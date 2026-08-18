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
- 失败限流：同 IP 连续失败 `webui.loginRateLimit.attempts` 次 → 锁 `windowMinutes` 分钟（内存计数 + 日志 `warn`）。
  IP 的来源分两种，判据只看 `webui.trustProxy`：
  - `true`：取 `X-Forwarded-For` 按 `webui.trustedProxyHops` **从右往左**数的那一跳（最左一跳由客户端
    自己填，取它等于没有限速），取不到时退回 `X-Real-IP`，再没有记 `direct`。
  - `false`（默认，直连）：**一个请求头都不看**，只用连接的远端地址（`getConnInfo`）；拿不到就全落进
    常量桶 `local`。桶键要是请求头，限流的代价就只是「再换一个头值」—— [18 · N-WEB-02] 修过一次并
    写明「`trustProxy` 为假时恒返回 `local`」，后来丢了这一半，[27 · S-01] 实测 12 次轮换 `X-Real-IP`
    全部 401、一次 429 都没有。回归用例在 `tests/server.test.ts`（`trustProxy=false` 那条）。

  单 IP 桶之外还有一个全局失败窗口，触发后所有登录请求先延迟 250ms 再校验 —— 换 IP 绕过要付出代价，
  而不是把 owner 一起锁死。失败表上限 1024 条。
- **请求体上界**：`/api/*` 全局挂 hono 的 `bodyLimit`，默认 1 MiB；`PUT /api/config/yaml` 与
  `POST /api/models/import` 放宽到 4 MiB、`PUT /api/prompts/:id` 到 2 MiB，超出回 `413 payload_too_large`。
  它必须挂在**鉴权中间件之前**：`/api/setup` 与两条登录端点注册在鉴权之前，未登录就能推一个任意大的
  请求体进来，而 `login` 那条 `password.length > 1024` 的检查发生在 `await ctx.req.json()` **之后**
  （[27 · S-05]）。`login` / `setup` 仍在进 argon2 之前拒绝超过 1024 字符的口令。
- **改口令**：`POST /api/auth/password {current, next}` → 校验旧口令 → argon2id → 写 `config_kv` +
  `config_revisions` → **吊销除当前会话外的全部 session**（`DELETE FROM sessions WHERE id<>?`）→ 发
  `config.changed`。校验一律现读配置，热重载落地后不再认任何进程内缓存；不重启也生效。
  `pnpm webui:passwd` 仍可用于线下生成哈希。**界面上暂时还没有这个表单**，当前只能打 API（见 [21](./21-webui-coverage-gaps.md)）。
- 登出删除 session 行，入口是顶栏最右侧的 `[退出登录]` 图标按钮（打 `POST /api/auth/logout` 后跳 `/login`；
  端点早就有，界面上一直没有入口，只能等 session 过期或手删 cookie）。`GET /api/auth/me` 返回登录态、到期时间**与本 session 的 `csrf`** —— 前端只把 token 放在内存里，刷新页面后必须靠这个端点补回来，否则刷新之后所有写操作都会 403。跨站拿不到它：既过不了 Origin 中间件，也读不到响应体。
- Session 滑动续期：每次请求更新 `last_seen_at`，超过 `sessionTtlHours` 未活动则失效。

### 2.2 单角色

WebUI 只有一个身份 = **owner**。不做多用户/RBAC（记入 [14](./14-open-questions.md)）。所有 API 都以 owner 权限执行，因此**必须**默认绑回环。

### 2.3 Telegram 一次性登录链接

**已实现（第五轮）。** `/webui`（**仅 owner 私聊**）→ `issueLoginToken()` 签发 5 分钟有效的一次性
token → 回一条 `<webui.publicUrl>/login?t=<token>` → 前端拿它打 `POST /api/auth/token` 换 session。

- token **存内存**，进程重启即失效，而且这就是它该有的语义：一条能换取 owner 全权限 session 的
  链接落进数据库或日志，泄露面比口令本身还大。所以服务端**不记 token 本身**，只记「用掉/失败」。
- 三道闸：单次使用（取出即删，错的 token 也不留给人反复试）、5 分钟过期、签发表有界（最多 16 个未用）。
- 群里不给：`/webui` 在非私聊里直接回「这个命令只在私聊里用」——登录链接出现在群里等于把 owner
  权限递给屏幕前所有人。
- `webui.publicUrl` 没配时**明说生成不出来**，而不是发一条打不开的链接。
- **三者由 CI 断言锁死**（`tests/trigger.test.ts` 的 `keeps /webui wired on both sides`）：
  `HANDLED_COMMANDS` + `bot.command('webui')` + `issueLoginToken` + `POST /api/auth/token` +
  该端点在鉴权中间件的放行名单里。上一轮就是因为「名字留在白名单里但服务端没写」才把它整个摘掉的
  （docs/20 · W-TG-01）。

---

## 3. 页面清单

全站共用 §6 的自建组件与 `styles.css` 的设计变量，视觉基准是总览页：左侧固定深色导航 + 顶栏（状态灯：bot 连接 / provider 健康 / 在途 turn 数 / 今日花费；右上角是引导 owner 的真实显示名与 `@username`），内容区一律是 `.surface` 卡片。

### 3.1 Dashboard
- 实时卡片：在途 turn、今日 turn 数、今日花费（四张指标卡是**累计值**）。
- **近 7 天趋势**（已实现）：消息量与轮次数的折线图，按 `general.timezone` 的**本地日**分桶
  （与配额 bucket 同一个时区口径，否则东八区会看到每天的量在早上八点断开）。没有数据的那天
  补 0 而不是跳过 —— 折线图上「那天没有点」和「那天是 0」是两回事。
- **额度环形图**（已实现）：只画 `global` 档的当前 day / month 两个环。chat / user 是按主体分的
  很多行，挤在总览上读不出东西 —— 那是配额页的表要干的事。`limit === null` 时**不画环**只写
  「不限」：一个永远填不满的圈让人分不清是快用完了还是还早。
- **在途 turn 表**（`DataGrid`，SSE 增量更新，已实现）：发起人（按 `principals` 反查显示名）+ 角色、
  contextKey、当前动作（`turn.progress` 给的「第 N 步 · 模型 / 工具 · 载荷摘要」）、步数与花费、
  已用时长（每秒走字）、`[取消]`。首屏走 `GET /api/turns/active`，之后靠 `turn.started` /
  `turn.progress` / `turn.finished` 增量更新。
  **数据来自进程内的 `TurnRegistry`，不是 `turns` 表** —— 崩溃残留的 `running` 行要等下次启动的
  `recoverAfterCrash` 才归零，只读表会把它们也画成「正在跑」。
  `[取消]` 打 `POST /api/turns/:id/cancel`：那是 abort 信号不是删除，该轮走 `abortTurn` 落成
  `cancelled`，上下文与已发出的消息都还在；二次确认里写明这一点。轮次已经结束时返回
  `{cancelled:false}`，界面说「这一轮已经结束了」而不是假装成功。
- **最近错误**（已实现）：`GET /api/logs?minLevel=warn&size=10`，点一行跳到日志页并展开那条 trace。
  过滤在**服务端**：在前端过滤会因为日志页只取了最近 200 条而漏掉更早的错误。此前这里是不分级别
  的最近 6 条，实际上永远被 info 刷满 —— 一张「最近错误」卡片看不到错误。
- **依赖健康卡片**（已实现）：DB 读写、SSE 连接、模型注册表可用数、在途 turn 数、MCP 就绪 / 异常数、
  沙箱 `mode` 与可用性（`plan.reason` 挂在 title 上），外加版本与运行时长。
  数据一律取 `GET /api/health/detail` —— **这几行以前是写死的文本**（沙箱恒显示「Docker」，
  与 `sandbox.mode` 无关），显示的东西与运行时无关比不显示更糟。
- **系统信息里的 DB / WAL / workspace 占用**（已实现，走 `/api/health/detail`）：**只统计不清理**
  —— 这三行是「该不该去点维护操作」的判据，自己动手会让一个读端点带上副作用。目录递归有深度上界
  （8 层）：workspace 里放着模型自己造的目录树，一个软链自指就能让这次请求不返回。

