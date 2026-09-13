/**
 * 第 1 段 `shadowedTokenCount` = **官方令牌价**(shadow-price claim) —— 口径钉死。
 *
 * 被修正的问题形态:写入端曾写「被遮蔽节点个数」。官方 `dsh-token-meter`
 * `lib/types/surface-projection.js:39` 的 `foldSurfaceProjection` 把
 * `compaction/prune` 当 claim 武装(`{start,end,tokens:shadowedTokenCount}`),
 * 下一个 surface replace 按 `deltaTokens = 本事件估价 − claim.tokens` 折叠 ⇒
 * 写节点个数会把被遮蔽区间的**令牌价**留在 `surfaceTokens` 里(高估),而
 * `surfaceTokens → projectedTokens` 是压缩压力/占用率的输入 ⇒ 提前误触发折叠。
 *
 * 本文件的断言一律用**官方函数**(`estimateMessage` / `deriveEventMessage` /
 * `foldSurfaceProjection`,见 test/official-meter.js),不手抄公式:
 *  1. 写入值 === 官方逐节点估价之和;
 *  2. 该值喂给官方 fold 得到**正确**增量(节点个数口径则偏);
 *  3. 拿不到官方 meter ⇒ 拒写(不编价);
 *  4. claim 被并发 append 顶掉 ⇒ 重挂审计段(官方协议要求 claim 与 replace 相邻);
 *  5. 节点估不出价(内存视图有洞)⇒ 显著诊断 + 只写可估部分(不静默编价)。
 */
import { describe, it, expect } from 'vitest'
import { createDshMarkerWriter } from '../lib/adapter/dsh-writer.js'
import { AUDIT_EVENT_TYPE, CARRIER_EVENT_TYPE, carrierShadowedSeqs } from '../lib/marker-carrier.js'
import { headerEvent, makeSession, userMessage, assistantMessage } from './helpers.js'
import { officialNodePrice, officialSurfaceMeter, officialSurfaceProjection, deriveMessage } from './official-meter.js'

/** 一个「3 节点、约两千令牌」的区间(复现反方实测量级:节点个数 3 vs 令牌价 ~2000)。 */
function priceSession() {
  return makeSession().seed(
    headerEvent(),
    userMessage('u1', 'q'.repeat(3000)),
    assistantMessage('a1', 'r'.repeat(3000)),
    assistantMessage('a2', 's'.repeat(2012)),
  )
}

const SPAN = { start: 1, end: 3, shadowedSeqs: [1, 2, 3] }
/** 官方口径的区间价:Σ estimateMessage(deriveEventMessage(event))(官方 surface-fold 同式)。 */
const officialRangePrice = (session, span) => span.shadowedSeqs.reduce((total, seq) => total + officialNodePrice(session.events[seq]), 0)

function writerWith(overrides = {}) {
  const logged = []
  const writer = createDshMarkerWriter({
    log: (line) => logged.push(line),
    meter: officialSurfaceMeter(),
    deriveMessage,
    ...overrides,
  })
  return { writer, logged }
}

