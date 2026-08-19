# 28 · 第十轮：停机活体测试（真进程 · 真 Telegram · 真 docker · 真时钟 · 真上游）

> ❄️ **已冻结（2026-08-19 快照）** —— 本文只记录当轮的发现与实测值，**不再更新**。文中所有
> 「未实现 / 不可达 / 仍然如此」都是**当时**的状态，不代表现在；当前状态见
> [`00-state.md`](../00-state.md)。条目编号（`L-COST-01` 之类）是源码注释与后续复审的溯源凭据，
> **不得重编号、不得删除**。

> **这一轮换的是手段，不是判据。** 前九轮（`15`–`20`、`22`–`27`）都是读码复审；这一轮把系统
> **真的跑起来**：真进程、真 Telegram（测试 bot `@theswimtestbot`）、真 docker、真磁盘、真时钟、
> 真上游，外加一个可编程的假上游用来构造真 provider 不会按需产生的故障形态。
> 目标只有一个 —— 找**单元测试结构性看不见**的问题。
>
> 全部在 `/home/swim/code/LuoLiCore-staging`（生产 `data/` 的完整副本）上进行，
> **产品代码零改动**，生产库指纹 `sha256sum -c` 全程 OK。

## 0. 结论速览

| | 条数 | 编号 |
| --- | --- | --- |
| **P1（高）** | 7 | `L-COST-01` `L-WEB-04` `L-LOG-01` `L-LOG-04` `L-TOOL-02` `L-EXT-02` `L-EXT-03` |
| **P2（中高 / 中）** | 16 | `L-OPS-01`–`06` `L-TG-02`–`04` `L-LOG-02` `L-LOG-03` `L-PROV-01` `L-SCH-01` `L-SCH-02` `L-EXT-04` `L-EXT-05` `L-QUOTA-02` `L-WEB-01`–`03` |
| **P3（低 / 记录）** | 7 | `L-TG-01` `L-TOOL-01` `L-SCH-03` `L-SCH-04` `L-DB-01` `L-AGT-01` `L-CTX-01` `L-COST-02` |
| **推翻（复核后撤回）** | 1 | `L-QUOTA-01`（见 §5） |

三句话版本：

1. **这一轮找到的东西，几乎全部落在「每一半都有测试、没有一条跨过边界」的位置上。**
   `L-WEB-01`（`/webui` 一次性登录）服务端有完整用例、bot 侧正确、**前端从来不打那个端点**；
   `L-LOG-04`（trace 树）读出侧修过一次、修完之后正确地读着一个**永远是 NULL 的列**；
   `L-TG-04`（限流停摆）所有既有用例都把 `bot.api` 整体替换掉，节流器从没进过测试回路。
2. **只有真上游能发现的那一条，是金额意义最大的一条。** `L-COST-01`：缓存命中的 token 被
   双重计价，**生产库 342 条 ledger 里 270 条有缓存命中，账面 44.4% 是虚的**。
   讽刺的是前缀缓存做得越成功（`4f8e4eb`），账面越贵；而 `quota` 吃的就是这个数。
3. **MCP 那一块有两条独立的高危**，而它是本部署**默认开着**的（`config_kv` 里 `mcp.enabled=true`）：
   子进程死后永远连不回来（`L-EXT-02`），以及每加一台 server 泄漏一个子进程、最终让进程
   无法优雅退出（`L-EXT-03`）。

---

## 1. 装置与方法

### 1.1 为什么必须真跑

摸底确认了三件事，它们共同决定了这一轮的形态：

- **没有任何用例跨过完整链路。** `tests/turn.partial-delivery.test.ts` 用真 grammY Bot 驱动，
  但 `onTurn` 是手写生成器；碰真 `runMainAgent` 的三个用例又都不走 Telegram。两个集合不相交。
- **`composeRuntime` 不存在**（[00 §2.1](../00-state.md) 的 `D-04`），`apps/bot/src/main.ts`
  508 行全是内联装配，集成测试装不起运行时。唯一的真实驱动方式是**把 `main.ts` 当子进程起起来**。
- **一批关键路径执行覆盖率为零**：docker 沙箱从没真跑过、cron 从没真到点触发过、
  grammY 的 throttler 从没进过测试回路、没有任何测试压过多写者并发、SIGKILL + 重启从没真跑过。

`pnpm smoke` 名不副实（32 行，只做 archive+context 的 ordinal 检查，一次模型/工具/Telegram 调用
都没有）—— `AC-OPS-006` 仍是 `[ ]` 是对的。

### 1.2 装置

| 层 | 用什么 |
|---|---|
| 进程 | 真 `apps/bot/src/main.ts`，cwd = staging 根（生效配置里 `sandbox.workspaceDir` 是相对路径）|
| Telegram | **真的**，测试 bot `@theswimtestbot`（7321634203），私聊 + 测试群（bot 为管理员、privacy 关）|
| provider（第一轮） | 本地假上游：OpenAI 兼容 SSE，可编程 `text` / `tool` / `http_error` / `empty` / `stall` / `malformed` / `truncate` / `huge`，并支持按用户正文关键词选剧本 |
| provider（第二轮） | 真上游（`deepseek-v4-flash@ksm-api` 等三家），另做 `[不可达假 provider, 真 provider]` 的混合链 |
| 数据 | 生产 `data/` 的完整副本（175 轮真实历史、915+ 条消息、真实附件树）|

**一个硬约束贯穿全程**：bot token 只能发消息、**不能模拟用户发消息**。所以真实 Telegram 入口
连同**整条流式投递路径**没有无人值守的驱动方式 —— 那部分由真人在一个 30 分钟的窗口里跑完
（20 条私聊/群 + 视觉确认）。无人值守开轮只能走 `POST /api/schedules/:id/trigger`，
而它走的是**非流式** `runMainAgent`。

### 1.3 三道闸

每条结论过三道才写进本文：**①复现**（写下步骤、复跑两次）→ **②归因**（定位 `file:line`，
说清为什么代码会这样）→ **③排除装置伪影**（明确回答「这是假上游/代理/测试 bot/staging 路径
造成的假象吗」）。此外对 10 条最重的结论另派了一次**以推翻为目标**的独立复核 ——
它推翻 1 条、收窄 4 条、另找出 3 条（§5、§6）。

**生效配置 ≠ `config/config.yaml`。** 真正生效的是 `config_kv` 覆盖层（57 行），
本文所有判据按它读：`sandbox.network=bridge`、`quota.enabled=false`、`requirePricing=false`、
`mcp.enabled=true`、`tools.selfExtend.enabled=true`、`provider.requestTimeoutMs=30000`、
`context.limit.tokens=100000`/`maxMessages=30`、`trigger.wakewords=["洛璃","nori"]`、
`approval.rules` 只有 `delete_file` 一条。

---

## 2. P1

### `L-COST-01` 缓存命中的 token 被双重计价 —— 生产账面 44.4% 是虚的

**只有真上游能发现**（假上游返回的 `cached_tokens` 恒为 0）。

真上游三轮基线，第三轮命中前缀缓存：

```
input_tokens=28082（其中 cache_read_tokens=25600）  output_tokens=25
price_in=0.14   price_out=0.28   price_cache_read=0.0028（便宜 50 倍）

库里 cost_usd                          = 0.00401016
按 usage.ts:34 / docs/10 §4.1 的公式    = 0.00401016   ← 逐位吻合
按「输入扣掉缓存部分」                  = 0.00042616
                                          高估 9.4 倍
```

**根因**：`packages/core/src/ledger/usage.ts:34`
`(inputTokens*priceIn + outputTokens*priceOut + cacheReadTokens*priceCacheRead + cacheWriteTokens*priceCacheWrite)/1e6`
把 `cacheReadTokens` 当成与 `inputTokens` **互斥**的一份，在两者之上各收一次钱。
`docs/10 §4.1` 的公式原文一模一样 —— **实现没跑偏，是这条判据本身选错了口径。**

**口径**：Anthropic 的 `input_tokens` **不含** `cache_read_input_tokens`（互斥，公式对）；
OpenAI 兼容口径的 `prompt_tokens` **包含** `prompt_tokens_details.cached_tokens`
（DeepSeek 是 `cache_hit + cache_miss = prompt_tokens`，子集，公式错）。
代码对 provider kind 不做区分，而本部署三个 provider 是 `openai-compatible ×2 + openai ×1`，
**没有一个是 Anthropic** —— 这个公式在这里 100% 的时候都是错的。

