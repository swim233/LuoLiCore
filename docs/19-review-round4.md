# 19 · 复审报告（第四轮）

> 复审对象：`docs/18-review-round3.md` 第三轮整改后的实现
> 基线：`pnpm typecheck` 通过；`pnpm test` **36 个文件 / 86 个用例全部通过**（上一轮 35 / 69）
> 方法：全量重读源码 → 针对性实测探针（PROBE-G…N）→ 清理探针 → 复原绿基线
> 标记：★ = 已用可运行的探针实测确认，非仅代码推断

---

## 0. 结论速览

| 项 | 结论 |
|---|---|
| 第三轮 4 个 P0 | **4/4 全部修复**，且都照根因改，不是打补丁 |
| 第三轮 4 个 P1 | 3 个修复，`T-CFG-01` **部分完成**（做了分类，但断言过弱、文档标注仍为空） |
| 第三轮 4 个 P2 | **4/4 全部修复** |
| 新增 P0 | **3 项**（`R-CFG-01`、`R-CFG-02`、`R-CTX-01`），全部 ★实测 |
| 新增 P1 | 4 项 | 
| 新增 P2 | 5 项 |
| 上下文引擎递归模式 | **首次被打断**——本轮新增的上下文缺陷只有 1 个，且是"同一函数的另一条分支"，不再是"新数据激活了休眠代码" |
| 新的高发区 | **配置持久化层**：`config_kv` 同时充当"配置覆盖源"和"通用 KV 存储"，三个写入方绕过了 schema 校验 |

### 0.1 本轮最重要的一条

**`/model` 命令用一次，机器人就再也起不来了。**

`bot.ts:150` 把 `perChat.modelAlias.<key>` 写进 `config_kv`；`readPersistedConfig`（`packages/db/src/config.ts:14-25`）按 `.` 展开成 `perChat.modelAlias.<key>`；`configSchema` 的 `superRefine`（`schema.ts:149-158`）判定它不在 perChat 覆盖白名单里 → `loadConfig` 抛出 → `apps/bot/src/main.ts:22` **没有 catch** → 进程启动失败。热更新路径（`main.ts:98`）有 `.catch`，所以在下次重启之前完全无症状。

这不是 schema 判错——[11 §2.1](./11-config-reference.md) 第 457 行明确写着「`perChat` 出现白名单外的路径 → 拒绝启动，指出具体路径」。**规格是对的，写入方没走校验。**

### 0.2 递归模式的变化

前三轮的模式是"每修一个上下文缺陷，就有新数据流进一条从未执行过的路径，立刻暴露下一个 P0"：

| 轮次 | 修复项 | 激活的新 P0 |
|---|---|---|
| 一→二 | `G-CTX-01` 补硬截断步骤 3 | `N-CTX-01` 死循环 |
| 二→三 | `N-CTX-03` 工具消息入库 | `T-CTX-01` 分级裁剪产出非法消息 |
| 二→三 | `N-CTX-04` 水位改到提交时 | `T-CTX-02` 并发重复认领 |
| 三→四 | `T-CTX-01` 修好了 `elidePart` | `R-CTX-01` **`truncatePartStrings` 没跟着修** |

第四轮这一条性质不同：不是"新数据激活休眠代码"，而是"同一个问题在**姊妹函数**里还留着一份"。`messages()` 里两条分支——`elidePart`（分级裁剪）和 `truncatePartStrings`（硬截断）——上一轮只修了前者。这说明[18 §5](./18-review-round3.md) 提的形状不变量方向是对的，只是**不变量集合还缺一条**（见 §5）。

而新的高发区转移到了配置层，成因同构：**一个有明确不变量的命名空间，存在不走校验器的写入方。**

---

## 1. 第三轮发现的复验结果

### 1.1 P0（4/4 已修复）

| 项 | 状态 | 证据 |
|---|---|---|
| **T-CTX-01** 分级裁剪产出非法消息 | ✅ 已修复 | `context.ts:49-55` 新增 `elidePart()`，保留 `type` 与 `toolCallId`/`toolName`，只清空载荷；`context.ts:210-211` 改为 `originalParts.map(elidePart)`；`engine.ts:205-215` 新增 `assertValidShape()`，在 `openTurn` 与 `materialize` 两个出口断言；`tests/context.invariants.test.ts` 用 6 个确定性种子覆盖 |
| **T-CTX-02** 并发轮次重复折入背景消息 | ✅ 已修复 | `0004_claim_exclusive.sql` 加 `claimed_by_turn` 与两个部分索引；`archive.ts:102` 加 `claimed_at IS NULL` 过滤；`archive.ts:116-118` 新增 `releaseClaims()`；`engine.ts:141-145` 的 `abortTurn` 不再是空壳；`context.ts:178` 提交时释放归属；`database.ts:52` 崩溃恢复时清空全部在途认领 |
| **T-SEC-01** `untrusted()` 未转义闭合标记 | ✅ 已修复 | `shared/index.ts:71-75` 实现了 [05 §344](./05-tools-and-permissions.md) 承诺的三件事：随机 nonce 边界、转义 `</untrusted-content`、转义 source 属性；`assembler.ts:8` 的内核提示词同步改成「只有携带相同 id 的闭合标记才结束边界」 |
| **T-TG-01** 群聊里用户自己的请求被标记为不可信 | ✅ 已修复 | `engine.ts:63` 改为 `message.triggered ? escaped : othersSpeech(escaped)`——触发消息不再被包裹；背景发言换成语义正确的 `<group-message>`；`assembler.ts:9` 内核提示词补了对应措辞。**额外加分**：`engine.ts:48-50` 新增 `escapeForgedSpeakerPrefixes()`，堵上了伪造 `[某人 12:34]` 说话人前缀这条本轮没提的路 |

