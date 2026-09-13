/**
 * dsh-retrace — lib/span-semantics.js
 *
 * 「遮蔽范围(span)」语义的**单一真相**:
 *
 * 1. **显式状态枚举(SPAN_STATUS)** —— 取代"返回 null 承载四种语义"的重载:
 *    旧实现里 `computeSpan` 返回 null 同时表示 ①真找不到目标 ②已被遮蔽
 *    ③还没落盘 ④重放失败——调用方只能靠猜(或再算一次)区分,跨层判定
 *    (host-core 的 spanMissKind)因此依赖"事实注入 + 内存兜底"的隐式约定。
 *    现在四种原因各有显式状态,判定 = 读状态,不再靠 null 猜。
 *
 * 2. **遮蔽范围规则的单一实现(spanAt/spanForSeq)** —— 业务层
 *    (host-core / message-list)与适配层(adapter/dsh)此前**各写一份**切片规则
 *    (轮首回退位置、尾部切片)、语义迟早分叉(审计:"预览与写入迟早对不上")。
 *    现在两层的规则收敛到本文件一处,两层只提供「节点序列 + 轮边界谓词」:
 *      - 节点序列:适配层 = 官方 foldSurface nodes(文件全量重放);
 *        业务层 = host 内存 surface.nodes 或投影后的活跃消息 seq;
 *      - 轮边界谓词:适配层/事件形态 = isRoundBoundaryEvent(真实用户输入,
 *        排除 context/steering 注入);业务层消息形态 = role==='user'
 *        (消息层没有 source 维度)。
 *    这里的规则是**位置段语义**(与平台无关):输入位置序,输出位置段。
 *
 * 模式语义(唯一权威定义,两层共用):
 *   - round:遮蔽「目标所在轮」= [目标轮首 .. 目标轮尾(下一个轮边界前)]——
 *     编辑/重新生成的语义(输入 + 它的回复一起回退);
 *   - tail :遮蔽「目标所在轮首 .. 节点序列末尾」——撤回/重新开始的语义
 *     (目标轮内任何位置都回退到轮首,防孤立输入;一直遮蔽到尾部);
 *   **两种模式共用同一条轮首回退规则**(这是审计指出的分叉点:业务层 tail 曾
 *   只从目标自身位置切到尾部,适配层 tail 回退到轮首 → 同一输入两种结果)。
 *
 * 纯模块:零 import、零平台依赖(动态插件 realm 可 inline,浏览器/Node 同构)。
 */

/**
 * 遮蔽计算结果的显式状态。
 *
 * | 状态             | 含义                                             | 调用方语义            |
 * |------------------|--------------------------------------------------|-----------------------|
 * | ok               | 找到 span                                        | 用 span 写遮蔽        |
 * | not-found        | 快照里没有这个目标(seq 空洞 / 事件列表不可读)   | 明确的 not-found 错误 |
 * | already-shadowed | 目标在日志里,但已被更早的 replace 移出当前面     | target-shadowed(只读) |
 * | not-persisted    | 目标尚未落盘(刚 commit,文件快照还没它)          | message-pending(可重试)|
 * | replay-failed    | 面重放(foldSurface)失败 —— 内部错误,非用户问题  | 内部错误(绝不冒充遮蔽) |
 */
export const SPAN_STATUS = Object.freeze({
  OK: 'ok',
  NOT_FOUND: 'not-found',
  ALREADY_SHADOWED: 'already-shadowed',
  NOT_PERSISTED: 'not-persisted',
  REPLAY_FAILED: 'replay-failed',
})

/** 遮蔽模式(语义见文件头)。
 */
export const SPAN_MODE = Object.freeze({
  ROUND: 'round',
  TAIL: 'tail',
})

/** 该值是否合法状态(契约校验用;不引依赖)。 */
export function isSpanStatus(value) {
  return value === SPAN_STATUS.OK || value === SPAN_STATUS.NOT_FOUND ||
    value === SPAN_STATUS.ALREADY_SHADOWED || value === SPAN_STATUS.NOT_PERSISTED ||
    value === SPAN_STATUS.REPLAY_FAILED
}

/**
 * 轮边界谓词(事件形态,单一真相)——真实用户输入才是轮边界。
 *
 * 运行时也会为注入上下文/steering 追加 `user/message`(source.kind !== 'user',
 * 例如环境快照);它们**不得**切分一个交换轮,否则遮蔽范围会把注入节点当轮首。
 * @param {{type?:string, data?:{source?:{kind?:string}}}} event
 */
export function isRoundBoundaryEvent(event) {
  return event?.type === 'user/message' && event?.data?.source?.kind === 'user'
}

