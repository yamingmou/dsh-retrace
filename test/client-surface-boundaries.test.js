/**
 * dsh-retrace · test/client-surface-boundaries.test.js
 *
 * 2026-09-15 白屏事故的收尾：**每一个** React 注册面都要有自己的错误边界。
 *
 * 事故本身（读档点视图的 `setExpanded` updater 引用未绑定变量）已在
 * client-view-boundary.test.js 复现并锁死；这里锁"其余注册面"：
 *   ① 设置行（settings.general.item）
 *   ② 聊天节点行（conversation.chat.node：user-actions / retrace-reference / recall-marker）
 *   ③ 助手动作条（conversation.chat.assistant-actions）
 * 三处任何一处渲染期抛错，都不能把宿主整页打白 —— 必须只有那一处变成「提示 + 重试」。
 * 关闭守卫是 DOM 装配（非 React），等价保护是"装配失败就降级不装"，也在这里锁住。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { createMiniReact, collectElements, textOf, findByClass } from './mini-react.js'
import { zh } from '../lib/client.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLIENT_SOURCE_PATH = path.join(ROOT, 'lib', 'client.js')

// `apply` is already a module export of client.js (never re-export it).
const EXPORTS = ['RetraceView', 'RetraceErrorBoundary', 'withPanelBoundary']

let client
let mini
const originalDocument = globalThis.document
const originalWindow = globalThis.window
const originalFetch = globalThis.fetch

/**
 * Minimal DOM for `ensureStyle` (CSS injection) and the close-guard assembly:
 * enough of the element/window surface that neither needs jsdom.
 */
const domStub = ({ window: windowOverrides = {}, document: documentOverrides = {} } = {}) => {
  const makeElement = (tag) => ({
    tagName: String(tag).toUpperCase(),
    dataset: {},
    style: {},
    children: [],
    textContent: '',
    innerHTML: '',
    id: '',
    className: '',
    title: '',
    visibilityState: 'visible',
    setAttribute() {},
    removeAttribute() {},
    appendChild() {},
    removeChild() {},
    remove() {},
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => null,
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 }),
  })
  const document = {
    createElement: makeElement,
    createTextNode: (text) => ({ textContent: String(text) }),
    querySelector: () => null,
    getElementById: () => null,
    addEventListener() {},
    removeEventListener() {},
    head: makeElement('head'),
    body: makeElement('body'),
    visibilityState: 'visible',
    ...documentOverrides,
  }
  const window = {
    innerHeight: 900,
    addEventListener() {},
    removeEventListener() {},
    setInterval: () => 1,
    clearInterval() {},
    setTimeout: (fn) => { return 0 },
    clearTimeout() {},
    ...windowOverrides,
  }
  return { document, window }
}

beforeAll(async () => {
  if (globalThis.document === undefined || globalThis.window === undefined) {
    const stub = domStub()
    globalThis.document = stub.document
    globalThis.window = stub.window
  }
  const asJson = (value) => Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve(value) })
  globalThis.fetch = (url) => {
    const target = String(url)
    if (target.includes('/summaries')) return asJson({ ok: true, value: { enabled: false, sessionId: 's1', skipped: 0, error: null, records: [], tree: null } })
    if (target.includes('/versions')) return asJson({ ok: true, value: { enabled: true, versions: [], hostReplacementCount: 0 } })
    return asJson({ ok: true, value: null })
  }
  mini = createMiniReact()
  const source = readFileSync(CLIENT_SOURCE_PATH, 'utf8')
  for (const name of EXPORTS) {
    const declared = source.includes(`function ${name}(`) || source.includes(`class ${name} `) || source.includes(`const ${name} = `)
    expect(declared, `lib/client.js must declare ${name}`).toBe(true)
  }
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

afterAll(() => {
  if (originalDocument === undefined) delete globalThis.document
  if (originalWindow === undefined) delete globalThis.window
  globalThis.fetch = originalFetch
})

const t = (key, params) => {
  let text = zh[key] ?? key
  if (params) for (const [name, value] of Object.entries(params)) text = text.split(`{${name}}`).join(String(value))
  return text
}

