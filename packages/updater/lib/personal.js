/**
 * Personal-center stats engine of the desktop launcher plugin.
 *
 * Aggregates chat activity into the Codex-style personal center: cumulative
 * tokens (input / cache hit / cache miss / output), peak daily usage, the
 * longest session, the consecutive-day streak, cost, and the per-day token
 * activity map that feeds the heatmap.
 *
 * Data sources — read directly from the launcher data directory
 * (`DSH_LAUNCHER_DATA_DIR`), parsed tolerantly so shape drift degrades a
 * figure instead of breaking the page:
 *
 *   storages/session_projcache.json
 *     the persisted projection cache. Two shapes are accepted: the current
 *     domain-data form (`tables.sessions.<id>.identity` +
 *     `rows.tokenUsage.val.totals`, `rows.sessionStats.val`,
 *     `rows.title.val` — the durable cumulative fold) and the legacy flat
 *     form (`<id>.tokenUsage` / `<id>.sessionStats`).
 *   storages/workspace.json
 *     domain-data form; `tables.workspaces.<id>.sessionIds` +
 *     `updatedAt` supplies each session's last-activity time.
 *   storages/sessions.json (legacy installs only)
 *     session headers (id, createdAt, updatedAt, title, model) and, when
 *     present, embedded per-message usage events.
 *   sessions/<project>/<session>/session.jsonl[.zstd]
 *     the append-only session event log (the exact per-day heatmap source):
 *     per-step `assistant/chunk` usage events with timestamps, the session
 *     header, `session/title`, and the model from `request/header` /
 *     `request/context`. Zstandard artifacts are read frame-by-frame with
 *     Node's built-in zstd decompressor; the per-session cumulative totals
 *     from the projection cache remain the fallback when a log is missing
 *     or truncated, attributed to the session's last-activity day.
 *
 * Cost follows the official DeepSeek pricing with the 8/17 price change and
 * the Beijing-time peak schedule (peak 9–12 & 14–18; off-peak otherwise),
 * matching the published table; prices are editable and persist into
 * launcher-settings.json.
 *
 * @module dsh-launcher-updater/personal
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import * as zlib from 'node:zlib'

const DAY_MS = 24 * 60 * 60 * 1000

/** Official pricing boundary: 2026-08-17 00:00 Beijing time. */
const BOUNDARY_MS = Date.UTC(2026, 7, 16, 16, 0, 0)

/** Default official prices, ¥ per 1M tokens (hit = cache read, miss = input). */
export const DEFAULT_PRICING = {
  before: { flash: { hit: 0.02, miss: 1, out: 2 }, pro: { hit: 0.025, miss: 3, out: 6 } },
  offPeak: { flash: { hit: 0.05, miss: 1.5, out: 4.5 }, pro: { hit: 0.15, miss: 4.5, out: 13.5 } },
  peak: { flash: { hit: 0.1, miss: 3, out: 9 }, pro: { hit: 0.3, miss: 9, out: 27 } },
}

/** Peak windows (Beijing time) as [startHour, endHour) pairs. */
export const DEFAULT_PEAK_HOURS = [[9, 12], [14, 18]]

