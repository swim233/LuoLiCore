# 21 · WebUI 控制面覆盖缺口

> **口径**：本文只回答一个问题 —— **「运行时真的有这个能力，但运维在 WebUI 里够不着」**。
> 三类东西不算缺口，单独列在 §5：运行时压根没接线的配置项（那是 `KNOWN_UNIMPLEMENTED_CONFIG_KEYS`
> 的事）、被别的端点取代的重复端点、以及有意做成只读的地方。
>
> 盘点时间：2026-08-16。数字口径见 §1 开头的复算方法，改了 schema 或页面之后重跑一遍即可。

---

## 0. 一句话结论

盘点前，`config.schema` 的 **151 个已接线配置叶子里只有 15 个**能在 WebUI 改（触发 9 + 输出 5 +
工具开关 1 + Agent 定义 1），**配额、沙箱、维护操作、扩展启停、配置历史、退出登录**六块能力
后端全都实现了、前端一个入口都没有。本轮把这六块接上，可写覆盖率从 15/151 提到 **44/151**。

剩下的 107 项与 §3 的六条端点级缺口逐条列在下面。其中 **G-SSE-01（WebUI 的实时刷新完全没工作过）**
是唯一一条 P0：它不是「少一个入口」，而是整个界面的数据新鲜度假设不成立。

---

## 1. 配置项覆盖

复算方法（改了 schema 或页面之后重跑）：拿 `config/config.schema.json` 展平成叶子路径，
扣掉 `KNOWN_UNIMPLEMENTED_CONFIG_KEYS` 与 `perChat`（它是覆盖层容器不是配置项），
再和页面上实际能写的键取差集。

| | 数量 |
|---|---|
| schema 叶子总数 | 224 |
| 运行时从不读（`KNOWN_UNIMPLEMENTED_CONFIG_KEYS`） | 72 |
| `perChat`（覆盖层容器，不是配置项） | 1 |
| **已接线** | **151** |
| ├ 本轮之前 WebUI 可写 | 15 |
| ├ 本轮新增可写 | 29（配额 17 + 沙箱 12） |
| └ **仍然只能改 `config.yaml`** | **107** |

### 1.1 已接线但 WebUI 改不了的 107 项

按 schema 分组。**表里每一项都是运行时真的会读的值** —— 改不了意味着运维只能停机改 YAML。

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
| `approval` | 4 | `enabled` `skipForOwner` `rememberWithinTurn` `rules` |
| `plugins` | 4 | `dir` `hookTimeoutMs` `order` `autoDisableAfterErrors` |
| `general` | 3 | `timezone` `maintenanceCron` `shutdown.graceMs` |
| `skills` | 3 | `dir` `watch` `defaultMinRole` |
| `mcp` | 3 | `healthCheckCron` `defaultMinRole` `servers` |
| `db` | 3 | `path` `backupKeep` `vacuumCron` |
| `prompt` | 1 | `maxTokens` |
| `output` | 1 | `maxMessageChars` |

**这里面最该先补的几项**（判据是「出事时运维第一时间会想去点的那个开关」）：

- `logs.level` / `logs.captureBodies` —— 排障时唯一想临时调大的两项，**都在热更新白名单里**，
  改完立刻生效，却只能停机改 YAML。
- `access.defaultUserRole` / `access.defaultChatRole` / `access.archiveBlocked` —— 同样热更新，
  被刷屏时想收紧默认角色，现在做不到。
- `approval.enabled` / `approval.rules` —— 热更新，是高风险工具的闸门。
- `agent.main.modelAlias` / `main.maxSteps` —— 热更新，换主模型是日常操作。
- `context.limit.*` —— 热更新，上下文炸了要调窗口。
- `tools.maxCallsPerTurn` / `tools.exec.*` —— 热更新。

> 剩下的多数是 `dir` / `path` / `cron` / 端口这类**改了也要重启**的部署期配置，
> 放进 WebUI 的收益远小于前面这批。真要一次做完，正路是把 `GET /api/config/schema`
> 已经返回的 `{schema, hotReloadable, unimplemented}` 三件套喂给一个自动生成的表单
> （docs/09 §3.13 里那条标 🚧 的「由 config.schema.json 自动生成表单」），而不是手写 107 个控件。

### 1.2 假控件：界面上能点，运行时不读

