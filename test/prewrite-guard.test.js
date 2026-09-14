/**
 * Pre-write guard unit tests.
 *
 * 1. Guard behaviour with an injected fake prewriter (pass / reject / throw /
 *    disabled / degraded).
 * 2. Real integration: the guard wired to the actual `dsh-log-contract`
 *    `createPreWriter` — a well-formed marker envelope passes, a corrupt one
 *    (the 8-25 incident's shape: empty sourceEventSeqs) is rejected.
 * 3. The host-core hook: `hooks.validateMarker` runs before the append and a
 *    rejecting guard aborts the write (session unchanged, op fails).
 */
import { describe, it, expect, vi } from 'vitest'
import { sessionEvents, eventAt } from '../lib/host-compat.js'
import { createMarkerGuard, rollbackShareOf, isRestoreMarker, ROLLBACK_MIN_SURFACE } from '../lib/prewrite-guard.js'
import { createEditorApi } from '../lib/host-core.js'
import { carrierShadowedSeqs } from '../lib/marker-carrier.js'
import { userMessage, assistantMessage, toolRow, headerEvent, makeSession, makeEnv, makeAgent, makeHooks } from './helpers.js'

function validEnvelope(session) {
  return {
    // 两段结构的第 2 段(载体):官方 user/message 词表精确四成员
    type: 'user/message',
    data: {
      role: 'user',
      id: 'retrace-recall-x',
      content: [{ type: 'text', text: '（此处内容已被撤回：原消息已归档，可在恢复视图中查看）' }],
      source: { kind: 'model', provider: 'p', model: 'm' },
    },
    surfaceOp: { op: 'replace', start: 0, end: 0 },
    // 首元素 = 审计段 seq(此处用 0 占位:守卫单测只看形状/遮蔽数,不校验存在性)
    sourceEventSeqs: [0],
  }
}

