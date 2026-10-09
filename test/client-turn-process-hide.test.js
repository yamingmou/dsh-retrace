/**
 * 0.4.127 —— 撤回后**轮级提示条**(turn-process)的残留:官方渲染「已停止」+ 底边。
 *
 * 用户报的现场(展示层残留;真实会话 id 与本机落点**不入库**,见发布前硬闸门):
 *   该会话是一条技术调研线;下面这些 seq / 键都是真机读数,消息 id 用合成占位值。
 *   轮 252 = 被中止的轮 —— 日志里只有
 *     `16900 turn/start` / `16903 user/message` / `16904 assistant/attempt` /
 *     `16905 step/end` / `16906 turn/end {kind:'aborted',reason:{kind:'user'}}`,
 *   随后 `16908 retrace-recall-…` 的 `surfaceOp = {op:'replace',startSeq:16903,endSeq:16903}`
 *   (遮蔽集合 = {16903},即那条用户消息)。撤回后**那条用户消息消失,但「已停止」还在**。
 *
 * 成因(官方源码到行,见 lib/client.js#hiddenKeysFor 的长注释):
 *   · 「已停止」= `t("message.stopped")`,由 `turn.end.data.reason.kind === 'aborted'` 驱动
 *     (`@deepseek-ai/dsh-client-ui-chat/lib/client.js:5415` 文案 / `:6169` 判据);
 *   · 承载它的 `turn-process` 行锚在 `controlAnchorSeq - 0.1`(`:10086` + :7119-7125),
 *     而 `controlAnchorSeq` 取自 `processEvidence()`(9918-9931:assistant/attempt ·
 *     tool/call · llm/retry)或回落到 `turn.start.seq`(`processSpec`,`:9959`)
 *     ⇒ 合成锚点 `ceil(16899.9) = 16900`(turn/start)**不在**遮蔽集合里;
 *   · 该行是 `data-chat-flow-key = "12:turn-process252"` 的 flow 条目(`:1760-1765`;
 *     键 = `conversationContextKey('turn-process', '252')` =
 *     `@deepseek-ai/dsh-client-ui-conversation/lib/client.js:1122-1124`)⇒ 我们的隐藏
 *     选择器按 `node.key` 命中它,但旧版本产不出这个键。
 *
 * 本文件钉四件事:
 *   ① 轮内内容行全被遮蔽 ⇒ 该轮 turn-process 的**键**进隐藏集合,并真的出现在注入的 CSS 里;
 *   ② 负向保护:未被遮蔽的轮、只被遮一部分的轮,表头一个都不许动;
 *   ③ 「恢复显示」(取消撤回)后内容回来 ⇒ 表头随同回来(同一个计划/同一套 CSS 链路);
 *   ④ 无法判定轮归属(既无 location 又无 data.turn)时**不动手**(安全侧)。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { createMiniReact, collectElements, textOf } from './mini-react.js'
import { zh } from '../lib/client.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLIENT_SOURCE_PATH = path.join(ROOT, 'lib', 'client.js')
const nodeRequire = createRequire(import.meta.url)

const EXTRACTED = ['hidePlanOf', 'RecallMarkerRow']

const statelessReact = {
  Component: class { constructor(props) { this.props = props ?? {}; this.state = {} } setState() {} },
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn(),
  useRef: (value) => ({ current: value }),
}

/** Bundle the REAL lib/client.js against a React stand-in (same pattern as client-unhide). */
async function bundleClient(react) {
  const source = readFileSync(CLIENT_SOURCE_PATH, 'utf8')
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
    (id) => (id === 'react' ? react : nodeRequire(id)), mod, mod.exports,
  )
  return mod.exports
}

let hooks

beforeAll(async () => {
  const source = readFileSync(CLIENT_SOURCE_PATH, 'utf8')
  for (const name of EXTRACTED) {
    expect(source.includes(`function ${name}(`), `lib/client.js must declare ${name}`).toBe(true)
  }
  hooks = await bundleClient(statelessReact)
  for (const name of EXTRACTED) expect(typeof hooks[name]).toBe('function')
})

afterAll(() => { hooks.__setMessageEditorWire(null) })