### 1.2 P1（3/4 已修复，1 项部分完成）

| 项 | 状态 | 说明 |
|---|---|---|
| **T-MEM-01** `#pending` 在失败轮次泄漏 | ✅ | `store.ts:133-137` 新增 `discard()`；`bot.ts:319` 在 `finally` 里与 `releaseTurn` 并列调用 |
| **T-AGENT-01** 中断后 `mainRun` 悬挂 | ✅ | `runtime.ts:266-270` 用 `settled` 闭包保证 finish/fail/interrupt 三者只生效一次；`bot.ts:299` 中断路径显式调用 `generated.interrupt()` |
| **T-CTX-03** 提交后 `appendDelta` 被静默丢弃 | ✅ | `engine.ts:117` 检测 `turn.finalized` 直接抛错；`commitTurn`/`abortTurn` 入口即置位。风格与 `ordinal is assigned only during commit` 一致 |
| **T-CFG-01** 47 项配置未接线 | ⚠️ **部分完成** | 做对了主体：`schema.ts:5-72` 列出 **67 个** `KNOWN_UNIMPLEMENTED_CONFIG_KEYS`，`tests/config.test.ts:49-60` 加了 CI 断言，选择了「显式分类」而非「假实现」——方向完全正确。但两处断言都比看上去弱，见 §3 `R-CFG-03` |

### 1.3 P2（4/4 已修复）

| 项 | 状态 | 说明 |
|---|---|---|
| **T-SEC-02** 群聊包裹的 token 开销 | ✅ | 触发消息完全不再包裹；背景消息的标记从 ~60 字符降到 ~34 字符 |
| **T-TOOL-01** `grep` 的 ReDoS | ✅ | `files.ts:64` 改走 `safeRegex(pattern, ignoreCase)`，非法模式返回 `invalid_pattern` |
| **T-EXT-01** 插件 import 缓存穿透导致模块泄漏 | ✅ | `plugins/manager.ts:45` 从 `?t=${Date.now()}` 改成 `?v=${target.signature}`，只有内容真变化才产生新模块 |
| **T-SEC-03** DNS rebinding TOCTOU | ✅ | `web.ts:39-42` 用自定义 `lookup` 把解析结果钉死在已校验的 IP 上，并保留 `Host` 头与 `servername`；`web.ts:82` 每次重定向重新走 `safeTarget` |

---

## 2. 新增 P0（阻断验收）

### R-CFG-01 ★实测 · `/model` 命令让机器人下次启动直接失败

**位置**：`packages/telegram/src/bot.ts:150` · `packages/db/src/config.ts:14-25` · `packages/core/src/config/schema.ts:149-158` · `apps/bot/src/main.ts:22`

**现状**：

```ts
// bot.ts:141-150 —— /model 命令，trusted 及以上可用
const configKey = `perChat.modelAlias.${key}`;
...
dependencies.db.prepare("INSERT INTO config_kv(key,value_json,updated_at,updated_by) VALUES (?,?,?,'command') ON CONFLICT(key) DO UPDATE SET ...").run(configKey, JSON.stringify(requested), Date.now());
```

**实测（PROBE-L，完全复刻上面这行写入）**：

```
PROBE-L config_kv          = [{"key":"perChat.modelAlias.chat:-1001234567","value_json":"\"high\""}]
PROBE-L 展开后的 overrides = {"perChat":{"modelAlias":{"chat:-1001234567":"high"}}}
PROBE-L 重启时             = 启动配置加载抛出 → perChat.modelAlias.chat:-1001234567: path is not in perChat override allowlist
```

**影响**：

- 触发门槛极低：**任意 trusted 用户在任意会话执行一次 `/model high`**。这是 [08](./08-telegram-adapter.md) 里公开记录的命令。
- 症状延迟且无关联：命令本身回复"当前会话模型已固定为 high"，热更新路径 `main.ts:98` 的 `.catch` 把校验失败降级成一条 `config.invalid` 日志，**当前进程一切正常**。直到下一次重启（部署、OOM、`SIGTERM`）才炸，此时故障现象是"启动即退出"，运维很难联想到几天前有人发过 `/model`。
- 恢复只能手工进 SQLite 删行——而 WebUI 起不来，`/api/config` 也访问不到。
- 在 supervisor / `docker-compose restart: always` 下这是**崩溃循环**。

**修复**（三选一，建议全做）：

