/**
 * test/close-guard-arming-matrix.test.js
 *
 * **武装决策真值表**——断言的是**行为**（"这一页到底会不会 `preventDefault`"），
 * 不是"文本里有没有写这句话"。
 *
 * 为什么单独一份（2026-09-19，用户点出的方法论问题）：
 *   「下游守得很严，上游已经在骗；断言覆盖的不能是**声称的**语义」。
 *   0.4.29 的教训正是这个形状：文本/判据都"写对了"，但**行为**在报告人那台壳上仍卡死
 *   （宿主把它判成浏览器页 ⇒ 客户端照旧武装）。文本锁（"README 里写了 X"）只能证明
 *   **声称**；这一份证明**决策**：把两端判据的全部组合穷举，逐格断言最终的"是否武装"。
 *
 * 两端判据（缺一不武装）：
 *   宿主侧 `guardSurfaceOf(ctx, headers, url)` → `quitVeto`
 *     ① 能力头 `x-dsh-desktop-renderer` ② 请求 UA 含 Electron ③ 请求 URL 含 `dsh-desktop-`
 *     ④ 宿主有桌面痕迹（→ unknown）
 *   客户端侧 `shouldArmNativeGate(snapshot, page)` → 页面 UA 含 Electron / URL 含标记 ⇒ 一票否决
 *
 * 最终武装 ⟺ 宿主回 `true` ∧ 客户端不否决。
 */
import { describe, it, expect } from 'vitest'
import { guardSurfaceOf, installSurfaceProbe, uninstallSurfaceProbe } from '../lib/close-guard.js'
import { shouldArmNativeGate } from '../lib/close-guard-client.js'

const ELECTRON_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) dsh-desktop/0.9.0 Chrome/126.0.6478.234 Electron/31.3.1 Safari/537.36'
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const DESKTOP_URL = '/api/plugins/retrace/runningState?token=abc&dsh-desktop-mode=advanced'
const PLAIN_URL = '/api/plugins/retrace/runningState'

/** 无桌面痕迹的宿主（报告人那台：纯 node.exe 跑 harness）+ 有桌面痕迹的宿主（2.x 壳）。 */
const PLAIN_HOST = { get: () => undefined }
const DESKTOP_HOST = { get: (n) => (n === 'desktopRuntime' ? {} : undefined) }

/** 页面侧环境（客户端读的 navigator/location）。 */
const ELECTRON_PAGE = { userAgent: ELECTRON_UA, href: `http://127.0.0.1:43120/${DESKTOP_URL}` }
const PLAIN_PAGE = { userAgent: BROWSER_UA, href: 'http://127.0.0.1:43120/' }

/** 让"跑测的 node 是不是 Electron"不参与判定（本机 pnpm 用的正是带 electron 字段的 node）。 */
function withPlainNode(fn) {
  const had = Object.prototype.hasOwnProperty.call(process.versions, 'electron')
  const before = process.versions.electron
  try {
    delete process.versions.electron
    return fn()
  } finally {
    if (had) process.versions.electron = before
    else delete process.versions.electron
  }
}

/** 最终决策：宿主怎么说 + 客户端是否否决。 */
function armed({ host = PLAIN_HOST, headers = {}, url = PLAIN_URL, page = PLAIN_PAGE } = {}) {
  return withPlainNode(() => {
    const { quitVeto } = guardSurfaceOf(host, headers, url)
    return shouldArmNativeGate({ quitVeto }, page)
  })
}

