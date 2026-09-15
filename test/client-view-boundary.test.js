/**
 * dsh-retrace · test/client-view-boundary.test.js
 *
 * 白屏事故回归 (2026-09-15 real machine: 「点了收起。直接白屏了」).
 *
 * The incident: the 收起 chip called the view's `toggle`, whose `setExpanded`
 * updater referenced an UNBOUND `row`. React runs updaters during the next
 * render, so the ReferenceError was a RENDER error; with no error boundary React
 * unmounted the host's whole tree and the entire GUI went blank.
 *
 * These tests drive the REAL `RetraceView` through a real render phase
 * (test/mini-react.js models React's documented semantics, including state
 * updaters in render and error boundaries) and lock:
 *   ① every row kind has a FINITE height (the row model's single source),
 *   ② an out-of-range window can never render a non-existent row,
 *   ③ the collapse round trip does not throw (the exact incident path),
 *   ④ the panel error boundary catches a throwing child and keeps the app alive.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { createMiniReact, collectElements, textOf, findByClass } from './mini-react.js'
// `zh` is already a module export of client.js (never re-export it: esbuild fails
// with "Multiple exports with the same name").
import { zh } from '../lib/client.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLIENT_SOURCE_PATH = path.join(ROOT, 'lib', 'client.js')

// The module-private surface these tests drive (bundle + appended exports).
const EXPORTS = [
  'RetraceView', 'RetraceErrorBoundary', 'rowHeightOf', 'clampIndex',
  'buildDisplayRows', 'visibleFrom', 'visibleTo',
]

let client
let mini
// The view measures its list through `document` (host DOM). jsdom is not a
// dependency here, so provide the two calls the view makes.
const originalDocument = globalThis.document
const originalWindow = globalThis.window
const originalFetch = globalThis.fetch

beforeAll(async () => {
  globalThis.document = globalThis.document ?? { querySelector: () => null, addEventListener() {}, removeEventListener() {} }
  globalThis.window = globalThis.window ?? { addEventListener() {}, removeEventListener() {}, innerHeight: 900 }
  // The view reads its digest + outline through `GET /summaries` (the same read
  // path the real machine uses). Serve it, plus the routes the mount effects hit.
  const asJson = (value) => Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve(value) })
  globalThis.fetch = (url) => {
    const target = String(url)
    if (target.includes('/summaries')) {
      return asJson({
        ok: true,
        value: {
          enabled: false,
          sessionId: 's1',
          skipped: 0,
          error: null,
          records: [...digests.entries()].map(([boundarySeq, digest]) => ({ boundarySeq, versionId: `v${boundarySeq}`, ...digest })),
          tree,
        },
      })
    }
    if (target.includes('/versions')) return asJson({ ok: true, value: { enabled: true, versions, hostReplacementCount: 0 } })
    return asJson({ ok: true, value: null })
  }
  const source = readFileSync(CLIENT_SOURCE_PATH, 'utf8')
  for (const name of EXPORTS) {
    // `zh` is a const dictionary; every other name is a function or a class.
    const declared = source.includes(`function ${name}(`) || source.includes(`class ${name} `)
    expect(declared, `lib/client.js must declare ${name}`).toBe(true)
  }
  mini = createMiniReact()
  const nodeRequire = createRequire(path.join(ROOT, 'package.json'))
  const bundled = await build({
    stdin: {
      contents: `${source}\nexport { ${EXPORTS.join(', ')} }\n`,
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
  })
  const mod = { exports: {} }
  // eslint-disable-next-line no-new-func
  new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(
    (id) => (id === 'react' ? mini.react : nodeRequire(id)), mod, mod.exports,
  )
  client = mod.exports
})

const t = (key, params) => {
  let text = zh[key] ?? key
  if (params) for (const [name, value] of Object.entries(params)) text = text.split(`{${name}}`).join(String(value))
  return text
}

// ---- fixtures: a root → child → grandchild forest --------------------------
const rec = (seq, kind = 'edit') => ({
  versionId: `v${seq}`, boundarySeq: seq, kind, createdAt: 1000 + seq, markerText: '', messageCount: 5,
  fileCounts: { created: 0, modified: 0, deleted: 0 }, touchedFiles: [], git: null,
})
const what = (seq) => ({
  op: 'edit', at: 1000 + seq, new: { excerpt: '' },
  replaced: [{ seq: 100 + seq, role: 'user', excerpt: `被丢弃的原文 ${seq}` }], replacedMore: 2,
})
const versions = [rec(1), rec(2), rec(3)]
const tree = {
  1: { parent: null, children: [2], discardedCount: 3 },
  2: { parent: 1, children: [3], discardedCount: 2 },
  3: { parent: 2, children: [], discardedCount: 1 },
}
const digests = new Map([
  [1, { what: what(1), called: false, discardedSeqs: [2], discardedCount: 3 }],
  [2, { what: what(2), called: false, discardedSeqs: [3], discardedCount: 2 }],
  [3, { what: what(3), called: false, discardedSeqs: [], discardedCount: 1 }],
])
const indexTree = () => new Map(Object.entries(tree).map(([key, node]) => [Number(key), node]))

const viewProps = {
  sessionId: 's1',
  useChat: () => undefined,
  useProjection: () => ({ versions, hostReplacementCount: 0 }),
  t,
  actions: {},
  store: {},
}

/** Mount the view inside a fake host App and settle the initial render + reads. */
const mountView = async ({ wrap = false } = {}) => {
  mini.reset()
  const child = mini.react.createElement(client.RetraceView, { key: 'retrace', ...viewProps })
  const app = mini.react.createElement('div', { className: 'host-app' }, [
    mini.react.createElement('div', { className: 'host-other-panel' }, '宿主其他面板'),
    wrap ? mini.react.createElement(client.RetraceErrorBoundary, { key: 'b', t }, child) : child,
  ])
  mini.mount(app)
  mini.flush()
  // let the /summaries + /versions reads settle, then render again
  await new Promise((resolve) => setTimeout(resolve, 0))
  mini.flush()
  return mini.tree()
}

