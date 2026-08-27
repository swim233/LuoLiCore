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
│  Sandbox         none / docker 两种执行隔离                                │
│  MemoryStore     ASSIST/CHARACTER/PUBMEMORY/PRIMEMORY 读写与版本           │
├───────────────────────────────────────────────────────────────────────────┤
│ L1  状态层 State                                                          │
│  ContextEngine   ★ 快照 / commit / rebase / 裁剪 / 背景消息认领            │
│  Archive         Telegram 原始消息归档 + FTS 检索                          │
│  Ledger          usage 记账 · 配额计数                                     │
│  LogSink         结构化 JSONL + DB 索引                                    │
├───────────────────────────────────────────────────────────────────────────┤
│ L0  持久层 Persistence                                                    │
│  packages/db     原生 SQL · 迁移 · 强制 chat 作用域的 Repository          │
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
- **入口也必须是并发的**。update 由 `UpdatePoller`（`packages/telegram/src/polling.ts`）自己拉、自己派发，
  **不走 grammY 的 `bot.start()`** —— 那个逐条串行喂 update（源码里那句注释就是 `handle updates sequentially (!)`），
  于是上面那三个上限永远争用不到：第二个人得等第一个人的整轮（含模型流式输出与工具执行）跑完，
  `concurrency.coalesceSameUserMs` 也永远等不到后一条消息。在途 update 上限 = `global + queueMax`，
  到顶就不再 `getUpdates`（backpressure 留在 Telegram 侧，而不是在进程里堆一批待下载的媒体）。
  handler 的异常在派发处收口：grammY 只在自家轮询里把它路由到 `bot.catch`，漏接就是 unhandledRejection。
- **同一个 chat 的入口段串行**（`KeyedMutex`，`bot.ts`）：认领 update → 归档 → 挂媒体这一段里有真实的
  异步等待，而归档顺序就是上下文顺序（`claimBackground` 按 `messages.id` 排）。锁只盖入口段，轮次在锁外并行。
- **锁**：`KeyedMutex`（进程内 `Map<string, Promise>`）保护 `openTurn` / `commitTurn` 的临界区。临界区内**禁止任何网络/模型调用**。
- **多实例**（非第一版目标）：SQLite WAL 模式下多进程写会争锁。若未来横向扩展，需把 `KeyedMutex` 换成 DB 行级 advisory lock（`context_locks` 表 + `INSERT OR FAIL`）并迁移 Postgres。[14 §2 Q1](./14-open-questions.md) 已拍板：**现在不实现，但保留将来迁移的可能性** —— 约束见 §3.1。
- **优雅退出**：收到 `SIGTERM` 后停止拉取新 update，等待在途 turn 至 `shutdown.graceMs`（默认 30s），超时则取消并标记 `turns.state='cancelled'`，最后 flush 日志与 WAL checkpoint。

### 3.1 单实例纪律

**「单进程」现在由一把文件锁保证，而不再只是一句约定。** 启动时抢 `<db.path>.lock`
（`acquireInstanceLock`，`packages/db/src/instance-lock.ts`），抢不到且主人的 PID 还活着就拒绝启动；
主人已死则接手并说出原来那个 pid。**顺序是 open → migrate → 拿锁 → `recoverAfterCrash`** ——
反过来的话，被拒绝启动的那个实例已经先把在位实例的在途状态清掉了。

**接手死锁靠的是「同一代只有一个进程能独占创建」，不是写完回读。** 锁文件里记着第几代
（`gen`），抢占方独占创建 `<db.path>.lock.<gen+1>`（`flag:'wx'`）—— 建成的那个才装锁文件，
输的那个看见 claim 里活着的 pid 照常被拒。写完回读定不了胜负：write 与 read 是两次 syscall，
两个进程各自「写—读」都能读到自己的 pid，于是**两个实例一起进 `recoverAfterCrash`**，
恰好是这把锁要挡的那件事（守卫下的守卫失效，触发条件是「上一次崩过 + 两个进程同时起」）。
抢占方崩在「建了 claim 还没装锁文件」那一刻也不锁死：下一个进程看到那一代属于死进程，往下一代找。

