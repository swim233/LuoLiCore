# 01 · 总体架构

## 1. 分层与模块边界

```
┌───────────────────────────────────────────────────────────────────────────┐
│ L5  接入层 Ingress                                                        │
│  packages/telegram   grammY 长轮询/Webhook · 中间件链 · 媒体下载 · 输出器 │
│  packages/server     Hono HTTP · REST /api · SSE /api/events · 静态 SPA   │
├───────────────────────────────────────────────────────────────────────────┤
│ L4  编排层 Orchestration                                                  │
│  Router          准入 → 角色解析 → 归档 → 触发判定 → 建 turn              │
│  TurnRunner      快照 → 跑 agent → 提交(commit/rebase) → 裁剪 → 输出       │
│  TaskManager     长任务生命周期 · 取消 · 进度推送                          │
├───────────────────────────────────────────────────────────────────────────┤
│ L3  智能层 Intelligence                                                   │
│  AgentFactory    AI SDK ToolLoopAgent 装配（模型/工具/停止条件/prepareStep）│
│  PromptAssembler 固定头部系统提示词装配（ASSIST/CHARACTER/MEMORY/环境块）   │
│  AgentBus        父子双向通信（ask_parent / answer / progress / result）    │
│  ProviderRegistry AI SDK provider registry（DB 驱动，热更新）              │
├───────────────────────────────────────────────────────────────────────────┤
│ L2  能力层 Capability                                                     │
│  ToolRegistry    内建工具 · Skill · Plugin · MCP 统一注册与权限过滤        │
│  Sandbox         none / jail / docker 三种执行隔离                         │
│  MemoryStore     ASSIST/CHARACTER/PUBMEMORY/PRIMEMORY 读写与版本           │
├───────────────────────────────────────────────────────────────────────────┤
│ L1  状态层 State                                                          │
│  ContextEngine   ★ 快照 / commit / rebase / 裁剪 / 背景消息认领            │
│  Archive         Telegram 原始消息归档 + FTS 检索                          │
│  Ledger          usage 记账 · 配额计数                                     │
│  LogSink         结构化 JSONL + DB 索引                                    │
├───────────────────────────────────────────────────────────────────────────┤
│ L0  持久层 Persistence                                                    │
│  packages/db     Drizzle schema · 迁移 · 强制 chat 作用域的 Repository     │
│  文件系统        data/files · data/workspace · memory/ · skills/ · logs/   │
└───────────────────────────────────────────────────────────────────────────┘
```

### 依赖方向硬规则

- **只允许上层依赖下层**。`ContextEngine` 不得 import `telegram`；`Archive` 不得 import `AgentFactory`。
- 跨层反向通知统一走**事件总线**（`EventBus`，进程内 `EventEmitter` + SSE 转发），而非直接调用。
- 唯一允许「跨层读」的对象是 `Config`（只读快照）与 `Logger`。
- 所有 DB 访问必须经 `packages/db` 的 Repository，**禁止在业务层写裸 SQL**（例外：`Archive` 的 FTS 查询，集中在 `ArchiveRepo` 内）。

---

## 2. 请求全链路时序

以「群聊 @bot」为典型路径：

```
Telegram Update
  │
  ├─(1) grammY middleware: dedupUpdate(update_id)            → 重复直接丢弃
  ├─(2) resolvePrincipals: role(user), role(chat)
  │       effective = min(...)   若 = blocked → 记 log 后静默丢弃（不回复）
  ├─(3) mediaGroupDebounce(1.5s)                              → 合并同 media_group_id
  ├─(4) downloadAttachments → data/files/<chatId>/...         → 抽取文档文本
  ├─(5) Archive.append(messages 行 + attachments 行 + FTS)    ★ 无论是否触发都入库
  ├─(6) TriggerMatcher                                        → 非触发则到此结束
  │
  ▼ 触发
  ├─(7) QuotaGuard.precheck(user, chat, global)               → 超额则回复额度提示并结束
  ├─(8) ConcurrencyGuard.acquire(key)                         → 超过 perKey 上限则排队/拒绝
  ├─(9) Turn 创建：turns 行 state=running, base_commit=HEAD(key)
  │
  ├─(10) ContextEngine.openTurn(key)   ── 加 key 锁 ─┐
  │        a. base = refs.done(key)                  │
  │        b. claim 背景消息 (claim_watermark, 上限 N)│  锁内完成，≈ms 级
  │        c. snapshot = materialize(base)            │
  │        d. 释放锁                                 ─┘
  │
  ├─(11) PromptAssembler.build(ctx)  → system(固定头部, 可缓存) 
  ├─(12) AgentFactory.main(...)  → ToolLoopAgent.stream()
  │        loop: prepareStep(activeTools by role, 硬天花板 prune, 模型选择)
  │              ├─ 文本增量 → TelegramOutput.stream(editMessageText 节流)
  │              ├─ 工具调用 → ToolRegistry.execute(权限校验 → 沙箱 → 日志)
  │              └─ 重任务   → spawn_agent → subagent(独立上下文)
  │                              ◄── ask_parent / report_progress (AgentBus)
  ├─(13) 出站消息 Archive.append(direction='out')
  │
  ├─(14) ContextEngine.commitTurn(turnId, delta)  ── 加 key 锁 ─┐
  │        a. head = refs.done(key)                             │
  │        b. head === base ? fast-forward : rebase(标记)        │
  │        c. 分配 ordinal（→ 完成顺序）                          │
  │        d. 写 context_messages + context_commits + refs       │
  │        e. prune(): 轮后裁剪 → 必要时再写一个 kind='prune' commit│
  │        f. 释放锁                                            ─┘
  │
  └─(15) 收尾：turns.state=committed · Ledger 落账 · 日志 flush · SSE 广播
```

