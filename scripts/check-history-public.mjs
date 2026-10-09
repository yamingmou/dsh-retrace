#!/usr/bin/env node
const GITHUB_MERGE_EMAIL = /^noreply@github\.com$/i
/**
 * 结构历史闸门 · check-history-public.mjs
 *
 * 目的:让一棵公开仓库的提交历史**自证**四件事,判据全部可由 `git` 独立复算。
 *
 *   ① 版本一致性  `package.json#version` == 提交标题里声明的版本,
 *                 且 `CHANGELOG` 里有该版本的行首条目;
 *   ② 结构真实性  `release:` 提交必须真的改动实现面(防"只改版本号");
 *   ③ 时间线单调  按时间序重排后,author date 不得倒退;
 *   ④ 身份合规    author / committer 邮箱必须在项目自有身份白名单内。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 设计纪律(每条都能在代码里指到)
 *
 *   · **只读**:全部通过 `spawnSync('git', …)`,绝不写被检查的仓库。
 *   · **fail-closed**:
 *       - 范围解析不了 ⇒ exit 2(绝不把"看不懂"当成"零失败");
 *       - 实现面是**白名单**;白名单外、又无法归类到文档/派生件的路径 ⇒ 计入实现面
 *         (宁可多算,不可放过);
 *       - 不是 git 仓 ⇒ exit 2。
 *   · **判据自带正例/反例**(`--selfcheck`):每类至少 1 正 1 反,**反例必须真的判红**,
 *     且不得串味(同一条反例只能踩红本类判据)。假红比漏报更糟 —— 它会把人训练成
 *     "把闸门关掉"。
 *   · **本文件是公开件**:不含任何内部名录、内部路径、内部工具名。它不 import 任何
 *     其它规则文件 —— 判据就是本文件自身,单一来源。
 *
 * Usage:
 *   node scripts/check-history-public.mjs --repo <path> [--range <rev-range>]
 *                                         [--json] [--max-failures <n>]
 *                                         [--selfcheck] [--help]
 *
 * 默认: `--repo .` `--range origin/main..HEAD`
 * 退出码: 0 全绿 / 1 有失败 / 2 用法或环境错。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

// ─────────────────────────────────────────────────────────────────────────────
// 1. 判据常量
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **版本条目标题**:`## [0.4.32] — …` / `## 0.4.32 …`。
 * 不接受行内出现(必须行首 `##`)—— 否则正文里被提到的版本号会被误判成"有条目"。
 */
export const CHANGELOG_ENTRY = (v) => new RegExp(`^##\\s*\\[?${v.replace(/\./g, '\\.')}\\]?(?:\\s|$|—|-)`, 'm')

/** 标题里声明的版本:`release: 0.4.129 — …`(全角/半角破折号、冒号都收)。 */
export const SUBJECT_VERSION = /^\s*(?:release|版本)\s*[:：]\s*v?(\d+\.\d+\.\d+)/i

/** 标题类型:`release:` / `dev:` / `docs:` / `fix:` … */
export const SUBJECT_KIND = /^\s*([a-z][a-z0-9-]*)\s*(?:\([^)]*\))?\s*[:：]/i

/**
 * **不计入实现面的路径**(改了它们不算"真的改了东西"):
 *   - `package.json` / `CHANGELOG.md`:版本号与发布说明 —— 正是本判据要防的那种改动;
 *   - `pnpm-lock.yaml` / `pnpm-workspace.yaml`:可由依赖声明重算;
 *   - `*.bundle.js` / `lib/dynamic-*.js` / `lib/generated/**`:派生件,可由源文件重算。
 */
export const NON_IMPL_RE = [
  /^package\.json$/,
  /^CHANGELOG\.md$/,
  /^pnpm-lock\.yaml$/,
  /^pnpm-workspace\.yaml$/,
  /\.bundle\.js$/,
  /^lib\/dynamic-(?:client|host)\.js$/,
  /^lib\/generated\//,
]

/** 文档 / 元数据:改了它**不算**实现面变化(纯文本次于 `docs:` / `dev:` 提交承担)。 */
export const DOC_PATH_RE = /(?:^|\/)(?:README[^/]*|CHANGELOG[^/]*|LICENSE|HUMANS[^/]*)$|\.(?:md|markdown|txt|rst)$/i

