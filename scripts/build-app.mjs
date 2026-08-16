/**
 * Assemble `dist/app/DeepSeek Harness.app` from the vendored Electron.app,
 * the shell code, the assembled runtime, and the data seed, then ad-hoc sign.
 *
 * Bundle layout (everything the app needs lives inside it):
 *
 *   Contents/MacOS/DeepSeek Harness        renamed Electron binary (immutable)
 *   Contents/Resources/app/                the supervisor shell (immutable)
 *   Contents/Resources/runtime/            active runtime (swapped on update)
 *   Contents/Resources/runtime.pristine/   factory runtime (self-heal source)
 *   Contents/Resources/data/               user data: DSH_HOME, logs
 *   Contents/Resources/icon.icns
 *
 * Usage: node scripts/build-app.mjs [--app-version 0.1.0] [--skip-sign]
 */

import { cp, mkdir, rm, writeFile, readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { BUILD, DIST, ROOT, parseFlags, resolveConfig, run } from './lib/util.mjs'

const flags = parseFlags(process.argv.slice(2))
const config = resolveConfig(flags)

const APP_NAME = 'DeepSeek Harness'
const APP_DIR = join(DIST, 'app', `${APP_NAME}.app`)
const RESOURCES = join(APP_DIR, 'Contents', 'Resources')
const RUNTIME_SRC = join(BUILD, 'runtime')
const ELECTRON_APP = join(BUILD, 'vendor', 'electron', 'Electron.app')

function plist() {
  const version = config.appVersion
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDevelopmentRegion</key>
	<string>zh_CN</string>
	<key>CFBundleDisplayName</key>
	<string>${APP_NAME}</string>
	<key>CFBundleExecutable</key>
	<string>${APP_NAME}</string>
	<key>CFBundleIconFile</key>
	<string>icon</string>
	<key>CFBundleIdentifier</key>
	<string>com.deepseek.harness</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleName</key>
	<string>${APP_NAME}</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>${version}</string>
	<key>CFBundleVersion</key>
	<string>${version}</string>
	<key>LSApplicationCategoryType</key>
	<string>public.app-category.developer-tools</string>
	<key>LSMinimumSystemVersion</key>
	<string>12.0</string>
	<key>NSHighResolutionCapable</key>
	<true/>
	<key>NSHumanReadableCopyright</key>
	<string>MIT License. DeepSeek Harness desktop launcher.</string>
	<key>NSSupportsAutomaticGraphicsSwitching</key>
	<true/>
</dict>
</plist>
`
}

async function main() {
  if (!existsSync(join(RUNTIME_SRC, 'harness.json'))) {
    throw new Error('runtime missing — run `npm run build-runtime` first')
  }
  if (!existsSync(join(ELECTRON_APP, 'Contents', 'MacOS', 'Electron'))) {
    throw new Error('vendored Electron missing — run `npm run fetch-tools` first')
  }

  console.log(`assembling ${APP_NAME} ${config.appVersion} (${config.arch})`)
  await rm(join(DIST, 'app'), { recursive: true, force: true })
  await mkdir(join(DIST, 'app'), { recursive: true })
  // ditto (not fs.cp): it preserves the framework's relative symlinks verbatim.
  await run('/usr/bin/ditto', [ELECTRON_APP, APP_DIR], { label: 'ditto' })

  /* ── main executable ── */
  await run('/bin/mv', [
    join(APP_DIR, 'Contents', 'MacOS', 'Electron'),
    join(APP_DIR, 'Contents', 'MacOS', APP_NAME),
  ], { label: 'rename-binary' })

  /* ── Info.plist ── */
  await writeFile(join(APP_DIR, 'Contents', 'Info.plist'), plist())

  /* ── icon ── */
  const iconSrc = join(ROOT, 'assets', 'icon.icns')
  if (existsSync(iconSrc)) {
    await cp(iconSrc, join(RESOURCES, 'icon.icns'))
  } else {
    console.warn('  warning: assets/icon.icns missing — run `npm run make-icon`; continuing without an icon')
  }

  /* ── shell ── */
  await rm(join(RESOURCES, 'app'), { recursive: true, force: true })
  await cp(join(ROOT, 'shell'), join(RESOURCES, 'app'), { recursive: true })

  /* ── runtime + pristine ── */
  console.log('  copying runtime (active + pristine)…')
  await rm(join(RESOURCES, 'runtime'), { recursive: true, force: true })
  await rm(join(RESOURCES, 'runtime.pristine'), { recursive: true, force: true })
  await cp(RUNTIME_SRC, join(RESOURCES, 'runtime'), { recursive: true, dereference: false })
  await cp(RUNTIME_SRC, join(RESOURCES, 'runtime.pristine'), { recursive: true, dereference: false })

  /* ── data dir: created empty; the shell seeds profiles, plugin links, and
     logs on first boot (and reconciles them on every boot) ── */
  await mkdir(join(RESOURCES, 'data'), { recursive: true })

  /* ── sign (ad-hoc; swap a Developer ID identity via --sign-identity) ── */
  if (flags['skip-sign'] !== true) {
    const identity = flags['sign-identity'] ?? '-'
    console.log(`  codesign (identity: ${identity === '-' ? 'ad-hoc' : identity}) …`)
    const sign = path => run('/usr/bin/codesign', ['--force', '--sign', String(identity), path], { label: 'codesign', quiet: true })

    // Layered signing: the Electron Framework is itself a signed nested
    // component; --deep on the outer bundle refuses to re-seal it. Sign the
    // helpers, the framework, then the app.
    const framework = join(APP_DIR, 'Contents', 'Frameworks', 'Electron Framework.framework')
    const helpersDir = join(framework, 'Versions', 'A', 'Helpers')
    for (const entry of await readdir(helpersDir)) {
      await sign(join(helpersDir, entry))
    }
    await sign(framework)
    await sign(APP_DIR)
    // Best-effort verification: Electron ships ReactiveObjC.framework with a
    // seal whose resource rules --deep verification rejects (an upstream
    // quirk, present in the official dist). A real launch is the check that
    // matters; treat verification failure as a warning.
    try {
      await run('/usr/bin/codesign', ['--verify', '--deep', '--verbose=1', APP_DIR], { label: 'codesign-verify' })
    } catch (error) {
      console.warn(`  warning: codesign verify reported: ${error.message.split('\n')[1] ?? error.message}`)
    }
  }

  const manifest = JSON.parse(await readFile(join(RESOURCES, 'runtime', 'harness.json'), 'utf8'))
  console.log(`app ready: ${APP_DIR}`)
  console.log(`  runtime ${manifest.runtimeVersion} (dsh ${manifest.dshVersion}), app ${config.appVersion}`)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
