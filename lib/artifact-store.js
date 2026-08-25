/**
 * dsh-retrace — content-addressed artifact snapshot store + `retrace` domain.
 *
 * PLAN.md §3.3 / §4.3: snapshots live under
 *
 *     $DSH_HOME/dsh-retrace/objects/<sha256[:2]>/<sha256>
 *
 * written with the same durable recipe as the official attachment store
 * (`dsh-attachment-local` saveImageFile): stage in tmp → O_EXCL write →
 * fsync → hardlink publish → directory fsync → integrity-verified reads.
 * The plugin owns this directory (host node:fs, exactly like attachments —
 * it never touches the workspace or any user-approval surface); workspace
 * reads/writes keep going through `ctx.fs`.
 *
 * Reference counting rides the `retrace` storageDomain (`refCounts` table +
 * global config) so one content-addressed object is shared across versions
 * and can be GC'd when nothing references it anymore. References are
 * `<versionId>:<path>` strings, so P1 rollback can look an object up by the
 * exact (version, file) pair.
 */
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, link, mkdir, open, readdir, readFile, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

// ---------------------------------------------------------------------------
// retrace storageDomain (refCounts + global config)
// ---------------------------------------------------------------------------

const refCountRecordSchema = z.object({
  /** `<versionId>:<path>` strings — the versions/files referencing this object. */
  refs: z.array(z.string()),
  sizeBytes: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
})

const globalConfigSchema = z.object({
  retentionLimit: z.number().int().min(1),
  gitEnabled: z.boolean(),
})

/** One version's git facts, recorded at the boundary (P1 GitAdapter). */
const versionGitRecordSchema = z.object({
  /** HEAD at the version boundary (null = not a repository then). */
  headHash: z.string().nullable(),
  /** Working tree dirty at the boundary. */
  dirty: z.boolean(),
})

/**
 * The `retrace` domain spec — open via `ctx.storageDomain.open(retraceDomainSpec)`.
 * The web composition's `storage-json` backend lands it at
 * `$DSH_HOME/storages/retrace.json` beside the session projection cache.
 */
export const retraceDomainSpec = defineDomain({
  name: 'retrace',
  version: 1,
  tables: {
    // UNIT_NAME_RE is lowercase-only; `refcounts` is the official-safe spelling
    // of the plan's `refCounts` table.
    refcounts: domainTable(refCountRecordSchema),
    versiongit: domainTable(versionGitRecordSchema),
  },
  global: {
    schema: globalConfigSchema,
    initial: { retentionLimit: 50, gitEnabled: true },
  },
})

// ---------------------------------------------------------------------------
// Durable directory plumbing (attachment-local pattern)
// ---------------------------------------------------------------------------

