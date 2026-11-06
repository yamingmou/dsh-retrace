/**
 * dsh-retrace — Undo store for artifact rollbacks (P0 data-safety).
 *
 * A rollback is the only path that writes user files. This module captures what
 * it is about to overwrite, **strictly before any write**, so a rollback can be
 * undone exactly once:
 *
 *   · bytes are content-addressed (`<root>/objects/<sha256[:2]>/<sha256>`), the
 *     same layout as artifact snapshots;
 *   · the ticket (`<root>/records/<undoId>.json`) carries, per file,
 *     `path + sha256|null + sizeBytes (+ version)`: `sha256:null` means the path
 *     did not exist before the rollback, so undoing it deletes the file again;
 *   · limits: at most 32 files / 16MB per ticket. Exceeding them **refuses the
 *     rollback** (`undo-limit`, surfaced by the caller) — never a silent
 *     truncation that would restore a wrong subset;
 *   · TTL: 30 minutes. An expired ticket is deleted on first use;
 *   · audit: every rollback/undo attempt appends one JSON line to
 *     `<root>/operations.jsonl` (`who` = sessionId, when, files, result).
 *
 * Everything is injectable (`root`, `now`) so unit tests do not touch the real
 * plugin data home.
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { appendFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { pluginDataHome } from './platform/session-paths.js'

/** A rollback captures at most this many files … */
export const UNDO_MAX_FILES = 32
/** … and at most this many bytes (16 MiB). */
export const UNDO_MAX_BYTES = 16 * 1024 * 1024
/** How long a ticket stays usable; the bytes are released with the record. */
export const UNDO_TTL_MS = 30 * 60_000

/**
 * One captured path.
 * `version` is the DSH fs stat version of the file **as the rollback left it**
 * (recorded after the write). Undo passes it back as `replaceIfVersion`, so an
 * edit that landed between rollback and undo makes the undo refuse (explicit
 * conflict) instead of silently discarding it. DSH fs versions are opaque
 * tokens (`"dev:ino:size:mtimeNs:ctimeNs"`) or numbers; both are accepted.
 */
export const undoEntrySchema = z.object({
  path: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  sizeBytes: z.number().int().nonnegative(),
  version: z.union([z.number().int().nonnegative(), z.string().min(1)]).nullable().optional(),
})

/** The persisted ticket. */
export const undoRecordSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  undoId: z.string().min(1),
  sessionId: z.string().min(1),
  versionId: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
  /** Files captured, in the order the rollback planned them. */
  entries: z.array(undoEntrySchema).min(1).max(UNDO_MAX_FILES),
})

/** Default `<pluginDataHome>/dsh-retrace/undo/` (same base as snapshots/backups). */
export function defaultUndoRoot() {
  return join(pluginDataHome(), 'dsh-retrace', 'undo')
}

/** sha256 hex of bytes (Buffer or Uint8Array). */
function digestBytes(data) {
  return createHash('sha256').update(data).digest('hex')
}

