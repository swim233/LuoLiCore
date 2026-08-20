# 00 · 当前态

> 这份文档回答三个问题：**现在还欠什么**、**哪些地方查过没问题**（免得下一轮重复查）、
> **权威清单在哪儿**。它是活的，跟着代码走。
>
> 复审报告（[`reviews/`](./reviews/)）是**历史快照**，写完即冻结，它们的结论一律不代表现在 ——
> 想知道现在的状态只看本文。反过来，本文**不重抄**别处已经由测试焊住的清单，只指过去：
> 同一个事实有两份副本，迟早会漂。上一次漂的代价是「未接线配置键」在四个地方有三个数字。
>
> 核对时间：2026-08-20（扩展页重设计 + MCP 登录落地）／2026-08-19（第九轮整改后 + M12 自我扩展落地 + 8-18 两次进程崩溃的收口
> + **第十轮停机活体测试的 30 条整改全部落地**）。
> 每一条都回代码查过，不采信文档自述。
>
> 第十轮那 30 条已经**从本文删干净**了 —— 做完就不留在这儿，历史在
> [`reviews/28`](./reviews/28-round10-live-system-test.md) 里。它换的是手段而不是判据：
> 真进程 / 真 Telegram / 真 docker / 真时钟 / 真上游，只找单元测试**结构性**看不见的问题，
> 而找到的东西几乎全部落在「每一半都有测试、没有一条跨过边界」的位置上 —— 前后端边界、
> 写入侧与读出侧的边界（trace 那条读出侧修过一次，修完之后正确地读着一个永远是 NULL 的列）、
> 以及被整体替换掉的依赖（所有既有用例都把 `bot.api` 换掉，节流器从没进过测试回路）。
> **下一轮要找同一类东西，先读那份报告的 §6（跑过没问题的）与 §8（排除掉的 8 条假象）。**

---

## 1. 权威清单在哪儿

本文不复制这四张表，改了它们不用回来改这里。

