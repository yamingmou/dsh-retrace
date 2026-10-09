/**
 * 撤回/编辑就该隐藏，不需要开关。
 *
 * 问题背景: 存量配置里 `hideShadowed: false`(version 3) 被永久固化 —— 迁移逻辑只对
 * `version < 3` 强制改回 true，于是无论怎么升级，撤回后界面都还在，且没有任何日志。
 * 因此该字段不再是判据、设置面板也不再提供入口，隐藏成为恒定行为，只保留两条例外:
 * ①legacy 老前缀标记永不隐藏(安全侧) ②自动收起的 40% 降级(待新折叠方案)。
 *
 * 这个文件同时是**生成物陈旧**的守卫: 我们历史上多次出现"源码改了、bundle 没重生成"，
 * 导致线上行为与源码不一致(排查成本极高)，所以三个文件必须同时满足判据。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')

const SOURCE = 'lib/client.js'
const ARTIFACTS = ['lib/client.bundle.js', 'lib/dynamic-client.js']
const NEW_GATE = 'const hiddenKeys = legacy ? null'

describe('撤回/编辑的隐藏是恒定行为，不受配置控制', () => {
  it('隐藏判据不再读取 hideShadowed 配置', () => {
    const src = read(SOURCE)
    expect(src).toContain(NEW_GATE)
    // 旧判据 `legacy || !getConfig().hideShadowed` 必须消失，否则存量 false 会再次关掉隐藏。
    expect(src).not.toContain('getConfig().hideShadowed')
  })

  it('设置面板不再提供该开关（恒定行为: 完全不需要开关）', () => {
    const src = read(SOURCE)
    expect(src).not.toContain("optionRow('hideShadowed'")
    expect(src).not.toContain("'options.hideShadowed'")
  })

  it('生成物与源码判据一致（守住"bundle 陈旧"这类历史问题）', () => {
    for (const artifact of ARTIFACTS) {
      const built = read(artifact)
      expect(built, `${artifact} 未重新生成: 缺少新判据`).toContain(NEW_GATE)
      expect(built, `${artifact} 未重新生成: 仍带旧判据`).not.toContain('getConfig().hideShadowed')
      expect(built, `${artifact} 未重新生成: 仍带旧开关 UI`).not.toContain('optionRow("hideShadowed"')
    }
  })

  it('legacy 豁免仍在（安全侧: 老前缀标记永不隐藏，不会被顺带删掉）', () => {
    const src = read(SOURCE)
    expect(src).toMatch(/const hiddenKeys = legacy \? null/)
    expect(src).toContain('legacy ? null')
  })
})
