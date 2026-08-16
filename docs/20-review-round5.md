# 20 · 复审报告（第五轮）

> 复审对象：`docs/19-review-round4.md` 第四轮整改后的实现（HEAD = `fffdcc3`）
> 基线：`pnpm typecheck` 通过；`pnpm test` **43 个文件 / 134 个用例全部通过**（上一轮 38 / 98）
> 方法：全量重读源码 → 针对性可运行探针（PROBE-A…E）→ 清理探针 → 复原绿基线
> 标记：★ = 已用可运行的探针实测确认，非仅代码推断

---

## 0.0 整改状态（本轮已全部关闭）

> 3 个 P0 / 6 个 P1 / 17 条 P2 全部按根因修复；`pnpm typecheck` 通过，`pnpm test` **46 文件 / 156 用例**
> （修复前 43 / 134）。新增的三类用例都**跨过了「我们的代码 → 外部依赖」那一跳**，也就是本轮
> 三个 P0 共同的缝：`tests/context.contract.test.ts`（上下文 → AI SDK，8 个场景 + 历史坏数据兜底）、
> `tests/media.test.ts`（真 JPEG → sharp → image part）、`tests/agent.model-wiring.test.ts`
> （`prepareStep` 存在时 fallback / 重试 / 记账是否还生效，含子 agent 配额）。三者都验证过
> **回退修复能让用例变红**。

需要记录的两个口径变化（超出报告建议，由需求方拍板）：

1. **`W-APPR-01` 选了「摘除」而不是「实现」**，且比报告的方案 2 更进一步：不是「保留 180 秒等待 +
   给发起人回执」，而是**代码层面当场拒绝**，把原因作为 `hint` 交给模型，由它用自己的话（守着人设）
   告诉用户。审批记录仍写 `approvals` 供审计。`approval.ttlMs` 因此进 `KNOWN_UNIMPLEMENTED_CONFIG_KEYS`。
2. **`W-SEC-02` 选了 scrypt + 密文版本化**：新写入用 `v2.<salt>.<iv>.<ct>.<tag>`（scrypt，salt 随密文存），
   v1 密文继续可解，`ProviderStore.key()` 读到 v1 就地重写成 v2 —— 不需要迁移脚本，也不会让
   已有的 provider key 变成解不开的垃圾。

`W-TG-01` 的三条按报告的「二选一」逐条落地：补 `/start` `/help` `/whois` handler；`/ask` 按 doc 08
的语义改成真触发（新增 `TriggerReason: 'ask'`）；`/webui` 从白名单摘除并在 doc 08 / doc 09 §2.3 标 🚧。

`W-CFG-02` 做了报告建议的 1+2+3：doc 11 重标（`concurrency.perKey/global/queueMax/mode`、
`memory.pubWriteMinRole/softLimitTokens/hardLimitTokens/maxSections`、`agent.maxDepth/maxSubagentsPerTurn`
改回 `需重启`；`general.name` 运行时压根没接线，改标 🚧）；`Sandbox` / `DatabaseApprovalBroker` /
`ToolRegistry`（limits + rules）/ `McpManager` 全部改吃 getter；`GET /api/config/schema` 带上
`hotReloadable` 与 `unimplemented` 前缀表。新增 CI 断言：doc 11 里标 `热更新` 的每个键都必须落在
`HOT_RELOADABLE_CONFIG_KEYS` 白名单里（或已标 🚧），改动时被迫更新白名单。

---

## 0. 结论速览

| 项 | 结论 |
|---|---|
| 第四轮 3 个 P0 | **3/3 全部修复**，且都照根因改 |
| 第四轮 4 个 P1 / 5 个 P2 | **9/9 全部修复** |
| 新增 P0 | **3 项**（`W-CTX-01`、`W-AGENT-01`、`W-MEDIA-01`），全部 ★实测 |
| 新增 P1 | 6 项（2 项 ★实测） |
| 新增 P2 | 15 项 |
| 本轮高发区 | **「构造好的对象从来没被真正喂给下游」**——上下文喂给 AI SDK、图片喂给 sharp、fallback 模型喂给 ToolLoopAgent、MCP schema 喂给 registry，四条链路都在最后一跳断掉 |
| 测试基线 | 用例数从 98 涨到 134，是四轮里增幅最大的一次；但**没有任何一个用例把引擎产出的上下文真的交给 `ToolLoopAgent`**，三个 P0 全部落在这个缝里 |

### 0.1 本轮最重要的一条

**任何一次 `load_skill`、任何一次群聊消息积压、任何一次在途轮次期间的 `/new`，都会让该会话此后每一轮都失败。**

`contextMessages()`（`runtime.ts:165`）把上下文消息原样映射成 `ModelMessage`，包括 `role: 'system'` 的 note。而 AI SDK v7 的 `standardizePrompt` 在 `allowSystemInMessages` 未开启时**直接拒绝 messages 里出现任何 system 消息**：

```
AI_InvalidPromptError: Invalid prompt: System messages are not allowed in the prompt
or messages fields. Use the instructions option instead.
```

代码里有 **4 个** 地方会产生 `role: 'system'` 的上下文消息，其中 3 个会被提交进库、在**之后每一轮**重放。`assertValidShape` 检查 part type 和 tool-call 配对，**但不检查 role**，所以写入侧和读出侧都放行。

### 0.2 递归模式的变化

前四轮的模式是「同一个不变量，写入方绕过了校验器」。本轮不同：

| 轮次 | 模式 |
|---|---|
| 一→三 | 上下文引擎连环：修一个缺陷激活一条休眠代码路径 |
| 四 | 配置持久化层：命名空间有校验器，但存在不走校验器的写入方 |
| **五** | **边界的另一侧从来没被联调过**：本进程内构造得很仔细的对象，交给外部依赖（AI SDK / sharp / MCP registry）时形状对不上，而没有任何测试跨过这个交接点 |

三个 P0 的形状完全一致：

> 模块 A 认真地构造了一个对象并做了自洽的断言，模块 B（外部库）有它自己的契约，**没有任何测试同时经过 A 和 B**。

`assertValidShape` 是 A 侧的断言，它检查的是「我认为的合法形状」；AI SDK 的 `standardizePrompt` 是 B 侧的契约。四轮以来上下文引擎的不变量做得越来越好，但**不变量集合是自定义的，不是从下游契约推导出来的**——这正是 `W-CTX-01` 能活到第五轮的原因（见 §5 结构性建议）。

---

## 1. 第四轮发现的复验结果

### 1.1 P0（3/3 已修复）

| 项 | 状态 | 证据 |
|---|---|---|
| **R-CFG-01** `/model` 写坏启动配置 | ✅ 已修复 | `0005_app_kv.sql` + `readAppKv`/`writeAppKv`（`db/src/config.ts`）；`bot.ts:164` 改写 `app_kv`；`loadConfig`（`config/index.ts:102-107`）逐条剔除非法路径后重试，`removeOverridePath` 顺带清空变空的父节点；`main.ts:22-28` 把被丢弃的键与清理 SQL 打进 stderr |
| **R-CFG-02** `PATCH /api/chats/:key` 绕过白名单 | ✅ 已修复 | `app.ts:231` 走 `runtimeConfigSchema.safeParse`；读取端 `perChatConfig()`（`config/index.ts:59`）已接线，`bot.ts:95`（触发判定）、`bot.ts:299`（openTurn）、`main.ts` 的 `onTurn` 三处都用上了 |
| **R-CTX-01** 硬截断毁掉 `part.type` | ✅ 已修复 | `STRUCTURAL_PART_KEYS`（`db/src/context.ts:272`）跳过判别字段；`OPAQUE_PART_TYPES`（275）整体保留或整体降级；`KNOWN_PART_TYPES`（`engine.ts:30`）白名单在 `openTurn`/`materialize`/`commitTurn` 三处断言 |