| ID | 位置 | 说明 | 状态 |
|---|---|---|---|
| G-CFG-01 | 设置 › 触发与唤醒词 › `编辑旧消息不重新触发` | `trigger.ignoreEditedAsTrigger` 在 `KNOWN_UNIMPLEMENTED_CONFIG_KEYS` 里：编辑消息一律按背景消息归档（docs/20 · W-TG-05）。这个勾选框存得下、运行时没人读 | ✅ 本轮改成禁用 + 「未接线」徽标 |

全表扫过一遍，**除此之外没有第二个假控件** —— 配额页新增的 5 个未接线键刻意不给控件，只列名字。

---

## 2. API 端点覆盖

服务端注册了 80 条 `/api/*` 路由。逐条比对 WebUI 的调用点后：

### 2.1 后端有、前端没有入口（真缺口）

| ID | 端点 | 缺的是什么 | 优先级 | 状态 |
|---|---|---|---|---|
| G-API-01 | `GET/PUT /api/quota` `POST /api/quota/reset` | 配额限额与实时计数器 | P1 | ✅ 本轮补（新增「配额」页；`GET` 此前根本不存在、`PUT` 是 `not_implemented` 桩） |
| G-API-02 | `GET/PUT /api/sandbox` `POST /api/sandbox/probe` | 沙箱 mode / 资源限制 / `bypassRoles` / 可用性探测 | P1 | ✅ 本轮补（工具页新增沙箱卡片） |
| G-API-03 | `POST /api/maintenance/*` | 备份 / VACUUM / 清理日志 / 重建 FTS | P1 | ✅ 本轮补（设置页） |
| G-API-04 | `PATCH /api/skills/:name` `DELETE /api/skills/:name` `PATCH /api/plugins/:name` `POST /api/plugins/:name/reload` `POST /api/mcp/:name/reconnect` | 扩展页此前是纯只读卡片，启停与重连都没有 | P1 | ✅ 本轮补 |
| G-API-05 | `GET /api/config/revisions` | 配置变更历史（谁在什么时候把哪个键改成了什么） | P2 | ✅ 本轮补（设置页「变更历史」） |
| G-API-06 | `POST /api/auth/logout` | **界面上没有退出登录** —— 只能等 session 过期或手删 cookie | P2 | ✅ 本轮补（顶栏） |
| G-API-07 | `GET /api/health/detail` | 总览页「依赖健康」四行是**写死的字**，沙箱恒显示「Docker」，与 `sandbox.mode` 无关 | P1 | ✅ 本轮补（改为真实数据 + MCP / 在途 turn / 版本 / 运行时长） |
| G-API-08 | `GET /api/files/:attachmentId` | **图片与文件在 WebUI 里完全不可见**：消息列表不返回 attachment id，也没有任何地方能点开。当前库里有 8 条附件、9 条非文本消息 | P1 | ❌ 未补 |
| G-API-09 | `PATCH /api/chats/:key` | 会话级配置覆盖（`perChat.<key>.trigger` / `.output` 等白名单项）。docs/09 §3.13 写明「设置页不提供」，但会话页也没提供 —— 这个端点目前**只能用 curl 打** | P2 | ❌ 未补 |
| G-API-10 | `POST /api/prompts/preview` | 提示词组装预览（「这个会话下最终发给模型的 system prompt 长什么样」） | P2 | ❌ 未补 |
| G-API-11 | `DELETE /api/messages/:id` | 归档消息软删。合规/隐私诉求下唯一的删除通道 | P2 | ❌ 未补 |
| G-API-12 | `POST /api/approvals/:id/decide` | 审批裁决按钮。**后端本身是半残的**（没有可用审批通道，命中规则当场拒绝，`decide` 对非 pending 行只回 `changed:false`，docs/09 §4），补了按钮也只能对历史行点 | P3 | ❌ 未补，建议连同审批通道一起做 |

### 2.2 docs/09 §4 承诺了、后端也没有

补 UI 之前得先补后端。

| ID | 端点 | 对应的界面承诺 | 优先级 |
|---|---|---|---|
| G-SRV-01 | `POST /api/tasks/:id/cancel` | docs §3.1 在途 turn 表的 `[取消]`、§3.12 任务表的 `[取消]`。**Telegram 侧有 `/cancel`，WebUI 侧没有任何取消通道** | P1 |
| G-SRV-02 | `POST /api/agents/:name/dryrun` | docs §3.9 的 `[试跑]` | P3 |
| G-SRV-03 | `POST/PATCH/DELETE /api/mcp[/:name]` | docs §3.8 的 MCP transport 配置表单与启停。当前只有 `GET` + `reconnect`，增删改只能改 `mcp.servers` | P2 |
| G-SRV-04 | `POST /api/skills` `PUT /api/skills/:name` | docs §3.8 的 Skill 新建与正文编辑（「含正文读写」） | P3 |
| G-SRV-05 | `POST /api/maintenance/gc-files` | 孤儿文件清理。显式返回 `not_implemented`（按项目先例这是对的，界面上因此不给按钮） | P3 |