之前没有这道闸的代价实测过：用同一个库起第二个实例，`recoverAfterCrash` 无条件把在位实例
**仍在执行**的轮次改成 `state='failed', error='process_restarted'`，顺带释放已认领的消息、
清零在途预留额度，之后 A 才因为 Telegram 409 关停 —— **赢的是后来者**。本机误跑一次
`pnpm dev` 就足够（`docs/reviews/28 · L-OPS-01`）。

锁是**按库**而不是按机器：两个各自有库的实例本来就不该互相挡。它不改变下面这两条 ——
横向扩展的路仍然是把 `KeyedMutex` 换成 DB 行级 advisory lock，那时这把锁要跟着换成
「同一个库允许 N 个实例」的租约。

[14 §2 Q1](./14-open-questions.md) 的决策有两半，第二半容易被忘掉：

1. **不删**为多实例预留的抽象。主要就是 Repository 层那些 key 参数与 `KeyedMutex` 的键 —— 它们同时
   是 [14](./14-open-questions.md) T7（「隔离靠代码纪律，不是物理边界」）的主要缓解手段。为了「反正
   永远单机」把它们拆平，等于用安全面换观感。
2. **新代码不得引入新的进程内状态假设**。

第 2 条没有断言能挡住 —— 没有哪条 CI 检查看得出「这个 Map 只在本进程可见」。所以它是一份复审清单，
改到下面任何一类时逐条对：

| 形态 | 为什么是问题 | 该怎么写 |
|---|---|---|
| 新增进程内缓存（`Map` / `Set` / 模块级变量）且**它是唯一真相** | 第二个实例看不到，两边各自算各自的 | 真相落 DB，进程内那份只当缓存，且能从 DB 重建 |
| 新增互斥/限流，锁只在进程内 | 两个实例各放行一次，配额与并发闸同时失效 | 用 `KeyedMutex` 现成那套（将来整体换成 advisory lock），别再造一个 |
| 新增只在本进程可见的广播（EventEmitter / SSE 直发） | 另一个实例上的 WebUI 收不到 | 走现有的 `log.publish` 一条路，将来换成 DB 轮询或外部总线时只改一处 |
| 新增「启动时扫一遍、之后只信内存」的表 | 另一个实例写的行永远看不见 | 每次读 DB，或者接受陈旧并**写明**可陈旧多久 |

**不是问题的**：纯函数的记忆化、单次请求内的缓存、进程本地的指标计数（本来就是 per-instance 语义）。

---

## 4. 目录结构

