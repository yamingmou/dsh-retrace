/**
 * dsh-retrace — checkpoint preimage store (Batch1: storage only).
 *
 * A checkpoint means the state **before** an operation. This module owns the
 * file half of that preimage and the per-session index; it never restores
 * anything yet. Rollback keeps its existing behavior and writes checkpoints in
 * the shadow of its own write path (see `lib/rollback.js#execute`).
 *
 * Layout (all below `pluginDataHome()/dsh-retrace` by default):
 *
 *   checkpoints/<sessionId>.json   per-session index (schema 1, atomic writes)
 *   <poolRoot>/objects/<sha[:2]>/<sha>  content-addressed pool — `createArtifactStore`
 *                                  layout; `poolRoot` defaults to `<root>/undo`, so
 *                                  the pool is shared with the undo tickets' bytes
 *
 * One index record:
 *
 *   { versionId, cutSeq, kind, createdAt, filesComplete, warnings,
 *     files: [{ path, key, version, sha256|null, size }] }
 *
 * `sha256: null` means the path did not exist before the operation (a later
 * restore must delete it, not rewrite it).
 *
 * Retention is tiered: file preimages are kept for the newest `fileLimit`
 * records; older records survive as conversation-only checkpoints marked
 * `filesUnavailable` (the record and its audit trail are never dropped for
 * that reason). At most `recordLimit` records are kept per session.
 *
 * GC is reference counted. An object survives while a live checkpoint record,
 * a live undo ticket (younger than `UNDO_TTL_MS`; the audit log carries no
 * content address, so its only role is deciding that window), or the caller's
 * `extraKeep` still names its sha256. `collect()` is explicit and never runs
 * on the rollback path: a shared pool may also be pinned by other consumers.
 */
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { createArtifactStore, gcArtifacts } from './artifact-store.js'
import { pluginDataHome } from './platform/session-paths.js'
import { UNDO_TTL_MS } from './undo-store.js'

/** How many records a session keeps (conversation-only ones included). */
export const CHECKPOINT_RECORD_LIMIT = 200
/** How many of the newest records keep their file preimages. */
export const CHECKPOINT_FILE_LIMIT = 50

const HEX64 = /^[0-9a-f]{64}$/

const fileRowSchema = z.object({
  path: z.string().min(1),
  key: z.string().nullable(),
  version: z.union([z.number(), z.string()]).nullable(),
  sha256: z.string().regex(HEX64).nullable(),
  size: z.number().int().nonnegative(),
})

const recordSchema = z.object({
  versionId: z.string().min(1),
  cutSeq: z.number().int().min(-1),
  kind: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
  filesComplete: z.boolean(),
  warnings: z.array(z.string()),
  filesUnavailable: z.boolean().optional(),
  pending: z.boolean().optional(),
  files: z.array(fileRowSchema),
}).passthrough()

const indexSchema = z.object({
  schema: z.literal(1),
  sessionId: z.string().min(1),
  records: z.array(recordSchema),
}).passthrough()

/** Session ids are UUIDs in practice; anything else is hashed into a legal name. */
function fileNameOf(sessionId) {
  const id = String(sessionId)
  return /^[A-Za-z0-9._-]{1,128}$/.test(id) ? id : createHash('sha256').update(id).digest('hex')
}

/** fsync one directory so a rename survives a crash (Windows defers to NTFS). */
async function syncDirectory(path) {
  /* v8 ignore next -- Windows cannot open directory handles; NTFS journaling owns entry durability. */
  if (process.platform === 'win32') return
  const handle = await open(path, constants.O_RDONLY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** Durable JSON publication: temp file → fsync → rename → directory fsync. */
async function writeJsonDurable(path, value) {
  const directory = dirname(path)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = join(directory, `.${randomUUID()}.tmp`)
  const text = `${JSON.stringify(value)}\n`
  let handle
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    await handle.writeFile(text)
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporary, path)
    await syncDirectory(directory)
  } catch (error) {
    /* v8 ignore next -- descriptor can remain open only when write/sync/close failed. */
    if (handle !== undefined) await handle.close().catch(() => {})
    await unlink(temporary).catch(() => {})
    throw error
  }
}

/**
 * Create the checkpoint preimage store.
 * @param {object} [options]
 * @param {string} [options.root] — base directory (index lives in `<root>/checkpoints`)
 * @param {string} [options.poolRoot] — object pool + undo tickets (default `<root>/undo`)
 * @param {() => number} [options.now] — injectable clock (tests / TTL window)
 * @param {number} [options.recordLimit]
 * @param {number} [options.fileLimit]
 * @param {(line: string) => void} [options.log]
 */
