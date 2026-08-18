# 24 · 第六轮整改的复核与返修

> ❄️ **已冻结（2026-08-17 快照）** —— 本文只记录当轮的发现与整改，**不再更新**。文中所有
> 「未实现 / 未接线 / 仍然开着的」都是**当时**的状态，不代表现在；当前状态见
> [`00-state.md`](../00-state.md)。条目编号（`V-SSRF-01` 之类）是 240 处源码注释的溯源凭据，
> **不得重编号、不得删除**。

> 复核对象：`docs/23-review-round6-remediation-report.md` 声称完成的 24 项（`docs/22` 的 §2 漏洞 + §3 设计缺陷）
> 方法：逐条回到 `docs/22` 的原始编号读代码 → 对可疑项写可运行探针 → **把生产构建真的跑起来**（`pnpm build` +
> `node dist/apps/bot/src/main.js`，owner 登录）→ 复跑 `typecheck` / `lint` / `test` / `build`
> 结论：19 项是根因修复；1 项把整个 WebUI 控制台改废，1 项修在了永远走不到的分支上，另有 3 处新引入的回归。
> 本文记录复核结论与**本轮返修**（编号 `R-*`）。

---

## 0. 一句话

`docs/23` 报表里 24 项全绿，但其中 **`D-UI-01` 让 14 个控制台页面全部空白**——而验证证据只打开了 `/login`，
那恰好是唯一没被改的页面。这不是抽查没覆盖到，是**验证的落点绕开了改动面**。

`docs/22 §6.1` 说的是「单元测试证明了模块能工作，没有任何测试证明它在真实进程里被接上了」。本轮把这句话
又演了两遍：`D-APPR-01` 的当场拒绝在真实进程里永远走不到（测试用的是零订阅者的裸 `EventBus`），
`D-UI-01` 的拆分在真实浏览器里一个绑定都解析不出来（没有任何组件级测试，构建通过 ≠ 渲染得出来）。

> **本轮补一条：改了什么，就必须在什么上验证。** 改渲染层就要真的渲染一次；改的是"没有 X 时怎么办"，
> 就要在真实进程真的没有 X 的那个条件下跑一次。构建产物能生成、测试全绿、`/login` 能打开，
> 三条加起来也不能证明控制台还活着。

---

## 1. 复核结论

### 1.1 确认修好（19 项）