**已排除「SDK 已经扣过」这一可能**：`@ai-sdk/openai-compatible` 的
`dist/index.mjs:67` 把 `cacheReadTokens` 取自 `prompt_tokens_details.cached_tokens`，
`inputTokens` 原样取 `prompt_tokens`，没有相减；SDK 提供的 `noCacheTokens` 在本仓零引用。

**同一文件内的矛盾**：`usage.ts:66` 的注释把 `cacheReadTokens / inputTokens` 当**命中率**用
（「这家上游的缓存到底是不是真的，只有这一个数能回答」）—— 那是子集语义。

**生产数据上的量级**（`data/luoli.db`，342 条 ledger，公式复现 339 条逐位吻合）：

| | |
|---|---|
| 有缓存命中的调用 | **270 / 342（79%）** |
| 这些调用现行记账 | $14.459214 |
| 按扣除口径 | $7.738964（**1.9 倍**） |
| 全库现行合计 / 扣除口径 | $15.136235 / $8.415985 |
| **账面高估** | **$6.72 = 44.4%** |

**影响**：不只是报表。`quota.commit(actualCost)` 吃的就是这个数 —— ①用户在缓存命中好的会话里
提前约一倍撞上日额度；②`perTurn.maxCostUsd` 提前触发（轮内被逼着 `toolChoice:'none'` 收尾）；
③前缀缓存做得越成功，账面越贵。

### `L-WEB-04` YAML 往返会擦掉登录口令哈希，实例掉回 setup-token 形态

**触发条件恰好是产品自己推荐的配置。**

- `GET /api/config/yaml`（`packages/server/src/app.ts:568`）对 `looksSecret(key, value)` 为真的行
  **整行跳过**（`packages/core/src/config/redact.ts:13`：叶子段匹配 `/key|secret|token|password/i`
  且值为非空字符串），`webui.passwordHash` 命中。
- WebUI「设置 → 高级」tab 就是 `GET` → 编辑 → `PUT`（`ConsoleView.vue:1542` / `:1553`）。
- `PUT` 拿到的树里已经没有 `passwordHash`，zod 补上默认值 `''`（`schema.ts:348`），
  整个 `webui` 段被写回；`writeConfigRows`（`packages/db/src/config.ts:52-53`）
  额外 `DELETE` 掉旧的 `webui.passwordHash` 行。
- `main.ts:246` 的 `if (!config.webui.passwordHash)` 随即生效，进程掉回 setup-token 形态。
- `host` 是默认 `127.0.0.1` 时 `schema.ts:354` 的 `superRefine` 不拦（它只在非 loopback 时要求口令），
  全程静默。

**为什么说触发条件是推荐配置**：`webui.passwordHash` 只在 `WEBUI_PASSWORD` **存在时**才被
`envPinnedConfigKeys()` 钉住、进而被 YAML 端点的 `pinnedConflicts` 整段排除。而 `.env.example`
那行注释写的是「首次启动时用它生成 `webui.passwordHash`，**之后可以删掉这一行**」，
`POST /api/auth/password`（`app.ts:420`）在被钉住时更是 409 并明说「或清掉它后再用这里」——
**产品明确引导运维删掉这个环境变量、改用 WebUI 改密**。删掉之后这条路就通了。

同一条路径对 `tools.web.searchApiKey` 同理。

### `L-LOG-01` `docs/10 §2` 的「`log_events.kind` 枚举」与实现严重脱节

穷举 `packages/*/src` + `apps/*/src` 的全部 `kind:` 字面量（81 个；已确认无任何动态拼接的 kind），
与文档表比对：

**表里写了、源码零处发出**：`tg.send`、`tg.edit`、`tg.action`、`turn.queued`、`archive.append`、
`skill.load`、`plugin.hook`、`plugin.error`、`tool.denied`、`tool.error`、`media.download`、
`media.extract`、`sandbox.run`、`approval.requested`、`prompt.build`、
`agent.spawn`/`agent.end`/`agent.ask`/`agent.answer`/`agent.progress`。

其中三处是**实打实的观测盲区**，不只是改名：

- **`tool.denied` → 权限拒绝完全静默。** `ToolRegistry.admit()`（`registry.ts:198-217`）里
  role 不够（`:207`）与 `maxCallsPerTurn` 超限（`:215`）都直接 return 不记日志（后者实测：
  45 次调用恰好 40 条 `tool.call`，超出的零日志，模型侧收到不带 hint 的
  `tool_call_limit_exceeded`）。同一批闸里 `tool_not_in_allowlist`、
  `tool_unavailable_for_subagent` 同样静默。
- **`turn.queued` → 排队等待时长不可观测。** `TurnConcurrency.acquire`
  （`turn/concurrency.ts:12`）入队无日志，`turn.start`（`bot.ts:537`）在**拿到槽位之后**才发
  且不带等待时长。「bot 半天不回」是排队还是上游慢，日志分不出来。
- **`plugin.hook` / `plugin.error` → 插件行为全程不可观测。** `PluginManager` 构造函数不接
  `LogSink`（`plugins/manager.ts:34`）；单次钩子失败只 `plugin.errors += 1`，
  要累计到 `autoDisableAfterErrors` 才经告警落一行，而那一行还受 `alerts.on`（**默认 `[]`**）
  与 `dedupeMinutes` 管。实测三轮必抛的 `beforeTurn`：与 plugin 有关的日志 **0 条**。
  `SkillLoader` 同样没有 `LogSink`（`loader.ts:84`），与 `agent.file_invalid` 不对称。

**源码在发、表里没有：36 种**，含生产库里出现最多的 `tg.api`（9745 条 = 全库 12535 条的 **78%**）、
`ctx.token_calibration`（122 条，warn 级第二多）、`config.invalid`、`ctx.abort`、`ctx.invalid_shape`、
`approval.{pending,expired,unavailable,no_rules,receipt_failed,disabled}`、`tool.custom_*`、
`trigger.{coalesced,cooldown}`、`sandbox.{unavailable,weak_isolation}`、`mcp.disconnect`、
`memory.hard_limit`、`prompt.truncated`、`schedule.created`、`system.restart`、`tg.membership`、
`turn.cancel`、`alert.{raised,deliver_failed}`、`maintenance.{cleanup,vacuum}` 等。

**牵连验收**：`docs/13:335` 的 `AC-LOG-001 ★` 期望链里点名 `tg.send`、`prompt.build` 与子 agent 的
`ask`，**四类节点都不存在**，按字面永远不可能通过；`docs/13:389` 的 `AC-PLG-004（自动）`
判据是「只记 `plugin.error`」，同样不可能通过。两条目前都还是 `[ ]`。

**为什么没有断言挡住**：`tests/docs.test.ts` 只焊「复审条目编号指得着」与「🚧 只在活文档」；
工具/上下文用例里 `LogSink` 一律被 stub 成 `{span:()=>…}`。

### `L-LOG-04` `parent_span_id` 全库为 NULL —— Trace「调用树」结构上是一张平表

staging 库：`total 15841 / with_span 11354 / **with_parent 0**`。浏览器里展开一条 trace，
13 个节点的 `style.marginLeft` 全是 `0px`；两轮不同 turn 复现。

**根因**：`parentSpanId` 在全仓只出现在四处 —— 类型声明（`log/sink.ts:14`）、写库
（`operations.ts:22-26`）、读出（`app.ts:980`/`:1594`）、前端展示（`ConsoleView.vue:456/693/2940`）。
**没有任何调用点传过它**，`LogSink.span()` 自身也不维护当前 span 栈。

**为什么这个盲区能活下来**：`ConsoleView.vue:29-31` 的注释记着一次**读出侧**的修复
（「曾经只声明了前 6 个，于是 trace 视图读 `node.parentSpanId` 永远是 undefined」）。
那次修完之后代码看起来对了 —— 它正确地读着一个**永远是 NULL 的列**。
而 `.vue` 模板不进 `tsc --noEmit`（同一段注释自陈），也没有任何断言检查这一列非空。

**与文档冲突**：`docs/10 §1` 画着完整父子树并明写「WebUI Trace 视图按 `parent_span_id` 重建树」；
`docs/10 §7` 第 1 条与第 4 条都以它为前提。与 `L-LOG-02` 叠加之后，
**`docs/10 §1` 那张 trace 图在实现里一条边都不存在。**

