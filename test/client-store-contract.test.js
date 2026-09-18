/**
 * dsh-retrace — published client source guards (2026-09-14 live-incident).
 *
 * These are static checks on `lib/client.js` (the file that is bundled into
 * `lib/client.bundle.js` and shipped). They pin the two halves of the fix that
 * a behaviour test can miss:
 *   1. the chat nodes are read from the TOP-LEVEL `snapshot.nodes`, and
 *      `snapshot.chat` (a key that does not exist anywhere in the host) is
 *      never dereferenced;
 *   2. every custom prop the four registered slot components destructure is
 *      declared by the host slot contract (owner / standard / keyed props, or
 *      the locale-injected `t`).
 *
 * ── Provenance of the slot contract below (recorded from the real host) ─────
 * Source: DSH Desktop 2.0.9, inside
 *   /Applications/DSH Desktop.app/Contents/Resources/app.asar
 * at the archive member
 *   node_modules/@deepseek-ai/dsh-cordis-client-runner/lib/client.js
 * (its slot-contract catalogue). Each entry there records an upstream `source`:
 *   - conversation.chat.assistant-actions → "packages/client/ui-chat/src/client/contract/slots.ts:213"
 *   - conversation.chat.node            → "packages/client/ui-chat/src/client/contract/slots.ts:182"
 * Extraction method: read the asar preamble (u32 header-size pickle + header
 * JSON), walk the header's `files` tree to the member, then slice
 * `8 + headerSize + offset .. + size`; locate `key: "conversation.chat.*"` and
 * copy `kind` / `standardProps` / `ownerProps` / `keyDomain` verbatim. Fields
 * below are transcribed, not remembered.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { zh, en } from '../lib/client.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLIENT_SOURCE_PATH = path.join(ROOT, 'lib', 'client.js')
const source = readFileSync(CLIENT_SOURCE_PATH, 'utf8')

const HOOK_NAMES = [
  'useMessageSeq',
  'useSeqHidden',
  'useShadowed',
  'useMarkerHidePlan',
  'useMarkerDismissed',
  'useEditReference',
]

/**
 * Slot contract transcribed from the host catalogue (see provenance above).
 * `standardProps` is deduplicated for the membership check; the host lists
 * `useWorkspaces` twice, which is irrelevant to name validity.
 */
const CHAT_STANDARD_PROPS = [
  'useResource',
  'useWorkspaces',
  'usePanelInfo',
  'useSessions',
  'useSessionPendingInteraction',
  'useChat',
  'useConversation',
  'useInput',
  'inputActions',
  'useSession',
  'sessionId',
  'useProjection',
  'useTrajectory',
]
const SLOT_CONTRACTS = {
  'conversation.chat.assistant-actions': {
    kind: 'list',
    standardProps: CHAT_STANDARD_PROPS,
    ownerProps: ['messageId'],
    // keyed owners expose the dispatched node via the owner key table
    // `{ [Kind in ChatNodeKind]: { node: ChatNode<Kind> } }`.
    keyedProps: [],
    source: 'packages/client/ui-chat/src/client/contract/slots.ts:213',
  },
  'conversation.chat.node': {
    kind: 'keyed',
    standardProps: CHAT_STANDARD_PROPS,
    ownerProps: ['cwd', 'openFile', 'inspectCall', 'forkAt', 'loadImage', 'renderMessageImages', 'fileMentions', 'turnProcess'],
    keyedProps: ['node'],
    source: 'packages/client/ui-chat/src/client/contract/slots.ts:182',
  },
  // The two plugin views (版本 / Fork) are `conversation.view` entries. Its
  // contract also declares the whole standard kit — including `useChat`, which
  // is the sanctioned node source for a view (the host's own chat view reads
  // `useChat((s) => s.nodes)`, dsh-client-ui-chat/lib/client.js:2074).
  'conversation.view': {
    kind: 'list',
    standardProps: CHAT_STANDARD_PROPS,
    ownerProps: ['viewRequest', 'openView', 'completeViewRequest'],
    keyedProps: [],
    source: 'packages/client/ui-conversation/src/client/contract/slots.ts:156',
  },
}

/** `conversation.view` entries; `actions`/`store` arrive via the entry's own `inject`. */
const VIEW_COMPONENTS = ['RetraceView']

