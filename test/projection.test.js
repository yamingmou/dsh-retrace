import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import {
  versionsProjectionDefinition,
  versionsViewSchema,
} from '../lib/projection/versions.js'
import {
  MARKER_ID_PREFIX,
  VERSION_LIMIT,
  applyVersionIndex,
  createVersionIndexState,
} from '../lib/version-index.js'

// ---------------------------------------------------------------------------
// Synthetic events (mirror lib/host-core.js shapes)
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

function assistantMessage(seq) {
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
        content: [{ type: 'text', text: 'reply' }],
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

function editorMarker(seq, { start, end, op = 'recall' } = {}) {
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
      editor: { targetSeq: start, text: 'original input' },
    },
  }
}

function compactionCheckpoint(seq, { start, end } = {}) {
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
      source: { kind: 'plugin', plugin: 'compact', compactionId: 'c1' },
    },
  }
}

/** Drive the unit exactly like the registry does: init → apply(event)… */
function run(definition, events) {
  let state = definition.init()
  for (const event of events) state = definition.apply(state, event)
  return state
}

// ---------------------------------------------------------------------------
// Unit definition shape
// ---------------------------------------------------------------------------

describe('versionsProjectionDefinition', () => {
  it('declares the official unit contract fields', () => {
    expect(versionsProjectionDefinition.key).toBe('retrace/versions')
    expect(versionsProjectionDefinition.stateVersion).toBe(1)
    expect(typeof versionsProjectionDefinition.init).toBe('function')
    expect(typeof versionsProjectionDefinition.apply).toBe('function')
    expect(typeof versionsProjectionDefinition.view).toBe('function')
    expect(typeof versionsProjectionDefinition.schema?.parse).toBe('function')
  })

  it('exposes wire + stateSchema so the registry serves the value (framework contract regression)', () => {
    // The registry (`dsh-session-projection` register) reads `definition.wire`
    // — a unit without it is checkpoint-only and its key NEVER appears in
    // snapshot()/push frames (P0 bug found by the P1 real-harness smoke).
    expect(versionsProjectionDefinition.wire).toBeDefined()
    expect(typeof versionsProjectionDefinition.wire.view).toBe('function')
    expect(typeof versionsProjectionDefinition.wire.viewSchema?.parse).toBe('function')
    expect(typeof versionsProjectionDefinition.stateSchema?.parse).toBe('function')
    // The wire view must parse through its own schema (what the registry does).
    const state = run(versionsProjectionDefinition, [
      userMessage(0),
      toolCall(1, { name: 'fs.write', args: { path: 'src/a.ts' } }),
      editorMarker(2, { start: 0, end: 1, op: 'edit' }),
    ])
    const parsed = versionsProjectionDefinition.wire.viewSchema.parse(
      versionsProjectionDefinition.wire.view(state),
    )
    expect(parsed.versions).toHaveLength(1)
    expect(parsed.versions[0].versionId).toBe('v2')
    // The raw fold state must parse through the stateSchema (durable rows).
    const stateParsed = versionsProjectionDefinition.stateSchema.parse(state)
    expect(stateParsed.knownFiles).toContain('src/a.ts')
  })

  it('is idempotent across a re-fold (deterministic, replayable)', () => {
    const events = [
      userMessage(0),
      toolCall(1, { name: 'fs.write', args: { path: 'src/a.ts' } }),
      assistantMessage(2),
      editorMarker(3, { start: 0, end: 2, op: 'edit' }),
      userMessage(4),
      compactionCheckpoint(5, { start: 4, end: 4 }),
      userMessage(6),
      assistantMessage(7),
    ]
    const first = run(versionsProjectionDefinition, events)
    const second = run(versionsProjectionDefinition, events)
    expect(JSON.parse(JSON.stringify(second))).toEqual(JSON.parse(JSON.stringify(first)))
  })
})

// ---------------------------------------------------------------------------
// Schema / view contract (what the registry parses and serves)
// ---------------------------------------------------------------------------

