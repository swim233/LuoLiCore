# 21 · WebUI 控制面覆盖缺口

> **口径**：本文只回答一个问题 —— **「运行时真的有这个能力，但运维在 WebUI 里够不着」**。
> 三类东西不算缺口，单独列在 §5：运行时压根没接线的配置项（那是 `KNOWN_UNIMPLEMENTED_CONFIG_KEYS`
> 的事）、被别的端点取代的重复端点、以及有意做成只读的地方。
>
> 盘点时间：2026-08-16。数字口径见 §1 开头的复算方法，改了 schema 或页面之后重跑一遍即可。
>
> **第二轮（2026-08-16 下午）**：完成 G-SSE-01、G-SRV-01、G-API-08、G-API-09 与自动生成配置表单，
> 可写配置覆盖率达到 151/151（其中 2 项密钥字段只读）。**第三轮**继续完成 G-API-10/11/12 与
> G-SRV-02/03/04；本文口径内的 WebUI 控制面缺口已清零，注册 API 端点从 82 条增至 **89 条**。
> 第三轮顺带把 `approval.ttlMs` 与 `mcp.enabled` 接了线（从 `KNOWN_UNIMPLEMENTED_CONFIG_KEYS` 摘掉），
> 分母因此从 151 变成 **153**，覆盖率仍是满的。

---

## 0. 一句话结论

盘点前，`config.schema` 的 **151 个已接线配置叶子里只有 15 个**能在 WebUI 改；配额、沙箱、
维护操作、扩展启停、配置历史、退出登录六块能力后端已有、前端无入口。第一轮把这六块接上，
可写覆盖率从 15/151 提到 44/151。

第二轮修复唯一 P0：G-SSE-01（WebUI 实时刷新完全没工作过），同时补齐取消、附件、会话级覆盖与
schema 自动表单，可写覆盖率达到 151/151（第三轮接线两项后是 **153/153**）。第三轮把最后六项补齐：真实运行时提示词预览、
归档消息软删、可等待且可裁决的审批流、MCP transport CRUD、Skill 正文 CRUD 与 Agent 隔离试跑。
除 §5 明确列出的重复端点、只读策略和未接线运行时配置外，**没有剩余控制面覆盖缺口**。

---

## 1. 配置项覆盖

复算方法（改了 schema 或页面之后重跑）：拿 `config/config.schema.json` 展平成叶子路径，
扣掉 `KNOWN_UNIMPLEMENTED_CONFIG_KEYS` 与 `perChat`（它是覆盖层容器不是配置项），
再和页面上实际能写的键取差集。

| | 数量 |
|---|---|
| schema 叶子总数 | 224 |
| 运行时从不读（`KNOWN_UNIMPLEMENTED_CONFIG_KEYS`） | 70 |
| `perChat`（覆盖层容器，不是配置项） | 1 |
| **已接线** | **153** |
| ├ 第一轮之前 WebUI 可写 | 15 |
| ├ 第一轮新增可写 | 29（配额 17 + 沙箱 12） |
| ├ 第二轮新增可写 | 107（自动生成的表单一次覆盖剩下全部，§4.3） |
| ├ 第三轮新增接线 | 2（`approval.ttlMs`、`mcp.enabled`，表单自动跟着多两项） |
| └ **仍然只能改 `config.yaml`** | **0** |

第三轮从白名单里摘掉的那两项：`approval.ttlMs` 随可等待审批一起真正被 `DatabaseApprovalBroker.request`
读起来（G-API-12），`mcp.enabled` 本来就一直是 `McpManager.reconcile` 的总开关 —— 它当初进白名单是
错判。摘的时候要同步三处：`schema.ts` 的两张表、`docs/11` 的 🚧 清单、以及本节这几个数字。

### 1.1 曾经「已接线但 WebUI 改不了」的那 109 项 —— ✅ 第二 / 三轮全部接上

**现在这一张表只剩存档价值**：设置页的「全部配置」由 `config/config.schema.json` 自动生成，
下面每一项都能在界面上改（§4.3）。留着这张分组表是为了下次复算时对得上号 ——
**表里每一项都是运行时真的会读的值**。

