/**
 * DeepSeek Harness — desktop launcher (Electron main process).
 *
 * The shell is a thin, immutable supervisor. Everything that makes the
 * harness run lives in a self-contained, swappable runtime directory inside
 * the app bundle:
 *
 *   Contents/Resources/runtime/          active runtime: bin shims (the
 *                                        app's own Electron binary runs as
 *                                        Node), the @deepseek-ai/dsh
 *                                        installation, and the launcher-
 *                                        updater plugin
 *   Contents/Resources/runtime.backup/   previous runtime after an update
 *                                        (deleted once the new one proves
 *                                        healthy — the rollback source)
 *   Contents/Resources/data/             persistent user data (DSH_HOME,
 *                                        logs, update state); never swapped.
 *                                        data/pristine/ holds the compressed
 *                                        self-heal snapshot this shell makes
 *                                        from the latest healthy runtime
 *                                        (the .app no longer embeds a second
 *                                        compressed copy of the runtime)
 *
 * Responsibilities:
 *   - boot the harness (`runtime/node/bin/node … dsh web --port N`) with a
 *     fresh free port and a fully app-internal environment (DSH_HOME inside
 *     the bundle, runtime bin dir first on PATH — nothing global is
 *     touched),
 *   - supervise it: exit code 42 means "restart" (update applied or the
 *     user asked for a restart); an abnormal exit during boot counts toward
 *     rollback; a healthy boot commits (deletes) the previous runtime,
 *   - host the BrowserWindow and keep navigation loopback-only,
 *   - repair itself: missing/broken runtime → restore pristine; two failed
 *     boots in a row → roll back to the backup or pristine runtime.
 */

const { app, BrowserWindow, Menu, dialog, shell: osShell } = require('electron')
const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')

/* ────────────────────────────── paths & constants ────────────────────────── */
const RESOURCES = process.resourcesPath
const RUNTIME = path.join(RESOURCES, 'runtime')
const LEGACY_PRISTINE_TAR = path.join(RESOURCES, 'runtime.pristine.tar.gz')
const BACKUP = path.join(RESOURCES, 'runtime.backup')
const BAD = path.join(RESOURCES, 'runtime.bad')
const DATA = path.join(RESOURCES, 'data')
const PRISTINE_DIR = path.join(DATA, 'pristine')
const HOME = path.join(DATA, 'home')
const LOGS = path.join(DATA, 'logs')
const HARNESS_LOG = path.join(LOGS, 'harness.log')

const RESTART_EXIT = 42
const BOOT_TIMEOUT_MS = 90 * 1000
const COMMIT_DELAY_MS = 20 * 1000
const BOOT_FAILURE_WINDOW_MS = 120 * 1000
const MAX_BOOT_FAILURES = 2
const MAX_ROLLBACK_CYCLES = 3
const MAX_LOG_BYTES = 8 * 1024 * 1024

const DSH_CLI_BIN = path.join('harness', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const NODE_BIN = path.join('node', 'bin', 'node')

/* ──────────────────────────────── small helpers ──────────────────────────── */
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const exists = p => { try { return fs.existsSync(p) } catch { return false } }

let logStream = null
function log(line) {
  const text = `${new Date().toISOString()} [shell] ${line}\n`
  try {
    fs.mkdirSync(LOGS, { recursive: true })
    if (!logStream) logStream = fs.createWriteStream(HARNESS_LOG, { flags: 'a' })
    logStream.write(text)
  } catch { /* logging must never break the shell */ }
  console.log(text.trimEnd())
}

function rotateLog() {
  try {
    const stat = fs.statSync(HARNESS_LOG)
    if (stat.size > MAX_LOG_BYTES) {
      fs.rmSync(`${HARNESS_LOG}.1`, { force: true })
      fs.renameSync(HARNESS_LOG, `${HARNESS_LOG}.1`)
      if (logStream) { logStream.end(); logStream = null }
    }
  } catch { /* absent log file */ }
}

function readManifest(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'harness.json'), 'utf8'))
  } catch {
    return null
  }
}

/** A runtime dir counts as valid when it has the manifest and both binaries. */
function runtimeValid(dir) {
  return exists(path.join(dir, 'harness.json'))
    && exists(path.join(dir, NODE_BIN))
    && exists(path.join(dir, DSH_CLI_BIN))
}

