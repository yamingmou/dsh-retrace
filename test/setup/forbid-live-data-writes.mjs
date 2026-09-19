/**
 * 测试进程的**结构性护栏**：测试期间永不使用真 `$DSH_HOME`，且把活家插件数据目录
 * 标为禁止写。
 *
 * 事故（2026-09-19，短码表被覆盖成空表 **三次**）：根因形态不是"某个测试忘了传参"，
 * 而是**整族**——`pluginDataHome()` 的契约是 `$DSH_HOME` 优先于显式 `home`
 * （与官方 resolveDshHome 逐字一致，有契约用例钉着），所以任何
 * `pluginDataHome({ home: tmp })`（不带 `dshHome: null`）在 `DSH_HOME=~/dsh-v3` 下
 * 都解析到**活家**，随后的 `writeFileSync` 就覆盖了用户真数据。
 * 逐个测试补参数治不了根：同一个坑在不同文件、不同 checkout（公开仓/投影树各一份）
 * 反复出现（实测第三次来自公开仓 `/tmp/another-checkout` 未修的副本）。
 *
 * 两道防线：
 *  ① **沙箱 `$DSH_HOME`**：bootstrap 把 env 指到一次性临时目录 ⇒
 *     `pluginDataHome()` 无论有没有 `dshHome: null`，都**解析不到活家**。
 *     这与"$DSH_HOME 优先"的契约**不冲突**（契约仍然成立，只是测试里的 env 不再是真活家）。
 *  ② **fs 写护栏**：即便有人硬编码活家路径，写尝试**立刻抛错**。
 *     ⚠️ 实测限制：vitest worker 在本 setup 之前已经 `import 'node:fs'`（facade 已快照），
 *     所以对**具名导入** `import { writeFileSync } from 'node:fs'` 的拦截可能不生效；
 *     它仍能拦住走 `require('node:fs')` / `fs.promises` 的路径。真正兜底的是 ① ＋
 *     `test/global-setup.mjs` 的**金丝雀**（跑完比对活家表 sha，变了就整轮红）。
 *
 * 逃生阀：`DSH_RETRACE_TEST_KEEP_DSH_HOME=1` 时不改 env（用于专门验证真 env 的场景）。
 */
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

const require_ = createRequire(import.meta.url)
const fs = require_('node:fs')

const REAL_DSH_HOME = process.env.DSH_HOME ?? null

/** 活家插件数据目录候选：$DSH_HOME 与两代基座（与 lib/platform/session-paths.js 同源）。 */
const LIVE_DIRS = (() => {
  const home = os.homedir()
  const bases = []
  if (REAL_DSH_HOME && REAL_DSH_HOME.trim() !== '') {
    bases.push(path.resolve(REAL_DSH_HOME === '~' ? home : REAL_DSH_HOME.replace(/^~(?=$|[/\\])/, home)))
  }
  bases.push(path.join(home, 'dsh-v3'))
  bases.push(path.join(home, '.dsh'))
  return [...new Set(bases)].map((base) => path.join(base, 'dsh-retrace'))
})()

// ── ① 沙箱 $DSH_HOME ────────────────────────────────────────────────────────
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-test-home-'))
if (process.env.DSH_RETRACE_TEST_KEEP_DSH_HOME !== '1') {
  process.env.DSH_HOME = SANDBOX
}

// ── ② fs 写护栏（尽力而为：见上面 ⚠️ 说明）────────────────────────────────
const liveHit = (target) => {
  const t = typeof target === 'string' ? target : (target && typeof target === 'object' && 'href' in target ? String(target.href) : null)
  if (t === null) return null
  let abs
  try { abs = path.resolve(t) } catch { return null }
  for (const dir of LIVE_DIRS) if (abs === dir || abs.startsWith(dir + path.sep)) return dir
  return null
}
const boom = (api, target) => {
  throw new Error(
    `[test-guard] 拒绝写活家插件数据目录：${api}(${target})\n`
    + `  活家目录：${LIVE_DIRS.join(' , ')}\n`
    + `  测试必须写临时目录：显式传 { dshHome: null }，或把目标建在 tmpRoot()/mkdtempSync() 下。`,
  )
}
for (const api of ['writeFileSync', 'appendFileSync', 'truncateSync', 'mkdirSync', 'rmdirSync',
  'rmSync', 'unlinkSync', 'copyFileSync', 'cpSync', 'chmodSync', 'chownSync', 'utimesSync',
  'createWriteStream', 'writeFile', 'appendFile']) {
  const original = fs[api]
  if (typeof original !== 'function') continue
  fs[api] = function guarded(target, ...rest) {
    if (liveHit(target)) boom(api, target)
    return original.call(this, target, ...rest)
  }
}
const WRITE_FLAGS = /[wa+]/
for (const api of ['openSync', 'open']) {
  const original = fs[api]
  if (typeof original !== 'function') continue
  fs[api] = function guarded(target, flags, ...rest) {
    let isWrite = false
    if (typeof flags === 'string') isWrite = WRITE_FLAGS.test(flags)
    else if (typeof flags === 'number') isWrite = (flags & 3) !== 0
    if (isWrite && liveHit(target)) boom(api, target)
    return original.call(this, target, flags, ...rest)
  }
}
for (const [api, idx] of [['renameSync', [0, 1]], ['linkSync', [0, 1]], ['symlinkSync', [1]]]) {
  const original = fs[api]
  if (typeof original !== 'function') continue
  fs[api] = function guarded(...args) {
    for (const i of idx) if (liveHit(args[i])) boom(`${api}(arg${i})`, args[i])
    return original.apply(this, args)
  }
}
if (fs.promises) {
  for (const api of ['writeFile', 'appendFile', 'mkdir', 'rm', 'rmdir', 'unlink', 'copyFile', 'cp', 'truncate']) {
    const original = fs.promises[api]
    if (typeof original !== 'function') continue
    fs.promises[api] = function guarded(target, ...rest) {
      if (liveHit(target)) boom(`promises.${api}`, target)
      return original.call(this, target, ...rest)
    }
  }
}

export const __LIVE_DIRS = LIVE_DIRS
export const __SANDBOX = SANDBOX
export const __REAL_DSH_HOME = REAL_DSH_HOME
export const __isLivePath = (p) => liveHit(p) !== null
