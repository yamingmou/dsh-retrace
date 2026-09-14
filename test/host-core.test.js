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
import { sessionEvents, eventAt } from '../lib/host-compat.js'
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
  lastCarrierMarker,
} from './helpers.js'
import { isRoundBoundaryEvent } from '../lib/span-semantics.js'
import { AUDIT_EVENT_TYPE, CARRIER_DATA_KEYS, carrierShadowedSeqs, carrierTargetSeq } from '../lib/marker-carrier.js'
import { deriveMessage, officialNodePrice, officialSurfaceMeter } from './official-meter.js'

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

/** 找最后一个遮蔽载体(两段结构的第 2 段:user/message + replace)。
 * 洞容忍夹具把 host 内存 events 造成稀疏数组(窗口化视图的 undefined 洞)→
 *  裸下标访问会抛 TypeError，这里按存在性判断。 */
function lastMarker(session) {
  return lastCarrierMarker(session)
}

/** 最近一次写入的审计段(compaction/prune)。 */
function lastAudit(session) {
  for (let i = sessionEvents(session).length - 1; i >= 0; i--) {
    const e = eventAt(session, i)
    if (e && e.type === AUDIT_EVENT_TYPE) return e
  }
  return null
}

describe('recall', () => {
  it('removes the whole exchange round containing a user message（0.4.20:recall = tail 语义,遮蔽目标轮及之后全部）', async () => {
    const session = standardSession()
    const agent = makeAgent()
    const api = makeApi(session, agent)

    const result = await api.recall({ sessionId: 's1', messageId: 'u1' })

    expect(result.ok).toBe(true)
    expect(result.value).toMatchObject({ op: 'recall', seq: 1, shadowed: 5, messageId: 'u1' })
    // tail:u1 轮 + u2/a2 全部遮蔽(编辑=从此处分叉);surface 只剩载体节点
    expect(surfaceSeqs(session)).toEqual([lastMarker(session).seq])
  })

  it('recalling an assistant reply removes its whole round too (input + output)', async () => {
    const session = standardSession()
    const api = makeApi(session, makeAgent())

    const result = await api.recall({ sessionId: 's1', messageId: 'a1' })

    expect(result.ok).toBe(true)
    // 撤回回复连带所在轮 input(回退轮首 u1)+ 其后全部 = tail 语义
    expect(result.value.shadowed).toBe(5)
    expect(surfaceSeqs(session)).toEqual([lastMarker(session).seq])
  })

  it('appends a two-segment carrier (audit prune + user/message replace)', async () => {
    const session = standardSession()
    const api = makeApi(session, makeAgent())

    await api.recall({ sessionId: 's1', messageId: 'u2' })

    const marker = lastMarker(session)
    expect(marker.type).toBe('user/message')
    // 官方 user/message 词表精确四成员(turn/step/editor 都无处容身)
    expect(Object.keys(marker.data).sort()).toEqual([...CARRIER_DATA_KEYS].sort())
    expect(marker.data.turn).toBeUndefined()
    expect(marker.data.step).toBeUndefined()
    expect(marker.surfaceOp).toEqual({ op: 'replace', start: 4, end: 5 })
    // 首元素 = 审计段(第 1 段)seq;其余 = 全部被遮蔽节点
    const audit = lastAudit(session)
    expect(marker.sourceEventSeqs).toEqual([audit.seq, 4, 5])
    // 第 1 段 shadowedTokenCount = **官方令牌价**(shadow-price claim),不是节点个数:
    // 口径由官方 estimateMessage(deriveEventMessage(event)) 给出(见 test/official-meter.js)
    const officialPrice = [4, 5].reduce((total, seq) => total + officialNodePrice(eventAt(session, seq)), 0)
    expect(audit.data).toEqual({ shadowedRange: { start: 4, end: 5 }, shadowedSeqs: [4, 5], shadowedTokenCount: officialPrice })
    expect(officialPrice).not.toBe(2) // 节点个数口径会写成 2 ⇒ 这就是被修正的高估源
    expect(audit.surfaceOp).toBeUndefined()
    expect(audit.sourceEventSeqs).toBeUndefined()
    expect(carrierShadowedSeqs(marker)).toEqual([4, 5])
    expect(marker.data.source).toEqual({ kind: 'model', provider: 'test-provider', model: 'test-model' })
    expect(marker.data.id).toMatch(/^retrace-recall-/)
    // 留痕形态(定稿 A2):content 非空且为文本块——空 content 会投影成一条"空消息"
    expect(marker.data.content).toEqual([{ type: 'text', text: '（此处内容已被撤回：原消息已归档，可在恢复视图中查看）' }])
    // 轮边界红线:载体的 source.kind='model' ⇒ 不被当成真实用户输入切轮
    expect(isRoundBoundaryEvent(marker)).toBe(false)
    // 不再写 turn/step 信封(三情形翻译作废):载体的前一个事件就是审计段
    const idx = sessionEvents(session).indexOf(marker)
    expect(eventAt(session, idx - 1)).toBe(audit)
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
    expect(sessionEvents(session).some((e) => e.type === 'user/message' && e.data.id === 'u1')).toBe(true)
  })

  it('returns agent-busy while the agent is running and has no cancel API (fallback)', async () => {
    const session = standardSession()
    const api = makeApi(session, makeAgent({ status: 'running' })) // 无 cancel → 回退 agent-busy

    const result = await api.recall({ sessionId: 's1', messageId: 'u1' })

    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('agent-busy')
    expect(surfaceSeqs(session)).toEqual([1, 2, 3, 4, 5]) // untouched
  })

  it('running agent WITH cancel API: auto-stops (cancel + whenIdle) then edits (2026-08-30 事故修复)', async () => {
    const session = standardSession()
    const cancel = vi.fn()
    const whenIdle = vi.fn(async () => {})
    const api = makeApi(session, makeAgent({ status: 'running', cancel, whenIdle }))

    const result = await api.recall({ sessionId: 's1', messageId: 'u1' })

    expect(cancel).toHaveBeenCalledTimes(1)
    expect(whenIdle).toHaveBeenCalledTimes(1)
    expect(result.ok).toBe(true) // 停止后编辑成功
    // 载体已写入(编辑生效;不再有 turn/step 信封,最后事件即载体)
    expect(lastMarker(session).type).toBe('user/message')
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
      expect(surfaceSeqs(session)).toEqual([1, lastMarker(session).seq])
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
      expect(surfaceSeqs(session)).toEqual([lastMarker(session).seq])
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
    expect(surfaceSeqs(session)).toEqual([1, 2, 3, lastMarker(session).seq]) // [u1,a1,tool] kept; [u2,a2] shadowed + carrier
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
    expect(surfaceSeqs(session)).toEqual([lastMarker(session).seq])
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
    const before = sessionEvents(session).length

    const result = await api.editAndResend({ sessionId: 's1', messageId: 'u1', text: 'hi' })

    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('agent-unavailable')
    expect(sessionEvents(session).length).toBe(before) // no partial application
  })

  it('business provenance lives outside the carrier: targetSeq derives from the range start', async () => {
    const session = standardSession()
    const api = makeApi(session, makeAgent())

    const result = await api.editAndResend({ sessionId: 's1', messageId: 'u2', text: 'edited' })

    const marker = lastMarker(session)
    // editor 已不再落盘(官方词表无位置):targetSeq 由区间起点派生,
    // 原文按需从日志回填(editor.text 不再冗余存储)
    expect(marker.data.editor).toBeUndefined()
    expect(carrierTargetSeq(marker)).toBe(4)
    // host 结果里仍带原文(重发/展示用):回填口径由读端从日志取,不由 marker 承载
    expect(result.value.originalText).toBe('second question')
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
    expect(surfaceSeqs(session)).toEqual([1, 2, 3, lastMarker(session).seq])
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

    // 0.4.20:recall 改 tail 语义(遮蔽目标及之后全部)——并发 recall 会互相遮蔽目标;
    // 验证锁改用 editAndResend(round 轮内遮蔽,互不遮蔽),锁语义不变
    const results = await Promise.all([
      api.editAndResend({ sessionId: 's1', messageId: 'u1', text: 'x1' }),
      api.editAndResend({ sessionId: 's1', messageId: 'u2', text: 'x2' }),
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

describe('两段结构:不再写 turn/step,载体 source.kind=\'model\'(改造后的位置语义)', () => {
  /**
   * 三情形 turn/step 翻译整体作废的依据:`dsh-token-meter/lib/index.js:753` 只要求
   * `assistant/message` 匹配打开中的 step/start;两段结构的第 2 段是 `user/message`,
   * 官方对它没有 step 配对要求(它连 turn/step 成员都没有)⇒ 信封/计数器推进全部消失。
   */
  it('回合中(有打开 step)编辑:不写任何 step/turn 信封,载体仍合法落盘', async () => {
    const { createEditorApi } = await import('../lib/host-core.js')
    const session = makeSession().seed(
      headerEvent(), userMessage('u1', 'hi'), assistantMessage('a1', 'yo'),
      { type: 'turn/start', data: { turn: 3 } },
      { type: 'step/start', data: { turn: 3, step: 1 } },
    )
    const { sessions, agents } = makeEnv(session, { agent: makeAgent() })
    const api = createEditorApi({}, sessions, agents, () => {}, makeHooks(agents))
    const before = sessionEvents(session).length
    const result = await api.recall({ sessionId: 's1', messageId: 'a1' })
    expect(result.ok).toBe(true)
    // 只多两个事件:审计段 + 载体段(没有 step/end、turn/end 包裹)
    expect(sessionEvents(session).length).toBe(before + 2)
    expect(eventAt(session, before).type).toBe(AUDIT_EVENT_TYPE)
    expect(eventAt(session, before + 1).type).toBe('user/message')
    const marker = lastMarker(session)
    expect(marker.data.turn).toBeUndefined()
    expect(marker.data.step).toBeUndefined()
  })

  it('轮次间(无打开 turn)编辑:不再新建 turn/start·step/start 信封', async () => {
    const { createEditorApi } = await import('../lib/host-core.js')
    const session = makeSession().seed(headerEvent(), userMessage('u1', 'hi'), assistantMessage('a1', 'yo'))
    const { sessions, agents } = makeEnv(session, { agent: makeAgent() })
    const api = createEditorApi({}, sessions, agents, () => {}, makeHooks(agents))
    const result = await api.recall({ sessionId: 's1', messageId: 'u1' })
    expect(result.ok).toBe(true)
    expect(sessionEvents(session).some((e) => e?.type === 'turn/start' || e?.type === 'step/start')).toBe(false)
    // agent-loop 计数器不再需要推进(agent 未被触碰)
    expect(agents.get('s1').phase).toBeUndefined()
  })

  it('审计段先写、载体后写:第 2 段首元素 === 第 1 段 seq(两者都引用更早 seq)', async () => {
    const session = standardSession()
    const api = makeApi(session, makeAgent())
    const result = await api.recall({ sessionId: 's1', messageId: 'u2' })
    expect(result.ok).toBe(true)
    const marker = lastMarker(session)
    const audit = lastAudit(session)
    expect(audit.seq).toBeLessThan(marker.seq)
    expect(marker.sourceEventSeqs[0]).toBe(audit.seq)
    // 审计段声明的被遮蔽段 === 载体区间(读写两端同一份 range 推出)
    expect(audit.data.shadowedRange).toEqual({ start: marker.surfaceOp.start, end: marker.surfaceOp.end })
    expect(audit.data.shadowedSeqs).toEqual(carrierShadowedSeqs(marker))
  })

  it('写前断言:targetSeq ≠ 被遮蔽区间起点 → 记一行诊断(派生值 = 区间起点),写入照常', async () => {
    const { createDshMarkerWriter } = await import('../lib/adapter/dsh-writer.js')
    const logged = []
    const writer = createDshMarkerWriter({ log: (line) => logged.push(line), meter: officialSurfaceMeter(), deriveMessage })
    const session = makeSession().seed(
      headerEvent(), userMessage('u1', 'q1'), assistantMessage('a1', 'r1'),
      userMessage('u2', 'q2'), assistantMessage('a2', 'r2'),
    )
    // ① 区间之外(targetSeq 4 ∉ [1..3]):旧守卫也拦;
    const outside = await writer.writeMarker(session, { start: 1, end: 3, shadowedSeqs: [1, 2, 3] }, { op: 'recall', targetSeq: 4, originalText: '' })
    expect(carrierTargetSeq(outside)).toBe(1)
    // ② **区间之内但非起点**(targetSeq 2 ∈ [1..3]、start = 1):这正是旧守卫
    //    (`!shadowedSeqs.includes(targetSeq)`)放过去、读端却无法还原的形态 ——
    //    实测:业务 targetSeq = 2、派生 0/1 时旧实现零诊断(静默错位)。
    const session2 = makeSession().seed(
      headerEvent(), userMessage('u1', 'q1'), assistantMessage('a1', 'r1'),
      userMessage('u2', 'q2'), assistantMessage('a2', 'r2'),
    )
    const inRange = await writer.writeMarker(session2, { start: 1, end: 3, shadowedSeqs: [1, 2, 3] }, { op: 'recall', targetSeq: 2, originalText: '' })
    expect(carrierTargetSeq(inRange)).toBe(1) // 读端派生 = 区间起点,与业务目标 2 不同
    const diagnostics = logged.filter((line) => line.includes('≠ 被遮蔽区间起点'))
    expect(diagnostics.length).toBe(2) // 两种偏离各记一行(旧实现第一种之外零诊断)
    expect(diagnostics[1]).toContain('targetSeq 2')
  })
})

describe('「提交中(message-pending)」vs「真被遮蔽(target-shadowed)」判定', () => {
  /**
   * 「提交中」会话:目标消息已进内存 events(findMessageSeq 可见),但 surface.nodes
   * 尚未纳入(刚 commit/文件 flush 滞后,本次 span 快照看不到)——模拟用户点击落在
   * turn 收尾窗口(某真实会话的收尾窗口 seq 与 step/end、turn/end 同一毫秒,
   * turn/end reason=aborted-user;文件尚未 flush 刚 commit 消息)。
   * lastType='assistant' → 尾部最新 assistant 回复(a2,seq 4)提交中;
   * lastType='user' → 尾部最新 user 输入(u3,seq 4)刚发出、尚未进快照。
   */
  function pendingTailSession({ lastType = 'assistant' } = {}) {
    const session = makeSession().seed(
      headerEvent(),
      userMessage('u1', 'first'),
      assistantMessage('a1', 'answer one'),
      userMessage('u2', 'second'),
    )
    session.appendRaw(lastType === 'assistant' ? assistantMessage('a2', 'answer two') : userMessage('u3', 'third'))
    session.surface.nodes.pop() // 模拟:本次 span 快照尚未纳入最后 append
    return session
  }

  it('recall 尾部最近 append(提交中)的回复 → message-pending,非 target-shadowed', async () => {
    const session = pendingTailSession() // a2(seq 4)在 events 尾、不在 surface
    const api = makeApi(session, makeAgent())

    const result = await api.recall({ sessionId: 's1', messageId: 'a2' })

    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('message-pending')
    expect(result.error.message).toBe('消息生成中,完成后可编辑')
    // 排查信息透传(建议 3):messageId/seq 随 wire 错误携带
    expect(result.error).toMatchObject({ messageId: 'a2', seq: 4 })
    // 未误伤:无 marker 写入,surface 保持原样
    expect(surfaceSeqs(session)).toEqual([1, 2, 3])
    expect(lastMarker(session)).toBeNull()
  })

  it('editAndResend「刚发送还没进快照」的 user 消息 → message-pending(可重试)', async () => {
    const session = pendingTailSession({ lastType: 'user' }) // u3(seq 4)提交中
    const api = makeApi(session, makeAgent())

    const result = await api.editAndResend({ sessionId: 's1', messageId: 'u3', text: 'third, edited' })

    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('message-pending')
    expect(result.error).toMatchObject({ messageId: 'u3', seq: 4 })
    expect(surfaceSeqs(session)).toEqual([1, 2, 3])
  })

  it('regenerate 提交中的回复 → message-pending(判定与 recall/edit 一致)', async () => {
    const session = pendingTailSession() // a2(seq 4)提交中
    const api = makeApi(session, makeAgent())

    const result = await api.regenerate({ sessionId: 's1', messageId: 'a2' })

    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('message-pending')
    expect(result.error).toMatchObject({ messageId: 'a2', seq: 4 })
  })

  it('文件层事实注入:fileMaxSeq < 目标 seq(文件 flush 滞后)→ message-pending(withFileSpan/http 同路)', async () => {
    const session = pendingTailSession() // a2 seq 4 在内存,文件快照只到 3
    const api = makeApi(session, makeAgent())
    // withFileSpan/http.js 在 spanFromFile null 时注入 spanFacts = { fileMaxSeq, targetSeq }
    const result = await api.recall({ sessionId: 's1', messageId: 'a2', spanFacts: { fileMaxSeq: 3, targetSeq: -1 } })
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('message-pending')
  })

  it('真被遮蔽(fold/recall 已移除)→ target-shadowed,中文可操作文案', async () => {
    const session = standardSession()
    const api = makeApi(session, makeAgent())
    const first = await api.recall({ sessionId: 's1', messageId: 'u1' })
    expect(first.ok).toBe(true)

    const second = await api.recall({ sessionId: 's1', messageId: 'u1' })

    expect(second.ok).toBe(false)
    expect(second.error.code).toBe('target-shadowed')
    expect(second.error.message).toBe('该消息位于已折叠块(历史只读):展开该块后编辑,或追加新消息修订')
    expect(second.error).toMatchObject({ messageId: 'u1', seq: 1 })
  })

  it('文件层事实已覆盖目标(seq ≤ fileMaxSeq)且算不出 span → 真被遮蔽 target-shadowed', async () => {
    const session = standardSession()
    const api = makeApi(session, makeAgent())
    await api.recall({ sessionId: 's1', messageId: 'u1' }) // marker seq 8 遮蔽 [1..5]
    // 文件快照已含 marker(最大 seq 8)仍算不出 u1 的 span → 遮蔽终判
    const result = await api.recall({ sessionId: 's1', messageId: 'u1', spanFacts: { fileMaxSeq: 8, targetSeq: 1 } })
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('target-shadowed')
  })

  it('三 op 判定一致:提交中 → 全 message-pending;真遮蔽 → 全 target-shadowed', async () => {
    const session = pendingTailSession() // a2 提交中
    const api = makeApi(session, makeAgent())
    const pending = [
      await api.recall({ sessionId: 's1', messageId: 'a2' }),
      await api.regenerate({ sessionId: 's1', messageId: 'a2' }),
    ]
    expect(pending.map((r) => r.error.code)).toEqual(['message-pending', 'message-pending'])

    // editAndResend 需 user 目标:同一「提交中」形态(尾部 user 未进快照)
    const s2 = pendingTailSession({ lastType: 'user' })
    const api2 = makeApi(s2, makeAgent())
    const pendingEdit = await api2.editAndResend({ sessionId: 's1', messageId: 'u3', text: 'x' })
    expect(pendingEdit.error.code).toBe('message-pending')

    // 真遮蔽形态:u1 被 recall 后,recall/edit/regenerate 全部 target-shadowed
    const s3 = standardSession()
    const api3 = makeApi(s3, makeAgent())
    await api3.recall({ sessionId: 's1', messageId: 'u1' })
    const shadowed = [
      await api3.recall({ sessionId: 's1', messageId: 'u1' }),
      await api3.editAndResend({ sessionId: 's1', messageId: 'u1', text: 'x' }),
      await api3.regenerate({ sessionId: 's1', messageId: 'a1' }),
    ]
    expect(shadowed.map((r) => r.error.code)).toEqual(['target-shadowed', 'target-shadowed', 'target-shadowed'])
  })

  it('显式状态:spanStatus=not-persisted → message-pending(架构级状态,不再靠 null+facts 猜)', async () => {
    const session = pendingTailSession()
    const api = makeApi(session, makeAgent())
    const result = await api.recall({ sessionId: 's1', messageId: 'a2', spanStatus: 'not-persisted', spanFacts: { fileMaxSeq: 3, targetSeq: -1 } })
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('message-pending')
    expect(result.error.message).toBe('消息生成中,完成后可编辑')
  })

  it('显式状态:spanStatus=already-shadowed → target-shadowed(历史只读)', async () => {
    const session = standardSession()
    const api = makeApi(session, makeAgent())
    await api.recall({ sessionId: 's1', messageId: 'u1' }) // 内存里 u1 已被遮蔽(span 算不出)
    const result = await api.recall({ sessionId: 's1', messageId: 'u1', spanStatus: 'already-shadowed', spanFacts: { fileMaxSeq: 8, targetSeq: 1 } })
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('target-shadowed')
    expect(result.error.message).toBe('该消息位于已折叠块(历史只读):展开该块后编辑,或追加新消息修订')
  })

  it('显式状态优先:not-found 压过内存兜底(不再一律 target-shadowed)', async () => {
    const session = standardSession()
    const api = makeApi(session, makeAgent())
    await api.recall({ sessionId: 's1', messageId: 'u1' })
    // 对照:无状态 → 内存兜底判遮蔽(target-shadowed);有状态 → 按状态给 message-not-found
    const fallback = await api.recall({ sessionId: 's1', messageId: 'u1' })
    expect(fallback.error.code).toBe('target-shadowed')
    const result = await api.recall({ sessionId: 's1', messageId: 'u1', spanStatus: 'not-found', spanFacts: { fileMaxSeq: 8, targetSeq: 1 } })
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('message-not-found')
    expect(result.error).toMatchObject({ messageId: 'u1', seq: 1 })
  })

  it('状态 + 文件事实联合定证:not-found 且内存 seq 超出快照 → message-pending(未落盘的证据)', async () => {
    const session = pendingTailSession() // a2(seq 4)已进内存,文件快照只到 3
    const api = makeApi(session, makeAgent())
    // 文件层对 id 目标只给"快照里没有" + 事实;内存 seq 4 > fileMaxSeq 3 = 未落盘证据
    const result = await api.recall({ sessionId: 's1', messageId: 'a2', spanStatus: 'not-found', spanFacts: { fileMaxSeq: 3, targetSeq: -1 } })
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('message-pending')
  })

  it('状态 + 文件事实联合定证:not-found 且快照已覆盖该 seq → message-not-found(永久不存在,不报可重试)', async () => {
    const session = standardSession()
    const api = makeApi(session, makeAgent())
    await api.recall({ sessionId: 's1', messageId: 'u1' }) // 内存里 u1 已遮蔽,span 算不出
    // 快照覆盖到 8 > 目标 seq 1 → 不是"未落盘",是快照里就没有这个 id
    const result = await api.recall({ sessionId: 's1', messageId: 'u1', spanStatus: 'not-found', spanFacts: { fileMaxSeq: 8, targetSeq: -1 } })
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('message-not-found')
  })

  it('显式状态:spanStatus=replay-failed → span-replay-failed(内部错误,绝不冒充遮蔽)', async () => {
    const session = standardSession()
    const api = makeApi(session, makeAgent())
    await api.recall({ sessionId: 's1', messageId: 'u1' })
    for (const call of [
      () => api.recall({ sessionId: 's1', messageId: 'u1', spanStatus: 'replay-failed', spanFacts: { fileMaxSeq: 8, targetSeq: 1 } }),
      () => api.editAndResend({ sessionId: 's1', messageId: 'u1', text: 'x', spanStatus: 'replay-failed', spanFacts: { fileMaxSeq: 8, targetSeq: 1 } }),
      () => api.regenerate({ sessionId: 's1', messageId: 'a1', spanStatus: 'replay-failed', spanFacts: { fileMaxSeq: 8, targetSeq: 1 } }),
    ]) {
      const result = await call()
      expect(result.ok).toBe(false)
      expect(result.error.code).toBe('span-replay-failed')
      expect(result.error.message).toMatch(/内部错误/)
      expect(result.error.code).not.toBe('target-shadowed') // 不冒充"历史只读"
      // 错误 details 必须带判因 facts(面为空 vs 重放抛错共用同一状态)
      expect(result.error.spanFacts).toMatchObject({ fileMaxSeq: 8, targetSeq: 1 })
    }
    // 带 cause 的判因细节透传到 wire(空面:nodes=0 + cause)
    const detailed = await api.recall({
      sessionId: 's1', messageId: 'u1', spanStatus: 'replay-failed',
      spanFacts: { fileMaxSeq: 8, targetSeq: 1, nodes: 0, cause: 'empty-surface' },
    })
    expect(detailed.error.spanFacts).toMatchObject({ nodes: 0, cause: 'empty-surface' })
    expect(detailed.error.nodes).toBeUndefined() // 判因细节收在一个 spanFacts 字段里,不污染 wire 顶层
  })

  it('状态优先于内存兜底:显式 not-persisted 压过内存"看起来已遮蔽"的形态', async () => {
    // 内存里目标看似被遮蔽(marker 命中),但文件侧显式状态是 not-persisted → 可重试
    const session = standardSession()
    const api = makeApi(session, makeAgent())
    await api.recall({ sessionId: 's1', messageId: 'u1' }) // 内存里 u1 已被遮蔽
    const result = await api.recall({ sessionId: 's1', messageId: 'u1', spanStatus: 'not-persisted', spanFacts: { fileMaxSeq: 8, targetSeq: -1 } })
    expect(result.error.code).toBe('message-pending')
  })

  it('文件注入 span(文件含目标)→ 不再被内存 surface 滞后误伤', async () => {
    const session = makeSession().seed(
      headerEvent(),
      userMessage('u1', 'first'),
      assistantMessage('a1', 'answer one'),
      userMessage('u2', 'second'),
    )
    // 内存 surface 滞后:a2 已在文件(文件算好 span 注入),但内存 nodes 还没有它
    session.appendRaw(assistantMessage('a2', 'answer two'))
    session.surface.nodes.pop()
    const span = { start: 3, end: 4, shadowedSeqs: [3, 4] } // 文件 round span(轮2 u2+a2)
    const agent = makeAgent()
    const api = makeApi(session, agent)

    const result = await api.regenerate({ sessionId: 's1', messageId: 'a2', span })

    expect(result.ok).toBe(true) // 文件 span 优先:不再因内存 idx===-1 抛 target-shadowed
    expect(result.value.op).toBe('regenerate')
    expect(agent.followup).toHaveBeenCalledTimes(1)
    // 重发文本必须是该轮(span 起点 seq 3 = u2)的原文
    expect(agent.followup.mock.calls[0][0].content[0].text).toBe('second')
    const marker = lastMarker(session)
    expect(marker.surfaceOp).toEqual({ op: 'replace', start: 3, end: 4 })
    expect(carrierTargetSeq(marker)).toBe(3) // 派生值 = 区间起点(该轮 user)
    expect(marker.data.editor).toBeUndefined()
  })
})

describe('regenerate 重发文本取自文件侧,绝不越过稀疏洞/遮蔽区选更早轮', () => {
  /**
   * 文件含目标(span 注入,host 内存 surface 滞后)且 host 内存 events 是窗口化
   * 视图:该轮 user(seq 3)是 undefined 洞,更早轮 user(seq 1)仍在内存——
   * 旧实现「直扫稀疏 events 找前置 user」会越过洞选中 seq 1 → 重发错文本 +
   * marker targetSeq 指向错轮。
   */
  function sparseHoleSession() {
    const session = makeSession().seed(
      headerEvent(), // seq 0
      userMessage('u1', 'OLDER ROUND PROMPT'), // seq 1(更早轮 user,内存里在)
      assistantMessage('a1', 'older answer'), // seq 2
      userMessage('u2', 'SAME ROUND PROMPT'), // seq 3(该轮 user → 洞)
      assistantMessage('a2', 'current answer'), // seq 4(目标,内存 events 有)
    )
    session.dropAt(3) // 洞:该轮 user 未被 materialize(窗口化视图)
    session.surface.nodes.pop() // 内存 surface 滞后:目标 seq 4 未纳入 → idx === -1
    return session
  }
  const fileSpan = { start: 3, end: 4, shadowedSeqs: [3, 4] } // 文件 round span(轮2)

  it('文件侧 prompt 注入(probe.prompt)→ 重发该轮 user 原文 + marker targetSeq 指向该轮', async () => {
    const session = sparseHoleSession()
    const agent = makeAgent()
    const api = makeApi(session, agent)

    const result = await api.regenerate({
      sessionId: 's1',
      messageId: 'a2',
      span: fileSpan,
      // index.js/http.js 由 spanProbeFromFile().prompt 注入(文件全量 events 取原文)
      regeneratePrompt: { seq: 3, text: 'SAME ROUND PROMPT' },
    })

    expect(result.ok).toBe(true)
    expect(agent.followup).toHaveBeenCalledTimes(1)
    // 关键断言:重发该轮 user 原文,绝不是更早轮(seq 1)的文本
    expect(agent.followup.mock.calls[0][0].content[0].text).toBe('SAME ROUND PROMPT')
    const marker = lastMarker(session)
    expect(marker.surfaceOp).toEqual({ op: 'replace', start: 3, end: 4 }) // 遮蔽范围 = 该轮
    // targetSeq 由区间起点派生(editor 不再落盘):区间起点 = 该轮 user seq 3
    expect(carrierTargetSeq(marker)).toBe(3)
  })

  it('文件 span 注入但 probe 带不出 prompt(内存该点也是洞)→ 保守 no-prompt,不重发错文本', async () => {
    const session = sparseHoleSession()
    const agent = makeAgent()
    const api = makeApi(session, agent)

    const result = await api.regenerate({ sessionId: 's1', messageId: 'a2', span: fileSpan }) // 无 regeneratePrompt

    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('no-prompt') // 可理解的错误,不是内部错误
    expect(agent.followup).not.toHaveBeenCalled() // 绝不越过洞重发更早轮文本
    expect(lastMarker(session)).toBeNull() // 无 marker 落盘(会话未被改)
  })

  it('文件 span + 内存无洞(调用方自有 span)→ 原文从 span 起点单点读取(不扫描)', async () => {
    const session = makeSession().seed(
      headerEvent(),
      userMessage('u1', 'OLDER ROUND PROMPT'),
      assistantMessage('a1', 'older answer'),
      userMessage('u2', 'SAME ROUND PROMPT'),
      assistantMessage('a2', 'current answer'),
    )
    session.surface.nodes.pop() // 内存 surface 滞后(events 齐全)
    const agent = makeAgent()
    const api = makeApi(session, agent)

    const result = await api.regenerate({ sessionId: 's1', messageId: 'a2', span: fileSpan })

    expect(result.ok).toBe(true)
    expect(agent.followup.mock.calls[0][0].content[0].text).toBe('SAME ROUND PROMPT')
    expect(carrierTargetSeq(lastMarker(session))).toBe(3)
  })

  it('跨遮蔽区(更早轮已被 fold 遮蔽成幽灵) + 当前轮 user 是洞 → 只重发当前轮原文', async () => {
    const session = makeSession().seed(
      headerEvent(),
      userMessage('u1', 'SHADOWED OLD PROMPT'), // seq 1(被 fold 遮蔽 → 幽灵)
      assistantMessage('a1', 'old answer'), // seq 2
      userMessage('u2', 'CURRENT PROMPT'), // seq 3(当前轮 user → 洞)
      assistantMessage('a2', 'current answer'), // seq 4(regenerate 目标)
    )
    const agent = makeAgent()
    const api = makeApi(session, agent)
    // 轮1 被 marker 遮蔽(replace 区间 1..2,与 index.js 注入 span 后的落盘同形)——
    // 日志 append-only,u1/a1 仍是 events(幽灵),旧实现的稀疏扫描会选中它们。
    session.append('assistant/message', {
      turn: 1, step: 1,
      message: { id: 'retrace-recall-x', role: 'assistant', content: [], source: { kind: 'model', provider: 'p', model: 'm' } },
      editor: { targetSeq: 1, text: '' },
    }, { surfaceOp: { op: 'replace', start: 1, end: 2 }, sourceEventSeqs: [1, 2] })
    session.surface.nodes.pop() // 内存 surface 滞后:目标 a2 未纳入
    session.dropAt(3) // 当前轮 user 是洞

    const result = await api.regenerate({
      sessionId: 's1',
      messageId: 'a2',
      span: fileSpan,
      regeneratePrompt: { seq: 3, text: 'CURRENT PROMPT' },
    })

    expect(result.ok).toBe(true)
    expect(agent.followup.mock.calls[0][0].content[0].text).toBe('CURRENT PROMPT')
    expect(agent.followup.mock.calls[0][0].content[0].text).not.toBe('SHADOWED OLD PROMPT')
    const marker = lastMarker(session)
    expect(marker.data.id).toMatch(/^retrace-regenerate-/)
    expect(carrierTargetSeq(marker)).toBe(3) // 不是被遮蔽幽灵轮的 seq 1
    expect(marker.surfaceOp).toEqual({ op: 'replace', start: 3, end: 4 })
  })
})
