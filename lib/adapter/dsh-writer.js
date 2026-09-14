/**
 * dsh-retrace — lib/adapter/dsh-writer.js
 *
 * DSH 平台的「遮蔽写入器」(ReplaceWriter 的 DSH 实现)——把业务意图
 * 「遮蔽这些消息」翻译成 DSH 的**两段结构**事件(形状真相见 lib/marker-carrier.js)。
 *
 * 抽象设计:
 * 编辑/撤销/分支/跳过 = 通用消息列表投影操作,业务层只表达「遮蔽 roundRange」。
 * **DSH 翻译成本全部隔离在本文件**:
 * - 第 1 段 `compaction/prune` = log-only 审计(官方词表:data 精确三成员);
 * - 第 2 段 `user/message` + `surfaceOp{op:'replace'}` + 完整 provenance = 真正遮蔽
 *   (四种 surface-eligible 类型里唯一能做任意多节点区间替换的);
 * - 两段关联:第 2 段 `sourceEventSeqs` 首元素 = 第 1 段 seq(官方先例
 *   `dsh-compaction-basic`:`[startEvent.seq, summaryEvent.seq, ...shadowedSeqs]`);
 *   方向只能是「第 2 段 → 第 1 段」,两者都引用更早 seq ⇒ **审计先写**。
 *
 * 与 0.4.x 的差异(逐条都有实测/源码依据,见 lib/marker-carrier.js 文件头):
 * - 载体从 `assistant/message` 换成 `user/message` —— 前者在官方 v3 结构性出局
 *   (禁 provenance / 迁移边剥 sourceEventSeqs);
 * - **三情形 turn/step 翻译整体作废**(依赖 `assistant/message` 的 step 配对要求;
 *   `user/message` 无此要求)⇒ 不再写 turn/start·step/start·turn/end 信封,
 *   不再推进 agent-loop 计数器,连带 5 个死函数一并移除;
 * - `data.editor` 不再落盘(官方封闭词表里没有它的位置):`targetSeq` 改由区间起点
 *   派生、`text` 改按需派生、**业务元数据派生的人读文本**改由宿主注入的派生面给出
 *   (见 carrierContentOf 的 deriveContentText);
 * - `data.shadowedSeqs` 冗余取消 —— 第 1 段的 `data.shadowedSeqs` 是官方合法成员,
 *   读端取它即可(顶层 provenance 被管道剥掉时同样取得到);
 * - 写前断言改为**双段**:第 1 段三成员形状 + 第 2 段四成员形状(区间端点取自
 *   去掉审计 seq 之后的首尾)。
 *
 * host-core 零 import(动态插件 realm 可运行),本文件被 index.js 引用,
 * 依赖方向 adapter → host-core(安全);host-core 通过 hooks.writeMarker
 * 注入本 writer,不反向 import。
 */
import { editorError, editorId, lastModelSource } from '../host-core.js'
// 契约运行时化:跨层边界校验——业务层传入的 span 与写出的两段事件都要在边界处
// 形状合规(违规 → 指名道姓的 contract-violation,而不是写出"表面成功、
// 重放时对不上"的载体)。
import { assertContract, assertSpanShape, assertMarkerShape, assertAuditShape, runtimeSurfaceOpShape, contractViolation } from './contract.js'
// 载体形状/文案的唯一真相(纯模块零 import;生成动态件时与 contract 一同 inline)。
import { AUDIT_EVENT_TYPE, CARRIER_EVENT_TYPE, CARRIER_SOURCE_KIND, TRACE_TEXT } from '../marker-carrier.js'
// Host event-view compatibility (new host: snapshotEvents/eventAt; old host: events array).
import { sessionEvents, eventAt, nextAppendSeq } from '../host-compat.js'

/**
 * 第 2 段的 content(留痕 + 可解释载体)。
 *
 * 优先级:① 调用方给的人读文本 ② 注入面由业务元数据派生的文本 ③ 定稿留痕文案。
 * content 一律**非空**:空 content 会投影成一条 `role:'user'` 的空消息,
 * 读者会误读成"用户发了空消息"(定稿形态明确排除它)。
 *
 * ② 是**注入面**而不是本文件实现的业务逻辑:业务元数据(结构化卡/摘要)的字段与文案
 * 属业务词表,通用写入器不认它。宿主装配时把「业务元数据 → 人读文本」的函数传进来
 * (与 meter/deriveMessage 同一形态,见 createDshMarkerWriter);没有该注入面的宿主
 * 本就没有那类业务数据 ⇒ 直接落到 ③,而不是走一个恒空的分支。
 * @param {object} meta - writer 的业务元数据
 * @param {(meta: object) => string} [deriveContentText] - 注入面(见上)
 * @returns {Array<{type:'text', text:string}>}
 */
