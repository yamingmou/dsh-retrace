/**
 * dsh-retrace — lib/identity/dedupe.js
 *
 * 渲染数据源的**去重核心**（纯函数）：同一会话只产出一组谱系标识。
 *
 * 为什么需要：同一会话在渲染面上有多个数据来源（宿主 badgeMap 下发的规范码、
 * 标题里已 pin 的 `[谱系标识]`、侧栏注入层、兜底派生）。来源一多就会出现
 * 「一行两组码」或「同一会话两个码」。去重放在**数据层**做（纯函数、可测、幂等），
 * 渲染层只消费结果，避免各渲染点各写一份判断而互相打架。
 *
 * 去重键（单一实现）：`codeKeyOf(sessionId)` = 规范化 uuid（去 `session-` 前缀、
 * 小写）。同一会话的 `session-<uuid>` 与裸 uuid 两种形态折叠成同一个键；
 * 键**不是** code 字符串 —— 按 code 去重会把「同会话两来源」误当成两个会话。
 *
 * 幂等：本模块每个变换都把「已去重的输入」映到自身（对输出再跑一遍，结果逐字 /
 * 逐键相等）。调用方可放心在每次渲染/每次 scan 上重复应用。
 */
/**
 * 浏览器安全（本模块会进 lib/client.js 的 bundle，⛔ 不得 import 任何 node:* 模块或
 * 会拉 node 内建的模块 —— 曾经 import shortcode.js 导致 `build-client` 解析失败）：
 * uuid 归一在本文件内联，与 shortcode.uuidOf 同口径（提取 uuid → 去连字符小写；
 * 否则清洗 hex；再否则 trim+小写+去 session- 前缀）。
 */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

/** 标识组的字面形状（与渲染层既有口径一致：`[` + 4–24 个非空白非 `]` 字符 + `]`）。 */
export const CODE_GROUP_RE = /\[([^\]\s]{4,24})\]/g

/** 去重用的占位符（临时替换被折叠掉的重复组；对外文本不出现）。 */
const DROP = '\u0000'

/**
 * 去重键：同一会话的两种 id 形态 → 同一个键。
 * 可解析 id（含 uuid 段）⇒ 规范化 uuid；不可解析 ⇒ trim + 小写 + 去 `session-` 前缀。
 * @param {string} sessionId
 * @returns {string} 空串 = 无键（调用方跳过该条）
 */
export function codeKeyOf(sessionId) {
  const raw = String(sessionId ?? '').trim()
  if (raw === '') return ''
  const m = raw.match(UUID_RE)
  if (m) return m[0].replace(/-/g, '').toLowerCase()
  const cleaned = raw.replace(/[^0-9a-f]/gi, '').toLowerCase()
  if (cleaned.length >= 32) return cleaned.slice(0, 32)
  return raw.replace(/^session-/i, '').toLowerCase()
}

/** 归一化「要折叠的码」列表（大小写不敏感）。 */
function codeTargets(codes) {
  const arr = Array.isArray(codes) ? codes : (codes == null ? [] : [codes])
  const out = new Set()
  for (const c of arr) {
    const s = String(c ?? '').trim().toLowerCase()
    if (s !== '') out.add(s)
  }
  return out
}

/** 文本里是否含指定码的标识组（大小写不敏感）。 */
function hasCodeGroup(text, code) {
  const want = String(code ?? '').trim().toLowerCase()
  if (want === '') return false
  const re = new RegExp(CODE_GROUP_RE.source, 'g')
  let m
  while ((m = re.exec(String(text ?? ''))) !== null) {
    if (String(m[1]).toLowerCase() === want) return true
  }
  return false
}

/**
 * 文本级去重：**同一个码**的重复标识组只留一组（保留首次出现位置）。
 *
 * - `codes` 给定时只折叠这些码（其他 `[...]` 组原样保留，避免误删别的标识）；
 * - `codes` 省略/空 ⇒ 任何重复出现的 token 都只留一组（同名组折叠）；
 * - 幂等：对返回值再调用一次，结果逐字相等。
 *
 * @param {string} text
 * @param {string|string[]} [codes]
 * @returns {string}
 */