describe('武装决策真值表（行为锁,不是文本锁）', () => {
  it('★ 0.4.28 的死锁格：无任何桌面痕迹 + 页面 UA 含 Electron → 宿主说 true,**但最终不武装**', () => {
    // 这一格就是报告人复测仍卡死的形态：宿主错回 browser/true。
    const { quitVeto, surface } = withPlainNode(() => guardSurfaceOf(PLAIN_HOST, { 'user-agent': ELECTRON_UA }, PLAIN_URL))
    expect(surface).toBe('desktop-renderer') // 0.4.30 起宿主自己就判对了
    expect(quitVeto).toBe(false)
    expect(armed({ headers: { 'user-agent': ELECTRON_UA }, page: ELECTRON_PAGE })).toBe(false)
    // **即便宿主那一条错**(强行喂 true),客户端一票否决也必须挡住 —— 这是本格的关键断言
    expect(shouldArmNativeGate({ quitVeto: true }, ELECTRON_PAGE)).toBe(false)
  })

  it('穷举:宿主 16 种入参组合 × 两类页面 ⇒ 最终武装与否逐格符合判据（无例外）', () => {
    const rows = []
    for (const header of [false, true]) {
      for (const ua of [false, true]) {
        for (const urlMark of [false, true]) {
          for (const desktopHost of [false, true]) {
            const headers = {
              ...(header ? { 'x-dsh-desktop-renderer': 'tok' } : {}),
              ...(ua ? { 'user-agent': ELECTRON_UA } : { 'user-agent': BROWSER_UA }),
            }
            const url = urlMark ? DESKTOP_URL : PLAIN_URL
            const host = desktopHost ? DESKTOP_HOST : PLAIN_HOST
            rows.push({
              header, ua, urlMark, desktopHost,
              browserPageArmed: armed({ host, headers, url, page: PLAIN_PAGE }),
              electronPageArmed: armed({ host, headers, url, page: ELECTRON_PAGE }),
            })
          }
        }
      }
    }
    expect(rows).toHaveLength(16)

    for (const r of rows) {
      const label = `header=${r.header} ua=${r.ua} url=${r.urlMark} host=${r.desktopHost}`
      // ① 证据页(UA 含 Electron / URL 带标记)一律**不武装** —— 与宿主怎么判无关
      if (r.ua || r.urlMark) expect(r.electronPageArmed, `证据页不该武装: ${label}`).toBe(false)
      // ② 页面 UA 含 Electron 也一律不武装(客户端一票否决)
      expect(r.electronPageArmed, `页面含 Electron 不该武装: ${label}`).toBe(false)
      // ③ 普通浏览器页:只有"请求级证据全无 + 宿主无桌面痕迹"才武装(网页端保护)
      const expectBrowserArmed = !r.header && !r.ua && !r.urlMark && !r.desktopHost
      expect(r.browserPageArmed, `浏览器页武装判定不符: ${label}`).toBe(expectBrowserArmed)
    }
    // ④ 结构性结论:证据页武装数为 **0**(不是"某几格例外")
    expect(rows.filter((r) => r.electronPageArmed).length).toBe(0)
    // ⑤ 且普通浏览器页在"干净宿主 + 干净请求"那一格**必须**武装(否则 Web 保护被关掉)
    expect(rows.filter((r) => r.browserPageArmed).length).toBe(1)
  })

  it('对"声称"的反向锁:文案里写了 X,不构成 X 为真的证据(文本锁单列,不当行为证据)', () => {
    // 这一条是**方法论断言**:文本检查通过 ≠ 行为正确。
    // 用 0.4.28 的真实形态演示:文案可以完全"说对",而行为仍是"武装"。
    const claimsWording = '桌面端（DSH Desktop）一律不武装原生门'
    const behaviorWouldArm = (snapshot, page) => shouldArmNativeGate(snapshot, page)
    // ① 文案在(声称成立)
    expect(claimsWording.includes('一律不武装')).toBe(true)
    // ② 但若客户端没有一票否决,同样的"声称"下行为会是武装 ⇒ 文本不等于行为
    const withoutVeto = (snapshot) => snapshot?.quitVeto === true
    expect(withoutVeto({ quitVeto: true })).toBe(true)
    // ③ 有一票否决之后,同一输入才是"不武装"
    expect(behaviorWouldArm({ quitVeto: true }, ELECTRON_PAGE)).toBe(false)
    // ④ 反向:普通浏览器页 + 宿主 true ⇒ 仍然是武装(不是"一律不武装"那么简单)
    expect(behaviorWouldArm({ quitVeto: true }, PLAIN_PAGE)).toBe(true)
  })

  it('宿主说"未知"(null)时,页面再像浏览器也不武装(未知取安全侧)', () => {
    expect(armed({ host: DESKTOP_HOST, headers: { 'user-agent': BROWSER_UA }, page: PLAIN_PAGE })).toBe(false)
  })

  it('★ 每一条客户端腿都必须**单独**承重(宿主全说谎时也要挡得住)', () => {
    // 复核指出:我原来的矩阵与实现同一公式 ⇒ 抓不到客户端侧回归(M1/M2/M4/M8 全绿)。
    // 这一格把"每条腿单独有效"钉死:宿主回 true 时,任何一条客户端证据都要能否决。
    const page = (userAgent, href) => ({ userAgent, href })
    expect(shouldArmNativeGate({ quitVeto: true }, page(ELECTRON_UA, 'http://x/'))).toBe(false) // UA 腿
    expect(shouldArmNativeGate({ quitVeto: true }, page(BROWSER_UA, `http://x/${DESKTOP_URL}`))).toBe(false) // URL 腿
    expect(shouldArmNativeGate({ quitVeto: true }, page(ELECTRON_UA, `http://x/${DESKTOP_URL}`))).toBe(false) // 两条都真
    expect(shouldArmNativeGate({ quitVeto: true }, page(BROWSER_UA, 'http://x/'))).toBe(true) // 浏览器页正向
  })

  it('★ 载荷自相矛盾(surface 说桌面页、quitVeto 说 true)⇒ 客户端必须听 surface(不武装)', () => {
    expect(shouldArmNativeGate({ surface: 'desktop-renderer', quitVeto: true }, PLAIN_PAGE)).toBe(false)
    expect(shouldArmNativeGate({ surface: 'desktop-renderer', quitVeto: false }, PLAIN_PAGE)).toBe(false)
    // 反向:surface=unknown + browser 页 + 宿主 true ⇒ 仍按原语义武装(不误伤 Web)
    expect(shouldArmNativeGate({ surface: 'unknown', quitVeto: true }, PLAIN_PAGE)).toBe(true)
  })

  it('★ 页面标记的生产通道是 Referer(我们的轮询 URL 无 query ⇒ URL 腿打不着)', () => {
    // 轮询真实形状:GET /api/plugins/retrace/runningState(无 query)。
    const pollingUrl = '/api/plugins/retrace/runningState'
    // ① 直接给 URL 带标记:函数能过(但生产请求不会长这样)
    expect(withPlainNode(() => guardSurfaceOf(PLAIN_HOST, { 'user-agent': BROWSER_UA }, DESKTOP_URL)).surface)
      .toBe('desktop-renderer')
    // ② 真实轮询 URL + 无 Referer ⇒ 宿主只能靠别的判据(此处为 browser)
    expect(withPlainNode(() => guardSurfaceOf(PLAIN_HOST, { 'user-agent': BROWSER_UA }, pollingUrl)))
      .toEqual({ surface: 'browser', quitVeto: true })
    // ③ 真实轮询 URL + **Referer 带页面标记** ⇒ 宿主判桌面页(这才是生产可达的那条)
    const withReferer = withPlainNode(() => guardSurfaceOf(
      PLAIN_HOST,
      { 'user-agent': BROWSER_UA, referer: `http://127.0.0.1:43120/${DESKTOP_URL}` },
      pollingUrl,
    ))
    expect(withReferer).toEqual({ surface: 'desktop-renderer', quitVeto: false })
    // ④ 反向:Referer 是普通页面 ⇒ 不影响(仍按浏览器页处理)
    expect(withPlainNode(() => guardSurfaceOf(
      PLAIN_HOST,
      { 'user-agent': BROWSER_UA, referer: 'http://127.0.0.1:43120/' },
      pollingUrl,
    ))).toEqual({ surface: 'browser', quitVeto: true })
  })

  it('探针不改变决策:装上/卸下探针对同一格的结果一致', () => {
    const before = armed({ headers: { 'user-agent': ELECTRON_UA }, page: ELECTRON_PAGE })
    installSurfaceProbe(() => {})
    const during = armed({ headers: { 'user-agent': ELECTRON_UA }, page: ELECTRON_PAGE })
    uninstallSurfaceProbe()
    const after = armed({ headers: { 'user-agent': ELECTRON_UA }, page: ELECTRON_PAGE })
    expect([before, during, after]).toEqual([false, false, false])
  })
})
