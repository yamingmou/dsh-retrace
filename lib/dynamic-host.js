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
     * dsh-retrace — lib/host-compat.js
     *
     * Host event-view compatibility accessors (single source of truth).
     *
     * DSH Desktop 2.0.9 (@deepseek-ai/dsh-session 0.1.5-rc.1) removed the public
     * event array from Session: the append-only log is reachable only through
     * `snapshotEvents()` (cached immutable full snapshot, indexed by seq) and
     * `eventAt(seq)` (one event at one exact seq). Older hosts expose a plain
     * `events` array with the same indexing (`events[i].seq === i`).
     *
     * Every host-event read in this plugin MUST go through these two accessors.
     * Reading the old member directly throws
     *   TypeError: Cannot read properties of undefined (reading 'length')
     * on the new host — that is exactly the "cannot recall / cannot edit"
     * incident (lib/host-core.js lastModelSource / findMessageSeq read the log
     * before any write, so both ops died before touching the session).
     *
     * Rules:
     *  - New API first (`snapshotEvents` / `eventAt`), legacy array second.
     *    The legacy path stays: both host generations stay supported.
     *  - A throwing or unrecognized view degrades to [] WITHOUT crashing, but it
     *    always leaves a one-shot diagnostic carrying a shape fingerprint — a
     *    silent empty log is how the incident stayed hidden. "Return [] and say
     *    nothing" is a bug, not resilience.
     *  - Import-free by design: the dynamic-plugin generator inlines this module
     *    into lib/dynamic-host.js, where module resolution is unavailable.
     */
    
    /** Diagnostic line for a degraded or fallback read (never throws). */
    function diagnose(line) {
      try {
        if (typeof console !== 'undefined' && typeof console.error === 'function') console.error(line)
      } catch { /* diagnostics must never break a read */ }
    }
    
    /** One-shot memory: a shape can only drift once per process; do not spam. */
    const diagnosed = new Set()
    
    /**
     * Emit `line` once per `key`. The key carries the shape fingerprint, so two
     * different broken shapes still produce two different, distinguishable lines.
     */
    function diagnoseOnce(key, line) {
      if (diagnosed.has(key)) return
      diagnosed.add(key)
      diagnose(line)
    }
    
    /** Test-only: clear the one-shot diagnostic memory. */
    function resetHostCompatDiagnostics() {
      diagnosed.clear()
    }
    
    /** Bounded shape fingerprint for diagnostics (never throws). */
    function shapeOf(value) {
      try {
        if (value === null) return 'null'
        if (value === undefined) return 'undefined'
        const type = typeof value
        if (type !== 'object' && type !== 'function') return type
        const keys = Object.keys(value)
        const head = keys.slice(0, 6).join(',')
        return `{${head}${keys.length > 6 ? ',…' : ''}}`
      } catch {
        return '<unreadable>'
      }
    }
    
    /**
     * The session's event log as an array indexed by seq.
     * @param {object} [session]
     * @returns {Array<object>} snapshot on new hosts, legacy array on old hosts, [] when neither exists
     */
    function sessionEvents(session) {
      if (!session) return []
      let legacy
      try {
        legacy = session.events
      } catch (error) {
        diagnoseOnce(
          `session-events:legacy-threw:${shapeOf(session)}`,
          `retrace: reading the legacy event view threw (${String(error)}); returning an empty log`,
        )
        return []
      }
      const hasLegacy = Array.isArray(legacy)
      const hasNewApi = typeof session.snapshotEvents === 'function'
      if (hasNewApi) {
        try {
          const snapshot = session.snapshotEvents()
          if (Array.isArray(snapshot)) return snapshot
          diagnoseOnce(
            `session-events:snapshot-not-array:${shapeOf(snapshot)}`,
            `retrace: session.snapshotEvents() returned ${shapeOf(snapshot)}, not an array; falling back to the legacy event view`,
          )
        } catch (error) {
          diagnoseOnce(
            `session-events:snapshot-threw:${shapeOf(session)}`,
            `retrace: session.snapshotEvents() threw (${String(error)}); falling back to the legacy event view`,
          )
        }
      }
      if (hasLegacy) return legacy
      // Only the "no API at all" case gets the generic line: when snapshotEvents()
      // exists but misbehaved, its own shape diagnostic above is the specific one.
      if (!hasNewApi) {
        diagnoseOnce(
          `session-events:no-view:${shapeOf(session)}`,
          `retrace: session exposes neither snapshotEvents() nor an events array (shape ${shapeOf(session)}) — the host API may have drifted; returning an empty log`,
        )
      }
      return []
    }
    
    /**
     * The next append position of the session log.
     *
     * Same formula as `dsh-log-contract`'s `createPreWriter` nextSeq:
     * `baseSeq = 0` then `max(seq) + 1`, with `seq`-less events counted
     * positionally. Producers need this to validate a **planned** two-segment
     * write (audit + carrier) *before* appending either segment — see
     * lib/adapter/dsh-writer.js (a post-append rejection left an
     * orphan `compaction/prune`).
     *
     * @param {object} [session]
     * @returns {number} non-negative next append seq
     */
    function nextAppendSeq(session) {
      const events = sessionEvents(session)
      let expected = 0
      for (const event of events) {
        const seq = Number.isSafeInteger(event?.seq) ? event.seq : expected
        if (seq + 1 > expected) expected = seq + 1
      }
      return expected
    }
    
    /**
     * One event at one exact sequence number.
     * @param {object} [session]
     * @param {number} seq - non-negative sequence number
     * @returns {object|undefined}
     */
    function eventAt(session, seq) {
      if (!session) return undefined
      if (typeof session.eventAt === 'function') {
        try {
          const event = session.eventAt(seq)
          if (event !== undefined) return event
        } catch (error) {
          diagnoseOnce(
            `session-event-at:threw:${shapeOf(session)}`,
            `retrace: session.eventAt(${String(seq)}) threw (${String(error)}); falling back to snapshot indexing`,
          )
        }
      }
      return sessionEvents(session)[seq]
    }
    
    /**
     * Enumerate the ids of all live sessions from a sessions service.
     *
     * Measured hosts (`@deepseek-ai/dsh-session` 0.1.0-rc.7 and 0.1.5-rc.1) both
     * expose `list()` returning `Session[]` (each with an `id` getter) and
     * neither exposes `keys()`. The `keys()` branch is kept only as a defensive
     * shape for still-earlier Map-style registries; it is NOT attested by any
     * measured host, so do not treat it as the "old host" contract.
     *
     * Deliberately NO `Object.keys(service)` fallback: on a host service instance
     * that yields the service's own implementation fields (e.g. `list`/`get`), not
     * session ids — the scan then silently sees zero sessions while looking
     * healthy. An unrecognized enumerator is reported as [] PLUS a one-shot
     * diagnostic with a shape fingerprint, so "no sessions" and "unknown shape"
     * are distinguishable.
     *
     * @param {object} [sessions] - the `sessions` service (`ctx.sessions`)
     * @returns {string[]} live session ids
     */
    function sessionIds(sessions) {
      if (!sessions || typeof sessions !== 'object') return []
      const shape = shapeOf(sessions)
      const hasList = typeof sessions.list === 'function'
      if (hasList) {
        let list
        let listError = null
        try {
          list = sessions.list()
        } catch (error) {
          listError = error
        }
        if (listError !== null) {
          diagnoseOnce(
            `session-ids:list-threw:${shape}`,
            `retrace: sessions.list() threw (${String(listError)}); falling back to sessions.keys()`,
          )
        } else if (Array.isArray(list)) {
          const ids = list.map((session) => session?.id).filter((id) => typeof id === 'string' && id.length > 0)
          if (ids.length > 0) return ids
          if (list.length === 0) return [] // authoritative: there really are no live sessions
          diagnoseOnce(
            `session-ids:list-no-id:${shape}`,
            `retrace: sessions.list() returned ${list.length} entries but none exposes a string id (first entry shape ${shapeOf(list[0])}) — the host API may have drifted`,
          )
          return []
        } else {
          diagnoseOnce(
            `session-ids:list-not-array:${shape}`,
            `retrace: sessions.list() returned ${shapeOf(list)}, not an array; falling back to sessions.keys()`,
          )
        }
      }
      const hasKeys = typeof sessions.keys === 'function'
      if (hasKeys) {
        try {
          return [...sessions.keys()]
        } catch (error) {
          diagnoseOnce(`session-ids:keys-threw:${shape}`, `retrace: sessions.keys() threw (${String(error)})`)
          return []
        }
      }
      // Only "neither enumerator exists" gets the generic line; a present-but-broken
      // list() already produced its own specific shape diagnostic above.
      if (!hasList) {
        diagnoseOnce(
          `session-ids:no-api:${shape}`,
          `retrace: sessions service exposes neither list() nor keys() (shape ${shape}) — cannot enumerate live sessions`,
        )
      }
      return []
    }
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
     * @returns {{start:number,end:number,shadowedSeqs:number[]}|null}
     */
    function spanAt(nodes, index, options = {}) {
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
     * dsh-retrace — lib/marker-carrier.js
     *
     * 「遮蔽载体」= 两段结构 —— **读端与写端共用的唯一形状真相**(零 import,纯函数)。
     *
     * 为什么载体改成两段(依据两段载体设计阶段 1.1,官方源码到行):
     * - `assistant/message` 作载体结构性出局:官方 v3 树不接受它带 provenance
     *   (`dsh-session/lib/index.js` —— assistant/message embeds its source stream),
     *   v1→v2 迁移边又无条件剥掉它的 `sourceEventSeqs` ⇒ 今天的遮蔽能力是 v0 独有;
     * - `user/message` 是四种 surface-eligible 类型里唯一能做「任意多节点区间替换」的
     *   (`tool/result` 限单节点,`system/message` v0 无此类型/须匹配打开中 step);
     * - 官方自己就是两段:`dsh-compaction-basic` 写 `compaction/summary`(log-only 审计)
     *   + `user/message`(真正替换);`dsh-compaction-tool-result-pruner` 同理。
     *
     * 形状(第 1 段先写,第 2 段后写——两者都引用更早 seq):
     *   第 1 段 `compaction/prune`(log-only,不投影):
     *     data = { shadowedRange:{start,end}, shadowedSeqs:[…], shadowedTokenCount:n }
     *     —— 官方词表把 data 定为**精确三成员**(无 optional/opaque)⇒ 多一个成员即被拒;
     *        且该类型非 surface-eligible ⇒ 带 surfaceOp/sourceEventSeqs 会在运行时抛错。
     *   第 2 段 `user/message`(真正遮蔽):
     *     data = { role, id, content, source }(官方词表同样精确四成员)
     *     surfaceOp = {op:'replace',start,end}(v0)/ {op:'replace',startSeq,endSeq}(v3)
     *     sourceEventSeqs = [<第 1 段 seq>, …全部被遮蔽节点]
     *     source.kind = 'model'(≠'user':见下)
     *
     * ⭐ 轮边界:轮边界谓词(`isRoundBoundaryEvent`)只认 `data.source.kind === 'user'`。
     * 载体若写 `kind:'user'` 就会被当成「真实用户输入」→ 切分交换轮 → round/tail 遮蔽
     * 段整体偏移(实测官方**不拦**,照样 load 且能力看着正常)。故载体一律 `kind:'model'`
     * (官方 `messageSourceValue` 对 `kind:'model'` 只要求 provider/model 非空串,与
     * message 角色无关 ⇒ 合法;v2→v3 的 SOURCE_KINDS 同样含 'model')。
     *
     * 关联读法(本文件即判据) —— **写侧 / 读侧分别如实**:
     *   写侧:`sourceEventSeqs = [<第 1 段 seq>, …全部被遮蔽节点]`(审计 seq 置首,权威);
     *   读侧:兼容**不含审计 seq 的历史形态** —— 该形态靠「审计段与载体段**紧邻**
     *         (审计.seq = 载体.seq − 1)且 `审计.shadowedRange === 载体的 surfaceOp 区间`」
     *         判定,**不可仅凭区间一致**:否则"审计段在、载体段在很远处或根本不存在"的
     *         真孤儿会被误判成成对 —— 容错反而掩盖要检出的缺陷(裁定 2026-09-14)。
     *         三选一判成对 = `isAuditPairedWithCarrier`(纯谓词)/ `pairedAuditOf`(带读取器)。
     * 被遮蔽节点 = 该数组里**从区间起点起**的连续段(有审计引导项时审计 seq 在区间之外,
     * 先于写入、数值上也更大)。旧形态(assistant/message + data.editor)的
     * `sourceEventSeqs` 本就以 `surfaceOp.start` 开头 ⇒ 切片结果 = 原数组。
     *
     * 纯模块:零 import、零平台依赖(动态插件 realm 可 inline,浏览器/Node 同构)。
     */
    
    /**
     * 本插件 marker id 前缀清单(NEW markers 用第一个;其余是历史插件名,改名后仍须能识别)。
     *
     * ⚠️ 这里只导出**清单**、不导出单数常量:本模块与 host-core 会被 inline 进同一个
     * 动态插件作用域(generate-dynamic 逐个 strip import/export),而 host-core 已导出
     * `MARKER_ID_PREFIX`(公开面 ./host-core 的一部分)⇒ 同名再声明即 `Identifier …
     * has already been declared`。两份取值由单测钉住相等(test/marker-carrier.test.js)。
     */
    const MARKER_ID_PREFIXES = ['retrace', 'message-editor']
    
    /** 第 1 段(审计载体,log-only)。 */
    const AUDIT_EVENT_TYPE = 'compaction/prune'
    /** 第 1 段 data 的精确成员(官方词表,一个都不能多)。 */
    const AUDIT_DATA_KEYS = ['shadowedRange', 'shadowedSeqs', 'shadowedTokenCount']
    
    /** 第 2 段(遮蔽载体,surface)。 */
    const CARRIER_EVENT_TYPE = 'user/message'
    /** 第 2 段 data 的精确成员(官方词表,一个都不能多)。 */
    const CARRIER_DATA_KEYS = ['role', 'id', 'content', 'source']
    /** 第 2 段的 source.kind(见文件头「轮边界」)。 */
    const CARRIER_SOURCE_KIND = 'model'
    
    /**
     * 留痕文案(定稿形态,不带品牌前缀)——遮蔽在模型上下文里留一句人读说明:
     * 读者应理解为「撤回痕迹」,而非「用户发了空消息」。
     * 依据:实测 `content: []` 会投影成一条 `role:'user', len:0` 的空消息(误读为
     * 用户发了空消息);带说明文本则读者读到撤回痕迹。
     */
    const TRACE_TEXT = '（此处内容已被撤回：原消息已归档，可在恢复视图中查看）'
    
    /** 该 id 是否为本插件 marker id(当前或历史前缀)。 */
    function isMarkerId(id, prefixes = MARKER_ID_PREFIXES) {
      return typeof id === 'string' && prefixes.some((p) => id.startsWith(`${p}-`))
    }
    
    // ─────────────────────────────────────────────────────────────────────────────
    // 迁移痕迹(TRACE)—— 历史**非法事件类型**的合法承载
    //
    // 问题:早期版本写过两种**不在官方 v0 冻结清单(51 条)**里的自造类型:
    //   `retrace/goal-marker`(语义 =「目标曾被清空」的痕迹,data 只有 originalOperation)
    //   `retrace/marker`(dsh-log-contract `--neutralize` 的产物:turn-null marker 被
    //     原地中和成 `retrace/marker + ignorable`,残留 editor{targetSeq,text})
    // 官方 v0→v1 边**拒绝一切未知历史类型**(`dsh-session-format-v0-to-v1/lib/index.js`
    // 的 `assertReleasedArtifactCoordinates`:`unknown historical event type … migration
    // refuses unknown historical events even when ignorable`)⇒ 含这些类型的会话**永久
    // 不可迁移**。裁定:**不删除**(保功能痕迹)⇒ 迁移前置步骤把它们**翻译**
    // 成官方合法、且我们读端认得的形态。
    //
    // 选定承载 = `feedback/record`,理由(逐条对官方词表,行号见下):
    //  ① 在冻结清单里 ⇒ 迁移接受(`RELEASED_V0_EVENT_DISPOSITIONS["feedback/record"]
    //     = disposition(["text"])`,即 data **恰一个** `text` 成员,无 optional/opaque);
    //  ② **非** surface-eligible(`SURFACE_EVENT_TYPES` 只含 user/message、
    //     assistant/message、tool/result)⇒ 信封不许 surfaceOp/sourceEventSeqs,
    //     也不进 `deriveEventMessage` 的投影 ⇒ **不投影进模型上下文**、不需要伪造 turn/step;
    //  ③ 官方 token-meter 只消费 assistant/message · assistant/attempt ·
    //     compaction/summary · compaction/prune(`dsh-token-meter/lib/index.js:305,392,428`)
    //     ⇒ **不被 token-meter 当 shadow-price claim 消费**;
    //  ④ 它是官方词表里**唯一**「自由文本 + 零坐标 + 零状态机」的注解槽:不要求
    //     turn/step/callId/goalId,不参与 goal/schedule/team/workflow 任何 fold ⇒ 承载痕迹
    //     时**不伪造任何 id**、不改变任何官方状态。
    // ⚠️ 已知代价(如实登记,不掩盖):`feedback/record` 在官方侧被 OTel 遥测当作「反馈」
    //   信号(`dsh-session-telemetry-otel/lib/index.js:37-45` 的 `isFeedback`,只判 type
    //   不看 payload)。但那条监听挂在 `session/event`(**运行期 append**)上,且带
    //   `session.eventAt(seq) === event` 前置(同文件 `:165-171`)—— 离线翻译写进日志的
    //   事件走**加载**路径,不经该监听;只有"运行期再追加一条痕迹"才会命中。故痕迹文案里
    //   显式写明 `retrace-trace`,读端与人都不把它当真实用户反馈(判据见
    //   `test/migration-traces.test.js` 的读端判定用例)。
    //
    // 形状(在线改写:seq/time/行数**一律不动**,只改 type 与 data):
    //   { type:'feedback/record', seq, time, data:{ text: 'retrace-trace/v1 {…}' } }
    // 文案前缀是**唯一识别判据**(前缀 + v1 + JSON);非本插件前缀的真实 feedback 一律不认。
    // ─────────────────────────────────────────────────────────────────────────────
    
    /** 痕迹事件的官方承载类型(见上:官方词表 data 恰一个自由文本成员)。 */
    const TRACE_EVENT_TYPE = 'feedback/record'
    /** 痕迹文案前缀(唯一识别判据;无它即非本插件痕迹)。 */
    const TRACE_TEXT_PREFIX = 'retrace-trace/v1 '
    /** 痕迹格式版本(前缀里已带 v1;这里是 JSON 内的同源字段,双写互证)。 */
    const TRACE_VERSION = 1
    /** 已知痕迹种类:goal-marker(A 类)/ marker(B 类,中和产物)。 */
    const TRACE_KINDS = Object.freeze(['goal-marker', 'marker'])
    /** A 类原类型 / B 类原类型(迁移翻译的输入,也是痕迹里的溯源字段)。 */
    const LEGACY_TRACE_TYPES = Object.freeze(['retrace/goal-marker', 'retrace/marker'])
    
    /** 痕迹 JSON 的**固定成员顺序**(字节稳定:同一输入 → 同一输出,便于幂等比对)。 */
    const TRACE_KEY_ORDER = Object.freeze(['v', 'kind', 'originalType', 'originalSeq', 'originalTime'])
    /** 各类别的**类别专属成员**(顺序固定;全部为可丢失判定的纯数据)。 */
    const TRACE_KIND_KEYS = Object.freeze({
      'goal-marker': Object.freeze(['originalOperation']),
      marker: Object.freeze(['targetSeq', 'messageId', 'text']),
    })
    
    /**
     * 痕迹 → 官方文本成员。成员顺序固定(字节稳定),`v` 与 kind 必须有值。
     * @param {{kind:string, originalType:string, originalSeq:number, originalTime:number}} trace
     * @returns {string}
     */
    function encodeTraceText(trace) {
      const out = { v: TRACE_VERSION }
      const written = new Set(['v'])
      const put = (key) => {
        if (written.has(key) || trace?.[key] === undefined) return
        out[key] = trace[key]
        written.add(key)
      }
      for (const key of TRACE_KEY_ORDER) put(key)
      for (const key of TRACE_KIND_KEYS[trace?.kind] ?? []) put(key)
      // 其余自有成员**原样带上**(未知/未来的痕迹字段不得静默丢弃;调用方按固定顺序
      // 构造入参 ⇒ 输出字节稳定,幂等比对可用)。
      for (const key of Object.keys(trace ?? {})) put(key)
      return TRACE_TEXT_PREFIX + JSON.stringify(out)
    }
    
    /**
     * 官方文本成员 → 痕迹载荷。**读端宽进**:前缀是唯一门(不认识的前缀 = 真实反馈),
     * 前缀之内只要 `v`/`kind` 成立就认(未知 kind 也认,免得未来的痕迹被误当真实反馈)。
     * @param {unknown} text - `data.text`
     * @returns {object|null} 解析失败时 null
     */
    function decodeTraceText(text) {
      if (typeof text !== 'string' || !text.startsWith(TRACE_TEXT_PREFIX)) return null
      let parsed
      try { parsed = JSON.parse(text.slice(TRACE_TEXT_PREFIX.length)) } catch { return null }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
      if (parsed.v !== TRACE_VERSION) return null
      if (typeof parsed.kind !== 'string' || parsed.kind.length === 0) return null
      return parsed
    }
    
    /** 痕迹事件判定(承载类型 + 文案前缀可解析;两者缺一不认)。 */
    function isTraceEvent(event) {
      return event?.type === TRACE_EVENT_TYPE && decodeTraceText(event?.data?.text) !== null
    }
    
    /** 痕迹事件的载荷(非痕迹 → null)。 */
    function tracePayloadOf(event) {
      return isTraceEvent(event) ? decodeTraceText(event.data.text) : null
    }
    
    /**
     * 痕迹事件的**人读**一句话(读端展示/排障用;不参与任何能力判据)。
     * @param {object} payload - `tracePayloadOf` 的结果
     * @returns {string} 无法描述时 ''
     */
    function traceSummary(payload) {
      if (!payload || typeof payload !== 'object') return ''
      const at = Number.isSafeInteger(payload.originalTime) ? new Date(payload.originalTime).toISOString() : '(时间未知)'
      if (payload.kind === 'goal-marker') return `目标曾被清空（${payload.originalOperation ?? '未知操作'}）@ ${at}`
      if (payload.kind === 'marker') return `旧载体 marker 痕迹（targetSeq=${payload.targetSeq ?? '?'}）@ ${at}`
      return `${payload.kind} 痕迹 @ ${at}`
    }
    
    /**
     * surfaceOp 的区间端点(双形状探测,读端宽进)。
     * v0 运行时 = `{op,start,end}`;v3 运行时 = `{op,startSeq,endSeq}`。
     * 两棵树都要求键数**精确为 3** 且键名精确 ⇒ 混写(同时带 start 与 startSeq)
     * 在这里一并被拒(返回 null),交由调用方按下标/形状自行判定。
     * @returns {{start:number, end:number}|null}
     */
    function spanRangeOf(surfaceOp) {
      if (!surfaceOp || typeof surfaceOp !== 'object' || Array.isArray(surfaceOp)) return null
      if (surfaceOp.op !== 'replace') return null
      const keys = Object.keys(surfaceOp)
      if (keys.length !== 3) return null
      const sorted = [...keys].sort().join(',')
      const v0 = sorted === 'end,op,start'
      const v3 = sorted === 'endSeq,op,startSeq'
      if (!v0 && !v3) return null
      const start = v0 ? surfaceOp.start : surfaceOp.startSeq
      const end = v0 ? surfaceOp.end : surfaceOp.endSeq
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null
      return { start, end }
    }
    
    /**
     * 第 2 段(遮蔽载体)判定:user/message + replace + 本插件 marker id。
     * 旧形态(assistant/message + `data.editor`)由 `isLegacyMarkerEvent` 单独判定
     * ——读端两种形态并存(历史日志里旧 marker 仍在,识别不得因改造而失效)。
     */
    function isCarrierMarkerEvent(event) {
      if (event?.type !== CARRIER_EVENT_TYPE) return false
      if (!spanRangeOf(event.surfaceOp)) return false
      return isMarkerId(event.data?.id)
    }
    
    /** 旧形态判定(2026-09 改造前的 marker:assistant/message + data.editor)。 */
    function isLegacyMarkerEvent(event) {
      return event?.type === 'assistant/message' && Boolean(event?.data?.editor)
    }
    
    /** 任一形态的遮蔽载体(读端入口)。 */
    function isShadowCarrierEvent(event) {
      return isCarrierMarkerEvent(event) || isLegacyMarkerEvent(event)
    }
    
    /**
     * 载体的遮蔽目标 seq(业务溯源)——旧形态读 `data.editor.targetSeq`,新形态由
     * `surfaceOp` 区间起点**派生**。
     *
     * 依据(147/147 全量实测):`data.editor.targetSeq` 与 `surfaceOp.start` 逐例相等
     * ⇒ 新形态该字段随 `editor` 一并去掉,读端按此派生(写端另有写前断言钉住相等)。
     * **旧形态仍以 `editor.targetSeq` 为准**(它是当时写入的业务意图;两值在实测中相等,
     * 但派生值只是区间起点,不是当时的意图本身)。
     * @returns {number} -1 = 无法派生
     */
    function carrierTargetSeq(event) {
      const legacy = event?.data?.editor?.targetSeq
      if (Number.isSafeInteger(legacy)) return legacy
      const range = spanRangeOf(event?.surfaceOp)
      return range ? range.start : -1
    }
    
    /**
     * 第 1 段(审计事件)的 seq —— 第 2 段 `sourceEventSeqs` 的首元素(无则 null)。
     *
     * ⚠️ 该定位**依赖顶层数组**:顶层被事件管道整条剥掉时它必然返回 null(见
     * `carrierShadowedSeqs` 的兜底链——那里不靠本函数也能取到被遮蔽段)。
     */
    function carrierAuditSeq(event) {
      const range = spanRangeOf(event?.surfaceOp)
      const seqs = Array.isArray(event?.sourceEventSeqs) ? event.sourceEventSeqs : null
      if (!range || !seqs || seqs.length === 0) return null
      if (seqs[0] === range.start) return null // 旧形态/无审计引用:首元素即区间起点
      return Number.isSafeInteger(seqs[0]) ? seqs[0] : null
    }
    
    /**
     * 客户端「审计上下文」的 kind —— 第 1 段审计事件的读端上下文(见本文件末尾的
     * `auditContextDefinition`)。
     */
    const AUDIT_CONTEXT_KIND = 'retrace-audit'
    
    /** 第 1 段 data 的**识别**判据(只认形状,不抛;与 contract.js 的断言同词表)。 */
    function isAuditData(data) {
      if (!data || typeof data !== 'object' || Array.isArray(data)) return false
      const keys = Object.keys(data)
      if (keys.length !== AUDIT_DATA_KEYS.length) return false
      if (!AUDIT_DATA_KEYS.every((key) => Object.hasOwn(data, key))) return false
      const range = data.shadowedRange
      if (!range || typeof range !== 'object' || Array.isArray(range)) return false
      if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end)) return false
      const seqs = data.shadowedSeqs
      return Array.isArray(seqs) && seqs.length > 0 && seqs.every((seq) => Number.isSafeInteger(seq))
    }
    
    /** 第 1 段事件(或它的 data)是否带本插件可识别的审计形状。 */
    function isAuditEvent(eventOrData) {
      const data = eventOrData && typeof eventOrData === 'object' && 'data' in eventOrData ? eventOrData.data : eventOrData
      return isAuditData(data)
    }
    
    /**
     * 从第 1 段审计记录取「被遮蔽 seq」——**校验后才采用**。
     *
     * 判据(缺一不采用,返回 []):① 审计记录的 `shadowedRange` 与载体区间逐值相等
     * (官方 shadow-price 协议本身就是按区间配对 claim;区间不等 = 不是本载体的审计段
     * —— 官方 `compaction-tool-result-pruner` 也写 `compaction/prune`,两侧同词表,
     * 因此**区间相等是区分「谁写的」的唯一判据**);② `shadowedSeqs` 非空且首尾 === 区间
     * 端点(官方语义约束:列全被遮蔽节点)。
     * @param {object} audit - 第 1 段事件,或它的 data(客户端读者只拿得到 data)
     * @param {object} event - 第 2 段载体(提供区间)
     * @returns {number[]} 不采用时 []
     */
    function shadowedSeqsOfAudit(audit, event) {
      const range = spanRangeOf(event?.surfaceOp)
      if (!range) return []
      const data = audit && typeof audit === 'object' && 'data' in audit ? audit.data : audit
      if (!isAuditData(data)) return []
      if (data.shadowedRange.start !== range.start || data.shadowedRange.end !== range.end) return []
      const seqs = data.shadowedSeqs.slice()
      if (seqs[0] !== range.start || seqs[seqs.length - 1] !== range.end) return []
      return seqs
    }
    
    /**
     * 读侧「审计段 ↔ 载体段」配对判定(单一真相;裁定 2026-09-14 §一)。
     *
     * **写侧规范(权威)**:`sourceEventSeqs[0] = 审计段 seq`。读侧为兼容历史形态采用
     * 三选一 —— 但**容错不得丢掉紧邻性**:
     *   ① `sourceEventSeqs[0] === 审计段.seq`(现行写侧形态);
     *   ② 审计段.seq **出现在** `sourceEventSeqs` 中(非首位;未来若有人放后面);
     *   ③ 历史形态(顶层数组只含区间节点、不含审计 seq,甚至整条被管道剥掉)⇒
     *      **审计段与载体段紧邻**(`载体.seq === 审计.seq + 1`)**且**
     *      `审计.shadowedRange === 载体 surfaceOp 区间`。
     *
     * ⚠️ 第 ③ 条**同时**要求紧邻 + 区间一致:只认区间一致会把"审计段在、载体段在很远处
     * 或根本不存在"的真孤儿误判为成对 —— 容错把要检出的缺陷掩盖掉,是唯一不可接受的
     * 结果。写侧 `assertPairing` **保持严格**(我们自己永远写审计首位,不该容忍自己的偏差)。
     *
     * @param {object} audit - 候选审计事件(`compaction/prune`)
     * @param {object} carrier - 候选载体事件(`user/message` + replace + 本插件 marker id)
     * @returns {{paired: boolean, via: 'ref-first'|'ref-anywhere'|'adjacent-range'|null}}
     */
    function isAuditPairedWithCarrier(audit, carrier) {
      if (!isAuditEvent(audit) || !isCarrierMarkerEvent(carrier)) return { paired: false, via: null }
      const auditSeq = Number.isSafeInteger(audit.seq) ? audit.seq : null
      const seqs = Array.isArray(carrier.sourceEventSeqs)
        ? carrier.sourceEventSeqs.filter((seq) => Number.isSafeInteger(seq))
        : []
      if (auditSeq !== null && seqs.length > 0 && seqs[0] === auditSeq) return { paired: true, via: 'ref-first' }
      if (auditSeq !== null && seqs.includes(auditSeq)) return { paired: true, via: 'ref-anywhere' }
      // ③ 历史形态:紧邻 + 区间一致(**两条都要**)
      const range = spanRangeOf(carrier.surfaceOp)
      if (auditSeq === null || !range || !Number.isSafeInteger(carrier.seq)) return { paired: false, via: null }
      if (carrier.seq !== auditSeq + 1) return { paired: false, via: null }
      const data = audit.data
      if (!isAuditData(data)) return { paired: false, via: null }
      if (data.shadowedRange.start !== range.start || data.shadowedRange.end !== range.end) return { paired: false, via: null }
      return { paired: true, via: 'adjacent-range' }
    }
    
    /**
     * 载体的配对审计段(读侧入口;带按 seq 取事件的读取器)。
     *
     * 候选顺序:先按 `sourceEventSeqs`(① 首位 / ② 任意位),再按**紧邻**(③)。
     * 每个候选都用 `isAuditPairedWithCarrier` 判定 —— 判定逻辑只有一份。
     * @param {object} carrier
     * @param {(seq:number)=>object|undefined} eventAt
     * @returns {{seq:number, event:object, via:string}|null}
     */
    function pairedAuditOf(carrier, eventAt) {
      if (typeof eventAt !== 'function') return null
      const seqs = Array.isArray(carrier?.sourceEventSeqs)
        ? carrier.sourceEventSeqs.filter((seq) => Number.isSafeInteger(seq))
        : []
      const adjacent = Number.isSafeInteger(carrier?.seq) ? carrier.seq - 1 : null
      const candidates = [...new Set([...seqs, ...(adjacent === null ? [] : [adjacent])])]
      for (const seq of candidates) {
        const audit = eventAt(seq)
        const verdict = isAuditPairedWithCarrier(audit, carrier)
        if (verdict.paired) return { seq, event: audit, via: verdict.via }
      }
      return null
    }
    
    /**
     * 审计段是否**被某个载体配对**(孤儿判定的唯一判据;裁定 §二末)。
     * 孤儿 = `!isAuditPairedWithSomeCarrier(audit, log)`。
     * @param {object} audit
     * @param {object[]} carriers - 日志里全部载体候选
     * @returns {{paired: boolean, via: string|null, carrierSeq: number|null}}
     */
    function isAuditPairedWithSomeCarrier(audit, carriers) {
      for (const carrier of carriers) {
        const verdict = isAuditPairedWithCarrier(audit, carrier)
        if (verdict.paired) return { paired: true, via: verdict.via, carrierSeq: Number.isSafeInteger(carrier.seq) ? carrier.seq : null }
      }
      return { paired: false, via: null, carrierSeq: null }
    }
    
    /**
     * 客户端侧的审计上下文定义(Cordis Conversation Definition)——**只参与取值,不建视图**
     * (无 target/buildViewNode ⇒ 不产生任何对话行;定义注册与匹配由 `register` 服务按
     * kind 收敛,读端用 `reader.previous(AUDIT_CONTEXT_KIND)` 取本载体之前那一条审计上下文)。
     *
     * 为什么客户端需要它:客户端只能按 kind 取**相邻上下文**,没有「按 seq 取任意事件」的
     * 接口 ⇒ 顶层 `sourceEventSeqs` 一旦被事件管道剥掉,载体自身再也拼不出被遮蔽集合
     * (0.4.12 的 `data.shadowedSeqs` 冗余已随官方词表收紧而取消)。
     */
    function auditContextDefinition() {
      return {
        kind: AUDIT_CONTEXT_KIND,
        match: (event) => (event?.type === AUDIT_EVENT_TYPE && isAuditData(event.data)
          ? { id: `audit:${Number(event.seq)}`, role: 'start' }
          : null),
        start: (_context, match) => match.event.data,
        update: (context) => context.state,
      }
    }
    
    /**
     * 载体的**被遮蔽 seq 列表**(单一取值口径)。
     *
     * 读法:从 `sourceEventSeqs` 里**区间起点**那一项起截(审计 seq 在区间之外);
     * 找不到区间起点(无 surfaceOp / 旧数据缺失)时原样返回,保持 0.4.x 的口径。
     *
     * 兜底链(顶层 provenance 被事件管道剥掉/截断时;取自 `pairedAuditOf` 的配对审计,
     * 再经 `shadowedSeqsOfAudit` 要求区间**端点吻合**,与官方语义约束同判据):
     *   ① 引用:审计 seq 在 `sourceEventSeqs` 首位 / 任意位 → `eventAt` 取该段;
     *   ② 相邻:审计段与本载体**紧邻**写盘(官方 shadow-price 协议要求两者紧邻)且区间一致;
     *   ③ 旧字段:本事件 `data.shadowedSeqs`(0.4.12 形态的冗余)。
     * ⚠️ 客户端没有 `eventAt`(只能按 kind 取相邻上下文)⇒ 那边走
     * `AUDIT_CONTEXT_KIND` 上下文 + `shadowedSeqsOfAudit`,同一判据。
     *
     * @param {object} event
     * @param {(seq:number)=>object|undefined} [eventAt] - 可选:按 seq 取事件。
     * @returns {number[]}
     */
    function carrierShadowedSeqs(event, eventAt) {
      const top = Array.isArray(event?.sourceEventSeqs)
        ? event.sourceEventSeqs.filter((s) => Number.isSafeInteger(s))
        : []
      const range = spanRangeOf(event?.surfaceOp)
      if (top.length > 0) {
        // 无区间(如外部 checkpoint 形态)→ 顶层数组即被遮蔽段,原样返回
        if (!range) return top
        // 官方 provenance 要求**列全被遮蔽节点**且区间起点是首节点 ⇒ 数组里必有区间起点;
        // 起点之前的部分是审计 seq 引导项。找不到起点 = 顶层数组不完整(事件管道被截断),
        // 落到下面的兜底路径,而不是把不完整的数组当成被遮蔽段。
        const at = top.indexOf(range.start)
        if (at >= 0 && top[top.length - 1] === range.end) return top.slice(at)
      }
      // 兜底路径(顶层被事件管道剥掉/截断时):若调用方给了事件读取器,
      // 取配对审计段(`pairedAuditOf`:① 首位引用 / ② 任意位引用 / ③ 紧邻+区间一致)
      // 的 `data.shadowedSeqs`(官方合法成员)——读侧配对判据只有一份。
      if (typeof eventAt === 'function') {
        const paired = pairedAuditOf(event, eventAt)
        if (paired) {
          const byPaired = shadowedSeqsOfAudit(paired.event, event)
          if (byPaired.length > 0) return byPaired
        }
      }
      const inner = event?.data?.shadowedSeqs
      return Array.isArray(inner) ? inner.filter((s) => Number.isSafeInteger(s)) : []
    }
    
    /** 载体的 content 文本(读端:留痕/说明文本 = 人读部分)。 */
    function carrierContentText(event) {
      const content = event?.data?.content
      if (!Array.isArray(content)) return ''
      return content
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('')
    }
    
    /** 载体的派生文本字段(旧形态取 editor.text;新形态按需派生,此处给空,由读端决定)。 */
    function carrierLegacyText(event) {
      const text = event?.data?.editor?.text
      return typeof text === 'string' ? text : ''
    }
    
    /**
     * 本模块**只承载「载体形状」**:两段结构、被遮蔽集合、人读文本的**读取**。
     *
     * 「结构化业务元数据 → 人读文本」的序列化属**业务侧概念**(字段名与文案都是业务
     * 词表),不在通用层:它由宿主装配成**注入面**交给写入器(lib/adapter/dsh-writer.js
     * 的 `deriveContentText`)。通用层因此零业务词汇,也不需要"没有业务数据时恒空"的
     * 分支——注入面缺席 = 该宿主本就没有结构化业务数据。
     */
    /**
     * dsh-retrace — lib/adapter/contract.js
     *
     * 适配器层契约(2026-09-01)——业务层与平台解耦的接口定义。
     * **2026-09-10 契约运行时化**:契约不再只是 JSDoc
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
    // 两段结构的形状/文案真相(纯模块零 import;动态件生成时先于本文件 inline)。
    
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
     * (首尾 === start/end)。
     *
     * ⚠️ 这里**不断言 start <= end**:nodes 是**位置序**(非 seq 单调)——replace marker
     * 带着更大的 seq 插进被遮蔽区间的位置,于是「位置在前、seq 更大」是合法形态。
     * 官方 `replacementRange`(dsh-session)只按 `indexOf(start) <= indexOf(end)` 的
     * **位置**判定,与 seq 数值大小无关;要求 start <= end 会把真实会话上的合法 span
     * 误判为契约违规(现场实测:位置序 span 的 seq 数值非单调属正常写入)。
     * 真正可判定的是:两端都是当前面上的节点 → 位置连续段 → 首尾一致(见下)。
     */
    function assertSpanShape(span, contract = 'Span.shape') {
      assertContract(isPlainObject(span), contract, 'span 为对象 {start,end,shadowedSeqs}', span)
      assertContract(
        Number.isSafeInteger(span.start) && span.start >= 0,
        contract, 'span.start 为非负安全整数', span.start,
      )
      assertContract(
        Number.isSafeInteger(span.end) && span.end >= 0,
        contract, 'span.end 为非负安全整数', span.end,
      )
      assertContract(
        Array.isArray(span.shadowedSeqs) && span.shadowedSeqs.length > 0,
        contract, 'span.shadowedSeqs 为非空数组', span.shadowedSeqs,
      )
      assertContract(
        span.shadowedSeqs.every((seq) => Number.isSafeInteger(seq) && seq >= 0),
        contract, 'span.shadowedSeqs 元素全为非负安全整数', span.shadowedSeqs,
      )
      assertContract(
        span.shadowedSeqs[0] === span.start && span.shadowedSeqs[span.shadowedSeqs.length - 1] === span.end,
        contract, 'shadowedSeqs 首尾 === span.start/end(位置连续段;seq 数值可非单调)',
        `${span.shadowedSeqs[0]}..${span.shadowedSeqs[span.shadowedSeqs.length - 1]}`,
      )
      return span
    }
    
    /**
     * span 计算结果契约:`{ status, span, facts }`——
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
     * 写入端**两段结构**的事件契约(ReplaceWriter 返回值 / 落盘前预演)。
     *
     * 为什么这些字段要断言:"写前校验保证 marker 合法"是**声称**——本断言把其中的形状
     * 部分变成**有校验**的事实(两段结构:第 1 段审计 + 第 2 段载体,形状各异):
     * - 第 1 段 `compaction/prune` 的 data 是官方精确三成员清单(无 optional/opaque)
     *   ⇒ 多一个成员即被官方 `has unexpected member` 拒;
     * - 第 2 段 `user/message` 的 data 同样是精确四成员清单,`surfaceOp` 区间与
     *   `sourceEventSeqs` 的被遮蔽段 首尾一致(否则重放面与写入端分叉 —— 历史上正是
     *   这类不一致导致会话加载失败)。
     *
     * `sourceEventSeqs` 的读法(与 lib/marker-carrier.js 一致):首元素 = 第 1 段审计
     * 事件的 seq,被遮蔽段自其后的**区间起点**开始 ⇒ 端点断言取「去掉审计 seq 之后的首尾」。
     * 预演阶段(第 1 段尚未写入,seq 未知)可传 `auditSeq` 占位值,断言逻辑不变。
     *
     * @param {object} marker - 第 2 段事件(或预演对象)
     * @param {string} contract - 断言上下文名
     * @param {{runtimeShape?:object, auditSeq?:number}} [opts] - runtimeShape 注入(测试/多树验证);
     *   auditSeq = 期望的审计 seq(占位允许,仅用于核对首元素位置)
     */
    function assertMarkerShape(marker, contract = 'ReplaceWriter.marker', opts = {}) {
      assertContract(isPlainObject(marker), contract, 'marker 为事件对象', marker)
      assertContract(Number.isSafeInteger(marker.seq) && marker.seq >= 0, contract, 'marker.seq 为非负安全整数', marker.seq)
      assertContract(marker.type === 'user/message', contract, "marker.type === 'user/message'(两段结构的第 2 段载体)", marker.type)
      const data = marker.data
      assertContract(isPlainObject(data), contract, 'marker.data 为对象', data)
      assertContract(
        sameKeySet(data, CARRIER_DATA_KEYS),
        contract,
        `marker.data 键集恰为 {${CARRIER_DATA_KEYS.join(',')}}(官方 user/message 词表,无 optional/opaque)`,
        Object.keys(data).join(','),
      )
      assertContract(
        isPlainObject(data.source) && data.source.kind === CARRIER_SOURCE_KIND,
        contract,
        `marker.data.source.kind === '${CARRIER_SOURCE_KIND}'(≠'user':否则轮边界被当成真实用户输入)`,
        data.source?.kind,
      )
      assertContract(
        Array.isArray(data.content) && data.content.length > 0,
        contract,
        'marker.data.content 为非空数组(空 content 会投影成一条空 user 消息)',
        data.content,
      )
      assertContract(isMarkerId(data.id), contract, `marker.data.id 为我方 marker id(前缀 ${MARKER_ID_PREFIXES.join('/')})`, data.id)
      const { start, end, startKey, endKey, shape } = markerSurfaceRange(marker.surfaceOp, contract)
      // 双向误用探测(方案 v3 §二①):**形状须与当前运行时一致**。
      // 依据:官方 v0 树只校验键数(=3)、不校验键名语义 ⇒ 用错形状的错误要等到下游才显现;
      // 且官方迁移链自己会在 v2→v3 换名 ⇒ 我方无需预先写 v3 键名(全语料 v3 形状先例 0/308)。
      // 故:本断言对**写侧严格**(形状须匹配目标树),而 markerSurfaceRange 的**解析**保持宽松
      // (两形状都解析,供读历史数据);目标树可经 opts.runtimeShape 注入(测试/多树验证用)。
      const rtShape = opts.runtimeShape ?? runtimeSurfaceOpShape()
      assertContract(
        shape === rtShape.shape,
        contract,
        `marker.surfaceOp 形状须与当前运行时一致(${rtShape.shape};SESSION_FORMAT_VERSION=${rtShape.version})`,
        `实际 ${shape}`,
      )
      const seqs = marker.sourceEventSeqs
      assertContract(Array.isArray(seqs) && seqs.length > 0, contract, 'marker.sourceEventSeqs 为非空数组', seqs)
      if (opts.auditSeq !== undefined) {
        assertContract(seqs[0] === opts.auditSeq, contract, 'sourceEventSeqs 首元素 === 第 1 段(审计)事件 seq', seqs[0])
        assertContract(seqs.length >= 2, contract, 'sourceEventSeqs = [审计 seq, …被遮蔽节点](至少 2 项)', seqs)
      }
      // 被遮蔽段自区间起点起:首元素若是区间起点(旧形态/无审计引用)则自 0 起算。
      const from = seqs[0] === start ? 0 : 1
      assertContract(
        seqs[from] === start && seqs[seqs.length - 1] === end,
        contract,
        `去掉审计 seq 后 sourceEventSeqs 首尾 === surfaceOp.${startKey}/${endKey}(写入端与重放面一致)`,
        `${seqs[from]}..${seqs[seqs.length - 1]}`,
      )
      assertContract(
        seqs.every((seq) => Number.isSafeInteger(seq) && seq >= 0),
        contract,
        'sourceEventSeqs 元素全为非负安全整数',
        seqs,
      )
      assertContract(
        new Set(seqs).size === seqs.length,
        contract,
        'sourceEventSeqs 无重复项(官方 provenance 拒重复)',
        seqs.length,
      )
      if (opts.auditSeq !== undefined) {
        // 审计事件写在其后 ⇒ 它的 seq 大于全部被遮蔽节点(官方 provenance 只允许引用
        // 更早事件;相等则同时构成重复项)。这条同时拦住"调用方拿陈旧快照算的 span"
        // ——那种 span 会把某个尚未产生的事件 seq 当成被遮蔽节点。
        const later = seqs.filter((seq) => seq !== opts.auditSeq && seq >= opts.auditSeq)
        assertContract(
          later.length === 0,
          contract,
          `全部被遮蔽节点 seq 早于审计事件 seq ${opts.auditSeq}(官方 provenance 只允许引用更早事件)`,
          later,
        )
      }
      return marker
    }
    
    /**
     * 第 1 段(`compaction/prune`,log-only 审计)的事件契约。
     *
     * 官方词表(`dsh-session-format-v0-to-v1`):data 恰三成员、无 optional/opaque;
     * 语义约束 = shadowedRange 恰 `{start,end}` 且**都早于本事件 seq**、shadowedSeqs
     * 非空且首尾 === 区间端点、shadowedTokenCount 为非负整数。
     * @param {object} audit - 第 1 段事件(或预演对象,seq 用占位 0)
     * @param {string} contract
     */
    function assertAuditShape(audit, contract = 'ReplaceWriter.audit') {
      assertContract(isPlainObject(audit), contract, '审计事件为对象', audit)
      assertContract(Number.isSafeInteger(audit.seq) && audit.seq >= 0, contract, '审计事件 seq 为非负安全整数', audit.seq)
      assertContract(audit.type === AUDIT_EVENT_TYPE, contract, `审计事件 type === '${AUDIT_EVENT_TYPE}'(官方 log-only 类型)`, audit.type)
      assertContract(
        audit.surfaceOp === undefined && audit.sourceEventSeqs === undefined,
        contract,
        '审计事件不带 surfaceOp/sourceEventSeqs(该类型非 surface-eligible,运行时直接抛)',
        describeActual({ surfaceOp: audit.surfaceOp, sourceEventSeqs: audit.sourceEventSeqs }),
      )
      const data = audit.data
      assertContract(isPlainObject(data), contract, '审计事件 data 为对象', data)
      assertContract(
        sameKeySet(data, AUDIT_DATA_KEYS),
        contract,
        `审计事件 data 键集恰为 {${AUDIT_DATA_KEYS.join(',')}}(官方词表:无 optional/opaque)`,
        Object.keys(data).join(','),
      )
      const range = data.shadowedRange
      assertContract(
        isPlainObject(range) && sameKeySet(range, ['start', 'end']),
        contract, 'shadowedRange 为精确 {start,end}', range,
      )
      assertContract(
        Number.isSafeInteger(range.start) && range.start >= 0 && Number.isSafeInteger(range.end) && range.end >= 0,
        contract, 'shadowedRange 端点为非负安全整数', `${range.start}..${range.end}`,
      )
      const seqs = data.shadowedSeqs
      assertContract(Array.isArray(seqs) && seqs.length > 0, contract, 'shadowedSeqs 为非空数组', seqs)
      assertContract(
        seqs.every((seq) => Number.isSafeInteger(seq) && seq >= 0),
        contract, 'shadowedSeqs 元素全为非负安全整数', seqs,
      )
      assertContract(
        seqs[0] === range.start && seqs[seqs.length - 1] === range.end,
        contract, 'shadowedSeqs 首尾 === shadowedRange 端点(官方语义约束)',
        `${seqs[0]}..${seqs[seqs.length - 1]}`,
      )
      assertContract(
        new Set(seqs).size === seqs.length,
        contract, 'shadowedSeqs 无重复 seq(官方 seqArray 拒重复)', `${seqs.length} 项/${new Set(seqs).size} 个不同值`,
      )
      assertContract(
        Number.isSafeInteger(data.shadowedTokenCount) && data.shadowedTokenCount >= 0,
        contract, 'shadowedTokenCount 为非负整数', data.shadowedTokenCount,
      )
      return audit
    }
    
    /** 两个键集是否**完全相同**(顺序无关)。 */
    function sameKeySet(value, keys) {
      const actual = Object.keys(value)
      if (actual.length !== keys.length) return false
      return keys.every((key) => Object.hasOwn(value, key))
    }
    
    /**
     * marker.surfaceOp 的**双形状**区间取值(特性探测,勿硬断言单一形状)。
     *
     * - **运行时 0.1.1-rc.2(树 v0)**：`{op:'replace', start, end}`
     *   —— `dsh-session/lib/types/surface.js:113-122` 的 `isReplaceOp` 要求 `Object.keys(op).length === 3`;
     *   且 `dsh-session-format-v0-to-v1/lib/index.js:1564-1568` 的
     *   `assertReleasedV0Keys(replacement, ['op','start','end'], [], …)` 对**多余键**报
     *   `has unexpected member`。
     * - **lab 0.1.5(v3)**：`{op:'replace', startSeq, endSeq}`
     *   —— `surface.js:166-174` 的 `isReplaceOp` 同样要求键数**精确为 3**;
     *   键名由 v2→v3 迁移改写(`dsh-session-format-v2-to-v3/lib/index.js:366-372`)。
     *
     * 两棵树都要求**键数精确为 3** → **不允许混写**(同时带 `start` 与 `startSeq` 在两边都非法)。
     * 本函数只做形状判定与区间提取,**不决定写哪一套**;写哪套由运行时特性探测决定。
     *
     * @param op - marker.surfaceOp
     * @param contract - 断言上下文名
     * @returns {{start:number, end:number, shape:'start/end'|'startSeq/endSeq'}}
     */
    /**
     * 当前运行时的 surfaceOp **形状**(特性探测,勿硬编码)。
     *
     * 依据:官方 `@deepseek-ai/dsh-session` 在**两棵树都导出** `SESSION_FORMAT_VERSION`
     * —— 运行时 0.1.1-rc.2 = `0`(形状 `{op,start,end}`);lab 0.1.5 = `3`(形状 `{op,startSeq,endSeq}`)。
     * 静态导入该常量在两棵树都安全(与"被移除的 `decodeStorageRecord`"不同)。
     *
     * ⚠️ 探测的理由:官方 v0 树只校验键数(=3),**不校验键名语义** ⇒ 写错形状的错误要等到下游才显现,
     * (`surface start targets consumed assistant/chunk undefined`)⇒ 写错形状会**静默失效**。
     *
     * @returns {{shape:'start/end'|'startSeq/endSeq', version:number, startKey:string, endKey:string}}
     */
    function runtimeSurfaceOpShape() {
      let version = 0
      try {
        // 动态读取,避免打包期静态解析失败时整体崩(降级为 v0 = 本仓当前运行时的形状)
        version = Number(SESSION_FORMAT_VERSION ?? 0)
      } catch { version = 0 }
      const v3 = Number.isFinite(version) && version >= 3
      return v3
        ? { shape: 'startSeq/endSeq', version, startKey: 'startSeq', endKey: 'endSeq' }
        : { shape: 'start/end', version, startKey: 'start', endKey: 'end' }
    }
    
    function markerSurfaceRange(op, contract = 'ReplaceWriter.marker') {
      assertContract(
        isPlainObject(op) && op.op === 'replace',
        contract, "marker.surfaceOp = {op:'replace',start,end}(v0)或 {op:'replace',startSeq,endSeq}(v3)", op,
      )
      const keys = Object.keys(op).sort().join(',')
      const isV0Shape = keys === 'end,op,start'
      const isV3Shape = keys === 'endSeq,op,startSeq'
      assertContract(
        isV0Shape || isV3Shape,
        contract,
        "marker.surfaceOp 键集为 {op,start,end}(v0 运行时)或 {op,startSeq,endSeq}(v3 运行时);两棵树均要求键数精确为 3,不得混用",
        keys,
      )
      const start = isV0Shape ? op.start : op.startSeq
      const end = isV0Shape ? op.end : op.endSeq
      assertContract(
        Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end >= 0,
        contract, 'marker.surfaceOp 区间端点为非负安全整数(位置序,start 数值可 > end)', `${start}..${end}`,
      )
      return {
        start,
        end,
        shape: isV0Shape ? 'start/end' : 'startSeq/endSeq',
        startKey: isV0Shape ? 'start' : 'startSeq',
        endKey: isV0Shape ? 'end' : 'endSeq',
      }
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
    // Host event-view compatibility (new host: snapshotEvents/eventAt; old host: events array).
    
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
      // 附带结构化排查信息(messageId/seq 等),经 op 信封透传到 wire
      if (details && typeof details === 'object') error.details = details
      return error
    }
    
    /**
     * 目标被更早 fold/recall/compact 遮蔽(历史只读)——文案给正解:
     * 展开该块后编辑,或追加新消息修订。host 侧即中文(不再透传英文),
     * client 按 code 再本地化(zh/en 同文案,见 lib/client.js error.*)。
     */
    const SHADOWED_TARGET_MESSAGE = '该消息位于已折叠块(历史只读):展开该块后编辑,或追加新消息修订'
    
    /**
     * 目标消息「提交中」(刚 commit/文件 flush 滞后,span 快照尚未纳入)
     * ——可重试,不是用户消息出了问题。
     */
    const PENDING_TARGET_MESSAGE = '消息生成中,完成后可编辑'
    
    /**
     * 遮蔽范围重放失败(内部错误)。之前这类失败与「已被遮蔽」
     * 共用 null → 用户看到"历史只读"(误导且不可行动);现在如实报内部错误。
     */
    const SPAN_REPLAY_FAILED_MESSAGE = '遮蔽范围计算失败(内部错误):会话日志重放异常,请重试或反馈该会话'
    
    /** 文件侧确证目标不存在(不是"提交中",也不是"被遮蔽")时的文案。 */
    const TARGET_NOT_FOUND_MESSAGE = '目标消息不在会话日志中(可能已删除或消息 id 无效)'
    
    /** Latest known provider/model: from the last request header, else last assistant message. */
    function lastModelSource(session) {
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
       * 写「遮蔽 marker」——业务层唯一入口（2026-09-02 抽象设计落地）。
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
       * 确保 agent 空闲（2026-08-30 事故修复，用户方案落地）：agent 正在响应时，
       * **不拒绝**——自动请求停止（`agent.cancel`）并等待其干净收尾（`whenIdle`）。
       *
       * 为什么必须等停止：编辑/重发发生在 agent 还开着 step 时，DSH 的 resend 机制
       * 会把旧 step 的 assistant/chunk 全部引用进新 assistant/message 的
       * `sourceEventSeqs`（实测：引用跨 turn 54 的 step 7/8/9），
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
       * 遮蔽计算(2026-09-01 彻底绕开稀疏 events):在 surface.nodes(全量 seq 列表)里
       * 找轮边界,不遍历稀疏的 host events 数组(host events 可能只加载部分,
       * 用户实测 host 报 2006 vs 文件全量 10;稀疏遍历的 undefined 洞导致遮蔽全量)。
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
       * 2026-09-01 修复(彻底绕开稀疏 events):在 surface.nodes(全量 seq 列表)里找
       * 轮边界,不遍历稀疏的 host events 数组——host 的 events 可能只加载部分
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
        const messageId = String(args?.messageId ?? '')
        const session = requireSession(sessionId)
        await ensureIdle(agents.get(sessionId))
        const seq = findMessageSeq(session, messageId)
        if (seq === -1) throw editorError('message-not-found', 'Message not found in this session.')
        // 2026-09-07:撤回语义 = 遮蔽目标轮及之后全部(编辑=从此处分叉
        // issue)——fallback 用 tail;主路径由 index.js 注入 spanFromFile(官方 foldSurface nodes)。
        // 大范围遮蔽由快照点守卫引导分支(太旧消息的正确出口)。
        // span null 不直接当「被遮蔽」——先区分「提交中(文件/快照滞后,可重试)」
        // 与「真被遮蔽(fold/recall/compact 已移除,历史只读)」。
        const span = args?.span ?? shadowSpanFrom(session, seq, { mode: 'tail' })
        if (!span) throwSpanMiss(session, seq, args, messageId)
        const markerEvent = await writeMarker(session, span, 'recall', seq, messageTextOf(session, seq))
        await flushSafely(session)
        notifyBoundary('recall', session, span, markerEvent, '')
        return {
          op: 'recall',
          messageId,
          seq,
          markerSeq: markerEvent.seq,
          shadowed: span.shadowedSeqs.length,
          text: messageTextOf(session, seq),
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
        const event = eventAt(session, seq)
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
        const events = sessionEvents(session)
        const firstBoundary = events.findIndex((e) => isRoundBoundary(e))
        const startSeq = fromScratch
          ? (firstBoundary >= 0 ? firstBoundary : 0)
          : seq
        if (startSeq === undefined) throw editorError('empty-surface', 'This session has no conversation to edit.')
        // 2026-09-01 修复:普通编辑用「轮内遮蔽」(只遮蔽目标输入+它的回复),不遮蔽到尾部——
        // 否则编辑「最新消息」会遮蔽 surface 尾部全部(用户实测:编辑"测试1"遮蔽 1806 节点,
        // 因为 UI 显示的消息在 surface 中间位置)。fromScratch 才遮蔽到尾部(重新开始语义)。
        // 2026-09-01 二次修复:若外部传入 span(host 从文件读全量算好,绕开稀疏 events),
        // 直接用外部 span;否则用内部计算(受 host 内存视图影响,可能不准)。
        // span null 先区分「提交中(可重试)」vs「真被遮蔽(历史只读)」。
        const span = args?.span ?? (fromScratch ? shadowSpanFrom(session, startSeq, { mode: 'tail' }) : roundSpanFrom(session, seq))
        if (!span) throwSpanMiss(session, seq, args, messageId)
        const markerEvent = await writeMarker(session, span, 'edit', seq, originalText)
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
          // 2026-09-01 在 nodes(全量 seq 列表)里向前找最近的 user 输入——不遍历稀疏 events。
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
        // 2026-09-01 修复:regenerate 也用「轮内遮蔽」——只遮蔽目标 user 的回复轮,
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
    
      return {
        recall: (args) => recall(args),
        editAndResend: (args) => editAndResend(args),
        regenerate: (args) => regenerate(args),
      }
    }
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
    // 契约运行时化:跨层边界校验——业务层传入的 span 与写出的两段事件都要在边界处
    // 形状合规(违规 → 指名道姓的 contract-violation,而不是写出"表面成功、
    // 重放时对不上"的载体)。
    // 载体形状/文案的唯一真相(纯模块零 import;生成动态件时与 contract 一同 inline)。
    // Host event-view compatibility (new host: snapshotEvents/eventAt; old host: events array).
    
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
    function carrierContentOf(meta, deriveContentText) {
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
    function createDshMarkerWriter({ validateMarker, log = () => {}, meter, deriveMessage, deriveContentText } = {}) {
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
    // 遮蔽写入器（DSH 两段结构翻译）。动态路径无 prewrite guard——
    // 正式装配在 lib/index.js 注入 validateMarker。
    // 官方 token-meter 服务面同样**注入**（生成件里不能 import 官方包）：第 1 段的
    // shadowedTokenCount 必须写官方 shadow-price（令牌价），拿不到服务时写入器拒写。
    const markerWriter = createDshMarkerWriter({
      meter: () => (typeof ctx.get === 'function' ? ctx.get('tokenMeter') : undefined) ?? ctx.tokenMeter,
      log,
    })
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
