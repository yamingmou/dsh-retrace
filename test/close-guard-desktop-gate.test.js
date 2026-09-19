/**
 * test/close-guard-desktop-gate.test.js
 *
 * 关闭守卫:**桌面壳自绘确认门**的行为锁。
 *
 * 锁的是用户五条判据里最容易假绿的四条(全部走**真的** beforeunload handler):
 *   ① 有任务 ⇒ 拦下 + 出现可点确认框(取消 / 仍要关闭);
 *   ② 确认[仍要关闭] ⇒ 放行(arm + close,二次 beforeunload 直接过)——**不许卡死**;
 *   ③ 无任务 ⇒ 直接放行,不弹框、不 prevent;
 *   ④ 注入/渲染失败 ⇒ 看门狗放行(宁可不拦,不许卡死)。
 * 外加装配级集成:`lib/client.js` 的**真 apply** 走一遍(证明"接线 → 真的执行"),不依赖
 * 构建产物(本件按约定不触碰生成物;产物由发放行方统一重建)。
 */
import { describe, it, expect, vi } from 'vitest'
import { GATE_MODAL_ID, GATE_WATCHDOG_MS, installDesktopGate } from '../lib/close-guard-client.js'
import { apply } from '../lib/client.js'

const ELECTRON_PAGE = { userAgent: 'Mozilla/5.0 Electron/43.3.0 Safari/537.36', href: 'http://127.0.0.1:43120/' }
const BROWSER_PAGE = { userAgent: 'Mozilla/5.0 (Macintosh) Chrome/150.0.0.0 Safari/537.36', href: 'http://127.0.0.1:43120/' }
const runningSnapshot = (n = 1) => ({ running: Array.from({ length: n }, (_, i) => ({ sessionId: `session-fixture-${i}`, reasons: ['agent-running'] })) })

