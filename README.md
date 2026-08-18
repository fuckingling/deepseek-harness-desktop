# DeepSeek Harness 桌面启动器（macOS）

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 打包成 macOS
应用：用户下载 DMG、拖进“应用程序”即可使用。**所有运行环境（Node、依赖、配置、数据）都在应用内部**，
不依赖、也不改动系统里的任何东西；设置菜单里新增**“更新”**页面，点一下即可原地更新 Harness，
不用重新下载安装。

开箱自带（均为插件形式新增，官方自带功能原样保留）：

- **更新**：设置 → 更新，原地更新 Harness。默认直接查官方 npm registry
  （`@deepseek-ai/dsh` 的 dist-tag），发现新版本后“更新并重启”，用应用内置 npm
  从官方源安装后原子替换 runtime 并重启（不触碰系统环境）；配置了启动器 feed
  （`harness.json` 的 `updateFeed`）时同时检查整包更新产物。支持自动检查（默认开启，
  每天定时检查，发现更新只提示、由你手动安装）。
- **个人中心**：设置 → 个人中心，Codex 风格的使用统计：累计 Token（输入/缓存命中/缓存未命中/
  输出四分桶）、单日峰值（含日期）、最长会话持续时间、连续活跃天数、累计费用（按官方 DeepSeek
  价格：8/17 调价前后分档 + 高峰 9–12/14–18 北京时间、低谷半价，价格可在页面修改），
  以及 GitHub 式 **Token 活动热力图**（全年 × 7 天，悬停看当日 token 与费用）和模型明细。
  数据直接聚合自会话存储：投影缓存 `storages/session_projcache.json`（域数据形态 v3 或旧扁平形态）、
  工作区 `storages/workspace.json` 与逐会话事件日志 `sessions/**/session.jsonl.zstd`（按帧解压，
  逐条用量精确到天）；逐条用量缺失时按会话最后活跃日归集（页面有说明）。
- **聊天记录备份与还原**：设置 → 备份与还原。一键把全部会话记录（`sessions/` 事件日志、
  `storages/`）与聊天中粘贴的图片（`attachments/`）打包成 tar.gz（保存在应用内，可下载带走）；
  还原时先校验归档安全性，把当前记录留一份 `.pre-restore` 快照后原子替换，并重启 Harness
  完整加载——字节级还原、失败不破坏现有数据。支持上传备份文件跨机器还原。
- **Codex 风格外框**：沉浸式无边框深色窗口（`hiddenInset`，红绿灯悬浮内嵌），
  顶部注入拖拽条可任意拖动窗口，侧边栏 logo 区（宽/窄两种形态）自动避让 macOS 窗口按钮，
  记忆窗口位置与大小、居中启动。

## 工作原理

### 自包含的安装

`DeepSeek Harness.app` 内部结构（全部在安装目录之内）：

```
DeepSeek Harness.app/Contents/
├── MacOS/DeepSeek Harness       Electron 外壳（不可变，负责监督）
└── Resources/
    ├── app/                     shell 主进程代码（不可变）
    ├── runtime/                 ← 可更新单元：完整的 Harness 运行环境
    │   ├── node/                bin shim（node/npm/pnpm）：exec 外壳的
    │   │                        Electron 二进制（ELECTRON_RUN_AS_NODE=1），
    │   │                        不再捆绑独立 Node.js
    │   ├── harness/             @deepseek-ai/dsh + 全部依赖
    │   ├── plugins/             dsh-launcher-updater 启动器插件（更新 + 个人中心）
    │   ├── profile-overlay.yml  插件挂载层（外壳以 --patch 应用）
    │   └── harness.json         运行时清单（版本 / 通道 / 更新源）
    ├── runtime.backup/          更新前的上一版本（回滚用，健康启动后自动清除）
    └── data/                    用户数据：DSH_HOME（会话、设置）、日志；
        └── pristine/            自修复快照：首次健康启动后由外壳把当前
                                 runtime 压缩到 runtime-<版本>.tar.gz
                                 （不再随 .app 打包第二份 runtime 副本）
```