### 1.2 P1 / P2（9/9 已修复）

| 项 | 状态 | 说明 |
|---|---|---|
| **R-TG-01** 非法时区 | ✅ | `ianaTimezone`（`schema.ts:6`）+ `formatClock`（`engine.ts:63`）双保险 |
| **R-BOT-01** 异常路径泄漏并发槽 | ✅ | `bot.ts:297-312` 把 `openTurn`/`turns.create` 并入 try，catch 里释放 `release`/`reservation`/`pendingId`；`openTurn` 内部（`engine.ts:104-110`）抛出时 `releaseClaims` |
| **R-API-01** `tools.overrides` 假成功 | ✅ | schema 加 `tools.overrides`（`schema.ts:132`）；`bindOverrides` + `active()` 过滤 + `execute()` 硬拦截（`registry.ts:52,84,120`） |
| **R-CFG-03** CI 断言过弱 | ✅ | 路径级引用检测；`telegram.mode` 非 polling 显式抛错（`main.ts`） |
| **R-MEM-01 / R-TG-02 / R-API-02 / R-TOOL-01 / R-DOC-01** | ✅ | 逐条核对过，改动都在位（`store.ts:113-119`、`stream-output.ts:52-55`、`app.ts:73-76`、`builtins.ts:105-108`、doc 03） |

**没有一条是打补丁式修复。** `perChatConfig` 补上读取端、`releaseClaims` 补上 `openTurn` 内部路径，都超出了报告要求的最小改动。

---

## 2. 新增 P0（阻断验收）

### W-CTX-01 ★实测 · 上下文里的 `role:'system'` 消息让整轮请求被 AI SDK 拒收

**位置**：`packages/core/src/agent/runtime.ts:165-170`（`contextMessages`）
**注入点**：`core/src/context/engine.ts:120` · `core/src/tools/builtins.ts:70` · `db/src/context.ts:149` · `db/src/context.ts:150`

**现状**：`contextMessages()` 把每条上下文消息直接映射成 `{ role, content: parts }`：

```ts
export function contextMessages(turn: RuntimeTurnContext): ModelMessage[] {
  return [...turn.snapshot.messages, ...turn.delta].map((message) => ({
    role: message.role,                       // ← 'system' 原样传下去
    content: (message.parts as …).map(…),     // ← system 消息的 content 必须是 string，这里是数组
  } as ModelMessage));
}
```

AI SDK v7.0.65 的 `standardizePrompt`（`node_modules/ai/dist/index.js:2581`）有两道卡：

```js
if (!allowSystemInMessages && messages.some((m) => m.role === "system")) throw new InvalidPromptError2({…});
// systemModelMessageSchema = z.object({ role: z.literal("system"), content: z.string(), … })
```

`ToolLoopAgent` 的 `allowSystemInMessages` 从 settings 透传，`runtime.ts:261` 与 `subagent.ts:28` **都没有设置它**，默认 `false`。

**实测（PROBE-A，直接调 `ToolLoopAgent.generate`）**：

```
PROBE-A contextMessages = [{"role":"system","content":[{"type":"text","text":"（本轮省略了 3 条…）"}]},{"role":"user",…}]
PROBE-A generate  = THROWS AI_InvalidPromptError: System messages are not allowed in the prompt or messages fields.
PROBE-A baseline（去掉 system 那条）= OK text=ok
PROBE-A2 allowSystemInMessages=true + 数组 content = THROWS AI_InvalidPromptError: The messages do not match the ModelMessage[] schema.
PROBE-A3 allowSystemInMessages=true + 字符串 content = OK
PROBE-A4 降级成 role:'user' = OK
```

**实测（PROBE-E，真 DB + 真 `ContextEngine` + 真 `ToolLoopAgent`）**——三个注入点各自的后果：

```
E1  load_skill 的 note（builtins.ts:70）
    turn1 committed（assertValidShape 放行了 role=system）
    turn2 roles = ["user","system","assistant","user"]
    turn2 model call = THROWS AI_InvalidPromptError …
    turn3 model call = THROWS AI_InvalidPromptError …      ← 会话级永久损坏

E2  背景消息省略提示（engine.ts:120，maxPerTurn=2、积压 5 条）
    delta roles = ["system","user","user","user"]
    model call  = THROWS AI_InvalidPromptError …           ← 当轮即失败

E3  上下文重置提示（context.ts:149，在途轮次期间 /new）
    next-turn roles = ["system","user","assistant","user"]
    model call      = THROWS AI_InvalidPromptError …       ← 会话级永久损坏
```

**影响**：

- **`load_skill` 用一次，该会话就废了。** 提示词里公开列着 skill 目录，模型自己就会调。note 被提交进 `context_messages`，之后每一轮物化都会带上它 —— `/new` 之前无法恢复。
- **群聊积压超过 `context.background.maxPerTurn`（默认 20）就永久卡死。** 失败轮次走 `abortTurn` → `releaseClaims` → 那批消息重新变成未认领、水位没推进 → 下一轮再次省略、再次插 note、再次失败。**这是一个自锁循环**，且只在群聊触发（私聊分支 `claim.omitted` 也会有，但私聊很难积压 20 条未触发消息）。
- **在途轮次期间 `/new`** → `baseInvalid` 分支无条件插 note（`context.ts:149`，不受 `injectNotice` 开关控制）→ 会话永久损坏。
- `context.rebase.injectNotice` 默认 `false`，所以第 4 个注入点（`context.ts:150`）默认不触发，但一旦运维打开就是同一颗雷。
- 症状对用户是「机器人不回复了」，对运维是 `turn.end` 里一条 `Invalid prompt: System messages are not allowed…`，**和上下文引擎看起来毫无关系**。

**修复**（两处都要改）：

1. `contextMessages()` 把 note 降级成模型能收的形状。note 的语义是「系统旁白」，降级成 `user` 最安全（PROBE-A4 已验证），也可以在 `ToolLoopAgent` 上开 `allowSystemInMessages: true` 并把 content 拍平成字符串（PROBE-A3），但那样 note 会被当成真正的 system 指令，与「内核提示词是唯一权威」冲突：

```ts
const NOTE_PREFIX = '（系统提示）';
export function contextMessages(turn: RuntimeTurnContext): ModelMessage[] {
  return [...turn.snapshot.messages, ...turn.delta].map((message) => {
    const content = (message.parts as Array<Record<string, unknown>>)
      .map((part) => part?.type === 'tool-result' ? { ...part, output: normalizeToolOutput(part.output) } : part);
    // system 只能出现在 instructions 里（AI SDK v7 契约）。note 降级成 user 文本，保留可读语义。
    if (message.role !== 'system') return { role: message.role, content } as ModelMessage;
    const text = content.map((part) => typeof part?.text === 'string' ? part.text : '').filter(Boolean).join('\n');
    return { role: 'user', content: [{ type: 'text', text: `${NOTE_PREFIX}${text}` }] } as ModelMessage;
  });
}
```

2. `assertValidShape` 补一条 role 不变量，让**产生它的那一轮**就报错，而不是等到下一轮物化：

