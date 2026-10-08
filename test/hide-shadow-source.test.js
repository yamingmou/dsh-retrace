/**
 * 0.4.124-fix —— 遮蔽序列的**解析优先级**与「已撤回 N 条消息」的同源 count。
 *
 * 事故现场(真机 2026-10-08 18:07:12,宿主日志 3 条 `hide-miss:no-hidden-keys`):
 *   · 会话 <内部会话> 的 marker 229/231/233 报"零隐藏键";
 *   · 但同一快照里另外 12 条 marker(markerCount=15)都产出了键 —— 差别只有一个:
 *     这 3 条的遮蔽表里**窗口内**的 seq 全是 marker 载体自身(172/174/226/229/231),
 *     `hiddenKeysFor` 按设计跳过 recall-marker 节点 ⇒ 零键。它们真正要藏的
 *     118-141 在客户端**加载窗口之外**(窗口起点落在 (141,148])。
 *   · `seqCount:7/5/3` 说明 `marker.data.shadowedSeqs` 非空(客户端 `start()` 已把
 *     顶层 provenance / 审计上下文归一到这里),不是"字段读不到"。
 *
 * 所以本文件钉四件事:
 *  ① **真形状**:写入端 marker 的 data 只有官方四成员(无 `shadowedSeqs`)——隐藏列表
 *     来自事件级 `sourceEventSeqs` / 配对审计;解析结果非空、CSS 选择器正确、
 *     count 与列表**同源**;
 *  ② 旧 carrier 形状(`data.shadowedSeqs` 直接给)行为逐字节不变;
 *  ③ 三档优先级各自生效:① marker-data > ② paired-audit > ③ surfaceOp 区间兜底;
 *  ④ 拿不到集合时**如实上报**(`why` + `auditSeq`/`auditNodeAvailable`/`seqSource`),
 *     绝不静默;legacy 老前缀即使带区间也永不隐藏。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { createMiniReact, collectElements, textOf } from './mini-react.js'
import { zh, __recallMarkerDefinition } from '../lib/client.js'
import { AUDIT_CONTEXT_KIND, CARRIER_DATA_KEYS, TRACE_TEXT } from '../lib/marker-carrier.js'
import { createDshMarkerWriter } from '../lib/adapter/dsh-writer.js'
import { sessionEvents } from '../lib/host-compat.js'
import { headerEvent, makeSession, userMessage as hostUserMessage, assistantMessage as hostAssistantMessage } from './helpers.js'
import { deriveMessage, officialSurfaceMeter } from './official-meter.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLIENT_SOURCE_PATH = path.join(ROOT, 'lib', 'client.js')
const nodeRequire = createRequire(import.meta.url)

const EXTRACTED = ['hidePlanOf', 'shadowedSeqsFor', 'RecallMarkerRow', 'useShadowed', 'useHideMissReport']

const statelessReact = {
  Component: class { constructor(props) { this.props = props ?? {}; this.state = {} } setState() {} },
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn(),
  useRef: (value) => ({ current: value }),
}

let hooks
beforeAll(async () => {
  const source = readFileSync(CLIENT_SOURCE_PATH, 'utf8')
  for (const name of EXTRACTED) {
    expect(source.includes(`function ${name}(`), `lib/client.js must declare ${name}`).toBe(true)
  }
  const bundled = await build({
    stdin: {
      contents: `${source}\nexport { ${EXTRACTED.join(', ')} }\n`,
      loader: 'js',
      resolveDir: path.dirname(CLIENT_SOURCE_PATH),
      sourcefile: 'client.js',
    },
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    write: false,
    external: ['react'],
    logLevel: 'silent',
  })
  const mod = { exports: {} }
  // eslint-disable-next-line no-new-func
  new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(
    (id) => (id === 'react' ? statelessReact : nodeRequire(id)), mod, mod.exports,
  )
  hooks = mod.exports
  for (const name of EXTRACTED) expect(typeof hooks[name]).toBe('function')
})

afterAll(() => { hooks.__setMessageEditorWire(null) })

// ---------------------------------------------------------------------------
// snapshot / node fixtures(形状与 test/client-unhide.test.js 同源)
// ---------------------------------------------------------------------------
const chatSnapshot = (entries) => {
  const nodes = new Map(entries.map((node) => [node.key, node]))
  return { nodes, order: entries.map((node) => node.key) }
}
const useChatFor = (snapshot) => (selector) => selector(snapshot)
const tZh = (key, params) => {
  let text = zh[key] ?? key
  if (params) for (const [name, value] of Object.entries(params)) text = text.split(`{${name}}`).join(String(value))
  return text
}
const userMessage = (key, seq) => ({
  key, kind: 'user-message', anchorSeq: seq,
  data: { seq, messageId: `u-${key}`, content: [{ type: 'text', text: `text ${seq}` }] },
})
const assistantStep = (key, seq) => ({
  key, kind: 'assistant-step', anchorSeq: seq,
  data: { finalNode: { messageId: `a-${key}`, seq }, blocks: [], status: 'done' },
})
/** 一条 marker 节点,data 由调用方给(默认 = 生产客户端 `start()` 的产物)。 */
const markerNode = (key, data) => ({ key, kind: 'recall-marker', anchorSeq: data.seq, data })
const expectedCss = (keys) => keys.map((key) => {
  const k = JSON.stringify(key)
  return `[data-chat-anchor-key=${k}],[data-chat-flow-key=${k}],[data-chat-anchor-key^=${JSON.stringify('[' + k)}],[data-chat-group-key*=${k}]{display:none!important}`
}).join('') + '[data-dsh-rt-hidden]{display:none!important}'
const stylesOf = (element) => collectElements(element).filter((el) => el.type === 'style')
/** 只取某条 marker 的 miss 明细(夹具里的载体节点自身也会上报,不属于本用例的判据)。 */
const missOf = (plan, key) => (plan.missDetails ?? []).find((detail) => detail.key === key) ?? null
const statusTextOf = (element) => textOf(collectElements(element).find((el) => el.props?.role === 'status'))