### `L-TOOL-02` `tools.fs.allowHostFsForOwner=true` 时 owner 的 fs 工具全线失效

**单元级复现**：

```
new PathJail('/', [])        resolve('/etc/hostname') → THROW path_outside_workspace
                             resolve('a.txt')         → THROW path_outside_workspace
                             resolve('.')             → '/'
new PathJail('/tmp', [])     resolve('a.txt')         → '/tmp/a.txt'   （正常）
```

**根因**：`packages/core/src/tools/jail.ts:40`
`if (real !== this.root && !real.startsWith(\`${this.root}${sep}\`)) throw` ——
`realpathSync('/') === '/'`，于是右边是 `'//'`，而没有任何真实路径以 `//` 开头。

**影响**：一个 `docs/09:305` 标着「已接线（第五轮）」、且**不在** `docs/11 §2.0.1` 未接线白名单里的
开关，打开后把 owner 的文件工具整体打死，报错还长得像安全拦截
（`path_outside_workspace`，`list_dir '/'` 回 `{ok:true, entries:[], skipped:22}`）。

**连带**：为这个模式专门写的那批 deny-glob（`<root>/config/**`、`<root>/data/luoli.db*`、
`<root>/memory/**`、`<root>/skills/**`、`<root>/plugins/**`，以及 `selfAuthoringDenyGlobs()`）
**从未被真正执行过** —— `jail.ts:6-14` 的 docstring 自陈它们挡的就是这条路。
默认模式（jail 根 = workspace）下这些绝对路径由 jail 本身挡住（`path_outside_workspace`），
所以**不是安全洞**，但这层防御没有任何实测支撑。相对模式那批（`**/.env*`、`**/*.pem`、
`**/.ssh/**`）照常生效（实测 `.env.local` → `path_denied`）。

### `L-EXT-02` MCP stdio 子进程死后永远连不回来，两条恢复路是同一条死路

**复现（3/3）**：`kill -9` 掉 agent-browser 子进程 → `mcp-health` cron 两次 + 显式
`POST /api/mcp/agent-browser/reconnect` 一次，全部 `mcp.error "Not connected"`、`state='down'`，
**一个新子进程都没起**。改一下 `args`（进指纹）立刻重连成功 —— 对照组闭环。

**根因**：`packages/core/src/mcp/manager.ts:58`
`if (existing && existing.fingerprint === print) return existing.client;` —— 只比连接参数指纹，
**不判活性**。子进程死后 `#clients` 里那条缓存永远命中；`discover()` 拿死 client 调 `listTools()`
必抛，`reconcile()` 的 catch 只写 `state='down'`，**不从 `#clients` 删**；transport 也没有
`onclose` 把它摘掉。`/api/mcp/:name/reconnect`（`app.ts:1519`）只是 `await reconcile()`，
与 cron 完全同路 —— **「重连」按钮结构上点不动任何东西**。

**影响**：那台 server 的工具被 `reconcile()` 开头的 `unregisterBySource('mcp')` 摘掉后再也回不来，
模型侧表现是能力凭空消失；唯一恢复手段是重启进程或改一次 server 参数。
本部署 `mcp.enabled=true` 且开着一台 stdio server。

### `L-EXT-03` MCP server 的新增/指纹变更会泄漏 stdio 子进程，一条就足以让进程无法优雅退出

**复现（3/3 + 一次直接观测到关停挂死）**：`POST /api/mcp` 建一台 stdio server →
`pgrep -P <botpid>` 得到**两个**子进程；两次 fingerprint-变更 PATCH → 2→3→4。
随后 SIGTERM：`system.stop` 落盘、HTTP 端口已关、`luoli.db-wal` 已消失（`closeDatabase` 跑完了），
但进程**存活 >100 秒**，fd 里挂着指向泄漏子进程的 pipe；`kill -9` 那几个之后 node 立刻退出。
只剩一个被跟踪子进程时同一条关停是 0 秒 —— 干净对照。

**根因**：一次写入触发**两次重叠**的 reconcile ——
`persist.ts:29` 的 `ports.emit(['mcp.servers'])` → `EventBus.emit`（`events.ts:22`，**同步**遍历）
→ `main.ts:362` 的订阅者同步起 `void loadConfig(...)` 后立即返回 → 端点接着
`await dependencies.mcp?.reconcile()`（`app.ts:1491`）；`loadConfig` 落地后 `main.ts:373` 再跑一次。
`reconcile()` 没有任何串行化（全仓 `KeyedMutex` 只用在 `context/engine.ts:143` 与 `bot.ts:116`）。
两条都在 `connect()` 里看到 `existing === undefined`（R1 还卡在 stdio 握手的 await 里），
都 `new StdioClientTransport(...)` spawn 子进程，`#clients.set` 只留住后来的那个。
`mcp.close()`（`manager.ts:150`）只遍历 `#clients`；而 MCP SDK 的 `StdioClientTransport`
不 `unref` 子进程 —— **一条**泄漏的 refed handle 就足以让 event loop 不空，
而 `shutdown()`（`main.ts:441-470`）只设 `process.exitCode`、不 `process.exit()`。

**范围（复核后收窄）**：只有**新增**或**指纹变化**的 PATCH 会泄漏；只改 `minRole`/`timeoutMs`
之类不进指纹的字段两条都命中缓存，零泄漏；`DELETE` 更安全（R1 已从 `#clients` 摘掉）。
它是竞态而非必然 —— 但 `loadConfig` 是毫秒级 fs+zod、stdio 握手是百毫秒级 spawn，实际大概率发生。

---

## 3. P2

### `L-OPS-01` 第二个实例启动会就地清掉在位实例的在途状态

A 在跑且有一条 `running` 的轮次（`inFlightTurns: 1`），用同一 token、同一库、另一端口起 B。
B 起来约 4 秒后，A 那条**仍在执行**的轮次变成
`state='failed', error='process_restarted', finished_at=<B 启动时刻>`；随后 A 才收到 409 关停 ——
**赢的是后来者**。

**根因**：`recoverAfterCrash(db)`（`packages/db/src/database.ts:47`，`main.ts:43` 调用）无条件执行
`UPDATE turns SET state='failed',error='process_restarted' WHERE state IN ('queued','running')`，
外加 `UPDATE messages SET claimed_at=NULL,claimed_by_turn=NULL`、
`UPDATE quota_counters SET reserved_usd=0`。它假定「进程启动 ⇒ 上一个进程已死」，
而没有任何东西保证这一点 —— 没有文件锁、没有 DB 锁、没有 PID 检查。

**影响**：本机误跑一次 `pnpm dev`（仓库自己在 `tests/shutdown.test.ts:29-31` 警告过它会抢走长轮询）
不仅顶掉生产实例，还会把它正在跑的轮次判死、释放已认领的消息、清零在途预留额度。
`docs/01 §3.1` 为横向扩展保留的抽象在这条面前是空的。

### `L-OPS-02` 启动窗口内 `POST /api/restart` 让进程裸崩，且不留任何日志

复现 2/2：

```
2026-08-19T00:22:34.413Z INFO system.start 洛璃 started
2026-08-19T00:22:34.640Z INFO webui.action POST /api/restart
ReferenceError: Cannot access 'restart' before initialization
    at Object.restart (apps/bot/src/main.ts:348:201)
    at Timeout._onTimeout (packages/server/src/app.ts:1705:42)
```

`main.ts:348` 把 `restart: (reason) => restart(reason)` 传给 `createServer`，而 `const restart`
声明在 `main.ts:436`；HTTP 在 `main.ts:355` 就开始监听。窗口 ≈ 从 HTTP 监听到 `schedule.loaded`
（实测 `system.start` 后约 1.0–1.1 秒），**Telegram 慢时更长**。

**一个字都不落的原因**：`process.on('uncaughtException')` 注册在 `main.ts:483`，**也在窗口之后** ——
窗口内抛出的异常拿不到那个处理器，于是没有 `system.crash`、没有优雅关停、没有 WAL checkpoint。
同一窗口里 `process.once('SIGTERM')`（`main.ts:472`）也还没挂上。
而 `/api/health` 在整个窗口里已经回 `ok`。