1. **立即止血**——把非配置键移出 `config_kv` 命名空间：新建 `app_kv(key,value_json,updated_at,updated_by)` 表，`/model`、`tools.overrides.*`、`plugin.*.*` 全部改写这张表。
2. **兜底**——`readPersistedConfig` 只接受合法 schema 路径，其余键跳过并记一条 `config.ignored_key` 警告。
3. **降级**——`main.ts:22` 包 try/catch：校验失败时回退到"文件 + 环境变量"两层（丢弃 DB 覆盖层）启动，并把出错的键与可直接复制执行的修复 SQL 打进日志：

```ts
let config: Readonly<Config>;
try { config = await loadConfig({ overrides: startupOverrides }); }
catch (error) {
  const keys = (error as ZodError).issues?.map((issue) => issue.path.join('.')) ?? [];
  console.error(`[config] 持久化覆盖层校验失败，已忽略该层启动。请执行：\n  DELETE FROM config_kv WHERE key IN (${keys.map((key) => `'${key}'`).join(',')});`);
  config = await loadConfig({});
}
```

---

### R-CFG-02 ★实测 · `PATCH /api/chats/:key` 完全绕过 perChat 覆盖白名单

**位置**：`packages/server/src/app.ts:206-210`

**现状**：

```ts
app.patch('/api/chats/:key', async (ctx) => {
  const body = await ctx.req.json<Record<string, unknown>>(); const key = `perChat.${ctx.req.param('key')}`; const now = Date.now();
  dependencies.db.prepare("INSERT INTO config_kv(...) VALUES (?,?,?,'webui') ON CONFLICT(key) DO UPDATE SET ...").run(key, JSON.stringify(body), now);
  dependencies.events.emit('config.changed', { keys: [key] }); return ctx.json({ ok: true, data: body });
});
```

**没有任何校验**——对比同一文件 `app.ts:188-204` 的 `PUT /api/config`，那里老老实实走了 `runtimeConfigSchema.safeParse(mergeDotted(...))`。

**实测（PROBE-J / J2）**：

```
PROBE-J  PATCH 状态                     = 200 {"ok":true,"data":{"access":{"defaultUserRole":"owner"},"sandbox":{"mode":"none"}}}
PROBE-J  config_kv                      = [{"key":"perChat.chat:abc","value_json":"{\"access\":{\"defaultUserRole\":\"owner\"},\"sandbox\":{\"mode\":\"none\"}}"}]
PROBE-J  同样内容经 PUT /api/config 校验 = 400
PROBE-J2 重启时                          = 启动配置加载抛出 → perChat.chat:abc.access.defaultUserRole: path is not in perChat override allowlist
                                                            | perChat.chat:abc.sandbox.mode: path is not in perChat override allowlist
```

**影响**：

- 同一份内容，走 `PUT /api/config` 是 400，走 `PATCH /api/chats/:key` 是 200。白名单这道防线在 WebUI 上有一个后门。
- 这道白名单的存在理由 [11 §2.1](./11-config-reference.md) 写得很清楚：「避免出现『某个群单独关掉了权限检查』这类危险配置」。上面的探针写进去的正是 `access.defaultUserRole: owner` 和 `sandbox.mode: none`。
- 和 `R-CFG-01` 同款后果：**下次启动直接失败**。
- 另有一层：**当前没有任何代码读取 `config.perChat`**（全仓搜索 `perChat` 只命中 schema 定义、`quota.perChat.*` 和 `perChat.modelAlias.*` 这个另起炉灶的键）。所以这个端点写进去的覆盖项**既不生效、又会 brick 启动**。[09 §165](./09-webui.md) 把它记为「PATCH 改 scope/唤醒词/覆盖项」。

**修复**：

```ts
app.patch('/api/chats/:key', async (ctx) => {
  const body = await ctx.req.json<Record<string, unknown>>();
  const parsed = runtimeConfigSchema.safeParse(mergeDotted(currentConfig(), { [`perChat.${ctx.req.param('key')}`]: body }));
  if (!parsed.success) return ctx.json({ ok: false, error: { code: 'invalid_config', message: '会话覆盖校验失败', details: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) } }, 400);
  ...
});
```

并补上 perChat 覆盖的**读取端**（否则这个端点仍然只是写进去不生效），或者按 [16 §5](./16-remediation-plan.md) 的「摘除比伪造安全」原则暂时返回 `not_implemented`。

---

### R-CTX-01 ★实测 · 硬截断把 `part.type` 一起截掉，产出 provider 会拒绝的消息

**位置**：`packages/db/src/context.ts:268-283`（`truncatePartStrings`）· `context.ts:118-138`（`hardTruncateLargest`）· `context.ts:212-213`（调用点）

**现状**：`truncatePartStrings` 是一个**无差别的字符串遍历器**——它对 parts 里的每一个字符串按预算依次消耗，包括判别字段本身：

```ts
const visit = (value: unknown): unknown => {
  if (typeof value === 'string') { ... }               // ← 'text' / 'image' / toolCallId 全都在这里被截
  if (Array.isArray(value)) return value.map(visit);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, visit(child)]));
  return value;
};
```

对象键的遍历顺序是插入顺序，`type` 通常排在第一个，于是**预算优先被 `type` 吃掉**。而 `hardTruncateLargest` 在超限严重时会把 `targetTokens` 压到 1（`context.ts:131`），进而 `chars` 算成 1（`context.ts:133`）。

