<div align="center">

# 🧭 dsh-retrace

**Recall · Edit-and-resend · Regenerate**, plus **write-safe** in-conversation
versioning — the **Agent business layer (production-grade guarantees)** for
DeepSeek Harness.

[![npm version](https://img.shields.io/npm/v/dsh-retrace)](https://www.npmjs.com/package/dsh-retrace)
[![npm downloads](https://img.shields.io/npm/dm/dsh-retrace)](https://www.npmjs.com/package/dsh-retrace)
[![License: MIT](https://img.shields.io/npm/l/dsh-retrace)](https://github.com/yamingmou/dsh-retrace/blob/main/LICENSE)
[![DSH plugin](https://img.shields.io/badge/DSH-plugin-4A90D9)](https://github.com/topics/dsh-plugin)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](https://github.com/yamingmou/dsh-retrace/pulls)

**English** · [简体中文](./README.zh.md)

</div>

**Recall / edit-and-resend / regenerate** — the three moves every conversation
deserves. But rewinding is not just "delete a message": DeepSeek Harness stores
conversations in an append-only event log, so a recall only rewinds the context
while changed **artifact files stay changed**. dsh-retrace versions the
conversation **and its artifacts** together, and keeps **every new rewind legal** —
it cannot dirty the log, and new markers create **no token-meter pairing debt**
(two-segment atomic pairs land by construction).

> ⚠️ **Honest scope (matches the companion contract's own note)**: sessions that
> already contain **legacy single-segment markers** — written by older versions —
> are **known design debt**. Before `/compact`, run the companion `check` and
> clean them up (`fix --remove-markers`); otherwise the host's own T1 self-check
> blocks compaction. New rewinds do not add to that debt.

> 🛡️ **Write safety** · 🔍 **Deep offline checks** · 🔄 **Detect → repair → guard** — see below.

---

## ⚡ One-minute install

> Requires DeepSeek Harness with the `dsh` CLI. **Restart DSH after install** (a running app does not hot-reload).

```sh
dsh plugin --profile desktop add dsh-retrace    # DSH Desktop
# or Web: dsh plugin --profile web add dsh-retrace
# or GitHub: dsh plugin --profile desktop add github:yamingmou/dsh-retrace
# or ZIP: dsh plugin --profile desktop add ~/plugins/dsh-retrace
```

**No command line?** Install the community plugin market once, then find
**dsh-retrace** in **Settings → Plugin Market** and install it with one click:

```sh
dsh plugin --profile desktop add dshmarket    # one time
```

After the restart, hover any assistant reply → **↩ / ↻**; any user message → **✎**.
Full steps in [📦 Installation](#-installation).

---

## 🛡️ Production-grade guarantees (all live in 0.4.x)

| | Capability | What it means |
|---|---|---|
| 🛡️ | **Write safety** | Every rewind passes a three-layer pre-write contract guard; running agents are auto-stopped (official `cancel`/`whenIdle`); turn-interval markers are wrapped in a temporary step — **new rewinds cannot dirty the log and add no token-meter pairing debt**; **legacy single-segment markers are known debt** (run the companion `check` + `fix --remove-markers` before `/compact`) |
| 🔍 | **Deep offline checks** | Companion `dsh-log-contract` ships 30+ contract rules (token-meter pairing / cross-step references / physical order / inbox replay), validated against real corrupted-session fixtures — it finds the class of problem that makes /compact permanently fail |
| 🔄 | **Detect → repair → guard** | A watchdog snapshots the log at the first sign of concurrent writes; offline `fix` neutralizes problem markers and clips cross-step references in place; pre-write validation stops bad events before they land |

---

## ✨ Features

| Action | Where | What happens |
| --- | --- | --- |
| **↩ Recall** | hover any assistant reply, or the row under any user message | Removes the **whole exchange round** (the input **and** the agent's output, tool rows included) from both the model context and the conversation view; the input text is echoed into the composer so you can re-ask or re-edit immediately. A small transient notice marks the rewind and disappears once you keep typing. |
| **✎ Edit & re-send** | row under any user message | The edited round is rewound and the new text is re-sent. By default **only the edited round** is replaced — earlier history stays visible; the optional "fresh conversation" setting rewinds the whole surface (earlier messages then leave the model context, and stay visible in the view as a marker notice by default). A collapsed **"original input"** reference sits right under the new message — click to expand, configurable off. |
| **↻ Regenerate** | hover any assistant reply | The reply (and everything after it) is rewound and hidden, then the original prompt is re-sent so the agent answers again. |

**Versioning & rollback (live in 0.4.x)** — every rewind is also recorded as a **version**:

| | What | |
|---|---|---|
| 🕘 | **Timeline** | a **Versions** tab in the conversation view: every version (type, time, message count, file-change badges), pushed live via `session/projection` (no polling), windowed for long histories |
| ↩️ | **Artifact rollback** | **context-only / artifacts-only / both** with dry-run preview; git-first + content-addressed snapshot fallback; the rollback is itself a new version (`restore`) |
| 🧭 | **Jump-to-conversation** | one click from a version to that point in the conversation (auto-loads history, anchor highlight) |
| 🧹 | **Bounded storage** | snapshots keep the most recent N versions (default 50); throttled background sweep prunes truncated ones |

**Why it's different** (the interaction layer — the guarantees above are the storage layer):

- 🎯 **Whole-round recall** — removes the input *and* its output (tool rows included), not just a single bubble.
- 🖥️ **Web + Desktop** — one plugin, both DeepSeek Harness surfaces.
- 🧠 **View ⇄ context in sync** — the conversation view always reflects exactly what the agent sees.
- ⚡ **Try in 30 seconds** — the dynamic form installs in your current session with no rebuild.

---

## 📦 Installation

### 1. Profile bundle (recommended)

The package declares a `dsh.bundle` manifest, so it installs through the official
plugin path into any profile:

```sh
dsh plugin --profile <name> add dsh-retrace
```

> ⚠️ **Restart required.** The install writes the new files and re-renders the
> profile composition, but a running app does **not** hot-reload bundles — quit
> and reopen **DSH Desktop** (or restart the `dsh` process for a standalone Web
> deployment) to load the plugin. To uninstall:
> `dsh plugin --profile <name> remove dsh-retrace` (then restart again).

### 2. Manual install (no `dsh` CLI)

The same result with plain file edits and `pnpm` — exactly the steps
`dsh plugin add` performs for you:

> **Downloaded this repo as a ZIP?** Unpack it somewhere stable (e.g.
> `~/plugins/dsh-retrace`), then either
> `dsh plugin --profile desktop add ~/plugins/dsh-retrace`, or follow the
> steps below with the dependency line pointing at the folder:
> `"dsh-retrace": "file:~/plugins/dsh-retrace"`.

1. Open the profile manifest (defaults: `<plugin data home>/profiles/desktop`
   on DSH Desktop, `<plugin data home>/profiles/web` for standalone Web — where
   `<plugin data home>` is `$DSH_HOME` when set, otherwise the **active session
   base**, e.g. a newer `DSH_HOME` directory; `~/.dsh/profiles` is only the
   pre-migration fallback) and add **both** the
   dependency and the bundle-layer entry:

   ```json
   {
     "dependencies": {
       "dsh-retrace": "^0.4.0"
     },
     "dsh": {
       "profile": {
         "bundles": [
           "@deepseek-ai/dsh-base",
           "@deepseek-ai/dsh-web-app",
           "dsh-retrace"
         ]
       }
     }
   }
   ```

   (Keep whatever entries your profile already has; only add the two
   `dsh-retrace` lines.)

2. Install inside the profile directory:

   ```sh
   cd "$DSH_HOME/profiles/<name>" && pnpm install   # or the active base you use
   ```

3. Restart DSH Desktop / the `dsh` process (see above).

For local development, point the dependency at a checkout instead of the
registry: `"dsh-retrace": "file:/path/to/dsh-retrace"` — or let
`dsh` do it: `dsh plugin --profile <name> add /path/to/dsh-retrace`.
For the latest GitHub commit without a release: use
`"dsh-retrace": "github:yamingmou/dsh-retrace"` (standard pnpm git
dependency syntax) in the same `dependencies` block, then `pnpm install`.

### 3. npm package + composition (classic)

```sh
npm i dsh-retrace
```

Add the package to the harness composition (`cordis.yml` of the app/deployment you use):

```yaml
- name: 'dsh-retrace'
```

The client half is picked up automatically from the package's `dsh.client` metadata and
bundled into the Web client (a client-module rebuild happens automatically when the
composition changes). The Host half registers the same-origin HTTP route
`/api/plugins/retrace/*` for the browser UI.

### 4. Dynamic plugin (current session — no install, no rebuild)

Use the **dynamic** entries shipped in the package. In the session where you want the
feature:

1. Open the plugin editor and define a new plugin from `lib/dynamic-host.js`
   (Host half) and `lib/dynamic-client.js` (Client half).
2. Approve and run the Client half.
3. Done — hover any assistant reply, or any user message, and use ↩ / ✎ / ↻.

The dynamic host registers the same operations behind the package-private
`harness.handle` RPC (`retrace.recall` / `retrace.editAndResend` /
`retrace.regenerate`).

---

## ⚙️ Settings → General

| Setting | Default | Description |
| --- | --- | --- |
| **Show the original input after editing** | on | A collapsed "original input" reference under the re-sent message showing the **most recent** replaced text (reference only — never sent to the model). |
| **Start a fresh conversation after editing** | off | Hide earlier messages too, so the conversation looks like a fresh start (the whole surface is rewound before re-sending). Default off: only the edited round's context is replaced. |
| **Hide shadowed messages per marker** | on | On (default): recall/edit/regenerate hide the replaced round per their markers. Off: every message stays visible; markers only show the notice and reference (review the full history). A single marker that would hide more than 40% of the conversation degrades to notice-only (history never silently vanishes). |
| **Version & artifact snapshots** | on | On: every recall/edit records a version (messages and touched files) powering the timeline and artifact rollback. Off: only rewinds context — no version records, no artifact tracking (lightest). |
| **Git integration** | on | On: use git to record and roll back when the workspace is a repository (never auto-commits, never touches your branches); non-repo workspaces can enable git from the timeline. Off: built-in snapshots under the plugin data home only — the plugin never touches the workspace git state; features are equivalent. |
| **Version retention limit** | 50 | File snapshots are kept for the most recent N versions; older ones are pruned automatically (timeline records and the audit trail are always kept). |

---

## 🧠 How it works

```
 durable transcript (append-only)          model context & view
 ┌─────────────────────────────────┐    ┌────────────────────┐
 │  … target message               │    │  … target message  │
 │      ↓ shadow span              │    │       ↓ rewind     │
 │  [target … last surface node]   │ ──▶│  (empty replace    │
 │      ↳ one replacement          │    │   = context cut)   │
 │        assistant/message (empty)│    └────────────────────┘
 │      ↳ optional original-input  │    agent.followup(new prompt)
 └─────────────────────────────────┘    → next turn rebuilds request
```

1. **Host core** (`lib/host-core.js`, zero runtime imports) locates the target
   message in the session's live surface, computes the shadow span
   `[message … last surface node]`, and appends one replacement
   `assistant/message` with an **empty** body — a valid surface node that
   derives to *no* model message, so the LLM context simply rewinds.
2. **Edit / regenerate** additionally call `agent.followup(...)` with the
   (new) prompt text; the agent's next turn builds its request from the
   rewound `session.deriveMessages()`.
3. **Client** (`lib/client.js`) registers:
   - a `user-actions` conversation node under every user message
     (an edit/recall row with an inline editor); recall echoes the text into the
     composer,
   - the `recall-marker` node renderer: a notice row that injects CSS hiding
     every shadowed message row from the flow (view and model context stay in
     sync), plus the optional original-input comparison block,
   - the `retrace` entry in the `conversation.chat.assistant-actions`
     strip (recall / regenerate),
   - preference toggles and the retention limit under Settings → General.

> Two different layers are at play: the **durable transcript** (append-only; old
> events are never rewritten or deleted) and the **model-visible surface** (rewound
> by an appended replacement event). So the old events stay in the log as an audit
> trail — but they are **synchronized out of both the model context and the visible
> conversation**, and the view always reflects what the agent actually sees.
> Persistence, projections and the transcript remain consistent because the plugin
> only appends valid, typed session events.

---

## 🔺 Compatibility & upgrade notes

`dsh-retrace` is a **bundle plugin**: it plugs into whatever host surface it is
installed into. A host release that *removes* a package or a client service can
therefore break an older plugin build even though nothing in that build changed —
the symptom is usually a failed boot, not a wrong-looking feature.

This section exists so you can tell **host-side breakage** from **plugin-side bugs**.
Read it before filing an issue.

### Host-side breaking changes that `0.4.26` adapts to — *not caused by this plugin*

1. **`@deepseek-ai/dsh-session` dropped `decodeStorageRecord` from its public export surface (in `0.1.5-rc.1`; the function still exists internally but is no longer exported from the package root and is unreachable via the exports map).**
   `dsh-retrace` itself never imported it, but its dependency `dsh-log-contract` did.
   With no such export the loader aborts with
   `plugin tree failed to load … does not provide an export named 'decodeStorageRecord'`
   and **the whole plugin tree fails to load — not just this plugin**, so the app does
   not start. `0.4.26` requires a `dsh-log-contract` build that decodes through its own
   local compatibility layer instead of the removed host export.
   → **Dependency note:** needs `dsh-log-contract >= 0.3.12`.
2. **A client **service** disappeared: `conversationEvents`** — it used to be provided by
   the legacy client runtime `@deepseek-ai/dsh-client-runtime`, which has been removed
   (the string `conversationEvents` no longer occurs anywhere in the host). A plugin whose
   client half still declares that service in `export const inject` never becomes ready:
   its fiber stays **pending**, which the host reports as
   `renderer boot failed (plugins: …): The client Loader did not provide an error message.`
   — no error text at all, the window does not finish starting, and the only way in is to
   disable the plugin.
   `0.4.26` drops the service from `inject` and resolves it **defensively** in `apply`
   (`uiConversation`, falling back to the legacy name), so it runs on hosts that provide
   the new service *and* on older hosts that still provide the old one.
   > Note: declaring a **package** that no longer exists in `dsh.client.inject` is *not*
   > what breaks the boot — the client loader skips unknown entries silently. The
   > breakage comes from the **service name** the plugin waits for.

> Both items above are **host-side removals**, documented here on purpose: if you hit
> either symptom right after a host upgrade, the first question is "does this plugin
> build predate the removal?", not "what did the plugin break?".

### Plugin-side fixes in `0.4.26` (these are ours)

- **Data home and session base are now one source.** The plugin previously resolved its
  own data directory through the host's home resolver (`$DSH_HOME` → `~/.dsh`), which
  does not know about a migrated base (for example a newer `DSH_HOME` directory). With
  `$DSH_HOME` unset,
  sessions were read from one base while snapshots and the artifact store were written
  to another. Snapshots, version stores and `verify-install` now follow the **active
  session base**. When `$DSH_HOME` is set, behaviour is unchanged.
- **No user-visible string hard-codes `~/.dsh` any more** (the settings hint used to say
  snapshots live under `~/.dsh`).
- Stale peer declarations with no remaining import site removed
  (`@deepseek-ai/dsh-home-paths`, `@deepseek-ai/dsh-client-runtime`).

### Host-side breaking changes that `0.4.28` adapts to — *not caused by this plugin*

1. **`@deepseek-ai/dsh-session` removed the `Session.events` member** (in `0.1.5-rc.1`).
   The class has no `events` field and no `events` getter at all any more; the supported
   readers are `snapshotEvents(fromSeq, toSeqExclusive)` (frozen, sequence-indexed),
   `eventAt(seq)`, `ownEvents()` and `isOwnSeq(seq)`. `0.4.28` reaches the log through a
   compatibility accessor that prefers the new API and falls back to the old array, so it
   runs on both host generations.
   **Symptom before the fix:** recall and edit did nothing and surfaced the raw error
   `TypeError: Cannot read properties of undefined (reading 'length')` — both operations
   start by locating the target message id, and that lookup read the removed member.
2. **The client-side session store has no `keys()`** (`ctx.sessions`). A plugin that
   enumerates sessions with `keys()` silently sees **zero** of them: no crash, no error,
   just safety warnings that never fire. `0.4.28` prefers the official `list()` and falls
   back to `keys()`; it deliberately does **not** fall back to enumerating service fields,
   because guessing produces a silent empty result as well.
3. **The client session controller has no title accessor** — `getTitle` does not exist
   anywhere in `@deepseek-ai/dsh-api-session-controller`, and its `getSnapshot()` carries
   no `title`. See the plugin-side item below: this one used to *overwrite your titles*.

### Plugin-side fixes in `0.4.28` (these are ours)

- **The edit / recall affordances never appeared at all.** The client half read chat
  nodes from `snapshot.chat.nodes`, a path this host build does not have — nodes live in
  the `useChat` store (`snapshot.nodes`). Every message-level component threw while
  rendering and was swallowed by the error boundary, so the buttons were missing, while
  the settings entry (which reads no nodes) rendered fine. Fixed: the client half now
  takes `useChat` from the slot contract.
- **"Jump to message" in the version and fork views did nothing.** It resolved the target
  anchor through `store.getSnapshot()?.chat?.nodes`, which is permanently `undefined`
  here. It now resolves through the `useChat` snapshot injected by the view and pages
  with the official `store.loadThrough(seq)`; when the jump cannot complete it reports a
  **diagnosable reason** (renderer warning + host-log line) instead of failing silently.
- **Assigning a short code could overwrite your session title.** The client composed
  `[CODE] <current title>` locally but had no way to read the current title, so the base
  degraded to the session-id prefix (`[XXXXXX] <session-id-prefix>`). Title tagging now goes
  through the host route only (`setBadgeTitle`), which reads the current title from the
  session log. Manual renames are unaffected.
- **Host-side operation failures are logged again** (code + message + stack). They used to
  return the message to the UI without a log line, which is why this whole class of bug
  was hard to diagnose from outside.

- **The version and fork views now explain themselves.** They used to show a title plus a row of
  actions with **no sentence anywhere saying what a "version" or a "fork" is** (the only near-miss
  was an empty-state line that disappears as soon as data arrives), and fork rows printed raw node
  types. They now carry an always-visible concept sentence, a type legend, and a plain-language
  "why" line on every row; impact text reads `旧路径的 N 条消息被替换`, not `被遮蔽 N 个节点`.
- **Client hide-lookup no longer rescans per row.** `useSeqHidden` re-scanned the node map for every
  row (measured **346 ms** at 2000 rows / 20 markers, **1568 ms** at 3000/30 — and that path was
  *dead* on this host until this release made the rows render at all, so it is this fix own cost).
  It now reuses one per-snapshot hide plan: **8.3 ms** and **18.3 ms** respectively, with the
  predicate verified equivalent against the old one.
### Upgrading

```bash
dsh plugin --profile desktop add dsh-retrace@0.4.30
# then restart DSH — plugins are not hot-reloaded
```

**`0.4.27` was withdrawn.** It was briefly published and then recalled — `latest` points at `0.4.26`
again and `0.4.27` is marked deprecated. **`0.4.28` is its replacement**: it carries every fix
`0.4.27` had, plus the two items below.

**`0.4.28` needs no data migration.** The session format is unchanged (v3), no session is
re-written, and nothing has to be re-indexed: upgrade, restart, and the two symptoms above
are gone. If you are on a host that still provides the old members, the compatibility
accessors keep those paths working — this build does not drop older hosts.

If the app **fails to boot after an upgrade**, a single failing plugin can take the
whole tree down, so recover first and diagnose second:

1. remove `dsh-retrace` from the profile's `dsh.profile.bundles` **and** its
   `dependencies` entry, restart, and confirm you can get back in;
2. read the host log —
   macOS: `~/Library/Application Support/DSH Desktop/logs/host/dsh-<date>.error.log`;
3. `plugin tree failed to load` is the **host** half; `renderer boot failed` is the
   **client** half. Both name the offending plugin/package — start there.

### Pinning

Pin an exact plugin version (`dsh-retrace@0.4.26`) and let `dsh-log-contract` resolve to
`>=0.3.12`. Do not rely on `^0.4` across a host upgrade: compatibility here is decided by
the **host surface**, not by semver alone.

---

## ⚠️ Requirements & limitations

- **Optional dependency (deliberately NOT in `package.json`)**: AI summaries need
  an `llm` service from the host (the official `@deepseek-ai/dsh-llm`, bundled
  with DSH Desktop). The plugin takes it **dynamically** via `ctx.get('llm')`:
  present ⇒ summaries available, absent ⇒ it degrades to **verbatim excerpts
  only**. Install and startup are unaffected either way. Model and credentials
  follow the session's own default selection
  (`agentDefaultModel.currentSelection()`); the plugin adds **no configuration
  surface of its own**. Summaries sit behind a **default-off** switch (at most one
  small call per operation: ≤6×400 chars in, ≤200 tokens out, 5 s timeout); when
  it is off there are **zero LLM calls**, while the verbatim excerpt (zero token
  cost) is **always recorded**.
- Only **user messages** can be edited; recall works on user and assistant
  messages. Tool results are shadowed along with the recalled range but are not
  themselves recall targets.
- The agent must be **idle**: while a reply is streaming you must stop it
  (⏹) before recalling or editing. The Host rejects with `agent-busy`
  otherwise.
- Recall/edit operate on the **active model surface**: a message that was
  already compacted away or previously recalled is rejected
  (`target-shadowed`).
- Regenerate re-sends only the **text** of the original prompt; prompts that
  carried images fall back to the text-only content.

---

## 🗺️ Roadmap

**What's in today (0.4.x):**

- Recall / edit-and-resend / regenerate, each written through a three-layer
  **pre-write contract guard** and a safe-edit path (auto-stop the agent, temp-step
  markers) — new rewinds do not corrupt the log and add no `/compact` debt;
  **legacy single-segment markers** remain known debt (see the honest note above).
- In-session **version timeline** + **artifact rollback** (git-first, snapshot
  fallback, dry-run preview, jump-to-conversation).
- **Fork map + session lineage** in the conversation view.
- **Real-time watchdog** — snapshots the log at the first sign of concurrent writes.
- Companion **`dsh-log-contract`**: 30+ offline contract rules + in-place repair
  (`fix --neutralize` / `--clip-crossstep`) for sessions that would fail `/compact`.
**Close guard (don't lose work by accident)** — before you exit or reload, know what is still running:

| | What | |
|---|---|---|
| 🛡️ | **Running-work detection** | every session is scanned for live work: agent running, queued inbox items, background jobs, unclosed turns |
| 📋 | **Running banner** | sessions with live work show a persistent in-page banner (short session code + reasons), so you can see it before quitting |
| ⚠️ | **Exit prompt** | on plugin dispose (app exit / reload) a Chinese notice lists each running session and why it is considered busy — it only warns, it never cancels your running agent |
| 🔒 | **Page-close interception (web browsers)** | `beforeunload` interception, armed only where the host reports a native confirm dialog: a strong confirm when work is running (details modal, `[仍关闭]` = confirm-and-go), a light confirm otherwise |
| 🔎 | **Query surface** | `retrace.runningState` (host RPC) + `GET|POST /api/plugins/retrace/runningState` (HTTP) — same shape on both transports; the all-sessions shape also carries the host-reported page surface (`surface` / `quitVeto`) |

> Desktop note: quit entry points differ by version/platform, and the DSH Desktop Electron
> shell we inspected has no `will-prevent-unload` handler (0 hits across the packaged 2.0.9
> `app.asar`). Where the entry does reach the page — the external report's DSH Desktop 0.9.0 /
> Windows — the page `beforeunload` veto is **swallowed silently**: no dialog, no feedback, and
> the exit looks stuck (only a force-quit works). Where it does not — the 2.0.9 shell we
> inspected routes the tray item through `requestQuit(0) → window.destroy() → app.exit(0)` — the
> quit is unaffected either way. The page cannot tell which case it is in, so desktop **never**
> arms the native gate; it relies on the running banner plus the dispose notice. The gate is
> armed only where the host reports that the page really surfaces a native dialog
> (`quitVeto: true`, i.e. browser pages).
>
> **Both criteria must hold** (2026-09-18, second round): the host side is only a
> *non-objection*, and the client keeps a **veto** — if this page's `navigator.userAgent`
> contains `Electron`, or the page URL contains `dsh-desktop-` (the external report's shell
> puts its desktop marker in the query string), the gate is **never** armed. The host-side
> criteria were widened to four request-level facts: the `x-dsh-desktop-renderer` capability
> header, a request `User-Agent` containing `Electron`, or a request URL **or `Referer`**
> containing `dsh-desktop-` — **any one** of them classifies the page as a desktop page. (Our own
> polling URL carries no query string, so the page marker is in practice read from `Referer`,
> which a same-origin `fetch` sends by default.) That covers the
> hosts that expose no desktop evidence at all (the reporter's: a pure-Node harness plus an
> Electron renderer, where all three older criteria were false, and the old code filed
> "no evidence at all" as a browser page ⇒ the gate was still armed ⇒ the exit still hung).
> If Desktop cannot quit, turning off "Exit confirmation (close guard)" in settings recovers
> immediately (no restart).

> Command surface: `retrace.runningState` (host RPC) + `GET|POST /api/plugins/retrace/runningState` (HTTP).

**What's next** — the agent business-layer plan (runtime guard, interruption
governance, ecosystem-facing interfaces) is **not published yet**: it is a plan,
not a shipped capability. This README describes the **development line (main)**,
which may run ahead of the latest npm release.

---

## 🛠️ Development

```sh
# structure
lib/host-core.js       # transport-neutral host logic (no imports)
lib/index.js           # published Host: harness RPC + HTTP route
lib/client.js          # client SOURCE (React via import; pluggable transport)
lib/client.bundle.js   # BUILT client bundle — the self-registering loader entry
                       # (`window.__ModuleLoader__.load`) served by client-modules
lib/dynamic-host.js    # GENERATED dynamic Host half (from lib/host-core.js)
lib/dynamic-client.js  # GENERATED dynamic Client half (from lib/client.js)
scripts/build-client.mjs      # bundle lib/client.js → lib/client.bundle.js
scripts/generate-dynamic.mjs  # generate both dynamic entries from the canonical sources
scripts/check-dynamic.mjs     # syntax-check the dynamic entries (function bodies)
test/                 # vitest suite: host-core ops + generated-entry smoke tests
.github/workflows/    # CI (syntax + build-sync + tests) and npm publish (v* tags)
cordis.patch.yml      # dsh.bundle profile patch layer
```

```sh
pnpm install          # install dev dependencies (vitest, esbuild)
pnpm check            # syntax-check sources AND the generated dynamic entries
pnpm build            # regenerate lib/dynamic-*.js + lib/client.bundle.js
pnpm test             # run the host-core unit tests
npm pack --dry-run    # verify the published file list
```

> ⚠️ **Generated files.** `lib/dynamic-host.js`, `lib/dynamic-client.js` and
> `lib/client.bundle.js` are built artifacts generated from `lib/host-core.js`
> and `lib/client.js` — never edit them by hand. CI fails when a committed
> artifact is stale (`git diff --exit-code`), so run `pnpm build` before
> committing. The dynamic client reuses the same client source as the published
> one and only swaps the transport (`host.call` vs the HTTP route) via
> `__setMessageEditorWire`.

PRs and issues are welcome — a `CONTRIBUTING.md` is coming soon
and the [issue tracker](https://github.com/yamingmou/dsh-retrace/issues).

---

## 📚 Ecosystem

Listed on the [dsh-plugin topic](https://github.com/topics/dsh-plugin).

Part of the **Agent business layer (production-grade guarantees)** — the
framework-agnostic layer that dsh-retrace implements on DeepSeek Harness.
Companion components:

- [**dsh-log-contract**](https://github.com/yamingmou/dsh-log-contract) — the
  business layer's "doctor": 30+ offline contract rules + in-place repair
  (`fix --neutralize` / `--clip-crossstep`). Installed automatically as a
  dependency; also published standalone for direct use.

> **Install straight from GitHub** (no npm registry needed — handy when you
> hand this repo's link to an AI or want the latest commit):
>
> ```sh
> dsh plugin --profile desktop add github:yamingmou/dsh-retrace
> # or with pnpm directly into a profile:
> cd "$DSH_HOME/profiles/desktop" && pnpm add github:yamingmou/dsh-retrace
> ```
>
> Then restart DSH Desktop as usual. The `dsh-log-contract` dependency is
> pulled in automatically.

A curated overview of the DeepSeek Harness plugin ecosystem lives at
[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
(third-party listing — verify availability before relying on it).

---

## 👥 Team

Built by the [OfferKuai](https://www.offerkuai.com) team — an AI job application
assistant on a mission that "users need results, not repeated conversations".
Founder: Zhaofeng (Yaming). This plugin is released as open source for the
DeepSeek Harness community.

## 📄 License

MIT


## 🧭 Session archaeology (`retrace` CLI)

Every tool call's full input/output is persisted in the session log — a data and
audit asset. The `retrace` CLI provides read-only archaeology (reusing
dsh-log-contract's contracts and extraction):

```sh
retrace index <session>                        # tool-call index (A1)
retrace query <session> --cmd "seed-scale"     # search outputs by command regex (A1)
retrace extract <session> --pattern "seed-scale" --out ./found   # export outputs (A2)
retrace file-history <session> <path>          # write/edit history of a file (A3)
retrace file-diff <session> <path> 0 5         # line diff between two versions (A3)
retrace lineage <session>                      # parent-chain lineage (A4)
```

`<session>` is a full log path or a sessionId (auto-looked-up under
the active session base — `$DSH_HOME/sessions`, else a newer base, else `~/.dsh/sessions`). All read-only.

**Session lineage in the fork map (A4, UI)**: the Fork map view header shows the
current session's `parentSession` chain (session → parent → root, `←` direction).
Data comes from `GET /api/plugins/retrace/lineage?sessionId=` (read-only header
walk with cycle protection), the same semantics as the CLI `retrace lineage` —
so "which session did this one continue/fork from" is visible at a glance, and
serves as the fork-topology metadata source.
