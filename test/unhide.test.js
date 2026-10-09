/**
 * 撤销撤回(unhide,0.4.124)—— 宿主侧写路径。
 *
 * 需求:误撤回之后要把界面恢复到撤回前,必须有一条 append-only 的取消写入
 * (而界面当时没有该入口)。本文件钉住这条写入的形状:
 *   · 写侧形状:`user/message` + `surfaceOp:'append'` + 独立前缀
 *     `retrace-unhide-` + `data.cancels = <被取消 marker 载体 seq>`,**绝不写第 2 段
 *     `compaction/prune` 审计**(那等于又隐藏一遍);
 *   · 幂等:同一 marker 重复取消不再写第二条;
 *   · 既有行逐字节不动(append-only);
 *   · 真实 `dsh-log-contract` 写前校验路径接受该信封(带 op/cancels 两个业务成员)。
 */
import { describe, it, expect, vi } from 'vitest'
import { createEditorApi, UNHIDE_TRACE_TEXT, UNHIDE_ID_PREFIX, markerOpOfMarkerId } from '../lib/host-core.js'
import { AUDIT_EVENT_TYPE, isCarrierMarkerEvent } from '../lib/marker-carrier.js'
import { isRoundBoundaryEvent } from '../lib/span-semantics.js'
import { createMarkerGuard } from '../lib/prewrite-guard.js'
import { createDshMarkerWriter } from '../lib/adapter/dsh-writer.js'
import { sessionEvents, eventAt } from '../lib/host-compat.js'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import {
  makeSession,
  userMessage,
  assistantMessage,
  headerEvent,
  makeEnv,
  makeAgent,
  makeApi,
  makeHooks,
  lastCarrierMarker,
} from './helpers.js'
import { deriveMessage, officialSurfaceMeter } from './official-meter.js'

/** header + u1 + a1 + u2 + a2 —— 标准两轮会话。 */
function standardSession() {
  return makeSession().seed(
    headerEvent(),
    userMessage('u1', 'first question'),
    assistantMessage('a1', 'first answer'),
    userMessage('u2', 'second question'),
    assistantMessage('a2', 'second answer'),
  )
}

/** 日志里的审计段数(第 1 段 `compaction/prune`)。 */
function auditCount(session) {
  return sessionEvents(session).filter((event) => event?.type === AUDIT_EVENT_TYPE).length
}

