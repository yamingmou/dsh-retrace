/**
 * 读端兜底:顶层 `sourceEventSeqs` 被事件管道剥掉/截断时,「被遮蔽集合」从哪来。
 *
 * 背景(反方实测 + 官方源码):第 2 段载体自身只带 `{role,id,content,source}`
 * (官方 `user/message` 词表精确四成员,0.4.12 的 `data.shadowedSeqs` 冗余已被移除),
 * 于是「被遮蔽了哪些消息」只能来自 ① 顶层 provenance ② 第 1 段审计段
 * (`compaction/prune`,官方合法成员 `shadowedSeqs`)。而旧兜底用
 * `carrierAuditSeq(event)` 定位审计 seq —— 它**本身依赖顶层数组**,整条被剥即自废。
 *
 * 本文件把两端的新口径钉死:
 *  - host 侧 `carrierShadowedSeqs(event, eventAt)`:按引用 seq,再按**相邻 seq**
 *    (审计段写在本载体前一个 seq —— 官方 shadow-price 协议要求 claim 与 replace 相邻);
 *  - client 侧 `__recallMarkerDefinition.start(…, reader)`:客户端 reader 只有
 *    `previous(kind)`(没有"按 seq 取任意事件"的接口)⇒ 走
 *    `AUDIT_CONTEXT_KIND` 相邻上下文,判据同为「区间与载体逐值相等」;
 *  - 四情形(完整 / 截断 / 整条被剥 / 缺起点)逐条实测;
 *  - 取不到审计段时 → [](不隐藏任何行 = 与 0.4.12 同样的保守行为,但不再**以为**
 *    自己拿到了集合)。
 */
import { describe, it, expect } from 'vitest'
import { sessionEvents, eventAt } from '../lib/host-compat.js'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AUDIT_CONTEXT_KIND,
  AUDIT_EVENT_TYPE,
  CARRIER_EVENT_TYPE,
  TRACE_TEXT,
  carrierShadowedSeqs,
  isCarrierMarkerEvent,
  shadowedSeqsOfAudit,
} from '../lib/marker-carrier.js'
import { createDshMarkerWriter, carrierContentOf } from '../lib/adapter/dsh-writer.js'
import { __recallMarkerDefinition } from '../lib/client.js'
import { headerEvent, makeSession, userMessage, assistantMessage } from './helpers.js'
import { deriveMessage, officialSurfaceMeter } from './official-meter.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const SPAN = { start: 3, end: 5, shadowedSeqs: [3, 4, 5] }

/** 真实写入一个两段载体(用生产 writer,不手搓形状)。 */
async function writeCarrier() {
  const session = makeSession().seed(
    headerEvent(),
    userMessage('u1', 'q1'), assistantMessage('a1', 'r1'),
    userMessage('u2', 'q2'), assistantMessage('a2', 'r2'), assistantMessage('a3', 'r3'),
  )
  const writer = createDshMarkerWriter({ meter: officialSurfaceMeter(), deriveMessage })
  const carrier = await writer.writeMarker(session, SPAN, { op: 'recall', targetSeq: 3, originalText: '' })
  const audit = sessionEvents(session).find((e) => e?.type === AUDIT_EVENT_TYPE)
  return { session, carrier, audit }
}

/** 事件读取器(session-adapter 的 bySeq 同形)。 */
const eventAtOf = (session) => (seq) => eventAt(session, seq)

/** 客户端 reader 的最小替身:只实现 previous(kind)(真实 reader 也只有这一个入口)。 */
function previousOnly(auditEvent) {
  return {
    previous: (kind) => (kind === AUDIT_CONTEXT_KIND && auditEvent
      ? { kind, id: `audit:${auditEvent.seq}`, startSeq: auditEvent.seq, state: auditEvent.data, matches: [{ event: auditEvent }] }
      : undefined),
  }
}

/** 客户端读端:marker 定义 start(context, match, reader) → 载体状态。 */
const clientStateOf = (carrier, reader) => __recallMarkerDefinition.start({}, { event: carrier }, reader)

