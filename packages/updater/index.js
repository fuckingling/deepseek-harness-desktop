/**
 * Host half of the desktop launcher updater plugin.
 *
 * A single loader row (`name: dsh-launcher-updater`) contributes both halves:
 * this node half registers small JSON HTTP routes on the web surface's
 * `webServer` service (paths are OUTSIDE `/api`, which the connection package
 * owns as a prefix route); the browser half (`./client`) renders the settings
 * sections and talks to these routes with ordinary fetch calls.
 *
 * Routes:
 *   GET  /launcher-updater/status   engine snapshot
 *   POST /launcher-updater/check    run a feed check, return the snapshot
 *   POST /launcher-updater/apply    stage and swap an update, then restart
 *   POST /launcher-updater/restart  plain harness restart
 *
 *   GET  /launcher-backup/status    backup engine snapshot + local backup list
 *   POST /launcher-backup/create    create a chat-record backup archive
 *   GET  /launcher-backup/download  stream one local backup archive
 *   POST /launcher-backup/restore   restore from a local/uploaded archive
 *   POST /launcher-backup/delete    delete one local backup archive
 *
 * Request safety: bound request bodies, and the Origin/Host headers are
 * checked when present — only the loopback origin this UI is served from may
 * call in (the same threat model the /api trust fence follows; a browser
 * page at some other origin must not drive a local privileged update).
 *
 * @module dsh-launcher-updater
 */

import { createReadStream, statSync } from 'node:fs'
import { UpdaterEngine, RESTART_EXIT_CODE } from './lib/engine.js'
import { BackupEngine } from './lib/backup.js'
import { PersonalStatsEngine } from './lib/personal.js'

export const name = 'launcher-updater-host'

/** Services this fiber needs before its routes can bind. */
export const inject = ['webServer']

const MAX_BODY = 768 * 1024 * 1024 // restore uploads (base64) may be large

/** Read a JSON body, bounded; rejects oversized or malformed payloads. */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

/** Allow only loopback origins/hosts; absent headers pass (curl, same-origin). */
function loopbackOk(req) {
  const origin = req.headers.origin
  if (origin !== undefined) {
    let host
    try {
      host = new URL(origin).hostname
    } catch {
      return false
    }
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]' && host !== '::1') return false
  }
  const hostHeader = req.headers.host
  if (hostHeader !== undefined) {
    const bare = hostHeader.split(':')[0]
    if (bare !== '127.0.0.1' && bare !== 'localhost' && bare !== '[::1]' && bare !== '::1') return false
  }
  return true
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

export function apply(ctx) {
  const engine = new UpdaterEngine(ctx)
  const backups = new BackupEngine(ctx)
  const personal = new PersonalStatsEngine()
  engine.startScheduler()

  const handle = async (req, res, fn, statusOk = 200) => {
    if (!loopbackOk(req)) {
      sendJson(res, 403, { ok: false, error: 'forbidden origin' })
      return
    }
    try {
      const body = req.method === 'POST' ? await readJsonBody(req) : {}
      const result = await fn(body)
      sendJson(res, statusOk, { ok: true, status: result })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      sendJson(res, 400, { ok: false, error: message, status: engine.status() })
    }
  }

  const handleBackup = async (req, res, fn, statusOk = 200) => {
    if (!loopbackOk(req)) {
      sendJson(res, 403, { ok: false, error: 'forbidden origin' })
      return
    }
    try {
      const body = req.method === 'POST' ? await readJsonBody(req) : {}
      const result = await fn(body)
      sendJson(res, statusOk, { ok: true, status: result })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      sendJson(res, 400, { ok: false, error: message, status: backups.status() })
    }
  }

  ctx.effect(() => {
    const routes = [
      { path: '/launcher-updater/status', fn: () => engine.status() },
      { path: '/launcher-updater/check', fn: () => engine.check() },
      { path: '/launcher-updater/apply', fn: body => engine.apply(body ?? {}) },
      { path: '/launcher-updater/restart', fn: () => engine.requestRestart() },
      { path: '/launcher-updater/settings', fn: body => engine.setSettings(body ?? {}) },
      { path: '/launcher-backup/status', fn: () => backups.status() },
      { path: '/launcher-backup/create', fn: () => backups.create() },
      { path: '/launcher-backup/restore', fn: body => backups.restore(body ?? {}) },
      { path: '/launcher-backup/delete', fn: body => backups.deleteBackup((body ?? {}).name ?? '') },
      { path: '/launcher-personal/status', fn: () => personal.status() },
      { path: '/launcher-personal/settings', fn: body => personal.setPricing((body ?? {}).pricing ?? {}) },
    ]
    const disposers = routes.map(route => ctx.webServer.register({
      kind: 'exact',
      path: route.path,
      handler: (req, res) => handle(req, res, route.fn),
    }))
    // Backup downloads stream the archive instead of answering JSON.
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/launcher-backup/download',
      handler: (req, res) => {
        if (!loopbackOk(req)) {
          sendJson(res, 403, { ok: false, error: 'forbidden origin' })
          return
        }
        try {
          const url = new URL(req.url ?? '/', 'http://x')
          const name = url.searchParams.get('name') ?? ''
          const file = backups.resolveBackup(name)
          const stat = statSync(file)
          res.writeHead(200, {
            'content-type': 'application/gzip',
            'content-length': stat.size,
            'content-disposition': `attachment; filename="${name}"`,
          })
          const stream = createReadStream(file)
          stream.on('error', () => res.destroy())
          stream.pipe(res)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          sendJson(res, 400, { ok: false, error: message })
        }
      },
    }))
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'launcher-updater-host: routes')
}

export { RESTART_EXIT_CODE }
