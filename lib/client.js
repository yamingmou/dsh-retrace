/**
 * dsh-retrace — Client plugin entry (published form).
 *
 * Adds to the Web conversation view:
 *  1. an action strip on assistant replies (撤回 / 重新生成) via the
 *     `conversation.chat.assistant-actions` list seat,
 *  2. an action row under every user message (编辑 / 撤回) with an inline
 *     editor; after a recall the recalled text is echoed into the composer,
 *  3. a `recall-marker` node that HIDES every shadowed message row from the
 *     flow (CSS `data-chat-anchor-key` rules) and renders a notice row with an
 *     optional "original input" comparison block,
 *  4. two preference toggles under Settings → General (original-input
 *     comparison row, fresh-start editing) backed by localStorage.
 *
 * Operations reach the Host through the same-origin route
 * `/api/plugins/retrace/*` registered by the Host half.
 */
import { createElement, useEffect, useState } from 'react'

export const name = 'dsh-retrace'
export const inject = ['slots', 'locale', 'conversationEvents']

const NS = 'retrace'
const ROUTE_BASE = '/api/plugins/retrace'
const MARKER_PREFIX = 'retrace'
const CONFIG_KEY = 'dsh-retrace:config'

/** Simplified Chinese dictionary (key-set source of truth). */
const zh = {
  'action.edit': '编辑',
  'action.editAria': '编辑这条消息',
  'action.recall': '撤回',
  'action.recallAssistant': '撤回这条回复',
  'action.recallUser': '撤回这条消息',
  'action.regenerate': '重新生成',
  'action.send': '发送',
  'action.cancel': '取消',
  'marker.recall': '已撤回这条消息及其后的对话',
  'marker.recallMany': '已撤回 {count} 条消息',
  'marker.recallOne': '已撤回 1 条消息',
  'marker.edit': '已编辑此消息并重新发送，对话从新消息继续',
  'marker.regenerate': '已重新生成回复',
  'marker.originalLabel': '原输入',
  'marker.referenceHint': '点击展开查看原提问（仅作对照，不会进入模型上下文）',
  'options.title': '消息编辑插件',
  'options.showOriginalInput': '编辑后显示原提问对照',
  'options.editFromScratch': '编辑后从新对话开始（隐藏此前的消息）',
  'options.versioning': '版本与产物快照',
  'options.versioningDesc': '开：每次撤回/编辑记录一个版本（消息与触碰文件），提供时间线与产物回退；关：仅回退上下文，不记录版本、不追踪产物（最省资源）。',
  'options.git': '启用 git 集成',
  'options.gitDesc': '开：工作区是 git 仓库时用 git 记录与回退（不自动提交、不动你的分支），非仓库可在时间线里一键启用；关：一律用内置快照（存于 ~/.dsh），不触碰工作区 git 状态，功能等价。',
  'options.retention': '版本保留上限',
  'options.retentionDesc': '文件快照只保留最近 N 个版本，超出自动清理最旧的；时间线记录与审计痕迹始终保留。',
  'error.generic': '操作失败，请重试',
  'error.busy': '请先停止当前回复再操作',
}
/** English dictionary, checked complete against the zh key set. */
const en = {
  'action.edit': 'Edit',
  'action.editAria': 'Edit this message',
  'action.recall': 'Recall',
  'action.recallAssistant': 'Recall this reply',
  'action.recallUser': 'Recall this message',
  'action.regenerate': 'Regenerate',
  'action.send': 'Send',
  'action.cancel': 'Cancel',
  'marker.recall': 'This message and the following conversation were recalled',
  'marker.recallMany': '{count} messages were recalled',
  'marker.recallOne': '1 message recalled',
  'marker.edit': 'Edited and re-sent; the conversation continues from the new message',
  'marker.regenerate': 'Reply regenerated',
  'marker.originalLabel': 'Original input',
  'marker.referenceHint': 'Click to expand the original input (reference only, never sent to the model)',
  'options.title': 'Message editor plugin',
  'options.showOriginalInput': 'Show the original input after editing',
  'options.editFromScratch': 'Start a fresh conversation after editing (hide earlier messages)',
  'options.versioning': 'Version & artifact snapshots',
  'options.versioningDesc': 'On: every recall/edit records a version (messages and touched files) powering the timeline and artifact rollback. Off: only rewinds context — no version records, no artifact tracking (lightest).',
  'options.git': 'Git integration',
  'options.gitDesc': 'On: uses git to record and roll back when the workspace is a repository (never auto-commits, never touches your branches); non-repo workspaces can enable git from the timeline. Off: built-in snapshots under ~/.dsh only — the plugin never touches the workspace git state; equivalent features.',
  'options.retention': 'Version retention limit',
  'options.retentionDesc': 'File snapshots are kept for the most recent N versions; older ones are pruned automatically (timeline records and the audit trail are always kept).',
  'error.generic': 'Operation failed; please try again',
  'error.busy': 'Stop the current reply before recalling or editing',
}

