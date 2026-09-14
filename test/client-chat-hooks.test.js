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
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn(),
  useRef: (value) => ({ current: value }),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  Fragment: Symbol('react.fragment'),
}))

import { apply, __setMessageEditorWire, zh } from '../lib/client.js'

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

//  regression (2026-09-14 review): the jump path. Extracted the same way
// so the resolution logic runs against the real source without touching lib/.
// The row components / label helpers are extracted too (display-only) so the
// "each row explains itself" copy can be asserted on the real render output.
const JUMP_EXPORTS = [
  'keyOfSeqIn', 'resolveAnchorKey', 'reportJumpUnavailable', 'jumpToAnchor', 'useChatNodes',
  'VersionRow', 'whyLabel', 'kindLabel',
]
const EXTRACTED_EXPORTS = [...HOOK_NAMES, ...JUMP_EXPORTS]

const fakeReact = {
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
  for (const name of EXTRACTED_EXPORTS) expect(source).toContain(`function ${name}(`)
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
  for (const name of EXTRACTED_EXPORTS) expect(typeof mod.exports[name]).toBe('function')
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
  const findComponent = (seat, key) => {
    const entry = captureSlotComponents().find(({ config }) => (
      config.name === seat && (key === undefined || config.key === key)
    ))
    expect(entry, `no registration for ${seat}${key ? ` key=${key}` : ''}`).toBeDefined()
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
//  regression (2026-09-14 review B1): jumpToAnchor read
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
// visible cost of the  fix): 2000 rows/20 markers ≈ 346 ms, 3000/30 ≈
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
    const RetraceView = viewComponent('retrace')
    const out = RetraceView({ sessionId: 's1', useChat: () => undefined, useProjection: () => undefined, t: tZh, actions: {}, store: {} })
    expect(allText(out)).toContain('每次撤回、编辑、重新生成前自动存一档，可回到任一档。')
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
  const row = (extra = {}) => hooks.VersionRow({
    record: { versionId: 'v9', kind: 'edit', createdAt: 0, messageCount: 12, markerText: '' },
    top: 0, t: tZh, what: whatFixture, onPreview() {}, onJump() {}, ...extra,
  })

  it('a checkpoint row shows the DISCARDED verbatim quote, the CONTINUED quote and the impact', () => {
    const text = allText(row({ what: { ...whatFixture, artifacts: { created: 1, modified: 2, deleted: 0 } } })).join(' • ')
    expect(text).toContain(zh['timeline.kind.edit'])
    expect(text).toContain('「原来的问法」')            // 被丢弃：逐字原文（可读性主体）
    expect(text).toContain('「改后的新问法」')          // 延续：新内容逐字
    expect(text).toContain('这次改动丢弃了 4 条消息')    // 2 listed + replacedMore 2
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
    expect(allText(discarded).join('')).toContain(zh['what.oldVoid'])
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
