/**
 * Unit tests for the host-contract gate's member matchers.
 *
 * Why this file exists (review-independent-2 §2.2(a)): the gate's `absent`
 * assertions used to only recognise `^\s+m;` / `get m()`. The host declares its
 * own members with initializers (`log = [];`, `headerFoldSeq = 0;`) and via
 * constructor assignment (`this.header = …`), so `events = [];` — the most
 * likely way `Session.events` would come back — would NOT have turned the gate
 * red. The matchers therefore live in the script as exported, testable
 * functions.
 *
 * HONEST SCOPE — this file does NOT enumerate *every* resurrection form. It
 * enumerates:
 *   - `declaresMember`: the line-oriented forms (fields/getters/methods/this./object keys);
 *   - `declaresMemberBoltOn`: the reflection/bolt-on forms (defineProperty,
 *     Object.assign, `.prototype.m`, __defineGetter__, __decorate, computed keys);
 *   - `scopedSlice` / `entrySlice`: the structural slicing the gate relies on.
 * Known escapes that are deliberately NOT chased are listed in
 * the host-contract drift review (review #3), see
 * §2.2 (E8 `@dec m = …` same line / E9 `declare m:` / E10 comment between name
 * and `=` / E11 newline before `=`) — do not assume completeness.
 *
 * The matchers deliberately over-approximate (a false red is the safe direction
 * for a reverse assertion); the "no false positive" cases below pin the
 * legitimate forms that must stay green — in particular a local
 * `const events = session.snapshotEvents()` is NOT a member.
 */
import { describe, it, expect } from 'vitest'
import { declaresMember, declaresMemberBoltOn, entrySlice, escapeRegExp, scopedSlice } from '../scripts/check-host-contract.mjs'

/** Every plausible "the member is back" form, per member name. */
const RESURRECTIONS = {
  events: [
    'events;',                          // class field, no initializer (host's own style)
    'events = [];',                     // class field with initializer (host's own style)
    'events = void 0',
    'events = new Map()',
    'events ??= []',
    'events?: unknown',                 // optional TS field
    'static events = [];',
    'get events() {',
    'set events(value) {',
    'async events() {',
    '*events() {',
    'this.events = []',
    'this.events.push(x)',
    'this.events ??= []',
    '{ events: [] }',
    '{events}',
    'const x = { nodes: [], events, replacements }',
  ],
  values: [
    'values() {',
    'get values() {',
    'values = () => {}',
    'values: () => []',
    '{ values: [] }',
    'this.values = new Map()',
  ],
  keys: [
    'keys() {',
    'get keys() {',
    'keys = () => []',
    '{ keys: [] }',
    'this.keys = []',
  ],
  sessionId: [
    'sessionId;',
    'sessionId = id;',
    'get sessionId() {',
    'this.sessionId = x',
    'this.sessionId = brand(id)',
    '{ sessionId: id }',
  ],
  chat: [
    'chat;',
    'chat = {};',
    'chat = new Map()',
    'get chat() {',
    'this.chat = new Map()',
    'chat: {}',
  ],
  nodes: [
    'nodes;',
    'nodes = new Map();',
    'get nodes() {',
    'this.nodes = map',
    'nodes: new Map()',
  ],
  getTitle: [
    'getTitle() {',
    'getTitle;',
    'getTitle = () => {}',
    'get getTitle() {',
    'this.getTitle = x',
    '{ getTitle: () => "" }',
  ],
}

/** Legitimate surrounding code that must NOT count as declaring the member. */
const LEGITIMATE = {
  events: [
    'eventsSnapshot;',
    'eventsSnapshot = [];',
    'this.eventsSnapshot = void 0',
    'snapshotEvents(fromSeq = SessionLogOffset(0), toSeqExclusive = this.seq) {',
    'eventAt(seq) {',
    'const events = session.snapshotEvents()',
    'for (const events of this.log) {',
    'const derivedEvents = []',
    'eventsOf(x)',
    'const { nodes, replacements } = foldSurface(events)',
  ],
  sessionId: [
    'const sessionId = brandString(`session-${++this.counter}`);',
    'let sessionId;',
    'sessionIdOf(x)',
    'this.sessionIdSnapshot = 1',
  ],
  values: [
    'const values = [...this.store.values()];',
    'this.store.values()',
    'valuesOf(x)',
    'valuesList()',
  ],
  keys: [
    'const keys = [...map.keys()];',
    'map.keys()',
    'keysOf(x)',
  ],
  chat: ['const chat = 1', 'chatOf(x)', 'chatLog = []'],
  nodes: ['const nodes = []', 'nodesOf(x)', 'nodesList = []'],
  getTitle: ['getTitles() {', 'titleOf(x)', 'forgetTitle = 1'],
}

