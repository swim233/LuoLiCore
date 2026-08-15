# 17 · 复审报告（修复后第二轮）

> 前置文档：[15-gap-review.md](./15-gap-review.md)（第一轮 13 P0 / 39 P1 / 19 P2）、[16-remediation-plan.md](./16-remediation-plan.md)（R0–R6 修复批次）。
> 本轮范围：全量重读 `packages/` + `apps/` 共 5627 行 TypeScript，逐条复验第一轮 13 项 P0，并做一次独立的新问题排查。
> 基线：`tsc --noEmit` 零错误；`vitest run` **52 passed / 35 files**（第一轮为 20 / 11）。

---

## 0. 结论速览

**第一轮 13 项 P0 已修复 12 项，1 项部分修复。** 上下文引擎、审批链路、沙箱 fail-closed、Telegram 准入网关这几处最危险的缺陷都是**按正确思路**改的，不是打补丁绕过去的——`turnStartOrdinals` 用 `MIN(ordinal) GROUP BY turn_id` 从根上解决了裁剪边界，`isPrivate` 被真正贯穿到 `OpenTurnRequest`/`RuntimeTurnContext` 而不是在调用点再推断一次。这一轮的代码质量明显高于上一轮。

但复审发现 **4 项新 P0、13 项 P1、13 项 P2**，其中 3 项 P0 已用临时用例实测确认。最严重的一项（`N-CTX-01`）是**修复本身引入的**：新增的硬截断步骤在特定输入下永不终止，会把该会话的 `commitTurn` 互斥锁永久占住。

| 域 | 新 P0 | 新 P1 | 新 P2 | 第一轮遗留 | 评价 |
|---|---|---|---|---|---|
| 上下文引擎 | 1 | 3 | 1 | 0 | 主结构正确，硬截断有致命回归 |
| 记忆与隐私 | 1 | 1 | 0 | 1（部分） | owner 豁免打穿了群聊硬禁止 |
| Telegram 适配 | 1 | 1 | 3 | 0 | 主链路完整，编辑消息被静默吞掉 |
| 扩展（Plugin/MCP） | 1 | 0 | 2 | 0 | 既不可达又无管控，两头落空 |
| 配置与运维 | 0 | 3 | 3 | 0 | 热更新形同虚设 |
| WebUI / API | 0 | 2 | 3 | 部分 | 端点补齐到 ~60，写入路径多为空转 |
| 工具与安全 | 0 | 3 | 1 | 0 | 注册表管控扎实，边界仍有洞 |
| **合计** | **4** | **13** | **13** | — | |

**当前是否具备验收条件：否。** 但距离可验收的差距已从「架构级」缩小到「缺陷级」——按 §5 的 F0/F1 两批（约 3–5 人日）修完，即可进入 [13-acceptance-criteria.md](./13-acceptance-criteria.md) 的正式验收。

### 0.1 整改完成状态（2026-08-15）

F0–F3 已按本报告执行。主要结果：硬截断单调收敛；群聊私有记忆硬隔离；编辑消息安全归档；Plugin/MCP 统一进入 `ToolRegistry`；运行时配置按 turn 读取；工具消息、媒体引用、claim 水位、quota 预留与 turn 运行态均按事务/生命周期收口；WebUI 已接提示词保存与 diff 回滚、Provider/模型/别名写入、上下文历史与 prune/rebase 标记、commit 快照与 `kind='manual'` 回滚。

验证基线以当前 CI/本地命令结果为准，不再沿用本报告最初的 `52 passed / 35 files` 快照。本报告 §2–§4 保留为问题来源和修复理由；其中“当前是否具备验收条件：否”是整改前结论，不代表当前状态。

---

## 1. 第一轮 P0 复验结果

| 编号 | 问题 | 状态 | 复验依据 |
|---|---|---|---|
| G-CTX-01 | 裁剪窗口落在 turn 中间，产生孤儿 `tool_result` | ✅ 已修复 | 新增 `ContextRepository.turnStartOrdinals()`（`context.ts:81`）用 `MIN(ordinal) … GROUP BY turn_id ORDER BY ordinal`；`engine.ts:191` 改为按下标推进 `starts[index]`。`minKeepTurns` 的 zod 约束是 `.positive()`（≥1），因此 `starts[index]!` 不会越界 |
| G-CTX-02 | 私聊背景消息被加群聊发言人前缀 | ✅ 已修复 | `isPrivate` 进入 `OpenTurnRequest`（`engine.ts:14`）与 `RuntimeTurnContext`（`shared/index.ts:56`），三处 `chatId === initiatorUserId` 推断已全部删除；`bot.ts:242` 传入 `chat.type === 'private'` |
| G-MEM-01 | 群聊可读取发起人的 PRIMEMORY | ⚠️ **部分修复** | `store.ts:67` 新增 `isPrivate` 形参、`builtins.ts:51` 按 `isPrivate` 收窄 scope 枚举——但 `store.ts:69` 的守卫写成 `if (!isPrivate && actorRole !== 'owner')`，owner 在群聊里仍可读。见 `N-MEM-01` |
| G-LOG-01 | `redact()` 抹掉 `log_events.key` | ✅ 已修复 | `secrets.ts:37` 新增 `STRUCTURAL_FIELDS` 白名单，`SENSITIVE_FIELD` 收紧为带边界的 `api_key|apikey|secret|token|password|passwd|credential` |
| G-AGENT-01 | `spawn_agent` 是伪造成功的桩 | ✅ 已修复 | `builtins.ts:88` 调用真实 `runSubAgent`；`subagent.ts` 用独立 `ToolLoopAgent` + `definition.tools` 白名单 + 独立记账 |
| G-AGENT-02 | 上下文消息被压平成纯文本 user 消息 | ✅ 已修复 | `runtime.ts:127` 的 `contextMessages()` 保留 `role` 与 `parts` |
| G-TOOL-01 | `approval: 'conditional'` 从不触发 | ✅ 已修复 | `registry.ts:86` 三分支派发；新增 `approval/rules.ts`（minimatch + 正则 + `target_exists`）；`main.ts:68` 注入 `config.approval.rules` |
| G-APV-01 | `approval.enabled=false` 语义反转 | ✅ 已修复 | `approvals.ts:13` 改为 `if (!enabled) return true`；`main.ts:67` 补了显式告警日志 |
| G-SBX-01 | 沙箱未在注册期 fail-closed | ✅ 已修复 | `builtins.ts:36/39` 用 `available: (role, ctx) => sandbox.plan(role, ctx.workspace).allowed`，`mode:'none'` 时 `bash`/`python` 直接不出现在工具表 |
| G-QUOTA-01 | 配额只在轮末结算一次 | ✅ 已修复 | `runtime.ts:247` 每个 step 结束即 `quota.commit`；`commit()` 用 `Math.min(amount, actual)` 递减预留，`finally` 里的 `release()` 不会二次退款。预留额估算仍粗糙，见 `N-QUOTA-01` |
| G-TG-01 | 命令处理器绕过准入网关 | ✅ 已修复 | `bot.ts:57` 的 `ingress` Map + `requireRole()`；`tests/access.commands.test.ts` 已覆盖「blocked 用户 /new 不改变上下文」 |
| G-TG-02 | `abortSignal` 立即丢弃，取消不可能 | ✅ 已修复 | 新增 `TurnRegistry`（含超时 `setTimeout` + `cancel` 鉴权 + `drain`）；`/cancel` 与 `callback_query` 双通道 |
| G-TG-03/04/05 | 流式 / 多模态 / 并发闸门缺失 | ✅ 已修复 | `TelegramOutput` 已接线（`bot.ts:260`）；`media.ts` 实现下载/缩放/PDF/DOCX 抽取；`TurnConcurrency` 实现 perKey + global + 队列上限 |