### `L-OPS-03` BOT_TOKEN 失效时进程在启动期裸崩，WebUI 也起不来

```
GrammyError: Call to 'getMe' failed! (401: Unauthorized)
    at Bot.init (grammy/out/bot.js:171:22)
    at createTelegramBot (packages/telegram/src/bot.ts:79:3)
    at async <anonymous> (apps/bot/src/main.ts:382:9)
```

`bot.ts:79` 的 `await bot.init()` 抛出后异常从 `main.ts:382` 的**顶层 await** 逃逸。
设计里处理 401 的是 `main.ts:404-408` 的 `poller.onFatal`，但那只覆盖**轮询**阶段。
且同样落在 `L-OPS-02` 的窗口内，所以没有 `system.crash`、没有优雅关停。

**影响**：换 token / token 被撤销是常规运维动作，撞上之后进程反复起不来，而**你恰恰需要 WebUI
才能改 token** —— 违背 `main.ts:85-89` 自己确立的原则（「缺 `main` 别名只警告，不 fatal，
好让 WebUI 还能进去改」）。`BOT_TOKEN` **缺失**被正确处理（`main.ts:423-429`），
**失效**无人接 —— 两条路不一致。

### `L-OPS-04` 崩溃恢复完全不可观测

`recoverAfterCrash`（`database.ts:47`）返回 `void`、不记任何日志，而它在 `main.ts:43` 被调用 ——
**`LogSink` 到 `main.ts:69` 才创建**，结构上没法记。一次非正常重启之后，
「reap 了几条 turn / task / agent_run、释放了多少认领、清了多少预留」在日志里一个字都没有。
`docs/00 §2` 自述 8-18 那两次崩溃「只能靠 `turns` 表里两行 `process_restarted` 反推」，
正是这条造成的。**紧邻它的 token 修复块（`main.ts:46-50`）用 `process.stdout.write` 报告了** ——
同一位置、同样在 LogSink 之前，说明这条路是通的。

### `L-OPS-05` `VACUUM` 把整库写进 WAL，而 `vacuum()` 不 checkpoint

37 MB 的库上 `POST /api/maintenance/vacuum` 期间 WAL 冲到 39,325,432 字节，**84 秒后仍是 38 MB**。
`maintenance.ts:43` 的 `vacuum()` 只有 `this.db.exec('VACUUM')`；`checkpoint()`（`:47`）
只挂在 `cleanup()` 末尾（`:137`）。默认 cron 是 `db.vacuumCron '0 5 * * 0'`（周日 5 点）与
`general.maintenanceCron '0 4 * * *'`（每天 4 点），所以每次周维护之后 WAL 要以整库大小挂约 23 小时；
同一 tick 内两个 cron 的先后并不稳定（实测两种顺序都出现过）。

### `L-OPS-06` `gcFiles()` 的错配保护挡不住它自己描述的那种错配

`POST /api/maintenance/gc-files` → `{files:0, agentResults:74, agentResultBytes:19779}`。
`agent_runs` 269 行带 ref，其中 **161 行指向另一个部署根**；被删的正是「盘上在新根、库里记着旧根」那批。

**根因**：守卫只覆盖 `if (!referenced.size)`（`maintenance.ts:158`）—— 只挡「一条带路径的行都没有」
这种**全错配**。而它 docstring 自己描述的场景（「`LUOLI_DATA_DIR` 指到别处」）产生的是
**部分错配**：`referenced` 非空，守卫结构性地不可能触发。

**路径存法不对称（复核后修正）**：把结果路径变成绝对的不是 `prompt/documents.ts:106`
（它忠实于被喂进来的目录），而是 `apps/bot/src/main.ts:103`
`process.env.LUOLI_DATA_DIR ? resolve(env,'agent-results') : resolve('data/agent-results')` ——
`resolve()` 无条件产出绝对路径，且无 env 时**绑定启动那一刻的 cwd**。
反过来 `attachments.local_path` 存相对路径（`media.dir` 默认 `./data/files`）
**是保护而不是共犯**：`maintenance.ts:193-194` 的 `referenced()` 与 walk 用同一个 cwd 归一化，
媒体目录天然免疫根变化。脆的恰恰是绝对存储那一半。

**触发条件（收窄）**：不是「任何部署根变化」，而是「`LUOLI_DATA_DIR` 变化」或
「无 `LUOLI_DATA_DIR` 时启动 cwd 变化」。`main.ts:99-102` 的注释显示作者防的是**同一次运行内**
的空间性错配，没意识到绝对路径带来的**时间性**错配。

### `L-TG-02` 分段回复的最后一段会被后续轮次的回复插队

一条 9469 字的回复被切成 3 条 Telegram 消息，Telegram 分配的 id 是 **1458、1459、1467** ——
中间隔着 1460~1466（三轮后续对话）。**真人在屏幕上确认**：先出现两段，
在「代码 / 慢慢想 / 工具」三条回复之后才冒出第三段。

**根因方向**：每一段各自过一次 `apiThrottler`（`bot.ts:82` 的 `out: { minTime: 1000 }`），
段与段之间存在「上一段落地后才排下一段」的空档，别的轮次的 `sendMessage` 在空档里插进队列。
（未逐行定位到分段循环，故标为「根因方向」。）

### `L-TG-03` 分段投递时，归档给每一段都存了一份**完整全文**

同一轮的 3 条出站消息在 `messages` 表里是 3 行，**每行 `length(text)` 都是 9469**，
head/tail 完全相同。**上下文侧是对的**：`context_messages` 只有一条（9614 字节）。
连带 `messages_fts` 也是三份 → `search_messages` 会把同一条回复搜出三次；归档体积按分段数翻倍。

### `L-TG-04` 群内并发把 per-chat 限流预算吃光，投递停摆约 14 秒

在一个 `trusted` 群里快速连发 5 条 `@bot N` 打出 6 轮并发（`perKey=3` 排队）：

```
02:14:06 → 02:14:23   该群约 20 次 API 调用（sendMessage ×8、sendChatAction ×6、edit ×1 …）
02:14:23.605 → 02:14:37.591   ← 整整 14 秒零投递
02:14:37.591 sendChatAction   14455ms
02:14:37.633 editMessageText  14028ms
```

`telegram.throttle.perChatPerMinute: 20` 的储备在 17 秒内被消耗完。
`docs/00 §2` 记 8-18 那次三分钟延迟的修复是「typing 上一拍没落地就跳过这一拍，**队列不再增长**」——
实测在并发下队列仍然增长到 14 秒：那个修复减少了 typing 的**数量**，但
**typing 与正文编辑仍共用同一份 20/分钟 预算**，上面那一刻排在队首的 `sendChatAction`
占的正是 `editMessageText` 要用的槽位。用户视角是「bot 打字打到一半不动了」。

### `L-LOG-02` `tg.api` 没有 `traceId`，投递侧的 span 全是游离行

生产库 `kind='tg.api'` 共 9745 条，`trace_id IS NULL` 的是 **9745 条（100%）**。
人工窗口那 14 轮里实际发生 25 次 `sendMessage` + 22 次 `editMessageText`，
按 `trace_id` 归轮的结果是**每一轮都是 0**。且 `data` 只有 `{method, ok}` —— 没有 chars、
没有 messageId、没有正文。「这一轮到底发了什么、编辑了几次」在日志里查不出来。

`docs/10 §1` 的 trace 图里画着 `tg.send span K` / `tg.edit span L` 挂在 turn 之下；
实现里 API transformer（`bot.ts:83-88`）不带任何 turn/chat 上下文。
**WebUI 上的表现**：Trace 视图从 `ctx.token_calibration` 直接跳到 `ctx.commit`，
缺的正是投递那一段，而**界面上没有任何提示** —— 头部只写「13 spans」，
没有「本轮还有 N 条无 trace 事件」的计数。
同时 transformer 装在 `autoRetry` 与 `apiThrottler` **之后**（grammY 后装的在最外层），
所以 `durationMs` 含节流排队与全部重试退避，重试次数不可见。

### `L-LOG-03` 模型给出非法工具参数时，日志里一条记录都没有

两次实测（`get_message({messageId:0})`、漏了必填参数的 `bash`）`tool.call` 计数都是 **0**，
唯一痕迹是上下文里那条 `output.type='error-text'` 的 tool-result（下一轮就被 `prune_level=1` 抹掉）。
入参校验发生在 AI SDK 内部（`AI_InvalidToolInputError`），`ToolRegistry.execute` 根本没被调到。
**`kind: 'tool.error'` 在源码里是 0 处**，而 `docs/10 §2` 有这一行。

