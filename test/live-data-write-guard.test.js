/**
 * "活家插件数据目录"护栏的**自检 / 阴性对照**。
 *
 * 事故背景：2026-09-19 短码表被测试覆盖成空表三次。这里证明三道防线不是摆设：
 *  ① 沙箱 ⇒ 事故原形（未传 dshHome）**解析不到活家**；
 *  ② fs 写护栏 ⇒ 硬编码活家路径被拦（并如实标注其已知限制）；
 *  ③ 金丝雀 ⇒ 真被改写时**整轮红**（用纯函数证明它会红）。
 */
import { describe, it, expect } from 'vitest'
import { writeFileSync, mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { __LIVE_DIRS, __SANDBOX, __REAL_DSH_HOME, __isLivePath } from './setup/forbid-live-data-writes.mjs'
import { changedSince, fingerprint, tableCandidates } from './global-setup.mjs'
import { pluginDataHome } from '../lib/platform/session-paths.js'

describe('护栏① 沙箱:$DSH_HOME 不指向活家', () => {
  it('测试进程里的 DSH_HOME 已被指向一次性临时沙箱', () => {
    expect(process.env.DSH_HOME).toBe(__SANDBOX)
    expect(__SANDBOX.startsWith(tmpdir())).toBe(true)
    expect(__SANDBOX).not.toBe(__REAL_DSH_HOME)
  })

  it('活家路径仍被正确识别(护栏不是一刀切)', () => {
    expect(__isLivePath(join(__LIVE_DIRS[0], 'codes.json'))).toBe(true)
    const tmp = mkdtempSync(join(tmpdir(), 'guard-ok-'))
    expect(__isLivePath(join(tmp, 'x.json'))).toBe(false)
    expect(() => writeFileSync(join(tmp, 'x.json'), 'ok')).not.toThrow()
    expect(existsSync(join(tmp, 'x.json'))).toBe(true)
  })
})

describe('护栏自检:事故原形(未传 dshHome)不再落到活家', () => {
  it('阴性对照:pluginDataHome({home}) 解析到沙箱,而不是活家', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'guard-bad-'))
    const dataHome = pluginDataHome({ home: tmp })          // ← 事故写法：不带 dshHome: null
    const liveBase = dirname(__LIVE_DIRS[0])
    // 关键断言:可能解析到沙箱(DSH_HOME 被沙箱化),但**绝不会**是活家
    expect(dataHome).not.toBe(liveBase)
    expect(__isLivePath(join(dataHome, 'dsh-retrace', 'codes.json'))).toBe(false)
  })

  it('fs 护栏对 require("node:fs") 路径生效:直接抛错且不留文件', () => {
    const cjsFs = createRequire(import.meta.url)('node:fs')
    const target = join(__LIVE_DIRS[0], '__guard-selfcheck__.json')
    let threw = false
    try { cjsFs.writeFileSync(target, 'boom') } catch { threw = true }
    // 万一护栏失效（回归），清掉残留的探针文件，绝不留垃圾在活家
    if (!threw && existsSync(target)) { try { cjsFs.unlinkSync(target) } catch { /* ignore */ } }
    expect(threw).toBe(true)
    expect(existsSync(target)).toBe(false)
  })

  it('如实记录已知限制:具名导入的拦截在 vitest worker 里可能不生效', () => {
    // 不是"通过",是**已知边界**:vitest worker 在本 setup 之前已 import 'node:fs',
    // ESM facade 已快照 ⇒ 改 fs.writeFileSync 对具名导入无效。真正兜底 = 沙箱(①)+金丝雀(③)。
    const src = readFileSync(new URL('./setup/forbid-live-data-writes.mjs', import.meta.url), 'utf8')
    expect(src).toContain('vitest worker 在本 setup 之前已经')
  })
})

describe('护栏③ 金丝雀:真有改写 ⇒ 整轮红(证明不是摆设)', () => {
  it('changedSince 对"sha 变了"给出改动项', () => {
    const dir = mkdtempSync(join(tmpdir(), 'canary-'))
    const f = join(dir, 'codes.json')
    writeFileSync(f, '{"codes":{}}\n')
    const before = [fingerprint(f)]
    writeFileSync(f, '{"codes":{"a":"abcdefghij"}}\n')
    const after = [fingerprint(f)]
    const changed = changedSince(before, after)
    expect(changed).toHaveLength(1)
    expect(changed[0].file).toBe(f)
    expect(changed[0].before.sha256).not.toBe(changed[0].after.sha256)
  })

  it('changedSince 对"没动"返回空(不误报)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'canary-ok-'))
    const f = join(dir, 'codes.json')
    writeFileSync(f, '{"codes":{}}\n')
    expect(changedSince([fingerprint(f)], [fingerprint(f)])).toEqual([])
  })

  it('金丝雀盯的就是活家表落点', () => {
    const cands = tableCandidates({ DSH_HOME: __REAL_DSH_HOME })
    expect(cands.some((c) => c.endsWith('/dsh-retrace/codes.json'))).toBe(true)
  })
})
