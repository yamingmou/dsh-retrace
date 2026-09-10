/**
 * Generate the self-contained dynamic plugin entries from the canonical
 * sources, so the two can never drift apart again.
 *
 *   lib/dynamic-host.js   ← lib/host-core.js (transport-agnostic ops)
 *   lib/dynamic-client.js ← lib/client.js    (bundle + `host.call` wire)
 *
 * The dynamic files are committed (the plugin editor loads them verbatim as
 * "function body that returns a Cordis Plugin"); `pnpm build` regenerates them
 * and CI fails when the committed copies are stale.
 */
import { build } from 'esbuild'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const read = (p) => readFileSync(join(root, p), 'utf8')
const write = (p, content) => {
  writeFileSync(join(root, p), content.endsWith('\n') ? content : `${content}\n`)
  console.log(`generated ${p}`)
}
const indent = (text, spaces) =>
  text
    .split('\n')
    .map((line) => `${' '.repeat(spaces)}${line}`)
    .join('\n')

// ---------------------------------------------------------------------------
// lib/dynamic-host.js
// ---------------------------------------------------------------------------
{
  const hostCore = read('lib/host-core.js')
  const writerSrc = read('lib/adapter/dsh-writer.js')
  // host-core 现在依赖两个**纯模块**(span 语义单一真相 + 契约运行时校验)——
  // 动态插件 realm 不能 import,故一并 inline(声明顺序 = 依赖顺序):
  //   span-semantics.js(零依赖)→ adapter/contract.js(只引 span-semantics)
  //   → host-core → dsh-writer
  const spanSemanticsSrc = read('lib/span-semantics.js')
  const contractSrc = read('lib/adapter/contract.js')
  // 这四个文件都是纯 ESM(host-core/span-semantics 零平台 import;contract 只引
  // span-semantics;dsh-writer 只引 host-core 与 contract 的符号)——strip export 与
  // import,声明落进动态 apply 作用域(inline 顺序保证符号先声明后使用)。
  const strip = (src) => src.replace(/^import .* from '[^']*';?\n/gm, '').replace(/^export /gm, '').trim()
  const inlineSpanSemantics = strip(spanSemanticsSrc)
  const inlineContract = strip(contractSrc)
  const inlineHost = strip(hostCore)
  const inlineWriter = strip(writerSrc)
  const dynamicHost = `/**
 * GENERATED FILE — do not edit by hand.
 * Source of truth: lib/host-core.js + lib/adapter/dsh-writer.js + the wrapper
 * below (scripts/generate-dynamic.mjs).
 */
return {
  inject: ['sessions', 'agents'],
  apply(ctx) {
    const { sessions, agents } = ctx
    const log = (line) => console.error(\`retrace: \${line}\`)
${indent(inlineSpanSemantics, 4)}
${indent(inlineContract, 4)}
${indent(inlineHost, 4)}
${indent(inlineWriter, 4)}
    // 遮蔽写入器（DSH 三情形翻译）。动态路径无 prewrite guard 与文件全量
    // readMaxStep——step 分配仅内存覆盖（maxStepInTurn），窗口外既有 step 无法
    // 感知（同类风险）；正式装配在
    // lib/index.js 注入 readMaxStep（文件全量）与 validateMarker。
    const markerWriter = createDshMarkerWriter({ agents, log })
    const api = createEditorApi(ctx, sessions, agents, log, { writeMarker: markerWriter.writeMarker })
    const disposers = [
      harness.handle('retrace.recall', (args) => api.recall(args)),
      harness.handle('retrace.editAndResend', (args) => api.editAndResend(args)),
      harness.handle('retrace.regenerate', (args) => api.regenerate(args)),
    ]
    ctx.effect(() => () => {
      for (const dispose of disposers) dispose()
    }, 'retrace: handlers')
  },
}
`
  write('lib/dynamic-host.js', dynamicHost)
}

// ---------------------------------------------------------------------------
// lib/dynamic-client.js
// ---------------------------------------------------------------------------
{
  const clientSrc = read('lib/client.js')
  const injectMatch = clientSrc.match(/export const inject = (\[[^\]]*\])/)
  if (!injectMatch) throw new Error('generate-dynamic: could not find `export const inject` in lib/client.js')
  const injectLiteral = injectMatch[1]

  // Bundle the canonical client WITHOUT the __ModuleLoader__ banner — the
  // dynamic runtime evaluates the returned plugin surface directly. Only
  // `react` stays external (the dynamic runtime provides it as a global).
  const result = await build({
    entryPoints: [join(root, 'lib', 'client.js')],
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: ['es2020'],
    external: ['react'],
    write: false,
    logLevel: 'silent',
  })
  const bundle = result.outputFiles[0].text.trim()

  const dynamicClient = `/**
 * GENERATED FILE — do not edit by hand.
 * Source of truth: lib/client.js + the wire wrapper below (scripts/generate-dynamic.mjs).
 */
return {
  inject: ${injectLiteral},
  apply(ctx) {
    const mod = (() => {
      var module = { exports: {} }
      var exports = module.exports
      const require = (name) =>
        name === 'react' ? React : (() => { throw new Error('dsh-retrace: unknown module "' + name + '" in dynamic client') })()
${indent(bundle, 6)}
      return module.exports
    })()
    if (typeof mod.__setMessageEditorWire === 'function') {
      mod.__setMessageEditorWire((op, payload) => host.call(\`retrace.\${op}\`, payload))
    }
    return mod.apply(ctx)
  },
}
`
  write('lib/dynamic-client.js', dynamicClient)
}
