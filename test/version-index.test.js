import { describe, it, expect } from 'vitest'
import {
  MARKER_ID_PREFIX,
  VERSION_LIMIT,
  isSurfaceEvent,
  isReplacementSurfaceEvent,
  isCompactCheckpointSource,
  kindFromMarkerId,
  classifyBoundaryKind,
  pathsFromToolCallArguments,
  touchedFilesFromEvent,
  createVersionIndexState,
  applyVersionIndex,
  viewVersionIndex,
} from '../lib/version-index.js'

// ---------------------------------------------------------------------------
// Synthetic event builders (mirror what lib/host-core.js appends)
// ---------------------------------------------------------------------------

function userMessage(seq, { id = `user-${seq}`, text = 'hello', source = { kind: 'user' } } = {}) {
  return {
    seq,
    type: 'user/message',
    time: 1_700_000_000_000 + seq,
    surfaceOp: 'append',
    data: { id, role: 'user', content: [{ type: 'text', text }], source },
  }
}

function assistantMessage(seq, { id = `asst-${seq}`, text = 'reply', content = null } = {}) {
  return {
    seq,
    type: 'assistant/message',
    time: 1_700_000_000_000 + seq,
    surfaceOp: 'append',
    data: {
      turn: 0,
      step: 0,
      message: {
        id,
        role: 'assistant',
        content: content ?? [{ type: 'text', text }],
        source: { kind: 'model', provider: 'test', model: 'test-model' },
      },
    },
  }
}

function toolCall(seq, { name, args }) {
  return {
    seq,
    type: 'tool/call',
    time: 1_700_000_000_000 + seq,
    surfaceOp: 'append',
    data: { id: `tool-${seq}`, name, arguments: JSON.stringify(args), turn: 0, step: 0 },
  }
}

function toolResult(seq, { error, meta } = {}) {
  const data = {
    id: `tool-${seq}`,
    turn: 0,
    step: 0,
    message: { role: 'tool', content: [{ type: 'text', text: 'ok' }] },
  }
  if (error) data.error = error
  if (meta) data.meta = meta
  return {
    seq,
    type: 'tool/result',
    time: 1_700_000_000_000 + seq,
    surfaceOp: 'append',
    data,
  }
}

/** The invisible marker host-core appends to shadow a span (recall/edit/regenerate/restore). */
function editorMarker(seq, { start, end, op = 'recall', targetSeq = start, text = 'original input' } = {}) {
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
      editor: { targetSeq, text },
    },
  }
}

/** Compaction checkpoint user/message (source = official compactCheckpointSource shape). */
function compactionCheckpoint(seq, { start, end, compactionId = 'c1' } = {}) {
  return {
    seq,
    type: 'user/message',
    time: 1_700_000_000_000 + seq,
    surfaceOp: { op: 'replace', start, end },
    sourceEventSeqs: Array.from({ length: end - start + 1 }, (_, i) => start + i),
    data: {
      id: `compact-${seq}`,
      role: 'user',
      content: [{ type: 'text', text: '<compaction summary>' }],
      source: { kind: 'plugin', plugin: 'compact', compactionId },
    },
  }
}

function fold(events, state = createVersionIndexState()) {
  return events.reduce((acc, event) => applyVersionIndex(acc, event), state)
}

// ---------------------------------------------------------------------------
// Predicates (official-equivalent semantics)
// ---------------------------------------------------------------------------

describe('surface predicates', () => {
  it('detects surface eligibility and replacement', () => {
    expect(isSurfaceEvent(userMessage(0))).toBe(true)
    expect(isSurfaceEvent(editorMarker(5, { start: 0, end: 4 }))).toBe(true)
    expect(isSurfaceEvent({ seq: 0, type: 'turn/start', data: {} })).toBe(false)
    expect(isSurfaceEvent({ seq: 0, type: 'user/message', data: {} })).toBe(false)
    expect(isReplacementSurfaceEvent(editorMarker(5, { start: 0, end: 4 }))).toBe(true)
    expect(isReplacementSurfaceEvent(userMessage(0))).toBe(false)
  })

  it('recognizes compaction checkpoint sources', () => {
    expect(isCompactCheckpointSource({ kind: 'plugin', plugin: 'compact', compactionId: 'c1' })).toBe(true)
    expect(isCompactCheckpointSource({ kind: 'user' })).toBe(false)
    expect(isCompactCheckpointSource(null)).toBe(false)
  })
})

