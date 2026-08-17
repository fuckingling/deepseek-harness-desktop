/**
 * Slash the harness runtime's node_modules footprint without touching
 * anything plain Node can load at runtime.
 *
 * Everything removed here is provably dead weight for the shipped product:
 *
 *   - source maps (*.map)           — only used by devtools/stack traces
 *   - type declarations (*.d.ts)    — never loaded by plain Node
 *   - TS sources (.ts/.tsx/.mts/.cts under src/) — deleted only when the
 *                                     package also ships a compiled
 *                                     dist/lib, and only TYPE files are
 *                                     touched: runtime .js/.mjs/.cjs inside
 *                                     src/ (koffi ships its runtime there)
 *                                     is always kept
 *   - tests / docs / examples …     — never imported at runtime
 *   - platform fallbacks            — wasm fallback for sharp, non-darwin
 *                                     prebuilds/reflink binaries: this
 *                                     runtime only ever runs on macOS
 *   - hand-audited package fat      — duplicate build formats, package-
 *                                     manager docs, polyfill variants nobody
 *                                     imports (verified against the
 *                                     installed dependency graph)
 *
 * The function is deliberately conservative: an allowlist of generic junk
 * patterns plus an explicit, commented denylist of package paths. A prune
 * target that no longer exists (dsh changed its layout) logs a note instead
 * of failing the build.
 *
 * Usage: await pruneHarnessNodeModules(harnessDir, log)
 */

import { rm, readdir, stat as statFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Entries of a directory that are junk in EVERY package at the package root. */
const JUNK_DIRS = new Set([
  '.github', '.circleci', '.nyc_output', 'coverage',
  'test', 'tests', '__tests__', 'spec', 'specs',
  'docs', 'doc', 'examples', 'example', 'benchmark', 'benchmarks',
  'man',
])

/**
 * Explicit package-relative removals, each with the audit reason.
 * Paths are relative to node_modules/.
 */
const PRUNE_TARGETS = [
  {
    path: '@img/sharp-wasm32',
    reason: 'sharp WebAssembly fallback — the darwin-arm64 native binding is installed; wasm only loads when every platform binding is missing',
  },
  {
    path: 'web-streams-polyfill/dist',
    keep: ['ponyfill.es2018.js'],
    reason: 'only consumer is fetch-blob, which deep-imports dist/ponyfill.es2018.js; the es6/ponyfill/polyfill × js/mjs × map matrix is dead weight',
  },
  {
    path: '@opentelemetry/semantic-conventions/build/esnext',
    reason: 'the "esnext" export condition is a bundler-only format; Node resolves module→esm / default→src',
  },
  {
    path: 'npm/docs',
    reason: 'npm CLI documentation — never read at runtime',
  },
  {
    path: 'npm/man',
    reason: 'npm CLI man pages — never read at runtime',
  },
  {
    path: '@mistralai/mistralai/examples',
    reason: 'SDK examples — never imported',
  },
]

/**
 * Delete a directory tree and return the byte count freed.
 */
async function removeTree(path) {
  const size = await treeSize(path)
  await rm(path, { recursive: true, force: true })
  return size
}

/**
 * Sum the size of a path (file or directory), following no symlinks.
 */
async function treeSize(path) {
  try {
    const s = await statFile(path)
    if (s.isFile()) return s.size
    if (!s.isDirectory()) return 0
  } catch {
    return 0
  }
  let total = 0
  try {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      total += await treeSize(join(path, entry.name))
    }
  } catch { /* raced removal */ }
  return total
}

async function pruneExplicitTargets(nodeModules, log, freed) {
  for (const target of PRUNE_TARGETS) {
    const targetPath = join(nodeModules, target.path)
    try {
      if (!(await statFile(targetPath)).isDirectory()) continue
    } catch {
      log(`prune: skip ${target.path} (not present — ${target.reason})`)
      continue
    }
    if (target.keep === undefined) {
      const bytes = await removeTree(targetPath)
      freed.total += bytes
      log(`prune: -${(bytes / 1024 / 1024).toFixed(1)} MB  ${target.path}  (${target.reason})`)
      continue
    }
    // Keep a fixed file list, remove everything else inside the dir.
    let bytes = 0
    for (const entry of await readdir(targetPath, { withFileTypes: true })) {
      if (target.keep.includes(entry.name)) continue
      bytes += await removeTree(join(targetPath, entry.name))
    }
    if (bytes > 0) {
      freed.total += bytes
      log(`prune: -${(bytes / 1024 / 1024).toFixed(1)} MB  ${target.path} (kept ${target.keep.join(', ')} — ${target.reason})`)
    }
  }
}

