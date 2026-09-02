/**
 * Unit tests for lib/host-core.js — the transport-agnostic editor ops.
 *
 * The suite locks in the behavior contract (result envelope, error codes,
 * marker shape, surface rewinding) and the regression cases fixed across the
 * v3.x line: injected-context user messages must not split rounds (v3.7),
 * tool rows are hidden with their round (v3.8), recall removes the whole
 * exchange (v3.3), and edit references are host-authoritative (v3.5/v3.6).
 */
import { describe, it, expect, vi } from 'vitest'
import {
  makeSession,
  userMessage,
  contextMessage,
  assistantMessage,
  toolRow,
  headerEvent,
  makeEnv,
  makeAgent,
  makeApi,
  makeHooks,
} from './helpers.js'

/** header + u1 + a1 + tool + u2 + a2 — the standard two-round session. */
function standardSession() {
  return makeSession().seed(
    headerEvent(),
    userMessage('u1', 'first question'),
    assistantMessage('a1', 'first answer'),
    toolRow('t1'),
    userMessage('u2', 'second question'),
    assistantMessage('a2', 'second answer'),
  )
}

function surfaceSeqs(session) {
  return session.surface.nodes.slice()
}

/** 找最后一个 retrace marker（surfaceOp replace 的 assistant/message；step 边界不算）。 */
function lastMarker(session) {
  for (let i = session.events.length - 1; i >= 0; i--) {
    const e = session.events[i]
    if (e.type === 'assistant/message' && e.surfaceOp?.op === 'replace') return e
  }
  return null
}

