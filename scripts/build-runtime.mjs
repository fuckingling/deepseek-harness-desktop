/**
 * Assemble the self-contained harness runtime at build/runtime:
 *
 *   node/      bin shims only: node/npm/pnpm run on the app's Electron
 *              binary (ELECTRON_RUN_AS_NODE=1) — no standalone Node.js is
 *              bundled anymore (was ~196 MB; the shell passes its own
 *              execPath down via DSH_LAUNCHER_NODE_BIN)
 *   harness/   @deepseek-ai/dsh install + bundled default plugins
 *   plugins/   dsh-launcher-updater (the update plugin; zero-dependency)
 *   agent-presets/  dsh-routing-suite router presets copied to DSH_HOME on boot
 *   profile-overlay.yml  composition overlay the shell boots with --patch:
 *                        mounts the launcher updater, the ModLens vision
 *                        plugin, the dsh-market plugin marketplace, and the
 *                        dsh-routing-suite injector
 *   harness.json  runtime manifest the updater and shell read
 *
 * This directory is BOTH what the .app embeds (runtime + its pristine
 * tar.gz snapshot) and what the update feed ships (tar.gz artifact) — one
 * source of truth.
 *
 * Usage: node scripts/build-runtime.mjs [--dsh-version 0.1.0-rc.6] [--runtime-version 0.1.0] [--modlens-version 3.17.3] [--dshmarket-version 1.9.0] [--pnpm-version 10.28.2] [--npm-version 11.17.0] [--channel stable] [--update-feed <url>] [--arch arm64] [--no-prune]
 */