| 编号 | 证据 |
|---|---|
| `V-DOS-01` | `grep` 与 `checkWakeword` 共用 `re2-wasm`。实测 `(a\|a)*$` 从 105,119 ms 降到 **16.9 ms**，`(a\|ab)*c` / `(.\|.)*$` / `(a\|a\|a)+$` 全部 ≤3 ms |
| `V-DOS-02` | `collect()` 边收边截到 `cap*2`，超限 `kill()` 进程组；`StringDecoder` 顺带修掉了按 chunk 边界切坏多字节字符（`I-11`） |
| `V-SKILL-01` | `resolveResource(uri, role)` 与 `load()` 同一条 `roleRank` 判据，`read_file` 传 `context.turn.effectiveRole` |
| `V-AUTH-01` | XFF 按 `trustedProxyHops` 从右取（schema `min(1)`，杜绝 `at(-0)` 退化成最左跳）+ 全局失败窗口 250ms 延迟 + 1024 项有界淘汰 + argon2 前拒绝超长口令 |
| `V-AUTH-02` | 校验现读配置 + `POST /api/auth/password` + `DELETE FROM sessions WHERE id<>?`（覆盖位的粘滞问题见 `R-AUTH-01`） |
| `V-SSRF-01` `V-NET-01` `I-14` | 三条出网路径统一到 `net/outbound.ts`：`redirect:'manual'` 逐跳复验、跨源剥 `authorization`/`x-api-key`/`x-goog-api-key`/`api-key`、补齐 `198.18/15` `192.0.0/24` TEST-NET-1/2/3 `64:ff9b::/96` `2002::/16`、端口白名单、响应体上限 |
| `V-LOG-01` | `cleanup()` 按 `cutoffDay` 字典序删日志目录（目录名即日期，不需要解析） |
| `V-LOG-02` | `ProviderStore.allDecryptedKeys()` 并进 `LogSink` secrets，`rebuildModels()` 与 `tools.web.searchApiKey` 热更新同步刷新 |
| `V-INFO-01` | `/ping` 只回版本 + 有效角色，dashboard 聚合数据仅 owner 可见 |
| `V-CFG-01` | `JSON.parse` reviver 剔 `__proto__`，`readPersistedConfig` 与 `dottedOverrides` 两个写入方都改了 |
| `D-PLUGIN-01` | `reconcile()` 开头 `INSERT … ON CONFLICT DO NOTHING` 发现登记（默认 `enabled=0`）+ `PATCH` 命中 0 行返回 404 + `onLoad`/`minRole` + `onToolCall`/`onToolResult`/`beforeSend` 三个 hook 真的接上。回归用例只往目录放文件、不碰数据库 |
| `D-QUOTA-01` | `stopWhen: stepCountIs(min(definition.maxSteps, perTurn.maxSteps))` + 子 agent 的 `prepareStep` 成本闸 + `spawn_agent` 派发前先看 `turnCost` |
| `D-STREAM-01` | 节流判断移到渲染之前 |
| `D-CFG-01` | `memory_write` 读 `turn.config`；`superRefine` 落实「perChat 只允许比全局更严格」 |
| `D-MEDIA-01` | 写入侧只存 `attachment://<id>`，读出侧按需水化（缺失时的行为见 `R-MEDIA-01`） |
| `D-LOG-01` | 200ms / 64KB 批次落盘，`error` 与 `system.crash` 强制同步刷新，写盘全程 try/catch 降级到 stderr |
| `D-OPS-01` | `Scheduler.add` 包 try/catch + croner `catch: true` + `onError` 注入 `scheduler.failed` |
| `D-OPS-02` | SSE `heartbeat.unref()` + `EventStreamRegistry.closeAll()` + `await http.close()` + `closeAllConnections` 兜底（`abortAll` 的丢失见 `R-OPS-01`） |
| `D-EVENT-01` | `Set` 自派发 + 订阅者异常隔离，顺带消掉 `maxListeners=10` 的告警 |
| `D-TOOL-01` | `allow` 与 `skillAllowedTools` 进 `ToolExecutionContext`，`execute()` 开头复验，返回 `tool_not_in_allowlist` |
| `D-ROLE-01` | `/grant` `/revoke` `/whois` 三条改走 `requireRole`，有效角色不再有第二份实现 |

### 1.2 `docs/23` 的编号错位

报表的编号与 `docs/22` 对不上，无法用于逐条核对（代码本身按 `docs/22` 的原意改对了）：

| `docs/23` 写的 | 实际对应 `docs/22` 的 |
|---|---|
| `V-AUTH-01` / `V-AUTH-02` | 互换 |
| `V-LOG-01` | `V-LOG-02`（脱敏） |
| `V-LOG-02` | `D-LOG-01`（缓冲写） |
| `D-LOG-01` | `V-LOG-01`（目录清理） |
| `V-NET-01` / `V-INFO-01` / `V-CFG-01` / `D-ROLE-01` | 描述的是另外的事，与 `docs/22` 同号条目无关 |

---

## 2. 返修

### R-UI-01 · P0 · `D-UI-01` 的拆分让 14 个控制台页面全部空白 —— 已回退

**位置**：`packages/webui/src/composables/useConsoleData.ts`（已删除）· 15 个 `views/*.vue`（已删除）

拆法是：模板搬进子 SFC，子 SFC 的 `setup` 返回一个**只有 `get` 陷阱**的 `Proxy`，转发到父组件实例。
Vue 解析模板绑定走的是 `hasOwn(setupState, key)` → `[[GetOwnProperty]]`，而这个 Proxy 没有
`getOwnPropertyDescriptor`/`ownKeys` 陷阱，目标又是 `{}`，于是 **`_ctx.xxx` 一个都解析不到**。