export function createPreimageStore({
  root = join(pluginDataHome(), 'dsh-retrace'),
  poolRoot = join(root, 'undo'),
  now = () => Date.now(),
  recordLimit = CHECKPOINT_RECORD_LIMIT,
  fileLimit = CHECKPOINT_FILE_LIMIT,
  log = () => {},
} = {}) {
  const objectStore = createArtifactStore(poolRoot)
  const checkpointsRoot = join(root, 'checkpoints')
  const indexPath = (sessionId) => join(checkpointsRoot, `${fileNameOf(sessionId)}.json`)
  const tails = new Map()

  async function read(sessionId) {
    let raw
    try {
      raw = await readFile(indexPath(sessionId), 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return { schema: 1, sessionId: String(sessionId), records: [] }
      throw error
    }
    const parsed = indexSchema.parse(JSON.parse(raw))
    if (parsed.sessionId !== String(sessionId)) throw new Error('checkpoint index does not belong to this session')
    return parsed
  }

  /** Serialize per session: read-modify-write of one index never interleaves. */
  function update(sessionId, change) {
    const run = (tails.get(sessionId) ?? Promise.resolve()).then(async () => {
      const current = await read(sessionId)
      const next = await change(current.records)
      await writeJsonDurable(indexPath(sessionId), { schema: 1, sessionId: String(sessionId), records: next })
      return next
    })
    const tail = run.catch(() => {})
    tails.set(sessionId, tail)
    return run.finally(() => {
      if (tails.get(sessionId) === tail) tails.delete(sessionId)
    })
  }

  /** Tiered retention: newest `fileLimit` records keep preimages, newest `recordLimit` survive. */
  function retain(records) {
    const kept = records.slice(-recordLimit)
    const boundary = kept.length - fileLimit
    return kept.map((record, index) => (
      index < boundary && !record.filesUnavailable ? { ...record, filesUnavailable: true } : record
    ))
  }

  /**
   * Append one checkpoint record (validated, then retained, then durably
   * published). Returns the stored record.
   */
  async function append(sessionId, record) {
    const parsed = recordSchema.parse({ warnings: [], ...record })
    await update(sessionId, (records) => retain([...records, parsed]))
    return parsed
  }

  /** Read-only record listing (newest last, as stored). */
  async function records(sessionId) {
    return (await read(sessionId)).records
  }

  /** Patch one record in place (e.g. `pending:false` once its operation committed). */
  async function updateRecord(sessionId, versionId, patch) {
    let found = null
    await update(sessionId, (records) => records.map((record) => {
      if (record.versionId !== versionId) return record
      found = recordSchema.parse({ ...record, ...patch })
      return found
    }))
    return found
  }

  /** Drop one record (used when the pending operation turned out to be a no-op). */
  async function removeRecord(sessionId, versionId) {
    let removed = 0
    await update(sessionId, (records) => records.filter((record) => {
      if (record.versionId !== versionId) return true
      removed += 1
      return false
    }))
    return removed
  }

  /**
   * Prune stale `pending` records — a crash/aborted operation leaves a preimage
   * whose operation never committed. Committed records (pending !== true) and
   * fresh pending records are untouched.
   * @returns {Promise<number>} how many records were dropped
   */
  async function prunePending(sessionId, { maxAgeMs = 24 * 60 * 60 * 1000, at = now() } = {}) {
    let removed = 0
    await update(sessionId, (records) => records.filter((record) => {
      const stale = record.pending === true && at - record.createdAt > maxAgeMs
      if (stale) removed += 1
      return !stale
    }))
    return removed
  }

  /** Refuse to collect while another append is mid-flight in this process. */
  async function settled() {
    await Promise.all([...tails.values()])
  }

  /** Undo tickets still inside the TTL window (their bytes stay pinned). */
  async function liveTickets() {
    const directory = join(poolRoot, 'records')
    let names
    try {
      names = await readdir(directory)
    } catch {
      return []
    }
    const tickets = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      try {
        const parsed = JSON.parse(await readFile(join(directory, name), 'utf8'))
        if (!Array.isArray(parsed.entries)) continue
        if (now() - Number(parsed.createdAt ?? 0) > UNDO_TTL_MS) continue
        tickets.push(parsed)
      } catch (error) {
        log(`retrace: checkpoint GC skipped an unreadable undo ticket (${name}): ${String(error)}`)
      }
    }
    return tickets
  }

  /**
   * Remove objects no live reference names. `extraKeep` lets a caller pin
   * objects owned by another consumer of the same pool (e.g. version
   * snapshots) — pass them or leave the pool dedicated.
   * @returns {Promise<{removed: number, kept: number}>}
   */
  async function collect({ extraKeep = [] } = {}) {
    await settled()
    const keep = new Set(extraKeep.filter((sha) => typeof sha === 'string' && HEX64.test(sha)))
    for (const name of await readdir(checkpointsRoot).catch(() => [])) {
      if (!name.endsWith('.json')) continue
      let parsed
      try {
        parsed = indexSchema.parse(JSON.parse(await readFile(join(checkpointsRoot, name), 'utf8')))
      } catch (error) {
        log(`retrace: checkpoint GC skipped an unreadable index (${name}): ${String(error)}`)
        continue
      }
      for (const record of parsed.records) {
        if (record.filesUnavailable) continue
        for (const file of record.files) if (file.sha256 !== null) keep.add(file.sha256)
      }
    }
    for (const ticket of await liveTickets()) {
      for (const entry of ticket.entries) {
        if (entry !== null && typeof entry === 'object' && typeof entry.sha256 === 'string' && HEX64.test(entry.sha256)) {
          keep.add(entry.sha256)
        }
      }
    }
    const removed = await gcArtifacts(objectStore, keep)
    return { removed, kept: keep.size }
  }

  return {
    root,
    poolRoot,
    checkpointsRoot,
    objectStore,
    indexPath,
    read,
    records,
    append,
    updateRecord,
    removeRecord,
    prunePending,
    retain,
    collect,
    now,
    /** Absolute path of one content-addressed object (tests / diagnostics). */
    objectPath: (sha256) => objectStore.pathOf(sha256),
  }
}
