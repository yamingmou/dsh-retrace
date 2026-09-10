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
// 官方 foldSurface:重放得与写入端完全一致的 surface nodes(replace 插 marker、
// 遮蔽移除节点 → nodes 非 seq 单调;span 计算必须用它,否则 start/end indexOf
// 会 not found/倒置 → S4/S8 拒 → 撤回死锁,ISSUE-20260907113201)。peerDep 提供。
import { foldSurface } from '@deepseek-ai/dsh-session'

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

/** 从指定文件路径读全量事件(测试可注入路径;生产走 readEvents 找 ~/.dsh)。
 *  P0-6(代码 M-5):单次编辑/查询操作会连读多次(span+文件快照事实),每次全量
 *  zstd 解压+JSON+foldSurface(1.37M 事件秒级)→ 加**进程级短缓存**(同批次
 *  内共享一次读取;以 mtime+size 校验文件未变,变了即失效,防与写入撕裂)。
 *  TTL 很短(300ms)只覆盖单次命令的连续读取,不缓存跨命令的陈旧数据。 */
const readCache = new Map() // filePath → { sig, events, at }
const READ_CACHE_TTL_MS = 300
async function readEventsFromFile(filePath) {
  try {
    if (!filePath) return null
    const { statSync } = await import('node:fs')
    // 文件签名(mtimeMs+size):写入会改 mtime/size → 缓存自动失效
    let sig = null
    try {
      const st = statSync(filePath)
      sig = `${st.mtimeMs}:${st.size}`
    } catch { sig = 'unreadable' }
    const hit = readCache.get(filePath)
    if (hit && hit.sig === sig && Date.now() - hit.at < READ_CACHE_TTL_MS) {
      return hit.events
    }
    const { loadSessionLog } = await import('dsh-log-contract')
    const log = loadSessionLog(filePath)
    const events = log.events.map((r) => r.event)
    // 只缓存有效读取(失败不缓存,下次重试)
    if (Array.isArray(events) && events.length > 0) {
      readCache.set(filePath, { sig, events, at: Date.now() })
      // 防膨胀:超过 32 个文件清空(单命令最多几个会话文件)
      if (readCache.size > 32) readCache.clear()
    }
    return events
  } catch { return null }
}

/**
 * 从全量事件计算遮蔽范围(业务逻辑,基于通用事件,与 DSH 无关)。
 *
 * 2026-09-07 修复(ISSUE-20260907113201-5e551006):nodes 不再从 events 顺序收集
 * (seq 递增的虚拟 nodes),改为**官方 foldSurface 重放得真实 surface nodes**——
 * 官方 replace 会把 marker(新 seq)插入遮蔽范围开头、移除被遮蔽节点 → nodes 非
 * seq 单调。旧算法按 seq 递增假设算 span,写入时官方 nodes 里 indexOf(start/end)
 * 可能 not found(目标已被遮蔽)或倒置(startIdx>endIdx,marker 插入) → S4/S8 拒 →
 * 撤回死锁(evidence 快照实测:target 710693 span[710693..711448] → index 442>441)。
 * 新算法 nodes = 官方 foldSurface 结果 → span 的 start/end 与写入端完全一致,
 * not found/倒置不可能;target 已被遮蔽(不在 nodes)= 返回 null(target-shadowed)。
 *
 * @param {Array} events - 全量事件(通用格式)。
 * @param {number|string} target - seq 或 messageId。
 * @param {'round'|'tail'} [mode] - round=遮蔽目标轮;tail=遮蔽目标位置之后全部(recall/fromScratch)。
 */
export function computeSpan(events, target, mode = 'round') {
  if (!Array.isArray(events) || events.length === 0) return null
  let seq = typeof target === 'number' ? target : -1
  if (seq === -1) {
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i]
      const id = ev?.type === 'user/message' ? ev.data?.id : ev?.type === 'assistant/message' ? ev.data?.message?.id : undefined
      if (typeof id === 'string' && id === target) { seq = ev.seq; break }
    }
  }
  if (seq === -1 || !events[seq]) return null
  // 官方 foldSurface 重放 = 与写入端一致的当前 surface(含 marker 插入效应、排除被遮蔽节点)
  let nodes
  try {
    const folded = foldSurface(events)
    nodes = folded?.nodes
  } catch {
    return null
  }
  if (!Array.isArray(nodes) || nodes.length === 0) return null
  const index = nodes.indexOf(seq)
  if (index === -1) return null // 目标已被遮蔽/不在 surface → 调用方报 target-shadowed
  if (mode === 'tail') {
    // tail:从目标所在轮首遮蔽到 surface 尾(撤回 = 移除整轮 input+output + 其后全部,
    // R2 语义;目标若是轮内 assistant/tool 则回退到轮首 user,防孤立输入)。
    let startPos = index
    for (let i = index; i >= 0; i--) { if (isRoundBoundary(events[nodes[i]])) { startPos = i; break } }
    const shadowedSeqs = nodes.slice(startPos)
    if (shadowedSeqs.length === 0) return null
    return { start: shadowedSeqs[0], end: shadowedSeqs[shadowedSeqs.length - 1], shadowedSeqs }
  }
  // round:目标轮(在官方 nodes 位置序上找轮边界;marker 是 assistant/message 非轮边界)
  let startIdx = index
  for (let i = index; i >= 0; i--) { if (isRoundBoundary(events[nodes[i]])) { startIdx = i; break } }
  let endIdx = nodes.length - 1
  for (let i = startIdx + 1; i < nodes.length; i++) { if (isRoundBoundary(events[nodes[i]])) { endIdx = i - 1; break } }
  const span = nodes.slice(startIdx, endIdx + 1)
  if (span.length === 0) return null
  return { start: span[0], end: span[span.length - 1], shadowedSeqs: span }
}

