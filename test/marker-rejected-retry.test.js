/**
 * C 的回归保护:index.js `withFileSpan` 的「marker-rejected → 重探一次 → 只重试一次」。
 *
 * 真根因是**竞态**:遮蔽区间在 `ensureIdle` **之前**算(lib/index.js 开头的 probe
 * → host-core 的 `await ensureIdle`)。probe 时面尾 = 43843(assistant tool-call),
 * 轮次停下后 43845(tool/result)才落盘 ⇒ 已算好的区间把这一对拆开 ⇒ 守卫 W1 以
 * `marker-rejected` 拒写。修法:首次被拒 + 确有注入 span ⇒ 重新探一次区间,用**新**
 * span 重试**一次**(绝不循环)。
 *
 * 手法:真 `apply()`(假 ctx + 假 harness,与 test/badge-ops-e2e.test.js 同款)+
 * `vi.mock` 换掉 host-core.createEditorApi(得到可编程的 `api[op]`)+ `vi.spyOn`
 * 真 dshAdapter.spanProbeFromFile(index.js 持有同一对象引用 ⇒ 动态取到 spy)。
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => {
  // apply() 在 boot 时就抓住 api 对象 ⇒ 必须是**稳定引用**,方法体动态查 impl
  // (每个用例换一份 vi.fn() 仍能被 apply 时捕获的同一个 api 看到)。
  const impl = { recall: null, editAndResend: null, regenerate: null, fold: null }
  const api = {}
  for (const key of Object.keys(impl)) api[key] = (...args) => impl[key](...args)
  return { impl, api }
})
vi.mock('../lib/host-core.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, createEditorApi: () => h.api }
})

import { apply } from '../lib/index.js'
import { dshAdapter } from '../lib/adapter/dsh.js'

const SID = 'session-c-retry'

/** 假 ctx + 假 harness;与 test/badge-ops-e2e.test.js 的 bootEnvironment 同款。 */
function bootEnvironment() {
  const handles = new Map()
  const session = { id: SID, header: {}, events: [] }
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    effect: (fn) => { try { return fn() } catch { return () => {} } },
    get: (name) => {
      if (name === 'sessionTitle') return { rename: () => true }
      if (name === 'webServer') return ctx.webServer
      return undefined
    },
    on: () => () => {},
    inject: (deps, fn) => { try { return fn ? fn() : undefined } catch { return undefined } },
    set: () => {}, provide: () => {}, isolate: () => ctx, extend: () => ctx,
    sessions: { list: () => [session], values: () => [session], get: (id) => (id === SID ? session : undefined) },
    agents: { get: () => undefined, list: () => [] },
    webServer: { register: () => () => {} },
    fs: {}, subprocess: {}, sandboxPolicy: {}, jobs: {},
    locale: { register: () => () => {}, bind: () => (k) => k },
    slots: { register: () => () => {} },
  }
  const prevHarness = globalThis.harness
  globalThis.harness = { handle: (name, fn) => { handles.set(name, fn); return () => {} } }
  apply(ctx)
  return {
    handles,
    restore() {
      if (prevHarness === undefined) delete globalThis.harness; else globalThis.harness = prevHarness
    },
  }
}

const rejected = () => ({ ok: false, error: { code: 'marker-rejected', message: '悬空 tool' } })
const OK1 = { ok: true, value: { op: 'recall', seq: 1, shadowed: 1 } }
const OK2 = { ok: true, value: { op: 'recall', seq: 1, shadowed: 2 } }
const STALE = { status: 'ok', span: { start: 1, end: 1, shadowedSeqs: [1] }, prompt: null }
const FRESH = { status: 'ok', span: { start: 1, end: 2, shadowedSeqs: [1, 2] }, prompt: 'P' }

let env
let probe
let op

beforeAll(() => { env = bootEnvironment() })
afterEach(() => { vi.restoreAllMocks() })

beforeEach(() => {
  for (const key of Object.keys(h.impl)) h.impl[key] = vi.fn()
  op = env.handles.get('retrace.recall')
  expect(typeof op, 'retrace.recall 必须注册在 harness 上').toBe('function')
  probe = vi.spyOn(dshAdapter, 'spanProbeFromFile')
})

