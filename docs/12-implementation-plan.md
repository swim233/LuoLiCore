# 12 · 实施指导（M0–M11）

原则：**每个里程碑都必须是可运行、可验收的**。不允许出现「写了三周代码但跑不起来」的阶段。每个 M 的出口条件对应 [13](./13-acceptance-criteria.md) 的具体 AC 编号。

预估基于「1 名熟练 TS 开发全职」。并行开发时 M9（WebUI）可与 M4–M8 重叠。

---

## M0 · 骨架（2–3 天）

**交付**
- pnpm workspace + TS 严格模式 + vitest + eslint/prettier + `tsx` dev。
- `packages/shared`（类型、错误类、ULID、Result 类型）。
- `packages/core/config`：zod schema（[11](./11-config-reference.md) 全量）+ 加载（yaml + env + config_kv 三层合并）+ 校验 + `${env:}` 展开 + 冻结快照 + `onChange`。
- `packages/core/log`：`LogSink`（JSONL 追加流 + 轮转 + 脱敏）+ span/trace 工具 + pino 控制台。
- `packages/db`：全表 DDL（[03](./03-data-model.md)）+ `0001_init.sql` + 迁移执行器 + PRAGMA 设置 + `ScopedRepo` 基类。**手写 SQL，不用 ORM**（D20）。
- `apps/bot/src/main.ts`：启动 → 校验配置 → 迁移 DB → 打印健康摘要 → 优雅退出。

**出口条件**
- `pnpm dev` 起得来，`Ctrl+C` 优雅退出，`logs/<date>/system.jsonl` 有 `system.start`。
- `pnpm test` 通过：配置校验用例（合法/非法各 5 例）、迁移在空库与已迁移库上均幂等。
- AC-CFG-001..011、AC-DB-001..006。

---

## M1 · Telegram 接入与归档（3–4 天）

