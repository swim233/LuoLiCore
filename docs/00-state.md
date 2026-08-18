# 00 · 当前态

> 这份文档回答三个问题：**现在还欠什么**、**哪些地方查过没问题**（免得下一轮重复查）、
> **权威清单在哪儿**。它是活的，跟着代码走。
>
> 复审报告（[`reviews/`](./reviews/)）是**历史快照**，写完即冻结，它们的结论一律不代表现在 ——
> 想知道现在的状态只看本文。反过来，本文**不重抄**别处已经由测试焊住的清单，只指过去：
> 同一个事实有两份副本，迟早会漂。上一次漂的代价是「未接线配置键」在四个地方有三个数字。
>
> 核对时间：2026-08-18（第九轮整改后 + M12 自我扩展落地）。每一条都回代码查过，不采信文档自述。

---

## 1. 权威清单在哪儿

本文不复制这四张表，改了它们不用回来改这里。

| 问题 | 权威 | 由什么焊住 |
|---|---|---|
| 哪些配置键还没接线 | [11 §2.0.1](./11-config-reference.md)（当前 10 条，每条写明为什么留着） | `tests/config.test.ts` —— 白名单每条必须在 `docs/11` 标记，且标注要跟着 `HOT_RELOADABLE_CONFIG_KEYS` |
| 验收条目的勾选状态 | [13](./13-acceptance-criteria.md)（当前 **160 / 440**） | `tests/acceptance.test.ts` —— 只有标 `(自动)` 且点名真实用例文件的能勾，签署表分子分母自动核对 |
| WebUI 控制面够不着什么 | [21](./21-webui-coverage-gaps.md) | 无自动约束（人工复算，方法见其 §1） |
| 某行代码为什么长这样 | [`reviews/`](./reviews/) 里的条目编号 | `tests/docs.test.ts` —— 编号被源码注释大量引用，删了或改了会报错 |

---

## 2. 还欠什么

按「挡着别人 / 单独可做」分组。**每条都实测过**，括号里是核对时的实际值。

### 2.1 结构性的三条（[`reviews/27` §8](./reviews/27-full-scope-review.md) 的 `Z4`/`Z5`，需求方拍板留到下一轮）

有依赖顺序，不要并行：

| 编号 | 欠什么 | 实测 | 前置 / 影响 |
|---|---|---|---|
| `D-01` | 裸 SQL 散在仓储层之外 | **165 条语句 / 16 个文件**（`app.ts` 一个就占 76 条）。`reviews/27` 记的是「40+」，已经涨了；M12 把 `writeConfigRows` 下沉进了 `packages/db`，`custom_tools` 也是从头就走 `CustomToolRepository`，这一条没有再被加高 | 先做这条。`tests/db.isolation.test.ts` 的按 chat 隔离断言只覆盖得到 `packages/db` 里的查询，仓储外的这 165 条**一条都没被那道断言覆盖** |
| `D-04` | `composeRuntime` 没抽出来 | 函数不存在；`apps/bot/src/main.ts` 445 行全是装配 | 依赖 `D-01`。抽出来之后集成测试才装得起运行时 —— 现在 `I-10` 那条改动就是因此没有用例覆盖 |
| `D-02` | `ConsoleView.vue` 拆分 | **2916 行**。`reviews/25 §8` 记的是「1700+」，**已经长了 1200 行** | 前置条件是 14 条渲染用例，目前 `tests/webui/console.render.test.ts` 有 4 条（逐个切 14 个导航页、导航项与分支一一对应，外加设置页四个二级 tab 的同两条）。**这是硬前置**：上一次没有用例就拆，14 个控制台页面全变空白（`reviews/24 · D-UI-01`）。设置页那两条是照着同一个形状写的，拆到哪个页面就先按那个形状补一条 |

### 2.2 缺一条阻塞式人机通道（两项同根）

Telegram 侧没有「发一条带选项的消息、等人点、把结果回灌给正在等的调用方」这条通道。实测
`packages/telegram` / `packages/core` 里除 `/cancel` 外没有任何 `inline_keyboard` 使用。它挡着两件事：

- **Telegram inline keyboard 审批** —— 裁决目前只能在 WebUI 做。发起人回执**已经补上**了
  （`approvals.ts:69`，落库后再发，发不出去不影响审批本身），所以现在不会再出现「沉默三分钟」，
  但人不在 WebUI 前面就只能等 TTL 自动拒绝。
- **`agent.askEscalateToUser`（转人工）** —— 仲裁本身（`agent.askArbiter` + `askTimeoutMs`）已接线；
  这个键为真时仲裁失败只多记一条 `agent.ask_unarbitrated` warn，**不会真的去问人**。详见
  [11 §2.0.1](./11-config-reference.md)。

### 2.3 零散的