**关键不变量**：步骤 (12) 期间**不触碰共享上下文**。所有产物累积在内存 `delta` 中，只有 (14) 写库。因此任何崩溃都不会留下半截上下文。

---

## 3. 进程模型与并发

- **单进程**：`apps/bot` 同时拉起 grammY 与 Hono（D15）。
- **并发单位是 turn**。全局并发上限 `concurrency.global`（默认 8），每 context key 上限 `concurrency.perKey`（默认 3），超出进入 FIFO 等待队列（`concurrency.queueMax`，默认 20；再超则回复「排队已满」）。
- **锁**：`KeyedMutex`（进程内 `Map<string, Promise>`）保护 `openTurn` / `commitTurn` 的临界区。临界区内**禁止任何网络/模型调用**。
- **多实例**（非第一版目标）：SQLite WAL 模式下多进程写会争锁。若未来横向扩展，需把 `KeyedMutex` 换成 DB 行级 advisory lock（`context_locks` 表 + `INSERT OR FAIL`）并迁移 Postgres。已在 [14](./14-open-questions.md) 记录。
- **优雅退出**：收到 `SIGTERM` 后停止拉取新 update，等待在途 turn 至 `shutdown.graceMs`（默认 30s），超时则取消并标记 `turns.state='cancelled'`，最后 flush 日志与 WAL checkpoint。

---

## 4. 目录结构

```
LuoLiCore/
├── apps/
│   └── bot/                        入口：装配所有模块、拉起 bot + http
│       └── src/main.ts
├── packages/
│   ├── core/
│   │   ├── context/                ★ ContextEngine
│   │   │   ├── engine.ts           openTurn / commitTurn / prune
│   │   │   ├── materialize.ts      commit → ModelMessage[]
│   │   │   ├── tokenizer.ts        token 估算（+ 真实 usage 校准）
│   │   │   └── render.ts           背景消息 [发言人 时间] 前缀渲染
│   │   ├── turn/                   TurnRunner · ConcurrencyGuard · KeyedMutex
│   │   ├── agent/                  AgentFactory · AgentBus · subagent 定义
│   │   ├── prompt/                 PromptAssembler
│   │   ├── provider/               ProviderRegistry · 定价表 · fallback
│   │   ├── tools/                  内建工具实现
│   │   │   ├── fs.ts  exec.ts  archive.ts  memory.ts  agent.ts  web.ts
│   │   │   └── registry.ts         注册 · 权限过滤 · 执行包装(日志/审批/超时)
│   │   ├── sandbox/                none · jail · docker
│   │   ├── memory/                 MemoryStore
│   │   ├── skills/                 SKILL.md 解析与渐进式披露
│   │   ├── plugins/                Plugin 加载器 · 钩子分发
│   │   ├── mcp/                    MCP client 管理
│   │   ├── ledger/                 usage 记账 · QuotaGuard
│   │   ├── log/                    LogSink · trace/span · 脱敏
│   │   ├── config/                 zod schema · 加载 · 热更新 · 校验
│   │   └── events.ts               EventBus
│   ├── db/
│   │   ├── schema/                 Drizzle 表定义（按 03 文档）
│   │   ├── migrations/             SQL 迁移（顺序编号）
│   │   └── repo/                   ArchiveRepo · ContextRepo · ... （强制 chat 作用域）
│   ├── telegram/
│   │   ├── bot.ts                  grammY 实例 · transformer(限流)
│   │   ├── middleware/             dedup · principals · media · archive · trigger
│   │   ├── output.ts               流式 editMessageText · 分片 · MarkdownV2 降级
│   │   ├── commands/               /new /undo /ctx /cancel /tasks /model ...
│   │   └── callbacks.ts            inline 按钮（取消 / 审批）
│   ├── server/
│   │   ├── app.ts                  Hono · session · CSRF
│   │   ├── routes/                 /api/*
│   │   └── sse.ts                  /api/events
│   ├── webui/                      Vite + Vue3 + PrimeVue（构建产物由 server 托管）
│   └── shared/                     类型 · 常量 · 错误类 · zod 公共 schema
├── config/
│   ├── config.yaml                 主配置（可被 WebUI 写回）
│   └── config.schema.json          由 zod 生成，供 WebUI 表单渲染
├── memory/
│   ├── ASSIST.md
│   ├── CHARACTER.md
│   ├── PUBMEMORY.md
│   └── private/<userId>/PRIMEMORY.md
├── skills/<name>/SKILL.md
├── plugins/<name>/plugin.ts
├── data/
│   ├── luoli.db  luoli.db-wal  luoli.db-shm
│   ├── files/<chatId>/<fileUniqueId>.<ext>
│   └── workspace/<chatId>/           工具的可写工作目录（沙箱挂载点）
├── logs/YYYY-MM-DD/{turn,model,tool,system}.jsonl
├── docs/                           本目录
└── docker/
    ├── Dockerfile                  应用镜像
    └── sandbox.Dockerfile          沙箱镜像（python + 常用 CLI，无网络）
```

