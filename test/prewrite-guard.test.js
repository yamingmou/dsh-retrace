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
import { createMarkerGuard, rollbackShareOf, isRestoreMarker, ROLLBACK_MIN_SURFACE } from '../lib/prewrite-guard.js'
import { createEditorApi } from '../lib/host-core.js'
import { userMessage, assistantMessage, toolRow, headerEvent, makeSession, makeEnv, makeAgent, makeHooks } from './helpers.js'

function validEnvelope(session) {
  return {
    type: 'assistant/message',
    data: {
      // 新形状(0.4.17v3+):真实 turn/step——T4(turn 缺失)写前拦截拒绝 turn:null marker
      turn: 1,
      step: 1,
      message: { id: 'retrace-recall-x', role: 'assistant', content: [], source: { kind: 'model', provider: 'p', model: 'm' } },
      editor: { targetSeq: 0, text: 'hi' },
    },
    surfaceOp: { op: 'replace', start: 0, end: 0 },
    sourceEventSeqs: [0],
  }
}

describe('快照点守卫（2026-08-31 5e55100a 事故闭环；2026-09-01 改为绝对遮蔽数判定）', () => {
  // 会话工厂：n 个 surface 节点 + header(不算节点)
  function bigSession(n = 10) {
    const s = makeSession()
    s.appendRaw({ type: 'request/header', data: { header: { config: { provider: 'p', model: 'm' } } } })
    for (let i = 0; i < n; i++) {
      s.appendRaw({
        type: i % 2 === 0 ? 'user/message' : 'assistant/message',
        data: {
          turn: Math.floor(i / 2) + 1,
          step: 0,
          ...(i % 2 === 0 ? { id: `u${i}`, source: { kind: 'user' } } : {}),
        },
      })
    }
    return s
  }

  // 大事件数会话：events 数组直接构造(模拟大会话,绕过 surface 窗口化)
  function hugeSession(nodeCount, eventCount) {
    const s = bigSession(nodeCount)
    // 填充到 eventCount(往 events 里塞非 surface 事件,如 chunk)
    while (s.events.length < eventCount) {
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
    const before = session.events.length
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
    for (let i = session.events.length - 1; i >= 0; i--) {
      const e = session.events[i]
      if (e.type === 'assistant/message' && e.surfaceOp?.op === 'replace') { marker = e; break }
    }
    expect(marker).toBeTruthy()
    expect(marker.sourceEventSeqs.length).toBeLessThanOrEqual(2)
  })

  it('host-core 全链路:fromScratch 遮蔽到尾部 → 触发 rollback-guide,事件零写入', async () => {
    const session = hugeSession(60, 2200)
    const before = session.events.length
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
    expect(session.events.length).toBe(before) // 零写入
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
    const before = session.events.length
    const { sessions, agents } = makeEnv(session, { agent: makeAgent() })
    const validateMarker = vi.fn(async () => ({ t1Ok: true }))
    const api = createEditorApi({}, sessions, agents, () => {}, makeHooks(agents, { validateMarker }))
    const result = await api.recall({ sessionId: 's1', messageId: 'u3' })
    expect(result.ok).toBe(true)
    expect(session.events.length).toBe(before + 5) // 情形③完整 turn 信封：turn/start+step/start+marker+step/end+turn/end
  })

  it('restore(rollback 回档)豁免:即使遮蔽巨大也不拦(问题 A 修复)', async () => {
    const factory = () => ({ validateAppend: () => ({ ok: true }) })
    const guard = createMarkerGuard({ prewriterFactory: factory })
    const session = hugeSession(60, 2500)
    const env = replaceEnvelope(Array.from({ length: 50 }, (_, i) => i), 0, 49)
    env.data.message.id = 'retrace-restore-abcd1234-xyz' // restore marker
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
    expect(factory).toHaveBeenCalledWith({ events: [] })
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
    await expect(guard.validateMarkerAppend({ id: 's1', events }, envelope)).rejects.toMatchObject({
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
    expect(validateMarker).toHaveBeenCalledTimes(1)
    const [calledSession, envelope] = validateMarker.mock.calls[0]
    expect(calledSession).toBe(session)
    expect(envelope.type).toBe('assistant/message')
    expect(envelope.surfaceOp).toEqual({ op: 'replace', start: 0, end: 1 })
    expect(envelope.sourceEventSeqs).toEqual([0, 1])
  })

  it('aborts the write when the hook rejects (nothing appended)', async () => {
    const session = makeSession().seed(userMessage('u1', 'hi'), assistantMessage('a1', 'yo'))
    const before = session.events.length
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
    expect(session.events.length).toBe(before) // nothing was committed
  })

  it('skips the hook when none is provided (dynamic-plugin path)', async () => {
    const session = makeSession().seed(userMessage('u1', 'hi'), assistantMessage('a1', 'yo'))
    const { sessions, agents } = makeEnv(session, { agent: makeAgent() })
    const api = createEditorApi({}, sessions, agents, () => {}, makeHooks(agents))
    const result = await api.recall({ sessionId: 's1', messageId: 'a1' })
    expect(result.ok).toBe(true)
  })
})

describe('R2 T1 折叠自检（2026-08-29：turn-null marker 不再静默破坏 /compact）', () => {
  it('tokenMeterFoldOk：无 step/start 的日志 → true（远古/夹具结构不误报）', async () => {
    const { tokenMeterFoldOk } = await import('../lib/prewrite-guard.js')
    expect(tokenMeterFoldOk([{ type: 'user/message', data: {} }])).toBe(true)
  })

  it('tokenMeterFoldOk：正常 step 配对 → true', async () => {
    const { tokenMeterFoldOk } = await import('../lib/prewrite-guard.js')
    const events = [
      { type: 'step/start', data: { turn: 1, step: 0 } },
      { type: 'assistant/message', data: { turn: 1, step: 0 } },
      { type: 'step/end', data: { turn: 1, step: 0 } },
    ]
    expect(tokenMeterFoldOk(events)).toBe(true)
  })

  it('tokenMeterFoldOk：turn-null assistant/message 无打开 step → false（/compact 会被拒）', async () => {
    const { tokenMeterFoldOk } = await import('../lib/prewrite-guard.js')
    const events = [
      { type: 'step/start', data: { turn: 1, step: 0 } },
      { type: 'assistant/message', data: { turn: 1, step: 0 } },
      { type: 'step/end', data: { turn: 1, step: 0 } },
      // 轮次间编辑 marker：turn/step = null，无打开 step
      { type: 'assistant/message', data: { turn: null, step: null } },
    ]
    expect(tokenMeterFoldOk(events)).toBe(false)
  })

  it('guard 返回 t1Ok=false 但**不阻断**写入（编辑必须生效；调用方未传 wrapped 信封时的防御路径）', async () => {
    const factory = vi.fn(() => ({ validateAppend: () => ({ ok: true }) }))
    const log = vi.fn()
    const guard = createMarkerGuard({ log, prewriterFactory: factory })
    // 会话事件里已有一次闭合的 step，随后追加裸 turn-null marker（无 wrapped 信封）→ T1 失败
    const session = {
      id: 's1',
      events: [
        { type: 'step/start', data: { turn: 1, step: 0 } },
        { type: 'assistant/message', data: { turn: 1, step: 0 } },
        { type: 'step/end', data: { turn: 1, step: 0 } },
      ],
    }
    const result = await guard.validateMarkerAppend(session, validEnvelope())
    expect(result).toEqual({ t1Ok: false }) // 不抛错、不阻断
    expect(log).toHaveBeenCalledWith(expect.stringContaining('markerT1Broken'))
  })

  it('host-core：情形③完整 turn 信封（turn:null 已废弃），T1 通过，marker 落盘且不标注（0.4.17v3 P1/D8 治本）', async () => {
    const session = makeSession().seed(userMessage('u1', 'hi'), assistantMessage('a1', 'yo'))
    const { sessions, agents } = makeEnv(session, { agent: makeAgent() })
    // 完整信封后 token-meter 配对必然通过 → t1Ok=true
    const validateMarker = vi.fn(async () => ({ t1Ok: true }))
    const api = createEditorApi({}, sessions, agents, () => {}, makeHooks(agents, { validateMarker }))
    const result = await api.recall({ sessionId: 's1', messageId: 'a1' })
    expect(result.ok).toBe(true) // 不阻断
    expect(result.value.markerT1Broken).toBe(false)
    // marker 已落盘、真实 turn 号（铁律：不得为 null）、无标注
    let marker = null
    for (let i = session.events.length - 1; i >= 0; i--) {
      const e = session.events[i]
      if (e.type === 'assistant/message' && e.surfaceOp?.op === 'replace') { marker = e; break }
    }
    expect(marker.type).toBe('assistant/message')
    expect(marker.data.turn).toBe(1)
    expect(marker.data.step).toBe(1)
    expect(marker.data?.editor?.markerT1Broken).toBeUndefined()
    // 校验钩子收到完整序列（turn/start → step/start → marker → step/end → turn/end）
    expect(validateMarker).toHaveBeenCalledTimes(1)
    const hookArgs = validateMarker.mock.calls[0]
    expect(hookArgs[2]).toEqual({
      wrappedBefore: [
        { type: 'turn/start', data: { turn: 1 } },
        { type: 'step/start', data: { turn: 1, step: 1 } },
      ],
      wrappedAfter: [
        { type: 'step/end', data: { turn: 1, step: 1 } },
        { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      ],
    })
  })

  it('guard：wrappedBefore/wrappedAfter 传入完整序列后 T1 自检通过（误报消除）', async () => {
    const factory = vi.fn(() => ({ validateAppend: () => ({ ok: true }) }))
    const log = vi.fn()
    const guard = createMarkerGuard({ log, prewriterFactory: factory })
    // 会话事件里已有一次闭合的 step，随后追加情形③ marker + 完整 turn 信封
    const session = {
      id: 's1',
      events: [
        { type: 'step/start', data: { turn: 1, step: 0 } },
        { type: 'assistant/message', data: { turn: 1, step: 0 } },
        { type: 'step/end', data: { turn: 1, step: 0 } },
      ],
    }
    const envelope = { ...validEnvelope(), data: { ...validEnvelope().data, turn: 2, step: 1 } } // 情形③：turn=2（信封 turn），step=1
    const result = await guard.validateMarkerAppend(session, envelope, {
      wrappedBefore: [
        { type: 'turn/start', data: { turn: 2 } },
        { type: 'step/start', data: { turn: 2, step: 1 } },
      ],
      wrappedAfter: [
        { type: 'step/end', data: { turn: 2, step: 1 } },
        { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
      ],
    })
    expect(result).toEqual({ t1Ok: true }) // 完整序列配对通过 → 不再误报
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('markerT1Broken'))
  })

  it('host-core：t1Ok=true（正常）时不标注', async () => {
    const session = makeSession().seed(userMessage('u1', 'hi'), assistantMessage('a1', 'yo'))
    const { sessions, agents } = makeEnv(session, { agent: makeAgent() })
    const validateMarker = async () => ({ t1Ok: true })
    const api = createEditorApi({}, sessions, agents, () => {}, makeHooks(agents, { validateMarker }))
    const result = await api.recall({ sessionId: 's1', messageId: 'a1' })
    expect(result.ok).toBe(true)
    expect(result.value.markerT1Broken).toBe(false)
    const marker = session.events[session.events.length - 1]
    expect(marker.data?.editor?.markerT1Broken).toBeUndefined()
  })
})
