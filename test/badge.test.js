/**
 * Session identity badge unit tests (2026-08-31).
 *
 * 短码 = 从 session id（唯一值）确定性导出：uuid → FNV-1a 64 → base36 → 10 位。
 * 铁律：同一 id 永远同码；不同 id 不同码；无状态纯函数；`session-` 前缀不影响。
 */
import { describe, it, expect } from 'vitest'
import { sessionBadge, uuidOf, fnv1a64, toBase36 } from '../lib/badge.js'

describe('sessionBadge（唯一值 → 短码）', () => {
  it('同一 id 确定性：两次调用结果相同', () => {
    const id = 'session-aaaaaaaa-0003-4000-8000-000000000003'
    expect(sessionBadge(id)).toBe(sessionBadge(id))
  })

  it('`session-` 前缀不影响（同一 uuid）', () => {
    const uuid = 'aaaaaaaa-0003-4000-8000-000000000003'
    expect(sessionBadge(`session-${uuid}`)).toBe(sessionBadge(uuid))
  })

  it('不同 id → 不同短码', () => {
    const a = sessionBadge('session-aaaaaaaa-0003-4000-8000-000000000003')
    const b = sessionBadge('session-aaaaaaaa-0005-4000-8000-000000000005')
    expect(a).not.toBe(b)
  })

  it('固定 10 位纯字母数字', () => {
    const ids = [
      'session-aaaaaaaa-0003-4000-8000-000000000003',
      'session-aaaaaaaa-0005-4000-8000-000000000005',
      'session-aaaaaaaa-0002-4000-8000-000000000002',
      'session-aaaaaaaa-0001-4000-8000-000000000001',
      'session-aaaaaaaa-0004-4000-8000-000000000004',
    ]
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
    const upper = '668F9166-648C-4C4A-B07B-879340B78F41'
    const lower = 'aaaaaaaa-0003-4000-8000-000000000003'
    expect(sessionBadge(upper)).toBe(sessionBadge(lower))
  })
})

describe('辅助函数', () => {
  it('uuidOf 提取 uuid 段并去横线小写', () => {
    expect(uuidOf('session-aaaaaaaa-0003-4000-8000-000000000003')).toBe('5e551010648c4c4ab07b879340b78f41')
    expect(uuidOf('aaaaaaaa-0003-4000-8000-000000000003')).toBe('5e551010648c4c4ab07b879340b78f41')
  })

  it('fnv1a64 确定性 + 非零', () => {
    const h1 = fnv1a64('5e551010648c4c4ab07b879340b78f41')
    const h2 = fnv1a64('5e551010648c4c4ab07b879340b78f41')
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