describe('C · marker-rejected 重探重试(只一次,绝不循环)', () => {
  it('①首次 marker-rejected + 重探得到新 span ⇒ 恰好重试 1 次且用新 span', async () => {
    probe.mockResolvedValueOnce(STALE).mockResolvedValueOnce(FRESH)
    h.impl.recall.mockResolvedValueOnce(rejected()).mockResolvedValueOnce(OK2)

    const result = await op({ sessionId: SID, messageId: 'u1' })

    expect(h.impl.recall).toHaveBeenCalledTimes(2)                 // 恰好一次重试
    expect(probe).toHaveBeenCalledTimes(2)                        // 恰好一次重探
    expect(h.impl.recall.mock.calls[0][0].span).toEqual(STALE.span)
    expect(h.impl.recall.mock.calls[1][0].span).toEqual(FRESH.span) // 用的是**新** span
    expect(h.impl.recall.mock.calls[1][0].messageId).toBe('u1')     // 其余实参原样
    expect(result).toEqual(OK2)                                   // 第二次结果原样返回
  })

  it('②首次成功 ⇒ 不重探、不重试', async () => {
    probe.mockResolvedValueOnce(STALE)
    h.impl.recall.mockResolvedValueOnce(OK1)

    const result = await op({ sessionId: SID, messageId: 'u1' })

    expect(result).toEqual(OK1)
    expect(h.impl.recall).toHaveBeenCalledTimes(1)
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('③首次失败但不是 marker-rejected(bad-scope)⇒ 不重探、不重试', async () => {
    probe.mockResolvedValueOnce(STALE)
    h.impl.recall.mockResolvedValueOnce({ ok: false, error: { code: 'bad-scope', message: 'x' } })

    const result = await op({ sessionId: SID, messageId: 'u1' })

    expect(result.error.code).toBe('bad-scope')
    expect(h.impl.recall).toHaveBeenCalledTimes(1)
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('④重试后仍 marker-rejected ⇒ 原样返回第二次结果,不再重试', async () => {
    probe.mockResolvedValueOnce(STALE).mockResolvedValueOnce(FRESH)
    h.impl.recall.mockResolvedValueOnce(rejected()).mockResolvedValueOnce(rejected())

    const result = await op({ sessionId: SID, messageId: 'u1' })

    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('marker-rejected')
    expect(h.impl.recall).toHaveBeenCalledTimes(2)   // 绝不进入第三次
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('⑤重探拿不到新 span(探针仍 miss)⇒ 不重试,原样返回第一次结果', async () => {
    probe.mockResolvedValueOnce(STALE).mockResolvedValueOnce({ status: 'not-found', span: null, facts: {} })
    h.impl.recall.mockResolvedValueOnce(rejected())

    const result = await op({ sessionId: SID, messageId: 'u1' })

    expect(result.error.code).toBe('marker-rejected')
    expect(h.impl.recall).toHaveBeenCalledTimes(1)
    expect(probe).toHaveBeenCalledTimes(2)          // 探了但没 span ⇒ 不重试
  })

  it('⑥重探抛错 ⇒ 不重试,原样返回第一次结果(包装层不把异常抛给上层)', async () => {
    probe.mockResolvedValueOnce(STALE).mockRejectedValueOnce(new Error('read failed'))
    h.impl.recall.mockResolvedValueOnce(rejected())

    const result = await op({ sessionId: SID, messageId: 'u1' })

    expect(result.error.code).toBe('marker-rejected')
    expect(h.impl.recall).toHaveBeenCalledTimes(1)
  })

  it('⑦regenerate 重试时带上新探到的 regeneratePrompt;editAndResend 同样接入', async () => {
    probe.mockResolvedValueOnce(STALE).mockResolvedValueOnce(FRESH)
    const regen = env.handles.get('retrace.regenerate')
    h.impl.regenerate.mockResolvedValueOnce(rejected()).mockResolvedValueOnce({ ok: true, value: { op: 'regenerate' } })

    const result = await regen({ sessionId: SID, messageId: 'u1' })

    expect(result.ok).toBe(true)
    expect(h.impl.regenerate).toHaveBeenCalledTimes(2)
    expect(h.impl.regenerate.mock.calls[1][0]).toMatchObject({ span: FRESH.span, regeneratePrompt: 'P' })
  })
})

describe('C · 探针调用形状(重探与首探同參数)', () => {
  it('recall 首探/重探都按 (sessionId, target, mode) 调用', async () => {
    probe.mockResolvedValueOnce(STALE).mockResolvedValueOnce(FRESH)
    h.impl.recall.mockResolvedValueOnce(rejected()).mockResolvedValueOnce(OK2)

    await op({ sessionId: SID, messageId: 'u1' })

    expect(probe.mock.calls[0].slice(0, 3)).toEqual([SID, 'u1', 'tail'])
    expect(probe.mock.calls[1].slice(0, 3)).toEqual([SID, 'u1', 'tail'])
  })
})