另有第一轮记录的**文档勘误**已被代码追平：`mcp/manager.ts` 改用 `@modelcontextprotocol/sdk` 的 `Client` + `StdioClientTransport`/`StreamableHTTPClientTransport`，不再依赖 `ai` 包并不存在的 `experimental_createMCPClient`。**[07-skills-plugins-mcp.md §4.2](./07-skills-plugins-mcp.md) 的示例代码需要按实现改写**（见 §4）。

---

## 2. 新增 P0（阻断验收）

### N-CTX-01 ★实测 · 硬截断死循环，会永久锁死整个会话

**位置**：`packages/db/src/context.ts:110-127`（`hardTruncateLargest`）、`packages/core/src/context/engine.ts:202`（调用点）

```ts
// context.ts:114 —— 排序用的是不可变的 tokens 列
const row = this.db.prepare(`SELECT ordinal,parts_json AS parts,meta_json AS meta,tokens FROM context_messages
  WHERE key=? AND ordinal BETWEEN ? AND ? AND prune_applied=0
  ORDER BY tokens DESC,ordinal LIMIT 1`).get(...);
const targetTokens = Math.max(1, row.tokens - excess);   // ← 基准是原始 tokens，不是当前生效值
meta.truncated = { chars, tokens: targetTokens, ... };   // ← 只改 meta，tokens 列永不变
```

```ts
// engine.ts:202 —— 无迭代上限
while (over() && repo.hardTruncateLargest(windowStart, commit.headOrdinal, config.context.limit.tokens)) hardTruncated = true;
```

**失效链**：`tokens` 列是不可变的，`ORDER BY tokens DESC, ordinal` 每次都选中**同一行**；而 `targetTokens` 用 `row.tokens - excess` 计算，`excess` 随上一次截断变小 ⇒ `targetTokens` 反而**变大**。于是同一条消息的生效 token 在两个值之间来回震荡，`over()` 永远为真，`hardTruncateLargest()` 永远返回 `true`。

**触发条件**：窗口收缩到 `minKeepTurns` 后仍超限，且窗口内**存在两条 `tokens` 相同的大消息**（把最大的一条压到 1 token 也不足以降到限额以下）。例如用户连发两段长文，或一条长文 + 一份长文档抽取结果。

**实测**（临时用例，已删除）：limit=4000，单个 turn 内两条 `tokens: 12004` 的消息 —

```
VERIFY-1 calls = 201  error = NON_TERMINATING: hardTruncateLargest called 201 times
```

（用例在第 200 次调用处强制抛错才终止；不设上限即为死循环。）

**影响**：`prune()` 在 `commitTurn()` 内、且在 `KeyedMutex.run(turn.key, …)` 的临界区里执行。一旦命中：

1. 该 Node 进程的一个事件循环 tick 被同步 SQL 死循环占满 → **整个 bot 停止响应所有会话**（不只是当前会话）；
2. 即使能中断，`KeyedMutex` 的这把 key 锁永不释放 → 该会话此后所有轮次全部挂起；
3. `turnTimeoutMs` 救不了——`abortSignal` 只影响模型调用，管不到已进入 `commitTurn` 的同步循环。

这是**修复 G-CTX-01 时新引入的回归**：第一轮报告只指出「缺少步骤 3 硬截断」，实现补上了步骤 3 但没有保证单调收敛。

**修复**：让每次截断严格递减，并让「无可再压缩者」成为终止条件。

```ts
// packages/db/src/context.ts
hardTruncateLargest(from: number, to: number, targetTotal: number): boolean {
  const stats = this.effectiveStats(from, to);
  const excess = stats.tokens - targetTotal;
  if (excess <= 0) return false;
  // 按「当前生效 token」排序，并排除已压到底的行 —— 两者共同保证终止
  const row = this.db.prepare(`SELECT ordinal,parts_json AS parts,meta_json AS meta,tokens,
      COALESCE(json_extract(meta_json,'$.truncated.tokens'),tokens) AS effective
    FROM context_messages
    WHERE key=? AND ordinal BETWEEN ? AND ? AND prune_applied=0
      AND COALESCE(json_extract(meta_json,'$.truncated.tokens'),tokens) > 1
    ORDER BY effective DESC,ordinal LIMIT 1`).get(this.key, from, to) as
    { ordinal: number; parts: string; meta: string | null; tokens: number; effective: number } | undefined;
  if (!row) return false;                          // 全部压到底仍超限 → 交给上层，不再空转
  const original = JSON.parse(row.parts) as unknown[];
  const textChars = original.reduce<number>((sum, part) =>
    sum + (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string' ? [...part.text].length : 0), 0);
  if (!textChars) return false;
  const targetTokens = Math.max(1, row.effective - excess);
  if (targetTokens >= row.effective) return false; // 不允许回涨：单调递减是终止的充要条件
  // chars 仍以原始 parts 为基准，因为 truncatePartStrings 作用于原始 parts
  const chars = Math.max(1, Math.floor(textChars * targetTokens / Math.max(1, row.tokens)));
  const meta = row.meta ? JSON.parse(row.meta) as Record<string, unknown> : {};
  meta.truncated = { chars, tokens: targetTokens, originalTokens: row.tokens };
  this.db.prepare('UPDATE context_messages SET meta_json=? WHERE key=? AND ordinal=?')
    .run(JSON.stringify(meta), this.key, row.ordinal);
  return true;
}
```