### 2.3 契约测试的假绿灯（已修）

`tests/api.contract.test.ts` 对 21 条读端点只断言 `status === 200`。未注册的 `/api/*` 会掉进
SPA fallback（`app.get('*')` 返回 `index.html`，200），所以 **`GET /api/quota` 这条断言在端点
根本不存在的情况下绿了很久**。本轮改成同时断言 `content-type: application/json` 与信封的 `ok:true`。

---

## 3. SSE 事件覆盖

docs/09 §5 列了 9 种事件。实际 `events.emit(...)` 的调用点只有两处：

| 事件 | 文档 | 实际 |
|---|---|---|
| `config.changed` | ✓ | ✅ 会发（`PUT /api/config`、`PATCH /api/chats/:key`、`PATCH /api/tools/:name`、`PUT /api/sandbox`、`PUT /api/quota`） |
| `approval.decided` | 未列在文档里 | ✅ 会发 |
| `log` `turn.started` `turn.progress` `turn.finished` `usage` `quota` `approval.pending` `task.updated` `health` | ✓ | ❌ **一次都不会发** |

### G-SSE-01（P0）：WebUI 的实时刷新从来没有工作过

`ConsoleView.vue` 的 `onMounted` 里只监听 `event: log`，而 **`LogSink` 的构造函数根本没有
`EventBus` 参数**（`apps/bot/src/main.ts:59`），日志写入路径上没有任何 emit。结论：

- **首屏 `load()` 之后，界面再也不会自己刷新**。看到的永远是打开那一刻的快照。
  已实测：另一进程往库里写了 skill / plugin / mcp 行，界面上要手动刷新页面才出现。
- 顶栏与日志页的「实时 / 在线」徽标只反映 **EventSource 连上了**，不反映有数据在流动 —— 它连着，
  但那根管子里一个字节都没有。
- 源码里多处注释（`syncTrigger` / `syncOutput` / `loadConversations` 上方）都写着
  「日志 SSE 每来一条事件就重跑 `load()`，所以表单要防回写覆盖」。**这套防回写机制是为一个
  从不发生的事件写的**；机制本身无害（将来接上就需要），但注释描述的现状是错的。

**建议的修法**（本轮未做 —— 它动的是每一条日志都要走的热路径，值得单独决策）：

1. 给 `LogSink` 加一个可选的 `events?: EventBus`，在 `event()` 落库之后 emit
   `{id, ts, level, kind, traceId, summary}`（**只发摘要，不发 `data`** —— payload 能到几百 KB，
   全量广播会把 SSE 连接打爆）。
2. 加 level 阈值与节流：`debug` 级别默认不广播；同一 `kind` 在 200 ms 内合并成一条。
   现在的 `events.addEventListener('log', () => void load())` 是**每条事件重拉 17 个端点**，
   接上之后不节流会立刻变成自我 DDoS。
3. `turn.*` / `usage` / `quota` 四种事件在 `runtime.ts` 与 `bot.ts` 已有的日志点旁边顺手 emit，
   总览页的在途 turn 表（docs §3.1）才有数据来源。

本轮的临时缓解：把监听改成 `['log', 'config.changed', 'approval.decided']` 三种，
至少「另一个标签页改了配置」「审批被裁决」能反映过来。

---

## 4. 本轮改了什么

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
| 72 个 `KNOWN_UNIMPLEMENTED_CONFIG_KEYS` | 运行时没接线，**不该**有控件。接线时从白名单里摘掉，同时补控件 |

---

## 6. 建议的下一批

按「出事时够不着的程度」排，不按工作量：

1. **G-SSE-01** —— 界面的数据新鲜度假设不成立，其余所有页面的价值都被它打折。
2. **G-SRV-01** —— WebUI 没有任何办法取消一个跑飞的 turn。
3. **G-API-08** —— 图片和文件在管理端完全不可见。
4. **§1.1 里那批热更新键的表单** —— `logs.level` / `access.*` / `approval.*` / `agent.main.*` /
   `context.limit.*`；正路是把 `GET /api/config/schema` 接上自动生成表单，而不是手写控件。
5. **G-API-09** —— 会话级覆盖目前只能 curl。