describe('versionsViewSchema', () => {
  it('validates the view produced by the unit', () => {
    const events = [
      userMessage(0),
      toolCall(1, { name: 'fs.write', args: { path: 'src/a.ts' } }),
      assistantMessage(2),
      editorMarker(3, { start: 0, end: 2, op: 'recall' }),
      userMessage(4),
      assistantMessage(5),
    ]
    const state = run(versionsProjectionDefinition, events)
    const view = versionsProjectionDefinition.view(state)
    const parsed = versionsViewSchema.parse(view) // throws on mismatch
    expect(parsed.versions).toHaveLength(1)
    expect(parsed.versions[0].kind).toBe('recall')
    expect(parsed.versions[0].touchedFiles).toEqual([{ path: 'src/a.ts', mode: 'created' }])
  })

  it('rejects an unknown version kind (schema drift guard)', () => {
    const bad = {
      versions: [
        {
          versionId: 'v1',
          boundarySeq: 1,
          createdAt: 0,
          kind: 'time-travel',
          markerText: '',
          messageCount: 0,
          fileCounts: { created: 0, modified: 0, deleted: 0 },
          touchedFiles: [],
          git: null,
        },
      ],
    }
    expect(versionsViewSchema.safeParse(bad).success).toBe(false)
  })

  it('rejects more than VERSION_LIMIT versions (fold never exceeds it)', () => {
    const many = {
      versions: Array.from({ length: VERSION_LIMIT + 1 }, (_, i) => ({
        versionId: `v${i}`,
        boundarySeq: i,
        createdAt: 0,
        kind: 'edit',
        markerText: '',
        messageCount: 0,
        fileCounts: { created: 0, modified: 0, deleted: 0 },
        touchedFiles: [],
        git: null,
      })),
    }
    expect(versionsViewSchema.safeParse(many).success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Registry contract: same-reference gating (Object.is drives the change feed)
// ---------------------------------------------------------------------------

describe('apply same-reference contract', () => {
  it('returns the same state for uninteresting events', () => {
    const state = createVersionIndexState()
    const next = applyVersionIndex(state, { seq: 0, type: 'turn/start', time: 1, data: {} })
    expect(next).toBe(state)
  })

  it('returns a new state for surface/file/boundary events', () => {
    const state = createVersionIndexState()
    expect(applyVersionIndex(state, userMessage(0))).not.toBe(state)
    expect(applyVersionIndex(state, toolCall(0, { name: 'fs.write', args: { path: 'a.ts' } }))).not.toBe(state)
    expect(applyVersionIndex(state, editorMarker(0, { start: -1, end: -1 }))).not.toBe(state)
  })
})

// ---------------------------------------------------------------------------
// Cold restore path (framework calls apply over a stored suffix)
// ---------------------------------------------------------------------------

describe('cold-restore replay', () => {
  it('refolds a full log from init identically to an incremental fold', () => {
    const events = [
      userMessage(0),
      assistantMessage(1),
      editorMarker(2, { start: 0, end: 1, op: 'regenerate' }),
      userMessage(3),
      assistantMessage(4),
    ]
    // incremental: every event applied one by one, as if driven live
    let incremental = versionsProjectionDefinition.init()
    const seen = []
    for (const event of events) {
      incremental = versionsProjectionDefinition.apply(incremental, event)
      seen.push(incremental)
    }
    // cold restore: fold from init over the whole log at once
    const cold = versionsProjectionDefinition.init()
    let acc = cold
    for (const event of events) acc = versionsProjectionDefinition.apply(acc, event)
    expect(versionsProjectionDefinition.view(acc)).toEqual(versionsProjectionDefinition.view(seen.at(-1)))
    expect(versionsProjectionDefinition.view(acc)).toEqual(
      versionsProjectionDefinition.view(run(versionsProjectionDefinition, events)),
    )
  })

  it('the schema accepts a re-validated view of a JSON-revived state (checkpoint round-trip)', () => {
    const events = [userMessage(0), assistantMessage(1), editorMarker(2, { start: 0, end: 1 })]
    const state = run(versionsProjectionDefinition, events)
    const revived = JSON.parse(JSON.stringify(state)) // what a persisted checkpoint row holds
    const view = versionsProjectionDefinition.view(revived)
    expect(versionsViewSchema.safeParse(view).success).toBe(true)
    expect(z.json().safeParse(JSON.parse(JSON.stringify(revived))).success).toBe(true)
  })
})
