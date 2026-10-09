/**
 * Rollback executor unit tests. A fake session is seeded with correctly
 * shaped surface events (every surface-eligible event carries its `surfaceOp`
 * marker — as real durable logs do) so `foldSurface` works; a fake seam /
 * ctx / subprocess stand in for the host services.
 */
import { describe, expect, it, vi } from 'vitest'
import { foldSurface } from '@deepseek-ai/dsh-session'
import { sessionEvents, eventAt } from '../lib/host-compat.js'
import { createRollbackExecutor } from '../lib/rollback.js'
import { carrierTargetSeq, spanRangeOf } from '../lib/marker-carrier.js'
import { makeAgent, makeHooks } from './helpers.js'

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

/**
 * A recall-style marker replacement —— **现役内核 v4 的载体形状**:
 * `user/message` + `{op:'replace',startSeq,endSeq}` + provenance。
 * 旧夹具是 `assistant/message` + `{start,end}` + `data.editor`,在 0.1.7-rc.2
 * (SESSION_FORMAT_VERSION=4)下结构上不可能存在:
 *  · `{start,end}` 被内核 surfaceOpOf/isReplaceOp 判 invalid(lib/index.js:292/307);
 *  · `assistant/message` + `sourceEventSeqs` 被内核直接拒(lib/index.js:312)。
 * 所以"严格 fold 成功"的夹具必须是现役形状,否则测的是退化路径。
 */
function markerEvent(id, span, sourceEventSeqs) {
  return {
    type: 'user/message',
    surfaceOp: { op: 'replace', startSeq: span[0], endSeq: span[span.length - 1] },
    sourceEventSeqs,
    data: {
      id,
      role: 'user',
      content: [{ type: 'text', text: '（此处内容已被撤回：原消息已归档，可在恢复视图中查看）' }],
      source: { kind: 'model', provider: 'test-provider', model: 'test-model' },
    },
  }
}

/**
 * A MALFORMED replacement as found in the user's real large session
 * (seq 33662/33682/…): a third-party `互操作标记-v1-*`
 * marker whose `sourceEventSeqs` embeds a NESTED array pair (`[28324,28334]`).
 * The kernel's provenance validator rejects it
 * (`… sourceEventSeqs must densely contain non-negative safe integers`), which
 * used to poison the whole rollback preview.
 */
function malformedMarkerEvent(id, span, sourceEventSeqs) {
  return {
    type: 'user/message',
    // 现役 v4 键名 —— 否则内核先以 `carries an invalid replace surfaceOp` 拒,
    // 测不到本用例要钉的 provenance 校验(
    // `sourceEventSeqs must densely contain non-negative safe integers`)。
    surfaceOp: { op: 'replace', startSeq: span[0], endSeq: span[span.length - 1] },
    sourceEventSeqs,
    data: { id, role: 'user', content: [{ type: 'text', text: 'folded' }], source: { kind: 'user' } },
  }
}

/** The real-session shape in miniature: u1/a1 replaced by a malformed fold, then u2. */
function malformedSession() {
  return makeSession().seed(
    userMessage('u1', 'hi'),
    assistantMessage('a1', 'yo'),
    malformedMarkerEvent('interop-marker-v1-b5-1790150438469', [0, 1], [0, [1, 2]]),
    userMessage('u2', 'again'),
  )
}