const indent = (line) => `\t${line}`

describe('declaresMember — resurrection forms are caught (review §2.2(a))', () => {
  for (const [member, forms] of Object.entries(RESURRECTIONS)) {
    it(`${member}: all ${forms.length} resurrection forms are detected`, () => {
      const missed = forms.filter((form) => !declaresMember(indent(form), member))
      expect(missed).toEqual([])
    })
  }
})

describe('declaresMember — legitimate code does not false-positive', () => {
  for (const [member, forms] of Object.entries(LEGITIMATE)) {
    it(`${member}: ${forms.length} legitimate forms stay green`, () => {
      const falsePositives = forms.filter((form) => declaresMember(indent(form), member))
      expect(falsePositives).toEqual([])
    })
  }
})

describe('declaresMember — the two hosts’ own declaration styles', () => {
  it('catches the exact styles the host uses for real members', () => {
    // dsh-session: `log = [];`, `eventsSnapshot;`, `headerFoldSeq = 0;`
    expect(declaresMember('var C = class {\n\tlog = [];\n};', 'log')).toBe(true)
    expect(declaresMember('var C = class {\n\teventsSnapshot;\n};', 'eventsSnapshot')).toBe(true)
    expect(declaresMember('var C = class {\n\theaderFoldSeq = 0;\n};', 'headerFoldSeq')).toBe(true)
    // dsh-agent-loop: `inbox;`
    expect(declaresMember('var A = class {\n\tinbox;\n};', 'inbox')).toBe(true)
    // client Session controller: `hasMore = false;`
    expect(declaresMember('export class S {\n\thasMore = false;\n}', 'hasMore')).toBe(true)
  })
})

describe('scopedSlice — a member check cannot leak across classes (review: Session vs SessionStore)', () => {
  const SESSION_CLASS = { start: 'var Session = class Session {', end: '\n};' }

  const SOURCE = [
    'var Session = class Session {',
    '\tlog = [];',
    '\tderiveEventMessage(event) {',
    '\t\treturn deriveEventMessage(event);',
    '\t}',
    '};',
    'var SessionStore = class extends Service {',
    '\tprepare(id) {',
    '\t\tlet sessionId;',
    '\t\tsessionId = brandString(id);',
    '\t}',
    '};',
  ].join('\n')

  it('excludes a later class: SessionStore’s `sessionId = …` is not Session.sessionId', () => {
    const slice = scopedSlice(SOURCE, SESSION_CLASS)
    expect(slice).not.toBeNull()
    expect(slice).toContain('deriveEventMessage')
    expect(slice).not.toContain('SessionStore')
    expect(declaresMember(slice, 'sessionId')).toBe(false) // the false red this prevents
    expect(declaresMember(SOURCE, 'sessionId')).toBe(true) // file-level WOULD have matched
  })

  it('still catches a member declared inside the scoped class', () => {
    const withEvents = SOURCE.replace('\tlog = [];', '\tlog = [];\n\tevents = [];')
    expect(declaresMember(scopedSlice(withEvents, SESSION_CLASS), 'events')).toBe(true)
  })

  it('returns null when the scope markers are gone (itself drift)', () => {
    expect(scopedSlice('nonsense', SESSION_CLASS)).toBeNull()
    expect(scopedSlice('var Session = class Session {\n', SESSION_CLASS)).toBeNull() // no end marker
  })
})