/** 实现面**白名单目录**(改了它们才算"真的改了东西")。 */
export const IMPL_DIR_RE = /^(?:lib|bin|src|test|tests|scripts)\//

/**
 * 路径是否属"实现面"。
 * 白名单命中 ⇒ 是;文档 / 派生件 / 版本元数据 ⇒ 否;**其余未归类路径 ⇒ 是**(fail-closed)。
 */
export function isImplPath(p) {
  if (NON_IMPL_RE.some((re) => re.test(p))) return false
  if (DOC_PATH_RE.test(p)) return false
  if (IMPL_DIR_RE.test(p)) return true
  return true
}

/**
 * **不要求"必须动实现面"的提交类型**。
 *
 * 为什么收这三个:它们是**标题里显式声明过**的非发布提交。只改文档的 `docs:` 提交在语义上
 * 就该没有实现变化;把它判红 = 假红,会逼人往文档提交里塞代码。
 * `release:` 没有免判 —— 那正是本判据的靶心。
 */
export const EXEMPT_KINDS = new Set(['dev', 'docs', 'chore'])

/**
 * **身份白名单**(项目自有身份,逐条列名):
 *   · `*@users.noreply.github.com` —— 平台提供的匿名提交地址;
 *   · `contact@offerkuai.com`      —— 项目自有域名,公开面如实反映发布主体。
 * 其余(个人邮箱 / 第三方域名 / 本机地址)一律不在白名单内。
 */
// 允许:GitHub noreply(含 users.noreply 与平台自身 noreply@github.com,后者见于 squash-merge 提交)
//       + 项目自有联系邮箱(发布主体保持原样)
export const IDENTITY_ALLOW_RE = [/@users\.noreply\.github\.com$/i, /^noreply@github\.com$/i, /@offerkuai\.com$/i]

/** 某个 email 是否在项目自有身份白名单内。 */
export function isAllowedIdentity(email) {
  return typeof email === 'string' && email !== '' && IDENTITY_ALLOW_RE.some((re) => re.test(email))
}

/** 报告里**脱敏**:`someone@gmail.com` → `s***@gmail.com`(隐私读数不得原样落到日志)。 */
export function maskEmail(email) {
  return String(email).replace(/^(.).*(@.*)$/, '$1***$2')
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. git 只读读取
// ─────────────────────────────────────────────────────────────────────────────

/** 跑一条 git;失败抛错并带上 stderr(调用方决定是"环境错"还是"判红")。 */
export function git(repo, args, { allowFail = false } = {}) {
// GitHub 为 PR 生成的合并提交,其 committer 是 noreply@github.com(非 users.noreply)⇒ 视为合规
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 })
  if (r.error) throw new Error(`git 执行失败:${r.error.message}`)
  if (r.status !== 0 && !allowFail) {
    throw new Error(`git ${args.join(' ')} 退出码 ${r.status}:${(r.stderr ?? '').trim().split('\n').slice(0, 3).join(' | ')}`)
  }
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

const RS = '\x1e'
const US = '\x00'

/**
 * 读提交序列(**按 author date 排序**)。
 * 时间线单调这一条必须看"按时间排好的序列"才有意义;若按拓扑序查,rebase / cherry-pick
 * 之后的常见形态会假红。
 */
export function readCommits(repo, range) {
  const fmt = ['%H', '%ae', '%ce', '%aI', '%cI', '%s', '%B'].join('%x00') + '%x1e'
  const args = ['log', '--reverse', '--date-order', `--format=${fmt}`]
  if (range) args.push(range)
  const out = git(repo, args).stdout
  return out
    .split(RS)
    .map((chunk) => chunk.replace(/^\n+/, ''))
    .filter((chunk) => chunk.trim() !== '')
    .map((chunk) => {
      const f = chunk.split(US)
      const [sha, authorEmail, committerEmail, authorDate, committerDate, subject] = f
      const body = f.slice(6).join(US)
      return { sha, authorEmail, committerEmail, authorDate, committerDate, subject, body }
    })
}

