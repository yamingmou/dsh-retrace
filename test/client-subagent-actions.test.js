/**
 * 任务 2(0.4.131)—— 子代理会话里隐藏「编辑 / 撤回 / 重新生成」。
 *
 * 显示成因(独立审计取证,可直接采信):`lib/client.js` 的 `userActionsDefinition.match`
 * 里没有任何会话维度规则,而它被注册进**全局** `uiConversation` 定义注册器
 * ⇒ 任何会话视图(含子代理)同一规则 ⇒ 核心套件在子代理会话里也出现。
 *
 * 规则的实测取证(逐字 `文件:行号` 写在 lib/client.js 的 `isSubagentSessionView` 注释里):
 *  · 官方 ui-subagent 自己用 `useSessions((state) => state.byId[sessionId]?.origin === "subagent")`
 *    (`@deepseek-ai/dsh-client-ui-subagent` `lib/client.js` — 隐藏「打开子代理目录」);
 *  · 第二规则 = 官方客户端会话快照的 `subagent` 字段(`.../sessions/session.js`,
 *    官方读法 `dsh-client-ui-subagent/lib/client.js/930`);
 *  · 两个 slot(`conversation.chat.node` / `conversation.chat.assistant-actions`)都是
 *    `scope: "session"` 且 `standardProps` 含 `sessionId`/`useSessions`/`useSession`
 *    (`dsh-cordis-client-runner/lib/client.js` 与 `:2397-2440` 的 slot 目录)。
 *
 * 本文件钉住:① 子代理会话 ⇒ 核心套件不显示;② 主会话 ⇒ 照常显示(行为逐字不变);
 * ③ 规则函数的正/反例(含"无 parentSession 的普通会话不得被误判为子代理")。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { collectElements } from './mini-react.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLIENT_SOURCE_PATH = path.join(ROOT, 'lib', 'client.js')
const nodeRequire = createRequire(import.meta.url)

const EXTRACTED = ['UserActionsRow', 'AssistantActions']

const statelessReact = {
  Component: class { constructor(props) { this.props = props ?? {}; this.state = {} } setState() {} },
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn(),
  useRef: (value) => ({ current: value }),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  Fragment: Symbol('react.fragment'),
}

let client

beforeAll(async () => {
  const source = readFileSync(CLIENT_SOURCE_PATH, 'utf8')
  for (const name of EXTRACTED) {
    expect(source.includes(`function ${name}(`) || source.includes(`const ${name} =`),
      `lib/client.js must declare ${name}`).toBe(true)
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
  client = mod.exports
})

afterAll(() => { /* 无外部资源需要清理 */ })

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------
const tKey = (key) => key
const tZh = (key) => ({ 'action.edit': '编辑', 'action.recallUser': '撤回', 'action.regenerate': '重新生成' }[key] ?? key)
const chatSnapshot = (entries) => ({ nodes: new Map(entries.map((n) => [n.key, n])), order: entries.map((n) => n.key) })
const useChatFor = (snapshot) => (selector) => selector(snapshot)

const userActions = (key, seq) => ({
  key, kind: 'user-actions', anchorSeq: seq,
  data: { seq, time: 0, messageId: `u-${key}`, content: [{ type: 'text', text: 'hi' }] },
})
const assistantStep = (key, messageId, seq) => ({
  key, kind: 'assistant-step', anchorSeq: seq,
  data: { finalNode: { messageId, seq }, blocks: [], status: 'done' },
})

/** 官方 `useSessions` 形状的最小替身:选择器吃一份会话列表快照。 */
const fakeUseSessions = (byId) => (selector) => selector({ byId })
/** 官方 `useSession` 形状的最小替身:选择器吃该会话快照。 */
const fakeUseSession = (snapshot) => (selector) => selector(snapshot)

/** 主会话(普通会话):origin 缺省、subagent=null;parentSession 血缘不参与规则。 */
const mainSessionHooks = {
  useSessions: fakeUseSessions({ s1: { id: 's1', parentId: 'session-parent-1' } }),
  useSession: fakeUseSession({ sessionId: 's1', subagent: null }),
}
const subagentSessionHooks = {
  useSessions: fakeUseSessions({ sub1: { id: 'sub1', parentId: 's1', origin: 'subagent' } }),
  useSession: fakeUseSession({ sessionId: 'sub1', subagent: { address: { kind: 'subagent', parentSessionId: 's1', childSessionId: 'sub1', mode: 'continuable' }, parentAvailable: true } }),
}

const chipsOf = (element) => collectElements(element)
  .filter((el) => el.type === 'button' && String(el.props?.className ?? '').includes('dsh-rt-chip'))
  .map((el) => el.props.title)
const iconButtons = (element) => collectElements(element)
  .filter((el) => el.type === 'button' && String(el.props?.className ?? '').includes('dsh-rt-icon'))

const userRow = (node, sessionId, hooks) => client.UserActionsRow({
  node, sessionId,
  useChat: useChatFor(chatSnapshot([node])),
  inputActions: {}, t: tZh, ...hooks,
})
const assistantRow = (messageId, sessionId, hooks) => client.AssistantActions({
  messageId, sessionId,
  useChat: useChatFor(chatSnapshot([assistantStep('a1', messageId, 42)])),
  t: tZh, ...hooks,
})

