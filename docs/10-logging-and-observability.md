# 10 · 日志、成本与配额

需求原文：「每次模型调用/工具调用等 都要有独立的日志」。落地为 **trace/span 模型**：一个 turn = 一条 trace，其中每次模型调用、每次工具调用、每个子 agent、每次 Telegram API 调用、每次上下文操作都是一个独立 span，可单独检索、单独查看完整 payload。

## 1. Trace 模型

```
trace_id = turn_id                        （命令类操作用 cmd_<ulid>；定时任务用 job_<ulid>）
                                          定时任务一旦开出轮次，trace_id 就是那一轮的 turn_id；
                                          `job_<ulid>` 只用在开轮之前（跳过、错过、装载）
span_id  = ULID
parent_span_id = 上级 span

turn 01J8…                                     kind=turn.start / turn.end
├── ctx.open        span A                     claimed=3, base=c041
├── prompt.build    span B                     blocks tokens=…
├── model.call      span C  parent=turn        #1 main→claude-opus-5
│   └── tool.call   span D  parent=C           spawn_agent(researcher)
│       └── agent.run  span E  parent=D        sub run_id=…
│           ├── model.call  span F parent=E
│           ├── tool.call   span G parent=E    grep
│           ├── agent.ask   span H parent=E
│           └── agent.answer span I parent=H
├── model.call      span J                     #2
├── tg.send         span K
├── tg.edit         span L (×N，聚合为一条带 count)
└── ctx.commit      span M                     rebase, prune
```