describe('shadow-price 口径:写入值 === 官方 estimateMessage 口径', () => {
  it('3 节点区间的写入值 = 官方逐节点估价之和(不是节点个数 3)', async () => {
    const session = priceSession()
    const { writer, logged } = writerWith()
    await writer.writeMarker(session, SPAN, { op: 'recall', targetSeq: 1, originalText: '' })

    const audit = session.events.find((e) => e?.type === AUDIT_EVENT_TYPE)
    const expected = officialRangePrice(session, SPAN)
    expect(audit.data.shadowedTokenCount).toBe(expected)
    expect(expected).toBeGreaterThan(2000) // 量级:3 个节点 ≈ 两千令牌
    expect(audit.data.shadowedTokenCount).not.toBe(SPAN.shadowedSeqs.length) // ≠ 3(旧口径)
    expect(logged.some((line) => line.includes('shadow-price 降级'))).toBe(false)
  })

  it('官方 foldSurfaceProjection:claim 用写入值 ⇒ 增量正确;用节点个数 ⇒ 偏(反证)', async () => {
    const session = priceSession()
    const { writer } = writerWith()
    const carrier = await writer.writeMarker(session, SPAN, { op: 'recall', targetSeq: 1, originalText: '' })
    const audit = session.events.find((e) => e?.type === AUDIT_EVENT_TYPE)

    // ① 审计段确实被官方 fold 当成 claim 武装(零增量),且字段名/形状都对得上
    const armed = officialSurfaceProjection.foldSurfaceProjection(undefined, audit)
    expect(armed.deltaTokens).toBe(0)
    expect(armed.claim).toEqual({ start: SPAN.start, end: SPAN.end, tokens: audit.data.shadowedTokenCount })
    // ② 载体(replace)消费 claim:增量 = 载体自身估价 − claim.tokens
    const carrierPrice = officialNodePrice(carrier)
    const correct = officialSurfaceProjection.foldSurfaceProjection(armed.claim, carrier)
    expect(correct.deltaTokens).toBe(carrierPrice - audit.data.shadowedTokenCount)
    // ③ 反证:claim 写「节点个数」时**少减**了「区间令牌价 − 节点数」——这部分被遮蔽
    //    内容的价会留在 surfaceTokens 里(高估 ⇒ 占用率虚高 ⇒ 可能提前误触发折叠)
    const forgeClaim = { ...armed.claim, tokens: SPAN.shadowedSeqs.length }
    const wrong = officialSurfaceProjection.foldSurfaceProjection(forgeClaim, carrier)
    expect(wrong.deltaTokens).toBe(carrierPrice - SPAN.shadowedSeqs.length)
    const overcount = wrong.deltaTokens - correct.deltaTokens
    expect(overcount).toBe(audit.data.shadowedTokenCount - SPAN.shadowedSeqs.length)
    expect(overcount).toBeGreaterThan(2000) // 每个 marker 让 surfaceTokens 高估 ~两千
  })

  it('两个官方来源同值:逐节点口径 vs measure() 表面口径(写入前取面)', async () => {
    const session = priceSession()
    // 写入前取面(写入后区间已被载体替换,面上不再有那些节点)
    const surfacePrice = officialSurfaceMeter().measure(session).nodes
      .filter((node) => SPAN.shadowedSeqs.includes(node.seq))
      .reduce((total, node) => total + node.tokens, 0)
    const { writer } = writerWith()
    await writer.writeMarker(session, SPAN, { op: 'recall', targetSeq: 1, originalText: '' })
    const audit = session.events.find((e) => e?.type === AUDIT_EVENT_TYPE)
    expect(audit.data.shadowedTokenCount).toBe(surfacePrice)
    expect(surfacePrice).toBe(officialRangePrice(session, SPAN))
  })

  it('拿不到官方 meter ⇒ 拒写(指名道姓报 meter,不编价)', async () => {
    const session = priceSession()
    const writer = createDshMarkerWriter({}) // 未注入 meter
    await expect(writer.writeMarker(session, SPAN, { op: 'recall', targetSeq: 1, originalText: '' }))
      .rejects.toThrow(/契约违规\[dshAdapter\.writeMarker\.meter\].*token-meter/)
    expect(session.events.some((e) => e?.type === AUDIT_EVENT_TYPE)).toBe(false) // 零写入(无审计段)
    expect(session.events.filter((e) => e?.surfaceOp?.op === 'replace').length).toBe(0) // 无载体段
  })

  it('claim 被并发 append 顶掉 ⇒ 重挂审计段(claim 与 replace 相邻)', async () => {
    const session = priceSession()
    const { writer, logged } = writerWith({
      validateMarker: async (s, _envelope, options) => {
        // post 阶段(审计段已落盘、载体未落盘)插入一个并发事件 —— 顶掉已武装的 claim
        if (options?.phase === 'post') s.append('assistant/chunk', { turn: 9, step: 0, text: 'concurrent' })
      },
    })
    const carrier = await writer.writeMarker(session, SPAN, { op: 'recall', targetSeq: 1, originalText: '' })

    const audits = session.events.filter((e) => e?.type === AUDIT_EVENT_TYPE)
    expect(audits.length).toBe(2) // 第一次的 claim 被顶掉 ⇒ 重挂
    expect(audits[1].data).toEqual(audits[0].data) // 同一个价
    expect(carrier.sourceEventSeqs[0]).toBe(audits[1].seq)
    // 相邻性:载体前一个事件就是被引用的审计段(官方协议要求)
    expect(session.events[session.events.indexOf(carrier) - 1]).toBe(audits[1])
    expect(logged.some((line) => line.includes('顶掉'))).toBe(true)
    // 官方 fold:重挂后的 claim 仍能给出正确增量
    const armed = officialSurfaceProjection.foldSurfaceProjection(undefined, audits[1])
    const delta = officialSurfaceProjection.foldSurfaceProjection(armed.claim, carrier).deltaTokens
    expect(delta).toBe(officialNodePrice(carrier) - audits[1].data.shadowedTokenCount)
  })

  it('节点取不到价(内存视图有洞)⇒ 显著诊断 + 只写可估部分(不静默编价)', async () => {
    const session = priceSession()
    delete session.events[2] // 洞:被遮蔽节点 seq 2 不在当前视图里
    const { writer, logged } = writerWith()
    await writer.writeMarker(session, SPAN, { op: 'recall', targetSeq: 1, originalText: '' })

    const audit = session.events.find((e) => e?.type === AUDIT_EVENT_TYPE)
    expect(audit.data.shadowedTokenCount).toBe(officialRangePrice(session, { shadowedSeqs: [1, 3] }))
    const diag = logged.filter((line) => line.includes('shadow-price 降级'))
    expect(diag.length).toBe(1)
    expect(diag[0]).toContain('seq 2') // 点名取不到的 seq
  })

  it('审计段形状不变:被遮蔽段仍取载体口径(审计 seq 不计入)', async () => {
    const session = priceSession()
    const { writer } = writerWith()
    const carrier = await writer.writeMarker(session, SPAN, { op: 'recall', targetSeq: 1, originalText: '' })
    const audit = session.events.find((e) => e?.type === AUDIT_EVENT_TYPE)
    expect(audit.data.shadowedSeqs).toEqual(carrierShadowedSeqs(carrier))
    expect(Object.keys(audit.data).sort()).toEqual(['shadowedRange', 'shadowedSeqs', 'shadowedTokenCount'])
  })
})
