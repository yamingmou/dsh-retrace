/**
 * dsh-retrace — client stylesheet (injected <style>).
 *
 * Split out of lib/client.js (published per-file byte limit). STYLE_ID/CSS were
 * module-private in lib/client.js and stay private there (imported, not
 * re-exported); only the file they live in changed.
 */
// ---------------------------------------------------------------------------
// Styles (plain injected <style>; removed with the plugin)
// ---------------------------------------------------------------------------
export const STYLE_ID = 'dsh-retrace-css'
export const CSS = `
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
.dsh-rt-error{display:flex;flex-direction:column;align-items:flex-end;gap:6px;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;max-width:min(525px,82%)}
.dsh-rt-error-text{text-align:right}
/* 兜底动作（仅改文本/保留后续）：只在重开被守卫拒绝时出现，**不与主按钮并列**。 */
.dsh-rt-error-fallback{display:flex;flex-direction:column;align-items:flex-end;gap:4px;padding:6px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-elevated)}
.dsh-rt-error-why{color:var(--dsw-alias-label-tertiary);text-align:right}
.dsh-rt-fallback-send{align-self:flex-end}
.dsh-rt-pause-note{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;max-width:min(525px,82%)}
.dsh-rt-marker-block{display:flex;flex-direction:column;align-items:center;gap:4px;width:100%;max-width:var(--dsh-chat-content-width);box-sizing:border-box;margin:0 auto;padding:2px 0}
.dsh-rt-marker{text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px}
.dsh-rt-marker-hint{text-align:center;color:var(--dsw-alias-state-warning-primary);font-size:11px;line-height:16px;margin-top:2px}
/* 撤销撤回(0.4.124):标记行上的「恢复显示」按钮 + 「已恢复显示」状态行。 */
.dsh-rt-marker-unhide{cursor:pointer;margin-top:2px}
.dsh-rt-marker-restored{text-align:center;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;margin-top:2px}
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
/* 行内撤回二次确认：fixed 遮罩 + 同一张 .dsh-rt-modal 卡片（不作为定位容器时改 auto 尺寸）。 */
.dsh-rt-confirm-scrim{position:fixed;inset:0;z-index:140;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,.32)}
.dsh-rt-modal.dsh-rt-confirm-card{position:relative;inset:auto;width:min(360px,100%);max-height:70vh}
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
