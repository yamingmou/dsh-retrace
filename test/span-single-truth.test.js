/**
 * 「轮首回退 / 尾部切片」规则的**单一实现** —— 结构断言(issue-230 )。
 *
 * issue-229 第 2 项把遮蔽范围规则收敛到 `lib/span-semantics.js`(业务层与适配层共用)。
 * 但当时只有**行为用例**(同一输入两模式结果一致)——行为一致**不排除**将来冒出第三份
 * 实现:只要新实现恰好与我们测过的输入一致,用例照样绿,直到某个边界输入让两份实现
 * 分叉(那正是审计最初发现的事故形态:"预览与写入迟早对不上")。
 *
 * 本文件把「只有一份实现」钉成**结构断言**(源码级正则):
 *   - `lib/**\/*.js` 下(除 `lib/span-semantics.js`)不得再出现
 *     ① 轮首回退循环(带轮边界谓词的向前扫描)② 尾部切片(切到序列末尾)
 *     ③ 同名原语(roundStartIndex/roundEndIndex/spanSliceOf)的本地定义
 *     ④ 用切片直接组装 span(`shadowedSeqs: <序列>.slice(…)`);
 *   - **生成件**(`lib/dynamic-host.js`、`lib/dynamic-client.js`、`lib/client.bundle.js`)
 *     是上述源码的字节级副本(内联 realm 版),内容派生 → 排除;它们与源码同源由
 *     `test/generated.test.js` 保证;
 *   - 断言必须**有牙**:下面用**历史实现形态**的样本逐条证明每条禁用正则真的能咬到
 *     它 —— 否则「零命中」只可能是正则写错了的假绿。
 *
 * **诚实记录的局限**:源码级正则是**形态**判据,不是完备证明(换变量名/换写法可绕过);
 * 它的价值是"再冒出一份实现时必然被拦下并逼你说明",与行为用例、声称登记互补。
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, dirname, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const SINGLE_TRUTH = 'lib/span-semantics.js'
/** 生成件(源码的副本/打包产物):内容是派生的,排除出结构断言。 */
const GENERATED = /(^|\/)(dynamic-host|dynamic-client|client\.bundle)\.js$/

/** 禁用形态:**形态**判据(见文件头局限说明)。 */
const BANS = [
  {
    what: '轮首回退循环(for 形态:向前找轮边界)',
    re: /(?:for|while)\s*\([^)]*?;\s*\w+\s*>=\s*0;\s*\w+\s*(?:--|-=)[^)]*\)[\s\S]{0,300}?is(?:Round)?Boundary/,
  },
  {
    what: '轮首回退循环(while 形态:边界谓词 + 退格)',
    re: /while\s*\([^()]*(?:isBoundary|isRoundBoundary)[\s\S]{0,160}?\w+\s*(?:--|-=)/,
  },
  {
    what: '同名原语的第二份定义(roundStartIndex/roundEndIndex/spanSliceOf)',
    re: /(?:function|const|let)\s+(roundStartIndex|roundEndIndex|spanSliceOf)\b/,
  },
  {
    what: '尾部切片(从位置切到序列末尾)',
    re: /\b(?:nodes|seqs|sequences|messages|events|surface)\s*\.slice\(\s*[^,)]+\)/,
  },
  {
    what: '尾部切片(切到 .length)',
    re: /\.slice\([^,)]+,\s*[\w.]*length\s*\)/,
  },
  {
    what: 'span 由序列切片直接组装(shadowedSeqs: <序列>.slice(…))',
    re: /shadowedSeqs\s*:\s*[\w.]*(?:nodes|seqs|sequences|messages|events|surface)[\w.]*\.slice\(/,
  },
]

