#!/usr/bin/env node
/**
 * check-host-contract — executable pre-release gate for the DSH host API surface.
 *
 * Why this exists: twice now a plugin release was written against a host member
 * that the installed DSH Desktop no longer has — `snapshot.chat.nodes` on the
 * client and `session.events` on the host. Both times the failure was silent
 * (no crash, clean logs), so only a real user noticed. This script turns the
 * audit table (内部审计报告 §2) into a
 * mechanical check: every host member the plugin reads must still exist, and
 * every member that must NOT exist must stay absent.
 *
 * Reads the INSTALLED app.asar directly (no network, no profile changes).
 *   ASAR: /Applications/DSH Desktop.app/Contents/Resources/app.asar
 *         (override with DSH_ASAR=/path/to/app.asar)
 *
 * Exit codes: 0 = all checks pass (or the asar is absent → explicit SKIP),
 *             1 = contract drift (drift/migration hint printed per failure).
 *
 * NOTE: do NOT reuse the `--grep` branch of the older lab helper — it prints
 * nothing on success and would make this gate vacuously green.
 */
import { existsSync, openSync, readSync, closeSync, realpathSync, readdirSync, statSync, readFileSync } from 'node:fs'
import { resolve, dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ASAR = process.env.DSH_ASAR || '/Applications/DSH Desktop.app/Contents/Resources/app.asar'
/** Repo root (for the plugin-side invariant; this script lives in scripts/). */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// ---------------------------------------------------------------------------
// Member-declaration matcher (unit-tested in test/host-contract-matcher.test.js)
//
// `absent` checks answer "would this member come back?". A regex for the two
// obvious forms (`^\s+m;` and `get m()`) misses how the host ACTUALLY declares
// its own members — with initializers and constructor assignments:
//   `log = [];`  `eventsSnapshot;`  `headerFoldSeq = 0;`  `inbox;`  `hasMore = false;`
// (review-independent-2 §2.2(a) found 16 missed resurrection forms).
// So match every plausible form; over-matching (a false red) is the safe
// direction for a reverse assertion.
// ---------------------------------------------------------------------------

/** Escape a string for literal use inside a RegExp. */
export function escapeRegExp(literal) {
  return String(literal).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * True when `text` declares or defines `member` in any form a host would use:
 *   1. class field / declaration, optionally initialized:
 *      `events;`  `events = [];`  `events = void 0`  `events = new Map()`  `hasMore = false;`
 *      (also `static events = …`, `events ??= …`, optional `events?: T`)
 *   2. getter / setter / method (incl. async / generator / static):
 *      `get events() {`  `events() {`  `async events() {`  `*events() {`
 *   3. constructor / instance assignment or mutation: `this.events = []`, `this.events.push(x)`
 *   4. object-literal property: `{ events: [] }` / `{events}` / `, events: …`
 *   5. a bare `member:` at line start (a property key / label on its own line)
 * Local `const events = []` is NOT a member and must not match (test-pinned).
 *
 * @param {string} text - one host file (or a class-body slice)
 * @param {string} member - bare member name, e.g. 'events'
 * @returns {boolean}
 */
export function declaresMember(text, member) {
  const m = escapeRegExp(member)
  const patterns = [
    new RegExp(`^[ \\t]*(?:static[ \\t]+)?${m}[ \\t]*(?:[;=]|\\?\\??[ \\t]*[:;=]|\\.[a-zA-Z_$])`, 'm'),
    new RegExp(`^[ \\t]*(?:static[ \\t]+)?(?:async[ \\t]+)?(?:get[ \\t]+|set[ \\t]+)?\\*?${m}[ \\t]*\\(`, 'm'),
    new RegExp(`\\bthis\\.[ \\t]*${m}\\b`),
    new RegExp(`[{,][ \\t]*(?:\\r?\\n[ \\t]*)?${m}[ \\t]*[:,}]`),
    new RegExp(`^[ \\t]*${m}[ \\t]*:`, 'm'),
  ]
  return patterns.some((re) => re.test(text))
}

/**
 * Slice one class body out of a file so a member check cannot be satisfied or
 * broken by an unrelated class in the same file (e.g. SessionStore's local
 * `sessionId = …` assignment must not look like `Session.sessionId`).
 * @param {string} text
 * @param {{start: string, end: string}} scope
 * @returns {string|null} null when the scope markers are gone (itself drift)
 */
export function scopedSlice(text, scope) {
  const from = text.indexOf(scope.start)
  if (from === -1) return null
  const after = from + scope.start.length
  const to = text.indexOf(scope.end, after)
  if (to === -1) return null
  return text.slice(after, to)
}

/** `var Session = class Session { … };` in dsh-session/lib/index.js. */
const SESSION_CLASS = { start: 'var Session = class Session {', end: '\n};' }
/** `var SessionStore = class extends Service { … };` (the sessions service). */
const SESSION_STORE_CLASS = { start: 'var SessionStore = class extends Service {', end: '\n};' }
/** `export class Session { … }` in the bundled types copy. */
const SESSION_CLASS_TYPES = { start: 'export class Session {', end: '\n}' }

/**
 * Bolt-on / reflection forms that live OUTSIDE the class body — so the scoped
 * `declaresMember` cannot see them (review-independent-3 §2.2, E1-E7/E12).
 * This runs on the WHOLE file, never on a slice: E3
 * (`Object.assign(Session.prototype, {events: []})`) is red file-wide but green
 * inside the class slice, i.e. slicing itself introduced that escape.
 *
 * Covers: Object.defineProperty(ies)/Reflect.defineProperty with the member as a
 * string key, Object.assign(X, {member…}), `X.prototype.member = …`,
 * `X.prototype, 'member'`, `__defineGetter__/__defineSetter__('member')`,
 * `__decorate([…], X.prototype, 'member', …)`, and computed class members
 * `['member'] = …` / `['member']() {}`.
 *
 * Known remaining escapes (deliberately not chased; listed in
 * review-independent-3 §2.2): `@dec member = …` on one line (E8, compiled away
 * in shipped JS), `declare member: T` (E9, needs a .d.ts), a comment between the
 * name and `=` (E10), and a line break before `=` (E11). Do not read this as an
 * exhaustive enumeration — see test/host-contract-matcher.test.js.
 *
 * @param {string} text - whole file contents
 * @param {string} member - bare member name, e.g. 'events'
 * @returns {boolean}
 */
export function declaresMemberBoltOn(text, member) {
  const m = escapeRegExp(member)
  const q = `['"\`]${m}['"\`]`
  const patterns = [
    new RegExp(`definePropert(?:y|ies)\\s*\\([^)]*${q}`),
    new RegExp(`Object\\.assign\\s*\\([^)]*\\{[^}]*\\b${m}\\b\\s*[:,}]`),
    new RegExp(`\\.prototype\\s*\\.\\s*${m}\\b`),
    new RegExp(`\\.prototype\\s*,\\s*${q}`),
    new RegExp(`__define(?:Getter|Setter)__\\s*\\(\\s*${q}`),
    new RegExp(`__decorate\\s*\\([^;]*${q}`),
    new RegExp(`\\[\\s*${q}\\s*\\]\\s*(?:[;=]|\\()`),
    // cheap extras for E8/E9 (low reality, but free)
    new RegExp(`^[ \\t]*@[\\w$.]+[^\\n]*\\b${m}\\b\\s*[;=]`, 'm'),
    new RegExp(`^[ \\t]*declare[ \\t]+${m}\\b`, 'm'),
  ]
  return patterns.some((re) => re.test(text))
}

/**
 * Slice ONE entry of the host's slot contract catalog, bounded by the next
 * `key: "` (deterministic), not by a character window (review-independent-3
 * §4.3). `conversation.view` sits among ~40 catalog entries; a char window could
 * match a neighbouring entry's `standardProps`.
 * @param {string} text
 * @param {string} key - catalog key, e.g. 'conversation.view'
 * @returns {string|null}
 */
export function entrySlice(text, key) {
  const marker = `key: "${key}"`
  const from = text.indexOf(marker)
  if (from === -1) return null
  const next = text.indexOf('key: "', from + marker.length)
  return text.slice(from, next === -1 ? text.length : next)
}

/**
 * Recursively collect `file:line` hits of `re` under `<root>/<dir>`, skipping
 * `skip` paths (relative to root) and non-.js files.
 * @param {string} root
 * @param {{dir: string, skip?: string[], re: RegExp}} spec
 * @returns {string[]}
 */
export function scanPluginFiles(root, { dir, skip = [], re }) {
  const skipped = new Set(skip)
  const hits = []
  const walk = (absDir) => {
    for (const name of readdirSync(absDir)) {
      const abs = join(absDir, name)
      const st = statSync(abs)
      if (st.isDirectory()) { walk(abs); continue }
      if (!name.endsWith('.js')) continue
      const rel = relative(root, abs).split(sep).join('/')
      if (skipped.has(rel)) continue
      const lines = readFileSync(abs, 'utf8').split('\n')
      for (let i = 0; i < lines.length; i++) {
        // fresh lastIndex per line (the regex may carry /g)
        const flags = re.flags.replace('g', '')
        if (new RegExp(re.source, flags).test(lines[i])) hits.push(`${rel}:${i + 1}`)
      }
    }
  }
  walk(join(root, dir))
  return hits
}



// ---------------------------------------------------------------------------
// Minimal asar reader (header: u32LE@12 = header size; data starts at 17 + it)
// ---------------------------------------------------------------------------
function openAsar(file) {
  const fd = openSync(file, 'r')
  const head = Buffer.alloc(16)
  readSync(fd, head, 0, 16, 0)
  const headerSize = head.readUInt32LE(12)
  const headerBuf = Buffer.alloc(headerSize)
  readSync(fd, headerBuf, 0, headerSize, 16)
  const tree = JSON.parse(headerBuf.toString('utf8').replace(/\0+$/, ''))
  const dataStart = 17 + headerSize
  const entries = new Map()
  const walk = (node, prefix) => {
    for (const [name, value] of Object.entries(node.files || {})) {
      const path = `${prefix}/${name}`
      if (value.files) walk(value, path)
      else entries.set(path, value)
    }
  }
  walk(tree, '')
  return {
    read(path) {
      const entry = entries.get(path)
      if (!entry) return null
      const buf = Buffer.alloc(entry.size)
      readSync(fd, buf, 0, entry.size, dataStart + Number(entry.offset))
      return buf.toString('utf8')
    },
    close() { closeSync(fd) },
  }
}

// ---------------------------------------------------------------------------
// Host file paths inside the asar
// ---------------------------------------------------------------------------
const SESSION = '/node_modules/@deepseek-ai/dsh-session/lib/index.js'
const SESSION_TYPES = '/node_modules/@deepseek-ai/dsh-session/lib/types/index.js'
const DSH_AGENT = '/node_modules/@deepseek-ai/dsh-agent/lib/index.js'
const INBOX = '/node_modules/@deepseek-ai/dsh-agent/lib/types/inbox.js'
const AGENT_LOOP = '/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js'
const TOKEN_METER = '/node_modules/@deepseek-ai/dsh-token-meter/lib/index.js'
const SESSION_TITLE = '/node_modules/@deepseek-ai/dsh-session-title/lib/index.js'
const WEB_SERVER = '/node_modules/@deepseek-ai/dsh-host-webserver/lib/index.js'
const FS_LOCAL = '/node_modules/@deepseek-ai/dsh-fs-local/lib/index.js'
const FS_SANDBOX = '/node_modules/@deepseek-ai/dsh-fs-sandbox/lib/index.js'
const SUBPROCESS_LOCAL = '/node_modules/@deepseek-ai/dsh-subprocess-local/lib/index.js'
const SANDBOX_POLICY = '/node_modules/@deepseek-ai/dsh-sandbox-policy/lib/index.js'
const JOBS_LOCAL = '/node_modules/@deepseek-ai/dsh-jobs-local/lib/index.js'
const SESSION_PROJECTION = '/node_modules/@deepseek-ai/dsh-session-projection/lib/index.js'
const SESSION_QUERY = '/node_modules/@deepseek-ai/dsh-session-query/lib/index.js'
const STORAGE_DOMAIN = '/node_modules/@deepseek-ai/dsh-storage-domain/lib/index.js'
const UI_CONVERSATION = '/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js'
const UI_CHAT = '/node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js'
const UI_RENDERER = '/node_modules/@deepseek-ai/dsh-client-ui-renderer/lib/client.js'
const CLIENT_LOCALE = '/node_modules/@deepseek-ai/dsh-client-locale/lib/client.js'
// Service registration files (service names come from super(ctx,"X"), NOT from
// the host bundle's patch line ids — see review-independent §8.7).
const DSH_FS = '/node_modules/@deepseek-ai/dsh-fs/lib/index.js'
const DSH_SUBPROCESS = '/node_modules/@deepseek-ai/dsh-subprocess/lib/index.js'
const DSH_JOBS = '/node_modules/@deepseek-ai/dsh-jobs/lib/index.js'
// Client-side Session controller + its service (the class the plugin's
// `ctx.get('sessions').binding(id).session` returns; review HIGH-1/HIGH-2).
const API_SESSION = '/node_modules/@deepseek-ai/dsh-api-session-controller/lib/types/client/sessions/session.js'
const API_SESSIONS_SERVICE = '/node_modules/@deepseek-ai/dsh-api-session-controller/lib/types/client/sessions/service.js'
const CLIENT_LOCALE_PKG = '/node_modules/@deepseek-ai/dsh-client-locale/package.json'
const CLIENT_UI_CONVERSATION_PKG = '/node_modules/@deepseek-ai/dsh-client-ui-conversation/package.json'
// Host slot contract catalog (the authoritative standardProps list for a slot).
const CLIENT_RUNNER = '/node_modules/@deepseek-ai/dsh-cordis-client-runner/lib/client.js'

// ---------------------------------------------------------------------------
// Declarative contract table
//
//   kind: 'present' → the member MUST be in the file (we read it)
//         'absent'  → the member MUST NOT be there (the old, removed member)
//   usedBy        → where this plugin reads it (failure points the reader here)
//   scope         → slice one class body out before matching (see scopedSlice)
//   entry         → slice one slot-catalog entry before matching (see entrySlice)
//   member        → match by declaration form (declaresMember) AND bolt-on form
//                   (declaresMemberBoltOn, whole file); absent-only
//   plugin        → scan the plugin's own tree (see scanPluginFiles) instead of asar
//
// COUNT DISCIPLINE: the total is `CHECKS.length`. The breakdown is printed in the
// summary as `N present + M absent`. Do NOT count with `grep` on the `kind:` field:
// this comment block (and the notes below) also contain those literals, so grep
// over-counts and the number drifts whenever a comment changes — trust the printed
// breakdown. (review-independent-3 §8.3 hit the same 75-vs-74 class of discrepancy.)
// ---------------------------------------------------------------------------
const CHECKS = [
  // ── Session read API (the 2.0.9 replacement for the removed `events`) ─────
  { kind: 'present', id: 'session.snapshotEvents', file: SESSION, re: /^\s+snapshotEvents\(/m, what: 'Session.snapshotEvents()', usedBy: 'lib/host-compat.js:sessionEvents' },
  { kind: 'present', id: 'session.eventAt', file: SESSION, re: /^\s+eventAt\(seq\)\s*\{/m, what: 'Session.eventAt(seq)', usedBy: 'lib/host-compat.js:eventAt' },
  { kind: 'present', id: 'session.ownEvents', file: SESSION, re: /^\s+ownEvents\(\)\s*\{/m, what: 'Session.ownEvents()', usedBy: '备查(继承事件边界)' },
  { kind: 'present', id: 'session.isOwnSeq', file: SESSION, re: /^\s+isOwnSeq\(seq\)\s*\{/m, what: 'Session.isOwnSeq(seq)', usedBy: '备查' },
  { kind: 'present', id: 'session.id', file: SESSION, re: /get id\(\)\s*\{/, what: 'Session.id getter', usedBy: 'lib/index.js, lib/watchdog.js, lib/versioning.js, lib/prewrite-guard.js' },
  { kind: 'present', id: 'session.seq', file: SESSION, re: /get seq\(\)\s*\{/, what: 'Session.seq getter', usedBy: 'lib/host-compat.js 语义基准(seq 索引)' },
  { kind: 'present', id: 'session.header', file: SESSION, re: /^\s+header;/m, what: 'Session.header field', usedBy: 'lib/rollback.js:80 (header.cwd), lib/index.js, lib/versioning.js' },
  { kind: 'present', id: 'session.header.cwd', file: SESSION, re: /cwd: meta\.cwd/, what: 'session.header.cwd written into the header at construction', usedBy: 'lib/rollback.js:81, lib/index.js:311,405, lib/versioning.js:81,124,372,397' },
  // runtime read of the same member (host fork path) — same shape the plugin uses
  // (`session.header?.cwd`). Kept separate so the header-construction assertion
  // cannot be satisfied by the input validator alone (review-independent-2 §2.2(c)).
  { kind: 'present', id: 'session.header.cwd.read', file: SESSION, re: /liveSource\.header\.cwd/, what: 'runtime read of session.header.cwd', usedBy: 'lib/rollback.js:81, lib/index.js:311,405, lib/versioning.js:81,124,372,397' },
  { kind: 'present', id: 'session.append', file: SESSION, re: /^\s+append\(type, data/m, what: 'Session.append(type, data, ...)', usedBy: 'lib/adapter/dsh-writer.js, lib/index.js:327' },
  // reverse: Session has no `sessionId` — the plugin's `?? session.sessionId` fallback
  // (lib/index.js:387) is a dead branch for a measured host.
  { kind: 'absent', id: 'session.sessionId (never existed)', file: SESSION, scope: SESSION_CLASS, member: 'sessionId', what: 'Session.sessionId must NOT exist', usedBy: 'lib/index.js:387 dead fallback (id is the only id)', hint: '若宿主新增 sessionId,核实语义再迁移;不要把它当 id 的别名' },
  // ── session.surface (was the "silent degradation" suspect; confirmed present) ──
  { kind: 'present', id: 'session.surface', file: SESSION, re: /get surface\(\)\s*\{/, what: 'Session.surface getter', usedBy: 'lib/host-core.js, lib/rollback.js:92' },
  { kind: 'present', id: 'session.surface.nodes', file: SESSION, re: /get nodes\(\)\s*\{/, what: 'SurfaceManager.nodes getter (number[])', usedBy: 'lib/host-core.js:249,331,545,674; lib/prewrite-guard.js:106' },

  // ── sessions service (SessionStore) ────────────────────────────────────────
  { kind: 'present', id: 'sessions.get', file: SESSION, re: /^\s+get\(id\)\s*\{/m, what: 'SessionStore.get(id)', usedBy: 'lib/host-core.js:180, lib/rollback.js:61, lib/versioning.js, lib/watchdog.js' },
  { kind: 'present', id: 'sessions.list', file: SESSION, re: /^\s+list\(\)\s*\{/m, what: 'SessionStore.list() → Session[]', usedBy: 'lib/host-compat.js:sessionIds (close-guard / interrupt-guard 枚举)' },
  { kind: 'present', id: 'sessions.flush', file: SESSION, re: /async flush\(session\)\s*\{/, what: 'SessionStore.flush(session)', usedBy: 'lib/host-core.js:412, lib/rollback.js:283' },
  // reverse: measured hosts (0.1.0-rc.7 and 0.1.5-rc.1) have no values()/keys().
  // The plugin keeps them as DEFENSIVE old-host fallbacks; these assertions record
  // that neither is the contract of a measured host (review A3/A4/LOW-2/LOW-3).
  { kind: 'absent', id: 'sessions.values (never existed)', file: SESSION, scope: SESSION_STORE_CLASS, member: 'values', what: 'SessionStore.values() must NOT exist', usedBy: 'lib/index.js:387 dead fallback (list() is the enumerator)', hint: 'keep the fallback for unmeasured hosts, but do not treat it as a live API' },
  { kind: 'absent', id: 'sessions.keys (never existed)', file: SESSION, scope: SESSION_STORE_CLASS, member: 'keys', what: 'SessionStore.keys() must NOT exist', usedBy: 'lib/host-compat.js:sessionIds defensive keys() fallback', hint: 'list() is the measured enumeration API; keys() is a defensive shape only' },

  // ── agents service + Agent object ─────────────────────────────────────────
  { kind: 'present', id: 'agents.get', file: DSH_AGENT, re: /^\s+get\(id\)\s*\{/m, what: 'AgentRegistry.get(id)', usedBy: 'lib/host-core.js:451,484,533; lib/close-guard.js:100,119' },
  { kind: 'present', id: 'agents.list', file: DSH_AGENT, re: /^\s+list\(\)\s*\{/m, what: 'AgentRegistry.list()', usedBy: '备查' },
  { kind: 'present', id: 'agent.status', file: AGENT_LOOP, re: /get status\(\)\s*\{/, what: "Agent.status getter ('idle'|'running')", usedBy: 'lib/host-core.js:197, lib/close-guard.js:34' },
  { kind: 'present', id: 'agent.followup', file: AGENT_LOOP, re: /^\s+followup\(/m, what: 'Agent.followup(message)', usedBy: 'lib/host-core.js:515,603' },
  { kind: 'present', id: 'agent.cancel', file: AGENT_LOOP, re: /^\s+cancel\(cause/m, what: 'Agent.cancel(cause)', usedBy: 'lib/host-core.js:203' },
  { kind: 'present', id: 'agent.whenIdle', file: AGENT_LOOP, re: /^\s+async whenIdle\(\)/m, what: 'Agent.whenIdle()', usedBy: 'lib/host-core.js:204' },
  { kind: 'present', id: 'agent.inbox', file: AGENT_LOOP, re: /^\s+inbox;/m, what: 'Agent.inbox field', usedBy: 'lib/close-guard.js:39-47 (hasPending/nextTurn/nextStep)' },
  // Inbox is asserted in BOTH locations on purpose (review INFO-1): the types file
  // is the parallel declaration, while the RUNTIME object is ReactLoopInbox in
  // dsh-agent-loop (this.inbox = new ReactLoopInbox(...)). They agree today; pin
  // both so a rename in either place fails loudly.
  { kind: 'present', id: 'inbox.hasPending', file: INBOX, re: /get hasPending\(\)/, what: 'Inbox.hasPending (declared type)', usedBy: 'lib/close-guard.js:42' },
  { kind: 'present', id: 'inbox.nextTurn', file: INBOX, re: /get nextTurn\(\)/, what: 'Inbox.nextTurn (declared type)', usedBy: 'lib/close-guard.js:44' },
  { kind: 'present', id: 'inbox.nextStep', file: INBOX, re: /get nextStep\(\)/, what: 'Inbox.nextStep (declared type)', usedBy: 'lib/close-guard.js:45' },
  { kind: 'present', id: 'agentLoopInbox.hasPending', file: AGENT_LOOP, re: /get hasPending\(\)/, what: 'ReactLoopInbox.hasPending (runtime object)', usedBy: 'lib/close-guard.js:42' },
  { kind: 'present', id: 'agentLoopInbox.nextTurn', file: AGENT_LOOP, re: /get nextTurn\(\)/, what: 'ReactLoopInbox.nextTurn (runtime object)', usedBy: 'lib/close-guard.js:44' },
  { kind: 'present', id: 'agentLoopInbox.nextStep', file: AGENT_LOOP, re: /get nextStep\(\)/, what: 'ReactLoopInbox.nextStep (runtime object)', usedBy: 'lib/close-guard.js:45' },

  // ── service NAMES the plugin injects / resolves (review A5) ───────────────
  // A wrong service name makes the plugin fiber permanently pending (client boot
  // failure) or ctx.get() return undefined — this class of incident already
  // happened in this repo (conversationEvents / dsh-client-runtime).
  //
  // ⚠️ 防重踩（review-independent §8.7 假警报）:服务名一律取自 `super(ctx,"X")`
  // 字面量（或 `ctx.provide("X")`），**不是**宿主 bundle 里那一行的 `id`。
  // 例:宿主 bundle 有 `id: sandbox` 的行,而真正的服务名是 sandboxPolicy
  // （`dsh-sandbox-policy` 的 `super(ctx, "sandboxPolicy")`）。曾据 bundle 行 id
  // 误判 `inject: ['sandboxPolicy']` 不成立。改 inject 前先在本闸门查 `super(ctx,"X")`。
  { kind: 'present', id: 'service.sessions', file: SESSION, re: /super\(ctx, "sessions"\)/, what: 'service "sessions"', usedBy: 'lib/index.js:126 inject' },
  { kind: 'present', id: 'service.agents', file: DSH_AGENT, re: /super\(ctx, "agents"\)/, what: 'service "agents"', usedBy: 'lib/index.js:126 inject' },
  { kind: 'present', id: 'service.webServer', file: WEB_SERVER, re: /super\(ctx, "webServer"\)/, what: 'service "webServer"', usedBy: 'lib/index.js:126 inject; ctx.get("webServer")' },
  { kind: 'present', id: 'service.fs', file: DSH_FS, re: /super\(ctx, "fs"\)/, what: 'service "fs"', usedBy: 'lib/index.js:126 inject' },
  { kind: 'present', id: 'service.subprocess', file: DSH_SUBPROCESS, re: /super\(ctx, "subprocess"\)/, what: 'service "subprocess"', usedBy: 'lib/index.js:126 inject' },
  { kind: 'present', id: 'service.sandboxPolicy', file: SANDBOX_POLICY, re: /super\(ctx, "sandboxPolicy"\)/, what: 'service "sandboxPolicy"', usedBy: 'lib/index.js:126 inject' },
  { kind: 'present', id: 'service.jobs', file: DSH_JOBS, re: /super\(ctx, "jobs"\)/, what: 'service "jobs"', usedBy: 'lib/index.js:126 inject' },
  { kind: 'present', id: 'service.tokenMeter', file: TOKEN_METER, re: /super\(ctx, "tokenMeter"\)/, what: 'service "tokenMeter"', usedBy: 'lib/index.js:151 ctx.get("tokenMeter")' },
  { kind: 'present', id: 'service.sessionTitle', file: SESSION_TITLE, re: /super\(ctx, "sessionTitle"\)/, what: 'service "sessionTitle"', usedBy: 'lib/index.js:323 ctx.get("sessionTitle")' },
  { kind: 'present', id: 'package.clientLocale', file: CLIENT_LOCALE_PKG, re: /"name": "@deepseek-ai\/dsh-client-locale"/, what: 'client inject package @deepseek-ai/dsh-client-locale', usedBy: 'package.json dsh.client.inject' },
  { kind: 'present', id: 'package.clientUiConversation', file: CLIENT_UI_CONVERSATION_PKG, re: /"name": "@deepseek-ai\/dsh-client-ui-conversation"/, what: 'client inject package @deepseek-ai/dsh-client-ui-conversation', usedBy: 'package.json dsh.client.inject' },

  // ── services resolved via ctx.get(...) / ctx.<service> ────────────────────
  { kind: 'present', id: 'tokenMeter.measure', file: TOKEN_METER, re: /^\s+measure\(session/m, what: 'tokenMeter.measure(session, header)', usedBy: 'lib/adapter/dsh-writer.js:priceBySurface' },
  { kind: 'present', id: 'tokenMeter.estimateMessage', file: TOKEN_METER, re: /^\s+estimateMessage\(message\)/m, what: 'tokenMeter.estimateMessage(message)', usedBy: 'lib/adapter/dsh-writer.js:priceByNode' },
  { kind: 'present', id: 'sessionTitle.rename', file: SESSION_TITLE, re: /^\s+rename\(session, title\)/m, what: 'sessionTitle.rename(session, title)', usedBy: 'lib/index.js:325' },
  { kind: 'present', id: 'webServer.register', file: WEB_SERVER, re: /^\s+register\(route\)/m, what: 'webServer.register(route)', usedBy: 'lib/index.js:269' },
  { kind: 'present', id: 'fs.resolve', file: FS_LOCAL, re: /^\s+async resolve\(path/m, what: 'fs.resolve(path, opts)', usedBy: 'lib/rollback.js, lib/versioning.js, lib/git-adapter.js' },
  { kind: 'present', id: 'fs.contains', file: FS_LOCAL, re: /^\s+contains\(parent, child\)/m, what: 'fs.contains(parent, child)', usedBy: 'lib/rollback.js:109, lib/versioning.js:86' },
  { kind: 'present', id: 'fs.stat', file: FS_LOCAL, re: /^\s+async stat\(target/m, what: 'fs.stat(target, signal)', usedBy: 'lib/rollback.js:192' },
  { kind: 'present', id: 'fs.readBytes', file: FS_LOCAL, re: /^\s+async readBytes\(target/m, what: 'fs.readBytes(target, signal, maxBytes)', usedBy: 'lib/versioning.js:87' },
  // 5-arg form the plugin calls: (target, content, expected, signal, sandboxPolicy)
  { kind: 'present', id: 'fs.writeText', file: FS_SANDBOX, re: /async writeText\(target, content, expected, signal, sandboxPolicy\)/, what: 'fs-sandbox writeText(..., sandboxPolicy)', usedBy: 'lib/rollback.js:196, lib/git-adapter.js:61' },
  { kind: 'present', id: 'subprocess.spawn', file: SUBPROCESS_LOCAL, re: /^\s+spawn\(spec\)/m, what: 'subprocess.spawn(spec)', usedBy: 'lib/rollback.js:171, lib/git-adapter.js:35' },
  { kind: 'present', id: 'subprocess.resolveExecutable', file: SUBPROCESS_LOCAL, re: /^\s+async resolveExecutable\(command/m, what: 'subprocess.resolveExecutable(command)', usedBy: 'lib/git-adapter.js:34' },
  { kind: 'present', id: 'sandboxPolicy.resolve', file: SANDBOX_POLICY, re: /^\s+resolve\(request/m, what: 'sandboxPolicy.resolve(request)', usedBy: 'lib/rollback.js:195' },
  { kind: 'present', id: 'jobs.list', file: JOBS_LOCAL, re: /^\s+list\(caller\)/m, what: 'jobs.list(caller)', usedBy: 'lib/close-guard.js:77-79' },
  { kind: 'present', id: 'sessionProjections.register', file: SESSION_PROJECTION, re: /^\s+register\(definition\)/m, what: 'sessionProjections.register(definition)', usedBy: 'lib/versioning.js:229,231' },
  { kind: 'present', id: 'sessionProjections.onChanged', file: SESSION_PROJECTION, re: /^\s+onChanged\(listener\)/m, what: 'sessionProjections.onChanged(listener)', usedBy: 'lib/versioning.js:233' },
  { kind: 'present', id: 'sessionProjections.snapshot', file: SESSION_PROJECTION, re: /^\s+snapshot\(session, keys\)/m, what: 'sessionProjections.snapshot(session, keys)', usedBy: 'lib/versioning.js:286' },
  { kind: 'present', id: 'sessionQuery.readEvent', file: SESSION_QUERY, re: /^\s+async readEvent\(request/m, what: 'sessionQuery.readEvent(request)', usedBy: 'lib/versioning.js:299' },
  { kind: 'present', id: 'sessionQuery.readSurface', file: SESSION_QUERY, re: /^\s+async readSurface\(sessionId\)/m, what: 'sessionQuery.readSurface(sessionId)', usedBy: 'lib/versioning.js:309' },
  { kind: 'present', id: 'storageDomain.open', file: STORAGE_DOMAIN, re: /^\s+async open\(spec\)/m, what: 'storageDomain.open(spec)', usedBy: 'lib/versioning.js:244' },
  { kind: 'present', id: 'storageDomain.table', file: STORAGE_DOMAIN, re: /^\s+table\(name\)/m, what: 'storageDomain.table(name)', usedBy: 'lib/versioning.js:90,128,196,344,364' },
  { kind: 'present', id: 'storageDomain.close', file: STORAGE_DOMAIN, re: /^\s+close\(\)/m, what: 'storageDomain.close()', usedBy: 'lib/versioning.js:250' },

  // ── cordis event + client-side services ───────────────────────────────────
  { kind: 'present', id: 'event.session/event', file: SESSION, re: /invokeContainedSessionObservers\(entry\.emitCtx, "session\/event"/, what: 'session/event emission', usedBy: 'lib/watchdog.js:113 (ctx.on)' },
  { kind: 'present', id: 'client.slots', file: UI_RENDERER, re: /super\(ctx, "slots"\)/, what: 'client service "slots"', usedBy: 'lib/client.js:35 inject' },
  { kind: 'present', id: 'client.locale', file: CLIENT_LOCALE, re: /ctx\.provide\("locale"/, what: 'client service "locale"', usedBy: 'lib/client.js:35 inject' },
  { kind: 'present', id: 'client.uiConversation', file: UI_CONVERSATION, re: /super\(ctx, "uiConversation"\)/, what: 'client service "uiConversation"', usedBy: 'lib/client.js:conversationRegistrar' },
  { kind: 'present', id: 'client.uiConversation.events.register', file: UI_CONVERSATION, re: /ConversationEventRegistry[\s\S]{0,500}?register\(definition\)/, what: 'uiConversation.events.register (official entry)', usedBy: 'lib/client.js:conversationRegistrar (.events.register first)' },
  { kind: 'present', id: 'client.useChat.nodes', file: UI_CHAT, re: /useChat\(\(s\) => s\.nodes\)/, what: 'useChat(s => s.nodes) official shape', usedBy: 'lib/client.js (node lookup; previous snapshot.chat.nodes drift)' },

  // ── client-side Session CONTROLLER (review HIGH-1/HIGH-2) ─────────────────
  // `lib/client.js` reads `ctx.get('sessions').binding(id).session` and then
  // getSnapshot()/loadOlder/hasMore/rename. That whole object class was missing
  // from the first audit table AND the first gate — the HIGH-1 break
  // (`getSnapshot()?.chat?.nodes`, always undefined) lived in exactly this gap.
  { kind: 'present', id: 'client.sessions.binding', file: API_SESSIONS_SERVICE, re: /^\s+binding\(id\)\s*\{/m, what: 'client sessions service binding(id)', usedBy: 'lib/client.js:2482,2495' },
  { kind: 'present', id: 'clientSession.getSnapshot', file: API_SESSION, re: /getSnapshot\(\)\s*\{/, what: 'client Session.getSnapshot()', usedBy: 'lib/client.js:1391,1405,1407' },
  { kind: 'present', id: 'clientSession.loadOlder', file: API_SESSION, re: /async loadOlder\(\)\s*\{/, what: 'client Session.loadOlder()', usedBy: 'lib/client.js pagination' },
  { kind: 'present', id: 'clientSession.loadThrough', file: API_SESSION, re: /loadThrough\(seq\)\s*\{/, what: 'client Session.loadThrough(seq) (official jump loader)', usedBy: 'recommended replacement for the HIGH-1 jump path' },
  { kind: 'present', id: 'clientSession.hasMore', file: API_SESSION, re: /^\s+hasMore = false;/m, what: 'client Session.hasMore field', usedBy: 'lib/client.js:1400' },
  { kind: 'present', id: 'clientSession.rename', file: API_SESSION, re: /async rename\(title\)\s*\{/, what: 'client Session.rename(title)', usedBy: 'lib/client.js session rename' },
  { kind: 'present', id: 'clientSession.sessionId', file: API_SESSION, re: /^\s+sessionId;/m, what: 'client Session.sessionId field', usedBy: 'client session identity' },
  // Anchored to the host slot CONTRACT CATALOG (review-independent-2 §2.2(b)):
  // the bare string `/useProjection/` hit 11 unrelated places (first hit in a
  // class the plugin never touches). What the plugin depends on is that the
  // `conversation.view` entry's `standardProps` list carries useChat +
  // useProjection — both are injected as view props (lib/client.js view slots).
  // Structural bound: the `conversation.view` catalog entry is sliced to the next
  // `key: "` (not a character window — review-independent-3 §4.3).
  { kind: 'present', id: 'client.conversationView.standardProps', file: CLIENT_RUNNER, entry: 'conversation.view', re: /standardProps: \[[\s\S]*?"useChat: UseChat"[\s\S]*?"useProjection: UseProjection"/, what: 'conversation.view standardProps contains useChat + useProjection', usedBy: 'lib/client.js view slot props (useChat / useProjection)' },
  // reverse: the controller has no getTitle/chat/nodes member — so
  // `store.getTitle(...)` is a dead branch and `getSnapshot()?.chat?` can never
  // resolve on this host (HIGH-1). Recorded so a future rename is visible.
  { kind: 'absent', id: 'clientSession.getTitle (never existed)', file: API_SESSION, member: 'getTitle', what: 'client Session.getTitle must NOT exist', usedBy: 'lib/client.js:1852,1924 dead branch (typeof-guarded)', hint: 'title comes from rename()/projection, not from the controller' },
  { kind: 'absent', id: 'clientSession.chat (never existed)', file: API_SESSION, member: 'chat', what: 'client Session.chat must NOT exist', usedBy: 'HIGH-1 was getSnapshot()?.chat?.nodes — undefined on this host', hint: '取节点用 store.loadThrough(seq) 或 slot 的 useChat(s=>s.nodes)' },
  { kind: 'absent', id: 'clientSession.nodes (never existed)', file: API_SESSION, member: 'nodes', what: 'client Session.nodes must NOT exist', usedBy: 'same as above', hint: '同 clientSession.chat' },

  // ── reverse assertions: removed members must stay removed ─────────────────
  { kind: 'absent', id: 'Session.events (removed)', file: SESSION, scope: SESSION_CLASS, member: 'events', what: 'Session.events must NOT exist', usedBy: 'all reads must go through lib/host-compat.js (sessionEvents/eventAt)', hint: '若宿主恢复同名成员,先核实语义再迁移;直读会让 host-compat 之外的代码重新漂移' },
  { kind: 'absent', id: 'Session.events (removed, bundled copy)', file: SESSION_TYPES, scope: SESSION_CLASS_TYPES, member: 'events', what: 'Session.events must NOT exist (second bundled copy)', usedBy: '同上', hint: '同 SESSION' },

  // ── plugin-side invariant (review-independent-3 §2.4.2 / §9.2) ────────────
  // Enumerating host-side resurrection forms can never be exhaustive. The
  // finite, 100%-pinnable direction is the plugin's own side: ONLY the compat
  // layer may READ the legacy event view. `lib/dynamic-host.js` is exempt
  // because it is the generated inline copy of `lib/host-compat.js` (the build
  // contract: scripts/generate-dynamic.mjs).
  //
  // The pattern targets VALUE-READING forms (`session.events`,
  // `session?.events.length/[0]/?? …`, `session['events']`). A bare guarded
  // existence PROBE (`Array.isArray(session?.events)`, `typeof session?.events`)
  // is allowed on purpose: it cannot throw, it is how dsh-writer/watchdog decide
  // whether a legacy view exists (their actual read goes through sessionEvents),
  // and tightening it further would require editing lib/ — out of scope here.
  { kind: 'absent', id: 'plugin.no-session-events-read', plugin: { dir: 'lib', skip: ['lib/host-compat.js', 'lib/dynamic-host.js'], re: /\bsession\s*\.\s*events\b|\bsession\s*\?\.\s*events\s*(?:\.|\[|\?\?|\|\||&&)|\bsession\s*\[\s*['"]events['"]\s*\]/ }, what: 'no session.events value-read outside lib/host-compat.js', usedBy: 'lib/host-compat.js:sessionEvents is the only sanctioned legacy read', hint: '任何新的直读都会在 2.0.9 宿主上抛 TypeError;走 sessionEvents()/eventAt()' },
]

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
function readPackageVersion(reader, path) {
  const raw = reader.read(path)
  if (raw === null) return '?'
  try { return JSON.parse(raw).version ?? '?' } catch { return '?' }
}

function main() {
  // DSH Desktop runs package scripts under Electron's Node, whose asar FS
  // wrapper hijacks every path ending in `.asar` (openSync on the archive
  // itself becomes "read an entry inside it" → ENOENT). `process.noAsar`
  // makes fs treat it as a plain file again. Harmless in plain Node.
  const prevNoAsar = process.noAsar
  process.noAsar = true
  try {
    if (!existsSync(ASAR)) {
      console.log(`host-contract: SKIP — 未找到 app.asar: ${ASAR}`)
      console.log('host-contract: (设置 DSH_ASAR 指向 DSH Desktop 的 app.asar 可启用本闸门;无 Desktop 的 CI 视为跳过)')
      return 0
    }
    const reader = openAsar(ASAR)
    try {
      const desktop = readPackageVersion(reader, '/package.json')
      const session = readPackageVersion(reader, '/node_modules/@deepseek-ai/dsh-session/package.json')
      console.log(`host-contract: DSH Desktop ${desktop} · @deepseek-ai/dsh-session ${session}`)
      console.log(`host-contract: asar = ${ASAR}`)
      console.log('')

      let failed = 0
      const presentCount = CHECKS.filter((c) => c.kind === 'present').length
      const absentCount = CHECKS.length - presentCount
      for (const check of CHECKS) {
        // ── plugin-side invariant: scans the LOCAL plugin tree, not the asar ──
        if (check.plugin) {
          let hits
          try {
            hits = scanPluginFiles(REPO_ROOT, check.plugin)
          } catch (error) {
            failed += 1
            console.log(`❌ ${check.id} — 插件源码扫描失败: ${String(error)}`)
            console.log(`     我方使用点: ${check.usedBy}`)
            continue
          }
          const ok = check.kind === 'present' ? hits.length > 0 : hits.length === 0
          if (ok) {
            console.log(`✅ ${check.id} — ${check.what}`)
            continue
          }
          failed += 1
          console.log(`❌ ${check.id} — ${check.what}`)
          console.log(`     插件: ${hits.join(', ')}`)
          console.log(`     期望: ${check.kind === 'present' ? '存在' : '不存在(插件侧不变量)'}`)
          console.log(`     我方使用点: ${check.usedBy}`)
          if (check.hint) console.log(`     建议: ${check.hint}`)
          continue
        }

        const raw = reader.read(check.file)
        if (raw === null) {
          failed += 1
          console.log(`❌ ${check.id} — 宿主文件不在 asar: ${check.file}`)
          console.log(`     期望: ${check.what}`)
          console.log(`     我方使用点: ${check.usedBy}`)
          continue
        }
        let source = raw
        if (check.scope) {
          const sliced = scopedSlice(raw, check.scope)
          if (sliced === null) {
            // The scope markers are gone: the assertion can no longer be evaluated,
            // so it is drift in itself (never silently pass).
            failed += 1
            console.log(`❌ ${check.id} — 作用域标记漂移(找不到 ${JSON.stringify(check.scope.start)} … ${JSON.stringify(check.scope.end)})`)
            console.log(`     宿主: ${check.file}`)
            console.log(`     我方使用点: ${check.usedBy}`)
            continue
          }
          source = sliced
        } else if (check.entry) {
          const sliced = entrySlice(raw, check.entry)
          if (sliced === null) {
            failed += 1
            console.log(`❌ ${check.id} — 契约目录条目缺失(找不到 key: "${check.entry}")`)
            console.log(`     宿主: ${check.file}`)
            console.log(`     我方使用点: ${check.usedBy}`)
            continue
          }
          source = sliced
        }
        // absent member checks scan BOTH the (scoped) slice and the whole file:
        // bolt-on forms such as Object.assign(X.prototype, {member…}) live outside
        // the class body, so slicing alone would hide them (review-3 §2.2 E3).
        const hit = check.member
          ? (declaresMember(source, check.member) || declaresMemberBoltOn(raw, check.member))
          : check.re.test(source)
        const ok = check.kind === 'present' ? hit : !hit
        if (ok) {
          console.log(`✅ ${check.id} — ${check.what}`)
          continue
        }
        failed += 1
        console.log(`❌ ${check.id} — ${check.what}`)
        console.log(`     宿主: ${check.file}${check.scope ? ' (作用域内)' : ''}${check.entry ? ` (条目 ${check.entry})` : ''}${check.member ? ' + 整文件 bolt-on 扫描' : ''}`)
        console.log(`     期望: ${check.kind === 'present' ? '存在' : `不存在(已移除成员不得复活${check.member ? `: ${check.member}` : ''})`}`)
        console.log(`     我方使用点: ${check.usedBy}`)
        if (check.hint) console.log(`     建议: ${check.hint}`)
      }

      console.log('')
      const breakdown = `${presentCount} present + ${absentCount} absent`
      if (failed > 0) {
        console.log(`host-contract: ${CHECKS.length - failed} ok, ${failed} FAILED (${breakdown}) —— 宿主契约漂移,先修再发`)
        return 1
      }
      console.log(`host-contract: ${CHECKS.length} ok, 0 failed (${breakdown}) —— 宿主契约面与审计基线一致`)
      return 0
    } finally {
      reader.close()
    }
  } finally {
    process.noAsar = prevNoAsar
  }
}

const isMain = (() => {
  const entry = process.argv[1]
  if (!entry) return false
  try { return realpathSync(resolve(entry)) === realpathSync(fileURLToPath(import.meta.url)) } catch { return false }
})()

if (isMain) process.exit(main())