describe('读端兜底 · 四情形(顶层 provenance 完整 / 截断 / 整条被剥 / 缺起点)', () => {
  it('情形 1:顶层完整 ⇒ 两端都取顶层数组(截掉审计引导项)', async () => {
    const { session, carrier, audit } = await writeCarrier()
    expect(carrier.sourceEventSeqs).toEqual([audit.seq, ...SPAN.shadowedSeqs])
    expect(carrierShadowedSeqs(carrier)).toEqual(SPAN.shadowedSeqs)
    expect(carrierShadowedSeqs(carrier, eventAtOf(session))).toEqual(SPAN.shadowedSeqs)
    expect(clientStateOf(carrier, previousOnly(audit)).shadowedSeqs).toEqual(SPAN.shadowedSeqs)
  })

  it('情形 2:顶层被截断(只剩审计 seq)⇒ 客户端回落审计上下文,host 回落审计段', async () => {
    const { session, carrier, audit } = await writeCarrier()
    const truncated = { ...carrier, sourceEventSeqs: [audit.seq] }
    expect(carrierShadowedSeqs(truncated)).toEqual([]) // 无读取器 = 客户端裸读
    expect(carrierShadowedSeqs(truncated, eventAtOf(session))).toEqual(SPAN.shadowedSeqs) // 按引用 seq
    expect(clientStateOf(truncated, previousOnly(audit)).shadowedSeqs).toEqual(SPAN.shadowedSeqs)
  })

  it('情形 3:顶层**整条**被剥 ⇒ 旧定位(`carrierAuditSeq`)自废,新口径仍取得到', async () => {
    const { session, carrier, audit } = await writeCarrier()
    const stripped = { seq: carrier.seq, type: CARRIER_EVENT_TYPE, surfaceOp: carrier.surfaceOp, data: carrier.data }
    expect(stripped.sourceEventSeqs).toBeUndefined()
    // host:引用 seq 无从定位 ⇒ 靠**相邻 seq**(审计段写在载体前一个 seq)取回
    expect(eventAtOf(session)(stripped.seq - 1)).toBe(audit)
    expect(carrierShadowedSeqs(stripped, eventAtOf(session))).toEqual(SPAN.shadowedSeqs)
    // client:相邻**上下文**(previous(kind))
    expect(clientStateOf(stripped, previousOnly(audit)).shadowedSeqs).toEqual(SPAN.shadowedSeqs)
  })

  it('情形 4:顶层不含区间起点(截断到中段)⇒ 不把不完整数组当被遮蔽段', async () => {
    const { session, carrier, audit } = await writeCarrier()
    const partial = { ...carrier, sourceEventSeqs: [audit.seq, 4, 5] } // 缺起点 3
    expect(carrierShadowedSeqs(partial)).toEqual([])
    expect(carrierShadowedSeqs(partial, eventAtOf(session))).toEqual(SPAN.shadowedSeqs)
    expect(clientStateOf(partial, previousOnly(audit)).shadowedSeqs).toEqual(SPAN.shadowedSeqs)
  })

  it('取不到审计段(无 reader / 上下文是他人写的)⇒ [](保守:不隐藏任何行)', async () => {
    const { carrier, audit } = await writeCarrier()
    const stripped = { seq: carrier.seq, type: CARRIER_EVENT_TYPE, surfaceOp: carrier.surfaceOp, data: carrier.data }
    const state = clientStateOf(stripped, previousOnly(undefined))
    expect(state.shadowedSeqs).toEqual([])
    expect(state.legacy).toBe(false) // 不是 legacy ⇒ 只是"没拿到集合",行还看得见
    // 官方 pruner 也写 compaction/prune(同词表):区间不等 ⇒ 不当成本载体的审计段
    const otherAudit = { ...audit, data: { ...audit.data, shadowedRange: { start: 1, end: 2 }, shadowedSeqs: [1, 2] } }
    expect(shadowedSeqsOfAudit(otherAudit, carrier)).toEqual([])
    expect(clientStateOf(stripped, previousOnly(otherAudit)).shadowedSeqs).toEqual([])
  })
})

