/**
 * GitAdapter unit tests — the adapter is transport-shaped: `command` and
 * `writeText` are injected, so every decision path (detect / status /
 * checkout guards / init sequence) is exercised with a fake runner instead of
 * a real git binary.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createGitAdapter, MINIMAL_GITIGNORE } from '../lib/git-adapter.js'

/** Build a fake runner with canned per-argv-prefix responses. */
function fakeRunner(routes) {
  const calls = []
  const command = vi.fn(async (argv, cwd) => {
    calls.push({ argv, cwd })
    for (const route of routes) {
      if (argv.every((part, i) => part === route.argv[i])) {
        return { ok: route.ok ?? true, exitCode: route.ok === false ? 1 : 0, stdout: route.stdout ?? '', stderr: route.stderr ?? '' }
      }
    }
    return { ok: false, exitCode: 1, stdout: '', stderr: 'unexpected: ' + argv.join(' ') }
  })
  return { command, calls }
}

const writeText = vi.fn(async () => {})
beforeEach(() => writeText.mockClear())

describe('git adapter detect', () => {
  it('returns the repository root inside a repository', async () => {
    const { command } = fakeRunner([{ argv: ['rev-parse', '--show-toplevel'], stdout: '/work/repo\n' }])
    const git = createGitAdapter({ command, writeText })
    await expect(git.detect('/work/repo/src')).resolves.toBe('/work/repo')
  })

  it('returns null outside a repository', async () => {
    const { command } = fakeRunner([{ argv: ['rev-parse', '--show-toplevel'], ok: false, stderr: 'fatal: not a git repository' }])
    const git = createGitAdapter({ command, writeText })
    await expect(git.detect('/work/plain')).resolves.toBeNull()
  })

  it('returns null for an empty cwd', async () => {
    const git = createGitAdapter({ command: vi.fn(), writeText })
    await expect(git.detect('')).resolves.toBeNull()
  })
})

describe('git adapter status', () => {
  it('parses HEAD + porcelain paths', async () => {
    const { command } = fakeRunner([
      { argv: ['rev-parse', '--show-toplevel'], stdout: '/work/repo\n' },
      { argv: ['rev-parse', 'HEAD'], stdout: 'abc123\n' },
      { argv: ['status', '--porcelain'], stdout: ' M src/a.ts\n?? new.txt\n' },
    ])
    const git = createGitAdapter({ command, writeText })
    await expect(git.status('/work/repo')).resolves.toEqual({
      root: '/work/repo',
      headHash: 'abc123',
      dirty: true,
      paths: ['src/a.ts', 'new.txt'],
    })
  })

  it('treats an unborn HEAD (no commits yet) as clean with null hash', async () => {
    const { command } = fakeRunner([
      { argv: ['rev-parse', '--show-toplevel'], stdout: '/work/repo\n' },
      { argv: ['rev-parse', 'HEAD'], ok: false, stderr: 'fatal: ambiguous argument' },
    ])
    const git = createGitAdapter({ command, writeText })
    await expect(git.status('/work/repo')).resolves.toEqual({
      root: '/work/repo',
      headHash: null,
      dirty: false,
      paths: [],
    })
  })
})

describe('git adapter checkout', () => {
  it('rejects absolute paths and .. escapes, and skips paths absent at the commit', async () => {
    const { command } = fakeRunner([
      { argv: ['ls-tree', '-r', '--name-only', 'abc123', '--', 'src/a.ts', 'missing.ts'], stdout: 'src/a.ts\n' },
      { argv: ['checkout', 'abc123', '--', 'src/a.ts'], stdout: '' },
    ])
    const git = createGitAdapter({ command, writeText })
    const outcome = await git.checkout('/work/repo', 'abc123', ['src/a.ts', '/etc/passwd', '../escape.txt', 'missing.ts'])
    expect(outcome.ok).toBe(true)
    expect(outcome.checked).toEqual(['src/a.ts'])
    expect(outcome.skipped).toEqual(['missing.ts'])
    const checkoutCall = command.mock.calls.find(([argv]) => argv[0] === 'checkout')
    expect(checkoutCall[0]).toEqual(['checkout', 'abc123', '--', 'src/a.ts'])
  })

  it('returns failed on a checkout error', async () => {
    const { command } = fakeRunner([
      { argv: ['ls-tree', '-r', '--name-only', 'abc123', '--', 'src/a.ts'], stdout: 'src/a.ts\n' },
      { argv: ['checkout', 'abc123', '--', 'src/a.ts'], ok: false, stderr: 'error: pathspec' },
    ])
    const git = createGitAdapter({ command, writeText })
    const outcome = await git.checkout('/work/repo', 'abc123', ['src/a.ts'])
    expect(outcome.ok).toBe(false)
    expect(outcome.checked).toEqual([])
  })
})

describe('git adapter init', () => {
  it('runs the full init sequence and records refs/dsh/versions', async () => {
    const { command } = fakeRunner([
      { argv: ['init', '-q'], stdout: '' },
      { argv: ['add', '.gitignore'], stdout: '' },
      { argv: ['commit', '-q', '-m', 'chore(dsh-retrace): initialize version tracking'], stdout: '' },
      { argv: ['rev-parse', 'HEAD'], stdout: 'deadbeef\n' },
      { argv: ['update-ref', 'refs/dsh/versions', 'deadbeef'], stdout: '' },
    ])
    const git = createGitAdapter({ command, writeText })
    const outcome = await git.init('/work/plain')
    expect(outcome.ok).toBe(true)
    expect(outcome.headHash).toBe('deadbeef')
    expect(writeText).toHaveBeenCalledWith('/work/plain/.gitignore', MINIMAL_GITIGNORE, undefined)
    expect(command.mock.calls.map(([argv]) => argv[0])).toEqual(['init', 'add', 'commit', 'rev-parse', 'update-ref'])
  })

  it('aborts cleanly when git init fails', async () => {
    const { command } = fakeRunner([{ argv: ['init', '-q'], ok: false, stderr: 'permission denied' }])
    const git = createGitAdapter({ command, writeText })
    await expect(git.init('/work/plain')).resolves.toMatchObject({ ok: false })
    expect(writeText).not.toHaveBeenCalled()
  })
})