/**
 * The pristine self-heal snapshot. Since the .app stopped embedding a
 * compressed copy of the runtime, this shell creates the snapshot itself
 * from the latest healthy runtime (data/pristine/runtime-<version>.tar.gz).
 * Installs that predate the feature may still carry the factory snapshot
 * inside Resources (legacy fallback).
 */
function pristineSnapshotPath() {
  try {
    if (fs.existsSync(PRISTINE_DIR)) {
      const snapshots = fs.readdirSync(PRISTINE_DIR)
        .filter(name => /^runtime-.*\.tar\.gz$/.test(name))
        .sort()
      if (snapshots.length > 0) return path.join(PRISTINE_DIR, snapshots[snapshots.length - 1])
    }
  } catch { /* data dir unavailable */ }
  return exists(LEGACY_PRISTINE_TAR) ? LEGACY_PRISTINE_TAR : null
}

/**
 * Snapshot the currently healthy runtime as the pristine self-heal source.
 * Runs detached (a slow disk must never delay boot); tmp+rename keeps the
 * snapshot atomic, and only the newest version is kept.
 */
function snapshotPristine() {
  const manifest = readManifest(RUNTIME)
  const version = manifest?.runtimeVersion ?? 'unknown'
  const target = path.join(PRISTINE_DIR, `runtime-${version}.tar.gz`)
  if (exists(target)) return
  try {
    fs.mkdirSync(PRISTINE_DIR, { recursive: true })
  } catch (error) {
    log(`pristine: mkdir failed: ${error.message}`)
    return
  }
  const tmp = `${target}.tmp`
  try { fs.rmSync(tmp, { force: true }) } catch { /* absent */ }
  log(`pristine: snapshotting runtime ${version} …`)
  const tar = spawn('/usr/bin/tar', ['-czf', tmp, '-C', RUNTIME, '.'], { stdio: 'ignore' })
  tar.on('error', error => log(`pristine: snapshot failed: ${error.message}`))
  tar.on('exit', code => {
    try {
      if (code !== 0) {
        fs.rmSync(tmp, { force: true })
        log(`pristine: snapshot failed (tar exit ${String(code)})`)
        return
      }
      fs.renameSync(tmp, target)
      for (const name of fs.readdirSync(PRISTINE_DIR)) {
        if (/^runtime-.*\.tar\.gz$/.test(name)) {
          const full = path.join(PRISTINE_DIR, name)
          if (full !== target) fs.rmSync(full, { force: true })
        }
      }
      log('pristine: snapshot ready')
    } catch (error) {
      log(`pristine: snapshot finalize failed: ${error.message}`)
    }
  })
  tar.unref()
}

/**
 * Recreate a factory runtime from the pristine snapshot. Extract into a
 * temp dir inside Resources, then atomically rename into place: a failed
 * extraction never leaves a half-restored runtime behind.
 */
function restorePristine() {
  const pristineTar = pristineSnapshotPath()
  if (pristineTar === null) return false
  const tmp = path.join(RESOURCES, 'runtime.restore.tmp')
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.mkdirSync(tmp, { recursive: true })
  const result = spawnSync('/usr/bin/tar', ['-xzf', pristineTar, '-C', tmp], { stdio: 'ignore' })
  if (result.status !== 0 || !runtimeValid(tmp)) {
    fs.rmSync(tmp, { recursive: true, force: true })
    log('restore: pristine snapshot extraction failed')
    return false
  }
  fs.rmSync(RUNTIME, { recursive: true, force: true })
  fs.renameSync(tmp, RUNTIME)
  log(`restore: factory runtime restored from ${path.basename(pristineTar)}`)
  return true
}

function logTail(pathname, lines) {
  try {
    const content = fs.readFileSync(pathname, 'utf8')
    return content.split('\n').slice(-lines).join('\n')
  } catch {
    return '(no log)'
  }
}

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

/* ─────────────────────────────── harness child ───────────────────────────── */
let child = null
let quitting = false
let booting = false
let port = 0
let bootStartAt = 0
let bootFailures = 0
let rollbackCycles = 0
let healthy = false
let commitTimer = null