```
LuoLiCore/
├── apps/
│   └── bot/src/main.ts             入口：装配所有模块、拉起 bot + http（生命周期与优雅关停）
├── packages/
│   ├── core/src/                   绝大部分逻辑
│   │   ├── context/engine.ts       ★ ContextEngine：openTurn / commitTurn / materialize / prune
│   │   ├── turn/                   concurrency.ts · keyed-mutex.ts · registry.ts
│   │   ├── agent/                  manager · runtime · subagent · harness · ask-arbiter ·
│   │   │                           definitions · fallback-model · step-observers · result-refs
│   │   ├── acp/                    ACP 客户端（规格见 docs/05 §3.5）：schema · errors · process ·
│   │   │                           manager · session · fs · terminals · permission · runs
│   │   │                           —— 切法见树下第二条注
│   │   ├── prompt/                 assembler.ts · documents.ts
│   │   ├── provider/               catalog · model-catalog · store（密钥加密）· alias-settings · health
│   │   ├── tools/                  registry.ts（注册 · 权限过滤 · 执行包装）· policy.ts（审批档位）
│   │   │                           builtins.ts（34 个内建工具）· files.ts · web.ts · schedule.ts
│   │   │                           jail.ts（PathJail）· cite.ts · containers.ts（容器管理工具）
│   │   │                           authoring.ts · custom.ts（自我扩展 M12）
│   │   │                           catalog-meta.ts（目录折叠与 `search_tools`）
│   │   ├── sandbox/                index.ts（none · docker）· containers.ts（持久容器）·
│   │   │                           exec-stream.ts（`collectProcess` 的字节上界与就地 kill）
│   │   ├── approval/rules.ts       审批规则匹配（`approvals.ts` 是 broker，在 src 根）
│   │   ├── interaction/prompts.ts  阻塞式人机通道（PendingPrompts）
│   │   ├── memory/store.ts         MemoryStore
│   │   ├── media/                  normalize.ts（图片归一）· web-assets.ts（网页取回的资产）
│   │   ├── skills/                 loader.ts（SKILL.md 解析与渐进式披露）· package.ts（装 skill 包）
│   │   ├── plugins/manager.ts      Plugin 加载器 · 钩子分发
│   │   ├── mcp/                    manager.ts · schema.ts · oauth.ts · persist.ts
│   │   ├── schedule/               create.ts（建任务的唯一校验）· runner.ts
│   │   ├── ledger/                 usage.ts 记账 · quota.ts QuotaGuard · repair.ts（一次性重算）
│   │   ├── log/sink.ts             LogSink（JSONL）· trace/span · 脱敏
│   │   ├── net/outbound.ts         全仓库唯一一条出网路径（SSRF 防护）
│   │   ├── config/                 schema.ts（zod）· index.ts（三层合并）· descriptions ·
│   │   │                           wakeword · redact.ts（脱敏口径，只有这一份）
│   │   └── *.ts                    access · approvals · alerts · events · maintenance ·
│   │                               scheduler · secrets
│   ├── db/
│   │   ├── migrations/             手写 SQL，`NNNN_*.sql` 按文件名顺序执行（**提交后不可修改**）
│   │   └── src/                    database.ts（连接 · PRAGMA · 迁移执行器）
│   │                               archive · context · config · principals · schedule · operations
│   │                               custom-tools · mcp-auth · sandbox
│   │                               —— 强制 chat 作用域的 Repository，全部手写 SQL
│   │                               instance-lock.ts —— 不是仓储，是进程级互斥（见 §3.1）
│   ├── telegram/src/               bot.ts（grammY · transformer 限流 · 入口按 chat 串行）
│   │                               polling.ts（并发有界的 long polling 驱动）
│   │                               trigger.ts · media.ts · reply.ts · tools.ts
│   │                               prompts.ts（人机通道的 Telegram 侧）· acp-card.ts（ACP 进度卡片）
│   │                               output.ts · stream-output.ts（流式 · 分片 · MarkdownV2 降级）
│   ├── server/src/                 app.ts（Hono · session · CSRF · 全部 `/api` 路由，当前 121 条）
│   │                               events.ts（SSE `/api/events`）
│   ├── webui/src/                  Vite + Vue 3（构建产物由 server 托管）
│   │   ├── views/                  ConsoleView.vue · ExtensionsPage.vue · TasksPage.vue · LoginView.vue
│   │   ├── components/             extensions/ · tasks/（从 ConsoleView 抽出去的纯呈现子组件）
│   │   ├── ui/                     自建组件原语（无 UI 框架）+ SchemaForm 自动生成配置表单
│   │   ├── api/client.ts           router/index.ts   styles.css
│   ├── plugin-sdk/src/index.ts     Plugin 作者用的类型入口
│   └── shared/src/                 errors.ts · index.ts（类型 · 常量 · 公共 zod schema）
├── config/
│   ├── config.yaml                 主配置（可被 WebUI 写回）
│   └── config.schema.json          由 zod 生成（`pnpm config:schema`），供 WebUI 表单渲染
├── memory/
│   ├── ASSIST.md  CHARACTER.md  PUBMEMORY.md
│   └── private/<userId>/PRIMEMORY.md
├── skills/<name>/SKILL.md
├── plugins/<name>/plugin.ts
├── agents/<name>.md                子 agent 的只读定义（D22）
├── data/
│   ├── luoli.db  luoli.db-wal  luoli.db-shm
│   ├── files/<chatId>/<fileUniqueId>.<ext>
│   └── workspace/<chatId>/         工具的可写工作目录（沙箱挂载点）
├── logs/YYYY-MM-DD/{turn,model,tool,system}.jsonl
├── docs/                           本目录（`reviews/` 是冻结的历史复审）
└── docker/
    ├── Dockerfile                  应用镜像
    └── sandbox.Dockerfile          沙箱镜像（python + 常用 CLI，无网络）
```

