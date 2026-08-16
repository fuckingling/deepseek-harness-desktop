/**
 * Shared build helpers: subprocess running, downloads, hashing, and the
 * project-wide build configuration. All scripts run on the build machine's
 * Node (dev-only tooling); the product itself never depends on it.
 * @module scripts/lib/util
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = fileURLToPath(new URL('../..', import.meta.url))
export const BUILD = join(ROOT, 'build')
export const DIST = join(ROOT, 'dist')

/** Run a command to completion; prints output lines with a prefix. */
export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const label = options.label ?? command
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options.spawn ?? {} })
    const out = []
    child.stdout.on('data', chunk => out.push(String(chunk)))
    child.stderr.on('data', chunk => out.push(String(chunk)))
    child.on('error', reject)
    child.on('close', code => {
      const text = out.join('')
      if (options.quiet !== true && text.trim() !== '') {
        for (const line of text.trimEnd().split('\n')) console.log(`[${label}] ${line}`)
      }
      if (code === 0) resolve(text)
      else reject(new Error(`${label} exited with code ${code}\n${text.slice(-4000)}`))
    })
  })
}

export function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('error', reject)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

/** Download a URL to a file with progress logging and a few retries. */
export async function download(url, target, label, attempts = 3) {
  let lastError
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await downloadOnce(url, target, label)
      return target
    } catch (error) {
      lastError = error
      if (attempt < attempts - 1) {
        console.warn(`  download retry ${attempt + 1}/${attempts - 1} after: ${error.message}`)
        await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)))
      }
    }
  }
  throw lastError
}

async function downloadOnce(url, target, label) {
  await mkdir(dirname(target), { recursive: true })
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15 * 60 * 1000) })
  if (!response.ok || response.body === null) {
    throw new Error(`download failed: ${url} → ${response.status}`)
  }
  const total = Number.parseInt(response.headers.get('content-length') ?? '0', 10) || null
  let received = 0
  let lastTick = 0
  const file = createWriteStream(target)
  const reader = response.body.getReader()
  const tick = (force = false) => {
    const now = Date.now()
    if (!force && now - lastTick < 1500) return
    lastTick = now
    const line = total === null
      ? `${(received / 1024 / 1024).toFixed(1)} MB`
      : `${(received / 1024 / 1024).toFixed(1)}/${(total / 1024 / 1024).toFixed(1)} MB (${Math.round((received / total) * 100)}%)`
    process.stdout.write(`\r  ${label ?? url}: ${line}  `)
  }
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value !== undefined) {
        received += value.length
        if (!file.write(Buffer.from(value))) await new Promise(resolve => file.once('drain', resolve))
        tick()
      }
    }
    await new Promise((resolve, reject) => file.end(error => (error === null ? resolve() : reject(error))))
    tick(true)
    process.stdout.write('\n')
  } catch (error) {
    file.destroy()
    throw error
  }
}

/** Resolve the build configuration (flags override defaults). */
export function resolveConfig(flags = {}) {
  return {
    arch: flags.arch ?? process.env.DSH_BUILD_ARCH ?? 'arm64',
    runtimeVersion: flags.runtimeVersion ?? '0.1.0',
    dshVersion: flags.dshVersion ?? '0.1.0-rc.6',
    channel: flags.channel ?? 'stable',
    updateFeed: flags.updateFeed ?? '',
    nodeVersion: flags.nodeVersion ?? null, // null = latest Node 24 LTS
    electronVersion: flags.electronVersion ?? null, // null = latest stable
    appVersion: flags.appVersion ?? '0.1.0',
  }
}

/** Small flag parser for --key value / --key=value. */
export function parseFlags(argv) {
  const flags = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const eq = arg.indexOf('=')
    if (eq !== -1) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1)
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      flags[arg.slice(2)] = argv[i + 1]
      i += 1
    } else {
      flags[arg.slice(2)] = true
    }
  }
  return flags
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

export { rename }