| 问题 | 权威 | 由什么焊住 |
|---|---|---|
| 哪些配置键还没接线 | [11 §2.0.1](./11-config-reference.md)（当前 10 条，每条写明为什么留着） | `tests/config.test.ts` —— 白名单每条必须在 `docs/11` 标记，且标注要跟着 `HOT_RELOADABLE_CONFIG_KEYS` |
| 验收条目的勾选状态 | [13](./13-acceptance-criteria.md)（当前 **213 / 490**） | `tests/acceptance.test.ts` —— 只有标 `(自动)` 且点名真实用例文件的能勾，签署表分子分母自动核对 |
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
| `D-02` | `ConsoleView.vue` 拆分 | **3034 行**（`reviews/25 §8` 记的是「1700+」；本轮之前是 3366，抽走扩展页减了 332 行）。渲染用例现在 **12 条**（此前 4 条）：14 个导航页各一次、设置页四个 tab、扩展页四个分段、外加 trace 深度 / 模型能力标记 / 未审阅形态 / 待你处理这几条 | 前置条件是渲染用例，**这一条仍然是硬前置**：上一次没有用例就拆，14 个控制台页面全变空白（`reviews/24 · D-UI-01`）。本轮按那个形状走通了一遍 —— 先补非空 fixture 让四类的行模板真的被渲染，再抽 `ExtensionsPage.vue` + `components/extensions/` 四个纯呈现子组件，然后补四条结构相关的用例。**再抽下一个页面照这个顺序**。另外记一条只有真浏览器发现得了的：WebUI 不能 import `@luoli/shared`（它拉 `node:crypto`，vite 会 externalize 成一调用就抛的桩；而 vitest 别名到 `src/` 并跑在 node 里，用例是绿的）|

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
| trace 树上还有三处**知情的**不对称（第十轮整改留下的） | ①`sandbox.run` 只有 `traceId`、没有 `parentSpanId`，在 trace 里是 depth 0 —— 要挂到 `bash` 那次 `tool.call` 之下得给 `Sandbox.run` 加一个参数再从三条工具路径各穿一遍，而 `docs/10 §1` 那张图本来也没有它；②`tool.error` **只覆盖主 agent**：子 agent 的 `onStepEnd` 不走 `stepToolResults`，同一个盲区在那边还开着（事故起点在主路径，`docs/10 §2` 那行也没承诺子 agent）；③运维禁用某个工具时 `tool.disabled` 与 `tool.denied` **同时落两行**（前者是既有 kind + 既有断言，后者是统一流水） | 三条都在 `docs/10 §2` 的表里写明了边界，所以不是「以为有其实没有」。②是唯一有实际排障代价的一条：子 agent 反复用错工具参数仍然只在上下文里留一条下一轮就被抹掉的 `error-text`。③要合成一条的话 `tests/regression.round9.test.ts` 那条 `warn: true` 断言要跟着改 |
| `pnpm dev`（tsx）下 plugin 热重载**永远跑旧代码**，且修不了 | tsx 的 ESM loader 按文件路径缓存、忽略 URL 上的 `?v=`，于是 `PluginManager` 的 cache-busting 整体失效：11 次 reload 每次都真跑 reconcile（`onLoad`/`onUnload` 都调、DB 更新、无 `load_error`），而**每次 `onLoad` 打印的都是 v1**。最小复现：`node probe.mjs` → `v1 → v2`；`node --import tsx/loader probe.mjs` → `v1 → v1` | **不假装修好**（`docs/16 §5`）：启动落一条 `plugin.hot_reload_unreliable` warn、reload 端点的响应带同一句话、`docs/07 §3.2` 与 `CLAUDE.md` 各写一句。生产（`pnpm start` 跑 `dist/` 的纯 node）不受影响，但 `plugins.watch` 的既定用途正是「本机写 plugin」—— 唯一该用它的场景恰好是它失效的场景。界面上现在显示了：reload 的响应带 `hotReloadReliable`，为假时弹**不自动消失**的 warn 并在 plugin 卡片上常驻一条提示（`G-API-15` 已闭合）。**底层那件事仍然修不了** —— 这一条留在这里是因为它是「不假装修好」的活样本 |
| MCP 子进程死后 `mcp_servers.state` 最长 5 分钟才纠正 | 判活性已经修好（死 client 不再被缓存命中，cron 与「重连」按钮都真的能重连），但库里那一行要等下一次 `mcp-health` reconcile 才从 `up` 改过来 | **不是在 `onclose` 里写库就能解决**：那个回调从子进程的 `'close'` 事件同步跑，`closeDatabase()` 之后一条泄漏子进程自然死亡会让裸 `db.prepare` 抛在 handler 里 → `uncaughtException`（`LogSink.event` 保证不抛，所以那条路只记日志）。要秒级反映得先给它加一个「库还开着吗」的判据。**界面这一半本轮补了**：MCP 表多一列「上次核对」，超过一个 `healthCheckCron` 周期就标「可能已陈旧」（`G-API-16` 的界面部分闭合）—— 陈旧还在，但读得出来了 |
| 分段回复的归档文本在**真的切开时**是近似字面 | 段与 `message_id` 的对应是**精确**的；不精确的是字面形态：渲染在分片之前、分片点是渲染后码点数组上的下标，反推源文本下标要把 offset 穿过两个递归渲染器（`**粗**`→`*粗*`、`###` 降级、列表符替换都不是 1:1）。只有一片时（绝大多数消息）那一片就是整条源文本，口径一字未变 | 切开时按 `toPlainText` 逐段反推 —— 它本来就是解析失败降级时**真正发出去**的那一份。要字面也精确得单独给 `safeRender` 加一张 offset map，而它的空行保真是有 55 条用例焊住的既有契约（`tests/output.render.test.ts`），不该为这件事去动它 |
| `health` 事件没有周期心跳 | 只在 provider 测试与 MCP 重连后 emit（`app.ts:727` / `1400`） | **有意为之**：顶栏新鲜度依据业务事件，不把连接状态伪装成周期健康检查。要改先想清楚这一点 |
| 工具策略覆盖层刚落地，`TOOL_POLICY` 不再是唯一真相 | `tools.overrides.<name>` 现在收 `enabled` / `minRole` / `approval` / `timeoutMs`；合并只有一份（`effectiveToolPolicy`，`packages/core/src/tools/policy.ts`），registry 与 `GET /api/tools` 共用 | 这是对 [09 §3.7](./09-webui.md) 旧决定的**有意推翻**（原文见 [21 §5](./21-webui-coverage-gaps.md) 那条「已推翻」）。改工具权限相关代码前先看那三条不变量：覆盖绕不过 `available()`、`approvalFor` 抬档只升不降、`timeoutMs: null` 的工具不吃超时覆盖。**读 minRole/approval 一律走 `ToolRegistry.effectivePolicy()`**，直接读 `tool.policy` 就是绕过覆盖层 |
| 解析失败的第二级兜底（发 `.md` 文档）没实现 | `sendWithFallback` / `TelegramOutput.edit` 只做了第一级：`can't parse entities` 时以纯文本重发/重编辑一次（`output.ts:161`、`stream-output.ts:98`）。[08 §5.2](./08-telegram-adapter.md) 那条「再失败则把内容作为 `.md` 文档发出并回复一句摘要」压根没有实现，而 AC-OUT-005 一直挂着 `[x]`（**已改回 `[ ]`**） | 第一级现在**记 `tg.parse_fallback` warn** 了（见 [10](./10-logging-and-observability.md) 的事件表），纯文本重发那一跳也包了 try —— 此前它是裸调，第二次失败照样打穿整轮，正是 `sendWithFallback` 的 docstring 说要防的事。**只剩第二级**：再失败则把正文作为 `.md` 文档发出并回复一句摘要 |
| 多步轮次的旁白：分段投递**又改了一次**，从「条件补分隔」变成「归一化」 | 第一版（`result.textStream` 丢 step 边界 → 投递侧 `text +=` 把六句旁白粘成一段，turn `01M09QBZVK…`）改成从 `result.stream` 走 `stepSeparatedText` 补 `\n\n`。**然后反过来空行爆炸**：KERNEL 那条「段间空一行」把模型教成每一步都以 `\n\n\n` 收尾，纯工具步的「正文」就是 `\n\n\n` —— 一条 11 步的回复开头 10 个换行、中段 12 连换行，而这一轮 `stepSeparatedText` **一个分隔符都没插**（logs/2026-08-18 · turn `01M0AKMXG4…`，落库的 assistant part 连那 10 个前导换行一起存了）。现在判据是「扣住尾部空白 + 到点补齐」：纯空白步整段丢弃、步边界恒等于一个空行、首尾无空白，步**内**的空白（列表缩进、围栏代码块里的空行）一个字不动 | 提示词侧同步反转：KERNEL 与 `ASSIST.md` 现在要求「只写那一句，不要自己加空行」。**渲染器不许参与收窄** —— `safeRender` 的空行保真是有测试焊住的既有契约（`tests/output.render.test.ts`）。改投递节奏或换 AI SDK 大版本时先跑 `tests/agent.stream-separator.test.ts`（含那条 11 步真实序列的端到端断言）|
| 一次 tool 输入校验失败能打崩进程 —— 整条链已收口 | 根因是 AI SDK 的 `step.toolResults` = `content.filter(p => p.type === 'tool-result')`，**`tool-error` part 被整个滤掉**，于是 `appendContext` 只把 tool-call 追进 delta。轮内没事（SDK 自己的 `responseMessages` 会把错误转成合法的 tool-result 发上线，那一轮 11 步全成功），下一轮起该会话每次请求都畸形 → 中转站 200 收下、流里 0 步就关闭 → AI SDK 在 flush 里用 `NoOutputGeneratedError` reject `result.text`（派生 promise，SDK 不标 handled）→ `runtime.ts` 那条 `final` 链在创建处没有 catch，而唯一的 catch 排在 `bot.ts` 的 `await consume(...)` 之后（`consume` 开头卡着 `sendChatAction`，实测 561ms）→ `unhandledRejection` → `exit(1)`。实测 2026-08-18 22:17:29 与 23:19:43 两次，`turns` 里两行 `failed / process_restarted / steps=0`，起因是 `get_message({messageId: 0})` 撞上 `z.number().int().positive()` | 五层都在：`stepToolResults` 收 `tool-error`；`commitTurn` 的 `assertPairedToolCalls` 挡新的孤儿（**只查 delta** —— 查 snapshot 会把已损坏的会话彻底锁死）；`contextMessages` 在读出侧给存量孤儿补结果并记 `ctx.orphan_tool_call`（**本次事故那条至今还在 `data/luoli.db` 里**，ordinal 508）；`final` 在创建处 `void final.catch(...)`；`unhandledRejection` 不再 `exit(1)`（[10 §2](./10-logging-and-observability.md)）。可见性也补了：流里的 `error` 部件与 0 步空流各记一条 `model.error`（`source:'stream'`）—— 两次崩溃在 `model.jsonl` 里此前完全隐形。红线进了 [02 §9](./02-context-engine.md) 第 20 条 |
| 含图轮次自动切 `vision` 别名刚落地 | 三处文档（[04 §5.2](./04-agents-and-providers.md)、[08 §7.2](./08-telegram-adapter.md)、`AC-PROV-009`）都写了、代码里一行都没有 —— `capabilities_json` 只有 WebUI 的徽章在读，`docs/03` 自己承认过「运行时不读这一列」。表现是模型看不见图却不知道自己看不见：实测它去 cp 文件、python 读尺寸、开本地 http 服务器、拿 agent-browser 截图，绕 11 步也没看到那张图；它还调了 `set_model('vision')` 并对用户说「切好啦」，而那个覆盖只在当轮生效（logs/2026-08-18 22:15） | **vision 压过一切**：压过 `downgradeAfterStep`，也压过 `set_model` 的当轮指定。`ModelRegistry.supportsVision(alias)` 必须先 `#models.has` —— `info()` 走 `#pick`，别名不存在时静默回落到 `main`，直接问就恒为真。一个能看图的别名都没有时才降级（图片换文本占位 + 回复末尾一句提示，走 `stepSeparatedText` 的收尾通道）。`set_model` 的 description 与返回值现在都写明「仅本轮」|
| 收尾补跑（`wrapUpIfNeeded`）刚落地 | 最后一步没有正文时（以工具调用或纯 reasoning 收尾）追加**一次**禁工具的模型调用让模型自己写结论。四道闸：最后一步无正文、本轮真的调过工具、`streamFailure` 为空、单轮成本闸有余量。**「一次」现在是硬判据**（`stopWhen` 里那条 `wrapUpMode && steps.length >= 1`）—— 它调的是 `agent.generate(...)`，也就是 `ToolLoopAgent` 的整个循环，此前上游在 `tools:[]` 的请求里仍返回 tool_calls 时收尾阶段又跑了 12 步（`steps=24`，`reviews/28 · L-AGT-01`）；`perTurn.maxCostUsd` 只是兜底，不是判据 | 它同时修掉了定时任务那条路的静默失败（`runMainAgent` 拿的也是「最后一步正文」，以工具调用收尾就空正文 → `model_returned_empty`）。**不伪造答复**是这条的红线（[16 §5](./reviews/16-remediation-plan.md)）：补跑是让模型自己说，不是替它编一句 |
| provider 健康检查刚落地，粒度是 **provider 而不是模型** | 周期探测（`provider/health.ts`，[04 §5.3](./04-agents-and-providers.md)）此前压根不存在：那个 cron 只调 `ModelRegistry.rebuild()`，一次探测都不发，于是「上游连上了但不返回」没有任何一处会记住 —— 实测 `logs/2026-08-18` 三个轮次各在开轮 363 秒后才 fallback（`3 × requestTimeoutMs` + 退避），一轮 600 秒最多够走一步，全部以「太久没有进展」收尾，而库里那行 `health_state` 始终是 `up` | 健康状态挂在 `providers` 上（`health_state` / `health_fail_count`），**不是挂在模型上**：一个 provider 被判 down，它下面所有模型一起从各自的别名链里消失（本部署 ksm-api 被判 down 会连带 `high` 的链首 `gpt-5.6-sol`）。这是 [04](./04-agents-and-providers.md) 现在的口径，要改成按模型判就得先改那份文档 + 加一张表。**判据的四条已经过了一轮复审并改齐**（`tests/provider.health.test.ts`）：计数单位是「一次调用一个候选」而不是一次尝试（按尝试记时 `maxRetries: 2` 的一次慢调用就能判死一个好 provider）、服务成功一次就归零（否则「连续」是「累计」，而计数在库里、重启也不清）、冷却到期时把库里那一行也改回 `up`/0（只在内存里放行会 30 分 down / 一个 cron 间隔 up 地抖）、cron 里**先 rebuild 再探**（`#probes` 是上一次 rebuild 的产物，反过来探不到刚放回来的那个）。另一条已知的：调用路径上把最后一个 provider 判成 down 时，`all_providers_down` 要等下一次 cron 才响（那条尾巴在 `main.ts` 的 `rebuildModels`，`recordFailure` 刻意不 rebuild —— 轮次中途换链会让这一步的记账反查不到服务它的那一行） |
| `turnTimeoutMs` 是硬边界，但**收尾那一条消息还是要发出去** | 到点后模型调用当场断，投递侧现在看得见（流会抛，轮次记 `failed` + `error='turn_timeout'`、`cancel_reason='timeout'` 而不是 committed，**也不是 `cancelled`** —— 超时是故障，要计入 `consecutive_turn_failures`，否则「每一轮都卡满十分钟」这种最该响的故障一次都不响，见 [04 §5.3](./04-agents-and-providers.md) 的三档）；但已经在屏幕上的内容要补一个「（生成中断）」（一个字都没投出去时不补，改为把那条占位消息删掉），那一次 `editMessageText` 要排 `telegram.throttle.perChatPerMinute`（群聊默认 20/分钟）的队 | 所以一轮的墙钟仍可能超出 `turnTimeoutMs` **一个 API 调用**的时间。此前超的是 3 分钟：typing 是 4 秒一发的 fire-and-forget（15/分钟），同一个群两轮并行就压满了那 20/分钟的预算，队里全是过期的 typing 而真正的消息排在最后（logs/2026-08-18 · B8F92Z）。现在 typing **给正文让路**：本轮有正文在途（含被节流器压着排队那一段）整拍跳过，首条消息发出之后节拍从 4 秒放宽到 15 秒（`tests/output.pacing.test.ts`）。此前只做了「上一拍没落地就跳过这一拍」，而那个判据是 per 轮次的、20/分钟 那个桶是 per chat 的 —— 于是「队列不再增长」只在单轮成立：第十轮实测同一个群 6 轮并发时预算 17 秒被吃光、随后 **14 秒零投递**，排在队首的 `sendChatAction` 占的正是 `editMessageText` 要用的槽位。**让一个可丢的请求占住不可丢请求的槽位本身就是错的**；grammY 那个桶没动，它是 Telegram 侧的真实限制 |
| `trigger.channels` 点不亮：频道消息一条都进不来 | 频道消息是 `channel_post` 更新，而 `packages/telegram/src/bot.ts` 里没有这个处理器（`bot.on('message')` 不匹配它），`telegram.allowedUpdates` 的默认值里也没有它。`trigger.ts:45` 那半条判断（`chat.type === 'channel' && !config.channels → null`）因此永远等不到输入 | 不是「以为有其实没有」：那个更新类型在 WebUI 的复选框里标着「无处理器」，配置手册也写了。真要接得先定频道语义 —— 频道里没有「@ 谁」，打开等于对每条频道消息都表态（`descriptions.ts` 里那句话），而 `my_chat_member` 之外还要处理 `channel_post` 的作者身份（频道消息可以没有 `from`） |
| 验收条目 277 条未勾 | 其中人工条目一律保持未勾（要人签字，不是测试的事）；其余是没有对应 vitest 用例的 `(自动)` 条目 | 勾选形式由 `tests/acceptance.test.ts` 定死，勾之前先写用例 |
| 10 条配置键未接线 | 见 [11 §2.0.1](./11-config-reference.md)，每条写明「暂时没做」还是「不该在这一层做」 | 摘键之前先看 [21 §1](./21-webui-coverage-gaps.md) 的复算方法 |
| 自我扩展刚落地（M12），四条通道默认全关 | `tools.selfExtend.*` 出厂 `enabled: false`；打开之后模型能写自定义工具 / skill / plugin，能登记 MCP server | 主闸不是审批而是「落库即禁用，owner 在扩展页点开」。动这一块之前先读 [14 T18/T19](./14-open-questions.md)：**授权时点与执行时点是分离的**，而 `requireSandbox` 默认关时自定义工具就是调用者的 `bash`（因而能直接写 `data/luoli.db` 绕开启用闸）|
| 装 skill 包的通道刚补上（`install_skill` + `POST /api/skills/package`） | 起因：用户在 Telegram 丢了一个带 `scripts/` + `bin/`（4.9 MB ELF）的音乐 skill 包，模型解到**工作目录**、一路 `bash scripts/invoke.sh` 用了起来 —— 能用，但它不是一个 skill：不进目录、不进 `skills` 表、扩展页看不见（`logs/2026-08-18/tool.jsonl` ts 1787036340–1787036441，全程没有一次 `write_skill`）。两条根因：① `tools.selfExtend.skills.enabled` 默认 `false` 且没人开过，`write_skill` 压根不在它的工具目录里，**而它拿不到任何说明为什么没有**；② 就算开着也装不了 —— `write_skill` 只收 `body: string`，`SkillLoader` 只写一个 `SKILL.md`，而 §2.1 的格式一开始就允许附属文件 | 通道见 [07 §2.5 / §6.5](./07-skills-plugins-mcp.md)，解包判据那张表列了每一道挡什么。**「装了一半」整棵回滚**是这条的红线：一个半成品在扩展页上和一个装好的坏 skill 长得一模一样 |
| owner 的 `bash` 绕得过 `skills/**` 的 deny-glob | `selfAuthoringDenyGlobs()` 只叠在 **fs 工具**的 `PathJail` 上（`main.ts` 的 `filesFor`），而 `sandbox.bypassRoles` 默认含 `owner` —— owner 的 `bash` 跑在宿主上不过沙箱，`unzip` 直接写进 `skills/` 没有任何东西挡 | **不算新洞**：owner 的宿主 `bash` 本来就等价于机器读写权限（[14 T8](./14-open-questions.md)），deny-glob 防的是 `write_file` 那条更安静的路。记在这里是因为它解释了「模型其实一直有条野路子，只是不知道」，以及为什么补的是一条**带校验的**通道而不是放开 deny-glob |
| 能力位可以撒谎，**推翻它的路已经落地**；撞上这一轮的那个模型上游已修 | 用户发图，模型连着几轮回与图无关的内容，而链路是好的：`logs/2026-08-19/blobs/` 里 11 份带图请求逐份解开，`image_url` 形状对、base64 解回来是完整可看的 JPEG、`provider.fallback … vision_required` 也记了。坏在末端那个模型 —— 拿一张三色块合成图直接打探针：该网关的 `grok-4.5` 四次全错且每次不同，`prompt_tokens` 恒为 2266 且 `prompt_tokens_details` **没有 `image_tokens`**，每次烧 600–2500 reasoning token 瞎猜；同一家的 `grok-4.3` 一次就对且有 `image_tokens: 42`。而 `capabilities_json.vision` 是按**模型名**从 models.dev 抄来的，官方 grok-4.5 确实有 vision → 这一行写着 `true` → 含图轮次**不切**别名。**2026-08-19 上游已修好那个模型**（该网关此后真的转发图片），所以本部署此刻没有需要标记的模型 —— 留在这里的是**形态与判据**，它会随下一家网关复发：探针用一张三色块合成图，判据是 usage 的 `prompt_tokens_details` 里有没有 `image_tokens`，**不要看目录说什么** | 目录改不了那个事实，所以补的是**推翻它的路**：`PATCH /api/models/:id` 的 `capabilities` + 模型对话框里的三态下拉（[21 §10](./21-webui-coverage-gaps.md) 的 `G-API-17`）。三条纪律：生效值写 `capabilities_json` 顶层、意图写 `manual`（运行时与徽标都读顶层，不必各自再懂一层优先级）；**白名单只放运行时真的会读的能力位** —— 现在只有 `vision`，其余五位纯徽章，给它们做开关就是假开关；`enrich` 必须把标记盖回去，「能力块照写」那句注释在 `supportsVision` 落地之后就不成立了。**另一半仍然是配置**：`vision` 别名链的顺序本身就能让一个瞎模型排在含图轮次前面，此时上面那套机制**一条都不会响**（它只判「当前别名能不能看图」，答案为真就到此为止）—— 那条一直够得着，只是没人知道要去排它 |
| 「清空上下文窗口」是好的，**而清空之后模型自己把历史捞回来了** | WebUI 那次点击真的落库（`context_commits` 里 `seq=154` / `kind='reset'` / `created_by='webui'`，`window_start=575 > head_ordinal=574` 即窗口为空），紧接着那一轮发给模型的请求也确实只有 2 条消息 —— 然后模型第一步就 `read_messages({direction:'before',limit:20})` 把 20 条历史整段捞回来，那份工具结果又作为 ordinal 577 落进新窗口，此后每一轮都带着它（`logs/2026-08-19` · turn `01M0CKK6W018B5KS9613SNEX5J`；用户那句话是「你记得我刚刚说过什么嘛」，模型的动作本身没错）。归档表不受窗口约束是设计（`/new` 一条消息都不删） | 所以这件事变成一个开关而不是一个修复：`context.recallBarrier`（默认关 = 保持原状）。开了之后清空那一刻的 `messages.id` 记进 reset commit 的 `meta.archiveFloor`，三个归档工具只看得到它之后的消息、**并且**背景认领水位一并推过去（两扇门要一起关，否则清空前那些没被认领的群发言照样进新窗口）。三条纪律见 [02 §7.1](./02-context-engine.md)：水位无条件记（开关是运行时的、commit 是不可变历史）、下限灌进 SQL 而不是过滤返回值、被挡住要如实说（`recallBarrier` 字段 / `error:'recall_barrier'`，不伪装成「这条不存在」）。清空后的第一轮还会在 RUNTIME 块里说一句「上下文：刚被清空」—— 不说的话模型把它当自己的失忆去补救，那正是上面那一幕 |
| 会话级持久容器刚落地（`sandbox.persistent`），**默认关** | 打开之后每个群 / 私聊一个常驻容器，执行走 `docker exec`；关着的时候一个字都不变（每次 `docker run --rm`）。它买的是两件 `--rm` 结构上做不到的事：**跨轮次活着的进程**与**出网**。注意**文件本来就是按会话持久的** —— `data/workspace/<chatId>` 一直绑定挂载在 `/workspace` 上，这一轮改的是容器本身（装的包、`/tmp`、跑着的进程）。`readOnlyRoot` 保持 `true`：`HOME=/workspace`，所以 `pip install --user` 装的包本来就落在持久工作区里，缺的只是网 | 规格在 [05 §5.5](./05-tools-and-permissions.md)，六个 owner 工具在 [05 §3.11](./05-tools-and-permissions.md)。三处最容易踩：① **取消不能 `docker kill` 容器** —— 那等于销毁整个会话的环境，而 `/cancel` 与超时走同一个钩子；打进程组，且 `kill` 后面**不能加 `--`**（dash 的内建 kill 认不了，取消会静静失效）。② **后台任务必须重定向到文件**，exec 一结束管道就关，进程下一次写 stdout 吃 SIGPIPE 就死。③ `persistent.network` 与 `sandbox.network` 是**两个键**，前者默认 `bridge`（打开持久化就等于默认开了出网，启动会 warn 一句）。真执行那条路由 `tests/sandbox.containers.docker.test.ts` 覆盖（docker 不可用时整份 skip）—— 上面①正是它逮到的，读码和单测都看不见 |
| **`data/workspace/<chatId>` 至今没有任何回收**，而持久容器不改变这一点 | `MaintenanceService` 一行都没管它，唯一的可见性是 `GET /api/health` 的 `workspaceBytes`。容器到期被回收**不动这里的文件**（那是 `container_reset` 默认不清文件的同一条取舍：容器是环境，workspace 是数据）| 要清只能人工，或用 `container_reset` 的 `wipeWorkspace` 单会话清（挪进 `.luoli-trash`，不真删）。真要做全局回收，判据不能是「多久没动」—— 一个季度不说话的群，它的工作区仍然是它的资料 |
| 一张图会把它**之后的每一轮**都钉在 vision 别名上 | 判据（`turnHasImages`）一直是 `snapshot + delta`，也就是整个上下文窗口。实测一个私聊里 4 条带图消息留在窗口内，此后每一轮纯文本都记 `provider.fallback … vision_required`（`logs/2026-08-19`）—— 纯文本的一句话切走贵的那一档；而一个能看图的别名都没配时，那些轮次的回复末尾还会挂一句「这张图我没能真的看到」，用户那一轮根本没发图 | `media.visionScope`（默认 `window` = 保持原状 / `turn` = 只算本轮新进来的图）。`turn` 档下历史图**只在这一轮真落在看不了图的别名上**时才换成占位文本（占位文本写明「重新发一次或引用那条消息」，那两种都会被算成本轮的图），落在能看图的别名上原样带着 —— 「再看一遍上面那张图」还能用。降档到 `low` 的那一步按**当步别名**再兜一次：`turn` 档下轮次级判据为假，`prepareStep` 那个 vision 覆盖不再拦，而把不透明 part 交给一个瞎模型正是 [08 §7.2](./08-telegram-adapter.md) 禁的事 |
| `web_fetch` 现在会抽标题 / 链接 / 图片，图片也真的进上下文 —— **JS 渲染与反爬仍然没有** | 此前三样东西是「页面上有、模型看不见」：`<title>`（`head` 整棵在 `DROP_TAGS` 里）、`<a href>` 的地址（只留锚文本，模型没法顺着页面走，只能退回 `web_search` 再搜一遍）、`<img>` 的 alt 与 src（`img` 既不在 `DROP_TAGS` 也不在 `BLOCK_TAGS`，扫到它一个字都不 push）。另外**非 HTML 响应被无条件 `toString('utf8')`**：`image/png` 之类产出最多 2MB 乱码再被 64KB 截断塞进上下文，比「取不到」更糟 —— 整个工具输出预算烧在噪声上，而模型以为自己读到了页面。而图片走不通是**三处各自独立**地挡着：抽取层丢掉 img、工具结果被 `JSON.stringify` + 截断 + 包成不可信文本、`isImagePart` 只认顶层 part 所以 vision 切换 / `capImages` / `degradeImages` 一个都认不出它。同一条管道让 **MCP 的截图也是坏的**（`browser_screenshot` 变成一坨截半 base64） | 规格在 [05 §3.6](./05-tools-and-permissions.md)，红线进了 [02 §9](./02-context-engine.md) 第 21/22 条，表在 [03 §2.4](./03-data-model.md)（`web_assets`）。三处最容易踩：① **`gcFiles()` 的 `referenced` 现在要并两张表** —— 漏一张的表现不是报错，是那张表的文件被静默当孤儿删掉（本仓踩过两次）；② **图片有两条通道**，跨轮靠 `webasset://` 顶层 part、本轮靠骑在工具结果上的 `media`，缺一条就是「这一轮看不见」或「下一轮看不见」，而 base64 **绝不许**落进 `parts_json`（`tool-result` 不在 `OPAQUE_PART_TYPES` 里，硬截断会把它切半，而截断结果是持久化的）；③ **vision 判据是轮首快照**，轮内注入的图靠 `turn.mediaInjected` 补，改成「每步重扫 messages」不管用（扫的是同一个认不出它的判据）。**仍然欠的**：JS 渲染（SPA 只能取到空壳）与反爬（UA 是 `LuoLiCore/0.1`，不少站点直接 403）。形态已经定了 —— 接一台浏览器 MCP 而**不是**把渲染引擎接进 `web_fetch`（那会绕开 `guardedFetch` 整套 SSRF 防护，而它还执行页面 JS，URL 预校验挡不住页面自己去打元数据地址），候选与那一整套警告见 [07 §4.4.1](./07-skills-plugins-mcp.md)。值不值得深度集成没拍板 |
| MCP 登录刚落地（OAuth + bearer 凭据库 + `needs_auth`） | 此前这条路**结构上走不通且看不出走不通**：`StreamableHTTPClientTransport` 没传 `authProvider`，而 SDK 那条 401 分支是 `if (response.status === 401 && this._authProvider)` —— `UnauthorizedError` 在本仓库构造不出来，一台要登录的 server 只留下 `state='down'` 加一句 `Error POSTing to endpoint: <原始响应体>`。stdio 那侧 `stderr` 是 SDK 默认的 `'inherit'`，server 打印的授权链接直接进 bot 进程的 stderr，不落库也不上界面 | 规格在 [07 §4.5](./07-skills-plugins-mcp.md)，界面在 [09 §3.8.1](./09-webui.md)。四条红线：① **凭据不进配置** —— `config_kv` 每行都被当配置覆盖层解析，配置还要进 `config_revisions` 与 `/api/config/export`，而按键名判密那条正则匹配不到 `Authorization`（这就是它此前明文外泄的路）；② **连接指纹必须带 `mcp_auth.version`**，否则轮换 token 不改变指纹、旧连接被缓存命中而界面显示「已连接」；③ **`auth.mode: none` 不挂 `authProvider`** —— 无条件挂能让 401 检测免费，代价是替运维去第三方那里跑一遍动态注册；④ **`webui.publicUrl` 没配就不开始授权**，不编一个 127.0.0.1 的 `redirect_uri`（注册进对方那里就不好改了）。回路由 `tests/mcp.oauth.test.ts` 对着一台真的受 OAuth 保护的 MCP server 焊住（PKCE 真验、code 一次性、refresh 真换）|