/** 解析 `git diff --numstat -z` 输出。返回 `[{add, del, path, binary}]`。 */
export function parseNumstatZ(out) {
  const toks = out.split('\0').filter((t) => t !== '')
  const list = []
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/.exec(t)
    if (!m) continue
    let path = m[3]
    // 重命名/复制:`add\tdel\t\0old\0new\0` ⇒ 路径在后续两个 token 里
    if (path === '' && toks[i + 2] !== undefined) {
      path = toks[i + 2]
      i += 2
    }
    list.push({
      add: m[1] === '-' ? 0 : Number(m[1]),
      del: m[2] === '-' ? 0 : Number(m[2]),
      binary: m[1] === '-',
      path,
    })
  }
  return list
}

/**
 * 两提交的 numstat。
 *
 * `parent` 必须是 git 意义上的真父提交,不是"时间线上的前一个提交"(两者在 rebase /
 * cherry-pick / 跳范围时不同)。根提交不能写 `git diff --root`(那是 `git diff-tree`
 * 的选项,`git diff` 静默忽略它并返回空 diff)⇒ 根提交走 `diff-tree --root`。
 */
export function diffStat(repo, parent, child) {
  const out = parent
    ? git(repo, ['diff', '--numstat', '-z', '--no-renames', parent, child]).stdout
    : git(repo, ['diff-tree', '-r', '--numstat', '-z', '--no-renames', '--root', child]).stdout
  return parseNumstatZ(out)
}

/** `sha → 第一父提交` 映射(只读 git 的真实父边)。空字符串 = 根提交。 */
export function readParents(repo, range) {
  const args = ['rev-list', '--parents', '--no-merges']
  if (range) args.push(range)
  const out = git(repo, args).stdout
  const map = new Map()
  for (const line of out.split('\n')) {
    const t = line.trim().split(/\s+/).filter(Boolean)
    if (t.length === 0) continue
    map.set(t[0], t[1] ?? null)
  }
  return map
}

