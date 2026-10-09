<div align="center">

# 🧭 dsh-retrace

**Recall · Resend (restart from here) · Regenerate**, plus **write-safe** in-conversation
versioning — the **Agent business layer (production-grade guarantees)** for
DeepSeek Harness.

[![npm version](https://img.shields.io/npm/v/dsh-retrace)](https://www.npmjs.com/package/dsh-retrace)
[![npm downloads](https://img.shields.io/npm/dm/dsh-retrace)](https://www.npmjs.com/package/dsh-retrace)
[![License: MIT](https://img.shields.io/npm/l/dsh-retrace)](https://www.npmjs.com/package/dsh-retrace)
[![DSH plugin](https://img.shields.io/badge/DSH-plugin-4A90D9)](https://github.com/topics/dsh-plugin)

**English** · [简体中文](./README.zh.md)

</div>

**Recall / resend / regenerate** — the three moves every conversation
deserves. But rewinding is not just "delete a message": DeepSeek Harness stores
conversations in an append-only event log, so a recall only rewinds the context
while changed **artifact files stay changed**. dsh-retrace versions the
conversation **and its artifacts** together, and keeps **every new rewind legal** —
it cannot dirty the log, and new markers create **no token-meter pairing debt**
(two-segment atomic pairs land by construction).

> ⚠️ **Honest scope (matches the companion contract's own note)**: sessions that
> already contain **legacy single-segment markers** — written by older versions —
> are **known design debt**. Before `/compact`, run the companion `check` and
> clean them up (`fix --remove-markers`); otherwise the host's own pre-compaction
> self-check blocks compaction. New rewinds do not add to that debt.

> 🛡️ **Write safety** · 🔍 **Deep offline checks** · 🔄 **Detect → repair → guard** — see below.

---

## ⚡ One-minute install

> Requires DeepSeek Harness with the `dsh` CLI. **Restart DSH after install** (a running app does not hot-reload).

```sh
dsh plugin --profile desktop add dsh-retrace    # DSH Desktop
# or Web: dsh plugin --profile web add dsh-retrace
# or from an unpacked checkout / ZIP:
#   dsh plugin --profile desktop add ~/plugins/dsh-retrace
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
| 🛡️ | **Write safety** | Every rewind passes a three-layer pre-write contract guard; a running agent is stopped automatically (official `cancel`/`whenIdle`, with a bounded wait); turn-interval markers are wrapped in a temporary step — **new rewinds cannot dirty the log and add no token-meter pairing debt**; **legacy single-segment markers are known debt** (run the companion `check` + `fix --remove-markers` before `/compact`) |
| 🔍 | **Deep offline checks** | Companion `dsh-log-contract` ships 30+ contract rules (token-meter pairing / cross-step references / physical order / inbox replay), validated against real corrupted-session fixtures — it finds the class of problem that makes /compact permanently fail |
| 🔄 | **Detect → repair → guard** | A watchdog snapshots the log at the first sign of concurrent writes; offline `fix` neutralizes problem markers and clips cross-step references in place; pre-write validation stops bad events before they land |

---

## ✨ Features

| Action | Where | What happens |
| --- | --- | --- |
| **↩ Recall** | hover any assistant reply, or the row under any user message | Opens a **confirmation first** (destructive: this message and everything after it leaves the conversation). On confirm, if a turn is still running the plugin **pauses it first** through the official stop entry and waits (bounded); if the pause fails or times out the recall still continues, with a visible notice. The whole exchange round (the input **and** the agent's output, tool rows included) is then removed from both the model context and the conversation view; the input text is echoed into the composer so you can re-ask or re-edit immediately. A transient notice marks the rewind and disappears once you keep typing. |
| **✎ Resend (restart from here)** | row under any user message | The primary meaning is **restart from this message**: this round and everything after it is rewound and the new text is re-sent, so the conversation continues on a new timeline branch. If that range is refused by the guard (too large to rewrite in place), the error offers a fallback action — **Change this text only (keep what follows)**. A collapsed **"original input"** reference sits right under the new message — click to expand, configurable off. |
| **↻ Regenerate** | hover any assistant reply | The reply (and everything after it) is rewound and hidden, then the original prompt is re-sent so the agent answers again. |

### Undoing a recall

| Action | Scope | What happens |
| --- | --- | --- |
| ↺ **Restore display** | view only | Puts the rows hidden by that marker back into the conversation view. The log only grows, the model context is unchanged, and the recall trace stays. Available on the marker row. |
| ⏪ **True restore** | log level | Neutralizes the two marker segments **in place** (sequence numbers are not renumbered), so the recalled range returns to the **model surface** and its edit / resend / recall actions work again. Requires an idle session that is not the one you are currently viewing; once it succeeds, switch away and reopen that session (or refresh the page) to see the restored content. Refusals are explained with a next step (session running / held by another process / already re-shadowed by a later marker / host does not provide the capability). |

**Checkpoints & rollback (live in 0.4.x)** — every rewind is also recorded as a **checkpoint**:

| | What | |
|---|---|---|
| 🕘 | **Checkpoints** | a **Checkpoints** tab in the conversation view: every change (type, time, message count, file-change badges), pushed live via `session/projection` (no polling), windowed for long histories; nested history is browsable outline-style |
| ↩️ | **Artifact rollback** | **context-only / artifacts-only / both** with dry-run preview; git-first + content-addressed snapshot fallback; a rollback is itself a new checkpoint (`restore`). Preview refuses while the agent is running (so "preview says yes, confirm says no" cannot happen), and preview/rollback failures are shown in the UI instead of failing silently |
| 🧭 | **Jump-to-conversation** | one click from a checkpoint to that point in the conversation (auto-loads history, anchor highlight); when the point is out of the auto-load budget the reason is reported instead of nothing happening |
| 🧹 | **Bounded storage** | snapshots keep the most recent N checkpoints (default 50); throttled background sweep prunes truncated ones |

> **Rollback on a damaged log** is not silent: the host's strict replay is the
> authority, but a single malformed event (for example a `sourceEventSeqs` row
> written by a third party with range encoding) can poison the whole replay. In
> that case the rollback degrades to a mirror replay, logs both the degradation
> and the original error, and flags the result as `degraded` on the wire; if even
> the mirror cannot run you get a structured `replay-failed` error, not a generic
> `internal`.

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
       "dsh-retrace": "^0.4.130"
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
For the latest commit without a release, add a git dependency using the repository
URL from this package's `repository` field (pnpm syntax
`"dsh-retrace": "github:<owner>/dsh-retrace"`) in the same `dependencies` block,
then `pnpm install`.

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

### 5. Requirements

- DeepSeek Harness providing the peer packages listed in `package.json`
  (`@deepseek-ai/dsh-session`, `@deepseek-ai/dsh-client-*`, `cordis`, `react` — the
  current build targets the `0.1.7-rc.2` generation).
- `dsh-log-contract >= 0.3.12` (installed automatically as a dependency).
- The plugin declares the host capabilities it needs via `inject`
  (`sessions`, `agents`, `webServer`, `fs`, `subprocess`, `sandboxPolicy`, `jobs`).
  A missing capability degrades the corresponding feature (for example, no
  `subprocess` ⇒ rollback uses the built-in snapshots only); it does not block boot.

---

## 🔒 Close guard (don't lose work by accident)

Before you exit or reload, know what is still running:

| | What | |
|---|---|---|
| 🛡️ | **Running-work detection** | every session is scanned for live work: agent running, queued inbox items, background jobs, unclosed turns |
| 📋 | **Running banner** | sessions with live work show a persistent in-page banner (short session code + reasons), so you can see it before quitting |
| ⚠️ | **Exit prompt** | on plugin dispose (app exit / reload) a Chinese notice lists each running session and why it is considered busy — it only warns, it never cancels your running agent |
| 🔒 | **Page-close interception** | The desktop never arms the host's native confirm dialog; it uses a **page-drawn confirm gate** instead: it draws the box and **verifies visibility synchronously** before blocking (`preventDefault`); if it cannot draw, is not visible, or the page is hidden ⇒ **lets the close through immediately**; the dialog waits for your choice (**Esc = cancel**); a **Web-Worker watchdog** (immune to background throttling) is only the *last* resort. Turning off "Exit confirmation (close guard)" recovers immediately (**no restart**) |
| 🔎 | **Query surface** | `retrace.runningState` (host RPC) + `GET\|POST /api/plugins/retrace/runningState` (HTTP) — same shape on both transports; the all-sessions shape also carries the host-reported page surface (`surface` / `quitVeto`) |

> **How the close confirm behaves (user-visible)**: whether the host pops its own
> **native** quit confirmation is decided **jointly by the host and the page**. On a
> desktop shell the plugin does **not** use the host's native dialog — it draws its
> **own in-page confirmation** (Esc cancels). If the page cannot draw that box, the
> box is not visible, or the page itself is hidden, the close is let through
> immediately. Turning off "Exit confirmation (close guard)" reverts to the host's
> default behaviour (no restart needed).
>
> **Known limitation (stated plainly)**: some desktop shells route quit **around
> the page entirely** (e.g. the tray item destroys the window directly, or the X
> button merely hides the window) ⇒ on those shells a plugin **cannot** show a
> confirm dialog at quit time; it **needs a shell seam** (a `will-prevent-unload`
> handler, or a pre-quit prompt hook). If the app cannot quit, turning off "Exit
> confirmation (close guard)" recovers immediately (no restart).

### Session badge & display name (**planned / off by default**)

Badges are for human collaboration; **identity is still decided by the session id**.
The transports (`sessionBadge` / `setBadgeTitle` / `initBadgeTitles` / `badgeMap`,
on both HTTP and harness), the resolver and the write guards are **in place**, but
the **automatic startup path that writes titles is off by default** (the client
gate is `globalThis.__DSH_RETRACE_BADGE_BOOTSTRAP = true`):

- A session title renders as `[badge] original title` — the **stable identifier is
  derived deterministically from the session id**, so a title change never changes it.
- Sessions with **no `session/title` event are left blank on purpose** (the title shows just
  `[badge]`) — **no project-name fallback, no fabricated name**.
- If the resolver is unavailable it falls back to the **raw session id as a placeholder**.
- The sidebar row, the running banner and the checkpoint view share **one source**: the same badge
  map the host hands down (host op `badgeMap`).

> **Planned (not shipped)**: the agent business-layer plan (runtime guard,
> interruption governance, ecosystem-facing interfaces) is a **plan**, not a
> shipped capability.

---

## ⚙️ Settings → General

| Setting | Default | Description |
| --- | --- | --- |
| **Show the original input after editing** | on | A collapsed "original input" reference under the re-sent message showing the **most recent** replaced text (reference only — never sent to the model). |
| **Checkpoints & artifact snapshots** | on | On: every recall/edit records a checkpoint (messages and touched files) powering the checkpoint list and artifact rollback. Off: only rewinds context — no checkpoint records, no artifact tracking (lightest). |
| **Summarize old content with AI** | off | On: each recall/edit makes one small model call to summarize the discarded old content. Requires the host `llm` service (the official `@deepseek-ai/dsh-llm`); absent ⇒ it degrades to **verbatim excerpts only**. Off: **zero LLM calls**; the verbatim excerpt (zero token cost) is **always recorded**. At most one small call per operation (input text capped at 500 characters, ≤200 output tokens, 5 s timeout); model and credentials follow the session's own default selection, and the plugin adds **no configuration surface of its own**. |
| **Git integration** | on | On: use git to record and roll back when the workspace is a repository (never auto-commits, never touches your branches); non-repo workspaces can enable git from the checkpoint view. Off: built-in snapshots under the plugin data home only — the plugin never touches the workspace git state; features are equivalent. |
| **Checkpoint retention limit** | 50 | File snapshots are kept for the most recent N checkpoints; older ones are pruned automatically (checkpoint records and the audit trail are always kept). |
| **Exit confirmation (close guard)** | off | On: confirm before the page closes when sessions have running or unfinished work (the plugin draws its own dialog; Esc cancels). Off by default because the gate can also intercept an in-app reload — see [🔒 Close guard](#-close-guard-dont-lose-work-by-accident) for the desktop details and the self-recovery note. |

The two toggles "hide shadowed messages per marker" and "start a fresh
conversation after editing" no longer exist: recall/resend/regenerate always hide
what they replaced (a single marker that would hide more than 40% of the
conversation degrades to notice-only, so history never silently vanishes), and
resend always uses the "restart from here" semantics with the fallback action
described above.

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
2. **Resend / regenerate** additionally call `agent.followup(...)` with the
   (new) prompt text; the agent's next turn builds its request from the
   rewound `session.deriveMessages()`.
3. **Client** (`lib/client.js`) registers:
   - a `user-actions` conversation node under every user message
     (a resend/recall row with an inline editor); recall echoes the text into the
     composer,
   - the `recall-marker` node renderer: a notice row that injects CSS hiding
     every shadowed message row from the flow (view and model context stay in
     sync), plus the optional original-input comparison block, the
     **Restore display** button and the **True restore** action,
   - the `retrace` entry in the `conversation.chat.assistant-actions`
     strip (recall / regenerate),
   - the **Checkpoints** view and the preference toggles under Settings → General.

> Two different layers are at play: the **durable transcript** (append-only; old
> events are never rewritten or deleted) and the **model-visible surface** (rewound
> by an appended replacement event). So the old events stay in the log as an audit
> trail — but they are **synchronized out of both the model context and the visible
> conversation**, and the view always reflects what the agent actually sees.
> Persistence, projections and the transcript remain consistent because the plugin
> only appends valid, typed session events. (**True restore** is the one operation
> that does edit the log, and it does so in place, without renumbering sequences.)

---

## 🔺 Compatibility & upgrade notes

`dsh-retrace` is a **bundle plugin**: it plugs into whatever host surface it is
installed into. A host release that *removes* a package or a client service can
therefore break an older plugin build even though nothing in that build changed —
the symptom is usually a failed boot, not a wrong-looking feature.

This section exists so you can tell **host-side breakage** from **plugin-side bugs**.
Read it before filing an issue.

### Host-side breaking changes this plugin adapts to — *not caused by this plugin*

1. **`@deepseek-ai/dsh-session` removed the `Session.events` member** (in `0.1.5-rc.1`).
   The supported readers are `snapshotEvents(fromSeq, toSeqExclusive)` (frozen,
   sequence-indexed), `eventAt(seq)`, `ownEvents()` and `isOwnSeq(seq)`. Before the
   fix, recall and edit did nothing and surfaced
   `TypeError: Cannot read properties of undefined (reading 'length')`. The plugin
   now reaches the log through a compatibility accessor that prefers the new API and
   falls back to the old array, so both host generations work.
2. **`@deepseek-ai/dsh-session` dropped `decodeStorageRecord` from its public export
   surface** (in `0.1.5-rc.1`; the function still exists internally but is no longer
   exported from the package root and is unreachable via the exports map).
   `dsh-retrace` itself never imported it, but its dependency `dsh-log-contract` did.
   With no such export the loader aborts with
   `plugin tree failed to load … does not provide an export named 'decodeStorageRecord'`
   and **the whole plugin tree fails to load — not just this plugin**, so the app does
   not start.
   → **Dependency note:** needs `dsh-log-contract >= 0.3.12`.
3. **A client **service** disappeared: `conversationEvents`** — it used to be provided by
   the legacy client runtime `@deepseek-ai/dsh-client-runtime`, which has been removed.
   A plugin whose client half still declares that service in `export const inject` never
   becomes ready: its fiber stays **pending**, which the host reports as
   `renderer boot failed (plugins: …): The client Loader did not provide an error message.`
   — no error text at all, the window does not finish starting, and the only way in is to
   disable the plugin. The plugin drops the service from `inject` and resolves it
   **defensively** in `apply` (`uiConversation`, falling back to the legacy name).
   > Note: declaring a **package** that no longer exists in `dsh.client.inject` is *not*
   > what breaks the boot — the client loader skips unknown entries silently. The
   > breakage comes from the **service name** the plugin waits for.
4. **The client-side session store has no `keys()`** (`ctx.sessions`). A plugin that
   enumerates sessions with `keys()` silently sees **zero** of them: no crash, no error,
   just safety warnings that never fire. The plugin prefers the official `list()` and
   falls back to `keys()`; it deliberately does **not** fall back to enumerating service
   fields, because guessing produces a silent empty result as well.

> All four items are **host-side removals**, documented here on purpose: if you hit
> one of these symptoms right after a host upgrade, the first question is "does this
> plugin build predate the removal?", not "what did the plugin break?".

### Plugin-side fixes (0.4.26 – 0.4.28)

- **Data home and session base are now one source.** The plugin previously resolved its
  own data directory through the host's home resolver (`$DSH_HOME` → `~/.dsh`), which
  does not know about a migrated base. With `$DSH_HOME` unset, sessions were read from
  one base while snapshots and the artifact store were written to another. Snapshots,
  version stores and `verify-install` now follow the **active session base**. When
  `$DSH_HOME` is set, behaviour is unchanged.
- **No user-visible string hard-codes `~/.dsh` any more** (the settings hint used to say
  snapshots live under `~/.dsh`).
- **The edit / recall affordances never appeared at all.** The client half read chat
  nodes from `snapshot.chat.nodes`, a path this host build does not have — nodes live in
  the `useChat` store (`snapshot.nodes`). Every message-level component threw while
  rendering and was swallowed by the error boundary, so the buttons were missing, while
  the settings entry (which reads no nodes) rendered fine.
- **"Jump to message" in the checkpoint view did nothing.** It resolved the target
  anchor through `store.getSnapshot()?.chat?.nodes`, which is permanently `undefined`
  here. It now resolves through the `useChat` snapshot injected by the view and pages
  with the official `store.loadThrough(seq)`; when the jump cannot complete it reports a
  **diagnosable reason** (renderer warning + host-log line) instead of failing silently.
- **Assigning a lineage ID could overwrite your session title.** Title tagging now goes
  through the host route only (`setBadgeTitle`), which reads the current title from the
  session log. Manual renames are unaffected.
- **Host-side operation failures are logged again** (code + message + stack). They used
  to return the message to the UI without a log line, which made this class of bug hard
  to diagnose from outside.
- **The checkpoint view now explains itself.** It used to show a title plus a row of
  actions with **no sentence anywhere saying what a "checkpoint" is**, and rows printed
  raw node types. It now carries an always-visible concept sentence, a type legend, and
  a plain-language "why" line on every row.
- **Client hide-lookup no longer rescans per row.** `useSeqHidden` re-scanned the node map
  for every row (measured **346 ms** at 2000 rows / 20 markers, **1568 ms** at 3000/30).
  It now reuses one per-snapshot hide plan: **8.3 ms** and **18.3 ms** respectively, with
  the predicate verified equivalent against the old one.

### Upgrading

```bash
dsh plugin --profile desktop add dsh-retrace@0.4.130
# then restart DSH — plugins are not hot-reloaded
```

**`0.4.27` and `0.4.31` were withdrawn** (briefly published, then recalled and marked
deprecated on npm). Their replacements carry every fix they had.

**No data migration is required.** The session format is unchanged (v3), no session is
re-written, and nothing has to be re-indexed: upgrade, restart, and the symptoms above
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

Pin an exact plugin version (`dsh-retrace@0.4.130`) and let `dsh-log-contract` resolve to
`>=0.3.12`. Do not rely on `^0.4` across a host upgrade: compatibility here is decided by
the **host surface**, not by semver alone.

---

## ⚠️ Requirements & limitations

- Only **user messages** can be re-sent from; recall works on user and assistant
  messages. Tool results are shadowed along with the recalled range but are not
  themselves recall targets.
- A recall that targets a running turn **pauses it first** (official stop entry, bounded
  wait). If the pause fails or times out, the recall continues and a notice tells you so.
  True restore and rollback preview require an **idle** session; they are rejected
  otherwise.
- Recall/resend operate on the **active model surface**: a message that was
  already compacted away or previously recalled is rejected
  (`target-shadowed`), and a message whose write has not flushed yet is reported as
  `message-pending` ("still being generated") rather than being misreported as gone.
- Regenerate re-sends only the **text** of the original prompt; prompts that
  carried images fall back to the text-only content.
- True restore edits the session log **in place** (it neutralizes the two marker
  segments; sequence numbers stay as they are). It refuses to run while the session is
  the one you are viewing, while it is running, or while another process holds the file,
  and you must reopen the session (or refresh) to see the result.

---

## 🗺️ Roadmap

**What's in today (0.4.x):**

- Recall / resend / regenerate, each written through a three-layer
  **pre-write contract guard** and a safe-edit path (auto-stop the agent, temp-step
  markers) — new rewinds do not corrupt the log and add no `/compact` debt;
  **legacy single-segment markers** remain known debt (see the honest note above).
- **Undo**: Restore display (view) and True restore (log level, in place).
- In-session **checkpoint timeline** + **artifact rollback** (git-first, snapshot
  fallback, dry-run preview, jump-to-conversation).
- **Close guard** (running-work banner, exit notice, page-drawn confirm gate).
- **Real-time watchdog** — snapshots the log at the first sign of concurrent writes.
- Companion **`dsh-log-contract`**: 30+ offline contract rules + in-place repair
  (`fix --neutralize` / `--clip-crossstep`) for sessions that would fail `/compact`.
- Read-only host surfaces for integration: `retrace/versions` and `retrace/forkmap`
  projections, `GET /api/plugins/retrace/{versions,forkmap,lineage,event,surface,doctor,snapshot}`,
  `POST /api/plugins/retrace/{rollback/preview,rollback,git/init}`, plus the badge
  ops (`sessionBadge` / `setBadgeTitle` / `initBadgeTitles` / `badgeMap`) and the
  `retrace` CLI (see below).

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
pnpm install          # install dev dependencies (vitest, esbuild); Node >= 22.13
pnpm check            # syntax-check sources AND the generated dynamic entries
pnpm build            # regenerate lib/dynamic-*.js + lib/client.bundle.js
pnpm test             # run the unit tests
npm pack --dry-run    # verify the published file list
```

> ⚠️ **Generated files.** `lib/dynamic-host.js`, `lib/dynamic-client.js` and
> `lib/client.bundle.js` are built artifacts generated from `lib/host-core.js`
> and `lib/client.js` — never edit them by hand. CI fails when a committed
> artifact is stale (`git diff --exit-code`), so run `pnpm build` before
> committing. The dynamic client reuses the same client source as the published
> one and only swaps the transport (`host.call` vs the HTTP route) via
> `__setMessageEditorWire`.

PRs and issues are welcome — a `CONTRIBUTING.md` is coming soon; use the issue
tracker linked from this package's `repository`/`bugs` metadata.

---

## 📚 Ecosystem

Listed on the [dsh-plugin topic](https://github.com/topics/dsh-plugin).

Part of the **Agent business layer (production-grade guarantees)** — the
framework-agnostic layer that dsh-retrace implements on DeepSeek Harness.
Companion components:

- [**dsh-log-contract**](https://www.npmjs.com/package/dsh-log-contract) — the
  business layer's "doctor": 30+ offline contract rules + in-place repair
  (`fix --neutralize` / `--clip-crossstep`). Installed automatically as a
  dependency; also published standalone for direct use.

> **Install straight from git** (no npm registry needed — handy when you
> hand this repo's link to an AI or want the latest commit):
>
> ```sh
> dsh plugin --profile desktop add github:<owner>/dsh-retrace
> # or with pnpm directly into a profile:
> cd "$DSH_HOME/profiles/desktop" && pnpm add github:<owner>/dsh-retrace
> ```
>
> Substitute the owner from this package's `repository` field. Then restart DSH
> Desktop as usual — the `dsh-log-contract` dependency is pulled in automatically.

A curated overview of the DeepSeek Harness plugin ecosystem lives at
[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
(third-party listing — verify availability before relying on it).

---

## 👥 Team

Built by the [OfferKuai](https://www.offerkuai.com) team — an AI job application
assistant on a mission that "users need results, not repeated conversations".
This plugin is released as open source for the DeepSeek Harness community.

## 📄 License

MIT

---

## 🧭 Session archaeology (`retrace` CLI)

Every tool call's full input/output is persisted in the session log — a data and
audit asset. The `retrace` CLI provides read-only archaeology (reusing
dsh-log-contract's contracts and extraction):

```sh
retrace index <session>                        # tool-call index
retrace query <session> --cmd "seed-scale"     # search outputs by command regex
retrace extract <session> --pattern "seed-scale" --out ./found   # export outputs
retrace file-history <session> <path>          # write/edit history of a file
retrace file-diff <session> <path> 0 5         # line diff between two versions
retrace lineage <session>                      # parent-chain lineage
```

`<session>` is a full log path or a sessionId (auto-looked-up under the active
session base — `$DSH_HOME/sessions`, else a newer base, else `~/.dsh/sessions`).
All read-only.

**Session lineage**: `GET /api/plugins/retrace/lineage?sessionId=` walks the
current session's `parentSession` chain (read-only, with cycle protection) — the
same semantics as the CLI `retrace lineage` — so "which session did this one
continue/fork from" is available to any client, and serves as the fork-topology
metadata source.