/**
 * Default plugins that live inside the runtime and must be resolvable from the
 * web profile. The profile's own node_modules is the designed out-of-tree
 * extension point; we pre-seed one relative symlink per bundled plugin and
 * reconcile them on every boot, so runtime updates pick up plugin changes and
 * pre-existing user data directories get the links they are missing.
 */
const RUNTIME_PLUGIN_LINKS = [
  { name: 'dsh-launcher-updater', target: parts => path.join(parts.runtime, 'plugins', 'dsh-launcher-updater') },
  { name: '@liustack/modlens', target: parts => path.join(parts.runtime, 'harness', 'node_modules', '@liustack', 'modlens') },
  { name: 'dshmarket', target: parts => path.join(parts.runtime, 'harness', 'node_modules', 'dshmarket') },
  { name: '@dsh-external/dsh-super-injector', target: parts => path.join(parts.runtime, 'harness', 'node_modules', '@dsh-external', 'dsh-super-injector') },
]

function syncPluginLinks() {
  const profileModules = path.join(HOME, 'profiles', 'web', 'node_modules')
  for (const plugin of RUNTIME_PLUGIN_LINKS) {
    const target = plugin.target({ runtime: RUNTIME })
    if (!exists(target)) {
      log(`plugin link: skipping ${plugin.name} (target missing: ${target})`)
      continue
    }
    const link = path.join(profileModules, plugin.name)
    const rel = path.relative(path.dirname(link), target)
    try {
      const stat = fs.lstatSync(link)
      if (stat.isSymbolicLink() && fs.readlinkSync(link) === rel) continue
      fs.rmSync(link, { recursive: true, force: true })
    } catch { /* absent link */ }
    try {
      fs.mkdirSync(path.dirname(link), { recursive: true })
      fs.symlinkSync(rel, link, 'dir')
      log(`plugin link: ${plugin.name} → ${rel}`)
    } catch (error) {
      log(`plugin link failed for ${plugin.name}: ${error.message}`)
    }
  }
}

/**
 * Default agent presets shipped inside the runtime (dsh-routing-suite).
 * Copy them into the user's DSH_HOME only when the preset id is absent, so
 * user-authored copies are never overwritten by a runtime update.
 */
function syncUserPresets() {
  const shippedRoot = path.join(RUNTIME, 'agent-presets')
  if (!exists(shippedRoot)) return
  const userRoot = path.join(HOME, '.agent-presets')
  let entries = []
  try {
    entries = fs.readdirSync(shippedRoot, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const source = path.join(shippedRoot, entry.name)
    const target = path.join(userRoot, entry.name)
    if (exists(target)) continue
    try {
      fs.mkdirSync(userRoot, { recursive: true })
      fs.cpSync(source, target, { recursive: true, dereference: false })
      log(`preset: installed ${entry.name} → ${target}`)
    } catch (error) {
      log(`preset: failed to install ${entry.name}: ${error.message}`)
    }
  }
}

function spawnHarness() {
  rotateLog()
  bootStartAt = Date.now()
  healthy = false
  log(`boot: spawning harness on 127.0.0.1:${port}`)

  const nodeBin = path.join(RUNTIME, NODE_BIN)
  const cliBin = path.join(RUNTIME, DSH_CLI_BIN)
  const manifest = readManifest(RUNTIME) ?? {}
  syncPluginLinks()
  syncUserPresets()

  const env = {
    ...process.env,
    DSH_HOME: HOME,
    DSH_LAUNCHER_RUNTIME_DIR: RUNTIME,
    DSH_LAUNCHER_DATA_DIR: DATA,
    DSH_LAUNCHER_APP_VERSION: app.getVersion(),
    // The runtime's node/npm/pnpm bin shims exec this binary with
    // ELECTRON_RUN_AS_NODE=1 — Electron doubles as the runtime Node.
    DSH_LAUNCHER_NODE_BIN: process.execPath,
    PATH: `${path.join(RUNTIME, 'node', 'bin')}${path.delimiter}${process.env.PATH ?? ''}`,
    // pnpm (used by dsh-market to install plugins) keeps its tarball store
    // and metadata cache inside the app's data directory — nothing lands in
    // ~/.local, ~/Library, or anywhere else outside the bundle.
    npm_config_store_dir: path.join(DATA, 'pnpm-store'),
    npm_config_cache_dir: path.join(DATA, 'pnpm-cache'),
  }
  if (manifest.updateFeed) env.DSH_LAUNCHER_FEED_URL = manifest.updateFeed
  if (manifest.channel) env.DSH_LAUNCHER_CHANNEL = manifest.channel

  // The composition overlay mounts the bundled default plugins (updater +
  // image support). It rides the runtime artifact, so updating the runtime
  // updates the plugin set without touching user data.
  //
  // Argument order matters: the dsh launcher's own flags (--patch) must come
  // FIRST — the first unknown token (--host) starts the inner args the web
  // app parses itself.
  const overlay = path.join(RUNTIME, 'profile-overlay.yml')
  const args = ['web']
  if (exists(overlay)) args.push('--patch', overlay)
  args.push('--host', '127.0.0.1', '--port', String(port))

  const logFd = fs.openSync(HARNESS_LOG, 'a')
  child = spawn(nodeBin, [cliBin, ...args], {
    env,
    stdio: ['ignore', logFd, logFd],
    // New sessions default to the user's real home as their working
    // directory; the harness environment itself stays fully app-internal.
    cwd: os.homedir(),
  })
  fs.closeSync(logFd)
  child.on('exit', onChildExit)
  // A spawn-time failure (missing node binary, bad permissions) fires 'error'
  // without 'exit'; treat it as an abnormal exit so the recovery paths run.
  child.on('error', error => {
    log(`spawn error: ${error.message}`)
    onChildExit(null, null)
  })
}

async function waitReady(timeoutMs = BOOT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child === null) throw new Error('harness exited during boot')
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) })
      if (response.status === 200) return
    } catch { /* not up yet */ }
    await sleep(250)
  }
  throw new Error(`harness boot timed out after ${Math.round(timeoutMs / 1000)}s`)
}

