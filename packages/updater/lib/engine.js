/**
 * Host-side update engine of the desktop launcher updater plugin.
 *
 * Two update channels, both fully app-internal:
 *
 *   official (npm) — the harness's official distribution channel
 *     (github.com/deepseek-ai/deepseek-harness publishes no GitHub Releases;
 *     npm @deepseek-ai/dsh IS the official source). The engine queries the
 *     npm registry for the latest @deepseek-ai/dsh, and upgrades by copying
 *     the runtime to a staging directory, re-pinning the dsh version there,
 *     and running the BUNDLED npm (Node ships npm inside its dist, so no
 *     package manager ever touches the user's system) with its cache pointed
 *     into the app's data directory.
 *
 *   launcher feed — optional launcher-published runtime artifacts
 *     (bundled Node, default plugins, overlay). Applies when configured
 *     (harness.json updateFeed) and its artifact carries the harness version
 *     the official channel offers; the official channel wins otherwise.
 *
 * Both channels end the same way: verify, stage, atomically swap
 * `runtime` ↔ `runtime.backup` on the same volume, then exit with code 42 —
 * the desktop shell interprets 42 as "restart for update" and boots the new
 * runtime; a failed boot rolls back.
 *
 * Configuration arrives through environment variables set by the desktop
 * shell (see shell/main.js):
 *
 *   DSH_LAUNCHER_RUNTIME_DIR  absolute path of the active runtime directory
 *   DSH_LAUNCHER_DATA_DIR     persistent data directory (survives updates)
 *   DSH_LAUNCHER_APP_VERSION  desktop shell version
 *   DSH_LAUNCHER_FEED_URL     optional feed override (defaults to the manifest)
 *   DSH_LAUNCHER_CHANNEL      optional channel override (defaults to the manifest)
 *   DSH_LAUNCHER_NPM_REGISTRY optional npm registry override (defaults to
 *                             the official registry.npmjs.org)
 *
 * @module dsh-launcher-updater/engine
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  cpSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

/** Runtime manifest filename inside the runtime directory. */
export const RUNTIME_MANIFEST = 'harness.json'

/** Process exit code the desktop shell treats as "restart for update". */
export const RESTART_EXIT_CODE = 42

/** Official npm registry (overridable via DSH_LAUNCHER_NPM_REGISTRY). */
export const DEFAULT_NPM_REGISTRY = 'https://registry.npmjs.org'

/** The official harness package name on npm. */
export const DSH_PACKAGE = '@deepseek-ai/dsh'

/** Artifact map keys used by the feed, derived from process.arch. */
const ARCH_KEYS = { arm64: 'darwin-arm64', x64: 'darwin-x64' }

/** Shape-check one feed response into the parts the engine reads. */
function readFeed(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('更新源响应不是 JSON 对象')
  const channels = raw.channels
  if (channels === null || typeof channels !== 'object' || Array.isArray(channels)) throw new Error('更新源缺少 channels')
  return channels
}

function readLatest(entry) {
  if (entry === null || typeof entry !== 'object') throw new Error('更新源通道条目无效')
  const latest = entry.latest
  if (latest === null || typeof latest !== 'object') throw new Error('更新源缺少 latest 版本')
  if (typeof latest.version !== 'string' || latest.version === '') throw new Error('更新源 latest.version 无效')
  if (latest.artifacts === null || typeof latest.artifacts !== 'object') throw new Error('更新源 latest.artifacts 无效')
  return latest
}

/**
 * Compare two dotted version strings. Returns -1 | 0 | 1. Prerelease
 * segments compare below the plain release of the same core version
 * (1.0.0-rc.1 < 1.0.0). Non-numeric segments compare lexically.
 */