调用点再加一道保险（防御未来的类似回归）：

```ts
// packages/core/src/context/engine.ts:201
let hardTruncated = false;
for (let guard = 0; guard <= messages.length && over(); guard += 1) {
  if (!repo.hardTruncateLargest(windowStart, commit.headOrdinal, config.context.limit.tokens)) break;
  hardTruncated = true;
}
if (over()) this.log?.event({ level: 'error', kind: 'ctx.hardcap',
  summary: '硬截断后仍超限，本轮将依赖 prepareStep 的 pruneMessages 兜底', key: commit.key });
```

**必须补的回归用例**：同一 turn 内放置两条 `tokens` 完全相同的超大消息，断言 `commitTurn` 在 1s 内返回且 `materialize().tokens <= limit.tokens`。现有 `tests/context.prune.test.ts` 的第二个用例只放了**一条**大消息，恰好一次就收敛，所以测不出来。

---

### N-MEM-01 ★实测 · owner 在群聊里仍能读取私有记忆

**位置**：`packages/core/src/memory/store.ts:69`

```ts
if (scope === 'primemory') {
  if (!isPrivate && actorRole !== 'owner') throw new Error('private_memory_forbidden');
  //                ^^^^^^^^^^^^^^^^^^^^^^ owner 豁免
```

**实测**（临时用例，已删除）：

```
VERIFY-2 group read as owner = "# 私有记忆\n\n## s\n- 我的体检报告显示…  <!-- src: chat u1 by u1 … -->\n"
```

**为什么这不是可接受的豁免**：设计目标里「群聊对话不能访问 PRIMEMORY.md」是**按场所**而非按人设的硬禁止（[06 §注入矩阵](./06-prompt-and-memory.md)、决策 D12）。owner 在群里 @ 机器人，模型读到 owner 的私有记忆并据此组织回复——这段内容会直接出现在**群聊所有成员**眼前。owner 的身份并不意味着群里其他人有权看他的私有记忆；恰恰相反，owner 最可能在私有记忆里存敏感信息。

同一 scope 判断在 `builtins.ts:51` 已经做对了（`memoryScopeSchema(context.turn.isPrivate)` 在群聊里把枚举收窄成只有 `pubmemory`），所以正常的 `memory_read` 工具路径进不来。但 `MemoryStore.read` 是公共方法，`/memory` 命令（`bot.ts:158`）、`PUT /api/prompts/:id`（`app.ts:239`）、`flush()`（`store.ts:108`）都直接调它——**深度防御在这一层被自己打了个洞**。

**修复**：场所判断不设角色豁免；owner 的跨用户读取审计保留。

```ts
if (scope === 'primemory') {
  if (!isPrivate) throw new Error('private_memory_forbidden');   // 群聊硬禁止，无角色豁免
  if (subject !== actorUserId && actorRole !== 'owner') throw new Error('private_memory_forbidden');
  if (subject !== actorUserId) this.log?.event({ level: 'warn', kind: 'memory.owner_read_private',
    summary: 'Owner read another user private memory', data: { targetUserId: subject } });
}
```

内部调用（`flush`、`forgetPrivate`）不应借道公共 `read()` 绕过守卫，改为私有方法：

```ts
private readRaw(scope: MemoryDocument['scope'], subject: string | null): MemoryDocument { /* 无鉴权，仅供内部落盘 */ }
```

**回归用例**：`tests/memory.isolation.test.ts` 补一条 `read('primemory', 'u1', 'owner', 'u1', false)` 必须抛 `private_memory_forbidden`。现有用例只覆盖了非 owner 角色，因此绿灯是假的。

---

### N-TG-01 ★实测 · 编辑消息被静默丢弃（`claimUpdate` 双重认领）

**位置**：`packages/telegram/src/bot.ts:59` 与 `bot.ts:175`

```ts
bot.use(async (ctx, next) => {
  if (!dependencies.operations.claimUpdate(ctx.update.update_id)) return;   // ← 第一次认领：成功
  ...
  if (!from || !chat || !message) { await next(); return; }                 // edited_message 走这里
```

```ts
bot.on('edited_message', async (ctx) => {
  if (dependencies.config.trigger.ignoreEditedAsTrigger && !dependencies.operations.claimUpdate(ctx.update.update_id)) return;
  //                                                       ^^^^ 第二次认领：必然失败 → 直接 return
```

`claimUpdate` 是 `INSERT OR IGNORE INTO processed_updates`，同一 `update_id` 只可能成功一次。而 `ignoreEditedAsTrigger` 的**默认值是 `true`**（`schema.ts:33`），所以默认配置下 `edited_message` 处理器**永远在第一行返回**。

**实测**（临时用例，已删除）：先发 `原文`，再编辑成 `改后的文字` —

```
VERIFY-4 archived rows = [{"id":1,"text":"原文"}]
```

**影响**：
- [08 §消息编辑](./08-telegram-adapter.md) 要求编辑产生 `revision+1` 的新归档行，`AC-TG` 相关用例全部不达标；
- `messages.revision` 列、`bot.ts:178` 的 `MAX(revision)+1` 查询、`telegram.notifyEdits` 配置项全部是死代码；
- 用户「打错字改一下」的内容永远进不了归档与检索。

顺带两个同处的问题：该处理器**不做准入判断**（blocked 用户的编辑也会被归档，绕过 `access.archiveBlocked`），且 `ignoreEditedAsTrigger` 被误用成了「是否处理」而非「是否作为触发源」。

**修复**：认领只做一次，语义各归各位。