describe('recall', () => {
  it('removes the whole exchange round containing a user message', async () => {
    const session = standardSession()
    const agent = makeAgent()
    const api = makeApi(session, agent)

    const result = await api.recall({ sessionId: 's1', messageId: 'u1' })

    expect(result.ok).toBe(true)
    expect(result.value).toMatchObject({ op: 'recall', seq: 1, shadowed: 3, messageId: 'u1' })
    // Round [u1, a1, tool] shadowed from the surface; u2 + a2 + marker remain.
    expect(surfaceSeqs(session)).toEqual([4, 5, 8])
  })

  it('recalling an assistant reply removes its whole round too (input + output)', async () => {
    const session = standardSession()
    const api = makeApi(session, makeAgent())

    const result = await api.recall({ sessionId: 's1', messageId: 'a1' })

    expect(result.ok).toBe(true)
    expect(result.value.shadowed).toBe(3)
    expect(surfaceSeqs(session)).toEqual([4, 5, 8])
  })

  it('appends an invisible replacement marker (empty assistant, surfaceOp replace)', async () => {
    const session = standardSession()
    const api = makeApi(session, makeAgent())

    await api.recall({ sessionId: 's1', messageId: 'u2' })

    const marker = lastMarker(session)
    expect(marker.type).toBe('assistant/message')
    expect(marker.data.turn).toBe(1) // 无打开 turn → 情形③完整 turn 信封，turn = nextTurn（0.4.17v3 P1/D8 治本）
    expect(marker.data.step).toBe(1)
    expect(marker.surfaceOp).toEqual({ op: 'replace', start: 4, end: 5 })
    expect(marker.sourceEventSeqs).toEqual([4, 5])
    expect(marker.data.message).toMatchObject({
      role: 'assistant',
      content: [],
      source: { kind: 'model', provider: 'test-provider', model: 'test-model' },
    })
    expect(marker.data.message.id).toMatch(/^retrace-recall-/)
    expect(marker.data.editor).toEqual({ targetSeq: 4, text: 'second question' })
    // 情形③完整 turn 信封：turn/start → step/start → marker → step/end → turn/end
    const idx = session.events.indexOf(marker)
    expect(session.events[idx - 2].type).toBe('turn/start')
    expect(session.events[idx - 1].type).toBe('step/start')
    expect(session.events[idx + 1].type).toBe('step/end')
    expect(session.events[idx + 2].type).toBe('turn/end')
    expect(session.events[idx - 2].data).toEqual({ turn: 1 })
    expect(session.events[idx - 1].data).toEqual({ turn: 1, step: 1 })
  })

  it('reports the durable text of the recalled message', async () => {
    const session = standardSession()
    const api = makeApi(session, makeAgent())

    const result = await api.recall({ sessionId: 's1', messageId: 'a2' })

    expect(result.value.text).toBe('second answer')
    expect(result.value.shadowed).toBe(2)
  })

  it('returns message-not-found for an unknown id', async () => {
    const session = standardSession()
    const api = makeApi(session, makeAgent())

    const result = await api.recall({ sessionId: 's1', messageId: 'ghost' })

    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('message-not-found')
  })

  it('returns target-shadowed when the message was already recalled (durable log kept)', async () => {
    const session = standardSession()
    const api = makeApi(session, makeAgent())

    const first = await api.recall({ sessionId: 's1', messageId: 'u1' })
    expect(first.ok).toBe(true)

    const second = await api.recall({ sessionId: 's1', messageId: 'u1' })

    expect(second.ok).toBe(false)
    expect(second.error.code).toBe('target-shadowed')
    // The durable log was never rewritten: u1 is still an event.
    expect(session.events.some((e) => e.type === 'user/message' && e.data.id === 'u1')).toBe(true)
  })

  it('returns agent-busy while the agent is running and has no cancel API (fallback)', async () => {
    const session = standardSession()
    const api = makeApi(session, makeAgent({ status: 'running' })) // 无 cancel → 回退 agent-busy

    const result = await api.recall({ sessionId: 's1', messageId: 'u1' })

    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('agent-busy')
    expect(surfaceSeqs(session)).toEqual([1, 2, 3, 4, 5]) // untouched
  })

  it('running agent WITH cancel API: auto-stops (cancel + whenIdle) then edits (2026-08-30 事故闭环)', async () => {
    const session = standardSession()
    const cancel = vi.fn()
    const whenIdle = vi.fn(async () => {})
    const api = makeApi(session, makeAgent({ status: 'running', cancel, whenIdle }))

    const result = await api.recall({ sessionId: 's1', messageId: 'u1' })

    expect(cancel).toHaveBeenCalledTimes(1)
    expect(whenIdle).toHaveBeenCalledTimes(1)
    expect(result.ok).toBe(true) // 停止后编辑成功
    // marker 已写入（编辑生效；轮次间编辑被临时 step 包裹，最后事件是 step/end）
    expect(lastMarker(session).type).toBe('assistant/message')
  })

  it('returns session-not-found for an unknown session', async () => {
    const session = standardSession()
    const { sessions, agents } = makeEnv(session, { agent: makeAgent() })
    const { createEditorApi } = await import('../lib/host-core.js')
    const api = createEditorApi({}, sessions, agents, () => {}, makeHooks(agents))
    const result = await api.recall({ sessionId: 'nope', messageId: 'u1' })
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('session-not-found')
  })

  it('returns bad-request for an empty sessionId', async () => {
    const session = standardSession()
    const api = makeApi(session, makeAgent())
    const result = await api.recall({ sessionId: '', messageId: 'u1' })
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('bad-request')
  })

  it('returns no-model-header when the session has no model source', async () => {
    const session = makeSession().seed(userMessage('u1', 'hi'))
    const api = makeApi(session, makeAgent())
    const result = await api.recall({ sessionId: 's1', messageId: 'u1' })
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('no-model-header')
  })

  it('flushes the session after shadowing', async () => {
    const session = standardSession()
    const flush = vi.fn()
    const { sessions, agents } = makeEnv(session, { agent: makeAgent(), flushImpl: flush })
    const { createEditorApi } = await import('../lib/host-core.js')
    const api = createEditorApi({}, sessions, agents, () => {}, makeHooks(agents))

    await api.recall({ sessionId: 's1', messageId: 'u1' })

    expect(flush).toHaveBeenCalledTimes(1)
    expect(flush).toHaveBeenCalledWith(session)
  })

  it('never rejects: transport failures become ok:false results', async () => {
    const session = standardSession()
    const api = makeApi(session, makeAgent())
    const result = await api.recall({ sessionId: 's1', messageId: 'nope' })
    expect(result.ok).toBe(false)
    expect(typeof result.error.code).toBe('string')
  })

  describe('round boundaries (regression guards)', () => {
    it('ignores injected-context user messages when splitting rounds (v3.7)', async () => {
      const session = makeSession().seed(
        headerEvent(),
        contextMessage('ctx1', 'injected context'),
        userMessage('u1', 'real question'),
        assistantMessage('a1', 'answer'),
      )
      const api = makeApi(session, makeAgent())

      const result = await api.recall({ sessionId: 's1', messageId: 'a1' })

      expect(result.ok).toBe(true)
      // Round is [u1, a1]; the injected context message stays in the surface.
      expect(surfaceSeqs(session)).toEqual([1, 6])
      expect(result.value.shadowed).toBe(2)
    })

    it('hides tool rows together with their round (v3.8)', async () => {
      const session = makeSession().seed(
        headerEvent(),
        userMessage('u1', 'run something'),
        toolRow('t1'),
        assistantMessage('a1', 'done'),
      )
      const api = makeApi(session, makeAgent())

      const result = await api.recall({ sessionId: 's1', messageId: 'u1' })

      expect(result.ok).toBe(true)
      expect(surfaceSeqs(session)).toEqual([6])
      expect(result.value.shadowed).toBe(3)
    })
  })
})

