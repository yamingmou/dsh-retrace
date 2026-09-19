/**
 * dsh-retrace · test/close-guard-desktop-quit.test.js
 *
 * 外部 issue #1（桌面端托盘「退出」死锁）的**装配层**回归：
 *
 *  桌面 Electron 页面 ⇒ `onBeforeUnload` **不调用** `preventDefault`；
 *  普通浏览器页面   ⇒ 同一条 handler 仍然拦（`kind='running'` 与 `kind='idle'` 都拦）。
 *
 * 这里跑的是**真的** `apply()` + **真的** `onBeforeUnload`（client.js 里的 DOM 装配），
 * 只把 `window`/`document` 换成最小假件（仓库没有 jsdom，先例见 test/mini-react.js）。
 * 关闭守卫是 DOM-only（不走 React），所以不需要渲染器也能接线。
 *
 * 现场依据：安装好的 DSH Desktop（2.0.9）`app.asar` 全文检索 `will-prevent-unload`
 * 0 命中 ⇒ 页面里的否决在桌面端是**静默**的（既拦不住退出、也不弹任何界面），
 * 于是「武装原生门」只在普通浏览器页面上才是有意义的动作。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, __setMessageEditorWire } from '../lib/client.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

// ---------------------------------------------------------------------------
// 最小假 DOM（只覆盖关闭守卫与 apply 用到的面）
// ---------------------------------------------------------------------------
function makeElement(tag) {
  return {
    tagName: String(tag).toUpperCase(),
    children: [],
    firstChild: null,
    style: {},
    dataset: {},
    className: '',
    id: '',
    type: '',
    title: '',
    textContent: '',
    isConnected: false,
    offsetHeight: 24,
    appendChild(child) {
      this.children.push(child)
      if (this.firstChild === null) this.firstChild = child
      child.parentNode = this
      if (this.tagName === 'BODY') child.isConnected = true
      return child
    },
    remove() { this.isConnected = false },
    querySelector(selector) {
      const want = String(selector).replace(/^\./, '').split(/\s+/)[0]
      const stack = [...this.children]
      while (stack.length > 0) {
        const node = stack.shift()
        if (String(node.className ?? '').split(/\s+/).includes(want)) return node
        stack.push(...(node.children ?? []))
      }
      return null
    },
    addEventListener() {},
    removeEventListener() {},
    getBoundingClientRect() { return { width: 100, height: 24 } },
    focus() {},
  }
}

function installFakeDom() {
  const listeners = new Map()
  const add = (map, type, fn) => {
    const list = map.get(type) ?? []
    list.push(fn)
    map.set(type, list)
  }
  const body = makeElement('body')
  body.isConnected = true
  const head = makeElement('head')
  const intervals = []
  const docListeners = new Map()

  const document = {
    head,
    body,
    visibilityState: 'visible',
    createElement: (tag) => makeElement(tag),
    createTextNode: (text) => ({ nodeType: 3, textContent: text }),
    querySelector: () => null,
    getElementById: () => null,
    addEventListener: (type, fn) => add(docListeners, type, fn),
    removeEventListener: () => {},
  }
  const window = {
    addEventListener: (type, fn) => add(listeners, type, fn),
    removeEventListener: () => {},
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length },
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    close: vi.fn(),
  }
  vi.stubGlobal('window', window)
  vi.stubGlobal('document', document)
  return {
    // [0] = client.js 的原生门(桌面不武装);[1] = 自绘确认门(桌面真正拦下的那条)。
    beforeUnload: () => (listeners.get('beforeunload') ?? [])[0],
    beforeUnloadAll: () => listeners.get('beforeunload') ?? [],
    intervals,
    document,
    window,
  }
}

function makeCtx() {
  return {
    effect: (fn) => {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    locale: { register: () => () => {}, bind: () => (key) => key },
    get: () => undefined,
    inject: (names, callback) => { callback({ get: () => undefined }); return () => {} },
    slots: { inject: (seat, callback) => { callback(); return () => {} }, register: () => () => {} },
  }
}

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }

/**
 * 起一个"宿主快照 = payload"的客户端，返回已接线的 beforeunload handler。
 * `payload` 形状 = runningState 载荷(`{ running, surface, quitVeto }`)。
 * `page` = 页面自身环境(`{ userAgent, href }`);省略 = 不注入(等于"看不出桌面痕迹")。
 */