**实测（PROBE-G：limit=100，一轮内两条约 2404 token 的消息）**：

```
PROBE-G 物化 parts =
  user      [{"type":"t…[已硬截断]","text":"…[已硬截断]"}]     ← 判别字段被毁
  assistant [{"type":"text","text":"yyyy…[已硬截断]"}]
PROBE-G 非法 part.type  = ["t…[已硬截断]"]
PROBE-G truncated meta  = [{"ordinal":1,"tokens":2404,"meta_json":"{\"truncated\":{\"chars\":1,\"tokens\":1,\"originalTokens\":2404}}"}, ...]
```

**实测（PROBE-H：带图片 part 的消息）**：

```
PROBE-H 物化 parts =
  user [{"type":"text","text":"zzzz…[已硬截断]"},
        {"type":"…[已硬截断]","image":"…[已硬截断]","mediaType":"…[已硬截断]","width":640,"height":480}]
```

多模态 part 总是排在文本 part 之后（`engine.ts:67`），所以**只要一条带图消息被硬截断，图片 part 的 `type` 和 `image` 必被清空**——预算到那里一定已经是 0。

**影响**：

- 与 `T-CTX-01` 完全同级：`ModelMessage` 里出现未知 part type，provider 直接拒绝整个请求。
- **粘性**：`meta_json.$.truncated.chars = 1` 已经落库，`messages()` 每次物化都会重新按这个预算截一遍。会话在 `/new` 之前每轮都失败——**会话级永久损坏**。
- **新增的 `assertValidShape` 抓不到它**：`engine.ts:205-215` 只检查"tool 消息是否带 tool-result"和"tool-result 是否有前置配对的 tool-call"，不检查 part 的 `type` 是否属于已知判别集合。

**修复**——两处都要改：

1. `truncatePartStrings` 改成只截**载荷字段**，不碰结构字段：

```ts
const STRUCTURAL_KEYS = new Set(['type', 'toolCallId', 'toolName', 'mediaType', 'filename', 'providerExecuted']);
if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, STRUCTURAL_KEYS.has(key) ? child : visit(child)]));
```

2. `assertValidShape` 补一条不变量（这条会当场抓住上面两个探针，也会抓住任何未来"字符串遍历式"改写）：

```ts
const PART_TYPES = new Set(['text', 'image', 'file', 'reasoning', 'tool-call', 'tool-result']);
for (const part of parts) if (part?.type !== undefined && !PART_TYPES.has(part.type)) this.invalidShape(key, `unknown part type ${JSON.stringify(part.type)}`);
```

---

## 3. 新增 P1

| 编号 | 位置 | 问题 | 建议 |
|---|---|---|---|
| **R-TG-01** ★实测 | `packages/core/src/context/engine.ts:61`、`config/schema.ts` 的 `general.timezone` | `configSchema` 只要求 `timezone` 是字符串，不校验它是合法 IANA 时区。`renderArchivedMessage` 在**群聊分支**用 `new Intl.DateTimeFormat('zh-CN', { timeZone: timezone })`，非法值会抛 `RangeError`。实测：`PROBE-M schema 是否接受拼错的时区 = Asia/Shangahi`；`isPrivate=true → openTurn 成功`，`isPrivate=false → openTurn 抛出：Invalid time zone specified: Asia/Shangahi`。**私聊完全正常、群聊全灭**，所以 owner 在私聊里怎么测都发现不了 | schema 改用 `z.string().refine((zone) => { try { new Intl.DateTimeFormat('en', { timeZone: zone }); return true; } catch { return false; } }, '不是合法的 IANA 时区')`；`renderArchivedMessage` 里对 `Intl` 调用兜一层 try/catch 回退到 UTC |
| **R-BOT-01** ★实测（复刻） | `packages/telegram/src/bot.ts:271-285` | `concurrency.acquire()` 在 try/catch 里，但紧随其后的 `openTurn()`（第 278 行）、`turns.create()`（283）**在大 try 块（286 行）之外**。这几行抛出时：`release` 拿到了却永不调用、`reservation` 永不释放、`pendingId` 留在 registry 里。实测复刻这个顺序：`PROBE-N 复刻「openTurn 抛出且未 release」后 active = 1`，`第二轮 永久排队`。配合 `R-TG-01`（群聊每轮必抛）= **该会话在 `perKey` 次触发后永久卡死**，且额度被永久预留 | 把 278-285 行并入同一个 try，或改成 `try { ... } catch (error) { release?.(); if (reservation) quota.release(reservation); registry.finish(pendingId); throw error; }`。`openTurn` 内部也应在抛出前释放已经打上的背景消息认领（`archive.releaseClaims(turnId)`），否则那批消息同样丢失 |
| **R-API-01** ★实测 | `packages/server/src/app.ts:269` | `PATCH /api/tools/:name` 写入 `tools.overrides.<name>`，但 **schema 里根本没有 `tools.overrides`**，zod 非严格对象会静默丢弃它，且没有任何代码读取它。实测：`PROBE-K PATCH 状态 = 200 {"ok":true,"data":{"enabled":false}}`；`config_kv = [{"key":"tools.overrides.bash",...}]`；`解析后是否存在 tools.overrides = false`。[09 §180](./09-webui.md) 把这个端点记作「工具启停」——**运维在事故中点"禁用 bash"会得到成功提示，而 bash 依然完全可用** | 与已经修好的 `PUT /api/quota` 同款处理：要么真正接线（在 schema 加 `tools.overrides: z.record(z.object({ enabled: z.boolean() })).default({})`，并在 `ToolRegistry.active()` 里过滤），要么返回 `not_implemented` 并在 WebUI 置灰。**不能保留假成功** |
| **R-CFG-03** | `tests/config.test.ts:39-60` | `T-CFG-01` 的 CI 断言比看上去弱两层。**其一**，引用检测只按**叶子名**匹配（`config.test.ts:56-57` 的正则只取 `key.split('.').at(-1)`），任何叶子名与常见属性撞名的键都会被判为"已接线"。实测：215 个叶子里有 21 个仅靠撞名通过，其中 `telegram.webhook.url`、`telegram.webhook.path` 经人工确认**完全没有实现**——`main.ts:116` 只处理 `mode === 'polling'`，配成 `webhook` 的结果是 bot 建好了但既不 start 也不注册路由，**静默失联**（而 `telegram.webhook.secretToken` 反倒进了白名单，三个兄弟键的分类互相矛盾）。**其二**，文档同步断言 `expect(docs).toContain(\`\\\`${key}\\\`\`)` 是**空断言**——doc 11 是配置参考手册，每个键本来就都在里面。实测 `grep -c '🚧' docs/11-config-reference.md = 1`，唯一一处还是第 38 行解释这个标记的图例，**67 个键没有一个真的被标注** | 引用检测改成路径级（至少要求父段与叶子同时出现，或直接静态解析 `config.a.b.c` 成员访问链）；文档断言改成检查该键所在行必须含 `🚧`；`telegram.mode: 'webhook'` 在 `main.ts` 加显式 `throw new Error('webhook mode not implemented')`，不要静默不收消息 |

