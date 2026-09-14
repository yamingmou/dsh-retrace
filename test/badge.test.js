/**
 * Session identity badge unit tests (2026-08-31).
 *
 * 短码 = 从 session id（唯一值）确定性导出：uuid → FNV-1a 64 → base36 → 10 位。
 * 铁律：同一 id 永远同码；不同 id 不同码；无状态纯函数；`session-` 前缀不影响。
 */
import { describe, it, expect } from 'vitest'
import { sessionBadge, uuidOf, fnv1a64, toBase36 } from '../lib/badge.js'

// 合成 uuid（重复字母 + 规律数字段，显然非真实会话）。
const U1 = 'aaaaaaaa-1111-4111-8111-111111111111'
const U1_NODASH = 'aaaaaaaa111141118111111111111111'
const U2 = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'
const U3 = 'cccccccc-3333-4333-8333-cccccccccccc'
const U4 = 'dddddddd-4444-4444-8444-dddddddddddd'
const U5 = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee'

describe('sessionBadge（唯一值 → 短码）', () => {
  it('同一 id 确定性：两次调用结果相同', () => {
    const id = U1
    expect(sessionBadge(id)).toBe(sessionBadge(id))
  })

  it('`session-` 前缀不影响（同一 uuid）', () => {
    expect(sessionBadge(`session-${U1}`)).toBe(sessionBadge(U1))
  })

  it('不同 id → 不同短码', () => {
    const a = sessionBadge(U1)
    const b = sessionBadge(U2)
    expect(a).not.toBe(b)
  })

  it('固定 10 位纯字母数字', () => {
    const ids = [U1, U2, U3, U4, U5]
    for (const id of ids) {
      const code = sessionBadge(id)
      expect(code).toMatch(/^[0-9a-z]{10}$/)
    }
  })

  it('空/无 uuid → 空串（调用方兜底）', () => {
    expect(sessionBadge('')).toBe('')
    expect(sessionBadge('not-a-session')).toBe('')
    expect(sessionBadge(undefined)).toBe('')
  })

  it('大小写不敏感（uuid 段统一小写）', () => {
    const upper = U1.toUpperCase()
    const lower = U1
    expect(sessionBadge(upper)).toBe(sessionBadge(lower))
  })
})

describe('辅助函数', () => {
  it('uuidOf 提取 uuid 段并去横线小写', () => {
    expect(uuidOf(`session-${U1}`)).toBe(U1_NODASH)
    expect(uuidOf(U1)).toBe(U1_NODASH)
  })

  it('fnv1a64 确定性 + 非零', () => {
    const h1 = fnv1a64(U1_NODASH)
    const h2 = fnv1a64(U1_NODASH)
    expect(h1).toBe(h2)
    expect(h1).not.toBe(0n)
  })

  it('toBase36 编码正确', () => {
    expect(toBase36(0n)).toBe('0')
    expect(toBase36(35n)).toBe('z')
    expect(toBase36(36n)).toBe('10')
    expect(toBase36(46655n)).toBe('zzz')
  })
})
