# 07 · Skill / Plugin / MCP 扩展生态

三种扩展机制，边界清晰：

| 机制 | 是什么 | 谁写 | 是否含代码 | 典型用途 |
|---|---|---|---|---|
| **Skill** | markdown 指令包（+ 可选附属脚本/资源） | 非程序员也能写 | 可选（脚本由 `bash` 工具跑） | 「怎么做某件事」的领域知识与流程 |
| **Plugin** | JS/TS 模块，注册工具/钩子/命令 | 开发者 | 是（进程内、全信任） | 新增真正的能力（接第三方 API、自定义钩子） |
| **MCP** | 外部 MCP server 提供的工具 | 第三方生态 | 外部进程/服务 | 复用现成 MCP 生态 |

---

## 2. Skill

### 2.1 目录与格式（Anthropic SKILL.md 兼容，D14）

```
skills/
  pdf-report/
    SKILL.md
    template.tex
    scripts/build.sh
  weekly-digest/
    SKILL.md
  music-download-cli/          # 装包装进来的（§2.5）
    SKILL.md
    scripts/invoke.sh
    references/cli-reference.md
    bin/music-download-cli
    .package.json              # 安装留痕：来源、安装时间、原档 sha256
  .staging-<pid>-<ulid>/       # 解包暂存，落位后即消失
  .backups/<name>-<ts>/        # 覆盖安装时旧的那棵
```

**点号开头的条目与非目录条目一律跳过**，不进 `skills` 表。`.staging-*` / `.backups/` 需要
这一条才能住在 `skills/` 里（同分区 `renameSync` 落位），而它本身也是独立正确的：在这之前
`skills/` 下一个 `.DS_Store` 会被扫成一行 `load_error` 假 skill。

`skills.source` 列（[03 §2.12](./03-data-model.md)）三个取值：`bundled`（随包那四份说明书）/
`package`（目录里有 `.package.json`）/ `local`（手写或 `write_skill` 写的）。

```markdown
---
name: pdf-report
description: 生成 PDF 报表。当用户要求"导出报表/生成 PDF/做一份周报"时使用。
allowed-tools: [read_file, write_file, bash, send_file]
min-role: trusted
model: high
version: 1.0.0
---

# 生成 PDF 报表

## 步骤
1. 用 `read_file` 读取数据源（默认 `/workspace/data.csv`）。
2. 复制本 skill 目录下的 `template.tex` 到 `/workspace/`。
3. 运行 `bash scripts/build.sh <输出名>`。
4. 用 `send_file` 把 `/workspace/<输出名>.pdf` 发给用户。

## 注意
- 数据超过 1000 行时先聚合，不要把原始数据塞进 LaTeX。
- 构建失败时把 `build.log` 的最后 30 行贴出来，不要重试超过 2 次。
```

**frontmatter 字段**

| 字段 | 必需 | 默认 | 说明 |
|---|---|---|---|
| `name` | ✓ | — | kebab-case，全局唯一，与目录名一致 |
| `description` | ✓ | — | **决定模型何时加载它**。必须写清「做什么 + 什么时候用」。上限 500 字符 |
| `allowed-tools` | ✗ | 继承角色白名单 | 载入后**收窄**可用工具（只能是角色白名单的子集，不能扩权） |
| `requires-tools` | ✗ | — | 这份 skill 讲的是怎么用哪几个工具。**它们不在本轮可用集里时整份 skill 不进目录**，`load_skill` 也拒（`skill_requires_unavailable_tools`）。与 `allowed-tools` 方向相反：那个是「载入后只准用这些」，这个是「这些不在就别看我」 |
| `min-role` | ✗ | `trusted` | 低于此角色的用户完全看不到该 skill |
| `model` | ✗ | — | 载入后建议切换的模型别名（写入 RUNTIME 块建议，模型可用 `set_model` 采纳） |
| `version` | ✗ | — | 展示用 |
| `enabled` | ✗ | `true` | 可在 WebUI 覆盖 |

