/**
 * dsh-retrace — test/close-guard-client.test.js
 * 关闭守卫 V2客户端纯逻辑层:reason 解析/本地化文案/快照判定/
 * 运行中清单/放行标记。
 */
import { describe, it, expect } from 'vitest'
import {
  parseReason,
  describeReason,
  sessionLine,
  runningLines,
  classifySnapshot,
  isStale,
  buildRunningCopy,
  createGuardStore,
  clientDesktopEvidence,
  shouldArmNativeGate,
  quitVetoOf,
  GUARD_ARM_TTL_MS,
  GUARD_POLL_MS,
} from '../lib/close-guard-client.js'

describe('close-guard-client parseReason(host reason 形状,对齐)', () => {
  it('识别四种官方 reason', () => {
    expect(parseReason('agent-running')).toEqual({ code: 'agent-running' })
    expect(parseReason('queued-2')).toEqual({ code: 'queued', count: 2 })
    expect(parseReason('jobs-1')).toEqual({ code: 'jobs', count: 1 })
    expect(parseReason('unclosed-turn-1,3')).toEqual({ code: 'unclosed-turn', turns: [1, 3] })
  })

  it('未知形状兜底不崩(未来 host 新增 reason)', () => {
    expect(parseReason('something-new-7')).toEqual({ code: 'other', raw: 'something-new-7' })
    expect(parseReason(undefined)).toEqual({ code: 'other', raw: '' })
  })
})

describe('close-guard-client describeReason(本地化文案)', () => {
  it('zh 文案', () => {
    expect(describeReason('agent-running', 'zh')).toBe('正在运行')
    expect(describeReason('queued-2', 'zh')).toBe('排队待办 2 条')
    expect(describeReason('jobs-1', 'zh')).toBe('后台任务 1 个')
    expect(describeReason('unclosed-turn-1,3', 'zh')).toBe('未闭合轮次 1、3')
  })

  it('en 文案', () => {
    expect(describeReason('agent-running', 'en')).toBe('agent running')
    expect(describeReason('queued-2', 'en')).toBe('2 queued')
    expect(describeReason('jobs-2', 'en')).toBe('2 background jobs')
    expect(describeReason('jobs-1', 'en')).toBe('1 background job')
    expect(describeReason('unclosed-turn-1,3', 'en')).toBe('unclosed turn 1,3')
  })

  it('未知 reason 回显原文', () => {
    expect(describeReason('wat-9', 'zh')).toBe('wat-9')
  })
})

describe('close-guard-client sessionLine/runningLines(A 明细聚合)', () => {
  it('单会话一行:会话 id + 各原因', () => {
    expect(sessionLine({ sessionId: 's1', reasons: ['agent-running', 'jobs-1'] }, { locale: 'zh' }))
      .toBe('- 会话 s1: 正在运行; 后台任务 1 个')
    expect(sessionLine({ sessionId: 's1', reasons: ['queued-2'] }, { locale: 'en' }))
      .toBe('- session s1: 2 queued')
  })

  it('label 覆盖原始 id(UI 传短码)', () => {
    expect(sessionLine({ sessionId: 'a-very-long-id', reasons: ['agent-running'] }, { locale: 'zh', label: 'zz065zz016' }))
      .toBe('- 会话 zz065zz016: 正在运行')
  })

  it('reasons 缺失兜底不崩', () => {
    expect(sessionLine({ sessionId: 's1' }, { locale: 'zh' })).toBe('- 会话 s1: 运行中(原因未识别)')
  })

  it('runningLines 多会话聚合(labelOf 逐会话短码)', () => {
    const running = [
      { sessionId: 'aaa', reasons: ['agent-running'] },
      { sessionId: 'bbb', reasons: ['jobs-2', 'unclosed-turn-5'] },
    ]
    const labelOf = (id) => (id === 'aaa' ? 'zz001' : 'zz002')
    const lines = runningLines(running, { locale: 'zh', labelOf })
    expect(lines).toEqual([
      '- 会话 zz001: 正在运行',
      '- 会话 zz002: 后台任务 2 个; 未闭合轮次 5',
    ])
  })
})

describe('close-guard-client classifySnapshot/isStale(beforeunload 同步判定)', () => {
  it('null/未同步 → unknown(不打扰);空清单 → idle;有运行 → running', () => {
    expect(classifySnapshot(null)).toBe('unknown')
    expect(classifySnapshot({})).toBe('unknown')
    expect(classifySnapshot({ running: [] })).toBe('idle')
    expect(classifySnapshot({ running: [{ sessionId: 's1', reasons: ['agent-running'] }] })).toBe('running')
  })

  it('TTL 只影响 stale 提示,不影响 A/B 判定', () => {
    const now = 1000000
    const fresh = { running: [], at: now - 1000 }
    expect(isStale(fresh, { ttlMs: 5000, now })).toBe(false)
    expect(isStale({ ...fresh, at: now - 60000 }, { ttlMs: 5000, now })).toBe(true)
    // 无 at(手动快照)→ 视为过期,但分类仍按内容
    expect(isStale({ running: [] }, { ttlMs: 5000, now })).toBe(true)
  })
})

