/**
 * Assemble the self-contained harness runtime at build/runtime:
 *
 *   node/      bin shims only: node/npm/pnpm run on the app's Electron
 *              binary (ELECTRON_RUN_AS_NODE=1) — no standalone Node.js is
 *              bundled anymore (was ~196 MB; the shell passes its own
 *              execPath down via DSH_LAUNCHER_NODE_BIN)
 *   harness/   @deepseek-ai/dsh install + bundled default plugins
 *   plugins/   dsh-launcher-updater (the launcher plugin: updates, backup &
 *              restore, personal center; zero-dependency)
 *   profile-overlay.yml  composition overlay the shell boots with --patch:
 *                        mounts the launcher plugin
 *   harness.json  runtime manifest the updater and shell read
 *
 * This directory is BOTH what the .app embeds (runtime + its pristine
 * tar.gz snapshot) and what the update feed ships (tar.gz artifact) — one
 * source of truth.
 *
 * Usage: node scripts/build-runtime.mjs [--dsh-version 0.1.0-rc.6] [--runtime-version 0.1.0] [--pnpm-version 10.28.2] [--npm-version 11.17.0] [--channel stable] [--update-feed <url>] [--arch arm64] [--no-prune]
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

async function main() {
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
  // it as runtime/node/bin/pnpm so the agent's own shell finds pnpm without
  // probing the user's PATH, corepack, or `npm -g`.
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
    // never through loose npm resolution. pnpm/npm ship as plain-JS packages
    // inside the harness install so their dependencies resolve from the same
    // node_modules: npm runs official-registry updates in the updater plugin,
    // pnpm is exposed to the agent's own shell via the runtime bin shims.
    dependencies: {
      '@deepseek-ai/dsh': config.dshVersion,
      'pnpm': pnpmVersion,
      'npm': npmVersion,
    },
  }, null, 2)}\n`)
  console.log(`npm install @deepseek-ai/dsh@${config.dshVersion} pnpm@${pnpmVersion} npm@${npmVersion} …`)
  await run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=warn'], {
    label: 'npm',
    spawn: { cwd: harnessDir },
  })
  const installed = JSON.parse(await readFile(join(harnessDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'))
  if (installed.version !== config.dshVersion) {
    throw new Error(`installed dsh ${installed.version} != requested ${config.dshVersion}`)
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
    # 启动器插件（双面：host 更新引擎 + 设置页“更新”“备份与还原”“个人中心”面板）
    - id: launcher-updater
      name: dsh-launcher-updater
`)

  /* ── runtime manifest ── */
  await writeFile(join(RUNTIME, 'harness.json'), `${JSON.stringify({
    name: 'dsh-harness-desktop-runtime',
    runtimeVersion: config.runtimeVersion,
    dshVersion: config.dshVersion,
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
    console.log(`  dsh ${config.dshVersion}, pnpm ${pnpmVersion}, npm ${npmVersion}, node(electron) ${nodeVer}`)
  } else {
    console.log(`  dsh ${config.dshVersion}, pnpm ${pnpmVersion}, npm ${npmVersion}`)
    console.log('  note: vendored Electron missing — run `npm run fetch-tools` to verify the shim chain')
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
