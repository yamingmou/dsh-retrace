/**
 * issue-200/issue-199 — client 操作失败文案映射。
 *
 * 修复前:client 只对 agent-busy 做本地化,其余 code 原样透传 host 英文
 * ("This message is no longer part of the active conversation.")——把「提交中
 * (文件 flush 滞后)」误报成「已不在活跃对话」,用户无法判断是 bug 还是可重试。
 * 修复后:code → 本地化(t 按 locale 取 zh/en);host 侧 message 已改中文与字典同源
 * (直接 import 断言防漂移);未映射 code 透传 host message(已中文则直接用)。
 */
import { describe, it, expect } from 'vitest'
import { zh, en, opFailureText } from '../lib/client.js'
import { SHADOWED_TARGET_MESSAGE, PENDING_TARGET_MESSAGE, SPAN_REPLAY_FAILED_MESSAGE, TARGET_NOT_FOUND_MESSAGE } from '../lib/host-core.js'

const tOf = (dict) => (key) => dict[key]

describe('client 操作失败文案(issue-200/199)', () => {
  it('message-pending → 中文「消息生成中,完成后可编辑」,不再透传 host 英文', () => {
    expect(opFailureText('message-pending', 'This message is no longer part of the active conversation.', tOf(zh)))
      .toBe(PENDING_TARGET_MESSAGE)
    // 字典与 host-core 文案同源(防两处漂移)
    expect(zh['error.messagePending']).toBe(PENDING_TARGET_MESSAGE)
    // 英文 locale 走英文文案(host 已是中文也不直接透传给英文用户)
    expect(opFailureText('message-pending', PENDING_TARGET_MESSAGE, tOf(en)))
      .toMatch(/still being generated/i)
  })

  it('target-shadowed → 折叠历史只读文案(展开后编辑/追加新消息指引),中英齐备', () => {
    expect(opFailureText('target-shadowed', 'This message is no longer part of the active conversation.', tOf(zh)))
      .toBe(SHADOWED_TARGET_MESSAGE)
    expect(zh['error.targetShadowed']).toBe(SHADOWED_TARGET_MESSAGE)
    expect(opFailureText('target-shadowed', SHADOWED_TARGET_MESSAGE, tOf(en)))
      .toMatch(/folded \(read-only\) history block/i)
  })

  it('agent-busy 仍映射 error.busy;未映射 code → 透传 host message(已中文直接用);无 message → error.generic', () => {
    const t = tOf(zh)
    expect(opFailureText('agent-busy', 'x', t)).toBe(zh['error.busy'])
    expect(opFailureText('no-text', 'host 中文文案', t)).toBe('host 中文文案')
    expect(opFailureText('session-not-found', 'session "s" not found', t)).toBe('session "s" not found')
    expect(opFailureText(undefined, null, t)).toBe(zh['error.generic'])
  })

  it('issue-229:message-not-found / span-replay-failed → 本地化(中英齐备,与 host 文案同源)', () => {
    expect(opFailureText('message-not-found', 'host 中文', tOf(zh))).toBe(TARGET_NOT_FOUND_MESSAGE)
    expect(zh['error.messageNotFound']).toBe(TARGET_NOT_FOUND_MESSAGE)
    expect(opFailureText('message-not-found', TARGET_NOT_FOUND_MESSAGE, tOf(en))).toMatch(/not in the session log/i)

    expect(opFailureText('span-replay-failed', 'host 中文', tOf(zh))).toBe(SPAN_REPLAY_FAILED_MESSAGE)
    expect(zh['error.spanReplayFailed']).toBe(SPAN_REPLAY_FAILED_MESSAGE)
    expect(opFailureText('span-replay-failed', SPAN_REPLAY_FAILED_MESSAGE, tOf(en))).toMatch(/internal error/i)

    // 契约违规:技术细节(契约名/期望/实际)只进日志,用户看通用文案
    expect(opFailureText('contract-violation', '契约违规[host-core.writeMarker.marker]:期望 …;实际 …', tOf(zh))).toBe(zh['error.generic'])
    expect(opFailureText('contract-violation', '契约违规[…]', tOf(en))).toBe(en['error.generic'])
  })

  it('字典键完整:en 与 zh 都含新 error 键(zh 为键集源头)', () => {
    for (const key of ['error.targetShadowed', 'error.messagePending', 'error.messageNotFound', 'error.spanReplayFailed']) {
      expect(typeof zh[key]).toBe('string')
      expect(typeof en[key]).toBe('string')
      expect(zh[key].length).toBeGreaterThan(0)
      expect(en[key].length).toBeGreaterThan(0)
    }
  })
})