describe('kindFromMarkerId / classifyBoundaryKind', () => {
  it('maps retrace marker id prefixes to version kinds', () => {
    expect(kindFromMarkerId(`${MARKER_ID_PREFIX}-recall-abc`)).toBe('recall')
    expect(kindFromMarkerId(`${MARKER_ID_PREFIX}-edit-abc`)).toBe('edit')
    expect(kindFromMarkerId(`${MARKER_ID_PREFIX}-regenerate-abc`)).toBe('regenerate')
    expect(kindFromMarkerId(`${MARKER_ID_PREFIX}-restore-abc`)).toBe('restore')
    expect(kindFromMarkerId('something-else')).toBe('edit')
    expect(kindFromMarkerId(undefined)).toBe('edit')
  })

  it('classifies legacy (renamed-away) marker id prefixes — rename must not break recognition', () => {
    expect(kindFromMarkerId('message-editor-recall-abc')).toBe('recall')
    expect(kindFromMarkerId('message-editor-edit-abc')).toBe('edit')
    expect(kindFromMarkerId('message-editor-regenerate-abc')).toBe('regenerate')
  })

  it('classifies boundary events: marker / compaction / generic replace', () => {
    expect(classifyBoundaryKind(editorMarker(5, { start: 0, end: 4, op: 'recall' }))).toBe('recall')
    expect(classifyBoundaryKind(editorMarker(5, { start: 0, end: 4, op: 'edit' }))).toBe('edit')
    expect(classifyBoundaryKind(compactionCheckpoint(5, { start: 0, end: 4 }))).toBe('compaction')
    const generic = {
      seq: 5,
      type: 'user/message',
      surfaceOp: { op: 'replace', start: 0, end: 4 },
      data: { id: 'x', role: 'user', content: [], source: { kind: 'user' } },
    }
    expect(classifyBoundaryKind(generic)).toBe('replace')
    expect(classifyBoundaryKind(userMessage(0))).toBe('replace') // not a boundary; kind unused
  })
})

// ---------------------------------------------------------------------------
// Touched-file extraction
// ---------------------------------------------------------------------------

describe('touchedFilesFromEvent', () => {
  it('extracts paths from whitelisted write tool calls', () => {
    const event = toolCall(1, { name: 'fs.write', args: { path: 'src/a.ts', content: 'x' } })
    expect(touchedFilesFromEvent(event)).toEqual([{ path: 'src/a.ts', intent: 'write' }])
  })

  it('marks delete tools with delete intent', () => {
    const event = toolCall(1, { name: 'fs.remove', args: { path: 'src/old.ts' } })
    expect(touchedFilesFromEvent(event)).toEqual([{ path: 'src/old.ts', intent: 'delete' }])
  })

  it('ignores unknown tools and non-path arguments', () => {
    expect(touchedFilesFromEvent(toolCall(1, { name: 'bash', args: { command: 'ls' } }))).toEqual([])
    expect(touchedFilesFromEvent(toolCall(1, { name: 'fs.write', args: { content: 'no path here' } }))).toEqual([])
  })

  it('trusts tool/result meta.path and skips failed results', () => {
    expect(touchedFilesFromEvent(toolResult(2, { meta: { path: 'src/a.ts' } }))).toEqual([
      { path: 'src/a.ts', intent: 'write' },
    ])
    expect(touchedFilesFromEvent(toolResult(2, { error: 'boom', meta: { path: 'src/a.ts' } }))).toEqual([])
  })

  it('parses paths from nested arguments', () => {
    const event = toolCall(1, { name: 'edit', args: { file_path: 'README.md', edits: [{ oldString: 'a', newString: 'b' }] } })
    expect(touchedFilesFromEvent(event)).toEqual([{ path: 'README.md', intent: 'write' }])
  })
})

