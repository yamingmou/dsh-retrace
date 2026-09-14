/**
 * 2026-09-14 事故 2 回归：会话 Definition 的注册入口。
 *
 * 现场：插件装好后客户端**没有编辑和撤回**。根因不是"服务名缺失"，而是**注册入口取错
 * 了一层**：当前基座的 `uiConversation`（UiConversation 类）把注册表挂在 `.events` 上，
 * 服务自身没有 `register`；官方调用点全是 `ctx.uiConversation.events.register(def)`。
 * 0.4.26 直接调 `service.register(...)` ⇒ 守卫 `typeof service.register === 'function'`
 * 恒 false ⇒ 四个 Definition 静默不注册 ⇒ user-actions 行 / marker 节点 / 编辑参考行
 * 全都不出现，而 boot 全绿。
 *
 * 本用例用假 ctx 跑**真** `apply`，把四条路径全部钉住：
 *   1. 新基座形态（入口在 `.events`）—— 旧实现这里是 0 次注册（红）
 *   2. 旧宿主形态（入口在服务自身）
 *   3. 两个服务都取不到（子 fiber 等待 + definitions=0 自报，不抛、不阻塞）
 *   4. 服务在但没有注册入口（必须留痕 source=…no-register-entry，不得静默）
 * 并检查自报行——它是宿主日志里"客户端半装载了 + 注册了几个定义/槽位"的唯一验收信号。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { apply, __setMessageEditorWire } from '../lib/client.js'

function makeCtx(services = {}) {
  const injectCalls = []
  const seats = []
  const effectLabels = []
  const ctx = {
    effect: (fn, label) => {
      effectLabels.push(label)
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    locale: { register: () => () => {}, bind: () => (key) => key },
    get: (name) => services[name],
    inject: (names, callback) => {
      injectCalls.push(names.join(','))
      callback({ get: (name) => services[name] })
      return () => {}
    },
    slots: {
      inject: (seat, callback) => {
        seats.push(seat)
        callback()
        return () => {}
      },
      register: () => () => {},
    },
  }
  return { ctx, injectCalls, seats, effectLabels }
}

const flushMicrotasks = async () => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

let reports
beforeEach(() => {
  reports = []
  __setMessageEditorWire((op, payload) => {
    reports.push({ op, payload })
    return Promise.resolve({ ok: true })
  })
})
afterEach(() => {
  __setMessageEditorWire(null)
})

describe('会话 Definition 注册入口（2026-09-14 事故 2 回归）', () => {
  it('新基座形态：入口在服务的 .events 上（服务自身没有 register）→ 四个 Definition 全部注册', async () => {
    const register = vi.fn(() => vi.fn())
    // 真实 UiConversation 的公开面：没有 register，只有 events/views/binding/…
    const uiConversation = { events: { register }, views: { register: vi.fn() }, bindings: new Map() }
    const { ctx, injectCalls } = makeCtx({ uiConversation })
    expect(() => apply(ctx)).not.toThrow()
    await flushMicrotasks()
    expect(injectCalls).toEqual([]) // 服务已在 ⇒ 不必等
    expect(register).toHaveBeenCalledTimes(4)
    expect(register.mock.calls.map((call) => call[0].kind)).toEqual([
      'retrace-actions',
      'retrace-reference',
      'recall-marker',
      'retrace-audit', // auditContextDefinition（读端审计上下文）
    ])
    expect(reports.at(-1)).toMatchObject({
      op: 'clientReport',
      payload: {
        id: 'dsh-retrace',
        inject: ['slots', 'locale'],
        definitions: 4,
        source: 'uiConversation.events',
        seats: 6,
        slots: 6,
      },
    })
  })

  it('旧宿主形态：入口在服务自身（conversationEvents）→ 同样注册四个 Definition', async () => {
    const register = vi.fn(() => vi.fn())
    const { ctx } = makeCtx({ conversationEvents: { register } })
    apply(ctx)
    await flushMicrotasks()
    expect(register).toHaveBeenCalledTimes(4)
    expect(reports.at(-1).payload).toMatchObject({ definitions: 4, source: 'conversationEvents.self' })
  })

  it('两个服务都取不到：走 ctx.inject 等待（不抛、不阻塞），并留下 definitions=0 的自报', async () => {
    const { ctx, injectCalls } = makeCtx()
    expect(() => apply(ctx)).not.toThrow()
    await flushMicrotasks()
    expect(injectCalls).toEqual(['uiConversation', 'conversationEvents'])
    expect(reports.at(-1).payload).toMatchObject({ definitions: 0, source: 'none' })
    // 静态 inject 里不含任何服务名（旧宿主会永久 pending ⇒ 整个 boot 失败）
    const { inject } = await import('../lib/client.js')
    expect(inject).toEqual(['slots', 'locale'])
  })

  it('服务在但没有注册入口：留痕 source=<name>.no-register-entry（不静默）', async () => {
    const { ctx } = makeCtx({ uiConversation: { views: {} } })
    apply(ctx)
    await flushMicrotasks()
    expect(reports.at(-1).payload).toMatchObject({
      definitions: 0,
      source: 'uiConversation.no-register-entry',
    })
  })

  it('每个 Definition 的 disposer 都挂进 ctx.effect（热重载不残留）', async () => {
    const disposers = []
    const register = vi.fn(() => {
      const dispose = vi.fn()
      disposers.push(dispose)
      return dispose
    })
    const { ctx, effectLabels } = makeCtx({ uiConversation: { events: { register } } })
    apply(ctx)
    await flushMicrotasks()
    expect(disposers).toHaveLength(4)
    expect(effectLabels).toContain('dsh-retrace: conversation definitions (uiConversation.events)')
    // ctx.effect 在 apply 里被立即展开一次（假 ctx 的 effect 会调 fn），拿到的 disposer
    // 必须逐个可调用且幂等。
    for (const dispose of disposers) expect(dispose).not.toHaveBeenCalled()
  })
})
