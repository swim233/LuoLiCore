# 12 · SDK 接入

> 规格层，活文档，与 [00](./00-state.md) 同步维护。第三方后端经独立前缀 `/sdk/v1` 接入本实例的
> core：新建会话、发消息（非流式/流式）、复用会话、管理会话。规划来源为实施计划文档
> 《SDK 系统实施计划》（仓库内未跟踪，不入库）；该文档的任务编号（`T1.1`–`T3.13`）、已定结论
> 编号（`1`–`22`）、审阅拍板（`Q-A`/`Q-B`/`Q-C`）与修订约定（`A1`–`A10`）与本文各节的对应关系见
> [§14](#14-与实施计划的对应)。源码注释仍引用这些编号，查阅时先查 §14 落到具体章节。

## 1. 定位与边界

会话是一等实体，落在既有上下文引擎之上（`contexts` / `context_messages` / `context_commits` /
`refs`，git 式模型不改，见 [02](./02-context-engine.md)）。来源（`sources`）是新增维度：Telegram
内建一行 `id='telegram'`，每个第三方接入方各占一行，密钥签发时绑定来源。SDK 调用方的角色恒
`trusted`、`isPrivate: true`，不提供角色能力（授予、降级、拉黑）。

不在本次范围（对照实施仍以此为准）：

- 工具调用。SDK 侧只有记忆三件（名义上，实际可达两件，见 [§8](#8-工具目录)），派发族、
  `schedule_*`、归档检索、Telegram 输出五件均不可达。
- 按来源的配额限额与在途排队上限（欠账，见 [§13](#13-欠账与限制)）。
- `checkout` 与 `undo`：git 式回溯是运维动作，交给第三方会构造出无法解释的上下文状态。
- `@luoli/sdk-client` 的发布流水线（私有 registry 配置另行）。
- 裸 SQL 收拢到仓储层（`D-01`，与本次无依赖关系）。
- `bot.ts` 接入 `runTurn()`（回归面是整条 Telegram 链路，另需单独一轮）。
- WebUI 对 SDK 会话的浏览与管理（列表混列、无消息元数据，记入 [21](./21-webui-coverage-gaps.md)）。

## 2. 数据模型引用

DDL 权威来源为 [03 §2.10](./03-data-model.md#210-扩展与记忆)（`sources`、按来源分区后的
`memory_docs`/`memory_revisions`）、[03 §2.15](./03-data-model.md#215-sdk-密钥与会话)
（`api_keys`、`contexts.source_id`/`deleted_at`、`sdk_sessions`）与
[03 §2.16](./03-data-model.md#216-sdk-仓储层与会话-purge)（仓储层访问口径、purge 删除面）。
本节只列本文其余各节都要用到的字段级事实，不重复 DDL：

- `sources.id`：`telegram` 固定；SDK 来源由 `SourceRepository.create()` 生成 ulid（Crockford
  Base32，天然满足「不含 `:` 与路径字符」的约束）。它兼三重身份：磁盘目录段
  （`memory/sources/<sourceId>/`）、`messages.from_user_id` 前缀、`primemory` 复合 subject 的
  前缀（`packages/core/src/memory/scope.ts` 的 `assertValidSourceId`）。
- `api_keys.source_id`：外键到 `sources(id)`，`foreign_keys=ON` 下强制。
- `contexts.source_id`：默认 `'telegram'`，SDK 会话建立时写入真实来源 id；`deleted_at` 是
  SDK 会话动词 `delete`（软停用）的标记，与「彻底删除会话」（`purge`，整行清除）是两个动词。
- `sdk_sessions.key`：`contexts.key` 的外键（`chat:<uuid>`），单列一表不并入 `contexts`——SDK
  专有列混进上下文引擎的表会让每一处读取都带着它。`end_user_id` 不落这张表，它是每请求必填
  字段，落点是 `messages.from_user_id`。
- `usage_ledger.source_id`：记账口径见 [§9](#9-记账)。
- `memory_docs`：`pubmemory`/`character`/`assist` 三个来源级 scope 的 subject 即 sourceId 本身；
  `primemory` 的 subject 是复合键 `<sourceId>:<sessionId>`（SDK 场景下 sessionId 即 `chatId`）。
  计算函数只有一个实现点：`packages/core/src/memory/scope.ts` 的 `memoryScopeSubjects()`。

## 3. 认证

### 3.1 token 形态与签发

`sk-` + id 段（16 字符）+ secret 段（32 字符），字母表恒 `[A-Za-z0-9]`
（`packages/core/src/sdk/keys.ts` 的 `ALPHABET`）——字母表刻意不含 `-`/`_`：内置脱敏正则
`/\bsk-[A-Za-z0-9_-]{16,}\b/g`（`packages/core/src/secrets.ts`）靠结尾的 `\b` 圈定匹配终点，
若字母表含 `-`/`_` 且恰好落在 token 结尾，`\b` 不成立，尾字符会漏出脱敏。id 段由
`randomToken()`（基于 `node:crypto` 的 `randomInt`，拒绝采样非取模）生成，不做碰撞重试
（62^16 空间远大于现有 `ulid()` 的碰撞处理力度）。

存储：`secret_enc` 落 `Secrets.encrypt(secret 段)`（随机 salt + 随机 IV，同一明文每次加密结果
不同，无法反向比对查行）。

### 3.2 校验

`verifyApiKey()` 按 id 段查行，取该行 `secret_enc` 或（id 不存在时）一个每 `Secrets` 实例只生成
一次的常量密文（`WeakMap<Secrets, string>` 缓存，主密钥轮换窗口内新旧两个 `Secrets` 实例各自
持有互不干扰的常量密文），随后统一走 `decryptEquals()`（`Buffer` 长度比较 + `timingSafeEqual`）
——id 存在与否走同一段代码、同一次解密与比较，两分支时延一致。

失败（token 不匹配 `sk-<16><32>` 形态、id 不存在、secret 不对、已停用 `disabled_at`、
来源已停用 `sourceDisabledAt`、已过期 `expiresAt <= now`）统一返回 `{ok:false}`，不带任何能
区分具体原因的字段；`/sdk/v1/*` 的 Bearer 中间件把它统一映射成 401 `unauthorized`。

校验成功后 `touchLastUsed(id, now)` 更新 `last_used_at`（在 `verifyApiKey()` 内部完成，不是
调用方的职责）。

### 3.3 通道隔离

Bearer（`Authorization: Bearer sk-...`）只对 `/sdk/v1/*` 生效，`packages/server/src/sdk/auth.ts`
的 `sdkBearerAuth` 中间件从不读 `luoli_sid` cookie；cookie 会话只对 `/api/*` 生效，其鉴权中间件
从不读 `Authorization` 头。双向 401：无 key 访问 `/sdk/v1/*` 得 401，SDK key 访问 `/api/*` 得
401，`luoli_sid` cookie 访问 `/sdk/v1/*` 得 401——两条通道互不识别对方的凭据，不存在一把凭据
同时打开两侧的情形。

`sourceId` 只有一个写入点：Bearer 中间件校验通过后 `ctx.set("sourceId", verified.key.sourceId)`；
`/sdk/v1/*` 下任何端点都不接受请求体或查询串传入 sourceId 覆盖它——跨来源隔离的判据只在
这一处成立。

## 4. `/sdk/v1` 端点契约

十个端点，独立中间件挂载（`mountSdkV1()`），不改 `app.ts` 的 `/api/*` cookie 免验白名单。

| 方法 | 路径 | 请求 schema | 响应 schema | 状态码 |
|---|---|---|---|---|
| POST | `/sdk/v1/sessions` | `sdkCreateSessionInputSchema`（`modelAlias`/`outputFormat`/`label` 均可选） | `sdkSessionResponseSchema` | 200 / 400 / 401 / 500 |
| GET | `/sdk/v1/sessions` | `sdkPageQuerySchema`（`cursor`/`limit`，查询串） | `sdkSessionListResponseSchema` | 200 / 400 / 401 / 500 |
| GET | `/sdk/v1/sessions/:id` | 无 | `sdkSessionResponseSchema` | 200 / 401 / 404 / 500 |
| PATCH | `/sdk/v1/sessions/:id` | `sdkUpdateSessionInputSchema`（`modelAlias`/`label`；`outputFormat` 建会话后不可改） | `sdkSessionResponseSchema` | 200 / 400 / 401 / 404 / 500 |
| DELETE | `/sdk/v1/sessions/:id` | 无 | `sdkOkResponseSchema` | 200 / 401 / 404 / 500 |
| POST | `/sdk/v1/sessions/:id/purge` | 无 | `sdkOkResponseSchema` | 200 / 401 / 404 / 500 |
| POST | `/sdk/v1/sessions/:id/reset` | 无 | `sdkResetResponseSchema`（`commitId`） | 200 / 401 / 404 / 500 |
| GET | `/sdk/v1/sessions/:id/commits` | `sdkPageQuerySchema` | `sdkCommitListResponseSchema` | 200 / 400 / 401 / 404 / 500 |
| POST | `/sdk/v1/sessions/:id/messages` | `sdkSendMessageInputSchema`（`endUserId`/`text`/`modelAlias?`） | `sdkMessageResponseSchema`（`text`/`usage`/`turnId`） | 200 / 400 / 401 / 404 / 429 / 500 / 502 / 409 |
| POST | `/sdk/v1/sessions/:id/messages/stream` | `sdkSendMessageInputSchema` | SSE，见 [§6](#6-流式协议) | 200（成功与失败共用；失败经 SSE `error` 事件表达）/ 400 / 401 / 404 / 429（配额，发生在写响应头之前） / 500 |

十端点的 zod 定义唯一来源为 `packages/sdk-client/src/schema.ts`（子路径 `@luoli/sdk-client/schema`
导出），服务端 `safeParse` 校验，客户端类型取 `z.infer`——两侧不各自维护一份形状。

会话解析（`resolveSession()`）按 `chatId`（URL 段裸 uuid）换算 `contexts.key` 后按
`(sourceId, key)` 取行：跨来源与不存在统一 404 `not_found`（不泄漏存在性）；存在但已软停用
返回更精确的 404 `session_deleted`（供客户端与「压根没这个会话」区分）。`DELETE`（幂等软停用）
与 `purge`（对已停用会话同样生效）不经过这层判据——前者对已停用会话重复调用应当成功，
后者的常见调用对象正是已停用的会话。

分页游标不透明：`GET .../sessions` 用 `(created_at, key)` keyset 编码为 base64url；
`GET .../commits` 用 `context_commits.seq` 编码为十进制字符串。**非法 cursor 静默返回首页**，
不报 400——`decodeCursor()` 解析失败按「无游标」处理；`commits` 端点里 `Number(cursor)` 非有限数
时同样退化为无 `before` 参数的首页查询。客户端应把 cursor 当不透明串使用，不自行构造。

`modelAlias` 校验复用 `agent/runtime.ts:1467-1474` 同一口径（`registry.chain(alias).length === 0`
即不可用），非法值 400 `invalid_request`，不静默退回默认别名链的首个存在项。

## 5. 错误契约

信封：`{ok:false, error:{code, message, retryable}}`（`packages/server/src/sdk/errors.ts` 的
`sdkError()`，建在 `/api/*` 共用的 `apiError()` 之上，叠加 `retryable` 一个字段）。`code` 进
契约（`sdkErrorCodeSchema` 十值枚举），`message` 不进契约（任意字符串，客户端不做形态假设）。

| code | HTTP 状态 | retryable | 场景 |
|---|---|---|---|
| `unauthorized` | 401 | false | Bearer 缺失或校验失败（各失败原因不区分） |
| `not_found` | 404 | false | 会话/来源/密钥不存在，或跨来源访问 |
| `invalid_request` | 400 | false | 入参不符合 schema、`modelAlias` 不可用 |
| `turn_queue_full` | 429 | true | `TurnConcurrency` 排队已满（`Retry-After: 5`） |
| `upstream_error` | 502 | true | 轮次已开起但产出/投递/提交失败（模型调用链路故障） |
| `session_deleted` | 404 | false | 会话存在但已软停用 |
| `not_implemented` | 500 | false | 部署未装配 SDK 依赖（`sources`/`apiKeys`/`secrets`/`sdk` 任一缺失） |
| `internal` | 500 | 视调用点而定 | 见下方说明 |
| `quota_exceeded` | 429 | true | 配额预留失败（无 `Retry-After`，见下方说明） |
| `cancelled` | 409 | true | 轮次被 `TurnRegistry.cancel()` 中止 |

`Retry-After` 仅 `turn_queue_full` 携带，固定 `5`（A9：无更好的估计口径，`turnTimeoutMs` 量级
过大不适合作退避基准）。

`quota_exceeded` 不带 `Retry-After`：额度按天/月窗口重置，5 秒退避在这个语境下是误导——它会让
客户端在配额耗尽的当下持续轮询，而实际要等到下一个计费窗口。

`internal` 的 `retryable` 因调用点而不同，契约上不固定：`runTurn()` 的 `stage:'setup'` 失败
（`buildTrigger`/`openTurn`/`turns.create` 本身抛出）映射时传 `true`；开轮前归档（`appendNext`）
直接抛出时映射传 `false`（默认值，未显式传参）。两处调用点尚未统一语义，读到 `internal` 时
不应假设它总是可重试。

`cancelled`（409）的客户端约束：`retryable:true` 语义是「可以发起新一轮」，不是「这次请求本身
值得重放」——**不应自动重试**。轮次被取消可能来自客户端自身断连（此时响应内容不可观测），
也可能来自 `POST /api/turns/:id/cancel`（WebUI owner，与本次 SDK 请求共用同一个
`TurnRegistry`）；后一种情形下发起请求的客户端仍连着，应读到「轮次被取消」而非「上游模型
服务出错」，但两种来源都不构成「立即重发同一条消息」的理由——重发前应确认是否仍需要这次
调用。

## 6. 流式协议

`POST /sdk/v1/sessions/:id/messages/stream`，四事件：`delta`（文本增量，`{text}`）、`done`
（最终文本与用量，`{text, usage}`）、`error`（`{code, message, retryable}`，与 HTTP 错误体
同形）、`queued`（进入排队时一次，`{position?}`，`position` 目前从不由服务端填充）。

顺序不变量：`queued`（如果出现）先于任何 `delta`——它在 `acquire()` 之前、`turnId` 产生之前
触发，排队时长可能长达数秒，事件必须在排队开始那一刻就发出；`delta` 零至多次；末尾恰好
`done` 或 `error` 之一，二者互斥且终结这个流。`error` 事件发出后立即 `close()`，流正常关闭，
不半开。

`done` 事件**不含 `turnId`**（与非流式端点的 `sdkMessageResponseSchema` 不同，后者含
`turnId`）：需要它时经 `GET .../commits` 反查——最近一条 `kind='turn'` 的提交带着
`turnId` 字段。

队列满的流式形态是架构限制，不是缺陷：`queued` 事件在 `acquire()` 之前发出，此时无法区分
「会排队等待」与「队列已满、即将被拒」；真正的拒绝（`turn_queue_full`）随后仍以 SSE `error`
事件表达（无法再改状态码，响应头已在配额判定通过、流开始建立时锁定为 200 +
`text/event-stream`）。因此队列满在流式端点上的可观测形态是 **200 SSE + `queued` 事件 +
随后一条 `error:turn_queue_full`**，不出现 HTTP 429。SSE 路径下没有 `Retry-After` 头可用
（流已在传输中），客户端固定按 5 秒退避（`@luoli/sdk-client` 内置常量，见 [§12](#12-客户端-luolisdk-client)）。

配额拒绝（`quota_exceeded`）发生在响应头写出之前——若判定不通过，端点仍以普通 HTTP 429 响应，
不必先打开 SSE 连接才报错。

响应头：`Content-Type: text/event-stream`、`Cache-Control: no-cache`、`Connection: keep-alive`、
`X-Accel-Buffering: no`（关闭反向代理的响应缓冲；nginx 认这个头，无反代的部署里它无副作用；
不设置的话逐块转发的 `delta` 事件会被代理攒到轮次结束才一次性放出，等价于退化成非流式）。

**无心跳帧**：连接在轮次执行期间没有任何保活数据。部署要求 `proxy_read_timeout ≥
concurrency.turnTimeoutMs`（默认 `600s`），否则反向代理会按自己的空闲超时（nginx 默认 `60s`）
提前掐断连接——比本系统自身的轮次超时更早生效，且客户端读到的将是一次传输层中断而非
`error` 事件。加心跳帧是后续可能的改进，本次未做。

客户端断连（连接中止）映射到 `TurnRegistry.cancel()`：排队阶段用 `onPending` 拿到的 pendingId
取消，`openTurn` 成功后改用真实 `turnId`。

## 7. 轮次语义

开轮前归档（不是 `buildTrigger` 回调内部完成）：`dependencies.archive.scope(chatId, null)
.appendNext()` 在配额预留、并发闸判定之前就把这条消息落库，`from_user_id` 为
`<sourceId>:<endUserId>`——与 Telegram 侧「先归档、后判定」的先例一致。`endUserId` 只做长度
（1–256）与控制字符校验（`sdkEndUserIdSchema`），取值本身不设形态限制：整数用户 id 在第三方
后端极常见，防碰撞完全靠服务端加前缀，`<sourceId>:<endUserId>` 永远不与 Telegram 的数字 id
空间重叠。

`initiatorUserId` 与 `userId`（配额预留的 subject）均取会话的 `chatId`（`session.chatId`，
uuid）——SDK 没有 Telegram 数字 id 意义上的「用户」，会话本身就是计费主体；因此 `perUser` 与
`perChat` 两档配额落在同一个 subject 上，不是两个独立维度。`endUserId` 只出现在
`messages.from_user_id`，不参与配额、不参与并发闸的 key。

A8：排队中断连或队列满（`stage:'queue'`）、以及开轮本身失败（`stage:'setup'`，`buildTrigger`/
`openTurn`/`turns.create` 抛出）时，已归档的那条消息置 `deleted_at`（`archive.markDeleted()`）。
`stage:'turn'`（轮次已开起但产出/投递/提交失败，含开轮后才发生的取消）**不**标记——`abortTurn`
已把这段历史记成 `cancelled` 或 `failed`，触发消息是这条记录的一部分，标记删除会与它冲突。
标记的理由：客户端收到错误后可以重发，留作背景消息反而让下一次请求把这条客户端认为失败的
消息当成历史的一部分。

审批 fail-closed：SDK 轮次没有人工审批通道。`memory_write` 在
`memory.pubWriteRequiresApproval=true` 时升级为需要审批（`memory_write(pub)`），此时
`ToolRegistry.execute()` 在 `context.agentKind==='sdk'` 分支直接返回 `{ok:false,
error:'approval_unavailable'}`，不进入 `DatabaseApprovalBroker.request()`——不写一条永远无人
处理的待批准记录，也不等到 TTL 过期才判定无人接单。

提示词：装配走 `PromptAssembler.buildSdk()`，不是 `assembleMainPrompt(...,'sdk')`——内核换成
`SDK_KERNEL[outputFormat]`，强制不渲染 TOOL CATALOG（SDK 会话没有「worker 能做的事」这个
目录概念）。详见 [06 §1.3](./06-prompt-and-memory.md#13-sdk-会话的内核sdk_kernel)。

角色恒 `trusted`：`runTurn()` 的 `effectiveRole` 与工具目录判定均以此为准，不做任何角色重算
（与定时任务「每次触发重新计算有效角色」的规则不同——SDK 没有可变的用户身份可重算）。

`agent_runs.kind` 恒为 `main`、`worker_kind` 恒为 `NULL`：SDK 顶层轮次不经派发，与 Telegram
主轮次记账口径一致，不产生任何 worker 行。

## 8. 工具目录

**默认三件，按来源可配。** 未配置的来源走 `SDK_AGENT_TOOLS` 常量
（`memory_read` / `memory_list` / `memory_write`，`packages/core/src/tools/policy.ts`）；配置过的
来源走 `sources.tools`（[§11](#11-管理面-apisdk)的 `PATCH /api/sdk/sources/:id/tools`）。取数口是
`sdkToolsFromConfig(row.tools)`：`NULL` 回落常量，空数组表示这个来源一件工具都不给——两者
不同，后者是显式配置的一种取值。存量部署与新建来源都是 `NULL`，因此不配就是原行为。

判据仍是 `toolCallableBy(kind, name, sdkTools?)` 一个函数，强制点仍是两处
（`#eligible()` 目录取数与 `admit()` 准入复查），与 `main`/`lw` 相同。本轮的集合在开轮时
一次性写入 `RuntimeTurnContext.sdkTools`（与 `sourceId` 同一条路，由 `/sdk/v1` 的路由查库后
传给 `runTurn()`），注册表不自己查库。每轮查一次而不缓存：改了配置就该下一轮生效。

**按来源而不是按密钥。** 密钥签发时绑定来源（[§3.1](#31-token-形态与签发)），同一来源可以有
多把密钥；按密钥配会让「轮换一把钥匙」变成一次权限变更。

**放开的是 `agentKind` 轴，不是安全边界。** 两根轴正交（[05 §4](./05-tools-and-permissions.md#4-权限矩阵权威表)）：
角色轴回答「这个身份够不够格」，`agentKind` 轴回答「这一档 agent 该拿哪些」。SDK 会话角色
恒 `trusted`，因此 `minRole` 高于 `trusted` 的工具配进白名单也到不了 `toolCallableBy()`——
`memory_list`（`minRole: 'owner'`）就是这种情况，它在名义白名单里但对 SDK 恒不可达（D-A 拍板
保留现状，不下调 `minRole`：那会把「跨来源枚举 `memory_docs`」这项 owner 专属能力一并开给
`trusted`）。审批同样不变，仍然 fail-closed（[§7](#7-轮次语义)）：放开白名单不会把一个需要
人工裁决的调用变成免审批的调用。

**结构性禁止，配了也不生效**（`SDK_FORBIDDEN_TOOLS`）。与「默认不给」不是一回事——上面那份
默认白名单是范围决定，可以按来源放开；这两族是与 SDK 通道的形状冲突，放开会产生没有正确
行为可言的调用：

| 族 | 成员 | 为什么 |
|---|---|---|
| 派发 | `spawn_worker` `spawn_harness` `spawn_acp` `read_worker_result` `ask_parent` | SDK 顶层轮次 `agent_runs.kind` 恒 `main`、`worker_kind` 恒 `NULL`（[§7](#7-轮次语义)），接了派发之后这条记账口径与实际产生的 worker 行对不上；`read_worker_result` 没有派发则永远读不到东西 |
| Telegram 输出 | `send_message` `send_photo` `send_file` `react` `pin_message` `stay_silent` | SDK 会话没有 Telegram chat，调用只会投到空处；`stay_silent` 表达的是「这一轮不回 Telegram」，而 SDK 的调用方在等一个响应体 |

两处都拦：管理面写入时**拒收**（400 `tool_forbidden_for_sdk`，让运维得到一句明确的拒绝，
而不是一份「保存成功但少了一项」的配置），运行期读侧再滤一次（防库被直接编辑过）。

`search_tools` 与 `schedule_*`、归档检索五件不在结构性禁止之列——它们默认不给，但可以按来源
放开。`search_tools` 放开时需注意 SDK 会话不渲染 TOOL CATALOG（见下），折叠目录这个概念在
这条路径上不成立。

**TOOL CATALOG 仍然不渲染。** 那一块描述的是「worker 能做的事」，供主 agent 判断值不值得派一个
出去；SDK 不接派发（结构性禁止），因此放开白名单也不改变这一点。模型看得到的是 RUNTIME 块
里的「可用工具」行（`activeTools`，按本来源的集合取数）与请求体里那几份工具 schema——
它直接调用叶子工具，不需要那个目录。

## 9. 记账

`UsageLedger.record()` 写 `usage_ledger.source_id`，三档取值：

1. SDK 轮次：`turn.sourceId`（`runTurn()` 写回该会话的来源 id）。
2. Telegram / 定时任务轮次：调用方显式回落 `TELEGRAM_SOURCE_ID`（字面量 `'telegram'`）。
3. 均未设置：落 `NULL`——写入点不猜测来源，一条无法确认归属的花费不该被计入某个具体来源的账。

四处写入点统一传 `turn.sourceId ?? TELEGRAM_SOURCE_ID`：`runtime.ts`（主轮次收尾）、
`step-observers.ts`（真实用量落点）、`subagent.ts`（worker 收尾）、`ask-arbiter.ts`
（仲裁调用）。`record()` 自身不做回落。

**WebUI 试跑（`dryRunWorker`，`apps/bot/src/compose.ts`）落 `'telegram'` 桶**：试跑构造的
`turn` 对象不设置 `sourceId`，经 `subagent.ts` 的兜底逻辑落回 `TELEGRAM_SOURCE_ID`——
它在花费记账上与真实 Telegram 轮次不可区分，[03](./03-data-model.md) 的三档写入规则未单独
为试跑开一档。

按来源聚合经 `UsageLedger.sourceUsage(sourceId)`，`purge` 该会话后聚合值不变（`usage_ledger`
不在 purge 删除面之列，见 [§10](#10-两种删除动词)）。**本次不做限额**（欠账 `SDK-01`，见
[§13](#13-欠账与限制)），`sourceUsage()` 目前**没有任何 HTTP 端点或 WebUI 页面读取它**——
写入侧完整，读出侧只有单元测试直接调用这个方法。回链：`docs/00 · SDK-01`、`docs/00 · SDK-02`
（[00 §2.1](./00-state.md)）。

## 10. 两种删除动词

**软删（`DELETE /sdk/v1/sessions/:id`）**：`SdkSessionRepository.softDelete()`，置
`contexts.deleted_at`。幂等（重复调用不覆盖已有时间戳，仍返回成功）。效果三条：不可开轮、
不可读（`resolveSession()` 返回更精确的 404 `session_deleted`）、不出现在
`GET /sdk/v1/sessions` 与 `GET /api/chats`（均加了 `deleted_at IS NULL` 过滤）。库行与磁盘文件
均保留。

**purge（`POST /sdk/v1/sessions/:id/purge`）**：`SdkSessionRepository.purge()`，一个事务内
按外键顺序硬删七类：`sdk_sessions` → `memory_revisions`（该会话 primemory 修订行）→
`memory_docs`（该会话 primemory 行，磁盘文件由 `purgeSdkSession()` 事后 `rmSync`）→
`messages` → `turns` → `context_messages`/`context_commits`/`refs` → `contexts`。**保留**：
`usage_ledger`、`agent_runs`、`approvals`、日志——记账与审计历史不因会话被删而消失。对已软
停用的会话同样生效（purge 不经 `resolveSession()` 的「已停用即 404」判据）。跨来源调用返回
`null`（404 `not_found`），不执行任何删除、不泄漏该会话属于别的来源。

purge 成功后落一条 `warn` 级 `sdk.session_purged`（`sourceId`、`chatId`），这是这条会话曾经
存在过、被谁删过的**唯一凭据**——与 `schedule.purged` 同一先例。库行与磁盘文件都不在了之后，
不留这一行就什么都查不到。

## 11. 管理面 `/api/sdk/*`

六端点，挂在 `/api/*` 前缀下（`mountSdkAdmin()`），复用既有的 cookie 会话 + CSRF + Origin 闸
+ 写操作审计日志中间件链，不单独实现任何一层；仅服务 WebUI 的 owner 管理面，与 `/sdk/v1/*`
的 Bearer 通道无关。

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/sdk/sources` | 列出全部来源（含已停用） |
| POST | `/api/sdk/sources` | 新建来源（只填 `name`，`id` 服务端生成 ulid） |
| GET | `/api/sdk/sources/:id/keys` | 列出该来源的密钥（不含密文） |
| POST | `/api/sdk/sources/:id/keys` | 签发密钥（返回明文 token，仅此一次） |
| PATCH | `/api/sdk/sources/:id/tools` | 改这个来源的 SDK 工具白名单（`{tools: string[] \| null}`，[§8](#8-工具目录)） |
| DELETE | `/api/sdk/keys/:id` | 软停用密钥 |
| GET | `/api/sdk/keys/:id/reveal` | 回显密钥明文（二次确认后调用） |

管理端错误码（`apiError()`，无 `retryable` 字段，与 `/sdk/v1/*` 的错误契约不同形）：

| code | HTTP 状态 | 场景 |
|---|---|---|
| `not_implemented` | 500 | 部署未装配 `sources`/`apiKeys` 仓储 |
| `secrets_unavailable` | 500 | 未配置 `LUOLI_MASTER_KEY`，无法签发或回显密钥 |
| `invalid_name` | 400 | 来源名称为空或超过 64 字符 |
| `not_found` | 404 | 来源或密钥不存在 |
| `source_not_sdk` | 400 | 对 `kind='telegram'` 的内建来源签发密钥（它走 Telegram 自己的鉴权，签发一把能代表它的 key 会绕开那条路径） |
| `source_disabled` | 400 | 对已停用的 SDK 来源签发密钥（停用是「不再接受新签发」的语义，已签发的旧密钥不因此失效） |
| `invalid_tools` | 400 | `tools` 不是工具名数组，也不是 `null` |
| `tool_forbidden_for_sdk` | 400 | 配进了结构性禁止的两族（[§8](#8-工具目录)）—— 拒收而不是静默滤掉：一份「保存成功但少了一项」的配置比一句明确的拒绝难查 |
| `invalid_label` | 400 | `label` 超过 200 字符 |
| `invalid_expires_at` | 400 | `expiresAt` 不是数字或不晚于当前时间 |
| `secret_undecryptable` | 500 | 回显时解密失败（主密钥轮换后旧密文用当前主密钥解不开） |

`sdk.key_revealed` 与 `sdk.key_reveal_failed` 的区别是**明文是否出网**：前者是每次成功回显都
落的一条 warn（含 keyId、sourceId、actor），不管密钥是否已停用、是否为重复回显——这一行是
「谁在什么时候看过明文」唯一的凭据；后者是解密失败时落的一条 warn（含失败原因），明文没有
出网，不构成「谁看过明文」的凭据，因此单独记档，不算进 `sdk.key_revealed` 那条计数。

**已停用的密钥仍可回显**：`ApiKeyRepository` 没有重新启用的方法，停用是终局状态，回显它
不产生新的可用凭据，只用于事后核对「这把已经作废的 key 当初是什么」，屏蔽它换不来安全收益，
反而在事故排查时少一条能核对的线索。

## 12. 客户端 `@luoli/sdk-client`

`createSdkClient({baseUrl, apiKey, fetch?})` 返回 `LuoliSdkClient`，十个方法对应十个端点：

| 方法 | 端点 |
|---|---|
| `createSession(input?)` | `POST /sdk/v1/sessions` |
| `listSessions(query?)` | `GET /sdk/v1/sessions` |
| `getSession(id)` | `GET /sdk/v1/sessions/:id` |
| `patchSession(id, input)` | `PATCH /sdk/v1/sessions/:id` |
| `deleteSession(id)` | `DELETE /sdk/v1/sessions/:id` |
| `purgeSession(id)` | `POST /sdk/v1/sessions/:id/purge` |
| `resetSession(id)` | `POST /sdk/v1/sessions/:id/reset` |
| `listCommits(id, query?)` | `GET /sdk/v1/sessions/:id/commits` |
| `sendMessage(id, input)` | `POST /sdk/v1/sessions/:id/messages` |
| `streamMessage(id, input)` | `POST /sdk/v1/sessions/:id/messages/stream`（返回 `AsyncIterable<SdkStreamEvent>`） |

`SdkError extends Error`，字段：`status`（HTTP 状态或 SSE 场景下按 `STATUS_BY_CODE` 换算的
等价状态）、`code`（`SdkErrorCode`）、`retryable`、`retryAfterMs?`（仅当响应带 `Retry-After`
头，或 SSE 路径下 `code === 'turn_queue_full'` 时固定 5000）、`cause?`（读流异常时保留原始
错误）。`autoRetryable` getter 等于 `retryable && code !== 'cancelled'`——`cancelled` 恒不建议
自动重试（见 [§5](#5-错误契约)）。

`retryAfterMs` 换算：非流式路径读真实 `Retry-After` 响应头（秒数 × 1000）；SSE 路径的
`error` 事件不经 HTTP 头传输，客户端内置常量 `TURN_QUEUE_FULL_RETRY_AFTER_MS = 5000`，
仅在 `code === 'turn_queue_full'` 时填充，其余错误码 SSE 路径下 `retryAfterMs` 恒
`undefined`。

流式 `error` 以异常抛出：`streamMessage()` 的生成器读到 `event: error` 帧时不作为一个普通
事件 `yield`，而是 `throw sdkErrorFromStreamEvent(data)`——与非流式路径的失败共用同一套
`catch (err instanceof SdkError)`。

**截断语义**：`for await` 消费完所有帧却既没读到 `done` 也没读到 `error`（EOF 前无终结事件，
含流里只有心跳注释帧的情形）与读流过程本身抛错（TCP reset、反代提前断连）两种情况均抛出
`SdkError(code: 'upstream_error', retryable: true)`，前者不带 `cause`，后者的 `cause` 是原始
异常。消费方主动提前 `break` 跳出 `for await` 循环（触发生成器的 `.return()`）**不算截断**，
不会走到上面这条兜底抛错——它是正常的提前结束，不是连接异常。

入参不做客户端侧校验：服务端已用同一份 `@luoli/sdk-client/schema` 做 `safeParse`，重复校验
没有额外收益；且本地 `.parse()` 失败会抛裸 `ZodError`，与服务端拒收后映射出的
`SdkError(invalid_request)` 是两种类型，会打破「错误统一抛 `SdkError`」的契约。响应体一律
`.parse()`（非 `.safeParse()`）——响应不符合契约时属实现缺陷，不是可预期的用户输入错误。

SSE 解析规则：自写解析器（无第三方依赖），按行增量消费，帧边界是「空行」（连续两个行终止符，
识别 `\r\n`/`\n`/`\r` 三种形式）；`data:` 允许多行按 `\n` 拼接后 `JSON.parse`；`:` 开头的行
是注释帧，无 `data:` 字段的帧整体跳过；`id:`/`retry:` 等未使用字段读到即忽略。已解析的帧
交给 `sdkStreamEventSchema.parse()` 做判别联合校验，不认识的 `event` 名会抛裸 `ZodError`
（不是 `SdkError`）——预留给未来新增心跳帧等扩展时的兼容性提醒。

`pnpm sdk:e2e`（`scripts/sdk-e2e.ts`，经 `tsx` 运行）对**真实进程**跑通 create → send →
stream → list → patch → delete → purge 全流程，要求先 `pnpm build`（`ERR_MODULE_NOT_FOUND`
类问题只在 dist 产物下暴露）。脚本本身经 tsx 运行，加载的是源码客户端而非 dist 产物；`dist`
产物客户端的可用性由构建产物存在性与类型解析间接保证，不由本脚本直接验证。

## 13. 欠账与限制

- **`SDK-01`**：SDK 按来源的限额未实现。`QuotaGuard.reserve()` 只有 `global`/`chat`/`user`
  三档 scope，没有 `source` 维度，一个 SDK 接入方可创建任意数量会话，每个会话独立计入
  `perChat`，来源整体无上限。详见 [00 §2.1 · SDK-01](./00-state.md)。
- **`SDK-02`**：SDK 排队饥饿。`TurnConcurrency` 的队列是全局的（`concurrency.ts` 的
  `queueMax`），一把 SDK key 开多个会话即可把队列填满，此时 Telegram 侧新轮次统一收到
  `turn_queue_full`。详见 [00 §2.1 · SDK-02](./00-state.md)。
- **非法 cursor 静默返回首页**：`GET .../sessions` 与 `GET .../commits` 均不对格式错误的
  `cursor` 报 400，退化为从头翻页（见 [§4](#4-sdkv1-端点契约)）。
- **流式端点无心跳帧**：见 [§6](#6-流式协议)，部署需自行保证反代读超时不短于
  `concurrency.turnTimeoutMs`。
- **`sourceUsage()` 无读口**：见 [§9](#9-记账)。
- **SDK 下 `userId = chatId`**：`perUser` 与 `perChat` 两档配额落在同一个 subject 上（见
  [§7](#7-轮次语义)），不是独立维度——按用户与按会话限额在 SDK 场景下等价。
- **客户端契约的已知不一致**（不影响当前功能，记录供后续版本参考）：`SdkError` 在裸包名
  `@luoli/sdk-client` 与子路径 `@luoli/sdk-client/schema` 两条 import 路径下不是同一个东西——
  裸包名下是类（`index.ts` 的 `export class SdkError extends Error`，本地显式导出遮蔽了它
  对 `schema.js` 的星号再导出）；子路径下同名的是 `z.infer` 出来的纯类型（错误载荷
  `{code,message,retryable}`），不是运行时值，写成 `instanceof` 判断在子路径这份上是类型错误，
  不是运行期判断失败；
  `AsyncIterable<SdkStreamEvent>` 的类型仍含 `error` 分支，但运行时该分支永不通过 `yield`
  产出（它总是被 `throw`）；未知事件名走裸 `ZodError` 而非 `SdkError`（见 [§12](#12-客户端-luolisdk-client)）；
  `internal` 错误码的 `retryable` 因调用点而异，不固定（见 [§5](#5-错误契约)）。

## 14. 与实施计划的对应

《SDK 系统实施计划》的编号在源码注释中仍被引用；本表把它们映射到本文档或其余 docs 的具体
位置，不再逐一重指向每处注释。

### 14.1 §0.1 审阅拍板

| 编号 | 结论 | 落在哪 |
|---|---|---|
| Q-A | 轮次管线抽 `runTurn()` 进 `packages/core/src/turn/pipeline.ts` | [§7](#7-轮次语义)、[02 §10.6](./02-context-engine.md) |
| Q-B | 密钥用 `Secrets` 加密存储，owner 专用回显端点，每次回显记 warn | [§3](#3-认证)、[§11](#11-管理面-apisdk) |
| Q-C | `MemoryStore.read()` 的 owner 例外整条删除 | [05 §3.4](./05-tools-and-permissions.md)、[06](./06-prompt-and-memory.md) |

### 14.2 §1 已定结论（1–22）

| # | 项 | 落在哪 |
|---|---|---|
| 1 | 接入形态：独立前缀 `/sdk/v1` | [§4](#4-sdkv1-端点契约) |
| 2 | 客户端包 `@luoli/sdk-client` | [§12](#12-客户端-luolisdk-client) |
| 3 | 会话标识：创建时分配 uuid，全局唯一 | [§2](#2-数据模型引用) |
| 4 | 来源粒度：每接入方一行，Telegram 内建 `id='telegram'` | [§2](#2-数据模型引用) |
| 5 | 密钥：`sk-` 前缀、加密存储、可回显、软停用、`expires_at` | [§3](#3-认证)、[§11](#11-管理面-apisdk) |
| 6 | 角色恒 `trusted`，`isPrivate: true` | [§1](#1-定位与边界)、[§7](#7-轮次语义) |
| 7 | 工具集：名义三件，实际两件可达 | [§8](#8-工具目录) |
| 8 | 记忆作用域按来源/（来源, 会话） | [§2](#2-数据模型引用)、[06 §3](./06-prompt-and-memory.md#3-作用域与注入矩阵) |
| 9 | 人格与 ASSIST 配置落 `sources` 行两列 | [03 §2.10](./03-data-model.md#210-扩展与记忆) |
| 10 | 归档必须写 `messages`，`tg_message_id` 取 `MAX+1` 同事务 | [§7](#7-轮次语义) |
| 11 | 发起人 `endUserId` 必填，落库加 `<sourceId>:` 前缀 | [§7](#7-轮次语义) |
| 12 | 输出流式与非流式并存 | [§4](#4-sdkv1-端点契约)、[§6](#6-流式协议) |
| 13 | 流式协议四事件 | [§6](#6-流式协议) |
| 14 | 错误契约 `{ok,error:{code,message,retryable}}` | [§5](#5-错误契约) |
| 15 | 模型别名按会话持久 + 每请求覆盖 | [§4](#4-sdkv1-端点契约) |
| 16 | 并发排队，队列满 429 带 `Retry-After` | [§5](#5-错误契约)、[§6](#6-流式协议) |
| 17 | 会话动词：create/get/list/delete/reset/commits，`delete` 软停用、`purge` 硬删 | [§4](#4-sdkv1-端点契约)、[§10](#10-两种删除动词) |
| 18 | 提示词新增 `SDK_KERNEL` | [06 §1.3](./06-prompt-and-memory.md#13-sdk-会话的内核sdk_kernel) |
| 19 | 配额本次不做按来源限额 | [§13](#13-欠账与限制) |
| 20 | WebUI 最小面 | [09 §3.9a](./09-webui.md#39a-sdk-接入来源--密钥) |
| 21 | 前置：抽 `composeRuntime` | [01](./01-architecture.md)、[00](./00-state.md) |
| 22 | 记忆迁移：启动期搬迁，`memory/sources/<sourceId>/` | [02](./02-context-engine.md)、[03 §2.10](./03-data-model.md#210-扩展与记忆) |

### 14.3 §1.1 修订新增的约定（A1–A10）

| 编号 | 约定 | 落在哪 |
|---|---|---|
| A1 | `sources`/`telegram` 种子行建于 `0019`（批二），SDK 专表在 `0020`（批三） | [03 §2.10/§2.15](./03-data-model.md) |
| A2 | `usage_ledger` 加 `source_id` 并回填 `telegram` | [§9](#9-记账) |
| A3 | `sourceId` 服务端生成 ulid，兼三重用途，禁 `:` 与路径字符 | [§2](#2-数据模型引用) |
| A4 | `CHARACTER.md`/`ASSIST.md` 复制进来源目录，`PUBMEMORY.md`/`private/` 移动 | [02](./02-context-engine.md)、[06 §2](./06-prompt-and-memory.md) |
| A5 | zod schema 唯一定义在 `@luoli/sdk-client/schema` | [§4](#4-sdkv1-端点契约)、[§12](#12-客户端-luolisdk-client) |
| A6 | SDK 路由独立成 `packages/server/src/sdk/` | [§4](#4-sdkv1-端点契约)、[§11](#11-管理面-apisdk) |
| A7 | `createTelegramBot` 与 Telegram 启动块留在 `main.ts` | [01](./01-architecture.md) |
| A8 | 排队中断连/队列满时已归档消息置 `deleted_at` | [§7](#7-轮次语义) |
| A9 | 队列满 `Retry-After` 固定 5 秒 | [§5](#5-错误契约) |
| A10 | token 字母表只用 `[A-Za-z0-9]` | [§3](#3-认证) |

### 14.4 §2 任务（T1.1–T3.13）

| 编号 | 任务 | 落在哪 |
|---|---|---|
| T1.1–T1.3 | `composeRuntime` 抽取、测试运行时、文档同步 | [01](./01-architecture.md)、[00](./00-state.md) |
| T2.1 | 迁移 `0019`：`sources` 表与记忆按来源改写 | [03 §2.10](./03-data-model.md#210-扩展与记忆) |
| T2.2 | 启动期 `migrateMemoryLayout()` | [02](./02-context-engine.md) |
| T2.3 | `MemoryStore.path()` 与作用域键计算 | [§2](#2-数据模型引用)、`packages/core/src/memory/scope.ts` |
| T2.4 | 两道私有记忆访问闸改写（比较作用域键） | [05 §3.4](./05-tools-and-permissions.md) |
| T2.5 | `PromptDocuments` 按来源 ensure/paths/readForPrompt | [06 §2](./06-prompt-and-memory.md) |
| T2.6 | 批二文档与文案 | [03](./03-data-model.md)、[06](./06-prompt-and-memory.md)、[13](./13-acceptance-criteria.md)、[README](./README.md) |
| T3.1 | 迁移 `0020`：`api_keys`/`contexts` 加列/`sdk_sessions`/`usage_ledger` 加列 | [03 §2.15](./03-data-model.md#215-sdk-密钥与会话) |
| T3.2 | 仓储层：`SourceRepository`/`ApiKeyRepository`/`SdkSessionRepository`/purge | [03 §2.16](./03-data-model.md#216-sdk-仓储层与会话-purge)、[§10](#10-两种删除动词) |
| T3.3 | 密钥签发与校验、`/api/sdk/*` 管理端点 | [§3](#3-认证)、[§11](#11-管理面-apisdk) |
| T3.4 | `AgentKind='sdk'` 与工具白名单 | [§8](#8-工具目录)、[05 §3.13](./05-tools-and-permissions.md#313-sdk-会话agentkind--sdk) |
| T3.5 | `SDK_KERNEL` 提示词 | [06 §1.3](./06-prompt-and-memory.md#13-sdk-会话的内核sdk_kernel) |
| T3.6 | `/sdk/v1` 端点与认证中间件 | [§3](#3-认证)、[§4](#4-sdkv1-端点契约) |
| T3.6a | `packages/sdk-client` 脚手架 + schema | [§12](#12-客户端-luolisdk-client) |
| T3.7 | 轮次执行路径 `runTurn()` | [§7](#7-轮次语义) |
| T3.8 | 流式协议 | [§6](#6-流式协议) |
| T3.9 | `usage_ledger` 记来源 | [§9](#9-记账) |
| T3.10 | `@luoli/sdk-client` 客户端 + 真实进程 e2e | [§12](#12-客户端-luolisdk-client) |
| T3.11 | WebUI 最小面 | [09 §3.9a](./09-webui.md#39a-sdk-接入来源--密钥) |
| T3.12 | docs/00 §2 两条欠账登记 | [§13](#13-欠账与限制) |
| T3.13 | 本文档 + 03/05/06/09/13/21/README 同步 | 全篇 |

---

**验收**：`env -u FORCE_COLOR pnpm test tests/docs.test.ts tests/config.test.ts
tests/acceptance.test.ts` 通过（T3.13）。
