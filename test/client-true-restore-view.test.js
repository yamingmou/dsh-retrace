/**
 * 真正恢复 · 任务 1 的客户端侧(0.4.131)—— 「写后让界面当场可见」。
 *
 * 平台调研结论(逐字依据写在 lib/client.js 的「真正恢复:需重读信号」块):
 * 平台**没有**官方「会话日志重读/缓存失效」接口(宿主 history 路由 live-preferred:
 * dsh-session-query/lib/index.js;SessionService 无 reload;客户端 sessions 服务
 * 只有 refreshProjections/refreshList)。因此本插件用两级机制:
 *   ① 本地视图账本(主路径):宿主写成功后客户端把该 marker 记下 ⇒ marker 行当帧不再注入
 *      隐藏 CSS、动作行不再被抑制(HIDE 消失 = 被撤回内容当帧重新可见);
 *   ② 官方 session.resync()(**尽力**,可取不到)。
 * 两级都不可用/失败 ⇒ clientReport 留痕 + 界面明写「刷新页面/重开会话」这一档手动兜底。
 *
 * 本文件用 test/mini-react.js 真渲染循环驱动**真实 lib/client.js**:
 * 点「真正恢复」→ op 返回 → 账本落 + resync 被调 → <style> 消失。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { createMiniReact, collectElements, textOf } from './mini-react.js'
import { readClientSource } from './client-source.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLIENT_SOURCE_PATH = path.join(ROOT, 'lib', 'client.js')
const nodeRequire = createRequire(import.meta.url)

/** 只有组件名需要**追加导出**(其余名字 lib/client.js 已 export)。 */
const EXTRACTED = ['RecallMarkerRow']
/** 自检:这些名字必须真的在 lib/client.js 里声明(少了就 fail-loud,不静默跳过)。 */
const REQUIRED_NAMES = [
  'zh', 'en', 'RecallMarkerRow', 'markTrueRestored', 'isLocallyTrueRestored',
  '__setTrueRestoreRereadDeps', '__setMessageEditorWire',
]

let mini
let client

beforeAll(async () => {
  const source = readFileSync(CLIENT_SOURCE_PATH, 'utf8')
  // 声明存在性按**文本面**查(拆分后的等价全文,见 test/client-source.js);
  // 下面喂给 esbuild 的仍是 lib/client.js 入口。
  const allSource = readClientSource()
  for (const name of REQUIRED_NAMES) {
    const declared = allSource.includes(`function ${name}(`) || allSource.includes(`const ${name} =`)
      || allSource.includes(`export const ${name} =`)
    expect(declared, `lib/client.js must declare ${name}`).toBe(true)
  }
  mini = createMiniReact()
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
    (id) => (id === 'react' ? mini.react : nodeRequire(id)), mod, mod.exports,
  )
  client = mod.exports
})

afterAll(() => {
  client.__setMessageEditorWire(null)
  client.__setTrueRestoreRereadDeps(null)
})

beforeEach(() => {
  mini.reset()
  client.__setMessageEditorWire(null)
  client.__setTrueRestoreRereadDeps(null)
})

// ---------------------------------------------------------------------------
// fixtures(与 test/client-unhide.test.js 同形)
// ---------------------------------------------------------------------------
const tZh = (key) => client.zh[key]
const userMessage = (key, seq) => ({
  key, kind: 'user-message', anchorSeq: seq,
  data: { seq, messageId: `u-${key}`, content: [{ type: 'text', text: `text ${seq}` }] },
})
const assistantStep = (key, messageId, seq) => ({
  key, kind: 'assistant-step', anchorSeq: seq,
  data: { finalNode: { messageId, seq }, blocks: [], status: 'done' },
})
const markerNode = (key, seq, shadowedSeqs) => ({
  key, kind: 'recall-marker', anchorSeq: seq,
  data: {
    seq, op: 'recall', shadowedSeqs, legacy: false, compact: false,
    markerId: `retrace-recall-${seq}`,
  },
})
const chatSnapshot = (entries) => ({ nodes: new Map(entries.map((n) => [n.key, n])), order: entries.map((n) => n.key) })
const useChatFor = (snapshot) => (selector) => selector(snapshot)

const buttons = (className) => collectElements(mini.tree())
  .filter((el) => el.type === 'button' && String(el.props?.className ?? '').includes(className))
const styles = () => collectElements(mini.tree()).filter((el) => el.type === 'style')
const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0))
  mini.flush()
  await new Promise((resolve) => setTimeout(resolve, 0))
  mini.flush()
}

const node = markerNode('m1', 7, [5, 6])
const snapshot = () => chatSnapshot([userMessage('u1', 5), assistantStep('a1', 'm-1', 6), node])

/**
 * ⚠️ 账本是**模块级**的(生产语义:一次页面会话内有效),跨用例共享。
 * 每个用例用自己的 sessionId,既隔离又顺便证明"账本只影响它自己的会话"。
 */
const mountRow = (sessionId) => {
  mini.mount(mini.react.createElement('div', { className: 'host-app' }, mini.react.createElement(client.RecallMarkerRow, {
    node, sessionId, useChat: useChatFor(snapshot()), t: tZh,
  })))
  mini.flush()
}

