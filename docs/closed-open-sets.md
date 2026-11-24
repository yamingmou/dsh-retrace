# 闭集与开集（R-5）：枚举穷尽 vs 留痕放行

> 规则：**自己的闭集**必须穷尽（每个已知值都有显式分支/断言，新增值不补 ⇒ 红）；
> **外部会新增的集合**不得穷尽（未知值留痕 + 默认放行 + 可升级）。
> 两个方向都会出事：外部输入穷尽 ⇒ 上游加值即崩；自己闭集放行 ⇒ 编漏没人发现。

## 闭集（本仓自己定义，必须穷尽）

| 集合 | 值 | 位置 | 穷尽方式 |
|---|---|---|---|
| 身份层 `LAYERS` | HEADER / RUNTIME / HUMAN | `lib/identity/shortcode.js:384-388` | 常量表；`test/closed-open-sets.test.js` 断言恰为三值 |
| 分配 `kind` | pinned / allocated / COLLISION-REFUSED | `lib/identity/shortcode.js:522,536,539` | 源码集合断言（出现第四种 ⇒ 红） |
| span 未命中 `kind` | pending / not-found / replay-failed / shadowed | 产出：`lib/host-core.js:786-845`；分支：`:861-877` | **四个显式 case** + 源码断言「case 集合 == 产出集合」；未知值 ⇒ 可见日志 + 保守收场（不崩） |

## 开集（外部定义、会新增，不得穷尽）

| 集合 | 来源 | 本仓处理 | 位置 |
|---|---|---|---|
| 事件 `type` 词表 | 上游运行时（随版本新增） | 并集已知类型 + 校验副本按 `ignorable` 处理（未知类型不崩） | `lib/index.js:509-521` |
| provider / model 名 | 上游/用户配置 | 原样透传，不做白名单穷尽 | `lib/marker-carrier.js`、`lib/adapter/dsh-writer.js` |
| 归档过滤枚举 `archivedFilter` | 宿主客户端（宿主自己 `assertNever`） | **本仓不镜像、不穷尽**（出现即红，防把宿主枚举抄成自己的闭集） | 不在本仓；宿主侧 `dsh-client-ui-workspace/lib/client.js:356-364` |

## 判定要点（可机检）
- 闭集：`test/closed-open-sets.test.js` 用「产出值集合 == 分支值集合」「常量表集合」两类断言，**换实现仍成立**（属性/行为，不是写法）。
- 开集：断言"本仓不出现该枚举的穷尽分支"（如 `archivedFilter`），以及未知事件类型走 `ignorable` 路径。