// ---------------------------------------------------------------------------
// 夹具:与真机同形的 chat 快照(键 = conversationContextKey 的真实形状)
// ---------------------------------------------------------------------------
const chatSnapshot = (entries) => {
  const nodes = new Map(entries.map((node) => [node.key, node]))
  return { nodes, order: entries.map((node) => node.key) }
}
const useChatFor = (snapshot) => (selector) => selector(snapshot)
const tKey = (key) => key
const tZh = (key, params) => {
  let text = zh[key] ?? key
  if (params) for (const [name, value] of Object.entries(params)) text = text.split(`{${name}}`).join(String(value))
  return text
}
const stylesOf = (element) => collectElements(element).filter((el) => el.type === 'style')
const expectedCss = (keys) => keys.map((key) => {
  const k = JSON.stringify(key)
  return `[data-chat-anchor-key=${k}],[data-chat-flow-key=${k}],[data-chat-anchor-key^=${JSON.stringify('[' + k)}],[data-chat-group-key*=${k}]{display:none!important}`
}).join('') + '[data-dsh-rt-hidden]{display:none!important}'

/** 官方 offset:`CHAT_SYNTHETIC_SEQ_OFFSETS.processControl = -0.1`(chat:7122)。 */
const PROCESS_CONTROL = -0.1

/**
 * 官方 location 索引的形状(`locationCoordinates`,chat:8116-8123):
 * `{kind:'turn', turn:{turn, start, end, status, steps, data}}`。
 * `reason` 是 `turn/end.data.reason`。
 */
const turnLocation = (turn, { startSeq, endSeq, reason }) => ({
  kind: 'turn',
  turn: {
    turn,
    start: { type: 'turn/start', seq: startSeq, data: { turn } },
    end: { type: 'turn/end', seq: endSeq, data: { turn, reason } },
    status: 'closed',
    steps: [],
    data: new Map(),
  },
})

/** 用户消息行。 */
const inputMessage = (turn, seq, id, location) => ({
  key: `13:input-message${id}`,
  kind: 'user',
  anchorSeq: seq,
  location,
  visibility: 'visible',
  data: { kind: 'user', seq, messageId: id, content: [{ type: 'text', text: `text ${seq}` }], source: { kind: 'user' } },
})

/** 轮级过程表头:`anchorSeq = controlAnchorSeq - 0.1`(chat:10086)。 */
const turnProcess = (turn, controlAnchorSeq, location) => ({
  key: `12:turn-process${turn}`,
  kind: 'turn-process',
  anchorSeq: controlAnchorSeq + PROCESS_CONTROL,
  location,
  visibility: 'visible',
  data: {
    turn,
    controlAnchorSeq,
    processStartSeq: controlAnchorSeq,
    answerAnchorSeq: null,
    answerStep: null,
    inlineReasoning: false,
    messageCount: 0,
    toolCallCount: 0,
    subagentCount: 0,
  },
})

/** 轮尾(`anchorSeq = data.seq + .1`,chat:10414);被中止且无回复 ⇒ closing = null。 */
const turnTail = (turn, endSeq, location, closing = null) => ({
  key: `9:turn-tail${turn}`,
  kind: 'turn-tail',
  anchorSeq: endSeq + 0.1,
  location,
  visibility: 'visible',
  data: { turn, seq: endSeq, time: 1, closing, branchUnavailable: closing === null },
})

const assistantStep = (turn, seq, location) => ({
  key: `13:assistant-step${seq}`,
  kind: 'assistant-step',
  anchorSeq: seq,
  location,
  visibility: 'visible',
  data: { status: 'settled', turn, step: 1, blocks: [], time: 1, finalNode: { messageId: `a-${seq}`, seq } },
})

/** marker 节点(carrier 读端归一后的形状,与生产 `start()` 的产物一致)。 */
const markerNode = (key, seq, shadowedSeqs, shadowedRange, extra = {}) => ({
  key,
  kind: 'recall-marker',
  anchorSeq: seq,
  data: {
    seq,
    op: 'recall',
    shadowedSeqs,
    shadowedRange,
    markerId: `retrace-recall-${key}`,
    legacy: false,
    compact: false,
    ...extra,
  },
})

const RECALL_MARKER_ID = 'retrace-recall-fixture-1'
const RECALL_INPUT_KEY = '13:input-messagefixture-input-16903'

