# 00 · 当前态

> 这份文档回答三个问题：**现在还欠什么**、**哪些地方查过没问题**（免得下一轮重复查）、
> **权威清单在哪儿**。它是活的，跟着代码走。
>
> 复审报告（[`reviews/`](./reviews/)）是**历史快照**，写完即冻结，它们的结论一律不代表现在 ——
> 想知道现在的状态只看本文。反过来，本文**不重抄**别处已经由测试焊住的清单，只指过去：
> 同一个事实有两份副本，迟早会漂。上一次漂的代价是「未接线配置键」在四个地方有三个数字。
>
> 核对时间：2026-08-19（第九轮整改后 + M12 自我扩展落地 + 8-18 两次进程崩溃的收口
> + **第十轮停机活体测试**，见 §2.0）。
> 每一条都回代码查过，不采信文档自述；§2.0 那一批**另外在真环境上跑过**。

---

## 1. 权威清单在哪儿

本文不复制这四张表，改了它们不用回来改这里。

| 问题 | 权威 | 由什么焊住 |
|---|---|---|
| 哪些配置键还没接线 | [11 §2.0.1](./11-config-reference.md)（当前 10 条，每条写明为什么留着） | `tests/config.test.ts` —— 白名单每条必须在 `docs/11` 标记，且标注要跟着 `HOT_RELOADABLE_CONFIG_KEYS` |
| 验收条目的勾选状态 | [13](./13-acceptance-criteria.md)（当前 **171 / 449**） | `tests/acceptance.test.ts` —— 只有标 `(自动)` 且点名真实用例文件的能勾，签署表分子分母自动核对 |
| WebUI 控制面够不着什么 | [21](./21-webui-coverage-gaps.md) | 无自动约束（人工复算，方法见其 §1） |
| 某行代码为什么长这样 | [`reviews/`](./reviews/) 里的条目编号 | `tests/docs.test.ts` —— 编号被源码注释大量引用，删了或改了会报错 |

---

## 2. 还欠什么

按「挡着别人 / 单独可做」分组。**每条都实测过**，括号里是核对时的实际值。

### 2.0 第十轮**活体测试**的发现（[`reviews/28`](./reviews/28-round10-live-system-test.md)）

前九轮都是读码复审；第十轮把系统真的跑起来（真进程 · 真 Telegram · 真 docker · 真时钟 · 真上游），
**只找单元测试结构性看不见的问题**。共 30 条，下面按「先修哪个」排，全部带 `file:line` 与实测值。

**先修这七条：**

| 编号 | 一句话 | 关键位置 |
|---|---|---|
| `L-COST-01` | **缓存命中的 token 被双重计价，生产账面 44.4% 是虚的**（342 条 ledger 里 270 条有缓存命中）。公式按 Anthropic 口径写（input 不含 cached），却用在 openai-compatible 上（input **含** cached）；本部署三个 provider 没有一个是 Anthropic。`quota` 吃的就是这个数 —— 缓存越有效，用户越早被挡 | `ledger/usage.ts:34` + `docs/10 §4.1` 的公式本身 |
| `L-WEB-04` | **YAML 往返会擦掉登录口令哈希**，实例掉回 setup-token 形态。`GET` 因 `looksSecret` 整行跳过 `webui.passwordHash`，`PUT` 用 zod 默认值 `''` 写回并 `DELETE` 旧行。触发条件恰是产品自己推荐的配置（`.env` 注释与 `app.ts:420` 都引导删掉 `WEBUI_PASSWORD`）| `app.ts:568` / `:585-593`、`config/redact.ts:13` |
| `L-EXT-02` | **MCP 子进程死后永远连不回来** —— `connect()` 只比指纹不判活性，cron 与 `/api/mcp/:name/reconnect` 是同一条死路，「重连」按钮结构上点不动任何东西 | `mcp/manager.ts:58` |
| `L-EXT-03` | **每次新增/指纹变更 MCP server 泄漏一个 stdio 子进程**，一条就足以让进程无法优雅退出（实测 SIGTERM 后存活 >100 秒）。根因是一次写入触发两次重叠的 `reconcile()`（`ports.emit` 的订阅者 + 端点自己 await），而 `reconcile()` 无串行化 | `mcp/persist.ts:29` + `main.ts:373` + `app.ts:1491` |
| `L-TOOL-02` | **`tools.fs.allowHostFsForOwner=true` 时 owner 的 fs 工具全线失效** —— `startsWith(root+sep)` 在 root=`/` 时是 `startsWith('//')`，恒为假。连带：为该模式写的那批 deny-glob 从未被真正执行过 | `tools/jail.ts:40` |
| `L-LOG-01` | `docs/10 §2` 那张「`log_events.kind` 枚举」与实现严重脱节：**表里写了、源码零处发出**的有 20 个（含 `tool.denied` / `turn.queued` / `plugin.*` / `sandbox.run` / `agent.*` / `prompt.build`），**源码在发、表里没有**的 36 个（含全库最多的 `tg.api`）。权限拒绝、排队时长、插件行为因此全都不可观测；`AC-LOG-001`/`AC-PLG-004` 按字面不可能通过 | 见报告 §2 |
| `L-LOG-04` | **`parent_span_id` 全库为 NULL** —— 全仓没有任何调用点传过它，Trace「调用树」结构上是一张平表。与 `L-LOG-02` 叠加后，`docs/10 §1` 那张 trace 图**在实现里一条边都不存在** | `log/sink.ts:220` 收得下但零写入方 |

