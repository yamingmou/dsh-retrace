/**
 * lib/marker-carrier.js —— 「遮蔽载体」形状真相的单元测试。
 *
 * 本文件是两段结构(第 1 段审计 `compaction/prune` + 第 2 段载体 `user/message`)
 * 读端与写端共用的判据。这里把下列东西钉死:
 *  1. 形状判据(v0/v3 双形状区间、混写拒绝、载体识别、审计 seq 引导项);
 *  2. 被遮蔽 seq 的取值口径(首元素是审计 seq ⇒ 自区间起点起截;旧形态等价)。
 */
import { describe, it, expect } from 'vitest'
import {
  AUDIT_CONTEXT_KIND,
  AUDIT_EVENT_TYPE,
  CARRIER_DATA_KEYS,
  CARRIER_EVENT_TYPE,
  CARRIER_SOURCE_KIND,
  TRACE_TEXT,
  carrierAuditSeq,
  carrierContentText,
  carrierShadowedSeqs,
  carrierTargetSeq,
  auditContextDefinition,
  shadowedSeqsOfAudit,
  isCarrierMarkerEvent,
  isAuditPairedWithCarrier,
  isAuditPairedWithSomeCarrier,
  pairedAuditOf,
  isLegacyMarkerEvent,
  isMarkerId,
  isShadowCarrierEvent,
  spanRangeOf,
} from '../lib/marker-carrier.js'
import { MARKER_ID_PREFIX } from '../lib/host-core.js'

/** 一个合规的载体事件(v0 形状;首元素 = 审计 seq 7)。 */
function carrier(overrides = {}) {
  return {
    seq: 8,
    type: CARRIER_EVENT_TYPE,
    surfaceOp: { op: 'replace', start: 2, end: 4 },
    sourceEventSeqs: [7, 2, 3, 4],
    data: {
      role: 'user',
      id: `${MARKER_ID_PREFIX}-recall-abc`,
      content: [{ type: 'text', text: TRACE_TEXT }],
      source: { kind: CARRIER_SOURCE_KIND, provider: 'p', model: 'm' },
    },
    ...overrides,
  }
}