### 3.2 会话（Chats）
- **会话列表是卡片而不是表格**：表格里最靠左的一列是 `chat:-1002492583774`，运维认不出这是哪个群。
  每个会话一张卡片，第一行就是**这是谁** —— 群聊显示群组名、私聊显示对方昵称。名字来自 `principals`
  （群走 `chat:<id>` 的 title；私聊优先取 `user:<id>` 的全名，`chat:<id>` 对私聊只存了 first_name），
  没登记过的会话退回 `未登记群聊/用户 <id>`，并按 Telegram 的「群/频道 id 一律为负」判断类型。
  第二行是 `@username`，没有用户名时改写会话类型（超级群 / 频道 / 私聊）—— 不重复下面那行 contextKey。
  卡片底部是 contextKey、消息数与窗口 token；`contextScope='thread'` 的会话多一个「话题 N」徽标。
- 选中一张卡片后，先是**「只对这个会话生效的设置」**卡片（已实现，`PATCH /api/chats/:key`）：
  当前覆盖以 chip 逐条列出（点分路径 + 值 + `[✕]` 取消覆盖，取消后空掉的中间层一并收掉），
  `[编辑覆盖项]` 展开的是同一套 schema 生成表单，但**只渲染 [11 §2.1](./11-config-reference.md) 白名单内的子树**
  （`trigger.*` / `output.*` / `context.scope` / `context.limit.*` / `context.background.*` /
  `agent.main.*` / `memory.pubWriteMinRole`）—— 白名单是安全边界，越界的路径服务端直接 400。
  控件里显示的是这个会话**实际生效**的值（全局 + 覆盖），改动才写进覆盖层；覆盖在下一轮生效。
  `PATCH` 是**整体替换**而不是合并，所以界面每次都把完整的覆盖对象发回去。
  `context.scope` 这一项带警告：改成 `thread` 之后该会话的后续消息落到新的 contextKey 上，
  而覆盖是按 key 存的 —— 等于这条覆盖把自己作废了。
  覆盖 chip 上方还有一条**会话模型别名**提示（已实现）：Telegram 的 `/model` 写的是 `app_kv` 的
  `modelAlias:<contextKey>`，它**压过**这里的 `agent.main.modelAlias` 与全局值（`runtime.ts` 先读它）。
  它存在时给黄色提示 + `[清除会话别名]`（`DELETE /api/chats/:key/model-alias`）—— 否则「改了模型别名
  不生效」在界面上完全无迹可寻（[21 · G-API-14](./21-webui-coverage-gaps.md)）。
  另有一个**独立的「会话人格文件」输入行**（`perChat.<key>.character`）：它在白名单里、运行时也真的
  读它（`assembleMainPrompt` → `PromptDocuments.paths`），但**不是 schema 叶子键**
  （`perChat` 是 `z.record(z.unknown())`），schema 生成的表单渲染不出来，所以单独给一个控件。
  只收 `memory/` 下的纯文件名（`.md` 结尾、不含目录与 `..`）—— 那个值会被当成路径段用；
  不合格时服务端**静默退回全局 `CHARACTER.md`**，因为一个拼错的文件名不该让整个会话开不了轮次
  （[27 · C-08](./reviews/27-full-scope-review.md)）。留空 = 取消这条覆盖。
- 再往下是并排的两块工作台：
  1. **上下文查看器**：当前窗口的消息序列，**按时间倒序 —— 最新的一条在最上面**（与消息页、commit
     时间线一致；ordinal 在提交时单调分配，倒排 ordinal 即倒排时间）。每条是一行徽标（ordinal、role、
     origin、speaker、时间、tokens、`prune_level`）+ 一行正文，正文永远占满整行：徽标数量是可变的
     （REBASED / 已移出窗口按需出现），用固定列数的网格排会把正文挤成 min-content 的竖排。
     被裁剪/降级的条目灰显并可展开原文；`rebased` 消息打红色徽标（`UiTag`）并显示「未见 ordinal 5–6」。
  2. **Commit 时间线**：列出 commits（seq、kind、window、head、tokens、rebased、base≠parent 时的对比）。
     操作：`[查看快照]` `[回滚到此]`（当前 HEAD 那一行禁用）。
     卡片顶部是**「改这个会话的 HEAD」**：`[撤回上一次提交]`（= `/undo`，HEAD 已是首个 commit 时禁用）与
     `[清空上下文窗口]`（= `/new`，二次确认）。这两个动作只对「当前选中的会话」有意义，放在页头时既看不出
     改的是谁也看不出改的是什么，因此跟它们操作的那张 commit 图放在一起，并在按钮上方写明二者都不删消息、
     走错了可以用同一张卡片里的 `[回滚到此]` 走回来。

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
  顶部一行是状态/会话/发起人/步数/token/花费/耗时，下面按「模型调用 / 工具与沙箱 / **工具输入输出** / 轮次与上下文 / 全部」分组
  列出该轮的全部 span，展开任一条看格式化后的载荷。`model.call` 的载荷里带 `request.body`，
  也就是真正发出去的请求体 —— turns 表只有统计、messages 表只有最终文本，**排查「模型到底收到了什么」只有这一份**。
  打开时默认落在模型调用并展开第一条。
- **长文本处理**：单条 span 的请求体动辄几十 KB，服务端按 120k 字符截断（置 `truncated`），载荷区固定高度自行滚动；
  `[复制 JSON]` 与 `[下载完整 JSON]` 都走 `GET /api/logs/:id/data` 取完整那一份（截断过的内容复制出去不是合法 JSON）。
  `logs.captureBodies` 关闭时详情里只有用量与耗时，页面顶部明说这一点，而不是显示一个空壳。
- **「工具输入输出」这一组读的不是日志，而是 `context_messages` 的原始 `parts_json`**
  （`contextMessages`，`origin IN ('tool_call','tool_result')`）。两个理由：日志按
  `logs.retentionDays` 清、`logs.captureBodies` 关掉时压根没有请求体，而 parts 永久保留；
  且它是**唯一对历史轮次有效**的来源（`LogSink.span` 修好之前落库的 `tool.call` 只有 output）。
  服务端直读列、刻意不走 `ContextRepository.messages()` —— 那条路会跑 `elidePart`。
  被裁剪降级过的行会打一个「模型现在看到的是占位符，下面是库里保留的原始 parts」的提示
  （分级降级只翻 `prune_applied` 标志位，原文一直在，[02 §5](./02-context-engine.md)）。
- 搜索结果表格多一列 `[详情]`，命中消息所属的那一轮同样能直接点开（服务端按 `turns.trigger_message_id` 回填 `turnId`）。
- **附件（已实现）**：对话卡片与检索结果行下面挂一条附件带子 —— 光栅图直接出缩略图，点开是大图
  （`GET /api/files/:id?inline=1`，白名单只有 png/jpeg/gif/webp，理由见 §4）；其余按类型出 chip，
  显示文件名 / mime / 大小 / 尺寸 / 时长，提取过正文的文档标「已提取正文」（模型当时读到的是正文）。
  `download_state` 不是 `done` 的行打「下载失败 / 超限未下载 / 已过期」徽标并**不给下载链接**
  （`expired` = 文件按 `media.retentionDays` 清掉了，元数据还在，[14 §2 Q9-a](./14-open-questions.md)）——
  点开必然 404，给一个必然报错的入口比没有更糟。
- **单条操作**：有 `turnId` 的消息可打开该轮实际调用；`[软删除]` 二次确认后调用
  `DELETE /api/messages/:id`，只设置 `deleted_at`，上下文提交、turn 与附件不级联删除；消息检索、
  turn 列表与详情均不再回显已删正文。

### 3.4 提示词（Prompts）

- 左侧是**文档卡片网格**：每张卡片显示用途、scope、字节数 / token 数、更新时间；文档 id、字符数、
  token 数与 scope 只作辅助信息，正文类型和磁盘路径用于区分实际 prompt block。
