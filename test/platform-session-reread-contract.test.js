/**
 * 平台契约取证(0.4.131 两项任务的**逐字依据**锁定)。
 *
 * 为什么要有这个文件:两个任务的实现都建立在一组平台事实之上 ——
 *   · 任务1「当场可见」:平台**没有**官方「会话日志重读/缓存失效」接口(所以只能
 *     本地视图账本 + 尽力调官方 `session.resync()`);
 *   · 任务2「子代理会话规则」:官方自己用什么字段判"这是子代理会话",以及
 *     session 作用域 slot 到底把哪些 standard prop 交到我们组件手里。
 * 这些事实如果只写在注释里,宿主换版后会**静默腐坏**(实现还在跑,依据已经没了)。
 * 所以这里逐条钉住 `文件:行号` —— 宿主升级导致行号/内容漂移 ⇒ 本文件变红,
 * 必须重新核对逐字依据(与 test/true-restore-real.test.js 锁现役内核同一纪律)。
 *
 * ⚠️ 环境不可用(没有 DSH Desktop 解包目录)⇒ **整文件 skip 并打印原因**,不假绿。
 * ⚠️ 只读:本文件不写任何宿主文件。
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** DSH Desktop 的解包运行时(现役件;`check-host-contract` 也读这里)。 */
const APP_ROOT = process.env.DSH_RETRACE_APP_ROOT
  ?? '/Applications/DSH Desktop.app/Contents/Resources/app/node_modules/@deepseek-ai'
const available = existsSync(APP_ROOT)

const read = (rel) => readFileSync(join(APP_ROOT, rel), 'utf8')
const lineAt = (rel, line) => read(rel).split('\n')[line - 1] ?? ''

/**
 * 逐字依据表(实现里引用过的每一条,行号 = 现役件实测)。
 * `needle` 必须是该行的子串(去掉首尾空白后比对,故缩进无关)。
 */
const CITATIONS = [
  // ── 任务2:子代理会话规则(官方 ui-subagent 自己的判法) ────────────────────
  ['dsh-client-ui-subagent/lib/client.js', 602, 'function SubagentCatalogAction({ sessionId, useSessions,', '官方组件从 session 作用域 slot props 里拿 sessionId + useSessions'],
  ['dsh-client-ui-subagent/lib/client.js', 603, "state.byId[sessionId]?.origin === \"subagent\"", '★官方唯一的「这是子代理会话」规则(列表快照 origin)'],
  ['dsh-client-ui-subagent/lib/client.js', 621, 'useSession((session) => session.subagent?.address)', '第二规则:会话快照 subagent'],
  ['dsh-client-ui-subagent/lib/client.js', 930, 'const subagent = owner.session?.subagent;', '第二规则的另一种读法(slot owner.session)'],
  // ── 任务2:数据面(origin/parentId 怎么来的) ───────────────────────────────
  ['dsh-api-session-controller/lib/types/client/sessions/service.js', 434, 'byId[id] === undefined && this.manager.subagentAddress(id)', 'retain 时必然补出该行(规则可用性依据)'],
  ['dsh-api-session-controller/lib/types/client/sessions/service.js', 524, "origin: 'subagent',", '列表快照的 origin 写入点(catalog 分支)'],
  ['dsh-api-session-controller/lib/types/client/sessions/manager.js', 73, 'this.addresses.set(id, address);', 'resolveTarget 在 retain 之前装好 address'],
  ['dsh-api-session-controller/lib/types/client/sessions/session.js', 818, 'subagent: this.address === undefined', '客户端会话快照 subagent 字段的产出点'],
  // ── 任务2:slot 契约(session 作用域把 sessionId/useSessions/useSession 交到组件) ──
  ['dsh-cordis-client-runner/lib/client.js', 2397, 'key: "conversation.chat.assistant-actions",', 'AssistantActions 所在 slot 目录条目'],
  ['dsh-cordis-client-runner/lib/client.js', 2399, 'scope: "session",', '该 slot 是 session 作用域'],
  ['dsh-cordis-client-runner/lib/client.js', 2428, '"useSessions: UseSessions",', 'standardProps:全局 useSessions'],
  ['dsh-cordis-client-runner/lib/client.js', 2436, '"useSession: SessionSnapshotSelector",', 'standardProps:useSession'],
  ['dsh-cordis-client-runner/lib/client.js', 2437, '"sessionId: SessionId",', 'standardProps:sessionId'],
  ['dsh-cordis-client-runner/lib/client.js', 2495, 'key: "conversation.chat.node",', 'UserActionsRow 所在 slot 目录条目'],
  ['dsh-cordis-client-runner/lib/client.js', 2497, 'scope: "session",', '该 slot 是 session 作用域'],
  ['dsh-cordis-client-runner/lib/client.js', 2519, '"useSessions: UseSessions",', 'standardProps:全局 useSessions'],
  ['dsh-cordis-client-runner/lib/client.js', 2527, '"useSession: SessionSnapshotSelector",', 'standardProps:useSession'],
  ['dsh-cordis-client-runner/lib/client.js', 2528, '"sessionId: SessionId",', 'standardProps:sessionId'],
  ['dsh-client-ui-renderer/lib/client.js', 716, 'const standard = standardProps(scope, rootBinding, scopeBinding);', 'standardKit 真把 standard 并进组件 props'],
  ['dsh-client-ui-renderer/lib/client.js', 718, '...standard,', '同上(展开进 kit)'],
  // ── 任务1:平台没有官方重读接口的三条硬证据 ────────────────────────────────
  ['dsh-session-query/lib/index.js', 352, 'const live = this.ctx.sessions.get(sessionId);', '★history 读路径 live-preferred'],
  ['dsh-session-query/lib/index.js', 353, 'if (live !== void 0) return this.live(live, projectionMode);', '★磁盘改写进不了宿主内存日志(故 resync 对热会话无效)'],
  ['dsh-session/lib/index.js', 1613, 'create(id, options) {', '宿主 SessionService 公开面:create'],
  ['dsh-session/lib/index.js', 1640, 'prepare(id, options) {', '公开面:prepare'],
  ['dsh-session/lib/index.js', 1694, 'enter(session) {', '公开面:enter'],
  ['dsh-session/lib/index.js', 1727, 'detachEntered(entry) {', '公开面:detachEntered(只摘除,不重读)'],
  ['dsh-session/lib/index.js', 1742, 'announce(session) {', '公开面:announce'],
  ['dsh-session/lib/index.js', 1792, 'async flush(session) {', '公开面:flush'],
  ['dsh-session/lib/index.js', 1821, 'get(id) {', '公开面:get'],
  ['dsh-session/lib/index.js', 1828, 'list() {', '公开面:list'],
  ['dsh-session/lib/index.js', 1847, 'fork(source, boundary, childSessionId) {', '公开面:fork'],
  // ── 任务1:客户端唯一可用的重读原语 + 声明面只有投影/列表刷新 ────────────────
  ['dsh-api-session-controller/lib/types/client/sessions/session.js', 402, 'async resync() {', '★客户端 Session.resync()(未进声明契约)'],
  ['dsh-api-session-controller/lib/types/client/sessions/service.js', 246, 'refreshProjections(sessionId) {', '声明面只有投影刷新'],
  ['dsh-api-session-controller/lib/types/client/sessions/service.js', 253, 'refresh() {', '声明面 refresh = refreshList'],
  ['dsh-cordis-client-runner/lib/client.js', 1311, 'refreshProjections(sessionId: SessionId): Promise<void>', '服务目录里声明的会话级刷新入口'],
]