**其余 23 条**（P2 十四条、P3 八条、另有 1 条复核后撤回）见报告 §3–§5。其中值得单独记住的：
`L-OPS-01`（第二个实例启动会就地清掉在位实例的在途轮次与认领）、
`L-TG-04`（群内并发把 per-chat 20/分钟 预算 17 秒吃光、随后 **14 秒零投递** —— `docs/00` 此前记的
「队列不再增长」在并发下不成立）、
`L-WEB-01`（`/webui` 一次性登录整条功能是死的：服务端有完整用例、bot 侧正确、**前端从来不打那个端点**）。

> **这一轮的模式**：找到的东西几乎全部落在「每一半都有测试、没有一条跨过边界」的位置上 ——
> 前后端边界（`L-WEB-01`）、写入侧与读出侧的边界（`L-LOG-04`：读出侧修过一次，
> 修完之后正确地读着一个永远是 NULL 的列）、被整体替换掉的依赖（`L-TG-04`：所有既有用例都把
> `bot.api` 换掉，节流器从没进过测试回路）。

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
| 解析失败的第二级兜底（发 `.md` 文档）没实现 | `sendWithFallback` / `TelegramOutput.edit` 只做了第一级：`can't parse entities` 时以纯文本重发/重编辑一次（`output.ts:161`、`stream-output.ts:98`）。[08 §5.2](./08-telegram-adapter.md) 那条「再失败则把内容作为 `.md` 文档发出并回复一句摘要」压根没有实现，而 AC-OUT-005 一直挂着 `[x]`（**已改回 `[ ]`**） | 第一级现在**记 `tg.parse_fallback` warn** 了（见 [10](./10-logging-and-observability.md) 的事件表），纯文本重发那一跳也包了 try —— 此前它是裸调，第二次失败照样打穿整轮，正是 `sendWithFallback` 的 docstring 说要防的事。**只剩第二级**：再失败则把正文作为 `.md` 文档发出并回复一句摘要 |
| 多步轮次的旁白：分段投递**又改了一次**，从「条件补分隔」变成「归一化」 | 第一版（`result.textStream` 丢 step 边界 → 投递侧 `text +=` 把六句旁白粘成一段，turn `01M09QBZVK…`）改成从 `result.stream` 走 `stepSeparatedText` 补 `\n\n`。**然后反过来空行爆炸**：KERNEL 那条「段间空一行」把模型教成每一步都以 `\n\n\n` 收尾，纯工具步的「正文」就是 `\n\n\n` —— 一条 11 步的回复开头 10 个换行、中段 12 连换行，而这一轮 `stepSeparatedText` **一个分隔符都没插**（logs/2026-08-18 · turn `01M0AKMXG4…`，落库的 assistant part 连那 10 个前导换行一起存了）。现在判据是「扣住尾部空白 + 到点补齐」：纯空白步整段丢弃、步边界恒等于一个空行、首尾无空白，步**内**的空白（列表缩进、围栏代码块里的空行）一个字不动 | 提示词侧同步反转：KERNEL 与 `ASSIST.md` 现在要求「只写那一句，不要自己加空行」。**渲染器不许参与收窄** —— `safeRender` 的空行保真是有测试焊住的既有契约（`tests/output.render.test.ts`）。改投递节奏或换 AI SDK 大版本时先跑 `tests/agent.stream-separator.test.ts`（含那条 11 步真实序列的端到端断言）|
| 一次 tool 输入校验失败能打崩进程 —— 整条链已收口 | 根因是 AI SDK 的 `step.toolResults` = `content.filter(p => p.type === 'tool-result')`，**`tool-error` part 被整个滤掉**，于是 `appendContext` 只把 tool-call 追进 delta。轮内没事（SDK 自己的 `responseMessages` 会把错误转成合法的 tool-result 发上线，那一轮 11 步全成功），下一轮起该会话每次请求都畸形 → 中转站 200 收下、流里 0 步就关闭 → AI SDK 在 flush 里用 `NoOutputGeneratedError` reject `result.text`（派生 promise，SDK 不标 handled）→ `runtime.ts` 那条 `final` 链在创建处没有 catch，而唯一的 catch 排在 `bot.ts` 的 `await consume(...)` 之后（`consume` 开头卡着 `sendChatAction`，实测 561ms）→ `unhandledRejection` → `exit(1)`。实测 2026-08-18 22:17:29 与 23:19:43 两次，`turns` 里两行 `failed / process_restarted / steps=0`，起因是 `get_message({messageId: 0})` 撞上 `z.number().int().positive()` | 五层都在：`stepToolResults` 收 `tool-error`；`commitTurn` 的 `assertPairedToolCalls` 挡新的孤儿（**只查 delta** —— 查 snapshot 会把已损坏的会话彻底锁死）；`contextMessages` 在读出侧给存量孤儿补结果并记 `ctx.orphan_tool_call`（**本次事故那条至今还在 `data/luoli.db` 里**，ordinal 508）；`final` 在创建处 `void final.catch(...)`；`unhandledRejection` 不再 `exit(1)`（[10 §2](./10-logging-and-observability.md)）。可见性也补了：流里的 `error` 部件与 0 步空流各记一条 `model.error`（`source:'stream'`）—— 两次崩溃在 `model.jsonl` 里此前完全隐形。红线进了 [02 §9](./02-context-engine.md) 第 20 条 |
| 含图轮次自动切 `vision` 别名刚落地 | 三处文档（[04 §5.2](./04-agents-and-providers.md)、[08 §7.2](./08-telegram-adapter.md)、`AC-PROV-009`）都写了、代码里一行都没有 —— `capabilities_json` 只有 WebUI 的徽章在读，`docs/03` 自己承认过「运行时不读这一列」。表现是模型看不见图却不知道自己看不见：实测它去 cp 文件、python 读尺寸、开本地 http 服务器、拿 agent-browser 截图，绕 11 步也没看到那张图；它还调了 `set_model('vision')` 并对用户说「切好啦」，而那个覆盖只在当轮生效（logs/2026-08-18 22:15） | **vision 压过一切**：压过 `downgradeAfterStep`，也压过 `set_model` 的当轮指定。`ModelRegistry.supportsVision(alias)` 必须先 `#models.has` —— `info()` 走 `#pick`，别名不存在时静默回落到 `main`，直接问就恒为真。一个能看图的别名都没有时才降级（图片换文本占位 + 回复末尾一句提示，走 `stepSeparatedText` 的收尾通道）。`set_model` 的 description 与返回值现在都写明「仅本轮」|
| 收尾补跑（`wrapUpIfNeeded`）刚落地 | 最后一步没有正文时（以工具调用或纯 reasoning 收尾）追加**一次**禁工具的模型调用让模型自己写结论。四道闸：最后一步无正文、本轮真的调过工具、`streamFailure` 为空、单轮成本闸有余量 | 它同时修掉了定时任务那条路的静默失败（`runMainAgent` 拿的也是「最后一步正文」，以工具调用收尾就空正文 → `model_returned_empty`）。**不伪造答复**是这条的红线（[16 §5](./reviews/16-remediation-plan.md)）：补跑是让模型自己说，不是替它编一句 |
| provider 健康检查刚落地，粒度是 **provider 而不是模型** | 周期探测（`provider/health.ts`，[04 §5.3](./04-agents-and-providers.md)）此前压根不存在：那个 cron 只调 `ModelRegistry.rebuild()`，一次探测都不发，于是「上游连上了但不返回」没有任何一处会记住 —— 实测 `logs/2026-08-18` 三个轮次各在开轮 363 秒后才 fallback（`3 × requestTimeoutMs` + 退避），一轮 600 秒最多够走一步，全部以「太久没有进展」收尾，而库里那行 `health_state` 始终是 `up` | 健康状态挂在 `providers` 上（`health_state` / `health_fail_count`），**不是挂在模型上**：一个 provider 被判 down，它下面所有模型一起从各自的别名链里消失（本部署 ksm-api 被判 down 会连带 `high` 的链首 `gpt-5.6-sol`）。这是 [04](./04-agents-and-providers.md) 现在的口径，要改成按模型判就得先改那份文档 + 加一张表。**判据的四条已经过了一轮复审并改齐**（`tests/provider.health.test.ts`）：计数单位是「一次调用一个候选」而不是一次尝试（按尝试记时 `maxRetries: 2` 的一次慢调用就能判死一个好 provider）、服务成功一次就归零（否则「连续」是「累计」，而计数在库里、重启也不清）、冷却到期时把库里那一行也改回 `up`/0（只在内存里放行会 30 分 down / 一个 cron 间隔 up 地抖）、cron 里**先 rebuild 再探**（`#probes` 是上一次 rebuild 的产物，反过来探不到刚放回来的那个）。另一条已知的：调用路径上把最后一个 provider 判成 down 时，`all_providers_down` 要等下一次 cron 才响（那条尾巴在 `main.ts` 的 `rebuildModels`，`recordFailure` 刻意不 rebuild —— 轮次中途换链会让这一步的记账反查不到服务它的那一行） |
| `turnTimeoutMs` 是硬边界，但**收尾那一条消息还是要发出去** | 到点后模型调用当场断，投递侧现在看得见（流会抛，轮次记 `failed` + `error='turn_timeout'`、`cancel_reason='timeout'` 而不是 committed，**也不是 `cancelled`** —— 超时是故障，要计入 `consecutive_turn_failures`，否则「每一轮都卡满十分钟」这种最该响的故障一次都不响，见 [04 §5.3](./04-agents-and-providers.md) 的三档）；但已经在屏幕上的内容要补一个「（生成中断）」（一个字都没投出去时不补，改为把那条占位消息删掉），那一次 `editMessageText` 要排 `telegram.throttle.perChatPerMinute`（群聊默认 20/分钟）的队 | 所以一轮的墙钟仍可能超出 `turnTimeoutMs` **一个 API 调用**的时间。此前超的是 3 分钟：typing 是 4 秒一发的 fire-and-forget（15/分钟），同一个群两轮并行就压满了那 20/分钟的预算，队里全是过期的 typing 而真正的消息排在最后（logs/2026-08-18 · B8F92Z）。现在 typing 上一拍没落地就跳过这一拍（`tests/output.pacing.test.ts`）。**但「队列不再增长」只在单轮成立** —— 第十轮实测：同一个群里 6 轮并发时 20/分钟 的预算 17 秒被吃光，随后 **14 秒零投递**，一次 `editMessageText` 排队 14028ms。那个修复减少了 typing 的**数量**，但 typing 与正文编辑仍共用同一份 per-chat 预算（`reviews/28 · L-TG-04`）|
| 验收条目 273 条未勾 | 其中人工条目一律保持未勾（要人签字，不是测试的事）；其余是没有对应 vitest 用例的 `(自动)` 条目 | 勾选形式由 `tests/acceptance.test.ts` 定死，勾之前先写用例 |
| 10 条配置键未接线 | 见 [11 §2.0.1](./11-config-reference.md)，每条写明「暂时没做」还是「不该在这一层做」 | 摘键之前先看 [21 §1](./21-webui-coverage-gaps.md) 的复算方法 |
| 自我扩展刚落地（M12），四条通道默认全关 | `tools.selfExtend.*` 出厂 `enabled: false`；打开之后模型能写自定义工具 / skill / plugin，能登记 MCP server | 主闸不是审批而是「落库即禁用，owner 在扩展页点开」。动这一块之前先读 [14 T18/T19](./14-open-questions.md)：**授权时点与执行时点是分离的**，而 `requireSandbox` 默认关时自定义工具就是调用者的 `bash`（因而能直接写 `data/luoli.db` 绕开启用闸）|
| 装 skill 包的通道刚补上（`install_skill` + `POST /api/skills/package`） | 起因：用户在 Telegram 丢了一个带 `scripts/` + `bin/`（4.9 MB ELF）的音乐 skill 包，模型解到**工作目录**、一路 `bash scripts/invoke.sh` 用了起来 —— 能用，但它不是一个 skill：不进目录、不进 `skills` 表、扩展页看不见（`logs/2026-08-18/tool.jsonl` ts 1787036340–1787036441，全程没有一次 `write_skill`）。两条根因：① `tools.selfExtend.skills.enabled` 默认 `false` 且没人开过，`write_skill` 压根不在它的工具目录里，**而它拿不到任何说明为什么没有**；② 就算开着也装不了 —— `write_skill` 只收 `body: string`，`SkillLoader` 只写一个 `SKILL.md`，而 §2.1 的格式一开始就允许附属文件 | 通道见 [07 §2.5 / §6.5](./07-skills-plugins-mcp.md)，解包判据那张表列了每一道挡什么。**「装了一半」整棵回滚**是这条的红线：一个半成品在扩展页上和一个装好的坏 skill 长得一模一样 |
| owner 的 `bash` 绕得过 `skills/**` 的 deny-glob | `selfAuthoringDenyGlobs()` 只叠在 **fs 工具**的 `PathJail` 上（`main.ts` 的 `filesFor`），而 `sandbox.bypassRoles` 默认含 `owner` —— owner 的 `bash` 跑在宿主上不过沙箱，`unzip` 直接写进 `skills/` 没有任何东西挡 | **不算新洞**：owner 的宿主 `bash` 本来就等价于机器读写权限（[14 T8](./14-open-questions.md)），deny-glob 防的是 `write_file` 那条更安静的路。记在这里是因为它解释了「模型其实一直有条野路子，只是不知道」，以及为什么补的是一条**带校验的**通道而不是放开 deny-glob |

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
