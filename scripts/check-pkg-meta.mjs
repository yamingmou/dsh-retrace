#!/usr/bin/env node
/**
 * 发布前元数据校验（2026-09-04）：package.json 的 repository / homepage / bugs
 * 必须指向当前仓库（github.com/yamingmou/<name>），不得残留旧账号 azmavethy。
 *
 * 事故背景：dsh-retrace 0.3.0 的 repository 曾指向 azmavethy/dsh-retrace
 * （旧 GitHub 账号，后注销 → 404 永久失效；npm 已发布版本元数据不可改）。
 * 本脚本防再犯：repository/homepage/bugs 任一写回旧名/写错 → 发布前即失败。
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
if (repo.includes('azmavethy')) {
  problems.push('repository 残留旧账号 azmavethy（已注销 → 404 永久失效）')
}

const homepage = pkg.homepage ?? ''
if (homepage && !homepage.includes(expectedPage)) {
  problems.push(`homepage 应指向 ${expectedPage}，实际 ${homepage}`)
}
if (homepage.includes('azmavethy')) {
  problems.push('homepage 残留旧账号 azmavethy')
}

const bugs = typeof pkg.bugs === 'string' ? pkg.bugs : (pkg.bugs?.url ?? '')
if (bugs && !bugs.includes(expectedPage)) {
  problems.push(`bugs 应指向 ${expectedPage}，实际 ${bugs}`)
}
if (bugs.includes('azmavethy')) {
  problems.push('bugs 残留旧账号 azmavethy')
}

if (problems.length > 0) {
  console.error(`❌ pkg-meta: ${name} 发布元数据校验失败:`)
  for (const p of problems) console.error(`   - ${p}`)
  process.exit(1)
}
console.log(`✅ pkg-meta: ${name} repository/homepage/bugs 均指向 yamingmou/${name}`)
