import { describe, it, expect, afterEach } from 'vitest'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createVersioningSeam, DEFAULT_RETRACE_CONFIG } from '../lib/versioning.js'
import { versionsProjectionDefinition } from '../lib/projection/versions.js'
import { MARKER_ID_PREFIX } from '../lib/version-index.js'
import { objectPath } from '../lib/artifact-store.js'

// ---------------------------------------------------------------------------
// Fake host services (the seam only needs a thin slice of each)
// ---------------------------------------------------------------------------

/** An in-memory KvTable with the storageDomain get/put contract. */
function fakeKvTable() {
  const records = new Map()
  return {
    get: (key) => records.get(key),
    put: async (key, value) => {
      records.set(key, value)
    },
    delete: async (key) => {
      records.delete(key)
    },
    entries: () => records.entries(),
    keys: () => records.keys(),
    records,
  }
}

function fakeDomain() {
  const refcounts = fakeKvTable()
  const versiongit = fakeKvTable()
  return {
    table: (name) => (name === 'refcounts' ? refcounts : name === 'versiongit' ? versiongit : null),
    global: { get: () => null, set: async () => {} },
    close: async () => {},
    refcounts,
    versiongit,
  }
}

function fakeCtx() {
  const sessions = new Map()
  const disposers = []
  const logLines = []
  const ctx = {
    sessions,
    fs: {
      resolve: async (path) => ({ targetKey: `ws/${path}`, displayPath: path }),
      contains: (parent, child) => child.targetKey.startsWith('ws/'),
      readBytes: async () => new TextEncoder().encode('file content'),
    },
    logger: { info: (line) => logLines.push(line), warn: (line) => logLines.push(line) },
    inject: (_list, fn) => {
      const seamCtx = {
        registeredDefinitions: [],
        changeListener: null,
        domain: null,
        sessionProjections: {
          register: (definition) => {
            seamCtx.registeredDefinitions.push(definition)
            return () => {}
          },
          onChanged: (listener) => {
            seamCtx.changeListener = listener
            return () => {}
          },
          snapshot: () => ({
            asOfSeq: -1,
            values: {
              'retrace/versions': { versions: [] },
              'retrace/forkmap': { nodes: [], boundaries: [] },
            },
          }),
        },
        sessionQuery: {
          readEvent: async (request) => ({ request }),
          readSurface: async (sessionId) => ({ sessionId }),
        },
        storageDomain: {
          open: async () => {
            const domain = fakeDomain()
            seamCtx.domain = domain
            return domain
          },
        },
      }
      fn(seamCtx)
      ctx.inject.seam = seamCtx
      return seamCtx
    },
    effect: (fn, name) => {
      disposers.push({ fn, name })
    },
    logLines,
    disposers,
  }
  return ctx
}

const roots = []
async function freshRoot() {
  const root = await mkdtemp(join(tmpdir(), 'retrace-seam-'))
  roots.push(root)
  return root
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
  )
})

/** Wait for the async domain-open inside the seam. */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 10))
}

/** Poll until `predicate` holds (the snapshot chain does real fs I/O). */
async function waitFor(predicate, { timeout = 2000, interval = 5 } = {}) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
  throw new Error('waitFor: condition not met within timeout')
}

function userMessage(seq) {
  return {
    seq,
    type: 'user/message',
    time: 1_700_000_000_000 + seq,
    surfaceOp: 'append',
    data: { id: `user-${seq}`, role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } },
  }
}

function toolWrite(seq, path) {
  return {
    seq,
    type: 'tool/call',
    time: 1_700_000_000_000 + seq,
    surfaceOp: 'append',
    data: { id: `tool-${seq}`, name: 'fs.write', arguments: JSON.stringify({ path }) },
  }
}

function editorMarker(seq, { start, end, op = 'recall', text = 'original' } = {}) {
  return {
    seq,
    type: 'assistant/message',
    time: 1_700_000_000_000 + seq,
    surfaceOp: { op: 'replace', start, end },
    sourceEventSeqs: Array.from({ length: end - start + 1 }, (_, i) => start + i),
    data: {
      turn: null,
      step: null,
      message: {
        id: `${MARKER_ID_PREFIX}-${op}-abc`,
        role: 'assistant',
        content: [],
        source: { kind: 'model', provider: 't', model: 'm' },
      },
      editor: { targetSeq: start, text },
    },
  }
}

