# 27 · 第九轮：全维度源码复审（SOLID · OWASP Top 10 · JS/TS 实践）

> ❄️ **已冻结（2026-08-18 快照）** —— 本文只记录当轮的发现与整改，**不再更新**。文中所有
> 「未实现 / 未接线 / 仍然开着的」都是**当时**的状态，不代表现在；当前状态见
> [`00-state.md`](../00-state.md)。条目编号（`V-SSRF-01` 之类）是 240 处源码注释的溯源凭据，
> **不得重编号、不得删除**。

> 范围：`packages/**/src`、`apps/**/src`、`scripts/`、`packages/db/migrations/`，共 **15,931 行**源码（不含
> `tests/`、`node_modules`、`dist`、`.git`）。**逐文件读完**，不是抽样。
>
> 与前八轮的关系：`docs/15`–`docs/20` 是按需求文档逐条对照的功能复审，`docs/22`/`docs/24` 是漏洞与整改
> 复核，`docs/26` 只审工具系统。**这一轮换的是判据**——不看「有没有照文档做」，只看三条外部标准：
> OWASP Top 10（2021）、SOLID、JS/TS 工程实践（含单线程运行时的资源上界）。所以下面有几条是前八轮
> 全都覆盖过的模块，只是这次的问法不一样。
>
> 每一条都带 `file:line` 与复现/判据。**标【实测】的四条跑过验证代码**（临时 vitest 探针，跑完即删，
> 见 §1.2）；其余是读码判定，没实测的一律不写成「可利用」。

## 0. 结论速览

| | 条数 | 编号 |
| --- | --- | --- |
| **P0 安全** | 1 | `S-01` |
| **P1** | 9 | `S-02` `S-03` `S-04` `R-01` `R-02` `R-03` `C-01` `C-02` `D-01` `D-02` |
| **P2** | 12 | `S-05`–`S-08` `R-04`–`R-06` `C-03`–`C-05` `D-03`–`D-05` |
| **P3（记录 / 清理）** | 12 | `S-09` `S-10` `R-07` `C-06`–`C-08` `D-06` `T-02`–`T-06` |

三句话版本：

1. **`S-01` 是一次回归。** 登录限流的桶键在 `webui.trustProxy=false`（默认）时取自 `X-Real-IP`
   请求头 —— 而 `docs/18 · N-WEB-02` 那一轮的修复原文写的是「`trustProxy` 为假时**恒返回** `local`」。
   现在换个头值就能无限次试口令，实测 12 次全部 401、一次 429 都没有。
2. **本轮的主题是「默认值与判据的一致性」。** `approval.rules` 默认空数组，于是 `bash` / `python` /
   `write_file` 这些标着 `conditional` 的工具在**默认配置下零审批**（`S-02`，实测）；审批规则的正则
   还是 JS 引擎（`S-03`），而同一类风险在 `grep`（`docs/19 · T-TOOL-01`）和唤醒词（`docs/08 §4`）
   两处都已经换成 RE2；用量报表按 UTC 分日、总览趋势与配额窗口按 `general.timezone` 分日（`C-02`）。
   每一条单独看都不像 bug，合起来是「同一件事有两套判据」。
3. **结构上有两个 1500+ / 2800 行的单文件**（`app.ts`、`ConsoleView.vue`），它们是下一轮任何改动的
   摩擦来源。`D-02` 有前车之鉴：`docs/24` 记着上一次拆 `ConsoleView` 让 14 个页面全空白并被回退，
   所以这次的前置条件是先有组件级渲染用例。

**没有发现权限绕过。** 角色模型（`min(用户角色, 会话角色)`、注册期 fail-closed、`execute()` 二次硬
拦截、定时任务每次触发重算）、SQL 注入面、原型污染面、CSRF/会话、SSRF 主路径、上下文引擎的 14 条
不变量都查过，结论见 §7 —— 那一节存在的意义是让下一轮不用重查。

## 1. 方法

### 1.1 覆盖

| 包 | 行数 | 读法 |
| --- | --- | --- |
| `packages/core/src`（40 文件） | ~5,600 | 全文 |
| `packages/server/src/app.ts` | 1,549 | 全文，逐端点 |
| `packages/telegram/src`（8 文件） | ~1,400 | 全文 |
| `packages/db/src`（8 文件）+ 7 份迁移 | ~1,100 | 全文 + DDL/索引 |
| `apps/bot/src/main.ts` | 413 | 全文 |
| `packages/webui/src` | ~4,000 | `ConsoleView.vue` 结构与危险模式扫描；其余全文 |
| `packages/shared`、`plugin-sdk`、`scripts/` | ~400 | 全文 |

### 1.2 实测的四条

临时探针 `tests/zz-audit-probe.test.ts`（4 例全过，验证完已删除，未进提交）：

| 探针 | 断言 | 结果 |
| --- | --- | --- |
| P1 → `S-01` | 同一 `X-Real-IP` 第 3 次得 429；换 12 个头值全部 401 | ✅ 绕过成立 |
| P2 → `S-02` | `configSchema.parse({})` 的 `approval.rules` 为 `[]`，且 `ApprovalRules([]).evaluate(bash, {command:'rm -rf /'})` 回 `needed:false` | ✅ 默认零审批 |
| P3 → `S-10` | `capMentions('… ,@a .@b ;@c', 1)` 之后仍剩 4 个 @ | ✅ 护栏漏一半 |
| P4 → `S-03` | `pattern:'^(a+)+$'` 对 26 个 `a` + `!` 的求值耗时可测（每多一字符翻倍） | ✅ 回溯成立 |

其余条目是读码判定。**凡是「需要攻击者先拿到 X」的，都在条目里写清 X 是什么**，不把前置条件藏起来。

基线：审前跑过一次全量 `pnpm test` —— **69 文件 / 389 例全绿**。所以下面每一条都不是「测试挂了」，
而是「测试没问到这里」。几处点名了对应的用例缺口（`S-01` 的 `trustProxy=false`、`D-05` 的
`onStepEnd`、`D-02` 的渲染用例）。

---

## 2. 安全（OWASP Top 10 对照）

### `S-01` 【P0 · A07 · 实测】登录限流的桶键是可伪造的请求头 —— 这是 `docs/18 · N-WEB-02` 的回归

```ts
// packages/server/src/app.ts:191-195
function requestIp(ctx, config): string {
  if (!config.webui.trustProxy) return ctx.req.header('x-real-ip')?.trim() || 'direct';
  const chain = ctx.req.header('x-forwarded-for')?.split(',')…;
  return chain.at(-config.webui.trustedProxyHops) ?? 'direct';
}
```

`trustProxy` 为 **false**（默认值，`schema.ts:241`）时读的是 `X-Real-IP` —— 判断反了。这个返回值是
`POST /api/auth/login` 的失败计数键（`app.ts:336-356`）：

```
POST /api/auth/login  X-Real-IP: 1  {"password":"a"}   → 401
POST /api/auth/login  X-Real-IP: 2  {"password":"b"}   → 401
…                                                        永远不会 429
```

实测 12 次轮换头值全部 401。唯一还在起作用的是全局软闸（`app.ts:339-343`：累计失败超
`attempts×20` 时每次请求延迟 250 ms），argon2id 的成本（~50 ms）比它更像限速器 —— 但那不是限流，
是硬件预算。

同一函数还喂给 `operations.createSession(ttl, ip, ua)`，所以 `sessions.ip` 这列的审计价值也是零。
（`Secure` cookie 判定走的是另一个函数 `requestIsSecure`，不受影响。）

**为什么会回归**：`docs/18 · N-WEB-02` 的修复记录写的是「新增 `clientIp()`：`trustProxy` 为假时恒
返回 `local`」，`docs/18 §428` 还把它列成「fail-closed 的默认」。现在的实现丢了这一半。而
`tests/server.test.ts:109` 那条用例只覆盖 `trustProxy: true` 的取跳逻辑 —— **默认路径一次都没被测过**。

**修**：`trustProxy=false` 时用连接的远端地址（`@hono/node-server` 的 `getConnInfo(ctx)`），拿不到
就回退常量 `'local'`；`x-real-ip` / `x-forwarded-for` 只在 `trustProxy=true` 时参与。并补一条
`trustProxy=false` 下轮换头值仍会被锁的用例 —— 没有这条，这一项会第三次回来。