---

## 4. 新增 P2

| 编号 | 位置 | 问题 | 建议 |
|---|---|---|---|
| **R-MEM-01** ★实测 | `packages/core/src/memory/store.ts:114-121` | 段数超限的合并循环取 `keys().next().value` 作为 `oldest`，但当 `oldest` 恰好就是 `'其他'` 时，`merged` 与 `sections.get('其他')` 是**同一个数组**，`merged.push(...merged)` 把它自我复制一份，随后 `delete` + `set` 又把它移到末尾。实测落盘结果里 `- 开头的裸条目` 出现了两次。循环本身能终止（'其他' 移到末尾后不再命中），但每次触发都会静默复制一遍该段 | `if (oldest === '其他') { const rest = [...parsed.sections.keys()].find((name) => name !== '其他'); if (!rest) break; oldest = rest; }`，或干脆 `const merged = [...(parsed.sections.get('其他') ?? [])]` 断开别名 |
| **R-TG-02** | `packages/telegram/src/stream-output.ts:69-71` | 流式循环的 `catch { interrupted = true }` 吞掉**所有**异常，包括 `sendMessage` 的 Telegram API 错误（第 59 行那次发送没有 `send()`/`edit()` 那样的降级重试）。网络抖动会被呈现成「（生成中断）」，并让 `bot.ts:299` 调用 `generated.interrupt()` → `agents.fail(mainRun, 'stream_interrupted')`。**模型好好的，却被记成中断** | 区分来源：模型流的异常 → `interrupted = true`；Telegram 发送异常 → 记 `tg.error` 后继续消费流（内容仍会在第 76-83 行的收尾重发） |
| **R-API-02** | `packages/server/src/app.ts:259` | `content-disposition: attachment; filename="${row.name}"` 直接拼接 Telegram 侧的原始文件名。文件名含 `"` 会破坏参数解析；含 CR/LF 时 undici 构造 `Response` 直接抛 TypeError → 500 | 用 RFC 5987 形式：`filename*=UTF-8''${encodeURIComponent(name)}`，并对 fallback 的 `filename` 做白名单过滤 |
| **R-TOOL-01** | `packages/core/src/tools/builtins.ts:105-106` | `ask_parent` 里 `const answer = input.default ?? input.options?.[0];` —— 子 agent 只要给了 options，就会被**自己的第一个选项**回答，并返回 `{ ok: true, askId, answer, source: 'rule' }`。父 agent 从头到尾没参与。这与 `agent.askArbiter` / `agent.askEscalateToUser` 进白名单是自洽的，但**返回 `ok: true` 让子 agent 以为请示获批了** | 未实现期间返回 `{ ok: false, error: 'ask_parent_not_implemented' }`，与 `PUT /api/quota` 保持同一标准；或按 [04](./04-agents-and-providers.md) 真正实现父 agent 仲裁 |
| **R-DOC-01** | `docs/03-data-model.md` | 数据模型文档落后于迁移：`media_parts_json`（`0002_remediation.sql`）与 `claimed_by_turn`（`0004_claim_exclusive.sql`）两列在 doc 03 里出现 **0 次**，而 doc 03 是给出 `messages` 建表 DDL 的权威文档 | 补两列及其索引；同时把「认领独占性」的新语义（`claimed_at IS NULL` 过滤 + 提交/中止/崩溃三条释放路径）写进 [02 §104](./02-context-engine.md) 附近 |

