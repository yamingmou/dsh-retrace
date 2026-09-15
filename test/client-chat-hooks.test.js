/**
 * dsh-retrace — chat hook behaviour tests (2026-09-14 live-incident regression).
 *
 * The live bug: every message-level slot (edit / recall / regenerate) never
 * appeared, while the settings slot did. Root cause: the six hooks below read
 * the chat nodes from `snapshot.chat.nodes` — but the chat snapshot returned by
 * the host's `useChat` selector carries its nodes at the TOP LEVEL
 * (`snapshot.nodes`, a Map of `{ key, kind, data, anchorSeq }`); the key
 * `snapshot.chat` does not exist anywhere in the host. The first render threw a
 * TypeError, the error boundary swallowed it, and the buttons never mounted.
 * The previous 694 green tests never touched these hooks, so the bug shipped.
 *
 * ── How the private hooks are reached without touching lib/ ─────────────────
 * The six hooks are module-private. Rather than modify `lib/client.js` (not
 * allowed), this file bundles the REAL source text at test time with esbuild
 * (a devDependency, already used by scripts/build-client.mjs), appends the six
 * named exports, keeps `react` external, and evaluates the CJS output with an
 * injected `require`. The tests therefore run the real implementation as it
 * exists on disk — the mutation check below re-reads it on every run.
 *
 * Hook contract under test (first argument IS the selector):
 *   const useChat = (sel) => sel(chatSnapshot)
 *   chatSnapshot = { nodes: new Map([[key, node], ...]), order: [key, ...] }
 *   node = { key, kind, data, anchorSeq }
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

// Mocked so the registered slot components can be invoked as plain functions
// (they call useState/useEffect; no React renderer is needed for this contract).
vi.mock('react', () => ({
  // The panel error boundary is a CLASS component (React only supports
  // getDerivedStateFromError on classes), so the mock needs `Component`.
  Component: class { constructor(props) { this.props = props ?? {}; this.state = {} } setState() {} },
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn(),
  useRef: (value) => ({ current: value }),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  Fragment: Symbol('react.fragment'),
}))

import { apply, __setMessageEditorWire, zh, en } from '../lib/client.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLIENT_SOURCE_PATH = path.join(ROOT, 'lib', 'client.js')
const nodeRequire = createRequire(import.meta.url)

const HOOK_NAMES = [
  'useMessageSeq',
  'useSeqHidden',
  'useShadowed',
  'useMarkerHidePlan',
  'useMarkerDismissed',
  'useEditReference',
]

// HIGH-1 regression (2026-09-14 review): the jump path. Extracted the same way
// so the resolution logic runs against the real source without touching lib/.
// The row components / label helpers are extracted too (display-only) so the
// "each row explains itself" copy can be asserted on the real render output.
const JUMP_EXPORTS = [
  'keyOfSeqIn', 'resolveAnchorKey', 'reportJumpUnavailable', 'jumpToAnchor', 'useChatNodes', 'useChatOrder',
  'VersionRow', 'whyLabel', 'kindLabel',
  // Display-only helpers/components extracted so the completeness locks (R20–R35)
  // can assert on the REAL render output of the real source.
  'latestSeqOf', 'buildDisplayRows', 'indexTree', 'roundsOf', 'nodeTextOf', 'clipText', 'pathStartOf',
  'CheckpointRow', 'CurrentPathBlock', 'PreviewBox', 'quietRecordsOf', 'quietRunsOf',
  // Panel error boundary (2026-09-15 white-screen incident): the registration
  // wraps the view in it, so tests unwrap before asserting on the view's copy.
  'RetraceErrorBoundary',
  'QuietBlock', 'QuietRow', 'QuietRunRow',
  // Compact-row model (2026-09-15): one line list shared by the row renderer and
  // the row-height math, plus the windowing / scroll-anchoring helpers.
  'whatLineList', 'whatLineElement', 'hasArtifacts', 'visibleFrom', 'visibleTo', 'anchoredScrollTop', 'budgetOf',
  'indentOf', 'levelClassOf', 'jumpTargetOf',
  // 收起三处：开头/末尾是行（buildDisplayRows 的 expanded 行），悬浮那枚在视图层
  // （collapseHintOf 判定 + CollapseHint 渲染）；视口高度常量是两处共用的单一来源。
  'collapseHintOf', 'CollapseHint', 'LIST_VIEWPORT_H', 'clampIndex',
]
const EXTRACTED_EXPORTS = [...HOOK_NAMES, ...JUMP_EXPORTS]

const fakeReact = {
  // Same reason as the vi.mock above: the bundle declares the class-based error
  // boundary at module-evaluation time, so `Component` must exist here too.
  Component: class { constructor(props) { this.props = props ?? {}; this.state = {} } setState() {} },
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useRef: (value) => ({ current: value }),
}

let hooks

beforeAll(async () => {
  const source = readFileSync(CLIENT_SOURCE_PATH, 'utf8')
  // Driver self-check: fail loudly (never silently skip) if the source or the
  // esbuild extraction stops exposing the hooks / jump helpers.
  for (const name of EXTRACTED_EXPORTS) {
    // Most extras are declarations; the panel error boundary is a CLASS (React
    // only supports getDerivedStateFromError on class components).
    const declared = source.includes(`function ${name}(`) || source.includes(`class ${name} `)
      || source.includes(`const ${name} =`)
    expect(declared, `lib/client.js must declare ${name}`).toBe(true)
  }
  const bundled = await build({
    stdin: {
      contents: `${source}\nexport { ${EXTRACTED_EXPORTS.join(', ')} }\n`,
      loader: 'js',
      resolveDir: path.dirname(CLIENT_SOURCE_PATH),
      sourcefile: 'client.js',
    },
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    write: false,
    external: ['react'],
    logLevel: 'silent',
  })
  const code = bundled.outputFiles[0].text
  const mod = { exports: {} }
  const load = (id) => (id === 'react' ? fakeReact : nodeRequire(id))
  // eslint-disable-next-line no-new-func
  new Function('require', 'module', 'exports', code)(load, mod, mod.exports)
  for (const name of EXTRACTED_EXPORTS) {
    // 绝大多数是函数/类；视口高度是一个数字常量（窗口与悬浮条共用）。
    const kind = typeof mod.exports[name]
    expect(kind === 'function' || (name === 'LIST_VIEWPORT_H' && kind === 'number')).toBe(true)
  }
  hooks = mod.exports
  // Keep the clientReport self-report off the network (it fires on a microtask).
  __setMessageEditorWire(() => Promise.resolve({ ok: true }))
})

afterAll(() => {
  __setMessageEditorWire(null)
})

// ---------------------------------------------------------------------------
// Host-shaped fixtures
// ---------------------------------------------------------------------------
/** Snapshot shaped exactly like the host `useChat` selector payload. */
function chatSnapshot(entries) {
  const nodes = new Map(entries.map((node) => [node.key, node]))
  return { nodes, order: entries.map((node) => node.key) }
}
/** The fake hook the host passes into every component/hook as `useChat`. */
function useChatFor(snapshot) {
  return (selector) => selector(snapshot)
}
const mapSeqs = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i)

/** assistant-step carries the finalized node at `data.finalNode`. */
const assistantStep = (key, messageId, seq, extra = {}) => ({
  key, kind: 'assistant-step', anchorSeq: seq,
  data: { finalNode: { messageId, seq }, blocks: [], status: 'done', ...extra },
})
const userMessage = (key, seq) => ({
  key, kind: 'user-message', anchorSeq: seq,
  data: { seq, messageId: `u-${key}`, content: [{ type: 'text', text: `text ${seq}` }] },
})
/** Plugin pseudo-node for one user message; anchors at the message's own seq (lib/client.js:482). */
const userActions = (key, seq) => ({
  key, kind: 'user-actions', anchorSeq: seq, data: { seq, time: 0, messageId: `u-${key}`, content: [] },
})
/** A recall/edit/regenerate marker; the hide authority. */
const marker = (key, seq, shadowedSeqs, extra = {}) => ({
  key, kind: 'recall-marker', anchorSeq: seq,
  data: { seq, op: 'recall', shadowedSeqs, legacy: false, compact: false, ...extra },
})
/** turn-tail's finalized reply lives at `data.closing.finalNode`. */
const turnTail = (key, seq) => ({
  key, kind: 'turn-tail', anchorSeq: seq + 0.5, data: { closing: { finalNode: { seq } } },
})
/** tool-call anchors at the event seq; the surface seq is `data.root.seq`. */
const toolCall = (key, seq) => ({
  key, kind: 'tool-call', anchorSeq: seq + 0.5, data: { root: { seq } },
})
/** The plugin's "original input" pseudo-row anchors at `seq - 0.5`. */
const referenceRow = (key, seq) => ({
  key, kind: 'retrace-reference', anchorSeq: seq - 0.5,
  data: { seq, messageId: `u-${seq}`, content: [] },
})

