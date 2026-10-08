/**
 * 2026-09-30(成员裁决)「编辑的主语义 = 从这条重开（重新编辑发送），后边是新的时间线分支」。
 *
 * 裁决原文：「现在编辑的时候有两个选项【只改这一条】【从这条重开】……我们只需要有重新
 * 开始这个概念（重新编辑发送）就可以啊——编辑肯定是重新开始——后边是新的时间线分支呀」。
 *
 * 因此本文件把三件事钉死（都是**行为面**断言，不是文案断言）：
 *  ① 编辑器里只有一个发送按钮，点击后发出的请求是 `fromScratch: true`（重开=新分支）；
 *  ② 「仅改文本（保留后续）」**只在**重开被守卫/写路径拒绝时，作为错误提示里的兜底动作
 *     出现（`error.rollbackGuide` 对应的 `rollback-guide` 等），点击后发 `fromScratch: false`；
 *     其他失败（agent-busy 等）不出现该兜底，且它永不与主按钮并列；
 *  ③ 设置面板不再有 `editFromScratch` 开关（i18n key 撤除 + 源码/两个派生件同步撤除，
 *     照 test/hide-always-on.test.js 的既有判据口径；CONFIG_DEFAULTS 字段与迁移逻辑保留）。
 *
 * 组件是**真的** lib/client.js：像 test/client-chat-hooks.test.js 一样，用 esbuild 把源码
 * 重新打包一次，`react` 换成 test/mini-react.js（有真 hook/渲染相位语义），再驱动
 * mount → click → flush → settle。这样测的就是磁盘上的实现，而不是它的副本。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { createMiniReact, collectElements, textOf } from './mini-react.js'
import { zh, en, isReopenBlocked } from '../lib/client.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLIENT_SOURCE_PATH = path.join(ROOT, 'lib', 'client.js')
const nodeRequire = createRequire(import.meta.url)

const tZh = (key, params) => {
  let text = zh[key] ?? key
  if (params) for (const [name, value] of Object.entries(params)) text = text.split(`{${name}}`).join(String(value))
  return text
}

/** Bundle lib/client.js with mini-react as `react`; returns { mini, client }. */
const buildInteractive = async (names) => {
  const mini = createMiniReact()
  const source = readFileSync(CLIENT_SOURCE_PATH, 'utf8')
  const bundled = await build({
    stdin: {
      contents: `${source}\nexport { ${names.join(', ')} }\n`,
      loader: 'js',
      resolveDir: path.dirname(CLIENT_SOURCE_PATH),
      sourcefile: 'client.js',
    },
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    write: false,
    external: ['react'],
    logLevel: 'silent',
  })
  const mod = { exports: {} }
  // eslint-disable-next-line no-new-func
  new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(
    (id) => (id === 'react' ? mini.react : nodeRequire(id)), mod, mod.exports,
  )
  return { mini, client: mod.exports }
}

const buttons = (mini, className) => collectElements(mini.tree())
  .filter((el) => el.type === 'button' && String(el.props?.className ?? '').includes(className))
const byClass = (mini, className) => collectElements(mini.tree())
  .find((el) => String(el.props?.className ?? '').includes(className))
const settle = async (mini) => {
  await new Promise((resolve) => setTimeout(resolve, 0))
  mini.flush()
}

/** One plugin pseudo-node (lib/client.js:userActionsDefinition), anchored at the message seq. */
const userActionsNode = (seq) => ({
  key: `u${seq}-actions`,
  kind: 'user-actions',
  anchorSeq: seq,
  data: { seq, time: 0, messageId: `u-u${seq}`, content: [{ type: 'text', text: `text ${seq}` }] },
})
const useChatFor = (node) => (selector) => selector({ nodes: new Map([[node.key, node]]), order: [node.key] })

const mountRow = (mini, client, node) => {
  mini.reset()
  mini.mount(mini.react.createElement('div', { className: 'host-app' }, mini.react.createElement(client.UserActionsRow, {
    node, sessionId: 's1', useChat: useChatFor(node), inputActions: {}, t: tZh,
  })))
  mini.flush()
}