export function compareVersions(a, b) {
  const pa = String(a).split('.')
  const pb = String(b).split('.')
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i += 1) {
    const sa = pa[i] ?? '0'
    const sb = pb[i] ?? '0'
    const na = Number.parseInt(sa, 10)
    const nb = Number.parseInt(sb, 10)
    if (!Number.isNaN(na) && !Number.isNaN(nb)) {
      if (na !== nb) return na < nb ? -1 : 1
      continue
    }
    // At least one side is not a plain number (e.g. "0-rc.1"): the whole
    // remaining dotted suffix compares as prerelease strings.
    const ra = pa.slice(i).join('.')
    const rb = pb.slice(i).join('.')
    return ra < rb ? -1 : ra > rb ? 1 : 0
  }
  return 0
}

function sha256OfFile(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('error', reject)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

function extractTarGz(archive, targetDir) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/tar', ['-xzf', archive, '-C', targetDir], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) resolve()
      else reject(new Error(`tar 解压失败 (exit ${String(code)}): ${stderr.trim().slice(-500)}`))
    })
  })
}

/** Minimal per-instance logger: appends one line to the data-dir log. */
function makeLog(dataDir) {
  return (line) => {
    try {
      const target = join(dataDir, 'logs', 'updater.log')
      mkdirSync(join(dataDir, 'logs'), { recursive: true })
      appendFileSync(target, `${new Date().toISOString()} ${line}\n`)
    } catch { /* logging must never break the update flow */ }
  }
}

/** Register a reversible side effect via ctx.effect when available. */
function ctxEffectSafe(ctx, callback, label) {
  if (ctx !== null && typeof ctx.effect === 'function') {
    ctx.effect(callback, label)
    return
  }
  const disposer = callback()
  // Degraded mode (no ctx): nothing to unwind against; the process owns it.
  void disposer
}

/** Read the runtime manifest; throws a descriptive error when absent/broken. */
function readManifest(runtimeDir) {
  const path = join(runtimeDir, RUNTIME_MANIFEST)
  let raw
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new Error(`无法读取运行时清单 ${path}：环境不是由桌面启动器安装的`)
  }
  return raw
}

/**
 * Update engine. One instance per host fiber; routes in index.js are thin
 * adapters over its methods. All mutable state is process-local.
 */
export class UpdaterEngine {
  constructor(ctx) {
    this.ctx = ctx
    this.runtimeDir = process.env.DSH_LAUNCHER_RUNTIME_DIR ?? ''
    this.dataDir = process.env.DSH_LAUNCHER_DATA_DIR ?? ''
    this.appVersion = process.env.DSH_LAUNCHER_APP_VERSION ?? ''
    this.feedUrl = process.env.DSH_LAUNCHER_FEED_URL ?? ''
    this.channel = process.env.DSH_LAUNCHER_CHANNEL ?? ''
    this.npmRegistry = (process.env.DSH_LAUNCHER_NPM_REGISTRY ?? DEFAULT_NPM_REGISTRY).replace(/\/+$/, '')
    this.supported = this.runtimeDir !== '' && existsSync(join(this.runtimeDir, RUNTIME_MANIFEST))
    this.log = makeLog(this.dataDir || this.runtimeDir || '.')
    this.phase = 'idle' // idle | checking | downloading | verifying | applying | restarting
    this.progress = null // { received: number, total: number | null }
    this.downloadTotal = null // best-effort content-length for the next download
    this.latest = null // trimmed update entry the last check resolved (public shape)
    this.latestFull = null // full feed entry, including artifacts (feed apply uses it)
    this.officialLatest = null // npm registry's latest official version info
    this.officialUpdateAvailable = false
    this.updateAvailable = false
    this.updateSource = null // 'feed' | 'npm'
    this.lastError = null
    this.restartRequested = false
    this.checkedAt = null
    this.archKey = ARCH_KEYS[process.arch] ?? null
    this.manifest = this.supported ? readManifest(this.runtimeDir) : {}
    this.settings = this.loadSettings()
    this.lastAutoCheckDate = null
  }

  /* ─────────────────────────── scheduled auto-check ─────────────────────────── */

  settingsPath() {
    return join(this.dataDir, 'launcher-settings.json')
  }