// ---------------------------------------------------------------------------
// useMessageSeq(useChat, messageId)
// ---------------------------------------------------------------------------
describe('useMessageSeq — the durable seq of a finalized assistant reply', () => {
  it('returns data.finalNode.seq for the matching assistant-step', () => {
    const snap = chatSnapshot([
      userMessage('u1', 41),
      assistantStep('a1', 'msg-1', 42),
      assistantStep('a2', 'msg-2', 43),
    ])
    expect(hooks.useMessageSeq(useChatFor(snap), 'msg-2')).toBe(43)
    expect(hooks.useMessageSeq(useChatFor(snap), 'msg-1')).toBe(42)
  })

  it('returns undefined when no node carries that messageId', () => {
    const snap = chatSnapshot([assistantStep('a1', 'msg-1', 42)])
    expect(hooks.useMessageSeq(useChatFor(snap), 'missing')).toBeUndefined()
  })

  it('only accepts kind assistant-step (a turn-tail closing reply is not a match)', () => {
    // turn-tail carries the same messageId shape at data.closing.finalNode —
    // it must NOT be mistaken for the assistant-step's own finalNode.
    const tt = turnTail('tt', 9)
    tt.data.closing.finalNode = { messageId: 'msg-1', seq: 9 }
    const snap = chatSnapshot([tt])
    expect(hooks.useMessageSeq(useChatFor(snap), 'msg-1')).toBeUndefined()
  })

  it('returns undefined on an empty node map', () => {
    expect(hooks.useMessageSeq(useChatFor(chatSnapshot([])), 'msg-1')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// useSeqHidden(useChat, seq)
// ---------------------------------------------------------------------------
describe('useSeqHidden — visual hiding, guard-aware', () => {
  it('false when the row exists but is not shadowed by any marker', () => {
    const snap = chatSnapshot([userMessage('u1', 5), marker('m1', 6, [])])
    expect(hooks.useSeqHidden(useChatFor(snap), 5)).toBe(false)
  })

  it('true when a live marker shadows the row seq', () => {
    const snap = chatSnapshot([userMessage('u1', 5), marker('m1', 6, [5])])
    expect(hooks.useSeqHidden(useChatFor(snap), 5)).toBe(true)
  })

  it('false when seq is absent / undefined', () => {
    const snap = chatSnapshot([userMessage('u1', 5), marker('m1', 6, [5])])
    expect(hooks.useSeqHidden(useChatFor(snap), undefined)).toBe(false)
    expect(hooks.useSeqHidden(useChatFor(snap), null)).toBe(false)
    expect(hooks.useSeqHidden(useChatFor(snap), 999)).toBe(false)
  })

  it('degraded marker (would hide >40% of a >20-row conversation) hides nothing', () => {
    const rows = mapSeqs(1, 21).map((seq) => userMessage(`u${seq}`, seq))
    const snap = chatSnapshot([...rows, marker('m1', 100, mapSeqs(1, 21))])
    const useChat = useChatFor(snap)
    // Same seq is still SHADOWED (operation feasibility) but NOT hidden (visual).
    expect(hooks.useShadowed(useChat, 5)).toBe(true)
    expect(hooks.useSeqHidden(useChat, 5)).toBe(false)
  })

  it('the 40% guard does not trip for a large conversation with a small shadow', () => {
    const rows = mapSeqs(1, 30).map((seq) => userMessage(`u${seq}`, seq))
    const snap = chatSnapshot([...rows, marker('m1', 100, [5])])
    expect(hooks.useSeqHidden(useChatFor(snap), 5)).toBe(true)
  })

  it('compact markers never hide rows (but still shadow them)', () => {
    const snap = chatSnapshot([
      userMessage('u1', 5),
      marker('m1', 6, [5], { compact: true, op: 'fold' }),
    ])
    const useChat = useChatFor(snap)
    expect(hooks.useShadowed(useChat, 5)).toBe(true)
    expect(hooks.useSeqHidden(useChat, 5)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// useShadowed(useChat, seq)
// ---------------------------------------------------------------------------
describe('useShadowed — operation feasibility (un-editable)', () => {
  it('false for a non-number seq', () => {
    const snap = chatSnapshot([marker('m1', 6, [5])])
    expect(hooks.useShadowed(useChatFor(snap), undefined)).toBe(false)
    expect(hooks.useShadowed(useChatFor(snap), null)).toBe(false)
  })

  it('true only when a recall-marker data.shadowedSeqs contains the seq', () => {
    const snap = chatSnapshot([userMessage('u1', 5), marker('m1', 6, [5])])
    expect(hooks.useShadowed(useChatFor(snap), 5)).toBe(true)
    expect(hooks.useShadowed(useChatFor(snap), 6)).toBe(false)
  })

  it('ignores a non-marker node that happens to carry shadowedSeqs', () => {
    const impostor = {
      key: 'x', kind: 'user-message', anchorSeq: 5,
      data: { seq: 5, shadowedSeqs: [5] },
    }
    expect(hooks.useShadowed(useChatFor(chatSnapshot([impostor])), 5)).toBe(false)
  })

  it('ignores a marker whose shadowedSeqs is missing or not an array', () => {
    const snap = chatSnapshot([
      { key: 'm1', kind: 'recall-marker', anchorSeq: 6, data: { seq: 6, op: 'recall' } },
    ])
    expect(hooks.useShadowed(useChatFor(snap), 6)).toBe(false)
  })

  it('counts compact markers (compacted messages are un-editable too)', () => {
    const snap = chatSnapshot([
      marker('m1', 6, [5], { compact: true, op: 'fold' }),
    ])
    expect(hooks.useShadowed(useChatFor(snap), 5)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// useMarkerHidePlan(useChat)
// ---------------------------------------------------------------------------
describe('useMarkerHidePlan — per-marker hide plan + snapshot memo', () => {
  it('returns the frozen empty plan when the conversation has no live marker', () => {
    const plan = hooks.useMarkerHidePlan(useChatFor(chatSnapshot([userMessage('u1', 5)])))
    expect(plan.rowCount).toBe(0)
    expect(plan.unionRatio).toBe(0)
    expect(plan.firstMarkerKey).toBe(null)
    expect(plan.planFor('m1')).toBe(null)
    expect(plan.hiddenFor('m1')).toBe(null)
  })

  it('computes hidden keys for message rows, turn-tails, tool calls and plugin pseudo rows', () => {
    const snap = chatSnapshot([
      userMessage('u1', 7),
      assistantStep('a1', 'msg-1', 7),
      turnTail('tt', 7),
      toolCall('tc', 7),
      referenceRow('ref', 7),
      userActions('ua', 7),
      marker('m1', 8, [7]),
    ])
    const plan = hooks.useMarkerHidePlan(useChatFor(snap))
    expect(plan.planFor('m1').degraded).toBe(false)
    expect(plan.planFor('m1').keys).toEqual(expect.arrayContaining(['u1', 'a1', 'tt', 'tc', 'ref', 'ua']))
    expect(plan.hiddenFor('m1')).toEqual(plan.planFor('m1').keys)
    // u1 + a1 + tt + tc count as real rows; user-actions/retrace-reference/recall-marker are pseudo nodes.
    expect(plan.rowCount).toBe(4)
  })

  it('applies the 40% guard PER MARKER, independently', () => {
    const rows = mapSeqs(1, 30).map((seq) => userMessage(`u${seq}`, seq))
    const snap = chatSnapshot([
      ...rows,
      marker('mGood', 100, [1]), // 1/30 rows → fine
      marker('mBad', 101, mapSeqs(2, 26)), // 25/30 rows → degraded
    ])
    const plan = hooks.useMarkerHidePlan(useChatFor(snap))
    expect(plan.rowCount).toBe(30)
    expect(plan.firstMarkerKey).toBe('mGood')
    expect(plan.planFor('mGood').degraded).toBe(false)
    expect(plan.planFor('mGood').keys).toEqual(['u1'])
    expect(plan.planFor('mBad').degraded).toBe(true)
    expect(plan.planFor('mBad').keys).toBe(null)
    expect(plan.hiddenFor('mBad')).toBe(null)
    // unionRatio still counts the degraded marker's keys collectively.
    expect(plan.unionRatio).toBeCloseTo(26 / 30, 5)
  })

  it('excludes compact markers from the marker table', () => {
    const snap = chatSnapshot([
      userMessage('u1', 5),
      marker('mCompact', 6, [5], { compact: true, op: 'fold' }),
      marker('mReal', 7, []),
    ])
    const plan = hooks.useMarkerHidePlan(useChatFor(snap))
    expect(plan.firstMarkerKey).toBe('mReal')
    expect(plan.planFor('mCompact')).toBe(null)
  })

  it('memoises per snapshot reference (same snapshot → same plan object)', () => {
    const nodes = [userMessage('u1', 1), marker('m1', 2, [1])]
    const snapshot = chatSnapshot(nodes)
    const first = hooks.useMarkerHidePlan(useChatFor(snapshot))
    const second = hooks.useMarkerHidePlan(useChatFor(snapshot))
    expect(second).toBe(first)
    const other = hooks.useMarkerHidePlan(useChatFor(chatSnapshot(nodes)))
    expect(other).not.toBe(first)
  })
})

// ---------------------------------------------------------------------------
// useMarkerDismissed(useChat, markerSeq, op)
// ---------------------------------------------------------------------------
describe('useMarkerDismissed — the notice disappears after the user keeps typing', () => {
  it('false when markerSeq is not a number', () => {
    const snap = chatSnapshot([userActions('ua1', 10)])
    expect(hooks.useMarkerDismissed(useChatFor(snap), undefined, 'recall')).toBe(false)
    expect(hooks.useMarkerDismissed(useChatFor(snap), null, 'edit')).toBe(false)
  })

  it('recall: dismissed after ONE later user message (strictly after the marker seq)', () => {
    expect(hooks.useMarkerDismissed(useChatFor(chatSnapshot([userActions('ua1', 10)])), 10, 'recall')).toBe(false)
    expect(hooks.useMarkerDismissed(useChatFor(chatSnapshot([userActions('ua1', 10)])), 9, 'recall')).toBe(true)
  })

  it('edit: the automatic re-send does not dismiss; a SECOND later message does', () => {
    const one = chatSnapshot([userActions('ua1', 10)])
    const two = chatSnapshot([userActions('ua1', 10), userActions('ua2', 11)])
    expect(hooks.useMarkerDismissed(useChatFor(one), 9, 'edit')).toBe(false)
    expect(hooks.useMarkerDismissed(useChatFor(two), 9, 'edit')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// useEditReference(useChat, mySeq)
// ---------------------------------------------------------------------------
describe('useEditReference — original text of the edit that produced this message', () => {
  it('null for a non-number mySeq', () => {
    const snap = chatSnapshot([marker('m1', 3, [], { op: 'edit', text: 'A' })])
    expect(hooks.useEditReference(useChatFor(snap), undefined)).toBe(null)
  })

  it('returns the nearest preceding edit marker text when no user message intervenes', () => {
    const snap = chatSnapshot([marker('m1', 3, [], { op: 'edit', text: 'ORIGINAL' })])
    expect(hooks.useEditReference(useChatFor(snap), 6)).toBe('ORIGINAL')
    // a user message BEFORE the marker is fine
    const withEarlier = chatSnapshot([
      userActions('ua0', 1),
      marker('m1', 3, [], { op: 'edit', text: 'ORIGINAL' }),
    ])
    expect(hooks.useEditReference(useChatFor(withEarlier), 6)).toBe('ORIGINAL')
  })

  it('null when another user message sits between the marker and mySeq (not the re-send)', () => {
    const snap = chatSnapshot([
      marker('m1', 3, [], { op: 'edit', text: 'ORIGINAL' }),
      userActions('ua1', 5),
    ])
    expect(hooks.useEditReference(useChatFor(snap), 6)).toBe(null)
  })

  it('only op === "edit" markers count, and only with non-empty text', () => {
    const recall = chatSnapshot([marker('m1', 3, [], { op: 'recall', text: 'ORIGINAL' })])
    expect(hooks.useEditReference(useChatFor(recall), 6)).toBe(null)
    const empty = chatSnapshot([marker('m1', 3, [], { op: 'edit', text: '' })])
    expect(hooks.useEditReference(useChatFor(empty), 6)).toBe(null)
  })

  it('ignores markers at or after mySeq and picks the nearest preceding one', () => {
    const snap = chatSnapshot([
      marker('m1', 3, [], { op: 'edit', text: 'first' }),
      marker('m2', 4, [], { op: 'edit', text: 'second' }),
      marker('m3', 6, [], { op: 'edit', text: 'after' }),
    ])
    expect(hooks.useEditReference(useChatFor(snap), 6)).toBe('second')
    expect(hooks.useEditReference(useChatFor(snap), 3)).toBe(null)
  })
})

// ---------------------------------------------------------------------------
// Negative control — the regression this suite exists for
// ---------------------------------------------------------------------------
describe('negative control: nodes must come from snapshot.nodes, never snapshot.chat', () => {
  it('a chat-shaped snapshot with NO `chat` key at all is read via snapshot.nodes', () => {
    // Under the old implementation (`snapshot.chat.nodes`) this throws.
    const snap = chatSnapshot([assistantStep('a1', 'msg-1', 42), marker('m1', 43, [42]), userMessage('u1', 7)])
    expect(snap.chat).toBeUndefined()
    const useChat = useChatFor(snap)
    expect(hooks.useMessageSeq(useChat, 'msg-1')).toBe(42)
    expect(hooks.useShadowed(useChat, 42)).toBe(true)
    expect(hooks.useSeqHidden(useChat, 7)).toBe(false)
  })

  it('touching snapshot.chat throws — the hooks must never touch it (booby-trapped payload)', () => {
    const nodes = new Map([
      ['a1', assistantStep('a1', 'msg-1', 42)],
      ['u1', userMessage('u1', 7)],
      ['m1', marker('m1', 8, [7])],
    ])
    const sessionish = new Proxy(
      { queue: {}, status: 'idle', sessionId: 's1', nodes, order: [...nodes.keys()] },
      {
        get(target, prop, receiver) {
          if (prop === 'chat') throw new Error('hook read snapshot.chat — nodes must come from snapshot.nodes')
          return Reflect.get(target, prop, receiver)
        },
      },
    )
    const useChat = useChatFor(sessionish)
    expect(hooks.useMessageSeq(useChat, 'msg-1')).toBe(42)
    expect(hooks.useShadowed(useChat, 7)).toBe(true)
    expect(hooks.useSeqHidden(useChat, 7)).toBe(true)
    expect(hooks.useMarkerDismissed(useChat, 1, 'recall')).toBe(false)
    expect(hooks.useEditReference(useChat, 7)).toBe(null)
    expect(hooks.useMarkerHidePlan(useChat).rowCount).toBe(2)
  })

  it('decoy chat.nodes is ignored when a top-level nodes map exists', () => {
    // Old code returned the decoy seq (99); the fix must return the top-level 42.
    const snap = chatSnapshot([assistantStep('real', 'msg-1', 42)])
    snap.chat = { nodes: new Map([['decoy', assistantStep('decoy', 'msg-1', 99)]]) }
    expect(hooks.useMessageSeq(useChatFor(snap), 'msg-1')).toBe(42)

    const withMarkers = chatSnapshot([userMessage('u1', 7)])
    withMarkers.chat = {
      nodes: new Map([['decoy-marker', marker('decoy-marker', 8, [7])]]),
    }
    expect(hooks.useShadowed(useChatFor(withMarkers), 7)).toBe(false)
    expect(hooks.useSeqHidden(useChatFor(withMarkers), 7)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Component wiring — the buttons actually mount with a host-shaped snapshot
// ---------------------------------------------------------------------------
function collect(node, out = []) {
  if (Array.isArray(node)) {
    for (const child of node) collect(child, out)
    return out
  }
  if (node && typeof node === 'object' && node.type !== undefined) {
    out.push(node)
    for (const child of node.children ?? []) collect(child, out)
  }
  return out
}
function captureSlotComponents() {
  const registered = []
  const ctx = {
    effect: (fn) => {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    locale: { register: () => () => {}, bind: () => (key) => key },
    get: () => undefined,
    inject: () => () => {},
    slots: {
      inject: (_seat, callback) => {
        callback()
        return () => {}
      },
      register: (config, Component) => {
        registered.push({ config, Component })
        return () => {}
      },
    },
  }
  apply(ctx)
  return registered
}

describe('slot components mount with a host-shaped chat snapshot', () => {
  const isBoundary = (type) => typeof type === 'function' && typeof type.getDerivedStateFromError === 'function'
  const findComponent = (seat, key) => {
    const entry = captureSlotComponents().find(({ config }) => (
      config.name === seat && (key === undefined || config.key === key)
    ))
    expect(entry, `no registration for ${seat}${key ? ` key=${key}` : ''}`).toBeDefined()
    // Every surface is wrapped in the panel error boundary (2026-09-15); these
    // tests are about the surface itself, so unwrap it.
    const wrapped = entry.Component({ t: (k) => k })
    if (wrapped && isBoundary(wrapped.type)) return (wrapped.children ?? [])[0].type
    return entry.Component
  }
  const t = (key) => key

  it('AssistantActions renders 撤回 / 重新生成 when the message seq resolves', () => {
    const AssistantActions = findComponent('conversation.chat.assistant-actions')
    const snap = chatSnapshot([assistantStep('a1', 'msg-1', 42)])
    const element = AssistantActions({ messageId: 'msg-1', sessionId: 's1', useChat: useChatFor(snap), t })
    const buttons = collect(element).filter((node) => node.type === 'button')
    expect(buttons.map((button) => button.props.title)).toEqual(['action.recallAssistant', 'action.regenerate'])
  })

  it('AssistantActions renders nothing when the messageId is absent or the reply is shadowed', () => {
    const AssistantActions = findComponent('conversation.chat.assistant-actions')
    expect(AssistantActions({ messageId: 'nope', sessionId: 's1', useChat: useChatFor(chatSnapshot([])), t })).toBe(null)
    const shadowed = chatSnapshot([assistantStep('a1', 'msg-1', 42), marker('m1', 43, [42])])
    expect(AssistantActions({ messageId: 'msg-1', sessionId: 's1', useChat: useChatFor(shadowed), t })).toBe(null)
  })

  it('UserActionsRow renders 编辑 / 撤回 unless hidden or shadowed', () => {
    const UserActionsRow = findComponent('conversation.chat.node', 'user-actions')
    const node = userMessage('u1', 5)
    const visible = UserActionsRow({ node, sessionId: 's1', useChat: useChatFor(chatSnapshot([node])), inputActions: {}, t })
    const buttons = collect(visible).filter((element) => element.type === 'button')
    expect(buttons.map((button) => button.props.className)).toEqual(['dsh-rt-chip', 'dsh-rt-chip'])
    const hidden = chatSnapshot([node, marker('m1', 6, [5])])
    expect(UserActionsRow({ node, sessionId: 's1', useChat: useChatFor(hidden), inputActions: {}, t })).toBe(null)
  })

  it('ReferenceRow renders the original input from an edit marker', () => {
    const ReferenceRow = findComponent('conversation.chat.node', 'retrace-reference')
    const ref = referenceRow('ref', 5)
    const snap = chatSnapshot([ref, marker('m1', 3, [], { op: 'edit', text: 'ORIGINAL' })])
    const element = ReferenceRow({ node: ref, useChat: useChatFor(snap), t })
    const summary = collect(element).find((element) => element.type === 'summary')
    expect(summary.children).toContain('marker.originalLabel：ORIGINAL')
    expect(ReferenceRow({ node: ref, useChat: useChatFor(chatSnapshot([ref])), t })).toBe(null)
  })

  it('RecallMarkerRow emits the hide rules for its shadowed keys and its notice label', () => {
    const RecallMarkerRow = findComponent('conversation.chat.node', 'recall-marker')
    const node = marker('m1', 6, [5])
    const snap = chatSnapshot([userMessage('u1', 5), node])
    const element = RecallMarkerRow({ node, useChat: useChatFor(snap), t })
    const styles = collect(element).filter((element) => element.type === 'style')
    expect(styles).toHaveLength(1)
    expect(styles[0].props.dangerouslySetInnerHTML.__html)
      .toContain('[data-chat-anchor-key="u1"]{display:none!important}')
    expect(collect(element).some((element) => element.props.role === 'status')).toBe(true)
  })

  it('RecallMarkerRow is inert for compact markers and legacy markers emit no hide rules', () => {
    const RecallMarkerRow = findComponent('conversation.chat.node', 'recall-marker')
    const compact = marker('m1', 6, [5], { compact: true, op: 'fold' })
    expect(RecallMarkerRow({ node: compact, useChat: useChatFor(chatSnapshot([compact])), t })).toBe(null)
    const legacy = marker('m1', 6, [5], { legacy: true })
    const element = RecallMarkerRow({ node: legacy, useChat: useChatFor(chatSnapshot([userMessage('u1', 5), legacy])), t })
    expect(collect(element).filter((node) => node.type === 'style')).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// HIGH-1 regression (2026-09-14 independent review B1): jumpToAnchor read
// `store.getSnapshot()?.chat?.nodes` — a field the client Session controller's
// snapshot does not have ⇒ keyOfSeq was always null ⇒ every 版本/Fork 视图
// 「跳转」 silently did nothing. The node source is now the `useChat` standard
// prop; paging uses the host jump loader `store.loadThrough(seq)`.
// ---------------------------------------------------------------------------
describe('resolveAnchorKey — jump lookup rides the chat source, never the session snapshot', () => {
  const nodeAt = (key, seq) => ({ key, kind: 'user-message', anchorSeq: seq, data: { seq } })
  const mapOf = (...nodes) => new Map(nodes.map((node) => [node.key, node]))

  it('resolves the key from the injected chat-node source (already loaded)', async () => {
    const nodes = mapOf(nodeAt('u1', 5))
    // Decoy store: its snapshot has NO nodes (the real client Session controller
    // shape). The old `getSnapshot()?.chat?.nodes` read returned undefined here.
    const store = { hasMore: true, getSnapshot: () => ({ queue: {}, running: false }), loadOlder: async () => {} }
    const result = await hooks.resolveAnchorKey({ anchorSeq: 5, store, readNodes: () => nodes, budget: 5 })
    expect(result).toEqual({ key: 'u1', reason: 'already-loaded', pages: 0 })
  })

  it('never touches store.getSnapshot or a snapshot.chat member (booby-trapped store)', async () => {
    const nodes = mapOf(nodeAt('u1', 5))
    const store = new Proxy(
      { hasMore: true, loadThrough: async () => {}, loadOlder: async () => {} },
      {
        get(target, prop, receiver) {
          if (prop === 'getSnapshot' || prop === 'chat') {
            throw new Error(`resolveAnchorKey read store.${String(prop)} — nodes must come from the injected chat source`)
          }
          return Reflect.get(target, prop, receiver)
        },
      },
    )
    const result = await hooks.resolveAnchorKey({ anchorSeq: 5, store, readNodes: () => nodes })
    expect(result).toEqual({ key: 'u1', reason: 'already-loaded', pages: 0 })
  })

  it('pages with the host jump loader loadThrough(seq), not loadOlder', async () => {
    let nodes = new Map()
    const calls = []
    const store = {
      hasMore: true,
      loadThrough: async (seq) => { calls.push(`through:${seq}`); nodes = mapOf(nodeAt('u1', 5)) },
      loadOlder: async () => { calls.push('older') },
    }
    const result = await hooks.resolveAnchorKey({ anchorSeq: 5, store, readNodes: () => nodes, budget: 5 })
    expect(calls).toEqual(['through:5'])
    expect(result).toMatchObject({ key: 'u1', reason: 'load-through', pages: 1 })
  })

  it('falls back to one-page loadOlder when the host has no loadThrough', async () => {
    let nodes = new Map()
    let pages = 0
    const store = { hasMore: true, loadOlder: async () => { pages += 1; nodes = mapOf(nodeAt('u1', 5)) } }
    const result = await hooks.resolveAnchorKey({ anchorSeq: 5, store, readNodes: () => nodes, budget: 5 })
    expect(pages).toBe(1)
    expect(result).toMatchObject({ key: 'u1', reason: 'paged', pages: 1 })
  })

  it('reports no-node-source (never throws) when the view received no useChat', async () => {
    const result = await hooks.resolveAnchorKey({ anchorSeq: 5, store: { loadOlder: async () => {} }, readNodes: undefined })
    expect(result).toEqual({ key: null, reason: 'no-node-source', pages: 0 })
  })

  it('reports a diagnosable reason (seq-not-in-window) instead of silently returning', async () => {
    const nodes = mapOf(nodeAt('u1', 5))
    const store = { hasMore: true, loadOlder: async () => {} } // empty page → bounded stop
    const result = await hooks.resolveAnchorKey({ anchorSeq: 99, store, readNodes: () => nodes, budget: 3 })
    expect(result).toEqual({ key: null, reason: 'seq-not-in-window', pages: 1 })
  })

  it('keyOfSeqIn is shape-tolerant', () => {
    expect(hooks.keyOfSeqIn(mapOf(nodeAt('u1', 5)), 5)).toBe('u1')
    expect(hooks.keyOfSeqIn(mapOf(nodeAt('u1', 5)), 6)).toBe(null)
    expect(hooks.keyOfSeqIn(undefined, 5)).toBe(null)
    expect(hooks.keyOfSeqIn({ size: 0 }, 5)).toBe(null)
    expect(hooks.keyOfSeqIn(new Map([['x', { key: 'x', anchorSeq: '5' }]]), 5)).toBe(null)
  })

  it('reportJumpUnavailable is NOT silent: renderer warning + a host-log line via clientReport', async () => {
    const reports = []
    // The extracted copy carries its own module-level wire — set THAT one.
    hooks.__setMessageEditorWire((op, payload) => { reports.push({ op, payload }); return Promise.resolve({ ok: true }) })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      hooks.reportJumpUnavailable('no-node-source', { anchorSeq: 7, pages: 0, hasNodeSource: false })
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0][0])).toContain('reason=no-node-source')
      expect(reports.at(-1)).toMatchObject({
        op: 'clientReport',
        payload: { id: 'dsh-retrace', source: 'jump-unavailable:no-node-source' },
      })
    } finally {
      warn.mockRestore()
      hooks.__setMessageEditorWire(null)
    }
  })

  it('a throwing loader becomes reason load-failed instead of an unhandled rejection', async () => {
    const thrower = async () => { throw new Error('loader boom') }
    const through = await hooks.resolveAnchorKey({
      anchorSeq: 5, store: { hasMore: true, loadThrough: thrower, loadOlder: async () => {} },
      readNodes: () => new Map(), budget: 3,
    })
    expect(through).toEqual({ key: null, reason: 'load-failed', pages: 0 })
    const older = await hooks.resolveAnchorKey({
      anchorSeq: 5, store: { hasMore: true, loadOlder: thrower },
      readNodes: () => new Map(), budget: 3,
    })
    expect(older).toEqual({ key: null, reason: 'load-failed', pages: 0 })
  })
})

describe('useChatNodes — the useChat prop is read through one unconditional hook', () => {
  it('subscribes through a real useChat and selects snapshot.nodes', () => {
    const nodes = new Map([['a', { key: 'a', anchorSeq: 1, data: {} }]])
    const snapshot = { nodes }
    const seen = []
    const useChat = (selector) => { const value = selector(snapshot); seen.push(value); return value }
    expect(hooks.useChatNodes(useChat)).toBe(nodes)
    expect(seen).toEqual([nodes])
  })

  it('yields undefined (never throws) when the host supplies no useChat', () => {
    expect(hooks.useChatNodes(undefined)).toBeUndefined()
    expect(hooks.useChatNodes(null)).toBeUndefined()
    expect(hooks.useChatNodes('not-a-hook')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// HIGH-A regression (2026-09-14 second review): the node source is the CALLING
// view's ref, and the host renders one conversation view at a time — so
// switching tabs UNMOUNTS the view and freezes the ref. Resolving after the
// switch therefore always failed whenever paging was needed. The tests below
// model the freeze faithfully (the 7 earlier resolveAnchorKey cases fed a test
// closure that the mock store mutated directly → structurally unable to catch
// this), and cover the failure-path tab semantics.
// ---------------------------------------------------------------------------
describe('jumpToAnchor — resolve BEFORE the tab switch (unmount freezes the ref)', () => {
  const nodeAt = (key, seq) => ({ key, kind: 'user-message', anchorSeq: seq, data: { seq } })

  /**
   * Minimal DOM for `switchToViewTab` + `waitForElement` + `flashKey`.
   * Switching to the chat tab (index 0) sets `state.switched`, which the test
   * uses to model the plugin view being unmounted.
   */
  function installDom({ rowPresent = true } = {}) {
    const state = { switched: false, scrolls: 0, anchorSelectors: [] }
    const row = { scrollIntoView: () => { state.scrolls += 1 }, closest: () => null, dataset: {} }
    const tabs = [0, 1, 2, 3].map((index) => ({ click: () => { if (index === 0) state.switched = true } }))
    const tablist = { getBoundingClientRect: () => ({ width: 100 }), querySelectorAll: () => tabs }
    const previous = { document: globalThis.document, requestAnimationFrame: globalThis.requestAnimationFrame }
    globalThis.document = {
      querySelectorAll: (selector) => (selector === '[role="tablist"]' ? [tablist] : []),
      querySelector: (selector) => {
        if (selector.startsWith('[data-chat-anchor-key=')) state.anchorSelectors.push(selector)
        // With rowPresent the row is always found: waitForElement resolves on the
        // first probe, and flashKey early-returns on its "style already present"
        // probe (no timer). With rowPresent:false the frame budget runs out.
        return rowPresent ? row : null
      },
      createElement: () => ({ dataset: {}, style: {}, appendChild() {}, remove() {} }),
      head: { appendChild() {} },
    }
    // Synchronous rAF so waitForElement resolves immediately.
    globalThis.requestAnimationFrame = (callback) => { callback(); return 0 }
    return {
      state,
      restore: () => {
        globalThis.document = previous.document
        globalThis.requestAnimationFrame = previous.requestAnimationFrame
      },
    }
  }

  it('resolves a NOT-yet-loaded key before switching tabs, though the ref freezes on unmount', async () => {
    // Faithful wiring model: `readNodes` is the view's chatNodesRef. It is
    // refreshed only when the view RENDERS, and the view renders only while
    // mounted. The store's window load always happens; whether the REF sees it
    // depends on whether the tab switch (unmount) already happened.
    let refNodes = new Map()
    const store = {
      hasMore: true,
      async loadThrough(seq) {
        const page = new Map([[`u${seq}`, nodeAt(`u${seq}`, seq)]])
        if (!dom.state.switched) refNodes = page // a render happened → ref updated
      },
      async loadOlder() {},
    }
    const dom = installDom()
    hooks.__setMessageEditorWire(() => Promise.resolve({ ok: true }))
    try {
      await hooks.jumpToAnchor(store, 5, () => refNodes)
      expect(dom.state.switched, 'the tab must switch once the key is known').toBe(true)
      expect(dom.state.scrolls, 'the resolved row must be scrolled into view').toBe(1)
      expect(dom.state.anchorSelectors).toContain('[data-chat-anchor-key="u5"]')
    } finally {
      hooks.__setMessageEditorWire(null)
      dom.restore()
    }
  })

  it('does NOT switch tabs when the key cannot be resolved (stay where the user is)', async () => {
    const dom = installDom()
    const reports = []
    hooks.__setMessageEditorWire((op, payload) => { reports.push({ op, payload }); return Promise.resolve({ ok: true }) })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await hooks.jumpToAnchor({ hasMore: true, loadOlder: async () => {} }, 5, undefined)
      expect(dom.state.switched, 'a failed resolve must not unmount the current view').toBe(false)
      expect(dom.state.scrolls).toBe(0)
      expect(reports.at(-1)?.payload?.source).toBe('jump-unavailable:no-node-source')
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
      hooks.__setMessageEditorWire(null)
      dom.restore()
    }
  })

  it('reports a throwing loader as load-failed and does not switch tabs', async () => {
    const dom = installDom()
    const reports = []
    const thrower = async () => { throw new Error('loader boom') }
    hooks.__setMessageEditorWire((op, payload) => { reports.push({ op, payload }); return Promise.resolve({ ok: true }) })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await hooks.jumpToAnchor({ hasMore: true, loadThrough: thrower, loadOlder: async () => {} }, 5, () => new Map())
      expect(dom.state.switched).toBe(false)
      expect(reports.at(-1)?.payload?.source).toBe('jump-unavailable:load-failed')
    } finally {
      warn.mockRestore()
      hooks.__setMessageEditorWire(null)
      dom.restore()
    }
  })

  it('reports row-not-rendered AFTER the tab switch when the row never mounts (documented behaviour)', async () => {
    // Locks the failure semantics the JSDoc now states: this case is NOT
    // "stay on the original view" — the tab is already switched and the user is
    // on the chat view; only the scroll/highlight is missing. The jump reports it
    // (never silent) rather than switching back.
    const dom = installDom({ rowPresent: false })
    const reports = []
    const nodes = new Map([['u5', nodeAt('u5', 5)]]) // already loaded → resolve succeeds
    hooks.__setMessageEditorWire((op, payload) => { reports.push({ op, payload }); return Promise.resolve({ ok: true }) })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await hooks.jumpToAnchor({ hasMore: true, loadOlder: async () => {} }, 5, () => nodes)
      expect(dom.state.switched, 'the tab switches as soon as the key is known').toBe(true)
      expect(dom.state.scrolls).toBe(0)
      expect(dom.state.anchorSelectors).toContain('[data-chat-anchor-key="u5"]')
      expect(reports.at(-1)?.payload?.source).toBe('jump-unavailable:row-not-rendered')
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
      hooks.__setMessageEditorWire(null)
      dom.restore()
    }
  })
})

// ---------------------------------------------------------------------------
// Performance (2026-09-14): `useSeqHidden` must reuse the per-snapshot hide
// plan instead of rescanning the node map for every row × marker. The old path
// was O(K·N²) and only became live once the action rows actually rendered (the
// visible cost of the HIGH-1 fix): 2000 rows/20 markers ≈ 346 ms, 3000/30 ≈
// 1.6 s per pass.
// ---------------------------------------------------------------------------
describe('hide plan is computed once per snapshot (performance guard)', () => {
  const nodeAt = (key, seq) => ({ key, kind: 'user-message', anchorSeq: seq, data: { seq } })
  const marker = (key, seq, shadowedSeqs) => ({
    key, kind: 'recall-marker', anchorSeq: seq, data: { seq, op: 'recall', shadowedSeqs, legacy: false, compact: false },
  })

  it('the per-row hide lookup does not rescan the node map', () => {
    const entries = []
    for (let i = 1; i <= 40; i += 1) entries.push(nodeAt(`u${i}`, i))
    entries.push(marker('m1', 100, [1, 2, 3]))
    const nodes = new Map(entries.map((node) => [node.key, node]))
    // Instrument: one `values()` call == one full node scan.
    let scans = 0
    const originalValues = nodes.values.bind(nodes)
    nodes.values = () => { scans += 1; return originalValues() }
    const snapshot = { nodes, order: [...nodes.keys()] }
    const useChat = (selector) => selector(snapshot)
    // Warm the per-snapshot memo (the single plan build may scan).
    hooks.useSeqHidden(useChat, 1)
    scans = 0
    for (let i = 1; i <= 40; i += 1) hooks.useSeqHidden(useChat, i)
    // Reusing the plan means ZERO node scans for the whole row pass. The old
    // per-row `rowHiddenByKey` rescan grew with the row count (and markers).
    expect(scans).toBe(0)
  })

  it('matches the old per-row predicate exactly (differential over a snapshot matrix)', () => {
    // Oracle: the OLD algorithm, expressed through the plan's public
    // `hiddenFor()` (which already encodes hiddenKeysFor + the 40% degradation
    // rule + compact exclusion) and a fresh first-match row lookup. Independent
    // of the new `isSeqHidden` path, so it catches any semantic drift.
    const oracle = (snapshot, seq, plan) => {
      if (seq === undefined || seq === null) return false
      let rowKey
      for (const node of snapshot.nodes.values()) {
        if (node.kind !== 'recall-marker' && typeof node.anchorSeq === 'number' && node.anchorSeq === seq) { rowKey = node.key; break }
      }
      if (rowKey === undefined) return false
      for (const node of snapshot.nodes.values()) {
        if (node.kind !== 'recall-marker') continue
        const keys = plan.hiddenFor(node.key)
        if (Array.isArray(keys) && keys.includes(rowKey)) return true
      }
      return false
    }
    const snap = (entries) => ({ nodes: new Map(entries.map((node) => [node.key, node])), order: entries.map((node) => node.key) })
    const rows1to = (n) => Array.from({ length: n }, (_, i) => nodeAt(`u${i + 1}`, i + 1))
    const snapshots = [
      snap(rows1to(6)), // no markers
      snap([...rows1to(6), marker('m1', 50, [3])]), // live marker
      snap([...rows1to(6), marker('m1', 50, [3]), marker('m2', 51, [4, 5])]), // two markers
      snap([...rows1to(6), marker('m1', 50, [3], )].map((n, i) => (i === 6 ? { ...n, data: { ...n.data, compact: true, op: 'fold' } } : n))), // compact
      snap([...rows1to(25), marker('m1', 500, rows1to(25).map((n) => n.anchorSeq))]), // degraded (>40% of 25)
      snap([...rows1to(30), marker('mGood', 100, [1]), marker('mBad', 101, Array.from({ length: 25 }, (_, i) => i + 2))]), // per-marker degradation
      snap([nodeAt('u5', 5), { key: 'u5b', kind: 'user-message', anchorSeq: 5, data: { seq: 5 } }, marker('m1', 50, [5])]), // duplicate seq: first match wins
    ]
    for (const snapshot of snapshots) {
      const useChat = (selector) => selector(snapshot)
      const plan = hooks.useMarkerHidePlan(useChat)
      for (let seq = 0; seq <= 32; seq += 1) {
        expect(hooks.useSeqHidden(useChat, seq), `seq ${seq}`).toBe(oracle(snapshot, seq, plan))
      }
      expect(hooks.useSeqHidden(useChat, undefined)).toBe(false)
      expect(hooks.useSeqHidden(useChat, null)).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// UX (2026-09-14): both views must say what they are, and every row must state
// what happened / what it affected. Assertions run on the REAL render output
// with the Chinese dictionary — i.e. the strings the user actually sees.
// ---------------------------------------------------------------------------
const tZh = (key, params) => {
  let text = zh[key] ?? key
  if (params) for (const [name, value] of Object.entries(params)) text = text.split(`{${name}}`).join(String(value))
  return text
}
function allText(node, out = []) {
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const child of node) allText(child, out); return out }
  if (node && typeof node === 'object' && node.children) for (const child of node.children) allText(child, out)
  return out
}
function captureRegistered() {
  const registered = []
  const ctx = {
    effect: (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
    locale: { register: () => () => {}, bind: () => (key) => key },
    get: () => undefined,
    inject: () => () => {},
    slots: {
      inject: (_seat, callback) => { callback(); return () => {} },
      register: (config, Component) => { registered.push({ config, Component }); return () => {} },
    },
  }
  apply(ctx)
  return registered
}

describe('the single checkpoint view explains itself (UX)', () => {
  const viewEntries = () => captureRegistered().filter(({ config }) => config.name === 'conversation.view')
  // The registration wraps RetraceView in the panel-level error boundary.
  // NOTE: this file holds TWO copies of lib/client.js (the imported module and the
  // esbuild bundle), so identity comparison would fail — detect the boundary by
  // its React error-boundary contract instead.
  const isBoundary = (type) => typeof type === 'function' && typeof type.getDerivedStateFromError === 'function'
  const renderView = (id, props) => {
    const out = viewComponent(id)(props)
    if (out && isBoundary(out.type)) {
      const child = (out.children ?? [])[0]
      return child.type(child.props)
    }
    return out
  }
  const viewComponent = (id) => {
    const entry = viewEntries().find(({ config }) => config.id === id)
    expect(entry, `no conversation.view registration for id=${id}`).toBeDefined()
    return entry.Component
  }

  it('registers exactly ONE conversation.view (the checkpoint tab) and drops the fork tab', () => {
    expect(viewEntries().map(({ config }) => config.id)).toEqual(['retrace'])
    expect(zh['view.retrace']).toBe('读档点')
    expect(zh['timeline.title']).toBe('读档点')
  })

  it('RetraceView always shows the plain-language concept sentence', () => {
    const out = renderView('retrace', { sessionId: 's1', useChat: () => undefined, useProjection: () => undefined, t: tZh, actions: {}, store: {} })
    // 页首说明（新口径，带次数）+ 顺序提示
    expect(allText(out)).toContain(tZh('timeline.intro', { count: 0 }))
    expect(allText(out)).toContain(tZh('timeline.orderHint'))
  })

  it('注册处真的把视图包在面板级错误边界里（白屏事故的结构防线）', () => {
    const wrapped = viewComponent('retrace')({ t: tZh })
    expect(isBoundary(wrapped.type), 'the registered component must be the error boundary').toBe(true)
    const child = (wrapped.children ?? [])[0]
    expect(typeof child?.type).toBe('function')
  })

  // A frozen-shape `what` (lib/boundary-what.js): verbatim excerpts + optional
  // artifacts. `summary` is a SEPARATE optional field.
  const whatFixture = {
    op: 'edit',
    at: 0,
    new: { excerpt: '改后的新问法' },
    replaced: [
      { seq: 7, role: 'user', excerpt: '原来的问法' },
      { seq: 8, role: 'assistant', excerpt: '原来的回答' },
    ],
    replacedMore: 2,
  }
  const collectElements = (node, out = []) => {
    if (Array.isArray(node)) { for (const child of node) collectElements(child, out); return out }
    if (node && typeof node === 'object' && node.type !== undefined) {
      out.push(node)
      for (const child of node.children ?? []) collectElements(child, out)
    }
    return out
  }
  const hasClass = (row, name) => collectElements(row).some((element) => String(element.props.className ?? '').includes(name))
  // The compact row shows ONE content line by default; these assertions are about
  // the full content (quotes / summary / colours / artifacts) ⇒ render the row
  // with its detail block open.
  const row = (extra = {}) => hooks.VersionRow({
    record: { versionId: 'v9', kind: 'edit', createdAt: 0, messageCount: 12, markerText: '' },
    top: 0, t: tZh, what: whatFixture, detailOpen: true, onPreview() {}, onJump() {}, ...extra,
  })

  it('a checkpoint row shows the DISCARDED verbatim quote, the CONTINUED quote and the impact', () => {
    const text = allText(row({ what: { ...whatFixture, artifacts: { created: 1, modified: 2, deleted: 0 } } })).join(' • ')
    expect(text).toContain(zh['timeline.kind.edit'])
    expect(text).toContain('「原来的问法」')            // 被丢弃：逐字原文（可读性主体）
    expect(text).toContain('「改后的新问法」')          // 延续：新内容逐字
    expect(text).toContain(zh['what.countShort'].replace('{count}', '4'))  // 首行：2 listed + replacedMore 2
    expect(text).toContain('产物变更：1 增 / 2 改 / 0 删')
  })

  it('a missing `what.artifacts` renders NO artifact line — never 0/0/0', () => {
    const built = row()
    expect(hasClass(built, 'dsh-rt-version-files')).toBe(false)
    const text = allText(built).join(' • ')
    expect(text).not.toContain('0 增')
    expect(text).not.toContain('0/0/0')
  })

  it('a missing summary renders NO summary block (no placeholder, no polling)', () => {
    const built = row({ summary: undefined, summaryCalled: false })
    expect(hasClass(built, 'dsh-rt-what-summary')).toBe(false)
    expect(allText(built).join(' • ')).not.toContain(zh['what.summaryTag'])
  })

  it('a present summary is its OWN element, never merged with the verbatim quote', () => {
    const built = row({ summary: 'AI 摘要文本', summaryCalled: true })
    const elements = collectElements(built)
    const quote = elements.find((element) => String(element.props.className ?? '').includes('dsh-rt-what-quote'))
    const summary = elements.find((element) => String(element.props.className ?? '').includes('dsh-rt-what-summary'))
    expect(quote, 'the verbatim quote element must exist').toBeDefined()
    expect(summary, 'the summary must be its own element').toBeDefined()
    expect(quote).not.toBe(summary)
    expect(allText(quote).join('')).not.toContain('AI 摘要文本')
    expect(allText(summary).join('')).not.toContain('原来的问法')
  })

  it('discarded vs continued content uses DIFFERENT colour classes', () => {
    const elements = collectElements(row())
    const continued = elements.find((element) => String(element.props.className ?? '').includes('dsh-rt-what-new'))
    const discarded = elements.find((element) => String(element.props.className ?? '').includes('dsh-rt-what-old'))
    expect(continued, 'continued (accent) element').toBeDefined()
    expect(discarded, 'discarded (muted) element').toBeDefined()
    expect(continued.props.className).not.toBe(discarded.props.className)
    expect(allText(discarded).join('')).toContain(zh['what.oldLabel'])
  })

  it('with no digest the row falls back to the plain why line', () => {
    const built = row({ what: null })
    const text = allText(built).join(' • ')
    expect(text).toContain('当时共 12 条消息')
    expect(text).toContain(hooks.whyLabel('edit', tZh))
  })

  it('role labels are human phrases, not the raw node-type nouns', () => {
    expect(zh['what.role.user']).toBe('你发送的消息')
    expect(zh['what.role.assistant']).toBe('助手生成的回复')
    expect(zh['what.role.tool']).toBe('工具执行结果')
    for (const bare of ['用户消息', '助手回复', '工具结果']) {
      expect(Object.values(zh)).not.toContain(bare)
    }
  })
})

// ---------------------------------------------------------------------------
// 「读档点」完备性锁 (2026-09-15) — R20/R21/R22/R24/R30/R31/R33/R34/R35.
//
// Every requirement below carries a lock test: deliberately breaking the
// behaviour makes the named test fail (the mutation table for each requirement
// is recorded in this round's completion report). The assertions run on the
// REAL render output of the real source.
// ---------------------------------------------------------------------------
describe('读档点 completeness locks (R20–R24/R30/R31/R33–R35)', () => {
  const rec = (seq, kind = 'edit') => ({ versionId: `v${seq}`, boundarySeq: seq, kind, createdAt: 0, messageCount: 7, markerText: '' })
  const whatOf = (n = 1) => ({
    op: 'edit', at: 0, new: { excerpt: '新内容' },
    replaced: Array.from({ length: n }, (_, i) => ({ seq: 900 + i, role: 'user', excerpt: `旧${i}` })),
  })
  const quietDigest = () => ({ quiet: true })
  const fullDigest = (what = whatOf()) => ({ what, called: false })
  const digestMap = (entries) => new Map(entries)
  const treeOf = (nodes) => hooks.indexTree({ tree: nodes })
  const chain = (depth) => {
    const nodes = {}
    for (let i = 1; i <= depth; i += 1) {
      nodes[String(i)] = { parent: i === 1 ? null : i - 1, children: i < depth ? [i + 1] : [], discardedCount: depth - i + 1 }
    }
    return treeOf(nodes)
  }
  const collect = (node, out = []) => {
    if (Array.isArray(node)) { for (const child of node) collect(child, out); return out }
    if (node && typeof node === 'object' && node.type !== undefined) {
      out.push(node)
      for (const child of node.children ?? []) collect(child, out)
    }
    return out
  }
  const textOf = (node) => allText(node).join(' | ')
  const classesOf = (node) => collect(node).map((element) => String(element.props.className ?? ''))
  const hasClass = (node, needle) => classesOf(node).some((name) => name.includes(needle))
  const sourceOf = () => readFileSync(CLIENT_SOURCE_PATH, 'utf8')
  /** The source text of one top-level function (up to the next one). */
  const functionSlice = (name, nextName) => {
    const source = sourceOf()
    const start = source.indexOf(`function ${name}(`)
    const end = source.indexOf(`function ${nextName}(`, start + 1)
    expect(start, `${name} must exist`).toBeGreaterThan(-1)
    expect(end, `${nextName} must follow ${name}`).toBeGreaterThan(start)
    return source.slice(start, end)
  }
  const pathBlock = (extra = {}) => hooks.CurrentPathBlock({
    t: tZh, rounds: [], open: false, messages: 0, onToggle() {}, onJump() {}, start: null, ...extra,
  })

  // ---- R20: quiet changes leave the main timeline; bottom collapsed block ----

  it('R20 · 安静改动不占主时间线（安静=服务端显式 quiet 标记）', () => {
    const versions = [rec(1), rec(2)]
    const digests = digestMap([[1, quietDigest()], [2, fullDigest()]])
    const rows = hooks.buildDisplayRows({ versions, digests, tree: null, expanded: null })
    expect(rows.map((row) => [row.kind, row.record.boundarySeq])).toEqual([['row', 2]])
    // The quiet one is not silently dropped from the model: it is collected.
    expect(hooks.quietRecordsOf(versions, digests).map((record) => record.boundarySeq)).toEqual([1])
    // A missing digest is NOT quiet (an unreadable/old boundary must stay visible).
    const missing = hooks.buildDisplayRows({ versions: [rec(3)], digests: digestMap([]), tree: null, expanded: null })
    expect(missing.map((row) => row.kind)).toEqual(['fallback'])
  })

  it('R20 · 安静节点仍保留树的骨架（不留行也不把嵌套子树弄丢）', () => {
    const versions = [rec(1), rec(2)]
    const digests = digestMap([[1, quietDigest()], [2, fullDigest()]])
    const tree = treeOf({
      '1': { parent: null, children: [2], discardedCount: 1 },
      '2': { parent: 1, children: [], discardedCount: 1 },
    })
    // 显式收起：安静节点自己没有行，但子树仍然可达（骨架在）
    const closed = hooks.buildDisplayRows({ versions, digests, tree, expanded: new Map([[1, false]]) })
    expect(closed.map((row) => [row.kind, row.count])).toEqual([['collapsed', 1]])
    // 2026-09-15：安静分支的 chip 层级与普通分支统一（都落在"子行那一级"，
    // 而不是安静节点自己的 level）——否则安静节点的收起入口缩进浅一级。
    expect(closed[0].level).toBe(1)
    // 默认收起（用户口径 2026-09-15）：安静节点不留行，子行也不出现
    const byDefault = hooks.buildDisplayRows({ versions, digests, tree, expanded: null })
    expect(byDefault.map((row) => row.kind)).toEqual(['collapsed'])
    expect(byDefault[0].level).toBe(1)
    const opened = hooks.buildDisplayRows({ versions, digests, tree, expanded: new Map([[1, true]]) })
    // 展开态多一枚「收起」chip（安静父节点同样有，否则点开就回不去），且它落在
    // **子行之后**——"收起"明确属于这次展开（用户口径 2026-09-15）。
    expect(opened.map((row) => row.kind)).toEqual(['expanded', 'row', 'expanded'])
    expect(opened[0].seq).toBe(1)
    expect(opened[0].position).toBe('head')
    expect(opened[1].record?.boundarySeq).toBe(2)
    expect(opened[1].level).toBe(1)
    expect(opened[2].seq).toBe(1)
    expect(opened[2].position).toBe('tail')
  })

  it('R20 · 折叠块默认收起、展开后逐条可见；默认态写死为折叠', () => {
    const runs = [[rec(10)]]
    const closed = hooks.QuietBlock({ t: tZh, runs, open: false, onToggle() {}, openRuns: null, onToggleRun() {}, onJumpLatest() {} })
    expect(hasClass(closed, 'dsh-rt-quiet-row')).toBe(false)
    expect(textOf(closed)).toContain(tZh('quiet.blockTitle', { count: 1 }))
    const opened = hooks.QuietBlock({ t: tZh, runs, open: true, onToggle() {}, openRuns: null, onToggleRun() {}, onJumpLatest() {} })
    expect(collect(opened).filter((el) => String(el.props.className ?? '').includes('dsh-rt-quiet-list'))).toHaveLength(1)
    expect(collect(opened).filter((el) => el.type === hooks.QuietRow)).toHaveLength(1)
    // No quiet changes → the block renders nothing at all.
    expect(hooks.QuietBlock({ t: tZh, runs: [], open: true, onToggle() {}, openRuns: null, onToggleRun() {}, onJumpLatest() {} })).toBeNull()
    // Default state (never persisted): collapsed.
    expect(sourceOf()).toContain('const [quietOpen, setQuietOpen] = useState(false)')
  })

  // ---- R21: plain text only — no summary, no artifact line, no artifacts-only rollback

  it('R21 · 安静行源码里没有摘要/产物/回退（源码断言）', () => {
    const slice = functionSlice('QuietRow', 'QuietRunRow')
    expect(slice).not.toContain('summary')
    expect(slice).not.toContain('artifacts')
    expect(slice).not.toContain('restoreTo')
    expect(slice).not.toContain('callOp')
    expect(slice).not.toContain('requestPreview')
  })

  it('R21 · 安静行渲染里没有摘要元素/产物行/“回到这一档”（渲染断言）', () => {
    const element = hooks.QuietRow({ record: rec(4), t: tZh, onJumpLatest() {} })
    expect(hasClass(element, 'dsh-rt-what-summary')).toBe(false)
    expect(hasClass(element, 'dsh-rt-version-files')).toBe(false)
    const text = textOf(element)
    expect(text).not.toContain(zh['what.summaryTag'])
    expect(text).not.toContain(zh['timeline.restoreTo'])
    expect(text).not.toContain(zh['timeline.artifactsOnly'])
    expect(text).toContain(zh['quiet.note'])
    expect(text).toContain(tZh('timeline.kind.edit'))
  })

  // ---- R22: the quiet action is pure navigation to the newest live message ---

  it('R22 · 安静行只有一个动作：跳到最新对话（点击不触发任何回退）', () => {
    let latest = 0
    const element = hooks.QuietRow({ record: rec(4), t: tZh, onJumpLatest: () => { latest += 1 } })
    const buttons = collect(element).filter((el) => el.type === 'button')
    expect(buttons).toHaveLength(1)
    expect(buttons[0].props.type).toBe('button')
    expect(allText(buttons[0]).join('')).toBe(zh['quiet.jumpLatest'])
    buttons[0].props.onClick()
    expect(latest).toBe(1)
    expect(textOf(element)).not.toContain(zh['timeline.restoreTo'])
  })

  it('R22 · latestSeqOf 取活路最后一个节点的 anchorSeq（顺序为准）', () => {
    const nodes = new Map([['a', { anchorSeq: 1 }], ['b', { anchorSeq: 9 }]])
    expect(hooks.latestSeqOf(nodes, ['a', 'b'])).toBe(9)
    expect(hooks.latestSeqOf(nodes, ['b', 'a'])).toBe(1)
    expect(hooks.latestSeqOf(new Map([['x', {}]]), ['x'])).toBeNull()
    expect(hooks.latestSeqOf(null, [])).toBeNull()
  })

  it('R22 · 视图把安静行接到“跳到最新对话”，而不是回退预览', () => {
    const source = sourceOf()
    expect(source).toContain('onJumpLatest: jumpLatest')
    expect(source).toContain('const jumpLatest = () => {')
    const block = functionSlice('QuietBlock', 'CurrentPathBlock')
    expect(block).not.toContain('callOp')
    expect(block).not.toContain('requestPreview')
    // The whole quiet block only knows the navigation callback.
    expect(block).toContain('onJumpLatest')
  })

  // ---- R24: merge threshold ≥2 consecutive, and the merged line expands ----

  it('R24 · 阈值 ≥2：单条不合并、直接可见；≥2 连成一行', () => {
    const runs = [[rec(10), rec(11), rec(12)], [rec(20)]]
    const opened = hooks.QuietBlock({ t: tZh, runs, open: true, onToggle() {}, openRuns: null, onToggleRun() {}, onJumpLatest() {} })
    const merged = collect(opened).filter((el) => el.type === hooks.QuietRunRow)
    const singles = collect(opened).filter((el) => el.type === hooks.QuietRow)
    expect(merged).toHaveLength(1)
    expect(singles).toHaveLength(1)
    // The lone change is listed directly (never swallowed by a merge).
    expect(singles[0].props.record.boundarySeq).toBe(20)
    expect(merged[0].props.run.map((record) => record.boundarySeq)).toEqual([10, 11, 12])
    // (The fake React does not execute child components: invoke the merged row
    //  directly to read its copy.)
    const mergedText = textOf(hooks.QuietRunRow({ t: tZh, run: [rec(10), rec(11), rec(12)], open: false, onToggleRun() {}, onJumpLatest() {} }))
    expect(mergedText).toContain(tZh('quiet.merged', { count: 3 }))
  })

  it('R24 · 合并行可展开：收起时 0 行，展开后逐条可达', () => {
    const run = [rec(10), rec(11), rec(12)]
    const closed = hooks.QuietRunRow({ t: tZh, run, open: false, onToggleRun() {}, onJumpLatest() {} })
    expect(collect(closed).filter((el) => el.type === hooks.QuietRow)).toHaveLength(0)
    const opened = hooks.QuietRunRow({ t: tZh, run, open: true, onToggleRun() {}, onJumpLatest() {} })
    const rows = collect(opened).filter((el) => el.type === hooks.QuietRow)
    expect(rows).toHaveLength(3)
    expect(rows.map((el) => el.props.record.boundarySeq)).toEqual([10, 11, 12])
    let toggles = 0
    const interactive = hooks.QuietRunRow({ t: tZh, run, open: false, onToggleRun: () => { toggles += 1 }, onJumpLatest() {} })
    collect(interactive).find((el) => String(el.props.className ?? '').includes('dsh-rt-quiet-btn')).props.onClick()
    expect(toggles).toBe(1)
  })

  it('R24 · 「连续」按时间线相邻判定（中间夹非安静 ⇒ 拆成两段）', () => {
    const versions = [rec(1), rec(2), rec(3)]
    const split = digestMap([[1, quietDigest()], [2, fullDigest()], [3, quietDigest()]])
    expect(hooks.quietRunsOf(versions, split).map((run) => run.map((record) => record.boundarySeq))).toEqual([[1], [3]])
    const together = digestMap([[1, quietDigest()], [2, quietDigest()], [3, fullDigest()]])
    expect(hooks.quietRunsOf(versions, together).map((run) => run.map((record) => record.boundarySeq))).toEqual([[1, 2]])
  })

  // ---- R30: our own round list; no official-trajectory entry ---------------

  it('R30 · 「现在的路」保留我们自己的轮次列表，可点跳转', () => {
    const rounds = [{ n: 1, seq: 5, question: '你问的', answer: '助手答的' }]
    const jumped = []
    const opened = hooks.CurrentPathBlock({
      t: tZh, rounds, open: true, messages: 3, start: null, onToggle() {}, onJump: (seq) => jumped.push(seq),
    })
    const rows = collect(opened).filter((el) => String(el.props.className ?? '').includes('dsh-rt-path-row'))
    expect(rows).toHaveLength(1)
    expect(textOf(opened)).toContain(tZh('path.round', { n: 1 }))
    expect(textOf(opened)).toContain('「你问的」')
    expect(textOf(opened)).toContain('「助手答的」')
    rows[0].props.onClick()
    expect(jumped).toEqual([5])
  })

  it('R30 · 没有通往官方轨迹的入口（我们自己加载信息展示）', () => {
    const source = sourceOf()
    expect(source).not.toContain('path.expandToTrajectory')
    expect(source).not.toContain("switchToViewTab('trajectory')")
    expect(zh['path.expandToTrajectory']).toBeUndefined()
  })

  // ---- R31: the start line uses the start text / summary (if any) ----------

  it('R31 · 起点行：有摘要显示摘要，缺省时如实显示原文，两者都无则显示计数', () => {
    const withSummary = pathBlock({ start: { summary: '这是摘要内容', text: '这是起点原文', count: 9 } })
    const summaryText = textOf(withSummary)
    expect(hasClass(withSummary, 'dsh-rt-path-start')).toBe(true)
    expect(summaryText).toContain(zh['path.start'])
    expect(summaryText).toContain('这是摘要内容')
    expect(summaryText).toContain(zh['what.summaryTag'])
    // 摘要与原文不混排（摘要存在时原文不再出现）。
    expect(summaryText).not.toContain('这是起点原文')

    const noSummary = pathBlock({ start: { summary: null, text: '这是起点原文', count: 9 } })
    expect(textOf(noSummary)).toContain('这是起点原文')

    const neither = pathBlock({ start: { summary: null, text: '', count: 9 } })
    const countsText = textOf(neither)
    expect(countsText.trim().length).toBeGreaterThan(0)
    expect(countsText).toContain(tZh('timeline.messages', { count: 9 }))
  })

  it('R31 · 起点取最早一档：有摘要用摘要，摘要缺省用原文，都没有用计数', () => {
    const versions = [rec(100), rec(50), rec(200)]
    // 列表顺序不可信：起点是 boundarySeq 最小的那一档（50）。
    const digests = digestMap([[50, { what: { new: { excerpt: '起点原文' } }, called: true, summary: '起点摘要' }], [100, fullDigest()], [200, fullDigest()]])
    expect(hooks.pathStartOf(versions, digests)).toEqual({ summary: '起点摘要', text: '起点原文', count: 7 })
    // 摘要未生成（called 非 true）⇒ 如实退回原文。
    const notCalled = digestMap([[50, { what: { new: { excerpt: '只有原文' } }, called: false, summary: '不该显示' }]])
    expect(hooks.pathStartOf(versions, notCalled)).toEqual({ summary: null, text: '只有原文', count: 7 })
    // 两者都没有 ⇒ 计数兜底（不空白、不占位）。
    expect(hooks.pathStartOf([rec(5)], digestMap([]))).toEqual({ summary: null, text: '', count: 7 })
    expect(hooks.pathStartOf([], digestMap([]))).toBeNull()
  })

  it('R31 · 起点行默认可见（不依赖轮次列表展开）', () => {
    const closed = pathBlock({ start: { summary: null, text: '起点原文', count: 9 } })
    expect(hasClass(closed, 'dsh-rt-path-row')).toBe(false)
    expect(hasClass(closed, 'dsh-rt-path-start')).toBe(true)
    expect(textOf(closed)).toContain('起点原文')
  })

  // ---- R3: the row must say WHAT happened (real-machine content fix) --------

  const richWhat = () => ({
    op: 'edit',
    at: new Date(2026, 8, 7, 12, 3).getTime(),
    new: { excerpt: '改后的新问法' },
    replaced: [
      { seq: 8692, role: 'user', excerpt: '我和外部AI的思路一致' },
      { seq: 8693, role: 'assistant', excerpt: '好的' },
      { seq: 9177, role: 'user', excerpt: '派工单' },
    ],
    replacedMore: 7,
  })
  const richRow = (extra = {}) => hooks.VersionRow({
    record: rec(9204), t: tZh, top: 0, what: richWhat(),
    summary: '这一段被丢掉了', summaryCalled: true, discardedCount: 10,
    onPreview() {}, onJump() {}, ...extra,
  })
  const quoteCount = (element) => collect(element).filter((el) => String(el.props.className ?? '').includes('dsh-rt-what-quote')).length

  it('R3 · 默认只有两行:首行=动作·时间·丢弃 N 条,第 2 行=仅一条逐字摘录', () => {
    const element = richRow()
    const text = textOf(element)
    // 首行：动作（人话） · 时间 · 计数
    expect(text).toContain(tZh('timeline.kind.edit'))
    expect(text).toContain('9-7 12:03')
    expect(text).toContain(tZh('what.countShort', { count: 10 }))
    // 第 2 行：唯一一条内容行 = 第一条可读引文
    expect(quoteCount(element)).toBe(1)
    expect(text).toContain('我和外部AI的思路一致')
    // 其余明细（引文 2/3、另有 M 条、【摘要】、延续）默认都不渲染
    expect(text).not.toContain('好的')
    expect(text).not.toContain('派工单')
    expect(text).not.toContain(tZh('what.more', { count: 7 }))
    expect(text).not.toContain(tZh('what.summaryTag'))
    expect(text).not.toContain('这一段被丢掉了')
    // 明细入口在（行尾 ›；没有明细的行不摆空入口），且**行里不再出现「明细」字样**
    expect(hasClass(element, 'dsh-rt-row-open')).toBe(true)
    expect(text).not.toContain('明细')
    expect(text).not.toContain(tZh('row.expand'))
  })

  it('R3 · 行级展开:明细行全部可见(逐字摘录 + 另有 M 条 + 【摘要】 + 延续)', () => {
    let toggled = []
    const element = richRow({ detailOpen: true, onToggleDetail: (seq) => toggled.push(seq) })
    const text = textOf(element)
    expect(quoteCount(element)).toBe(4)                 // 3 条引文 + 延续
    expect(text).toContain('我和外部AI的思路一致')
    expect(text).toContain('好的')
    expect(text).toContain('派工单')
    expect(text).toContain(tZh('what.more', { count: 7 }))
    expect(text).toContain(tZh('what.summaryTag'))
    expect(text).toContain('这一段被丢掉了')
    expect(text).toContain('改后的新问法')
    expect(hasClass(element, 'dsh-rt-what-summary')).toBe(true)
    // 收起/展开入口：行尾 ›（点击目标 = 这一档的 seq；aria-expanded 反映状态）
    const open = collect(element).find((el) => String(el.props.className ?? '').includes('dsh-rt-row-open'))
    expect(open).toBeDefined()
    expect(allText(open).join('')).toBe('›')
    expect(open.props['aria-expanded']).toBe(true)
    open.props.onClick()
    expect(toggled).toEqual([9204])
  })

  it('R3 · 行级展开/收起往返(默认态 → 展开态 → 默认态)', () => {
    const closed = richRow()
    const opened = richRow({ detailOpen: true })
    expect(quoteCount(closed)).toBe(1)
    expect(quoteCount(opened)).toBe(4)
    // 行尾 › 的 aria-expanded 表达展开/收起（往返由 mounted 用例与点击回调锁）
    expect(collect(closed).find((el) => String(el.props.className ?? '').includes('dsh-rt-row-open')).props['aria-expanded']).toBe(false)
    expect(collect(opened).find((el) => String(el.props.className ?? '').includes('dsh-rt-row-open')).props['aria-expanded']).toBe(true)
  })

  it('R3 · 原文已被压缩掉时不显示空引号,而是明确说明"已被压缩无法还原"(不编造摘录)', () => {
    const what = {
      op: 'recall',
      at: Date.UTC(2026, 8, 1, 8, 30),
      new: { excerpt: '' },
      // 事件已不在日志里:角色 unknown、摘录为空,但 seq 列表仍然精确。
      replaced: [
        { seq: 100, role: 'unknown', excerpt: '' },
        { seq: 101, role: 'unknown', excerpt: '' },
        { seq: 102, role: 'unknown', excerpt: '' },
      ],
      replacedMore: 4,
    }
    const element = hooks.VersionRow({
      record: rec(200), t: tZh, top: 0, what, discardedCount: 7, onPreview() {}, onJump() {},
    })
    const text = textOf(element)
    // 计数在首行(短文案)
    expect(text).toContain(tZh('what.countShort', { count: 7 }))
    // 真机发现(2026-09-15):一条**没有可读原文**的档只显示"另有 N 条"读起来像坏行。
    // 现在必须**说清原因**(原文已被压缩),而且仍然不许编造摘录。
    expect(text).toContain(tZh('what.compacted', { count: 7 }))
    expect(text).not.toContain(tZh('what.more', { count: 7 }))
    // 压缩提示就是这一档唯一的内容行 ⇒ 没有可展开的明细（没有行尾 ›）
    expect(hasClass(element, 'dsh-rt-row-open')).toBe(false)
    // 没有可读摘录 ⇒ 不渲染「已丢弃」引言块(不显示空白引号)。
    expect(hasClass(element, 'dsh-rt-what-old')).toBe(false)
    // 也不显示「延续」(new.excerpt 为空)
    expect(hasClass(element, 'dsh-rt-what-new')).toBe(false)
  })

  it('R3 · 部分原文可读时:照常渲染引号 + "另有 N 条"(两个分支都在)', () => {
    const what = {
      op: 'edit',
      at: Date.UTC(2026, 8, 1, 8, 30),
      new: { excerpt: '' },
      replaced: [
        { seq: 100, role: 'user', excerpt: '可读的原文' },
        { seq: 101, role: 'unknown', excerpt: '' },
        { seq: 102, role: 'unknown', excerpt: '' },
      ],
      replacedMore: 2,
    }
    const compact = hooks.VersionRow({
      record: rec(201), t: tZh, top: 0, what, discardedCount: 5, onPreview() {}, onJump() {},
    })
    const compactText = textOf(compact)
    expect(hasClass(compact, 'dsh-rt-what-old')).toBe(true)
    expect(compactText).toContain('可读的原文')
    expect(compactText).not.toContain(tZh('what.compacted', { count: 5 }))
    // 「另有 M 条」是明细行 ⇒ 默认不渲染,展开后必须回来(信息不丢)
    expect(compactText).not.toContain(tZh('what.more', { count: 4 }))
    const opened = hooks.VersionRow({
      record: rec(201), t: tZh, top: 0, what, discardedCount: 5, detailOpen: true, onPreview() {}, onJump() {},
    })
    expect(textOf(opened)).toContain(tZh('what.more', { count: 4 }))
  })

  it('R3 · 宿主自身的替换不进列表,只报一行计数(客户端兜底)', () => {
    const source = sourceOf()
    // 列表侧兜底过滤 + 一行计数提示 + 不与时间线行混排
    expect(source).toContain("const list = (versions ?? []).filter((record) => record?.kind !== 'replace')")
    expect(source).toContain('hostReplacements > 0 && createElement')
    expect(source).toContain("t('host.replacements', { count: hostReplacements })")
    expect(source).toContain('const [hostReplacements, setHostReplacements] = useState(0)')
    expect(zh['host.replacements']).toContain('宿主')
    expect(zh['host.replacements']).not.toContain('宜主')
  })

  // ---- R33/R34/R35: destructive rollback needs an explicit confirmation ----

  it('R33 · 通往 rollback 的唯一路径经过“预览 + 确认”', () => {
    const source = sourceOf()
    const ROLLBACK_CALL = "callOp('rollback',"
    // The real rollback POST exists exactly once in the whole client...
    expect(source.split(ROLLBACK_CALL).length - 1).toBe(1)
    // ...inside the confirm handler (window: its definition → the next declaration).
    const start = source.indexOf('const confirmRollback = () => {')
    const end = source.indexOf('const initGit =', start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(source.slice(start, end).split(ROLLBACK_CALL).length - 1).toBe(1)
    // The handler is reachable only from the modal's confirm button.
    expect(source.split('confirmRollback').length - 1).toBe(2)
    expect(source.split('onConfirm: confirmRollback').length - 1).toBe(1)
    // And every preview comes from the preview op (no direct rollback shortcut).
    expect(source).toContain("callOp('rollback/preview'")
  })

  it('R34 · 确认弹窗列出影响明细（消息数 + 文件数 + 逐文件明细）', () => {
    const preview = {
      versionId: 'v9', kind: 'edit', boundarySeq: 3, contextOnly: false,
      data: {
        context: { messages: 3 },
        artifacts: { rows: [{ path: 'src/a.ts', action: 'restore' }, { path: 'src/b.ts', action: 'delete' }] },
      },
      error: null,
    }
    const element = hooks.PreviewBox({ preview, scope: 'both', setScope() {}, busy: false, t: tZh, onConfirm() {}, onCancel() {} })
    const text = textOf(element)
    expect(text).toContain(tZh('timeline.messagesRemoved', { count: 3 }))
    expect(text).toContain(tZh('timeline.artifactsImpact', { count: 2 }))
    const fileList = collect(element).find((el) => String(el.props.className ?? '').includes('dsh-rt-modal-files'))
    expect(fileList, '文件明细必须列出').toBeDefined()
    expect(collect(fileList).filter((el) => el.type === 'li')).toHaveLength(2)
    expect(text).toContain('src/a.ts')
    expect(text).toContain('src/b.ts')
  })

  it('R34 · 产物为 0 时也如实说明，不静默', () => {
    const preview = {
      versionId: 'v9', kind: 'edit', boundarySeq: 3, contextOnly: false,
      data: { context: { messages: 1 }, artifacts: { rows: [] } }, error: null,
    }
    const element = hooks.PreviewBox({ preview, scope: 'both', setScope() {}, busy: false, t: tZh, onConfirm() {}, onCancel() {} })
    expect(textOf(element)).toContain(zh['timeline.filesNone'])
    expect(hasClass(element, 'dsh-rt-modal-files')).toBe(false)
  })

  it('R35 · 堵掉键盘/快捷跳过确认：只有显式点击确认按钮才提交', () => {
    const source = sourceOf()
    for (const forbidden of ['onKeyDown', 'onKeyPress', 'onKeyUp', 'onSubmit', "'Enter'", "'form'"]) {
      expect(source, `客户端不得存在 ${forbidden}`).not.toContain(forbidden)
    }
    const modal = functionSlice('PreviewBox', 'whatBody')
    expect((modal.match(/onClick: onConfirm/g) ?? [])).toHaveLength(1)
    const confirm = collect(hooks.PreviewBox({
      preview: { versionId: 'v1', kind: 'edit', boundarySeq: 1, contextOnly: false, data: { context: { messages: 1 }, artifacts: { rows: [] } }, error: null },
      scope: 'both', setScope() {}, busy: false, t: tZh, onConfirm() {}, onCancel() {},
    })).find((el) => String(el.props.className ?? '').includes('dsh-rt-confirm'))
    expect(confirm.props.type).toBe('button')
  })

  // ---- client consumption of the server outline forest (R26–R29 locks) -----

  it('tree 缺失 ⇒ 平铺且不崩；有 children 才有「还有 N 次改动」', () => {
    const versions = [rec(1), rec(2), rec(3)]
    const digests = digestMap([[1, fullDigest()], [2, fullDigest()], [3, fullDigest()]])
    expect(hooks.buildDisplayRows({ versions, digests, tree: treeOf({}), expanded: null }).map((row) => row.kind)).toEqual(['row', 'row', 'row'])
    // 默认收起：只有根那一行 + 一个折叠入口（用户点击才展开）
    const byDefault = hooks.buildDisplayRows({ versions, digests, tree: chain(3), expanded: null })
    expect(byDefault.map((row) => row.kind)).toEqual(['row', 'collapsed'])
    expect(byDefault[1].count).toBe(2)
    // 显式收起根 ⇒ 只留折叠入口（用户的选择优先于默认）
    const closed = hooks.buildDisplayRows({ versions, digests, tree: chain(3), expanded: new Map([[1, false]]) })
    expect(closed.map((row) => row.kind)).toEqual(['row', 'collapsed'])
    expect(closed[1].count).toBe(2)
    const opened = hooks.buildDisplayRows({ versions, digests, tree: chain(3), expanded: new Map([[1, true]]) })
    // 展开 #1 后：内容行 → 开头收起 → 子行 → 更深一层的折叠行 → 末尾收起
    expect(opened.map((row) => row.kind)).toEqual(['row', 'expanded', 'row', 'collapsed', 'expanded'])
    expect(opened[1].seq).toBe(1)
    expect(opened[1].position).toBe('head')
    expect(opened[4].position).toBe('tail')
    expect(opened[2].level).toBe(1)
  })

  it('嵌套只看服务端链接，不看数值区间（反序 seq 仍然嵌套）', () => {
    const versions = [rec(100), rec(50)]
    const digests = digestMap([[100, fullDigest()], [50, fullDigest()]])
    const tree = treeOf({
      '100': { parent: null, children: [50], discardedCount: 2 },
      '50': { parent: 100, children: [], discardedCount: 1 },
    })
    const opened = hooks.buildDisplayRows({ versions, digests, tree, expanded: new Map([[100, true]]) })
    expect(opened.map((row) => [row.kind, row.level, row.record?.boundarySeq ?? row.seq])).toEqual([
      ['row', 0, 100],
      ['expanded', 1, 100],
      ['row', 1, 50],
      ['expanded', 1, 100],
    ])
  })

  it('层级配色不同（当前路绿 / L1 / L2），且默认只展开一层', () => {
    const versions = [1, 2, 3, 4, 5].map((seq) => rec(seq))
    const digests = digestMap([1, 2, 3, 4, 5].map((seq) => [seq, fullDigest()]))
    const rows = hooks.buildDisplayRows({ versions, digests, tree: chain(5), expanded: new Map([[1, true], [2, true], [3, true]]) })
    expect(rows.some((row) => row.kind === 'depth')).toBe(true)
    // The fake React does not execute child components, so the level colour
    // classes are asserted on the real row renderer invoked directly.
    const renderRow = (row) => hooks.VersionRow({
      record: row.record, t: tZh, top: 0, level: row.level, current: row.current === true, nested: row.level > 0,
      what: row.digest?.what ?? null, discardedCount: row.discardedCount, onPreview() {}, onJump() {},
    })
    // 展开态会插入没有 record 的收起 chip ⇒ 取内容行必须按 kind 过滤。
    const contentAt = (level) => rows.find((row) => row.kind === 'row' && row.level === level)
    const root = renderRow(contentAt(0))
    const l1 = renderRow(contentAt(1))
    const l2 = renderRow(contentAt(2))
    expect(hasClass(root, 'dsh-rt-current')).toBe(true)
    expect(hasClass(l1, 'dsh-rt-level-1')).toBe(true)
    expect(hasClass(l2, 'dsh-rt-level-2')).toBe(true)
    // Default is FLAT (one level max): no pre-expansion.
    expect(sourceOf()).toContain('const [expanded, setExpanded] = useState(null)')
  })

  it('展开后能收起：展开态插一枚「收起」chip,点它回到 collapsed(往返都能走)', () => {
    // 普通分支 + 安静分支都要有(真机病根:展开后原入口被 children 取代 ⇒ 点开回不去)
    const cases = [
      { label: '普通节点', digests: digestMap([[1, fullDigest()], [2, fullDigest()]]), opened: ['row', 'expanded', 'row', 'expanded'], closed: ['row', 'collapsed'] },
      // 安静父节点自己没有内容行(R20) ⇒ 收起态只有折叠提示。
      { label: '安静节点', digests: digestMap([[1, quietDigest()], [2, fullDigest()]]), opened: ['expanded', 'row', 'expanded'], closed: ['collapsed'] },
    ]
    for (const { label, digests, opened: openedKinds, closed: closedKinds } of cases) {
      const versions = [rec(1), rec(2)]
      const tree = treeOf({
        '1': { parent: null, children: [2], discardedCount: 2 },
        '2': { parent: 1, children: [], discardedCount: 1 },
      })
      const expanded = new Map([[1, true]])
      const openRows = hooks.buildDisplayRows({ versions, digests, tree, expanded })
      expect(openRows.map((row) => row.kind), label).toEqual(openedKinds)
      const chipRow = openRows.find((row) => row.kind === 'expanded')
      expect(chipRow, `${label}: 展开态必须有一枚收起入口`).toBeDefined()
      expect(chipRow.seq, label).toBe(1)
      // 开头一枚（子行之前）+ 末尾一枚（子行之后）：两头都够得着
      const chips = openRows.filter((row) => row.kind === 'expanded')
      expect(chips.map((row) => row.position), label).toEqual(['head', 'tail'])
      expect(openRows.indexOf(chips[0]), label).toBeLessThan(openRows.indexOf(chips[1]))
      expect(openRows.indexOf(chips[1]), label).toBe(openRows.length - 1)
      // 渲染出的 chip：文案是 tree.collapse、图标是 ▾、动作是 onToggle(父 seq)
      const toggled = []
      const chip = hooks.CheckpointRow({ row: chipRow, t: tZh, top: 0, onToggle: (seq) => toggled.push(seq), onPreview() {}, onJump() {} })
      const button = collect(chip).find((element) => element.type === 'button')
      expect(button, label).toBeDefined()
      const chipText = allText(button).join('')
      expect(chipText, label).toContain(zh['tree.collapse'])
      expect(chipText, label).toContain('收起')
      expect(chipText, label).toContain('▾')
      expect(hasClass(chip, 'dsh-rt-tree-btn'), label).toBe(true)
      button.props.onClick()
      expect(toggled, label).toEqual([1])
      // 视图的 toggle 语义(Map 翻转)⇒ 再构建一次回到 collapsed
      const flipped = new Map(expanded)
      flipped.set(1, flipped.get(1) !== true)
      expect(hooks.buildDisplayRows({ versions, digests, tree, expanded: flipped }).map((row) => row.kind), label).toEqual(closedKinds)
      // 收起后同一个入口还能再展开(往返)
      expect(hooks.buildDisplayRows({ versions, digests, tree, expanded: new Map([[1, true]]) }).map((row) => row.kind), label).toEqual(openedKinds)
    }
  })

  it('收起入口的文案字典齐全（zh 中文 / en 有键，防漏翻或放错字典）', () => {
    expect(zh['tree.collapse']).toBe('收起')
    expect(en['tree.collapse']).toBe('Collapse')
    // 同一字典里不得再出现第二个 tree.collapse（重复键会让先前那条被静默覆盖）
    expect((sourceOf().match(/'tree\.collapse':/g) ?? [])).toHaveLength(2)
  })

  it('R3 · 行高预算 = 紧凑 60 / 展开 +18×明细行数(与渲染行数同源,不会裁切)', () => {
    const what = {
      op: 'edit', at: 0, new: { excerpt: '延续' },
      replaced: [{ seq: 1, role: 'user', excerpt: 'a' }, { seq: 2, role: 'user', excerpt: 'b' }],
      replacedMore: 1,
    }
    const versions = [rec(9)]
    const digests = digestMap([[9, { what, called: false }]])
    const closed = hooks.buildDisplayRows({ versions, digests, tree: null, expanded: null })[0]
    // 内容行 = ② 现在这条(取不到时的如实说明) + 2 条引文 + 另有 1 条 + 延续 = 5 行
    // ⇒ 紧凑显示 2 行（②/③），明细 3 行
    expect(closed.contentCount).toBe(5)
    expect(closed.detailCount).toBe(3)
    expect(closed.height).toBe(60 + 18)
    const opened = hooks.buildDisplayRows({ versions, digests, tree: null, expanded: null, detailOpen: new Map([[9, true]]) })[0]
    expect(opened.detailOpen).toBe(true)
    expect(opened.height).toBe(60 + 18 + 3 * 18)
    // 渲染出来的内容行数必须与预留高度一致(模型与渲染同源)
    const rendered = hooks.VersionRow({ record: rec(9), t: tZh, top: 0, what, detailOpen: true, onPreview() {}, onJump() {} })
    const bodyLines = collect(rendered).filter((el) => {
      const name = String(el.props.className ?? '')
      return ['dsh-rt-version-line', 'dsh-rt-what-quote', 'dsh-rt-what-more', 'dsh-rt-what-summary', 'dsh-rt-version-files'].some((cls) => name.includes(cls))
    }).length
    // 首行 + 紧凑内容行(2: ②③) + 明细行(3) = 6
    expect(bodyLines).toBe(6)
    // 预留高度 == 实际渲染行数（模型与渲染同源，不裁切）
    expect(60 + (bodyLines - 2) * 18).toBe(opened.height)
  })

  it('行高锁：ROW_H = 60,三处行高 CSS 都是 60px(不再是 112px)', () => {
    const source = sourceOf()
    expect(source).toContain('const ROW_H = 60')
    expect(source).not.toContain('const ROW_H = 116')
    // 窗口化列表的行高与三处行 CSS 必须同步(改一处不改另一处 = 行错位/裁切)
    expect(source.match(/height:60px/g) ?? []).toHaveLength(3)
    expect(source).not.toContain('height:112px')
    for (const selector of ['.dsh-rt-version{', '.dsh-rt-tree-toggle{', '.dsh-rt-fallback{']) {
      const line = source.split('\n').find((candidate) => candidate.startsWith(selector))
      expect(line, selector).toBeDefined()
      expect(line, selector).toContain('height:60px')
    }
  })

  it('收起/展开的滚动锚定：视口上方的高度变化按 delta 补偿（下方变化交给浏览器夹取）', () => {
    // 折叠：视口上方少了 60px ⇒ scrollTop 减 60，视口里的内容不动
    expect(hooks.anchoredScrollTop({ scrollTop: 240, anchorOffset: 60, delta: -60 })).toBe(180)
    // 展开：视口上方多了 54px ⇒ scrollTop 加 54
    expect(hooks.anchoredScrollTop({ scrollTop: 240, anchorOffset: 60, delta: 54 })).toBe(294)
    // 变化在视口下方（锚点 offset ≥ scrollTop）⇒ 不动，底部边界让浏览器夹取
    expect(hooks.anchoredScrollTop({ scrollTop: 0, anchorOffset: 300, delta: -60 })).toBe(0)
    // 顶到 0 不为负
    expect(hooks.anchoredScrollTop({ scrollTop: 30, anchorOffset: 0, delta: -200 })).toBe(0)
    // 没有高度变化 ⇒ 原样
    expect(hooks.anchoredScrollTop({ scrollTop: 120, anchorOffset: 0, delta: 0 })).toBe(120)
  })

  it('窗口化：可见窗口按前缀和二分求（行高不再恒定也不出错）', () => {
    const rows = [{ height: 60 }, { height: 60 }, { height: 96 }, { height: 60 }]
    const offsets = [0, 60, 120, 216]
    expect(hooks.visibleFrom(rows, offsets, 0)).toBe(0)
    expect(hooks.visibleFrom(rows, offsets, 130)).toBe(0)      // 落在第 3 行内 + 2 行 slack ⇒ 仍是 0
    expect(hooks.visibleFrom(rows, offsets, 230)).toBe(1)      // 越过第 3 行 ⇒ 起点 3 − slack 2 = 1
    expect(hooks.visibleTo(rows, offsets, 0)).toBe(2)          // 底部 0 ⇒ 只留 slack
    expect(hooks.visibleTo(rows, offsets, 200)).toBe(4)        // 覆盖到第 4 行 ⇒ 到末尾
    // 空列表不炸
    expect(hooks.visibleFrom([], [], 100)).toBe(0)
    expect(hooks.visibleTo([], [], 100)).toBe(0)
  })

  // ---- 深层档不再点不开 (2026-09-15 final UX fix) ---------------------------

  it('默认收起：默认输出里没有任何 level ≥ 1 的内容行（点击才展开）', () => {
    const versions = [1, 2, 3, 4].map((seq) => rec(seq))
    const digests = digestMap(versions.map((record) => [record.boundarySeq, fullDigest()]))
    const tree = chain(4)
    const rows = hooks.buildDisplayRows({ versions, digests, tree, expanded: null })
    // 默认收起：没有任何**内容行**带缩进（折叠入口 chip 仍然缩进在父档下面，
    // 它表示"这里还能展开"，不是子级内容）
    const content = rows.filter((row) => row.record !== undefined)
    expect(content.length).toBeGreaterThan(0)
    expect(content.some((row) => row.level >= 1), '默认不得有任何 level ≥ 1 的内容行').toBe(false)
    expect(content.every((row) => row.level === 0)).toBe(true)
    // 有子节点的根只留一个折叠入口（点击才展开）
    expect(rows.filter((row) => row.kind === 'collapsed')).toHaveLength(1)

    // 点击（显式展开）后才出现 level 1 的子行
    const opened = hooks.buildDisplayRows({ versions, digests, tree, expanded: new Map([[1, true]]) })
    expect(opened.map((row) => [row.kind, row.level])).toEqual([['row', 0], ['expanded', 1], ['row', 1], ['collapsed', 2], ['expanded', 1]])
    // 再收起（用户点收起 ⇒ false）⇒ 回到展开前
    const closed = hooks.buildDisplayRows({ versions, digests, tree, expanded: new Map([[1, false]]) })
    expect(closed.map((row) => [row.kind, row.level])).toEqual([['row', 0], ['collapsed', 1]])
    // 往返：再展开一次结果与第一次相同（不崩）
    const reopened = hooks.buildDisplayRows({ versions, digests, tree, expanded: new Map([[1, true]]) })
    expect(reopened.map((row) => [row.kind, row.level])).toEqual(opened.map((row) => [row.kind, row.level]))
  })

  it('缩进分级可见：paddingLeft 跟着已放开深度递增（0/14/28/42/56/70），同级之间相等', () => {
    const versions = [1, 2, 3, 4, 5, 6].map((seq) => rec(seq))
    const digests = digestMap(versions.map((record) => [record.boundarySeq, fullDigest()]))
    const tree = chain(6)
    // 逐级放开：第 5 级(level 4)的节点要多放开一层才能显示它的子级（点一次给 next）
    const rows = hooks.buildDisplayRows({ versions, digests, tree, expanded: new Map([[1, true], [2, true], [3, true], [4, true], [5, 2]]) })
    const contentAt = (level) => rows.find((row) => row.kind === 'row' && row.level === level)
    const padOf = (row) => hooks.VersionRow({
      record: row.record, t: tZh, top: 0, level: row.level, current: row.current === true, nested: row.level > 0,
      what: row.digest?.what ?? null, discardedCount: row.discardedCount, onPreview() {}, onJump() {},
    }).props.style.paddingLeft
    // 父/子/孙/曾孙/第 5 级/第 6 级：严格递增，不设 3 级上限
    expect([0, 1, 2, 3, 4, 5].map((level) => padOf(contentAt(level))))
      .toEqual(['0px', '14px', '28px', '42px', '56px', '70px'])
    // 同级之间相等（一样深的两条行缩进一致）
    const sameLevel = rows.filter((row) => row.kind === 'row' && row.level === 1)
    if (sameLevel.length >= 2) expect(padOf(sameLevel[0])).toBe(padOf(sameLevel[1]))
    // 层级配色也跟着分级
    const colorAt = (level) => hooks.VersionRow({
      record: contentAt(level).record, t: tZh, top: 0, level, current: false, nested: level > 0,
      what: contentAt(level).digest?.what ?? null, onPreview() {}, onJump() {},
    })
    expect(hasClass(colorAt(1), 'dsh-rt-level-1')).toBe(true)
    expect(hasClass(colorAt(2), 'dsh-rt-level-2')).toBe(true)
    // 折叠/收起/深层入口（chip）也走同一套 14px 步进
    const chipPad = (level) => {
      const chip = rows.find((row) => (row.kind === 'expanded' || row.kind === 'collapsed' || row.kind === 'depth') && row.level === level)
      expect(chip, `chip at level ${level}`).toBeDefined()
      return hooks.CheckpointRow({
        row: chip, t: tZh, top: 0, onToggle() {}, onToggleDepth() {}, onToggleDetail() {}, onPreview() {}, onJump() {},
      }).props.style.paddingLeft
    }
    expect([1, 2, 3, 4].map(chipPad)).toEqual(['14px', '28px', '42px', '56px'])
  })

  it('配色只用 3 级：第 4 级起沿用 L3 的颜色（颜色是分类，缩进才是深度）', () => {
    // 只允许 level-1/2/3 三个配色类，且更深一律落到 level-3
    expect([0, 1, 2, 3, 4, 5, 9].map((level) => hooks.levelClassOf(level))).toEqual([
      '', ' dsh-rt-level-1', ' dsh-rt-level-2', ' dsh-rt-level-3', ' dsh-rt-level-3', ' dsh-rt-level-3', ' dsh-rt-level-3',
    ])
    // 缩进没有 3 级上限（与配色解耦）
    expect([0, 1, 3, 4, 9].map((level) => hooks.indentOf(level))).toEqual(['0px', '14px', '42px', '56px', '126px'])
    // 样式表里不得出现第 4 种配色类
    const source = sourceOf()
    expect(source).not.toContain('.dsh-rt-level-4')
    expect(source).not.toContain('.dsh-rt-level-5')
    // 真实渲染：level 4 的行同时具备 56px 缩进与 level-3 的颜色
    const versions4 = [1, 2, 3, 4, 5].map((seq) => rec(seq))
    const digests4 = digestMap(versions4.map((record) => [record.boundarySeq, fullDigest()]))
    const rows4 = hooks.buildDisplayRows({
      versions: versions4, digests: digests4, tree: chain(5),
      expanded: new Map([[1, true], [2, true], [3, true], [4, true]]),
    })
    const l4 = rows4.find((row) => row.kind === 'row' && row.level === 4)
    const element = hooks.VersionRow({
      record: l4.record, t: tZh, top: 0, level: l4.level, current: false, nested: true,
      what: l4.digest?.what ?? null, onPreview() {}, onJump() {},
    })
    expect(element.props.style.paddingLeft).toBe('56px')
    expect(hasClass(element, 'dsh-rt-level-3')).toBe(true)
    expect(hasClass(element, 'dsh-rt-level-4')).toBe(false)
  })

  it('重复/无意义的输入挂在父档下面时必须缩进一级（不与父档对齐）', () => {
    // (a) 父档 + 同一批重复编辑：它们彼此同级，但都必须缩进一级
    const versions = [rec(1), rec(2), rec(3), rec(4)]
    const digests = digestMap(versions.map((record) => [record.boundarySeq, fullDigest()]))
    const batch = treeOf({
      '1': { parent: null, children: [2, 3, 4], discardedCount: 3 },
      '2': { parent: 1, children: [], discardedCount: 1 },
      '3': { parent: 1, children: [], discardedCount: 1 },
      '4': { parent: 1, children: [], discardedCount: 1 },
    })
    const rows = hooks.buildDisplayRows({ versions, digests, tree: batch, expanded: new Map([[1, true]]) })
    const levels = rows.filter((row) => row.record !== undefined).map((row) => row.level)
    expect(levels).toEqual([0, 1, 1, 1])                 // 父档 0；同批 3 条都在 level 1
    expect(new Set(levels.slice(1)).size).toBe(1)        // 同批之间同级（相等）
    expect(levels.slice(1).every((level) => level >= 1)).toBe(true)

    // (b) 安静档（重复/无意义输入本身不占时间线）挂着一个普通子档：
    //     子档必须缩进一级；安静档的入口 chip 不得比它自己的子档更深
    const quietRoot = treeOf({
      '2': { parent: null, children: [3], discardedCount: 1 },
      '3': { parent: 2, children: [], discardedCount: 0 },
    })
    const quietRows = hooks.buildDisplayRows({
      versions: [rec(2), rec(3)],
      digests: digestMap([[2, quietDigest()], [3, fullDigest()]]),
      tree: quietRoot,
      expanded: new Map([[2, true]]),
    })
    const child = quietRows.find((row) => row.record?.boundarySeq === 3)
    const chip = quietRows.find((row) => row.seq === 2)
    expect(child, '安静档的子档要出现').toBeDefined()
    expect(child.level, '安静档的子档必须缩进一级').toBeGreaterThanOrEqual(1)
    expect(chip.level).toBeLessThanOrEqual(child.level)
    // 安静档自己没有内容行（R20：它们收在底部区块里）
    expect(quietRows.some((row) => row.kind === 'row' && row.record?.boundarySeq === 2)).toBe(false)

    // (c) 安静档在普通父档下面时，它的子档仍然缩进（≥ 1，且与父档不同级）
    const nested = treeOf({
      '1': { parent: null, children: [2], discardedCount: 2 },
      '2': { parent: 1, children: [3], discardedCount: 1 },
      '3': { parent: 2, children: [], discardedCount: 0 },
    })
    const nestedRows = hooks.buildDisplayRows({
      versions: [rec(1), rec(2), rec(3)],
      digests: digestMap([[1, fullDigest()], [2, quietDigest()], [3, fullDigest()]]),
      tree: nested,
      expanded: new Map([[1, true], [2, true]]),
    })
    const parent = nestedRows.find((row) => row.record?.boundarySeq === 1)
    const leaf = nestedRows.find((row) => row.record?.boundarySeq === 3)
    expect(parent.level).toBe(0)
    expect(leaf.level).toBeGreaterThan(parent.level)
  })


  it('深层档不再点不开：点一次「还有 N 层」多出一级子行（入口是按钮,不是死胡同文本）', () => {
    const versions = [1, 2, 3, 4, 5, 6, 7].map((seq) => rec(seq))
    const digests = digestMap(versions.map((record) => [record.boundarySeq, fullDigest()]))
    const tree = chain(7)
    const deep = new Map([[1, true], [2, true], [3, true]])
    const before = hooks.buildDisplayRows({ versions, digests, tree, expanded: deep })
    const depth = before.find((row) => row.kind === 'depth')
    expect(depth, '第 4 级应出现「还有 N 层」').toBeDefined()
    expect(depth.seq).toBe(4)
    expect(depth.level).toBe(3)
    expect(depth.next).toBe(1)                                  // 一次恰好放开一级
    expect(before.some((row) => row.record?.boundarySeq === 5)).toBe(false)

    // 入口必须是一个可点的按钮（原来是一段不可点的文本）
    const clicked = []
    const chip = hooks.CheckpointRow({
      row: depth, t: tZh, top: 0, onToggle() {},
      onToggleDepth: (seq, next) => clicked.push([seq, next]), onPreview() {}, onJump() {},
    })
    const button = collect(chip).find((element) => element.type === 'button')
    expect(button, '「还有 N 层」必须是按钮').toBeDefined()
    expect(allText(button).join('')).toContain(tZh('tree.moreLevels', { count: 3 }))
    expect(button.props.title).toBe(tZh('tree.deepen'))
    button.props.onClick()
    expect(clicked).toEqual([[4, 1]])

    // 视图语义：预算提到 next ⇒ 恰好多出一级（#5 出现、#6 仍不可见）
    const after = hooks.buildDisplayRows({ versions, digests, tree, expanded: new Map([...deep, [4, 1]]) })
    const afterSeqs = after.map((row) => row.record?.boundarySeq).filter((seq) => seq !== undefined)
    expect(afterSeqs).toContain(5)
    expect(afterSeqs).not.toContain(6)
    expect(after.filter((row) => row.kind === 'depth').map((row) => row.seq)).toEqual([5])
  })

  it('深度预算逐级：点一次只放一级（不会一次到底）', () => {
    const versions = [1, 2, 3, 4, 5, 6, 7].map((seq) => rec(seq))
    const digests = digestMap(versions.map((record) => [record.boundarySeq, fullDigest()]))
    const tree = chain(7)
    const base = new Map([[1, true], [2, true], [3, true]])
    const seqsOf = (expanded) => hooks.buildDisplayRows({ versions, digests, tree, expanded })
      .map((row) => row.record?.boundarySeq).filter((seq) => seq !== undefined)

    expect(seqsOf(base)).toEqual([1, 2, 3, 4])                      // 只到第 4 级
    expect(seqsOf(new Map([...base, [4, 1]]))).toEqual([1, 2, 3, 4, 5])
    expect(seqsOf(new Map([...base, [4, 1], [5, 2]]))).toEqual([1, 2, 3, 4, 5, 6])
    // 第 7 级要第三次点击才出现 —— 绝不是"一次全展开"
    expect(seqsOf(new Map([...base, [4, 1], [5, 2]]))).not.toContain(7)
    expect(seqsOf(new Map([...base, [4, 1], [5, 2], [6, 3]]))).toContain(7)
    // 每一级都是"新出现的那个 depth 行"自己带 next
    const rows = hooks.buildDisplayRows({ versions, digests, tree, expanded: new Map([...base, [4, 1]]) })
    expect(rows.filter((row) => row.kind === 'depth').map((row) => [row.seq, row.level, row.next])).toEqual([[5, 4, 2]])
  })

  it('安静节点在深层同样点得开（两个分支的 next 都要对）', () => {
    const versions = [1, 2, 3, 4, 5].map((seq) => rec(seq))
    // #4 是安静档(R20 不占主时间线)，但它仍然是一个真实节点、也有子树。
    const digests = digestMap([
      [1, fullDigest()], [2, fullDigest()], [3, fullDigest()], [4, quietDigest()], [5, fullDigest()],
    ])
    const tree = chain(5)
    const deep = new Map([[1, true], [2, true], [3, true]])
    const before = hooks.buildDisplayRows({ versions, digests, tree, expanded: deep })
    const depth = before.find((row) => row.kind === 'depth')
    expect(depth, '安静档在深层也应该有「还有 N 层」入口').toBeDefined()
    expect(depth.seq).toBe(4)
    expect(depth.next).toBe(1)                       // 安静分支同样"一次一级"
    expect(before.some((row) => row.record?.boundarySeq === 5)).toBe(false)
    // 放开一级后 #5 出现（安静节点自己没有行，子行照常渲染）
    const after = hooks.buildDisplayRows({ versions, digests, tree, expanded: new Map([...deep, [4, 1]]) })
    expect(after.map((row) => row.record?.boundarySeq).filter((seq) => seq !== undefined)).toEqual([1, 2, 3, 5])
  })

  it('放开后能收起回原状：收起 chip 把这一档的深度预算清零', () => {
    const versions = [1, 2, 3, 4, 5, 6, 7].map((seq) => rec(seq))
    const digests = digestMap(versions.map((record) => [record.boundarySeq, fullDigest()]))
    const tree = chain(7)
    const base = new Map([[1, true], [2, true], [3, true]])
    const opened = hooks.buildDisplayRows({ versions, digests, tree, expanded: new Map([...base, [4, 1]]) })
    const chipRow = opened.find((row) => row.kind === 'expanded' && row.seq === 4)
    expect(chipRow, '放开后必须有一枚可见的收起 chip').toBeDefined()
    const toggled = []
    const chip = hooks.CheckpointRow({
      row: chipRow, t: tZh, top: 0, onToggle: (seq) => toggled.push(seq),
      onToggleDepth() {}, onToggleDetail() {}, onPreview() {}, onJump() {},
    })
    const button = collect(chip).find((element) => element.type === 'button')
    expect(allText(button).join('')).toContain(tZh('tree.collapse'))
    button.props.onClick()
    expect(toggled).toEqual([4])

    // 视图 toggle 语义：预算 > 0 ⇒ 0（回原状）；回原状后「还有 N 层」重新出现、#5 消失
    const closed = hooks.buildDisplayRows({ versions, digests, tree, expanded: new Map([...base, [4, hooks.budgetOf(1) > 0 ? 0 : 1]]) })
    expect(closed.filter((row) => row.kind === 'depth').map((row) => row.seq)).toEqual([4])
    expect(closed.some((row) => row.record?.boundarySeq === 5)).toBe(false)
    // 回原状后还能再点开（往返）
    const reopened = hooks.buildDisplayRows({ versions, digests, tree, expanded: new Map([...base, [4, 1]]) })
    expect(reopened.map((row) => row.record?.boundarySeq).filter((seq) => seq !== undefined)).toContain(5)
  })

  // ---- 「给人读」改版：文案锁 (2026-09-15) --------------------------------

  it('给人读·首行不再说"丢弃"：计数用「换掉了 N 条」', () => {
    const element = richRow()
    const text = textOf(element)
    expect(text).toContain(tZh('what.countShort', { count: 10 }))
    expect(tZh('what.countShort', { count: 10 })).toBe('换掉了 10 条')
    expect(text).not.toContain('丢弃')
    // 展开后同样不得出现"丢弃"
    expect(textOf(richRow({ detailOpen: true }))).not.toContain('丢弃')
  })

  it('给人读·第二行是「原来的内容：{角色}「原文」」，且全行不露 #seq', () => {
    const element = richRow()
    const text = textOf(element)
    expect(text).toContain(tZh('what.oldLabel'))
    expect(tZh('what.oldLabel')).toBe('原来的内容：')
    expect(text).toContain('「我和外部AI的思路一致」')
    // 任何行的可见文本都不得出现 #<数字>
    for (const rendered of [element, richRow({ detailOpen: true }), hooks.QuietRow({ record: rec(4), t: tZh, onJumpLatest() {} })]) {
      expect(textOf(rendered)).not.toMatch(/#\d+/)
    }
    // tooltip 也不许带 seq
    for (const el of collect(element)) {
      for (const value of Object.values(el.props ?? {})) {
        if (typeof value === 'string') expect(value).not.toMatch(/#\d+/)
      }
    }
  })

  it('给人读·压缩行的第二行只说"宿主压缩了上下文"，绝不把压缩摘要当"原来的内容"', () => {
    // 压缩档的 what.replaced 里那段文本其实是**压缩摘要本身**（真实数据就这样），
    // 标成"原来的内容"会让人以为被换掉的就是它 ⇒ 压缩行固定只给归属说明。
    const summaryText = 'This is an automatically generated checkpoint condensing an earlier conversation'
    const compaction = {
      op: 'compaction', at: 0, new: { excerpt: '' },
      replaced: [{ seq: 1, role: 'user', excerpt: summaryText }], replacedMore: 813,
    }
    const element = hooks.VersionRow({
      record: rec(9100, 'compaction'), t: tZh, top: 0, what: compaction, discardedCount: 814,
      onPreview() {}, onJump() {},
    })
    const text = textOf(element)
    expect(text).toContain('宿主')                      // 归属说明
    expect(tZh('what.compacted')).toContain('宿主')
    expect(text).not.toContain('原来的内容')              // 不得把摘要当原文
    expect(text).not.toContain(summaryText)             // 摘录一律不显示
    expect(text).toContain(tZh('timeline.kind.compaction'))
    // 展开态（若将来有明细）同样不得出现摘录
    const opened = hooks.VersionRow({
      record: rec(9100, 'compaction'), t: tZh, top: 0, what: compaction, discardedCount: 814,
      detailOpen: true, onToggleDetail() {}, onPreview() {}, onJump() {},
    })
    expect(textOf(opened)).not.toContain(summaryText)
    // 非压缩档仍然照常显示"原来的内容"
    expect(textOf(richRow())).toContain('原来的内容')
  })

  it('给人读·行尾只剩两个语义清楚的动作：跳转（纯导航）与 回到这一档（回退）', () => {
    const element = richRow()
    const actions = collect(element).find((el) => String(el.props.className ?? '').includes('dsh-rt-version-actions'))
    expect(actions).toBeDefined()
    const buttons = collect(actions).filter((el) => el.type === 'button')
    expect(buttons.map((el) => allText(el).join(''))).toEqual([tZh('timeline.restoreTo'), tZh('timeline.jump')])
    // 两者文案必须一眼能分清（不同词、不是近义词）
    expect(tZh('timeline.restoreTo')).toBe('回到这一档')
    expect(tZh('timeline.jump')).toBe('跳转')
    expect(tZh('timeline.restoreTo')).not.toBe(tZh('timeline.jump'))
    // 行里不再出现「明细」这一类中间入口
    expect(textOf(element)).not.toContain('明细')
  })

  it('给人读·行尾有「›」且带 title（点它展开这一档）', () => {
    let toggled = []
    const element = richRow({ onToggleDetail: (seq) => toggled.push(seq) })
    const open = collect(element).find((el) => String(el.props.className ?? '').includes('dsh-rt-row-open'))
    expect(open, '行尾必须有「›」入口').toBeDefined()
    expect(allText(open).join('')).toBe('›')
    expect(open.props.title).toBe(tZh('timeline.openEntry'))
    expect(open.props['aria-label']).toBe(tZh('timeline.openEntry'))
    open.props.onClick()
    expect(toggled).toEqual([9204])
  })

  it('给人读·折叠 chip 去比喻、压缩行带归属', () => {
    expect(tZh('tree.changes', { count: 3 })).toBe('这一档里还有 3 次改动')
    expect(tZh('tree.changes', { count: 3 })).toContain('这一档')
    const versions = [rec(1), rec(2)]
    const digests2 = digestMap([[1, fullDigest()], [2, fullDigest()]])
    const tree = treeOf({ '1': { parent: null, children: [2], discardedCount: 1 }, '2': { parent: 1, children: [], discardedCount: 0 } })
    const flat = hooks.buildDisplayRows({ versions, digests: digests2, tree, expanded: null })
    const chip = hooks.CheckpointRow({ row: flat.find((row) => row.kind === 'collapsed'), t: tZh, top: 0, onToggle() {}, onToggleDepth() {}, onToggleDetail() {}, onPreview() {}, onJump() {} })
    expect(textOf(chip)).toContain('这一档')
    expect(textOf(chip)).not.toContain('这条路')
    // 压缩行：必须写明是"宿主"压缩的（不是我们弄丢的）
    expect(tZh('what.compacted')).toContain('宿主')
    const compacted = hooks.VersionRow({
      record: rec(200), t: tZh, top: 0,
      what: { op: 'recall', new: { excerpt: '' }, replaced: [{ seq: 1, role: 'unknown', excerpt: '' }], replacedMore: 6 },
      discardedCount: 7, onPreview() {}, onJump() {},
    })
    expect(textOf(compacted)).toContain('宿主')
    expect(textOf(compacted)).not.toMatch(/#\d+/)
  })

  it('给人读·页首顺序提示存在（页首说明在视图里渲染，见 mounted 用例）', () => {
    expect(tZh('timeline.orderHint')).toBe('最近的改动在最下面')
    expect(zh['timeline.openEntry']).toBe('查看这一档')
  })

  // ---- R40/R41/R43: 「这一条是什么」+ 纯文本分级（真机反馈 2026-09-15） ------
  //
  // 用户原话：①「这个条目，现在是什么我并不知道——这一轮的输入」②「（压缩 814
  // → 1002 → 1265 三行）这一块不应该是三级的缩进区别吗」。两条都要求**不点开
  // 就能看出来**，而且复制成纯文本后仍然成立。

  // `CheckpointRow` returns an ELEMENT whose type is the `VersionRow` function
  // (the react mock never renders it). Unwrap component elements so the
  // assertions run on real render output, not on the element descriptor.
  const renderDeep = (node) => {
    if (Array.isArray(node)) return node.map(renderDeep)
    if (node && typeof node === 'object' && node.type !== undefined) {
      if (typeof node.type === 'function') return renderDeep(node.type(node.props))
      return { ...node, children: (node.children ?? []).map(renderDeep) }
    }
    return node
  }
  const line1Of = (element) => {
    const line = collect(renderDeep(element)).find((el) => String(el.props.className ?? '').includes('dsh-rt-version-line'))
    expect(line, '首行必须存在').toBeDefined()
    return allText(line).join('')
  }

  it('R40 · 行首写明这是第几轮：编辑重发 · 第 159 轮 · 时间 · 换掉了 N 条', () => {
    const element = hooks.VersionRow({
      record: rec(9300), t: tZh, top: 0, level: 0, turn: 159,
      what: richWhat(), discardedCount: 10, onPreview() {}, onJump() {},
    })
    const line1 = line1Of(element)
    expect(tZh('timeline.round', { n: 159 })).toBe('第 159 轮')
    expect(line1).toContain('第 159 轮')
    // 顺序：动作 → 轮次 → 计数（读起来是"编辑重发 · 第 159 轮 · … · 换掉了 N 条"）
    expect(line1.indexOf(tZh('timeline.kind.edit'))).toBeLessThan(line1.indexOf('第 159 轮'))
    expect(line1.indexOf('第 159 轮')).toBeLessThan(line1.indexOf(tZh('what.countShort', { count: 10 })))
    // 行模型 → 渲染 全链：轮次从摘要记录流到行，再流进首行
    const versions = [rec(9300)]
    const digests = digestMap([[9300, { ...fullDigest(richWhat()), turn: 159 }]])
    const [row] = hooks.buildDisplayRows({ versions, digests, tree: null, expanded: null })
    expect(row.turn).toBe(159)
    const mounted = hooks.CheckpointRow({
      row, t: tZh, top: 0, onToggle() {}, onToggleDepth() {}, onToggleDetail() {}, onPreview() {}, onJump() {},
    })
    expect(line1Of(mounted)).toContain('第 159 轮')
    expect(line1Of(mounted)).toBe(line1Of(element))
  })

  it('R40 · 取不到轮次就整段省略（不出现"第 ? 轮"、不留空标签）', () => {
    // 摘要记录里没有 turn（旧档 / 日志里没有 turn）⇒ 首行只剩 动作 · 时间
    const noTurn = line1Of(richRow())
    expect(noTurn).not.toContain('第 ')
    expect(noTurn).not.toContain('轮')
    expect(noTurn).toContain(tZh('timeline.kind.edit'))
    // turn = 0 / 负数 / 非整数同样当作取不到（真机 turn 从 1 起）
    for (const bad of [0, -3, 1.5, Number.NaN, null, undefined, '159']) {
      expect(line1Of(richRow({ turn: bad }))).not.toContain('第 ')
    }
    // 摘要记录没有 turn ⇒ 行模型上就是 null（渲染侧统一判空）
    const versions = [rec(9301)]
    const [row] = hooks.buildDisplayRows({ versions, digests: digestMap([[9301, fullDigest()]]), tree: null, expanded: null })
    expect(row.turn).toBeNull()
  })

  it('R41 · 第二行从"这一轮的输入"说人话（user/assistant/tool/unknown 四种）', () => {
    expect(tZh('what.role2.user')).toBe('这一轮的输入')
    expect(tZh('what.role2.assistant')).toBe('助手的回复')
    expect(tZh('what.role2.tool')).toBe('工具输出')
    expect(tZh('what.role2.unknown')).toBe('原内容')
    // 四个词必须彼此不同（不能都退化成同一个笼统的词）
    const words = ['user', 'assistant', 'tool', 'unknown'].map((role) => tZh(`what.role2.${role}`))
    expect(new Set(words).size).toBe(4)
    const rowOf = (role) => hooks.VersionRow({
      record: rec(9310), t: tZh, top: 0, turn: 12,
      what: { op: 'edit', at: 0, new: { excerpt: '' }, replaced: [{ seq: 1, role, excerpt: '派工单' }] },
      discardedCount: 1, onPreview() {}, onJump() {},
    })
    // 完整读法：原来的内容：这一轮的输入「派工单」（同一行首尾相接，逗号分隔符不打断）
    expect(allText(rowOf('user')).join('')).toContain(`${tZh('what.oldLabel')}${tZh('what.role2.user')}「派工单」`)
    expect(textOf(rowOf('assistant'))).toContain(tZh('what.role2.assistant'))
    expect(textOf(rowOf('tool'))).toContain(tZh('what.role2.tool'))
    expect(textOf(rowOf('unknown'))).toContain(tZh('what.role2.unknown'))
    // 旧的"你发送的消息"口径不再出现在任何一行
    expect(textOf(rowOf('user'))).not.toContain(tZh('what.role.user'))
    expect(textOf(richRow({ detailOpen: true }))).not.toContain(tZh('what.role.user'))
  })

  it('R43 · 纯文本也看得出三级：行首引导符逐级变长（与 paddingLeft 同步）', () => {
    const versions = [1, 2, 3, 4].map((seq) => rec(seq))
    const digests = digestMap(versions.map((record) => [record.boundarySeq, fullDigest()]))
    const tree = chain(4)
    const expanded = new Map([[1, true], [2, true], [3, true]])
    const rows = hooks.buildDisplayRows({ versions, digests, tree, expanded }).filter((row) => row.kind === 'row')
    expect(rows.map((row) => row.level)).toEqual([0, 1, 2, 3])
    const rendered = rows.map((row) => {
      const element = renderDeep(hooks.CheckpointRow({
        row, t: tZh, top: 0, onToggle() {}, onToggleDepth() {}, onToggleDetail() {}, onPreview() {}, onJump() {},
      }))
      const text = allText(element).join('')
      return {
        level: row.level,
        paddingLeft: element.props.style.paddingLeft,
        prefix: (text.match(/^(?:\u2502 )+/) ?? [''])[0],
        text,
      }
    })
    // ① 可见前缀（复制成纯文本后仍在）：0 / 2 / 4 / 6 个字符，严格变长
    expect(rendered.map((entry) => entry.prefix.length)).toEqual([0, 2, 4, 6])
    expect(rendered.map((entry) => entry.prefix)).toEqual(['', '\u2502 ', '\u2502 \u2502 ', '\u2502 \u2502 \u2502 '])
    // 一级行没有引导符（前缀为空），但动作标签仍在行里
    expect(rendered[0].text.startsWith('\u2502')).toBe(false)
    expect(rendered[0].text).toContain(tZh('timeline.kind.edit'))
    // 三级行复制出来就是「│ │ │ 编辑重发 · 第 N 轮 · …」
    expect(rendered[3].text.startsWith('\u2502 \u2502 \u2502 ')).toBe(true)
    expect(rendered[3].text).toContain(tZh('timeline.kind.edit'))
    // ② 同时 CSS 缩进也在：0 / 14 / 28 / 42 px（两条线索缺一不可）
    expect(rendered.map((entry) => entry.paddingLeft)).toEqual(['0px', '14px', '28px', '42px'])
    // ③ 折叠/深层 chip 同样带引导符（层级不只在内容行上）
    const chipRow = hooks.buildDisplayRows({ versions, digests, tree, expanded: new Map([[1, true], [2, true]]) })
      .find((row) => row.kind === 'depth' || row.kind === 'collapsed' || row.kind === 'expanded')
    expect(chipRow, '二级以上应出现 chip').toBeDefined()
    const chip = renderDeep(hooks.CheckpointRow({
      row: chipRow, t: tZh, top: 0, onToggle() {}, onToggleDepth() {}, onToggleDetail() {}, onPreview() {}, onJump() {},
    }))
    expect(allText(chip).join('').startsWith('\u2502 '.repeat(chipRow.level))).toBe(true)
    expect(collect(chip).some((el) => String(el.props.className ?? '').includes('dsh-rt-indent-guide'))).toBe(true)
  })

  it('已丢弃内容不可跳转（只有活路行才有跳转动作）', () => {
    const element = hooks.VersionRow({
      record: rec(1), t: tZh, top: 0, level: 0, current: true, nested: false,
      what: whatOf(2), onPreview() {}, onJump() {},
    })
    const discarded = collect(element).find((el) => String(el.props.className ?? '').includes('dsh-rt-what-old'))
    expect(discarded).toBeDefined()
    expect(collect(discarded).some((el) => el.type === 'button')).toBe(false)
  })

  // ---- R44–R48: 「现在这条」读序 + 收起位置 + 逐级色条（用户口径 2026-09-15） --

  const nowOf = (seq, excerpt, role = 'user') => ({ seq, role, excerpt })
  const nowRow = (extra = {}) => hooks.VersionRow({
    record: rec(9400), t: tZh, top: 0, kind: 'edit',
    what: richWhat(), discardedCount: 10, turn: 160,
    onPreview() {}, onJump() {}, ...extra,
  })
  // 内容行只有这几类是"一行"（label/jump 这些是行内片段，不是行）
  const LINE_CLASSES = ['dsh-rt-what-quote', 'dsh-rt-what-more', 'dsh-rt-what-summary', 'dsh-rt-version-files']
  const contentLinesOf = (element) => collect(renderDeep(element))
    .filter((el) => {
      const name = String(el.props.className ?? '')
      return LINE_CLASSES.some((cls) => name.includes(cls))
    })
    .map((el) => allText(el).join(''))

  it('R44 · 读序是 ② 现在这条 → ③ 原来的内容（现在这条在前，可跳转）', () => {
    expect(tZh('what.nowLabel')).toBe('现在这条：')
    const jumped = []
    const element = nowRow({ now: nowOf(8706, '新发出去的那句'), onJump: () => jumped.push('jump') })
    const lines = contentLinesOf(element)
    expect(lines[0]).toContain(tZh('what.nowLabel'))
    expect(lines[0]).toContain('「新发出去的那句」')
    expect(lines[1]).toContain(tZh('what.oldLabel'))
    // ② 就是「跳转」的同一个动作（不是第二个入口）
    const jump = collect(renderDeep(element)).find((el) => String(el.props.className ?? '').includes('dsh-rt-what-jump'))
    expect(jump, '② 必须可跳转').toBeDefined()
    expect(jump.props.title).toBe(tZh('timeline.jump'))
    expect(jump.props['aria-label']).toBe(tZh('timeline.jump'))
    jump.props.onClick()
    expect(jumped).toEqual(['jump'])
    // 行尾仍然只有那两个动作（没有新增第三个入口）
    const actions = collect(element).find((el) => String(el.props.className ?? '').includes('dsh-rt-version-actions'))
    expect(collect(actions).filter((el) => el.type === 'button').map((el) => allText(el).join('')))
      .toEqual([tZh('timeline.restoreTo'), tZh('timeline.jump')])
  })

  it('R44 · 跳转目标是"现在这条"的 seq（读端不知道时才退回边界 seq）', () => {
    const versions = [rec(8699)]
    const digests = digestMap([[8699, { ...fullDigest(richWhat()), now: nowOf(8706, '新发出去的那句') }]])
    const [row] = hooks.buildDisplayRows({ versions, digests, tree: null, expanded: null })
    expect(row.now?.seq).toBe(8706)
    expect(hooks.jumpTargetOf(row)).toBe(8706)
    // 读端没给出对应物 ⇒ 退回边界 seq（纯导航，不编造）
    const [bare] = hooks.buildDisplayRows({ versions, digests: digestMap([[8699, fullDigest(richWhat())]]), tree: null, expanded: null })
    expect(bare.now).toBeNull()
    expect(hooks.jumpTargetOf(bare)).toBe(8699)
    expect(hooks.jumpTargetOf({ record: { boundarySeq: 42 } })).toBe(42)
  })

  it('R44 · ② 与 ③ 文本相同 ⇒ 合并成一句，不出现两段重复引文', () => {
    const same = richWhat().replaced[0].excerpt
    const element = nowRow({
      what: { ...richWhat(), replaced: [{ seq: 1, role: 'user', excerpt: same }] },
      now: nowOf(8706, same),
    })
    const text = allText(renderDeep(element)).join('')
    expect(text).toContain(tZh('what.resentSame'))
    expect(tZh('what.resentSame')).toContain('内容未改')
    expect(text).toContain(`「${same}」`)
    // 同一段文本只出现一次（出现两次说明合并没生效）
    expect(text.split(`「${same}」`).length - 1).toBe(1)
    // 合并句本身仍然可跳转（② 的动作没有因为合并而消失）
    const jump = collect(renderDeep(element)).find((el) => String(el.props.className ?? '').includes('dsh-rt-what-jump'))
    expect(jump).toBeDefined()
    expect(jump.props.title).toBe(tZh('timeline.jump'))
    // 不相同则照常分两句（不能一律合并）
    const diff = nowRow({ now: nowOf(8706, '改过的那句') })
    expect(allText(renderDeep(diff)).join('')).not.toContain(tZh('what.resentSame'))
  })

  it('R44 · ② 取不到如实写：纯撤回 / 其他原因各一句（都不编造）', () => {
    expect(tZh('what.noNewRecall')).toContain('没有新的对应内容')
    expect(tZh('what.noNewMissing')).toContain('已不在日志里')
    const recall = hooks.VersionRow({
      record: rec(9401, 'recall'), t: tZh, top: 0, what: richWhat(), discardedCount: 2,
      now: null, onPreview() {}, onJump() {},
    })
    const recallLines = contentLinesOf(recall)
    expect(recallLines[0]).toContain(tZh('what.noNewRecall'))
    expect(recallLines[1]).toContain(tZh('what.oldLabel'))
    // 撤回行不得出现"现在这条："这种它拿不到的锚点
    expect(allText(renderDeep(recall)).join('')).not.toContain(tZh('what.nowLabel'))
    // 编辑/重新生成但日志里找不到对应物 ⇒ 另一句
    const gone = nowRow({ now: null })
    const goneLines = contentLinesOf(gone)
    expect(goneLines[0]).toContain(tZh('what.noNewMissing'))
    expect(goneLines[0]).not.toContain(tZh('what.noNewRecall'))
    // 任何一行都不露 #seq（现在这条也不例外）
    for (const rendered of [renderDeep(gone), renderDeep(recall), renderDeep(nowRow({ now: nowOf(8706, 'x') }))]) {
      expect(allText(rendered).join('')).not.toMatch(/#\d+/)
    }
  })

  it('R45 · 压缩行只给「跳转」：不出现「回到这一档」', () => {
    const compaction = {
      op: 'compaction', at: 0, new: { excerpt: '' },
      replaced: [{ seq: 1, role: 'user', excerpt: 'host compaction summary' }], replacedMore: 813,
    }
    const element = hooks.VersionRow({
      record: rec(9100, 'compaction'), t: tZh, top: 0, what: compaction, discardedCount: 814,
      onPreview() {}, onJump() {},
    })
    const actions = collect(element).find((el) => String(el.props.className ?? '').includes('dsh-rt-version-actions'))
    expect(actions).toBeDefined()
    const buttons = collect(actions).filter((el) => el.type === 'button')
    expect(buttons.map((el) => allText(el).join(''))).toEqual([tZh('timeline.jump')])
    expect(allText(element).join('')).not.toContain(tZh('timeline.restoreTo'))
    // 内容行仍然只有一条归属说明（上一轮的锁保持）
    expect(contentLinesOf(element)).toEqual([tZh('what.compacted')])
    // 无 digest 的兜底压缩行同样只给跳转
    const versions = [rec(9101, 'compaction')]
    const [row] = hooks.buildDisplayRows({ versions, digests: digestMap([]), tree: null, expanded: null })
    expect(row.kind).toBe('fallback')
    const fallback = hooks.CheckpointRow({
      row, t: tZh, top: 0, onToggle() {}, onToggleDepth() {}, onToggleDetail() {}, onPreview() {}, onJump() {},
    })
    expect(allText(fallback).join('')).not.toContain(tZh('timeline.restoreTo'))
    // 非压缩行不受影响
    expect(allText(nowRow()).join('')).toContain(tZh('timeline.restoreTo'))
  })

  it('R46 · 收起三处：开头一枚 + 末尾一枚（未展开态一个都没有）', () => {
    const versions = [1, 2, 3].map((seq) => rec(seq))
    const digests = digestMap(versions.map((record) => [record.boundarySeq, fullDigest()]))
    const tree = chain(3)
    const renderText = (row) => allText(renderDeep(hooks.CheckpointRow({
      row, t: tZh, top: 0, onToggle() {}, onToggleDepth() {}, onToggleDetail() {}, onPreview() {}, onJump() {},
    }))).join('')
    // 未展开：可见文本里一个「收起」都没有（只有 ▸ 这一档里还有 N 次改动）
    const closed = hooks.buildDisplayRows({ versions, digests, tree, expanded: null })
    const closedText = closed.map(renderText).join('\n')
    expect(closedText).not.toContain(tZh('tree.collapse'))
    expect(closedText).toContain(tZh('tree.changes', { count: 2 }))
    // 展开：**开头 + 末尾各恰好一枚**（同一个动作，位置不同）
    const opened = hooks.buildDisplayRows({ versions, digests, tree, expanded: new Map([[1, true]]) })
    expect(opened.map((row) => row.kind)).toEqual(['row', 'expanded', 'row', 'collapsed', 'expanded'])
    const chips = opened.filter((row) => row.kind === 'expanded' && row.seq === 1)
    expect(chips.map((row) => row.position)).toEqual(['head', 'tail'])
    const headIndex = opened.indexOf(chips[0])
    const tailIndex = opened.indexOf(chips[1])
    const childIndex = opened.findIndex((row) => row.record?.boundarySeq === 2)
    expect(childIndex, '展开态必须有子行').toBeGreaterThan(-1)
    // 位置：父行 < 开头收起 < 子行 < 末尾收起
    expect(headIndex).toBe(1)
    expect(headIndex).toBeLessThan(childIndex)
    expect(childIndex).toBeLessThan(tailIndex)
    expect(tailIndex).toBe(opened.length - 1)
    // 两枚渲染出来都看得见「收起」，都是按钮、都收这一档
    for (const chip of chips) expect(renderText(chip)).toContain(tZh('tree.collapse'))
    const toggled = []
    for (const chip of chips) {
      const button = collect(renderDeep(hooks.CheckpointRow({
        row: chip, t: tZh, top: 0, onToggle: (seq) => toggled.push(seq), onToggleDepth() {}, onToggleDetail() {}, onPreview() {}, onJump() {},
      }))).find((el) => el.type === 'button')
      expect(button).toBeDefined()
      button.props.onClick()
    }
    expect(toggled).toEqual([1, 1])
    // 收起后（budget 0）两枚都不见了
    const reclosed = hooks.buildDisplayRows({ versions, digests, tree, expanded: new Map([[1, 0]]) })
    expect(reclosed.filter((row) => row.kind === 'expanded')).toHaveLength(0)
    expect(reclosed.map(renderText).join('\n')).not.toContain(tZh('tree.collapse'))
  })

  it('R49 · 悬浮收起条：父行滚出视口上方、末尾还在视口下方时给得出入口', () => {
    // 长展开层：一档展开出 18 个子行（远高于视口 LIST_VIEWPORT_H）⇒ 开头那枚一定
    // 已经滚出视口上方，而末尾那枚还在视口下方。
    const versions = Array.from({ length: 19 }, (_, i) => rec(i + 1))
    const digests = digestMap(versions.map((record) => [record.boundarySeq, fullDigest()]))
    const nodes = { '1': { parent: null, children: Array.from({ length: 18 }, (_, i) => i + 2), discardedCount: 18 } }
    for (let seq = 2; seq <= 19; seq += 1) nodes[String(seq)] = { parent: 1, children: [], discardedCount: 0 }
    const tree = treeOf(nodes)
    const rows = hooks.buildDisplayRows({ versions, digests, tree, expanded: new Map([[1, true]]) })
    const offsets = []
    let total = 0
    for (const row of rows) { offsets.push(total); total += row.height }
    const bottomOf = (index) => offsets[index] + rows[index].height
    const headIndex = rows.findIndex((row) => row.kind === 'expanded' && row.position === 'head')
    const tailIndex = rows.findIndex((row) => row.kind === 'expanded' && row.position === 'tail')
    expect(headIndex).toBeGreaterThan(-1)
    expect(tailIndex).toBeGreaterThan(headIndex)
    const viewport = hooks.LIST_VIEWPORT_H
    expect(total).toBeGreaterThan(viewport)
    // ① 顶部：开头那枚还在视口里 ⇒ 不需要悬浮条
    expect(hooks.collapseHintOf({ rows, offsets, scrollTop: 0, viewportHeight: viewport })).toBeNull()
    // ② 滚到父行/开头收起都到视口上方、而末尾仍在视口下方 ⇒ 必须给悬浮入口
    const scrollTop = Math.ceil(bottomOf(headIndex)) + 5
    expect(offsets[tailIndex]).toBeGreaterThan(scrollTop + viewport)
    const hint = hooks.collapseHintOf({ rows, offsets, scrollTop, viewportHeight: viewport })
    expect(hint, '展开层横跨视口时必须给悬浮收起入口').not.toBeNull()
    expect(hint.seq).toBe(1)
    expect(Number.isSafeInteger(hint.level)).toBe(true)
    // 悬浮条上的标签：轮次取不到时用动作名（都不含 #seq）
    expect(typeof hint.label).toBe('string')
    expect(hint.label).not.toMatch(/#\d+/)
    // ③ 末尾也进了视口 ⇒ 不需要悬浮条（末尾那枚够得着）
    const deep = offsets[tailIndex] - 10
    expect(hooks.collapseHintOf({ rows, offsets, scrollTop: deep, viewportHeight: viewport })).toBeNull()
    // ④ 整个展开层都滚到视口上方 ⇒ 也不需要
    expect(hooks.collapseHintOf({ rows, offsets, scrollTop: total, viewportHeight: viewport })).toBeNull()
    // ⑤ 降级：坏输入不抛
    expect(hooks.collapseHintOf({ rows: null, offsets: null, scrollTop: 0, viewportHeight: viewport })).toBeNull()
    expect(hooks.collapseHintOf({ rows, offsets, scrollTop: Number.NaN, viewportHeight: viewport })).toBeNull()
  })

  it('R49 · 悬浮收起条渲染出来是一个可点的「收起」（点它 = 收起这一档）', () => {
    const hints = []
    const element = renderDeep(hooks.CollapseHint({
      hint: { seq: 4, level: 1, label: tZh('timeline.round', { n: 240 }) },
      t: tZh,
      onToggle: (seq) => hints.push(seq),
    }))
    const text = allText(element).join('')
    expect(text).toContain(tZh('tree.collapse'))
    expect(text).toContain(tZh('timeline.round', { n: 240 }))
    expect(text).not.toMatch(/#\d+/)
    const button = collect(element).find((el) => el.type === 'button')
    expect(button, '悬浮条必须是按钮').toBeDefined()
    expect(button.props.title).toBe(tZh('timeline.collapseHintTitle'))
    button.props.onClick()
    expect(hints).toEqual([4])
    // 没有 hint 时什么都不渲染（不占位、不参与行高）
    expect(hooks.CollapseHint({ hint: null, t: tZh, onToggle() {} })).toBeNull()
  })

  it('R49 · 悬浮条不进行高/offsets：行模型里没有它，前缀和 = 行高之和', () => {
    const versions = Array.from({ length: 12 }, (_, i) => rec(i + 1))
    const digests = digestMap(versions.map((record) => [record.boundarySeq, fullDigest()]))
    const tree = chain(12)
    const rows = hooks.buildDisplayRows({ versions, digests, tree, expanded: new Map([[1, true], [2, true]]) })
    // 行模型里只有这几种 kind（悬浮条是视图层的浮层，不是一行）
    const kinds = new Set(rows.map((row) => row.kind))
    for (const kind of kinds) expect(['row', 'fallback', 'collapsed', 'expanded', 'depth']).toContain(kind)
    // 每一行的高度都是有限数，前缀和 === 行高之和（悬浮条没有被算进去）
    let total = 0
    for (const row of rows) {
      expect(Number.isFinite(row.height)).toBe(true)
      total += row.height
    }
    const offsets = []
    let sum = 0
    for (const row of rows) { offsets.push(sum); sum += row.height }
    expect(sum).toBe(total)
    expect(offsets).toHaveLength(rows.length)
    // 窗口仍然正确：滚到中段时，渲染窗口里确实有一行覆盖该位置（visibleFrom 带
    // 两行余量，所以不能拿它单行做断言 —— 断言"窗口内存在覆盖 scrollTop 的行"）
    const scrollTop = Math.floor(total / 2)
    const from = hooks.clampIndex(hooks.visibleFrom(rows, offsets, scrollTop), rows.length)
    const to = Math.max(from, hooks.clampIndex(hooks.visibleTo(rows, offsets, scrollTop + hooks.LIST_VIEWPORT_H), rows.length))
    const covering = []
    for (let i = from; i < to; i += 1) {
      if (offsets[i] <= scrollTop && scrollTop < offsets[i] + rows[i].height) covering.push(i)
    }
    expect(covering.length, '窗口必须覆盖当前滚动位置').toBeGreaterThan(0)
  })

  it('R47 · 每一级都有该级配色的左侧导引线（父子孙三级都要有，且按级区分）', () => {
    const versions = [1, 2, 3, 4].map((seq) => rec(seq))
    const digests = digestMap(versions.map((record) => [record.boundarySeq, fullDigest()]))
    const rows = hooks.buildDisplayRows({
      versions, digests, tree: chain(4), expanded: new Map([[1, true], [2, true], [3, true]]),
    }).filter((row) => row.kind === 'row')
    expect(rows.map((row) => row.level)).toEqual([0, 1, 2, 3])
    const guides = rows.map((row) => {
      const element = renderDeep(hooks.CheckpointRow({
        row, t: tZh, top: 0, onToggle() {}, onToggleDepth() {}, onToggleDetail() {}, onPreview() {}, onJump() {},
      }))
      return collect(element)
        .map((el) => String(el.props.className ?? ''))
        .filter((name) => name.includes('dsh-rt-indent-guide'))
    })
    // 一级行没有导引线；n 级行恰好 n 条，各带自己的级色（更深沿用 L3 色）
    expect(guides.map((list) => list.length)).toEqual([0, 1, 2, 3])
    expect(guides[1]).toEqual(['dsh-rt-indent-guide dsh-rt-indent-guide-1'])
    expect(guides[2][1]).toBe('dsh-rt-indent-guide dsh-rt-indent-guide-2')
    expect(guides[3][2]).toBe('dsh-rt-indent-guide dsh-rt-indent-guide-3')
    // 配色仍然只有三级（第 4 级沿用 L3）
    const deep = renderDeep(hooks.CheckpointRow({
      row: rows[3], t: tZh, top: 0, onToggle() {}, onToggleDepth() {}, onToggleDetail() {}, onPreview() {}, onJump() {},
    }))
    expect(collect(deep).some((el) => String(el.props.className ?? '').includes('dsh-rt-indent-guide-4'))).toBe(false)
    // 折叠/深层 chip 也带导引线（层级不只在内容行上）
    const chipRow = hooks.buildDisplayRows({ versions, digests, tree: chain(4), expanded: new Map([[1, true], [2, true]]) })
      .find((row) => row.kind === 'depth' || row.kind === 'collapsed' || row.kind === 'expanded')
    const chip = renderDeep(hooks.CheckpointRow({
      row: chipRow, t: tZh, top: 0, onToggle() {}, onToggleDepth() {}, onToggleDetail() {}, onPreview() {}, onJump() {},
    }))
    expect(collect(chip).filter((el) => String(el.props.className ?? '').includes('dsh-rt-indent-guide')).length)
      .toBe(chipRow.level)
  })

  it('roundsOf 把活路表面配成轮次（含截断）', () => {
    const nodes = new Map([
      ['u', { kind: 'user-message', anchorSeq: 5, data: { content: [{ type: 'text', text: 'hello there' }] } }],
      ['a', { kind: 'assistant-step', anchorSeq: 6, data: { blocks: [{ kind: 'text', text: 'hi back' }] } }],
    ])
    expect(hooks.roundsOf(nodes, ['u', 'a'])).toEqual([{ n: 1, seq: 5, question: 'hello there', answer: 'hi back' }])
    expect(hooks.clipText('x'.repeat(100)).endsWith('…')).toBe(true)
  })

  it('全局默认收起：路径块与安静块都不默认展开', () => {
    const source = sourceOf()
    expect(source).toContain('const [pathOpen, setPathOpen] = useState(false)')
    expect(source).toContain('const [quietOpen, setQuietOpen] = useState(false)')
  })
})