/** 真实写入一个两段载体(生产 writer),返回 { carrier, audit } 两张真事件。 */
async function realCarrier() {
  const session = makeSession().seed(
    headerEvent(),
    hostUserMessage('u1', 'q1'), hostAssistantMessage('a1', 'r1'),
    hostUserMessage('u2', 'q2'), hostAssistantMessage('a2', 'r2'), hostAssistantMessage('a3', 'r3'),
  )
  const writer = createDshMarkerWriter({ meter: officialSurfaceMeter(), deriveMessage })
  const carrier = await writer.writeMarker(session, { start: 3, end: 5, shadowedSeqs: [3, 4, 5] }, { op: 'recall', targetSeq: 3, originalText: '' })
  const audit = sessionEvents(session).find((e) => e?.type === 'compaction/prune')
  return { carrier, audit }
}
/** 客户端 reader 的最小替身(真实 reader 也只有 previous(kind) 一个入口)。 */
const readerFor = (audit) => ({
  previous: (kind) => (kind === AUDIT_CONTEXT_KIND && audit
    ? { kind, startSeq: audit.seq, state: audit.data, matches: [{ event: audit }] }
    : undefined),
})
const stateOf = (carrier, reader) => __recallMarkerDefinition.start({}, { event: carrier }, reader)

