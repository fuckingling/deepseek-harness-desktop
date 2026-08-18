/**
 * Run the assembled runtime directly on the dev machine (no Electron shell):
 * boots `dsh web` with the same app-internal environment the shell would set,
 * pointing DSH_HOME at build/dev-data. Used to verify the composition, the
 * updater routes, and the settings section before touching the .app.
 *
 * Usage: node scripts/dev-run.mjs [--port 3080] [--feed <url>] [--channel stable]
 */

import { spawn } from 'node:child_process'
import { mkdir, rm, symlink, readFile, lstat, readlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { delimiter, dirname, join, relative } from 'node:path'
import net from 'node:net'
import { BUILD, parseFlags, resolveConfig } from './lib/util.mjs'

const flags = parseFlags(process.argv.slice(2))
const config = resolveConfig(flags)

const RUNTIME = join(BUILD, 'runtime')
const DATA = join(BUILD, 'dev-data')

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

/** Reconcile the profile node_modules symlinks for runtime-resident plugins. */
async function syncPluginLinks(homeDir) {
  const profileModules = join(homeDir, 'profiles', 'web', 'node_modules')
  const plugins = [
    { name: 'dsh-launcher-updater', target: join(RUNTIME, 'plugins', 'dsh-launcher-updater') },
  ]
  for (const plugin of plugins) {
    if (!existsSync(plugin.target)) {
      console.warn(`dev-run: skipping ${plugin.name} (target missing)`)
      continue
    }
    const link = join(profileModules, plugin.name)
    const rel = relative(dirname(link), plugin.target)
    try {
      const stat = await lstat(link)
      if (stat.isSymbolicLink() && await readlink(link) === rel) continue
      await rm(link, { recursive: true, force: true })
    } catch { /* absent */ }
    await mkdir(dirname(link), { recursive: true })
    await symlink(rel, link, 'dir')
  }
}

async function main() {
  if (!existsSync(join(RUNTIME, 'harness.json'))) {
    throw new Error('runtime missing — run `npm run build-runtime` first')
  }
  await syncPluginLinks(join(DATA, 'home'))

  const port = flags.port !== undefined ? Number.parseInt(String(flags.port), 10) : await pickFreePort()
  const manifest = JSON.parse(await readFile(join(RUNTIME, 'harness.json'), 'utf8'))

  // The runtime's node shim runs the vendored Electron binary as Node
  // (ELECTRON_RUN_AS_NODE=1) — dev runs outside the .app bundle, so the
  // shim's bundle-layout discovery cannot help; point it here explicitly.
  const electronBin = join(BUILD, 'vendor', 'electron', 'Electron.app', 'Contents', 'MacOS', 'Electron')
  if (!existsSync(electronBin)) {
    throw new Error('vendored Electron missing — run `npm run fetch-tools` first')
  }

  const env = {
    ...process.env,
    DSH_HOME: join(DATA, 'home'),
    DSH_LAUNCHER_RUNTIME_DIR: RUNTIME,
    DSH_LAUNCHER_DATA_DIR: DATA,
    DSH_LAUNCHER_APP_VERSION: config.appVersion,
    DSH_LAUNCHER_FEED_URL: flags.feed ?? manifest.updateFeed ?? '',
    DSH_LAUNCHER_CHANNEL: flags.channel ?? manifest.channel ?? 'stable',
    DSH_LAUNCHER_NODE_BIN: electronBin,
    PATH: `${join(RUNTIME, 'node', 'bin')}${delimiter}${process.env.PATH ?? ''}`,
    npm_config_store_dir: join(DATA, 'pnpm-store'),
    npm_config_cache_dir: join(DATA, 'pnpm-cache'),
  }

  const overlay = join(RUNTIME, 'profile-overlay.yml')
  // Launcher flags first: --patch must precede the web app's own flags.
  const args = ['web']
  if (existsSync(overlay)) args.push('--patch', overlay)
  args.push('--host', '127.0.0.1', '--port', String(port))

  console.log(`booting runtime ${manifest.runtimeVersion} (dsh ${manifest.dshVersion}) on http://127.0.0.1:${port}/`)
  console.log(`DSH_HOME=${env.DSH_HOME}`)
  const child = spawn(join(RUNTIME, 'node', 'bin', 'node'), [
    join(RUNTIME, 'harness', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    ...args,
  ], { env, stdio: ['inherit', 'inherit', 'inherit'] })

  child.on('exit', code => {
    console.log(`\n[dev-run] dsh exited (code ${code})`)
    process.exit(code ?? 0)
  })
  process.on('SIGINT', () => child.kill('SIGINT'))
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