export function carrierContentOf(meta, deriveContentText) {
  const blocks = Array.isArray(meta?.content)
    ? meta.content.filter((b) => b && b.type === 'text' && typeof b.text === 'string' && b.text.length > 0)
    : []
  if (blocks.length > 0) return blocks.map((b) => ({ type: 'text', text: b.text }))
  let derived = ''
  try {
    derived = typeof deriveContentText === 'function' ? deriveContentText(meta) : ''
  } catch { derived = '' }
  if (typeof derived === 'string' && derived.length > 0) return [{ type: 'text', text: derived }]
  return [{ type: 'text', text: TRACE_TEXT }]
}

/**
 * 解析注入的官方 token-meter 服务面。
 *
 * 为什么是**注入**而不是 import:本文件在动态插件 realm 里以 inline 形式运行
 * (生成器 strip 掉 import),官方包在那里不可加载;宿主(正式装配 lib/index.js
 * 与动态件包装)把 `ctx.get('tokenMeter')` 的取值函数传进来。
 * @param {object|Function} [meter] - 服务对象,或返回服务对象的取值函数
 * @returns {object|null} 服务面(measure 与/或 estimateMessage);拿不到时 null
 */
function resolveMeter(meter) {
  let service
  try {
    service = typeof meter === 'function' ? meter() : meter
  } catch { service = undefined }
  if (!service) return null
  const usable = typeof service.measure === 'function' || typeof service.estimateMessage === 'function'
  return usable ? service : null
}

/**
 * 按**节点**取官方价:`Σ meter.estimateMessage(deriveMessage(event))`。
 *
 * 与官方 `dsh-compaction-tool-result-pruner` 生产者同式
 * (`this.ctx.tokenMeter.estimateMessage(event.data.message)`),也与官方
 * surface fold 的节点价同式(`estimateMessage(deriveEventMessage(event))`)。
 * `deriveMessage` 由宿主注入(官方 `@deepseek-ai/dsh-session` 的
 * `deriveEventMessage`)——动态 realm 拿不到它,那条路径走 surface 法。
 * @returns {{tokens:number, missing:number[]}|null} null = 该来源不可用
 */
function priceByNode({ service, deriveMessage, session, seqs }) {
  if (typeof deriveMessage !== 'function' || typeof service.estimateMessage !== 'function') return null
  // 无事件视图(既无 snapshotEvents 也无 events 数组)→ 该来源不可用(null,不再是静默空)。
  const hasEventView = typeof session?.snapshotEvents === 'function' || Array.isArray(session?.events)
  if (!hasEventView) return null
  let tokens = 0
  const missing = []
  for (const seq of seqs) {
    const event = Number.isSafeInteger(seq) ? eventAt(session, seq) : undefined
    let price = null
    if (event !== undefined && event !== null) {
      try {
        const message = deriveMessage(event)
        price = message === null || message === undefined ? 0 : service.estimateMessage(message)
      } catch { price = null }
    }
    if (!Number.isSafeInteger(price) || price < 0) { missing.push(seq); continue }
    tokens += price
  }
  return { tokens, missing }
}

/**
 * 按**表面**取官方价:`Σ measure(session).nodes` 里被遮蔽节点的 tokens。
 *
 * 与官方 `dsh-compaction-basic:544` 生产者同式
 * (`selectedNodes.reduce((total, node) => total + node.tokens, 0)`)——它取的正是
 * `measure()` 的面节点。
 * @returns {{tokens:number, missing:number[]}|null} null = 该来源不可用
 */
function priceBySurface({ service, session, seqs, log }) {
  if (typeof service.measure !== 'function') return null
  let nodes
  try {
    nodes = service.measure(session)?.nodes
  } catch (error) {
    log(`retrace: token-meter measure(session) 失败(${String(error?.message ?? error)});shadow-price 改走逐节点估价`)
    return null
  }
  if (!Array.isArray(nodes)) return null
  const bySeq = new Map()
  for (const node of nodes) if (Number.isSafeInteger(node?.seq)) bySeq.set(node.seq, node)
  let tokens = 0
  const missing = []
  for (const seq of seqs) {
    const node = bySeq.get(seq)
    if (!node || !Number.isSafeInteger(node.tokens) || node.tokens < 0) { missing.push(seq); continue }
    tokens += node.tokens
  }
  return { tokens, missing }
}