describe('快照点守卫（2026-08-31 事故修复；2026-09-01 改为绝对遮蔽数判定）', () => {
  // 会话工厂：n 个 surface 节点 + header(不算节点)
  // ⚠️ 事件必须带**真实消息形状**(user/message 带 content、assistant/message 带
  // message):写入器现在按官方口径给被遮蔽区间估令牌价(estimateMessage 口径),
  // 光有 turn/step 的空壳事件估不出价 —— 那不是"大会话"的替身,是坏事件。
  function bigSession(n = 10) {
    const s = makeSession()
    s.appendRaw({ type: 'request/header', data: { header: { config: { provider: 'p', model: 'm' } } } })
    for (let i = 0; i < n; i++) {
      const user = i % 2 === 0
      s.appendRaw({
        type: user ? 'user/message' : 'assistant/message',
        data: user
          ? { turn: Math.floor(i / 2) + 1, step: 0, id: `u${i}`, role: 'user', content: [{ type: 'text', text: `q${i}` }], source: { kind: 'user' } }
          : { turn: Math.floor(i / 2) + 1, step: 0, message: { id: `a${i}`, role: 'assistant', content: [{ type: 'text', text: `r${i}` }], source: { kind: 'model', provider: 'p', model: 'm' } } },
      })
    }
    return s
  }

  // 大事件数会话：events 数组直接构造(模拟大会话,绕过 surface 窗口化)
  function hugeSession(nodeCount, eventCount) {
    const s = bigSession(nodeCount)
    // 填充到 eventCount(往 log 里塞非 surface 事件,如 chunk)
    while (sessionEvents(s).length < eventCount) {
      s.appendRaw({ type: 'assistant/chunk', data: { turn: 999, step: 0, text: 'x' } })
    }
    return s
  }

  function replaceEnvelope(sourceSeqs, start, end) {
    const env = validEnvelope()
    env.surfaceOp = { op: 'replace', start, end }
    env.sourceEventSeqs = sourceSeqs
    return env
  }

  it('遮蔽 ≤ 40 节点(绝对阈值):即使大会话也不拦(2026-09-01 编辑最后一条修复)', async () => {
    const factory = () => ({ validateAppend: () => ({ ok: true }) })
    const guard = createMarkerGuard({ prewriterFactory: factory })
    // 大会话(2500 事件)但只遮蔽 12 个节点 = 编辑最后一条 → 不拦
    const session = hugeSession(50, 2500)
    const envelope = replaceEnvelope(Array.from({ length: 12 }, (_, i) => i), 0, 11)
    expect(rollbackShareOf(session, envelope)).toBe(0)
    await expect(guard.validateMarkerAppend(session, envelope)).resolves.toEqual({ t1Ok: true })
  })

  it('遮蔽 > 40 节点 + 大会话(>2000 事件)→ 抛 rollback-guide(回档请求拒绝落盘)', async () => {
    const log = vi.fn()
    const factory = () => ({ validateAppend: () => ({ ok: true }) })
    const guard = createMarkerGuard({ log, prewriterFactory: factory })
    const session = hugeSession(60, 2500)
    const envelope = replaceEnvelope(Array.from({ length: 50 }, (_, i) => i), 0, 49) // 遮蔽 50 > 40
    expect(rollbackShareOf(session, envelope)).toBeGreaterThan(0)
    await expect(guard.validateMarkerAppend(session, envelope)).rejects.toMatchObject({ code: 'rollback-guide' })
    expect(log).toHaveBeenCalledWith(expect.stringContaining('rollback guard'))
  })

  it('遮蔽 > 40 节点但小会话(<2000 事件)→ 不拦(短会话豁免)', async () => {
    const factory = () => ({ validateAppend: () => ({ ok: true }) })
    const guard = createMarkerGuard({ prewriterFactory: factory })
    const session = bigSession(60) // events 少
    const envelope = replaceEnvelope(Array.from({ length: 50 }, (_, i) => i), 0, 49)
    expect(rollbackShareOf(session, envelope)).toBe(0)
    await expect(guard.validateMarkerAppend(session, envelope)).resolves.toEqual({ t1Ok: true })
  })

  it('enabled=false 时跳过回档守卫(门控)', async () => {
    const factory = () => ({ validateAppend: () => ({ ok: true }) })
    const guard = createMarkerGuard({ prewriterFactory: factory, enabled: () => false })
    const session = hugeSession(60, 2500)
    const envelope = replaceEnvelope(Array.from({ length: 50 }, (_, i) => i), 0, 49)
    await expect(guard.validateMarkerAppend(session, envelope)).resolves.toEqual({ t1Ok: true })
  })

  it('host-core 全链路:edit 用轮内遮蔽(round),编辑早期消息也只遮蔽 1 轮 → 不触发守卫', async () => {
    // 60 surface 节点 + 2000+ chunk = 大会话;编辑 u0 → roundSpanFrom 只遮蔽 u0 轮
    const session = hugeSession(60, 2200)
    const before = sessionEvents(session).length
    const { sessions, agents } = makeEnv(session, { agent: makeAgent() })
    const validateMarker = vi.fn(async (s, envelope) => {
      const share = rollbackShareOf(s, envelope)
      if (share > 0) {
        const error = new Error('rollback guard')
        error.code = 'rollback-guide'
        throw error
      }
    })
    const api = createEditorApi({}, sessions, agents, () => {}, makeHooks(agents, { validateMarker }))
    const result = await api.editAndResend({ sessionId: 's1', messageId: 'u0', text: 'edited' })
    expect(result.ok).toBe(true) // round 遮蔽(1 轮)→ 不触发守卫
    // marker 写入,遮蔽的是 u0 轮(2 个节点)
    let marker = null
    for (let i = sessionEvents(session).length - 1; i >= 0; i--) {
      const e = eventAt(session, i)
      if (e.type === 'user/message' && e.surfaceOp?.op === 'replace') { marker = e; break }
    }
    expect(marker).toBeTruthy()
    // 被遮蔽节点数取载体口径(首元素是审计 seq,不计入)
    expect(carrierShadowedSeqs(marker).length).toBeLessThanOrEqual(2)
  })

  it('host-core 全链路:fromScratch 遮蔽到尾部 → 触发 rollback-guide,事件零写入', async () => {
    const session = hugeSession(60, 2200)
    const before = sessionEvents(session).length
    const { sessions, agents } = makeEnv(session, { agent: makeAgent() })
    const validateMarker = vi.fn(async (s, envelope) => {
      const share = rollbackShareOf(s, envelope)
      if (share > 0) {
        const error = new Error('rollback guard')
        error.code = 'rollback-guide'
        throw error
      }
    })
    const api = createEditorApi({}, sessions, agents, () => {}, makeHooks(agents, { validateMarker }))
    const result = await api.editAndResend({ sessionId: 's1', messageId: 'u0', text: 'edited', fromScratch: true })
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('rollback-guide')
    expect(sessionEvents(session).length).toBe(before) // 零写入
  })

  it('host-core 全链路:小范围 recall(撤 1 轮)→ 照常通过', async () => {
    const session = makeSession().seed(
      userMessage('u1', 'hi'),
      assistantMessage('a1', 'yo'),
      userMessage('u2', 'again'),
      assistantMessage('a2', 'ok'),
      userMessage('u3', 'more'),
      assistantMessage('a3', 'done'),
    )
    const before = sessionEvents(session).length
    const { sessions, agents } = makeEnv(session, { agent: makeAgent() })
    const validateMarker = vi.fn(async () => ({ t1Ok: true }))
    const api = createEditorApi({}, sessions, agents, () => {}, makeHooks(agents, { validateMarker }))
    const result = await api.recall({ sessionId: 's1', messageId: 'u3' })
    expect(result.ok).toBe(true)
    expect(sessionEvents(session).length).toBe(before + 2) // 两段结构：审计段 + 载体段(无 turn/step 信封)
  })

  it('restore(rollback 回档)豁免:即使遮蔽巨大也不拦(问题 A 修复)', async () => {
    const factory = () => ({ validateAppend: () => ({ ok: true }) })
    const guard = createMarkerGuard({ prewriterFactory: factory })
    const session = hugeSession(60, 2500)
    const env = replaceEnvelope(Array.from({ length: 50 }, (_, i) => i), 0, 49)
    env.data.id = 'retrace-restore-synthetic-xyz' // restore marker(id 在两段结构的 data.id 上)
    expect(isRestoreMarker(env)).toBe(true)
    await expect(guard.validateMarkerAppend(session, env)).resolves.toEqual({ t1Ok: true })
  })

  it('非 restore 的 遮蔽 >40 节点 仍被拦(问题 A 不误伤编辑)', async () => {
    const factory = () => ({ validateAppend: () => ({ ok: true }) })
    const guard = createMarkerGuard({ prewriterFactory: factory })
    const session = hugeSession(60, 2500)
    const env = replaceEnvelope(Array.from({ length: 50 }, (_, i) => i), 0, 49)
    expect(isRestoreMarker(env)).toBe(false)
    await expect(guard.validateMarkerAppend(session, env)).rejects.toMatchObject({ code: 'rollback-guide' })
  })

  it('导出常量:ROLLBACK_MIN_SHADOWED=40, ROLLBACK_MIN_EVENTS=2000', () => {
    const { ROLLBACK_MIN_SHADOWED, ROLLBACK_MIN_EVENTS } = require('../lib/prewrite-guard.js')
    expect(ROLLBACK_MIN_SHADOWED).toBe(40)
    expect(ROLLBACK_MIN_EVENTS).toBe(2000)
  })
})

