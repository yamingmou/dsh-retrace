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
/**
 * Every marker-id prefix this build can recognise. `MARKER_PREFIX` is the
 * prefix NEW markers are written with; the rest are LEGACY prefixes produced
 * by earlier plugin names (dsh-message-editor). RENAME RULE: when the plugin
 * changes its identity again, keep the old prefix in this list (and in
 * LEGACY_MARKER_PREFIXES) so markers written under the previous name keep
 * rendering — recognition must never be broken by a rename.
 */
const MARKER_PREFIXES = [MARKER_PREFIX, 'message-editor']
/**
 * Legacy prefixes whose markers are treated as annotations only: the notice
 * and the "original input" reference render, but their shadowed ranges are
 * NEVER hidden. Rationale: a marker written by an older plugin name may not
 * match this build's edit semantics; hiding content based on it would
 * silently re-hide conversations the user already sees. Renames must ADD the
 * retired prefix here (soft-compat: renamed-era markers become annotations,
 * so a rename can never hide previously visible content).
 */
const LEGACY_MARKER_PREFIXES = ['message-editor']
/** Recognise any marker id this build can interpret, current or legacy. */
function isMarkerId(id) {
  return typeof id === 'string' && MARKER_PREFIXES.some((p) => id.startsWith(`${p}-`))
}
/** Whether a marker id was written under a legacy (renamed-away) prefix. */
function isLegacyMarkerId(id) {
  return typeof id === 'string' && LEGACY_MARKER_PREFIXES.some((p) => id.startsWith(`${p}-`))
}
const CONFIG_KEY = 'dsh-retrace:config'
/** Config keys of renamed-away plugin names, read as a fallback on first load. */
const LEGACY_CONFIG_KEYS = ['dsh-message-editor:config']

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
  'options.hideShadowed': '按标记隐藏被编辑/撤回的消息',
  'options.hideShadowedDesc': '开：撤回/编辑/重新生成按标记隐藏被替换的消息（默认）。关：所有消息保持可见，标记仅显示提示与对照（查看完整历史用）。',
  'options.versioning': '版本与产物快照',
  'options.versioningDesc': '开：每次撤回/编辑记录一个版本（消息与触碰文件），提供时间线与产物回退；关：仅回退上下文，不记录版本、不追踪产物（最省资源）。',
  'options.git': '启用 git 集成',
  'options.gitDesc': '开：工作区是 git 仓库时用 git 记录与回退（不自动提交、不动你的分支），非仓库可在时间线里一键启用；关：一律用内置快照（存于 ~/.dsh），不触碰工作区 git 状态，功能等价。',
  'options.retention': '版本保留上限',
  'options.retentionDesc': '文件快照只保留最近 N 个版本，超出自动清理最旧的；时间线记录与审计痕迹始终保留。',
  'timeline.open': '时间线',
  'timeline.openAria': '打开会话时间线',
  'timeline.title': '版本时间线',
  'timeline.refresh': '刷新',
  'timeline.close': '关闭',
  'timeline.empty': '还没有版本。撤回 / 编辑 / 重新生成会在此记录版本。',
  'timeline.loading': '加载中…',
  'timeline.error': '时间线加载失败',
  'timeline.kind.recall': '撤回',
  'timeline.kind.edit': '编辑重发',
  'timeline.kind.regenerate': '重新生成',
  'timeline.kind.restore': '恢复',
  'timeline.kind.compaction': '压缩',
  'timeline.kind.replace': '替换',
  'timeline.messages': '{count} 条消息',
  'timeline.files': '{created} 增 / {modified} 改 / {deleted} 删',
  'timeline.filesNone': '无文件变更',
  'timeline.preview': '回退预览',
  'timeline.previewDesc': '将回退到版本 {version}（{kind}）。',
  'timeline.contextOnly': '仅对话',
  'timeline.contextOnlyDesc': '移除该版本之后的消息（保留日志审计痕迹）',
  'timeline.artifactsOnly': '仅产物',
  'timeline.artifactsOnlyDesc': '把该版本触碰的文件恢复到当时的內容',
  'timeline.both': '两者',
  'timeline.bothDesc': '先回退对话，再回退产物',
  'timeline.messagesRemoved': '将移除 {count} 条消息',
  'timeline.noChanges': '当前已在该版本状态，无变化',
  'timeline.artifactsList': '产物动作（{count}）',
  'timeline.artifact.restore': '恢复',
  'timeline.artifact.delete': '删除',
  'timeline.artifact.skip': '跳过',
  'timeline.confirm': '确认回退',
  'timeline.cancel': '取消',
  'timeline.busy': '回退中…',
  'timeline.detail': '详情',
  'timeline.jump': '跳转',
  'timeline.jumpFailed': '该版本在较远的过去（超出自动加载预算），无法直接定位。请向上滚动加载更早消息后重试；或用「详情」查看该版本当时的事件原文。',
  'timeline.gitRepo': 'git 仓库',
  'timeline.gitHead': 'HEAD {hash}',
  'timeline.gitDirty': '工作区有未提交改动',
  'timeline.gitInit': '启用 git 版本管理',
  'timeline.gitInitDesc': '在工作区执行 git init（仅添加 .gitignore 与一个基线提交），版本回退将优先使用 git。',
  'timeline.gitInitConfirm': '确定要初始化 git 吗？',
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
  'options.hideShadowed': 'Hide shadowed messages per marker',
  'options.hideShadowedDesc': 'On: recall/edit/regenerate hide the replaced messages per their markers (default). Off: every message stays visible; markers only show the notice and reference (use to review full history).',
  'options.versioning': 'Version & artifact snapshots',
  'options.versioningDesc': 'On: every recall/edit records a version (messages and touched files) powering the timeline and artifact rollback. Off: only rewinds context — no version records, no artifact tracking (lightest).',
  'options.git': 'Git integration',
  'options.gitDesc': 'On: uses git to record and roll back when the workspace is a repository (never auto-commits, never touches your branches); non-repo workspaces can enable git from the timeline. Off: built-in snapshots under ~/.dsh only — the plugin never touches the workspace git state; equivalent features.',
  'options.retention': 'Version retention limit',
  'options.retentionDesc': 'File snapshots are kept for the most recent N versions; older ones are pruned automatically (timeline records and the audit trail are always kept).',
  'timeline.open': 'Timeline',
  'timeline.openAria': 'Open the session timeline',
  'timeline.title': 'Version timeline',
  'timeline.refresh': 'Refresh',
  'timeline.close': 'Close',
  'timeline.empty': 'No versions yet. Recall / edit / regenerate record a version here.',
  'timeline.loading': 'Loading…',
  'timeline.error': 'Failed to load the timeline',
  'timeline.kind.recall': 'Recall',
  'timeline.kind.edit': 'Edit & resend',
  'timeline.kind.regenerate': 'Regenerate',
  'timeline.kind.restore': 'Restore',
  'timeline.kind.compaction': 'Compaction',
  'timeline.kind.replace': 'Replace',
  'timeline.messages': '{count} messages',
  'timeline.files': '{created} created / {modified} modified / {deleted} deleted',
  'timeline.filesNone': 'No file changes',
  'timeline.preview': 'Rollback preview',
  'timeline.previewDesc': 'Will roll back to version {version} ({kind}).',
  'timeline.contextOnly': 'Context only',
  'timeline.contextOnlyDesc': 'Remove messages after this version (the log audit trail stays)',
  'timeline.artifactsOnly': 'Artifacts only',
  'timeline.artifactsOnlyDesc': 'Restore the files this version touched to their state at that version',
  'timeline.both': 'Both',
  'timeline.bothDesc': 'Roll back the context first, then the artifacts',
  'timeline.messagesRemoved': '{count} messages will be removed',
  'timeline.noChanges': 'Already at this version; nothing to change',
  'timeline.artifactsList': 'Artifact actions ({count})',
  'timeline.artifact.restore': 'restore',
  'timeline.artifact.delete': 'delete',
  'timeline.artifact.skip': 'skip',
  'timeline.confirm': 'Confirm rollback',
  'timeline.cancel': 'Cancel',
  'timeline.busy': 'Rolling back…',
  'timeline.detail': 'Details',
  'timeline.jump': 'Jump',
  'timeline.jumpFailed': 'This version lies too far back (beyond the auto-load budget) to locate directly. Scroll up to load earlier messages, or use Details to read the original event text of this version.',
  'timeline.gitRepo': 'git repository',
  'timeline.gitHead': 'HEAD {hash}',
  'timeline.gitDirty': 'working tree has uncommitted changes',
  'timeline.gitInit': 'Enable git versioning',
  'timeline.gitInitDesc': 'Runs git init in the workspace (adds a minimal .gitignore and a baseline commit); rollback will prefer git.',
  'timeline.gitInitConfirm': 'Initialize git in this workspace?',
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
const CONFIG_DEFAULTS = { showOriginalInput: true, editFromScratch: true, hideShadowed: true, versioning: true, git: true, retentionLimit: 50 }
const configListeners = new Set()
let configCache = readConfig()

