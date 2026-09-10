/**
 * dsh-retrace — lib/message-list.js
 *
 * 消息列表投影 —— Agent 业务层的第一个抽象能力（2026-09-01）。
 *
 * 哲学（日志/表达分离）：
 * - 日志层：客观记录一切消息事件 + 编辑/撤回操作（append-only，永不改写）；
 * - 业务层（本模块）：按业务规则推导「当前对话 = 哪些消息」——
 *   被编辑/撤回的消息不在当前列表（「人会忘记，但事情有记录」）；
 * - 渲染层：消费本模块输出的消息列表，与日志如何表达（DSH surface/replace/turn）无关。
 *
 * 本模块是**纯业务**：零平台 import（只引 lib/span-semantics.js 的纯规则）、
 * 纯函数、可测试、可跨平台。它只理解两个抽象：
 *   - `messages`：全量消息事件（{ seq, role, turn, text }，来自日志层适配器）；
 *   - `shadows`：遮蔽区间（{ start, end }，来自编辑/撤回操作的记录）。
 * DSH 的 surfaceOp/replace/turn 是适配器的翻译，不是本模块的概念。
 *
 * 业务规则（当前版本）：
 *   1. 遮蔽区间按「时间序」应用：后应用的遮蔽覆盖先应用的；
 *   2. 被任何遮蔽区间覆盖的消息 → 不在当前列表（status 保留为 'shadowed' 可审计）；
 *   3. 遮蔽区间本身不是消息（编辑/撤回标记由日志层表达，业务层只消费结果）。
 *
 * 未来扩展（生命周期并入，问题3 方向）：消息可带 `source`（用户/模型/工具/子任务），
 * 子任务生命周期（完成/失败/挂起）可作为投影的状态输入——命令层处理生命周期。
 */
// 遮蔽范围规则(轮首回退/尾部切片)= lib/span-semantics.js 单一真相。
// 本模块只提供「活跃消息 seq 节点序列 + 轮边界谓词」,规则本身不在本文件实现。
import { SPAN_MODE, spanForSeq } from './span-semantics.js'

/** 消息事件的最小业务形态（适配器负责把宿主事件翻译成这个）。 */
// { seq, role: 'user'|'assistant'|'tool', turn, text, source? }

/**
 * 按业务规则投影当前消息列表。
 * @param {Array<{seq:number, role:string, turn?:number, text?:string}>} messages - 全量消息（时间序）。
 * @param {Array<{seqs?:number[], start?:number, end?:number}>} [shadows] - 遮蔽（时间序，可空）。
 *   `seqs` = 精确被遮蔽的 seq 集合（推荐——sourceEventSeqs 原样，不误伤区间内未遮蔽消息）；
 *   `start/end` = 连续区间（兼容，区间内所有 seq 遮蔽）。
 * @returns {Array<{seq:number, role:string, turn?:number, text?:string, status:'active'|'shadowed'}>}
 *   当前消息列表（status='active' 的为当前对话；shadowed 的保留供审计/回档）。
 */
export function projectMessageList(messages, shadows = []) {
  if (!Array.isArray(messages)) return []
  const covered = new Set()
  for (const s of shadows) {
    if (!s) continue
    if (Array.isArray(s.seqs)) {
      for (const seq of s.seqs) {
        if (typeof seq === 'number') covered.add(seq)
      }
      continue
    }
    if (typeof s.start === 'number' && typeof s.end === 'number' && s.start <= s.end) {
      for (let seq = s.start; seq <= s.end; seq++) covered.add(seq)
    }
  }
  return messages.map((m) => ({
    ...m,
    status: covered.has(m.seq) ? 'shadowed' : 'active',
  }))
}

/** 当前对话的「活跃消息列表」（status === 'active'，时间序）。 */
export function activeMessages(messages, shadows = []) {
  return projectMessageList(messages, shadows).filter((m) => m.status === 'active')
}

/** 当前对话的「活跃轮次数」（按 turn 去重；无 turn 时按 user 消息计）。 */
export function activeTurnCount(messages, shadows = []) {
  const active = activeMessages(messages, shadows)
  const turns = new Set(active.map((m) => (typeof m.turn === 'number' ? m.turn : null)))
  turns.delete(null)
  if (turns.size > 0) return turns.size
  return active.filter((m) => m.role === 'user').length
}

/**
 * 编辑/撤回的遮蔽范围（业务层计算，不依赖宿主 surface）。
 *
 * **切片规则不在本文件实现** ——轮首回退 / 尾部切片
 * 一律调用 lib/span-semantics.js 的 spanForSeq，与适配层（adapter/dsh.js 的 computeSpan，
 * 主路径用文件全量 + 官方 foldSurface nodes）以及宿主业务层（host-core）**同一实现**。
 * 此前本函数的 tail 模式只从「目标自身位置」切到活跃尾部，而适配层 tail 会先**回退到
 * 目标所在轮首** —— 同一输入两种结果（审计："预览与写入迟早对不上"）。现在两种模式
 * 语义统一（见 span-semantics 文件头）：
 *   - 'round' = [目标轮首 .. 目标轮尾]（编辑/重新生成）；
 *   - 'tail'  = [目标轮首 .. 活跃列表末尾]（撤回/重新开始）。
 * 轮边界谓词:优先用 `source.kind`(消息形态带 source 时与适配层的事件谓词
 * isRoundBoundaryEvent 同义——注入上下文/steering 的 user 消息 source.kind !== 'user',
 * **不得**切分交换轮);消息层没有 source 维度时回落 `role === 'user'`。
 * 两层的**规则**同一份,谓词随各自形态显式给出(这正是"预览=写入"的前提)。
 *
 * @param {Array<{seq:number, role:string, turn?:number, source?:object}>} messages - 全量消息。
 * @param {Array<{start:number, end:number}>} shadows - 已有遮蔽（应用后）。
 * @param {number} targetSeq - 目标消息 seq。
 * @param {object} [opts]
 * @param {'round'|'tail'} [opts.mode='tail'] - 语义见上。
 * @returns {{start:number, end:number, shadowedSeqs:number[]}|null}
 *   null = 目标不在当前活跃列表（已遮蔽/不存在）。
 */
export function shadowSpanOf(messages, shadows, targetSeq, { mode = SPAN_MODE.TAIL } = {}) {
  const projected = projectMessageList(messages, shadows)
  const active = projected.filter((m) => m.status === 'active')
  const nodes = active.map((m) => m.seq)
  const bySeq = new Map(active.map((m) => [m.seq, m]))
  return spanForSeq(nodes, targetSeq, {
    mode,
    isBoundary: (seq) => {
      const m = bySeq.get(seq)
      if (!m) return false
      if (m.source && typeof m.source.kind === 'string') return m.role === 'user' && m.source.kind === 'user'
      return m.role === 'user'
    },
  })
}
