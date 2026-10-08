/**
 * 撤销撤回(unhide,0.4.124)—— 客户端侧。
 *
 * 三件事一次钉住:
 *   ① `hidePlanOf` **减去**被 `cancels` 指向的 marker 的全部隐藏键(durable 路径:
 *      取消标记进了 snapshot ⇒ 隐藏规则消失);
 *   ② 标记行上的「恢复显示」按钮 → 调 op → **界面立刻恢复**(点击态即时去掉注入的
 *      <style>,不等宿主推回事件);
 *   ③ 「该隐藏却没隐藏」的判定搬出组件、落到隐藏计划的**消费侧**,并且 warn +
 *      `clientReport` 两条出口(0.4.123 之前 `markers.length === 0` 那条盲区永远没日志)。
 *
 * 未取消时的既有隐藏行为**逐字节**回归也在这里(CSS 全文比对)。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { createMiniReact, collectElements, textOf } from './mini-react.js'
import { zh, en, __recallMarkerDefinition } from '../lib/client.js'
import {
  makeSession, userMessage as hostUserMessage, assistantMessage as hostAssistantMessage,
  headerEvent, makeAgent, makeApi, lastCarrierMarker,
} from './helpers.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLIENT_SOURCE_PATH = path.join(ROOT, 'lib', 'client.js')
const nodeRequire = createRequire(import.meta.url)

const EXTRACTED = [
  'hidePlanOf',
  'useShadowed',
  'useSeqHidden',
  'RecallMarkerRow',
  'expectHiddenRows',
  'useHideMissReport',
  'markerOpFromId',
  'isUnhideMarkerEvent',
]

const statelessReact = {
  Component: class { constructor(props) { this.props = props ?? {}; this.state = {} } setState() {} },
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn(),
  useRef: (value) => ({ current: value }),
}

/** Bundle the REAL lib/client.js twice: stateless (assertions) + mini-react (clicks). */
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
    expect(source.includes(`function ${name}(`) || source.includes(`const ${name} =`),
      `lib/client.js must declare ${name}`).toBe(true)
  }
  hooks = await bundleClient(statelessReact)
  for (const name of EXTRACTED) expect(typeof hooks[name]).toBe('function')
})

afterAll(() => { hooks.__setMessageEditorWire(null) })

// ---------------------------------------------------------------------------
// Host-shaped fixtures (same shapes as test/client-chat-hooks.test.js)
// ---------------------------------------------------------------------------
const chatSnapshot = (entries) => {
  const nodes = new Map(entries.map((node) => [node.key, node]))
  return { nodes, order: entries.map((node) => node.key) }
}
const useChatFor = (snapshot) => (selector) => selector(snapshot)
const tZh = (key) => zh[key]
const tKey = (key) => key
const userMessage = (key, seq) => ({
  key, kind: 'user-message', anchorSeq: seq,
  data: { seq, messageId: `u-${key}`, content: [{ type: 'text', text: `text ${seq}` }] },
})
const assistantStep = (key, messageId, seq) => ({
  key, kind: 'assistant-step', anchorSeq: seq,
  data: { finalNode: { messageId, seq }, blocks: [], status: 'done' },
})
const marker = (key, seq, shadowedSeqs, extra = {}) => ({
  key, kind: 'recall-marker', anchorSeq: seq,
  data: {
    seq, op: 'recall', shadowedSeqs, legacy: false, compact: false,
    markerId: `retrace-recall-${seq}`, ...extra,
  },
})
/** A cancel marker node exactly as lib/client.js#recallMarkerDefinition.start builds it. */
const unhideNode = (key, seq, cancels) => ({
  key, kind: 'recall-marker', anchorSeq: seq,
  data: {
    seq, op: 'unhide', cancels, shadowedSeqs: [], legacy: false, compact: false,
    markerId: `retrace-unhide-${seq}`,
  },
})
/** The hide CSS, restated independently (byte-for-byte regression). */
const expectedCss = (keys) => keys.map((key) => {
  const k = JSON.stringify(key)
  return `[data-chat-anchor-key=${k}],[data-chat-flow-key=${k}],[data-chat-anchor-key^=${JSON.stringify('[' + k)}],[data-chat-group-key*=${k}]{display:none!important}`
}).join('') + '[data-dsh-rt-hidden]{display:none!important}'
const stylesOf = (element) => collectElements(element).filter((el) => el.type === 'style')
const buttonsOf = (element) => collectElements(element).filter((el) => el.type === 'button')