/** 取某个提交的某个文件(不存在返回 `null`)。 */
export function fileAt(repo, sha, path) {
  const r = git(repo, ['show', `${sha}:${path}`], { allowFail: true })
  return r.status === 0 ? r.stdout : null
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. 四类判据
// ─────────────────────────────────────────────────────────────────────────────

/** 失败条目:`文件:行 | 提交 | 判据 | 原因`。 */
function fail(commit, check, file, line, reason, extra = {}) {
  return { sha: commit.sha.slice(0, 10), subject: commit.subject.slice(0, 90), check, file, line, reason, ...extra }
}

export const CHECK_META = {
  'version-consistency': '版本一致性:package.json#version == 标题声明版本,且 CHANGELOG 里有该版行首条目',
  'tree-authenticity': '结构真实性:release 提交必须动实现面(防"只改版本号")',
  'timeline-monotonic': '时间线单调:author date 非递减(按时间序排序后)',
  'identity-hygiene': '身份合规:author/committer 邮箱必须在项目自有身份白名单内',
}

/**
 * 逐提交跑四类判据。
 * @param {{repo:string, range?:string}} opts
 */
export function checkHistory({ repo, range = 'origin/main..HEAD' } = {}) {
  const failing = []

  // 范围合法性(fail-closed:范围看不懂 ⇒ 环境错,不是"零失败")
  const rangeCheck = git(repo, ['rev-list', '--count', range], { allowFail: true })
  if (rangeCheck.status !== 0) {
    throw new Error(`范围 "${range}" 无法解析(git rev-list 退出码 ${rangeCheck.status}):${rangeCheck.stderr.trim().split('\n')[0]}`)
  }
  const declaredCount = Number(rangeCheck.stdout.trim())

  const commits = readCommits(repo, range)

  // diff 基准 = git 的真实第一父;时间线单调 = 排序后的前一个提交。两者刻意分开。
  const parentOf = readParents(repo, range)
  const prevByTime = (i) => (i === 0 ? null : commits[i - 1].sha)

  let releaseCount = 0
  let dateP = null

  commits.forEach((c, i) => {
    const parent = parentOf.has(c.sha) ? parentOf.get(c.sha) : prevByTime(i)
    const pkgRaw = fileAt(repo, c.sha, 'package.json')

    // ── ① 版本一致性 ────────────────────────────────────────────────────────
    const sv = SUBJECT_VERSION.exec(c.subject)?.[1] ?? null
    const kind = SUBJECT_KIND.exec(c.subject)?.[1]?.toLowerCase() ?? null
    let pkgVersion = null
    if (pkgRaw !== null) {
      try {
        pkgVersion = JSON.parse(pkgRaw).version ?? null
      } catch (err) {
        failing.push(fail(c, 'version-consistency', 'package.json', 0, `package.json 不是合法 JSON:${err.message}`))
      }
    }
    if (sv) {
      releaseCount++
      if (pkgVersion === null) {
        failing.push(fail(c, 'version-consistency', 'package.json', 0, `标题声明 ${sv},但该提交没有可解析的 package.json#version`))
      } else if (pkgVersion !== sv) {
        failing.push(fail(c, 'version-consistency', 'package.json', 0, `标题声明 ${sv},package.json#version = ${pkgVersion}`, { declared: sv, actual: pkgVersion }))
      }
      const cl = fileAt(repo, c.sha, 'CHANGELOG.md')
      if (cl === null) {
        failing.push(fail(c, 'version-consistency', 'CHANGELOG.md', 0, `标题声明 ${sv},但该提交没有 CHANGELOG.md`))
      } else {
        const lines = cl.split('\n')
        const hitLine = lines.findIndex((l) => CHANGELOG_ENTRY(sv).test(l))
        if (hitLine < 0) {
          const head = lines.findIndex((l) => /^##\s/.test(l))
          failing.push(
            fail(c, 'version-consistency', 'CHANGELOG.md', head >= 0 ? head + 1 : 1,
              `CHANGELOG 里没有 ${sv} 的条目(## [${sv}] 或 ## ${sv});该文件最高条目为 ${head >= 0 ? lines[head].trim().slice(0, 60) : '(无 ## 标题)'}`,
              { declared: sv, topHeading: head >= 0 ? lines[head].trim().slice(0, 80) : null }),
          )
        }
      }
    }

    // ── ② 结构真实性 ────────────────────────────────────────────────────────
    // 复算:`git -C <repo> diff --numstat <parent> <child>` 后按实现面白名单过滤,行数须 ≥ 1。
    let stat = []
    try {
      stat = diffStat(repo, parent, c.sha)
    } catch (err) {
      failing.push(fail(c, 'tree-authenticity', '-', 0, `无法读取相邻 diff(${err.message})`))
    }
    const impl = stat.filter((s) => isImplPath(s.path))
    const implLines = impl.reduce((a, s) => a + s.add + s.del, 0)
    const files = stat.map((s) => s.path)
    const versionOnly = files.length > 0 && files.every((f) => !isImplPath(f))
    const exempt = kind !== null && EXEMPT_KINDS.has(kind)
    const mustImplement = sv !== null || kind === 'release'
    if (mustImplement && implLines < 1 && !exempt) {
      failing.push(
        fail(c, 'tree-authenticity', files.length ? files.join(',') : '-', 0,
          `release 提交零实现面变化(实现面改动行数 = 0;全部改动 = [${files.join(', ') || '空 diff'}]${versionOnly ? ',即"只改版本号"' : ''})`,
          { implLines, changedFiles: files.slice(0, 20), versionOnly }),
      )
    }

    // ── ③ 时间线单调 ────────────────────────────────────────────────────────
    if (dateP !== null && c.authorDate < dateP) {
      failing.push(fail(c, 'timeline-monotonic', 'git log --format=%aI', 0,
        `author date 倒流:${c.authorDate} < 前一个提交 ${dateP}`,
        { authorDate: c.authorDate, previousAuthorDate: dateP }))
    }
    dateP = c.authorDate

    // ── ④ 身份合规 ──────────────────────────────────────────────────────────
    for (const [role, email] of [['author', c.authorEmail], ['committer', c.committerEmail]]) {
      if (!email) {
        failing.push(fail(c, 'identity-hygiene', 'git log --format=%ae/%ce', 0, `${role} email 为空`))
        continue
      }
      if (!isAllowedIdentity(email)) {
        // 读数额外说明"形态像私人邮箱"由外部工具判定;这里只给白名单结论 + 脱敏值。
        failing.push(fail(c, 'identity-hygiene', 'git log --format=%ae/%ce', 0,
          `${role} email 不在身份白名单内:${maskEmail(email)}`, { role }))
      }
    }
  })

  return {
    repo: resolve(repo),
    range,
    declaredCount,
    commitCount: commits.length,
    releaseCount,
    failing,
    firstCommit: commits[0]?.sha ?? null,
    lastCommit: commits[commits.length - 1]?.sha ?? null,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. 报告
// ─────────────────────────────────────────────────────────────────────────────

/** 失败按判据分组计数。 */
export function failureHistogram(failing) {
  const by = {}
  for (const f of failing) by[f.check] = (by[f.check] ?? 0) + 1
  return by
}

function renderReport(res, { maxFailures = 20 } = {}) {
  const L = []
  L.push(`结构历史闸门 | repo=${res.repo}`)
  L.push(`范围 ${res.range} | 提交 ${res.commitCount}(rev-list 计数 ${res.declaredCount})| release 提交 ${res.releaseCount}`)
  L.push('')
  if (res.failing.length === 0) {
    L.push('✅ 全绿:四类判据(版本一致性 / 结构真实性 / 时间线单调 / 身份合规)逐提交通过')
  } else {
    const hist = failureHistogram(res.failing)
    L.push(`❌ 失败 ${res.failing.length} 条,分布:`)
    for (const k of Object.keys(CHECK_META)) {
      L.push(`   ${k.padEnd(20)} ${String(hist[k] ?? 0).padStart(5)}   ${CHECK_META[k]}`)
    }
    L.push('')
    L.push(`前 ${Math.min(maxFailures, res.failing.length)} 条(格式 = 文件:行 | 提交 | 判据 | 原因):`)
    for (const f of res.failing.slice(0, maxFailures)) {
      L.push(`  ${f.file}:${f.line} | ${f.sha} | ${f.check} | ${f.reason}`)
      L.push(`      subject: ${f.subject}`)
    }
    if (res.failing.length > maxFailures) L.push(`  …(其余 ${res.failing.length - maxFailures} 条省略;--max-failures <n> 可调)`)
  }
  return L.join('\n')
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. `--selfcheck`:内置正例/反例,反例必须能红
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 造一份"版本一致"的配套文件(`package.json` / `CHANGELOG.md` / 实现文件)。
 * `implRel === null` ⇒ 刻意不写实现文件(复现"只改版本号")。
 */
function VOL(patch, note, implRel, implText, { changelogVersion } = {}) {
  const v = `0.4.${patch}`
  const clv = changelogVersion ?? v
  const older = []
  for (let p = 1; p < patch; p++) {
    if (`0.4.${p}` === clv) continue
    older.push(`## [0.4.${p}]`, '', `- 版本 0.4.${p}`, '')
  }
  const lines = ['# Changelog', '', `## [${clv}] — 本条说明`, '', `- ${note}`, '', ...older]
  const files = {
    'package.json': JSON.stringify({ name: 'selfcheck-fixture', version: v }, null, 2) + '\n',
    'CHANGELOG.md': lines.join('\n'),
  }
  if (implRel) files[implRel] = implText
  return files
}

const VOL1 = (note, implRel = 'lib/a.js') => VOL(1, note, implRel, 'export const a = 1\n')
const VOL2 = (note, implRel = 'lib/a.js', implText = 'export const a = 1\nexport const b = 2\n', opts = {}) => VOL(2, note, implRel, implText, opts)
const VOL2_VERSION_ONLY = (note, opts = {}) => VOL(2, note, null, null, opts)

export const SELFCHECK_PROBES = [
  // ── ① 版本一致性 ────────────────────────────────────────────────────────
  {
    id: 'SC-01-version-ok',
    check: 'version-consistency',
    expectFail: false,
    steps: [
      { files: VOL1('初始实现'), subject: 'release: 0.4.1 — 初始实现' },
      { files: VOL2('追加 b'), subject: 'release: 0.4.2 — 追加 b' },
    ],
  },
  {
    id: 'SC-02-version-stale-changelog',
    check: 'version-consistency',
    expectFail: true,
    steps: [
      { files: VOL1('初始实现'), subject: 'release: 0.4.1 — 初始实现' },
      // 标题声明 0.4.2、package.json 也写 0.4.2,但 CHANGELOG 头条故意停在 0.4.1
      { files: VOL2('追加 b', 'lib/a.js', 'export const a = 1\nexport const b = 2\n', { changelogVersion: '0.4.1' }), subject: 'release: 0.4.2 — 追加 b' },
    ],
  },

  // ── ② 结构真实性 ────────────────────────────────────────────────────────
  {
    id: 'SC-03-tree-ok',
    check: 'tree-authenticity',
    expectFail: false,
    steps: [
      { files: VOL1('初始实现'), subject: 'release: 0.4.1 — 初始实现' },
      { files: VOL2('追加 b'), subject: 'release: 0.4.2 — 追加 b' },
    ],
  },
  {
    id: 'SC-04-tree-version-only',
    check: 'tree-authenticity',
    expectFail: true,
    steps: [
      { files: VOL1('初始实现'), subject: 'release: 0.4.1 — 初始实现' },
      // 只改版本号 + CHANGELOG:零实现面变化
      { files: VOL2_VERSION_ONLY('追加 b'), subject: 'release: 0.4.2 — 追加 b' },
    ],
  },
  {
    // `dev:` 是标题里显式声明过的非发布提交 ⇒ 允许零实现面变化
    id: 'SC-04b-tree-dev-exempt',
    check: 'tree-authenticity',
    expectFail: false,
    steps: [
      { files: VOL1('初始实现'), subject: 'release: 0.4.1 — 初始实现' },
      { files: { 'NOTES.md': '开发记录\n' }, subject: 'dev: 记录更新(无实现面变化)' },
    ],
  },
  {
    id: 'SC-04c-tree-chore-exempt',
    check: 'tree-authenticity',
    expectFail: false,
    steps: [
      { files: VOL1('初始实现'), subject: 'release: 0.4.1 — 初始实现' },
      { files: { 'NOTES.md': '例行维护记录\n' }, subject: 'chore: 例行维护(无实现面变化)' },
    ],
  },
  {
    // 反例的"伪装形态":bump 版本号 + 顺手改一行文档 ⇒ 仍须判红
    id: 'SC-04d-tree-doc-smuggling',
    check: 'tree-authenticity',
    expectFail: true,
    steps: [
      { files: VOL1('初始实现'), subject: 'release: 0.4.1 — 初始实现' },
      { files: { ...VOL2_VERSION_ONLY('追加 b'), 'README.md': '# fixture 0.4.2\n\n本次只调整了文档措辞。\n' }, subject: 'release: 0.4.2 — 追加 b' },
    ],
  },

  // ── ③ 时间线单调 ────────────────────────────────────────────────────────
  {
    id: 'SC-05-timeline-ok',
    check: 'timeline-monotonic',
    expectFail: false,
    steps: [
      { files: VOL1('初始实现'), subject: 'release: 0.4.1 — 初始实现', date: '2026-01-01T00:00:00+08:00' },
      { files: VOL2('追加 b'), subject: 'release: 0.4.2 — 追加 b', date: '2026-01-02T00:00:00+08:00' },
    ],
  },
  {
    id: 'SC-06-timeline-backwards',
    check: 'timeline-monotonic',
    expectFail: true,
    steps: [
      { files: VOL1('初始实现'), subject: 'release: 0.4.1 — 初始实现', date: '2026-01-02T00:00:00+08:00' },
      // 第二个提交的 author date 早于第一个:重排历史很容易做出这种倒流
      { files: VOL2('追加 b'), subject: 'release: 0.4.2 — 追加 b', date: '2026-01-01T00:00:00+08:00' },
    ],
  },

  // ── ④ 身份合规 ──────────────────────────────────────────────────────────
  {
    id: 'SC-07-identity-noreply-ok',
    check: 'identity-hygiene',
    expectFail: false,
    steps: [
      { files: VOL1('初始实现'), subject: 'release: 0.4.1 — 初始实现', email: 'alice@users.noreply.github.com' },
    ],
  },
  {
    // 项目自有域名必须在白名单内:把项目自己的发布主体判红 = 假红
    id: 'SC-07b-identity-project-domain-ok',
    check: 'identity-hygiene',
    expectFail: false,
    steps: [
      { files: VOL1('初始实现'), subject: 'release: 0.4.1 — 初始实现', email: 'contact@offerkuai.com' },
    ],
  },
  {
    id: 'SC-08-identity-gmail',
    check: 'identity-hygiene',
    expectFail: true,
    steps: [
      { files: VOL1('初始实现'), subject: 'release: 0.4.1 — 初始实现', email: 'someone@gmail.com' },
    ],
  },
  {
    id: 'SC-08b-identity-qq',
    check: 'identity-hygiene',
    expectFail: true,
    steps: [
      { files: VOL1('初始实现'), subject: 'release: 0.4.1 — 初始实现', email: 'someone@qq.com' },
    ],
  },
  {
    id: 'SC-08c-identity-163',
    check: 'identity-hygiene',
    expectFail: true,
    steps: [
      { files: VOL1('初始实现'), subject: 'release: 0.4.1 — 初始实现', email: 'someone@163.com' },
    ],
  },
]

/** 一个极小的 git 仓写入器(供自检与测试复用)。 */
export function makeRepoWriter(dir) {
  mkdirSync(dir, { recursive: true })
  git(dir, ['init', '-q', '-b', 'main'])
  git(dir, ['config', 'user.name', 'Self Check'])
  git(dir, ['config', 'user.email', 'selfcheck@users.noreply.github.com'])
  return {
    dir,
    write(rel, text) {
      const p = join(dir, rel)
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, text)
    },
    commit(subject, { email = 'selfcheck@users.noreply.github.com', name = 'Self Check', date } = {}) {
      git(dir, ['add', '-A'])
      const env = { ...process.env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email }
      if (date) {
        env.GIT_AUTHOR_DATE = date
        env.GIT_COMMITTER_DATE = date
      }
      const r = spawnSync('git', ['-C', dir, 'commit', '-q', '--allow-empty', '-m', subject], { encoding: 'utf8', env })
      if (r.status !== 0) throw new Error(`自检夹具提交失败:${(r.stderr ?? '').trim()}`)
    },
  }
}

/**
 * 跑自检。每个探针独立仓 + 全量历史(`range = 'HEAD'`,根提交也走一遍)。
 * `ok=false` ⇒ 调用方 exit 1。
 */
export function runSelfCheck() {
  const base = mkdtempSync(join(tmpdir(), 'history-public-selfcheck-'))
  const rows = []
  try {
    for (const probe of SELFCHECK_PROBES) {
      const dir = join(base, probe.id)
      const W = makeRepoWriter(dir)
      try {
        for (const step of probe.steps) {
          for (const [rel, text] of Object.entries(step.files ?? {})) W.write(rel, text)
          W.commit(step.subject, { email: step.email ?? 'selfcheck@users.noreply.github.com', date: step.date })
        }
      } catch (err) {
        rows.push({ id: probe.id, check: probe.check, expectFail: probe.expectFail, ok: false, note: `夹具搭建失败:${err.message}` })
        continue
      }
      let res
      try {
        res = checkHistory({ repo: dir, range: 'HEAD' })
      } catch (err) {
        rows.push({ id: probe.id, check: probe.check, expectFail: probe.expectFail, ok: false, note: `运行异常:${err.message}` })
        continue
      }
      const own = res.failing.filter((f) => f.check === probe.check)
      const other = res.failing.filter((f) => f.check !== probe.check)
      const red = own.length > 0
      // 正例必须零失败;反例必须恰好踩红本类(串味按不通过处理 —— 串味会掩盖漏报)。
      const ok = probe.expectFail ? red && other.length === 0 : res.failing.length === 0
      const note = ok
        ? ''
        : probe.expectFail
          ? `反例未按预期判红:本类失败 ${own.length},他类失败 ${other.length}${other.length ? `(串味:${other.map((f) => f.check).join(',')})` : '(漏报)'}`
          : `正例被判红(假红):${res.failing.slice(0, 2).map((f) => `${f.check}:${f.reason}`).join(' / ')}`
      rows.push({
        id: probe.id,
        check: probe.check,
        expectFail: probe.expectFail,
        got: red ? 'red' : 'green',
        ownFails: own.length,
        otherFails: other.length,
        ok,
        note,
      })
    }
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
  return { ok: rows.every((r) => r.ok), rows }
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. CLI
// ─────────────────────────────────────────────────────────────────────────────

const HELP = `结构历史闸门 · 逐提交断言一棵公开历史的四项结构事实

Usage:
  node scripts/check-history-public.mjs --repo <path> [--range <rev-range>]
                                        [--json] [--max-failures <n>]
                                        [--selfcheck] [--help]

判据(四类,逐提交):
  ① version-consistency  package.json#version == 标题声明版本,且 CHANGELOG 里有该版行首条目
  ② tree-authenticity    release: 提交必须动实现面(≥1 行);dev:/docs:/chore: 免判
  ③ timeline-monotonic   author date 非递减(按时间序排序后判定)
  ④ identity-hygiene     author/committer 邮箱必须在项目自有身份白名单内
                         (*@users.noreply.github.com / contact@offerkuai.com),其余判红并脱敏

默认: --repo . --range origin/main..HEAD
退出码: 0 全绿 / 1 有失败(或自检不符期望)/ 2 用法或环境错

--selfcheck 内置正例/反例:四类各 1 正 1 反,外加 dev:/chore: 免判正例与私人邮箱反例。
`

function parseArgs(argv) {
  const out = { repo: process.cwd(), range: 'origin/main..HEAD', json: false, selfcheck: false, help: false, maxFailures: 20 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--repo') out.repo = argv[++i]
    else if (a === '--range') out.range = argv[++i]
    else if (a === '--max-failures') out.maxFailures = Number(argv[++i])
    else if (a === '--json') out.json = true
    else if (a === '--selfcheck') out.selfcheck = true
    else if (a === '--help' || a === '-h') out.help = true
    else throw new Error(`未知参数:${a}`)
  }
  if (!Number.isFinite(out.maxFailures) || out.maxFailures < 1) out.maxFailures = 20
  return out
}

function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(`用法错误:${err.message}\n\n${HELP}`)
    process.exit(2)
  }
  if (args.help) {
    console.log(HELP)
    process.exit(0)
  }

  if (args.selfcheck) {
    const { ok, rows } = runSelfCheck()
    console.log('结构历史闸门 · --selfcheck(内置正例/反例,反例必须能红)')
    for (const r of rows) {
      const tag = r.expectFail ? '反例' : '正例'
      console.log(`  ${r.ok ? '✅' : '❌'} ${r.id.padEnd(34)} ${r.check.padEnd(20)} ${tag} → 实测 ${r.got ?? '?'}(本类失败 ${r.ownFails ?? '-'},他类 ${r.otherFails ?? '-'})${r.note ? ' ｜ ' + r.note : ''}`)
    }
    const bad = rows.filter((r) => !r.ok)
    console.log(bad.length === 0 ? `\n✅ selfcheck OK:${rows.length} 个探针全部符合期望(正例绿 / 反例红)` : `\n❌ selfcheck 失败:${bad.length}/${rows.length}`)
    process.exit(ok ? 0 : 1)
  }

  if (!existsSync(join(args.repo, '.git'))) {
    console.error(`环境错:${resolve(args.repo)} 不是 git 仓(缺 .git)`)
    process.exit(2)
  }

  let res
  try {
    res = checkHistory({ repo: args.repo, range: args.range })
  } catch (err) {
    console.error(`环境错:${err.message}`)
    process.exit(2)
  }

  if (args.json) {
    console.log(JSON.stringify({ ...res, histogram: failureHistogram(res.failing), maxFailures: args.maxFailures }, null, 2))
  } else {
    console.log(renderReport(res, { maxFailures: args.maxFailures }))
  }
  process.exit(res.failing.length === 0 ? 0 : 1)
}

// 只在直接执行时跑 main(被 import 时不跑 —— 测试要 import 判据函数)。
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (invokedDirectly) {
  try {
    main()
  } catch (err) {
    console.error(`未捕获错误:${err?.stack ?? err}`)
    process.exit(2)
  }
}