/** List package dirs: node_modules/<name> and node_modules/@<scope>/<name>. */
async function packageDirs(nodeModules) {
  const packages = []
  for (const entry of await readdir(nodeModules, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    if (!entry.isDirectory()) continue
    const path = join(nodeModules, entry.name)
    if (entry.name.startsWith('@')) {
      for (const scoped of await readdir(path, { withFileTypes: true })) {
        if (scoped.isDirectory()) packages.push(join(path, scoped.name))
      }
    } else {
      packages.push(path)
    }
  }
  return packages
}

/**
 * Platform pruning: native prebuilds/binaries for platforms this macOS
 * runtime can never run.
 *
 *   - <pkg>/prebuilds/<platform>/…   keep only darwin-* entries
 *   - <pkg>/third_party              Windows ConPTY sources etc.
 *   - reflink.{linux,win32,darwin-x64}*.node   pnpm's copy-on-write helper
 */
async function pruneForeignPlatformFiles(pkg, freed) {
  const rel = pkg.slice(pkg.indexOf('node_modules') + 'node_modules/'.length)

  try {
    if ((await statFile(join(pkg, 'prebuilds'))).isDirectory()) {
      for (const entry of await readdir(join(pkg, 'prebuilds'), { withFileTypes: true })) {
        if (entry.name.startsWith('darwin-')) continue
        const bytes = await removeTree(join(pkg, 'prebuilds', entry.name))
        if (bytes > 0) {
          freed.total += bytes
          freed.details.push(`${rel}/prebuilds/${entry.name} ${(bytes / 1024 / 1024).toFixed(2)}MB`)
        }
      }
    }
  } catch { /* no prebuilds */ }

  try {
    if ((await statFile(join(pkg, 'third_party'))).isDirectory()) {
      const bytes = await removeTree(join(pkg, 'third_party'))
      if (bytes > 0) {
        freed.total += bytes
        freed.details.push(`${rel}/third_party ${(bytes / 1024 / 1024).toFixed(2)}MB`)
      }
    }
  } catch { /* no third_party */ }

  await walkAndRemove(pkg, path => {
    const name = path.slice(path.lastIndexOf('/') + 1)
    if (name.startsWith('reflink.') && !name.startsWith('reflink.darwin-arm64')) return 'foreign-binary'
    return null
  }, freed)
}

/**
 * Remove source maps, type declarations, TS sources, junk directories, and
 * foreign-platform binaries across every package.
 */
async function pruneGeneric(nodeModules, log, freed) {
  const packages = await packageDirs(nodeModules)
  for (const pkg of packages) {
    const rel = pkg.slice(nodeModules.length + 1)

    // Junk dirs at the package root.
    for (const junk of JUNK_DIRS) {
      try {
        if (!(await statFile(join(pkg, junk))).isDirectory()) continue
      } catch {
        continue
      }
      const bytes = await removeTree(join(pkg, junk))
      if (bytes > 0) {
        freed.total += bytes
        freed.details.push(`${rel}/${junk} ${(bytes / 1024 / 1024).toFixed(1)}MB`)
      }
    }

    // TypeScript sources: delete .ts/.tsx/.mts/.cts files under src/ (plain
    // Node never loads them for packages that also ship compiled output),
    // but NEVER delete whole directories or any .js/.mjs/.cjs runtime file —
    // packages like koffi ship their runtime inside src/.
    const srcDir = join(pkg, 'src')
    const hasCompiledSibling = await Promise.all(['dist', 'lib', 'esm', 'cjs', 'build']
      .map(async name => {
        try { return (await statFile(join(pkg, name))).isDirectory() } catch { return false }
      })).then(results => results.some(Boolean))
    if (hasCompiledSibling) {
      let bytes = 0
      await walkFiles(srcDir, path => {
        const name = path.slice(path.lastIndexOf('/') + 1)
        if (/\.(ts|tsx|mts|cts)$/.test(name)) return 'ts-source'
        return null
      }, size => { bytes += size })
      if (bytes > 0) {
        freed.total += bytes
        freed.details.push(`${rel}/src(ts) ${(bytes / 1024 / 1024).toFixed(1)}MB`)
      }
    }

    // Source maps + type declarations + foreign native binaries.
    await walkAndRemove(pkg, path => {
      const name = path.slice(path.lastIndexOf('/') + 1)
      if (name.endsWith('.map') || name.endsWith('.d.ts') || name.endsWith('.d.mts') || name.endsWith('.d.cts')) return 'map-types'
      if (name.startsWith('reflink.') && !name.startsWith('reflink.darwin-arm64')) return 'foreign-binary'
      return null
    }, freed)

    await pruneForeignPlatformFiles(pkg, freed)
  }
}

/**
 * Recursively walk a directory; `classify` decides per-file removal, and
 * every removed file's byte count is reported through `onBytes`.
 * Missing directories and symlinks are skipped (nothing is followed).
 */
async function walkFiles(root, classify, onBytes) {
  let entries = []
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      await walkFiles(path, classify, onBytes)
      continue
    }
    if (classify(path) === null) continue
    try {
      const s = await statFile(path)
      await rm(path, { force: true })
      onBytes(s.size)
    } catch { /* raced deletion is fine */ }
  }
}

/**
 * Recursively walk a directory; `classify` decides per-file removal.
 */
async function walkAndRemove(root, classify, freed) {
  await walkFiles(root, classify, size => { freed.total += size })
}

/**
 * Prune the installed harness dependencies. Safe to re-run (idempotent).
 * @returns {Promise<number>} total bytes freed
 */
export async function pruneHarnessNodeModules(harnessDir, log = console.log) {
  const nodeModules = join(harnessDir, 'node_modules')
  const freed = { total: 0, details: [] }
  log('prune: trimming runtime node_modules …')
  await pruneExplicitTargets(nodeModules, log, freed)
  await pruneGeneric(nodeModules, log, freed)
  if (freed.details.length > 0) {
    log(`prune: generic junk removed (${freed.details.length} dirs) — ` +
      `${freed.details.slice(0, 12).join(', ')}${freed.details.length > 12 ? ` (+${freed.details.length - 12} more)` : ''}`)
  }
  log(`prune: freed ${(freed.total / 1024 / 1024).toFixed(1)} MB total`)
  return freed.total
}