2026-08-18 那次打崩进程的事故起点就是 `get_message({messageId:0})`；即使崩溃已修，
「模型反复用错参数」这件事在日志里仍然完全不可见。

### `L-PROV-01` 发生 fallback 时 `model.call` 记的是**失败的候选**

链 `fake-bad(不可达) → deepseek-v4-flash@ksm-api`（**真上游**）：
日志 `model.call 2690ms rig-fake-bad.chat/fake-bad`，账 `usage_ledger` 记 `deepseek-v4-flash@ksm-api`。
**同一次调用在日志与账里指向两个不同的 provider。**

**根因**：`runtime.ts:836` 的 span 用 `event.provider` / `event.modelId` —— 那是 AI SDK
**step 开始时**的模型，而 fallback 发生在 `fallbackLanguageModel` 中间件内部，SDK 看不见。
`onServed` 明明已经把真正服务的候选记进了 `servedModelId`（`runtime.ts:708`），span 没用它。
`docs/10 §7` 第 3 条要求「每次模型调用能看到 provider/模型/别名」—— 一旦 fallback 就都是错的。

### `L-SCH-01` 启动窗口内经 HTTP 触发的定时任务会跑完整轮、花掉模型钱，然后整轮作废

`/api/health` 一回 ok 就 `POST /api/schedules/:id/trigger`（实测在 `system.start` 后 321ms）：
轮次正常开、跑 2 步、`usage_ledger` 记了 $0.30，最后
`turn.end error='delivery_failed:telegram_unavailable'`、**不提交**。

**根因**：`telegramTools`（`main.ts:200-204`）只要有 `BOT_TOKEN` 就**立刻非空**，
但它持有的 `bot` 要到 `main.ts:382` 才赋值。`runner.ts:135` 的 `if (!bridge)` 判的是外层对象 ——
**那条 `telegram_unavailable` skip 分支（本应不开轮）是死代码**。
`main.ts:205-206` 的注释把这件事说得完全正确（「`load()` 要等 bot 起来」），所以 cron 触发是安全的 ——
**但 HTTP 手动触发端点绕过了 `load()`**，而 HTTP 从 `main.ts:355` 就在监听。

### `L-SCH-02` 定时任务的失败不计入 `consecutive_turn_failures` 告警

`consecutiveFailures` 只存在于 `packages/telegram/src/bot.ts:95`（Telegram 轮次处理器内），
`ScheduledJobRunner` 里 `alerts` 一次都没出现。于是「上游变黑洞、每次定时触发都超时」这类故障，
在没人聊天的部署里一次告警都不会响 —— 而 `docs/10 §6` 把这条告警定义为「这个部署坏了」的信号。

### `L-EXT-04` `pnpm dev`（tsx）下 plugin 热重载装得像成功了，实际一直跑旧代码

`plugin.js` 的 `VERSION` 从 v1 改到 v11，每次 `POST /api/plugins/:name/reload`：
reconcile 每次都真跑（11 次 `onLoad` / 10 次 `onUnload`、DB 更新、无 `load_error`），
但**每次 `onLoad` 打印的都是 v1**。最小复现：`node probe.mjs` → `v1 → v2`（正常）；
`node --import tsx/loader probe.mjs` → `v1 → v1`（写入前后各 sleep 2.5 秒仍如此，排除 mtime 粒度）。

tsx 的 ESM loader 按文件路径缓存、忽略 URL 上的 `?v=`，于是 `plugins/manager.ts:61` 的
cache-busting 在 tsx 下整体失效。**生产不受影响**（`pnpm start` 跑 `dist/` 的纯 node）。
但 `CLAUDE.md` 把 `pnpm dev` 定为本地运行方式，而 `plugins.watch` 的既定用途正是
「本机写 plugin」（`manager.ts:192` 注释）—— 唯一该用它的场景恰好是它静默失效的场景。

**顺带量化**（纯 node）：cache-busting 本身无界 —— 同一文件带唯一 `?v=` 连 import 30 次、
每份模块级持有 4 MB → RSS 54 MB → 175 MB，显式 `global.gc()` 后不回落。
`onUnload` 能清掉规矩 plugin 注册的定时器/句柄，泄漏的是**模块记录本身与它持有的模块级内存**。

### `L-EXT-05` `reconcile()` 先清空后重建，于是每 5 分钟出现一段「MCP 工具全部消失」的窗口

`manager.ts:94-95` 先 `registry.unregisterBySource('mcp')` + `#tools.clear()`，
然后逐台 server **串行** `await discover()`，每台最长 `mcp.connectTimeoutMs`（默认 15s）。
这段窗口内 `ToolRegistry.catalog()` 交给模型的目录里**一个 MCP 工具都没有**，
而 `mcp.healthCheckCron` 默认 `*/5 * * * *`（`main.ts:141`）周期性打开这个窗口。
本部署开着 `agent-browser`（stdio，state=up），意味着每 5 分钟有一段模型突然看不见浏览器工具的时间；
一台连不上的 server 会把窗口拉到 15 秒以上。修法是先在临时表里 discover 完再原子替换。

### `L-QUOTA-02` 限流拒绝复用了额度文案，占位符直接漏给用户

真人看到的原话：**「今天的额度用完了（已用 —/—），下个额度窗口 重置。」**
而真实原因是「这一小时你已经开了 30 轮」，与金额无关。

`bot.ts:463` 对非 `concurrent` 的拒绝一律回 `config.quota.onExceeded.message`，
并把 `{spent}`/`{limit}` 替换成 `—`。**紧邻的 `concurrent` 分支（`bot.ts:459-462`）自己论证过
这么做的危害** —— 注释原文「`concurrentPerUser` 挡下来的不是额度……而『今天的额度用完了』
会让人当天不再尝试」—— 并给了专门文案。同一个论证没有应用到
`turnsPerUserPerHour` / `turnsPerChatPerHour` 这一档。

**连带观察**：定时任务的轮次计入创建者的 per-user 限流额度 ——
本轮测试用定时任务跑的 38 轮把 owner 自己挡在了门外（真人实测撞上）。

### `L-WEB-01` `/webui` 一次性登录链接整条功能是死的 —— 前端从未兑换 token

配好 `webui.publicUrl` 后私聊发 `/webui` → 收到 `<publicUrl>/login?t=<token>` → 点开 →
**控制台要求输入密码**（真人实测）。

`packages/webui/src/views/LoginView.vue:11` 把 `route.query.t` 读进了 `token`，
但 `:20` 只在 setup 分支里发它（`props.setup ? { token, password } : { password }`）——
登录分支只 POST `{ password }`。**`grep -rn "auth/token" packages/webui/src/` 零命中。**

**为什么没被挡住**：三方各自有测试，没有一条跨过前后端边界。
`tests/webui.gaps.test.ts:152-163`「C1 · /webui 一次性登录」验了单次使用、过期、401、set-cookie ——
它自己的注释写着「**逐个钉住服务端那一半**」；`docs/08:504` 说「命令 / handler / 服务端端点三者由
CI 断言锁死」，锁的正是这三者，**不含前端消费那一跳**；而 `docs/09:72` 明写
「前端拿它打 `POST /api/auth/token` 换 session」。
**佐证**：用假 token 直接打端点回 `{"ok":false,"error":{"code":"invalid_token"}}` —— 端点是活的。

安全上 fail-closed（退化成密码框，token 不泄漏也不会被误认），故定中高而非高。

### `L-WEB-02` YAML 覆盖层往返一次，代码默认值被永久钉死

`GET /api/config/yaml` → **一个字不改** → `PUT` 回去：生效覆盖**叶子**数 **73 → 171**，
凭空多出 98 个从没被覆盖过的键（`db.path`、`tools.fs.denyGlobs`、`tools.fs.allowHostFsForOwner`、
`provider.catalog.*`、`skills.package.*`…），值全等于当时的代码默认值。
第二次往返起幂等 —— **第一次保存就钉死了，之后界面上看不出来**。

