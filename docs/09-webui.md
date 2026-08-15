# 09 · WebUI 管理端

形态：**同进程内置**（Hono + 静态 SPA），单管理员密码 + Session，SSE 实时推送（D15）。前端 **PrimeVue 4**。

## 1. 部署形态

```
node apps/bot
 ├─ grammY bot（polling / webhook）
 └─ Hono server  :8787
     ├─ GET  /                      → packages/webui/dist（SPA，history fallback）
     ├─ POST /api/auth/login|logout
     ├─ *    /api/**                → 需 session + CSRF（非 GET）
     ├─ GET  /api/events            → SSE（日志、进度、状态）
     └─ POST /webhook/telegram      → 仅 webhook 模式，独立于 /api 鉴权
```

```yaml
webui:
  enabled: true
  host: 127.0.0.1        # ★ 默认只监听回环，公网暴露需自行前置 TLS 反代
  port: 8787
  basePath: /
  sessionTtlHours: 168
  passwordHash: '$argon2id$...'     # 由 `pnpm webui:passwd` 生成或首次启动向导写入
  trustProxy: false                 # true 时读取 X-Forwarded-For 记 session ip
  allowOrigins: []                  # 默认同源；配置 CORS 仅供开发
```

启动检查：`webui.enabled && !passwordHash` → 生成一次性 setup token 打印到控制台，`/setup` 页面用它设定初始密码。`host` 非 `127.0.0.1` 且未设密码 → **拒绝启动**。

---

## 2. 鉴权

### 2.1 密码 + Session

- 密码用 **argon2id**（`memoryCost=19456, timeCost=2, parallelism=1`）哈希存配置。
- `POST /api/auth/login {password}` → 校验 → 生成 32 字节随机 session id → 写 `sessions` 表 → `Set-Cookie: luoli_sid=…; HttpOnly; SameSite=Lax; Path=/; Secure(当 https)`。
- 同时返回 `csrf` token（存 `sessions.csrf`）；前端放内存，所有非 GET 请求带 `X-CSRF-Token`。
- 失败限流：同 IP 连续失败 5 次 → 锁 15 分钟（内存计数 + 日志 `warn`）。
- 登出删除 session 行；`GET /api/auth/me` 返回登录态、到期时间**与本 session 的 `csrf`** —— 前端只把 token 放在内存里，刷新页面后必须靠这个端点补回来，否则刷新之后所有写操作都会 403。跨站拿不到它：既过不了 Origin 中间件，也读不到响应体。
- Session 滑动续期：每次请求更新 `last_seen_at`，超过 `sessionTtlHours` 未活动则失效。

### 2.2 单角色

WebUI 只有一个身份 = **owner**。不做多用户/RBAC（记入 [14](./14-open-questions.md)）。所有 API 都以 owner 权限执行，因此**必须**默认绑回环。

### 2.3 可选：Telegram 一次性登录链接

`/webui`（owner 私聊）→ 生成 5 分钟有效的一次性 token → 返回 `http://<webui.publicUrl>/login?t=<token>` → 访问即换取 session。用于「不想记密码」的场景，与密码登录并存。token 单次使用、存内存、进程重启即失效。

---

## 3. 页面清单

用 PrimeVue 组件，左侧 `Menu` 导航 + 顶部 `Toolbar`（状态灯：bot 连接 / provider 健康 / 在途 turn 数 / 今日花费）。

### 3.1 Dashboard
- 实时卡片：在途 turn、今日 turn 数、今日花费/额度环形图（`Knob`）、消息量趋势（`Chart` 折线，近 7 天）。
- 在途 turn 表（`DataTable`，SSE 增量更新）：turn id、会话、发起人、状态、步数、已用时长、花费、`[取消]`。
- 最近错误（`DataTable`，level≥warn，10 条，点击跳日志 trace）。
- 系统信息：版本、上线时长、DB 大小、WAL 大小、workspace 占用、沙箱可用性、MCP 状态摘要。

