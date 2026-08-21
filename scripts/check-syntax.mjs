/**
 * check-syntax — syntax-check every file under lib/ with esbuild's parser.
 *
 * `node --check a.js b.js` only validates its FIRST argument and silently
 * skips the rest (verified against Node 24), so the previous multi-file
 * `node --check` invocation was only ever checking lib/index.js. We use
 * esbuild's in-process transform (already a devDependency) instead of
 * spawning `node --check` per file: no child processes, works everywhere,
 * and fails the build on the first syntax error.
 */
import { transform } from 'esbuild'
import { readdirSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const files = []

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      walk(full)
    } else if (entry.endsWith('.js')) {
      files.push(full)
    }
  }
}

walk(join(root, 'lib'))

let failed = 0
for (const file of files) {
  try {
    await transform(await readFile(file, 'utf8'), {
      loader: 'js',
      format: 'esm',
      // Parse only — never executed, so no imports are resolved.
    })
  } catch (error) {
    failed += 1
    console.error(`check-syntax: ${file}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

if (failed > 0) {
  console.error(`check-syntax: ${failed} file(s) failed syntax check`)
  process.exit(1)
}
console.log(`check-syntax: ok (${files.length} files)`)