// ---------------------------------------------------------------------------
// Durable-surface helpers (mirror of @deepseek-ai/dsh-session/surface).
// ---------------------------------------------------------------------------
const SURFACE_TYPES = new Set(['user/message', 'assistant/message', 'tool/result'])

function isReplacementSurfaceEvent(event) {
  return SURFACE_TYPES.has(event.type) && event.surfaceOp !== undefined && event.surfaceOp !== 'append'
}

// ---------------------------------------------------------------------------
// Wire call
// ---------------------------------------------------------------------------
// The published client calls the same-origin HTTP route registered by the Host
// half. The generated dynamic client (scripts/generate-dynamic.mjs) swaps in
// `host.call` before apply runs, so ONE source serves both runtimes and the
// two can never drift apart.
let wire = null

export function __setMessageEditorWire(fn) {
  wire = fn
}

function callOp(op, payload) {
  if (typeof wire === 'function') return wire(op, payload)
  return fetch(`${ROUTE_BASE}/${op}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...retraceConfigHeaders() },
    body: JSON.stringify(payload),
  }).then((res) => {
    if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`)
    return res.json()
  })
}

/** The localStorage plugin config, carried to the Host on every request
 * (PLAN §4.6: the host honors it per request and does not persist it). */
function retraceConfigHeaders() {
  const { versioning, git, retentionLimit } = getConfig()
  return { 'x-retrace-config': JSON.stringify({ versioning, git, retentionLimit }) }
}

// ---------------------------------------------------------------------------
// Plugin preferences (localStorage-backed, reactive)
// ---------------------------------------------------------------------------
const CONFIG_DEFAULTS = { showOriginalInput: true, editFromScratch: true, versioning: true, git: true, retentionLimit: 50 }
const configListeners = new Set()
let configCache = readConfig()

/** resendMessageId -> the exact text that edit replaced (most recent, host-authoritative). */
const editReferences = new Map()

function readConfig() {
  try {
    const raw = localStorage.getItem(CONFIG_KEY)
    return { ...CONFIG_DEFAULTS, ...(raw ? JSON.parse(raw) : {}) }
  } catch {
    return { ...CONFIG_DEFAULTS }
  }
}
function getConfig() {
  return configCache
}
function setConfig(patch) {
  configCache = { ...configCache, ...patch }
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(configCache))
  } catch { /* storage unavailable */ }
  for (const listener of configListeners) listener(configCache)
}
function subscribeConfig(listener) {
  configListeners.add(listener)
  return () => {
    configListeners.delete(listener)
  }
}
function useConfig() {
  const [, force] = useState(0)
  useEffect(() => subscribeConfig(() => force((x) => x + 1)), [])
  return getConfig()
}

// ---------------------------------------------------------------------------
// Conversation node definitions
// ---------------------------------------------------------------------------
function chatNodeLike(context, kind, anchorSeq, data) {
  return {
    key: context.key,
    kind,
    id: context.id,
    target: 'chat',
    anchorSeq,
    location: context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' },
    visibility: 'visible',
    data,
  }
}

/** One small action row per user-sent message (edit / recall). */
const userActionsDefinition = {
  kind: 'retrace-actions',
  target: 'chat',
  match: (event) => (
    event.type === 'user/message'
    && event.surfaceOp === 'append'
    && event.data.source?.kind === 'user'
      ? { id: String(event.data.id), role: 'start' }
      : null
  ),
  start: (_context, match) => {
    const event = match.event
    return {
      seq: event.seq,
      time: event.time,
      messageId: String(event.data.id),
      content: event.data.content,
    }
  },
  update: (context) => context.state,
  buildViewNode: (context) => {
    if (context.state === undefined) return null
    return chatNodeLike(context, 'user-actions', context.state.seq, context.state)
  },
}