// ---------------------------------------------------------------------------
// ① hidePlanOf 减去被取消 marker 的全部隐藏键
// ---------------------------------------------------------------------------
describe('hidePlanOf — 取消标记减掉隐藏键(durable 路径)', () => {
  it('cancels(seq) ⇒ 被取消 marker 的 keys/union/hiddenRowKeys 全部消失,plan.cancelled=true', () => {
    const nodes = [userMessage('u1', 5), assistantStep('a1', 'm-1', 6), marker('m1', 7, [5, 6]), unhideNode('x1', 8, { seqs: [7], ids: [] })]
    const plan = hooks.hidePlanOf(chatSnapshot(nodes))

    expect(plan.planFor('m1')).toMatchObject({ cancelled: true, keys: null })
    expect(plan.hiddenFor('m1')).toBe(null)
    expect(plan.cancelledCount).toBe(1)
    expect(plan.isSeqHidden(5)).toBe(false)
    expect(plan.isSeqHidden(6)).toBe(false)
    expect(plan.unionRatio).toBe(0)
    // 取消标记自己不隐藏、也不算进 marker 计数(firstMarkerKey 仍是真 marker)
    expect(plan.markerCount).toBe(1)
    expect(plan.firstMarkerKey).toBe('m1')
    expect(plan.planKeys).toEqual(['m1'])
  })

  it('cancels 也认裸数值与 markerId 两种读端形态(读端宽进)', () => {
    const bare = hooks.hidePlanOf(chatSnapshot([
      userMessage('u2', 11), marker('m2', 12, [11]), unhideNode('x2', 13, 12),
    ]))
    expect(bare.isSeqHidden(11)).toBe(false)
    expect(bare.planFor('m2').cancelled).toBe(true)

    const byId = hooks.hidePlanOf(chatSnapshot([
      userMessage('u3', 21),
      marker('m3', 22, [21], { markerId: 'retrace-edit-abc' }),
      unhideNode('x3', 23, { seqs: [], ids: ['retrace-edit-abc'] }),
    ]))
    expect(byId.isSeqHidden(21)).toBe(false)
    expect(byId.planFor('m3').cancelled).toBe(true)
  })

  it('只取消它指向的那一条:其它 marker 的隐藏键一个不少', () => {
    const plan = hooks.hidePlanOf(chatSnapshot([
      userMessage('u4', 31), userMessage('u5', 32),
      marker('m4', 33, [31]), marker('m5', 34, [32]),
      unhideNode('x4', 35, 33),
    ]))
    expect(plan.isSeqHidden(31)).toBe(false)
    expect(plan.isSeqHidden(32)).toBe(true)
    expect(plan.planFor('m5').cancelled).toBeUndefined()
    expect(plan.planFor('m5').keys).toEqual(['u5'])
  })

  it('重复取消(即使日志里真出现两条取消标记)也无害:集合取并集,cancelledCount 只算一次', () => {
    const plan = hooks.hidePlanOf(chatSnapshot([
      userMessage('u6', 41), marker('m6', 42, [41]),
      unhideNode('x6a', 43, 42), unhideNode('x6b', 44, 42),
    ]))
    expect(plan.planFor('m6')).toMatchObject({ cancelled: true, keys: null })
    expect(plan.isSeqHidden(41)).toBe(false)
    expect(plan.cancelledCount).toBe(1) // 被取消的是 marker 数,不是取消标记数
    expect(plan.markerCount).toBe(1)
    // 两条取消标记的 notice 行都渲染(无需去重;都显示「已恢复显示」)
    const rows = [unhideNode('x6a', 43, 42), unhideNode('x6b', 44, 42)].map((node) => hooks.RecallMarkerRow({
      node, sessionId: 's1', useChat: useChatFor(chatSnapshot([userMessage('u6', 41), marker('m6', 42, [41]), node])), t: tKey,
    }))
    for (const row of rows) {
      expect(stylesOf(row)).toHaveLength(0)
      expect(textOf(row)).toContain('marker.unhide')
    }
  })

  it('恢复显示**只改显示**:useShadowed(操作可行性)不变 —— 恢复出来的行仍然不给编辑/撤回入口(宿主会拒)', () => {
    const cancelSnapshot = chatSnapshot([userMessage('u6', 41), marker('m6', 42, [41]), unhideNode('x6', 43, 42)])
    expect(hooks.useShadowed(useChatFor(cancelSnapshot), 41)).toBe(true)
    expect(hooks.useSeqHidden(useChatFor(cancelSnapshot), 41)).toBe(false)
  })

  it('markerOpFromId / isUnhideMarkerEvent:独立前缀,不与 recall/edit/regenerate/restore/fold 相撞', () => {
    expect(hooks.markerOpFromId('retrace-unhide-mf3k-ab12cd34')).toBe('unhide')
    expect(hooks.markerOpFromId('retrace-recall-1')).toBe('recall')
    expect(hooks.markerOpFromId('retrace-restore-1')).toBe('restore')
    expect(hooks.isUnhideMarkerEvent({
      seq: 9, type: 'user/message', surfaceOp: 'append',
      data: { id: 'retrace-unhide-1', op: 'unhide', cancels: 7 },
    })).toBe(true)
    // 业务成员缺失/前缀不符 ⇒ 不认(不会被当成取消标记)
    expect(hooks.isUnhideMarkerEvent({ type: 'user/message', surfaceOp: 'append', data: { id: 'retrace-recall-1', op: 'unhide' } })).toBe(false)
    expect(hooks.isUnhideMarkerEvent({ type: 'user/message', surfaceOp: 'append', data: { id: 'retrace-unhide-1' } })).toBe(false)
  })

  it('写侧→读侧闭环:append 的取消标记被 marker 定义认成 op=unhide 节点(不隐藏任何节点)', () => {
    const cancelEvent = {
      seq: 9,
      time: 1,
      type: 'user/message',
      surfaceOp: 'append',
      data: {
        role: 'user',
        id: 'retrace-unhide-mf3k-ab12cd34',
        op: 'unhide',
        cancels: 7,
        content: [{ type: 'text', text: '（已恢复显示被撤回的内容…' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
    }
    expect(__recallMarkerDefinition.match(cancelEvent)).toMatchObject({ role: 'start' })
    const state = __recallMarkerDefinition.start({}, { event: cancelEvent }, undefined)
    expect(state.op).toBe('unhide')
    expect(state.legacy).toBe(false)
    expect(state.cancels).toEqual({ seqs: [7], ids: [] })
    expect(state.shadowedSeqs).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// ② 标记行渲染:未取消 = 逐字节不变;已取消 = 无隐藏规则 + 「已恢复显示」
// ---------------------------------------------------------------------------
describe('RecallMarkerRow — 未取消的既有隐藏行为逐字节不变,已取消不注入隐藏规则', () => {
  const markerNode = marker('m1', 7, [5, 6])

  it('未取消:注入的 CSS 与 0.4.123 的规则全文逐字节相同,且没有「恢复显示」以外的多余按钮', () => {
    const element = hooks.RecallMarkerRow({
      node: markerNode, sessionId: 's1', useChat: useChatFor(chatSnapshot([userMessage('u1', 5), assistantStep('a1', 'm-1', 6), markerNode])), t: tKey,
    })
    const styles = stylesOf(element)
    expect(styles).toHaveLength(1)
    expect(styles[0].props.dangerouslySetInnerHTML.__html).toBe(expectedCss(['u1', 'a1']))
    // 撤回文案不变(2 个被遮蔽 seq ⇒ recallMany,与既有分支逐字一致)
    expect(textOf(collectElements(element).find((el) => el.props?.role === 'status'))).toBe('marker.recallMany')
  })

  it('op=fold / op=restore 的既有渲染不变(fold 仍走降级闸,restore 仍是回档文案)', () => {
    const fold = marker('mf', 17, [15], { op: 'fold' })
    const folded = hooks.RecallMarkerRow({
      node: fold, sessionId: 's1', useChat: useChatFor(chatSnapshot([userMessage('u1', 15), fold])), t: tKey,
    })
    expect(stylesOf(folded)[0].props.dangerouslySetInnerHTML.__html).toBe(expectedCss(['u1']))
    const restore = marker('mr', 27, [25], { op: 'restore' })
    const restored = hooks.RecallMarkerRow({
      node: restore, sessionId: 's1', useChat: useChatFor(chatSnapshot([userMessage('u1', 25), restore])), t: tKey,
    })
    expect(textOf(collectElements(restored).find((el) => el.props?.role === 'status'))).toBe('marker.restore')
  })

  it('被取消:该 marker 行不再注入隐藏 CSS,显示「已恢复显示」,按钮消失', () => {
    const element = hooks.RecallMarkerRow({
      node: markerNode,
      sessionId: 's1',
      useChat: useChatFor(chatSnapshot([
        userMessage('u1', 5), assistantStep('a1', 'm-1', 6), markerNode, unhideNode('x1', 8, 7),
      ])),
      t: tKey,
    })
    expect(stylesOf(element)).toHaveLength(0)
    const texts = collectElements(element).filter((el) => el.props?.role === 'status').map((el) => textOf(el))
    expect(texts).toContain('marker.restored')
    expect(buttonsOf(element).map((el) => el.props.className)).not.toContain('dsh-rt-chip dsh-rt-marker-unhide')
  })

  it('可取消的 marker 才有「恢复显示」;fold/unhide/legacy/无隐藏键一律没有', () => {
    const render = (node, snapshot) => hooks.RecallMarkerRow({ node, sessionId: 's1', useChat: useChatFor(snapshot), t: tKey })
    const has = (element) => buttonsOf(element).some((el) => String(el.props.className).includes('dsh-rt-marker-unhide'))
    // recall(有键)⇒ 有
    expect(has(render(markerNode, chatSnapshot([userMessage('u1', 5), markerNode])))).toBe(true)
    // restore(有键)⇒ 有(回退也是"撤销"的一种)
    const rest = marker('mr', 27, [25], { op: 'restore' })
    expect(has(render(rest, chatSnapshot([userMessage('u1', 25), rest])))).toBe(true)
    // fold ⇒ 无(归档有既有展开链路)
    const fold = marker('mf', 17, [15], { op: 'fold' })
    expect(has(render(fold, chatSnapshot([userMessage('u1', 15), fold])))).toBe(false)
    // legacy ⇒ 无(它本来就不隐藏)
    const legacy = marker('ml', 37, [35], { legacy: true })
    expect(has(render(legacy, chatSnapshot([userMessage('u1', 35), legacy])))).toBe(false)
    // 隐藏键为空 ⇒ 无(没有可恢复的内容)
    const empty = marker('me', 47, [])
    expect(has(render(empty, chatSnapshot([userMessage('u1', 45), empty])))).toBe(false)
  })

  it('取消标记自己的 notice 行:文案 = marker.unhide,不注入任何隐藏规则、没有按钮', () => {
    const element = hooks.RecallMarkerRow({
      node: unhideNode('x1', 8, 7),
      sessionId: 's1',
      useChat: useChatFor(chatSnapshot([userMessage('u1', 5), marker('m1', 7, [5]), unhideNode('x1', 8, 7)])),
      t: tKey,
    })
    expect(stylesOf(element)).toHaveLength(0)
    expect(textOf(element)).toContain('marker.unhide')
    expect(buttonsOf(element)).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// ③ 点「恢复显示」→ 调 op → 界面立刻恢复(真渲染循环)
// ---------------------------------------------------------------------------
describe('点「恢复显示」(真渲染循环)', () => {
  const buildNode = () => marker('m1', 7, [5, 6])
  const snapshotFor = (withCancel) => chatSnapshot([
    userMessage('u1', 5),
    assistantStep('a1', 'm-1', 6),
    buildNode(),
    ...(withCancel ? [unhideNode('x1', 8, 7)] : []),
  ])

  const mountRow = (mini, client, node, snapshot) => {
    mini.reset()
    mini.mount(mini.react.createElement('div', { className: 'host-app' },
      mini.react.createElement(client.RecallMarkerRow, {
        node, sessionId: 's1', useChat: useChatFor(snapshot), t: tZh,
      })))
    mini.flush()
  }

  it('点击 → callOp(unhide,{sessionId,markerSeq}) → <style> 消失(界面立刻恢复)+ 「已恢复显示」', async () => {
    const mini = createMiniReact()
    const client = await bundleClient(mini.react)
    const calls = []
    client.__setMessageEditorWire((op, payload) => {
      calls.push({ op, payload })
      return Promise.resolve({ ok: true, value: { op: 'unhide', markerSeq: 7, cancelSeq: 9 } })
    })
    try {
      mountRow(mini, client, buildNode(), snapshotFor(false))
      const styleEl = collectElements(mini.tree()).filter((el) => el.type === 'style')
      expect(styleEl).toHaveLength(1) // 点击前:藏着
      const button = collectElements(mini.tree()).find((el) => el.type === 'button')
      expect(button.props.className).toContain('dsh-rt-marker-unhide')

      button.props.onClick()
      await new Promise((resolve) => setTimeout(resolve, 0))
      mini.flush()

      expect(calls).toEqual([{ op: 'unhide', payload: { sessionId: 's1', markerSeq: 7 } }])
      // 界面立刻恢复:注入的隐藏 <style> 被 React 从树上移除(不等宿主推回取消标记)
      expect(collectElements(mini.tree()).filter((el) => el.type === 'style')).toHaveLength(0)
      expect(textOf(mini.tree())).toContain(zh['marker.restored'])
      // 按钮消失 ⇒ 重复取消无从发生
      expect(collectElements(mini.tree()).filter((el) => el.type === 'button')).toHaveLength(0)
    } finally {
      client.__setMessageEditorWire(null)
    }
  })

  it('宿主已推回取消标记(durable 路径)时,行直接是「已恢复」态:没有按钮、没有隐藏规则', async () => {
    const mini = createMiniReact()
    const client = await bundleClient(mini.react)
    try {
      mountRow(mini, client, buildNode(), snapshotFor(true))
      expect(collectElements(mini.tree()).filter((el) => el.type === 'style')).toHaveLength(0)
      expect(collectElements(mini.tree()).filter((el) => el.type === 'button')).toHaveLength(0)
      expect(textOf(mini.tree())).toContain(zh['marker.restored'])
    } finally {
      client.__setMessageEditorWire(null)
    }
  })

  it('失败:显示可读错误、按钮还在(可重试),界面**不**假装恢复', async () => {
    const mini = createMiniReact()
    const client = await bundleClient(mini.react)
    client.__setMessageEditorWire(() => Promise.resolve({
      ok: false, error: { code: 'marker-not-found', message: '未找到该撤回/编辑标记' },
    }))
    try {
      mountRow(mini, client, buildNode(), snapshotFor(false))
      // ⚠️ 按 **class 定位**「恢复显示」按钮:0.4.126 起 marker 行上还有第二枚按钮
      // (「真正恢复」,log-level undo),按 `el.type === 'button'` 计数会把两枚都数进来。
      collectElements(mini.tree()).find((el) => el.type === 'button' && el.props?.className === 'dsh-rt-chip dsh-rt-marker-unhide').props.onClick()
      await new Promise((resolve) => setTimeout(resolve, 0))
      mini.flush()

      expect(collectElements(mini.tree()).filter((el) => el.type === 'style')).toHaveLength(1) // 仍然藏着
      // 未映射 code ⇒ 透传宿主文案(host-core 已是中文,不静默)
      expect(textOf(mini.tree())).toContain('未找到该撤回/编辑标记')
      // 失败后「恢复显示」按钮还在(可重试);真正恢复按钮也在(两条出路都在,不假装恢复)
      const buttons = collectElements(mini.tree()).filter((el) => el.type === 'button')
      expect(buttons.filter((el) => el.props?.className === 'dsh-rt-chip dsh-rt-marker-unhide')).toHaveLength(1)
      expect(buttons.filter((el) => el.props?.className === 'dsh-rt-chip dsh-rt-marker-true-restore')).toHaveLength(1)
    } finally {
      client.__setMessageEditorWire(null)
    }
  })

  it('reject(网络/通道抛错)也留痕:错误文案可见,不静默', async () => {
    const mini = createMiniReact()
    const client = await bundleClient(mini.react)
    client.__setMessageEditorWire(() => Promise.reject(new Error('HTTP 404')))
    try {
      mountRow(mini, client, buildNode(), snapshotFor(false))
      collectElements(mini.tree()).find((el) => el.type === 'button' && el.props?.className === 'dsh-rt-chip dsh-rt-marker-unhide').props.onClick()
      await new Promise((resolve) => setTimeout(resolve, 0))
      mini.flush()
      expect(textOf(mini.tree())).toContain('HTTP 404')
      expect(collectElements(mini.tree()).filter((el) => el.type === 'button' && el.props?.className === 'dsh-rt-chip dsh-rt-marker-unhide')).toHaveLength(1)
    } finally {
      client.__setMessageEditorWire(null)
    }
  })
})

// ---------------------------------------------------------------------------
// ④ 「该隐藏却没隐藏」:消费侧判定 + warn/clientReport 两条出口
// ---------------------------------------------------------------------------
describe('hide-miss 消费侧判定(warn + clientReport)', () => {
  const reports = []
  const wire = (op, payload) => {
    reports.push({ op, payload })
    return Promise.resolve({ ok: true, value: { logged: true } })
  }
  const drain = () => { reports.length = 0 }

  it('正常路径零噪音:该隐藏的 marker 隐藏成功 ⇒ 一条 clientReport 都没有', () => {
    drain()
    hooks.__setMessageEditorWire(wire)
    const snapshot = chatSnapshot([userMessage('u1', 5), marker('m1', 6, [5])])
    hooks.useHideMissReport(useChatFor(snapshot), 's-normal')
    hooks.useHideMissReport(useChatFor(snapshot), 's-normal')
    hooks.__setMessageEditorWire(null)
    expect(reports).toEqual([])
  })

  it('① 计划侧:marker 在、却产不出隐藏键 ⇒ missDetails 命中并上报 clientReport', () => {
    drain()
    const snapshot = chatSnapshot([
      userMessage('u1', 105),
      // shadowedSeqs 指向的 seq 在快照里没有节点 ⇒ 键为空(撤回后界面还在的形态)
      marker('m-miss', 106, [999]),
    ])
    const plan = hooks.hidePlanOf(snapshot)
    expect(plan.missDetails).toHaveLength(1)
    expect(plan.missDetails[0]).toMatchObject({ key: 'm-miss', reason: 'no-hidden-keys', op: 'recall', seqCount: 1 })
    hooks.__setMessageEditorWire(wire)
    hooks.useHideMissReport(useChatFor(snapshot), 's-miss-1')
    hooks.useHideMissReport(useChatFor(snapshot), 's-miss-1') // 幂等:只报一次
    hooks.__setMessageEditorWire(null)
    expect(reports).toHaveLength(1)
    expect(reports[0].op).toBe('clientReport')
    expect(reports[0].payload.source).toContain('hide-miss:no-hidden-keys')
  })

  it('② 盲区侧(markers.length === 0):op 成功却没等到标记进 snapshot ⇒ 宽限期后上报 marker-not-in-snapshot', () => {
    drain()
    const nowSpy = vi.spyOn(Date, 'now')
    try {
      nowSpy.mockReturnValue(1_000_000)
      hooks.expectHiddenRows('s-blind', 'recall', 205, 3)
      // 行在快照里、但那枚标记**没进** snapshot(旧判据的永久盲区:hidePlan 走 EMPTY_HIDE_PLAN,
      // marker 组件根本不渲染 ⇒ 以前一条日志都没有)
      const snapshot = chatSnapshot([userMessage('u1', 205)])
      expect(hooks.hidePlanOf(snapshot).markerCount).toBe(0)
      hooks.__setMessageEditorWire(wire)
      // 宽限期内:不报(正常推送延迟不出噪音)
      hooks.useHideMissReport(useChatFor(snapshot), 's-blind')
      expect(reports).toEqual([])
      // 宽限期后:报一次(且只报一次)
      nowSpy.mockReturnValue(1_000_000 + 6000)
      hooks.useHideMissReport(useChatFor(snapshot), 's-blind')
      hooks.useHideMissReport(useChatFor(snapshot), 's-blind')
      hooks.__setMessageEditorWire(null)
      expect(reports).toHaveLength(1)
      expect(reports[0].payload.source).toContain('hide-miss:marker-not-in-snapshot')
      expect(reports[0].payload.source).toContain('s-blind')
      // 账本已清:同一期望不会再报
      nowSpy.mockReturnValue(1_000_000 + 60000)
      hooks.__setMessageEditorWire(wire)
      hooks.useHideMissReport(useChatFor(snapshot), 's-blind')
      hooks.__setMessageEditorWire(null)
      expect(reports).toHaveLength(1)
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('② 期望兑现(标记进了 snapshot、行被隐藏)⇒ 账本清掉、零上报', () => {
    drain()
    const nowSpy = vi.spyOn(Date, 'now')
    try {
      nowSpy.mockReturnValue(2_000_000)
      hooks.expectHiddenRows('s-ok', 'recall', 305, 1)
      hooks.__setMessageEditorWire(wire)
      hooks.useHideMissReport(useChatFor(chatSnapshot([userMessage('u1', 305), marker('m-ok', 306, [305])])), 's-ok')
      nowSpy.mockReturnValue(2_000_000 + 60000)
      // 账本已清 ⇒ 即使过很久也不再出现在判定里
      hooks.useHideMissReport(useChatFor(chatSnapshot([userMessage('u1', 305)])), 's-ok')
      hooks.__setMessageEditorWire(null)
      expect(reports).toEqual([])
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('目标行不在快照里(未加载/窗口化)⇒ 判不了就不误报', () => {
    drain()
    const nowSpy = vi.spyOn(Date, 'now')
    try {
      nowSpy.mockReturnValue(3_000_000)
      hooks.expectHiddenRows('s-nowin', 'editAndResend', 405, 2)
      const snapshot = chatSnapshot([userMessage('u1', 999)])
      hooks.__setMessageEditorWire(wire)
      nowSpy.mockReturnValue(3_000_000 + 60000)
      hooks.useHideMissReport(useChatFor(snapshot), 's-nowin')
      hooks.__setMessageEditorWire(null)
      expect(reports).toEqual([])
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('shadowed 为 0(宿主没遮蔽任何东西)⇒ 不登记期望', () => {
    drain()
    const nowSpy = vi.spyOn(Date, 'now')
    try {
      nowSpy.mockReturnValue(4_000_000)
      hooks.expectHiddenRows('s-zero', 'recall', 505, 0)
      hooks.__setMessageEditorWire(wire)
      nowSpy.mockReturnValue(5_000_000)
      hooks.useHideMissReport(useChatFor(chatSnapshot([userMessage('u1', 505)])), 's-zero')
      hooks.__setMessageEditorWire(null)
      expect(reports).toEqual([])
    } finally {
      nowSpy.mockRestore()
    }
  })
})

// ---------------------------------------------------------------------------
// ⑤ i18n:新键中英成对,且不再是英文(zh)
// ---------------------------------------------------------------------------
describe('撤销撤回文案(zh/en 成对)', () => {
  it('新键两边都有、非空、且 zh 不是英文', () => {
    for (const key of ['marker.unhide', 'marker.unhideAction', 'marker.unhiding', 'marker.unhideHint', 'marker.restored']) {
      expect(typeof zh[key], `zh 缺 ${key}`).toBe('string')
      expect(typeof en[key], `en 缺 ${key}`).toBe('string')
      expect(zh[key].length).toBeGreaterThan(0)
      expect(en[key].length).toBeGreaterThan(0)
    }
    expect(zh['marker.unhideAction']).toBe('恢复显示')
    expect(en['marker.unhideAction']).toBe('Restore display')
    expect(zh['marker.restored']).toBe('已恢复显示')
  })

  it('死路文案已改:unionHint 指向「恢复显示」,不再提已撤除的「按标记隐藏」开关', () => {
    for (const dict of [zh, en]) {
      expect(dict['marker.unionHint']).not.toMatch(/按标记隐藏|Hide shadowed messages|设置→通用/)
    }
    expect(zh['marker.unionHint']).toContain('恢复显示')
    expect(en['marker.unionHint']).toContain('Restore display')
  })

  it('审计列出的 10 个英文 zh 键已中文化(值里不再是大段英文)', () => {
    const keys = [
      'options.showOriginalInput', 'options.versioning', 'options.versioningDesc',
      'options.summaryDesc', 'options.git', 'options.gitDesc', 'options.retentionDesc',
      'timeline.gitHead', 'options.closeGuardDesc',
    ]
    for (const key of keys) {
      expect(typeof zh[key], `zh 缺 ${key}`).toBe('string')
      expect(zh[key], `zh[${key}] 仍是英文`).toMatch(/[\u4e00-\u9fa5]/)
      // 英文侧保持不变(仍是英文)
      expect(en[key]).toBeTruthy()
    }
  })
})

// ---------------------------------------------------------------------------
// ⑥ 端到端(写侧 → 读侧):宿主真写出的两段 marker + 取消标记,经**真定义**变成节点后,
//    hidePlanOf 里那条 marker 的隐藏键真的消失(不是用手搓节点自证)。
// ---------------------------------------------------------------------------
describe('端到端:hidePlanOf 认出真写入的取消标记', () => {
  /** 事件 → 客户端 marker 节点(走 lib/client.js 的真定义 match/start)。 */
  const nodeOf = (event) => {
    const matched = __recallMarkerDefinition.match(event)
    const state = __recallMarkerDefinition.start({}, { ...matched, event }, undefined)
    return { key: `marker:${String(event.data?.id ?? event.seq)}`, kind: 'recall-marker', anchorSeq: state.seq, data: state }
  }

  it('撤回(真 writer 两段结构)→ 取消(host-core unhide):隐藏键从有到无', async () => {
    const session = makeSession().seed(
      headerEvent(),
      hostUserMessage('u1', 'first question'),
      hostAssistantMessage('a1', 'first answer'),
    )
    const api = makeApi(session, makeAgent())
    const recall = await api.recall({ sessionId: 's1', messageId: 'u1' })
    expect(recall.ok).toBe(true)
    const markerEvent = lastCarrierMarker(session)
    expect(markerEvent).toBeTruthy()
    const markerNode = nodeOf(markerEvent)
    expect(markerNode.data.op).toBe('recall')
    // 被遮蔽 seq 读得到(真写入的 provenance/审计)
    expect(markerNode.data.shadowedSeqs.length).toBeGreaterThan(0)

    const events = session.snapshotEvents()
    const rowSeq = events.find((e) => e?.type === 'user/message' && e.data?.id === 'u1')?.seq
    const rowKey = 'u1' // 官方 user 行 key = message id(与 client-chat-hooks 夹具同形)
    const rows = [{ key: rowKey, kind: 'user-message', anchorSeq: rowSeq, data: { seq: rowSeq, messageId: 'u1', content: [] } }]

    const before = hooks.hidePlanOf(chatSnapshot([...rows, markerNode]))
    expect(before.planFor(markerNode.key).cancelled).toBeUndefined()
    expect(before.isSeqHidden(rowSeq)).toBe(true)

    const cancel = await api.unhide({ sessionId: 's1', markerSeq: markerEvent.seq })
    expect(cancel.ok).toBe(true)
    const cancelNode = nodeOf(session.eventAt(cancel.value.cancelSeq))
    expect(cancelNode.data.op).toBe('unhide')
    expect(cancelNode.data.cancels).toEqual({ seqs: [markerEvent.seq], ids: [] })

    const after = hooks.hidePlanOf(chatSnapshot([...rows, markerNode, cancelNode]))
    expect(after.planFor(markerNode.key)).toMatchObject({ cancelled: true, keys: null })
    expect(after.isSeqHidden(rowSeq)).toBe(false)
    expect(after.unionRatio).toBe(0)
    expect(after.cancelledCount).toBe(1)
    // 取消标记的行本身也进了快照(读端看得到"已恢复"这条留痕)
    expect(after.planKeys).toEqual([markerNode.key])
  })
})
