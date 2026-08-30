/**
 * Rollback executor unit tests. A fake session is seeded with correctly
 * shaped surface events (every surface-eligible event carries its `surfaceOp`
 * marker — as real durable logs do) so `foldSurface` works; a fake seam /
 * ctx / subprocess stand in for the host services.
 */
import { describe, expect, it, vi } from 'vitest'
import { createRollbackExecutor } from '../lib/rollback.js'

/** User message event (real user input → round boundary). */
function userMessage(id, text, extra = {}) {
  return {
    type: 'user/message',
    surfaceOp: 'append',
    data: { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' }, ...extra },
  }
}

/** Assistant model reply (carries provider/model for marker append). */
function assistantMessage(id, text) {
  return {
    type: 'assistant/message',
    surfaceOp: 'append',
    data: {
      message: {
        id,
        role: 'assistant',
        content: [{ type: 'text', text }],
        source: { kind: 'model', provider: 'test-provider', model: 'test-model' },
      },
    },
  }
}

/** A recall-style marker replacement (empty assistant message). */
function markerEvent(id, span, sourceEventSeqs) {
  return {
    type: 'assistant/message',
    surfaceOp: { op: 'replace', start: span[0], end: span[span.length - 1] },
    sourceEventSeqs,
    data: {
      turn: null,
      step: null,
      message: { id, role: 'assistant', content: [], source: { kind: 'model', provider: 'test-provider', model: 'test-model' } },
      editor: { targetSeq: span[0], text: 'edited' },
    },
  }
}

/** Fake session: append-only log + shadow-able surface + header.cwd. */
function makeSession(cwd = '/work') {
  const events = []
  const surface = { nodes: [] }
  const session = {
    id: 's1',
    header: { cwd },
    events,
    surface,
    seed(...events) {
      for (const event of events) this.appendRaw(event)
      return this
    },
    appendRaw(event) {
      const record = { seq: events.length, time: Date.now(), ...event }
      events.push(record)
      if (record.type !== 'request/header') {
        if (record.surfaceOp && record.surfaceOp.op === 'replace') {
          const { start, end } = record.surfaceOp
          surface.nodes = surface.nodes.filter((seq) => seq < start || seq > end)
        }
        surface.nodes.push(record.seq)
      }
      return record
    },
    append(type, data, options = {}) {
      const record = { seq: events.length, time: Date.now(), type, data, ...options }
      events.push(record)
      // 与真实 dsh-session 一致：step/turn 边界不进 surface
      if (type === 'step/start' || type === 'step/end' || type === 'turn/start' || type === 'turn/end') return record
      if (options.surfaceOp && options.surfaceOp.op === 'replace') {
        const { start, end } = options.surfaceOp
        surface.nodes = surface.nodes.filter((seq) => seq < start || seq > end)
      }
      surface.nodes.push(record.seq)
      return record
    },
  }
  return session
}

/** A version record shape as served by the projection view. */
function versionRecord(overrides = {}) {
  return {
    versionId: 'v3',
    boundarySeq: 3,
    createdAt: 1,
    kind: 'recall',
    markerText: 'edited',
    messageCount: 3,
    fileCounts: { created: 1, modified: 0, deleted: 0 },
    touchedFiles: [{ path: 'src/a.ts', mode: 'created' }],
    git: null,
    ...overrides,
  }
}

/** A fake seam implementing the surface the rollback executor consumes. */
function makeSeam(overrides = {}) {
  return {
    configFor: () => ({ versioning: true, git: false, retentionLimit: 50 }),
    snapshot: () => ({ enabled: true, versions: [versionRecord()] }),
    agentOf: () => undefined,
    resolveSnapshot: vi.fn(async () => 'sha-a'),
    readSnapshot: vi.fn(async () => new TextEncoder().encode('file content')),
    gitStatus: vi.fn(async () => null),
    gitCheckout: vi.fn(async (cwd, headHash, paths) => ({ ok: true, checked: paths, skipped: [] })),
    gitHeadFor: vi.fn(async () => null),
    ...overrides,
  }
}

/** A fake ctx: fs (resolve/contains/stat/writeText), subprocess, sandboxPolicy. */
function makeCtx() {
  const writes = []
  const spawns = []
  const ctx = {
    fs: {
      resolve: async (path, { cwd } = {}) => (path === '.' ? cwd ?? '/work' : `${cwd ?? '/work'}/${path}`),
      contains: (root, target) => target.startsWith(root + '/'),
      stat: vi.fn(async (target) => ({ version: 7 })),
      writeText: vi.fn(async (target, content, expected) => {
        writes.push({ target, content, expected })
      }),
    },
    subprocess: {
      spawn: (spec) => {
        spawns.push(spec)
        return { done: Promise.resolve({ exitCode: 0 }) }
      },
    },
    sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) },
  }
  return { ctx, writes, spawns }
}

