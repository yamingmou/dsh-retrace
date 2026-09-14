/**
 * dsh-retrace — `what` digest contract tests (frozen 2026-09-14).
 *
 * The projection wire used to be the candidate carrier for `what`; the measured
 * cost (+70.8% versions / +93.7% forkmap per frame, and 188 KB/180 KB in the
 * durable checkpoint) moved it to the plugin's own artifact, built at OPERATION
 * time from the log (lib/boundary-what.js + lib/llm-summary.js).
 *
 * Rules pinned here:
 *   - `excerpt` is VERBATIM log text, capped at 60 chars + `…`;
 *   - `replaced` ≤ 3 entries, the rest summarized as `replacedMore`;
 *   - only the OLD content is summarized; `new` carries a verbatim excerpt only;
 *   - the projection wire/state stay lean: no `what` (and no digest ring);
 *   - the host surfaceOp shape is read in both spellings (v0 `start/end`,
 *     0.1.5 `startSeq/endSeq`) so the live splice runs on the real host.
 */
import { describe, it, expect } from 'vitest'
import {
  EXCERPT_MAX,
  REPLACED_MAX,
  excerpt,
  makeWhat,
  roleOf,
  eventText,
} from '../lib/boundary-what.js'
import {
  MARKER_ID_PREFIX,
  applyVersionIndex,
  createVersionIndexState,
  viewVersionIndex,
} from '../lib/version-index.js'
import { applyForkmap, createForkmapState, viewForkmap } from '../lib/forkmap.js'
import { versionsViewSchema, versionIndexStateSchema } from '../lib/projection/versions.js'
import { forkmapViewSchema, forkmapStateSchema } from '../lib/projection/forkmap.js'

// ---------------------------------------------------------------------------
// Event builders
// ---------------------------------------------------------------------------

