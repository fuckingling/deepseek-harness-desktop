/**
 * Fetch the build-time vendored tools into build/vendor:
 *   - a standalone Node.js 24 (LTS) distribution for the runtime (the
 *     harness runs on THIS node, never on the user's system node),
 *   - the Electron.app distribution for the launcher shell.
 *
 * pnpm is NOT fetched here: the runtime bundles the npm `pnpm` package
 * (plain JS, runs on the bundled Node via a bin shim) because pnpm's
 * standalone binaries are unsigned and macOS kills them.
 *
 * Downloads are cached; re-running reuses them. Versions resolve
 * automatically (latest stable Electron, latest Node 24) unless pinned with
 * --electron-version / --node-version.
 *
 * Usage: node scripts/fetch-tools.mjs [--arch arm64|x64] [--electron-version v..] [--node-version 24.x.y]
 */

import { chmod, mkdir, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { BUILD, download, parseFlags, run, resolveConfig } from './lib/util.mjs'

const flags = parseFlags(process.argv.slice(2))
const config = resolveConfig(flags)

const VENDOR = join(BUILD, 'vendor')
const NODE_DIR = join(VENDOR, 'node')
const ELECTRON_DIR = join(VENDOR, 'electron')

async function fetchJsonWithRetry(url, attempts = 4) {
  let lastError
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30000) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.json()
    } catch (error) {
      lastError = error
      if (i < attempts - 1) {
        console.warn(`  retry ${i + 1}/${attempts - 1} after: ${error.message}`)
        await new Promise(resolve => setTimeout(resolve, 1500 * (i + 1)))
      }
    }
  }
  throw lastError
}

async function latestNode24() {
  const index = await fetchJsonWithRetry('https://nodejs.org/dist/index.json')
  const match = index.find(entry => String(entry.version).startsWith('v24.') && entry.lts !== false)
  if (match === undefined) throw new Error('no Node 24 LTS found in dist index')
  return match
}

async function latestElectron() {
  const candidates = [
    'https://registry.npmjs.org/electron/latest',
    'https://api.github.com/repos/electron/electron/releases/latest',
  ]
  let lastError
  for (const url of candidates) {
    try {
      const data = await fetchJsonWithRetry(url, 2)
      if (typeof data.version === 'string' && data.version !== '') return data.version
      if (typeof data.tag_name === 'string' && data.tag_name !== '') return data.tag_name.replace(/^v/, '')
    } catch (error) {
      lastError = error
    }
  }
  throw lastError ?? new Error('no electron version source responded')
}

async function main() {
  console.log(`arch=${config.arch}`)
  await mkdir(VENDOR, { recursive: true })

  /* ── Node ── */
  if (existsSync(join(NODE_DIR, 'bin', 'node'))) {
    const version = await run(join(NODE_DIR, 'bin', 'node'), ['--version'], { quiet: true })
    console.log(`node: cached ${version.trim()}`)
  } else {
    const entry = config.nodeVersion !== null
      ? { version: /^v/.test(config.nodeVersion) ? config.nodeVersion : `v${config.nodeVersion}`, files: null }
      : await latestNode24()
    const version = entry.version
    const url = `https://nodejs.org/dist/${version}/node-${version}-darwin-${config.arch}.tar.gz`
    console.log(`node: downloading ${url}`)
    const archive = join(VENDOR, `node-${version}.tar.gz`)
    await download(url, archive, 'node')
    await rm(join(VENDOR, 'node-extract'), { recursive: true, force: true })
    await mkdir(join(VENDOR, 'node-extract'), { recursive: true })
    await run('/usr/bin/tar', ['-xzf', archive, '-C', join(VENDOR, 'node-extract')], { label: 'tar' })
    await rm(NODE_DIR, { recursive: true, force: true })
    await run('/bin/mv', [join(VENDOR, 'node-extract', `node-${version}-darwin-${config.arch}`), NODE_DIR], { label: 'mv' })
    await rm(join(VENDOR, 'node-extract'), { recursive: true, force: true })
    await rm(archive, { force: true })
    console.log(`node: installed ${version} → ${NODE_DIR}`)
  }

  /* ── Electron ── */
  const electronApp = join(ELECTRON_DIR, 'Electron.app')
  if (existsSync(join(electronApp, 'Contents', 'MacOS', 'Electron'))) {
    const plist = await readFile(join(electronApp, 'Contents', 'Info.plist'), 'utf8')
    const match = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)
    console.log(`electron: cached ${match?.[1] ?? 'unknown'}`)
  } else {
    const version = config.electronVersion !== null
      ? (config.electronVersion.startsWith('v') ? config.electronVersion.slice(1) : config.electronVersion)
      : await latestElectron()
    const url = `https://github.com/electron/electron/releases/download/v${version}/electron-v${version}-darwin-${config.arch}.zip`
    console.log(`electron: downloading ${url}`)
    const archive = join(VENDOR, `electron-v${version}.zip`)
    await download(url, archive, 'electron')
    await rm(ELECTRON_DIR, { recursive: true, force: true })
    await mkdir(ELECTRON_DIR, { recursive: true })
    await run('/usr/bin/unzip', ['-q', archive, '-d', ELECTRON_DIR], { label: 'unzip' })
    await rm(archive, { force: true })
    console.log(`electron: installed v${version} → ${ELECTRON_DIR}`)
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
