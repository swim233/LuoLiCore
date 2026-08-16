# 09 · WebUI 管理端

形态：**同进程内置**（Hono + 静态 SPA），单管理员密码 + Session，SSE 实时推送（D15）。前端 **Vue 3 + 自建 UI 层**（`src/ui/`，无第三方组件框架；图标沿用 PrimeIcons 字体）。

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

🚧 **未实现（已从命令白名单摘除）。** 原设计：`/webui`（owner 私聊）→ 生成 5 分钟有效的一次性 token
→ 返回 `http://<webui.publicUrl>/login?t=<token>` → 访问即换取 session；token 单次使用、存内存、
进程重启即失效。服务端与 handler 都没写，而名字留在 `trigger.ts` 的白名单里只会让 `/webui`
石沉大海，所以先摘除（docs/20 · W-TG-01；[08 §8](./08-telegram-adapter.md)）。要实现时**两侧一起加**：
`/login` 端点 + `bot.command('webui')` + `HANDLED_COMMANDS`，三者有 CI 断言互相锁死。

---

## 3. 页面清单

全站共用 §6 的自建组件与 `styles.css` 的设计变量，视觉基准是总览页：左侧固定深色导航 + 顶栏（状态灯：bot 连接 / provider 健康 / 在途 turn 数 / 今日花费；右上角是引导 owner 的真实显示名与 `@username`），内容区一律是 `.surface` 卡片。

### 3.1 Dashboard
- 实时卡片：在途 turn、今日 turn 数、今日花费/额度环形图、消息量趋势（折线图，近 7 天）。
- 在途 turn 表（`DataGrid`，SSE 增量更新）：turn id、会话、发起人、状态、步数、已用时长、花费、`[取消]`。
- 最近错误（`DataGrid`，level≥warn，10 条，点击跳日志 trace）。
- 系统信息：版本、上线时长、DB 大小、WAL 大小、workspace 占用、沙箱可用性、MCP 状态摘要。

### 3.2 会话（Chats）
- 会话列表（`DataGrid`，可搜索/排序）：chat、类型、角色、消息数、上下文 token/上限、最后活跃、今日花费、`contextScope`。
- 详情三个 Tab：
  1. **上下文查看器**：当前窗口的消息序列（时间线或虚拟滚动列表）。每条显示 ordinal、role、origin、speaker、tokens、`prune_level`；被裁剪/降级的条目灰显并可展开原文；`rebased` 消息打红色徽标（`UiTag`）并显示「未见 ordinal 5–6」。
  2. **Commit 时间线**：`DataGrid` 列出 commits（seq、kind、window、head、tokens、rebased、base≠parent 时的对比）。操作：`[查看快照]` `[回滚到此]`（二次确认）。
  3. **设置**：`contextScope` 切换、唤醒词、`output.mode` 覆盖、模型别名固定、`background.maxPerTurn` 覆盖、`[/new]` `[/undo]` 按钮。

### 3.3 消息与对话（Messages）
- **默认视图是「最近的模型对话」而不是消息流**：一次 turn 的提问与回答分散在多行 `messages` 里，
  按行翻页读不出对话的样子。走 `GET /api/turns`，**每页 20 次对话**，服务端 `LIMIT/OFFSET` 分页
  （`turns` 表可能很大，不整表拉回来再切）。每张卡片显示状态、会话、发起人、触发原因、时间，
  提问与回答各截断两行，底部一行 `步数 · 工具调用 · token · 花费`；点开展开全文并可跳到该轮 trace。
  流式回复被切成多条 Telegram 消息时归档里每条存的都是同一份全文，读出来按内容去重，不重复 N 遍。
- 搜索框与 `[搜索归档]` **在同一行**（`.search-row`），回车等价于点按钮；检索走 `GET /api/messages?q=`
  （owner 跨会话，中文三字以上 FTS5 trigram，短词回退 LIKE），结果切换成表格视图，
  `[返回最近对话]` 切回。正文一律纯文本渲染。