```ts
const KNOWN_ROLES = new Set(['user', 'assistant', 'tool']);   // 注意：不含 'system'
…
if (!KNOWN_ROLES.has(message.role)) this.invalidShape(key, `role ${message.role} cannot be sent to the provider`);
```

加这条断言之前，先把 4 个注入点的 `role` 改成 `'user'`（`origin: 'note'` 保持不变，WebUI 与裁剪逻辑都按 origin 区分，不受影响）。**只改 `contextMessages` 而不改注入点也能修好，但库里已有的坏数据仍然存在**——建议同时出一条清理语句：

```sql
UPDATE context_messages SET role='user' WHERE role='system';
```

---

### W-AGENT-01 ★实测 · `prepareStep` 覆盖 `model`，整条 fallback / 重试链是死代码

**位置**：`packages/core/src/agent/runtime.ts:272`（`prepareStep`）· `runtime.ts:244`（`fallbackLanguageModel`）· `agent/fallback-model.ts`

**现状**：`ToolLoopAgent` 构造时传入的是包了中间件的 fallback 模型：

```ts
const model = fallbackLanguageModel(chain.map(…), { maxRetries, retryBaseMs, onFallback, onUnavailable, onExhausted });
const agent = new ToolLoopAgent({ model, …, prepareStep: async ({ stepNumber, messages }) => {
  …
  const patch = { activeTools: …, model: dependencies.registry.resolve(selectedAlias), …settings };  // ← 每一步都覆盖
  return patch;
} });
```

`registry.resolve()` 返回的是 `#models` 里那个**未经包装的裸模型**。`prepareStep` 无条件设置 `model`，所以构造时那个 fallback 包装从第 0 步起就再也没被用过。

**实测（PROBE-B）**：

```
PROBE-B  prepareStep 返回 model  → text = inner-direct | 中间件调用次数 = 0
PROBE-B2 prepareStep 不返回 model → text = outer        | 中间件调用次数 = 1
```

**影响**——`fallback-model.ts` 整个文件（105 行）在主 agent 路径上不生效：

- `provider.maxRetries` / `retryBaseMs` / `retryMaxMs` **完全不起作用**，上游一次 5xx 就直接失败。
- 别名的 fallback 链只有 `chain[0]` 会被用到，`onFallback` 永远不触发。第二、第三个模型配了也白配。
- `onUnavailable` → `markProviderDown` 永不触发，401/403 的 provider 不会被摘掉，`health_state` 停在 `up`。
- **`onExhausted` 永不触发 ⇒ `streamFailure` 永远是 `null`。** 而 `runtime.ts:319/323` 的
  `if (!text.trim() && streamFailure) throw streamFailure` 正是上一次提交（`7038222`、`e5cf682` 的同族修复）用来区分「上游挂了」和「模型没话说」的那一份。这个区分**现在是失效的**：上游彻底故障时 `result.text` 是空串、`streamFailure` 是 null，于是走到 `bot.ts:339` 的 `model_returned_empty`，用户收到「模型这轮没吐出任何正文」——正是那条修复想要消灭的误报。
- `subagent.ts:21` 更直接：`registry.resolve(alias)`，从来就没有 fallback 包装。

**修复**：把 fallback 包装做进「按别名解析」这一层，让 `prepareStep` 拿到的也是包装后的模型。

```ts
// runtime.ts —— 每个别名一份包装，按需缓存；prepareStep 降档到 low 时拿到的也是带 fallback 的 low
const wrapped = new Map<string, LanguageModel>();
const wrappedFor = (aliasName: string): LanguageModel => {
  const cached = wrapped.get(aliasName);
  if (cached) return cached;
  const candidates = dependencies.registry.chain(aliasName);
  const built = candidates.length
    ? fallbackLanguageModel(candidates.map((c) => ({ model: c.model, id: c.info.modelId })), fallbackOptions)
    : dependencies.registry.resolve(aliasName);
  wrapped.set(aliasName, built);
  return built;
};
const model = wrappedFor(alias);
…
patch.model = wrappedFor(selectedAlias);   // ← 而不是 registry.resolve(selectedAlias)
```

`subagent.ts` 同样处理。**回归用例**：`prepareStep` 存在时，中间件仍然被调用（PROBE-B 的形状直接可以搬进 `tests/agent.retry.test.ts`）。

---

### W-MEDIA-01 ★实测 · 每一张图片都处理失败：sharp 的输入输出是同一个文件

**位置**：`packages/telegram/src/media.ts:56-63`

**现状**：

```ts
const extension = extname(file.name ?? remote.file_path ?? '') || (file.kind === 'photo' ? '.jpg' : '.bin');
const path = join(directory, `${file.uniqueId}${extension}`);
…writeFileSync(path, …);
let localPath = path;
if (file.kind === 'photo') {
  localPath = join(directory, `${file.uniqueId}.jpg`);
  await sharp(path).rotate().resize(…).jpeg({ quality: 85 }).toFile(localPath);   // ← path === localPath
}
```

photo 分支里 `file.name` 恒为 `undefined`（`fileFrom()` 明确设了 `name: undefined`），所以 `extension` 取自 Telegram 的 `remote.file_path`，而它固定是 `photos/file_<n>.jpg` → `.jpg`。于是 `path` 与 `localPath` **总是同一个字符串**。

**实测（PROBE-D）**：

```
PROBE-D1 extname(photos/file_4.jpg) = ".jpg"
PROBE-D1 下载路径 = data/probe-d/AgADBAADqacxG.jpg | sharp 输出路径 = data/probe-d/AgADBAADqacxG.jpg | 相同 = true
PROBE-D2 同路径 toFile   = THROWS Cannot use same file for input and output
PROBE-D3 不同路径 toFile = OK
```

**影响**：

- `process()` 的 catch 吞掉异常 → `attachments.download_state='failed'` → 返回 `[{type:'text', text:'[photo 处理失败]'}]`。
- **多模态输入 100% 不可用**。模型永远看不到任何图片，只看到一句「处理失败」。
- 连带失效的还有：`vision` 别名（没有图片就永远不会被选中）、`media.maxImageEdge` / `maxImageBytes` 的缩放语义、`estimatePartTokens` 里那段按宽高估算 image token 的分支（`engine.ts:46-50`）。
- 症状极具误导性：日志里是 `[photo 处理失败]`，运维会去查 Telegram 下载、磁盘权限、sharp 安装，而真实原因是一行路径拼接。

**修复**（一行）：

```ts
const original = join(directory, `${file.uniqueId}.orig${extension}`);
writeFileSync(original, …);
let localPath = original;
if (file.kind === 'photo') {
  localPath = join(directory, `${file.uniqueId}.jpg`);
  await sharp(original).rotate().resize(…).jpeg({ quality: 85 }).toFile(localPath);
  rmSync(original, { force: true });        // 归一化之后原始文件没有保留价值
}
```

**回归用例**：造一个真 JPEG（`sharp({create:…}).jpeg().toBuffer()`），跑一遍 `process()`，断言返回的 part 是 `{type:'image'}` 而不是 `{type:'text'}`，且 `attachments.download_state='done'`。现有 43 个测试文件里**没有一个碰过 `TelegramMedia`**。

---

## 3. 新增 P1

### W-CFG-01 ★实测 · 点号路径展开没挡 `__proto__`，一次请求污染整个进程

**位置**：`packages/server/src/app.ts:57`（`mergeDotted`）· `packages/core/src/config/index.ts:65`（`dottedOverrides`）· `packages/db/src/config.ts:24`（`readPersistedConfig`）

