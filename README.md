<div align="center">

# 🧭 dsh-retrace

**Retrace · 回溯** — Recall · Edit-and-resend · Regenerate, plus **in-conversation
versioning**: a timeline of every rewind, artifact rollback, and a fork map of the
paths your conversation explored (roadmap). A Harness enhancement plugin for the
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web GUI and
Desktop app (both share the same Web frontend).

[![npm version](https://img.shields.io/npm/v/dsh-retrace)](https://www.npmjs.com/package/dsh-retrace)
[![npm downloads](https://img.shields.io/npm/dm/dsh-retrace)](https://www.npmjs.com/package/dsh-retrace)
[![License: MIT](https://img.shields.io/npm/l/dsh-retrace)](https://github.com/yamingmou/dsh-retrace/blob/main/LICENSE)
[![DSH plugin](https://img.shields.io/badge/DSH-plugin-4A90D9)](https://github.com/topics/dsh-plugin)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](https://github.com/yamingmou/dsh-retrace/pulls)

**English** · [简体中文](./README.zh.md)

</div>

> ## ⚡ Install in one minute
>
> **Option A — one command (recommended):** with DeepSeek Harness's `dsh` CLI:
>
> ```sh
> dsh plugin --profile desktop add dsh-retrace   # DSH Desktop
> # or: dsh plugin --profile web add dsh-retrace  # standalone Web
> ```
>
> **Option B — downloaded this repo as ZIP (or handing this link to an AI):**
> unpack it and run `dsh plugin --profile desktop add <folder>` — or install
> straight from GitHub, no unpacking:
>
> ```sh
> dsh plugin --profile desktop add github:yamingmou/dsh-retrace
> ```
>
> Follow [📦 Installation](#-installation) → *Manual install* for the exact
> file-edit steps.
>
> **Option C — no command line at all:** install the community plugin market
> once, then install dsh-retrace from its UI:
>
> ```sh
> dsh plugin --profile desktop add dshmarket   # one time
> ```
>
> Restart, then **Settings → Plugin Market** → search **dsh-retrace** →
> **Install** (one click). The market lists plugins from the curated
> [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
> registry; dsh-retrace is listed there.
>
> > ⚠️ **Restart required after install.** Quit and reopen **DSH Desktop**
> > (or restart the `dsh` process for a standalone Web deployment) — a running
> > app keeps the previous bundle in memory and will not hot-reload it.
>
> Hover any assistant reply → **↩ / ↻**; any user message → **✎** — that's it.

DeepSeek Harness stores every conversation as an **append-only event log**, so there is
no built-in "undo". `dsh-retrace` brings back the three moves every chat deserves —
**撤回 (recall)**, **编辑重发 (edit-and-resend)**, **重新生成 (regenerate)** — and then
goes further: because a recall only rewinds the **context**, while files the agent
already changed stay changed, retrace versions your conversation **and its artifacts**
in one place.

**What makes it different from a plain "undo / fork-graph / verify" plugin:**

- **Edits never dirty your log.** Every rewind is written through a **pre-write
  contract guard** (three-layer validation before commit), edits auto-stop the running
  agent via the official `cancel`/`whenIdle` API, and turn-interval markers are wrapped
  in a temporary step — so rewinds stay legal for the official token meter and never
  break `/compact` (a failure mode that silently corrupts sessions in other tools).
- **Deep offline checks, not shallow ones.** The companion `dsh-log-contract` ships
  30+ contract rules (token-meter pairing, cross-step source references, physical
  order, inbox replay…) validated against real corrupted-session fixtures — it catches
  the class of problem that makes the official `/compact` permanently fail, which a
  generic "orphan tool call" linter cannot see.
- **Detect → repair → guard loop.** Watchdog snapshots the log at the first sign of
  concurrent writes; offline `fix` neutralizes problem markers and clips cross-step
  references in place; pre-write validation stops bad events before they land.

Recall / edit **remove the target messages from the conversation view and the model
context** — that is exactly the effect you see. What stays untouched is the underlying
**durable transcript**: it remains append-only, old events are never rewritten or deleted,
and the plugin merely appends one valid replacement event (the same `replace` primitive
the built-in compaction uses) to rewind the surface — so the log keeps a full audit trail
of every rewind. On top of that trail, retrace records version boundaries, touched files
and (optionally) git state, and lets you roll back artifacts or jump back to any point
in the conversation — all **inside the same session**, no session-switching.

> ✅ **Timeline + artifact rollback + safe-edit guard are live (0.4.x)** — recall / edit /
> regenerate, the version timeline, artifact rollback (git-first, snapshot
> fallback), jump-to-conversation, marker pre-write validation (three-layer
> contract guard) and the real-time watchdog are all in. The fork map (P2) is in
> progress per [PLAN.md](./PLAN.md).

---

## ✨ Features

| Action | Where | What happens |
| --- | --- | --- |
| **↩ 撤回** (recall) | hover any assistant reply, or the row under any user message | Removes the **whole exchange round** (the input **and** the agent's output, tool rows included) from both the model context and the conversation view; the input text is echoed into the composer so you can re-ask or re-edit immediately. A small transient notice marks the rewind and disappears once you keep typing. |
| **✎ 编辑重发** (edit & re-send) | row under any user message | The edited round is rewound and the new text is re-sent. By default **only the edited round** is replaced — earlier history stays visible; the optional "fresh conversation" setting rewinds the whole surface (earlier messages then leave the model context, and stay visible in the view as a marker notice by default). A collapsed **"original input"** reference sits right under the new message — click to expand, configurable off. |
| **↻ 重新生成** (regenerate) | hover any assistant reply | The reply (and everything after it) is rewound and hidden, then the original prompt is re-sent so the agent answers again. |

**Versioning & rollback (live in 0.4.x)** — every rewind is also recorded as a **version**:

- 🕘 **Timeline** — a **Versions** tab in the conversation view (on par with the official 对话/轨迹 tabs, since 0.4.2): every version (type, time, message count, file-change badges, summary), pushed live via `session/projection` (no polling), windowed for long histories; event inspection reuses the official Trajectory ledger.
- ↩️ **Artifact rollback** — each version offers **context-only / artifacts-only / both** rollback with a dry-run preview; git-first (commit-free checkout of the listed paths) with content-addressed snapshot fallback. The rollback itself is recorded as a new version (`restore`) — rollback of a rollback.
- 🧭 **Jump-to-conversation** — one click from a version to that point in the conversation (auto-loads earlier history, anchor highlight).
- 🧹 **Bounded storage** — file snapshots keep the most recent N versions (default 50); a throttled background sweep prunes snapshots of truncated versions, keeping long sessions bounded.

**Why it's different**

- 🎯 **Whole-round recall** — one click removes the input *and* its output (including tool rows), not just a single bubble.
- 🖥️ **Web + Desktop** — the same plugin covers both surfaces of DeepSeek Harness.
- 🔒 **Removed from view & context, not from the log** — recalled/edited messages disappear from the conversation view and the model context, while the durable transcript is never rewritten or deleted; the plugin only appends valid, typed session events (the same `replace` primitive the built-in compaction uses), so the log keeps a full audit trail.
- 🧠 **View ⇄ context in sync** — the conversation view always reflects exactly what the agent sees.
- ⚡ **Try in 30 seconds** — the dynamic form installs in your current session with no rebuild.

---

## 🚀 Quick start

The one-line install is at the top of this page (**⚡ Install in one minute**).
This section covers the same ground with more detail.

> Requires DeepSeek Harness with the `dsh` CLI. Installs the plugin as a profile
> bundle and automatically rebuilds the Web client:

```sh
# DSH Desktop (desktop profile)
dsh plugin --profile desktop add dsh-retrace

# standalone Web (`dsh web` / web profile)
dsh plugin --profile web add dsh-retrace
```

> ⚠️ **Restart after install.** A running app keeps the previously loaded bundle
> in memory, so **quit and reopen DSH Desktop** (or restart the `dsh` process for
> a standalone Web deployment) before the plugin activates.

After the restart, hover any assistant reply, or any user message, and use ↩ / ✎ / ↻.

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
     (编辑 / 撤回 row with an inline editor); recall echoes the text into the
     composer,
   - the `recall-marker` node renderer: a notice row that injects CSS hiding
     every shadowed message row from the flow (view and model context stay in
     sync), plus the optional original-input comparison block,
   - the `retrace` entry in the `conversation.chat.assistant-actions`
     strip (撤回 / 重新生成),
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


## 🧭 会话日志考古（retrace CLI）

DSH 会话日志持久化了每次工具调用的完整输入输出——数据资产与审计资产。
`retrace` CLI 提供只读考古能力（复用 dsh-log-contract 0.3.0 的契约与提取）：

```sh
retrace index <session>                        # 工具调用索引（A1）
retrace query <session> --cmd "seed-scale"     # 按命令正则查输出（A1）
retrace extract <session> --pattern "seed-scale" --out ./found   # 导出输出（A2）
retrace file-history <session> <path>          # 文件 write/edit 历史版本（A3）
retrace file-diff <session> <path> 0 5         # 两版本行级 diff（A3）
retrace lineage <session>                      # 会话 parent 链谱系（A4）
```

<session> 为完整日志路径或 sessionId（自动在 ~/.dsh/sessions 查找）。全部只读。

**分叉图里的会话谱系（A4,UI）**：Fork map 视图头部展示当前会话的
`parentSession` 接续链（当前会话 → 父 → 根,`←` 方向）。数据来自
`GET /api/plugins/retrace/lineage?sessionId=`（只读 header 遍历,带环保护）,
与 CLI `retrace lineage` 同一语义。这样"这个会话是从哪个会话接着干/分叉出来的"
在界面上一眼可见——也是分叉图拓扑的元数据源。
