/**
 * Personal-center stats engine of the desktop launcher plugin.
 *
 * Aggregates chat activity into the Codex-style personal center: cumulative
 * tokens (input / cache hit / cache miss / output), peak daily usage, the
 * longest session, the consecutive-day streak, cost, and the per-day token
 * activity map that feeds the heatmap.
 *
 * Data sources — read directly from the storage-json files under DSH_HOME
 * (`storages/`), parsed tolerantly so shape drift degrades a figure instead
 * of breaking the page:
 *
 *   sessions.json            session headers (id, createdAt, updatedAt,
 *                            title, model) and, when present, per-message
 *                            usage events with timestamps (the exact per-day
 *                            heatmap source).
 *   session_projcache.json   the persisted projection cache: per-session
 *                            `tokenUsage` (uncachedInputTokens, outputTokens,
 *                            cacheReadTokens, cacheWriteTokens — the durable
 *                            cumulative fold) and `sessionStats` (llmMs, …).
 *                            Cumulative totals are authoritative; when a
 *                            session has no per-message usage events its
 *                            tokens are attributed to its last-activity day.
 *
 * Cost follows the official DeepSeek pricing with the 8/17 price change and
 * the Beijing-time peak schedule (peak 9–12 & 14–18; off-peak otherwise),
 * matching the published table; prices are editable and persist into
 * launcher-settings.json.
 *
 * @module dsh-launcher-updater/personal
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

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
    if (typeof src[key] === 'number') target[key] += src[key]
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
 * the session stores use, regardless of nesting.
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
    const sessions = readJson(join(storages, 'sessions.json'))
    const proj = readJson(join(storages, 'session_projcache.json'))

    // ── session headers ──
    const records = []
    if (sessions !== null) {
      const map = Array.isArray(sessions) ? sessions : (sessions.sessions ?? sessions)
      const entries = Array.isArray(map) ? map.map((v, i) => [v?.id ?? i, v]) : Object.entries(map ?? {})
      for (const [id, rec] of entries) {
        if (rec === null || typeof rec !== 'object') continue
        const createdAt = Number(rec.createdAt ?? rec.created ?? 0) || 0
        if (createdAt <= 0) continue
        const updatedAt = Number(rec.updatedAt ?? rec.updated ?? rec.lastActiveAt ?? createdAt) || createdAt
        records.push({
          id: String(id),
          title: typeof rec.title === 'string' ? rec.title : (typeof rec.name === 'string' ? rec.name : ''),
          model: typeof rec.model === 'string' ? rec.model : (typeof rec.modelId === 'string' ? rec.modelId : ''),
          createdAt,
          updatedAt,
        })
      }
    }

    // ── usage events (exact per-day source when present) ──
    const events = []
    if (sessions !== null) scanUsageEvents(sessions, events)

    // ── per-session totals from the projection cache ──
    const projById = new Map()
    if (proj !== null) {
      const map = Array.isArray(proj) ? proj : (proj.sessions ?? proj)
      const entries = Array.isArray(map) ? map : Object.entries(map ?? {})
      for (const [id, row] of entries) {
        if (row === null || typeof row !== 'object') continue
        const tu = row.tokenUsage ?? row
        const ss = row.sessionStats ?? null
        projById.set(String(id), {
          tokens: {
            input: Number(tu?.uncachedInputTokens ?? 0) || 0,
            cacheHit: Number(tu?.cacheReadTokens ?? 0) || 0,
            cacheMiss: Number(tu?.cacheWriteTokens ?? 0) || 0,
            output: Number(tu?.outputTokens ?? 0) || 0,
          },
          llmMs: Number(ss?.llmMs ?? 0) || 0,
        })
      }
    }

    // ── aggregates: every contribution carries its own band-aware cost ──
    const total = emptyBucket()
    const byDay = new Map()
    const byModel = new Map()
    const bySession = []
    const seenIds = new Set()
    const addContribution = (dateKey, model, tokens, spanMs, costMs) => {
      const tier = modelTier(model)
      const bucket = { ...tokens, tokens: 0, cost: costOfBucket(tokens, costMs, this.pricing, tier) }
      let day = byDay.get(dateKey)
      if (day === undefined) {
        day = { date: dateKey, ...emptyBucket(), sessions: 0, spanMs: 0 }
        byDay.set(dateKey, day)
      }
      mergeBucket(day, bucket)
      day.spanMs += spanMs
      mergeBucket(total, bucket)
      let m = byModel.get(tier)
      if (m === undefined) {
        m = { model: tier, ...emptyBucket() }
        byModel.set(tier, m)
      }
      mergeBucket(m, bucket)
    }

    // 1. exact per-day events when the stores expose them
    const hasExactEvents = events.length > 0
    for (const ev of events) {
      addContribution(localDayKey(ev.time), ev.model ?? '', {
        input: ev.input,
        cacheHit: ev.cacheHit,
        cacheMiss: ev.cacheMiss,
        output: ev.output,
      }, 0, ev.time)
    }

    // 2. sessions: headers + cumulative totals (attributed to the
    //    last-activity day only when no exact events exist at all)
    for (const rec of records) {
      const row = projById.get(rec.id) ?? null
      const tokens = row === null
        ? { input: 0, cacheHit: 0, cacheMiss: 0, output: 0 }
        : { input: row.tokens.input, cacheHit: row.tokens.cacheHit, cacheMiss: row.tokens.cacheMiss, output: row.tokens.output }
      const span = Math.max(0, (rec.updatedAt || rec.createdAt) - rec.createdAt)
      const lastAt = rec.updatedAt || rec.createdAt
      if (!hasExactEvents && row !== null) {
        const key = localDayKey(lastAt)
        addContribution(key, rec.model, tokens, span, lastAt)
        const day = byDay.get(key)
        if (day !== undefined) day.sessions += 1
      }
      seenIds.add(rec.id)
      bySession.push({
        id: rec.id,
        title: rec.title,
        model: rec.model,
        spanMs: span,
        llmMs: row?.llmMs ?? 0,
        tokens: { ...tokens },
        cost: costOfBucket(tokens, lastAt, this.pricing, modelTier(rec.model)),
        lastAt,
      })
    }

    // 3. projection rows without a header record
    for (const [id, row] of projById) {
      if (seenIds.has(id)) continue
      const tokens = { ...row.tokens }
      addContribution(localDayKey(Date.now()), '', tokens, 0, Date.now())
      bySession.push({
        id, title: '', model: '', spanMs: 0, llmMs: row.llmMs,
        tokens, cost: costOfBucket(tokens, Date.now(), this.pricing, 'flash'), lastAt: Date.now(),
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
