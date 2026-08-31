/**
 * dsh-retrace — lib/adapter/contract.js
 *
 * 适配器层契约(2026-09-01)——业务层与平台解耦的接口定义。
 *
 * 目标:换架构(不用 DSH)时,业务层(message-list.js/守卫)零改动,
 * 只需实现新的「读事件 + 写替换」两个适配器。
 *
 * 三个角色:
 * - 业务层:message-list.js(纯函数,零依赖)——消费「通用事件」,产出消息列表/遮蔽;
 * - 适配器层(本文件):定义「事件读取器」和「替换写入器」两个接口;
 * - 平台实现:dsh-adapter.js(DSH 实现)、未来 self-runtime-adapter.js 等。
 *
 * 通用事件格式(业务层消费的最小形态):
 *   { seq, type, turn, data, source }——与具体平台的存储格式无关。
 */

/**
 * 事件读取器接口:按 sessionId 提供「全量事件」(可靠事实,非内存视图)。
 * @typedef {Object} EventReader
 * @property {(sessionId: string) => Promise<Array<{seq:number, type:string, turn?:number, data?:object, source?:object}>>} readEvents
 *   - 返回按 seq 升序的全量事件;
 *   - 必须从持久化层读(文件/存储),不依赖运行内存(host 内存可能稀疏/窗口化);
 *   - 失败返回 null/throw 由调用方 fallback。
 */

/**
 * 替换写入器接口:在会话上写「遮蔽替换」(模型侧消费)。
 * @typedef {Object} ReplaceWriter
 * @property {(sessionId: string, span: {start:number, end:number, shadowedSeqs:number[]}) => Promise<object>} writeReplace
 *   - 用平台机制写替换标记(DSH = session.append + surfaceOp replace);
 *   - 返回写入结果(marker seq 等)。
 */

/**
 * 组装一个「完整适配器」:读事件 + 写替换,业务层只依赖它。
 * @param {EventReader} reader
 * @param {ReplaceWriter} writer
 */
export function createAdapter(reader, writer) {
  return { reader, writer }
}

/** 空适配器(无平台时,业务层可独立运行)。 */
export const NULL_ADAPTER = createAdapter(
  { readEvents: async () => null },
  { writeReplace: async () => null },
)
