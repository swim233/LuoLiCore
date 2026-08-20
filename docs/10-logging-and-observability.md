# 10 · 日志、成本与配额

需求原文：「每次模型调用/工具调用等 都要有独立的日志」。落地为 **trace/span 模型**：一个 turn = 一条 trace，其中每次模型调用、每次工具调用、每个子 agent、每次 Telegram API 调用、每次上下文操作都是一个独立 span，可单独检索、单独查看完整 payload。

## 1. Trace 模型

```
trace_id = turn_id                        （命令类操作用 cmd_<ulid>；定时任务用 job_<ulid>）
                                          定时任务一旦开出轮次，trace_id 就是那一轮的 turn_id；
                                          `job_<ulid>` 只用在开轮之前（跳过、错过、装载）
span_id  = ULID
parent_span_id = 上级 span

turn 01J8…                                     kind=turn.start（spanId = turn 根）/ turn.end
├── turn.queued                                只在真的排过队时才落，带 waitedMs
├── ctx.open        span A  parent=turn        claimed=3, base=c041
├── prompt.build    span B  parent=turn        blockTokens=…
├── model.call      span C  parent=turn        #1 main→claude-opus-5
│   ├── tool.call   span D  parent=C           spawn_agent(researcher)
│   │   ├── agent.spawn     parent=D           派出去那一刻就落，不等它跑完
│   │   ├── agent.run  span E  parent=D        sub run_id=…
│   │   │   ├── model.call  span F parent=E
│   │   │   ├── agent.progress    parent=E
│   │   │   └── tool.call   span G parent=E    grep
│   │   │       └── agent.ask  span H parent=G ask_parent 本身是一次工具调用
│   │   │           ├── model.call  parent=H   仲裁（low 档，一步，无工具）
│   │   │           └── agent.answer parent=H  source=arbiter
│   │   └── agent.end       parent=E           steps, costUsd
│   └── tool.error          parent=C           模型给了非法参数：SDK 内部就拒了，execute 没被调到
├── model.call      span J  parent=turn        #2
├── tg.send         span K  parent=turn
├── tg.edit         span L  parent=turn        （×N，聚合为一条带 editCount）
├── tg.action       span M  parent=turn        （×N，聚合为一条带 count）
└── ctx.commit      span N  parent=turn        rebase, prune
```