```ts
bot.on('edited_message', async (ctx) => {
  const message = ctx.editedMessage;
  const from = message.from;
  const chatId = String(message.chat.id);
  if (!from) return;
  // 准入：与主链路一致
  const userRole = dependencies.principals.roleOf('user', String(from.id)) ?? dependencies.config.access.defaultUserRole;
  const storedChatRole = dependencies.principals.roleOf('chat', chatId);
  const effectiveRole = resolveEffectiveRole({ userRole, ...(storedChatRole ? { chatRole: storedChatRole } : {}),
    isPrivate: message.chat.type === 'private', defaultChatRole: dependencies.config.access.defaultChatRole });
  if (effectiveRole === 'blocked' && !dependencies.config.access.archiveBlocked) return;
  const row = dependencies.db.prepare('SELECT COALESCE(MAX(revision),-1)+1 AS revision FROM messages WHERE chat_id=? AND tg_message_id=?')
    .get(chatId, message.message_id) as { revision: number };
  dependencies.archive.scope(chatId, message.message_thread_id ?? null).append({ /* …原样… */ 
    // ignoreEditedAsTrigger 只决定 triggered，不决定是否归档
    triggered: dependencies.config.trigger.ignoreEditedAsTrigger ? false : /* 重新匹配触发 */ false,
    revision: row.revision });
});
```

**回归用例**：`tests/` 新增 —— 发消息 + 编辑，断言 `archive.recent()` 含两行且 `revision` 为 `0,1`。

---

### N-EXT-01 · Plugin / MCP 工具既不可达，又不受管控

**位置**：`packages/core/src/agent/runtime.ts:195-202`（注册）、`runtime.ts:215`（`activeTools`）、`runtime.ts:221`（`prepareStep`）

```ts
for (const registered of dependencies.tools.active(turn.effectiveRole, toolContext)) { toolSet[registered.name] = tool({…}); }
for (const entry of dependencies.plugins?.toolEntries() ?? []) { toolSet[entry.name] = tool({ …, execute: candidate.execute }); }
for (const entry of dependencies.mcp?.toolEntries() ?? []) { toolSet[entry.name] = tool({ …, execute: entry.call }); }
const agent = new ToolLoopAgent({ …, tools: toolSet, activeTools: activeNames, … });
//                                                    ^^^^^^^^^^^ 只含 ToolRegistry 的工具
```

`activeNames` 来自 `ToolRegistry.activeNames()`，而 plugin/MCP 工具从未注册进 `ToolRegistry`。`ai@5.0.236` 的实现（`dist/index.mjs:1217`）会按 `activeTools` 过滤 `tools` 后才发给 provider：

```js
const filteredTools = activeTools != null ? Object.entries(tools).filter(([name]) => activeTools.includes(name)) : ...
```

`prepareStep` 返回的 `activeTools: activeForStep` 同样只来自注册表，逐 step 覆盖，所以**没有任何一步能让模型看见 plugin/MCP 工具**。

**双重损失**——这是一个「两头都不占」的结构：

1. **功能上**：整个 MCP 生态与插件工具体系是死的。`McpManager` 会连接服务器、拉取工具清单、写 `mcp_servers` 表、被 `mcp-health` cron 定期 reconcile——全部白做。[07 §MCP](./07-skills-plugins-mcp.md) 的验收项无一可过。
2. **安全上**：一旦有人「顺手」把 `activeTools` 改成 `Object.keys(toolSet)` 让它们可达，这些工具会**完全绕过** `ToolRegistry.execute` 的 11 步包装——没有 `minRole` 校验（`mcp_servers.min_role` 和 `mcp.defaultMinRole` 存了但没人读）、没有审批、没有 `maxCallsPerTurn`、没有 `maxConsecutiveErrors` 熔断、没有 `#normalizeOutput` 的输出截断、没有 `untrusted()` 包裹、没有 `tool.call` span。即 limited 用户可直接调用任意 MCP 服务器的任意工具。

**修复方向（推荐）**：不要去改 `activeTools`，而是把外部工具**注册进 `ToolRegistry`**，让它们自动获得全部管控并自然出现在 `activeNames` 里。

```ts
// packages/core/src/tools/registry.ts —— 支持动态来源的注册与替换
registerExternal(input: { name: string; description: string; inputSchema: z.ZodType<unknown>;
  minRole: Role; approval: ApprovalPolicy; scope: ToolScope; source: 'plugin' | 'mcp';
  execute: (input: unknown) => Promise<unknown> }): void {
  this.#tools.set(input.name, {
    name: input.name, description: input.description, inputSchema: input.inputSchema,
    policy: { minRole: input.minRole, approval: input.approval, scope: input.scope, source: input.source as never },
    sourcePriority: input.source === 'plugin' ? 60 : 40,   // 低于 builtin(100)，冲突时内置优先
    untrustedOutput: true,                                  // 外部来源一律按不可信内容处理
    execute: async (raw) => await input.execute(raw) as object,
  });
}
unregisterBySource(source: 'plugin' | 'mcp'): void {
  for (const [name, tool] of this.#tools) if (tool.policy.source === source) this.#tools.delete(name);
}
```

`McpManager.reconcile()` / `PluginManager.reconcile()` 完成后调用 `unregisterBySource` + `registerExternal`，`minRole` 取 `server.minRole ?? config.mcp.defaultMinRole`（插件取 `plugins` 表的配置或 `trusted`），`approval` 默认 `conditional` 以便 `approval.rules` 能命中。MCP 的 JSON Schema 需要转成 zod（用 `json-schema-to-zod`，或先用 `z.record(z.unknown())` 兜底并在 span 里记录原始 schema）。

同时把 `runtime.ts` 的两个外部工具循环删掉——注册表已经统一出口。

---

## 3. 新增 P1

