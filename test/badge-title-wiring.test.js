/**
 * dsh-retrace — 短码/名字展示层接线测试（B 步）。
 *
 * 覆盖 §B 三件：① 客户端真去调 `initBadgeTitles`；② `setBadgeTitle`
 * 不静默吞错；③ 名字取 `session/title` 日志真值（无事件 ⇒ 留空，不回落项目名）。
 *
 * ── 阴性对照（本文件的重点）────────────────────────────────────────────────
 * 每条正向断言旁边都有一条**喂坏的**用例：如果退回旧实现，对照必须转红。
 *   对照 ①（旧：cwd 项目名回落）—— 会话 cwd 有值但日志无 title 事件时，
 *       命名结果不得含项目名；旧实现会产出 `[op065] my-project` ⇒ 红。
 *   对照 ②（旧：客户端从不调 initBadgeTitles）—— 请求 op 名单里必须出现
 *       `initBadgeTitles`；旧实现该 op 永不出现 ⇒ 红。
 *   对照 ③（旧：`.catch(() => {})` 静默吞错）—— 宿主报错/请求抛错时必须有
 *       `clientReport` 上报；旧实现 0 上报 ⇒ 红。
 *
 * 客户端私有函数用 esbuild 在测试时打包**真实源码**再求值（与本仓
 * test/client-chat-hooks.test.js 同一手法），不改 lib/。
 */
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

vi.mock('react', () => ({
  Component: class { constructor(props) { this.props = props ?? {}; this.state = {} } setState() {} },
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useRef: (value) => ({ current: value }),
  useSyncExternalStore: (_s, get) => get(),
  Fragment: Symbol('react.fragment'),
}))

import { trueTitleOf, tagTitle, hasBadgeTitle } from '../lib/index.js'
import { __setMessageEditorWire } from '../lib/client.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLIENT_SOURCE_PATH = path.join(ROOT, 'lib', 'client.js')
const nodeRequire = createRequire(import.meta.url)

// 只追加两个**私有**函数；`__setMessageEditorWire` 本来就是 client.js 的公开导出，
// 会随打包一起出现在 bundle 的 exports 上（bundle 与 ESM import 是两个独立模块
// 实例，各自的 `wire` 互不相通 ⇒ 必须用 bundle 自己的设置器）。
const EXTRACTED = ['reportBadgeFailure', 'bootstrapBadgeTitles']
const fakeReact = {
  Component: class { constructor(props) { this.props = props ?? {}; this.state = {} } setState() {} },
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useRef: (value) => ({ current: value }),
}

let client
let clientSource