- **每条对话卡片右侧有 `[查看详情]`**：打开 `UiModal` 展示这一轮**实际发给上游的 JSON**（`GET /api/turns/:id/detail`）——
  顶部一行是状态/会话/发起人/步数/token/花费/耗时，下面按「模型调用 / 工具与沙箱 / 轮次与上下文 / 全部」分组
  列出该轮的全部 span，展开任一条看格式化后的载荷。`model.call` 的载荷里带 `request.body`，
  也就是真正发出去的请求体 —— turns 表只有统计、messages 表只有最终文本，**排查「模型到底收到了什么」只有这一份**。
  打开时默认落在模型调用并展开第一条。
- **长文本处理**：单条 span 的请求体动辄几十 KB，服务端按 120k 字符截断（置 `truncated`），载荷区固定高度自行滚动；
  `[复制 JSON]` 与 `[下载完整 JSON]` 都走 `GET /api/logs/:id/data` 取完整那一份（截断过的内容复制出去不是合法 JSON）。
  `logs.captureBodies` 关闭时详情里只有用量与耗时，页面顶部明说这一点，而不是显示一个空壳。
- 搜索结果表格多一列 `[详情]`，命中消息所属的那一轮同样能直接点开（服务端按 `turns.trigger_message_id` 回填 `turnId`）。
- 单条操作：`[定位到上下文]`（若已被认领）、`[查看所属 turn 的 trace]`、`[软删除]`。

### 3.4 提示词（Prompts）
- 左侧是**文档卡片网格**（不是 id/scope/bytes 的四列表格）：每张卡片一份文档，显示图标 + 中文名
  （人格 / 助理守则 / 公共记忆 / 私有记忆）、`全局` 或所属会话/用户、**这份文档进的是 prompt 的第几个 block 及其用途**、
  文档 id、字节数 / token 数 / 更新时间。选中的卡片高亮。
  —— `character:global` 这种 id 认不出是干什么的，用途必须写在卡片上，而不是让运维回去读 [06](./06-prompt-and-memory.md)。
  覆盖的文档集合仍是：`CHARACTER.md`、`CHARACTER.<chat>.md`、`ASSIST.md`、`PUBMEMORY.md`、`private/<userId>/PRIMEMORY.md`。
- 右侧编辑器（文本域 + 行号；或按需换 CodeMirror）：实时 token 计数、字节数、保存（`Ctrl+S`）；
  标题下写明文档类型与磁盘路径。没选中任何一份时右侧是提示卡片，而不是一片空白。