async function mountAssembly(payload, page) {
  const dom = installFakeDom()
  if (page) {
    // 页面自身证据读的是全局 navigator / location(见 close-guard-client 的
    // pageEnvironment);这里按真实浏览器那样把它们挂到全局。
    vi.stubGlobal('navigator', { userAgent: page.userAgent ?? '' })
    vi.stubGlobal('location', { href: page.href ?? '' })
  }
  __setMessageEditorWire((op) => {
    // 两个传输通道的回包都是信封 { ok, value }(见 client.js refresh())。
    if (op === 'runningState') return Promise.resolve({ ok: true, value: payload })
    return Promise.resolve({ ok: true })
  })
  apply(makeCtx())
  await flush()
  const all = dom.beforeUnloadAll()
  expect(all.length).toBe(2) // ① client.js 原生门 ② 自绘确认门
  expect(typeof all[0]).toBe('function') // 装配失败(抛错被 catch)会让这里先红
  return { handler: all[0], all, dom }
}

/** 旧签名的薄包装:返回 [0](client.js 原生门),既有用例语义不变。 */
async function mountGuard(payload, page) {
  return (await mountAssembly(payload, page)).handler
}

const runningPayload = () => ({
  running: [{ sessionId: 's1', reasons: ['agent-running'] }],
  surface: 'browser',
  quitVeto: true,
})

/** 页面自身证据的两个样本(与 close-guard-client.test.js 同源)。 */
const ELECTRON_PAGE = { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) dsh-desktop/0.9.0 Chrome/126.0.6478.234 Electron/31.3.1 Safari/537.36', href: 'http://127.0.0.1:43120/' }
const PLAIN_PAGE = { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', href: 'http://127.0.0.1:43120/' }
const DESKTOP_URL_PAGE = { userAgent: PLAIN_PAGE.userAgent, href: 'http://127.0.0.1:43120/?token=abc&dsh-desktop-mode=advanced' }

let warnSpy
beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  // onBeforeUnload 的 running 分支用**裸** setTimeout 弹明细模态;假定时器保证它
  // 不在 DOM 已被撤走的下一个宏任务里炸(不推进时间 ⇒ 回调不跑)。
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
})
afterEach(() => {
  vi.useRealTimers()
  __setMessageEditorWire(null)
  vi.unstubAllGlobals()
  warnSpy.mockRestore()
})

function fire(handler) {
  const event = { preventDefault: vi.fn(), returnValue: undefined }
  handler(event)
  return event
}

