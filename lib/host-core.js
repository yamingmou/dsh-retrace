/**
 * dsh-retrace — Host core.
 *
 * Shared business logic for message recall (撤回), edit-and-resend (编辑重发)
 * and regenerate (重新生成) over one DSH Session.
 *
 * The DSH conversation log is append-only, but the model-visible *surface*
 * supports positional replacement (the same primitive compaction uses): a new
 * surface-eligible event carrying `surfaceOp: { op: 'replace', start, end }`
 * shadows every node in [start..end] from the derived model history. This
 * module asks the injected writer for the **two-segment carrier** the official
 * format actually allows — a log-only `compaction/prune` audit event plus a
 * `user/message` replacement whose `content` carries the recall/fold trace text
 * (shape rules in lib/marker-carrier.js) — so the conversation rewinds to before
 * the target while the durable transcript keeps an audit trail AND the model
 * sees a short, honest trace instead of the removed content.
 *
 * Pure ESM with zero **platform** imports: safe to run inside the dynamic-package
 * sandbox and inside a published package alike. Every op resolves to a transport-
 * neutral result object `{ ok: true, value }` or `{ ok: false, error }` and
 * never rejects (transport failures are the caller's concern).
 *
 * ——本文件的两处收敛:
 * 1. **span 语义单一真相**(第 2 项):轮首回退/尾部切片/区间段规则搬去
 *    lib/span-semantics.js(spanAt),本文件只提供「节点序列 + 轮边界谓词」——
 *    此前业务层(本文件)与适配层(adapter/dsh.js)各写一份切片规则,语义迟早
 *    分叉(审计:"预览与写入迟早对不上")。
 * 2. **span 未命中的判定读显式状态**(第 1 项):args.spanStatus(文件层给出的
 *    SPAN_STATUS)优先;无状态(文件不可读/直接调用/测试桩)才回落到内存判定。
 */
import { SPAN_STATUS, spanForSeq, isRoundBoundaryEvent, roundStartIndex } from './span-semantics.js'
import { assertSpanShape, assertMarkerShape } from './adapter/contract.js'
import { MARKER_ID_PREFIXES, carrierShadowedSeqs, isCarrierMarkerEvent } from './marker-carrier.js'
// Host event-view compatibility (new host: snapshotEvents/eventAt; old host: events array).
import { sessionEvents, eventAt } from './host-compat.js'

export const EDITOR_PLUGIN = 'retrace'

/**
 * Message-id prefix every event this plugin appends carries (client discriminator).
 * RENAME RULE: when the plugin changes identity, KEEP this prefix unchanged for
 * new markers — or, if it must change, add the old value to the legacy prefix
 * lists in lib/client.js (MARKER_PREFIXES / LEGACY_MARKER_PREFIXES) and
 * lib/version-index.js (MARKER_ID_PREFIXES) so old markers keep rendering and
 * classifying. Recognition must never be broken by a rename.
 */
export const MARKER_ID_PREFIX = 'retrace'