- `[预览组装]`：选择会话与角色后调用 `POST /api/prompts/preview`。后端与真实轮次共用
  `assembleMainPrompt`，返回 kernel / character / assist / catalog / public/private memory / runtime
  各 block 的完整正文、token 数与截断状态，并带该会话上下文消息数和 token 数。界面用分段条显示
  占比，逐块展开正文；这不是 `context.materialize()` 的近似值。
- 每块另标「缓存段 / 每轮重算」：稳定段（KERNEL/CHARACTER/ASSIST）走 `instructions` 里那条 system
  并带缓存断点，易变段（TOOL CATALOG/PUBMEMORY/PRIMEMORY/RUNTIME）挂在请求体最末尾、每轮重算
  （[06 §1](./06-prompt-and-memory.md)）。**预览把两段连着显示，实际请求里它们并不相邻** ——
  中间隔着整段对话历史，那正是这么排的目的。
  改人设会让缓存段整体作废一次，这个标记是让运维在动手前看得见这件事；开关工具或改 SKILL.md
  只动 TOOL CATALOG，已经不再牵连缓存段。
- 右侧编辑器显示正文、行号、估算 token、字节数；保存走 `PUT /api/prompts/:id`（Ctrl+S）。
- 标题下写明文档类型与磁盘路径。版本时间线来自 `GET /api/prompts/:id/revisions`，展示 unified diff，
  `[回滚到此版本]` 调 `POST /api/prompts/:id/rollback`。

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
- 沙箱设置（已实现，在工具表下方）：`mode` 单选、容器网络、镜像、`dockerBin`、工作目录与
  **宿主工作目录**、内存 / CPU / 进程数 / tmpfs、`readOnlyRoot`、`bypassRoles`（多选）。
  写走 `PUT /api/sandbox`（点分键相对 `sandbox`），`sandbox` 在热更新白名单里，下一次工具调用即生效。
  - `[探测可用性]` 打 `POST /api/sandbox/probe`，**探的是库里已保存的那份配置** —— 表单里改了还没存，
    探出来的仍是旧 `mode`，所以结果行里要写明这一点。
  - `mode=none` 保存前二次确认（exec 类工具将以 bot 进程的权限直接在宿主上执行模型给出的命令）；
    `bypassRoles` 里出现 owner 之外的角色时给出警示。
  - `GET /api/sandbox` 一并返回 `plan('owner')`：连 owner 都 `allowed:false` 时（例如进程在容器内
    却没配 `hostWorkspaceDir`）页面顶部出红条并写出 `reason`，否则运维只会看到工具莫名失败。
  - `[拉取镜像]`（`POST /api/sandbox/image`，已实现）：**只 pull 不 build**。build 要有 Dockerfile
    上下文、会跑任意构建指令、耗时以分钟计，那是部署动作不是控制台按钮。镜像名取自**已保存的配置**
    而不是请求体 —— 让人从界面上指定任意镜像等于绕开 `sandbox.image` 那道配置，而沙箱镜像决定了
    模型能在里面用什么。拉取有 10 分钟上界（这是一个同步等着的 HTTP 请求）。
  - `tools.fs.allowHostFsForOwner` 已接线（第五轮）：owner 的 fs 工具 jail 到 `/` 而不是会话
    workspace，`denyGlobs` 照样生效。**开关旁边必须有红色警示** —— 这是 [14](./14-open-questions.md) T8
    那条取舍的显式入口。
- **审批规则试跑**（`POST /api/approvals/test`，已实现）：给一个工具名 + 一条样例输入，逐条回报
  哪些规则命中、**为什么没命中**（工具名不匹配 / 正则不匹配 / 正则编译失败）、最终风险档位。
  判定用的是**运行时那份** `ApprovalRules`（共用 `compiled` 的编译结果）—— 在前端再实现一遍匹配
  必然漂移，而「以为配了审批其实永不命中」正是这条配置最容易出的错。`when: 'target_exists'`
  一律记成「取决于运行时」：试跑没有真实执行上下文，含糊其辞比编一个答案好。
  规则本身仍在「全部配置」的 `approval.rules` 里编辑。

### 3.8 扩展（Skills / Plugins / MCP）

三类扩展继续共用卡片网格，但操作按各自真实生命周期区分：

- **Skills**：name、description、min-role、状态、允许工具、模型建议与附属文件；可 `[新建]`、
  `[编辑]` 正文/frontmatter、启停和删除。`GET /api/skills/:name` 返回正文与文件清单；
  `POST /api/skills`、`PUT /api/skills/:name`、`DELETE /api/skills/:name` 直接安全写入或删除
  `SKILL.md`，随后重扫并同步数据库。新建时未指定 `min-role` 则热读 `skills.defaultMinRole`。
- **Plugins**：name、version、minRole、load_error；启用 plugin 会执行全信任代码，因此二次确认。
  启停与重载继续走 `PATCH /api/plugins/:name` / `POST /api/plugins/:name/reload`。
- **MCP**：卡片显示 transport、连接状态、失败原因、最小角色与发现到的工具名；可新建、编辑、启停、
  删除和重连。表单按 stdio / Streamable HTTP 切换 command、args、env 或 url、headers，并覆盖
  minRole、toolAllow、toolDeny、timeoutMs。CRUD 写入 `mcp.servers` 配置覆盖与 revision，发
  `config.changed` 后立即 `McpManager.reconcile()`；不是直接改运行时缓存。重名返回 409。
  **`mcp.enabled` 是总开关且出厂为 `false`**（`reconcile` 一上来就对它 early-return）：关着的时候
  页面顶部与新建对话框都给一条横幅加 `[打开总开关]`，保存后的 Toast 也说明「存下了但不会连」——
  否则运维拿到的是 `ok:true` 加一条永远停在「等待连接」的行，正是「保存成功但运行时没变」
  那类反馈（docs/20 · W-CFG-02）。

### 3.9 子 Agent（Agents）

- 表格：name、description、modelAlias、maxSteps、tools、minRole、resultMaxChars、injectMemory。
- **来源徽标**（[14 §2 Q5-b](./14-open-questions.md)）：`GET /api/agents` 交回文件定义
  （`agents/<name>.md`）与配置定义合并后的名单，每条带 `source` —— `file`（只在文件里，打
  「来自文件」）/ `file-overridden`（两边都有，跑的是配置那份，打「覆盖了文件」）/ `config`（无徽标）。
- `[新建 Agent]` / 行点击编辑整份 `agent.agents` 配置数组；保存后 `config.changed` 触发
  `AgentManager.replaceDefinitions()`（含一次文件重扫），删除也走同一条干净切换路径。
  **写回时只写 `source !== 'file'` 的那些** —— 把整张合并名单写回去等于把每个 `.md` 悄悄复制进
  DB 覆盖层，从此改文件不再生效而界面上什么都看不出来。
- 编辑一条 `file` 定义**不置灰**：那正是「文件只读 / DB 赢」该有的入口，保存后它变成 `file-overridden`。
  删除分两种：纯文件定义删不掉（提示去删那个 `.md`），覆盖则删掉覆盖、回到文件那份。
- `[试跑]` 打开隔离面板：输入 task 后调用 `POST /api/agents/:name/dryrun`。服务端创建可审计的
  `agent_run`，复用 `runSubAgent`，以 NDJSON 逐行推送 step（正文、工具输入输出）、usage、
  final 或 error。关闭请求或点 `[取消试跑]` 会 abort 该试跑，不影响 Telegram turn。
  **试跑与正常轮次共用同一份配额**：开跑前 `quota.reserve`，每步 `commit`，结束后 `release` 剩余
  预留；额度不足直接拒绝开跑。只记 `usage_ledger` 不进 `quota_counters` 的话，`global.daily`
  对试跑一概无效（docs/20 · W-QUOTA-01）。chat / user 两级计数落在合成 subject `webui-dryrun` 上，
  不吃真实会话与用户的额度。

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
- **点任一行看这条事件的详情（已实现）**：`GET /api/logs/:id` → `UiModal`。上半是元信息栅格
  （时间 / 级别 / kind / 摘要 / trace / span / parent span / chat / user / key / 耗时 / 载荷大小），
  下半是格式化后的 `data_json`，带 `[复制 JSON]` 与 `[下载完整 JSON]`（走 `GET /api/logs/:id/data` 取未截断那份）。
  footer 两个跳转：`[展开整条 trace]` 与 `[看这一轮详情]`（`cmd_*` / `job_*` 的 trace 不是轮次，不给这个按钮）。
  此前点一行只会去重建 trace，而 `trace_id` 为空的那些（`system.start`、`config.changed`、
  `maintenance.*`、`webui.action`）**点了什么都不发生** —— `log_events` 的 15 列里界面只用到 5 列。
