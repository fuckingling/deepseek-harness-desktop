/**
 * Assemble the self-contained harness runtime at build/runtime:
 *
 *   node/      standalone Node.js (from build/vendor) + standalone pnpm
 *              (dsh-market runs it; no PATH probing, no corepack, no -g)
 *   harness/   @deepseek-ai/dsh install + bundled default plugins
 *   plugins/   dsh-launcher-updater (the update plugin; zero-dependency)
 *   profile-overlay.yml  composition overlay the shell boots with --patch:
 *                        mounts the launcher updater, the ModLens vision
 *                        plugin, and the dsh-market plugin marketplace
 *   harness.json  runtime manifest the updater and shell read
 *
 * This directory is BOTH what the .app embeds (runtime + runtime.pristine)
 * and what the update feed ships (tar.gz artifact) — one source of truth.
 *
 * Usage: node scripts/build-runtime.mjs [--dsh-version 0.1.0-rc.6] [--runtime-version 0.1.0] [--modlens-version 3.17.3] [--dshmarket-version 1.9.0] [--channel stable] [--update-feed <url>] [--arch arm64]
 */

import { chmod, mkdir, rm, cp, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { BUILD, ROOT, parseFlags, resolveConfig, run } from './lib/util.mjs'

const flags = parseFlags(process.argv.slice(2))
const config = resolveConfig(flags)

const RUNTIME = join(BUILD, 'runtime')
const VENDOR_NODE = join(BUILD, 'vendor', 'node')
const UPDATER_SRC = join(ROOT, 'packages', 'updater')

async function main() {
  if (!existsSync(join(VENDOR_NODE, 'bin', 'node'))) {
    throw new Error('vendor node missing — run `npm run fetch-tools` first')
  }

  const modlensVersion = flags['modlens-version'] ?? '3.17.3'
  const dshmarketVersion = flags['dshmarket-version'] ?? '1.9.0'
  const pnpmVersion = flags['pnpm-version'] ?? '10.28.2'

  console.log(`assembling runtime ${config.runtimeVersion} (dsh ${config.dshVersion}, ${config.arch})`)
  await rm(RUNTIME, { recursive: true, force: true })
  await mkdir(RUNTIME, { recursive: true })

  /* ── bundled Node + pnpm bin shim ── */
  await cp(VENDOR_NODE, join(RUNTIME, 'node'), { recursive: true, dereference: false })
  // The runtime bundles the npm `pnpm` package (plain JS); this shim exposes
  // it as runtime/node/bin/pnpm so dsh-market — and the agent's own shell —
  // find pnpm without probing the user's PATH, corepack, or `npm -g`.
  // (pnpm's standalone binaries are unsigned and macOS kills them.)
  await writeFile(join(RUNTIME, 'node', 'bin', 'pnpm'), `#!/bin/sh
# dsh-harness-desktop: run the runtime-bundled pnpm on the bundled Node.
BASE="$(cd "$(dirname "$0")/.." && pwd)"
exec "$BASE/bin/node" "$BASE/../harness/node_modules/pnpm/bin/pnpm.cjs" "$@"
`)
  await chmod(join(RUNTIME, 'node', 'bin', 'pnpm'), 0o755)

  /* ── dsh install + bundled default plugins ── */
  const harnessDir = join(RUNTIME, 'harness')
  await mkdir(harnessDir, { recursive: true })
  await writeFile(join(harnessDir, 'package.json'), `${JSON.stringify({
    name: 'dsh-harness-desktop-runtime',
    version: config.runtimeVersion,
    private: true,
    // Exact pins on purpose: runtime updates flow through the update feed,
    // never through loose npm resolution. The bundled plugins live inside
    // the harness install so their dependencies resolve from the same
    // node_modules:
    //   @liustack/modlens  image support (bundled vision CLI)
    //   dshmarket          the in-app plugin marketplace (zero deps)
    //   pnpm               runs dsh-market's installs (plain JS on our Node)
    dependencies: {
      '@deepseek-ai/dsh': config.dshVersion,
      '@liustack/modlens': modlensVersion,
      'dshmarket': dshmarketVersion,
      'pnpm': pnpmVersion,
    },
  }, null, 2)}\n`)
  console.log(`npm install @deepseek-ai/dsh@${config.dshVersion} @liustack/modlens@${modlensVersion} dshmarket@${dshmarketVersion} pnpm@${pnpmVersion} …`)
  await run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=warn'], {
    label: 'npm',
    spawn: { cwd: harnessDir },
  })
  const installed = JSON.parse(await readFile(join(harnessDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'))
  if (installed.version !== config.dshVersion) {
    throw new Error(`installed dsh ${installed.version} != requested ${config.dshVersion}`)
  }
  const installedModlens = JSON.parse(await readFile(join(harnessDir, 'node_modules', '@liustack', 'modlens', 'package.json'), 'utf8'))
  if (installedModlens.version !== modlensVersion) {
    throw new Error(`installed @liustack/modlens ${installedModlens.version} != requested ${modlensVersion}`)
  }
  const installedMarket = JSON.parse(await readFile(join(harnessDir, 'node_modules', 'dshmarket', 'package.json'), 'utf8'))
  if (installedMarket.version !== dshmarketVersion) {
    throw new Error(`installed dshmarket ${installedMarket.version} != requested ${dshmarketVersion}`)
  }
  const installedPnpm = JSON.parse(await readFile(join(harnessDir, 'node_modules', 'pnpm', 'package.json'), 'utf8'))
  if (installedPnpm.version !== pnpmVersion) {
    throw new Error(`installed pnpm ${installedPnpm.version} != requested ${pnpmVersion}`)
  }

  /* ── updater plugin (zero-dependency, lives in runtime/plugins) ── */
  const updaterFiles = ['package.json', 'index.js', 'client.js', 'lib']
  for (const name of updaterFiles) {
    await cp(join(UPDATER_SRC, name), join(RUNTIME, 'plugins', 'dsh-launcher-updater', name), { recursive: true })
  }

  /* ── composition overlay the shell applies with --patch ── */
  await writeFile(join(RUNTIME, 'profile-overlay.yml'), `# DeepSeek Harness 桌面启动器 — 运行时 composition overlay。
# 由外壳以 --patch 方式在 profile 层之后叠加；随 runtime 一起更新，
# 因此新增/移除默认插件不需要改动用户数据目录。
- insert:
    # 启动器更新插件（双面：host 更新引擎 + 设置页“更新”面板）
    - id: launcher-updater
      name: dsh-launcher-updater
    # 默认图像支持插件：ModLens 视觉引擎
    # （粘贴/拖入图片 → modlens_read_image 工具 → 结构化 JSON 证据，
    #   模型选择器自带 “(modlens vision)” 包装入口）
    - id: modlens
      name: '@liustack/modlens'
    # 应用内插件市场（设置 → 插件市场，800+ 社区插件一键安装/升级）。
    # allowRestart: false —— 本应用的进程由桌面外壳监督，重启由
    # “设置 → 更新 → 重启 Harness”统一负责（市场只显示待重启提示）。
    - id: dsh-market
      name: dshmarket
      config:
        allowRestart: false
`)

  /* ── runtime manifest ── */
  await writeFile(join(RUNTIME, 'harness.json'), `${JSON.stringify({
    name: 'dsh-harness-desktop-runtime',
    runtimeVersion: config.runtimeVersion,
    dshVersion: config.dshVersion,
    modlensVersion: modlensVersion,
    dshmarketVersion: dshmarketVersion,
    pnpmVersion: pnpmVersion,
    channel: config.channel,
    updateFeed: config.updateFeed,
    arch: config.arch,
    builtAt: new Date().toISOString(),
  }, null, 2)}\n`)

  console.log(`runtime ready: ${RUNTIME}`)
  console.log(`  dsh ${config.dshVersion}, modlens ${modlensVersion}, dshmarket ${dshmarketVersion}, pnpm ${pnpmVersion}, node ${await (await run(join(RUNTIME, 'node', 'bin', 'node'), ['--version'], { quiet: true })).trim()}`)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
