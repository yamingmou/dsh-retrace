/**
 * dsh-retrace — lib/adapter/dsh.js
 *
 * DSH 平台适配器(2026-09-01)——实现 EventReader 接口。
 *
 * 职责:从 DSH 会话文件(session.jsonl.zstd)读全量事件——可靠事实,
 * 不依赖 host 内存视图(DSH 2.0.3 host 的 session.events 可能稀疏/窗口化)。
 *
 * 换架构时:业务层(message-list.js/守卫)零改动,新平台实现自己的 EventReader
 * (读自己的日志格式 → 同样的通用事件结构)。
 */
import { readdirSync, accessSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** 找 DSH 会话文件路径(遍历 ~/.dsh/sessions 各工作区)。 */
export function sessionFilePath(sessionId) {
  const root = join(homedir(), '.dsh', 'sessions')
  for (const workspace of readdirSync(root)) {
    const candidate = join(root, workspace, String(sessionId), 'session.jsonl.zstd')
    try { accessSync(candidate); return candidate } catch { /* keep looking */ }
  }
  return null
}

/** 是否是真实的用户输入(轮边界)——排除 context/steering 注入。 */
export function isRoundBoundary(event) {
  return event?.type === 'user/message' && event?.data?.source?.kind === 'user'
}

/**
 * DSH 事件读取器:从文件读全量事件(通用事件结构)。
 * @returns {Promise<Array<{seq:number, type:string, turn?:number, data?:object, source?:object}>|null>}
 */
async function readEvents(sessionId) {
  const filePath = sessionFilePath(sessionId)
  return readEventsFromFile(filePath)
}

/** 从指定文件路径读全量事件(测试可注入路径;生产走 readEvents 找 ~/.dsh)。 */
async function readEventsFromFile(filePath) {
  try {
    if (!filePath) return null
    const { loadSessionLog } = await import('dsh-log-contract')
    const log = loadSessionLog(filePath)
    return log.events.map((r) => r.event)
  } catch { return null }
}

/**
 * 从全量事件计算遮蔽范围(业务逻辑,基于通用事件,与 DSH 无关)。
 * @param {Array} events - 全量事件(通用格式)。
 * @param {number|string} target - seq 或 messageId。
 * @param {'round'|'tail'} [mode] - round=遮蔽目标轮;tail=遮蔽目标之后(编辑 fromScratch)。
 */
export function computeSpan(events, target, mode = 'round') {
  if (!Array.isArray(events)) return null
  let seq = typeof target === 'number' ? target : -1
  if (seq === -1) {
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i]
      const id = ev?.type === 'user/message' ? ev.data?.id : ev?.type === 'assistant/message' ? ev.data?.message?.id : undefined
      if (typeof id === 'string' && id === target) { seq = ev.seq; break }
    }
  }
  if (seq === -1 || !events[seq]) return null
  // surface 节点 = user/assistant/tool 消息(近似 surface 节点,与官方 foldSurface 一致)
  const nodes = []
  for (const ev of events) {
    if (ev && (ev.type === 'user/message' || ev.type === 'assistant/message' || ev.type === 'tool/result')) nodes.push(ev.seq)
  }
  if (mode === 'tail') {
    const shadowedSeqs = nodes.filter((s) => s >= seq)
    if (shadowedSeqs.length === 0) return null
    return { start: shadowedSeqs[0], end: shadowedSeqs[shadowedSeqs.length - 1], shadowedSeqs }
  }
  const index = nodes.indexOf(seq)
  if (index === -1) return null
  let startIdx = index
  for (let i = index; i >= 0; i--) { if (isRoundBoundary(events[nodes[i]])) { startIdx = i; break } }
  let endIdx = nodes.length - 1
  for (let i = startIdx + 1; i < nodes.length; i++) { if (isRoundBoundary(events[nodes[i]])) { endIdx = i - 1; break } }
  const span = nodes.slice(startIdx, endIdx + 1)
  if (span.length === 0) return null
  return { start: span[0], end: span[span.length - 1], shadowedSeqs: span }
}

/**
 * DSH 适配器:EventReader 实现。
 * 从文件读全量事件(可靠事实),并提供基于它的遮蔽计算。
 */
