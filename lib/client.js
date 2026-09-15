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
import { Component, createElement, useEffect, useRef, useState } from 'react'
import { sessionBadge } from './badge.js'
import { AUDIT_CONTEXT_KIND, auditContextDefinition, carrierShadowedSeqs, carrierTargetSeq, isCarrierMarkerEvent, shadowedSeqsOfAudit } from './marker-carrier.js'
import {
  GUARD_POLL_MS,
  classifySnapshot,
  buildRunningCopy,
  runningLines,
  createGuardStore,
} from './close-guard-client.js'

export const name = 'dsh-retrace'
// ⚠️ 只列**新基座确实存在**的客户端服务。旧名 `conversationEvents`（由已移除的
//    `@deepseek-ai/dsh-client-runtime` 提供）**已删** —— 留一个不存在的服务名在 inject 里
//    会让本插件永远不就绪，进而让整个 renderer boot 失败（2026-09-14 实测；官方社区市场
//    自检脚本亦把"仍请求该旧 runtime"定义为**直接判错**的形态）。
//    读端在 apply 里按 `uiConversation → conversationEvents` 顺序防御性查找。
export const inject = ['slots', 'locale']

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
export const zh = {
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
  'marker.degradedHint': '此操作涉及大范围对话，为保护历史未隐藏内容（日志完好）。',
  'marker.unionHint': '已累积隐藏约 {count}% 的历史消息；可在 设置→通用 关闭「按标记隐藏」查看完整历史。',
  'marker.t1Broken': '编辑已生效；此标记会使本会话的 /compact 失效。离线清理：关闭会话后运行 dsh-log-contract fix --drop-turnnull（编辑外观会回退为原始内容）。',
  'options.title': '消息编辑插件',
  'options.showOriginalInput': '编辑后显示原提问对照',
  'options.editFromScratch': '编辑后从新对话开始（隐藏此前的消息，默认关）',
  'options.hideShadowed': '按标记隐藏被编辑/撤回的消息',
  'options.hideShadowedDesc': '开（默认）：撤回/编辑/重新生成按标记隐藏被替换的那一轮消息。关：所有消息保持可见，标记仅显示提示与对照（查看完整历史用）。一次操作要隐藏超过 40% 的对话时自动降级为不隐藏。',
  'options.versioning': '读档点与产物快照',
  'options.versioningDesc': '开：每次撤回/编辑自动存一档（消息与触碰文件），提供读档点列表与产物回退；关：仅回退上下文，不存档、不追踪产物（最省资源）。',
  'options.summary': '给旧内容生成 AI 摘要',
  'options.summaryDesc': '开：撤回 / 编辑时多花 1 次小模型调用，为被丢弃的旧内容生成摘要，帮助回忆；依赖宿主提供 llm 服务，缺失时自动降级为只显示原文。关（默认）：只显示逐字原文，不产生任何调用。',
  'options.git': '启用 git 集成',
  'options.gitDesc': '开：工作区是 git 仓库时用 git 记录与回退（不自动提交、不动你的分支），非仓库可在时间线里一键启用；关：一律用内置快照（存于插件数据目录），不触碰工作区 git 状态，功能等价。',
  'options.retention': '读档点保留上限',
  'options.retentionDesc': '文件快照只保留最近 N 个读档点，超出自动清理最旧的；读档点记录与审计痕迹始终保留。',
  'timeline.open': '时间线',
  'timeline.openAria': '打开会话时间线',
  'timeline.title': '读档点',
  // 概念解释（常驻副标题）：说清"它是什么 + 你能拿它做什么"，不堆术语。
  'timeline.intro': '这里是你会话的改动记录：每次撤回 / 编辑 / 重新生成前，原来的内容都会存一档（共 {count} 次）。点任一条可展开看当时的原话。',
  'view.retrace': '读档点',
  'timeline.refresh': '刷新',
  'badge.hint': '短码由会话唯一 id 确定性导出，永不变（标题会变）。',
  'timeline.close': '关闭',
  'timeline.empty': '还没有读档点。撤回 / 编辑 / 重新生成会自动存一档。',
  'timeline.loading': '加载中…',
  'timeline.error': '时间线加载失败',
  'timeline.kind.recall': '撤回',
  'timeline.kind.edit': '编辑重发',
  'timeline.kind.regenerate': '重新生成',
  'timeline.kind.restore': '恢复',
  'timeline.kind.compaction': '压缩',
  'timeline.kind.replace': '替换',
  'timeline.messages': '当时共 {count} 条消息',
  'timeline.files': '产物变更：{created} 增 / {modified} 改 / {deleted} 删',
  'timeline.filesNone': '无产物变更',
  // 每行的"为什么发生"兜底说明（有 markerText 时优先显示原文摘要）。
  'timeline.why.recall': '丢弃此后的消息，对话从这一点重新继续。',
  'timeline.why.edit': '这条消息被改写后重新发送，原问法保留为对照。',
  'timeline.why.regenerate': '这条回复被重新生成，原回复退出对话。',
  'timeline.why.restore': '对话回退到这一档的状态。',
  'timeline.why.compaction': '此处压缩了较早的上下文。',
  'timeline.why.replace': '此处发生一次替换，旧内容退出对话。',
  'timeline.preview': '回退预览',
  'timeline.restoreTo': '回到这一档',
  'timeline.previewDesc': '将回到「{kind}」时的那一档（{version}）。',
  'timeline.contextOnly': '仅对话',
  'timeline.contextOnlyDesc': '移除这一档之后的消息（日志审计痕迹保留）',
  'timeline.artifactsOnly': '仅产物',
  'timeline.artifactsOnlyDesc': '把这一档触碰的文件恢复到当时的內容',
  'timeline.both': '两者',
  'timeline.bothDesc': '先回退对话，再回退产物',
  'timeline.messagesRemoved': '将移除 {count} 条消息',
  'timeline.noChanges': '当前已在这一档，无变化',
  'timeline.artifactsList': '将变更的文件（{count}）',
  // R34：二次确认要列出影响明细（文件数 + 明细）。
  'timeline.artifactsImpact': '将改动或删除 {count} 个文件（见下列明细）',
  'timeline.artifact.restore': '恢复',
  'timeline.artifact.delete': '删除',
  'timeline.artifact.skip': '跳过',
  'timeline.confirm': '确认回退',
  'timeline.cancel': '取消',
  'timeline.busy': '回退中…',
  'timeline.detail': '详情',
  'timeline.jump': '跳转',
  'timeline.jumpFailed': '该读档点在较远的过去（超出自动加载预算），无法直接定位。请向上滚动加载更早消息后重试；或用「详情」查看它当时的事件原文。',
  'timeline.doctorWarn': '该会话含 {count} 个编辑/撤回标记；执行压缩（/compact）前建议先清理，否则压缩可能失败。',
  'timeline.gitRepo': 'git 仓库',
  'timeline.gitHead': 'HEAD {hash}',
  'timeline.gitDirty': '工作区有未提交改动',
  'timeline.gitInit': '启用 git 读档点管理',
  'timeline.gitInitDesc': '在工作区执行 git init（仅添加 .gitignore 与一个基线提交），读档点回退将优先使用 git。',
  'timeline.gitInitConfirm': '确定要初始化 git 吗？',
  'error.generic': '操作失败，请重试',
  'error.busy': '请先停止当前回复再操作',
  // 不再原样透传 host 错误(曾为英文 "no longer part of the active
  // conversation"——把「提交中」误报成「已不在活跃对话」)。按 code 本地化:
  'error.targetShadowed': '该消息位于已折叠块(历史只读):展开该块后编辑,或追加新消息修订',
  'error.messagePending': '消息生成中,完成后可编辑',
  // 新增两个 host 错误码(message-not-found / span-replay-failed)+ 契约违规走通用文案
  'error.messageNotFound': '目标消息不在会话日志中(可能已删除或消息 id 无效)',
  'error.spanReplayFailed': '遮蔽范围计算失败(内部错误):会话日志重放异常,请重试或反馈该会话',
  // 概念解释（常驻副标题）：说清"它是什么 + 你能拿它做什么"。
  // 行内类型图标的人读图例（上下文行只有类型信息，需图例解释）。
  // 边界摘要（what）：逐字原文与 AI 摘要分开渲染（各自独立元素）。
  'what.summaryTag': '摘要',
  'what.more': '另有 {count} 条',
  'what.compacted': '宿主压缩了上下文（与本次回退无关），原文已不在日志里',
  'what.currentLabel': '延续',
  'what.oldVoid': '已丢弃',
  // 第二行的口径：不再说“丢弃”、也不再露原始 seq。
  'what.oldLabel': '原来的内容：',
  'what.role.unknown': '旧内容',
  // 行里的角色措辞换成用户视角（用户原话：“这一轮的输入”）。
  'what.role2.user': '这一轮的输入',
  'what.role2.assistant': '助手的回复',
  'what.role2.tool': '工具输出',
  'what.role2.unknown': '原内容',
  // 「现在这条」——读者先看到它，再看到被它换掉的那一份（阅读顺序 ①→②→③）
  'what.nowLabel': '现在这条：',
  'what.resentSame': '内容未改，重新发送；原来的内容：',
  'what.noNewRecall': '这条没有新的对应内容（撤回后由后续输入继续）',
  'what.noNewMissing': '这条对应的新内容已不在日志里',
  'what.role.user': '你发送的消息',
  'what.role.assistant': '助手生成的回复',
  'what.role.tool': '工具执行结果',
  'what.discarded': '这次改动丢弃了 {count} 条消息',
  // 紧凑行（两行）：计数搬到首行，正文默认只留一条内容行。
  'what.countShort': '换掉了 {count} 条',
  'row.expand': '明细',
  'row.collapse': '收起',
  // 嵌套大纲 / 安静改动 / 现在的路
  'tree.moreLevels': '还有 {count} 层',
  'tree.changes': '这一档里还有 {count} 次改动',
  'tree.collapse': '收起',
  // 深层档：点一次开一层（不再是死胡同）。
  'tree.deepen': '点一次开一层',
  // 展开层内悬浮的收起入口（不必滚到底部就能收）
  'timeline.collapseHint': '▾ 收起：{label}',
  'timeline.collapseHintTitle': '收起这一档（不用滚到底部）',
  'quiet.note': '（无输出、无产物变化）',
  // R20：安静改动不占主时间线，收进底部默认折叠的纯文字区块。
  'quiet.blockTitle': '简单改动（{count} 次）',
  // R24：连续 ≥2 次才合并成一行（可展开）；单条不合并、直接可见。
  'quiet.merged': '连续 {count} 次改动',
  'quiet.expand': '▸ 展开',
  // R22：安静行动作 = 纯导航（跳到最新对话），不是回退。
  'quiet.jumpLatest': '跳到最新对话',
  // 实机发现(2026-09-15)：宿主自身的 surface 替换不是用户的改动，已过滤；数量如实告知。
  'host.replacements': '另有 {count} 条宿主自身的替换（非本插件改动），未计入列表。',
  'path.title': '现在的路',
  'path.header': '{title}（{messages} 条消息 / {rounds} 轮）',
  // R31：起点文字 / 摘要（如有）——摘要缺省时如实显示原文。
  'path.start': '起点',
  // 页首的顺序提示 + 行尾“能点”的提示。
  'timeline.orderHint': '最近的改动在最下面',
  // 行首的轮次（从日志推；取不到就整段省略）。
  'timeline.round': '第 {n} 轮',
  'timeline.openEntry': '查看这一档',
  // 白屏事故(2026-09-15)：面板级错误边界的提示与重试。
  'view.errorTitle': '读档点渲染出错',
  // 每一个注册面都有自己的标题（提示/重试共用）。
  'panel.error.marker': '编辑 / 撤回 标记渲染出错',
  'panel.error.actions': '消息操作按钮渲染出错',
  'panel.error.userActions': '用户消息操作渲染出错',
  'panel.error.reference': '原问法对照行渲染出错',
  'panel.error.options': '设置项渲染出错',
  'view.errorHint': '这个面板暂时无法显示（宿主其他部分不受影响）。可以点「重试」重新渲染。',
  'view.errorRetry': '重试',
  'path.round': '第 {n} 轮',
  'path.empty': '（当前没有对话轮次）',
  'options.closeGuard': '退出确认（关闭守卫）',
  'options.closeGuardDesc': '开（默认）：页面/窗口关闭前确认退出——有运行中任务或未完成对话时强拦并列出明细（防误关丢进度），无任务时轻确认一次。此拦截作用于浏览器/页面关闭路径（网页版标签页；桌面版应用退出为宿主原生路径，见运行中横幅提示）。',
}
/** English dictionary, checked complete against the zh key set. */
export const en = {
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
  'marker.degradedHint': 'This operation spans a large part of the conversation; content stays visible to protect your history (the log is intact).',
  'marker.unionHint': 'About {count}% of the history is hidden in total; disable "Hide shadowed messages" in Settings → General to review the full history.',
  'marker.t1Broken': 'Edit applied; this marker will break /compact for this session. Offline clean-up: close the session and run dsh-log-contract fix --drop-turnnull (the edit reverts to the original content).',
  'options.title': 'Message editor plugin',
  'options.showOriginalInput': 'Show the original input after editing',
  'options.editFromScratch': 'Start a fresh conversation after editing (hide earlier messages, default off)',
  'options.hideShadowed': 'Hide shadowed messages per marker',
  'options.hideShadowedDesc': 'On (default): recall/edit/regenerate hide the replaced round per their markers. Off: every message stays visible; markers only show the notice and reference (use to review full history). A single op that would hide more than 40% of the conversation degrades to notice-only automatically.',
  'options.versioning': 'Checkpoints & artifact snapshots',
  'options.versioningDesc': 'On: every recall/edit saves a checkpoint (messages and touched files) powering the checkpoint list and artifact rollback. Off: only rewinds context — no checkpoints, no artifact tracking (lightest).',
  'options.summary': 'Summarize old content with AI',
  'options.summaryDesc': 'On: each recall/edit makes one small model call to summarize the discarded old content, to help you remember it; requires the host llm service and degrades to verbatim text only when absent. Off (default): verbatim text only, no calls.',
  'options.git': 'Git integration',
  'options.gitDesc': 'On: uses git to record and roll back when the workspace is a repository (never auto-commits, never touches your branches); non-repo workspaces can enable git from the timeline. Off: built-in snapshots under the plugin data home only — the plugin never touches the workspace git state; equivalent features.',
  'options.retention': 'Checkpoint retention limit',
  'options.retentionDesc': 'File snapshots are kept for the most recent N checkpoints; older ones are pruned automatically (checkpoint records and the audit trail are always kept).',
  'timeline.open': 'Timeline',
  'timeline.openAria': 'Open the session timeline',
  'timeline.title': 'Checkpoints',
  'timeline.intro': 'Every recall / edit / regenerate saves what it replaced. {count} changes in this session — click one to expand.',
  'view.retrace': 'Checkpoints',
  'timeline.refresh': 'Refresh',
  'badge.hint': 'A stable shortcode derived from the session id (titles change, badges never do).',
  'timeline.close': 'Close',
  'timeline.empty': 'No checkpoints yet. A recall / edit / regenerate saves one here.',
  'timeline.loading': 'Loading…',
  'timeline.error': 'Failed to load the timeline',
  'timeline.kind.recall': 'Recall',
  'timeline.kind.edit': 'Edit & resend',
  'timeline.kind.regenerate': 'Regenerate',
  'timeline.kind.restore': 'Restore',
  'timeline.kind.compaction': 'Compaction',
  'timeline.kind.replace': 'Replace',
  'timeline.messages': '{count} messages at this point',
  'timeline.files': 'artifacts: {created} created / {modified} modified / {deleted} deleted',
  'timeline.filesNone': 'no artifact changes',
  'timeline.why.recall': 'Everything after this point is dropped; the conversation continues from here.',
  'timeline.why.edit': 'This message was rewritten and resent; the original wording is kept for comparison.',
  'timeline.why.regenerate': 'This reply was regenerated; the previous reply leaves the conversation.',
  'timeline.why.restore': 'The conversation returns to its state at this checkpoint.',
  'timeline.why.compaction': 'Earlier context was compacted at this point.',
  'timeline.why.replace': 'A replacement happened here; the old content leaves the conversation.',
  'timeline.preview': 'Rollback preview',
  'timeline.restoreTo': 'Back to this checkpoint',
  'timeline.previewDesc': 'Returns to the checkpoint taken at "{kind}" ({version}).',
  'timeline.contextOnly': 'Context only',
  'timeline.contextOnlyDesc': 'Remove messages after this checkpoint (the log audit trail stays)',
  'timeline.artifactsOnly': 'Artifacts only',
  'timeline.artifactsOnlyDesc': 'Restore the files this checkpoint touched to their state back then',
  'timeline.both': 'Both',
  'timeline.bothDesc': 'Roll back the context first, then the artifacts',
  'timeline.messagesRemoved': '{count} messages will be removed',
  'timeline.noChanges': 'Already at this checkpoint; nothing to change',
  'timeline.artifactsList': 'Files to change ({count})',
  'timeline.artifactsImpact': 'Will change or delete {count} files (listed below)',
  'timeline.artifact.restore': 'restore',
  'timeline.artifact.delete': 'delete',
  'timeline.artifact.skip': 'skip',
  'timeline.confirm': 'Confirm rollback',
  'timeline.cancel': 'Cancel',
  'timeline.busy': 'Rolling back…',
  'timeline.detail': 'Details',
  'timeline.jump': 'Jump',
  'timeline.jumpFailed': 'This checkpoint lies too far back (beyond the auto-load budget) to locate directly. Scroll up to load earlier messages, or use Details to read its original event text.',
  'timeline.doctorWarn': 'This session has {count} edit/recall markers; clean them before compacting (/compact) or compaction may fail.',
  'timeline.gitRepo': 'git repository',
  'timeline.gitHead': 'HEAD {hash}',
  'timeline.gitDirty': 'working tree has uncommitted changes',
  'timeline.gitInit': 'Enable git checkpoints',
  'timeline.gitInitDesc': 'Runs git init in the workspace (adds a minimal .gitignore and a baseline commit); rollback will prefer git.',
  'timeline.gitInitConfirm': 'Initialize git in this workspace?',
  'error.generic': 'Operation failed; please try again',
  'error.busy': 'Stop the current reply before recalling or editing',
  // localized by code (see zh). Never show the raw host copy verbatim.
  'error.targetShadowed': 'This message is inside a folded (read-only) history block: expand that block to edit it, or append a new message instead',
  'error.messagePending': 'Message is still being generated; edit it once it finishes',
  'error.messageNotFound': 'That message is not in the session log (deleted, or the id is invalid)',
  'error.spanReplayFailed': 'Could not compute the shadow range (internal error): session-log replay failed; retry or report this session',
  'what.summaryTag': 'Summary',
  'what.more': '{count} more',
  'what.compacted': 'the host compacted this context (not caused by this rewind) — originals are no longer in the log',
  'what.currentLabel': 'Continued',
  'what.oldVoid': 'discarded',
  'what.oldLabel': 'previously:',
  'what.role.unknown': 'Old content',
  'what.role2.user': "this round's input",
  'what.role2.assistant': "the assistant's reply",
  'what.role2.tool': 'tool output',
  'what.role2.unknown': 'original content',
  'what.nowLabel': 'now: ',
  'what.resentSame': 'resent unchanged; previously: ',
  'what.noNewRecall': 'no new counterpart — later input follows this recall',
  'what.noNewMissing': 'the counterpart for this entry is no longer in the log',
  'what.role.user': 'Message you sent',
  'what.role.assistant': 'Reply generated by the assistant',
  'what.role.tool': 'Tool execution result',
  'what.discarded': 'this change discarded {count} messages',
  'what.countShort': 'replaced {count} messages',
  'row.expand': 'Details',
  'row.collapse': 'Collapse',
  'tree.moreLevels': '{count} more levels',
  'tree.changes': '{count} more changes in this entry',
  'tree.collapse': 'Collapse',
  'tree.deepen': 'Open one more level',
  'timeline.collapseHint': 'Collapse: {label}',
  'timeline.collapseHintTitle': 'Collapse this entry (no need to scroll to the bottom)',
  'quiet.note': ' (no output, no artifact changes)',
  'quiet.blockTitle': 'Simple changes ({count})',
  'quiet.merged': '{count} changes in a row',
  'quiet.expand': '▸ Show',
  'quiet.jumpLatest': 'Jump to the latest message',
  'host.replacements': '{count} host-side surface replacements (not changes made by this plugin) are excluded from the list.',
  'path.title': 'Current path',
  'path.header': '{title} ({messages} messages / {rounds} rounds)',
  'path.start': 'Start',
  'timeline.orderHint': 'newest changes are at the bottom',
  'timeline.round': 'Round {n}',
  'timeline.openEntry': 'Open this entry',
  'view.errorTitle': 'Checkpoints failed to render',
  'panel.error.marker': 'Edit / recall marker failed to render',
  'panel.error.actions': 'Message action strip failed to render',
  'panel.error.userActions': 'User message actions failed to render',
  'panel.error.reference': 'Original-input comparison failed to render',
  'panel.error.options': 'Settings row failed to render',
  'view.errorHint': 'This panel could not render (the rest of the app is unaffected). Use Retry to render it again.',
  'view.errorRetry': 'Retry',
  'path.round': 'Round {n}',
  'path.empty': '(no conversation rounds yet)',
  'options.closeGuard': 'Exit confirmation (close guard)',
  'options.closeGuardDesc': 'On (default): confirm before the page/window closes — when sessions have running or unfinished work a strong guard lists them (prevents accidental progress loss); otherwise a light one-time confirm. Applies to browser/page close paths (web tabs; Desktop app exit is a host-native path — see the running banner).',
}