### 2.2 渐进式披露（Progressive Disclosure）

系统提示词的 TOOL CATALOG 块里**只放 name + description**（每个约 30–60 token）：

```
可用 Skill（用 load_skill 载入后按其说明执行）：
- pdf-report: 生成 PDF 报表。当用户要求"导出报表/生成 PDF/做一份周报"时使用。
- weekly-digest: 汇总本周群聊要点。当用户说"总结这周"时使用。
```

```ts
load_skill: tool({
  description: '载入一个 Skill 的完整操作说明。载入后请严格按其步骤执行。',
  inputSchema: z.object({ name: z.string() }),
  execute: async ({ name }) => {
    const s = await skills.get(name);
    if (!s || !s.enabled)            return { ok:false, error:`Skill 不存在或已禁用: ${name}` };
    if (roleRank(role) < roleRank(s.minRole)) return { ok:false, error:'权限不足' };
    turn.runtime.loadedSkills.add(name);            // → 影响下一 step 的 activeTools
    return {
      ok: true, name, body: s.body,                 // SKILL.md 正文（frontmatter 已剥离）
      dir: s.relDir,                                // 供 read_file 访问附属资源
      allowedTools: s.allowedToolsEffective,        // 与角色白名单求交后的结果
      modelSuggestion: s.model ?? null,
      files: await skills.listFiles(name),          // 附属文件清单
    };
  },
})
```

载入后的效果（在 `prepareStep` 里实现）：
- `activeTools = 角色白名单 ∩ (⋃ 已载入 skill 的 allowed-tools ∪ 核心工具集)`；若某 skill 未声明 `allowed-tools`，则不收窄。

  **「未声明则不收窄」= 它对这个并集贡献空集**，不是「贡献当前全部可用工具」。这一点曾经反了：
  `SkillLoader.load()` 在未声明那一档交回的 `allowedTools` 等于「此刻全部可用工具」，而调用方
  无条件把它并进本轮允许集 —— 于是先载入一个 `allowed-tools: [read_file]` 的 skill、再载入一个
  不声明的，前一个的收窄就被整个抹掉了。所以 `load()` 另外交回一个 `narrows` 标志，只有它为真
  才动允许集：调用方分不清「收窄到这些」和「没收窄，这些是全部」，就必然会犯这个错。

  **核心工具集 = `load_skill` · `send_message` · `report_progress` · `context_stats`**
  （单一数据源：`packages/core/tools/policy.ts` 的 `SKILL_NARROWING_EXEMPT`，`prepareStep` 与
  `ToolRegistry.execute` 两处都读它）。`allowed-tools` 表达的是「这件事要用哪些工具」，不是
  「这一轮不许再干别的」—— 一个 `allowed-tools: [bash]` 的 skill 此前把这四个一起关掉，于是模型
  跑完 skill 连一句话都追发不出去、子 agent 连进度都报不了。豁免它们不是放权：`allowed-tools`
  只能是角色白名单的子集（见上表），交回去的仍然是该角色本来就有的东西。
- skill 正文作为一条 `role='system'`、`origin='note'`、`prune_level=2` 的消息进入 **delta**（因此可审计、会被裁剪、不占 `instructions`）。
- 同一轮多次载入同一 skill → 幂等，返回 `{ok:true, alreadyLoaded:true}` 不重复注入。

> 为什么不把所有 skill 正文都塞进系统提示词？因为 10 个 skill 就能吃掉 10k+ token。渐进式披露是 skill 机制的**核心价值**，必须实现。

### 2.3 加载与热更新

- 启动时扫描 `skills/*/SKILL.md`，解析 frontmatter（`gray-matter` + zod 校验），写 `skills` 表（`content_hash` 用于变更检测）。
- 文件监听（`chokidar`，`skills.watch` 默认 `true`）：变更 → 重新解析 → 更新表 → 广播 `EventBus('extensions.changed')` → 下一轮重建 TOOL CATALOG。
  **只在 `name → content_hash` 映射真的变了时才广播**：watcher 的 100ms 去抖之外再挡一层，
  否则一次装包过程中的每一次写盘都变成一次 SSE 推送 + 一次 WebUI 重新拉四个端点。