---

## 5. 修复批次与一条结构性建议

### R0 · 止血（约 0.5 人日）

| # | 改动 | 对应 |
|---|---|---|
| 1 | `main.ts:22` 给 `loadConfig` 包 try/catch，失败时丢弃 DB 覆盖层启动并打印修复 SQL | R-CFG-01 |
| 2 | `readPersistedConfig` 过滤非法 schema 路径（或把 `/model`、`tools.overrides`、`plugin.*` 迁到 `app_kv` 表） | R-CFG-01 / R-CFG-02 / R-API-01 |
| 3 | `PATCH /api/chats/:key` 走 `runtimeConfigSchema.safeParse` | R-CFG-02 |
| 4 | `truncatePartStrings` 跳过结构字段 + `assertValidShape` 加 part type 白名单 | R-CTX-01 |

**建议同时准备一次性修复脚本**：`DELETE FROM config_kv WHERE key LIKE 'perChat.modelAlias.%' OR key LIKE 'tools.overrides.%';`——已经在跑的实例可能已经带着这颗雷。

### R1 · 收口（约 1 人日）

| # | 改动 | 对应 |
|---|---|---|
| 5 | `general.timezone` 加 IANA 校验 + `Intl` 调用兜底 | R-TG-01 |
| 6 | `bot.ts` 把 `openTurn`/`turns.create` 并入 try，异常路径释放并发槽、配额与认领 | R-BOT-01 |
| 7 | `PATCH /api/tools/:name` 真接线或返回 `not_implemented` | R-API-01 |
| 8 | CI 断言改成路径级引用检测；doc 11 逐项补 `🚧`；`telegram.mode: 'webhook'` 显式报错 | R-CFG-03 |
| 9 | R-MEM-01 / R-TG-02 / R-API-02 / R-TOOL-01 / R-DOC-01 | P2 五项 |

### 一条结构性建议：不变量要覆盖"写入方"，不只是"读出方"

[18 §5](./18-review-round3.md) 提的形状不变量已经落地成 `context.invariants.test.ts`，效果是实打实的——本轮上下文引擎只剩 1 个缺陷，且被限制在一个未被不变量覆盖的字段上。**这个方向要继续，但要补一层对称的东西。**

本轮三个 P0 里有两个（R-CFG-01、R-CFG-02）的形状完全相同：

> 一个命名空间有明确的、文档化的不变量（`configSchema` + perChat 白名单），验证器也正确实现了它，但**存在不经过验证器的写入方**。

上下文引擎已经把这件事做对了——`ordinal is assigned only during commit`、`turn_delta_finalized` 都是在写入侧设卡。配置层没有：`config_kv` 是一张任何人都能 `INSERT` 的裸表，而它同时是 `loadConfig` 的输入源。

建议加两条 CI 断言，成本很低但能一次性锁死这一类：

```ts
// 1. 任何写入 config_kv 的键，必须是合法 schema 路径
it('每个 config_kv 写入点的键前缀都是合法配置路径', () => {
  const keys = collectConfigKvWriteKeys(sourceFiles('packages'), sourceFiles('apps')); // 静态提取字面量与模板前缀
  const valid = new Set(configLeafPaths(configSchema.parse({})).flatMap(prefixes));    // 含所有中间路径
  expect(keys.filter((key) => !valid.has(key))).toEqual([]);
});

// 2. 任何持久化过的 config_kv 内容，重新加载必须成功
it('config_kv 的任意子集都不会让 loadConfig 抛出', async () => { /* 属性式：对已知写入点各造一条记录，逐个 loadConfig */ });
```

第 2 条是关键——它把"写入方不走校验器"这件事变成**当场红灯**，而不是等到某次重启才炸。同理，`assertValidShape` 的 part type 白名单也应当在 `insertTurn` 写入侧再断言一次，而不只在 `materialize` 读出侧。

---

## 6. 文档侧

| 项 | 状态 |
|---|---|
| [05 §344](./05-tools-and-permissions.md) 的 nonce 边界规格 | ✅ 代码已追上文档（上一轮是文档超前） |
| [08](./08-telegram-adapter.md) 的群聊渲染 | ✅ 已同步 `<group-message>` |
| [02](./02-context-engine.md) 的裁剪语义 | ✅ 已同步分级裁剪保留结构字段 |
| [11 §2.1](./11-config-reference.md) perChat 白名单 | ⚠️ 文档正确，但**没有任何一处提醒 `/model` 与 `PATCH /api/chats` 会写进这个命名空间**——建议在 §2.1 补一段"谁可以写 perChat" |
| [11](./11-config-reference.md) 的 `🚧` 标注 | ❌ 计数为 **1**，且是图例本身。67 个未接线键一个都没标 |
| [03](./03-data-model.md) 数据模型 | ❌ 缺 `media_parts_json`、`claimed_by_turn` 两列 |
| [09 §165 / §180](./09-webui.md) | ⚠️ 两个端点（`PATCH /api/chats/:key`、`PATCH /api/tools/:name`）记录的能力当前都不成立 |
| [13](./13-acceptance-criteria.md) | 自第二轮起未更新，`R-*` 相关的 AC 需要补 |

