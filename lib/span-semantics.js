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
 * @public-note:start
 * - range:遮蔽 [startSeq .. endSeq] 位置连续段——完成块(能力)。
 *   区间**不拆工具对**:`tool/call` 与配对的 `tool/result`(内核口径 = 同 turn +
 *   同 step + callId)必须同进同出(见 expandRangeForToolPairs)——否则面里会留下
 *   「有 result 无 call / 有 call 无 result」,写前守卫按 W1 拒绝(严格端点
 *   INVALID_REQUEST)。
 * @public-note:end
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
 * @public-note:start
 * range 属扩展能力(公开层不提供)。
 * @public-note:end
 */
export const SPAN_MODE = Object.freeze({
  ROUND: 'round',
  TAIL: 'tail',
  RANGE: 'range', // @public-note-line
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

/* @public-note:start */
/**
 * 工具对配对键(内核口径的**单一真相**;逐字依据 @deepseek-ai/dsh-session
 * 0.1.7-rc.2,真实安装位置 =
 * `neutral/profiles/desktop/node_modules/dsh-retrace/node_modules/@deepseek-ai/dsh-session/lib/`):
 *
 *   - `lib/invariant.js`  `case "tool/call":` → `requireOpenStep(trace,
 *     "tool/call", event.data.turn, event.data.step, fail)` +
 *     `pendingCalls = { kind: "add", callId: event.data.callId }`;
 *   - `lib/invariant.js`  `case "tool/result":` → `requireOpenStep(trace,
 *     "tool/result", event.data.turn, event.data.step, fail)` +
 *     `const callId = event.data.message.source.callId;` +
 *     `if (!trace.pendingCalls.has(callId) && !syntheticNotStarted) fail(\`tool/result
 *     for ${callId} with no prior tool/call in this step\`)`;
 *   - `lib/invariant.js`  `case "step/end":` → `pendingCalls = { kind: "clear" }`
 *     (待配对集合**按 step 清空** ⇒ 配对作用域 = 同一 open step);
 *   - `lib/index.js`    运行时同口径(`step/end` → `pendingCalls.clear()`;
 *     `tool/result` → `pendingCalls.delete(event.data.message.source.callId)`)。
 *
 * ⇒ 配对键 = **turn + step + callId**;`callId` 取值:call 侧 `data.callId`,
 * result 侧 `data.message.source.callId`。字段不整(缺 turn/step)即不配对 ——
 * 与内核 `requireOpenStep` 的拒绝一致(不猜、不按命名放宽)。
 * 合成结果 `TOOL_NOT_STARTED`(`lib/invariant.js`)内核豁免,本函数不特殊处理:
 * 它没有前置 call 时自然无从扩展(绝不凭空造 seq)。
 *
 * @param {object} event - 事件载荷(`{type,data}`;可为 undefined/空洞)。
 * @returns {{side:'call'|'result',callId:string,key:string}|null}
 */
export function toolPairOf(event) {
  const type = event?.type
  if (type !== 'tool/call' && type !== 'tool/result') return null
  const turn = event.data?.turn
  const step = event.data?.step
  const callId = type === 'tool/call' ? event.data?.callId : event.data?.message?.source?.callId
  if (typeof callId !== 'string' || callId === '') return null
  if (!Number.isSafeInteger(turn) || !Number.isSafeInteger(step)) return null
  return { side: type === 'tool/call' ? 'call' : 'result', callId, key: `${turn}/${step}/${callId}` }
}

/**
 * `assistant/message` 里 tool-call 块的 callId(内核**运行时** wire 配对口径:
 * `lib/index.js` `for (const block of event.data.message.content) if
 * (block.type === "tool-call") pendingCalls.set(block.id, { step: event.data.step })`,
 * 与 `lib/index.js` 的 `pendingCalls.delete(event.data.message.source.callId)`
 * 成对)。这同时是写前守卫 W1(`dsh-log-contract/lib/checks.js,767-784`)的
 * 配对来源 —— 守卫只把 assistant tool-call 计为 pending,`tool/call` 事件不计。
 *
 * @param {object} event
 * @returns {string[]} tool-call 块 id 列表(非 assistant / 无块 → [])。
 */
export function assistantToolCallIdsOf(event) {
  if (event?.type !== 'assistant/message') return []
  const content = event.data?.message?.content
  if (!Array.isArray(content)) return []
  const ids = []
  for (const block of content) {
    if (block?.type === 'tool-call' && typeof block.id === 'string' && block.id !== '') ids.push(block.id)
  }
  return ids
}

/** 内核 wire 配对键(assistant tool-call 与 tool/result 同 step + 同 callId)。 */
function wirePairKeyOf(step, callId) {
  return Number.isSafeInteger(step) ? `${step}:${callId}` : `?:${callId}`
}

/**
 * 「工具对不拆」区间稳定化:把位置段 [startPos..endPos] **迭代扩展**到没有任何
 * 只覆盖配对一侧的工具对为止。
 *
 * 约束:
 *   - `tool/call` ↔ 同 turn+step+callId 的 `tool/result`(内核 invariant 口径,
 *     见 `toolPairOf`);**包含一侧 ⇒ 必须同时包含另一侧**(向对应方向扩位置)。
 *   - `options.pairAssistantTools === true` 时再加一条:assistant/message 的
 *     tool-call 块 ↔ 同 step+callId 的 `tool/result`(内核运行时口径 =
 *     守卫 W1 的 wire 口径)。缺省 false ⇒ 严格只做需求里的 tool/call 配对。
 *
 * 扩展语义:
 *   - 扩展只到**配对事件自身的位置**(区间仍是连续位置段),不多吞无关轮次;
 *     扩展后可能纳入新的工具对 ⇒ 循环到稳定(lo 只减 / hi 只增,必然收敛)。
 *   - 另一侧在当前面里不存在(未落盘 / 已被遮蔽 / 合成 `TOOL_NOT_STARTED`)⇒
 *     无从扩展,原样返回(绝不凭空造 seq)。
 *   - 无 `eventOf`(调用方拿不到事件载荷)⇒ 原样返回 —— 调用方的旧行为逐字节不变。
 *
 * @param {number[]} nodes - 面节点 seq(位置序,非 seq 单调)。
 * @param {number} startPos - 区间起点位置(含)。
 * @param {number} endPos - 区间终点位置(含)。
 * @param {(seq:number)=>object|undefined} [eventOf] - seq → 事件载荷。
 * @param {{pairAssistantTools?:boolean}} [options]
 * @returns {{startPos:number,endPos:number}} 稳定化后的位置段(不合法输入原样)。
 */
export function expandRangeForToolPairs(nodes, startPos, endPos, eventOf, options = {}) {
  const stable = { startPos, endPos }
  if (!Array.isArray(nodes) || nodes.length === 0) return stable
  if (!Number.isInteger(startPos) || !Number.isInteger(endPos)) return stable
  if (startPos < 0 || endPos < startPos || endPos >= nodes.length) return stable
  if (typeof eventOf !== 'function') return stable
  const pairAssistant = options?.pairAssistantTools === true

  // ① 预索引:每侧只取**首次**出现位置(重复 callId 属病态日志,不与内核的
  //    单值 pendingCalls 语义赛跑;首次出现 = 面位置序上最早的合法配对点)。
  const first = (map, key, pos) => { if (!map.has(key)) map.set(key, pos) }
  const kernelCall = new Map()
  const kernelResult = new Map()
  const wireAssistant = new Map()
  const wireResult = new Map()
  for (let i = 0; i < nodes.length; i++) {
    const event = eventOf(nodes[i])
    if (!event) continue
    const pair = toolPairOf(event)
    if (pair) {
      if (pair.side === 'call') first(kernelCall, pair.key, i)
      else {
        first(kernelResult, pair.key, i)
        if (pairAssistant) first(wireResult, wirePairKeyOf(event.data?.step, pair.callId), i)
      }
      continue
    }
    if (pairAssistant) {
      for (const id of assistantToolCallIdsOf(event)) first(wireAssistant, wirePairKeyOf(event.data?.step, id), i)
    }
  }

  // ② 配对组:组内位置必须同进同出(至少两个位置才有约束)。
  const groups = new Map()
  const groupsByPos = new Map()
  const link = (groupKey, pos) => {
    if (typeof pos !== 'number') return
    let set = groups.get(groupKey)
    if (!set) { set = new Set(); groups.set(groupKey, set) }
    set.add(pos)
    const list = groupsByPos.get(pos)
    if (list) { if (!list.includes(groupKey)) list.push(groupKey) } else groupsByPos.set(pos, [groupKey])
  }
  for (const [key, pos] of kernelCall) link(`k:${key}`, pos)
  for (const [key, pos] of kernelResult) link(`k:${key}`, pos)
  if (pairAssistant) {
    for (const [key, pos] of wireAssistant) link(`w:${key}`, pos)
    for (const [key, pos] of wireResult) link(`w:${key}`, pos)
  }

  // ③ 迭代到稳定:扫当前段,任何组只要有一员在段内就把整组拉进段(lo 只减/hi 只增)。
  let lo = startPos
  let hi = endPos
  let changed = true
  while (changed) {
    changed = false
    for (let i = lo; i <= hi; i++) {
      const keys = groupsByPos.get(i)
      if (!keys) continue
      for (const key of keys) {
        for (const pos of groups.get(key)) {
          if (pos < lo) { lo = pos; changed = true } else if (pos > hi) { hi = pos; changed = true }
        }
      }
    }
  }
  return { startPos: lo, endPos: hi }
}
/* @public-note:end */

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
 * @public-note:start
 * @param {number} [options.endSeq] - range 模式区间终点 seq(须为节点)。
 * @param {(seq:number)=>object|undefined} [options.eventOf] - seq → 事件载荷;
 *   **给出**时 range 段按「工具对不拆」稳定化(expandRangeForToolPairs);
 *   缺省(旧调用方)⇒ 逐字节保持旧区间。
 * @param {boolean} [options.pairAssistantTools] - 稳定化时额外纳入
 *   assistant/message 的 tool-call 块 ↔ tool/result(守卫 W1 的 wire 口径;缺省 false)。
 * @public-note:end
 * @returns {{start:number,end:number,shadowedSeqs:number[]}|null}
 */
export function spanAt(nodes, index, options = {}) {
  const { mode = SPAN_MODE.ROUND, isBoundary = () => false /* @public-note:start */, endSeq, eventOf, pairAssistantTools /* @public-note:end */ } = options
  if (!Array.isArray(nodes) || nodes.length === 0) return null
  if (!Number.isInteger(index) || index < 0 || index >= nodes.length) return null
  /* @public-note:start */
  if (mode === SPAN_MODE.RANGE) {
    const endIndex = endSeq === undefined ? index : nodes.indexOf(endSeq)
    if (endIndex === -1 || index > endIndex) return null
    // 区间不拆工具对:包含 tool/call 或 tool/result 一侧 ⇒ 迭代扩展到配对侧也在段内。
    const stable = expandRangeForToolPairs(nodes, index, endIndex, eventOf, { pairAssistantTools })
    return spanSliceOf(nodes, stable.startPos, stable.endPos)
  }
  /* @public-note:end */
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