/** Fold a log through the unit and return the view at the final event's seq. */
function foldView(events) {
  let state = versionsProjectionDefinition.init()
  for (const event of events) state = versionsProjectionDefinition.apply(state, event)
  return versionsProjectionDefinition.view(state)
}

// ---------------------------------------------------------------------------
// Seam registration
// ---------------------------------------------------------------------------

describe('createVersioningSeam', () => {
  it('registers the projection units and wires the change feed on inject', async () => {
    const ctx = fakeCtx()
    const seam = createVersioningSeam(ctx, () => {}, { storeRoot: await freshRoot() })
    seam.register()
    const seamCtx = ctx.inject.seam
    // Both units register: the versions unit and the P2.1 fork-map unit.
    expect(seamCtx.registeredDefinitions).toContain(versionsProjectionDefinition)
    expect(seamCtx.registeredDefinitions.map((d) => d.key)).toEqual([
      'retrace/versions',
      'retrace/forkmap',
    ])
    expect(typeof seamCtx.changeListener).toBe('function')
  })

  it('doctorScan flags turn-null markers that break the token meter (B1)', async () => {
    const ctx = fakeCtx()
    const seam = createVersioningSeam(ctx, () => {}, { storeRoot: await freshRoot() })
    seam.register()
    const seamCtx = ctx.inject.seam
    // seed a session with a modern step structure + a turn-null edit marker
    const session = {
      id: 's1',
      events: [
        { seq: 0, type: 'user/message', surfaceOp: 'append', time: 1, data: { id: 'u1', role: 'user', content: [], source: { kind: 'user' } } },
        { seq: 1, type: 'step/start', time: 2, data: { turn: 0, step: 1 } },
        { seq: 2, type: 'assistant/message', surfaceOp: 'append', time: 3, data: { turn: 0, step: 1, message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'yo' }], source: { kind: 'model', provider: 'p', model: 'm' } } } },
        { seq: 3, type: 'step/end', time: 4, data: { turn: 0, step: 1 } },
        { seq: 4, type: 'assistant/message', surfaceOp: { op: 'replace', start: 0, end: 2 }, sourceEventSeqs: [0, 2], time: 5, data: { turn: null, step: null, message: { id: 'retrace-edit-x', role: 'assistant', content: [], source: { kind: 'model', provider: 'p', model: 'm' } }, editor: { targetSeq: 0, text: 'edited' } } },
      ],
    }
    ctx.sessions.set('s1', session)
    const result = seam.doctorScan('s1')
    expect(result.enabled).toBe(true)
    expect(result.markerCount).toBe(1)
    expect(result.markers[0]).toMatchObject({ seq: 4 })
    // healthy session without markers → zero
    const clean = { id: 's2', events: session.events.filter((e) => e.data?.editor === undefined) }
    ctx.sessions.set('s2', clean)
    expect(seam.doctorScan('s2').markerCount).toBe(0)
  })

  it('is unavailable before inject (headless compositions degrade to L1)', () => {
    const ctx = fakeCtx()
    const seam = createVersioningSeam(ctx, () => {}, { storeRoot: '/tmp' })
    expect(seam.available()).toBe(false)
    expect(seam.snapshot('s1')).toEqual({ enabled: false, versions: [] })
  })

  it('readEvent/readSurface reject with versioning-unavailable when not injected', async () => {
    const ctx = fakeCtx()
    const seam = createVersioningSeam(ctx, () => {}, { storeRoot: '/tmp' })
    await expect(seam.readEvent({ sessionId: 's1', seq: 0 })).rejects.toMatchObject({
      code: 'versioning-unavailable',
    })
    await expect(seam.readSurface('s1')).rejects.toMatchObject({
      code: 'versioning-unavailable',
    })
  })

  it('lineage walks header.parentSession to the root (A4)', async () => {
    const ctx = fakeCtx()
    const seam = createVersioningSeam(ctx, () => {}, { storeRoot: await freshRoot() })
    await settle()
    ctx.sessions.set('leaf', { id: 'leaf', header: { cwd: '/ws', parentSession: 'mid' } })
    ctx.sessions.set('mid', { id: 'mid', header: { cwd: '/ws', parentSession: 'root' } })
    ctx.sessions.set('root', { id: 'root', header: { cwd: '/ws' } })
    expect(seam.lineage('leaf')).toEqual([
      { id: 'leaf', parentId: 'mid' },
      { id: 'mid', parentId: 'root' },
      { id: 'root', parentId: null },
    ])
    // standalone session → single-hop chain
    expect(seam.lineage('root')).toEqual([{ id: 'root', parentId: null }])
  })

  it('lineage stops at a cycle (defensive) and tolerates unknown parents', async () => {
    const ctx = fakeCtx()
    const seam = createVersioningSeam(ctx, () => {}, { storeRoot: await freshRoot() })
    await settle()
    ctx.sessions.set('a', { id: 'a', header: { cwd: '/ws', parentSession: 'b' } })
    ctx.sessions.set('b', { id: 'b', header: { cwd: '/ws', parentSession: 'a' } })
    const chain = seam.lineage('a')
    expect(chain.length).toBe(2)
    expect(new Set(chain.map((hop) => hop.id))).toEqual(new Set(['a', 'b']))
    // parent id not present in the registry → still surfaced as a hop
    // (the UI can show "continues from <ghost>"), no throw
    ctx.sessions.set('solo', { id: 'solo', header: { cwd: '/ws', parentSession: 'ghost' } })
    expect(seam.lineage('solo')).toEqual([
      { id: 'solo', parentId: 'ghost' },
      { id: 'ghost', parentId: null },
    ])
  })
})