beforeAll(async () => {
  clientSource = readFileSync(CLIENT_SOURCE_PATH, 'utf8')
  for (const name of EXTRACTED) {
    expect(clientSource.includes(`function ${name}(`), `lib/client.js must declare ${name}`).toBe(true)
  }
  const bundled = await build({
    stdin: {
      contents: `${clientSource}\nexport { ${EXTRACTED.join(', ')} }\n`,
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
  const load = (id) => (id === 'react' ? fakeReact : nodeRequire(id))
  // eslint-disable-next-line no-new-func
  new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(load, mod, mod.exports)
  for (const name of EXTRACTED) expect(typeof mod.exports[name]).toBe('function')
  client = mod.exports
})

/** 真实短码形态：工作区2+序号3+父工作区2+父序号3 = 固定 10 位。 */
const BADGE = 'op065op016'

/** 记录型 wire：把每次 callOp 的 op 名与载荷存下来，按脚本给结果。 */
function recordingWire(script = {}) {
  const calls = []
  const wire = (op, payload) => {
    calls.push({ op, payload })
    const reply = script[op]
    if (typeof reply === 'function') return reply(op, payload)
    return Promise.resolve(reply ?? { ok: true })
  }
  return { wire, calls }
}

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms))

/** 合成会话：事件列表 + header.cwd（旧实现的项目名回落来源）。 */
const sessionWith = (events, cwd = '/home/user/my-project') => ({
  id: 'session-00000000-0000-4000-8000-cf4c4732fd3b',
  header: { cwd },
  events,
})

// ─────────────────────────────────────────────────────────────────────────────
describe('B③ 名称真值：session/title 日志，无事件则留空（不回落项目名）', () => {
  it('取最后一个 session/title 事件的值', () => {
    const session = sessionWith([
      { type: 'session/title', data: { title: '旧名字' } },
      { type: 'message', data: {} },
      { type: 'session/title', data: { title: '新名字' } },
    ])
    expect(trueTitleOf(session)).toBe('新名字')
  })

  it('阴性对照①：cwd 有项目名但日志无 title 事件 ⇒ 名字留空，结果不含项目名', () => {
    const session = sessionWith([{ type: 'message', data: { text: 'hi' } }], '/home/user/my-project')
    expect(trueTitleOf(session)).toBe('')
    const tagged = tagTitle(BADGE, trueTitleOf(session))
    // 旧实现会回落 cwd 基名 ⇒ '[op065op016] my-project' ⇒ 本条转红
    expect(tagged).toBe(`[${BADGE}]`)
    expect(tagged).not.toContain('my-project')
  })

  it('有真名字时正常拼接，且先剥掉旧短码前缀（不叠码）', () => {
    expect(tagTitle(BADGE, '项目讨论')).toBe(`[${BADGE}] 项目讨论`)
    expect(tagTitle(BADGE, `[${BADGE}] 项目讨论`)).toBe(`[${BADGE}] 项目讨论`)
    expect(tagTitle(BADGE, '[dx035dx034] 别的码')).toBe(`[${BADGE}] 别的码`)
    // 剥前缀的判据是「括号内 ≥6 个 [a-z0-9]」（旧版短码/正文里的短括号不误删）
    expect(tagTitle(BADGE, '[abc] 正文')).toBe(`[${BADGE}] [abc] 正文`)
  })

  it('幂等判据认 [badge] 与 [badge] 名称两种形态', () => {
    expect(hasBadgeTitle(BADGE, `[${BADGE}]`)).toBe(true)
    expect(hasBadgeTitle(BADGE, `[${BADGE}] 项目讨论`)).toBe(true)
    expect(hasBadgeTitle(BADGE, '[dx035dx034] 项目讨论')).toBe(false)
    expect(hasBadgeTitle(BADGE, '')).toBe(false)
  })

  it('结构化断言：三处调用点都走真值 helper，源码里不再有 cwd/项目名回落', () => {
    const source = readFileSync(path.join(ROOT, 'lib', 'index.js'), 'utf8')
    expect(source.includes('cwd.split')).toBe(false)
    expect((source.match(/trueTitleOf\(session\)/g) ?? []).length).toBeGreaterThanOrEqual(3)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('B① 客户端真去调 initBadgeTitles（阴性对照②：旧实现该 op 永不出现）', () => {
  it('阴性对照②：bootstrap 必须发出 initBadgeTitles 请求', async () => {
    const { wire, calls } = recordingWire({ initBadgeTitles: { ok: true, value: { total: 3 } } })
    client.__setMessageEditorWire(wire)
    const cancel = client.bootstrapBadgeTitles({ attempts: 1, delayMs: 1 })
    await tick(20)
    cancel()
    const ops = calls.map((c) => c.op)
    expect(ops).toContain('initBadgeTitles')
    // 成功时不得有多余上报
    expect(ops).not.toContain('clientReport')
    client.__setMessageEditorWire(null)
  })

  it('结构化断言：apply() 里挂了启动 bootstrap（挂 ctx.effect 以便卸载清理）', () => {
    expect(/ctx\.effect\(\(\) => bootstrapBadgeTitles\(\)/.test(clientSource)).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('B② 失败不静默（阴性对照③：旧实现 0 上报）', () => {
  it('阴性对照③-a：宿主返回 ok:false ⇒ 必须上报 clientReport', async () => {
    const { wire, calls } = recordingWire({
      initBadgeTitles: { ok: false, error: { code: 'boom', message: 'store not enumerable' } },
    })
    client.__setMessageEditorWire(wire)
    const cancel = client.bootstrapBadgeTitles({ attempts: 1, delayMs: 1 })
    await tick(20)
    cancel()
    const report = calls.find((c) => c.op === 'clientReport')
    expect(report).toBeTruthy()
    expect(String(report.payload?.source)).toContain('initBadgeTitles')
    expect(String(report.payload?.source)).toContain('store not enumerable')
    client.__setMessageEditorWire(null)
  })

  it('阴性对照③-b：请求抛错 ⇒ 必须上报 clientReport（重试计数写明）', async () => {
    const { wire, calls } = recordingWire({
      initBadgeTitles: () => Promise.reject(new Error('HTTP 503')),
    })
    client.__setMessageEditorWire(wire)
    const cancel = client.bootstrapBadgeTitles({ attempts: 2, delayMs: 1 })
    await tick(30)
    cancel()
    const reports = calls.filter((c) => c.op === 'clientReport')
    expect(reports.length).toBeGreaterThanOrEqual(1)
    expect(String(reports[0].payload?.source)).toContain('HTTP 503')
    // attempts=2 ⇒ 至少请求两次（退避重试真的发生）
    expect(calls.filter((c) => c.op === 'initBadgeTitles').length).toBeGreaterThanOrEqual(2)
    client.__setMessageEditorWire(null)
  })

  it('reportBadgeFailure 走 console.warn + clientReport 两条出口', () => {
    const { wire, calls } = recordingWire({})
    client.__setMessageEditorWire(wire)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    client.reportBadgeFailure('setBadgeTitle', new Error('rename failed'))
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
    expect(String(calls.find((c) => c.op === 'clientReport')?.payload?.source)).toContain('setBadgeTitle')
    expect(String(calls.find((c) => c.op === 'clientReport')?.payload?.source)).toContain('rename failed')
    client.__setMessageEditorWire(null)
  })

  it('结构化断言：setBadgeTitle/sessionBadge 调用点不再有 catch(() => {}) 静默吞错', () => {
    const badgeBlock = clientSource.slice(clientSource.indexOf("callOp('setBadgeTitle'"), clientSource.indexOf("callOp('setBadgeTitle'") + 900)
    expect(/catch\(\(\) => \{\}\)/.test(badgeBlock)).toBe(false)
    expect(badgeBlock).toContain('reportBadgeFailure')
  })
})