**交付**
- `packages/telegram`：bot 实例、throttler、autoRetry、logging transformer。
- 中间件链前 10 步（[08 §2](./08-telegram-adapter.md#2-中间件链顺序即安全语义)）：errorBoundary、trace、dedup、resolvePrincipals、accessGate、ignoreBots、mediaGroupDebounce、download、archive。
- `principals` 引导（`LUOLI_OWNER_ID`）、`my_chat_member` 处理 + 通知 owner。
- 命令骨架：`/ping` `/whoami` `/help` `/grant` `/revoke` `/whois`。
- 媒体下载 + 文档抽取（pdf/txt/code/csv）。

**出口条件**
- 私聊 `/ping` 有回复；群里普通消息全部入库；`blocked` 主体的消息不入库、无回复。
- 发相册 3 张图 → 一条逻辑消息、3 条 `messages`、3 条 `attachments`、文件落盘。
- 发 pdf → `extracted_text` 非空。
- AC-TG-001..011、AC-ACL-001..007。

---

## M2 · 上下文引擎（4–6 天）★ 最关键

**交付**
- `context/engine.ts`：`openTurn` / `appendDelta` / `commitTurn` / `abortTurn` / `reset` / `undo` / `setHead`。
- `KeyedMutex`；`ordinal` 在 commit 时分配；`claim_watermark` 单调前移。
- `materialize.ts` + LRU 缓存 + 分级 prune 的就地降级渲染。
- `render.ts`：背景消息 `[发言人 时间]` 前缀、非文本占位符、伪造前缀转义。
- `tokenizer.ts` + EMA 校准。
- 裁剪算法（turn 边界 → 分级 prune → 硬截断）+ `kind='prune'` commit。
- rebase 检测、标记、`ctx.rebase` 日志。
- 命令：`/new` `/undo` `/ctx`。

**此阶段先不接模型**：用一个 `EchoAgent`（把 delta 原样回显 + 追加一条 assistant 消息）验证全部上下文语义。

**出口条件**
- AC-CTX-001..028 **全部通过**（含并发 rebase 的确定性用例：用可控 sleep 模拟 A/B 完成顺序）。
- 压力测试：同 key 并发 20 个 turn，最终 `ordinal` 无空洞、无重复，`refs.done` 唯一且 `head_ordinal` = max(ordinal)。
- 裁剪测试：构造 100 轮对话，断言窗口始终落在 turn 边界、`tokens ≤ limit`、无孤儿 tool 消息。

---

## M3 · Provider + 主 Agent（3–4 天）

**交付**
- `provider/registry.ts`：DB → `createProviderRegistry` + `customProvider` 别名 + `fallbackModel` + `usageMiddleware` + `loggingMiddleware`。
- 密钥 AES-256-GCM 加解密。
- `prompt/assembler.ts`：block 0–6 + prompt cache 断点 + `maxTokens` 截断策略。
- `agent/factory.ts`：`ToolLoopAgent` 装配（`instructions` / `messages` / `stopWhen` / `prepareStep` 的 (a)(c) 分支 / 生命周期回调）。
- `turn/runner.ts`：串起 openTurn → agent → 输出 → commitTurn。
- `telegram/output.ts`：流式 `editMessageText` + 分片 + MarkdownV2 安全渲染 + 降级。
- 命令 `/model`。

**出口条件**
- 私聊「你好」→ 流式回复；出站消息入库；上下文含 user+assistant 两条。
- 群里 @bot → 回复，且上下文含被认领的背景消息。
- 断掉主 provider（改错 key）→ 自动 fallback 到第二个模型并记 `provider.fallback`。
- 关掉全部 provider → 回复「模型暂时不可用」且 **delta 未提交**。
- AC-AGENT-001..008、AC-PROV-001..009、AC-OUT-001..008、AC-PROMPT-001..006。

---

## M4 · 工具与权限与沙箱（4–5 天）

**交付**
- `tools/policy.ts`（`TOOL_POLICY` 单一数据源）+ `tools/registry.ts`（11 步执行包装，[05 §8](./05-tools-and-permissions.md#8-toolregistry-执行包装统一横切)）。
- fs 工具 + `resolveJailed`（realpath + denyGlobs）+ trash/backup。
- 检索工具（`search_messages` / `read_messages` / `get_message` / `admin_search_messages` / `context_stats`）+ FTS trigram 回退。
- exec 工具 + `sandbox`（none/jail/docker 三实现 + `plan()` 策略矩阵 + fail-closed）。
- web 工具 + SSRF 防护。
- Telegram 侧工具。
- 审批流（`approvals` 表 + Telegram inline 按钮 + 超时）。
- `prepareStep` 的 (b) 分支（`activeTools` 按角色）。

**出口条件**
- `limited` 用户请求写文件 → 工具不在 `activeTools` 里（不是「调用后被拒」）。
- `trusted` 用户在 `sandbox.mode=none` 下请求 `bash` → 工具不存在，模型如实告知。
- 路径穿越 `../../etc/passwd`、symlink 逃逸、`.env` 读取 → 全部被拒。
- `rm -rf` → 触发审批；owner 批准后执行；超时后返回未批准。
- AC-TOOL-001..020、AC-SBX-001..010、AC-APV-001..007。

---

## M5 · Subagent 与任务（3–4 天）

**交付**
- `spawn_agent`（async generator + `toModelOutput` 摘要回灌）+ `list_agents` + `read_agent_result`。
- `agent_runs` / `agent_messages` 落库；深度、并发、环路、次数护栏。
- `AgentBus`：`ask` / `answer`（规则 → arbiter → 转人工 → 超时四级）/ `progress` / `result`。
- `TaskManager`：占位消息、进度编辑节流、inline 取消、`/tasks` `/cancel`、超时。
- 取消级联（AbortSignal → 子 agent → `docker kill`）。

**出口条件**
- 一个需要读 5 个文件的请求 → 主 agent 派发 `researcher`，用户看到占位 + 进度 + 最终回复；主上下文里只有摘要（不含子 agent 的完整 transcript）。
- 子 agent `ask_parent` → arbiter 应答 → 继续执行；日志中可见 ask/answer 与 source。
- 点取消 → 子 agent 与沙箱容器都终止，5 秒内消息变「已取消」。
- 环路（researcher 派 researcher 派 researcher）→ 第三层被拒。
- AC-SUB-001..013、AC-TASK-001..008。

---

## M6 · 记忆（2–3 天）

**交付**
- `MemoryStore`：四类文档读写、原子落盘、`memory_docs` / `memory_revisions`。
- 注入矩阵（群聊代码路径不读 primemory）。
- `memory_read` / `memory_write` / `memory_list`；scope 收窄与工具不注册逻辑。
- 去重、soft/hard limit、来源标注、轮末批量落盘。
- 自动压缩（`low` 模型 → `.pending/` → 待审）。
- 命令 `/memory` `/forgetme`；owner 读他人私有记忆的告警日志。

**出口条件**
- 私聊说「记住我不吃香菜」→ 写入 `private/<uid>/PRIMEMORY.md`，含来源标注。
- 群聊里说同样的话 → 只能写 PUBMEMORY（且 `limited` 角色写不了）；组装的系统提示词中**不含任何 primemory 内容**（断言字符串不存在）。
- 用户 B 的私聊看不到用户 A 的私有记忆。
- 写超 hard limit → 拒绝并提示整理。
- AC-MEM-001..013。

---

## M7 · Skill / Plugin / MCP（3–4 天）

**交付**
- Skill 加载器（gray-matter + zod）、渐进式披露、`load_skill`、`skill://` 只读访问、chokidar 热更新、附属目录挂载。
- `@luoli/plugin-sdk` + 加载器 + hook 分发（顺序、超时、崩溃隔离、自动禁用）+ `ctx.storage`。
- MCP 客户端管理（懒连接、健康、重启退避、工具前缀与包裹、allow/deny）。
- `tools.maxRegistered` 护栏与优先级截断。

**出口条件**
- 放一个 SKILL.md → 系统提示词目录里出现它的 description（且**只有** description）；模型 `load_skill` 后拿到正文并按其收窄工具集。
- SKILL.md 写坏 frontmatter → 该 skill 显红，其他一切正常。
- 启用一个示例 plugin → 其工具可调用；hook 抛异常 3 次 → 自动禁用并告警。
- 配一个 stdio MCP server → 工具以 `mcp__<name>__*` 出现；kill 掉 server → 工具从 RUNTIME 块消失。
- AC-SKL-001..008、AC-PLG-001..008、AC-MCP-001..008。

---

## M8 · 日志、成本、配额（2–3 天）

**交付**
- 全部事件 kind 落地（[10 §2](./10-logging-and-observability.md#2-事件种类log_eventskind-枚举)）+ `file_ref` 大 payload 落盘。
- `usageMiddleware` 记账（含流式在 finish part 记账、缓存 token 单独计价、失败也记）。
- `QuotaGuard`：预留-提交-释放、多级判定、bucket、`perTurn` 上限、`rateLimit`。
- 80% 提示、超限文案、owner 告警、`/usage`。
- 维护任务（备份、vacuum、日志清理、孤儿文件、`processed_updates` 清理、reserved 归零）。

**出口条件**
- 一次 turn 的日志能重建完整调用树；模型调用费用之和 = `turns.cost_usd`。
- 把 `perUser.daily` 设为 0.001 → 第二次请求被拒且文案正确；`/usage` 数字一致。
- 并发 5 个 turn 且额度只够 2 个 → 只有 2 个通过（预留机制生效），无超支。
- 全库 JSONL 正则扫描无任何 key/token 明文。
- AC-LOG-001..011、AC-QUOTA-001..012。

---

## M9 · WebUI（5–7 天，可与 M4–M8 并行）

**交付**
- `packages/server`：Hono、session、CSRF、静态托管、安全响应头、SSE、全部 `/api` 路由。
- `packages/webui`：13 个页面（[09 §3](./09-webui.md#3-页面清单)）、SSE store、`SchemaForm`、`TraceTree`、`ContextViewer`、`CommitTimeline`、`DiffView`、`SecretInput`。
- 首次启动向导（设密码）。

**出口条件**
- 登录/登出/CSRF/失败限流可用；未登录访问 `/api/*` 一律 401。
- Dashboard 实时显示在途 turn 并可取消。
- 上下文查看器能看出某条消息是 rebase 产生的、被裁剪的、被降级的。
- Trace 视图能展开一次真实 turn 的全部 span 并看到完整请求消息。
- 改一个热更新配置项 → 下一轮生效，无需重启；改需重启项 → 有明确徽标。
- 提示词编辑 → 保存 → 有 diff 版本 → 可回滚。
- AC-WEB-001..021。

---

## M10 · 硬化与交付（3–4 天）

**交付**
- `docker/Dockerfile`（多阶段：build → 精简运行时，含 webui dist）+ `docker/sandbox.Dockerfile` + `docker-compose.yml`（挂载 `data/ memory/ skills/ plugins/ logs/ config/`，`/var/run/docker.sock` 可选以支持 docker 沙箱）。
- `README`：部署、备份、恢复、升级步骤。
- 端到端冒烟脚本（`pnpm smoke`）：模拟 20 个 update 走完全链路并断言 DB 状态。
- 提示注入红队用例集（[13 §11](./13-acceptance-criteria.md#11-安全-ac-sec)）。
- 负载测试：1 小时 500 条消息 + 50 个 turn，观察内存、DB 大小、WAL、句柄数无泄漏。
- 崩溃恢复演练：turn 进行中 `kill -9` → 重启后上下文一致、无半截 commit、reserved 归零。

**出口条件**
- 全部 AC 通过（或明确记录豁免项及理由）。
- 从零部署（干净机器 + docker compose up）在 10 分钟内可用。
- 备份文件可在另一台机器恢复并继续对话。

---

## M11 · HarnessAgent（2–3 天）

[14 §2 Q8](./14-open-questions.md) 于 2026-08-18 拍板要做。把 Claude Code / Codex 这类 harness 当子
agent 接进来 —— 「在 Telegram 里让它改你的仓库」。

⚠️ **Q8 原文那句「AI SDK v7 提供了这个抽象」是错的**：`ai@7.0.65` 里只有 `ToolLoopAgent`，没有任何
Harness 抽象。所以这不是「接一个 SDK 类」，而是**起一个外部 CLI 子进程**（`claude -p "<任务>"` /
`codex exec "<任务>"`）并把输出收回来。连带影响：配额与记账那两条管线**接不上** —— 花的是 harness
自己的额度，本系统看不到它的 token 数。能复用的只有取消（abortSignal → SIGTERM）与日志。

**先读 [14](./14-open-questions.md) T8 与 T17。** 这不是又一个子 agent：harness 自带一整套工具，
`available()` 的注册期 fail-closed 与 `execute()` 的二次硬拦截**都看不见它的内部调用**。下面三道门
就是全部的门。

**做什么**
- 准入：**仅 `owner` 且仅私聊**。群聊一律拒绝（群里任何人的发言都是注入面，而它能改仓库）。
  照旧走 `min(用户角色, 会话角色)`，另加一道会话类型判定。
- 目录边界：新增白名单配置键，显式列出 harness 能动的仓库路径；不在名单里的一律拒。
  **默认空 = 功能整体关闭**。不复用 `data/workspace/<chatId>`（那样就失去了这件事的初衷），
  也不接受任务里写任意路径。
- 审批：**起 harness 这一个动作**整体走一次审批（形状照 `bash` 的 `conditional`）。批准之后它内部
  怎么跑不再逐条拦 —— 本系统本来就看不见，假装能逐条审批等于伪造一道门（`docs/16 §5`）。
- 凭据：harness 自己的登录态不进本项目的 `config_kv`，也不进日志。

**出口条件**
- 默认配置（白名单为空）下工具**不进模型的工具目录**，而不是进了目录再报错。
- 群聊里 owner 起它 → 拒绝，且回执说明原因。
- 白名单外的路径 → 拒绝。
- 起它的动作在审批列表里能看到、能拒、拒了之后不执行。

---

## 关键实现顺序警告

1. **M2 必须先于 M3**。先接模型再做上下文引擎，会导致上下文语义被「模型能跑就行」的临时代码污染，rebase/裁剪几乎必然做错。
2. **M4 的 `TOOL_POLICY` 必须先于任何工具实现**。先写工具再补权限，一定会漏。
3. **权限与沙箱不要留「以后再加」的 TODO**。fail-closed 的默认值从第一行代码就要正确，否则中间任何一次测试部署都是暴露的。
4. **WebUI 的写操作最后接**。先做只读页面（Dashboard/Logs/Chats），确认数据模型合理，再做配置写入。
5. `logs.captureBodies` 在开发期开着（调试全靠它），生产按需。