/** One entry per `ctx.slots.register(...)` of this plugin. */
const REGISTERED_COMPONENTS = [
  { component: 'AssistantActions', seat: 'conversation.chat.assistant-actions', key: null },
  { component: 'UserActionsRow', seat: 'conversation.chat.node', key: 'user-actions' },
  { component: 'ReferenceRow', seat: 'conversation.chat.node', key: 'retrace-reference' },
  { component: 'RecallMarkerRow', seat: 'conversation.chat.node', key: 'recall-marker' },
]

/** Extract the brace-balanced body of a top-level `function name(...) {}`. */
function functionBody(text, name) {
  const start = text.indexOf(`function ${name}(`)
  expect(start, `function ${name} not found in lib/client.js`).toBeGreaterThan(-1)
  const braceStart = text.indexOf('{', start)
  let depth = 0
  for (let i = braceStart; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1
    else if (text[i] === '}') {
      depth -= 1
      if (depth === 0) return text.slice(braceStart, i + 1)
    }
  }
  throw new Error(`unbalanced braces while reading function ${name}`)
}

/** Destructured parameter names of `function Component({ a, b, t })`. */
function destructuredProps(text, name) {
  const match = new RegExp(`function ${name}\\(\\{([^}]*)\\}`).exec(text)
  expect(match, `destructured props of ${name} not found`).not.toBeNull()
  return match[1].split(',').map((entry) => entry.trim()).filter(Boolean)
}

/**
 * The whole source slice of one top-level function, from its declaration to the
 * next top-level `function`. Robust against destructured parameters and against
 * braces/`${}` inside template literals (which a brace counter would miscount).
 */
function functionSlice(text, name) {
  const start = text.indexOf(`function ${name}(`)
  expect(start, `function ${name} not found in lib/client.js`).toBeGreaterThan(-1)
  const next = text.indexOf('\nfunction ', start + 1)
  return text.slice(start, next === -1 ? text.length : next)
}

