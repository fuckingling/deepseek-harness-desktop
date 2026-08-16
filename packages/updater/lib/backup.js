/**
 * Chat-record backup & restore engine of the desktop launcher plugin.
 *
 * Backs up the complete session data under DSH_HOME — the `sessions/`
 * directory (the append-only JSONL event logs, one per session), the
 * `storages/` directory (workspace + every projection the storage-json
 * backend writes) and the `attachments/` directory (images pasted into
 * chats) — into one tar.gz archive, and restores it by atomically swapping
 * those directories and asking the shell for a restart (exit 42), so the
 * harness reloads every restored record from disk. A pre-restore snapshot of
 * the current records is kept (`*.pre-restore`) for manual recovery.
 *
 * The plugin is plain Node ESM: only builtin modules + /usr/bin/tar (always
 * present on macOS), no build step. All paths are inside the app bundle's
 * data directory; downloads/restores never touch anything else.
 *
 * @module dsh-launcher-updater/backup
 */

import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { RESTART_EXIT_CODE } from './engine.js'

/** Directories under DSH_HOME that constitute the complete chat records. */
export const CHAT_DIRS = ['storages', 'sessions', 'attachments']

/** Manifest filename written into every archive root. */
export const BACKUP_INFO = 'backup-info.json'

const SAFE_NAME = /^[a-zA-Z0-9._-]+$/

function bytesOf(path) {
  let total = 0
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (entry.isFile()) {
        try { total += statSync(p).size } catch { /* racing writes */ }
      }
    }
  }
  try { walk(path) } catch { /* missing */ }
  return total
}

function runTar(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/tar', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) resolve()
      else reject(new Error(`tar 失败 (exit ${String(code)}): ${stderr.trim().slice(-300)}`))
    })
  })
}

function listTar(path) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/tar', ['-tzf', path], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', chunk => { out += String(chunk) })
    child.stderr.on('data', chunk => { err += String(chunk) })
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) resolve(out.split('\n').map(line => line.trim()).filter(line => line !== ''))
      else reject(new Error(`tar 无法读取归档: ${err.trim().slice(-200)}`))
    })
  })
}

/** Reject archives with path traversal or absolute entries before extracting. */
function assertSafeListing(entries) {
  for (const entry of entries) {
    if (entry.startsWith('/') || entry.includes('..')) {
      throw new Error(`归档包含不安全路径: ${entry.slice(0, 120)}`)
    }
  }
}

/**
 * Backup engine. One instance per host fiber; the routes in index.js are
 * thin adapters over its methods. State is process-local.
 */
export class BackupEngine {
  constructor(ctx, env = process.env) {
    this.ctx = ctx
    this.dataDir = env.DSH_LAUNCHER_DATA_DIR ?? ''
    this.runtimeDir = env.DSH_LAUNCHER_RUNTIME_DIR ?? ''
    this.supported = this.dataDir !== '' && this.runtimeDir !== ''
    this.home = this.dataDir === '' ? '' : join(this.dataDir, 'home')
    this.backupDir = this.dataDir === '' ? '' : join(this.dataDir, 'backups')
    this.phase = 'idle' // idle | creating | restoring
    this.lastError = null
    this.lastBackup = null // { name, at, sizeBytes }
  }

  storagesPath() { return join(this.home, 'storages') }
  sessionsPath() { return join(this.home, 'sessions') }
  attachmentsPath() { return join(this.home, 'attachments') }

  /** Snapshot for GET /launcher-backup/status (JSON-safe by construction). */
  status() {
    return {
      supported: this.supported,
      phase: this.phase,
      lastError: this.lastError,
      lastBackup: this.lastBackup,
      storagesBytes: this.supported ? bytesOf(this.storagesPath()) : 0,
      sessionsBytes: this.supported ? bytesOf(this.sessionsPath()) : 0,
      attachmentsBytes: this.supported ? bytesOf(this.attachmentsPath()) : 0,
      backups: this.listBackups(),
    }
  }

  /** Local backup files, newest first. */
  listBackups() {
    if (this.backupDir === '' || !existsSync(this.backupDir)) return []
    return readdirSync(this.backupDir)
      .filter(name => name.endsWith('.tar.gz') && SAFE_NAME.test(name))
      .map((name) => {
        const stat = statSync(join(this.backupDir, name))
        return { name, sizeBytes: stat.size, at: stat.mtime.toISOString() }
      })
      .sort((a, b) => (a.at < b.at ? 1 : -1))
  }