### `S-02` 【P1 · A05 · 实测】默认配置下所有 `conditional` 工具零审批

`approval.rules` 默认 `[]`（`schema.ts:217`），而 `ApprovalRules.evaluate()` 在规则表为空时恒回
`{needed:false}`（`approval/rules.ts:43-54`）。于是 `TOOL_POLICY` 里标 `conditional` 的五个工具 ——
`bash`、`python`、`write_file`、`move_file`、`memory_write`（`policy.ts:18-30`）—— 在开箱配置下对
`trusted` 用户**完全不经审批**。实测 `{command:'rm -rf /'}` 也是 `needed:false`。

误导性在于三件事叠在一起：`approval.enabled` 默认 `true`（面板显示「审批已启用」）、`docs/05` 的
工具表把 bash 标成「条件审批」、而 `config/config.yaml` 里没有任何规则样例。运维看到的是一个开着
的开关和一张写着「条件审批」的表，实际是门开着。

**修**：二选一，但必须选一个 ——
① 给 `approval.rules` 一份非空默认（`bash`/`python` 的高危命令模式 + `write_file`/`move_file` 的
`when:'target_exists'`），`config/config.yaml` 里带注释写全；
② 保持空默认，但在启动时对「`approval.enabled=true` 且 `rules.length===0`」记一条 warn，并在 WebUI
的审批页顶上说明「0 条规则时 conditional 等于 never」。
（`docs/16 §5`「摘除比伪造安全」在这里读作：宁可明说门是开的。）

### `S-03` 【P1 · A05/A06 · 实测】审批规则的正则是 JS 引擎，且求值对象由模型决定

```ts
// packages/core/src/approval/rules.ts:19-26,48
function compilePattern(source: string): RegExp | null {  // ← new RegExp，不是 RE2
  …return new RegExp(insensitive ? source.slice(4) : source, insensitive ? 'i' : undefined);
}
if (compiled.rule.pattern && !compiled.pattern.test(JSON.stringify(input))) continue;
//                                                 ^^^^^^^^^^^^^^^^^^^^ 模型给的工具参数
```

`pattern` 来自配置（owner 面），求值对象是**模型/用户内容**。一个形状不巧的规则（`(a+)+`、
`(\w+\s?)*$` 这类）撞上一段合适的输入就是指数回溯，而这是单线程进程 —— 卡住的是整个 bot（所有会话
的轮次、WebUI、SSE 心跳）。实测 26 个字符已经量级可测，每多一个字符翻一倍。

`schema.ts:30-38` 的 `superRefine` 只验「能不能编译」，编译得过的正则照样能指数回溯。

**这是同一条教训的最后一处**：`grep` 已经换 RE2（`docs/19 · T-TOOL-01`），唤醒词也是
（`config/wakeword.ts:28`，还带 128 字符上界）。`re2-wasm` 已经是依赖。

**修**：`compilePattern` 换 `new RE2(source, …)`，长度上界与 `checkWakeword` 对齐；`superRefine`
同步换成用 RE2 编译，写入端当场 400（不兼容 RE2 的模式在运行时本来也不该生效）。

### `S-04` 【P1 · A10】`web_search` 绕开了全仓库唯一的出网路径

```ts
// packages/core/src/tools/web.ts:124
response = await fetch(target, { method: …, headers, …, signal });
```

`headers` 里带着搜索 API key（`x-subscription-token` / `x-api-key`，`web.ts:117-119`）。裸 `fetch`
意味着：无 SSRF 策略、**跟随重定向且不摘认证头**、无响应体上界（`response.json()` 全收）。

而 `outbound.ts:8` 的 `AUTH_HEADER` 白名单里恰好就有 `x-api-key`：

```ts
const AUTH_HEADER = /^(authorization|proxy-authorization|x-api-key|x-goog-api-key|api-key)$/i;
```

—— 「跨源重定向必须摘掉这些头」是本仓库已经写下的判断，而 undici 的 `fetch` 只按 fetch 规范摘
`Authorization` / `Cookie` / `Proxy-Authorization`，自定义头会原样跟到新主机。`alerts.ts:24-26` 把
规矩说得更直接：「在这里另开一个裸 fetch 等于让运维可配的 URL 直接打内网」。

目标域名是常量（`api.search.brave.com` 等），所以要利用它得先控住上游或 DNS —— 这是一条纵深防御
缺口而不是可直接利用的漏洞。但代价是：搜索 key 可被一个 302 带走，且多了一条无策略的出网通道。

**修**：改走 `guardedFetch(target, {…}, { allowPrivate:false, maxRedirects:0, maxBytes: …,
timeoutMs: options.timeoutMs })`。搜索 API 不需要重定向。

### `S-05` 【P2 · A05】`/api/*` 没有任何请求体上界

全仓库无 `bodyLimit`（已 grep 确认）。`ctx.req.json()` 把请求体整份读进内存；`PUT /api/config/yaml`
（`app.ts:562`）、`PUT /api/prompts/:id`（`app.ts:1122`）、`POST /api/models/import`（`app.ts:729`）
都是无上界写入。

大部分端点在鉴权后（owner 面），但 **`POST /api/setup`、`/api/auth/login`、`/api/auth/token` 在鉴权
中间件之前注册**（`app.ts:311-388` vs `app.ts:390`）—— 未登录就能推一个任意大的请求体进来。
`login` 有 `body.password.length > 1024` 的检查，但那发生在 `await ctx.req.json()` **之后**。

**修**：全局挂一道 hono 的 `bodyLimit`（1 MiB 量级），YAML / 导入 / prompts 三条单独放宽到各自的
业务上界。

### `S-06` 【P2 · A02】`${env:NAME}` 展开发生在合并之后，于是 DB 覆盖层也能读环境变量

```ts
// packages/core/src/config/index.ts:117
const compose = () => substituteEnvironment(deepMerge(deepMerge(file, overrides), envLayer));
//                    ^^^^^^^^^^^^^^^^^^^^ overrides = config_kv（WebUI 可写）
```

往任意配置项里写 `${env:LUOLI_MASTER_KEY}`，下次 `loadConfig` 就把主密钥展开进那个键。`GET /api/config`
的脱敏是**按键名**判的（`publicConfig`，`app.ts:171-175`），`general.timezone` 这类键不在其列，于是
主密钥明文出现在响应里；`GET /api/config/export` 与 `config_revisions` 同理（`looksSecret` 也是按
键名）。

这不是提权（能写配置的已经是 owner），但它把「主密钥只在进程内、只用于解密 provider key」这条性质
破掉了，并给它加了一条经 HTTP 响应与导出文件的泄漏路径。

**修**：env 展开只作用于文件层 —— `deepMerge(deepMerge(substituteEnvironment(file), overrides), envLayer)`。
DB 覆盖层里的 `${env:…}` 应当原样保留（或写入端直接拒收）。

### `S-07` 【P2 · A01】两个读文件端点不做包含性校验

- `GET /api/files/:attachmentId`（`app.ts:975-983`）：`readFileSync(row.path)`，`row.path` 直接来自
  `attachments.local_path`。
- `GET /api/prompts/:id`（`app.ts:1120`）：`readFileSync(row.path)`，来自 `memory_docs.path`。

同一个文件里对日志目录就是过 `safeRef()` 的（`app.ts:154-159`）。这两列今天只由本进程写入，所以是
纵深防御缺口；但「DB 里的路径值可信」是一个会随时间失效的假设（导入、迁移、手工修库）。

顺带：附件是 `readFileSync` 一次读全，20 MB 的文档就是一次 20 MB 堆分配 + 一次 20 MB 响应缓冲。

**修**：两处都过 `safeRef(config.media.dir, …)` / `safeRef(config.memory.dir, …)`；附件改
`createReadStream`。

### `S-08` 【P2 · A01】身份字符串直接当路径段