- 列表列：时间 / 级别 / 事件 / 摘要 / **载荷**（`data_bytes`）/ Trace。载荷正文不在列表里
  （见 §4 的 `GET /api/logs`）。
- `[导出 trace]` → JSON 下载，便于贴 issue。

### 3.10.1 定时任务（在「任务与审批」页；docs/21 · `G-API-16`）

第三张卡片，**跨会话**列出全部任务：任务名 + 正文 / 会话（带创建者）/ 模式 / 触发（cron 或绝对时间 +
时区）/ 下一次 / 上一次（结果标签 + 时刻 + 累计次数 + 错误原文）/ 状态 / 操作。

- `[新建定时任务]` → `UiModal`：会话下拉（只列已有上下文的会话）、任务名、模式、触发方式
  （cron / 一次性）、正文。正文的标签跟着模式变（agent 是「任务描述（给模型看）」，notify 是
  「要发出的正文」）。**一个会话都没有时按钮禁用并给一条说明** —— 空下拉配「填完才报错」
  是最难受的那种表单。
- `[立即触发]`：二次确认里**写清代价** —— agent 模式点一下就是一次真实模型调用（花钱），
  而且真的会往那个会话发一条消息。不等结果，提示语指向该行的「上一次」。
- `[停掉]`：二次确认说明停掉后不再触发、任务行按 `schedule.retentionDays` 保留、同名任务之后可重建。
- `schedule.enabled` 关着时整卡一条横幅（任务留在库里但不触发）；没装配运行时时明说「读不到」，
  不显示零条。
- 定时轮次跑完会改「上一次」与「下一次」，所以这一组跟着 `turn.finished` 事件刷新。

### 3.11 用量（Usage）
- **时间范围（7/30/90 天）+ 维度切换**（按天/会话/用户/模型/别名/agent/provider）：走
  `GET /api/usage/report?groupBy&from&to`。聚合本来就实现好了（`UsageLedger.report`），
  只是从来没有端点调过它 —— 这一页因此长期只有一张不分维度的明细表。
  `chat` / `user` / `provider` 维度的 bucket 是裸 id，显示名在**服务端**补（前端不再实现第二份反查规则）。
- **图表**：按天时是折线（花费、输入/输出 token），按其他维度时是水平条形排行 —— 维度值是群名/模型名，
  竖着放会把标签压成竖排。条形图只画前 10 并把余下的合成一条「其余 N 项」，**不静默截断**。
  自建 SVG（`UiLineChart` / `UiBarChart` / `UiRing`），不引图表库：全站已摘掉 PrimeVue，而 CSP 也不允许从 CDN 取。
- **缓存命中卡片**（`cache_read / 输入 token`）：`cache_read_tokens` 一直在 `usage_ledger` 里，
  但此前没有任何一处把它除以输入 —— 于是「这家上游的前缀缓存到底是不是真的」只能靠翻 JSONL
  反推请求体、逐轮比对前缀。命中率**按桶单独算**（不是把总数一除）：一个大桶会盖掉其它桶，
  而这张卡正是用来分辨哪一家上游、哪个模型的缓存值得依赖的。
  中转站的前缀缓存可能是**概率性**的（同一份请求发两次，一次命中一次不命中），
  配 `provider` 维度看这个数是唯一能把它测出来的办法（[04 §5.1.1](./04-agents-and-providers.md)）。
- 明细表（`usage_ledger` 分页）（已实现）。
- 配额是**独立一页**，见 §3.11a —— 限额、实时计数器与重置按钮都在那里。

### 3.11a 配额（Quota）
导航里的独立页面，数据一次 `GET /api/quota` 取齐（限额 + 计数器 + 未接线键名 + 缺定价模型），
写入走 `PUT /api/quota`（body 是相对 `quota` 的点分键）。

- **限额表单**（已实现）：`enabled` / `requirePricing` / `minReserveUsd`、global / perChat / perUser × day / month 金额、
  `perUser.byRole` 按角色覆盖（四个角色各一组 day/month，留空 = 继承 perUser 的值）、
  单轮上限（`perTurn.maxCostUsd` / `maxSteps`）、频率限制（`rateLimit.turnsPerUserPerHour` /
  `turnsPerChatPerHour` / `concurrentPerUser`）、超限行为（`onExceeded.reply` + `onExceeded.message`）。
  金额留空 = `null` = 不限。保存后热更新（`quota` 在 `HOT_RELOADABLE_CONFIG_KEYS` 里），下一条消息即生效。
- **未接线的键不给控件**，只在表单末尾以灰条列出 `GET /api/quota` 返回的 `unimplemented`
  （`perTurn.maxToolCalls` / `maxSubagents` / `maxDurationMs` / `onExceeded.notifyOwner` / `warnAtRatio`，
  来自 `KNOWN_UNIMPLEMENTED_CONFIG_KEYS`，不在前端硬编码第二份）。
  **给一个存得下但运行时不读的开关，比没有这个开关更糟**（docs/20 · W-CFG-02）；
  这几项要设只能改 `config.yaml`，接线之后从白名单里摘掉，控件才随之出现。
- **当前计数器**（已实现）：`quota_counters` 全表（上限 500 行，按 bucket 倒序），
  每行给出 `cost_usd` / `reserved_usd` / `turns`、所属 bucket 是否是**当前窗口**、以及**合成好的上限**。
  上限不由前端拼：`(scope, window)` 到配置的取值规则（含 `perUser.byRole` 覆盖）与 `bot.ts` 同源，
  在服务端算完再返回。chat / user 行按 `principals` 反查显示名与角色 —— 只显示裸 Telegram ID 认不出是谁。
  有效角色是 `min(用户角色, 会话角色)`，服务端只看得到用户自己那一档，因此配了 `byRole` 时
  user 行的上限标 `limitApprox`，界面上以「≈」提示实际生效的可能更低。
- **`[重置]`**（已实现）：`POST /api/quota/reset`。不带 body 是全表清零；行内按钮带
  `{scope, subject, window, bucket}` 只删那一行 —— 一个人撞满当日额度，没有理由把全局与其他所有人的
  当月计数一起抹掉。两种都写 `webui.action` 审计。
- **无定价模型告警条**（已实现）：启用中但 `price_in`/`price_out` 为空的模型会让该轮花费**按 0 记账**，
  限额再准也拦不住它。告警条列出前 20 个并给出跳转到模型页的入口。

### 3.12 任务与审批

- 任务表：在途 + 历史（`tasks` 表，由 `spawn_agent` 派发），标题、状态、更新时间、`[取消]`。
  子 agent 没有独立取消句柄；按钮调用 `POST /api/turns/:id/cancel`，二次确认明确会取消整轮及
  同轮其他子 agent。
- 审批队列：工具、风险、状态、请求时间、过期时间、发起人、输入摘要与操作。命中审批规则后
  `DatabaseApprovalBroker` 插入 pending 行并发 `approval.pending`；owner 可 `[拒绝]` /
  `[批准]`，调用 `POST /api/approvals/:id/decide`。批准后原工具调用才继续；拒绝、TTL 到期或
  轮次取消均不执行。历史行只显示裁决人，不能重复裁决。
  **待审数挂在左侧导航的角标上**，不只在这一页：一条 pending 意味着某个真实轮次正卡在工具调用上
  最多 `approval.ttlMs`，只在任务页刷新等于「运维不切过来就永远不知道有人在等」。
  `approval.pending` / `approval.decided` 因此单独成一个全页面可见的刷新组（事件本身很稀疏，
  只有命中规则才发），而不是跟着任务表一起走 §5 的页面过滤。