/**
 * 第 1 段 `shadowedTokenCount` = 被遮蔽区间的**官方令牌价**(shadow price)。
 *
 * 为什么不是节点个数(2026-09 实测修正):官方 `dsh-token-meter`
 * `lib/types/surface-projection.js:39` 把 `compaction/prune` 当 shadow-price claim
 * 武装(`{start,end,tokens:shadowedTokenCount}`),下一个 surface replace 按
 * `deltaTokens = 本事件估价 − claim.tokens` 折叠;官方两个生产者都写**令牌价**
 * (`dsh-compaction-tool-result-pruner`:`ctx.tokenMeter.estimateMessage(...)`;
 * `dsh-compaction-basic:544`:`selectedNodes.reduce((t,n)=>t+n.tokens,0)`)。
 * 写节点个数 ⇒ 每个 marker 让 surfaceTokens 高估「区间价 − 节点数」,而
 * `surfaceTokens → projectedTokens` 是压缩压力/占用率的输入 ⇒ 会提前误触发折叠。
 *
 * 两条来源同为官方口径(逐节点 / 表面);两者都可算却给出不同的价 = 业务 span 与
 * 官方当前面分叉(写出的 claim 会与官方 fold 对不上)⇒ 记显著诊断并采逐节点值。
 * 有节点取不到价(内存视图有洞/面滞后):**不编价**,claim 只含可估部分并记诊断
 * 行点名取不到的 seq(官方 surfaceTokens 会因此偏高这些节点的价)。
 *
 * @returns {number} 非负整数令牌价
 */
function officialShadowPrice({ service, deriveMessage, session, span, log }) {
  const contract = 'dshAdapter.writeMarker.shadowPrice'
  const seqs = Array.isArray(span.shadowedSeqs) ? span.shadowedSeqs : []
  const byNode = priceByNode({ service, deriveMessage, session, seqs })
  const bySurface = priceBySurface({ service, session, seqs, log })
  const available = [byNode, bySurface].filter(Boolean)
  const complete = available.filter((result) => result.missing.length === 0)
  if (complete.length === 2 && complete[0].tokens !== complete[1].tokens) {
    log(`retrace: shadow-price 两条官方口径不一致(逐节点 ${complete[0].tokens} vs 表面 ${complete[1].tokens})—— 业务 span 与官方当前面可能分叉;采逐节点值`)
  }
  // 择优:① 完整来源(逐节点优先 —— 它不依赖 surface 记账)② 缺得最少的来源
  const chosen = complete[0] ?? [...available].sort((a, b) => a.missing.length - b.missing.length)[0] ?? null
  assertContract(!!chosen, contract, '官方 token-meter 能给出被遮蔽区间的估价(逐节点或表面)', '两条来源都不可用(未注入 meter / 会话不可量)')
  if (chosen.missing.length > 0) {
    log(`retrace: shadow-price 降级 —— 被遮蔽节点 seq ${chosen.missing.join(',')} 在当前视图取不到(估不出价);claim 只含可估部分(官方 surfaceTokens 会偏高这些节点的价)`)
  }
  assertContract(Number.isSafeInteger(chosen.tokens) && chosen.tokens >= 0, contract, 'shadow-price 为非负整数', chosen.tokens)
  return chosen.tokens
}

/**
 * 创建 DSH 遮蔽写入器。
 * @param {object} deps
 * @param {Function} [deps.validateMarker] - 写前校验钩子(prewrite-guard)。
 * @param {(line: string) => void} [deps.log]
 * @param {object|Function} [deps.meter] - 官方 token-meter 服务面(或其取值函数),
 *   写第 1 段前用它算被遮蔽区间的令牌价;完全拿不到时**拒写**(写了价不对的 claim
 *   会静默污染官方占用率口径 —— 见 officialShadowPrice)。
 * @param {Function} [deps.deriveMessage] - 官方 `deriveEventMessage`(宿主注入):
 *   有它就能逐节点取价,不依赖 surface 记账;动态 realm 无它时走 measure 法。
 * @param {(meta: object) => string} [deps.deriveContentText] - 宿主注入:**业务元数据 →
 *   第 2 段人读文本**的派生面(与 meter/deriveMessage 并列;业务词表不进通用层)。
 *   缺席的宿主(本就没有结构化业务数据)⇒ 第 2 段回落定稿留痕文案,写入照常。
 */