/**
 * 文件侧「目标同一轮的前置 user 原文」(M-1,独立审查 74e580d 后续)——regenerate
 * 重发文本的唯一可靠来源。
 *
 * 为什么必须算在文件侧:host 内存 session.events 是窗口化/稀疏视图(带 undefined 洞),
 * regenerate 在内存里「向前找最近的前置 user」会越过洞(洞里正是该轮 user)或越过被
 * 遮蔽区间,选到**更早轮**的 user → 重发错文本 + marker targetSeq 指向错轮。round span
 * 的起点在文件全量 events + 官方 foldSurface nodes 上就是目标同一轮的轮首 user
 * (computeSpan round 模式向前找 isRoundBoundary 的落点),从该点单点取原文不可能跨轮。
 *
 * 纯函数(零平台 import)。
 * @returns {{seq: number, text: string}|null} span 起点非轮边界 user(孤儿回复:向前
 *   找不到 user;或非 round 模式)→ null(调用方保守处理:绝不重发更早轮的文本)。
 */
export function roundPromptOf(events, span, mode = 'round') {
  if (mode !== 'round' || !span || !Array.isArray(events)) return null
  const seq = span.start
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) return null
  const event = events[seq]
  if (!isRoundBoundary(event)) return null
  const content = event.data?.content
  const text = Array.isArray(content)
    ? content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('')
    : ''
  return { seq, text }
}

/**
 * computeSpan + 文件快照事实(issue-200):一次遍历同时给出遮蔽 span 与
 * 「文件快照已知最大 seq / 目标在快照里的 seq」。span 为 null 时,调用方
 * (withFileSpan/http.js)把这些事实注入 args.spanFacts,host-core 据此区分:
 *  - 目标 seq > 文件快照最大 seq → 文件尚未 flush 该消息(提交中)→ message-pending;
 *  - 快照已覆盖目标位置却不在其 surface(span null)→ 真被遮蔽 → target-shadowed。
 * 纯函数(与 computeSpan 同构,平台无关;零平台 import)。
 *
 * M-1(独立审查 74e580d 后续):同时带回 prompt = round span 起点 user 的原文
 * (roundPromptOf)。span 命中时调用方把它注入 args.regeneratePrompt —— regenerate
 * 的重发文本/ marker targetSeq 一律取自文件侧,不再直扫 host 稀疏 events
 * (直扫会越过洞选中更早轮 user,重发错文本)。
 *
 * @returns {{span: object|null, facts: {fileMaxSeq: number, targetSeq: number},
 *   prompt: {seq: number, text: string}|null}}
 */
export function computeSpanProbe(events, target, mode = 'round', opts = {}) {
  const span = computeSpan(events, target, mode, opts)
  let targetSeq = typeof target === 'number' ? target : -1
  let fileMaxSeq = -1
  if (Array.isArray(events)) {
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i]
      if (!ev) continue
      if (typeof ev.seq === 'number' && ev.seq > fileMaxSeq) fileMaxSeq = ev.seq
      if (targetSeq === -1) {
        const id = ev?.type === 'user/message' ? ev.data?.id : ev?.type === 'assistant/message' ? ev.data?.message?.id : undefined
        if (typeof id === 'string' && id === target) targetSeq = ev.seq
      }
    }
  }
  return { span, facts: { fileMaxSeq, targetSeq: targetSeq >= 0 ? targetSeq : -1 }, prompt: roundPromptOf(events, span, mode) }
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
   * 便捷:读事件一次,同时给出 span 与文件快照事实(issue-200)。span 为 null 时
   * 调用方(withFileSpan/http.js)注入 facts → host-core 区分「提交中(message-pending)」
   * 与「真被遮蔽(target-shadowed)」——文件 flush 滞后不再误报「已不在活跃对话」。
   * M-1(独立审查 74e580d 后续):probe.prompt = round span 起点 user 的**文件侧原文**
   * ——regenerate 的重发文本/ marker targetSeq 取自这里,不直扫 host 稀疏 events。
   */
  async spanProbeFromFile(sessionId, target, mode = 'round', opts = {}) {
    const events = await readEvents(sessionId)
    return computeSpanProbe(events, target, mode, opts)
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