function clearCommit() {
  if (commitTimer !== null) {
    clearTimeout(commitTimer)
    commitTimer = null
  }
}

/** After a healthy boot, the previous runtime (update rollback source) goes,
 *  and the healthy runtime becomes the new pristine self-heal snapshot. */
function armCommit() {
  clearCommit()
  commitTimer = setTimeout(() => {
    commitTimer = null
    healthy = true
    if (exists(BACKUP)) {
      log('commit: healthy boot, removing previous runtime backup')
      fs.rmSync(BACKUP, { recursive: true, force: true })
    }
    snapshotPristine()
  }, COMMIT_DELAY_MS)
  commitTimer.unref?.()
}

function tryRollback() {
  if (exists(BACKUP)) {
    log('rollback: moving broken runtime aside and restoring the previous one')
    fs.rmSync(BAD, { recursive: true, force: true })
    fs.renameSync(RUNTIME, BAD)
    fs.renameSync(BACKUP, RUNTIME)
    return true
  }
  if (pristineSnapshotPath() !== null) {
    log('rollback: restoring the pristine factory runtime')
    fs.rmSync(BAD, { recursive: true, force: true })
    fs.renameSync(RUNTIME, BAD)
    return restorePristine()
  }
  return false
}

function onChildExit(code, signal) {
  if (quitting || child === null) return
  child = null
  clearCommit()
  log(`harness exited: code=${code} signal=${signal ?? 'none'}`)

  if (code === RESTART_EXIT) {
    log('restart requested (update applied or manual restart)')
    void boot()
    return
  }

  const failedDuringBoot = Date.now() - bootStartAt < BOOT_FAILURE_WINDOW_MS
  if (failedDuringBoot && !healthy) {
    bootFailures += 1
  } else {
    bootFailures = 1 // a crash after a healthy period just restarts once
  }

  // Two consecutive boot-window failures → the runtime is suspect: roll back
  // to the previous/known-good runtime when one exists.
  if (bootFailures >= MAX_BOOT_FAILURES && rollbackCycles < MAX_ROLLBACK_CYCLES) {
    rollbackCycles += 1
    if (tryRollback()) {
      bootFailures = 0
      void boot()
      return
    }
  }
  // Neither restart nor rollback is making progress → give up with the logs.
  if (bootFailures >= 4 || rollbackCycles >= MAX_ROLLBACK_CYCLES) {
    showFatalError(code, signal)
    return
  }
  void boot()
}