三处是同一段「按 `.` 展开成嵌套对象」的代码，都没有屏蔽 `__proto__`：

```ts
const current = cursor[part];                                     // part === '__proto__' → Object.prototype
if (!current || typeof current !== 'object' || Array.isArray(current)) cursor[part] = {};
cursor = cursor[part] as Record<string, unknown>;                 // cursor 变成 Object.prototype
… cursor[last] = value;                                           // 写进 Object.prototype
```

**实测（PROBE-C）**：

```
C1  mergeDotted({…}, {'__proto__.LUOLI_POLLUTED':'pwned'})
    merged 自有键 = ["general"]          ← 看不出任何异常
    污染后 ({}).LUOLI_POLLUTED = "pwned"
    任意对象都继承到了            = "pwned"

C2  污染发生在校验之前 = "pwned"
    随后 safeParse = ["tools.overrides.LUOLI_POLLUTED: Expected object, received string",
                      "quota.perUser.byRole.LUOLI_POLLUTED: Expected object, received string"]

C2b 用一个能通过校验的值污染（数字 1），随后一个完全无关的合法请求
    ({}).luoliJunk = 1 | 无关的 PUT /api/config 校验 = false      ← 之后所有配置写入都 400

C3  config_kv 里存在 '__proto__.LUOLI_BOOT' 这一行
    readPersistedConfig 返回的自有键 = []
    调用之后 ({}).LUOLI_BOOT = "pwned"                            ← 每次启动都重放
```

**影响**：

- **污染发生在校验之前。** `PUT /api/config` 最终会返回 400，但那个 400 是**偶然**的：只因为 schema 里恰好有两个 `z.record` 字段（`tools.overrides`、`quota.perUser.byRole`）会枚举到继承来的键。它不是一道防线。
- **C2b 是真正的后果**：污染一旦发生，`Object.prototype` 上多出来的键会让**此后每一次** `configSchema.safeParse` 都失败 —— WebUI 的所有配置写入、以及 `config.changed` 的热重载，全部 400 / 报错。一次请求就把配置面板永久打死，只能重启。
- **C3 是更坏的分支**：如果这样一行进了 `config_kv`（当前 `PUT /api/config` 会先 400 挡住，但 `mergeDotted` 的三个调用方里只要有一个的校验放行，就会落库），启动时 `readPersistedConfig` 重放污染 → `loadConfig` 校验失败 → 第四轮加的自愈逻辑 `removeOverridePath` **拿它没办法**（它删的是 overrides 的自有属性，而污染在原型上）→ `throw parsed.error` → **进程起不来，且无法自愈**。这正是 `R-CFG-01` 那类崩溃循环换了一扇门回来。
- 触发需要已登录的 WebUI 会话（owner 级），所以不是越权，但它是一个「合法操作把系统改成不可恢复状态」的洞。

**修复**——三处共用一个守卫，并加一条 CI 断言：

```ts
const FORBIDDEN_SEGMENT = new Set(['__proto__', 'constructor', 'prototype']);
function assignDotted(root: Record<string, unknown>, key: string, value: unknown): boolean {
  const parts = key.split('.').filter(Boolean);
  if (parts.some((part) => FORBIDDEN_SEGMENT.has(part))) return false;   // 调用方记一条 config.rejected_key
  let cursor = root;
  for (const [index, part] of parts.entries()) {
    if (index === parts.length - 1) { cursor[part] = value; break; }
    const current = cursor[part];
    if (!current || typeof current !== 'object' || Array.isArray(current)) cursor[part] = Object.create(null) as Record<string, unknown>;
    cursor = cursor[part] as Record<string, unknown>;
  }
  return true;
}
```

`app.ts` 的 `PUT /api/config` / `PATCH /api/chats/:key` / `PATCH /api/tools/:name` / `PUT /api/sandbox` 全部改走它，被拒的键返回 400 `invalid_config_key`。`readPersistedConfig` 与 `dottedOverrides` 里被拒的键跳过并告警。

---

### W-CFG-02 · 标着「热更新」的配置项有一大半在启动时就冻住了

**位置**：`apps/bot/src/main.ts` 的装配段 · `docs/11-config-reference.md`

[11 §开头](./11-config-reference.md) 立下的契约是：「标 `热更新` 的项保存后立即生效（下一个 turn）；标 `需重启` 的项保存后 WebUI 显示待重启徽标。」

实际上只有三条通路是活的：`bot.ts` 的 `config` Proxy（每次读都取 `currentConfig()`）、`turn.config`（`openTurn` 时合并 perChat）、`ToolRegistry.bindOverrides()`。其余子系统在 `main.ts` 里拿的是**启动时那份 `config` 对象**，`config.changed` 只 `configStore.replace(...)`，不重建它们：

| 配置项 | doc 11 标注 | 实际 | 后果 |
|---|---|---|---|
| `sandbox.mode` | 热更新（§260） | **冻结**（`new Sandbox(config.sandbox…)`） | ⚠️ 事故中在 WebUI 把 `docker` 改成 `none` 想切断执行类工具，返回 200、`GET /api/sandbox` 显示已改，**`bash`/`python` 照跑不误** |
| `approval.enabled` | 热更新（§286） | **冻结**（`new DatabaseApprovalBroker(db, config, …)`） | ⚠️ 打开审批不生效；关闭审批也不生效 |
| `approval.rules` | 热更新 · WebUI 可编辑（§291） | **冻结**（`new ToolRegistry(…, config.approval.rules)`） | ⚠️ 新增的高危命令规则要重启才生效 |
| `mcp.enabled` / `mcp.servers` | 热更新（§352） | **冻结**（`new McpManager(db, config.mcp, log)`） | `/api/mcp/:name/reconnect` 重连的永远是启动时那份服务器列表；新增 MCP server 必须重启 |
| `concurrency.*`（perKey/global/queueMax/turnTimeoutMs） | 热更新（§132-137） | **冻结** | 限流调不动 |
| `tools.maxCallsPerTurn` / `maxRegistered` / `maxConsecutiveErrors` | 热更新（§218） | **冻结** | |
| `memory.softLimitTokens` / `maxSections` | 热更新（§153） | **冻结** | |
| `agent.maxDepth` / `maxSubagentsPerTurn` | 热更新（§167） | **冻结** | |
| `logs.level` | 热更新 | ✅ 活的（`log.setLevel`） | |
| `agent.agents` | 热更新 | ✅ 活的（`replaceDefinitions`） | |

前三项是**安全相关**的：它们都是「出事时运维会去点的那个开关」，而点了没用、界面还说成功了。这与 [16 §5](./16-remediation-plan.md)「摘除比伪造安全」是同一个原则问题。

**修复**（按成本从低到高，建议 1+2 一起做）：

1. **诚实标注**：把上表里冻结的项在 doc 11 改成 `需重启`，`GET /api/config/schema` 带上 `restartRequired` 标志，WebUI 保存后对这些键显示「需重启才生效」徽标。半天工作量，立刻消除误导。
2. **把三个安全项做成真热更新**：它们的共同形状是「构造时吃了一份 config 快照」，改成吃一个 getter 即可，和 `ToolRegistry.bindOverrides()` 已经用过的手法一致：

```ts
// Sandbox / DatabaseApprovalBroker / ToolRegistry 的 limits 与 rules
constructor(private readonly config: () => Readonly<Config['sandbox']>) {}
// 调用处 this.config().mode
const sandbox = new Sandbox(() => configStore.snapshot().sandbox, …);
```