| 欠什么 | 实测 | 备注 |
|---|---|---|
| `health` 事件没有周期心跳 | 只在 provider 测试与 MCP 重连后 emit（`app.ts:727` / `1400`） | **有意为之**：顶栏新鲜度依据业务事件，不把连接状态伪装成周期健康检查。要改先想清楚这一点 |
| 工具策略覆盖层刚落地，`TOOL_POLICY` 不再是唯一真相 | `tools.overrides.<name>` 现在收 `enabled` / `minRole` / `approval` / `timeoutMs`；合并只有一份（`effectiveToolPolicy`，`packages/core/src/tools/policy.ts`），registry 与 `GET /api/tools` 共用 | 这是对 [09 §3.7](./09-webui.md) 旧决定的**有意推翻**（原文见 [21 §5](./21-webui-coverage-gaps.md) 那条「已推翻」）。改工具权限相关代码前先看那三条不变量：覆盖绕不过 `available()`、`approvalFor` 抬档只升不降、`timeoutMs: null` 的工具不吃超时覆盖。**读 minRole/approval 一律走 `ToolRegistry.effectivePolicy()`**，直接读 `tool.policy` 就是绕过覆盖层 |
| 解析失败的第二级兜底（发 `.md` 文档）没实现 | `sendWithFallback` / `TelegramOutput.edit` 只做了第一级：`can't parse entities` 时以纯文本重发/重编辑一次（`output.ts:161`、`stream-output.ts:81`）。[08 §5.2](./08-telegram-adapter.md) 那条「再失败则把内容作为 `.md` 文档发出并回复一句摘要」压根没有实现，而 AC-OUT-005 一直挂着 `[x]`（**已改回 `[ ]`**） | 两级都不打日志，`turn.jsonl` 里只有 `turn.start` / `ctx.commit` / `turn.end`。**渲染后真正发出去的文本全链路没有一处落日志** —— 这次的行内代码 bug 只能靠翻下一次模型调用的上下文 blob 反推出来。要补兜底的话顺手把「降级了」记一条 warn |
| 验收条目 274 条未勾 | 其中人工条目一律保持未勾（要人签字，不是测试的事）；其余是没有对应 vitest 用例的 `(自动)` 条目 | 勾选形式由 `tests/acceptance.test.ts` 定死，勾之前先写用例 |
| 10 条配置键未接线 | 见 [11 §2.0.1](./11-config-reference.md)，每条写明「暂时没做」还是「不该在这一层做」 | 摘键之前先看 [21 §1](./21-webui-coverage-gaps.md) 的复算方法 |
| 自我扩展刚落地（M12），四条通道默认全关 | `tools.selfExtend.*` 出厂 `enabled: false`；打开之后模型能写自定义工具 / skill / plugin，能登记 MCP server | 主闸不是审批而是「落库即禁用，owner 在扩展页点开」。动这一块之前先读 [14 T18/T19](./14-open-questions.md)：**授权时点与执行时点是分离的**，而 `requireSandbox` 默认关时自定义工具就是调用者的 `bash`（因而能直接写 `data/luoli.db` 绕开启用闸）|

---

## 3. 查过、没有发现问题的地方

**下一轮先读这三节再决定查什么**，它们是给复审省时间的，每一项都逐文件读过。

| 范围 | 在哪 | 覆盖了什么 |
|---|---|---|
| 全维度（OWASP / SOLID / JS·TS） | [`reviews/27` §7](./reviews/27-full-scope-review.md) | 13 个面：SQL 注入、原型污染、CSRF + 会话、SSRF 主路径、密钥、提示词注入、ReDoS、权限模型、上下文引擎 §9 的 19 条红线、优雅关停、并发闸与互斥、WebUI 前端 XSS |
| 工具系统 | [`reviews/26` §6](./reviews/26-round8-tool-review.md) | 七道权限闸、`PathJail` 的五类穿越、`untrusted()` 包裹顺序、超时账、追发预算、`edit_file` 审批档位 |
| WebUI 控制面 | [21 §5](./21-webui-coverage-gaps.md) | 判定为「不是缺口」的三类：运行时没接线的配置项、被取代的重复端点、有意做成只读的地方 |

---

## 4. 怎么维护这份文档

- **发现新缺口** → 写进 §2，带实测值和 `file:line`。不要只写「XX 没实现」，写清楚**挡着什么**。
- **补完一条** → 从 §2 删掉。历史留在当轮的复审报告里，不在这儿堆。
- **做完一轮复审** → 报告写进 [`reviews/`](./reviews/)，加 frozen header，然后**把结论折进本文**。
  报告本身从此不再改 —— 它的条目编号是源码注释的凭据（`tests/docs.test.ts` 焊住）。
- **§1 那四张表永远不要抄到这里来**。想知道具体哪 10 个配置键、哪 274 条验收项，点进去看。