- span 落 `log_events` 一行（含 `duration_ms`），大 payload 落 `logs/<date>/<kind>.jsonl` 并在行里记 `file_ref`。
- WebUI Trace 视图按 `parent_span_id` 重建树（[09 §3.10](./09-webui.md#310-日志logs)）。

## 2. 事件种类（`log_events.kind` 枚举）

| kind | level | 关键字段 |
|---|---|---|
| `tg.update` | debug | update_id, type, chat, user, bytes |
| `access.denied` | info | user, chat, userRole, chatRole, reason |
| `archive.append` | debug | messageId, kind, hasMedia |
| `media.download` | info | attachmentId, bytes, ms, state |
| `media.extract` | info | attachmentId, chars, state |
| `trigger.matched` / `trigger.skipped` | debug | reason |
| `quota.check` | info | scope, spent, limit, decision |
| `quota.exceeded` | warn | scope, subject, spent, limit |
| `turn.queued` / `turn.start` / `turn.end` | info（`turn.end` 断掉时 **warn**） | key, initiator, role, steps, costUsd, state。`turn cancelled/failed after partial delivery` = 已经吐过内容之后才断的那一路（[04 §5.3](./04-agents-and-providers.md)）：delta 提交了、状态不是 committed，`deliveredChars` 是留在屏幕上的字数 |
| `turn.wrap_up` | **warn** | chars（最后一步没有正文，补跑了一次收尾；失败时带 error） |
| `turn.no_final_text` | **warn** | streamedChars, messages（补跑也没救回来，回落到流里攒到的文本） |
| `ctx.open` | debug | baseCommit, claimed, snapshotTokens, snapshotMsgs |
| `ctx.commit` | info | commitId, ordinals[from,to], fastForward |
| `ctx.rebase` | **warn** | base, onto, skippedCommits[] |
| `ctx.prune` | info | fromOrdinal, toOrdinal, levels[], tokensBefore/After |
| `ctx.hardcap` | warn | step, tokensBefore/After |
| `prompt.build` | debug | blockTokens{kernel,character,assist,catalog,pub,pri,runtime}, total |
| `model.call` | info | alias, provider, modelId, in/out/cacheR/cacheW, ms, finishReason, costUsd, requestRef |
| `model.error` | error/warn | alias, modelId, errorKind, status, retryAttempt, willRetry, willFallback。**每一次失败的尝试一行**（warn），整条链耗尽时再一行（error）。只落最后那一条时，「熬满三次超时再 fallback」在日志里就是一段什么都没有的空白 —— `logs/2026-08-18` 那 363 秒只有开头的 `turn.start` 与结尾的 `provider.fallback`，中间靠 `3 × requestTimeoutMs + 退避` 的算术反推 |
| `provider.fallback` | warn | from, to, reason |
| `provider.health` | info/warn/**error** | provider, state, ms, failures, status。error = 这一次把 provider 判成了 `down`（[04 §5.3](./04-agents-and-providers.md)） |
| `tool.call` | info | **input**（工具参数）, output, ms, ok；失败时 input + error。一个 span 只落一行，所以开始时的 `input` 与结束时的 `output` 是**合并**进同一行的 —— `LogSink.span().end()` 曾经用结束载荷整体顶掉开始那份，于是这一行只有 `output`，WebUI 的对话详情因此永远看不到工具输入（`tests/log.span.test.ts`） |
| `tool.denied` | warn | tool, reason(role/rate/approval), role |
| `tool.error` | warn | tool, errorKind, message |
| `tool.disabled` | warn | tool —— 运维在 WebUI 关掉的工具被调用（目录之外的第二道硬拦截） |
| `tool.disabled_after_errors` | warn | tool, failures —— 同一工具连续失败到 `tools.maxConsecutiveErrors`，本轮停用。这条是排障时区分「模型没试」和「试了被拦」的唯一凭据 |
| `sandbox.run` | info | mode, image, exitCode, ms, oom, killed |
| `approval.requested` / `approval.decided` | info | tool, risk, decidedBy, channel, ms |
| `agent.spawn` / `agent.end` | info | name, depth, modelAlias, steps, costUsd |
| `agent.ask` / `agent.answer` | info | fromRun, toRun, source(rule/arbiter/timeout), ms。**没有 `source='user'`** —— 转人工那一级没实现（[04 §4.3](./04-agents-and-providers.md)） |
| `agent.ask_unarbitrated` | warn（取消时 info） | askId, agentRunId, reason(no_model/cancelled/timeout/failed/empty), detail, escalationRequested —— 仲裁没能给出答复，子 agent 接下来按「没人应答」走。`escalationRequested:true` 表示运维开了 `agent.askEscalateToUser` 但那个键仍未接线，**没有真的去问人** |
| `agent.file_invalid` | error | file, error —— `agents/<name>.md` 解析失败。其余定义照常加载，所以这一行是「我加的那个 agent 为什么不存在」的唯一凭据（[04 §3.1](./04-agents-and-providers.md)） |
| `agent.harness` | info/warn | dir, command, exitCode, timedOut, ms —— M11 起了一次外部 harness。**它内部干了什么不在这里**（也不在任何地方），本系统看不见（[14](./14-open-questions.md) T17） |
| `agent.progress` | debug | phase, done/total |
| `memory.read` / `memory.write` | info | scope, subject, op, section, bytesAfter, reason |
| `memory.owner_read_private` | **warn** | targetUserId |
| `memory.compact` | info | scope, tokensBefore/After, autoApplied |
| `skill.load` | info | name, tokens, allowedTools |
| `plugin.hook` | debug | plugin, hook, ms |
| `plugin.error` | warn | plugin, hook, message |
| `mcp.connect` / `mcp.error` | info/warn | server, transport, toolCount |
| `tg.send` / `tg.edit` / `tg.action` | debug | chatId, messageId, chars, ms, editCount |
| `tg.error` | warn | method, description, retryAfter |
| `tg.parse_fallback` | **warn** | chars, error, phase(`send` \| `edit`) —— `parseMode` 渲染被 Telegram 拒收（`can't parse entities`），已降级成纯文本重发/重编辑一次。**这一跳此前一个字都不落**，于是行内代码那个 bug 只能靠翻下一次模型调用的 context blob 反推。第二级兜底（发 `.md` 文档）仍未实现，见 [00 §2.3](./00-state.md) |
| `webui.action` | info | method, path, bodyDigest, ip |
| `webui.error` | error | method, path, error —— 端点抛出了没有被自己接住的异常，由 `app.onError` 兜住。**回给前端的信封里只有这一行的 id**（`ref:`），异常消息不出网：它可能带库路径、SQL、密钥片段 |
| `config.changed` | info | keys[], actor |
| `maintenance.*` | info | job, ms, affected |
| `schedule.fired` | info | job, name, mode, role, runCount —— 定时任务开始一轮（trace_id 是那一轮的 turn_id） |
| `schedule.skipped` | warn | job, name, reason（`schedule.disabled` \| `role_downgraded` \| `quota_exceeded` \| `turn_queue_rejected` \| `telegram_unavailable`）—— 任务留着，只跳过这一次 |
| `schedule.missed` | warn | job, name, expected, catchUp:false —— 停机期间错过了触发点。**不补跑**（[02 §10.3](./02-context-engine.md#103-不补跑)），所以这一条是「今天早报没发」的唯一凭据 |
| `schedule.failed` | error | job, name, error —— 这一次触发失败；一次性任务不重试 |
| `schedule.cancelled` | warn | job, role —— 创建者被封禁，整条任务停用 |
| `schedule.loaded` | info | registered, missed, enabled —— 启动时装载了多少条 |
| `system.start` / `system.stop` | info | version, mode, uptime |
| `model.error` | error | alias, modelId, cause —— fallback 链整条耗尽时的最后一个错误 |
| `system.crash` | error | event（`uncaughtException` \| `unhandledRejection`）, detail（stack） |

`model.error` 补的是一个盲区：AI SDK 会把步骤级失败吞进内部的 `onError`，让 `result.text`
解析成空串而不抛异常。没有这一行时，一次上游 502 在日志里只留下一条正常的 `model.call`，
运维看到的只有「bot 不回复」（[04](./04-agents-and-providers.md#上游失败不能伪装成模型没话说)）。

`system.crash` 是崩溃前的最后一行：进程照旧退出（恢复交给下次启动的 `recoverAfterCrash`），
但必须留下原因。曾经有一次 uncaught 的流错误把进程直接带走、日志里一个字都没有，
排查只能靠翻数据库猜「最后一条 `turn.start` 之后发生了什么」——这个钩子就是为了不再有第二次。

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
const cost = (u.inputTokens  * m.price_in
            + u.outputTokens * m.price_out
            + (u.cachedInputTokens ?? 0) * (m.price_cache_read  ?? 0)
            + (u.cacheCreationInputTokens ?? 0) * (m.price_cache_write ?? 0)) / 1_000_000;

await ledger.insert({ ts, turnId, agentRunId, spanId, chatId, userId,
  providerId: m.provider_id, modelId: m.model_id, modelAlias,
  inputTokens: u.inputTokens, outputTokens: u.outputTokens,
  cacheReadTokens: u.cachedInputTokens ?? 0,
  cacheWriteTokens: u.cacheCreationInputTokens ?? 0,
  reasoningTokens: u.reasoningTokens ?? 0,
  costUsd: cost, latencyMs, finishReason, ok });

await quota.commit({ chatId, userId, costUsd: cost });     // 见 §5.3
await turns.addCost(turnId, cost);
```

注意点：
- **流式也要记账**：`doStream` 的 usage 在流结束时才有；middleware 需在流的 `finish` part 上记账，不能在 `doStream` 返回时就记。
- **失败调用也记一行**（`ok=0`，cost 按实际已产生的 usage；很多 provider 在超时/中断时不返回 usage → cost=0，但仍记录以便统计失败率）。
- 缓存 token 单独计价（Anthropic 的 cache write 通常比 base input 贵、cache read 便宜很多，不区分会严重失真）。
- 无定价 → `cost=0` + `error_kind='no_pricing'`，WebUI 告警；`quota.requirePricing=true` 时非 owner 不得使用该模型。

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
  rateLimit:                   # 与金额无关的防滥用
    turnsPerUserPerHour: 30
    turnsPerChatPerHour: 100
    concurrentPerUser: 2
  onExceeded:
    reply: true                # 是否回复用户（false 则静默丢弃）
    message: '今天的额度用完了（已用 {spent}/{limit}），{resetAt} 重置。'
    notifyOwner: true          # global 超限时私聊 owner
```

判定顺序（任一拒绝即拒绝）：`global` → `perChat` → `perUser(byRole 覆盖)` → `rateLimit`。

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
2. 每次工具调用能看到完整输入、输出（或截断标记 + 全文引用）、耗时、是否走沙箱、是否经审批。
3. 每次模型调用能看到 provider/模型/别名/四类 token/费用/延迟/finishReason；费用之和 = `turns.cost_usd`（误差 < 1e-9）。
4. 子 agent 的 span 挂在派发它的 `tool.call` 之下，且其费用计入同一 turn。
5. rebase / prune / hardcap 事件在日志中明确可见，且能看出裁掉了哪些 ordinal。
6. 日志中**不出现**任何 API key、bot token、master key 明文（自动化测试用正则扫全部 JSONL，AC-LOG-007）。