```ts
// packages/core/src/memory/store.ts:204
primemory: join(this.directory, 'private', subject ?? 'invalid', 'PRIMEMORY.md'),
// packages/core/src/prompt/documents.ts:36
privateMemory: resolve(this.directory, 'private', userId, 'PRIMEMORY.md'),
```

当前来源是 `String(from.id)`（Telegram 数字 id）与 `access.bootstrapOwnerId`。前者安全，后者是**自由
字符串环境变量** —— `LUOLI_OWNER_ID=../../etc` 会让私有记忆落到目录外（自伤，但没有任何一道闸）。
定时任务的 `createdBy` 也走这条路（`runner.ts:163`）。

**修**：一道 `/^\d{1,20}$/` 校验（`loadConfig` 里对 `bootstrapOwnerId` 加，或在两个 path 函数里加）。

### `S-09` 【P3 · 记录不改】`PathJail` 是 check-then-use

`jail.resolve()`（`tools/jail.ts:13-34`）realpath 校验后返回路径，调用方随后 `readFileSync` /
`writeFileSync` —— 中间可被换成越界软链（TOCTOU）。前置条件是攻击者已经能在 workspace 里执行命令，
而 jail 本来就明确「不是安全边界」（`docs/05 §5.4`、`sandbox/index.ts:166-167` 的 warn）。
**记录，不建议改**：真正的边界是 docker 模式。

### `S-10` 【P3 · 实测】`output.maxMentions` 的护栏漏一半

```ts
// packages/telegram/src/output.ts:74
return text.replace(/(^|[\s(（])@([A-Za-z][\w]{4,31})\b/g, …);
```

只数「前面是空白或左括号」的 @。实测 `,@bobbyxx`、`.@cindyxx`、`;@daisyxx` 三种在 `max=1` 下全部
逃过 —— 而 Telegram 对这些前置字符照样解析成 mention。注释里写「提示词里说好不要这么做，但那不是
边界，投递侧才是」，那么投递侧的判据应该跟 Telegram 的一致。

**修**：前置条件换成「前一个字符不是 `[\w@]`」（用 lookbehind 或手工回看）。

---

## 3. 资源上界与可用性

> 这一节的共同点：单线程运行时里，一个无界操作等于一次全局停顿。`docs/22` 已经按这个主题清过一轮
> （grep 回溯、沙箱 stdout、流式渲染、日志文件、定时任务异常五处），下面是那一轮没覆盖到的。

### `R-01` 【P1】不可信文档解析在 per-chat 入口锁内，无超时、无内存上界

```
bot.ts:114  ingressOrder.run(chatId, async () => {      ← 这把锁串行化整个 chat 的入口段
bot.ts:148    await attachMedia(media, scoped, message, archived);
media.ts:126-134   pdf-parse / mammoth / sharp ← 用户上传的 20 MB 文件
media.ts:128       new PDFParse({ data: readFileSync(path) })   ← 整份进内存
```

`media.maxDocBytes` 默认 20 MiB。一个畸形 PDF（解析器活锁、或压缩炸弹）会让 `attachMedia` 永不返回
→ 那个会话的入口互斥锁**永久持有** → 该 chat 之后的每条消息既不归档也不触发，而日志里只有一条
`turn.start` 都没有。`bot.catch` 只在抛错时才有话说，挂住不算抛错。

`sharp` 有 `limitInputPixels` 默认防线；`pdf-parse` / `mammoth` 没有任何超时或预算。

**修**：`extract()` 套一道硬超时（`registry.ts:63` 已有 `withTimeout` 可复用）+ 大小闸门；并把
`attachMedia` 挪到锁外 —— 归档行已经落库，挂媒体是补写（`reply.ts:18-24` 的 `attachMedia` 本身就是
幂等的 `if (row.mediaParts?.length) return`）。

### `R-02` 【P1】`read_file` / `edit_file` 无视文件大小整份读盘

```ts
// packages/core/src/tools/files.ts:50
const buffer = readFileSync(target);            // ← 先整份读进内存
const content = decoder.decode(buffer.subarray(offset, offset + effective));  // 再裁
// files.ts:209  edit(): const content = readFileSync(target, 'utf8');        // 同样整份
```

`tools.fs.maxReadBytes`（默认 256 KiB）只裁**交给模型的那一段**，不限制读盘。`grep` 有闸
（`files.ts:162`：`stat.size > maxReadBytes * 4` 就跳过并记 skipped），`read` / `edit` 没有。

而 workspace 里的大文件正是 `bash` / `python` 自己造出来的（`dd`、日志、下载）—— 模型 `read_file` 一
个 2 GB 文件就是一次 2 GB 分配。`read_file` 的 `skill://` 分支（`builtins.ts:153`）同样整份读。

**修**：读之前 `statSync` 一次，超过 `maxReadBytes` 的走定位读（`openSync` + `readSync(fd, buf, 0,
len, offset)`，`media.ts:109-116` 的 `readHead` 已经是这个写法），把现成的 `offset`/`nextOffset`
分页语义接上；`edit_file` 对超限文件直接 `ok:false` 说清原因。

### `R-03` 【P1】`context_stats` 把整段历史塞进工具结果

```ts
// packages/core/src/context/engine.ts:326-335
stats(key) {
  const messages = repo.messagesThrough(head?.headOrdinal ?? repo.maxOrdinal())…  // ordinal 1 起的全部消息
  return { …, commits: repo.commits(100), messages };
}
// packages/core/src/tools/builtins.ts:247
execute: (_input, context) => ({ ok: true, ...dependencies.context.stats(context.turn.key) })
```

工具描述是「读取当前上下文窗口和提交状态」，实际交回**这个会话有史以来的每一条上下文消息及其
`parts`** 加最近 100 个 commit。随后 `#normalizeOutput`（`registry.ts:231-244`）按
`tools.exec.maxOutputBytes`（64 KiB）从中间截断 —— 模型拿到的是一段掐断的 JSON 文本，前 32 KiB 是最
早的历史，后 32 KiB 是 commit 列表。既烧 token 又没有信息。

同一个 `stats()` 也是 `GET /api/chats/:key/commits` 的响应体（`app.ts:985`），以及 `/ctx` 命令的数据源
（`bot.ts:254` 只取其中四个字段 —— `docs/20 · W-TG-02` 修的是「别把它整份发给 Telegram」，没动这个
返回形状）。

**修**：`stats()` 加参数（`stats(key, { withMessages: false })`）或拆成 `stats()` / `timeline()`；
`context_stats` 只回 `messageCount` / `tokens` / `windowStart..headOrdinal` / `claimWatermark`，历史
留给 WebUI 的 `/api/chats/:key/context`。

### `R-04` 【P2】`quota.rateLimit.concurrentPerUser` 在并发入口下形同虚设

```ts
// packages/core/src/ledger/quota.ts:120-122
const user = db.prepare("SELECT …,SUM(state IN ('queued','running')) AS concurrent FROM turns WHERE initiator_user_id=? AND started_at>=?")…
if ((user.concurrent ?? 0) >= input.concurrentPerUser) …
```

数的是 `turns` 表里的行，而那一行要到 `openTurn` 之后才写（`bot.ts:486`）。`canStart`（`bot.ts:418`）
与 `turns.create` 之间隔着配额预留、`concurrency.acquire`（可能排队）与整个 `openTurn`（含背景认领
与快照物化）。`UpdatePoller` 现在是**并发派发**的（`polling.ts:105-110`），同一个人的两条消息可以
同时通过检查 —— 这个上限只在「入口串行」的年代成立，而并发正是 `f08118b` 那次提交打开的。

**修**：用进程内的 `TurnRegistry` 判并发（`app.ts:907-909` 已经写明它才是在途轮次的权威来源，且
`list()` 现成），或把「登记在途」提前到 `canStart` 之后的同一个同步段。

### `R-05` 【P2】六张表没有任何保留策略

`MaintenanceService.cleanup()`（`maintenance.ts:63-99`）清的是 `log_events`、`processed_updates`、
`sessions`、`approvals`、子 agent 结果文件、`scheduled_jobs`。**不清**：

