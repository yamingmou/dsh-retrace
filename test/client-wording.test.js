/**
 * 2026-10-08(既定口径·文案)——
 *   「按钮文案需要修改，编辑就应该是"重发"。撤回不需要展示归档就用"撤回"」
 *
 * 三件都钉**行为面/字面**两处:
 *  ① 编辑入口 = 「重发」:按钮文字、title、编辑器 aria 与发送按钮(text/title)一致改口径
 *     "重发＝本条及其后重开"(zh/en 成对);
 *  ② 撤回相关文案**不再出现"归档"**:marker 正文(`TRACE_TEXT`,进模型上下文的留痕)、
 *     二次确认描述、确认按钮(原来是「撤回并归档」);
 *  ③ 旧文案的**读端**识别不许跟着一起改:历史日志里已经写着旧串,summary-gate 的占位判据
 *     必须继续认它(test/summary-gate.test.js 已有用例,这里补一条同步守卫)。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { createMiniReact, collectElements, textOf } from './mini-react.js'
import { zh, en } from '../lib/client.js'
import { TRACE_TEXT } from '../lib/marker-carrier.js'
import { isPlaceholderText } from '../lib/summary-gate.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLIENT_SOURCE_PATH = path.join(ROOT, 'lib', 'client.js')
const nodeRequire = createRequire(import.meta.url)
const tZh = (key) => zh[key] ?? key

/** 历史版本写进日志的旧留痕文案(读端必须继续认它)。 */
const HISTORICAL_TRACE_TEXT = '（此处内容已被撤回：原消息已归档，可在恢复视图中查看）'

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

// ---------------------------------------------------------------------------
// ① 编辑入口 = 「重发」(按钮真渲染 + title/aria/hint 同口径)
// ---------------------------------------------------------------------------
describe('① 编辑按钮文案 = 「重发」', () => {
  it('字典字面(zh/en 成对)', () => {
    expect(zh['action.edit']).toBe('重发')
    expect(en['action.edit']).toBe('Resend')
    expect(zh['action.editAria']).toBe('重发这条消息')
    expect(en['action.editAria']).toBe('Resend this message')
    // op=edit 的 notice 文案与时间线行标签同口径
    expect(zh['marker.edit']).toContain('重发')
    expect(en['marker.edit']).toContain('Resent')
    expect(zh['timeline.kind.edit']).toBe('重发')
    expect(en['timeline.kind.edit']).toBe('Resend')
    // 「重发＝本条及其后重开」的口径写进 title/hint(test/client-edit-reopen-default.test.js 亦钉)
    expect(zh['action.sendFromHere']).toContain('重发')
    expect(zh['action.sendFromHere']).toContain('重开')
    expect(zh['action.sendFromHereHint']).toContain('重发即重开')
    expect(zh['action.sendFromHereHint']).toContain('本条及其后')
    expect(en['action.sendFromHere']).toMatch(/resend/i)
    expect(en['action.sendFromHere']).toMatch(/restart/i)
    expect(en['action.sendFromHereHint']).toMatch(/resending/i)
    // 旧词「编辑」不再出现在这四个入口里
    for (const key of ['action.edit', 'action.editAria', 'action.sendFromHere', 'action.sendFromHereHint', 'marker.edit']) {
      expect(zh[key], `${key} 仍含旧词「编辑」`).not.toContain('编辑')
      expect(en[key], `${key} 仍含旧词 "edit"`).not.toMatch(/\bedit/i)
    }
  })

  it('真渲染:用户消息行上的 chip 文字与 title 都是「重发」;编辑器发送按钮 = 「重发（从这条重开）」', async () => {
    const { mini, client } = await buildInteractive(['UserActionsRow'])
    mountRow(mini, client, userActionsNode(5))
    const chips = buttons(mini, 'dsh-rt-chip')
    const editChip = chips.find((el) => el.props.title === tZh('action.edit'))
    expect(editChip, '「重发」chip 必须存在').toBeDefined()
    expect(textOf(editChip)).toBe('重发')
    expect(editChip.props.title).toBe('重发')

    editChip.props.onClick()
    mini.flush()
    const send = buttons(mini, 'dsh-rt-editor-send')[0]
    expect(textOf(send)).toBe(zh['action.sendFromHere'])
    expect(textOf(send)).toContain('重发')
    expect(send.props.title).toBe(zh['action.sendFromHereHint'])
    expect(send.props.title).toContain('重发即重开')
  })
})