**根因**：`app.ts:585-593` —— `runtimeConfigSchema.safeParse(tree)` 让 zod 把每个 `.default()` 填满，
随后 `rows = applicable.map(key => [key, readDotted(parsed.data, key)])` 写回库的是填满之后那份。
GET 那一侧（`:562-571`）是对的；`PUT /api/config`（`:489-491`）的注释更明写「键仍以请求体为准……
不能顺手把整棵树写下去」—— 同一份自觉在 YAML 端点上没落实。

**粒度（复核后修正）**：落库的是 `[顶层段, 整棵子树]`，`config_kv` 的**行数反而下降**
（`writeConfigRows` 会 `DELETE` 掉所有 `startsWith('<段>.')` 的旧行）。
「73 → 171」说的是**生效覆盖叶子数**。

`docs/09 §3.13` 与界面上的说明文字都逐字警告过这件事（「导进另一个部署等于把那一刻的默认值钉死」），
并量过「243 个叶子里只有 21 个偏离默认值」—— 往返一次之后是 171。
**真正的爆炸半径见 `L-WEB-04`。**

### `L-WEB-03` `gc-files` 的 fail-closed 拒绝被渲染成绿色「完成」

制造「一条带路径的行都没有」→ 维护页点「清理孤儿文件」→ toast class 是 `toast success`、
标题「清理孤儿文件 完成」，拒绝理由挤在一行 JSON 的 `refused` 字段尾巴上，8 秒后自动消失。
`ConsoleView.vue:1628` 的 `pushToast({ severity: 'success', summary: \`${label} 完成\`, … })`
severity 与标题写死，不看 `result.refused`。

而 `refused` 的唯一触发条件就是「库与目录来自两套部署」，正是运维最该立刻停手的那一种
（`maintenance.ts:198` 注释：「静静地『删了 0 个』会让运维以为目录本来就是干净的」；
`docs/25 §10` 记的误删 76 个附件 + 90 份子 agent 全文就是它防的）。

---

## 4. P3（低 / 记录）

### `L-TG-01` 优雅关停时被中止的长轮询记成 `tg.api` **error**

生产库 `kind='tg.api' AND level='error'` 共 **42 条，42/42 落在某次 `system.stop` 的 3 秒内**
（56 次关停）。也就是说这个部署至今**没有过一次真实的 Telegram API 故障**，但日志里躺着
42 条 error 级噪声。`UpdatePoller.stop()`（`polling.ts:74`）abort 掉在途 `getUpdates`；
`#fetch` 的 catch（`polling.ts:99`）确实吞掉了它 —— 但 span 在更低一层就已经记成 error 了
（`bot.ts:83-88` 的 transformer 不知道「我们正在关停」）。
代价：真出 Telegram 故障时与正常重启在日志里长得一样。

### `L-TOOL-01` 输出超过 `2 × maxOutputBytes` 时子进程被 SIGKILL 且整次调用记 `ok:false`

让模型连续调 `bash` 跑 `python3 -c "print('A'*400000)"`：命令**确实执行了**
（`tool.call` 的 output 里有 stdout），但返回 `{ok:false, exitCode:null}`，三次之后
`tool.disabled_after_errors  Disabled bash after 3 failures`（**本轮**停用，`releaseTurn` 会清）。

**复核后收窄**：`sandbox/index.ts` 里有**两种**截断 ——
`clipped(stdout, cap)`（`:255-256`，头尾各半 + 省略标注）只置 `out.truncated`，**不影响 `ok`**，
那才是 `docs/05:204` 描述的那一种；而 `truncatedByCap`（`:243`）的触发条件是单条流累计到
**`cap * 2`**，触发时同一行**立刻 `kill()`** 子进程，此时 `exitCode` 本来就不是 0。
所以 `:258` 的 `!truncatedByCap` 几乎是冗余的。

**残留的真问题（比初判窄得多）**：①`docs/05:204` 与 `docs/11:237` **只描述了截断，一个字都没提
「超过两倍就 SIGKILL 并把整次调用记成失败」** —— 一条只是输出多的正常命令（`cat` 大文件、
verbose 构建）会被杀掉并报失败，模型收到 `ok:false` 会倾向原地重试；②「子进程已自己退出 0、
但最后一批 >128KB 的输出在 `close` 之前才 flush 完」这个竞态窗口里 `kill()` 打空，
`exitCode === 0` 而 `truncatedByCap === true` → 一次成功调用被记成失败。

### `L-SCH-03` 合成 `tg_message_id` 撞号的核对是死代码

`docs/02:653` 要求「分配之后必须核对 `append` 的返回值：`tgMessageId` 与分配值不等就抛
`schedule_trigger_conflict`」。而 `packages/db/src/archive.ts:136` 在 `INSERT OR IGNORE` 没插进去时，
用 `WHERE chat_id=? AND tg_message_id=? AND revision=?` 把行读回来 —— 绑的就是入参那个 id，
所以返回行的 `tgMessageId` **恒等于入参**，`runner.ts:242` 的比较永远为假。
要真看见撞号得判 `run().changes` 或比对返回行的 `id`。
`grep schedule_trigger_conflict tests/` 零命中。
可达性低（`runner.ts:235` 取 `MAX+1`，单进程内 SELECT 与 INSERT 之间没有 await），
但 `L-OPS-01` 已经证明「两实例同库」是能发生的。

### `L-SCH-04` 角色降级告警文案指错对象

`schedule/runner.ts:130` 写死「**创建者**已被封禁」，而触发它的判据是 `min(用户角色, 会话角色)` ——
封的是**会话**时文案同样这么说，运维会去查错的对象。

### `L-DB-01` 混合查询里 <3 码点的 token 被静默丢弃且无兜底

`packages/db/src/archive.ts:60-63`：`matchable = tokens.filter(t => [...t].length >= 3)`；
只要存在任意一个 ≥3 码点的 token，**全部 <3 码点的 token 被整体丢弃**，matchable 之间用 ` OR ` 连接。

**复核后收窄**：FTS5 用的是 trigram（`migrations/0001_init.sql:30`），
实测 2 码点词 `MATCH` 恒 0 而 `LIKE` 有 6 条 —— 所以**丢弃本身是正确降级**，
纯 2 字查询也会走 `{ like }` 分支能命中。`archive.ts:44-49` 的 docstring 写明了这个理由。
**真缺陷只在**：查询中同时含长短 token 时，短 token 既没有 per-token 的 LIKE 兜底，
也不回报给调用方 —— `search_messages("名字 李小明")` 只按 `李小明` 检索，而模型不知道。

### `L-AGT-01` 收尾补跑说是「一次」，实现上是一整个工具循环

`docs/00 §2` 写「追加**一次**禁工具的模型调用」，而 `runtime.ts:888` 调的是 `agent.generate(...)` ——
`ToolLoopAgent` 的整个循环。实测：让上游在禁工具的收尾调用里仍返回 `tool_calls`，
收尾阶段又跑了 12 步（`steps=24`），最终 `turn.wrap_up chars=0` + `model_returned_empty`。
触发条件是「上游在 `tools:[]` 的请求里仍返回 tool_calls」——真模型不会配合，
故本轮只在假上游上复现；成本上界仍由 `perTurn.maxCostUsd` 兜着。

### `L-CTX-01` 读出侧的孤儿修复按 id **全局**匹配，同窗口内 id 重复会让真孤儿逃过修复

`runtime.ts:414-419` 先扫全量 `source` 建 `answered` 集合，再逐条判 `!answered.has(id)`。
只要窗口内**任何位置**存在同名 `toolCallId` 的 tool-result，那条真正没有结果的 tool-call 就不会被补。
而 AI SDK 的 `convertToLanguageModelPrompt` 是**有序**校验
（`ai/src/prompt/convert-to-language-model-prompt.ts:130-172`），于是直接抛
`MissingToolResultsError` 在发请求之前 —— 会话每一轮都以
`Tool result is missing for tool call <id>.` 失败、`steps=0`、**一条 `ctx.orphan_tool_call` 都没有**，
直到窗口推过那条或 `/new`。
**触发条件**：`toolCallId` 在同一窗口内重复。真实 provider 的 id 是随机的，概率很低，
故记为潜在健壮性缺口。修复方向是按位置配对而不是全局集合。

### `L-COST-02` `quota.ts:173` 的 `modelCost()` 是死代码，且带着 `L-COST-01` 的同一份公式