| 表 | 增长速率 | 谁在读 |
| --- | --- | --- |
| `usage_ledger` | 每一步模型调用一行 | `/api/usage`（LIMIT 1000）、`report()` |
| `turns` | 每轮一行 | `/api/turns`（分页） |
| `config_revisions` | 每次配置写入一行（含被吞并的后代行） | `/api/config/revisions`（LIMIT 500） |
| `memory_revisions` | 每次记忆写入一行，**存完整 diff** | `/api/prompts/:id/revisions`（LIMIT 200） |
| `tasks` | 每个子 agent 一行 | `/api/tasks`（LIMIT 500） |
| `quota_counters` | 每个 (scope,subject,window,bucket) 一行，跨天跨月只增 | `/api/quota`（LIMIT 500） |

读端点都有 LIMIT，所以症状不是慢查询而是**库文件只涨不落**，且 `VACUUM` 帮不上（数据还在）。
`docs/10 §204` 写了方案（「数据量超 400 天后由维护任务聚合进可选表 `usage_daily` 再删原始行」），
没有实现，也没有列进 `KNOWN_UNIMPLEMENTED_CONFIG_KEYS`（因为它不是配置键）。

**修**：至少给 `usage_ledger` / `config_revisions` / `memory_revisions` / `quota_counters` 各一个保留
期。加配置键的话记得同步 `docs/11` + `tests/config.test.ts` 的引用断言（CLAUDE.md）。

### `R-06` 【P2】`/api/dashboard` 把 7 天的两张表拉进 JS 再分桶

```ts
// packages/db/src/operations.ts:86-93
for (const row of db.prepare('SELECT tg_date AS ts FROM messages WHERE tg_date>=?').all(since)) …
for (const row of db.prepare('SELECT COALESCE(started_at,queued_at) AS ts,… FROM turns WHERE …>=?').all(since)) …
```

总览页反复刷新的端点，每次把近 7 天的**每一行**取回来在 JS 里数。按本地日分桶的需求不需要这样：
先在 JS 里算出 7 个 `[from,to)` 区间，再一句 `SELECT COUNT(*) … WHERE ts BETWEEN ? AND ?` 分组即可
（时区口径不变）。

### `R-07` 【P3】四处小泄漏 / 无界

- `builtins.ts:116,144`：`waiting` Map 只在 `releaseSlot` 里删；一轮里排队的 `spawn_agent` 全部被
  abort（`/cancel`）时会留下一个空数组条目，进程生命周期内不回收。
- `bot.ts:391`：`triggerCooldown` 的有界淘汰只删已过期项 —— `cooldownMsPerUser` 较大时，短时间内
  超过 4096 个不同发言人会让它越过上界继续涨。
- `provider/store.ts:75-81`：`abortablePause` 不摘 abort 监听器（`{ once:true }` 只在真的 abort 时
  生效），每次重试退避留一个监听在轮次信号上。
- `plugins/manager.ts:90-98`：hook 抛错时 `clearTimeout(timer)` 被跳过（走了 catch），定时器留到
  `hookTimeoutMs` 才自灭。

---

## 4. 正确性与一致性

### `C-01` 【P1】`ModelRegistry.rebuild()` 不容一行坏数据，坏一行则全部别名消失

```ts
// packages/core/src/agent/runtime.ts:67-78
rebuild(cooldownMinutes = 30) {
  this.#models.clear(); this.#info.clear(); this.#chains.clear();   // ← 先清空
  …
  const apiKey = this.providers.key(provider.id);                    // 主密钥换过 → 抛
  const headers = provider.headers ? JSON.parse(provider.headers) : null;  // 坏 JSON → 抛
```

`ProviderStore.key()` 在密文解不开时抛（`store.ts:44`，GCM 认证失败），`JSON.parse` 在
`headers_json` 是坏 JSON 时抛。任一情况下：注册表已经被清空、异常向上传播、**所有别名一起没了**。
调用点里 `rebuildModels()` 是在 `POST /api/providers` / `/api/models` / `PATCH /api/models/:id` 等端点
里同步调的 → 端点 500，而运行时从此没有任何可用模型直到下一次成功的 rebuild。

同一个文件里 `app.ts:639` 对同一列就是兜住的：`try { headers = JSON.parse(row.headers) } catch { headers = null }`。

**修**：per-provider `try/catch`，失败的那一个跳过并记 `provider.health` warn（顺带就是
`all_providers_down` 告警的正确触发条件）。

### `C-02` 【P1】用量报表按 UTC 分日，总览趋势与配额窗口按配置时区分日

```ts
// packages/core/src/ledger/usage.ts:54
day: "strftime('%Y-%m-%d', ts / 1000, 'unixepoch')"     // ← UTC
// packages/db/src/operations.ts:80    new Intl.DateTimeFormat('en-CA', { timeZone: timezone, … })
// packages/core/src/ledger/quota.ts:23 quotaBucket(now, timezone, window)
```

`quotaBucket` 的注释把这条规矩写清了：「与配额 bucket 用同一个时区口径」，`dashboard()` 也照做了。
`report()` 漏在外面 —— 东八区部署里，「用量报表的 8 月 18 日」= 本地 8 月 18 日 08:00 到 8 月 19 日
08:00。用量页与总览页对同一天给出两个数字，而这正是运维核对账单时会撞上的地方。

**修**：`report()` 收一个时区参数，`strftime('%Y-%m-%d', ts/1000, 'unixepoch', ?)` 传 `±HH:MM`
修饰符（固定偏移够用，DST 地区退化到按 JS 分桶）；或直接复用 `quotaBucket` 在 JS 侧分组。
`app.ts:1414-1428` 的调用点已经有 `config.general.timezone` 在手。

### `C-03` 【P2】`edit_file` 能绕开 `write_file` 的覆盖审批

```ts
// packages/core/src/tools/policy.ts:18-19
write_file: { minRole:'trusted', approval:'conditional', … },
edit_file:  { minRole:'trusted', approval:'never',       … },
```

而 `FileTools.edit()` 最后一步就是 `return this.write(path, …)`（`files.ts:216`），且可以把整份文件
换掉（`oldString` 取全文，或 `replaceAll`）。`write_file` 还带 `approvalTargetExists`
（`builtins.ts:170`）—— 说明「覆盖已存在的文件要审批」正是它的设计意图（`when:'target_exists'`）。
`edit_file` 恰好只作用于已存在的文件，却是 `never`。

**修**：`edit_file` 与 `write_file` 同档（`conditional`），或在 `S-02` 的默认规则里把
`tool: ['write_file','edit_file','move_file']` 一起写进 `when:'target_exists'` 那条。

### `C-04` 【P2】MCP 的 schema 转换在 per-server 错误边界之外，且无递归上界

```ts
// packages/core/src/mcp/manager.ts:109-122
for (const raw of config.servers) { try { …await this.discover(server)… } catch { …记 down… } }
if (this.registry) for (const entry of this.#tools.values())
  this.registry.registerExternal({ …, inputSchema: jsonSchemaToZod(entry.inputSchema), … });
//                                                 ^ 在 try 外面
```

`jsonSchemaToZod`（`mcp/schema.ts:11-47`）对 `properties` / `items` 无深度上界地递归。一台 MCP server
返回超深 `inputSchema` → `RangeError` 从 `reconcile()` 抛出 → `POST /api/mcp` / `PATCH /api/mcp/:name`
500；而 `main.ts:113` 的 `await mcp.reconcile()` 在启动路径上，**整个进程起不来**。

**修**：转换放进 per-server 的 try（或自己包一层），失败退回 `z.record(z.unknown())` + warn；
`jsonSchemaToZod` 加深度上界（32 足够，超过就 `z.unknown()`，与它对 `$ref`/`oneOf` 的降级策略一致）。

### `C-05` 【P2】`/grant` 不校验 id 形态，`/revoke` 与它不对称

```ts
// packages/telegram/src/bot.ts:291-295
const [kind, id, role] = ctx.match.trim().split(/\s+/);
if (!kind || !id || !['owner',…].includes(role ?? '') || !['user','chat'].includes(kind)) …用法…
principals.upsertSeen({ id: `${kind}:${id}`, tgId: id, … });
```