/**
 * The "original input" reference block for an edit re-send. Anchored just
 * before the message (`seq - 0.5`) so it renders directly ABOVE the new
 * input; the action buttons stay below the bubble in `user-actions`.
 */
const userReferenceDefinition = {
  kind: 'retrace-reference',
  target: 'chat',
  match: (event) => (
    event.type === 'user/message'
    && event.surfaceOp === 'append'
    && event.data.source?.kind === 'user'
      ? { id: `ref:${String(event.data.id)}`, role: 'start' }
      : null
  ),
  start: (_context, match) => {
    const event = match.event
    return {
      seq: event.seq,
      time: event.time,
      messageId: String(event.data.id),
      content: event.data.content,
    }
  },
  update: (context) => context.state,
  buildViewNode: (context) => {
    if (context.state === undefined) return null
    return chatNodeLike(context, 'retrace-reference', context.state.seq - 0.5, context.state)
  },
}

function markerOpFromId(id) {
  if (id.startsWith(`${MARKER_PREFIX}-recall-`)) return 'recall'
  if (id.startsWith(`${MARKER_PREFIX}-edit-`)) return 'edit'
  if (id.startsWith(`${MARKER_PREFIX}-regenerate-`)) return 'regenerate'
  return 'edit'
}

/**
 * The recall/edit/regenerate marker node. Renders a notice row and injects CSS
 * that hides every shadowed message row (they stay in the durable log as an
 * audit trail but disappear from the flow, so view and model context agree).
 */
const recallMarkerDefinition = {
  kind: 'recall-marker',
  target: 'chat',
  match: (event) => {
    if (event.type !== 'assistant/message' || !isReplacementSurfaceEvent(event)) return null
    const id = event.data?.message?.id
    if (typeof id !== 'string' || !id.startsWith(`${MARKER_PREFIX}-`)) return null
    return { id: `marker:${id}`, role: 'start' }
  },
  start: (_context, match) => {
    const event = match.event
    return {
      seq: event.seq,
      time: event.time,
      op: markerOpFromId(String(event.data.message.id)),
      shadowedSeqs: Array.isArray(event.sourceEventSeqs) ? event.sourceEventSeqs.slice() : [],
      targetSeq: event.data?.editor?.targetSeq,
      text: event.data?.editor?.text,
    }
  },
  update: (context) => context.state,
  buildViewNode: (context) => {
    if (context.state === undefined) return null
    return chatNodeLike(context, 'recall-marker', context.state.seq, context.state)
  },
}