// ── 真机现场:轮 252(被中止,整轮唯一的可见面节点 = 那条用户消息)──────────
const T252 = turnLocation(252, { startSeq: 16900, endSeq: 16906, reason: { kind: 'aborted', reason: { kind: 'user' } } })
// ── 对照:轮 251(已完成、未被遮蔽)与轮 250(只被遮一部分)─────────────────
const T251 = turnLocation(251, { startSeq: 16891, endSeq: 16898, reason: { kind: 'completed' } })
const T250 = turnLocation(250, { startSeq: 16880, endSeq: 16889, reason: { kind: 'completed' } })

const turn252Nodes = (marker) => [
  inputMessage(252, 16903, 'fixture-input-16903', T252),
  turnProcess(252, 16900, T252),
  turnTail(252, 16906, T252),
  marker,
]

const recallMarkerT252 = () => markerNode('m-252', 16908, [16903], { start: 16903, end: 16903 }, { markerId: RECALL_MARKER_ID })

// ---------------------------------------------------------------------------
// ① 整轮被遮蔽 ⇒ 表头的键进隐藏集合(并真的进注入的 CSS)
// ---------------------------------------------------------------------------
describe('turn-process 表头 —— 整轮被遮蔽时一并隐藏', () => {
  it('① 被中止的轮:遮蔽集合 {16903} ⇒ 该轮表头键 12:turn-process252 也进 keys', () => {
    const plan = hooks.hidePlanOf(chatSnapshot(turn252Nodes(recallMarkerT252())))
    const keys = plan.hiddenFor('m-252')
    expect(keys).toContain(RECALL_INPUT_KEY)          // 那条用户消息照旧被藏
    expect(keys).toContain('12:turn-process252')      // ★ 新增:轮级表头(「已停止」+ 底边)
    expect(keys).toHaveLength(2)                      // 只多这一个键
    // 轮尾(closing=null,官方 lastContent 跳过它)不算内容行,不参与判定
    expect(keys).not.toContain('9:turn-tail252')
  })

  it('① 成因复核:表头的合成锚点是 turn/start.seq,而遮蔽集合里只有面节点 ⇒ 旧判据必然漏掉它', () => {
    const plan = hooks.hidePlanOf(chatSnapshot(turn252Nodes(recallMarkerT252())))
    // 合成锚点(controlAnchorSeq + processControl)= 16899.9 ⇒ ceil = 16900
    expect(Math.ceil(16900 + PROCESS_CONTROL)).toBe(16900)
    // 16900 = turn/start,不是面节点;遮蔽集合 = {16903}
    expect(plan.hiddenFor('m-252')).not.toContain('13:input-message16900')
    expect(plan.isSeqHidden(16900)).toBe(false)
    expect(plan.isSeqHidden(16903)).toBe(true)
  })

  it('① 注入的 CSS 逐字节覆盖该表头的 flow 键(与既有规则同形)', () => {
    const snapshot = chatSnapshot(turn252Nodes(recallMarkerT252()))
    const element = hooks.RecallMarkerRow({ node: recallMarkerT252(), sessionId: 's1', useChat: useChatFor(snapshot), t: tKey })
    const styles = stylesOf(element)
    expect(styles).toHaveLength(1)
    const html = styles[0].props.dangerouslySetInnerHTML.__html
    expect(html).toContain('[data-chat-flow-key="12:turn-process252"]')
    expect(html).toBe(expectedCss([RECALL_INPUT_KEY, '12:turn-process252']))
  })

  it('① 键形状与官方一致:conversationContextKey(kind,id) = `<len>:<kind><id>`', () => {
    // 官方 @deepseek-ai/dsh-client-ui-conversation/lib/client.js:1122-1124
    //   conversationContextKey(kind, id) => `${kind.length}:${kind}${id}`
    // 而 turn-process 定义给的是 `id = String(event.data.turn)`(chat:10026-10044)
    // ⇒ 该行的节点键 / `data-chat-flow-key` 就是下面这个字面量;夹具用的必须是它,
    // 否则上面那条 CSS 在真机上命中的是另一个键。
    const conversationContextKey = (kind, id) => `${kind.length}:${kind}${id}`
    expect(conversationContextKey('turn-process', '252')).toBe('12:turn-process252')
    expect(conversationContextKey('turn-tail', '252')).toBe('9:turn-tail252')
    expect(conversationContextKey('input-message', 'fixture-input-16903'))
      .toBe(RECALL_INPUT_KEY)
  })

  it('① 官方契约(只读现役安装):文案/判据/flow 键/底边逐字存在 —— 残缺即来源判断失效', () => {
    const APP_CHAT = '/Applications/DSH Desktop.app/Contents/Resources/app/node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js'
    let official = null
    try { official = readFileSync(APP_CHAT, 'utf8') } catch { official = null }
    if (official === null) return // 未装官方客户端 ⇒ 跳过(不假装验证过)
    expect(official).toContain('"message.stopped": "已停止"')            // :5415 文案
    expect(official).toContain('reason === "aborted" ? t("message.stopped")') // :6169 驱动字段
    expect(official).toContain('"data-chat-flow-key": flowKey')          // :1761 可命中的键
    expect(official).toContain('"data-turn-process": node.data.turn')    // :6181 轮标识
    expect(official).toContain('.IfZI0W_root{box-sizing:border-box')     // :6130 表头(含 border-bottom)
    expect(official).toContain('processControl: -.1')                    // :7122 合成锚点偏移
    expect(official).toContain('data.controlAnchorSeq + CHAT_SYNTHETIC_SEQ_OFFSETS.processControl') // :10086
  })
})