3. `McpManager` 改为在 `reconcile()` 时读 `configStore.snapshot().mcp`，并关闭已从配置中移除的 client。

**CI 断言**（防止再漂移）：doc 11 里标 `热更新` 的每个键，必须能在 `main.ts` 的 `config.changed` 处理器可达的代码里找到「经由 `configStore.snapshot()` / `turn.config` / Proxy 读取」的路径；做不到静态判定时，至少断言「标注为热更新的键集合 ⊆ 人工维护的 `HOT_RELOADABLE_KEYS` 白名单」，改动时被迫更新白名单。

---

### W-QUOTA-01 · 子 agent 的花费完全不计入配额

**位置**：`packages/core/src/agent/subagent.ts:30-43` · `packages/core/src/ledger/quota.ts`

`runSubAgent` 的 `onStepEnd` 只调 `ledger.record(...)`，**没有调 `quota.commit(...)`**。而 `QuotaGuard` 的日/月计数器 `quota_counters.cost_usd` 只在 `commit()` 里递增（`runtime.ts:302`，主 agent 路径）。

后果链：

- `quota.global.daily` / `perChat.daily` / `perUser.daily` **看不到任何子 agent 花费**。默认配置下 `spawn_agent` 对 limited 用户就开放，`maxSubagentsPerTurn` 默认 10，每个子 agent `maxSteps` 由 agent 定义决定 —— 一轮可以在配额账本上「免费」跑掉十几次模型调用。
- `runtime.ts:274` 的单轮成本闸门读的是 `dependencies.reservation?.committed`，同样只含主 agent 的花费，所以 `quota.perTurn.maxCostUsd` 对子 agent 也不设防。
- `usage_ledger` 和 `turns.cost_usd` 是准的（`ledger.record` 会更新），所以**用量报表看得见、配额拦不住** —— 这种不一致比单纯漏记更难排查。

**修复**：把 `quota` 与 `reservation` 传进 `SubAgentDependencies`，在 `onStepEnd` 里与主 agent 同样处理；`prepareStep` 的成本闸门改成读 `ledger.turnCost(turn.turnId)`（它把主 agent 与所有子 agent 的花费都算进去了，且已经有现成方法）：

```ts
const spent = dependencies.ledger.turnCost(turn.turnId);
if (spent >= config.quota.perTurn.maxCostUsd || …) { patch.activeTools = []; patch.toolChoice = 'none'; }
```

**回归用例**：跑一轮带 `spawn_agent` 的假模型，断言 `quota_counters.cost_usd` 的增量等于 `usage_ledger` 里该 turn 的总和。

---

### W-TG-01 · `/start` 和 `/help` 是彻底的沉默；任何以 `/` 开头的消息都被丢弃

**位置**：`packages/telegram/src/trigger.ts:41` · `packages/telegram/src/bot.ts:96,261`

`trigger.ts:41` 的 `ours` 集合列了 18 个命令名：

```ts
const ours = new Set(['start','help','ask','new','undo','ctx','cancel','tasks','model','memory','forgetme','whoami','whois','grant','revoke','usage','webui','ping']);
```

`bot.ts` 实际注册了 13 个：`ping new undo ctx tasks model whoami grant revoke memory forgetme cancel usage`。

**缺 handler 的有 5 个：`start` `help` `ask` `whois` `webui`。** 判成 `command` 的消息在 `bot.on('message')` 第 261 行被直接 return，于是这 5 个命令是彻底的静默 —— 而 `/start` 是每个 Telegram 用户按下「开始」时发出的第一条消息。

这正是同一段代码上方的注释在警告的事（「名字列在这里却没注册 handler，用户发出去就石沉大海 —— `/wake` 因此摘除」），修 `/wake` 时漏了其余 5 个。

**更宽的一条**：`bot.ts:96` 是

```ts
const triggerReason = message.text?.startsWith('/') ? 'command' : matchTrigger(…);
```

**任何**以 `/` 开头的文本都被判成 command，绕过 `ours` 白名单、也绕过 `config.trigger.command` 开关。所以私聊里发一句 `/home/app 这个目录满了` 或 `/usr/bin 下没有它`，机器人不会有任何反应。

**修复**：

1. 补上 `/start` `/help` 两个 handler（最小实现：`/start` 回一句自我介绍 + 当前角色，`/help` 回可用命令表）。
2. 从 `ours` 里删掉 `ask` `whois` `webui`，或者补齐它们的 handler。二选一，不要保留「列了但不理」的状态。
3. `bot.ts:96` 改成只在 `matchTrigger` 判定为 `command` 时才用 `'command'`，把裸 `/` 前缀的判断交给 `trigger.ts` 里那套带 `bot_command` entity + `ours` 白名单的逻辑：

```ts
const triggerReason = matchTrigger(ctx, {…}, bot.botInfo.id, bot.botInfo.username);
```

（`matchTrigger` 已经在 `config.command` 分支里做了 entity 校验和白名单，语义严格更好。）

**CI 断言**：`ours` 集合与 `bot.command(...)` 注册的名字必须一一对应 —— 可以在 `tests/trigger.test.ts` 里断言两个集合相等。

---

### W-MCP-01 · MCP 工具的入参 schema 被丢掉，模型不知道怎么调

**位置**：`packages/core/src/mcp/manager.ts:77`

`discover()` 认真地把每个 MCP 工具的 `inputSchema` 取了回来并存进 `#tools`，注册时却换成了通配：

```ts
for (const entry of this.#tools.values())
  this.registry.registerExternal({ name: entry.name, description: entry.description,
    inputSchema: z.record(z.unknown()),        // ← entry.inputSchema 没用上
    minRole: entry.minRole, source: 'mcp', execute: entry.call });
```

于是模型拿到的工具定义是「一个任意对象」。它只能靠工具名和描述猜参数名，猜错了 `ToolRegistry.execute` 的 `safeParse` 也不会拦（`z.record(z.unknown())` 什么都收），错误参数直接送到 MCP server。**MCP 工具在实践中不可用**，而 [07 §4](./07-skills-plugins-mcp.md) 把它写成一等能力。

同一处顺带两条：`server.timeoutMs` 存进了 `mcp_servers` 表但从未用来限制 `callTool`；`connect()` 缓存的 client 在服务器被移除/禁用后不会断开（只有 `close()` 会）。

**修复**：MCP 的 `inputSchema` 是标准 JSON Schema，用现成的转换器接上即可（仓库已依赖 `zod-to-json-schema` 的反向工具链可选，也可以直接让 registry 接受 JSON Schema）：

```ts
// 方案 A：registry 支持 JSON Schema 直通（AI SDK 的 tool() 接受 jsonSchema()）
import { jsonSchema } from 'ai';
inputSchema: jsonSchema(entry.inputSchema as JSONSchema7),
// 方案 B：json-schema-to-zod 转成 zod，保持 registry 单一类型
```

方案 A 更省事，但要把 `RegisteredTool.inputSchema` 的类型从 `z.ZodType` 放宽到 AI SDK 的 `FlexibleSchema`，并给 `execute()` 的 `safeParse` 一条对应分支。**别让它继续维持「注册成功但没法用」的状态**。

---

### W-APPR-01 · 文档承诺的 Telegram 审批交互没有实现，非 owner 的高危工具只会静默超时

