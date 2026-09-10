/**
 * GENERATED FILE — do not edit by hand.
 * Source of truth: lib/host-core.js + lib/adapter/dsh-writer.js + the wrapper
 * below (scripts/generate-dynamic.mjs).
 */
return {
  inject: ['sessions', 'agents'],
  apply(ctx) {
    const { sessions, agents } = ctx
    const log = (line) => console.error(`retrace: ${line}`)
    /**
     * dsh-retrace — lib/span-semantics.js
     *
     * 「遮蔽范围(span)」语义的**单一真相**(issue-229 第 1/2 项,复核):
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
     * 遮蔽计算结果的显式状态(issue-229 第 1 项)。
     *
     * | 状态             | 含义                                             | 调用方语义            |
     * |------------------|--------------------------------------------------|-----------------------|
     * | ok               | 找到 span                                        | 用 span 写遮蔽        |
     * | not-found        | 快照里没有这个目标(seq 空洞 / 事件列表不可读)   | 明确的 not-found 错误 |
     * | already-shadowed | 目标在日志里,但已被更早的 replace 移出当前面     | target-shadowed(只读) |
     * | not-persisted    | 目标尚未落盘(刚 commit,文件快照还没它)          | message-pending(可重试)|
     * | replay-failed    | 面重放(foldSurface)失败 —— 内部错误,非用户问题  | 内部错误(绝不冒充遮蔽) |
     */
    const SPAN_STATUS = Object.freeze({
      OK: 'ok',
      NOT_FOUND: 'not-found',
      ALREADY_SHADOWED: 'already-shadowed',
      NOT_PERSISTED: 'not-persisted',
      REPLAY_FAILED: 'replay-failed',
    })
    
    /** 遮蔽模式(语义见文件头)。
     */
    const SPAN_MODE = Object.freeze({
      ROUND: 'round',
      TAIL: 'tail',
    })
    
    /** 该值是否合法状态(契约校验用;不引依赖)。 */
    function isSpanStatus(value) {
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
    function isRoundBoundaryEvent(event) {
      return event?.type === 'user/message' && event?.data?.source?.kind === 'user'
    }
    
    /**
     * 目标位置 → 轮首位置(向前找最近的轮边界;找不到则停在目标自身位置)。
     * 唯一实现:业务层与适配层的 round/tail 共用(审计第 2 项的分叉点就在这条规则)。
     */
    function roundStartIndex(nodes, index, isBoundary) {
      for (let i = index; i >= 0; i--) {
        if (isBoundary(nodes[i])) return i
      }
      return index
    }
    
    /** 轮首位置 → 轮尾位置(向后找下一个轮边界前一位;没有则到序列末尾)。 */
    function roundEndIndex(nodes, startIndex, isBoundary) {
      for (let i = startIndex + 1; i < nodes.length; i++) {
        if (isBoundary(nodes[i])) return i - 1
      }
      return nodes.length - 1
    }
    
    /** 位置段 [startPos..endPos] → span 结构(空段 → null)。 */
    function spanSliceOf(nodes, startPos, endPos) {
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
     * @param {number} [options.endSeq] - range 模式区间终点 seq(须为节点)。
     * @returns {{start:number,end:number,shadowedSeqs:number[]}|null}
     */
    function spanAt(nodes, index, options = {}) {
      const { mode = SPAN_MODE.ROUND, isBoundary = () => false, endSeq } = options
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
    function spanForSeq(nodes, seq, options = {}) {
      if (!Array.isArray(nodes)) return null
      const index = nodes.indexOf(seq)
      if (index === -1) return null
      return spanAt(nodes, index, options)
    }
    
    /** 成功结果(统一结构;调用方不组装裸对象)。 */
    function spanOk(span, facts) {
      return { status: SPAN_STATUS.OK, span, facts }
    }
    
    /** 失败结果(status 显式;span 恒为 null,不再让 null 承载多种语义)。 */
    function spanMiss(status, facts) {
      return { status, span: null, facts }
    }
    
    /**
     * 计算结果 → 业务层判定输入(args.spanStatus / args.spanFacts)。
     *
     * 只在**文件侧确有快照证据**时下传(fileMaxSeq >= 0):文件不可读时无证据,
     * 交回业务层按内存视图判定(0.4.24 及以前的行为,不变)。
     * @returns {{spanStatus:string, spanFacts:object}|null} null = 无需下传/调用方自行判定
     */
    function spanMissArgsOf(result) {
      if (!result || typeof result !== 'object') return null
      if (result.status === SPAN_STATUS.OK || result.span) return null
      const facts = result.facts
      if (!facts || typeof facts.fileMaxSeq !== 'number' || facts.fileMaxSeq < 0) return null
      return { spanStatus: result.status, spanFacts: facts }
    }
    
    /** 日志用一行摘要(span 长度 / 状态 + 快照事实)。 */
    function describeSpanResult(result) {
      if (!result || typeof result !== 'object') return 'no-result'
      const facts = result.facts ?? {}
      const tail = `targetSeq=${Number.isSafeInteger(facts.targetSeq) ? facts.targetSeq : -1},fileMaxSeq=${Number.isSafeInteger(facts.fileMaxSeq) ? facts.fileMaxSeq : -1}`
      if (result.status === SPAN_STATUS.OK) {
        const n = Array.isArray(result.span?.shadowedSeqs) ? result.span.shadowedSeqs.length : 0
        return `${SPAN_STATUS.OK}:${n} seqs(${tail})`
      }
      return `${result.status}(${tail})`
    }
    /**
     * dsh-retrace — lib/adapter/contract.js
     *
     * 适配器层契约(2026-09-01)——业务层与平台解耦的接口定义。
     * **2026-09-10 契约运行时化(issue-229 第 3 项,复核)**:契约不再只是 JSDoc
     * 声明——跨层边界处的形状在**运行时**被断言,违反时抛出**指名道姓**的错误
     * (哪个契约 / 期望什么 / 实际什么),不再"以奇怪方式炸"或静默通过。
     *
     * 目标:换架构(不用 DSH)时,业务层(message-list.js/守卫)零改动,
     * 只需实现新的「读事件 + 写替换」两个适配器。
     *
     * 三个角色:
     * - 业务层:message-list.js(纯函数,零依赖)——消费「通用事件」,产出消息列表/遮蔽;
     * - 适配器层(本文件):定义「事件读取器」和「替换写入器」两个接口 + 运行时校验;
     * - 平台实现:dsh.js / dsh-writer.js(DSH 实现)、未来 self-runtime-adapter.js 等。
     *
     * 通用事件格式(业务层消费的最小形态):
     *   { seq, type, turn, data, source }——与具体平台的存储格式无关。
     *
     * 校验原则(轻量,零依赖):
     * - 纯函数:不达标 → **抛**(`code: 'contract-violation'`,附 contract/expected/actual),
     *   或返回带 violations 的结果(供"体检"式调用);
     * - 成本可控:大日志(百万级事件)只**抽样**校验头/中/尾,禁止 O(n) 全量断言;
     * - 只在**跨层边界**校验:适配器返回值、跨层传入的 span、写出的 marker——
     *   内部实现细节不设卡(避免把断言变成运行负担)。
     *
     * 零平台 import(只引纯语义模块) → 动态插件 realm 可 inline。
     */
    
    /** 契约违规错误码(host 侧透传到 wire;client 未映射时显示 host message)。 */
    const CONTRACT_VIOLATION = 'contract-violation'
    
    /** 实际值的紧凑渲染(错误信息可读;超长截断,不 dump 百万事件)。 */
    function describeActual(value) {
      if (value === undefined) return 'undefined'
      if (value === null) return 'null'
      if (typeof value === 'function') return 'function'
      if (Array.isArray(value)) return `Array(${value.length})`
      if (typeof value === 'object') {
        const keys = Object.keys(value)
        return `{${keys.slice(0, 8).join(',')}${keys.length > 8 ? ',…' : ''}}`
      }
      const text = String(value)
      return text.length > 80 ? `${text.slice(0, 80)}…` : text
    }
    
    /**
     * 造一个契约违规错误:错误信息里说清**哪个契约 / 期望什么 / 实际什么**。
     * @param {string} contract - 契约名(如 'Span.shape' / 'ReplaceWriter.result')
     * @param {string} expected - 期望(人读)
     * @param {unknown} actual - 实际值(渲染后入 message,原值挂 error.actual)
     * @returns {Error}
     */
    function contractViolation(contract, expected, actual) {
      const error = new Error(`契约违规[${contract}]:期望 ${expected};实际 ${describeActual(actual)}`)
      error.code = CONTRACT_VIOLATION
      error.contract = contract
      error.expected = expected
      error.actual = actual
      return error
    }
    
    /** 断言(条件不成立 → 抛契约违规)。 */
    function assertContract(condition, contract, expected, actual) {
      if (!condition) throw contractViolation(contract, expected, actual)
      return true
    }
    
    const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
    
    /**
     * span 结构契约:{start, end, shadowedSeqs} 且 shadowedSeqs 是**位置连续段**
     * (首尾 === start/end)——写入端 surfaceOp 与 sourceEventSeqs 一致性的前提,
     * 也是"遮蔽语义保证"的唯一可判定形式。
     */
    function assertSpanShape(span, contract = 'Span.shape') {
      assertContract(isPlainObject(span), contract, 'span 为对象 {start,end,shadowedSeqs}', span)
      assertContract(
        Number.isSafeInteger(span.start) && span.start >= 0,
        contract, 'span.start 为非负安全整数', span.start,
      )
      assertContract(
        Number.isSafeInteger(span.end) && span.end >= span.start,
        contract, 'span.end 为安全整数且 >= start', span.end,
      )
      assertContract(
        Array.isArray(span.shadowedSeqs) && span.shadowedSeqs.length > 0,
        contract, 'span.shadowedSeqs 为非空数组', span.shadowedSeqs,
      )
      assertContract(
        span.shadowedSeqs.every((seq) => Number.isSafeInteger(seq)),
        contract, 'span.shadowedSeqs 元素全为非负安全整数', span.shadowedSeqs,
      )
      assertContract(
        span.shadowedSeqs[0] === span.start && span.shadowedSeqs[span.shadowedSeqs.length - 1] === span.end,
        contract, 'shadowedSeqs 首尾 === span.start/end(位置连续段)', span.shadowedSeqs,
      )
      return span
    }
    
    /**
     * span 计算结果契约(issue-229 第 1 项):`{ status, span, facts }`——
     * status 必须是 SPAN_STATUS 成员;status ≠ ok 时 span 必须为空
     * (状态显式,不允许"有 span 又报失败"的自相矛盾结果)。
     */
    function assertSpanResult(result, contract = 'SpanResult.shape') {
      assertContract(isPlainObject(result), contract, '结果为对象 {status, span, facts}', result)
      assertContract(isSpanStatus(result.status), contract, `status ∈ SPAN_STATUS(${Object.values(SPAN_STATUS).join('|')})`, result.status)
      if (result.status === SPAN_STATUS.OK) {
        assertSpanShape(result.span, `${contract}.span`)
      } else {
        assertContract(
          result.span === null || result.span === undefined,
          contract, 'status ≠ ok 时 span 必须为空(null/undefined)', result.span,
        )
      }
      if (result.facts !== undefined) assertSpanFacts(result.facts, `${contract}.facts`)
      return result
    }
    
    /** 文件快照事实契约:{fileMaxSeq, targetSeq}(-1 = 未知/不可读)。 */
    function assertSpanFacts(facts, contract = 'SpanFacts.shape') {
      assertContract(isPlainObject(facts), contract, 'facts 为对象 {fileMaxSeq,targetSeq}', facts)
      assertContract(Number.isSafeInteger(facts.fileMaxSeq), contract, 'facts.fileMaxSeq 为安全整数(-1 = 快照不可读)', facts.fileMaxSeq)
      assertContract(Number.isSafeInteger(facts.targetSeq), contract, 'facts.targetSeq 为安全整数(-1 = 快照未含目标)', facts.targetSeq)
      return facts
    }
    
    /**
     * 事件列表契约(EventReader 返回值)——通用事件最小形态的**抽样**校验:
     * 元素必须是非 null 对象;带 seq 时必须是数字(header 帧等无 seq 事件合法)。
     * 抽样头/中/尾(百万级日志不做 O(n) 断言,成本必须可忽略)。
     */
    function assertEventListShape(events, contract = 'EventReader.events', { sample = 5 } = {}) {
      assertContract(Array.isArray(events), contract, '事件列表为数组(null = 读取失败,由调用方降级)', events)
      if (events.length === 0) return events
      const positions = new Set([0, events.length - 1, Math.floor(events.length / 2), 1, events.length - 2])
      let checked = 0
      for (const i of positions) {
        if (i < 0 || i >= events.length || checked >= sample) continue
        checked++
        const event = events[i]
        assertContract(isPlainObject(event), contract, `events[${i}] 为非 null 对象(通用事件形态)`, event)
        if (event.seq !== undefined) {
          assertContract(typeof event.seq === 'number' && Number.isSafeInteger(event.seq), contract, `events[${i}].seq 为安全整数(或省略)`, event.seq)
        }
        if (event.type !== undefined) {
          assertContract(typeof event.type === 'string', contract, `events[${i}].type 为字符串(或省略)`, event.type)
        }
      }
      return events
    }
    
    /**
     * 写入端 marker 事件契约(ReplaceWriter 返回值)。
     *
     * 为什么这些字段必须断言:"写前校验保证 marker 合法"是**声称**——本断言把
     * 其中的形状部分变成**有校验**的事实:marker 是替换型空 assistant 消息,
     * `surfaceOp.start/end` 必须与 `sourceEventSeqs` 首尾一致(否则重放面与写入
     * 端分叉 → 遮蔽范围与日志不一致,历史上正是这类不一致导致会话加载失败)。
     */
    function assertMarkerShape(marker, contract = 'ReplaceWriter.marker') {
      assertContract(isPlainObject(marker), contract, 'marker 为事件对象', marker)
      assertContract(Number.isSafeInteger(marker.seq) && marker.seq >= 0, contract, 'marker.seq 为非负安全整数', marker.seq)
      assertContract(marker.type === 'assistant/message', contract, "marker.type === 'assistant/message'", marker.type)
      const op = marker.surfaceOp
      assertContract(isPlainObject(op) && op.op === 'replace', contract, "marker.surfaceOp = {op:'replace',start,end}", op)
      assertContract(Number.isSafeInteger(op.start) && Number.isSafeInteger(op.end) && op.end >= op.start, contract, 'marker.surfaceOp.start/end 为安全整数且 start <= end', `${op.start}..${op.end}`)
      const seqs = marker.sourceEventSeqs
      assertContract(Array.isArray(seqs) && seqs.length > 0, contract, 'marker.sourceEventSeqs 为非空数组', seqs)
      assertContract(
        seqs[0] === op.start && seqs[seqs.length - 1] === op.end,
        contract, 'sourceEventSeqs 首尾 === surfaceOp.start/end(写入端与重放面一致)', `${seqs[0]}..${seqs[seqs.length - 1]}`,
      )
      const editor = marker.data?.editor
      assertContract(
        isPlainObject(editor) && Number.isSafeInteger(editor.targetSeq),
        contract, 'marker.data.editor.targetSeq 为安全整数(业务溯源字段)', editor?.targetSeq,
      )
      return marker
    }
    
    /** 适配器组装契约(两个角色都必须实现各自方法)。 */
    function assertAdapterShape(adapter, contract = 'Adapter.shape') {
      assertContract(isPlainObject(adapter), contract, '适配器为对象 {reader, writer}', adapter)
      assertContract(
        isPlainObject(adapter.reader) && typeof adapter.reader.readEvents === 'function',
        contract, 'adapter.reader.readEvents 为函数(EventReader)', adapter.reader,
      )
      assertContract(
        isPlainObject(adapter.writer) && typeof adapter.writer.writeReplace === 'function',
        contract, 'adapter.writer.writeReplace 为函数(ReplaceWriter)', adapter.writer,
      )
      return adapter
    }
    
    /**
     * 事件读取器接口:按 sessionId 提供「全量事件」(可靠事实,非内存视图)。
     * @typedef {Object} EventReader
     * @property {(sessionId: string) => Promise<Array<{seq:number, type:string, turn?:number, data?:object, source?:object}>|null>} readEvents
     *   - 返回按 seq 升序的全量事件;
     *   - 必须从持久化层读(文件/存储),不依赖运行内存(host 内存可能稀疏/窗口化);
     *   - 失败返回 null/throw 由调用方 fallback(运行时经 assertEventListShape 抽样校验)。
     */
    
    /**
     * 替换写入器接口:在会话上写「遮蔽替换」(模型侧消费)。
     * @typedef {Object} ReplaceWriter
     * @property {(sessionId: string, span: {start:number, end:number, shadowedSeqs:number[]}) => Promise<object>} writeReplace
     *   - 用平台机制写替换标记(DSH = session.append + surfaceOp replace);
     *   - 返回写入结果(marker seq 等),运行时经 assertMarkerShape 校验。
     */
    
    /**
     * 组装一个「完整适配器」:读事件 + 写替换,业务层只依赖它。
     * @param {EventReader} reader
     * @param {ReplaceWriter} writer
     */
    function createAdapter(reader, writer) {
      return assertAdapterShape({ reader, writer }, 'Adapter.assembly')
    }
    
    /** 空适配器(无平台时,业务层可独立运行)。 */
    const NULL_ADAPTER = createAdapter(
      { readEvents: async () => null },
      { writeReplace: async () => null },
    )
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
     * module appends an *invisible* replacement marker (an empty assistant message
     * derives to no model message) so the conversation rewinds to before the
     * target while the durable transcript keeps an audit trail.
     *
     * Pure ESM with zero **platform** imports: safe to run inside the dynamic-package
     * sandbox and inside a published package alike. Every op resolves to a transport-
     * neutral result object `{ ok: true, value }` or `{ ok: false, error }` and
     * never rejects (transport failures are the caller's concern).
     *
     * issue-229(复核,2026-09-10)——本文件的两处收敛:
     * 1. **span 语义单一真相**(第 2 项):轮首回退/尾部切片/区间段规则搬去
     *    lib/span-semantics.js(spanAt),本文件只提供「节点序列 + 轮边界谓词」——
     *    此前业务层(本文件)与适配层(adapter/dsh.js)各写一份切片规则,语义迟早
     *    分叉(审计:"预览与写入迟早对不上")。
     * 2. **span 未命中的判定读显式状态**(第 1 项):args.spanStatus(文件层给出的
     *    SPAN_STATUS)优先;无状态(文件不可读/直接调用/测试桩)才回落到内存判定。
     */
    
    const EDITOR_PLUGIN = 'retrace'
    
    /**
     * Message-id prefix every event this plugin appends carries (client discriminator).
     * RENAME RULE: when the plugin changes identity, KEEP this prefix unchanged for
     * new markers — or, if it must change, add the old value to the legacy prefix
     * lists in lib/client.js (MARKER_PREFIXES / LEGACY_MARKER_PREFIXES) and
     * lib/version-index.js (MARKER_ID_PREFIXES) so old markers keep rendering and
     * classifying. Recognition must never be broken by a rename.
     */
    const MARKER_ID_PREFIX = 'retrace'
    
    /** A fresh marker event id: `<prefix>-<op>-<time36>-<rand>`. */
    function editorId(op) {
      return `${MARKER_ID_PREFIX}-${op}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    }
    
    /** An error carrying a stable wire `code` (mirrors the editor result shape). */
    function editorError(code, message, details) {
      const error = new Error(message)
      error.code = code
      // issue-200:附带结构化排查信息(messageId/seq 等),经 op() 信封透传到 wire
      if (details && typeof details === 'object') error.details = details
      return error
    }
    
    /**
     * issue-199:目标被更早 fold/recall/compact 遮蔽(历史只读)——文案给正解:
     * 展开该块后编辑,或追加新消息修订。host 侧即中文(不再透传英文),
     * client 按 code 再本地化(zh/en 同文案,见 lib/client.js error.*)。
     */
    const SHADOWED_TARGET_MESSAGE = '该消息位于已折叠块(历史只读):展开该块后编辑,或追加新消息修订'
    
    /**
     * issue-200:目标消息「提交中」(刚 commit/文件 flush 滞后,span 快照尚未纳入)
     * ——可重试,不是用户消息出了问题。
     */
    const PENDING_TARGET_MESSAGE = '消息生成中,完成后可编辑'
    
    /**
     * issue-229:遮蔽范围重放失败(内部错误)。issue-199 之前这类失败与「已被遮蔽」
     * 共用 null → 用户看到"历史只读"(误导且不可行动);现在如实报内部错误。
     */
    const SPAN_REPLAY_FAILED_MESSAGE = '遮蔽范围计算失败(内部错误):会话日志重放异常,请重试或反馈该会话'
    
    /** issue-229:文件侧确证目标不存在(不是"提交中",也不是"被遮蔽")时的文案。 */
    const TARGET_NOT_FOUND_MESSAGE = '目标消息不在会话日志中(可能已删除或消息 id 无效)'
    
    /** Latest known provider/model: from the last request header, else last assistant message. */
    function lastModelSource(session) {
      const events = session.events
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
    
    /**
     * 写「遮蔽 marker」——业务层唯一入口（2026-09-02 抽象设计落地）。
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
    function createEditorApi(ctx, sessions, agents, log = () => {}, hooks = {}) {
      /** One in-flight op per session; later ops wait for the earlier one. */
      const locks = new Map()
    
      /**
       * 写「遮蔽 marker」——业务层唯一入口（2026-09-02 抽象设计落地）。
       * 平台写入器（DSH 三情形翻译）经 hooks.writeMarker 注入，本函数只组装
       * 业务意图（op + targetSeq + originalText）并转发；写入器缺失 = 平台未装配。
       */
      async function writeMarker(session, span, op, targetSeq, originalText) {
        const writer = hooks?.writeMarker
        if (typeof writer !== 'function') {
          throw editorError('writer-unavailable', 'No marker writer (adapter) is wired; cannot shadow messages.')
        }
        // 契约运行时化(issue-229 第 3 项):业务层 → 适配器 = 跨层边界。
        // 传出去的 span 必须先合规(否则写入端 surfaceOp/sourceEventSeqs 会写出与
        // 重放面不一致的 marker);返回的 marker 也必须合规(否则下游读 seq/editor
        // 时"以奇怪方式炸")。违规 → contract-violation(指名道姓),绝不静默。
        assertSpanShape(span, 'host-core.writeMarker.span')
        const markerEvent = await writer(session, span, { op, targetSeq, originalText })
        assertMarkerShape(markerEvent, 'host-core.writeMarker.marker')
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
       * 确保 agent 空闲（2026-08-30 事故闭环，用户方案落地）：agent 正在响应时，
       * **不拒绝**——自动请求停止（`agent.cancel`）并等待其干净收尾（`whenIdle`）。
       *
       * 为什么必须等停止：编辑/重发发生在 agent 还开着 step 时，DSH 的 resend 机制
       * 会把旧 step 的 assistant/chunk 全部引用进新 assistant/message 的
       * `sourceEventSeqs`（5e551007 seq 7000004：引用跨 turn 54 的 step 7/8/9），
       * token-meter 对跨 step 引用抛 `belongs to another step`（dsh-token-meter
       * lib/index.js:645）→ 同样刷屏压垮 host。先停止 → step 干净关闭 → 编辑在
       * 轮次边界执行，不再触发跨 step 引用。
       *
       * agent 无 cancel/whenIdle（headless/测试桩）时回退为抛 agent-busy（原行为）。
       */
      async function ensureIdle(agent) {
        if (!agent || typeof agent.status !== 'string' || agent.status !== 'running') return
        if (typeof agent.cancel === 'function' && typeof agent.whenIdle === 'function') {
          try {
            // 官方 AgentCancelCause 类型只有 user/parent/hook/disposed 四种
            // （dsh-commands typert.host.js:166）——用 { kind: 'user' } 与 UI 停止按钮同义，
            // 中断的 turn/end 会按官方语义记录 reason。
            agent.cancel({ kind: 'user' })
            await agent.whenIdle()
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
        const events = session.events
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
       * 遮蔽计算(2026-09-01 彻底绕开稀疏 events):在 surface.nodes(全量 seq 列表)里
       * 找轮边界,不遍历稀疏的 session.events 数组(host events 可能只加载部分,
       * 用户实测 host 报 2006 vs 文件全量 10;稀疏遍历的 undefined 洞导致遮蔽全量)。
       *
       * issue-229 第 2 项:切片规则(轮首回退 / 尾部切片 / 区间段)**不再在本文件实现**,
       * 一律调用 lib/span-semantics.js 的 spanForSeq —— 与适配层(adapter/dsh.js 的
       * computeSpan,主路径用文件全量 + 官方 foldSurface nodes)同一实现,业务层与
       * 适配层的 span 语义从此不可能分叉(审计:"预览与写入迟早对不上")。
       * 本函数只负责:取节点序列(内存 surface.nodes)、给轮边界谓词、喂目标 seq。
       * - mode='round':遮蔽目标所在轮——edit/regenerate 用;
       * - mode='tail' :从目标轮首遮蔽到面尾——fromScratch/recall 用。
       */
      function shadowSpanFrom(session, startSeq, { mode = 'round' } = {}) {
        const events = session.events
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
       * issue-229 第 2 项;此前本文件与 dsh.js 各有一份重复拷贝)。
       */
      const isRoundBoundary = isRoundBoundaryEvent
    
      /**
       * The exchange-round span containing `seq`: the user input plus everything
       * the agent produced for it (all assistant/tool nodes up to the next user
       * input). Recalling one message therefore removes the whole round — input
       * AND output — from the model surface.
       *
       * 2026-09-01 修复(彻底绕开稀疏 events):在 surface.nodes(全量 seq 列表)里找
       * 轮边界,不遍历稀疏的 session.events 数组——host 的 events 可能只加载部分
       * (用户实测: 编辑消息 host 报遮蔽 2006,而文件全量算只有 10 个;稀疏 events
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
       * span 未命中 → 落成哪个错误码(issue-229 第 1 项:判定 = **读显式状态**,不再靠 null 猜)。
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
        if (status === SPAN_STATUS.NOT_FOUND) return 'not-found'
        if (status === SPAN_STATUS.REPLAY_FAILED) return 'replay-failed'
        const facts = args?.spanFacts
        if (facts && typeof facts.fileMaxSeq === 'number' && facts.fileMaxSeq >= 0) {
          return seq > facts.fileMaxSeq ? 'pending' : 'shadowed'
        }
        const events = session.events
        const nodes = Array.isArray(session.surface?.nodes) ? session.surface.nodes : []
        if (Array.isArray(events)) {
          for (let i = events.length - 1; i >= 0; i--) {
            const ev = events[i]
            if (!ev || ev.surfaceOp?.op !== 'replace') continue
            const shadowedSeqs = Array.isArray(ev.sourceEventSeqs)
              ? ev.sourceEventSeqs
              : Array.isArray(ev.data?.editor?.shadowedSeqs) ? ev.data.editor.shadowedSeqs
              : Array.isArray(ev.data?.shadowedSeqs) ? ev.data.shadowedSeqs : null
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
       * span 未命中分支统一抛错(issue-200/199/229):按**显式状态**给错误码——
       * pending → message-pending(可重试);shadowed → target-shadowed(中文可操作文案);
       * not-found → message-not-found(与内存侧 findMessageSeq 同一错误码);
       * replay-failed → span-replay-failed(内部错误,不冒充遮蔽)。
       */
      function throwSpanMiss(session, seq, args, messageId) {
        const details = { messageId, seq }
        switch (spanMissKind(session, seq, args)) {
          case 'pending':
            throw editorError('message-pending', PENDING_TARGET_MESSAGE, details)
          case 'not-found':
            throw editorError('message-not-found', TARGET_NOT_FOUND_MESSAGE, details)
          case 'replay-failed':
            throw editorError('span-replay-failed', SPAN_REPLAY_FAILED_MESSAGE, details)
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
                    // issue-200:editorError 附带的排查信息(messageId/seq)透传到 wire;
                    // 放前面,code/message 恒为准,不会被 details 覆盖。
                    ...(error && typeof error.details === 'object' && error.details ? error.details : {}),
                    code: error && typeof error.code === 'string' ? error.code : 'internal',
                    message: error instanceof Error ? error.message : String(error),
                  },
                }),
              ),
          )
      }
    
      /** Extract the durable text of a user or assistant message by seq. */
      function messageTextOf(session, seq) {
        const event = session.events[seq]
        if (!event) return ''
        const data = event.type === 'user/message' ? event.data : event.data?.message
        return extractUserText(data?.content)
      }
    
      /** 撤回: remove the whole exchange round (input + output) around one message. */
      const recall = op(async (args) => {
        const sessionId = String(args?.sessionId ?? '')
        const messageId = String(args?.messageId ?? '')
        const session = requireSession(sessionId)
        await ensureIdle(agents.get(sessionId))
        const seq = findMessageSeq(session, messageId)
        if (seq === -1) throw editorError('message-not-found', 'Message not found in this session.')
        // 2026-09-07:撤回语义 = 遮蔽目标轮及之后全部(编辑=从此处分叉,bfb965e4/5e551006
        // issue)——fallback 用 tail;主路径由 index.js 注入 spanFromFile(官方 foldSurface nodes)。
        // 大范围遮蔽由快照点守卫引导分支(太旧消息的正确出口)。
        // issue-200:span null 不直接当「被遮蔽」——先区分「提交中(文件/快照滞后,可重试)」
        // 与「真被遮蔽(fold/recall/compact 已移除,历史只读)」。
        const span = args?.span ?? shadowSpanFrom(session, seq, { mode: 'tail' })
        if (!span) throwSpanMiss(session, seq, args, messageId)
        const markerEvent = await writeMarker(session, span, 'recall', seq, messageTextOf(session, seq))
        await flushSafely(session)
        return {
          op: 'recall',
          messageId,
          seq,
          markerSeq: markerEvent.seq,
          shadowed: span.shadowedSeqs.length,
          text: messageTextOf(session, seq),
          markerT1Broken: markerEvent?.data?.editor?.markerT1Broken === true,
        }
      })
    
      /**
       * 编辑重发: rewind before a user message, replace it with `text`, then re-trigger
       * the agent. With `fromScratch` the whole surface is rewound first, so the
       * conversation continues from a clean slate (new-conversation semantics).
       */
      const editAndResend = op(async (args) => {
        const sessionId = String(args?.sessionId ?? '')
        const messageId = String(args?.messageId ?? '')
        const text = args?.text
        const fromScratch = args?.fromScratch === true
        const session = requireSession(sessionId)
        const agent = agents.get(sessionId)
        await ensureIdle(agent)
        const seq = findMessageSeq(session, messageId)
        if (seq === -1) throw editorError('message-not-found', 'Message not found in this session.')
        const event = session.events[seq]
        if (!isRoundBoundary(event)) {
          throw editorError('not-user-message', 'Only user messages can be edited and re-sent.')
        }
        if (typeof text !== 'string' || text.trim().length === 0) {
          throw editorError('blank-text', 'The edited message must not be empty.')
        }
        if (!agent || typeof agent.followup !== 'function') {
          throw editorError('agent-unavailable', 'No live agent for this session; cannot re-send.')
        }
        const originalText = messageTextOf(session, seq)
        // 2026-09-01 事件级:fromScratch 取第一个 user 输入(不依赖 surface.nodes[0])
        const startSeq = fromScratch
          ? (session.events.findIndex((e) => isRoundBoundary(e)) >= 0 ? session.events.findIndex((e) => isRoundBoundary(e)) : 0)
          : seq
        if (startSeq === undefined) throw editorError('empty-surface', 'This session has no conversation to edit.')
        // 2026-09-01 修复:普通编辑用「轮内遮蔽」(只遮蔽目标输入+它的回复),不遮蔽到尾部——
        // 否则编辑「最新消息」会遮蔽 surface 尾部全部(用户实测:编辑"测试1"遮蔽 1806 节点,
        // 因为 UI 显示的消息在 surface 中间位置)。fromScratch 才遮蔽到尾部(重新开始语义)。
        // 2026-09-01 二次修复:若外部传入 span(host 从文件读全量算好,绕开稀疏 session.events),
        // 直接用外部 span;否则用内部计算(受 host 内存视图影响,可能不准)。
        // issue-200:span null 先区分「提交中(可重试)」vs「真被遮蔽(历史只读)」。
        const span = args?.span ?? (fromScratch ? shadowSpanFrom(session, startSeq, { mode: 'tail' }) : roundSpanFrom(session, seq))
        if (!span) throwSpanMiss(session, seq, args, messageId)
        const markerEvent = await writeMarker(session, span, 'edit', seq, originalText)
        await flushSafely(session)
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
          markerT1Broken: markerEvent?.data?.editor?.markerT1Broken === true,
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
        const event = session.events[seq]
        if (event?.type !== 'assistant/message') {
          throw editorError('not-assistant-message', 'Regenerate targets an assistant reply.')
        }
        // issue-200/199:判定序与 recall/editAndResend 对齐——args.span(文件注入)优先;
        // 无 span 时先在内存 surface 上找前置 user 输入;「内存 surface 找不到目标」
        // 不再无条件当遮蔽终判(提交竞态里内存 surface 可能滞后于刚 commit 的事件,
        // 旧代码在 :413 直接抛 target-shadowed,与 recall/edit 的 span-null 判定不一致)。
        const nodes = Array.isArray(session.surface?.nodes) ? session.surface.nodes : []
        const idx = nodes.indexOf(seq)
        let userSeq = -1
        if (args?.span) {
          // M-1(独立审查 74e580d 后续):文件已注入 round span(其起点 = 目标同一轮的
          // 前置 user,由文件全量 events + 官方 nodes 算得)时,**绝不直扫稀疏
          // session.events 找前置 user**——host 内存 events 是窗口化视图(有 undefined
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
          } else if (Number.isSafeInteger(args.span.start) && isRoundBoundary(session.events[args.span.start])) {
            userSeq = args.span.start
          }
        } else if (idx !== -1) {
          // 2026-09-01 在 nodes(全量 seq 列表)里向前找最近的 user 输入——不遍历稀疏 events
          for (let i = idx - 1; i >= 0; i--) {
            if (isRoundBoundary(session.events[nodes[i]])) {
              userSeq = nodes[i]
              break
            }
          }
        }
        // 孤儿回复(目标在 surface 上、前置无 user 输入):任何 span 来源都无 prompt 可重发
        if (idx !== -1 && userSeq === -1) {
          throw editorError('no-prompt', 'No user message precedes this reply; cannot regenerate.')
        }
        const span = args?.span ?? (userSeq !== -1 ? roundSpanFrom(session, userSeq) : null)
        if (!span) throwSpanMiss(session, seq, args, messageId)
        // 文件 span 存在但没锁定同轮 user(probe 未带回 prompt,且 span 起点在内存里
        // 读不到/非轮边界)→ 保守 no-prompt:不重发错文本(M-1)。
        if (userSeq === -1) {
          throw editorError('no-prompt', 'No user message precedes this reply; cannot regenerate.')
        }
        // M-1:重发文本来源——文件侧 prompt(promptSeq 已锁定该轮 user,内存有洞也可靠)
        // 优先;否则内存 events[userSeq] 单点读取(userSeq 已限定为该轮 user 位置,
        // 不做任何扫描)。
        const fileText = args?.regeneratePrompt?.seq === userSeq && typeof args.regeneratePrompt.text === 'string'
          ? args.regeneratePrompt.text
          : null
        const text = fileText ?? extractUserText(session.events[userSeq]?.data?.content)
        if (!text.trim()) {
          throw editorError('no-text', 'The original message carries no text to regenerate from.')
        }
        if (!agent || typeof agent.followup !== 'function') {
          throw editorError('agent-unavailable', 'No live agent for this session; cannot re-send.')
        }
        // 2026-09-01 修复:regenerate 也用「轮内遮蔽」——只遮蔽目标 user 的回复轮,
        // 不遮蔽到尾部(否则 regenerate 早期回复遮蔽 surface 尾部全部,触发守卫误拦)。
        const markerEvent = await writeMarker(session, span, 'regenerate', userSeq, text)
        await flushSafely(session)
        const message = resendMessage(text.trim(), 'resend')
        agent.followup(message)
        return {
          op: 'regenerate',
          messageId,
          seq,
          resendMessageId: message.id,
          shadowed: span.shadowedSeqs.length,
          markerT1Broken: markerEvent?.data?.editor?.markerT1Broken === true,
        }
      })
    
      return {
        recall: (args) => recall(args),
        editAndResend: (args) => editAndResend(args),
        regenerate: (args) => regenerate(args),
      }
    }
    /**
     * dsh-retrace — lib/adapter/dsh-writer.js
     *
     * DSH 平台的「遮蔽写入器」（ReplaceWriter 的 DSH 实现）——把业务意图
     * 「遮蔽这些消息」翻译成 DSH 事件形状。
     *
     * 抽象设计（工程-生产级运行时/编辑撤销分支跳过-消息列表投影抽象-设计-20260902.md）：
     * 编辑/撤销/分支/跳过 = 通用消息列表投影操作，业务层只表达「遮蔽 roundRange」。
     * **DSH 翻译成本全部隔离在本文件**：
     * - 官方 token-meter 要求 assistant/message 必须有打开的 step（T1）→
     *   marker 必须落在合法 turn/step 位置（三情形）：
     *   ① 有打开的 step（回合中）→ 携带该 step 的 turn/step；
     *   ② 无打开 step 但有打开着的 turn（回合内 step 间隙，5e551001 现场）
     *      → 该 turn 号 + 新 step 号（文件全量 max + 1，绕开窗口化内存）；
     *   ③ 无打开 turn（真轮次间）→ 完整 turn 信封 + 推进 agent-loop lastTurn
     *      （防重发/下一条消息复用同一 turn 号 = duplicate start）；
     * - 客户端渲染层（复盘 2026-09-02）：任何 step/marker 不得写 turn:null
     *   （D8 白屏死循环）、同 turn 内 step 不得复用（step key 冲突白屏）——
     *   T3/T4 检测规则见 dsh-log-contract。
     *
     * host-core 零 import（动态插件 realm 可运行），本文件被 index.js 引用，
     * 依赖方向 adapter → host-core（安全）；host-core 通过 hooks.writeMarker
     * 注入本 writer，不反向 import。
     */
    // issue-229 第 3 项(契约运行时化):跨层边界校验——业务层传入的 span 与写出的
    // marker 都必须在边界处形状合规(违规 → 指名道姓的 contract-violation,而不是
    // 写出"表面成功、重放时对不上"的 marker)。
    // 零 import 链（host-core 零 import）：本文件可被 generate-dynamic.mjs inline 进
    // dynamic-host（动态插件 realm 不能 import）。文件全量的 step 号（readMaxStep）
    // 由装配者注入；本文件自带内存 maxStepInTurn 兜底。
    
    /**
     * 创建 DSH 遮蔽写入器。
     * @param {object} deps
     * @param {object} deps.agents      — agent 注册表（agents.get，情形③计数器推进）。
     * @param {Function} [deps.validateMarker] — 写前校验钩子（prewrite-guard）。
     * @param {(line: string) => void} [deps.log]
     */
    function createDshMarkerWriter({ agents, validateMarker, readMaxStep, log = () => {} } = {}) {
      return {
        /**
         * 写入一个「遮蔽 marker」：业务意图（遮蔽 span）翻译成 DSH 事件形状。
         * @param {object} session - DSH Session 实例。
         * @param {{start:number, end:number, shadowedSeqs:number[]}} span - 遮蔽范围（业务层算好）。
         * @param {{op:string, targetSeq:number, originalText:string}} meta - 业务元数据。
         * @returns {Promise<object>} markerEvent（调用方读取 seq/editor 等）。
         */
        async writeMarker(session, span, meta) {
          // 契约边界(issue-229 第 3 项):业务层 → 适配器。span 不合规(空/倒置/非连续段)
          // 在这里立刻报错,不进三情形翻译——否则会写出 surfaceOp 与 sourceEventSeqs
          // 不一致的 marker(会话面上的遮蔽范围与日志记录分叉,历史上正是这类不一致
          // 导致加载失败/编辑死锁)。
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
          const marker = {
            id: editorId(op),
            role: 'assistant',
            content: [],
            source: { kind: 'model', provider: model.provider, model: model.model },
          }
          // ── 三情形 turn/step 赋值（DSH 翻译核心，见文件头注释）──
          const openStep = findOpenStep(session)
          const openTurn = openStep === null ? findOpenTurn(session) : null
          let markerTurn
          let markerStep
          let wrappedBefore = [] // marker 前的包裹事件（turn/start、step/start）
          let wrappedAfter = [] // marker 后的包裹事件（step/end、turn/end）
          if (openStep) {
            markerTurn = openStep.turn
            markerStep = openStep.step
          } else if (openTurn) {
            markerTurn = openTurn.turn
            // 情形② step 号 = **max(内存, 文件) + 1**（独立审查 2026-09-02 处置）：
            // - 内存 maxStepInTurn 覆盖本进程刚写的 marker（文件 flush 滞后时文件
            //   读不到——同一打开 turn 内连续两次情形② 若只信文件会取到同一 step
            //   → step key 冲突白屏）；
            // - 文件全量 readMaxStep 覆盖窗口外既有 step（host 窗口化内存不可信，
            //   算小会与窗口外冲突，复盘 2026-09-02 §五）；
            // 两者取大 = 双向覆盖。readMaxStep 由装配者注入（index.js 从文件全量算），
            // 动态路径（dynamic-host inline）未注入时仅内存覆盖（窗口外风险已文档化）。
            let maxStep = maxStepInTurn(session, openTurn.turn)
            if (typeof readMaxStep === 'function') {
              const fromFile = await readMaxStep(session.id, openTurn.turn)
              if (typeof fromFile === 'number' && Number.isSafeInteger(fromFile) && fromFile > maxStep) maxStep = fromFile
            }
            markerStep = maxStep + 1
            wrappedBefore = [{ type: 'step/start', data: { turn: markerTurn, step: markerStep } }]
            wrappedAfter = [{ type: 'step/end', data: { turn: markerTurn, step: markerStep } }]
          } else {
            markerTurn = nextTurnOf(session)
            markerStep = 1
            wrappedBefore = [
              { type: 'turn/start', data: { turn: markerTurn } },
              { type: 'step/start', data: { turn: markerTurn, step: 1 } },
            ]
            wrappedAfter = [
              { type: 'step/end', data: { turn: markerTurn, step: 1 } },
              // 官方契约（逐字镜像 dsh-agent-loop/lib/index.js:620）：turn/end 必须带
              // reason.kind（completed|max-tokens|blocked|aborted|error|interrupted）——
              // 缺失 = malformed → 官方 validation 拒绝 → 会话加载失败（5e551005 事故，
              // 维护线 tools/validate.mjs 固化）。我们的信封 turn 立即完整关闭 →
              // kind: 'completed'（与 agent-loop 正常完成一致）。
              { type: 'turn/end', data: { turn: markerTurn, reason: { kind: 'completed' } } },
            ]
          }
          const data = {
            turn: markerTurn,
            step: markerStep,
            message: marker,
            editor: {
              targetSeq,
              text: typeof meta?.originalText === 'string' ? meta.originalText.slice(0, 2000) : '',
            },
          }
          const surfaceOp = { op: 'replace', start: span.start, end: span.end }
          const sourceEventSeqs = Array.isArray(span.shadowedSeqs) ? span.shadowedSeqs.slice() : []
          // 2026-09-01：把遮蔽 seq 冗余进 data.shadowedSeqs——部分客户端事件管道会剥离
          // event 顶层 sourceEventSeqs（0.4.12 实测：撤回/编辑后消息不隐藏 = client 拿不到
          // shadowedSeqs）。data 里的字段随事件体持久化，client 读 data 更稳（fallback 顶层）。
          data.shadowedSeqs = sourceEventSeqs
          // 包裹事件**先于校验构建**（校验与落盘共用同一组事件），校验钩子拿到完整序列
          // （wrappedBefore + envelope + wrappedAfter）做 T1 自检——消除"自检只见裸信封 →
          // 恒报 markerT1Broken"的误报（0.4.12-0.4.16 每次轮次间编辑刷 31 行日志的根因）。
          if (typeof validateMarker === 'function') {
            const result = await validateMarker(
              session,
              { type: 'assistant/message', data, surfaceOp, sourceEventSeqs },
              { wrappedBefore, wrappedAfter },
            )
            if (result && result.t1Ok === false) {
              // 理论上三情形信封后 T1 恒通过；残留 fallback 标注（防御）。
              data.editor.markerT1Broken = true
            }
          }
          for (const w of wrappedBefore) session.append(w.type, w.data)
          const markerEvent = session.append('assistant/message', data, { surfaceOp, sourceEventSeqs })
          // 契约边界:适配器 → 业务层(出口自检)。marker 形状与业务层下游假设
          // (seq/editor/surfaceOp↔sourceEventSeqs)不一致时立刻暴露,不留给读侧。
          assertMarkerShape(markerEvent, 'dshAdapter.writeMarker.marker')
          for (const w of wrappedAfter) session.append(w.type, w.data)
          // 情形③：我们消费了 nextTurn（信封里的 turn/start），把 agent-loop 的 lastTurn
          // 推进到该 turn——重发/下一条消息才落到 nextTurn+1，不会复用（防 duplicate start）。
          if (wrappedBefore.length >= 2) {
            const agent = agents?.get?.(session.id)
            advanceLoopTurn(agent, markerTurn, log)
          }
          return markerEvent
        },
      }
    }
    
    /**
     * 找当前打开的 step（最近一次未闭合的 step/start 的 turn/step）。
     * 扫描 session.events：step/start 开、step/end 关；末尾仍开即返回。
     * 无打开 step 返回 null（轮次间编辑）。
     */
    function findOpenStep(session) {
      const events = Array.isArray(session?.events) ? session.events : []
      let open = null
      for (const event of events) {
        if (event?.type === 'step/start') {
          open = { turn: event.data?.turn, step: event.data?.step }
        } else if (event?.type === 'step/end') {
          open = null
        }
      }
      return open
    }
    
    /**
     * 找当前打开着的 turn（最近一次 turn/start 无配对 turn/end）。
     * 扫描 session.events：turn/start 开、turn/end 关；末尾仍开即返回。
     * 无打开 turn 返回 null（真轮次间，情形③）。
     */
    function findOpenTurn(session) {
      const events = Array.isArray(session?.events) ? session.events : []
      let open = null
      for (const event of events) {
        if (event?.type === 'turn/start') {
          open = { turn: event.data?.turn }
        } else if (event?.type === 'turn/end') {
          open = null
        }
      }
      return open
    }
    
    /** 某 turn 内已出现的最大 step 号（无 step 返回 0）。内存扫描（窗口化不可信时用文件版）。 */
    function maxStepInTurn(session, turn) {
      const events = Array.isArray(session?.events) ? session.events : []
      let max = 0
      for (const event of events) {
        if (event?.data?.turn !== turn) continue
        const step = event?.data?.step
        if (typeof step === 'number' && Number.isSafeInteger(step) && step > max) max = step
      }
      return max
    }
    
    /**
     * 下一个 turn 号：scan 最大 turn（turn/start、step/start、assistant/message、user/message
     * 的 data.turn 中取最大）+1。无任何 turn 时从 1 起。
     */
    function nextTurnOf(session) {
      const events = Array.isArray(session?.events) ? session.events : []
      let max = 0
      for (const event of events) {
        const t = event?.data?.turn
        if (typeof t === 'number' && Number.isSafeInteger(t) && t > max) max = t
      }
      return max + 1
    }
    
    /**
     * 推进 agent-loop 的 turn 计数器（情形③专用）。
     * 仅在 loop 处于 idle 且 lastTurn+1 === consumedTurn 时推进——守卫防误伤
     * （loop 已推进/文件被外部改号时跳过；信封的 turn/start 已让文件 max turn 前移，
     * 跨重启自愈，这里只补同一 loop 实例的内存计数器）。
     */
    function advanceLoopTurn(agent, consumedTurn, log = () => {}) {
      if (!agent || typeof agent !== 'object') return
      const phase = agent.phase
      if (!phase || phase.kind !== 'idle') {
        log(`retrace: advanceLoopTurn skipped — agent not idle (${phase?.kind ?? 'no-phase'})`)
        return
      }
      if (!Number.isSafeInteger(phase.lastTurn) || phase.lastTurn + 1 !== consumedTurn) {
        log(`retrace: advanceLoopTurn skipped — lastTurn ${phase?.lastTurn} +1 !== consumed ${consumedTurn}`)
        return
      }
      phase.lastTurn = consumedTurn
    }
    // 遮蔽写入器（DSH 三情形翻译）。动态路径无 prewrite guard 与文件全量
    // readMaxStep——step 分配仅内存覆盖（maxStepInTurn），窗口外既有 step 无法
    // 感知（5e551001 同类风险，独立审查 2026-09-02 记录）；正式装配在
    // lib/index.js 注入 readMaxStep（文件全量）与 validateMarker。
    const markerWriter = createDshMarkerWriter({ agents, log })
    const api = createEditorApi(ctx, sessions, agents, log, { writeMarker: markerWriter.writeMarker })
    const disposers = [
      harness.handle('retrace.recall', (args) => api.recall(args)),
      harness.handle('retrace.editAndResend', (args) => api.editAndResend(args)),
      harness.handle('retrace.regenerate', (args) => api.regenerate(args)),
    ]
    ctx.effect(() => () => {
      for (const dispose of disposers) dispose()
    }, 'retrace: handlers')
  },
}
