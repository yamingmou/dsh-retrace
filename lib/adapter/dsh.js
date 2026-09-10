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
// issue-229:span 语义(状态枚举 + 轮首回退/切片规则)收敛到单一真相模块——
// 适配层与业务层(host-core/message-list)调用同一实现,不再各写一份。
import {
  SPAN_STATUS, spanAt, spanOk, spanMiss,
  isRoundBoundaryEvent,
} from '../span-semantics.js'
// issue-229 第 3 项:跨层契约运行时校验(形状违规 → 指名道姓的错误,不静默/不奇怪地炸)
import { assertEventListShape, assertSpanShape, assertSpanResult } from './contract.js'

/**
 * seq → 事件查找:优先按数组下标(真实会话 seq 自 0 连续、index==seq),下标与 seq
 * 不符(异构夹具/截断重排)时才惰性建值索引兜底——正确性优先,热路径零额外分配。
 */
function seqLookup(events) {
  let byValue = null
  return (seq) => {
    const direct = events[seq]
    if (direct !== undefined && direct?.seq === seq) return direct
    if (byValue === null) {
      byValue = new Map()
      for (const ev of events) {
        if (ev && typeof ev.seq === 'number' && !byValue.has(ev.seq)) byValue.set(ev.seq, ev)
      }
    }
    return byValue.get(seq)
  }
}
/** 找 DSH 会话文件路径(遍历 ~/.dsh/sessions 各工作区)。 */
export function sessionFilePath(sessionId) {
  const root = join(homedir(), '.dsh', 'sessions')
  for (const workspace of readdirSync(root)) {
    const candidate = join(root, workspace, String(sessionId), 'session.jsonl.zstd')
    try { accessSync(candidate); return candidate } catch { /* keep looking */ }
  }
  return null
}

/**
 * 是否是真实的用户输入(轮边界)——排除 context/steering 注入。
 * issue-229 第 2 项:实现搬到 lib/span-semantics.js(单一真相)——此前 host-core 与
 * 本文件各有一份逐字相同的拷贝,两处分叉即遮蔽范围分叉。此处保留同名导出(对外兼容)。
 */
export const isRoundBoundary = isRoundBoundaryEvent

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
    // 契约运行时化(issue-229 第 3 项):EventReader 返回值形状在**唯一入口**抽样校验
    // (头/中/尾;百万级日志不做 O(n) 断言)。形状漂移(如 log 记录包装变了导致
    // undefined 洞)在此立刻报错,不再让下游 foldSurface 以奇怪方式炸。
    assertEventListShape(events, 'dshAdapter.readEvents')
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
 * issue-229 第 1 项(复核):**返回显式状态,不再用 null 承载四种语义**。
 * 旧实现返回 null 同时表示 ①真找不到目标 ②已被遮蔽 ③还没落盘 ④重放失败——
 * 调用方无法区分,只能再算一遍/靠注入事实猜(host-core.spanMissKind)。
 * 现在返回 `{ status, span, facts }`(SPAN_STATUS 五态,见 lib/span-semantics.js):
 *   - ok               → span 可用;
 *   - not-found        → 快照里没有这个目标(seq 空洞 / 事件列表不可读);
 *   - already-shadowed → 目标在日志里,但已被更早的 replace 移出当前面(历史只读);
 *   - not-persisted    → 目标尚未落盘(刚 commit,文件快照还没它;可重试);
 *   - replay-failed    → foldSurface 重放失败(内部错误,绝不冒充"已遮蔽")。
 * facts = { fileMaxSeq, targetSeq, mode, nodes }(文件快照事实,与 span 同一份快照)。
 *
 * 2026-09-07 修复(ISSUE-20260907113201-5e551006):nodes 不再从 events 顺序收集
 * (seq 递增的虚拟 nodes),改为**官方 foldSurface 重放得真实 surface nodes**——
 * 官方 replace 会把 marker(新 seq)插入遮蔽范围开头、移除被遮蔽节点 → nodes 非
 * seq 单调。旧算法按 seq 递增假设算 span,写入时官方 nodes 里 indexOf(start/end)
 * 可能 not found(目标已被遮蔽)或倒置(startIdx>endIdx,marker 插入) → S4/S8 拒 →
 * 撤回死锁(evidence 快照实测:target 710693 span[710693..711448] → index 442>441)。
 * 新算法 nodes = 官方 foldSurface 结果 → span 的 start/end 与写入端完全一致。
 *
 * issue-229 第 2 项:轮首回退/尾部切片规则改由 lib/span-semantics.js 的 spanAt 提供
 * (与业务层 host-core 同一实现)——本函数只负责「读事件 + 判状态 + 给规则喂料」。
 *
 * @param {Array} events - 全量事件(通用格式)。
 * @param {number|string} target - seq 或 messageId。
 * @param {'round'|'tail'} [mode] - round=遮蔽目标轮;tail=从目标轮首遮蔽到面尾。
 * @returns {{status:string, span:object|null, facts:object}} 显式状态结果(见上)。
 */
