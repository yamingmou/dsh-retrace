# PATCH-NOTES — desktop-patch provenance

> **Metadata only.** This file records *what a desktop patch is based on, what it targets, what it changes, and any caveats*.
> It never carries executable logic, and the machine-readable twin is `package.json` → `dshDesktopPatch`.
> Copy this template per release and keep `target.version` equal to `package.json.version` (the gate `test/patch-provenance.test.js` enforces it).

## How to fill this template (per release)

| field | rule |
|---|---|
| `basedOn` | the package + version this patch is derived FROM (upstream, not this repo) |
| `target` | this package + the version it becomes; `target.version` MUST equal `package.json.version` |
| `changes` | one line per behaviour change, naming the module (`http`, `client-config`, `compat`, …) and the observable effect; no file paths with owner accounts, no ad-hoc counts |
| `notes` | caveats + the rule that applies when cutting the next release |
| `target.host` | MUST mirror `package.json` → `dsh.compatibility.dsh` (single numeric statement of the supported host line) |

Rules: **metadata only** (no executable logic, no build steps), keep the four
headings below, and let `test/patch-provenance.test.js` + `scripts/check-compat-matrix.mjs`
be the drift check instead of a manual review.

## basedOn
- package: `dsh-retrace (upstream base)`
- version: `0.4.138`

## target
- package: `dsh-retrace`
- version: `0.4.146`
- host: `>=0.1.5 <0.3.0` (mirrors `dsh.compatibility.dsh`)

## changes
- `http`: require a loopback socket peer plus a same-origin Host/Origin gate; a non-loopback peer, a forged Host or a bad Origin is rejected with **403** (fail-closed).
- `http`: the prewrite guard is **host-only** — the client header can neither enable nor disable it.
- `http`: the `fold` endpoint requires a **raw safe-integer range** (400 on invalid) and strips a caller-supplied span.
- `client-config`: retention bounds unified to **5..500** (step 5) between the store clamp and the number-input markup.
- `client-config`: multi-tab sync — read-merge before every write, refresh after the write, and a `storage` listener.
- `compat`: the matrix gate now covers **non-`@deepseek-ai/dsh*`** dependencies with explicit WARN/FAIL (never a silent skip), and it runs inside `pnpm check`.
- `client`: attachment ids are checked for resolvability against the draft registry before they reach the composer — an id the registry does not hold is never sent (visible notice + host log, text still restored).
- `metrics`: four read-only cache metrics added — per-request tools sha16, cacheRead drop attribution by request reason (`initial`/`resume`/`change`/`series`), injected-block visible count (`turn=null` + AGENTS signature), and `cacheWriteTokens`; no dedupe/scrub/folding.

## notes
- The changes above are compatible with the previous behaviour for every *legal* request; only boundary violations change (they become explicit 403/400 rather than being accepted).
- The host-only prewrite guard is a behaviour change for callers that used the header to disable it: that header is now ignored by design.
- When cutting a release, bump `target.version` here **and** in `package.json`; the provenance test fails on drift.
- This template deliberately names the upstream base only by package/version (no account name): the public projection's leak gate rejects repository-owner handles outside the audited `README`/`CHANGELOG`/`package.json` entries.