### 3.2 会话（Chats）
- 会话列表（`DataTable`，可搜索/排序）：chat、类型、角色、消息数、上下文 token/上限、最后活跃、今日花费、`contextScope`。
- 详情三个 Tab：
  1. **上下文查看器**：当前窗口的消息序列（`Timeline` 或虚拟滚动列表）。每条显示 ordinal、role、origin、speaker、tokens、`prune_level`；被裁剪/降级的条目灰显并可展开原文；`rebased` 消息打红色徽标（`Tag`）并显示「未见 ordinal 5–6」。
  2. **Commit 时间线**：`DataTable` 列出 commits（seq、kind、window、head、tokens、rebased、base≠parent 时的对比）。操作：`[查看快照]` `[回滚到此]`（`ConfirmDialog`）。
  3. **设置**：`contextScope` 切换、唤醒词、`output.mode` 覆盖、模型别名固定、`background.maxPerTurn` 覆盖、`[/new]` `[/undo]` 按钮。

### 3.3 消息检索（Messages）
- 全库检索（owner 可跨会话）：关键词（FTS）、会话、发言人、时间范围、类型、是否触发。
- `DataTable` 分页 + 行展开显示 `raw_json`（`Fieldset` + 代码高亮）与附件预览（`Image` / 文件下载）。
- 单条操作：`[定位到上下文]`（若已被认领）、`[查看所属 turn 的 trace]`、`[软删除]`。