/**
 * 目标位置 → 轮首位置(向前找最近的轮边界;找不到则停在目标自身位置)。
 * 唯一实现:业务层与适配层的 round/tail 共用(审计第 2 项的分叉点就在这条规则)。
 */
export function roundStartIndex(nodes, index, isBoundary) {
  for (let i = index; i >= 0; i--) {
    if (isBoundary(nodes[i])) return i
  }
  return index
}

/** 轮首位置 → 轮尾位置(向后找下一个轮边界前一位;没有则到序列末尾)。 */
export function roundEndIndex(nodes, startIndex, isBoundary) {
  for (let i = startIndex + 1; i < nodes.length; i++) {
    if (isBoundary(nodes[i])) return i - 1
  }
  return nodes.length - 1
}

/** 位置段 [startPos..endPos] → span 结构(空段 → null)。 */
export function spanSliceOf(nodes, startPos, endPos) {
  const shadowedSeqs = nodes.slice(startPos, endPos + 1)
  if (shadowedSeqs.length === 0) return null
  return {
    start: shadowedSeqs[0],
    end: shadowedSeqs[shadowedSeqs.length - 1],
    shadowedSeqs,
  }
}

/**
 * 遮蔽范围规则(唯一实现)——给定节点序列与目标**位置**,按模式给出位置段。
 * @param {Array<number>} nodes - 当前面的节点 seq(位置序,非 seq 单调)。
 * @param {number} index - 目标在 nodes 中的位置。
 * @param {object} [options]
 * @param {'round'|'tail'} [options.mode='round'] - 语义见文件头。
 * @param {(node:number)=>boolean} [options.isBoundary] - 轮边界谓词(按节点 seq 判)。
 * @returns {{start:number,end:number,shadowedSeqs:number[]}|null}
 */
export function spanAt(nodes, index, options = {}) {
  const { mode = SPAN_MODE.ROUND, isBoundary = () => false  } = options
  if (!Array.isArray(nodes) || nodes.length === 0) return null
  if (!Number.isInteger(index) || index < 0 || index >= nodes.length) return null
  // round/tail 共用轮首回退;两者只差"到哪里结束"
  const startPos = roundStartIndex(nodes, index, isBoundary)
  const endPos = mode === SPAN_MODE.TAIL
    ? nodes.length - 1
    : roundEndIndex(nodes, startPos, isBoundary)
  return spanSliceOf(nodes, startPos, endPos)
}

/** 目标 seq → span(节点序列里找不到目标 → null;两层统一入口)。 */
export function spanForSeq(nodes, seq, options = {}) {
  if (!Array.isArray(nodes)) return null
  const index = nodes.indexOf(seq)
  if (index === -1) return null
  return spanAt(nodes, index, options)
}

/** 成功结果(统一结构;调用方不组装裸对象)。 */
export function spanOk(span, facts) {
  return { status: SPAN_STATUS.OK, span, facts }
}

/** 失败结果(status 显式;span 恒为 null,不再让 null 承载多种语义)。 */
export function spanMiss(status, facts) {
  return { status, span: null, facts }
}

/**
 * 计算结果 → 业务层判定输入(args.spanStatus / args.spanFacts)。
 *
 * 只在**文件侧确有快照证据**时下传(fileMaxSeq >= 0):文件不可读时无证据,
 * 交回业务层按内存视图判定(0.4.24 及以前的行为,不变)。
 * @returns {{spanStatus:string, spanFacts:object}|null} null = 无需下传/调用方自行判定
 */
export function spanMissArgsOf(result) {
  if (!result || typeof result !== 'object') return null
  if (result.status === SPAN_STATUS.OK || result.span) return null
  const facts = result.facts
  if (!facts || typeof facts.fileMaxSeq !== 'number' || facts.fileMaxSeq < 0) return null
  return { spanStatus: result.status, spanFacts: facts }
}

/** 日志用一行摘要(span 长度 / 状态 + 快照事实)。 */
export function describeSpanResult(result) {
  if (!result || typeof result !== 'object') return 'no-result'
  const facts = result.facts ?? {}
  const tail = `targetSeq=${Number.isSafeInteger(facts.targetSeq) ? facts.targetSeq : -1},fileMaxSeq=${Number.isSafeInteger(facts.fileMaxSeq) ? facts.fileMaxSeq : -1}`
  if (result.status === SPAN_STATUS.OK) {
    const n = Array.isArray(result.span?.shadowedSeqs) ? result.span.shadowedSeqs.length : 0
    return `${SPAN_STATUS.OK}:${n} seqs(${tail})`
  }
  return `${result.status}(${tail})`
}
