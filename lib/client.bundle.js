window.__ModuleLoader__.load({
	id: "dsh-retrace",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// lib/client.js
var client_exports = {};
__export(client_exports, {
  __setMessageEditorWire: () => __setMessageEditorWire,
  apply: () => apply,
  inject: () => inject,
  name: () => name
});
module.exports = __toCommonJS(client_exports);
var import_react = require("react");
var name = "dsh-retrace";
var inject = ["slots", "locale", "conversationEvents"];
var NS = "retrace";
var ROUTE_BASE = "/api/plugins/retrace";
var MARKER_PREFIX = "retrace";
var MARKER_PREFIXES = [MARKER_PREFIX, "message-editor"];
var LEGACY_MARKER_PREFIXES = ["message-editor"];
function isMarkerId(id) {
  return typeof id === "string" && MARKER_PREFIXES.some((p) => id.startsWith(`${p}-`));
}
function isLegacyMarkerId(id) {
  return typeof id === "string" && LEGACY_MARKER_PREFIXES.some((p) => id.startsWith(`${p}-`));
}
var CONFIG_KEY = "dsh-retrace:config";
var LEGACY_CONFIG_KEYS = ["dsh-message-editor:config"];
var zh = {
  "action.edit": "\u7F16\u8F91",
  "action.editAria": "\u7F16\u8F91\u8FD9\u6761\u6D88\u606F",
  "action.recall": "\u64A4\u56DE",
  "action.recallAssistant": "\u64A4\u56DE\u8FD9\u6761\u56DE\u590D",
  "action.recallUser": "\u64A4\u56DE\u8FD9\u6761\u6D88\u606F",
  "action.regenerate": "\u91CD\u65B0\u751F\u6210",
  "action.send": "\u53D1\u9001",
  "action.cancel": "\u53D6\u6D88",
  "marker.recall": "\u5DF2\u64A4\u56DE\u8FD9\u6761\u6D88\u606F\u53CA\u5176\u540E\u7684\u5BF9\u8BDD",
  "marker.recallMany": "\u5DF2\u64A4\u56DE {count} \u6761\u6D88\u606F",
  "marker.recallOne": "\u5DF2\u64A4\u56DE 1 \u6761\u6D88\u606F",
  "marker.edit": "\u5DF2\u7F16\u8F91\u6B64\u6D88\u606F\u5E76\u91CD\u65B0\u53D1\u9001\uFF0C\u5BF9\u8BDD\u4ECE\u65B0\u6D88\u606F\u7EE7\u7EED",
  "marker.regenerate": "\u5DF2\u91CD\u65B0\u751F\u6210\u56DE\u590D",
  "marker.originalLabel": "\u539F\u8F93\u5165",
  "marker.referenceHint": "\u70B9\u51FB\u5C55\u5F00\u67E5\u770B\u539F\u63D0\u95EE\uFF08\u4EC5\u4F5C\u5BF9\u7167\uFF0C\u4E0D\u4F1A\u8FDB\u5165\u6A21\u578B\u4E0A\u4E0B\u6587\uFF09",
  "marker.degradedHint": "\u6B64\u64CD\u4F5C\u6D89\u53CA\u5927\u8303\u56F4\u5BF9\u8BDD\uFF0C\u4E3A\u4FDD\u62A4\u5386\u53F2\u672A\u9690\u85CF\u5185\u5BB9\uFF08\u65E5\u5FD7\u5B8C\u597D\uFF09\u3002",
  "marker.unionHint": "\u5DF2\u7D2F\u79EF\u9690\u85CF\u7EA6 {count}% \u7684\u5386\u53F2\u6D88\u606F\uFF1B\u53EF\u5728 \u8BBE\u7F6E\u2192\u901A\u7528 \u5173\u95ED\u300C\u6309\u6807\u8BB0\u9690\u85CF\u300D\u67E5\u770B\u5B8C\u6574\u5386\u53F2\u3002",
  "options.title": "\u6D88\u606F\u7F16\u8F91\u63D2\u4EF6",
  "options.showOriginalInput": "\u7F16\u8F91\u540E\u663E\u793A\u539F\u63D0\u95EE\u5BF9\u7167",
  "options.editFromScratch": "\u7F16\u8F91\u540E\u4ECE\u65B0\u5BF9\u8BDD\u5F00\u59CB\uFF08\u9690\u85CF\u6B64\u524D\u7684\u6D88\u606F\uFF0C\u9ED8\u8BA4\u5173\uFF09",
  "options.hideShadowed": "\u6309\u6807\u8BB0\u9690\u85CF\u88AB\u7F16\u8F91/\u64A4\u56DE\u7684\u6D88\u606F",
  "options.hideShadowedDesc": "\u5F00\uFF08\u9ED8\u8BA4\uFF09\uFF1A\u64A4\u56DE/\u7F16\u8F91/\u91CD\u65B0\u751F\u6210\u6309\u6807\u8BB0\u9690\u85CF\u88AB\u66FF\u6362\u7684\u90A3\u4E00\u8F6E\u6D88\u606F\u3002\u5173\uFF1A\u6240\u6709\u6D88\u606F\u4FDD\u6301\u53EF\u89C1\uFF0C\u6807\u8BB0\u4EC5\u663E\u793A\u63D0\u793A\u4E0E\u5BF9\u7167\uFF08\u67E5\u770B\u5B8C\u6574\u5386\u53F2\u7528\uFF09\u3002\u4E00\u6B21\u64CD\u4F5C\u8981\u9690\u85CF\u8D85\u8FC7 40% \u7684\u5BF9\u8BDD\u65F6\u81EA\u52A8\u964D\u7EA7\u4E3A\u4E0D\u9690\u85CF\u3002",
  "options.versioning": "\u7248\u672C\u4E0E\u4EA7\u7269\u5FEB\u7167",
  "options.versioningDesc": "\u5F00\uFF1A\u6BCF\u6B21\u64A4\u56DE/\u7F16\u8F91\u8BB0\u5F55\u4E00\u4E2A\u7248\u672C\uFF08\u6D88\u606F\u4E0E\u89E6\u78B0\u6587\u4EF6\uFF09\uFF0C\u63D0\u4F9B\u65F6\u95F4\u7EBF\u4E0E\u4EA7\u7269\u56DE\u9000\uFF1B\u5173\uFF1A\u4EC5\u56DE\u9000\u4E0A\u4E0B\u6587\uFF0C\u4E0D\u8BB0\u5F55\u7248\u672C\u3001\u4E0D\u8FFD\u8E2A\u4EA7\u7269\uFF08\u6700\u7701\u8D44\u6E90\uFF09\u3002",
  "options.git": "\u542F\u7528 git \u96C6\u6210",
  "options.gitDesc": "\u5F00\uFF1A\u5DE5\u4F5C\u533A\u662F git \u4ED3\u5E93\u65F6\u7528 git \u8BB0\u5F55\u4E0E\u56DE\u9000\uFF08\u4E0D\u81EA\u52A8\u63D0\u4EA4\u3001\u4E0D\u52A8\u4F60\u7684\u5206\u652F\uFF09\uFF0C\u975E\u4ED3\u5E93\u53EF\u5728\u65F6\u95F4\u7EBF\u91CC\u4E00\u952E\u542F\u7528\uFF1B\u5173\uFF1A\u4E00\u5F8B\u7528\u5185\u7F6E\u5FEB\u7167\uFF08\u5B58\u4E8E ~/.dsh\uFF09\uFF0C\u4E0D\u89E6\u78B0\u5DE5\u4F5C\u533A git \u72B6\u6001\uFF0C\u529F\u80FD\u7B49\u4EF7\u3002",
  "options.retention": "\u7248\u672C\u4FDD\u7559\u4E0A\u9650",
  "options.retentionDesc": "\u6587\u4EF6\u5FEB\u7167\u53EA\u4FDD\u7559\u6700\u8FD1 N \u4E2A\u7248\u672C\uFF0C\u8D85\u51FA\u81EA\u52A8\u6E05\u7406\u6700\u65E7\u7684\uFF1B\u65F6\u95F4\u7EBF\u8BB0\u5F55\u4E0E\u5BA1\u8BA1\u75D5\u8FF9\u59CB\u7EC8\u4FDD\u7559\u3002",
  "timeline.open": "\u65F6\u95F4\u7EBF",
  "timeline.openAria": "\u6253\u5F00\u4F1A\u8BDD\u65F6\u95F4\u7EBF",
  "timeline.title": "\u7248\u672C\u65F6\u95F4\u7EBF",
  "view.retrace": "\u7248\u672C",
  "timeline.refresh": "\u5237\u65B0",
  "timeline.close": "\u5173\u95ED",
  "timeline.empty": "\u8FD8\u6CA1\u6709\u7248\u672C\u3002\u64A4\u56DE / \u7F16\u8F91 / \u91CD\u65B0\u751F\u6210\u4F1A\u5728\u6B64\u8BB0\u5F55\u7248\u672C\u3002",
  "timeline.loading": "\u52A0\u8F7D\u4E2D\u2026",
  "timeline.error": "\u65F6\u95F4\u7EBF\u52A0\u8F7D\u5931\u8D25",
  "timeline.kind.recall": "\u64A4\u56DE",
  "timeline.kind.edit": "\u7F16\u8F91\u91CD\u53D1",
  "timeline.kind.regenerate": "\u91CD\u65B0\u751F\u6210",
  "timeline.kind.restore": "\u6062\u590D",
  "timeline.kind.compaction": "\u538B\u7F29",
  "timeline.kind.replace": "\u66FF\u6362",
  "timeline.messages": "{count} \u6761\u6D88\u606F",
  "timeline.files": "{created} \u589E / {modified} \u6539 / {deleted} \u5220",
  "timeline.filesNone": "\u65E0\u6587\u4EF6\u53D8\u66F4",
  "timeline.preview": "\u56DE\u9000\u9884\u89C8",
  "timeline.previewDesc": "\u5C06\u56DE\u9000\u5230\u7248\u672C {version}\uFF08{kind}\uFF09\u3002",
  "timeline.contextOnly": "\u4EC5\u5BF9\u8BDD",
  "timeline.contextOnlyDesc": "\u79FB\u9664\u8BE5\u7248\u672C\u4E4B\u540E\u7684\u6D88\u606F\uFF08\u4FDD\u7559\u65E5\u5FD7\u5BA1\u8BA1\u75D5\u8FF9\uFF09",
  "timeline.artifactsOnly": "\u4EC5\u4EA7\u7269",
  "timeline.artifactsOnlyDesc": "\u628A\u8BE5\u7248\u672C\u89E6\u78B0\u7684\u6587\u4EF6\u6062\u590D\u5230\u5F53\u65F6\u7684\u5167\u5BB9",
  "timeline.both": "\u4E24\u8005",
  "timeline.bothDesc": "\u5148\u56DE\u9000\u5BF9\u8BDD\uFF0C\u518D\u56DE\u9000\u4EA7\u7269",
  "timeline.messagesRemoved": "\u5C06\u79FB\u9664 {count} \u6761\u6D88\u606F",
  "timeline.noChanges": "\u5F53\u524D\u5DF2\u5728\u8BE5\u7248\u672C\u72B6\u6001\uFF0C\u65E0\u53D8\u5316",
  "timeline.artifactsList": "\u4EA7\u7269\u52A8\u4F5C\uFF08{count}\uFF09",
  "timeline.artifact.restore": "\u6062\u590D",
  "timeline.artifact.delete": "\u5220\u9664",
  "timeline.artifact.skip": "\u8DF3\u8FC7",
  "timeline.confirm": "\u786E\u8BA4\u56DE\u9000",
  "timeline.cancel": "\u53D6\u6D88",
  "timeline.busy": "\u56DE\u9000\u4E2D\u2026",
  "timeline.detail": "\u8BE6\u60C5",
  "timeline.trajectory": "\u8F68\u8FF9\u53F0\u8D26",
  "timeline.jump": "\u8DF3\u8F6C",
  "timeline.jumpFailed": "\u8BE5\u7248\u672C\u5728\u8F83\u8FDC\u7684\u8FC7\u53BB\uFF08\u8D85\u51FA\u81EA\u52A8\u52A0\u8F7D\u9884\u7B97\uFF09\uFF0C\u65E0\u6CD5\u76F4\u63A5\u5B9A\u4F4D\u3002\u8BF7\u5411\u4E0A\u6EDA\u52A8\u52A0\u8F7D\u66F4\u65E9\u6D88\u606F\u540E\u91CD\u8BD5\uFF1B\u6216\u7528\u300C\u8BE6\u60C5\u300D\u67E5\u770B\u8BE5\u7248\u672C\u5F53\u65F6\u7684\u4E8B\u4EF6\u539F\u6587\u3002",
  "timeline.gitRepo": "git \u4ED3\u5E93",
  "timeline.gitHead": "HEAD {hash}",
  "timeline.gitDirty": "\u5DE5\u4F5C\u533A\u6709\u672A\u63D0\u4EA4\u6539\u52A8",
  "timeline.gitInit": "\u542F\u7528 git \u7248\u672C\u7BA1\u7406",
  "timeline.gitInitDesc": "\u5728\u5DE5\u4F5C\u533A\u6267\u884C git init\uFF08\u4EC5\u6DFB\u52A0 .gitignore \u4E0E\u4E00\u4E2A\u57FA\u7EBF\u63D0\u4EA4\uFF09\uFF0C\u7248\u672C\u56DE\u9000\u5C06\u4F18\u5148\u4F7F\u7528 git\u3002",
  "timeline.gitInitConfirm": "\u786E\u5B9A\u8981\u521D\u59CB\u5316 git \u5417\uFF1F",
  "error.generic": "\u64CD\u4F5C\u5931\u8D25\uFF0C\u8BF7\u91CD\u8BD5",
  "error.busy": "\u8BF7\u5148\u505C\u6B62\u5F53\u524D\u56DE\u590D\u518D\u64CD\u4F5C",
  "view.fork": "\u5206\u53C9",
  "fork.title": "\u5206\u53C9\u56FE",
  "fork.empty": "\u8FD8\u6CA1\u6709\u5206\u53C9\u3002\u64A4\u56DE / \u7F16\u8F91 / \u91CD\u65B0\u751F\u6210 / \u6062\u590D\u4F1A\u5728\u6B64\u4EA7\u751F\u5206\u53C9\u3002",
  "fork.refresh": "\u5237\u65B0",
  "fork.spine": "\u5F53\u524D\u8DEF\u5F84",
  "fork.shadowed": "\u88AB\u906E\u853D {count} \u4E2A\u8282\u70B9",
  "fork.node.user": "\u7528\u6237\u6D88\u606F",
  "fork.node.assistant": "\u52A9\u624B\u56DE\u590D",
  "fork.node.tool": "\u5DE5\u5177\u7ED3\u679C",
  "fork.histTitle": "\u5386\u53F2\u5206\u53C9\u70B9"
};
var en = {
  "action.edit": "Edit",
  "action.editAria": "Edit this message",
  "action.recall": "Recall",
  "action.recallAssistant": "Recall this reply",
  "action.recallUser": "Recall this message",
  "action.regenerate": "Regenerate",
  "action.send": "Send",
  "action.cancel": "Cancel",
  "marker.recall": "This message and the following conversation were recalled",
  "marker.recallMany": "{count} messages were recalled",
  "marker.recallOne": "1 message recalled",
  "marker.edit": "Edited and re-sent; the conversation continues from the new message",
  "marker.regenerate": "Reply regenerated",
  "marker.originalLabel": "Original input",
  "marker.referenceHint": "Click to expand the original input (reference only, never sent to the model)",
  "marker.degradedHint": "This operation spans a large part of the conversation; content stays visible to protect your history (the log is intact).",
  "marker.unionHint": 'About {count}% of the history is hidden in total; disable "Hide shadowed messages" in Settings \u2192 General to review the full history.',
  "options.title": "Message editor plugin",
  "options.showOriginalInput": "Show the original input after editing",
  "options.editFromScratch": "Start a fresh conversation after editing (hide earlier messages, default off)",
  "options.hideShadowed": "Hide shadowed messages per marker",
  "options.hideShadowedDesc": "On (default): recall/edit/regenerate hide the replaced round per their markers. Off: every message stays visible; markers only show the notice and reference (use to review full history). A single op that would hide more than 40% of the conversation degrades to notice-only automatically.",
  "options.versioning": "Version & artifact snapshots",
  "options.versioningDesc": "On: every recall/edit records a version (messages and touched files) powering the timeline and artifact rollback. Off: only rewinds context \u2014 no version records, no artifact tracking (lightest).",
  "options.git": "Git integration",
  "options.gitDesc": "On: uses git to record and roll back when the workspace is a repository (never auto-commits, never touches your branches); non-repo workspaces can enable git from the timeline. Off: built-in snapshots under ~/.dsh only \u2014 the plugin never touches the workspace git state; equivalent features.",
  "options.retention": "Version retention limit",
  "options.retentionDesc": "File snapshots are kept for the most recent N versions; older ones are pruned automatically (timeline records and the audit trail are always kept).",
  "timeline.open": "Timeline",
  "timeline.openAria": "Open the session timeline",
  "timeline.title": "Version timeline",
  "view.retrace": "Versions",
  "timeline.refresh": "Refresh",
  "timeline.close": "Close",
  "timeline.empty": "No versions yet. Recall / edit / regenerate record a version here.",
  "timeline.loading": "Loading\u2026",
  "timeline.error": "Failed to load the timeline",
  "timeline.kind.recall": "Recall",
  "timeline.kind.edit": "Edit & resend",
  "timeline.kind.regenerate": "Regenerate",
  "timeline.kind.restore": "Restore",
  "timeline.kind.compaction": "Compaction",
  "timeline.kind.replace": "Replace",
  "timeline.messages": "{count} messages",
  "timeline.files": "{created} created / {modified} modified / {deleted} deleted",
  "timeline.filesNone": "No file changes",
  "timeline.preview": "Rollback preview",
  "timeline.previewDesc": "Will roll back to version {version} ({kind}).",
  "timeline.contextOnly": "Context only",
  "timeline.contextOnlyDesc": "Remove messages after this version (the log audit trail stays)",
  "timeline.artifactsOnly": "Artifacts only",
  "timeline.artifactsOnlyDesc": "Restore the files this version touched to their state at that version",
  "timeline.both": "Both",
  "timeline.bothDesc": "Roll back the context first, then the artifacts",
  "timeline.messagesRemoved": "{count} messages will be removed",
  "timeline.noChanges": "Already at this version; nothing to change",
  "timeline.artifactsList": "Artifact actions ({count})",
  "timeline.artifact.restore": "restore",
  "timeline.artifact.delete": "delete",
  "timeline.artifact.skip": "skip",
  "timeline.confirm": "Confirm rollback",
  "timeline.cancel": "Cancel",
  "timeline.busy": "Rolling back\u2026",
  "timeline.detail": "Details",
  "timeline.trajectory": "Trajectory",
  "timeline.jump": "Jump",
  "timeline.jumpFailed": "This version lies too far back (beyond the auto-load budget) to locate directly. Scroll up to load earlier messages, or use Details to read the original event text of this version.",
  "timeline.gitRepo": "git repository",
  "timeline.gitHead": "HEAD {hash}",
  "timeline.gitDirty": "working tree has uncommitted changes",
  "timeline.gitInit": "Enable git versioning",
  "timeline.gitInitDesc": "Runs git init in the workspace (adds a minimal .gitignore and a baseline commit); rollback will prefer git.",
  "timeline.gitInitConfirm": "Initialize git in this workspace?",
  "error.generic": "Operation failed; please try again",
  "error.busy": "Stop the current reply before recalling or editing",
  "view.fork": "Fork",
  "fork.title": "Fork map",
  "fork.empty": "No forks yet. Recall / edit / regenerate / restore fork the path here.",
  "fork.refresh": "Refresh",
  "fork.spine": "Current path",
  "fork.shadowed": "{count} shadowed nodes",
  "fork.node.user": "User message",
  "fork.node.assistant": "Assistant reply",
  "fork.node.tool": "Tool result",
  "fork.histTitle": "Historical fork points"
};
var SURFACE_TYPES = /* @__PURE__ */ new Set(["user/message", "assistant/message", "tool/result"]);
function isReplacementSurfaceEvent(event) {
  return SURFACE_TYPES.has(event.type) && event.surfaceOp !== void 0 && event.surfaceOp !== "append";
}
var wire = null;
function __setMessageEditorWire(fn) {
  wire = fn;
}
function callOp(op, payload) {
  if (typeof wire === "function") return wire(op, payload);
  return fetch(`${ROUTE_BASE}/${op}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...retraceConfigHeaders() },
    body: JSON.stringify(payload)
  }).then((res) => {
    if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
    return res.json();
  });
}
function retraceConfigHeaders() {
  const { versioning, git, retentionLimit } = getConfig();
  return { "x-retrace-config": JSON.stringify({ versioning, git, retentionLimit }) };
}
var CONFIG_VERSION = 3;
var CONFIG_DEFAULTS = { version: CONFIG_VERSION, showOriginalInput: true, editFromScratch: false, hideShadowed: true, versioning: true, git: true, retentionLimit: 50, prewrite: true };
var configListeners = /* @__PURE__ */ new Set();
var configCache = readConfig();
var editReferences = /* @__PURE__ */ new Map();
function migrateConfig(parsed) {
  const version = typeof parsed.version === "number" ? parsed.version : 1;
  if (version >= CONFIG_VERSION) return { ...CONFIG_DEFAULTS, ...parsed };
  return {
    ...CONFIG_DEFAULTS,
    ...parsed,
    version: CONFIG_VERSION,
    editFromScratch: CONFIG_DEFAULTS.editFromScratch,
    hideShadowed: CONFIG_DEFAULTS.hideShadowed
  };
}
function readConfig() {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (raw !== null) {
      const parsed = raw ? JSON.parse(raw) : {};
      const migrated = migrateConfig(parsed);
      const storedVersion = typeof parsed.version === "number" ? parsed.version : 1;
      if (storedVersion < CONFIG_VERSION) {
        try {
          localStorage.setItem(CONFIG_KEY, JSON.stringify(migrated));
        } catch {
        }
      }
      return migrated;
    }
    for (const legacyKey of LEGACY_CONFIG_KEYS) {
      const legacyRaw = localStorage.getItem(legacyKey);
      if (legacyRaw !== null) {
        const migrated = migrateConfig(legacyRaw ? JSON.parse(legacyRaw) : {});
        try {
          localStorage.setItem(CONFIG_KEY, JSON.stringify(migrated));
        } catch {
        }
        return migrated;
      }
    }
    return { ...CONFIG_DEFAULTS };
  } catch {
    return { ...CONFIG_DEFAULTS };
  }
}
function getConfig() {
  return configCache;
}
function setConfig(patch) {
  configCache = { ...configCache, ...patch };
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(configCache));
  } catch {
  }
  for (const listener of configListeners) listener(configCache);
}
function subscribeConfig(listener) {
  configListeners.add(listener);
  return () => {
    configListeners.delete(listener);
  };
}
function useConfig() {
  const [, force] = (0, import_react.useState)(0);
  (0, import_react.useEffect)(() => subscribeConfig(() => force((x) => x + 1)), []);
  return getConfig();
}
function chatNodeLike(context, kind, anchorSeq, data) {
  return {
    key: context.key,
    kind,
    id: context.id,
    target: "chat",
    anchorSeq,
    location: context.start?.location ?? context.matches[0]?.location ?? { kind: "unresolved" },
    visibility: "visible",
    data
  };
}
var userActionsDefinition = {
  kind: "retrace-actions",
  target: "chat",
  match: (event) => event.type === "user/message" && event.surfaceOp === "append" && event.data.source?.kind === "user" ? { id: String(event.data.id), role: "start" } : null,
  start: (_context, match) => {
    const event = match.event;
    return {
      seq: event.seq,
      time: event.time,
      messageId: String(event.data.id),
      content: event.data.content
    };
  },
  update: (context) => context.state,
  buildViewNode: (context) => {
    if (context.state === void 0) return null;
    return chatNodeLike(context, "user-actions", context.state.seq, context.state);
  }
};
var userReferenceDefinition = {
  kind: "retrace-reference",
  target: "chat",
  match: (event) => event.type === "user/message" && event.surfaceOp === "append" && event.data.source?.kind === "user" ? { id: `ref:${String(event.data.id)}`, role: "start" } : null,
  start: (_context, match) => {
    const event = match.event;
    return {
      seq: event.seq,
      time: event.time,
      messageId: String(event.data.id),
      content: event.data.content
    };
  },
  update: (context) => context.state,
  buildViewNode: (context) => {
    if (context.state === void 0) return null;
    return chatNodeLike(context, "retrace-reference", context.state.seq - 0.5, context.state);
  }
};
function markerOpFromId(id) {
  for (const p of MARKER_PREFIXES) {
    if (id.startsWith(`${p}-recall-`)) return "recall";
    if (id.startsWith(`${p}-edit-`)) return "edit";
    if (id.startsWith(`${p}-regenerate-`)) return "regenerate";
  }
  return "edit";
}
var recallMarkerDefinition = {
  kind: "recall-marker",
  target: "chat",
  match: (event) => {
    if (event.type !== "assistant/message" || !isReplacementSurfaceEvent(event)) return null;
    const id = event.data?.message?.id;
    if (!isMarkerId(id)) return null;
    return { id: `marker:${id}`, role: "start" };
  },
  start: (_context, match) => {
    const event = match.event;
    const id = String(event.data.message.id);
    const legacy = isLegacyMarkerId(id);
    return {
      seq: event.seq,
      time: event.time,
      op: markerOpFromId(id),
      legacy,
      // Legacy markers never hide: treat their shadowed range as empty so the
      // notice/reference render but no row is hidden and no action row is
      // suppressed via useShadowed.
      shadowedSeqs: legacy ? [] : Array.isArray(event.sourceEventSeqs) ? event.sourceEventSeqs.slice() : [],
      targetSeq: event.data?.editor?.targetSeq,
      text: event.data?.editor?.text
    };
  },
  update: (context) => context.state,
  buildViewNode: (context) => {
    if (context.state === void 0) return null;
    return chatNodeLike(context, "recall-marker", context.state.seq, context.state);
  }
};
function textOf(content) {
  if (!Array.isArray(content)) return "";
  return content.filter((block) => block && block.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n");
}
function useMessageSeq(useSession, messageId) {
  return useSession((snapshot) => {
    for (const node of snapshot.chat.nodes.values()) {
      if (node.kind === "assistant-step" && node.data?.finalNode?.messageId === messageId) {
        return node.data.finalNode.seq;
      }
    }
    return void 0;
  });
}
var SHADOW_SAFETY_RATIO = 0.4;
function hiddenKeysFor(shadowedSeqs, nodes) {
  if (!Array.isArray(shadowedSeqs) || shadowedSeqs.length === 0) return null;
  const hidden = new Set(shadowedSeqs);
  const keys = [];
  for (const node of nodes.values()) {
    if (node.kind === "recall-marker") continue;
    if (node.kind === "turn-tail") {
      const closingSeq = node.data?.closing?.finalNode?.seq;
      if (typeof closingSeq === "number" && hidden.has(closingSeq)) keys.push(node.key);
      continue;
    }
    if (node.kind === "tool-call") {
      const resultSeq = node.data?.root?.seq;
      if (typeof resultSeq === "number" && hidden.has(resultSeq)) keys.push(node.key);
      continue;
    }
    if (typeof node.anchorSeq === "number" && hidden.has(node.anchorSeq)) keys.push(node.key);
  }
  return keys.length === 0 ? null : keys;
}
var EMPTY_HIDE_PLAN = Object.freeze({
  hiddenFor: () => null,
  planFor: () => null,
  unionRatio: 0,
  firstMarkerKey: null
});
function useMarkerHidePlan(useSession) {
  return useSession((snapshot) => {
    const nodes = snapshot.chat.nodes;
    let rowCount = 0;
    const markers = [];
    for (const node of nodes.values()) {
      if (typeof node.anchorSeq === "number") rowCount += 1;
      if (node.kind === "recall-marker") markers.push(node);
    }
    if (markers.length === 0) return EMPTY_HIDE_PLAN;
    const plans = /* @__PURE__ */ new Map();
    const union = /* @__PURE__ */ new Set();
    for (const marker of markers) {
      const keys = hiddenKeysFor(marker.data?.shadowedSeqs, nodes);
      const degraded = keys !== null && rowCount > 0 && keys.length / rowCount > SHADOW_SAFETY_RATIO;
      plans.set(marker.key, { keys: degraded ? null : keys, degraded });
      if (keys !== null) for (const key of keys) union.add(key);
    }
    return {
      planFor: (key) => plans.get(key) ?? null,
      hiddenFor: (key) => plans.get(key)?.keys ?? null,
      unionRatio: rowCount > 0 ? union.size / rowCount : 0,
      firstMarkerKey: markers[0].key
    };
  });
}
function rowHiddenByKey(snapshot, rowKey) {
  if (rowKey === void 0 || rowKey === null) return false;
  const nodes = snapshot.chat.nodes;
  let rowCount = 0;
  for (const node of nodes.values()) if (typeof node.anchorSeq === "number") rowCount += 1;
  for (const node of nodes.values()) {
    if (node.kind !== "recall-marker") continue;
    const keys = hiddenKeysFor(node.data?.shadowedSeqs, nodes);
    if (keys === null) continue;
    if (rowCount > 0 && keys.length / rowCount > SHADOW_SAFETY_RATIO) continue;
    if (keys.includes(rowKey)) return true;
  }
  return false;
}
function useRowHidden(useSession, key) {
  return useSession((snapshot) => rowHiddenByKey(snapshot, key));
}
function useSeqHidden(useSession, seq) {
  return useSession((snapshot) => {
    if (seq === void 0 || seq === null) return false;
    for (const node of snapshot.chat.nodes.values()) {
      if (node.kind !== "recall-marker" && typeof node.anchorSeq === "number" && node.anchorSeq === seq) {
        return rowHiddenByKey(snapshot, node.key);
      }
    }
    return false;
  });
}
function useMarkerDismissed(useSession, markerSeq, op) {
  return useSession((snapshot) => {
    if (typeof markerSeq !== "number") return false;
    let after = 0;
    for (const node of snapshot.chat.nodes.values()) {
      if (node.kind === "user-actions" && typeof node.data?.seq === "number" && node.data.seq > markerSeq) {
        after += 1;
      }
    }
    return op === "edit" ? after >= 2 : after >= 1;
  });
}
function useEditReference(useSession, mySeq) {
  return useSession((snapshot) => {
    if (typeof mySeq !== "number") return null;
    let latestMarkerSeq = -1;
    let referenceText = null;
    let prevUserSeq = -1;
    for (const node of snapshot.chat.nodes.values()) {
      if (node.kind === "recall-marker" && node.data?.op === "edit" && typeof node.data.seq === "number" && node.data.seq < mySeq && node.data.seq > latestMarkerSeq) {
        latestMarkerSeq = node.data.seq;
        referenceText = typeof node.data.text === "string" && node.data.text.length > 0 ? node.data.text : null;
      }
      if (node.kind === "user-actions" && typeof node.data?.seq === "number" && node.data.seq < mySeq && node.data.seq > prevUserSeq) {
        prevUserSeq = node.data.seq;
      }
    }
    if (latestMarkerSeq === -1 || referenceText === null) return null;
    if (prevUserSeq > latestMarkerSeq) return null;
    return referenceText;
  });
}
function AssistantActions({ messageId, sessionId, useSession, t }) {
  const seq = useMessageSeq(useSession, messageId);
  const hidden = useSeqHidden(useSession, seq);
  const [busy, setBusy] = (0, import_react.useState)(false);
  const [failure, setFailure] = (0, import_react.useState)(null);
  if (hidden || seq === void 0) return null;
  const run = (op) => {
    setBusy(true);
    setFailure(null);
    callOp(op, { sessionId, messageId }).then(
      (result) => {
        setBusy(false);
        if (!result || result.ok !== true) {
          const message = result?.error?.message || "Operation failed; please try again";
          const code = result?.error?.code;
          setFailure(code === "agent-busy" ? t("error.busy") : message);
        }
      },
      (error) => {
        setBusy(false);
        setFailure(error?.message ?? t("error.generic"));
      }
    );
  };
  return (0, import_react.createElement)("span", { className: "dsh-rt-strip" }, [
    (0, import_react.createElement)("button", {
      key: "recall",
      type: "button",
      className: "dsh-rt-icon",
      title: t("action.recallAssistant"),
      "aria-label": t("action.recallAssistant"),
      disabled: busy,
      onClick: () => run("recall")
    }, "\u21A9"),
    (0, import_react.createElement)("button", {
      key: "regenerate",
      type: "button",
      className: "dsh-rt-icon",
      title: t("action.regenerate"),
      "aria-label": t("action.regenerate"),
      disabled: busy,
      onClick: () => run("regenerate")
    }, "\u21BB"),
    failure !== null && (0, import_react.createElement)("span", { key: "error", className: "dsh-rt-error", role: "status" }, failure)
  ]);
}
function ReferenceRow({ node, useSession, t }) {
  const { seq, messageId } = node.data;
  const hidden = useRowHidden(useSession, node.key);
  const markerRef = useEditReference(useSession, seq);
  const referenceText = editReferences.get(messageId) ?? markerRef;
  const config = useConfig();
  if (hidden) return null;
  if (referenceText === null || !config.showOriginalInput) return null;
  return (0, import_react.createElement)("div", { className: "dsh-rt-user-row" }, [
    (0, import_react.createElement)("details", { className: "dsh-rt-reference" }, [
      (0, import_react.createElement)(
        "summary",
        { title: t("marker.referenceHint") },
        `${t("marker.originalLabel")}\uFF1A${referenceText.length > 60 ? `${referenceText.slice(0, 60)}\u2026` : referenceText}`
      ),
      (0, import_react.createElement)("div", { className: "dsh-rt-reference-text" }, referenceText)
    ])
  ]);
}
function UserActionsRow({ node, sessionId, useSession, inputActions, t }) {
  const { seq, messageId, content } = node.data;
  const hidden = useRowHidden(useSession, node.key);
  const [editing, setEditing] = (0, import_react.useState)(false);
  const [draft, setDraft] = (0, import_react.useState)("");
  const [busy, setBusy] = (0, import_react.useState)(false);
  const [failure, setFailure] = (0, import_react.useState)(null);
  if (hidden) return null;
  const openEditor = () => {
    setDraft(textOf(content));
    setFailure(null);
    setEditing(true);
  };
  const closeEditor = () => {
    setEditing(false);
    setFailure(null);
  };
  const settle = (result, op) => {
    setBusy(false);
    if (!result || result.ok !== true) {
      const code = result?.error?.code;
      setFailure(code === "agent-busy" ? t("error.busy") : result?.error?.message ?? t("error.generic"));
      return;
    }
    if (op === "recall") {
      const echoed = typeof result.value?.text === "string" && result.value.text.length > 0 ? result.value.text : textOf(content);
      if (echoed && inputActions && typeof inputActions.setDraft === "function") {
        inputActions.setDraft(echoed);
      }
      return;
    }
    if (op === "editAndResend") {
      if (result.value?.resendMessageId && typeof result.value?.originalText === "string") {
        editReferences.set(result.value.resendMessageId, result.value.originalText);
      }
      setEditing(false);
    }
  };
  const run = (op, extra = {}) => {
    setBusy(true);
    setFailure(null);
    callOp(op, { sessionId, messageId, ...extra }).then(
      (result) => settle(result, op),
      (error) => {
        setBusy(false);
        setFailure(error?.message ?? t("error.generic"));
      }
    );
  };
  return (0, import_react.createElement)("div", { className: "dsh-rt-user-row" }, [
    editing ? (0, import_react.createElement)("div", { key: "editor", className: "dsh-rt-editor" }, [
      (0, import_react.createElement)("textarea", {
        key: "input",
        className: "dsh-rt-textarea",
        "aria-label": t("action.editAria"),
        value: draft,
        rows: 3,
        onChange: (event) => setDraft(event.target.value)
      }),
      (0, import_react.createElement)("div", { key: "buttons", className: "dsh-rt-editor-buttons" }, [
        (0, import_react.createElement)("button", {
          key: "send",
          type: "button",
          className: "dsh-rt-editor-send",
          disabled: busy || draft.trim().length === 0,
          onClick: () => run("editAndResend", {
            text: draft.trim(),
            fromScratch: getConfig().editFromScratch
          })
        }, t("action.send")),
        (0, import_react.createElement)("button", {
          key: "cancel",
          type: "button",
          className: "dsh-rt-editor-cancel",
          disabled: busy,
          onClick: closeEditor
        }, t("action.cancel"))
      ])
    ]) : (0, import_react.createElement)("span", { key: "row", className: "dsh-rt-user-actions" }, [
      (0, import_react.createElement)("button", {
        key: "edit",
        type: "button",
        className: "dsh-rt-chip",
        title: t("action.edit"),
        disabled: busy,
        onClick: openEditor
      }, t("action.edit")),
      (0, import_react.createElement)("button", {
        key: "recall",
        type: "button",
        className: "dsh-rt-chip",
        title: t("action.recallUser"),
        disabled: busy,
        onClick: () => run("recall")
      }, t("action.recall"))
    ]),
    failure !== null && (0, import_react.createElement)("div", { key: "error", className: "dsh-rt-error", role: "status" }, failure)
  ]);
}
function RecallMarkerRow({ node, useSession, t }) {
  const { seq, op, shadowedSeqs, legacy } = node.data;
  const dismissed = useMarkerDismissed(useSession, seq, op);
  const hidePlan = useMarkerHidePlan(useSession);
  const plan = hidePlan.planFor(node.key);
  const hiddenKeys = legacy || !getConfig().hideShadowed ? null : plan?.keys ?? null;
  const css = hiddenKeys === null ? null : hiddenKeys.map((key) => `[data-chat-anchor-key=${JSON.stringify(key)}]{display:none!important}`).join("");
  const count = Array.isArray(shadowedSeqs) ? shadowedSeqs.length : 0;
  const label = op === "recall" ? count > 1 ? t("marker.recallMany", { count }) : t("marker.recallOne") : op === "regenerate" ? t("marker.regenerate") : t("marker.edit");
  const degradedHint = !legacy && plan?.degraded === true ? (0, import_react.createElement)("div", { key: "degraded", className: "dsh-rt-marker-hint" }, t("marker.degradedHint")) : null;
  const unionHint = !legacy && hidePlan.firstMarkerKey === node.key && hidePlan.unionRatio > SHADOW_SAFETY_RATIO ? (0, import_react.createElement)(
    "div",
    { key: "union", className: "dsh-rt-marker-hint" },
    t("marker.unionHint", { count: Math.round(hidePlan.unionRatio * 100) })
  ) : null;
  return (0, import_react.createElement)("div", { className: "dsh-rt-marker-block", "data-dismissed": dismissed || void 0 }, [
    css !== null && (0, import_react.createElement)("style", { key: "hide", dangerouslySetInnerHTML: { __html: css } }),
    !dismissed && (0, import_react.createElement)("div", { key: "label", className: "dsh-rt-marker", role: "status" }, label),
    !dismissed && degradedHint,
    !dismissed && unionHint
  ]);
}
function OptionsRow({ t }) {
  const config = useConfig();
  const toggle = (key) => (event) => setConfig({ [key]: event.target.checked });
  const optionRow = (key, labelKey, descKey) => (0, import_react.createElement)("label", { key, className: "dsh-rt-option" }, [
    (0, import_react.createElement)("input", { type: "checkbox", checked: config[key], onChange: toggle(key) }),
    (0, import_react.createElement)("span", { className: "dsh-rt-option-text" }, [
      (0, import_react.createElement)("span", { className: "dsh-rt-option-label" }, t(labelKey)),
      (0, import_react.createElement)("span", { className: "dsh-rt-option-desc" }, t(descKey))
    ])
  ]);
  return (0, import_react.createElement)("div", { className: "dsh-rt-options" }, [
    (0, import_react.createElement)("div", { key: "title", className: "dsh-rt-options-title" }, t("options.title")),
    (0, import_react.createElement)("label", { key: "original", className: "dsh-rt-option" }, [
      (0, import_react.createElement)("input", {
        type: "checkbox",
        checked: config.showOriginalInput,
        onChange: toggle("showOriginalInput")
      }),
      (0, import_react.createElement)("span", null, t("options.showOriginalInput"))
    ]),
    (0, import_react.createElement)("label", { key: "fresh", className: "dsh-rt-option" }, [
      (0, import_react.createElement)("input", {
        type: "checkbox",
        checked: config.editFromScratch,
        onChange: toggle("editFromScratch")
      }),
      (0, import_react.createElement)("span", null, t("options.editFromScratch"))
    ]),
    optionRow("hideShadowed", "options.hideShadowed", "options.hideShadowedDesc"),
    optionRow("versioning", "options.versioning", "options.versioningDesc"),
    optionRow("git", "options.git", "options.gitDesc"),
    (0, import_react.createElement)("div", { key: "retention", className: "dsh-rt-option dsh-rt-option-number" }, [
      (0, import_react.createElement)("span", { className: "dsh-rt-option-text" }, [
        (0, import_react.createElement)("span", { className: "dsh-rt-option-label" }, t("options.retention")),
        (0, import_react.createElement)("span", { className: "dsh-rt-option-desc" }, t("options.retentionDesc"))
      ]),
      (0, import_react.createElement)("input", {
        type: "number",
        min: 5,
        max: 500,
        step: 5,
        className: "dsh-rt-retention-input",
        value: config.retentionLimit,
        onChange: (event) => {
          const value = Math.max(1, Math.min(1e3, Number(event.target.value) || 50));
          setConfig({ retentionLimit: value });
        }
      })
    ])
  ]);
}
var STYLE_ID = "dsh-retrace-css";
var CSS = `
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
.dsh-rt-reference summary:before{content:"\u25B8";transition:transform .12s;font-size:10px}
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
.dsh-rt-timeline-git{display:flex;align-items:center;gap:6px;flex:none;border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;padding:4px 8px}
.dsh-rt-timeline-git-text{color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px}
.dsh-rt-timeline-list{overflow-y:auto;flex:1;min-height:0;position:relative;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2)}
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
.dsh-rt-fork-list{overflow-y:auto;flex:1;min-height:0;position:relative}
.dsh-rt-fork-spine-label{color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px;flex:none}
.dsh-rt-fork-row{position:absolute;left:0;right:0;box-sizing:border-box;display:flex;align-items:flex-start;gap:8px;padding:6px 8px;border-radius:8px}
.dsh-rt-fork-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-rt-fork-icon{flex:none;width:22px;height:22px;display:inline-flex;justify-content:center;align-items:center;font-size:13px;color:var(--dsw-alias-label-secondary)}
.dsh-rt-fork-boundary .dsh-rt-fork-icon{color:var(--dsw-alias-state-warning-primary)}
.dsh-rt-fork-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.dsh-rt-fork-line{display:flex;align-items:baseline;gap:8px;min-width:0}
.dsh-rt-fork-label{font-size:12px;font-weight:500;line-height:18px;color:var(--dsw-alias-label-primary);white-space:nowrap}
.dsh-rt-fork-seq{font-family:var(--dsw-font-mono);font-size:11px;line-height:18px;color:var(--dsw-alias-label-caption);flex:none}
.dsh-rt-fork-shadowed{font-size:11px;line-height:18px;color:var(--dsw-alias-state-warning-primary);flex:none}
.dsh-rt-fork-text{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-rt-fork-boundary{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-elevated)}
.dsh-rt-fork-hist{display:flex;flex-direction:column;gap:4px;border-top:1px solid var(--dsw-alias-border-l2);padding-top:8px;overflow-y:auto;flex:none}
.dsh-rt-fork-hist-row{display:flex;align-items:flex-start;gap:8px;padding:4px 8px;border-radius:8px}
.dsh-rt-fork-hist-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
`;
var JUMP_PAGE_BUDGET = 24;
function switchToViewTab(viewId) {
  const ORDER = { chat: 0, trajectory: 1, retrace: 2, "retrace-fork": 3 };
  const index = ORDER[viewId];
  if (index === void 0) {
    console.warn(`[dsh-retrace] no tab order registered for "${viewId}"`);
    return;
  }
  const buttons = [...document.querySelectorAll('[role="tablist"] [role="tab"]')];
  const button = buttons[index];
  if (!button) {
    console.warn(`[dsh-retrace] tab "${viewId}" (index ${index}) not found in the conversation tab bar`);
    return;
  }
  button.click();
}
function waitForElement(selector, frames) {
  return new Promise((resolve) => {
    let remaining = frames;
    const probe = () => {
      const el = document.querySelector(selector);
      if (el !== null) return resolve(el);
      if (remaining-- <= 0) return resolve(null);
      requestAnimationFrame(probe);
    };
    requestAnimationFrame(probe);
  });
}
function flashKey(key) {
  const id = `dsh-rt-jump-${key.replace(/[^a-z0-9]/gi, "-")}`;
  if (document.querySelector(`style[data-plugin-css="${id}"]`)) return;
  const tag = document.createElement("style");
  tag.dataset.pluginCss = id;
  tag.textContent = `[data-chat-anchor-key=${JSON.stringify(key)}]{animation:dsh-rt-flash 1.6s ease-out 2}@keyframes dsh-rt-flash{0%,100%{background:transparent}30%,70%{background:var(--dsw-alias-state-business-primary)}55%{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 30%,transparent)}}`;
  document.head.appendChild(tag);
  setTimeout(() => tag.remove(), 3400);
}
async function jumpToAnchor(store, anchorSeq) {
  switchToViewTab("chat");
  if (!store || typeof store.loadOlder !== "function" || typeof store.getSnapshot !== "function") return;
  const keyOfSeq = (seq) => {
    const nodes = store.getSnapshot()?.chat?.nodes;
    if (!nodes) return null;
    for (const node of nodes.values()) {
      if (typeof node.anchorSeq === "number" && node.anchorSeq === seq) return node.key;
    }
    return null;
  };
  let key = keyOfSeq(anchorSeq);
  let pages = 0;
  while (key === null && pages < JUMP_PAGE_BUDGET && store.hasMore) {
    const before = store.getSnapshot()?.chat?.nodes?.size ?? 0;
    await store.loadOlder();
    const after = store.getSnapshot()?.chat?.nodes?.size ?? 0;
    pages += 1;
    if (after === before) break;
    key = keyOfSeq(anchorSeq);
  }
  if (key === null) {
    await new Promise((resolve) => setTimeout(resolve, 60));
    key = keyOfSeq(anchorSeq);
  }
  if (key === null) {
    console.warn(`[dsh-retrace] jump target seq ${anchorSeq} not reached within ${JUMP_PAGE_BUDGET} pages`);
    return;
  }
  const el = await waitForElement(`[data-chat-anchor-key=${JSON.stringify(key)}]`, 90);
  if (el === null) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  flashKey(key);
}
var NODE_ICONS = { "user/message": "\u{1F464}", "assistant/message": "\u{1F916}", "tool/result": "\u{1F527}" };
function nodeTypeLabel(type, t) {
  if (type === "user/message") return t("fork.node.user");
  if (type === "assistant/message") return t("fork.node.assistant");
  if (type === "tool/result") return t("fork.node.tool");
  return type;
}
function bindListHeight(listEl) {
  if (!listEl) return () => {
  };
  const measure = () => {
    const top = listEl.getBoundingClientRect().top;
    const height = Math.max(120, window.innerHeight - top - 16);
    if (Math.abs(listEl.clientHeight - height) > 4) {
      listEl.style.flex = "none";
      listEl.style.height = `${height}px`;
    }
  };
  measure();
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
  ro?.observe(document.body);
  window.addEventListener("resize", measure);
  return () => {
    ro?.disconnect();
    window.removeEventListener("resize", measure);
  };
}
function ensureStyle() {
  if (typeof document === "undefined") return () => {
  };
  if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`)) return () => {
  };
  const tag = document.createElement("style");
  tag.dataset.plugin = "dsh-retrace";
  tag.dataset.pluginCss = STYLE_ID;
  tag.textContent = CSS;
  document.head.appendChild(tag);
  return () => {
    tag.remove();
  };
}
var KIND_ICONS = { recall: "\u21A9", edit: "\u270E", regenerate: "\u21BB", restore: "\u27F2", compaction: "\u25A4", replace: "\u21C4" };
function kindLabel(kind, t) {
  return t(`timeline.kind.${kind}`) || kind;
}
function timeLabel(ms) {
  const date = new Date(ms);
  return `${date.getMonth() + 1}-${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
function timelineGet(path) {
  return fetch(`${ROUTE_BASE}${path}`, { headers: retraceConfigHeaders() }).then((res) => {
    if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
    return res.json();
  });
}
function fileCountLabel(counts, t) {
  const total = (counts?.created ?? 0) + (counts?.modified ?? 0) + (counts?.deleted ?? 0);
  if (total === 0) return t("timeline.filesNone");
  return t("timeline.files", {
    created: counts.created ?? 0,
    modified: counts.modified ?? 0,
    deleted: counts.deleted ?? 0
  });
}
function RetraceView({ sessionId, useProjection, t, actions, store }) {
  const [versions, setVersions] = (0, import_react.useState)(null);
  const [loading, setLoading] = (0, import_react.useState)(false);
  const [error, setError] = (0, import_react.useState)(null);
  const [git, setGit] = (0, import_react.useState)(null);
  const [gitBusy, setGitBusy] = (0, import_react.useState)(false);
  const [preview, setPreview] = (0, import_react.useState)(null);
  const [previewScope, setPreviewScope] = (0, import_react.useState)("both");
  const [rollbackBusy, setRollbackBusy] = (0, import_react.useState)(false);
  const [scrollTop, setScrollTop] = (0, import_react.useState)(0);
  const projected = typeof useProjection === "function" ? useProjection("retrace/versions") : void 0;
  (0, import_react.useEffect)(() => {
    if (projected && Array.isArray(projected.versions)) setVersions(projected.versions);
  }, [projected]);
  const refresh = () => {
    setLoading(true);
    setError(null);
    timelineGet(`/versions?sessionId=${encodeURIComponent(sessionId)}`).then((result) => {
      if (!result || result.ok !== true) throw new Error(result?.error?.message ?? "versions failed");
      setVersions(result.value?.versions ?? []);
    }).catch((cause) => setError(cause?.message ?? "timeline error")).finally(() => setLoading(false));
  };
  const refreshGit = () => {
    if (getConfig().git !== true) return;
    timelineGet(`/git/status?sessionId=${encodeURIComponent(sessionId)}`).then((result) => setGit(result?.ok === true ? result.value : null)).catch(() => setGit(null));
  };
  (0, import_react.useEffect)(() => {
    if (projected === void 0) refresh();
    refreshGit();
  }, []);
  const jump = (boundarySeq) => jumpToAnchor(store, boundarySeq);
  const requestPreview = (record) => {
    setPreviewScope("both");
    setPreview({ versionId: record.versionId, kind: record.kind, boundarySeq: record.boundarySeq, data: null, error: null });
    callOp("rollback/preview", { sessionId, versionId: record.versionId, scope: "both" }).then((result) => {
      setPreview((prev) => prev && prev.versionId === record.versionId ? { ...prev, data: result?.ok === true ? result.value : null, error: result?.ok === true ? null : result?.error?.message ?? null } : prev);
    });
  };
  const confirmRollback = () => {
    if (!preview) return;
    setRollbackBusy(true);
    callOp("rollback", { sessionId, versionId: preview.versionId, scope: previewScope }).then((result) => {
      setRollbackBusy(false);
      if (!result || result.ok !== true) {
        setPreview((prev) => prev && { ...prev, error: result?.error?.message ?? "rollback failed" });
        return;
      }
      setPreview(null);
      if (projected === void 0) refresh();
      refreshGit();
    });
  };
  const initGit = () => {
    if (!window.confirm(t("timeline.gitInitConfirm"))) return;
    setGitBusy(true);
    callOp("git/init", { sessionId }).then((result) => {
      setGitBusy(false);
      refreshGit();
    });
  };
  const ROW_H = 64;
  const list = versions ?? [];
  const visible = list.slice(Math.max(0, Math.floor(scrollTop / ROW_H) - 2), Math.min(list.length, Math.ceil(scrollTop / ROW_H) + Math.ceil(640 / ROW_H) + 2));
  (0, import_react.useEffect)(() => {
    if (list.length === 0) return void 0;
    return bindListHeight(document.querySelector(".dsh-rt-view .dsh-rt-timeline-list"));
  }, [list.length]);
  return (0, import_react.createElement)("div", { className: "dsh-rt-view" }, [
    (0, import_react.createElement)("div", { key: "head", className: "dsh-rt-timeline-head" }, [
      (0, import_react.createElement)("span", { key: "title", className: "dsh-rt-timeline-title" }, t("timeline.title")),
      (0, import_react.createElement)("button", {
        key: "refresh",
        type: "button",
        className: "dsh-rt-chip",
        onClick: refresh
      }, t("timeline.refresh"))
    ]),
    git !== null && git !== void 0 && (0, import_react.createElement)("div", { key: "git", className: "dsh-rt-timeline-git" }, [
      git.headHash ? [
        (0, import_react.createElement)("span", { key: "r", className: "dsh-rt-timeline-git-text" }, `${t("timeline.gitRepo")} \xB7 ${t("timeline.gitHead", { hash: git.headHash.slice(0, 8) })}${git.dirty ? ` \xB7 ${t("timeline.gitDirty")}` : ""}`)
      ] : (0, import_react.createElement)("button", {
        key: "init",
        type: "button",
        className: "dsh-rt-chip",
        disabled: gitBusy,
        onClick: initGit,
        title: t("timeline.gitInitDesc")
      }, t("timeline.gitInit"))
    ]),
    error !== null && (0, import_react.createElement)("div", { key: "error", className: "dsh-rt-error" }, error),
    loading && (0, import_react.createElement)("div", { key: "loading", className: "dsh-rt-timeline-empty" }, t("timeline.loading")),
    !loading && list.length === 0 && (0, import_react.createElement)("div", { key: "empty", className: "dsh-rt-timeline-empty" }, t("timeline.empty")),
    list.length > 0 && (0, import_react.createElement)("div", {
      key: "list",
      className: "dsh-rt-timeline-list",
      onScroll: (event) => setScrollTop(event.target.scrollTop)
    }, [
      (0, import_react.createElement)("div", { key: "spacer", style: { height: `${list.length * ROW_H}px`, position: "relative" } }, [
        visible.map((record) => (0, import_react.createElement)(VersionRow, {
          key: record.versionId,
          record,
          t,
          top: list.indexOf(record) * ROW_H,
          onPreview: () => requestPreview(record),
          onTrajectory: () => switchToViewTab("trajectory"),
          onJump: () => jump(record.boundarySeq)
        }))
      ])
    ]),
    preview && (0, import_react.createElement)(PreviewBox, {
      key: "preview",
      preview,
      scope: previewScope,
      setScope: setPreviewScope,
      busy: rollbackBusy,
      t,
      onConfirm: confirmRollback,
      onCancel: () => setPreview(null)
    })
  ]);
}
function VersionRow({ record, top, t, onPreview, onTrajectory, onJump }) {
  return (0, import_react.createElement)("div", { className: "dsh-rt-version", style: { top: `${top}px` } }, [
    (0, import_react.createElement)("span", { key: "kind", className: `dsh-rt-version-kind dsh-rt-version-kind-${record.kind}`, title: kindLabel(record.kind, t) }, KIND_ICONS[record.kind] ?? "\u2022"),
    (0, import_react.createElement)("div", { key: "body", className: "dsh-rt-version-body" }, [
      (0, import_react.createElement)("div", { key: "line1", className: "dsh-rt-version-line" }, [
        (0, import_react.createElement)("span", { key: "kind", className: "dsh-rt-version-kind-label" }, kindLabel(record.kind, t)),
        (0, import_react.createElement)("span", { key: "time", className: "dsh-rt-version-time" }, timeLabel(record.createdAt)),
        (0, import_react.createElement)("span", { key: "msgs", className: "dsh-rt-version-msgs" }, t("timeline.messages", { count: record.messageCount })),
        (0, import_react.createElement)("span", { key: "files", className: "dsh-rt-version-files" }, fileCountLabel(record.fileCounts, t))
      ]),
      record.markerText ? (0, import_react.createElement)("div", { key: "text", className: "dsh-rt-version-text" }, record.markerText.length > 120 ? `${record.markerText.slice(0, 120)}\u2026` : record.markerText) : null
    ]),
    (0, import_react.createElement)("span", { key: "actions", className: "dsh-rt-version-actions" }, [
      (0, import_react.createElement)("button", { key: "jump", type: "button", className: "dsh-rt-chip", onClick: onJump }, t("timeline.jump")),
      (0, import_react.createElement)("button", { key: "trajectory", type: "button", className: "dsh-rt-chip", onClick: onTrajectory, title: t("timeline.trajectory") }, t("timeline.trajectory")),
      (0, import_react.createElement)("button", { key: "preview", type: "button", className: "dsh-rt-chip dsh-rt-chip-danger", onClick: onPreview }, t("timeline.preview"))
    ])
  ]);
}
function PreviewBox({ preview, scope, setScope, busy, t, onConfirm, onCancel }) {
  const data = preview.data;
  const scopes = [
    ["context", "timeline.contextOnly", "timeline.contextOnlyDesc"],
    ["artifacts", "timeline.artifactsOnly", "timeline.artifactsOnlyDesc"],
    ["both", "timeline.both", "timeline.bothDesc"]
  ];
  return (0, import_react.createElement)("div", { className: "dsh-rt-modal" }, [
    (0, import_react.createElement)("div", { key: "title", className: "dsh-rt-modal-title" }, [
      t("timeline.preview"),
      (0, import_react.createElement)("span", { key: "ver", className: "dsh-rt-modal-sub" }, t("timeline.previewDesc", { version: preview.versionId, kind: kindLabel(preview.kind, t) }))
    ]),
    preview.error && (0, import_react.createElement)("div", { key: "err", className: "dsh-rt-error" }, preview.error),
    data === null && !preview.error && (0, import_react.createElement)("div", { key: "wait", className: "dsh-rt-timeline-empty" }, t("timeline.loading")),
    data && (0, import_react.createElement)("div", { key: "body", className: "dsh-rt-modal-body" }, [
      (0, import_react.createElement)(
        "div",
        { key: "ctx", className: "dsh-rt-modal-line" },
        data.context?.messages > 0 ? t("timeline.messagesRemoved", { count: data.context.messages }) : t("timeline.noChanges")
      ),
      (0, import_react.createElement)("div", { key: "art", className: "dsh-rt-modal-line" }, t("timeline.artifactsList", { count: data.artifacts?.rows?.length ?? 0 })),
      (0, import_react.createElement)("ul", { key: "files", className: "dsh-rt-modal-files" }, (data.artifacts?.rows ?? []).slice(0, 12).map((row) => (0, import_react.createElement)("li", { key: row.path }, [
        (0, import_react.createElement)(
          "span",
          { key: "a", className: `dsh-rt-art-${row.action}` },
          row.action === "skip" ? `${t("timeline.artifact.skip")} (${row.reason ?? ""})` : row.action === "delete" ? t("timeline.artifact.delete") : t("timeline.artifact.restore")
        ),
        (0, import_react.createElement)("span", { key: "p", className: "dsh-rt-art-path" }, row.path)
      ]))),
      (0, import_react.createElement)("div", { key: "scope", className: "dsh-rt-modal-scope" }, scopes.map(([value, labelKey, descKey]) => (0, import_react.createElement)("label", { key: value, className: "dsh-rt-option" }, [
        (0, import_react.createElement)("input", { type: "radio", name: "rt-scope", checked: scope === value, onChange: () => setScope(value) }),
        (0, import_react.createElement)("span", { className: "dsh-rt-option-text" }, [
          (0, import_react.createElement)("span", { className: "dsh-rt-option-label" }, t(labelKey)),
          (0, import_react.createElement)("span", { className: "dsh-rt-option-desc" }, t(descKey))
        ])
      ])))
    ]),
    (0, import_react.createElement)("div", { key: "buttons", className: "dsh-rt-modal-buttons" }, [
      (0, import_react.createElement)("button", { key: "cancel", type: "button", className: "dsh-rt-editor-cancel", disabled: busy, onClick: onCancel }, t("timeline.cancel")),
      (0, import_react.createElement)(
        "button",
        { key: "confirm", type: "button", className: "dsh-rt-editor-send dsh-rt-confirm", disabled: busy || preview.error !== null, onClick: onConfirm },
        busy ? t("timeline.busy") : t("timeline.confirm")
      )
    ])
  ]);
}
function ForkView({ sessionId, useProjection, t, actions, store }) {
  const [fork, setFork] = (0, import_react.useState)(null);
  const [loading, setLoading] = (0, import_react.useState)(false);
  const [error, setError] = (0, import_react.useState)(null);
  const [scrollTop, setScrollTop] = (0, import_react.useState)(0);
  const projected = typeof useProjection === "function" ? useProjection("retrace/forkmap") : void 0;
  const versions = typeof useProjection === "function" ? useProjection("retrace/versions") : void 0;
  const markerBySeq = new Map((versions?.versions ?? []).map((v) => [v.boundarySeq, v.markerText]));
  (0, import_react.useEffect)(() => {
    if (projected && Array.isArray(projected.nodes) && Array.isArray(projected.boundaries)) setFork(projected);
  }, [projected]);
  const refresh = () => {
    setLoading(true);
    setError(null);
    timelineGet(`/forkmap?sessionId=${encodeURIComponent(sessionId)}`).then((result) => {
      if (!result || result.ok !== true) throw new Error(result?.error?.message ?? "forkmap failed");
      setFork(result.value?.nodes ? result.value : null);
    }).catch((cause) => setError(cause?.message ?? "forkmap error")).finally(() => setLoading(false));
  };
  (0, import_react.useEffect)(() => {
    if (projected === void 0) refresh();
  }, []);
  const nodes = fork?.nodes ?? [];
  const boundaries = fork?.boundaries ?? [];
  const boundaryBySeq = new Map(boundaries.map((b) => [b.seq, b]));
  const spineSeqSet = new Set(nodes.map((n) => n.seq));
  const offSpine = boundaries.filter((b) => !spineSeqSet.has(b.seq));
  (0, import_react.useEffect)(() => {
    if (nodes.length === 0) return void 0;
    return bindListHeight(document.querySelector(".dsh-rt-view .dsh-rt-fork-list"));
  }, [nodes.length]);
  const ROW_H = 56;
  const visible = nodes.slice(
    Math.max(0, Math.floor(scrollTop / ROW_H) - 2),
    Math.min(nodes.length, Math.ceil(scrollTop / ROW_H) + Math.ceil(640 / ROW_H) + 2)
  );
  return (0, import_react.createElement)("div", { className: "dsh-rt-view" }, [
    (0, import_react.createElement)("div", { key: "head", className: "dsh-rt-timeline-head" }, [
      (0, import_react.createElement)("span", { key: "title", className: "dsh-rt-timeline-title" }, t("fork.title")),
      (0, import_react.createElement)("button", {
        key: "refresh",
        type: "button",
        className: "dsh-rt-chip",
        onClick: refresh
      }, t("fork.refresh"))
    ]),
    error !== null && (0, import_react.createElement)("div", { key: "error", className: "dsh-rt-error" }, error),
    loading && (0, import_react.createElement)("div", { key: "loading", className: "dsh-rt-timeline-empty" }, t("timeline.loading")),
    !loading && nodes.length === 0 && (0, import_react.createElement)("div", { key: "empty", className: "dsh-rt-timeline-empty" }, t("fork.empty")),
    nodes.length > 0 && (0, import_react.createElement)("div", { key: "spine", className: "dsh-rt-fork-spine-label" }, t("fork.spine")),
    nodes.length > 0 && (0, import_react.createElement)("div", {
      key: "list",
      className: "dsh-rt-fork-list",
      onScroll: (event) => setScrollTop(event.target.scrollTop)
    }, [
      (0, import_react.createElement)("div", { key: "spacer", style: { height: `${nodes.length * ROW_H}px`, position: "relative" } }, [
        visible.map((node) => (0, import_react.createElement)(ForkRow, {
          key: node.seq,
          node,
          boundary: boundaryBySeq.get(node.seq),
          markerText: markerBySeq.get(node.seq),
          t,
          top: nodes.indexOf(node) * ROW_H,
          onJump: () => jumpToAnchor(store, node.seq)
        }))
      ])
    ]),
    offSpine.length > 0 && (0, import_react.createElement)("div", { key: "hist", className: "dsh-rt-fork-hist" }, [
      (0, import_react.createElement)("div", { key: "title", className: "dsh-rt-fork-spine-label" }, t("fork.histTitle")),
      offSpine.map((boundary) => (0, import_react.createElement)(ForkHistRow, {
        key: boundary.seq,
        boundary,
        markerText: markerBySeq.get(boundary.seq),
        t,
        onJump: () => jumpToAnchor(store, boundary.seq)
      }))
    ])
  ]);
}
function ForkRow({ node, boundary, markerText, t, top, onJump }) {
  const isBoundary = boundary !== void 0;
  const icon = isBoundary ? KIND_ICONS[boundary.kind] ?? "\u2022" : NODE_ICONS[node.type] ?? "\u2022";
  const label = isBoundary ? kindLabel(boundary.kind, t) : nodeTypeLabel(node.type, t);
  return (0, import_react.createElement)("div", {
    className: `dsh-rt-fork-row${isBoundary ? " dsh-rt-fork-boundary" : ""}`,
    style: { top: `${top}px` }
  }, [
    (0, import_react.createElement)("span", { key: "icon", className: "dsh-rt-fork-icon" }, icon),
    (0, import_react.createElement)("div", { key: "body", className: "dsh-rt-fork-body" }, [
      (0, import_react.createElement)("div", { key: "line", className: "dsh-rt-fork-line" }, [
        (0, import_react.createElement)("span", { key: "label", className: "dsh-rt-fork-label" }, label),
        (0, import_react.createElement)("span", { key: "seq", className: "dsh-rt-fork-seq" }, `#${node.seq}`),
        isBoundary && boundary.replacedSeqs.length > 0 && (0, import_react.createElement)(
          "span",
          { key: "shadowed", className: "dsh-rt-fork-shadowed" },
          t("fork.shadowed", { count: boundary.replacedSeqs.length })
        )
      ]),
      isBoundary && markerText && (0, import_react.createElement)(
        "div",
        { key: "text", className: "dsh-rt-fork-text" },
        markerText.length > 140 ? `${markerText.slice(0, 140)}\u2026` : markerText
      )
    ]),
    (0, import_react.createElement)("button", { key: "jump", type: "button", className: "dsh-rt-chip", onClick: onJump }, t("timeline.jump"))
  ]);
}
function ForkHistRow({ boundary, markerText, t, onJump }) {
  return (0, import_react.createElement)("div", { className: "dsh-rt-fork-hist-row" }, [
    (0, import_react.createElement)("span", { key: "icon", className: "dsh-rt-fork-icon" }, KIND_ICONS[boundary.kind] ?? "\u2022"),
    (0, import_react.createElement)("div", { key: "body", className: "dsh-rt-fork-body" }, [
      (0, import_react.createElement)("div", { key: "line", className: "dsh-rt-fork-line" }, [
        (0, import_react.createElement)("span", { key: "label", className: "dsh-rt-fork-label" }, kindLabel(boundary.kind, t)),
        (0, import_react.createElement)("span", { key: "seq", className: "dsh-rt-fork-seq" }, `#${boundary.seq}`),
        boundary.replacedSeqs.length > 0 && (0, import_react.createElement)(
          "span",
          { key: "shadowed", className: "dsh-rt-fork-shadowed" },
          t("fork.shadowed", { count: boundary.replacedSeqs.length })
        )
      ]),
      markerText && (0, import_react.createElement)(
        "div",
        { key: "text", className: "dsh-rt-fork-text" },
        markerText.length > 140 ? `${markerText.slice(0, 140)}\u2026` : markerText
      )
    ]),
    (0, import_react.createElement)("button", { key: "jump", type: "button", className: "dsh-rt-chip", onClick: onJump }, t("timeline.jump"))
  ]);
}
function apply(ctx) {
  const disposeStyle = ensureStyle();
  ctx.effect(() => () => disposeStyle(), "dsh-retrace: styles");
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-retrace: dictionaries");
  const t = ctx.locale.bind(NS);
  const conversationEvents = ctx.get("conversationEvents");
  if (conversationEvents) {
    conversationEvents.register(userActionsDefinition);
    conversationEvents.register(userReferenceDefinition);
    conversationEvents.register(recallMarkerDefinition);
  }
  ctx.slots.inject("conversation.chat.assistant-actions", () => ctx.slots.register({
    name: "conversation.chat.assistant-actions",
    id: "retrace",
    order: 20,
    locale: NS
  }, AssistantActions));
  ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
    name: "conversation.chat.node",
    key: "user-actions",
    locale: NS
  }, UserActionsRow));
  ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
    name: "conversation.chat.node",
    key: "retrace-reference",
    locale: NS
  }, ReferenceRow));
  ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
    name: "conversation.chat.node",
    key: "recall-marker",
    locale: NS
  }, RecallMarkerRow));
  ctx.slots.inject("conversation.view", () => ctx.slots.register({
    name: "conversation.view",
    id: "retrace",
    order: 20,
    locale: NS,
    label: () => t("view.retrace"),
    inject: (sessionId, actions) => ({
      actions,
      store: ctx.get?.("sessions")?.binding?.(sessionId)?.session
    })
  }, RetraceView));
  ctx.slots.inject("conversation.view", () => ctx.slots.register({
    name: "conversation.view",
    id: "retrace-fork",
    order: 30,
    locale: NS,
    label: () => t("view.fork"),
    inject: (sessionId, actions) => ({
      actions,
      store: ctx.get?.("sessions")?.binding?.(sessionId)?.session
    })
  }, ForkView));
  ctx.slots.inject("settings.general.item", () => ctx.slots.register({
    name: "settings.general.item",
    id: "retrace",
    order: 30,
    locale: NS
  }, OptionsRow));
}
		Object.defineProperty(module.exports, Symbol.toStringTag, { value: "Module" });
		return module.exports;
	}
});
