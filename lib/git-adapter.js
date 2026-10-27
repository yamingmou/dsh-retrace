/**
 * dsh-retrace — GitAdapter ().
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
/** 把缺失的条目追加到已有 .gitignore 末尾（不覆盖用户内容）。 */
export function mergeGitignore(existing) {
  if (typeof existing !== 'string' || existing.trim() === '') return MINIMAL_GITIGNORE
  const have = new Set(existing.split('\n').map((l) => l.trim()).filter(Boolean))
  const missing = MINIMAL_GITIGNORE.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !have.has(l))
  if (!missing.length) return existing
  const sep = existing.endsWith('\n') ? '' : '\n'
  return existing + sep + '# added by dsh-retrace (one-click git init)\n' + missing.join('\n') + '\n'
}

export const MINIMAL_GITIGNORE = [
  '# created by dsh-retrace (one-click git init) — remove freely',
  'node_modules/',
  'dist/',
  '*.log',
  '',
].join('\n')

const SPILL_LIMIT = 256 * 1024

/** git 二进制"不在"（ENOENT）⇒ 视为非仓，而不是把宿主异常冒泡成 500/internal。 */
function isGitMissing(error) {
  if (error && typeof error === 'object' && error.code === 'ENOENT') return true
  return /ENOENT|cannot find .*git|executable.*not found/i.test(String(error?.message ?? error))
}