/** 历史实现形态(issue-229 收敛前的真实写法)——用于证明每条正则有牙。 */
const HISTORICAL_SHAPES = [
  // 适配层旧 computeSpan:目标位置向前找最近轮边界
  "for (let i = targetIdx; i >= 0; i--) { if (isRoundBoundaryEvent(events[i])) return i }\nreturn targetIdx",
  // 业务层旧 shadowSpanOf:直接 slice 到结尾
  'const shadowedSeqs = messages.slice(targetIdx)\nreturn { start: shadowedSeqs[0], end: shadowedSeqs[shadowedSeqs.length - 1], shadowedSeqs }',
  // while 形态的向前回退 + 退格
  'while (i >= 0 && !isBoundary(nodes[i])) i--',
  // 影子原语定义
  'function roundStartIndex(nodes, index, isBoundary) {',
  // span 由序列切片组装
  'return { start: nodes[index], end: nodes[nodes.length - 1], shadowedSeqs: events.slice(startPos, events.length) }',
]

function libFiles() {
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.git') continue
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) { walk(full); continue }
      if (!entry.endsWith('.js')) continue
      out.push(relative(root, full).split(sep).join('/'))
    }
  }
  walk(join(root, 'lib'))
  return out
}

function banHits(rel) {
  const text = readFileSync(join(root, rel), 'utf8')
  const lines = text.split('\n')
  const hits = []
  for (const ban of BANS) {
    // 跨行形态:行级失配时再整文件试一次(报告仍指到命中行)
    const at = lines.findIndex((line) => ban.re.test(line))
    if (at >= 0) { hits.push(`${rel}:${at + 1}  [${ban.what}]  ${lines[at].trim().slice(0, 110)}`); continue }
    if (ban.re.test(text)) {
      const offset = ban.re.exec(text)?.index ?? 0
      const line = text.slice(0, offset).split('\n').length
      hits.push(`${rel}:${line}  [${ban.what}]  (跨行形态)`)
    }
  }
  return hits
}

describe('单一真相(第 2 项)· 结构断言:轮首回退/尾部切片只有一份实现', () => {
  it('issue-230 :lib/ 下除 lib/span-semantics.js 外,不存在第二份轮首回退/尾部切片实现', () => {
    const scanned = libFiles().filter((rel) => rel !== SINGLE_TRUTH && !GENERATED.test(rel))
    expect(scanned.length).toBeGreaterThan(15) // 扫描面非空(防规则失效导致"假绿")
    const hits = scanned.flatMap(banHits)
    expect(hits).toEqual([])
  })

  it('规则实现确实在 lib/span-semantics.js(原语与回退循环都还在,不是"两边都没有"的假绿)', () => {
    const text = readFileSync(join(root, SINGLE_TRUTH), 'utf8')
    for (const name of ['roundStartIndex', 'roundEndIndex', 'spanSliceOf', 'spanAt', 'spanForSeq']) {
      expect(text).toContain(`export function ${name}`)
    }
    expect(/for\s*\(let i = index;\s*i >= 0;\s*i--\)/.test(text)).toBe(true) // 唯一的轮首回退循环
  })

  it('断言有牙:每条禁用形态都能咬到历史实现样本(正则写错 → 这里先红)', () => {
    for (const ban of BANS) {
      const bitten = HISTORICAL_SHAPES.filter((shape) => ban.re.test(shape))
      expect(bitten.length, `禁用形态「${ban.what}」咬不到任何历史样本 → 该条断言是假绿`).toBeGreaterThan(0)
    }
    // 反向:样本集合本身要覆盖到每一条(逐条对应,防"两条正则共用一个样本"掩盖失效)
    const uncovered = BANS.filter((ban) => !HISTORICAL_SHAPES.some((shape) => ban.re.test(shape))).map((b) => b.what)
    expect(uncovered).toEqual([])
  })

  it('豁免集合只含生成件(生成件的同源由 test/generated.test.js 保证)', () => {
    for (const rel of ['lib/dynamic-host.js', 'lib/dynamic-client.js', 'lib/client.bundle.js']) {
      expect(GENERATED.test(rel)).toBe(true)
      expect(existsSync(join(root, rel))).toBe(true)
    }
    expect(existsSync(join(root, 'test/generated.test.js'))).toBe(true)
  })
})