describe('escapeRegExp', () => {
  it('escapes regex metacharacters', () => {
    expect(escapeRegExp('a.b*c(d)')).toBe('a\\.b\\*c\\(d\\)')
    expect(new RegExp(escapeRegExp('a.b')).test('a.b')).toBe(true)
    expect(new RegExp(escapeRegExp('a.b')).test('axb')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Bolt-on / reflection forms (review-independent-3 §2.2, escapes E1-E12).
// These live OUTSIDE the class body or use quoted keys, so the scoped
// line-oriented matcher cannot see them — hence a second, whole-file pass.
// ---------------------------------------------------------------------------
describe('declaresMemberBoltOn — reflection/bolt-on resurrection forms', () => {
  const BOLT_ON = {
    events: [
      "Object.defineProperty(Session.prototype, 'events', { value: [] })", // E1
      "Reflect.defineProperty(Session.prototype, 'events', { value: [] })", // E1 (Reflect)
      "defineProperty(Session.prototype, 'events', { value: [] })", // E1 (bare, static block)
      'Session.prototype.events = []', // E2
      'Object.assign(Session.prototype, { events: [] })', // E3 (red file-wide, green in-slice)
      '__decorate([dec], Session.prototype, "events", void 0)', // E4
      "class Session { static { Object.defineProperty(this.prototype, 'events', { value: [] }) } }", // E6
      "class Session { ['events'] = [] }", // E7
      "class Session { ['events']() {} }", // E7 (computed method)
      '@dec events = [];', // E8 (cheap extra; see header re escapes)
      'declare events: unknown;', // E9 (cheap extra)
    ],
    values: ['SessionStore.prototype.values = function () {}'], // E5
    keys: ['SessionStore.prototype.keys = () => []'],
    chat: ["API.prototype.__defineGetter__('chat', fn)"], // E12
    nodes: ["Object.defineProperty(API, 'nodes', { get: () => map })"],
  }

  for (const [member, forms] of Object.entries(BOLT_ON)) {
    it(`${member}: ${forms.length} bolt-on form(s) are detected`, () => {
      const missed = forms.filter((form) => !declaresMemberBoltOn(form, member))
      expect(missed).toEqual([])
    })
  }

  it('a bolt-on form outside the class slice is invisible to the scoped matcher (why the raw pass exists)', () => {
    const source = [
      'var Session = class Session {',
      '\tlog = [];',
      '};',
      'Object.assign(Session.prototype, { events: [] })', // outside the slice
    ].join('\n')
    const SESSION_CLASS = { start: 'var Session = class Session {', end: '\n};' }
    expect(declaresMember(scopedSlice(source, SESSION_CLASS), 'events')).toBe(false) // slice-only: escape
    expect(declaresMemberBoltOn(source, 'events')).toBe(true) // whole-file pass catches it
  })

  it('legitimate reflection on other members does not false-positive', () => {
    const legitimate = [
      ["Object.defineProperty(this, 'log', { value: [] })", 'events'],
      ["Object.defineProperty(this, 'eventsList', { value: [] })", 'events'],
      ['Object.assign(target, { nodes: [] })', 'events'],
      ['obj.prototype.eventsSnapshot = []', 'events'],
      ['foo.events()', 'events'],
      ["foo['eventsList'] = 1", 'events'],
      ["__defineGetter__('eventsList', fn)", 'events'],
      ['__decorate([d], X, "eventsList", void 0)', 'events'],
      ['@dec eventsSnapshot = [];', 'events'],
      ['declare eventsSnapshot: unknown;', 'events'],
      ['class Session { log = []; }', 'events'],
    ]
    const falsePositives = legitimate.filter(([form, member]) => declaresMemberBoltOn(form, member))
    expect(falsePositives).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// entrySlice — deterministic slot-catalog entry boundary (review-3 §4.3).
// Replaces the character-window regex, which could match a neighbouring entry.
// ---------------------------------------------------------------------------
describe('entrySlice — next `key: "` is the boundary, not a character window', () => {
  const CATALOG = [
    '\t\t\t{',
    '\t\t\t\tkey: "conversation.view",',
    '\t\t\t\tstandardProps: [',
    '\t\t\t\t\t"useChat: UseChat",',
    '\t\t\t\t\t"useProjection: UseProjection"',
    '\t\t\t\t]',
    '\t\t\t},',
    '\t\t\t{',
    '\t\t\t\tkey: "main",',
    '\t\t\t\tstandardProps: [',
    '\t\t\t\t\t"useChat: UseChat",',
    '\t\t\t\t\t"MAIN_ONLY_MARKER"',
    '\t\t\t\t]',
    '\t\t\t}',
  ].join('\n')

  it('bounds the view entry at the next key (no leak from the following entry)', () => {
    const slice = entrySlice(CATALOG, 'conversation.view')
    expect(slice).not.toBeNull()
    expect(slice).toContain('"useProjection: UseProjection"')
    expect(slice).not.toContain('MAIN_ONLY_MARKER')
    expect(slice).not.toContain('key: "main"')
  })

  it('a missing useChat/useProjection pair in the view entry is NOT rescued by another entry', () => {
    // view entry without useProjection; the NEXT entry has both props — a char
    // window would have been falsely green, the structural slice is not.
    const poisoned = CATALOG.replace('\t\t\t\t\t"useProjection: UseProjection"', '\t\t\t\t\t"somethingElse: Else"')
    const slice = entrySlice(poisoned, 'conversation.view')
    const re = /standardProps: \[[\s\S]*?"useChat: UseChat"[\s\S]*?"useProjection: UseProjection"/
    expect(re.test(slice)).toBe(false)
  })

  it('returns null when the key is absent; last entry slices to end of text', () => {
    expect(entrySlice(CATALOG, 'nope')).toBeNull()
    const last = entrySlice(CATALOG, 'main')
    expect(last).toContain('MAIN_ONLY_MARKER')
    expect(last).not.toContain('key: "conversation.view"')
  })
})