/** fsync a directory so its entries survive a crash. */
async function syncDirectory(path) {
  /* v8 ignore next -- Windows cannot open directory handles; NTFS journaling owns entry durability there. */
  if (process.platform === 'win32') return
  const handle = await open(path, constants.O_RDONLY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/**
 * Create a private directory tree and persist every ancestor entry up to a
 * caller-vouched durable boundary (mirrors `ensureDurableDirectory` in
 * `dsh-attachment-local`). Re-syncing a durable entry is harmless; skipping
 * an unsynced one is not.
 */
async function ensureDurableDirectory(path, boundary) {
  const target = resolve(path)
  const stop = resolve(boundary)
  await mkdir(target, { recursive: true, mode: 0o700 })
  await chmod(target, 0o700)
  let level = target
  while (level !== stop) {
    const parent = dirname(level)
    await syncDirectory(parent)
    /* v8 ignore next -- callers pass a boundary that is an ancestor of path. */
    if (parent === level) return
    level = parent
  }
}

/** sha256 of bytes (Buffer or Uint8Array). */
function digest(data) {
  return createHash('sha256').update(data).digest('hex')
}

/** Absolute path of one content-addressed object below the store root. */
export function objectPath(root, sha256) {
  return join(root, 'objects', sha256.slice(0, 2), sha256)
}

// ---------------------------------------------------------------------------
// ArtifactStore
// ---------------------------------------------------------------------------

/**
 * Create the content-addressed snapshot store below `root`
 * (`$DSH_HOME/dsh-retrace`). All I/O is host `node:fs` on the plugin's own
 * directory; nothing here reads or writes the workspace.
 */
export function createArtifactStore(root) {
  const objectsRoot = join(root, 'objects')
  const staging = join(root, 'tmp')

  return {
    root,
    /** Absolute path of one object (read/remove). */
    pathOf: (sha256) => objectPath(root, sha256),

    /**
     * Durably persist immutable bytes and return their content address.
     * Deduplicated by sha256: a second save of identical bytes hardlinks to
     * the existing object after verifying its integrity (`existed: true`).
     * @returns {Promise<{sha256: string, sizeBytes: number, existed: boolean}>}
     */
    async save(data) {
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
      const sha256 = digest(bytes)
      const bucket = join(objectsRoot, sha256.slice(0, 2))
      const target = objectPath(root, sha256)
      await ensureDurableDirectory(bucket, root)
      await ensureDurableDirectory(staging, root)
      const temporary = join(staging, randomUUID())
      let handle
      try {
        handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
        await handle.writeFile(bytes)
        await handle.sync()
        await handle.close()
        handle = undefined
        let existed = false
        try {
          await link(temporary, target)
        } catch (error) {
          // EEXIST is the only recoverable link race: another save published first.
          if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
          existed = true
          const existing = new Uint8Array(await readFile(target))
          if (digest(existing) !== sha256) {
            throw new Error(`retrace artifact integrity mismatch at ${target}`)
          }
        }
        await syncDirectory(bucket)
        await syncDirectory(objectsRoot)
        await unlink(temporary)
        return { sha256, sizeBytes: bytes.byteLength, existed }
      } catch (error) {
        /* v8 ignore next -- descriptor can remain open only when write/sync/close failed. */
        if (handle !== undefined) await handle.close().catch(() => {})
        await unlink(temporary).catch(() => {})
        throw error
      }
    },

    /** Read an object, verifying its content address (integrity-checked). */
    async read(sha256) {
      const data = new Uint8Array(await readFile(objectPath(root, sha256)))
      if (digest(data) !== sha256) {
        throw new Error(`retrace artifact integrity check failed for ${sha256}`)
      }
      return data
    },

    /** Remove one object; missing objects are a no-op. */
    async remove(sha256) {
      try {
        await unlink(objectPath(root, sha256))
      } catch (error) {
        /* v8 ignore next -- concurrent GC removing the same object is fine. */
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      }
    },

    /** Every stored object sha256 (walks `objects/<xx>/<sha>`). */
    async list() {
      let buckets
      try {
        buckets = await readdir(objectsRoot, { withFileTypes: true })
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
        throw error
      }
      const hashes = []
      for (const bucket of buckets) {
        if (!bucket.isDirectory() || bucket.name.length !== 2) continue
        for (const entry of await readdir(join(objectsRoot, bucket.name))) {
          if (entry.length === 64) hashes.push(entry)
        }
      }
      return hashes.sort()
    },
  }
}

/**
 * Remove every stored object not in `keep` (a Set of sha256).
 * Callers derive `keep` from the `refCounts` table (refs.length > 0) plus
 * whatever retention policy applies. Returns the number of removed objects.
 */
export async function gcArtifacts(store, keep) {
  const removed = []
  for (const sha256 of await store.list()) {
    if (!keep.has(sha256)) {
      await store.remove(sha256)
      removed.push(sha256)
    }
  }
  return removed.length
}

/** Parse a `<versionId>:<path>` reference (first colon splits version id). */
export function parseRef(ref) {
  const colon = ref.indexOf(':')
  if (colon === -1) return { versionId: null, path: ref }
  return { versionId: ref.slice(0, colon), path: ref.slice(colon + 1) }
}

/** Build a `<versionId>:<path>` reference string. */
export function refFor(versionId, path) {
  return `${versionId}:${path}`
}
