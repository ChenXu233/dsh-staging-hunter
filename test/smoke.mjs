import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { apply } from '../lib/index.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function bucket(uuid) {
  const hex = uuid.replace(/-/g, '')
  return parseInt(hex.slice(24, 32), 16) / 0xffffffff
}

let pass = 0, fail = 0
function check(label, cond, extra = '') {
  if (cond) { pass++; console.log('  PASS  ' + label + (extra ? '  [' + extra + ']' : '')) }
  else { fail++; console.log('  FAIL  ' + label + (extra ? '  [' + extra + ']' : '')) }
}

const ORIGINAL = '6540d174-b134-5886-82be-6d3f8f40cbd2'   // 用户原身份, 桶值 55.96%
const IN_COHORT = '11111111-1111-4111-8111-0000000000d2'  // 构造低位桶

function freshDir() {
  return mkdtempSync(path.join(os.tmpdir(), 'staging-hunter-'))
}

// ---- case 1: 原身份在圈外 -> 应被改写 ----
console.log('\n[case 1] 原身份 bucket=55.96%%，target=1%%')
{
  const dir = freshDir()
  const file = path.join(dir, '.updaterId')
  writeFileSync(file, ORIGINAL, 'utf8')
  const dispose = apply({}, { updaterIdPath: file, targetPercentage: 1, checkIntervalMs: 0 })
  const after = readFileSync(file, 'utf8')
  check('文件仍是 36 字节无换行', after.length === 36 && !after.endsWith('\n'), JSON.stringify(after))
  check('新值通过 UUID.check 正则', UUID_RE.test(after))
  check('桶值 < 1%', bucket(after) < 0.01, (bucket(after) * 100).toFixed(6) + '%')
  check('桶值接近目标 1%', Math.abs(bucket(after) - 0.01) < 0.0001, (bucket(after) * 100).toFixed(6) + '%')
  check('生成了备份文件', readdirSync(dir).some(f => f.includes('.backup-')))
  check('生成了 sidecar', existsSync(path.join(dir, '.staging-hunter.json')))
  const side = JSON.parse(readFileSync(path.join(dir, '.staging-hunter.json'), 'utf8'))
  check('sidecar 钉住的就是写入值', side.uuid === after, side.uuid)
  typeof dispose === 'function' ? dispose() : null
  rmSync(dir, { recursive: true, force: true })
}

// ---- case 2: 幂等 ----
console.log('\n[case 2] 重复 apply 不应再改动')
{
  const dir = freshDir()
  const file = path.join(dir, '.updaterId')
  writeFileSync(file, ORIGINAL, 'utf8')
  const d1 = apply({}, { updaterIdPath: file, targetPercentage: 1, checkIntervalMs: 0 })
  const first = readFileSync(file, 'utf8')
  const d2 = apply({}, { updaterIdPath: file, targetPercentage: 1, checkIntervalMs: 0 })
  const second = readFileSync(file, 'utf8')
  check('第二次未改动文件', first === second, second)
  check('只有一个备份（不重复刷备份）', readdirSync(dir).filter(f => f.includes('.backup-')).length === 1)
  typeof d1 === 'function' ? d1() : null
  typeof d2 === 'function' ? d2() : null
  rmSync(dir, { recursive: true, force: true })
}

// ---- case 3: 已在圈内 -> 沿用，不换身份 ----
console.log('\n[case 3] 现有身份已在圈内应被沿用')
{
  const dir = freshDir()
  const file = path.join(dir, '.updaterId')
  writeFileSync(file, IN_COHORT, 'utf8')
  const before = bucket(IN_COHORT)
  const d = apply({}, { updaterIdPath: file, targetPercentage: 1, checkIntervalMs: 0 })
  const after = readFileSync(file, 'utf8')
  check('身份未被替换', after === IN_COHORT, after)
  check('原桶值 ' + (before * 100).toFixed(4) + '% 仍在 1% 内', before < 0.01)
  check('没有产生备份（无需改写）', readdirSync(dir).filter(f => f.includes('.backup-')).length === 0)
  typeof d === 'function' ? d() : null
  rmSync(dir, { recursive: true, force: true })
}

// ---- case 4: 文件被写坏 -> 修复 ----
console.log('\n[case 4] 文件损坏应被修复')
{
  const dir = freshDir()
  const file = path.join(dir, '.updaterId')
  writeFileSync(file, 'not-a-uuid\n', 'utf8')
  const d = apply({}, { updaterIdPath: file, targetPercentage: 1, checkIntervalMs: 0 })
  const after = readFileSync(file, 'utf8')
  check('已修复为合法 UUID', UUID_RE.test(after), JSON.stringify(after))
  check('桶值 < 1%', bucket(after) < 0.01)
  typeof d === 'function' ? d() : null
  rmSync(dir, { recursive: true, force: true })
}

// ---- case 5: 配置文件不存在 -> 自建 ----
console.log('\n[case 5] .updaterId 不存在时应自行创建')
{
  const dir = freshDir()
  const file = path.join(dir, 'nested', '.updaterId')
  const d = apply({}, { updaterIdPath: file, targetPercentage: 1, checkIntervalMs: 0 })
  check('文件已创建', existsSync(file))
  check('内容合法且低位桶', UUID_RE.test(readFileSync(file, 'utf8')) && bucket(readFileSync(file, 'utf8')) < 0.01)
  typeof d === 'function' ? d() : null
  rmSync(dir, { recursive: true, force: true })
}

// ---- case 6: disabled ----
console.log('\n[case 6] enabled:false 应完全不动作')
{
  const dir = freshDir()
  const file = path.join(dir, '.updaterId')
  writeFileSync(file, ORIGINAL, 'utf8')
  const d = apply({}, { enabled: false, updaterIdPath: file, targetPercentage: 1, checkIntervalMs: 0 })
  check('文件保持原样', readFileSync(file, 'utf8') === ORIGINAL)
  typeof d === 'function' ? d() : null
  rmSync(dir, { recursive: true, force: true })
}

console.log('\n================ ' + pass + ' passed, ' + fail + ' failed ================')
process.exit(fail === 0 ? 0 : 1)