**位置**：`packages/core/src/approvals.ts` · `packages/telegram/src/bot.ts:238`

[05 §6](./05-tools-and-permissions.md) 的流程图第 315 行明确写着：

```
├─ Telegram: 发消息 + inline [✓ 批准][✗ 拒绝]（仅 owner 与 approval.allowInitiator 时的发起人可点）
├─ WebUI: /api/approvals 出现待办 + SSE 推送 + 可选桌面通知
```

WebUI 那半实现了（`events.emit('approval.pending')` + `/api/approvals/:id/decide`）。**Telegram 那半完全没有**：`bot.on('callback_query:data')` 只处理 `c:`（取消）前缀，没有任何地方发送审批消息或 inline keyboard。

后果：一个 trusted 用户在 Telegram 里让模型 `delete_file`（policy 是 `approval: 'always'`），`DatabaseApprovalBroker.request` 每 500 ms 轮询数据库，**整整 180 秒**，其间该轮次挂着不动、占着并发槽和配额预留，最后返回 `未获批准`。全过程 Telegram 侧没有任何提示，owner 除非正好开着 WebUI 才会知道。

`approval.allowInitiator` 已经在 `KNOWN_UNIMPLEMENTED_CONFIG_KEYS` 里，但**审批消息本身没有被标注为未实现**，doc 05 仍然把它画在主流程里。

**修复**（二选一，不要留在中间态）：

1. **实现**：在 `DatabaseApprovalBroker` 上加一个可选的 `notifier`，由 `main.ts` 注入 Telegram 实现，发送带 `a:<approvalId>:ok` / `a:<approvalId>:no` 的 inline keyboard；`bot.on('callback_query:data')` 增加 `a:` 分支，校验点击者是 owner（或 `allowInitiator` 时的发起人）后调 `approvals.decide(...)`。轮询也可以顺手换成 EventBus 订阅（doc 05 写的就是 `Promise + EventBus`）。
2. **摘除**：doc 05 §6 把 Telegram 那一行标成 `🚧`，并在审批发起时给发起人回一句「该操作需要 owner 在 WebUI 审批，180 秒内未处理将自动拒绝」——至少让用户知道发生了什么，而不是干等三分钟。

---

## 4. 新增 P2

| 编号 | 位置 | 问题 | 建议 |
|---|---|---|---|
| **W-TG-02** | `bot.ts:146,151` | `/ctx` 与 `/tasks` 把 `context.stats(key)`（含窗口内**全部消息及其 parts**）JSON 序列化后发出去，活跃会话轻松超过 Telegram 的 4096 字符上限 → API 400 → `bot.catch` 记一条日志，用户看到的是没有回应 | 只回摘要（commit id / 窗口 / token / 消息条数），完整数据给 WebUI 链接；或走 `splitTelegramText` |
| **W-TG-03** | `bot.ts:320` | 非流式分支 `ctx.reply(part, { parse_mode: 'MarkdownV2' })` 没有 parse-entities 降级重试，而 `TelegramOutput.send()`（`stream-output.ts:26-32`）有。`safeRender` 之后再按字符数切分，仍可能切开 `\.` 转义对或 `*bold*` 配对 | 抽出 `sendWithFallback()`，两条路径共用 |
| **W-TG-04** | `stream-output.ts:94` | `consume()` 收尾循环里新增消息用的是裸 `bot.api.sendMessage(..., {parse_mode:'MarkdownV2'})`，既没走 `deliver()` 也没有降级重试，抛出后会把整轮打成 failed | 同上，改走 `deliver()` + 降级 |
| **W-TOOL-01** | `registry.ts:108-121` | `execute()` 复查了 `disabledByOperator`、`state.disabled`、`minRole`，但**没有复查 `tool.available?.()`，也没有复查 `agentKind==='sub' && name==='memory_write'`**。目前每个相关工具都恰好各自 fail-closed（`sandbox.run` 内部再判一次 plan；`telegram!` 为空时 TypeError 被 catch 成 `ok:false`），所以不可利用，但这是靠巧合而不是靠设计 | 在 `execute()` 里补这两条，与 `active()` 的过滤集合对齐；[05 §220](./05-tools-and-permissions.md) 的「单一数据源」精神要求两边一致 |
| **W-SBX-01** | `sandbox/index.ts:118` | 容器名是 `luoli-sbx-${Date.now()}`。并发上限 8，同毫秒启动两个容器就撞名（`docker run --name` 冲突，第二个直接失败）；且 [05 §5.3](./05-tools-and-permissions.md) 写的是 `luoli-sbx-<turnId>-<n>`，`/cancel` 想按 turn 找容器也找不到 | 按文档改成 `luoli-sbx-${turnId}-${seq}`，`Sandbox.run` 接收 turnId |
| **W-SBX-02** | `sandbox/index.ts:104-111` | [05 §5.2](./05-tools-and-permissions.md) 要求 jail 模式「日志 level=warn 提示隔离较弱」，`plan()` 里没有这条日志 | 补上；WebUI 沙箱页也照 §5.4 显示「jail 不是安全边界」 |
| **W-PROMPT-01** | `assembler.ts:78` · `runtime.ts:229` | `build()` 算出了 `truncated: string[]`，调用方只取 `.instructions`。当 catalog + runtime 块把预算吃满时，`CHARACTER.md` 会被整段截成一句「（记忆已截断…）」，**人格静默消失且无任何日志** | `runtime.ts` 取回 `truncated`，非空时记一条 `prompt.truncated` warn |
| **W-PROV-01** | `provider/store.ts:55` | `retryDelay` 的「jitter」是 `sha256(String(attempt))` —— 对同一 attempt 是常量，所有并发请求退避到同一时刻。这不是抖动 | 用 `crypto.randomInt` 或按 turnId 派生 |
| **W-LEDGER-01** | `runtime.ts:296` | `modelAlias: step.model.modelId === initialInfo.modelId ? alias : 'low'` —— 走 fallback 链切到第二个模型时会被记成 `'low'`，而它可能根本不是降档。按别名分组的用量报表因此失真 | 用 `infoByModelId(step.model.modelId)` 反查真实别名，查不到记 `unknown` |
| **W-TG-05** | `bot.ts:224` · `trigger.ts` | `trigger.ignoreEditedAsTrigger: false` 实际无效：`bot.on('edited_message')` 只归档，从不开轮次。更糟的是被判成 `triggered=1` 的编辑消息会被 `claimBackground` 的 `triggered=0` 过滤排除，**既不触发也不进背景上下文，等于凭空消失** | 要么真正实现（编辑触发新轮次），要么把该键加进 `KNOWN_UNIMPLEMENTED_CONFIG_KEYS` 并在 doc 11 标 `🚧`；无论哪种，编辑消息都不该被静默丢弃 |
| **W-SEC-01** | `tools/web.ts` · `main.ts` | `tools.web.searchApiKeyRef` 被**当作明文 key 直接使用**（`webSearch: { apiKey: config.tools.web.searchApiKeyRef }`）。键名叫 `Ref` 却不是引用，而 provider 的 key 走的是 `Secrets` 加密。搜索 key 于是明文躺在 `config.yaml` / `config_kv` 里 | 要么改名为 `searchApiKey` 并明说是明文，要么真做成引用（指向 `providers` 表或独立的加密 secret 表） |
| **W-SEC-02** | `core/src/secrets.ts:7` | 主密钥派生是裸 `sha256(masterKey)`，无 salt、无 KDF。`LUOLI_MASTER_KEY` 若是人选的口令，离线爆破成本极低 | 至少 `scrypt`/`argon2id` + 固定 salt（存 DB），或在文档里强制要求 32 字节随机值并在启动时校验熵 |
| **W-FS-01** | `tools/files.ts:47,67` | `glob` 与 `grep` 的 `walk` 没有已访问集合。workspace 内一个指向自身祖先的符号链接（`ln -s . loop`，`bash` 就能建）会让递归无限下去 —— 匹配数上限只在**命中**时才起作用 | 用 `realpathSync` 记录已访问目录集合；或给 `walk` 加深度上限（`list` 已经有了） |
| **W-API-01** | `app.ts:121-128` | `GET /api/health` 在鉴权中间件之前放行，返回 provider 列表（id/name/kind/baseUrl/健康状态）、MCP 服务器、沙箱 plan、在途轮次数。默认绑 `127.0.0.1` 所以影响有限，但一旦 `webui.host` 放开就是无鉴权信息泄露 | 拆成两个：无鉴权的 `/api/health` 只回 `{ok, uptimeMs}`；详细信息移到鉴权后的 `/api/health/detail` |
| **W-API-02** | `app.ts:369` 与 `app.ts:460` | `DELETE /api/aliases/:alias` 注册了两次，第二份是死代码（Hono 用先注册的那份，第二份缺 404 分支）。另外 `publicConfig`（`app.ts:88`）里 `/…/.test(key) ? key : key` 是恒等三元式 | 删掉重复路由与恒等三元式 |
| **W-API-03** | `app.ts:386-393` | `GET /api/messages?q=…` 走 `adminSearchAll(query, page*size)` 后再本地切片，`total` 因此等于「已取回条数」而不是命中总数，翻到后面页数会漂 | 搜索分支单独算 `COUNT(*)`，或明确返回 `hasMore` 而不是 `total` |
| **W-CFG-03** | `main.ts:16-21,113` | 启动时把 `LUOLI_WEBUI_HOST` / `WEBUI_PASSWORD` 叠进 `startupOverrides`，但 `config.changed` 的热重载只做 `loadConfig({ overrides: readPersistedConfig(...) })`，**不带这层 env 覆盖**。若 host 存在 DB 而口令只来自 env，热重载会撞上 `webui.passwordHash` 的 superRefine 而整体失败（`removeOverridePath` 也删不掉它，因为它不在 overrides 里） | 把 env 叠加抽成 `envOverlay()` 函数，启动与热重载共用 |

