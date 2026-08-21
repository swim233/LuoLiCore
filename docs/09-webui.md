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
  allowOrigins: []                  # 默认同源即可；`pnpm webui:dev` 不需要它（见 §2.1 Origin 闸）
```

启动检查：`webui.enabled && !passwordHash` → 生成一次性 setup token 打印到控制台，`/setup` 页面用它设定初始密码。`host` 非 `127.0.0.1` 且未设密码 → **拒绝启动**。

---

## 2. 鉴权

### 2.1 密码 + Session

- 密码用 **argon2id**（`memoryCost=19456, timeCost=2, parallelism=1`）哈希存配置。
- `POST /api/auth/login {password}` → 校验 → 生成 32 字节随机 session id → 写 `sessions` 表 → `Set-Cookie: luoli_sid=…; HttpOnly; SameSite=Strict; Path=/; Secure(当 https)`。
  （此前这里写的是 `Lax`，实现一直是 `Strict`。MCP 的 OAuth 回调之所以要进鉴权豁免名单，正是
  因为 `Strict`：那一跳是授权服务器发起的跨站重定向，浏览器不会带上这个 cookie。）
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
- **Origin 闸**：`/api/*` 最前面一道，比 `Origin` 头与**服务端自己的 origin**（由 `Host` 算出）；
  不相等且不在 `webui.allowOrigins` 里 → `403 origin`。**没有 `Origin` 头的请求放行** —— 它挡的是
  浏览器发起的跨站请求（cookie 是 `SameSite=Strict`、写操作另有 CSRF token，这是第三层），
  不是鉴权，curl / 脚本不受影响。
  **`pnpm webui:dev` 因此要靠 dev 代理改造请求头**：dev server 在 5173 而 `/api` 在 8787，
  `packages/webui/vite.config.ts` 的代理同时改写 `Host`（`changeOrigin: true`）与 `Origin`
  （`headers.origin`），让服务端看到一份彻底同源的请求。**缺任一个，`webui:dev` 里登录及一切
  `/api` 请求恒定 403** —— 且 Vite 只对字符串简写的代理自动补 `changeOrigin`，改成对象形式时会
  静静丢掉。不要改用「往 `allowOrigins` 里加 dev 地址」绕过：`config/config.yaml` 在版本控制里，
  那等于把一条开发用的跨源放行提交进仓库。回归用例在 `tests/server.test.ts`，照着 vite 配置真的
  算一遍那两个头再打一次登录。
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
- **前端那一跳在 `LoginView` 的 `onMounted` 里**：非 setup 分支且 query 带 `t` 时先兑换，成功照
  口令登录的收尾走（存 csrf → `authenticated=true` → 进控制台），失败落回口令框并把服务端给的原因
  写进表单内的 error callout —— token 是 5 分钟一次性的，**过期是常态**，那里不能只有一句「请求失败」。
  兑换期间整张卡片是 loading 态。安全上失败即降级成口令框（fail-closed），所以这条路只补功能。
- **四者由 CI 断言锁死**：前三者（`HANDLED_COMMANDS` + `bot.command('webui')` + `issueLoginToken` +
  `POST /api/auth/token` + 该端点在鉴权中间件的放行名单里）在 `tests/trigger.test.ts` 的
  `keeps /webui wired on both sides`；**前端消费那一跳**在 `tests/webui/login.render.test.ts`。
  上一轮是因为「名字留在白名单里但服务端没写」才把它整个摘掉的（docs/20 · W-TG-01）；这一轮是
  反过来 —— 命令、服务端、bot 三处各有测试且全绿，而前端从未打过那个端点，`/login?t=…` 渲染的是
  普通口令框，整条功能死了一轮没人发现（docs/28 · L-WEB-01）。**没有一条测试跨过前后端边界**
  就是它能活下来的唯一原因。

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
     **「清空」清掉的是窗口，不是模型的记忆**：归档表不受窗口约束，`read_messages` 照旧翻得到清空之前
     的话（实测清空后模型第一步就把 20 条历史捞回来了）。要让它真的等于失忆，开
     `context.recallBarrier`（[02 §7.1](./02-context-engine.md)）—— 这个端点会按当前开关决定要不要
     连背景认领水位一起推。

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
  表头的 `[补齐元数据]` 对**已入库**的模型重跑一次匹配：能力块照写（**但人工标记盖回去**，见下），
  **价格只填空着的**（已填的不覆盖），窗口/最大输出默认不动（运维可能按预算调小过），走 `POST /api/models/enrich`。
- **看图能力可以人工标记**（模型编辑对话框里的三态下拉：`跟随目录判断` / `强制：能看图` / `强制：看不了图`）。
  为什么要有这个：能力标签是按**模型名**在 models.dev 上匹配来的，而中转站照抄官方模型名却不真的
  转发图片是常态 —— 那种模型照常 200 返回、usage 里没有 `image_tokens`，然后凭上下文瞎猜图里有什么，
  而抄来的 `vision:true` 让含图轮次**不切** `vision` 别名（[04 §5.2](./04-agents-and-providers.md)）。
  三件事写在控件旁边：**这是能力块里唯一有运行时行为的一位**（其余标签只影响界面，所以不给开关 ——
  假开关比没开关糟）；判断方法（拿一张三色块图问它颜色，答错就是看不见）；取消标记后该行维持现值、
  下一次 `[补齐元数据]` 再按目录重填。标过的行在能力列上多一枚 `手标 · 能看图` / `手标 · 看不了图` 徽标。
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
- **子导航分四档**（全部 / 用户 / 私聊 / 群与频道，每项带计数）：三者的语义不同 ——
  会话角色只是上限，群里某人的有效角色 = min(他自己的角色, 该群的角色)，混在一张表里看不出来。
- **`kind` 不是类型标签。** 库里它只有 `user` / `chat` 两个取值，而 `chat` 是「一个 Telegram 会话」
  **不是「群」**：每个私聊也有一行 `chat:<用户 id>`。类型一律按 `principals.chat_type` 显示
  （私聊 / 普通群 / 超级群 / 频道），缺失时回落到 Telegram id 的正负号 —— 与会话页的
  `chatIdentity()` 同一套判据，两处不许各写一份（[21 · G-UI-01](./21-webui-coverage-gaps.md)）。
- **角色列同时给出有效角色。** 一个私聊在库里是两行（`user:X` 与 `chat:X`），显示名与 tg_id
  一模一样、只差一个类型标签，而 `list()` 按 `updated_at DESC` 排，刚改过的那行必然置顶 ——
  于是「只改了 `chat:X`」与「改对了」在界面上长得完全一样（[21 · G-UI-03](./21-webui-coverage-gaps.md)）。
  `GET /api/principals` 每行多回一个 `effectiveRole`，**由服务端用 `resolveEffectiveRole` 算**，
  前端不重算第二份。配对本身就是「这是一对私聊」的判据：Telegram 用户 id 恒正、群 / 频道 id 恒负，
  `user:X` 与 `chat:X` 同时在表里就只可能是私聊，不需要再看一次 `chat_type`。
  群 / 频道那行回 `null` —— 它的角色是上限不是有效角色，每个成员各不相同，编一个确定值出来
  比不给更坏。`effectiveRole` 与本行 `role` 不一致时，角色列下面多一行红字「实际 <角色>」；
  一致时不出，这一页有几十行，逐行挂一个「有效 X」是噪声。
- 点任一行打开二级菜单（`UiModal`）：只读展示 kind / tg_id / 显示名 / username，
  角色下拉可改并写明该角色意味着什么；升到 `owner` 时额外警示「跳过审批与沙箱」。
  保存走 `PATCH /api/principals/:id`，下一轮生效并写审计日志。
- **表格每行带勾选框**，选中若干行后表格上方出现批量条（已勾选数 + `[清空勾选]` + `[批量改角色]`）：
  对话框里选目标角色、列出被选中的主体（类型 / 名字 / 当前角色）、写明该角色意味着什么，
  保存走 `POST /api/principals/roles`。一次新进十几个人时逐行点开改角色是纯粹的重复劳动。
  切换子导航会清空勾选（跨类型的批量在语义上是两回事）。
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
- 工具表：名称、来源（builtin/agent/plugin/mcp/custom）、minRole、审批策略、作用域、启停状态、近 7 天调用次数与失败率、平均耗时。
  `GET /api/tools` 除策略外还返回每个工具当前的 `enabled`（来自 `tools.overrides`）——
  只给静态策略表的话，页面显示的东西与运行时无关。
- 每行还带一个 `deferred`：**这台机器的配置下**这个工具属不属于折叠族，由 `tools.catalog.*` 的 glob、
  `policy.source`、折叠豁免表、以及 `search_tools` 那一行的 `enabled` 在查询期一起算
  （[05 §3.12](./05-tools-and-permissions.md)、[07 §5](./07-skills-plugins-mcp.md#5-三者的统一注册流程)）。
  **它答的不是「某一轮里它被折叠了吗」**：`describe()` 手上没有角色也没有轮次上下文，所以真实轮次里
  还会叠上角色门槛、`available()`、skill 收窄、`maxRegistered` 截断，而子 agent 那条路一个都不折叠。
  一个连带后果值得单说：把 `search_tools` 那一行 `enabled` 关掉（或把它的 `minRole` 抬上去）会让
  **每一行**的 `deferred` 变成 false —— 折叠机制整体停摆，就在这个开关所在的同一张表上。
  **它与 `enabled` 是两件事**：折叠工具
  照旧可执行，只是模型默认看不见它的 schema、要先 `search_tools` 展开一次；而 `enabled=false`
  是硬边界。没有注册表的那条兜底路（静态策略表）一律报 `false` —— 折叠判据在那里判不出来。
  界面目前还没用上这个字段（[21 · G-API-23](./21-webui-coverage-gaps.md)），而单个工具的折叠与否
  **不做成 per-tool 开关**：真相在 `tools.catalog.resident` / `defer` 那两个 glob 上，配置页已经改得到。
- 点任一行打开二级菜单（`UiModal`）。**来源与作用域只读**：`source` 由注册方式决定，`scope`
  在运行时不参与任何判定（它是给人看的标签），做成可写等于放一个改了没效果的开关。
  **启停、minRole、审批策略、单次超时四项可写**，写进 `tools.overrides.<name>`。
  停用仍是硬边界：既从工具目录移除，`ToolRegistry.execute` 也二次拦截返回 `tool_disabled_by_operator`。
  - `TOOL_POLICY` 从「唯一真相」降级为**默认值与对照基准**：覆盖层缺某个字段就用它那份，
    所以后续改代码里的策略仍然推得动没被显式覆盖的工具（覆盖字段一律 optional，不写默认值 ——
    给了默认值等于把每一条历史覆盖行钉死在写它那天的策略上）。界面因此必须**同时显示
    「代码默认」与「当前生效」**，只显示一个的话运维看不出自己在偏离什么。
  - **放宽要二次确认**：minRole 调低、或审批降档（`always` → `conditional` → `never`）时，
    `PATCH` 在没有 `confirmRelax:true` 的情况下返回 `409 relax_requires_confirmation` 并列出
    哪几个字段、从什么放宽到什么；界面据此弹确认框，并在工具表上给该行留「已放宽」标记。
    收紧与恢复默认直接保存。超时不算放宽（资源旋钮不是权限闸），照样进审计但不拦。
  - **覆盖只动「角色闸」与「审批闸」这两道，绕不过 `available()`。** `spawn_harness` 在
    `available()` 里硬判 `role === 'owner' && isPrivate`，把它的 minRole 覆盖成 `limited`
    照样开不出来；`web_fetch` 对 `limited` 的 allowlist 判定同理。这一点要写在弹窗里 ——
    否则运维会以为调低 minRole 就等于放开了那个工具。
  - **`approvalFor` 的抬档不受覆盖影响**：覆盖设的是**基准档**，`memory_write` 这类靠
    `approvalFor` 把自己抬进审批的工具，基准改成 `never` 也照样抬（`ToolRegistry` 取最严者）。
  - `timeoutMs` 只对声明了超时的工具有效。`bash` / `python` / `spawn_agent` / `spawn_harness` /
    `ask_parent` 以及全部 `custom_*` 声明的是 `timeoutMs: null`（它们各自有自己的硬期限），界面对
    这几个置灰并注明原因 —— 从外面给它们套一层 race 会在它们自己的超时之前把调用砍掉。
    自定义工具自己的期限在 `custom_tools.timeout_ms` 上，由 `Sandbox.run` 钳在
    `tools.exec.maxTimeoutMs` 内执行，与 `bash` 同构。
  - **自定义工具（`custom_*`）的「代码默认」来自模型声明的那份**，因此「已放宽」红标在这里的含义是
    「运维把它调得比模型声明的更松」。而无论怎么覆盖，它的角色地板都焊在 `available()` 里
    （不低于 `bash` 的门槛）—— 这正是上面那条「覆盖绕不过 `available()`」的又一个实例
    （[05 §3.10](./05-tools-and-permissions.md)）。它的存废与复审在扩展页，不在这里：
    这一页管「现在开着没有」，那一页管「这个工具存不存在、审没审过」。
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
  - **持久容器**（`sandbox.persistent.*`，[05 §5.5](./05-tools-and-permissions.md)）：`enabled` 开关、
    滑动 TTL、绝对上限、容器数上限、持久容器的网络、回收频率。三条界面纪律：
    - `enabled` 旁边**必须有红色警示**说明它同时把网络默认改成 `bridge` —— 上面那个
      `sandbox.network` 管的是一次性容器，两个键并排显示时最容易被当成一个。
    - 绝对上限与容器数上限要写明 `0`/边界的含义（`maxLifetimeMs: 0` = 不设上限；撞容器数上限
      是**直接报错**而不是退回一次性容器）。
    - 关掉 `enabled` **不会立刻销毁已有容器**，它们由下一次 `reapCron` 对账收走 —— 界面要说这句话，
      否则运维关掉开关之后在 `docker ps` 里还看得见容器，会以为没生效。
  - **容器面板**（在沙箱设置下方，`persistent.enabled` 为假时整块折叠并说明原因）：一行一个会话，
    列出会话名、状态、建于 / 上次用 / 还剩多久、进程数、内存、是否钉住，表头带 `used/max`。
    行内操作「重置」「钉住」「续期」分别打 `DELETE /api/containers/:chatId`（`?wipe=1` 才清文件）
    与 `POST /api/containers/:chatId/keep`。
    - **「重置」的 `confirm()` 要写明代价**：容器里跑着的进程会一起没（照「立即触发」那条的写法）。
      清文件是**另一个**勾选项且默认不勾 —— 界面上把「换环境」和「删数据」做成一个按钮，
      迟早有人点错（同 `container_reset` 的默认值，[05 §3.11](./05-tools-and-permissions.md)）。
    - 依赖没装配时回 `not_implemented`，面板显示「这个部署没有装配持久容器运行时」而**不是空列表** ——
      「读不到」和「一个都没有」必须分得开（同定时任务面板）。
  - `tools.fs.allowHostFsForOwner` 已接线（第五轮）：owner 的 fs 工具 jail 到 `/` 而不是会话
    workspace，`denyGlobs` 照样生效。**开关旁边必须有红色警示** —— 这是 [14](./14-open-questions.md) T8
    那条取舍的显式入口。
- **审批规则试跑**（`POST /api/approvals/test`，已实现）：给一个工具名 + 一条样例输入，逐条回报
  哪些规则命中、**为什么没命中**（工具名不匹配 / 正则不匹配 / 正则编译失败）、最终风险档位。
  判定用的是**运行时那份** `ApprovalRules`（共用 `compiled` 的编译结果）—— 在前端再实现一遍匹配
  必然漂移，而「以为配了审批其实永不命中」正是这条配置最容易出的错。`when: 'target_exists'`
  一律记成「取决于运行时」：试跑没有真实执行上下文，含糊其辞比编一个答案好。
  规则本身仍在「全部配置」的 `approval.rules` 里编辑。

### 3.8 扩展（Skills / MCP / Plugins / 自定义工具）

**这一页的活儿不是「列出扩展」，是决定模型被允许具备什么能力、并且真的看过。** M12 之后其中
两类是模型自己写下来的，所以视觉主轴取 **来源 + 有没有人看过**，而不是「开着还是关着」。

实现在 `packages/webui/src/views/ExtensionsPage.vue` + `src/components/extensions/`
（四个纯呈现子组件 + 一份共用类型），**不在 `ConsoleView.vue` 里**。写操作与 busy 态全在页面外壳，
子组件不碰 `api()`。

> **共用卡片网格那条口径被推翻了。** 原文是「四类扩展继续共用卡片网格，但操作按各自真实生命周期
> 区分」，实现是一个 `extensionRows` 把四类拼成一个数组塞进一个 `provider-grid`，八个动作按钮靠
> `v-if="item.kind === ..."` 分流。代价是每一类只显示得出四类的**交集**：MCP 的连接状态与凭据、
> plugin 的 `provides`、skill 的 `requires-tools`、自定义工具的 runtime/scope 全都摆不下，
> 而这些字段 API 早就在发。另有一条纯排版的代价：`.provider-grid` 会把同排每张卡片一起拉到最高
> 那张的高度，一份长描述或一台发现了 70 个工具的 server 就能把邻居撑成内容散开的空盒子。

**四个分段（`.subtabs` + `[data-ext-tab="<key>"]`，形状照设置页那四个 tab）**，
键是 `skills` / `mcp` / `plugins` / `tools`。改这里要连同
`tests/webui/console.render.test.ts` 的 `EXTENSION_TABS` 一起改 —— 漏一个分支，那一段从此没人
渲染过（`docs/24 · R-UI-01` 是没有渲染用例就拆子视图的那一次）。

**两个结构性元素：**

- **来源脊**：每行左侧 3px，`bundled` 灰 / `local` 主色 / `package` 青 / 模型自撰 琥珀 /
  加载失败 玫红。**「未审阅」有自己的形态**（虚线边框 + 琥珀脊）而不只是换一个标签的字 ——
  「没人看过」和「有人看过之后关掉」是两回事，混成一个标签运维就分不清哪些在等自己。
- **待你处理**：页顶一条，数三类在等人的东西（未审阅的包 / 未复审的脚本 / 要登录的 server /
  加载或连接失败）。点一下跳到对应分段。归零时降级成一句灰字，不放庆祝文案。

四类各自的版式与「说是之前要看什么」：

- **Skills**（阅读式列表）—— 要看的是**正文**；装包进来的还要看它带了哪些文件
  （「这个包往我机器上放了什么」是启用它之前唯一要回答的问题）。行上摆 name、description、
  来源徽标、`min-role`、`requires-tools`、`allowed-tools`、上次变更。
  **`requires-tools` 必须摆出来**：这几个工具不在本轮工具集里时这份 skill 压根不进模型目录
  （`SkillLoader.catalog()`），而 `tools.selfExtend.*` 出厂全关 —— 于是一份说明书在这一页上
  显示「可用」，模型那边却永远看不见它。`GET /api/skills` 因此多回 `requires_tools` 与
  `allowed_tools` 两列（**只取那两个字段，不放行整份 `frontmatter_json`**，G-EXT-06 的口径不变）。
  可 `[新建]`、`[编辑]`/`[读一遍]`、启停、删除、`[装 Skill 包]`。
  **随包那四份说明书只放行启停**：改正文 / 描述 / 删除回 403 `skill_reserved`，界面上那个删除
  按钮因此根本不渲染（摆一个点下去必然报错的按钮比不给更难排查）。
  `skills.enabled` 关着时页顶给提示条并带 `[打开总开关]`。
- **MCP**（连接表）—— 要看的是**活没活、谁的、挂了哪些工具、登录了没有**。列：server（名 + url
  或命令行）、状态、凭据、工具条数、最低角色、上次核对、动作。要登录 / 连不上的行排在最前并
  整行浅琥珀底。详见 [§3.8.1](#381-需要登录的-mcp-server)。
  - **工具清单从行内挪进抽屉**（`UiDrawer`）。此前它是一个封高的内嵌滚动区：条数没有上限
    （一台 agent-browser 就发现 64–70 个），不封高的话一台 server 足以把整页拉到 1700px；
    封高之后清单里读不出总数，所以又在副标题补了一句「N 个工具」。现在**条数进列、清单进抽屉**，
    既读得出总数，也读得到每个工具的描述 —— 那份描述由对面那台 server 写，是提示注入面之一
    （[05 §7](./05-tools-and-permissions.md#7-提示注入防护)），值得能看见。
  - **`mcp.enabled` 是总开关且出厂为 `false`**（`reconcile` 一上来就对它 early-return）：
    关着时页顶与新建对话框都给横幅加 `[打开总开关]`，保存后的 Toast 也说明「存下了但不会连」——
    否则运维拿到的是 `ok:true` 加一条永远停在「等待连接」的行（docs/20 · W-CFG-02）。
  - **`[重连]` 直接用 `POST /api/mcp/:name/reconnect` 的返回值**（`{state, error}`）：此前整块
    响应被丢掉、恒弹一句「已重连」，而这一跳最想知道的恰好是它这次连上没有。
  - **「上次核对」列 + 陈旧提示**：`mcp_servers.state` 由 `mcp-health` 每 5 分钟对一次账，
    子进程被 `kill -9` 之后最长 5 分钟才从 `up` 改过来。判据用 `updated_at`（每次成功 reconcile
    都会推）而不是去解 cron 表达式。
- **Plugins**（代码物件卡）—— 要看的是**源码**，所以主动作是 `[看源码]`
  （`GET /api/plugins/:name/source`；没有它，「启用前先看过源码」就只是句口号）。
  卡片上摆 `provides_json` 解出来的「它往运行时加了 N 个工具 / M 个 hook」—— 那是 MCP 工具条数的
  plugin 对应物，端点一直在发而界面一直没读。启用要二次确认（全信任、无沙箱）。
  `[重载]` 之后**按 `hotReloadReliable` 分流**：跑在 tsx（`pnpm dev`）下时热重载静默跑旧代码，
  这时弹的是不自动消失的 warn 并在卡片上常驻一条提示，而不是一句「已重载」。
  `DELETE /api/plugins/:name` 连目录带库里那行一起删。
- **自定义工具**（待复审队列）—— 要看的是**脚本正文与参数**，未审阅的排在最前。行上直接摆
  runtime、作用域、超时、由谁写下，不用点开才看得到。**正文与参数在这里是只读的**：顺手改一行
  会让 `definition_hash` 与模型以为的那份定义脱节，要改就让模型改，或者直接删。
  启用一段模型写的脚本记 **warn** 级 `webui.action`，跟放宽工具权限同一档。

**通道闸提示条要指名道姓说出真正关着的那个键。** 判据是「`tools.selfExtend.enabled` 主闸或
本分段那个子闸任一为假」，而提示文案此前恒定写 `tools.selfExtend.skills.enabled` —— 主闸关着时
它指向的那个键其实是开的，照它去翻只会发现「明明开着」。现在按当前分段选键，并给
`[打开这条通道]`。

**页内确认框取代 `window.confirm` / `window.prompt`**（此前六处）。它是这一页唯一不走设计系统的
模态：系统绘制、深色主题下露出亮色面板、长文案会被截断 —— 而这几处的文案恰恰是「启用之前你该
知道什么」。装包的多份 `SKILL.md` 选择也从 `prompt` 改成一个带 `UiSelect` 的对话框。

#### 3.8.1 需要登录的 MCP server

规格在 [07 §4.5](./07-skills-plugins-mcp.md)；这里只说界面。

`mcp_servers.state` 多一档 **`needs_auth`（「要登录」）**。它跟 `down` 分开是因为运维动作完全
不同：前者要人去点一次授权，后者要人去看命令行 / 网络。此前两者挤在 `down` 里，而 `last_error`
是一句 `Error POSTing to endpoint: <原始响应体>` —— 从里面读不出该做什么。

`GET /api/mcp` 每行多两块（都**不含密文**）：

- `credential`：`{ mode, scope, hint, expiresAt, authorizedAt, authorized }`。`hint` 是 bearer
  token 的末 4 位（照 `providers.api_key_hint` 的既有做法），界面因此不必解密就能显示。
- `pendingAuthorization`：`{ authorizationUrl, expiresAt }`。刷新页面之后〔登录〕按钮还得能点，
  所以这条要能在**不消费掉 `state`** 的前提下读到。

三种 `auth.mode` 在这一行上的样子：

| `auth.mode` | 凭据列 | 动作 |
|---|---|---|
| `none` | 「不需要」 | 撞上 401 时状态是「要登录」，提示语指向「去把 `auth.mode` 改成 bearer 或 oauth」——**这个模式下没有登录按钮**，因为还没决定用哪种方式 |
| `bearer` | `Bearer` 徽标 + `····末4位` + 到期时间 | `[填 token]` / `[换 token]` → `PUT /api/mcp/:name/auth`；有凭据时另给 `[注销]` |
| `oauth` | `OAuth` 徽标 + 到期时间 | `[登录]` → `POST /api/mcp/:name/auth/start`，拿到授权 URL 后 `window.open` 到新标签；`[注销]` → `DELETE /api/mcp/:name/auth` |

**授权 URL 由服务端算，不由前端拼。** 只有服务端知道 `webui.publicUrl`，而 `redirect_uri` 一旦
注册进对方那里就不好改；`publicUrl` 没配时这条路**直接断掉并说明缺什么**，不编一个 127.0.0.1
的地址（照 `/webui` 命令没配 publicUrl 时那句话的做法）。

**回调那一跳的落点是浏览器地址栏，不是 fetch**，所以服务端只能把结果编进 URL：
`302 → /?mcpAuth=<status>[&detail=...]`。控制台在 `onMounted` 里读出来弹一条 toast、
把参数擦掉（`replaceState`，否则刷新会再弹一遍）、并切到扩展页。不读它的话，人被重定向回来
只看到一个多了查询串的首页 —— 「授权到底成没成」一个字都没有。

`mcpAuth` 的取值：`ok` / `denied` / `bad_state` / `incomplete` / `failed` / `not_found` /
`unavailable`，每一条对应一句说清下一步的话。**`bad_state` 不含糊**：state 无效、已用过、
或已过期（10 分钟）都归它，文案直接说「回扩展页重新点一次〔登录〕」。

新建 / 编辑 MCP 的表单在 http transport 下多一组：登录方式（三选）、`scope`、`client_id`
（对方不支持动态注册时手填）。表单里**不收 token** —— 那一栏在列表行的 `[填 token]` 对话框里，
写入即加密、任何读路径都不回显。表单上写明这件事，因为「凭据不在这份配置里」是个反直觉但
重要的事实（它同时是 `headers.Authorization` 明文进 `config_revisions` 那条路的修复）。

`stdio` server **没有** `auth` 字段：OAuth 是 HTTP 的事，而一台 stdio server 的「登录」是它自己
在带外做的。界面上这类 server 的凭据列恒为「不需要」，而它的 stderr 现在会逐行进日志
（`mcp.stderr`）—— 那是这类 server 唯一能给出的线索。

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
  缩进按 `parent_span_id` **链**算 depth（[10 §1](./10-logging-and-observability.md#1-trace-模型)），不是「有父就缩一级」——
  后者在 `parent_span_id` 全库为 NULL 的年代看不出问题，父边真的连上之后会把 `agent.run` 下面那三层
  压成同一层（docs/28 · L-LOG-04）。**环与悬挂父都按 depth 0 渲染**：一次查询只取 500 行，
  子 span 的父完全可能不在这一页里，而一条坏数据不该把整个视图打成空白（`tests/webui/console.render.test.ts`）。
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

**跨会话**列出全部任务：任务名 + 正文 / 会话（带创建者）/ 模式 / 触发（cron 或绝对时间 +
时区）/ 下一次 / 上一次（结果标签 + 时刻 + 累计次数 + 错误原文）/ 状态 / 操作。

- **一个弹窗管新建与编辑**（`isNew` 分支）。`[新建定时任务]` 与行内 `[编辑]` 打开的是同一个
  `UiModal`：会话下拉（只列已有上下文的会话）、任务名、模式、触发方式（cron / 一次性）、正文、
  静默开关。正文的标签跟着模式变（agent 是「任务描述（给模型看）」，notify 是「要发出的正文」）。
  **一个会话都没有时新建按钮禁用并给一条说明** —— 空下拉配「填完才报错」是最难受的那种表单。
- **编辑时四个字段只读，每个只读都有理由**，且理由要写在控件旁边而不是只留在这份文档里：
  **会话**（隔离锚点，`POST` 连客户端给的 `chatId` 都不收）、**模式**（正文语义与花不花钱随它
  一起翻转，见 [05 §3.8](./05-tools-and-permissions.md)）、**时区**（任务含义锚在创建时那个时区上，
  [03 §2.12](./03-data-model.md)）、**创建者**（每次触发按 `min(用户角色, 会话角色)` 重算，
  做成可写就是一个提权把手）。要换这四样只能取消重建 —— 代价是 `run_count` 与运行历史归零，
  而那正好是「这已经是另一条任务了」的诚实表达。
- ⚠ **一次性任务的 `at` 回填必须走墙钟折算，不能直接填 ISO。** `GET` 发的是 `toISOString()` 的
  UTC 瞬时，而表单收的是**任务行上那个时区**的墙钟串（`YYYY-MM-DDTHH:mm`）。直接回填的话，
  `Asia/Shanghai` 上一条「早八点」的任务会显示成 `…T00:00:00Z`，人顺手改成 `08:00` 再保存 ——
  **任务被静默挪后 8 小时，两次操作各自都不报错**。折算按行上的 `timezone`，不是 `general.timezone`。
- **前端只做格式校验，不做策略校验**（`name` / `text` 非空、cron 非空、`at` 匹配正则）。
  `interval_too_short` / `at_in_the_past` / `too_many_jobs` / `duplicate_name` / `invalid_cron`
  一律等服务端回 —— 「建与改的校验只有一份」（`createScheduledJob` / `updateScheduledJob`）
  对前端比对端点更成立：抄一份到浏览器里，它连库里有没有重名都不知道。
- `[立即触发]`：二次确认里**写清代价** —— agent 模式点一下就是一次真实模型调用（花钱），
  而且真的会往那个会话发一条消息。不等结果，提示语指向该行的「上一次」。
- `[停掉]`：二次确认说明停掉后不再触发、任务行按 `schedule.retentionDays` 保留、同名任务之后可重建。
- **`[永久删除]` 与 `[停掉]` 是两个动词，二次确认必须把区别说全**：停掉是软取消（行还在、状态
  「已停用」、按保留期自然清），永久删除是**把那一行从库里删掉**（`POST …/purge`），
  **连 active 的也删得掉**，`run_count` 与全部运行历史一起没有。所以它**放在弹窗 footer 最左**、
  不进行内操作区 —— 与「停掉」两个红按钮在同一行里并排迟早误点，而这两个的后果差着一整段历史。
  服务端那一路留了一条 warn 日志（`schedule.purged`），界面上这句「库里只剩那一行凭据」也要说。
- **静默开关**（`silent`，对应 `scheduled_jobs.allow_silent`）：勾上之后模型在这条任务的轮次里
  多一个 `stay_silent` 工具，可以宣布这一轮不投递（[02 §10.5](./02-context-engine.md)）。
  **`mode='notify'` 时置灰并说明为什么** —— notify 不调模型，没有任何人能在触发时做这个判断，
  服务端那一侧也直接拒（`invalid_silent`）。控件禁用要配一句解释，光灰着等于让人以为界面坏了。
- **「上一次」多一档「静默」标签**，与「成功 / 失败 / 跳过 / 错过 / 已取消」并列，用中性色而不是
  成功色也不是失败色 —— 它两样都不是。**连续静默次数超过阈值时那一行出提示**（`silentStreak`
  由 `GET` 一起回），文案指向「这条任务可能已经变成一台只烧钱不说话的定时器」：这是运维在界面上
  唯一看得见的那一层，其余三层都在库和日志里（[02 §10.5](./02-context-engine.md) 那张四层表）。
- **列表撞上限时出「还有 N 条」，不静默截断。** 这一卡不分页（行数有界，`DataGrid` 客户端切片），
  但 `GET` 的信封带 `total` / `truncated`；`truncated` 为真时表尾一条说明 —— 与用量页条形图
  「其余 N 项」同一条规矩（§3.11）：**看不见的部分必须说出来**。
- `schedule.enabled` 关着时整卡一条横幅（任务留在库里但不触发）；没装配运行时时明说「读不到」，
  不显示零条。
- **总开关关着时「建不了但改得了」**：`POST` 照旧回 `schedule_disabled`（建一条不会响的任务，除了
  让人以为它排上了之外没有别的作用），而 `PATCH`（连同 `[停掉]` / `[永久删除]`）放行。这个不对称
  是有意的，理由是止损路径：一条任务跑飞了要改它，如果编辑也被总开关拦住，运维就得**先把总开关
  打开** —— 那一下会把**所有**任务一起重新武装。而改一条根本不会触发的任务本身没有任何副作用
  （`fire()` 那一侧照旧 skip，`updateScheduledJob` 因此不过 `gateEnabled`）。
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

**三张卡竖排，顺序是 任务 → 定时任务（§3.10.1）→ 审批。** 此前审批卡挤在定时任务卡右边
（`.dashboard-grid` 是 `2fr 1fr`），而定时任务那张 8 列宽的表只占 2fr —— 它上面挂的 `wide`
在整个 webui 里没有任何 CSS 命中，是一个死 class。三张卡都是宽表，横排只能让每一张都不够宽；
竖排（`.card-stack`）之后各占满整行。**总览页的 `.dashboard-grid` 不动**，那是另一页的骨架。

- 任务表：在途 + 历史（`tasks` 表，由 `spawn_agent` 派发），标题、状态、会话 / 发起人、更新时间、
  `[取消]`。**删除不在行内**，见下。**服务端分页**（`?page=&size=`），排序是「running 优先，其余按
  `updated_at` 倒序」—— 在途的那几条是运维唯一等得起的东西，不该被昨天的历史挤到第二页。
  会话名与用户名由**服务端**反查（`principals`），前端不实现第二份规则（同 §3.11 的用量维度）。
- **只读详情弹窗**（点行打开，抄日志详情那套 `.detail-summary` + `.detail-payload` 两段式）：
  整行字段 + `progress`（解析后）+ join 出来的那一轮（`turns`：状态、步数、工具数、花费、错误）
  与那次子运行（`agent_runs`：agent 名、模型别名、状态、结果摘要）。**只读，不做编辑** ——
  一条任务记录是某一轮真实发生过的事，改它等于改历史。
  ⚠ 进度那一栏的标签必须写「**最后一条**进度」而不是「进度」：`AgentManager.progress` 每次
  覆盖 `progress_json` 同一列，历史行里留下的是最后那一帧，不是一条时间线。
- **`[取消整轮]` 与 `[永久删除]` 是两个动词，而且都在详情弹窗的 footer 里。** 取消打的是
  `POST /api/turns/:id/cancel`（子 agent 没有独立取消句柄，二次确认要明说会取消整轮及同轮其他
  子 agent）；删除打的是 `DELETE /api/tasks/:id`，**删的是这一行记录，不是取消通道** ——
  它对在跑的任务直接回 409 `task_running`。二次确认要写清：删掉之后这条子任务的进度与
  结果摘要都没有了，而那一轮的 trace（`turns` / `agent_runs` / 日志）还在。
  两条形状上的取舍，都跟着已有先例：**删除不进行内**（与 `[取消]` 两个红按钮并排必然误点，
  同 §3.10.1 的定时任务卡与扩展页的 Skill 弹窗），而 running 时那一档是**置灰而不是隐藏** ——
  隐藏之后运维只会问「为什么这条没有删除按钮」，置灰配一句说明才答得上来。
- ⚠ 行内按钮一律 `@click.stop`：`DataGrid` 的 `row-click` **无条件**挂在 `<tr>` 上（不看
  `clickable`），不 stop 就是「点取消的同时弹出详情框」。先例是 §3.9 子 Agent 表里那个行内
  `[试跑]`，只是那一处没有用例守着。
- ⚠ 二次确认是在**详情弹窗开着**的时候弹的，而 `.ui-overlay` 恒为 `z-index: 40` —— 两层弹窗
  只能靠 DOM 顺序分胜负，而 `ConfirmHost` 挂在 `App.vue` 里、锚点排在所有页内弹窗**之前**。
  所以确认框的遮罩要单独抬一层（`.ui-overlay:has(.confirm-detail)`），否则点了什么都不会发生。
- 审批队列：工具、风险、状态、请求时间、过期时间、发起人、输入摘要与操作。命中审批规则后
  `DatabaseApprovalBroker` 插入 pending 行并发 `approval.pending`；owner 可 `[拒绝]` /
  `[批准]`，调用 `POST /api/approvals/:id/decide`。批准后原工具调用才继续；拒绝、TTL 到期或
  轮次取消均不执行。历史行只显示裁决人，不能重复裁决。
  **服务端分页**（`?page=&size=`，size 上限 200），排序是「pending 优先，其余按请求时间倒序」。
  此前是硬 `LIMIT 200` —— 撞上限就是静默截断，而被截掉的恰恰是最老的那些历史行。
  过期扫描留在 `COUNT` 与 `SELECT` **之前**：先把该标 `expired` 的标掉，再数、再取，
  否则第一页显示的 pending 与角标上的数字会差一个刷新周期。
  **待审数挂在左侧导航的角标上**，不只在这一页：一条 pending 意味着某个真实轮次正卡在工具调用上
  最多 `approval.ttlMs`，只在任务页刷新等于「运维不切过来就永远不知道有人在等」。
  `approval.pending` / `approval.decided` 因此单独成一个全页面可见的刷新组（事件本身很稀疏，
  只有命中规则才发），而不是跟着任务表一起走 §5 的页面过滤。
  ⚠ **角标那个数来自服务端的全表 `pending` 计数，不是当前页里数出来的。** 分页之后这两者不再
  相等：翻到第 2 页时页内可能一条 pending 都没有，而门外还有五个人在等。这是整次分页改造里
  唯一一处会**静默造成功能退化**的地方 —— 界面看不出错，只是角标悄悄变成 0。所以 `GET` 的信封
  里 `pending` 与 `total` 是两个字段，前端不拿 `items` 去推。
- **「0 条规则时 conditional 等于 never」的 callout**（已实现）：`approval.enabled` 开着而
  `approval.rules` 是空数组时，这一块顶上出现一条黄色提示并点名受影响的工具（从工具表里筛
  `approval === 'conditional'` 的那些）。`ApprovalRules.evaluate()` 在规则表为空时恒回
  「不需要审批」，于是**面板显示「审批已启用」而门是开着的** —— 而这正是出厂默认
  （[27 · S-02](./reviews/27-full-scope-review.md)，需求方选定「明说门是开的」而不是塞一份默认规则）。
  启动时另有一条 `approval.no_rules` 警告与 stderr 提示。
- 桌面通知仍未实现。

### 3.13 配置（Settings）

页面是**四个二级 tab**（`常用 / 全部配置 / 维护 / 高级`，复用 §3.6 那套 `.subtabs`），不是一条长滚动。
拆开的理由是量出来的：改之前八个区块并排，分组全折叠时首屏就有 **4430 px**，「全部配置」点一次
「全部展开」是 **28075 px**（26 组 / 233 个可见字段，`tools` 一组就 2917 px）。而这八块实际是**四类
访问频率差两三个数量级**的东西 —— 日常旋钮、全量 schema 表单、运维动作、逃生舱，此前在页面上权重完全相同。

| tab | 装什么 |
|---|---|
| 常用 | 触发与唤醒词、输出节奏（含等待文案） |
| 全部配置 | schema 自动生成的全量表单 + `[变更历史]` |
| 维护 | 修改登录口令、五个维护动作、`[重启进程]`、导出 / 导入配置 |
| 高级 | 原始 YAML 覆盖层、合并后的完整配置（默认收起） |

- **前三个 tab 用 `v-show`，「高级」用 `v-if`**。这不是风格选择：触发、输出、全量表单三处各自握着
  未保存的草稿（`triggerDirty` / `outputDirty` / `SchemaForm` 的 `draft`），`v-if` 会在切 tab 时销毁组件，
  表现是**改了一半点去看别的 tab，回来什么都没了、也没有任何提示**。反过来「高级」必须 `v-if`：
  它要把整份合并配置 `JSON.stringify` 一遍，常驻等于每次进设置页都白算一次。
- `settingsTab` 与模板分支由 `tests/webui/console.render.test.ts` 逐个切过去断言有内容 ——
  与导航项同一条防线（少一个分支 = 那个 tab 从此没人渲染过）。

- **触发与唤醒词**卡片（已实现，`常用`）：`private` / `mention` / `reply` / `command` / `channels` 五个开关、
  唤醒词增删（每条标注「包含 / 正则」，不会生效的标红并写明原因）、`wakewordMinLength`、
  `requireTextAfterMention`、`ignoreEditedAsTrigger`。可用性判定打 `POST /api/config/wakewords/check`，
  与运行时匹配共用 `checkWakeword`（[08 §4](./08-telegram-adapter.md#4-触发判定)）；保存走 `PUT /api/config` 的点分键，
  热更新即时生效。列表里有不可用模式时保存会被服务端拒绝（`invalid_wakeword`）并把原因回显在 Toast 上。
  日志 SSE 会不断触发页面刷新，表单在有未保存改动时不被回写覆盖。
- **输出节奏**卡片（已实现，`常用`）：`output.mode`、`replyDelayMs`（防秒回，锚点是用户那条消息）、
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
- **「全部配置」表单**（已实现，`全部配置`）：由 `config.schema.json`（zod → JSON Schema）**自动生成**，
  分组折叠面板，每项一张卡片，显示键路径、**这一项的作用说明**、当前值、默认值、取值范围与
  `Tag: 热更新 / 需重启 / 未接线`。
  这是 [21 §1.1](./21-webui-coverage-gaps.md) 里那 109 个「已接线但改不了」配置项的正路 ——
  手写控件必然与 schema 漂移，所以前端**不维护第二份清单**，控件形态一律从 schema 推：
  布尔 → 开关药丸（写着「已开启 / 已关闭」，不是一个孤零零的勾选框），`enum` → 下拉，
  `integer`/`number` → 数字框（`anyOf[number,null]` 留空即「不限」），
  字符串数组 → 一行一条的文本域，**取值受限的数组（`items.enum`）→ 一组复选框**，
  对象与对象数组（`tools.overrides`、`approval.rules`、
  `agent.agents`、`mcp.servers`）→ JSON 文本域（保存前本地校验，敲错了不发请求）。
  - **复选框那一档还带逐个取值的说明**（`CONFIG_ENUM_NOTES`，随三件套一起进
    `GET /api/config/schema` 的 `enumNotes`）：一格里的取值不总是等价的 ——
    `telegram.allowedUpdates` 那 23 个 Bot API 更新类型里只有 4 个真的有处理器，
    而它们在界面上长得一模一样。这件事写不进那一格的 `description`（一句话装不下 23 条），
    不写又等于让运维勾一个「勾了什么都不会发生」的框（[21 · G-UI-02](./21-webui-coverage-gaps.md)）。
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
  - **「只看非默认值」筛选**：判据是**当前值 ≠ schema 的 `default`**，两份数据表单本来就都在手，
    不加端点、也不在前端存第二份清单。实测一个真实部署 **243 个叶子里只有 21 个偏离默认值** ——
    「这个部署到底改过什么」此前在界面上根本答不出来，只能去「原始 YAML」猜，而那里是**覆盖层
    不是差异集**：专用面板（配额 / 沙箱 / 输出）保存时整组写回，实测 `config_kv` 有 50 行，
    其中大半的值与默认值相同。判定按 `JSON.stringify` 比较，**没有 `default` 的叶子不参与**
    （判不出来就不标，别假装知道）。分组抬头同时给出该组的非默认项数，非默认的格子带一个左侧色条。
    它与「待保存」是两件事：待保存 = 这次编辑还没提交，非默认 = 已经生效的值不是代码默认值。
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
  - 保存只发**真正改过的那几项**（点分键 → `PUT /api/config`）；保存后按 `hotReloadable` 分类回报，
    **需重启的键在 Toast 里点名** —— 「保存成功但运行时没变」是最误导的一类反馈（docs/20 · W-CFG-02）。
  - 有专用面板的键（触发 / 输出 / 配额 / 沙箱 / 工具开关 / Agent）在这里照样能改，但标注
    「另有专用面板」，那边有额外的校验与实时数据。
- **修改登录口令**（已实现，`维护` 首屏）：`POST /api/auth/password`，改完其余 session 全部吊销、
  不用重启即时生效。`WEBUI_PASSWORD` 在环境里时整个表单换成告警 —— 那种情况下改了重启就回退。
- **`[原始 YAML]` 模式**（已实现，`高级`）：编辑的是**覆盖层**（`config_kv`）而不是合并后的全量 ——
  全量里绝大多数是代码默认值，导进另一个部署等于把那一刻的默认值钉死。
  **解析与校验都在服务端**，用的就是 `loadConfig` 那个 YAML 解析器：放到前端等于让两处方言各自漂移
  （缩进 tab、锚点、`yes/no` 当布尔这些边角都有差异），而「界面上过了、启动时炸了」是最难查的一类。
  语法错误回 `{ line, column }`，校验错误回 zod 的路径，两者都显示在编辑器旁边而不是让 Toast 一闪而过。
  - **落库粒度是叶子**（`context.limit.tokens` 这样的点分键），既不是顶层段、更不是整棵树写成一行
    —— 后者会把工具页那种更细的覆盖全部作废（G-CFG-02）。按**段**落库同样不行：
    `runtimeConfigSchema.safeParse` 会把每个 `.default()` 填满，写回去的是**填满之后**那整棵子树，
    于是一次「一个字不改」的往返就把生效覆盖叶子从 73 涨到 171，把那一刻的代码默认值永久钉死，
    而第二次往返起幂等 —— 第一次保存就钉死了，之后界面上看不出来（docs/28 · L-WEB-02）。
    枚举叶子时**递归普通对象、把数组当叶子**（`approval.rules` / `mcp.servers` / `agent.agents`
    是整块语义，逐个下标落库既没人这么读、也会被 `sortOverrideKeys` 拼回原样），空对象不产生叶子。
    落库的值仍取**校验后**的那一份，与 `PUT /api/config` 同一条契约（zod 的强制转换要进 `config_kv`）。
  - **这份 YAML 是所提交段落的全量视图**：段里删掉一个键，那一行就真的从 `config_kv` 消失 ——
    端点算出「落在提交段之下、但不在新叶子集里」的旧键，交给 `writeConfigRows` 在**同一个事务**里
    删掉并记进 `config_revisions`（配置写入的唯一出口不能绕）。反过来，把**整个顶层段**从 YAML 里
    删掉**不删任何东西**：「这一段我不管」与「这一段清空」在提交的树里区分不出来，宁可不删。
  - **密钥类行不参与往返，也永不被删**。`GET` 对 `looksSecret` 为真的行整行跳过（与导出同一套判据：
    叶子段像密钥 + 值是非空字符串），并在 YAML **顶部生成一段注释**逐条列出它们，写明「保持原值，
    删掉这段注释也不会删掉它们」—— 界面上此前只有一个 `skipped` 数组，运维看不出「我提交的这份少了
    什么」。`PUT` 那一侧按同一份判据**自己重算一次**（`GET`/`PUT` 是两次独立请求，不能信客户端），
    把它们连同 `envPinnedConfigKeys()` 一起排除在删除集之外。
    此前 `webui.passwordHash` 就是这样被一次往返擦掉的：`PUT` 拿到的树里没有它 → zod 补上默认值 `''`
    → 整个 `webui` 段写回 → 那一行被删 → `main.ts` 的 `if (!config.webui.passwordHash)` 生效、
    进程掉回 setup-token 形态，而 `host` 是默认回环时 `superRefine` 不拦，**全程静默**。
    触发条件恰好是产品自己引导的配置：`webui.passwordHash` 只在 `WEBUI_PASSWORD` 存在时才被
    `envPinnedConfigKeys()` 钉住，而 `.env.example` 与 `POST /api/auth/password` 的 409 都在劝运维
    删掉那个环境变量、改用界面改密（docs/28 · L-WEB-04）。`tools.web.searchApiKey` 是同一条路。
  - 被环境变量钉住的**那个叶子**跳过并在响应的 `skipped` 里点名（此前是整个顶层段一起跳过）。
    响应另带 `pruned`（这次真的删掉的旧键）与 `preserved`（保住的密钥行），Toast 逐项点名。
- **合并后的完整配置**（已实现，`高级`，**默认收起**）：`config.yaml` → DB 覆盖层 → 环境变量三层
  合并的只读结果，点 `[展开]` 才 `JSON.stringify`。它此前常驻在设置页最底下：既占掉一整屏，
  又因为「看起来最全」而被当成真正的配置源 —— 它和上面那张表单是同一份数据的两种视图，
  而能改的是表单那一份。
- 保存 → 写 `config_kv` + `config_revisions` → 广播热更新事件；需重启项标注。
- **`[重启进程]`**（`POST /api/restart`，已实现，`维护`）：走和 SIGTERM 完全一样的优雅关闭路径（排空在途
  轮次、刷日志、WAL checkpoint），落点在 `apps/bot` —— 服务器包不重实现一遍。**先回响应再退出**：
  同一个 tick 里 `process.exit` 会让这次请求连响应都收不到，界面上表现成「点了没反应」。
  二次确认里必须写明**没有 systemd / docker 这类 supervisor 时进程不会自己回来**。
- **`[变更历史]`**（已实现，`全部配置` 抬头）：读 `GET /api/config/revisions`，列出最近 500 条覆盖写入的键、
  操作者、时间与新旧值。密钥类字段在写入时就已存成 `«redacted»`。
- **`[导出配置]` / `[导入配置]`**（已实现，`维护`）：导的是 `config_kv` 的**覆盖层**。密钥类键
  **直接不导出**而不是导成 `«redacted»` —— 导成占位符的话，导入端会把真密钥覆盖成一个字面量。
  判据是「叶子段像密钥 + 值是非空字符串」，与 `publicConfig` 同一套口径：拿整条点分路径去匹配会把
  `context.limit.tokens` 也当成密钥（`/token/i` 命中 "tokens"），于是一份导出里静静地少几项真配置。
  导入走和 `PUT /api/config` 完全一样的校验与落库路径，**按键覆盖、不删除**文件里没有的那些；
  被环境变量锁定的键跳过并点名（比让人先去删环境变量再导一次好）。
- **维护操作**（已实现，`维护`）：`[立即备份 DB]`、`[VACUUM]`、`[清理过期日志]`、`[清理孤儿文件]`、`[重建 FTS 索引]`
  五个按钮，都走 `POST /api/maintenance/:action`，执行前二次确认（同步执行，大库上会阻塞写入），
  结果回显在 Toast 里（备份返回文件路径）。
  `[清理孤儿文件]`（`gc-files`）扫的是**孤儿**：`data/files/**` 与 `data/agent-results/**` 里没有任何
  DB 行指向的文件（下载中途崩溃、`local_path` 被换掉、手工删过库行留下的）。返回删除条数与字节数。
  **它不是保留策略** —— 媒体附件的自动过期是 [14 §2](./14-open-questions.md) Q9 的未决问题，
  二次确认里要写清这一点，别让运维以为点一下就能瘦身（docs/22 · I-09）。
  **返回体里带 `refused` 时 Toast 必须是 `warn`、标题写「已拒绝」、且不自动消失**：`severity` 与标题
  写死成绿色「完成」的话，拒绝理由只会挤在一行 JSON 的尾巴上、8 秒后自己消失（docs/28 · L-WEB-03）。
  而 `gcFiles` 的 `refused` 两种触发条件都指向同一件事 —— **库与目录对不上**，
  正是运维最该立刻停手、去核对 `LUOLI_DATA_DIR` 与 `media.dir` 的那一种
  （[25 §10](./reviews/25-round7-remediation.md) 记的误删 76 个附件 + 90 份子 agent 全文
  就是它防住的）：**全错配**（一条带路径的行都没有，而目录里有文件）与**部分错配**
  （有行指向目标目录之外 —— 那一条此前结构上不可能触发，`docs/28 · L-OPS-06` 实测被删的
  正是这一类的 74 份）。后者有一个良性误报：改过 `media.dir` 而把老文件留在原地时也会被拒，
  文案里给了出路。**不要为此放宽判据** —— 一条目录外的 ref 与一个可能被误删的文件是一对一的。

---

## 4. REST API

统一响应：普通 JSON 端点使用 `{ ok:true, data }` / `{ ok:false, error:{ code,message,details? } }`；
`GET /api/events` 使用 SSE，`POST /api/agents/:name/dryrun` 使用逐行 NDJSON，不套普通响应信封。

**这个信封没有例外，失败路径也一样。** 客户端（`packages/webui/src/api/client.ts`）无条件
`response.json()`，任何一条 `text/plain` 响应在它那儿都表现成 `SyntaxError: Unexpected token 'I'`
—— 报错和真实原因毫无关系。两半都要焊住：

- 未匹配的 `/api/*` → 404 `not_found`。**必须注册在静态兜底之前**，否则它们拿到 200 + `index.html`
  （docs/22 · I-13）。
- 端点里抛出来的异常 → `app.onError` 兜住。`HTTPException`（`bodyLimit` 之类）原样交回；
  请求体不是合法 JSON（`SyntaxError`）→ 400 `invalid_json` —— 这一条同时给所有没有自己
  `.catch()` 的 `ctx.req.json()` 站点收口；其余 → 500 `internal`，message 形如
  `服务端出错，已记录（ref: <log_events.id>）`。**异常消息不进响应**：它可能带库路径、SQL、
  密钥片段，全文只落 `webui.error` 那一行（[10](./10-logging-and-observability.md)）。

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
| `GET/POST/PATCH/DELETE /api/models[/:id]` | 模型。`PATCH` 动到任一价格字段时，会把 `capabilities_json.catalog.priceSource` 翻成 `manual`。`PATCH` 另收 `capabilities`：`{vision: true \| false \| null}`（`null` = 取消标记，回到目录判断），生效值写 `capabilities_json` 顶层、意图写 `manual`，落库后 `rebuildModels()` 即时生效并记一条 `webui.action / model capability marked`。**只认运行时真的会读的能力位**（现在只有 `vision`），其余键回 `400 model_invalid` 而不是静静吞掉；取值不是 `true/false/null` 同样 400。行不存在时回 `{changes:0}`（与其它 `PATCH` 一致，不是 404） |
| `POST /api/models/import` | 从上游目录批量落库：`{providerId, models:[{modelId, displayName?, contextWindow?, maxOutput?, priceIn?, priceOut?, priceCacheRead?, priceCacheWrite?}], contextWindow?, maxOutput?}`，单次上限 200 条。**能力块与定价出处一律在服务端重新解析**（请求体里的 capabilities 是客户端说的，落库的必须是目录里实际有的那条）。已存在的 `(provider_id, model_id)` 跳过而不是覆盖（不能把已调好的定价冲掉），返回 `{inserted, skipped, priced, ids}` |
| `POST /api/models/enrich` | 给已入库的模型补元数据：`{ids?: string[], overwrite?: boolean}`（不给 `ids` 就是全部）。能力块照写；**价格只填 `NULL` 的那几个**，已有价格保留并把出处标成 `manual`；窗口/最大输出只有 `overwrite:true` 才覆盖。返回 `{scanned, updated, priced, unmatched}`；目录完全不可用时 `502 catalog_unavailable`（不能拿空值把现有行洗掉） |
| `GET/PUT/DELETE /api/aliases[/:alias]` | 别名、fallback 链与采样参数。`PUT` 校验别名名（`^[a-z][a-z0-9_-]{0,31}$`）、链非空且模型存在、`settings` 过 `aliasSettingsSchema`（[04 §5.2.1](./04-agents-and-providers.md#521-别名参数settings_json)），任一不过返回 `alias_invalid` + 具体路径 |
| `GET/PATCH /api/principals[/:id]` | 主体与角色。`GET` 的每一行除库里那份 `role` 外还带 `effectiveRole`：`user:X` 与 `chat:X` 配得上对时是两者的 `resolveEffectiveRole` 结果（即模型系统提示里那个 `role`），配不上对（只见过一边、或本行是群 / 频道）时为 `null` —— 群的角色是上限不是有效角色 |
| `POST /api/principals/bulk` | 批量登记主体：`{ids:[…], kind: user\|chat, role}`，单次上限 500。ID 必须是 Telegram 数字 ID（`^-?\d{1,20}$`），非法 ID 或非法角色返回 400。已存在的主体**只补一次 `setRole`，不再走 `upsertSeen`**（`ON CONFLICT` 分支不动 role 但会照写 `display_name`/`username`，而这里手上只有 `null`，等于把 Telegram 同步来的真名清空），返回 `{count, created, updated}` |
| `POST /api/principals/roles` | 勾选批量改角色：`{ids:[主体 id…], role}`，单次上限 500。**只改已存在的行，不新建**（新建走 `/api/principals/bulk`，那边收的是 Telegram 数字 ID）；库里找不到的 id 原样回报而不是静默跳过，返回 `{count, changed, missing}` |
| `GET /api/tools` `PATCH /api/tools/:name` | 工具启停与策略覆盖。`GET` 每个工具回**生效值**（`minRole`/`approval`/`scope`/`source`/`enabled`/`timeoutMs`）外加 `defaults`（代码里那份）、`relaxed`（比默认更松的字段名）、`selfManagedTimeout`、`deferred`（这台机器的 `tools.catalog.*` 下它属不属于折叠族；没装配注册表的静态兜底分支一律 false，见 §3.7）。`PATCH` 收 `{enabled?, minRole?, approval?, timeoutMs?, confirmRelax?}`，三个策略字段给 `null` = 恢复默认；**先读当前覆盖再整体写回** `tools.overrides.<name>`（一个 key 一条整叶 JSON，只写变动的那个字段会把其余的抹掉）。放宽且无 `confirmRelax` 时 `409 relax_requires_confirmation`。被禁用的工具从工具目录消失，且 `ToolRegistry.execute` 会二次拦截并返回 `tool_disabled_by_operator`。未知工具名返回 404 |
| `GET/PUT /api/sandbox` `POST /api/sandbox/probe` `POST /api/sandbox/image` | 沙箱配置、探测、拉取镜像（只 pull 不 build；镜像名取自已保存的配置） |
| `GET /api/containers` | 持久容器列表 + `used/max`。运行时没装配时 `not_implemented`，**不是空列表** |
| `DELETE /api/containers/:chatId` | 重置（销毁 + 立即重建）。`?wipe=1` 才连 `/workspace` 的文件一起清，且那一档把文件挪进 `.luoli-trash/<ts>/` |
| `POST /api/containers/:chatId/keep` | 改到期时间 / 钉住。钉住只豁免滑动 TTL，绝对上限照常 |
| `POST /api/approvals/test` | 审批规则试跑：`{tool, input?, rules?}` → 逐条命中报告 + 最终风险档位。用的是运行时那份匹配器 |
| `GET /api/schedules` | 定时任务面板的数据：`{available, enabled, timezone, settings:{maxPerChat, minIntervalMinutes, maxPayloadChars}, jobs:[{id, key, chatId, threadId, createdBy, chatLabel, creatorLabel, name, mode, state, cron\|at, timezone, payload, silent, silentStreak, runCount, nextRun?, lastRunAt?, lastState?, lastError?, createdAt, updatedAt}], total, truncated}`。**跨会话**（WebUI 只有 owner 一个身份，[14](./14-open-questions.md) A15），`nextRun` 来自进程内的 `Scheduler`。**不分页**：行数由 `schedule.maxPerChat` 有界，前端 `DataGrid` 客户端切片就够；但撞上 `listAll` 的上限时 `truncated:true` + `total`，界面出「还有 N 条」而不是静默少显示几行。`at` 发的是 ISO **瞬时**（`POST`/`PATCH` 收的是墙钟串，方向不对称，见下）。没装配运行时时 `available:false` + 空数组 —— 界面据此说「读不到」，而不是「一条都没有」 |
| `POST /api/schedules` | 建一个定时任务。body `{key, name, mode, text, cron\|at, silent?}`。**落点从 `contexts` 按 `key` 反查**，不收客户端给的 `chatId`/`threadId`（同 [05 §8](./05-tools-and-permissions.md) 对工具的要求）；归属身份取 `access.bootstrapOwnerId`，没配则 `owner_unset` 400。校验与 `schedule_create` 工具**共用 `createScheduledJob`** —— 两边各写一遍的话 WebUI 迟早能建出工具建不出来的任务 |
| `PATCH /api/schedules/:id` | 改一条**活跃**任务。body `{name?, text?, cron?, at?, silent?}`，给几改几；一个都没给回 400 `nothing_to_update`（不回假成功）。**不收 `key` / `chatId` / `threadId` / `createdBy` / `mode`**：前四个是隔离与提权锚点，`mode` 会同时翻转 `payload` 的语义与花不花钱（[05 §3.8](./05-tools-and-permissions.md)）。校验与 `schedule_update` 工具共用 `updateScheduledJob`，返回体与 `POST` 同形（`scheduleRow`）。**两个触发字段都没给时触发时间原样保留且不重新校验** —— 运维事后把 `minIntervalMinutes` 从 5 调到 60，「我只改了一句正文」不该以 `interval_too_short` 失败。`at` 按**任务行上的** `timezone` 解释，不是 `general.timezone`。400 是全部校验码（`invalid_cron` / `interval_too_short` / `at_in_the_past` / `invalid_schedule` / `duplicate_name` / `invalid_silent` / `nothing_to_update` / `schedule_register_failed` …）、404 `not_found`、409 `not_active`、500 `not_implemented`（没装配运行时）。**改动排不进调度器时整行回滚**（旧 name / payload / cron 都回来，旧 cron 排回调度器）—— 半改半没改的行会让「界面上写着新时间、实际按旧时间触发」。**`name` 在这里是新名字**（HTTP 已经用 `:id` 定位了），而工具那边 `name` 是定位符、`newName` 才是新名字 —— 这处不对称是故意的，两侧各自的定位方式决定的 |
| `DELETE /api/schedules/:id` | 停用一条任务：置 `cancelled` 并从 `Scheduler` 摘掉。已经结束的行回 `{cancelled:false}` 而不是假成功。**这一行一个字都不改** —— `AC-WEB-033` 逐条焊住三种返回，硬删走下面那条 |
| `POST /api/schedules/:id/purge` | **硬删一行**（[03 §4](./03-data-model.md) 那条手工通道）：`{removed:true, name, wasActive}`；404 / 500。与 `DELETE` 是两个动词 —— 那个是软取消、行还在，这个把 `run_count` 与全部运行历史一起抹掉，**active 的也删得掉**。顺序**必须**是 active 时先 `runner.unregister` 再 `jobs.remove`：反过来的话调度器里还留着一条指向已消失行的 cron，下一次到点是一条查不到出处的失败。留一条 **warn** `schedule.purged` —— 硬删一条 active 任务之后「bot 突然不再提醒了」在库里再无痕迹，这一行就是那个痕迹 |
| `POST /api/schedules/:id/trigger` | 立即触发一次。**不等它跑完**（`mode='agent'` 的一次触发是一整轮真实模型调用，同步等会把请求挂到 `concurrency.turnTimeoutMs`），先回 `{started:true}`，结果落在该行的 `lastState`/`lastError` 与日志里。非 `active` 的任务回 409；runner 还没 `load()`（Telegram 投递通道未就绪）时回 400 `not_ready` —— 启动窗口内触发会开一条**发不出去**的轮次：跑完模型、记完账，最后不提交（`docs/28 · L-SCH-01`）；不影响 cron 的下一次 |
| `GET/POST /api/skills` `GET/PUT/PATCH/DELETE /api/skills/:name` | Skill 列表、正文/frontmatter CRUD、启停。列表回 `{name, description, min_role, enabled, source, load_error, updated_at, allowed_tools, requires_tools}` —— **不是 `SELECT *`**：`path`（宿主文件系统路径）、`content_hash`、整份 `frontmatter_json` 前端一个都不用；后两列是从 `frontmatter_json` 里**只取那两个字段**再发出去（`requires-tools` 没被满足的 skill 压根不进模型目录，那件事必须在列表上看得见，见 §3.8）。随包 skill 的 `DELETE` 与「改 `enabled` 以外任何字段」回 403 `skill_reserved` |
| `POST /api/skills/package` | 装一个 skill 包。multipart，字段 `file` 收 zip，可选 `name` / `subdir` / `overwrite`。与 `install_skill` 工具**共用 `installSkillPackage`**（端点自己抄一遍的话两条路迟早在校验上分叉）。落地即停用。包根有歧义时回 400 `skill_ambiguous_root` 并列出候选，重名回 409 |
| `GET/PATCH /api/plugins[/:name]` `POST /api/plugins/:name/reload` `GET/DELETE /api/plugins/:name/source` | Plugin。`reload` 回 `{name, hotReloadReliable, warning?}` —— 跑在 tsx 下时热重载静默跑旧代码，界面按这个字段分流（§3.8） |
| `GET/POST /api/mcp` `PATCH/DELETE /api/mcp/:name` `POST /api/mcp/:name/reconnect` | MCP transport CRUD、热重连。列表每行带 `credential` 与 `pendingAuthorization`（**都不含密文**，见 §3.8.1）与 `connectedAt` |
| `POST /api/mcp/:name/auth/start` | 开一次 OAuth 授权，回 `{status, authorizationUrl, expiresAt}`。`webui.publicUrl` 没配时 400 并说明缺什么；`auth.mode` 不是 `oauth` 时 400 `mcp_auth_mode` |
| `GET /api/mcp/oauth/callback` | 授权服务器重定向回来的落点。**在鉴权白名单里** —— session cookie 是 `SameSite=Strict`，跨站重定向不会带上它；准入判据换成 OAuth 自己的 `state`（32 字节随机、单次使用、10 分钟、只在进程内）。换完 token 单台重连，然后 `302 → /?mcpAuth=<status>` |
| `PUT/DELETE /api/mcp/:name/auth` | 设 / 清 bearer token。写入即加密（`LUOLI_MASTER_KEY`），任何读路径都不回显；拒 `«redacted»`。缺凭据库（通常是缺 `LUOLI_MASTER_KEY`）时四条 auth 端点一律 500 `mcp_auth_unavailable` —— **不假装保存成功**（照 `PUT /api/quota` 回 `not_implemented` 的先例） |
| `GET/PATCH/DELETE /api/custom-tools[/:name]` | 模型自撰写的工具。缺装配时 500 `not_implemented` 而不是空数组 |
| `GET /api/agents` `POST /api/agents/:name/dryrun` | 子 agent 定义与 NDJSON 隔离试跑（定义增删改走 `agent.agents` 配置） |
| `GET /api/logs` `GET /api/logs/:id` `GET /api/logs/trace/:traceId` `GET /api/logs/blob?ref=` | 日志 |
| `GET /api/usage` | 用量明细（`usage_ledger`，最近 1000 条） |
| `GET /api/usage/report?groupBy&from&to` | 用量聚合。`groupBy` ∈ `day\|chat\|user\|model\|alias\|agent`，非法值 400；`chat`/`user` 的行带回 `label`（服务端反查 `principals`） |
| `GET /api/quota` | 配额页的全部数据：`{quota, timezone, buckets:{day,month}, counters:[…], unpriced:[…], unpricedTotal, unimplemented:[…]}`。`counters` 是 `quota_counters` 全表（上限 500 行）**加上服务端合成的 `limit`**：`(scope, window)` 到配置的取值规则含 `perUser.byRole` 覆盖，让前端自己拼等于把 `bot.ts` 的规则实现两遍。`current` 标记该行是否落在当前 bucket；chat/user 行按 `principals` 反查 `role`/`label`/`username`；配了 `byRole` 时 user 行带 `limitApprox`（有效角色取 `min(用户, 会话)`，服务端只看得到前者）。`unimplemented` 转发 `KNOWN_UNIMPLEMENTED_CONFIG_KEYS` 里 `quota.` 开头的那几项，界面据此不给控件 |
| `PUT /api/quota` | body 是**相对 `quota` 的点分键**（`{"global.daily": 5}` → `quota.global.daily`），与 `PUT /api/sandbox` 一致。展开走 `assignDotted`、整体过 `configSchema`，落 `config_kv` + `config_revisions` 并广播 `config.changed`（与 `PUT /api/config` 同一套校验与审计）。非法键 400 `invalid_config_key`，校验失败 400 `invalid_config` + 逐条 `details` |
| `POST /api/quota/reset` | 重置计数器。不带 body = 全表清零；带 `{scope, subject?, window?, bucket?}` 只删匹配的行（**给了任一过滤条件就必须给 `scope`**，否则 400 `invalid_filter` —— 只按 `bucket` 删会跨 scope 误伤）。返回 `{changes}` |
| `GET /api/tasks` | 任务列表（`tasks` 表）：`?page=&size=` → `{items, total, page, size}`，排序「`state='running'` 优先，其余 `updated_at` 倒序」。**行里不带 `progress_json`**（那是详情的事，列表一次上百行带着它只是往浏览器推死重量），**加 `chatLabel` / `userLabel`**（服务端 `principalLabel` 反查，前端不实现第二份规则，同 `GET /api/usage/report`）。**没有 `POST /api/tasks/:id/cancel`**：子 agent 跑在父轮次的 abort 信号下，没有独立的取消句柄，界面上的任务 `[取消]` 打的是下面那条轮次取消 —— 造一个只能取消整轮的 task 端点等于起个会误导人的名字 |
| `GET /api/tasks/:id` | 单条任务的只读详情：整行 + `progress`（解析后的 `progress_json`，注意它是**最后一帧**不是时间线 —— `AgentManager.progress` 每次覆盖同一列）+ join 出来的 `turn{state, steps, toolCalls, costUsd, error}` 与 `agentRun{agentName, modelAlias, state, resultSummary}`。404 表示这一行不在了。这两块数据运行时一直在写，而界面此前一处都看不到（[21 §15](./21-webui-coverage-gaps.md)） |
| `DELETE /api/tasks/:id` | 删这一行**记录**，不是取消通道：`{removed:true}`；404；**409 `task_running`**（只拒 `state='running'`，其余四态都放行）。删掉之后这条子任务的进度与结果摘要没有了，而那一轮的 trace（`turns` / `agent_runs` / 日志）还在 —— 界面上的二次确认要把这句说出来。名字里是 `tasks` 不是 `turns`，两者删的东西完全不同 |
| `GET /api/turns/active` | 在途轮次：`[{id, key, chatId, userId, role, startedAt, steps, toolCalls, costUsd, inputTokens, outputTokens}]`。**来源是进程内的 `TurnRegistry`**（`turns` 表里可能有上次崩溃残留的 `running` 行），步数与花费仍从表里按 `id IN (…)` 一次取回；表里没有对应行时补零。进程内的 `AbortController` / 定时器不出现在响应里 |
| `POST /api/turns/:id/cancel` | 取消一个在途轮次：向该轮的 `AbortController` 发 abort，轮次走 `abortTurn` 落成 `cancelled`，**不删任何消息或上下文**。WebUI 是单角色 owner，可取消任何人的轮次。轮次不在注册表里（已经结束）时返回 `{cancelled:false}` 而不是 404 —— 这不是错误，是「没有作用对象」。写 `webui.action` 与 `turn.cancel` 审计 |
| `GET /api/approvals` `POST /api/approvals/:id/decide` | pending 与历史审批；owner 裁决。`GET` 收 `?page=&size=`（size 上限 200）→ `{items, total, page, size, pending}`，排序 `(state='pending') DESC, requested_at DESC`。**`pending` 是服务端全表 `COUNT(*) WHERE state='pending'`，不是当前页数出来的** —— 左侧导航那个角标读的就是它（§3.12），拿页内条数去推的话翻到第 2 页角标就悄悄变成 0，而门外还有人在等 `approval.ttlMs`。过期扫描（把超 `expires_at` 的 pending 标 `expired`）留在 `COUNT` 与 `SELECT` **之前**，否则这一页的数字和角标差一个刷新周期。此前是硬 `LIMIT 200`，撞上限静默截断 |
| `GET /api/config` `PUT /api/config` `GET /api/config/schema` `GET /api/config/revisions` | 配置。`/schema` 的三件套 `{schema, hotReloadable, unimplemented}` **都在 `data` 信封里**（统一客户端只解 `data`，挂在顶层的兄弟键会被静默丢掉，自动生成的表单就是靠这两份前缀表打「热更新 / 需重启 / 未接线」徽标的）。`PUT` body 为点分键；含 `__proto__`/`constructor`/`prototype` 段的键一律 400 `invalid_config_key`（原型污染发生在校验之前，一次请求就能让此后所有配置写入失败，docs/20 · W-CFG-01）；动到 `trigger.*` 时唤醒词要过 `checkWakeword`，不可用返回 400 `invalid_wakeword`。`/schema` 另带 `hotReloadable` 与 `unimplemented` 两个键名前缀表：不在 `hotReloadable` 里的键保存后需要重启才生效，WebUI 据此显示待重启徽标（[11](./11-config-reference.md)） |
| `POST /api/config/wakewords/check` | 逐条返回唤醒词的 `{ kind: contains\|regex, ok, reason }`，供面板即时提示；判定与运行时匹配同源 |
| `POST /api/maintenance/{backup,vacuum,cleanup-logs,gc-files,rebuild-fts}` | 维护。`gc-files` 只删没有任何 DB 行指向的孤儿，**不是过期策略** |
| `POST /api/restart` | 重启进程：走和 SIGTERM 一样的优雅关闭。**先回响应再退出**；没有 supervisor 时进程不会自己回来 |
| `GET /api/config/export` `POST /api/config/import` | 配置覆盖层的导出 / 导入。密钥类键不导出（不是导成 `«redacted»`）；导入按键覆盖、不删除 |
| `GET/PUT /api/config/yaml` | 原始 YAML 模式。解析在服务端（与 `loadConfig` 同一个解析器）；语法错误回 `{line, column}`，校验错误回 zod 路径。`GET` 跳过密钥类行并在 YAML 顶部生成注释逐条点名；`PUT` **按叶子落库**（递归对象、数组当叶子），并删掉「落在提交段之下、不在新叶子集里」的旧键 —— 密钥类行与 env 钉住的键排除在删除集之外。响应 `{keys, skipped, pruned, preserved, subsumed}` |
| `POST /api/auth/token` | 用 `/webui` 发的一次性 token 换 session。单次使用、5 分钟过期；**在鉴权中间件的放行名单里**（否则它自己就要求先登录） |
| `GET /api/logs?minLevel=` | 日志列表。`minLevel` ∈ `debug\|info\|warn\|error`，总览页的「最近错误」卡片用 `warn`。字段是 `log_events` 的列（snake_case）**减去 `data_json`，加 `data_bytes`** —— 单条载荷能到 `logs.bodyMaxBytes`（256 KB）、列表一次上千行，带着载荷刷新等于每次往浏览器推几十 MB。要正文走 `GET /api/logs/:id` |
| `GET /api/events` | SSE |

**定时任务的 `at` 在两个方向上不是同一种字符串**：`GET` 发 `toISOString()` 的 UTC 瞬时，
`POST` / `PATCH` 收墙钟串 `YYYY-MM-DDTHH:mm` 并**按任务行上的 `timezone`** 解释
（不是 `general.timezone`）。折算由前端做（§3.10.1 那条 ⚠）。两侧统一成 ISO 也是一种选法，
但那要求表单控件替人做时区换算，而 `<input type="datetime-local">` 收的本来就是墙钟 ——
真正危险的是**看起来两边都对**：直接回填 ISO 再保存，任务被静默挪走几小时，两次操作各自都不报错。

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
event: extensions.changed data: {kind: 'skill'}
```

⚠ `extensions.changed` **此前一直不在这张表里**（运行时在发、前端在收，只有文档缺一行）。它的
`kind` 字段留着扩展的余地，但**目前只有 `'skill'` 一个取值**：唯一的发送点是 `SkillLoader` 的
变更回调（`main.ts`，「扫描结果真的变了才广播」）。plugin / MCP / 自定义工具那几页靠别的事件顺带刷新，
不走这一条 —— 不要看着 `kind` 就以为另外三类也会发。

发送点（都在已有的日志点旁边）：`turn.started` / `turn.finished` 在 `packages/telegram/src/bot.ts`，
`turn.progress` / `usage` 在 `packages/core/src/agent/runtime.ts` 的 `onStepStart` / `onStepEnd`，
`quota` 在 `QuotaGuard.commit`（结算事务提交之后才发，先发会让订阅方读到旧值），
`task.updated` 在 `spawn_agent` 与 `report_progress`，`health` 在 `POST /api/providers/:id/test`
与 `POST /api/mcp/:name/reconnect`（这两处是健康状态**真的会变**的地方；没有独立的健康轮询器，
所以它不是周期心跳），`extensions.changed` 在 `SkillLoader` 的变更回调（`apps/bot/src/main.ts` 装配处）。
`log` 由 `LogSink` 自己发。

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

**这是盘上的实际形状**，不是构想。此前这一节列着 `stores/`（9 个）与 `components/`（10 个）
一整棵目录树，而两者都不存在 —— pinia 装在 `main.ts` 里但一个 store 都没有，共用组件全在 `ui/`。
文档写着不存在的结构，比不写更容易让人照着找。

```
packages/webui/
├── index.html
├── vite.config.ts             build → dist；dev server 5173，proxy /api → WEBUI_DEV_API ?? :8787
│                              （代理改写 Host + Origin 过 §2.1 的 Origin 闸，缺了就恒 403）
└── src/
    ├── main.ts                createApp + router + pinia（无 UI 框架插件）+ 自托管字体
    ├── styles.css             设计变量（浅/深两套 + 字体栈）+ 全站样式，唯一的样式来源
    ├── router/index.ts        三条路由（/login /setup /），全局守卫（未登录 → /login）
    ├── api/client.ts          fetch 封装：CSRF 头、401 跳登录、统一错误 toast、NDJSON 流
    ├── ui/                    自建原语，全部只用 styles.css 的变量
    │   ├── toast.ts           pushToast() / toastError()：全站唯一的通知通道
    │   ├── ToastHost.vue      右上角通知栈（success/info/warn/error）
    │   ├── confirm.ts         askConfirm()：二次确认的唯一通道，照 toast.ts 那对的形状
    │   ├── ConfirmHost.vue    确认框宿主，App.vue 挂一次
    │   ├── UiButton.vue  UiTag.vue  types.ts
    │   ├── UiCheckbox.vue  UiSwitch.vue  UiNumber.vue  UiSelect.vue   ← 点选与步进控件，见下
    │   ├── DataGrid.vue       表格：列定义 + 具名插槽 + 分页 + 单/多选
    │   ├── UiModal.vue  UiDrawer.vue  ChainPicker.vue  AttachmentStrip.vue
    │   ├── SchemaForm.vue     config.schema → 表单（设置页「全部配置」）
    │   └── UiLineChart.vue  UiBarChart.vue  UiRing.vue                ← 手写 SVG，无图表库
    ├── components/extensions/  扩展页四类各一个纯呈现组件 + 一份共用类型（§3.8）
    │   ├── types.ts           四类的行类型、来源判据、状态标签映射
    │   └── SkillList.vue  McpTable.vue  PluginCards.vue  CustomToolQueue.vue
    ├── components/tasks/       「任务与审批」页三张卡各一个自足组件（§3.12）
    │   ├── types.ts           三套 COLUMNS、行类型、状态枚举、toWallClock()/WALL_CLOCK_RE
    │   └── TasksCard.vue  SchedulesCard.vue  ApprovalsCard.vue
    └── views/
        ├── LoginView.vue
        ├── ExtensionsPage.vue 扩展页（§3.8）。ConsoleView 里只留 `<ExtensionsPage>` 一行
        ├── TasksPage.vue      任务与审批页（§3.12）：三张卡竖排的壳，同样只在 ConsoleView 里占一行
        └── ConsoleView.vue    其余 12 个页面（docs/00 §2.1 的 D-02 就是它）
```

- **`components/tasks/` 这三张卡各管各的端点、分页游标、弹窗与 busy 态，写操作不上提到父层。**
  扩展页那条「父层管所有写操作」的规矩防的是**跨卡共享 busy**，这里三张卡零交集；
  而服务端分页的页码必须和它的 loader 待在一起（同 `loadConversations`），提到父层就又变回争用点。
- **能挪进 `.ts` 的逻辑就别留在 SFC 里。** `types.ts` 一次写全三套列定义与折算函数，是因为
  **`.vue` 不进 `tsc`**（`tsconfig.json` 里那条 `packages/**/*.vue` 是空转）——
  留在 SFC 里的那部分等于没有类型检查，只有渲染用例兜得住。
- **`scripts/copy/extract.ts` 的 `BROWSER_FILES` 要跟着改**：`views/` 是逐个列名字的、
  `components/` 下没有通配。不加进去，新 UI 的文案在 dev 校样面板里一句都看不见。

- **抽子组件一律用普通 `<script setup>`，不返回任何 Proxy。** 上一次把控制台拆成 15 个子视图时，
  子 SFC 的 `setup` 返回了一个只有 `get` 陷阱的 Proxy，而 Vue 解析模板绑定走
  `hasOwn(setupState, key)` —— `pnpm build` 通过、`pnpm test` 全绿、`/login` 打得开，
  而 14 个页面全是空白（`docs/24 · R-UI-01`）。**`.vue` 模板不进 `tsc --noEmit`**，
  所以判据只能靠 `tests/webui/console.render.test.ts` 真的渲染一次。
- **WebUI 不 import `@luoli/shared`。** 那个包的 `exports` 指向 `dist/index.js`，而它 import
  `node:crypto`；vite 会把它 externalize 成一个一调用就抛的桩，表现是整页空白加一条
  「Module "node:crypto" has been externalized for browser compatibility」。而 vitest 把
  `@luoli/shared` 别名到 `src/index.ts` 并跑在 node 里，**所以渲染用例是绿的** ——
  这条只有真浏览器发现得了。要共用常量就在前端自己留一份（`ROLES` 已经是这么做的）。

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
- **文案版式工具层**（`styles.css` 末尾的 `u-*`）。八组，同组互斥、空值即清掉这一组：
  `u-push-{start,center,end}`（元素在容器里贴哪边）、`u-text-{start,center,end}`（文字在自己框里
  怎么对齐）、`u-gap-{x,y}-{0..3}`（与左边 / 上面那一块的距离）、`u-size-{xs,sm,lg,xl}`（字号）、
  `u-weight-{400,500,600,700}`（字重）、`u-slant-{italic,normal}`（斜体）、`u-display-none`（隐藏）。
  这些 token 由 dev 文案面板（`COPY_EDIT=1`，见 [`docs/copy/README.md`](./copy/README.md)）写进模板的
  `class`，也可以手写。四条纪律：
  **① 不碰颜色** —— 颜色承载状态语义（危险 / 主次 / 禁用），逐句改颜色会让同一个红色在两处意思不同。
  （字号 / 字重原先也在禁区里，后按需求方要求开了，代价用下面第 ② 条兑。）
  **② 档位固定，不开任意数值**，且**字号是「基准 × 倍数」而不是绝对值**：
  `.u-size-lg { font-size: calc(var(--u-base, 1em) * 1.12) }`，基准由面板量元素**自己**的字号写成
  内联 `--u-base`。不能直接写 `1.12em` —— `em` 在 `font-size` 上是**父级**的字号，实测这套界面上
  一个 64px 的 `<h1>`（父级 16px）点「大」会缩到 17.9px，与按钮上写的字正好相反；而 CSS 里没有
  任何单位能表达「我自己现在这么大的 1.12 倍」，所以基准必须存下来（也因此点两次不叠加）。
  **③ 这一层带 `!important`，且只有这一层允许**。`.auth-card p { margin: 0 }`（0,1,1）、
  `.hero-row p:last-child { margin: 0 }`（0,2,1）这类既有规则都比裸工具类（0,1,0）更特异，
  不带 important 的话面板上点了没反应 —— **一个静默失效的控件比没有这个控件更糟**。
  **④ 位置与留白一律用 logical 属性**（`inline` / `block`），深浅色两套主题与将来的 RTL 都不受影响。
- **自由拖拽的偏移写成元素自己的 `style="translate: 12px -4px"`**（同一个面板产出）。
  **不许写内联 `transform`**：`transform` 被按钮按压反馈（`scale(.97)`）、`rise-in` 入场、页面过渡
  用着，内联写上去会把它们整条顶掉；`translate` 是独立的变换属性，与 `transform` 叠加而不是互斥，
  这套样式里一处未用。代价是明知的：偏移是固定像素，换个断点宽度它还偏这么多，且 `translate`
  不参与排版，推远了会与邻居重叠。所以它适合小幅微调，不适合当布局手段。
- **同一个面板还能真的删元素**（`u-display-none` 是「先藏起来」，删是从模板里摘走）。三条否决判据
  写在 `ElementInfo.guards`，命中即不许删：后面紧跟着 `v-else`/`v-else-if`（81 处，删掉前面那个
  `v-if` 会让整个文件编译不过）、带 `ref`（8 处，脚本运行时炸）、模板唯一的根节点（22 处）。
  三条都是**保存之后才炸**的形态，所以判据在 AST 侧、由服务端否决，面板只负责把理由念出来。
- i18n：**结构上没有 i18n 层，文案就在各 SFC 里**。改写走 dev 文案面板
  （`COPY_EDIT=1`，见 [`docs/copy/README.md`](./copy/README.md)）：抽取与落回都在
  `scripts/copy/extract.ts`，`applyChanges` 是唯一写入口。原先这里写「文案集中在 `src/i18n/zh-CN.ts`，预留 `en`」，
  而 [14 §4](./14-open-questions.md) 同时写着「i18n 第一版不做」且 `general.locale` 已从 schema 摘除
  —— 那个目录从来没存在过，两处都是在描述一个不存在的结构。真做多语言时再按 14 §4 那条路一起加回来。

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