import { chmod, mkdir, rm, cp, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { BUILD, ROOT, parseFlags, resolveConfig, run } from './lib/util.mjs'
import { pruneHarnessNodeModules } from './lib/prune-runtime.mjs'

const flags = parseFlags(process.argv.slice(2))
const config = resolveConfig(flags)

const RUNTIME = join(BUILD, 'runtime')
const UPDATER_SRC = join(ROOT, 'packages', 'updater')
const ROUTING_SUITE_SRC = join(ROOT, 'packages', 'dsh-routing-suite')

async function main() {
  const modlensVersion = flags['modlens-version'] ?? '3.17.3'
  const dshmarketVersion = flags['dshmarket-version'] ?? '1.9.0'
  const pnpmVersion = flags['pnpm-version'] ?? '10.28.2'
  const npmVersion = flags['npm-version'] ?? '11.17.0'

  console.log(`assembling runtime ${config.runtimeVersion} (dsh ${config.dshVersion}, ${config.arch})`)
  await rm(RUNTIME, { recursive: true, force: true })
  await mkdir(RUNTIME, { recursive: true })

  /* ── node/npm/pnpm bin shims (Electron doubles as the runtime Node) ── */
  await mkdir(join(RUNTIME, 'node', 'bin'), { recursive: true })
  // The app's Electron binary runs any Node program with ELECTRON_RUN_AS_NODE=1
  // (verified: dsh CLI, node-pty, sharp, koffi, pnpm all work on it). The
  // shell/dev-run export their own execPath as DSH_LAUNCHER_NODE_BIN; inside
  // the .app the shim can also discover the executable via the bundle layout,
  // so staged/restored runtime copies keep working without any env plumbing.
  await writeFile(join(RUNTIME, 'node', 'bin', 'node'), `#!/bin/sh
# dsh-harness-desktop: run the Electron binary as plain Node.js.
# --expose-internals is required: cordis-plugin-loader resolves out-of-tree
# plugin entries through Node's internal ESM loader (baseUrl = profile dir);
# the fallback native addon (node-addon-require-builtin) cannot find its
# embedder symbols under Electron's embedded Node. Upstream's desktop launcher
# passes the same flag.
if [ -n "$DSH_LAUNCHER_NODE_BIN" ] && [ -x "$DSH_LAUNCHER_NODE_BIN" ]; then
  ELECTRON_RUN_AS_NODE=1 exec "$DSH_LAUNCHER_NODE_BIN" --expose-internals "$@"
fi
SELF="$(cd "$(dirname "$0")" && pwd -P)"
MACOS="$SELF/../../../../MacOS"
if [ -d "$MACOS" ]; then
  for exe in "$MACOS"/*; do
    if [ -x "$exe" ] && [ ! -d "$exe" ]; then
      ELECTRON_RUN_AS_NODE=1 exec "$exe" --expose-internals "$@"
    fi
  done
fi
echo "dsh-harness-desktop: cannot locate the Electron binary to run as node (set DSH_LAUNCHER_NODE_BIN)" >&2
exit 127
`)
  await chmod(join(RUNTIME, 'node', 'bin', 'node'), 0o755)
  // The runtime bundles the npm `pnpm` package (plain JS); this shim exposes
  // it as runtime/node/bin/pnpm so dsh-market — and the agent's own shell —
  // find pnpm without probing the user's PATH, corepack, or `npm -g`.
  // (pnpm's standalone binaries are unsigned and macOS kills them.)
  await writeFile(join(RUNTIME, 'node', 'bin', 'pnpm'), `#!/bin/sh
# dsh-harness-desktop: run the runtime-bundled pnpm on the Electron-as-Node binary.
BASE="$(cd "$(dirname "$0")/.." && pwd)"
exec "$BASE/bin/node" "$BASE/../harness/node_modules/pnpm/bin/pnpm.cjs" "$@"
`)
  await chmod(join(RUNTIME, 'node', 'bin', 'pnpm'), 0o755)
  // npm likewise ships as a plain-JS harness dependency; the updater's
  // official-registry path (applyOfficial) runs it via this shim.
  await writeFile(join(RUNTIME, 'node', 'bin', 'npm'), `#!/bin/sh
# dsh-harness-desktop: run the runtime-bundled npm on the Electron-as-Node binary.
BASE="$(cd "$(dirname "$0")/.." && pwd)"
exec "$BASE/bin/node" "$BASE/../harness/node_modules/npm/bin/npm-cli.js" "$@"
`)
  await chmod(join(RUNTIME, 'node', 'bin', 'npm'), 0o755)

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
    //   npm                official-registry updates in the updater plugin
    dependencies: {
      '@deepseek-ai/dsh': config.dshVersion,
      '@liustack/modlens': modlensVersion,
      'dshmarket': dshmarketVersion,
      'pnpm': pnpmVersion,
      'npm': npmVersion,
    },
  }, null, 2)}\n`)
  console.log(`npm install @deepseek-ai/dsh@${config.dshVersion} @liustack/modlens@${modlensVersion} dshmarket@${dshmarketVersion} pnpm@${pnpmVersion} npm@${npmVersion} …`)
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
  const installedNpm = JSON.parse(await readFile(join(harnessDir, 'node_modules', 'npm', 'package.json'), 'utf8'))
  if (installedNpm.version !== npmVersion) {
    throw new Error(`installed npm ${installedNpm.version} != requested ${npmVersion}`)
  }

  /* ── updater plugin (zero-dependency, lives in runtime/plugins) ── */
  const updaterFiles = ['package.json', 'index.js', 'client.js', 'lib']
  for (const name of updaterFiles) {
    await cp(join(UPDATER_SRC, name), join(RUNTIME, 'plugins', 'dsh-launcher-updater', name), { recursive: true })
  }

  /* ── dsh-routing-suite: injector plugin + router presets ── */
  const injectorDest = join(harnessDir, 'node_modules', '@dsh-external', 'dsh-super-injector')
  await mkdir(join(harnessDir, 'node_modules', '@dsh-external'), { recursive: true })
  await cp(join(ROUTING_SUITE_SRC, 'injector'), injectorDest, { recursive: true })
  const presetDest = join(RUNTIME, 'agent-presets')
  await mkdir(presetDest, { recursive: true })
  await cp(join(ROUTING_SUITE_SRC, 'preset', 'router-standard'), join(presetDest, 'router-standard'), { recursive: true })
  await cp(join(ROUTING_SUITE_SRC, 'preset', 'router-spec'), join(presetDest, 'router-spec'), { recursive: true })

  /* ── size prune: strip dead weight from the shipped node_modules ──
     (source maps, type declarations, TS sources, tests/docs, non-macOS
     prebuilds, audited package fat; --no-prune skips for forensics) */
  if (flags['no-prune'] === true) {
    console.log('prune: skipped (--no-prune)')
  } else {
    await pruneHarnessNodeModules(harnessDir, console.log)
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
    # dsh-routing-suite 注入器：运行时插件管理（dev_* 工具全家桶）
    - id: dsh-super-injector
      name: '@dsh-external/dsh-super-injector'
`)

  /* ── runtime manifest ── */
  await writeFile(join(RUNTIME, 'harness.json'), `${JSON.stringify({
    name: 'dsh-harness-desktop-runtime',
    runtimeVersion: config.runtimeVersion,
    dshVersion: config.dshVersion,
    modlensVersion: modlensVersion,
    dshmarketVersion: dshmarketVersion,
    pnpmVersion: pnpmVersion,
    npmVersion: npmVersion,
    channel: config.channel,
    updateFeed: config.updateFeed,
    arch: config.arch,
    builtAt: new Date().toISOString(),
  }, null, 2)}\n`)

  console.log(`runtime ready: ${RUNTIME}`)
  // Sanity-check the shim chain (needs the vendored Electron; assembly itself
  // does not — npm install runs on the build machine's npm).
  const electronBin = join(BUILD, 'vendor', 'electron', 'Electron.app', 'Contents', 'MacOS', 'Electron')
  if (existsSync(electronBin)) {
    const nodeVer = (await run(join(RUNTIME, 'node', 'bin', 'node'), ['--version'], {
      quiet: true,
      spawn: { env: { ...process.env, DSH_LAUNCHER_NODE_BIN: electronBin } },
    })).trim()
    console.log(`  dsh ${config.dshVersion}, modlens ${modlensVersion}, dshmarket ${dshmarketVersion}, pnpm ${pnpmVersion}, npm ${npmVersion}, node(electron) ${nodeVer}`)
  } else {
    console.log(`  dsh ${config.dshVersion}, modlens ${modlensVersion}, dshmarket ${dshmarketVersion}, pnpm ${pnpmVersion}, npm ${npmVersion}`)
    console.log('  note: vendored Electron missing — run `npm run fetch-tools` to verify the shim chain')
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
