# 15 · 实现与文档差异审阅（Gap Review）

审阅对象：`packages/*`、`apps/bot`、`scripts`、`tests` 全量源码（3,831 行 TS/Vue）。
审阅基线：本目录 `README.md` 的 D1–D20 决策与 01–13 号文档。
审阅时间：2026-08-15。

**静态状态**：`tsc --noEmit` 通过；`vitest run` 20/20 通过（11 个文件）。
**结论**：骨架、数据模型、配置 schema、准入模型的实现质量高且与文档一致；但**上下文裁剪、记忆隔离、子 agent、审批、配额、取消、流式输出、多模态、扩展生态**存在从「语义错误」到「整块未实现」的差异，其中 12 项为 P0。

> 严重度定义
> **P0** — 破坏文档已定的核心语义或安全边界，会产生错误行为或越权，必须修。
> **P1** — 文档明确承诺、验收用例依赖，但未实现或实现不完整。
> **P2** — 健壮性、一致性、可维护性问题，不阻塞验收但应排期。

---

## 0. 总览

| 域 | P0 | P1 | P2 | 与文档的整体符合度 |
|---|:--:|:--:|:--:|---|
| 数据模型 / 迁移（03） | 0 | 2 | 1 | ★★★★☆ 27 张表齐全，DDL 与文档一致 |
| 配置（11） | 0 | 2 | 0 | ★★★★★ schema 与文档逐项吻合，校验规则到位 |
| 准入与角色（05 §2） | 1 | 0 | 0 | ★★★★☆ `resolveEffectiveRole` 正确，但命令绕过网关 |
| **上下文引擎（02）** | 2 | 4 | 3 | ★★★☆☆ 两层结构与 rebase 正确，**裁剪算法错误** |
| **记忆（06）** | 1 | 3 | 2 | ★★★☆☆ 提示词注入正确，**工具读取路径越权** |
| Agent / Provider（04） | 2 | 4 | 2 | ★★☆☆☆ 主 agent 可用，**子 agent 为桩** |
| 工具 / 沙箱 / 审批（05） | 3 | 5 | 4 | ★★☆☆☆ 33 条策略仅实现 19 个工具 |
| Telegram（08） | 2 | 5 | 3 | ★★☆☆☆ 无流式、无多模态、无取消 |
| 日志 / 成本 / 配额（10） | 2 | 4 | 1 | ★★☆☆☆ 记账正确，**span 树与配额闭环缺失** |
| 扩展生态（07） | 0 | 4 | 1 | ★★☆☆☆ Skill 加载器完成度高但未接线；MCP 缺失 |
| WebUI（09） | 0 | 3 | 1 | ★☆☆☆☆ 2/13 页面，API 覆盖约 40% |
| 运维（12/13） | 0 | 3 | 1 | ★★★☆☆ 崩溃恢复正确，优雅退出与定时任务缺失 |
| **合计** | **13** | **39** | **19** | |

---

## 1. P0 —— 必须修

### G-CTX-01 · 裁剪窗口落在 turn 中间，产生孤儿 tool 消息 ★已实测确认

