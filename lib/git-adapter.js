/**
 * dsh-retrace — GitAdapter (PLAN.md §4.4).
 *
 * All git activity rides the host subprocess seam (`ctx.subprocess`):
 * read-only commands (`rev-parse`, `status`, `ls-tree`) run freely; write
 * commands (`init`, `update-ref`, `checkout`, the one-time initial commit)
 * are only ever issued from user-confirmed flows (one-click init, artifact
 * rollback). Nothing here touches the working tree directly — every file
 * change goes through `ctx.fs` (workspace sandbox) or `git checkout` with a
 * strict path allow-list.
 *
 * The adapter is transport-shaped for tests: the caller injects `run` (one
 * spawn spec in → one outcome out) and `writeText` (workspace sandbox write),
 * so the test suite exercises the full decision logic with a fake runner
 * instead of a real git binary.
 */

import { isAbsolute, join, relative, resolve } from 'node:path'

/** Minimal `.gitignore` written by the one-click init (never touches user files). */
export const MINIMAL_GITIGNORE = [
  '# created by dsh-retrace (one-click git init) — remove freely',
  'node_modules/',
  'dist/',
  '*.log',
  '',
].join('\n')

const SPILL_LIMIT = 256 * 1024

/** Run-spec → outcome shim over the real host subprocess seam. */
export function createSubprocessRunner(ctx, log = () => {}) {
  const command = async (argv, cwd, signal) => {
    const git = await ctx.subprocess.resolveExecutable('git')
    const handle = ctx.subprocess.spawn({
      argv: [git, ...argv],
      cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 256 * 1024, spill: { maxBytes: SPILL_LIMIT } },
        stderr: { maxBytes: 256 * 1024, spill: { maxBytes: SPILL_LIMIT } },
      },
      graceMs: 30_000,
      signal,
      env: {},
    })
    const outcome = await handle.done
    const collected = handle.collected
    const read = (reader) => {
      const value = reader.readFrom(0)
      return value.text ?? ''
    }
    return {
      ok: outcome.exitCode === 0,
      exitCode: outcome.exitCode,
      stdout: read(collected.stdout),
      stderr: read(collected.stderr),
    }
  }
  const writeText = async (target, content, sandboxPolicy) => {
    await ctx.fs.writeText(target, content, undefined, undefined, sandboxPolicy)
  }
  return { command, writeText }
}

/**
 * Create the git adapter.
 * @param {object} deps
 * @param {(argv: string[], cwd: string, signal?: AbortSignal) => Promise<{ok:boolean, exitCode?:number, stdout:string, stderr:string}>} deps.command
 * @param {(target: string, content: string, sandboxPolicy: any) => Promise<void>} deps.writeText — workspace sandbox write (one-click init's .gitignore).
 * @param {(line: string) => void} [deps.log]
 */
export function createGitAdapter({ command, writeText, log = () => {} }) {
  /** Detect the enclosing repository root from `cwd` (outer repos included). */
  async function detect(cwd) {
    if (typeof cwd !== 'string' || cwd.length === 0) return null
    const run = await command(['rev-parse', '--show-toplevel'], cwd)
    if (!run.ok) return null
    const root = run.stdout.trim()
    return root.length > 0 ? root : null
  }

  /**
   * Read-only repo status at `cwd`: HEAD hash + dirty flag + porcelain paths.
   * Returns null when `cwd` is not inside a repository.
   */
  async function status(cwd, signal) {
    if (typeof cwd !== 'string' || cwd.length === 0) return null
    const run = await command(['rev-parse', '--show-toplevel'], cwd, signal)
    if (!run.ok) return null
    const root = run.stdout.trim()
    if (root.length === 0) return null
    const head = await command(['rev-parse', 'HEAD'], cwd, signal)
    if (!head.ok) return { root, headHash: null, dirty: false, paths: [] }
    const headHash = head.stdout.trim()
    const dirtyRun = await command(['status', '--porcelain'], cwd, signal)
    const paths = dirtyRun.ok
      ? dirtyRun.stdout.split('\n').map((line) => line.replace(/^.../, '')).filter((p) => p.length > 0)
      : []
    return { root, headHash, dirty: paths.length > 0, paths }
  }

  /** Files present at `headHash` among `paths` (rollback allow-list pre-filter). */
  async function presentAt(cwd, headHash, paths, signal) {
    if (paths.length === 0) return []
    const run = await command(['ls-tree', '-r', '--name-only', headHash, '--', ...paths], cwd, signal)
    if (!run.ok) return []
    const present = new Set(run.stdout.split('\n').filter((p) => p.length > 0))
    return paths.filter((p) => present.has(p))
  }

  /** Guard every path: relative, inside cwd, no `..` escape, not absolute. */
  function guardPaths(cwd, paths) {
    const base = resolve(cwd)
    const safe = []
    for (const path of paths) {
      if (typeof path !== 'string' || path.length === 0) continue
      if (isAbsolute(path)) continue
      const resolved = resolve(base, path)
      const rel = relative(base, resolved)
      if (rel.startsWith('..') || isAbsolute(rel)) continue
      safe.push(rel)
    }
    return safe
  }

  /**
   * Roll `paths` back to their content at `headHash` (`git checkout <hash> -- <paths>`).
   * Only paths present at the commit are touched; absent ones are no-ops.
   * @returns {{ok: boolean, checked: string[], skipped: string[], stderr?: string}}
   */
  async function checkout(cwd, headHash, paths, signal) {
    const safe = guardPaths(cwd, paths)
    if (safe.length === 0) return { ok: true, checked: [], skipped: [] }
    const present = await presentAt(cwd, headHash, safe, signal)
    const skipped = safe.filter((p) => !present.includes(p))
    if (present.length === 0) return { ok: true, checked: [], skipped }
    const run = await command(['checkout', headHash, '--', ...present], cwd, signal)
    if (!run.ok) {
      log(`retrace: git checkout failed: ${run.stderr.trim()}`)
      return { ok: false, checked: [], skipped: safe, stderr: run.stderr }
    }
    return { ok: true, checked: present, skipped }
  }

  /**
   * One-click init for a non-repository workspace: `git init` + minimal
   * `.gitignore` + a baseline commit + the `refs/dsh/versions` ref (the
   * plugin's own ref; the default branch is only touched by the baseline
   * commit). Deleting `refs/dsh/versions` afterwards restores the pre-plugin
   * git state (the baseline commit and .gitignore remain).
   * @returns {{ok: boolean, root: string, headHash?: string, stderr?: string}}
   */
  async function init(cwd, signal) {
    const base = resolve(cwd)
    const initRun = await command(['init', '-q'], base, signal)
    if (!initRun.ok) return { ok: false, root: base, stderr: initRun.stderr }
    const gitignoreTarget = join(base, '.gitignore')
    try {
      await writeText(gitignoreTarget, MINIMAL_GITIGNORE, undefined)
    } catch (error) {
      return { ok: false, root: base, stderr: String(error) }
    }
    const add = await command(['add', '.gitignore'], base, signal)
    if (!add.ok) return { ok: false, root: base, stderr: add.stderr }
    const commit = await command(['commit', '-q', '-m', 'chore(dsh-retrace): initialize version tracking'], base, signal)
    if (!commit.ok) return { ok: false, root: base, stderr: commit.stderr }
    const head = await command(['rev-parse', 'HEAD'], base, signal)
    const headHash = head.ok ? head.stdout.trim() : undefined
    if (headHash) {
      await command(['update-ref', 'refs/dsh/versions', headHash], base, signal)
    }
    return { ok: true, root: base, headHash }
  }

  return { detect, status, checkout, init }
}
