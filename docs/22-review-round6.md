# 22 · 复审报告（第六轮）：漏洞 / 设计缺陷 / 可改进条目

> 复审对象：`docs/20-review-round5.md` 第五轮整改后的实现（HEAD = `75b1942`）
> 基线：`pnpm typecheck` 通过；`pnpm test` **53 个文件 / 222 个用例全部通过**（上一轮 46 / 156）
> 方法：全量重读 8,022 行源码（`packages/` + `apps/`）→ 针对性可运行探针（PROBE-1…4）→ 与
> `docs/03` / `05` / `07` / `09` / `10` / `11` 的承诺逐条对表
> 标记：★ = 已用可运行的探针实测确认，非仅代码推断
>
> **本文按需求方要求分三段**：[§2 漏洞](#2-漏洞)（可被利用或直接导致服务不可用）、
> [§3 设计缺陷](#3-设计缺陷)（能力存在但接线/边界设计有问题）、[§4 可改进条目](#4-可改进条目)（正确但可以更好）。
> 三段共用 §1 的复验结论与 §5 的修复批次；同一根因跨段时用编号互引。

---

## 0. 结论速览

| 项 | 结论 |
|---|---|
| 第五轮 3 P0 / 6 P1 / 15 P2 | **23/24 真正关闭**，唯一例外是 `W-APPR-01`（文档已诚实标 🚧，但代码里那 180 秒干等原样保留，见 `D-APPR-01`） |
| 新增漏洞 | **10 项**：2 个 P0（均 ★实测）、3 个 P1、4 个 P2、1 个 P3 |
| 新增设计缺陷 | 13 项（3 项 ★实测） |
| 新增可改进条目 | 14 项 |
| 本轮高发区 | **「进程级资源没有上界」**——正则回溯、子进程 stdout、流式渲染、日志文件、定时任务异常，五处都能把整个单线程进程拖垮或直接杀掉，而它们分属五个互不相关的模块 |
| 测试基线 | 用例数从 156 涨到 222，是六轮里最扎实的一次；但**没有任何一个用例给出 CPU / 内存 / 磁盘的上界断言**，两个 P0 全部落在这个缝里 |

### 0.1 本轮最重要的一条

**任何一个能调用 `grep` 的 `limited` 用户，可以用一个 33 个字符的正则把整个进程冻住 105 秒；再长几个字符就是几小时。**

`safeRegex`（`tools/files.ts:7`）拦的是嵌套量词 `(a+)+`、反向引用和断言，**拦不住交替式回溯**
`(a|a)*`。而 `tests/security.test.ts:35` 那条「rejects expensive file-search regular expressions」
断言的恰好是守卫已经认识的三种形状——**测试验证的是守卫自己的公理，不是「grep 有 CPU 上界」这个性质**。

```
PROBE-3  safeRegex('(a|a)*$')   -> ACCEPTED
PROBE-3  safeRegex('(a|ab)*c')  -> ACCEPTED
PROBE-3  safeRegex('(a|a|a)+$') -> ACCEPTED
PROBE-3  safeRegex('(x+x+)+y')  -> rejected      ← 守卫只认识这一类
PROBE-3  'a'×32 + 'b'  对  /(a|a)*$/u  = 105,119 ms（事件循环全程阻塞）
```

Node 是单线程的：这 105 秒里 Telegram long polling 不收单、WebUI 全部请求挂起、其它会话的
在途轮次一步也不走、`turnTimeoutMs` 的定时器也不会响（它同样排在事件循环上）。`abortSignal`
在这里毫无意义——回溯是同步的。

### 0.2 递归模式的变化

| 轮次 | 模式 |
|---|---|
| 一→三 | 上下文引擎连环：修一个缺陷激活一条休眠代码路径 |
| 四 | 配置持久化层：命名空间有校验器，但存在不走校验器的写入方 |
| 五 | 边界的另一侧从来没被联调过：本地对象交给外部依赖时形状对不上 |
| **六** | **有守卫、有测试，但守卫的判据是「我认识的坏形状」而不是「这个操作的资源上界」** |

`safeRegex`、`clipped()`、`splitTelegramText`、`MaintenanceService.cleanup` 四处的共同形状：

> 都写了限制，限制的都是**枚举得出来的坏情况**（已知的危险正则、结束之后的输出长度、
> 单条消息的字符数、数据库里的行数），而没有一处限制**这段代码最多能占用多少 CPU / 内存 / 磁盘**。

第五轮的教训是「不变量要从下游契约推导」。本轮补一条对称的：

> **凡是接受外部输入并进入循环/递归/回溯的代码，都必须有一个与输入形状无关的资源上界。**
> 形状黑名单只能拦住你想到的那些，上界能拦住你没想到的那些。

---

## 1. 第五轮发现的复验结果

### 1.1 P0（3/3 已修复，均照根因改）

| 项 | 状态 | 证据 |
|---|---|---|
| **W-CTX-01** 上下文里的 `role:'system'` | ✅ | `SENDABLE_ROLES`（`agent/runtime.ts:186`）读出侧降级；`KNOWN_ROLES`（`context/engine.ts:43`）写入侧断言；4 个注入点全改 `role:'user'`；`0006_context_role_system.sql` 清历史数据；`tests/context.contract.test.ts` 跨过了 AI SDK 那一跳 |
| **W-AGENT-01** `prepareStep` 覆盖 fallback 模型 | ✅ | `aliasModel()`（`runtime.ts:179`）把包装做进「按别名解析」层，`wrappedFor()` 按别名缓存，`prepareStep` 的 `patch.model` 也走它（`runtime.ts:369`）；`subagent.ts:34` 同步；`onServed` 补上了「谁真的服务了这一步」 |
| **W-MEDIA-01** sharp 输入输出同路径 | ✅ | `media.ts:58` 原始文件加 `.orig` 后缀，归一化后 `rmSync`；`tests/media.test.ts` 用真 JPEG 走完 `process()` |

### 1.2 P1 / P2（20/21）

| 项 | 状态 | 说明 |
|---|---|---|
| W-CFG-01 原型污染 | ✅（路径段） | `assignDotted`（`shared/src/index.ts:22`）三处共用，`__proto__`/`constructor`/`prototype` 被拒且上报。**值里的 `__proto__` 仍未覆盖，见 `V-CFG-01`** |
| W-CFG-02 热更新契约 | ✅ | `Sandbox` / `DatabaseApprovalBroker` / `ToolRegistry`（limits + rules）/ `McpManager` 全部改吃 getter；`HOT_RELOADABLE_CONFIG_KEYS` + CI 断言。**同类新实例见 `D-CFG-01`** |
| W-QUOTA-01 子 agent 花费不计配额 | ✅ | `subagent.ts:61` 调 `quota.commit`；单轮闸门改读 `ledger.turnCost`。**但 `perTurn` 的上限本身对子 agent 仍不设防，见 `D-QUOTA-01`** |
| W-TG-01 命令表三方不一致 | ✅ | `HANDLED_COMMANDS` + `COMMANDS` 表 + `bot.command()` 三者由 `tests/trigger.test.ts` 钉住；`bot.ts:96` 交回 `matchTrigger` |
| W-MCP-01 MCP 入参 schema | ✅ | `mcp/schema.ts` 的 `jsonSchemaToZod`；`timeoutMs` 传进 `callTool`；`reconcile` 断开被移除的 server |
| **W-APPR-01 Telegram 审批** | ⚠️ **仅文档关闭** | `docs/05 §346` 已诚实写明「Telegram inline keyboard 仍未实现」，但 `docs/20 §0.0` 记录的处置是「代码层面当场拒绝」——**这条决定没有落到代码**。运行时仍是插一条 pending 然后 `await` 满 `approval.ttlMs`。见 `D-APPR-01` |
| W-TG-02/03/04/05 | ✅ | `/ctx` 改摘要；`sendWithFallback` 两条投递路径共用；收尾循环走 `deliver`；编辑消息统一按背景归档 |
| W-TOOL-01 `execute()` 复查 | ✅（部分） | `available?.()` 与 `agentKind==='sub' && memory_write` 都补上了。**`allow`（skill / 子 agent 白名单）仍只在目录层过滤，见 `D-TOOL-01`** |
| W-SBX-01/02 | ✅ | 容器名 `luoli-sbx-<turnId>-<seq>`；jail 模式 warn 日志 |
| W-PROMPT-01 / W-PROV-01 / W-LEDGER-01 | ✅ | `prompt.truncated` warn；`randomInt` 抖动；`aliasOf` + `infoByModelId` 反查真实别名 |
| W-SEC-01 / W-SEC-02 | ✅ | `searchApiKeyRef` → `searchApiKey`（明说是明文）；scrypt + `v2.` 密文版本化 + 读时就地升级 |
| W-FS-01 / W-API-01/02/03 / W-CFG-03 | ✅ | `glob`/`grep` 的 `#enter` realpath 去重；`/api/health` 拆分；`adminSearchCount`；`envOverlay` 启动与热重载共用 |

**24 项里 23 项是根因修复，且大多超出了报告要求的最小改动**（`onServed` 这一份报告里根本没提，是修的人自己看出来的）。

---

## 2. 漏洞

> 口径：能被使用者（含模型自身）触发，且后果是**越权、信息泄露或服务不可用**。
> 严重度按「触发门槛 × 后果范围」定，不按代码改动量。

### V-DOS-01 ★实测 · P0 · `grep` 的正则守卫拦不住交替式回溯，一次调用冻住整个进程

**位置**：`packages/core/src/tools/files.ts:6-9`（`safeRegex`）· 同一份守卫也用在
`packages/core/src/config/wakeword.ts:5`（`UNSAFE_SOURCE`）

```ts
function safeRegex(source: string, ignoreCase: boolean): RegExp | null {
  if ([...source].length > 128 || /\\[1-9]|\(\?[=!<]|(\([^)]*[+*][^)]*\))[+*]|\{\d+,\d*\}\s*[+*{]/.test(source)) return null;
  try { return new RegExp(source, ignoreCase ? 'giu' : 'gu'); } catch { return null; }
}
```

守卫枚举了四类坏形状：反向引用、断言、**括号内含 `+`/`*` 且整体再被 `+`/`*` 限定**、`{n,m}` 后接量词。
交替式回溯 `(a|a)*` 的括号里一个量词都没有，因此整条判据都碰不到它。

**实测（PROBE-3）**：见 §0.1。`'a'×32 + 'b'` 对 `/(a|a)*$/u` 耗时 **105,119 ms**；指数增长，
36 个字符就是约 28 分钟。同样通过守卫的还有 `(a|ab)*c`、`(a|a|a)+$`，以及最普适的 `(.|.)*$`
——后者对**任意** 30 字符以上的行都成立，不需要构造特殊内容。

**触发条件**：`grep` 的 `minRole` 是 `limited`（`tools/policy.ts:17`），工作目录里只要有一个文件
带一行 30 字符以上的文本即可（`bash` / `write_file` 写过任何东西的会话都满足；`.luoli-bak`
是隐藏目录默认不扫，但正常产物不是）。模型自己也可能无意触发——内核提示词让它「工具报错只修正参数」，
它会重试。

**影响**：Node 单线程。回溯期间 —— Telegram 不收单（long polling 的 `getUpdates` 排在事件循环上）、
WebUI 所有请求挂起、SSE 心跳停、其它会话的在途轮次一步不走、`concurrency.turnTimeoutMs` 与
`TurnRegistry` 的超时定时器也不会响（同一个事件循环）。**没有任何现有机制能中断它**：
`abortSignal` 对同步回溯无效，`ToolRegistry` 的 `maxCallsPerTurn` 只在调用返回后才计数。

**唤醒词是同一个洞的另一扇门**：`checkWakeword` 用同一份 `UNSAFE_SOURCE`，而唤醒词是对
**每一条群消息**的前 4096 字符求值的。运维在 WebUI 存一条 `^(a|a)*$`（`POST /api/config/wakewords/check`
会返回 `ok:true`），此后任意群成员发一句 `aaaa…` 就永久冻住 bot。

**修复**（守卫改不动这个问题，必须给上界）：

1. **首选：换线性时间引擎。** `grep` 的语义不需要回溯特性，`node-re2` / `RE2` 绑定对同样的模式是 O(n)。
   模式编译失败时如实返回 `invalid_pattern`，不要退回 `RegExp`。
2. **退而求其次：把匹配移出事件循环并给硬超时。** `worker_threads` 里跑匹配，主线程 `Atomics.wait`
   或超时后 `worker.terminate()`。成本是每次 `grep` 一个 worker，但 `grep` 本来就不是热路径。
3. **无论选哪个，都要补一条与形状无关的断言**（见 §6）：
   ```ts
   // tests/security.test.ts —— 断言的是「上界」而不是「守卫认识的形状」
   it('grep 对任何通过校验的模式都有 CPU 上界', () => {
     for (const pattern of ['(a|a)*$', '(a|ab)*c', '(.|.)*$', '(a|a|a)+$']) {
       const started = performance.now();
       files.grep(pattern, '.');                    // 目录里放一行 64 个 'a'
       expect(performance.now() - started).toBeLessThan(1000);
     }
   });
   ```
4. `checkWakeword` 同步处理；`WAKEWORD_SCAN_LIMIT=4096` 只削减了输入长度，对指数复杂度不起作用。

---

### V-DOS-02 · P0 · 沙箱子进程的 stdout 在进程结束前完全没有上界

**位置**：`packages/core/src/sandbox/index.ts:146-164`

```ts
let stdout = '';
let stderr = '';
child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });   // ← 无上界
child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
…
const exitCode = await new Promise<number | null>((resolve) => child.once('close', resolve));
const out = clipped(stdout, this.#cfg().maxOutputBytes);                        // ← 结束之后才截
```

`maxOutputBytes`（默认 64 KB）只在**子进程退出之后**才生效。在此之前，`stdout` 是一个无限增长的
V8 字符串，长在 bot 进程的堆里。

**触发**：`bash` 的 `minRole` 是 `trusted`；`owner` 走 `bypassRoles` 直接在宿主跑。一条
`yes`、`cat /dev/urandom | base64`、`seq 1 1e12` 都可以。默认 `tools.exec.defaultTimeoutMs=60000`，
`maxTimeoutMs=300000`（模型可以自己传 `timeoutMs`）。

**为什么现有的三道限制都挡不住**：

| 限制 | 为什么无效 |
|---|---|
| `ulimit -f`（jail/host 模式，`index.ts:141`） | `-f` 限的是**文件**大小，管道写入不受限 |
| `--memory=512m`（docker 模式） | 限的是**容器**的内存，不是我们这一侧的接收缓冲 |
| `--pids-limit` / `--cpus` | 与输出量无关 |

**影响**：几秒钟内几百 MB 到几 GB 的堆增长 → V8 OOM → 整个 bot 进程被杀。`recoverAfterCrash`
会在下次启动时把所有 `running` 轮次记成 `process_restarted`，但用户侧看到的是 bot 突然消失。
这在多租户群里是一个 `trusted` 用户单方面拉停全服务的能力。

**修复**（一处，边收边截）：

```ts
const cap = this.#cfg().maxOutputBytes;
let stdoutBytes = 0;
child.stdout.on('data', (chunk: Buffer) => {
  stdoutBytes += chunk.length;
  // 留两倍余量给 clipped() 的首尾拼接，超过就丢弃后续并杀掉子进程 —— 反正也要被截断。
  if (stdout.length < cap * 2) stdout += chunk.toString();
  else if (!killed) { truncatedByCap = true; kill(); }
});
```

`stderr` 同理。顺带把 `chunk.toString()` 换成 `StringDecoder`：现在按 chunk 边界解码会切坏多字节字符。

**回归用例**：`sandbox.mode: 'jail'` 下跑 `yes | head -c 100000000`，断言 `run()` 在
`maxOutputBytes` 的常数倍内返回且 `truncated=true`，进程 RSS 不超过基线 + 若干 MB。

---

### V-SKILL-01 · P1 · `read_file` 的 `skill://` 分支绕过 skill 的 `min-role`

**位置**：`packages/core/src/tools/builtins.ts:65-71` · `packages/core/src/skills/loader.ts:189-199`

```ts
// builtins.ts —— read_file
if (!input.path.startsWith('skill://')) return dependencies.filesFor(context.workspace).read(...);
const path = dependencies.skills.resolveResource(input.path);   // ← 没有传 role
const buffer = readFileSync(path);
```

```ts
// loader.ts —— resolveResource
const skill = this.#skills.get(name!);
if (!skill || !skill.enabled) throw new Error('skill_unavailable');   // ← 只判 enabled
```

`SkillLoader` 有两条读取路径，只有一条判角色：

| 路径 | 判 `minRole` |
|---|---|
| `load_skill` → `loader.load()`（`loader.ts:184`） | ✅ `roleRank(role) < roleRank(skill.minRole)` → 权限不足 |
| `read_file skill://<name>/<file>` → `resolveResource()` | ❌ 无 |

`read_file` 的 `minRole` 是 `limited`（`tools/policy.ts:14`），而 skill 的默认 `minRole` 是
`skills.defaultMinRole = trusted`，运维还可以在 frontmatter 里写 `min-role: owner`。

**影响**：任何 `limited` 用户（或代表他的模型）用 `read_file`、`path="skill://<name>/SKILL.md"`
就能拿到本应 owner 专属的 skill 全文与目录内所有资源文件。skill 目录正是运维放「内部流程、
特权操作手册、上游账号约定」的地方——`min-role: owner` 就是为这个存在的。名字不是秘密：
`catalog()` 按角色过滤，但 skill 目录名可以猜，`list_dir` 也够不着但 `glob` 在工作目录外无效，
所以门槛是「知道名字」而不是「有权限」——这不是安全边界。

**修复**：把角色带进解析层，和 `load()` 用同一条判据。

```ts
// loader.ts
resolveResource(uri: string, role: Role): string {
  …
  const skill = this.#skills.get(name!);
  if (!skill || !skill.enabled) throw new Error('skill_unavailable');
  if (roleRank(role) < roleRank(skill.minRole)) throw new Error('skill_forbidden');
  …
}
// builtins.ts
const path = dependencies.skills.resolveResource(input.path, context.turn.effectiveRole);
```

**回归用例**：`tests/skill.runtime.test.ts` 加一条——`min-role: owner` 的 skill，
`limited` 角色调 `read_file skill://…` 必须 `ok:false`。

---

### V-AUTH-01 · P1 · 登录限速可被 `X-Forwarded-For` 绕过；关掉 `trustProxy` 又变成全局锁死

**位置**：`packages/server/src/app.ts:112-115`（`requestIp`）· `189-208`（`/api/auth/login`）

```ts
function requestIp(ctx, config): string {
  if (!config.webui.trustProxy) return 'local';
  return ctx.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
}
```

两个模式各有一个问题，且都是「限速形同虚设」：

| `webui.trustProxy` | 行为 | 后果 |
|---|---|---|
| `true`（放在反代后必须开，否则拿不到真实 IP） | 取 XFF 的**最左**一跳 | 最左一跳是**客户端自己写的**。攻击者每次请求换一个 `X-Forwarded-For`，`failures` 里永远是新桶，`loginRateLimit.attempts=5` 一次都触发不了 |
| `false`（默认） | 所有请求都记在 `'local'` 这一个桶里 | 任何人连按 5 次错密码，**owner 自己也被锁 15 分钟**；攻击者可以持续锁死管理端 |

**次生影响**：`argon2id(memoryCost=19456, timeCost=2)` 每次校验约 19 MiB + 几十毫秒 CPU。
绕过限速之后，登录端点本身就是一个放大的 CPU/内存打击面——`/api/auth/login` 在鉴权中间件**之前**，
不需要任何凭据。

**另外**：`failures` 是一个永不清理的 `Map`，键由攻击者控制（XFF 值），只在登录成功时 `delete` 单条。
这是一个可无限增长的内存结构。

**修复**：

1. `requestIp` 改成「按配置的可信跳数从**右**往左取」：`webui.trustedProxyHops`（默认 1），
   `xff.split(',').at(-hops)`。反代自己追加的那一跳才是可信的。
2. 无论哪种模式，**同时**维护一个全局失败计数：单 IP 桶防定向爆破，全局桶防「换 IP 绕过」，
   全局桶触发时改成延迟响应（而不是 429 锁死），避免变成拒绝 owner 的开关。
3. `failures` 加上限（LRU 或定期清 `lockedUntil` 已过期的条目）。
4. 顺带：`/api/auth/login` 与 `/api/setup` 在 `argon2` 之前加一个廉价的请求体长度检查
   （密码 > 1024 字符直接 400），避免拿超长口令刷 argon2。

---

### V-AUTH-02 · P1 · WebUI 口令改不掉：写进去返回 200，运行时仍认旧口令

**位置**：`packages/server/src/app.ts:147` · `189-208`

```ts
let passwordHash = currentConfig().webui.passwordHash;   // ← 建服务器时读一次，此后再没更新过
…
valid = Boolean(body.password && passwordHash && await argon2.verify(passwordHash, body.password));
```

`passwordHash` 是 `createServer()` 的闭包变量，只有两处会写它：初始化时读一次、`POST /api/setup`
成功时赋值。而 `/api/setup` 只在**首次部署（尚无口令）**时可用（`dependencies.setup` 在
`main.ts:144` 只有 `!config.webui.passwordHash` 时才生成）。

于是「改口令」的唯一通路是 `PUT /api/config {"webui.passwordHash": "<argon2 hash>"}`：

- 请求返回 `200 {ok:true}`；
- `config_kv` 写入成功，`config_revisions` 留下审计记录；
- `config.changed` 触发热重载，`configStore` 里的值也更新了；
- **但 `passwordHash` 这个闭包变量没人动**，登录校验用的还是它。

结果：**旧口令继续能登录，新口令登不上**，而界面告诉运维「保存成功」。这正是
[16 §5](./16-remediation-plan.md)「摘除比伪造安全」要消灭的形态——只不过这次伪造的是
一次安全操作的成功。泄露口令后的应急处置（改密码）在这个系统上是无效的，直到重启。

**并且没有任何改口令的入口**：`ConsoleView.vue` 里搜不到 password 相关表单（只有 provider
的 API Key 输入框），`docs/09 §2.1` 也只描述了「`pnpm webui:passwd` 生成或首次启动向导写入」。

**修复**：

1. 校验时现读，别缓存：
   ```ts
   const activeHash = (): string => setupWrittenHash ?? currentConfig().webui.passwordHash;
   ```
   （`/api/setup` 那次写入要保留一个覆盖位，因为它没有触发 `config.changed`。）
2. 补 `POST /api/auth/password {current, next}`：校验旧口令 → `argon2.hash(next)` → 落
   `config_kv` + `config_revisions` → **吊销该用户的其余 session**（`DELETE FROM sessions WHERE id<>?`）。
   改口令而不吊销旧会话，等于改了个寂寞。
3. `POST /api/setup` 成功后顺手 `events.emit('config.changed', {keys:['webui.passwordHash']})`，
   让 `configStore` 与闭包在同一时刻一致。

---

### V-SSRF-01 · P2 · `probeProvider` 无任何出网防护，且会跟着 302 把 API Key 送到第三方

**位置**：`packages/core/src/provider/catalog.ts:81-100` · 调用方 `packages/server/src/app.ts:314-329`

```ts
response = await fetch(catalogUrl(target.kind, baseUrl), {
  headers: { accept: 'application/json', ...target.headers ?? {}, ...authHeaders(target.kind, apiKey) },
  signal: AbortSignal.timeout(timeoutMs),
  redirect: 'follow',                                  // ← 跟随重定向
});
```

`web_fetch` 那一侧（`tools/web.ts`）做得很扎实：DNS 预解析 + 全部地址过私网判定 + 自定义
`lookup` 钉死已校验 IP + 每次重定向重新校验。**这条路径一样都没有**：

1. **无私网判定。** `POST /api/providers/:id/test` 接受请求体里的 `baseUrl` 覆盖
   （`app.ts:318` 的 `adhoc` 分支），于是管理端就是一个带鉴权的 SSRF 代理，
   `http://169.254.169.254/latest/meta-data/` 之类可以直接打。
2. **`redirect: 'follow'` + 自定义鉴权头。** Node 的 fetch 按规范只在跨源重定向时剥掉
   `Authorization`，**不剥 `x-api-key` / `x-goog-api-key`**（`authHeaders` 对 anthropic / google
   用的正是这两个）。一个被入侵的上游网关只要回一个 `302 Location: https://attacker/`，
   就能收到明文 API Key。
3. `ModelCatalog`（`provider.catalog.url`，默认 `https://models.dev/api.json`）是同一形态的第三条出网路径。

**影响定级为 P2 而不是 P1**：三条路径都需要已登录的 owner 会话，且 WebUI 默认绑 `127.0.0.1`。
但第 2 点是**不需要攻击者碰 WebUI 的**——只要上游被劫持或域名过期即可。

**修复**：把 `web_fetch` 的守卫抽成 `packages/core/src/net/outbound.ts`，三条路径共用：

```ts
export async function guardedFetch(url: string, init: RequestInit, policy: { allowPrivate: boolean }): Promise<Response>;
```

- `redirect: 'manual'`，自己处理 3xx 并对每一跳重新走 `safeTarget`；跨源时剥掉全部鉴权头。
- `allowPrivate` 做成配置（`provider.allowPrivateBaseUrl`，默认 `false`）——自建网关跑在
  内网是合理场景，但它必须是运维显式打开的，而不是默认没人管。

---

### V-NET-01 · P2 · `web_fetch` 的私网判定漏了若干保留段，且不限端口

**位置**：`packages/core/src/tools/web.ts:8-23`（`privateAddress`）

现有覆盖：`0/8`、`10/8`、`127/8`、`169.254/16`、`172.16/12`、`192.168/16`、`100.64/10`、
`>=224`、IPv6 的 `::1` / `fc` / `fd` / `fe8-feb` / IPv4-mapped。**漏掉的**：

| 段 | 用途 |
|---|---|
| `198.18.0.0/15` | 基准测试网段，常被用作内网 |
| `192.0.0.0/24` | IETF 协议分配 |
| `192.0.2.0/24`、`198.51.100.0/24`、`203.0.113.0/24` | TEST-NET-1/2/3 |
| `64:ff9b::/96` | NAT64，可编码任意 IPv4（含 `127.0.0.1`） |
| `2002::/16` | 6to4，同上 |

另外**没有端口限制**：`http://<公网主机>:6379/` 之类可以拿来探公网上的非 HTTP 服务
（返回体会被当成正文塞进上下文）。

**修复**：补齐上表；加 `ALLOWED_PORTS = new Set([80, 443, 8080, 8443])`（或按配置）；
`64:ff9b::/96` 与 `2002::/16` 按内嵌的 IPv4 递归判一次，和现有的 `::ffff:` 分支同样处理。

---

### V-LOG-01 · P2 · 日志文件与 blob 永不删除，`logs.retentionDays` 只清了数据库

**位置**：`packages/core/src/maintenance.ts:26-37` · 承诺见 `docs/03-data-model.md:596-597`

`docs/03` 的保留策略表写得很明确：

| 对象 | 策略 | 实现 |
|---|---|---|
| `log_events` | `logs.retentionDays` = 30 | ✅ `DELETE FROM log_events WHERE ts<?` |
| `logs/*.jsonl` | 同上，「超期文件删除；可选先 gzip」 | ❌ **一行都没有** |
| `logs/<day>/blobs/*.json` | 随上 | ❌ 无 |

`logs.captureBodies` 默认 `true`，`LogSink.event` 把每一步模型调用的**完整请求体**
（含全部工具 schema 与上下文）写进 `logs/<day>/model.jsonl`，超过 `bodyMaxBytes`（256 KB）
的还额外落一个 blob 文件。一个中等活跃的实例每天几百 MB 起。

**次生影响比「占磁盘」更糟**：`LogSink.event` 用的是 `appendFileSync`。磁盘写满时它**抛异常**，
而它在 `runtime.ts` 的 `onStepEnd`、`ToolRegistry.execute` 的 span、`bot.ts` 的 `turn.end`
等处都是裸调用——一次 ENOSPC 就能把在途轮次打成 failed，并且错误信息与真实原因（磁盘满）
毫无关系。`POST /api/maintenance/gc-files` 明确返回 `not_implemented`，所以运维在界面上也没有出口。

**修复**：`cleanup()` 里补一段目录清理，与 DB 那一半用同一个 `logCutoff`：

```ts
const cutoffDay = new Date(logCutoff).toISOString().slice(0, 10);
for (const day of readdirSync(this.logsDir, { withFileTypes: true })) {
  if (!day.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(day.name) || day.name >= cutoffDay) continue;
  rmSync(join(this.logsDir, day.name), { recursive: true, force: true });
}
```

（目录名就是 `YYYY-MM-DD`，字典序即时间序，不需要解析。）另外把 `LogSink.event` 的写盘包一层
try/catch：**日志写不进去不该让业务失败**，降级成 stderr 一行即可。

---

### V-LOG-02 · P2 · 解密后的 provider API Key 不在日志脱敏名单里

**位置**：`apps/bot/src/main.ts:70` · 承诺见 `docs/10-logging-and-observability.md:130`

`docs/10` 写的是脱敏「内置，不可关闭」，明确列了 **「`providers.api_key_enc` 解密后的明文」**。
实际传给 `LogSink` 的 `secrets` 只有两个：

```ts
const log = new LogSink(operations, config.logs.dir, [process.env.BOT_TOKEN ?? '', process.env.LUOLI_MASTER_KEY ?? ''], …);
```

`redact()` 的内置正则（`secrets.ts:67-71`）能兜住 `sk-…` 与 `Bearer …`，但兜不住
Google 的 `AIza…`、xAI 的 `xai-…`、以及任意自建网关的 key 形态。

**泄漏路径**：上游返回的错误体在 `model.error`（`runtime.ts:346`）与 `provider.health`
（`app.ts:362`）里原样入库/入文件，而不少网关会在 4xx 响应里回显整个请求（含 headers）。
`probeProvider` 自己做了 `clean()`（`catalog.ts:86`，带上本次 key），但那只覆盖它自己的返回值。

**修复**：`ProviderStore` 暴露一个 `allDecryptedKeys(): string[]`（rebuild 时缓存），
`main.ts` 在 `modelRegistry.rebuild()` 之后把它并进 `log` 的 secrets 列表；
`rebuildModels()` 的回调里同步刷新。同时把 `config.tools.web.searchApiKey` 一并加进去
——它是明文存的，最有可能出现在日志里。

---

### V-INFO-01 · P2 · `/ping` 对 `limited` 用户吐全局运营数据（含累计花费）

**位置**：`packages/telegram/src/bot.ts:172-175` · `packages/db/src/operations.ts:47-52`

```ts
bot.command('ping', async (ctx) => {
  if (!await requireRole(ctx.update.update_id, 'limited', …)) return;
  await ctx.reply(`LuoLiCore …\n运行正常\n${JSON.stringify(dependencies.operations.dashboard())}`);
});
```

`dashboard()` 返回的是**跨全部会话**的聚合：轮次总数、在途数、失败数、**累计 USD 花费**、
消息总数、provider 数量。

`/usage` 已经正确地要求 `owner`（`COMMANDS` 表里 `minRole: 'owner'`），`/ping` 却把同一类信息
以「健康检查」的名义发给任何 `limited` 用户——包括不该知道这台机器还服务着哪些人、烧了多少钱的群成员。

**修复**：`/ping` 只回版本 + 「运行正常」+ 该用户自己的有效角色；聚合数据留给 `/usage`。
如果要保留 owner 的便利，按角色分支：`access.effectiveRole === 'owner'` 时才附 dashboard。

---

### V-CFG-01 · P3 · `assignDotted` 只挡路径段，不挡值里的 `__proto__`（当前无害，但是巧合）

**位置**：`packages/shared/src/index.ts:22`（`assignDotted`）· `packages/core/src/config/index.ts:7`（`deepMerge`）

第五轮的 `W-CFG-01` 修的是**点分路径的段**：`'__proto__.x'` 这样的键被拒。但值本身没有过滤，
而 `JSON.parse('{"__proto__":{…}}')` 会产出一个**自有**的 `__proto__` 属性，随后
`deepMerge` 的 `result[key] = …` 会触发 `Object.prototype.__proto__` 的 setter。

**实测（PROBE-1）**：

```
own keys of parsed value      = [ '__proto__' ]
assignDotted('tools.overrides', value) = true          ← 放行
({}).LUOLI_POLLUTED after deepMerge    = undefined     ← 全局 Object.prototype 安全
merged.tools.overrides 的原型          = { LUOLI_POLLUTED: 'pwned' }   ← 被改写了
```

**为什么现在无害**：污染的是**某个嵌套配置节点自己的原型**，不是 `Object.prototype`；
而 `configSchema.safeParse` 用 `Object.keys` 重建对象，继承来的键在 `parsed.data` 里不会出现，
`loadConfig` 返回的也正是 `parsed.data`。

**为什么仍要修**：这份安全性完全依赖「zod 恰好用 `Object.keys` 重建」和「`deepMerge` 的结果
一定会过一次 schema」。`dottedOverrides` 与 `readPersistedConfig` 是公开导出的，它们的返回值
是**未经校验**的；`envOverlay(overrides)` 就直接在这个对象上做属性赋值。任何一个新的调用方
不走 schema，这条链就活了。

**修复**（一行，且与已有守卫同一处）：`assignDotted` 里对值做一次浅遍历，
或者更彻底——`readPersistedConfig` / `dottedOverrides` 解析时用
`JSON.parse(raw, (k, v) => k === '__proto__' ? undefined : v)`。前者更集中，后者更根治，建议后者。

---

## 3. 设计缺陷

> 口径：能力**已实现**，但接线、边界或职责划分有问题，导致「配了不生效」「有上限但拦不住」
> 「文档承诺与运行时行为不一致」。不含单纯的性能或代码风格问题（那些在 §4）。

### D-PLUGIN-01 · P1 · Plugin 子系统在生产部署里没有任何入口

**位置**：`packages/core/src/plugins/manager.ts:28-37` · `packages/server/src/app.ts:834-836` ·
承诺见 `docs/07-skills-plugins-mcp.md:185`

`PluginManager.reconcile()` 的发现逻辑是：

```ts
const enabled = new Map(this.db.prepare('SELECT name,enabled,config_json FROM plugins').all()…);
for (const name of readdirSync(this.directory)) {
  const row = enabled.get(name);
  if (!row?.enabled || !existsSync(path)) continue;      // ← 库里没有这一行就直接跳过
  …
}
```

**全仓库没有任何一处 INSERT 进 `plugins` 表。** `grep -rn "INTO plugins"` 只在
`0001_init.sql` 的建表语句里有结果。于是：

| 步骤 | 期望（doc 07 §3.2） | 实际 |
|---|---|---|
| 把 plugin 放进 `./plugins/<name>/plugin.js` | 启动/重载时被发现，写一行 `enabled=0` | **没有任何代码写这一行** |
| owner 在 WebUI 里看到它 | `GET /api/plugins` 列出 | 查的是空表，永远是空列表 |
| owner 点「启用」 | `PATCH /api/plugins/:name` | `UPDATE … WHERE name=?` 命中 0 行，**返回 `{ok:true, changes:0}`** |
| `reconcile()` 加载它 | import + 注册工具 | 永远走不到 |

`tests/plugin.runtime.test.ts` 全绿——因为它自己在第 16 行 `INSERT INTO plugins(...)` 把行造出来了。
**测试覆盖的是 `PluginManager` 这个类，不是「一个 plugin 从落盘到生效」这条链**，
和第五轮三个 P0 是同一个形状，只是这次断在了「我们的代码 → 我们自己的另一段代码」之间。

**顺带失效的一整片**：

- `docs/07 §3.3` 的 hook 顺序图里，`onToolCall` / `onToolResult` / `beforeSend` **一次都没有被调用过**
  （全仓库 0 处引用；被调用的只有 `onMessage` / `beforeTurn` / `beforeModelCall` / `afterCommit`）。
- `@luoli/plugin-sdk` 的 `PluginDefinition` 声明了 `minRole` / `configSchema` / `commands` /
  `agents` / `onLoad`，`PluginManager` 一个都不读（`min_role` 读的是**数据库列**，
  而那一列同样没人写）。
- `docs/07 §3.2` 的「含密字段自动加密存储 + 前端只显示 hint」没有实现。

**修复**（按「先能用，再谈完整」排）：

1. `reconcile()` 开头加一次发现登记：扫 `./plugins/*/plugin.js`，对每个目录
   `INSERT INTO plugins(name,path,min_role,enabled,updated_at) VALUES (?,?,'trusted',0,?) ON CONFLICT(name) DO NOTHING`
   ——**默认 `enabled=0`**，与 doc 07 的「必须 owner 显式启用」一致。
2. `PATCH /api/plugins/:name` 在 `changes===0` 时返回 404，别再假成功。
3. `min_role` 改从 `definition.minRole` 取（SDK 已经声明了），DB 列作为 owner 覆盖。
4. 三个未接线的 hook：要么接上（`ToolRegistry.execute` 前后 + `TelegramOutput` 投递前），
   要么在 `docs/07 §3.3` 的图上标 🚧。**不要保留「文档画着但没有」的状态。**
5. **回归用例**：新写一个 `tests/plugin.discovery.test.ts`——只往目录里放文件，不碰数据库，
   断言 `reconcile()` 之后 `GET /api/plugins` 能看到它、`PATCH` 能启用它、启用后工具进注册表。

---

### D-QUOTA-01 · P1 · `quota.perTurn.*` 对子 agent 完全不设防

**位置**：`packages/core/src/agent/subagent.ts:46` · 对照 `packages/core/src/agent/runtime.ts:358,372`

主 agent 有两道闸：

```ts
stopWhen: stepCountIs(Math.min(config.agent.main.maxSteps, config.quota.perTurn.maxSteps)),   // 步数
…
const cost = dependencies.ledger.turnCost(turn.turnId);                                        // 花费
if (cost >= config.quota.perTurn.maxCostUsd || …) { patch.activeTools = []; patch.toolChoice = 'none'; }
```

子 agent 一道都没有：

```ts
const agent = new ToolLoopAgent({ model, …, stopWhen: stepCountIs(definition.maxSteps) });     // 只有定义里的步数
```

`runSubAgent` 没有 `prepareStep`，因此没有任何成本闸门；`definition.maxSteps` 也不与
`quota.perTurn.maxSteps` 取 min。

**后果链**：`spawn_agent` 的 `minRole` 是 `limited`；`agent.maxSubagentsPerTurn` 默认 10；
`docs/04 §3.1` 给的示例 agent 里 `coder` 是 `maxSteps: 30`。于是**一轮最多 10 × 30 = 300 次
模型调用**，而 `quota.perTurn.maxSteps` 是 12、`maxCostUsd` 是 0.5。

第五轮的 `W-QUOTA-01` 修的是「花费**记不记**得到日/月计数器上」，修得对；但「单轮**拦不拦**得住」
是另一件事：主 agent 的成本闸门只在**主 agent 的下一步**才重新求值，而一次
`spawn_agent` 调用在返回之前是一个不可中断的黑盒。

**修复**：

1. `stopWhen: stepCountIs(Math.min(definition.maxSteps, config.quota.perTurn.maxSteps))`
   ——子 agent 也拿一份 config（`turn.config` 已经在手上）。
2. 给 `runSubAgent` 补 `prepareStep`，用与主 agent 相同的那一句：
   ```ts
   prepareStep: async () => (dependencies.ledger.turnCost(turn.turnId) >= perTurn.maxCostUsd
     ? { activeTools: [], toolChoice: 'none' as const } : {}),
   ```
   `turnCost` 是按 `turn_id` 聚合的，主 agent 与所有兄弟子 agent 的花费都在里面，天然共享同一个天花板。
3. `spawn_agent` 在派发**之前**先看一眼 `turnCost`：已经超了就直接
   `{ ok:false, error:'turn_budget_exhausted' }`，不要开一个注定会被闸掉的 agent。

---

### D-STREAM-01 ★实测 · P1 · 流式输出每收到一个 chunk 就把全文重新渲染并切分一次

**位置**：`packages/telegram/src/stream-output.ts:69`

```ts
if (Date.now() < Math.max(this.since + replyDelayMs, firstChunkAt + bufferMs)) continue;
const rendered = splitTelegramText(text, this.options.maxChars);      // ← 每个 chunk 都跑一次全文
…
if (Date.now() - lastEdit >= this.options.intervalMs && …) {          // ← 编辑才有节流
```

**编辑动作**有 `intervalMs`（2 s）与 `minDeltaChars`（24）两道节流，**渲染没有**。
`splitTelegramText` 会调 `safeRender`（5 遍全文正则 + 逐行 replace），再在切分循环里
反复 `[...remaining]` 把整串展开成码点数组。

**实测（PROBE-2）**：40 KB 的中文回答、20 字符一个 chunk（典型 token 流）：

```
chunks=1980  finalChars=39600  totalMs=3507      ← 累计 3.5 秒纯 CPU
single call on full text = 4ms                   ← 只在需要投递时算一次的话
```

**影响**：这 3.5 秒是**同步**占用事件循环的，分散在整个流式过程中。`concurrency.global` 默认 8，
八个会话同时在长回答上流式输出时，进程的 CPU 全花在重复渲染同一段文本上——表现是
「回复越长越卡、别的群跟着一起变慢」，而所有指标（模型延迟、DB、网络）都正常。

**修复**（把渲染挪到节流之后，两行）：

```ts
if (Date.now() - lastEdit < this.options.intervalMs && messageIds.length) continue;   // 先判节流
const rendered = splitTelegramText(text, this.options.maxChars);                      // 再渲染
```

顺带修 `splitTelegramText` 内部的 `[...remaining]`：循环每一轮都重建整串的码点数组，
本身就是 O(n²/max)。改成在进入循环前展开一次、之后只在数组上切片。

---

### D-APPR-01 · P1 · Telegram 侧没有审批通道，非 owner 的高危工具静默挂 180 秒

**位置**：`packages/core/src/approvals.ts:54-84` · `packages/telegram/src/bot.ts:294-301`

`docs/05 §346` 现在写得很诚实：「**当前可用通道是 WebUI。**…Telegram inline keyboard 仍未实现」。
但 `docs/20 §0.0` 记录的需求方裁决是另一件事：

> `W-APPR-01` 选了「摘除」而不是「实现」…**不是**「保留 180 秒等待 + 给发起人回执」，
> 而是**代码层面当场拒绝**，把原因作为 `hint` 交给模型。

**这条裁决没有落到代码。** `DatabaseApprovalBroker.request` 依然是：插一条 `pending` →
`emit('approval.pending')` → 返回一个只有 `decide()` / 超时 / abort 才会 resolve 的 Promise，
`timer` 是 `config.approval.ttlMs`（默认 180 s）。

**运行时后果**（trusted 用户在 Telegram 里让模型 `delete_file`，policy 是 `approval:'always'`）：

- 该轮次**挂 180 秒不动**，其间占着 `concurrency` 的槽（`perKey=3`、`global=8`）、
  占着配额预留、占着 `turnTimeoutMs` 的预算；
- Telegram 侧**零提示**——没有「正在等待管理员批准」，也没有「已超时」；用户看到的是 bot 三分钟不吭声；
- owner 除非恰好开着 WebUI 的审批页，否则根本不知道有这回事；
- 三分钟后模型收到 `未获批准` + `EXPIRED_HINT`，才第一次开口。

`callback_query:data` 的处理器只认 `c:`（取消）前缀，没有 `a:` 分支。

**修复**（二选一，仍然不要留中间态）：

1. **落实已裁决的方案**：`request()` 里判断「有没有活着的裁决通道」——没有 SSE 订阅者
   （`EventBus` 加一个 `subscriberCount`）时**当场返回** `{approved:false, hint:'该操作需要 owner
   批准，但当前没有可用的审批通道'}`，不要 await。有订阅者时才走现在这条等待路径。
2. **补上 Telegram 通道**：`DatabaseApprovalBroker` 加可选 `notifier`，`main.ts` 注入 Telegram
   实现，发 `a:<id>:ok` / `a:<id>:no` 的 inline keyboard；`callback_query:data` 加 `a:` 分支，
   校验点击者是 owner 后调 `decide()`。

无论选哪个，**发起人都必须在第一时间收到一句话**说明正在等什么、等多久。

---

### D-CFG-01 · P2 · `memory.pubWriteMinRole` 的 perChat 覆盖不生效，「只允许更严格」也没人执行

**位置**：`apps/bot/src/main.ts:133` · `packages/core/src/tools/builtins.ts:110-114` ·
承诺见 `docs/11-config-reference.md §2.1`

doc 11 §2.1 的 perChat 白名单里有这么一行（且**没有**标 🚧，同一份清单里的 `character` 是标了的）：

```
memory.pubWriteMinRole（只允许比全局更严格）
```

代码里两件事都不成立：

1. **不生效**：`registerBuiltins` 在启动时把全局值抓成一个常量传进去
   （`pubWriteMinRole: config.memory.pubWriteMinRole`），`memory_write` 的 `execute` 用的是
   `dependencies.pubWriteMinRole`，**从不读 `context.turn.config`**。而 `turn.config` 正是
   `perChatConfig()` 合并过的那一份。于是 `PATCH /api/chats/:key {"memory":{"pubWriteMinRole":"limited"}}`
   会通过校验、落库、进 `turn.config`，然后被彻底忽略。
2. **「只允许更严格」不存在**：`configSchema` 的 `superRefine` 只检查路径在不在白名单里，
   没有任何地方比较 perChat 值与全局值的 `roleRank`。

**为什么它比一般的「配了不生效」更值得单列**：PUBMEMORY 是**全局单一份**文档（决策 D12），
所有会话共享。一个「按会话放宽写入门槛」的旋钮，语义上就是「在 A 群里给 limited 用户开一个
写全局记忆的口子」——它现在恰好是死的，但白名单允许它、文档承诺它、校验器不拦它。
这与 `docs/11 §2.1` 开头「避免出现『某个群单独关掉了权限检查』这类危险配置」的立意直接冲突。

**修复**：

1. `memory_write` 改读 `(context.turn.config as Config).memory.pubWriteMinRole`，与
   `tgLimits(context)`（`builtins.ts:36`）已经用过的手法一致。
2. `superRefine` 补一条：`perChat.*.memory.pubWriteMinRole` 的 `roleRank` 必须 ≥ 全局值，
   否则 `addIssue`。**这条约束是文档已经承诺的，补它不算加需求。**
3. 顺带自查同类：目前 `turn.config` 里合并了、但运行时读全局快照的还有
   `tools.fs.*`（`filesFor` 闭包捕获）——它不在 perChat 白名单里，所以没有安全影响，
   但同样值得在 doc 11 里标清楚。

---

### D-MEDIA-01 · P2 · 图片以 base64 直接进上下文并被持久化，每一轮全量重传

**位置**：`packages/telegram/src/media.ts:72` · `packages/db/src/context.ts:154-168`

```ts
if (file.kind === 'photo') return [{ type: 'file', data: readFileSync(localPath).toString('base64'), mediaType: 'image/jpeg' }];
```

这个 part 会被存进**两张表**：`messages.media_parts_json`（归档）与 `context_messages.parts_json`
（上下文），并在此后**每一轮**物化时读出、经 `contextMessages()` 原样发给 provider，
直到它滚出窗口。

一张 1568px 长边、q85 的 JPEG 大约 200–500 KB，base64 后 270–670 KB。默认
`context.limit.maxMessages=200`，一个聊图的群里窗口里挂三五张图很正常：

- 每一轮的请求体多出 1–3 MB（上行带宽 + 序列化 + `estimateStructureTokens` 遍历）；
- SQLite 里同一份 base64 存两遍，`context_messages` 表迅速膨胀，`materialize()` 的
  `structuredClone` 缓存（64 条）也跟着吃内存；
- `hardTruncateLargest` 对不透明 part 的策略是「整体保留或整体换占位」（这是对的，
  见 `docs/02` 不变量），所以裁剪时它们要么全在、要么全没，中间没有档位。

**修复方向**（这是设计取舍，不是 bug，但现在的取舍代价被低估了）：
part 里只存 `{ type:'file', ref:'attachment://<id>', mediaType }`，在 `contextMessages()`
读出时按需 `readFileSync` 重新水化。好处是库不再存 base64、`/api/chats/:key/context`
不再返回 MB 级 JSON；代价是物化多一次磁盘读（有 `#cache` 兜着）。
若维持现状，至少在 `docs/02` 与 `docs/08 §7` 里把「每轮重传」这件事写清楚。

---

### D-LOG-01 · P2 · 逐条 `appendFileSync` 写日志，与 doc 10 承诺的缓冲写相反

**位置**：`packages/core/src/log/sink.ts:126-134` · 承诺见 `docs/10-logging-and-observability.md:132`

doc 10：「写入用**追加流 + 每 200ms 或 64KB flush**，避免每条 fsync。」

实现：每一条事件都做 `existsSync` + `statSync`（轮转检查）+ `appendFileSync`，**同步、逐条**。
`model.call` 的 span 在 `captureBodies=true`（默认）时带着整个请求体——单条几百 KB 的同步写盘，
落在 `onStepEnd` 这个热路径上。一次工具风暴（`maxCallsPerTurn=40`）就是 40+ 次同步写。

代码里有一条注释解释了同步的理由（`main.ts:264`：「LogSink 是 appendFileSync，写得完」——
为了保证 crash 之前那一条能落盘）。这个理由对 `system.crash` 那一条成立，对其余 99.9% 的事件不成立。

**修复**：常规事件走缓冲流（`createWriteStream` + 200 ms/64 KB flush，如 doc 10 所写），
只有 `level==='error'` 或 `kind==='system.crash'` 走同步路径。轮转检查改成按累计字节数计数，
不要每条 `statSync`。

---

### D-OPS-01 · P2 · 定时任务抛一次异常就杀掉整个进程

**位置**：`packages/core/src/scheduler.ts:6-10` · `apps/bot/src/main.ts:265-272`

```ts
add(expression, task, name) {
  const invoke = async (): Promise<void> => { await task(); };
  const cron = new Cron(expression, { protect: true }, invoke);   // ← 没有 catch 选项
}
```

croner 的 `catch` 默认 `false`（`croner.cjs`：`s.catch = s.catch===void 0 ? !1 : s.catch`），
此时 `_trigger()` 直接 `await this.fn(...)`，而 `_checkTrigger` 调它时既不 `await` 也不 `.catch()`
——任务抛出 = **unhandledRejection**。而 `main.ts` 把 `unhandledRejection` 接成了 `process.exit(1)`。

**实测（PROBE-4）**：

```
UNHANDLED REJECTION -> Error: maintenance blew up
```

**可达路径**（全部注册在 `main.ts:92-96`）：

| 任务 | 可能抛什么 |
|---|---|
| `maintenance.vacuum()`（每周日 05:00） | `SQLITE_BUSY`、`cannot VACUUM from within a transaction` |
| `maintenance.cleanup()`（每天 04:00） | 磁盘/权限问题；`checkpoint()` 的 `SQLITE_BUSY` |
| `mcp.reconcile()`（每 5 分钟） | 每台 server 的错误各自 catch 了，但 `unregisterBySource` / `registerExternal` / `jsonSchemaToZod` 抛出不在 catch 里 |
| `modelRegistry.rebuild()`（每 10 分钟） | `providers.key()` 解密失败（换过 `LUOLI_MASTER_KEY`）、`JSON.parse(headers)` |

也就是说：**换过主密钥的实例，每 10 分钟自杀一次**；`mcp.enabled` 打开且某台 server 的
`inputSchema` 触发转换异常，每 5 分钟自杀一次。

**修复**：`Scheduler.add` 里把 `invoke` 包严：

```ts
const invoke = async (): Promise<void> => {
  try { await task(); }
  catch (error) { this.onError?.(name, error); }     // main.ts 注入 log.event({level:'error', kind:'scheduler.failed'})
};
```

顺带把 croner 的 `catch: true` 也带上（双保险，且 croner 自己的内部异常也能兜住）。
`main.ts` 的 `unhandledRejection → exit(1)` 保持不变——它是最后一道网，不该被日常的任务失败触发。

---

### D-OPS-02 · P2 · 只要有一个 WebUI 标签页开着，SIGTERM 就退不出去

**位置**：`packages/server/src/app.ts:1002`（SSE）· `apps/bot/src/main.ts:241-259`（`shutdown`）

```ts
const heartbeat = setInterval(() => controller.enqueue(encoder.encode(': ping\n\n')), 20_000);
ctx.req.raw.signal.addEventListener('abort', () => { clearInterval(heartbeat); unsubscribe(); controller.close(); }, { once: true });
```

`heartbeat` **没有 `unref()`**，且只在**客户端主动断开**时才被清掉。`shutdown()` 这边：

```ts
http.close();                    // 不 await，也不销毁已有连接
…
process.exitCode = 0;            // 事件循环非空时这句不会让进程退出
```

`http.close()` 只是停止接受新连接；已建立的 SSE 长连接不会被关，20 秒一次的定时器把事件循环
一直撑着。结果：`systemd` 等到 `TimeoutStopSec` → `SIGKILL` → 下次启动 `recoverAfterCrash`
把在途轮次全记成 `process_restarted`。**每一次部署都变成一次「崩溃恢复」**，
而 `turnRegistry.drain(graceMs)` 精心设计的优雅退出被完全绕过。

**修复**（三处，都很小）：

1. `heartbeat.unref()`；
2. 服务器持有一个活跃 SSE 控制器集合，`shutdown()` 时逐个 `controller.close()`；
3. `shutdown()` 里 `await new Promise(r => http.close(r))`，并在 `graceMs` 之后
   `http.closeAllConnections?.()` 兜底。

---

### D-EVENT-01 · P2 · `EventBus.emit` 不隔离订阅者异常，且用的是默认 maxListeners

**位置**：`packages/core/src/events.ts:8-15`

```ts
emit(type: string, data: unknown): void {
  this.#emitter.emit('event', { type, data, at: Date.now() });   // 同步派发，无 try/catch
}
```

`EventEmitter.emit` 是同步的，任何一个订阅者抛出都会**沿调用栈原样传回发射方**。发射方包括
`QuotaGuard.commit`（在 `onStepEnd` 里，每一步模型调用后）、`LogSink.publish`、
`config.changed`、`approval.*`。订阅方主要是 SSE 的 `controller.enqueue`——流被关闭或
内部队列出错时它会抛 `TypeError: Invalid state`。

于是一个前端连接的异常状态，可以让**一次记账**抛出，进而把整轮打成 failed。
现有代码在 `abort` 时的顺序是对的（先 `unsubscribe()` 再 `close()`），但 `ReadableStream`
的 `cancel()` 路径没有处理器，靠的是「@hono/node-server 一定会触发 abort」这个假设。

另外 `EventEmitter` 默认 `maxListeners=10`：**第 11 个 WebUI 标签页**就会开始刷
`MaxListenersExceededWarning`，并且看起来像内存泄漏告警。

**修复**：

```ts
emit(type: string, data: unknown): void {
  for (const listener of this.#listeners) {
    try { listener({ type, data, at: Date.now() }); }
    catch (error) { this.#onListenerError?.(error); }    // 一个瞎了不能带走其他人
  }
}
```

（用一个 `Set` 自己派发比 `EventEmitter` 更直接，顺带消掉 maxListeners 的问题。）
SSE 那边补一个 `cancel()` 处理器，与 `abort` 走同一段清理。

---

### D-TOOL-01 · P2 · skill 与子 agent 的工具白名单只在目录层过滤，`execute()` 不复查

**位置**：`packages/core/src/tools/registry.ts:105-118`（`active` 的 `allow` 参数）· `131-176`（`execute`）

第五轮的 `W-TOOL-01` 把 `available?.()` 与 `agentKind==='sub' && memory_write` 补进了 `execute()`，
方向对。但 `active()` 的过滤集合里还有**两条**没有对应的复查：

| 过滤条件 | `active()` | `execute()` |
|---|---|---|
| `roleRank` / `disabledByOperator` / `state.disabled` | ✅ | ✅ |
| `available?.()` | ✅ | ✅（第五轮补） |
| `agentKind==='sub' && memory_write` | ✅ | ✅（第五轮补） |
| **`allow`（子 agent 的 `definition.tools`）** | ✅ `subagent.ts:42` 传入 | ❌ |
| **`turn.skillAllowedTools`（skill 的 `allowed-tools`）** | ✅ `runtime.ts:362-363` 过滤 | ❌ |

目前不可利用：两者都通过 AI SDK 的 `activeTools` 生效，模型请求目录外的工具会被 SDK 挡成
`NoSuchToolError`。但这与 `W-TOOL-01` 的处置理由一字不差——**「目前恰好挡得住，但那是巧合不是设计」**。
`docs/05 §234` 的「单一数据源」要求两侧一致。

**修复**：把 `allow` 与 `skillAllowedTools` 一起塞进 `ToolExecutionContext`，
`execute()` 开头复查一次，返回 `tool_not_in_allowlist`。

---

### D-ROLE-01 · P3 · `/grant` `/revoke` `/whois` 绕过有效角色，只看用户角色

**位置**：`packages/telegram/src/bot.ts:161-171, 227-242`

其余 13 个命令都走 `requireRole(update_id, minRole, reply)`，它读的是 `ingress` 里那份
`effectiveRole = min(userRole, chatRole)`（决策 D9）。这三个**发放权限**的命令却是自己写的：

```ts
const actor = dependencies.principals.roleOf('user', String(ctx.from?.id ?? ''));
if (actor !== 'owner') { await ctx.reply('权限不足。'); return; }
```

于是 owner 在一个 `chat` 角色被降到 `trusted` / `limited` 的群里，仍然可以 `/grant`。

**不可利用**（owner 就是 owner，权限没有被放大），但它是整个代码库里**唯一一处**把
`effective = min(user, chat)` 这条不变量写了第二遍的地方——而这正是 `docs/20 §9` 第 7 条表扬
`checkWakeword` 时说的那件事（「分成两份会漂移」）。同一个教训在唤醒词上学会了，
在这三个命令上还没有。而且语义上说不通：把某个群的角色降下来，本意就包含「不在这个群里做管理操作」。

**修复**：三个命令改走 `requireRole(ctx.update.update_id, 'owner', …)`。
`COMMANDS` 表里它们的 `minRole` 已经写了 `owner`，改完两处就一致了。

---

### D-UI-01 · P3 · `ConsoleView.vue` 是一个 2,190 行的单文件组件

**位置**：`packages/webui/src/views/ConsoleView.vue`

`docs/09 §3` 描述了 14 个页面区块（§3.1 Dashboard … §3.13 Settings），实现里它们全在一个 SFC 里，
占 WebUI 全部代码的 77%（2190 / 2852）。

不是 bug，但它有具体代价：任何两个人同时改 WebUI 必然冲突；单个页面的状态与其余十三个共享
同一个 `setup()` 作用域，改一处的回归面是整个控制台。前端侧目前也没有任何组件级测试
（`tests/webui.console.test.ts` 测的是服务端 API，不是这个组件），拆分之前也很难加。

**修复**：按 `docs/09 §3` 的分节拆成对应的 `views/*.vue` + 一个共享的 `useConsoleData()` composable。
这件事越晚做越贵，且不影响任何运行时行为。

---

## 4. 可改进条目

> 口径：当前行为正确或影响有限，但存在明确更好的做法。按模块分组，不排优先级。

### 4.1 正确性 / 数据质量

| 编号 | 位置 | 问题 | 建议 |
|---|---|---|---|
| **I-01** | `server/app.ts:545-553` | `GET /api/messages` 非搜索分支是 `LIMIT 1000` 后**在内存里**分页：`size=50` 时第 21 页起永远是空的，`total` 最多 1000，界面上的页码是假的 | 与 `/api/turns` 一样走 SQL `LIMIT/OFFSET` + 单独 `COUNT(*)` |
| **I-02** | `ledger/quota.ts:64` | `commit()` 每次 `turns=turns+1`，而它是在**每一步模型调用**后被调用的 → `quota_counters.turns` 实际统计的是步数，配额页把它标成「轮次」 | 轮次计数移到 `reserve()`（每轮一次），或把列名/标签改成 `calls` |
| **I-03** | `tools/files.ts:50-56, 68-78, 90-97` | `list`/`glob`/`grep` 的 `walk` 对每个条目直接 `statSync`。一个**断链软链**（`bash` 一行就能造，下载失败也会留）会抛 ENOENT，让整次调用返回 `ok:false` | `statSync` 包 try/catch，跳过读不到的条目并在结果里记 `skipped: n` |
| **I-04** | `agent/runtime.ts:405` · `ledger/quota.ts:56` | `quota.commit` 在 `onStepEnd` 里同步写 6 行 `quota_counters`（3 scope × 2 window），每步一次 | 按轮次累积、在轮末一次性结算；或至少把 `RETURNING` 的 6 次单行更新合并成一条语句 |
| **I-05** | `memory/store.ts:95-133` | `flush()` 是无锁的读-改-写整份文档。两个并发轮次（不同会话）同时写 PUBMEMORY 会丢更新 | 复用 `KeyedMutex`，key 用 `${scope}:${subject}` |
| **I-06** | `server/app.ts:258-280` | `PUT /api/config` 校验用的是 `parsed.value`，**落库的是请求体原值**。zod 的默认值/强制转换不会进 `config_kv` | `write.run(key, JSON.stringify(pick(parsed.data, key)), now)` |

### 4.2 资源与性能（与 §2 的两个 P0 同源）

| 编号 | 位置 | 问题 | 建议 |
|---|---|---|---|
| **I-07** | `telegram/media.ts:83, 87, 91` | `[...readFileSync(path,'utf8')].slice(0, maxChars)` 把一份 20 MB（`media.maxDocBytes`）的文档展开成两千万元素的数组再切 | 先按字节 `subarray` 粗截到 `maxChars * 4`，再展开；PDF/DOCX 同理 |
| **I-08** | `telegram/output.ts:69-81` | `splitTelegramText` 的 `while ([...remaining].length > max)` 每轮重建整串码点数组，O(n²/max) | 循环外展开一次，之后只在数组上切 |
| **I-09** | `prompt/documents.ts:92-97`（`AgentResultStore.put`） · `telegram/media.ts:96-99` | `data/agent-results/<runId>.txt` 与 `data/files/**` 的附件**永不清理** | `MaintenanceService.cleanup()` 按 `agent_runs.finished_at` / `attachments.created_at` 一并清；`POST /api/maintenance/gc-files` 别再返回 `not_implemented`（见 `V-LOG-01`，同一个批次做） |
| **I-10** | `tools/registry.ts:177` | `releaseTurn` 只在 `bot.ts:420` 被调用。WebUI 的 agent 试跑（`dryRunAgent`）与提示词预览走的也是 `#state(turnId)`，各留一条永不释放的记录 | `dryRunAgent` 的 `finally` 里补 `toolRegistry.releaseTurn(run.turnId)` |
| **I-11** | `sandbox/index.ts:149-150` | `chunk.toString()` 按 chunk 边界解码，多字节字符会被切坏（与 `V-DOS-02` 同一处） | 用 `StringDecoder` |

### 4.3 安全加固（不构成漏洞，但值得收紧）

| 编号 | 位置 | 问题 | 建议 |
|---|---|---|---|
| **I-12** | `server/app.ts:151` | CSP 缺 `object-src 'none'`、`base-uri 'self'`、`form-action 'self'`；`frame-ancestors` 靠的是 `X-Frame-Options`（已过时但仍有效） | 补齐三条指令，并把 `frame-ancestors 'none'` 也写进 CSP |
| **I-13** | `server/app.ts:1004-1005` | `app.get('*')` 兜底，导致**未匹配的 `/api/*`** 返回 200 + `index.html` 而不是 404 JSON。前端 `api()` 会在 `response.json()` 处抛 SyntaxError，报错信息与真实原因无关 | 在静态兜底之前加 `app.all('/api/*', () => 404 JSON)` |
| **I-14** | `provider/catalog.ts` · `tools/web.ts` · `provider/model-catalog.ts` | 三条出网路径各写各的超时、重定向与地址策略（见 `V-SSRF-01`） | 统一到 `net/outbound.ts`，一处策略三处复用；新增出网点时不会再漏 |

---

## 5. 修复批次

### X0 · 止血（约 1.5 人日）

| # | 改动 | 对应 | 备注 |
|---|---|---|---|
| 1 | `grep` 换线性时间引擎或移进 worker + 硬超时；`checkWakeword` 同步处理 | `V-DOS-01` | **优先于其他一切**。附带 §6 那条「有 CPU 上界」的断言 |
| 2 | 沙箱 stdout/stderr 边收边截，超限即 kill | `V-DOS-02` | 一处改动，约 10 行 |
| 3 | `resolveResource` 加 role 判定 | `V-SKILL-01` | 3 行 + 一条回归用例 |
| 4 | `passwordHash` 现读 + `POST /api/auth/password` + 吊销旧 session | `V-AUTH-02` | 泄露后的应急处置现在是无效的 |
| 5 | `Scheduler.add` 包 try/catch + croner `catch: true` | `D-OPS-01` | 换过主密钥的实例目前每 10 分钟自杀一次 |

### X1 · 收口（约 2.5 人日）

| # | 改动 | 对应 |
|---|---|---|
| 6 | 登录限速改按可信跳数取 IP + 全局桶 + `failures` 上限 | `V-AUTH-01` |
| 7 | Plugin 发现登记（`INSERT … ON CONFLICT DO NOTHING`）+ `PATCH` 404 + 三个未接线 hook 二选一 | `D-PLUGIN-01` |
| 8 | 子 agent 接上 `perTurn.maxSteps` 与成本闸门 | `D-QUOTA-01` |
| 9 | 流式渲染挪到节流之后 | `D-STREAM-01` |
| 10 | 审批：无裁决通道时当场拒绝（或补 Telegram inline keyboard），发起人必须立刻收到回执 | `D-APPR-01` |
| 11 | `memory_write` 读 `turn.config` + `superRefine` 补「只允许更严格」 | `D-CFG-01` |
| 12 | 日志目录清理 + `LogSink` 写盘包 try/catch + 缓冲写 | `V-LOG-01` `D-LOG-01` |
| 13 | SSE `unref` + 关停时主动断连 + `EventBus` 隔离订阅者异常 | `D-OPS-02` `D-EVENT-01` |

### X2 · 加固与整理（约 2 人日）

| # | 改动 | 对应 |
|---|---|---|
| 14 | `net/outbound.ts` 统一出网守卫（含 `redirect:'manual'` 与保留段补全） | `V-SSRF-01` `V-NET-01` `I-14` |
| 15 | provider key 进日志脱敏名单 | `V-LOG-02` |
| 16 | `/ping` 收敛为不含聚合数据 | `V-INFO-01` |
| 17 | `execute()` 复查 `allow` 与 `skillAllowedTools` | `D-TOOL-01` |
| 18 | JSON 解析剔除 `__proto__` 键 | `V-CFG-01` |
| 19 | 三个权限命令改走 `requireRole` | `D-ROLE-01` |
| 20 | §4 的 14 条可改进项 | `I-01`…`I-14` |
| 21 | `ConsoleView.vue` 按路由拆分 | `D-UI-01` |

---

## 6. 结构性建议：给资源画上界，而不是给形状列黑名单

第五轮的建议是「不变量要从下游契约推导」，已经落地成 `tests/context.contract.test.ts` 那一组
跨边界用例，效果实打实——本轮上下文引擎与模型链路**零新缺陷**。

本轮的两个 P0 说明还缺一层。它们不在任何一个「边界」上，而在**同一段代码自己的资源消耗**上：

| 位置 | 写了什么限制 | 限制的是什么 | 漏了什么 |
|---|---|---|---|
| `safeRegex` | 四类危险正则的形状 | 我认识的坏模式 | 这次匹配最多跑多久 |
| `Sandbox.run` | `maxOutputBytes` | 子进程**结束后**的输出长度 | 运行期间我最多接收多少字节 |
| `TelegramOutput.consume` | `intervalMs` / `minDeltaChars` | 编辑**动作**的频率 | 渲染这段文本最多花多少 CPU |
| `MaintenanceService.cleanup` | `retentionDays` | 数据库**行数** | 磁盘上的字节 |

四处的共同点：**限制的量与「这段代码会占用多少资源」不是同一个量。**

落地成本很低，且能一次性锁死这一整类：

```ts
// tests/resource-bounds.test.ts —— 断言的是上界，不是形状
describe('外部输入进入循环/递归的地方都有资源上界', () => {
  it.each([
    ['grep 任意合法模式',   () => files.grep('(.|.)*$', '.'),                      { ms: 1000 }],
    ['sandbox 无限输出',    () => sandbox.run('yes', 'owner', ws, signal, 3000),   { ms: 5000, heapMb: 64 }],
    ['流式渲染 40KB 回答',  () => consumeStream(chunksOf(bigAnswer, 20)),          { ms: 500 }],
    ['文档提取 20MB 文本',  () => media.process(bigTxtMessage, row),               { heapMb: 128 }],
  ])('%s', async (_name, run, bound) => {
    const before = process.memoryUsage().heapUsed;
    const started = performance.now();
    await run();
    if (bound.ms) expect(performance.now() - started).toBeLessThan(bound.ms);
    if (bound.heapMb) expect((process.memoryUsage().heapUsed - before) / 1e6).toBeLessThan(bound.heapMb);
  });
});
```

这一组用例的价值不在于精确的阈值（阈值可以放宽到 10 倍），而在于**它对模式一无所知**：
下一个 `(a|ab)*c`、下一个 `cat /dev/urandom`、下一条 O(n²) 的渲染路径，都会在同一条断言上变红。

### 6.1 与「装配」有关的第二类空白

`D-PLUGIN-01`、`V-LOG-01`、`D-OPS-02` 三条各自属于不同模块，但形状一致：

> **单元测试证明了模块能工作，没有任何测试证明它在真实进程里被接上了。**
> `plugin.runtime.test.ts` 自己 INSERT 了那行数据；日志保留没有任何测试；
> SIGTERM 退出路径没有任何测试。

建议加一组「装配契约」用例（可以跑在 `pnpm smoke` 里，它已经拉起了全链路）：

- 往 `plugins/` 放一个文件、**不碰数据库**，断言它出现在 `GET /api/plugins` 里；
- 造一个 31 天前的 `logs/2026-07-17/` 目录，跑 `cleanup()`，断言它没了；
- 起进程 → 建一个 SSE 连接 → `SIGTERM` → 断言进程在 `graceMs + 1s` 内退出。

---

## 7. 文档侧

| 项 | 状态 |
|---|---|
| [02](./02-context-engine.md) 不变量清单（含第 15 条 role） | ✅ 第五轮已补，写入/读出两侧都在位 |
| [05 §6](./05-tools-and-permissions.md) 审批流 | ⚠️ 文档已诚实标「Telegram 未实现」，但**没有描述 180 秒干等**这个实际行为（`D-APPR-01`） |
| [03 §保留策略](./03-data-model.md) `logs/*.jsonl` 超期删除 | ❌ 未实现（`V-LOG-01`）。要么实现，要么把那两行改成 🚧 |
| [10](./10-logging-and-observability.md) 「追加流 + 200ms/64KB flush」 | ❌ 实现是逐条 `appendFileSync`（`D-LOG-01`） |
| [10](./10-logging-and-observability.md) 脱敏含「provider key 解密后的明文」 | ❌ 未接线（`V-LOG-02`） |
| [07 §3.2/3.3](./07-skills-plugins-mcp.md) Plugin 安装与 hook 表 | ❌ 安装链路不存在；`onToolCall`/`onToolResult`/`beforeSend` 从未被调用（`D-PLUGIN-01`） |
| [11 §2.1](./11-config-reference.md) `memory.pubWriteMinRole（只允许比全局更严格）` | ❌ 既不生效也没有「更严格」的校验（`D-CFG-01`）。同一份清单里 `character` 标了 🚧，这一条也该有归属 |
| [09 §2.1](./09-webui.md) 口令管理 | ❌ 没有改口令的通路，且写进配置无效（`V-AUTH-02`）。文档也没说「改完要重启」 |
| [13](./13-acceptance-criteria.md) 验收条目 | ⚠️ 自第二轮起未更新；`W-*` / 本轮 `V-*` `D-*` 对应的 AC 需要补 |
| [21](./21-webui-coverage-gaps.md) WebUI 覆盖缺口 | ⚠️ 口径是「运行时有、界面够不着」，因此 `D-PLUGIN-01` 不在它的口径内（运行时也没有）。建议在 §5「不是缺口」里加一行指向本文 |

---

## 8. 本轮确认做得好的地方

1. **第五轮 24 项里 23 项是根因修复。** `aliasModel()` 把 fallback 包装挪到「按别名解析」层
   而不是在 `prepareStep` 里打补丁；`onServed` 这一份报告根本没提，是修的人自己看出
   「包装之后 `step.model.modelId` 恒等于链首」才补的。
2. **`tests/context.contract.test.ts` 这类跨边界用例真的奏效了。** 上下文引擎与模型链路
   本轮零新缺陷，是六轮里第一次。
3. **`untrusted()` 与 `web_fetch` 的 SSRF 防护依然是全仓库最扎实的一段。** 自定义 `lookup`
   钉死已校验 IP、保留 `Host` 与 `servername`、每次重定向重新校验——本轮找出的
   `V-SSRF-01` 恰恰是「另外两条出网路径没有向它看齐」。
4. **`db/src/config.ts` 顶部关于 `config_kv` / `app_kv` 命名空间分离的注释**，
   以及 `archiveQuery` 关于中文两字词退回 LIKE 的注释，仍然是本仓库注释风格的范本：
   解释的都是读代码看不出来的「为什么」。
5. **`assertValidShape` 在三个出入口都跑 + `0006` 迁移清历史数据**——修 `W-CTX-01` 时
   同时处理了「新数据不再产生」和「老数据已经在库里」两件事，很多项目只做前一半。
6. **失败文案分类（`failureText`）与 `sendWithFallback` 的降级重试**：把「上游挂了」
   「模型没配」「缺定价」「没吐正文」分开讲，并且两条投递路径共用同一份降级逻辑。
7. **`HANDLED_COMMANDS` ↔ `COMMANDS` ↔ `bot.command()` 三方由测试钉死**——`W-TG-01` 修完
   顺手把「同一份知识写在三处」变成了编译期/测试期约束，这正是 `D-ROLE-01` 还缺的那一步。

---

## 9. 一句话总结

第五轮的 24 项关闭了 23 项且修得扎实，上下文引擎与模型链路已经稳了；本轮把审查推到
**「这段代码最多能吃掉多少 CPU / 内存 / 磁盘」**这个维度，两个 P0 都落在这里——
其中 `V-DOS-01` 的触发条件是「一个 `limited` 用户调一次 `grep`」，后果是**整个进程冻住至少
105 秒（实测），且没有任何现有机制能中断**。建议 `V-DOS-01`、`V-DOS-02` 优先于其他一切处理，
并把 §6 那组「资源上界」断言一起加上——否则下一轮还会在同一个缝里发现新的东西。

第二条值得记住的是 `D-PLUGIN-01`：一个有文档、有 SDK、有测试、有 WebUI 页面的子系统，
**在真实部署里从来没有可能被启用过**，因为没有任何代码往 `plugins` 表里写第一行。
测试全绿不等于链路接上了——这是第五轮教训在「我们自己的两段代码之间」的复现。