`/grant user @alice owner` 通过校验，写出一条 `tg_id='@alice'` 的主体行 —— 永远匹配不到任何消息，
命令还回「已设置 user:@alice = owner」。`POST /api/principals/bulk` 对同一件事有正确的校验
（`app.ts:1020`：`/^-?\d{1,20}$/`，注释还写明「放行 @username 只会写出一条永远匹配不到任何消息的
主体记录」）—— **同一道闸修过一侧，漏了另一侧**，正是 `docs/26` 的主题。

`/revoke` 另一个不对称：它收的是完整主体 id（`setRole(id, …)`，`bot.ts:300`），而 `/grant` 收
`<kind> <id>`。`/revoke 123456` 静默无效（返回「主体不存在」）。

**修**：抽一个 `parsePrincipal(input): {id,kind,tgId} | null` 给三个入口共用（`/grant`、`/revoke`、
`/whois` 已经在自己拼 kind 了）。

### `C-06` 【P3】`archiveQuery` 的 LIKE 分支不转义通配符

`archive.ts:52-56`：分词正则 `[^\p{L}\p{N}_]+` 把 `_` 当词内字符保留，于是 `a_b` → `LIKE '%a_b%'`，
下划线在 LIKE 里是「任意一个字符」。只影响检索精度（不是注入 —— 值是绑定参数）。

### `C-07` 【P3】`safeRender` 的占位符字符不在转义集里

`output.ts:16-18,36`：代码块被换成 ` <n> `，最后再换回来。`SPECIAL`（`output.ts:4`）不含
` `，所以正文里自带 ` 0 ` 的消息会被替换成别的内容或被吞掉。文本损坏，无注入。

### `C-08` 【P3】`perChat` 白名单里有一个永远不生效的键

`schema.ts:248` 的白名单含 `/^character$/`，于是 `perChat.<key>.character` 能存进 `config_kv`、能过
校验、`perChatConfig` 也会把它合进本轮配置 —— 但没有任何代码读 `config.character`
（`PromptDocuments.paths(userId, characterOverride?)` 的第二个参数从来没有调用方传）。

这正是 `tests/config.test.ts` 那条「每个 schema 叶子键要么被引用、要么进 `KNOWN_UNIMPLEMENTED`」断言
要挡的形态 —— 它漏在断言之外，因为 `perChat` 是 `z.record(z.unknown())`，白名单里的路径不是 schema
叶子键。**修**：要么接线（`readForPrompt` 传 `characterOverride`），要么从白名单删掉；顺带考虑让那条
CI 断言也覆盖 `perChat` 白名单。

---

## 5. SOLID / 结构

### `D-01` 【P1 · SRP + DIP】`app.ts` 1549 行：路由层直接当 SQL 层

一个文件里 ~90 个端点，其中 **40+ 处直接写 `dependencies.db.prepare(...)`**：`/api/chats`、
`/api/turns`、`/api/turns/:id/detail`、`/api/quota`、`/api/models*`、`/api/aliases*`、`/api/mcp*`、
`/api/plugins/:name`、`/api/prompts*`、`/api/approvals`、`/api/tasks`、`/api/messages*`…

代价不是「不好看」，是三件具体的事：

1. `packages/db` 的仓储层被绕过。而 `tests/db.isolation.test.ts` 是**扫源码里的 SQL 字面量**来断言
   会话作用域的（`archive.ts:188-190` 的注释专门解释过这一点）—— 写在 `app.ts` 里的查询不在那把尺
   子的量程内。
2. 同一份查询在两处各写一遍就会漂移。`principalLabel`（`app.ts:143`）与 `/api/quota` 的
   `principals` Map（`app.ts:1442`）已经是同一件事的两种写法。
3. 端点无法单测 —— 每个测试文件都得先手搓一个 30 依赖的 `createServer` harness（`tests/*.test.ts`
   里现在有 6 份近似重复的 `appHarness`）。

**修（分步，不要一次做完）**：① 先把裸 SQL 收进 `packages/db`（新增 `AdminRepository`，或按域并入
既有仓储），路由只做校验与编排；② 再按页面切路由模块（`routes/config.ts` / `models.ts` / `chats.ts`
/ `logs.ts` / `quota.ts` / `schedule.ts` / `extensions.ts`），`createServer` 只负责中间件与装配。
第 ① 步就能让 `db.isolation` 那条断言重新覆盖到这些查询。

### `D-02` 【P1 · SRP】`ConsoleView.vue` 2808 行、100+ 顶层 ref、14 个页面

**这一项有前车之鉴**：`docs/24 §3` 记着上一次拆分（`D-UI-01`）「构建通过、测试全绿、`/login` 打得
开，而 14 个控制台页面全是空白」并被回退，根因是「一个组件级测试都没有」。

所以顺序是固定的：先给 14 个页面各补一条渲染用例（`tests/webui/console.render.test.ts` +
`vitest.config.ts` 的 `webui` project 已经把前置条件铺好了），再按页拆，每拆一个跑一次。
不要先拆再补测。

### `D-03` 【P2 · SRP】`ToolRegistry.execute()` 把 9 道准入闸与执行编排焊在一起

`registry.ts:153-216`：工具存在 → 熔断 → 运维禁用 → 角色 → 子 agent 限制 → `available()` →
`context.allow` → skill 收窄 → 调用次数 → 参数校验 → 审批档位合并 → 审批 → hooks → span → 超时
race → 输出归一化 → 熔断计数。

闸门本身是对的（`docs/20 · W-TOOL-01` 明确要求「`active()` 的过滤集合必须在这里逐条复查」）。问题是
它们和执行编排在同一个方法里，于是没法单独测「给定 (角色, 上下文) 这次调用该不该被放行」，而这正是
最需要穷举的部分。

**修**：抽 `admit(tool, context): { ok: true } | { ok: false; error: string; hint?: string }` 纯函数
（连同 `approvalFor` 的档位合并），`execute()` 只剩 `admit → approve → run → normalize`。

### `D-04` 【P2 · DIP】`main.ts` 413 行顶层模块，构造顺序是隐式契约

30+ 个组件在模块作用域里按顺序 `new`，注释里反复写「A 必须早于 B 建」：

- `main.ts:56-58`「EventBus 要早于 quota / log 建」
- `main.ts:71-72`「告警要早于沙箱、plugin、模型注册表建起来」
- `main.ts:160-163`「bot 要到最后才建得起来，所以桥拿的是 getter」
- `main.ts:168-170`「这里只**建**不**装**」

每一条都是真的约束，但它们只存在于注释里 —— 挪一行的代价要靠读注释发现。而且这段代码没有任何测试
覆盖（顶层 await + `process.exit` 让它不可导入）。

**修**：抽 `export function composeRuntime(config, env): Runtime`，顺序约束变成函数体内的局部事实，
`main.ts` 只剩「读配置 → compose → 起服务 → 装信号处理」。副产品是集成测试终于能装出一整套运行时，
替掉 6 份重复 harness。

### `D-05` 【P2 · SRP】`runMainAgentInternal` 一个函数六件事

`runtime.ts:358-517`：提示词装配、模型链包装、`prepareStep` 的降档与 in-flight 裁剪、`onStepEnd` 的
记账 + 配额提交 + SSE 广播 + 上下文 delta 追加 + token 校准、流式收尾与失败归因。

`onStepEnd`（`runtime.ts:459-490`）尤其密集 —— 而「链内 fallback 时按谁计价」（`docs/20 ·
W-LEDGER-01`）、「校准的两端必须是同一个东西」这两个历史 bug 都在这个回调里，两者都没有单测，因为
要测它就得先造一个完整的 `ToolLoopAgent`。

**修**：把 `onStepEnd` 拆成几个可注入的观察者（`LedgerObserver` / `BroadcastObserver` /
`ContextObserver` / `CalibrationObserver`），每个都能单独喂一个假 step 来测。

### `D-06` 【P3 · ISP】`ServerDependencies` 是一个 30+ 字段的巨型接口

`app.ts:32-73`，其中 15 个可选，端点里到处 `dependencies.x ?? not_implemented`（`schedules`、
`turnRegistry`、`skills`、`plugins`、`mcp`、`agents`、`sandbox`、`previewPrompt`、`dryRunAgent`、
`restart`、`ledger`、`modelCatalog`、`memory`、`promptDocuments`、`eventStreams`）。