---

## 7. 测试覆盖

**本轮真实进步**：36 文件 / 86 用例（上轮 35 / 69）。`context.invariants.test.ts` 是这次最有价值的新增——6 个确定性种子 × 6 条不变量，正是 [18 §5](./18-review-round3.md) 建议的形态，而且它**确实起作用了**：本轮上下文引擎的新缺陷从 3 个降到 1 个。

**仍然空白的区域**（三个新 P0 都落在这里）：

| 区域 | 现状 | 建议最小用例 |
|---|---|---|
| 配置持久化往返 | 零覆盖。没有任何用例走 `写 config_kv → readPersistedConfig → loadConfig` 这条链 | 对每个已知写入点各造一条记录，断言 `loadConfig` 不抛 |
| WebUI 写端点的校验一致性 | `api.contract.test.ts` 只测了 providers/models/aliases 三个端点的校验 | 参数化：所有写端点对"schema 非法输入"必须返回 4xx |
| 硬截断路径 | `context.prune.test.ts` 覆盖了分级裁剪，但没有构造"截断预算压到 1"的极端场景 | 把 `assertValidShape` 的 part type 断言加进 `context.invariants.test.ts`，并把 limit 调到能逼出 `chars = 1` |
| 群聊 vs 私聊的分支差异 | 大量用例用 `isPrivate: true`，而 `renderArchivedMessage` 的群聊分支是独立代码路径 | 现有上下文用例参数化跑两遍 |

最后一条值得强调：**R-TG-01 之所以危险，正是因为它只在群聊触发**。测试里 `isPrivate` 的默认取值会系统性地漏掉这一整条分支。

---

## 8. 验收状态快照（粗估）

沿用前三轮的口径（[13](./13-acceptance-criteria.md) 的 253 条 AC，★ 为 62 条关键项）：

| 轮次 | 通过 | 比例 | ★ 关键项 |
|---|---|---|---|
| 第一轮复审后 | ~176/253 | 70% | 41/62 |
| 第二轮复审后 | ~189/253 | 75% | 47/62 |
| 第三轮复审后 | ~219/253 | 87% | 52/62 |
| **第四轮（现在）** | **~234/253** | **92%** | **57/62** |
| R0 修完预计 | ~245/253 | 97% | 60/62 |

分域看：

| 域 | 上轮 | 本轮 | 变化 |
|---|---|---|---|
| 上下文引擎 | 中 | **高** | `T-CTX-01/02/03` 全修 + 不变量测试落地，只剩 `R-CTX-01` 一条同族分支 |
| 安全边界 | 中 | **高** | `T-SEC-01/02/03` 全修，`untrusted()` 终于与规格一致 |
| Telegram 适配 | 中高 | 中高 | `T-TG-01` 修好且额外堵了说话人伪造，但新增 `R-TG-01`/`R-BOT-01` |
| 配置与 WebUI | 中 | **低** | 本轮首次深挖，暴露 3 个 P0/P1 —— 不是代码退步，是这块此前没被审到 |
| 扩展（skill/plugin/mcp） | 中高 | 中高 | `T-EXT-01` 修好；三个 `*.enabled` 开关仍是白名单里的空档 |

「配置与 WebUI」评分下降的原因和上一轮「上下文引擎」下降一样：**不是代码变差，是审查深度到了**。前三轮的注意力都在上下文引擎和安全边界上，配置持久化层是第一次被系统性地探针覆盖。

---

## 9. 本轮确认做得好的地方

1. **`elidePart` + `assertValidShape` 的组合**——不是只修 bug，而是同时补了"下次再犯会当场报错"的机制。`invalidShape()` 先记 `ctx.invalid_shape` 事件再抛错，排障信息给得很到位。
2. **`context.invariants.test.ts` 用确定性种子而非随机数**——既拿到了属性式测试的覆盖面，又保证了失败可复现，还绕开了 vitest 里随机测试难定位的老问题。
3. **`escapeForgedSpeakerPrefixes` 是主动加的**——第三轮报告里没提说话人前缀伪造，实现方自己想到了并且把它和 `<group-message>` 一起做掉。这是这四轮里第一次出现"修复超出报告范围且方向正确"。
4. **`T-CFG-01` 选了"显式分类 + CI 断言"而不是"假实现"**——67 个键老老实实列出来，比悄悄接一半线诚实得多。断言本身需要加强（`R-CFG-03`），但选择是对的。
5. **`claimed_at IS NULL` + `claimed_by_turn` + 三条释放路径**（提交 `context.ts:178`、中止 `engine.ts:143`、崩溃恢复 `database.ts:52`）——认领生命周期这次是闭合的，没有留下"只在 happy path 释放"的口子。
6. **`web.ts` 的 DNS 钉死**——自定义 `lookup` 把已校验 IP 传下去，同时保留 `Host` 与 `servername` 让虚拟主机和 TLS 仍然工作，每次重定向重新校验。这是 SSRF 防护里少见的做对了细节的实现。
7. **插件模块的 `?v=${signature}`**——从时间戳换成内容签名，既保留热重载又不再无限泄漏模块。

