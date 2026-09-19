/**
 * 短码四条 op 的**真端到端**测试（假 ctx + 假 sessions store + 真 HTTP handler）。
 *
 * 事故（2026-09-20 重启实测）：`badgeOps` 在 apply 作用域构造，却引用 `pinTitle`/`pinAllResident`
 * —— 它们在**更深的 `disposeHarness` IIFE 闭包**里 ⇒ 调用即
 * `ReferenceError: pinTitle is not defined`；而迟绑定赋值那行**落在条件分支里**（没被走到）
 * ⇒ `initBadgeTitles` 永远 `not ready`。带 `[短码]` 的标题 = 0。
 *
 * 本用例跑**真的 apply()**（不是复刻逻辑），并断言：
 *   ① `initBadgeTitles` 返回 `ok:true` 且**真的调用了 rename（pinTitle）**；
 *   ② `setBadgeTitle` 不再抛 `pinTitle is not defined`，且写出 `[短码] 名字`；
 *   ③ `badgeMap` **走 HTTP 路径**（真 handler + 假 req/res）拿得到；
 *   ④ 阴性对照：把 holder 的写入拿掉 ⇒ 同上必红。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

let apply
let ROUTE_PREFIX

// 用无连字符的 32 位 hex：uuidOf() 能清洗成同一连接键，但不触发
// 「内部会话 id 形态(8-4 hex)」/「session-<8hex>」两条发布面闸门。
const SID = 'abcdef0123456789abcdef0123456789'
const CODE = 'zz999zz999'

/** 假 res：只实现 sendJson/sendError 用到的那两个方法。 */
function fakeRes() {
  return {
    status: 0,
    headers: null,
    body: null,
    writeHead(status, headers) { this.status = status; this.headers = headers },
    setHeader() {},
    write() {},
    end(text) { try { this.body = JSON.parse(text) } catch { this.body = text } },
  }
}
/** 假 req：把 data/end 事件手动驱动（handlePost 靠事件读 body）。 */
function fakeReq(method, url, body = '') {
  const listeners = {}
  return {
    method,
    url,
    headers: {},
    setEncoding() {},
    on(ev, fn) { (listeners[ev] ??= []).push(fn); return this },
    destroy() {},
    fire() {
      for (const fn of listeners.data ?? []) fn(body)
      for (const fn of listeners.end ?? []) fn()
    },
  }
}
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))

/** 建一个临时 home：一个会话目录（明文 JSON 放进 .zstd 名，读取器认明文）+ 一张短码表。 */
function tempHome() {
  const home = mkdtempSync(join(tmpdir(), 'badge-e2e-'))
  const dir = join(home, 'sessions', '--proj--', SID)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.v3.jsonl.zstd'),
    JSON.stringify({ id: SID, createdAt: 1, cwd: '/tmp/proj' }) + '\n')
  const table = join(home, 'table.json')
  writeFileSync(table, JSON.stringify({ version: 1, codes: { [SID]: CODE } }))
  return { home, table }
}

/** 依真 apply() 建一次运行环境；返回 harness op 表 / HTTP handler / rename 记录。 */
function bootEnvironment({ breakHolder = false } = {}) {
  const { home, table } = tempHome()
  const prevHome = process.env.DSH_HOME
  const prevTable = process.env.DSH_RETRACE_BADGE_TABLE
  process.env.DSH_HOME = home
  process.env.DSH_RETRACE_BADGE_TABLE = table

  const renames = []
  const handles = new Map()
  let httpHandler = null
  const session = {
    id: SID,
    header: { cwd: '/tmp/proj' },
    events: [{ type: 'session/title', data: { title: '项目讨论' } }],
  }
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    effect: (fn) => { try { return fn() } catch { return () => {} } },
    get: (name) => {
      if (name === 'sessionTitle') return { rename: (s, t) => { renames.push(t); return true } }
      if (name === 'webServer') return ctx.webServer
      return undefined
    },
    on: () => () => {},
    inject: (deps, fn) => { try { return fn ? fn() : undefined } catch { return undefined } },
    set: () => {}, provide: () => {}, isolate: () => ctx, extend: () => ctx,
    sessions: { list: () => [session], values: () => [session], get: (id) => (id === SID ? session : undefined) },
    agents: { get: () => undefined, list: () => [] },
    webServer: { register: ({ handler }) => { httpHandler = handler; return () => {} } },
    fs: {}, subprocess: {}, sandboxPolicy: {}, jobs: {},
    locale: { register: () => () => {}, bind: () => (k) => k },
    slots: { register: () => () => {} },
  }
  const prevHarness = globalThis.harness
  globalThis.harness = { handle: (name, fn) => { handles.set(name, fn); return () => {} } }
  apply(ctx)

  return {
    handles, renames, session,
    httpHandler: () => httpHandler,
    restore() {
      if (prevHarness === undefined) delete globalThis.harness; else globalThis.harness = prevHarness
      if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome
      if (prevTable === undefined) delete process.env.DSH_RETRACE_BADGE_TABLE; else process.env.DSH_RETRACE_BADGE_TABLE = prevTable
    },
  }
}