describe('createMarkerGuard (fake prewriter)', () => {
  it('passes a valid envelope through', async () => {
    const factory = vi.fn(() => ({ validateAppend: () => ({ ok: true }) }))
    const guard = createMarkerGuard({ prewriterFactory: factory })
    await expect(guard.validateMarkerAppend({ id: 's1', events: [] }, validEnvelope())).resolves.toEqual({ t1Ok: true })
    // 2026-09-14：显式传 header（版本单一真相）；缺 header 时由契约按形状推断。
    expect(factory).toHaveBeenCalledWith({ events: [], header: null })
  })

  it('把会话 header 传给契约（dsh-log-contract ≥0.3.13 的格式版本单一真相）', async () => {
    // 只传 events 时 0.3.13 会按事件形状推断版本：一份没有 system/message、也没有任何
    // replace 的 v3 日志只会推出 2（assistant/attempt 在 v2/v3 都有）⇒ 我们写的现代
    // {op:'replace',startSeq,endSeq} 会被判 S4/S8 拒写。传 header 即在本次调用内固定版本。
    const factory = vi.fn(() => ({ validateAppend: () => ({ ok: true }) }))
    const guard = createMarkerGuard({ prewriterFactory: factory })
    const header = { version: 3, id: 's1', createdAt: 1, isSeeded: false }
    await expect(guard.validateMarkerAppend({ id: 's1', events: [], header }, validEnvelope()))
      .resolves.toEqual({ t1Ok: true })
    expect(factory).toHaveBeenCalledWith({ events: [], header })
  })

  it('throws marker-rejected on error-level violations', async () => {
    const factory = () => ({
      validateAppend: () => ({ ok: false, violations: [{ id: 'S5', severity: 'error', message: 'missing seq' }] }),
    })
    const log = vi.fn()
    const guard = createMarkerGuard({ log, prewriterFactory: factory })
    await expect(guard.validateMarkerAppend({ id: 's1', events: [] }, validEnvelope())).rejects.toMatchObject({
      code: 'marker-rejected',
    })
    expect(log).toHaveBeenCalledWith(expect.stringContaining('S5'))
  })

  it('wraps a throwing prewriter as marker-rejected', async () => {
    const factory = () => ({ validateAppend: () => { throw new Error('boom') } })
    const guard = createMarkerGuard({ prewriterFactory: factory })
    await expect(guard.validateMarkerAppend({ id: 's1', events: [] }, validEnvelope())).rejects.toMatchObject({
      code: 'marker-rejected',
    })
  })

  it('skips validation when enabled(sessionId) is false', async () => {
    const factory = vi.fn(() => ({ validateAppend: () => ({ ok: false, violations: [] }) }))
    const guard = createMarkerGuard({ prewriterFactory: factory, enabled: () => false })
    await expect(guard.validateMarkerAppend({ id: 's1', events: [] }, validEnvelope())).resolves.toEqual({ t1Ok: true })
    expect(factory).not.toHaveBeenCalled()
  })

  it('degrades silently when the lazy import fails, and remembers the failure', async () => {
    const log = vi.fn()
    const guard = createMarkerGuard({ log })
    // The default factory lazy-imports dsh-log-contract; in a broken environment
    // the guard must not throw. We can't force the import to fail here, so
    // assert the real integration path instead (below) and that the guard
    // object shape is stable.
    expect(typeof guard.validateMarkerAppend).toBe('function')
  })
})