describe('editAndResend', () => {
  it('rewinds from the edited user message and re-sends the new text', async () => {
    const session = standardSession()
    const agent = makeAgent()
    const api = makeApi(session, agent)

    const result = await api.editAndResend({
      sessionId: 's1',
      messageId: 'u2',
      text: '  second question, edited  ',
    })

    expect(result.ok).toBe(true)
    expect(result.value).toMatchObject({
      op: 'edit',
      seq: 4,
      shadowed: 2,
      text: 'second question, edited',
      originalText: 'second question',
      fromScratch: false,
    })
    expect(surfaceSeqs(session)).toEqual([1, 2, 3, 8]) // [u1,a1,tool] kept; [u2,a2] shadowed + marker
    expect(agent.followup).toHaveBeenCalledTimes(1)
    const [sent] = agent.followup.mock.calls[0]
    expect(sent).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: 'second question, edited' }],
      source: { kind: 'user' },
    })
    expect(sent.id).toMatch(/^retrace-resend-/)
  })

  it('with fromScratch rewinds the whole surface (new-conversation semantics)', async () => {
    const session = standardSession()
    const agent = makeAgent()
    const api = makeApi(session, agent)

    const result = await api.editAndResend({
      sessionId: 's1',
      messageId: 'u1',
      text: 'fresh start',
      fromScratch: true,
    })

    expect(result.ok).toBe(true)
    expect(result.value.fromScratch).toBe(true)
    expect(result.value.shadowed).toBe(5)
    expect(surfaceSeqs(session)).toEqual([8])
    expect(agent.followup).toHaveBeenCalledTimes(1)
  })

  it('rejects assistant messages (only user messages are editable)', async () => {
    const session = standardSession()
    const api = makeApi(session, makeAgent())
    const result = await api.editAndResend({ sessionId: 's1', messageId: 'a1', text: 'hi' })
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('not-user-message')
  })

  it('rejects blank or whitespace-only text', async () => {
    const session = standardSession()
    const api = makeApi(session, makeAgent())
    for (const text of ['', '   ', '\n\t']) {
      const result = await api.editAndResend({ sessionId: 's1', messageId: 'u1', text })
      expect(result.ok).toBe(false)
      expect(result.error.code).toBe('blank-text')
    }
  })

  it('returns agent-unavailable without a live agent (and shadows nothing)', async () => {
    const session = standardSession()
    const api = makeApi(session, undefined)
    const before = session.events.length

    const result = await api.editAndResend({ sessionId: 's1', messageId: 'u1', text: 'hi' })

    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('agent-unavailable')
    expect(session.events.length).toBe(before) // no partial application
  })

  it('marks the replaced original text in the marker (host-authoritative, v3.5/v3.6)', async () => {
    const session = standardSession()
    const api = makeApi(session, makeAgent())

    await api.editAndResend({ sessionId: 's1', messageId: 'u2', text: 'edited' })

    const marker = lastMarker(session)
    expect(marker.data.editor).toEqual({ targetSeq: 4, text: 'second question' })
  })
})

