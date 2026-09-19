/**
 * 全轮**金丝雀**：跑测试前后比对"活家短码表"的指纹；**变了就整轮红**。
 *
 * 为什么需要它：`test/setup/forbid-live-data-writes.mjs` 的沙箱能保证"通过正常 API
 * 解析不到活家"，但挡不住有人**硬编码**活家路径。金丝雀是最后一道 fail-closed：
 * 只要有东西真的改写了活家表，这一轮测试立刻失败并指名文件，而不是让用户的数据悄悄没了。
 *
 * 只盯**短码表**（`codes.json` / 两代基座旁的旧落点）——它们是"只读数据"，
 * 插件稳态只读不写（源码一手），所以任何变化都必然是测试/工具写的。
 * 不盯整个 dsh-retrace 目录：里面 objects/snapshots 是运行中的 App 在正常写入的。
 */
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 可能被 badgeTableCandidates 命中的表落点（与 lib/platform/session-paths.js 同源）。 */
export function tableCandidates(env = process.env, home = os.homedir()) {
  const bases = []
  const dsh = env.DSH_HOME
  if (dsh && dsh.trim() !== '') bases.push(path.resolve(dsh === '~' ? home : dsh.replace(/^~(?=$|[/\\])/, home)))
  bases.push(path.join(home, 'dsh-v3'))
  bases.push(path.join(home, '.dsh'))
  const out = [...new Set(bases)].map((b) => path.join(b, 'dsh-retrace', 'codes.json'))
  out.push(path.join(home, '.dsh', '会话短码表.json'))
  out.push(path.join(home, 'dsh-v3', '会话短码表.json'))
  return [...new Set(out)]
}

/** 取一个文件的指纹（不存在 → missing）。 */
export function fingerprint(file) {
  try {
    const st = statSync(file)
    return { file, exists: true, size: st.size, mtimeMs: st.mtimeMs, sha256: createHash('sha256').update(readFileSync(file)).digest('hex') }
  } catch {
    return { file, exists: false, size: 0, mtimeMs: 0, sha256: null }
  }
}

/** 纯函数：比对两组指纹，返回"变了的文件"列表（便于单测证明金丝雀不是摆设）。 */
export function changedSince(before, after) {
  const byFile = new Map(after.map((f) => [f.file, f]))
  const changed = []
  for (const b of before) {
    const a = byFile.get(b.file)
    if (!a) continue
    if (a.exists !== b.exists || a.sha256 !== b.sha256) changed.push({ file: b.file, before: b, after: a })
  }
  return changed
}

let before = null
const REAL_DSH_HOME = process.env.DSH_HOME ?? null

export async function setup() {
  before = tableCandidates({ DSH_HOME: REAL_DSH_HOME }, os.homedir()).map(fingerprint)
}

export async function teardown() {
  if (before === null) return
  const after = tableCandidates({ DSH_HOME: REAL_DSH_HOME }, os.homedir()).map(fingerprint)
  const changed = changedSince(before, after)
  if (changed.length > 0) {
    const lines = changed.map((c) => `  ${c.file}\n    before: ${c.before.sha256 ?? '(missing)'}\n    after : ${c.after.sha256 ?? '(missing)'}`)
    process.stderr.write(
      `\n[test-guard] 活家短码表在本轮测试中被改写（fail-closed）：\n${lines.join('\n')}\n`
      + `  ⇒ 某个测试/工具写了活家数据目录。请改到临时目录（显式 { dshHome: null } 或 tmpRoot()）。\n`,
    )
    // vitest 的 globalSetup.teardown 抛错只会打一句 "error during close"，
    // **不会**让退出码非 0（实测）⇒ 金丝雀就成了摆设。这里显式把退出码置非 0，
    // 并用 process.exit(1) 兜底（安全跳闸优先于完整报告）。
    process.exitCode = 1
    process.exit(1)
  }
}