// ---------------------------------------------------------------------------
// ② 撤回文案不再出现「归档」
// ---------------------------------------------------------------------------
describe('② 撤回相关文案去掉"归档"', () => {
  it('marker 正文(TRACE_TEXT)就事论事说撤回', () => {
    expect(TRACE_TEXT).toBe('（此处内容已被撤回，可在恢复视图中查看）')
    expect(TRACE_TEXT).not.toContain('归档')
    expect(TRACE_TEXT).toContain('此处内容已被撤回')
    expect(TRACE_TEXT).toContain('恢复视图')
  })

  it('二次确认描述与确认按钮(zh/en)', () => {
    expect(zh['action.recallConfirmDesc']).not.toContain('归档')
    expect(en['action.recallConfirmDesc']).not.toMatch(/archive/i)
    // 真实可用的出路仍然写明(「恢复显示」= host 侧 unhide,见 test/unhide.test.js)
    expect(zh['action.recallConfirmDesc']).toContain('恢复显示')
    expect(en['action.recallConfirmDesc']).toMatch(/restore display/i)
    expect(zh['action.recallConfirmYes']).toBe('撤回')
    expect(zh['action.recallConfirmYes']).not.toContain('归档')
    expect(en['action.recallConfirmYes']).toBe('Recall')
    expect(en['action.recallConfirmYes']).not.toMatch(/archive/i)
  })

  it('源码守卫:zh/en 字典里所有撤回/标记类条目都不含"归档"/"archive"', () => {
    const offenders = []
    for (const [dict, name, pattern] of [[zh, 'zh', /归档/], [en, 'en', /archive/i]]) {
      for (const [key, value] of Object.entries(dict)) {
        if (typeof value !== 'string') continue
        if (!/^(action\.recall|marker\.)/.test(key)) continue
        if (pattern.test(value)) offenders.push(`${name}.${key}=${value}`)
      }
    }
    expect(offenders).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// ③ 读端:历史日志里的旧文案必须继续被识别(不许跟着文案一起改判据)
// ---------------------------------------------------------------------------
describe('③ 旧文案的读端识别不回归', () => {
  it('summary-gate 的占位判据同时认新串与历史串', () => {
    expect(isPlaceholderText(TRACE_TEXT)).toBe(true)
    expect(isPlaceholderText(HISTORICAL_TRACE_TEXT)).toBe(true)
  })

  it('派生件与源码同源(源码改了、产物没重生成 = 历史事故形态)', () => {
    const source = readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8')
    for (const key of ["'action.edit': '重发'", "'action.recallConfirmYes': '撤回'", "'action.edit': 'Resend'", "'action.recallConfirmYes': 'Recall'"]) {
      expect(source).toContain(key)
    }
    for (const artifact of ['lib/client.bundle.js', 'lib/dynamic-client.js']) {
      const built = readFileSync(path.join(ROOT, artifact), 'utf8')
      // esbuild 把非 ASCII 转义成 \uXXXX ⇒ 断言转义后的字面与英文原文两种形态。
      expect(built, `${artifact} 未重新生成:缺少新文案`).toContain('"action.edit": "Resend"')
      expect(built, `${artifact} 未重新生成:缺少新文案(zh)`).toContain('"action.edit": "\\u91CD\\u53D1"')
      // 旧文案「撤回并归档」(\u64A4\u56DE\u5E76\u5F52\u6863)不得残留
      expect(built, `${artifact} 仍带旧文案`).not.toContain('\\u64A4\\u56DE\\u5E76\\u5F52\\u6863')
      expect(built, `${artifact} 仍带旧文案`).not.toContain('"action.edit": "Edit"')
    }
    const host = readFileSync(path.join(ROOT, 'lib', 'dynamic-host.js'), 'utf8')
    expect(host).toContain('（此处内容已被撤回，可在恢复视图中查看）')
    expect(host).not.toContain('（此处内容已被撤回：原消息已归档，可在恢复视图中查看）')
  })
})