/** 写成功信封(与 host-core 的返回形状逐字段一致)。 */
const writtenResult = (sessionId) => ({
  ok: true,
  value: {
    op: 'unshadow', markerSeq: 7, markerId: 'retrace-recall-7', markerOp: 'recall',
    alreadyRestored: false, zeroWrite: false, dryRun: false, reloadRequired: true,
    reread: { required: true, sessionId, reason: 'log-rewritten', alreadyRestored: false, neutralizedSeqs: [7, 6], markerId: 'retrace-recall-7' },
  },
})

describe('真正恢复 · 客户端当场可见(任务1)', () => {
  it('账本规则(isLocallyTrueRestored):载体 seq 或 markerId 命中 ⇒ true;别的 session/别的 marker ⇒ false', () => {
    expect(client.isLocallyTrueRestored('ledger-A', node)).toBe(false)
    client.markTrueRestored('ledger-A', { seq: 7, auditSeq: 6, markerId: 'retrace-recall-7' })
    expect(client.isLocallyTrueRestored('ledger-A', node)).toBe(true)
    // 另一个会话不受影响
    expect(client.isLocallyTrueRestored('ledger-B', node)).toBe(false)
    // 同一会话里另一枚 marker(seq/markerId 都不同)不受影响
    expect(client.isLocallyTrueRestored('ledger-A', markerNode('m9', 99, [98]))).toBe(false)
    // 幂等:重复记同一枚不算新增
    expect(client.markTrueRestored('ledger-A', { seq: 7, markerId: 'retrace-recall-7' })).toBe(false)
  })

  it('★写成功后本会话视图当场不再隐藏:账本命中的 marker 行不再注入隐藏 CSS、显示「已真正恢复」', async () => {
    const sid = 'view-main'
    const ops = []
    const resync = vi.fn(async () => {})
    client.__setMessageEditorWire((op, payload) => { ops.push({ op, payload }); return Promise.resolve(writtenResult(sid)) })
    client.__setTrueRestoreRereadDeps({ sessions: () => ({ binding: () => ({ session: { resync } }) }) })

    mountRow(sid)
    // 点击前:隐藏 CSS 在(被撤回内容确实被我们自己的规则藏着)
    expect(styles()).toHaveLength(1)

    const chip = buttons('dsh-rt-marker-true-restore')
    expect(chip).toHaveLength(1)
    chip[0].props.onClick()
    mini.flush()
    await settle()

    // op 只发一次,且**不再**带 currentSessionId(规则已删,见任务1)
    expect(ops.map((o) => o.op)).toEqual(['unshadow'])
    expect(ops[0].payload).toMatchObject({ sessionId: sid, markerSeq: 7 })
    expect('currentSessionId' in ops[0].payload).toBe(false)
    // ① 本地账本生效:隐藏 CSS 消失(当帧不再隐藏该区间),文案 = 已真正恢复
    expect(styles()).toHaveLength(0)
    const status = collectElements(mini.tree()).filter((el) => el.props?.role === 'status').map((el) => textOf(el))
    expect(status.join('|')).toContain(tZh('marker.trueRestore'))
    // ② 官方 resync 被调用一次(尽力重读)
    expect(resync).toHaveBeenCalledTimes(1)
    // 账本落库(渲染规则与账本同源)
    expect(client.isLocallyTrueRestored(sid, node)).toBe(true)
  })

  it('★两级都不可用(resync 取不到 session 面)⇒ 界面明写「刷新页面/重开会话」且 clientReport 留痕', async () => {
    const sid = 'view-fallback'
    const ops = []
    client.__setMessageEditorWire((op, payload) => {
      ops.push({ op, payload })
      if (op === 'clientReport') return Promise.resolve({ ok: true, value: null })
      return Promise.resolve(writtenResult(sid))
    })
    // sessions 服务取不到 ⇒ resync 不可用(真实旧宿主/服务未 provide 的情形)
    client.__setTrueRestoreRereadDeps({ sessions: () => undefined })

    mountRow(sid)
    buttons('dsh-rt-marker-true-restore')[0].props.onClick()
    mini.flush()
    await settle()

    // 界面明写最后兜底(「刷新页面」那一档在文案里)
    const body = textOf(mini.tree())
    expect(body).toContain('刷新页面')
    expect(body).toContain('重开该会话')
    // 留痕:clientReport 一条,source 里写明 reread unavailable
    const reports = ops.filter((o) => o.op === 'clientReport')
    expect(reports).toHaveLength(1)
    expect(String(reports[0].payload.source)).toContain('true-restore-reread unavailable')
    // 即便重读不可用,本地账本仍让界面当场恢复(CSS 已消失)
    expect(styles()).toHaveLength(0)
  })

  it('resync 抛错 ⇒ 同样只是状态:留痕 clientReport(failed)且不影响本地当场可见', async () => {
    const sid = 'view-throw'
    const ops = []
    client.__setMessageEditorWire((op, payload) => {
      ops.push({ op, payload })
      if (op === 'clientReport') return Promise.resolve({ ok: true })
      return Promise.resolve(writtenResult(sid))
    })
    client.__setTrueRestoreRereadDeps({ sessions: () => ({ binding: () => ({ session: { resync: async () => { throw new Error('rpc down') } } }) }) })

    mountRow(sid)
    buttons('dsh-rt-marker-true-restore')[0].props.onClick()
    mini.flush()
    await settle()

    expect(styles()).toHaveLength(0)
    const reports = ops.filter((o) => o.op === 'clientReport')
    expect(reports).toHaveLength(1)
    expect(String(reports[0].payload.source)).toContain('true-restore-reread failed')
    expect(String(reports[0].payload.source)).toContain('rpc down')
  })
})