// ---------------------------------------------------------------------------
// ② 负向保护:未遮蔽 / 只遮一部分的轮,表头一律不动
// ---------------------------------------------------------------------------
describe('turn-process 表头 —— 负向保护(不得误伤其它轮)', () => {
  const full = () => [
    inputMessage(250, 16881, 'u-250', T250),
    assistantStep(250, 16882, T250),
    turnProcess(250, 16881, T250),
    turnTail(250, 16889, T250),
    inputMessage(251, 16894, 'u-251', T251),
    assistantStep(251, 16896, T251),
    turnProcess(251, 16891, T251),
    turnTail(251, 16898, T251),
    ...turn252Nodes(recallMarkerT252()),
  ]

  it('② 只遮轮 252 ⇒ 轮 250/251 的表头一个都不进 keys', () => {
    const plan = hooks.hidePlanOf(chatSnapshot(full()))
    const keys = plan.hiddenFor('m-252')
    expect(keys).toContain('12:turn-process252')
    expect(keys).not.toContain('12:turn-process251')
    expect(keys).not.toContain('12:turn-process250')
    expect(keys).not.toContain('13:input-messageu-251')
    // 未被遮蔽的轮的内容行也不动
    expect(plan.isSeqHidden(16894)).toBe(false)
  })

  it('② 完全没遮到任何面节点(遮蔽集合指向窗口外的 seq)⇒ 表头不动(keys 为空 ⇒ null)', () => {
    const marker = markerNode('m-far', 16908, [999999], { start: 999999, end: 999999 })
    const plan = hooks.hidePlanOf(chatSnapshot([...turn252Nodes(marker)]))
    expect(plan.hiddenFor('m-far')).toBe(null)
  })

  it('② 同一轮只被遮一部分(用户消息被遮、助手回复还在)⇒ 表头不动', () => {
    // 轮 252 加一条**未**被遮蔽的助手回复:内容行 = 2,被遮 = 1 ⇒ 判据不成立
    const marker = recallMarkerT252()
    const nodes = [...turn252Nodes(marker), assistantStep(252, 16907, T252)]
    const plan = hooks.hidePlanOf(chatSnapshot(nodes))
    const keys = plan.hiddenFor('m-252')
    expect(keys).toContain(RECALL_INPUT_KEY)
    expect(keys).not.toContain('12:turn-process252')
    expect(plan.isSeqHidden(16907)).toBe(false)
  })

  it('② 轮里只剩我们自己的伪节点(没有真实内容行)⇒ 不动手(保守)', () => {
    const marker = recallMarkerT252()
    const pseudo = {
      key: '15:retrace-actions16903', kind: 'retrace-actions', anchorSeq: 16903.1,
      location: { kind: 'unresolved' }, visibility: 'visible', data: { seq: 16903 },
    }
    const plan = hooks.hidePlanOf(chatSnapshot([pseudo, turnProcess(252, 16900, T252), marker]))
    expect(plan.hiddenFor('m-252')).toBe(null)
  })

  it('④ 拿不到轮归属(既无 location 又无 data.turn)⇒ 不动手(安全侧)', () => {
    const marker = recallMarkerT252()
    const anonymous = {
      key: '12:turn-process252', kind: 'turn-process', anchorSeq: 16899.9,
      visibility: 'visible', data: { controlAnchorSeq: 16900 },
    }
    const plan = hooks.hidePlanOf(chatSnapshot([
      inputMessage(252, 16903, 'fixture-input-16903', T252), anonymous, marker,
    ]))
    expect(plan.hiddenFor('m-252')).toEqual([RECALL_INPUT_KEY])
  })

  it('④ visibility=hidden 的行(官方 isVisibleChatNode 不渲染)不算内容行', () => {
    const marker = recallMarkerT252()
    const hiddenStep = { ...assistantStep(252, 16907, T252), visibility: 'hidden' }
    const plan = hooks.hidePlanOf(chatSnapshot([...turn252Nodes(marker), hiddenStep]))
    // 该行不渲染 ⇒ 它不该阻止表头一起被藏
    expect(plan.hiddenFor('m-252')).toContain('12:turn-process252')
  })
})