/** The version at the malformed boundary (seq 2): its folded surface is [2]. */
const malformedVersion = { snapshot: () => ({ enabled: true, versions: [versionRecord({ versionId: 'v2', boundarySeq: 2, messageCount: 1 })] }) }

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
        // 区间读取走单一真相 spanRangeOf(双形状):现役 v4 = startSeq/endSeq
        const range = record.surfaceOp ? spanRangeOf(record.surfaceOp) : null
        if (range) {
          surface.nodes = surface.nodes.filter((seq) => seq < range.start || seq > range.end)
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
      const range = options.surfaceOp ? spanRangeOf(options.surfaceOp) : null
      if (range) {
        surface.nodes = surface.nodes.filter((seq) => seq < range.start || seq > range.end)
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
function makeRollback(session, seamOverrides = {}, ctxOverrides = {}, log = () => {}) {
  const { ctx, writes, spawns } = makeCtx()
  const seam = makeSeam(seamOverrides)
  const sessions = { get: (id) => (id === 's1' ? session : undefined), flush: vi.fn(async () => {}) }
  const agents = { get: () => makeAgent() }
  const writeMarker = makeHooks(agents).writeMarker
  const rollback = createRollbackExecutor({ ctx: { ...ctx, ...ctxOverrides }, sessions, seam, writeMarker, log })
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
    // 两段结构：第 1 段（审计）@5、第 2 段（载体）@6（不再有 turn/step 信封）
    expect(result.markerSeq).toBe(6)
    expect(result.context.messages).toBe(1)
    const audit = eventAt(session, 5)
    expect(audit.type).toBe('compaction/prune')
    expect(audit.data.shadowedSeqs).toEqual([4])
    const marker = eventAt(session, 6)
    expect(marker.type).toBe('user/message')
    expect(marker.surfaceOp).toEqual({ op: 'replace', startSeq: 4, endSeq: 4 })
    expect(marker.sourceEventSeqs).toEqual([5, 4])
    // 业务溯源 targetSeq 由区间起点派生（editor 已不再落盘；restore 的边界 seq 3
    // 不等于区间起点 4 ⇒ 该场景读到的派生值是区间起点，见报告「能力损失」一节）
    expect(carrierTargetSeq(marker)).toBe(4)
    expect(marker.data.source.kind).toBe('model')
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

// ---------------------------------------------------------------------------
// 退化路径:
// 用户大会话里 7 条第三方 fold marker 的 `sourceEventSeqs` 嵌了数组(如
// [28324,28334]),内核严格折叠整体抛错 ⇒ preview() 在写任何东西之前就抛,
// 客户端拿到 {ok:false,error:{code:'internal'}}。修法 = 严格折叠失败 → 镜像折叠
// (lib/version-index.js#applyVersionIndex),并打警告;镜像也失败 ⇒ replay-failed。
// ---------------------------------------------------------------------------
describe('rollback replay degradation (malformed sourceEventSeqs)', () => {
  it('夹具自检:该畸形行确实让内核严格折叠抛错(否则下面的退化用例是假绿)', () => {
    const session = malformedSession()
    expect(() => foldSurface(sessionEvents(session).slice(0, 3)))
      .toThrow(/sourceEventSeqs must densely contain non-negative safe integers/)
  })

  it('preview 不再抛错:镜像折叠算出同一份 diff,并打「严格折叠失败→镜像回退」警告', async () => {
    const session = malformedSession()
    const lines = []
    const { rollback } = makeRollback(session, malformedVersion, {}, (line) => lines.push(line))
    const result = await rollback.preview({ sessionId: 's1', versionId: 'v2', scope: 'context' })
    expect(result.versionId).toBe('v2')
    expect(result.context.messages).toBe(1)
    expect(result.context.diff).toEqual([3]) // 目标面 [2] 之外的当前面节点 = u2@3
    expect(result.context.firstSeq).toBe(3)
    expect(result.context.lastSeq).toBe(3)
    expect(result.context.degraded).toBe(true)
    expect(result.applicable).toBe(true)
    const warning = lines.find((line) => line.includes('严格折叠失败→镜像回退'))
    expect(warning, `no degradation warning in: ${JSON.stringify(lines)}`).toBeDefined()
    expect(warning).toContain('densely contain') // 原始错误信息必须在日志里
  })

  it('execute 在退化路径下仍写出 restore marker 并报告 degraded', async () => {
    const session = malformedSession()
    const lines = []
    const { rollback, sessions } = makeRollback(session, malformedVersion, {}, (line) => lines.push(line))
    const result = await rollback.execute({ sessionId: 's1', versionId: 'v2', scope: 'context' })
    // 审计段 @4 + 载体段 @5(与既有 execute 用例同一两段结构)
    expect(result.markerSeq).toBe(5)
    expect(result.context).toEqual({ messages: 1, degraded: true })
    const marker = eventAt(session, 5)
    expect(marker.type).toBe('user/message')
    expect(marker.surfaceOp).toEqual({ op: 'replace', startSeq: 3, endSeq: 3 })
    expect(sessions.flush).toHaveBeenCalled()
    expect(lines.some((line) => line.includes('已退化到镜像折叠'))).toBe(true)
  })

  it('退化 diff 只遮蔽镜像也认得的节点:镜像表看不见的 developer/message 不误伤(安全侧)', async () => {
    // 真机读数:内核把 `developer/message` 当表面事件,而镜像表
    // (lib/version-index.js:55)不含它 ⇒ 直接相减会多遮蔽 2 个节点(18 vs 真值 16)。
    // 修法 = 与"镜像自己的当前面"求交:看不见的节点保持可见,绝不误藏。
    const session = malformedSession()
    session.appendRaw({
      type: 'developer/message',
      surfaceOp: 'append',
      data: { id: 'd1', role: 'developer', content: [{ type: 'text', text: 'blind node' }] },
    })
    const lines = []
    const { rollback } = makeRollback(session, malformedVersion, {}, (line) => lines.push(line))
    const result = await rollback.preview({ sessionId: 's1', versionId: 'v2', scope: 'context' })
    expect(session.surface.nodes).toEqual([2, 3, 4]) // 活面确实含镜像看不见的 4
    expect(result.context.diff).toEqual([3]) // 4 不被遮蔽
    expect(result.context.degraded).toBe(true)
    expect(lines.some((line) => line.includes('blindExcluded=1'))).toBe(true) // 不静默:读数进日志
  })

  it('镜像回退也失败 → 结构化 replay-failed(不是笼统 internal),且零写入', async () => {
    const session = malformedSession()
    const before = session.events.length
    const lines = []
    const { ctx } = makeCtx()
    const sessions = { get: (id) => (id === 's1' ? session : undefined), flush: vi.fn(async () => {}) }
    const rollback = createRollbackExecutor({
      ctx,
      sessions,
      seam: makeSeam(malformedVersion),
      writeMarker: makeHooks({ get: () => makeAgent() }).writeMarker,
      log: (line) => lines.push(line),
      applyIndex: () => { throw new Error('mirror exploded') },
    })
    const rejected = await rollback.preview({ sessionId: 's1', versionId: 'v2', scope: 'context' })
      .then(() => null, (error) => error)
    expect(rejected?.code).toBe('replay-failed')
    expect(rejected.message).toContain('densely contain') // 原始原因
    expect(rejected.message).toContain('畸形 sourceEventSeqs') // 建议
    expect(rejected.details).toMatchObject({ boundarySeq: 2, versionId: 'v2', mirrorError: 'mirror exploded' })
    expect(session.events.length).toBe(before) // 一个字节都没写
    expect(lines.some((line) => line.includes('镜像回退亦失败'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 预览的 idle 闸(与 execute 同口径)。
// 缺陷(独立审计实测):execute() 有 requireIdle,preview() 没有 ⇒ 运行中预览
// 「成功/可回档」、点确认才被 agent-busy 拒 —— 用户看到「预览说行、确认说不行」。
// 修法 = preview() 调同一个 requireIdle,code/文案与 execute 逐字一致。
// ---------------------------------------------------------------------------
describe('rollback preview idle gate (parity with execute)', () => {
  /** 运行中的 agent 桩:seam.agentOf 返回 {status:'running'}。 */
  const runningAgent = { agentOf: () => ({ status: 'running' }) }

  /** 与既有 preview 用例同一夹具:boundary 3 之后还有 u3@4 可回退。 */
  function previewSession() {
    return makeSession().seed(
      userMessage('u1', 'hi'),
      assistantMessage('a1', 'yo'),
      userMessage('u2', 'again'),
      markerEvent('retrace-recall-1', [0, 1], [0, 1]),
      userMessage('u3', 'more'),
    )
  }

  it('运行中 preview 被拒为 agent-busy(与 execute 同 code/同文案),且零副作用', async () => {
    const session = previewSession()
    const before = session.events.length
    const { rollback, seam, writes, spawns, sessions } = makeRollback(session, runningAgent)

    const previewError = await rollback.preview({ sessionId: 's1', versionId: 'v3', scope: 'both' })
      .then(() => null, (error) => error)
    expect(previewError?.code).toBe('agent-busy')

    // 文案口径:与 execute 同一句(逐字相等,防止两条闸各自演化)
    const executeError = await rollback.execute({ sessionId: 's1', versionId: 'v3', scope: 'both' })
      .then(() => null, (error) => error)
    expect(executeError?.code).toBe('agent-busy')
    expect(previewError.message).toBe(executeError.message)

    // 副作用为零:没有事件、没有 fs 写、没有 rm、没有 git、没有 flush
    expect(session.events.length).toBe(before)
    expect(session.surface.nodes).toEqual([2, 3, 4])
    expect(writes.length).toBe(0)
    expect(spawns.length).toBe(0)
    expect(seam.resolveSnapshot).not.toHaveBeenCalled()
    expect(seam.readSnapshot).not.toHaveBeenCalled()
    expect(seam.gitStatus).not.toHaveBeenCalled()
    expect(seam.gitCheckout).not.toHaveBeenCalled()
    expect(sessions.flush).not.toHaveBeenCalled()
  })

  it('空闲 preview 结果逐字段不变(versionId/diff/messages/artifacts 同旧断言)', async () => {
    const session = previewSession()
    const { rollback, seam } = makeRollback(session) // agentOf 默认 undefined ⇒ 无运行中 agent
    const result = await rollback.preview({ sessionId: 's1', versionId: 'v3', scope: 'both' })
    expect(result).toEqual({
      versionId: 'v3',
      kind: 'recall',
      boundarySeq: 3,
      scope: 'both',
      context: { messages: 1, diff: [4], firstSeq: 4, lastSeq: 4, degraded: false },
      artifacts: {
        rows: [{ path: 'src/a.ts', action: 'restore', method: 'snapshot', safe: true }],
        git: { enabled: false },
      },
      applicable: true,
    })
    expect(seam.resolveSnapshot).toHaveBeenCalledWith('v3', 'src/a.ts')
    expect(session.events.length).toBe(5) // 预览不写任何东西
  })

  it('agent 存在但状态不是 running(如 idle)⇒ 预览照旧放行(不过度拦截)', async () => {
    const session = previewSession()
    const { rollback } = makeRollback(session, { agentOf: () => ({ status: 'idle' }) })
    const result = await rollback.preview({ sessionId: 's1', versionId: 'v3', scope: 'both' })
    expect(result.context.messages).toBe(1)
    expect(result.applicable).toBe(true)
  })
})