// ---------------------------------------------------------------------------
// 操作失败文案
// ---------------------------------------------------------------------------
/**
 * 操作失败文案:code → 本地化映射(t 按当前 locale 取 zh/en),不再原样透传 host
 * 错误。target-shadowed/message-pending 两个 host 侧已改中文文案、与字典同源——
 * 此处仍按 code 走 t(),保证英文界面也显示英文;未映射的 code 透传 host message
 * (host 已中文则直接用;如 fold 的 target-shadowed 之外的中文错误),无 message
 * 兜底 error.generic。host 同时在 error 上附带 messageId/seq(排查用建议 3)。
 */
export function opFailureText(code, message, t) {
  if (code === 'agent-busy') return t('error.busy')
  if (code === 'target-shadowed') return t('error.targetShadowed')
  if (code === 'message-pending') return t('error.messagePending')
  // 显式状态落到的新错误码(缺了会让英文用户看到 host 中文文案)
  if (code === 'message-not-found') return t('error.messageNotFound')
  if (code === 'span-replay-failed') return t('error.spanReplayFailed')
  // 契约违规是**内部错误**,detail(契约名/期望/实际)只进日志,不给用户看技术细节
  if (code === 'contract-violation') return t('error.generic')
  return message ?? t('error.generic')
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
  const { versioning, git, retentionLimit, summary } = getConfig()
  return { 'x-retrace-config': JSON.stringify({ versioning, git, retentionLimit, summary }) }
}

// ---------------------------------------------------------------------------
// Plugin preferences (localStorage-backed, reactive)
// ---------------------------------------------------------------------------
/**
 * v3 defaults (2026-08-26 incident fix, finalized): v1's default
 * `editFromScratch: true` made a single edit hide the WHOLE conversation before
 * the edit point, so clicking "load earlier" appeared to load nothing. v3 keeps
 * normal edit UX while making the wipe impossible:
 *  - `editFromScratch: false` — editing one message no longer rewinds the whole
 *    conversation; only the edited round is replaced on the model surface.
 *  - `hideShadowed: true` — the replaced round of an edit/recall/regenerate is
 *    hidden from the view (the natural "old message disappears" UX), while the
 *    safety guard in `useHiddenKeys` (40% of the conversation) refuses any
 *    single marker from blanking out most of the history.
 */
const CONFIG_VERSION = 3
const CONFIG_DEFAULTS = { version: CONFIG_VERSION, showOriginalInput: true, editFromScratch: false, hideShadowed: true, versioning: true, git: true, retentionLimit: 50, prewrite: true, closeGuard: true, summary: false }
const configListeners = new Set()
let configCache = readConfig()

/** resendMessageId -> the exact text that edit replaced (most recent, host-authoritative). */
const editReferences = new Map()

/**
 * Pre-v3 migration: the destructive default `editFromScratch: true` is always
 * reset to false; `hideShadowed` is reset to true (the natural edit UX) for
 * configs written under the interim v2 defaults (where it was force-false).
 * Every other customization is preserved.
 */
function migrateConfig(parsed) {
  const version = typeof parsed.version === 'number' ? parsed.version : 1
  if (version >= CONFIG_VERSION) return { ...CONFIG_DEFAULTS, ...parsed }
  return {
    ...CONFIG_DEFAULTS,
    ...parsed,
    version: CONFIG_VERSION,
    editFromScratch: CONFIG_DEFAULTS.editFromScratch,
    hideShadowed: CONFIG_DEFAULTS.hideShadowed,
  }
}