export function createDshMarkerWriter({ validateMarker, log = () => {}, meter, deriveMessage, deriveContentText } = {}) {
  return {
    /**
     * 写入一个「遮蔽载体」(两段结构):业务意图(遮蔽 span)翻译成 DSH 事件形状。
     * @param {object} session - DSH Session 实例。
     * @param {{start:number, end:number, shadowedSeqs:number[]}} span - 遮蔽范围(业务层算好)。
     * @param {{op:string, targetSeq:number, originalText:string, content?:Array}} meta - 业务元数据。
     * @returns {Promise<object>} 第 2 段事件(调用方读 seq/surfaceOp)。
     */
    async writeMarker(session, span, meta) {
      // 契约边界:业务层 → 适配器。span 不合规(空/倒置/非连续段)在这里立刻报错,
      // 不进入形状翻译——否则会写出 surfaceOp 与 sourceEventSeqs 不一致的载体
      // (会话面上的遮蔽范围与日志记录分叉,历史上正是这类不一致导致加载失败/编辑死锁)。
      assertSpanShape(span, 'dshAdapter.writeMarker.span')
      const op = String(meta?.op ?? '')
      const targetSeq = Number(meta?.targetSeq)
      const model = lastModelSource(session)
      if (!model) {
        throw editorError(
          'no-model-header',
          'This session has no model header yet; send at least one message before recalling or editing.',
        )
      }
      // 业务溯源(targetSeq 随 editor 一并去掉,读端按区间起点派生):读端的派生值
      // 就是区间起点,故 **业务目标 ≠ 区间起点** 即记诊断(旧守卫只拦"区间之外",
      // "区间内但非起点"会写出一份读端无法还原的溯源值——2026-09 实测:business
      // targetSeq=2 / span.start=0 时旧守卫零诊断、静默错位)。只记不抛:真实 marker
      // 观测(203/203)上二者相等,而合成样例说明理论上可分离——偏离要看得见,
      // 又不阻断合法操作。
      if (Number.isSafeInteger(targetSeq) && targetSeq >= 0 && targetSeq !== span.start) {
        log(`retrace: marker targetSeq ${targetSeq} ≠ 被遮蔽区间起点 ${span.start}(读端按区间起点派生 ⇒ 该溯源值无法由载体还原;区间 ${span.start}..${span.end})`)
      }
      const data = {
        role: 'user',
        id: editorId(op),
        content: carrierContentOf(meta, deriveContentText),
        // 轮边界守卫:轮边界谓词只认 source.kind === 'user'。载体写 'model'
        // (官方 messageSourceValue 对 model 只要求 provider/model 非空串,与角色无关;
        //  v2→v3 的 SOURCE_KINDS 同样含 'model')——写 'user' 会被当成真实用户输入
        // 而切分交换轮,遮蔽段整体偏移,且官方不拦。
        source: { kind: CARRIER_SOURCE_KIND, provider: model.provider, model: model.model },
      }
      // 运行时形状探测(1.2):v0 运行时 = {op,start,end};v3 运行时 = {op,startSeq,endSeq}。
      // 官方 v0 树只校验键数(=3)、不校验键名语义 ⇒ 写错形状会在下游暴露为误导性错误,
      // 因此按运行时选形状,而非硬编码(见 contract.js runtimeSurfaceOpShape)。
      const opShape = runtimeSurfaceOpShape()
      const surfaceOp = opShape.startKey === 'startSeq'
        ? { op: 'replace', startSeq: span.start, endSeq: span.end }
        : { op: 'replace', start: span.start, end: span.end }
      const shadowed = Array.isArray(span.shadowedSeqs) ? span.shadowedSeqs.slice() : []
      // ── 写前断言/校验(全部在任何 append 之前)──
      // 两段结构**成对**(判据 = lib/marker-carrier.js:15 形状 / :23 sourceEventSeqs
      // 首元素 = 第 1 段 seq / :32 同一读法)。任何在第 1 段落盘**之后**才失败的校验
      // 都会留下孤儿审计行(2026-09-14 真机:seq 26032/26033 —— 官方 shadow-price
      // claim 无人消费 ⇒ contextPressure.surfaceTokens 漂移)。
      // 故把完整契约校验**前移**:审计段按它将被写入的位置合成进事件表,与载体一起校验。
      // seq 是唯一无法提前得知的字段:交给 validateMarker 的信封**不带 seq**
      // ——`createPreWriter.validateAppend` 只在 `candidate.seq === undefined` 时按
      // nextSeq 赋值;带伪造 seq(历史硬编码 0)会被判 E2/S6/S8(见 marker-append-seq 测试)。
      // `assertMarkerShape` 仍用 `seq: 0` 的**形状副本**(只要求 seq 是非负安全整数)。
      const carrierEnvelope = (seqs) => ({ type: CARRIER_EVENT_TYPE, data, surfaceOp, sourceEventSeqs: seqs })
      const withShapeSeq = (envelope) => ({ seq: 0, ...envelope })
      const preview = carrierEnvelope(shadowed.slice())
      assertMarkerShape(withShapeSeq(preview), 'dshAdapter.writeMarker.marker(preview)', { runtimeShape: opShape })
      // 写前校验钩子三态(见 prewrite-guard):
      //   pre  = 落盘前只跑业务闸(回档幅度等,不依赖 seq)⇒ 拒绝时**零写入**;
      //   pair = **计划中的两段**(审计 + 载体)整体跑完整契约校验 ⇒ 拒绝时**零写入**;
      //   post = 兼容旧调用方的"第 1 段已落盘"形态(本 writer 已不使用)。
      // 业务闸先于「取令牌价」:业务拒绝的错误码不该被定价路径的内部错误盖掉。
      if (typeof validateMarker === 'function') {
        await validateMarker(session, preview, { phase: 'pre' })
      }
      // 第 1 段 shadowedTokenCount = **官方令牌价**(不是节点个数):官方 fold 把它当
      // shadow-price claim 消费(见 officialShadowPrice)。完全拿不到官方 meter 就**拒写**
      // ——编一个价会静默污染 surfaceTokens(压缩压力/占用率的输入),比拒写危险。
      const meterService = resolveMeter(meter)
      if (!meterService) {
        throw contractViolation(
          'dshAdapter.writeMarker.meter',
          '宿主提供官方 token-meter 服务面(用于 shadow-price claim 的令牌价)',
          'undefined(未注入,或该宿主无 tokenMeter 服务)',
        )
      }
      const shadowedTokenCount = officialShadowPrice({ service: meterService, deriveMessage, session, span, log })
      const auditData = {
        shadowedRange: { start: span.start, end: span.end },
        shadowedSeqs: shadowed.slice(),
        shadowedTokenCount,
      }
      // ① 第 1 段:官方词表把 `compaction/prune` 的 data 定为精确三成员
      //    (无 optional/opaque)⇒ 形状不合规一律在写盘前拦下。
      assertAuditShape({ seq: 0, type: AUDIT_EVENT_TYPE, data: auditData }, 'dshAdapter.writeMarker.audit(preview)')
      // ── pair 校验:两段作为整体,在任何 append 之前 ──────────────────────────
      // 计划中的审计 seq = 当前追加位;校验后**同步复核**(到 appendAudit 之间无 await),
      // 并发 append 使预言过期时重跑校验;连续漂移则零写入报错(不留孤儿)。
      let plannedAuditSeq = nextAppendSeq(session)
      let pairValidated = typeof validateMarker !== 'function'
      for (let attempt = 0; attempt < 3 && !pairValidated; attempt++) {
        const pairEnvelope = carrierEnvelope([plannedAuditSeq, ...shadowed])
        assertMarkerShape(withShapeSeq(pairEnvelope), 'dshAdapter.writeMarker.marker(pair)', { runtimeShape: opShape, auditSeq: plannedAuditSeq })
        await validateMarker(session, pairEnvelope, { phase: 'pair', audit: auditData, auditSeq: plannedAuditSeq })
        const live = nextAppendSeq(session)
        if (live === plannedAuditSeq) pairValidated = true
        else plannedAuditSeq = live
      }
      if (!pairValidated) {
        throw editorError(
          'marker-pair-race',
          'Concurrent appends kept moving the log tail while validating the two-segment marker; nothing was written. Retry.',
        )
      }
      // ── 同步段:审计 + 载体,中间没有任何 await ────────────────────────────
      // 官方 shadow-price 协议要求 claim 与 replace **紧邻**(surface-projection:
      // "producers append the metering event and the replacement synchronously
      // adjacent, so a surviving claim always prices the very next event")。旧流程在
      // 两段之间有一次 post 校验 await ⇒ 并发 append 可能顶掉 claim;现在校验全部前移,
      // 两段在同一同步段内落盘,相邻性由结构成立(rearmClaim 仅作兜底)。
      const auditSeq = appendAudit(session, auditData)
      if (auditSeq !== plannedAuditSeq) {
        throw editorError(
          'marker-pair-race',
          `Audit segment landed at seq ${auditSeq} but the two-segment marker was validated at ${plannedAuditSeq}; nothing further was written. Retry.`,
        )
      }
      const reArmed = rearmClaim(session, span, auditSeq, shadowedTokenCount, log)
      const finalAuditSeq = reArmed === auditSeq ? auditSeq : reArmed
      if (finalAuditSeq !== auditSeq) {
        log(`retrace: 已重挂审计段 seq ${finalAuditSeq}(并发顶掉;旧段留在日志里,log-only,不遮蔽任何节点)`)
      }
      // 第 2 段落盘(首元素 = 审计 seq,其后是全部被遮蔽节点)。
      const carrier = session.append(CARRIER_EVENT_TYPE, data, { surfaceOp, sourceEventSeqs: [finalAuditSeq, ...shadowed] })
      // ── 写后对账:两段成对(判据见 lib/marker-carrier.js:23/:32)──
      assertPairing(session, finalAuditSeq, carrier)
      return carrier
    },
  }
}

