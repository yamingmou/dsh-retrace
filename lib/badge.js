/**
 * dsh-retrace — lib/badge.js
 *
 * 会话短码（identity badge）——2026-08-31 用户指定的小功能。
 *
 * 需求：与人交互时需要稳定的会话识别符（标题会变、session id 太长）。
 * 解法：**从 session id（唯一值）确定性导出短码**——不依赖全量扫描、
 * 不依赖外部短码表、插件运行时自算即可。同一 session id 永远得到同一短码。
 *
 * 与 `会话短码表.json`（工作区+序号语义格式 member-23member-01）的关系：
 * - 外部表 = 人工维护的语义短码（线名/父子关系可读），由维护线维护；
 * - 本模块 = 插件自算的确定性短码（人机交互兜底），任何环境可复现；
 * - 两者并存：铭牌优先显示外部语义短码（若可查），否则用本模块兜底。
 *
 * 算法：FNV-1a 64-bit（uuid 段）→ base36 → 固定 10 位（补 0）。
 * - 10 位纯字母数字（36^10 ≈ 3.6e15 空间，会话规模下碰撞可忽略）；
 * - 只依赖 id 本身，无状态、无 IO、纯函数（可测试、可在 client/host 复用）。
 */

/** 提取 id 中的 uuid 段（hex），无匹配则退回 hex 清洗。 */
export function uuidOf(id) {
  const text = String(id ?? '')
  const m = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
  if (m) return m[0].replace(/-/g, '').toLowerCase()
  const cleaned = text.replace(/[^0-9a-f]/gi, '').toLowerCase()
  return cleaned.length >= 8 ? cleaned.slice(0, 32) : ''
}

/** FNV-1a 64-bit（BigInt，避免精度丢失）。 */
export function fnv1a64(text) {
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const mask = 0xffffffffffffffffn
  for (let i = 0; i < text.length; i++) {
    hash ^= BigInt(text.charCodeAt(i))
    hash = (hash * prime) & mask
  }
  return hash
}

const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz'

/** BigInt → base36 字符串。 */
export function toBase36(value) {
  if (value < 0n) value = -value
  if (value === 0n) return '0'
  let out = ''
  let v = value
  while (v > 0n) {
    out = BASE36[Number(v % 36n)] + out
    v /= 36n
  }
  return out
}

/**
 * 会话短码：uuid 段 → FNV-1a 64 → base36 → 固定 10 位（补 0 截断）。
 * @param {string} sessionId - 会话 id（`session-<uuid>` 或裸 uuid）。
 * @returns {string} 10 位短码；无法提取 uuid 时返回空串（调用方自行兜底）。
 */
export function sessionBadge(sessionId) {
  const uuid = uuidOf(sessionId)
  if (uuid.length === 0) return ''
  return toBase36(fnv1a64(uuid)).padStart(10, '0').slice(0, 10)
}