/** 文件"不存在"类错误 ⇒ 可安全新建；其余读失败一律当"状态未知"（禁写）。 */
function isMissingFile(error) {
  if (error && typeof error === 'object' && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return true
  return /ENOENT|ENOTDIR|no such file|not found|does not exist|不存在/i.test(String(error?.message ?? error))
}

/** Run-spec → outcome shim over the real host subprocess seam. */
export function createSubprocessRunner(ctx, log = () => {}) {
  const command = async (argv, cwd, signal) => {
    try {
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
    } catch (error) {
      // 护栏③：git 缺失（resolveExecutable/spawn 的 ENOENT）⇒ 报"命令失败"，
      // 上层据此"视为非仓"（status ⇒ null / init ⇒ 干净失败），绝不冒泡。
      if (!isGitMissing(error)) throw error
      log(`retrace: git executable unavailable: ${String(error?.message ?? error)}`)
      return { ok: false, exitCode: 127, stdout: '', stderr: `git executable unavailable: ${String(error?.message ?? error)}` }
    }
  }
  const writeText = async (target, content, sandboxPolicy) => {
    try {
      await ctx.fs.writeText(target, content, undefined, undefined, sandboxPolicy)
    } catch (error) {
      // 兼容：部分宿主实现要求 Uint8Array（历史 bug: string ⇒ "reading 'trim'"）
      if (!(error && /trim|readonly|Uint8/i.test(String(error)))) throw error
      await ctx.fs.writeText(target, new TextEncoder().encode(content), undefined, undefined, sandboxPolicy)
    }
  }
  // 可选读接口（**三态**，0.4.135 特性② 护栏② 生产接线）：宿主暴露 readText/read
  // 时用于"追加而非覆盖"。返回值语义：
  //   string    = 读到了现有内容；
  //   null      = 明确"文件不存在"（读口报 ENOENT 类）⇒ 可以安全新建；
  //   undefined = **状态未知**（宿主无读接口 / 读失败原因不明）⇒ 上层禁写 .gitignore
  //               （宁可不建，不可覆盖用户已有文件 —— 没有这三态时，"无读接口"与
  //               "读到 null"同值 ⇒ 一律写 MINIMAL，正是要修的覆盖缺陷）。
  const readText = async (target) => {
    const fn = ctx.fs?.readText ?? ctx.fs?.read
    if (typeof fn !== 'function') return undefined
    try {
      const value = await fn.call(ctx.fs, target)
      if (typeof value === 'string') return value
      if (value && typeof value.text === 'string') return value.text
      if (value instanceof Uint8Array) return new TextDecoder().decode(value)
      return undefined
    } catch (error) {
      return isMissingFile(error) ? null : undefined
    }
  }
  return { command, writeText, readText }
}

/**
 * Create the git adapter.
 * @param {object} deps
 * @param {(argv: string[], cwd: string, signal?: AbortSignal) => Promise<{ok:boolean, exitCode?:number, stdout:string, stderr:string}>} deps.command
 * @param {(target: string, content: string, sandboxPolicy: any) => Promise<void>} deps.writeText — workspace sandbox write (one-click init's .gitignore).
 * @param {(line: string) => void} [deps.log]
 */
export function createGitAdapter({ command, writeText, readText = null, log = () => {} }) {
  /** 写文本；若宿主报 string 类型问题（历史 bug: "reading 'trim'"）⇒ 用 Uint8Array 重试一次。 */
  async function writeTextResilient(target, content, policy) {
    try { return await writeText(target, content, policy) }
    catch (error) {
      if (!/trim|readonly|Uint8/i.test(String(error))) throw error
      return await writeText(target, new TextEncoder().encode(content), policy)
    }
  }
  /** Detect the enclosing repository root from `cwd` (outer repos included). */
  async function detect(cwd, signal) {
    if (typeof cwd !== 'string' || cwd.length === 0) return null
    const run = await command(['rev-parse', '--show-toplevel'], cwd, signal)
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
   *
   * 三护栏（0.4.135 特性②）：
   *  ① detect 前置 —— 已在仓（外层仓也算）⇒ **不执行 init**，返回明确状态
   *    `{ok:false, alreadyRepo:true, reason:'already-repository', root}`;
   *  ② readText 缺席 ⇒ 看不见已有 .gitignore ⇒ **一个字节都不写**（宁可不建，
   *    不可覆盖用户文件）；写过才 `git add .gitignore`;
   *  ③ git 缺失（ENOENT）⇒ 按"非仓"干净失败（`ok:false`），不抛。
   * @returns {{ok: boolean, root: string, headHash?: string, alreadyRepo?: boolean, reason?: string, stderr?: string}}
   */
  async function init(cwd, signal) {
    const base = resolve(cwd)
    // 护栏①：先问"是不是已经在仓里"（外层仓也算）——已在仓 ⇒ 绝不 init。
    const inRepo = await detect(base, signal)
    if (inRepo) return { ok: false, root: inRepo, alreadyRepo: true, reason: 'already-repository' }
    const initRun = await command(['init', '-q'], base, signal)
    if (!initRun.ok) return { ok: false, root: base, stderr: initRun.stderr }
    // 护栏②：只有**确知现状**（读到内容 / 明确"文件不存在"）时才敢动 .gitignore；
    // 状态未知（宿主无读接口、读失败原因不明 ⇒ readText 回 undefined）⇒ 一个字节都
    // 不写、也不 add（宁可不建，不可覆盖用户已有文件）。
    if (typeof readText === 'function') {
      const gitignoreTarget = join(base, '.gitignore')
      let existing
      try {
        existing = await readText(gitignoreTarget)
      } catch {
        existing = undefined // 读抛错 ⇒ 状态未知 ⇒ 禁写
      }
      if (existing !== undefined) {
        const desired = mergeGitignore(existing)
        if (desired !== existing) {
          try {
            await writeTextResilient(gitignoreTarget, desired, undefined)
          } catch (error) {
            return { ok: false, root: base, stderr: `write .gitignore failed: ${String(error)}` }
          }
          const add = await command(['add', '.gitignore'], base, signal)
          if (!add.ok) return { ok: false, root: base, stderr: add.stderr }
        }
      }
    }
    const identityArgs = ['-c', 'user.name=dsh-retrace', '-c', 'user.email=retrace@localhost']
    let commit = await command([...identityArgs, 'commit', '-q', '--allow-empty', '-m', 'chore(dsh-retrace): initialize version tracking'], base, signal)
    if (!commit.ok) {
      // 回退：某些环境下不支持 -c 前置参数 ⇒ 再试一次最朴素形态
      commit = await command(['commit', '-q', '--allow-empty', '-m', 'chore(dsh-retrace): initialize version tracking'], base, signal)
    }
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