describe('regenerate', () => {
  it('rewinds to the preceding user prompt and re-sends its text', async () => {
    const session = standardSession()
    const agent = makeAgent()
    const api = makeApi(session, agent)

    const result = await api.regenerate({ sessionId: 's1', messageId: 'a2' })

    expect(result.ok).toBe(true)
    expect(result.value).toMatchObject({ op: 'regenerate', seq: 5, shadowed: 2 })
    expect(surfaceSeqs(session)).toEqual([1, 2, 3, 8])
    expect(agent.followup).toHaveBeenCalledTimes(1)
    const [sent] = agent.followup.mock.calls[0]
    expect(sent.content[0].text).toBe('second question')
  })

  it('rejects user messages as targets', async () => {
    const session = standardSession()
    const api = makeApi(session, makeAgent())
    const result = await api.regenerate({ sessionId: 's1', messageId: 'u1' })
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('not-assistant-message')
  })

  it('returns no-prompt when no user message precedes the reply', async () => {
    const session = makeSession().seed(headerEvent(), assistantMessage('a1', 'orphan reply'))
    const api = makeApi(session, makeAgent())
    const result = await api.regenerate({ sessionId: 's1', messageId: 'a1' })
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('no-prompt')
  })

  it('returns no-text for image-only prompts (text degrades, README limitation)', async () => {
    const session = makeSession().seed(
      headerEvent(),
      {
        type: 'user/message',
        data: { id: 'u1', content: [{ type: 'image', url: 'https://x/y.png' }], source: { kind: 'user' } },
      },
      assistantMessage('a1', 'about the image'),
    )
    const api = makeApi(session, makeAgent())
    const result = await api.regenerate({ sessionId: 's1', messageId: 'a1' })
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('no-text')
  })

  it('returns target-shadowed for replies outside the active surface', async () => {
    const session = standardSession()
    const api = makeApi(session, makeAgent())
    await api.recall({ sessionId: 's1', messageId: 'u1' })

    const result = await api.regenerate({ sessionId: 's1', messageId: 'a1' })

    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('target-shadowed')
  })
})

describe('concurrency and result envelope', () => {
  it('serializes ops on the same session through the per-session lock', async () => {
    const session = standardSession()
    const agent = makeAgent()
    let active = 0
    let maxActive = 0
    const { sessions, agents } = makeEnv(session, {
      agent,
      flushImpl: async () => {
        active += 1
        maxActive = Math.max(maxActive, active)
        await new Promise((r) => setTimeout(r, 5))
        active -= 1
      },
    })
    const { createEditorApi } = await import('../lib/host-core.js')
    const api = createEditorApi({}, sessions, agents, () => {}, makeHooks(agents))

    const results = await Promise.all([
      api.recall({ sessionId: 's1', messageId: 'u1' }),
      api.recall({ sessionId: 's1', messageId: 'u2' }),
    ])

    expect(results.map((r) => r.ok)).toEqual([true, true])
    expect(maxActive).toBe(1)
  })

  it('always resolves (never rejects) even when the op body throws', async () => {
    const { createEditorApi } = await import('../lib/host-core.js')
    const sessions = {
      get() {
        throw new Error('boom')
      },
    }
    const api = createEditorApi({}, sessions, { get: () => undefined }, () => {})
    const result = await api.recall({ sessionId: 's1', messageId: 'u1' })
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('internal')
  })
})

