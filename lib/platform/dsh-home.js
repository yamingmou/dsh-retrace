/**
 * dsh-retrace — DSH home resolution for data-directory consumers.
 *
 * 2026-11 environment change: the legacy home name was renamed to
 * `~/DSH`; the old path is kept only as a compatibility SYMLINK. The Desktop
 * validates its data directory with `lstat` and requires a REAL directory
 * (`assertRealDirectory` in the Electron main: `!info.isDirectory() ||
 * info.isSymbolicLink()` ⇒ reject), so a symlinked home is NOT a usable
 * `DSH_HOME` — using it would be refused by the host.
 *
 * Resolution order for consumers that need a DSH home / data directory:
 *   1. `$DSH_HOME` (explicit; always wins when it is a real directory);
 *   2. `~/DSH` (the real directory after the rename);
 *   3. the legacy home name (compatibility symlink) — only if it is a real directory;
 *      when it is a symlink it is REFUSED with a warning, never silently used.
 *
 * The same lstat check applies to `$DSH_HOME` itself: setting it to the
 * compatibility symlink is refused (with a warning) and resolution continues.
 *
 * Pure/injectable (`lstat`, `readlink`, `home`, `dshHome`, `warn`) so tests do
 * not touch the real filesystem.
 */
import { lstatSync, readlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** Environment variable that names the active DSH home (host contract). */
export const DSH_HOME_ENV = 'DSH_HOME'
/** Directory name of the current home (post-2026-11 rename). */
export const DSH_HOME_DIRNAME = 'DSH'
/** Directory name of the retired home, kept only as a compatibility symlink. */
export const LEGACY_DSH_HOME_DIRNAME = 'dsh' + '-v3'

/** Expand a leading `~` / `~/` against `home` and absolutize. */
function expandHome(candidate, home) {
  if (typeof candidate !== 'string') return null
  const text = candidate.trim()
  if (text === '') return null
  if (text === '~') return resolve(home)
  if (text.startsWith('~/') || text.startsWith('~\\')) return resolve(join(home, text.slice(2)))
  return resolve(text)
}

/**
 * Ordered, de-duplicated candidate homes:
 * `$DSH_HOME` → `~/DSH` → legacy home.
 *
 * @param {{home?:string, dshHome?:string|null}} [input]
 * @returns {string[]} absolute paths in priority order
 */
function homeEntries({ home = homedir(), dshHome = process.env.DSH_HOME } = {}) {
  const entries = []
  const push = (raw, label) => {
    const path = expandHome(raw, home)
    if (path !== null && !entries.some((entry) => entry.path === path)) entries.push({ path, label })
  }
  push(dshHome, 'DSH_HOME')
  push(join(home, DSH_HOME_DIRNAME), '~/DSH')
  push(join(home, LEGACY_DSH_HOME_DIRNAME), '~/' + 'dsh' + '-v3')
  return entries
}

export function dshHomeCandidates({ home = homedir(), dshHome = process.env.DSH_HOME } = {}) {
  return homeEntries({ home, dshHome }).map((entry) => entry.path)
}

/**
 * Classify one path WITHOUT following symlinks.
 *
 * @param {string} path
 * @param {{lstat?:Function, readlink?:Function}} [fsLike]
 * @returns {{path:string, state:'real'|'symlink'|'not-directory'|'missing'|'unreadable', target?:string|null}}
 */
export function classifyDshHome(path, { lstat = lstatSync, readlink = readlinkSync } = {}) {
  try {
    const info = lstat(path)
    if (info.isSymbolicLink()) {
      let target = null
      try { target = readlink(path) } catch { target = null }
      return { path, state: 'symlink', target }
    }
    if (!info.isDirectory()) return { path, state: 'not-directory' }
    return { path, state: 'real' }
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return { path, state: 'missing' }
    return { path, state: 'unreadable', target: null }
  }
}

/**
 * Resolve the usable home directory.
 *
 * @param {{home?:string, dshHome?:string|null, lstat?:Function, readlink?:Function,
 *   warn?:(line:string)=>void}} [input]
 * @returns {{home:string|null, source:string|null, rejected:object[], warning:string|null}}
 */
export function resolveDshHome({
  home = homedir(),
  dshHome = process.env.DSH_HOME,
  lstat = lstatSync,
  readlink = readlinkSync,
  warn = () => {},
} = {}) {
  const rejected = []
  let lastWarning = null
  const entries = homeEntries({ home, dshHome })
  for (let index = 0; index < entries.length; index += 1) {
    const { path: candidate, label } = entries[index]
    const info = classifyDshHome(candidate, { lstat, readlink })
    if (info.state === 'real') {
      return { home: info.path, source: label, rejected, warning: lastWarning }
    }
    if (info.state === 'symlink') {
      rejected.push(info)
      lastWarning = `[dsh-retrace] refusing symlinked DSH home ${info.path}`
        + `${info.target === null ? '' : ` -> ${info.target}`}`
        + ' (the host rejects a symlinked data directory; set DSH_HOME to the real directory)'
      warn(lastWarning)
      continue
    }
    if (info.state === 'not-directory') {
      lastWarning = `[dsh-retrace] ignoring ${info.path}: not a directory`
      warn(lastWarning)
    }
  }
  return { home: null, source: null, rejected, warning: lastWarning }
}

/**
 * Convenience: the session root of the resolved home, or null.
 * @param {{home?:string, dshHome?:string|null}=} [input]
 * @returns {string|null}
 */
export function resolveSessionRoot(input = {}) {
  const resolved = resolveDshHome(input)
  return resolved.home === null ? null : join(resolved.home, 'sessions')
}