「这个部署装配了什么」是一个真实的变量（`webui.enabled=false`、没有 `BOT_TOKEN`、没有定时任务运行
时），而且 `not_implemented` 而非假成功的做法是对的（`docs/16 §5`）。但把它表达成「一个接口 + 15 个
可选字段」意味着每个端点都要自己判一次。按能力分组（`ScheduleCapability` / `AgentCapability` /
`ExtensionCapability`）能让判断集中到装配处。

---

## 6. JS/TS 实践

### `T-01` 先说好的部分

这三件事在同规模的 TS 项目里罕见，值得写下来免得下一轮「顺手改掉」：

- **零 `any`、零 `@ts-ignore` / `@ts-expect-error`、零松散相等**（全仓库 grep 确认）。`as never` 只
  两处（grammY 的 abort-controller shim 类型不兼容，`polling.ts:142` 有注释）。
- `exactOptionalPropertyTypes` 明显是开着的 —— 代码里大量 `...(x ? { k: x } : {})` 而不是 `k: x ?? undefined`。
- `process.env` 只出现在 `config/index.ts`（配置层）、`sandbox/index.ts:207`（子进程 env 白名单）与
  两处 `npm_package_version`。没有任何模块偷读环境变量。
- 迁移与索引质量高：`ux_messages_tg`、`ux_commits_key_seq`、`ux_sched_name`（带 `WHERE state='active'`
  的部分唯一索引）、`ix_messages_unclaimed` 这类部分索引都在该在的地方。

### `T-02` 【P3】死参数

`log/sink.ts:100-108`：`#flushFile(path, synchronous = false)` 的第二个参数以 `void synchronous;`
结尾 —— 三处调用点都传 `true`，而函数体只有一条同步路径。要么实现异步分支，要么删掉参数；留着会让
读者以为存在两条路径。

### `T-03` 【P3】死条件

`sandbox/index.ts:207`：

```ts
Object.entries(process.env).filter(([key]) =>
  ['PATH','LANG','TZ'].includes(key) && !/(TOKEN|KEY|SECRET|LUOLI|BOT_TOKEN)/i.test(key))
```

前半段已经把 key 限死在三个字面量上，后半段恒为真。删掉（或把白名单改成可配置时再让它有意义）。

### `T-04` 【P3】两处按字节截断会切开多字节字符

- `registry.ts:236-240`：`buffer.subarray(0, half).toString('utf8')`
- `sandbox/index.ts:68-74`：`clipped()` 按字节算预算、按码点切，结果仍可能超过 `max` 字节

产出 U+FFFD 或半个字符。同一个仓库里 `truncatePartStrings`（`db/context.ts:319-338`）已经是正确写法
（按码点切 + 不透明 part 整体替换），可以照它改。

### `T-05` 【P3】手工拼 SQL 并手工转义引号

`database.ts:33` 与 `maintenance.ts:22`：

```ts
db.exec(`VACUUM INTO '${path.replaceAll("'", "''")}'`);
```

SQLite 的 `VACUUM INTO` 收的是 SQL 表达式，`db.prepare('VACUUM INTO ?').run(path)` 可行。这里的
`path` 不含外部输入（`dirname(db) + luoli-<ts>-<label>.db`），所以不是漏洞 —— 但「自己转义 SQL」是
一个不该留在仓库里的先例。

### `T-06` 【P3】裸 `JSON.parse`

38 处 `JSON.parse` 里若干是裸调用：`readAppKv`（`db/config.ts:13`）、`withMedia`（`archive.ts:82`）、
`rebuild` 的 headers（`runtime.ts:78`，见 `C-01`）、`ScheduleRepository` 的调用方。「库里可能有坏
JSON」不是假想 —— `app.ts:1000-1004` 就专门 catch 了「历史行里可能是坏 JSON，改价不该因此失败」。
逐处判一下：能降级的降级，不能的就让它抛在有边界的地方。

---

## 7. 查过、没有发现问题的地方

> 这一节是给下一轮省时间的（同 `docs/26 §6`）。下面每一项都逐文件读过，结论是「当前实现是对的」。

| 面 | 查了什么 | 结论 |
| --- | --- | --- |
| **SQL 注入（A03）** | 全部动态 SQL | 只有三类：占位符展开（`ids.map(()=>'?')`）、**白名单**列名（`PATCH /api/models/:id` 的 `map`、`/api/quota/reset` 的四个字段名、`report()` 的 groupBy 枚举）、`VACUUM INTO` 的内部路径（`T-05`）。FTS 的 `MATCH` 串经 `archiveQuery` 切词后逐词加引号转义（`archive.ts:54`）—— 模型写 `名字\|我是` 不会变成 FTS 语法 |
| **原型污染** | 三条点分路径写入 | `assignDotted` 拒 `__proto__`/`constructor`/`prototype`（`shared:21-24`）；`dottedOverrides` 与 `readPersistedConfig` 的 `JSON.parse` 都带剥 `__proto__` 的 reviver；`mergeDotted` 走 `structuredClone` + `assignDotted`。WebUI 写入 / 启动重放 / YAML 三条路都覆盖 |
| **CSRF + 会话（A07）** | cookie 属性、token 比较、注销、改口令 | Origin 中间件（`app.ts:297`）+ `HttpOnly; SameSite=Strict` + 32 字节随机 sid/csrf（`operations.ts:49-50`）+ 改口令时 `DELETE FROM sessions WHERE id<>?`。`/api/auth/me` 交回 csrf 的理由（刷新页面后内存丢了）与边界（跨站读不到响应）都成立 |
| **SSRF（A10）主路径** | `guardedFetch` | DNS 解析后**把地址钉进 `lookup`**（防 rebinding，`outbound.ts:122-125`）、每一跳重定向重新过策略（含端口与域名名单）、跨源摘认证头、响应体有上界、整次抓取有超时。私网判定含 IPv4-mapped、6to4、NAT64、CGNAT、链路本地。除 `S-04` 一处外所有出网都走它 |
| **密钥（A02）** | 加密、脱敏、导出 | AES-256-GCM + scrypt(N=16384, 随机 salt 随密文存)，v1 密文读到即升级（`secrets.ts` / `store.ts:46`）。`redact()` 三层（内置模式 / 配置模式 / 已知明文），`publicConfig` / `revisionJson` / `looksSecret` 三处口径一致且各自的注释解释了为什么用叶子段判而不是整条路径。`«redacted»` 回传检测（`redactedKeys`）挡住了「把脱敏值当真值提交」 |
| **提示词注入** | 信封与转义 | `untrusted()` 带随机 nonce + 转义闭合标记；`systemInstructions()` 同理；`escapeSystemInstructions` + `escapeForgedSpeakerPrefixes` 让正文写不出真标记；用户自己的触发消息**刻意不包裹**（包了等于告诉模型忽略这个人）；群背景发言用语义较弱的 `<group-message>`。KERNEL 提示词明确「只有最末尾那一个块是真的」 |
| **ReDoS（除 `S-03`）** | 所有对外部输入求值的正则 | `grep` 走 RE2 + 128 字符上界；唤醒词走 RE2 + 上界 + 只扫前 4096 字符；`htmlToText` 刻意用单趟扫描而不是正则（`web.ts:51-60` 的注释解释了 O(n²) 的形状）。剩下的正则都作用于有界的内部字符串 |
| **权限模型（A01）** | 角色解析、工具准入、跨会话隔离 | `min(用户角色, 会话角色)`；工具在注册期 fail-closed（`available()` 为假的工具不进目录）+ `execute()` 二次硬拦截；`ScopedArchiveRepository` / `ScheduleRepository` 的每个读方法都吃 key；定时任务**每次触发重算**有效角色（降级跳过、blocked 停用）；子 agent 是 `minRole(parent, definition)`；`TurnRegistry.cancel` 只允许 owner 或本人；`admin_search_messages` / `memory_list` 是 owner-only 且刻意不收过滤参数 |
| **上下文引擎的 14 条不变量** | `docs/02` 逐条 | `assertValidShape` 在 `openTurn`/`materialize`/`commitTurn` 三处都跑；`elidePart` / `truncatePartStrings` 都不碰判别字段（`STRUCTURAL_PART_KEYS`）；不透明 part 要么原样要么整体换占位；ordinal 只在提交时分配；`finalized` 后 `appendDelta` 抛错。**本轮没有新发现** |
| **优雅关停** | `main.ts:370-400` | 顺序（停拉取 → 停 bot → drain 轮次 → abortAll → 再 drain → poller.drain → http close → WAL checkpoint）与每一步的理由都成立，`docs/24 · R-OPS-01` 那条已落实 |
| **并发闸与互斥** | `KeyedMutex` / `TurnConcurrency` / croner `protect` | `#drain()` 的 splice 索引处理正确；waiter 的 abort 会把自己摘出队列；`Scheduler.add` 用 `protect:true` 防重叠（只有手动 `POST /api/schedules/:id/trigger` 绕过它，见 `R-04` 的同类问题但影响小得多） |
| **WebUI 前端（A03 XSS）** | 全量扫描 | 无 `v-html` / `innerHTML` / `eval` / `new Function`；无 `localStorage` 存凭据（csrf 只在内存 `reactive`）；`:href` 只绑定站内 `/api/…` 路径。CSP 也挡住了内联脚本 |