describe('行高单一来源：每一种 row.kind 都是有限数', () => {
  it('rowHeightOf 覆盖所有 kind；未知 kind 也回退到 ROW_H（绝不 NaN/undefined）', () => {
    const finite = (value) => Number.isFinite(value) && value > 0
    expect(client.rowHeightOf({ kind: 'row', detailOpen: false })).toBe(60)
    expect(client.rowHeightOf({ kind: 'row', detailOpen: true, detailCount: 3 })).toBe(60 + 3 * 18)
    expect(client.rowHeightOf({ kind: 'row', detailOpen: true })).toBe(60)                 // 缺 detailCount
    expect(client.rowHeightOf({ kind: 'row', detailOpen: true, detailCount: NaN })).toBe(60)
    expect(client.rowHeightOf({ kind: 'row', detailOpen: true, detailCount: 'x' })).toBe(60)
    for (const kind of ['fallback', 'collapsed', 'expanded', 'depth', 'brand-new-kind', undefined]) {
      expect(finite(client.rowHeightOf({ kind })), `kind=${String(kind)}`).toBe(true)
    }
  })

  it('buildDisplayRows 产出的每一行都带有限 height（含默认展开的一层与深层提示）', () => {
    const rows = client.buildDisplayRows({ versions, digests, tree: indexTree(), expanded: null })
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(Number.isFinite(row.height), `kind=${row.kind} height=${row.height}`).toBe(true)
      expect(row.height).toBeGreaterThan(0)
    }
    // 展开明细的行也有限
    const opened = client.buildDisplayRows({ versions, digests, tree: indexTree(), expanded: null, detailOpen: new Map([[1, true]]) })
    for (const row of opened) expect(Number.isFinite(row.height)).toBe(true)
    // 树展开态（会出现 expanded / collapsed / depth 三种骨架行）同样每一行都有限
    // 只展开根：会出现 row + expanded chip + 子行 + collapsed chip
    const treeExpanded = client.buildDisplayRows({
      versions, digests, tree: indexTree(), expanded: new Map([[1, true]]),
    })
    const kinds = new Set(treeExpanded.map((row) => row.kind))
    expect(kinds.has('expanded')).toBe(true)
    expect(kinds.has('collapsed')).toBe(true)
    for (const row of treeExpanded) {
      expect(Number.isFinite(row.height), `kind=${row.kind} height=${row.height}`).toBe(true)
    }
  })
})