// ---------------------------------------------------------------------------
// 最小假 DOM(元素可点、有尺寸、有 isConnected)
// ---------------------------------------------------------------------------
function makeEl(tag) {
  return {
    tagName: String(tag).toUpperCase(),
    children: [],
    style: { cssText: '' },
    dataset: {},
    id: '',
    type: '',
    textContent: '',
    isConnected: false,
    focused: false,
    offsetHeight: 24,
    onclick: null,
    appendChild(child) { this.children.push(child); child.parentNode = this; if (this.tagName === 'BODY') child.isConnected = true; return child },
    remove() { this.isConnected = false; if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((c) => c !== this) },
    setAttribute() {},
    getBoundingClientRect() { return { width: this.visible === false ? 0 : 100, height: 40 } },
    focus() { this.focused = true },
  }
}
function makeDom() {
  const winListeners = new Map()
  const docListeners = new Map()
  const body = makeEl('body')
  body.isConnected = true
  const doc = {
    body,
    head: makeEl('head'),
    visibilityState: 'visible',
    createElement: (tag) => makeEl(tag),
    createTextNode: (t) => ({ textContent: t }),
    querySelector: () => null,
    addEventListener(type, fn) { docListeners.set(type, [...(docListeners.get(type) ?? []), fn]) },
    removeEventListener(type, fn) { docListeners.set(type, (docListeners.get(type) ?? []).filter((f) => f !== fn)) },
  }
  const win = {
    navigator: { language: 'zh-CN' },
    addEventListener(type, fn) { winListeners.set(type, [...(winListeners.get(type) ?? []), fn]) },
    removeEventListener(type, fn) { winListeners.set(type, (winListeners.get(type) ?? []).filter((f) => f !== fn)) },
    setTimeout: (fn, ms) => { win.__timers.push({ fn, ms }); return win.__timers.length },
    clearTimeout: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
    close: vi.fn(),
    __timers: [],
  }
  const fireBeforeUnload = () => {
    const event = { preventDefault: vi.fn(), returnValue: undefined }
    for (const fn of winListeners.get('beforeunload') ?? []) fn(event)
    return event
  }
  const fireVisibility = (state) => {
    doc.visibilityState = state
    for (const fn of docListeners.get('visibilitychange') ?? []) fn()
  }
  const fireKeydown = (key) => {
    for (const fn of docListeners.get('keydown') ?? []) fn({ key })
  }
  return { win, doc, body, fireBeforeUnload, fireVisibility, fireKeydown, click: (el) => el.onclick?.({ target: el }) }
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
const findById = (body, id) => body.children.find((c) => c.id === id)
const buttonsOf = (overlay) => {
  const out = []
  const walk = (node) => { for (const child of node.children ?? []) { if (child.tagName === 'BUTTON') out.push(child); walk(child) } }
  walk(overlay)
  return out
}

describe('桌面自绘确认门:装/拦/确认/取消/失败放行', () => {
  let reports
  const makeGate = (dom, snapshot, { enabled = true, page = ELECTRON_PAGE } = {}) => {
    reports = []
    const store = { snapshot, armed: false, get: () => snapshot, arm() { this.armed = true }, isArmed() { return this.armed } }
    const uninstall = installDesktopGate({
      win: dom.win,
      doc: dom.doc,
      store,
      page: () => page,
      enabled: () => enabled,
      report: (event, extra) => reports.push({ event, extra }),
      timers: { setTimeout: dom.win.setTimeout, clearTimeout: dom.win.clearTimeout },
    })
    return { store, uninstall }
  }

  it('① 有任务 + 桌面页 ⇒ preventDefault 且出现可点确认框([取消]/[仍要关闭])', () => {
    const dom = makeDom()
    makeGate(dom, runningSnapshot(2))
    const event = dom.fireBeforeUnload()
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(event.returnValue).toBe('')
    const overlay = findById(dom.body, GATE_MODAL_ID)
    expect(overlay).toBeTruthy()
    const buttons = buttonsOf(overlay)
    expect(buttons.map((b) => b.textContent)).toEqual(['取消', '仍要关闭'])
    expect(reports.map((r) => r.event)).toContain('intercept')
  })

  it('② 点[仍要关闭] ⇒ arm + close + 上报 release;二次 beforeunload 不再拦(真的放行)', () => {
    const dom = makeDom()
    const { store } = makeGate(dom, runningSnapshot(2))
    dom.fireBeforeUnload()
    dom.click(buttonsOf(findById(dom.body, GATE_MODAL_ID))[1])
    expect(store.armed).toBe(true)
    expect(dom.win.close).toHaveBeenCalledTimes(1)
    expect(reports.map((r) => r.event)).toContain('release')
    expect(findById(dom.body, GATE_MODAL_ID)).toBeFalsy()
    // 二次关闭手势:已放行 ⇒ 不拦(这就是"确认后真的退"的关键一步)
    const second = dom.fireBeforeUnload()
    expect(second.preventDefault).not.toHaveBeenCalled()
    // 关窗没生效时给下一步提示(渲染器不允许脚本关窗的兜底)
    const hintTimer = dom.win.__timers.find((t) => t.ms === 300)
    hintTimer.fn()
    const hint = findById(dom.body, 'dsh-rt-guard-toast')
    expect(hint?.textContent).toContain('请再点一次关闭')
  })

  it('③ 无任务 ⇒ 不拦、不弹框;仅留一条 allow-no-running 回执', () => {
    const dom = makeDom()
    makeGate(dom, { running: [] })
    const event = dom.fireBeforeUnload()
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(findById(dom.body, GATE_MODAL_ID)).toBeFalsy()
    expect(reports.map((r) => r.event)).toEqual(['gate-ready', 'allow-no-running'])
  })

  it('③b 守卫关闭 / 非桌面页 / 状态未知 ⇒ 一律放行(官方行为)', () => {
    for (const opts of [{ enabled: false }, { page: BROWSER_PAGE }]) {
      const dom = makeDom()
      makeGate(dom, runningSnapshot(2), opts)
      expect(dom.fireBeforeUnload().preventDefault).not.toHaveBeenCalled()
    }
    const dom = makeDom()
    makeGate(dom, null)
    expect(dom.fireBeforeUnload().preventDefault).not.toHaveBeenCalled()
  })

  it('④ 渲染失败(appendChild 抛) ⇒ **根本不拦**(主保险:没出口不 block),arm+close 放行', () => {
    const dom = makeDom()
    const { store } = makeGate(dom, runningSnapshot(1))
    dom.doc.body.appendChild = () => { throw new Error('inject failed') }
    const event = dom.fireBeforeUnload()
    expect(event.preventDefault).not.toHaveBeenCalled() // 不再出现"拦下但没出口"
    expect(store.armed).toBe(true)
    expect(dom.win.close).toHaveBeenCalledTimes(1)
    expect(reports.map((r) => r.event)).toContain('fail-soft-ui-not-rendered') // 情形 A:从未渲染
  })

  it('④c 页面不可见(hidden)⇒ 不拦、不弹框,留 allow-hidden 回执(看门狗被节流也不怕)', () => {
    const dom = makeDom()
    makeGate(dom, runningSnapshot(2))
    dom.doc.visibilityState = 'hidden'
    const event = dom.fireBeforeUnload()
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(findById(dom.body, GATE_MODAL_ID)).toBeFalsy()
    expect(reports.map((r) => r.event)).toEqual(['gate-ready', 'allow-hidden'])
  })

  it('④d 拦下后页面转隐藏(壳把窗藏了/被遮挡)⇒ 走隐藏放行,不再等看门狗', () => {
    const dom = makeDom()
    const { store } = makeGate(dom, runningSnapshot(1))
    dom.fireBeforeUnload()
    expect(store.armed).toBe(false)
    dom.fireVisibility('hidden')
    expect(store.armed).toBe(true)
    expect(dom.win.close).toHaveBeenCalledTimes(1)
    expect(reports.map((r) => r.event)).toContain('fail-soft-hidden')
  })

  it('④e 次保险优先 Web Worker(不受后台节流);worker 到点且框不在 ⇒ 放行', () => {
    const dom = makeDom()
    const worker = { onmessage: null, posted: [], postMessage(ms) { this.posted.push(ms) }, terminate: vi.fn() }
    const revoked = []
    dom.win.Worker = function Worker() { return worker }
    dom.win.Blob = function Blob(parts) { this.parts = parts }
    dom.win.URL = { createObjectURL: () => 'blob:gate', revokeObjectURL: (u) => revoked.push(u) }
    const { store } = makeGate(dom, runningSnapshot(1), { Worker: dom.win.Worker })
    dom.fireBeforeUnload()
    expect(worker.posted).toEqual([GATE_WATCHDOG_MS])      // 走的是 worker 计时器
    expect(dom.win.__timers.filter((t) => t.ms === GATE_WATCHDOG_MS)).toHaveLength(0) // 没走主线程
    findById(dom.body, GATE_MODAL_ID).remove()             // 框被撤走
    worker.onmessage()                                     // worker 到点
    expect(store.armed).toBe(true)
    expect(dom.win.close).toHaveBeenCalledTimes(1)
    expect(revoked).toContain('blob:gate')
    expect(reports.map((r) => r.event)).toContain('fail-soft-ui-gone') // 情形 B:渲染过但已消失
  })

  it('④g 框渲染过且在 ⇒ 看门狗**不放行**(只记 waiting);用户不点就一直等', () => {
    const dom = makeDom()
    const { store } = makeGate(dom, runningSnapshot(1))
    dom.fireBeforeUnload()
    const timer = dom.win.__timers.find((t) => t.ms === GATE_WATCHDOG_MS)
    expect(timer).toBeTruthy()
    timer.fn() // 看门狗到点:UI 还在
    expect(store.armed).toBe(false)                       // 没有放行
    expect(dom.win.close).not.toHaveBeenCalled()          // 没有自动关
    expect(findById(dom.body, GATE_MODAL_ID)).toBeTruthy() // UI 还在等
    expect(reports.map((r) => r.event)).toContain('waiting')
    expect(reports.map((r) => r.event)).not.toContain('fail-soft-ui-gone')
  })

  it('④h 键盘逃生:Esc 等同 [取消](不放行、不关窗,可退)', () => {
    const dom = makeDom()
    const { store } = makeGate(dom, runningSnapshot(1))
    dom.fireBeforeUnload()
    dom.fireKeydown('Escape')
    expect(store.armed).toBe(false)
    expect(dom.win.close).not.toHaveBeenCalled()
    expect(findById(dom.body, GATE_MODAL_ID)).toBeFalsy()
    expect(reports.map((r) => r.event)).toContain('cancel')
  })

  it('④f 拿不到 Worker(CSP 拒绝)⇒ 退回主线程计时器,功能不退', () => {
    const dom = makeDom()
    dom.win.Worker = function Worker() { throw new Error('blocked by CSP') }
    dom.win.Blob = function Blob() {}
    dom.win.URL = { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} }
    const { store } = makeGate(dom, runningSnapshot(1))
    dom.fireBeforeUnload()
    const timer = dom.win.__timers.find((t) => t.ms === GATE_WATCHDOG_MS)
    expect(timer).toBeTruthy()
    findById(dom.body, GATE_MODAL_ID).remove()
    timer.fn()
    expect(store.armed).toBe(true)
    expect(reports.map((r) => r.event)).toContain('fail-soft-ui-gone')
  })

  it('④b 画出来但不可见(高度 0)⇒ 主保险当场放行(不 block、不等看门狗)', () => {
    const dom = makeDom()
    const { store } = makeGate(dom, runningSnapshot(1))
    const original = dom.doc.createElement
    dom.doc.createElement = (tag) => { const el = original(tag); if (tag === 'div') el.offsetHeight = 0; return el }
    const event = dom.fireBeforeUnload()
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(store.armed).toBe(true)
    expect(dom.win.close).toHaveBeenCalledTimes(1)
    expect(reports.map((r) => r.event)).toContain('fail-soft-ui-not-rendered') // 情形 A:画了但不可见
  })

  it('取消:收掉确认框、不放行、不关窗;再次关闭仍受拦(保护还在)', () => {
    const dom = makeDom()
    const { store } = makeGate(dom, runningSnapshot(1))
    dom.fireBeforeUnload()
    dom.click(buttonsOf(findById(dom.body, GATE_MODAL_ID))[0])
    expect(store.armed).toBe(false)
    expect(dom.win.close).not.toHaveBeenCalled()
    expect(reports.map((r) => r.event)).toContain('cancel')
    expect(dom.fireBeforeUnload().preventDefault).toHaveBeenCalledTimes(1) // 再次关闭仍被拦
  })

  it('注入面缺失(window/document 拿不到)⇒ 空操作,绝不 throw(官方行为)', () => {
    expect(() => installDesktopGate({})).not.toThrow()
    expect(typeof installDesktopGate({ win: makeDom().win })).toBe('function')
  })

  it('幂等:同一 window 重复安装只挂一个监听(热重载不叠加)', () => {
    const dom = makeDom()
    makeGate(dom, runningSnapshot(1))
    makeGate(dom, runningSnapshot(1))
    const event = dom.fireBeforeUnload()
    expect(event.preventDefault).toHaveBeenCalledTimes(1) // 两个 handler 都跑就会是 2
  })
})