async function boot() {
  if (quitting || booting || child !== null) return // already supervised; exit handler drives the next step
  booting = true
  try {
    port = await pickFreePort()
    spawnHarness()
    await waitReady()
    log(`harness ready on http://127.0.0.1:${port}/`)
    bootFailures = 0
    rollbackCycles = 0
    createOrReloadWindow()
    armCommit()
  } catch (error) {
    log(`boot failed: ${error instanceof Error ? error.message : String(error)}`)
    if (child !== null && child.exitCode === null) child.kill('SIGTERM') // exit handler continues the recovery
  } finally {
    booting = false
  }
}

function showFatalError(code, signal) {
  const detail = `harness 进程意外退出 (code=${code ?? 'null'}, signal=${signal ?? 'none'})。`
  const tail = `${logTail(HARNESS_LOG, 30)}\n\n${logTail(path.join(LOGS, 'updater.log'), 15)}`
  const buttons = ['打开日志目录', '退出']
  const choice = dialog.showMessageBoxSync({
    type: 'error',
    title: 'DeepSeek Harness',
    message: 'DeepSeek Harness 无法启动',
    detail: `${detail}\n\n${tail}`,
    buttons,
    defaultId: 0,
    cancelId: 1,
  })
  if (choice === 0) osShell.openPath(LOGS)
  app.quit()
}

/* ───────────────────────────────── window ────────────────────────────────── */
let win = null

/** Bounds persistence: remember where the user left the window. */
function windowStateFile() {
  return path.join(DATA, 'window-state.json')
}

function readWindowState() {
  try {
    const state = JSON.parse(fs.readFileSync(windowStateFile(), 'utf8'))
    if (typeof state.width === 'number' && typeof state.height === 'number') return state
  } catch { /* first run / corrupt state */ }
  return null
}

function persistWindowState() {
  if (win === null) return
  try {
    const bounds = win.getNormalBounds()
    fs.mkdirSync(DATA, { recursive: true })
    fs.writeFileSync(windowStateFile(), `${JSON.stringify({
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      maximized: win.isMaximized(),
    }, null, 2)}\n`)
  } catch { /* cosmetic persistence only */ }
}

/**
 * Codex-style immersive outer frame: frameless window (`titleBarStyle:
 * 'hiddenInset'` — traffic lights float inset over the dark canvas, exactly
 * the Codex look), full-bleed dark background, persisted window bounds,
 * centered on first launch.
 *
 * Dragging: macOS gives frameless windows no native drag surface, so the
 * shell injects a page-level drag strip across the top (the official
 * -webkit-app-region mechanism, same one Codex/VSCode-style apps use). The
 * sidebar brand row is nudged down so nothing interactive sits under the
 * traffic lights or the strip; a future dsh version that renames the brand
 * class just loses the cosmetic nudge, never the drag strip.
 */
const WINDOW_CSS = `
  body::before {
    content: '';
    position: fixed;
    top: 0; left: 0; right: 0;
    height: 32px;
    -webkit-app-region: drag;
    z-index: 2147483647;
  }
  /* Reserve the traffic-light zone in both sidebar modes: the logo row
     (wordmark when expanded, whale mark when collapsed to the rail) starts
     below the macOS window controls, and keeps ONE fixed height so the
     header looks identical wide and narrow. */
  [class*="logoRow"] {
    height: 72px !important;
    padding-top: 34px !important;
  }
  /* dsh-market's category bar ("全部…" chips) is sticky at top:-13px with a
     -12px top margin, so scrolling the Discover list slides it UP OVER the
     search box and its opaque background covers the input's lower half.
     Stick it flush at the container top and drop the negative margin: the
     search scrolls away cleanly under a properly anchored bar. */
  .eGUBIq_cats {
    top: 0 !important;
    margin-top: 0 !important;
  }
`

function injectWindowCss() {
  if (win === null) return
  win.webContents.insertCSS(WINDOW_CSS).catch(() => { /* page not ready */ })
  win.webContents.executeJavaScript(NAV_ICON_PATCH_SCRIPT).catch(() => { /* page not ready */ })
}