// ---------------------------------------------------------------------------
// ③ 「恢复显示」⇒ 内容回来,表头随同回来
// ---------------------------------------------------------------------------
describe('恢复显示后表头随内容一起回来(同一计划 / 同一套 CSS)', () => {
  const cancelsTarget = (seq) => ({
    key: 'm-cancel',
    kind: 'recall-marker',
    anchorSeq: 16910,
    data: {
      seq: 16910, op: 'unhide', cancels: { seqs: [16908], ids: [] },
      shadowedSeqs: [], legacy: false, compact: false, markerId: 'retrace-unhide-1',
    },
  })

  it('③ durable 路径:取消标记进了快照 ⇒ marker 的计划 keys = null(表头与内容一起恢复)', () => {
    const snapshot = chatSnapshot([...turn252Nodes(recallMarkerT252()), cancelsTarget(16908)])
    const plan = hooks.hidePlanOf(snapshot)
    expect(plan.planFor('m-252')).toMatchObject({ cancelled: true, keys: null })
    expect(plan.hiddenFor('m-252')).toBe(null)
    expect(plan.isSeqHidden(16903)).toBe(false)
  })

  it('③ durable 路径:该 marker 行不再注入任何隐藏 CSS(「已停止」表头不再被藏)', () => {
    const snapshot = chatSnapshot([...turn252Nodes(recallMarkerT252()), cancelsTarget(16908)])
    const element = hooks.RecallMarkerRow({
      node: recallMarkerT252(), sessionId: 's1', useChat: useChatFor(snapshot), t: tKey,
    })
    expect(stylesOf(element)).toHaveLength(0)
  })

  it('③ 点「恢复显示」⇒ 注入的隐藏 CSS(含表头规则)当帧消失(真渲染循环)', async () => {
    const mini = createMiniReact()
    const client = await bundleClient(mini.react)
    client.__setMessageEditorWire(() => Promise.resolve({ ok: true, value: { op: 'unhide', markerSeq: 16908, cancelSeq: 16910 } }))
    try {
      const snapshot = chatSnapshot(turn252Nodes(recallMarkerT252()))
      mini.reset()
      mini.mount(mini.react.createElement('div', { className: 'host-app' },
        mini.react.createElement(client.RecallMarkerRow, {
          node: recallMarkerT252(), sessionId: 's1', useChat: useChatFor(snapshot), t: tZh,
        })))
      mini.flush()
      const before = collectElements(mini.tree()).filter((el) => el.type === 'style')
      expect(before).toHaveLength(1)
      expect(before[0].props.dangerouslySetInnerHTML.__html).toContain('[data-chat-flow-key="12:turn-process252"]')

      const button = collectElements(mini.tree())
        .find((el) => el.type === 'button' && el.props?.className === 'dsh-rt-chip dsh-rt-marker-unhide')
      expect(button, '「恢复显示」按钮必须存在').toBeTruthy()
      button.props.onClick()
      await new Promise((resolve) => setTimeout(resolve, 0))
      mini.flush()

      // 内容与表头同时恢复:CSS 整块被移除
      expect(collectElements(mini.tree()).filter((el) => el.type === 'style')).toHaveLength(0)
      expect(textOf(mini.tree())).toContain(zh['marker.restored'])
    } finally {
      client.__setMessageEditorWire(null)
    }
  })
})