// ---------------------------------------------------------------------------
// 锁 0(2026-09-19 复核):真实装配有**两条** beforeunload 监听器 —— [0] = client.js
// 的原生门(桌面不武装),[1] = 自绘确认门(桌面真正拦下的那条)。此前用例只取 [0],
// 于是"桌面不武装"看着绿、真实装配的拦截没人测(假绿)。这里列出两条并断言**聚合**
// 行为:有任务 ⇒ 恰一条拦下(自绘门)且确认框在;无任务/隐藏 ⇒ 两条都不拦。
// ---------------------------------------------------------------------------
describe('真实装配两条监听器:桌面端谁在拦(复核假绿修复)', () => {
  const byClass = (root, cls) => {
    const stack = [...(root?.children ?? [])]
    while (stack.length > 0) {
      const node = stack.shift()
      if (String(node.className ?? '').split(/\s+/).includes(cls)) return node
      stack.push(...(node.children ?? []))
    }
    return null
  }
  const modalOf = (doc) => (doc.body.children ?? []).find((child) => child.id === 'dsh-rt-guard-modal')
  const fireAll = (all) => {
    const event = { preventDefault: vi.fn(), returnValue: undefined }
    for (const fn of all) fn(event)
    return event
  }

  it('有任务 + 桌面页 + 可见:[0] 原生门不拦;两条聚合恰一条拦(自绘门)+确认框在;确认后真的退', async () => {
    const { all, dom } = await mountAssembly(runningPayload(), ELECTRON_PAGE)
    expect(fire(all[0]).preventDefault).not.toHaveBeenCalled() // [0] = client.js 原生门:桌面不武装(旧锁仍真)
    const event = fireAll(all)
    expect(event.preventDefault).toHaveBeenCalledTimes(1)      // 真正拦下的是 [1] 自绘门,恰好一条
    const modal = modalOf(dom.document)
    expect(modal).toBeTruthy()
    byClass(modal, 'dsh-rt-guard-btn-primary').onclick()       // [仍要关闭]
    expect(dom.window.close).toHaveBeenCalledTimes(1)          // 放行 = 真的再关一次
    expect(fireAll(all).preventDefault).not.toHaveBeenCalled() // 二次关闭两条都放行
  })

  it('无任务 + 桌面页:两条都不拦(判据 3 不打扰)', async () => {
    const { all, dom } = await mountAssembly({ running: [], surface: 'desktop-renderer', quitVeto: false }, ELECTRON_PAGE)
    expect(fireAll(all).preventDefault).not.toHaveBeenCalled()
    expect(modalOf(dom.document)).toBeFalsy()
  })

  it('隐藏窗 + 有任务 + 桌面页:两条都不拦(复核 ④:隐藏页定时器会节流,不拿退出赌看门狗)', async () => {
    const { all, dom } = await mountAssembly(runningPayload(), ELECTRON_PAGE)
    dom.document.visibilityState = 'hidden'
    expect(fireAll(all).preventDefault).not.toHaveBeenCalled()
    expect(modalOf(dom.document)).toBeFalsy()
  })
})

// ---------------------------------------------------------------------------
// 锁 1：桌面 / 无承载面 ⇒ 不 preventDefault([0] 原生门腿的单元锁;见锁 0 的聚合断言)
// ---------------------------------------------------------------------------
describe('桌面端不武装原生门（issue #1 核心修复）', () => {
  it('宿主回报 quitVeto=false（Desktop Electron 页面）→ running 会话也不 preventDefault', async () => {
    const handler = await mountGuard({ running: [{ sessionId: 's1', reasons: ['agent-running'] }], surface: 'desktop-renderer', quitVeto: false })
    const event = fire(handler)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(event.returnValue).toBe(undefined)
  })

  it('宿主回报中性态 quitVeto=null（拿不到请求证据 / 旧版桌面壳）→ 同样不武装（未知取安全侧）', async () => {
    const handler = await mountGuard({ running: [{ sessionId: 's1', reasons: ['unclosed-turn-1'] }], surface: 'unknown', quitVeto: null })
    expect(fire(handler).preventDefault).not.toHaveBeenCalled()
  })

  it('宿主的载荷里根本没有 quitVeto 字段（旧宿主）→ 不武装', async () => {
    const handler = await mountGuard({ running: [{ sessionId: 's1', reasons: ['jobs-1'] }] })
    expect(fire(handler).preventDefault).not.toHaveBeenCalled()
  })

  it('桌面端空闲会话也不拦（原实现对 kind=idle 同样无条件拦）', async () => {
    const handler = await mountGuard({ running: [], surface: 'desktop-renderer', quitVeto: false })
    expect(fire(handler).preventDefault).not.toHaveBeenCalled()
  })

  it('不武装 ≠ 停用守卫：桌面端仍然按运行中状态渲染运行中横幅', async () => {
    await mountGuard({ running: [{ sessionId: 's1', reasons: ['agent-running'] }], surface: 'desktop-renderer', quitVeto: false })
    const banner = globalThis.document.body.children.find((n) => n.id === 'dsh-rt-guard-banner')
    expect(banner).toBeTruthy()
    const head = banner.querySelector('.dsh-rt-guard-banner-head')
    // 假 DOM 不做 textContent 聚合(真实 DOM 才会):直接读那个文本子节点。
    expect(head.children[0].textContent).toContain('1')
    expect(head.children[0].textContent).toContain('running')
  })
})