  loadSettings() {
    try {
      const raw = JSON.parse(readFileSync(this.settingsPath(), 'utf8'))
      return {
        autoCheck: raw.autoCheck !== false, // default ON
        autoCheckTime: typeof raw.autoCheckTime === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(raw.autoCheckTime)
          ? raw.autoCheckTime
          : '03:00',
      }
    } catch {
      return { autoCheck: true, autoCheckTime: '03:00' }
    }
  }

  saveSettings() {
    if (this.dataDir === '') return
    try {
      mkdirSync(this.dataDir, { recursive: true })
      writeFileSync(this.settingsPath(), `${JSON.stringify(this.settings, null, 2)}\n`)
    } catch { /* diagnostics only */ }
  }

  /** Update the auto-check settings; validate then persist. */
  setSettings(patch = {}) {
    if (typeof patch.autoCheck === 'boolean') this.settings.autoCheck = patch.autoCheck
    if (typeof patch.autoCheckTime === 'string') {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(patch.autoCheckTime)) throw new Error('自动检查时间格式应为 HH:MM')
      this.settings.autoCheckTime = patch.autoCheckTime
    }
    this.saveSettings()
    this.log(`settings: autoCheck=${String(this.settings.autoCheck)} time=${this.settings.autoCheckTime}`)
    return this.status()
  }

  todayStamp(now = new Date()) {
    const pad = n => String(n).padStart(2, '0')
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  }

  /** Next scheduled auto-check as an ISO string (or null when disabled). */
  nextAutoCheckAt() {
    if (this.settings.autoCheck !== true) return null
    const [h, m] = this.settings.autoCheckTime.split(':').map(Number)
    const next = new Date()
    next.setHours(h, m, 0, 0)
    if (this.lastAutoCheckDate === this.todayStamp() || next.getTime() <= Date.now()) {
      next.setDate(next.getDate() + 1)
    }
    return next.toISOString()
  }

  /**
   * Daily scheduled check: every 30s, when the configured time is reached
   * (or already passed today — catch-up for machines that were asleep/off at
   * the scheduled moment), run one check and record today's date so it never
   * fires twice a day. The timer rides ctx.effect, so it dies with the fiber.
   */
  startScheduler() {
    ctxEffectSafe(this.ctx, () => {
      const timer = setInterval(() => {
        try {
          if (this.settings.autoCheck !== true) return
          if (this.phase !== 'idle') return
          const now = new Date()
          const [h, m] = this.settings.autoCheckTime.split(':').map(Number)
          if (now.getHours() * 60 + now.getMinutes() < h * 60 + m) return
          if (this.lastAutoCheckDate === this.todayStamp(now)) return
          this.lastAutoCheckDate = this.todayStamp(now)
          this.log(`auto-check: daily scheduled run (${this.settings.autoCheckTime})`)
          this.check().catch(error => {
            this.log(`auto-check failed: ${error instanceof Error ? error.message : String(error)}`)
          })
        } catch { /* the scheduled check must never break the timer */ }
      }, 30 * 1000)
      return () => clearInterval(timer)
    }, 'launcher-updater: auto-check scheduler')
  }

  /** Snapshot for GET /launcher-updater/status (JSON-safe by construction). */
  status() {
    return {
      supported: this.supported,
      appVersion: this.appVersion,
      runtimeVersion: this.manifest.runtimeVersion ?? '',
      dshVersion: this.manifest.dshVersion ?? '',
      channel: this.channel || this.manifest.channel || 'stable',
      feedUrl: this.feedUrl || this.manifest.updateFeed || '',
      npmRegistry: this.npmRegistry,
      arch: this.archKey,
      phase: this.phase,
      progress: this.progress,
      updateAvailable: this.updateAvailable,
      updateSource: this.updateSource,
      latest: this.latest,
      officialLatest: this.officialLatest,
      officialUpdateAvailable: this.officialUpdateAvailable,
      lastError: this.lastError,
      restartRequested: this.restartRequested,
      checkedAt: this.checkedAt,
      autoCheck: this.settings.autoCheck,
      autoCheckTime: this.settings.autoCheckTime,
      nextAutoCheckAt: this.nextAutoCheckAt(),
    }
  }

  feed() {
    if (!this.feedUrl && this.manifest.updateFeed) return this.manifest.updateFeed
    return this.feedUrl
  }

  channelName() {
    return this.channel || this.manifest.channel || 'stable'
  }

  /**
   * Check both update channels: the official npm registry (the harness's
   * official distribution channel) and, when configured, the launcher feed.
   * The official channel wins when both offer updates. Idempotent and safe
   * to call while idle; concurrent calls coalesce through the phase guard.
   */
  async check() {
    if (!this.supported) throw new Error('更新功能仅在桌面启动器中可用')
    if (this.phase !== 'idle') throw new Error(`正在${this.phase === 'checking' ? '检查' : '更新'}，请稍候`)
    this.phase = 'checking'
    this.lastError = null
    this.latest = null
    this.latestFull = null
    this.updateAvailable = false
    this.updateSource = null
    let npmError = null
    let feedError = null

    try {
      /* ── official channel: npm registry ── */
      try {
        this.log(`check: GET ${this.npmRegistry}/${DSH_PACKAGE}`)
        const response = await fetch(`${this.npmRegistry}/${DSH_PACKAGE}`, {
          headers: {
            accept: 'application/vnd.npm.install-v1+json', // abbreviated metadata: dist-tags + time
            'user-agent': 'dsh-launcher-updater',
          },
          signal: AbortSignal.timeout(20000),
        })
        if (!response.ok) throw new Error(`官方 registry 响应 ${response.status}`)
        const pkg = await response.json()
        const distTags = pkg['dist-tags'] ?? null
        const version = typeof distTags === 'object' && distTags !== null && typeof distTags.latest === 'string'
          ? distTags.latest
          : (typeof pkg.version === 'string' ? pkg.version : null)
        if (version === null || version === '') throw new Error('官方 registry 未返回版本号')
        const currentDsh = this.manifest.dshVersion ?? '0.0.0'
        const time = pkg.time ?? null
        this.officialLatest = {
          version,
          publishedAt: (time !== null && typeof time === 'object' && typeof time[version] === 'string') ? time[version] : '',
        }
        this.officialUpdateAvailable = compareVersions(version, currentDsh) > 0
        this.log(`check: official dsh current=${currentDsh} latest=${version} available=${String(this.officialUpdateAvailable)}`)
      } catch (error) {
        npmError = error instanceof Error ? error.message : String(error)
        this.officialLatest = null
        this.officialUpdateAvailable = false
        this.log(`check: official channel failed: ${npmError}`)
      }

      /* ── launcher feed (optional) ── */
      let feedLatest = null
      const url = this.feed()
      if (url !== '') {
        try {
          this.log(`check: GET ${url}`)
          const response = await fetch(url, {
            headers: { accept: 'application/json', 'user-agent': 'dsh-launcher-updater' },
            signal: AbortSignal.timeout(20000),
          })
          if (!response.ok) throw new Error(`更新源响应 ${response.status}`)
          const channels = readFeed(await response.json())
          const entry = channels[this.channelName()]
          if (entry === undefined) throw new Error(`更新源没有通道 "${this.channelName()}"`)
          const latest = readLatest(entry)
          const current = this.manifest.runtimeVersion ?? '0.0.0'
          const available = compareVersions(latest.version, current) > 0
          this.latestFull = latest
          feedLatest = {
            source: 'feed',
            version: latest.version,
            dshVersion: latest.dshVersion ?? '',
            notes: latest.notes ?? '',
            publishedAt: latest.publishedAt ?? '',
            available,
          }
          this.log(`check: feed current=${current} latest=${latest.version} available=${String(available)}`)
        } catch (error) {
          feedError = error instanceof Error ? error.message : String(error)
          this.log(`check: feed failed: ${feedError}`)
        }
      }

      /* ── decide: official harness updates outrank launcher artifacts ── */
      if (this.officialUpdateAvailable) {
        this.updateSource = 'npm'
        this.updateAvailable = true
        this.latest = {
          source: 'npm',
          version: this.officialLatest.version,
          dshVersion: this.officialLatest.version,
          notes: '',
          publishedAt: this.officialLatest.publishedAt,
        }
      } else if (feedLatest !== null && feedLatest.available) {
        this.updateSource = 'feed'
        this.updateAvailable = true
        this.latest = { ...feedLatest }
      } else if (feedLatest !== null) {
        this.latest = { ...feedLatest } // display-only (no update)
      }
      this.checkedAt = new Date().toISOString()

      // Only fail the whole check when every channel failed.
      if (npmError !== null && (url === '' || feedError !== null)) {
        throw new Error(`检查失败：官方源(${npmError})${feedError !== null ? `；启动器更新源(${feedError})` : ''}`)
      }
    } finally {
      this.phase = 'idle'
    }
    return this.status()
  }

  /**
   * Stage and atomically swap in the checked update, then request a restart
   * (exit 42). The HTTP response is written before the exit fires.
   *
   * updateSource 'feed' → download the launcher artifact, verify sha256,
   * extract. updateSource 'npm' → copy the current runtime to staging and
   * upgrade @deepseek-ai/dsh there with the BUNDLED npm against the official
   * registry. Both end in the same atomic swap + restart; a failed boot on
   * the new runtime rolls back (the shell owns that).
   * @param options.force - apply even when no newer version was reported.
   */
  async apply(options = {}) {
    if (!this.supported) throw new Error('更新功能仅在桌面启动器中可用')
    if (this.phase !== 'idle') throw new Error('已有更新任务在进行中')
    if (this.archKey === null) throw new Error(`不支持的架构: ${process.arch}`)
    if (this.latest === null) throw new Error('尚未检查更新，请先点击“检查更新”')
    if (!this.updateAvailable && options.force !== true) throw new Error('当前已是最新版本')

    const parent = join(this.runtimeDir, '..')
    const backup = join(parent, 'runtime.backup')
    const staging = join(parent, `.update-staging-${String(process.pid)}`)
    const archive = join(parent, `.update-${String(process.pid)}.tar.gz`)

    this.lastError = null
    try {
      mkdirSync(staging, { recursive: true })
      if (this.updateSource === 'npm') {
        await this.applyOfficial(staging)
      } else {
        const artifact = this.latestArtifact()
        if (artifact === null) throw new Error(`更新源没有 ${this.archKey} 架构的产物`)
        this.phase = 'downloading'
        this.downloadTotal = await this.probeDownloadSize(artifact.url)
        this.progress = { received: 0, total: this.downloadTotal }
        this.log(`apply: downloading ${artifact.url}`)
        await this.download(artifact.url, archive)

        this.phase = 'verifying'
        this.progress = null
        this.log(`apply: verifying sha256 (${artifact.sha256})`)
        const digest = await sha256OfFile(archive)
        if (digest !== artifact.sha256.toLowerCase()) {
          throw new Error(`校验和不匹配：期望 ${artifact.sha256.slice(0, 16)}…，实际 ${digest.slice(0, 16)}…`)
        }

        this.phase = 'applying'
        this.log(`apply: extracting into ${staging}`)
        await extractTarGz(archive, staging)
        this.validateStaged(staging, this.latest.version)
      }

      // Atomic-ish swap on one volume: runtime → backup, staging → runtime.
      // If the second rename fails we restore the old runtime immediately.
      rmSync(backup, { recursive: true, force: true })
      renameSync(this.runtimeDir, backup)
      try {
        renameSync(staging, this.runtimeDir)
      } catch (error) {
        renameSync(backup, this.runtimeDir)
        throw error
      }

      this.manifest = readManifest(this.runtimeDir)
      this.updateAvailable = false
      this.updateSource = null
      this.restartRequested = true
      this.phase = 'restarting'
      this.writeUpdateState({ from: 'previous', to: this.manifest.dshVersion ?? this.manifest.runtimeVersion })
      this.log(`apply: swapped to dsh ${this.manifest.dshVersion ?? '?'} (runtime ${this.manifest.runtimeVersion ?? '?'}); restarting`)

      // The shell restarts the harness child on exit code 42; the response to
      // the browser is flushed long before this timer fires.
      setTimeout(() => { process.exit(RESTART_EXIT_CODE) }, 600)
      return this.status()
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      this.phase = 'idle'
      this.progress = null
      this.log(`apply failed: ${this.lastError}`)
      throw error
    } finally {
      rmSync(archive, { force: true })
      rmSync(staging, { recursive: true, force: true })
    }
  }

  /**
   * Official-channel update: copy the current runtime into staging, re-pin
   * @deepseek-ai/dsh to the checked version, and install with the bundled npm
   * (Node ships npm inside its dist; its cache points into the app's data
   * directory — nothing touches the user's system environment).
   */
  async applyOfficial(staging) {
    this.phase = 'applying'
    this.progress = null
    const target = this.latest.version
    this.log(`apply(npm): staging current runtime, upgrading ${DSH_PACKAGE} → ${target}`)
    cpSync(this.runtimeDir, staging, { recursive: true, dereference: false })

    const harnessDir = join(staging, 'harness')
    const pkgPath = join(harnessDir, 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    if (pkg.dependencies === null || typeof pkg.dependencies !== 'object' || typeof pkg.dependencies[DSH_PACKAGE] !== 'string') {
      throw new Error(`运行时缺少 ${DSH_PACKAGE} 依赖，无法从官方源更新`)
    }
    pkg.dependencies[DSH_PACKAGE] = target
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)

    // Test hook: force a real registry download of the target package even
    // when the current install already matches (DSH_LAUNCHER_FORCE_REDOWNLOAD=1).
    if (process.env.DSH_LAUNCHER_FORCE_REDOWNLOAD === '1') {
      rmSync(join(harnessDir, 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true, force: true })
      this.log('apply(npm): forced redownload of dsh (test hook)')
    }

    // npm now ships as a plain-JS harness dependency exposed through a bin
    // shim (runtime/node/bin/npm); the standalone Node dist is gone.
    const npmBin = join(staging, 'node', 'bin', 'npm')
    if (!existsSync(npmBin)) throw new Error('内置 npm 缺失（node/bin/npm），无法从官方源更新')
    this.log(`apply(npm): npm install ${DSH_PACKAGE}@${target} (official registry)`)
    const env = {
      ...process.env,
      npm_config_registry: this.npmRegistry,
      npm_config_cache: join(this.dataDir || staging, '.npm-cache'),
      npm_config_update_notifier: 'false',
      npm_config_audit: 'false',
      npm_config_fund: 'false',
      npm_config_loglevel: 'warn',
      PATH: `${join(staging, 'node', 'bin')}${process.env.PATH ? `:${process.env.PATH}` : ''}`,
    }
    await this.runCommand(npmBin, ['install', '--omit=dev'], {
      cwd: harnessDir,
      env,
      timeoutMs: 10 * 60 * 1000,
      label: 'npm',
    })

    const installed = JSON.parse(readFileSync(join(harnessDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'))
    if (installed.version !== target) {
      throw new Error(`官方源安装结果不匹配：期望 ${target}，实际 ${installed.version}`)
    }

    const manifestPath = join(staging, RUNTIME_MANIFEST)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.dshVersion = target
    manifest.builtAt = new Date().toISOString()
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    this.validateStaged(staging)
    this.log(`apply(npm): staged dsh ${target} ready for swap`)
  }

  /** Spawn a command to completion with a hard timeout and logged output. */
  runCommand(command, args, options) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] })
      const killTimer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 10 * 60 * 1000)
      let output = ''
      const onData = chunk => {
        output += String(chunk)
        if (output.length > 20000) output = output.slice(-20000)
      }
      child.stdout.on('data', onData)
      child.stderr.on('data', onData)
      child.on('error', error => {
        clearTimeout(killTimer)
        reject(error)
      })
      child.on('close', code => {
        clearTimeout(killTimer)
        if (code === 0) resolve()
        else {
          this.log(`${options.label} exited ${String(code)}: ${output.slice(-1500)}`)
          reject(new Error(`${options.label} 失败 (exit ${String(code)})：${output.trim().split('\n').slice(-4).join('\n').slice(-600)}`))
        }
      })
    })
  }

  latestArtifact() {
    if (this.latest === null) return null
    // The full feed entry (with artifacts) is cached internally alongside the
    // trimmed public shape.
    const full = this.latestFull
    const artifacts = full !== null && typeof full === 'object' ? full.artifacts : null
    if (artifacts === null || typeof artifacts !== 'object') return null
    const entry = artifacts[this.archKey]
    if (entry === null || typeof entry !== 'object') return null
    if (typeof entry.url !== 'string' || entry.url === '' || typeof entry.sha256 !== 'string') return null
    return entry
  }

  /** Request a plain harness restart (no update). */
  requestRestart() {
    if (!this.supported) throw new Error('更新功能仅在桌面启动器中可用')
    this.restartRequested = true
    this.phase = 'restarting'
    setTimeout(() => { process.exit(RESTART_EXIT_CODE) }, 600)
    return this.status()
  }

  /**
   * Download a URL to a local file via the system curl (always present on
   * macOS). Streaming through Node's fetch is avoided on purpose: undici in
   * some Node 24 releases aborts the whole process on a mid-stream teardown
   * race (`assert(!this.paused)`), and an updater must never crash the
   * harness it updates. Progress is sampled from the output file size.
   */
  download(url, target) {
    return new Promise((resolve, reject) => {
      this.progress = { received: 0, total: this.downloadTotal }
      const child = spawn('/usr/bin/curl', [
        '--silent', '--show-error', '--location', '--fail',
        '--connect-timeout', '20', '--output', target, url,
      ], { stdio: ['ignore', 'ignore', 'pipe'] })
      const killTimer = setTimeout(() => child.kill('SIGKILL'), 10 * 60 * 1000)
      const poll = setInterval(() => {
        try {
          this.progress = { received: statSync(target).size, total: this.downloadTotal }
        } catch { /* file not there yet */ }
      }, 500)
      let stderr = ''
      child.stderr.on('data', chunk => { stderr += String(chunk) })
      child.on('error', error => {
        clearTimeout(killTimer)
        clearInterval(poll)
        reject(error)
      })
      child.on('close', code => {
        clearTimeout(killTimer)
        clearInterval(poll)
        if (code === 0) {
          try {
            this.progress = { received: statSync(target).size, total: this.downloadTotal }
          } catch { /* fall through with the sampled value */ }
          resolve()
        } else {
          reject(new Error(`下载失败 (curl exit ${String(code)}): ${stderr.trim().slice(-300)}`))
        }
      })
    })
  }

  /** Best-effort content-length probe for progress display; never fatal. */
  async probeDownloadSize(url) {
    try {
      const response = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(10000) })
      const length = response.headers.get('content-length')
      return length === null ? null : Number.parseInt(length, 10)
    } catch {
      return null
    }
  }

  /** The staged runtime must look like a real runtime before we swap. */
  validateStaged(staging, expectedVersion = null) {
    const manifest = readManifest(staging)
    if (expectedVersion !== null && manifest.runtimeVersion !== expectedVersion) {
      throw new Error(`产物运行时版本不匹配：期望 ${expectedVersion}，实际 ${manifest.runtimeVersion ?? '?'}`)
    }
    if (!existsSync(join(staging, 'node', 'bin', 'node'))) {
      throw new Error('产物缺少 node/bin/node')
    }
    if (!existsSync(join(staging, 'harness', 'node_modules', '@deepseek-ai', 'dsh'))) {
      throw new Error('产物缺少 @deepseek-ai/dsh 安装')
    }
  }

  writeUpdateState(update) {
    if (this.dataDir === '') return
    try {
      mkdirSync(this.dataDir, { recursive: true })
      writeFileSync(join(this.dataDir, 'update-state.json'), `${JSON.stringify({
        appliedAt: new Date().toISOString(),
        to: update.to,
        from: update.from,
      }, null, 2)}\n`)
    } catch { /* diagnostics only */ }
  }
}
