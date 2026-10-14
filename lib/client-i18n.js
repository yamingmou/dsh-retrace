/**
 * dsh-retrace — client i18n dictionaries + operation-failure copy.
 *
 * Split out of lib/client.js (the published tree enforces a per-file byte
 * limit). The plugin export surface is unchanged: lib/client.js imports and
 * re-exports every name declared here.
 */
/** Simplified Chinese dictionary (key-set source of truth). */
export const zh = {
  // 「编辑」这个入口就应该是**「重发」** —— 它的语义是
  //   "本条及其后重开"(不是改一段文字)。英文同口径(Resend)。旧词「编辑」不再出现在
  //   按钮/标题/提示里(grep 守卫见 test/client-wording.test.js)。
  'action.edit': '重发',
  'action.editAria': '重发这条消息',
  'action.recall': '撤回',
  'action.recallAssistant': '撤回这条回复',
  'action.recallUser': '撤回这条消息',
  // 撤回是破坏性动作（本条及其后退出对话）⇒ 点按钮只开确认，确认后才发请求。
  'action.recallConfirm': '撤回这条消息？',
  // 就事论事说「撤回」:不再提"归档"。原内容确实还在、也真能找回,
  // 所以保留一句真实可用的替代操作 —— 就是这条 marker 上的「恢复显示」按钮。
  'action.recallConfirmDesc': '撤回后本条及其后的对话将从此处重新继续；原内容之后可用该标记上的「恢复显示」找回。',
  'action.recallConfirmYes': '撤回',
  'action.recallConfirmCancel': '取消',
  // 撤回前先暂停在飞轮次：
  // 运行中点确认时先显示暂停提示；暂停失败/超时也**必须**有可见文案（不许静默）。
  'action.recallPausing': '正在暂停当前运行…',
  'action.recallPauseFailed': '未能暂停当前运行，已继续撤回',
  'action.recallPauseTimeout': '等待暂停超时，已继续撤回',
  'action.regenerate': '重新生成',
  'action.send': '发送',
  // 「重发的主语义 = 从这条重开(重新编辑发送),后边是新的时间线分支」:
  //   `action.sendOnlyThis` **不再是并列按钮** —— 它是重开被守卫/写路径拒绝后,错误提示里
  //   才出现的兜底动作(只替换本条及其回复,后续原样保留)。
  'action.sendOnlyThis': '仅改文本（保留后续）',
  'action.sendOnlyThisHint': '只替换本条及其回复，后面的对话原样保留（不进入新的时间线分支）',
  'action.sendFromHere': '重发（从这条重开）',
  'action.sendFromHereHint': '重发即重开：本条及其后将被替换／隐藏，后续进入新的时间线分支。范围过大时守卫会拒绝，届时错误提示里会给出「仅改文本（保留后续）」。',
  'action.reopenBlocked': '本条及其后范围过大／被守卫拒绝，无法一并重开。若只是想改这段文字，可用兜底动作：',
  'error.rollbackGuide': '本次改写范围过大（大会话不支持整体重写）：本条及其后无法一并替换。请改用下方出现的「仅改文本（保留后续）」，或先新建会话再重开。',
  'action.cancel': '取消',
  'marker.recall': '已撤回这条消息及其后的对话',
  'marker.recallMany': '已撤回 {count} 条消息',
  'marker.recallOne': '已撤回 1 条消息',
  // op='edit' 的 notice 文案同口径改为「重发」。
  'marker.edit': '已重发此消息（本条及其后重开），对话从新消息继续',
  'marker.regenerate': '已重新生成回复',
  // 回档(rollback)marker 的提示:此前无此键且 op 落到兜底 'edit',界面误显示「已编辑
  // 此消息并重新发送」。回档语义 = 面回退到该读档点(与撤回/编辑一样隐藏被替换的后续节点)。
  'marker.restore': '已回退到该档位',
  'marker.originalLabel': '原输入',
  'marker.referenceHint': '点击展开查看原提问（仅作对照，不会进入模型上下文）',
  'marker.degradedHint': '此操作涉及大范围对话，为保护历史未隐藏内容（日志完好）。',
  // 替代操作改了 —— `hideShadowed` 开关已于 0.4.120 撤除,
  //   「设置→通用关闭按标记隐藏」是**死路文案**。真实替代操作 = 标记行上的「恢复显示」。
  'marker.unionHint': '已累积隐藏约 {count}% 的历史消息；在任一标记行点「恢复显示」即可找回被撤回的内容。',
  // 撤销撤回(0.4.124)——取消标记的 notice 文案 / 按钮 / 状态。中英成对。
  'marker.unhide': '已恢复显示被撤回的内容（模型上下文与撤回痕迹不变）',
  'marker.unhideAction': '恢复显示',
  'marker.unhiding': '恢复中…',
  'marker.unhideHint': '把这枚标记隐藏的内容重新显示出来（只改界面显示：日志只增不减，模型上下文不变）',
  'marker.restored': '已恢复显示',
  // 真正恢复(0.4.126)——日志层面撤销:把被撤回内容放回**模型面**,编辑/重发/撤回入口复活。
  // 与「恢复显示」的区别必须写在按钮旁边(前者只改界面,后者改日志),否则用户分不清。
  'marker.trueRestore': '已真正恢复：被撤回内容回到模型上下文（日志原地中和，seq 不变）',
  'marker.trueRestoreAction': '真正恢复',
  'marker.trueRestoring': '真正恢复中…',
  'marker.trueRestoreHint': '把被撤回内容**放回模型上下文**（改写日志里这两段标记为无效果形状）：恢复后该区间重新可编辑/可撤回/可重发。可在本会话里直接执行（按钮就在该会话内）；只有该会话有在途轮次时会被拒。恢复后本会话视图当场重载；若界面仍是旧视图，最后兜底 = 刷新页面（或重开该会话）。',
  'marker.trueRestoreReload': '日志已改写：已下发重读信号，本会话视图当场重载，恢复后的内容重新可见（模型面已放回）。若界面仍是旧视图，请刷新页面（或重开该会话）。',
  'error.unshadowHeld': '会话文件正被其他进程持有：请先关闭占用它的进程再恢复。',
  'error.unshadowRunning': '该会话有在途轮次：请先停止当前回复（点停止按钮/等它停稳）再恢复。',
  'error.unshadowReshadowed': '该区间已被更晚的标记重新遮蔽：请先真正恢复更晚那枚标记，再恢复这一枚。',
  'error.unshadowUnavailable': '当前宿主未装配「真正恢复」能力（需要宿主侧注入日志手术面）。',
  'error.unshadowLsof': '无法确认会话文件是否被占用（lsof 不可用）：为安全起见拒绝执行。',
  'marker.t1Broken': '编辑已生效；此标记会使本会话的 /compact 失效。离线清理：关闭会话后运行 dsh-log-contract fix --drop-turnnull（编辑外观会回退为原始内容）。',
  'options.title': '消息编辑插件',
  'options.showOriginalInput': '编辑后显示原提问对照',
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
  'badge.hint': '谱系标识由会话唯一 id 确定性导出，永不变（标题会变）。',
  'timeline.close': '关闭',
  'timeline.empty': '还没有读档点。撤回 / 编辑 / 重新生成会自动存一档。',
  'timeline.loading': '加载中…',
  'timeline.error': '时间线加载失败',
  'timeline.kind.recall': '撤回',
  'timeline.kind.edit': '重发',
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
  'timeline.gitHead': '提交 {hash}',
  'timeline.gitDirty': '工作区有未提交改动',
  'timeline.gitInit': '启用 git 读档点管理',
  'timeline.gitInitDesc': '在工作区执行 git init（仅添加 .gitignore 与一个基线提交），读档点回退将优先使用 git。',
  'timeline.gitInitConfirm': '确定要初始化 git 吗？',
  'error.generic': '操作失败，请重试',
  'error.busy': '请先停止当前回复再操作',
  // 回档失败不再静默（预览/确认两处）：保留原始错误便于诊断。
  'error.rollbackPreview': '回档预览失败：{message}',
  'error.rollback': '回档失败：{message}',
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
  // 实机发现：宿主自身的 surface 替换不是用户的改动，已过滤；数量如实告知。
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
  // 白屏故障：面板级错误边界的提示与重试。
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
  'options.closeGuardDesc': '关（默认）：开启后，页面关闭前确认退出——有运行中任务或未完成对话时，弹**本插件自绘**的中文确认框（[取消] / [仍要关闭]），点[仍要关闭]真的退出（确认框一直等你的选择，Esc 等同取消）；无任务直接关，不打扰。桌面端（DSH Desktop）不武装**宿主原生确认框**那条路（桌面壳未处理 will-prevent-unload，宿主框会被静默吞掉），改用**页面自绘确认门**：先画框并确认看得见，才拦下关闭；框画不出来、不可见或页面不可见 ⇒ 当场放行，看门狗（Web Worker 计时器，不受后台节流）只作最后一道。武装**原生门**的规则是两道：宿主说会弹原生框（quitVeto），且本页自己看不出桌面痕迹（UA 无 Electron、URL 无 dsh-desktop-）——任一条不成立就不武装（一票否决）。退出入口随版本/平台而变——外部报告的 0.9.0 一类入口会走到页面 beforeunload，2.0.9 的托盘/⌘Q 走 requestQuit→window.destroy→app.exit 不经过本门。桌面端退不掉时先关这一项（立即恢复，不用重启）。',
}
/** English dictionary, checked complete against the zh key set. */
export const en = {
  // the entry point is “Resend” — its semantics is
  //   "restart from this message"; the old “Edit” wording is gone from the button,
  //   its title/aria and the composer hint (zh/en stay paired).
  'action.edit': 'Resend',
  'action.editAria': 'Resend this message',
  'action.recall': 'Recall',
  'action.recallAssistant': 'Recall this reply',
  'action.recallUser': 'Recall this message',
  // Destructive: the chip only opens this confirmation; the request is sent on confirm.
  'action.recallConfirm': 'Recall this message?',
  // Say “recall” and nothing else.
  // The content really is still there, so keep the one genuinely working way back.
  'action.recallConfirmDesc': 'This message and everything after it continue from here; the original content can be brought back later with “Restore display” on this marker.',
  'action.recallConfirmYes': 'Recall',
  'action.recallConfirmCancel': 'Cancel',
  // Pause the in-flight turn before recalling. The
  // failure/timeout copies are user-visible on purpose: never silent.
  'action.recallPausing': 'Pausing the current run…',
  'action.recallPauseFailed': 'Could not pause the current run; recall continued',
  'action.recallPauseTimeout': 'Timed out waiting for the run to pause; recall continued',
  'action.regenerate': 'Regenerate',
  'action.send': 'Send',
  'action.sendOnlyThis': 'Change this text only (keep what follows)',
  'action.sendOnlyThisHint': 'Replace only this message and its reply; the conversation after it stays as is (no new timeline branch).',
  'action.sendFromHere': 'Resend (restart from here)',
  'action.sendFromHereHint': 'Resending restarts from here: this message and everything after it will be replaced/hidden and continue on a new timeline branch. Large ranges are refused by the guard — then the error offers “Change this text only (keep what follows)”.',
  'action.reopenBlocked': 'This message and everything after it is too large a range to restart (refused by the guard). If you only meant to change this text, use the fallback:',
  'error.rollbackGuide': 'This rewrite spans too much (large sessions cannot be rewritten in place): this message and everything after it cannot be replaced together. Use “Change this text only (keep what follows)” below, or start a new session to restart.',
  'action.cancel': 'Cancel',
  'marker.recall': 'This message and the following conversation were recalled',
  'marker.recallMany': '{count} messages were recalled',
  'marker.recallOne': '1 message recalled',
  // op='edit' notice copy: same “Resend” wording as the button (zh/en paired).
  'marker.edit': 'Resent (this message and everything after it restarted); the conversation continues from the new message',
  'marker.regenerate': 'Reply regenerated',
  // Rollback marker (op 'restore'): the surface rewound to that checkpoint.
  'marker.restore': 'Rolled back to this checkpoint',
  'marker.originalLabel': 'Original input',
  'marker.referenceHint': 'Click to expand the original input (reference only, never sent to the model)',
  'marker.degradedHint': 'This operation spans a large part of the conversation; content stays visible to protect your history (the log is intact).',
  // the old copy pointed at the removed "Hide shadowed messages"
  //   switch (dropped in 0.4.120) — a dead end. The real way out is the per-marker
  //   "Restore display" button.
  'marker.unionHint': 'About {count}% of the history is hidden in total; click "Restore display" on any marker row to bring recalled content back.',
  // Cancel marker (0.4.124) — notice copy, button, status.
  'marker.unhide': 'Display restored for the recalled content (model context and the recall trace are unchanged)',
  'marker.unhideAction': 'Restore display',
  'marker.unhiding': 'Restoring…',
  'marker.unhideHint': 'Show the content this marker hides again (display only: the log is append-only and the model context is unchanged)',
  'marker.restored': 'Display restored',
  // True restore (0.4.126) — log-level undo: puts the recalled content back on the
  // MODEL surface so edit/resend/recall work again (vs. "Restore display", which is UI-only).
  'marker.trueRestore': 'Truly restored: the recalled content is back in the model context (log neutralized in place, seq unchanged)',
  'marker.trueRestoreAction': 'True restore',
  'marker.trueRestoring': 'Restoring for real…',
  'marker.trueRestoreHint': 'Put the recalled content back on the MODEL surface (rewrites those two marker lines into a no-effect shape): afterwards the range is editable/recallable/resendable again. Works from inside this session (the button lives here); only an in-flight turn is refused. The session view reloads right away; if it still shows the old view, reload the page (or reopen the session) as the last resort.',
  'marker.trueRestoreReload': 'The log was rewritten: a re-read signal was pushed, this session view reloads right away and the restored content is visible again (the model surface is restored). If the view still shows the old one, reload the page (or reopen the session).',
  'error.unshadowHeld': 'The session file is held by another process: close the process holding it and retry.',
  'error.unshadowRunning': 'This session has an in-flight turn: stop the current reply (stop button / wait for it to settle), then retry.',
  'error.unshadowReshadowed': 'That range is shadowed again by a later marker: true-restore the later marker first, then this one.',
  'error.unshadowUnavailable': 'This host did not wire the true-restore capability (the host must inject the log-surgery surface).',
  'error.unshadowLsof': 'Cannot verify whether the session file is in use (lsof unavailable): refusing to proceed.',
  'marker.t1Broken': 'Edit applied; this marker will break /compact for this session. Offline clean-up: close the session and run dsh-log-contract fix --drop-turnnull (the edit reverts to the original content).',
  'options.title': 'Message editor plugin',
  'options.showOriginalInput': 'Show the original input after editing',
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
  'badge.hint': 'A stable lineage ID derived from the session id (titles change, badges never do).',
  'timeline.close': 'Close',
  'timeline.empty': 'No checkpoints yet. A recall / edit / regenerate saves one here.',
  'timeline.loading': 'Loading…',
  'timeline.error': 'Failed to load the timeline',
  'timeline.kind.recall': 'Recall',
  'timeline.kind.edit': 'Resend',
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
  // Rollback failures are never silent again (preview + confirm); the raw cause is kept.
  'error.rollbackPreview': 'Rollback preview failed: {message}',
  'error.rollback': 'Rollback failed: {message}',
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
  'options.closeGuardDesc': 'Off (default): when enabled, confirm before the page closes — when sessions have running or unfinished work this plugin shows its own Chinese confirm dialog ([Cancel] / [Close anyway]), and [Close anyway] really exits (the dialog waits for your choice; Esc cancels); with no running work the page closes directly, without interruption. Desktop (DSH Desktop) never arms the host native dialog path (the desktop shell has no will-prevent-unload handler, so that dialog is swallowed silently); it uses the page-drawn confirm gate instead: draw the dialog and verify it is visible first, only then block the close; if it cannot be drawn or shown, or the page is not visible, the close passes immediately, with a watchdog (Web Worker timer, immune to background throttling) as the last resort. Arming the native gate takes both criteria: the host says a native dialog appears (quitVeto) AND this page shows no desktop evidence itself (no Electron in the UA, no dsh-desktop- in the URL) — if either fails it stays unarmed (a client-side veto). Quit entries differ by version/platform — the 0.9.0-class entry in the external report does reach page beforeunload, while the 2.0.9 tray/⌘Q goes requestQuit→window.destroy→app.exit and never reaches this gate. If Desktop cannot quit, turn this off first (recovers immediately, no restart).',
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
  if (code === 'rollback-guide') return t('error.rollbackGuide')   // 不再让用户去做未实现的"创建分支"
  // 真正恢复(0.4.126)的拒绝理由:必须给出"下一步怎么做",不能只甩 host 的长句
  // (英文界面同样要有英文文案)。
  if (code === 'session-held') return t('error.unshadowHeld')
  if (code === 'session-running') return t('error.unshadowRunning')
  if (code === 'restore-re-shadowed') return t('error.unshadowReshadowed')
  if (code === 'unshadow-unavailable') return t('error.unshadowUnavailable')
  if (code === 'lsof-unavailable') return t('error.unshadowLsof')
  // 契约违规是**内部错误**,detail(契约名/期望/实际)只进日志,不给用户看技术细节
  if (code === 'contract-violation') return t('error.generic')
  return message ?? t('error.generic')
}