实测（`pnpm build` 产物，`node dist/apps/bot/src/main.js`，真实 owner 登录）：

```
navItems     : 总览 会话 消息 提示词 模型 主体 工具 扩展 Agent 日志 用量 配额 任务与审批 设置
内容区文本长度: 0                ← 侧栏顶栏还在（它们留在 ConsoleView 自己的模板里），页面主体全空
console      : TypeError: Cannot read properties of undefined (reading 'private')
```

最小复现（不依赖本仓库）：

```js
const Child = defineComponent({ setup: () => new Proxy({}, { get: (_t, k) => Reflect.get(parent, k) }),
  render() { return h('div', `active=${this.active}`); } });
// → "active=undefined" + [Vue warn] Property "active" was accessed during render but is not defined on instance.
```

顺带说，即使补齐陷阱让它渲染出来，这次拆分也没达成 `D-UI-01` 的目的：`ConsoleView.vue` 仍是 1715 行、
**全部状态和逻辑还在同一个 `setup()`**，15 个子视图拿到的是 `Record<string, unknown>`（所有模板绑定
失去类型检查，父文件因此要挂 `eslint-disable no-unused-vars`），组件级测试依然写不了。
代价全留下了，收益一个没拿到，还多出一层对 Vue 内部实现的依赖。

**处置：整体回退**，`ConsoleView.vue` 还原到 `75b1942`，删掉 15 个子视图与 composable。
`D-UI-01` 回到未关闭状态——它在 `docs/22` 里本就是 P3、明确写着「不影响任何运行时行为」，
用一次 P0 停机去换它不成立。要做的话得是真的把状态抽进 composable（返回 ref 对象、
子视图 `setup: () => ({ ...store })`，并解决 `UiButton`/`DataGrid` 等组件在子 SFC 里的注册），
那是一次独立的、需要组件级测试兜底的重构。

> **拆分前先有渲染测试。** 这次没有任何组件级测试，`vitest.config.ts` 也没配 `@vitejs/plugin-vue` 与
> jsdom——`@vue/test-utils` 明明已经在 devDependencies 里。补这一层是重做 `D-UI-01` 的前置条件。

### R-APPR-01 · P1 · `D-APPR-01` 修在了永远走不到的分支上 —— 已修

**位置**：`packages/core/src/approvals.ts` · `packages/core/src/events.ts` · `packages/server/src/app.ts`

`request()` 判的是 `events.subscriberCount === 0`，但 `apps/bot/src/main.ts` 有一个**无条件、永不取消**的
`events.subscribe(...)`（处理 `config.changed`）。真实进程里这个计数恒 ≥ 1，当场拒绝的分支**一次都不会进**，
180 秒静默干等原样保留。`tests/approval.rules.test.ts` 用的是零订阅者的裸 `EventBus`，所以测试绿。

**修法**：区分「在听」和「能裁决」。`EventBus.subscribe(listener, { channel: true })` 标记裁决通道，
新增 `channelCount`；只有 WebUI 的 SSE 订阅带这个标记，审批据此判断。既有 6 条审批用例的 harness
相应改成挂一条真的裁决通道——它们问的是「有人能裁决时怎么走」，挂成普通订阅者测的就不是那件事了。

回归用例钉的正是这条接线：`rejects immediately when no approval channel is connected` 里**先挂一个普通
订阅者**（模拟 `main.ts` 那个），再断言当场拒绝；另加一条 `waits for a decision once a real channel is connected`。

**本轮未闭合**：有裁决通道时，发起人在等待期间仍然收不到任何提示（`docs/22 · D-APPR-01` 要求「发起人必须
在第一时间收到一句话」）。补 Telegram 回执需要把 EventBus 接进 telegram 包，留作独立一项，已在
`docs/05` 与 `docs/21 §6` 标注。（第七轮已补上发起人回执，见 `docs/25 §8`；inline keyboard 审批仍缺。）