> 这棵树画的是**现状**，不是目标结构。两处正在改的：`server/src/app.ts` 一个文件装着全部 `/api`
> 路由与大量裸 SQL（`docs/00 §2.1` 的 `D-01` / `D-04`），`webui/src/views/ConsoleView.vue`
> 仍是全仓最长的单文件（`D-02`；扩展页与任务页已经抽出去了，剩下的部分还没拆成页面组件）。
> **行数与条数别在这里写死** —— 现值记在 `docs/00 §2.1` 那两行的实测列里，两处各写一份必然漂。

> `acp/` 那九个文件的切法有讲究，不是按「一个类一个文件」随手分的：
> - **`schema.ts` 不 import 任何 SDK 运行时**（只有 zod）。`config/schema.ts` 要 import 它，而后者又被
>   `scripts/config-schema.ts` 与 WebUI 吃进去 —— 那条链上多拖一个 SDK 运行时，`pnpm config:schema`
>   与前端构建就都得为一台可能根本没启用的外部 agent 付账。
> - **`errors.ts` 一处定义、三处共用**（manager / session / 工具壳）。二十多个错误码连着面向模型的
>   hint 文案，散成三份会慢慢漂，而 [05 §3.5](./05-tools-and-permissions.md) 是它们唯一的文档来源
>   —— 文案有三份的时候「先改文档」就再也验不动了。
> - **`process.ts` 同样不 import SDK**：spawn、argv、env 策略、Node↔Web stream 桥、stderr 环形缓冲与
>   半行缓冲的上界、`stdin.end → SIGTERM → 5s → SIGKILL` 这条梯子都是纯逻辑，量一次 argv 的用例不该
>   为此把整个 SDK 拖进来。
> - 反向能力那三块各占一个文件（`fs.ts` / `terminals.ts` / `permission.ts`），因为它们当初就是三个
>   并行的工作面 —— 接口契约先钉住、三块各改各的文件、谁也不动对方的。

---

## 5. 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 运行时 | Node.js 22 LTS + TypeScript 5.6 (ESM, `strict`) | `moduleResolution: bundler`，`verbatimModuleSyntax` |
| 包管理 | pnpm workspace | `packages/*` + `apps/*` |
| Agent | **AI SDK v7**（`ai`, `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google`, `@ai-sdk/openai-compatible`） | `ToolLoopAgent` / `createProviderRegistry` / `prepareStep` |
| Telegram | **grammY** + `@grammyjs/auto-retry` + `@grammyjs/transformer-throttler` | 长轮询默认，Webhook 可选 |
| DB | **better-sqlite3** + **原生 SQL**（无 ORM 查询层）+ FTS5(trigram) | WAL 模式；迁移是手写 `packages/db/migrations/NNNN_*.sql`，由 `migrateDatabase()` 按文件名顺序在事务里执行。**没有 drizzle-kit** |
| HTTP | **Hono** + `@hono/node-server` | REST + SSE + 静态托管 |
| 前端 | Vite + Vue 3 + Pinia + vue-router + PrimeIcons（**无 UI 组件框架**，`src/ui/` 自建原语） | 视觉基准是总览页，全站共用 `styles.css` 的设计变量；见 [09 §6](./09-webui.md#6-前端结构) |
| 校验 | **zod** | 工具 `inputSchema`、配置 schema、API body |
| 日志 | 自建 `LogSink`（JSONL）+ `pino` 作控制台输出 | 见 [10](./10-logging-and-observability.md) |
| 测试 | **vitest** + `@grammyjs/...` 无需真实 API 的 stub + 内存 SQLite | 见 [13](./13-acceptance-criteria.md) |
| 沙箱 | Docker CLI（`docker run --rm`） | 见 [05](./05-tools-and-permissions.md#5-沙箱) |

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