describe('client source guard: chat nodes come from snapshot.nodes', () => {
  it('never dereferences snapshot.chat (0 hits, no matter the form)', () => {
    expect(source.match(/snapshot\.chat\./g) ?? []).toHaveLength(0)
    // stronger: the bare property access itself must not exist
    expect(source.match(/\bsnapshot\.chat\b/g) ?? []).toHaveLength(0)
  })

  it('reads snapshot.nodes, and every one of the six hooks does so (directly or via hidePlanOf)', () => {
    // INTENTIONAL exact count (change-detector), not noise. The incident fix
    // routed the node reads through `snapshot.nodes`, not `snapshot.chat.nodes`.
    // The count moved 7 -> 5 with the 2026-09-14 performance fix: the reads that
    // used to live inside `useMarkerHidePlan` and `useSeqHidden` now live in the
    // shared `hidePlanOf` plan (which still reads `snapshot.nodes`). A legitimate
    // NEW read must be added here on purpose — do NOT delete this assertion as
    // flaky; it pins the fix against a re-introduced `snapshot.chat.nodes` or a
    // silently dropped read.
    expect((source.match(/snapshot\.nodes/g) ?? [])).toHaveLength(5)
    const plan = functionBody(source, 'hidePlanOf')
    expect(plan, 'the shared hide plan must read snapshot.nodes').toContain('snapshot.nodes')
    expect(plan, 'the shared hide plan must not read snapshot.chat').not.toContain('snapshot.chat')
    for (const name of HOOK_NAMES) {
      const body = functionBody(source, name)
      expect(body, `${name} must read snapshot.nodes or delegate to hidePlanOf`).toMatch(/snapshot\.nodes|hidePlanOf\(/)
      expect(body, `${name} must not read snapshot.chat`).not.toContain('snapshot.chat')
    }
  })

  it('the six hooks take their selector as the first parameter named useChat', () => {
    for (const name of HOOK_NAMES) {
      expect(source).toMatch(new RegExp(`function ${name}\\(useChat[,)]`))
    }
  })
})

describe('client source guard: RecallMarkerRow calls hooks unconditionally (Rules of Hooks)', () => {
  it('calls useMarkerDismissed / useMarkerHidePlan before the `compact` early return', () => {
    const body = functionSlice(source, 'RecallMarkerRow')
    const earlyReturn = body.indexOf('if (compact) return null')
    expect(earlyReturn, 'the compact early return must exist').toBeGreaterThan(-1)
    const dismissedAt = body.indexOf('useMarkerDismissed(')
    const hidePlanAt = body.indexOf('useMarkerHidePlan(')
    expect(dismissedAt, 'useMarkerDismissed call not found').toBeGreaterThan(-1)
    expect(hidePlanAt, 'useMarkerHidePlan call not found').toBeGreaterThan(-1)
    // Regression guard: an early return BEFORE a hook call makes the hook order
    // depend on `node.data.compact`, which is a Rules-of-Hooks violation the
    // moment that flag can change between renders for the same component slot.
    expect(dismissedAt, 'useMarkerDismissed must be called before the compact early return').toBeLessThan(earlyReturn)
    expect(hidePlanAt, 'useMarkerHidePlan must be called before the compact early return').toBeLessThan(earlyReturn)
  })
})

describe('client source guard: slot props are declared by the host contract', () => {
  it('the contract transcription carries its host provenance', () => {
    // Guard the provenance fixture itself: if someone edits the constants they
    // must keep pointing at the upstream contract file.
    for (const contract of Object.values(SLOT_CONTRACTS)) {
      expect(contract.source).toMatch(/packages\/client\/ui-(chat|conversation)\/src\/client\/contract\/slots\.ts:\d+/)
    }
    expect(SLOT_CONTRACTS['conversation.chat.assistant-actions'].kind).toBe('list')
    expect(SLOT_CONTRACTS['conversation.chat.node'].kind).toBe('keyed')
    expect(SLOT_CONTRACTS['conversation.view'].kind).toBe('list')
  })

  it('each registered component only destructures contract / locale props', () => {
    const LOCALE_INJECTED = new Set(['t']) // t comes from register({ locale: NS })
    for (const { component, seat } of REGISTERED_COMPONENTS) {
      const contract = SLOT_CONTRACTS[seat]
      const allowed = new Set([
        ...contract.standardProps,
        ...contract.ownerProps,
        ...contract.keyedProps,
        ...LOCALE_INJECTED,
      ])
      const props = destructuredProps(source, component)
      for (const prop of props) {
        expect(allowed.has(prop), `${component} destructures "${prop}", not in the ${seat} contract`).toBe(true)
      }
      // the fix: the selector hook is useChat (chat snapshot), not useSession
      expect(props, `${component} must take the useChat selector`).toContain('useChat')
      expect(props, `${component} must receive the locale-bound t`).toContain('t')
    }
  })

  it('the plugin still registers the four chat slots the contract covers', () => {
    for (const { seat, key, component } of REGISTERED_COMPONENTS) {
      expect(source).toContain(`name: '${seat}'`)
      if (key !== null) expect(source).toContain(`key: '${key}'`)
      // The component is the second argument of that registration form — since
      // 2026-09-15 every surface is wrapped in the shared panel error boundary,
      // so accept either the bare or the wrapped form (the surface must still be
      // the one registered; that is what this guard protects).
      const bare = `}, ${component})`
      const wrapped = `}, withPanelBoundary(${component}, `
      expect(source.includes(bare) || source.includes(wrapped), `${component} must be the registered component`).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// §8.1 correction (2026-09-14 independent review): "the host has no `chat`
// path" was concluded from a scan for the LITERAL `snapshot.chat` (0 hits) —
// which missed the live survivor `store.getSnapshot()?.chat?.nodes`
// (lib/client.js:1391/1405/1407 before this fix). The scan below enumerates
// the optional-chained / store-rooted forms as well, and runs on
// block-comment-stripped source (a doc comment may legitimately quote the
// buggy shape, so only CODE is judged).
// ---------------------------------------------------------------------------
const CODE = source.replace(/\/\*[\s\S]*?\*\//g, '')

describe('client source guard: the jump path never reads chat nodes off the store', () => {
  it('no store-rooted / optional-chained chat-node read survives (scan forms enumerated)', () => {
    const FORMS = [
      [/snapshot\.chat\./g, 'snapshot.chat.'],
      [/\bchat\?\.nodes/g, '.chat?.nodes'],
      [/getSnapshot\(\)\?\.chat/g, 'getSnapshot()?.chat'],
      [/getSnapshot\(\)\.chat\b/g, 'getSnapshot().chat'],
    ]
    for (const [re, label] of FORMS) {
      expect(CODE.match(re) ?? [], `code must not contain ${label}`).toHaveLength(0)
    }
  })

  it('resolveAnchorKey reads nodes via the injected source and pages via loadThrough', () => {
    const body = functionSlice(source, 'resolveAnchorKey')
    expect(body).toContain('readNodes()')
    expect(body).toContain('loadThrough')
    expect(body, 'the node lookup must not come from the session store').not.toContain('getSnapshot')
    const jump = functionSlice(source, 'jumpToAnchor')
    expect(jump).toContain('readNodes')
    expect(jump, 'the jump must not read the session store snapshot').not.toContain('getSnapshot')
  })

  it('badge title tagging goes through the server op, never a client-side title read', () => {
    // 2.0.9 上宿主客户端**没有**读标题的途径：`store.getTitle` 在
    // `dsh-api-session-controller` 全包 0 命中，客户端会话控制器的 `buildSnapshot()`
    // 字段里也没有 title。删掉的那段本地实现用这个读值拼 `[badge] base`，读不到就把
    // base 退化成 `sessionId.slice(0,16)` ⇒ **把用户标题冲成 `[XXXXXX] <id 前缀>`**。
    // 服务端本就从日志读当前标题并追加 `session/title`（lib/index.js:307/327）⇒ 只留它。
    expect(CODE.match(/getTitle/g) ?? [], 'no client-side title read may survive').toHaveLength(0)
    expect(CODE, 'the badge title path must call the server op').toContain("'setBadgeTitle'")
  })

  it('the checkpoint view takes useChat from the view contract', () => {
    const standard = new Set(SLOT_CONTRACTS['conversation.view'].standardProps)
    expect(standard.has('useChat')).toBe(true)
    for (const component of VIEW_COMPONENTS) {
      const props = destructuredProps(source, component)
      expect(props, `${component} must take the useChat standard prop`).toContain('useChat')
      // `actions` (inject's 2nd arg) and `store` (the entry's own inject result)
      // are not standard-kit props; every other prop must be declared.
      for (const prop of props) {
        expect(
          ['actions', 'store', 't'].includes(prop) || standard.has(prop),
          `${component} destructures "${prop}", not in the conversation.view standard kit`,
        ).toBe(true)
      }
    }
  })

  it('the badge path calls the server op only (no local title read, no id-prefix fallback)', () => {
    const retrace = functionSlice(source, 'RetraceView')
    expect(retrace, 'the auto-badge path must call the server op').toContain("callOp('setBadgeTitle'")
    // The removal is documented in a block comment quoting the old shape, so
    // only the CODE is judged.
    const retraceCode = retrace.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(retraceCode, 'no client-side title read').not.toContain('getTitle')
    expect(retraceCode, 'the id-prefix title fallback must not return').not.toMatch(/slice\(0,\s*16\)/)
    expect(CODE, 'no id-prefix title fallback anywhere in code').not.toMatch(/slice\(0,\s*16\)/)
  })

  it('the view components read useChat through one unconditional hook (no ternary call)', () => {
    // HIGH review MEDIUM-B: `useChat(...)` inside a `typeof … ? … : …` in a
    // component body makes the hook call conditional (Rules of Hooks). It must
    // go through the always-called `useChatNodes` wrapper instead.
    const wrapper = functionSlice(source, 'useChatNodes')
    expect(wrapper, 'the wrapper must guard the absent-prop case inside itself').toContain("typeof useChat === 'function'")
    for (const component of VIEW_COMPONENTS) {
      const body = functionSlice(source, component)
      expect(body, `${component} must call useChatNodes unconditionally`).toContain('useChatNodes(useChat)')
      expect(body, `${component} must not gate the useChat hook call in a ternary`)
        .not.toMatch(/typeof useChat === 'function'\s*\?\s*useChat\(/)
    }
  })
})

// ---------------------------------------------------------------------------
// UX source guard (2026-09-14): the single checkpoint view must keep its
// concept sentence and every row must keep the plain-language why line.
// ---------------------------------------------------------------------------
describe('client source guard: the checkpoint view explains itself', () => {
  it('the dictionaries carry the concept sentence, the why lines and the digest labels', () => {
    for (const key of ['timeline.intro', 'what.summaryTag', 'what.oldVoid', 'what.currentLabel', 'what.discarded']) {
      for (const dict of [zh, en]) {
        expect(String(dict[key] ?? '').trim(), `${key} must be non-empty`).not.toBe('')
      }
    }
    for (const kind of ['recall', 'edit', 'regenerate', 'restore', 'compaction', 'replace']) {
      for (const dict of [zh, en]) {
        expect(String(dict[`timeline.why.${kind}`] ?? '').trim(), `timeline.why.${kind}`).not.toBe('')
      }
    }
  })

  it('role labels are human phrases, not the raw node-type nouns', () => {
    expect(zh['what.role.user']).toBe('你发送的消息')
    expect(zh['what.role.assistant']).toBe('助手生成的回复')
    expect(zh['what.role.tool']).toBe('工具执行结果')
    expect(zh['what.role.user']).not.toBe(zh['what.role.assistant'])
    expect(zh['what.role.user']).not.toBe(zh['what.role.tool'])
    for (const bare of ['用户消息', '助手回复', '工具结果', 'User message', 'Assistant reply', 'Tool result']) {
      expect(Object.values(zh)).not.toContain(bare)
      expect(Object.values(en)).not.toContain(bare)
    }
    expect(zh['what.discarded']).not.toContain('节点')
    expect(en['what.discarded']).not.toContain('node')
  })

  it('the view wires the concept sentence and the row wires the why line', () => {
    // 页首说明现在带次数（{count}）⇒ 断言到 key 为止
    expect(functionSlice(source, 'RetraceView'), 'RetraceView must render the concept sentence').toContain("t('timeline.intro'")
    expect(functionSlice(source, 'VersionRow'), 'VersionRow must explain why when there is no marker text').toContain('whyLabel(')
  })
})

// ---------------------------------------------------------------------------
// Naming + summary switch + digest rendering guards (2026-09-14).
// ---------------------------------------------------------------------------
const FORBIDDEN_VISIBLE_WORDS = /版本|分叉|岔路口|路径|谱系|分支/
describe('client source guard: checkpoints copy + summary switch + digest rendering', () => {
  it('no retired wording survives in the view copy', () => {
    // Scoped to the VIEW copy: `options.gitDesc` legitimately says 分支 (git
    // branches) and `options.closeGuardDesc` legitimately says 路径 (close
    // paths) — neither is the retired fork vocabulary.
    for (const [name, dict] of [['zh', zh], ['en', en]]) {
      const offenders = Object.entries(dict)
        .filter(([key]) => /^(timeline|what|view|fork)\./.test(key))
        .filter(([, value]) => FORBIDDEN_VISIBLE_WORDS.test(String(value)))
        .map(([key]) => key)
      expect(offenders, `${name} view keys still using a retired word`).toEqual([])
    }
  })

  it('the checkpoint tab name and concept sentence are the approved wording', () => {
    expect(zh['timeline.title']).toBe('读档点')
    expect(zh['view.retrace']).toBe('读档点')
    expect(zh['timeline.intro']).toBe('这里是你会话的改动记录：每次撤回 / 编辑 / 重新生成前，原来的内容都会存一档（共 {count} 次）。点任一条可展开看当时的原话。')
  })

  it('the retired fork view and its data channel are gone', () => {
    expect(source, 'no ForkView component remains').not.toMatch(/function ForkView\(/)
    expect(source, 'no fork tab registration remains').not.toContain("id: 'retrace-fork'")
    expect(source, 'no /forkmap fetch remains').not.toContain('timelineGet(`/forkmap')
    expect(source, 'no /lineage fetch remains').not.toContain('timelineGet(`/lineage')
    expect(zh['view.fork']).toBeUndefined()
    expect(zh['fork.title']).toBeUndefined()
  })

  it('the summary switch defaults OFF and travels in x-retrace-config', () => {
    expect(functionSlice(source, 'retraceConfigHeaders')).toContain('summary')
    expect(source).toMatch(/const CONFIG_DEFAULTS = \{[^}]*summary: false/)
    expect(String(zh['options.summary'] ?? '')).not.toBe('')
    expect(String(zh['options.summaryDesc'] ?? '')).toMatch(/摘要/)
    expect(String(en['options.summary'] ?? '')).not.toBe('')
  })

  it('the row wires the digest quote / summary / colour classes', () => {
    // 2026-09-15: the digest LINES moved into whatLineElement (compact row +
    // detail block share one line model), so the colour classes live there.
    const body = functionSlice(source, 'whatLineElement')
    expect(body).toContain('dsh-rt-what-quote')
    expect(body).toContain('dsh-rt-what-summary')
    expect(body).toContain('dsh-rt-what-new')
    expect(body).toContain('dsh-rt-what-old')
    const version = functionSlice(source, 'VersionRow')
    expect(version).toContain('whatLineElement(')
    expect(version, 'the artifact line must come from the digest, not a raw 0/0/0 count').toContain('artifactsLabel(')
    // the digest read is a single pure-read fetch merged by boundarySeq
    expect(functionSlice(source, 'fetchBoundaryDigests')).toContain('/summaries?sessionId=')
    expect(functionSlice(source, 'indexDigests')).toContain('boundarySeq')
  })
})