/**
 * The settings nav renders a hardcoded icon map (models/agent-presets/
 * plugins) and falls back to the gear for every other section, so all our
 * sections — 更新, 备份与还原, 个人中心, and the bundled 插件市场 — show the
 * same wrong glyph. This observer swaps the nav icon per section label with
 * proper single-path glyphs (Material Design icon set, the same fill style
 * DSH's own icons use). Pure DOM patch: survives harness updates, degrades
 * to the stock gear if selectors ever drift.
 */
const NAV_ICON_PATCH_SCRIPT = `(function () {
  var GLYPHS = {
    "插件市场": "M20 4H4v2h16V4zm1 10v-2l-1-5H4l-1 5v2h1v6h10v-6h4v6h2v-6h1zm-9 4H6v-4h6v4z",
    "Plugin Market": "M20 4H4v2h16V4zm1 10v-2l-1-5H4l-1 5v2h1v6h10v-6h4v6h2v-6h1zm-9 4H6v-4h6v4z",
    "Market": "M20 4H4v2h16V4zm1 10v-2l-1-5H4l-1 5v2h1v6h10v-6h4v6h2v-6h1zm-9 4H6v-4h6v4z",
    "备份与还原": "M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z",
    "Backup & Restore": "M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z",
    "更新": "M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z",
    "Updates": "M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z",
    "个人中心": "M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z",
    "Personal": "M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z",
  };
  function patchRow(row) {
    var svg = row.querySelector("svg");
    if (svg === null || svg.getAttribute("data-dsh-navicon") === "1") return;
    var label = row.querySelector("span[class*='navLabel'], span");
    var text = (label === null ? row.textContent : label.textContent || "").trim();
    var glyph = GLYPHS[text];
    if (glyph === undefined) return;
    svg.setAttribute("data-dsh-navicon", "1");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.innerHTML = "<path d=\\"" + glyph + "\\" fill=\\"currentColor\\"/>";
  }
  function scan() {
    var labels = document.querySelectorAll("span[class*='navLabel']");
    for (var i = 0; i < labels.length; i++) {
      var row = labels[i].closest("button, li, [role='tab'], [role='menuitem']") || labels[i].parentElement;
      if (row !== null) patchRow(row);
    }
  }
  var observer = new MutationObserver(scan);
  observer.observe(document.body, { childList: true, subtree: true });
  scan();
})();`

function createOrReloadWindow() {
  const url = `http://127.0.0.1:${port}/`
  if (win === null) {
    const saved = readWindowState()
    win = new BrowserWindow({
      width: saved?.width ?? 1100,
      height: saved?.height ?? 760,
      x: saved?.x,
      y: saved?.y,
      minWidth: 880,
      minHeight: 560,
      title: 'DeepSeek Harness',
      show: false,
      backgroundColor: '#16161d',
      titleBarStyle: 'hiddenInset',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    if (saved === null) win.center()
    win.once('ready-to-show', () => win.show())
    win.on('resize', () => persistWindowState())
    win.on('move', () => persistWindowState())
    win.on('closed', () => {
      persistWindowState()
      win = null
    })
    win.webContents.on('did-finish-load', injectWindowCss)
    win.webContents.setWindowOpenHandler(({ url: target }) => {
      if (/^https?:/i.test(target)) osShell.openExternal(target)
      return { action: 'deny' }
    })
    win.webContents.on('will-navigate', (event, target) => {
      let parsed
      try { parsed = new URL(target) } catch { return } // relative: allow
      const loopback = (parsed.protocol === 'http:' || parsed.protocol === 'https:')
        && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '::1')
      if (loopback) return
      event.preventDefault()
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') osShell.openExternal(target)
    })
  }
  win.loadURL(url)
}

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'DeepSeek Harness',
      submenu: [
        { role: 'about', label: '关于 DeepSeek Harness' },
        { type: 'separator' },
        { role: 'hide', label: '隐藏' },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '全部显示' },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '显示',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '切换全屏' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'close', label: '关闭窗口' },
      ],
    },
  ]))
}

