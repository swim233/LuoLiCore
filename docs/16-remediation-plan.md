# 16 · 修复计划与回归验收

配套文档：[15-gap-review.md](./15-gap-review.md)（差异清单与逐条修改指导）。
本文只回答三个问题：**先修什么、怎么验证修好了、什么时候可以宣布验收通过**。

---

## 1. 修复批次

批次之间有依赖，**不要并行做 R0 和 R1**（R1 依赖 R0 修好的上下文语义）。每批结束必须跑完「出口条件」才进下一批。

### R0 · 止血（0.5–1 天）★ 先做

只做「改动小、风险高、不改架构」的六处。目标是让当前这版**在有人用的情况下不出事**。

| 顺序 | 缺陷 | 改动量 | 说明 |
|---|---|---|---|
| 1 | **G-MEM-01** 群聊读私有记忆 | ~15 行 | 隐私泄露，最高优先级 |
| 2 | **G-TG-01** 命令绕过准入网关 | ~40 行 | 陌生人可清空任意会话上下文 |
| 3 | **G-AGENT-01** `spawn_agent` 伪造完成 | 1 行（先摘除注册） | 完整实现放到 R3；**在那之前必须摘掉**，返回伪结果比没有更糟 |
| 4 | **G-TOOL-01 + G-APV-01** 审批失效 / 语义反转 | ~60 行 | `bash("rm -rf …")` 当前无人把关 |
| 5 | **G-SBX-01** 沙箱 fail-closed | ~20 行 | 加 `available()` 谓词即可，docker 探测放 R2 |
| 6 | **G-LOG-01** 脱敏抹掉上下文键 | ~5 行 | 日志可用性 |

**出口条件**
- 新增用例：群聊 `memory_read('primemory')` 抛 `private_memory_forbidden`；
- 新增用例：`blocked` 用户 `/new` 无效且上下文不变；
- 新增用例：`approval.enabled=false` 时 `delete_file` 可执行；`enabled=true` 且命中 `rm -rf` 规则时 `bash` 产生 pending 审批；
- 新增用例：`sandbox.mode='none'` 时 `activeTools` 不含 `bash`/`python`（trusted），含（owner）；
- 新增用例：`redact` 保留 `key`/`chatId`/`traceId`，仍脱敏 bot token 与 `sk-`；
- 原有 20 条用例保持通过，`tsc --noEmit` 零错误。

---

### R1 · 上下文引擎正确性（1–2 天）

| 缺陷 | 说明 |
|---|---|
| **G-CTX-01** 裁剪窗口落在 turn 中间 | 新增 `ContextRepository.turnStartOrdinals()`，重写 `prune` 步骤 1；补步骤 3 硬截断 |
| **G-CTX-02** 私聊前缀 | `isPrivate` 显式贯穿 `OpenTurnRequest` → `RuntimeTurnContext`；删除三处 `chatId === userId` 推断 |
| G-CTX-04 | base 失效时插入 note |
| G-CTX-07 | 背景认领排除 blocked 发言人 |
| G-CTX-08 | commit 的 `tokens_total` 改为重算 |
| G-CTX-05 / G-CTX-06 | 接上 token 校准；物化 LRU 缓存（prune 后失效） |

**出口条件**
- AC-CTX-001…028 **全部**有对应自动化用例并通过（当前只有 3 条）；
- 关键断言：`window_start ∈ turnStartOrdinals(key)`；窗口内不存在缺配对 `tool_call` 的 `tool` 消息；
- 私聊 delta 无 `[名字 HH:MM]` 前缀；
- 100 轮 × 大消息的裁剪压测：`tokens ≤ limit` 恒成立，`context_messages` 行数只增不减。

---

### R2 · Agent 与模型调用链（2–3 天）

