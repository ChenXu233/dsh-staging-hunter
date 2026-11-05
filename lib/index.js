/**
 * dsh-staging-hunter — 让本机永远落在 DSH 桌面端夜间版灰度「第一批」。
 *
 * 原理（全部来自本机 app.asar 里 electron-updater/out/AppUpdater.js 的官方实现）：
 *
 *   async isStagingMatch(updateInfo) {
 *     let stagingPercentage = parseInt(updateInfo.stagingPercentage, 10)
 *     stagingPercentage = stagingPercentage / 100          // feed 里是 0-100
 *     const stagingUserId = await this.stagingUserIdPromise.value
 *     const val = UUID.parse(stagingUserId).readUint32BE(12)
 *     const percentage = val / 0xffffffff
 *     return percentage < stagingPercentage                // 严格小于
 *   }
 *
 * 而 stagingUserId 来自 %APPDATA%/\@deepseek-ai/dsh-desktop/.updaterId。
 * 只要把该文件里的 UUID 换成 bytes[12..15] 足够小（即桶值足够低）的一个合法
 * UUID，本机就会在任何 stagingPercentage > 桶值 的发布中入圈。
 *
 * 本插件做的事：
 *   1. 启动时读取 .updaterId，若桶值已经足够低就沿用（不换身份）；
 *   2. 否则生成一个低位桶 UUID 写回（并备份原文件、把钉住的 UUID 存进 sidecar）；
 *   3. 之后用 fs.watch + 定时巡检守着它——被应用改回随机值就立刻改回来。
 *
 * 为什么需要「守」：.updaterId 缺失或格式非法时，AppUpdater.getOrCreateStagingUserId()
 * 会重新生成一个随机 UUID（桶值均匀分布，约 70% 概率直接掉出 30% 灰度圈）。
 *
 * 注意：AppUpdater 用 Lazy 缓存 stagingUserIdPromise，所以本插件写回的值
 * 要等下一次应用启动才被更新检查读取。插件 apply 发生在启动早期，通常早于
 * 首轮检查，但不要依赖这个顺序——改完后重启一次最稳。
 */

import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, watch, writeFileSync, unwatchFile } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/** 插件名（cordis 用）。 */
export const name = 'dsh-staging-hunter'

/** 与 builder-util-runtime 的 UUID.check 等价的正则（锚定，禁止首尾空白/换行）。 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const DEFAULTS = {
  /** 总开关。 */
  enabled: true,
  /** 桶值上限（百分比）。桶值低于它即视为「在第一批」。 */
  targetPercentage: 1,
  /** 钉死的 UUID；留空表示自动挑选/生成。 */
  uuid: '',
  /** .updaterId 路径覆盖；留空自动探测。 */
  updaterIdPath: '',
  /** 定时巡检间隔（毫秒）；0 表示只靠 fs.watch。 */
  checkIntervalMs: 60_000,
}

/** 候选 userData 目录，按平台给出。 */
function candidateUserDataDirs() {
  const dirs = []
  const appdata = process.env.APPDATA
  if (appdata) {
    dirs.push(path.join(appdata, '@deepseek-ai', 'dsh-desktop'))
    dirs.push(path.join(appdata, 'deepseek-ai', 'dsh-desktop'))
  }
  if (process.platform === 'darwin') {
    dirs.push(path.join(os.homedir(), 'Library', 'Application Support', '@deepseek-ai', 'dsh-desktop'))
  }
  if (process.platform !== 'win32' && process.platform !== 'darwin') {
    dirs.push(path.join(os.homedir(), '.config', '@deepseek-ai', 'dsh-desktop'))
  }
  dirs.push(path.join(os.homedir(), '.dsh', 'dsh-desktop'))
  return dirs
}

/** 解析出真正要维护的 .updaterId 路径。 */
function resolveUpdaterIdPath(override) {
  if (override) return override
  const dirs = candidateUserDataDirs()
  for (const dir of dirs) {
    if (existsSync(path.join(dir, '.updaterId'))) return path.join(dir, '.updaterId')
  }
  // 一个都不存在时用首选路径（写入时会建目录）
  return path.join(dirs[0], '.updaterId')
}

/** 计算 UUID 的桶值；非法返回 null。 */
function bucketOf(uuid) {
  const hex = String(uuid ?? '').trim().replace(/-/g, '')
  if (hex.length !== 32) return null
  const val = parseInt(hex.slice(24, 32), 16)
  if (!Number.isFinite(val)) return null
  return val / 0xffffffff
}

/** 生成一个合法 UUID，且 bytes[12..15] 精确落在目标桶值。 */
function uuidAtBucket(percent) {
  const b = randomBytes(16)
  b[6] = (b[6] & 0x0f) | 0x40 // version 4
  b[8] = (b[8] & 0x3f) | 0x80 // RFC 4122 variant
  const val = Math.min(0xffffffff, Math.floor((percent / 100) * 0xffffffff))
  b[12] = (val >>> 24) & 0xff
  b[13] = (val >>> 16) & 0xff
  b[14] = (val >>> 8) & 0xff
  b[15] = val & 0xff
  const hex = b.toString('hex')
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join('-')
}

function makeLog(ctx) {
  let logger = null
  try {
    if (typeof ctx?.logger === 'function') logger = ctx.logger('staging-hunter')
    else if (ctx?.logger && typeof ctx.logger.info === 'function') logger = ctx.logger
  } catch {}
  return (msg) => {
    try {
      if (logger && typeof logger.info === 'function') return logger.info(msg)
    } catch {}
    try { console.log('[staging-hunter] ' + msg) } catch {}
  }
}

