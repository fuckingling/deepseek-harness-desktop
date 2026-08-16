/**
 * Run e2e probes inside the built app (dist/app/DeepSeek Harness.app) using
 * the shell's DSH_LAUNCHER_E2E_* verification hook. Each probe is a JS file
 * executed inside the rendered page; its returned JSON lands in
 * build/e2e-<name>.json, and --shot adds a PNG capture next to it.
 *
 * The desktop app must not be running already (single-instance lock).
 *
 * Usage:
 *   node scripts/e2e.mjs                          # run every e2e/check-*.js probe
 *   node scripts/e2e.mjs e2e/check-personal.js    # one probe
 *   node scripts/e2e.mjs --shot e2e/check-heatmap-layout.js
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { BUILD, DIST, ROOT } from './lib/util.mjs'

const APP_BIN = join(DIST, 'app', 'DeepSeek Harness.app', 'Contents', 'MacOS', 'DeepSeek Harness')
const E2E_DIR = join(ROOT, 'e2e')
const PROBE_TIMEOUT_MS = 120000

const argv = process.argv.slice(2)
const shot = argv.includes('--shot')
const probes = argv.filter(arg => arg !== '--shot')

async function defaultProbes() {
  const files = await readdir(E2E_DIR)
  return files
    .filter(file => file.startsWith('check-') && file.endsWith('.js'))
    .sort()
    .map(file => join(E2E_DIR, file))
}

function runProbe(probe) {
  const name = basename(probe).replace(/\.js$/, '')
  const out = join(BUILD, `e2e-${name}.json`)
  const env = { ...process.env, DSH_LAUNCHER_E2E_SCRIPT: resolve(probe), DSH_LAUNCHER_E2E_OUT: out }
  if (shot) env.DSH_LAUNCHER_E2E_SHOT = join(BUILD, `e2e-${name}.png`)
  return new Promise(resolveResult => {
    const child = spawn(APP_BIN, [], { env, stdio: ['ignore', 'ignore', 'inherit'] })
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, PROBE_TIMEOUT_MS)
    child.on('exit', async code => {
      clearTimeout(timer)
      if (timedOut) return resolveResult({ name, ok: false, reason: 'timeout (is the app already running?)' })
      if (code === 0 && existsSync(out)) {
        try {
          const data = JSON.parse(await readFile(out, 'utf8'))
          return resolveResult({ name, ok: data.ok !== false, detail: data.ok === undefined ? 'informational' : `ok=${data.ok}` })
        } catch {
          return resolveResult({ name, ok: false, reason: `unreadable result ${out}` })
        }
      }
      return resolveResult({ name, ok: false, reason: `exit ${code} without result` })
    })
  })
}

async function main() {
  if (!existsSync(APP_BIN)) throw new Error('app missing — run `npm run build-app` first')
  await mkdir(BUILD, { recursive: true })
  const targets = probes.length > 0 ? probes : await defaultProbes()
  console.log(`e2e: ${targets.length} probe(s), results → build/`)
  let failed = 0
  for (const probe of targets) {
    if (!existsSync(probe)) { console.error(`✗ ${probe} not found`); failed += 1; continue }
    console.log(`\n▶ ${basename(probe)}`)
    const result = await runProbe(probe)
    if (result.ok) console.log(`  ✓ ${result.detail}`)
    else { console.error(`  ✗ ${result.reason}`); failed += 1 }
  }
  if (failed > 0) { console.error(`\ne2e: ${failed} probe(s) failed`); process.exit(1) }
  console.log('\ne2e: all probes ok')
}

main().catch(error => { console.error(error); process.exit(1) })