/** 写第 1 段(审计事件),返回其 seq(非法即抛)。 */
function appendAudit(session, auditData) {
  const auditEvent = session.append(AUDIT_EVENT_TYPE, auditData)
  const auditSeq = Number(auditEvent?.seq)
  if (!Number.isSafeInteger(auditSeq) || auditSeq < 0) {
    throw contractViolation('dshAdapter.writeMarker.auditSeq', 'append 返回的审计事件 seq 为非负安全整数', auditEvent?.seq)
  }
  return auditSeq
}

/** 日志末尾事件的 seq(会话对象无 events 视图时 null ⇒ 跳过相邻性复核)。 */
function tailSeqOf(session) {
  const events = sessionEvents(session)
  if (!Array.isArray(events) || events.length === 0) return null
  const last = events[events.length - 1]
  return Number.isSafeInteger(last?.seq) ? last.seq : null
}

/**
 * 复核 claim 与 replace 的相邻性(见上面 writeMarker 的说明):不满足则重挂审计段。
 * @returns {number} 第 2 段应引用的审计 seq(相邻时即原值)
 */
function rearmClaim(session, span, auditSeq, shadowedTokenCount, log) {
  const tail = tailSeqOf(session)
  if (tail === null || tail === auditSeq) return auditSeq
  log(`retrace: shadow-price claim(审计段 seq ${auditSeq})被并发事件 seq ${tail} 顶掉 ⇒ 重挂 claim;旧审计段留在日志里(log-only,不遮蔽任何节点)`)
  return appendAudit(session, {
    shadowedRange: { start: span.start, end: span.end },
    shadowedSeqs: Array.isArray(span.shadowedSeqs) ? span.shadowedSeqs.slice() : [],
    shadowedTokenCount,
  })
}