### 3.4 提示词（Prompts）
- 左侧文档树（`Tree`）：`CHARACTER.md`、`CHARACTER.<chat>.md`、`ASSIST.md`、`PUBMEMORY.md`、`private/<userId>/PRIMEMORY.md`。
- 右侧编辑器（`Textarea` + 行号；或按需换 CodeMirror）：实时 token 计数、字节数、保存（`Ctrl+S`）。
- `[预览组装]`：选一个会话 + 角色 → 展示完整 block 0–6 与各块 token 占比（`ProgressBar` 堆叠）。
- `[历史]`：`memory_revisions` 列表 + unified diff 展示（`Dialog`）+ `[回滚到此版本]`。
- PRIMEMORY 页顶部醒目提示「查看他人私有记忆会被记录」（对应 [06 §5.3](./06-prompt-and-memory.md#53-隐私细节)）。
- 待审压缩 diff（`memory/.pending/`）在此显示 `[应用] [丢弃]`。

### 3.5 Provider 与模型
- Provider 表：名称、类型、base_url、key hint、启用、健康状态（`Tag`）、`[测试连接]` `[拉取模型]` `[编辑]` `[删除]`。
- 编辑对话框：类型下拉、base_url、**API Key 写入型输入**（占位符 `保持不变`）、自定义 headers（键值表格）、`[测试连接]`（用对话框里尚未保存的 key/base_url 试，不写健康状态）。
- `[测试连接]` 的结果与所有 provider/模型写操作的反馈走**右上角 `Toast`**（`position="top-right"`，自动滑入滑出），不再用顶栏的静态横幅：连通时显示耗时与上游返回的模型数，失败时显示错误类型与上游消息摘要。详见 [04 §5.4](./04-agents-and-providers.md#54-密钥管理)。
- 模型表（按 provider 分组，`TreeTable`）：model_id、显示名、context_window、max_output、能力开关（vision/tools/reasoning/cache）、四个价格字段、启用、排序。
- `[从 Provider 拉取模型]`：选 provider → 调 `GET /api/providers/:id/models` 拿上游模型目录 → 带搜索框的多选表格（**不做白名单过滤**，上游返回什么就列什么；已在库中的行灰显且不可勾选）→ 勾选若干 → `POST /api/models/import` 批量落库。上游给了窗口/最大输出（Google）就逐行带入，没给（OpenAI / Anthropic）则用对话框顶部的默认值；**价格一律不猜，落库为空**，需在模型表里手工补齐（对应 [04 §5.5](./04-agents-and-providers.md#55-定价与-token-计费)「不自动抓取」）。
- **别名管理**：每个别名一行，`OrderList` 拖拽排列 fallback 链 + settings JSON 编辑（temperature / maxOutputTokens / reasoningEffort…）。缺少 `main` 别名时整页红色警示。
- `[导入]`：粘贴 JSON 批量导入 provider+模型+定价（导出同格式，便于备份/迁移）。
- 每个模型行显示近 7 天调用次数与花费（来自 `usage_ledger`）。

### 3.6 主体与权限（Principals）
- 表格：kind、tg_id、显示名/username、角色（内联 `Select` 直接改）、首次出现、最后活跃、消息数、今日花费、备注。
- 过滤：仅群 / 仅用户 / 按角色。
- `[批量导入]`（粘贴 id 列表 + 目标角色）、`[导出]`。
- 权限矩阵只读视图：把 `TOOL_POLICY` 渲染成 [05 §4](./05-tools-and-permissions.md#4-权限矩阵权威表) 那张表，便于核对；可切「以某角色视角」预览可用工具集。

### 3.7 工具与沙箱
- 工具表：名称、来源（builtin/plugin/skill/mcp）、minRole、审批策略、本会话/全局启停、近 7 天调用次数与失败率、平均耗时。
- 沙箱设置：`mode` 单选（含 docker 可用性探测结果）、镜像名 + `[拉取/构建]`、资源限制、网络、`bypassRoles`（多选）、超时。
- `allowHostFsForOwner` 开关带红色确认对话框。
- 审批规则编辑器（`DataTable` 行内编辑）：tool 匹配、正则、风险级别、`[测试正则]`（输入样例命令看是否命中）。

### 3.8 扩展（Skills / Plugins / MCP）
- **Skills**：卡片/表格列出 name、description、min-role、allowed-tools、token 占用、状态（解析错误显红）。`[编辑]` 打开 frontmatter 表单 + 正文编辑器；`[新建]`；`[启停]`；`[查看附属文件]`。
- **Plugins**：name、version、minRole、启用（默认关，开启时弹「plugin 以全信任方式运行任意代码」确认）、`configSchema` 生成的表单、provides 概览（工具/钩子/命令/agent）、`load_error`、`[重载]`。
- **MCP**：server 列表 + 状态、transport 配置表单、发现到的工具清单（含 inputSchema 预览 `Dialog`）、allow/deny glob、`[重连]`、最近错误。

### 3.9 子 Agent（Agents）
- 表格：name、description、modelAlias、maxSteps、tools（`MultiSelect`）、minRole、resultMaxChars、来源（config/plugin）。
- `instructions` 编辑器 + token 计数。
- `[试跑]`：给定 task 文本，直接派发一次并在 `Dialog` 里流式展示步骤/工具/结果与花费（不进任何会话上下文）。

### 3.10 日志（Logs）
- 过滤器：时间范围、level、kind（多选）、trace_id、chat、user、关键词。
- 虚拟滚动表格；`[实时]` 开关走 SSE 追加。
- **Trace 视图**（重点）：输入/点击 `trace_id` → 树形展开（`Tree`）：
  ```
  turn 01J8…  (12.4s, $0.031, committed, rebased)
  ├ context.open        (8ms)  base=c041 claimed=3
  ├ model.call #1       (2.1s) main→claude-opus-5  in 6,240 out 180  $0.008
  │ └ tool.spawn_agent  (7.9s) researcher
  │   ├ model.call      (1.8s) low→…  in 1,020 out 240  $0.001
  │   ├ tool.grep       (120ms) 12 hits
  │   ├ agent.ask       (2.0s) "该用哪个目录?" → arbiter: "/workspace/logs"
  │   └ model.call      (2.4s) …
  ├ model.call #2       (1.9s) …
  ├ telegram.send       (300ms) msg 8841
  └ context.commit      (14ms) rebase onto c042, prune 2 turns
  ```
  每个节点可展开看完整 payload（请求 messages、工具输入输出、响应），大 payload 从 `logs/*.jsonl` 按 `file_ref` 懒加载。
- `[导出 trace]` → JSON 下载，便于贴 issue。

### 3.11 用量与配额（Usage）
- 时间范围选择 + 维度切换（按天/按会话/按用户/按模型/按 agent）。
- 图表：花费堆叠柱（按模型）、token 折线（in/out/cache）、成功率。
- 明细表（`usage_ledger` 分页）。
- 配额设置表单：global/chat/user × day/month 金额、按角色覆盖、turn 级上限（cost / steps / tools / subagents）、`requirePricing` 开关。
- 当前计数器实时展示（`quota_counters`，含 `reserved_usd`）+ `[重置某计数器]`（owner，写审计日志）。
- 无定价模型告警条。

### 3.12 任务与审批
- 任务表：在途 + 历史，进度、耗时、花费、`[取消]`、`[查看 trace]`。
- 审批队列：待审列表（工具、输入代码块、发起人、会话、风险、剩余时限）+ `[批准] [拒绝]`；历史审批记录可查。
- 桌面通知（`Notification API`，需用户授权）+ 页面标题角标。

### 3.13 配置（Settings）
- 由 `config.schema.json`（zod → JSON Schema）**自动生成**表单：分组折叠面板（`Accordion`），每项含描述、默认值、当前值、是否需要重启（`Tag: 热更新 / 需重启`）。
- `[原始 YAML]` 模式：直接编辑，保存前跑 zod 校验，错误定位到行。
- 保存 → 写 `config_kv` + `config_revisions` → 广播热更新事件；需重启项标注并提供 `[重启进程]`（若在 systemd/docker 下由外部 supervisor 拉起）。
- `[导出配置]` / `[导入配置]`（密钥字段自动排除）。
- 维护操作：`[立即备份 DB]`、`[VACUUM]`、`[清理过期日志]`、`[重建 FTS 索引]`、`[清理孤儿文件]`。

---

## 4. REST API

统一响应：`{ ok: true, data }` / `{ ok: false, error: { code, message, details? } }`。分页统一 `?page=1&size=50` → `{ items, total, page, size }`。

| Method & Path | 说明 |
|---|---|
| `POST /api/auth/login` `POST /api/auth/logout` `GET /api/auth/me` | 鉴权 |
| `GET /api/dashboard` | 概览聚合 |
| `GET /api/chats` `GET /api/chats/:key` `PATCH /api/chats/:key` | 会话（PATCH 改 scope/唤醒词/覆盖项）。PATCH body 必须通过 `configSchema` 与 [11 §2.1](./11-config-reference.md) 的 `perChat` 白名单，越界返回 400 |
| `GET /api/chats/:key/context` | 当前窗口消息（分页） |
| `GET /api/chats/:key/commits` | commit 时间线 |
| `POST /api/chats/:key/commits/:id/checkout` | 回滚 done 指针 |
| `POST /api/chats/:key/reset` `POST /api/chats/:key/undo` | 等价 `/new` `/undo` |
| `GET /api/messages` `GET /api/messages/:id` `DELETE /api/messages/:id` | 消息检索（`?q=` 走 FTS） |
| `GET /api/files/:attachmentId` | 附件下载（校验 session） |
| `GET /api/prompts` `GET /api/prompts/:id` `PUT /api/prompts/:id` | 提示词/记忆文档 |
| `GET /api/prompts/:id/revisions` `POST /api/prompts/:id/rollback` | 版本 |
| `POST /api/prompts/preview` | 组装预览（body: `{key, role}`） |
| `GET/POST/PATCH/DELETE /api/providers[/:id]` | Provider |
| `POST /api/providers/:id/test` | 测试连接：按 kind 向上游模型目录接口发一次 GET（15s 超时），返回 `{reachable, code, message, status, latencyMs, models}`（`models` 是数量，不是列表）。body 可选 `{apiKey, baseUrl, kind}` 覆盖库里的值，用于测试尚未保存的配置。**只有不带覆盖的测试写健康状态**：成功写 `health_state='up'` 并清空 `health_error`（这是 `down` 的唯一人工恢复路径），401/403 写 `down`，其余失败只更新 `health_checked_at` —— 网关缺 `/models` 不等于对话不可用，不能因此把可用的 provider 摘掉 |
| `GET /api/providers/:id/models` | 拉取上游模型目录，返回 `[{modelId, displayName, contextWindow, maxOutput}]`（后两项上游没给就是 `null`）。上游不可达时返回 `502` + 错误 code |
| `GET/POST/PATCH/DELETE /api/models[/:id]` | 模型 |
| `POST /api/models/import` | 从上游目录批量落库：`{providerId, models:[{modelId, displayName?, contextWindow?, maxOutput?}], contextWindow?, maxOutput?}`，单次上限 200 条。已存在的 `(provider_id, model_id)` 跳过而不是覆盖（不能把已调好的定价冲掉），返回 `{inserted, skipped, ids}` |
| `GET/PUT /api/aliases[/:alias]` | 别名与 fallback 链 |
| `GET/PATCH /api/principals[/:id]` `POST /api/principals/bulk` | 主体与角色 |
| `GET /api/tools` `PATCH /api/tools/:name` | 工具启停。写入 `tools.overrides.<name>.enabled`；被禁用的工具从工具目录消失，且 `ToolRegistry.execute` 会二次拦截并返回 `tool_disabled_by_operator`。未知工具名返回 404 |
| `GET/PUT /api/sandbox` `POST /api/sandbox/probe` | 沙箱配置与探测 |
| `GET/POST/PATCH/DELETE /api/skills[/:name]` | Skill（含正文读写） |
| `GET/PATCH /api/plugins[/:name]` `POST /api/plugins/:name/reload` | Plugin |
| `GET/POST/PATCH/DELETE /api/mcp[/:name]` `POST /api/mcp/:name/reconnect` | MCP |
| `GET/POST/PATCH/DELETE /api/agents[/:name]` `POST /api/agents/:name/dryrun` | 子 agent |
| `GET /api/logs` `GET /api/logs/trace/:traceId` `GET /api/logs/blob?ref=` | 日志 |
| `GET /api/usage` `GET/PUT /api/quota` `POST /api/quota/reset` | 用量与配额 |
| `GET /api/tasks` `POST /api/tasks/:id/cancel` | 任务 |
| `GET /api/approvals` `POST /api/approvals/:id/decide` | 审批 |
| `GET /api/config` `PUT /api/config` `GET /api/config/schema` `GET /api/config/revisions` | 配置 |
| `POST /api/maintenance/{backup,vacuum,cleanup-logs,rebuild-fts,gc-files}` | 维护 |
| `GET /api/events` | SSE |

审计：所有非 GET 请求写 `log_events(kind='webui.action')`，含路径、body 摘要（脱敏）、session ip。

---

## 5. SSE 事件

```
event: turn.started      data: {turnId, key, chatId, user, at}
event: turn.progress     data: {turnId, phase, step, note}
event: turn.finished     data: {turnId, state, steps, costUsd, rebased, durationMs}
event: log               data: {id, ts, level, kind, traceId, summary}
event: usage             data: {turnId, model, in, out, costUsd}
event: quota             data: {scope, subject, bucket, spent, limit}
event: approval.pending  data: {id, tool, risk, chatId, expiresAt}
event: task.updated      data: {id, state, progress}
event: health            data: {providers:[...], mcp:[...], sandbox:{ok}, bot:{ok}}
event: config.changed    data: {keys:[...]}
```

- 单连接多主题；前端按 `event` 分发到 Pinia store。
- 心跳注释 `: ping` 每 20s，防中间代理断连；断线前端指数退避重连（1s→30s）。
- 背压：`log` 事件在服务端按 200 条/秒截流，超出发 `{dropped: n}`。
- SSE 连接需 session cookie；未鉴权直接 401。

---

## 6. 前端结构

```
packages/webui/
├── index.html
├── vite.config.ts             base: '/', proxy /api → :8787（dev）
└── src/
    ├── main.ts                createApp + PrimeVue(Aura) + router + pinia
    ├── router/index.ts        路由 + 全局守卫（未登录 → /login）
    ├── stores/
    │   ├── auth.ts  events.ts（SSE 单例）  dashboard.ts  chats.ts
    │   ├── providers.ts  logs.ts  usage.ts  config.ts  approvals.ts
    ├── api/client.ts          fetch 封装：CSRF 头、401 跳登录、统一错误 toast
    ├── components/
    │   ├── StatusBar.vue  RoleTag.vue  TokenMeter.vue  CostBadge.vue
    │   ├── ContextViewer.vue  CommitTimeline.vue  TraceTree.vue
    │   ├── DiffView.vue  SecretInput.vue  SchemaForm.vue（config.schema → 表单）
    └── views/                 每个 §3 页面一个 .vue
```

- PrimeVue 组件按需引入（`unplugin-vue-components` + `PrimeVueResolver`），主题 Aura + 深/浅色跟随系统（`ToggleButton` 可手动切）。
- 表格统一虚拟滚动 + 服务端分页/排序/筛选（日志与消息量可能很大）。
- 所有金额显示 4 位小数 + hover 显示完整值；token 显示千分位。
- **只读渲染安全**：消息内容、日志 payload 一律作为纯文本渲染（`v-text` / `<pre>`），**禁止 `v-html`**（消息内容来自不可信用户）。
- i18n：文案集中在 `src/i18n/zh-CN.ts`，预留 `en`。第一版仅中文。

---

## 7. 构建与托管

- `pnpm build` → `packages/webui/dist` → 被 `packages/server` 用 `serveStatic` 托管；SPA fallback 到 `index.html`。
- 生产镜像里 dist 已内置，无需 Node 之外的静态服务器。
- 缓存：带 hash 的资源 `immutable, max-age=31536000`；`index.html` `no-cache`。
- 安全响应头：`Content-Security-Policy: default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'`、`X-Frame-Options: DENY`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`。
