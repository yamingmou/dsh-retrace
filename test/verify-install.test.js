/**
 * dsh-retrace · test/verify-install.test.js
 *
 * verify-install.mjs 版本比较逻辑测试（2026-08-31 发现：
 * ^0.x.y 分支忽略 patch 导致 0.3.2 vs ^0.3.6 报 PASS——事故场景漏网）。
 *
 * 通过提取脚本中的 satisfiesRange 函数体做纯函数测试（脚本本身无导出）。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

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