| 编号 | 位置 | 问题 | 影响 | 修复要点 |
|---|---|---|---|---|
| **N-CTX-02** ★实测 | `context/engine.ts:52` | 多模态 token 完全不计入估算：`tokens: estimateTextTokens(text)` 只算文本，`mediaParts` 的 base64 不计。实测一张图 `serializedChars = 400301` → `estimatedTokens = 9` | 上下文限额、`tokenRatio` 校准、配额预留全部失真；一张图就能把真实输入撑到几十万 token 而裁剪逻辑毫无察觉 | `tokens` 改为 `estimateTextTokens(text) + mediaParts.reduce(…)`，图片按 `(w*h)/750` 或固定 `1500` 计；非文本 part 至少按 `JSON.stringify(part).length * 0.1` 计 |
| **N-CTX-03** | `bot.ts:266`（唯一的 assistant `appendDelta`） | `tool_call` / `tool_result` 消息**从不写入** `context_messages`。全库仅 `shared/index.ts:29` 的类型定义提到这两个 origin | ① [02 §5.3](./02-context-engine.md) 的分级裁剪（level 2 = 工具参数、level 1 = 工具结果）是死代码，`markPruned` 永远匹配不到行；② 跨轮次丢失工具调用历史，模型看不到自己上一轮做过什么，重复劳动 | `streamMainAgent` 在 `onStepEnd` 里把 `step.content` 的 tool-call / tool-result 部分 `appendDelta` 进去（`pruneLevel` 分别为 2 / 1）；或在 [02](./02-context-engine.md) 中明确「工具消息不入库」并删除分级裁剪规格 |
| **N-CTX-04** | `context/engine.ts:74` | `advanceWatermark` 在 `openTurn` 内前移，但 [02 §4](./02-context-engine.md) 定义 `claim_watermark` 是「**已折入上下文**的最大 `messages.id`」 | 轮次失败/取消/超时后，被认领的背景消息永久丢失——它们既没进任何 commit，水位又已越过 | 水位前移移到 `commitTurn` 的事务内（与 `insertTurn` 同一 transaction）；或在 `abortTurn` 里回退水位到 `turn` 打开前的值 |
| **N-MEM-02** | `tools/registry.ts:131`、`approvals.ts:10` | `ToolRegistry.#turns` 与 `DatabaseApprovalBroker.#remembered` 两个 Map **只增不删** | 长期运行进程的内存单调增长（每轮一个 `TurnToolState`，每次审批一个记忆项） | `ToolRegistry` 增加 `releaseTurn(turnId)`，在 `bot.ts` 的 `finally` 里调用；`#remembered` 的 key 已含 `turnId`，同处一并清理 |
| **N-CFG-01** | `apps/bot/src/main.ts:23,91` | `ConfigStore` 是**惰性摆设**：`configStore.replace(next, keys)` 只更新其内部 `#current`，而 `ConfigStore.onChange` 全库零调用；所有消费者（`createTelegramBot`、`ToolRegistry`、`Sandbox`、`DatabaseApprovalBroker`、`registerBuiltins`、`createServer`）拿到的都是启动时那个被 `deepFreeze` 的 `config` 对象 | [11 §热更新](./11-config-reference.md) 声明可热更新的配置项，实际只有 `logs.level`、provider 重建、skills 重扫、plugins 重载 4 条生效；改 `context.limit.tokens`、`trigger.*`、`approval.rules`、`quota.*` 等必须重启 | 让消费者持有 `ConfigStore` 而非 `Config` 快照（`deps.config()` 取代 `deps.config`），或在 `main.ts` 用 `configStore.onChange` 重建受影响组件；无法热更新的键在 [11](./11-config-reference.md) 里明确标注「需重启」 |
| **N-CFG-02** | `config/schema.ts` 全域 | **约 45 个配置项声明了但代码从不读取**：`telegram.webhook.*`、`telegram.dropPendingOnStart`、`telegram.notifyEdits`、`webui.trustProxy`、`webui.allowOrigins`、`webui.basePath`、`webui.publicUrl`、`cancel.commitPartial`、`agent.maxConcurrentSubagents`、`agent.ask*`、`alerts.*`、`output.parseMode`、`output.flushOnSentence`、`output.typingWhileWorking`、`output.placeholderAfterMs`、`output.maxMentions`、`trigger.cooldownMsPerUser`、`quota.warnAtRatio`、`quota.onExceeded.notifyOwner`、`quota.perTurn.maxToolCalls`、`quota.perTurn.maxDurationMs`、`memory.pubWriteRequiresApproval`、`memory.autoApplyCompaction`、`memory.requireSourceTag`、`tools.fs.allowHostFsForOwner`、`tools.web.allowlist/denylist/searchProvider/summarizeWithAlias`、`tools.archive.*`、`tools.tg.*`、`prompt.includeToolCatalog`、`prompt.runtimeBlock.*`、`context.cacheCommits`、`context.rebase.markMeta`、`context.background.showUsername/showTime/includeNonText`、`media.maxImagesPerTurn/groupDebounceMs/stickerAsImage/downloadVoice`、`db.ftsTokenizer`、`logs.gzipAfterDays`、`logs.redactPatterns`、`provider.healthDownCooldownMinutes/requestTimeoutMs/streamIdleTimeoutMs`、`skills.enabled`、`plugins.enabled/watch`、`webui.enabled` | 用户在 WebUI 里改这些开关会「保存成功」但毫无效果——这是最容易消耗信任的一类缺陷 | 三选一，逐项决策：① 接线；② 从 schema 删除；③ 保留但在 [11](./11-config-reference.md) 标注 `🚧 未实现`，且 WebUI 设置页对这些字段置灰。**建议为 schema 增加 CI 断言**：每个叶子键必须在 `packages/`、`apps/` 中至少被引用一次，否则必须出现在显式的 `KNOWN_UNIMPLEMENTED` 白名单里 |
| **N-WEB-01** | `server/app.ts:239` | `PUT /api/prompts/:id` **不写文件**：构造了一个 `write` 对象却从未使用，只 `UPDATE memory_docs SET bytes=?,tokens=?`，然后返回 `{ok:true}` | WebUI 编辑 CHARACTER.md / ASSIST.md / PUBMEMORY.md 全部静默失效，且把 `memory_docs` 的 bytes/tokens 改成了与磁盘不符的值（数据库自此说谎）。`PromptDocuments.save()` 已实现且**全库零调用** | 直接调用现成的 `dependencies.documents.save(row.scope, row.subject, body.content, 'webui')`；`createServer` 的依赖里补 `documents: PromptDocuments` |
| **N-WEB-02** | `server/app.ts:116,124` | 登录限流的 key 是 `ctx.req.header('x-forwarded-for') ?? 'local'`，**未经校验**且 `webui.trustProxy` 从不参与判断 | 攻击者每次请求换一个 XFF 即可绕过 5 次锁定做在线爆破；反过来也可伪造他人 IP 触发锁定 | `trustProxy === true` 时才取 XFF 的**第一跳**，否则用 `ctx.env` 的实际远端地址；同时对 `''` 密码短路。并按 [09 §鉴权](./09-webui.md) 补 `allowOrigins` 的 Origin 校验 |
| **N-TOOL-01** | `tools/builtins.ts:116` | `set_model` 写入 `turn.modelAliasOverride`，但**全库无人读取**——`runtime.ts:203` 始终用 `config.agent.main.modelAlias` | 工具向模型报告 `{ok:true, alias}`，模型据此以为已切换到高性能模型并规划了更重的任务，实际模型没变。**向模型撒谎比工具缺失更有害** | `runtime.ts` 的 `alias` 改为 `turn.modelAliasOverride ?? config.agent.main.modelAlias`，并在 `prepareStep` 里响应中途切换；在接好之前，先从注册表移除该工具（沿用 [16 §5](./16-remediation-plan.md) 的「摘除比伪造安全」原则） |
| **N-SEC-01** | `shared/index.ts:66` | `untrusted()` 只清洗 `source` 里的引号，**不转义正文**：正文若含 `</untrusted-content>` 即可提前闭合包裹标记，后续内容会被模型当作可信指令 | [05 §提示注入防御](./05-tools-and-permissions.md) 的核心机制可被一行文本绕过。`web_fetch`、文件读取、MCP 结果、文档抽取全部走这条路径——攻击者控制网页内容即可注入 | 正文转义闭合标记，并用随机 nonce 加固：<br>`const nonce = randomBytes(6).toString('hex');`<br>`text.replaceAll('</untrusted-content', '<\\/untrusted-content')`<br>`` `<untrusted-content id="${nonce}" source="…">…</untrusted-content id="${nonce}">` `` |
| **N-SBX-02** | `sandbox/index.ts:53`、`main.ts:69` | `plan()` 只在 `#dockerAvailable === false` 时拒绝，而 `setDockerAvailable()` **全库零调用**，字段恒为 `null` | `mode: 'docker'`（默认值）且宿主没有 docker 时，`plan()` 返回 allowed → 工具照常注册 → 每次调用都在 `spawn()` 失败。[05 §沙箱](./05-tools-and-permissions.md) 要求的 fail-closed 只做了一半（`mode:'none'` 那半是对的） | 启动时探测一次并注册到健康 cron：<br>`sandbox.setDockerAvailable(spawnSync(config.sandbox.dockerBin, ['info'], {timeout: 5000}).status === 0)` |
| **N-PROV-01** | `agent/runtime.ts:64`、`main.ts:43,62` | `ModelRegistry.rebuild()` 内 `providers.key()` 会在主密钥缺失/不匹配时抛 `LUOLI_MASTER_KEY is unavailable`，调用点均无 `try/catch` | 启动直接崩溃且错误信息与真实原因（provider 表里有加密 key 但环境变量没给）距离很远；更糟的是 `provider-health` cron 每 10 分钟触发一次未捕获的 rejection | `rebuild()` 内逐 provider `try/catch`，失败者写 `providers.health_state='down'` + `health_error`、记 `provider.error` 日志并跳过，不影响其他 provider |
| **N-QUOTA-01** | `bot.ts:223-228` | 预留额是 `max(minReserveUsd, (limit.tokens/4)/1e6 * 1.5)`——与实际模型定价无关，默认恒为 `$0.02`；`ModelRegistry.estimate()` 已实现却无人调用 | 高价模型下预留严重偏低，并发场景中多个轮次可同时通过配额闸门后一起超支（[10 §配额](./10-logging-and-observability.md) 的 reserve→commit 设计目的正是防这个） | `reserve` 的 `estimateUsd` 改用 `registry.estimate(alias, turn.snapshot.tokens + delta tokens) ?? minReserveUsd` |