---

## 8. 建议的修复批次

按依赖排序。每一批都能独立验收，**不要合批**。

| 批次 | 条目 | 为什么放一起 |
| --- | --- | --- |
| **Z0 · 安全，改动都在十行内** | `S-01` `S-03` `S-04` `S-05` `C-05` | 五条都是「换一个判据 / 加一道闸」，互不耦合。`S-01` 必须带一条 `trustProxy=false` 的回归用例（它已经回归过一次） |
| **Z1 · 默认值与口径** | `S-02` `S-06` `C-02` `C-03` | 都会动到「运维看到的东西」：审批默认、配置展开、日界、审批档位。改完要同步 `docs/05` / `docs/11` / `config/config.yaml` |
| **Z2 · 资源上界** | `R-01` `R-02` `R-03` `C-01` `C-04` | 五条的共同形状是「一个无界或不容错的操作能拖垮全局」。建议一起做，因为验收方式相同（喂一个畸形/超大输入，看进程还活着） |
| **Z3 · 纵深防御** | `S-07` `S-08` `R-04` `R-05` `R-06` | 没有已知的可利用路径，但每一条都在收窄一个「今天成立、明天不一定」的假设 |
| **Z4 · 结构** | `D-01`①→`D-04`→`D-01`② | 顺序有依赖：先把 SQL 收进仓储（让 `db.isolation` 断言重新覆盖），再抽 `composeRuntime`（让集成测试能装运行时），最后才切路由模块 |
| **Z5 · 前端** | `D-02` | **前置条件是 14 条渲染用例**，不是可选项（`docs/24 §3`） |
| **Z6 · 清理** | `S-09`(记录) `S-10` `R-07` `C-06`–`C-08` `D-03` `D-05` `T-02`–`T-06` | 逐条独立，可以随手带 |

改动如果碰到 schema，记住三处联动（CLAUDE.md）：`docs/11` 的键说明、`tests/config.test.ts` 的引用
断言（或 `KNOWN_UNIMPLEMENTED_CONFIG_KEYS` 白名单 + `docs/11` 里带 `🚧` 的那一行）、
`HOT_RELOADABLE_CONFIG_KEYS`（只有「运行时读的是 getter」才能进）。

---

## 9. 与前八轮的关系

- **`docs/25` 仍是 🚧 清单的权威来源。** 本轮没有改动任何 🚧 标记，也没有把「已知未实现」重新报一遍
  —— `telegram.webhook.*`、`agent.ask*`、`media.groupDebounceMs` 这些都在 `docs/25 §4.3` 里有交代。
  唯一的例外是 `C-08`（`perChat.<key>.character`）：它**不在**那份清单里，因为它不是 schema 叶子键，
  那条 CI 断言看不见它。
- **`S-01` 是 `docs/18 · N-WEB-02` 的回归**，`docs/13` 里没有对应的自动化条目
  （整改时补了 `AC-SEC-016`，见 §10）。
- **`C-05` 与 `docs/26` 同主题**（同一道闸修过一侧漏了另一侧），只是这次两侧分别在 Telegram 命令与
  HTTP 端点上。
- **`R-01`/`R-02`/`R-03` 延续 `docs/22` 的「资源上界」主题**，是那一轮没覆盖到的三处：不可信文档
  解析、文件读取、工具返回体。

---

## 10. 整改记录（本轮已落地）

> 由整改方追加。范围按 §8 的批次走，**需求方拍板 Z0–Z3 + Z6，`Z4`/`Z5` 留到下一轮**
> （`D-01` 的 40+ 处裸 SQL、`D-04` 的 `composeRuntime`、`D-02` 的 `ConsoleView` 拆分）。
> 验收：`pnpm typecheck` / `pnpm lint` 干净，`pnpm test` **70 文件 / 413 例全绿**（审前是 69/389），
> `pnpm smoke` 20 update / 10 turn 通过。

### 10.1 逐条状态