export function computeSpan(events, target, mode = 'round') {
  const numericTarget = typeof target === 'number' && Number.isSafeInteger(target) && target >= 0
  // ① 事件列表不可读/为空:没有任何快照证据 → not-found,且 facts.fileMaxSeq = -1。
  //    (调用方 spanMissArgsOf 不把无证据的结果下传 → 业务层按内存视图判定,0.4.24 行为不变)
  if (!Array.isArray(events) || events.length === 0) {
    return spanMiss(SPAN_STATUS.NOT_FOUND, { fileMaxSeq: -1, targetSeq: numericTarget ? target : -1, mode, nodes: 0 })
  }
  const at = seqLookup(events)
  // ② 文件快照事实:已知最大 seq + 目标在快照里的 seq(一次遍历)。
  //    消息 id → seq 取**最后一次**出现(与旧实现一致;id 唯一,重复时以最新为准)。
  let fileMaxSeq = -1
  let seq = numericTarget ? target : -1
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (typeof ev?.seq === 'number' && ev.seq > fileMaxSeq) fileMaxSeq = ev.seq
    if (seq === -1 && typeof target === 'string') {
      const id = ev?.type === 'user/message' ? ev.data?.id : ev?.type === 'assistant/message' ? ev.data?.message?.id : undefined
      if (typeof id === 'string' && id === target) seq = ev.seq
    }
  }
  const facts = { fileMaxSeq, targetSeq: seq >= 0 ? seq : -1, mode, nodes: 0 }
  if (seq === -1) {
    // ③ 目标在快照里定位不到:
    //    - 消息 id 目标:日志 append-only,已存在的消息 id 必随文件持久化 → 不在快照 =
    //      **尚未落盘**(刚 commit,文件 flush 滞后)→ not-persisted(可重试,issue-200 语义);
    //    - 非字符串目标(非法 seq):无意义输入 → not-found。
    if (typeof target !== 'string') return spanMiss(SPAN_STATUS.NOT_FOUND, facts)
    return spanMiss(SPAN_STATUS.NOT_PERSISTED, facts)
  }
  if (numericTarget && target > fileMaxSeq) return spanMiss(SPAN_STATUS.NOT_PERSISTED, facts)
  if (at(seq) === undefined) return spanMiss(SPAN_STATUS.NOT_FOUND, facts)
  // ④ 官方 foldSurface 重放 = 与写入端一致的当前 surface(含 marker 插入效应、排除被遮蔽节点)
  let nodes
  try {
    const folded = foldSurface(events)
    nodes = folded?.nodes
  } catch {
    // 重放失败是**内部错误**:旧实现与"目标已被遮蔽"共用 null → 用户看到"历史只读"
    // (误导)。现在显式 replay-failed,调用方报内部错误(绝不冒充遮蔽)。
    return spanMiss(SPAN_STATUS.REPLAY_FAILED, facts)
  }
  if (!Array.isArray(nodes) || nodes.length === 0) return spanMiss(SPAN_STATUS.REPLAY_FAILED, facts)
  facts.nodes = nodes.length
  const index = nodes.indexOf(seq)
  // ⑤ 目标在日志里但不在当前面 → 已被更早的 replace(fold/recall/compact)遮蔽
  if (index === -1) return spanMiss(SPAN_STATUS.ALREADY_SHADOWED, facts)
  // ⑥ 规则单一真相:轮首回退/尾部切片/区间段全部由 spanAt 给(业务层同一实现)
  const span = spanAt(nodes, index, {
    mode,
    isBoundary: (nodeSeq) => isRoundBoundaryEvent(at(nodeSeq)),
  })
  if (!span) return spanMiss(SPAN_STATUS.NOT_FOUND, facts)
  // 契约运行时化(issue-229 第 3 项):适配器产出的 span 结构在出口自检
  assertSpanShape(span, 'dshAdapter.computeSpan.span')
  return spanOk(span, facts)
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
  const event = seqLookup(events)(seq)
  if (!isRoundBoundary(event)) return null
  const content = event.data?.content
  const text = Array.isArray(content)
    ? content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('')
    : ''
  return { seq, text }
}