/** Local day key for a timestamp (sessions live on machine-local days). */
function localDayKey(ms) {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function isBeijingPeak(ms) {
  const d = new Date(ms + 8 * 3600 * 1000) // shift to Beijing wall clock
  const h = d.getUTCHours()
  return DEFAULT_PEAK_HOURS.some(([start, end]) => h >= start && h < end)
}

function modelTier(model) {
  const m = String(model ?? '').toLowerCase()
  if (m.includes('pro') || m.includes('reasoner')) return 'pro'
  return 'flash'
}

/** Display/aggregation key for a model: the real model name, never a tier. */
function modelName(model) {
  const s = String(model ?? '').trim()
  return s === '' ? 'unknown' : s
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function emptyBucket() {
  return { input: 0, cacheHit: 0, cacheMiss: 0, output: 0, tokens: 0, cost: 0 }
}

function mergeBucket(target, src) {
  for (const key of Object.keys(src)) {
    if (typeof src[key] === 'number') target[key] = (target[key] ?? 0) + src[key]
  }
}

/** Cost (¥) of a token bucket at a timestamp, band-aware, per model tier. */
function costOfBucket(bucket, ms, pricing = DEFAULT_PRICING, tier = 'flash') {
  const band = ms < BOUNDARY_MS ? 'before' : (isBeijingPeak(ms) ? 'peak' : 'offPeak')
  const price = pricing[band][tier]
  return (bucket.cacheHit * price.hit + (bucket.input + bucket.cacheMiss) * price.miss + bucket.output * price.out) / 1e6
}

/**
 * Recursive scan for usage events: any object carrying a `usage`-like token
 * record plus a sibling timestamp. Handles the event-log and message shapes
 * the legacy session stores use, regardless of nesting.
 */
function scanUsageEvents(value, out, depth = 0, cap = 20000) {
  if (depth > 8 || out.length >= cap) return
  if (Array.isArray(value)) {
    for (const item of value) scanUsageEvents(item, out, depth + 1, cap)
    return
  }
  if (value === null || typeof value !== 'object') return
  const usage = value.usage ?? value.usageInfo ?? null
  if (usage !== null && typeof usage === 'object') {
    const time = value.time ?? value.createdAt ?? value.ts ?? value.timestamp ?? null
    const t = typeof time === 'number' ? time : (typeof time === 'string' ? Date.parse(time) : NaN)
    if (Number.isFinite(t) && t > 0) {
      const tokens = {
        input: Number(usage.inputTokens ?? usage.promptTokens ?? usage.uncachedInputTokens ?? 0) || 0,
        cacheHit: Number(usage.cacheReadTokens ?? usage.cachedInputTokens ?? usage.cacheHitTokens ?? 0) || 0,
        cacheMiss: Number(usage.cacheWriteTokens ?? usage.cacheMissTokens ?? 0) || 0,
        output: Number(usage.outputTokens ?? usage.completionTokens ?? 0) || 0,
      }
      if (tokens.input + tokens.cacheHit + tokens.cacheMiss + tokens.output > 0) {
        out.push({ time: t, model: value.model ?? value.modelId ?? null, ...tokens })
      }
    }
  }
  for (const key of Object.keys(value)) {
    if (key === 'usage' || key === 'usageInfo') continue
    scanUsageEvents(value[key], out, depth + 1, cap)
  }
}

/* ───────────────────────── session event logs ─────────────────────────────── */
/*
 * The JSONL backend owns a concatenated-frame Zstandard container (one frame
 * per appended batch). Node's one-shot zstd API decodes exactly one frame, so
 * complete frames are located structurally first — the same walk the
 * harness's own persistence backend performs — and each frame is decoded on
 * its own. An incomplete final frame (a write in flight) is skipped.
 */

const ZSTD_MAGIC = 4247762216 // 0xFD2FB528 little-endian
/** Frame budget per log: past this the log is treated as totals-only. */
const MAX_LOG_FRAMES = 40000
/** Byte budget per log: past this the log is skipped (totals fallback). */
const MAX_LOG_BYTES = 256 * 1024 * 1024

function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) break // torn frame tail
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) break // stop cleanly on garbage
    offset += 4
    if (offset === buffer.length) break
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) break
    offset += remainingHeaderBytes
    let complete = true
    for (;;) {
      if (buffer.length - offset < 3) { complete = false; break }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      if (blockType === 3) { complete = false; break } // reserved block type
      const blockSize = blockHeader >>> 3
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) { complete = false; break }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (!complete) break
    if (checksum) {
      if (buffer.length - offset < 4) break
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return frames
}

/** Extracted from one session artifact; `events` is the per-day source. */
function parseLogText(text, out) {
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    let ev
    try { ev = JSON.parse(line) } catch { continue }
    const t = typeof ev.time === 'number' ? ev.time : 0
    if (t > out.lastAt) out.lastAt = t
    switch (ev.type) {
      case 'session': {
        if (typeof ev.id === 'string' && ev.id !== '') out.id = ev.id
        const createdAt = Number(ev.createdAt) || 0
        if (createdAt > 0 && out.createdAt <= 0) out.createdAt = createdAt
        if (typeof ev.cwd === 'string') out.cwd = ev.cwd
        break
      }
      case 'session/title': {
        const title = ev.data?.title
        if (typeof title === 'string' && title !== '') out.title = title
        break
      }
      case 'request/header': {
        const model = ev.data?.header?.config?.model
        if (typeof model === 'string' && model !== '') out.model = model
        break
      }
      case 'request/context': {
        const model = ev.data?.model
        if (typeof model === 'string' && model !== '') out.model = model
        break
      }
      case 'assistant/chunk': {
        const chunk = ev.data?.chunk
        if (chunk?.type !== 'usage') break
        const usage = chunk.usage ?? ev.data?.usage ?? null
        if (usage === null || typeof usage !== 'object') break
        const input = Number(usage.inputTokens ?? usage.promptTokens ?? 0) || 0
        const cacheHit = Number(usage.cacheReadTokens ?? usage.cachedInputTokens ?? 0) || 0
        const cacheMiss = Number(usage.cacheWriteTokens ?? 0) || 0
        const output = Number(usage.outputTokens ?? usage.completionTokens ?? 0) || 0
        if (t > 0 && input + cacheHit + cacheMiss + output > 0) {
          // stamp the model active at this point in the log (request/header
          // and request/context events precede the usage they apply to, so a
          // session that switched models mid-way attributes each call right)
          out.events.push({ time: t, input, cacheHit, cacheMiss, output, model: out.model })
        }
        break
      }
    }
  }
}