/**
 * 「从这条重开」被挡（⇒ 才露出兜底动作「仅改文本（保留后续）」）的**判定单一来源**。
 *
 * 编辑的主语义恒为重开（`fromScratch: true`），兜底 `fromScratch: false` 只在重开
 * **本身**失败、且失败原因是"这条重开做不到"时才出现 —— 与主按钮不同排、不同时呈现。
 * 依据 host 侧**实际错误形状**（`lib/host-core.js` 的 op 信封只透传 `code`/`message`，
 * `needsConfirm`/`shadowed`/`share` 到不了客户端，故只能按 code 判）：
 *  - `rollback-guide` — 极端回档闸（`lib/prewrite-guard.js`，遮蔽节点数/占比超极端线）。
 *    这正是 `error.rollbackGuide` 文案对应的码，也是"范围过大"的唯一权威信号。
 *  - `marker-rejected` — 写路径/契约拒写（`lib/prewrite-guard.js` 的 W 系列）。重开用的
 *    tail 区间被拒时，只改本条的 round 区间是**另一个更小区间**，仍有替代操作。
 *  - `span-replay-failed` — 文件侧 tail 区间重放不出来（`lib/host-core.js` 的
 *    `replay-failed`）。round 区间由独立探针算（`lib/index.js` 按 `fromScratch`
 *    选 `tail`/`round`），故重开算不出 ≠ 只改本条算不出。
 *
 * 明确**不**包含：`target-shadowed`/`message-not-found`/`message-pending`（目标本身
 * 的问题，round 区间同样会失败，给兜底按钮只是让用户再撞一次墙）、`agent-busy`
 * （可重试的瞬时状态）、`not-user-message`/`blank-text`/`agent-unavailable`
 * （与区间无关）。这些情况下主按钮重试/换目标才是替代操作，故不出现兜底入口。
 */
export function isReopenBlocked(code) {
  return code === 'rollback-guide' || code === 'marker-rejected' || code === 'span-replay-failed'
}

/**
 * 回档失败文案(预览 + 确认两处共用):i18n 前缀 + **原始错误**(诊断用)。
 * `cause` 既可能是 rejected promise 的 Error/'HTTP 500',也可能是 ok:false 的
 * host message 字符串;两者都保留。没有可取信息时兜底 error.generic。
 */
export function rollbackFailureText(key, cause, t) {
  const raw = cause instanceof Error ? cause.message : (typeof cause === 'string' ? cause : '')
  return t(key, { message: raw || t('error.generic') })
}
