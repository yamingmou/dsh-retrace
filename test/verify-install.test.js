/**
 * dsh-retrace · test/verify-install.test.js
 *
 * verify-install.mjs 版本比较逻辑测试（2026-08-31 发现：
 * ^0.x.y 分支忽略 patch 导致 0.3.2 vs ^0.3.6 报 PASS——事故场景漏网）。
 *
 * 通过提取脚本中的 satisfiesRange 函数体做纯函数测试（脚本本身无导出）。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const script = readFileSync(join(__dirname, '..', 'scripts', 'verify-install.mjs'), 'utf8')

// 提取 satisfiesRange 函数（脚本内定义，无导出）
const match = script.match(/function satisfiesRange[\s\S]*?\n}/)
if (!match) throw new Error('satisfiesRange 未在脚本中找到')
const satisfiesRange = new Function(`return (${match[0].replace(/^function/, 'function')})`)()

describe('verify-install satisfiesRange（版本范围匹配）', () => {
  it('^0.x.y 要求 minor 锁定 + patch >= 声明（0.x 时 patch 是兼容位）', () => {
    expect(satisfiesRange('0.3.6', '^0.3.6')).toBe(true)
    expect(satisfiesRange('0.3.7', '^0.3.6')).toBe(true)
    expect(satisfiesRange('0.4.11', '^0.4.11')).toBe(true)
    expect(satisfiesRange('0.4.12', '^0.4.11')).toBe(true)
  })

  it('^0.x.y 事故场景必须 FAIL（低 patch / 跨 minor 都不满足）', () => {
    // 2026-08-30 事故：web profile 停在 0.3.2，声明 ^0.3.6
    expect(satisfiesRange('0.3.2', '^0.3.6')).toBe(false)
    // 0.4.6 vs ^0.4.10 / 0.4.10 vs ^0.4.11（半装态）
    expect(satisfiesRange('0.4.6', '^0.4.10')).toBe(false)
    expect(satisfiesRange('0.4.10', '^0.4.11')).toBe(false)
    // 跨 minor
    expect(satisfiesRange('0.4.0', '^0.3.6')).toBe(false)
    expect(satisfiesRange('0.5.0', '^0.4.11')).toBe(false)
  })

  it('^1.x.y 语义：major 锁定，minor/patch >= 声明', () => {
    expect(satisfiesRange('1.2.3', '^1.2.3')).toBe(true)
    expect(satisfiesRange('1.3.0', '^1.2.3')).toBe(true)
    expect(satisfiesRange('1.2.2', '^1.2.3')).toBe(false)
    expect(satisfiesRange('2.0.0', '^1.2.3')).toBe(false)
  })

  it('~ 与精确版本', () => {
    expect(satisfiesRange('0.3.6', '~0.3.6')).toBe(true)
    expect(satisfiesRange('0.3.7', '~0.3.6')).toBe(true)
    expect(satisfiesRange('0.4.0', '~0.3.6')).toBe(false)
    expect(satisfiesRange('0.4.11', '0.4.11')).toBe(true)
    expect(satisfiesRange('0.4.12', '0.4.11')).toBe(false)
  })

  it('边界：未安装/空范围', () => {
    expect(satisfiesRange(null, '^0.3.6')).toBe(false)
    expect(satisfiesRange('0.3.6', '')).toBe(true)
    expect(satisfiesRange('0.3.6', null)).toBe(true)
  })
})

// 提取 discoverProfiles（脚本内定义，无导出）
const dMatch = script.match(/function discoverProfiles[\s\S]*?\n}/)
if (!dMatch) throw new Error('discoverProfiles 未在脚本中找到')

describe('verify-install discoverProfiles（profile 清单从磁盘发现）', () => {
  // 2026-09-14：清单原为硬编码 ['desktop','web','audit20260822']——旧 home 时代的入口名单。
  // 换到新基座（v3，只有 acp/desktop/web）后 audit20260822 必然缺失 ⇒ 每次校验一条假红 + exit 1。
  const discoverProfiles = new Function('fs', 'path', `return (${dMatch[0]})`)(
    { readdirSync, existsSync },
    { join },
  )

  it('发现真实存在的 profile，忽略 node_modules 与无 package.json 的目录', () => {
    const base = mkdtempSync(join(tmpdir(), 'vi-profiles-'))
    try {
      for (const p of ['acp', 'desktop', 'web']) {
        mkdirSync(join(base, p), { recursive: true })
        writeFileSync(join(base, p, 'package.json'), '{"name":"p"}')
      }
      mkdirSync(join(base, 'node_modules'), { recursive: true })
      writeFileSync(join(base, 'node_modules', 'package.json'), '{}')
      mkdirSync(join(base, 'scratch'), { recursive: true }) // 无 package.json
      mkdirSync(join(base, '.cache'), { recursive: true })
      expect(discoverProfiles(base)).toEqual(['acp', 'desktop', 'web'])
    } finally { rmSync(base, { recursive: true, force: true }) }
  })

  it('目录不存在 → 空数组（调用方报「至少发现一个 profile」失败，不是崩）', () => {
    expect(discoverProfiles(join(tmpdir(), 'vi-不存在-' + Date.now()))).toEqual([])
  })
})

describe('verify-install file: 相对挂载路径按 profile 目录解析（集成）', () => {
  // 2026-09-14：桌面 profile 的依赖写作 `file:../../../pkgs/<pkg>`。此前直接交给 cwd 解析
  // ⇒ 只有恰好从同深度目录运行才碰对，换个 cwd 一律误报「仓库不可读」。
  it('从**任意** cwd 运行都能解析相对的 file: 挂载并比对仓库版本', () => {
    const base = mkdtempSync(join(tmpdir(), 'vi-relmount-'))
    try {
      const profDir = join(base, 'home', 'profiles')
      const repoAbs = join(base, 'repo')
      mkdirSync(join(profDir, 'desktop', 'node_modules', 'dsh-retrace'), { recursive: true })
      mkdirSync(join(profDir, 'desktop', 'node_modules', 'dsh-log-contract'), { recursive: true })
      mkdirSync(repoAbs, { recursive: true })
      writeFileSync(join(repoAbs, 'package.json'), '{"name":"r","version":"9.9.9"}')
      // 相对层级：<base>/<platform>/profiles/desktop → ../../../repo = <base>/repo
      writeFileSync(join(profDir, 'desktop', 'package.json'), JSON.stringify({
        name: 'p', version: '0.0.0',
        dependencies: {
          'dsh-retrace': 'file:../../../repo',
          'dsh-log-contract': 'file:../../../repo',
        },
      }))
      for (const pkg of ['dsh-retrace', 'dsh-log-contract']) {
        writeFileSync(join(profDir, 'desktop', 'node_modules', pkg, 'package.json'),
          JSON.stringify({ name: pkg, version: '9.9.9' }))
      }
      const res = spawnSync(process.execPath,
        [join(__dirname, '..', 'scripts', 'verify-install.mjs'), '--profile-dir', profDir, '--gui-port', '1'],
        { encoding: 'utf8', cwd: tmpdir() }) // cwd 与两处都无关
      const out = (res.stdout || '') + (res.stderr || '')
      expect(out).toContain('✅ profile desktop dsh-retrace 本地挂载')
      expect(out).toContain('实装 9.9.9 = 仓库 9.9.9')
      expect(out).toContain('✅ profile desktop dsh-log-contract 本地挂载')
      expect(out).not.toContain('仓库 不可读')
    } finally { rmSync(base, { recursive: true, force: true }) }
  })
})