---

## 4. 新增 P2

| 编号 | 位置 | 问题 | 建议 |
|---|---|---|---|
| N-OPS-01 | `db/database.ts:45` | `recoverAfterCrash` 只处理 `turns` 与 `quota_counters`，遗漏 `agent_runs` 与 `tasks`（重启后永远停在 `running`） | 补两条 `UPDATE … SET state='failed', error='process_restarted'` |
| N-AGENT-01 | `tools/builtins.ts:81` | `agents.createMain()` 创建的 main run 从不结束，`agent_runs` 永远 `running` | `bot.ts` 的 `finally` 里补 `agents.finishMain(turn.turnId)` |
| N-AGENT-02 | `tools/builtins.ts:104` | `ask_parent` 恒走「规则」分支（`input.default ?? options[0] ?? 兜底语`），[04 §四级回答](./04-agents-and-providers.md) 的 arbiter / 用户升级 / 超时三级全未实现；`agent.askArbiter`、`askEscalateToUser`、`askTimeoutMs` 因此是死配置 | 要么实现 arbiter 级，要么在 [04](./04-agents-and-providers.md) 降级为「仅规则级」并删除对应配置 |
| N-TG-02 | `telegram/output.ts:36` | `splitTelegramText` 先 `safeRender` 再按字符数切分：跨切点的 ``` 代码块会被拆成未闭合的两半；无候选分隔符时 `boundary = max` 可能落在 `\.` 转义对中间 | 先按原文切分再逐段 `safeRender`；或切分后对每段重跑一次围栏配平 |
| N-TG-03 | `telegram/media.ts:66` | 图片以完整 base64 进入 `parts`，`commitTurn` 时原样写入 `context_messages.parts_json` | 改存 `attachments.id` 引用，渲染进模型消息时再按需读盘（同时缓解 N-CTX-02） |
| N-TG-04 | `db/archive.ts:91` | `claimBackground` 返回的行不含 `mediaParts`（该字段只在 `media.process` 后挂到内存对象上） | 从 `attachments` 表按 `message_id` 回填 |
| N-TG-05 | `telegram/stream-output.ts:2` | `safeRender` 被 import 但未使用（实际经由 `splitTelegramText` 间接调用） | 删除无用 import；建议开启 `noUnusedLocals` |
| N-TOOL-02 | `tools/builtins.ts:118` | `web_search` 注册时 `available: () => false`，永远不可用；`tools.web.searchProvider` 等 4 个配置项随之失效 | 接线或摘除；保留则在 [05](./05-tools-and-permissions.md) 标注 `🚧` |
| N-TOOL-03 | `tools/files.ts:56` | `grep` 直接 `new RegExp(模型给的 pattern)`，无长度/复杂度限制也无超时 | 复用 `trigger.ts:45` 已有的 ReDoS 防御（长度 ≤128 + 嵌套量词检测） |
| N-APV-01 | `approval/rules.ts:48` | 规则 `{tool: 'delete_file'}`（无 `pattern`/`when`/`always`）会被静默跳过——语义反直觉，用户以为配了审批其实没有 | 要么把裸规则当作 `always: true`，要么在 `configSchema` 里对 `approval.rules` 做结构校验并报错 |
| N-WEB-03 | `server/app.ts:94` | `/api/health` 硬编码 `db:{ok:true}` 与 `inFlightTurns: 0` | 接 `turnRegistry.size` 与一次 `PRAGMA quick_check`；否则 [10 §健康探针](./10-logging-and-observability.md) 的监控是假的 |
| N-WEB-04 | `server/app.ts:235,241,259` | `PUT /api/sandbox`、`POST /api/prompts/:id/rollback`、`PUT /api/quota` 都是「回显入参 + `ok:true`」的空转端点 | 实现或返回 `501`，不要伪装成功 |
| N-WEB-05 | `server/app.ts:218` | `/api/messages` 直接返回 `SELECT *`，含未脱敏的 `raw_json` | 列白名单 + 对 `raw_json` 走 `redact()` |
| N-SEC-02 | `tools/web.ts:14` | `safeUrl` 先 `lookup()` 再 `fetch()`，两次解析之间存在 DNS rebinding 窗口；`privateAddress` 未覆盖 `::ffff:127.0.0.1` 映射地址 | 解析后固定 IP 直连并手工设置 `Host` 头；补 IPv4-mapped IPv6 判断 |
| N-EXT-02 | `plugins/manager.ts:31` | `import(\`…?t=${Date.now()}\`)` 每次 reconcile 都产生新的模块实例，ESM 模块图不可回收 | 记录已加载 hash，内容未变则跳过重载 |
| N-CTX-05 | `turn/concurrency.ts:15` | 排队的 waiter 无超时也不响应 abort，队列未满时可能长期挂起 | `acquire(key, signal, timeoutMs)`，超时 reject 并回复用户 |

---

## 5. 修复批次建议

沿用 [16-remediation-plan.md](./16-remediation-plan.md) 的编号习惯，本轮记为 F0–F3。

### F0 · 止血（0.5 人日，必须先做）

| 顺序 | 项 | 改动量 |
|---|---|---|
| 1 | `N-CTX-01` 硬截断死循环 | `context.ts` 一个方法 + `engine.ts` 循环加上限 |
| 2 | `N-MEM-01` owner 群聊读私有记忆 | 删一个 `&& actorRole !== 'owner'` + 内部改用 `readRaw` |
| 3 | `N-TG-01` 编辑消息双重认领 | 删一行 + 补准入判断 |
| 4 | `N-TOOL-01` `set_model` 摘除或接线 | 三行 |
| 5 | `N-SEC-01` `untrusted()` 转义闭合标记 | 一个函数 |

**F0 的三项 P0 都属于「代码看起来对、语义错」**，且现有 52 条用例全部测不出来。**逐条先写红灯用例再改实现**——否则无法证明改对了。

### F1 · 恢复被声明的能力（2–3 人日）

`N-EXT-01`（外部工具入注册表）、`N-CFG-01`（热更新真正生效）、`N-WEB-01`（提示词落盘）、`N-CTX-02`（多模态计费）、`N-CTX-04`（水位随提交前移）、`N-SBX-02`（docker 探测）、`N-PROV-01`（provider 降级不崩）、`N-WEB-02`（限流 key）。

### F2 · 收口与一致性（1–2 人日）

`N-CFG-02` 的 45 个配置项逐项决策（接线 / 删除 / 标注 `🚧`）+ CI 断言；`N-CTX-03` 决定工具消息是否入库并同步 [02](./02-context-engine.md)；`N-MEM-02`、`N-QUOTA-01`、`N-OPS-01`、`N-AGENT-01/02`。

### F3 · WebUI 深化（3–5 人日，可与 F1/F2 并行）

当前 `ConsoleView.vue` 用 125 行覆盖了 [09 §3](./09-webui.md) 的全部 13 个导航分区，**只读展示基本齐全**，但编辑类交互几乎都没有：提示词编辑器与 diff 回滚、别名 `OrderList` 拖拽、Provider 编辑对话框、上下文查看器的 `prune_level` 灰显与 `rebased` 徽标、Commit 时间线的 `[回滚到此]`。这与 `N-WEB-01/04` 的后端空转端点是同一件事的两面——**建议前后端成对修复**，否则前端做完仍然存不进去。

---

## 6. 文档侧需要同步修改

| 文档 | 修改 | 原因 |
|---|---|---|
| [07 §4.2](./07-skills-plugins-mcp.md) | 用 `@modelcontextprotocol/sdk` 的 `Client` + `StdioClientTransport` / `StreamableHTTPClientTransport` 重写示例，删除 `experimental_createMCPClient` | 第一轮记录的勘误已由实现解决，文档反而落后于代码 |
| [02 §5.3](./02-context-engine.md) | 补一句硬截断的**终止性不变式**：「每次截断必须使目标消息的生效 token 严格递减；全部压至下限仍超限时退出循环并告警」 | `N-CTX-01` 的根因是规格没写终止条件，实现自然写漏 |
| [02 §4](./02-context-engine.md) | 明确 `claim_watermark` 前移的**时机**（随 commit 事务，而非 openTurn） | 现规格只说了「已折入上下文」，未说明失败轮次如何处理，`N-CTX-04` 由此产生 |
| [02 §5.3](./02-context-engine.md) | 决定 `tool_call`/`tool_result` 是否入库；若不入库则删除分级裁剪规格 | `N-CTX-03`：现规格描述的 level 1/2 在实现中无数据可匹配 |
| [05 §7](./05-tools-and-permissions.md) | 在「内容与指令分离」条目补充：正文必须转义闭合标记并使用随机 nonce | `N-SEC-01`：现文档只要求「包裹」，未要求「防逃逸」 |
| [05 §3.1](./05-tools-and-permissions.md) | 为 `edit_file`（现为「审批：—」）补一条风险说明 | `edit_file` 可改写 workspace 内任意既有文件，危险性不低于需审批的 `write_file` 覆盖场景。**代码与文档一致，此处是设计取舍需要复核，不是实现缺陷** |
| [11](./11-config-reference.md) | 为 `N-CFG-02` 列出的约 45 个键加 `🚧 未实现`；为不可热更新的键加「需重启」 | 避免 WebUI「保存成功但无效果」 |
| [09 §3](./09-webui.md) | 标注哪些页面当前为只读、哪些后端端点尚未实现 | 与 `N-WEB-01/04` 对齐预期 |

---

## 7. 测试覆盖评估

**52 passed / 35 files**，相比第一轮的 20 / 11 是实质性进步，且新增用例的选题准确——`context.prune`、`context.private`、`memory.isolation`、`sandbox.failclosed`、`approval.rules`、`access.commands`、`quota.concurrency`、`turn.drain`、`cancel` 全部对准了第一轮的 P0。

但仍存在**同一类盲区**：用例验证的是「修复后的正常路径」，而非「修复未覆盖的邻接分支」。

| 本轮 P0 | 最接近的现有用例 | 为何没测出来 |
|---|---|---|
| `N-CTX-01` | `context.prune.test.ts` 第 2 例 | 只放**一条**大消息，一次截断即收敛；死循环需要**两条 `tokens` 相同**的大消息 |
| `N-MEM-01` | `memory.isolation.test.ts` | 只覆盖非 owner 角色在群聊被拒；未覆盖 owner |
| `N-TG-01` | `access.commands.test.ts` | 只发 `message` 更新，从未构造 `edited_message` |
| `N-EXT-01` | `mcp.runtime.test.ts`、`plugin.runtime.test.ts` | 测的是 `McpManager`/`PluginManager` 自身能发现工具，未断言这些工具**最终能被模型调用**（即出现在 `activeTools` 里） |

**建议补充的断言（按性价比排序）**：

1. 硬截断终止性（两条等大消息，1s 超时断言）；
2. `memory.read` 的四象限矩阵：`{owner, 非owner} × {私聊, 群聊}`，只有 `私聊+本人` 与 `私聊+owner跨用户` 允许；
3. `edited_message` 归档 revision 递增；
4. **端到端工具可达性**：注册一个假插件 + 假 MCP 服务器（`tests/fixtures/mcp-server.mjs` 已有），断言其工具名同时出现在 `activeNames` 与 `ToolRegistry.names()` 中；
5. 配置项引用断言（`N-CFG-02`）——这是唯一能长期防住「声明了但没接线」这类缺陷的手段。

---

## 8. 验收状态快照（粗估）

对 [13-acceptance-criteria.md](./13-acceptance-criteria.md) 的 253 条用例做估算。这是基于代码审阅的**判断，不是实跑结果**，仅用于判断「是否值得启动正式验收」。

| 分组 | 用例数 | 第一轮估计 | 本轮估计 | 主要卡点 |
|---|---|---|---|---|
| 配置 / 数据库 / 迁移 | 24 | 18 | 21 | `N-CFG-02` 的未接线项 |
| 上下文引擎 | 28 | 9 | 22 | `N-CTX-01` 硬截断、`N-CTX-03` 工具消息 |
| Telegram / 输出 / 多模态 | 35 | 8 | 27 | `N-TG-01` 编辑消息 |
| 权限 / 沙箱 / 审批 | 30 | 12 | 26 | `N-SBX-02` docker 探测 |
| Agent / Provider / 子 agent | 23 | 6 | 18 | `N-AGENT-02` ask 四级 |
| 提示词 / 记忆 | 22 | 11 | 18 | `N-MEM-01` |
| 日志 / 配额 / 运维 | 26 | 14 | 21 | `N-QUOTA-01`、`N-WEB-03` |
| Skill / Plugin / MCP | 21 | 7 | 9 | `N-EXT-01`（整段阻断） |
| WebUI | 26 | 8 | 13 | `N-WEB-01/04` + 前端编辑态 |
| 安全 | 18 | 8 | 14 | `N-SEC-01`、`N-WEB-02` |
| **合计** | **253** | **~101 (40%)** | **~189 (75%)** | |
| 其中 ★ 关键项 | 62 | 21 | 47 | |

**判断**：F0 + F1 完成后（约 3–4 人日）预计可达 ~225/253、★ 56/62，届时具备启动正式验收的条件。F3（WebUI 编辑态）可作为验收后的增量交付，不必阻塞。

---

## 9. 值得保留的做法

复审中确认以下实现是**正确且经过深思**的，后续重构时不要退化：

1. **`turnStartOrdinals` 用 SQL 的 `MIN … GROUP BY`** 而不是在 JS 里重算——既正确又让「turn 边界」这个不变式有了唯一真相源。
2. **`isPrivate` 作为显式参数贯穿全链路**，而非从 `chatId === userId` 反推——这个改动同时修好了记忆隔离和渲染格式两个问题。
3. **`insertTurn` 的事务边界**：读 HEAD、分配 ordinal、写消息、写 commit、移 ref 全在一个 `db.transaction` 内，且 `appendDelta` 里有 `if (message.ordinal !== undefined) throw`——「ordinal 只在提交时分配」这条红线有运行时断言保护。
4. **`main.ts:78` 的 `for (const name of Object.keys(TOOL_POLICY)) if (!toolRegistry.has(name)) throw`**——把「策略表与注册表必须一一对应」变成启动断言，这正是第一轮「注册 19/33」问题的正确长期解法。
5. **`KeyedMutex` 的 FIFO 语义**与 `TurnConcurrency` 的 perKey/global 双层闸门。
6. **`fallbackLanguageModel`** 用 `wrapLanguageModel` 中间件实现重试+降级，对 401/403 不重试——判断正确。
7. **`PathJail`** 对不存在路径的父目录 realpath 处理、符号链接二次校验。
8. **`Secrets`** 的 AES-256-GCM 实现与 `STRUCTURAL_FIELDS` 白名单式脱敏。
9. **`quota.commit` 的 `Math.min(amount, actual)` 递减**——保证了 `finally` 中的 `release()` 不会二次退款。
10. **`TurnRegistry.drain` + `abortAll` 的两段式优雅停机**。