/** 打开编辑器（点「编辑」chip），返回编辑器里的按钮。 */
const openEditor = (mini) => {
  const chip = buttons(mini, 'dsh-rt-chip').find((el) => el.props.title === tZh('action.edit'))
  expect(chip, '「编辑」chip 必须存在').toBeDefined()
  chip.props.onClick()
  mini.flush()
}

let wireOff = []
afterEach(() => { for (const off of wireOff) off(); wireOff = [] })
const installWire = (client, fn) => {
  client.__setMessageEditorWire(fn)
  wireOff.push(() => client.__setMessageEditorWire(null))
}

// ---------------------------------------------------------------------------
// ① 编辑的主语义 = 从这条重开（唯一的发送按钮 → fromScratch: true）
// ---------------------------------------------------------------------------
describe('编辑的主语义 = 从这条重开（重新编辑发送）', () => {
  it('编辑器只有一个发送按钮，且发出的是 fromScratch: true（新时间线分支）', async () => {
    const { mini, client } = await buildInteractive(['UserActionsRow'])
    const calls = []
    installWire(client, (op, payload) => {
      calls.push({ op, payload })
      return Promise.resolve({ ok: true, value: { resendMessageId: 'r1', originalText: 'text 5' } })
    })
    mountRow(mini, client, userActionsNode(5))
    openEditor(mini)

    const sendButtons = buttons(mini, 'dsh-rt-editor-send')
    // 旧版并列的第二枚（「只改这一条」）必须消失：编辑器里只剩一个发送按钮 + 取消。
    expect(sendButtons, '编辑器只许有一个发送按钮').toHaveLength(1)
    expect(textOf(sendButtons[0])).toBe(zh['action.sendFromHere'])
    expect(textOf(sendButtons[0])).not.toBe(zh['action.sendOnlyThis'])
    expect(sendButtons[0].props.title).toBe(zh['action.sendFromHereHint'])
    // 文案必须说清"本条及其后会被替换/隐藏 + 后续进入新的时间线分支"。
    expect(zh['action.sendFromHereHint']).toContain('本条及其后')
    expect(zh['action.sendFromHereHint']).toContain('新的时间线分支')
    expect(en['action.sendFromHereHint']).toMatch(/new timeline branch/i)

    sendButtons[0].props.onClick()
    mini.flush()
    await settle(mini)

    const edits = calls.filter((call) => call.op === 'editAndResend')
    expect(edits, '点发送恰好发一次 editAndResend').toHaveLength(1)
    expect(edits[0].payload).toMatchObject({ sessionId: 's1', messageId: 'u-u5', text: 'text 5', fromScratch: true })
    // 成功 ⇒ 编辑器关闭（正常路径不残留兜底入口）。
    expect(buttons(mini, 'dsh-rt-editor-send')).toHaveLength(0)
    expect(byClass(mini, 'dsh-rt-fallback-send')).toBeUndefined()
  })

  it('正常路径（未失败）永远不渲染兜底动作 —— 绝不与主按钮并列', async () => {
    const { mini, client } = await buildInteractive(['UserActionsRow'])
    installWire(client, () => Promise.resolve({ ok: true, value: {} }))
    mountRow(mini, client, userActionsNode(5))
    openEditor(mini)
    expect(byClass(mini, 'dsh-rt-error')).toBeUndefined()
    expect(byClass(mini, 'dsh-rt-fallback-send')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// ② 重开被守卫拒绝 ⇒ 错误提示里才出现「仅改文本（保留后续）」（点击=fromScratch: false）
// ---------------------------------------------------------------------------
describe('重开被拒 ⇒ 错误提示里的兜底动作「仅改文本（保留后续）」', () => {
  it('rollback-guide（error.rollbackGuide）⇒ 出现兜底；点击后发 fromScratch: false', async () => {
    const { mini, client } = await buildInteractive(['UserActionsRow'])
    const calls = []
    let guardFires = true
    installWire(client, (op, payload) => {
      calls.push({ op, payload })
      if (op !== 'editAndResend') return Promise.resolve({ ok: true, value: {} })
      if (payload.fromScratch === true && guardFires) {
        guardFires = false
        // host 侧真实形状（lib/host-core.js 的 op 信封 + lib/prewrite-guard.js:218）。
        return Promise.resolve({ ok: false, error: { code: 'rollback-guide', message: '本次改写范围属于极端回档（遮蔽 2200 个对话节点）' } })
      }
      return Promise.resolve({ ok: true, value: { resendMessageId: 'r2', originalText: 'text 5' } })
    })
    mountRow(mini, client, userActionsNode(5))
    openEditor(mini)
    buttons(mini, 'dsh-rt-editor-send')[0].props.onClick()
    mini.flush()
    await settle(mini)

    // ① 错误提示用的是 error.rollbackGuide（既有兜底语义仍然可达）。
    const error = byClass(mini, 'dsh-rt-error')
    expect(error, '失败必须有可见错误行').toBeDefined()
    expect(textOf(error)).toContain(tZh('error.rollbackGuide'))
    // ② 兜底动作在**错误行里**，不在编辑器按钮排里。
    const fallback = byClass(mini, 'dsh-rt-fallback-send')
    expect(fallback, '重开被守卫拒绝 ⇒ 必须给出「仅改文本（保留后续）」').toBeDefined()
    expect(textOf(fallback)).toBe(zh['action.sendOnlyThis'])
    expect(fallback.props.title).toBe(zh['action.sendOnlyThisHint'])
    expect(byClass(mini, 'dsh-rt-error-fallback')).toBeDefined()
    expect(textOf(byClass(mini, 'dsh-rt-error-fallback'))).toContain(tZh('action.reopenBlocked'))
    // 编辑器里仍然只有主按钮 + 取消（兜底不并列）。
    const editorButtons = collectElements(byClass(mini, 'dsh-rt-editor-buttons'))
      .filter((el) => el.type === 'button')
    expect(editorButtons.map((el) => textOf(el))).toEqual([zh['action.sendFromHere'], zh['action.cancel']])

    // ③ 点兜底 ⇒ 第二次请求 fromScratch: false（保留后续，不进新分支）。
    fallback.props.onClick()
    mini.flush()
    await settle(mini)
    const edits = calls.filter((call) => call.op === 'editAndResend')
    expect(edits).toHaveLength(2)
    expect(edits[0].payload.fromScratch).toBe(true)
    expect(edits[1].payload).toMatchObject({ sessionId: 's1', messageId: 'u-u5', text: 'text 5', fromScratch: false })
    // 成功 ⇒ 编辑器与兜底一起消失。
    expect(byClass(mini, 'dsh-rt-fallback-send')).toBeUndefined()
    expect(buttons(mini, 'dsh-rt-editor-send')).toHaveLength(0)
  })

  it('marker-rejected / span-replay-failed 同样给兜底；agent-busy 不给（不给用户再撞一次墙）', async () => {
    const { mini, client } = await buildInteractive(['UserActionsRow'])
    let code = 'marker-rejected'
    installWire(client, (op) => (op === 'editAndResend'
      ? Promise.resolve({ ok: false, error: { code, message: 'guard detail' } })
      : Promise.resolve({ ok: true, value: {} })))
    mountRow(mini, client, userActionsNode(5))
    openEditor(mini)

    for (const [nextCode, expected] of [['marker-rejected', true], ['span-replay-failed', true], ['agent-busy', false], ['target-shadowed', false]]) {
      code = nextCode
      buttons(mini, 'dsh-rt-editor-send')[0].props.onClick()
      mini.flush()
      await settle(mini)
      const fallback = byClass(mini, 'dsh-rt-fallback-send')
      if (expected) expect(fallback, `${nextCode} ⇒ 必须给兜底`).toBeDefined()
      else expect(fallback, `${nextCode} ⇒ 不该给兜底`).toBeUndefined()
      expect(byClass(mini, 'dsh-rt-error')).toBeDefined()
    }
    // 判定单一来源：`isReopenBlocked` 就是这条边界的唯一实现。
    expect(['rollback-guide', 'marker-rejected', 'span-replay-failed'].map(isReopenBlocked)).toEqual([true, true, true])
    expect(['agent-busy', 'target-shadowed', 'message-pending', 'message-not-found'].map(isReopenBlocked))
      .toEqual([false, false, false, false])
  })

  it('兜底动作自己失败 ⇒ 不再重复给兜底（避免死循环式建议，错误照常可见）', async () => {
    const { mini, client } = await buildInteractive(['UserActionsRow'])
    installWire(client, (op) => (op === 'editAndResend'
      ? Promise.resolve({ ok: false, error: { code: 'rollback-guide', message: 'guard' } })
      : Promise.resolve({ ok: true, value: {} })))
    mountRow(mini, client, userActionsNode(5))
    openEditor(mini)
    buttons(mini, 'dsh-rt-editor-send')[0].props.onClick()
    mini.flush()
    await settle(mini)
    const fallback = byClass(mini, 'dsh-rt-fallback-send')
    expect(fallback).toBeDefined()
    fallback.props.onClick()
    mini.flush()
    await settle(mini)
    expect(byClass(mini, 'dsh-rt-error'), '错误必须仍然可见').toBeDefined()
    expect(byClass(mini, 'dsh-rt-fallback-send'), '兜底失败后不再给同一枚按钮').toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// ③ 设置面板不再有 editFromScratch 开关（渲染面 + i18n key + 派生件同步）
// ---------------------------------------------------------------------------
describe('设置面板撤除 editFromScratch 开关（字段留 / UI 撤 / 判定不读）', () => {
  it('渲染面：OptionsRow 里不再出现该选项，其余开关照旧', async () => {
    const { mini, client } = await buildInteractive(['OptionsRow'])
    mini.reset()
    mini.mount(mini.react.createElement('div', { className: 'host-app' },
      mini.react.createElement(client.OptionsRow, { t: tZh })))
    mini.flush()
    const text = textOf(mini.tree())
    expect(text).toContain(tZh('options.showOriginalInput'))
    expect(text).not.toContain('options.editFromScratch')
    expect(text).not.toContain('editFromScratch')
    // 其余可配置项仍在（撤的是这一个开关，不是整个面板）。
    for (const key of ['options.versioning', 'options.summary', 'options.git', 'options.closeGuard', 'options.retention']) {
      expect(text, `${key} 必须仍在设置面板`).toContain(tZh(key))
    }
  })

  it('i18n：zh/en 成对撤除；字段仍在 CONFIG_DEFAULTS（照 hideShadowed 的既有处理）', () => {
    expect(zh['options.editFromScratch']).toBeUndefined()
    expect(en['options.editFromScratch']).toBeUndefined()
    // 新文案中英成对（兜底动作与后果预览必须两种语言都在）。
    for (const key of ['action.sendOnlyThis', 'action.sendOnlyThisHint', 'action.sendFromHere', 'action.sendFromHereHint', 'action.reopenBlocked', 'error.rollbackGuide']) {
      expect(typeof zh[key], `zh 缺 ${key}`).toBe('string')
      expect(typeof en[key], `en 缺 ${key}`).toBe('string')
    }
    const src = readFileSync(CLIENT_SOURCE_PATH, 'utf8')
    // 字段留 + 迁移不动（不删配置键，老配置照常迁移，只是不再参与判定）。
    expect(src).toContain('editFromScratch: CONFIG_DEFAULTS.editFromScratch')
    expect(src).toContain('editFromScratch: false')
    // 判定不读：编辑器不再有任何 config.editFromScratch 读取。
    expect(src).not.toContain('config.editFromScratch')
  })

  it('生成物与源码同步撤除（守住"改源码忘重建 bundle"的历史事故）', () => {
    const src = readFileSync(CLIENT_SOURCE_PATH, 'utf8')
    expect(src).not.toContain("'options.editFromScratch'")
    expect(src).not.toContain("toggle('editFromScratch')")
    for (const artifact of ['lib/client.bundle.js', 'lib/dynamic-client.js']) {
      const built = readFileSync(path.join(ROOT, artifact), 'utf8')
      expect(built, `${artifact} 未重新生成: 仍带旧开关的 i18n key`).not.toContain('options.editFromScratch')
      expect(built, `${artifact} 未重新生成: 仍带旧开关的绑定`).not.toContain('editFromScratch")')
      // 新主语义必须进了派生件（否则线上还是旧行为）。
      expect(built, `${artifact} 未重新生成: 缺少"从这条重开"主按钮实现`).toContain('sendFromHere')
      expect(built, `${artifact} 未重新生成: 缺少兜底判定`).toContain('rollback-guide')
    }
  })
})