describe('marker-carrier · 形状判据', () => {
  it('前缀清单与 host-core 的 MARKER_ID_PREFIX 一致(两份取值不得漂移)', () => {
    // 单数常量归 host-core(公开面 ./host-core);本模块只导出清单——两者由本用例钉住。
    expect(isMarkerId(`${MARKER_ID_PREFIX}-recall-x`)).toBe(true)
    expect(isMarkerId('message-editor-recall-x')).toBe(true)
    expect(isMarkerId('assistant-msg-1')).toBe(false)
    expect(isMarkerId(undefined)).toBe(false)
  })

  it('spanRangeOf:双形状解析;混写/键数≠3/非 replace → null', () => {
    expect(spanRangeOf({ op: 'replace', start: 2, end: 4 })).toEqual({ start: 2, end: 4 })
    expect(spanRangeOf({ op: 'replace', startSeq: 2, endSeq: 4 })).toEqual({ start: 2, end: 4 })
    expect(spanRangeOf({ op: 'replace', start: 2, end: 4, startSeq: 2 })).toBeNull()
    expect(spanRangeOf({ op: 'append', start: 2, end: 4 })).toBeNull()
    expect(spanRangeOf({ op: 'replace', startSeq: 2, endSeq: 'x' })).toBeNull()
    expect(spanRangeOf(null)).toBeNull()
  })

  it('isCarrierMarkerEvent:user/message + replace + 本插件 id;旧形态单独识别', () => {
    expect(isCarrierMarkerEvent(carrier())).toBe(true)
    // 缺 surfaceOp / 非本插件 id / assistant 形态 → 不是载体
    expect(isCarrierMarkerEvent(carrier({ surfaceOp: undefined }))).toBe(false)
    expect(isCarrierMarkerEvent(carrier({ data: { ...carrier().data, id: 'u1' } }))).toBe(false)
    const legacy = { type: 'assistant/message', seq: 5, data: { editor: { targetSeq: 2, text: 'x' } } }
    expect(isLegacyMarkerEvent(legacy)).toBe(true)
    expect(isCarrierMarkerEvent(legacy)).toBe(false)
    // 读端入口两种形态都认(历史日志里旧 marker 仍在)
    expect(isShadowCarrierEvent(legacy)).toBe(true)
    expect(isShadowCarrierEvent(carrier())).toBe(true)
    expect(isShadowCarrierEvent({ type: 'user/message', data: { id: 'u1' } })).toBe(false)
  })

  it('被遮蔽 seq 取值口径:首元素是审计 seq(不在区间内)⇒ 自区间起点起截', () => {
    const marker = carrier()
    expect(carrierAuditSeq(marker)).toBe(7)
    expect(carrierShadowedSeqs(marker)).toEqual([2, 3, 4])
    // 旧形态(顶层数组本就以区间起点开头)⇒ 原样返回(0.4.x 口径不变)
    const legacySeqs = { surfaceOp: { op: 'replace', start: 2, end: 4 }, sourceEventSeqs: [2, 3, 4] }
    expect(carrierAuditSeq(legacySeqs)).toBeNull()
    expect(carrierShadowedSeqs(legacySeqs)).toEqual([2, 3, 4])
    // 顶层被事件管道剥掉 → 回落 data.shadowedSeqs(旧字段)
    expect(carrierShadowedSeqs({ data: { shadowedSeqs: [2, 3] } })).toEqual([2, 3])
    // 顶层被截断(只剩审计 seq)→ 用**相邻**事件(审计段写在载体前一个 seq)取回
    const auditEvent = { seq: 7, type: AUDIT_EVENT_TYPE, data: { shadowedRange: { start: 2, end: 4 }, shadowedSeqs: [2, 3, 4], shadowedTokenCount: 30 } }
    const stripped = { ...carrier(), seq: 8, sourceEventSeqs: [7] }
    expect(carrierShadowedSeqs(stripped, (seq) => (seq === 7 ? auditEvent : undefined))).toEqual([2, 3, 4])
    // 顶层**整条**被剥 → 引用 seq 无从定位,但审计段与本载体相邻 ⇒ 仍取得到
    const noTop = { seq: 8, type: CARRIER_EVENT_TYPE, surfaceOp: { op: 'replace', start: 2, end: 4 }, data: carrier().data }
    expect(carrierShadowedSeqs(noTop, (seq) => (seq === 7 ? auditEvent : undefined))).toEqual([2, 3, 4])
    // 局部数组不完整(缺区间终点)⇒ 不当成被遮蔽段,同样落到兜底
    const partial = { ...carrier(), sourceEventSeqs: [7, 2, 3] }
    expect(carrierShadowedSeqs(partial, (seq) => (seq === 7 ? auditEvent : undefined))).toEqual([2, 3, 4])
    expect(carrierShadowedSeqs(partial)).toEqual([]) // 无读取器 = 客户端不保留该字段
  })

  it('审计段取值判据:区间必须与载体逐值相等(否则不是本载体的审计段)', () => {
    const marker = carrier() // 区间 2..4
    const ours = { shadowedRange: { start: 2, end: 4 }, shadowedSeqs: [2, 3, 4], shadowedTokenCount: 30 }
    expect(shadowedSeqsOfAudit(ours, marker)).toEqual([2, 3, 4])
    expect(shadowedSeqsOfAudit({ data: ours }, marker)).toEqual([2, 3, 4]) // 事件形态同样接受
    // 官方 pruner 也写 compaction/prune(同词表)⇒ 区间相等是唯一判据
    expect(shadowedSeqsOfAudit({ shadowedRange: { start: 5, end: 6 }, shadowedSeqs: [5, 6], shadowedTokenCount: 9 }, marker)).toEqual([])
    // 记录不完整(缺终点)/键集不符 ⇒ 不采用
    expect(shadowedSeqsOfAudit({ shadowedRange: { start: 2, end: 4 }, shadowedSeqs: [2, 3], shadowedTokenCount: 9 }, marker)).toEqual([])
    expect(shadowedSeqsOfAudit({ ...ours, extra: 1 }, marker)).toEqual([])
    expect(shadowedSeqsOfAudit(undefined, marker)).toEqual([])
    // 审计上下文定义:认得带形状的第 1 段,不认其他事件
    const definition = auditContextDefinition()
    expect(definition.kind).toBe(AUDIT_CONTEXT_KIND)
    expect(definition.target).toBeUndefined() // 不建视图(不产生对话行)
    expect(definition.match({ seq: 7, type: AUDIT_EVENT_TYPE, data: ours })).toEqual({ id: 'audit:7', role: 'start' })
    expect(definition.match({ seq: 7, type: 'compaction/summary', data: ours })).toBeNull()
    expect(definition.match({ seq: 7, type: AUDIT_EVENT_TYPE, data: { shadowedSeqs: [2, 3, 4] } })).toBeNull()
    expect(definition.start({}, { event: { data: ours } })).toEqual(ours)
  })

  it('carrierTargetSeq / carrierContentText:业务溯源派生 + 人读文本', () => {
    expect(carrierTargetSeq(carrier())).toBe(2)
    expect(carrierTargetSeq({ data: { editor: { targetSeq: 9 } } })).toBe(9) // 旧形态回落
    expect(carrierTargetSeq({})).toBe(-1)
    expect(carrierTargetSeq({ surfaceOp: { op: 'replace', startSeq: 2, endSeq: 4 } })).toBe(2)
    expect(carrierContentText(carrier())).toBe(TRACE_TEXT)
    expect(carrierContentText({ data: { content: [] } })).toBe('')
  })

  it('carrierTargetSeq 只认区间起点;业务目标偏离它属**异常形态**(写入端记诊断)', () => {
    // 原用例把「业务目标与区间起点可分离」写成设计前提(手工合成样例)。反方复核:
    // 203/203 真实 marker 观测上 `editor.targetSeq === surfaceOp.start` 无一反例,
    // 故不再把该形态当常态登记 —— 写入端改为「targetSeq ≠ 区间起点 即记诊断」
    // (区间内非起点同样诊断,不再是静默错位),行为面由
    // test/host-core.test.js「写前断言:targetSeq ≠ 被遮蔽区间起点 → 记一行诊断」覆盖。
    expect(carrierTargetSeq(carrier())).toBe(2)
    // 派生与顶层数组首元素(审计 seq 7)无关:派生的只有区间起点
    expect(carrierTargetSeq(carrier({ sourceEventSeqs: [7, 3, 4, 5], surfaceOp: { op: 'replace', start: 3, end: 5 } }))).toBe(3)
    // 无区间且无旧字段 ⇒ -1(读端据 -1 判定"无法还原",不猜)
    expect(carrierTargetSeq({ surfaceOp: { op: 'append' } })).toBe(-1)
    // 键数≠3 / 混写的 surfaceOp 一律不认(与 spanRangeOf 同判据)
    expect(carrierTargetSeq({ surfaceOp: { op: 'replace', start: 3, end: 5, extra: 1 } })).toBe(-1)
  })

  it('导出的成员清单与官方词表一致(写入端断言的依据)', () => {
    expect(AUDIT_EVENT_TYPE).toBe('compaction/prune')
    expect(CARRIER_EVENT_TYPE).toBe('user/message')
    expect(CARRIER_SOURCE_KIND).toBe('model')
    expect(CARRIER_DATA_KEYS).toEqual(['role', 'id', 'content', 'source'])
    expect(TRACE_TEXT).toBe('（此处内容已被撤回：原消息已归档，可在恢复视图中查看）')
  })
})