describe('close-guard-client buildRunningCopy(A 文案,规格草案可微调)', () => {
  const snapshot = {
    running: [
      { sessionId: 's1', reasons: ['agent-running'] },
      { sessionId: 's2', reasons: ['queued-2', 'jobs-1'] },
    ],
    at: Date.now(),
  }

  it('head 含会话计数 + 每会话明细行', () => {
    const copy = buildRunningCopy(snapshot, { locale: 'zh' })
    expect(copy.head).toContain('2 个会话存在运行中任务')
    expect(copy.lines).toHaveLength(2)
    expect(copy.lines[0]).toContain('正在运行')
    expect(copy.lines[1]).toContain('排队待办 2 条')
  })

  it('过期快照附带 stale 提示(文案诚实:状态可能已变化)', () => {
    const stale = buildRunningCopy(
      { running: snapshot.running, at: Date.now() - 60000 },
      { locale: 'zh', ttlMs: 5000 },
    )
    expect(stale.stale).toBe(true)
    expect(stale.hint).toContain('可能已变化')
    const fresh = buildRunningCopy(snapshot, { locale: 'zh', ttlMs: 5000 })
    expect(fresh.stale).toBe(false)
  })
})

describe('close-guard-client createGuardStore(放行标记:二次触发语义)', () => {
  it('arm 后短时内放行,超 GUARD_ARM_TTL_MS 重新确认', () => {
    let t = 1
    const store = createGuardStore({ now: () => t })
    expect(store.isArmed()).toBe(false)
    store.arm()
    expect(store.isArmed()).toBe(true)
    t = GUARD_ARM_TTL_MS + 2
    expect(store.isArmed()).toBe(false)
  })

  it('disarm/状态复位清除放行;快照 set/get 保留 at 时间戳', () => {
    const store = createGuardStore({ now: () => 42 })
    store.set({ running: [{ sessionId: 's1', reasons: ['agent-running'] }] })
    expect(store.get().running).toHaveLength(1)
    expect(store.get().at).toBe(42)
    store.arm()
    store.disarm()
    expect(store.isArmed()).toBe(false)
  })
})

describe('close-guard-client 轮询常量(与装配一致)', () => {
  it('GUARD_POLL_MS 为 5s(beforeunload 前状态最多落后一轮)', () => {
    expect(GUARD_POLL_MS).toBe(5000)
  })
})

// ---------------------------------------------------------------------------
// 客户端一票否决(2026-09-18 第二轮,issue #1 复测仍卡死)
//
// 现场:报告人那台壳三条宿主判据全不成立 ⇒ 宿主错回 `surface=browser, quitVeto=true`
// ⇒ 客户端照旧武装 ⇒ 仍然退不掉。⇒ 页面**自己**的两条属性(UA / URL)成为最后一道。
// 下面每一格都是变异锁:删掉对应判据必红。
// ---------------------------------------------------------------------------
const ELECTRON_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) dsh-desktop/0.9.0 Chrome/126.0.6478.234 Electron/31.3.1 Safari/537.36'
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const DESKTOP_HREF = 'http://127.0.0.1:43120/?token=abc&dsh-desktop-mode=advanced&dsh-desktop-platform=win32'
const BROWSER_HREF = 'http://127.0.0.1:43120/'

describe('close-guard-client clientDesktopEvidence(页面自身证据)', () => {
  it('UA 含 Electron / URL 含 dsh-desktop- 各自成立;普通浏览器页两条都不成立', () => {
    expect(clientDesktopEvidence({ userAgent: ELECTRON_UA, href: BROWSER_HREF }))
      .toEqual({ electronUa: true, urlMark: false, desktop: true })
    expect(clientDesktopEvidence({ userAgent: BROWSER_UA, href: DESKTOP_HREF }))
      .toEqual({ electronUa: false, urlMark: true, desktop: true })
    expect(clientDesktopEvidence({ userAgent: BROWSER_UA, href: BROWSER_HREF }))
      .toEqual({ electronUa: false, urlMark: false, desktop: false })
    // 缺字段/形状不对不抛(装配层拿到什么就喂什么)
    expect(clientDesktopEvidence({})).toEqual({ electronUa: false, urlMark: false, desktop: false })
    expect(clientDesktopEvidence({ userAgent: null, href: 42 })).toEqual({ electronUa: false, urlMark: false, desktop: false })
    // 大小写不敏感(Electron 段大小写各版本都出现过)
    expect(clientDesktopEvidence({ userAgent: 'x electron/31' }).desktop).toBe(true)
  })
})