全仓（含 `tests/`）零调用点，而它把重复计价的公式又抄了一份
（`input.input * price.input + … + cacheRead * price.cacheRead`）。
修 `usage.ts:34` 的人只改一处就走，下一个人接上这个函数就是同一个 bug 复活。

---

## 5. 复核后**撤回**的结论

### ~~`L-QUOTA-01`~~ `quota.enabled=false` 关不掉 rateLimit —— **不是缺陷，是有意设计**

本轮一度记了这一条（依据是 `bot.ts:451` 的 `canStart` 不看 `config.quota.enabled`，
而 `descriptions.ts:291` 写「关掉之后不再拦截」）。**独立复核推翻了它**，三条证据：

- `docs/10 §5.1:269`：`rateLimit:  # 与金额无关的防滥用` —— 分类写死在规格里；
- `packages/webui/src/views/ConsoleView.vue:2458` 有一条专门的红条：
  「`quota.enabled` 已关闭：所有金额限额都不再判定……**频率限制（下面那组）不受这个开关影响，
  仍然生效**」；
- `docs/13:475`（`AC-WEB-033`）把这条红条列为验收项。

代码侧也一致：`quota.enabled` 被消费的地方全是**金额**闸。而被引的 `descriptions.ts:291` 原文是
「**花费配额总开关**。关掉之后不再拦截，但用量仍然照常记账。」—— 主语在第一个词就限定了，
是初判截掉了限定语。**留在这里是为了让下一轮不必再查一遍。**

---

## 6. 跑过、没有发现问题的地方

**下一轮先读这一节。** 每一项都是在真环境上跑过的，不是读码判定。

### 6.1 进程生命周期

| 场景 | 结论 |
|---|---|
| 空库冷启动 | 9 条迁移、37 张表、owner 落位、setup token 打印、缺 `main` 别名只警告且给出可操作引导、`approval.no_rules` 正确触发 |
| SIGTERM + 在途轮次 + 开着的 SSE | `graceMs` 到点后 `abortAll`，轮次记 `cancelled/cancel_reason='shutdown'`，30.16 秒退出 |
| SIGKILL 后重启 | `recoverAfterCrash` 把轮次记 `failed/process_restarted`、WAL 恢复、`reserved_usd` 清零、任务重新装载 |
| 双实例抢 token | 409 → `onFatal` → 优雅关停、退出码 1（**但见 `L-OPS-01`：赢的是后来者**）|

### 6.2 上下文引擎与 provider

| 场景 | 结论 |
|---|---|
| tool 输入校验失败的完整链（`a56a914` 的回归） | **修复成立**：`tool-error` 进了 `stepToolResults`，落了配对 `tool-result`（`output.type='error-text'`），下一次请求形状完好，无孤儿 |
| 读出侧孤儿修复（唯一 id 的正常情况） | 删掉某条 tool-result 后触发：`ctx.orphan_tool_call Repaired 1 tool-call(s)`，请求里补出占位结果，轮次正常提交 |
| `wrapUpIfNeeded` 正常路径 | 13 次请求 = 12 步带工具 + 1 次 `tools:[]` 收尾，`turn.wrap_up chars=15`，提交；`maxSteps=12` 守住 |
| 同一 context key 的**真并发**两轮 | 同一 base 开出；先提交 `rebased:false`，后提交 `rebased:true` + `ctx.rebase{base,onto}`；两轮都提交 |
| 分级裁剪不碰判别字段 | 64KB 工具输出 → `prune_level=2`/`1`，481 字节；最后一次请求 22 组 `tool_calls`/`tool` 消息，`id`/`name`/`tool_call_id` **一个不缺** |
| fallback 链 | 3 次尝试（`maxRetries=2`）→ `willRetry`/`willFallback` 标志正确 → `provider.fallback{from,to,reason}` → 次位候选服务并提交 |
| provider 健康全周期 | 判死（3 次探测失败）→ 被排除出探测 → **冷却到期把库里那行改回 `up`/0** 后重新探测。与 `docs/04 §5.3` 的四条判据一致 |
| `turnTimeoutMs` 三档判定 | `state='failed'`、`error='turn_timeout'`、`cancel_reason='timeout'`、`turn.end` error 级「turn timed out」|
| 配置热更新 | `PUT /api/config` 改 `concurrency.turnTimeoutMs` 等**无需重启**即生效 |
| **真上游基线** | 三轮 `deepseek-v4-flash@ksm-api` 全 committed；`turns.cost_usd` 与 `sum(usage_ledger.cost_usd)` **逐位相等**；第三轮 **25600/28082（91%）前缀缓存命中** —— `4f8e4eb`/`075f7d7` 的缓存前缀工作在真网关上确实生效（假上游测不出来）|

### 6.3 工具与沙箱（**docker 此前零执行覆盖**）

| 场景 | 结论 |
|---|---|
| docker argv | `ps -eo args` 实抓，与 `sandbox/index.ts:209-214` **逐项一致**；容器内 `id` = `uid=1000(sandbox)` |
| `--memory` / `--pids-limit` | 分配 2GB → `exitCode:137, oom:true`；fork 炸弹 → `sh: 0: Cannot fork` |
| 网络 | `bridge` 下公网可达、宿主 172.17.0.1 上绑 0.0.0.0 的端口可达（绑 127.0.0.1 的不可达）；`--network=none` 对照 curl exit 6 |
| 超时 → `docker kill` | 3 秒内被 kill，`docker ps -a` **零残留**（`--rm`）|
| `-v` 卷映射 / `--read-only` / `--tmpfs` | 容器内写入落到宿主 workspace；`/` `/etc` 只读；`/tmp` 可写、大小 = `tmpfsMb`、`noexec` 生效 |
| jail 四条 `ulimit` | `-f`/`-t`/`-u`/`-v` 与配置逐项对得上；`nprocCeiling()` 取值合理；env 白名单只有 `PATH LANG TZ` |
| `PathJail` 五类穿越 | `../` / 绝对路径 / 符号链接指向 `/etc/passwd` / 符号链接指向 staging 根 / 相对上跳链接 → 全部 `path_outside_workspace`；`.env.local` → `path_denied` |
| owner `bash` 绕 deny-glob | `docs/00 §2` 那条**现在仍然如此**：`write_file` 写 `skills/` 被挡（fs 侧 ✓），同一轮 `bash` 直接 `mkdir` 成功。与文档一致，不算新洞 |
| 工具策略三条不变量 | 覆盖绕不过 `available()` ✓；`timeoutMs:null` 的工具不吃超时覆盖 ✓；目录过滤热更新即时生效 ✓ |
| 审批三条路 | `approval.unavailable`（无 SSE 通道）立即拒绝且不插 pending 行 ✓；TTL 恰好 20.000s 后 `approval.expired`、`decided_by=system`、轮次照常收尾 ✓；批准/拒绝（`POST /api/approvals/:id/decide`，与按钮同一 handler）→ 执行进 `.luoli-trash/` / 模型收到 DENIED_HINT ✓ |
| SSRF | `127.0.0.1:8788`→`port_blocked`、`169.254.169.254`→`ssrf_blocked`、`file://`→`unsupported_protocol`、**`127.0.0.1.nip.io`（DNS 解析到私网）→`ssrf_blocked`**、**公网 302 跳进 127.0.0.1 → `ssrf_blocked`（每跳复验）**；`untrusted-content` 双层包裹带随机 nonce |
| 子 agent | `agent_runs` 主/子两行齐全，子行 `effective_role=limited`（owner 派发也不提权）；结果落盘；`read_agent_result` 分页读回正确 |

### 6.4 定时任务（**此前全靠手动 `trigger()`，本轮是真时钟**）

`at` 一次性任务在目标时刻**迟 5 ms** 触发并 committed、`state='done'`/`run_count=1`；
cron 真触发，`minIntervalMinutes: 5` 正确挡住 `*/1` 与 `*/4`；
**停机 4.5 分钟跨过两个触发点 → 3 条 `schedule.missed{catchUp:false}`，一条都没补跑**；
触发时重算角色三档全对（`limited` → `skipped{role_downgraded}` 且任务留存、`blocked` → `cancelled`）；
`mode='notify'` 也开完整轮次且产出进上下文。
**时区没有判据分叉**：端点与工具都不收客户端 timezone，统一取 `general.timezone`，
按行 timezone 触发成立。五个维护 cron 压到每分钟后全部真到点。