/* ────────────────────────────── e2e/dev helpers ──────────────────────────── */
/** DSH_LAUNCHER_E2E_SCRIPT=<file> — run the file's JS inside the page once it
 *  loads, write the returned JSON to DSH_LAUNCHER_E2E_OUT, screenshot to
 *  DSH_LAUNCHER_E2E_SHOT, and quit. Build/CI verification hook only. */
async function runE2eIfRequested() {
  const script = process.env.DSH_LAUNCHER_E2E_SCRIPT
  if (!script) return false
  try {
    await sleep(2500)
    const code = fs.readFileSync(script, 'utf8')
    const result = await win.webContents.executeJavaScript(code, true)
    const out = process.env.DSH_LAUNCHER_E2E_OUT
    if (out) fs.writeFileSync(out, JSON.stringify(result, null, 2))
    const shot = process.env.DSH_LAUNCHER_E2E_SHOT
    if (shot) {
      await sleep(1200)
      const image = await win.webContents.capturePage()
      fs.writeFileSync(shot, image.toPNG())
    }
    app.quit()
    return true
  } catch (error) {
    console.error('e2e hook failed:', error)
    app.exit(2)
    return true
  }
}

/* ───────────────────────────────── lifecycle ─────────────────────────────── */
function isTranslocated() {
  // Gatekeeper translocates quarantined apps launched straight from a DMG to a
  // read-only random mount; the runtime needs its writable bundle home.
  return app.getAppPath().includes('AppTranslocation')
}

function ensureRuntime() {
  if (runtimeValid(RUNTIME)) return true
  if (exists(BACKUP) && runtimeValid(BACKUP)) {
    log('runtime missing/invalid; restoring the previous runtime')
    fs.rmSync(BAD, { recursive: true, force: true })
    fs.renameSync(RUNTIME, BAD)
    fs.renameSync(BACKUP, RUNTIME)
    return true
  }
  if (pristineSnapshotPath() !== null) {
    log('runtime missing/invalid; restoring the pristine factory runtime')
    fs.rmSync(BAD, { recursive: true, force: true })
    return restorePristine()
  }
  return false
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  // A second copy was launched while one is already running: explain instead
  // of silently quitting (a silent exit reads as a crash to the user).
  app.whenReady().then(() => {
    dialog.showMessageBoxSync({
      type: 'info',
      title: 'DeepSeek Harness',
      message: 'DeepSeek Harness 已在运行',
      detail: '应用已经有一个窗口在运行。请切换到已有的 DeepSeek Harness 窗口；如果看不到，请在程序坞中点击它的图标。',
      buttons: ['好的'],
    })
    app.quit()
  })
} else {
  app.on('second-instance', () => {
    if (win !== null) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(() => {
    if (isTranslocated()) {
      dialog.showMessageBoxSync({
        type: 'info',
        title: 'DeepSeek Harness',
        message: '请先将 DeepSeek Harness 移到“应用程序”文件夹',
        detail: 'macOS 会临时隔离直接从安装映像启动的应用。请把 DeepSeek Harness 拖到“应用程序”文件夹后，再从那里打开。',
        buttons: ['打开“应用程序”文件夹', '退出'],
      })
      osShell.openPath('/Applications')
      app.quit()
      return
    }

    buildMenu()
    try {
      fs.mkdirSync(HOME, { recursive: true })
      fs.mkdirSync(LOGS, { recursive: true })
    } catch (error) {
      log(`data dir setup failed: ${error.message}`)
    }

    if (!ensureRuntime()) {
      dialog.showErrorBox('DeepSeek Harness', '应用内缺少运行环境（runtime），且没有可恢复的备份。请重新安装 DeepSeek Harness。')
      app.quit()
      return
    }

    void boot().then(() => runE2eIfRequested())
  })

  app.on('activate', () => {
    if (win === null && child !== null && port !== 0) createOrReloadWindow()
  })

  app.on('window-all-closed', () => {
    app.quit()
  })

  app.on('before-quit', () => {
    quitting = true
    clearCommit()
    const current = child
    child = null
    if (current !== null && current.exitCode === null) {
      current.kill('SIGTERM')
      const killer = setTimeout(() => {
        try { current.kill('SIGKILL') } catch { /* already gone */ }
      }, 5000)
      killer.unref?.()
    }
  })
}