function readConfig() {
  try {
    const raw = localStorage.getItem(CONFIG_KEY)
    if (raw !== null) {
      const parsed = raw ? JSON.parse(raw) : {}
      const migrated = migrateConfig(parsed)
      const storedVersion = typeof parsed.version === 'number' ? parsed.version : 1
      if (storedVersion < CONFIG_VERSION) {
        // Persist the migration so the next load starts from the v3 shape.
        try { localStorage.setItem(CONFIG_KEY, JSON.stringify(migrated)) } catch { /* storage unavailable */ }
      }
      return migrated
    }
    // Rename-safe fallback: pick up settings saved under a previous plugin name.
    for (const legacyKey of LEGACY_CONFIG_KEYS) {
      const legacyRaw = localStorage.getItem(legacyKey)
      if (legacyRaw !== null) {
        const migrated = migrateConfig(legacyRaw ? JSON.parse(legacyRaw) : {})
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
    if (!isReplacementSurfaceEvent(event)) return null
    if (event.type === 'assistant/message') {
      const id = event.data?.message?.id
      if (!isMarkerId(id)) return null
      return { id: `marker:${id}`, role: 'start' }
    }
    // 两段结构的第 2 段:user/message + replace + 我方 marker id
    // (判据来自 lib/marker-carrier.js,不在客户端另写一份)。
    if (isCarrierMarkerEvent(event)) {
      return { id: `marker:${String(event.data.id)}`, role: 'start' }
    }
    // Compaction checkpoints are user/message replaces with the official
    // `plugin: compact` source. They are NOT our markers, but their shadow
    // range tells us which messages were compacted away — used ONLY to hide
    // the edit/recall entries for those messages (compacted rows are handled
    // by the engine itself, so the checkpoint marker renders nothing and
    // never injects hide rules).
    if (event.type === 'user/message' && isCompactCheckpoint(event.data?.source)) {
      return { id: `marker:compact:${event.seq}`, role: 'start' }
    }
    return null
  },
  start: (_context, match, reader) => {
    const event = match.event
    const compact = event.type === 'user/message' && isCompactCheckpoint(event.data?.source)
    // 载体两形态:旧形态 id 在 data.message.id,两段结构在 data.id。
    const id = compact ? '' : String(event.data?.message?.id ?? event.data?.id ?? '')
    const legacy = !compact && isLegacyMarkerId(id)
    // 被遮蔽 seq 的取值口径收敛到 marker-carrier（两段结构的顶层数组首项是审计
    // seq，须截掉）。顶层 provenance 被事件管道剥掉/截断时，客户端**只能**按 kind 取
    // 相邻上下文（reader 没有"按 seq 取任意事件"的接口）⇒ 回落到第 1 段审计上下文，
    // 再走同一个判据（区间与载体逐值相等才采用，否则视为他人写的审计段）。
    const fromProvenance = carrierShadowedSeqs(event)
    const audit = typeof reader?.previous === 'function' ? reader.previous(AUDIT_CONTEXT_KIND) : undefined
    const fromAudit = shadowedSeqsOfAudit(audit?.state, event)
    return {
      seq: event.seq,
      time: event.time,
      op: compact ? 'compaction' : markerOpFromId(id),
      legacy,
      compact,
      // Legacy/compact markers never hide: their shadowed range is kept for
      // the action-row suppression check (useShadowed) but empty for legacy
      // so no row is hidden and no action row is suppressed for legacy
      // markers (rename must never make visible content disappear).
      shadowedSeqs: legacy ? [] : (fromProvenance.length > 0 ? fromProvenance : fromAudit),
      // 业务溯源改由区间起点派生（editor.targetSeq 已不再落盘）；旧形态仍读 editor。
      // 与 host 侧同一实现：lib/marker-carrier.js 的 carrierTargetSeq（v0/v3 双形状 +
      // 键数/op 校验都在那里，客户端不再另写一份取值）。
      targetSeq: carrierTargetSeq(event),
      // 原文不再随载体存储（读端按需派生）⇒ 新形态此处为空：编辑「原输入」行改由
      // 本次会话内的 editReferences 映射提供，跨会话回看走恢复视图（展开逐字回填）。
      text: event.data?.editor?.text,
    }
  },
  update: (context) => context.state,
  buildViewNode: (context) => {
    if (context.state === undefined) return null
    return chatNodeLike(context, 'recall-marker', context.state.seq, context.state)
  },
}

/**
 * 测试入口：客户端 marker 定义本体（`start` 的第三参 = conversation reader，
 * 用例据此复现「顶层 provenance 被剥 ⇒ 回落审计上下文」的读端路径）。
 */
export const __recallMarkerDefinition = recallMarkerDefinition

/** Official compaction checkpoint source: `{kind:'plugin', plugin:'compact'}`. */
function isCompactCheckpoint(source) {
  return Boolean(source) && source.kind === 'plugin' && source.plugin === 'compact'
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
function useMessageSeq(useChat, messageId) {
  return useChat((snapshot) => {
    for (const node of snapshot.nodes.values()) {
      if (node.kind === 'assistant-step' && node.data?.finalNode?.messageId === messageId) {
        return node.data.finalNode.seq
      }
    }
    return undefined
  })
}

/**
 * Safety guard: a SINGLE marker that would hide more than this share of the
 * conversation's rows is refused (the marker renders as a notice only, and an
 * explicit hint explains why). Ordinary recalls/edits shadow a few rows and
 * always hide — the guard only ever trips on whole-surface operations such as
 * "edit, start a fresh conversation". History must never silently vanish.
 *
 * Note (0.4.3 regression, fixed): the previous UNION-wide guard degraded EVERY
 * marker (including fresh recalls) once the session's markers collectively
 * covered >40% of the rows — recall/edit silently stopped hiding. The guard is
 * per-marker again; a stacked-edit session still hides each replaced round,
 * and a visible hint reports how much history is hidden in total.
 */
const SHADOW_SAFETY_RATIO = 0.4

/**
 * 短会话豁免阈值（2026-09-01问题 B 的 client 侧另一半；
 * 09-01 用户实测调大至 20）：行数 ≤ 本值的会话永不触发 40% 降级——否则
 * 小会话撤回/编辑 2-4 条消息就 >40%，被误判为「大范围操作」降级为不隐藏
 * （用户实测：「已撤回 4 条消息 + 此操作涉及大范围对话…」= 小会话误伤）。
 * 与 host 侧 ROLLBACK_MIN_SURFACE=20（surface 节点）同源：短会话豁免只在
 * 大会话按比例判定。20 行 ≈ 10 轮 ≈ 20 条消息，正常撤回/编辑远小于此。
 */
const SHADOW_MIN_ROWS_FOR_RATIO = 20

/** 40% 降级判定（短会话豁免版）：行数足够大才按比例判定。 */
function shadowDegraded(keys, rowCount) {
  return keys !== null && rowCount > SHADOW_MIN_ROWS_FOR_RATIO && keys.length / rowCount > SHADOW_SAFETY_RATIO
}

/**
 * Every chat-node key that should disappear when `shadowedSeqs` are recalled:
 * the shadowed message rows themselves, plus the per-turn action row (copy /
 * feedback / branch) when its finalized assistant reply is among them.
 */
function hiddenKeysFor(shadowedSeqs, nodes) {
  if (!Array.isArray(shadowedSeqs) || shadowedSeqs.length === 0) return null
  const hidden = new Set(shadowedSeqs)
  const keys = []
  for (const node of nodes.values()) {
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
    if (typeof node.anchorSeq === 'number') {
      // Pseudo rows anchor at HALF seqs to order before their message
      // (retrace-reference uses `seq - 0.5`); the shadow set holds whole
      // seqs, so map the anchor back to its integer seq before matching —
      // otherwise the original-input reference survives the message it
      // belongs to (visible residue after an edit).
      const anchored = node.anchorSeq % 1 === 0 ? node.anchorSeq : Math.ceil(node.anchorSeq)
      if (hidden.has(anchored)) keys.push(node.key)
    }
  }
  return keys.length === 0 ? null : keys
}

/**
 * Hide plan (0.4.3 → per-marker): one snapshot pass computes every marker's
 * hidden keys and applies the safety guard to each marker INDEPENDENTLY. A
 * single normal recall/edit hides its replaced round (a few rows ≪ the
 * threshold); only a marker that would hide most of the history by itself
 * (e.g. "start a fresh conversation") degrades to notice-only. The plan also
 * reports the collective ratio so the UI can hint when stacked edits hide a
 * large share of the conversation.
 */
const EMPTY_HIDE_PLAN = Object.freeze({
  hiddenFor: () => null,
  planFor: () => null,
  unionRatio: 0,
  rowCount: 0,
  firstMarkerKey: null,
  // No live marker ⇒ nothing is hidden, whatever the nodes are.
  isSeqHidden: () => false,
})

/**
 * Plugin pseudo-node kinds never represent a real conversation row; they must
 * not count toward the safety-ratio denominator (0.4.x review: counting them
 * diluted the 40% guard to ~55-68% of real rows).
 */
const PLUGIN_PSEUDO_KINDS = new Set(['user-actions', 'retrace-reference', 'recall-marker'])

/** Count only REAL conversation rows (excludes the plugin's pseudo nodes). */
function realRowCount(nodes) {
  let count = 0
  for (const node of nodes.values()) {
    if (typeof node.anchorSeq === 'number' && !PLUGIN_PSEUDO_KINDS.has(node.kind)) count += 1
  }
  return count
}

// Module-level memo: the conversation snapshot reference is stable between
// events, so the hide plan (O(nodes) per pass) is computed once per snapshot
// and shared by every marker row AND every `useSeqHidden` row — same object
// reference → no re-render storm (0.4.x review: each marker row recomputed the
// whole table every snapshot).
let hidePlanCacheSnapshot = null
let hidePlanCacheValue = null

/**
 * Build (or reuse) the per-snapshot hide plan.
 *
 * `isSeqHidden(seq)` answers the SAME question the old per-row `rowHiddenByKey`
 * scan did — "the first non-marker node anchored at `seq` is hidden by some
 * non-degraded marker" (degraded markers hide nothing; compact markers never
 * enter `markers`) — but from this ONE plan. Routing `useSeqHidden` through the
 * plan removes the O(rows × markers × nodes) rescan that ran for every row on
 * every snapshot (measured 2026-09-14 before this: 500 rows/5 markers ≈ 6 ms,
 * 2000/20 ≈ 346 ms, 3000/30 ≈ 1.6 s per pass; the hook path only became live
 * once the action rows actually rendered).
 */
function hidePlanOf(snapshot) {
  if (hidePlanCacheSnapshot === snapshot) return hidePlanCacheValue
  const nodes = snapshot.nodes
  const rowCount = realRowCount(nodes)
  const markers = []
  for (const node of nodes.values()) {
    if (node.kind === 'recall-marker' && !node.data?.compact) markers.push(node)
  }
  if (markers.length === 0) {
    hidePlanCacheSnapshot = snapshot
    hidePlanCacheValue = EMPTY_HIDE_PLAN
    return hidePlanCacheValue
  }
  const plans = new Map()
  const union = new Set()
  const hiddenRowKeys = new Set()
  for (const marker of markers) {
    const keys = hiddenKeysFor(marker.data?.shadowedSeqs, nodes)
    const degraded = shadowDegraded(keys, rowCount)
    plans.set(marker.key, { keys: degraded ? null : keys, degraded })
    if (keys !== null) {
      for (const key of keys) union.add(key)
      // Degraded markers hide nothing, so only live keys enter the row lookup.
      if (!degraded) for (const key of keys) hiddenRowKeys.add(key)
    }
  }
  // `useSeqHidden` resolves the row key as the FIRST non-marker node at the seq.
  const seqToKey = new Map()
  for (const node of nodes.values()) {
    if (node.kind === 'recall-marker') continue
    if (typeof node.anchorSeq === 'number' && !seqToKey.has(node.anchorSeq)) seqToKey.set(node.anchorSeq, node.key)
  }
  hidePlanCacheSnapshot = snapshot
  hidePlanCacheValue = {
    planFor: (key) => plans.get(key) ?? null,
    hiddenFor: (key) => plans.get(key)?.keys ?? null,
    unionRatio: rowCount > 0 ? union.size / rowCount : 0,
    rowCount,
    firstMarkerKey: markers[0].key,
    isSeqHidden: (seq) => {
      if (seq === undefined || seq === null) return false
      const key = seqToKey.get(seq)
      return key !== undefined && hiddenRowKeys.has(key)
    },
  }
  return hidePlanCacheValue
}

function useMarkerHidePlan(useChat) {
  return useChat((snapshot) => hidePlanOf(snapshot))
}

/**
 * True when the chat row for surface `seq` is hidden right now. Reads the
 * per-snapshot plan (see `hidePlanOf`) instead of rescanning the node map per
 * row × marker, so it is O(1) per row once the plan exists for the snapshot.
 */
function useSeqHidden(useChat, seq) {
  return useChat((snapshot) => hidePlanOf(snapshot).isSeqHidden(seq))
}

/**
 * True when `seq` was shadowed by ANY recall/edit/regenerate/compaction
 * marker — the OPERATION-FEASIBILITY dimension, distinct from visual hiding:
 * a shadowed message can never be edited/recalled again (the host rejects it
 * with target-shadowed), so its action entries must be hidden even when the
 * row itself stays visible (guard-degraded or compacted).
 */
function useShadowed(useChat, seq) {
  return useChat((snapshot) => {
    if (seq === undefined || seq === null) return false
    for (const node of snapshot.nodes.values()) {
      // Include compact markers: compacted messages are also un-editable.
      if (node.kind === 'recall-marker' && Array.isArray(node.data?.shadowedSeqs)
        && node.data.shadowedSeqs.includes(seq)) {
        return true
      }
    }
    return false
  })
}

/** The marker notice disappears once the user keeps typing after the rewind. */
function useMarkerDismissed(useChat, markerSeq, op) {
  return useChat((snapshot) => {
    if (typeof markerSeq !== 'number') return false
    let after = 0
    for (const node of snapshot.nodes.values()) {
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
function useEditReference(useChat, mySeq) {
  return useChat((snapshot) => {
    if (typeof mySeq !== 'number') return null
    let latestMarkerSeq = -1
    let referenceText = null
    let prevUserSeq = -1
    for (const node of snapshot.nodes.values()) {
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

/**
 * The chat-node map for a `conversation.view` entry, read through the host's
 * `useChat` standard prop.
 *
 * The view components call this UNCONDITIONALLY — the `useChat` call is never
 * written inside a ternary in a component body, so the component's own hook
 * sequence does not depend on whether the prop is present. `useChat` is part of
 * the `conversation.view` standard kit on both measured host generations; a
 * host that does not supply it yields `undefined` (jumps then report
 * `no-node-source`) instead of crashing the view.
 */
const NO_CHAT_SELECTOR = () => undefined
function useChatNodes(useChat) {
  const read = typeof useChat === 'function' ? useChat : NO_CHAT_SELECTOR
  return read((snapshot) => snapshot?.nodes)
}
/** The display order of the live chat surface (for the "current path" block). */
function useChatOrder(useChat) {
  const read = typeof useChat === 'function' ? useChat : NO_CHAT_SELECTOR
  return read((snapshot) => snapshot?.order)
}

/** Collapse whitespace and cap one excerpt at `max` chars (display hint). */
function clipText(text, max = 60) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/** Host chat-node text extraction (mirrors dsh-client-ui-chat: user `data.content`
 * blocks with `type:'text'`, assistant `data.blocks` with `kind:'text'`). */
function nodeTextOf(node) {
  const data = node?.data
  if (data === null || typeof data !== 'object') return ''
  const blocks = node.kind === 'user-message' ? data.content : data.blocks
  if (!Array.isArray(blocks)) return ''
  let out = ''
  for (const block of blocks) {
    if (block && (block.type === 'text' || block.kind === 'text') && typeof block.text === 'string') {
      out += (out ? ' ' : '') + block.text
    }
  }
  return out.replace(/\s+/g, ' ').trim()
}

/**
 * R22 — the anchor seq of the LAST live node (the newest message on the current
 * path). The quiet rows' action is PURE naviation to this seq: no rollback call,
 * no scope selector, nothing destructive. `null` when the surface is empty (the
 * button is then a no-op instead of a broken jump).
 */
function latestSeqOf(nodes, order) {
  if (!(nodes instanceof Map)) return null
  const keys = Array.isArray(order) ? order : [...nodes.keys()]
  for (let i = keys.length - 1; i >= 0; i -= 1) {
    const node = nodes.get(keys[i])
    if (node && typeof node.anchorSeq === 'number') return node.anchorSeq
  }
  return null
}

/**
 * The live current path as rounds: each `user-message` opens a round, the next
 * `assistant-step` closes it. ONLY current-surface nodes appear here (discarded
 * nodes are not in the derived surface), which is exactly why these rows are the
 * only jumpable ones. Returns [{ n, seq, question, answer }].
 */
function roundsOf(nodes, order) {
  if (!(nodes instanceof Map)) return []
  const keys = Array.isArray(order) ? order : [...nodes.keys()]
  const rounds = []
  let open = null
  for (const key of keys) {
    const node = nodes.get(key)
    if (node === undefined || node === null) continue
    if (node.kind === 'user-message') {
      if (open !== null) rounds.push(open)
      open = { n: rounds.length + 1, seq: node.anchorSeq, question: clipText(nodeTextOf(node)), answer: '' }
    } else if (node.kind === 'assistant-step' && open !== null) {
      open.answer = clipText(nodeTextOf(node))
    }
  }
  if (open !== null) rounds.push(open)
  return rounds
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/** 撤回 / 重新生成 strip inside a finalized assistant reply's IconActions row. */
function AssistantActions({ messageId, sessionId, useChat, t }) {
  const seq = useMessageSeq(useChat, messageId)
  const hidden = useSeqHidden(useChat, seq)
  const shadowed = useShadowed(useChat, seq)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState(null)
  // Hidden (visually) or shadowed (un-editable: recalled/edited/compacted
  // away) messages must not offer recall/regenerate — the host would reject
  // with target-shadowed.
  if (hidden || shadowed || seq === undefined) return null

  const run = (op) => {
    setBusy(true)
    setFailure(null)
    callOp(op, { sessionId, messageId }).then(
      (result) => {
        setBusy(false)
        if (!result || result.ok !== true) {
          const message = result?.error?.message || 'Operation failed; please try again'
          const code = result?.error?.code
          setFailure(opFailureText(code, message, t))
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
function ReferenceRow({ node, useChat, t }) {
  const { seq, messageId } = node.data
  // The reference node anchors at seq-0.5 (above the message) and never
  // appears in any hide rule — judge by the REAL message seq so a shadowed
  // re-send's reference disappears with it (0.4.4 regression: judging by the
  // node key left stale "original input" blocks after a second edit).
  const hidden = useSeqHidden(useChat, seq)
  const markerRef = useEditReference(useChat, seq)
  const referenceText = editReferences.get(messageId) ?? markerRef
  const config = useConfig()
  if (hidden) return null
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
function UserActionsRow({ node, sessionId, useChat, inputActions, t }) {
  const { seq, messageId, content } = node.data
  // Two independent dimensions: visual hiding (guard-protected, row stays
  // visible when degraded) vs operation feasibility (a shadowed message can
  // never be edited again — the host rejects with target-shadowed). Hide the
  // edit/recall entries when EITHER applies, so compacted or recalled rows
  // that remain visible don't offer operations that would just fail.
  const hidden = useSeqHidden(useChat, seq)
  const shadowed = useShadowed(useChat, seq)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState(null)
  if (hidden || shadowed) return null

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
      setFailure(opFailureText(code, result?.error?.message ?? null, t))
      return
    }
    // 防御分支（两段结构改造后 host 不再返回该标注：载体是 user/message，token-meter
    // 对它没有 step 配对要求）——旧版 host 仍可能返回，故保留展示路径。
    if (result.value?.markerT1Broken === true) {
      setFailure(t('marker.t1Broken'))
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
function RecallMarkerRow({ node, useChat, t }) {
  const { seq, op, shadowedSeqs, legacy, compact } = node.data
  // Rules of Hooks: both hooks run UNCONDITIONALLY, before any early return.
  // `compact` only decides the render below; compaction checkpoints still render
  // nothing and never enter the hide table (useMarkerHidePlan skips compact
  // markers itself), so moving the calls changes no outward behaviour.
  const dismissed = useMarkerDismissed(useChat, seq, op)
  const hidePlan = useMarkerHidePlan(useChat)
  // Compaction checkpoints render nothing here: their only role is feeding
  // useShadowed so compacted messages lose their edit/recall entries.
  if (compact) return null
  const plan = hidePlan.planFor(node.key)
  const hiddenKeys = legacy || !getConfig().hideShadowed ? null : (plan?.keys ?? null)

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
  // A per-marker safety-guard trip (e.g. "start a fresh conversation") and a
  // collective-hide hint appear once, on the first marker row.
  const degradedHint = !legacy && plan?.degraded === true
    ? createElement('div', { key: 'degraded', className: 'dsh-rt-marker-hint' }, t('marker.degradedHint'))
    : null
  const unionHint = !legacy && hidePlan.firstMarkerKey === node.key && hidePlan.rowCount > SHADOW_MIN_ROWS_FOR_RATIO && hidePlan.unionRatio > SHADOW_SAFETY_RATIO
    ? createElement('div', { key: 'union', className: 'dsh-rt-marker-hint' },
        t('marker.unionHint', { count: Math.round(hidePlan.unionRatio * 100) }))
    : null

  return createElement('div', { className: 'dsh-rt-marker-block', 'data-dismissed': dismissed || undefined }, [
    css !== null && createElement('style', { key: 'hide', dangerouslySetInnerHTML: { __html: css } }),
    !dismissed && createElement('div', { key: 'label', className: 'dsh-rt-marker', role: 'status' }, label),
    !dismissed && degradedHint,
    !dismissed && unionHint,
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
    optionRow('summary', 'options.summary', 'options.summaryDesc'),
    optionRow('git', 'options.git', 'options.gitDesc'),
    optionRow('closeGuard', 'options.closeGuard', 'options.closeGuardDesc'),
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
.dsh-rt-marker-hint{text-align:center;color:var(--dsw-alias-state-warning-primary);font-size:11px;line-height:16px;margin-top:2px}
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
/* ---- P1 timeline (conversation view tab) ---- */

.dsh-rt-view{box-sizing:border-box;display:flex;flex-direction:column;gap:6px;flex:1 1 0%;min-height:0;overflow:hidden;padding:12px 16px 0}
.dsh-rt-timeline-head{display:flex;align-items:center;gap:8px;flex:none}
.dsh-rt-timeline-title{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;line-height:20px;flex:1}
.dsh-rt-view-intro{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;flex:none;padding:2px 0 4px}
/* 页首：这是什么（带次数）+ 顺序提示 */
.dsh-rt-intro-order{color:var(--dsw-alias-label-tertiary);margin-left:6px}
/* 第二行的口径前缀 */
.dsh-rt-what-label{flex:none;color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px}
/* 行尾「›」：这一档可以点开 */
/* 逐级引导线：文本里仍是「│ 」（复制成纯文本也读得出来），画面上是一条该级配色的
   细色条——缩进不靠量像素，色条本身就说清"谁在谁下面"。 */
.dsh-rt-indent-guide{flex:none;display:inline-block;width:3px;height:16px;margin:0 7px 0 0;border-radius:2px;overflow:hidden;color:transparent;font-size:1px;line-height:1px;white-space:pre;align-self:center}
.dsh-rt-indent-guide-1{background:var(--dsw-alias-label-secondary)}
.dsh-rt-indent-guide-2{background:var(--dsw-alias-state-warning-primary)}
.dsh-rt-indent-guide-3{background:var(--dsw-alias-state-info-primary)}
/* 展开层内悬浮收起条：sticky + 高度 0 ⇒ 视觉上钉在列表视口顶部，但不占内容高度
   （虚拟化的前缀和只由行模型决定；任何进流元素都会让 offsets 与渲染错位）。 */
.dsh-rt-collapse-hint{position:sticky;top:6px;height:0;display:flex;justify-content:center;align-items:flex-start;z-index:3;pointer-events:none}
.dsh-rt-collapse-hint-btn{pointer-events:auto;box-shadow:0 2px 8px var(--dsw-alias-bg-mask,rgba(0,0,0,.18));background:var(--dsw-alias-bg-elevated,var(--dsw-alias-bg-base));border:1px solid var(--dsw-alias-border-l2)}
.dsh-rt-what-none{color:var(--dsw-alias-label-secondary);font-style:normal}
.dsh-rt-what-jump{background:none;border:0;padding:0;margin:0;font:inherit;color:var(--dsw-alias-state-info-primary);cursor:pointer;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
.dsh-rt-what-jump:hover{text-decoration:underline}
.dsh-rt-line-sep{flex:none;color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px}
.dsh-rt-version-round{flex:none;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}
.dsh-rt-row-open{flex:none;background:transparent;border:none;padding:0 2px;margin-top:1px;cursor:pointer;color:var(--dsw-alias-label-tertiary);font-size:14px;line-height:16px}
.dsh-rt-row-open:hover{color:var(--dsw-alias-label-primary)}
/* 面板级错误边界：坏的是这一块（不是整页） */
.dsh-rt-view-error{gap:6px;padding:12px}
.dsh-rt-error-title{color:var(--dsw-alias-state-error-primary);font-size:13px;font-weight:600;line-height:20px}
.dsh-rt-error-detail{margin:0;color:var(--dsw-alias-label-tertiary);font-family:var(--dsw-font-mono);font-size:11px;line-height:16px;white-space:pre-wrap;word-break:break-all}
.dsh-rt-error-retry{align-self:flex-start}
/* Filtered host-side replacements: one muted line, never a timeline row. */
.dsh-rt-host-note{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;flex:none;padding:2px 0}
.dsh-rt-timeline-git{display:flex;align-items:center;gap:6px;flex:none;border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;padding:4px 8px}
.dsh-rt-doctor{border-color:var(--dsw-alias-state-warning-primary);background:var(--dsw-alias-state-warn-tertiary)}
.dsh-rt-doctor .dsh-rt-timeline-git-text{color:var(--dsw-alias-state-warning-primary)}
.dsh-rt-timeline-git-text{color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px}
.dsh-rt-timeline-list{overflow-y:auto;flex:1;min-height:0;position:relative;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2)}
.dsh-rt-timeline-empty{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;padding:12px 4px;text-align:center}
.dsh-rt-version{position:absolute;left:0;right:0;height:60px;box-sizing:border-box;display:flex;align-items:flex-start;gap:8px;border:1px solid transparent;border-radius:10px;padding:6px 8px;overflow:hidden}
.dsh-rt-version:hover{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l2)}
.dsh-rt-version-kind{flex:none;width:22px;height:22px;display:inline-flex;justify-content:center;align-items:center;border-radius:6px;background:var(--dsw-alias-fill-l2);color:var(--dsw-alias-label-secondary);font-size:12px;margin-top:1px}
.dsh-rt-version-kind-restore{background:var(--dsw-alias-state-success-bg);color:var(--dsw-alias-state-success-primary)}
.dsh-rt-version-kind-compaction{background:var(--dsw-alias-fill-l2);color:var(--dsw-alias-label-caption)}
.dsh-rt-version-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.dsh-rt-version-line{display:flex;align-items:center;gap:8px;min-width:0;white-space:nowrap}
.dsh-rt-version-kind-label{color:var(--dsw-alias-label-primary);font-size:12px;font-weight:600;line-height:16px}
.dsh-rt-version-time,.dsh-rt-version-msgs{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
/* 紧凑行首行的计数（原正文里的 impact 行已并入这里，同一信息不占两行） */
.dsh-rt-version-count{flex:none;color:var(--dsw-alias-state-warning-primary);font-size:11px;line-height:16px}
.dsh-rt-version-files{color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px;overflow:hidden;text-overflow:ellipsis}
/* ---- boundary digest (what): verbatim quotes vs optional AI summary ---- */
.dsh-rt-what-quote{display:flex;align-items:baseline;gap:6px;min-width:0;font-size:11px;line-height:16px;white-space:nowrap;overflow:hidden;overflow-wrap:anywhere}
.dsh-rt-what-role,.dsh-rt-what-seq{flex:none;color:var(--dsw-alias-label-caption);font-size:11px}
.dsh-rt-what-text{min-width:0;overflow:hidden;text-overflow:ellipsis;font-family:var(--dsw-font-mono)}
.dsh-rt-what-more{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
/* NEW path = emphasized accent (proposal green) */
.dsh-rt-what-new{border-left:2px solid var(--dsw-alias-state-success-primary);padding-left:6px;background:var(--dsw-alias-state-success-bg);border-radius:0 6px 6px 0;color:var(--dsw-alias-state-success-primary)}
.dsh-rt-what-new .dsh-rt-what-text{color:var(--dsw-alias-state-success-primary);text-decoration:none}
.dsh-rt-what-new-tag{flex:none;font-size:10px;line-height:16px;color:var(--dsw-alias-state-success-primary);font-weight:600}
/* OLD path = muted grey + explicitly void (struck-through quote) */
.dsh-rt-what-old{border-left:2px solid var(--dsw-alias-border-l2);padding-left:6px;color:var(--dsw-alias-label-tertiary);opacity:.72}
.dsh-rt-what-old .dsh-rt-what-text{color:var(--dsw-alias-label-tertiary);text-decoration:line-through}
.dsh-rt-what-void{flex:none;font-size:10px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
/* AI summary = its own element, italic + faint background, never mixed with a quote */
.dsh-rt-what-summary{display:flex;align-items:baseline;gap:6px;min-width:0;font-size:11px;line-height:16px;font-style:italic;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-fill-l2);border-radius:6px;padding:0 6px;white-space:nowrap;overflow:hidden}
.dsh-rt-what-summary-tag{flex:none;font-size:10px;line-height:16px;font-weight:600;font-style:normal;color:var(--dsw-alias-label-caption)}
.dsh-rt-what-summary-text{min-width:0;overflow:hidden;text-overflow:ellipsis}
/* ---- outline nesting: level colours (host alias tokens → both themes) ---- */
.dsh-rt-level-1{border-left:3px solid var(--dsw-alias-label-secondary)}
.dsh-rt-level-2{border-left:3px solid var(--dsw-alias-state-warning-primary)}
.dsh-rt-level-3{border-left:3px solid var(--dsw-alias-state-info-primary)}
.dsh-rt-current{border-left:3px solid var(--dsw-alias-state-success-primary)}
.dsh-rt-level-1 .dsh-rt-version-kind-label,.dsh-rt-level-1 .dsh-rt-tree-hint{color:var(--dsw-alias-label-secondary)}
.dsh-rt-level-2 .dsh-rt-version-kind-label,.dsh-rt-level-2 .dsh-rt-tree-hint{color:var(--dsw-alias-state-warning-primary)}
.dsh-rt-level-3 .dsh-rt-version-kind-label,.dsh-rt-level-3 .dsh-rt-tree-hint{color:var(--dsw-alias-state-info-primary)}
.dsh-rt-current .dsh-rt-version-kind-label{color:var(--dsw-alias-state-success-primary)}
.dsh-rt-tree-toggle{position:absolute;left:0;right:0;height:60px;box-sizing:border-box;display:flex;align-items:center;border:1px solid transparent;border-radius:10px;overflow:hidden}
.dsh-rt-tree-btn{color:var(--dsw-alias-label-tertiary);font-size:11px}
.dsh-rt-tree-hint{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
/* ---- plain-text row: a boundary with no digest content (quiet rows never
       land in the timeline, so no absolute-positioned quiet row exists) ---- */
.dsh-rt-fallback{position:absolute;left:0;right:0;height:60px;box-sizing:border-box;display:flex;align-items:center;gap:8px;border:1px solid transparent;border-radius:10px;padding:6px 8px;overflow:hidden}
.dsh-rt-plain-text{min-width:0;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* ---- R20/R24: bottom COLLAPSED block of quiet/simple changes ---- */
.dsh-rt-quiet-block{display:flex;flex-direction:column;gap:2px;flex:none;border-top:1px solid var(--dsw-alias-border-l2);padding-top:6px;margin-top:6px;max-height:132px;overflow:hidden}
.dsh-rt-quiet-head{display:flex;align-items:center;background:transparent;border:none;padding:0;cursor:pointer;font:inherit;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-rt-quiet-head:hover{color:var(--dsw-alias-label-secondary)}
.dsh-rt-quiet-list{display:flex;flex-direction:column;gap:1px;overflow-y:auto;min-height:0}
.dsh-rt-quiet-row{display:flex;align-items:center;gap:6px;min-width:0}
.dsh-rt-quiet-row .dsh-rt-plain-text{color:var(--dsw-alias-label-tertiary)}
.dsh-rt-quiet-run{display:flex;flex-direction:column;gap:1px;min-width:0}
.dsh-rt-quiet-run-head{display:flex;align-items:center;gap:6px;min-width:0}
.dsh-rt-quiet-run-head .dsh-rt-plain-text{color:var(--dsw-alias-label-tertiary)}
.dsh-rt-quiet-run-list{display:flex;flex-direction:column;gap:1px;padding-left:14px;min-height:0}
.dsh-rt-quiet-btn{flex:none}
/* ---- R31: the always-visible start line of 「现在的路」 ---- */
.dsh-rt-path-start{display:flex;align-items:baseline;gap:6px;min-width:0}
.dsh-rt-path-start-tag{flex:none;color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px;font-weight:600}
.dsh-rt-path-start-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}
.dsh-rt-path-start-counts{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.dsh-rt-path-start-summary{display:flex;align-items:baseline;gap:6px;min-width:0;font-size:11px;line-height:16px;font-style:italic;color:var(--dsw-alias-label-secondary)}
.dsh-rt-path-start-summary-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* ---- 「现在的路」fixed bottom block ---- */
.dsh-rt-path{display:flex;flex-direction:column;gap:2px;flex:none;border-top:1px solid var(--dsw-alias-border-l2);padding-top:6px;margin-top:6px;max-height:132px;overflow:hidden}
.dsh-rt-path-title{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:600;line-height:18px;flex:none}
.dsh-rt-path-list{display:flex;flex-direction:column;gap:1px;overflow-y:auto;min-height:0}
.dsh-rt-path-row{display:flex;align-items:baseline;gap:6px;min-width:0;width:100%;box-sizing:border-box;background:transparent;border:none;border-radius:6px;padding:1px 4px;text-align:left;cursor:pointer;font:inherit}
.dsh-rt-path-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-rt-path-n{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.dsh-rt-path-q{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-state-success-primary);font-size:11px;line-height:16px}
.dsh-rt-path-arrow{flex:none;color:var(--dsw-alias-label-caption);font-size:11px}
.dsh-rt-path-a{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}
.dsh-rt-path-empty{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.dsh-rt-plain{overflow:hidden}
.dsh-rt-plain-note{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;flex:none}
.dsh-rt-path-head{display:flex;align-items:center;background:transparent;border:none;padding:0;cursor:pointer;font:inherit;color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:600;line-height:18px;text-align:left}
.dsh-rt-path-head:hover{color:var(--dsw-alias-label-primary)}
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
.dsh-rt-fork-badge-code{font-family:var(--dsw-font-mono);font-size:12px;font-weight:600;line-height:16px;color:var(--dsw-alias-state-info-primary);flex:none}
/* 关闭守卫:运行中横幅 / A 明细模态 / 放行提示(独立于会话视图) */
.dsh-rt-guard-banner{position:fixed;top:10px;right:10px;z-index:2147483000;max-width:min(430px,calc(100vw - 20px));background:var(--dsw-alias-bg-elevated,#262626);border:1px solid #b8860b;border-radius:10px;padding:8px 10px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary,#eee);box-shadow:0 4px 20px rgba(0,0,0,.4);display:flex;flex-direction:column;gap:4px;text-align:left}
.dsh-rt-guard-banner-head{display:flex;align-items:center;gap:6px;font-weight:600;color:#f0c674}
.dsh-rt-guard-banner-note{color:var(--dsw-alias-label-caption,#aaa);font-size:11px;line-height:16px}
.dsh-rt-guard-banner-list{margin:2px 0 0;padding:0 0 0 14px;color:var(--dsw-alias-label-primary,#eee);font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:11px;line-height:17px;white-space:pre-line}
.dsh-rt-guard-link{background:none;border:none;padding:0;color:var(--dsw-alias-state-info-primary,#7ab8ff);font-size:11px;cursor:pointer}
.dsh-rt-guard-link:hover{text-decoration:underline}
.dsh-rt-guard-btn{border:1px solid var(--dsw-alias-border-l2,#555);background:transparent;color:var(--dsw-alias-label-primary,#eee);border-radius:6px;padding:2px 10px;font-size:12px;line-height:20px;cursor:pointer}
.dsh-rt-guard-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}
.dsh-rt-guard-btn-primary{border-color:#a33;background:#8b1f1f;color:#fff;font-weight:600}
.dsh-rt-guard-btn-primary:hover{background:#a33}
.dsh-rt-guard-overlay{position:fixed;inset:0;z-index:2147483001;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:16px}
.dsh-rt-guard-modal{background:var(--dsw-alias-bg-elevated,#202020);border:1px solid #b8860b;border-radius:12px;max-width:min(520px,calc(100vw - 32px));padding:14px 16px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary,#eee);box-shadow:0 10px 40px rgba(0,0,0,.5);display:flex;flex-direction:column;gap:10px}
.dsh-rt-guard-modal-title{font-weight:700;color:#f0c674;font-size:14px}
.dsh-rt-guard-modal-lines{margin:0;padding:0 0 0 16px;font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:12px;line-height:19px;white-space:pre-line}
.dsh-rt-guard-modal-hint{color:var(--dsw-alias-label-caption,#aaa);font-size:11px;line-height:16px}
.dsh-rt-guard-modal-actions{display:flex;justify-content:flex-end;gap:8px}
.dsh-rt-guard-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483002;background:var(--dsw-alias-bg-elevated,#262626);border:1px solid var(--dsw-alias-border-l2,#555);border-radius:8px;padding:6px 12px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary,#eee);box-shadow:0 4px 16px rgba(0,0,0,.35);max-width:min(560px,calc(100vw - 24px))}
`

const JUMP_PAGE_BUDGET = 24

/**
 * Switch to a conversation view tab programmatically.
 *
 * The official API offers no setView to third-party views: `actions` is only
 * injected to entries that declare a `store`, and the chat store is private to
 * ui-conversation — so `actions?.setView?.(...)` silently no-ops for plugins
 * (0.4.2 relied on it; verified against the renderer source 2026-08-26). The
 * only programmatic path is clicking the tab-bar button — the same path a user
 * click takes. Tab buttons render in registration order (priority, then
 * order): chat=0, trajectory=10, retrace=20. A view with an
 * earlier order would shift the indices; verified on the real harness before
 * relying on the positions.
 */
function switchToViewTab(viewId) {
  const ORDER = { chat: 0, trajectory: 1, retrace: 2 }
  const index = ORDER[viewId]
  if (index === undefined) {
    console.warn(`[dsh-retrace] no tab order registered for "${viewId}"`)
    return
  }
  // Only VISIBLE tablists count — hidden tabbars (settings etc.) must not
  // shift the index (0.4.x review: a document-wide query could click the
  // wrong control). The conversation view's tab bar is the visible one.
  const buttons = [...document.querySelectorAll('[role="tablist"]')]
    .filter((tablist) => tablist.getBoundingClientRect().width > 0)
    .flatMap((tablist) => [...tablist.querySelectorAll('[role="tab"]')])
  const button = buttons[index]
  if (!button) {
    console.warn(`[dsh-retrace] tab "${viewId}" (index ${index}) not found in the conversation tab bar`)
    return
  }
  button.click()
}

/** Count chat nodes regardless of store shape (Map or iterator-only). */
function nodeCountOf(nodes) {
  if (!nodes) return 0
  if (typeof nodes.size === 'number') return nodes.size
  return [...nodes.values()].length
}

/** rAF poll for an element that appears after a view switch + render pass. */
function waitForElement(selector, frames) {
  return new Promise((resolve) => {
    let remaining = frames
    const probe = () => {
      const el = document.querySelector(selector)
      if (el !== null) return resolve(el)
      if (remaining-- <= 0) return resolve(null)
      requestAnimationFrame(probe)
    }
    requestAnimationFrame(probe)
  })
}

/** One-shot highlight for the jumped-to row (removes itself). */
function flashKey(key) {
  const id = `dsh-rt-jump-${key.replace(/[^a-z0-9]/gi, '-')}`
  if (document.querySelector(`style[data-plugin-css="${id}"]`)) return
  const tag = document.createElement('style')
  tag.dataset.pluginCss = id
  tag.textContent = `[data-chat-anchor-key=${JSON.stringify(key)}]{animation:dsh-rt-flash 1.6s ease-out 2}@keyframes dsh-rt-flash{0%,100%{background:transparent}30%,70%{background:var(--dsw-alias-state-business-primary)}55%{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 30%,transparent)}}`
  document.head.appendChild(tag)
  setTimeout(() => tag.remove(), 3400)
}

/**
 * The chat-node key whose anchor is `seq` (or null). `nodes` is the host chat
 * snapshot's node Map (`useChat((s) => s.nodes)`) — the only sanctioned source
 * for the `data-chat-anchor-key` mapping.
 */
function keyOfSeqIn(nodes, seq) {
  if (!nodes || typeof nodes.values !== 'function') return null
  for (const node of nodes.values()) {
    if (node && typeof node.anchorSeq === 'number' && node.anchorSeq === seq) return node.key
  }
  return null
}

/**
 * Resolve the chat anchor key for `seq`, paging the session window as needed.
 *
 * Node access is INJECTED (`readNodes`) because the node list lives in the
 * host's `useChat` snapshot and `useChat` is a React hook: it cannot be called
 * from this plain async function, and the client Session controller's
 * `getSnapshot()` carries no chat nodes at all (verified against
 * `@deepseek-ai/dsh-api-session-controller`: `lib/types/client/sessions/
 * session.js:416` returns `{sessionId, queue, running, hasMore, …}` with no
 * `chat`/`nodes`). The previous code walked `getSnapshot()` -> `.chat` ->
 * `.nodes` on that snapshot (neither member exists), so every jump silently
 * no-opped.
 *
 * Paging uses the host's official jump loader `store.loadThrough(seq)`
 * ("Jump loader: page backwards until the window covers seq", session.js:335)
 * when present, falling back to one-page `store.loadOlder()`.
 *
 * Deliberately free of React/DOM so the resolution logic is unit-testable.
 *
 * @returns {Promise<{key: string|null, reason: string, pages: number}>}
 */
async function resolveAnchorKey({ anchorSeq, store, readNodes, budget = 24, settle }) {
  if (typeof anchorSeq !== 'number') return { key: null, reason: 'bad-seq', pages: 0 }
  if (typeof readNodes !== 'function') return { key: null, reason: 'no-node-source', pages: 0 }
  const nodesOf = () => {
    try {
      return readNodes() ?? null
    } catch {
      return null
    }
  }
  let key = keyOfSeqIn(nodesOf(), anchorSeq)
  if (key !== null) return { key, reason: 'already-loaded', pages: 0 }
  const canThrough = typeof store?.loadThrough === 'function'
  const canOlder = typeof store?.loadOlder === 'function'
  if (!canThrough && !canOlder) return { key: null, reason: 'no-load-api', pages: 0 }
  let pages = 0
  if (canThrough) {
    // A loader that throws must still reach the diagnosable path, never an
    // unhandled rejection out of jumpToAnchor.
    try {
      await store.loadThrough(anchorSeq)
    } catch {
      return { key: null, reason: 'load-failed', pages }
    }
    pages += 1
    if (typeof settle === 'function') await settle()
    key = keyOfSeqIn(nodesOf(), anchorSeq)
    if (key !== null) return { key, reason: 'load-through', pages }
  }
  // One-page fallback for hosts without the jump loader; bounded by `budget`.
  while (key === null && canOlder && pages < budget && store.hasMore !== false) {
    const before = nodeCountOf(nodesOf())
    try {
      await store.loadOlder()
    } catch {
      return { key: null, reason: 'load-failed', pages }
    }
    pages += 1
    if (typeof settle === 'function') await settle()
    if (nodeCountOf(nodesOf()) === before) break // empty page: stop, do not spin
    key = keyOfSeqIn(nodesOf(), anchorSeq)
  }
  return key === null
    ? { key: null, reason: 'seq-not-in-window', pages }
    : { key, reason: 'paged', pages }
}

/**
 * A jump that cannot complete must NOT be silent: emit one structured renderer
 * warning plus one host-log line through the existing `clientReport` channel
 * (the client half's only route into the host log — `lib/http.js:527` prints
 * `source` verbatim). Diagnostics never throw into the click path.
 */
function reportJumpUnavailable(reason, detail = {}) {
  const context = `reason=${reason} seq=${String(detail.anchorSeq)} pages=${Number(detail.pages) || 0}`
    + ` nodeSource=${detail.hasNodeSource === false ? 'missing' : 'present'}`
    + (detail.key ? ` key=${detail.key}` : '')
  console.warn(`[dsh-retrace] jump to anchor unavailable (${context})`)
  try {
    const sent = callOp('clientReport', { id: name, source: `jump-unavailable:${reason}` })
    if (sent && typeof sent.catch === 'function') sent.catch(() => { /* log only */ })
  } catch { /* diagnostics must never break the click path */ }
}

/**
 * Shared jump (checkpoint view): resolve the anchor key FIRST, then
 * switch to the chat tab and scroll the rendered row into view.
 *
 * ORDER IS LOAD-BEARING: `readNodes` is the CALLING view's `useChat` ref, and
 * the host renders one conversation view at a time
 * (`renderSlot('conversation.view', …, { only: active.id })`), so a tab switch
 * UNMOUNTS this view and freezes that ref. Resolving first keeps the `useChat`
 * subscription alive while the store pages the window; paging itself is
 * session-level (`store`) and does not need the chat view mounted. Resolving
 * after the switch only ever worked when the target was already loaded — the
 * paging path (`loadThrough`) always saw the frozen map.
 *
 * Failure semantics — TWO different cases, NOT one rule:
 *  - key UNRESOLVED (`no-node-source` / `no-load-api` / `load-failed` /
 *    `seq-not-in-window`): we never switched tabs, so the user STAYS on the
 *    current view. Switching would unmount it without being able to show the
 *    target — the only effect would be losing context.
 *  - key RESOLVED but the row did not render within the frame budget
 *    (`row-not-rendered`): the tab HAS been switched, so the user is ALREADY on
 *    the chat view; only the scroll/highlight is missing. We report it and stay
 *    there: the target is in the loaded window, and the plugin has no reliable
 *    programmatic way back (see `switchToViewTab`), so switching back would
 *    just hide the loaded target.
 *
 * `readNodes` is supplied by the calling view component from its `useChat`
 * standard prop — a React hook cannot be called here.
 */
async function jumpToAnchor(store, anchorSeq, readNodes) {
  const { key, reason, pages } = await resolveAnchorKey({
    anchorSeq,
    store,
    readNodes,
    budget: JUMP_PAGE_BUDGET,
    // Let the node source re-render (React commit) before reading it again.
    settle: () => new Promise((resolve) => { setTimeout(resolve, 60) }),
  })
  if (key === null) {
    reportJumpUnavailable(reason, {
      anchorSeq,
      pages,
      hasNodeSource: typeof readNodes === 'function',
    })
    return
  }
  // Key known: switch to the chat view (this unmounts the calling view), then
  // poll for its rendered row.
  switchToViewTab('chat')
  const el = await waitForElement(`[data-chat-anchor-key=${JSON.stringify(key)}]`, 90)
  if (el === null) {
    // The tab was already switched (above): the user is on the chat view, only
    // the scroll/highlight is missing. Report it — do not pretend the jump
    // stayed on the original view.
    reportJumpUnavailable('row-not-rendered', { anchorSeq, pages, key })
    return
  }
  el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  flashKey(key)
}

/**
 * Bound a windowed list to the available height.
 *
 * The conversation view area is a flex chain whose middle (`viewArea`,
 * `flex:1 0 auto; min-height:auto`) grows to CONTENT — a virtualized list's
 * tall spacer (N × rowHeight) inflates the whole view to the full list height,
 * so the list never scrolls and the window slice never moves (verified on the
 * real harness 2026-08-26; the official trajectory view avoids this because
 * its virtualized content contributes no tall spacer). Measuring the list
 * height against the viewport and setting it explicitly caps the spacer's
 * contribution — the view then collapses back to the bounded height.
 */
function bindListHeight(listEl) {
  if (!listEl) return () => {}
  const measure = () => {
    const top = listEl.getBoundingClientRect().top
    const height = Math.max(120, window.innerHeight - top - 16)
    if (Math.abs(listEl.clientHeight - height) > 4) {
      // The list is a flex item (flex:1 → flex-basis:0%); a plain height is
      // ignored by the flex layout, so pin it with flex:none.
      listEl.style.flex = 'none'
      listEl.style.height = `${height}px`
    }
  }
  measure()
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
  ro?.observe(document.body)
  window.addEventListener('resize', measure)
  return () => {
    ro?.disconnect()
    window.removeEventListener('resize', measure)
  }
}

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
/** Every kind `classifyBoundaryKind` can emit (lib/version-index.js). */
const BOUNDARY_KINDS = new Set(['recall', 'edit', 'regenerate', 'restore', 'compaction', 'replace'])

function kindLabel(kind, t) {
  return t(`timeline.kind.${kind}`) || kind
}

/**
 * One plain-language line explaining why a boundary happened and what it did —
 * the row's self-description when the record carries no marker text. Falls back
 * to `replace` for any unexpected kind so the row never shows a bare i18n key.
 */
function whyLabel(kind, t) {
  return t(`timeline.why.${BOUNDARY_KINDS.has(kind) ? kind : 'replace'}`)
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

/** Format the artifact-count badge. Returns null when `what.artifacts` is absent
 * (the line must then NOT render at all — never `0/0/0`). */
/** Whether a digest carries an artifact line at all (missing ⇒ never 0/0/0). */
function hasArtifacts(artifacts) {
  return artifacts !== undefined && artifacts !== null && typeof artifacts === 'object'
}

function artifactsLabel(artifacts, t) {
  if (!hasArtifacts(artifacts)) return null
  return t('timeline.files', {
    created: artifacts.created ?? 0,
    modified: artifacts.modified ?? 0,
    deleted: artifacts.deleted ?? 0,
  })
}

/** Human role phrase for one `what.replaced[]` entry. */
const ROLE_LABEL_KEYS = { user: 'what.role.user', assistant: 'what.role.assistant', tool: 'what.role.tool' }
/** 用户视角的角色措辞（行里用；旧的 `what.role.*` 保留给别处与既有用例）。 */
/** 轮次（人读）：只认 ≥1 的整数（真机 turn 从 1 起）；0/缺失都返回 null。 */
function roundOf(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

const ROLE2_LABEL_KEYS = { user: 'what.role2.user', assistant: 'what.role2.assistant', tool: 'what.role2.tool' }
function roleLabel2(role, t) {
  return t(ROLE2_LABEL_KEYS[role] ?? 'what.role2.unknown')
}

function roleLabel(role, t) {
  return t(ROLE_LABEL_KEYS[role] ?? 'what.role.unknown')
}

/**
 * The boundary digests ("what did this boundary change") + optional LLM
 * summaries. They are NOT in the projection wire: `what` lives in the plugin's
 * OWN artifact, so the client fetches it once per view open and merges by
 * boundarySeq (`GET /summaries` — a pure read, no LLM call ever happens here).
 * A missing/failed read degrades to `null` (rows fall back to the plain counts).
 */
function fetchBoundaryDigests(sessionId) {
  return timelineGet(`/summaries?sessionId=${encodeURIComponent(sessionId)}`)
    .then((body) => (body && body.ok === true && body.value ? body.value : null))
    .catch(() => null)
}

/** boundarySeq → digest record Map (empty Map when the read returned nothing). */
function indexDigests(value) {
  const records = Array.isArray(value?.records) ? value.records : []
  return new Map(records.map((record) => [record.boundarySeq, record]))
}

/**
 * Normalize the server outline forest (`value.tree`, lib/boundary-tree.js) into a
 * Map. The server already decided nesting with EXACT set membership; the client
 * only follows `parent`/`children` links and never infers from numeric ranges.
 * `null` when the field is absent (old artifacts) ⇒ the caller renders flat.
 */
function indexTree(value) {
  const raw = value?.tree
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const map = new Map()
  for (const [key, node] of Object.entries(raw)) {
    const seq = Number(key)
    if (!Number.isSafeInteger(seq) || node === null || typeof node !== 'object') continue
    map.set(seq, {
      parent: Number.isSafeInteger(node.parent) ? node.parent : null,
      children: Array.isArray(node.children) ? node.children.filter((child) => Number.isSafeInteger(child)) : [],
      discardedCount: Number.isSafeInteger(node.discardedCount) ? node.discardedCount : null,
    })
  }
  return map.size > 0 ? map : null
}

/** Nesting levels that get their own colour (L1..L3); deeper folds to a hint. */
const TREE_MAX_LEVEL = 3

/**
 * How many levels a node has been granted (2026-09-15 deep-level fix).
 *
 * The tree stops at `TREE_MAX_LEVEL` levels; a node below the cap shows a
 * clickable 「还有 N 层」 entry instead of a dead end. `true` is the legacy
 * "opened one level" value (rows already used a boolean Map).
 */
function budgetOf(value, fallback = 0) {
  if (value === true) return 1
  if (value === false) return 0
  if (Number.isInteger(value)) return value > 0 ? value : 0
  return fallback
}

/**
 * Compact row height: exactly TWO text lines (动作·时间·计数 + 一条内容行).
 * Must stay in sync with the three row heights in the stylesheet
 * (`.dsh-rt-version` / `.dsh-rt-tree-toggle` / `.dsh-rt-fallback`).
 */
const ROW_H = 60
/** One extra detail line revealed by the row-level › entry. */
const DETAIL_H = 18
/**
 * Content lines shown WITHOUT expanding (2026-09-15 reading order): ② 现在这条
 * and ③ 原来的内容. Both must be readable in the compact row — an entry whose
 * anchor is hidden behind a click is exactly what the reader complained about.
 * Everything past these goes into the expandable detail block.
 */
const SHOWN_CONTENT_LINES = 2

/** One indent step per granted depth level (user decision 2026-09-15: the step
 * follows how deep the user has opened, it does NOT stop at the 3rd level —
 * a deep chain must not look flat again). */
const INDENT_PX = 14
/** Sanity cap only (a 9-level chain = 126px); effectively "no cap" in practice. */
const INDENT_MAX_LEVEL = 12
/**
 * 给悬浮收起条用的视口高度估计（与虚拟窗口里那处 `scrollTop + 640` 同值：那个
 * 640 被渲染卡死回归锁钉在源码里，这里不重复引用它，只保持同一个量级）。
 * 只影响"展开层是否横跨视口"的判定，不参与任何行高/offsets。
 */
const LIST_VIEWPORT_H = 640

/**
 * Left padding of one row: `已放开深度 × 14px`.
 * NOTE: indentation is DEPTH, colour is CLASS — they are deliberately separate
 * (`levelClassOf` keeps three colours so a deep chain does not turn into a
 * rainbow).
 */
/** 纯文本层级引导符：每级一个 `│ `（可复制、可读屏）。 */
/** The plain-text guide of one level: `│ ` (copy-paste keeps the hierarchy). */
function indentGuide(level) {
  const depth = Number.isFinite(level) && level > 0 ? Math.floor(level) : 0
  return '\u2502 '.repeat(Math.min(depth, INDENT_MAX_LEVEL))
}

/**
 * One guide per OPENED level: `│ ` glyphs, each with its own level colour class.
 * CSS draws each of them as a thin coloured bar, so "who is under whom" no longer
 * depends on measuring 14px (user feedback 2026-09-15: 14px 被图标和文字淹没).
 * Colours still stop at three levels (`TREE_MAX_LEVEL`); the bars do not.
 */
function guideSpans(level) {
  const depth = Number.isFinite(level) && level > 0 ? Math.floor(level) : 0
  const spans = []
  for (let step = 1; step <= Math.min(depth, INDENT_MAX_LEVEL); step += 1) {
    spans.push(createElement('span', {
      key: `guide-${step}`,
      className: `dsh-rt-indent-guide dsh-rt-indent-guide-${Math.min(step, TREE_MAX_LEVEL)}`,
    }, indentGuide(1)))
  }
  return spans
}

function indentOf(level) {
  const depth = Number.isFinite(level) && level > 0 ? Math.floor(level) : 0
  return `${Math.min(depth, INDENT_MAX_LEVEL) * INDENT_PX}px`
}

/**
 * The colour class of one row: L1/L2/L3 keep their own colour and everything
 * deeper REUSES L3 (`TREE_MAX_LEVEL` is a colour cap, not an indent cap).
 */
function levelClassOf(level) {
  const depth = Number.isFinite(level) && level >= 1 ? Math.floor(level) : 0
  return depth === 0 ? '' : ` dsh-rt-level-${Math.min(depth, TREE_MAX_LEVEL)}`
}

/**
 * THE height of one display row — the ONLY place a row height is decided.
 *
 * Every `kind` has an explicit finite budget and an unknown kind falls back to
 * `ROW_H`, so no future row kind can ever produce `undefined`/`NaN` here.
 * 2026-09-15 white-screen incident: a non-finite height made the prefix-sum
 * offsets NaN and the window search inconsistent; the row model and the row
 * renderer now BOTH call this function, so they cannot drift apart either.
 *
 * The compact row reserves one line per shown content line (② / ③) and one more
 * per detail line while the row is open, so nothing is ever clipped.
 *
 * @param {{kind?:string, detailOpen?:boolean, detailCount?:number, contentCount?:number}} row
 * @returns {number} a finite pixel height
 */
function rowHeightOf(row) {
  if (row?.kind === 'row') {
    const content = Number.isFinite(row.contentCount) && row.contentCount > 0 ? Math.floor(row.contentCount) : 1
    const shown = Math.min(SHOWN_CONTENT_LINES, content)
    const detail = row.detailOpen === true && Number.isFinite(row.detailCount) && row.detailCount > 0
      ? Math.floor(row.detailCount)
      : 0
    return ROW_H + Math.max(0, shown - 1) * DETAIL_H + detail * DETAIL_H
  }
  // collapsed / expanded / depth / fallback / unknown → exactly one compact row.
  return ROW_H
}

/**
 * Build the outline display list from the ordered boundary records plus the
 * server forest. Rows are `{kind: 'row'|'fallback'|'collapsed'|'depth', …}`.
 *
 * - `tree === null` ⇒ every row is a level-0 current-path row (flat).
 * - A node with children collapses to `还有 N 次改动`; expanding shows ONE level.
 *   Level > 3 folds to a `还有 N 层` hint.
 * - Nested rows never render 「延续」 (those paths have no continuation).
 * - R20: a QUIET change (`digest.quiet === true`, the server's explicit marker)
 *   takes NO main-timeline row at all. It still keeps the outline skeleton
 *   (children stay reachable through the collapsed hint) because dropping the
 *   node would break the tree (server tree is byte-identical to the baseline
 *   only when the quiet scaffolding row exists). The quiet changes themselves
 *   are listed in the bottom collapsed 「简单改动」 block.
 * - A boundary with no digest content renders as a plain-text `fallback` row
 *   (never blank): `quiet === true` is not the same as "no what".
 * Nesting is NEVER inferred by the client (no numeric ranges) — only the
 * server's `parent`/`children` links are followed.
 */
function buildDisplayRows({ versions, digests, tree, expanded, detailOpen = null, t = null }) {
  const list = Array.isArray(versions) ? versions : []
  // `t` is only used to detect the artifact line; a key-echo fallback keeps the
  // row model callable from tests (the LINE COUNT is translation-independent).
  const tr = typeof t === 'function' ? t : (key) => key
  const digestOf = (seq) => (digests instanceof Map ? digests.get(seq) : undefined)
  // R20: quiet = the server's EXPLICIT structural marker (`quiet:true`): the four
  // summary gates all failed AND the artifact counts are a definite 0/0/0. A
  // missing digest is NOT quiet (it is an unreadable/old boundary and must stay
  // visible as a plain-text row).
  const isQuiet = (seq) => digestOf(seq)?.quiet === true
  const nodeOf = (seq) => (tree instanceof Map ? tree.get(seq) : undefined)
  const childrenOf = (seq) => nodeOf(seq)?.children ?? []
  const isNested = (seq) => { const node = nodeOf(seq); return node !== undefined && node.parent !== null }
  const depthBelow = (seq, seen = new Set()) => {
    if (seen.has(seq)) return 0
    seen.add(seq)
    const kids = childrenOf(seq)
    return kids.length === 0 ? 0 : 1 + Math.max(...kids.map((kid) => depthBelow(kid, seen)))
  }
  const descendants = (seq, seen = new Set()) => {
    if (seen.has(seq)) return 0
    seen.add(seq)
    return childrenOf(seq).reduce((sum, kid) => sum + 1 + descendants(kid, seen), 0)
  }
  // `expanded` values are the per-node DEPTH BUDGET (levels opened below that
  // node; `true` is the legacy one-level form). DEFAULT: COLLAPSED for every node
  // — nothing auto-expands, the user clicks whichever row/chip they want to open
  // (user decision 2026-09-15: "我们应该是默认收起——使用者点击才展开").
  // An explicit `false` (user collapsed it) and any positive number behave the
  // same way as before; per-node budgets still drive the 「还有 N 层」 entries.
  const grantedOf = (seq) => budgetOf(expanded instanceof Map ? expanded.get(seq) : undefined)
  const isExpanded = (seq) => grantedOf(seq) >= 1
  // A node may show its children when either the base allowance covers this
  // level, or the user has granted this node enough levels (one per click).
  const canOpen = (seq, level) => level < TREE_MAX_LEVEL + grantedOf(seq)
  const bySeq = new Map(list.map((record) => [record.boundarySeq, record]))
  const rows = []
  // EVERY row goes through here ⇒ every row carries a finite `height`.
  const push = (row) => { row.height = rowHeightOf(row); rows.push(row) }
  const emitNode = (seq, level) => {
    const record = bySeq.get(seq)
    if (record === undefined) return
    const kids = childrenOf(seq)
    if (isQuiet(seq)) {
      // R20: no main-timeline row. Keep the skeleton so nested content stays
      // reachable (the quiet node is a real node in the server forest).
      if (kids.length > 0) {
        if (!canOpen(seq, level)) {
          push({
            kind: 'depth', seq, level, granted: grantedOf(seq),
            remaining: depthBelow(seq), count: descendants(seq),
            // one click = exactly one more level, even for a node far below the cap
            next: Math.max(grantedOf(seq) + 1, level - TREE_MAX_LEVEL + 1),
          })
        } else if (isExpanded(seq)) {
          // 重复/无意义的输入（安静档）挂在谁下面就要缩进一级，彼此同级也没关系：
          // 子行落在 level + 1（此前是 level ⇒ 与父档对齐、看不出层级）。
          emitCollapseChips(seq, level + 1, kids)
        }
        else push({ kind: 'collapsed', seq, level: level + 1, granted: grantedOf(seq), remaining: depthBelow(seq), count: descendants(seq) })
      }
      return
    }
    const digest = digestOf(seq)
    const fallback = digest === undefined || digest === null || digest.what === undefined || digest.what === null
    // Compact two-line row. The detail block is one click away; its height is
    // reserved from the SAME line list the renderer walks (`whatLineList`), so
    // `overflow:hidden` can never eat content.
    const compactionBoundary = record.kind === 'compaction' || digest?.what?.op === 'compaction'
    const contentCount = fallback
      ? 1
      : Math.max(1, whatLineList(digest.what, summaryTextOf(digest), {
          suppressContinue: level > 0,
          artifacts: artifactsLabel(digest.what?.artifacts, tr),
          compaction: compactionBoundary,
          now: digest.now ?? record.now ?? null,
          kind: record.kind,
        }).lines.length)
    const detailCount = fallback ? 0 : Math.max(0, contentCount - SHOWN_CONTENT_LINES)
    const open = detailCount > 0 && detailOpen instanceof Map && detailOpen.get(seq) === true
    push({
      kind: fallback ? 'fallback' : 'row',
      record,
      digest,
      level,
      current: !isNested(seq),
      discardedCount: nodeOf(seq)?.discardedCount ?? null,
      // 轮次（人读）：来自摘要/派生记录；取不到就是 null ⇒ 行首整段省略
      turn: roundOf(digest?.turn) ?? roundOf(record.turn),
      // 「现在这条」来自读端（存储/派生记录都补过），没有就是 null
      now: digest?.now ?? record.now ?? null,
      granted: grantedOf(seq),
      contentCount,
      detailCount,
      detailOpen: open,
    })
    if (kids.length === 0) return
    if (!canOpen(seq, level)) {
      push({
        kind: 'depth', seq, level, granted: grantedOf(seq),
        remaining: depthBelow(seq), count: descendants(seq),
        next: Math.max(grantedOf(seq) + 1, level - TREE_MAX_LEVEL + 1),
      })
      return
    }
    if (!isExpanded(seq)) {
      push({ kind: 'collapsed', seq, level: level + 1, granted: grantedOf(seq), remaining: depthBelow(seq), count: descendants(seq) })
      return
    }
    // 真机反馈(2026-09-15)：展开后原入口被 children 取代 ⇒ "有展开没收起"。
    // 第三版反馈（2026-09-15）：收起入口要三处都有 —— **开头 + 末尾**各一枚（悬浮
    // 那枚在视图里，见 `collapseHintOf` / `CollapseHint`），否则用户得滚到底部才收得掉。
    emitCollapseChips(seq, level + 1, kids)
  }
  const emitGroup = (seqs, level) => { for (const seq of seqs) emitNode(seq, level) }
  /**
   * 展开层的两枚收起入口：**开头**（父行之下、子行之上）+ **末尾**（子行之后）。
   * 用户口径（2026-09-15）：「收起这个按钮 应该在开头、展开层内悬浮、尾部都有，
   * 要不必须到底部才能收起」。两枚是同一个动作（`onToggle(seq)`），只是位置不同；
   * 第三处（展开层内悬浮）在视图层，见 `collapseHintOf` / `CollapseHint`。
   */
  const emitCollapseChips = (seq, chipLevel, kids) => {
    const label = hintLabelOf(seq)
    const chip = (position) => push({
      kind: 'expanded', seq, level: chipLevel, granted: grantedOf(seq),
      count: descendants(seq), position, hintLabel: label,
    })
    chip('head')
    emitGroup(kids, chipLevel)
    chip('tail')
  }
  /** 悬浮收起条上写哪一档：优先"第 N 轮"（日志里取得到才有），否则动作名。 */
  const hintLabelOf = (seq) => {
    const turn = roundOf(digestOf(seq)?.turn) ?? roundOf(bySeq.get(seq)?.turn)
    return turn === null ? kindLabel(bySeq.get(seq)?.kind, tr) : tr('timeline.round', { n: turn })
  }
  emitGroup(list.map((record) => record.boundarySeq).filter((seq) => !isNested(seq)), 0)
  return rows
}

/**
 * First row index still visible at `scrollTop` (two rows of slack above).
 * Row heights are no longer uniform (an expanded row is taller), so the window
 * is found from the prefix-sum offsets instead of `scrollTop / ROW_H`.
 */
/**
 * 展开层内悬浮收起条的判定（纯函数，不参与行高/offsets）。
 *
 * 用户口径（2026-09-15）：收起入口三处都要有（开头 / 展开层内悬浮 / 末尾），
 * 否则用户得滚到底部才收得掉。开头/末尾两枚是**行**（见 `emitCollapseChips`）；
 * 第三枚是浮层：当某一档的展开层**横跨整个视口**（开头那枚已在视口上方、末尾那枚
 * 还在视口下方）时，用户在视口里能看到子行却够不到任何收起入口 ⇒ 给一个浮层入口。
 *
 * 返回最深的那一档（用户在看的通常是最内层），没有就返回 null，也不返回
 * `#seq` 之类的原始坐标。
 *
 * @param {{rows:object[], offsets:number[], scrollTop:number, viewportHeight:number}} input
 * @returns {{seq:number, level:number, label:string}|null}
 */
function collapseHintOf({ rows, offsets, scrollTop, viewportHeight }) {
  if (!Array.isArray(rows) || !Array.isArray(offsets)) return null
  if (!Number.isFinite(scrollTop) || !Number.isFinite(viewportHeight)) return null
  const bottom = scrollTop + Math.max(0, viewportHeight)
  let best = null
  for (let head = 0; head < rows.length; head += 1) {
    const row = rows[head]
    if (row?.kind !== 'expanded' || row.position !== 'head') continue
    let tail = -1
    for (let i = head + 1; i < rows.length; i += 1) {
      if (rows[i]?.kind === 'expanded' && rows[i].seq === row.seq && rows[i].position === 'tail') { tail = i; break }
    }
    if (tail < 0) continue
    const headBottom = (Number.isFinite(offsets[head]) ? offsets[head] : 0) + (row.height ?? ROW_H)
    const tailTop = Number.isFinite(offsets[tail]) ? offsets[tail] : 0
    if (headBottom > scrollTop) continue      // 开头那枚还在视口里 ⇒ 够得着
    if (tailTop < bottom) continue            // 末尾那枚已经进视口 ⇒ 够得着
    if (best === null || row.level > best.level) {
      best = { seq: row.seq, level: row.level, label: String(row.hintLabel ?? '') }
    }
  }
  return best
}

function visibleFrom(rows, offsets, scrollTop) {
  // Binary search (offsets are sorted): first row whose bottom edge is below
  // `scrollTop`. Keeps the 2026-08-30 regression fixed — never a per-row scan.
  let lo = 0
  let hi = rows.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (offsets[mid] + (rows[mid].height ?? ROW_H) <= scrollTop) lo = mid + 1
    else hi = mid
  }
  return Math.max(0, lo - 2)
}

/**
 * Clamp a computed row index into `[0, length]`.
 * Second line of defence (2026-09-15): the window search is exact, but any future
 * change that lets a non-finite height in must not be able to render a
 * non-existent row. `NaN`/negative → 0, beyond the end → `length`.
 */
function clampIndex(value, length) {
  // NaN / undefined / non-numbers → 0; +Infinity → length (the end of the list).
  if (typeof value !== 'number' || Number.isNaN(value)) return 0
  return Math.min(Math.max(value, 0), length)
}

/** One past the last row whose top edge is above `bottom` (two rows of slack). */
function visibleTo(rows, offsets, bottom) {
  let lo = 0
  let hi = rows.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (offsets[mid] < bottom) lo = mid + 1
    else hi = mid
  }
  return Math.min(rows.length, lo + 2)
}

/**
 * Scroll anchoring (2026-09-15 real-machine feedback: "收起后滚动位置跳动").
 *
 * A toggle changes the total row height by `delta` (negative when collapsing).
 * Rows BELOW the toggle shift by `delta`; when the toggle sits ABOVE the
 * viewport that shift would move the content under the viewport (a jump), so
 * `scrollTop` is moved by the same delta. A change entirely BELOW the viewport
 * needs no compensation — the browser only clamps the bottom edge.
 */
function anchoredScrollTop({ scrollTop, anchorOffset, delta }) {
  if (!Number.isFinite(delta) || delta === 0) return scrollTop
  if (!(anchorOffset < scrollTop)) return scrollTop
  return Math.max(0, scrollTop + delta)
}

/** R20 — the quiet/simple changes, in timeline order, for the bottom block. */
function quietRecordsOf(versions, digests) {
  const list = Array.isArray(versions) ? versions : []
  const digestOf = (seq) => (digests instanceof Map ? digests.get(seq) : undefined)
  return list.filter((record) => digestOf(record.boundarySeq)?.quiet === true)
}

/**
 * R24 \u2014 split the quiet changes into CONSECUTIVE runs. "Consecutive" means
 * adjacent in the timeline: a non-quiet boundary between two quiet ones starts a
 * new run (the measured data has 30 runs / 18 of length 1, so merging by
 * adjacency is the real shape — merging every quiet record regardless of
 * position would claim a continuity that is not there).
 * Only runs of \u22652 are merged into one expandable line; a run of 1 stays a
 * single visible row (never merged away).
 */
function quietRunsOf(versions, digests) {
  const list = Array.isArray(versions) ? versions : []
  const digestOf = (seq) => (digests instanceof Map ? digests.get(seq) : undefined)
  const runs = []
  let run = []
  for (const record of list) {
    if (digestOf(record.boundarySeq)?.quiet === true) {
      run.push(record)
    } else if (run.length > 0) {
      runs.push(run)
      run = []
    }
  }
  if (run.length > 0) runs.push(run)
  return runs
}
/**
 * R31 — the 「现在的路」 start line. The "start" of the live path is the
 * EARLIEST boundary (smallest boundarySeq — the list order is not trusted here):
 * its AI summary when there is one, else its verbatim continuation excerpt, else
 * the honest message count. Never a placeholder, never blank.
 */
function pathStartOf(versions, digests) {
  const list = Array.isArray(versions) ? versions : []
  if (list.length === 0) return null
  let first = list[0]
  for (const record of list) {
    if (Number.isSafeInteger(record?.boundarySeq) && record.boundarySeq < first.boundarySeq) first = record
  }
  const digest = digests instanceof Map ? digests.get(first.boundarySeq) : undefined
  return {
    summary: digest?.called === true && typeof digest.summary === 'string' ? digest.summary : null,
    text: typeof digest?.what?.new?.excerpt === 'string' ? digest.what.new.excerpt : '',
    count: first.messageCount,
  }
}

/**
 * P1 — Version timeline as an official conversation view tab (PLAN §5.1,
 * 0.4.2 trajectory-leverage): rendered in the `conversation.view` slot (a tab
 * next to 对话/轨迹). The versions data channel stays plugin-owned — the live
 * `session/projection` push frames arrive through
 * `useProjection('retrace/versions')` when present (zero polling), with the
 * HTTP `/versions` route as fallback — because versions are DERIVED data the
 * official event stream does not carry. The view shell, view switching,
 * paging and the trajectory handoff reuse the official mechanisms.
 */
function RetraceView({ sessionId, useChat, useProjection, t, actions, store }) {
  const [versions, setVersions] = useState(null)
  // Host-side surface replacements filtered out of the list (count only).
  const [hostReplacements, setHostReplacements] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [git, setGit] = useState(null)
  const [gitBusy, setGitBusy] = useState(false)
  const [preview, setPreview] = useState(null)
  const [previewScope, setPreviewScope] = useState('both')
  // 语义短码（2026-09-01）：默认空,异步从 host 短码表拿（工作区+序号语义）。
  // 不用 FNV 兜底显示——该规则产出的是语义码,不是随机 hash。
  const [badge, setBadge] = useState('')
  const [rollbackBusy, setRollbackBusy] = useState(false)
  const [scrollTop, setScrollTop] = useState(0)
  const [doctor, setDoctor] = useState(null)
  // boundarySeq → boundary digest record (`what` + optional `summary`). Not in
  // the projection wire; fetched once per open and refreshed with the list.
  const [digests, setDigests] = useState(null)
  // Server outline forest (`value.tree`) — null when absent (flat fallback).
  const [tree, setTree] = useState(null)
  // Explicit expand toggles: seq → bool (outline nesting).
  const [expanded, setExpanded] = useState(null)
  // 「现在的路」与「简单改动」块默认折叠（不持久化）。
  const [pathOpen, setPathOpen] = useState(false)
  const [quietOpen, setQuietOpen] = useState(false)
  // R24: expanded ≥2-runs inside the quiet block (`quiet:<seq>` → bool).
  const [openRuns, setOpenRuns] = useState(null)
  // Row-level detail (`boundarySeq` → bool): reveals the extra content lines.
  const [detailOpen, setDetailOpen] = useState(null)

  // Live push-frame path (projection standard kit) — falls back to HTTP.
  const projected = typeof useProjection === 'function' ? useProjection('retrace/versions') : undefined

  // Chat node source for jumps: `useChat` is a `conversation.view` standard prop
  // (host contract; the host's own chat view reads `useChat((s) => s.nodes)`).
  // The ref keeps the LATEST nodes readable from the click handler; because it
  // only updates on render, jumpToAnchor must resolve the key BEFORE the tab
  // switch unmounts this view.
  const chatNodes = useChatNodes(useChat)
  const chatNodesRef = useRef(chatNodes)
  chatNodesRef.current = chatNodes
  const chatOrder = useChatOrder(useChat)

  useEffect(() => {
    if (projected && Array.isArray(projected.versions)) setVersions(projected.versions)
    if (Number.isSafeInteger(projected?.hostReplacementCount)) setHostReplacements(projected.hostReplacementCount)
  }, [projected])

  const refresh = () => {
    setLoading(true)
    setError(null)
    refreshDigests()
    timelineGet(`/versions?sessionId=${encodeURIComponent(sessionId)}`)
      .then((result) => {
        if (!result || result.ok !== true) throw new Error(result?.error?.message ?? 'versions failed')
        setVersions(result.value?.versions ?? [])
        if (Number.isSafeInteger(result.value?.hostReplacementCount)) setHostReplacements(result.value.hostReplacementCount)
      })
      .catch((cause) => setError(cause?.message ?? 'timeline error'))
      .finally(() => setLoading(false))
  }

  /** Fetch the boundary digests (`what`) + any stored summaries for this session. */
  const refreshDigests = () => {
    fetchBoundaryDigests(sessionId).then((value) => {
      setDigests(indexDigests(value))
      setTree(indexTree(value))
      if (Number.isSafeInteger(value?.hostReplacementCount)) setHostReplacements(value.hostReplacementCount)
    })
  }

  const refreshGit = () => {
    if (getConfig().git !== true) return
    timelineGet(`/git/status?sessionId=${encodeURIComponent(sessionId)}`)
      .then((result) => setGit(result?.ok === true ? result.value : null))
      .catch(() => setGit(null))
  }

  // Mount-time load: projection push frames arrive live when the host mounts
  // the registry; HTTP is the on-demand fallback for minimal compositions.
  //
  // ⚠️ 2026-09-15 真机空列表事故：兜底判据此前是 `projected === undefined` —— 只覆盖
  // "**完全没有**投影"。宿主注册了投影单元、但这一帧的 view 不含 `versions`（冷启动/
  // 首帧未就绪/注册表存在而数据还没折出来）时，`projected` 是**有值的**、`versions`
  // 却读不到 ⇒ 既不用它、也**不走 HTTP 兜底** ⇒ 读档点永远显示"还没有读档点"，
  // 而且不报错（静默降级）。判据改为"**读不到 versions 数组就兜底**"。
  useEffect(() => {
    if (!projected || !Array.isArray(projected.versions)) refresh()
    refreshGit()
    // The digest/summary read is independent of the versions source (projection
    // or HTTP) and must run even when push frames are live.
    refreshDigests()
    // Compression pre-check: flag turn-null markers that would break /compact.
    timelineGet(`/doctor?sessionId=${encodeURIComponent(sessionId)}`)
      .then((result) => setDoctor(result?.ok === true ? result.value : null))
      .catch(() => setDoctor(null))
    // 写入短码 title（一次：如果标题已含短码则跳过）
    callOp('setBadgeTitle', { sessionId }).catch(() => {})
    // 语义短码（2026-09-01）：host 短码表优先（工作区+序号），FNV 兜底
    callOp('sessionBadge', { sessionId }).then((result) => {
      if (result && result.ok === true && typeof result.value?.badge === 'string') {
        setBadge(result.value.badge)
      }
    }).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Jump: switch to the chat tab (tab-bar click — `actions?.setView?.()` is a
  // silent no-op for store-less third-party views), page up via the session
  // store's official `loadThrough(seq)` until the anchor seq is loaded, then
  // scroll the chat row into view. Node lookup rides the `useChat` standard
  // prop (the client Session controller's snapshot has no chat nodes).
  // The whole flow runs here because the view switch unmounts this view.
  const jump = (boundarySeq) => jumpToAnchor(store, boundarySeq, () => chatNodesRef.current)
  // 「跳转」跳到这一档**现在对应的那条消息**（② 现在这条）；读端没给出对应物时
  // 退回原来的边界 seq（纯导航，不改语义、不新增入口）。
  const jumpRow = (row) => jump(jumpTargetOf(row))

  const requestPreview = (record, options = {}) => {
    // Quiet changes touched no artifacts: their rollback is CONTEXT ONLY.
    const contextOnly = options.contextOnly === true
    const scope = contextOnly ? 'context' : 'both'
    setPreviewScope(scope)
    setPreview({ versionId: record.versionId, kind: record.kind, boundarySeq: record.boundarySeq, contextOnly, data: null, error: null })
    callOp('rollback/preview', { sessionId, versionId: record.versionId, scope }).then((result) => {
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
      // 同上：读不到 versions 就兜底，而不是只在"完全没有投影"时兜底。
      if (!projected || !Array.isArray(projected.versions)) refresh()
      refreshGit()
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

  // ---- windowed list (zero-dep) ----
  // Belt-and-braces: the server already filters host-side surface replacements
  // out of `/versions` (viewVersionIndex). An older cached wire could still
  // carry them, and they are NOT the user's changes, so never render them.
  const list = (versions ?? []).filter((record) => record?.kind !== 'replace')
  // Outline display list (flat when `tree` is absent; nested per the server forest).
  // Rows are COMPACT (ROW_H = two lines); an open detail block adds DETAIL_H per line.
  const rows = buildDisplayRows({ versions: list, digests, tree, expanded, detailOpen, t })
  // 2026-08-30 渲染卡死修复：带起始索引切片，渲染用索引算 top（原 `list.indexOf`
  // 是 O(N²)）。2026-09-15：行高不再恒定（展开明细的行更高）⇒ top 与前缀和挂钩，
  // 仍然只渲染可见行。
  const offsets = new Array(rows.length)
  let totalHeight = 0
  for (let i = 0; i < rows.length; i += 1) {
    offsets[i] = totalHeight
    totalHeight += rows[i].height ?? ROW_H
  }
  // 白屏事故(2026-09-15 真机：点收起后整页崩)的第二道防线。**根治**在
  // `rowHeightOf` + 行模型唯一的 `push`（每个 kind 都有确定的有限高度，见
  // 那次事故的复现报告：真根因其实是 state updater 里的未绑定变量），所以这里
  // 理论上不可能命中；保留净化 + 夹紧只为防将来有人绕过 `push` 直接塞行。
  for (let i = 0; i < offsets.length; i++) {
    if (!Number.isFinite(offsets[i])) offsets[i] = i * ROW_H
  }
  const visibleStart = clampIndex(visibleFrom(rows, offsets, scrollTop), rows.length)
  const visibleEnd = Math.max(visibleStart, clampIndex(visibleTo(rows, offsets, scrollTop + 640), rows.length))
  const visible = rows.slice(visibleStart, visibleEnd)
  const collapseHint = collapseHintOf({ rows, offsets, scrollTop, viewportHeight: LIST_VIEWPORT_H })
  const rowKey = (row) => row.record?.versionId ?? `${row.kind}:${row.seq}`
  // Scroll anchoring: capture where the toggled row sits BEFORE the height change
  // and compensate afterwards (only when that row is above the viewport).
  const listRef = useRef(null)
  const anchorRef = useRef(null)
  const toggleWithAnchor = (row, apply) => {
    const index = row === null || row === undefined ? -1 : rows.findIndex((candidate) => rowKey(candidate) === rowKey(row))
    anchorRef.current = { offset: index >= 0 ? offsets[index] : 0, scrollTop, totalBefore: totalHeight }
    apply()
  }
  const toggle = (key) => {
    // BIND the row: the updater below runs during the NEXT RENDER (React invokes
    // state updaters in the render phase), so referencing an unbound name here
    // threw a ReferenceError inside render and took the whole host GUI down
    // (white-screen incident 2026-09-15).
    const target = rows.find((row) => row.seq === key || row.record?.boundarySeq === key) ?? null
    toggleWithAnchor(target, () => setExpanded((prev) => {
      const next = new Map(prev instanceof Map ? prev : [])
      // Default is COLLAPSED, so "open" ⇒ 1 and "close" ⇒ `false` (an explicit
      // collapse, kept distinct from the default in the state).
      const open = target !== null && budgetOf(target.granted, 0) > 0
      next.set(key, open ? false : 1)
      return next
    }))
  }
  // 深层档（2026-09-15）：点一次「还有 N 层」把这一档的深度预算提到行模型算好的
  // 下一档（一次恰好放开一级；不是"一次全展开"）。收起走同一个 toggle（→ 0）。
  const deepen = (seq, next) => toggleWithAnchor(
    rows.find((row) => row.seq === seq) ?? null,
    () => setExpanded((prev) => {
      const map = new Map(prev instanceof Map ? prev : [])
      map.set(seq, Number.isInteger(next) && next > 0 ? next : budgetOf(map.get(seq)) + 1)
      return map
    }),
  )
  const toggleDetail = (seq) => toggleWithAnchor(
    rows.find((row) => row.record?.boundarySeq === seq) ?? null,
    () => setDetailOpen((prev) => {
      const next = new Map(prev instanceof Map ? prev : [])
      next.set(seq, next.get(seq) !== true)
      return next
    }),
  )
  useEffect(() => {
    const anchor = anchorRef.current
    anchorRef.current = null
    if (anchor === null) return
    const next = anchoredScrollTop({ scrollTop: anchor.scrollTop, anchorOffset: anchor.offset, delta: totalHeight - anchor.totalBefore })
    if (next === anchor.scrollTop) return
    setScrollTop(next)
    if (listRef.current) listRef.current.scrollTop = next
  }, [totalHeight])
  // Always drop the anchor after the render settles: a toggle that changes NO
  // height (e.g. expanding a node whose children emit no row) must not leave a
  // stale anchor behind for the next toggle.
  useEffect(() => { anchorRef.current = null })
  const rounds = roundsOf(chatNodesRef.current, chatOrder)
  // R20/R24: the quiet changes, grouped into consecutive runs (≥2 folds into one
  // expandable line inside the bottom block).
  const quietRuns = quietRunsOf(list, digests)
  const toggleRun = (key) => setOpenRuns((prev) => {
    const next = new Map(prev instanceof Map ? prev : [])
    next.set(key, next.get(key) !== true)
    return next
  })
  // R22: the quiet rows' action is pure navigation to the newest live message.
  const jumpLatest = () => {
    const seq = latestSeqOf(chatNodesRef.current, chatOrder)
    if (typeof seq === 'number') jump(seq)
  }
  // R31: the 「现在的路」 start line (summary if any, else the verbatim text).
  const pathStart = pathStartOf(list, digests)

  // Same view-area height trap as the fork list (see bindListHeight).
  useEffect(() => {
    if (list.length === 0) return undefined
    return bindListHeight(document.querySelector('.dsh-rt-view .dsh-rt-timeline-list'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.length])

  return createElement('div', { className: 'dsh-rt-view' }, [
    createElement('div', { key: 'head', className: 'dsh-rt-timeline-head' }, [
      createElement('span', { key: 'title', className: 'dsh-rt-timeline-title' }, t('timeline.title')),
      // 会话铭牌（2026-09-01）：所有界面统一展示短码，沟通任务用
      sessionId && createElement('code', { key: 'badge', className: 'dsh-rt-fork-badge-code', title: t('badge.hint') }, `[${badge}]`),
      createElement('button', {
        key: 'refresh',
        type: 'button',
        className: 'dsh-rt-chip',
        onClick: refresh,
      }, t('timeline.refresh')),
    ]),

    // 概念解释：常驻一句，说清「版本是什么 + 能拿它做什么」（空态也有）。
    // 页首说明（固定，不随虚拟滚动消失）：这是什么 + 共几次 + 顺序提示
    createElement('div', { key: 'intro', className: 'dsh-rt-view-intro' }, [
      createElement('span', { key: 'what', className: 'dsh-rt-intro-what' }, t('timeline.intro', { count: list.length })),
      createElement('span', { key: 'order', className: 'dsh-rt-intro-order' }, t('timeline.orderHint')),
    ]),

    doctor && doctor.enabled && doctor.markerCount > 0 && createElement('div', { key: 'doctor', className: 'dsh-rt-timeline-git dsh-rt-doctor' }, [
      createElement('span', { key: 'text', className: 'dsh-rt-timeline-git-text' }, t('timeline.doctorWarn', { count: doctor.markerCount })),
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

    // Host-side surface replacements are filtered out of the list; say how many
    // instead of hiding them silently (and never mix them with user changes).
    hostReplacements > 0 && createElement('div', { key: 'hostnote', className: 'dsh-rt-host-note' }, t('host.replacements', { count: hostReplacements })),

    error !== null && createElement('div', { key: 'error', className: 'dsh-rt-error' }, error),
    loading && createElement('div', { key: 'loading', className: 'dsh-rt-timeline-empty' }, t('timeline.loading')),
    !loading && list.length === 0 && createElement('div', { key: 'empty', className: 'dsh-rt-timeline-empty' }, t('timeline.empty')),

    rows.length > 0 && createElement('div', {
      key: 'list',
      ref: listRef,
      className: 'dsh-rt-timeline-list',
      onScroll: (event) => setScrollTop(event.target.scrollTop),
    }, [
      // 悬浮收起条：sticky + height:0 ⇒ 不进流、不改 scrollHeight（不用滚到底部）
      createElement(CollapseHint, {
        key: 'collapse-hint',
        hint: collapseHint,
        t,
        onToggle: (seq) => toggle(seq),
      }),
      createElement('div', { key: 'spacer', style: { height: `${totalHeight}px`, position: 'relative' } }, [
        visible.map((row, i) => createElement(CheckpointRow, {
          key: rowKey(row),
          row,
          t,
          top: offsets[visibleStart + i],
          onToggle: toggle,
          onToggleDepth: deepen,
          onToggleDetail: toggleDetail,
          onPreview: row.record === undefined ? () => {} : () => requestPreview(row.record),
          onJump: row.record === undefined ? () => {} : () => jumpRow(row),
        })),
      ]),
    ]),

    // 最下方「现在的路」：默认折叠，展开后按轮次列对话文字（仅活路可跳）。
    // 最下方两块：简单改动（R20 默认折叠）+ 现在的路（我们自己的轮次列表，R30）。
    createElement(QuietBlock, {
      key: 'quiet',
      t,
      runs: quietRuns,
      open: quietOpen,
      onToggle: () => setQuietOpen((open) => !open),
      openRuns,
      onToggleRun: toggleRun,
      onJumpLatest: jumpLatest,
    }),
    createElement(CurrentPathBlock, { key: 'path', t, rounds, start: pathStart, open: pathOpen, messages: chatNodesRef.current instanceof Map ? chatNodesRef.current.size : 0, onToggle: () => setPathOpen((open) => !open), onJump: (seq) => jump(seq) }),

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
  ])
}

/**
 * Dispatch one display row to the right renderer.
 *
 * Level colours (host alias tokens → both themes give their own values):
 *   L1 `--dsw-alias-label-secondary` (slate grey-blue) · L2
 *   `--dsw-alias-state-warning-primary` (amber) · L3
 *   `--dsw-alias-state-info-primary` (teal) · current path
 *   `--dsw-alias-state-success-primary` (green).
 *
 * Quiet changes never reach this dispatcher (R20: they have no main-timeline
 * row); its `fallback` branch covers boundaries with no digest content.
 */
/**
 * The target of ONE row's 「跳转」: the message the entry corresponds to TODAY
 * (② 现在这条, from the read side) when known, else the boundary seq itself.
 * Pure so the model can be asserted without mounting the view.
 */
function jumpTargetOf(row) {
  const nowSeq = row?.now?.seq
  return Number.isSafeInteger(nowSeq) ? nowSeq : row?.record?.boundarySeq
}

function CheckpointRow({ row, t, top, onToggle, onToggleDepth, onToggleDetail, onPreview, onJump }) {
  const level = Number.isInteger(row.level) ? row.level : 0
  const levelClass = levelClassOf(level)
  const currentClass = row.current ? ' dsh-rt-current' : ''
  const style = { top: `${top}px`, paddingLeft: indentOf(level) }
  const guide = guideSpans(level)
  if (row.kind === 'collapsed') {
    return createElement('div', { className: `dsh-rt-tree-toggle${levelClass}${currentClass}`, style }, [
      ...guide,
      createElement('button', { type: 'button', className: 'dsh-rt-chip dsh-rt-tree-btn', onClick: () => onToggle(row.seq) },
        `\u2514\u2500 \u25b8 ${t('tree.changes', { count: Math.max(1, row.count) })}`),
    ])
  }
  if (row.kind === 'expanded') {
    return createElement('div', { className: `dsh-rt-tree-toggle${levelClass}${currentClass}`, style }, [
      ...guide,
      createElement('button', { type: 'button', className: 'dsh-rt-chip dsh-rt-tree-btn', onClick: () => onToggle(row.seq) },
        `\u2514\u2500 \u25be ${t('tree.collapse')}`),
    ])
  }
  if (row.kind === 'depth') {
    // NOT a dead end any more: clicking grants this node one more level.
    return createElement('div', { className: `dsh-rt-tree-toggle dsh-rt-tree-depth${levelClass}${currentClass}`, style }, [
      ...guide,
      createElement('button', {
        type: 'button',
        className: 'dsh-rt-chip dsh-rt-tree-btn',
        title: t('tree.deepen'),
        onClick: () => onToggleDepth(row.seq, row.next),
      }, `\u2514\u2500 \u25b8 ${t('tree.moreLevels', { count: Math.max(1, row.remaining) })}`),
    ])
  }
  if (row.kind === 'fallback') {
    // No digest content for this boundary (old artifact, or the artifact read
    // failed): plain text, NEVER a blank/placeholder row. Quiet changes never
    // reach here — they have no main-timeline row at all (R20).
    return createElement('div', { className: `dsh-rt-version dsh-rt-plain${levelClass}${currentClass}`, style }, [
      ...guide,
      createElement('span', { className: `dsh-rt-version-kind dsh-rt-version-kind-${row.record.kind}`, title: kindLabel(row.record.kind, t) }, KIND_ICONS[row.record.kind] ?? '\u2022'),
      createElement('div', { key: 'body', className: 'dsh-rt-version-body' }, [
        createElement('div', { key: 'line1', className: 'dsh-rt-version-line' }, [
          createElement('span', { key: 'kind', className: 'dsh-rt-version-kind-label' }, kindLabel(row.record.kind, t)),
          createElement('span', { key: 'time', className: 'dsh-rt-version-time' }, timeLabel(row.record.createdAt)),
          createElement('span', { key: 'note', className: 'dsh-rt-plain-note' }, t('timeline.messages', { count: row.record.messageCount })),
        ]),
      ]),
      createElement('span', { key: 'actions', className: 'dsh-rt-version-actions' }, [
        // 无 digest 的兜底行同样遵守"压缩行只给跳转"。
        row.record.kind === 'compaction'
          ? null
          : createElement('button', { key: 'restore', type: 'button', className: 'dsh-rt-chip dsh-rt-chip-danger', onClick: onPreview }, t('timeline.restoreTo')),
        createElement('button', { key: 'jump', type: 'button', className: 'dsh-rt-chip', onClick: onJump }, t('timeline.jump')),
      ]),
    ])
  }
  return createElement(VersionRow, {
    record: row.record,
    t,
    top,
    level,
    current: row.current === true,
    nested: level > 0,
    what: row.digest?.what ?? null,
    summary: row.digest?.summary,
    summaryCalled: row.digest?.called === true,
    discardedCount: row.discardedCount,
    turn: row.turn,
    now: row.now ?? null,
    detailOpen: row.detailOpen === true,
    onToggleDetail,
    onPreview,
    onJump,
  })
}
/**
 * R21/R22 \u2014 ONE quiet/simple change inside the bottom block.
 *
 * PLAIN TEXT ONLY: no discarded-quote block, no \u3010\u6458\u8981\u3011 element, no artifact
 * line, and NO "artifacts only" rollback. Its single action is PURE NAVIGATION
 * to the newest live message (R22) \u2014 it never calls `callOp('rollback')`.
 */
/**
 * 展开层内的悬浮收起入口（视图层的第三处，见 `collapseHintOf`）。
 *
 * 它是一个**浮层**：绝对定位、不参与行高/前缀和（虚拟化靠 offsets，任何进流的
 * 元素都会重蹈 2026-09-15 白屏的覆辙）。`hint === null` 时渲染 null。
 */
function CollapseHint({ hint, t, onToggle }) {
  if (hint === null || hint === undefined) return null
  return createElement('div', { className: 'dsh-rt-collapse-hint' }, [
    createElement('button', {
      key: 'collapse',
      type: 'button',
      className: 'dsh-rt-chip dsh-rt-collapse-hint-btn',
      title: t('timeline.collapseHintTitle'),
      'aria-label': t('timeline.collapseHintTitle'),
      onClick: () => onToggle(hint.seq),
    }, t('timeline.collapseHint', { label: hint.label })),
  ])
}

function QuietRow({ record, t, onJumpLatest }) {
  return createElement('div', { className: 'dsh-rt-quiet-row' }, [
    createElement('span', { key: 'text', className: 'dsh-rt-plain-text' },
      `${kindLabel(record.kind, t)} \u00b7 ${timeLabel(record.createdAt)}${t('quiet.note')}`),
    createElement('button', { key: 'jump-latest', type: 'button', className: 'dsh-rt-chip', onClick: onJumpLatest }, t('quiet.jumpLatest')),
  ])
}

/**
 * R24 \u2014 a run of \u22652 CONSECUTIVE quiet changes collapsed into ONE plain-text
 * line. It is expandable (`\u25b8 \u5c55\u5f00`): the individual changes are still reachable,
 * they are only folded. Runs of length 1 never use this component.
 */
function QuietRunRow({ t, run, open, onToggleRun, onJumpLatest }) {
  return createElement('div', { className: 'dsh-rt-quiet-run' }, [
    createElement('div', { key: 'head', className: 'dsh-rt-quiet-run-head' }, [
      createElement('span', { key: 'text', className: 'dsh-rt-plain-text' },
        `${t('quiet.merged', { count: run.length })}${t('quiet.note')}`),
      createElement('button', { key: 'toggle', type: 'button', className: 'dsh-rt-chip dsh-rt-quiet-btn', 'aria-expanded': open === true, onClick: onToggleRun }, t('quiet.expand')),
    ]),
    open === true && createElement('div', { key: 'items', className: 'dsh-rt-quiet-run-list' }, run.map((record) => createElement(QuietRow, {
      key: record.versionId,
      record,
      t,
      onJumpLatest,
    }))),
  ])
}

/**
 * R20 \u2014 the bottom block collecting the quiet/simple changes so they never take
 * a main-timeline row. COLLAPSED by default (not persisted). Expanding the block
 * shows the changes one by one (R24: consecutive runs of \u22652 fold into one
 * expandable line; a lone change is listed directly).
 */
function QuietBlock({ t, runs, open, onToggle, openRuns, onToggleRun, onJumpLatest }) {
  const items = Array.isArray(runs) ? runs : []
  const total = items.reduce((sum, run) => sum + run.length, 0)
  if (total === 0) return null
  const expanded = openRuns instanceof Map ? openRuns : new Map()
  return createElement('div', { className: 'dsh-rt-quiet-block' }, [
    createElement('button', { key: 'head', type: 'button', className: 'dsh-rt-quiet-head', 'aria-expanded': open === true, onClick: onToggle },
      `${open === true ? '\u25be' : '\u25b8'} ${t('quiet.blockTitle', { count: total })}${t('quiet.note')}`),
    open === true && createElement('div', { key: 'list', className: 'dsh-rt-quiet-list' }, items.map((run) => (run.length >= 2
      ? createElement(QuietRunRow, {
          key: `quiet:${run[0].boundarySeq}`,
          t,
          run,
          open: expanded.get(`quiet:${run[0].boundarySeq}`) === true,
          onToggleRun: () => onToggleRun(`quiet:${run[0].boundarySeq}`),
          onJumpLatest,
        })
      : createElement(QuietRow, { key: run[0].versionId, record: run[0], t, onJumpLatest })))),
  ])
}

/**
 * \u300c\u73b0\u5728\u7684\u8def\u300d\u2014 a fixed text block at the bottom: one line per round of the LIVE
 * derived surface (`第 N 轮 ·「你问的…」→「助手答的…」`). Only these rows are
 * jumpable (discarded nodes are not in the derived surface, so they cannot be
 * located in the conversation — they stay reachable through the outline rows).
 */
function CurrentPathBlock({ t, rounds, open, onToggle, onJump, messages, start }) {
  const items = Array.isArray(rounds) ? rounds : []
  // R31 — the start line is ALWAYS visible (it is the block's default reading):
  // the AI summary when there is one, else the verbatim continuation text, else
  // the honest message count. Never a placeholder, never blank.
  const startSummary = typeof start?.summary === 'string' && start.summary.trim() !== '' ? start.summary : null
  const startText = typeof start?.text === 'string' && start.text.trim() !== '' ? start.text : null
  const startLine = start === null || start === undefined
    ? null
    : createElement('div', { key: 'start', className: 'dsh-rt-path-start' }, [
        createElement('span', { key: 'tag', className: 'dsh-rt-path-start-tag' }, t('path.start')),
        startSummary !== null
          ? createElement('span', { key: 'summary', className: 'dsh-rt-path-start-summary' }, [
              createElement('span', { key: 'tag', className: 'dsh-rt-what-summary-tag' }, t('what.summaryTag')),
              createElement('span', { key: 'text', className: 'dsh-rt-path-start-summary-text' }, startSummary),
            ])
          : (startText !== null
              ? createElement('span', { key: 'text', className: 'dsh-rt-path-start-text' }, startText)
              : createElement('span', { key: 'counts', className: 'dsh-rt-path-start-counts' }, t('timeline.messages', { count: Number(start.count) || 0 }))),
      ])
  return createElement('div', { className: 'dsh-rt-path' }, [
    startLine,
    // Default COLLAPSED (never persisted): one clickable header line only.
    createElement('button', {
      key: 'head',
      type: 'button',
      className: 'dsh-rt-path-head',
      'aria-expanded': open === true,
      onClick: onToggle,
    }, `${open === true ? '▾' : '▸'} ${t('path.header', { messages: Number(messages) || 0, rounds: items.length })}`),
    open === true && items.length > 0 && createElement('div', { key: 'list', className: 'dsh-rt-path-list' }, items.map((round) => createElement('button', {
      key: round.seq ?? round.n,
      type: 'button',
      className: 'dsh-rt-path-row',
      onClick: () => onJump(round.seq),
    }, [
      createElement('span', { key: 'n', className: 'dsh-rt-path-n' }, t('path.round', { n: round.n })),
      createElement('span', { key: 'q', className: 'dsh-rt-path-q' }, `「${round.question}」`),
      createElement('span', { key: 'arrow', className: 'dsh-rt-path-arrow' }, '→'),
      createElement('span', { key: 'a', className: 'dsh-rt-path-a' }, `「${round.answer}」`),
    ]))),
    open === true && items.length === 0 && createElement('div', { key: 'empty', className: 'dsh-rt-path-empty' }, t('path.empty')),
  ])
}

/**
 * One checkpoint row (uniform height for the windowed list).
 *
 * Readability contract: the row must say WHAT CHANGED, not just when/counts.
 * `what` (the boundary digest, fetched from the plugin artifact) supplies the
 * verbatim old excerpt; `summary` is the OPTIONAL LLM paraphrase and is a
 * SEPARATE element (never merged with the verbatim quote). `what.artifacts`
 * absent ⇒ the artifact line does not render at all (never 0/0/0).
 * Nested rows (level > 0, dead heads) suppress 「延续」 — those paths have none.
 */
/**
 * One checkpoint row — COMPACT TWO LINES by default, details on demand.
 *
 * Default (60px, the user's "默认别太高"):
 *   line 1  动作(人话) · 时间 · 丢弃 N 条
 *   line 2  ONE content line: the first readable quote, else the compacted
 *           notice / 「另有 M 条」 / the artifact line, else the plain why line
 *
 * The remaining quotes, the 【摘要】 summary, the continuation and the artifact
 * detail are NOT dropped — they are one click away behind the ▸明细 chip, which
 * grows THIS row by `detailLines × DETAIL_H`. `buildDisplayRows` reserves the
 * same height from the same line list, so `overflow:hidden` never eats content
 * (that was the 60px incident).
 *
 * `what` may be absent (old boundary): the row still shows two lines, never blank.
 */
function VersionRow({ record, top, t, level = 0, current = false, nested = false, what, summary, summaryCalled, discardedCount, turn = null, now = null, detailOpen = false, onToggleDetail, onPreview, onJump }) {
  const summaryText = summaryCalled === true && typeof summary === 'string' && summary.trim() !== '' ? summary : null
  const artifacts = artifactsLabel(what?.artifacts, t)
  const hasWhat = what !== null && what !== undefined
  const compaction = record.kind === 'compaction' || what?.op === 'compaction'
  const { lines, replacedTotal } = hasWhat
    ? whatLineList(what, summaryText, { suppressContinue: nested, artifacts, compaction, now, kind: record.kind })
    : { lines: [], replacedTotal: 0 }
  // No digest at all ⇒ the verbatim marker text (or the plain "why") IS this
  // row's content line; a boundary never renders as a blank row.
  const contentLines = lines.length > 0
    ? lines
    : [{
        kind: 'text',
        key: 'text',
        text: record.markerText
          ? (record.markerText.length > 120 ? `${record.markerText.slice(0, 120)}…` : record.markerText)
          : whyLabel(record.kind, t),
      }]
  const compactLines = contentLines.slice(0, SHOWN_CONTENT_LINES)
  const detailLines = contentLines.slice(SHOWN_CONTENT_LINES)
  const impactCount = Number.isInteger(discardedCount) ? discardedCount : replacedTotal
  const levelClass = levelClassOf(level)
  const currentClass = current ? ' dsh-rt-current' : ''
  // Same function as the row model (single source): both sides derive the height
  // from the same line list, and neither can produce a non-finite value.
  const rowHeight = rowHeightOf({
    kind: 'row',
    detailOpen: detailOpen === true,
    detailCount: detailLines.length,
    contentCount: contentLines.length,
  })
  return createElement('div', { className: `dsh-rt-version${levelClass}${currentClass}`, style: { top: `${top}px`, height: `${rowHeight}px`, paddingLeft: indentOf(level) } }, [
    // 逐级引导线：每一级一枚 `│ `（CSS 画成该级配色的细色条）——层级不靠量像素，
    // 复制成纯文本也仍然是 `│ │ │ …`。
    ...guideSpans(level),
    createElement('span', { key: 'kind', className: `dsh-rt-version-kind dsh-rt-version-kind-${record.kind}`, title: kindLabel(record.kind, t) }, KIND_ICONS[record.kind] ?? '•'),
    createElement('div', { key: 'body', className: 'dsh-rt-version-body' }, [
      // 行首：动作 · 第 N 轮 · 时间 ·（换掉了 N 条 | 无摘要时的原始消息数）
      // 轮次从日志推（边界事件所在 turn，取不到就**整段省略**，不显示"第 ? 轮"）；
      // 分隔符用可见的 `·`，这样复制出来的纯文本也读得通。
      createElement('div', { key: 'line1', className: 'dsh-rt-version-line' }, [
        createElement('span', { key: 'kind', className: 'dsh-rt-version-kind-label' }, kindLabel(record.kind, t)),
        // 轮次拿不到时**连分隔符一起省**（不留一个孤零零的 ·）
        roundOf(turn) === null
          ? null
          : [
              line1Separator('sep-round'),
              createElement('span', { key: 'round', className: 'dsh-rt-version-round' }, t('timeline.round', { n: roundOf(turn) })),
            ],
        line1Separator('sep-time'),
        createElement('span', { key: 'time', className: 'dsh-rt-version-time' }, timeLabel(typeof what?.at === 'number' ? what.at : record.createdAt)),
        impactCount > 0
          ? [
              line1Separator('sep-count'),
              createElement('span', { key: 'count', className: 'dsh-rt-version-count' }, t('what.countShort', { count: impactCount })),
            ]
          : (hasWhat ? null : [
              line1Separator('sep-msgs'),
              createElement('span', { key: 'msgs', className: 'dsh-rt-version-msgs' }, t('timeline.messages', { count: record.messageCount })),
            ]),
      ]),
      // 第 2..3 行：② 现在这条 → ③ 原来的内容（压缩行仍只有一条归属说明）
      compactLines.map((line) => whatLineElement(line, t, { onJump })),
      // 展开态：其余明细行（引文 2..3 / 另有 M 条 / 【摘要】 / 延续 / 产物明细）
      detailOpen === true && detailLines.length > 0 ? detailLines.map((line) => whatLineElement(line, t, { onJump })) : null,
    ]),
    // 明细的唯一入口：行尾的「›」（原来的「▸ 明细」chip 已并入它 —— 一行里
    // 不再挤两个同义入口）。detailLines > 0 才出现，避免死入口。
    detailLines.length > 0
      ? createElement('button', {
          key: 'open',
          type: 'button',
          className: 'dsh-rt-row-open',
          title: t('timeline.openEntry'),
          'aria-label': t('timeline.openEntry'),
          'aria-expanded': detailOpen === true,
          onClick: () => onToggleDetail(record.boundarySeq),
        }, '\u203a')
      : null,
    // 行尾动作：回到这一档（回退，走二次确认）+ 跳转（纯导航）。
    // 宿主压缩行**只给跳转**（用户口径 2026-09-15）：回退到宿主压缩点不是用户
    // 的意图，那个档也不是我们造成的。
    createElement('span', { key: 'actions', className: 'dsh-rt-version-actions' }, [
      compaction === true
        ? null
        : createElement('button', { key: 'restore', type: 'button', className: 'dsh-rt-chip dsh-rt-chip-danger', onClick: onPreview }, t('timeline.restoreTo')),
      createElement('button', { key: 'jump', type: 'button', className: 'dsh-rt-chip', onClick: onJump }, t('timeline.jump')),
    ]),
  ])
}

/**
 * PANEL-LEVEL ERROR BOUNDARY (2026-09-15 white-screen incident).
 *
 * The view renders inside the HOST's React tree. A render error with no boundary
 * propagates to the host root, and React unmounts the ENTIRE tree — the user's
 * whole GUI goes blank (real machine: "点了收起。直接白屏了"). This boundary
 * turns any render error of this panel into a small Chinese notice + a Retry
 * button, so the worst case is "this panel is broken", never "the app is gone".
 *
 * It MUST be a class component: React only implements error boundaries through
 * `getDerivedStateFromError` / `componentDidCatch`.
 */
class RetraceErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  componentDidCatch(error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[dsh-retrace] view render failed: ${message}`)
    try {
      const sent = callOp('clientReport', { id: 'view-render-error', source: `view-render-error: ${message}`.slice(0, 200) })
      if (sent && typeof sent.catch === 'function') sent.catch(() => { /* log only */ })
    } catch { /* diagnostics must never break the panel */ }
  }

  render() {
    const error = this.state.error
    if (error === null) return this.props.children
    const t = typeof this.props.t === 'function' ? this.props.t : (key) => key
    const title = typeof this.props.title === 'string' && this.props.title !== '' ? this.props.title : t('view.errorTitle')
    return createElement('div', { className: 'dsh-rt-view dsh-rt-view-error' }, [
      createElement('div', { key: 'title', className: 'dsh-rt-error-title' }, title),
      createElement('div', { key: 'hint', className: 'dsh-rt-view-intro' }, t('view.errorHint')),
      createElement('pre', { key: 'detail', className: 'dsh-rt-error-detail' }, String(error.message ?? error)),
      createElement('button', {
        key: 'retry',
        type: 'button',
        className: 'dsh-rt-chip dsh-rt-error-retry',
        onClick: () => this.setState({ error: null }),
      }, t('view.errorRetry')),
    ])
  }
}

/**
 * Wrap ONE registration surface in the shared `RetraceErrorBoundary`.
 *
 * EVERY React surface this plugin registers goes through here (the chat node rows,
 * the assistant action strip, the settings row, the read-point view), so a render
 * error can only break that one surface — never the host's whole tree. One
 * implementation, no copies.
 *
 * @param {Function} Component - the surface component
 * @param {string} titleKey - i18n key of that surface's failure title
 * @returns {Function} the wrapped slot component
 */
const withPanelBoundary = (Component, titleKey) => (props) => createElement(
  RetraceErrorBoundary,
  {
    t: props?.t,
    title: typeof props?.t === 'function' ? props.t(titleKey) : undefined,
  },
  createElement(Component, props),
)

/** Rollback preview + confirm box (scope selector + artifact actions). */
function PreviewBox({ preview, scope, setScope, busy, t, onConfirm, onCancel }) {
  const data = preview.data
  // A quiet change touched no artifacts, so only the CONTEXT rollback is offered
  // (an artifacts-only rollback would be a no-op).
  const contextOnly = preview.contextOnly === true
  const scopes = contextOnly
    ? [['context', 'timeline.contextOnly', 'timeline.contextOnlyDesc']]
    : [
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
      // R34: the second confirmation must state WHAT it touches — the message
      // count above, plus the artifact count and the file detail below.
      !contextOnly && createElement('div', { key: 'art', className: 'dsh-rt-modal-line' },
        (data.artifacts?.rows?.length ?? 0) > 0
          ? t('timeline.artifactsImpact', { count: data.artifacts.rows.length })
          : t('timeline.filesNone')),
      !contextOnly && (data.artifacts?.rows?.length ?? 0) > 0 && createElement('ul', { key: 'files', className: 'dsh-rt-modal-files' }, (data.artifacts?.rows ?? []).slice(0, 12).map((row) =>
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

/**
 * The content of one checkpoint row as an ORDERED LINE LIST.
 *
 * Single source of truth: the compact row (line 1 = 动作·时间·计数, line 2 = ONE
 * content line), the expandable detail block, and the row-height math all read
 * this list, so the reserved height can never disagree with what is rendered
 * (the "60px 裁掉内容" incident was exactly such a desync).
 *
 * Line kinds: `now` (现在这条 = the message the action left behind) · `now-same`
 * (its excerpt and the original are the same text ⇒ ONE merged sentence) ·
 * `now-none` (honest notice: recall, or the counterpart is gone) · `old` (verbatim
 * discarded quote) · `compacted` (originals are gone) · `more` ("另有 M 条") ·
 * `summary` (optional AI summary) · `new` (continuation) · `files` (artifact
 * churn, only when the field exists).
 *
 * READ ORDER (user-specified 2026-09-15): ② 现在这条 → ③ 原来的内容. ② is never
 * invented: no counterpart ⇒ a notice, never a guess at the round's input (that
 * text is still in the conversation and readable on its own).
 *
 * @param {object} what - lib/boundary-what.js payload
 * @param {string|null} summaryText - usable summary (called + non-empty)
 * @param {{suppressContinue?: boolean, artifacts?: string|null, compaction?: boolean,
 *   now?: {seq:number, role:string, excerpt:string}|null, kind?: string|null}} [options]
 * @returns {{lines: object[], replacedTotal: number}}
 */
function whatLineList(what, summaryText, { suppressContinue = false, artifacts = null, compaction = false, now = null, kind = null } = {}) {
  const rawReplaced = Array.isArray(what?.replaced) ? what.replaced : []
  const replaced = rawReplaced.filter((entry) => typeof entry?.excerpt === 'string' && entry.excerpt !== '')
  const newExcerpt = typeof what?.new?.excerpt === 'string' ? what.new.excerpt : ''
  const replacedTotal = rawReplaced.length + (Number.isInteger(what?.replacedMore) ? what.replacedMore : 0)
  const lines = []
  if (compaction === true) {
    // 宿主压缩：被压缩掉的内容**不在日志里**，而 what.replaced 里那段文本其实是
    // 压缩摘要本身 —— 把它标成"原来的内容"是错的。压缩行固定只给归属说明，
    // **不给任何摘录**（2026-09-15 读者判定）。
    lines.push({ kind: 'compacted', key: 'old-compacted', count: replacedTotal })
  } else {
    // ② 现在这条（读者先看到"现在是什么"，再看到被换掉的那一份）
    const nowExcerpt = typeof now?.excerpt === 'string' ? now.excerpt : ''
    const firstOld = replaced.length > 0 ? replaced[0].excerpt : ''
    // ② 与 ③ 的可见文本相同 ⇒ 合并成一句。显示两段一样的引文会让人以为我们
    // 显示错了（真机 case：#8699 的 resend 文本与原文逐字相同）。
    const mergedSame = kind !== 'recall' && nowExcerpt !== '' && nowExcerpt === firstOld
    if (kind === 'recall') {
      // 纯撤回没有"新内容"：后续的输入是另一件事，不是它的对应物。
      lines.push({ kind: 'now-none', key: 'now-none', reason: 'recall' })
    } else if (mergedSame) {
      lines.push({ kind: 'now-same', key: 'now-same', text: nowExcerpt })
    } else if (nowExcerpt !== '') {
      lines.push({ kind: 'now', key: 'now', text: nowExcerpt })
    } else if (kind === 'edit' || kind === 'regenerate') {
      lines.push({ kind: 'now-none', key: 'now-none', reason: 'missing' })
    }
    // ③ 原来的内容（合并句已经说过第一段文本 ⇒ 不再重复它）
    const oldShown = mergedSame ? replaced.slice(1) : replaced
    for (const entry of oldShown) lines.push({ kind: 'old', key: `old-${entry.seq}`, entry })
    const listedCount = mergedSame ? 1 + oldShown.length : replaced.length
    if (replacedTotal > 0 && replaced.length === 0) {
      // Every original was already compacted away ⇒ do NOT print a bare count:
      // say WHY there is no content (real-machine finding 2026-09-15).
      lines.push({ kind: 'compacted', key: 'old-compacted', count: replacedTotal })
    } else if (replacedTotal > listedCount) {
      lines.push({ kind: 'more', key: 'old-more', count: replacedTotal - listedCount })
    }
  }
  if (summaryText !== null && summaryText !== undefined) lines.push({ kind: 'summary', key: 'summary', text: summaryText })
  if (!suppressContinue && newExcerpt !== '') lines.push({ kind: 'new', key: 'new', text: newExcerpt })
  if (typeof artifacts === 'string' && artifacts !== '') lines.push({ kind: 'files', key: 'files', text: artifacts })
  return { lines, replacedTotal }
}

/** 行首各段之间的可见分隔符（复制成纯文本也要读得通）。 */
function line1Separator(key) {
  return createElement('span', { key, className: 'dsh-rt-line-sep' }, '\u00b7')
}

/** The usable summary of one digest (`called` + non-empty), else null. */
function summaryTextOf(digest) {
  return digest?.called === true && typeof digest.summary === 'string' && digest.summary.trim() !== '' ? digest.summary : null
}

/**
 * Render ONE line of `whatLineList`.
 *
 * `onJump` (optional) makes the ② line itself the jump target — the SAME action
 * as the row-end 「跳转」 chip, not a second entry: clicking "现在这条" takes you
 * to that message.
 */
function whatLineElement(line, t, { onJump = null } = {}) {
  if (line === null || line === undefined) return null
  if (line.kind === 'now') {
    return createElement('div', { key: line.key, className: 'dsh-rt-what-quote dsh-rt-what-now' }, [
      createElement('span', { key: 'label', className: 'dsh-rt-what-label' }, t('what.nowLabel')),
      typeof onJump === 'function'
        ? createElement('button', {
            key: 'jump',
            type: 'button',
            className: 'dsh-rt-what-text dsh-rt-what-jump',
            title: t('timeline.jump'),
            'aria-label': t('timeline.jump'),
            onClick: onJump,
          }, `「${line.text}」`)
        : createElement('span', { key: 'text', className: 'dsh-rt-what-text' }, `「${line.text}」`),
    ])
  }
  if (line.kind === 'now-same') {
    // 合并句：只说一次文本，仍然可跳转（② 的动作没有因为合并而消失）。
    return createElement('div', { key: line.key, className: 'dsh-rt-what-quote dsh-rt-what-now dsh-rt-what-same' }, [
      createElement('span', { key: 'label', className: 'dsh-rt-what-label' }, t('what.resentSame')),
      typeof onJump === 'function'
        ? createElement('button', {
            key: 'jump',
            type: 'button',
            className: 'dsh-rt-what-text dsh-rt-what-jump',
            title: t('timeline.jump'),
            'aria-label': t('timeline.jump'),
            onClick: onJump,
          }, `「${line.text}」`)
        : createElement('span', { key: 'text', className: 'dsh-rt-what-text' }, `「${line.text}」`),
    ])
  }
  if (line.kind === 'now-none') {
    // 取不到就如实说（区分"本来就没有"与"已经不在日志里"），不编造。
    return createElement('div', { key: line.key, className: 'dsh-rt-what-more dsh-rt-what-none' },
      line.reason === 'recall' ? t('what.noNewRecall') : t('what.noNewMissing'))
  }
  if (line.kind === 'old') {
    // 第二行：「原来的内容：{角色}「原文」」——不露原始 seq，也不说"丢弃"。
    return createElement('div', { key: line.key, className: 'dsh-rt-what-quote dsh-rt-what-old' }, [
      createElement('span', { key: 'label', className: 'dsh-rt-what-label' }, t('what.oldLabel')),
      createElement('span', { key: 'role', className: 'dsh-rt-what-role' }, roleLabel2(line.entry.role, t)),
      createElement('span', { key: 'text', className: 'dsh-rt-what-text' }, `「${line.entry.excerpt}」`),
    ])
  }
  if (line.kind === 'compacted') {
    return createElement('div', { key: line.key, className: 'dsh-rt-what-more' }, t('what.compacted', { count: line.count }))
  }
  if (line.kind === 'more') {
    return createElement('div', { key: line.key, className: 'dsh-rt-what-more' }, t('what.more', { count: line.count }))
  }
  if (line.kind === 'summary') {
    return createElement('div', { key: line.key, className: 'dsh-rt-what-summary' }, [
      createElement('span', { key: 'tag', className: 'dsh-rt-what-summary-tag' }, t('what.summaryTag')),
      createElement('span', { key: 'text', className: 'dsh-rt-what-summary-text' }, line.text),
    ])
  }
  if (line.kind === 'new') {
    return createElement('div', { key: line.key, className: 'dsh-rt-what-quote dsh-rt-what-new' }, [
      createElement('span', { key: 'tag', className: 'dsh-rt-what-new-tag' }, t('what.currentLabel')),
      createElement('span', { key: 'text', className: 'dsh-rt-what-text' }, `「${line.text}」`),
    ])
  }
  if (line.kind === 'files') {
    return createElement('div', { key: line.key, className: 'dsh-rt-version-files' }, line.text)
  }
  if (line.kind === 'text') {
    return createElement('div', { key: line.key, className: 'dsh-rt-version-text' }, line.text)
  }
  return null
}

/**
 * The digest body of one checkpoint row, in reading order:
 *   被丢弃（每条逐字旧原文，弱化灰 + 标记已丢弃）→ 压缩提示/另有 M 条 → 可选
 *   【摘要】（独立元素）→ 延续（新原文，强调色）→ 产物变更。
 * Verbatim quotes and the AI summary are ALWAYS separate elements.
 * `maxLines` truncates for the compact row (see `whatLineList`).
 */
function whatBody(what, summaryText, t, { suppressContinue = false, maxLines = null, artifacts = null, now = null, kind = null, onJump = null } = {}) {
  const { lines } = whatLineList(what, summaryText, { suppressContinue, artifacts, now, kind })
  const shown = Number.isInteger(maxLines) && maxLines >= 0 ? lines.slice(0, maxLines) : lines
  return shown.map((line) => whatLineElement(line, t, { onJump }))
}

// ---------------------------------------------------------------------------
// 关闭守卫 V2 — 装配层(纯逻辑/文案在
// lib/close-guard-client.js,可单测;这里只做 DOM 与事件接线)
//
// 验证结论(实证详见提交报告 + close-guard-client.js 头注释):
//  - Desktop 应用退出 = 宿主 window.destroy()(electron-runtime release 内)
//    + app.exit()——Electron 语义下 beforeunload 不触发 → 本拦截只覆盖
//    **web 浏览器 tab/窗口关闭与页面重载路径**;
//  - 浏览器 beforeunload 确认框文案/按钮不可自定义(Chromium 统一原生框),
//    故 A 强拦 = 原生门 + 「取消后」的中文明细模态;B 轻确认 = 原生一次确认;
//  - Desktop 退出时用户能看到的 client 侧提示 = 运行中横幅(有任务即常驻,
//    不依赖退出路径)——桌面替代 seam(宿主原生 quit-veto)需官方 shell 支持,
//    已在报告中向宿主提议(main.js requestQuit / electron-runtime release)。
// ---------------------------------------------------------------------------
const GUARD_MODAL_ID = 'dsh-rt-guard-modal'
const GUARD_BANNER_ID = 'dsh-rt-guard-banner'
const GUARD_TOAST_ID = 'dsh-rt-guard-toast'

/** 装配一次守卫;返回清理函数。t 来自 apply(经 ctx.effect 注册清理)。 */
function installCloseGuard(t) {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {}
  const locale = () => (t('action.cancel') === '取消' ? 'zh' : 'en')
  const store = createGuardStore()
  const ui = { banner: null, modal: null, toast: null, toastTimer: 0, dismissed: null, expanded: false, lastSig: '' }
  let supported = true
  let failures = 0

  /** 会话 id → 显示名(优先确定性短码;无 uuid 时退回原始 id)。 */
  const labelOf = (sessionId) => {
    try {
      const badge = sessionBadge(sessionId)
      return badge || String(sessionId)
    } catch { return String(sessionId) }
  }
  /** 当前运行中集合签名(集合/原因变化 → 重置「已忽略」,横幅值得再看一眼)。 */
  const runningSig = (snapshot) => {
    const running = snapshot?.running
    if (!Array.isArray(running)) return ''
    return running.map((r) => `${r.sessionId}:${(r.reasons ?? []).join(',')}`).join('|')
  }

  // -- 状态同步(host → client):beforeunload 内无法 await,轮询缓存快照 ----
  function queryRunningState() {
    if (typeof wire === 'function') return wire('runningState', {})
    return fetch(`${ROUTE_BASE}/runningState`, {
      method: 'GET',
      headers: retraceConfigHeaders(),
      cache: 'no-store',
    }).then((res) => {
      if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`)
      return res.json()
    })
  }
  function refresh() {
    if (!supported) return
    queryRunningState().then((payload) => {
      failures = 0
      const value = payload && payload.ok ? payload.value : null
      if (!value || !Array.isArray(value.running)) return
      const prev = store.get()
      store.set({ running: value.running })
      if (runningSig(store.get()) !== runningSig(prev)) ui.dismissed = null
      renderBanner()
    }).catch(() => {
      // host 侧无 /runningState(旧版/极简动态宿主)→ 3 次失败后停用本页守卫
      failures += 1
      if (failures >= 3) {
        supported = false
        removeBanner()
        console.warn('[dsh-retrace] close-guard: running-state 通道不可用(3 次失败),本页关闭守卫停用')
      }
    })
  }

  // -- 运行中横幅(有运行中任务即常驻;Desktop 退出前用户也能看到) ----------
  function removeBanner() {
    if (ui.banner) { ui.banner.remove(); ui.banner = null }
  }
  function bannerNote(lang) {
    return lang === 'zh'
      ? '关闭页面/退出前请先确认——任务中断可能丢失进度(桌面端应用退出在宿主侧,请以此横幅为准)'
      : 'Confirm before closing/exiting — interrupting work may lose progress (Desktop app exit is host-side; rely on this banner)'
  }
  function renderBanner() {
    const cfg = getConfig()
    if (!cfg.closeGuard || !supported) return removeBanner()
    const snap = store.get()
    if (classifySnapshot(snap) !== 'running') return removeBanner()
    const lang = locale()
    const lines = runningLines(snap.running, { locale: lang, labelOf })
    const sig = lines.join('\n')
    if (ui.dismissed === sig) return
    if (ui.banner && ui.banner.isConnected && ui.lastSig === sig) return // 内容未变不重建
    if (!ui.banner) {
      ui.banner = document.createElement('div')
      ui.banner.id = GUARD_BANNER_ID
      ui.banner.className = 'dsh-rt-guard-banner'
      const head = document.createElement('div')
      head.className = 'dsh-rt-guard-banner-head'
      ui.banner.appendChild(head)
      const note = document.createElement('div')
      note.className = 'dsh-rt-guard-banner-note'
      ui.banner.appendChild(note)
      const list = document.createElement('div')
      list.className = 'dsh-rt-guard-banner-list'
      list.style.display = 'none'
      ui.banner.appendChild(list)
      document.body.appendChild(ui.banner)
    }
    const n = snap.running.length
    const head = ui.banner.firstChild
    head.textContent = ''
    head.appendChild(document.createTextNode(lang === 'zh' ? `⚠️ ${n} 个会话运行中` : `⚠️ ${n} session${n === 1 ? '' : 's'} running`))
    const toggle = document.createElement('button')
    toggle.type = 'button'
    toggle.className = 'dsh-rt-guard-link'
    toggle.textContent = ui.expanded ? (lang === 'zh' ? '收起' : 'Hide') : (lang === 'zh' ? '明细' : 'Details')
    toggle.onclick = () => {
      ui.expanded = !ui.expanded
      const list = ui.banner.querySelector('.dsh-rt-guard-banner-list')
      if (list) list.style.display = ui.expanded ? 'block' : 'none'
      toggle.textContent = ui.expanded ? (lang === 'zh' ? '收起' : 'Hide') : (lang === 'zh' ? '明细' : 'Details')
    }
    const dismiss = document.createElement('button')
    dismiss.type = 'button'
    dismiss.className = 'dsh-rt-guard-link'
    dismiss.textContent = '×'
    dismiss.title = lang === 'zh' ? '忽略(任务结束或变化后再提示)' : 'Dismiss (re-shows when the running set changes)'
    dismiss.onclick = () => {
      ui.dismissed = sig
      removeBanner()
    }
    head.appendChild(toggle)
    head.appendChild(dismiss)
    ui.banner.querySelector('.dsh-rt-guard-banner-note').textContent = bannerNote(lang)
    const listEl = ui.banner.querySelector('.dsh-rt-guard-banner-list')
    listEl.textContent = lines.join('\n')
    listEl.style.display = ui.expanded ? 'block' : 'none'
    ui.lastSig = sig
  }

  // -- A 明细模态(原生门取消后出现)与放行提示 ---------------------------------
  function hideModal() {
    if (ui.modal) { ui.modal.remove(); ui.modal = null }
  }
  function showModal() {
    const snap = store.get()
    if (classifySnapshot(snap) !== 'running') return
    const lang = locale()
    const copy = buildRunningCopy(snap, { locale: lang, labelOf })
    hideModal()
    const overlay = document.createElement('div')
    overlay.className = 'dsh-rt-guard-overlay'
    overlay.id = GUARD_MODAL_ID
    overlay.onclick = (event) => { if (event.target === overlay) hideModal() }
    const modal = document.createElement('div')
    modal.className = 'dsh-rt-guard-modal'
    modal.onclick = (event) => event.stopPropagation()
    const title = document.createElement('div')
    title.className = 'dsh-rt-guard-modal-title'
    title.textContent = copy.head
    modal.appendChild(title)
    const lines = document.createElement('div')
    lines.className = 'dsh-rt-guard-modal-lines'
    lines.textContent = copy.lines.join('\n')
    modal.appendChild(lines)
    if (copy.hint) {
      const hint = document.createElement('div')
      hint.className = 'dsh-rt-guard-modal-hint'
      hint.textContent = copy.hint
      modal.appendChild(hint)
    }
    const actions = document.createElement('div')
    actions.className = 'dsh-rt-guard-modal-actions'
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'dsh-rt-guard-btn'
    cancel.textContent = lang === 'zh' ? '取消' : 'Cancel'
    cancel.onclick = () => hideModal()
    const proceed = document.createElement('button')
    proceed.type = 'button'
    proceed.className = 'dsh-rt-guard-btn dsh-rt-guard-btn-primary'
    proceed.textContent = lang === 'zh' ? '仍关闭' : 'Close anyway'
    proceed.onclick = () => {
      store.arm() // 放行:下一次关闭手势(beforeunload 二次触发)直接通过
      hideModal()
      try { window.close() } catch { /* 普通浏览器 tab 拒绝脚本关闭,走二次手势 */ }
      showToast(lang === 'zh'
        ? '已放行——若未自动退出,请再次点击关闭窗口/标签页(30 秒内有效,过期需重新确认)'
        : 'Armed — if the window did not close, click close again (valid 30s, then re-confirm)')
    }
    actions.appendChild(cancel)
    actions.appendChild(proceed)
    modal.appendChild(actions)
    overlay.appendChild(modal)
    document.body.appendChild(overlay)
    ui.modal = overlay
  }
  function showToast(text) {
    if (!ui.toast) {
      ui.toast = document.createElement('div')
      ui.toast.id = GUARD_TOAST_ID
      ui.toast.className = 'dsh-rt-guard-toast'
      document.body.appendChild(ui.toast)
    }
    ui.toast.textContent = text
    clearTimeout(ui.toastTimer)
    ui.toastTimer = setTimeout(() => { if (ui.toast) { ui.toast.remove(); ui.toast = null } }, 8000)
  }

  // -- 页面关闭拦截(beforeunload;仅浏览器/页面路径触发) -----------------------
  function onBeforeUnload(event) {
    if (!getConfig().closeGuard || !supported) return
    if (store.isArmed()) return // 已放行(用户已选 [仍关闭])→ 二次触发直接过
    const kind = classifySnapshot(store.get())
    if (kind === 'unknown') return // 状态未同步(host 不可达/刚启动)→ 不打扰
    // A/B 共用浏览器原生门:returnValue 触发原生确认(Chromium 文案不可自定义,
    // 见 close-guard-client.js 头注释;用户控制可在设置关闭)。
    try { event.preventDefault?.() } catch { /* ignore */ }
    try { event.returnValue = '' } catch { /* ignore */ }
    if (kind === 'running') {
      // A 强拦明细:用户取消原生门(留在页面)后弹中文明细模态;若用户直接选
      // 离开,运行中横幅已在全程提示——浏览器对自定义文案的硬限制即此。
      setTimeout(() => {
        if (classifySnapshot(store.get()) === 'running' && !store.isArmed()) showModal()
      }, 0)
    }
  }
  function onVisibility() {
    if (document.visibilityState === 'visible') refresh()
  }

  window.addEventListener('beforeunload', onBeforeUnload)
  document.addEventListener('visibilitychange', onVisibility)
  const timer = window.setInterval(refresh, GUARD_POLL_MS)
  refresh()
  const unsubscribe = subscribeConfig(() => {
    renderBanner()
    if (getConfig().closeGuard) refresh()
  })
  return () => {
    window.removeEventListener('beforeunload', onBeforeUnload)
    document.removeEventListener('visibilitychange', onVisibility)
    window.clearInterval(timer)
    unsubscribe()
    removeBanner()
    hideModal()
    if (ui.toast) { ui.toast.remove(); ui.toast = null }
    clearTimeout(ui.toastTimer)
  }
}

// ---------------------------------------------------------------------------
// Conversation Definition registration (new host / old host)
// ---------------------------------------------------------------------------
/**
 * Resolve the registration entry point of a conversation service.
 *
 * 当前基座把注册表挂在服务**内部**:`uiConversation`(UiConversation 类,公开方法只有
 * binding/imageUrl/peekImageUrl/seedImageUrl/inspectSystemPrompt/inspectRequestPrompt/drop
 * —— **没有 register**;类体里连 "register" 这个词都不出现),官方入口是
 * `ctx.uiConversation.events.register(definition)`(asar 内 29 处官方调用点全是这一形态,
 * 类型侧 `ConversationEventRegistry.register` 还会用 `assertDefinitionTarget` 校验
 * target/buildViewNode 成对)。旧基座的 `conversationEvents` 则把 `register` 直接放在服务上。
 *
 * 两个形状都支持。返回 `null` = 服务实例上没有可用入口 —— 调用方要留一行日志,
 * 不能像 0.4.26 那样静默跳过(那正是 2026-09-14「装上插件后没有编辑和撤回」的直接成因)。
 *
 * @param {unknown} service - `ctx.get('uiConversation')` / `ctx.get('conversationEvents')`
 * @returns {{ register: (definition: object) => () => void, via: 'events'|'self' }|null}
 */
function conversationRegistrar(service) {
  if (service === null || typeof service !== 'object') return null
  const events = service.events
  if (events !== null && typeof events === 'object' && typeof events.register === 'function') {
    return { register: (definition) => events.register(definition), via: 'events' }
  }
  if (typeof service.register === 'function') {
    return { register: (definition) => service.register(definition), via: 'self' }
  }
  return null
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------
export function apply(ctx) {
  const disposeStyle = ensureStyle()
  ctx.effect(() => () => disposeStyle(), 'dsh-retrace: styles')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-retrace: dictionaries')
  const t = ctx.locale.bind(NS)

  // 关闭守卫 V2:页面关闭 beforeunload 拦截(A 强拦/B 轻
  // 确认,运行中状态经 /runningState 轮询缓存)+ 运行中横幅(Desktop 退出走
  // 宿主 destroy,横幅是退出前唯一可见的 client 侧提示——替代 seam 见报告)。
  // The close guard is DOM-only (no React), so the panel error boundary does not
  // apply to it: fail CLOSED instead — the guard degrades to "not installed"
  // rather than breaking the plugin's activation (and with it the client half).
  let disposeCloseGuard = () => {}
  try {
    disposeCloseGuard = installCloseGuard(t)
  } catch (error) {
    console.warn(`[dsh-retrace] close guard unavailable: ${String(error?.message ?? error)}`)
  }
  ctx.effect(() => () => disposeCloseGuard(), 'dsh-retrace: close guard')

  // ★ 2026-09-14 事故 2：用户报「插件装好后客户端没有编辑和撤回了」。第一手定因：
  //   宿主侧一切正常（route + watchdog 心跳都在），boot manifest 里本插件行也在
  //   （application 批，inject=[slots,locale]）⇒ 客户端半**装载了**；缺的是会话
  //   Definition 的注册。旧代码 `ctx.get('uiConversation').register(...)` 把注册入口
  //   当在**服务自身**上，而 2.0.9 的 uiConversation 把注册表放在 `.events` 上
  //   （见 conversationRegistrar 的注释）⇒ 守卫
  //   `typeof conversationEvents.register === 'function'` **恒 false** ⇒ 四个
  //   Definition 静默不注册 ⇒ user-actions 行 / marker 节点 / 编辑参考行全都不出现
  //   （用户看到的就是"没有编辑和撤回了"），而 boot 全绿、无任何报错。
  //   修法三条：
  //   1) 取值分两层：新形态 `.events.register`，旧宿主保留服务自身的 `register`；
  //   2) 等待用 `ctx.inject([...])` 子 fiber —— **静态 `export const inject` 里不加
  //      服务名**：旧宿主没有该服务时本插件行会永久 pending ⇒ `assertEntriesActive()`
  //      抛 `web boot: … did not activate` ⇒ **整个 renderer 起不来**（2026-09-14 实测）；
  //      子 fiber 不是 loader entry（`assertEntriesActive` 只遍历 `ctx.loader.entries()`），
  //      等不到也不影响 boot；
  //   3) 结果一律留一行宿主日志（见 sendClientReport）——"静默降级"本身就是第二层原因。
  //
  //   槽位计数口径：`slots` = 真正落进注册表的座位数（0..7）；`seats` = 本半发起的
  //   挂载点数（恒 7）。分开报是因为那些座位由**同批**其它插件行声明，并发 boot 下
  //   apply 时刻可能还没声明（`slots.inject` 会延后到声明时再回调）。
  let slotMounted = 0
  let slotSeats = 0
  let definitionsCount = 0
  let definitionsSource = 'none'
  let reportLines = 0
  let lastReportKey = ''
  const sendClientReport = () => {
    // 只打日志（宿主 handler 只走 logger.info），不落盘、不写会话。
    // 每次 apply 最多两行：一行现状 + 一行"状态真的变了"的更正（例如兜底先报了
    // definitions=0，随后服务就绪注册成功）。同一状态重复上报被抑制。
    const key = `${definitionsCount}|${definitionsSource}`
    if (reportLines > 0 && (key === lastReportKey || reportLines >= 2)) return
    reportLines += 1
    lastReportKey = key
    try {
      const sent = callOp('clientReport', {
        id: name,
        inject: [...inject],
        definitions: definitionsCount,
        slots: slotMounted,
        seats: slotSeats,
        source: definitionsSource,
      })
      if (sent && typeof sent.catch === 'function') sent.catch(() => { /* 上报失败不影响业务路径 */ })
    } catch {
      /* 上报失败不影响业务路径 */
    }
  }
  const scheduleClientReport = (delayMs) => {
    // 动态客户端 realm 把裸 setTimeout/setInterval 换成了会抛错的"教学陷阱"
    // （dsh-cordis-client-runner 的 closureTraps），所以定时器只走 window.*；
    // 没有 window（单测/无 DOM 环境）时退到微任务——语义一样：等本次 apply 的同步段
    // 跑完再报，这样槽位计数才是终值。
    const schedule = typeof window === 'undefined' ? undefined : window.setTimeout
    if (typeof schedule === 'function') {
      schedule(sendClientReport, delayMs)
      return
    }
    if (typeof queueMicrotask === 'function') {
      queueMicrotask(sendClientReport)
      return
    }
    sendClientReport()
  }
  // 兜底：两边服务都没等到时也要留下一行 definitions=0 的痕迹（窗口取 3s：同批服务
  // 就绪通常在毫秒级，正常路径在注册成功时就已报过，这里只是失败可见性）。
  scheduleClientReport(3000)
  const registerConversationDefinitions = (serviceName, service) => {
    if (definitionsCount > 0) return true
    const registrar = conversationRegistrar(service)
    if (registrar === null) {
      if (service !== undefined && service !== null) definitionsSource = `${serviceName}.no-register-entry`
      return false
    }
    // register() 返回的 disposer 要挂 ctx.effect：否则 Definition 会活过插件卸载/
    // 热重载，下一次 apply 直接 "already registered"（0.4.x review：设置里切一次就崩）。
    const disposeDefinitions = [
      registrar.register(userActionsDefinition),
      registrar.register(userReferenceDefinition),
      registrar.register(recallMarkerDefinition),
      // 第 1 段审计 `compaction/prune` 的读端上下文：不建视图（无 target），只为
      // 「顶层 provenance 被剥掉时取出被遮蔽集合」提供一个可按 kind 取到的相邻上下文
      // （0.4.12 的 data.shadowedSeqs 冗余已随官方词表收紧取消）。
      registrar.register(auditContextDefinition()),
    ]
    definitionsCount = disposeDefinitions.length
    definitionsSource = `${serviceName}.${registrar.via}`
    ctx.effect(
      () => () => disposeDefinitions.forEach((dispose) => { try { dispose() } catch { /* 幂等 disposer */ } }),
      `dsh-retrace: conversation definitions (${definitionsSource})`,
    )
    scheduleClientReport(0)
    return true
  }
  if (!registerConversationDefinitions('uiConversation', ctx.get('uiConversation'))) {
    // 客户端 shell 的 plugin boot 是 Promise.all（同批并发、无先后次序）⇒ 同批的
    // ui-conversation 行可能还没 apply。子 fiber 等它就绪（不阻塞、不影响 boot）。
    ctx.inject(['uiConversation'], (child) => {
      if (!registerConversationDefinitions('uiConversation', child.get('uiConversation'))) scheduleClientReport(0)
    })
  }
  if (definitionsCount === 0 && !registerConversationDefinitions('conversationEvents', ctx.get('conversationEvents'))) {
    // 旧宿主回退（2.0.9 上这个服务已不存在 ⇒ 子 fiber 永久等待，无害）。
    ctx.inject(['conversationEvents'], (child) => {
      if (!registerConversationDefinitions('conversationEvents', child.get('conversationEvents'))) scheduleClientReport(0)
    })
  }

  // 槽位挂载：计数只用于自报（slots/seats），不改原有 slot.inject 语义。
  const mountSlot = (seat, mount) => {
    slotSeats += 1
    return ctx.slots.inject(seat, () => {
      const dispose = mount()
      slotMounted += 1
      return dispose
    })
  }

  mountSlot('conversation.chat.assistant-actions', () => ctx.slots.register({
    name: 'conversation.chat.assistant-actions',
    id: 'retrace',
    order: 20,
    locale: NS,
  }, withPanelBoundary(AssistantActions, 'panel.error.actions')))

  mountSlot('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'user-actions',
    locale: NS,
  }, withPanelBoundary(UserActionsRow, 'panel.error.userActions')))

  mountSlot('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'retrace-reference',
    locale: NS,
  }, withPanelBoundary(ReferenceRow, 'panel.error.reference')))

  mountSlot('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'recall-marker',
    locale: NS,
  }, withPanelBoundary(RecallMarkerRow, 'panel.error.marker')))

  // P0 (0.4.2, trajectory-leverage) — the version timeline as an official
  // conversation view tab (next to 对话/轨迹). The view shell + switching are
  // the official mechanisms; the versions data channel stays plugin-owned
  // (projection push frames → HTTP /versions fallback).
  mountSlot('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'retrace',
    order: 20,
    locale: NS,
    label: () => t('view.retrace'),
    inject: (sessionId, actions) => ({
      actions,
      store: ctx.get?.('sessions')?.binding?.(sessionId)?.session,
    }),
    // The boundary wraps the view INSIDE the host's React tree, so a render error
    // can only break this panel (never the whole GUI).
  }, withPanelBoundary(RetraceView, 'view.errorTitle')))

  mountSlot('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'retrace',
    order: 30,
    locale: NS,
  }, withPanelBoundary(OptionsRow, 'panel.error.options')))
}