describe('回归守卫(防兜底再次被悄悄删掉)', () => {
  it('client 产物里注册了审计上下文定义;载体仍被识别为我方 marker', async () => {
    const { carrier } = await writeCarrier()
    expect(isCarrierMarkerEvent(carrier)).toBe(true)
    const source = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
    // 2026-09-14：注册入口改由 conversationRegistrar 解析（新基座 UI 服务把注册表
    // 挂在 `.events` 上，服务本身没有 register）——断言只看"审计上下文定义仍被注册"。
    expect(source).toMatch(/\.register\(auditContextDefinition\(\)\)/)
    expect(source).toContain('shadowedSeqsOfAudit')
    // 生成件(动态客户端 / 打包产物)同样带上兜底(与源码同源由 test/generated.test.js 保证)
    for (const file of ['dynamic-client.js', 'client.bundle.js']) {
      expect(readFileSync(join(root, 'lib', file), 'utf8')).toContain(AUDIT_CONTEXT_KIND)
    }
  })

  it('载体区间起点派生(单一口径):严格形状判据,畸形 surfaceOp 不给数', async () => {
    const { carrier } = await writeCarrier()
    // 历史实现(client.js 自有 spanStartOf:只取数值,不校验 op/键数)会给出 3;
    // 现在两端共用 marker-carrier 的 spanRangeOf(要求 op==='replace' 且键数恰 3)
    const historical = (event) => {
      const op = event?.surfaceOp
      if (!op || typeof op !== 'object') return -1
      const start = op.start !== undefined ? op.start : op.startSeq
      return typeof start === 'number' ? start : -1
    }
    const malformed = { ...carrier, surfaceOp: { op: 'replace', start: 3, end: 5, extra: 1 } }
    expect(historical(malformed)).toBe(3) // 旧口径:照给数(与 spanRangeOf 分歧)
    expect(clientStateOf(malformed, previousOnly(undefined)).targetSeq).toBe(-1) // 新口径:畸形不给数
    // 正常形态仍派生区间起点;旧形态(editor.targetSeq)照旧回落
    expect(clientStateOf(carrier, previousOnly(undefined)).targetSeq).toBe(SPAN.start)
    const legacy = { seq: 9, type: 'assistant/message', data: { editor: { targetSeq: 7, text: 'x' }, message: { id: 'retrace-recall-x' } }, surfaceOp: { op: 'replace', start: 3, end: 5 } }
    expect(clientStateOf(legacy, previousOnly(undefined)).targetSeq).toBe(7)
  })
})

/**
 * 第 2 段 content 的**通道路径**(2026-09-10):写入器不自带业务序列化,
 * 业务元数据 → 人读文本由**注入面**给出(`deriveContentText`,与 meter/deriveMessage
 * 同一形态)。注入面缺席 = 该宿主本就没有结构化业务数据 ⇒ 直接落留痕文案。
 */
describe('第 2 段 content · 调用方文本 > 注入的派生面 > 定稿留痕文案', () => {
  it('三档优先级逐档生效;注入面缺席不是错误(照常写入)', async () => {
    // ① 调用方给的人读文本优先(注入面在场也不覆盖它)
    expect(carrierContentOf({ content: [{ type: 'text', text: '调用方文本' }] }, () => '注入文本'))
      .toEqual([{ type: 'text', text: '调用方文本' }])
    // ② 无调用方文本 ⇒ 用注入面派生
    expect(carrierContentOf({}, () => '注入文本')).toEqual([{ type: 'text', text: '注入文本' }])
    // ③ 无注入面 ⇒ 留痕文案(不是空 content,也不抛)
    expect(carrierContentOf({})).toEqual([{ type: 'text', text: TRACE_TEXT }])
    // 端到端:真实 writer 走同一档位(注入面缺席 = 公开宿主形态)
    const session = makeSession().seed(
      headerEvent(),
      userMessage('u1', 'q1'), assistantMessage('a1', 'r1'),
      userMessage('u2', 'q2'), assistantMessage('a2', 'r2'), assistantMessage('a3', 'r3'),
    )
    const plain = createDshMarkerWriter({ meter: officialSurfaceMeter(), deriveMessage })
    const plainCarrier = await plain.writeMarker(session, SPAN, { op: 'recall', targetSeq: 3, originalText: '' })
    expect(plainCarrier.data.content).toEqual([{ type: 'text', text: TRACE_TEXT }])
    // 注入面在场 ⇒ 该文本进 content(装配点怎么装配由宿主负责,写入器只认通道)
    const injected = createDshMarkerWriter({
      meter: officialSurfaceMeter(),
      deriveMessage,
      deriveContentText: (meta) => `注入:${meta.op}`,
    })
    const injectedCarrier = await injected.writeMarker(session, SPAN, { op: 'recall', targetSeq: 3, originalText: '' })
    expect(injectedCarrier.data.content).toEqual([{ type: 'text', text: '注入:recall' }])
  })

  it('注入面返回空串/非字符串/抛错 ⇒ 一律回落留痕文案(不写空 content,也不拒写)', () => {
    for (const derive of [() => '', () => undefined, () => 42, () => { throw new Error('boom') }]) {
      expect(carrierContentOf({}, derive)).toEqual([{ type: 'text', text: TRACE_TEXT }])
    }
    // 调用方给的全是空文本块 ⇒ 视同未给(不让空块短路派生面)
    expect(carrierContentOf({ content: [{ type: 'text', text: '' }] }, () => '注入文本'))
      .toEqual([{ type: 'text', text: '注入文本' }])
  })
})
