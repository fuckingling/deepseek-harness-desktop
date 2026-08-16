/**
 * Orchestrate the full build: runtime → icon → app → dmg, forwarding the
 * SAME flags to every step.
 *
 * Why this wrapper exists: `npm run build -- --flag x` appends the extra
 * args only to the LAST command of a chained npm script, so flags like
 * --update-feed would never reach build-runtime.mjs (which bakes them into
 * runtime/harness.json). Each step parses only the flags it understands and
 * ignores the rest.
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { ROOT } from './lib/util.mjs'

const steps = ['build-runtime.mjs', 'make-icon.mjs', 'build-app.mjs', 'build-dmg.mjs']
const args = process.argv.slice(2)

for (const step of steps) {
  console.log(`\n=== build: node scripts/${step} ${args.join(' ')} ===`)
  const child = spawn(process.execPath, [join(ROOT, 'scripts', step), ...args], { stdio: 'inherit' })
  const code = await new Promise(resolve => child.on('exit', resolve))
  if (code !== 0) process.exit(code ?? 1)
}
console.log('\nbuild: all steps done')