/**
 * 写后对账:第 2 段与第 1 段**成对**。
 *
 * 判据取自契约本身(`lib/marker-carrier.js`):
 *   - `:15` 形状 = 第 1 段先写、第 2 段后写,两者都引用更早 seq;
 *   - `:23` 第 2 段 `sourceEventSeqs = [<第 1 段 seq>, …全部被遮蔽节点]`;
 *   - `:32` 关联读法(判据):第 2 段 `sourceEventSeqs` **首元素 = 第 1 段 seq**。
 * 不满足 ⇒ 显式失败(marker-pair-unpaired),不静默返回半写结果。
 * @param {object} session
 * @param {number} auditSeq - 第 1 段(审计)seq
 * @param {object} carrier - 第 2 段(载体)事件
 */
function assertPairing(session, auditSeq, carrier) {
  const auditEvent = eventAt(session, auditSeq)
  const first = Array.isArray(carrier?.sourceEventSeqs) ? carrier.sourceEventSeqs[0] : undefined
  const paired = first === auditSeq
    && Number.isSafeInteger(carrier?.seq)
    && carrier.seq === auditSeq + 1
    && auditEvent?.type === AUDIT_EVENT_TYPE
  if (!paired) {
    throw editorError(
      'marker-pair-unpaired',
      `Marker segments are not paired: carrier.seq=${String(carrier?.seq)} sourceEventSeqs[0]=${String(first)} audit seq=${auditSeq} (event type=${String(auditEvent?.type ?? 'missing')}). An orphan audit segment may remain in the log () — do not ignore.`,
    )
  }
}