---

## 3. 查过、没有发现问题的地方

**下一轮先读这三节再决定查什么**，它们是给复审省时间的，每一项都逐文件读过。

| 范围 | 在哪 | 覆盖了什么 |
|---|---|---|
| **真环境跑过的**（第十轮活体测试） | [`reviews/28` §6](./reviews/28-round10-live-system-test.md) | **这一节是读码复审给不出来的**：docker 沙箱真执行（argv/OOM/pids/网络/超时 kill/卷映射/只读根，此前零执行覆盖）、cron 真到点触发与停机错过不补跑（此前全靠手动 `trigger()`）、真人 + 真 Telegram 的毒 markdown 渲染与 `/cancel` 与媒体全类型与 vision 别名切换、真并发 rebase、provider 健康全周期含冷却恢复、审批三条路、SSRF 五类含 DNS rebinding 与重定向、skill 包「装一半整棵回滚」、7 路并发压 SQLite、真浏览器跑 14 页、SSE 四条硬约束、**日志脱敏 400 MB 全量扫描零命中（阳性对照 9/9）**、`reviews/27 · S-01` 复验未回归 |
| 第十轮**排除**掉的 8 条假象 | [`reviews/28` §8](./reviews/28-round10-live-system-test.md) | 下一轮若沿用同一套装置会再撞上：假上游的固定 usage / 非流式判据 / 跨轮复用 toolCallId、`fetch()` 探针的 450 ms 基线、以及两条属历史而非现状的日志形态 |
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