---

## 5. 修复批次与结构性建议

### W0 · 止血（约 1 人日）

| # | 改动 | 对应 | 备注 |
|---|---|---|---|
| 1 | `contextMessages()` 把 `role:'system'` 降级为 `user`；4 个注入点改写 role；`assertValidShape` 加 role 白名单 | `W-CTX-01` | 附带 `UPDATE context_messages SET role='user' WHERE role='system';` 清理已损坏的会话 |
| 2 | `prepareStep` 改用带 fallback 包装的模型；`subagent.ts` 同步 | `W-AGENT-01` | |
| 3 | `media.ts` 原始文件与归一化输出分路径 | `W-MEDIA-01` | 一行改动 |
| 4 | 点号展开屏蔽 `__proto__`/`constructor`/`prototype`，三处共用 | `W-CFG-01` | |

**建议同时准备巡检脚本**：`SELECT key, COUNT(*) FROM context_messages WHERE role='system' GROUP BY key;` —— 已经在跑的实例大概率有会话已经废了。

### W1 · 收口（约 2 人日）

| # | 改动 | 对应 |
|---|---|---|
| 5 | doc 11 重标热更新/需重启 + schema 带 `restartRequired` + WebUI 徽标；`Sandbox`/`ApprovalBroker`/`ApprovalRules` 改吃 getter | `W-CFG-02` |
| 6 | 子 agent 花费计入 `quota.commit`；单轮闸门改读 `ledger.turnCost` | `W-QUOTA-01` |
| 7 | 补 `/start` `/help`；`ours` 与已注册命令对齐；`bot.ts:96` 交回 `matchTrigger` | `W-TG-01` |
| 8 | MCP `inputSchema` 接线；`timeoutMs` 生效；移除的 server 断开 | `W-MCP-01` |
| 9 | Telegram 审批 inline keyboard（或按「摘除比伪造安全」标 `🚧` + 给发起人回执） | `W-APPR-01` |
| 10 | P2 十七项 | §4 |

### 结构性建议：不变量要从**下游契约**推导，而不是自己定义

第四轮的建议是「不变量要覆盖写入方，不只是读出方」，已经落地成 `assertValidShape` 在三个出入口都跑。方向对，效果也实打实——本轮上下文引擎**内部**零缺陷。

但 `W-CTX-01` 说明还缺一层：

> `assertValidShape` 检查的是**我们自己定义的**合法形状（part type 白名单、tool-call 配对）。它对 `role` 一个字都没说，因为「role 只能是 user/assistant/tool」这条规则不在我们的规格里，**它在 AI SDK 的 `standardizePrompt` 里**。

三个 P0 全是同一形状：本进程内自洽，交给外部依赖时形状对不上。所以不变量的来源应该反过来——**不是「我们认为什么合法」，而是「下游会拒绝什么」**。落地成本很低：

```ts
// tests/context.contract.test.ts —— 引擎产出的上下文必须能被 AI SDK 收下
import { ToolLoopAgent } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';

const SCENARIOS = [
  ['纯文本轮次',        (h) => …],
  ['工具调用轮次',       (h) => …],
  ['load_skill 之后',    (h) => …],   // ← 会当场抓住 W-CTX-01
  ['背景消息被省略',      (h) => …],   // ←
  ['在途轮次期间 /new',   (h) => …],   // ←
  ['分级裁剪后',         (h) => …],
  ['硬截断预算=1',       (h) => …],
  ['带图片 part',        (h) => …],
];
it.each(SCENARIOS)('%s：contextMessages() 能被 ToolLoopAgent 接受', async (_name, build) => {
  const turn = await build(harness());
  await expect(new ToolLoopAgent({ model: mock, instructions: 's' })
    .generate({ messages: contextMessages(turn) })).resolves.toBeDefined();
});
```

这一条用例就能同时锁死 `W-CTX-01` 和未来任何一次「上下文形状漂移」。同理值得加的还有两条**跨边界**用例：

- **媒体链路**：造一张真 JPEG 走完 `TelegramMedia.process()`，断言产出 `{type:'image'}`（抓 `W-MEDIA-01`）。
- **模型链路**：`prepareStep` 存在时，包装中间件仍被调用（抓 `W-AGENT-01`）。

共同点是：**每一条都跨过一个「我们的代码 → 外部库」的交接点**。43 个测试文件里，跨过这类交接点的目前是 0 个。

---

## 6. 文档侧