/** 「没有重读接口」的**缺席**规则:方法声明形态的 reload/reread/invalidate 一处都没有。 */
const ABSENT_RELOAD_DECLS = [
  'dsh-session/lib/index.js',
  'dsh-api-session-controller/lib/types/client/sessions/session.js',
  'dsh-api-session-controller/lib/types/client/sessions/service.js',
]

describe.skipIf(!available)('平台契约取证 · 真正恢复的「重读」与子代理规则(逐字 文件:行号)', () => {
  it('每一条逐字依据都仍在原位(行号 + 内容双锁)', () => {
    const mismatches = []
    for (const [rel, line, needle, why] of CITATIONS) {
      const actual = lineAt(rel, line).trim()
      if (!actual.includes(needle)) {
        mismatches.push(`${rel}:${line} 期望含 ${JSON.stringify(needle)}(${why})\n  实际: ${actual.slice(0, 160)}`)
      }
    }
    expect(mismatches, `逐字依据漂移(宿主换版 ⇒ 重新核对并更新实现与注释):\n${mismatches.join('\n')}`).toEqual([])
  })

  it('★平台**没有**官方「会话日志重读/缓存失效」接口(缺席规则,三条线上都无方法声明)', () => {
    const found = []
    for (const rel of ABSENT_RELOAD_DECLS) {
      const source = read(rel)
      const matches = source.match(/^\s+(async )?(reload|reread|invalidate)[A-Za-z]*\(/gm) ?? []
      if (matches.length > 0) found.push(`${rel}: ${matches.join(' | ')}`)
    }
    expect(found, `若平台新增了重读接口,任务1 的「本地视图账本 + 尽力 resync」应改用官方入口:\n${found.join('\n')}`).toEqual([])
  })

  it('官方 ui-subagent:子代理会话规则没有第二套写法(唯一规则 = origin === "subagent")', () => {
    const source = read('dsh-client-ui-subagent/lib/client.js')
    expect(source).toMatch(/state\.byId\[sessionId\]\?\.origin === "subagent"/)
    // 反例规则(不得出现 parentSession/parentId 形态的"子代理"判定):它会把 fork 的
    // 普通会话误判成子代理 —— 我方 isSubagentSessionView 也刻意不采用。
    expect(/origin === "subagent"\s*\|\|/.test(source)).toBe(false)
  })

  it('会话作用域 slot 的 standard kit 真的含 sessionId/useSession/useSessions(源码级,不只是注释)', () => {
    const renderer = read('dsh-client-ui-renderer/lib/client.js')
    expect(renderer).toMatch(/function standardKit\(host, entry, scope, rootBinding, scopeBinding\)/)
    expect(renderer).toMatch(/const standard = standardProps\(scope, rootBinding, scopeBinding\)/)
    expect(renderer).toMatch(/\.\.\.standard,/)
    for (const rel of ['dsh-cordis-client-runner/lib/client.js']) {
      const source = read(rel)
      // 两个 slot 各自那份 standardProps 列表都要齐核心套件
      for (const needle of ['useSessions: UseSessions', 'useSession: SessionSnapshotSelector', 'sessionId: SessionId']) {
        expect(source.includes(`"${needle}",`), `${rel} 缺少 ${needle}`).toBe(true)
      }
    }
  })
})

// 环境不可用 ⇒ 不静默(打印原因,与其他"现役件"用例同纪律)。
if (!available) {
  describe('平台契约取证(skip 说明)', () => {
    it('缺少 DSH Desktop 解包目录 ⇒ 本文件整块 skip(不是"通过")', () => {
      console.warn(`[dsh-retrace] platform-contract: skip —— 未找到 ${APP_ROOT}`)
      expect(available).toBe(false)
    })
  })
}