  /** Create a fresh backup archive of sessions/ + storages/ + attachments/. */
  async create() {
    if (!this.supported) throw new Error('备份功能仅在桌面启动器中可用')
    if (this.phase !== 'idle') throw new Error('已有备份/还原任务在进行中')
    this.phase = 'creating'
    this.lastError = null
    const infoFile = join(this.home, '.backup-info-tmp.json')
    try {
      mkdirSync(this.backupDir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const name = `chat-backup-${stamp}.tar.gz`
      const target = join(this.backupDir, name)
      const included = CHAT_DIRS.filter(dir => existsSync(join(this.home, dir)))
      const info = {
        format: 'dsh-desktop-chat-backup',
        createdAt: new Date().toISOString(),
        included,
        storagesBytes: bytesOf(this.storagesPath()),
        sessionsBytes: bytesOf(this.sessionsPath()),
        attachmentsBytes: bytesOf(this.attachmentsPath()),
      }
      // Stage the manifest inside home and rename it inside the archive
      // (BSD tar's -s substitution, macOS-native).
      writeFileSync(infoFile, `${JSON.stringify(info, null, 2)}\n`)
      await runTar([
        '-czf', target, '-C', this.home,
        '-s', `|^\\.backup-info-tmp\\.json$|${BACKUP_INFO}|`,
        '.backup-info-tmp.json', ...included,
      ])
      this.lastBackup = { name, at: new Date().toISOString(), sizeBytes: statSync(target).size }
      return { ...this.lastBackup, ...info }
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      throw error
    } finally {
      rmSync(infoFile, { force: true })
      this.phase = 'idle'
    }
  }

  /** Resolve one local backup archive to its absolute path. */
  resolveBackup(name) {
    if (!SAFE_NAME.test(name)) throw new Error('非法备份文件名')
    const path = join(this.backupDir, name)
    if (!existsSync(path)) throw new Error('备份不存在')
    return path
  }

  /** Validate an archive: readable, safe entries, and a backup-info manifest. */
  async validateArchive(path) {
    const entries = await listTar(path)
    assertSafeListing(entries)
    const roots = new Set(entries.map(entry => entry.split('/')[0]).filter(part => part !== ''))
    if (!roots.has(BACKUP_INFO) && !roots.has('storages')) {
      throw new Error(`归档不是聊天记录备份（缺少 ${BACKUP_INFO} 或 storages/）：${[...roots].join(', ').slice(0, 120) || '(空)'}`)
    }
    return entries
  }

  /**
   * Restore from a local backup or an uploaded archive, then restart the
   * harness. Steps: validate → extract to a staging dir → snapshot current
   * records aside (`*.pre-restore`) → atomically move the staged dirs into
   * place → exit 42 so the shell reboots the harness over the restored data.
   * @param options.file - local backup name; options.base64 - uploaded archive.
   */
  async restore(options = {}) {
    if (!this.supported) throw new Error('还原功能仅在桌面启动器中可用')
    if (this.phase !== 'idle') throw new Error('已有备份/还原任务在进行中')
    this.phase = 'restoring'
    this.lastError = null
    const upload = join(this.dataDir, '.restore-upload.tar.gz')
    const staging = join(this.dataDir, '.restore-staging')
    try {
      let source = null
      if (typeof options.file === 'string' && options.file !== '') {
        source = this.resolveBackup(options.file)
      } else if (typeof options.base64 === 'string' && options.base64 !== '') {
        if (options.base64.length > 768 * 1024 * 1024) throw new Error('备份文件过大（上限 512MB）')
        const raw = Buffer.from(options.base64, 'base64')
        if (raw.length === 0) throw new Error('备份文件为空')
        mkdirSync(this.dataDir, { recursive: true })
        writeFileSync(upload, raw)
        source = upload
      } else {
        throw new Error('请选择本地备份或上传备份文件')
      }

      await this.validateArchive(source)

      rmSync(staging, { recursive: true, force: true })
      mkdirSync(staging, { recursive: true })
      await runTar(['-xzf', source, '-C', staging])

      // Archive root holds the dirs directly (validated above).
      const stagedBase = staging

      // Snapshot current records aside for manual recovery, then swap.
      for (const dir of CHAT_DIRS) {
        const current = join(this.home, dir)
        const incoming = join(stagedBase, dir)
        const snapshot = `${current}.pre-restore`
        if (!existsSync(incoming)) continue
        rmSync(snapshot, { recursive: true, force: true })
        if (existsSync(current)) renameSync(current, snapshot)
        renameSync(incoming, current)
      }

      this.phase = 'restarting'
      setTimeout(() => { process.exit(RESTART_EXIT_CODE) }, 500)
      return { ok: true, restarting: true }
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      this.phase = 'idle'
      throw error
    } finally {
      rmSync(upload, { force: true })
      rmSync(staging, { recursive: true, force: true })
    }
  }

  /** Delete one local backup archive. */
  deleteBackup(name) {
    if (this.backupDir === '') throw new Error('备份功能仅在桌面启动器中可用')
    const path = this.resolveBackup(name)
    rmSync(path, { force: true })
    return this.status()
  }
}