### 6.5 扩展

skill 包安装的权限位（`scripts/*` 保 `rwx------`、目录 `drwx------`）正确；
三类恶意包全部挡住（`../` 越界 / 缺 SKILL.md / 符号链接）；
**「装了一半整棵回滚」红线成立** —— 超限失败后原树一字未动、无 `.staging-*` 残留、表里无行，
成功覆盖那条路旧树完整躺在 `.backups/`；
chokidar 100 ms 去抖生效（2 ms 内写 41 个文件只触发 2 次重扫）；
`plugins.hookTimeoutMs` 精确 5000 ms；`autoDisableAfterErrors` 第 3 轮准确禁用；
自我扩展主闸成立（`define_tool` 落库 `enabled=0`，禁用期间模型硬调也拿不到，
改正文再 define 会 `reset:true` 打回未启用 —— `docs/07 §6.1` 防「先无害后恶意」有效）。

### 6.6 DB

7 路并发轮次 + WebUI 轮询 + VACUUM + gcFiles + rebuildFts + backup 叠加：
7 轮全 committed、6 轮 `rebased=1`、0 失败，**`SQLITE_BUSY` 日志 0 条**。
这是**结构性**的：better-sqlite3 同步 + 单连接 + 单线程，进程内不存在争用 ——
`busy_timeout=5000` 只有在出现第二个写进程时才有意义（即 `L-OPS-01` 那种情形）。
`rebuildFts` 18 ms；1143 条真实中文消息上逐条对「LIKE 子串真值」，FTS5 与 LIKE 两条路
**结果全部精确**。`gcFiles` 对 185 个真实媒体附件**零误删**。

### 6.7 Telegram（真人 + 真 Telegram）

毒 markdown 渲染正确（行内代码是代码样式，`1bf5dcc` 的修复成立），全程零 `tg.parse_fallback` ——
`safeRender` 的「全量转义 + 反解白名单」扛住了表格 / 未闭合星号 / 超长 URL / 裸特殊字符 / 围栏代码块；
`/cancel` 屏幕上出现「（生成中断）」且已投出内容进归档；
媒体全类型下载落盘（照片 ×2、语音 ogg、PDF 抽出 10616 字、贴纸 webp）；
**含图轮次自动切 `vision` 别名**（令 `main` 指向声明不支持看图的模型后，`usage_ledger` 记
`model_alias='vision'`）；有效角色取 min 成立（owner 在 trusted 群里被抿平成 trusted，
群内 `blocked` 用户即使群 trusted 也被拒）；四种群触发全部命中；
群内连发 5 条打出真并发且 `perKey=3` 生效、多轮 `rebased:true` 全部提交；
被拒用户的消息仍进归档；限流拒绝的消息被正确 `demoteToBackground`；
空闲过期裁剪在**真实时钟**上触发（`idleMs:892760`）。

### 6.8 WebUI 与可观测性（真浏览器）

14 个导航页 + 4 个设置子 tab 在真实数据下 **console 报错/警告 0 条、非 2xx 请求 0 条、无空白页**；
SSE 实时刷新实测（触发一轮后 1.5 秒内总览卡片自动更新）；
**`docs/27 · S-01` 复验已修复未回归**（`trustProxy=false` 下 12 次错口令并每次换 `X-Real-IP`：
1–5 → 401，6–12 → **429**，一次都没绕过）；
setup token 全路径通（独立实例）；CSRF/Origin/cookie/安全头齐全且比 `docs/09 §7` 多四项收紧；
**SSE 四条硬约束全过**（心跳精确 20.00s、200.05ms 合并且尾包带 `merged:5`、`debug` 不广播、
SIGTERM 后 **11ms** 被 `closeAll()` 关掉）；
`perChat` 覆盖白名单在 `PUT /api/config` 与 `PATCH /api/chats/:key` **两条路上都是硬边界**，
env pinned 键 400 并点名该改哪个变量，`__proto__` 400（`W-CFG-01` 未回归）；
日志载荷解引用两条读出路径都对（磁盘 1.5 MB 的 blob 能完整取回，**不是占位对象**）；
**日志脱敏零命中**（390 文件 / 400.3 MB / 16946 行，针包括三个真实 provider **解密后的明文 key**、
`LUOLI_MASTER_KEY`、生产与测试 BOT_TOKEN，跑两次都是 `hits: []`，**阳性对照 9/9 触发**）。

---

## 7. 本轮**没有**覆盖到的

标出来是为了不让下一轮把它们当成「查过了」。

- **群内背景发言认领**：所有群轮次 `ctx.open` 都是 `claimed:0` —— 唯一一条非触发消息在最后一轮
  之后才到，没有后续轮次去认领它。要测得先发背景消息、再发触发消息。
- **一个能看图的别名都没有时的降级**（图片换占位文本 + 回复末尾提示）：本轮 `vision` 别名可用，
  走的是切换路径。
- **审批的 WebUI 按钮与 Telegram 发起人回执的实际观感**（后端裁决路径已跑通）。
- **`docs/00 §2` 的不变量②「`approvalFor` 抬档只升不降」** 未单独构造（做法已清楚，与审批
  场景的时间窗冲突）。
- **plugin 热重载在 bot 进程内的 ESM 泄漏实测**：被 `L-EXT-04` 的 tsx 缓存挡住，
  只能在纯 node 下单独量。要在真进程里量得先 `pnpm build` + `pnpm start`。
- **模型侧 `install_mcp` / `write_plugin` 两条通道**：只做了代码核实（`enabled:false` 写死），
  没让模型真调。
- **`L-EXT-02` 在 http transport 上是否同样不可恢复**：只验了 stdio（`connect()` 的指纹短路对
  两种 transport 是同一段代码，但没实测）。
- **构造上不可复现的**：0 步空流、畸形 SSE、中途挂住、链首 ECONNREFUSED —— 真 provider 不会
  按需产生这些形态，本轮全部由假上游构造；`L-AGT-01` 需要「上游在 `tools:[]` 时仍返回 tool_calls」，
  `L-CTX-01` 需要 toolCallId 重复，真上游都不会配合。

---

## 8. 方法：本轮**排除**了什么

三道闸里第三道（排除装置伪影）挡下了 8 条看起来像模像样的「发现」。记在这里是因为
下一轮如果用同样的装置，会再撞上同样的坑。

| 观察 | 为什么排除 |
|---|---|
| `ctx.token_calibration` 报 `est=207225 / real=1200` | 假上游返回固定 `prompt_tokens`。生产 122 条真实校准里 ratio 与 `real/est` 吻合，机制正常 |
| 轮次 `error='Invalid JSON response'` | 假上游把缺失的 `stream` 字段当成流式；定时任务走的是**非流式** `runMainAgent` |
| 4538 条 `tg.api` 的 `data` 里没有 `method` | **历史**：分界线干净（最后一条 08-17T16:04:15Z，第一条有 method 08-17T16:43:29Z，之后 0 条），`mergeSpanData` 已修 |
| 3 条 `system.crash` 都是 `unhandledRejection` | **历史**：当前代码走 `system.unhandled_rejection` 且不退出（`main.ts:504`）|
| 「孤儿修复失效」 | 假上游早期版本跨轮次复用 `call_N_0`，窗口里已有同名结果。改成唯一 id 后修复正常 —— 副产物是 `L-CTX-01` |
| MCP stdio 子进程被遗弃 | 不成立：实测无 `ppid=1` 的 `agent-browser`，stdio 管道关闭时子进程自己退出 |
| 事件循环「满屏 450 ms 卡顿」 | 探针用了 Node `fetch()`，undici 连接处理本身就 ~450 ms；同时刻 curl 基线 0.4 ms |
| 「生产上 `install_mcp`/`install_skill` 的审批降档是绕过护栏来的」 | 查 `config_revisions` + 日志：08-18T12:46 是 `PATCH` 先 409、再带 `confirmRelax:true` 重试，落库并记了 `warn tool policy relaxed` —— **护栏当时正常工作，那是运维的知情决定** |

另有 1 条经独立复核后**整条撤回**（`L-QUOTA-01`，见 §5），4 条被收窄
（`L-EXT-03` 的触发范围、`L-TOOL-01` 的根因、`L-WEB-02` 的粒度、`L-DB-01` 的实质、
`L-OPS-06` 的根因位置）。
