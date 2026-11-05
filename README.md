# dsh-staging-hunter

让 DSH 桌面端**永远落在夜间版灰度的第一批**。

## 它解决什么问题

DSH 桌面端用 electron-updater 的 staging 机制控制放量：官方 feed
（`https://download.deepseek.com/dsh-desk/feeds/win-x64/nightly.yml`）里有一个
`stagingPercentage`（0–100）。本机是否入圈由 `.updaterId` 里的 UUID 决定：

```js
// app.asar -> node_modules/electron-updater/out/AppUpdater.js
stagingPercentage = parseInt(updateInfo.stagingPercentage, 10) / 100
const val = UUID.parse(stagingUserId).readUint32BE(12)
const percentage = val / 0xffffffff
return percentage < stagingPercentage   // 严格小于
```

桶值是 UUID 的**确定性哈希**，所以一台机器永远落在同一位置——放量比例低于你的
桶值时，你就一直收不到新版本。本插件把 `.updaterId` 钉在一个极低的桶值上，
于是任何 `stagingPercentage > 配置值` 的发布你都在圈内。

## 行为

1. 启动时读 `.updaterId`；若桶值已低于上限就**沿用现有身份**（不换 UUID）。
2. 否则生成一个合法 v4 UUID，把 `bytes[12..15]` 精确写成目标桶值，备份原文件后写回。
3. 把钉住的 UUID 存进 `.staging-hunter.json`（sidecar），保证**跨启动身份稳定**。
4. `fs.watch` + 定时巡检守着文件：被应用改回随机值时立刻改回来。
5. 插件卸载时自动关闭 watcher 与定时器。

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `targetPercentage` | `1` | 桶值上限（%）。桶值低于它即视为在第一批 |
| `uuid` | `''` | 钉死的 UUID；留空自动挑选/生成 |
| `updaterIdPath` | `''` | `.updaterId` 路径覆盖；留空自动探测 |
| `checkIntervalMs` | `60000` | 巡检间隔；`0` 表示只靠 fs.watch |

## 安装（本仓库未自动写入你的 profile）

本插件**没有**注册进 `~/.dsh/profiles/desktop`。要启用时二选一：

### A. 作为 bundle 包（推荐）

```bash
# 1) 放进 profile 的 node_modules（目录联接，不触发 pnpm 重装）
cmd //c mklink /J "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-staging-hunter" "E:\git\dsh-staging-hunter"

# 2) 在 ~/.dsh/profiles/desktop/package.json 的 dependencies 与
#    dsh.profile.bundles 里各加一行 "dsh-staging-hunter"
```

### B. 直接写进 profile 的补丁层

在 `~/.dsh/profiles/desktop/cordis.patch.yml` 追加：

```yaml
- insert:
    - id: dsh-staging-hunter
      name: 'dsh-staging-hunter'
      config:
        targetPercentage: 1
```

改完重启 DSH 桌面端。启动日志里应出现：

```
[staging-hunter] pinned updaterId (startup) -> <uuid>  bucket=1.000000%
[staging-hunter] watching ...\.updaterId  ceiling=1%  pinnedBucket=1.000000%
```

## 注意

- **完整性不受影响**：只改本地「我是谁」的标签，安装包仍从官方地址下载，并按 feed 里的
  `sha512` 与安装器 `publisherName` 验签。
- **需要重启**：`AppUpdater` 用 `Lazy` 缓存 `stagingUserIdPromise`，本插件写回的值
  在下一次启动的更新检查中才生效。
- **nightly 有风险**：你会稳定收到 rc 版本，可能遇到崩溃或破坏性变更。
- **副作用**：你不在圈内时，旧行为是「停在当前版本」；现在会持续跟进最新 nightly。