// ---------------------------------------------------------------------------
// 锁 2：Web / 有承载面 ⇒ 仍然拦（回归）
// ---------------------------------------------------------------------------
describe('网页端仍然武装原生门（行为不变）', () => {
  it('quitVeto=true + kind=running → preventDefault 且写 returnValue', async () => {
    const handler = await mountGuard(runningPayload(), PLAIN_PAGE)
    const event = fire(handler)
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(event.returnValue).toBe('')
  })

  it('quitVeto=true + kind=idle → 仍然轻确认一次（preventDefault）', async () => {
    const handler = await mountGuard({ running: [], surface: 'browser', quitVeto: true }, PLAIN_PAGE)
    const event = fire(handler)
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(event.returnValue).toBe('')
  })

  it('载荷不带 quitVeto 但页面是普通浏览器页 → 仍不武装(宿主未知一律取安全侧)', async () => {
    const handler = await mountGuard({ running: [{ sessionId: 's1', reasons: ['agent-running'] }] }, PLAIN_PAGE)
    expect(fire(handler).preventDefault).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 锁 2b：客户端一票否决（2026-09-18 第二轮,issue #1 复测仍卡死）
//
// 第一轮修复只改了宿主判据;报告人那台壳三条宿主判据**全不成立** ⇒ 宿主错回
// `surface=browser, quitVeto=true` ⇒ 客户端照旧武装 ⇒ 仍然退不掉。这一组从
// **装配层**钉死:页面自己的 UA / URL 只要带桌面证据,一律不武装。
// ---------------------------------------------------------------------------
describe('客户端一票否决：宿主判错也不许把桌面端卡死（第二轮核心修复）', () => {
  it('★ 报告人现场回归:宿主回 surface=browser/quitVeto=true,页面 UA 含 Electron → 不 preventDefault', async () => {
    const handler = await mountGuard({ running: [{ sessionId: 's1', reasons: ['agent-running'] }], surface: 'browser', quitVeto: true }, ELECTRON_PAGE)
    const event = fire(handler)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(event.returnValue).toBe(undefined)
  })

  it('★ 空闲也会被拦的那种形态:running 空 + 宿主回 true + 页面 UA 含 Electron → 不 preventDefault', async () => {
    const handler = await mountGuard({ running: [], surface: 'browser', quitVeto: true }, ELECTRON_PAGE)
    expect(fire(handler).preventDefault).not.toHaveBeenCalled()
  })

  it('★ 页面 URL 带 dsh-desktop-(UA 看不出来) → 同样不 preventDefault', async () => {
    const handler = await mountGuard({ running: [], surface: 'browser', quitVeto: true }, DESKTOP_URL_PAGE)
    expect(fire(handler).preventDefault).not.toHaveBeenCalled()
  })

  it('一票否决 ≠ 停用守卫:桌面页仍然渲染运行中横幅', async () => {
    await mountGuard({ running: [{ sessionId: 's1', reasons: ['agent-running'] }], surface: 'browser', quitVeto: true }, ELECTRON_PAGE)
    const banner = globalThis.document.body.children.find((n) => n.id === 'dsh-rt-guard-banner')
    expect(banner).toBeTruthy()
  })

  it('变异锁:源码里装配层必须走 shouldArmNativeGate(不能用裸 quitVetoOf 当闸门)', () => {
    const src = readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8')
    expect(src).toContain('shouldArmNativeGate(store.get())')
    expect(src).not.toMatch(/if \(!quitVetoOf\(/)
    // 客户端模块必须导出两道判据(宿主值 + 页面证据)
    const mod = readFileSync(path.join(ROOT, 'lib', 'close-guard-client.js'), 'utf8')
    expect(mod).toContain('export function shouldArmNativeGate')
    expect(mod).toContain('export function clientDesktopEvidence')
  })
})
// ---------------------------------------------------------------------------
// 锁 3：对外文本与事实一致
//
// 两类失效，各一把锁：
//   (a) 把"未覆盖的路径"写成结论（旧病）：断言"桌面端退出不经过 beforeunload /
//       Desktop 不受影响"；
//   (b) **无限定地把某一条退出入口当成全部事实**（2026-09-18 对抗复核抓到的新病）：
//       "托盘退出…会触发页面 beforeunload" —— 对 2.0.9 是假的（托盘项走
//       requestQuit(0) → window.destroy() → app.exit(code)，不经过 beforeunload），
//       只有 0.9.0/Windows 那一类入口才走到它。
//   ⇒ 触发类断言必须**带版本/平台限定**（"0.9.0 一类入口…" / "by version/platform"），
//     否则判为无限定断言。
// ---------------------------------------------------------------------------

/** 承担对外文本职责的文件（`lib/http.js` 的公开路由文档也算对外面）。 */
const TEXT_SURFACES = [
  'README.md',
  'README.zh.md',
  'lib/close-guard-client.js',
  'lib/close-guard.js',
  'lib/client.js',
  'lib/http.js',
]

/**
 * 旧断言的特征串（= 把没覆盖到的路径当成结论）。
 * 刻意只收**断言措辞**，不收 API 名或普通词：
 *  - 不收"不受影响"这类在别处有正常用法的词（README.zh.md 的"安装/启动不受影响"）；
 *  - 不收 `window.destroy()` / `app.exit()` —— 修正后的文本**必须**引用它们来描述
 *    2.0.9 的真实路径，收 API 名会把正确文本判红（2026-09-18 复核修订）。
 */
const OLD_CLAIM_MARKERS = [
  '不触发页面 beforeunload',
  'beforeunload 不会触发',
  'beforeunload 不触发',
  'hook cannot fire',
  'destroys the window on quit',
  '宿主原生路径',
  'host-native path',
  'host exposes no plugin quit-veto seam',
  '未暴露',
  // 无限定触发断言的历史原句（详见 unqualifiedTriggerHits 的通用判定）
  '托盘退出走宿主 quit 路径、会触发页面',
  '托盘退出走宿主 quit 路径,该路径**会**触发',
  '该路径**会**触发页面',
  'tray quit goes through the host quit path and does trigger',
]

/**
 * 收集一段文本里命中的旧断言特征串。
 * 先去掉行内代码反引号:旧句子写的是"页面 `beforeunload` 不会触发",带反引号。
 */
function oldClaimHits(text) {
  const bare = String(text).replace(/`/g, '')
  return OLD_CLAIM_MARKERS.filter((marker) => bare.includes(marker.replace(/`/g, '')))
}

/** 版本/平台限定词：出现即视为"已限定为某一类入口"。 */
const VERSION_QUALIFIER_RE = /0\.9\.0|2\.0\.9|版本|随版本|按版本|version|platform|平台/i

/** 把一段字面量编成"容忍 markdown 强调/空白"的正则源（`会**触发` 也要认出来）。 */
function markdownTolerant(source) {
  return source
    .split('')
    .map((ch) => ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[\\s*_]{0,3}')
}
/**
 * 触发类动词（"beforeunload 会不会走到/被触发"的说法）。
 * 兼容 markdown 强调：线上文本写过 `该路径**会**触发页面`（会 ** 触发），
 * 朴素的 `会触发` 字面量会**漏判**（2026-09-18 复核自查抓到）。
 */
const TRIGGER_VERB_RE = new RegExp(
  [
    markdownTolerant('不会触发'), markdownTolerant('会触发'),
    markdownTolerant('会经过'), markdownTolerant('会走到'),
    markdownTolerant('does trigger'), markdownTolerant('does fire'), markdownTolerant('does reach'),
  ].join('|'),
  'gi',
)

/**
 * 无限定触发断言 = 说了"beforeunload 会/不会（被）触发/走到"，但**同一句**里没有
 * 版本/平台限定。
 *
 * 判据：先折叠空白（正文会折行，按行匹配会漏），再按句末标点切成句子，然后逐句
 * 要求"触发词 + `beforeunload` + 限定词"三者同句。
 *
 * 为什么按句而不是按固定半径：半径判定会被**邻近分句**的限定词连带赦免 —— 实测
 * （2026-09-18 复核自查）把 close-guard.js 里 0.9.0 那条改回无限定句后，紧邻的
 * 2.0.9 分句落在 ±100 半径内，半径版放行。改成同句判定后该变异必红。
 * 分隔符含 `:` / `：`（引子分句与列表项之间常用冒号），否则限定词会从上一分句
 * 漏过来；不含裸 `.`（`0.9.0` 里的点会被误切）：只在不夹数字处切。
 * @returns {string[]} 违规片段的描述（便于断言失败时定位）。
 */
function unqualifiedTriggerHits(text) {
  const flat = String(text).replace(/`/g, '').replace(/\s+/g, ' ')
  const sentences = flat.split(/(?<!\d)\.(?!\d)|[。；;！？?：:]/)
  const out = []
  for (const sentence of sentences) {
    if (!/beforeunload/i.test(sentence)) continue        // 不是在讲 beforeunload ⇒ 无关
    if (VERSION_QUALIFIER_RE.test(sentence)) continue    // 同句已限定
    for (const match of sentence.matchAll(TRIGGER_VERB_RE)) out.push(`${match[0]}@${sentence.indexOf(match[0])}`)
  }
  return out
}

/**
 * 每条触发断言都必须带版本/平台限定 —— 反向锁：删掉限定词（把文本改回无限定句）
 * 也要红。逐文件列出**必须存在**的限定事实（"按版本二选一"的那两半）。
 */
const VERSION_CONDITIONAL_FACTS = [
  { file: 'README.md', requires: [/0\.9\.0/, /2\.0\.9/, /by\s+version\/platform/i, /never\*{0,2}\s*arms/i] },
  { file: 'README.zh.md', requires: [/0\.9\.0/, /2\.0\.9/, /版本\/[\s*]{0,12}平台[\s*]{0,12}而变/, /一律不武装/] },
  { file: 'lib/close-guard-client.js', requires: [/0\.9\.0/, /2\.0\.9/, /版本\/[\s*]{0,12}平台[\s*]{0,12}而变/, /一律不武装/] },
  { file: 'lib/close-guard.js', requires: [/0\.9\.0/, /2\.0\.9/, /版本\/[\s*]{0,12}平台[\s*]{0,12}而变/, /一律不武装/] },
  { file: 'lib/client.js', requires: [/0\.9\.0/, /2\.0\.9/, /版本\/[\s*]{0,12}平台[\s*]{0,12}而变/, /never\*{0,2}\s*arms/i] },
  { file: 'lib/http.js', requires: [/0\.9\.0/, /2\.0\.9/, /版本\/[\s*]{0,12}平台[\s*]{0,12}而变/] },
]

const readRepoFile = (rel) => readFileSync(path.join(ROOT, rel), 'utf8')
/** 折叠空白 + 去 markdown 引用前缀（折行/引用位置变化不该让内容断言假红）。 */
const readFlat = (rel) => readRepoFile(rel).replace(/`/g, '').replace(/\s+/g, ' ').replace(/>\s?/g, '')

describe('对外文本不再把未覆盖的路径写成结论', () => {
  it('对外文本都不含旧断言（桌面"不触发/不受影响"式结论）', () => {
    for (const rel of TEXT_SURFACES) {
      expect({ file: rel, hits: oldClaimHits(readRepoFile(rel)) }).toEqual({ file: rel, hits: [] })
    }
  })

  it('触发类断言一律带版本/平台限定（不再把某一条入口当成全部事实）', () => {
    for (const rel of TEXT_SURFACES) {
      expect({ file: rel, hits: unqualifiedTriggerHits(readRepoFile(rel)) }).toEqual({ file: rel, hits: [] })
    }
  })

  it('对外文本都写明了"壳未处理 will-prevent-unload / 退出入口随版本而变 / 桌面端不武装宿主原生确认框(改自绘门)"', () => {
    for (const rel of ['README.md', 'README.zh.md', 'lib/close-guard-client.js']) {
      const text = readRepoFile(rel)
      expect({ file: rel, hasFact: text.includes('will-prevent-unload') }).toEqual({ file: rel, hasFact: true })
      expect({ file: rel, hasBeforeUnload: text.includes('beforeunload') }).toEqual({ file: rel, hasBeforeUnload: true })
    }
    // README 是折行的 markdown（还带 `> ` 引用前缀）⇒ 内容断言一律在"折叠空白 +
    // 去引用前缀"的视图上做，避免折行位置一变就假红。
    // 2026-09-20 口径更正：桌面端**不武装的是宿主原生确认框**；真正生效的是**页面自绘确认门**
    //（它确实会 preventDefault）。下面两句钉的就是更正后的措辞。
    expect(readFlat('README.md')).toContain("desktop never arms the host's native confirm dialog")
    expect(readFlat('README.zh.md')).toContain('**桌面端一律不武装宿主原生确认框**')
    // 新增事实锁：自绘确认门 + "壳不经过页面"的已知限制（少了任一条都要红）
    expect(readFlat('README.zh.md')).toContain('页面自绘确认门')
    expect(readFlat('README.zh.md')).toContain('壳提供 seam')
    expect(readFlat('README.md')).toContain('page-drawn confirm gate')
    expect(readFlat('README.md')).toContain('needs a shell seam')
    // 短码/名字那条也得上对外文本（0.4.31 已上线）
    expect(readFlat('README.zh.md')).toContain('opxxxopxxx')
    expect(readFlat('README.md')).toContain('opxxxopxxx')
    // 2026-09-18（对抗复核追加）：文本必须写明"退出入口随版本/平台而变"，
    // 而不是把某一条入口（app.quit / app.exit）当作全部事实 —— 这正是本 issue 的病因。
    expect(readFlat('README.md')).toContain('by version/platform')
    expect(readFlat('README.zh.md')).toContain('退出入口随版本/平台而变')
    expect(readFlat('lib/close-guard-client.js')).toContain('退出入口随版本/平台而变')
  })

  it('"按版本二选一"的事实逐文件钉住（删掉限定词/删掉任一半都要红）', () => {
    for (const { file, requires } of VERSION_CONDITIONAL_FACTS) {
      // 折行 + markdown 引用前缀（`> `）都不该让"限定事实"判红。
      const flat = readRepoFile(file).replace(/`/g, '').replace(/\s+/g, ' ').replace(/>\s?/g, '')
      for (const re of requires) {
        expect({ file, re: String(re), hit: re.test(flat) }).toEqual({ file, re: String(re), hit: true })
      }
    }
  })

  it('检测器非空转：旧句子与无限定句都必须被认出来（否则"0 命中"等于没测）', () => {
    expect(oldClaimHits('> Desktop note: the Electron shell destroys the window on quit, so the page-level\n> `beforeunload` hook cannot fire there')).toEqual([
      'hook cannot fire',
      'destroys the window on quit',
    ])
    expect(oldClaimHits('桌面版应用退出为宿主原生路径，见运行中横幅提示')).toEqual(['宿主原生路径'])
    expect(oldClaimHits('套用旧措辞：退出路径 beforeunload 不会触发')).toEqual(['beforeunload 不会触发'])
    expect(oldClaimHits('桌面版（DSH Desktop）的托盘退出走宿主 quit 路径、会触发页面 beforeunload，而桌面壳未处理 will-prevent-unload'))
      .toContain('托盘退出走宿主 quit 路径、会触发页面')
    // 触发类断言的通用判定：
    expect(unqualifiedTriggerHits('托盘退出走宿主 quit 路径、会触发页面 beforeunload，而桌面壳未处理 will-prevent-unload')).not.toEqual([])
    expect(unqualifiedTriggerHits('the tray quit goes through the host quit path and does trigger page beforeunload')).not.toEqual([])
    expect(unqualifiedTriggerHits('② DSH Desktop 托盘退出走宿主 quit 路径,该路径**会**触发页面 `beforeunload`;')).not.toEqual([])
    // 邻近分句的限定词不得赦免（半径判定会放行 ⇒ 这条样本专门钉住"按句判定"）：
    expect(unqualifiedTriggerHits('0.9.0 版本上会触发页面 beforeunload;而这里托盘退出会触发页面 beforeunload')).not.toEqual([])
    // 限定版必须放行（否则锁会逼着人删掉正确文本）：
    expect(unqualifiedTriggerHits('外部报告的 DSH Desktop 0.9.0 / Windows 那一类入口会触发页面 beforeunload ⇒ 否决被静默吞掉')).toEqual([])
    expect(unqualifiedTriggerHits('the 0.9.0-class entry in the external report does reach page beforeunload')).toEqual([])
    expect(unqualifiedTriggerHits('在会走到 beforeunload 的那类版本上，preventDefault 是静默的')).toEqual([])
  })

  it('设置项文案与横幅文案：桌面端不武装的是"宿主原生框"，改用页面自绘确认门(锁随行为一起改)', () => {
    const client = readRepoFile('lib/client.js')
    const flat = client.replace(/`/g, '').replace(/\s+/g, ' ')
    // 新口径:不武装的是宿主原生确认框那条路;桌面改用**页面自绘确认门**,并写明
    // 看门狗兜底(worker 计时器,不受后台节流)与"先画框可见才拦"。
    expect(flat).toContain('桌面端（DSH Desktop）不武装**宿主原生确认框**那条路')
    expect(flat).toContain('页面自绘确认门')
    expect(flat).toContain('Web Worker 计时器，不受后台节流')
    expect(flat).toContain('Desktop (DSH Desktop) never arms the host native dialog path')
    expect(flat).toContain('page-drawn confirm gate')
    expect(client).toContain('桌面端用页面自绘确认框;若未弹出,以此横幅为准')
    expect(client).toContain('Desktop uses a page-drawn confirm dialog')
    // 旧文案（把桌面退出写成"宿主原生路径"）不得复活
    expect(oldClaimHits(client)).toEqual([])
  })

  // -------------------------------------------------------------------------
  // 第二轮（2026-09-18 复测仍卡死）：两道判据 + 自救开关，都要有文本、且要能被验
  // -------------------------------------------------------------------------
  it('第二轮事实逐条钉住：两道判据 / 请求级证据（含 Referer）/ 自救开关（删任一即红）', () => {
    // ① 设置项文案必须给出自救开关（报告人正是靠它先恢复的）
    const client = readRepoFile('lib/client.js')
    expect(client).toContain('桌面端退不掉时先关这一项')
    expect(client).toMatch(/turn this off first/i)
    // ② 两条判据都要写出来（宿主"不反对" + 客户端一票否决）
    const flatClient = client.replace(/`/g, '').replace(/\s+/g, ' ')
    expect(flatClient).toContain('判据是两道')
    expect(flatClient).toContain('一票否决')
    expect(flatClient).toMatch(/no Electron in the UA, no dsh-desktop- in the URL/i)
    // ③ README（中/英）都要写明补了什么判据、为什么（"完全没有证据"曾被归成浏览器页）
    const zh = readRepoFile('README.zh.md').replace(/`/g, '').replace(/\s+/g, ' ').replace(/>\s?/g, '')
    expect(zh).toContain('两道判据都成立才武装')
    expect(zh).toContain('一票否决')
    expect(zh).toContain('dsh-desktop-')
    expect(zh).toContain('完全没有证据')
    expect(zh).toContain('Referer')  // 生产可达的那条通道必须在文本里写明
    expect(zh).toContain('桌面端退不掉时')
    const en = readRepoFile('README.md').replace(/`/g, '').replace(/\s+/g, ' ').replace(/>\s?/g, '')
    expect(en).toContain('Both criteria must hold')
    expect(en.toLowerCase()).toContain('veto')
    expect(en).toContain('dsh-desktop-')
    expect(en).toContain('no evidence at all')
    expect(en).toMatch(/Referer/i)
    expect(en).toMatch(/turning off .*close guard.*recovers/i)
  })

  it('第二轮判据的源码出口必须在（删掉判据函数即红）', () => {
    const host = readRepoFile('lib/close-guard.js')
    expect(host).toContain('export function isElectronRequest')
    expect(host).toContain('export function hasDesktopUrlMark')
    expect(host).toContain('export function surfaceEvidenceOf')
    expect(host).toContain('export function installSurfaceProbe')
    // 探针必须按组合去重（否则客户端 5s 轮询会把宿主日志刷爆）
    expect(host).toContain('surfaceProbeSeen')
    const clientSide = readRepoFile('lib/close-guard-client.js')
    expect(clientSide).toContain('export function clientDesktopEvidence')
    expect(clientSide).toContain('export function shouldArmNativeGate')
    expect(clientSide).toContain("CLIENT_DESKTOP_URL_MARK = 'dsh-desktop-'")
  })
})