function userMessage(seq, text) {
  return {
    seq,
    type: 'user/message',
    time: 1_700_000_000_000 + seq,
    surfaceOp: 'append',
    data: { id: `user-${seq}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
  }
}

function assistantMessage(seq, text) {
  return {
    seq,
    type: 'assistant/message',
    time: 1_700_000_000_000 + seq,
    surfaceOp: 'append',
    data: {
      turn: 0,
      step: 0,
      message: {
        id: `asst-${seq}`,
        role: 'assistant',
        content: [{ type: 'text', text }],
        source: { kind: 'model', provider: 'test', model: 'test-model' },
      },
    },
  }
}

function toolResult(seq, text) {
  return {
    seq,
    type: 'tool/result',
    time: 1_700_000_000_000 + seq,
    surfaceOp: 'append',
    data: { id: `tool-${seq}`, turn: 0, step: 0, message: { role: 'tool', content: [{ type: 'text', text }] } },
  }
}

/** Our marker (mirrors lib/host-core.js): empty assistant message + editor text. */
function marker(seq, { start, end, op = 'recall', text = '' } = {}) {
  return {
    seq,
    type: 'assistant/message',
    time: 1_700_000_000_000 + seq,
    surfaceOp: { op: 'replace', start, end },
    sourceEventSeqs: Array.from({ length: end - start + 1 }, (_, i) => start + i),
    data: {
      turn: null,
      step: null,
      message: {
        id: `${MARKER_ID_PREFIX}-${op}-abc123`,
        role: 'assistant',
        content: [],
        source: { kind: 'model', provider: 'test', model: 'test-model' },
      },
      editor: { targetSeq: start, text },
    },
  }
}

const foldVersions = (events) => events.reduce(applyVersionIndex, createVersionIndexState())
const foldForkmap = (events) => events.reduce(applyForkmap, createForkmapState())
/** The span a boundary replaced = the surface events before its own. */
const spanOf = (events, end) => events.slice(0, end)

// ---------------------------------------------------------------------------
// excerpt()
// ---------------------------------------------------------------------------

describe('excerpt() — verbatim, capped, single line', () => {
  it('returns text verbatim when at or under the cap', () => {
    const text = 'a'.repeat(EXCERPT_MAX)
    expect(excerpt(text)).toBe(text)
    expect(excerpt('  你好   世界  ')).toBe('你好 世界')
  })

  it('caps at EXCERPT_MAX and marks the truncation with an ellipsis', () => {
    const long = 'b'.repeat(EXCERPT_MAX + 50)
    const cut = excerpt(long)
    expect(cut.length).toBe(EXCERPT_MAX + 1)
    expect(cut.endsWith('…')).toBe(true)
    expect(cut.slice(0, EXCERPT_MAX)).toBe('b'.repeat(EXCERPT_MAX))
    expect(long.startsWith(cut.slice(0, EXCERPT_MAX))).toBe(true)
  })

  it('maps absent / non-string text to the empty string', () => {
    expect(excerpt(undefined)).toBe('')
    expect(excerpt(null)).toBe('')
    expect(excerpt(42)).toBe('')
  })
})

// ---------------------------------------------------------------------------
// makeWhat — the artifact payload
// ---------------------------------------------------------------------------

describe('makeWhat — verbatim excerpts of the discarded content', () => {
  const span = [
    userMessage(0, '把 build 脚本改成只跑 vitest'),
    assistantMessage(1, '好的，我改了 scripts/build.mjs'),
    userMessage(2, '再加一个 --watch'),
    assistantMessage(3, '已加上 watch 分支'),
  ]

  it('reports the replaced messages verbatim, in surface order', () => {
    const what = makeWhat({ op: 'recall', at: 123, spanEvents: span, newText: '' })
    expect(what.op).toBe('recall')
    expect(what.at).toBe(123)
    expect(what.replaced).toEqual([
      { seq: 0, role: 'user', excerpt: '把 build 脚本改成只跑 vitest' },
      { seq: 1, role: 'assistant', excerpt: '好的，我改了 scripts/build.mjs' },
      { seq: 2, role: 'user', excerpt: '再加一个 --watch' },
    ])
    // 4 shadowed seqs, 3 listed ⇒ exactly one more.
    expect(what.replacedMore).toBe(1)
    // Verbatim: the excerpt is a slice of the real log text.
    expect(span[1].data.message.content[0].text).toBe(what.replaced[1].excerpt)
    // The new content carries an excerpt only — never a summary.
    expect(what.new).toEqual({ excerpt: '' })
    expect(what.new.summary).toBeUndefined()
  })

  it('omits replacedMore when nothing was cut off', () => {
    const what = makeWhat({ op: 'recall', spanEvents: span.slice(0, 3) })
    expect(what.replaced).toHaveLength(REPLACED_MAX)
    expect(Object.hasOwn(what, 'replacedMore')).toBe(false)
  })

  it('degrades to unknown/empty (never throws) for a seq without an event', () => {
    const what = makeWhat({ op: 'recall', spanEvents: span.slice(0, 1), replacedSeqs: [0, 7, 8] })
    expect(what.replaced).toEqual([
      { seq: 0, role: 'user', excerpt: '把 build 脚本改成只跑 vitest' },
      { seq: 7, role: 'unknown', excerpt: '' },
      { seq: 8, role: 'unknown', excerpt: '' },
    ])
  })

  it('carries the action’s own new text verbatim (capped)', () => {
    const what = makeWhat({ op: 'edit', spanEvents: span, newText: '改写后的新问题' })
    expect(what.new.excerpt).toBe('改写后的新问题')
    const long = makeWhat({ op: 'edit', spanEvents: span, newText: 'x'.repeat(200) })
    expect(long.new.excerpt.length).toBe(EXCERPT_MAX + 1)
  })

  it('reports artifacts as counts only', () => {
    const what = makeWhat({ op: 'recall', spanEvents: span, artifacts: { created: 1, modified: 2, deleted: 0 } })
    expect(what.artifacts).toEqual({ created: 1, modified: 2, deleted: 0 })
    expect(JSON.stringify(what)).not.toContain('src/')
    expect(Object.hasOwn(makeWhat({ op: 'recall', spanEvents: span, artifacts: { created: 0, modified: 0, deleted: 0 } }), 'artifacts')).toBe(false)
  })

  it('role/eventText cover user, assistant and tool rows', () => {
    expect(roleOf(userMessage(0, 'x'))).toBe('user')
    expect(roleOf(assistantMessage(1, 'x'))).toBe('assistant')
    expect(roleOf(toolResult(2, 'x'))).toBe('tool')
    expect(roleOf({ type: 'turn/start' })).toBe('unknown')
    expect(eventText(toolResult(3, 'tool out'))).toBe('tool out')
  })
})

// ---------------------------------------------------------------------------
// The projection wire/state stay lean (regression: the measured +70% tax)
// ---------------------------------------------------------------------------

describe('projection wire and fold state carry no what / digest ring', () => {
  const events = [userMessage(0, 'hello'), assistantMessage(1, 'hi'), marker(2, { start: 0, end: 1, op: 'recall' })]

  it('viewVersionIndex emits no what and no digests', () => {
    const view = viewVersionIndex(foldVersions(events))
    expect(Object.hasOwn(view.versions[0], 'what')).toBe(false)
    expect(Object.keys(view.versions[0]).sort()).toEqual(
      ['boundarySeq', 'createdAt', 'fileCounts', 'git', 'kind', 'markerText', 'messageCount', 'touchedFiles', 'versionId'].sort(),
    )
  })

  it('forkmap view carries only seq/kind/replacedSeqs', () => {
    const view = viewForkmap(foldForkmap(events))
    expect(view.boundaries[0]).toEqual({ seq: 2, kind: 'recall', replacedSeqs: [0, 1] })
    expect(Object.hasOwn(view.boundaries[0], 'what')).toBe(false)
  })

  it('the fold state schemas carry only the fields they had before the digest work', () => {
    const vState = foldVersions(events)
    const fState = foldForkmap(events)
    expect(Object.keys(vState).sort()).toEqual(['knownFiles', 'surface', 'versions', 'windowFiles'])
    expect(Object.keys(fState).sort()).toEqual(['boundaries', 'nodes'])
    expect(versionIndexStateSchema.safeParse(vState).success).toBe(true)
    expect(forkmapStateSchema.safeParse(fState).success).toBe(true)
    expect(versionsViewSchema.safeParse(viewVersionIndex(vState)).success).toBe(true)
    expect(forkmapViewSchema.safeParse(viewForkmap(fState)).success).toBe(true)
  })

  it('a legacy row without what still validates (old checkpoints keep loading)', () => {
    expect(forkmapViewSchema.safeParse({ nodes: [], boundaries: [{ seq: 3, kind: 'recall', replacedSeqs: [] }] }).success).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Host surfaceOp shape (v0 {start,end} vs 0.1.5 {startSeq,endSeq})
// ---------------------------------------------------------------------------

describe('dual-shape surfaceOp — the live splice must run on the real host', () => {
  const v3Marker = (seq, { start, end, op = 'recall' } = {}) => {
    const event = marker(seq, { start, end, op })
    return { ...event, surfaceOp: { op: 'replace', startSeq: start, endSeq: end } }
  }

  it('v3 (startSeq/endSeq) shadows the span: surface shrinks', () => {
    const events = [
      userMessage(0, '第一段被丢掉的内容'),
      assistantMessage(1, '第一段回答'),
      userMessage(2, '第二段'),
      assistantMessage(3, '第二段回答'),
      v3Marker(4, { start: 0, end: 3, op: 'recall' }),
    ]
    const state = foldVersions(events)
    const [version] = viewVersionIndex(state).versions
    // Surface = [4] only; without the dual-shape read it stayed [0,1,2,3,4].
    expect(version.messageCount).toBe(1)
    const [boundary] = viewForkmap(foldForkmap(events)).boundaries
    expect(boundary.replacedSeqs).toEqual([0, 1, 2, 3])
  })

  it('v0 (start/end) and v3 (startSeq/endSeq) fold to the same view', () => {
    const base = [userMessage(0, 'a'), assistantMessage(1, 'b')]
    const v0 = viewVersionIndex(foldVersions([...base, marker(2, { start: 0, end: 1, op: 'edit' })]))
    const v3 = viewVersionIndex(foldVersions([...base, v3Marker(2, { start: 0, end: 1, op: 'edit' })]))
    expect(v3).toEqual(v0)
    expect(v3.versions[0].messageCount).toBe(1)
  })

  it('the span fed to makeWhat is the one the fold spliced out', () => {
    const events = [userMessage(0, '丢掉我'), assistantMessage(1, '也丢掉我'), v3Marker(2, { start: 0, end: 1, op: 'recall' })]
    const boundary = viewForkmap(foldForkmap(events)).boundaries[0]
    const span = spanOf(events, 2).filter((event) => boundary.replacedSeqs.includes(event.seq))
    const what = makeWhat({ op: boundary.kind, spanEvents: span })
    expect(what.replaced.map((entry) => entry.excerpt)).toEqual(['丢掉我', '也丢掉我'])
  })
})