> **体积**：runtime 在构建时经过瘦身（`scripts/lib/prune-runtime.mjs`）：剔除全部
> source map、类型声明、TS 源码、测试/文档、非 macOS 平台的原生二进制（sharp-wasm32、
> node-pty/reflink 的其它平台 prebuild）与审计过的冗余文件（web-streams-polyfill 的多格式
> 矩阵、otel semantic-conventions 的 esnext 构建、npm 文档等），约 -150 MB。Electron 框架只
> 保留 en/zh_CN 两个语言包（约 -44 MB）。DMG 用 UDZO zlib-level=9 压缩。整条链把 DMG 从
> ~1.4 GB（0.1.0 最初版本）降到几百兆。排查体积问题可用 `--no-prune` 跳过瘦身对比。

启动时 shell 只做三件事：拉起 `runtime/node/bin/node … dsh web --port N`（`DSH_HOME` 指向应用内
`data/home`，`PATH` 前置应用内的 node shim，shim 再以 `ELECTRON_RUN_AS_NODE=1` 把外壳二进制当
Node 用），等服务器就绪后打开窗口。用户的系统环境完全不被触碰。

默认插件通过**运行时 overlay**（`runtime/profile-overlay.yml`，以 `--patch` 叠加在 web profile
之后）挂载：插件包本体随 runtime 一起分发，外壳每次启动把 profile 的 `node_modules` 符号链接
对账到 runtime 内的插件位置。**升级 runtime 即升级插件**，用户数据目录无需改动；移除某个默认
插件也只需在新 runtime 的 overlay 里删掉对应行。

### 应用内更新（设置 → 更新）

- 更新插件是一个**双面 Cordis 插件**（`packages/updater`）：host 侧在 harness 的 web 服务器上
  注册 `/launcher-updater/*` 路由并执行更新；浏览器侧在设置面板注册“更新”页。
- 它随出厂 profile 补丁层挂进 web composition（`scripts/build-runtime.mjs` 构建时生成
  `runtime/profile-overlay.yml`，外壳以 `--patch` 叠加），无需改动 dsh 本体，任何 dsh 版本都能用。
- 更新流程：检查 feed → 下载 `runtime-<version>-darwin-<arch>.tar.gz` → 校验 sha256 →
  解压到暂存目录 → 原子交换 `runtime` ↔ `runtime.backup` → 以退出码 42 通知 shell 重启。
- shell 监督：新运行时健康启动 20 秒后提交（删除备份）；连续两次启动失败自动回滚到上一版本或
  出厂版本。**更新失败也不会留下一个不能用的应用。**

### 更新源：官方 npm 渠道（默认）+ 可选启动器 feed

官方仓库（github.com/deepseek-ai/deepseek-harness）**不发布 GitHub Release**，官方分发渠道是
npm 的 `@deepseek-ai/dsh`。因此“检查更新”默认直接查**官方 npm registry**：

1. 对比应用内 `dshVersion` 与官方 `dist-tag latest`；发现新版本后“更新并重启”会：
   把当前 runtime 复制到暂存目录 → 重写 dsh 版本 → 用**应用内置 npm**（以纯 JS 依赖随 runtime 分发，经 `node/bin/npm` shim 运行，
   缓存指向应用内目录，不触碰系统环境）从官方 registry 安装 → 原子交换 → 重启。
   启动器插件（更新/备份还原/个人中心）随之保留。
2. 配置了启动器 feed（`harness.json` 的 `updateFeed`）时，同时检查 feed 的 runtime 产物；
   官方 dsh 版本优先，feed 用于分发启动器专属的整包更新（默认插件集变更、Electron 升级等）。

npm registry 可用环境变量 `DSH_LAUNCHER_NPM_REGISTRY` 覆盖（默认官方 registry.npmjs.org）。