// ---------------------------------------------------------------------------
// Shared selector helpers
// ---------------------------------------------------------------------------
function textOf(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/** The durable seq of the finalized assistant message with `messageId`. */
function useMessageSeq(useSession, messageId) {
  return useSession((snapshot) => {
    for (const node of snapshot.chat.nodes.values()) {
      if (node.kind === 'assistant-step' && node.data?.finalNode?.messageId === messageId) {
        return node.data.finalNode.seq
      }
    }
    return undefined
  })
}

/** True when `seq` was shadowed by any recall/edit/regenerate marker. */
function useShadowed(useSession, seq) {
  return useSession((snapshot) => {
    if (seq === undefined || seq === null) return false
    for (const node of snapshot.chat.nodes.values()) {
      if (node.kind === 'recall-marker' && Array.isArray(node.data?.shadowedSeqs)
        && node.data.shadowedSeqs.includes(seq)) {
        return true
      }
    }
    return false
  })
}

/**
 * Every chat-node key that should disappear when `shadowedSeqs` are recalled:
 * the shadowed message rows themselves, plus the per-turn action row (copy /
 * feedback / branch) when its finalized assistant reply is among them.
 */
function useHiddenKeys(useSession, shadowedSeqs) {
  return useSession((snapshot) => {
    if (!Array.isArray(shadowedSeqs) || shadowedSeqs.length === 0) return null
    const hidden = new Set(shadowedSeqs)
    const keys = []
    for (const node of snapshot.chat.nodes.values()) {
      if (node.kind === 'recall-marker') continue
      if (node.kind === 'turn-tail') {
        // `closing` is the finalized assistant-step *data*; the message seq
        // lives on its `finalNode` (matching how the app reads `closing.finalNode.seq`).
        const closingSeq = node.data?.closing?.finalNode?.seq
        if (typeof closingSeq === 'number' && hidden.has(closingSeq)) keys.push(node.key)
        continue
      }
      if (node.kind === 'tool-call') {
        // Tool rows anchor at the tool/call event seq, which is a log-only
        // event and never a surface node, so it cannot appear in shadowedSeqs.
        // Match the settled result's surface seq (root.seq) instead.
        const resultSeq = node.data?.root?.seq
        if (typeof resultSeq === 'number' && hidden.has(resultSeq)) keys.push(node.key)
        continue
      }
      if (typeof node.anchorSeq === 'number' && hidden.has(node.anchorSeq)) keys.push(node.key)
    }
    return keys.length === 0 ? null : keys
  })
}

/** The marker notice disappears once the user keeps typing after the rewind. */
function useMarkerDismissed(useSession, markerSeq, op) {
  return useSession((snapshot) => {
    if (typeof markerSeq !== 'number') return false
    let after = 0
    for (const node of snapshot.chat.nodes.values()) {
      if (node.kind === 'user-actions' && typeof node.data?.seq === 'number' && node.data.seq > markerSeq) {
        after += 1
      }
    }
    // The edit marker's own re-send message follows it automatically; the notice
    // stays until the user sends ANOTHER message after the edit.
    return op === 'edit' ? after >= 2 : after >= 1
  })
}

/**
 * For one user message, the original text of the edit that produced it: the
 * nearest preceding edit marker with no other user message in between (i.e.
 * this message is the automatic re-send after an edit).
 */
function useEditReference(useSession, mySeq) {
  return useSession((snapshot) => {
    if (typeof mySeq !== 'number') return null
    let latestMarkerSeq = -1
    let referenceText = null
    let prevUserSeq = -1
    for (const node of snapshot.chat.nodes.values()) {
      if (node.kind === 'recall-marker' && node.data?.op === 'edit' && typeof node.data.seq === 'number'
        && node.data.seq < mySeq && node.data.seq > latestMarkerSeq) {
        latestMarkerSeq = node.data.seq
        referenceText = typeof node.data.text === 'string' && node.data.text.length > 0 ? node.data.text : null
      }
      if (node.kind === 'user-actions' && typeof node.data?.seq === 'number'
        && node.data.seq < mySeq && node.data.seq > prevUserSeq) {
        prevUserSeq = node.data.seq
      }
    }
    if (latestMarkerSeq === -1 || referenceText === null) return null
    if (prevUserSeq > latestMarkerSeq) return null
    return referenceText
  })
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/** 撤回 / 重新生成 strip inside a finalized assistant reply's IconActions row. */
function AssistantActions({ messageId, sessionId, useSession, t }) {
  const seq = useMessageSeq(useSession, messageId)
  const shadowed = useShadowed(useSession, seq)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState(null)
  if (shadowed || seq === undefined) return null

  const run = (op) => {
    setBusy(true)
    setFailure(null)
    callOp(op, { sessionId, messageId }).then(
      (result) => {
        setBusy(false)
        if (!result || result.ok !== true) {
          const message = result?.error?.message || 'Operation failed; please try again'
          const code = result?.error?.code
          setFailure(code === 'agent-busy' ? t('error.busy') : message)
        }
      },
      (error) => {
        setBusy(false)
        setFailure(error?.message ?? t('error.generic'))
      },
    )
  }

  return createElement('span', { className: 'dsh-rt-strip' }, [
    createElement('button', {
      key: 'recall',
      type: 'button',
      className: 'dsh-rt-icon',
      title: t('action.recallAssistant'),
      'aria-label': t('action.recallAssistant'),
      disabled: busy,
      onClick: () => run('recall'),
    }, '↩'),
    createElement('button', {
      key: 'regenerate',
      type: 'button',
      className: 'dsh-rt-icon',
      title: t('action.regenerate'),
      'aria-label': t('action.regenerate'),
      disabled: busy,
      onClick: () => run('regenerate'),
    }, '↻'),
    failure !== null && createElement('span', { key: 'error', className: 'dsh-rt-error', role: 'status' }, failure),
  ])
}

/** 原输入 reference block, rendered just above the re-sent message. */
function ReferenceRow({ node, useSession, t }) {
  const { seq, messageId } = node.data
  const shadowed = useShadowed(useSession, seq)
  const markerRef = useEditReference(useSession, seq)
  const referenceText = editReferences.get(messageId) ?? markerRef
  const config = useConfig()
  if (shadowed) return null
  if (referenceText === null || !config.showOriginalInput) return null
  return createElement('div', { className: 'dsh-rt-user-row' }, [
    createElement('details', { className: 'dsh-rt-reference' }, [
      createElement('summary', { title: t('marker.referenceHint') },
        `${t('marker.originalLabel')}：${referenceText.length > 60 ? `${referenceText.slice(0, 60)}…` : referenceText}`),
      createElement('div', { className: 'dsh-rt-reference-text' }, referenceText),
    ]),
  ])
}

/** 编辑 / 撤回 action row under one user message; recall echoes into the composer. */
function UserActionsRow({ node, sessionId, useSession, inputActions, t }) {
  const { seq, messageId, content } = node.data
  const shadowed = useShadowed(useSession, seq)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState(null)
  if (shadowed) return null

  const openEditor = () => {
    setDraft(textOf(content))
    setFailure(null)
    setEditing(true)
  }
  const closeEditor = () => {
    setEditing(false)
    setFailure(null)
  }
  const settle = (result, op) => {
    setBusy(false)
    if (!result || result.ok !== true) {
      const code = result?.error?.code
      setFailure(code === 'agent-busy' ? t('error.busy') : (result?.error?.message ?? t('error.generic')))
      return
    }
    if (op === 'recall') {
      const echoed = typeof result.value?.text === 'string' && result.value.text.length > 0
        ? result.value.text
        : textOf(content)
      if (echoed && inputActions && typeof inputActions.setDraft === 'function') {
        inputActions.setDraft(echoed)
      }
      return
    }
    if (op === 'editAndResend') {
      if (result.value?.resendMessageId && typeof result.value?.originalText === 'string') {
        editReferences.set(result.value.resendMessageId, result.value.originalText)
      }
      setEditing(false)
    }
  }
  const run = (op, extra = {}) => {
    setBusy(true)
    setFailure(null)
    callOp(op, { sessionId, messageId, ...extra }).then(
      (result) => settle(result, op),
      (error) => {
        setBusy(false)
        setFailure(error?.message ?? t('error.generic'))
      },
    )
  }

  return createElement('div', { className: 'dsh-rt-user-row' }, [
    editing
      ? createElement('div', { key: 'editor', className: 'dsh-rt-editor' }, [
        createElement('textarea', {
          key: 'input',
          className: 'dsh-rt-textarea',
          'aria-label': t('action.editAria'),
          value: draft,
          rows: 3,
          onChange: (event) => setDraft(event.target.value),
        }),
        createElement('div', { key: 'buttons', className: 'dsh-rt-editor-buttons' }, [
          createElement('button', {
            key: 'send',
            type: 'button',
            className: 'dsh-rt-editor-send',
            disabled: busy || draft.trim().length === 0,
            onClick: () => run('editAndResend', {
              text: draft.trim(),
              fromScratch: getConfig().editFromScratch,
            }),
          }, t('action.send')),
          createElement('button', {
            key: 'cancel',
            type: 'button',
            className: 'dsh-rt-editor-cancel',
            disabled: busy,
            onClick: closeEditor,
          }, t('action.cancel')),
        ]),
      ])
      : createElement('span', { key: 'row', className: 'dsh-rt-user-actions' }, [
        createElement('button', {
          key: 'edit',
          type: 'button',
          className: 'dsh-rt-chip',
          title: t('action.edit'),
          disabled: busy,
          onClick: openEditor,
        }, t('action.edit')),
        createElement('button', {
          key: 'recall',
          type: 'button',
          className: 'dsh-rt-chip',
          title: t('action.recallUser'),
          disabled: busy,
          onClick: () => run('recall'),
        }, t('action.recall')),
      ]),
    failure !== null && createElement('div', { key: 'error', className: 'dsh-rt-error', role: 'status' }, failure),
  ])
}

/** The transient notice row: hides shadowed content, dismissed after the user keeps typing. */
function RecallMarkerRow({ node, useSession, t }) {
  const { seq, op, shadowedSeqs } = node.data
  const dismissed = useMarkerDismissed(useSession, seq, op)
  const hiddenKeys = useHiddenKeys(useSession, shadowedSeqs)

  // The hide rules must stay mounted even after the notice is dismissed,
  // otherwise the recalled message would reappear.
  const css = hiddenKeys === null
    ? null
    : hiddenKeys.map((key) => `[data-chat-anchor-key=${JSON.stringify(key)}]{display:none!important}`).join('')
  const count = Array.isArray(shadowedSeqs) ? shadowedSeqs.length : 0
  const label = op === 'recall'
    ? (count > 1 ? t('marker.recallMany', { count }) : t('marker.recallOne'))
    : op === 'regenerate' ? t('marker.regenerate') : t('marker.edit')

  return createElement('div', { className: 'dsh-rt-marker-block', 'data-dismissed': dismissed || undefined }, [
    css !== null && createElement('style', { key: 'hide', dangerouslySetInnerHTML: { __html: css } }),
    !dismissed && createElement('div', { key: 'label', className: 'dsh-rt-marker', role: 'status' }, label),
  ])
}

/** Settings → General: the plugin's two preference toggles. */
function OptionsRow({ t }) {
  const config = useConfig()
  const toggle = (key) => (event) => setConfig({ [key]: event.target.checked })
  const optionRow = (key, labelKey, descKey) => createElement('label', { key, className: 'dsh-rt-option' }, [
    createElement('input', { type: 'checkbox', checked: config[key], onChange: toggle(key) }),
    createElement('span', { className: 'dsh-rt-option-text' }, [
      createElement('span', { className: 'dsh-rt-option-label' }, t(labelKey)),
      createElement('span', { className: 'dsh-rt-option-desc' }, t(descKey)),
    ]),
  ])
  return createElement('div', { className: 'dsh-rt-options' }, [
    createElement('div', { key: 'title', className: 'dsh-rt-options-title' }, t('options.title')),
    createElement('label', { key: 'original', className: 'dsh-rt-option' }, [
      createElement('input', {
        type: 'checkbox',
        checked: config.showOriginalInput,
        onChange: toggle('showOriginalInput'),
      }),
      createElement('span', null, t('options.showOriginalInput')),
    ]),
    createElement('label', { key: 'fresh', className: 'dsh-rt-option' }, [
      createElement('input', {
        type: 'checkbox',
        checked: config.editFromScratch,
        onChange: toggle('editFromScratch'),
      }),
      createElement('span', null, t('options.editFromScratch')),
    ]),
    optionRow('versioning', 'options.versioning', 'options.versioningDesc'),
    optionRow('git', 'options.git', 'options.gitDesc'),
    createElement('div', { key: 'retention', className: 'dsh-rt-option dsh-rt-option-number' }, [
      createElement('span', { className: 'dsh-rt-option-text' }, [
        createElement('span', { className: 'dsh-rt-option-label' }, t('options.retention')),
        createElement('span', { className: 'dsh-rt-option-desc' }, t('options.retentionDesc')),
      ]),
      createElement('input', {
        type: 'number',
        min: 5,
        max: 500,
        step: 5,
        className: 'dsh-rt-retention-input',
        value: config.retentionLimit,
        onChange: (event) => {
          const value = Math.max(1, Math.min(1000, Number(event.target.value) || 50))
          setConfig({ retentionLimit: value })
        },
      }),
    ]),
  ])
}

// ---------------------------------------------------------------------------
// Styles (plain injected <style>; removed with the plugin)
// ---------------------------------------------------------------------------
const STYLE_ID = 'dsh-retrace-css'
const CSS = `
.dsh-rt-strip{display:inline-flex;align-items:center;gap:2px}
.dsh-rt-icon{width:28px;height:28px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:transparent;border:none;border-radius:28px;display:inline-flex;justify-content:center;align-items:center;padding:0;font-size:14px;line-height:1}
.dsh-rt-icon:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dsh-rt-icon:disabled{opacity:.4;cursor:default}
.dsh-rt-user-row{display:flex;flex-direction:column;align-items:flex-end;gap:4px;margin-top:2px}
.dsh-rt-user-actions{display:inline-flex;gap:6px}
.dsh-rt-chip{color:var(--dsw-alias-label-tertiary);cursor:pointer;background:var(--dsw-alias-interactive-bg-hover);border:none;border-radius:12px;padding:2px 10px;font-size:12px;line-height:20px}
.dsh-rt-chip:hover:not(:disabled){color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover-solid)}
.dsh-rt-chip:disabled{opacity:.5;cursor:default}
.dsh-rt-editor{display:flex;flex-direction:column;gap:6px;width:min(525px,82%);border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);border-radius:12px;padding:8px}
.dsh-rt-textarea{resize:vertical;width:100%;box-sizing:border-box;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-elevated);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;outline:none;padding:8px 10px;font:inherit;font-size:14px;line-height:20px}
.dsh-rt-textarea:focus{box-shadow:0 0 0 2px var(--dsw-alias-state-business-primary)}
.dsh-rt-editor-buttons{display:flex;justify-content:flex-end;gap:8px}
.dsh-rt-editor-send{color:#fff;cursor:pointer;background:var(--dsw-alias-button-info-fill);border:none;border-radius:999px;padding:4px 16px;font-size:13px;line-height:20px}
.dsh-rt-editor-send:hover:not(:disabled){background:var(--dsw-alias-button-info-hover)}
.dsh-rt-editor-send:disabled{opacity:.4;cursor:default}
.dsh-rt-editor-cancel{color:var(--dsw-alias-label-secondary);cursor:pointer;background:transparent;border:none;border-radius:999px;padding:4px 12px;font-size:13px;line-height:20px}
.dsh-rt-editor-cancel:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsh-rt-error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;max-width:min(525px,82%)}
.dsh-rt-marker-block{display:flex;flex-direction:column;align-items:center;gap:4px;width:100%;max-width:var(--dsh-chat-content-width);box-sizing:border-box;margin:0 auto;padding:2px 0}
.dsh-rt-marker{text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px}
.dsh-rt-reference{width:min(525px,82%);box-sizing:border-box;border:1px dashed var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-elevated);border-radius:10px;padding:2px 12px}
.dsh-rt-reference summary{color:var(--dsw-alias-label-caption);cursor:pointer;user-select:none;font-size:12px;line-height:22px;list-style:none;display:inline-flex;align-items:center;gap:6px;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-rt-reference summary::-webkit-details-marker{display:none}
.dsh-rt-reference summary:before{content:"▸";transition:transform .12s;font-size:10px}
.dsh-rt-reference[open] summary:before{transform:rotate(90deg)}
.dsh-rt-reference summary:hover{color:var(--dsw-alias-label-secondary)}
.dsh-rt-reference-text{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;white-space:pre-wrap;overflow-wrap:anywhere;padding:2px 0 6px}
.dsh-rt-options{display:flex;flex-direction:column;gap:8px;padding:2px 0}
.dsh-rt-options-title{color:var(--dsw-alias-label-secondary);font-size:13px;font-weight:600;line-height:20px}
.dsh-rt-option{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;cursor:pointer}
.dsh-rt-option-text{display:flex;flex-direction:column;gap:1px;min-width:0}
.dsh-rt-option-label{color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
.dsh-rt-option-desc{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:17px}
.dsh-rt-option-number{align-items:flex-start}
.dsh-rt-retention-input{width:64px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-elevated);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:2px 6px;font:inherit;font-size:13px;outline:none;margin-top:1px}
.dsh-rt-retention-input:focus{box-shadow:0 0 0 2px var(--dsw-alias-state-business-primary)}
.dsh-rt-option input{accent-color:var(--dsw-alias-state-business-primary)}
`

function ensureStyle() {
  if (typeof document === 'undefined') return () => {}
  if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`)) return () => {}
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-retrace'
  tag.dataset.pluginCss = STYLE_ID
  tag.textContent = CSS
  document.head.appendChild(tag)
  return () => {
    tag.remove()
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------
export function apply(ctx) {
  const disposeStyle = ensureStyle()
  ctx.effect(() => () => disposeStyle(), 'dsh-retrace: styles')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-retrace: dictionaries')

  const conversationEvents = ctx.get('conversationEvents')
  if (conversationEvents) {
    conversationEvents.register(userActionsDefinition)
    conversationEvents.register(userReferenceDefinition)
    conversationEvents.register(recallMarkerDefinition)
  }

  ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
    name: 'conversation.chat.assistant-actions',
    id: 'retrace',
    order: 20,
    locale: NS,
  }, AssistantActions))

  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'user-actions',
    locale: NS,
  }, UserActionsRow))

  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'retrace-reference',
    locale: NS,
  }, ReferenceRow))

  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'recall-marker',
    locale: NS,
  }, RecallMarkerRow))

  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'retrace',
    order: 30,
    locale: NS,
  }, OptionsRow))
}
