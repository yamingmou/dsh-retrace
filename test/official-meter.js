/**
 * 测试侧的**官方 token-meter** 接入点(不手抄公式)。
 *
 * 为什么需要它:第 1 段审计事件的 `shadowedTokenCount` 是官方 shadow-price claim
 * (令牌价),判据只能是官方自己的估价函数——手抄一份公式就等于把「与官方一致」
 * 变成自我实现。
 *
 * 两个接入点:
 *  1. `estimateMessage` / `foldSurfaceProjection` —— 官方包**按文件路径**取值。
 *     包的 exports 映射只放行 `.` / `./client` / `./invariant` / `./package.json`,
 *     纯估价模块 `lib/types/estimate.js` 不在其中 ⇒ 先解析包入口,再取同级文件
 *     (发布产物布局;桌面宿主里同一份文件).
 *  2. `officialSurfaceMeter()` —— 官方口径的会话面测量桩:`{nodes:[{seq,tokens}]}`,
 *     节点价一律 = 官方 `estimateMessage(deriveEventMessage(event))`
 *     (`@deepseek-ai/dsh-token-meter/lib/types/surface-fold.js:39` 的同一行公式,
 *     官方 `TokenMeter.measure()` 的节点价即由此折出)。宿主装配时注入的是真服务
 *     (`ctx.get('tokenMeter')`),测试里用这个桩替代服务面。
 *
 * 包已声明为 peerDependency(宿主提供 `ctx.tokenMeter`),故可解析;解析失败时
 * 本模块**直接抛**(而不是静默降级成"跳过")——否则「与官方口径一致」会变成假绿。
 */
import { createRequire } from 'node:module'
import { sessionEvents, eventAt } from '../lib/host-compat.js'
import { pathToFileURL } from 'node:url'
import { deriveEventMessage } from '@deepseek-ai/dsh-session'

const require = createRequire(import.meta.url)

/** 官方 token-meter 包入口 → 同级发布文件(按文件 import;见文件头)。 */
function officialModule(relative) {
  let entry
  try {
    entry = require.resolve('@deepseek-ai/dsh-token-meter')
  } catch (error) {
    throw new Error(
      'official-token-meter: 解析不到官方包 @deepseek-ai/dsh-token-meter'
      + '(它在 package.json 的 peerDependencies 里,先跑 pnpm install)。原始错误: '
      + String(error?.message ?? error),
    )
  }
  return import(new URL(relative, pathToFileURL(entry)).href)
}

/** 官方纯估价模块(estimateMessage / estimateContent / ROLE_OVERHEAD …)。 */
export const officialEstimate = await officialModule('./types/estimate.js')
/** 官方 O(1) surface 折价单元(foldSurfaceProjection:claim 武装 + 消费)。 */
export const officialSurfaceProjection = await officialModule('./types/surface-projection.js')

/** 官方 `estimateMessage`(纯函数,测试直接调用)。 */
export const estimateMessage = officialEstimate.estimateMessage

/**
 * 一个事件的**官方估价**:`estimateMessage(deriveEventMessage(event))`
 * (官方 surface-fold 的节点价同式;非表面事件 → 0)。
 * @param {object} event
 * @returns {number}
 */
export function officialNodePrice(event) {
  const message = deriveEventMessage(event)
  return message === null ? 0 : estimateMessage(message)
}

/**
 * 官方口径的会话面测量桩:`measure(session) → {nodes:[{seq,tokens}]}`。
 * 节点序取会话自身的面(fake session 与官方 fold 对这些事件形状同序),
 * **节点价一律由官方估价函数给出**——测试要断言的就是"写入值 == Σ 这些节点价"。
 * @param {object} session
 */
export function officialSurfaceMeter(session) {
  return {
    measure(target) {
      const session0 = target ?? session
      const events = sessionEvents(session0)
      const seqs = Array.isArray(session0?.surface?.nodes) ? session0.surface.nodes : []
      // 洞(窗口化视图)上的节点估不出价 ⇒ 不出现在面里(与官方 measure 对完整日志的行为一致)
      return { nodes: seqs.filter((seq) => events[seq] !== undefined && events[seq] !== null).map((seq) => ({ seq, tokens: officialNodePrice(events[seq]) })) }
    },
  }
}

/** 按 seq 取事件的读取器(session-adapter 的 bySeq 同形)。 */
export function eventAtOf(session) {
  const events = sessionEvents(session)
  return (seq) => events[seq]
}

/**
 * 写入器要的 `deriveMessage`(官方 `deriveEventMessage`,与宿主注入的是同一个函数)。
 * 测试里显式注入它 ⇒ 逐节点取价路径(host 生产路径)被真实覆盖。
 */
export const deriveMessage = deriveEventMessage
