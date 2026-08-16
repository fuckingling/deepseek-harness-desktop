/**
 * Build a FAKE newer runtime artifact for end-to-end update testing:
 * copies the assembled runtime, bumps its runtimeVersion, packages it as a
 * feed artifact, and rewrites dist/feed/feed.json to point at a local server.
 *
 * Usage:
 *   node scripts/make-fake-update.mjs --new-version 9.9.9 --feed-base http://127.0.0.1:8099
 *   cd dist/feed && python3 -m http.server 8099
 *   node scripts/dev-run.mjs --feed http://127.0.0.1:8099/feed.json
 */

import { cp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BUILD, DIST, parseFlags, resolveConfig, run, sha256File } from './lib/util.mjs'

const flags = parseFlags(process.argv.slice(2))
const config = resolveConfig(flags)
const newVersion = flags['new-version'] ?? '9.9.9'
const feedBase = flags['feed-base'] ?? 'http://127.0.0.1:8099'

async function main() {
  const src = join(BUILD, 'fake-update-src')
  await rm(src, { recursive: true, force: true })
  await cp(join(BUILD, 'runtime'), src, { recursive: true, dereference: false })

  const manifestPath = join(src, 'harness.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.runtimeVersion = newVersion
  manifest.builtAt = new Date().toISOString()
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

  await mkdir(join(DIST, 'feed'), { recursive: true })
  const artifactName = `runtime-${newVersion}-darwin-${config.arch}.tar.gz`
  const artifactPath = join(DIST, 'feed', artifactName)
  await rm(artifactPath, { force: true })
  await run('/usr/bin/tar', ['-czf', artifactPath, '-C', src, '.'], { label: 'tar', quiet: true })
  const sha256 = await sha256File(artifactPath)

  const feed = {
    schemaVersion: 1,
    defaultChannel: config.channel,
    channels: {
      [config.channel]: {
        latest: {
          version: newVersion,
          dshVersion: manifest.dshVersion,
          notes: `FAKE update to ${newVersion} for local e2e testing.`,
          publishedAt: new Date().toISOString(),
          artifacts: {
            [`darwin-${config.arch}`]: {
              url: `${feedBase.replace(/\/+$/, '')}/${artifactName}`,
              sha256,
            },
          },
        },
      },
    },
  }
  await writeFile(join(DIST, 'feed', 'feed.json'), `${JSON.stringify(feed, null, 2)}\n`)
  console.log(`fake update ready: ${artifactPath}`)
  console.log(`feed: dist/feed/feed.json → ${feedBase}/feed.json`)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