/**
 * 读侧配对:三选一 + 「紧邻性」硬约束(裁定 2026-09-14 §一)。
 *
 * 容错**不得**把"审计段在、载体段在很远处或根本不存在"的真孤儿误判成成对 ——
 * 容错把要检出的缺陷掩盖掉是唯一不可接受的结果。写侧 `assertPairing` 保持严格。
 */
describe('marker-carrier · 读侧配对(三选一 + 紧邻硬约束)', () => {
  const auditAt = (seq, start, end) => ({
    seq,
    type: AUDIT_EVENT_TYPE,
    data: { shadowedRange: { start, end }, shadowedSeqs: [start, end], shadowedTokenCount: 1 },
  })
  const carrierAt = (seq, start, end, seqs) => ({
    seq,
    type: CARRIER_EVENT_TYPE,
    surfaceOp: { op: 'replace', start, end },
    sourceEventSeqs: seqs,
    data: {
      role: 'user',
      id: `${MARKER_ID_PREFIX}-recall-x`,
      content: [{ type: 'text', text: TRACE_TEXT }],
      source: { kind: CARRIER_SOURCE_KIND, provider: 'p', model: 'm' },
    },
  })

  it('① 审计 seq 置首(现行写侧形态)→ 成对', () => {
    expect(isAuditPairedWithCarrier(auditAt(10, 2, 4), carrierAt(11, 2, 4, [10, 2, 4])))
      .toEqual({ paired: true, via: 'ref-first' })
  })

  it('② 审计 seq 出现在数组非首位 → 成对', () => {
    expect(isAuditPairedWithCarrier(auditAt(10, 2, 4), carrierAt(15, 2, 4, [2, 4, 10])))
      .toEqual({ paired: true, via: 'ref-anywhere' })
  })

  it('③ 历史形态(不含审计 seq)且**紧邻 + 区间一致** → 成对', () => {
    expect(isAuditPairedWithCarrier(auditAt(10, 2, 4), carrierAt(11, 2, 4, [2, 4])))
      .toEqual({ paired: true, via: 'adjacent-range' })
  })

  it('阴性①:审计段没有任何载体 → 仍判孤儿', () => {
    expect(isAuditPairedWithSomeCarrier(auditAt(10, 2, 4), []).paired).toBe(false)
    expect(isAuditPairedWithSomeCarrier(auditAt(10, 2, 4), [carrierAt(99, 7, 8, [7, 8])]).paired).toBe(false)
  })

  it('阴性②:审计与载体**不紧邻**(中间插别的事件)→ 仍判孤儿', () => {
    const audit = auditAt(10, 2, 4)
    const far = carrierAt(12, 2, 4, [2, 4]) // 区间一致,但 seq 差 2(不紧邻)且不含审计 seq
    expect(isAuditPairedWithCarrier(audit, far)).toEqual({ paired: false, via: null })
    expect(isAuditPairedWithSomeCarrier(audit, [far]).paired).toBe(false)
    // 引用形态(①②)按裁定不依赖紧邻 —— 引用本身就是自证;只有历史形态③要求紧邻
    expect(isAuditPairedWithCarrier(audit, carrierAt(12, 2, 4, [10, 2, 4])).via).toBe('ref-first')
  })

  it('阴性③:区间一致但审计 seq 不在 sourceEventSeqs 且不紧邻 → 仍判孤儿', () => {
    expect(isAuditPairedWithCarrier(auditAt(10, 2, 4), carrierAt(50, 2, 4, [2, 4])))
      .toEqual({ paired: false, via: null })
  })

  const readerFor = (events) => {
    const bySeq = new Map(events.map((event) => [event.seq, event]))
    return (seq) => bySeq.get(seq)
  }

  it('pairedAuditOf:历史形态靠紧邻定位;远端载体取不到审计', () => {
    const adjacentLog = [auditAt(10, 2, 4), carrierAt(11, 2, 4, [])]
    expect(pairedAuditOf(adjacentLog[1], readerFor(adjacentLog))).toMatchObject({ seq: 10, via: 'adjacent-range' })
    const remoteLog = [auditAt(10, 2, 4), carrierAt(50, 2, 4, [])]
    expect(pairedAuditOf(remoteLog[1], readerFor(remoteLog))).toBeNull()
  })

  it('carrierShadowedSeqs:顶层被剥 + 紧邻 → 取回被遮蔽段(读侧容错生效)', () => {
    const log = [auditAt(10, 2, 4), carrierAt(11, 2, 4, [])]
    expect(carrierShadowedSeqs(log[1], readerFor(log))).toEqual([2, 4])
  })
})
