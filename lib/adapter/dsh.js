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

/** 官方 nodes 里 [start..end] 位置段的节点 seq(折叠候选 shadowedSeqs)。 */
function rangeSeqs(nodes, start, end) {
  const si = nodes.indexOf(start)
  const ei = nodes.indexOf(end)
  if (si === -1 || ei === -1 || si > ei) return []
  return nodes.slice(si, ei + 1)
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
 *  P0-6(代码 M-5):fold 单次操作会连读 3-4 次(边界/span/摘要),每次全量
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
 * 2026-09-07 修复(ISSUE-20260907113201-3f9e4f12):nodes 不再从 events 顺序收集
 * (seq 递增的虚拟 nodes),改为**官方 foldSurface 重放得真实 surface nodes**——
 * 官方 replace 会把 marker(新 seq)插入遮蔽范围开头、移除被遮蔽节点 → nodes 非
 * seq 单调。旧算法按 seq 递增假设算 span,写入时官方 nodes 里 indexOf(start/end)
 * 可能 not found(目标已被遮蔽)或倒置(startIdx>endIdx,marker 插入) → S4/S8 拒 →
 * 撤回死锁(evidence 快照实测:target 710693 span[710693..711448] → index 442>441)。
 * 新算法 nodes = 官方 foldSurface 结果 → span 的 start/end 与写入端完全一致,
 * not found/倒置不可能;target 已被遮蔽(不在 nodes)= 返回 null(target-shadowed)。
 *
 * @param {Array} events - 全量事件(通用格式)。
 * @param {number|string} target - seq 或 messageId(round/tail 用);range 模式下为区间起点。
 * @param {'round'|'tail'|'range'} [mode] - round=遮蔽目标轮;tail=遮蔽目标位置之后全部;
 *   range=遮蔽 [target..opts.endSeq] 区间(折叠完成块,长会话整理窗口批1)。
 * @param {object} [opts] - range 模式:opts.endSeq = 区间终点(必须为 surface 节点)。
 */
export function computeSpan(events, target, mode = 'round', opts = {}) {
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
  if (mode === 'range') {
    // range:折叠完成块区间 [seq..endSeq]——位置连续段(长会话整理窗口批1 marker 折叠承载)。
    // 端点必须是 surface 节点;区间可含 marker(先前折叠节点,折叠链收敛语义)。
    const endSeq = typeof opts?.endSeq === 'number' ? opts.endSeq : seq
    const endIndex = nodes.indexOf(endSeq)
    if (endIndex === -1) return null
    if (index > endIndex) return null
    const shadowedSeqs = nodes.slice(index, endIndex + 1)
    if (shadowedSeqs.length === 0) return null
    return { start: shadowedSeqs[0], end: shadowedSeqs[shadowedSeqs.length - 1], shadowedSeqs }
  }
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
 * DSH 适配器:EventReader 实现。
 * 从文件读全量事件(可靠事实),并提供基于它的遮蔽计算。
 */
export const dshAdapter = {
  reader: { readEvents },
  /** 便捷:读事件 + 算遮蔽一步到位(供 index.js/http.js 注入 args.span)。 */
  async spanFromFile(sessionId, target, mode = 'round', opts = {}) {
    const events = await readEvents(sessionId)
    return computeSpan(events, target, mode, opts)
  },
  /**
   * 上下文用量体检 + 折叠建议(长会话整理批4):读文件 → 测量上下文用量(中文校正)+ 候选折叠块
   * (头部之后最老完成块)+ 收益估算。全中文建议给正解。
   * (体检命令 A,规格 §五):返回带 cacheMetrics = 缓存前缀读数 +
   * 官方压缩史(cacheReadTokens = 官方 API usage 实测;被动层留痕,waterLevel 报告可见)。
   * @param {string} [filePath] 可选:直接指定会话文件路径(测试注入;生产走 ~/.dsh)。
   */
  async waterLevelFromFile(sessionId, opts = {}, filePath) {
    const events = filePath ? await readEventsFromFile(filePath) : await readEvents(sessionId)
    if (!Array.isArray(events) || events.length === 0) return null
    const { measureWaterLevel, estimateRangeTokens, YELLOW_RATIO } = await import('../water-level.js')
    // surface 口径:官方 foldSurface nodes(近似模型上下文;全量含被折叠历史会高估且
    // 折叠后不回落,独立审查 ❌-4)。nodes 同时用于候选定位(compaction 后 events seq 序失真)。
    const nodes = (() => { try { return foldSurface(events).nodes } catch { return [] } })()
    const level = measureWaterLevel(events, { ...opts, surface: opts.surface !== false && nodes.length ? nodes : null })
    // 折叠候选:官方 nodes 位置序上第一个真实完成轮(跳过 compact checkpoint 与无文本;
    // 候选不选 nodes[0] 的 checkpoint——独立审查 ❌-5)。
    // (官方失效/不再抢先):suggestion 生成线从"band≠green(60%)"改为按 pct
    // 阈值——默认仍 0.6(= 原 band 语义,报告口径不变);接线处传 suggestPct=自动层触发线
    // (0.55)→ 55-60% 灰区(green 带)也有候选,自动层能在这段折(官方 0.8 前留缓冲)。
    let suggestion = null
    const suggestPct = Number.isFinite(opts?.suggestPct) && opts.suggestPct > 0 && opts.suggestPct < 1 ? opts.suggestPct : YELLOW_RATIO
    if (level.pct >= suggestPct) {
      const isCompact = (ev) => ev?.type === 'user/message' && ev.data?.source?.kind === 'plugin' && ev.data?.source?.plugin === 'compact'
      const firstUser = nodes.find((s) => events[s]?.type === 'user/message' && !isCompact(events[s]))
      if (firstUser !== undefined) {
        const span = computeSpan(events, firstUser, 'round')
        if (span) {
          const gain = estimateRangeTokens(events, span.shadowedSeqs)
          suggestion = {
            foldRange: { start: span.start, end: span.end, rounds: 1, reason: 'completed' },
            gainTokens: gain,
            shadowed: span.shadowedSeqs.length,
            afterPct: level.window > 0 ? Math.max(0, (level.cjkTokens - gain) / level.window) : 0,
          }
        }
      }
    }
    // 长会话整理防线·度量(体检命令 A,规格 §四/§五):缓存前缀读数 +
    // 官方压缩史。cacheReadTokens = 官方 API usage 实测(事件现成);compactionHistory
    // = 被动层留痕(该会话被官方压缩 N 次/共打掉 X token,含每次明细)。纯读,
    // 度量失败只缺 cacheMetrics 字段,不阻断上下文用量报告。
    let cacheMetrics = null
    try {
      const { latestCacheReadTokens: latestRead, compactionHistory: historyOf } = await import('../cache-metrics.js')
      cacheMetrics = {
        latestCacheReadTokens: latestRead(events),
        compactionHistory: historyOf(events),
      }
    } catch { /* 度量失败 → 不带 cacheMetrics */ }
    return { ...level, suggestion, cacheMetrics }
  },
  /**
   * fold 自动边界(批5:50 轮上限接线)——fold 命令未显式给 endSeq 时,按
   * foldBoundaryFrom 从 start 起自动兜底切块。默认 = 单轮语义完成块;
   * 显式 rounds 多轮编组时由 foldBoundary 内部 ≤FOLD_MAX_ROUNDS=50 上限兜底。
   * @param {string} [filePath] 可选:直接指定会话文件路径(测试注入)。
   */
  async foldBoundaryFromFile(sessionId, start, opts = {}, filePath) {
    const events = filePath ? await readEventsFromFile(filePath) : await readEvents(sessionId)
    if (!Array.isArray(events) || events.length === 0) return null
    const { foldBoundaryFrom } = await import('../fold-boundary.js')
    return foldBoundaryFrom(events, Number(start), opts)
  },
  /**
   * unfold 展开数据(长会话整理批3,视图层回填):读文件 → 找 fold marker 的 sourceEventSeqs
   * → 提取被遮蔽 seq 的消息内容(按序,供客户端渲染整块供人回看)。模型上下文不变(仍=摘要)。
   * 逆序链式定位 = 按 markerSeq 找(展开指定折叠块)。
   */
  async unfoldContentFromFile(sessionId, markerSeq, filePath) {
    const events = filePath ? await readEventsFromFile(filePath) : await readEvents(sessionId)
    if (!Array.isArray(events) || events.length === 0) return null
    // 注意:不要假设 events 数组 index == seq(实际 seq 起点随文件格式变——实测真会话
    // seq 自 0 连续、index==seq;测试夹具 header 后 seq 自 1、index=seq-1)——统一按值找
    const marker = events.find((e) => e?.seq === Number(markerSeq))
    if (!marker || marker.type !== 'assistant/message' || !String(marker.data?.message?.id ?? '').startsWith('retrace-fold-')) {
      return null
    }
    const shadowed = Array.isArray(marker.sourceEventSeqs) ? marker.sourceEventSeqs : (Array.isArray(marker.data?.shadowedSeqs) ? marker.data.shadowedSeqs : [])
    if (shadowed.length === 0) return null
    // B2 读侧"先看路标卡"层:marker.editor.trio(结构化长会话整理)存在则附上——客户端
    // 展开前先显示卡(块标题/一句话结论/时间),决定是否展开 rows;旧 marker(单文本,
    // 无 trio)兼容:返回 {markerSeq, trio:null, rows}。
    const trio = marker.data?.editor?.trio ?? null
    // M-4(独立审查):修订链读侧——若后续 fold marker 的 supersededBy 指向本卡,
    // 提示"后有修订"(本结论已被取代,别误信旧结论)。旧卡仍在可审计。
    let supersededByNewer = null
    const markerNum = Number(markerSeq)
    for (const ev of events) {
      if (!ev || ev.seq <= markerNum || ev.type !== 'assistant/message') continue
      if (!String(ev.data?.message?.id ?? '').startsWith('retrace-fold-')) continue
      const newerCard = ev.data?.editor?.trio?.['roadmap-card']
      if (newerCard && Number(newerCard.supersededBy) === markerNum) {
        supersededByNewer = ev.seq
        break
      }
    }
    const bySeq = new Map(events.map((e) => [e?.seq, e]))
    const rows = []
    for (const seq of shadowed) {
      const ev = bySeq.get(seq)
      if (!ev) continue
      const type = ev.type
      let text = ''
      if (type === 'user/message') {
        text = Array.isArray(ev.data?.content) ? ev.data.content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n') : ''
      } else if (type === 'assistant/message') {
        text = Array.isArray(ev.data?.message?.content) ? ev.data.message.content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n') : ''
      }
      rows.push({ seq, type: type === 'user/message' ? 'user' : type === 'assistant/message' ? 'assistant' : 'tool', text })
    }
    return { markerSeq: markerNum, trio, supersededByNewer, rows }
  },
  /**
   * 折叠摘要(长会话整理批2):读文件 → 折叠块事件 → 确定摘要。
   * P0-3(四角度审核 A-1/D-1):输入 = **surface 节点序**(折叠块本体 = span.shadowedSeqs,
   * 官方 nodes 位置连续段),而非 LOG 切片——日志 append-only 含先前被遮蔽轮的原事件
   * (幽灵),LOG 切片会把幽灵轮二次汇总(轮次/工具结果虚增、尾输入指向已不在 surface
   * 的旧输入)。端点 [start..end] 必为 surface 节点(range mode 保证);若端点不在
   * 官方 nodes(被遮蔽/非节点)→ 兜底 LOG 切片(保持旧行为兼容)。
   */
  async summaryFromFile(sessionId, start, end, filePath) {
    const events = filePath ? await readEventsFromFile(filePath) : await readEvents(sessionId)
    if (!Array.isArray(events) || events.length === 0) return null
    const lo = Number(start)
    const hi = Number(end)
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < 0 || hi < lo) return null
    const { buildFoldSummary } = await import('../fold-summary.js')
    // P0-3:以官方 surface nodes 位置段为输入(消幽灵轮)
    const bySeq = new Map(events.map((e, i) => [e?.seq, i]))
    let slice = null
    try {
      const folded = foldSurface(events)
      const nodes = folded?.nodes
      if (Array.isArray(nodes) && nodes.length > 0) {
        const si = nodes.indexOf(lo)
        const ei = nodes.indexOf(hi)
        if (si !== -1 && ei !== -1 && si <= ei) {
          const shadowed = nodes.slice(si, ei + 1)
          const picked = []
          for (const seq of shadowed) {
            const idx = bySeq.get(seq)
            if (idx !== undefined && events[idx]) picked.push(events[idx])
          }
          if (picked.length > 0) slice = picked
        }
      }
    } catch { /* foldSurface 失败 → 兜底 LOG 切片 */ }
    if (!slice) {
      if (hi >= events.length) return null
      slice = events.slice(lo, hi + 1)
    }
    return buildFoldSummary(slice, { start: lo, end: hi })
  },
  /**
   * B2 折叠长会话整理(2026-09-09):读文件 → surface 位置段事件 → 长会话整理对象
   * ({'roadmap-card':{blockTitle,summary,keySeqs,timeRange}, process, archive})。
   * 与 summaryFromFile 同源(消幽灵轮:输入 = surface nodes 位置段非 LOG 切片);
   * summaryFromFile 给单文本(content 人读),本方法给结构化(editor.trio,读侧用)。
   * @param {string} [filePath] 可选:测试注入。
   */
  async trioFromFile(sessionId, start, end, filePath) {
    const events = filePath ? await readEventsFromFile(filePath) : await readEvents(sessionId)
    if (!Array.isArray(events) || events.length === 0) return null
    const lo = Number(start)
    const hi = Number(end)
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < 0 || hi < lo) return null
    const { buildFoldTrio } = await import('../fold-trio.js')
    const bySeq = new Map(events.map((e, i) => [e?.seq, i]))
    let picked = null
    let shadowedSeqs = null
    try {
      const folded = foldSurface(events)
      const nodes = folded?.nodes
      if (Array.isArray(nodes) && nodes.length > 0) {
        const si = nodes.indexOf(lo)
        const ei = nodes.indexOf(hi)
        if (si !== -1 && ei !== -1 && si <= ei) {
          shadowedSeqs = nodes.slice(si, ei + 1)
          const arr = []
          for (const seq of shadowedSeqs) {
            const idx = bySeq.get(seq)
            if (idx !== undefined && events[idx]) arr.push(events[idx])
          }
          if (arr.length > 0) picked = arr
        }
      }
    } catch { /* foldSurface 失败 → 兜底 LOG 切片 */ }
    if (!picked) {
      if (hi >= events.length) return null
      picked = events.slice(lo, hi + 1)
      shadowedSeqs = null
    }
    return buildFoldTrio(picked, { start: lo, end: hi, shadowedSeqs: shadowedSeqs ?? [lo, hi] })
  },
  /**
   * 从文件全量事件算某 turn 内的最大 step 号(情形② marker step 分配用)。
   * 绕开 host 窗口化 session.events(稀疏内存视图可能看不到 turn 内全部 step,
   * 算小 → 新 step 号与窗口外既有 step 冲突 = step key 冲突白屏,1e99e1ff 回顾)。
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
// 语义短码推导(2026-09-02)——工作区 createdAt 序号 + 父链,与
// gen-session-codes.mjs 同规则(表的新鲜版,不冲突)。
// 短码 = 工作区2 + 序号3 + 父工作区2 + 父序号3;根父 = FF000。
// 只读会话文件帧1(header),全量 ~110 会话 ≈ 30ms,懒加载缓存。
// ─────────────────────────────────────────────────────────────────────────────

/** 工作区目录名 → 2 位缩写(与 gen-session-codes.mjs 同逻辑: --Users-maxwell-opena-- → op)。 */
function workspaceAbbr(workspace) {
  const name = String(workspace).replace('--Users-maxwell-', '').replace(/--$/, '')
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
  // 工作区内按 createdAt 排序 → 序号(与 gen-session-codes 一致)
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