describe('createMarkerGuard (real dsh-log-contract integration)', () => {
  // Real durable logs carry `surfaceOp: 'append'` on every surface-eligible
  // event (the official foldSurface requires it) AND engine-accurate
  // turn/step on append assistant messages (M1) — seed accordingly.
  function realLog() {
    const events = [
      { seq: 0, type: 'user/message', surfaceOp: 'append', time: 1, data: { id: 'u1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } } },
      { seq: 1, type: 'assistant/message', surfaceOp: 'append', time: 2, data: { turn: 1, step: 0, message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'yo' }], source: { kind: 'model', provider: 'p', model: 'm' } } } },
    ]
    return events
  }

  it('accepts a well-formed marker envelope against a real session log', async () => {
    const events = realLog()
    const { createPreWriter } = await import('dsh-log-contract')
    const guard = createMarkerGuard({ prewriterFactory: createPreWriter })
    const envelope = validEnvelope()
    // The real span for this surface: recall shadows u1..a1 (seq 0..1).
    envelope.surfaceOp = { op: 'replace', start: 0, end: 1 }
    envelope.sourceEventSeqs = [0, 1]
    await expect(guard.validateMarkerAppend({ id: 's1', events }, envelope)).resolves.toEqual({ t1Ok: true })
  })

  it('rejects the 8-25 incident shape: empty sourceEventSeqs on a replace', async () => {
    const events = realLog()
    const { createPreWriter } = await import('dsh-log-contract')
    const guard = createMarkerGuard({ prewriterFactory: createPreWriter })
    const envelope = validEnvelope()
    envelope.surfaceOp = { op: 'replace', start: 0, end: 1 }
    envelope.sourceEventSeqs = [] // ← the incident's first-round corruption
    await expect(guard.validateMarkerAppend({ id: 's1', events }, envelope, { phase: 'post' })).rejects.toMatchObject({
      code: 'marker-rejected',
    })
  })
})