/** resendMessageId -> the exact text that edit replaced (most recent, host-authoritative). */
const editReferences = new Map()

function readConfig() {
  try {
    const raw = localStorage.getItem(CONFIG_KEY)
    if (raw !== null) return { ...CONFIG_DEFAULTS, ...(raw ? JSON.parse(raw) : {}) }
    // Rename-safe fallback: pick up settings saved under a previous plugin name.
    for (const legacyKey of LEGACY_CONFIG_KEYS) {
      const legacyRaw = localStorage.getItem(legacyKey)
      if (legacyRaw !== null) {
        const migrated = { ...CONFIG_DEFAULTS, ...(legacyRaw ? JSON.parse(legacyRaw) : {}) }
        try { localStorage.setItem(CONFIG_KEY, JSON.stringify(migrated)) } catch { /* storage unavailable */ }
        return migrated
      }
    }
    return { ...CONFIG_DEFAULTS }
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
  for (const p of MARKER_PREFIXES) {
    if (id.startsWith(`${p}-recall-`)) return 'recall'
    if (id.startsWith(`${p}-edit-`)) return 'edit'
    if (id.startsWith(`${p}-regenerate-`)) return 'regenerate'
  }
  return 'edit'
}

/**
 * The recall/edit/regenerate marker node. Renders a notice row and injects CSS
 * that hides every shadowed message row (they stay in the durable log as an
 * audit trail but disappear from the flow, so view and model context agree).
 * Legacy-prefix markers (written under a renamed-away plugin name) render as
 * annotations only: their shadowed ranges are never hidden, so a rename can
 * never make previously visible content disappear.
 */
const recallMarkerDefinition = {
  kind: 'recall-marker',
  target: 'chat',
  match: (event) => {
    if (event.type !== 'assistant/message' || !isReplacementSurfaceEvent(event)) return null
    const id = event.data?.message?.id
    if (!isMarkerId(id)) return null
    return { id: `marker:${id}`, role: 'start' }
  },
  start: (_context, match) => {
    const event = match.event
    const id = String(event.data.message.id)
    const legacy = isLegacyMarkerId(id)
    return {
      seq: event.seq,
      time: event.time,
      op: markerOpFromId(id),
      legacy,
      // Legacy markers never hide: treat their shadowed range as empty so the
      // notice/reference render but no row is hidden and no action row is
      // suppressed via useShadowed.
      shadowedSeqs: legacy ? [] : (Array.isArray(event.sourceEventSeqs) ? event.sourceEventSeqs.slice() : []),
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
  const { seq, op, shadowedSeqs, legacy } = node.data
  const dismissed = useMarkerDismissed(useSession, seq, op)
  const hiddenKeys = legacy || !getConfig().hideShadowed ? null : useHiddenKeys(useSession, shadowedSeqs)

  // The hide rules must stay mounted even after the notice is dismissed,
  // otherwise the recalled message would reappear. Legacy markers and the
  // `hideShadowed: off` preference never inject hide rules.
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
    optionRow('hideShadowed', 'options.hideShadowed', 'options.hideShadowedDesc'),
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
/* ---- P1 timeline ---- */
.dsh-rt-timeline{position:relative}
.dsh-rt-timeline-trigger{min-height:28px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:transparent;border:none;border-radius:6px;display:inline-flex;align-items:center;gap:4px;padding:3px 6px;font-size:12px;line-height:18px}
.dsh-rt-timeline-trigger:hover,.dsh-rt-timeline-trigger:focus-visible{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover)}
.dsh-rt-timeline-icon{font-size:13px}
.dsh-rt-timeline-panel{position:fixed;top:calc(100% + 6px);right:8px;z-index:2147483000;width:min(520px,calc(100vw - 32px));max-height:min(70vh,640px);box-sizing:border-box;display:flex;flex-direction:column;gap:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-specific-menu);box-shadow:var(--dsw-shadow-lv3);border-radius:12px;padding:8px;overflow:hidden}
.dsh-rt-timeline-head{display:flex;align-items:center;gap:8px;flex:none}
.dsh-rt-timeline-title{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;line-height:20px;flex:1}
.dsh-rt-timeline-git{display:flex;align-items:center;gap:6px;flex:none;border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;padding:4px 8px}
.dsh-rt-timeline-git-text{color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px}
.dsh-rt-timeline-list{overflow-y:auto;flex:none;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2)}
.dsh-rt-timeline-empty{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;padding:12px 4px;text-align:center}
.dsh-rt-version{position:absolute;left:0;right:0;height:60px;box-sizing:border-box;display:flex;align-items:flex-start;gap:8px;border:1px solid transparent;border-radius:10px;padding:6px 8px}
.dsh-rt-version:hover{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l2)}
.dsh-rt-version-kind{flex:none;width:22px;height:22px;display:inline-flex;justify-content:center;align-items:center;border-radius:6px;background:var(--dsw-alias-fill-l2);color:var(--dsw-alias-label-secondary);font-size:12px;margin-top:1px}
.dsh-rt-version-kind-restore{background:var(--dsw-alias-state-success-bg);color:var(--dsw-alias-state-success-primary)}
.dsh-rt-version-kind-compaction{background:var(--dsw-alias-fill-l2);color:var(--dsw-alias-label-caption)}
.dsh-rt-version-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.dsh-rt-version-line{display:flex;align-items:center;gap:8px;min-width:0;white-space:nowrap}
.dsh-rt-version-kind-label{color:var(--dsw-alias-label-primary);font-size:12px;font-weight:600;line-height:16px}
.dsh-rt-version-time,.dsh-rt-version-msgs{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.dsh-rt-version-files{color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px;overflow:hidden;text-overflow:ellipsis}
.dsh-rt-version-text{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-rt-version-actions{flex:none;display:inline-flex;gap:4px;opacity:0;transition:opacity .1s}
.dsh-rt-version:hover .dsh-rt-version-actions{opacity:1}
.dsh-rt-chip-danger{color:var(--dsw-alias-state-error-primary)}
.dsh-rt-chip-danger:hover{color:var(--dsw-alias-state-error-primary)}
.dsh-rt-modal{position:absolute;inset:0;z-index:130;display:flex;flex-direction:column;gap:8px;box-sizing:border-box;border-radius:12px;background:var(--dsw-specific-menu);padding:10px;box-shadow:var(--dsw-shadow-lv3)}
.dsh-rt-modal-title{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;line-height:20px}
.dsh-rt-modal-sub{color:var(--dsw-alias-label-tertiary);font-size:11px;font-weight:400}
.dsh-rt-modal-body{display:flex;flex-direction:column;gap:6px;overflow-y:auto;min-height:0}
.dsh-rt-modal-line{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dsh-rt-modal-files{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px;max-height:160px;overflow-y:auto}
.dsh-rt-modal-files li{display:flex;gap:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dsh-rt-art-restore{color:var(--dsw-alias-state-success-primary);flex:none}
.dsh-rt-art-delete{color:var(--dsw-alias-state-error-primary);flex:none}
.dsh-rt-art-skip{color:var(--dsw-alias-label-caption);flex:none}
.dsh-rt-art-path{font-family:var(--dsw-font-mono);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-rt-modal-scope{display:flex;flex-direction:column;gap:4px}
.dsh-rt-modal-buttons{display:flex;justify-content:flex-end;gap:8px;flex:none}
.dsh-rt-confirm{background:var(--dsw-alias-state-error-primary)}
.dsh-rt-modal-json{margin:0;overflow:auto;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-elevated);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px;font-family:var(--dsw-font-mono);font-size:11px;line-height:15px;white-space:pre-wrap;word-break:break-all}
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
// P1 — Version timeline (header action + floating panel)
// ---------------------------------------------------------------------------
// Data sources, per PLAN.md §5.1: the live `session/projection` push frames
// arrive through the `useProjection` standard kit when present (zero polling);
// the HTTP `/versions` route is the fallback (opened on demand + manual
// refresh). Detail reads are lazy `GET /event`; rollback runs
// `POST /rollback/preview` → confirm → `POST /rollback`; the git banner uses
// `GET /git/status` and `POST /git/init`. The list window is a zero-dependency
// fixed-row virtualizer (uniform rows) — @tanstack/react-virtual was evaluated
// but bundling it (~15 KiB) for a list this size is not worth it.

const KIND_ICONS = { recall: '↩', edit: '✎', regenerate: '↻', restore: '⟲', compaction: '▤', replace: '⇄' }

function kindLabel(kind, t) {
  return t(`timeline.kind.${kind}`) || kind
}

function timeLabel(ms) {
  const date = new Date(ms)
  return `${date.getMonth() + 1}-${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function timelineGet(path) {
  return fetch(`${ROUTE_BASE}${path}`, { headers: retraceConfigHeaders() }).then((res) => {
    if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`)
    return res.json()
  })
}

/** Format a file-count badge. */
function fileCountLabel(counts, t) {
  const total = (counts?.created ?? 0) + (counts?.modified ?? 0) + (counts?.deleted ?? 0)
  if (total === 0) return t('timeline.filesNone')
  return t('timeline.files', {
    created: counts.created ?? 0,
    modified: counts.modified ?? 0,
    deleted: counts.deleted ?? 0,
  })
}

/**
 * The header action + floating timeline panel (PLAN §5.1). Rendered inside
 * `conversation.session.header.actions`; the panel is absolutely positioned
 * under the trigger so the chat stays mounted (jump-to-conversation needs it).
 */
function TimelinePanel({ sessionId, useSession, useProjection, useSessions, t, ctx }) {
  const [open, setOpen] = useState(false)
  const [versions, setVersions] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [git, setGit] = useState(null)
  const [gitBusy, setGitBusy] = useState(false)
  const [preview, setPreview] = useState(null)
  const [previewScope, setPreviewScope] = useState('both')
  const [rollbackBusy, setRollbackBusy] = useState(false)
  const [detail, setDetail] = useState(null)
  const [jumpTarget, setJumpTarget] = useState(null)
  const [jumpNotice, setJumpNotice] = useState(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [panelPos, setPanelPos] = useState(null)
  const rootRef = { current: null }
  const triggerRef = { current: null }
  const snapRef = { current: null }

  // Live push-frame path (projection standard kit) — falls back to HTTP.
  const projected = typeof useProjection === 'function' ? useProjection('retrace/versions') : undefined
  useSession((snapshot) => {
    snapRef.current = snapshot
    return snapshot.chat.nodes.size
  })

  useEffect(() => {
    if (projected && Array.isArray(projected.versions)) setVersions(projected.versions)
  }, [projected])

  /** Anchor the panel to the trigger's live viewport rect (fixed positioning). */
  const anchorPanel = () => {
    const rect = triggerRef.current?.getBoundingClientRect?.()
    if (!rect) return
    setPanelPos({
      top: rect.bottom + 6,
      right: Math.max(8, window.innerWidth - rect.right),
    })
  }

  // Re-anchor on open and while open (scroll/resize keep it under the trigger).
  useEffect(() => {
    if (!open) return
    anchorPanel()
    const onViewportChange = () => anchorPanel()
    window.addEventListener('resize', onViewportChange)
    window.addEventListener('scroll', onViewportChange, true)
    return () => {
      window.removeEventListener('resize', onViewportChange)
      window.removeEventListener('scroll', onViewportChange, true)
    }
  }, [open])

  const refresh = () => {
    setLoading(true)
    setError(null)
    timelineGet(`/versions?sessionId=${encodeURIComponent(sessionId)}`)
      .then((result) => {
        if (!result || result.ok !== true) throw new Error(result?.error?.message ?? 'versions failed')
        setVersions(result.value?.versions ?? [])
      })
      .catch((cause) => setError(cause?.message ?? 'timeline error'))
      .finally(() => setLoading(false))
  }

  const refreshGit = () => {
    if (getConfig().git !== true) return
    timelineGet(`/git/status?sessionId=${encodeURIComponent(sessionId)}`)
      .then((result) => setGit(result?.ok === true ? result.value : null))
      .catch(() => setGit(null))
  }

  const toggle = () => {
    const next = !open
    setOpen(next)
    if (next) {
      if (projected === undefined) refresh()
      refreshGit()
    }
  }

  // Dismiss on outside pointer (matching the jobs menu pattern).
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event) => {
      if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  // Jump: page up via the session store until the anchor is loaded, then the
  // reactive effect below scrolls once the node appears. The store has no
  // seek-to-seq API — only `loadOlder` (50/page) — so far-away targets are
  // unreachable without thousands of pages; cap the budget and fall back to a
  // clear notice (details drawer shows the version's event text instead).
  const JUMP_PAGE_BUDGET = 24
  const jump = async (boundarySeq) => {
    setJumpNotice(null)
    setJumpTarget(boundarySeq)
    const binding = ctx?.get?.('sessions')?.binding?.(sessionId)
    const store = binding?.session
    if (!store || typeof store.loadOlder !== 'function') return
    let pages = 0
    while (pages < JUMP_PAGE_BUDGET && store.hasMore) {
      const before = snapRef.current?.chat?.nodes?.size ?? 0
      await store.loadOlder()
      const after = snapRef.current?.chat?.nodes?.size ?? 0
      pages += 1
      if (after === before) break // page returned nothing
    }
    // Budget exhausted without the anchor appearing → tell the user honestly.
    // Give the last prepend a tick to propagate into the snapshot first.
    await new Promise((resolve) => setTimeout(resolve, 60))
    if (!nodePresent(boundarySeq)) {
      setJumpNotice(t('timeline.jumpFailed'))
      setJumpTarget(null)
    }
  }

  /** Whether any loaded chat node anchors at `seq`. */
  function nodePresent(seq) {
    const nodes = snapRef.current?.chat?.nodes
    if (!nodes) return false
    for (const node of nodes.values()) {
      if (typeof node.anchorSeq === 'number' && node.anchorSeq === seq) return true
    }
    return false
  }

  const foundKey = useSession((snapshot) => {
    if (jumpTarget === null) return null
    for (const node of snapshot.chat.nodes.values()) {
      if (typeof node.anchorSeq === 'number' && node.anchorSeq === jumpTarget) return node.key
    }
    return null
  })

  useEffect(() => {
    if (foundKey === null || jumpTarget === null) return
    const el = document.querySelector(`[data-chat-anchor-key=${JSON.stringify(foundKey)}]`)
    if (!el) {
      setJumpNotice(t('timeline.jumpFailed'))
      setJumpTarget(null)
      return
    }
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    const id = `dsh-rt-jump-${foundKey.replace(/[^a-z0-9]/gi, '-')}`
    if (!document.querySelector(`style[data-plugin-css="${id}"]`)) {
      const tag = document.createElement('style')
      tag.dataset.pluginCss = id
      tag.textContent = `[data-chat-anchor-key=${JSON.stringify(foundKey)}]{animation:dsh-rt-flash 1.6s ease-out 2}@keyframes dsh-rt-flash{0%,100%{background:transparent}30%,70%{background:var(--dsw-alias-state-business-primary)}55%{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 30%,transparent)}}`
      document.head.appendChild(tag)
      setTimeout(() => tag.remove(), 3400)
    }
    setJumpTarget(null)
  }, [foundKey, jumpTarget])

  const requestPreview = (record) => {
    setPreviewScope('both')
    setPreview({ versionId: record.versionId, kind: record.kind, boundarySeq: record.boundarySeq, data: null, error: null })
    callOp('rollback/preview', { sessionId, versionId: record.versionId, scope: 'both' }).then((result) => {
      setPreview((prev) => prev && prev.versionId === record.versionId
        ? { ...prev, data: result?.ok === true ? result.value : null, error: result?.ok === true ? null : result?.error?.message ?? null }
        : prev)
    })
  }

  const confirmRollback = () => {
    if (!preview) return
    setRollbackBusy(true)
    callOp('rollback', { sessionId, versionId: preview.versionId, scope: previewScope }).then((result) => {
      setRollbackBusy(false)
      if (!result || result.ok !== true) {
        setPreview((prev) => prev && { ...prev, error: result?.error?.message ?? 'rollback failed' })
        return
      }
      setPreview(null)
      if (projected === undefined) refresh()
      refreshGit()
    })
  }

  const openDetail = (record) => {
    setDetail({ seq: record.boundarySeq, data: null, error: null })
    timelineGet(`/event?sessionId=${encodeURIComponent(sessionId)}&seq=${record.boundarySeq}&before=2&after=2`)
      .then((result) => {
        setDetail((prev) => prev && prev.seq === record.boundarySeq
          ? { ...prev, data: result?.ok === true ? result.value : null, error: result?.ok === true ? null : result?.error?.message ?? null }
          : prev)
      })
  }

  const initGit = () => {
    if (!window.confirm(t('timeline.gitInitConfirm'))) return
    setGitBusy(true)
    callOp('git/init', { sessionId }).then((result) => {
      setGitBusy(false)
      refreshGit()
    })
  }

  // ---- windowed list (uniform rows, zero-dep) ----
  const ROW_H = 64
  const list = versions ?? []
  const visible = list.slice(Math.max(0, Math.floor(scrollTop / ROW_H) - 2), Math.min(list.length, Math.ceil(scrollTop / ROW_H) + Math.ceil(420 / ROW_H) + 2))

  return createElement('div', { className: 'dsh-rt-timeline', ref: rootRef }, [
    createElement('button', {
      key: 'trigger',
      ref: triggerRef,
      type: 'button',
      className: 'dsh-rt-timeline-trigger',
      title: t('timeline.open'),
      'aria-label': t('timeline.openAria'),
      onClick: toggle,
    }, [
      createElement('span', { key: 'i', className: 'dsh-rt-timeline-icon' }, '⧉'),
      createElement('span', { key: 'label', className: 'dsh-rt-timeline-label' }, t('timeline.open')),
    ]),

    open && createElement('div', {
      key: 'panel',
      className: 'dsh-rt-timeline-panel',
      style: panelPos ? { top: `${panelPos.top}px`, right: `${panelPos.right}px` } : undefined,
    }, [
      createElement('div', { key: 'head', className: 'dsh-rt-timeline-head' }, [
        createElement('span', { key: 'title', className: 'dsh-rt-timeline-title' }, t('timeline.title')),
        createElement('button', {
          key: 'refresh',
          type: 'button',
          className: 'dsh-rt-chip',
          onClick: refresh,
        }, t('timeline.refresh')),
        createElement('button', {
          key: 'close',
          type: 'button',
          className: 'dsh-rt-chip',
          onClick: () => setOpen(false),
        }, t('timeline.close')),
      ]),

      git !== null && git !== undefined && createElement('div', { key: 'git', className: 'dsh-rt-timeline-git' }, [
        git.headHash
          ? [
              createElement('span', { key: 'r', className: 'dsh-rt-timeline-git-text' }, `${t('timeline.gitRepo')} · ${t('timeline.gitHead', { hash: git.headHash.slice(0, 8) })}${git.dirty ? ` · ${t('timeline.gitDirty')}` : ''}`),
            ]
          : createElement('button', {
              key: 'init',
              type: 'button',
              className: 'dsh-rt-chip',
              disabled: gitBusy,
              onClick: initGit,
              title: t('timeline.gitInitDesc'),
            }, t('timeline.gitInit')),
      ]),

      error !== null && createElement('div', { key: 'error', className: 'dsh-rt-error' }, error),
      loading && createElement('div', { key: 'loading', className: 'dsh-rt-timeline-empty' }, t('timeline.loading')),
      !loading && list.length === 0 && createElement('div', { key: 'empty', className: 'dsh-rt-timeline-empty' }, t('timeline.empty')),

      list.length > 0 && createElement('div', {
        key: 'list',
        className: 'dsh-rt-timeline-list',
        style: { height: `${Math.min(420, list.length * ROW_H)}px` },
        onScroll: (event) => setScrollTop(event.target.scrollTop),
      }, [
        createElement('div', { key: 'spacer', style: { height: `${list.length * ROW_H}px`, position: 'relative' } }, [
          visible.map((record) => createElement(VersionRow, {
            key: record.versionId,
            record,
            t,
            top: list.indexOf(record) * ROW_H,
            onPreview: () => requestPreview(record),
            onDetail: () => openDetail(record),
            onJump: () => jump(record.boundarySeq),
          })),
        ]),
      ]),

      preview && createElement(PreviewBox, {
        key: 'preview',
        preview,
        scope: previewScope,
        setScope: setPreviewScope,
        busy: rollbackBusy,
        t,
        onConfirm: confirmRollback,
        onCancel: () => setPreview(null),
      }),

      detail && createElement(DetailBox, { key: 'detail', detail, t, onClose: () => setDetail(null) }),
      jumpNotice !== null && createElement('div', { key: 'jump', className: 'dsh-rt-error' }, jumpNotice),
    ]),
  ])
}

/** One version row (uniform height for the windowed list). */
function VersionRow({ record, top, t, onPreview, onDetail, onJump }) {
  return createElement('div', { className: 'dsh-rt-version', style: { top: `${top}px` } }, [
    createElement('span', { key: 'kind', className: `dsh-rt-version-kind dsh-rt-version-kind-${record.kind}`, title: kindLabel(record.kind, t) }, KIND_ICONS[record.kind] ?? '•'),
    createElement('div', { key: 'body', className: 'dsh-rt-version-body' }, [
      createElement('div', { key: 'line1', className: 'dsh-rt-version-line' }, [
        createElement('span', { key: 'kind', className: 'dsh-rt-version-kind-label' }, kindLabel(record.kind, t)),
        createElement('span', { key: 'time', className: 'dsh-rt-version-time' }, timeLabel(record.createdAt)),
        createElement('span', { key: 'msgs', className: 'dsh-rt-version-msgs' }, t('timeline.messages', { count: record.messageCount })),
        createElement('span', { key: 'files', className: 'dsh-rt-version-files' }, fileCountLabel(record.fileCounts, t)),
      ]),
      record.markerText
        ? createElement('div', { key: 'text', className: 'dsh-rt-version-text' }, record.markerText.length > 120 ? `${record.markerText.slice(0, 120)}…` : record.markerText)
        : null,
    ]),
    createElement('span', { key: 'actions', className: 'dsh-rt-version-actions' }, [
      createElement('button', { key: 'detail', type: 'button', className: 'dsh-rt-chip', onClick: onDetail }, t('timeline.detail')),
      createElement('button', { key: 'jump', type: 'button', className: 'dsh-rt-chip', onClick: onJump }, t('timeline.jump')),
      createElement('button', { key: 'preview', type: 'button', className: 'dsh-rt-chip dsh-rt-chip-danger', onClick: onPreview }, t('timeline.preview')),
    ]),
  ])
}

/** Rollback preview + confirm box (scope selector + artifact actions). */
function PreviewBox({ preview, scope, setScope, busy, t, onConfirm, onCancel }) {
  const data = preview.data
  const scopes = [
    ['context', 'timeline.contextOnly', 'timeline.contextOnlyDesc'],
    ['artifacts', 'timeline.artifactsOnly', 'timeline.artifactsOnlyDesc'],
    ['both', 'timeline.both', 'timeline.bothDesc'],
  ]
  return createElement('div', { className: 'dsh-rt-modal' }, [
    createElement('div', { key: 'title', className: 'dsh-rt-modal-title' }, [
      t('timeline.preview'),
      createElement('span', { key: 'ver', className: 'dsh-rt-modal-sub' }, t('timeline.previewDesc', { version: preview.versionId, kind: kindLabel(preview.kind, t) })),
    ]),
    preview.error && createElement('div', { key: 'err', className: 'dsh-rt-error' }, preview.error),
    data === null && !preview.error && createElement('div', { key: 'wait', className: 'dsh-rt-timeline-empty' }, t('timeline.loading')),
    data && createElement('div', { key: 'body', className: 'dsh-rt-modal-body' }, [
      createElement('div', { key: 'ctx', className: 'dsh-rt-modal-line' },
        data.context?.messages > 0
          ? t('timeline.messagesRemoved', { count: data.context.messages })
          : t('timeline.noChanges')),
      createElement('div', { key: 'art', className: 'dsh-rt-modal-line' }, t('timeline.artifactsList', { count: data.artifacts?.rows?.length ?? 0 })),
      createElement('ul', { key: 'files', className: 'dsh-rt-modal-files' }, (data.artifacts?.rows ?? []).slice(0, 12).map((row) =>
        createElement('li', { key: row.path }, [
          createElement('span', { key: 'a', className: `dsh-rt-art-${row.action}` },
            row.action === 'skip' ? `${t('timeline.artifact.skip')} (${row.reason ?? ''})` : (row.action === 'delete' ? t('timeline.artifact.delete') : t('timeline.artifact.restore'))),
          createElement('span', { key: 'p', className: 'dsh-rt-art-path' }, row.path),
        ]))),
      createElement('div', { key: 'scope', className: 'dsh-rt-modal-scope' }, scopes.map(([value, labelKey, descKey]) =>
        createElement('label', { key: value, className: 'dsh-rt-option' }, [
          createElement('input', { type: 'radio', name: 'rt-scope', checked: scope === value, onChange: () => setScope(value) }),
          createElement('span', { className: 'dsh-rt-option-text' }, [
            createElement('span', { className: 'dsh-rt-option-label' }, t(labelKey)),
            createElement('span', { className: 'dsh-rt-option-desc' }, t(descKey)),
          ]),
        ]))),
    ]),
    createElement('div', { key: 'buttons', className: 'dsh-rt-modal-buttons' }, [
      createElement('button', { key: 'cancel', type: 'button', className: 'dsh-rt-editor-cancel', disabled: busy, onClick: onCancel }, t('timeline.cancel')),
      createElement('button', { key: 'confirm', type: 'button', className: 'dsh-rt-editor-send dsh-rt-confirm', disabled: busy || preview.error !== null, onClick: onConfirm },
        busy ? t('timeline.busy') : t('timeline.confirm')),
    ]),
  ])
}

/** Lazy event viewer (GET /event). */
function DetailBox({ detail, t, onClose }) {
  return createElement('div', { className: 'dsh-rt-modal' }, [
    createElement('div', { key: 'title', className: 'dsh-rt-modal-title' }, [
      `${t('timeline.detail')} · seq ${detail.seq}`,
      createElement('button', { key: 'close', type: 'button', className: 'dsh-rt-chip', onClick: onClose }, t('timeline.close')),
    ]),
    detail.error && createElement('div', { key: 'err', className: 'dsh-rt-error' }, detail.error),
    detail.data === null && !detail.error && createElement('div', { key: 'wait', className: 'dsh-rt-timeline-empty' }, t('timeline.loading')),
    detail.data && createElement('pre', { key: 'json', className: 'dsh-rt-modal-json' }, JSON.stringify(detail.data, null, 2)),
  ])
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

  // P1 — timeline entry in the session header (order ≈30, after the session crumb).
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'retrace-timeline',
    order: 30,
    locale: NS,
  }, (props) => TimelinePanel({ ...props, ctx })))

  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'retrace',
    order: 30,
    locale: NS,
  }, OptionsRow))
}