describe('越界窗口不会渲染不存在的行', () => {
  it('clampIndex 把 NaN/负数/越界值夹进 [0, length]', () => {
    expect(client.clampIndex(NaN, 5)).toBe(0)
    expect(client.clampIndex(undefined, 5)).toBe(0)
    expect(client.clampIndex(-3, 5)).toBe(0)
    expect(client.clampIndex(2, 5)).toBe(2)
    expect(client.clampIndex(99, 5)).toBe(5)
    expect(client.clampIndex(Infinity, 5)).toBe(5)
  })

  it('滚到远超内容的位置：只渲染边界内的行，不抛错', async () => {
    const rows = client.buildDisplayRows({ versions, digests, tree: indexTree(), expanded: null })
    const offsets = []
    let total = 0
    for (const row of rows) { offsets.push(total); total += row.height }
    const start = client.clampIndex(client.visibleFrom(rows, offsets, 10 ** 9), rows.length)
    const end = Math.max(start, client.clampIndex(client.visibleTo(rows, offsets, 10 ** 9 + 640), rows.length))
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeLessThanOrEqual(rows.length)
    const visible = rows.slice(start, end)
    for (const row of visible) expect(row).toBeDefined()
    // 真实视图：把列表滚到超远处，渲染不抛错且仍然只有边界内的行
    const mounted = await mountView()
    const list = findByClass(mounted, 'dsh-rt-timeline-list')
    expect(list).toBeDefined()
    list.props.onScroll({ target: { scrollTop: 10 ** 9 } })
    const after = mini.flush()
    expect(textOf(after)).toContain('宿主其他面板')
    // count ROW containers only (child classes like `dsh-rt-version-body` also
    // contain the same prefix)
    const rowCount = collectElements(after)
      .filter((el) => String(el.props?.className ?? '').split(' ').includes('dsh-rt-version')).length
    expect(rowCount).toBeLessThanOrEqual(rows.length)
  })
})

describe('收起往返不崩（白屏事故的真机路径）', () => {
  const chips = (treeRoot) => collectElements(treeRoot)
    .filter((el) => String(el.props?.className ?? '').includes('dsh-rt-tree-btn'))

  it('默认收起 → 点击展开 → 点收起 → 再展开，全程不抛错', async () => {
    const mounted = await mountView()
    // 默认收起（用户口径）：没有「收起」入口，只有折叠入口
    expect(chips(mounted).some((el) => textOf(el).includes(zh['tree.collapse']))).toBe(false)
    const foldChip = chips(mounted).find((el) => textOf(el).includes(zh['tree.changes'].split('{')[0]))
    expect(foldChip, '默认应收起，留一个折叠入口').toBeDefined()

    // 点击展开（事故路径：updater 在下一次渲染里执行）
    expect(() => { foldChip.props.onClick(); mini.flush() }).not.toThrow()
    const opened = mini.tree()
    expect(textOf(opened)).toContain('宿主其他面板')
    const collapseChip = chips(opened).find((el) => textOf(el).includes(zh['tree.collapse']))
    expect(collapseChip, '展开后应出现「收起」').toBeDefined()

    // 点收起 ⇒ 回到默认形态；再展开一次 ⇒ 与第一次相同（往返不崩）
    expect(() => { collapseChip.props.onClick(); mini.flush() }).not.toThrow()
    expect(chips(mini.tree()).some((el) => textOf(el).includes(zh['tree.collapse']))).toBe(false)
    const foldAgain = chips(mini.tree()).find((el) => textOf(el).includes(zh['tree.changes'].split('{')[0]))
    expect(() => { foldAgain.props.onClick(); mini.flush() }).not.toThrow()
    expect(chips(mini.tree()).some((el) => textOf(el).includes(zh['tree.collapse']))).toBe(true)
    expect(textOf(mini.tree())).toContain('宿主其他面板')
  })

  it('深层「还有 N 层」点开/收起往返也不崩', async () => {
    const mounted = await mountView()
    // 先把根收起来再展开到深层：直接用默认视图里的折叠入口
    const fold = chips(mounted).find((el) => textOf(el).includes(zh['tree.changes'].split('{')[0]))
    expect(fold).toBeDefined()
    fold.props.onClick()
    mini.flush()
    const reopen = chips(mini.tree()).find((el) => textOf(el).includes(zh['tree.collapse']))
    reopen.props.onClick()
    mini.flush()
    const deep = chips(mini.tree()).find((el) => textOf(el).includes(zh['tree.moreLevels'].split('{')[0]))
    if (deep) {
      expect(() => { deep.props.onClick(); mini.flush() }).not.toThrow()
      expect(textOf(mini.tree())).toContain('宿主其他面板')
    }
  })
})