- **位置**：`packages/core/src/context/engine.ts:157-180`（`prune`）
- **文档依据**：[02 §5.2](./02-context-engine.md#52-裁剪单位exchange一个-turn-的-delta)「裁剪的最小单位是一个完整 turn 的 delta，`window_start` 只能落在某个 turn 的第一条消息上」；[02 §9 红线 6](./02-context-engine.md#9-实现红线清单code-review-必查)；AC-CTX-014。
- **现状**：

```ts
const turnStarts = [...new Map(messages.map((m) => [m.turnId, m.ordinal])).values()];
//                     ↑ Map 遇到重复 key 保留【最后】一个值 ⇒ 得到的是每个 turn 的「末条」ordinal
while (...) {
  turnStarts.shift();
  windowStart = turnStarts[0] ?? windowStart;   // ↑ 再取下一个 turn 的「末条」
}
```

  两处叠加，`window_start` 必然落在某个 turn 的最后一条消息上。

- **实测**：10 轮对话（每轮 `trigger` + `tool_call` + `tool_result`，ordinal 1,4,7,…,28），`limit.tokens=4000` 触发裁剪后

  ```
  windowStart = 27      turn 起始 ordinal = 1,4,7,10,13,16,19,22,25,28
  窗口首条 origin = tool_result   role = tool
  ```

  窗口第一条是 `tool_result`，其配对的 `tool_call`（ordinal 26）已被排除 —— 这正是文档要防的孤儿。多数 provider（Anthropic / OpenAI）会直接 400 拒绝这种消息序列。

- **修改指导**：

```ts
// packages/db/src/context.ts —— 新增：按 turn 分组取【首条】ordinal
turnStartOrdinals(from: number, to: number): number[] {
  return (this.db.prepare(
    `SELECT MIN(ordinal) AS ordinal FROM context_messages
      WHERE key=? AND ordinal BETWEEN ? AND ? GROUP BY turn_id ORDER BY ordinal`
  ).all(this.key, from, to) as Array<{ ordinal: number }>).map((row) => row.ordinal);
}

// packages/core/src/context/engine.ts —— prune 的步骤 1 改写
const starts = repo.turnStartOrdinals(commit.windowStart, commit.headOrdinal);
let windowStart = commit.windowStart;
let index = 0;
const over = () => {
  const kept = messages.filter((m) => m.ordinal >= windowStart);
  return kept.reduce((s, m) => s + (m.tokens ?? 0), 0) > cfg.context.limit.tokens
      || kept.length > cfg.context.limit.maxMessages;
};
// 至少保留 minKeepTurns 个完整 turn（含刚提交的这个）
while (over() && starts.length - index > cfg.context.limit.minKeepTurns) {
  index += 1;
  windowStart = starts[index]!;      // ← 始终是下一个 turn 的【首条】
}
```

  同时补上文档 §5.3 的**步骤 3（字符级硬截断）**：分级 prune 后仍超限时，对窗口内最大的一条消息做硬截断并写 `meta.truncated`。当前实现完全缺这一步，遇到「单条超大工具输出」会永久超限。

- **验收**：AC-CTX-014、AC-CTX-015。补一条断言：`window_start ∈ turnStartOrdinals` 且窗口内不存在没有配对 `tool_call` 的 `tool` 消息。

---

### G-CTX-02 · 私聊的背景消息被加上群聊发言人前缀 ★已实测确认

- **位置**：`packages/core/src/context/engine.ts:73`
- **文档依据**：[02 §4.3](./02-context-engine.md#43-渲染格式)「私聊：无前缀，直接是消息正文」；[02 §9 红线 10](./02-context-engine.md#9-实现红线清单code-review-必查)；AC-CTX-006。
- **现状**：

```ts
const delta = claim.rows.map((m) => renderArchivedMessage(m, false, tz));
//                                                        ↑ isPrivate 恒为 false
delta.push(renderArchivedMessage(request.trigger, request.trigger.chatId === request.initiatorUserId, tz));
//                                                ↑ 触发消息用的是另一套（脆弱的）判定
```

- **实测**：私聊（chatId = userId = `999`）中一条未触发的历史消息 + 一条触发消息，得到

  ```
  delta = ["[Alice 02:26] 先问一句", "再问一句"]
  ```

  同一轮里前缀风格自相矛盾，模型会学着在私聊里也给自己加前缀。

- **附带问题（同源）**：`chatId === initiatorUserId` 这种「私聊判定」在三处被复制（`engine.ts:78`、`runtime.ts:135`、`builtins.ts:38`）。它依赖「Telegram 私聊 chat.id 等于 user.id」这一外部约定，且是 **D11 记忆隔离的判定依据**，不应该靠推断。

- **修改指导**：
  1. `OpenTurnRequest` 增加显式字段 `isPrivate: boolean`，由 `packages/telegram/src/bot.ts` 从 `ctx.chat.type === 'private'` 传入（那里是唯一的权威来源）。
  2. `RuntimeTurnContext` 同样携带 `isPrivate`，供 `runtime.ts` / `builtins.ts` 使用，删除全部 `chatId === initiatorUserId` 推断。
  3. `openTurn` 中背景与触发消息统一 `renderArchivedMessage(m, request.isPrivate, tz)`。

- **验收**：AC-CTX-006；新增用例：私聊 delta 中任何一条都不匹配 `/^\[.+ \d{2}:\d{2}\]/`。

---

### G-MEM-01 · 群聊可以读取发起人的私有记忆 ★已实测确认

- **位置**：`packages/core/src/memory/store.ts:52`、`packages/core/src/tools/builtins.ts:33-34`
- **文档依据**：[06 §3.1](./06-prompt-and-memory.md#31-注入读)「群聊 PRIMEMORY：**✗（硬禁止）**」；D11；AC-MEM-003、AC-MEM-004。
- **现状**：

```ts
// store.ts
if (scope === 'primemory' && subject !== actorUserId && actorRole !== 'owner') throw ...
// builtins.ts —— memory_read 把 subject 设为发起人自己
subject: input.scope === 'primemory' ? context.turn.initiatorUserId : null
```

  群聊里 `subject === actorUserId` 恒成立 ⇒ 守卫失效。`MemoryStore.read` 根本没有 `isPrivate` 参数。

- **实测**：`store.read('primemory','u123','limited','u123')` 未抛错，返回 `data/…/private/u123/PRIMEMORY.md` 的内容。在群里让 bot「看看你记得我什么」即可把私聊里写的私密信息读进群上下文。

- **注意**：**提示词注入路径是正确的**（`PromptDocuments.readForPrompt` 只在 `isPrivate` 时读 PRIMEMORY，`PromptAssembler` 也正确省略该块，AC-PROMPT-002 通过）。泄漏只发生在**工具读取路径**，所以单看提示词测试会误以为安全。

- **修改指导**：
  1. `MemoryStore.read(scope, subject, actorRole, actorUserId, isPrivate)` 增加 `isPrivate` 参数：

     ```ts
     if (scope === 'primemory') {
       if (!isPrivate && actorRole !== 'owner') throw new Error('private_memory_forbidden');
       if (subject !== actorUserId && actorRole !== 'owner') throw new Error('private_memory_forbidden');
     }
     ```
  2. 按 [06 §3.2](./06-prompt-and-memory.md#32-写入) 的「工具不注册」原则，在 `ToolRegistry.forRole` 层面收窄 —— 群聊注册的 `memory_read`/`memory_write` 的 `inputSchema` 应为 `z.enum(['pubmemory'])`，`primemory` **不出现在枚举里**（当前是静态 enum 含两个值，AC-MEM-003 明确要求枚举中无该值）。做法：把这两个工具改为按 `(role, isPrivate)` 动态构造的注册项。
  3. owner 读他人私有记忆时补 `log.event({level:'warn', kind:'memory.owner_read_private', data:{targetUserId}})`（AC-MEM-011）。

- **验收**：AC-MEM-002/003/004/011。

---

### G-LOG-01 · 脱敏器把 `log_events.key`（上下文键）整个抹掉 ★已实测确认

- **位置**：`packages/core/src/secrets.ts:46`
- **文档依据**：[10 §3](./10-logging-and-observability.md#3-落盘格式) 日志行含 `"key": "chat:-1001234567"`；[09 §3.10](./09-webui.md#310-日志logs) 按会话过滤日志。
- **现状**：`redact` 的字段名规则 `/key|secret|token|password/i.test(name)` 会命中 `LogEvent` 自己的 `key` 字段（上下文键）。
- **实测**：`redact({level,kind,key:'chat:-1001234567',summary})` → `{"key":"«redacted»"}`。所有日志行与 `log_events.key` 列永久丢失会话维度，WebUI 无法按会话过滤日志。
- **修改指导**：把字段名规则收紧为「以 key 结尾或独立单词」，并显式豁免结构字段：

```ts
const STRUCTURAL = new Set(['key', 'kind', 'traceId', 'spanId', 'parentSpanId', 'chatId', 'userId']);
const SENSITIVE = /(^|_|\b)(api[_-]?key|apikey|secret|token|password|passwd|credential)s?($|_|\b)/i;
if (!STRUCTURAL.has(name) && SENSITIVE.test(name) && typeof input === 'string' && input) return '«redacted»';
```

  注意保留正则型脱敏（bot token / `sk-` / `Bearer`）——那部分实现正确，AC-LOG-007 通过。
- **验收**：AC-LOG-007 保持通过 + 新增断言 `log_events.key` 与 `chatId` 不被脱敏。

---

### G-AGENT-01 · `spawn_agent` 是桩：从不真正运行子 agent

- **位置**：`packages/core/src/tools/builtins.ts:43-51`
- **文档依据**：[04 §3.2](./04-agents-and-providers.md#32-spawn_agent-工具)；D13；AC-SUB-001…013 全部。
- **现状**：

```ts
const { run, definition } = dependencies.agents.spawn(parent, input.agent, input.task, input.modelAlias);
const summary = `[子 agent ${definition.name} 已创建] ${input.task}${...}`;
return { ok: true, runId: run.id, agent: definition.name, result: dependencies.agents.finish(run, summary) };
```

  创建 `agent_runs` 行后**立即把任务描述原样当作结果 finish 掉**。没有模型调用、没有独立上下文、没有工具集、没有进度、没有 `toModelOutput` 摘要回灌。主 agent 拿到的是自己刚写的 task 文本，会据此编造结论。

- **影响**：M5 整块（AC-SUB 13 条 + AC-TASK 8 条）不成立；且比「未实现」更糟 —— 它会让模型**以为**任务已完成。
- **修改指导**（按 [04 §3.2](./04-agents-and-providers.md#32-spawn_agent-工具) 落地）：
  1. 把子 agent 执行逻辑放进 `packages/core/src/agent/subagent.ts`，签名 `runSubAgent(run, definition, task, context, deps): AsyncGenerator<Progress, Result>`；内部构造 `new ToolLoopAgent({ model: registry.resolve(alias), instructions: prompt.buildSub(definition), tools: registry.active(run.effectiveRole, {…, agentKind:'sub', allow: definition.tools}), stopWhen: stepCountIs(definition.maxSteps) })`，`messages` 仅为 `[{role:'user', content: task(+context)}]`。
  2. `spawn_agent.execute` 改为 `async function*`，`yield` 进度、`return` 结果；并在 AI SDK 侧配 `toModelOutput` 只回灌 `resultMaxChars` 内的摘要。
  3. 子 agent 的 usage 用同一个 `turnId` + 自身 `agentRunId` 记入 `usage_ledger`（[10 §4.1](./10-logging-and-observability.md#41-记账点)）。
  4. 深度/环路/数量护栏已在 `AgentManager.spawn` 正确实现，直接复用。
  5. 配套补 `read_agent_result`（`AgentResultStore.read` 已就绪，只差注册工具）。
- **验收**：AC-SUB-001…013。**在没实现之前，应先把 `spawn_agent` 从注册表摘掉**，宁可不提供，也不能返回伪造的完成结果。

---

### G-AGENT-02 · 上下文消息被压平成纯文本，工具配对与多模态全丢

- **位置**：`packages/core/src/agent/runtime.ts:111-118`（`contextMessages`）
- **文档依据**：[02 §6](./02-context-engine.md#6-物化与缓存)「`messages: ModelMessage[]`，已含 multimodal parts」；[08 §7.2](./08-telegram-adapter.md#72-图片处理)；D16。
- **现状**：

```ts
const content = message.parts.map((p) => 'text' in p ? String(p.text) : JSON.stringify(p)).join('\n');
if (message.role === 'tool') return { role: 'user', content: `[工具结果]\n${content}` };
```

  三个后果：
  1. `tool` 消息被伪装成 `user` 消息 —— 与 AI SDK 的 tool-call/tool-result 协议脱节，模型无法把结果关联回它发起的调用；
  2. 任何非文本 part（图片、文件）被 `JSON.stringify` 成一坨 JSON 塞进文本；
  3. assistant 消息丢掉 `toolCalls`，多步循环的历史不可复现。
- **修改指导**：`context_messages.parts_json` 已经按 AI SDK `ModelMessage.content` 的 parts 数组存储，**直接透传即可**：

```ts
function contextMessages(turn): ModelMessage[] {
  return [...turn.snapshot.messages, ...turn.delta].map((m) => ({
    role: m.role, content: m.parts,          // 不再 join 成字符串
  } as ModelMessage));
}
```

  并要求写入端（`appendDelta` 的调用方）按真实语义写 parts：assistant 的 `tool-call` part、tool 的 `tool-result` part、图片的 `image` part。当前 `bot.ts:133` 只写了一条纯文本 assistant 消息，配合 G-TG-03（无流式、无工具事件回写）一并修。
- **验收**：AC-AGENT-001（`messages` 只含上下文）+ 新增：含图片的轮次在请求体中出现 `image` part；多步工具循环后 `context_messages` 中存在 `origin='tool_call'` / `'tool_result'` 且成对。

---

### G-TOOL-01 · `approval: 'conditional'` 从不触发审批；`approval.rules` 未实现

- **位置**：`packages/core/src/tools/registry.ts:70`
- **文档依据**：[05 §6](./05-tools-and-permissions.md#6-审批流) 风险规则表；AC-APV-001。
- **现状**：`if (tool.policy.approval === 'always' && !(await approval.request(...)))` —— 只处理 `'always'`。而 `TOOL_POLICY` 里 `bash`/`python`/`write_file`/`move_file` 都是 `'conditional'`，`config.approval.rules` 数组从未被读取。结果：**`bash("rm -rf /workspace")` 直接执行，不经任何审批**。
- **修改指导**：
  1. 新增 `packages/core/src/approval/rules.ts`：把 `config.approval.rules`（`{tool, pattern, when, always, risk}`）编译成匹配器，输入 `(toolName, input, context)` 输出 `{needed: boolean; risk: 'low'|'medium'|'high'}`；`when: 'target_exists'` 需要工具侧提供谓词（`write_file`/`move_file` 检查目标是否存在）。
  2. `registry.execute` 改为：

     ```ts
     const decision = tool.policy.approval === 'always'
       ? { needed: true, risk: 'high' as const }
       : tool.policy.approval === 'conditional'
         ? rules.evaluate(name, parsed.data, context)
         : { needed: false, risk: 'low' as const };
     if (decision.needed && !(await this.approval.request(tool, parsed.data, context, decision.risk))) return { ok:false, error:'未获批准' };
     ```
  3. `approvals.risk` 写真实风险级别（当前硬编码 `'high'`）。
  4. 实现 `approval.rememberWithinTurn`（同 turn 内同工具同输入复用决定）。
- **验收**：AC-APV-001、AC-APV-007。

---

### G-APV-01 · `approval.enabled = false` 反而让高危工具永久不可用（语义反转）

- **位置**：`packages/core/src/approvals.ts:12`
- **现状**：`if (!this.config.approval.enabled) return false;` —— 返回「未批准」。调用方据此拒绝执行，于是**关闭审批 = 禁用 `delete_file`**。
- **文档依据**：[11 §2](./11-config-reference.md#2-configconfigyaml-全量参考) `approval.enabled` 的语义是「是否启用审批流程」，关闭应表示「不需要审批」。
- **修改指导**：`if (!this.config.approval.enabled) return true;`，并在启动时对 `approval.enabled=false` 打一条 `warn` 日志（这是把高危工具变成无人值守，属于重大配置）。
- **验收**：新增用例 —— `approval.enabled=false` 时 `delete_file` 可执行且 `approvals` 表无 pending 行。

---

### G-SBX-01 · `sandbox.mode='none'` 时 `bash`/`python` 仍然注册（未 fail-closed）

- **位置**：`packages/core/src/tools/registry.ts:46-55`（`active`）、`packages/core/src/sandbox/index.ts:41-45`
- **文档依据**：[05 §5.2](./05-tools-and-permissions.md#52-策略解析sandboxplan)「非 owner 在无沙箱时**工具消失而非降级**」；AC-SBX-001「工具**不存在**（fail-closed），不是『执行后被拒』」。
- **现状**：`Sandbox.plan` 的判定本身是对的（bypassRoles 优先、mode=none 拒绝），但只在 `run()` 内生效。工具依旧出现在 `activeTools` 与 RUNTIME 块里，模型会调用它然后收到一条错误。
- **同类缺口**：`sandbox.mode='docker'` 但宿主无 docker 时，也应视为不可用并 fail-closed（AC-SBX-008），当前没有任何 docker 可用性探测。
- **修改指导**：
  1. `RegisteredTool` 增加可选谓词 `available?(role, context): boolean`；`ToolRegistry.active` 过滤 `tool.available?.(role, ctx) !== false`。
  2. `bash`/`python` 注册时传 `available: (role) => dependencies.sandbox.plan(role).allowed`。
  3. `Sandbox` 启动时探测 `docker version`（缓存 + 每 `healthDownCooldownMinutes` 重试），`plan()` 在 `mode==='docker' && !dockerAvailable` 时对非 bypass 角色返回 `allowed:false`，并触发 owner 告警。
- **验收**：AC-SBX-001、AC-SBX-002、AC-SBX-008。

---

### G-QUOTA-01 · 配额只在轮末结算一次，预留恒为 `minReserveUsd`

- **位置**：`packages/telegram/src/bot.ts:110-137`
- **文档依据**：[10 §5.3](./10-logging-and-observability.md#53-预留-提交防并发超支)「预留 = 估算成本 × 安全系数 1.5；每次模型调用后 commit」；AC-QUOTA-002「额度只够 2 个 turn，并发 5 个 → 恰好 2 个执行」。
- **现状**：
  - `reserve({ estimateUsd: config.quota.minReserveUsd })` —— 预留固定 $0.02，与本轮实际开销无关；
  - `quota.commit(reservation, turns.cost(turnId))` 只在 turn 成功结束时调用一次；
  - `perTurn.maxCostUsd / maxSteps / maxToolCalls / maxSubagents / maxDurationMs` 与 `rateLimit.*` 全部未使用；
  - `warnAtRatio`（80% 提示）、`onExceeded.reply`、`notifyOwner`、`requirePricing` 均未实现；超限文案里 `{spent}`/`{limit}` 被替换成 `—`。
- **影响**：并发 N 个 turn 时，N × $0.02 的预留通过检查，实际可花掉任意金额；单轮失控（模型疯狂调工具）也无上限。**配额在并发场景下形同虚设**。
- **修改指导**：
  1. 预留估算：`estimate = (snapshotTokens + expectedOutput) × 别名单价 × 1.5`，下限 `minReserveUsd`。
  2. 把 `QuotaGuard` 传进 `runMainAgent`，在 `prepareStep` 里做 `canSpend` 判定（[04 §2](./04-agents-and-providers.md#2-主-agent-装配) 的 (d) 分支）：余额不足或 `turns.cost_usd > perTurn.maxCostUsd` 时置 `toolChoice:'none'` + `activeTools:[]` 强制收尾。
  3. `UsageLedger.record` 之后立即 `quota.commit(reservation, cost)`（每次模型调用一次），`release` 只归还剩余预留。
  4. 补 `rateLimit`（按 `turns` 表滑窗计数）、80% 一次性提示、owner 告警、`requirePricing`（无定价模型对非 owner 不可用）。
  5. 超限文案填真实数字：`{spent}`/`{limit}` 从 `quota_counters` 取，`{resetAt}` 按 bucket 推算。
- **验收**：AC-QUOTA-001…012。

---

### G-TG-01 · 命令处理器绕过准入网关（blocked 用户可操作上下文）

- **位置**：`packages/telegram/src/bot.ts:33-79`
- **文档依据**：[08 §2](./08-telegram-adapter.md#2-中间件链顺序即安全语义) 中间件顺序（accessGate 在 commandRouter 之前）；[08 §8](./08-telegram-adapter.md#8-命令) 命令的 minRole 列；AC-ACL-001。
- **现状**：`bot.command('new'|'undo'|'ctx'|'tasks'|'ping'|'usage'|'whoami', …)` 全部注册在 `bot.on('message')` 之前，且**不做任何角色检查、不调用 `next()`**。后果：
  - 任何人（包括 `blocked`、未白名单的陌生人）在任意群/私聊发 `/new` 即可**清空该会话上下文**，`/undo` 可回退他人对话，`/ctx` 可读取上下文统计，`/usage` 可读取全局用量；
  - 这些消息也从未进入 `claimUpdate` 去重与 `archive`，与 [08 §3](./08-telegram-adapter.md#3-归档) 的「命令消息仍归档」不符。
- **修改指导**：
  1. 在所有 `bot.command` 之前插入一个 grammY 中间件，完成 dedup → 角色解析 → `blocked` 拦截 → 归档，并把 `ctx.access` 挂到 context 上，然后 `await next()`。
  2. 每个命令 handler 首行按 [08 §8](./08-telegram-adapter.md#8-命令) 的 minRole 表校验 `ctx.access.effective`；`/grant`/`/revoke`/`/usage`(全局) 限 owner。
  3. `/whois`、`/model`、`/memory`、`/forgetme`、`/wake`、`/cancel`、`/help`、`/start`、`/ask` 尚未实现，一并补齐（`/ask` 需显式触发 AI 流程）。
- **验收**：AC-ACL-001、AC-ACL-006、AC-TG-001。

---

### G-TG-02 · `abortSignal` 是一次性空 controller —— 取消与超时不可能实现

- **位置**：`packages/telegram/src/bot.ts:123`
- **文档依据**：[08 §6](./08-telegram-adapter.md#6-长任务与进度)；D17；[02 §3.5](./02-context-engine.md#35-取消cancel)；AC-TASK-004。
- **现状**：`abortSignal: new AbortController().signal` —— controller 立刻被丢弃，无人持有引用，**永远不可能 abort**。因此 `/cancel`、inline 取消按钮、`concurrency.turnTimeoutMs`、审批超时联动、沙箱容器 kill 全部无法工作（沙箱 `run()` 里的 abort 监听是死代码）。
- **修改指导**：
  1. 新增 `TurnRegistry`（`Map<turnId, {controller, chatId, userId, startedAt}>`），`openTurn` 时登记、`finally` 中注销。
  2. `setTimeout(() => controller.abort('timeout'), config.concurrency.turnTimeoutMs)`。
  3. 实现 `/cancel [id]` 与 inline 按钮（`callback_data = 'c:<turnId>'`），校验点击者为发起人或 owner（AC-TASK-005/006）。
  4. 取消后按 `cancel.commitPartial`（默认 false）决定是否提交 delta，`turns.state='cancelled'` + `cancel_reason`。
  5. 沙箱容器名改为 `luoli-sbx-<turnId>-<seq>`，取消时 `docker kill` 精确匹配（当前用 `Date.now()` 命名，并发同毫秒会撞名）。
- **验收**：AC-TASK-004…008、AC-CTX-022。

---

### G-TG-03 · 流式输出未接线（`TelegramOutput` 是死代码）

- **位置**：`packages/telegram/src/bot.ts:128-132` vs `packages/telegram/src/stream-output.ts`
- **文档依据**：D18「可配置，默认流式」；[08 §5.2](./08-telegram-adapter.md#52-流式算法)；AC-OUT-001/006/007。
- **现状**：`stream-output.ts` 实现了 `TelegramOutput.consume()`（typing 续期、节流 edit、失败降级），但 `bot.ts` **从未 import 它**，走的是 `ctx.reply(safeRender(part))` 一次性发送。`runMainAgent` 也用 `agent.generate()` 而非 `agent.stream()`，根本没有可消费的流。`output.mode` 配置项无效。
- **修改指导**：
  1. `runMainAgent` 改为 `const result = await agent.stream({messages, abortSignal})`，返回 `result.textStream` 给调用方；`onTurn` 的签名从 `Promise<string>` 改为 `Promise<{ stream: AsyncIterable<string>; final: Promise<AgentResult> }>`。
  2. `bot.ts` 用 `new TelegramOutput(bot, chatId, {mode: cfg.output.mode, …}).consume(stream, replyToId)`。
  3. 修 `TelegramOutput.consume` 的两个缺陷：
     - `if (text.length > this.options.maxChars) break;` 会**中途放弃剩余流**并在 finally 里用 `send()` 重发全文 ⇒ 已发出的那条消息内容重复。应改为「定稿当前消息 → 新开一条继续」而不是 break。
     - 编辑失败被静默 `catch {}`，应区分 `message is not modified`（忽略）/ `429`（跳过本次增量）/ `can't parse entities`（降级为纯文本重试一次）。
  4. `output.placeholderAfterMs`（占位消息）与 D17 的进度编辑一并接上。
- **验收**：AC-OUT-001…008。

---

### G-TG-04 · 多模态完全缺失（D16 未实现）

- **位置**：`packages/telegram/src/bot.ts`（无附件相关代码）；`attachments` 表存在但**从未写入**
- **文档依据**：D16；[08 §7](./08-telegram-adapter.md#7-多模态)；AC-TG-006/007/008/009。
- **现状**：`messageKind()` 能识别 photo/document/voice 等类型并写入 `messages.kind`，但没有文件下载、没有 `attachments` 行、没有文本抽取、没有图片归一化、没有 media group 去抖、没有 image part 注入。`config.media.*` 整块（15 个配置项）无效。非文本消息进上下文时只有 `renderArchivedMessage` 的 `[${kind}]` 占位（连 caption 都丢了 —— `text` 字段虽存了 caption，但 `message.text ?? '[kind]'` 在 caption 存在时会用 caption，这点是对的）。
- **修改指导**：按 [08 §7](./08-telegram-adapter.md#7-多模态) 补 `packages/telegram/src/media.ts`：`getFile` → 下载到 `media.dir/<chatId>/<fileUniqueId>.<ext>` → 写 `attachments` → 图片经 `sharp` 归一化到 `maxImageEdge` → 文档按 `media.extract.types` 抽取文本（pdf-parse / mammoth / 直读）→ `renderArchivedMessage` 产出带 `image` part 或 `<untrusted-content source="file:…">` 包裹的文本 part。media group 用 `groupDebounceMs` 去抖聚合为一条逻辑消息。
  同时 `prepareStep` 需按 [04 §5.2](./04-agents-and-providers.md#52-内建别名语义) 在含图片且当前模型无 vision 时切 `vision` 别名。
- **验收**：AC-TG-006…009、AC-PROV-009。

---

### G-TG-05 · 并发闸门 / 队列 / 超时未实现

- **位置**：`packages/telegram/src/bot.ts`（无相关代码）
- **文档依据**：[01 §3](./01-architecture.md#3-进程模型与并发)、[02 §3.6](./02-context-engine.md#36-并发限流)；`concurrency.*` 六个配置项。
- **现状**：`concurrency.mode/perKey/global/queueMax/coalesceSameUserMs/turnTimeoutMs` 全部未使用。每条触发消息立刻起一个 turn，无上限。活跃群里可以瞬间打满 provider 限流与预算。`mode='serial'`（文档中的「逃生舱」）无法启用。
- **修改指导**：新增 `packages/core/src/turn/concurrency.ts`：
  - `Semaphore(global)` + `Map<key, Semaphore(perKey)>` + FIFO 等待队列（长度 `queueMax`，超出回复「排队已满」）；
  - `mode==='serial'` 时 `perKey` 强制为 1；
  - `coalesceSameUserMs > 0` 时同用户窗口内的连续触发并入同一 delta；
  - 与 G-TG-02 的 `TurnRegistry`/超时共用一份状态，供 `/api/dashboard` 的 `inFlightTurns` 使用（当前硬编码 `0`）。
- **验收**：AC-CTX-028、AC-QUOTA-012、AC-WEB-006。

---

## 2. P1 —— 文档承诺但未实现 / 不完整

### 2.1 上下文引擎

| ID | 文档依据 | 现状 | 修改指导 |
|---|---|---|---|
| G-CTX-03 | [02 §5.4](./02-context-engine.md#54-硬天花板轮内临时裁剪d3-第二句) 轮内硬天花板 | `prepareStep` 只设 `activeTools` 与降档，无 `pruneMessages` | 在 `prepareStep` 中按 `modelInfo.contextWindow × hardCapRatio` 判定并调用 AI SDK 的 `pruneMessages`；记 `ctx.hardcap` 日志。**只改本次调用的 messages，不写库** |
| G-CTX-04 | [02 §3.3 情况 0](./02-context-engine.md#33-committurn-临界区-b) base 失效插入 note | `insertTurn` 未做该判定 | 提交时若 `head.kind==='reset'` 或 base 不在当前 HEAD 的祖先链上，在 delta 首部插入 `origin='note'` 的「上下文已被重置」说明（AC-CTX-020） |
| G-CTX-05 | [02 §5.5](./02-context-engine.md#55-token-估算与校准) EMA 校准 | `ContextEngine.calibrate()` 实现正确但**无人调用**；`contexts.token_ratio` 恒为 1.0 | 在 `UsageLedger.record` 之后用真实 `inputTokens` 与快照估算值调用 `calibrate`；估算处乘以 `token_ratio` |
| G-CTX-06 | [02 §6](./02-context-engine.md#6-物化与缓存) 物化 LRU 缓存 | 每次 `materialize` 都全量查库；`context.cacheCommits` 无效 | 加 `Map<commitId, MaterializedContext>` LRU；**prune 就地降级后必须失效该 key 的缓存** |
| G-CTX-07 | [02 §4.1](./02-context-engine.md#41-认领范围) 排除 blocked 发言人 | `claimBackground` 只过滤 `direction/from_kind/triggered`，不看角色 | SQL 加 `AND from_user_id NOT IN (SELECT tg_id FROM principals WHERE kind='user' AND role='blocked')` |
| G-CTX-08 | [03 §2.5](./03-data-model.md#25-上下文层核心) `tokens_total` 语义 | `insertControl`（prune/reset/manual）把 `tokens_total` 写 0，下一个 turn 从 0 累加 ⇒ commit 上的 token 统计长期失真（`/ctx`、WebUI、AC-CTX-027 受影响）| `insertControl` 按 `window_start..head_ordinal` 重新 `SUM(tokens)` 写入；`insertTurn` 同样重算而非增量累加 |

### 2.2 Agent 与 Provider

| ID | 文档依据 | 现状 | 修改指导 |
|---|---|---|---|
| G-AGENT-03 | [10 §1](./10-logging-and-observability.md#1-trace-模型) 每次模型调用一个 span | 只有 `usage_ledger` 行，**没有 `model.call` 日志事件**；`tool.call` span 也不挂 `parentSpanId` | 用 `ToolLoopAgent` 的 `onStepStart/onStepEnd/onToolExecutionStart/onToolExecutionEnd` 生成 span 树；`include:{requestMessages,requestBody,responseBody}` 已开启，把 body 按 `logs.captureBodies`/`bodyMaxBytes` 落 `logs/<date>/model.jsonl` 并写 `file_ref` |
| G-AGENT-04 | [04 §5.3](./04-agents-and-providers.md#53-fallback-与重试) | fallback/retry 在**最外层**包裹整个 `agent.generate()`。一次失败会**重跑整个工具循环**，已产生副作用的工具（写文件、执行命令、发消息）被重复执行 | 把 retry/fallback 下沉到 `LanguageModel` 层：用 `wrapLanguageModel` + 自建 `fallbackModel(chain)` 中间件（文档 §5.1 的写法），让 `ToolLoopAgent` 只构造一次 |
| G-AGENT-05 | [04 §2](./04-agents-and-providers.md#2-主-agent-装配) `usage` 归属 | `prepareStep` 降档到 `low` 后，记账仍写 `candidate.info`（原模型）⇒ 费用与模型统计错配 | 从 `onStepEnd` 事件里取实际使用的 model id 记账 |
| G-AGENT-06 | [04 §2.1](./04-agents-and-providers.md#21-prompt-缓存) prompt cache 断点 | 未实现；无 `providerOptions.anthropic.cacheControl` | 在 `instructions` 的稳定区末尾打断点；`usage_ledger` 已有 cacheRead/Write 列，接上即可（AC-PROMPT-005） |
| G-AGENT-07 | [11 §4](./11-config-reference.md#4-配置校验规则超出类型之外的约束)「`model_aliases` 缺 `main` → 拒绝启动」 | `ModelRegistry.resolve` 静默回退 main→high→low；启动不校验 | `main.ts` 在 `modelRegistry.rebuild()` 后校验 `aliases().includes('main')`，缺失则打印可操作提示并 `process.exit(1)`（AC-CFG-005、AC-WEB-014） |
| G-AGENT-08 | [04 §4](./04-agents-and-providers.md#4-agent-间通信) 双向通信 | `AgentManager.ask/answer` 只写表，**没有 Bus、没有阻塞等待、没有 rule/arbiter/user/timeout 四级应答**；`ask_parent`/`report_progress` 工具未注册 | 与 G-AGENT-01 一并实现 `AgentBus`。注意 `answer()` 当前会 `UPDATE ... SET kind='answer'` **覆盖原 ask 行**，问题文本丢失 —— 应插入新行并用 `answered_at` 关联 |

### 2.3 工具

| ID | 文档依据 | 现状 | 修改指导 |
|---|---|---|---|
| G-TOOL-02 | [05 §3](./05-tools-and-permissions.md#3-工具目录) 33 项 | `TOOL_POLICY` 有 33 条，`registerBuiltins` 只注册 **19** 个。缺：`glob` `grep` `memory_list` `read_agent_result` `ask_parent` `report_progress` `set_model` `web_search` `send_message` `send_photo` `react` `send_file` `pin_message` | 补齐；`grep` 优先用 ripgrep，缺失时回退 JS 实现。**AC-TOOL-001（策略表↔文档一致性）会通过，但策略表↔实现一致性没人检查** —— 补一条 CI 断言：`Object.keys(TOOL_POLICY)` 与注册表 key 集合相等 |
| G-TOOL-03 | [05 §3.2](./05-tools-and-permissions.md#32-聊天记录检索) | `read_messages` 只有 `limit`，无 `anchor`/`direction`；`search_messages` 无 `from`/`after`/`before`/`kind`；返回原始行而非文档的 `#id [时间] 发言人: 正文` 格式 | 按文档补参数与渲染格式（AC-TOOL-011） |
| G-TOOL-04 | [05 §8](./05-tools-and-permissions.md#8-toolregistry-执行包装统一横切) 第 9 步 | `registry.execute` 不做输出裁剪、不做 `<untrusted-content>` 包裹（`RegisteredTool.untrustedOutput` 字段**声明了但从未被读取**）。仅 `web_fetch` 在自己内部包了 | 在 `execute` 统一处理：按 `tools.exec.maxOutputBytes` 裁剪 + `untrustedOutput` 为真时用 `untrusted()` 包裹（`@luoli/shared` 已有该 helper）。`read_file` 也应标记为 untrusted（AC-SEC-004） |
| G-TOOL-05 | [05 §8](./05-tools-and-permissions.md#8-toolregistry-执行包装统一横切) 第 5 步 | `state.calls += 1` 发生在 schema 校验与审批**之前** ⇒ 参数写错的调用也消耗配额 | 移到实际执行前 |
| G-TOOL-06 | [05 §3.6](./05-tools-and-permissions.md#36-网络) | `web.allowlist`/`denylist` 未实现；`limited` 角色未受限；无 `prompt` 摘要参数与 HTML→markdown | 补齐；allowlist 为空时对 `limited` 不注册 `web_fetch` |

### 2.4 记忆

| ID | 文档依据 | 现状 | 修改指导 |
|---|---|---|---|
| G-MEM-02 | [06 §5.2](./06-prompt-and-memory.md#52-自动压缩) | `flush()` 里所谓「压缩」只是把**当前全文原样**复制到 `.pending/`，没有模型调用、没有合并去重 | 用 `low` 别名做真正的压缩调用；`autoApplyCompaction=false` 时只写 `.pending/` 并在 WebUI 出待审 diff |
| G-MEM-03 | [06 §4](./06-prompt-and-memory.md#4-记忆文件格式) | `flush()` 的 section 插入逻辑用字符串 `indexOf('\n## ')` 拼接，未做 `maxSections` 限制，重复 section 会插到错误位置 | 改为解析成 `{sections: Map}` 结构后重新序列化 |
| G-MEM-04 | [06 §5.3](./06-prompt-and-memory.md#53-隐私细节) | `/memory`、`/forgetme` 未实现；owner 读他人私有记忆无 warn 日志 | 补齐（AC-MEM-011/012） |
| G-MEM-05 | [03 §2.10](./03-data-model.md#210-扩展与记忆) | `memory_revisions.diff` 写的是 `-<全文>\n+<全文>`，不是 unified diff；大记忆文件会让该表迅速膨胀 | 用 `diff` 库生成 unified diff |

### 2.5 扩展生态

| ID | 文档依据 | 现状 | 修改指导 |
|---|---|---|---|
| G-EXT-01 | [07 §2.2](./07-skills-plugins-mcp.md#22-渐进式披露progressive-disclosure) | `SkillLoader` 实现完整（frontmatter zod 校验、失败隔离、`skill://` 解析、DB 持久化），但 **`catalog()` 从未被调用** —— skill 的 name/description 不进系统提示词，模型无从知道有哪些 skill | `runMainAgent` 的 catalog 拼接处加入 `skills.catalog(role)`（AC-SKL-001） |
| G-EXT-02 | [07 §2.2](./07-skills-plugins-mcp.md#22-渐进式披露progressive-disclosure) | `load_skill` 返回 `allowedTools` 但**没有任何地方消费它** ⇒ skill 的 `allowed-tools` 收窄不生效；skill 正文也未作为 `origin='note'` 进 delta | 在 `TurnCtx` 上加 `loadedSkills`，`prepareStep` 计算 `activeTools = 角色白名单 ∩ (⋃ skill.allowedTools ∪ 核心集)`；正文写入 delta（`pruneLevel: 2`） |
| G-EXT-03 | [07 §2.3](./07-skills-plugins-mcp.md#23-加载与热更新)、§3.2 | `skills.watch` / `plugins.watch` 未实现（无 chokidar 依赖）；`read_file` 不接受 `skill://` | 补 watch 与 `skill://` 前缀路由（AC-SKL-007/008） |
| G-EXT-04 | [07 §3.3](./07-skills-plugins-mcp.md#33-hook-执行顺序与并发) | `PluginManager.hook()` 写得不错（超时、崩溃隔离、自动禁用），但**整条管线里没有一处调用它**；plugin 的 `tools`/`commands`/`agents` 也未注册进 `ToolRegistry`；`plugins.order` 未实现 | 在 Update→归档→turn→模型→工具→输出→commit 的各节点插入 `plugins.hook(...)`；启用时把 plugin tools 注册进 `ToolRegistry`（`sourcePriority` 低于 builtin） |
| G-EXT-05 | [07 §4](./07-skills-plugins-mcp.md#4-mcp) | **MCP 完全缺失**：无 `packages/core/src/mcp`，`config.mcp.servers` 无效，`mcp_servers` 表空置 | 需要注意：**`ai@7.0.65` 并不导出 `experimental_createMCPClient`**（文档 07 §4.2 的示例基于早期版本，见 §4 文档勘误）。实现应直接用 `@modelcontextprotocol/sdk` 的 Client + StdioClientTransport/StreamableHTTPClientTransport，再把 `listTools()` 结果适配成 AI SDK `tool()`，并套用文档要求的角色/超时/untrusted 包裹/日志 |

### 2.6 Telegram

| ID | 文档依据 | 现状 | 修改指导 |
|---|---|---|---|
| G-TG-06 | [08 §1](./08-telegram-adapter.md#1-bot-初始化) | 无 `autoRetry`、无 `apiThrottler`、无 logging transformer；webhook 模式未实现（`telegram.mode='webhook'` 时 bot 根本不启动）；`dropPendingOnStart` 未使用 | 按文档补齐；webhook 用 `webhookCallback(bot,'hono')` 挂到 server，校验 secret token |
| G-TG-07 | [08 §2.3](./08-telegram-adapter.md#23-my_chat_member) / §3 | `edited_message`、`my_chat_member`、`callback_query` 均在 `allowedUpdates` 里申报但**无处理器**。被拉进新群不通知 owner；消息编辑不写 revision | 补三个处理器（AC-TG-010/011） |
| G-TG-08 | [08 §4](./08-telegram-adapter.md#4-触发判定) | `matchTrigger` 缺 `command` 归属校验（任意 `/xxx` 都算触发）、`channels`、`cooldownMsPerUser`、`ignoreEditedAsTrigger`、`perChat` 唤醒词覆盖；`wakewordMinLength` 未用；正则未加超时保护（ReDoS） | 按文档补齐；命令需匹配 bot 自己的命令集与 `@username` 后缀（`strictCommandSuffix`） |
| G-TG-09 | [08 §5.2](./08-telegram-adapter.md#52-流式算法) | `splitTelegramText` 在 `safeRender` **之前**切分。MarkdownV2 转义会让长度翻倍，3900 字的片段转义后可能超 4096 → Telegram 400 | 先 `safeRender` 再按渲染后长度切分，或切分后校验渲染长度并回退切点 |
| G-TG-10 | [08 §9](./08-telegram-adapter.md#9-错误呈现) | 只有「出了点问题」一种文案；配额/排队/权限/上下文过大等分支缺失 | 按文档的错误文案表补齐 |

### 2.7 日志 / WebUI / 运维

| ID | 文档依据 | 现状 | 修改指导 |
|---|---|---|---|
| G-LOG-02 | [10 §3](./10-logging-and-observability.md#3-落盘格式) | `logs.level` 未生效（debug 事件也全量落盘）；无按 `maxFileMb` 轮转、无 gzip、无 `bodyMaxBytes` 分离与 `file_ref`；`appendFileSync` 逐条同步写 | 加 level 过滤 + 缓冲写（200ms/64KB flush）+ 轮转 + 大 payload 分离 |
| G-LOG-03 | [10 §2](./10-logging-and-observability.md#2-事件种类log_eventskind-枚举) 40+ 种事件 | 实际只产出约 8 种（`tg.error` `access.denied` `turn.end` `provider.fallback` `tool.call` `approval.*` `system.*` `webui.action`）。`ctx.open/commit/rebase/prune/hardcap`、`model.call`、`quota.*`、`memory.*`、`skill.load`、`trigger.*` 全缺 | 按枚举补齐 —— 这是 WebUI Trace 视图与 AC-LOG-001 的前提 |
| G-WEB-01 | [09 §3](./09-webui.md#3-页面清单) 13 个页面 | 只有 `ConsoleView.vue`（112 行）与 `LoginView.vue`。上下文查看器、Commit 时间线、Trace 树、提示词编辑、Provider 管理、权限矩阵、用量报表、审批队列、配置表单全部没有 | 按文档补齐；优先 Trace 视图与上下文查看器（它们是排查 P0 问题的工具） |
| G-WEB-02 | [09 §4](./09-webui.md#4-rest-api) | `PUT /api/config` **不做任何 zod 校验**就写 `config_kv`。写入非法值（如 `context.limit.tokens=1`）会导致下次启动被 schema 拒绝 ⇒ **通过 WebUI 可以把 bot 写死** | 写入前用 `configSchema.safeParse(合并后的完整配置)`；失败返回 400 与具体路径；同时补 `/api/config` 的敏感字段过滤 |
| G-WEB-03 | [09 §4](./09-webui.md#4-rest-api) | 约 30 个端点缺失（chats PATCH/checkout、messages/:id、files、prompts 读写与回滚与 preview、providers test/PATCH/DELETE、principals/bulk、tools PATCH、sandbox、skills/plugins/mcp 写操作与 reload、agents CRUD/dryrun、logs/trace、logs/blob、quota、tasks/cancel、gc-files）；无分页信封 `{items,total,page,size}` | 按文档补齐 |
| G-OPS-01 | [11 §3](./11-config-reference.md#3-热更新实现要点) | `PUT /api/config` 发 `config.changed` 事件，但**没有任何订阅者**；`ConfigStore` 类已写好却从未实例化 ⇒ **热更新完全不生效**，AC-CFG-009 失败 | `main.ts` 用 `ConfigStore` 持有配置，订阅 `config.changed` → 重新 `loadConfig` → `replace()` → 按 key 前缀分发（registry.rebuild / skills.rescan / plugins.reconcile / log.setLevel） |
| G-OPS-02 | [01 §3](./01-architecture.md#3-进程模型与并发) 优雅退出 | `shutdown()` 立即 `bot.stop()` + `http.close()` + `closeDatabase()`，**不等在途 turn**，`general.shutdown.graceMs` 未使用 ⇒ 重启会截断正在进行的对话 | 停止拉取新 update → 等待 `TurnRegistry` 清空至 `graceMs` → 超时则 abort 并标 `cancelled` → 再关闭 |
| G-OPS-03 | [03 §4](./03-data-model.md#4-保留与清理后台定时任务) | `MaintenanceService` 实现完整但**从不被调度**；`general.maintenanceCron`、`db.vacuumCron`、`memory.compactCron`、`provider.healthCheckCron`、`mcp.healthCheckCron` 五个 cron 配置全部无效 | 引入轻量调度器（`croner`/`node-cron`）在 `main.ts` 注册 |
| G-OPS-04 | AC-DB-005 | 迁移前不做备份 | `migrateDatabase` 在应用第一条未执行迁移前调用 `VACUUM INTO data/backup/luoli-<ts>-pre-<NNNN>.db` |

---

## 3. P2 —— 健壮性与一致性

| ID | 位置 | 问题 | 建议 |
|---|---|---|---|
| G-P2-01 | `db/src/database.ts:21`、`server/src/app.ts:208` | `resolve('packages/db/migrations')` 与 `resolve('packages/webui/dist')` 都是 **CWD 相对路径**，从其它目录或 Docker 里启动即失效 | 用 `import.meta.url` 推导包内路径 |
| G-P2-02 | `core/src/sandbox/index.ts:35` | `clipped()` 用 `Buffer.subarray().toString()` 截断，会切断多字节 UTF-8 产生乱码 | 按字符截断，或用 `TextDecoder({stream:true})` |
| G-P2-03 | `core/src/sandbox/index.ts:72` | `abortSignal.addEventListener` 未先检查 `aborted`；已取消的 turn 仍会起容器 | 首行 `if (abortSignal.aborted) return killedResult` |
| G-P2-04 | `core/src/sandbox/index.ts:59` | jail 模式用 `sh -lc`（**登录 shell**）会 source profile，可能重新引入被过滤掉的环境变量；且没有文档 §5.4 要求的 `ulimit -v/-t/-f/-u` | 改 `sh -c` 并包一层 `ulimit ...; exec ...` |
| G-P2-05 | `core/src/tools/jail.ts:23` | `absolute.replace(parent, realParent)` 用字符串替换，替换的是**首次出现**而非前缀，路径含重复片段时会错 | 改 `realParent + absolute.slice(parent.length)` |
| G-P2-06 | `core/src/tools/files.ts` | 忽略 `tools.fs.trashDir`/`backupDir`/`showHidden` 配置（硬编码 `.luoli-trash`/`.luoli-bak`）；`read()` 按字节切分可能截断多字节字符 | 读配置；按字符或行分页 |
| G-P2-07 | `db/src/archive.ts:96` | `claimBackground` 用 `id BETWEEN first AND last` 标记 `claimed_at`，会把区间内**未被认领**的行（bot 消息、触发消息）也标成已认领 | 改为按实际 id 列表更新 |
| G-P2-08 | `db/src/archive.ts:79` | FTS 分支用 `columns.replaceAll(',', ',m.')` 拼列名，依赖「SQLite 允许 `m.` 与列名间有空白」这一冷门行为 | 显式写出带前缀的列表 |
| G-P2-09 | `db/src/archive.ts:55` | `append()` 无 `ON CONFLICT`，与 `ux_messages_tg(chat_id,tg_message_id,revision)` 撞车时抛异常，会整条 turn 失败 | 加 `ON CONFLICT DO NOTHING` + 回查 |
| G-P2-10 | `core/src/agent/manager.ts:71` | `truncated: summary.length < result.length` 混用码点切分与 UTF-16 长度 | 统一用 `[...str].length` |
| G-P2-11 | `core/src/prompt/assembler.ts:76` + `runtimeBlock` | RUNTIME 块被套两层标题（`=== RUNTIME ===` + `=== 运行时 ===`）；`quota` 参数从未传入，`prompt.runtimeBlock.showQuota` 无效 | 去掉重复标题；接上额度显示 |
| G-P2-12 | `telegram/src/bot.ts:47,51` | `/ctx`、`/tasks` 直接把 JSON 塞进 MarkdownV2 代码块返回给用户 | 按文档 [08 §8](./08-telegram-adapter.md#8-命令) 渲染为人类可读摘要 |
| G-P2-13 | `server/src/app.ts:51` | 安全响应头在 `await next()` **之后**设置，对 SSE 等流式响应可能已发出头 | 改为在 next 之前设置 |
| G-P2-14 | `server/src/app.ts:75` | Set-Cookie 缺 `Secure`（即使 https） | 按 `x-forwarded-proto`/配置补 |
| G-P2-15 | `tests/` | 20 条用例 vs 文档 253 条 AC（覆盖率 ~8%）。裁剪、背景认领、blocked 归档、并发配额、记忆越权、工具白名单等关键路径**无测试** —— 本次三个 P0 缺陷都是现有测试无法发现的 | 见 [16 §3](./16-remediation-plan.md#3-回归测试补充清单) |
| G-P2-16 | `core/src/tools/registry.ts:54` | `maxRegistered` 用 `slice` 截断但不记 warn 日志，也不按文档的「内建>agent>plugin>skill>MCP」优先级（当前按 `sourcePriority` 数字，语义相近但未覆盖 skill/mcp） | 补日志与显式优先级常量 |
| G-P2-17 | `core/src/context/engine.ts:37` | `escapeForgedSpeakerPrefixes` 只处理 `[名字 HH:MM]` 形态，不覆盖 `↩︎回复 #12` 这类系统标记 | 扩展正则 |
| G-P2-18 | `core/src/ledger/quota.ts:53` | `commit()` 里 `Math.min(reservation.amount, actualUsd)` 在多次 commit 场景下会低估应释放的预留 | 与 G-QUOTA-01 一并重构为「每次调用 commit 增量」 |
| G-P2-19 | `apps/bot/src/main.ts:13` | 变量名 `configPath` 实为 DB 路径，且在 `loadConfig` 之前用硬编码默认值读 `config_kv`，与 `config.db.path` 可能不一致 | 重命名并统一路径来源 |

---

## 4. 文档侧勘误（文档写错，应改文档而非代码）

| 位置 | 问题 | 更正 |
|---|---|---|
| [07 §4.2](./07-skills-plugins-mcp.md#42-接入实现) | 示例 `import { experimental_createMCPClient as createMCPClient } from 'ai'`。**`ai@7.0.65` 未导出任何 MCP 符号**（已核验 `Object.keys(import('ai'))`） | 改为基于 `@modelcontextprotocol/sdk` 的 `Client` + `StdioClientTransport`/`StreamableHTTPClientTransport`，自行适配为 AI SDK `tool()`；并注明「若后续 AI SDK 恢复导出 MCP client，可切换」 |
| [02 §3.3](./02-context-engine.md#33-committurn-临界区-b) | 伪代码 `rows.forEach(r => { ... [ (await repo.getCommit(...))?.head_ordinal ...] })` —— 在非 async 回调里用 `await`，无法运行 | 改为先 `const base = await repo.getCommit(t.baseCommitId)` 再进入 `forEach`；并把 `skipped` 的 `await` 提到 `forEach` 之前 |
| [04 §2](./04-agents-and-providers.md#2-主-agent-装配) | 用了 `isStepCount(n)`。该导出在 `ai@7.0.65` **存在**，但当前实现用的是同义的 `stepCountIs(n)` | 两者皆可；在文档补一句「`ai` v7 同时导出 `isStepCount` 与 `stepCountIs`，实现统一用 `stepCountIs`」 |
| [04 §2](./04-agents-and-providers.md#2-主-agent-装配) | 未提到 `ToolLoopAgent` 的 `include: { requestMessages, requestBody, responseBody }` 选项 —— 这正是 [10 §7](./10-logging-and-observability.md#7-可观测性验收要点) 要求「能看到完整请求消息」的实现手段，实现里已用上 | 在文档补充该选项与 `logs.captureBodies` 的对应关系 |
| [13](./13-acceptance-criteria.md) AC-TOOL-001 | 只校验「`TOOL_POLICY` ↔ 文档矩阵」一致，未校验「`TOOL_POLICY` ↔ 实际注册工具」一致 —— 本次 13 个工具缺失正好从这个缝里漏过 | 拆成 AC-TOOL-001a（策略↔文档）与 AC-TOOL-001b（策略↔注册表），后者标 ★ |

---

## 5. 做得好的部分（保持，勿在重构中破坏）

1. **两层上下文结构与 rebase 语义完全正确**：`ordinal` 确实只在 `commitTurn` 内分配（`appendDelta` 有显式断言）；`insertTurn` 在单个 `db.transaction` 内完成「读 HEAD → 分配 ordinal → 写消息 → 写 commit → 移 ref」，`KeyedMutex` 是正确的 FIFO 实现。D1 的「完成顺序决定历史顺序」有对应测试并通过。
2. **裁剪不删数据**：`markPruned` 只置 `prune_applied=1`，`materialize` 时替换内容，原文保留 —— 红线 5 遵守。
3. **`resolveEffectiveRole` 取交集正确**，私聊继承用户角色的规则与文档一致。
4. **数据模型 27 张表、索引、FTS5 trigram、触发器与文档 03 逐条吻合**；`recoverAfterCrash` 正确实现了「重启标记残留 running 为 failed + reserved 归零」（AC-OPS-001、AC-QUOTA-010）。
5. **配置 schema 与文档 11 高度一致**，`superRefine` 实现了 perChat 白名单、perKey≤global、webui 绑定校验等文档要求的额外规则。
6. **`Secrets` 的 AES-256-GCM 实现与 `v1.<iv>.<ct>.<tag>` 格式正确**；provider key 从不回传前端（`list()` 只出 hint）。
7. **SSRF 防护扎实**：DNS 解析后逐跳校验，覆盖 IPv4 私网/回环/link-local/CGNAT 与 IPv6 ULA/link-local（AC-TOOL-012/013 通过）。
8. **`PathJail`**：realpath 解析、前缀比对、denyGlobs、symlink 二次校验齐全（AC-TOOL-003/004/005 通过）。
9. **`SkillLoader`** 的 frontmatter zod 校验、目录名一致性检查、解析失败隔离（坏 skill 不影响其它）、DB 持久化都符合文档 —— 只差接线。
10. **WebUI 鉴权链**：session + CSRF + 登录限流 + CSP/XFO/nosniff 响应头，与文档 09 §2/§7 一致（AC-WEB-002/003/004/020 通过）。
11. **`UsageLedger`** 四类 token 分别计价、失败调用也落账、同事务更新 `turns.cost_usd` —— AC-LOG-004 的「求和相等」成立。
12. `tsc --noEmit` 零错误，代码风格统一，无 `any` 泛滥，错误对象结构化（`{ok:false,error}`）—— 基础工程质量好。

---

## 6. 差异清单速查（按文件）

| 文件 | 涉及缺陷 |
|---|---|
| `packages/core/src/context/engine.ts` | **G-CTX-01**、**G-CTX-02**、G-CTX-04/05/06、G-P2-17 |
| `packages/db/src/context.ts` | G-CTX-01（新增 `turnStartOrdinals`）、G-CTX-08 |
| `packages/db/src/archive.ts` | G-CTX-07、G-P2-07/08/09 |
| `packages/core/src/memory/store.ts` | **G-MEM-01**、G-MEM-02/03/05 |
| `packages/core/src/secrets.ts` | **G-LOG-01** |
| `packages/core/src/agent/runtime.ts` | **G-AGENT-02**、G-AGENT-03/04/05/06、G-CTX-03、G-EXT-01 |
| `packages/core/src/agent/manager.ts` | G-AGENT-08、G-P2-10 |
| `packages/core/src/tools/builtins.ts` | **G-AGENT-01**、**G-MEM-01**、G-TOOL-02/03/06 |
| `packages/core/src/tools/registry.ts` | **G-TOOL-01**、**G-SBX-01**、G-TOOL-04/05、G-P2-16 |
| `packages/core/src/approvals.ts` | **G-APV-01**、G-TOOL-01 |
| `packages/core/src/sandbox/index.ts` | **G-SBX-01**、G-P2-02/03/04 |
| `packages/core/src/ledger/quota.ts` | **G-QUOTA-01**、G-P2-18 |
| `packages/core/src/log/sink.ts` | G-LOG-02/03 |
| `packages/core/src/plugins/manager.ts` | G-EXT-04 |
| `packages/core/src/skills/loader.ts` | G-EXT-01/02/03（加载器本身无缺陷，缺的是接线） |
| `packages/core/src/prompt/assembler.ts` | G-AGENT-06、G-P2-11 |
| `packages/telegram/src/bot.ts` | **G-TG-01**、**G-TG-02**、**G-TG-03**、**G-TG-04**、**G-TG-05**、G-TG-06/07/10、G-P2-12 |
| `packages/telegram/src/trigger.ts` | G-TG-08 |
| `packages/telegram/src/output.ts` | G-TG-09 |
| `packages/telegram/src/stream-output.ts` | G-TG-03（两处逻辑缺陷） |
| `packages/server/src/app.ts` | G-WEB-02/03、G-P2-01/13/14 |
| `packages/webui/src/` | G-WEB-01 |
| `apps/bot/src/main.ts` | G-AGENT-07、G-OPS-01/02/03、G-P2-19 |
| `packages/db/src/database.ts` | G-OPS-04、G-P2-01 |
| （不存在）`packages/core/src/mcp/` | G-EXT-05 |
| `tests/` | G-P2-15 |

修复顺序与回归清单见 [16-remediation-plan.md](./16-remediation-plan.md)。
