/**
 * vitest 配置：唯一的职责是挂上"禁止写活家插件数据目录"的硬护栏
 * （见 test/setup/forbid-live-data-writes.mjs 的事故说明）。
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // ① 每个 worker：沙箱 $DSH_HOME + fs 写护栏（解析不到活家）
    setupFiles: ['./test/setup/forbid-live-data-writes.mjs'],
    // ② 全轮：金丝雀（真被写了 ⇒ 整轮红，fail-closed）
    globalSetup: ['./test/global-setup.mjs'],
  },
})
