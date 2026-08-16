/**
 * Generate assets/icon.icns from assets/icon-app.svg using the vendored
 * Electron (offscreen render → PNG → iconset → iconutil). macOS tooling only;
 * the .icns is what build-app embeds as the bundle icon.
 *
 * Usage: node scripts/make-icon.mjs
 */

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BUILD, ROOT, parseFlags, run } from './lib/util.mjs'

const flags = parseFlags(process.argv.slice(2))
const ELECTRON_BIN = join(BUILD, 'vendor', 'electron', 'Electron.app', 'Contents', 'MacOS', 'Electron')

const ICON_SIZES = [
  [16, 16], [16, 32], [32, 32], [32, 64],
  [128, 128], [128, 256], [256, 256], [256, 512],
  [512, 512], [512, 1024],
]

async function main() {
  const work = join(BUILD, 'icon-work')
  await rm(work, { recursive: true, force: true })
  await mkdir(work, { recursive: true })

  const renderer = join(work, 'render-icon.js')
  await writeFile(renderer, `
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const svg = fs.readFileSync(${JSON.stringify(join(ROOT, 'assets', 'icon-app.svg'))}, 'utf8')
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, frame: false, transparent: false, webPreferences: { offscreen: true } })
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<body style="margin:0">' + svg + '</body>'))
  await new Promise(r => setTimeout(r, 400))
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 })
  fs.writeFileSync(${JSON.stringify(join(work, 'icon-1024.png'))}, image.toPNG())
  app.quit()
})
`)

  console.log('rendering 1024px icon via Electron…')
  await run(ELECTRON_BIN, [renderer], { label: 'electron-render' })

  const iconset = join(work, 'icon.iconset')
  await mkdir(iconset, { recursive: true })
  for (const [logical, pixels] of ICON_SIZES) {
    const scale = logical === pixels ? '' : '@2x'
    await run('/usr/bin/sips', ['-z', String(pixels), String(pixels), join(work, 'icon-1024.png'), '--out', join(iconset, `icon_${logical}x${logical}${scale}.png`)], { label: 'sips', quiet: true })
  }
  const out = join(ROOT, 'assets', 'icon.icns')
  await run('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', out], { label: 'iconutil' })
  console.log(`icon ready: ${out}`)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