- `[预览组装]`：选一个会话 + 角色 → 展示完整 block 0–6 与各块 token 占比（堆叠进度条）。
- `[历史]`：`memory_revisions` 列表 + unified diff 展示（`UiModal`）+ `[回滚到此版本]`。
- PRIMEMORY 页顶部醒目提示「查看他人私有记忆会被记录」（对应 [06 §5.3](./06-prompt-and-memory.md#53-隐私细节)）。
- 待审压缩 diff（`memory/.pending/`）在此显示 `[应用] [丢弃]`。

### 3.5 Provider 与模型
- Provider 表：名称、类型、base_url、key hint、启用、健康状态（`UiTag`）、`[测试连接]` `[拉取模型]` `[编辑]` `[删除]`。
- 编辑对话框：类型下拉、base_url、**API Key 写入型输入**（占位符 `保持不变`）、自定义 headers（键值表格）、`[测试连接]`（用对话框里尚未保存的 key/base_url 试，不写健康状态）。
- `[测试连接]` 的结果与所有 provider/模型写操作的反馈走**右上角 `ToastHost`**（滑入、到点自动消失、可手动关掉，最多同时留 5 条），不再用顶栏的静态横幅：连通时显示耗时与上游返回的模型数，失败时显示错误类型与上游消息摘要。详见 [04 §5.4](./04-agents-and-providers.md#54-密钥管理)。
- 模型表：model_id、Provider、context_window、**能力标签**（看图 / 读 PDF / 工具 / 结构化输出 / 思考档位，来自 `capabilities_json`）、
  两个价格字段（每行标出定价出处：`provider 自报价` / `厂商官方价` / `手工填写`；为空时红字提示「缺定价 · 花费按 0 记账」）、启用、排序。
  表头的 `[补齐元数据]` 对**已入库**的模型重跑一次匹配：能力块照写，**价格只填空着的**（已填的不覆盖），
  窗口/最大输出默认不动（运维可能按预算调小过），走 `POST /api/models/enrich`。
- `[从 Provider 拉取模型]`：选 provider → 调 `GET /api/providers/:id/models` 拿上游模型目录 → 带搜索框的多选表格（**不做白名单过滤**，上游返回什么就列什么；已在库中的行灰显且不可勾选）→ 勾选若干 → `POST /api/models/import` 批量落库。
  每行同时展示窗口/最大输出、价格、能力标签与**定价出处徽标**，数据来自 models.dev 的本地缓存目录（[04 §5.4.1](./04-agents-and-providers.md#541-模型元数据目录modelsdev)）：
  - 窗口/最大输出：上游自己给了（Google）就用上游的（它是那台机器上的事实），没给才用目录补，再没有才用对话框顶部的默认值 —— 每行标明是哪一种。
  - 价格：只在能确定出处时带入（provider 自报价 > 厂商官方价）；只有第三方托管报价的模型**价格留空**，行上给出区间（如「第三方 $0.2–$0.4（2 家），需手填」）。
  - 对话框顶部常驻一条目录状态：缓存了多少模型、多久前更新、是否已过期，以及 `[刷新目录]`（`POST /api/models/catalog/refresh`，带 `If-None-Match`，没更新时提示「models.dev 上没有更新」）。
    目录不可用时这条会说明原因，并提示窗口与价格都要手填 —— 而不是让人对着一片空白猜为什么没有价格。
- **别名管理**：表里**六个内建别名常驻**（`main`/`high`/`low`/`vision`/`title`/`embed`），没配的显示
  「未配置」+ 该别名的用途说明与 `[配置]` 按钮 —— 运维不该靠读文档才知道要填哪几个别名、各是干什么的。
  每行展示解析后的 fallback 链（`provider/model_id`，链里指向已删除或已停用模型的分段标红）与采样参数摘要。
  编辑对话框：别名下拉（内建六选一或自定义，选中即显示用途说明）、`ChainPicker` 选模型组 fallback 链（拖拽或上下按钮排序）、
  采样参数**逐字段表单**（[04 §5.2.1](./04-agents-and-providers.md#521-别名参数settings_json) 的白名单，
  常用三项常驻、其余进可折叠的「高级」区，每项写明取值范围，留空 = 用 provider 默认）。
  不再暴露裸 JSON 文本框：白名单之外的键本来就会被服务端拒，让人手写 JSON 只是把报错推迟到保存那一刻。
  缺少 `main` 别名时整页红色警示。`[删除]` 走 `DELETE /api/aliases/:alias`（否则打错的别名永远留在表里）。
- `[导入]`：粘贴 JSON 批量导入 provider+模型+定价（导出同格式，便于备份/迁移）。
- 每个模型行显示近 7 天调用次数与花费（来自 `usage_ledger`）。

### 3.6 主体与权限（Principals）
- 表格：kind、tg_id、显示名/username、角色、首次出现、最后活跃、消息数、今日花费、备注。
- **子导航把用户与群聊分开**（全部 / 用户 / 群聊，每项带计数）：两者的语义不同 ——
  会话角色只是上限，群里某人的有效角色 = min(他自己的角色, 该群的角色)，混在一张表里看不出来。
- 点任一行打开二级菜单（`UiModal`）：只读展示 kind / tg_id / 显示名 / username，
  角色下拉可改并写明该角色意味着什么；升到 `owner` 时额外警示「跳过审批与沙箱」。
  保存走 `PATCH /api/principals/:id`，下一轮生效并写审计日志。
- **表格每行带勾选框**，选中若干行后表格上方出现批量条（已勾选数 + `[清空勾选]` + `[批量改角色]`）：
  对话框里选目标角色、列出被选中的主体（类型 / 名字 / 当前角色）、写明该角色意味着什么，
  保存走 `POST /api/principals/roles`。一次新进十几个人时逐行点开改角色是纯粹的重复劳动。
  切换「全部 / 用户 / 群聊」子导航会清空勾选（跨 kind 的批量在语义上是两回事）。
- 引导 owner（`access.bootstrapOwnerId` 指向的那一行）在表里带 `引导 OWNER` 徽标，
  批量改角色时若选中了它且目标不是 owner，对话框里红色提示「降级之后 Telegram 那边没人能管 bot」。
  另外**引导 owner 的显示名与用户名只能由 Telegram 那边写**：启动时的 `ensureOwner` 只在行不存在时插入占位的 `Owner`，
  已存在的行一个字段都不动 —— 早先它走 `upsertSeen`，每次重启都把真名冲回 `Owner` / 空用户名。
  顶栏右上角显示的也是这一行的真实显示名与 `@username`（不再是写死的 `OW`），点一下跳到主体页。
- `[批量导入]`：粘贴 Telegram **数字 ID** 列表（换行/空格/逗号分隔，去重）+ 类型 + 目标角色，
  一次性登记还没跟 bot 说过话的人。前端先标出非法 ID（`@username`、非数字），
  服务端再校验一次；**已存在的主体必须真的改角色** —— `upsertSeen` 的 `ON CONFLICT` 分支
  刻意不动 `role`（避免每条消息把手工设的角色冲掉），只调它会「导入成功」却什么都没变，
  所以写入端对已存在的行**改为只调 `setRole`**（连 `upsertSeen` 都不再调：它的 `ON CONFLICT`
  会把这里仅有的 `null` 写进 `display_name`/`username`，把真名清空），返回 `{count, created, updated}`。
- 权限矩阵只读视图：把 `TOOL_POLICY` 渲染成 [05 §4](./05-tools-and-permissions.md#4-权限矩阵权威表) 那张表，便于核对；可切「以某角色视角」预览可用工具集。

### 3.7 工具与沙箱
- 工具表：名称、来源（builtin/plugin/skill/mcp）、minRole、审批策略、作用域、启停状态、近 7 天调用次数与失败率、平均耗时。
  `GET /api/tools` 除策略外还返回每个工具当前的 `enabled`（来自 `tools.overrides`）——
  只给静态策略表的话，页面显示的东西与运行时无关。
- 点任一行打开二级菜单（`UiModal`）：来源 / minRole / 审批 / 作用域**只读**并注明它们来自代码里的
  单一策略源 `TOOL_POLICY`（注册期 fail-closed）；**能从界面调低某个工具的最低角色等于把权限矩阵
  变成两份会漂移的真相**，所以这里唯一可写的是启停。停用是硬边界：既从工具目录移除，
  `ToolRegistry.execute` 也二次拦截返回 `tool_disabled_by_operator`。
- 沙箱设置：`mode` 单选（含 docker 可用性探测结果）、镜像名 + `[拉取/构建]`、资源限制、网络、`bypassRoles`（多选）、超时。
- `allowHostFsForOwner` 开关带红色确认对话框。
- 审批规则编辑器（`DataGrid` 行内编辑）：tool 匹配、正则、风险级别、`[测试正则]`（输入样例命令看是否命中）。

### 3.8 扩展（Skills / Plugins / MCP）
- **Skills**：卡片/表格列出 name、description、min-role、allowed-tools、token 占用、状态（解析错误显红）。`[编辑]` 打开 frontmatter 表单 + 正文编辑器；`[新建]`；`[启停]`；`[查看附属文件]`。
- **Plugins**：name、version、minRole、启用（默认关，开启时弹「plugin 以全信任方式运行任意代码」确认）、`configSchema` 生成的表单、provides 概览（工具/钩子/命令/agent）、`load_error`、`[重载]`。
- **MCP**：server 列表 + 状态、transport 配置表单、发现到的工具清单（含 inputSchema 预览 `UiModal`）、allow/deny glob、`[重连]`、最近错误。

### 3.9 子 Agent（Agents）
- 表格：name、description、modelAlias、maxSteps、tools、minRole；`[新建 Agent]` 在页头。
- 点任一行打开二级菜单（`UiModal`）：名称（新建时可填，之后只读 —— 模型用它调 `spawn_agent`）、
  职责描述、模型别名（下拉取自别名路由表）、minRole、步数上限、结果最大字符、`injectMemory`、
  可用工具多选（全不勾 = 不额外限制，沿用父 agent 在当前角色下的工具目录）、`instructions` 编辑器。
  对话框里同时提供 `[删除]`。
- 保存写的是**整张 `agent.agents` 数组**（`PUT /api/config`，点分键 `agent.agents`）：
  没有单条 PATCH 端点，而这个数组本身就是一个 schema 叶子，写入时整体过 `configSchema` 校验。
- `AgentManager` 的定义表只在构造时读一次，因此 `config.changed` 里带 `agent.agents` 时
  必须 `replaceDefinitions()`；否则运维看到的是「保存成功但派发的还是旧的」。
- `[试跑]`：给定 task 文本，直接派发一次并在 `UiModal` 里流式展示步骤/工具/结果与花费（不进任何会话上下文）。

### 3.10 日志（Logs）
- 过滤器：时间范围、level、kind（多选）、trace_id、chat、user、关键词。
- 虚拟滚动表格；`[实时]` 开关走 SSE 追加。
- **Trace 视图**（重点）：输入/点击 `trace_id` → 树形展开（树形控件）：
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
- **触发与唤醒词**卡片（已实现）：`private` / `mention` / `reply` / `command` / `channels` 五个开关、
  唤醒词增删（每条标注「包含 / 正则」，不会生效的标红并写明原因）、`wakewordMinLength`、
  `requireTextAfterMention`、`ignoreEditedAsTrigger`。可用性判定打 `POST /api/config/wakewords/check`，
  与运行时匹配共用 `checkWakeword`（[08 §4](./08-telegram-adapter.md#4-触发判定)）；保存走 `PUT /api/config` 的点分键，
  热更新即时生效。列表里有不可用模式时保存会被服务端拒绝（`invalid_wakeword`）并把原因回显在 Toast 上。
  日志 SSE 会不断触发页面刷新，表单在有未保存改动时不被回写覆盖。
- **输出节奏**卡片（已实现）：`output.mode`、`replyDelayMs`（防秒回，锚点是用户那条消息）、
  `streamBufferMs`（首帧缓冲，锚点是上游第一个 chunk）、`streamIntervalMs`、`streamMinDeltaChars`。
  两个锚点的区别写在字段说明里 —— 只调 `replyDelayMs` 治不了「第一条消息只有一个字」
  （[08 §5.2](./08-telegram-adapter.md#52-流式算法)）。保存同样走 `PUT /api/config` 的点分键，
  下一轮回复生效；在途那一轮沿用开轮时的值。同样有未保存改动时不被 SSE 刷新回写。
- 会话级覆盖（`perChat.<contextKey>.trigger`）优先于全局值，目前只有 `PATCH /api/chats/:key` 这一个入口，设置页不提供。
  `perChat.<contextKey>.output` 同理（投递侧读的就是本轮合并后的那份配置）。
- 由 `config.schema.json`（zod → JSON Schema）**自动生成**表单：分组折叠面板（折叠面板），每项含描述、默认值、当前值、是否需要重启（`Tag: 热更新 / 需重启`）。🚧 未实现，当前只在卡片下方展示只读的合并配置 JSON。
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
| `GET /api/chats` `GET /api/chats/:key` `PATCH /api/chats/:key` | 会话（PATCH 改 scope/唤醒词/覆盖项）。PATCH body 必须通过 `configSchema` 与 [11 §2.1](./11-config-reference.md) 的 `perChat` 白名单，越界返回 400；带 `trigger` 时唤醒词还要过 `checkWakeword`，不可用返回 `invalid_wakeword` |
| `GET /api/chats/:key/context` | 当前窗口消息（分页） |
| `GET /api/chats/:key/commits` | commit 时间线 |
| `POST /api/chats/:key/commits/:id/checkout` | 回滚 done 指针 |
| `POST /api/chats/:key/reset` `POST /api/chats/:key/undo` | 等价 `/new` `/undo` |
| `GET /api/messages` `GET /api/messages/:id` `DELETE /api/messages/:id` | 消息检索（`?q=` 走 FTS）。列表结果里 `turnId` 会回填：触发消息自己不带 `turn_id`（只有回复落盘才写那一列），但检索命中后最想点开的正是它那一轮，所以按 `turns.trigger_message_id` 反查补上 |
| `GET /api/turns` | 最近的模型对话，按 turn 聚合：`?page=1&size=20`（size 上限 100）→ `{items, total, page, size}`。每项带触发消息正文（`prompt`）与该轮 bot 回复（`reply`，按内容去重）、状态、步数/工具数/token/花费。分页走 SQL `LIMIT/OFFSET` |
| `GET /api/turns/:id/detail` | 一次对话的**实际调用载荷**：`{turn, captureBodies, events:[{id, ts, level, kind, summary, spanId, parentSpanId, durationMs, text, bytes, truncated, fileRef}]}`。`events` 是 `log_events` 里 `trace_id = turn id` 的全部 span（上限 500 条，按时间序）；`text` 是格式化后的 `data_json`，单条超过 120k 字符截断并置 `truncated`。超过 `logs.bodyMaxBytes` 的载荷已被 `LogSink` 挪进 `logs/<day>/blobs/*.json`，这里**解引用后再返回**（不然详情里只剩一行 `{"fileRef":…}`）；blob 已被保留策略清掉时 `text=null` 且保留 `fileRef`。turn 不存在返回 404 |
| `GET /api/logs/:id/data` | 单条日志事件的完整载荷（`application/json` 附件下载），blob 同样解引用。详情视图里的 JSON 会被截断，复制与下载必须拿到完整那一份 |
| `GET /api/files/:attachmentId` | 附件下载（校验 session） |
| `GET /api/prompts` `GET /api/prompts/:id` `PUT /api/prompts/:id` | 提示词/记忆文档 |
| `GET /api/prompts/:id/revisions` `POST /api/prompts/:id/rollback` | 版本 |
| `POST /api/prompts/preview` | 组装预览（body: `{key, role}`） |
| `GET/POST/PATCH/DELETE /api/providers[/:id]` | Provider |
| `POST /api/providers/:id/test` | 测试连接：按 kind 向上游模型目录接口发一次 GET（15s 超时），返回 `{reachable, code, message, status, latencyMs, models}`（`models` 是数量，不是列表）。body 可选 `{apiKey, baseUrl, kind}` 覆盖库里的值，用于测试尚未保存的配置。**只有不带覆盖的测试写健康状态**：成功写 `health_state='up'` 并清空 `health_error`（这是 `down` 的唯一人工恢复路径），401/403 写 `down`，其余失败只更新 `health_checked_at` —— 网关缺 `/models` 不等于对话不可用，不能因此把可用的 provider 摘掉 |
| `GET /api/providers/:id/models` | 拉取上游模型目录并用 models.dev 的本地缓存补齐元数据，返回 `{models:[{modelId, displayName, contextWindow, maxOutput, limitSource, priceIn, priceOut, priceCacheRead, priceCacheWrite, meta}], latencyMs, catalog}`。`meta` 是匹配结果（`match`/`catalogProviderId`/`catalogModelId`/`normalized`/`capabilities`/`reasoningControl`/`reasoningEfforts`/`modalities`/`priceRange`，见 [04 §5.4.1](./04-agents-and-providers.md#541-模型元数据目录modelsdev)），目录不可用时整块为 `match:'none'` 的空值而不是编造。上游不可达时返回 `502` + 错误 code |
| `GET /api/models/catalog` | models.dev 缓存状态：`{enabled, available, stale, ageMs, ttlHours, fetchedAt, etag, providers, models, path, error}` |
| `POST /api/models/catalog/refresh` | 强制续期一次（带 `If-None-Match`）。返回状态 + `outcome`：`fetched` / `not-modified` / `stale`（出网失败但旧缓存可用，仍返回 200）；**完全没有缓存又拉不到**才 `502 catalog_unavailable` |
| `GET/POST/PATCH/DELETE /api/models[/:id]` | 模型。`PATCH` 动到任一价格字段时，会把 `capabilities_json.catalog.priceSource` 翻成 `manual` |
| `POST /api/models/import` | 从上游目录批量落库：`{providerId, models:[{modelId, displayName?, contextWindow?, maxOutput?, priceIn?, priceOut?, priceCacheRead?, priceCacheWrite?}], contextWindow?, maxOutput?}`，单次上限 200 条。**能力块与定价出处一律在服务端重新解析**（请求体里的 capabilities 是客户端说的，落库的必须是目录里实际有的那条）。已存在的 `(provider_id, model_id)` 跳过而不是覆盖（不能把已调好的定价冲掉），返回 `{inserted, skipped, priced, ids}` |
| `POST /api/models/enrich` | 给已入库的模型补元数据：`{ids?: string[], overwrite?: boolean}`（不给 `ids` 就是全部）。能力块照写；**价格只填 `NULL` 的那几个**，已有价格保留并把出处标成 `manual`；窗口/最大输出只有 `overwrite:true` 才覆盖。返回 `{scanned, updated, priced, unmatched}`；目录完全不可用时 `502 catalog_unavailable`（不能拿空值把现有行洗掉） |
| `GET/PUT/DELETE /api/aliases[/:alias]` | 别名、fallback 链与采样参数。`PUT` 校验别名名（`^[a-z][a-z0-9_-]{0,31}$`）、链非空且模型存在、`settings` 过 `aliasSettingsSchema`（[04 §5.2.1](./04-agents-and-providers.md#521-别名参数settings_json)），任一不过返回 `alias_invalid` + 具体路径 |
| `GET/PATCH /api/principals[/:id]` | 主体与角色 |
| `POST /api/principals/bulk` | 批量登记主体：`{ids:[…], kind: user\|chat, role}`，单次上限 500。ID 必须是 Telegram 数字 ID（`^-?\d{1,20}$`），非法 ID 或非法角色返回 400。已存在的主体**只补一次 `setRole`，不再走 `upsertSeen`**（`ON CONFLICT` 分支不动 role 但会照写 `display_name`/`username`，而这里手上只有 `null`，等于把 Telegram 同步来的真名清空），返回 `{count, created, updated}` |
| `POST /api/principals/roles` | 勾选批量改角色：`{ids:[主体 id…], role}`，单次上限 500。**只改已存在的行，不新建**（新建走 `/api/principals/bulk`，那边收的是 Telegram 数字 ID）；库里找不到的 id 原样回报而不是静默跳过，返回 `{count, changed, missing}` |
| `GET /api/tools` `PATCH /api/tools/:name` | 工具启停。`GET` 在静态策略之外一并返回当前 `enabled`（来自 `tools.overrides`）。`PATCH` 写入 `tools.overrides.<name>.enabled`；被禁用的工具从工具目录消失，且 `ToolRegistry.execute` 会二次拦截并返回 `tool_disabled_by_operator`。未知工具名返回 404 |
| `GET/PUT /api/sandbox` `POST /api/sandbox/probe` | 沙箱配置与探测 |
| `GET/POST/PATCH/DELETE /api/skills[/:name]` | Skill（含正文读写） |
| `GET/PATCH /api/plugins[/:name]` `POST /api/plugins/:name/reload` | Plugin |
| `GET/POST/PATCH/DELETE /api/mcp[/:name]` `POST /api/mcp/:name/reconnect` | MCP |
| `GET /api/agents` `POST /api/agents/:name/dryrun` | 子 agent。**写不走单条端点**：定义存在配置里，新增/编辑/删除都是把整张 `agent.agents` 数组经 `PUT /api/config` 写进覆盖层，由 `configSchema` 统一校验 |
| `GET /api/logs` `GET /api/logs/trace/:traceId` `GET /api/logs/blob?ref=` | 日志 |
| `GET /api/usage` `GET/PUT /api/quota` `POST /api/quota/reset` | 用量与配额 |
| `GET /api/tasks` `POST /api/tasks/:id/cancel` | 任务 |
| `GET /api/approvals` `POST /api/approvals/:id/decide` | 审批。🚧 当前没有可用的审批通道，命中规则的调用当场被拒（[05 §6](./05-tools-and-permissions.md)）：列表是审计视图（谁在什么时候被挡了），`decide` 对非 pending 行返回 `changed:false` |
| `GET /api/config` `PUT /api/config` `GET /api/config/schema` `GET /api/config/revisions` | 配置。`PUT` body 为点分键；含 `__proto__`/`constructor`/`prototype` 段的键一律 400 `invalid_config_key`（原型污染发生在校验之前，一次请求就能让此后所有配置写入失败，docs/20 · W-CFG-01）；动到 `trigger.*` 时唤醒词要过 `checkWakeword`，不可用返回 400 `invalid_wakeword`。`/schema` 另带 `hotReloadable` 与 `unimplemented` 两个键名前缀表：不在 `hotReloadable` 里的键保存后需要重启才生效，WebUI 据此显示待重启徽标（[11](./11-config-reference.md)） |
| `POST /api/config/wakewords/check` | 逐条返回唤醒词的 `{ kind: contains\|regex, ok, reason }`，供面板即时提示；判定与运行时匹配同源 |
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
    ├── main.ts                createApp + router + pinia（无 UI 框架插件）
    ├── styles.css             设计变量（浅/深两套 + 字体栈）+ 全站样式，唯一的样式来源
    ├── router/index.ts        路由 + 全局守卫（未登录 → /login）
    ├── stores/
    │   ├── auth.ts  events.ts（SSE 单例）  dashboard.ts  chats.ts
    │   ├── providers.ts  logs.ts  usage.ts  config.ts  approvals.ts
    ├── api/client.ts          fetch 封装：CSRF 头、401 跳登录、统一错误 toast
    ├── ui/                    自建原语，全部只用 styles.css 的变量
    │   ├── toast.ts           pushToast()：全站唯一的通知通道
    │   ├── ToastHost.vue      右上角通知栈（success/info/warn/error）
    │   ├── UiButton.vue  UiTag.vue  UiSelect.vue  UiNumber.vue
    │   ├── DataGrid.vue       表格：列定义 + 具名插槽 + 分页 + 单/多选
    │   ├── UiModal.vue  UiDrawer.vue  ChainPicker.vue
    ├── components/
    │   ├── StatusBar.vue  RoleTag.vue  TokenMeter.vue  CostBadge.vue
    │   ├── ContextViewer.vue  CommitTimeline.vue  TraceTree.vue
    │   ├── DiffView.vue  SecretInput.vue  SchemaForm.vue（config.schema → 表单）
    └── views/                 每个 §3 页面一个 .vue
```

- **不引入第三方 UI 框架**。组件框架自带的主题（此前是 PrimeVue + Aura）与总览页那套手写卡片是两套并行的视觉系统，
  同一个页面上会同时出现两种圆角、两种输入框、两种阴影；调它的 CSS 变量只能逼近、不能对齐。`src/ui/` 下的原语
  直接用 `styles.css` 的 `--surface` / `--border` / `--primary` 等变量，深浅色跟随 `<html class="dark">` 一处切换。
- **通知只有一种**：任何写操作的成败反馈都走 `pushToast()`（[§3.5](#35-provider-与模型) 的 `[测试连接]` 是基准样式），
  不再有第二套「顶栏静态横幅」。页内校验类提示（登录失败、别名链有失效模型）仍用 `.callout` 内联块，因为它们要跟着表单走。
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
- **字体自托管，不许连外网**：CSP 是 `default-src 'self'`，`fonts.googleapis.com` 的 `@import` 会被整条挡掉 ——
  表现是本地 dev 好好的、线上悄悄退回系统字体。字体走 `@fontsource/fira-sans`（latin 400/600/700）+
  `@fontsource-variable/fira-code`（latin 可变字重，一个文件覆盖 300–700），由 `main.ts` 引入、Vite 打进
  `dist/assets`，浏览器只取 latin 子集（≈110 kB，`immutable` 缓存）。中文字形本来就靠系统回退，Fira 没有 CJK。
  字体族名只写在 `styles.css` 的 `--font-sans` / `--font-mono` 两个变量里，换字体不用再全文替换。