**自动检查**：设置 → 更新 里有"自动检查更新"开关（默认开启），每天在设定时间（默认
03:00，可用时间选择器修改，持久化在应用内 `launcher-settings.json`）自动检查官方新版本；
机器在设定时刻休眠/关机时，当天首次启动后自动补一次。发现新版本只提示，仍由你在此页面
手动安装（更新会重启 Harness，不趁人不在时打断会话）。

### 更新源（feed）

更新源是一个静态 JSON（`dist/feed/feed.json`，由构建产出），放在任何 HTTPS 站点或
GitHub Releases 上：

```json
{
  "schemaVersion": 1,
  "defaultChannel": "stable",
  "channels": {
    "stable": {
      "latest": {
        "version": "0.1.0",
        "dshVersion": "0.1.0-rc.6",
        "notes": "更新说明…",
        "publishedAt": "2026-08-16T00:00:00.000Z",
        "artifacts": {
          "darwin-arm64": { "url": "https://…/runtime-0.1.0-darwin-arm64.tar.gz", "sha256": "…" }
        }
      }
    }
  }
}
```

运行时清单 `harness.json` 里的 `updateFeed` 指向这个 feed；也可以用环境变量
`DSH_LAUNCHER_FEED_URL` 覆盖。未配置 feed 时“更新”页会提示“未配置更新源”。

## 构建

前置要求：macOS，系统 Node ≥ 20（仅构建用），网络可访问 nodejs.org / npm / GitHub。

```bash
npm run fetch-tools      # 下载 Electron（缓存于 build/vendor；兼任运行时 Node）
npm run build-runtime    # 组装运行时（npm 安装 @deepseek-ai/dsh）
npm run make-icon        # 由 assets/icon-app.svg 生成 icon.icns
npm run build-app        # 组装 .app 并 ad-hoc 签名
npm run build-dmg        # 打包 DMG + 更新产物（feed）
# 或一条命令（flags 会由 scripts/build.mjs 透传给每一步，--update-feed 才能写进 harness.json）：
npm run build -- --runtime-version 0.1.1 --update-feed https://github.com/fuckingling/deepseek-harness-desktop/releases/download/v0.1.1
```

产出：

| 路径 | 说明 |
| --- | --- |
| `dist/dmg/DeepSeek Harness-<版本>-<架构>.dmg` | 安装包 |
| `dist/feed/runtime-<版本>-darwin-<架构>.tar.gz` | 更新产物（发布到 feed 指向的地址） |
| `dist/feed/feed.json` | 更新源清单 |

常用参数（各脚本均支持）：`--arch arm64|x64`、`--dsh-version 0.1.0-rc.6`、
`--runtime-version 0.1.0`、`--app-version 0.1.0`、`--channel stable`、`--update-feed <url>`。
体积相关：`--no-prune`（跳过 runtime 瘦身，用于排查）、`--dmg-format UDBZ`（bzip2 二段式
压缩，DMG 再小 ~30%，代价是构建与挂载更慢；默认 UDZO zlib-level=9）。

> **符号链接**：打包链里所有 `fs.cp` 复制 bundle 时必须带 `verbatimSymlinks: true`
> （`build-app.mjs` 复制 runtime、`build-dmg.mjs` 复制 app 进 DMG）。Node 的 `fs.cp`
> 默认会把相对符号链接（Electron Framework 的 `Versions/Current/...`、npm 的 `.bin`
> shim）重写成构建机的绝对路径，装到别的机器（或构建目录被删后）打开即闪退
> （dyld: Library not loaded）。`build-app` 末尾有绝对链接门禁：成品 bundle 内出现
> 任何绝对符号链接会直接构建失败。

分支模型：`develop` 为默认开发分支（日常提交走这里），`master` 为稳定分支；发布时把
develop 合并进 master，再从 master 打版本 tag（v0.1.0…），Release 与 DMG/更新产物都基于该 tag。