### R-TG-01 · P2 · `splitTelegramText` 静默丢字 —— 已修

**位置**：`packages/telegram/src/output.ts`

顺手做的 `I-08`（§4，`docs/23` 声明排除的范围）优化把 `remaining` 换成码点数组，但断点仍来自
`String#lastIndexOf`——那是 **UTF-16 下标**。正文里有代理对（emoji）时两者错位，`body` 取不满而
`remaining` 多跳，中间那段直接消失：

```
输入 5001 码点（3000 个 😀 + 换行 + 2000 个 X）
旧实现（HEAD）      parts=2  输出 5000 码点  丢 1    ← 断点处被 trim 掉的空白
整改后             parts=1  输出 3896 码点  丢 1105  ← 22%
```

而长度上限、分段数、fence 配平这些既有断言全部照常通过。

**修法**：断点一律在码点数组上找（`lastIndexOfPair` + `Array#lastIndexOf`），`boundary` 因此恒 ≤ `budget`。
回归用例断言的是**「切完还是那段话」**，与断点落在哪、正文有没有代理对无关。

### R-OPS-01 · P2 · `shutdown()` 丢了 `abortAll` 兜底 —— 已修

**位置**：`apps/bot/src/main.ts`

修 `D-OPS-02` 时把这段删了：

```ts
if (!(await turnRegistry.drain(graceMs))) { turnRegistry.abortAll('shutdown'); await turnRegistry.drain(…); }
```

改成 `await turnRegistry.drain(graceMs)`，返回值丢弃。`drain()` 只是等，宽限期内没排空的轮次不再被中断——
`turnRegistry.abortAll` 一度成为全仓库只剩测试在调的方法。这恰好抵消了 `D-OPS-02` 想要的效果：
退不出去照样等 `SIGKILL`，下次启动照样 `recoverAfterCrash`。

一并恢复：`system.shutdown` 改回 `system.stop`（`docs/10 §74` 的事件表写的是它，改名等于让文档与实现对不上），
`db.close()` 改回 `closeDatabase(db)`（后者带 `wal_checkpoint(TRUNCATE)`），`skills.close()` 补回 `await`。

### R-AUTH-01 · P2 · 口令覆盖位粘滞，`V-AUTH-02` 从另一个入口复发 —— 已修

**位置**：`packages/server/src/app.ts`

`activePasswordHash()` 是 `setupWrittenHash ?? currentConfig().webui.passwordHash`，而 `setupWrittenHash`
一旦被 `/api/setup` 或 `/api/auth/password` 写入就**永久遮蔽配置**。于是
`PUT /api/config {"webui.passwordHash": …}` 又变回：返回 200、写进 `config_kv`、留下审计记录、**登录还认旧的**——
`V-AUTH-02` 原样复发，只是换了个入口。

**修法**：覆盖位只覆盖「已写进 `config_kv`、但热重载还没落到 `configStore`」这个窗口。记下写入时的旧值，
快照仍等于旧值时才顶上；快照一旦变成别的（无论谁改的），立刻交回配置层。

### R-MEDIA-01 · P2 · 附件缺失时抛异常，会话级永久损坏 —— 已修

**位置**：`packages/core/src/agent/runtime.ts`

`D-MEDIA-01` 的读出侧水化在附件行缺失时 `throw new Error('attachment_unavailable')`，`readFileSync` 也没有兜。
**parts 是持久化的**：文件一丢，该会话在 `/new` 之前每一轮都会在物化时炸掉。这与 `docs/02` 的不变量
直接冲突——「不透明 part 要么原样保留，要么整体换成占位文本」。

**修法**：抽出 `hydrateAttachment()`，行缺失、状态非 `done`、读盘失败三种情况统一降级成一句占位文本。

### R-SEC-01 · P3 · CPU 上界断言的语料太短 —— 已修

