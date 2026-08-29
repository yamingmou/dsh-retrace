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
conversation **and its artifacts** together, and guarantees **every rewind is
legal — never dirtying the log, never breaking /compact**.

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
| 🛡️ | **Write safety** | Every rewind passes a three-layer pre-write contract guard; running agents are auto-stopped (official `cancel`/`whenIdle`); turn-interval markers are wrapped in a temporary step — **rewinds never dirty the log, /compact never breaks** |
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

1. Open the profile manifest (defaults: `~/.dsh/profiles/desktop` on DSH
   Desktop, `~/.dsh/profiles/web` for standalone Web) and add **both** the
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
   cd ~/.dsh/profiles/<name> && pnpm install
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
| **Git integration** | on | On: use git to record and roll back when the workspace is a repository (never auto-commits, never touches your branches); non-repo workspaces can enable git from the timeline. Off: built-in snapshots under `~/.dsh` only — the plugin never touches the workspace git state; features are equivalent. |
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

## ⚠️ Requirements & limitations

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
  markers) — rewinds never corrupt the log or break `/compact`.
- In-session **version timeline** + **artifact rollback** (git-first, snapshot
  fallback, dry-run preview, jump-to-conversation).
- **Fork map + session lineage** in the conversation view.
- **Real-time watchdog** — snapshots the log at the first sign of concurrent writes.
- Companion **`dsh-log-contract`**: 30+ offline contract rules + in-place repair
  (`fix --neutralize` / `--clip-crossstep`) for sessions that would fail `/compact`.

**What's next** — see the [public roadmap](./docs/ROADMAP.md) for the agent
business-layer plan (runtime guard, interruption governance, ecosystem-facing
interfaces). This README only describes what is already shipped.

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

PRs and issues are welcome — see [CONTRIBUTING](./CONTRIBUTING.md) (coming soon)
and the [issue tracker](https://github.com/yamingmou/dsh-retrace/issues).

---

## 📚 Ecosystem

Listed on the [dsh-plugin topic](https://github.com/topics/dsh-plugin).

Part of the **Agent business layer (production-grade guarantees)** — see the
[public roadmap](./docs/ROADMAP.md) for the framework-agnostic layer and how
dsh-retrace is its DeepSeek Harness implementation. Companion components:

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
> cd ~/.dsh/profiles/desktop && pnpm add github:yamingmou/dsh-retrace
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
`~/.dsh/sessions`). All read-only.

**Session lineage in the fork map (A4, UI)**: the Fork map view header shows the
current session's `parentSession` chain (session → parent → root, `←` direction).
Data comes from `GET /api/plugins/retrace/lineage?sessionId=` (read-only header
walk with cycle protection), the same semantics as the CLI `retrace lineage` —
so "which session did this one continue/fork from" is visible at a glance, and
serves as the fork-topology metadata source.