describe('「给人读」页首（固定、带次数、带顺序提示）', () => {
  it('页首说明带真实次数 + 顺序提示，且不在滚动容器里（固定不消失）', async () => {
    const mounted = await mountView()
    const text = textOf(mounted)
    // 次数 = 本夹具的 3 档
    expect(text).toContain(t('timeline.intro', { count: 3 }))
    expect(text).toContain(t('timeline.orderHint'))
    // 固定：页首不在 .dsh-rt-timeline-list 内部（它不随虚拟滚动消失）
    const intro = findByClass(mounted, 'dsh-rt-view-intro')
    expect(intro, '页首说明必须存在').toBeDefined()
    const list = findByClass(mounted, 'dsh-rt-timeline-list')
    const insideList = list ? collectElements(list).includes(intro) : false
    expect(insideList, '页首说明不得放进滚动容器').toBe(false)
    // 整个视图的可见文本里不得出现 #<数字>
    expect(text).not.toMatch(/#\d+/)
  })

  it('展开一条后，页首仍在、仍无 #seq', async () => {
    const mounted = await mountView()
    const chips = collectElements(mounted).filter((el) => String(el.props?.className ?? '').includes('dsh-rt-tree-btn'))
    const fold = chips.find((el) => textOf(el).includes(t('tree.changes', { count: 1 }).split('{')[0]))
    if (fold) { fold.props.onClick(); mini.flush() }
    const text = textOf(mini.tree())
    expect(text).toContain(t('timeline.intro', { count: 3 }))
    expect(text).not.toMatch(/#\d+/)
  })
})

describe('收起三处：开头 / 展开层内悬浮 / 末尾（真实渲染器）', () => {
  /** 长展开层夹具：一档展开出 18 个子行（远高于 LIST_VIEWPORT_H = 640）。 */
  const longFixture = () => {
    const versions = Array.from({ length: 19 }, (_, i) => rec(i + 1))
    const children = Array.from({ length: 18 }, (_, i) => i + 2)
    const nodes = { 1: { parent: null, children, discardedCount: 18 } }
    for (const seq of children) nodes[seq] = { parent: 1, children: [], discardedCount: 0 }
    const records = versions.map((record) => ({ boundarySeq: record.boundarySeq, versionId: record.versionId, what: what(record.boundarySeq), called: false }))
    const digestsMap = new Map(records.map((record) => [record.boundarySeq, record]))
    return { versions, nodes, records, digestsMap }
  }

  const mountLong = async () => {
    const fixture = longFixture()
    const originalFetch = globalThis.fetch
    const asJson = (value) => Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve(value) })
    globalThis.fetch = (url) => {
      const target = String(url)
      if (target.includes('/summaries')) {
        return asJson({ ok: true, value: { enabled: false, sessionId: 's1', skipped: 0, error: null, records: fixture.records, tree: fixture.nodes } })
      }
      if (target.includes('/versions')) return asJson({ ok: true, value: { enabled: true, versions: fixture.versions, hostReplacementCount: 0 } })
      return asJson({ ok: true, value: null })
    }
    mini.reset()
    mini.mount(mini.react.createElement('div', { className: 'host-app' }, mini.react.createElement(client.RetraceView, {
      ...viewProps,
      useProjection: () => ({ versions: fixture.versions, hostReplacementCount: 0 }),
    })))
    mini.flush()
    await new Promise((resolve) => setTimeout(resolve, 0))
    mini.flush()
    return { fixture, restore: () => { globalThis.fetch = originalFetch } }
  }

  const classOf = (el) => String(el.props?.className ?? '')
  const clickFold = () => {
    const chip = collectElements(mini.tree()).find((el) => classOf(el).includes('dsh-rt-tree-btn'))
    expect(chip, '默认收起时必须有折叠入口').toBeDefined()
    chip.props.onClick()
    mini.flush()
  }
  const scrollTo = (top) => {
    const list = findByClass(mini.tree(), 'dsh-rt-timeline-list')
    expect(list).toBeDefined()
    list.props.onScroll({ target: { scrollTop: top } })
    mini.flush()
  }

  it('展开后开头/末尾各一枚；滚到展开层中段 ⇒ 出现悬浮收起入口，点它回到未展开态', async () => {
    const { restore } = await mountLong()
    try {
      clickFold()
      const chipTexts = () => collectElements(mini.tree())
        .filter((el) => classOf(el).includes('dsh-rt-tree-btn') && textOf(el).includes(t('tree.collapse')))
      // 顶部：**开头**那枚在视口里（末尾那枚在 1500px 外还没进窗口）⇒ 不需要悬浮条
      expect(chipTexts().length, '顶部必须看得见开头那枚收起').toBe(1)
      expect(findByClass(mini.tree(), 'dsh-rt-collapse-hint-btn')).toBeUndefined()
      // 滚到展开层中段（开头那枚已在视口上方、末尾那枚还在视口下方）：两枚都够不着
      // ⇒ 必须给悬浮收起入口（这就是"不用滚到底部也能收"）
      // （渲染窗口会带两行余量，行内 chip 可能仍在 DOM 里但已在视口上方 ⇒ 只看悬浮条）
      scrollTo(200)
      const hint = findByClass(mini.tree(), 'dsh-rt-collapse-hint-btn')
      expect(hint, '展开层横跨视口时必须给悬浮收起入口（不用滚到底部）').toBeDefined()
      expect(textOf(hint)).toContain(t('tree.collapse'))
      // 滚到最底部：末尾那枚进了视口 ⇒ 悬浮条让位给行内入口
      scrollTo(99999)
      expect(chipTexts().length, '底部必须看得见末尾那枚收起').toBe(1)
      expect(findByClass(mini.tree(), 'dsh-rt-collapse-hint-btn')).toBeUndefined()
      // 回到中段再点悬浮条（前面那次滚动只是证明"末尾够得着时不打扰"）
      scrollTo(200)
      const again = findByClass(mini.tree(), 'dsh-rt-collapse-hint-btn')
      expect(again).toBeDefined()
      // 悬浮条不进内容高度：spacer 高度 === 行模型行高之和（没有多出一行）
      const longVersions = Array.from({ length: 19 }, (_, i) => rec(i + 1))
      const fixture = longFixture()
      const model = client.buildDisplayRows({
        versions: longVersions,
        digests: fixture.digestsMap,
        tree: indexTree() && new Map(Object.entries(fixture.nodes).map(([key, node]) => [Number(key), node])),
        expanded: new Map([[1, 1]]),
        t,
      })
      const total = model.reduce((sum, row) => sum + row.height, 0)
      const spacer = collectElements(mini.tree()).find((el) => el.props?.style?.position === 'relative' && typeof el.props.style.height === 'string')
      expect(spacer, '虚拟列表必须有 spacer').toBeDefined()
      expect(spacer.props.style.height).toBe(`${total}px`)
      // 点悬浮条 ⇒ 收起这一档：三处入口全部消失
      again.props.onClick()
      mini.flush()
      expect(findByClass(mini.tree(), 'dsh-rt-collapse-hint-btn')).toBeUndefined()
      expect(textOf(mini.tree())).not.toContain(t('tree.collapse'))
      // 未展开态仍然只有折叠入口
      const folded = collectElements(mini.tree()).filter((el) => classOf(el).includes('dsh-rt-tree-btn'))
      expect(folded.length).toBe(1)
      expect(textOf(folded[0])).not.toContain(t('tree.collapse'))
    } finally {
      restore()
    }
  })

  it('悬浮条不参与行高：滚动后窗口仍然渲染得出行、且不抛（白屏类病根）', async () => {
    const { restore } = await mountLong()
    try {
      clickFold()
      for (const top of [0, 200, 800, 1400, 1601, 99999]) {
        expect(() => scrollTo(top)).not.toThrow()
        expect(collectElements(mini.tree()).some((el) => classOf(el).includes('dsh-rt-version'))).toBe(true)
      }
    } finally {
      restore()
    }
  })
})