// ---------------------------------------------------------------------------
// ① 真形状:写入端 data 无 shadowedSeqs,隐藏列表来自事件级 provenance / 配对审计
// ---------------------------------------------------------------------------
describe('① 真形状(事件级 sourceEventSeqs + 配对审计;marker data 无 shadowedSeqs)', () => {
  it('marker data 只有官方四成员;节点账本记下 auditSeq/审计列表/区间', async () => {
    const { carrier, audit } = await realCarrier()
    expect(Object.keys(carrier.data).sort()).toEqual([...CARRIER_DATA_KEYS].sort())
    expect(carrier.data.shadowedSeqs).toBeUndefined()          // 铁证:写入形状没有该字段
    expect(carrier.sourceEventSeqs).toEqual([audit.seq, 3, 4, 5])
    expect(carrier.data.content).toEqual([{ type: 'text', text: TRACE_TEXT }])

    const state = stateOf(carrier, readerFor(audit))
    expect(state.shadowedSeqs).toEqual([3, 4, 5])              // 客户端归一化(审计引导项被截掉)
    expect(state.auditSeq).toBe(audit.seq)
    expect(state.auditShadowedSeqs).toEqual([3, 4, 5])
    expect(state.shadowedRange).toEqual({ start: 3, end: 5 })
  })

  it('隐藏键非空、CSS 选择器正确、count 与遮蔽列表同源(同一次解析)', async () => {
    const { carrier, audit } = await realCarrier()
    const state = stateOf(carrier, undefined) // 顶层 provenance 在场 ⇒ 不需要审计上下文
    expect(state.shadowedSeqs).toEqual([3, 4, 5])
    const node = markerNode('m1', state)
    const snapshot = chatSnapshot([userMessage('r3', 3), assistantStep('r4', 4), userMessage('r5', 5), node])
    const plan = hooks.hidePlanOf(snapshot)

    const keys = plan.hiddenFor('m1')
    expect(keys).toEqual(['r3', 'r4', 'r5'])
    // count 同源:计划里那份解析结果就是键的来源
    expect(plan.planFor('m1')).toMatchObject({ seqCount: 3, seqSource: 'marker-data', labelCount: 3 })
    expect(plan.missDetails).toEqual([])

    // 渲染层:CSS 选择器逐字节正确,notice 的数字 = 同一份列表长度
    const element = hooks.RecallMarkerRow({ node, sessionId: 's1', useChat: useChatFor(snapshot), t: tZh })
    expect(stylesOf(element)).toHaveLength(1)
    expect(stylesOf(element)[0].props.dangerouslySetInnerHTML.__html).toBe(expectedCss(keys))
    expect(statusTextOf(element)).toBe(tZh('marker.recallMany', { count: 3 }))
  })
})

// ---------------------------------------------------------------------------
// ② 旧 carrier 形状:data.shadowedSeqs 直接给 ⇒ 行为不变
// ---------------------------------------------------------------------------
describe('② 旧 carrier 形状(data.shadowedSeqs 非空)行为逐字节不变', () => {
  const node = markerNode('m1', {
    seq: 7, op: 'recall', shadowedSeqs: [5, 6], legacy: false, compact: false, markerId: 'retrace-recall-7',
  })

  it('优先用 marker data;CSS 与 0.4.123 的规则全文逐字节相同', () => {
    const snapshot = chatSnapshot([userMessage('u1', 5), assistantStep('a1', 6), node])
    const plan = hooks.hidePlanOf(snapshot)
    expect(plan.hiddenFor('m1')).toEqual(['u1', 'a1'])
    expect(plan.planFor('m1')).toMatchObject({ seqSource: 'marker-data', labelCount: 2 })
    const element = hooks.RecallMarkerRow({ node, sessionId: 's1', useChat: useChatFor(snapshot), t: tZh })
    expect(stylesOf(element)[0].props.dangerouslySetInnerHTML.__html).toBe(expectedCss(['u1', 'a1']))
  })

  it('优先级:① 非空时**不**被 ②/③ 改写(即使区间更大)', () => {
    const both = markerNode('m2', {
      seq: 9, op: 'recall', shadowedSeqs: [5], auditSeq: 8, auditShadowedSeqs: [5, 6, 7],
      shadowedRange: { start: 5, end: 7 }, legacy: false, compact: false,
    })
    const plan = hooks.hidePlanOf(chatSnapshot([userMessage('u1', 5), assistantStep('a1', 6), userMessage('u2', 7), both]))
    expect(plan.hiddenFor('m2')).toEqual(['u1'])      // 只有 5,不含 6/7
    expect(plan.planFor('m2')).toMatchObject({ seqSource: 'marker-data', seqCount: 1, labelCount: 1 })
  })
})