/**
 * computeSpan + 文件快照事实(issue-200)——**一次遍历**给出显式状态、遮蔽 span 与
 * 「文件快照已知最大 seq / 目标在快照里的 seq」。调用方(withFileSpan/http.js)按
 * status 处理(issue-229 第 1 项,不再靠 null 猜):
 *  - not-persisted    → 目标 seq > 文件快照最大 seq(文件尚未 flush)→ message-pending;
 *  - already-shadowed → 快照已覆盖目标位置却不在其 surface → target-shadowed(只读);
 *  - not-found        → 快照里没有这个目标 → 明确的 not-found;
 *  - replay-failed    → 面重放失败 → 内部错误(不冒充"已遮蔽")。
 * 纯函数(与 computeSpan 同构,平台无关;零平台 import)。
 *
 * M-1(独立审查 74e580d 后续):同时带回 prompt = round span 起点 user 的原文
 * (roundPromptOf)。span 命中时调用方把它注入 args.regeneratePrompt —— regenerate
 * 的重发文本/ marker targetSeq 一律取自文件侧,不再直扫 host 稀疏 events
 * (直扫会越过洞选中更早轮 user,重发错文本)。
 *
 * @returns {{status: string, span: object|null, facts: {fileMaxSeq: number,
 *   targetSeq: number, mode: string, nodes: number}, prompt: {seq: number, text: string}|null}}
 */
export function computeSpanProbe(events, target, mode = 'round', opts = {}) {
  const result = computeSpan(events, target, mode, opts)
  return { ...result, prompt: roundPromptOf(events, result.span, mode) }
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
    return assertSpanResult(computeSpan(events, target, mode), 'dshAdapter.spanFromFile')
  },
  /**
   * 便捷:读事件一次,同时给出 span 与文件快照事实(issue-200)。status ≠ ok 时
   * 调用方(withFileSpan/http.js)按状态注入 args.spanStatus/spanFacts → host-core
   * 区分「提交中(message-pending)」「真被遮蔽(target-shadowed)」「找不到(not-found)」
   * 与「内部错误(replay-failed)」——文件 flush 滞后不再误报「已不在活跃对话」。
   * M-1(独立审查 74e580d 后续):probe.prompt = round span 起点 user 的**文件侧原文**
   * ——regenerate 的重发文本/ marker targetSeq 取自这里,不直扫 host 稀疏 events。
   */
  async spanProbeFromFile(sessionId, target, mode = 'round', opts = {}) {
    const events = await readEvents(sessionId)
    return assertSpanResult(computeSpanProbe(events, target, mode, opts), 'dshAdapter.spanProbeFromFile')
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