- **「0 条规则时 conditional 等于 never」的 callout**（已实现）：`approval.enabled` 开着而
  `approval.rules` 是空数组时，这一块顶上出现一条黄色提示并点名受影响的工具（从工具表里筛
  `approval === 'conditional'` 的那些）。`ApprovalRules.evaluate()` 在规则表为空时恒回
  「不需要审批」，于是**面板显示「审批已启用」而门是开着的** —— 而这正是出厂默认
  （[27 · S-02](./reviews/27-full-scope-review.md)，需求方选定「明说门是开的」而不是塞一份默认规则）。
  启动时另有一条 `approval.no_rules` 警告与 stderr 提示。
- 桌面通知仍未实现。

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
  同一张卡片下半截是**等待文案**：`placeholderTexts`（一行一条的文本域，保存时滤掉空行后落成数组）、
  `placeholderPick`（随机 / 固定）、`placeholderIndex`（固定用第几条，`pick != fixed` 时禁用）与
  `placeholderAfterMs`。下面一行实时预告「这一轮会发哪条」，因为随机档看不出配的对不对；
  **文本域清空时那行换成 warn callout**，说明占位消息已经关掉 —— `placeholderAfterMs` 的 schema 是
  `positive()`，填不了 0，清空列表是唯一的关闭途径（[11 output](./11-config-reference.md)）。
  越界下标在预告里和 `pickPlaceholder` 一样回落到第一条，不是 clamp 到末条：两边不一致的话，
  界面预告的和实际发出去的会是两条不同的文案。
- 会话级覆盖（`perChat.<contextKey>.*`）优先于全局值。**入口在会话页**（§3.2），不在这里 ——
  它只对选中的那个会话有意义，放在全局设置页既看不出改的是谁也看不出改的是什么。
- **「全部配置」表单**（已实现）：由 `config.schema.json`（zod → JSON Schema）**自动生成**，
  分组折叠面板，每项一张卡片，显示键路径、**这一项的作用说明**、当前值、默认值、取值范围与
  `Tag: 热更新 / 需重启 / 未接线`。
  这是 [21 §1.1](./21-webui-coverage-gaps.md) 里那 109 个「已接线但改不了」配置项的正路 ——
  手写控件必然与 schema 漂移，所以前端**不维护第二份清单**，控件形态一律从 schema 推：
  布尔 → 开关药丸（写着「已开启 / 已关闭」，不是一个孤零零的勾选框），`enum` → 下拉，
  `integer`/`number` → 数字框（`anyOf[number,null]` 留空即「不限」），
  字符串数组 → 一行一条的文本域，对象与对象数组（`tools.overrides`、`approval.rules`、
  `agent.agents`、`mcp.servers`）→ JSON 文本域（保存前本地校验，敲错了不发请求）。
  - **作用说明同样来自 schema 的 `description`**：唯一来源是 `packages/core/src/config/descriptions.ts`
    的 `CONFIG_DESCRIPTIONS`（点分路径 → 一句话），由 `configJsonSchema()` 注入
    —— `GET /api/config/schema` 与 `pnpm config:schema` 生成的文件走的是同一个函数。
    `tests/config.test.ts` 断言它与 schema 叶子**严格一一对应**：少一条、多一条都不给过。
    没有说明的格子只剩一个点分键名，运维得回头翻 [11](./11-config-reference.md) 才知道自己在改什么。
    顶层分组（`general` / `telegram` / …）的那一句写在分组抬头上，搜索框同时匹配键名与说明。
  - 说明里**不写「热更新 / 未接线」**：那两件事由徽标表达，抄进正文只会多一处会漂的副本。
  - 读默认值与说明时认的是**原始节点**而不是 `$ref` 指过去的那个：zodToJsonSchema 对复用的 zod 实例
    （`role`、`nullableMoney`）发 `$ref`，把 `default` 放在 `$ref` 的兄弟位置。跟着 `$ref` 走再读，
    `quota.perChat.daily` 会显示成「默认 5」（真值 1）、`memory.pubWriteMinRole` 显示成
    「默认 blocked」（真值 trusted），说明也会串成同一句。
  - **未接线的键默认隐藏**且控件禁用（可用「显示未接线项」翻出来看）：能点但运行时不读就是假控件。
  - **密钥字段只写**：不回显（`GET /api/config` 里它们已经是 `«redacted»`），占位符写明「已设置，
    留空表示不改」，另给 `[清空]` / `[撤销清空]`。曾经是整体只读，代价是 `tools.web.searchApiKey`
    在 WebUI 里压根配不了，而 `web_search` 的 `available()` 要求 provider 与 key 同时有值 ——
    那个可写的下拉框于是成了空开关（[21 · G-CFG-04](./21-webui-coverage-gaps.md)）。
    也可以填 `${env:NAME}` 引用，加载时替换。唯一仍然只读的是 `webui.passwordHash`：它要的是
    argon2 哈希而不是口令，改口令走本页的「修改登录口令」表单。
    含 `«redacted»` 的值（`mcp.servers` 那种整块 JSON 最容易）**前后端都拒收**：那不是真值。
  - **被环境变量钉住的键禁用**并点名该改哪个变量：`GET /api/config/schema` 的 `envPinned` 给出当前
    真的被钉住的那几条（`db.path`、`access.bootstrapOwnerId`、`sandbox.hostWorkspaceDir`、
    `webui.host`、`webui.passwordHash`）。env 层在覆盖层之后合并，写进去只会在下次加载时被盖回，
    所以写入端也直接 400（[21 · G-CFG-03](./21-webui-coverage-gaps.md)）。
  - **整块写入会作废同一子树下更细的覆盖**（例如工具页逐个点出来的 `tools.overrides.<name>`）：
    响应里的 `subsumed` 列出它们，Toast 点名提醒去核对工具页的开关状态。
  - **修改登录口令**（设置页首屏）：`POST /api/auth/password`，改完其余 session 全部吊销、
    不用重启即时生效。`WEBUI_PASSWORD` 在环境里时整个表单换成告警 —— 那种情况下改了重启就回退。
  - 保存只发**真正改过的那几项**（点分键 → `PUT /api/config`）；保存后按 `hotReloadable` 分类回报，
    **需重启的键在 Toast 里点名** —— 「保存成功但运行时没变」是最误导的一类反馈（docs/20 · W-CFG-02）。
  - 有专用面板的键（触发 / 输出 / 配额 / 沙箱 / 工具开关 / Agent）在这里照样能改，但标注
    「另有专用面板」，那边有额外的校验与实时数据。
- **`[原始 YAML]` 模式**（已实现）：编辑的是**覆盖层**（`config_kv`）而不是合并后的全量 ——
  全量里绝大多数是代码默认值，导进另一个部署等于把那一刻的默认值钉死。
  **解析与校验都在服务端**，用的就是 `loadConfig` 那个 YAML 解析器：放到前端等于让两处方言各自漂移
  （缩进 tab、锚点、`yes/no` 当布尔这些边角都有差异），而「界面上过了、启动时炸了」是最难查的一类。
  语法错误回 `{ line, column }`，校验错误回 zod 的路径，两者都显示在编辑器旁边而不是让 Toast 一闪而过。
  落库按**顶层段**逐段覆盖，不是把整棵树写成一行 —— 后者会把工具页那种更细的覆盖全部作废（G-CFG-02）。
- 保存 → 写 `config_kv` + `config_revisions` → 广播热更新事件；需重启项标注。
- **`[重启进程]`**（`POST /api/restart`，已实现）：走和 SIGTERM 完全一样的优雅关闭路径（排空在途
  轮次、刷日志、WAL checkpoint），落点在 `apps/bot` —— 服务器包不重实现一遍。**先回响应再退出**：
  同一个 tick 里 `process.exit` 会让这次请求连响应都收不到，界面上表现成「点了没反应」。
  二次确认里必须写明**没有 systemd / docker 这类 supervisor 时进程不会自己回来**。
- **`[变更历史]`**（已实现）：读 `GET /api/config/revisions`，列出最近 500 条覆盖写入的键、
  操作者、时间与新旧值。密钥类字段在写入时就已存成 `«redacted»`。