- **扫描末尾清理陈行**：`DELETE FROM skills WHERE name NOT IN (盘上这一批)`。`persist()` 只
  upsert，在这之前盘上删掉一个 skill 目录，那一行永远留在表里、永远显示在扩展页 ——
  唯一会删行的是 `SkillLoader.remove()`。**目录读取抛 `ENOENT` 的那一支不清理**：
  `skills.dir` 临时不在（换盘、挂载没起来）时清空整张表比留着陈行糟得多。
- 解析失败：写 `skills.load_error`，该 skill 标记不可用，WebUI 显红，**不影响其他 skill 与启动**。
- WebUI 可直接编辑 SKILL.md（带 frontmatter 表单 + 正文编辑器）、启停、查看解析结果与 token 占用。
  **随包那四份说明书只放行启停**：改正文 / 描述 / 删除一律拒（`skill_reserved`）。
  `write_skill` 从一开始就拒改它们（§6.3），而 WebUI 侧此前能改能删 —— 同一条不变量只焊住了一半。

### 2.4 Skill 目录的文件访问

- Skill 目录在 fs jail 之外（`skills/` 与 `data/workspace/` 是不同的根）。
- `load_skill` 返回 `dir` 后，`read_file` 允许以 `skill://<name>/<relPath>` 形式访问该 skill 目录（**只读**）。实现上在 `resolveJailed` 前拦截该 scheme，映射到 `skills/<name>/`，并禁止 `..`。
- Skill 附属脚本要在沙箱里跑：`load_skill` 时自动把 `skills/<name>/` 以只读方式挂载到容器 `/skill`（docker 模式）或拷贝到 `workspace/.luoli-skill/<name>/`（jail 模式）。

### 2.5 装一个 skill 包（zip / 目录）

§2.1 的格式一开始就允许附属文件，但**在这之前没有任何途径把它们放进去**：`write_skill`
的入参只有 `body: string`，`SkillLoader` 也只写一个 `SKILL.md`；`write_file` / `edit_file`
被 `selfAuthoringDenyGlobs()` 对 `skills/**` 关死。实测代价见 [00 §2](./00-state.md)：
用户在 Telegram 丢了一个带 `scripts/` + `bin/`（4.9 MB ELF）的音乐 skill 包，模型把它解到
**工作目录**、一路 `bash scripts/invoke.sh` 用了起来 —— 能用，但它不是一个 skill：
不进目录、不进 `skills` 表、扩展页看不见、`load_skill` 与 `skill://` 都够不着。

`installSkillPackage()`（`packages/core/src/skills/package.ts`）是这条通道的唯一实现，
模型侧的 `install_skill`（§6.5）与 WebUI 的 `POST /api/skills/package`（[09 §3.8](./09-webui.md)）
共用它 —— 端点自己抄一遍的话，两条路迟早在校验上分叉。

**流程**：解包到 `<skillsDir>/.staging-*/` → 逐条目校验 → 定位包根 → 改写 frontmatter →
`renameSync` 落位 → `scan()` 复核。复核发现 `load_error` 就整棵回滚进 `.backups/failed-*`
并报错：**「装了一半」不能留在目录里**，它在扩展页上和一个装好的坏 skill 长得一模一样。

**逐条目的判据**（zip 与目录两条来源共用同一份）：