| 分组 | 数量 | 键 |
|---|---|---|
| `tools` | 16 | `maxRegistered` `maxCallsPerTurn` `maxConsecutiveErrors` `defaultTimeoutMs` `fs.maxReadBytes` `fs.maxWriteBytes` `fs.showHidden` `fs.denyGlobs` `fs.trashDir` `fs.backupDir` `exec.defaultTimeoutMs` `exec.maxTimeoutMs` `exec.maxOutputBytes` `web.maxResponseBytes` `web.searchProvider` `web.searchApiKey` |
| `context` | 9 | `scope` `limit.tokens` `limit.maxMessages` `limit.minKeepTurns` `hardCapRatio` `background.enabled` `background.maxPerTurn` `rebase.injectNotice` `tokenRatioAlpha` |
| `provider` | 9 | `maxRetries` `retryBaseMs` `retryMaxMs` `healthCheckCron` `catalog.enabled` `catalog.url` `catalog.cacheFile` `catalog.ttlHours` `catalog.timeoutMs` |
| `webui` | 8 | `host` `port` `sessionTtlHours` `passwordHash` `trustProxy` `allowOrigins` `loginRateLimit.attempts` `loginRateLimit.windowMinutes` |
| `agent` | 7 | `main.modelAlias` `main.maxSteps` `main.downgradeAfterStep` `maxDepth` `maxSubagentsPerTurn` `askTimeoutMs` `maxAsksPerRun` |
| `memory` | 7 | `dir` `pubWriteMinRole` `softLimitTokens` `hardLimitTokens` `maxSections` `compactCron` `forgetMeRetentionDays` |
| `media` | 7 | `dir` `maxImageBytes` `maxDocBytes` `maxImageEdge` `extract.enabled` `extract.maxChars` `extract.inlineChars` |
| `logs` | 7 | `level` `dir` `captureBodies` `bodyMaxBytes` `maxFileMb` `retentionDays` `console` |
| `telegram` | 6 | `mode` `allowedUpdates` `allowBots` `strictCommandSuffix` `throttle.globalPerSecond` `throttle.perChatPerMinute` |
| `concurrency` | 5 | `mode` `perKey` `global` `queueMax` `turnTimeoutMs` |
| `access` | 4 | `defaultUserRole` `defaultChatRole` `archiveBlocked` `bootstrapOwnerId` |
| `approval` | 5 | `enabled` `ttlMs` `skipForOwner` `rememberWithinTurn` `rules` |
| `plugins` | 4 | `dir` `hookTimeoutMs` `order` `autoDisableAfterErrors` |
| `general` | 3 | `timezone` `maintenanceCron` `shutdown.graceMs` |
| `skills` | 3 | `dir` `watch` `defaultMinRole` |
| `mcp` | 4 | `enabled` `healthCheckCron` `defaultMinRole` `servers` |
| `db` | 3 | `path` `backupKeep` `vacuumCron` |
| `prompt` | 1 | `maxTokens` |
| `output` | 1 | `maxMessageChars` |

当时点名「最该先补」的那几项（`logs.level` / `logs.captureBodies`、`access.*`、`approval.*`、
`agent.main.*`、`context.limit.*`、`tools.maxCallsPerTurn` / `tools.exec.*`）现在都带着「热更新」
徽标摆在设置页上，改完下一条消息即生效。

> 顺带修掉一个会直接反映到界面上的错标：`logs.captureBodies` 是每轮从 `turn.config` 现读的
> （`runtime.ts` 的 `bodyForLog`、`GET /api/turns/:id/detail`），**真的是热更新**，却漏在
> `HOT_RELOADABLE_CONFIG_KEYS` 外 —— 表单会对着排障时最常翻的这个开关说「需重启」。
> 第三轮把 `skills.defaultMinRole` 接进了 `SkillLoader.create()`，新建表单也从当前配置快照取默认值，
> 因而现在确实是热更新；`plugins.order` 仍由 `PluginManager` 在构造时拿走，必须重启。
> `tests/config.test.ts` 会逐段检查 docs/11 的热更新标记，避免 `logs` / `skills` / `plugins`
> 整段漏检。

### 1.2 假控件：界面上能点，运行时不读

| ID | 位置 | 说明 | 状态 |
|---|---|---|---|
| G-CFG-01 | 设置 › 触发与唤醒词 › `编辑旧消息不重新触发` | `trigger.ignoreEditedAsTrigger` 在 `KNOWN_UNIMPLEMENTED_CONFIG_KEYS` 里：编辑消息一律按背景消息归档（docs/20 · W-TG-05）。这个勾选框存得下、运行时没人读 | ✅ 第一轮改成禁用 + 「未接线」徽标 |

全表扫过一遍，**除此之外没有第二个假控件** —— 配额页新增的 5 个未接线键刻意不给控件，只列名字。

---

## 2. API 端点覆盖