- **`[导出配置]` / `[导入配置]`**（已实现）：导的是 `config_kv` 的**覆盖层**。密钥类键
  **直接不导出**而不是导成 `«redacted»` —— 导成占位符的话，导入端会把真密钥覆盖成一个字面量。
  判据是「叶子段像密钥 + 值是非空字符串」，与 `publicConfig` 同一套口径：拿整条点分路径去匹配会把
  `context.limit.tokens` 也当成密钥（`/token/i` 命中 "tokens"），于是一份导出里静静地少几项真配置。
  导入走和 `PUT /api/config` 完全一样的校验与落库路径，**按键覆盖、不删除**文件里没有的那些；
  被环境变量锁定的键跳过并点名（比让人先去删环境变量再导一次好）。
- **维护操作**（已实现）：`[立即备份 DB]`、`[VACUUM]`、`[清理过期日志]`、`[清理孤儿文件]`、`[重建 FTS 索引]`
  五个按钮，都走 `POST /api/maintenance/:action`，执行前二次确认（同步执行，大库上会阻塞写入），
  结果回显在 Toast 里（备份返回文件路径）。
  `[清理孤儿文件]`（`gc-files`）扫的是**孤儿**：`data/files/**` 与 `data/agent-results/**` 里没有任何
  DB 行指向的文件（下载中途崩溃、`local_path` 被换掉、手工删过库行留下的）。返回删除条数与字节数。
  **它不是保留策略** —— 媒体附件的自动过期是 [14 §2](./14-open-questions.md) Q9 的未决问题，
  二次确认里要写清这一点，别让运维以为点一下就能瘦身（docs/22 · I-09）。

---

## 4. REST API

统一响应：普通 JSON 端点使用 `{ ok:true, data }` / `{ ok:false, error:{ code,message,details? } }`；
`GET /api/events` 使用 SSE，`POST /api/agents/:name/dryrun` 使用逐行 NDJSON，不套普通响应信封。