describe('close-guard-client shouldArmNativeGate(宿主 + 客户端两道都真才武装)', () => {
  it('★ 报告人现场回归:宿主错回 quitVeto=true,但页面 UA 含 Electron → 不武装', () => {
    const snapshot = { running: [], surface: 'browser', quitVeto: true }
    expect(quitVetoOf(snapshot)).toBe(true) // 宿主那条确实说了"可以"
    expect(shouldArmNativeGate(snapshot, { userAgent: ELECTRON_UA, href: BROWSER_HREF })).toBe(false)
  })

  it('★ 宿主错回 quitVeto=true,但页面 URL 带 dsh-desktop- → 不武装', () => {
    expect(shouldArmNativeGate({ running: [], surface: 'browser', quitVeto: true },
      { userAgent: BROWSER_UA, href: DESKTOP_HREF })).toBe(false)
  })

  it('正向对照:普通浏览器页(无 Electron、无标记)+ quitVeto=true → 武装(网页端保护不变)', () => {
    expect(shouldArmNativeGate({ running: [], surface: 'browser', quitVeto: true },
      { userAgent: BROWSER_UA, href: BROWSER_HREF })).toBe(true)
  })

  it('宿主那条不成立时,页面再像浏览器也不武装(false/null/缺字段)', () => {
    const page = { userAgent: BROWSER_UA, href: BROWSER_HREF }
    expect(shouldArmNativeGate({ quitVeto: false }, page)).toBe(false)
    expect(shouldArmNativeGate({ quitVeto: null }, page)).toBe(false)
    expect(shouldArmNativeGate({}, page)).toBe(false)
    expect(shouldArmNativeGate(undefined, page)).toBe(false)
  })
})

describe('close-guard-client 自绘确认门:纯决策与上报', () => {
  it('planBeforeUnload:只有"运行中 + 桌面页"才拦;其余一律放行(阴性对照)', async () => {
    const { planBeforeUnload } = await import('../lib/close-guard-client.js')
    const running = { running: [{ sessionId: 's1', reasons: ['agent-running'] }] }
    expect(planBeforeUnload(running, { desktop: true })).toEqual({ action: 'gate', reason: 'running-desktop' })
    // 无任务 ⇒ 直接关,不打扰(判据 3)
    expect(planBeforeUnload({ running: [] }, { desktop: true })).toEqual({ action: 'allow', reason: 'no-running' })
    // 状态未知(宿主读不到)⇒ 不打扰
    expect(planBeforeUnload(null, { desktop: true })).toEqual({ action: 'allow', reason: 'state-unknown' })
    // 非桌面页 ⇒ 交给 client.js 的原生确认门(浏览器)
    expect(planBeforeUnload(running, { desktop: false })).toEqual({ action: 'allow', reason: 'browser-native-gate' })
    // 已放行 / 守卫关闭 ⇒ 放行
    expect(planBeforeUnload(running, { desktop: true, armed: true })).toEqual({ action: 'allow', reason: 'armed' })
    expect(planBeforeUnload(running, { desktop: true, enabled: false })).toEqual({ action: 'allow', reason: 'disabled' })
    // 页面不可见 ⇒ 不拦(隐藏窗没有可点的确认框,且隐藏页定时器会被节流;判据 ④)
    expect(planBeforeUnload(running, { desktop: true, visible: false })).toEqual({ action: 'allow', reason: 'hidden' })
  })

  it('runningCountOf / gateEnabled(直读配置,失败默认开)', async () => {
    const { runningCountOf, gateEnabled } = await import('../lib/close-guard-client.js')
    expect(runningCountOf({ running: [1, 2, 3] })).toBe(3)
    expect(runningCountOf(null)).toBe(0)
    expect(gateEnabled({ getItem: () => null })).toBe(true)
    expect(gateEnabled({ getItem: () => JSON.stringify({ closeGuard: false }) })).toBe(false)
    expect(gateEnabled({ getItem: () => JSON.stringify({ closeGuard: true }) })).toBe(true)
    expect(gateEnabled({ getItem: () => '{bad json' })).toBe(true)
    expect(gateEnabled({ getItem: () => { throw new Error('blocked') } })).toBe(true)
  })

  it('reportGateEvent:搭既有 runningState 通道且 keepalive(关闭瞬间也发得出);失败不抛', async () => {
    const { reportGateEvent } = await import('../lib/close-guard-client.js')
    const calls = []
    reportGateEvent('intercept', { surface: 'desktop-renderer', running: 2 }, (url, init) => { calls.push({ url, init }); return Promise.resolve({}) })
    expect(calls[0].url).toContain('/api/plugins/retrace/runningState?')
    expect(calls[0].url).toContain('closeGuardEvent=intercept')
    expect(calls[0].url).toContain('surface=desktop-renderer')
    expect(calls[0].url).toContain('running=2')
    expect(calls[0].init.keepalive).toBe(true)
    expect(() => reportGateEvent('release', {}, () => { throw new Error('offline') })).not.toThrow()
    expect(() => reportGateEvent('release', {}, undefined)).not.toThrow()
  })
})