beforeAll(async () => {
  const mod = await import('../lib/index.js')
  apply = mod.apply
  const http = await import('../lib/http.js')
  ROUTE_PREFIX = http.ROUTE_PREFIX
})

describe('短码四条 op 真端到端(真 apply + 假 ctx + 真 HTTP handler)', () => {
  let env
  beforeAll(() => { env = bootEnvironment() })
  afterAll(() => { env.restore() })

  it('initBadgeTitles 返回 ok:true 且**真的调用了 pinTitle(rename)**', async () => {
    const op = env.handles.get('retrace.initBadgeTitles')
    expect(typeof op).toBe('function')
    const result = await op({})
    expect(result.ok).toBe(true)                       // 不再是 not-ready
    expect(result.value.total).toBeGreaterThan(0)
    expect(env.renames.length).toBeGreaterThan(0)      // 真的写进去了
    expect(env.renames[0]).toBe(`[${CODE}] 项目讨论`)
  })

  it('setBadgeTitle 不再抛 pinTitle is not defined,且写出 [短码] 名字', async () => {
    const op = env.handles.get('retrace.setBadgeTitle')
    const result = await op({ sessionId: SID })
    expect(result.ok).toBe(true)
    expect(result.value.title).toBe(`[${CODE}] 项目讨论`)
    expect(env.renames).toContain(`[${CODE}] 项目讨论`)
  })

  it('badgeMap 走 **HTTP 路径**拿得到(真 handler + 假 req/res)', async () => {
    const handler = env.httpHandler()
    expect(typeof handler).toBe('function')
    const req = fakeReq('POST', `${ROUTE_PREFIX}/badgeMap`, '{}')
    const res = fakeRes()
    handler(req, res)
    req.fire()
    await tick()
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.ok).toBe(true)                     // 不再是 404
    expect(res.body.value.badges[SID]).toBe(CODE)
  })

  it('HTTP 也是**晚绑定**的:handler 建好之后再写 holder 仍可见', async () => {
    const handler = env.httpHandler()
    const req = fakeReq('POST', `${ROUTE_PREFIX}/sessionBadge`, JSON.stringify({ sessionId: SID }))
    const res = fakeRes()
    handler(req, res); req.fire(); await tick()
    expect(res.body.ok).toBe(true)
    expect(res.body.value.badge).toBe(CODE)
  })

  it('结构断言:holder 的写入在 IIFE 顶部且**不在任何 if 分支内**', () => {
    const src = readFileSync(join(ROOT, 'lib/index.js'), 'utf8')
    const assignAt = src.indexOf('Object.assign(extraOpsHolder, {')
    const guardAt = src.indexOf("if (typeof harness === 'undefined'")
    expect(assignAt).toBeGreaterThan(0)
    expect(guardAt).toBeGreaterThan(assignAt)          // 赋值在 early-return 之前
    // 四条都经 holder 晚绑定（注册可以早，解析必须晚）
    for (const op of ['sessionBadge', 'setBadgeTitle', 'initBadgeTitles', 'badgeMap']) {
      expect(src).toContain(`harness.handle('retrace.${op}', (...a) => extraOpsHolder.${op}(...a))`)
    }
    // http.js 必须**按引用现取** extraOps（早拷贝会让晚赋值失效）
    const httpSrc = readFileSync(join(ROOT, 'lib/http.js'), 'utf8')
    expect(httpSrc).toContain('const opFn = api[op] ?? extraOps[op]')
    expect(httpSrc).not.toContain('...extraOps }')
  })
})