describe('unhide — 写侧形状(append-only 取消标记)', () => {
  it('撤回后取消:追加 1 条 retrace-unhide-* + surfaceOp append + cancels=marker seq,且零审计段', async () => {
    const session = standardSession()
    const api = makeApi(session, makeAgent())
    const recall = await api.recall({ sessionId: 's1', messageId: 'u1' })
    expect(recall.ok).toBe(true)
    const marker = lastCarrierMarker(session)
    expect(marker).toBeTruthy()
    const before = sessionEvents(session).length
    const auditsBefore = auditCount(session)
    const markerJson = JSON.stringify(eventAt(session, marker.seq))

    const result = await api.unhide({ sessionId: 's1', markerSeq: marker.seq })

    expect(result.ok).toBe(true)
    expect(result.value).toMatchObject({
      op: 'unhide',
      markerSeq: marker.seq,
      cancels: marker.seq,
      alreadyCancelled: false,
      shadowed: 0,
    })
    // 只多 1 行(单段;两段 marker 是 +2)
    expect(sessionEvents(session).length).toBe(before + 1)
    // ⛔ 绝不写第 1/2 段审计(那等于又隐藏一遍)
    expect(auditCount(session)).toBe(auditsBefore)
    const event = eventAt(session, result.value.cancelSeq)
    expect(event.type).toBe('user/message')
    expect(event.data.id.startsWith(UNHIDE_ID_PREFIX)).toBe(true)
    expect(event.data.id).toMatch(/^retrace-unhide-[0-9a-z]+-[0-9a-z]+$/)
    expect(event.data.op).toBe('unhide')
    expect(event.data.cancels).toBe(marker.seq)
    expect(event.data.content).toEqual([{ type: 'text', text: UNHIDE_TRACE_TEXT }])
    expect(event.data.content[0].text).toContain('已恢复显示')
    // 单段 append(**不是** replace:replace 会把原 marker 载体换出面,客户端就看不到
    // "被取消的是哪条 marker"了)
    expect(event.surfaceOp).toBe('append')
    expect(event.sourceEventSeqs).toBeUndefined()
    // 轮边界红线:source.kind='model' ⇒ 不被当成真实用户输入
    expect(event.data.source.kind).toBe('model')
    expect(isRoundBoundaryEvent(event)).toBe(false)
    // append-only:既有行(两段 marker)逐字节不变
    expect(JSON.stringify(eventAt(session, marker.seq))).toBe(markerJson)
    // 被遮蔽的节点仍在日志里,面也没被"恢复"(本能力只改客户端显示)
    expect(sessionEvents(session).some((e) => e?.type === 'user/message' && e.data?.id === 'u2')).toBe(true)
  })

  it('markerId 路径同样可达(客户端没有 seq 时的兜底)', async () => {
    const session = standardSession()
    const api = makeApi(session, makeAgent())
    await api.recall({ sessionId: 's1', messageId: 'u2' })
    const marker = lastCarrierMarker(session)

    const result = await api.unhide({ sessionId: 's1', markerId: String(marker.data.id) })

    expect(result.ok).toBe(true)
    expect(result.value.markerSeq).toBe(marker.seq)
    const event = eventAt(session, result.value.cancelSeq)
    expect(event.data.cancels).toBe(marker.seq)
  })

  it('幂等:同一 marker 重复取消不再写第二条(第二次返回 alreadyCancelled)', async () => {
    const session = standardSession()
    const api = makeApi(session, makeAgent())
    await api.recall({ sessionId: 's1', messageId: 'u2' })
    const marker = lastCarrierMarker(session)

    const first = await api.unhide({ sessionId: 's1', markerSeq: marker.seq })
    const afterFirst = sessionEvents(session).length
    const second = await api.unhide({ sessionId: 's1', markerSeq: marker.seq })

    expect(first.value.alreadyCancelled).toBe(false)
    expect(second.ok).toBe(true)
    expect(second.value).toMatchObject({ alreadyCancelled: true, cancelSeq: first.value.cancelSeq, cancels: marker.seq })
    expect(sessionEvents(session).length).toBe(afterFirst)
  })

  it('写入前过 hooks.validateMarker(信封不带 seq,单段 append)', async () => {
    const session = standardSession()
    const { sessions, agents } = makeEnv(session, { agent: makeAgent() })
    const validateMarker = vi.fn(async () => ({ t1Ok: true }))
    const api = createEditorApi({}, sessions, agents, () => {}, makeHooks(agents, { validateMarker }))
    await api.recall({ sessionId: 's1', messageId: 'u2' })
    const marker = lastCarrierMarker(session)
    validateMarker.mockClear()

    const result = await api.unhide({ sessionId: 's1', markerSeq: marker.seq })

    expect(result.ok).toBe(true)
    expect(validateMarker).toHaveBeenCalledTimes(1)
    const [calledSession, envelope] = validateMarker.mock.calls[0]
    expect(calledSession).toBe(session)
    expect(Object.hasOwn(envelope, 'seq')).toBe(false)
    expect(envelope.type).toBe('user/message')
    expect(envelope.surfaceOp).toBe('append')
    expect(envelope.data.op).toBe('unhide')
    expect(envelope.data.cancels).toBe(marker.seq)
  })

  it('目标不是本插件 marker 载体 ⇒ marker-not-found(零写入);取消标记不能再取消', async () => {
    const session = standardSession()
    const api = makeApi(session, makeAgent())
    const before = sessionEvents(session).length

    // ① 普通用户消息的 seq
    const notMarker = await api.unhide({ sessionId: 's1', markerSeq: 1 })
    expect(notMarker.ok).toBe(false)
    expect(notMarker.error.code).toBe('marker-not-found')

    // ② 不存在的 seq
    const missing = await api.unhide({ sessionId: 's1', markerSeq: 9999 })
    expect(missing.error.code).toBe('marker-not-found')

    // ③ 参数缺失
    const bad = await api.unhide({ sessionId: 's1' })
    expect(bad.error.code).toBe('bad-request')

    // ④ 取消标记自身
    await api.recall({ sessionId: 's1', messageId: 'u2' })
    const marker = lastCarrierMarker(session)
    const first = await api.unhide({ sessionId: 's1', markerSeq: marker.seq })
    const second = await api.unhide({ sessionId: 's1', markerSeq: first.value.cancelSeq })
    expect(second.ok).toBe(false)
    expect(second.error.code).toBe('marker-not-cancellable')
    expect(sessionEvents(session).length).toBe(before + 3) // 两段 marker + 1 条取消标记
  })

  it('markerOpOfMarkerId:unhide 与宿主/客户端同词表(改前缀即红)', () => {
    expect(markerOpOfMarkerId('retrace-unhide-mf3k-ab12cd34')).toBe('unhide')
    expect(markerOpOfMarkerId('retrace-recall-1')).toBe('recall')
    expect(markerOpOfMarkerId('retrace-edit-1')).toBe('edit')
    expect(markerOpOfMarkerId('retrace-regenerate-1')).toBe('regenerate')
    expect(markerOpOfMarkerId('retrace-restore-1')).toBe('restore')
    expect(markerOpOfMarkerId('message-editor-unhide-1')).toBe('unhide')
    expect(markerOpOfMarkerId('retrace-unknown-1')).toBe('')
    expect(markerOpOfMarkerId('')).toBe('')
  })
})