| 挡什么 | 怎么挡 |
|---|---|
| zip-slip | 条目名含 `\0` / 绝对路径 / `..` 段一律拒；`resolve()` 之后再断言前缀包含。两道，因为第一道是形状判断而第二道是结果判断 |
| 符号链接 | 高 16 位 `S_IFMT === 0xa000` 一律拒。链接本身无害，但它能让 `skill://` 读出目录之外的东西，而 `resolveResource()` 的包含判断走的是 `resolve()` 不是 `realpath` |
| 条目数 | `skills.package.maxEntries` |
| 单文件体积 | `skills.package.maxFileBytes`，**按实际写出的字节数判，不信头里的 `uncompressedSize`** —— 那个字段是攻击者填的 |
| 总体积 / 压缩炸弹 | `skills.package.maxTotalBytes`，同样按实际写出的累计 |
| 执行位 | 一律 `0o600`（目录 `0o700`）；**只有 `scripts/` 与 `bin/` 下、且原条目带执行位的**保留 `0o700`，受 `skills.package.allowExecutable` 管（关掉 = 包退化成纯文本） |

**包根定位**：`SKILL.md` 常被套一层顶层目录，而一个包里可以有好几份（那个音乐包就同时带
`music-download-cli/` 与 `music-download-cli-linux/` 两套）。深度 ≤2 内恰好一个 → 取它所在
目录；多个 → 回 `skill_ambiguous_root` 并**把候选列出来**，让调用方带 `subdir` 重试。
一个都没有 → `skill_md_not_found`。

**落位前强制改写 frontmatter** 三件事：`name` 置为安装名（`scan()` 要求 `name === 目录名`，
包里写的那个未必对得上）、`enabled: false`（见 §6.1）、`min-role` 抬到不低于
`tools.selfExtend.skills.minRole`。包是别人写的，这三个字段不能由它自己说了算。

---

## 3. Plugin

### 3.1 形态

```
plugins/
  weather/
    plugin.ts
    package.json        # 可选，声明依赖（需 pnpm install 到根 workspace）
```

```ts
// plugins/weather/plugin.ts
import { definePlugin, tool, z } from '@luoli/plugin-sdk';

export default definePlugin({
  name: 'weather',
  version: '1.0.0',
  minRole: 'limited',
  configSchema: z.object({
    apiKey: z.string(),
    defaultCity: z.string().default('Beijing'),
  }),

  tools: ({ config, ctx, log }) => ({
    get_weather: tool({
      description: '查询城市天气。',
      inputSchema: z.object({ city: z.string().optional(), days: z.number().int().max(7).default(1) }),
      execute: async ({ city, days }) => {
        const r = await fetch(`https://api.example.com/w?q=${city ?? config.defaultCity}&d=${days}`,
                              { headers: { 'X-Key': config.apiKey } });
        if (!r.ok) return { ok: false, error: `上游返回 ${r.status}` };
        return { ok: true, ...(await r.json()) };
      },
    }),
  }),

  hooks: {
    // 归档之后、触发判定之前
    onMessage: async ({ message, ctx }) => { /* 可返回 { drop: true } 丢弃该消息 */ },
    // 快照已就绪、模型调用之前；可追加 delta 消息或改写 runtime
    beforeTurn: async ({ turn, ctx }) => {},
    // 每次模型调用前；可改写 settings（不可改 model —— 模型选择由 registry 统一负责）
    beforeModelCall: async ({ turn, step, settings }) => settings,
    // 工具调用前后（可用于自定义审计/限流；返回 { deny: reason } 可阻断）
    onToolCall: async ({ tool, input, turn }) => {},
    onToolResult: async ({ tool, output, turn }) => {},
    // delta 提交之后
    afterCommit: async ({ turn, commit }) => {},
    // 出站消息发送前（可改写文本，例如统一加签名）
    beforeSend: async ({ text, chatId }) => text,
  },

  commands: [
    { name: 'weather', description: '查天气', minRole: 'limited',
      handler: async ({ args, reply, ctx }) => { await reply(await fmt(args)); } },
  ],

  agents: [
    { name: 'weather-analyst', description: '分析多日天气趋势', modelAlias: 'low',
      tools: ['get_weather'], instructions: '...' },
  ],

  // 生命周期
  onLoad:   async ({ config, log, db }) => {},
  onUnload: async () => {},
});
```

### 3.2 加载规则

- **默认禁用**（`plugins.enabled=0`），必须 owner 在 WebUI 显式启用 —— plugin 是全信任代码，等同于给它 root。
- 加载方式：动态 `import(pathToFileURL(file))`，用 `tsx`/预编译（生产建议 `pnpm build:plugins` 产出 `.js`，避免运行时编译依赖）。
- 校验：`definePlugin` 返回值过 zod schema；`name` 必须与目录名一致且未被占用；工具名自动前缀 `<plugin>_<tool>`，冲突则加载失败。
- 配置：`configSchema` 生成 WebUI 表单；值存 `plugins.config_json`；含密字段（名字匹配 `/key|token|secret|password/i`）自动加密存储 + 前端只显示 hint。
- 隔离：**无沙箱**（进程内）。文档与 WebUI 必须明确警告：安装第三方 plugin 等同于运行任意代码。
- 崩溃隔离：所有 hook 调用包 try/catch，超时 `plugins.hookTimeoutMs`（默认 5000）；单个 plugin 连续失败 3 次自动禁用并告警（`plugins.load_error` 写入原因）。
- 热更新：`plugins.watch`（默认 `false`，因为卸载副作用难保证）。改动后在 WebUI 点「重载」，执行 `onUnload` → 清注册表 → 重新 import（Node ESM 需加 cache-busting query）。

### 3.3 Hook 执行顺序与并发

```
Update → [onMessage]*        （按 plugins.order 顺序串行；任一返回 drop 则终止链）
       → 归档 → 触发判定
       → openTurn → [beforeTurn]*  （串行）
       → loop:
           [beforeModelCall]* → 模型调用
           工具调用: [onToolCall]* → 执行 → [onToolResult]*
       → 输出: [beforeSend]*
       → commitTurn → [afterCommit]*  （并行，失败只记日志）
