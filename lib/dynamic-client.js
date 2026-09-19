/**
 * GENERATED FILE — do not edit by hand.
 * Source of truth: lib/client.js + the wire wrapper below (scripts/generate-dynamic.mjs).
 */
return {
  inject: ['slots', 'locale'],
  apply(ctx) {
    const mod = (() => {
      var module = { exports: {} }
      var exports = module.exports
      const require = (name) =>
        name === 'react' ? React : (() => { throw new Error('dsh-retrace: unknown module "' + name + '" in dynamic client') })()
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
        __recallMarkerDefinition: () => __recallMarkerDefinition,
        __setMessageEditorWire: () => __setMessageEditorWire,
        apply: () => apply,
        en: () => en,
        inject: () => inject,
        name: () => name,
        opFailureText: () => opFailureText,
        zh: () => zh
      });
      module.exports = __toCommonJS(client_exports);
      var import_react = require("react");
      
      // lib/marker-carrier.js
      var MARKER_ID_PREFIXES = ["retrace", "message-editor"];
      var AUDIT_EVENT_TYPE = "compaction/prune";
      var AUDIT_DATA_KEYS = ["shadowedRange", "shadowedSeqs", "shadowedTokenCount"];
      var CARRIER_EVENT_TYPE = "user/message";
      function isMarkerId(id, prefixes = MARKER_ID_PREFIXES) {
        return typeof id === "string" && prefixes.some((p) => id.startsWith(`${p}-`));
      }
      var TRACE_KINDS = Object.freeze(["goal-marker", "marker"]);
      var LEGACY_TRACE_TYPES = Object.freeze(["retrace/goal-marker", "retrace/marker"]);
      var TRACE_KEY_ORDER = Object.freeze(["v", "kind", "originalType", "originalSeq", "originalTime"]);
      var TRACE_KIND_KEYS = Object.freeze({
        "goal-marker": Object.freeze(["originalOperation"]),
        marker: Object.freeze(["targetSeq", "messageId", "text"])
      });
      function spanRangeOf(surfaceOp) {
        if (!surfaceOp || typeof surfaceOp !== "object" || Array.isArray(surfaceOp)) return null;
        if (surfaceOp.op !== "replace") return null;
        const keys = Object.keys(surfaceOp);
        if (keys.length !== 3) return null;
        const sorted = [...keys].sort().join(",");
        const v0 = sorted === "end,op,start";
        const v3 = sorted === "endSeq,op,startSeq";
        if (!v0 && !v3) return null;
        const start = v0 ? surfaceOp.start : surfaceOp.startSeq;
        const end = v0 ? surfaceOp.end : surfaceOp.endSeq;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
        return { start, end };
      }
      function isCarrierMarkerEvent(event) {
        if (event?.type !== CARRIER_EVENT_TYPE) return false;
        if (!spanRangeOf(event.surfaceOp)) return false;
        return isMarkerId(event.data?.id);
      }
      function carrierTargetSeq(event) {
        const legacy = event?.data?.editor?.targetSeq;
        if (Number.isSafeInteger(legacy)) return legacy;
        const range = spanRangeOf(event?.surfaceOp);
        return range ? range.start : -1;
      }
      var AUDIT_CONTEXT_KIND = "retrace-audit";
      function isAuditData(data) {
        if (!data || typeof data !== "object" || Array.isArray(data)) return false;
        const keys = Object.keys(data);
        if (keys.length !== AUDIT_DATA_KEYS.length) return false;
        if (!AUDIT_DATA_KEYS.every((key) => Object.hasOwn(data, key))) return false;
        const range = data.shadowedRange;
        if (!range || typeof range !== "object" || Array.isArray(range)) return false;
        if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end)) return false;
        const seqs = data.shadowedSeqs;
        return Array.isArray(seqs) && seqs.length > 0 && seqs.every((seq) => Number.isSafeInteger(seq));
      }
      function isAuditEvent(eventOrData) {
        const data = eventOrData && typeof eventOrData === "object" && "data" in eventOrData ? eventOrData.data : eventOrData;
        return isAuditData(data);
      }
      function shadowedSeqsOfAudit(audit, event) {
        const range = spanRangeOf(event?.surfaceOp);
        if (!range) return [];
        const data = audit && typeof audit === "object" && "data" in audit ? audit.data : audit;
        if (!isAuditData(data)) return [];
        if (data.shadowedRange.start !== range.start || data.shadowedRange.end !== range.end) return [];
        const seqs = data.shadowedSeqs.slice();
        if (seqs[0] !== range.start || seqs[seqs.length - 1] !== range.end) return [];
        return seqs;
      }
      function isAuditPairedWithCarrier(audit, carrier) {
        if (!isAuditEvent(audit) || !isCarrierMarkerEvent(carrier)) return { paired: false, via: null };
        const auditSeq = Number.isSafeInteger(audit.seq) ? audit.seq : null;
        const seqs = Array.isArray(carrier.sourceEventSeqs) ? carrier.sourceEventSeqs.filter((seq) => Number.isSafeInteger(seq)) : [];
        if (auditSeq !== null && seqs.length > 0 && seqs[0] === auditSeq) return { paired: true, via: "ref-first" };
        if (auditSeq !== null && seqs.includes(auditSeq)) return { paired: true, via: "ref-anywhere" };
        const range = spanRangeOf(carrier.surfaceOp);
        if (auditSeq === null || !range || !Number.isSafeInteger(carrier.seq)) return { paired: false, via: null };
        if (carrier.seq !== auditSeq + 1) return { paired: false, via: null };
        const data = audit.data;
        if (!isAuditData(data)) return { paired: false, via: null };
        if (data.shadowedRange.start !== range.start || data.shadowedRange.end !== range.end) return { paired: false, via: null };
        return { paired: true, via: "adjacent-range" };
      }
      function pairedAuditOf(carrier, eventAt) {
        if (typeof eventAt !== "function") return null;
        const seqs = Array.isArray(carrier?.sourceEventSeqs) ? carrier.sourceEventSeqs.filter((seq) => Number.isSafeInteger(seq)) : [];
        const adjacent = Number.isSafeInteger(carrier?.seq) ? carrier.seq - 1 : null;
        const candidates = [.../* @__PURE__ */ new Set([...seqs, ...adjacent === null ? [] : [adjacent]])];
        for (const seq of candidates) {
          const audit = eventAt(seq);
          const verdict = isAuditPairedWithCarrier(audit, carrier);
          if (verdict.paired) return { seq, event: audit, via: verdict.via };
        }
        return null;
      }
      function auditContextDefinition() {
        return {
          kind: AUDIT_CONTEXT_KIND,
          match: (event) => event?.type === AUDIT_EVENT_TYPE && isAuditData(event.data) ? { id: `audit:${Number(event.seq)}`, role: "start" } : null,
          start: (_context, match) => match.event.data,
          update: (context) => context.state
        };
      }
      function carrierShadowedSeqs(event, eventAt) {
        const top = Array.isArray(event?.sourceEventSeqs) ? event.sourceEventSeqs.filter((s) => Number.isSafeInteger(s)) : [];
        const range = spanRangeOf(event?.surfaceOp);
        if (top.length > 0) {
          if (!range) return top;
          const at = top.indexOf(range.start);
          if (at >= 0 && top[top.length - 1] === range.end) return top.slice(at);
        }
        if (typeof eventAt === "function") {
          const paired = pairedAuditOf(event, eventAt);
          if (paired) {
            const byPaired = shadowedSeqsOfAudit(paired.event, event);
            if (byPaired.length > 0) return byPaired;
          }
        }
        const inner = event?.data?.shadowedSeqs;
        return Array.isArray(inner) ? inner.filter((s) => Number.isSafeInteger(s)) : [];
      }
      
      // lib/badge.js
      function uuidOf(id) {
        const text = String(id ?? "");
        const m = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
        if (m) return m[0].replace(/-/g, "").toLowerCase();
        const cleaned = text.replace(/[^0-9a-f]/gi, "").toLowerCase();
        return cleaned.length >= 8 ? cleaned.slice(0, 32) : "";
      }
      function fnv1a64(text) {
        let hash = 0xcbf29ce484222325n;
        const prime = 0x100000001b3n;
        const mask = 0xffffffffffffffffn;
        for (let i = 0; i < text.length; i++) {
          hash ^= BigInt(text.charCodeAt(i));
          hash = hash * prime & mask;
        }
        return hash;
      }
      var BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz";
      function toBase36(value) {
        if (value < 0n) value = -value;
        if (value === 0n) return "0";
        let out = "";
        let v = value;
        while (v > 0n) {
          out = BASE36[Number(v % 36n)] + out;
          v /= 36n;
        }
        return out;
      }
      function sessionBadge(sessionId) {
        const uuid = uuidOf(sessionId);
        if (uuid.length === 0) return "";
        return toBase36(fnv1a64(uuid)).padStart(10, "0").slice(0, 10);
      }
      
      // lib/close-guard-client.js
      var GUARD_POLL_MS = 5e3;
      var GUARD_TTL_MS = 3e4;
      var GUARD_ARM_TTL_MS = 3e4;
      function localeOf(locale) {
        return locale === "en" ? "en" : "zh";
      }
      function parseReason(reason) {
        const raw = typeof reason === "string" ? reason : "";
        let match;
        if (raw === "agent-running") return { code: "agent-running" };
        if (match = raw.match(/^queued-(\d+)$/)) return { code: "queued", count: Number(match[1]) };
        if (match = raw.match(/^jobs-(\d+)$/)) return { code: "jobs", count: Number(match[1]) };
        if (match = raw.match(/^unclosed-turn-(.+)$/)) {
          const turns = match[1].split(",").map((t) => Number(t)).filter((t) => Number.isInteger(t));
          return { code: "unclosed-turn", turns };
        }
        return { code: "other", raw };
      }
      function describeReason(reason, locale = "zh") {
        const lang = localeOf(locale);
        const r = parseReason(reason);
        switch (r.code) {
          case "agent-running":
            return lang === "zh" ? "\u6B63\u5728\u8FD0\u884C" : "agent running";
          case "queued":
            return lang === "zh" ? `\u6392\u961F\u5F85\u529E ${r.count} \u6761` : `${r.count} queued`;
          case "jobs":
            return lang === "zh" ? `\u540E\u53F0\u4EFB\u52A1 ${r.count} \u4E2A` : `${r.count} background job${r.count === 1 ? "" : "s"}`;
          case "unclosed-turn":
            return lang === "zh" ? `\u672A\u95ED\u5408\u8F6E\u6B21 ${r.turns.join("\u3001")}` : `unclosed turn ${r.turns.join(",")}`;
          default:
            return r.raw || (lang === "zh" ? "\u8FD0\u884C\u4E2D" : "running");
        }
      }
      function sessionLine(item, { locale = "zh", label } = {}) {
        const lang = localeOf(locale);
        const id = label || item?.sessionId || "?";
        const reasons = Array.isArray(item?.reasons) ? item.reasons : [];
        const body = reasons.length > 0 ? reasons.map((r) => describeReason(r, lang)).join("; ") : lang === "zh" ? "\u8FD0\u884C\u4E2D(\u539F\u56E0\u672A\u8BC6\u522B)" : "running (reason unknown)";
        return `- ${lang === "zh" ? "\u4F1A\u8BDD" : "session"} ${id}: ${body}`;
      }
      function runningLines(running, { locale = "zh", labelOf } = {}) {
        const items = Array.isArray(running) ? running : [];
        return items.map((item) => sessionLine(item, {
          locale,
          label: typeof labelOf === "function" ? labelOf(item.sessionId) : void 0
        }));
      }
      function classifySnapshot(snapshot) {
        if (!snapshot || !Array.isArray(snapshot.running)) return "unknown";
        return snapshot.running.length > 0 ? "running" : "idle";
      }
      function isStale(snapshot, { ttlMs = GUARD_TTL_MS, now = Date.now() } = {}) {
        return !snapshot || typeof snapshot.at !== "number" || now - snapshot.at > ttlMs;
      }
      function buildRunningCopy(snapshot, { locale = "zh", labelOf, now = Date.now(), ttlMs = GUARD_TTL_MS } = {}) {
        const lang = localeOf(locale);
        const running = Array.isArray(snapshot?.running) ? snapshot.running : [];
        const count = running.length;
        const head = lang === "zh" ? `\u6709 ${count} \u4E2A\u4F1A\u8BDD\u5B58\u5728\u8FD0\u884C\u4E2D\u4EFB\u52A1,\u5173\u95ED\u5C06\u4E2D\u65AD\u8FDB\u5EA6` : `${count} session${count === 1 ? "" : "s"} with running work \u2014 closing will interrupt progress`;
        const lines = runningLines(running, { locale: lang, labelOf });
        const stale = isStale(snapshot, { ttlMs, now });
        const hint = stale ? lang === "zh" ? "(\u72B6\u6001\u540C\u6B65\u4E8E\u8F83\u65E9\u65F6\u523B,\u53EF\u80FD\u5DF2\u53D8\u5316)" : "(state may be stale)" : void 0;
        return { head, lines, hint, stale };
      }
      function quitVetoOf(snapshot) {
        return snapshot?.quitVeto === true;
      }
      var CLIENT_DESKTOP_URL_MARK = "dsh-desktop-";
      var CLIENT_DESKTOP_UA_RE = /electron/i;
      function clientDesktopEvidence(page = pageEnvironment()) {
        const ua = typeof page?.userAgent === "string" ? page.userAgent : "";
        const url = typeof page?.href === "string" ? page.href : "";
        const electronUa = CLIENT_DESKTOP_UA_RE.test(ua);
        const urlMark = url.includes(CLIENT_DESKTOP_URL_MARK);
        return { electronUa, urlMark, desktop: electronUa || urlMark };
      }
      function pageEnvironment() {
        const g = globalThis;
        const ua = g?.navigator?.userAgent;
        const href = g?.location?.href;
        return {
          userAgent: typeof ua === "string" ? ua : "",
          href: typeof href === "string" ? href : ""
        };
      }
      function shouldArmNativeGate(snapshot, page = pageEnvironment()) {
        if (snapshot?.surface === "desktop-renderer") return false;
        if (!quitVetoOf(snapshot)) return false;
        return !clientDesktopEvidence(page).desktop;
      }
      function createGuardStore({ now = Date.now, armTtlMs = GUARD_ARM_TTL_MS } = {}) {
        let snapshot = null;
        let armedAt = 0;
        const store = {
          /** 设置最新 host 快照(runningSessions 形状 { running: [...] })。 */
          set(next) {
            snapshot = next && typeof next === "object" ? { ...next, at: next.at ?? now() } : null;
          },
          get() {
            return snapshot;
          },
          /** 用户确认仍关闭 → 放行标记(二次触发有效)。 */
          arm() {
            armedAt = now();
          },
          /** 放行标记是否仍有效(未过期)。 */
          isArmed() {
            return armedAt > 0 && now() - armedAt <= armTtlMs;
          },
          /** 状态重变(运行中→静止→运行中)或手动重置时清除放行。 */
          disarm() {
            armedAt = 0;
          }
        };
        try {
          const win = globalThis?.window;
          const doc = globalThis?.document;
          if (win && doc) {
            queueMicrotask(() => {
              try {
                installDesktopGate({ win, doc, store });
              } catch {
              }
            });
          }
        } catch {
        }
        return store;
      }
      var GATE_WATCHDOG_MS = 1500;
      var GATE_MODAL_ID = "dsh-rt-guard-modal";
      var GATE_HINT_ID = "dsh-rt-guard-toast";
      var GATE_CONFIG_KEY = "dsh-retrace:config";
      var GATE_ROUTE = "/api/plugins/retrace/runningState";
      var GATE_QUERY = "closeGuardEvent";
      function runningCountOf(snapshot) {
        return Array.isArray(snapshot?.running) ? snapshot.running.length : 0;
      }
      function gateEnabled(storage = globalThis?.localStorage) {
        try {
          const raw = storage?.getItem?.(GATE_CONFIG_KEY);
          if (raw === null || raw === void 0 || raw === "") return true;
          const parsed = JSON.parse(raw);
          return parsed?.closeGuard !== false;
        } catch {
          return true;
        }
      }
      function planBeforeUnload(snapshot, { armed = false, enabled = true, desktop = false, visible = true } = {}) {
        if (!enabled) return { action: "allow", reason: "disabled" };
        if (armed) return { action: "allow", reason: "armed" };
        const kind = classifySnapshot(snapshot);
        if (kind === "unknown") return { action: "allow", reason: "state-unknown" };
        if (kind === "idle") return { action: "allow", reason: "no-running" };
        if (visible === false) return { action: "allow", reason: "hidden" };
        if (!desktop) return { action: "allow", reason: "browser-native-gate" };
        return { action: "gate", reason: "running-desktop" };
      }
      function reportGateEvent(event, extra = {}, fetchImpl = globalThis?.fetch) {
        try {
          if (typeof fetchImpl !== "function") return;
          const params = new URLSearchParams({ [GATE_QUERY]: String(event) });
          for (const [key, value] of Object.entries(extra)) {
            if (value !== void 0 && value !== null && value !== "") params.set(key, String(value));
          }
          const done = fetchImpl(`${GATE_ROUTE}?${params.toString()}`, { method: "GET", cache: "no-store", keepalive: true });
          if (done && typeof done.catch === "function") done.catch(() => {
          });
        } catch {
        }
      }
      function installDesktopGate({
        win,
        doc,
        store,
        page = pageEnvironment,
        enabled = gateEnabled,
        report = reportGateEvent,
        timers = {}
      } = {}) {
        if (!win || !doc || !store || win.__dshRetraceCloseGate) return () => {
        };
        win.__dshRetraceCloseGate = true;
        const setT = timers.setTimeout ?? win.setTimeout?.bind(win) ?? setTimeout;
        const clearT = timers.clearTimeout ?? win.clearTimeout?.bind(win) ?? clearTimeout;
        let modal = null;
        let attempt = 0;
        let secondary = null;
        const labelOf = (sessionId) => {
          try {
            return sessionBadge(sessionId) || String(sessionId);
          } catch {
            return String(sessionId);
          }
        };
        const langOf = () => String(win.navigator?.language ?? "").toLowerCase().startsWith("en") ? "en" : "zh";
        const el = (tag, css, text) => {
          const node = doc.createElement(tag);
          if (css) node.style.cssText = css;
          if (text !== void 0) node.textContent = text;
          return node;
        };
        const removeModal = () => {
          try {
            modal?.remove?.();
          } catch {
          }
          modal = null;
        };
        const modalVisible = () => {
          try {
            if (!modal || modal.isConnected === false) return false;
            const height = modal.offsetHeight;
            if (typeof height === "number") return height > 0;
            const rect = modal.getBoundingClientRect?.();
            return rect === void 0 ? false : rect.width > 0;
          } catch {
            return false;
          }
        };
        const eventExtra = (extra = {}) => ({ surface: "desktop-renderer", ...extra });
        function createTimer() {
          try {
            const g = win;
            const canWorker = typeof g.Worker === "function" && typeof g.Blob === "function" && typeof g.URL?.createObjectURL === "function";
            if (canWorker) {
              const url = g.URL.createObjectURL(new g.Blob(["onmessage=function(e){setTimeout(function(){postMessage(1)},e.data)}"], { type: "text/javascript" }));
              const worker = new g.Worker(url);
              let done = false;
              const stop = () => {
                if (done) return;
                done = true;
                try {
                  worker.terminate();
                } catch {
                }
                try {
                  g.URL.revokeObjectURL(url);
                } catch {
                }
              };
              return {
                kind: "worker",
                arm(ms, cb) {
                  worker.onmessage = () => {
                    if (done) return;
                    stop();
                    cb();
                  };
                  worker.postMessage(ms);
                },
                dispose: stop
              };
            }
          } catch {
          }
          let handle;
          return {
            kind: "timeout",
            arm(ms, cb) {
              handle = setT(cb, ms);
            },
            dispose() {
              try {
                clearT(handle);
              } catch {
              }
            }
          };
        }
        function clearSecondary() {
          const current = secondary;
          secondary = null;
          if (!current) return;
          try {
            current.timer?.dispose?.();
          } catch {
          }
          try {
            doc.removeEventListener?.("visibilitychange", current.onHidden);
          } catch {
          }
          try {
            doc.removeEventListener?.("keydown", current.onKeydown);
          } catch {
          }
        }
        function showHint(text) {
          try {
            const tip = el("div", "position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483002;background:#262626;color:#eee;border:1px solid #555;border-radius:8px;padding:6px 12px;font:12px/18px -apple-system,system-ui,sans-serif;max-width:90vw;", text);
            tip.id = GATE_HINT_ID;
            tip.className = "dsh-rt-guard-toast";
            doc.body.appendChild(tip);
            setT(() => {
              try {
                tip.remove?.();
              } catch {
              }
            }, 8e3);
          } catch {
          }
        }
        function release(reason, id) {
          if (id !== void 0 && id !== attempt) return;
          attempt += 1;
          clearSecondary();
          report(reason, eventExtra({ running: runningCountOf(store.get()) }));
          try {
            store.arm();
          } catch {
          }
          removeModal();
          try {
            win.close?.();
          } catch {
          }
          setT(() => showHint(reason.startsWith("fail-soft") ? "\u786E\u8BA4\u6846\u672A\u80FD\u663E\u793A\uFF1A\u5DF2\u6309\u5B98\u65B9\u884C\u4E3A\u653E\u884C\uFF0C\u8BF7\u518D\u70B9\u4E00\u6B21\u5173\u95ED" : "\u5DF2\u653E\u884C\uFF1A\u82E5\u7A97\u53E3\u672A\u5173\u95ED\uFF0C\u8BF7\u518D\u70B9\u4E00\u6B21\u5173\u95ED"), 300);
        }
        function showModal(copy, lang, id) {
          const overlay = el("div", "position:fixed;inset:0;z-index:2147483001;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:16px;");
          overlay.id = GATE_MODAL_ID;
          overlay.className = "dsh-rt-guard-overlay";
          overlay.setAttribute?.("role", "dialog");
          const box = el("div", "background:#202020;color:#eee;border:1px solid #b8860b;border-radius:12px;max-width:min(520px,92vw);padding:14px 16px;font:13px/20px -apple-system,system-ui,sans-serif;display:flex;flex-direction:column;gap:10px;box-sizing:border-box;");
          box.className = "dsh-rt-guard-modal";
          const title = el("div", "font-weight:700;color:#f0c674;font-size:14px;", copy.head);
          title.className = "dsh-rt-guard-modal-title";
          const body = el("div", "white-space:pre-line;font:12px/19px ui-monospace,SFMono-Regular,monospace;", copy.lines.join("\n"));
          body.className = "dsh-rt-guard-modal-lines";
          box.appendChild(title);
          box.appendChild(body);
          if (copy.hint) {
            const note = el("div", "color:#aaa;font-size:11px;", copy.hint);
            note.className = "dsh-rt-guard-modal-hint";
            box.appendChild(note);
          }
          const waiting = el("div", "color:#aaa;font-size:11px;", lang === "zh" ? "\u7B49\u5F85\u4F60\u7684\u9009\u62E9\uFF08\u4E0D\u81EA\u52A8\u5173\u95ED\uFF1BEsc \u7B49\u540C\u53D6\u6D88\uFF09" : "Waiting for your choice (no auto-close; Esc cancels)");
          waiting.className = "dsh-rt-guard-modal-wait";
          box.appendChild(waiting);
          const actions = el("div", "display:flex;justify-content:flex-end;gap:8px;");
          actions.className = "dsh-rt-guard-modal-actions";
          const cancel = el("button", "border:1px solid #555;background:transparent;color:#eee;border-radius:6px;padding:4px 12px;font-size:12px;line-height:20px;cursor:pointer;", lang === "zh" ? "\u53D6\u6D88" : "Cancel");
          cancel.type = "button";
          cancel.className = "dsh-rt-guard-btn";
          cancel.onclick = () => {
            if (id !== attempt) return;
            attempt += 1;
            clearSecondary();
            report("cancel", eventExtra());
            removeModal();
          };
          const proceed = el("button", "border:1px solid #a33;background:#8b1f1f;color:#fff;font-weight:600;border-radius:6px;padding:4px 12px;font-size:12px;line-height:20px;cursor:pointer;", lang === "zh" ? "\u4ECD\u8981\u5173\u95ED" : "Close anyway");
          proceed.type = "button";
          proceed.className = "dsh-rt-guard-btn dsh-rt-guard-btn-primary";
          proceed.onclick = () => release("release", id);
          actions.appendChild(cancel);
          actions.appendChild(proceed);
          box.appendChild(actions);
          overlay.appendChild(box);
          try {
            doc.body.appendChild(overlay);
            modal = overlay;
          } catch {
            modal = null;
            return false;
          }
          try {
            (cancel.focus ?? proceed.focus)?.call(cancel);
          } catch {
          }
          return modalVisible();
        }
        function armSecondary(id) {
          clearSecondary();
          const onHidden = () => {
            if (doc.visibilityState === "hidden") release("fail-soft-hidden", id);
          };
          const onKeydown = (event) => {
            if (event?.key !== "Escape" || id !== attempt) return;
            attempt += 1;
            clearSecondary();
            report("cancel", eventExtra());
            removeModal();
          };
          const timer = createTimer();
          const state = { id, timer, onHidden, onKeydown };
          secondary = state;
          try {
            doc.addEventListener?.("visibilitychange", onHidden);
          } catch {
          }
          try {
            doc.addEventListener?.("keydown", onKeydown);
          } catch {
          }
          timer.arm(GATE_WATCHDOG_MS, () => {
            if (id !== attempt || secondary !== state) return;
            if (modalVisible()) report("waiting", eventExtra({ running: runningCountOf(store.get()) }));
            else release("fail-soft-ui-gone", id);
          });
        }
        function onBeforeUnload(event) {
          const snapshot = store.get();
          const plan = planBeforeUnload(snapshot, {
            armed: store.isArmed?.() === true,
            enabled: enabled() === true,
            desktop: clientDesktopEvidence(page()).desktop === true,
            visible: doc.visibilityState !== "hidden"
          });
          if (plan.action !== "gate") {
            if (plan.reason === "no-running" || plan.reason === "hidden") report(`allow-${plan.reason}`, eventExtra({ running: runningCountOf(snapshot) }));
            return;
          }
          const id = attempt + 1;
          attempt = id;
          let shown = false;
          try {
            shown = showModal(buildRunningCopy(snapshot, { locale: langOf(), labelOf }), langOf(), id) === true;
          } catch {
            shown = false;
          }
          if (!shown) {
            removeModal();
            release("fail-soft-ui-not-rendered", id);
            return;
          }
          try {
            event?.preventDefault?.();
          } catch {
          }
          try {
            if (event) event.returnValue = "";
          } catch {
          }
          report("intercept", eventExtra({ running: runningCountOf(snapshot) }));
          armSecondary(id);
        }
        win.addEventListener("beforeunload", onBeforeUnload);
        if (clientDesktopEvidence(page()).desktop === true) report("gate-ready", eventExtra({ running: runningCountOf(store.get()) }));
        return () => {
          clearSecondary();
          try {
            win.removeEventListener("beforeunload", onBeforeUnload);
          } catch {
          }
          removeModal();
          try {
            delete win.__dshRetraceCloseGate;
          } catch {
          }
        };
      }
      
      // lib/client.js
      var name = "dsh-retrace";
      var inject = ["slots", "locale"];
      var NS = "retrace";
      var ROUTE_BASE = "/api/plugins/retrace";
      var MARKER_PREFIX = "retrace";
      var MARKER_PREFIXES = [MARKER_PREFIX, "message-editor"];
      var LEGACY_MARKER_PREFIXES = ["message-editor"];
      function isMarkerId2(id) {
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
        "marker.t1Broken": "\u7F16\u8F91\u5DF2\u751F\u6548\uFF1B\u6B64\u6807\u8BB0\u4F1A\u4F7F\u672C\u4F1A\u8BDD\u7684 /compact \u5931\u6548\u3002\u79BB\u7EBF\u6E05\u7406\uFF1A\u5173\u95ED\u4F1A\u8BDD\u540E\u8FD0\u884C dsh-log-contract fix --drop-turnnull\uFF08\u7F16\u8F91\u5916\u89C2\u4F1A\u56DE\u9000\u4E3A\u539F\u59CB\u5185\u5BB9\uFF09\u3002",
        "options.title": "\u6D88\u606F\u7F16\u8F91\u63D2\u4EF6",
        "options.showOriginalInput": "\u7F16\u8F91\u540E\u663E\u793A\u539F\u63D0\u95EE\u5BF9\u7167",
        "options.editFromScratch": "\u7F16\u8F91\u540E\u4ECE\u65B0\u5BF9\u8BDD\u5F00\u59CB\uFF08\u9690\u85CF\u6B64\u524D\u7684\u6D88\u606F\uFF0C\u9ED8\u8BA4\u5173\uFF09",
        "options.hideShadowed": "\u6309\u6807\u8BB0\u9690\u85CF\u88AB\u7F16\u8F91/\u64A4\u56DE\u7684\u6D88\u606F",
        "options.hideShadowedDesc": "\u5F00\uFF08\u9ED8\u8BA4\uFF09\uFF1A\u64A4\u56DE/\u7F16\u8F91/\u91CD\u65B0\u751F\u6210\u6309\u6807\u8BB0\u9690\u85CF\u88AB\u66FF\u6362\u7684\u90A3\u4E00\u8F6E\u6D88\u606F\u3002\u5173\uFF1A\u6240\u6709\u6D88\u606F\u4FDD\u6301\u53EF\u89C1\uFF0C\u6807\u8BB0\u4EC5\u663E\u793A\u63D0\u793A\u4E0E\u5BF9\u7167\uFF08\u67E5\u770B\u5B8C\u6574\u5386\u53F2\u7528\uFF09\u3002\u4E00\u6B21\u64CD\u4F5C\u8981\u9690\u85CF\u8D85\u8FC7 40% \u7684\u5BF9\u8BDD\u65F6\u81EA\u52A8\u964D\u7EA7\u4E3A\u4E0D\u9690\u85CF\u3002",
        "options.versioning": "\u8BFB\u6863\u70B9\u4E0E\u4EA7\u7269\u5FEB\u7167",
        "options.versioningDesc": "\u5F00\uFF1A\u6BCF\u6B21\u64A4\u56DE/\u7F16\u8F91\u81EA\u52A8\u5B58\u4E00\u6863\uFF08\u6D88\u606F\u4E0E\u89E6\u78B0\u6587\u4EF6\uFF09\uFF0C\u63D0\u4F9B\u8BFB\u6863\u70B9\u5217\u8868\u4E0E\u4EA7\u7269\u56DE\u9000\uFF1B\u5173\uFF1A\u4EC5\u56DE\u9000\u4E0A\u4E0B\u6587\uFF0C\u4E0D\u5B58\u6863\u3001\u4E0D\u8FFD\u8E2A\u4EA7\u7269\uFF08\u6700\u7701\u8D44\u6E90\uFF09\u3002",
        "options.summary": "\u7ED9\u65E7\u5185\u5BB9\u751F\u6210 AI \u6458\u8981",
        "options.summaryDesc": "\u5F00\uFF1A\u64A4\u56DE / \u7F16\u8F91\u65F6\u591A\u82B1 1 \u6B21\u5C0F\u6A21\u578B\u8C03\u7528\uFF0C\u4E3A\u88AB\u4E22\u5F03\u7684\u65E7\u5185\u5BB9\u751F\u6210\u6458\u8981\uFF0C\u5E2E\u52A9\u56DE\u5FC6\uFF1B\u4F9D\u8D56\u5BBF\u4E3B\u63D0\u4F9B llm \u670D\u52A1\uFF0C\u7F3A\u5931\u65F6\u81EA\u52A8\u964D\u7EA7\u4E3A\u53EA\u663E\u793A\u539F\u6587\u3002\u5173\uFF08\u9ED8\u8BA4\uFF09\uFF1A\u53EA\u663E\u793A\u9010\u5B57\u539F\u6587\uFF0C\u4E0D\u4EA7\u751F\u4EFB\u4F55\u8C03\u7528\u3002",
        "options.git": "\u542F\u7528 git \u96C6\u6210",
        "options.gitDesc": "\u5F00\uFF1A\u5DE5\u4F5C\u533A\u662F git \u4ED3\u5E93\u65F6\u7528 git \u8BB0\u5F55\u4E0E\u56DE\u9000\uFF08\u4E0D\u81EA\u52A8\u63D0\u4EA4\u3001\u4E0D\u52A8\u4F60\u7684\u5206\u652F\uFF09\uFF0C\u975E\u4ED3\u5E93\u53EF\u5728\u65F6\u95F4\u7EBF\u91CC\u4E00\u952E\u542F\u7528\uFF1B\u5173\uFF1A\u4E00\u5F8B\u7528\u5185\u7F6E\u5FEB\u7167\uFF08\u5B58\u4E8E\u63D2\u4EF6\u6570\u636E\u76EE\u5F55\uFF09\uFF0C\u4E0D\u89E6\u78B0\u5DE5\u4F5C\u533A git \u72B6\u6001\uFF0C\u529F\u80FD\u7B49\u4EF7\u3002",
        "options.retention": "\u8BFB\u6863\u70B9\u4FDD\u7559\u4E0A\u9650",
        "options.retentionDesc": "\u6587\u4EF6\u5FEB\u7167\u53EA\u4FDD\u7559\u6700\u8FD1 N \u4E2A\u8BFB\u6863\u70B9\uFF0C\u8D85\u51FA\u81EA\u52A8\u6E05\u7406\u6700\u65E7\u7684\uFF1B\u8BFB\u6863\u70B9\u8BB0\u5F55\u4E0E\u5BA1\u8BA1\u75D5\u8FF9\u59CB\u7EC8\u4FDD\u7559\u3002",
        "timeline.open": "\u65F6\u95F4\u7EBF",
        "timeline.openAria": "\u6253\u5F00\u4F1A\u8BDD\u65F6\u95F4\u7EBF",
        "timeline.title": "\u8BFB\u6863\u70B9",
        // 概念解释（常驻副标题）：说清"它是什么 + 你能拿它做什么"，不堆术语。
        "timeline.intro": "\u8FD9\u91CC\u662F\u4F60\u4F1A\u8BDD\u7684\u6539\u52A8\u8BB0\u5F55\uFF1A\u6BCF\u6B21\u64A4\u56DE / \u7F16\u8F91 / \u91CD\u65B0\u751F\u6210\u524D\uFF0C\u539F\u6765\u7684\u5185\u5BB9\u90FD\u4F1A\u5B58\u4E00\u6863\uFF08\u5171 {count} \u6B21\uFF09\u3002\u70B9\u4EFB\u4E00\u6761\u53EF\u5C55\u5F00\u770B\u5F53\u65F6\u7684\u539F\u8BDD\u3002",
        "view.retrace": "\u8BFB\u6863\u70B9",
        "timeline.refresh": "\u5237\u65B0",
        "badge.hint": "\u77ED\u7801\u7531\u4F1A\u8BDD\u552F\u4E00 id \u786E\u5B9A\u6027\u5BFC\u51FA\uFF0C\u6C38\u4E0D\u53D8\uFF08\u6807\u9898\u4F1A\u53D8\uFF09\u3002",
        "timeline.close": "\u5173\u95ED",
        "timeline.empty": "\u8FD8\u6CA1\u6709\u8BFB\u6863\u70B9\u3002\u64A4\u56DE / \u7F16\u8F91 / \u91CD\u65B0\u751F\u6210\u4F1A\u81EA\u52A8\u5B58\u4E00\u6863\u3002",
        "timeline.loading": "\u52A0\u8F7D\u4E2D\u2026",
        "timeline.error": "\u65F6\u95F4\u7EBF\u52A0\u8F7D\u5931\u8D25",
        "timeline.kind.recall": "\u64A4\u56DE",
        "timeline.kind.edit": "\u7F16\u8F91\u91CD\u53D1",
        "timeline.kind.regenerate": "\u91CD\u65B0\u751F\u6210",
        "timeline.kind.restore": "\u6062\u590D",
        "timeline.kind.compaction": "\u538B\u7F29",
        "timeline.kind.replace": "\u66FF\u6362",
        "timeline.messages": "\u5F53\u65F6\u5171 {count} \u6761\u6D88\u606F",
        "timeline.files": "\u4EA7\u7269\u53D8\u66F4\uFF1A{created} \u589E / {modified} \u6539 / {deleted} \u5220",
        "timeline.filesNone": "\u65E0\u4EA7\u7269\u53D8\u66F4",
        // 每行的"为什么发生"兜底说明（有 markerText 时优先显示原文摘要）。
        "timeline.why.recall": "\u4E22\u5F03\u6B64\u540E\u7684\u6D88\u606F\uFF0C\u5BF9\u8BDD\u4ECE\u8FD9\u4E00\u70B9\u91CD\u65B0\u7EE7\u7EED\u3002",
        "timeline.why.edit": "\u8FD9\u6761\u6D88\u606F\u88AB\u6539\u5199\u540E\u91CD\u65B0\u53D1\u9001\uFF0C\u539F\u95EE\u6CD5\u4FDD\u7559\u4E3A\u5BF9\u7167\u3002",
        "timeline.why.regenerate": "\u8FD9\u6761\u56DE\u590D\u88AB\u91CD\u65B0\u751F\u6210\uFF0C\u539F\u56DE\u590D\u9000\u51FA\u5BF9\u8BDD\u3002",
        "timeline.why.restore": "\u5BF9\u8BDD\u56DE\u9000\u5230\u8FD9\u4E00\u6863\u7684\u72B6\u6001\u3002",
        "timeline.why.compaction": "\u6B64\u5904\u538B\u7F29\u4E86\u8F83\u65E9\u7684\u4E0A\u4E0B\u6587\u3002",
        "timeline.why.replace": "\u6B64\u5904\u53D1\u751F\u4E00\u6B21\u66FF\u6362\uFF0C\u65E7\u5185\u5BB9\u9000\u51FA\u5BF9\u8BDD\u3002",
        "timeline.preview": "\u56DE\u9000\u9884\u89C8",
        "timeline.restoreTo": "\u56DE\u5230\u8FD9\u4E00\u6863",
        "timeline.previewDesc": "\u5C06\u56DE\u5230\u300C{kind}\u300D\u65F6\u7684\u90A3\u4E00\u6863\uFF08{version}\uFF09\u3002",
        "timeline.contextOnly": "\u4EC5\u5BF9\u8BDD",
        "timeline.contextOnlyDesc": "\u79FB\u9664\u8FD9\u4E00\u6863\u4E4B\u540E\u7684\u6D88\u606F\uFF08\u65E5\u5FD7\u5BA1\u8BA1\u75D5\u8FF9\u4FDD\u7559\uFF09",
        "timeline.artifactsOnly": "\u4EC5\u4EA7\u7269",
        "timeline.artifactsOnlyDesc": "\u628A\u8FD9\u4E00\u6863\u89E6\u78B0\u7684\u6587\u4EF6\u6062\u590D\u5230\u5F53\u65F6\u7684\u5167\u5BB9",
        "timeline.both": "\u4E24\u8005",
        "timeline.bothDesc": "\u5148\u56DE\u9000\u5BF9\u8BDD\uFF0C\u518D\u56DE\u9000\u4EA7\u7269",
        "timeline.messagesRemoved": "\u5C06\u79FB\u9664 {count} \u6761\u6D88\u606F",
        "timeline.noChanges": "\u5F53\u524D\u5DF2\u5728\u8FD9\u4E00\u6863\uFF0C\u65E0\u53D8\u5316",
        "timeline.artifactsList": "\u5C06\u53D8\u66F4\u7684\u6587\u4EF6\uFF08{count}\uFF09",
        // R34：二次确认要列出影响明细（文件数 + 明细）。
        "timeline.artifactsImpact": "\u5C06\u6539\u52A8\u6216\u5220\u9664 {count} \u4E2A\u6587\u4EF6\uFF08\u89C1\u4E0B\u5217\u660E\u7EC6\uFF09",
        "timeline.artifact.restore": "\u6062\u590D",
        "timeline.artifact.delete": "\u5220\u9664",
        "timeline.artifact.skip": "\u8DF3\u8FC7",
        "timeline.confirm": "\u786E\u8BA4\u56DE\u9000",
        "timeline.cancel": "\u53D6\u6D88",
        "timeline.busy": "\u56DE\u9000\u4E2D\u2026",
        "timeline.detail": "\u8BE6\u60C5",
        "timeline.jump": "\u8DF3\u8F6C",
        "timeline.jumpFailed": "\u8BE5\u8BFB\u6863\u70B9\u5728\u8F83\u8FDC\u7684\u8FC7\u53BB\uFF08\u8D85\u51FA\u81EA\u52A8\u52A0\u8F7D\u9884\u7B97\uFF09\uFF0C\u65E0\u6CD5\u76F4\u63A5\u5B9A\u4F4D\u3002\u8BF7\u5411\u4E0A\u6EDA\u52A8\u52A0\u8F7D\u66F4\u65E9\u6D88\u606F\u540E\u91CD\u8BD5\uFF1B\u6216\u7528\u300C\u8BE6\u60C5\u300D\u67E5\u770B\u5B83\u5F53\u65F6\u7684\u4E8B\u4EF6\u539F\u6587\u3002",
        "timeline.doctorWarn": "\u8BE5\u4F1A\u8BDD\u542B {count} \u4E2A\u7F16\u8F91/\u64A4\u56DE\u6807\u8BB0\uFF1B\u6267\u884C\u538B\u7F29\uFF08/compact\uFF09\u524D\u5EFA\u8BAE\u5148\u6E05\u7406\uFF0C\u5426\u5219\u538B\u7F29\u53EF\u80FD\u5931\u8D25\u3002",
        "timeline.gitRepo": "git \u4ED3\u5E93",
        "timeline.gitHead": "HEAD {hash}",
        "timeline.gitDirty": "\u5DE5\u4F5C\u533A\u6709\u672A\u63D0\u4EA4\u6539\u52A8",
        "timeline.gitInit": "\u542F\u7528 git \u8BFB\u6863\u70B9\u7BA1\u7406",
        "timeline.gitInitDesc": "\u5728\u5DE5\u4F5C\u533A\u6267\u884C git init\uFF08\u4EC5\u6DFB\u52A0 .gitignore \u4E0E\u4E00\u4E2A\u57FA\u7EBF\u63D0\u4EA4\uFF09\uFF0C\u8BFB\u6863\u70B9\u56DE\u9000\u5C06\u4F18\u5148\u4F7F\u7528 git\u3002",
        "timeline.gitInitConfirm": "\u786E\u5B9A\u8981\u521D\u59CB\u5316 git \u5417\uFF1F",
        "error.generic": "\u64CD\u4F5C\u5931\u8D25\uFF0C\u8BF7\u91CD\u8BD5",
        "error.busy": "\u8BF7\u5148\u505C\u6B62\u5F53\u524D\u56DE\u590D\u518D\u64CD\u4F5C",
        // 不再原样透传 host 错误(曾为英文 "no longer part of the active
        // conversation"——把「提交中」误报成「已不在活跃对话」)。按 code 本地化:
        "error.targetShadowed": "\u8BE5\u6D88\u606F\u4F4D\u4E8E\u5DF2\u6298\u53E0\u5757(\u5386\u53F2\u53EA\u8BFB):\u5C55\u5F00\u8BE5\u5757\u540E\u7F16\u8F91,\u6216\u8FFD\u52A0\u65B0\u6D88\u606F\u4FEE\u8BA2",
        "error.messagePending": "\u6D88\u606F\u751F\u6210\u4E2D,\u5B8C\u6210\u540E\u53EF\u7F16\u8F91",
        // 新增两个 host 错误码(message-not-found / span-replay-failed)+ 契约违规走通用文案
        "error.messageNotFound": "\u76EE\u6807\u6D88\u606F\u4E0D\u5728\u4F1A\u8BDD\u65E5\u5FD7\u4E2D(\u53EF\u80FD\u5DF2\u5220\u9664\u6216\u6D88\u606F id \u65E0\u6548)",
        "error.spanReplayFailed": "\u906E\u853D\u8303\u56F4\u8BA1\u7B97\u5931\u8D25(\u5185\u90E8\u9519\u8BEF):\u4F1A\u8BDD\u65E5\u5FD7\u91CD\u653E\u5F02\u5E38,\u8BF7\u91CD\u8BD5\u6216\u53CD\u9988\u8BE5\u4F1A\u8BDD",
        // 概念解释（常驻副标题）：说清"它是什么 + 你能拿它做什么"。
        // 行内类型图标的人读图例（上下文行只有类型信息，需图例解释）。
        // 边界摘要（what）：逐字原文与 AI 摘要分开渲染（各自独立元素）。
        "what.summaryTag": "\u6458\u8981",
        "what.more": "\u53E6\u6709 {count} \u6761",
        "what.compacted": "\u5BBF\u4E3B\u538B\u7F29\u4E86\u4E0A\u4E0B\u6587\uFF08\u4E0E\u672C\u6B21\u56DE\u9000\u65E0\u5173\uFF09\uFF0C\u539F\u6587\u5DF2\u4E0D\u5728\u65E5\u5FD7\u91CC",
        "what.currentLabel": "\u5EF6\u7EED",
        "what.oldVoid": "\u5DF2\u4E22\u5F03",
        // 第二行的口径：不再说“丢弃”、也不再露原始 seq。
        "what.oldLabel": "\u539F\u6765\u7684\u5185\u5BB9\uFF1A",
        "what.role.unknown": "\u65E7\u5185\u5BB9",
        // 行里的角色措辞换成用户视角（用户原话：“这一轮的输入”）。
        "what.role2.user": "\u8FD9\u4E00\u8F6E\u7684\u8F93\u5165",
        "what.role2.assistant": "\u52A9\u624B\u7684\u56DE\u590D",
        "what.role2.tool": "\u5DE5\u5177\u8F93\u51FA",
        "what.role2.unknown": "\u539F\u5185\u5BB9",
        // 「现在这条」——读者先看到它，再看到被它换掉的那一份（阅读顺序 ①→②→③）
        "what.nowLabel": "\u73B0\u5728\u8FD9\u6761\uFF1A",
        "what.resentSame": "\u5185\u5BB9\u672A\u6539\uFF0C\u91CD\u65B0\u53D1\u9001\uFF1B\u539F\u6765\u7684\u5185\u5BB9\uFF1A",
        "what.noNewRecall": "\u8FD9\u6761\u6CA1\u6709\u65B0\u7684\u5BF9\u5E94\u5185\u5BB9\uFF08\u64A4\u56DE\u540E\u7531\u540E\u7EED\u8F93\u5165\u7EE7\u7EED\uFF09",
        "what.noNewMissing": "\u8FD9\u6761\u5BF9\u5E94\u7684\u65B0\u5185\u5BB9\u5DF2\u4E0D\u5728\u65E5\u5FD7\u91CC",
        "what.role.user": "\u4F60\u53D1\u9001\u7684\u6D88\u606F",
        "what.role.assistant": "\u52A9\u624B\u751F\u6210\u7684\u56DE\u590D",
        "what.role.tool": "\u5DE5\u5177\u6267\u884C\u7ED3\u679C",
        "what.discarded": "\u8FD9\u6B21\u6539\u52A8\u4E22\u5F03\u4E86 {count} \u6761\u6D88\u606F",
        // 紧凑行（两行）：计数搬到首行，正文默认只留一条内容行。
        "what.countShort": "\u6362\u6389\u4E86 {count} \u6761",
        "row.expand": "\u660E\u7EC6",
        "row.collapse": "\u6536\u8D77",
        // 嵌套大纲 / 安静改动 / 现在的路
        "tree.moreLevels": "\u8FD8\u6709 {count} \u5C42",
        "tree.changes": "\u8FD9\u4E00\u6863\u91CC\u8FD8\u6709 {count} \u6B21\u6539\u52A8",
        "tree.collapse": "\u6536\u8D77",
        // 深层档：点一次开一层（不再是死胡同）。
        "tree.deepen": "\u70B9\u4E00\u6B21\u5F00\u4E00\u5C42",
        // 展开层内悬浮的收起入口（不必滚到底部就能收）
        "timeline.collapseHint": "\u25BE \u6536\u8D77\uFF1A{label}",
        "timeline.collapseHintTitle": "\u6536\u8D77\u8FD9\u4E00\u6863\uFF08\u4E0D\u7528\u6EDA\u5230\u5E95\u90E8\uFF09",
        "quiet.note": "\uFF08\u65E0\u8F93\u51FA\u3001\u65E0\u4EA7\u7269\u53D8\u5316\uFF09",
        // R20：安静改动不占主时间线，收进底部默认折叠的纯文字区块。
        "quiet.blockTitle": "\u7B80\u5355\u6539\u52A8\uFF08{count} \u6B21\uFF09",
        // R24：连续 ≥2 次才合并成一行（可展开）；单条不合并、直接可见。
        "quiet.merged": "\u8FDE\u7EED {count} \u6B21\u6539\u52A8",
        "quiet.expand": "\u25B8 \u5C55\u5F00",
        // R22：安静行动作 = 纯导航（跳到最新对话），不是回退。
        "quiet.jumpLatest": "\u8DF3\u5230\u6700\u65B0\u5BF9\u8BDD",
        // 实机发现(2026-09-15)：宿主自身的 surface 替换不是用户的改动，已过滤；数量如实告知。
        "host.replacements": "\u53E6\u6709 {count} \u6761\u5BBF\u4E3B\u81EA\u8EAB\u7684\u66FF\u6362\uFF08\u975E\u672C\u63D2\u4EF6\u6539\u52A8\uFF09\uFF0C\u672A\u8BA1\u5165\u5217\u8868\u3002",
        "path.title": "\u73B0\u5728\u7684\u8DEF",
        "path.header": "{title}\uFF08{messages} \u6761\u6D88\u606F / {rounds} \u8F6E\uFF09",
        // R31：起点文字 / 摘要（如有）——摘要缺省时如实显示原文。
        "path.start": "\u8D77\u70B9",
        // 页首的顺序提示 + 行尾“能点”的提示。
        "timeline.orderHint": "\u6700\u8FD1\u7684\u6539\u52A8\u5728\u6700\u4E0B\u9762",
        // 行首的轮次（从日志推；取不到就整段省略）。
        "timeline.round": "\u7B2C {n} \u8F6E",
        "timeline.openEntry": "\u67E5\u770B\u8FD9\u4E00\u6863",
        // 白屏事故(2026-09-15)：面板级错误边界的提示与重试。
        "view.errorTitle": "\u8BFB\u6863\u70B9\u6E32\u67D3\u51FA\u9519",
        // 每一个注册面都有自己的标题（提示/重试共用）。
        "panel.error.marker": "\u7F16\u8F91 / \u64A4\u56DE \u6807\u8BB0\u6E32\u67D3\u51FA\u9519",
        "panel.error.actions": "\u6D88\u606F\u64CD\u4F5C\u6309\u94AE\u6E32\u67D3\u51FA\u9519",
        "panel.error.userActions": "\u7528\u6237\u6D88\u606F\u64CD\u4F5C\u6E32\u67D3\u51FA\u9519",
        "panel.error.reference": "\u539F\u95EE\u6CD5\u5BF9\u7167\u884C\u6E32\u67D3\u51FA\u9519",
        "panel.error.options": "\u8BBE\u7F6E\u9879\u6E32\u67D3\u51FA\u9519",
        "view.errorHint": "\u8FD9\u4E2A\u9762\u677F\u6682\u65F6\u65E0\u6CD5\u663E\u793A\uFF08\u5BBF\u4E3B\u5176\u4ED6\u90E8\u5206\u4E0D\u53D7\u5F71\u54CD\uFF09\u3002\u53EF\u4EE5\u70B9\u300C\u91CD\u8BD5\u300D\u91CD\u65B0\u6E32\u67D3\u3002",
        "view.errorRetry": "\u91CD\u8BD5",
        "path.round": "\u7B2C {n} \u8F6E",
        "path.empty": "\uFF08\u5F53\u524D\u6CA1\u6709\u5BF9\u8BDD\u8F6E\u6B21\uFF09",
        "options.closeGuard": "\u9000\u51FA\u786E\u8BA4\uFF08\u5173\u95ED\u5B88\u536B\uFF09",
        "options.closeGuardDesc": "\u5F00\uFF08\u9ED8\u8BA4\uFF09\uFF1A\u9875\u9762\u5173\u95ED\u524D\u786E\u8BA4\u9000\u51FA\u2014\u2014\u6709\u8FD0\u884C\u4E2D\u4EFB\u52A1\u6216\u672A\u5B8C\u6210\u5BF9\u8BDD\u65F6\uFF0C\u5F39**\u672C\u63D2\u4EF6\u81EA\u7ED8**\u7684\u4E2D\u6587\u786E\u8BA4\u6846\uFF08[\u53D6\u6D88] / [\u4ECD\u8981\u5173\u95ED]\uFF09\uFF0C\u70B9[\u4ECD\u8981\u5173\u95ED]\u771F\u7684\u9000\u51FA\uFF08\u786E\u8BA4\u6846\u4E00\u76F4\u7B49\u4F60\u7684\u9009\u62E9\uFF0CEsc \u7B49\u540C\u53D6\u6D88\uFF09\uFF1B\u65E0\u4EFB\u52A1\u76F4\u63A5\u5173\uFF0C\u4E0D\u6253\u6270\u3002\u684C\u9762\u7AEF\uFF08DSH Desktop\uFF09\u4E0D\u6B66\u88C5**\u5BBF\u4E3B\u539F\u751F\u786E\u8BA4\u6846**\u90A3\u6761\u8DEF\uFF08\u684C\u9762\u58F3\u672A\u5904\u7406 will-prevent-unload\uFF0C\u5BBF\u4E3B\u6846\u4F1A\u88AB\u9759\u9ED8\u541E\u6389\uFF09\uFF0C\u6539\u7528**\u9875\u9762\u81EA\u7ED8\u786E\u8BA4\u95E8**\uFF1A\u5148\u753B\u6846\u5E76\u786E\u8BA4\u770B\u5F97\u89C1\uFF0C\u624D\u62E6\u4E0B\u5173\u95ED\uFF1B\u6846\u753B\u4E0D\u51FA\u6765\u3001\u4E0D\u53EF\u89C1\u6216\u9875\u9762\u4E0D\u53EF\u89C1 \u21D2 \u5F53\u573A\u653E\u884C\uFF0C\u770B\u95E8\u72D7\uFF08Web Worker \u8BA1\u65F6\u5668\uFF0C\u4E0D\u53D7\u540E\u53F0\u8282\u6D41\uFF09\u53EA\u4F5C\u6700\u540E\u4E00\u9053\u3002\u6B66\u88C5**\u539F\u751F\u95E8**\u7684\u5224\u636E\u662F\u4E24\u9053\uFF1A\u5BBF\u4E3B\u8BF4\u4F1A\u5F39\u539F\u751F\u6846\uFF08quitVeto\uFF09\uFF0C\u4E14\u672C\u9875\u81EA\u5DF1\u770B\u4E0D\u51FA\u684C\u9762\u75D5\u8FF9\uFF08UA \u65E0 Electron\u3001URL \u65E0 dsh-desktop-\uFF09\u2014\u2014\u4EFB\u4E00\u6761\u4E0D\u6210\u7ACB\u5C31\u4E0D\u6B66\u88C5\uFF08\u4E00\u7968\u5426\u51B3\uFF09\u3002\u9000\u51FA\u5165\u53E3\u968F\u7248\u672C/\u5E73\u53F0\u800C\u53D8\u2014\u2014\u5916\u90E8\u62A5\u544A\u7684 0.9.0 \u4E00\u7C7B\u5165\u53E3\u4F1A\u8D70\u5230\u9875\u9762 beforeunload\uFF0C2.0.9 \u7684\u6258\u76D8/\u2318Q \u8D70 requestQuit\u2192window.destroy\u2192app.exit \u4E0D\u7ECF\u8FC7\u672C\u95E8\u3002\u684C\u9762\u7AEF\u9000\u4E0D\u6389\u65F6\u5148\u5173\u8FD9\u4E00\u9879\uFF08\u7ACB\u5373\u6062\u590D\uFF0C\u4E0D\u7528\u91CD\u542F\uFF09\u3002"
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
        "marker.t1Broken": "Edit applied; this marker will break /compact for this session. Offline clean-up: close the session and run dsh-log-contract fix --drop-turnnull (the edit reverts to the original content).",
        "options.title": "Message editor plugin",
        "options.showOriginalInput": "Show the original input after editing",
        "options.editFromScratch": "Start a fresh conversation after editing (hide earlier messages, default off)",
        "options.hideShadowed": "Hide shadowed messages per marker",
        "options.hideShadowedDesc": "On (default): recall/edit/regenerate hide the replaced round per their markers. Off: every message stays visible; markers only show the notice and reference (use to review full history). A single op that would hide more than 40% of the conversation degrades to notice-only automatically.",
        "options.versioning": "Checkpoints & artifact snapshots",
        "options.versioningDesc": "On: every recall/edit saves a checkpoint (messages and touched files) powering the checkpoint list and artifact rollback. Off: only rewinds context \u2014 no checkpoints, no artifact tracking (lightest).",
        "options.summary": "Summarize old content with AI",
        "options.summaryDesc": "On: each recall/edit makes one small model call to summarize the discarded old content, to help you remember it; requires the host llm service and degrades to verbatim text only when absent. Off (default): verbatim text only, no calls.",
        "options.git": "Git integration",
        "options.gitDesc": "On: uses git to record and roll back when the workspace is a repository (never auto-commits, never touches your branches); non-repo workspaces can enable git from the timeline. Off: built-in snapshots under the plugin data home only \u2014 the plugin never touches the workspace git state; equivalent features.",
        "options.retention": "Checkpoint retention limit",
        "options.retentionDesc": "File snapshots are kept for the most recent N checkpoints; older ones are pruned automatically (checkpoint records and the audit trail are always kept).",
        "timeline.open": "Timeline",
        "timeline.openAria": "Open the session timeline",
        "timeline.title": "Checkpoints",
        "timeline.intro": "Every recall / edit / regenerate saves what it replaced. {count} changes in this session \u2014 click one to expand.",
        "view.retrace": "Checkpoints",
        "timeline.refresh": "Refresh",
        "badge.hint": "A stable shortcode derived from the session id (titles change, badges never do).",
        "timeline.close": "Close",
        "timeline.empty": "No checkpoints yet. A recall / edit / regenerate saves one here.",
        "timeline.loading": "Loading\u2026",
        "timeline.error": "Failed to load the timeline",
        "timeline.kind.recall": "Recall",
        "timeline.kind.edit": "Edit & resend",
        "timeline.kind.regenerate": "Regenerate",
        "timeline.kind.restore": "Restore",
        "timeline.kind.compaction": "Compaction",
        "timeline.kind.replace": "Replace",
        "timeline.messages": "{count} messages at this point",
        "timeline.files": "artifacts: {created} created / {modified} modified / {deleted} deleted",
        "timeline.filesNone": "no artifact changes",
        "timeline.why.recall": "Everything after this point is dropped; the conversation continues from here.",
        "timeline.why.edit": "This message was rewritten and resent; the original wording is kept for comparison.",
        "timeline.why.regenerate": "This reply was regenerated; the previous reply leaves the conversation.",
        "timeline.why.restore": "The conversation returns to its state at this checkpoint.",
        "timeline.why.compaction": "Earlier context was compacted at this point.",
        "timeline.why.replace": "A replacement happened here; the old content leaves the conversation.",
        "timeline.preview": "Rollback preview",
        "timeline.restoreTo": "Back to this checkpoint",
        "timeline.previewDesc": 'Returns to the checkpoint taken at "{kind}" ({version}).',
        "timeline.contextOnly": "Context only",
        "timeline.contextOnlyDesc": "Remove messages after this checkpoint (the log audit trail stays)",
        "timeline.artifactsOnly": "Artifacts only",
        "timeline.artifactsOnlyDesc": "Restore the files this checkpoint touched to their state back then",
        "timeline.both": "Both",
        "timeline.bothDesc": "Roll back the context first, then the artifacts",
        "timeline.messagesRemoved": "{count} messages will be removed",
        "timeline.noChanges": "Already at this checkpoint; nothing to change",
        "timeline.artifactsList": "Files to change ({count})",
        "timeline.artifactsImpact": "Will change or delete {count} files (listed below)",
        "timeline.artifact.restore": "restore",
        "timeline.artifact.delete": "delete",
        "timeline.artifact.skip": "skip",
        "timeline.confirm": "Confirm rollback",
        "timeline.cancel": "Cancel",
        "timeline.busy": "Rolling back\u2026",
        "timeline.detail": "Details",
        "timeline.jump": "Jump",
        "timeline.jumpFailed": "This checkpoint lies too far back (beyond the auto-load budget) to locate directly. Scroll up to load earlier messages, or use Details to read its original event text.",
        "timeline.doctorWarn": "This session has {count} edit/recall markers; clean them before compacting (/compact) or compaction may fail.",
        "timeline.gitRepo": "git repository",
        "timeline.gitHead": "HEAD {hash}",
        "timeline.gitDirty": "working tree has uncommitted changes",
        "timeline.gitInit": "Enable git checkpoints",
        "timeline.gitInitDesc": "Runs git init in the workspace (adds a minimal .gitignore and a baseline commit); rollback will prefer git.",
        "timeline.gitInitConfirm": "Initialize git in this workspace?",
        "error.generic": "Operation failed; please try again",
        "error.busy": "Stop the current reply before recalling or editing",
        // localized by code (see zh). Never show the raw host copy verbatim.
        "error.targetShadowed": "This message is inside a folded (read-only) history block: expand that block to edit it, or append a new message instead",
        "error.messagePending": "Message is still being generated; edit it once it finishes",
        "error.messageNotFound": "That message is not in the session log (deleted, or the id is invalid)",
        "error.spanReplayFailed": "Could not compute the shadow range (internal error): session-log replay failed; retry or report this session",
        "what.summaryTag": "Summary",
        "what.more": "{count} more",
        "what.compacted": "the host compacted this context (not caused by this rewind) \u2014 originals are no longer in the log",
        "what.currentLabel": "Continued",
        "what.oldVoid": "discarded",
        "what.oldLabel": "previously:",
        "what.role.unknown": "Old content",
        "what.role2.user": "this round's input",
        "what.role2.assistant": "the assistant's reply",
        "what.role2.tool": "tool output",
        "what.role2.unknown": "original content",
        "what.nowLabel": "now: ",
        "what.resentSame": "resent unchanged; previously: ",
        "what.noNewRecall": "no new counterpart \u2014 later input follows this recall",
        "what.noNewMissing": "the counterpart for this entry is no longer in the log",
        "what.role.user": "Message you sent",
        "what.role.assistant": "Reply generated by the assistant",
        "what.role.tool": "Tool execution result",
        "what.discarded": "this change discarded {count} messages",
        "what.countShort": "replaced {count} messages",
        "row.expand": "Details",
        "row.collapse": "Collapse",
        "tree.moreLevels": "{count} more levels",
        "tree.changes": "{count} more changes in this entry",
        "tree.collapse": "Collapse",
        "tree.deepen": "Open one more level",
        "timeline.collapseHint": "Collapse: {label}",
        "timeline.collapseHintTitle": "Collapse this entry (no need to scroll to the bottom)",
        "quiet.note": " (no output, no artifact changes)",
        "quiet.blockTitle": "Simple changes ({count})",
        "quiet.merged": "{count} changes in a row",
        "quiet.expand": "\u25B8 Show",
        "quiet.jumpLatest": "Jump to the latest message",
        "host.replacements": "{count} host-side surface replacements (not changes made by this plugin) are excluded from the list.",
        "path.title": "Current path",
        "path.header": "{title} ({messages} messages / {rounds} rounds)",
        "path.start": "Start",
        "timeline.orderHint": "newest changes are at the bottom",
        "timeline.round": "Round {n}",
        "timeline.openEntry": "Open this entry",
        "view.errorTitle": "Checkpoints failed to render",
        "panel.error.marker": "Edit / recall marker failed to render",
        "panel.error.actions": "Message action strip failed to render",
        "panel.error.userActions": "User message actions failed to render",
        "panel.error.reference": "Original-input comparison failed to render",
        "panel.error.options": "Settings row failed to render",
        "view.errorHint": "This panel could not render (the rest of the app is unaffected). Use Retry to render it again.",
        "view.errorRetry": "Retry",
        "path.round": "Round {n}",
        "path.empty": "(no conversation rounds yet)",
        "options.closeGuard": "Exit confirmation (close guard)",
        "options.closeGuardDesc": "On (default): confirm before the page closes \u2014 when sessions have running or unfinished work this plugin shows its own Chinese confirm dialog ([Cancel] / [Close anyway]), and [Close anyway] really exits (the dialog waits for your choice; Esc cancels); with no running work the page closes directly, without interruption. Desktop (DSH Desktop) never arms the host native dialog path (the desktop shell has no will-prevent-unload handler, so that dialog is swallowed silently); it uses the page-drawn confirm gate instead: draw the dialog and verify it is visible first, only then block the close; if it cannot be drawn or shown, or the page is not visible, the close passes immediately, with a watchdog (Web Worker timer, immune to background throttling) as the last resort. Arming the native gate takes both criteria: the host says a native dialog appears (quitVeto) AND this page shows no desktop evidence itself (no Electron in the UA, no dsh-desktop- in the URL) \u2014 if either fails it stays unarmed (a client-side veto). Quit entries differ by version/platform \u2014 the 0.9.0-class entry in the external report does reach page beforeunload, while the 2.0.9 tray/\u2318Q goes requestQuit\u2192window.destroy\u2192app.exit and never reaches this gate. If Desktop cannot quit, turn this off first (recovers immediately, no restart)."
      };
      function opFailureText(code, message, t) {
        if (code === "agent-busy") return t("error.busy");
        if (code === "target-shadowed") return t("error.targetShadowed");
        if (code === "message-pending") return t("error.messagePending");
        if (code === "message-not-found") return t("error.messageNotFound");
        if (code === "span-replay-failed") return t("error.spanReplayFailed");
        if (code === "contract-violation") return t("error.generic");
        return message ?? t("error.generic");
      }
      var SURFACE_TYPES = /* @__PURE__ */ new Set(["user/message", "assistant/message", "tool/result"]);
      function isReplacementSurfaceEvent(event) {
        return SURFACE_TYPES.has(event.type) && event.surfaceOp !== void 0 && event.surfaceOp !== "append";
      }
      var wire = null;
      var badgeBySession = /* @__PURE__ */ new Map();
      var normalizeBadgeKey = (id) => String(id ?? "").replace(/^session-/, "").toLowerCase();
      function rememberBadge(sessionId, badge) {
        if (typeof badge !== "string" || badge === "") return;
        badgeBySession.set(normalizeBadgeKey(sessionId), badge);
      }
      function canonicalBadgeOf(sessionId) {
        const hit = badgeBySession.get(normalizeBadgeKey(sessionId));
        return typeof hit === "string" ? hit : "";
      }
      function rememberBadgeMap(badges) {
        if (!badges || typeof badges !== "object") return 0;
        let added = 0;
        for (const [id, code] of Object.entries(badges)) {
          const before = canonicalBadgeOf(id);
          rememberBadge(id, code);
          if (before === "" && canonicalBadgeOf(id) !== "") added += 1;
        }
        return added;
      }
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
        const { versioning, git, retentionLimit, summary } = getConfig();
        return { "x-retrace-config": JSON.stringify({ versioning, git, retentionLimit, summary }) };
      }
      var CONFIG_VERSION = 3;
      var CONFIG_DEFAULTS = { version: CONFIG_VERSION, showOriginalInput: true, editFromScratch: false, hideShadowed: true, versioning: true, git: true, retentionLimit: 50, prewrite: true, closeGuard: true, summary: false };
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
          if (!isReplacementSurfaceEvent(event)) return null;
          if (event.type === "assistant/message") {
            const id = event.data?.message?.id;
            if (!isMarkerId2(id)) return null;
            return { id: `marker:${id}`, role: "start" };
          }
          if (isCarrierMarkerEvent(event)) {
            return { id: `marker:${String(event.data.id)}`, role: "start" };
          }
          if (event.type === "user/message" && isCompactCheckpoint(event.data?.source)) {
            return { id: `marker:compact:${event.seq}`, role: "start" };
          }
          return null;
        },
        start: (_context, match, reader) => {
          const event = match.event;
          const compact = event.type === "user/message" && isCompactCheckpoint(event.data?.source);
          const id = compact ? "" : String(event.data?.message?.id ?? event.data?.id ?? "");
          const legacy = !compact && isLegacyMarkerId(id);
          const fromProvenance = carrierShadowedSeqs(event);
          const audit = typeof reader?.previous === "function" ? reader.previous(AUDIT_CONTEXT_KIND) : void 0;
          const fromAudit = shadowedSeqsOfAudit(audit?.state, event);
          return {
            seq: event.seq,
            time: event.time,
            op: compact ? "compaction" : markerOpFromId(id),
            legacy,
            compact,
            // Legacy/compact markers never hide: their shadowed range is kept for
            // the action-row suppression check (useShadowed) but empty for legacy
            // so no row is hidden and no action row is suppressed for legacy
            // markers (rename must never make visible content disappear).
            shadowedSeqs: legacy ? [] : fromProvenance.length > 0 ? fromProvenance : fromAudit,
            // 业务溯源改由区间起点派生（editor.targetSeq 已不再落盘）；旧形态仍读 editor。
            // 与 host 侧同一实现：lib/marker-carrier.js 的 carrierTargetSeq（v0/v3 双形状 +
            // 键数/op 校验都在那里，客户端不再另写一份取值）。
            targetSeq: carrierTargetSeq(event),
            // 原文不再随载体存储（读端按需派生）⇒ 新形态此处为空：编辑「原输入」行改由
            // 本次会话内的 editReferences 映射提供，跨会话回看走恢复视图（展开逐字回填）。
            text: event.data?.editor?.text
          };
        },
        update: (context) => context.state,
        buildViewNode: (context) => {
          if (context.state === void 0) return null;
          return chatNodeLike(context, "recall-marker", context.state.seq, context.state);
        }
      };
      var __recallMarkerDefinition = recallMarkerDefinition;
      function isCompactCheckpoint(source) {
        return Boolean(source) && source.kind === "plugin" && source.plugin === "compact";
      }
      function textOf(content) {
        if (!Array.isArray(content)) return "";
        return content.filter((block) => block && block.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n");
      }
      function useMessageSeq(useChat, messageId) {
        return useChat((snapshot) => {
          for (const node of snapshot.nodes.values()) {
            if (node.kind === "assistant-step" && node.data?.finalNode?.messageId === messageId) {
              return node.data.finalNode.seq;
            }
          }
          return void 0;
        });
      }
      var SHADOW_SAFETY_RATIO = 0.4;
      var SHADOW_MIN_ROWS_FOR_RATIO = 20;
      function shadowDegraded(keys, rowCount) {
        return keys !== null && rowCount > SHADOW_MIN_ROWS_FOR_RATIO && keys.length / rowCount > SHADOW_SAFETY_RATIO;
      }
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
          if (typeof node.anchorSeq === "number") {
            const anchored = node.anchorSeq % 1 === 0 ? node.anchorSeq : Math.ceil(node.anchorSeq);
            if (hidden.has(anchored)) keys.push(node.key);
          }
        }
        return keys.length === 0 ? null : keys;
      }
      var EMPTY_HIDE_PLAN = Object.freeze({
        hiddenFor: () => null,
        planFor: () => null,
        unionRatio: 0,
        rowCount: 0,
        firstMarkerKey: null,
        // No live marker ⇒ nothing is hidden, whatever the nodes are.
        isSeqHidden: () => false
      });
      var PLUGIN_PSEUDO_KINDS = /* @__PURE__ */ new Set(["user-actions", "retrace-reference", "recall-marker"]);
      function realRowCount(nodes) {
        let count = 0;
        for (const node of nodes.values()) {
          if (typeof node.anchorSeq === "number" && !PLUGIN_PSEUDO_KINDS.has(node.kind)) count += 1;
        }
        return count;
      }
      var hidePlanCacheSnapshot = null;
      var hidePlanCacheValue = null;
      function hidePlanOf(snapshot) {
        if (hidePlanCacheSnapshot === snapshot) return hidePlanCacheValue;
        const nodes = snapshot.nodes;
        const rowCount = realRowCount(nodes);
        const markers = [];
        for (const node of nodes.values()) {
          if (node.kind === "recall-marker" && !node.data?.compact) markers.push(node);
        }
        if (markers.length === 0) {
          hidePlanCacheSnapshot = snapshot;
          hidePlanCacheValue = EMPTY_HIDE_PLAN;
          return hidePlanCacheValue;
        }
        const plans = /* @__PURE__ */ new Map();
        const union = /* @__PURE__ */ new Set();
        const hiddenRowKeys = /* @__PURE__ */ new Set();
        for (const marker of markers) {
          const keys = hiddenKeysFor(marker.data?.shadowedSeqs, nodes);
          const degraded = shadowDegraded(keys, rowCount);
          plans.set(marker.key, { keys: degraded ? null : keys, degraded });
          if (keys !== null) {
            for (const key of keys) union.add(key);
            if (!degraded) for (const key of keys) hiddenRowKeys.add(key);
          }
        }
        const seqToKey = /* @__PURE__ */ new Map();
        for (const node of nodes.values()) {
          if (node.kind === "recall-marker") continue;
          if (typeof node.anchorSeq === "number" && !seqToKey.has(node.anchorSeq)) seqToKey.set(node.anchorSeq, node.key);
        }
        hidePlanCacheSnapshot = snapshot;
        hidePlanCacheValue = {
          planFor: (key) => plans.get(key) ?? null,
          hiddenFor: (key) => plans.get(key)?.keys ?? null,
          unionRatio: rowCount > 0 ? union.size / rowCount : 0,
          rowCount,
          firstMarkerKey: markers[0].key,
          isSeqHidden: (seq) => {
            if (seq === void 0 || seq === null) return false;
            const key = seqToKey.get(seq);
            return key !== void 0 && hiddenRowKeys.has(key);
          }
        };
        return hidePlanCacheValue;
      }
      function useMarkerHidePlan(useChat) {
        return useChat((snapshot) => hidePlanOf(snapshot));
      }
      function useSeqHidden(useChat, seq) {
        return useChat((snapshot) => hidePlanOf(snapshot).isSeqHidden(seq));
      }
      function useShadowed(useChat, seq) {
        return useChat((snapshot) => {
          if (seq === void 0 || seq === null) return false;
          for (const node of snapshot.nodes.values()) {
            if (node.kind === "recall-marker" && Array.isArray(node.data?.shadowedSeqs) && node.data.shadowedSeqs.includes(seq)) {
              return true;
            }
          }
          return false;
        });
      }
      function useMarkerDismissed(useChat, markerSeq, op) {
        return useChat((snapshot) => {
          if (typeof markerSeq !== "number") return false;
          let after = 0;
          for (const node of snapshot.nodes.values()) {
            if (node.kind === "user-actions" && typeof node.data?.seq === "number" && node.data.seq > markerSeq) {
              after += 1;
            }
          }
          return op === "edit" ? after >= 2 : after >= 1;
        });
      }
      function useEditReference(useChat, mySeq) {
        return useChat((snapshot) => {
          if (typeof mySeq !== "number") return null;
          let latestMarkerSeq = -1;
          let referenceText = null;
          let prevUserSeq = -1;
          for (const node of snapshot.nodes.values()) {
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
      var NO_CHAT_SELECTOR = () => void 0;
      function useChatNodes(useChat) {
        const read = typeof useChat === "function" ? useChat : NO_CHAT_SELECTOR;
        return read((snapshot) => snapshot?.nodes);
      }
      function useChatOrder(useChat) {
        const read = typeof useChat === "function" ? useChat : NO_CHAT_SELECTOR;
        return read((snapshot) => snapshot?.order);
      }
      function clipText(text, max = 60) {
        const flat = String(text ?? "").replace(/\s+/g, " ").trim();
        return flat.length > max ? `${flat.slice(0, max)}\u2026` : flat;
      }
      function nodeTextOf(node) {
        const data = node?.data;
        if (data === null || typeof data !== "object") return "";
        const blocks = node.kind === "user-message" ? data.content : data.blocks;
        if (!Array.isArray(blocks)) return "";
        let out = "";
        for (const block of blocks) {
          if (block && (block.type === "text" || block.kind === "text") && typeof block.text === "string") {
            out += (out ? " " : "") + block.text;
          }
        }
        return out.replace(/\s+/g, " ").trim();
      }
      function latestSeqOf(nodes, order) {
        if (!(nodes instanceof Map)) return null;
        const keys = Array.isArray(order) ? order : [...nodes.keys()];
        for (let i = keys.length - 1; i >= 0; i -= 1) {
          const node = nodes.get(keys[i]);
          if (node && typeof node.anchorSeq === "number") return node.anchorSeq;
        }
        return null;
      }
      function roundsOf(nodes, order) {
        if (!(nodes instanceof Map)) return [];
        const keys = Array.isArray(order) ? order : [...nodes.keys()];
        const rounds = [];
        let open = null;
        for (const key of keys) {
          const node = nodes.get(key);
          if (node === void 0 || node === null) continue;
          if (node.kind === "user-message") {
            if (open !== null) rounds.push(open);
            open = { n: rounds.length + 1, seq: node.anchorSeq, question: clipText(nodeTextOf(node)), answer: "" };
          } else if (node.kind === "assistant-step" && open !== null) {
            open.answer = clipText(nodeTextOf(node));
          }
        }
        if (open !== null) rounds.push(open);
        return rounds;
      }
      function AssistantActions({ messageId, sessionId, useChat, t }) {
        const seq = useMessageSeq(useChat, messageId);
        const hidden = useSeqHidden(useChat, seq);
        const shadowed = useShadowed(useChat, seq);
        const [busy, setBusy] = (0, import_react.useState)(false);
        const [failure, setFailure] = (0, import_react.useState)(null);
        if (hidden || shadowed || seq === void 0) return null;
        const run = (op) => {
          setBusy(true);
          setFailure(null);
          callOp(op, { sessionId, messageId }).then(
            (result) => {
              setBusy(false);
              if (!result || result.ok !== true) {
                const message = result?.error?.message || "Operation failed; please try again";
                const code = result?.error?.code;
                setFailure(opFailureText(code, message, t));
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
      function ReferenceRow({ node, useChat, t }) {
        const { seq, messageId } = node.data;
        const hidden = useSeqHidden(useChat, seq);
        const markerRef = useEditReference(useChat, seq);
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
      function UserActionsRow({ node, sessionId, useChat, inputActions, t }) {
        const { seq, messageId, content } = node.data;
        const hidden = useSeqHidden(useChat, seq);
        const shadowed = useShadowed(useChat, seq);
        const [editing, setEditing] = (0, import_react.useState)(false);
        const [draft, setDraft] = (0, import_react.useState)("");
        const [busy, setBusy] = (0, import_react.useState)(false);
        const [failure, setFailure] = (0, import_react.useState)(null);
        if (hidden || shadowed) return null;
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
            setFailure(opFailureText(code, result?.error?.message ?? null, t));
            return;
          }
          if (result.value?.markerT1Broken === true) {
            setFailure(t("marker.t1Broken"));
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
      function RecallMarkerRow({ node, useChat, t }) {
        const { seq, op, shadowedSeqs, legacy, compact } = node.data;
        const dismissed = useMarkerDismissed(useChat, seq, op);
        const hidePlan = useMarkerHidePlan(useChat);
        if (compact) return null;
        const plan = hidePlan.planFor(node.key);
        const hiddenKeys = legacy || !getConfig().hideShadowed ? null : plan?.keys ?? null;
        const css = hiddenKeys === null ? null : hiddenKeys.map((key) => `[data-chat-anchor-key=${JSON.stringify(key)}]{display:none!important}`).join("");
        const count = Array.isArray(shadowedSeqs) ? shadowedSeqs.length : 0;
        const label = op === "recall" ? count > 1 ? t("marker.recallMany", { count }) : t("marker.recallOne") : op === "regenerate" ? t("marker.regenerate") : t("marker.edit");
        const degradedHint = !legacy && plan?.degraded === true ? (0, import_react.createElement)("div", { key: "degraded", className: "dsh-rt-marker-hint" }, t("marker.degradedHint")) : null;
        const unionHint = !legacy && hidePlan.firstMarkerKey === node.key && hidePlan.rowCount > SHADOW_MIN_ROWS_FOR_RATIO && hidePlan.unionRatio > SHADOW_SAFETY_RATIO ? (0, import_react.createElement)(
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
          optionRow("summary", "options.summary", "options.summaryDesc"),
          optionRow("git", "options.git", "options.gitDesc"),
          optionRow("closeGuard", "options.closeGuard", "options.closeGuardDesc"),
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
      .dsh-rt-view-intro{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;flex:none;padding:2px 0 4px}
      /* \u9875\u9996\uFF1A\u8FD9\u662F\u4EC0\u4E48\uFF08\u5E26\u6B21\u6570\uFF09+ \u987A\u5E8F\u63D0\u793A */
      .dsh-rt-intro-order{color:var(--dsw-alias-label-tertiary);margin-left:6px}
      /* \u7B2C\u4E8C\u884C\u7684\u53E3\u5F84\u524D\u7F00 */
      .dsh-rt-what-label{flex:none;color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px}
      /* \u884C\u5C3E\u300C\u203A\u300D\uFF1A\u8FD9\u4E00\u6863\u53EF\u4EE5\u70B9\u5F00 */
      /* \u9010\u7EA7\u5F15\u5BFC\u7EBF\uFF1A\u6587\u672C\u91CC\u4ECD\u662F\u300C\u2502 \u300D\uFF08\u590D\u5236\u6210\u7EAF\u6587\u672C\u4E5F\u8BFB\u5F97\u51FA\u6765\uFF09\uFF0C\u753B\u9762\u4E0A\u662F\u4E00\u6761\u8BE5\u7EA7\u914D\u8272\u7684
         \u7EC6\u8272\u6761\u2014\u2014\u7F29\u8FDB\u4E0D\u9760\u91CF\u50CF\u7D20\uFF0C\u8272\u6761\u672C\u8EAB\u5C31\u8BF4\u6E05"\u8C01\u5728\u8C01\u4E0B\u9762"\u3002 */
      .dsh-rt-indent-guide{flex:none;display:inline-block;width:3px;height:16px;margin:0 7px 0 0;border-radius:2px;overflow:hidden;color:transparent;font-size:1px;line-height:1px;white-space:pre;align-self:center}
      .dsh-rt-indent-guide-1{background:var(--dsw-alias-label-secondary)}
      .dsh-rt-indent-guide-2{background:var(--dsw-alias-state-warning-primary)}
      .dsh-rt-indent-guide-3{background:var(--dsw-alias-state-info-primary)}
      /* \u5C55\u5F00\u5C42\u5185\u60AC\u6D6E\u6536\u8D77\u6761\uFF1Asticky + \u9AD8\u5EA6 0 \u21D2 \u89C6\u89C9\u4E0A\u9489\u5728\u5217\u8868\u89C6\u53E3\u9876\u90E8\uFF0C\u4F46\u4E0D\u5360\u5185\u5BB9\u9AD8\u5EA6
         \uFF08\u865A\u62DF\u5316\u7684\u524D\u7F00\u548C\u53EA\u7531\u884C\u6A21\u578B\u51B3\u5B9A\uFF1B\u4EFB\u4F55\u8FDB\u6D41\u5143\u7D20\u90FD\u4F1A\u8BA9 offsets \u4E0E\u6E32\u67D3\u9519\u4F4D\uFF09\u3002 */
      .dsh-rt-collapse-hint{position:sticky;top:6px;height:0;display:flex;justify-content:center;align-items:flex-start;z-index:3;pointer-events:none}
      .dsh-rt-collapse-hint-btn{pointer-events:auto;box-shadow:0 2px 8px var(--dsw-alias-bg-mask,rgba(0,0,0,.18));background:var(--dsw-alias-bg-elevated,var(--dsw-alias-bg-base));border:1px solid var(--dsw-alias-border-l2)}
      .dsh-rt-what-none{color:var(--dsw-alias-label-secondary);font-style:normal}
      .dsh-rt-what-jump{background:none;border:0;padding:0;margin:0;font:inherit;color:var(--dsw-alias-state-info-primary);cursor:pointer;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
      .dsh-rt-what-jump:hover{text-decoration:underline}
      .dsh-rt-line-sep{flex:none;color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px}
      .dsh-rt-version-round{flex:none;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}
      .dsh-rt-row-open{flex:none;background:transparent;border:none;padding:0 2px;margin-top:1px;cursor:pointer;color:var(--dsw-alias-label-tertiary);font-size:14px;line-height:16px}
      .dsh-rt-row-open:hover{color:var(--dsw-alias-label-primary)}
      /* \u9762\u677F\u7EA7\u9519\u8BEF\u8FB9\u754C\uFF1A\u574F\u7684\u662F\u8FD9\u4E00\u5757\uFF08\u4E0D\u662F\u6574\u9875\uFF09 */
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
      /* \u7D27\u51D1\u884C\u9996\u884C\u7684\u8BA1\u6570\uFF08\u539F\u6B63\u6587\u91CC\u7684 impact \u884C\u5DF2\u5E76\u5165\u8FD9\u91CC\uFF0C\u540C\u4E00\u4FE1\u606F\u4E0D\u5360\u4E24\u884C\uFF09 */
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
      /* ---- outline nesting: level colours (host alias tokens \u2192 both themes) ---- */
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
      /* ---- R31: the always-visible start line of \u300C\u73B0\u5728\u7684\u8DEF\u300D ---- */
      .dsh-rt-path-start{display:flex;align-items:baseline;gap:6px;min-width:0}
      .dsh-rt-path-start-tag{flex:none;color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px;font-weight:600}
      .dsh-rt-path-start-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}
      .dsh-rt-path-start-counts{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
      .dsh-rt-path-start-summary{display:flex;align-items:baseline;gap:6px;min-width:0;font-size:11px;line-height:16px;font-style:italic;color:var(--dsw-alias-label-secondary)}
      .dsh-rt-path-start-summary-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      /* ---- \u300C\u73B0\u5728\u7684\u8DEF\u300Dfixed bottom block ---- */
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
      /* \u5173\u95ED\u5B88\u536B:\u8FD0\u884C\u4E2D\u6A2A\u5E45 / A \u660E\u7EC6\u6A21\u6001 / \u653E\u884C\u63D0\u793A(\u72EC\u7ACB\u4E8E\u4F1A\u8BDD\u89C6\u56FE) */
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
      `;
      var JUMP_PAGE_BUDGET = 24;
      function switchToViewTab(viewId) {
        const ORDER = { chat: 0, trajectory: 1, retrace: 2 };
        const index = ORDER[viewId];
        if (index === void 0) {
          console.warn(`[dsh-retrace] no tab order registered for "${viewId}"`);
          return;
        }
        const buttons = [...document.querySelectorAll('[role="tablist"]')].filter((tablist) => tablist.getBoundingClientRect().width > 0).flatMap((tablist) => [...tablist.querySelectorAll('[role="tab"]')]);
        const button = buttons[index];
        if (!button) {
          console.warn(`[dsh-retrace] tab "${viewId}" (index ${index}) not found in the conversation tab bar`);
          return;
        }
        button.click();
      }
      function nodeCountOf(nodes) {
        if (!nodes) return 0;
        if (typeof nodes.size === "number") return nodes.size;
        return [...nodes.values()].length;
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
      function keyOfSeqIn(nodes, seq) {
        if (!nodes || typeof nodes.values !== "function") return null;
        for (const node of nodes.values()) {
          if (node && typeof node.anchorSeq === "number" && node.anchorSeq === seq) return node.key;
        }
        return null;
      }
      async function resolveAnchorKey({ anchorSeq, store, readNodes, budget = 24, settle }) {
        if (typeof anchorSeq !== "number") return { key: null, reason: "bad-seq", pages: 0 };
        if (typeof readNodes !== "function") return { key: null, reason: "no-node-source", pages: 0 };
        const nodesOf = () => {
          try {
            return readNodes() ?? null;
          } catch {
            return null;
          }
        };
        let key = keyOfSeqIn(nodesOf(), anchorSeq);
        if (key !== null) return { key, reason: "already-loaded", pages: 0 };
        const canThrough = typeof store?.loadThrough === "function";
        const canOlder = typeof store?.loadOlder === "function";
        if (!canThrough && !canOlder) return { key: null, reason: "no-load-api", pages: 0 };
        let pages = 0;
        if (canThrough) {
          try {
            await store.loadThrough(anchorSeq);
          } catch {
            return { key: null, reason: "load-failed", pages };
          }
          pages += 1;
          if (typeof settle === "function") await settle();
          key = keyOfSeqIn(nodesOf(), anchorSeq);
          if (key !== null) return { key, reason: "load-through", pages };
        }
        while (key === null && canOlder && pages < budget && store.hasMore !== false) {
          const before = nodeCountOf(nodesOf());
          try {
            await store.loadOlder();
          } catch {
            return { key: null, reason: "load-failed", pages };
          }
          pages += 1;
          if (typeof settle === "function") await settle();
          if (nodeCountOf(nodesOf()) === before) break;
          key = keyOfSeqIn(nodesOf(), anchorSeq);
        }
        return key === null ? { key: null, reason: "seq-not-in-window", pages } : { key, reason: "paged", pages };
      }
      function reportJumpUnavailable(reason, detail = {}) {
        const context = `reason=${reason} seq=${String(detail.anchorSeq)} pages=${Number(detail.pages) || 0} nodeSource=${detail.hasNodeSource === false ? "missing" : "present"}` + (detail.key ? ` key=${detail.key}` : "");
        console.warn(`[dsh-retrace] jump to anchor unavailable (${context})`);
        try {
          const sent = callOp("clientReport", { id: name, source: `jump-unavailable:${reason}` });
          if (sent && typeof sent.catch === "function") sent.catch(() => {
          });
        } catch {
        }
      }
      function reportBadgeFailure(op, detail) {
        const message = detail instanceof Error ? detail.message : String(detail ?? "unknown");
        console.warn(`[dsh-retrace] ${op} failed: ${message}`);
        try {
          const sent = callOp("clientReport", { id: name, source: `${op}-failed: ${message}`.slice(0, 200) });
          if (sent && typeof sent.catch === "function") sent.catch(() => {
          });
        } catch {
        }
      }
      var badgeInfoSent = /* @__PURE__ */ new Set();
      function reportBadgeInfo(op, detail) {
        const key = `${op}:${detail}`;
        if (badgeInfoSent.has(key)) return;
        badgeInfoSent.add(key);
        console.warn(`[dsh-retrace] ${op}: ${detail}`);
        try {
          const sent = callOp("clientReport", { id: name, source: `${op}: ${String(detail).slice(0, 180)}` });
          if (sent && typeof sent.catch === "function") sent.catch(() => {
          });
        } catch {
        }
      }
      function safeSchedule(fn, delayMs) {
        try {
          const schedule = typeof window === "undefined" ? void 0 : window.setTimeout;
          if (typeof schedule === "function") {
            const handle = schedule(fn, delayMs);
            return () => {
              try {
                window.clearTimeout(handle);
              } catch {
              }
            };
          }
          if (typeof queueMicrotask === "function") {
            queueMicrotask(fn);
            return () => {
            };
          }
        } catch {
        }
        return () => {
        };
      }
      function bootstrapBadgeTitles({ attempts = 5, delayMs = 3e3 } = {}) {
        if (globalThis.__DSH_RETRACE_BADGE_BOOTSTRAP !== true) return () => {
        };
        let mapPending;
        try {
          mapPending = callOp("badgeMap", {});
        } catch (cause) {
          mapPending = Promise.reject(cause);
        }
        Promise.resolve(mapPending).then((result) => {
          if (result && result.ok === true) reportBadgeInfo("badgeMap", `loaded ${rememberBadgeMap(result.value?.badges)}`);
          else reportBadgeFailure("badgeMap", result?.error?.message ?? "host returned ok:false");
        }).catch((cause) => reportBadgeFailure("badgeMap", cause));
        let cancelTimer = () => {
        };
        let cancelled = false;
        let left = attempts;
        const attempt = () => {
          if (cancelled) return;
          let pending;
          try {
            pending = callOp("initBadgeTitles", {});
          } catch (cause) {
            pending = Promise.reject(cause);
          }
          Promise.resolve(pending).then((result) => {
            if (result && result.ok === true) return;
            throw new Error(result?.error?.message ?? "host returned ok:false");
          }).catch((cause) => {
            if (cancelled) return;
            left -= 1;
            const suffix = left > 0 ? `(retry, ${left} left)` : "(retries exhausted)";
            reportBadgeFailure("initBadgeTitles", `${cause?.message ?? cause} ${suffix}`);
            if (left > 0) cancelTimer = safeSchedule(attempt, delayMs);
          });
        };
        cancelTimer = safeSchedule(attempt, 0);
        return () => {
          cancelled = true;
          if (cancelTimer) cancelTimer();
        };
      }
      async function jumpToAnchor(store, anchorSeq, readNodes) {
        const { key, reason, pages } = await resolveAnchorKey({
          anchorSeq,
          store,
          readNodes,
          budget: JUMP_PAGE_BUDGET,
          // Let the node source re-render (React commit) before reading it again.
          settle: () => new Promise((resolve) => {
            setTimeout(resolve, 60);
          })
        });
        if (key === null) {
          reportJumpUnavailable(reason, {
            anchorSeq,
            pages,
            hasNodeSource: typeof readNodes === "function"
          });
          return;
        }
        switchToViewTab("chat");
        const el = await waitForElement(`[data-chat-anchor-key=${JSON.stringify(key)}]`, 90);
        if (el === null) {
          reportJumpUnavailable("row-not-rendered", { anchorSeq, pages, key });
          return;
        }
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        flashKey(key);
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
      var BOUNDARY_KINDS = /* @__PURE__ */ new Set(["recall", "edit", "regenerate", "restore", "compaction", "replace"]);
      function kindLabel(kind, t) {
        return t(`timeline.kind.${kind}`) || kind;
      }
      function whyLabel(kind, t) {
        return t(`timeline.why.${BOUNDARY_KINDS.has(kind) ? kind : "replace"}`);
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
      function hasArtifacts(artifacts) {
        return artifacts !== void 0 && artifacts !== null && typeof artifacts === "object";
      }
      function artifactsLabel(artifacts, t) {
        if (!hasArtifacts(artifacts)) return null;
        return t("timeline.files", {
          created: artifacts.created ?? 0,
          modified: artifacts.modified ?? 0,
          deleted: artifacts.deleted ?? 0
        });
      }
      function roundOf(value) {
        return Number.isSafeInteger(value) && value > 0 ? value : null;
      }
      var ROLE2_LABEL_KEYS = { user: "what.role2.user", assistant: "what.role2.assistant", tool: "what.role2.tool" };
      function roleLabel2(role, t) {
        return t(ROLE2_LABEL_KEYS[role] ?? "what.role2.unknown");
      }
      function fetchBoundaryDigests(sessionId) {
        return timelineGet(`/summaries?sessionId=${encodeURIComponent(sessionId)}`).then((body) => body && body.ok === true && body.value ? body.value : null).catch(() => null);
      }
      function indexDigests(value) {
        const records = Array.isArray(value?.records) ? value.records : [];
        return new Map(records.map((record) => [record.boundarySeq, record]));
      }
      function indexTree(value) {
        const raw = value?.tree;
        if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
        const map = /* @__PURE__ */ new Map();
        for (const [key, node] of Object.entries(raw)) {
          const seq = Number(key);
          if (!Number.isSafeInteger(seq) || node === null || typeof node !== "object") continue;
          map.set(seq, {
            parent: Number.isSafeInteger(node.parent) ? node.parent : null,
            children: Array.isArray(node.children) ? node.children.filter((child) => Number.isSafeInteger(child)) : [],
            discardedCount: Number.isSafeInteger(node.discardedCount) ? node.discardedCount : null
          });
        }
        return map.size > 0 ? map : null;
      }
      var TREE_MAX_LEVEL = 3;
      function budgetOf(value, fallback = 0) {
        if (value === true) return 1;
        if (value === false) return 0;
        if (Number.isInteger(value)) return value > 0 ? value : 0;
        return fallback;
      }
      var ROW_H = 60;
      var DETAIL_H = 18;
      var SHOWN_CONTENT_LINES = 2;
      var INDENT_PX = 14;
      var INDENT_MAX_LEVEL = 12;
      var LIST_VIEWPORT_H = 640;
      function indentGuide(level) {
        const depth = Number.isFinite(level) && level > 0 ? Math.floor(level) : 0;
        return "\u2502 ".repeat(Math.min(depth, INDENT_MAX_LEVEL));
      }
      function guideSpans(level) {
        const depth = Number.isFinite(level) && level > 0 ? Math.floor(level) : 0;
        const spans = [];
        for (let step = 1; step <= Math.min(depth, INDENT_MAX_LEVEL); step += 1) {
          spans.push((0, import_react.createElement)("span", {
            key: `guide-${step}`,
            className: `dsh-rt-indent-guide dsh-rt-indent-guide-${Math.min(step, TREE_MAX_LEVEL)}`
          }, indentGuide(1)));
        }
        return spans;
      }
      function indentOf(level) {
        const depth = Number.isFinite(level) && level > 0 ? Math.floor(level) : 0;
        return `${Math.min(depth, INDENT_MAX_LEVEL) * INDENT_PX}px`;
      }
      function levelClassOf(level) {
        const depth = Number.isFinite(level) && level >= 1 ? Math.floor(level) : 0;
        return depth === 0 ? "" : ` dsh-rt-level-${Math.min(depth, TREE_MAX_LEVEL)}`;
      }
      function rowHeightOf(row) {
        if (row?.kind === "row") {
          const content = Number.isFinite(row.contentCount) && row.contentCount > 0 ? Math.floor(row.contentCount) : 1;
          const shown = Math.min(SHOWN_CONTENT_LINES, content);
          const detail = row.detailOpen === true && Number.isFinite(row.detailCount) && row.detailCount > 0 ? Math.floor(row.detailCount) : 0;
          return ROW_H + Math.max(0, shown - 1) * DETAIL_H + detail * DETAIL_H;
        }
        return ROW_H;
      }
      function buildDisplayRows({ versions, digests, tree, expanded, detailOpen = null, t = null }) {
        const list = Array.isArray(versions) ? versions : [];
        const tr = typeof t === "function" ? t : (key) => key;
        const digestOf = (seq) => digests instanceof Map ? digests.get(seq) : void 0;
        const isQuiet = (seq) => digestOf(seq)?.quiet === true;
        const nodeOf = (seq) => tree instanceof Map ? tree.get(seq) : void 0;
        const childrenOf = (seq) => nodeOf(seq)?.children ?? [];
        const isNested = (seq) => {
          const node = nodeOf(seq);
          return node !== void 0 && node.parent !== null;
        };
        const depthBelow = (seq, seen = /* @__PURE__ */ new Set()) => {
          if (seen.has(seq)) return 0;
          seen.add(seq);
          const kids = childrenOf(seq);
          return kids.length === 0 ? 0 : 1 + Math.max(...kids.map((kid) => depthBelow(kid, seen)));
        };
        const descendants = (seq, seen = /* @__PURE__ */ new Set()) => {
          if (seen.has(seq)) return 0;
          seen.add(seq);
          return childrenOf(seq).reduce((sum, kid) => sum + 1 + descendants(kid, seen), 0);
        };
        const grantedOf = (seq) => budgetOf(expanded instanceof Map ? expanded.get(seq) : void 0);
        const isExpanded = (seq) => grantedOf(seq) >= 1;
        const canOpen = (seq, level) => level < TREE_MAX_LEVEL + grantedOf(seq);
        const bySeq = new Map(list.map((record) => [record.boundarySeq, record]));
        const rows = [];
        const push = (row) => {
          row.height = rowHeightOf(row);
          rows.push(row);
        };
        const emitNode = (seq, level) => {
          const record = bySeq.get(seq);
          if (record === void 0) return;
          const kids = childrenOf(seq);
          if (isQuiet(seq)) {
            if (kids.length > 0) {
              if (!canOpen(seq, level)) {
                push({
                  kind: "depth",
                  seq,
                  level,
                  granted: grantedOf(seq),
                  remaining: depthBelow(seq),
                  count: descendants(seq),
                  // one click = exactly one more level, even for a node far below the cap
                  next: Math.max(grantedOf(seq) + 1, level - TREE_MAX_LEVEL + 1)
                });
              } else if (isExpanded(seq)) {
                emitCollapseChips(seq, level + 1, kids);
              } else push({ kind: "collapsed", seq, level: level + 1, granted: grantedOf(seq), remaining: depthBelow(seq), count: descendants(seq) });
            }
            return;
          }
          const digest = digestOf(seq);
          const fallback = digest === void 0 || digest === null || digest.what === void 0 || digest.what === null;
          const compactionBoundary = record.kind === "compaction" || digest?.what?.op === "compaction";
          const contentCount = fallback ? 1 : Math.max(1, whatLineList(digest.what, summaryTextOf(digest), {
            suppressContinue: level > 0,
            artifacts: artifactsLabel(digest.what?.artifacts, tr),
            compaction: compactionBoundary,
            now: digest.now ?? record.now ?? null,
            kind: record.kind
          }).lines.length);
          const detailCount = fallback ? 0 : Math.max(0, contentCount - SHOWN_CONTENT_LINES);
          const open = detailCount > 0 && detailOpen instanceof Map && detailOpen.get(seq) === true;
          push({
            kind: fallback ? "fallback" : "row",
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
            detailOpen: open
          });
          if (kids.length === 0) return;
          if (!canOpen(seq, level)) {
            push({
              kind: "depth",
              seq,
              level,
              granted: grantedOf(seq),
              remaining: depthBelow(seq),
              count: descendants(seq),
              next: Math.max(grantedOf(seq) + 1, level - TREE_MAX_LEVEL + 1)
            });
            return;
          }
          if (!isExpanded(seq)) {
            push({ kind: "collapsed", seq, level: level + 1, granted: grantedOf(seq), remaining: depthBelow(seq), count: descendants(seq) });
            return;
          }
          emitCollapseChips(seq, level + 1, kids);
        };
        const emitGroup = (seqs, level) => {
          for (const seq of seqs) emitNode(seq, level);
        };
        const emitCollapseChips = (seq, chipLevel, kids) => {
          const label = hintLabelOf(seq);
          const chip = (position) => push({
            kind: "expanded",
            seq,
            level: chipLevel,
            granted: grantedOf(seq),
            count: descendants(seq),
            position,
            hintLabel: label
          });
          chip("head");
          emitGroup(kids, chipLevel);
          chip("tail");
        };
        const hintLabelOf = (seq) => {
          const turn = roundOf(digestOf(seq)?.turn) ?? roundOf(bySeq.get(seq)?.turn);
          return turn === null ? kindLabel(bySeq.get(seq)?.kind, tr) : tr("timeline.round", { n: turn });
        };
        emitGroup(list.map((record) => record.boundarySeq).filter((seq) => !isNested(seq)), 0);
        return rows;
      }
      function collapseHintOf({ rows, offsets, scrollTop, viewportHeight }) {
        if (!Array.isArray(rows) || !Array.isArray(offsets)) return null;
        if (!Number.isFinite(scrollTop) || !Number.isFinite(viewportHeight)) return null;
        const bottom = scrollTop + Math.max(0, viewportHeight);
        let best = null;
        for (let head = 0; head < rows.length; head += 1) {
          const row = rows[head];
          if (row?.kind !== "expanded" || row.position !== "head") continue;
          let tail = -1;
          for (let i = head + 1; i < rows.length; i += 1) {
            if (rows[i]?.kind === "expanded" && rows[i].seq === row.seq && rows[i].position === "tail") {
              tail = i;
              break;
            }
          }
          if (tail < 0) continue;
          const headBottom = (Number.isFinite(offsets[head]) ? offsets[head] : 0) + (row.height ?? ROW_H);
          const tailTop = Number.isFinite(offsets[tail]) ? offsets[tail] : 0;
          if (headBottom > scrollTop) continue;
          if (tailTop < bottom) continue;
          if (best === null || row.level > best.level) {
            best = { seq: row.seq, level: row.level, label: String(row.hintLabel ?? "") };
          }
        }
        return best;
      }
      function visibleFrom(rows, offsets, scrollTop) {
        let lo = 0;
        let hi = rows.length;
        while (lo < hi) {
          const mid = lo + hi >> 1;
          if (offsets[mid] + (rows[mid].height ?? ROW_H) <= scrollTop) lo = mid + 1;
          else hi = mid;
        }
        return Math.max(0, lo - 2);
      }
      function clampIndex(value, length) {
        if (typeof value !== "number" || Number.isNaN(value)) return 0;
        return Math.min(Math.max(value, 0), length);
      }
      function visibleTo(rows, offsets, bottom) {
        let lo = 0;
        let hi = rows.length;
        while (lo < hi) {
          const mid = lo + hi >> 1;
          if (offsets[mid] < bottom) lo = mid + 1;
          else hi = mid;
        }
        return Math.min(rows.length, lo + 2);
      }
      function anchoredScrollTop({ scrollTop, anchorOffset, delta }) {
        if (!Number.isFinite(delta) || delta === 0) return scrollTop;
        if (!(anchorOffset < scrollTop)) return scrollTop;
        return Math.max(0, scrollTop + delta);
      }
      function quietRunsOf(versions, digests) {
        const list = Array.isArray(versions) ? versions : [];
        const digestOf = (seq) => digests instanceof Map ? digests.get(seq) : void 0;
        const runs = [];
        let run = [];
        for (const record of list) {
          if (digestOf(record.boundarySeq)?.quiet === true) {
            run.push(record);
          } else if (run.length > 0) {
            runs.push(run);
            run = [];
          }
        }
        if (run.length > 0) runs.push(run);
        return runs;
      }
      function pathStartOf(versions, digests) {
        const list = Array.isArray(versions) ? versions : [];
        if (list.length === 0) return null;
        let first = list[0];
        for (const record of list) {
          if (Number.isSafeInteger(record?.boundarySeq) && record.boundarySeq < first.boundarySeq) first = record;
        }
        const digest = digests instanceof Map ? digests.get(first.boundarySeq) : void 0;
        return {
          summary: digest?.called === true && typeof digest.summary === "string" ? digest.summary : null,
          text: typeof digest?.what?.new?.excerpt === "string" ? digest.what.new.excerpt : "",
          count: first.messageCount
        };
      }
      function RetraceView({ sessionId, useChat, useProjection, t, actions, store }) {
        const [versions, setVersions] = (0, import_react.useState)(null);
        const [hostReplacements, setHostReplacements] = (0, import_react.useState)(0);
        const [loading, setLoading] = (0, import_react.useState)(false);
        const [error, setError] = (0, import_react.useState)(null);
        const [git, setGit] = (0, import_react.useState)(null);
        const [gitBusy, setGitBusy] = (0, import_react.useState)(false);
        const [preview, setPreview] = (0, import_react.useState)(null);
        const [previewScope, setPreviewScope] = (0, import_react.useState)("both");
        const [badge, setBadge] = (0, import_react.useState)("");
        const [rollbackBusy, setRollbackBusy] = (0, import_react.useState)(false);
        const [scrollTop, setScrollTop] = (0, import_react.useState)(0);
        const [doctor, setDoctor] = (0, import_react.useState)(null);
        const [digests, setDigests] = (0, import_react.useState)(null);
        const [tree, setTree] = (0, import_react.useState)(null);
        const [expanded, setExpanded] = (0, import_react.useState)(null);
        const [pathOpen, setPathOpen] = (0, import_react.useState)(false);
        const [quietOpen, setQuietOpen] = (0, import_react.useState)(false);
        const [openRuns, setOpenRuns] = (0, import_react.useState)(null);
        const [detailOpen, setDetailOpen] = (0, import_react.useState)(null);
        const projected = typeof useProjection === "function" ? useProjection("retrace/versions") : void 0;
        const chatNodes = useChatNodes(useChat);
        const chatNodesRef = (0, import_react.useRef)(chatNodes);
        chatNodesRef.current = chatNodes;
        const chatOrder = useChatOrder(useChat);
        (0, import_react.useEffect)(() => {
          if (projected && Array.isArray(projected.versions)) setVersions(projected.versions);
          if (Number.isSafeInteger(projected?.hostReplacementCount)) setHostReplacements(projected.hostReplacementCount);
        }, [projected]);
        const refresh = () => {
          setLoading(true);
          setError(null);
          refreshDigests();
          timelineGet(`/versions?sessionId=${encodeURIComponent(sessionId)}`).then((result) => {
            if (!result || result.ok !== true) throw new Error(result?.error?.message ?? "versions failed");
            setVersions(result.value?.versions ?? []);
            if (Number.isSafeInteger(result.value?.hostReplacementCount)) setHostReplacements(result.value.hostReplacementCount);
          }).catch((cause) => setError(cause?.message ?? "timeline error")).finally(() => setLoading(false));
        };
        const refreshDigests = () => {
          fetchBoundaryDigests(sessionId).then((value) => {
            setDigests(indexDigests(value));
            setTree(indexTree(value));
            if (Number.isSafeInteger(value?.hostReplacementCount)) setHostReplacements(value.hostReplacementCount);
          });
        };
        const refreshGit = () => {
          if (getConfig().git !== true) return;
          timelineGet(`/git/status?sessionId=${encodeURIComponent(sessionId)}`).then((result) => setGit(result?.ok === true ? result.value : null)).catch(() => setGit(null));
        };
        (0, import_react.useEffect)(() => {
          if (!projected || !Array.isArray(projected.versions)) refresh();
          refreshGit();
          refreshDigests();
          timelineGet(`/doctor?sessionId=${encodeURIComponent(sessionId)}`).then((result) => setDoctor(result?.ok === true ? result.value : null)).catch(() => setDoctor(null));
          callOp("setBadgeTitle", { sessionId }).then((result) => {
            if (!result || result.ok !== true) {
              reportBadgeFailure("setBadgeTitle", result?.error?.message ?? "host returned ok:false");
              return;
            }
            reportBadgeInfo("setBadgeTitle", `${sessionId} \u2192 ${result.value?.title ?? ""}${result.value?.alreadyTagged === true ? "(alreadyTagged)" : ""}`);
          }).catch((cause) => reportBadgeFailure("setBadgeTitle", cause));
          callOp("sessionBadge", { sessionId }).then((result) => {
            if (result && result.ok === true && typeof result.value?.badge === "string") {
              setBadge(result.value.badge);
              rememberBadge(sessionId, result.value.badge);
            } else {
              reportBadgeFailure("sessionBadge", result?.error?.message ?? "response has no badge");
            }
          }).catch((cause) => reportBadgeFailure("sessionBadge", cause));
        }, []);
        const jump = (boundarySeq) => jumpToAnchor(store, boundarySeq, () => chatNodesRef.current);
        const jumpRow = (row) => jump(jumpTargetOf(row));
        const requestPreview = (record, options = {}) => {
          const contextOnly = options.contextOnly === true;
          const scope = contextOnly ? "context" : "both";
          setPreviewScope(scope);
          setPreview({ versionId: record.versionId, kind: record.kind, boundarySeq: record.boundarySeq, contextOnly, data: null, error: null });
          callOp("rollback/preview", { sessionId, versionId: record.versionId, scope }).then((result) => {
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
            if (!projected || !Array.isArray(projected.versions)) refresh();
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
        const list = (versions ?? []).filter((record) => record?.kind !== "replace");
        const rows = buildDisplayRows({ versions: list, digests, tree, expanded, detailOpen, t });
        const offsets = new Array(rows.length);
        let totalHeight = 0;
        for (let i = 0; i < rows.length; i += 1) {
          offsets[i] = totalHeight;
          totalHeight += rows[i].height ?? ROW_H;
        }
        for (let i = 0; i < offsets.length; i++) {
          if (!Number.isFinite(offsets[i])) offsets[i] = i * ROW_H;
        }
        const visibleStart = clampIndex(visibleFrom(rows, offsets, scrollTop), rows.length);
        const visibleEnd = Math.max(visibleStart, clampIndex(visibleTo(rows, offsets, scrollTop + 640), rows.length));
        const visible = rows.slice(visibleStart, visibleEnd);
        const collapseHint = collapseHintOf({ rows, offsets, scrollTop, viewportHeight: LIST_VIEWPORT_H });
        const rowKey = (row) => row.record?.versionId ?? `${row.kind}:${row.seq}`;
        const listRef = (0, import_react.useRef)(null);
        const anchorRef = (0, import_react.useRef)(null);
        const toggleWithAnchor = (row, apply2) => {
          const index = row === null || row === void 0 ? -1 : rows.findIndex((candidate) => rowKey(candidate) === rowKey(row));
          anchorRef.current = { offset: index >= 0 ? offsets[index] : 0, scrollTop, totalBefore: totalHeight };
          apply2();
        };
        const toggle = (key) => {
          const target = rows.find((row) => row.seq === key || row.record?.boundarySeq === key) ?? null;
          toggleWithAnchor(target, () => setExpanded((prev) => {
            const next = new Map(prev instanceof Map ? prev : []);
            const open = target !== null && budgetOf(target.granted, 0) > 0;
            next.set(key, open ? false : 1);
            return next;
          }));
        };
        const deepen = (seq, next) => toggleWithAnchor(
          rows.find((row) => row.seq === seq) ?? null,
          () => setExpanded((prev) => {
            const map = new Map(prev instanceof Map ? prev : []);
            map.set(seq, Number.isInteger(next) && next > 0 ? next : budgetOf(map.get(seq)) + 1);
            return map;
          })
        );
        const toggleDetail = (seq) => toggleWithAnchor(
          rows.find((row) => row.record?.boundarySeq === seq) ?? null,
          () => setDetailOpen((prev) => {
            const next = new Map(prev instanceof Map ? prev : []);
            next.set(seq, next.get(seq) !== true);
            return next;
          })
        );
        (0, import_react.useEffect)(() => {
          const anchor = anchorRef.current;
          anchorRef.current = null;
          if (anchor === null) return;
          const next = anchoredScrollTop({ scrollTop: anchor.scrollTop, anchorOffset: anchor.offset, delta: totalHeight - anchor.totalBefore });
          if (next === anchor.scrollTop) return;
          setScrollTop(next);
          if (listRef.current) listRef.current.scrollTop = next;
        }, [totalHeight]);
        (0, import_react.useEffect)(() => {
          anchorRef.current = null;
        });
        const rounds = roundsOf(chatNodesRef.current, chatOrder);
        const quietRuns = quietRunsOf(list, digests);
        const toggleRun = (key) => setOpenRuns((prev) => {
          const next = new Map(prev instanceof Map ? prev : []);
          next.set(key, next.get(key) !== true);
          return next;
        });
        const jumpLatest = () => {
          const seq = latestSeqOf(chatNodesRef.current, chatOrder);
          if (typeof seq === "number") jump(seq);
        };
        const pathStart = pathStartOf(list, digests);
        (0, import_react.useEffect)(() => {
          if (list.length === 0) return void 0;
          return bindListHeight(document.querySelector(".dsh-rt-view .dsh-rt-timeline-list"));
        }, [list.length]);
        return (0, import_react.createElement)("div", { className: "dsh-rt-view" }, [
          (0, import_react.createElement)("div", { key: "head", className: "dsh-rt-timeline-head" }, [
            (0, import_react.createElement)("span", { key: "title", className: "dsh-rt-timeline-title" }, t("timeline.title")),
            // 会话铭牌（2026-09-01）：所有界面统一展示短码，沟通任务用
            sessionId && (0, import_react.createElement)("code", { key: "badge", className: "dsh-rt-fork-badge-code", title: t("badge.hint") }, `[${badge}]`),
            (0, import_react.createElement)("button", {
              key: "refresh",
              type: "button",
              className: "dsh-rt-chip",
              onClick: refresh
            }, t("timeline.refresh"))
          ]),
          // 概念解释：常驻一句，说清「版本是什么 + 能拿它做什么」（空态也有）。
          // 页首说明（固定，不随虚拟滚动消失）：这是什么 + 共几次 + 顺序提示
          (0, import_react.createElement)("div", { key: "intro", className: "dsh-rt-view-intro" }, [
            (0, import_react.createElement)("span", { key: "what", className: "dsh-rt-intro-what" }, t("timeline.intro", { count: list.length })),
            (0, import_react.createElement)("span", { key: "order", className: "dsh-rt-intro-order" }, t("timeline.orderHint"))
          ]),
          doctor && doctor.enabled && doctor.markerCount > 0 && (0, import_react.createElement)("div", { key: "doctor", className: "dsh-rt-timeline-git dsh-rt-doctor" }, [
            (0, import_react.createElement)("span", { key: "text", className: "dsh-rt-timeline-git-text" }, t("timeline.doctorWarn", { count: doctor.markerCount }))
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
          // Host-side surface replacements are filtered out of the list; say how many
          // instead of hiding them silently (and never mix them with user changes).
          hostReplacements > 0 && (0, import_react.createElement)("div", { key: "hostnote", className: "dsh-rt-host-note" }, t("host.replacements", { count: hostReplacements })),
          error !== null && (0, import_react.createElement)("div", { key: "error", className: "dsh-rt-error" }, error),
          loading && (0, import_react.createElement)("div", { key: "loading", className: "dsh-rt-timeline-empty" }, t("timeline.loading")),
          !loading && list.length === 0 && (0, import_react.createElement)("div", { key: "empty", className: "dsh-rt-timeline-empty" }, t("timeline.empty")),
          rows.length > 0 && (0, import_react.createElement)("div", {
            key: "list",
            ref: listRef,
            className: "dsh-rt-timeline-list",
            onScroll: (event) => setScrollTop(event.target.scrollTop)
          }, [
            // 悬浮收起条：sticky + height:0 ⇒ 不进流、不改 scrollHeight（不用滚到底部）
            (0, import_react.createElement)(CollapseHint, {
              key: "collapse-hint",
              hint: collapseHint,
              t,
              onToggle: (seq) => toggle(seq)
            }),
            (0, import_react.createElement)("div", { key: "spacer", style: { height: `${totalHeight}px`, position: "relative" } }, [
              visible.map((row, i) => (0, import_react.createElement)(CheckpointRow, {
                key: rowKey(row),
                row,
                t,
                top: offsets[visibleStart + i],
                onToggle: toggle,
                onToggleDepth: deepen,
                onToggleDetail: toggleDetail,
                onPreview: row.record === void 0 ? () => {
                } : () => requestPreview(row.record),
                onJump: row.record === void 0 ? () => {
                } : () => jumpRow(row)
              }))
            ])
          ]),
          // 最下方「现在的路」：默认折叠，展开后按轮次列对话文字（仅活路可跳）。
          // 最下方两块：简单改动（R20 默认折叠）+ 现在的路（我们自己的轮次列表，R30）。
          (0, import_react.createElement)(QuietBlock, {
            key: "quiet",
            t,
            runs: quietRuns,
            open: quietOpen,
            onToggle: () => setQuietOpen((open) => !open),
            openRuns,
            onToggleRun: toggleRun,
            onJumpLatest: jumpLatest
          }),
          (0, import_react.createElement)(CurrentPathBlock, { key: "path", t, rounds, start: pathStart, open: pathOpen, messages: chatNodesRef.current instanceof Map ? chatNodesRef.current.size : 0, onToggle: () => setPathOpen((open) => !open), onJump: (seq) => jump(seq) }),
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
      function jumpTargetOf(row) {
        const nowSeq = row?.now?.seq;
        return Number.isSafeInteger(nowSeq) ? nowSeq : row?.record?.boundarySeq;
      }
      function CheckpointRow({ row, t, top, onToggle, onToggleDepth, onToggleDetail, onPreview, onJump }) {
        const level = Number.isInteger(row.level) ? row.level : 0;
        const levelClass = levelClassOf(level);
        const currentClass = row.current ? " dsh-rt-current" : "";
        const style = { top: `${top}px`, paddingLeft: indentOf(level) };
        const guide = guideSpans(level);
        if (row.kind === "collapsed") {
          return (0, import_react.createElement)("div", { className: `dsh-rt-tree-toggle${levelClass}${currentClass}`, style }, [
            ...guide,
            (0, import_react.createElement)(
              "button",
              { type: "button", className: "dsh-rt-chip dsh-rt-tree-btn", onClick: () => onToggle(row.seq) },
              `\u2514\u2500 \u25B8 ${t("tree.changes", { count: Math.max(1, row.count) })}`
            )
          ]);
        }
        if (row.kind === "expanded") {
          return (0, import_react.createElement)("div", { className: `dsh-rt-tree-toggle${levelClass}${currentClass}`, style }, [
            ...guide,
            (0, import_react.createElement)(
              "button",
              { type: "button", className: "dsh-rt-chip dsh-rt-tree-btn", onClick: () => onToggle(row.seq) },
              `\u2514\u2500 \u25BE ${t("tree.collapse")}`
            )
          ]);
        }
        if (row.kind === "depth") {
          return (0, import_react.createElement)("div", { className: `dsh-rt-tree-toggle dsh-rt-tree-depth${levelClass}${currentClass}`, style }, [
            ...guide,
            (0, import_react.createElement)("button", {
              type: "button",
              className: "dsh-rt-chip dsh-rt-tree-btn",
              title: t("tree.deepen"),
              onClick: () => onToggleDepth(row.seq, row.next)
            }, `\u2514\u2500 \u25B8 ${t("tree.moreLevels", { count: Math.max(1, row.remaining) })}`)
          ]);
        }
        if (row.kind === "fallback") {
          return (0, import_react.createElement)("div", { className: `dsh-rt-version dsh-rt-plain${levelClass}${currentClass}`, style }, [
            ...guide,
            (0, import_react.createElement)("span", { className: `dsh-rt-version-kind dsh-rt-version-kind-${row.record.kind}`, title: kindLabel(row.record.kind, t) }, KIND_ICONS[row.record.kind] ?? "\u2022"),
            (0, import_react.createElement)("div", { key: "body", className: "dsh-rt-version-body" }, [
              (0, import_react.createElement)("div", { key: "line1", className: "dsh-rt-version-line" }, [
                (0, import_react.createElement)("span", { key: "kind", className: "dsh-rt-version-kind-label" }, kindLabel(row.record.kind, t)),
                (0, import_react.createElement)("span", { key: "time", className: "dsh-rt-version-time" }, timeLabel(row.record.createdAt)),
                (0, import_react.createElement)("span", { key: "note", className: "dsh-rt-plain-note" }, t("timeline.messages", { count: row.record.messageCount }))
              ])
            ]),
            (0, import_react.createElement)("span", { key: "actions", className: "dsh-rt-version-actions" }, [
              // 无 digest 的兜底行同样遵守"压缩行只给跳转"。
              row.record.kind === "compaction" ? null : (0, import_react.createElement)("button", { key: "restore", type: "button", className: "dsh-rt-chip dsh-rt-chip-danger", onClick: onPreview }, t("timeline.restoreTo")),
              (0, import_react.createElement)("button", { key: "jump", type: "button", className: "dsh-rt-chip", onClick: onJump }, t("timeline.jump"))
            ])
          ]);
        }
        return (0, import_react.createElement)(VersionRow, {
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
          onJump
        });
      }
      function CollapseHint({ hint, t, onToggle }) {
        if (hint === null || hint === void 0) return null;
        return (0, import_react.createElement)("div", { className: "dsh-rt-collapse-hint" }, [
          (0, import_react.createElement)("button", {
            key: "collapse",
            type: "button",
            className: "dsh-rt-chip dsh-rt-collapse-hint-btn",
            title: t("timeline.collapseHintTitle"),
            "aria-label": t("timeline.collapseHintTitle"),
            onClick: () => onToggle(hint.seq)
          }, t("timeline.collapseHint", { label: hint.label }))
        ]);
      }
      function QuietRow({ record, t, onJumpLatest }) {
        return (0, import_react.createElement)("div", { className: "dsh-rt-quiet-row" }, [
          (0, import_react.createElement)(
            "span",
            { key: "text", className: "dsh-rt-plain-text" },
            `${kindLabel(record.kind, t)} \xB7 ${timeLabel(record.createdAt)}${t("quiet.note")}`
          ),
          (0, import_react.createElement)("button", { key: "jump-latest", type: "button", className: "dsh-rt-chip", onClick: onJumpLatest }, t("quiet.jumpLatest"))
        ]);
      }
      function QuietRunRow({ t, run, open, onToggleRun, onJumpLatest }) {
        return (0, import_react.createElement)("div", { className: "dsh-rt-quiet-run" }, [
          (0, import_react.createElement)("div", { key: "head", className: "dsh-rt-quiet-run-head" }, [
            (0, import_react.createElement)(
              "span",
              { key: "text", className: "dsh-rt-plain-text" },
              `${t("quiet.merged", { count: run.length })}${t("quiet.note")}`
            ),
            (0, import_react.createElement)("button", { key: "toggle", type: "button", className: "dsh-rt-chip dsh-rt-quiet-btn", "aria-expanded": open === true, onClick: onToggleRun }, t("quiet.expand"))
          ]),
          open === true && (0, import_react.createElement)("div", { key: "items", className: "dsh-rt-quiet-run-list" }, run.map((record) => (0, import_react.createElement)(QuietRow, {
            key: record.versionId,
            record,
            t,
            onJumpLatest
          })))
        ]);
      }
      function QuietBlock({ t, runs, open, onToggle, openRuns, onToggleRun, onJumpLatest }) {
        const items = Array.isArray(runs) ? runs : [];
        const total = items.reduce((sum, run) => sum + run.length, 0);
        if (total === 0) return null;
        const expanded = openRuns instanceof Map ? openRuns : /* @__PURE__ */ new Map();
        return (0, import_react.createElement)("div", { className: "dsh-rt-quiet-block" }, [
          (0, import_react.createElement)(
            "button",
            { key: "head", type: "button", className: "dsh-rt-quiet-head", "aria-expanded": open === true, onClick: onToggle },
            `${open === true ? "\u25BE" : "\u25B8"} ${t("quiet.blockTitle", { count: total })}${t("quiet.note")}`
          ),
          open === true && (0, import_react.createElement)("div", { key: "list", className: "dsh-rt-quiet-list" }, items.map((run) => run.length >= 2 ? (0, import_react.createElement)(QuietRunRow, {
            key: `quiet:${run[0].boundarySeq}`,
            t,
            run,
            open: expanded.get(`quiet:${run[0].boundarySeq}`) === true,
            onToggleRun: () => onToggleRun(`quiet:${run[0].boundarySeq}`),
            onJumpLatest
          }) : (0, import_react.createElement)(QuietRow, { key: run[0].versionId, record: run[0], t, onJumpLatest })))
        ]);
      }
      function CurrentPathBlock({ t, rounds, open, onToggle, onJump, messages, start }) {
        const items = Array.isArray(rounds) ? rounds : [];
        const startSummary = typeof start?.summary === "string" && start.summary.trim() !== "" ? start.summary : null;
        const startText = typeof start?.text === "string" && start.text.trim() !== "" ? start.text : null;
        const startLine = start === null || start === void 0 ? null : (0, import_react.createElement)("div", { key: "start", className: "dsh-rt-path-start" }, [
          (0, import_react.createElement)("span", { key: "tag", className: "dsh-rt-path-start-tag" }, t("path.start")),
          startSummary !== null ? (0, import_react.createElement)("span", { key: "summary", className: "dsh-rt-path-start-summary" }, [
            (0, import_react.createElement)("span", { key: "tag", className: "dsh-rt-what-summary-tag" }, t("what.summaryTag")),
            (0, import_react.createElement)("span", { key: "text", className: "dsh-rt-path-start-summary-text" }, startSummary)
          ]) : startText !== null ? (0, import_react.createElement)("span", { key: "text", className: "dsh-rt-path-start-text" }, startText) : (0, import_react.createElement)("span", { key: "counts", className: "dsh-rt-path-start-counts" }, t("timeline.messages", { count: Number(start.count) || 0 }))
        ]);
        return (0, import_react.createElement)("div", { className: "dsh-rt-path" }, [
          startLine,
          // Default COLLAPSED (never persisted): one clickable header line only.
          (0, import_react.createElement)("button", {
            key: "head",
            type: "button",
            className: "dsh-rt-path-head",
            "aria-expanded": open === true,
            onClick: onToggle
          }, `${open === true ? "\u25BE" : "\u25B8"} ${t("path.header", { messages: Number(messages) || 0, rounds: items.length })}`),
          open === true && items.length > 0 && (0, import_react.createElement)("div", { key: "list", className: "dsh-rt-path-list" }, items.map((round) => (0, import_react.createElement)("button", {
            key: round.seq ?? round.n,
            type: "button",
            className: "dsh-rt-path-row",
            onClick: () => onJump(round.seq)
          }, [
            (0, import_react.createElement)("span", { key: "n", className: "dsh-rt-path-n" }, t("path.round", { n: round.n })),
            (0, import_react.createElement)("span", { key: "q", className: "dsh-rt-path-q" }, `\u300C${round.question}\u300D`),
            (0, import_react.createElement)("span", { key: "arrow", className: "dsh-rt-path-arrow" }, "\u2192"),
            (0, import_react.createElement)("span", { key: "a", className: "dsh-rt-path-a" }, `\u300C${round.answer}\u300D`)
          ]))),
          open === true && items.length === 0 && (0, import_react.createElement)("div", { key: "empty", className: "dsh-rt-path-empty" }, t("path.empty"))
        ]);
      }
      function VersionRow({ record, top, t, level = 0, current = false, nested = false, what, summary, summaryCalled, discardedCount, turn = null, now = null, detailOpen = false, onToggleDetail, onPreview, onJump }) {
        const summaryText = summaryCalled === true && typeof summary === "string" && summary.trim() !== "" ? summary : null;
        const artifacts = artifactsLabel(what?.artifacts, t);
        const hasWhat = what !== null && what !== void 0;
        const compaction = record.kind === "compaction" || what?.op === "compaction";
        const { lines, replacedTotal } = hasWhat ? whatLineList(what, summaryText, { suppressContinue: nested, artifacts, compaction, now, kind: record.kind }) : { lines: [], replacedTotal: 0 };
        const contentLines = lines.length > 0 ? lines : [{
          kind: "text",
          key: "text",
          text: record.markerText ? record.markerText.length > 120 ? `${record.markerText.slice(0, 120)}\u2026` : record.markerText : whyLabel(record.kind, t)
        }];
        const compactLines = contentLines.slice(0, SHOWN_CONTENT_LINES);
        const detailLines = contentLines.slice(SHOWN_CONTENT_LINES);
        const impactCount = Number.isInteger(discardedCount) ? discardedCount : replacedTotal;
        const levelClass = levelClassOf(level);
        const currentClass = current ? " dsh-rt-current" : "";
        const rowHeight = rowHeightOf({
          kind: "row",
          detailOpen: detailOpen === true,
          detailCount: detailLines.length,
          contentCount: contentLines.length
        });
        return (0, import_react.createElement)("div", { className: `dsh-rt-version${levelClass}${currentClass}`, style: { top: `${top}px`, height: `${rowHeight}px`, paddingLeft: indentOf(level) } }, [
          // 逐级引导线：每一级一枚 `│ `（CSS 画成该级配色的细色条）——层级不靠量像素，
          // 复制成纯文本也仍然是 `│ │ │ …`。
          ...guideSpans(level),
          (0, import_react.createElement)("span", { key: "kind", className: `dsh-rt-version-kind dsh-rt-version-kind-${record.kind}`, title: kindLabel(record.kind, t) }, KIND_ICONS[record.kind] ?? "\u2022"),
          (0, import_react.createElement)("div", { key: "body", className: "dsh-rt-version-body" }, [
            // 行首：动作 · 第 N 轮 · 时间 ·（换掉了 N 条 | 无摘要时的原始消息数）
            // 轮次从日志推（边界事件所在 turn，取不到就**整段省略**，不显示"第 ? 轮"）；
            // 分隔符用可见的 `·`，这样复制出来的纯文本也读得通。
            (0, import_react.createElement)("div", { key: "line1", className: "dsh-rt-version-line" }, [
              (0, import_react.createElement)("span", { key: "kind", className: "dsh-rt-version-kind-label" }, kindLabel(record.kind, t)),
              // 轮次拿不到时**连分隔符一起省**（不留一个孤零零的 ·）
              roundOf(turn) === null ? null : [
                line1Separator("sep-round"),
                (0, import_react.createElement)("span", { key: "round", className: "dsh-rt-version-round" }, t("timeline.round", { n: roundOf(turn) }))
              ],
              line1Separator("sep-time"),
              (0, import_react.createElement)("span", { key: "time", className: "dsh-rt-version-time" }, timeLabel(typeof what?.at === "number" ? what.at : record.createdAt)),
              impactCount > 0 ? [
                line1Separator("sep-count"),
                (0, import_react.createElement)("span", { key: "count", className: "dsh-rt-version-count" }, t("what.countShort", { count: impactCount }))
              ] : hasWhat ? null : [
                line1Separator("sep-msgs"),
                (0, import_react.createElement)("span", { key: "msgs", className: "dsh-rt-version-msgs" }, t("timeline.messages", { count: record.messageCount }))
              ]
            ]),
            // 第 2..3 行：② 现在这条 → ③ 原来的内容（压缩行仍只有一条归属说明）
            compactLines.map((line) => whatLineElement(line, t, { onJump })),
            // 展开态：其余明细行（引文 2..3 / 另有 M 条 / 【摘要】 / 延续 / 产物明细）
            detailOpen === true && detailLines.length > 0 ? detailLines.map((line) => whatLineElement(line, t, { onJump })) : null
          ]),
          // 明细的唯一入口：行尾的「›」（原来的「▸ 明细」chip 已并入它 —— 一行里
          // 不再挤两个同义入口）。detailLines > 0 才出现，避免死入口。
          detailLines.length > 0 ? (0, import_react.createElement)("button", {
            key: "open",
            type: "button",
            className: "dsh-rt-row-open",
            title: t("timeline.openEntry"),
            "aria-label": t("timeline.openEntry"),
            "aria-expanded": detailOpen === true,
            onClick: () => onToggleDetail(record.boundarySeq)
          }, "\u203A") : null,
          // 行尾动作：回到这一档（回退，走二次确认）+ 跳转（纯导航）。
          // 宿主压缩行**只给跳转**（用户口径 2026-09-15）：回退到宿主压缩点不是用户
          // 的意图，那个档也不是我们造成的。
          (0, import_react.createElement)("span", { key: "actions", className: "dsh-rt-version-actions" }, [
            compaction === true ? null : (0, import_react.createElement)("button", { key: "restore", type: "button", className: "dsh-rt-chip dsh-rt-chip-danger", onClick: onPreview }, t("timeline.restoreTo")),
            (0, import_react.createElement)("button", { key: "jump", type: "button", className: "dsh-rt-chip", onClick: onJump }, t("timeline.jump"))
          ])
        ]);
      }
      var RetraceErrorBoundary = class extends import_react.Component {
        constructor(props) {
          super(props);
          this.state = { error: null };
        }
        static getDerivedStateFromError(error) {
          return { error: error instanceof Error ? error : new Error(String(error)) };
        }
        componentDidCatch(error) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(`[dsh-retrace] view render failed: ${message}`);
          try {
            const sent = callOp("clientReport", { id: "view-render-error", source: `view-render-error: ${message}`.slice(0, 200) });
            if (sent && typeof sent.catch === "function") sent.catch(() => {
            });
          } catch {
          }
        }
        render() {
          const error = this.state.error;
          if (error === null) return this.props.children;
          const t = typeof this.props.t === "function" ? this.props.t : (key) => key;
          const title = typeof this.props.title === "string" && this.props.title !== "" ? this.props.title : t("view.errorTitle");
          return (0, import_react.createElement)("div", { className: "dsh-rt-view dsh-rt-view-error" }, [
            (0, import_react.createElement)("div", { key: "title", className: "dsh-rt-error-title" }, title),
            (0, import_react.createElement)("div", { key: "hint", className: "dsh-rt-view-intro" }, t("view.errorHint")),
            (0, import_react.createElement)("pre", { key: "detail", className: "dsh-rt-error-detail" }, String(error.message ?? error)),
            (0, import_react.createElement)("button", {
              key: "retry",
              type: "button",
              className: "dsh-rt-chip dsh-rt-error-retry",
              onClick: () => this.setState({ error: null })
            }, t("view.errorRetry"))
          ]);
        }
      };
      var withPanelBoundary = (Component2, titleKey) => (props) => (0, import_react.createElement)(
        RetraceErrorBoundary,
        {
          t: props?.t,
          title: typeof props?.t === "function" ? props.t(titleKey) : void 0
        },
        (0, import_react.createElement)(Component2, props)
      );
      function PreviewBox({ preview, scope, setScope, busy, t, onConfirm, onCancel }) {
        const data = preview.data;
        const contextOnly = preview.contextOnly === true;
        const scopes = contextOnly ? [["context", "timeline.contextOnly", "timeline.contextOnlyDesc"]] : [
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
            // R34: the second confirmation must state WHAT it touches — the message
            // count above, plus the artifact count and the file detail below.
            !contextOnly && (0, import_react.createElement)(
              "div",
              { key: "art", className: "dsh-rt-modal-line" },
              (data.artifacts?.rows?.length ?? 0) > 0 ? t("timeline.artifactsImpact", { count: data.artifacts.rows.length }) : t("timeline.filesNone")
            ),
            !contextOnly && (data.artifacts?.rows?.length ?? 0) > 0 && (0, import_react.createElement)("ul", { key: "files", className: "dsh-rt-modal-files" }, (data.artifacts?.rows ?? []).slice(0, 12).map((row) => (0, import_react.createElement)("li", { key: row.path }, [
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
      function whatLineList(what, summaryText, { suppressContinue = false, artifacts = null, compaction = false, now = null, kind = null } = {}) {
        const rawReplaced = Array.isArray(what?.replaced) ? what.replaced : [];
        const replaced = rawReplaced.filter((entry) => typeof entry?.excerpt === "string" && entry.excerpt !== "");
        const newExcerpt = typeof what?.new?.excerpt === "string" ? what.new.excerpt : "";
        const replacedTotal = rawReplaced.length + (Number.isInteger(what?.replacedMore) ? what.replacedMore : 0);
        const lines = [];
        if (compaction === true) {
          lines.push({ kind: "compacted", key: "old-compacted", count: replacedTotal });
        } else {
          const nowExcerpt = typeof now?.excerpt === "string" ? now.excerpt : "";
          const firstOld = replaced.length > 0 ? replaced[0].excerpt : "";
          const mergedSame = kind !== "recall" && nowExcerpt !== "" && nowExcerpt === firstOld;
          if (kind === "recall") {
            lines.push({ kind: "now-none", key: "now-none", reason: "recall" });
          } else if (mergedSame) {
            lines.push({ kind: "now-same", key: "now-same", text: nowExcerpt });
          } else if (nowExcerpt !== "") {
            lines.push({ kind: "now", key: "now", text: nowExcerpt });
          } else if (kind === "edit" || kind === "regenerate") {
            lines.push({ kind: "now-none", key: "now-none", reason: "missing" });
          }
          const oldShown = mergedSame ? replaced.slice(1) : replaced;
          for (const entry of oldShown) lines.push({ kind: "old", key: `old-${entry.seq}`, entry });
          const listedCount = mergedSame ? 1 + oldShown.length : replaced.length;
          if (replacedTotal > 0 && replaced.length === 0) {
            lines.push({ kind: "compacted", key: "old-compacted", count: replacedTotal });
          } else if (replacedTotal > listedCount) {
            lines.push({ kind: "more", key: "old-more", count: replacedTotal - listedCount });
          }
        }
        if (summaryText !== null && summaryText !== void 0) lines.push({ kind: "summary", key: "summary", text: summaryText });
        if (!suppressContinue && newExcerpt !== "") lines.push({ kind: "new", key: "new", text: newExcerpt });
        if (typeof artifacts === "string" && artifacts !== "") lines.push({ kind: "files", key: "files", text: artifacts });
        return { lines, replacedTotal };
      }
      function line1Separator(key) {
        return (0, import_react.createElement)("span", { key, className: "dsh-rt-line-sep" }, "\xB7");
      }
      function summaryTextOf(digest) {
        return digest?.called === true && typeof digest.summary === "string" && digest.summary.trim() !== "" ? digest.summary : null;
      }
      function whatLineElement(line, t, { onJump = null } = {}) {
        if (line === null || line === void 0) return null;
        if (line.kind === "now") {
          return (0, import_react.createElement)("div", { key: line.key, className: "dsh-rt-what-quote dsh-rt-what-now" }, [
            (0, import_react.createElement)("span", { key: "label", className: "dsh-rt-what-label" }, t("what.nowLabel")),
            typeof onJump === "function" ? (0, import_react.createElement)("button", {
              key: "jump",
              type: "button",
              className: "dsh-rt-what-text dsh-rt-what-jump",
              title: t("timeline.jump"),
              "aria-label": t("timeline.jump"),
              onClick: onJump
            }, `\u300C${line.text}\u300D`) : (0, import_react.createElement)("span", { key: "text", className: "dsh-rt-what-text" }, `\u300C${line.text}\u300D`)
          ]);
        }
        if (line.kind === "now-same") {
          return (0, import_react.createElement)("div", { key: line.key, className: "dsh-rt-what-quote dsh-rt-what-now dsh-rt-what-same" }, [
            (0, import_react.createElement)("span", { key: "label", className: "dsh-rt-what-label" }, t("what.resentSame")),
            typeof onJump === "function" ? (0, import_react.createElement)("button", {
              key: "jump",
              type: "button",
              className: "dsh-rt-what-text dsh-rt-what-jump",
              title: t("timeline.jump"),
              "aria-label": t("timeline.jump"),
              onClick: onJump
            }, `\u300C${line.text}\u300D`) : (0, import_react.createElement)("span", { key: "text", className: "dsh-rt-what-text" }, `\u300C${line.text}\u300D`)
          ]);
        }
        if (line.kind === "now-none") {
          return (0, import_react.createElement)(
            "div",
            { key: line.key, className: "dsh-rt-what-more dsh-rt-what-none" },
            line.reason === "recall" ? t("what.noNewRecall") : t("what.noNewMissing")
          );
        }
        if (line.kind === "old") {
          return (0, import_react.createElement)("div", { key: line.key, className: "dsh-rt-what-quote dsh-rt-what-old" }, [
            (0, import_react.createElement)("span", { key: "label", className: "dsh-rt-what-label" }, t("what.oldLabel")),
            (0, import_react.createElement)("span", { key: "role", className: "dsh-rt-what-role" }, roleLabel2(line.entry.role, t)),
            (0, import_react.createElement)("span", { key: "text", className: "dsh-rt-what-text" }, `\u300C${line.entry.excerpt}\u300D`)
          ]);
        }
        if (line.kind === "compacted") {
          return (0, import_react.createElement)("div", { key: line.key, className: "dsh-rt-what-more" }, t("what.compacted", { count: line.count }));
        }
        if (line.kind === "more") {
          return (0, import_react.createElement)("div", { key: line.key, className: "dsh-rt-what-more" }, t("what.more", { count: line.count }));
        }
        if (line.kind === "summary") {
          return (0, import_react.createElement)("div", { key: line.key, className: "dsh-rt-what-summary" }, [
            (0, import_react.createElement)("span", { key: "tag", className: "dsh-rt-what-summary-tag" }, t("what.summaryTag")),
            (0, import_react.createElement)("span", { key: "text", className: "dsh-rt-what-summary-text" }, line.text)
          ]);
        }
        if (line.kind === "new") {
          return (0, import_react.createElement)("div", { key: line.key, className: "dsh-rt-what-quote dsh-rt-what-new" }, [
            (0, import_react.createElement)("span", { key: "tag", className: "dsh-rt-what-new-tag" }, t("what.currentLabel")),
            (0, import_react.createElement)("span", { key: "text", className: "dsh-rt-what-text" }, `\u300C${line.text}\u300D`)
          ]);
        }
        if (line.kind === "files") {
          return (0, import_react.createElement)("div", { key: line.key, className: "dsh-rt-version-files" }, line.text);
        }
        if (line.kind === "text") {
          return (0, import_react.createElement)("div", { key: line.key, className: "dsh-rt-version-text" }, line.text);
        }
        return null;
      }
      var GUARD_MODAL_ID = "dsh-rt-guard-modal";
      var GUARD_BANNER_ID = "dsh-rt-guard-banner";
      var GUARD_TOAST_ID = "dsh-rt-guard-toast";
      function installCloseGuard(t) {
        if (typeof window === "undefined" || typeof document === "undefined") return () => {
        };
        const locale = () => t("action.cancel") === "\u53D6\u6D88" ? "zh" : "en";
        const store = createGuardStore();
        const ui = { banner: null, modal: null, toast: null, toastTimer: 0, dismissed: null, expanded: false, lastSig: "" };
        let supported = true;
        let failures = 0;
        const labelOf = (sessionId) => canonicalBadgeOf(sessionId) || String(sessionId);
        const runningSig = (snapshot) => {
          const running = snapshot?.running;
          if (!Array.isArray(running)) return "";
          return running.map((r) => `${r.sessionId}:${(r.reasons ?? []).join(",")}`).join("|");
        };
        function queryRunningState() {
          if (typeof wire === "function") return wire("runningState", {});
          return fetch(`${ROUTE_BASE}/runningState`, {
            method: "GET",
            headers: retraceConfigHeaders(),
            cache: "no-store"
          }).then((res) => {
            if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
            return res.json();
          });
        }
        function refresh() {
          if (!supported) return;
          queryRunningState().then((payload) => {
            failures = 0;
            const value = payload && payload.ok ? payload.value : null;
            if (!value || !Array.isArray(value.running)) return;
            const prev = store.get();
            store.set({ running: value.running, quitVeto: value.quitVeto, surface: value.surface });
            if (runningSig(store.get()) !== runningSig(prev)) ui.dismissed = null;
            renderBanner();
          }).catch(() => {
            failures += 1;
            if (failures >= 3) {
              supported = false;
              removeBanner();
              console.warn("[dsh-retrace] close-guard: running-state \u901A\u9053\u4E0D\u53EF\u7528(3 \u6B21\u5931\u8D25),\u672C\u9875\u5173\u95ED\u5B88\u536B\u505C\u7528");
            }
          });
        }
        function removeBanner() {
          if (ui.banner) {
            ui.banner.remove();
            ui.banner = null;
          }
        }
        function bannerNote(lang) {
          return lang === "zh" ? "\u5173\u95ED\u9875\u9762/\u9000\u51FA\u524D\u8BF7\u5148\u786E\u8BA4\u2014\u2014\u4EFB\u52A1\u4E2D\u65AD\u53EF\u80FD\u4E22\u5931\u8FDB\u5EA6(\u684C\u9762\u7AEF\u7528\u9875\u9762\u81EA\u7ED8\u786E\u8BA4\u6846;\u82E5\u672A\u5F39\u51FA,\u4EE5\u6B64\u6A2A\u5E45\u4E3A\u51C6)" : "Confirm before closing/exiting \u2014 interrupting work may lose progress (Desktop uses a page-drawn confirm dialog; if it does not appear, rely on this banner)";
        }
        function renderBanner() {
          const cfg = getConfig();
          if (!cfg.closeGuard || !supported) return removeBanner();
          const snap = store.get();
          if (classifySnapshot(snap) !== "running") return removeBanner();
          const lang = locale();
          const lines = runningLines(snap.running, { locale: lang, labelOf });
          const sig = lines.join("\n");
          if (ui.dismissed === sig) return;
          if (ui.banner && ui.banner.isConnected && ui.lastSig === sig) return;
          if (!ui.banner) {
            ui.banner = document.createElement("div");
            ui.banner.id = GUARD_BANNER_ID;
            ui.banner.className = "dsh-rt-guard-banner";
            const head2 = document.createElement("div");
            head2.className = "dsh-rt-guard-banner-head";
            ui.banner.appendChild(head2);
            const note = document.createElement("div");
            note.className = "dsh-rt-guard-banner-note";
            ui.banner.appendChild(note);
            const list = document.createElement("div");
            list.className = "dsh-rt-guard-banner-list";
            list.style.display = "none";
            ui.banner.appendChild(list);
            document.body.appendChild(ui.banner);
          }
          const n = snap.running.length;
          const head = ui.banner.firstChild;
          head.textContent = "";
          head.appendChild(document.createTextNode(lang === "zh" ? `\u26A0\uFE0F ${n} \u4E2A\u4F1A\u8BDD\u8FD0\u884C\u4E2D` : `\u26A0\uFE0F ${n} session${n === 1 ? "" : "s"} running`));
          const toggle = document.createElement("button");
          toggle.type = "button";
          toggle.className = "dsh-rt-guard-link";
          toggle.textContent = ui.expanded ? lang === "zh" ? "\u6536\u8D77" : "Hide" : lang === "zh" ? "\u660E\u7EC6" : "Details";
          toggle.onclick = () => {
            ui.expanded = !ui.expanded;
            const list = ui.banner.querySelector(".dsh-rt-guard-banner-list");
            if (list) list.style.display = ui.expanded ? "block" : "none";
            toggle.textContent = ui.expanded ? lang === "zh" ? "\u6536\u8D77" : "Hide" : lang === "zh" ? "\u660E\u7EC6" : "Details";
          };
          const dismiss = document.createElement("button");
          dismiss.type = "button";
          dismiss.className = "dsh-rt-guard-link";
          dismiss.textContent = "\xD7";
          dismiss.title = lang === "zh" ? "\u5FFD\u7565(\u4EFB\u52A1\u7ED3\u675F\u6216\u53D8\u5316\u540E\u518D\u63D0\u793A)" : "Dismiss (re-shows when the running set changes)";
          dismiss.onclick = () => {
            ui.dismissed = sig;
            removeBanner();
          };
          head.appendChild(toggle);
          head.appendChild(dismiss);
          ui.banner.querySelector(".dsh-rt-guard-banner-note").textContent = bannerNote(lang);
          const listEl = ui.banner.querySelector(".dsh-rt-guard-banner-list");
          listEl.textContent = lines.join("\n");
          listEl.style.display = ui.expanded ? "block" : "none";
          ui.lastSig = sig;
        }
        function hideModal() {
          if (ui.modal) {
            ui.modal.remove();
            ui.modal = null;
          }
        }
        function showModal() {
          const snap = store.get();
          if (classifySnapshot(snap) !== "running") return;
          const lang = locale();
          const copy = buildRunningCopy(snap, { locale: lang, labelOf });
          hideModal();
          const overlay = document.createElement("div");
          overlay.className = "dsh-rt-guard-overlay";
          overlay.id = GUARD_MODAL_ID;
          overlay.onclick = (event) => {
            if (event.target === overlay) hideModal();
          };
          const modal = document.createElement("div");
          modal.className = "dsh-rt-guard-modal";
          modal.onclick = (event) => event.stopPropagation();
          const title = document.createElement("div");
          title.className = "dsh-rt-guard-modal-title";
          title.textContent = copy.head;
          modal.appendChild(title);
          const lines = document.createElement("div");
          lines.className = "dsh-rt-guard-modal-lines";
          lines.textContent = copy.lines.join("\n");
          modal.appendChild(lines);
          if (copy.hint) {
            const hint = document.createElement("div");
            hint.className = "dsh-rt-guard-modal-hint";
            hint.textContent = copy.hint;
            modal.appendChild(hint);
          }
          const actions = document.createElement("div");
          actions.className = "dsh-rt-guard-modal-actions";
          const cancel = document.createElement("button");
          cancel.type = "button";
          cancel.className = "dsh-rt-guard-btn";
          cancel.textContent = lang === "zh" ? "\u53D6\u6D88" : "Cancel";
          cancel.onclick = () => hideModal();
          const proceed = document.createElement("button");
          proceed.type = "button";
          proceed.className = "dsh-rt-guard-btn dsh-rt-guard-btn-primary";
          proceed.textContent = lang === "zh" ? "\u4ECD\u5173\u95ED" : "Close anyway";
          proceed.onclick = () => {
            store.arm();
            hideModal();
            try {
              window.close();
            } catch {
            }
            showToast(lang === "zh" ? "\u5DF2\u653E\u884C\u2014\u2014\u82E5\u672A\u81EA\u52A8\u9000\u51FA,\u8BF7\u518D\u6B21\u70B9\u51FB\u5173\u95ED\u7A97\u53E3/\u6807\u7B7E\u9875(30 \u79D2\u5185\u6709\u6548,\u8FC7\u671F\u9700\u91CD\u65B0\u786E\u8BA4)" : "Armed \u2014 if the window did not close, click close again (valid 30s, then re-confirm)");
          };
          actions.appendChild(cancel);
          actions.appendChild(proceed);
          modal.appendChild(actions);
          overlay.appendChild(modal);
          document.body.appendChild(overlay);
          ui.modal = overlay;
        }
        function showToast(text) {
          if (!ui.toast) {
            ui.toast = document.createElement("div");
            ui.toast.id = GUARD_TOAST_ID;
            ui.toast.className = "dsh-rt-guard-toast";
            document.body.appendChild(ui.toast);
          }
          ui.toast.textContent = text;
          clearTimeout(ui.toastTimer);
          ui.toastTimer = setTimeout(() => {
            if (ui.toast) {
              ui.toast.remove();
              ui.toast = null;
            }
          }, 8e3);
        }
        function onBeforeUnload(event) {
          if (!getConfig().closeGuard || !supported) return;
          if (store.isArmed()) return;
          const kind = classifySnapshot(store.get());
          if (kind === "unknown") return;
          if (!shouldArmNativeGate(store.get())) return;
          try {
            event.preventDefault?.();
          } catch {
          }
          try {
            event.returnValue = "";
          } catch {
          }
          if (kind === "running") {
            setTimeout(() => {
              if (classifySnapshot(store.get()) === "running" && !store.isArmed()) showModal();
            }, 0);
          }
        }
        function onVisibility() {
          if (document.visibilityState === "visible") refresh();
        }
        window.addEventListener("beforeunload", onBeforeUnload);
        document.addEventListener("visibilitychange", onVisibility);
        const timer = window.setInterval(refresh, GUARD_POLL_MS);
        refresh();
        const unsubscribe = subscribeConfig(() => {
          renderBanner();
          if (getConfig().closeGuard) refresh();
        });
        return () => {
          window.removeEventListener("beforeunload", onBeforeUnload);
          document.removeEventListener("visibilitychange", onVisibility);
          window.clearInterval(timer);
          unsubscribe();
          removeBanner();
          hideModal();
          if (ui.toast) {
            ui.toast.remove();
            ui.toast = null;
          }
          clearTimeout(ui.toastTimer);
        };
      }
      function conversationRegistrar(service) {
        if (service === null || typeof service !== "object") return null;
        const events = service.events;
        if (events !== null && typeof events === "object" && typeof events.register === "function") {
          return { register: (definition) => events.register(definition), via: "events" };
        }
        if (typeof service.register === "function") {
          return { register: (definition) => service.register(definition), via: "self" };
        }
        return null;
      }
      function apply(ctx) {
        const disposeStyle = ensureStyle();
        ctx.effect(() => () => disposeStyle(), "dsh-retrace: styles");
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-retrace: dictionaries");
        ctx.effect(() => {
          try {
            return bootstrapBadgeTitles();
          } catch (error) {
            reportBadgeFailure("initBadgeTitles", error);
            return () => {
            };
          }
        }, "dsh-retrace: init badge titles");
        const t = ctx.locale.bind(NS);
        let disposeCloseGuard = () => {
        };
        try {
          disposeCloseGuard = installCloseGuard(t);
        } catch (error) {
          console.warn(`[dsh-retrace] close guard unavailable: ${String(error?.message ?? error)}`);
        }
        ctx.effect(() => () => disposeCloseGuard(), "dsh-retrace: close guard");
        let slotMounted = 0;
        let slotSeats = 0;
        let definitionsCount = 0;
        let definitionsSource = "none";
        let reportLines = 0;
        let lastReportKey = "";
        const sendClientReport = () => {
          const key = `${definitionsCount}|${definitionsSource}`;
          if (reportLines > 0 && (key === lastReportKey || reportLines >= 2)) return;
          reportLines += 1;
          lastReportKey = key;
          try {
            const sent = callOp("clientReport", {
              id: name,
              inject: [...inject],
              definitions: definitionsCount,
              slots: slotMounted,
              seats: slotSeats,
              source: definitionsSource
            });
            if (sent && typeof sent.catch === "function") sent.catch(() => {
            });
          } catch {
          }
        };
        const scheduleClientReport = (delayMs) => {
          const schedule = typeof window === "undefined" ? void 0 : window.setTimeout;
          if (typeof schedule === "function") {
            schedule(sendClientReport, delayMs);
            return;
          }
          if (typeof queueMicrotask === "function") {
            queueMicrotask(sendClientReport);
            return;
          }
          sendClientReport();
        };
        scheduleClientReport(3e3);
        const registerConversationDefinitions = (serviceName, service) => {
          if (definitionsCount > 0) return true;
          const registrar = conversationRegistrar(service);
          if (registrar === null) {
            if (service !== void 0 && service !== null) definitionsSource = `${serviceName}.no-register-entry`;
            return false;
          }
          const disposeDefinitions = [
            registrar.register(userActionsDefinition),
            registrar.register(userReferenceDefinition),
            registrar.register(recallMarkerDefinition),
            // 第 1 段审计 `compaction/prune` 的读端上下文：不建视图（无 target），只为
            // 「顶层 provenance 被剥掉时取出被遮蔽集合」提供一个可按 kind 取到的相邻上下文
            // （0.4.12 的 data.shadowedSeqs 冗余已随官方词表收紧取消）。
            registrar.register(auditContextDefinition())
          ];
          definitionsCount = disposeDefinitions.length;
          definitionsSource = `${serviceName}.${registrar.via}`;
          ctx.effect(
            () => () => disposeDefinitions.forEach((dispose) => {
              try {
                dispose();
              } catch {
              }
            }),
            `dsh-retrace: conversation definitions (${definitionsSource})`
          );
          scheduleClientReport(0);
          return true;
        };
        if (!registerConversationDefinitions("uiConversation", ctx.get("uiConversation"))) {
          ctx.inject(["uiConversation"], (child) => {
            if (!registerConversationDefinitions("uiConversation", child.get("uiConversation"))) scheduleClientReport(0);
          });
        }
        if (definitionsCount === 0 && !registerConversationDefinitions("conversationEvents", ctx.get("conversationEvents"))) {
          ctx.inject(["conversationEvents"], (child) => {
            if (!registerConversationDefinitions("conversationEvents", child.get("conversationEvents"))) scheduleClientReport(0);
          });
        }
        const mountSlot = (seat, mount) => {
          slotSeats += 1;
          return ctx.slots.inject(seat, () => {
            const dispose = mount();
            slotMounted += 1;
            return dispose;
          });
        };
        mountSlot("conversation.chat.assistant-actions", () => ctx.slots.register({
          name: "conversation.chat.assistant-actions",
          id: "retrace",
          order: 20,
          locale: NS
        }, withPanelBoundary(AssistantActions, "panel.error.actions")));
        mountSlot("conversation.chat.node", () => ctx.slots.register({
          name: "conversation.chat.node",
          key: "user-actions",
          locale: NS
        }, withPanelBoundary(UserActionsRow, "panel.error.userActions")));
        mountSlot("conversation.chat.node", () => ctx.slots.register({
          name: "conversation.chat.node",
          key: "retrace-reference",
          locale: NS
        }, withPanelBoundary(ReferenceRow, "panel.error.reference")));
        mountSlot("conversation.chat.node", () => ctx.slots.register({
          name: "conversation.chat.node",
          key: "recall-marker",
          locale: NS
        }, withPanelBoundary(RecallMarkerRow, "panel.error.marker")));
        mountSlot("conversation.view", () => ctx.slots.register({
          name: "conversation.view",
          id: "retrace",
          order: 20,
          locale: NS,
          label: () => t("view.retrace"),
          inject: (sessionId, actions) => ({
            actions,
            store: ctx.get?.("sessions")?.binding?.(sessionId)?.session
          })
          // The boundary wraps the view INSIDE the host's React tree, so a render error
          // can only break this panel (never the whole GUI).
        }, withPanelBoundary(RetraceView, "view.errorTitle")));
        mountSlot("settings.general.item", () => ctx.slots.register({
          name: "settings.general.item",
          id: "retrace",
          order: 30,
          locale: NS
        }, withPanelBoundary(OptionsRow, "panel.error.options")));
      }
      return module.exports
    })()
    if (typeof mod.__setMessageEditorWire === 'function') {
      mod.__setMessageEditorWire((op, payload) => host.call(`retrace.${op}`, payload))
    }
    return mod.apply(ctx)
  },
}