---

## 5. 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 运行时 | Node.js 22 LTS + TypeScript 5.6 (ESM, `strict`) | `moduleResolution: bundler`，`verbatimModuleSyntax` |
| 包管理 | pnpm workspace | `packages/*` + `apps/*` |
| Agent | **AI SDK v7**（`ai`, `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google`, `@ai-sdk/openai-compatible`） | `ToolLoopAgent` / `createProviderRegistry` / `prepareStep` |
| Telegram | **grammY** + `@grammyjs/auto-retry` + `@grammyjs/transformer-throttler` | 长轮询默认，Webhook 可选 |
| DB | **better-sqlite3** + **Drizzle ORM** + FTS5(trigram) | WAL 模式；`drizzle-kit` 生成迁移 |
| HTTP | **Hono** + `@hono/node-server` | REST + SSE + 静态托管 |
| 前端 | Vite + Vue 3 + **PrimeVue 4 (Aura preset)** + Pinia + vue-router + PrimeIcons | 表格用 `DataTable`，编辑器用 `Textarea`/CodeMirror |
| 校验 | **zod** | 工具 `inputSchema`、配置 schema、API body |
| 日志 | 自建 `LogSink`（JSONL）+ `pino` 作控制台输出 | 见 [10](./10-logging-and-observability.md) |
| 测试 | **vitest** + `@grammyjs/...` 无需真实 API 的 stub + 内存 SQLite | 见 [13](./13-acceptance-criteria.md) |
| 沙箱 | Docker CLI（`docker run --rm`）/ 进程内 jail | 见 [05](./05-tools-and-permissions.md#5-沙箱) |

### 版本锁定原则

- AI SDK 主版本锁 `^7`；升级前必须跑完 [13](./13-acceptance-criteria.md) 的 AC-AGENT-* 与 AC-CTX-* 全集。
- 模型 id **不硬编码在代码里**，全部来自 `models` 表（[04](./04-agents-and-providers.md#5-provider-与模型注册表)）。代码只认别名 `main/high/low/vision/title/embed`。

---

## 6. 错误与降级策略

| 故障 | 行为 |
|---|---|
| Provider 429 / 5xx | 按 `models` 的 fallback 链换下一个模型；同链耗尽则指数退避重试 `provider.maxRetries`（默认 2）；仍失败 → 回复「模型暂时不可用」，turn 标 `failed`，**delta 不提交** |
| 模型返回超长（超 `maxOutput`） | 截断并追加「(输出被截断)」；日志记 `finishReason='length'` |
| 工具超时 | 返回结构化错误给模型（`{ok:false, error:'timeout'}`），让模型自行决策，不中断 turn |
| 工具抛异常 | 同上，错误信息脱敏后回灌；连续 `tools.maxConsecutiveErrors`（默认 3）次失败则强制停止 loop |
| Telegram 400 (Markdown 解析失败) | 自动降级 `parse_mode=undefined` 重发一次；仍失败则发纯文本摘要 + 完整内容作为 `.md` 文档 |
| Telegram 429 | `auto-retry` 按 `retry_after` 等待；流式编辑遇 429 直接跳过本次增量（不排队堆积） |
| DB 写失败 | turn 标 `failed`，向用户回复「内部错误(引用 turnId)」；日志 `level=error` |
| commit 时发现 base commit 已不存在（被 `/new` 重置） | 放弃 rebase，转为 `kind='turn'` 挂到当前 HEAD，并在 delta 前插入 `origin='note'` 的系统提示说明上下文已被重置 |
| subagent 失败 | 向父 agent 返回 `{ok:false, error}`；父 agent 决定重试或告知用户 |
| 配额超限（轮内触发） | 停止后续模型调用，把已生成内容作为最终回复发出，并追加额度提示 |