/** Bounded, fsync'd write helper: temp file + rename keeps a crash from leaving half JSON. */
async function writeFileDurable(path, data) {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Date.now().toString(36)}`
  await writeFile(tmp, data)
  await rename(tmp, path)
}

/**
 * Create a store instance.
 * @param {object} [options]
 * @param {string} [options.root] — storage root (defaults to the plugin data home)
 * @param {() => number} [options.now] — injectable clock (tests)
 * @param {(line: string) => void} [options.log]
 */
export function createUndoStore({ root = defaultUndoRoot(), now = () => Date.now(), log = () => {} } = {}) {
  const objectsRoot = join(root, 'objects')
  const recordsRoot = join(root, 'records')
  const auditPath = join(root, 'operations.jsonl')
  let counter = 0

  const objectPath = (sha256) => join(objectsRoot, sha256.slice(0, 2), sha256)
  const recordPath = (undoId) => join(recordsRoot, `${undoId}.json`)

  /** Save bytes content-addressed; dedup by sha. Returns metadata for the entry. */
  async function saveBytes(data) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
    const sha256 = digestBytes(bytes)
    const target = objectPath(sha256)
    if (existsSync(target)) {
      const stored = await readFile(target)
      if (digestBytes(stored) !== sha256) {
        throw new Error(`undo object integrity check failed for ${sha256}`)
      }
      return { sha256, sizeBytes: bytes.byteLength, existed: true }
    }
    await writeFileDurable(target, bytes)
    return { sha256, sizeBytes: bytes.byteLength, existed: false }
  }

  /** Read captured bytes back; verifies the content address (corruption is loud). */
  async function readBytes(sha256) {
    if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) {
      throw new Error(`invalid undo sha256: ${String(sha256)}`)
    }
    const data = new Uint8Array(await readFile(objectPath(sha256)))
    if (digestBytes(data) !== sha256) {
      throw new Error(`undo object integrity check failed for ${sha256}`)
    }
    return data
  }

  /** Persist a ticket (validated against `undoRecordSchema`; undeclared keys are rejected). */
  async function put(record) {
    const parsed = undoRecordSchema.parse({ schemaVersion: 1, ...record })
    await writeFileDurable(recordPath(parsed.undoId), `${JSON.stringify(parsed, null, 2)}\n`)
    return parsed
  }

  /**
   * Load one ticket. Expired tickets are deleted here (first use is enough —
   * the caller reports `undo-expired`); malformed records throw loudly rather
   * than being treated as "already used".
   * @returns {Promise<{record: object|null, expired: boolean}>}
   */
  async function get(undoId) {
    if (typeof undoId !== 'string' || undoId.length === 0) return { record: null, expired: false }
    let raw
    try {
      raw = await readFile(recordPath(undoId), 'utf8')
    } catch {
      return { record: null, expired: false }
    }
    const parsed = undoRecordSchema.parse(JSON.parse(raw))
    if (now() - parsed.createdAt > UNDO_TTL_MS) {
      await deleteRecord(undoId)
      return { record: null, expired: true }
    }
    return { record: parsed, expired: false }
  }

  /** Consume (delete) a ticket. Idempotent. */
  async function deleteRecord(undoId) {
    if (typeof undoId !== 'string' || undoId.length === 0) return
    try {
      await unlink(recordPath(undoId))
    } catch { /* already gone */ }
  }

  /** Read-only listing of live tickets (tests / diagnostics). */
  async function list() {
    const { readdir } = await import('node:fs/promises')
    let names
    try {
      names = await readdir(recordsRoot)
    } catch {
      return []
    }
    const out = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const undoId = name.slice(0, -'.json'.length)
      const { record } = await get(undoId)
      if (record !== null) out.push(record)
    }
    return out
  }

  /** New ticket id (stable shape tests can assert on). */
  function nextUndoId() {
    counter += 1
    return `undo-${now().toString(36)}-${counter}`
  }

  /**
   * Append one audit line. Auditing must never break the operation itself:
   * failures are reported through `log` and swallowed (the file system may be
   * read-only in odd deployments).
   */
  async function audit(event) {
    const line = JSON.stringify({
      at: now(),
      op: event.op,
      sessionId: event.sessionId ?? null,
      versionId: event.versionId ?? null,
      undoId: event.undoId ?? null,
      files: Array.isArray(event.files) ? event.files : [],
      ok: event.ok === true,
      result: event.result ?? null,
      failure: event.failure ?? null,
    })
    try {
      await mkdir(root, { recursive: true })
      await appendFile(auditPath, `${line}\n`)
    } catch (error) {
      log(`retrace: undo audit append failed: ${String(error)}`)
    }
  }

  return {
    root,
    constants: { UNDO_MAX_FILES, UNDO_MAX_BYTES, UNDO_TTL_MS },
    saveBytes,
    readBytes,
    put,
    get,
    deleteRecord,
    list,
    nextUndoId,
    now,
    audit,
    /** Absolute path helpers (tests). */
    objectPath,
    recordPath,
    auditPath,
  }
}

/** Normalise a DSH fs stat version (number or opaque token) into a CAS value. */
export function statVersion(stat) {
  const version = stat?.version
  if ((typeof version === 'number' && Number.isSafeInteger(version)) || (typeof version === 'string' && version.length > 0)) {
    return version
  }
  return null
}

/** CAS expectation for `ctx.fs.writeText`, or `undefined` when the fs has no version. */
export function replaceIfVersion(version) {
  return version === null || version === undefined ? undefined : { kind: 'replaceIfVersion', version }
}
