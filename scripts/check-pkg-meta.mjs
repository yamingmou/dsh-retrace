#!/usr/bin/env node
/**
 * 发布前元数据校验（2026-09-04，2026-09-10 改为正向白名单）：package.json 的
 * repository / homepage / bugs 必须指向**预期 owner** 的公开仓库
 * （github.com/yamingmou/<name>）。
 *
 * 事故背景：0.3.0 的 repository 曾指向一个后来注销的旧 GitHub 账号
 * （→ 404 永久失效；npm 已发布版本的元数据不可改）。
 * 本脚本防再犯：三个字段任一不匹配预期 owner → 发布前即失败（正向校验，
 * 不依赖任何具体的历史账号名）。
 *
 * 接入：prepublishOnly（发布必查）+ 可手动跑 `node scripts/check-pkg-meta.mjs`。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const name = pkg.name
const expectedRepo = `github.com/yamingmou/${name}.git`
const expectedPage = `github.com/yamingmou/${name}`

const problems = []

const repo = typeof pkg.repository === 'string' ? pkg.repository : (pkg.repository?.url ?? '')
if (!repo.includes(expectedRepo)) {
  problems.push(`repository 应为 ${expectedRepo}，实际 ${JSON.stringify(repo) || '(缺失)'}`)
}

const homepage = pkg.homepage ?? ''
if (homepage && !homepage.includes(expectedPage)) {
  problems.push(`homepage 应指向 ${expectedPage}，实际 ${homepage}`)
}

const bugs = typeof pkg.bugs === 'string' ? pkg.bugs : (pkg.bugs?.url ?? '')
if (bugs && !bugs.includes(expectedPage)) {
  problems.push(`bugs 应指向 ${expectedPage}，实际 ${bugs}`)
}

if (problems.length > 0) {
  console.error(`❌ pkg-meta: ${name} 发布元数据校验失败:`)
  for (const p of problems) console.error(`   - ${p}`)
  process.exit(1)
}
console.log(`✅ pkg-meta: ${name} repository/homepage/bugs 均指向 yamingmou/${name}`)