`tests/security.test.ts` 新增的上界断言用的语料是 4 个 `'a'`。`(a|a)*$` 对 4 个字符即使用回溯引擎也是秒过，
**这条断言挡不住退回 `RegExp` 的回归**——又变成了在验证守卫自己的公理（`docs/22 §0.1` 点名的那个形状）。
改成 64 个 `'a'`（`docs/22 §6` 给的数），并把四个形状都跑一遍。

---

## 3. 复核后的验证

| 检查 | 结果 |
|---|---|
| `pnpm typecheck` | 通过 |
| `pnpm lint` | 通过 |
| `pnpm test` | 53 文件 / **232** 用例通过（整改后为 229，本轮 +3） |
| `pnpm build` | 通过 |
| **控制台实际渲染** | 生产构建 + owner 登录，逐页点过：14 个页面正常渲染，无 Vue 警告 |

每条返修都配了会红的回归用例：

| 返修 | 用例 | 对着旧实现会怎样 |
|---|---|---|
| `R-APPR-01` | `tests/approval.rules.test.ts` | 先挂一个普通订阅者 → 旧判据不再拒绝 → 红 |
| `R-TG-01` | `tests/output.test.ts` | 5001 码点丢 1105 个 → 红 |
| `R-AUTH-01` | `tests/server.test.ts` | 热重载落地后仍认覆盖位 → 第三次登录红 |
| `R-MEDIA-01` | `tests/media.test.ts` | `not.toThrow()` 直接红 |
| `R-SEC-01` | `tests/security.test.ts` | 退回 `RegExp` 时 64 个 `'a'` 指数级 → 超时红 |

`R-UI-01` 与 `R-OPS-01` 没有对应用例，是这轮留下的最大空白：

- **WebUI 一个组件级测试都没有。** `@vue/test-utils` 与 `@vitejs/plugin-vue` 已在 devDependencies，
  但 `vitest.config.ts` 既没配 vue 插件也没配 jsdom 环境。**重做 `D-UI-01` 之前必须先补这一层。**
- **SIGTERM 退出路径没有任何测试。** `docs/22 §6.1` 建议的那条「起进程 → 建一个 SSE 连接 → SIGTERM →
  断言进程在 `graceMs + 1s` 内退出」仍然没有，`pnpm smoke` 也没覆盖。

---

## 4. 仍然开着的

> **第七轮（2026-08-17）更新**：下面这张表里除 `D-UI-01` 的拆分本身之外都已闭合，见
> [25-round7-remediation.md](./25-round7-remediation.md)。组件测试层已经补上（`tests/webui/`
> + happy-dom + `@vitejs/plugin-vue`），SIGTERM 与资源上界两组测试也建了。

| 项 | 状态 |
|---|---|
| `D-UI-01` | 拆分仍未做（回退状态保持），但**前置条件已满足**：`tests/webui/console.render.test.ts` 逐个切过 14 个导航页、断言内容区非空且无 Vue 警告。它在第七轮上线的第一次运行就抓到了一处新引入的 prop 类型错配 —— 这层防线是活的 |
| `D-APPR-01` 的「发起人回执」 | 未实现，已在 `docs/05` 与 `docs/21 §6` 标 🚧。第七轮仍未做 —— 补它要把 EventBus 接进 telegram 包 |
| `G-API-13`（改口令没有界面入口） | ✅ 第四轮已补（`docs/21 §6.1`） |
| `docs/22 §4` 的 `I-01`…`I-14` | ✅ 第七轮做掉 9 项（`I-05` 判定为误报并修了同一处的真问题），见 `docs/25` |
| `docs/13-acceptance-criteria.md` | ✅ 第七轮：标 `(自动)` 的条目按真实 vitest 覆盖逐条核对并勾选，签署表复算 |
| 资源上界测试组 | ✅ 第七轮：`tests/resource-bounds.test.ts`（沙箱 stdout / 多字节解码 / 文档提取 / 日志轮转 / blob 外置）+ `tests/shutdown.test.ts` |