describe('unhide — 真实 dsh-log-contract 写前校验(带 op/cancels 业务成员)', () => {
  /** 与 test/marker-append-seq.test.js 同形:请求头 + 一轮对话(surfaceOp append)。 */
  function realLogSession() {
    const session = makeSession()
    session.header = { version: SESSION_FORMAT_VERSION, id: 's1', createdAt: 0, isSeeded: false }
    session.append('request/header', { header: { config: { provider: 'p', model: 'm' } } })
    session.append(
      'user/message',
      { id: 'u1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } },
      { surfaceOp: 'append' },
    )
    session.append(
      'assistant/message',
      {
        turn: 0,
        step: 0,
        message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'yo' }], source: { kind: 'model', provider: 'p', model: 'm' } },
      },
      { surfaceOp: 'append' },
    )
    return session
  }

  /** 生产装配:真实 guard(懒加载 dsh-log-contract)+ 真实 writer。 */
  function realApi(session, log = () => {}) {
    const guard = createMarkerGuard({ log })
    const writer = createDshMarkerWriter({
      validateMarker: guard.validateMarkerAppend,
      meter: officialSurfaceMeter(),
      deriveMessage,
    })
    const { sessions, agents } = makeEnv(session, { agent: makeAgent() })
    return createEditorApi({}, sessions, agents, log, {
      validateMarker: guard.validateMarkerAppend,
      writeMarker: writer.writeMarker,
    })
  }

  it('撤回 → 取消:两条写入都过真实契约守卫(取消标记的信封不被拒)', async () => {
    const session = realLogSession()
    const logs = []
    const api = realApi(session, (line) => logs.push(String(line)))
    const recall = await api.recall({ sessionId: 's1', messageId: 'a1' })
    expect(recall.ok, `recall 应通过真实守卫: ${JSON.stringify(recall.error ?? {})}`).toBe(true)
    const marker = lastCarrierMarker(session)
    expect(isCarrierMarkerEvent(marker)).toBe(true)

    const result = await api.unhide({ sessionId: 's1', markerSeq: marker.seq })

    expect(result.ok, `unhide 应通过真实守卫: ${JSON.stringify(result.error ?? {})}`).toBe(true)
    expect(result.value.alreadyCancelled).toBe(false)
    expect(logs.filter((line) => line.includes('marker-rejected'))).toEqual([])
    const event = eventAt(session, result.value.cancelSeq)
    expect(event.data.op).toBe('unhide')
    expect(event.data.cancels).toBe(marker.seq)
  })

  it('零写入侧:守卫拒绝时不留半行(带不可序列化的 cancels?不——用不存在的目标走坏路径)', async () => {
    // 守卫拒绝的模拟:validateMarker 抛 marker-rejected ⇒ append 不得发生。
    const session = realLogSession()
    const api = realApi(session)
    await api.recall({ sessionId: 's1', messageId: 'a1' })
    const marker = lastCarrierMarker(session)
    const before = sessionEvents(session).length
    const { sessions, agents } = makeEnv(session, { agent: makeAgent() })
    const rejecting = createEditorApi({}, sessions, agents, () => {}, makeHooks(agents, {
      validateMarker: async () => { const error = new Error('rejected'); error.code = 'marker-rejected'; throw error },
    }))
    const result = await rejecting.unhide({ sessionId: 's1', markerSeq: marker.seq })
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('marker-rejected')
    expect(sessionEvents(session).length).toBe(before)
  })
})