describe('面板级错误边界：坏的是这一块，不是整页', () => {
  const Boom = () => { throw new Error('boom: 子组件渲染失败') }

  it('捕获子渲染错误：面板显示中文提示 + 重试按钮，外层存活', () => {
    mini.reset()
    const app = mini.react.createElement('div', { className: 'host-app' }, [
      mini.react.createElement('div', { className: 'host-other-panel' }, '宿主其他面板'),
      mini.react.createElement(client.RetraceErrorBoundary, { key: 'b', t }, mini.react.createElement(Boom)),
    ])
    mini.mount(app)
    expect(() => mini.flush()).not.toThrow()
    const rendered = mini.tree()
    const text = textOf(rendered)
    expect(text).toContain('宿主其他面板')                        // 外层没被连累
    expect(text).toContain(zh['view.errorTitle'])                 // 中文提示
    expect(text).toContain('boom: 子组件渲染失败')                 // 具体原因
    const retry = findByClass(rendered, 'dsh-rt-error-retry')
    expect(retry, '必须有重试按钮').toBeDefined()
    expect(textOf(retry)).toContain(zh['view.errorRetry'])
    // 点重试 ⇒ 边界清空错误并重新渲染（仍然抛 ⇒ 再次落到错误提示，不白屏）
    expect(() => { retry.props.onClick(); mini.flush() }).not.toThrow()
    expect(textOf(mini.tree())).toContain(zh['view.errorTitle'])
    expect(textOf(mini.tree())).toContain('宿主其他面板')
  })

  it('读档点视图被边界包着：视图抛错时宿主其他面板仍在（不会整页白）', () => {
    // 用一个一定会抛的“视图”替换真视图，确认装配位置正确
    const Broken = () => { throw new Error('view exploded') }
    mini.reset()
    const app = mini.react.createElement('div', { className: 'host-app' }, [
      mini.react.createElement('div', { className: 'host-other-panel' }, '宿主其他面板'),
      mini.react.createElement(client.RetraceErrorBoundary, { key: 'b', t }, mini.react.createElement(Broken)),
    ])
    mini.mount(app)
    expect(() => mini.flush()).not.toThrow()
    expect(textOf(mini.tree())).toContain(zh['view.errorTitle'])
    expect(textOf(mini.tree())).toContain('宿主其他面板')
  })

  it('注册处必须把视图包在边界里（源码守卫）', () => {
    const source = readFileSync(CLIENT_SOURCE_PATH, 'utf8')
    // One shared factory wraps every surface (2026-09-15 收尾).
    expect(source).toContain("}, withPanelBoundary(RetraceView, 'view.errorTitle')))")
    expect(source).toContain('const withPanelBoundary = (Component, titleKey) =>')
    expect(source).toContain('getDerivedStateFromError')
  })
})

afterAll(() => {
  if (originalDocument === undefined) delete globalThis.document
  if (originalWindow === undefined) delete globalThis.window
  globalThis.fetch = originalFetch
})
