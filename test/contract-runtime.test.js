/**
 * 契约运行时化测试("契约仅 JSDoc 声明 → 跨层契约错误
 * 以奇怪方式炸")。
 *
 * 声称 = 有校验:本套件把 lib/adapter/contract.js 的每条运行时断言都钉住——
 *  - 违规必须**抛**(不是静默通过、不是莫名崩溃);
 *  - 错误信息必须说清「哪个契约 / 期望什么 / 实际什么」;
 *  - 端到端:业务层传入坏 span / 适配器返回坏 marker → 立刻 contract-violation。
 */
import { describe, it, expect, vi } from 'vitest'
import { sessionEvents, eventAt } from '../lib/host-compat.js'
import {
  CONTRACT_VIOLATION, contractViolation, assertContract, assertSpanShape, assertSpanResult,
  assertSpanFacts, assertEventListShape, assertMarkerShape, assertAuditShape, markerSurfaceRange,
  assertAdapterShape, createAdapter, NULL_ADAPTER,
} from '../lib/adapter/contract.js'
import { createDshMarkerWriter } from '../lib/adapter/dsh-writer.js'
import { officialSurfaceMeter, deriveMessage } from './official-meter.js'
import { createEditorApi } from '../lib/host-core.js'
import { makeSession, makeAgent, makeApi, userMessage, assistantMessage, headerEvent } from './helpers.js'

const span = (start = 0, end = 2) => ({ start, end, shadowedSeqs: [start, start + 1, end].filter((v, i, a) => a.indexOf(v) === i && v <= end) })

describe('契约违规错误形状(哪个契约 / 期望什么 / 实际什么)', () => {
  it('contractViolation:message 带契约名+期望+实际,error 上挂 contract/expected/actual', () => {
    const error = contractViolation('Span.shape', 'start 为非负整数', -1)
    expect(error.message).toBe('契约违规[Span.shape]:期望 start 为非负整数;实际 -1')
    expect(error.code).toBe(CONTRACT_VIOLATION)
    expect(error.contract).toBe('Span.shape')
    expect(error.expected).toBe('start 为非负整数')
    expect(error.actual).toBe(-1)
  })

  it('contractViolation:实际值渲染紧凑(对象/数组只给形状,不 dump 百万事件)', () => {
    expect(contractViolation('c', 'e', { a: 1, b: 2 }).message).toContain('{a,b}')
    expect(contractViolation('c', 'e', [1, 2, 3]).message).toContain('Array(3)')
    expect(contractViolation('c', 'e', undefined).message).toContain('undefined')
    expect(contractViolation('c', 'e', null).message).toContain('null')
    expect(contractViolation('c', 'e', () => {}).message).toContain('function')
  })

  it('assertContract:通过返回 true;不通过抛契约违规', () => {
    expect(assertContract(true, 'c', 'e', 1)).toBe(true)
    expect(() => assertContract(false, 'c', 'e', 1)).toThrow(/契约违规\[c\]/)
  })
})