// ---------------------------------------------------------------------------
// Change feed → snapshot side effect
// ---------------------------------------------------------------------------

describe('onChanged side effect', () => {
  it('snapshots touched files and records refcounts for a NEW boundary', async () => {
    const ctx = fakeCtx()
    const seam = createVersioningSeam(ctx, () => {}, { storeRoot: await freshRoot() })
    seam.register()
    const seamCtx = ctx.inject.seam
    await settle() // domain open resolves

    const view = foldView([userMessage(0), toolWrite(1, 'src/a.ts'), editorMarker(2, { start: 0, end: 1, op: 'edit' })])
    expect(view.versions[0].touchedFiles).toEqual([{ path: 'src/a.ts', mode: 'created' }])

    const session = { id: 's1', header: { cwd: '/ws' } }
    seamCtx.changeListener(session, 'retrace/versions', view, 2)
    await waitFor(() => seamCtx.domain.refcounts.records.size === 1)

    const records = [...seamCtx.domain.refcounts.records.values()]
    expect(records).toHaveLength(1)
    expect(records[0].refs).toEqual(['v2:src/a.ts'])
    expect(records[0].sizeBytes).toBeGreaterThan(0)
  })

  it('ignores non-new boundaries and non-retrace keys', async () => {
    const ctx = fakeCtx()
    const seam = createVersioningSeam(ctx, () => {}, { storeRoot: await freshRoot() })
    seam.register()
    const seamCtx = ctx.inject.seam
    await settle()
    const session = { id: 's1', header: { cwd: '/ws' } }

    seamCtx.changeListener(session, 'other/key', { versions: [] }, 5)
    seamCtx.changeListener(session, 'retrace/versions', { versions: [] }, 3)
    await settle()
    expect(seamCtx.domain.refcounts.records.size).toBe(0)
  })

  it('does not snapshot when versioning is off for the session', async () => {
    const ctx = fakeCtx()
    const seam = createVersioningSeam(ctx, () => {}, { storeRoot: await freshRoot() })
    seam.register()
    const seamCtx = ctx.inject.seam
    await settle()
    seam.setConfig('s1', { ...DEFAULT_RETRACE_CONFIG, versioning: false })

    let reads = 0
    ctx.fs.readBytes = async () => {
      reads += 1
      return new TextEncoder().encode('x')
    }
    const view = foldView([userMessage(0), toolWrite(1, 'src/a.ts'), editorMarker(2, { start: 0, end: 1, op: 'edit' })])
    const session = { id: 's1', header: { cwd: '/ws' } }
    seamCtx.changeListener(session, 'retrace/versions', view, 2)
    await settle()
    expect(reads).toBe(0)
    expect(seamCtx.domain.refcounts.records.size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Snapshot / config view
// ---------------------------------------------------------------------------

describe('seam snapshot and config', () => {
  it('serves the live projection snapshot as the HTTP fallback', async () => {
    const ctx = fakeCtx()
    const session = { id: 's1', header: { cwd: '/ws' } }
    ctx.sessions.set('s1', session)
    const seam = createVersioningSeam(ctx, () => {}, { storeRoot: await freshRoot() })
    seam.register()
    await settle()
    const value = seam.snapshot('s1')
    expect(value.enabled).toBe(true)
    expect(value.versions).toEqual([])
  })

  it('reports enabled:false when versioning is off for the session', async () => {
    const ctx = fakeCtx()
    ctx.sessions.set('s1', { id: 's1', header: { cwd: '/ws' } })
    const seam = createVersioningSeam(ctx, () => {}, { storeRoot: await freshRoot() })
    seam.register()
    await settle()
    seam.setConfig('s1', { ...DEFAULT_RETRACE_CONFIG, versioning: false })
    expect(seam.snapshot('s1').enabled).toBe(false)
  })

  it('throws session-not-found for unknown sessions', () => {
    const ctx = fakeCtx()
    const seam = createVersioningSeam(ctx, () => {}, { storeRoot: '/tmp' })
    seam.register()
    expect(() => seam.snapshot('missing')).toThrow(/not found/)
  })

  it('configFor falls back to defaults; setConfig merges per request', () => {
    const ctx = fakeCtx()
    const seam = createVersioningSeam(ctx, () => {}, { storeRoot: '/tmp' })
    expect(seam.configFor('s1')).toEqual(DEFAULT_RETRACE_CONFIG)
    seam.setConfig('s1', { versioning: false })
    expect(seam.configFor('s1')).toEqual({ ...DEFAULT_RETRACE_CONFIG, versioning: false })
  })
})

// ---------------------------------------------------------------------------
// P1.5 — background GC sweep (retention-bounded artifact store)
// ---------------------------------------------------------------------------

describe('GC sweep', () => {
  it('prunes refs to versions truncated out of the timeline window and removes their objects', async () => {
    const ctx = fakeCtx()
    const storeRoot = await freshRoot()
    const seam = createVersioningSeam(ctx, () => {}, { storeRoot, gcIntervalMs: 0 })
    seam.register()
    const seamCtx = ctx.inject.seam
    await settle()

    const session = { id: 's1', header: { cwd: '/ws' } }
    const { mkdir, writeFile } = await import('node:fs/promises')

    // A pre-truncation snapshot: version v2 referenced an object; the fold below
    // keeps only the last 200 of 205 versions, so v2 leaves the window.
    await seamCtx.domain.refcounts.put('deadbeef', { refs: ['v2:src/old.ts'], sizeBytes: 4, createdAt: 1 })
    await mkdir(dirname(objectPath(storeRoot, 'deadbeef')), { recursive: true })
    await writeFile(objectPath(storeRoot, 'deadbeef'), 'old!')

    // Build a 205-version log: (user, tool-write, marker) per version.
    const events = []
    for (let i = 0; i < 205; i++) {
      events.push(userMessage(3 * i))
      events.push(toolWrite(3 * i + 1, `src/f${i}.ts`))
      events.push(editorMarker(3 * i + 2, i === 0 ? { start: 0, end: 1 } : { start: 3 * i - 1, end: 3 * i + 1, op: 'edit' }))
    }
    const view = foldView(events)
    expect(view.versions.length).toBe(200) // VERSION_LIMIT truncation

    seamCtx.changeListener(session, 'retrace/versions', view, 3 * 204 + 2)
    // The newest boundary's snapshot lands (v614:src/f204.ts survives).
    await waitFor(() => {
      const records = [...seamCtx.domain.refcounts.records.values()]
      return records.some((r) => r.refs && r.refs.includes('v614:src/f204.ts'))
    })
    // The truncated version's ref is pruned…
    await waitFor(() => {
      const records = [...seamCtx.domain.refcounts.records.values()]
      return records.every((r) => r.refs.every((ref) => !ref.startsWith('v2:')))
    })
    // …and its object file is GC'd, while the retained snapshot survives.
    await waitFor(async () => {
      try { await access(objectPath(storeRoot, 'deadbeef')); return false } catch { return true }
    })
    const shaNew = [...seamCtx.domain.refcounts.records.keys()].find((sha) => sha !== 'deadbeef')
    await access(objectPath(storeRoot, shaNew))
  })
})