- span 落 `log_events` 一行（含 `duration_ms`），大 payload 落 `logs/<date>/<kind>.jsonl` 并在行里记 `file_ref`。
- WebUI Trace 视图按 `parent_span_id` 重建树（[09 §3.10](./09-webui.md#310-日志logs)）：depth 由父链长度算，
  **环与悬挂父都按 depth 0 渲染** —— 一次查询只取 500 行，子 span 的父完全可能不在这一页里，
  而一条坏数据不该把整个视图打成空白。

**父边一律显式传，不用 AsyncLocalStorage。** 全仓零处使用隐式上下文，而「当前 span」这种
进程内隐式状态与 [01 §3.1](./01-architecture.md) 那张表相冲。四条边各自的载体：

| 边 | 载体 |
|---|---|
| turn 根 → `ctx.*` / `prompt.build` / `model.call` / `tg.*` / `turn.end` | `RuntimeTurnContext.rootSpanId`（`openTurn` 生成一个 ULID） |
| `model.call` → `tool.call` | `onStepStart` 把该步 span 的 id 写进 `ToolExecutionContext.parentSpanId`（步是串行的，同一步里并行的工具调用共享同一个父，正确） |
| `tool.call` → 子 agent / 子调用 | `ToolRegistry.execute()` 建完 span 后**浅拷贝**一份 context 交给 `tool.execute`（改共享对象的话，同一步里并排的多个 `spawn_agent` 会互相顶掉） |
| `agent.run` → 子 agent 内部 | `runSubAgent` 建 `agent.run` span，它的 `model.call` / `tool.call` 都挂在它之下 |

此前 `parent_span_id` 这一列**从来没有任何调用点写过**：staging 库 `total 15841 / with_span 11354 /
with_parent 0`，浏览器里展开一条 trace，13 个节点的 `marginLeft` 全是 `0px`。读出侧修过一次
（`ConsoleView.vue` 开头那段注释），修完之后**正确地读着一个永远是 NULL 的列**
（[reviews/28](./reviews/28-round10-live-system-test.md) · L-LOG-04）。

## 2. 事件种类（`log_events.kind` 枚举）

这张表与实现是**双向焊住**的：`tests/docs.test.ts` 把这一列的 kind 集合与 `packages/*/src` +
`apps/*/src` 里的 `kind:` 字面量集合逐条比对，多一个少一个都会红。加日志点要同时加一行；
新增的**非日志** `kind:`（principal 的 `user`/`chat`、message 的 `text`、commit 的 `turn` 之类）
要进那条断言的排除名单。此前这张表与实现严重脱节：表里写了源码零发出 19 个、源码在发表里没有
约 35 个（含全库 78% 的 `tg.api`），而 `docs/13` 的 `AC-LOG-001` 按字面永远不可能通过
（[reviews/28](./reviews/28-round10-live-system-test.md) · L-LOG-01）。

| kind | level | 关键字段 |
|---|---|---|
| `tg.update` | debug | updateId, type, chat, user |
| `tg.api` | info / error | method, ok, ms —— **传输层**那一行，装在 grammY 的 API transformer 里。它**没有 traceId**：transformer 拿不到 turn/chat 上下文（生产库 9745 条里 `trace_id IS NULL` 的是 9745 条），所以「这一轮发了什么」要看 `tg.send` / `tg.edit` / `tg.action`，这一条只回答「那次 HTTP 调用花了多久」。`durationMs` **含节流排队与全部重试退避** —— transformer 装在 `autoRetry` 与 `apiThrottler` **之后**，而 grammY 后装的在最外层，所以重试次数在这一行里看不出来。关停期间被 `UpdatePoller.stop()` abort 掉的在途 `getUpdates` 记 `info` + `reason:'shutdown'`：生产库 42 条 error **42/42** 落在某次 `system.stop` 的 3 秒内，也就是说这个部署至今没有过一次真实的 Telegram API 故障，而真出故障时与正常重启在日志里长得一样（[reviews/28](./reviews/28-round10-live-system-test.md) · L-TG-01） |
| `tg.membership` | info | status —— bot 被拉进 / 踢出一个会话 |
| `access.denied` | info | userRole, chatRole —— `blocked` 主体的消息不开轮次 |
| `media.download` | info（`skipped`/`failed` 时 **warn**） | attachmentId, kind, bytes, ms, state（`done` \| `skipped` \| `failed`）, reason。入站附件的下载与归一化。没有 traceId —— 它跑在开轮之前 |
| `media.extract` | info（`failed` 时 **warn**） | attachmentId, kind, chars, ms, state, error —— 文档正文提取。提取失败**不算**下载失败（文件已经在盘上了），所以它是独立一行 |
| `trigger.matched` / `trigger.skipped` | debug（编辑那一路 info） | reason —— 一个三元发出点，两个 kind 共用一处 |
| `trigger.cooldown` | debug | cooldownMs, sinceMs —— `trigger.cooldownMsPerUser` 压住了这一条。它已降级成背景消息，下一轮照样进上下文 |
| `trigger.coalesced` | debug | coalesceMs —— `concurrency.coalesceSameUserMs` 窗口内被同一个人后面那条取代 |
| `quota.check` | info（未知拒绝档 warn） | scope, spent, limit, decision。并发与频率两档也走它（`rejection`, `limit`）—— 那两档与金额无关，见 [§5.1](#51-层级) |
| `quota.exceeded` | warn | scope, subject, spent, limit —— 与 `quota.check` 同一个三元发出点。`quota.enabled=false` 时**一条都不落**（预留恒为空，此前每轮都记一条假的超限） |
| `turn.queued` | info | active, queued, waitedMs —— **只在真的排过队时才落**（`TurnConcurrency.available(key)` 为假）。`turn.start` 也带 `waitedMs`：少了这两样，「bot 半天不回」是排队还是上游慢，日志里分不出来（[reviews/28](./reviews/28-round10-live-system-test.md) · L-LOG-01） |
| `turn.start` / `turn.end` | info（`turn.end` 断掉时 **warn**） | key, initiator, role, steps, costUsd, state, waitedMs。`turn.start` 的 `spanId` 就是这条 trace 的根，`turn.end` 挂在它之下。`turn cancelled/timed out/failed after partial delivery` = 已经吐过内容之后才断的那一路（[04 §5.3](./04-agents-and-providers.md) 的三档）：delta 提交了、状态不是 committed，`deliveredChars` 是留在屏幕上的字数。`turn timed out` = `turnTimeoutMs` 到点（`state='failed'`、`error='turn_timeout'`、`cancel_reason='timeout'`），与用户 `/cancel` 分开记 |
| `turn.cancel` | info | cancelled —— WebUI 点的取消（`POST /api/turns/:id/cancel`）。`false` 表示那一轮已经收尾了 |
| `turn.wrap_up` | **warn** | chars（最后一步没有正文，补跑了一次收尾；失败时带 error） |
| `turn.no_final_text` | **warn** | streamedChars, messages（补跑也没救回来，回落到流里攒到的文本） |
| `ctx.open` | debug | baseCommit, claimed, snapshotTokens, snapshotMsgs |
| `ctx.commit` | info | commitId, rebased |
| `ctx.rebase` | **warn** | base, onto |
| `ctx.prune` | info | fromOrdinal, toOrdinal, levels[], tokensBefore/After。空闲超期补裁那一次带 `reason:'idle_expired'` 且没有 traceId（它跑在开轮里，那时 turnId 还没交出去） |
| `ctx.hardcap` | warn（读出侧兜底耗尽时 **error**） | stepNumber, cap, before/after |
| `ctx.abort` | warn（清理本身失败时 **error**） | messages / error —— 轮次中止那一路：`cancel.commitPartial` 提交了半份 delta、或者只释放认领。`abortTurn failed; turn still recorded as ended` 那条 error 说的是「清理挂了但状态记住了」 |
| `ctx.invalid_shape` | error | key —— `assertValidShape` 在读出或写入侧拒收了一份形状。**这条会话的历史是坏的** |
| `ctx.token_calibration` | warn | estimatedInput, realInput, ratio —— 估算与真实相差超过 20% 才记。生产库里它是 warn 级第二多的一种 |
| `ctx.image_placeholder` | info | alias, scope, reason —— `media.visionScope='turn'` 那一档：本轮没有新图、而这一轮的别名看不了图，于是更早轮次留在窗口里的图片整体换成占位文本（[08 §7.2](./08-telegram-adapter.md)）。它**不是** `vision_unavailable`：那一档是「用户此刻发的图也看不了」，要在回复末尾道歉；这一档用户这一轮根本没发图，什么都不该对他说，所以只有这一行日志能解释「它为什么说看不到上面那张图」 |
| `prompt.build` | debug | blockTokens{kernel,character,assist,catalog,pubmemory,primemory,runtime}, total, truncated[] |
| `prompt.truncated` | **warn** | truncated[], blocks, maxTokens —— 预算被 catalog + runtime 吃满时 CHARACTER.md 会被整段截成一句提示，人格静默消失 |
| `model.call` | info（服务的候选 ≠ 链首时 **warn**） | alias, servedProvider, servedModelId, stepNumber, usage, ms, finishReason, costUsd, request/response。**摘要行里写的是真正出力的那个候选**，不是链首：span 在 `onStepStart` 开、`onStepEnd` 关，而链内 fallback 发生在 `fallbackLanguageModel` 中间件内部、AI SDK 看不见（`wrapLanguageModel` 让 SDK 可见的永远是链首）。此前这一行记的是**失败的候选**，同一次调用在日志与 `usage_ledger` 里指向两个不同的 provider（[reviews/28](./reviews/28-round10-live-system-test.md) · L-PROV-01），而 [§7](#7-可观测性验收要点) 第 3 条要求「每次模型调用能看到 provider/模型/别名」。所以 `span().end()` 有一个可覆盖 `summary` 与 `level` 的入口 —— `summary` 是列不是载荷，改不了它就只能在载荷里说 |
| `model.error` | warn / error | alias, modelId, errorKind, status, retryAttempt, willRetry, willFallback；整条链耗尽时 `cause`，流里的 `error` 部件与 0 步空流时 `source:'stream'`。**每一次失败的尝试一行**（warn），整条链耗尽时再一行（error）。只落最后那一条时，「熬满三次超时再 fallback」在日志里就是一段什么都没有的空白 —— `logs/2026-08-18` 那 363 秒只有开头的 `turn.start` 与结尾的 `provider.fallback`，中间靠 `3 × requestTimeoutMs + 退避` 的算术反推 |
| `provider.fallback` | warn | from, to, reason。`to` 是**真正会被尝试的下一个候选**（跳过已 down 的），不是链数组里的下一个；`reason='skipped_down'` 是「这个候选因为已 down 被跳过」那一路 —— 不落它的话，链 A→B→C 而 B 已 down 时日志写「A → B」而实际服务的是 C（[04 §5.3](./04-agents-and-providers.md)） |
| `provider.health` | info/warn/**error** | provider, state, ms, failures, status。error = 这一次把 provider 判成了 `down`（[04 §5.3](./04-agents-and-providers.md)） |
| `provider.catalog` | info/warn | outcome, models, error —— models.dev 的模型目录拉取结果（[04 §5.4.1](./04-agents-and-providers.md)） |
| `tool.call` | info | **input**（工具参数）, output, ms, ok；失败时 input + error。一个 span 只落一行，所以开始时的 `input` 与结束时的 `output` 是**合并**进同一行的 —— `LogSink.span().end()` 曾经用结束载荷整体顶掉开始那份，于是这一行只有 `output`，WebUI 的对话详情因此永远看不到工具输入（`tests/log.span.test.ts`） |
| `tool.denied` | warn | tool, reason, role, error —— **准入闸的每一次拒绝一行**。`reason` 穷举：`unknown_tool` / `disabled_after_errors` / `disabled_by_operator` / `role` / `subagent` / `unavailable` / `allowlist` / `skill_narrowed` / `rate`（`tools.maxCallsPerTurn`）/ `approval`。`ToolRegistry.admit()` 刻意是**只读**判定（不写状态、不记日志），所以这一行由 `execute()` 记。此前整批闸门全是静默的：实测 45 次调用恰好 40 条 `tool.call`，超出的**零日志**，模型侧只收到一句不带 hint 的 `tool_call_limit_exceeded`（[reviews/28](./reviews/28-round10-live-system-test.md) · L-LOG-01） |
| `tool.error` | warn | tool, toolCallId, errorKind, message —— 模型给了**非法工具参数**：校验发生在 AI SDK 内部（`AI_InvalidToolInputError`），`ToolRegistry.execute` 根本没被调到，于是 `tool.call` 计数是 0，唯一痕迹是上下文里那条 `output.type='error-text'` 的 tool-result，而它下一轮就被 `prune_level=1` 抹掉。这一行从 `stepToolResults` 收到的 `tool-error` part 上记。2026-08-18 打崩进程的事故起点正是 `get_message({messageId:0})`（[reviews/28](./reviews/28-round10-live-system-test.md) · L-LOG-03）。注册表自己的入参校验失败（`inputSchemaFor` 收窄过的那一档）走同一个 kind，`errorKind='invalid_input'` |
| `tool.disabled` | warn | tool —— 运维在 WebUI 关掉的工具被调用（目录之外的第二道硬拦截）。这一档**同时**记 `tool.denied`：那一条是统一的拒绝流水，这一条是运维视角的凭据 |
| `tool.disabled_after_errors` | warn | tool, failures —— 同一工具连续失败到 `tools.maxConsecutiveErrors`，本轮停用。这条是排障时区分「模型没试」和「试了被拦」的唯一凭据 |
| `tool.registry_truncated` | warn | total, visible —— 可用工具数超过 `tools.maxRegistered`，目录被截断 |
| `tool.external_conflict` | warn | source, existing —— 两个来源想注册同一个工具名，后来的被拒 |
| `tool.custom_defined` / `tool.custom_removed` | info | tool —— 自撰写工具的增删（[07](./07-skills-and-extensions.md)） |
| `tool.custom_invalid` | warn | tool —— `custom_tools` 里那一行注册失败（schema 坏了、超时值非法） |
| `tool.mcp` | info | ms —— 一次 MCP 工具调用（`server/tool` 在 summary 里）。它是 `tool.call` 之下那一跳真正出网的部分 |
| `sandbox.run` | info（`ok=false` 时 **warn**） | mode, image, exitCode, ms, oom, killed, truncated, role, denied —— 每一次沙箱执行一行，**被拒的那一档也落**（模型侧只看到一句工具失败，而「为什么」是配置层的事）。`killed` 分不出是超时、取消还是输出超限，看 `truncated` 与 `ms`（[05 §5.2](./05-tools.md)）。带 traceId 但**没有 parentSpanId**：沙箱是 `bash` / `python` / 自撰写工具三条路共用的底层，只交出事实、不认识 span —— 所以它在 trace 里是 depth 0，而「哪次工具调用引起的」按时间与 `tool.call` 对照。`turnId='adhoc'`（探测、非轮次调用）那些连 traceId 都没有 |
| `sandbox.unavailable` | error | 启动探测发现 `sandbox.mode=docker` 但 docker 不可用 —— 执行类工具会整批失败 |
| `sandbox.weak_isolation` | warn | `sandbox.mode=jail`：只有 ulimit + 目录隔离，不是安全边界。模式变了才再说一次。**`sandbox.persistent.network=bridge` 也走这一条**（持久容器默认能出网，而可审计出站代理没有实现，[05 §5.5](./05-tools-and-permissions.md)）：同样按「变了才再说一次」去重 |
| `sandbox.container.created` | info | chatId, name, image, specHash, ms, hasSetsid —— 给某个会话建了一个持久容器（[05 §5.5](./05-tools-and-permissions.md)）。`hasSetsid=false` 意味着**取消杀不干净整个进程组**，排障时先看这一位 |
| `sandbox.container.reaped` | info | chatId, name, reason(`idle`/`hard`/`respec`/`reset`/`orphan`/`exited`), aliveProcs, ageMs —— 销毁一个持久容器。**`aliveProcs` 是这一行存在的理由**：容器一没，那个会话里跑着的 server 就没了，而用户看到的只是「它突然不工作了」 |
| `sandbox.container.limit` | warn | chatId, used, max —— 撞上 `sandbox.persistent.maxContainers`，**没建**并把错交回模型。不退回一次性容器，所以这一行是运维侧唯一的信号 |
| `sandbox.container.reconciled` | info（有孤儿时 **warn**） | adopted, dropped, orphans, exited —— 每个 `reapCron` tick 与启动时的 DB ↔ docker 双向对账。`orphans>0` 表示有带 `luoli.managed` 标签却不在库里的容器被 `rm -f` 了 |
| `sandbox.container.exec` | info（`ok=false` 时 **warn**） | chatId, name, exitCode, ms, background, killed —— 持久容器里的一次 `docker exec`，**只有 `container_*` 工具那条路会落**（`bash` / `python` 走 `Sandbox.run`，记的仍是 `sandbox.run`）。两者并列而不是互相取代：`sandbox.run` 记「工具要执行一段命令」，这一条记「owner 点名往某个会话的容器里执行」 |
| `approval.pending` / `approval.decided` | info（拒绝与过期 **warn**） | id, tool, risk, channel, actor, expiresAt, ms。`pending` 是「已经推给 owner，等裁决」那一刻（文档此前叫 `approval.requested`，实现里从来是 `pending`） |
| `approval.expired` | warn | id, risk —— `ttlMs` 到点没人裁决，按拒绝处理 |
| `approval.unavailable` | warn | risk —— 没有任何裁决通道（`webui.enabled=false` 或一个 SSE 连接都没有），命中规则的调用当场被拒（[reviews/24](./reviews/24-review-round9.md) · R-APPR-01） |
| `approval.no_rules` | warn | conditional[] —— `approval.enabled=true` 但 `approval.rules` 是空的：0 条规则时 `conditional` 等于 `never`，门是开着的 |
| `approval.disabled` | warn | 审批整块关掉，高危工具不经复审直接执行 |
| `approval.receipt_failed` | warn | error —— 回执发不回发起人所在的会话 |
| `agent.spawn` | info | runId, name, depth, modelAlias, taskChars —— **派出去那一刻就落**，不等它跑完。`agent.run` 只在结束时才落库（span 的语义），所以一个卡住的子 agent 只有这一行能证明它存在 |
| `agent.run` | info（失败时 **warn**） | runId, name, alias, steps, costUsd, ok, ms —— 子 agent 那一整段的**容器 span**：它的 id 是内部 `model.call` / `tool.call` 的父。父是派发它的那次 `tool.call`（[§7](#7-可观测性验收要点) 第 4 条） |
| `agent.end` | info（失败时 **warn**） | runId, name, steps, costUsd, ok, error, summaryChars |
| `agent.ask` / `agent.answer` | info | askId, fromRun, toRun, source(rule/arbiter/timeout), ms。`agent.ask` 是一个 span（父是 `ask_parent` 那次 `tool.call`），`agent.answer` 挂在它之下。**没有 `source='user'`** —— 转人工那一级没实现（[04 §4.3](./04-agents-and-providers.md)） |
| `agent.ask_unarbitrated` | warn（取消时 info） | askId, agentRunId, reason(no_model/cancelled/timeout/failed/empty), detail, escalationRequested —— 仲裁没能给出答复，子 agent 接下来按「没人应答」走。`escalationRequested:true` 表示运维开了 `agent.askEscalateToUser` 但那个键仍未接线，**没有真的去问人** |
| `agent.file_invalid` | error | file, error —— `agents/<name>.md` 解析失败。其余定义照常加载，所以这一行是「我加的那个 agent 为什么不存在」的唯一凭据（[04 §3.1](./04-agents-and-providers.md)） |
| `agent.harness` | info/warn | dir, command, exitCode, timedOut, ms —— M11 起了一次外部 harness。**它内部干了什么不在这里**（也不在任何地方），本系统看不见（[14](./14-open-questions.md) T17） |
| `agent.progress` | debug | phase, done/total —— 子 agent 每跑完一步一条（`phase:'step'`），加上模型自己调 `report_progress` 那一条 |
| `memory.read` / `memory.write` | info | scope, subject, op, bytesAfter |
| `memory.owner_read_private` | **warn** | targetUserId |
| `memory.hard_limit` | warn | scope, subject, tokens, hardLimit —— 这次写入被硬上限挡掉了 |
| `memory.compact` | info | pending —— 压缩复审的定时提醒（`memory.compactCron`） |
| `skill.load` | info（解析失败 **error**） | name, tokens, minRole, allowedTools, requiresTools, error。**只在那份 skill 真的变了时才落**（`scan()` 自己算的 `name → 内容哈希` 签名）：watcher 一次保存能连发好几个事件，逐次记等于把一次 `install_skill` 写成几十行。解析失败这一档与 `agent.file_invalid` 对称 —— 少了它，「我加的那个 skill 为什么不存在」只能去翻 `skills.load_error` 那一列 |
| `skills.disabled` | info | `skills.enabled=false`：目录整块不扫，一份说明书都不进工具目录 |
| `plugin.hook` | debug | plugin, hook, ms —— **只记慢的那一次**：判据是 `ms >= max(50, plugins.hookTimeoutMs / 10)`，也就是「已经吃掉超时预算 10% 的那一次」。钩子每轮要跑好几次（`onToolCall` 是每次工具调用一次），逐次记会把 `logs.level='debug'` 的部署刷爆，而「这个钩子跑了 3ms」不是任何排障问题的答案。运维调紧 `hookTimeoutMs` 时这条线跟着紧 |
| `plugin.error` | warn | plugin, hook, message, errors, disabled —— **每一次**失败都记。此前只有累计到 `plugins.autoDisableAfterErrors` 时才经告警落一行，而那一行还受 `alerts.on`（默认 `[]`）与 `dedupeMinutes` 管：实测一个三轮必抛的 `beforeTurn`，与 plugin 有关的日志 **0 条**（[reviews/28](./reviews/28-round10-live-system-test.md) · L-LOG-01）。加载失败与目录重扫失败走同一个 kind（`phase:'load'` / `'rescan'`） |
| `plugin.hot_reload_unreliable` | warn | entry —— 这个运行时下热重载会「成功」但仍跑旧代码（tsx 的 loader 按路径缓存模块）。修不了，只能说出来（[reviews/28](./reviews/28-round10-live-system-test.md) · L-EXT-04） |
| `plugins.disabled` | info | `plugins.enabled=false`：一个 plugin 都不加载，钩子链是空的 |
| `mcp.connect` / `mcp.error` | info/warn | server, transport, tool |
| `mcp.disconnect` | info/warn | server —— 连接断开（warn，下一次 reconcile 会重连）或从配置里移除（info） |
| `mcp.auth` | info/warn | server, status, authMode —— 登录相关的每一步：开始授权 / 换到 token / 授权被拒 / 注销 / **判定为「要登录」**（[07 §4.5](./07-skills-plugins-mcp.md)）。「要登录」刻意不记成 `mcp.error`：它跟「连不上」要人做的事完全不同 |
| `mcp.stderr` | warn | server —— stdio 子进程 stderr 的**逐行**转发（单行截到 2 KB）。SDK 的默认是 `stderr: 'inherit'`，于是一台 server 打印的「打开这个链接授权」「缺 XXX_TOKEN」直接写进 bot 进程的 stderr：不进这里、不落库、界面上一个字都没有 —— 而那恰好是「它为什么连不上」的答案 |
| `tg.send` | debug（失败 **warn**） | chatId, messageId, chars, ms, error, path（`stream` \| `once` \| `final` \| `tool` \| `fallback`）—— **投递层**那一行，带 traceId。`tg.api` 拿不到 turn 上下文，所以「这一轮到底发了什么、编辑了几次」只有这三条回答得了（[reviews/28](./reviews/28-round10-live-system-test.md) · L-LOG-02）。**失败档在五条路径上都要落**：`tool` 那条把上游报错吞成 `ok:false` 交回模型、`once` / `fallback` 抛出去记成整轮失败，两种都不落的话「消息被 Telegram 拒收」在带 traceId 的日志里一个字都没有 |
| `tg.edit` | debug | chatId, messageId, editCount, chars, ms —— **一轮聚合成一条**（[§1](#1-trace-模型) 那张图）：一次流式回复能编辑几十次，逐次记只是噪声 |
| `tg.action` | debug | chatId, count, ms —— typing 同样聚合成一条 |
| `tg.error` | warn | method, description, retryAfter |
| `tg.parse_fallback` | **warn** | chars, error, phase(`send` \| `edit`) —— `parseMode` 渲染被 Telegram 拒收（`can't parse entities`），已降级成纯文本重发/重编辑一次。**这一跳此前一个字都不落**，于是行内代码那个 bug 只能靠翻下一次模型调用的 context blob 反推。第二级兜底（发 `.md` 文档）仍未实现，见 [00 §2.3](./00-state.md) |
| `webui.action` | info（高危动作 **warn**） | method, path, bodyDigest, ip |
| `webui.error` | error | method, path, error —— 端点抛出了没有被自己接住的异常，由 `app.onError` 兜住。**回给前端的信封里只有这一行的 id**（`ref:`），异常消息不出网：它可能带库路径、SQL、密钥片段 |
| `webui.disabled` | warn | `webui.enabled=false`：整个 HTTP 面不监听，**审批也就没有裁决通道** |
| `config.changed` | info | keys[] |
| `config.invalid` | warn / error | 启动与热重载时的配置问题：缺 `main` 别名、唤醒词不会生效、一个触发源都没开、持久化覆盖被剔除（`dropped[]`）。这些都不中止启动 —— 补配置要用的 WebUI 不能被配置错误带走 |
| `maintenance.cleanup` / `maintenance.vacuum` | info | 每日维护与 VACUUM 的结果 |
| `maintenance.repair` | warn | 一次性数据修复留下的痕迹（计价口径重算、子 agent 结果路径归一化）。它只在真的改过东西时才落 |
| `scheduler.failed` | error | error —— 五个维护 cron 里某一个抛了（用户任务那一路走 `schedule.failed`） |
| `schedule.created` | info | job, name, cron, mode —— 从 WebUI 新建了一条定时任务（工具那一路的痕迹在 `tool.call` 里） |
| `schedule.fired` | info | job, name, mode, role, runCount —— 定时任务开始一轮（trace_id 是那一轮的 turn_id） |
| `schedule.skipped` | warn | job, name, reason（`schedule.disabled` \| `role_downgraded` \| `quota_exceeded` \| `turn_queue_rejected` \| `telegram_unavailable`）—— 任务留着，只跳过这一次 |
| `schedule.missed` | warn | job, name, expected, catchUp:false —— 停机期间错过了触发点。**不补跑**（[02 §10.3](./02-context-engine.md#103-不补跑)），所以这一条是「今天早报没发」的唯一凭据 |
| `schedule.failed` | error | job, name, error —— 这一次触发失败；一次性任务不重试 |
| `schedule.cancelled` | warn | job, role —— 创建者被封禁，整条任务停用 |
| `schedule.loaded` | info | registered, missed, enabled —— 启动时装载了多少条 |
| `system.start` / `system.stop` | info（Telegram 入口禁用时 **warn**） | name, webui, providerSecrets / signal |
| `system.restart` | warn | reason —— WebUI 按下的「重启进程」。**没有 supervisor 时进程不会自己回来** |
| `system.recovered` | warn | turns, tasks, agentRuns, claims, reservations —— 上一个进程没有正常收尾，`recoverAfterCrash` 判死了这些。此前它一个字都不落，一次非正常重启 reap 了什么只能靠翻 `turns` 表反推（[reviews/28](./reviews/28-round10-live-system-test.md) · L-OPS-04） |
| `ctx.orphan_tool_call` | warn | toolCallIds[] —— 读出侧给「没有配对结果的 tool-call」补了结果。**这条会话的历史是坏的** |
| `alert.raised` | error | alert, …告警自己的载荷 —— 一条告警被触发（[§6](#6-健康检查与告警)）。**它不挡在投递前面**：`db_write_failed` 的触发源就是「库写不进去」 |
| `alert.deliver_failed` | warn | alert, error —— owner 私聊或 webhook 发不出去。告警链路自己坏了不能再炸一次 |
| `system.crash` | error | event（`uncaughtException`）, detail（stack）—— 进程即将退出 |
| `system.unhandled_rejection` | error | event（`unhandledRejection`）, detail（stack）—— 进程**不**退出 |

`model.error` 补的是一个盲区：AI SDK 会把步骤级失败吞进内部的 `onError`，让 `result.text`
解析成空串而不抛异常。没有这一行时，一次上游 502 在日志里只留下一条正常的 `model.call`，
运维看到的只有「bot 不回复」（[04](./04-agents-and-providers.md#上游失败不能伪装成模型没话说)）。
`onExhausted` 只覆盖「`doStream` 抛出来」那一路：中转站 200 收下、SSE 里 0 步就关闭那一路既不抛
也不触发流级看门狗，两次进程崩溃（logs/2026-08-18 22:17 / 23:19）在 `model.jsonl` 里因此完全隐形。
所以流里的 `error` 部件与「一步都没跑完」现在也各记一条（`source:'stream'`）。

`system.crash` 是崩溃前的最后一行：进程照旧退出（恢复交给下次启动的 `recoverAfterCrash`），
但必须留下原因。曾经有一次 uncaught 的流错误把进程直接带走、日志里一个字都没有，
排查只能靠翻数据库猜「最后一条 `turn.start` 之后发生了什么」——这个钩子就是为了不再有第二次。

**`unhandledRejection` 与 `uncaughtException` 不是一回事，处理也不一样。** 前者只记
`system.unhandled_rejection` 并让进程继续跑。上一版两者共用一个处理器、一律 `exit(1)`，代价在
2026-08-18 兑现了两次：`runtime.ts` 那条 `final` 链有一个「创建之后、`bot.ts` 挂上 catch 之前」的
窗口（`TelegramOutput.consume` 开头要等 `sendChatAction`，实测 561ms），上游一次 0 步返回落在窗口
里，一条私聊里泄漏的一个 promise 就把整个进程带走了 —— 连带杀掉当时所有并发轮次，`bot.ts` 那三处
catch 一次都没跑到，`model.error` 也来不及写，事后只能靠 `turns` 表里两行 `process_restarted` 反推。
那个窗口已经堵上了（`void final.catch(...)`），但「一个悬着的 promise = 整个进程」这条兑换率本身
就不该存在：rejection 是**某一次调用**的失败，不是进程级不可恢复状态（那才是 `uncaughtException`
的语义）。轮次侧该记 failed 的自有它自己的路。

## 3. 落盘格式

```
logs/
  2026-08-15/
    turn.jsonl        turn/ctx/quota/trigger 级事件
    model.jsonl       每次模型调用（含完整请求消息与响应，见下）
    tool.jsonl        每次工具调用（完整输入输出）
    system.jsonl      启动/配置/维护/插件/MCP/WebUI
```

每行一个 JSON 对象：

```json
{
  "ts": 1755212345678, "level": "info", "kind": "model.call",
  "traceId": "01J8ABCD…", "spanId": "01J8ABCE…", "parentSpanId": "01J8ABCD…",
  "chatId": "-1001234567", "userId": "8899001", "key": "chat:-1001234567",
  "agentRunId": "01J8…",
  "alias": "main", "provider": "anthropic-main", "modelId": "claude-opus-5",
  "durationMs": 2114, "finishReason": "tool-calls",
  "usage": { "in": 6240, "out": 180, "cacheRead": 5800, "cacheWrite": 0, "reasoning": 0 },
  "costUsd": 0.0081,
  "request":  { "instructionsHash": "sha256:…", "messages": [ … ], "tools": ["read_file", …],
                "settings": { "temperature": 0.7, "maxOutputTokens": 4096 } },
  "response": { "text": "…", "toolCalls": [ … ] }
}
```

配置：

```yaml
logs:
  level: info                  # debug|info|warn|error
  dir: ./logs
  captureBodies: true          # false 时 request/response 只留 hash 与长度
  bodyMaxBytes: 262144         # 单条 payload 上限，超出落独立文件并记引用
  retentionDays: 30
  gzipAfterDays: 3
  console: pretty              # pretty|json|off
  redactPatterns:              # 追加到内置脱敏规则
    - 'sk-[A-Za-z0-9_\-]{16,}'
```

**脱敏**（内置，不可关闭）：Bot token 形态 `\d{8,10}:[A-Za-z0-9_-]{35}`、`sk-…`、`Bearer <token>`、`LUOLI_MASTER_KEY` 值、`providers.api_key_enc` 解密后的明文、`config` 中名字匹配 `/key|secret|token|password/i` 的字段值 → 替换为 `«redacted»`。脱敏在**写入前**执行，对 DB 与文件同时生效。

**轮转**：按日期目录 + 单文件超 `logs.maxFileMb`（默认 128）时追加 `.1`、`.2`。写入用追加流 + 每 200ms 或 64KB flush，避免每条 fsync。

**DB 索引行 vs 文件全文**：`log_events` 只存摘要字段（可检索、可聚合），完整 payload 只在文件里。这样 DB 不会被大 payload 撑爆，同时 WebUI 仍能按需拉全文（`GET /api/logs/blob?ref=`）。

**`retentionDays` 同时管子 agent 的全文结果。** `data/agent-results/<runId>.txt` 是和日志同性质的调试产物，
`MaintenanceService.cleanup()` 按 `agent_runs.finished_at` 一并过期：删文件、把 `result_full_ref` 置空，
`result_summary` 留着（摘要是上下文里已经引用过的东西，删了会让历史轮次的引述悬空）。之后
`read_agent_result` 回一句「已按日志保留期清理，只剩摘要」而不是抛 ENOENT（docs/22 · I-09）。
**媒体附件不在这里过期** —— `data/files/**` 是用户数据，自动过期策略是 [14 §2](./14-open-questions.md) Q9
的未决问题。`POST /api/maintenance/gc-files` 扫的是**孤儿**：磁盘上有、但没有任何 DB 行指向的文件
（下载中途崩溃、`local_path` 被换掉、手工删过库行留下的），那不是保留策略。

**实时广播（`LogSink` → `EventBus` → SSE）**：落库之后同一条事件还会以**摘要形式**推给 WebUI
（`{id, ts, level, kind, traceId, summary}`，见 [09 §5](./09-webui.md#5-sse-事件)）。三条硬约束：

- **只发摘要，不发 `data`** —— 单条载荷能到几百 KB，全量广播会把每个开着的控制台连接一起打爆；
  要正文走 `GET /api/logs/:id/data`。
- **`debug` 不广播**（阈值是广播侧的，与 `logs.level` 无关：debug 照常落库，只是不推）。
- **同一 `kind` 在 200 ms 内合并成一条**，尾包带 `merged: n`。一次工具风暴能在几十毫秒里产生上百条
  `tool.call`，不合并的话「每来一条事件前端刷新一次」就是自我 DDoS。

阈值与窗口刻意不做成配置项：调松它们的唯一效果是把 SSE 连接和前端一起打爆。
`LogSink` 没拿到 `EventBus` 时这一整段是空操作（测试与 CLI 场景），日志行为完全不变。

**读出侧必须解引用**：超过 `logs.bodyMaxBytes` 的 `data` 在库里只剩 `{fileRef, bytes}`。任何展示载荷的地方
（`GET /api/turns/:id/detail`、`GET /api/logs/:id/data`，见 [09 §4](./09-webui.md#4-rest-api)）都要顺着 `fileRef`
把 `logs/<day>/blobs/*.json` 读回来 —— 否则「查看这一轮实际发了什么」看到的是一行占位对象，
而恰恰是最大的那些请求体会命中这条路径。文件已被保留策略清掉时如实说明，不要拿占位对象充数。

## 4. 成本记账

### 4.1 记账点

`usageMiddleware`（[04 §5.1](./04-agents-and-providers.md#51-构建流程)）包在每个模型上，`doGenerate`/`doStream` 结束时：

```ts
const m = modelRow;
// **计价的输入是 noCache 那一份，不是 inputTokens。** 见下面那条口径说明。
const priced = u.noCacheTokens ?? Math.max(0, u.inputTokens - u.cacheReadTokens - u.cacheWriteTokens);
const cost = (priced           * m.price_in
            + u.outputTokens   * m.price_out
            + u.cacheReadTokens  * (m.price_cache_read  ?? 0)
            + u.cacheWriteTokens * (m.price_cache_write ?? 0)) / 1_000_000;

await ledger.insert({ ts, turnId, agentRunId, spanId, chatId, userId,
  providerId: m.provider_id, modelId: m.model_id, modelAlias,
  inputTokens: u.inputTokens,               // 存 total（超集），不存 priced —— 见口径说明
  outputTokens: u.outputTokens,
  cacheReadTokens: u.cacheReadTokens,
  cacheWriteTokens: u.cacheWriteTokens,
  reasoningTokens: u.reasoningTokens ?? 0,
  costUsd: cost, latencyMs, finishReason, ok });

await quota.commit({ chatId, userId, costUsd: cost });     // 见 §5.3
await turns.addCost(turnId, cost);
```

**口径：`inputTokens` 是超集，缓存那部分必须先扣掉。** AI SDK 的 `asLanguageModelUsage` 把
`step.usage.inputTokens` 统一成 `inputTokens.total`，而三家 provider 包都让 total 成为超集：
`@ai-sdk/openai-compatible` 的 total 是 `promptTokens`（DeepSeek 是 `cache_hit + cache_miss`），
`@ai-sdk/openai` 同理，`@ai-sdk/anthropic` 则是把 Anthropic 互斥的原始字段重新加成
`input + cacheCreation + cacheRead`。**所以这里不按 provider kind 分叉** ——
`inputTokenDetails.noCacheTokens` 就是那份互斥的输入，三家一致。

此前这条公式把 `cacheRead` 当成与 `inputTokens` **互斥**的一份、在两者之上各收一次钱
（Anthropic 上 `cacheWrite` 还要再重复一次），而 `cacheRead` 通常比 base input 便宜几十倍
—— 一次 91% 前缀命中的调用因此高估 9.4 倍，生产库 342 条 ledger 里 270 条有缓存命中，
**账面高估 44.4%**。`quota.commit` 吃的就是这个数，于是**前缀缓存做得越成功，用户越早撞上
日额度**（`docs/reviews/28 · L-COST-01`；那份报告归因到 provider kind，实测不成立，
所以那条假设在这里被显式否掉，别再去接 kind）。

**`usage_ledger.input_tokens` 仍存 total，不存 priced。** `cacheReadTokens / inputTokens`
是「这家上游的缓存到底是不是真的」唯一能回答的那个比值（`AC-LOG-022` 的 provider 维度聚合
就靠它），存 priced 会把它弄坏 —— 计价口径与观测口径在这一列上是两件事。

注意点：
- **流式也要记账**：`doStream` 的 usage 在流结束时才有；middleware 需在流的 `finish` part 上记账，不能在 `doStream` 返回时就记。
- **失败调用也记一行**（`ok=0`，cost 按实际已产生的 usage；很多 provider 在超时/中断时不返回 usage → cost=0，但仍记录以便统计失败率）。
- 缓存 token 单独计价（cache write 通常比 base input 贵、cache read 便宜几十倍，不区分会严重失真）。
- **`noCacheTokens` 缺失时回落到相减，不回落到 `inputTokens`**：SDK 换大版本时那个字段一旦
  消失，「少扣一次缓存」是账目偏高（可查、可回溯），「按 total 计价」是账目翻倍。
- 无定价 → `cost=0` + `error_kind='no_pricing'`，WebUI 告警；`quota.requirePricing=true` 时非 owner 不得使用该模型。
- **旧口径的存量数据由一次性修复（`repair:ledger-cache-cost:v1`）重算**：逐行先验算旧
  `cost_usd` 是否复现旧公式，复现的按新公式重写，不复现的（定价此后改过、`no_pricing`）
  原样留下并计数 —— 只改我们自己算错的那些。`turns.cost_usd` 跟着按
  `SUM(usage_ledger.cost_usd)` 重算；`quota_counters.cost_usd` 只对**明细还在**的账期重新聚合
  （超过 `maintenance.retention.usageDays` 的明细已经没有了，那些账期算不回来，也早已过期）。

### 4.2 聚合视图

`GET /api/usage?from&to&groupBy=day|chat|user|model|alias|agent` 直接 SQL 聚合（`usage_ledger` 有对应索引）。

`groupBy=day` **按 `general.timezone` 的本地日分桶**，与总览趋势（`OperationsRepository.dashboard`）
和配额账期（`quotaBucket`）同一个口径。此前它是裸的 `strftime(…,'unixepoch')` —— UTC ——
于是东八区部署里「用量报表的 8 月 18 日」是本地 18 日 08:00 到 19 日 08:00，用量页与总览页对
同一天给出两个数字，而这正是运维核对账单时会撞上的地方（docs/27 · C-02）。
实现是把时区表达成一个固定偏移（`sqliteTimezoneModifier`）交给 SQL 与 JS 两侧共用，两处因此**按构造**
一致；代价是跨 DST 切换的范围里，切换后那半段的日界会差一小时（默认时区 Asia/Shanghai 没有 DST，
配额账期仍走 Intl 精确分桶 —— 它只按「现在」算当前 bucket，不回溯历史）。

**保留期**：`maintenance.retention.usageDays`（默认 400 天）由每日维护任务直接删原始行。
早先设想的「先聚合进可选表 `usage_daily` 再删」**没有实现**，因此超过保留期的明细就是没有了 ——
要长期账目请在保留期内自行导出。`quota_counters` 同理走 `maintenance.retention.quotaCounterDays`
（当前账期的行永远不会被删）。此前这两张表一条保留策略都没有，只涨不落且 `VACUUM` 帮不上
（数据还在，docs/27 · R-05）。

## 5. 配额

> 对应决策 D19。

### 5.1 层级

```yaml
quota:
  enabled: true
  currency: USD
  requirePricing: true
  minReserveUsd: 0.02          # 剩余额度低于此值时禁止发起新的模型调用
  global:  { daily: 5.00,  monthly: 100.00 }
  perChat: { daily: 1.00,  monthly: null }
  perUser:
    daily: 0.50
    monthly: null
    byRole:                    # 覆盖 perUser
      owner:   { daily: null, monthly: null }    # null = 不限
      trusted: { daily: 2.00 }
      limited: { daily: 0.30 }
  perTurn:
    maxCostUsd: 0.50
    maxSteps: 12
    maxToolCalls: 40
    maxSubagents: 10
    maxDurationMs: 600000
  rateLimit:                   # 与金额无关的防滥用；滚动一小时窗口，不受 quota.enabled 影响
    turnsPerUserPerHour: 30    # 定时任务的轮次不计入这两项（见下）
    turnsPerChatPerHour: 100
    concurrentPerUser: 2       # 这一项照旧数定时轮次：它真的占着一个槽
  onExceeded:
    reply: true                # 是否回复用户（false 则静默丢弃）—— 只管**金额**那一档
    message: '今天的额度用完了（已用 {spent}/{limit}），{resetAt} 重置。'
    notifyOwner: true          # global 超限时私聊 owner
```

判定顺序（任一拒绝即拒绝）：`global` → `perChat` → `perUser(byRole 覆盖)` → `rateLimit`。

**`rateLimit` 的两档按小时次数不数定时任务的轮次。** 它防的是「人在刷」，而定时任务的频率在
**创建时**就由 `schedule.minIntervalMinutes` / `schedule.maxPerChat` 管住了；实测一天 38 次定时
触发把 owner 自己挡在了门外（docs/28 · L-QUOTA-02）。判据是 `turns.trigger_reason <> 'schedule'`，
只作用于 `canStart`；**金额那一侧一个子句都没改**（`reserve()` 照旧把定时轮次的花费算进
global / perChat / perUser 的 daily / monthly）。

**并发与频率两档各有自己的文案，且都不受 `onExceeded.reply` 管。** 那个开关的语义是「额度用光了
就别再回话」，而这两档说的是「现在不行，等一会儿」—— 沉默等于 bot 对一句正常的话装没看见。
套 `onExceeded.message` 更糟：`{spent}`/`{limit}` 没有值可填，真人看到的原话是
「今天的额度用完了（已用 —/—），下个额度窗口 重置。」而真实原因是「这一小时开了 30 轮」
（docs/28 · L-QUOTA-02）。频率那句要说清是**频率**、按人还是按会话、以及窗口是滚动一小时。

### 5.2 时间窗口

- `day` bucket = `YYYY-MM-DD`（按 `general.timezone` 的本地日期），`month` = `YYYY-MM`。
- 重置无需定时任务：bucket 键变了就是新窗口（计数器行天然分离）。
- 回复文案里的 `{resetAt}` 由当前 bucket 推算（次日 00:00 / 次月 1 日 00:00，本地时区）。

### 5.3 预留-提交（防并发超支）

并发 turn 会同时通过检查然后各花一笔，导致超额。用「预留」解决：

```
precheck(turn):
  est = 估算本轮成本  = (snapshotTokens + 预估输出) × 当前别名单价 × perTurn 安全系数(默认 1.5)
  for scope in [global, chat, user]:
      if spent + reserved + est > limit  → 拒绝
  reserve(scope, est)                            # quota_counters.reserved_usd += est; turns += 1
  turn.reservation = est

commit(actualCost):                              # 每次模型调用后
  spent += actualCost;  reserved -= min(reserved, actualCost)

release(turn):                                   # turn 结束（含失败）
  reserved -= 剩余未消耗的预留（下限 0）
```

- **`turns` 在 `reserve()` 里 +1，一轮只加一次。** 它此前在 `commit()` 里，而 commit 是每一步模型调用之后
  都调的 —— 那样 `quota_counters.turns` 统计的是**步数**，而配额页把它标成「轮次」（docs/22 · I-02）。
  预留被拒时提前返回，不留计数；WebUI 的试跑与正常轮次共用同一份计数。
- `commit()` 的六行（3 scope × 2 window）是**一条** `UPDATE … WHERE (scope,subject,window,bucket) IN (VALUES …)
  RETURNING …`，不是六条单行 UPDATE —— 它每步都要跑一次（docs/22 · I-04）。
- `reserved_usd` 由维护任务兜底清零（进程崩溃可能残留）：启动时把所有 `reserved_usd` 归零（因为不存在跨进程的在途 turn）。
- 轮内超 `perTurn.maxCostUsd` → `prepareStep` 置 `toolChoice:'none'` + 清空 `activeTools`，让模型用现有信息收尾（[04 §2](./04-agents-and-providers.md#2-主-agent-装配)）。

### 5.4 用户可见性

- `/usage`：本人今日/本月用量与上限；owner 看全局与 top 消费会话。
- 达到 80% 阈值时，在回复末尾追加一次性提示（每 bucket 只提示一次）：`（今日额度已用 80%）`。
- 超限回复用 `quota.onExceeded.message` 模板；`global` 超限额外私聊 owner。

## 6. 健康检查与告警

```
GET /api/health（无需鉴权）—— 只回存活状态，不透露任何内部拓扑
{ ok, uptimeMs }

GET /api/health/detail（需登录）—— 详细状态
{ ok, version, uptimeMs,
  db: { ok },
  providers: [{ id, name, kind, baseUrl, healthState }],
  mcp: [{ name, state, error }],
  sandbox: { allowed, mode },
  inFlightTurns }
```

> 拆成两个是因为「无需鉴权」和「provider 列表（含 baseUrl）+ MCP 服务器 + 沙箱 plan + 在途轮次数」
> 不能同时成立：默认绑 `127.0.0.1` 时影响有限，但 `webui.host` 一放开就是无鉴权信息泄露
> （docs/20 · W-API-01）。外部探针只需要 `/api/health`。

告警渠道（`alerts`）：
- **私聊 owner**（默认开）：global 配额超限、provider 全部不可用、DB 写失败、plugin 自动禁用、沙箱不可用而有非 owner 请求执行、连续 5 个 turn 失败。
  - `consecutive_turn_failures` 数的是 `state='failed'`：`/cancel` 不算（用户点的取消不是故障），
    而 **`concurrency.turnTimeoutMs` 到点算**（[04 §5.3](./04-agents-and-providers.md) 那三档）。
    超时曾经和 `/cancel` 一样归进 `cancelled`，于是「每一轮都卡满十分钟」这种最该响的故障
    一次都不响（`logs/2026-08-18`：三十来轮全记 `cancelled`）。
  - 计数**跨会话，也跨入口**：连续失败说的是「这个部署坏了」，不是「这个群坏了」。所以
    `TurnFailureStreak` 由装配方建**一份**，同时交给 Telegram 入口与 `ScheduledJobRunner`
    —— 它此前只存在于 `createTelegramBot` 的闭包里，定时轮次的失败一次都不计入，于是上游变黑洞时
    没人聊天的部署一次告警都不响（docs/28 · L-SCH-02）。每条入口各持一份同样不行：两份各卡在
    4 次，而这个部署已经全线不通了。
- 告警去重：同 `alertKey` 在 `alerts.dedupeMinutes`（默认 30）内只发一次。
- 可选 webhook：`alerts.webhookUrl`（POST JSON），便于接自有监控。

> **告警投递不得依赖库写成功。** `db_write_failed` 这一条的触发源就是「库写不进去」
> （`LogSink.onWriteFailure` → `AlertDispatcher.fire`），所以 `raise()` 里那次
> `alert.raised` 落库**不能挡在投递前面**：挡住的话，库坏了唯一该响的那条告警一定不响，
> 而 `fire()` 的 `.catch()` 会把它咽得无声无息。同理 `LogSink.event()` **一律不抛** ——
> 它的调用点全在 catch 块、`.catch()` 回调和进程的 crash handler 里，让它抛等于把
> 「日志写不进去」升级成「轮次失败」，再升级成「crash handler 自己抛、`process.exit(1)`
> 走不到」。入库失败时它返回 `0`（与「级别不够」同一个返回值）并只记 stderr + 告警。

## 7. 可观测性验收要点

一次典型 turn 结束后，必须能做到（对应 [13 §8](./13-acceptance-criteria.md#8-日志与成本-ac-log)）：

1. 用 `turn_id` 在 WebUI 一次检索出完整调用树，含每次模型调用的**完整请求消息**与响应。
   「树」的判据是 `parent_span_id` 真的连着（[§1](#1-trace-模型)）——`tests/log.trace.test.ts` 跑一轮假上游 + 假工具，
   断言那四条边真的落库（`with_parent > 0` 且父子 kind 对得上）。
2. 每次工具调用能看到完整输入、输出（或截断标记 + 全文引用）、耗时、是否走沙箱、是否经审批。
   **被拒的那些也要看得见**：`tool.denied` 覆盖准入闸的每一种拒绝，`tool.error` 覆盖「参数非法、
   `execute` 压根没被调到」那一路。
3. 每次模型调用能看到 provider/模型/别名/四类 token/费用/延迟/finishReason；费用之和 = `turns.cost_usd`（误差 < 1e-9）。
   **一旦发生链内 fallback，这三个说的必须是真正出力的那个候选** —— 它与 `usage_ledger` 那一行
   指向同一个 provider（[reviews/28](./reviews/28-round10-live-system-test.md) · L-PROV-01）。
4. 子 agent 的 span（`agent.run`）挂在派发它的 `tool.call` 之下，且其费用计入同一 turn。
5. rebase / prune / hardcap 事件在日志中明确可见，且能看出裁掉了哪些 ordinal。
6. 日志中**不出现**任何 API key、bot token、master key 明文（自动化测试用正则扫全部 JSONL，AC-LOG-007）。