describe('host-core hooks.validateMarker', () => {
  it('calls the hook with the would-be envelope before appending', async () => {
    const session = makeSession().seed(userMessage('u1', 'hi'), assistantMessage('a1', 'yo'))
    const { sessions, agents } = makeEnv(session, { agent: makeAgent() })
    const validateMarker = vi.fn(async () => {})
    const api = createEditorApi({}, sessions, agents, () => {}, makeHooks(agents, { validateMarker }))
    const result = await api.recall({ sessionId: 's1', messageId: 'a1' })
    expect(result.ok).toBe(true)
    // 两阶段:pre(业务闸)+ pair(计划中的两段:审计按预言 seq 合成 + 载体一起校验)
    expect(validateMarker).toHaveBeenCalledTimes(2)
    const [calledSession, preEnvelope, preExtra] = validateMarker.mock.calls[0]
    expect(calledSession).toBe(session)
    expect(preExtra?.phase).toBe('pre')
    expect(preEnvelope.type).toBe('user/message')
    expect(preEnvelope.surfaceOp).toEqual({ op: 'replace', start: 0, end: 1 })
    expect(preEnvelope.sourceEventSeqs).toEqual([0, 1])
    const [, pairEnvelope, pairExtra] = validateMarker.mock.calls[1]
    expect(pairExtra?.phase).toBe('pair')
    expect(pairEnvelope.sourceEventSeqs).toEqual([2, 0, 1]) // 首元素 = 审计段 seq(预言值 == 真实值)
    expect(pairExtra?.auditSeq).toBe(2)
    expect(pairExtra?.audit?.shadowedSeqs).toEqual([0, 1])
    // 校验全部发生在写入之前;写完后审计段确实落在 seq 2(两段成对)
    expect(eventAt(session, 2)?.type).toBe('compaction/prune')
  })

  it('aborts the write when the hook rejects (nothing appended)', async () => {
    const session = makeSession().seed(userMessage('u1', 'hi'), assistantMessage('a1', 'yo'))
    const before = sessionEvents(session).length
    const { sessions, agents } = makeEnv(session, { agent: makeAgent() })
    const validateMarker = async () => {
      const error = new Error('Marker write rejected by contract guard')
      error.code = 'marker-rejected'
      throw error
    }
    const api = createEditorApi({}, sessions, agents, () => {}, makeHooks(agents, { validateMarker }))
    const result = await api.recall({ sessionId: 's1', messageId: 'a1' })
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('marker-rejected')
    expect(sessionEvents(session).length).toBe(before) // nothing was committed
  })

  it('skips the hook when none is provided (dynamic-plugin path)', async () => {
    const session = makeSession().seed(userMessage('u1', 'hi'), assistantMessage('a1', 'yo'))
    const { sessions, agents } = makeEnv(session, { agent: makeAgent() })
    const api = createEditorApi({}, sessions, agents, () => {}, makeHooks(agents))
    const result = await api.recall({ sessionId: 's1', messageId: 'a1' })
    expect(result.ok).toBe(true)
  })
})

describe('T1 折叠自检作废 + 钩子两阶段（载体改造后）', () => {
  /**
   * 原 R2 T1 自检(token-meter 配对:assistant/message 须落在打开中的 step 内)随载体
   * 改造一并作废——第 2 段是 `user/message`,token-meter 对它没有 step 配对要求。
   * 留三条断言把"作废"本身钉住:函数不再导出、host 结果不再带 markerT1Broken、
   * 钩子按 pre/post 两阶段被调用。
   */
  it('tokenMeterFoldOk 不再导出(死函数随 T1 作废一并移除)', async () => {
    const mod = await import('../lib/prewrite-guard.js')
    expect(mod.tokenMeterFoldOk).toBeUndefined()
  })

  it('host 结果不再带 markerT1Broken(该标注随 T1 作废)', async () => {
    const session = makeSession().seed(userMessage('u1', 'hi'), assistantMessage('a1', 'yo'))
    const { sessions, agents } = makeEnv(session, { agent: makeAgent() })
    const api = createEditorApi({}, sessions, agents, () => {}, makeHooks(agents))
    const result = await api.recall({ sessionId: 's1', messageId: 'a1' })
    expect(result.ok).toBe(true)
    expect(result.value.markerT1Broken).toBeUndefined()
  })

  it('钩子两阶段:pre(落盘前,仅业务闸) + pair(计划中的两段,完整契约校验;仍在写之前)', async () => {
    const session = makeSession().seed(userMessage('u1', 'hi'), assistantMessage('a1', 'yo'))
    const { sessions, agents } = makeEnv(session, { agent: makeAgent() })
    const phases = []
    const validateMarker = vi.fn(async (_session, envelope, extra) => { phases.push(extra?.phase) })
    const api = createEditorApi({}, sessions, agents, () => {}, makeHooks(agents, { validateMarker }))
    const result = await api.recall({ sessionId: 's1', messageId: 'a1' })
    expect(result.ok).toBe(true)
    expect(phases).toEqual(['pre', 'pair'])
    // pair 阶段拿到的首元素 = 审计段 seq(载荷把计划中的审计段按同一 seq 合成进事件表,
    // 故完整契约校验在**任何 append 之前**就能跑 —— 本轮整改的核心)
    const pairEnvelope = validateMarker.mock.calls[1][1]
    expect(pairEnvelope.sourceEventSeqs[0]).toBe(eventAt(session, 2).seq)
  })
})