服务端现注册 89 条 `/api/*` 路由：第二轮增加 2 条 turn 取消路由，第三轮再增加 7 条
（MCP CRUD 3、Skill 详情/新建/完整更新 3、Agent 试跑 1；prompt preview、消息软删与审批裁决原本已有端点）。
逐条比对 WebUI 的调用点后：

### 2.1 后端有、前端没有入口（真缺口）

| ID | 端点 | 缺的是什么 | 优先级 | 状态 |
|---|---|---|---|---|
| G-API-01 | `GET/PUT /api/quota` `POST /api/quota/reset` | 配额限额与实时计数器 | P1 | ✅ 第一轮补（新增「配额」页；`GET` 此前根本不存在、`PUT` 是 `not_implemented` 桩） |
| G-API-02 | `GET/PUT /api/sandbox` `POST /api/sandbox/probe` | 沙箱 mode / 资源限制 / `bypassRoles` / 可用性探测 | P1 | ✅ 第一轮补（工具页新增沙箱卡片） |
| G-API-03 | `POST /api/maintenance/*` | 备份 / VACUUM / 清理日志 / 重建 FTS | P1 | ✅ 第一轮补（设置页） |
| G-API-04 | `PATCH /api/skills/:name` `DELETE /api/skills/:name` `PATCH /api/plugins/:name` `POST /api/plugins/:name/reload` `POST /api/mcp/:name/reconnect` | 扩展页此前是纯只读卡片，启停与重连都没有 | P1 | ✅ 第一轮补 |
| G-API-05 | `GET /api/config/revisions` | 配置变更历史（谁在什么时候把哪个键改成了什么） | P2 | ✅ 第一轮补（设置页「变更历史」） |
| G-API-06 | `POST /api/auth/logout` | **界面上没有退出登录** —— 只能等 session 过期或手删 cookie | P2 | ✅ 第一轮补（顶栏） |
| G-API-07 | `GET /api/health/detail` | 总览页「依赖健康」四行是**写死的字**，沙箱恒显示「Docker」，与 `sandbox.mode` 无关 | P1 | ✅ 第一轮补（改为真实数据 + MCP / 在途 turn / 版本 / 运行时长） |
| G-API-08 | `GET /api/files/:attachmentId` | **图片与文件在 WebUI 里完全不可见**：消息列表不返回 attachment id，也没有任何地方能点开。当时库里有 8 条附件、9 条非文本消息 | P1 | ✅ 第二轮补（消息卡片与检索结果下面的附件带子：图片出缩略图可点开大图，其余给下载；`?inline=1` 只对光栅图放行） |
| G-API-09 | `PATCH /api/chats/:key` | 会话级配置覆盖（`perChat.<key>.trigger` / `.output` 等白名单项）。docs/09 §3.13 写明「设置页不提供」，但会话页也没提供 —— 这个端点当时**只能用 curl 打** | P2 | ✅ 第二轮补（会话页「只对这个会话生效的设置」卡片：白名单内的项按 schema 生成控件，覆盖项以 chip 列出并可逐条取消） |
| G-API-10 | `POST /api/prompts/preview` | 提示词组装预览（「这个会话下最终发给模型的 system prompt 长什么样」） | P2 | ✅ 第三轮补（与真实轮次共用 `assembleMainPrompt`，展示每个 block 的正文、token 与截断状态） |
| G-API-11 | `DELETE /api/messages/:id` | 归档消息软删。合规/隐私诉求下唯一的删除通道 | P2 | ✅ 第三轮补（检索结果与会话卡片均有二次确认；turn 列表/详情不再回显已删 prompt） |
| G-API-12 | `POST /api/approvals/:id/decide` | 审批裁决按钮；命中规则的调用必须保持 pending，裁决后才能继续或拒绝 | P3 | ✅ 第三轮补（WebUI owner 可批准/拒绝；TTL 与轮次取消均 fail-closed） |

### 2.2 docs/09 §4 承诺了、后端也没有

补 UI 之前得先补后端。