| 项 | 状态 |
|---|---|
| [11 §2.1](./11-config-reference.md) perChat 白名单与「谁可以写 perChat」 | ✅ 第四轮已补，读取端也接上了 |
| [11](./11-config-reference.md) 的 `🚧` 标注 | ✅ 67 个键逐行标注，CI 断言已加强 |
| [03](./03-data-model.md) 数据模型 | ✅ `media_parts_json`、`claimed_by_turn`、`app_kv` 都在 |
| [02](./02-context-engine.md) 不变量清单 | ⚠️ 14 条里没有一条讲 `role`。补第 15 条：「可发送给 provider 的消息 role 只能是 user/assistant/tool；system 只存在于 instructions」 |
| [11](./11-config-reference.md) 的热更新标注 | ❌ 至少 10 组键标着「热更新」而实际需重启，其中 3 组安全相关（`W-CFG-02`） |
| [05 §6](./05-tools-and-permissions.md) Telegram 审批 | ❌ 流程图里的 inline keyboard 一行没实现（`W-APPR-01`） |
| [05 §5.2](./05-tools-and-permissions.md) jail 的 warn 日志 | ❌ 未实现（`W-SBX-02`） |
| [05 §5.3](./05-tools-and-permissions.md) 容器名 `luoli-sbx-<turnId>-<n>` | ❌ 实现是 `luoli-sbx-<Date.now()>`（`W-SBX-01`） |
| [07 §4](./07-skills-plugins-mcp.md) MCP 工具能力 | ❌ 入参 schema 未接线，工具实际不可用（`W-MCP-01`） |
| [08](./08-telegram-adapter.md) 命令表 | ❌ 与 `trigger.ts` 的 `ours`、`bot.ts` 的注册三方不一致（`W-TG-01`） |
| [13](./13-acceptance-criteria.md) | 自第二轮起未更新，`R-*` / `W-*` 相关 AC 需要补 |

---

## 7. 测试覆盖

**本轮真实进步**：43 文件 / 134 用例（上轮 38 / 98），增幅是四轮里最大的。`config.persistence.test.ts`、`regression.round4.test.ts` 把第四轮的每一条都钉住了，回退修复能让用例变红 —— 这一点确认过。

**空白区域**（三个 P0 全落在这里）：

| 区域 | 现状 | 建议最小用例 |
|---|---|---|
| 上下文 → AI SDK 的交接 | **零覆盖**。`agent.messages.test.ts` 只断言 `contextMessages()` 的返回形状，从不把它交给 `ToolLoopAgent` | §5 的 `context.contract.test.ts`，8 个场景 |
| 媒体处理 | **零覆盖**。43 个文件里没有一个 import 过 `TelegramMedia` | 真 JPEG 走完 `process()`，断言产出 image part |
| `prepareStep` 与模型包装的交互 | `agent.retry.test.ts` 只测了 `fallbackLanguageModel` 本身，没测它在 `ToolLoopAgent` 里还生不生效 | 中间件调用计数断言 |
| 子 agent 的配额记账 | `quota.test.ts` / `subagent.test.ts` 各自覆盖，交叉处没有 | 断言 `quota_counters` 增量 == `usage_ledger` 该 turn 总和 |
| 命令表一致性 | 无 | `ours` 集合 == `bot.command()` 注册集合 |
| 配置热更新的实际生效 | `config.api.test.ts` 只测写入与校验，不测「改完之后运行时行为真的变了」 | 改 `sandbox.mode` 后断言 `sandbox.plan()` 的返回随之改变 |

一个共同的教训：**四轮以来的用例都在验证「模块内部自洽」，没有一条验证「模块交出去的东西对方收得下」。** 本轮三个 P0 全部由此而来。

---

## 8. 验收状态快照（粗估）

沿用前四轮口径（[13](./13-acceptance-criteria.md) 的 253 条 AC，★ 为 62 条关键项）：

| 轮次 | 通过 | 比例 | ★ 关键项 |
|---|---|---|---|
| 第三轮复审后 | ~219/253 | 87% | 52/62 |
| 第四轮复审后 | ~234/253 | 92% | 57/62 |
| **第五轮（现在）** | **~225/253** | **89%** | **52/62** |
| W0 修完预计 | ~240/253 | 95% | 58/62 |
| W0+W1 修完预计 | ~247/253 | 98% | 60/62 |

比例回落不是代码退步，而是**本轮首次做端到端联调**：多模态输入、MCP 工具、Telegram 审批、fallback 重试这四组能力此前被计为「已实现」，实测都不成立。

分域看：

| 域 | 上轮 | 本轮 | 变化 |
|---|---|---|---|
| 上下文引擎（内部） | 高 | **高** | 内部零新缺陷，不变量测试继续奏效 |
| 上下文 → provider 交接 | 未审 | **低** | 首次覆盖，`W-CTX-01` 是本轮最严重的一条 |
| 配置与 WebUI | 低 | **中** | 第四轮三条全修好；新增 `W-CFG-01`（原型污染）与 `W-CFG-02`（热更新契约） |
| 安全边界 | 高 | 中高 | `untrusted()` / SSRF / 路径 jail 都扎实；扣分在 `W-CFG-02` 的三个安全开关不热更新 + `W-APPR-01` |
| Telegram 适配 | 中高 | **中** | 输出渲染与流式处理做得好；`/start` 静默、图片全灭、审批缺失三条都在这一层 |
| 扩展（skill/plugin/mcp） | 中高 | **中低** | skill/plugin 扎实；MCP 入参 schema 未接线，实际不可用 |
| 配额与计量 | 未深审 | 中 | 主 agent 路径正确；子 agent 花费不计入配额 |

---

## 9. 本轮确认做得好的地方

1. **第四轮 12 项全部关闭，且都是根因修复。** `perChatConfig` 连读取端一起补齐、`releaseClaims` 覆盖到 `openTurn` 内部抛出路径、`loadConfig` 的逐条剔除还顺手清空变空的父节点 —— 都超出了报告要求的最小改动。
2. **`app_kv` / `config_kv` 的命名空间分离做得干净。** `db/src/config.ts` 顶上那段注释直接把「为什么不能混用」写清楚了，`/model` 和插件存储都迁过去了，`0005` 还带了历史数据迁移。
3. **`untrusted()` 与 SSRF 防护经得起细看。** 自定义 `lookup` 钉死已校验 IP、保留 `Host` 与 `servername`、每次重定向重新校验、IPv4-mapped IPv6 也覆盖了 —— 这一块比多数生产代码严谨。
4. **`safeRender` 的 MarkdownV2 处理很细。** 未闭合围栏补齐、代码块先保护再还原、表格转成代码块、`**bold**` 先转义再还原成 `*bold*`。模型输出里的破坏性字符基本都挡住了。
5. **`archiveQuery` 那段注释是本仓库注释风格的范本。** 它解释的是「为什么中文两字词要退回 LIKE、为什么退回时要用最长词而不是原串」，这是读代码看不出来的部分。
6. **失败文案分类（`failureText`）。** 把「上游重试耗尽」「模型没配」「缺定价」「没吐正文」分开讲，每一条都告诉用户该找谁 —— 大多数项目在这里只会给一句「出错了」。
7. **`checkWakeword` 运行时与写入端共用一份判定。** 注释里写明了「分成两份会漂移」，这正是 `W-TG-01` 里 `ours` 与 `bot.command` 分成两份造成的问题 —— 同一个教训在唤醒词上学会了，在命令表上还没有。

---

## 10. 一句话总结

第四轮的 12 项全部关闭且修得扎实，上下文引擎**内部**已经稳了；本轮把审查推到了「我们的代码交给外部依赖」的那一跳，三个 P0 全部落在这里 —— 其中 `W-CTX-01` 的触发条件是「模型调一次 `load_skill`」或「群里攒够 20 条闲聊」，后果是**该会话此后每一轮都失败**，且 `assertValidShape` 因为不检查 role 而全程放行。**建议优先于其他一切处理，并把 §5 的跨边界契约测试一起加上**——否则下一轮还会在同一个缝里发现新的东西。
