/**
 * Package the built .app into a DMG and produce the update-feed artifacts:
 *
 *   dist/dmg/DeepSeek Harness-<app-version>-<arch>.dmg
 *   dist/feed/runtime-<runtimeVersion>-darwin-<arch>.tar.gz   (the update unit)
 *   dist/feed/feed.json                                       (feed for publishing)
 *
 * The DMG gets a standard "drag to Applications" layout (best effort: the
 * Finder arrangement is cosmetic and skipped silently if osascript is
 * unavailable).
 *
 * Usage: node scripts/build-dmg.mjs [--update-feed <base-url>] [--sign-identity <id>]
 */

import { cp, mkdir, rm, writeFile, readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { BUILD, DIST, ROOT, parseFlags, resolveConfig, run, sha256File } from './lib/util.mjs'

const flags = parseFlags(process.argv.slice(2))
const config = resolveConfig(flags)

const APP_NAME = 'DeepSeek Harness'
const APP_DIR = join(DIST, 'app', `${APP_NAME}.app`)
const RUNTIME_SRC = join(BUILD, 'runtime')

async function main() {
  if (!existsSync(join(APP_DIR, 'Contents', 'MacOS', APP_NAME))) {
    throw new Error('app missing — run `npm run build-app` first')
  }

  await mkdir(join(DIST, 'dmg'), { recursive: true })
  await mkdir(join(DIST, 'feed'), { recursive: true })

  const dmgName = `${APP_NAME}-${config.appVersion}-${config.arch}.dmg`
  const dmgPath = join(DIST, 'dmg', dmgName)
  const staging = join(BUILD, 'dmg-staging')
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  await cp(APP_DIR, join(staging, `${APP_NAME}.app`), { recursive: true, dereference: false })
  await run('/bin/ln', ['-s', '/Applications', join(staging, 'Applications')], { label: 'ln' })

  console.log(`creating ${dmgPath} …`)
  await rm(dmgPath, { force: true })
  // Default UDZO (zlib) at maximum level: noticeably smaller than hdiutil's
  // default (which favors speed) and fast to create/mount.
  // --dmg-format UDBZ re-encodes a UDZO-9 image as bzip2: ~30% smaller
  // release artifact, at the cost of a slower build and mount. (Creating
  // UDBZ straight from the staging folder uses small blocks and barely
  // beats UDZO-9; the convert path is what actually shrinks it.)
  const format = flags['dmg-format'] ?? 'UDZO'
  const udzoImageKey = ['-imagekey', 'zlib-level=9']
  if (format === 'UDBZ') {
    const udzoPath = `${dmgPath}.udzo.tmp.dmg`
    await rm(udzoPath, { force: true })
    await run('/usr/bin/hdiutil', [
      'create', '-volname', APP_NAME, '-srcfolder', staging, '-ov', '-format', 'UDZO',
      ...udzoImageKey, udzoPath,
    ], { label: 'hdiutil-create-udzo' })
    await run('/usr/bin/hdiutil', [
      'convert', udzoPath, '-format', 'UDBZ', '-imagekey', 'bzip2-level=9', '-o', dmgPath,
    ], { label: 'hdiutil-convert-udbz' })
    await rm(udzoPath, { force: true })
  } else {
    const imageKeyArgs = format === 'UDZO' ? udzoImageKey : []
    await run('/usr/bin/hdiutil', [
      'create', '-volname', APP_NAME, '-srcfolder', staging, '-ov', '-format', format,
      ...imageKeyArgs, dmgPath,
    ], { label: 'hdiutil' })
  }

  // Cosmetic Finder layout: mount, arrange icons, detach. Best effort —
  // read-write mount may be denied in sandboxed/CI environments; the DMG is
  // fully usable without the icon arrangement.
  try {
    const mount = join(BUILD, 'dmg-mount')
    await mkdir(mount, { recursive: true })
    await run('/usr/bin/hdiutil', ['attach', dmgPath, '-nobrowse', '-readwrite', '-mountpoint', mount], { label: 'hdiutil-attach', quiet: true })
    await run('/usr/bin/osascript', ['-e', `
      tell application "Finder"
        tell disk "${APP_NAME}"
          open
          set current view of container window to icon view
          set toolbar visible of container window to false
          set statusbar visible of container window to false
          set the bounds of container window to {200, 200, 760, 540}
          set viewOptions to the icon view options of container window
          set arrangement of viewOptions to not arranged
          set icon size of viewOptions to 96
          set position of item "${APP_NAME}.app" of container window to {150, 170}
          set position of item "Applications" of container window to {410, 170}
          close
          update without registering applications
        end tell
      end tell
    `], { label: 'osascript' })
    await run('/usr/bin/hdiutil', ['detach', mount, '-quiet'], { label: 'hdiutil-detach', quiet: true })
  } catch (error) {
    console.warn(`  warning: Finder layout skipped (${error.message.split('\n').slice(0, 2).join(' | ')})`)
  }

  /* ── update feed artifacts ── */
  const artifactName = `runtime-${config.runtimeVersion}-darwin-${config.arch}.tar.gz`
  const artifactPath = join(DIST, 'feed', artifactName)
  console.log(`packaging update artifact ${artifactName} …`)
  await rm(artifactPath, { force: true })
  await run('/usr/bin/tar', ['-czf', artifactPath, '-C', RUNTIME_SRC, '.'], { label: 'tar', quiet: true })
  const sha256 = await sha256File(artifactPath)

  const feedBase = flags['update-feed'] ?? config.updateFeed ?? ''
  const feedUrl = feedBase === '' ? '' : `${feedBase.replace(/\/+$/, '')}/${artifactName}`
  const feed = {
    schemaVersion: 1,
    defaultChannel: config.channel,
    channels: {
      [config.channel]: {
        latest: {
          version: config.runtimeVersion,
          dshVersion: config.dshVersion,
          notes: flags.notes ?? '',
          publishedAt: new Date().toISOString(),
          artifacts: {
            [`darwin-${config.arch}`]: {
              url: feedUrl,
              sha256,
            },
          },
        },
      },
    },
  }
  const feedPath = join(DIST, 'feed', 'feed.json')
  await writeFile(feedPath, `${JSON.stringify(feed, null, 2)}\n`)

  const runtime = JSON.parse(await readFile(join(RUNTIME_SRC, 'harness.json'), 'utf8'))
  console.log('done:')
  console.log(`  dmg:     ${dmgPath}`)
  console.log(`  artifact:${artifactPath}  (${sha256})`)
  console.log(`  feed:    ${feedPath}`)
  if (feedUrl === '') {
    console.log('  note:    feed artifact url is empty — publish with --update-feed <base-url> to fill it')
  } else {
    console.log(`  note:    runtime ${runtime.runtimeVersion} feeds from ${feedUrl}`)
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