---

## 10. 一句话总结

第三轮的 12 项缺陷关掉了 11 项半，上下文引擎的连环模式**首次被打断**，形状不变量这条路走对了。本轮的三个 P0 全部集中在此前没被系统审查过的配置持久化层，其中 `R-CFG-01` 的触发条件是「任意 trusted 用户执行一次 `/model`」，后果是「下次重启起不来」——**这是四轮以来触发门槛最低、症状最延迟的一个缺陷，建议优先于其他一切处理**。

---

## 11. 修复记录（2026-08-15）

本轮 12 项缺陷已全部关闭。基线：`pnpm typecheck` 通过；`pnpm test` **38 个文件 / 98 个用例通过**（复审时为 36 / 86）。

### P0

| 项 | 改动 | 回归用例 |
|---|---|---|
| **R-CFG-01** | 新增 `app_kv` 表与迁移 `0005_app_kv.sql`，把 `perChat.modelAlias.*` 与 `plugin.*` 搬出 `config_kv` 并自动迁移历史数据；`/model` 改写 `app_kv`；`loadConfig` 在覆盖层校验失败时逐条剔除非法路径后重试，通过 `onInvalidOverride` 上报；`main.ts` 把被丢弃的键与清理 SQL 打进 stderr | `config.persistence.test.ts`：app_kv 隔离、0005 数据迁移、自愈剔除、`config.yaml` 自身非法仍然抛出 |
| **R-CFG-02** | `PATCH /api/chats/:key` 改走 `runtimeConfigSchema.safeParse` 并写 `config_revisions`；补上读取端 `perChatConfig()`，`openTurn` 合并覆盖、`onTurn` 改用 `turn.config`，写入不再是空操作 | `regression.round4.test.ts`：越界覆盖 400 且不落库、合法覆盖 200；`config.persistence.test.ts`：合并生效 |
| **R-CTX-01** | `truncatePartStrings` 跳过结构字段（`type`/`toolCallId`/`toolName`/`mediaType`…）；图片等不透明 part 改为整体保留或整体降级为占位文本；`assertValidShape` 增加 part type 白名单，并在 `commitTurn` 写入侧也断言一次 | `regression.round4.test.ts`：预算压到 1 时 type 完好、图片不半截、未知 part type 被拒收（已验证回退修复后该用例即失败） |

### P1

| 项 | 改动 | 回归用例 |
|---|---|---|
| **R-TG-01** | `general.timezone` 加 IANA 校验；`renderArchivedMessage` 的时间格式化兜底回退 UTC | `config.test.ts` 拒绝拼错时区；`regression.round4.test.ts` 群聊渲染不再抛 |
| **R-BOT-01** | `openTurn`/`turns.create` 并入 try，异常路径释放并发槽、配额预留与 pending 注册；`openTurn` 内部抛出时归还已打上的背景消息认领 | 现有 `turn.drain` / `cancel` 用例 + 手工复核 |
| **R-API-01** | schema 增加 `tools.overrides`；`ToolRegistry.bindOverrides()` 读热更新配置，`active()` 过滤 + `execute()` 硬拦截；端点校验 body、校验工具名、写 `config_revisions` 并广播 `config.changed` | `regression.round4.test.ts`：未知工具 404、非法 body 400、禁用后既不在目录也不可调用 |
| **R-CFG-03** | 引用检测改成路径级（连续后缀访问链 + 祖先整体传递两档）；doc 11 的白名单块由脚本按模块重排并逐行加 `🚧`，测试要求每个键都能找到同时含该键与 `🚧` 的行；`telegram.mode` 非 polling 时显式抛错；`telegram.webhook.url/path` 补进白名单 | `config.test.ts` 四个用例 |

### P2

| 项 | 改动 |
|---|---|
| **R-MEM-01** | 合并循环不再把「其他」当作合并来源，并改用新数组断开别名 |
| **R-TG-02** | 流式消费区分「模型流异常」与「Telegram 投递异常」；投递失败走 `onDeliveryError` 记 `tg.error`，不再误报「（生成中断）」和 `stream_interrupted` |
| **R-API-02** | `content-disposition` 改用 RFC 5987 `filename*`，ASCII fallback 逐字符过滤 |
| **R-TOOL-01** | `ask_parent` 不再拿子 agent 自己的 `options[0]` 伪造答复；无 `default` 时返回 `ask_parent_not_implemented` |
| **R-DOC-01** | doc 03 补 `media_parts_json`、`claimed_by_turn` 两列与两个部分索引，并新增 `app_kv` 表 |

### 文档同步

- [02](./02-context-engine.md)：硬截断补形状不变式说明；不变量清单新增第 14 条（part type 白名单，读出侧与写入侧都断言）。
- [03](./03-data-model.md)：`messages` 两列 + 索引、`app_kv` 表。
- [09](./09-webui.md)：`PATCH /api/chats/:key` 与 `PATCH /api/tools/:name` 两行补上真实语义。
- [11](./11-config-reference.md)：白名单块逐行加 `🚧`；§2.1 增加「谁可以写 perChat」与启动自愈说明。