// ---------------------------------------------------------------------------
// ③ 三档优先级:② 配对审计(按 seq 定位 / 上下文副本)→ ③ 区间兜底
// ---------------------------------------------------------------------------
describe('③ 优先级 ② paired-audit 与 ③ surface-op 兜底', () => {
  it('② shadowedSeqs 为空 + 审计上下文副本在场 ⇒ 用审计列表(不是 provenance.slice(1))', () => {
    const node = markerNode('m1', {
      seq: 9, op: 'recall', shadowedSeqs: [], auditSeq: 99, auditShadowedSeqs: [5, 6],
      shadowedRange: { start: 1, end: 99 }, legacy: false, compact: false,
    })
    const plan = hooks.hidePlanOf(chatSnapshot([userMessage('u1', 5), assistantStep('a1', 6), node]))
    expect(plan.hiddenFor('m1')).toEqual(['u1', 'a1'])
    expect(plan.planFor('m1')).toMatchObject({ seqSource: 'paired-audit', seqCount: 2, labelCount: 2 })
  })

  it('② 审计事件在 nodes 里按 seq 找得到 ⇒ 直接读它的 data.shadowedSeqs', () => {
    const auditNode = {
      key: 'audit', kind: 'compaction', anchorSeq: 99,
      data: { seq: 99, shadowedSeqs: [5, 6], shadowedRange: { start: 5, end: 6 } },
    }
    const node = markerNode('m1', {
      seq: 9, op: 'recall', shadowedSeqs: [], auditSeq: 99, auditShadowedSeqs: [],
      shadowedRange: null, legacy: false, compact: false,
    })
    const plan = hooks.hidePlanOf(chatSnapshot([userMessage('u1', 5), assistantStep('a1', 6), auditNode, node]))
    expect(plan.hiddenFor('m1')).toEqual(['u1', 'a1'])
    expect(plan.planFor('m1')).toMatchObject({ seqSource: 'paired-audit', seqCount: 2 })
  })

  it('③ ①②都拿不到 ⇒ 展开 surfaceOp 区间;labelCount = 实际命中行数(不拿区间长度冒充)', () => {
    const node = markerNode('m1', {
      seq: 9, op: 'recall', shadowedSeqs: [], auditSeq: null, auditShadowedSeqs: [],
      shadowedRange: { start: 5, end: 8 }, legacy: false, compact: false,
    })
    const plan = hooks.hidePlanOf(chatSnapshot([userMessage('u1', 5), assistantStep('a1', 6), userMessage('u2', 7), node]))
    expect(plan.hiddenFor('m1')).toEqual(['u1', 'a1', 'u2'])
    expect(plan.planFor('m1')).toMatchObject({ seqSource: 'surface-op', seqCount: 4, labelCount: 3 })
    expect(plan.missDetails).toEqual([])
  })

  it('③ 区间在窗口里只命中 marker 载体 ⇒ 仍然零键(载体按设计跳过),如实报 miss', () => {
    const carrierRow = { key: 'c6', kind: 'recall-marker', anchorSeq: 6, data: { seq: 6, op: 'recall', shadowedSeqs: [99] } }
    const node = markerNode('m1', {
      seq: 9, op: 'recall', shadowedSeqs: [], auditSeq: null, auditShadowedSeqs: [],
      shadowedRange: { start: 6, end: 6 }, legacy: false, compact: false,
    })
    const plan = hooks.hidePlanOf(chatSnapshot([userMessage('u1', 5), carrierRow, node]))
    expect(plan.hiddenFor('m1')).toBeNull()
    expect(missOf(plan, 'm1')).toMatchObject({
      key: 'm1', reason: 'no-hidden-keys', why: 'shadowed-seqs-not-in-window', seqSource: 'surface-op', range: true,
    })
  })
})

