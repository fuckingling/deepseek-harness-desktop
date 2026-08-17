/**
 * Fetch the build-time vendored tools into build/vendor:
 *   - the Electron.app distribution for the launcher shell. Its binary is
 *     ALSO the runtime Node: the runtime ships only bin shims (node/npm/pnpm)
 *     that exec the app binary with ELECTRON_RUN_AS_NODE=1, so no standalone
 *     Node.js distribution is bundled anymore (previously ~196 MB).
 *
 * pnpm/npm are plain-JS npm packages installed inside the runtime's harness
 * install; pnpm's standalone binaries are unsigned and macOS kills them.
 *
 * Downloads are cached; re-running reuses them. The Electron version resolves
 * automatically (latest stable) unless pinned with --electron-version.
 *
 * Usage: node scripts/fetch-tools.mjs [--arch arm64|x64] [--electron-version v..]
 */

import { mkdir, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { BUILD, download, parseFlags, run, resolveConfig } from './lib/util.mjs'

const flags = parseFlags(process.argv.slice(2))
const config = resolveConfig(flags)

const VENDOR = join(BUILD, 'vendor')
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

  /* ── Electron (shell + runtime Node via ELECTRON_RUN_AS_NODE) ── */
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