// ---------------------------------------------------------------------------
// ③ 规则函数正/反例
// ---------------------------------------------------------------------------
describe('isSubagentSessionView — 单一规则函数(官方 origin / subagent 两字段)', () => {
  it('正例:列表快照 origin==="subagent" ⇒ true(官方 ui-subagent:603 的同款规则)', () => {
    expect(client.isSubagentSessionView({
      sessionId: 'sub1',
      useSessions: fakeUseSessions({ sub1: { origin: 'subagent', parentId: 's1' } }),
    })).toBe(true)
  })

  it('正例:会话快照 subagent 非 null ⇒ true(官方 ui-subagent:621/930 的同款规则)', () => {
    expect(client.isSubagentSessionView({
      sessionId: 'sub1',
      useSession: fakeUseSession({ subagent: { address: { mode: 'one-shot' } } }),
    })).toBe(true)
  })

  it('★反例:普通会话(无 parentSession、origin 缺省、subagent===null)⇒ false', () => {
    expect(client.isSubagentSessionView({
      sessionId: 's1',
      useSessions: fakeUseSessions({ s1: { id: 's1' } }),
      useSession: fakeUseSession({ sessionId: 's1', subagent: null }),
    })).toBe(false)
  })

  it('★反例:fork 出来的普通会话(带 parentId 血缘但 origin 缺省、subagent=null)不得被误判为子代理', () => {
    expect(client.isSubagentSessionView({
      sessionId: 'forked',
      useSessions: fakeUseSessions({ forked: { id: 'forked', parentId: 'session-origin' } }),
      useSession: fakeUseSession({ sessionId: 'forked', subagent: null }),
    })).toBe(false)
  })

  it('反例:钩子缺失(旧宿主/单测直调)、sessionId 空、选择器抛错 ⇒ 一律 false(不误藏)', () => {
    expect(client.isSubagentSessionView({})).toBe(false)
    expect(client.isSubagentSessionView({ sessionId: '' })).toBe(false)
    expect(client.isSubagentSessionView({ sessionId: 's1', useSessions: () => { throw new Error('no service') } })).toBe(false)
    expect(client.isSubagentSessionView({ sessionId: 's1', useSession: () => { throw new Error('no service') } })).toBe(false)
    // 两个来源都被读到时也不因为"读不到"而误判
    expect(client.isSubagentSessionView({
      sessionId: 's1',
      useSessions: fakeUseSessions({}),
      useSession: fakeUseSession(undefined),
    })).toBe(false)
  })

  it('规则只认该 sessionId 自己那一行:别的会话是子代理也不影响本会话', () => {
    const byId = { sub9: { origin: 'subagent' }, s1: { id: 's1' } }
    expect(client.isSubagentSessionView({ sessionId: 's1', useSessions: fakeUseSessions(byId) })).toBe(false)
    expect(client.isSubagentSessionView({ sessionId: 'sub9', useSessions: fakeUseSessions(byId) })).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// ① 子代理会话 ⇒ 核心套件不显示 / ② 主会话 ⇒ 照常显示
// ---------------------------------------------------------------------------
describe('子代理会话里不显示「编辑 / 撤回 / 重新生成」;主会话逐字照旧', () => {
  it('① 子代理会话:UserActionsRow 返回 null(编辑/撤回不显示)', () => {
    const node = userActions('u1', 5)
    expect(userRow(node, 'sub1', subagentSessionHooks)).toBe(null)
  })

  it('① 子代理会话:AssistantActions 返回 null(重新生成不显示)', () => {
    expect(assistantRow('msg-1', 'sub1', subagentSessionHooks)).toBe(null)
  })

  it('① 只有 origin 规则(pickUseSession 缺席)也生效:子代理会话同样不显示', () => {
    const node = userActions('u1', 5)
    expect(userRow(node, 'sub1', { useSessions: subagentSessionHooks.useSessions })).toBe(null)
    expect(assistantRow('msg-1', 'sub1', { useSessions: subagentSessionHooks.useSessions })).toBe(null)
  })

  it('② 主会话:UserActionsRow 照常显示编辑与撤回 chip', () => {
    const node = userActions('u1', 5)
    const element = userRow(node, 's1', mainSessionHooks)
    expect(element).not.toBe(null)
    const titles = chipsOf(element)
    expect(titles.length).toBeGreaterThan(0)
    expect(titles).toContain('编辑')
    expect(titles).toContain('撤回')
  })

  it('② 主会话:AssistantActions 照常显示「重新生成」图标按钮', () => {
    const element = assistantRow('msg-1', 's1', mainSessionHooks)
    expect(element).not.toBe(null)
    const icons = iconButtons(element)
    expect(icons).toHaveLength(1)
    expect(icons[0].props.title).toBe('重新生成')
  })

  it('② 主会话 + 钩子缺席(旧宿主)⇒ 与改动前逐字一致(仍显示核心套件)', () => {
    const node = userActions('u1', 5)
    const element = userRow(node, 's1', {})
    expect(chipsOf(element)).toContain('编辑')
    expect(iconButtons(assistantRow('msg-1', 's1', {}))).toHaveLength(1)
  })

  it('② 主会话里"被隐藏/被遮蔽"的既有抑制仍然优先(不因新规则而放宽)', () => {
    // marker 遮蔽 seq 5 ⇒ 该行的编辑/撤回照旧被抑制(与 0.4.130 同规则)
    const markerNode = {
      key: 'm1', kind: 'recall-marker', anchorSeq: 7,
      data: { seq: 7, op: 'recall', shadowedSeqs: [5], legacy: false, compact: false, markerId: 'retrace-recall-7' },
    }
    const node = userActions('u1', 5)
    const element = client.UserActionsRow({
      node, sessionId: 's1',
      useChat: useChatFor(chatSnapshot([node, markerNode])),
      inputActions: {}, t: tZh, ...mainSessionHooks,
    })
    expect(element).toBe(null)
  })
})