export function dedupeCodeText(text, codes = []) {
  const src = String(text ?? '')
  const targets = codeTargets(codes)
  const seen = new Set()
  const collapsed = src.replace(CODE_GROUP_RE, (matched, token) => {
    const key = String(token).toLowerCase()
    if (targets.size > 0 && !targets.has(key)) return matched
    if (seen.has(key)) return DROP
    seen.add(key)
    return matched
  })
  if (collapsed.indexOf(DROP) === -1) return src
  // 折叠掉占位符 + 其两侧的空白（含两侧都有空白时合并成一个空格）
  const out = collapsed.replace(new RegExp(`[ \\t]*${DROP}[ \\t]*`, 'g'), ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/^[ \t]+/, '')
    .replace(/[ \t]+$/, '')
  return out
}

/**
 * 渲染决策：**同一会话只出一组码**。返回交给渲染层的两部分：
 *   - `title`：去掉重复组后的标题文本（幂等）；
 *   - `badgeText`：`null` = 标题里已有该码 ⇒ **不再前置徽标**（只这一组）；
 *     `'[code]'` / `'[code] name'` = 标题没有码 ⇒ 由渲染层前置这一组。
 *
 * 幂等：`dedupeDisplay({ title: r.title, code, name })` 的 `title` 与 `r.title` 相同，
 * 且 `dedupeCodeText(r.title + (r.badgeText ?? ''), [code])` 逐字稳定。
 *
 * @param {{title?: string, code?: string, name?: string|null}} input
 * @returns {{title: string, badgeText: string|null}}
 */
export function dedupeDisplay({ title = '', code = '', name = null } = {}) {
  const titleIn = String(title ?? '')
  const codeStr = String(code ?? '').trim()
  if (codeStr === '') return { title: titleIn, badgeText: null }
  const titleOut = dedupeCodeText(titleIn, [codeStr])
  if (hasCodeGroup(titleOut, codeStr)) return { title: titleOut, badgeText: null }
  const nameStr = typeof name === 'string' ? name.trim() : ''
  return { title: titleOut, badgeText: nameStr === '' ? `[${codeStr}]` : `[${codeStr}] ${nameStr}` }
}

/**
 * 数据源级去重：同会话来多个来源（不同 id 形态 / 不同码）时只留一条。
 *
 * - 键 = `codeKeyOf(sessionId)`；
 * - 同键多条：`priority`（数值，默认 0）高者胜；同优先级取**先出现**者（顺序稳定）；
 * - 返回 Map 的迭代顺序 = 该键**首次出现**的顺序（幂等：对输出再跑，键序与值不变）。
 *
 * @param {Array<{sessionId?: string, id?: string, code?: string, priority?: number, rank?: number}>} entries
 * @param {{priorityOf?: (entry: object) => number}} [options]
 * @returns {Map<string, {sessionId: string, code: string}>}
 */
export function oneCodePerSession(entries, { priorityOf = null } = {}) {
  const chosen = new Map()   // key → { priority, value }
  for (const entry of entries ?? []) {
    if (!entry || typeof entry !== 'object') continue
    const sid = entry.sessionId ?? entry.id
    const code = String(entry.code ?? '').trim()
    if (sid == null || code === '') continue
    const key = codeKeyOf(sid)
    if (key === '') continue
    const rawPriority = priorityOf ? priorityOf(entry) : (entry.priority ?? entry.rank ?? 0)
    const priority = Number.isFinite(Number(rawPriority)) ? Number(rawPriority) : 0
    const prev = chosen.get(key)
    if (prev === undefined) {
      chosen.set(key, { priority, value: { sessionId: String(sid), code } })
      continue
    }
    if (priority > prev.priority) chosen.set(key, { priority, value: { sessionId: String(sid), code } })
  }
  const out = new Map()
  for (const [key, held] of chosen) out.set(key, held.value)
  return out
}

/**
 * 一组渲染数据源里的「一组码」：把 `oneCodePerSession` 的结果摊平成稳定数组
 * （key 序 + `{key, sessionId, code}`），便于渲染层直接遍历与快照比对。
 * 幂等：对同一数据源重复调用结果逐项相等（不依赖 Map 之外的隐式状态）。
 * @param {Array<object>} entries
 * @param {{priorityOf?: (entry: object) => number}} [options]
 * @returns {Array<{key: string, sessionId: string, code: string}>}
 */
export function dedupeCodeRows(entries, options = {}) {
  return [...oneCodePerSession(entries, options)].map(([key, v]) => ({ key, sessionId: v.sessionId, code: v.code }))
}