```

`plugins.order`（WebUI 可拖拽排序）决定同类 hook 的执行顺序。

### 3.4 `@luoli/plugin-sdk`

`packages/plugin-sdk` 只 re-export 稳定表面：`definePlugin`、`tool`、`z`、类型（`PluginCtx`、`TurnView`、`Role`）、`log`、只读 `db` 查询接口（**不暴露写接口**，plugin 想持久化用 `ctx.storage`：一个以 plugin 名为前缀的 KV）。语义化版本，破坏性变更升主版本。

---

## 4. MCP

### 4.1 配置

```yaml
mcp:
  enabled: true
  connectTimeoutMs: 15000
  servers:
    - name: filesystem
      transport: stdio
      command: npx
      args: ['-y', '@modelcontextprotocol/server-filesystem', './data/workspace']
      minRole: trusted
      toolAllow: ['read_*', 'list_*']
      toolDeny: ['write_*']
    - name: notion
      transport: http
      url: https://mcp.example.com/notion
      headers: { Authorization: 'Bearer ${env:NOTION_MCP_TOKEN}' }
      minRole: owner
      timeoutMs: 30000
```

### 4.2 接入实现

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const client = new Client({ name: 'luolicore', version: '0.1.0' });
const transport = srv.transport === 'stdio'
  ? new StdioClientTransport({ command: srv.command, args: srv.args, env: resolveEnv(srv.env) })
  : new StreamableHTTPClientTransport(new URL(srv.url), { requestInit: { headers: resolveEnv(srv.headers) } });
await client.connect(transport);
const raw = await client.listTools();
const tools = raw.tools.filter((tool) => matchAllow(tool.name, srv.toolAllow, srv.toolDeny));
```

> AI SDK v7 当前不导出 MCP client。本项目直接使用 `@modelcontextprotocol/sdk`；若后续 AI SDK 恢复稳定 MCP client，可在保持 `wrapMcpTool` 语义不变的前提下切换。