// ---------------------------------------------------------------------------
// ④ 真机现场复刻(窗口化)+ 拿不到集合时如实上报
// ---------------------------------------------------------------------------
describe('④ 真机 2026-10-08 18:07:12 现场复刻(窗口起点落在 (141,148])', () => {
  // marker 229 的真值:审计 seq 228、遮蔽 [138,139,140,141,174,172,226]、区间 138..226。
  // 客户端窗口里有 148/151(它们由更早的 marker 负责),但 marker 229 自己的 138-141 在窗口外,
  // 窗口内的 172/174/226 是**载体**(被 hiddenKeysFor 跳过)⇒ 零键。
  const REAL_LIST = [138, 139, 140, 141, 174, 172, 226]
  const carrierNode = (seq) => ({
    key: `c${seq}`, kind: 'recall-marker', anchorSeq: seq,
    data: { seq, op: 'recall', shadowedSeqs: [seq], legacy: false, compact: false },
  })
  const windowRows = [userMessage('u148', 148), userMessage('u151', 151), userMessage('u223', 223)]

  it('① 归一化列表非空但窗口内只有载体 ⇒ 零键 + why=shadowed-seqs-not-in-window', () => {
    const node = markerNode('m229', {
      seq: 229, op: 'recall', shadowedSeqs: REAL_LIST, auditSeq: 228, auditShadowedSeqs: REAL_LIST,
      shadowedRange: { start: 138, end: 226 }, legacy: false, compact: false,
      markerId: 'retrace-recall-munquo25-3pgwe2tv',
    })
    const plan = hooks.hidePlanOf(chatSnapshot([...windowRows, carrierNode(174), carrierNode(172), carrierNode(226), node]))
    expect(plan.hiddenFor('m229')).toBeNull()
    expect(missOf(plan, 'm229')).toMatchObject({
      reason: 'no-hidden-keys',
      why: 'shadowed-seqs-not-in-window',
      seqCount: 7,                 // ← 与宿主日志里的 seqCount:7 一致(证明字段并非读不到)
      seqSource: 'marker-data',
      auditSeq: 228,
      auditNodeAvailable: false,   // 审计段是 log-only,不产出 view node(不是错误,如实上报)
      auditSeqsAvailable: false,
    })
  })

  it('② 顶层 provenance 被剥 + 审计上下文在场 ⇒ 用审计列表,结果同 ①(仍零键,不是因为没拿到集合)', () => {
    const node = markerNode('m229', {
      seq: 229, op: 'recall', shadowedSeqs: [], auditSeq: 228, auditShadowedSeqs: REAL_LIST,
      shadowedRange: { start: 138, end: 226 }, legacy: false, compact: false,
    })
    const plan = hooks.hidePlanOf(chatSnapshot([...windowRows, carrierNode(174), carrierNode(172), carrierNode(226), node]))
    expect(plan.hiddenFor('m229')).toBeNull()
    expect(plan.planFor('m229')).toMatchObject({ seqSource: 'paired-audit', seqCount: 7, labelCount: 7 })
    expect(missOf(plan, 'm229')).toMatchObject({ why: 'shadowed-seqs-not-in-window', seqSource: 'paired-audit' })
  })

  it('③ 区间兜底接管:窗口内的 148/151/223 被正确隐藏(不再误报 miss)', () => {
    const node = markerNode('m229', {
      seq: 229, op: 'recall', shadowedSeqs: [], auditSeq: 228, auditShadowedSeqs: [],
      shadowedRange: { start: 138, end: 226 }, legacy: false, compact: false,
    })
    const plan = hooks.hidePlanOf(chatSnapshot([...windowRows, carrierNode(174), carrierNode(172), carrierNode(226), node]))
    expect(plan.hiddenFor('m229')).toEqual(['u148', 'u151', 'u223'])
    expect(plan.planFor('m229')).toMatchObject({ seqSource: 'surface-op', labelCount: 3 })
    expect(missOf(plan, 'm229')).toBe(null)
  })

  it('配对审计**不可达**且无区间 ⇒ why=audit-unreachable,并仍然走 clientReport(不静默)', () => {
    const reports = []
    hooks.__setMessageEditorWire((op, payload) => { reports.push({ op, payload }); return Promise.resolve({ ok: true, value: {} }) })
    try {
      const node = markerNode('m-broken', {
        seq: 229, op: 'recall', shadowedSeqs: [], auditSeq: 228, auditShadowedSeqs: [],
        shadowedRange: null, legacy: false, compact: false,
      })
      const snapshot = chatSnapshot([userMessage('u148', 148), node])
      const plan = hooks.hidePlanOf(snapshot)
      expect(missOf(plan, 'm-broken')).toMatchObject({
        reason: 'no-hidden-keys', why: 'audit-unreachable', auditSeq: 228, seqSource: 'none',
      })
      hooks.useHideMissReport(useChatFor(snapshot), 's1')
      expect(reports).toHaveLength(1)
      expect(reports[0].payload.source).toContain('hide-miss:no-hidden-keys')
      expect(reports[0].payload.source).toContain('audit-unreachable')
    } finally {
      hooks.__setMessageEditorWire(null)
    }
  })

  it('legacy 老前缀即使带区间也永不隐藏(重命名不得让已可见内容消失)', () => {
    const node = markerNode('m-legacy', {
      seq: 9, op: 'recall', shadowedSeqs: [], auditSeq: null, auditShadowedSeqs: [],
      shadowedRange: { start: 5, end: 8 }, legacy: true, compact: false,
    })
    const plan = hooks.hidePlanOf(chatSnapshot([userMessage('u1', 5), assistantStep('a1', 6), node]))
    expect(plan.planFor('m-legacy')).toMatchObject({ keys: null, seqSource: 'legacy', labelCount: 0 })
    expect(plan.missDetails).toEqual([])   // legacy 不进 miss(它本来就不隐藏)
  })
})