发布新版本（以 GitHub Releases 为例）：

```bash
# 0. 合并 develop → master（发布从稳定分支出 tag）
git checkout master && git merge develop && git push

# 1. 构建新版本（运行时版本号 +1）
npm run build -- --runtime-version 0.1.1 --update-feed https://github.com/fuckingling/deepseek-harness-desktop/releases/download/v0.1.1

# 2. 发布 dist/feed/ 下的 runtime-*.tar.gz 与 feed.json 到 Releases
gh release create v0.1.1 dist/feed/runtime-0.1.1-darwin-arm64.tar.gz dist/feed/feed.json

# 3. 已有用户点击 设置 → 更新 → 检查更新 即可原地升级（应用本身不用动）
```

正式分发时建议：把 `--sign-identity` 换成你的 Apple Developer ID 并做公证
（构建脚本默认 ad-hoc 签名，首次打开需右键 → 打开确认一次）。

## 本地开发验证

```bash
npm run build-runtime
npm run dev-run                  # 直接跑 harness（不经过 Electron 外壳）
# 浏览器打开打印的地址；设置面板里应出现“更新”页
# curl http://127.0.0.1:<port>/launcher-updater/status  查看更新引擎状态
```

打包成 App 后，可用 e2e 探测脚本做页内自动化验证（先退出正在运行的 App——外壳有单实例锁）：

```bash
npm run build-app
npm run e2e                                # 依次跑 e2e/check-*.js 全部探测
npm run e2e -- e2e/check-personal.js --shot  # 单条探测 + 截图（结果在 build/e2e-*.json/.png）
```

用本地 feed 模拟一次完整自更新：

```bash
# 造一个"新版本"运行时（把 runtimeVersion 改成 9.9.9）并打包成产物
node scripts/make-fake-update.mjs
# 起一个本地静态服务器充当 feed
cd dist/feed && python3 -m http.server 8099
# 以指向该 feed 的方式启动 harness：
node scripts/dev-run.mjs --feed http://127.0.0.1:8099/feed.json
# 设置 → 更新 → 检查更新 → 更新并重启；进程退出码 42 即代表"已通知 shell 重启"
```

## 项目结构

```
shell/main.js                   Electron 主进程：拉起/监督/回滚/Codex 风格窗口
packages/updater/               启动器插件（双面：更新 + 备份还原 + 个人中心）
  index.js                      host 侧：更新/备份/个人中心路由 + 引擎入口
  lib/engine.js                 下载/校验/原子交换/重启
  lib/backup.js                 聊天记录备份/还原引擎
  lib/personal.js               个人中心用量统计引擎
  client.js                     设置页 UI（更新/备份与还原/个人中心，zh/en）
scripts/
  fetch-tools.mjs  build-runtime.mjs  build-app.mjs  build-dmg.mjs
  make-icon.mjs    dev-run.mjs  make-fake-update.mjs  e2e.mjs  build.mjs
  lib/util.mjs                  构建脚本共享工具（下载/哈希/配置）
assets/icon-app.svg             App 图标源（icon.icns 由 make-icon 生成）
e2e/                            Electron 页内自动化探测脚本（npm run e2e 运行）
```

启动器插件在 `build-runtime.mjs` 里维护：`pnpm`、`npm` 的版本分别用 `--pnpm-version` /
`--npm-version` 覆盖；增删默认插件 = 改 `runtime/harness/package.json` 的依赖 +
`profile-overlay.yml` 的行。

## 已知边界

- 仅支持 macOS（arm64 / x64），DMG 安装；Windows 不在范围内。
- 无 Apple Developer ID 时是 ad-hoc 签名：首次打开需右键 → 打开。
- “环境自包含”指 Harness 的运行环境与数据都在应用内；作为编码代理，
  Harness 本身仍会在你指定的工作目录里读写你的项目文件（这正是它的用途）。
- 更新会重启整个 Harness，进行中的会话可能中断（UI 中有提示）。
