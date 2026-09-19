/**
 * test/close-guard-r2-probes.test.js
 *
 * 第二轮对抗复核给出的 5 条**独立探针**(不是作者写的矩阵,用来抓作者锁抓不到的回归)。
 * 落库时按复核后的真实状态改写:探针 B 原本记录的是"载荷自相矛盾时仍武装"这个**洞**——
 * 0.4.30 已按复核建议修掉(客户端现在也看 `surface`),故 B 改为断言"不再武装"。
 * 保留下来的价值:①每条客户端腿**单独**承重 ②生产**可达性**(轮询 URL 无 query ⇒ 走 Referer)
 * ③残留未覆盖集合(六信号全假仍武装——这条是**已知边界**,不是缺陷)④探针去重。
 */
import { describe, it, expect } from 'vitest'
import { guardSurfaceOf, installSurfaceProbe, uninstallSurfaceProbe } from '../lib/close-guard.js'
import { shouldArmNativeGate } from '../lib/close-guard-client.js'

const ELECTRON_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) dsh-desktop/0.9.0 Chrome/126.0.6478.234 Electron/31.3.1 Safari/537.36'
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const plainNode = (fn) => {
  const had = Object.prototype.hasOwnProperty.call(process.versions, 'electron')
  const before = process.versions.electron
  try { delete process.versions.electron; return fn() } finally { if (had) process.versions.electron = before; else delete process.versions.electron }
}
const PLAIN_HOST = { get: () => undefined }
const MARKED = 'http://127.0.0.1:43120/?token=abc&dsh-desktop-mode=advanced'

describe('R2 extra probes', () => {
  it('A. each CLIENT leg is load-bearing on its own when the host lies (quitVeto=true)', () => {
    expect(shouldArmNativeGate({ quitVeto: true }, { userAgent: ELECTRON_UA, href: 'http://x/' })).toBe(false)
    expect(shouldArmNativeGate({ quitVeto: true }, { userAgent: BROWSER_UA, href: MARKED })).toBe(false)
    expect(shouldArmNativeGate({ quitVeto: true }, { userAgent: ELECTRON_UA, href: MARKED })).toBe(false)
    expect(shouldArmNativeGate({ quitVeto: true }, { userAgent: BROWSER_UA, href: 'http://x/' })).toBe(true)
  })

  it('B. 载荷自相矛盾(surface=desktop-renderer + quitVeto=true)⇒ 必须听 surface,不武装(复核发现的洞,已修)', () => {
    expect(shouldArmNativeGate({ surface: 'desktop-renderer', quitVeto: true }, { userAgent: BROWSER_UA, href: 'http://x/' })).toBe(false)
    // 反向:surface=unknown 不是"桌面页"证据,按原语义走(浏览器页 + 宿主 true ⇒ 武装)
    expect(shouldArmNativeGate({ surface: 'unknown', quitVeto: true }, { userAgent: BROWSER_UA, href: 'http://x/' })).toBe(true)
  })

  it('C. 轮询 URL 无 query ⇒ 宿主 URL 腿打不着;页面标记靠 Referer 与客户端腿兜', () => {
    const polling = '/api/plugins/retrace/runningState'
    const host = plainNode(() => guardSurfaceOf(PLAIN_HOST, { 'user-agent': BROWSER_UA }, polling))
    expect(host).toEqual({ surface: 'browser', quitVeto: true }) // 裸轮询:宿主判浏览器(如实)
    // ① 客户端腿兜住(页面 URL 有标记 ⇒ 不武装)
    expect(shouldArmNativeGate({ quitVeto: host.quitVeto }, { userAgent: BROWSER_UA, href: MARKED })).toBe(false)
    // ② 生产可达的那条:同一请求带 Referer(同源 fetch 默认行为)⇒ 宿主自己就判桌面页
    const withReferer = plainNode(() => guardSurfaceOf(PLAIN_HOST, { 'user-agent': BROWSER_UA, referer: MARKED }, polling))
    expect(withReferer).toEqual({ surface: 'desktop-renderer', quitVeto: false })
  })

  it('D. 【已知边界,非缺陷】六信号全假(UA 无 Electron、URL/Referer 无标记、无能力头、宿主无痕迹)⇒ 仍武装', () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) dsh-shell/3.1 Chrome/126.0.0.0 Safari/537.36'
    const host = plainNode(() => guardSurfaceOf(PLAIN_HOST, { 'user-agent': ua }, '/api/plugins/retrace/runningState'))
    expect(host).toEqual({ surface: 'browser', quitVeto: true })
    expect(shouldArmNativeGate({ quitVeto: host.quitVeto }, { userAgent: ua, href: 'http://127.0.0.1:43120/' })).toBe(true)
  })

  it('E. probe logs the same combo only once (second producer suppressed)', () => {
    const lines = []
    installSurfaceProbe((l) => lines.push(l))
    plainNode(() => guardSurfaceOf(PLAIN_HOST, { 'user-agent': BROWSER_UA }, '/api/plugins/retrace/runningState'))
    plainNode(() => guardSurfaceOf(PLAIN_HOST, { 'user-agent': BROWSER_UA }, '/api/plugins/retrace/runningState?sessionId=s9'))
    expect(lines.filter((l) => l.includes('承载面判定')).length).toBe(1)
    uninstallSurfaceProbe()
  })
})