/** A fresh marker event id: `<prefix>-<op>-<time36>-<rand>`. */
export function editorId(op) {
  return `${MARKER_ID_PREFIX}-${op}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** An error carrying a stable wire `code` (mirrors the editor result shape). */
export function editorError(code, message, details) {
  const error = new Error(message)
  error.code = code
  // 附带结构化排查信息(messageId/seq 等),经 op 信封透传到 wire
  if (details && typeof details === 'object') error.details = details
  return error
}

/**
 * 目标被更早 fold/recall/compact 遮蔽(历史只读)——文案给正解:
 * 展开该块后编辑,或追加新消息修订。host 侧即中文(不再透传英文),
 * client 按 code 再本地化(zh/en 同文案,见 lib/client.js error.*)。
 */
export const SHADOWED_TARGET_MESSAGE = '该消息位于已折叠块(历史只读):展开该块后编辑,或追加新消息修订'

/**
 * 目标消息「提交中」(刚 commit/文件 flush 滞后,span 快照尚未纳入)
 * ——可重试,不是用户消息出了问题。
 */
export const PENDING_TARGET_MESSAGE = '消息生成中,完成后可编辑'

/**
 * 遮蔽范围重放失败(内部错误)。之前这类失败与「已被遮蔽」
 * 共用 null → 用户看到"历史只读"(误导且不可行动);现在如实报内部错误。
 */
export const SPAN_REPLAY_FAILED_MESSAGE = '遮蔽范围计算失败(内部错误):会话日志重放异常,请重试或反馈该会话'

/** 文件侧确证目标不存在(不是"提交中",也不是"被遮蔽")时的文案。 */
export const TARGET_NOT_FOUND_MESSAGE = '目标消息不在会话日志中(可能已删除或消息 id 无效)'

// ─────────────────────────────────────────────────────────────────────────────
// 撤销撤回(unhide)—— 0.4.124
//
// 需求:界面要提供「撤销撤回」这一操作,把被隐藏的消息恢复显示。
// 这里补上它需要的 append-only 写入:写一条「取消标记」,语义 = 取消某个既有
// marker 的**隐藏效果**。
//
// 形状(与既有两段 marker **不同**:只写 1 段):`user/message` + `surfaceOp: 'append'`。
//   ① **只有 1 段**。既有 marker 的第 1 段 `compaction/prune` 是官方 shadow-price claim
//      (`shadowedTokenCount` = 被遮蔽区间的令牌价),再写一段 = 再声称一次"这些节点
//      被遮蔽"⇒ 等于又隐藏一遍,方向相反。⛔ 绝不写。
//   ② `surfaceOp: 'append'`(**不是** replace)。撤销的是"显示",不是"面":
//      - replace 的官方语义(`dsh-session` 的 `replacementRange`)必然要求 start/end 是
//        当前面上的节点,并把该区间**移出**面 ⇒ 若照搬 marker 的 replace,原 marker
//        载体本身会从面上被换掉,客户端连"被取消的是哪条 marker"都看不到
//        (要求:被取消的 marker 自己的 notice 行要显示「已恢复」);
//      - append 是**只增不减**:面(模型上下文)与日志的既有行**一个字节都不动**,
//        只多一条人读留痕 ⇒ 与"append-only,绝不改写/删除既有日志行"的要求同向。
//   ③ data 用官方 `user/message` 词表的四成员 {role,id,content,source} **加**两个
//      业务成员 {op:'unhide', cancels:<marker seq>}。加成员是被允许的:内核消息形状
//      校验(`dsh-session/lib/index.js` 的 assertMessageEventShape)只查
//      id/role/source/content,不做精确键集校验;`dsh-log-contract` 的 E6 同口径
//      
//      test/unhide.test.js「真实 dsh-log-contract」用例)。
//   ④ `cancels` 取**被取消 marker 载体的 seq**(非 marker id):规则是"哪一个既有
//      日志行被取消",seq 是 append-only 日志里的稳定最小标识;客户端 marker 节点上
//      本来就有 `data.seq`(hidePlan 的消费侧直接可用),而 id 需要再解析一层。
//      读端宽进:id 也认(手工修过的日志/未来写入端改口径都不至于静默失效)。
//   ⑤ `source.kind = 'model'`(与既有载体同一原因):轮边界谓词只认 kind==='user',
//      写 'user' 会被当成真实用户输入、切分交换轮。
//   ⑥ `content` 非空人读文案:空 content 会投影成"用户发了空消息"。
// ─────────────────────────────────────────────────────────────────────────────

/** 撤销撤回的 op 名(客户端 callOp / harness retrace.unhide / HTTP 路由段同名)。 */
export const UNHIDE_OP = 'unhide'

/**
 * 取消标记的**独立 id 前缀** = `<MARKER_ID_PREFIX>-unhide-`。
 * ⛔ 不复用 `retrace-restore-`(已被回档 marker 占用,客户端映射为 op:'restore'
 * + 文案「已回退到该档位」),也⛔ 不用 recall/edit/regenerate/fold 前缀
 * (会被当成新的隐藏标记)。
 */
export const UNHIDE_ID_PREFIX = `${MARKER_ID_PREFIX}-${UNHIDE_OP}-`

/** 取消标记的正文(人读一句话;非空——空 content 会被读成"用户发了空消息")。 */
export const UNHIDE_TRACE_TEXT = '（已恢复显示被撤回的内容：这些内容重新可见；模型上下文与撤回痕迹不变，日志只增不减）'

/** 本插件 marker id 的 op 段(客户端 markerOpFromId 的宿主侧同口径;两端各自持有,不跨 realm import)。 */
const MARKER_OP_SEGMENTS = ['unhide', 'recall', 'edit', 'regenerate', 'restore', 'fold']

/* ═══════════════════════════════════════════════════════════════════════════
 * 真正恢复(true restore,`unshadow`)—— 0.4.126
 *
 * 与 `unhide`(只恢复**显示**,单段 append,模型面不变)并列的第二条替代操作:
 * 把目标 marker 的**两段**(载体 user/message+replace + 配对 compaction/prune 审计)
 * 在**日志层**原地中和成 log-only 形状(surfaceOp/sourceEventSeqs 删除、type 改
 * `retrace/marker`、`ignorable:true`、seq/行数/时间/data 一律不动)⇒ 官方 fold 不再
 * 遮蔽该区间 ⇒ 区间回到**模型面**,`target-shadowed` 消失,编辑/重发/撤回入口复活。
 *
 * 为什么不是追加一条事件(第 1 步调研结论,逐字依据):官方 surfaceOp 词表**封闭**
 * (`@deepseek-ai/dsh-session` 0.1.7-rc.2 `lib/index.js-308`:只有 `"append"` 与
 * 恰好三成员的 `{op:'replace',startSeq,endSeq}`),**没有** un-replace/unfold/restore;
 * 而 fold 用 `splice` 把替换区间移出面(`:443-452`/`:460-472`)⇒ append-only 日志
 * 在数学上无法把已移除节点放回面。
 *
 * 本文件只做**业务判定与错误翻译**,文件手术(帧级最小改写 + 备份 + 写后校验)全部
 * 隔离在注入面 `hooks.trueRestore`(lib/rollback.js 的 createTrueRestore)→ host-core
 * 保持零平台 import(动态插件 realm 可运行)。
 * ⛔ `NEUTRALIZED_MARKER_TYPE` 的两处持有由 test/true-restore.test.js 的成对用例钉死。
 * ═════════════════════════════════════════════════════════════════════════ */

/** 真正恢复的 op 名(客户端 callOp / harness retrace.unshadow / HTTP 路由段同名)。 */
export const UNSHADOW_OP = 'unshadow'

/** 中和态的 type(与 lib/rollback.js 的 NEUTRALIZED_MARKER_TYPE 同值,两处各自持有)。 */
export const NEUTRALIZED_MARKER_TYPE = 'retrace/marker'

/** 事件是否已是中和态(log-only 形状:type 命中 + ignorable + 无 surfaceOp/sourceEventSeqs)。 */
export function isNeutralizedMarkerEvent(event) {
  return event?.type === NEUTRALIZED_MARKER_TYPE
    && event.ignorable === true
    && event.surfaceOp === undefined
    && event.sourceEventSeqs === undefined
}

/**
 * 本插件 marker id → op 段('' = 不是本插件 marker id)。
 * ⚠️ 与 lib/client.js 的 `markerOpFromId` 同词表:两处**各自持有**(客户端 bundle 与
 * 宿主 host-core 不能互相 import),由 test/unhide.test.js 的成对用例钉住。
 */
export function markerOpOfMarkerId(id) {
  if (typeof id !== 'string' || id.length === 0) return ''
  for (const prefix of MARKER_ID_PREFIXES) {
    for (const op of MARKER_OP_SEGMENTS) {
      if (id.startsWith(`${prefix}-${op}-`)) return op
    }
  }
  return ''
}

/** Latest known provider/model: from the last request header, else last assistant message. */
export function lastModelSource(session) {
  const events = sessionEvents(session)
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event.type === 'request/header') {
      const config = event.data?.header?.config
      if (
        config &&
        typeof config.provider === 'string' && config.provider.length > 0 &&
        typeof config.model === 'string' && config.model.length > 0
      ) {
        return { provider: config.provider, model: config.model }
      }
    }
    if (event.type === 'assistant/message') {
      const source = event.data?.message?.source
      if (
        source && source.kind === 'model' &&
        typeof source.provider === 'string' && source.provider.length > 0 &&
        typeof source.model === 'string' && source.model.length > 0
      ) {
        return { provider: source.provider, model: source.model }
      }
    }
  }
  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// 撤回 · 连带终止本轮派生任务（方案 A）
//
// 现场缺陷：撤回只停"当前这一轮"（客户端 pauseRunningTurn → 会话 cancel，加上本
// 文件的 ensureIdle），**本轮派生出去的子代理会话与后台作业不在终止范围内**
// ⇒ 撤回之后它们继续往各自的会话写事件，时间线又继续了。
//
// 只终止与本轮有**明确创建关系**的任务，不按"时间接近"猜。规则三条：
//  ① 子代理会话（continuable child）—— 父会话**自己日志里**的 `subagent/catalog`
//     事件是唯一结构化创建凭据：
//       parent.append('subagent/catalog', {version,childId,childCreatedAt,mode,label})
//     （写入实现见 `@deepseek-ai/dsh-subagent` 的 catalog.js `establishCatalogChild`
//      与 continuation.js 的子会话建立处——子会话建立时同步追加到**父**会话。）
//     该事件在父会话日志里有**持久 seq** ⇒「创建发生在被撤回的这段历史里」是日志
//     事实，不是猜测。子会话自己的 v4 header 另带 parentSession / origin:'subagent'
//     / delegationDepth，可作交叉核对（host-core 不需要读它）。
//  ② 后台作业 —— 官方 jobs 注册表（owner = 本会话 agent id）∩ 区间内的**创建公告**。
//     已审计的两个产出者与其公告原文：
//       · dsh-tool-subagent 的 `started background subagent job <jobId>`
//       · dsh-tool-workflow  的 `started in the background as job <jobId>.`
//     仅「id 出现在区间内的创建公告里 且 owner === 本会话 且 未结算」的作业进集合；
//     区间内被 job_output 一类调用**提到**的老作业不算（防误杀）。
//  ③ 脚本/子进程 —— 随其作业终止回收（作业产出者自己实现 cancel，例如向进程组发
//     信号）；本文件不越过作业所有权另发信号（也没有平台能力）。
//  ④ 前台（阻塞）子代理 —— 随父轮次 cancel 一起中止（见 ensureIdle），不单独枚举。
//
// 执行顺序（**全部在写 marker 之前完成**，见 recall op）：
//   枚举 → 并发终止（每目标一个超时，默认 10s） → 静默确认（status 离开
//   running/stopping） → 写 marker → 写后核对（默认等 3s，断言新事件数 = 0）。
// 静默确认超时也放行写 marker，但如实记入"未静默集合"并落宿主日志。
//
// 兜底提示（不是可选项，但只在极低概率下出现）：仅当 ①确实枚举到任务
// ②终止调用失败/抛错、或终止调用成功但静默确认超时（等价：没停成）
// ③重试 1 次仍失败/仍未静默 时，recall 结果才附**一条**指名道姓的 `derivedNotice`
// （哪个任务没停 + 怎么手动停）。状态面不可读**单独**不构成提示（没有"它还在跑"
// 的证据），只如实记 `verified:false` + 宿主日志。
// 正常路径出现次数恒为 0（由 test/rollback-derived-tasks.test.js 的断言钉住）。
// ─────────────────────────────────────────────────────────────────────────────

/** 每个派生任务的终止调用上限（默认；op 参数 `derivedTerminateMs` 可覆盖）。 */
export const DERIVED_TERMINATE_TIMEOUT_MS = 10000
/** 终止后等「全部静默」的上限（默认；op 参数 `derivedQuietMs` 可覆盖）。 */
export const DERIVED_QUIET_TIMEOUT_MS = 10000
/** 写 marker 之后的核对窗口，默认 3s（op 参数 `derivedVerifyMs` 可覆盖）。 */
export const DERIVED_VERIFY_MS = 3000
/** 静默确认轮询间隔（op 参数 `derivedPollMs` 可覆盖）。 */
export const DERIVED_POLL_MS = 200
/** 兜底提示的终止重试次数（1 次；op 参数 `derivedRetries` 可覆盖）。 */
export const DERIVED_RETRIES = 1

/**
 * 后台作业**创建公告**的形态（逐条对应一个已审计的产出者，见上方 ②）：
 *   dsh-tool-subagent  `started background subagent job <jobId>`
 *   dsh-tool-workflow  `… started in the background as job <jobId>.`
 * 第三条是形态兜底：`started … job <id>`（新产出者只要沿用这句人读公告就能被认到）。
 * 提取出的 id 先与「本会话拥有的、未结算的作业」求交才算目标 ⇒ 误提取只会落空
 * （防误杀由这一次所有权求交保证，见 lib/index.js 的 derivedTasks 注入面）。
 */
const DERIVED_JOB_CREATION_PATTERNS = [
  /started background subagent job\s+([A-Za-z0-9._:-]+)/i,
  /started in the background as job\s+([A-Za-z0-9._:-]+)/i,
  /\bstarted\b[^.\n]{0,120}?\bjob\s+([A-Za-z0-9][A-Za-z0-9._:-]*)/i,
]

/** 一次事件里可读的文本字段（tool/call 的 arguments、tool/result 的两层 content）。 */
function derivedEventText(event) {
  const data = event?.data
  if (!data || typeof data !== 'object') return ''
  const parts = []
  if (typeof data.arguments === 'string') parts.push(data.arguments)
  const content = data.message?.content
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      if (typeof block.text === 'string') parts.push(block.text)
      if (Array.isArray(block.content)) {
        for (const inner of block.content) {
          if (inner && typeof inner.text === 'string') parts.push(inner.text)
        }
      }
    }
  }
  return parts.join('\n')
}

/** 事件 seq 是否落在被撤回区间内（span 的位置连续段 → 数值范围）。 */
export function inRecalledSpan(seq, span) {
  return Number.isSafeInteger(seq) && Number.isSafeInteger(span?.start) && Number.isSafeInteger(span?.end)
    && seq >= span.start && seq <= span.end
}

/**
 * 区间内的子代理创建事实 → 目标列表。
 * 规则 = 父会话日志里 `subagent/catalog` 事件（结构化创建凭据）的 **seq** 落在
 * `[span.start, span.end]` 内，目标 id = `data.childId`。
 * @param {Array} events - 父会话事件视图（sessionEvents）
 * @param {{start:number,end:number}} span - 被撤回区间
 * @returns {Array<{kind:'subagent',id:string,label:string,evidence:string}>}
 */
export function subagentTargetsInEvents(events, span) {
  const out = []
  if (!Array.isArray(events)) return out
  for (const event of events) {
    if (!event || event.type !== 'subagent/catalog') continue
    if (!inRecalledSpan(event.seq, span)) continue
    const id = event.data?.childId
    if (typeof id !== 'string' || id.length === 0) continue
    out.push({
      kind: 'subagent',
      id,
      label: typeof event.data?.label === 'string' ? event.data.label : '',
      evidence: `subagent/catalog seq=${event.seq}`,
    })
  }
  return out
}

/**
 * 区间内的后台作业**创建公告** → job id 候选。
 * 只管"日志里明说了刚启动了某个 job"；调用方仍须与本会话拥有的未结算作业求交
 * （所有权规则在平台侧，见 lib/index.js 的 derivedTasks 注入面）。
 * @param {Array} events - 会话事件视图
 * @param {{start:number,end:number}} span - 被撤回区间
 * @returns {string[]} job id 候选（去重）
 */
export function jobIdsInEvents(events, span) {
  const ids = new Set()
  if (!Array.isArray(events)) return []
  for (const event of events) {
    if (!event || !inRecalledSpan(event.seq, span)) continue
    const text = derivedEventText(event)
    if (text.length === 0) continue
    for (const pattern of DERIVED_JOB_CREATION_PATTERNS) {
      const match = pattern.exec(text)
      if (!match) continue
      const id = match[1].replace(/[.,;:]+$/, '')
      if (id.length > 0) ids.add(id)
    }
  }
  return [...ids]
}

/**
 * 「静止」规则：既不在跑、也不在收尾。
 * agent 侧 status ∈ {running, idle, …}，作业侧 status ∈ {running, stopping,
 * succeeded, failed, killed}（见 @deepseek-ai/dsh-jobs-local 的 killJob：先置
 * stopping，结算后才进终态）⇒ running 与 stopping 都**不算**停下来了。
 */
export function derivedStatusIsQuiet(status) {
  return status !== 'running' && status !== 'stopping'
}

/**
 * 兜底提示文案（**唯一**产出点）：指名道姓 + 怎么手动停。
 * @param {Array<{kind:string,id:string,status?:string,terminateError?:string|null}>} stuck
 * @returns {string} 空串 = 不需要提示（正常路径恒为空串）
 */
export function derivedStuckNotice(stuck) {
  if (!Array.isArray(stuck) || stuck.length === 0) return ''
  const lines = stuck.map((task) => {
    const why = task.terminateError ? `；终止调用失败：${task.terminateError}` : ''
    const status = typeof task.status === 'string' && task.status !== '' ? task.status : '未知'
    return task.kind === 'subagent'
      ? `子代理会话 ${task.id}（状态 ${status}${why}）：手动停止 → 用 interrupt_agent 中断它，或先切到该子会话再点停止。`
      : `后台作业 ${task.id}（状态 ${status}${why}）：手动停止 → 用 job_kill 指定 job_id=${task.id}。`
  })
  return `撤回已完成，但下列派生任务未能停止（时间线可能继续）：${lines.join(' ')}`
}

/**
 * 写「遮蔽 marker」——业务层唯一入口。
 *
 * 编辑/撤销/分支/跳过 = 通用消息列表投影操作，业务层只表达「遮蔽这些消息」
 * （span = {start, end, shadowedSeqs}）。**DSH 的 turn/step 翻译全部隔离在
 * adapter**（lib/adapter/dsh-writer.js：三情形 turn 赋值、完整 turn 信封、
 * agent-loop 计数器推进、step 号窗口化防御）——host-core 不感知 turn/step。
 *
 * 平台写入器经 hooks.writeMarker 注入（动态插件 realm 零 import，host-core
 * 不 import adapter；adapter 反向 import 本文件的 editorId/editorError/
 * lastModelSource）。
 */
export function createEditorApi(ctx, sessions, agents, log = () => {}, hooks = {}) {
  /** One in-flight op per session; later ops wait for the earlier one. */
  const locks = new Map()

  /**
   * Post-write observer (optional): the boundary was committed AND validated, so
   * the seam may now build its own artifact for it (the digest + the opt-in LLM
   * summary). It runs OUTSIDE the op path: a synchronous throw is logged and a
   * returned promise is deliberately not awaited, so an edit/recall never waits
   * on an artifact write or an LLM call.
   */
  function notifyBoundary(op, session, span, markerEvent, newText) {
    const hook = hooks.onBoundary
    if (typeof hook !== 'function') return
    try {
      hook({ op, sessionId: session?.id, session, markerSeq: markerEvent?.seq, span, newText })
    } catch (error) {
      log(`retrace: onBoundary hook failed: ${String(error?.message ?? error)}`)
    }
  }

  /**
   * 写「遮蔽 marker」——业务层唯一入口。
   * 平台写入器（DSH 三情形翻译）经 hooks.writeMarker 注入，本函数只组装
   * 业务意图（op + targetSeq + originalText）并转发；写入器缺失 = 平台未装配。
   */
  async function writeMarker(session, span, op, targetSeq, originalText) {
    const writer = hooks?.writeMarker
    if (typeof writer !== 'function') {
      throw editorError('writer-unavailable', 'No marker writer (adapter) is wired; cannot shadow messages.')
    }
    // 契约运行时化:业务层 → 适配器 = 跨层边界。
    // 传出去的 span 必须先合规(否则写入端 surfaceOp/sourceEventSeqs 会写出与
    // 重放面不一致的 marker)。违规 → contract-violation(指名道姓),绝不静默。
    // (可抛断言一律在**任何写入之前**——)
    assertSpanShape(span, 'host-core.writeMarker.span')
    const markerEvent = await writer(session, span, { op, targetSeq, originalText })
    try {
      // 出口自检:适配器返回的 marker 必须合规(下游读 seq/editor/surfaceOp 的假设前提)。
      // 注意:此时**已经写入**(真实写入器在 append 前自检,见 dsh-writer),拒绝
      // 半状态 —— 失败前先把已写内容落盘(否则"客户端报失败、面上其实已改")。
      assertMarkerShape(markerEvent, 'host-core.writeMarker.marker')
    } catch (error) {
      await flushSafely(session)
      throw error
    }
    return markerEvent
  }

  function locked(sessionId, fn) {
    const previous = locks.get(sessionId) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(fn)
    locks.set(sessionId, next)
    void next.finally(() => {
      if (locks.get(sessionId) === next) locks.delete(sessionId)
    }).catch(() => {})
    return next
  }

  function requireSession(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw editorError('bad-request', 'sessionId must be a non-empty string')
    }
    const session = sessions.get(sessionId)
    if (!session) throw editorError('session-not-found', `session "${sessionId}" not found`)
    return session
  }

  /**
   * 确保 agent 空闲（故障修复，按实测行为定案）：agent 正在响应时，
   * **不拒绝**——自动请求停止（`agent.cancel`）并等待其干净收尾（`whenIdle`）。
   *
   * 为什么必须等停止：编辑/重发发生在 agent 还开着 step 时，DSH 的 resend 机制
   * 会把旧 step 的 assistant/chunk 全部引用进新 assistant/message 的
   * `sourceEventSeqs`，
   * token-meter 对跨 step 引用抛 `belongs to another step`（dsh-token-meter
   * lib/index.js）→ 同样刷屏压垮 host。先停止 → step 干净关闭 → 编辑在
   * 轮次边界执行，不再触发跨 step 引用。
   *
   * agent 无 cancel/whenIdle（headless/测试桩）时回退为抛 agent-busy（原行为）。
   *
   * 两条加固（另一路勘察 + 本路逐字核对官方源码）：
   *   1) 排队窗口：规则加上 inbox 排队（见 inboxHasPending）；
   *   2) 等待上限：whenIdle 换成 whenIdleWithTimeout。
   */

  /** 停止等待上限（加固 2）：见 whenIdleWithTimeout。 */
  const AGENT_STOP_TIMEOUT_MS = 15000

  /**
   * 排队规则（加固 1，）。官方 Agent.inbox 公开面（逐字；两版内核同形状）：
   *   现役内核 0.1.7-rc.2 = @deepseek-ai/dsh-agent-loop/lib/index.js（桌面 app 内）
   *     :752  inbox;   ← ReactLoopAgent 字段
   *     :80/84/88  get nextTurn() / get nextStep() / get hasPending()
   *                → `state["next-turn"].length > 0 || state["next-step"].length > 0`(88-91）
   *     :815  cancel(cause, options) 默认 this.inbox.clear()(816-819）
   *   旧版内核 0.1.1-rc.2 = @deepseek-ai/dsh-agent/lib/index.js（profile 副本）
   *     :34/38/40-41  同名三面（hasPending = 两个排队列表非空）；:357 由 agent-loop 构造
   * agent 进 idle 相位后 status 读作 'idle'（现役 :790-792 / 旧版 dsh-agent-loop
   * lib/index.js-382：idle 与 maintenance 都映射成 'idle'），此时 inbox 里仍可能压着
   * 排队轮次；只按 status 判 ⇒ 撤回 marker 写完后排队轮次照跑，撤回语义被破坏。
   *
   * fail-soft（向后兼容）：旧内核或形状不同（无 inbox / 无布尔 hasPending /
   * getter 抛错）一律按「无排队」处理 —— 行为与改动前相同，只留一行日志，
   * 读 inbox 的任何异常都不外传。现役内核的 inbox 是投影驱动的：`current()` 在
   * 投影未注册时直接抛（现役 :174-177，抛点 :176），故这里的 try/catch 是真实路径而非摆设。
   */
  function inboxHasPending(agent) {
    let inbox
    try {
      inbox = agent?.inbox
    } catch (error) {
      log(`retrace: agent.inbox unreadable (treated as no pending work): ${String(error?.message ?? error)}`)
      return false
    }
    if (!inbox || typeof inbox !== 'object') return false
    try {
      if (typeof inbox.hasPending === 'boolean') return inbox.hasPending
      // 没有布尔 hasPending（形状略异）：只用官方那两个排队列表的数组长判空；
      // 两个都不是数组 ⇒ 判不了 ⇒ 不当作 pending。
      const nextTurn = Array.isArray(inbox.nextTurn) ? inbox.nextTurn.length : 0
      const nextStep = Array.isArray(inbox.nextStep) ? inbox.nextStep.length : 0
      return nextTurn + nextStep > 0
    } catch (error) {
      log(`retrace: agent.inbox.hasPending unreadable (treated as no pending work): ${String(error?.message ?? error)}`)
      return false
    }
  }

  /**
   * 「该会话有在途轮次吗」—— unshadow(以及任何就地改日志的写路径)的唯一会话态闸。
   * 规则来源(全部取自官方公开面,逐条):
   *   ① `session.isRunning === true`(客户端 runningState 的同源真值,见本文件 :1445 的既有读法);
   *   ② `agent.status` ∈ {running, stopping}——官方 Agent.status 相位串
   *      (现役 @deepseek-ai/dsh-agent-loop/lib/index.js-792 把 idle/maintenance 都映射成 idle,
   *       运行相位读作 'running';stopping 见作业侧的同类相位,见 derivedStatusIsQuiet 的注释);
   *   ③ `inboxHasPending(agent)` —— 已排队但还没开跑的轮次(规则与注入面注释见 inboxHasPending)。
   * 为什么停止之外还要看排队:排队轮次随时开跑 ⇒ 与本工具的「临时文件 + rename」并发写同一文件,
   * 追加可能落进被 unlink 的旧 inode(真丢数据),这不是"用户体验"闸而是数据完整性闸。
   * 读不到(旧内核/测试桩/字段抛错)一律按"无在途"放行(与改动前的 fail-soft 口径相同),
   * 只由调用方留痕 —— 不因为判不了就把入口彻底关死。
   * @returns {string} '' = 无在途;否则 'running-reply' | 'stopping-reply' | 'queued-turn'
   */
  function sessionInFlightReason(session, agent) {
    if (session?.isRunning === true) return 'running-reply'
    let status
    try {
      status = agent?.status
    } catch (error) {
      log(`retrace: agent.status unreadable (treated as no in-flight turn): ${String(error?.message ?? error)}`)
      status = undefined
    }
    if (status === 'running') return 'running-reply'
    if (status === 'stopping') return 'stopping-reply'
    if (inboxHasPending(agent)) return 'queued-turn'
    return ''
  }

  /**
   * 有上限地等 whenIdle（加固 2，）。
   * 官方实现 `async whenIdle() { do await (activity = this.activityDone); while (activity !== this.activityDone) }`
   * （现役 @deepseek-ai/dsh-agent-loop/lib/index.js-875；旧版同文件 :460-464）——
   * driver 卡在任一 await（工具/适配器不返回）时该 promise 一直不 settle，
   * 无上限的 await 会让 recall 请求永久 pending（HTTP 无响应，且同会话后续 op
   * 被 locked() 队列堵住）。超时抛错 → 既有 agent-stop-failed 出口。
   * 定时器 unref（可选链），不拖住进程/测试；两条路径都清掉定时器。
   */
  async function whenIdleWithTimeout(agent, timeoutMs = AGENT_STOP_TIMEOUT_MS) {
    let timer
    try {
      return await Promise.race([
        agent.whenIdle(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`agent.whenIdle() did not settle within ${timeoutMs}ms`))
          }, timeoutMs)
          timer.unref?.()
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  async function ensureIdle(agent) {
    let status
    try {
      status = agent?.status
    } catch (error) {
      log(`retrace: agent.status unreadable (treated as no active work): ${String(error?.message ?? error)}`)
      status = undefined
    }
    // status 面不可判定（旧内核/测试桩没有 status）⇒ 与改动前相同：直接放行，
    // 不因 inbox 有内容就改判（加固 1 只作用于 status 面可读的 agent）。
    if (typeof status !== 'string') return
    const running = status === 'running'
    const pending = inboxHasPending(agent)
    if (!running && !pending) return
    if (typeof agent.cancel === 'function' && typeof agent.whenIdle === 'function') {
      try {
        // 官方 AgentCancelCause 类型只有 user/parent/hook/disposed 四种
        // （dsh-commands typert.host.js）——用 { kind: 'user' } 与 UI 停止按钮同义，
        // 中断的 turn/end 会按官方语义记录 reason。
        agent.cancel({ kind: 'user' })
        await whenIdleWithTimeout(agent)
        return
      } catch (error) {
        throw editorError('agent-stop-failed', `Failed to stop the running reply before editing: ${String(error)}`)
      }
    }
    throw editorError(
      'agent-busy',
      'The agent is still responding. Stop the current reply before recalling or editing.',
    )
  }

  /** Locate the durable seq of a user/assistant message by its stable message id. */
  function findMessageSeq(session, messageId) {
    if (typeof messageId !== 'string' || messageId.length === 0) {
      throw editorError('bad-request', 'messageId must be a non-empty string')
    }
    const events = sessionEvents(session)
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]
      const id = event.type === 'user/message'
        ? event.data?.id
        : event.type === 'assistant/message'
          ? event.data?.message?.id
          : undefined
      if (typeof id === 'string' && id === messageId) return event.seq
    }
    return -1
  }

  /**
   * 遮蔽计算(彻底绕开稀疏 events):在 surface.nodes(全量 seq 列表)里
   * 找轮边界,不遍历稀疏的 host events 数组(host events 可能只加载部分,
   * 现场反馈 host 报 2006 vs 文件全量 10;稀疏遍历的 undefined 洞导致遮蔽全量)。
   *
   * 切片规则(轮首回退 / 尾部切片 / 区间段)**不再在本文件实现**,
   * 一律调用 lib/span-semantics.js 的 spanForSeq —— 与适配层(adapter/dsh.js 的
   * computeSpan,主路径用文件全量 + 官方 foldSurface nodes)同一实现,业务层与
   * 适配层的 span 语义从此不可能分叉(审计:"预览与写入迟早对不上")。
   * 本函数只负责:取节点序列(内存 surface.nodes)、给轮边界谓词、喂目标 seq。
   * - mode='round':遮蔽目标所在轮——edit/regenerate 用;
   * - mode='tail' :从目标轮首遮蔽到面尾——fromScratch/recall 用。
   */
  function shadowSpanFrom(session, startSeq, { mode = 'round' } = {}) {
    const events = sessionEvents(session)
    const nodes = Array.isArray(session.surface?.nodes) ? session.surface.nodes : []
    if (!Array.isArray(events) || !events[startSeq]) return null
    return spanForSeq(nodes, startSeq, {
      mode,
      isBoundary: (seq) => isRoundBoundary(events[seq]),
    })
  }

  /**
   * 轮边界谓词(单一真相):真实用户输入才是轮边界。运行时也会为注入
   * 上下文/steering 追加 `user/message`(source.kind !== 'user',如环境快照),
   * 它们**不得**切分一个交换轮。实现位于 lib/span-semantics.js(与适配层同一份,
   * 此前本文件与 dsh.js 各有一份重复拷贝)。
   */
  const isRoundBoundary = isRoundBoundaryEvent

  /**
   * The exchange-round span containing `seq`: the user input plus everything
   * the agent produced for it (all assistant/tool nodes up to the next user
   * input). Recalling one message therefore removes the whole round — input
   * AND output — from the model surface.
   *
   * 修复(彻底绕开稀疏 events):在 surface.nodes(全量 seq 列表)里找
   * 轮边界,不遍历稀疏的 host events 数组——host 的 events 可能只加载部分
   * 
   * 遍历时 undefined 洞导致找不到下一个 user → end 到尾部 → 遮蔽全量)。
   * events[nodes[i]] 只按需查「实际存在的节点」,不遍历空洞。
   */
  function roundSpanFrom(session, seq) {
    return shadowSpanFrom(session, seq, { mode: 'round' })
  }

  function extractUserText(content) {
    if (!Array.isArray(content)) return ''
    return content
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('')
  }

  /**
   * span 未命中 → 落成哪个错误码(判定 = **读显式状态**,不再靠 null 猜)。
   *
   * 首选证据:args.spanStatus —— 文件层(adapter/dsh.js computeSpan)给出的显式状态:
   *   not-persisted    → 'pending'     目标 seq 超出文件快照最大 seq(刚 commit 未 flush;
   *                                    可重试,`message-pending`);消息 id 在 append-only
   *                                    日志里找不到(同因)也归此;
   *   already-shadowed → 'shadowed'    目标在日志里但已被更早 replace 移出当前面(历史只读);
   *   not-found        → 'not-found'   文件快照可读却确证目标不存在;
   *   replay-failed    → 'replay-failed' 面重放失败(内部错误,绝不冒充"已遮蔽")。
   *
   * 回落证据(无状态:文件不可读 / 直接调用 host-core / 测试桩)——内存判定,与
   * 0.4.24 语义一致,分两步:
   *  1. 仅有 args.spanFacts(旧调用方兼容):目标 seq > 文件快照最大 seq → pending;
   *     否则 shadowed;
   *  2. 无文件事实 → 内存判:
   *     a. 更早 replace marker 的 sourceEventSeqs(data.shadowedSeqs 兜底)命中目标
   *        → shadowed(fold/recall/compact 的确定性证据);
   *     b. 目标事件存在且其 seq 超出 surface 已知最大节点(尾部最近 append,快照
   *        未纳入)→ pending;
   *     c. 其余无法判定 → shadowed(保守,保持 0.4.23 及以前的语义)。
   */
  function spanMissKind(session, seq, args) {
    const status = args?.spanStatus
    if (status === SPAN_STATUS.NOT_PERSISTED) return 'pending'
    if (status === SPAN_STATUS.ALREADY_SHADOWED) return 'shadowed'
    if (status === SPAN_STATUS.REPLAY_FAILED) return 'replay-failed'
    if (status === SPAN_STATUS.NOT_FOUND) {
      // 文件层只证明"快照里没有这个目标",未证明原因(未落盘 vs 不存在)——用它给的
      // 事实 + 我们手里的内存 seq 补足证据:
      //   快照已读到 fileMaxSeq,而目标在内存里的 seq **超出**快照末尾 → 尚未落盘 → 可重试;
      //   否则是快照覆盖了那一段却没有该 id → 明确的 not-found。
      const facts = args?.spanFacts
      if (facts && facts.targetSeq === -1 && typeof facts.fileMaxSeq === 'number'
        && facts.fileMaxSeq >= 0 && seq > facts.fileMaxSeq) return 'pending'
      return 'not-found'
    }
    const facts = args?.spanFacts
    if (facts && typeof facts.fileMaxSeq === 'number' && facts.fileMaxSeq >= 0) {
      return seq > facts.fileMaxSeq ? 'pending' : 'shadowed'
    }
    const events = sessionEvents(session)
    const nodes = Array.isArray(session.surface?.nodes) ? session.surface.nodes : []
    if (Array.isArray(events)) {
      for (let i = events.length - 1; i >= 0; i--) {
        const ev = events[i]
        if (!ev || ev.surfaceOp?.op !== 'replace') continue
        // 载体被遮蔽 seq 的取值口径(两段结构的第 2 段含审计 seq 引导项,旧形态不含)
        // 收敛到 marker-carrier 的单一实现,本文件不另写一份。
        const seqsOf = carrierShadowedSeqs(ev)
        const shadowedSeqs = seqsOf.length > 0 ? seqsOf : null
        if (shadowedSeqs && shadowedSeqs.includes(seq)) return 'shadowed'
      }
      if (events[seq]) {
        let maxNode = -1
        for (const s of nodes) if (typeof s === 'number' && s > maxNode) maxNode = s
        if (maxNode >= 0 && seq > maxNode) return 'pending'
        if (maxNode < 0) {
          // 无 surface 节点(surface 整体滞后/未加载):仅当目标是事件流最后一个真实
          // 消息事件时才判 pending(可重试);否则无法区分 → shadowed(保守)。
          for (let i = events.length - 1; i >= 0; i--) {
            const ev = events[i]
            if (ev && (ev.type === 'user/message' || ev.type === 'assistant/message')) {
              return ev.seq === seq ? 'pending' : 'shadowed'
            }
          }
        }
      }
    }
    return 'shadowed'
  }

  /**
   * replay-failed 的**判因细节**:该状态被两种原因共用
   * ——① 面重放**抛错** ② 面重放**正常但节点为空**(合法空面)。两者文案都是"内部错误",
   * 光看 code 无法判因;把适配器给的 facts 关键字段并进错误 details
   * (nodes / cause / fileMaxSeq / targetSeq),日志与前端就能区分。
   * 不新增 SPAN_STATUS 成员:状态机/契约/前端本地化都不扩散。
   */
  function replayFailedDetails(args) {
    const facts = args?.spanFacts
    if (!facts || typeof facts !== 'object') return {}
    const picked = {}
    if (typeof facts.nodes === 'number') picked.nodes = facts.nodes
    if (typeof facts.cause === 'string') picked.cause = facts.cause
    if (typeof facts.fileMaxSeq === 'number') picked.fileMaxSeq = facts.fileMaxSeq
    if (typeof facts.targetSeq === 'number') picked.targetSeq = facts.targetSeq
    return Object.keys(picked).length ? { spanFacts: picked } : {}
  }

  /**
   * span 未命中分支统一抛错:按**显式状态**给错误码——
   * pending → message-pending(可重试);shadowed → target-shadowed(中文可操作文案);
   * not-found → message-not-found(与内存侧 findMessageSeq 同一错误码);
   * replay-failed → span-replay-failed(内部错误,不冒充遮蔽;details 带判因 facts)。
   */
  function throwSpanMiss(session, seq, args, messageId) {
    const details = { messageId, seq }
    switch (spanMissKind(session, seq, args)) {
      case 'pending':
        throw editorError('message-pending', PENDING_TARGET_MESSAGE, details)
      case 'not-found':
        throw editorError('message-not-found', TARGET_NOT_FOUND_MESSAGE, details)
      case 'replay-failed':
        throw editorError('span-replay-failed', SPAN_REPLAY_FAILED_MESSAGE, { ...details, ...replayFailedDetails(args) })
      default:
        throw editorError('target-shadowed', SHADOWED_TARGET_MESSAGE, details)
    }
  }

  function resendMessage(text, op) {
    return {
      id: editorId(op),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user', rpcId: editorId('retrace') },
    }
  }

  async function flushSafely(session) {
    try {
      if (typeof sessions.flush === 'function') await sessions.flush(session)
    } catch (error) {
      log(`retrace: flush failed: ${String(error)}`)
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 撤回 · 连带终止派生任务（方案 A）——规则与顺序见文件头同名块。
  // 全部经 hooks 注入面调用，本文件零平台 import（动态插件 realm 照常可用）。
  //   hooks.derivedTasks({sessionId,session,span})  → 枚举（平台侧：全量文件日志 + jobs 注册表）
  //   hooks.interruptSubagent({sessionId,id,target})→ 终止子代理（等价官方 interrupt）
  //   hooks.killDerivedJob({sessionId,id,target})   → 终止作业（等价官方 job_kill）
  //   hooks.derivedStatus({sessionId,targets})      → [{kind,id,status,events}]（静默确认 + 写后核对）
  // ───────────────────────────────────────────────────────────────────────────

  /** 每次调用的超时/重试（op 参数可覆盖，默认见文件头常量）。 */
  function derivedOptions(args) {
    const num = (value, fallback) => (Number.isFinite(value) && value >= 0 ? value : fallback)
    return {
      terminateMs: num(args?.derivedTerminateMs, DERIVED_TERMINATE_TIMEOUT_MS),
      quietMs: num(args?.derivedQuietMs, DERIVED_QUIET_TIMEOUT_MS),
      verifyMs: num(args?.derivedVerifyMs, DERIVED_VERIFY_MS),
      pollMs: num(args?.derivedPollMs, DERIVED_POLL_MS),
      retries: Number.isSafeInteger(args?.derivedRetries) && args.derivedRetries >= 0 ? args.derivedRetries : DERIVED_RETRIES,
    }
  }

  const derivedSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

  /** 有上限地等一个 promise：超时/reject 都落成结果，不外抛、不产生未处理拒绝。 */
  function withDerivedTimeout(promise, ms) {
    let timer
    return Promise.race([
      Promise.resolve(promise).then(
        (value) => ({ timedOut: false, value }),
        (error) => ({ timedOut: false, error }),
      ),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), ms)
        timer.unref?.()
      }),
    ]).finally(() => clearTimeout(timer))
  }

  /** 平台枚举结果 → 目标列表（宽进：数组 / {subagents,jobs} / {subagentIds,jobIds}）。 */
  function normalizeDerivedTargets(raw) {
    const out = []
    const push = (kind, item) => {
      if (typeof item === 'string' && item.length > 0) {
        out.push({ kind, id: item, label: '', evidence: 'hook' })
        return
      }
      if (!item || typeof item.id !== 'string' || item.id.length === 0) return
      out.push({
        kind: typeof item.kind === 'string' && item.kind !== '' ? item.kind : kind,
        id: item.id,
        label: typeof item.label === 'string' ? item.label : '',
        evidence: typeof item.evidence === 'string' ? item.evidence : 'hook',
      })
    }
    if (!raw) return out
    if (Array.isArray(raw)) { for (const item of raw) push('subagent', item); return out }
    const groups = [[raw.subagents, 'subagent'], [raw.subagentIds, 'subagent'], [raw.jobs, 'job'], [raw.jobIds, 'job']]
    for (const [list, kind] of groups) {
      if (!Array.isArray(list)) continue
      for (const item of list) push(kind, item)
    }
    return out
  }

  /**
   * 枚举被撤回区间内派生出来的任务。
   * ①平台注入面（生产主路径，读全量文件日志 + 官方 jobs 注册表）
   * ②内存日志兜底（子代理：`subagent/catalog` 的持久 seq 落在区间内）
   * ③后台作业没有内存兜底：所有权与结算状态只有官方 jobs 注册表能给（规则见注释）
   */
  async function enumerateDerivedTargets(session, sessionId, span) {
    const found = new Map()
    const add = (target) => {
      if (!target || typeof target.id !== 'string' || target.id.length === 0) return
      const key = `${target.kind}:${target.id}`
      if (!found.has(key)) found.set(key, target)
    }
    if (typeof hooks?.derivedTasks === 'function') {
      try {
        const raw = await hooks.derivedTasks({ sessionId, session, span })
        for (const target of normalizeDerivedTargets(raw)) add(target)
      } catch (error) {
        log(`retrace: 派生任务枚举(平台注入面)失败，回落内存日志: ${String(error?.message ?? error)}`)
      }
    }
    for (const target of subagentTargetsInEvents(sessionEvents(session), span)) add(target)
    // ③ 后台作业**只**经平台注入面（见上）：判"是不是本轮的"要"创建公告落在区间内"，
    //    判"是不是本会话的、还开着"要官方 jobs 注册表的 owner/status —— 后者 host-core
    //    拿不到。⛔ 不按日志里的 id 猜着杀（那正是误杀别人的作业的方式）。
    return [...found.values()]
  }

  function derivedTargetKey(target) {
    return `${target?.kind}:${target?.id}`
  }

  /** 终止一个目标（并发调用；超时/异常一律落成结果，不抛）。 */
  async function terminateDerivedTarget(sessionId, target, terminateMs) {
    const terminate = target.kind === 'subagent' ? hooks?.interruptSubagent : hooks?.killDerivedJob
    const base = { kind: target.kind, id: target.id, label: target.label, evidence: target.evidence }
    if (typeof terminate !== 'function') {
      return { ...base, ok: false, timedOut: false, error: '终止能力未装配（宿主缺 interruptSubagent/killDerivedJob 注入面）' }
    }
    const raced = await withDerivedTimeout(
      Promise.resolve().then(() => terminate({ sessionId, id: target.id, target })),
      terminateMs,
    )
    if (raced.timedOut) return { ...base, ok: false, timedOut: true, error: `终止调用超时（${terminateMs}ms）` }
    if (raced.error !== undefined) {
      return { ...base, ok: false, timedOut: false, error: String(raced.error?.message ?? raced.error) }
    }
    const value = raced.value
    if (value && value.ok === false) {
      return { ...base, ok: false, timedOut: false, error: String(value.error?.message ?? value.error ?? '终止调用被拒') }
    }
    return { ...base, ok: true, timedOut: false, error: null }
  }

  /** 运行态 + 事件计数的唯一读数口。null = 宿主没装配读数面（不可判定，如实上报）。 */
  async function readDerivedState(sessionId, targets) {
    if (typeof hooks?.derivedStatus !== 'function') return null
    try {
      const raw = await hooks.derivedStatus({ sessionId, targets })
      const rows = Array.isArray(raw) ? raw : Array.isArray(raw?.rows) ? raw.rows : []
      const map = new Map()
      for (const row of rows) {
        if (!row || typeof row.id !== 'string' || row.id.length === 0) continue
        const value = {
          status: typeof row.status === 'string' ? row.status : undefined,
          events: Number.isFinite(row.events) ? row.events : undefined,
        }
        if (typeof row.kind === 'string' && row.kind !== '') map.set(`${row.kind}:${row.id}`, value)
        map.set(row.id, value)
      }
      return map
    } catch (error) {
      log(`retrace: 派生任务状态读数失败: ${String(error?.message ?? error)}`)
      return null
    }
  }

  function derivedRowOf(state, target) {
    if (!state) return undefined
    return state.get(derivedTargetKey(target)) ?? state.get(target.id)
  }

  /** 静默确认：轮询到全部 `status` 离开 running/stopping（超时返回未静默集合）。 */
  async function awaitDerivedQuiet(sessionId, targets, { quietMs, pollMs }) {
    const deadline = Date.now() + quietMs
    for (;;) {
      const state = await readDerivedState(sessionId, targets)
      if (state === null) {
        return { quiet: [], unquiet: targets.map((t) => ({ ...t, status: 'unreadable' })), unreadable: true }
      }
      const unquiet = []
      for (const target of targets) {
        const row = derivedRowOf(state, target)
        if (!derivedStatusIsQuiet(row?.status)) unquiet.push({ ...target, status: row?.status ?? 'unreadable' })
      }
      if (unquiet.length === 0) return { quiet: targets.slice(), unquiet: [], unreadable: false }
      if (Date.now() >= deadline) {
        const running = new Set(unquiet.map(derivedTargetKey))
        return { quiet: targets.filter((t) => !running.has(derivedTargetKey(t))), unquiet, unreadable: false }
      }
      await derivedSleep(Math.max(1, pollMs))
    }
  }

  /**
   * 兜底提示的准入判定：只有「观测到仍在 running/stopping」或「终止调用失败/超时
   * **且**状态面不可读（不敢当作已停）」的目标才算没停。
   * 任务自己结束了（状态面已离开 running）就不报 —— 避免假提示；
   * 终止调用失败但状态面正常且已静止，同样不报（没停成才报）。
   */
  function derivedStuckList(targets, attempts, quiet) {
    const failed = new Map(attempts.filter((a) => a.ok !== true).map((a) => [derivedTargetKey(a), a]))
    const unquiet = new Map(quiet.unquiet.map((t) => [derivedTargetKey(t), t]))
    const out = []
    for (const target of targets) {
      const key = derivedTargetKey(target)
      const fail = failed.get(key)
      const row = unquiet.get(key)
      const stillRunning = Boolean(row) && row.status !== 'unreadable'
      const unreadable = quiet.unreadable === true || row?.status === 'unreadable'
      if (stillRunning) {
        out.push({
          kind: target.kind, id: target.id, label: target.label, status: row.status,
          terminateError: fail?.error ?? null, terminateTimedOut: fail?.timedOut === true, reason: 'still-running',
        })
        continue
      }
      if (fail && unreadable) {
        out.push({
          kind: target.kind, id: target.id, label: target.label, status: 'unknown',
          terminateError: fail.error ?? null, terminateTimedOut: fail.timedOut === true, reason: 'status-unreadable',
        })
      }
    }
    return out
  }

  /**
   * 写 marker 之前的全部动作：枚举 → 并发终止 → 静默确认 →（失败则重试 1 次）。
   * 本函数不抛（内部全部兜底）；返回值里 `stuck` 非空才允许出兜底提示。
   */
  async function terminateDerivedBeforeMarker(session, sessionId, span, args) {
    const opts = derivedOptions(args)
    // 宿主没装配任何终止能力（未注入 interruptSubagent/killDerivedJob）⇒ 本轮**不枚举、
    // 不终止、不提示**：拿不到"哪个任务没停"的读数，任何提示都只是噪音。如实留一行
    // 宿主日志（这是装配缺口，不是"派生任务停不下来"）。
    if (typeof hooks?.interruptSubagent !== 'function' && typeof hooks?.killDerivedJob !== 'function') {
      log('retrace: 撤回连带终止不可用（宿主未注入 interruptSubagent/killDerivedJob）——本轮不枚举派生任务，也不出兜底提示')
      return { targets: [], attempts: [], quiet: [], unquiet: [], unreadable: false, stuck: [], verifyMs: opts.verifyMs, skipped: 'no-terminate-capability' }
    }
    let targets = []
    try {
      targets = await enumerateDerivedTargets(session, sessionId, span)
    } catch (error) {
      log(`retrace: 派生任务枚举失败（跳过连带终止）: ${String(error?.message ?? error)}`)
    }
    if (targets.length === 0) {
      return { targets: [], attempts: [], quiet: [], unquiet: [], unreadable: false, stuck: [], verifyMs: opts.verifyMs }
    }
    log(`retrace: 撤回连带终止 → 枚举到 ${targets.length} 个派生任务: ${targets.map((t) => derivedTargetKey(t)).join(', ')}`)
    let attempts = await Promise.all(targets.map((target) => terminateDerivedTarget(sessionId, target, opts.terminateMs)))
    let quiet = await awaitDerivedQuiet(sessionId, targets, opts)
    let stuck = derivedStuckList(targets, attempts, quiet)
    for (let round = 0; round < opts.retries && stuck.length > 0; round += 1) {
      const keys = new Set(stuck.map((row) => `${row.kind}:${row.id}`))
      const retryTargets = targets.filter((t) => keys.has(derivedTargetKey(t)))
      log(`retrace: 派生任务终止失败/未静默 ${stuck.length} 个 → 重试 ${round + 1}/${opts.retries}: ${retryTargets.map((t) => derivedTargetKey(t)).join(', ')}`)
      const again = await Promise.all(retryTargets.map((target) => terminateDerivedTarget(sessionId, target, opts.terminateMs)))
      const byKey = new Map(again.map((row) => [derivedTargetKey(row), row]))
      attempts = attempts.map((row) => byKey.get(derivedTargetKey(row)) ?? row)
      quiet = await awaitDerivedQuiet(sessionId, targets, opts)
      stuck = derivedStuckList(targets, attempts, quiet)
    }
    return { targets, attempts, quiet: quiet.quiet, unquiet: quiet.unquiet, unreadable: quiet.unreadable, stuck, verifyMs: opts.verifyMs }
  }

  /**
   * 写 marker **之后**的核对：等 `verifyMs`，断言这些目标的新事件数 = 0。
   * 不为 0（或仍未静默）⇒ 交给调用方落宿主日志与结果（可见，不静默）。
   */
  async function verifyDerivedAfterMarker(sessionId, cascade, verifyMs) {
    const targets = cascade?.targets ?? []
    if (targets.length === 0) return { verified: true, afterMarkerActivity: [] }
    const snapshot = (state) => {
      const out = new Map()
      for (const target of targets) {
        const row = derivedRowOf(state, target)
        out.set(derivedTargetKey(target), { status: row?.status, events: row?.events })
      }
      return out
    }
    const baseline = await readDerivedState(sessionId, targets)
    if (baseline === null) {
      log('retrace: 派生任务写后核对不可用（宿主缺 derivedStatus 注入面）——未核对，如实上报')
      return { verified: false, afterMarkerActivity: [] }
    }
    const before = snapshot(baseline)
    await derivedSleep(verifyMs)
    const after = await readDerivedState(sessionId, targets)
    if (after === null) {
      log('retrace: 派生任务写后核对第二次读数失败——未核对，如实上报')
      return { verified: false, afterMarkerActivity: [] }
    }
    const now = snapshot(after)
    const activity = []
    for (const target of targets) {
      const key = derivedTargetKey(target)
      const b = before.get(key)
      const a = now.get(key)
      if (Number.isFinite(b?.events) && Number.isFinite(a?.events) && a.events > b.events) {
        activity.push({ kind: target.kind, id: target.id, newEvents: a.events - b.events, status: a.status ?? null })
      } else if (!derivedStatusIsQuiet(a?.status)) {
        activity.push({ kind: target.kind, id: target.id, newEvents: null, status: a?.status ?? 'unreadable' })
      }
    }
    return { verified: true, afterMarkerActivity: activity }
  }

  /** recall 结果里的派生任务段（可观测面；正常路径**不含** derivedNotice）。 */
  function derivedResultPayload(cascade, verify, error) {
    const payload = {
      enumerated: cascade.targets.map((row) => ({ kind: row.kind, id: row.id, ...(row.label ? { label: row.label } : {}) })),
      terminated: cascade.attempts.map((row) => ({ kind: row.kind, id: row.id, ok: row.ok === true, timedOut: row.timedOut === true, error: row.error ?? null })),
      quiet: cascade.quiet.map((row) => derivedTargetKey(row)),
      unquiet: cascade.unquiet.map((row) => ({ kind: row.kind, id: row.id, status: row.status ?? 'unknown' })),
      verified: verify.verified,
      afterMarkerActivity: verify.afterMarkerActivity,
      stuck: cascade.stuck.map((row) => ({ kind: row.kind, id: row.id, status: row.status ?? 'unknown', reason: row.reason ?? 'unknown', terminateError: row.terminateError ?? null })),
    }
    if (cascade.skipped) payload.skipped = cascade.skipped
    if (error) payload.error = error
    return payload
  }

  /** Wrap one op body into the transport-neutral result convention. */
  function op(fn) {
    return (args) =>
      locked(String(args?.sessionId ?? ''), () =>
        Promise.resolve()
          .then(() => fn(args))
          .then(
            (value) => ({ ok: true, value }),
            (error) => ({
              ok: false,
              error: {
                // editorError 附带的排查信息(messageId/seq)透传到 wire;
                // 放前面,code/message 恒为准,不会被 details 覆盖。
                ...(error && typeof error.details === 'object' && error.details ? error.details : {}),
                code: error && typeof error.code === 'string' ? error.code : 'internal',
                message: error instanceof Error ? error.message : String(error),
              },
            }),
          ),
      )
  }

  /**
   * A（实测需求"那条 /goal 要能撤回/编辑"）: **按 seq 解析目标** ——
   *   `command/run` 这类事件**没有 messageId**（只有 commandId/seq/args），而遮蔽层只吃 seq。
   *   优先用显式 `args.seq`；否则回落到 messageId 路径（行为不变）。
   */
  function resolveTarget(session, args) {
    const direct = Number(args?.seq)
    if (Number.isSafeInteger(direct) && direct >= 0) {
      const ev = eventAt(session, direct)
      if (ev) return { seq: direct, event: ev, viaSeq: true }
    }
    const messageId = String(args?.messageId ?? '')
    const seq = findMessageSeq(session, messageId)
    return { seq, event: seq === -1 ? null : eventAt(session, seq), viaSeq: false, messageId }
  }

  /** 命令类事件（command/run 等）的原文：`args` 优先，退回 `/<name>`。 */
  function commandTextOf(event) {
    if (!event || event.type !== 'command/run') return ''
    const d = event?.data ?? {}
    const a = typeof d.args === 'string' ? d.args.trim() : ''
    if (a !== '') return a
    return typeof d.name === 'string' && d.name !== '' ? `/${d.name}` : ''
  }

  /** Extract the durable text of a user or assistant message by seq. */
  function messageTextOf(session, seq) {
    const event = eventAt(session, seq)
    if (!event) return ''
    const data = event.type === 'user/message' ? event.data : event.data?.message
    return extractUserText(data?.content)
  }

  /** 撤回: remove the whole exchange round (input + output) around one message. */
  const recall = op(async (args) => {
    const sessionId = String(args?.sessionId ?? '')
    const session = requireSession(sessionId)
    await ensureIdle(agents.get(sessionId))
    const tgt = resolveTarget(session, args)
    const messageId = String(args?.messageId ?? '')
    const seq = tgt.seq
    if (seq === -1 || tgt.event === null) throw editorError('message-not-found', 'Message not found in this session.')
    // 撤回语义 = 遮蔽目标轮及之后全部(编辑=从此处分叉
    // issue)——fallback 用 tail;主路径由 index.js 注入 spanFromFile(官方 foldSurface nodes)。
    // 大范围遮蔽由快照点守卫引导分支(太旧消息的正确出口)。
    // span null 不直接当「被遮蔽」——先区分「提交中(文件/快照滞后,可重试)」
    // 与「真被遮蔽(fold/recall/compact 已移除,历史只读)」。
    const span = args?.span ?? shadowSpanFrom(session, seq, { mode: 'tail' })
    if (!span) throwSpanMiss(session, seq, args, messageId)
    const recallText = messageTextOf(session, seq) || commandTextOf(tgt.event)
    // ── 方案 A：写 marker **之前**先把被撤回区间里派生出去的任务停干净 ──────────
    // 顺序：枚举 → 并发终止（每目标超时）→ 静默确认（这是写 marker 的前置条件，
    // 超时也放行但记入未静默集合）→ 写 marker → 写后核对。内部全部兜底：连带终止
    // 自身出问题时撤回照写，该失败以 derived.error 如实上报。
    let cascade
    let cascadeError = null
    try {
      cascade = await terminateDerivedBeforeMarker(session, sessionId, span, args)
    } catch (error) {
      cascadeError = String(error?.message ?? error)
      log(`retrace: ⚠ 撤回连带终止内部异常（撤回继续，但派生任务未被终止）: ${cascadeError}`)
      cascade = { targets: [], attempts: [], quiet: [], unquiet: [], unreadable: false, stuck: [], verifyMs: 0 }
    }
    if (cascade.unquiet.length > 0) {
      log(`retrace: ⚠ 撤回静默确认超时，未静默任务 ${cascade.unquiet.map((r) => `${derivedTargetKey(r)}(${r.status ?? 'unknown'})`).join(', ')} —— 按设计继续写 marker（记入结果 unquiet）`)
    }
    const markerEvent = await writeMarker(session, span, 'recall', seq, recallText, tgt.viaSeq ? { explicitUserTarget: true } : {})
    await flushSafely(session)
    const verify = await verifyDerivedAfterMarker(sessionId, cascade, cascade.verifyMs)
    const notice = derivedStuckNotice(cascade.stuck)
    if (notice !== '') log(`retrace: ⚠ 撤回兜底提示（有派生任务未能停止）: ${notice}`)
    if (verify.afterMarkerActivity.length > 0) {
      log(`retrace: ⚠ 撤回写 marker(seq=${markerEvent.seq}) 之后这些派生任务仍有新事件: ${JSON.stringify(verify.afterMarkerActivity)}`)
    }
    if (verify.verified === false && cascade.targets.length > 0) {
      log(`retrace: ⚠ 撤回写后核对未完成（读数面不可用），${cascade.targets.length} 个派生任务的事件数未被核对`)
    }
    notifyBoundary('recall', session, span, markerEvent, '')
    return {
      op: 'recall',
      messageId,
      seq,
      markerSeq: markerEvent.seq,
      shadowed: span.shadowedSeqs.length,
      text: recallText,
      viaSeq: tgt.viaSeq === true,
      derived: derivedResultPayload(cascade, verify, cascadeError),
      // 兜底提示（设计 ）：仅当枚举到任务 且 终止失败/超时 且 重试 1 次仍没停时才有值。
      // 正常路径恒无此键 —— 由 test/rollback-derived-tasks.test.js 的断言钉住。
      ...(notice !== '' ? { derivedNotice: notice } : {}),
    }
  })

  /**
   * 编辑重发: rewind before a user message, replace it with `text`, then re-trigger
   * the agent. With `fromScratch` the whole surface is rewound first, so the
   * conversation continues from a clean slate (new-conversation semantics).
   */
  const editAndResend = op(async (args) => {
    const sessionId = String(args?.sessionId ?? '')
    const text = args?.text
    const fromScratch = args?.fromScratch === true
    const session = requireSession(sessionId)
    const agent = agents.get(sessionId)
    await ensureIdle(agent)
    const tgt = resolveTarget(session, args)
    const seq = tgt.seq
    if (seq === -1 || tgt.event === null) throw editorError('message-not-found', 'Message not found in this session.')
    const event = tgt.event
    // A: **命令类目标（command/run）也可编辑重发** —— 它们不是轮边界（isRoundBoundary 为假），
    //   但没有 messageId 仍有 seq ⇒ 遮蔽层完全可用；文案回填取 `data.args`。
    const isCommand = event?.type === 'command/run'
    if (!isRoundBoundary(event) && !isCommand) {
      throw editorError('not-user-message', 'Only user messages can be edited and re-sent.')
    }
    const messageId = String(args?.messageId ?? (typeof event?.data?.commandId === 'string' ? event.data.commandId : ''))
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw editorError('blank-text', 'The edited message must not be empty.')
    }
    if (!agent || typeof agent.followup !== 'function') {
      throw editorError('agent-unavailable', 'No live agent for this session; cannot re-send.')
    }
    const originalText = messageTextOf(session, seq) || commandTextOf(event)
    // 事件级:fromScratch 取第一个 user 输入(不依赖 surface.nodes[0])
    const events = sessionEvents(session)
    const firstBoundary = events.findIndex((e) => isRoundBoundary(e))
    // 修（依据现场日志）: `findIndex` 返回的是**数组下标**，这里却当 **seq** 用 ⇒
    //   现场实测 firstBoundary=3 ⇒ startSeq=3（会话第一个节点）⇒ fromScratch 编辑的区间被算成 `3..尾`（= 整个 surface）
    //   ⇒ 守卫报"极端遮蔽 个节点"并拒绝。修法: 取该下标的**事件 seq**（无则回落 0）。
    const startSeq = fromScratch
      ? (firstBoundary >= 0 ? (Number.isSafeInteger(events[firstBoundary]?.seq) ? events[firstBoundary].seq : 0) : 0)
      : seq
    if (startSeq === undefined) throw editorError('empty-surface', 'This session has no conversation to edit.')
    // 修复:普通编辑用「轮内遮蔽」(只遮蔽目标输入+它的回复),不遮蔽到尾部——
    // 否则编辑「最新消息」会遮蔽 surface 尾部全部
    // 因为 UI 显示的消息在 surface 中间位置)。fromScratch 才遮蔽到尾部(重新开始语义)。
    // 二次修复:若外部传入 span(host 从文件读全量算好,绕开稀疏 events),
    // 直接用外部 span;否则用内部计算(受 host 内存视图影响,可能不准)。
    // span null 先区分「提交中(可重试)」vs「真被遮蔽(历史只读)」。
    const span = args?.span ?? (fromScratch ? shadowSpanFrom(session, startSeq, { mode: 'tail' }) : roundSpanFrom(session, seq))
    if (!span) throwSpanMiss(session, seq, args, messageId)
    const markerEvent = await writeMarker(session, span, 'edit', seq, originalText, tgt.viaSeq ? { explicitUserTarget: true } : {})
    await flushSafely(session)
    notifyBoundary('edit', session, span, markerEvent, text)
    const message = resendMessage(text.trim(), 'resend')
    agent.followup(message)
    return {
      op: 'edit',
      messageId,
      seq,
      resendMessageId: message.id,
      shadowed: span.shadowedSeqs.length,
      text: text.trim(),
      originalText,
      fromScratch,
    }
  })

  /** 重新生成: rewind to the user prompt that produced one assistant reply, then re-send it. */
  const regenerate = op(async (args) => {
    const sessionId = String(args?.sessionId ?? '')
    const messageId = String(args?.messageId ?? '')
    const session = requireSession(sessionId)
    const agent = agents.get(sessionId)
    await ensureIdle(agent)
    const seq = findMessageSeq(session, messageId)
    if (seq === -1) throw editorError('message-not-found', 'Message not found in this session.')
    const event = eventAt(session, seq)
    if (event?.type !== 'assistant/message') {
      throw editorError('not-assistant-message', 'Regenerate targets an assistant reply.')
    }
    // 判定序与 recall/editAndResend 对齐——args.span(文件注入)优先;
    // 无 span 时先在内存 surface 上找前置 user 输入;「内存 surface 找不到目标」
    // 不再无条件当遮蔽终判(提交竞态里内存 surface 可能滞后于刚 commit 的事件,
    // 旧代码在 :413 直接抛 target-shadowed,与 recall/edit 的 span-null 判定不一致)。
    const nodes = Array.isArray(session.surface?.nodes) ? session.surface.nodes : []
    const idx = nodes.indexOf(seq)
    let userSeq = -1
    if (args?.span) {
      // 文件已注入 round span(其起点 = 目标同一轮的
      // 前置 user,由文件全量 events + 官方 nodes 算得)时,**绝不直扫稀疏
      // host events 找前置 user**——host 内存 events 是窗口化视图(有 undefined
      // 洞),直扫会越过洞(洞里正是该轮 user)或被遮蔽区间,选到**更早轮**的 user
      // → 重发错文本 + marker targetSeq 指向错轮。前置 user 与原文一律取文件侧:
      // args.regeneratePrompt(index.js/http.js 由 spanProbeFromFile 的 prompt 带回,
      // = round span 起点 user 的原文);文件侧带不出时只做「span 起点单点」内存
      // 校验(单点读,不扫描),读不到/非轮边界 → 保守报 no-prompt(宁可报错,
      // 绝不越过遮蔽区重发更早轮的文本)。
      const filePrompt = args.regeneratePrompt
      const promptSeq = Number.isSafeInteger(filePrompt?.seq) && filePrompt.seq >= 0 ? filePrompt.seq : -1
      if (promptSeq !== -1 && typeof filePrompt?.text === 'string') {
        userSeq = promptSeq
      } else if (Number.isSafeInteger(args.span.start) && isRoundBoundary(eventAt(session, args.span.start))) {
        userSeq = args.span.start
      }
    } else if (idx !== -1) {
      // 在 nodes(全量 seq 列表)里向前找最近的 user 输入——不遍历稀疏 events。
      // 回退规则**不在本文件重写**,复用 span-semantics 的 roundStartIndex
      // (单一实现;第二份回退循环由结构断言 test/span-single-truth.test.js 拦下)。
      // 找不到轮边界时 roundStartIndex 停在传入口(idx-1):该位置不是轮边界 → userSeq 保持 -1
      // (与旧循环语义逐字一致:孤儿回复不重发)。
      const startPos = roundStartIndex(nodes, idx - 1, (s) => isRoundBoundary(eventAt(session, s)))
      if (isRoundBoundary(eventAt(session, nodes[startPos]))) userSeq = nodes[startPos]
    }
    // 孤儿回复(目标在 surface 上、前置无 user 输入):任何 span 来源都无 prompt 可重发
    if (idx !== -1 && userSeq === -1) {
      throw editorError('no-prompt', 'No user message precedes this reply; cannot regenerate.')
    }
    const span = args?.span ?? (userSeq !== -1 ? roundSpanFrom(session, userSeq) : null)
    if (!span) throwSpanMiss(session, seq, args, messageId)
    // 文件 span 存在但没锁定同轮 user(probe 未带回 prompt,且 span 起点在内存里
    // 读不到/非轮边界)→ 保守 no-prompt:不重发错文本。
    if (userSeq === -1) {
      throw editorError('no-prompt', 'No user message precedes this reply; cannot regenerate.')
    }
    // 重发文本来源——文件侧 prompt(promptSeq 已锁定该轮 user,内存有洞也可靠)
    // 优先;否则内存 events[userSeq] 单点读取(userSeq 已限定为该轮 user 位置,
    // 不做任何扫描)。
    const fileText = args?.regeneratePrompt?.seq === userSeq && typeof args.regeneratePrompt.text === 'string'
      ? args.regeneratePrompt.text
      : null
    const text = fileText ?? extractUserText(eventAt(session, userSeq)?.data?.content)
    if (!text.trim()) {
      throw editorError('no-text', 'The original message carries no text to regenerate from.')
    }
    if (!agent || typeof agent.followup !== 'function') {
      throw editorError('agent-unavailable', 'No live agent for this session; cannot re-send.')
    }
    // 修复:regenerate 也用「轮内遮蔽」——只遮蔽目标 user 的回复轮,
    // 不遮蔽到尾部(否则 regenerate 早期回复遮蔽 surface 尾部全部,触发守卫误拦)。
    const markerEvent = await writeMarker(session, span, 'regenerate', userSeq, text)
    await flushSafely(session)
    notifyBoundary('regenerate', session, span, markerEvent, text)
    const message = resendMessage(text.trim(), 'resend')
    agent.followup(message)
    return {
      op: 'regenerate',
      messageId,
      seq,
      resendMessageId: message.id,
      shadowed: span.shadowedSeqs.length,
    }
  })

  /**
   * 撤销撤回(恢复显示):追加**一条**「取消标记」`user/message`,取消某个既有 marker
   * 的隐藏效果。append-only:既有日志行(两段 marker / 被遮蔽节点)**一个字节都不动**,
   * 也不写第 2 段审计(形状与理由见文件头「撤销撤回(unhide)」块)。
   *
   * 目标解析:优先 `args.markerSeq`(客户端 marker 节点上的 `data.seq`),否则
   * `args.markerId`。目标必须是**本插件 marker 载体**(`isCarrierMarkerEvent`:
   * user/message + 合法 replace 区间 + 本插件 id)⇒ 只认我们自己写的 marker,
   * 不认 compaction checkpoint / 官方压缩段。
   *
   * 幂等:同一 marker 已被取消(日志里已有 `cancels === <该 marker seq>` 的取消标记)
   * ⇒ **不再写第二条**,返回 `{ alreadyCancelled: true }` 与既有那条的 seq。
   * 因此重复点击/重复调用不会堆积取消行(且即使堆积也**无害**:客户端按集合取并集,
   * 只是多一行留痕)。
   *
   * 写入校验:复用既有的 marker 写入校验路径(`hooks.validateMarker`,正式装配 =
   * lib/prewrite-guard.js 的完整契约校验),信封**不带 seq**(交给 prewriter 按日志尾
   * 赋值;带伪造 seq 会被判 E2/S6/S8 三连,见 test/marker-append-seq.test.js)。
   *
   * 不做 `ensureIdle`:取消标记是**单段追加**(没有两段 marker 的 token-meter step
   * 配对约束),不需要轮边界;为一次"恢复显示"去中断用户正在跑的轮次是过度动作。
   * 会话运行中照常写,但留一行日志(可见,不静默)。
   */
  const unhide = op(async (args) => {
    const sessionId = String(args?.sessionId ?? '')
    const session = requireSession(sessionId)
    const events = sessionEvents(session)
    const wantSeq = Number(args?.markerSeq)
    const wantId = typeof args?.markerId === 'string' ? args.markerId : ''
    if ((!Number.isSafeInteger(wantSeq) || wantSeq < 0) && wantId === '') {
      throw editorError('bad-request', 'unhide needs markerSeq (integer) or markerId (non-empty string)')
    }
    let target
    if (Number.isSafeInteger(wantSeq) && wantSeq >= 0) {
      target = eventAt(session, wantSeq)
    } else {
      for (let i = events.length - 1; i >= 0; i--) {
        const event = events[i]
        if (event?.type === 'user/message' && String(event.data?.id ?? '') === wantId) { target = event; break }
      }
    }
    if (!target) {
      throw editorError('marker-not-found', '未找到该撤回/编辑标记(可能已不在会话日志里)',
        { markerSeq: Number.isSafeInteger(wantSeq) ? wantSeq : -1, markerId: wantId })
    }
    // 取消标记自身不可再取消 —— **先于**载体形状判,否则错误码会落成 marker-not-found
    // (取消标记是单段 append,本来就不是 replace 载体),用户看到的原因就错了。
    if (target.type === 'user/message' && target.data?.op === UNHIDE_OP) {
      throw editorError('marker-not-cancellable', '该标记本身已经是「撤销撤回」标记,不能再取消', { markerSeq: target.seq })
    }
    if (!isCarrierMarkerEvent(target)) {
      throw editorError('marker-not-found',
        'unhide 只取消本插件的撤回/编辑标记(两段结构的第 2 段);该 seq 不是 marker 载体',
        { markerSeq: target.seq })
    }
    const targetOp = markerOpOfMarkerId(target.data?.id)
    // 幂等:已有同一目标的取消标记 ⇒ 直接返回既有那条(零写入)。
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]
      if (event?.type !== 'user/message' || event.data?.op !== UNHIDE_OP) continue
      if (Number(event.data?.cancels) !== Number(target.seq)) continue
      return {
        op: UNHIDE_OP,
        markerSeq: target.seq,
        markerId: String(target.data?.id ?? ''),
        markerOp: targetOp,
        cancelSeq: event.seq,
        cancels: target.seq,
        alreadyCancelled: true,
        shadowed: 0,
      }
    }
    const model = lastModelSource(session)
    if (!model) {
      throw editorError(
        'no-model-header',
        'This session has no model header yet; send at least one message before cancelling a marker.',
      )
    }
    const data = {
      role: 'user',
      id: editorId(UNHIDE_OP),
      op: UNHIDE_OP,
      cancels: Number(target.seq),
      content: [{ type: 'text', text: UNHIDE_TRACE_TEXT }],
      source: { kind: 'model', provider: model.provider, model: model.model },
    }
    // 与 marker 写入同一校验路径(信封不带 seq;phase 缺省 = 完整契约校验)。
    if (typeof hooks?.validateMarker === 'function') {
      await hooks.validateMarker(session, { type: 'user/message', data, surfaceOp: 'append' })
    }
    if (session?.isRunning === true) {
      log(`retrace: unhide 在会话运行中写入取消标记(单段追加,无轮边界约束)`)
    }
    const event = session.append('user/message', data, { surfaceOp: 'append' })
    await flushSafely(session)
    return {
      op: UNHIDE_OP,
      markerSeq: target.seq,
      markerId: String(target.data?.id ?? ''),
      markerOp: targetOp,
      cancelSeq: event.seq,
      cancels: target.seq,
      alreadyCancelled: false,
      shadowed: 0,
    }
  })

  /**
   * 真正恢复(日志层面遮蔽撤销,0.4.126)—— 与 `unhide` 并列的第二条替代操作。
   *
   * `unhide` 只恢复**显示**(单段 append 取消标记,模型面不变,`target-shadowed` 照旧);
   * `unshadow` 把目标 marker 的**两段**在日志层原地中和 ⇒ 区间回到模型面 ⇒
   * 编辑/重发/撤回入口复活。为什么只能改日志而不是追加事件,见文件头
   * 「真正恢复(unshadow)」块的逐字内核依据。
   *
   * 目标解析:优先 `args.markerSeq`(客户端 marker 节点上的 `data.seq`),否则 `args.markerId`;
   * 必须是**本插件 marker 载体**(`isCarrierMarkerEvent`)或**已中和态**(幂等 ⇒ 零写入)。
   *
   * 安全闸(硬;全部在写入之前,任一不过 ⇒ 拒绝并给可读原因):
   *   ① 会话文件定位(注入面 `hooks.sessionFileFor`);
   *   ② 折叠预演 + 区间回面证明(引擎内;被更晚 replace 重新遮蔽 ⇒ 拒绝);
   *   ③ `lsof` 无持有者(引擎内;lsof 不可用 fail-closed);
   *   ④ 目标**无在途轮次**——running(会话在跑)/ stopping(回复收尾中)/ inbox 有排队
   *      (见 sessionInFlightReason)⇒ 拒绝,理由给到可操作动作("先停止当前回复再恢复")。
   *      这是**唯一**的会话态拒绝理由:0.4.131 既定口径撤掉了此前的「当前会话闸」
   *      (`args.currentSessionId === sessionId` ⇒ 拒绝)——按钮就长在该会话里,
   *      要求切走等于入口不可达;就地改写正在使用的会话造成的宿主内存/磁盘分叉,
   *      由引擎的写后校验 + 客户端本地「已真正恢复」视图账本兜住。
   * 幂等:已是中和态 ⇒ `alreadyRestored:true` + `zeroWrite:true`(零写入)。
   * ⛔ 不追加任何事件(追加会与"中和"语义打架,也失去幂等的零写入保证)——
   * 中和后的两行本身就是持久留痕(data.id / data.op / seq 全保留)。
   *
   * 写后「需重读」信号(客户端当场可见的唯一通道,平台没有官方重读接口):
   * 结果里 `reread = { required, sessionId, reason:'log-rewritten', neutralizedSeqs,
   * markerId }`。客户端据此 (a) 把该 marker 记进本地账本 ⇒ 该会话视图**当帧**
   * 不再注入隐藏 CSS / 不再抑制动作行,(b) 尽力调用官方客户端会话面的 `resync()`。
   * 平台调研的逐字依据与边界写在 lib/client.js 的「真正恢复:需重读信号」块。
   * 写成功后宿主**必须**把「磁盘已改、内存未重读」这一事实随结果带回客户端(不许静默)。
   */
  const unshadow = op(async (args) => {
    const sessionId = String(args?.sessionId ?? '')
    const session = requireSession(sessionId)
    const events = sessionEvents(session)
    const wantSeq = Number(args?.markerSeq)
    const wantId = typeof args?.markerId === 'string' ? args.markerId : ''
    if ((!Number.isSafeInteger(wantSeq) || wantSeq < 0) && wantId === '') {
      throw editorError('bad-request', 'unshadow needs markerSeq (integer) or markerId (non-empty string)')
    }
    let target
    if (Number.isSafeInteger(wantSeq) && wantSeq >= 0) {
      target = eventAt(session, wantSeq)
    } else {
      for (let i = events.length - 1; i >= 0; i--) {
        const event = events[i]
        const id = String(event?.data?.id ?? event?.data?.message?.id ?? '')
        if (id === wantId) { target = event; break }
      }
    }
    if (!target) {
      throw editorError('marker-not-found', '未找到该撤回/编辑标记(可能已不在会话日志里)',
        { markerSeq: Number.isSafeInteger(wantSeq) ? wantSeq : -1, markerId: wantId })
    }
    if (target.type === 'user/message' && target.data?.op === UNHIDE_OP) {
      throw editorError('marker-not-cancellable', '该标记本身是「撤销撤回」标记(单段 append,没有遮蔽区间),没有可真正恢复的内容', { markerSeq: target.seq })
    }
    const already = isNeutralizedMarkerEvent(target)
    if (!already && !isCarrierMarkerEvent(target)) {
      throw editorError('marker-not-found',
        'unshadow 只恢复本插件的撤回/编辑标记(两段结构的第 2 段);该 seq 既不是 marker 载体也不是已恢复态',
        { markerSeq: target.seq })
    }
    const targetOp = markerOpOfMarkerId(String(target.data?.id ?? ''))
    if (!already && targetOp === '') {
      throw editorError('marker-not-found', 'unshadow 只恢复本插件写的标记(id 前缀不属于本插件)', { markerSeq: target.seq })
    }
    if (typeof hooks?.trueRestore !== 'function') {
      throw editorError('unshadow-unavailable',
        '当前宿主没有装配「真正恢复」(日志层面撤销)能力——该能力需要注入 trueRestore(见 lib/index.js 装配)', { markerSeq: target.seq })
    }
    if (typeof hooks?.sessionFileFor !== 'function') {
      throw editorError('unshadow-unavailable', '当前宿主没有注入会话文件定位面(sessionFileFor)', { markerSeq: target.seq })
    }
    const file = await hooks.sessionFileFor(sessionId)
    if (typeof file !== 'string' || file.length === 0) {
      throw editorError('session-file-not-found', `找不到会话 ${sessionId} 的日志文件(无法做日志层面恢复)`, { sessionId })
    }
    // 溯源(审计 seq / 被遮蔽集合)以**磁盘**为准:内存视图可能被事件管道剥掉顶层
    // provenance —— 引擎会自己从盘上派生,这里只把内存里拿得到的那份作为提示传下去。
    const cited = Array.isArray(target.sourceEventSeqs) ? target.sourceEventSeqs : []
    const auditHint = Number.isSafeInteger(cited[0]) ? cited[0] : null
    // 在途轮次闸(唯一会话态闸;规则与理由见 sessionInFlightReason 的注释)。
    // 放在 op 侧**直接拒绝**:①理由文案由业务层给(可操作、与客户端文案同源);
    // ②engine 一次都不被调用(连读盘都不做,零副作用);③引擎侧的同名闸
    // (lib/rollback.js 的 session-running)保留为**最后防线**,防直调引擎绕过 op。
    const inFlight = sessionInFlightReason(session, agents?.get?.(sessionId))
    if (inFlight !== '') {
      const detail = inFlight === 'stopping-reply'
        ? '该会话的回复正在收尾(stopping)'
        : inFlight === 'queued-turn'
          ? '该会话还有排队中的轮次(inbox 未清空)'
          : '该会话正在回复(轮次进行中)'
      throw editorError(
        'session-running',
        `${detail}——请先停止当前回复(点会话里的停止按钮/等它停稳)再执行「真正恢复」;在飞轮次会与本工具的日志改写并发,追加可能丢失`,
        { sessionId, markerSeq: target.seq, reason: inFlight },
      )
    }
    const result = await hooks.trueRestore({
      file,
      carrierSeq: target.seq,
      auditSeq: auditHint,
      shadowedSeqs: cited.length > 1 ? cited.slice(1) : [],
      markerId: String(target.data?.id ?? ''),
      sessionId,
      running: false,
      runningReason: '',
      dryRun: args?.dryRun === true,
    })
    const written = result?.alreadyRestored !== true && result?.dryRun !== true
    if (written) {
      // 平台没有官方「会话日志重读/缓存失效」接口(逐字依据见 lib/client.js 的
      // 「真正恢复:需重读信号」块):宿主内存日志此刻仍是旧的,磁盘已是中和态。
      // 如实说出这一点,并把「需重读」作为结构化信号交给客户端(客户端据此做
      // 会话视图的本地修正 + 尽力调官方 resync);手动刷新/重开仍是最后兜底。
      log(`retrace: unshadow 已改写会话日志(${file});宿主内存视图未重读 ⇒ 已下发 reread 信号,需重开该会话/刷新页面才看到恢复后的内容(marker seq ${target.seq}${result?.auditSeq !== null && result?.auditSeq !== undefined ? ` / 审计 ${result.auditSeq}` : ''})`)
    }
    const neutralizedSeqs = [
      target.seq,
      ...(Number.isSafeInteger(result?.auditSeq) ? [result.auditSeq] : []),
    ]
    return {
      op: UNSHADOW_OP,
      markerSeq: target.seq,
      markerId: String(target.data?.id ?? ''),
      markerOp: targetOp,
      alreadyRestored: result?.alreadyRestored === true,
      zeroWrite: result?.zeroWrite === true,
      dryRun: result?.dryRun === true,
      reloadRequired: written,
      // 「需重读」信号(客户端当场可见的唯一通道;边界见 op 文档与 lib/client.js):
      // alreadyRestored 也带 —— 磁盘已是中和态,界面可能仍是旧视图,客户端本地账本同样要落。
      reread: result?.dryRun === true ? null : {
        required: written || result?.alreadyRestored === true,
        sessionId,
        reason: 'log-rewritten',
        alreadyRestored: result?.alreadyRestored === true,
        neutralizedSeqs,
        markerId: String(target.data?.id ?? ''),
      },
      file: result?.file ?? file,
      backupPath: result?.backupPath ?? null,
      auditSeq: result?.auditSeq ?? auditHint,
      neutralizedSeqs,
      shadowed: result?.surface?.shadowedTotal ?? 0,
      restored: result?.surface?.restored ?? 0,
      stillHidden: result?.surface?.stillHidden ?? [],
      surface: result?.surface ?? null,
      frames: result?.frames ?? null,
      verify: result?.verify ?? null,
    }
  })

  return {
    recall: (args) => recall(args),
    editAndResend: (args) => editAndResend(args),
    regenerate: (args) => regenerate(args),
    unhide: (args) => unhide(args),
    unshadow: (args) => unshadow(args),
  }
}
