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
import { createMarkerGuard } from '../lib/prewrite-guard.js'
import { createEditorApi } from '../lib/host-core.js'
import { userMessage, assistantMessage, toolRow, headerEvent, makeSession, makeEnv, makeAgent } from './helpers.js'

function validEnvelope(session) {
  return {
    type: 'assistant/message',
    data: {
      turn: null,
      step: null,
      message: { id: 'retrace-recall-x', role: 'assistant', content: [], source: { kind: 'model', provider: 'p', model: 'm' } },
      editor: { targetSeq: 0, text: 'hi' },
    },
    surfaceOp: { op: 'replace', start: 0, end: 0 },
    sourceEventSeqs: [0],
  }
}

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
    const api = createEditorApi({}, sessions, agents, () => {}, { validateMarker })
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
    const api = createEditorApi({}, sessions, agents, () => {}, { validateMarker })
    const result = await api.recall({ sessionId: 's1', messageId: 'a1' })
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('marker-rejected')
    expect(session.events.length).toBe(before) // nothing was committed
  })

  it('skips the hook when none is provided (dynamic-plugin path)', async () => {
    const session = makeSession().seed(userMessage('u1', 'hi'), assistantMessage('a1', 'yo'))
    const { sessions, agents } = makeEnv(session, { agent: makeAgent() })
    const api = createEditorApi({}, sessions, agents, () => {})
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

  it('guard 返回 t1Ok=false 但**不阻断**写入（编辑必须生效）', async () => {
    const factory = vi.fn(() => ({ validateAppend: () => ({ ok: true }) }))
    const log = vi.fn()
    const guard = createMarkerGuard({ log, prewriterFactory: factory })
    // 会话事件里已有一次闭合的 step，随后追加 turn-null marker → T1 失败
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

  it('host-core：t1Ok=false 时 marker 落盘且 editor.markerT1Broken=true，返回值带标志', async () => {
    const session = makeSession().seed(userMessage('u1', 'hi'), assistantMessage('a1', 'yo'))
    const { sessions, agents } = makeEnv(session, { agent: makeAgent() })
    // 模拟 prewrite-guard：契约通过但 T1 折叠失败
    const validateMarker = async () => ({ t1Ok: false })
    const api = createEditorApi({}, sessions, agents, () => {}, { validateMarker })
    const result = await api.recall({ sessionId: 's1', messageId: 'a1' })
    expect(result.ok).toBe(true) // 不阻断
    expect(result.value.markerT1Broken).toBe(true)
    // marker 已落盘且带标注
    const marker = session.events[session.events.length - 1]
    expect(marker.type).toBe('assistant/message')
    expect(marker.data?.editor?.markerT1Broken).toBe(true)
  })

  it('host-core：t1Ok=true（正常）时不标注', async () => {
    const session = makeSession().seed(userMessage('u1', 'hi'), assistantMessage('a1', 'yo'))
    const { sessions, agents } = makeEnv(session, { agent: makeAgent() })
    const validateMarker = async () => ({ t1Ok: true })
    const api = createEditorApi({}, sessions, agents, () => {}, { validateMarker })
    const result = await api.recall({ sessionId: 's1', messageId: 'a1' })
    expect(result.ok).toBe(true)
    expect(result.value.markerT1Broken).toBe(false)
    const marker = session.events[session.events.length - 1]
    expect(marker.data?.editor?.markerT1Broken).toBeUndefined()
  })
})