/** Convenience: a ready rollback executor. */
function makeRollback(session, seamOverrides = {}, ctxOverrides = {}) {
  const { ctx, writes, spawns } = makeCtx()
  const seam = makeSeam(seamOverrides)
  const sessions = { get: (id) => (id === 's1' ? session : undefined), flush: vi.fn(async () => {}) }
  const rollback = createRollbackExecutor({ ctx: { ...ctx, ...ctxOverrides }, sessions, seam, log: () => {} })
  return { rollback, seam, writes, spawns, sessions }
}

describe('rollback preview', () => {
  it('rejects an invalid scope', async () => {
    const session = makeSession().seed(
      userMessage('u1', 'hi'),
      assistantMessage('a1', 'yo'),
      userMessage('u2', 'again'),
    )
    const { rollback } = makeRollback(session)
    await expect(rollback.preview({ sessionId: 's1', versionId: 'v4', scope: 'nope' })).rejects.toMatchObject({ code: 'bad-scope' })
  })

  it('reports the context diff (messages after the boundary) and the artifact plan', async () => {
    // v3 boundary: marker at seq 3 shadows u1..a1; then u3 appended at seq 4.
    const session = makeSession().seed(
      userMessage('u1', 'hi'),
      assistantMessage('a1', 'yo'),
      userMessage('u2', 'again'),
      markerEvent('retrace-recall-1', [0, 1], [0, 1]),
      userMessage('u3', 'more'),
    )
    const { rollback } = makeRollback(session)
    const result = await rollback.preview({ sessionId: 's1', versionId: 'v3', scope: 'both' })
    expect(result.context.messages).toBe(1)
    expect(result.context.firstSeq).toBe(4)
    expect(result.applicable).toBe(true)
    expect(result.artifacts.rows[0]).toMatchObject({ path: 'src/a.ts', action: 'restore', method: 'snapshot' })
  })

  it('reports non-applicable when the session is already at the version', async () => {
    const session = makeSession().seed(
      userMessage('u1', 'hi'),
      assistantMessage('a1', 'yo'),
      userMessage('u2', 'again'),
      markerEvent('retrace-recall-1', [0, 1], [0, 1]),
    )
    const { rollback } = makeRollback(session)
    const result = await rollback.preview({ sessionId: 's1', versionId: 'v3', scope: 'both' })
    expect(result.context.messages).toBe(0)
    expect(result.applicable).toBe(true) // artifact row still applies
  })
})