| ID | 端点 | 对应的界面承诺 | 优先级 | 状态 |
|---|---|---|---|---|
| G-SRV-01 | ~~`POST /api/tasks/:id/cancel`~~ → `GET /api/turns/active` + `POST /api/turns/:id/cancel` | docs §3.1 在途 turn 表的 `[取消]`、§3.12 任务表的 `[取消]`。**Telegram 侧有 `/cancel`，WebUI 侧没有任何取消通道** | P1 | ✅ 第二轮补（换了端点名，理由见 §4.2） |
| G-SRV-02 | `POST /api/agents/:name/dryrun` | docs §3.9 的 `[试跑]` | P3 | ✅ 第三轮补（NDJSON 流式 step / usage / final / error；断开请求即 abort） |
| G-SRV-03 | `POST/PATCH/DELETE /api/mcp[/:name]` | docs §3.8 的 MCP transport 配置表单与启停 | P2 | ✅ 第三轮补（transport-aware schema 校验，写 `config_kv` / revision 并立即 reconcile） |
| G-SRV-04 | `POST /api/skills` `PUT /api/skills/:name` | docs §3.8 的 Skill 新建与正文编辑（含正文读写） | P3 | ✅ 第三轮补（安全写 `SKILL.md`、重扫并同步数据库；另有详情与删除端点） |
| G-SRV-05 | `POST /api/maintenance/gc-files` | 孤儿文件清理。显式返回 `not_implemented`（按项目先例这是对的，界面上因此不给按钮） | P3 | 有意不做 |

### 2.3 契约测试的假绿灯（已修）

`tests/api.contract.test.ts` 对当时那 21 条读端点只断言 `status === 200`（现在是 23 条）。未注册的 `/api/*` 会掉进
SPA fallback（`app.get('*')` 返回 `index.html`，200），所以 **`GET /api/quota` 这条断言在端点
根本不存在的情况下绿了很久**。第一轮改成同时断言 `content-type: application/json` 与信封的 `ok:true`。

---

## 3. SSE 事件覆盖

### G-SSE-01（P0）：WebUI 的实时刷新从来没有工作过 —— ✅ 已修

**修之前**：docs/09 §5 列了 9 种事件，实际 `events.emit(...)` 的调用点只有两处
（`config.changed` 与未列在文档里的 `approval.decided`）。`ConsoleView.vue` 唯一监听的 `log`
永远不会到达，因为 **`LogSink` 的构造函数根本没有 `EventBus` 参数**，日志写入路径上没有任何 emit。
后果：

- 首屏 `load()` 之后界面再也不会自己刷新，看到的永远是打开那一刻的快照（已实测：另一进程往库里
  写了 skill / plugin / mcp 行，界面上要手动刷新页面才出现）。
- 顶栏与日志页的「实时 / 在线」徽标只反映 **EventSource 连上了**，不反映有数据在流动。
- 源码里多处注释写着「日志 SSE 每来一条事件就重跑 `load()`，所以表单要防回写覆盖」——
  **那套防回写机制是为一个从不发生的事件写的**。