describe('R2 路径一：打开 step 内编辑写合法 turn/step（2026-08-30 事故闭环）', () => {
  it('findOpenStep：无 step/start → null（轮次间编辑）', async () => {
    const { findOpenStep } = await import('../lib/adapter/dsh-writer.js')
    const session = makeSession().seed(userMessage('u1', 'hi'))
    expect(findOpenStep(session)).toBeNull()
  })

  it('findOpenStep：step 已关闭 → null', async () => {
    const { findOpenStep } = await import('../lib/adapter/dsh-writer.js')
    const session = makeSession().seed(
      userMessage('u1', 'hi'),
      { type: 'step/start', data: { turn: 3, step: 1 } },
      assistantMessage('a1', 'yo'),
      { type: 'step/end', data: { turn: 3, step: 1 } },
    )
    expect(findOpenStep(session)).toBeNull()
  })

  it('findOpenStep：step 仍打开 → 返回 turn/step', async () => {
    const { findOpenStep } = await import('../lib/adapter/dsh-writer.js')
    const session = makeSession().seed(
      userMessage('u1', 'hi'),
      { type: 'step/start', data: { turn: 3, step: 1 } },
      assistantMessage('a1', 'yo'),
    )
    expect(findOpenStep(session)).toEqual({ turn: 3, step: 1 })
  })

  it('回合中编辑：marker 携带当前 step 的 turn/step（非 null），T1 通过', async () => {
    const { createEditorApi } = await import('../lib/host-core.js')
    const session = makeSession().seed(
      userMessage('u1', 'hi'),
      { type: 'step/start', data: { turn: 3, step: 1 } },
      assistantMessage('a1', 'yo'),
    )
    const { sessions, agents } = makeEnv(session, { agent: makeAgent() })
    // 校验钩子：契约通过 + T1 自检通过（step 内 marker 不再破坏 token meter）
    const validateMarker = async () => ({ t1Ok: true })
    const api = createEditorApi({}, sessions, agents, () => {}, makeHooks(agents, { validateMarker }))
    const result = await api.recall({ sessionId: 's1', messageId: 'a1' })
    expect(result.ok).toBe(true)
    const marker = session.events[session.events.length - 1]
    expect(marker.type).toBe('assistant/message')
    expect(marker.data.turn).toBe(3) // 携带当前 step 的 turn
    expect(marker.data.step).toBe(1) // 携带当前 step 的 step
    expect(marker.data.editor?.markerT1Broken).toBeUndefined() // 无标注
    expect(result.value.markerT1Broken).toBe(false)
  })

  it('轮次间编辑（无打开 step、无打开 turn = 情形③）：完整 turn 信封 + 推进 loop 计数器，T1 通过（0.4.17v3 P1/D8 治本）', async () => {
    const { createEditorApi } = await import('../lib/host-core.js')
    const session = makeSession().seed(userMessage('u1', 'hi'), assistantMessage('a1', 'yo'))
    // 带 phase 的 agent：lastTurn=0 → 信封消费 turn 1 → 推进到 1（重发落到 2）
    const agent = makeAgent({ phase: { kind: 'idle', lastTurn: 0 } })
    const { sessions, agents } = makeEnv(session, { agent })
    // 校验钩子收到完整序列（turn/start → step/start → marker → step/end → turn/end）→ T1 恒通过
    const validateMarker = vi.fn(async () => ({ t1Ok: true }))
    const api = createEditorApi({}, sessions, agents, () => {}, makeHooks(agents, { validateMarker }))
    const result = await api.recall({ sessionId: 's1', messageId: 'a1' })
    expect(result.ok).toBe(true)
    const marker = lastMarker(session)
    expect(marker.data.turn).toBe(1) // 真实 turn 号（铁律：不得为 null——5e551001 白屏）
    expect(marker.data.step).toBe(1)
    expect(marker.data.editor?.markerT1Broken).toBeUndefined() // 不再标注
    expect(result.value.markerT1Broken).toBe(false)
    // 校验钩子收到完整序列（before + envelope + after）
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
    // 完整 turn 信封落盘
    const idx = session.events.indexOf(marker)
    expect(session.events[idx - 2].type).toBe('turn/start')
    expect(session.events[idx - 1].type).toBe('step/start')
    expect(session.events[idx + 1].type).toBe('step/end')
    expect(session.events[idx + 2].type).toBe('turn/end')
    expect(session.events[idx - 2].data).toEqual({ turn: 1 })
    expect(session.events[idx - 1].data).toEqual({ turn: 1, step: 1 })
    // loop 计数器已推进：重发/下一条消息落到 turn 2（防 duplicate start）
    expect(agent.phase.lastTurn).toBe(1)
  })

  it('情形②（有打开着的 turn、无打开的 step）：marker 用该 turn 号 + 新 step 号（5e551001 D8 现场）', async () => {
    const { createEditorApi } = await import('../lib/host-core.js')
    // turn 5 打开着（turn/start 无 turn/end），step 1 已关
    const session = makeSession().seed(
      { type: 'turn/start', data: { turn: 5 } },
      userMessage('u1', 'hi'),
      { type: 'step/start', data: { turn: 5, step: 1 } },
      assistantMessage('a1', 'yo'),
      { type: 'step/end', data: { turn: 5, step: 1 } },
    )
    const { sessions, agents } = makeEnv(session, { agent: makeAgent() })
    const validateMarker = vi.fn(async () => ({ t1Ok: true }))
    const api = createEditorApi({}, sessions, agents, () => {}, makeHooks(agents, { validateMarker }))
    const result = await api.recall({ sessionId: 's1', messageId: 'a1' })
    expect(result.ok).toBe(true)
    const marker = lastMarker(session)
    expect(marker.data.turn).toBe(5) // 用打开着的 turn 号（非 null、非 nextTurn）
    expect(marker.data.step).toBe(2) // 新 step 号 = max step + 1（不覆盖旧 step draft）
    // 信封 = 只有 step/start + step/end（turn/start 早已存在，无需新建）
    const hookArgs = validateMarker.mock.calls[0]
    expect(hookArgs[2]).toEqual({
      wrappedBefore: [{ type: 'step/start', data: { turn: 5, step: 2 } }],
      wrappedAfter: [{ type: 'step/end', data: { turn: 5, step: 2 } }],
    })
    const idx = session.events.indexOf(marker)
    expect(session.events[idx - 1].data).toEqual({ turn: 5, step: 2 })
    expect(session.events[idx + 1].data).toEqual({ turn: 5, step: 2 })
  })

  it('情形② step = max(内存, 文件)+1：文件滞后时内存覆盖（连续编辑不冲突，独立审查 2026-09-02 处置）', async () => {
    const { createEditorApi } = await import('../lib/host-core.js')
    const session = makeSession().seed(
      { type: 'turn/start', data: { turn: 5 } },
      { type: 'step/start', data: { turn: 5, step: 1 } },
      userMessage('u1', 'hi'),
      assistantMessage('a1', 'yo'),
      { type: 'step/end', data: { turn: 5, step: 1 } },
      { type: 'step/start', data: { turn: 5, step: 2 } },
      userMessage('u2', 'again'),
      assistantMessage('a2', 'more'),
      { type: 'step/end', data: { turn: 5, step: 2 } },
    )
    const { sessions, agents } = makeEnv(session, { agent: makeAgent() })
    const validateMarker = vi.fn(async () => ({ t1Ok: true }))
    // 文件滞后:readMaxStep 恒返回 2(flush 未落盘,文件看不到本进程刚写的 marker step)
    const readMaxStep = vi.fn(async () => 2)
    const api = createEditorApi({}, sessions, agents, () => {}, makeHooks(agents, { validateMarker, readMaxStep }))
    // 同一打开 turn 内连续两次情形②(编辑不同消息,避免目标被遮蔽)
    const r1 = await api.recall({ sessionId: 's1', messageId: 'a1' })
    const m1 = lastMarker(session)
    expect(r1.ok).toBe(true)
    expect(m1.data.step).toBe(3) // max(内存2, 文件2)+1 = 3
    const r2 = await api.recall({ sessionId: 's1', messageId: 'a2' })
    const m2 = lastMarker(session)
    expect(r2.ok).toBe(true)
    expect(m2.data.step).toBe(4) // 内存已见 step 3 → max(内存3, 文件2)+1 = 4,不与 m1 冲突
    expect(m1.data.step).not.toBe(m2.data.step) // step key 唯一
  })

  it('情形② + readMaxStep：从文件全量算 step（窗口化内存不可信，5e551001 复盘 §五）', async () => {
    const { createEditorApi } = await import('../lib/host-core.js')
    // turn 5 打开着;内存视图只含 step 1,但文件全量含 step 1..45(窗口外)
    const session = makeSession().seed(
      { type: 'turn/start', data: { turn: 5 } },
      userMessage('u1', 'hi'),
      { type: 'step/start', data: { turn: 5, step: 1 } },
      assistantMessage('a1', 'yo'),
      { type: 'step/end', data: { turn: 5, step: 1 } },
    )
    const { sessions, agents } = makeEnv(session, { agent: makeAgent() })
    const validateMarker = vi.fn(async () => ({ t1Ok: true }))
    // readMaxStep 模拟从文件读全量:turn 5 实际已有 step 45(窗口外,内存看不到);
    // 现在经 writer 依赖注入(makeHooks),不再经 args 传递
    const readMaxStep = vi.fn(async () => 45)
    const api = createEditorApi({}, sessions, agents, () => {}, makeHooks(agents, { validateMarker, readMaxStep }))
    const result = await api.recall({ sessionId: 's1', messageId: 'a1' })
    expect(result.ok).toBe(true)
    const marker = lastMarker(session)
    expect(marker.data.turn).toBe(5)
    expect(marker.data.step).toBe(46) // 用文件全量 max(45)+1,不与窗口外 step 冲突
    expect(readMaxStep).toHaveBeenCalledWith('s1', 5)
    const idx = session.events.indexOf(marker)
    expect(session.events[idx - 1].data).toEqual({ turn: 5, step: 46 })
    expect(session.events[idx + 1].data).toEqual({ turn: 5, step: 46 })
  })
})