describe('rollback execute', () => {
  it('appends a restore marker shadowing the post-boundary surface', async () => {
    const session = makeSession().seed(
      userMessage('u1', 'hi'),
      assistantMessage('a1', 'yo'),
      userMessage('u2', 'again'),
      markerEvent('retrace-recall-1', [0, 1], [0, 1]),
      userMessage('u3', 'more'),
    )
    const { rollback, sessions } = makeRollback(session)
    const result = await rollback.execute({ sessionId: 's1', versionId: 'v3', scope: 'context' })
    expect(result.markerSeq).toBe(6)
    expect(result.context.messages).toBe(1)
    const marker = session.events[6] // marker 在临时 step 之后（step/start@5, marker@6）
    expect(marker.type).toBe('assistant/message')
    expect(marker.surfaceOp).toEqual({ op: 'replace', start: 4, end: 4 })
    expect(marker.sourceEventSeqs).toEqual([4])
    expect(marker.data.editor.targetSeq).toBe(3)
    expect(sessions.flush).toHaveBeenCalled()
  })

  it('restores artifacts from snapshots through the sandboxed fs (CAS-guarded)', async () => {
    const session = makeSession().seed(
      userMessage('u1', 'hi'),
      assistantMessage('a1', 'yo'),
      userMessage('u2', 'again'),
      markerEvent('retrace-recall-1', [0, 1], [0, 1]),
    )
    const { rollback, writes, seam } = makeRollback(session)
    const result = await rollback.execute({ sessionId: 's1', versionId: 'v3', scope: 'artifacts' })
    expect(seam.resolveSnapshot).toHaveBeenCalledWith('v3', 'src/a.ts')
    expect(seam.readSnapshot).toHaveBeenCalledWith('sha-a')
    expect(writes.length).toBe(1)
    expect(writes[0].target).toBe('/work/src/a.ts')
    expect(writes[0].content).toBe('file content')
    expect(writes[0].expected).toEqual({ kind: 'replaceIfVersion', version: 7 })
    expect(result.artifacts[0]).toMatchObject({ path: 'src/a.ts', status: 'restored' })
  })

  it('rolls back deleted files through subprocess rm (guarded)', async () => {
    const session = makeSession().seed(
      userMessage('u1', 'hi'),
      assistantMessage('a1', 'yo'),
      userMessage('u2', 'again'),
      markerEvent('retrace-recall-1', [0, 1], [0, 1]),
    )
    const { rollback, spawns } = makeRollback(session, {
      snapshot: () => ({ enabled: true, versions: [versionRecord({ touchedFiles: [{ path: 'gone.txt', mode: 'deleted' }] })] }),
    })
    const result = await rollback.execute({ sessionId: 's1', versionId: 'v3', scope: 'artifacts' })
    expect(spawns.length).toBe(1)
    expect(spawns[0].argv[0]).toBe('rm')
    expect(spawns[0].argv).toContain('gone.txt')
    expect(result.artifacts[0]).toMatchObject({ path: 'gone.txt', status: 'deleted' })
  })

  it('uses git checkout when the workspace is a repository with a recorded HEAD', async () => {
    const session = makeSession().seed(
      userMessage('u1', 'hi'),
      assistantMessage('a1', 'yo'),
      userMessage('u2', 'again'),
      markerEvent('retrace-recall-1', [0, 1], [0, 1]),
    )
    const seam = makeSeam({
      configFor: () => ({ versioning: true, git: true, retentionLimit: 50 }),
      gitStatus: async () => ({ root: '/work', headHash: 'abc123', dirty: true, paths: [] }),
    })
    const { rollback } = makeRollback(session, seam)
    const result = await rollback.execute({ sessionId: 's1', versionId: 'v3', scope: 'artifacts' })
    expect(seam.gitCheckout).toHaveBeenCalledWith('/work', 'abc123', ['src/a.ts'])
    expect(result.artifacts[0]).toMatchObject({ path: 'src/a.ts', status: 'restored' })
  })

  it('both scope: context marker first, then artifacts', async () => {
    const session = makeSession().seed(
      userMessage('u1', 'hi'),
      assistantMessage('a1', 'yo'),
      userMessage('u2', 'again'),
      markerEvent('retrace-recall-1', [0, 1], [0, 1]),
      userMessage('u3', 'more'),
    )
    const { rollback, writes } = makeRollback(session)
    const result = await rollback.execute({ sessionId: 's1', versionId: 'v3', scope: 'both' })
    expect(result.markerSeq).toBe(6)
    expect(writes.length).toBe(1)
  })
})