| Method & Path | 说明 |
|---|---|
| `POST /api/auth/login` `POST /api/auth/logout` `GET /api/auth/me` | 鉴权 |
| `GET /api/dashboard` | 概览聚合 |
| `GET /api/chats` `GET /api/chats/:key` `PATCH /api/chats/:key` | 会话（PATCH 改 scope/唤醒词/覆盖项）。PATCH body 必须通过 `configSchema` 与 [11 §2.1](./11-config-reference.md) 的 `perChat` 白名单，越界返回 400；带 `trigger` 时唤醒词还要过 `checkWakeword`，不可用返回 `invalid_wakeword` |
| `GET /api/chats/:key/context` | 当前窗口消息（分页） |
| `GET /api/chats/:key/commits` | commit 时间线 |
| `POST /api/chats/:key/commits/:id/checkout` | 回滚 done 指针 |
| `POST /api/chats/:key/reset` `POST /api/chats/:key/undo` | 等价 `/new` `/undo` |
| `GET /api/messages` `GET /api/messages/:id` `DELETE /api/messages/:id` | 消息检索（`?q=` 走 FTS）。列表结果里 `turnId` 会回填：触发消息自己不带 `turn_id`（只有回复落盘才写那一列），但检索命中后最想点开的正是它那一轮，所以按 `turns.trigger_message_id` 反查补上。每条还带 `attachments:[{id, kind, mime, fileName, sizeBytes, width, height, durationSec, downloadState, downloadError, extractState, hasLocal}]`（按 `message_id` 一次 IN 查询归组）—— **不返回 `local_path`**：磁盘路径对界面没用，泄漏出去只是白送一份部署布局 |
| `GET /api/turns` | 最近的模型对话，按 turn 聚合：`?page=1&size=20`（size 上限 100）→ `{items, total, page, size}`。每项带触发消息正文（`prompt`）与该轮 bot 回复（`reply`，按内容去重）、状态、步数/工具数/token/花费，以及触发消息上的 `attachments`（形状同 `GET /api/messages`，另带 `promptMessageId`）。分页走 SQL `LIMIT/OFFSET` |
| `GET /api/turns/:id/detail` | 一次对话的**实际调用载荷**：`{turn, captureBodies, events:[{id, ts, level, kind, summary, spanId, parentSpanId, durationMs, text, bytes, truncated, fileRef}], contextMessages:[{ordinal, id, role, origin, pruneLevel, pruneApplied, textPreview, tokens, createdAt, text, bytes, truncated, fileRef}]}`。`events` 是 `log_events` 里 `trace_id = turn id` 的全部 span（上限 500 条，按时间序）；`text` 是格式化后的 `data_json`，单条超过 120k 字符截断并置 `truncated`。超过 `logs.bodyMaxBytes` 的载荷已被 `LogSink` 挪进 `logs/<day>/blobs/*.json`，这里**解引用后再返回**（不然详情里只剩一行 `{"fileRef":…}`）；blob 已被保留策略清掉时 `text=null` 且保留 `fileRef`。turn 不存在返回 404。`contextMessages` 是该轮写进 `context_messages` 的消息（按 `(key, turn_id)` 取，上限 500），`text` 是**原始 `parts_json`** —— 不走 `ContextRepository.messages()`，那条路会跑 `elidePart` 把降级过的行改写成占位符。这是工具输入对历史轮次唯一有效的来源 |
| `GET /api/logs/:id` | 单条日志事件的详情（日志页点开一行）：整行 camelCase（`id, ts, level, kind, traceId, spanId, parentSpanId, chatId, userId, key, summary, durationMs`） + `{text, bytes, truncated, fileRef}`（与 `GET /api/turns/:id/detail` 共用 `detailPayload`：120k 截断 + blob 解引用）。**注册在 `/api/logs/blob` 与 `/api/logs/trace/:traceId` 之后**（Hono 按注册序匹配，`:id` 放前面会把那两条整个吃掉），非数字 id 直接 404 |
| `GET /api/logs/:id/data` | 单条日志事件的完整载荷（`application/json` 附件下载），blob 同样解引用。详情视图里的 JSON 会被截断，复制与下载必须拿到完整那一份 |
| `GET /api/files/:attachmentId` | 附件下载（校验 session）。默认 `content-disposition: attachment`；`?inline=1` 只对**光栅图**（`image/png` `image/jpeg` `image/gif` `image/webp`）放行内联渲染 —— 附件的 mime 来自 Telegram、是发送方可控的，同源内联 SVG/HTML 等于把用户上传的内容变成本站脚本，白名单之外一律照旧当附件下载 |
| `GET /api/prompts` `GET /api/prompts/:id` `PUT /api/prompts/:id` | 提示词（body 读写） |
| `GET /api/prompts/:id/revisions` `POST /api/prompts/:id/rollback` | 版本 |
| `POST /api/prompts/preview` | 按会话与角色走真实运行时路径组装完整 prompt blocks |
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
| `GET/PUT /api/sandbox` `POST /api/sandbox/probe` `POST /api/sandbox/image` | 沙箱配置、探测、拉取镜像（只 pull 不 build；镜像名取自已保存的配置） |
| `POST /api/approvals/test` | 审批规则试跑：`{tool, input?, rules?}` → 逐条命中报告 + 最终风险档位。用的是运行时那份匹配器 |
| `GET /api/schedules` | 定时任务面板的数据：`{available, enabled, timezone, settings:{maxPerChat, minIntervalMinutes, maxPayloadChars}, jobs:[{id, key, chatId, threadId, createdBy, chatLabel, creatorLabel, name, mode, state, cron\|at, timezone, payload, runCount, nextRun?, lastRunAt?, lastState?, lastError?, createdAt, updatedAt}]}`。**跨会话**（WebUI 只有 owner 一个身份，[14](./14-open-questions.md) A15），`nextRun` 来自进程内的 `Scheduler`。没装配运行时时 `available:false` + 空数组 —— 界面据此说「读不到」，而不是「一条都没有」 |
| `POST /api/schedules` | 建一个定时任务。body `{key, name, mode, text, cron\|at}`。**落点从 `contexts` 按 `key` 反查**，不收客户端给的 `chatId`/`threadId`（同 [05 §8](./05-tools-and-permissions.md) 对工具的要求）；归属身份取 `access.bootstrapOwnerId`，没配则 `owner_unset` 400。校验与 `schedule_create` 工具**共用 `createScheduledJob`** —— 两边各写一遍的话 WebUI 迟早能建出工具建不出来的任务 |
| `DELETE /api/schedules/:id` | 停用一条任务：置 `cancelled` 并从 `Scheduler` 摘掉。已经结束的行回 `{cancelled:false}` 而不是假成功 |
| `POST /api/schedules/:id/trigger` | 立即触发一次。**不等它跑完**（`mode='agent'` 的一次触发是一整轮真实模型调用，同步等会把请求挂到 `concurrency.turnTimeoutMs`），先回 `{started:true}`，结果落在该行的 `lastState`/`lastError` 与日志里。非 `active` 的任务回 409；不影响 cron 的下一次 |
| `GET/POST /api/skills` `GET/PUT/PATCH/DELETE /api/skills/:name` | Skill 列表、正文/frontmatter CRUD、启停 |
| `GET/PATCH /api/plugins[/:name]` `POST /api/plugins/:name/reload` | Plugin |
| `GET/POST /api/mcp` `PATCH/DELETE /api/mcp/:name` `POST /api/mcp/:name/reconnect` | MCP transport CRUD、热重连 |
| `GET /api/agents` `POST /api/agents/:name/dryrun` | 子 agent 定义与 NDJSON 隔离试跑（定义增删改走 `agent.agents` 配置） |
| `GET /api/logs` `GET /api/logs/:id` `GET /api/logs/trace/:traceId` `GET /api/logs/blob?ref=` | 日志 |
| `GET /api/usage` | 用量明细（`usage_ledger`，最近 1000 条） |
| `GET /api/usage/report?groupBy&from&to` | 用量聚合。`groupBy` ∈ `day\|chat\|user\|model\|alias\|agent`，非法值 400；`chat`/`user` 的行带回 `label`（服务端反查 `principals`） |
| `GET /api/quota` | 配额页的全部数据：`{quota, timezone, buckets:{day,month}, counters:[…], unpriced:[…], unpricedTotal, unimplemented:[…]}`。`counters` 是 `quota_counters` 全表（上限 500 行）**加上服务端合成的 `limit`**：`(scope, window)` 到配置的取值规则含 `perUser.byRole` 覆盖，让前端自己拼等于把 `bot.ts` 的规则实现两遍。`current` 标记该行是否落在当前 bucket；chat/user 行按 `principals` 反查 `role`/`label`/`username`；配了 `byRole` 时 user 行带 `limitApprox`（有效角色取 `min(用户, 会话)`，服务端只看得到前者）。`unimplemented` 转发 `KNOWN_UNIMPLEMENTED_CONFIG_KEYS` 里 `quota.` 开头的那几项，界面据此不给控件 |
| `PUT /api/quota` | body 是**相对 `quota` 的点分键**（`{"global.daily": 5}` → `quota.global.daily`），与 `PUT /api/sandbox` 一致。展开走 `assignDotted`、整体过 `configSchema`，落 `config_kv` + `config_revisions` 并广播 `config.changed`（与 `PUT /api/config` 同一套校验与审计）。非法键 400 `invalid_config_key`，校验失败 400 `invalid_config` + 逐条 `details` |
| `POST /api/quota/reset` | 重置计数器。不带 body = 全表清零；带 `{scope, subject?, window?, bucket?}` 只删匹配的行（**给了任一过滤条件就必须给 `scope`**，否则 400 `invalid_filter` —— 只按 `bucket` 删会跨 scope 误伤）。返回 `{changes}` |
| `GET /api/tasks` | 任务列表（`tasks` 表，最近 500 条）。**没有 `POST /api/tasks/:id/cancel`**：子 agent 跑在父轮次的 abort 信号下，没有独立的取消句柄，界面上的任务 `[取消]` 打的是下面那条轮次取消 —— 造一个只能取消整轮的 task 端点等于起个会误导人的名字 |
| `GET /api/turns/active` | 在途轮次：`[{id, key, chatId, userId, role, startedAt, steps, toolCalls, costUsd, inputTokens, outputTokens}]`。**来源是进程内的 `TurnRegistry`**（`turns` 表里可能有上次崩溃残留的 `running` 行），步数与花费仍从表里按 `id IN (…)` 一次取回；表里没有对应行时补零。进程内的 `AbortController` / 定时器不出现在响应里 |
| `POST /api/turns/:id/cancel` | 取消一个在途轮次：向该轮的 `AbortController` 发 abort，轮次走 `abortTurn` 落成 `cancelled`，**不删任何消息或上下文**。WebUI 是单角色 owner，可取消任何人的轮次。轮次不在注册表里（已经结束）时返回 `{cancelled:false}` 而不是 404 —— 这不是错误，是「没有作用对象」。写 `webui.action` 与 `turn.cancel` 审计 |
| `GET /api/approvals` `POST /api/approvals/:id/decide` | pending 与历史审批；owner 裁决 |
| `GET /api/config` `PUT /api/config` `GET /api/config/schema` `GET /api/config/revisions` | 配置。`/schema` 的三件套 `{schema, hotReloadable, unimplemented}` **都在 `data` 信封里**（统一客户端只解 `data`，挂在顶层的兄弟键会被静默丢掉，自动生成的表单就是靠这两份前缀表打「热更新 / 需重启 / 未接线」徽标的）。`PUT` body 为点分键；含 `__proto__`/`constructor`/`prototype` 段的键一律 400 `invalid_config_key`（原型污染发生在校验之前，一次请求就能让此后所有配置写入失败，docs/20 · W-CFG-01）；动到 `trigger.*` 时唤醒词要过 `checkWakeword`，不可用返回 400 `invalid_wakeword`。`/schema` 另带 `hotReloadable` 与 `unimplemented` 两个键名前缀表：不在 `hotReloadable` 里的键保存后需要重启才生效，WebUI 据此显示待重启徽标（[11](./11-config-reference.md)） |
| `POST /api/config/wakewords/check` | 逐条返回唤醒词的 `{ kind: contains\|regex, ok, reason }`，供面板即时提示；判定与运行时匹配同源 |
| `POST /api/maintenance/{backup,vacuum,cleanup-logs,gc-files,rebuild-fts}` | 维护。`gc-files` 只删没有任何 DB 行指向的孤儿，**不是过期策略** |
| `POST /api/restart` | 重启进程：走和 SIGTERM 一样的优雅关闭。**先回响应再退出**；没有 supervisor 时进程不会自己回来 |
| `GET /api/config/export` `POST /api/config/import` | 配置覆盖层的导出 / 导入。密钥类键不导出（不是导成 `«redacted»`）；导入按键覆盖、不删除 |
| `GET/PUT /api/config/yaml` | 原始 YAML 模式。解析在服务端（与 `loadConfig` 同一个解析器）；语法错误回 `{line, column}`，校验错误回 zod 路径 |
| `POST /api/auth/token` | 用 `/webui` 发的一次性 token 换 session。单次使用、5 分钟过期；**在鉴权中间件的放行名单里**（否则它自己就要求先登录） |
| `GET /api/logs?minLevel=` | 日志列表。`minLevel` ∈ `debug\|info\|warn\|error`，总览页的「最近错误」卡片用 `warn`。字段是 `log_events` 的列（snake_case）**减去 `data_json`，加 `data_bytes`** —— 单条载荷能到 `logs.bodyMaxBytes`（256 KB）、列表一次上千行，带着载荷刷新等于每次往浏览器推几十 MB。要正文走 `GET /api/logs/:id` |
| `GET /api/events` | SSE |

审计：所有非 GET 请求写 `log_events(kind='webui.action')`，含路径、body 摘要（脱敏）、session ip。

---

## 5. SSE 事件