function makeWarn(ctx) {
  let logger = null
  try {
    if (typeof ctx?.logger === 'function') logger = ctx.logger('staging-hunter')
    else if (ctx?.logger && typeof ctx.logger.warn === 'function') logger = ctx.logger
  } catch {}
  return (msg) => {
    try {
      if (logger && typeof logger.warn === 'function') return logger.warn(msg)
    } catch {}
    try { console.warn('[staging-hunter] ' + msg) } catch {}
  }
}

export function apply(ctx, config) {
  const log = makeLog(ctx)
  const warn = makeWarn(ctx)
  const cfg = { ...DEFAULTS, ...(config && typeof config === 'object' ? config : {}) }

  if (!cfg.enabled) {
    log('disabled by config')
    return
  }

  const file = resolveUpdaterIdPath(cfg.updaterIdPath)
  const userDataDir = path.dirname(file)
  const sidecar = path.join(userDataDir, '.staging-hunter.json')
  const target = Number(cfg.targetPercentage) > 0 ? Number(cfg.targetPercentage) : DEFAULTS.targetPercentage
  const ceiling = target / 100

  // ---- 1. 决定要钉住的 UUID ----------------------------------------------
  let pinned = ''
  try {
    const raw = JSON.parse(readFileSync(sidecar, 'utf8'))
    if (typeof raw?.uuid === 'string' && UUID_RE.test(raw.uuid)) pinned = raw.uuid
  } catch {}

  if (!pinned && typeof cfg.uuid === 'string' && UUID_RE.test(cfg.uuid)) pinned = cfg.uuid

  if (!pinned) {
    // 沿用当前身份：只要它已经在圈内就不换
    try {
      const cur = readFileSync(file, 'utf8')
      if (UUID_RE.test(cur)) {
        const b = bucketOf(cur)
        if (b !== null && b < ceiling) pinned = cur
      }
    } catch {}
  }

  if (!pinned) pinned = uuidAtBucket(target)

  const pinnedBucket = bucketOf(pinned)

  // ---- 2. 写 sidecar，保证跨启动身份稳定 ----------------------------------
  try {
    mkdirSync(userDataDir, { recursive: true })
    writeFileSync(sidecar, JSON.stringify({ uuid: pinned, targetPercentage: target, updatedAt: new Date().toISOString() }, null, 2))
  } catch (e) {
    warn('cannot write sidecar: ' + (e && e.message))
  }

  // ---- 3. 幂等写入 .updaterId ---------------------------------------------
  let lastBackedUp = ''
  let writes = 0

  function backup(content) {
    if (!content || content === lastBackedUp) return
    lastBackedUp = content
    try {
      writeFileSync(file + '.backup-' + Date.now(), content, 'utf8')
      log('backed up previous updaterId -> ' + path.basename(file) + '.backup-*')
    } catch (e) {
      warn('backup failed: ' + (e && e.message))
    }
  }

  function enforce(reason) {
    let current = null
    try { current = readFileSync(file, 'utf8') } catch {}
    if (current === pinned) return false

    // 当前值合法但已在圈内、且我们没被显式要求换身份时，尊重它
    if (current && UUID_RE.test(current)) {
      const b = bucketOf(current)
      if (b !== null && b < ceiling && current !== pinned) {
        // 已在圈内：把身份改成它，不再强行覆盖
        pinned = current
        try {
          writeFileSync(sidecar, JSON.stringify({ uuid: pinned, targetPercentage: target, updatedAt: new Date().toISOString() }, null, 2))
        } catch {}
        log('adopted existing in-cohort updaterId (bucket ' + (b * 100).toFixed(4) + '%)')
        return false
      }
    }

    if (current != null) backup(current)
    try {
      mkdirSync(userDataDir, { recursive: true })
      // 关键：不加换行。UUID.check 的正则是锚定的，尾部换行会被判非法。
      writeFileSync(file, pinned, 'utf8')
      writes += 1
      const now = bucketOf(readFileSync(file, 'utf8'))
      log('pinned updaterId (' + reason + ') -> ' + pinned + '  bucket=' + (now === null ? '?' : (now * 100).toFixed(6) + '%'))
      return true
    } catch (e) {
      warn('cannot write ' + file + ': ' + (e && e.message))
      return false
    }
  }

  enforce('startup')
  log('watching ' + file + '  ceiling=' + target + '%  pinnedBucket=' + (pinnedBucket === null ? '?' : (pinnedBucket * 100).toFixed(6) + '%'))

  // ---- 4. 守门：fs.watch + 定时巡检 ---------------------------------------
  let watcher = null
  try {
    watcher = watch(userDataDir, { persistent: false }, (_evt, filename) => {
      if (!filename) return
      if (String(filename) !== '.updaterId') return
      enforce('watch')
    })
    watcher.on?.('error', (e) => warn('watcher error: ' + (e && e.message)))
  } catch (e) {
    warn('fs.watch unavailable, falling back to polling: ' + (e && e.message))
  }

  const intervalMs = Number(cfg.checkIntervalMs)
  let timer = null
  if (Number.isFinite(intervalMs) && intervalMs > 0) {
    timer = setInterval(() => enforce('poll'), intervalMs)
    timer.unref?.()
  }

  // ---- 5. 卸载时清理 ------------------------------------------------------
  return () => {
    try { watcher?.close?.() } catch {}
    try { if (timer) clearInterval(timer) } catch {}
    log('stopped after ' + writes + ' correction(s)')
  }
}