**修之后**的事件覆盖（发送点见 [09 §5](./09-webui.md#5-sse-事件)）：

| 事件 | 文档 | 实际 |
|---|---|---|
| `log` | ✓ | ✅ `LogSink.event()` 落库之后广播摘要 |
| `turn.started` `turn.finished` | ✓ | ✅ `bot.ts` 已有的 `turn.start` / `turn.end` 日志点旁边 |
| `turn.progress` | ✓ | ✅ `runtime.ts` 的 `onStepStart`（模型）与 `onStepEnd`（工具） |
| `usage` | ✓ | ✅ `runtime.ts` 的 `onStepEnd`，与 `ledger.record` 同一处 |
| `quota` | ✓ | ✅ `QuotaGuard.commit`，事务提交之后 |
| `task.updated` | ✓ | ✅ `spawn_agent` 的三次状态迁移 + `report_progress` |
| `health` | ✓ | ⚠️ 只在健康状态**真的会变**的两处发（`POST /api/providers/:id/test`、`POST /api/mcp/:name/reconnect`）。没有独立的健康轮询器，它不是周期心跳 |
| `config.changed` | ✓ | ✅ 会发（`PUT /api/config`、`PATCH /api/chats/:key`、`PATCH /api/tools/:name`、`PUT /api/sandbox`、`PUT /api/quota`） |
| `approval.decided` | 未列在文档里 | ✅ 会发（已补进 docs/09 §5 的表） |
| `approval.pending` | ✓ | ✅ 命中审批规则后写 pending 行并广播；任务页定向刷新，owner 可批准或拒绝 |

三条硬约束（[10 §3](./10-logging-and-observability.md#3-落盘格式) 有完整说明）：
`log` **只发摘要不发 `data`**；`debug` 不广播；同一 `kind` 在 200 ms 内合并成一条并带 `merged: n`。
阈值与窗口写死在 `LogSink` 里，不做成配置项 —— 调松它们的唯一效果是把 SSE 连接和前端一起打爆。

前端同步换掉了「收到任何事件就重跑 `load()`」（那是一次 18 个端点，接上事件之后立刻会变成
自我 DDoS）：每种事件映射到固定的几组数据，**且只刷当前页面看得见的那几组**，同组 400 ms 内合并，
切页时由 `watch(active)` 补拉。`turn.progress` 直接用载荷更新在途表，不回查。
那几处描述「日志心跳」的注释也改成了现在真正会发生的事。

---

## 4. 改了什么

### 4.1 第一轮（配额 / 沙箱 / 维护 / 扩展启停 / 变更历史 / 退出登录）

| 改动 | 文件 |
|---|---|
| 新增 `GET /api/quota`（限额 + 计数器 + 服务端合成的 `limit` + 缺定价模型 + 未接线键名） | `packages/server/src/app.ts` |
| `PUT /api/quota` 从 `not_implemented` 桩改成真实写入（点分键 → `configSchema` → `config_kv` + `config_revisions` + `config.changed`） | 同上 |
| `POST /api/quota/reset` 支持 `{scope, subject, window, bucket}` 精确重置（不带 body 仍是全表清零；只给非 `scope` 过滤条件返回 400） | 同上 |
| 导出 `quotaBucket`，服务端与记账侧共用同一份 bucket 计算 | `packages/core/src/ledger/quota.ts` |
| 新增「配额」页；工具页新增沙箱卡片；设置页新增维护操作与配置变更历史；扩展页支持启停 / 重载 / 重连；顶栏新增退出登录；总览页依赖健康改为真实数据 | `packages/webui/src/views/ConsoleView.vue` |
| MCP 卡片改读 `state` / `last_error`（此前只看 `load_error`，连不上的 server 显示成「可用」） | 同上 |
| `trigger.ignoreEditedAsTrigger` 勾选框禁用并标「未接线」 | 同上 |
| 契约测试补 `content-type` + `ok:true` 断言，堵掉 SPA fallback 造成的假绿灯 | `tests/api.contract.test.ts` |
| 新增配额 API 的 6 条用例（byRole 合成、`limitApprox`、缺定价统计、点分键落库与广播、原型污染键、精确重置） | `tests/quota.api.test.ts` |

### 4.2 第二轮（G-SSE-01 + G-SRV-01）

| 改动 | 文件 |
|---|---|
| `LogSink` 接 `EventBus`：落库后广播摘要（`{id, ts, level, kind, traceId, summary}`），`debug` 不广播，同 `kind` 200 ms 合并并带 `merged`；尾包定时器 `unref()`，另加 `close()` 供关停时丢弃 | `packages/core/src/log/sink.ts` |
| `LogSink.publish(type, data)`：结构化事件不落库只广播。**每个已经持有 `log` 的调用点直接发**，不把 `EventBus` 再挨个穿进 bot / runtime / builtins 的依赖对象 —— 漏穿一个的表现就是某一类事件永远不到，而这正是 G-SSE-01 的成因。只有拿不到 `LogSink` 的 `QuotaGuard` 是显式收 `EventBus` 的 | 同上 |
| `turn.started` / `turn.finished` 在已有的 `turn.start` / `turn.end` 日志点旁边发 | `packages/telegram/src/bot.ts` |
| `turn.progress`（模型/工具两个相位）与 `usage` 在 `onStepStart` / `onStepEnd` 发 | `packages/core/src/agent/runtime.ts` |
| `TurnRepository.finish` 改用 `UPDATE … RETURNING` 回一份结算统计（steps / toolCalls / costUsd / durationMs），供 `turn.finished` 用；不额外查一次 | `packages/db/src/operations.ts` |
| `QuotaGuard` 接 `EventBus`：`commit` 用 `RETURNING` 顺手拿回已花金额，事务提交后发 `quota`；`QuotaReservation.rows` 多带一个 `limit`（结算时已经拿不到本轮限额了） | `packages/core/src/ledger/quota.ts` |
| `task.updated`：`spawn_agent` 的 running / done / failed 三次迁移 + `report_progress` | `packages/core/src/tools/builtins.ts` |
| `health` 事件在 provider 测试与 MCP 重连之后发；`reconnect` 顺带返回该 server 的 `{state, error}` | `packages/server/src/app.ts` |
| 新增 `GET /api/turns/active`（读进程内 `TurnRegistry`，统计从 `turns` 表一次 IN 取回，缺行补零）与 `POST /api/turns/:id/cancel`（abort 信号，已结束的轮次回 `{cancelled:false}`） | 同上 |
| `EventBus` 提到 `QuotaGuard` / `LogSink` 之前构造；关停时 `log.close()` | `apps/bot/src/main.ts` |
| 前端：事件按类型定向刷新（9 组数据 + 页面可见性过滤 + 400 ms 合并），总览页新增在途 turn 表与 `[取消]`，任务页 running 行加 `[取消]`（说明取消的是整轮），审批卡片写明为什么不给裁决按钮，SSE 徽标区分「连上了」与「有数据在流动」 | `packages/webui/src/views/ConsoleView.vue` |
| 新增 6 条用例：广播阈值与合并窗口、`publish` 不落库、`/api/events` 流上真的收得到、配额事件载荷、`/api/turns/active` 形状、取消端点两种结果与审计 | `tests/sse.events.test.ts` |
| 契约测试补 `/api/turns`、`/api/turns/active` 两条读端点 | `tests/api.contract.test.ts` |

**为什么端点名从 `POST /api/tasks/:id/cancel` 换成 `POST /api/turns/:id/cancel`**：
`tasks` 行由 `spawn_agent` 派发，子 agent 跑在**父轮次**的 abort 信号下，没有独立的取消句柄。
按原名做一个「取消这条任务」的端点，实际行为却是把整轮连同其他子 agent 一起停 —— 那是个会误导人的名字。
界面上任务表的 `[取消]` 仍在，只是打的是轮次取消，并在二次确认里说清楚它停的是什么。

### 4.3 第二轮（G-API-08：附件可见）

| 改动 | 文件 |
|---|---|
| `GET /api/messages` 与 `GET /api/turns` 返回 `attachments`（按 `message_id` 一次 IN 查询归组，**不含 `local_path`**） | `packages/server/src/app.ts` |
| `GET /api/files/:attachmentId?inline=1` 只对光栅图（png/jpeg/gif/webp）放行内联，其余照旧当附件下载 —— mime 来自 Telegram、是发送方可控的，同源内联 SVG/HTML 等于自造 XSS | 同上 |
| 新组件：消息卡片与检索结果下面的附件带子。图片出 92px 缩略图、点开是大图 + 下载；其余按类型出图标 chip（文件名 / mime / 大小 / 尺寸 / 时长 / 「已提取正文」）。`download_state` 不是 `done` 的行打「下载失败 / 超限未下载」徽标并**不给下载链接** —— 点开必然 404 | `packages/webui/src/ui/AttachmentStrip.vue` |
| 契约测试补一条：附件元数据形状、响应里不出现磁盘路径、`?inline=1` 对 png 给 `inline` 而对 svg 仍给 `attachment` | `tests/api.contract.test.ts` |

### 4.4 第二轮（§1.1 的自动生成表单 + G-API-09 的会话级覆盖）

| 改动 | 文件 |
|---|---|
| `GET /api/config/schema` 的 `{schema, hotReloadable, unimplemented}` 三件套改为**放进 `data` 信封**：统一客户端只解 `data`，挂在顶层的兄弟键会被静默丢掉，表单会把每一项都当成需重启 | `packages/server/src/app.ts` |
| 新组件 `SchemaForm`：走一遍 JSON Schema（含 `$ref` 解析、`anyOf[number,null]` 的「不限」）推出控件形态 —— 布尔/枚举/整数小数/字符串/字符串数组（一行一条）/对象与对象数组（JSON 文本域）；每项显示键路径、默认值、取值范围、「热更新 / 需重启 / 未接线」徽标；未接线项默认隐藏且控件禁用；**值为 `«redacted»` 或名字像密钥的字符串一律只读**（写回去等于用字面量覆盖真值）；按键名过滤、只看热更新项、分组折叠、只发真正改过的那几项 | `packages/webui/src/ui/SchemaForm.vue` |
| 设置页接上「全部配置」；保存后按 `hotReloadable` 分类回报，**需重启的键在 Toast 里点名**。保存成功后把表单基线推上去 —— 落库是同步的但 bot 进程要等 `config.changed` 才 `loadConfig()`，紧接着那次 `GET /api/config` 可能还是旧值，不推基线的话保存完按钮还挂着「保存 N 项改动」 | `packages/webui/src/views/ConsoleView.vue` |
| 会话页新增「只对这个会话生效的设置」：当前覆盖以 chip 列出并可逐条 `[取消覆盖]`（空掉的中间层一并收掉），下面复用 `SchemaForm` 但只渲染 `docs/11 §2.1` 白名单内的子树，控件里显示的是**这个会话实际生效的值**（全局 + 覆盖）。`PATCH` 是整体替换而不是合并，所以每次都把完整覆盖对象发回去 | 同上 |
| `logs.captureBodies` 补进 `HOT_RELOADABLE_CONFIG_KEYS`（每轮现读，真的是热更新）；当时将尚未接线的 `skills.defaultMinRole` 改标「需重启」，第三轮接入 Skill 新建默认角色后再改为热更新 | `packages/core/src/config/schema.ts`、`docs/11-config-reference.md` |
| 那条「docs/11 标热更新的键必须真在白名单里」的断言改成**逐段扫全部 yaml 块**（此前只查第一段，`logs` / `skills` / `plugins` 整段漏在外面，三个错标就是这么活下来的） | `tests/config.test.ts` |
| 新增两条用例：`/api/config/schema` 的三件套在同一个 `data` 信封里；`PATCH /api/chats/:key` 是整体替换而不是合并（界面的「取消覆盖」正是靠这条语义） | `tests/config.api.test.ts` |

**一个只有真跑起来才会撞上的坑**：`config` 是深响应式 ref，读出来的嵌套对象是 Proxy，
而 `structuredClone(Proxy)` 直接抛 `DataCloneError` —— 表现是「点了取消覆盖没反应，连报错都没有」。
配置本来就是 JSON 安全的，改走一遍序列化，并把整段包进 try/catch 让失败能冒到 Toast 上。

### 4.5 第三轮（最后六项缺口）

| 改动 | 文件 |
|---|---|
| 抽出并导出 `assembleMainPrompt`，真实轮次与 `POST /api/prompts/preview` 共用工具目录、Skill 目录、Agent 目录、PromptDocuments、per-chat 配置与上下文组装路径；前端展示 block 正文、token 占比与截断状态 | `packages/core/src/agent/runtime.ts`、`apps/bot/src/main.ts`、`packages/server/src/app.ts`、`packages/webui/src/views/ConsoleView.vue` |
| 归档检索与会话卡片接软删入口；`/api/turns` 和 turn detail 的 prompt join 排除 `deleted_at` 非空行，避免删后从轮次视图泄回 | `packages/server/src/app.ts`、`packages/webui/src/views/ConsoleView.vue` |
| `DatabaseApprovalBroker` 改为 pending Promise：插入后发 `approval.pending`，WebUI 裁决、TTL、abort 三条路径原子改状态并唤醒等待调用；批准才继续执行工具 | `packages/core/src/approvals.ts`、`packages/webui/src/views/ConsoleView.vue` |
| MCP server 改用 stdio / HTTP 判别联合 schema；CRUD 统一校验并写 `mcp.servers`、配置 revision、`config.changed`，随后热 reconcile；前端表单覆盖 transport、参数、环境、headers、角色、工具白/黑名单与超时 | `packages/core/src/config/schema.ts`、`packages/server/src/app.ts`、`packages/webui/src/views/ConsoleView.vue` |
| `SkillLoader` 新增安全 create/read/update/remove，正文与 frontmatter 同写 `SKILL.md` 后重扫；`skills.defaultMinRole` 成为新建默认值并热读；扩展页新增正文编辑器 | `packages/core/src/skills/loader.ts`、`apps/bot/src/main.ts`、`packages/webui/src/views/ConsoleView.vue` |
| Agent 试跑创建可审计的隔离 `agent_run`，复用 `runSubAgent` 并以 NDJSON 推 step / usage / final / error；前端可查看工具输入输出、用量并取消流 | `packages/core/src/agent/manager.ts`、`packages/core/src/agent/subagent.ts`、`packages/server/src/app.ts`、`packages/webui/src/api/client.ts` |
| 契约覆盖 pending/批准/拒绝/过期/取消、Skill 文件生命周期、提示词/试跑 API、软删隐藏、MCP/Skill 管理路由 | `tests/approval.rules.test.ts`、`tests/skill.runtime.test.ts`、`tests/api.contract.test.ts` |

### 4.6 第三轮复查补漏

第三轮自查时发现六处「补上了能力但留了口子」，一并修掉：

| 改动 | 文件 |
|---|---|
| **试跑接上配额**：先 `quota.reserve` 再逐步 `commit`，额度不足直接拒绝开跑，`finally` 里 `release` 剩余预留。此前只传了 `ledger` 不传 `quota` —— 用量报表看得见这笔花费、`quota_counters` 却不涨，`global.daily` 对试跑一概无效（`subagent.ts` 的注释警告的正是这个，docs/20 · W-QUOTA-01）。chat/user 计数落在合成 subject `webui-dryrun` 上：试跑花的是真钱，但不该记到某个真实会话头上 | `apps/bot/src/main.ts` |
| **`mcp.enabled` 总开关摆到界面上**：它出厂是 `false` 且 `reconcile` 一上来就对它 early-return，新建 server 会拿到 `ok:true` 加一条永远停在「等待连接」的行。扩展页顶部与新建对话框在它关着时给横幅 + `[打开总开关]`，保存后的 Toast 也改成告警而不是「已连接」 | `packages/webui/src/views/ConsoleView.vue`、`docs/11` |
| **待审角标挂到导航上**：`approval.pending` 原本只刷 `tasks` 组，而该组只在任务页可见 —— 运维不切过去就不知道有个真实轮次正卡着。拆出独立的 `approvals` 刷新组（全页面可见，事件本身很稀疏），左侧导航「任务与审批」出红色计数 | 同上、`packages/webui/src/styles.css` |
| **过期/取消的 hint 不再被记成「已拒绝」**：`rememberWithinTurn` 原本只记布尔，同轮重试一个刚过期的调用会拿到 `DENIED_HINT`，模型据此告诉用户「管理员拒绝了」，而真相是没人来得及看 | `packages/core/src/approvals.ts` |
| Skill 重名从 400 改 409（`apiError` 放行 409），`PUT` / `PATCH /api/skills/:name` 合并成一个 handler —— 两个动词各抄一份 body 映射，改 frontmatter 字段时必然漏掉其中一个 | `packages/server/src/app.ts` |
| `docs/11` 的 🚧 清单里摘掉已接线的 `approval.ttlMs` 与 `mcp.enabled`（`config.test.ts` 那条断言只查白名单 → 文档单向，查不出文档里多标的 🚧）；`docs/13` 补 AC-APV-010/011 与 AC-WEB-049~054，并改掉与新行为矛盾的 AC-APV-008、AC-WEB-043 | `docs/11-config-reference.md`、`docs/13-acceptance-criteria.md` |

---

## 5. 判定为「不是缺口」

| 项 | 理由 |
|---|---|
| `GET /api/health` | 无鉴权探活端点，是给外部监控用的；SPA 该用 `/api/health/detail` |
| `GET /api/logs/blob` | 被 `GET /api/logs/:id/data` 取代（后者带 `content-disposition`，且 blob 解引用一致） |
| `GET /api/messages/:id`、`GET /api/chats/:key/commits` | 列表端点已经返回同样的字段，单条端点是给外部集成留的 |
| `GET /api/models/catalog` | `GET /api/providers/:id/models` 的响应里已经带 `catalog` 状态块 |
| 工具的 `minRole` / `approval` / `scope` 只读 | 单一策略源 `TOOL_POLICY` 在注册期 fail-closed；从界面调低某个工具的最低角色 = 权限矩阵有两份会漂移的真相（docs/09 §3.7） |
| 模型别名不能指向不存在的模型、别名链不能为空 | `PUT /api/aliases/:alias` 的校验，不是缺口 |
| 70 个 `KNOWN_UNIMPLEMENTED_CONFIG_KEYS` | 运行时没接线，**不该**有控件。接线时从白名单里摘掉，同时补控件、改 `docs/11` 的 🚧 清单、复算 §1 的数字 |

---

## 6. 第三轮结论

G-API-10/11/12 与 G-SRV-02/03/04 均已完成；按本文「运行时已有、WebUI 够不着」的口径，
当前没有剩余项。仍存在但**不属于本清单缺口**的边界：

- `POST /api/maintenance/gc-files` 仍显式返回 `not_implemented`，界面继续不提供按钮。
- Telegram inline keyboard 审批仍未实现；WebUI 已是可用审批通道，命中规则的调用会等待 WebUI
  裁决、TTL 或轮次取消，不再当场伪拒绝。**代价是从 Telegram 发起的那一轮会静默停住最多
  `approval.ttlMs`**（默认 180s），发起人侧没有任何提示 —— 所以待审角标现在挂在导航上（§4.6），
  但真正的解法仍是补一条能送达发起人的通道。
- `health` 事件仍只在 provider 测试与 MCP 重连后发送，没有周期心跳；顶栏的新鲜度依据业务事件，
  不把连接状态伪装成周期健康检查。
- `perChat` 白名单里的 `character` 仍是兼容性保留项；会话专属人设继续走
  `memory/CHARACTER.<chat>.md`，覆盖面板不展示这项。