**入参 schema 必须接上。** MCP 的 `inputSchema` 是标准 JSON Schema，registry 只认 zod，
`packages/core/src/mcp/schema.ts` 的 `jsonSchemaToZod` 负责转换（覆盖 MCP 实际会产出的子集：
object/array/string/number/integer/boolean/enum/required/default/nullable；遇到 `$ref`/`oneOf`
这类表达不了的结构就把**那一个节点**退回 `z.unknown()` 宽松放行，而不是把整个工具打回通配）。
此前注册时整份换成 `z.record(z.unknown())`，模型拿到的工具定义是「一个任意对象」：只能靠工具名
猜参数名，猜错了 `execute()` 的 `safeParse` 也不拦，错误参数直接送到 MCP server —— MCP 工具在实践中
不可用，而注册是「成功」的（docs/20 · W-MCP-01）。

`wrapMcpTool` 统一施加：
- 角色检查（`srv.minRole`）；
- 超时 `srv.timeoutMs`（作为 `client.callTool` 的 `RequestOptions.timeout`；不接线的话一台卡住的
  server 能把整轮拖到轮次超时）；
- 输出裁剪 + `<untrusted-content source="mcp:<server>">` 包裹（[05 §7](./05-tools-and-permissions.md#7-提示注入防护)）；
- 日志 span（`kind='tool.mcp'`，记 server 名与耗时）；
- 审批规则（默认 `mcp__*` risk=medium ⇒ 命中 `approval.rules` 时需批准）。

### 4.3 生命周期

- **懒连接**：首次有角色 ≥ `minRole` 的 turn 需要该 server 时才连接；连接结果缓存。
- 健康：每 `mcp.healthCheckCron`（默认 5 分钟）`list_tools` 探活；失败标 `state='down'`，工具从注册表移除并在 RUNTIME 块中消失（模型不会调用不存在的工具）。
- stdio server 崩溃 → 自动重启，指数退避，最多 5 次后标 `down` 并告警。
- **配置里被移除或停用的 server 在下一次 `reconcile()` 就断开**（`state='disabled'`），连接参数
  （url/command/args/env/headers）变了也会先断旧连接再重连：只把工具从注册表摘掉的话，stdio 子进程
  会一直挂着，而缓存的 client 又会被当成「已连接」复用。`McpManager` 按 getter 读配置，
  `config.changed` 命中 `mcp.` 前缀时重跑 `reconcile()`，新增 server 不再需要重启（docs/20 · W-MCP-01）。
- 退出时统一 `client.close()`。
- WebUI：server 列表、状态、发现到的工具清单（含 schema 预览）、启停、`toolAllow/Deny` 编辑、手动重连、最近错误。

### 4.4 与自建工具的取舍（遵循 AI SDK 官方建议）

- **核心能力（fs、exec、检索、记忆、agent）一律自建**，不用 MCP —— 需要严格的 jail、审批、日志与类型安全。
- MCP 定位为「用户可选的第三方能力接入」，默认 `minRole=trusted`、默认全部 `enabled=0`。
- MCP 工具名冲突：加 `mcp__<server>__` 前缀天然隔离；同 server 内重名由上游负责。

---

## 5. 三者的统一注册流程

```ts
// ToolRegistry.forRole(role, ctx) 的组装顺序（后者不覆盖前者，冲突则报错并跳过）
const tools = {
  ...builtinTools(role, ctx),                       // 05 §3
  ...agentTools(role, ctx),                         // spawn_agent 等
  ...(cfg.skills.enabled ? { load_skill } : {}),    // skill 正文按需载入
  ...pluginTools(role, ctx),                        // <plugin>_<tool>
  ...(await mcpTools(role, ctx)),                   // mcp__<server>__<tool>
  ...customTools(role, ctx),                        // custom_<name>（§6）
};
// 再按 activeTools 收窄（skill 的 allowed-tools ∩ 角色白名单）
```

**总量护栏**：`tools.maxRegistered`（默认 80）。超出时按优先级截断（内建 100 > agent 90 > `load_skill` 80 >
plugin 60 > MCP 40 > 自定义 30），记 `warn` 日志并在 RUNTIME 块告知「部分扩展工具因数量上限未加载」。
工具描述总 token 也计入 `prompt.maxTokens` 预算。自撰写的排在最后：模型可以一口气造二十个，
让它先挤掉运维显式配的 MCP 是错的方向。

**装配顺序上，自定义工具最后 reconcile**（`main.ts`）：`registerExternal` 拒绝跨来源覆盖，先注册的赢，
于是重名时运维显式配的 plugin / MCP 压过模型自己造的那份 —— 方向是 fail-safe。

---

## 6. 自我扩展：模型给自己写工具 / skill / plugin / 装 MCP（M12）

`docs/14 §2 Q13` 拍板后加的。四条通道复用的都是本文前面已有的运行时机制，模型侧只是多了七个工具
（清单与权限档见 [05 §3.10](./05-tools-and-permissions.md)）。

### 6.1 一条共同的纪律

**模型能创建，但不能让自己创建的东西生效。**

| 通道 | 落地状态 | 谁能让它生效 |
|---|---|---|
| `define_tool` → `custom_tools` 表 | `enabled=0` | owner 在扩展页点启用；或运维打开 `tools.selfExtend.customTools.autoEnable` |
| `write_plugin` → `plugins/<name>/plugin.js` | 库里那行 `enabled=0` | 仅 owner（plugin 是进程内全信任 = root，§3.2 / [14 A27](./14-open-questions.md)） |
| `install_mcp` → `mcp.servers` | `enabled: false` | 仅 owner |
| `write_skill` → `SKILL.md` | 直接生效 | —— skill 是纯文本，不含可执行代码；约束是 `min-role` 有配置下限，且随包发的四份说明书不许覆写 |
| `install_skill` → `skills/<name>/` 一整棵 | `enabled=false` | 仅 owner（§6.5） |

**`write_skill` 直接生效而 `install_skill` 不行，差别在「纯文本」这个前提**：`write_skill`
写出去的就是一段 Markdown，最坏情况是一份误导性的说明书；而一个包带着 `scripts/` 与
`bin/`（那个音乐包里是一个 4.9 MB 的 ELF），启用它等于让模型读到一份「去跑这个自带二进制」
的说明书。那一步必须有人看过文件清单 —— 与 `write_plugin` / `install_mcp` 同一条理由。

**改动正文会把前三者打回未启用。** 没有这条，「先定义无害的、拿到启用、再改成恶意的」直接走通。
`write_plugin` 覆盖前还会把旧源码留一份 `plugin.js.bak-<ts>`（备份名不叫 `plugin.js`，`reconcile()`
不会去加载它）：这个入口现在也给模型用，而被覆盖的可能是运维手写的那份，`plugin.js` 没有
`write_file` 那样的回收站。
`custom_tools` 靠 `definition_hash` 判，plugin 靠 `PluginManager.writeSource` 里的内容比对
（那条不变量必须住在 manager 里：`reconcile()` 用 `sha256(文件+配置)` 当 ESM 的 cache-busting 签名，
改一个**已启用** plugin 的文件之后下一次 reconcile 就把新代码 import 进本进程了）。

### 6.2 自定义工具

一个自定义工具 = `{名字, 描述, 参数 JSON Schema, runtime: bash|python, 脚本正文, minRole, scope}`，
真相在 `custom_tools` 表（[03 §2.11](./03-data-model.md)），进程内那份是 `CustomToolManager` 的缓存、
每次 `reconcile()` 都能从库里重建（[01 §3.1](./01-architecture.md) 单实例纪律）。

- 注册：`jsonSchemaToZod`（与 MCP 共用）→ `registerExternal({source:'custom'})`，**逐行 try** ——
  一份畸形的 params 不能带走其余工具，更不能从这里抛到启动路径上（同 `docs/27 · C-04`）。
- 同步：每轮开始在 `runMainAgentInternal` 顶部调一次 `syncIfChanged()`，指纹是「条数 + max(updated_at)」。
  **条数不能省**：删掉一行不会推高 max，只看时间戳的话一次删除永远同步不过去。
  **只在主 agent 做** —— 子 agent 跑在父轮内部，在那里重扫会把父轮已冻结的 `toolSet` 弄脱节。
- 执行与参数契约、以及那七道闸各自挡什么：[05 §3.10](./05-tools-and-permissions.md)。
- `skills/` 与 `plugins/` 对 fs 工具一律关死，而且**由 `skills.dir` / `plugins.dir` 推出来**、
  叠在运维那份 `tools.fs.denyGlobs` 之上（`selfAuthoringDenyGlobs()`）。写死在 schema 默认值里
  的话，改过目录或自己写过一份 denyGlobs 的部署就一条都不生效 —— 而那正是最需要它的时候：
  `allowHostFsForOwner` 打开时 `write_file` 能绕过 `writeSource` 直接改一个已启用 plugin 的源码。

### 6.3 给模型的说明书

四份说明书都带 `requires-tools`（[§2.1](#21-目录与格式anthropic-skillmd-兼容d14)），因为
`min-role` 挡不住这件事：说明书讲的工具受 `tools.selfExtend.*` 控制、出厂是关的，而 skill 目录
只按角色过滤。**实测代价**：模型在目录里读到「用 `install_mcp` 装 MCP」，去调却没有这个工具，
于是花了八分钟用 `bash` 逆向代码库、从 `sessions` 表里取了一个 owner 会话去打 WebUI 的
`PUT /api/config` + `POST /api/mcp` 把事办了。一份「教你用一个你没有的工具」的说明书，
比没有这份说明书糟。

四份随包提交在 `skills/` 的 skill：`writing-tools` / `writing-skills` / `writing-plugins` /
`installing-mcp`，全部 `min-role: owner` + `requires-tools`。走的就是 §2.2 的渐进式披露 —— 平时只占目录里四行，
正文靠 `load_skill` 拉。新工具的 `description` 结尾指路（「写之前先 `load_skill("writing-tools")`」）。

`write_skill` 与 `install_skill` 都拒绝覆写这四个名字：模型把自己的说明书改坏之后，
下一次它就是照着改坏的那份写的。同一条现在也焊在 WebUI 侧（§2.3 末尾）。

### 6.4 WebUI

扩展页第四类，与 Skill / Plugin / MCP 同一张卡片布局（[09 §3.10](./09-webui.md)）。
两个动词分开：扩展页管「这个工具存不存在 / 审没审过」，工具页管「现在开着没有」。
未审阅的行带独立徽标（不是「停用」——「没人看过」和「有人看过之后关掉了」是两回事），
点开可以只读地看正文与参数；plugin 走 `GET /api/plugins/:name/source` 看源码。

装包进来的 skill 用的是同一套徽标：`source='package'` 且从未被启用过 = 未审阅，
详情里列出 `SKILL.md` 正文与附带文件清单（`SkillDefinition.files`）—— **要看的正是那份清单**，
「这个包往我机器上放了什么」是启用它之前唯一需要回答的问题。

### 6.5 装 skill 包（`install_skill`）

`inputSchema: { source, name?, subdir?, overwrite? }`，落地即停用，实现见 §2.5。

**`source` 只在两个地方解析**，别的一律 `skill_source_forbidden`：

- 本轮 `context.workspace` 之内（与 fs 工具同一个 `PathJail` 包含判断）；
- `<media.dir>/<本会话 chatId>/` 之下 —— 用户发来的附件就落在这里
  （`packages/telegram/src/media.ts`），而**这正是装包的主场景**：用户在聊天里丢一个 zip。
  限定到本会话的子目录，是因为 `media.dir` 底下按 chatId 分目录存着**所有**会话的附件，
  不限定就等于给了一条跨会话读文件的路。

`available()` 与 `write_skill` 共用 `tools.selfExtend.skills.enabled` 一个开关：两件事都是
「往 `skills/` 里写东西」，分成两个开关只会多出一种「开了一半」的状态。