function parseLogBuffer(buf, compressed) {
  const out = { id: null, createdAt: 0, cwd: null, title: null, model: null, events: [], lastAt: 0 }
  if (compressed) {
    if (typeof zlib.zstdDecompressSync !== 'function') return null
    const frames = scanZstdFrames(buf)
    if (frames.length === 0) return null
    if (frames.length > MAX_LOG_FRAMES) {
      // Too large to fold event-by-event: keep header/title/model plus the
      // final frame's timestamp, and let cumulative totals take over.
      for (const index of [0, frames.length - 1]) {
        try { parseLogText(zlib.zstdDecompressSync(buf.subarray(frames[index].start, frames[index].end)).toString('utf8'), out) } catch { /* skip */ }
      }
      out.truncated = true
      return out
    }
    for (const frame of frames) {
      try {
        parseLogText(zlib.zstdDecompressSync(buf.subarray(frame.start, frame.end)).toString('utf8'), out)
      } catch { /* a corrupt frame stops cleanly; remaining frames still parse */ }
    }
  } else {
    parseLogText(buf.toString('utf8'), out)
  }
  return out
}

const LOG_CACHE = new Map() // path → { mtimeMs, size, data }
const LOG_CACHE_MAX = 64

function readSessionLog(logPath) {
  let st
  try { st = statSync(logPath) } catch { return null }
  if (st.size > MAX_LOG_BYTES) return null
  const hit = LOG_CACHE.get(logPath)
  if (hit !== undefined && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.data
  let data = null
  try {
    data = parseLogBuffer(readFileSync(logPath), logPath.endsWith('.zstd'))
  } catch {
    data = null
  }
  if (LOG_CACHE.size >= LOG_CACHE_MAX) LOG_CACHE.delete(LOG_CACHE.keys().next().value)
  LOG_CACHE.set(logPath, { mtimeMs: st.mtimeMs, size: st.size, data })
  return data
}

/** One session under `home/sessions/<project>/<id>/`; both suffixes probed. */
function readSessionLogAny(sessionDir) {
  const zstd = readSessionLog(join(sessionDir, 'session.jsonl.zstd'))
  if (zstd !== null) return zstd
  return readSessionLog(join(sessionDir, 'session.jsonl'))
}

function collectSessionLogs(sessionsDir, records, eventsById) {
  let projects
  try { projects = readdirSync(sessionsDir) } catch { return }
  for (const project of projects) {
    const projectDir = join(sessionsDir, project)
    let entries
    try { entries = readdirSync(projectDir, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const data = readSessionLogAny(join(projectDir, entry.name))
      if (data === null || data.id === null) continue
      const rec = ensureRecord(records, data.id)
      if (rec.createdAt <= 0) rec.createdAt = data.createdAt
      if (data.cwd !== null) rec.cwd = rec.cwd ?? data.cwd
      if (rec.title === '' && data.title !== null) rec.title = data.title
      if (rec.model === '' && data.model !== null) rec.model = data.model
      if (data.lastAt > 0) rec.updatedAt = Math.max(rec.updatedAt, data.lastAt)
      if (data.truncated === true) {
        // Partial fold would undercount — totals on the last-activity day.
        if (eventsById.get(data.id) === undefined) eventsById.set(data.id, [])
      } else if (data.events.length > 0) {
        eventsById.set(data.id, data.events)
      }
    }
  }
}

/* ─────────────────────────────── record assembly ──────────────────────────── */

function ensureRecord(records, id) {
  let rec = records.get(id)
  if (rec === undefined) {
    rec = {
      id,
      title: '',
      model: '',
      cwd: null,
      createdAt: 0,
      updatedAt: 0,
      llmMs: 0,
      tokens: { input: 0, cacheHit: 0, cacheMiss: 0, output: 0 },
    }
    records.set(id, rec)
  }
  return rec
}

/** Versioned projection rows live behind `{ver, seq, val}` wrappers. */
function rowVal(rows, key) {
  const row = rows?.[key]
  if (row !== null && typeof row === 'object' && !Array.isArray(row) && 'val' in row) return row.val
  return row ?? null
}

function readProjcache(proj, records) {
  if (proj === null) return
  // Current domain-data form: { unit, global, tables: { sessions: { id: rec } } }
  const isDomain = proj.tables !== undefined || proj.unit?.name === 'session_projcache'
  let entries
  if (isDomain) {
    const domain = proj.tables?.sessions ?? {}
    entries = Array.isArray(domain) ? domain.map((v, i) => [v?.id ?? i, v]) : Object.entries(domain)
  } else {
    // Legacy flat form: { [id]: { tokenUsage, sessionStats, … } }
    const map = Array.isArray(proj) ? proj : (proj.sessions ?? proj)
    entries = Array.isArray(map) ? map.map((v, i) => [v?.id ?? i, v]) : Object.entries(map ?? {})
  }
  for (const [id, row] of entries) {
    if (row === null || typeof row !== 'object') continue
    const rec = ensureRecord(records, String(id))
    const identity = row.identity ?? null
    if (identity !== null && typeof identity === 'object') {
      const createdAt = Number(identity.createdAt ?? 0) || 0
      if (createdAt > 0 && rec.createdAt <= 0) rec.createdAt = createdAt
      if (typeof identity.cwd === 'string') rec.cwd = identity.cwd
      const rows = row.rows ?? null
      const tu = rowVal(rows, 'tokenUsage')
      const totals = (tu !== null && typeof tu === 'object') ? (tu.totals ?? tu) : null
      if (totals !== null && typeof totals === 'object') {
        rec.tokens = {
          input: Number(totals.uncachedInputTokens ?? totals.inputTokens ?? 0) || 0,
          cacheHit: Number(totals.cacheReadTokens ?? totals.cachedInputTokens ?? 0) || 0,
          cacheMiss: Number(totals.cacheWriteTokens ?? 0) || 0,
          output: Number(totals.outputTokens ?? totals.completionTokens ?? 0) || 0,
        }
      }
      const ss = rowVal(rows, 'sessionStats')
      if (ss !== null && typeof ss === 'object') rec.llmMs = Number(ss.llmMs ?? 0) || 0
      const title = rowVal(rows, 'title')
      if (typeof title === 'string' && title !== '' && rec.title === '') rec.title = title
    } else {
      const tu = row.tokenUsage ?? row
      const ss = row.sessionStats ?? null
      if (tu !== null && typeof tu === 'object') {
        rec.tokens = {
          input: Number(tu.uncachedInputTokens ?? 0) || 0,
          cacheHit: Number(tu.cacheReadTokens ?? 0) || 0,
          cacheMiss: Number(tu.cacheWriteTokens ?? 0) || 0,
          output: Number(tu.outputTokens ?? 0) || 0,
        }
      }
      if (ss !== null && typeof ss === 'object') rec.llmMs = Number(ss.llmMs ?? 0) || 0
    }
  }
}

function readWorkspaces(ws, records) {
  if (ws === null) return
  const map = ws.tables?.workspaces ?? ws.workspaces ?? null
  if (map === null) return
  const entries = Array.isArray(map) ? map.map((v, i) => [v?.id ?? i, v]) : Object.entries(map)
  for (const [, row] of entries) {
    if (row === null || typeof row !== 'object') continue
    if (!Array.isArray(row.sessionIds)) continue
    const updatedAt = (typeof row.updatedAt === 'number' ? row.updatedAt : Date.parse(String(row.updatedAt ?? ''))) || 0
    for (const sid of row.sessionIds) {
      if (updatedAt <= 0) continue
      const rec = ensureRecord(records, String(sid))
      rec.updatedAt = Math.max(rec.updatedAt, updatedAt)
    }
  }
}

function readLegacySessions(sessions, records, eventsById) {
  if (sessions === null) return
  const map = Array.isArray(sessions) ? sessions : (sessions.sessions ?? sessions)
  const entries = Array.isArray(map) ? map.map((v, i) => [v?.id ?? i, v]) : Object.entries(map ?? {})
  for (const [id, row] of entries) {
    if (row === null || typeof row !== 'object') continue
    const sid = String(id)
    const createdAt = Number(row.createdAt ?? row.created ?? 0) || 0
    if (createdAt <= 0) continue
    const rec = ensureRecord(records, sid)
    if (rec.createdAt <= 0) rec.createdAt = createdAt
    const updatedAt = Number(row.updatedAt ?? row.updated ?? row.lastActiveAt ?? createdAt) || createdAt
    rec.updatedAt = Math.max(rec.updatedAt, updatedAt)
    if (rec.title === '' && typeof row.title === 'string') rec.title = row.title
    if (rec.model === '' && typeof row.model === 'string') rec.model = row.model
    const events = []
    scanUsageEvents(row, events)
    if (events.length > 0 && eventsById.get(sid) === undefined) eventsById.set(sid, events)
  }
}

/* ────────────────────────────────── engine ────────────────────────────────── */

export class PersonalStatsEngine {
  constructor(env = process.env) {
    this.dataDir = env.DSH_LAUNCHER_DATA_DIR ?? ''
    this.supported = this.dataDir !== ''
    this.home = this.dataDir === '' ? '' : join(this.dataDir, 'home')
    this.pricing = this.loadPricing()
    this.cached = null
    this.cachedAt = 0
  }

  loadPricing() {
    if (this.dataDir === '') return DEFAULT_PRICING
    try {
      const settings = JSON.parse(readFileSync(join(this.dataDir, 'launcher-settings.json'), 'utf8'))
      const p = settings?.pricing
      if (p !== null && typeof p === 'object' && typeof p.peak?.pro?.out === 'number') return p
    } catch { /* defaults */ }
    return DEFAULT_PRICING
  }

  setPricing(patch = {}) {
    if (patch === null || typeof patch !== 'object') throw new Error('无效的计费设置')
    const next = {
      before: {
        flash: { ...this.pricing.before.flash, ...patch.before?.flash },
        pro: { ...this.pricing.before.pro, ...patch.before?.pro },
      },
      offPeak: {
        flash: { ...this.pricing.offPeak.flash, ...patch.offPeak?.flash },
        pro: { ...this.pricing.offPeak.pro, ...patch.offPeak?.pro },
      },
      peak: {
        flash: { ...this.pricing.peak.flash, ...patch.peak?.flash },
        pro: { ...this.pricing.peak.pro, ...patch.peak?.pro },
      },
    }
    for (const band of Object.values(next)) {
      for (const tier of Object.values(band)) {
        for (const key of ['hit', 'miss', 'out']) {
          const v = tier[key]
          if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Error('价格必须是非负数字')
        }
      }
    }
    this.pricing = next
    this.cached = null
    try {
      if (this.dataDir !== '') {
        mkdirSync(this.dataDir, { recursive: true })
        const path = join(this.dataDir, 'launcher-settings.json')
        let settings = {}
        try { settings = JSON.parse(readFileSync(path, 'utf8')) } catch { /* fresh */ }
        settings.pricing = next
        writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`)
      }
    } catch { /* persistence is best-effort */ }
    return this.status()
  }

  /** Aggregate snapshot; cached briefly so UI polling stays cheap. */
  status() {
    if (!this.supported) return { supported: false }
    const now = Date.now()
    if (this.cached !== null && now - this.cachedAt < 5000) return this.cached
    this.cached = this.compute()
    this.cachedAt = now
    return this.cached
  }

  compute() {
    const storages = join(this.home, 'storages')
    const proj = readJson(join(storages, 'session_projcache.json'))
    const ws = readJson(join(storages, 'workspace.json'))
    const legacySessions = readJson(join(storages, 'sessions.json'))

    // ── session records (merged from every source; log events preferred) ──
    const records = new Map() // id → { id, title, model, cwd, createdAt, updatedAt, llmMs, tokens }
    const eventsById = new Map() // id → [{ time, input, cacheHit, cacheMiss, output }]
    readProjcache(proj, records)
    readWorkspaces(ws, records)
    readLegacySessions(legacySessions, records, eventsById)
    collectSessionLogs(join(this.home, 'sessions'), records, eventsById)

    // ── aggregates: every contribution carries its own band-aware cost ──
    const total = emptyBucket()
    const byDay = new Map()
    const byModel = new Map()
    const bySession = []
    const addContribution = (dateKey, model, tokens, costMs, sessions) => {
      if (tokens.input + tokens.cacheHit + tokens.cacheMiss + tokens.output <= 0) return
      const tier = modelTier(model)
      const bucket = {
        input: tokens.input,
        cacheHit: tokens.cacheHit,
        cacheMiss: tokens.cacheMiss,
        output: tokens.output,
        tokens: 0,
        cost: costOfBucket(tokens, costMs, this.pricing, tier),
      }
      let day = byDay.get(dateKey)
      if (day === undefined) {
        day = { date: dateKey, ...emptyBucket(), sessions: 0 }
        byDay.set(dateKey, day)
      }
      mergeBucket(day, bucket)
      day.sessions += sessions
      mergeBucket(total, bucket)
      const name = modelName(model)
      let m = byModel.get(name)
      if (m === undefined) {
        m = { model: name, ...emptyBucket() }
        byModel.set(name, m)
      }
      mergeBucket(m, bucket)
    }

    for (const rec of records.values()) {
      if (rec.createdAt <= 0 && rec.updatedAt <= 0) continue
      const events = eventsById.get(rec.id)
      const lastAt = Math.max(rec.updatedAt, rec.createdAt, 0)
      const span = Math.max(0, (rec.updatedAt > 0 ? rec.updatedAt : rec.createdAt) - rec.createdAt)
      if (events !== undefined && events.length > 0) {
        // exact per-day attribution from the session's own usage events
        for (const ev of events) addContribution(localDayKey(ev.time), ev.model ?? rec.model, ev, ev.time, 0)
        const day = byDay.get(localDayKey(lastAt))
        if (day !== undefined) day.sessions += 1
      } else {
        // no per-step usage: cumulative totals on the last-activity day
        addContribution(localDayKey(lastAt), rec.model, rec.tokens, lastAt, 1)
      }
      bySession.push({
        id: rec.id,
        title: rec.title,
        model: rec.model,
        spanMs: span,
        llmMs: rec.llmMs,
        tokens: { ...rec.tokens },
        cost: costOfBucket(rec.tokens, lastAt, this.pricing, modelTier(rec.model)),
        lastAt,
      })
    }

    // finalize
    const perDay = [...byDay.values()]
    for (const day of perDay) {
      day.tokens = day.input + day.cacheHit + day.cacheMiss + day.output
    }
    for (const m of byModel.values()) {
      m.tokens = m.input + m.cacheHit + m.cacheMiss + m.output
    }
    total.tokens = total.input + total.cacheHit + total.cacheMiss + total.output

    // peak day
    let peak = null
    for (const day of perDay) {
      if (peak === null || day.tokens > peak.tokens) peak = day
    }

    // streak (consecutive activity days ending today or yesterday)
    const activeDays = new Set(perDay.filter(d => d.tokens > 0).map(d => d.date))
    let streak = 0
    let cursor = localDayKey(Date.now())
    if (!activeDays.has(cursor)) cursor = localDayKey(Date.now() - DAY_MS)
    while (activeDays.has(cursor)) {
      streak += 1
      cursor = localDayKey(new Date(`${cursor}T00:00:00`).getTime() - DAY_MS)
    }

    // longest session
    const longest = bySession.reduce((acc, s) => (s.spanMs > (acc?.spanMs ?? -1) ? s : acc), null)

    // heatmap: the full calendar year (Jan 1 – Dec 31); days after today are
    // flagged `future` so the client renders them lighter.
    const days = new Map(perDay.map(d => [d.date, d]))
    const todayKeyLocal = localDayKey(Date.now())
    const year = new Date().getFullYear()
    const start = new Date(year, 0, 1)
    const end = new Date(year, 11, 31)
    const heatmap = []
    for (let t = start.getTime(); t <= end.getTime(); t += DAY_MS) {
      const key = localDayKey(t)
      const day = days.get(key)
      heatmap.push({
        date: key,
        tokens: day?.tokens ?? 0,
        cost: day?.cost ?? 0,
        sessions: day?.sessions ?? 0,
        weekday: new Date(`${key}T00:00:00`).getDay(),
        future: key > todayKeyLocal,
      })
    }

    return {
      supported: true,
      pricing: this.pricing,
      peakHours: DEFAULT_PEAK_HOURS,
      totals: total,
      sessions: bySession.length,
      peak: peak === null ? null : { date: peak.date, tokens: peak.tokens, cost: peak.cost },
      streak,
      longest: longest === null ? null : { id: longest.id, title: longest.title, model: longest.model, spanMs: longest.spanMs, llmMs: longest.llmMs },
      byModel: [...byModel.values()].sort((a, b) => b.tokens - a.tokens),
      heatmap,
      generatedAt: new Date().toISOString(),
    }
  }
}