| 编号 | 状态 | 落点 | 回归用例 |
| --- | --- | --- | --- |
| `S-01` | ✅ 已修 | `requestIp` 在 `trustProxy=false` 时只认 `getConnInfo(ctx).remote.address`，拿不到回退常量 `local`；请求头只在 `trustProxy=true` 时参与 | `server.test.ts`「ignores client headers…」（AC-SEC-016） |
| `S-02` | ✅ 已修（方案②） | 启动时对「`enabled=true` 且 `rules` 为空」记 `approval.no_rules` + stderr 提示；WebUI 审批页顶上 callout 点名受影响的 conditional 工具；`config/config.yaml` 带注释掉的示例规则 | 人工（AC-SEC-021） |
| `S-03` | ✅ 已修 | `compilePattern` 换 RE2 + 128 字符上界；新增 `checkApprovalPattern`，`approvalRuleSchema` 的 `superRefine` 与运行时**共用同一份实现** | `regression.round9.test.ts`（AC-SEC-018） |
| `S-04` | ✅ 已修 | `webSearch` 走 `guardedFetch`（`allowPrivate:false` / `maxRedirects:0` / `maxBytes` / `timeoutMs`）；顺带把 `x-subscription-token` 加进 `outbound.ts` 的 `AUTH_HEADER` 名单 | `web.test.ts` 覆盖 `guardedFetch` 侧；搜索侧无出网用例 |
| `S-05` | ✅ 已修 | `/api/*` 全局 `bodyLimit`，默认 1 MiB；YAML / 模型导入 4 MiB、prompts 2 MiB。挂在 Origin 闸之后、所有路由之前 | `server.test.ts`（AC-SEC-017） |
| `S-06` | ✅ 已修 | `${env:…}` 只对文件层展开：`deepMerge(deepMerge(substituteEnvironment(file), overrides), envLayer)`。DB 覆盖层里的写法原样保留 | — |
| `S-07` | ✅ 已修 | 新增 `storedPathWithin()`（先绝对化再判包含，因为库里存的是相对 cwd 的路径）；`/api/files/:id` 与 `GET /api/prompts/:id` 都过它，附件改 `createReadStream` 流式 | `api.contract.test.ts` / `config.api.test.ts` 的 harness 同步成「目录与配置一致」 |
| `S-08` | ✅ 已修 | `access.bootstrapOwnerId` 加 `TG_ID_PATTERN` 形态校验（空串仍放行，`loadConfig` 另有更清楚的 requireOwner 报错） | `regression.round9.test.ts`（AC-SEC-019） |
| `S-09` | 📌 记录不改 | 与报告一致：`PathJail` 的 TOCTOU 前置条件是「已能在 workspace 里执行命令」，真正的边界是 docker 模式 | — |
| `S-10` | ✅ 已修 | `capMentions` 的前置条件换成 lookbehind `(?<![\w@])` | `regression.round9.test.ts` |
| `R-01` | ✅ 已修 | `attachMedia` 挪到入口锁**外**（`resolveQuotedMessage` 拆成同步的 `archiveQuotedMessage` + 锁外挂媒体，两条路径共用一份实现）；`extract()` 套 20s 硬超时，提取失败只记 `extract_state='failed'` 而不把整条附件记成下载失败；下载后按**真实字节数**再判一次大小闸 | `reply.quoted.test.ts` / `media.test.ts` |
| `R-02` | ✅ 已修 | 新增 `readSlice()` 定位读（前 offset 字节按固定缓冲数换行，行号与分页语义不变），`FileTools.read` 与 `read_file` 的 `skill://` 分支共用；`edit()` 先 `statSync`，超过 `maxWriteBytes` 回 `file_too_large_to_edit` | `regression.round9.test.ts` |
| `R-03` | ✅ 已修 | `stats(key, { timeline?: boolean })`，默认只回摘要；`context_stats` 用默认值，WebUI 的两个端点显式传 `timeline: true`；工具 description 同步说明「不含逐条历史」 | `regression.round9.test.ts` |
| `R-04` | ✅ 已修 | `canStart` 收 `inFlight`，由 `TurnRegistry.countForUser()` 提供。从 `canStart` 到 `registry.register` 之间**没有 await**，所以这个判据真的能挡住同一个人的两条并发消息 | `regression.round9.test.ts` |
| `R-05` | ✅ 已修（加配置键） | 新增 `maintenance.retention.{usageDays,quotaCounterDays,configRevisionDays,memoryRevisionDays}`（默认 400/400/180/180，**0 = 不清**），接进 `MaintenanceService.cleanup()`。`turns` / `tasks` 刻意不给保留期（trace 骨架，属 docs/14 §2 Q9） | `regression.round9.test.ts` |
| `R-06` | ✅ 已修 | `dashboard()` 改成两句 `GROUP BY strftime(...)`，不再把近 7 天每一行拉回 JS | `regression.round9.test.ts`（与 `C-02` 同一条） |
| `R-07` | ✅ 已修（四处） | `spawn_agent` 的槽位表在 abort 路径上回收空条目；`triggerCooldown` 清完仍超上界时按插入序淘汰；`abortablePause` 摘 abort 监听器；plugin hook 的 `clearTimeout` 挪进 `finally` | — |
| `C-01` | ✅ 已修 | `rebuild()` 的 provider 循环加 per-provider `try/catch`：失败的记成 `health_state='down'` 并回调告知装配方（`main.ts` 记一条 `provider.health` warn），其余别名照常可用 | `regression.round9.test.ts` |
| `C-02` | ✅ 已修 | `report()` 收时区参数，`groupBy=day` 用 `strftime(…, '±HH:MM')`；`dashboard()` 与它共用 `sqliteTimezoneModifier` / `localDayName`（`@luoli/shared`），两处**按构造**同口径。DST 折中写进 docs/10 §4.2 | `regression.round9.test.ts` |
| `C-03` | ✅ 已修 | `edit_file` 改 `conditional` 并加上与 `write_file` 同一个 `approvalTargetExists`；docs/05 的工具表、权限矩阵与示例规则同步 | `regression.round9.test.ts`（间接：示例规则形状） |
| `C-04` | ✅ 已修 | `jsonSchemaToZod` 加 32 层深度上界；schema 转换挪进 per-server 的 `try`，单条工具转换失败只退回**那一个**工具的宽松放行 | `regression.round9.test.ts` / `mcp.runtime.test.ts` |
| `C-05` | ✅ 已修 | 新增 `parsePrincipal` / `TG_ID_PATTERN`（`@luoli/shared`），`/grant`、`/revoke`、`/whois` 与 `POST /api/principals/bulk` 共用；`/revoke` 现在也收 `<kind> <id>` 与裸 id（裸 id 两种主体都试） | `regression.round9.test.ts`（AC-SEC-020） |
| `C-06` | ✅ 已修 | `archiveQuery` 的 LIKE 值转义 `\ % _`，三处 LIKE 语句都带 `ESCAPE '\'` | `regression.round9.test.ts` |
| `C-07` | ✅ 已修 | `safeRender` 进门先摘掉 NUL，占位符从此不可能被正文伪造 | `regression.round9.test.ts` |
| `C-08` | ✅ 已修（接线） | `assembleMainPrompt` 读本轮配置里的 `character` 交给 `PromptDocuments.paths`；那边加一道文件名形态闸（纯文件名 + `.md`，不含 `..`），不合格**静默退回全局** `CHARACTER.md`。另新增一条 CI 断言：`perChat` 白名单里每条路径要么对应 schema 叶子，要么进 `PER_CHAT_NON_SCHEMA_KEYS` 且真的被代码读到 | `regression.round9.test.ts` / `config.test.ts` |
| `D-01` `D-02` `D-04` | ⏭ 本轮不做 | 需求方拍板 Z0–Z3 + Z6。三条的前置条件与顺序照 §8 的 Z4/Z5 不变（先收 SQL → 抽 `composeRuntime` → 切路由模块；前端先补 14 条渲染用例）。`tests/webui/console.render.test.ts` 已有 2 例覆盖 14 个导航页切换，是 `D-02` 的起点而不是终点 | — |
| `D-03` | ✅ 已修 | 抽 `ToolRegistry.admit(name, context)`（只读判定，9 道闸）与 `#approvalDecision`（档位合并）；`execute()` 只剩 admit → approve → run → normalize | `regression.round9.test.ts` |
| `D-05` | ✅ 已修 | 新增 `agent/step-observers.ts`：`record` / `broadcast` / `appendContext` / `calibrate` 四个观察者，入口是自定义的 `StepFacts` 而不是 AI SDK 的 step 类型（那个类型没人能手搓）。`runtime.ts` 只剩一层映射 | `regression.round9.test.ts` |
| `T-02` | ✅ 已修 | `#flushFile` 的 `synchronous` 死参数删掉（三处调用点同步） | — |
| `T-03` | ✅ 已修 | 沙箱 env 白名单的恒真后半段删掉 | — |
| `T-04` | ✅ 已修 | 新增 `elideMiddleBytes`（`@luoli/shared`）：预算按字节、切分按字符边界、结果**不超过** `maxBytes`；`#normalizeOutput` 与沙箱 `clipped` 共用 | `regression.round9.test.ts` |
| `T-05` | ✅ 已修 | 两处 `VACUUM INTO` 改绑参数 | `migration.backup.test.ts` |
| `T-06` | ✅ 部分修 | `readAppKv`、`withMedia`、`readPersistedConfig` 三处降级（坏行当「没有这一行」并上报）。**上下文引擎的 `parts_json` 解析刻意保持抛出**：那里一行坏数据意味着快照本身不完整，静默丢一条消息会破坏 tool-call 配对的不变量，而 `openTurn` 的调用方本来就在 try 里（「抛在有边界的地方」） | `regression.round9.test.ts` |

### 10.2 顺带做的两件事

- **`tests/regression.round9.test.ts`**（21 例）是这一轮的主要防线，按报告编号分组。`S-01` / `S-05`
  在 `tests/server.test.ts`（登录路径的 harness 在那里）。
- **两个测试 harness 修正**：`api.contract.test.ts` 把附件 fixture 挪进 `media.dir` 之下、
  `config.api.test.ts` 让 `memory.dir` 与 `PromptDocuments` 的根一致。这不是为了让新断言通过 ——
  那两个 harness 此前配出了一种**生产里不存在**的形态（库里的路径落在配置的目录之外）。

### 10.3 留给下一轮

1. `Z4` / `Z5`（`D-01` / `D-02` / `D-04`），顺序与前置条件见 §8。
2. `usage_daily` 聚合表仍未实现，所以 `maintenance.retention.usageDays` 到期就是**直接删明细**
   （docs/10 §4.2 已改成如实描述，不再写成「聚合后再删」）。
3. `PromptDocuments.save('character', <chatKey>, …)` 写的仍是全局 `CHARACTER.md`（`paths()` 不按
   subject 分文件），于是 `character:<chat>` 与 `character:global` 两行 `memory_docs` 指向同一个文件。
   这一轮只接了**读**侧的 `perChat.<key>.character`；写侧那处不一致是本轮之外的既有问题。
