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
     * Pure ESM with zero imports: safe to run inside the dynamic-package sandbox
     * and inside a published package alike. Every op resolves to a transport-
     * neutral result object `{ ok: true, value }` or `{ ok: false, error }` and
     * never rejects (transport failures are the caller's concern).
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
        return writer(session, span, { op, targetSeq, originalText })
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
       * - mode='round':遮蔽 startSeq 所在轮——edit/regenerate 用;
       * - mode='tail':遮蔽 startSeq 之后所有 surface 节点——fromScratch 用。
       */
      function shadowSpanFrom(session, startSeq, { mode = 'round' } = {}) {
        const events = session.events
        const nodes = Array.isArray(session.surface?.nodes) ? session.surface.nodes : []
        if (!Array.isArray(events) || !events[startSeq]) return null
        if (mode === 'round') {
          const index = nodes.indexOf(startSeq)
          if (index === -1) return null
          let startIdx = index
          for (let i = index; i >= 0; i--) {
            if (isRoundBoundary(events[nodes[i]])) { startIdx = i; break }
          }
          let endIdx = nodes.length - 1
          for (let i = startIdx + 1; i < nodes.length; i++) {
            if (isRoundBoundary(events[nodes[i]])) { endIdx = i - 1; break }
          }
          const span = nodes.slice(startIdx, endIdx + 1)
          if (span.length === 0) return null
          return { start: span[0], end: span[span.length - 1], shadowedSeqs: span }
        }
        // tail 模式:从目标所在轮首遮蔽到 surface 尾(撤回 = 移除整轮 input+output + 其后
        // 全部;目标若是轮内 assistant/tool 则回退到轮首 user,防孤立输入)。位置连续段——
        // marker 插入使 nodes 非 seq 单调,filter(s>=startSeq) 会漏/错;host 视图尽力,
        // 主路径 = index.js 注入 spanFromFile 官方 foldSurface nodes,ISSUE-20260907113201。
        const index = nodes.indexOf(startSeq)
        if (index === -1) return null // 已被遮蔽/不在 surface → target-shadowed
        let startPos = index
        for (let i = index; i >= 0; i--) {
          if (isRoundBoundary(events[nodes[i]])) { startPos = i; break }
        }
        const shadowedSeqs = nodes.slice(startPos)
        if (shadowedSeqs.length === 0) return null
        return {
          start: shadowedSeqs[0],
          end: shadowedSeqs[shadowedSeqs.length - 1],
          shadowedSeqs,
        }
      }
    
      /**
       * A round boundary is a real user-sent message. The runtime also appends
       * `user/message` events for injected context/steering (source.kind !== 'user',
       * e.g. the runtime-context snapshot); those must NOT split an exchange round.
       */
      function isRoundBoundary(event) {
        return event?.type === 'user/message' && event.data?.source?.kind === 'user'
      }
    
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
        const nodes = Array.isArray(session.surface?.nodes) ? session.surface.nodes : []
        const events = session.events
        if (!Array.isArray(events) || !events[seq]) return null
        const index = nodes.indexOf(seq)
        if (index === -1) return null
        // 向前找轮首(在 nodes 里找最近的前一个 user 输入)
        let startIdx = index
        for (let i = index; i >= 0; i--) {
          if (isRoundBoundary(events[nodes[i]])) { startIdx = i; break }
        }
        // 向后找轮尾(在 nodes 里找下一个 user 输入前)
        let endIdx = nodes.length - 1
        for (let i = startIdx + 1; i < nodes.length; i++) {
          if (isRoundBoundary(events[nodes[i]])) { endIdx = i - 1; break }
        }
        const span = nodes.slice(startIdx, endIdx + 1)
        return {
          start: span[0],
          end: span[span.length - 1],
          shadowedSeqs: span,
        }
      }
    
      function extractUserText(content) {
        if (!Array.isArray(content)) return ''
        return content
          .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('')
      }
    
      /**
       * span 计算失败(目标不在本次 span 快照的 surface)时区分两类原因(issue-200):
       *  - 'pending'  → 目标消息「提交中」:刚 commit/正被 append,文件与快照尚未纳入
       *                 (用户点击落在 turn 收尾窗口)——应可重试(message-pending),
       *                 不是「消息已不在活跃对话」;
       *  - 'shadowed' → 目标被更早的 replace(fold/recall/compact)移出 surface(历史只读)。
       *
       * 纯函数(零 import):只消费 args.spanFacts(文件层注入)与会话内存结构。
       * 判定(证据递减):
       *  1. 文件层事实 args.spanFacts(withFileSpan/http.js 在 spanFromFile 返回 null 时注入):
       *     目标 seq > 文件快照已知最大 seq → 快照尚未覆盖目标(文件 flush 滞后)→ pending;
       *     快照已覆盖到目标位置却仍无 span → 目标已被文件 surface 移除 → shadowed。
       *  2. 无文件事实(直接调用/测试桩/文件不可读)→ 内存判:
       *     a. 更早 replace marker 的 sourceEventSeqs(data.shadowedSeqs 兜底)命中目标
       *        → shadowed(fold/recall/compact 的确定性证据);
       *     b. 目标事件存在且其 seq 超出 surface 已知最大节点(尾部最近 append,快照
       *        未纳入)→ pending;
       *     c. 其余无法判定 → shadowed(保守,保持 0.4.23 及以前的语义)。
       */
      function spanMissKind(session, seq, args) {
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
    
      /** span null 分支统一抛错(issue-200/199):pending → message-pending;否则 target-shadowed(中文可操作文案)。 */
      function throwSpanMiss(session, seq, args, messageId) {
        const details = { messageId, seq }
        if (spanMissKind(session, seq, args) === 'pending') {
          throw editorError('message-pending', PENDING_TARGET_MESSAGE, details)
        }
        throw editorError('target-shadowed', SHADOWED_TARGET_MESSAGE, details)
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