describe('pathsFromToolCallArguments', () => {
  it('collects path-like strings from known keys only', () => {
    expect(pathsFromToolCallArguments('fs.write', JSON.stringify({ path: 'a/b.ts', mode: 0o644 }))).toEqual(['a/b.ts'])
    expect(pathsFromToolCallArguments('fs.write', 'not json')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Fold
// ---------------------------------------------------------------------------

describe('applyVersionIndex', () => {
  it('folds the surface like foldSurface (append then replace)', () => {
    const state = fold([
      userMessage(0),
      assistantMessage(1),
      editorMarker(2, { start: 0, end: 1 }),
    ])
    expect(state.surface).toEqual([2])
    expect(state.versions).toHaveLength(1)
    expect(state.versions[0].versionId).toBe('v2')
    expect(state.versions[0].boundarySeq).toBe(2)
    expect(state.versions[0].kind).toBe('recall')
    expect(state.versions[0].messageCount).toBe(1)
    expect(state.versions[0].createdAt).toBe(1_700_000_000_002)
  })

  it('accumulates the touched-file window and freezes it at the boundary', () => {
    const state = fold([
      userMessage(0),
      toolCall(1, { name: 'fs.write', args: { path: 'src/a.ts' } }),
      toolResult(2, { meta: { path: 'src/a.ts' } }),
      assistantMessage(3),
      editorMarker(4, { start: 0, end: 3 }),
    ])
    expect(state.versions[0].touchedFiles).toEqual([{ path: 'src/a.ts', mode: 'created' }])
    // window cleared after the boundary
    expect(state.windowFiles).toEqual({})
  })

  it('classifies a compaction checkpoint boundary', () => {
    const state = fold([
      userMessage(0),
      assistantMessage(1),
      compactionCheckpoint(2, { start: 0, end: 1 }),
    ])
    expect(state.versions[0].kind).toBe('compaction')
    expect(state.versions[0].markerText).toBe('')
  })

  it('carries the marker text summary for edit/regenerate markers', () => {
    const state = fold([
      userMessage(0),
      assistantMessage(1),
      editorMarker(2, { start: 0, end: 1, op: 'edit', text: 'edited prompt' }),
    ])
    expect(state.versions[0].kind).toBe('edit')
    expect(state.versions[0].markerText).toBe('edited prompt')
  })

  it('tracks created → modified → deleted across windows', () => {
    const state = fold([
      userMessage(0),
      toolCall(1, { name: 'fs.write', args: { path: 'src/a.ts' } }),
      assistantMessage(2),
      editorMarker(3, { start: 0, end: 2, op: 'recall' }), // v3: a.ts created
      userMessage(4),
      toolCall(5, { name: 'fs.write', args: { path: 'src/a.ts' } }),
      assistantMessage(6),
      editorMarker(7, { start: 4, end: 6, op: 'recall' }), // v7: a.ts modified
      userMessage(8),
      toolCall(9, { name: 'fs.remove', args: { path: 'src/a.ts' } }),
      assistantMessage(10),
      editorMarker(11, { start: 8, end: 10, op: 'recall' }), // v11: a.ts deleted
    ])
    expect(state.versions.map((v) => v.touchedFiles)).toEqual([
      [{ path: 'src/a.ts', mode: 'created' }],
      [{ path: 'src/a.ts', mode: 'modified' }],
      [{ path: 'src/a.ts', mode: 'deleted' }],
    ])
  })

  it('returns the same state reference for uninteresting events', () => {
    const state = createVersionIndexState()
    const boring = [
      { seq: 0, type: 'turn/start', time: 1, data: {} },
      { seq: 1, type: 'request/header', time: 2, data: {} },
      { seq: 2, type: 'assistant/chunk', time: 3, data: {} },
    ]
    let acc = state
    for (const event of boring) {
      const next = applyVersionIndex(acc, event)
      expect(next).toBe(acc)
      acc = next
    }
  })

  it('returns a new reference when the surface changes', () => {
    const state = createVersionIndexState()
    expect(applyVersionIndex(state, userMessage(0))).not.toBe(state)
  })

  it('caps the version list at VERSION_LIMIT (oldest dropped, log replay recovers)', () => {
    const events = []
    for (let i = 0; i < VERSION_LIMIT + 5; i++) {
      events.push(userMessage(i * 3))
      events.push(assistantMessage(i * 3 + 1))
      events.push(editorMarker(i * 3 + 2, { start: i * 3, end: i * 3 + 1 }))
    }
    const state = fold(events)
    expect(state.versions).toHaveLength(VERSION_LIMIT)
    expect(state.versions[0].versionId).toBe(`v${(VERSION_LIMIT + 5 - VERSION_LIMIT) * 3 + 2}`)
  })

  it('keeps the state plain-JSON serializable (projection cache round-trip)', () => {
    const state = fold([
      userMessage(0),
      toolCall(1, { name: 'fs.write', args: { path: 'src/a.ts' } }),
      assistantMessage(2),
      editorMarker(3, { start: 0, end: 2 }),
      userMessage(4),
      assistantMessage(5),
    ])
    const revived = structuredClone(JSON.parse(JSON.stringify(state)))
    expect(revived).toEqual(state)
  })
})

// ---------------------------------------------------------------------------
// Wire view
// ---------------------------------------------------------------------------

describe('viewVersionIndex', () => {
  it('produces the compact timeline summary with file counts', () => {
    const state = fold([
      userMessage(0),
      toolCall(1, { name: 'fs.write', args: { path: 'src/a.ts' } }),
      toolCall(2, { name: 'fs.remove', args: { path: 'src/old.ts' } }),
      assistantMessage(3),
      editorMarker(4, { start: 0, end: 3, op: 'edit', text: 'edited' }),
    ])
    const view = viewVersionIndex(state)
    expect(view.versions).toHaveLength(1)
    const [v] = view.versions
    expect(v).toMatchObject({
      versionId: 'v4',
      kind: 'edit',
      markerText: 'edited',
      messageCount: 1,
      fileCounts: { created: 1, modified: 0, deleted: 1 },
      git: null,
    })
    expect(v.touchedFiles).toEqual([
      { path: 'src/a.ts', mode: 'created' },
      { path: 'src/old.ts', mode: 'deleted' },
    ])
  })

  it('is empty for a fresh state', () => {
    expect(viewVersionIndex(createVersionIndexState())).toEqual({ versions: [] })
  })
})
