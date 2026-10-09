/**
 * 结构历史闸门 · 机制测试
 *
 * 覆盖(与判据逐条对应):
 *   ① 版本一致性:标题声明的版本 == `package.json#version`,且 `CHANGELOG` 有该版行首条目;
 *   ② 结构真实性:release 提交零实现面变化 ⇒ 判红;`dev:` / `chore:` ⇒ 免判;正常改动 ⇒ 绿;
 *   ③ 时间线单调:author date 倒流 ⇒ 判红;
 *   ④ 身份合规:私人邮箱 ⇒ 判红且报告**脱敏**;项目自有身份 ⇒ 绿;
 *   ⑤ fail-closed:范围不可解析 / 不是 git 仓 ⇒ exit 2(绝不 exit 0);
 *   ⑥ `--selfcheck`:内置正例/反例全部符合期望 ⇒ exit 0。
 *
 * 纪律:测试**不抄**判据里的路径清单与身份白名单(两者都是 `check-history-public.mjs`
 * 的唯一来源),而是**真跑 CLI / 真造 git 仓 / 断言行为**。抄一份进测试 = 让两处各自漂移。
 * 全部用例都在临时目录里造小 git 仓,不碰本仓、不碰任何既有仓库。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const GATE = join(REPO, 'scripts', 'check-history-public.mjs')

/** 跑闸门(CLI,真子进程)。 */
function gate(args) {
  const r = spawnSync(process.execPath, [GATE, ...args], { encoding: 'utf8', cwd: REPO })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

/** 真跑 git;失败即抛(夹具出错必须炸,不能静默造出一个"看起来绿"的仓)。 */
function git(dir, args, env) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, ...(env ?? {}) } })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败:${(r.stderr ?? '').trim()}`)
  return r.stdout
}

/** 一个极小的 git 仓写入器。默认身份是白名单内的匿名地址。 */
function makeRepo(name) {
  const dir = join(BASE, name)
  mkdirSync(dir, { recursive: true })
  git(dir, ['init', '-q', '-b', 'main'])
  git(dir, ['config', 'user.name', 'Fixture Author'])
  git(dir, ['config', 'user.email', 'fixture@users.noreply.github.com'])
  return {
    dir,
    write(rel, text) {
      const p = join(dir, rel)
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, text)
    },
    commit(subject, { email = 'fixture@users.noreply.github.com', name = 'Fixture Author', date } = {}) {
      git(dir, ['add', '-A'])
      const env = {
        GIT_AUTHOR_NAME: name,
        GIT_AUTHOR_EMAIL: email,
        GIT_COMMITTER_NAME: name,
        GIT_COMMITTER_EMAIL: email,
        ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}),
      }
      git(dir, ['commit', '-q', '--allow-empty', '-m', subject], env)
    },
  }
}

/**
 * 造一份"版本一致"的配套文件。
 * `opts.changelogVersion`:把 `CHANGELOG` 头条版本压回更旧的版本(复现"卡住"形态)。
 * `opts.noImpl`:刻意不写实现文件(复现"只改版本号")。
 */
function releaseTree(version, note, { changelogVersion, noImpl = false, implRel = 'lib/widget.js', implText = 'export const widget = 1\n' } = {}) {
  const clv = changelogVersion ?? version
  const files = {
    'package.json': JSON.stringify({ name: 'fixture-widget', version }, null, 2) + '\n',
    'CHANGELOG.md': `# Changelog\n\n## [${clv}] — ${note}\n\n- ${note}\n`,
    'README.md': `# fixture-widget ${version}\n`,
  }
  if (!noImpl) files[implRel] = implText
  return files
}

/** 写入一组文件。 */
function writeAll(W, files) {
  for (const [rel, text] of Object.entries(files)) W.write(rel, text)
}

let BASE
beforeAll(() => { BASE = mkdtempSync(join(tmpdir(), 'history-public-test-')) })
afterAll(() => { rmSync(BASE, { recursive: true, force: true }) })

