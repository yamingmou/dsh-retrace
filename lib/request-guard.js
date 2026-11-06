/**
 * dsh-retrace — 请求边界（request origin）与调用方输入辅助。
 *
 * 插件路由 `/api/plugins/retrace/*` **无鉴权**，唯一真实的边界是"请求是否来自
 * loopback"（设计来源：外部 fork 0.4.79 的对抗性审计；此处按本仓风格重写，
 * 不整段搬运）。单看 Host 头不构成边界：本机任意进程都能伪造它，而 DNS-rebinding
 * 页面会让 Host 与 Origin **天然一致** —— 所以真正要查的是 **socket peer 地址**；
 * Host / Origin 只作为"是否浏览器、是否同源"的辅助证据。
 *
 * 本模块刻意零依赖（不 import 宿主运行时），传输层与测试可以共享同一套判定。
 */

/** IPv4/IPv6 回环地址（含 IPv4-mapped IPv6 形态，如 `::ffff:127.0.0.1` / `::ffff:7f00:1`）。 */
export function loopbackAddress(address) {
  if (typeof address !== 'string') return false
  let value = address.trim().toLowerCase()
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1)
  if (value === '::1') return true
  // 双栈宿主可能把 peer 渲染成十六进制映射形态（`::ffff:7f00:1`）；先折算成点分再判定，
  // 避免"合法的本机请求被当成外来请求"或反之。
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(value)
  if (mapped !== null) {
    const hi = Number.parseInt(mapped[1], 16)
    const lo = Number.parseInt(mapped[2], 16)
    return loopbackAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`)
  }
  if (value.startsWith('::ffff:')) return loopbackAddress(value.slice('::ffff:'.length))
  const parts = value.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Host 头 → 主机名（小写、去掉端口）；解析不了返回空串。 */
export function hostNameOf(host) {
  if (typeof host !== 'string' || host.length === 0) return ''
  try {
    // URL.hostname keeps IPv6 brackets (`[::1]`); normalize to bare form so loopback checks match.
    return new URL(`http://${host}`).hostname.toLowerCase().replace(/^\[|\]$/g, '')
  } catch {
    return ''
  }
}

/** Host/Origin 主机名是否在本机回环名单里（`localhost` 与明文回环 IP）。 */
export function isLoopbackHostName(name) {
  return name === 'localhost' || name === '127.0.0.1' || name === '::1'
}

/** `DSH_RETRACE_ALLOW_REMOTE=1` ⇒ 显式放行隧道/LAN（保持旧"任意来源"行为的逃生门）。 */
export function remoteAllowed() {
  return process.env.DSH_RETRACE_ALLOW_REMOTE === '1'
}

/**
 * Loopback 请求闸。fail-closed：socket peer 取不到（或不是回环）即拒；Host 头还须
 * 指向本机回环（伪造 Host 从别的接口进来时，peer 与 Host 至少有一项对不上）。
 * @param {{ socket?: { remoteAddress?: string }, headers?: Record<string, string|undefined> }} req
 */
export function isLoopbackRequest(req, { allowRemote = false } = {}) {
  if (allowRemote) return true
  const peer = req?.socket?.remoteAddress
  if (!loopbackAddress(peer)) return false
  return isLoopbackHostName(hostNameOf(req?.headers?.host))
}

/** 各 scheme 的默认端口（URL 会把默认端口归一化为空串，比对前要补回来）。 */
const DEFAULT_PORTS = { 'http:': '80', 'https:': '443' }

/**
 * 同源闸：浏览器请求带 Origin 时，它必须与 Host **同源**（同主机名 + 同端口）。
 * 回环判定不在这里重复 —— Host 闸（isLoopbackRequest）已经保证 Host 指向本机；
 * 隧道/LAN 由宿主 opt-in 后，Origin 与 Host 同源即可通过。
 * 非浏览器客户端（curl / 测试 / 服务端调用）不带 Origin —— 合法性由 Host 闸保证，
 * 这里放行；`Origin: null`、file://、跨站页面则一律拒。
 * @param {string|undefined} origin 请求头 Origin
 * @param {string|undefined} hostHeader 请求头 Host
 */
export function originAllowed(origin, hostHeader) {
  if (typeof origin !== 'string' || origin.length === 0) return true
  let parsed
  let host
  try {
    parsed = new URL(origin)
    host = new URL(`http://${String(hostHeader ?? '').trim()}`)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  if (parsed.hostname.toLowerCase() !== host.hostname.toLowerCase()) return false
  // Host 头不带 scheme：缺端口时按 http 默认端口理解，再与 Origin 的有效端口比对。
  const originPort = parsed.port || DEFAULT_PORTS[parsed.protocol] || ''
  const hostPort = host.port || DEFAULT_PORTS['http:']
  return originPort === hostPort
}

/**
 * fold 端点区间校验：端点必须是**原始安全整数**，不接受 `Number()` 强转 ——
 * `Number(null) === 0`、`Number('') === 0`、`Number(true) === 1` 曾把"缺参/坏参"
 * 折叠成 seq 0（把首节点折掉）。`end` 允许缺省（自动边界，合法行为不变）；
 * 缺省时 `requireEnd` 为 true 的调用方（如 foldPreview）按非法处理。
 */
export function isFoldRange(args, { requireEnd = false } = {}) {
  if (args === null || typeof args !== 'object') return false
  if (!Number.isSafeInteger(args.start) || args.start < 0) return false
  if (!Object.prototype.hasOwnProperty.call(args, 'end') || args.end === undefined) return !requireEnd
  return Number.isSafeInteger(args.end) && args.end >= args.start
}

/**
 * 丢弃调用方自带的 `span`：span 决定 marker 替换的 surface 区间，客户端提供时
 * 可绕开宿主侧的 rollback-share 预检（只数 `sourceEventSeqs.length`）。宿主始终
 * 从会话日志重算 span，故 HTTP 入口不接受调用方给的区间。
 */
export function withoutClientSpan(args) {
  if (args === null || typeof args !== 'object' || !Object.prototype.hasOwnProperty.call(args, 'span')) return args
  const next = { ...args }
  delete next.span
  return next
}
