/**
 * 「客户端源码」的**文本面**（给按文本断言的用例用）。
 *
 * 背景：公开发布面有单文件字节上限（256 KiB），`lib/client.js` 因此按内聚块拆出了
 * `lib/client-css.js`（STYLE_ID + CSS）与 `lib/client-i18n.js`（zh/en 字典 + 操作失败文案）。
 * 拆分**不改对外导出面**（client.js import + 再导出），但按文本 grep 源码的用例会找不到
 * 搬走的那些行。
 *
 * 约定：
 *  - 按**文本**断言 client 源码（`toContain` / 正则 / 声明存在性）⇒ 读 `readClientSource()`；
 *    它等价于拆分前的 `lib/client.js` 全文（三件按 import 顺序拼接）。
 *  - 需要 **esbuild 打包**的用例仍以 `lib/client.js` 为入口（import 会被正常解析），
 *    不要喂这份拼接文本（重复声明 + 重复 import）。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** client 源文件（顺序 = lib/client.js 的 import 顺序）。 */
export const CLIENT_SOURCE_PARTS = ['lib/client.js', 'lib/client-css.js', 'lib/client-i18n.js']

const root = dirname(dirname(fileURLToPath(import.meta.url)))

/** 拆分前 `lib/client.js` 的等价全文（按文本断言的单一入口）。 */
export function readClientSource() {
  return CLIENT_SOURCE_PARTS.map((rel) => readFileSync(join(root, rel), 'utf8')).join('\n')
}