export const dshAdapter = {
  reader: { readEvents },
  /** 便捷:读事件 + 算遮蔽一步到位(供 index.js/http.js 注入 args.span)。 */
  async spanFromFile(sessionId, target, mode = 'round') {
    const events = await readEvents(sessionId)
    return computeSpan(events, target, mode)
  },
  /**
   * 从文件全量事件算某 turn 内的最大 step 号(情形② marker step 分配用)。
   * 绕开 host 窗口化 session.events(稀疏内存视图可能看不到 turn 内全部 step,
   * 算小 → 新 step 号与窗口外既有 step 冲突 = step key 冲突白屏,5e551001 复盘)。
   * 失败返回 null(调用方 fallback 内存扫描)。
   * @param {string} [filePath] 可选:直接指定会话文件路径(测试注入)。
   */
  async maxStepInTurnFromFile(sessionId, turn, filePath) {
    const events = filePath ? await readEventsFromFile(filePath) : await readEvents(sessionId)
    if (!Array.isArray(events)) return null
    let max = 0
    for (const ev of events) {
      if (ev?.type === 'step/start' && ev.data?.turn === turn) {
        const step = ev.data?.step
        if (typeof step === 'number' && Number.isSafeInteger(step) && step > max) max = step
      }
    }
    return max
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// 语义短码推导(2026-09-02)——工作区 createdAt 序号 + 父链,与维护线
// generate-session-codes.mjs 同规则(表的新鲜版,不冲突)。
// 短码 = 工作区2 + 序号3 + 父工作区2 + 父序号3;根父 = FF000。
// 只读会话文件帧1(header),全量 ~110 会话 ≈ 30ms,懒加载缓存。
// ─────────────────────────────────────────────────────────────────────────────

/** 工作区目录名 → 2 位缩写(与 generate-session-codes.mjs 同逻辑: --home-anon-<workspace>-- → op)。 */
function workspaceAbbr(workspace) {
  const name = String(workspace).replace('--home-anon-', '').replace(/--$/, '')
  const parts = name.split('-').filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toLowerCase()
  return name.slice(0, 2).toLowerCase()
}

/** 派生短码表:扫全部工作区会话 header,按 createdAt 排序编号,含父链。 */
export async function deriveBadgeTable() {
  const { readSessionHeader } = await import('dsh-log-contract')
  const root = join(homedir(), '.dsh', 'sessions')
  const rows = [] // { id, ws, createdAt, parent }
  for (const workspace of readdirSync(root)) {
    const wsDir = join(root, workspace)
    let sids
    try { sids = readdirSync(wsDir) } catch { continue }
    for (const sid of sids) {
      const header = readSessionHeader(join(wsDir, sid, 'session.jsonl.zstd'))
      if (!header || typeof header.id !== 'string') continue
      rows.push({
        id: header.id,
        ws: workspaceAbbr(workspace),
        createdAt: header.createdAt ?? 0,
        parent: typeof header.parentSession === 'string' ? header.parentSession : null,
      })
    }
  }
  // 工作区内按 createdAt 排序 → 序号(与 generate-session-codes 一致)
  const byWs = {}
  for (const r of rows) (byWs[r.ws] ??= []).push(r)
  const seqOf = new Map() // sessionId → { ws, seq }
  for (const ws of Object.keys(byWs)) {
    byWs[ws].sort((a, b) => a.createdAt - b.createdAt)
    byWs[ws].forEach((r, i) => seqOf.set(r.id, { ws, seq: i + 1 }))
  }
  const WS = 2
  const SEQ = 3
  const pad = (n) => String(n).padStart(SEQ, '0')
  const codes = {}
  for (const r of rows) {
    const self = seqOf.get(r.id)
    if (!self) continue
    const selfCode = `${self.ws}${pad(self.seq)}`
    const parentInfo = r.parent ? seqOf.get(r.parent) : null
    codes[r.id] = parentInfo
      ? `${selfCode}${parentInfo.ws}${pad(parentInfo.seq)}`
      : `${selfCode}FF${'0'.repeat(SEQ)}`
  }
  return codes
}

let deriveCache = null
let derivePromise = null

/** 语义短码(推导):懒加载缓存;会话不在表(如已删/新加入但未扫)返回 null。 */
export async function semanticBadgeOf(sessionId) {
  const id = String(sessionId ?? '')
  if (deriveCache !== null) return deriveCache[id] ?? null
  derivePromise ??= deriveBadgeTable().then((codes) => {
    deriveCache = codes
    return codes
  }).catch(() => {
    deriveCache = {}
    return deriveCache
  })
  const codes = await derivePromise
  return codes[id] ?? null
}

/** 刷新推导缓存(新会话创建/删除后调用,后台)。 */
export function invalidateBadgeDerive() {
  deriveCache = null
  derivePromise = null
}