describe('Span.shape(跨层 span 结构契约)', () => {
  it('合法 span 通过,并原样返回', () => {
    const s = { start: 0, end: 2, shadowedSeqs: [0, 1, 2] }
    expect(assertSpanShape(s)).toBe(s)
  })

  it('非对象/空段/首尾≠start,end/元素非法 → 明确报错', () => {
    expect(() => assertSpanShape(null)).toThrow(/Span\.shape.*期望 span 为对象/)
    expect(() => assertSpanShape({ start: 0, end: 2, shadowedSeqs: [] })).toThrow(/shadowedSeqs 为非空数组/)
    expect(() => assertSpanShape({ start: 0, end: 2, shadowedSeqs: [0, 9] })).toThrow(/shadowedSeqs 首尾 === span\.start\/end/)
    expect(() => assertSpanShape({ start: -1, end: 0, shadowedSeqs: [-1, 0] })).toThrow(/span\.start 为非负安全整数/)
    expect(() => assertSpanShape({ start: 0, end: -1, shadowedSeqs: [0, -1] })).toThrow(/span\.end 为非负安全整数/)
    expect(() => assertSpanShape({ start: 0, end: 1, shadowedSeqs: [0, 'x'] })).toThrow(/元素全为非负安全整数/)
  })

  it('**不断言 start <= end**:位置序 span 的 seq 数值可非单调(marker 插入 → 合法)', () => {
    // 官方 replacementRange 只按 indexOf(start) <= indexOf(end) 的**位置**判定;
    // 真实会话实测:位置连续段 [start … end](start 数值 > end)是正常写入。
    const positional = { start: 420, end: 415, shadowedSeqs: [420, 418, 415] }
    expect(assertSpanShape(positional)).toBe(positional)
    expect(() => assertMarkerShape({
      seq: 12,
      type: 'user/message',
      surfaceOp: { op: 'replace', start: 420, end: 415 },
      sourceEventSeqs: [421, 420, 418, 415],
      data: {
        role: 'user',
        id: 'retrace-recall-x',
        content: [{ type: 'text', text: '（此处内容已被撤回：原消息已归档，可在恢复视图中查看）' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
    })).not.toThrow()
  })

  it('契约名可定制(报错指认调用点)', () => {
    expect(() => assertSpanShape(null, 'host-core.writeMarker.span')).toThrow(/契约违规\[host-core\.writeMarker\.span\]/)
  })
})

describe('SpanResult.shape / SpanFacts.shape(显式状态结果契约)', () => {
  it('ok + 合法 span 通过;ok 缺 span → 报错', () => {
    const ok = { status: 'ok', span: { start: 0, end: 1, shadowedSeqs: [0, 1] }, facts: { fileMaxSeq: 1, targetSeq: 0 } }
    expect(assertSpanResult(ok)).toBe(ok)
    expect(() => assertSpanResult({ status: 'ok', span: null })).toThrow(/SpanResult\.shape\.span/)
  })

  it('非 ok 状态带 span → 报错(状态显式,不允许自相矛盾)', () => {
    expect(() => assertSpanResult({ status: 'not-found', span: { start: 0, end: 1, shadowedSeqs: [0, 1] } }))
      .toThrow(/status ≠ ok 时 span 必须为空/)
  })

  it('非法 status → 报错并列全合法取值', () => {
    expect(() => assertSpanResult({ status: 'pending', span: null }))
      .toThrow(/status ∈ SPAN_STATUS\(ok\|not-found\|already-shadowed\|not-persisted\|replay-failed\)/)
  })

  it('facts 必须是安全整数(-1 = 未知)', () => {
    expect(() => assertSpanFacts({ fileMaxSeq: 'x', targetSeq: 0 })).toThrow(/fileMaxSeq 为安全整数/)
    expect(() => assertSpanFacts({ fileMaxSeq: 0, targetSeq: null })).toThrow(/targetSeq 为安全整数/)
    expect(assertSpanFacts({ fileMaxSeq: -1, targetSeq: -1 })).toEqual({ fileMaxSeq: -1, targetSeq: -1 })
  })
})

describe('EventReader.events(事件列表契约,抽样校验)', () => {
  it('合法(含无 seq 的 header 帧)通过;非数组报错', () => {
    const events = [{ type: 'session', version: 0 }, { seq: 1, type: 'user/message' }, { seq: 2, type: 'assistant/message' }]
    expect(assertEventListShape(events)).toBe(events)
    expect(() => assertEventListShape({ events: [] })).toThrow(/事件列表为数组/)
    expect(assertEventListShape([])).toEqual([])
  })

  it('undefined 洞(记录包装漂移)→ 抽样命中并明确报错', () => {
    const events = [{ seq: 0, type: 'user/message' }, undefined, { seq: 2, type: 'assistant/message' }]
    expect(() => assertEventListShape(events)).toThrow(/events\[1\] 为非 null 对象/)
  })

  it('seq 非数字 / type 非字符串 → 报错(抽样到才报,不 O(n) 全量)', () => {
    expect(() => assertEventListShape([{ seq: '1', type: 'user/message' }])).toThrow(/seq 为安全整数/)
    expect(() => assertEventListShape([{ seq: 1, type: 42 }])).toThrow(/type 为字符串/)
  })
})

describe('ReplaceWriter.marker(两段结构第 2 段契约)', () => {
  const good = {
    seq: 6,
    type: 'user/message',
    surfaceOp: { op: 'replace', start: 0, end: 1 },
    sourceEventSeqs: [5, 0, 1],
    data: {
      role: 'user',
      id: 'retrace-recall-x',
      content: [{ type: 'text', text: '（此处内容已被撤回：原消息已归档，可在恢复视图中查看）' }],
      source: { kind: 'model', provider: 'p', model: 'm' },
    },
  }

  it('合法载体通过(真实 writer 产出形状)', () => {
    expect(assertMarkerShape(good)).toBe(good)
    // 去掉审计引导项后,端点仍是区间首尾(读端口径)
    expect(assertMarkerShape(good, 'ReplaceWriter.marker', { auditSeq: 5 })).toBe(good)
  })

  it('缺 surfaceOp / 非 user-message / data 成员越界 / content 空 / source 非 model → 报错', () => {
    expect(() => assertMarkerShape({ ...good, surfaceOp: undefined })).toThrow(/marker\.surfaceOp = \{op:'replace',start,end\}/)
    expect(() => assertMarkerShape({ ...good, type: 'assistant/message' })).toThrow(/marker\.type === 'user\/message'/)
    expect(() => assertMarkerShape({ ...good, sourceEventSeqs: [5, 0, 1, 2] })).toThrow(/sourceEventSeqs 首尾 === surfaceOp\.start\/end/)
    expect(() => assertMarkerShape({ ...good, seq: -1 })).toThrow(/marker\.seq 为非负安全整数/)
    // 官方 user/message 词表精确四成员:多一个成员即被官方拒(editor 无处容身)
    expect(() => assertMarkerShape({ ...good, data: { ...good.data, editor: { targetSeq: 0 } } }))
      .toThrow(/marker\.data 键集恰为 \{role,id,content,source\}/)
    // 空 content 会投影成一条空 user 消息(实测)⇒ 写侧拦下
    expect(() => assertMarkerShape({ ...good, data: { ...good.data, content: [] } }))
      .toThrow(/marker\.data\.content 为非空数组/)
    // source.kind 非 'model' → 轮边界污染(官方不拦,写侧拦)
    expect(() => assertMarkerShape({ ...good, data: { ...good.data, source: { kind: 'user' } } }))
      .toThrow(/marker\.data\.source\.kind === 'model'/)
    expect(() => assertMarkerShape({ ...good, data: { ...good.data, id: 'not-a-marker' } }))
      .toThrow(/marker\.data\.id 为我方 marker id/)
  })

  it('★ 首元素 = 审计 seq:与 surfaceOp 起点撞号 / 引用未产生的事件 → 报错', () => {
    // 撞号(审计 seq 与被遮蔽节点相同)= 官方 provenance 重复项
    expect(() => assertMarkerShape({ ...good, sourceEventSeqs: [1, 0, 1] }, 'ReplaceWriter.marker', { auditSeq: 1 }))
      .toThrow(/sourceEventSeqs 无重复项/)
    // 陈旧的 span:被遮蔽项 seq ≥ 审计 seq(该事件此刻还不存在)——
    // 端点断言先命中(末项 7 ≠ 区间终点 1);取端点一致但含未来 seq 的形态再验该闸
    expect(() => assertMarkerShape({ ...good, sourceEventSeqs: [5, 0, 6, 1] }, 'ReplaceWriter.marker', { auditSeq: 5 }))
      .toThrow(/全部被遮蔽节点 seq 早于审计事件 seq 5/)
  })
})

describe('ReplaceWriter.audit(两段结构第 1 段契约)', () => {
  const good = {
    seq: 5,
    type: 'compaction/prune',
    data: { shadowedRange: { start: 0, end: 1 }, shadowedSeqs: [0, 1], shadowedTokenCount: 2 },
  }

  it('合法审计事件通过', () => {
    expect(assertAuditShape(good)).toBe(good)
  })

  it('成员越界 / 带 surfaceOp·sourceEventSeqs / 端点不符 / tokenCount 非法 → 报错', () => {
    expect(() => assertAuditShape({ ...good, data: { ...good.data, editor: {} } }))
      .toThrow(/审计事件 data 键集恰为 \{shadowedRange,shadowedSeqs,shadowedTokenCount\}/)
    expect(() => assertAuditShape({ ...good, surfaceOp: { op: 'replace', start: 0, end: 1 } }))
      .toThrow(/审计事件不带 surfaceOp\/sourceEventSeqs/)
    expect(() => assertAuditShape({ ...good, sourceEventSeqs: [0, 1] }))
      .toThrow(/审计事件不带 surfaceOp\/sourceEventSeqs/)
    expect(() => assertAuditShape({ ...good, data: { ...good.data, shadowedSeqs: [0, 2] } }))
      .toThrow(/shadowedSeqs 首尾 === shadowedRange 端点/)
    expect(() => assertAuditShape({ ...good, data: { ...good.data, shadowedSeqs: [0, 0, 1] } }))
      .toThrow(/shadowedSeqs 无重复 seq/)
    expect(() => assertAuditShape({ ...good, data: { ...good.data, shadowedTokenCount: -1 } }))
      .toThrow(/shadowedTokenCount 为非负整数/)
    expect(() => assertAuditShape({ ...good, type: 'user/message' }))
      .toThrow(/审计事件 type === 'compaction\/prune'/)
  })
})

/**
 * #2:surfaceOp 键名是**运行时可变的官方契约**——
 * 运行时 0.1.1-rc.2(v0 树)= {start,end};lab 0.1.5(v3 树)= {startSeq,endSeq}
 * (v2→v3 迁移改写键名)。两棵树都要求键数**精确为 3**,故不得混写。
 * 契约层必须**特性探测双形状**,而不是硬断言单一形状(否则 lab v3 上误报)。
 */
describe('markerSurfaceRange(surfaceOp 双形状特性探测)', () => {
  it('v0 形状 {op,start,end} 通过,并回报键名', () => {
    expect(markerSurfaceRange({ op: 'replace', start: 0, end: 1 }))
      .toEqual({ start: 0, end: 1, shape: 'start/end', startKey: 'start', endKey: 'end' })
  })

  it('v3 形状 {op,startSeq,endSeq} 通过,并回报键名(lab 0.1.5)', () => {
    expect(markerSurfaceRange({ op: 'replace', startSeq: 7, endSeq: 9 }))
      .toEqual({ start: 7, end: 9, shape: 'startSeq/endSeq', startKey: 'startSeq', endKey: 'endSeq' })
  })

  it('双形状均接受**位置序**(start 数值可 > end)', () => {
    expect(markerSurfaceRange({ op: 'replace', start: 9, end: 7 }).shape).toBe('start/end')
    expect(markerSurfaceRange({ op: 'replace', startSeq: 9, endSeq: 7 }).shape).toBe('startSeq/endSeq')
  })

  it('混写(同时带 start 与 startSeq)/键数不为 3 / op 非 replace → 明确报错', () => {
    expect(() => markerSurfaceRange({ op: 'replace', start: 0, end: 1, startSeq: 0, endSeq: 1 }))
      .toThrow(/键集为 \{op,start,end\}.*或 \{op,startSeq,endSeq\}.*不得混用/)
    expect(() => markerSurfaceRange({ op: 'replace', start: 0, end: 1, extra: 2 })).toThrow(/不得混用/)
    expect(() => markerSurfaceRange({ op: 'append', start: 0, end: 1 })).toThrow(/marker\.surfaceOp = \{op:'replace',start,end\}/)
    expect(() => markerSurfaceRange(null)).toThrow(/marker\.surfaceOp = \{op:'replace',start,end\}/)
  })

  it('端点非非负安全整数 → 报错', () => {
    expect(() => markerSurfaceRange({ op: 'replace', start: -1, end: 1 })).toThrow(/区间端点为非负安全整数/)
    expect(() => markerSurfaceRange({ op: 'replace', startSeq: 0, endSeq: 'x' })).toThrow(/区间端点为非负安全整数/)
  })
})

describe('assertMarkerShape 认双形状(v3 树 marker 不再误报)', () => {
  const v3Good = {
    seq: 43,
    type: 'user/message',
    surfaceOp: { op: 'replace', startSeq: 40, endSeq: 41 },
    sourceEventSeqs: [42, 40, 41],
    data: {
      role: 'user',
      id: 'retrace-edit-x',
      content: [{ type: 'text', text: '（此处内容已被撤回：原消息已归档，可在恢复视图中查看）' }],
      source: { kind: 'model', provider: 'p', model: 'm' },
    },
  }

  it('v3 形状 marker 在 **v3 树**上通过并原样返回(注入目标树,不依赖当前运行时)', () => {
    const v3rt = { shape: 'startSeq/endSeq', version: 3, startKey: 'startSeq', endKey: 'endSeq' }
    expect(assertMarkerShape(v3Good, 'ReplaceWriter.marker', { runtimeShape: v3rt })).toBe(v3Good)
  })

  it('v3 形状下 sourceEventSeqs 首尾不一致 → 报错信息用 v3 键名(注入 v3 树)', () => {
    const v3rt = { shape: 'startSeq/endSeq', version: 3, startKey: 'startSeq', endKey: 'endSeq' }
    expect(() => assertMarkerShape({ ...v3Good, sourceEventSeqs: [42, 40, 41, 99] }, 'ReplaceWriter.marker', { runtimeShape: v3rt }))
      .toThrow(/sourceEventSeqs 首尾 === surfaceOp\.startSeq\/endSeq/)
  })

  it('★ 双向误用探测:**在 v0 运行时写 v3 形状** → 明确报错(不得静默)', () => {
    const v0rt = { shape: 'start/end', version: 0, startKey: 'start', endKey: 'end' }
    expect(() => assertMarkerShape(v3Good, 'ReplaceWriter.marker', { runtimeShape: v0rt }))
      .toThrow(/形状须与当前运行时一致|contract-violation/)
  })

  it('v0 形状仍按 v0 键名报错(不回归)', () => {
    const v0Good = {
      seq: 6, type: 'user/message',
      surfaceOp: { op: 'replace', start: 0, end: 1 }, sourceEventSeqs: [5, 0, 1],
      data: {
        role: 'user', id: 'retrace-recall-y',
        content: [{ type: 'text', text: '（此处内容已被撤回：原消息已归档，可在恢复视图中查看）' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
    }
    expect(assertMarkerShape(v0Good)).toBe(v0Good)
    expect(() => assertMarkerShape({ ...v0Good, sourceEventSeqs: [5, 0, 1, 2] }))
      .toThrow(/sourceEventSeqs 首尾 === surfaceOp\.start\/end/)
  })
})

describe('Adapter.shape(适配器组装契约)', () => {
  it('缺 reader.readEvents / writer.writeReplace → 组装即报错(不再运行到一半才炸)', () => {
    expect(() => createAdapter({}, { writeReplace: async () => null })).toThrow(/adapter\.reader\.readEvents 为函数/)
    expect(() => createAdapter({ readEvents: async () => null }, {})).toThrow(/adapter\.writer\.writeReplace 为函数/)
    expect(() => assertAdapterShape(null)).toThrow(/适配器为对象 \{reader, writer\}/)
    expect(createAdapter({ readEvents: async () => null }, { writeReplace: async () => null }).reader.readEvents).toBeTypeOf('function')
    expect(NULL_ADAPTER.writer.writeReplace).toBeTypeOf('function')
  })
})

describe('端到端:跨层契约违规 → 立刻明确报错(不静默、不奇怪地炸)', () => {
  it('业务层传入坏 span → dsh-writer 边界抛 contract-violation(带契约名)', async () => {
    const writer = createDshMarkerWriter({ meter: officialSurfaceMeter(), deriveMessage })
    const session = makeSession().seed(headerEvent(), userMessage('u1', 'hi'), assistantMessage('a1', 'yo'))
    // 首尾与 start/end 不一致(位置连续段被破坏)
    await expect(writer.writeMarker(session, { start: 0, end: 5, shadowedSeqs: [0, 1, 9] }, { op: 'recall', targetSeq: 0, originalText: '' }))
      .rejects.toThrow(/契约违规\[dshAdapter\.writeMarker\.span\].*shadowedSeqs 首尾/)
    // start 非整数
    await expect(writer.writeMarker(session, { start: '0', end: 1, shadowedSeqs: [0, 1] }, { op: 'recall', targetSeq: 0, originalText: '' }))
      .rejects.toThrow(/span\.start 为非负安全整数/)
    // 空 span 同样拦下(写出去就是"遮蔽零条"的诡异 marker)
    await expect(writer.writeMarker(session, { start: 0, end: 0, shadowedSeqs: [] }, { op: 'recall', targetSeq: 0, originalText: '' }))
      .rejects.toThrow(/shadowedSeqs 为非空数组/)
    // 注意:**start 数值 > end 数值不是违规**(位置序;官方只判 indexOf(start) <= indexOf(end))
    // 会话须覆盖 span 里的每个 seq(两段结构的审计段占用"下一个 seq",陈旧 span 会被拦下)
    const posSession = makeSession().seed(
      headerEvent(), userMessage('u1', 'q1'), assistantMessage('a1', 'r1'),
      userMessage('u2', 'q2'), assistantMessage('a2', 'r2'), userMessage('u3', 'q3'),
    )
    const positional = await writer.writeMarker(posSession, { start: 4, end: 1, shadowedSeqs: [4, 3, 2, 1] }, { op: 'recall', targetSeq: 1, originalText: '' })
    expect(positional.surfaceOp).toEqual({ op: 'replace', start: 4, end: 1 })
  })

  it('适配器返回坏 marker → host-core 边界抛 contract-violation(经 op 信封成 code)', async () => {
    const session = makeSession().seed(headerEvent(), userMessage('u1', 'hi'), assistantMessage('a1', 'yo'))
    const agent = makeAgent()
    const sessions = { get: () => session, flush: async () => {} }
    const agents = { get: () => agent }
    // 坏写入器:返回的 marker 缺 surfaceOp(形状不合契约)
    const api = createEditorApi({}, sessions, agents, () => {}, { writeMarker: async () => ({ seq: 9, type: 'assistant/message' }) })
    const result = await api.recall({ sessionId: 's1', messageId: 'u1' })
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe(CONTRACT_VIOLATION)
    expect(result.error.message).toMatch(/契约违规\[host-core\.writeMarker\.marker\]/)
  })

  it('出口断言失败时**先落盘再报错**(不留"客户端报失败、面上其实已改"的半状态)', async () => {
    const session = makeSession().seed(headerEvent(), userMessage('u1', 'hi'), assistantMessage('a1', 'yo'))
    const flushed = []
    const sessions = { get: () => session, flush: async (s) => { flushed.push(sessionEvents(s).length) } }
    const agents = { get: () => makeAgent() }
    const badWriter = async (s, span) => s.append('assistant/message', { turn: 1, message: { id: 'retrace-recall-bad', content: [] } }) // 缺 surfaceOp/editor
    const api = createEditorApi({}, sessions, agents, () => {}, { writeMarker: badWriter })
    const result = await api.recall({ sessionId: 's1', messageId: 'u1' })
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe(CONTRACT_VIOLATION)
    expect(flushed.length).toBe(1) // 已写内容先落盘(拒绝半状态)
    expect(flushed[0]).toBe(sessionEvents(session).length)
  })

  it('传入坏 span 时**任何写入都不发生**(断言先于 append;不留半关闭 turn)', async () => {
    const session = makeSession().seed(headerEvent(), userMessage('u1', 'hi'), assistantMessage('a1', 'yo'))
    const before = sessionEvents(session).length
    const sessions = { get: () => session, flush: async () => {} }
    const agents = { get: () => makeAgent() }
    // 写入器本身合规,但业务层传了坏 span(空 shadowedSeqs)→ 必须在任何 append 前拦住
    const writer = createDshMarkerWriter({ meter: officialSurfaceMeter(), deriveMessage })
    const api = createEditorApi({}, sessions, agents, () => {}, { writeMarker: (s, span, meta) => writer.writeMarker(s, { ...span, shadowedSeqs: [] }, meta) })
    const result = await api.recall({ sessionId: 's1', messageId: 'u1' })
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe(CONTRACT_VIOLATION)
    expect(sessionEvents(session).length).toBe(before) // 零写入(无半关闭 turn/信封残留)
  })

  it('正常路径不受断言影响(真 writer + 真 api 全绿)', async () => {
    const session = makeSession().seed(headerEvent(), userMessage('u1', 'hi'), assistantMessage('a1', 'yo'))
    const api = makeApi(session, makeAgent())
    const result = await api.recall({ sessionId: 's1', messageId: 'u1' })
    expect(result.ok).toBe(true)
    const marker = sessionEvents(session).find((e) => e?.surfaceOp?.op === 'replace')
    expect(() => assertMarkerShape(marker)).not.toThrow()
  })

  it('断言不改变调用方可见行为:坏 span 只在写前拦住,会话未被改坏', async () => {
    const session = makeSession().seed(headerEvent(), userMessage('u1', 'hi'), assistantMessage('a1', 'yo'))
    const before = sessionEvents(session).length
    const writer = createDshMarkerWriter({ meter: officialSurfaceMeter(), deriveMessage })
    await expect(writer.writeMarker(session, null, { op: 'recall', targetSeq: 0, originalText: '' }))
      .rejects.toMatchObject({ code: CONTRACT_VIOLATION })
    expect(sessionEvents(session).length).toBe(before) // 没有半写状态
  })
})

describe('1.2 运行时 surfaceOp 形状探测(升级前置:形状必须随运行时)', () => {
  it('runtimeSurfaceOpShape():按 SESSION_FORMAT_VERSION 判定形状(v0→start/end,v3→startSeq/endSeq)', () => {
    const { runtimeSurfaceOpShape } = require('../lib/adapter/contract.js')
    const r = runtimeSurfaceOpShape()
    // 本仓当前运行时 = 0.1.1-rc.2 ⇒ version 0 ⇒ v0 形状
    expect(typeof r.version).toBe('number')
    if (r.version >= 3) {
      expect(r.shape).toBe('startSeq/endSeq')
      expect([r.startKey, r.endKey]).toEqual(['startSeq', 'endSeq'])
    } else {
      expect(r.shape).toBe('start/end')
      expect([r.startKey, r.endKey]).toEqual(['start', 'end'])
    }
  })

  it('markerSurfaceRange():v0 形状与 v3 形状都能解析出同区间(不得硬断言单一形状)', () => {
    const { markerSurfaceRange } = require('../lib/adapter/contract.js')
    const a = markerSurfaceRange({ op: 'replace', start: 3, end: 9 })
    const b = markerSurfaceRange({ op: 'replace', startSeq: 3, endSeq: 9 })
    expect([a.start, a.end]).toEqual([3, 9])
    expect([b.start, b.end]).toEqual([3, 9])
    expect(a.shape).toBe('start/end')
    expect(b.shape).toBe('startSeq/endSeq')
  })

  it('markerSurfaceRange():混写两种键名 → 报 contract-violation(两棵树都要求键数精确为 3)', () => {
    const { markerSurfaceRange } = require('../lib/adapter/contract.js')
    expect(() => markerSurfaceRange({ op: 'replace', start: 1, end: 2, startSeq: 1, endSeq: 2 })).toThrow(/contract-violation|surfaceOp/)
  })

  it('断言:**v0 树对 v3 键名不报命名错** ⇒ 故必须按运行时选形状(不得硬编码)', () => {
    // 该用例锁住"为什么需要本机制":官方 v0 的 isReplaceOp 只查键数=3,不查键名语义;
    // 写错形状会被下游以误导性错误暴露(surface start targets consumed assistant/chunk undefined)。
    const { runtimeSurfaceOpShape } = require('../lib/adapter/contract.js')
    const src = require('node:fs').readFileSync(new URL('../lib/adapter/dsh-writer.js', import.meta.url), 'utf8')
    expect(src).toMatch(/runtimeSurfaceOpShape\(\)/)
    expect(src).not.toMatch(/const surfaceOp = \{ op: 'replace', start: span\.start, end: span\.end \}/)
    expect(runtimeSurfaceOpShape().startKey).toBeTruthy()
  })
})