// ─────────────────────────────────────────────────────────────────────────────
describe('① 版本一致性(标题声明版本 == package.json#version,且 CHANGELOG 有条目)', () => {
  it('两版都对得上 ⇒ exit 0,JSON 报告零失败', () => {
    const W = makeRepo('v-ok')
    writeAll(W, releaseTree('0.4.1', '首个版本'))
    W.commit('release: 0.4.1 — 首个版本')
    writeAll(W, releaseTree('0.4.2', '第二个版本', { implText: 'export const widget = 1\nexport const extra = 2\n' }))
    W.commit('release: 0.4.2 — 第二个版本')

    const r = gate(['--repo', W.dir, '--range', 'HEAD'])
    expect(r.status, r.stdout + r.stderr).toBe(0)
    expect(r.stdout).toContain('全绿')

    const j = gate(['--repo', W.dir, '--range', 'HEAD', '--json'])
    expect(JSON.parse(j.stdout).failing).toEqual([])
  })

  it('CHANGELOG 里没有该版条目 ⇒ 判红,原因里点出"最高条目",并给 文件:行', () => {
    const W = makeRepo('v-stale-changelog')
    writeAll(W, releaseTree('0.4.1', '一'))
    W.commit('release: 0.4.1 — 一')
    // 第二个 release:package.json 升到 0.4.2,CHANGELOG 头条故意停在 0.4.1
    writeAll(W, releaseTree('0.4.2', '二', { changelogVersion: '0.4.1', implText: 'export const widget = 2\n' }))
    W.commit('release: 0.4.2 — 二')

    const r = gate(['--repo', W.dir, '--range', 'HEAD'])
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('CHANGELOG 里没有 0.4.2 的条目')
    expect(r.stdout).toMatch(/CHANGELOG\.md:\d+/)
    expect(r.stdout).toContain('0.4.1')
  })

  it('package.json#version 与标题声明不符 ⇒ 判红(两个值都打印)', () => {
    const W = makeRepo('v-mismatch-pkg')
    writeAll(W, releaseTree('0.4.1', '一'))
    W.commit('release: 0.4.1 — 一')
    const t = releaseTree('0.4.3', '二', { implText: 'export const widget = 2\n' })
    t['CHANGELOG.md'] = '# Changelog\n\n## [0.4.2] — 二\n\n- 二\n'
    writeAll(W, t)
    W.commit('release: 0.4.2 — 二')

    const r = gate(['--repo', W.dir, '--range', 'HEAD'])
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('标题声明 0.4.2,package.json#version = 0.4.3')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('② 结构真实性(release 提交必须动实现面;防"只改版本号")', () => {
  it('只改 package.json 的 release 提交 ⇒ 判红,JSON 里 implLines === 0 且 versionOnly === true', () => {
    const W = makeRepo('t-version-only')
    writeAll(W, releaseTree('0.4.1', '一'))
    W.commit('release: 0.4.1 — 一')
    writeAll(W, releaseTree('0.4.2', '二', { noImpl: true }))
    W.commit('release: 0.4.2 — 二')

    const r = gate(['--repo', W.dir, '--range', 'HEAD'])
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('零实现面变化')
    expect(r.stdout).toContain('只改版本号')
    expect(r.stdout).toContain('package.json')

    const j = JSON.parse(gate(['--repo', W.dir, '--range', 'HEAD', '--json']).stdout)
    const f = j.failing.find((x) => x.check === 'tree-authenticity')
    expect(f, '应在 tree-authenticity 判据上判红').toBeTruthy()
    expect(f.implLines).toBe(0)
    // versionOnly 的口径 = 全部改动文件都不属实现面(含"顺手改 README"这种伪装)
    expect(f.versionOnly).toBe(true)
  })

  it('"bump 版本号 + 顺手改 README"同样判红(文档不得冒充实现面)', () => {
    const W = makeRepo('t-doc-smuggling')
    writeAll(W, releaseTree('0.4.1', '一'))
    W.commit('release: 0.4.1 — 一')
    const t = releaseTree('0.4.2', '二', { noImpl: true })
    t['README.md'] = '# fixture-widget 0.4.2\n\n本次只调整了文档措辞。\n'
    writeAll(W, t)
    W.commit('release: 0.4.2 — 二')

    const r = gate(['--repo', W.dir, '--range', 'HEAD'])
    expect(r.status, r.stdout).toBe(1)
    expect(r.stdout).toContain('零实现面变化')
  })

  it('`dev:` 提交(零实现面变化)⇒ 免判,exit 0', () => {
    const W = makeRepo('t-dev-exempt')
    writeAll(W, releaseTree('0.4.1', '一'))
    W.commit('release: 0.4.1 — 一')
    W.write('NOTES.md', '记录:本轮只更新文档,无实现面变化。\n')
    W.commit('dev: 记录更新(无实现面变化)')

    const r = gate(['--repo', W.dir, '--range', 'HEAD'])
    expect(r.status, r.stdout).toBe(0)
  })

  it('`chore:` 提交(零实现面变化)⇒ 免判,exit 0', () => {
    const W = makeRepo('t-chore-exempt')
    writeAll(W, releaseTree('0.4.1', '一'))
    W.commit('release: 0.4.1 — 一')
    W.write('NOTES.md', '例行维护记录。\n')
    W.commit('chore: 例行维护(无实现面变化)')

    const r = gate(['--repo', W.dir, '--range', 'HEAD'])
    expect(r.status, r.stdout).toBe(0)
  })

  it('release 提交真的动了实现面 ⇒ 绿(不把正常提交误判成"只改版本号")', () => {
    const W = makeRepo('t-impl-ok')
    writeAll(W, releaseTree('0.4.1', '一'))
    W.commit('release: 0.4.1 — 一')
    writeAll(W, releaseTree('0.4.2', '二', { implText: 'export const widget = 1\nexport const extra = 2\n' }))
    W.commit('release: 0.4.2 — 二')
    expect(gate(['--repo', W.dir, '--range', 'HEAD']).status).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('③ 时间线单调(author date 非递减)', () => {
  it('author date 倒流 ⇒ 判红,并打印两个时间', () => {
    const W = makeRepo('tl-backwards')
    writeAll(W, releaseTree('0.4.1', '一'))
    W.commit('release: 0.4.1 — 一', { date: '2026-03-02T00:00:00+08:00' })
    writeAll(W, releaseTree('0.4.2', '二', { implText: 'export const widget = 2\n' }))
    W.commit('release: 0.4.2 — 二', { date: '2026-03-01T00:00:00+08:00' })

    const r = gate(['--repo', W.dir, '--range', 'HEAD'])
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('author date 倒流')
    expect(r.stdout).toContain('2026-03-01T00:00:00+08:00')
    expect(r.stdout).toContain('2026-03-02T00:00:00+08:00')
  })

  it('时间递增 ⇒ 绿', () => {
    const W = makeRepo('tl-forwards')
    writeAll(W, releaseTree('0.4.1', '一'))
    W.commit('release: 0.4.1 — 一', { date: '2026-03-01T00:00:00+08:00' })
    writeAll(W, releaseTree('0.4.2', '二', { implText: 'export const widget = 2\n' }))
    W.commit('release: 0.4.2 — 二', { date: '2026-03-02T00:00:00+08:00' })
    expect(gate(['--repo', W.dir, '--range', 'HEAD']).status).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('④ 身份合规(白名单 = 匿名平台地址 + 项目自有域名)', () => {
  it('私人邮箱(author 与 committer)⇒ 判红,且报告里**脱敏**', () => {
    const W = makeRepo('i-private')
    writeAll(W, releaseTree('0.4.1', '一'))
    W.commit('release: 0.4.1 — 一', { email: 'someone@gmail.com' })

    const r = gate(['--repo', W.dir, '--range', 'HEAD'])
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('不在身份白名单内')
    // 脱敏:完整私人邮箱不得原样出现在读数里
    expect(r.stdout).not.toContain('someone@gmail.com')
    expect(r.stdout).toContain('s***@gmail.com')
    // author 与 committer 各一条 ⇒ 2 条
    expect(r.stdout).toMatch(/author email 不在身份白名单内/)
    expect(r.stdout).toMatch(/committer email 不在身份白名单内/)
  })

  it('匿名平台地址 ⇒ 绿', () => {
    const W = makeRepo('i-noreply')
    writeAll(W, releaseTree('0.4.1', '一'))
    W.commit('release: 0.4.1 — 一', { email: 'alice@users.noreply.github.com' })
    expect(gate(['--repo', W.dir, '--range', 'HEAD']).status).toBe(0)
  })

  it('项目自有域名 contact@offerkuai.com ⇒ 绿(不得把发布主体判红)', () => {
    const W = makeRepo('i-project-domain')
    writeAll(W, releaseTree('0.4.1', '一'))
    W.commit('release: 0.4.1 — 一', { email: 'contact@offerkuai.com' })
    const r = gate(['--repo', W.dir, '--range', 'HEAD'])
    expect(r.status, r.stdout).toBe(0)
  })

  it('本机地址 dev@localhost ⇒ 判红(不在白名单内)', () => {
    const W = makeRepo('i-localhost')
    writeAll(W, releaseTree('0.4.1', '一'))
    W.commit('release: 0.4.1 — 一', { email: 'dev@localhost' })
    const r = gate(['--repo', W.dir, '--range', 'HEAD'])
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('不在身份白名单内')
  })

  it('第三方邮箱域名(163)⇒ 判红', () => {
    const W = makeRepo('i-163')
    writeAll(W, releaseTree('0.4.1', '一'))
    W.commit('release: 0.4.1 — 一', { email: 'someone@163.com' })
    const r = gate(['--repo', W.dir, '--range', 'HEAD'])
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('s***@163.com')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('⑤ fail-closed("看不懂"绝不等于"没问题")', () => {
  it('不存在的 range ⇒ exit 2 + 环境错,绝不 exit 0', () => {
    const W = makeRepo('bad-range')
    writeAll(W, releaseTree('0.4.1', '一'))
    W.commit('release: 0.4.1 — 一')
    const r = gate(['--repo', W.dir, '--range', 'no-such-ref..HEAD'])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('环境错')
  })

  it('不是 git 仓 ⇒ exit 2(不能静默"零失败")', () => {
    const dir = join(BASE, 'not-a-repo')
    mkdirSync(dir, { recursive: true })
    const r = gate(['--repo', dir, '--range', 'HEAD'])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('不是 git 仓')
  })

  it('未知参数 ⇒ exit 2', () => {
    const r = gate(['--no-such-flag'])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('用法错误')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('⑥ --selfcheck(四类各 1 正 1 反 + dev:/chore: 免判正例 + 私人邮箱反例)', () => {
  it('exit 0,且四类判据都出现在探针表里', () => {
    // 自检要真造十几个小 git 仓(每个 1–2 次提交)⇒ 默认 5s 会假超时。
    const r = gate(['--selfcheck'])
    expect(r.status, r.stdout + r.stderr).toBe(0)
    expect(r.stdout).toContain('selfcheck OK')
    for (const check of ['version-consistency', 'tree-authenticity', 'timeline-monotonic', 'identity-hygiene']) {
      expect(r.stdout, `自检缺 ${check} 的探针`).toContain(check)
    }
    expect(r.stdout).toContain('反例')
    expect(r.stdout).toContain('正例')
  }, 120_000)
})