| 缺陷 | 说明 |
|---|---|
| **G-AGENT-02** 消息压平 | `contextMessages` 直接透传 parts；写入端按真实语义写 tool-call/tool-result/image part |
| G-AGENT-04 | retry/fallback 下沉到 `wrapLanguageModel` 中间件，`ToolLoopAgent` 只构造一次（当前重跑整个工具循环会重复副作用） |
| G-AGENT-03 | 用生命周期回调产出 `model.call`/`tool.call` span 树（含 `parentSpanId`），body 按 `captureBodies` 落盘 |
| G-AGENT-05 | 降档后按实际模型记账 |
| G-AGENT-06 | prompt cache 断点 |
| G-AGENT-07 | 启动校验 `main` 别名缺失（后改为告警不阻塞启动，见 [04 §5.2](./04-agents-and-providers.md#52-内建别名语义)） |
| G-CTX-03 | `prepareStep` 硬天花板 `pruneMessages` |
| **G-QUOTA-01** | 预留估算 ×1.5、每次模型调用后 commit、`prepareStep` 里的 `canSpend`、`perTurn.*`、`rateLimit`、80% 提示、`requirePricing` |

**出口条件**
- AC-AGENT-001…008、AC-PROV-001…009、AC-PROMPT-001…006、AC-QUOTA-001…012；
- 重点：**AC-QUOTA-002**（额度够 2 个、并发 5 个 → 恰好 2 个执行）；
- 重点：**AC-LOG-001/002/004**（trace 树可重建、能看到完整请求 messages、费用求和相等）；
- 重点：新增用例 —— provider 首次失败后重试，**已执行过的工具不被重复调用**。

---

### R3 · Subagent、任务、取消（2–3 天）

| 缺陷 | 说明 |
|---|---|
| **G-AGENT-01** | 真正实现 `runSubAgent`（独立上下文、独立工具集、`toModelOutput` 摘要回灌、usage 归属同 turn） |
| G-AGENT-08 | `AgentBus`：`ask/answer/progress/result`，rule → arbiter → user → timeout 四级；`answer` 插入新行而非覆盖 ask |
| **G-TG-02** | `TurnRegistry` + 真实 `AbortController` + `turnTimeoutMs` + `/cancel` + inline 取消按钮 + 容器名含 turnId |
| **G-TG-05** | 并发闸门/队列/`mode='serial'`/`coalesceSameUserMs` |
| G-TOOL-02（部分） | `read_agent_result`、`ask_parent`、`report_progress`、`set_model` |

**出口条件**：AC-SUB-001…013、AC-TASK-001…008、AC-CTX-022、AC-CTX-028。
重点：取消后 `docker ps` 无残留 `luoli-sbx-*`；子 agent 的完整 transcript **不进** `context_messages`。

---

### R4 · Telegram 完整性（2–3 天）

| 缺陷 | 说明 |
|---|---|
| **G-TG-03** | 流式输出接线 + `TelegramOutput.consume` 的两处逻辑缺陷 |
| **G-TG-04** | 多模态：下载、`attachments`、抽取、图片归一化、media group 去抖、image part、vision 别名切换 |
| G-TG-06 | autoRetry / throttler / logging transformer / webhook 模式 / `dropPendingOnStart` |
| G-TG-07 | `edited_message` / `my_chat_member` / `callback_query` |
| G-TG-08 | 触发判定补全（命令归属、channels、cooldown、perChat 唤醒词、正则保护） |
| G-TG-09 | 先渲染后切分 |
| G-TG-10 | 错误文案分支 |
| G-TOOL-02（其余） | `glob` `grep` `web_search` `send_message` `send_photo` `react` `send_file` `pin_message` `memory_list` |
| G-TOOL-03/04/05/06 | 检索参数、输出裁剪与 untrusted 包裹、计数时机、web allowlist |

**出口条件**：AC-TG-001…011、AC-OUT-001…008、AC-TOOL-001…020（含新增的 001b）、AC-SEC-003/004。

---

### R5 · 记忆、扩展生态、运维（2–3 天）

| 缺陷 | 说明 |
|---|---|
| G-MEM-02/03/04/05 | 真压缩、section 结构化、`/memory` `/forgetme`、owner 读私有记忆告警、unified diff |
| G-EXT-01/02/03 | Skill catalog 进提示词、`allowed-tools` 生效、watch、`skill://` |
| G-EXT-04 | Plugin hook 接线 + plugin 工具注册 + `plugins.order` |
| G-EXT-05 | MCP（用 `@modelcontextprotocol/sdk`，见 [15 §4](./15-gap-review.md#4-文档侧勘误文档写错应改文档而非代码) 勘误） |
| G-OPS-01/02/03/04 | 热更新接线、优雅退出等待、cron 调度、迁移前备份 |
| G-LOG-02/03 | level 过滤、缓冲写、轮转、大 payload 分离、40+ 事件补齐 |

**出口条件**：AC-MEM-001…013、AC-SKL-001…008、AC-PLG-001…008、AC-MCP-001…008、AC-LOG-001…011、AC-CFG-009/010、AC-OPS-002/003。

---

### R6 · WebUI 与收尾（3–5 天）

| 缺陷 | 说明 |
|---|---|
| **G-WEB-02** | `PUT /api/config` 加 zod 校验（当前可通过 WebUI 把 bot 写死） |
| G-WEB-03 | 补齐约 30 个缺失端点 + 分页信封 |
| G-WEB-01 | 13 个页面。**优先做 Trace 视图与上下文查看器** —— 它们是排查前面所有问题的工具 |
| G-P2-* | 19 条健壮性问题 |

**出口条件**：AC-WEB-001…021、AC-SEC-001…012、AC-OPS-001…008，以及 [13](./13-acceptance-criteria.md) 的整体通过条件。

---

## 2. 建议节奏

```
R0 止血 ──► R1 上下文 ──► R2 Agent/配额 ──► R3 Subagent/取消 ──► R4 Telegram ──► R5 记忆/扩展/运维 ──► R6 WebUI
 0.5–1d      1–2d          2–3d              2–3d                2–3d           2–3d                3–5d
```

合计约 **13–20 人日**。若要缩短：R6 的 WebUI 页面可以只做 Trace 视图 + 上下文查看器 + 配置校验（约 1.5 天），其余页面延后 —— 但 **G-WEB-02 的配置校验必须做**，它是可用性风险。

---

## 3. 回归测试补充清单

当前 20 条用例覆盖约 8% 的 AC，**本次三个 P0 缺陷全部是现有测试无法发现的**。按批次补充，优先级从高到低：

### 必须补（P0 相关，随 R0/R1 一起提交）

| 用例 | 断言要点 |
|---|---|
| `context.prune.test.ts` | 构造 10 轮（trigger+tool_call+tool_result），触发裁剪后 `window_start ∈ turnStartOrdinals`；窗口首条不是 `tool` role；窗口内 `tool_result` 都有配对 `tool_call` |
| `context.prune.test.ts` | 单个超大 turn → 分级 prune（level 2 → 1）→ 硬截断；最终 `tokens ≤ limit`；`context_messages` 行数不变 |
| `context.private.test.ts` | 私聊 delta 任一条都不匹配 `/^\[.+ \d{2}:\d{2}\]/`；群聊 delta 的背景消息**必须**匹配 |
| `context.background.test.ts` | `maxPerTurn=3` + 10 条背景 → 只认领最新 3 条 + 一条 `origin='note'`；`claim_watermark` 单调；失败 turn 不回退水位 |
| `context.background.test.ts` | blocked 发言人的消息不进 delta，但仍在 `messages` 中 |
| `memory.isolation.test.ts` | 群聊 `read('primemory', …)` 抛错；私聊本人可读；owner 可读他人且产生 `memory.owner_read_private` warn |
| `memory.isolation.test.ts` | 群聊注册的 `memory_write.inputSchema` 的 scope 枚举**不含** `primemory` |
| `access.commands.test.ts` | blocked/limited 用户执行 `/new` `/undo` `/grant` 全部被拒且状态不变 |
| `approval.rules.test.ts` | `rm -rf` 命中规则 → pending；`ls` 不命中 → 直接执行；`enabled=false` → 直接执行；owner + `skipForOwner` → auto_approved |
| `sandbox.failclosed.test.ts` | `mode='none'`：trusted 的 `activeTools` 无 `bash`，owner 有；`mode='docker'` 且 docker 不可用时同理 |
| `secrets.redact.test.ts` | `key`/`chatId`/`traceId` 保留；`apiKey`/`api_key`/`token` 被脱敏；bot token 与 `sk-` 正则仍生效 |

### 应该补（随 R2/R3）

| 用例 | 断言要点 |
|---|---|
| `agent.messages.test.ts` | 发给 provider 的 `messages` 中 tool 消息 role 为 `'tool'`、含 `tool-result` part；图片轮次含 `image` part；`instructions` 不在 `messages[0]` |
| `agent.retry.test.ts` | 首个 provider 失败重试时，已执行的工具**不被重复调用**（用计数 mock） |
| `quota.concurrency.test.ts` | 额度只够 2 个 turn，并发 5 个 → 恰好 2 个执行，总花费 ≤ 上限 |
| `quota.perturn.test.ts` | 轮内触及 `perTurn.maxCostUsd` → `activeTools` 清空、已生成内容作为回复发出 |
| `subagent.test.ts` | 子 agent 首条 messages 不含主对话；`effective_role ≤ 父`；完整 transcript 不在 `context_messages`；深度/环路/数量护栏 |
| `cancel.test.ts` | abort 后子 agent 结束、沙箱容器被 kill、`turns.state='cancelled'`、delta 未提交 |
| `log.trace.test.ts` | 一次含子 agent 的 turn 能重建完整 span 树；`usage_ledger` 求和 == `turns.cost_usd` |

### CI 一致性断言（一次性补，长期防回归）

```ts
// tests/consistency.test.ts
it('TOOL_POLICY 与实际注册工具集完全一致', () => {
  expect(new Set(registry.names())).toEqual(new Set(Object.keys(TOOL_POLICY)));
});
it('所有会话级 Repository 方法的 SQL 都带 chat_id/key 过滤', () => { /* AC-DB-003，已有雏形，需扩到全部方法 */ });
it('日志事件 kind 都在文档枚举内', () => { /* 对照 10 §2 的枚举常量 */ });
it('config.schema.json 与 zod schema 同步', () => { /* 防止 WebUI 表单与实际校验漂移 */ });
```

---

## 4. 验收状态快照（2026-08-15）

按 [13](./13-acceptance-criteria.md) 的 253 条 AC 粗估当前状态。**这不是实测结果**，是基于代码审阅的判断，用于排期，不能替代实际验收。

| 模块 | 总数 | 预计通过 | 预计失败 | 主要失败原因 |
|---|---:|---:|---:|---|
| 配置与 DB | 17 | 13 | 4 | AC-CFG-005/009/010、AC-DB-005 |
| **上下文引擎** | 28 | 14 | 14 | G-CTX-01/02/03/04/06/07，多模态与取消相关 |
| Telegram 与准入 | 26 | 8 | 18 | 无流式、无多模态、无编辑/入群处理、命令绕过 |
| Agent 与 Provider | 23 | 12 | 11 | 消息压平、无 span、无 prompt cache、无别名校验 |
| 工具/沙箱/审批 | 37 | 18 | 19 | 13 个工具缺失、审批规则、fail-closed、untrusted 包裹 |
| Subagent 与任务 | 21 | 1 | 20 | `spawn_agent` 为桩、无取消、无任务 |
| 记忆 | 13 | 6 | 7 | 越权读取、无压缩、无命令 |
| 日志与成本 | 23 | 9 | 14 | 无 span 树、事件缺失、配额闭环缺失 |
| 扩展生态 | 24 | 5 | 19 | Skill 未接线、Plugin 未接线、MCP 缺失 |
| WebUI | 21 | 6 | 15 | 2/13 页面、API 缺失、config 无校验 |
| 安全 | 12 | 6 | 6 | 记忆越权、untrusted 包裹缺失、审批缺失 |
| 运维 | 8 | 3 | 5 | 无优雅退出、无 cron、无冒烟脚本断言 |
| **合计** | **253** | **≈101** | **≈152** | **通过率 ≈ 40%** |

**★ 项（核心语义）状态**：文档中标 ★ 的 62 条里，预计通过 21 条、失败 41 条。按 [13 §13](./13-acceptance-criteria.md#13-验收签署) 的整体通过条件（全部 ★ 通过 + 非 ★ ≥95%），**当前不具备验收条件**；完成 R0–R4 后可复评。

---

## 5. 给实现者的三条提醒

1. **先补测试再改代码**。R0/R1 涉及的三处 P0 都是「代码看起来对、实际语义错」的类型 —— 只有断言才能防止改完又漂回去。建议每条 P0 先写一个红灯用例，再改实现让它变绿。
2. **不要在 R1 之前动 Agent 层**。上下文物化的返回结构（G-AGENT-02 要改的 parts 透传）依赖 R1 确定的消息写入语义；顺序颠倒会返工。
3. **摘除比伪造安全**。`spawn_agent` 这类「返回看似成功的假结果」的桩，在补全之前一律从注册表移除。同理，任何暂不实现的工具，宁可不出现在 `TOOL_POLICY` 与 RUNTIME 块里，也不要注册一个总是报错的版本 —— 模型会反复重试并把上下文塞满。