// ---------------------------------------------------------------------------
// 装配级集成:跑 client.js 的**真 apply**(不依赖构建产物,故本件不触碰生成物)
// 证明"接线 → 真的执行":createGuardStore 装门 → 有任务关闭 ⇒ 确认框 + 确认后放行,
// 且 client.js 自身的原生门在桌面页不武装(不重复拦)。
// ---------------------------------------------------------------------------
describe('client.js apply 装配集成(接线 → 真的执行)', () => {
  const makeCtx = () => ({
    effect: (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
    locale: { register: () => () => {}, bind: () => (key) => key },
    get: () => undefined,
    inject: (names, callback) => { callback({ get: () => undefined }); return () => {} },
    slots: { inject: (seat, callback) => { callback(); return () => {} }, register: () => () => {} },
  })

  it('apply 后:有任务关闭 ⇒ 自绘确认框;点仍要关闭 ⇒ close;二次关闭不再拦', async () => {
    const dom = makeDom()
    const fetchImpl = vi.fn(async () => ({ status: 200, json: async () => ({ ok: true, value: { running: runningSnapshot(1).running, surface: 'desktop-renderer', quitVeto: false } }) }))
    vi.stubGlobal('window', dom.win)
    vi.stubGlobal('document', dom.doc)
    vi.stubGlobal('navigator', { userAgent: ELECTRON_PAGE.userAgent, language: 'zh-CN' })
    vi.stubGlobal('location', { href: ELECTRON_PAGE.href })
    vi.stubGlobal('fetch', fetchImpl)
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} })
    try {
      apply(makeCtx())
      await flush() // 轮询拿到 running 快照 + 自绘门微任务安装
      expect(fetchImpl).toHaveBeenCalled()
      const event = dom.fireBeforeUnload()
      expect(event.preventDefault).toHaveBeenCalledTimes(1) // 自绘门拦下;client.js 原生门在桌面页不武装 ⇒ 不重复
      const overlay = findById(dom.body, GATE_MODAL_ID)
      expect(overlay).toBeTruthy()
      dom.click(buttonsOf(overlay)[1])
      expect(dom.win.close).toHaveBeenCalledTimes(1)
      expect(dom.fireBeforeUnload().preventDefault).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