/** Capture every slot registration the plugin makes (fake host ctx). */
const captureRegistered = () => {
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
  client.apply(ctx)
  return registered
}

const isBoundary = (type) => typeof type === 'function' && typeof type.getDerivedStateFromError === 'function'
const viewProps = {
  sessionId: 's1',
  useChat: () => undefined,
  useProjection: () => ({ versions: [], hostReplacementCount: 0 }),
  t,
  actions: {},
  store: {},
}
const mountApp = async (children) => {
  mini.reset()
  mini.mount(mini.react.createElement('div', { className: 'host-app' }, children))
  mini.flush()
  await new Promise((resolve) => setTimeout(resolve, 0))
  mini.flush()
  return mini.tree()
}

describe('每一个 React 注册面都由同一个边界包着', () => {
  const SURFACES = [
    ['conversation.chat.assistant-actions', undefined, 'panel.error.actions'],
    ['conversation.chat.node', 'user-actions', 'panel.error.userActions'],
    ['conversation.chat.node', 'retrace-reference', 'panel.error.reference'],
    ['conversation.chat.node', 'recall-marker', 'panel.error.marker'],
    ['conversation.view', 'retrace', 'view.errorTitle'],
    ['settings.general.item', undefined, 'panel.error.options'],
  ]

  it('六个注册面每一处都包着 RetraceErrorBoundary，且用的是同一个实现', () => {
    const registered = captureRegistered()
    const byName = (name, key) => registered.find(({ config }) => config.name === name
      && (key === undefined ? config.id !== undefined || config.key === undefined : config.key === key || config.id === key))
    const boundaryTypes = new Set()
    for (const [name, key, titleKey] of SURFACES) {
      const entry = byName(name, key)
      expect(entry, `registration for ${name}/${String(key)}`).toBeDefined()
      // The registered component must be the boundary-wrapped surface…
      const wrapped = entry.Component({ t })
      expect(isBoundary(wrapped.type), `${name} must be wrapped`).toBe(true)
      boundaryTypes.add(wrapped.type)
      // …and it must carry that surface's own title (not a generic one).
      expect(wrapped.props.title, `${name} title`).toBe(t(titleKey))
      // …with the real surface as its only child.
      const child = (wrapped.children ?? [])[0]
      expect(typeof child?.type).toBe('function')
    }
    // ONE boundary implementation for every surface (no copies).
    expect(boundaryTypes.size).toBe(1)
    expect([...boundaryTypes][0]).toBe(client.RetraceErrorBoundary)
  })

  it('withPanelBoundary 是唯一入口（源码守卫：注册处不再裸传组件）', () => {
    const source = readFileSync(CLIENT_SOURCE_PATH, 'utf8')
    for (const titleKey of ['panel.error.actions', 'panel.error.userActions', 'panel.error.reference', 'panel.error.marker', 'panel.error.options', 'view.errorTitle']) {
      expect(source, `missing withPanelBoundary(..., '${titleKey}')`).toContain(`'${titleKey}')`)
    }
    // every `ctx.slots.register(...)` must close with a wrapped component
    const bare = [...source.matchAll(/\}, (?!withPanelBoundary\()([A-Za-z]+)\)\)/g)].map((m) => m[1])
    expect(bare, `registered without a boundary: ${bare.join(', ')}`).toEqual([])
  })
})