```
event: turn.started      data: {turnId, key, chatId, user, role, triggerReason, at}
event: turn.progress     data: {turnId, phase: model|tools, step, note}
event: turn.finished     data: {turnId, key, chatId, state, steps, toolCalls, costUsd, rebased, durationMs}
event: log               data: {id, ts, level, kind, traceId, summary, merged?}
event: usage             data: {turnId, model, alias, in, out, costUsd}
event: quota             data: {scope, subject, window, bucket, spent, limit}
event: task.updated      data: {id, turnId, title?, runId?, state, progress}
event: health            data: {source: provider|mcp, name, ok, code}
event: config.changed    data: {keys:[...]}
event: approval.pending  data: {id, turnId, agentRunId, tool, input, risk, chatId, requesterUserId, requestedAt, expiresAt}
event: approval.decided  data: {id, tool, risk, chatId, approved, actor, channel, state?}
```

发送点（都在已有的日志点旁边）：`turn.started` / `turn.finished` 在 `packages/telegram/src/bot.ts`，
`turn.progress` / `usage` 在 `packages/core/src/agent/runtime.ts` 的 `onStepStart` / `onStepEnd`，
`quota` 在 `QuotaGuard.commit`（结算事务提交之后才发，先发会让订阅方读到旧值），
`task.updated` 在 `spawn_agent` 与 `report_progress`，`health` 在 `POST /api/providers/:id/test`
与 `POST /api/mcp/:name/reconnect`（这两处是健康状态**真的会变**的地方；没有独立的健康轮询器，
所以它不是周期心跳）。`log` 由 `LogSink` 自己发。

- 单连接多主题。心跳注释 `: ping` 每 20s，防中间代理断连；断线由浏览器 `EventSource` 自动重连。
- **`log` 事件只带摘要**（不含 `data`），`debug` 不广播，同一 `kind` 在 200 ms 内合并成一条并带
  `merged: n` —— 细节与理由见 [10 §3](./10-logging-and-observability.md#3-落盘格式)。
- **前端按事件类型定向刷新**，不是收到任何事件就重跑一次全量 `load()`（那是一次 18 个端点）：
  每种事件映射到固定的几组数据，且只刷当前页面看得见的那几组，同组 400 ms 内合并一次；
  切换页面时 `watch(active)` 补拉。`turn.progress` 直接用载荷更新在途表，不回查。
- 正在编辑的表单（触发、输出节奏、配额、沙箱）有 dirty 标记，`config.changed` 触发的重载不会回写覆盖。
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
    │   ├── UiButton.vue  UiTag.vue
    │   ├── UiCheckbox.vue  UiSwitch.vue  UiNumber.vue  UiSelect.vue   ← 点选与步进控件，见下
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
- **点选与步进控件也在设计系统里**（`UiCheckbox` / `UiSwitch` / `UiNumber` / `UiSelect`）。不引入 UI 框架之后，
  这四类控件一度直接落在原生元素上，而它们恰恰是**唯一由操作系统绘制**的一层：`accent-color` 只够染
  checkbox 中间那块填充，圆角、边框粗细改不动；`<select>` 展开的弹层完全不受页面控制（深色主题下会露出
  亮色的系统面板）；`<input type=number>` 的上下箭头在 Chrome 只有 hover 才出现、Firefox 常驻，宽度与配色
  都调不了。表现是设置页与对话框里成片的控件跟这套 10–20 px 圆角卡片对不上。四个原语一律
  **「原生元素留在 DOM 里管语义，外观自己画」**：键盘、`<label>` 关联、`:checked` / `:indeterminate`、
  `min`/`max`/`step` 校验都还是浏览器的，只把那个元素挪出视野（`opacity: 0` + 1 px 见方，不是 `display: none`
  —— 后者连焦点和表单语义一起丢）。三个约束是踩出来的，不是风格偏好：
  - **勾选框 = 从一组里挑几个或筛选视图；开关 = 开/关某一项能力**，不混用。触发来源那五格是「哪些消息算触发」
    这一个集合的成员，用勾选框；`quota.enabled`、工具启停、Skill 启用是能力开关，用开关。混着用之后
    「勾上了」和「开着」在同一页里读不出区别。「全部配置」里所有 boolean 叶子都走开关（状态由拨钮表达，
    旁边的「已开启 / 已关闭」降级成注解）。
  - **`UiNumber` 的加减用 `<span>` 而不是 `<button>`。** 调用方普遍写成 `<label>内存上限<UiNumber/></label>`，
    而 `<button>` 是 labelable 元素 —— 点标题文字会被浏览器转发成「点了第一个 labelable 后代」，也就是**静悄悄
    减一格**。换成 `<span>` 后转发落到中间那个 `input` 上，点标题 = 聚焦输入框；键盘用户走 `input` 自己的上下键
    （原生 spinbutton 语义本来就在那儿）。步进值按 `step` 与当前值里较长的那个小数位收一次，否则温度点两下
    就成了 `0.30000000000000004`。
  - **`UiSelect` 的面板 Teleport 到 body + `position: fixed`**：它的宿主格子（对话框正文、「全部配置」的分组、
    表格）都是 `overflow: auto` 的滚动区，留在原地会被裁掉。层级取 50，压在 toast（60）之下、对话框（40）之上；
    滚动与缩放时重新贴合（`scroll` 不冒泡，必须用捕获监听）。**面板打开时 Esc 要 `stopPropagation`** ——
    `UiModal` 的 Esc 监听挂在 `window` 上，不拦下来会连对话框一起关掉。
- **通知只有一种**：任何写操作的成败反馈都走 `pushToast()`（[§3.5](#35-provider-与模型) 的 `[测试连接]` 是基准样式），
  不再有第二套「顶栏静态横幅」。页内校验类提示（登录失败、别名链有失效模型）仍用 `.callout` 内联块，因为它们要跟着表单走。
- **滚动条也在设计系统里**。页面上有七八处独立滚动区（消息窗口、commit 时间线、载荷 `pre`、工具多选、
  模型链、侧栏导航），原生滚动条那条灰槽跟这套 12–20 px 圆角卡片是两种年代的东西，每一处都会露出来。
  统一成透明轨道 + 圆角滑块（3 px 透明边框 + `background-clip: padding-box` 做内缩），hover 升到主色。
  **`scrollbar-width` / `scrollbar-color` 只能发给 Firefox**：Chrome 121 起，元素上一旦出现 `scrollbar-width`，
  整套 `::-webkit-scrollbar-*` 就被忽略，两者同时写等于自己把圆角滑块关掉 —— 用
  `@supports not selector(::-webkit-scrollbar)` 把标准属性圈起来。固定深色的 `pre` 与侧栏另给一套浅色滑块。
- **动效有统一的三档**，全部收在 300 ms 内，且 `prefers-reduced-motion` 一处关掉：
  页面切换是内容区整块淡入上移（`<Transition name="page" mode="out-in">`，每个分支必须带 `key` ——
  相邻页面都是 `<section>`，没有 key 时 Vue 认成同一个节点，只换内容不走过渡）；
  列表入场是 `rise-in` 逐项错开（会话卡片、总览指标卡）；点击一律有按下反馈（按钮 `scale(.97)`、
  图标按钮 `scale(.88)`、对话框 `scale(.97)` 弹入）。左侧导航常驻不动，所以页面切换不做横向滑动 ——
  横移会读成「整页被推走了」。**折叠区一律是「箭头旋转 90° + 内容 `reveal-down`」**（`.ui-fieldset`、
  对话详情的载荷、「全部配置」的分组）：换图标类名而不转箭头会读成闪烁，内容直接蹦出来则看不出它从哪儿来。
- **公共类名要么写在自己的作用域里，要么别用**。`.field-note`、`.switch-line`、`.search.grow`
  当初都只定义在 `.form-grid` / `.search-row` 的后代选择器下，「全部配置」表单照抄了类名却拿不到样式：
  说明文字是满黑正文色、搜索框卡在 290 px 不跟着伸、分组抬头那个 `<button>` 连 `border: 0` 都没有，
  深色主题下露出浏览器默认的亮边框（`button` 全局只设了 `cursor`）。新加区块要么复用
  `.callout` / `.ui-tag` 这类无前缀原语，要么在 `styles.css` 里给自己那一段写全。
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
