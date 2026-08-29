/**
 * GENERATED FILE — do not edit by hand.
 * Source of truth: lib/host-core.js + the wrapper below (scripts/generate-dynamic.mjs).
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
    function editorError(code, message) {
      const error = new Error(message)
      error.code = code
      return error
    }
    
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
     * Append the invisible replacement marker that shadows [span.start..span.end].
     * Shared by recall/edit/regenerate (L1) and context rollback (P1): an empty
     * assistant message is a valid surface node yet derives to *no* model message,
     * so the LLM context simply rewinds. `turn: null` declares a session-level
     * event (the client location index maps it to SESSION_LOCATION, keeping it out
     * of every turn's node list). `editor` carries the reference facts the UI uses
     * for the optional "original input" comparison row.
     */
    /**
     * Append the invisible replacement marker that shadows [span.start..span.end].
     * Shared by recall/edit/regenerate (L1) and context rollback (P1): an empty
     * assistant message is a valid surface node yet derives to *no* model message,
     * so the LLM context simply rewinds. `turn: null` declares a session-level
     * event (the client location index maps it to SESSION_LOCATION, keeping it out
     * of every turn's node list). `editor` carries the reference facts the UI uses
     * for the optional "original input" comparison row.
     *
     * The optional `validate` hook receives the would-be event envelope BEFORE it
     * is committed (validate first, commit later — the 8-25 incident's fix): a
     * throwing validator aborts the append, so a contract-violating marker can
     * never reach the durable log. The hook may be async.
     *
     * R2（2026-08-29）：validate 可返回 `{ t1Ok }`（prewrite-guard 的 T1 折叠自检）。
     * t1Ok=false 时**不阻断写入**（编辑必须生效），但在 marker 的 `editor` 上标注
     * `markerT1Broken: true`，让客户端/离线工具知道该 marker 会使 /compact 失效。
     */
    async function appendEditorMarker(session, span, op, targetSeq, originalText, validate) {
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
      // R2 路径一（2026-08-30 事故闭环）：有打开的 step（回合中编辑）时，marker 携带
      // 该 step 的 turn/step —— token-meter 配对通过，不产生 T1 违规、不刷屏。
      // 无打开 step（轮次间编辑，常态）才回退 turn:null（配合 markerT1Broken 标注）。
      const openStep = findOpenStep(session)
      const data = {
        turn: openStep ? openStep.turn : null,
        step: openStep ? openStep.step : null,
        message: marker,
        editor: {
          targetSeq,
          text: typeof originalText === 'string' ? originalText.slice(0, 2000) : '',
        },
      }
      const surfaceOp = { op: 'replace', start: span.start, end: span.end }
      const sourceEventSeqs = span.shadowedSeqs.slice()
      if (typeof validate === 'function') {
        const result = await validate(session, { type: 'assistant/message', data, surfaceOp, sourceEventSeqs })
        if (result && result.t1Ok === false) {
          // R2：标注该 marker 会破坏 /compact（不阻断编辑）。
          data.editor.markerT1Broken = true
        }
      }
      return session.append('assistant/message', data, { surfaceOp, sourceEventSeqs })
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
    
    function createEditorApi(ctx, sessions, agents, log = () => {}, hooks = {}) {
      /** One in-flight op per session; later ops wait for the earlier one. */
      const locks = new Map()
    
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
       * `sourceEventSeqs`（526f1835 seq 936047：引用跨 turn 54 的 step 7/8/9），
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
            agent.cancel({ kind: 'plugin-retrace-edit' })
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
    
      /** The current model-surface span starting at `startSeq` through the tail. */
      function shadowSpanFrom(session, startSeq) {
        const nodes = session.surface.nodes
        const index = nodes.indexOf(startSeq)
        if (index === -1) return null
        const span = nodes.slice(index)
        return {
          start: span[0],
          end: span[span.length - 1],
          shadowedSeqs: span.slice(),
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
       */
      function roundSpanFrom(session, seq) {
        const nodes = session.surface.nodes
        const index = nodes.indexOf(seq)
        if (index === -1) return null
        const targetEvent = session.events[seq]
        let startIdx = index
        if (!isRoundBoundary(targetEvent)) {
          for (let i = index - 1; i >= 0; i--) {
            if (isRoundBoundary(session.events[nodes[i]])) {
              startIdx = i
              break
            }
          }
        }
        let endIdx = nodes.length - 1
        for (let i = startIdx + 1; i < nodes.length; i++) {
          if (isRoundBoundary(session.events[nodes[i]])) {
            endIdx = i - 1
            break
          }
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
        const span = roundSpanFrom(session, seq)
        if (!span) throw editorError('target-shadowed', 'This message is no longer part of the active conversation.')
        const markerEvent = await appendEditorMarker(session, span, 'recall', seq, messageTextOf(session, seq), hooks.validateMarker)
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
        const startSeq = fromScratch ? session.surface.nodes[0] : seq
        if (startSeq === undefined) throw editorError('empty-surface', 'This session has no conversation to edit.')
        const span = shadowSpanFrom(session, startSeq)
        if (!span) throw editorError('target-shadowed', 'This message is no longer part of the active conversation.')
        const markerEvent = await appendEditorMarker(session, span, 'edit', seq, originalText, hooks.validateMarker)
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
        const nodes = session.surface.nodes
        const index = nodes.indexOf(seq)
        if (index === -1) throw editorError('target-shadowed', 'This message is no longer part of the active conversation.')
        let userSeq = -1
        for (let i = index - 1; i >= 0; i--) {
          if (isRoundBoundary(session.events[nodes[i]])) {
            userSeq = nodes[i]
            break
          }
        }
        if (userSeq === -1) throw editorError('no-prompt', 'No user message precedes this reply; cannot regenerate.')
        const text = extractUserText(session.events[userSeq]?.data?.content)
        if (!text.trim()) {
          throw editorError('no-text', 'The original message carries no text to regenerate from.')
        }
        if (!agent || typeof agent.followup !== 'function') {
          throw editorError('agent-unavailable', 'No live agent for this session; cannot re-send.')
        }
        const span = shadowSpanFrom(session, userSeq)
        if (!span) throw editorError('target-shadowed', 'This message is no longer part of the active conversation.')
        const markerEvent = await appendEditorMarker(session, span, 'regenerate', userSeq, text, hooks.validateMarker)
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
    const api = createEditorApi(ctx, sessions, agents, log)
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