describe('任一面渲染期抛错 ⇒ 只有那一面坏，宿主其他面照常', () => {
  const Boom = () => { throw new Error('surface exploded') }

  it('聊天节点标记面崩：对话主视图 / 设置面板 / 读档点都还在', async () => {
    const rendered = await mountApp([
      mini.react.createElement('div', { className: 'host-chat-view' }, '对话主视图'),
      // the failing surface, wrapped exactly like the registration wraps it
      client.withPanelBoundary(Boom, 'panel.error.marker')({ t }),
      // the REAL read-point view, wrapped by the same factory
      client.withPanelBoundary(client.RetraceView, 'view.errorTitle')({ key: 'view', ...viewProps }),
      mini.react.createElement('div', { className: 'host-settings' }, '设置面板'),
    ])
    const text = textOf(rendered)
    expect(text).toContain('对话主视图')
    expect(text).toContain('设置面板')
    expect(text).toContain(t('panel.error.marker'))          // 坏的那一面有提示
    expect(text).toContain(zh['view.errorHint'])             // 可操作提示
    expect(findByClass(rendered, 'dsh-rt-error-retry'), '必须有重试').toBeDefined()
    expect(text).not.toContain(zh['view.errorTitle'])        // 读档点没被连累
    expect(text).toContain(t('timeline.refresh'))            // 读档点仍在渲染自己的内容
    // 只有一处错误标题（坏的那一面）
    const titles = collectElements(rendered).filter((el) => String(el.props?.className ?? '').includes('dsh-rt-error-title'))
    expect(titles).toHaveLength(1)
  })

  it('读档点崩：设置行 / 聊天节点行 / 助手动作条都还在', async () => {
    const rendered = await mountApp([
      mini.react.createElement('div', { className: 'host-chat-view' }, '对话主视图'),
      client.withPanelBoundary(Boom, 'view.errorTitle')({ t }),
      client.withPanelBoundary(() => mini.react.createElement('span', null, '设置行内容'), 'panel.error.options')({ t }),
      client.withPanelBoundary(() => mini.react.createElement('span', null, '标记行内容'), 'panel.error.marker')({ t }),
      client.withPanelBoundary(() => mini.react.createElement('span', null, '动作条内容'), 'panel.error.actions')({ t }),
    ])
    const text = textOf(rendered)
    expect(text).toContain(t('view.errorTitle'))
    expect(text).toContain('对话主视图')
    expect(text).toContain('设置行内容')
    expect(text).toContain('标记行内容')
    expect(text).toContain('动作条内容')
    expect(text).not.toContain(t('panel.error.options'))
    expect(text).not.toContain(t('panel.error.marker'))
    expect(text).not.toContain(t('panel.error.actions'))
  })

  it('关掉边界 ⇒ 异常逃出整棵渲染（这正是白屏的机制）', () => {
    mini.reset()
    mini.mount(mini.react.createElement('div', null, [
      mini.react.createElement('div', null, '对话主视图'),
      mini.react.createElement(Boom),
    ]))
    expect(() => mini.flush()).toThrow(/surface exploded/)
  })
})

describe('关闭守卫是 DOM 装配（非 React）⇒ 装配失败必须降级而不是炸掉 apply', () => {
  it('installCloseGuard 抛错时 apply 仍然完成注册', () => {
    const registered = []
    const ctx = {
      effect: (fn) => { try { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} } catch { return () => {} } },
      locale: { register: () => () => {}, bind: () => (key) => key },
      get: () => undefined,
      inject: () => () => {},
      slots: {
        inject: (_seat, callback) => { callback(); return () => {} },
        register: (config, Component) => { registered.push({ config, Component }); return () => {} },
      },
    }
    // Make the GUARD's DOM assembly throw (its own window listener), leaving the
    // plugin's CSS injection untouched.
    const savedWindow = globalThis.window
    globalThis.window = domStub({
      window: { addEventListener: (type) => { if (type === 'beforeunload') throw new Error('dom exploded') } },
    }).window
    const warnings = []
    const savedWarn = console.warn
    console.warn = (line) => warnings.push(String(line))
    try {
      expect(() => client.apply(ctx)).not.toThrow()
    } finally {
      console.warn = savedWarn
      globalThis.window = savedWindow
    }
    // Every surface still registered (the client half is not lost to the guard).
    expect(registered.filter(({ config }) => config.name === 'conversation.view')).toHaveLength(1)
    expect(registered.filter(({ config }) => config.name === 'settings.general.item')).toHaveLength(1)
    expect(warnings.join(' ')).toContain('close guard unavailable')
  })

  it('源码守卫：关守卫的装配被 try/catch 包着（失败降级，不炸 apply）', () => {
    const source = readFileSync(CLIENT_SOURCE_PATH, 'utf8')
    expect(source).toContain('try {\n    disposeCloseGuard = installCloseGuard(t)\n  } catch (error) {')
    expect(source).toContain('close guard unavailable')
  })
})