// ---------------------------------------------------------------------------
// (B) 取消撤回之后的**可操作性**判定
//
// 用户实测:「恢复展示成功——恢复后的消息没有编辑和撤回」。修法有两条路:
//   (i) 让客户端 `useShadowed` 忽略被取消的 marker,把编辑/撤回入口放回来 ——
//       **必须**同时让宿主接受这些 op,否则按钮回来了却点一次错一次(比不回来更糟);
//   (ii) 保持入口不出现(现状),如实说明为什么。
//
// 本用例是 (i) 的**前置证据**:取消标记只写一条单段 append(它不产生 replace、
// 也不改模型面,见本文件顶部的形状断言),而 editAndResend/recall/regenerate 的
// span 计算都要求目标 seq 仍在当前面(surface)上 ⇒ 三个 op 现在全返回
// `target-shadowed`。所以当前选 (ii)。
// ⚠️ 若将来落成"把被遮蔽内容重新物化回面"的新 op(相当于恢复视图那套),
// 这个用例必须与 lib/client.js 的 useShadowed 一起改(删掉本块 + 客户端放行),
// 否则就是"能点但必失败"。
// ---------------------------------------------------------------------------
describe('(B) 取消标记不改变可操作性:三个 op 仍被宿主拒(target-shadowed)', () => {
  it('editAndResend / recall / regenerate 在已取消的 marker 目标上全部被拒', async () => {
    const session = standardSession()
    const api = makeApi(session, makeAgent())
    const recall = await api.recall({ sessionId: 's1', messageId: 'u1' })
    expect(recall.ok).toBe(true)
    const marker = lastCarrierMarker(session)
    const un = await api.unhide({ sessionId: 's1', markerSeq: marker.seq })
    expect(un.ok).toBe(true)

    const attempts = [
      ['editAndResend', { messageId: 'u1', text: 'rewritten', fromScratch: true }],
      ['recall', { messageId: 'u1' }],
      ['regenerate', { messageId: 'a1' }],
    ]
    for (const [op, payload] of attempts) {
      const result = await api[op]({ sessionId: 's1', ...payload })
      expect(result.ok, `${op} 不该在已取消的遮蔽目标上成功(面没恢复)`).toBe(false)
      expect(result.error.code, `${op} 的拒因`).toBe('target-shadowed')
    }
  })
})
