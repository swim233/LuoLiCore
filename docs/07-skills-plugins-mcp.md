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
```

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
- skill 正文作为一条 `role='system'`、`origin='note'`、`prune_level=2` 的消息进入 **delta**（因此可审计、会被裁剪、不占 `instructions`）。
- 同一轮多次载入同一 skill → 幂等，返回 `{ok:true, alreadyLoaded:true}` 不重复注入。

> 为什么不把所有 skill 正文都塞进系统提示词？因为 10 个 skill 就能吃掉 10k+ token。渐进式披露是 skill 机制的**核心价值**，必须实现。

### 2.3 加载与热更新

- 启动时扫描 `skills/*/SKILL.md`，解析 frontmatter（`gray-matter` + zod 校验），写 `skills` 表（`content_hash` 用于变更检测）。
- 文件监听（`chokidar`，`skills.watch` 默认 `true`）：变更 → 重新解析 → 更新表 → 广播 `EventBus('skills.changed')` → 下一轮重建 TOOL CATALOG。
- 解析失败：写 `skills.load_error`，该 skill 标记不可用，WebUI 显红，**不影响其他 skill 与启动**。
- WebUI 可直接编辑 SKILL.md（带 frontmatter 表单 + 正文编辑器）、启停、查看解析结果与 token 占用。

### 2.4 Skill 目录的文件访问

- Skill 目录在 fs jail 之外（`skills/` 与 `data/workspace/` 是不同的根）。
- `load_skill` 返回 `dir` 后，`read_file` 允许以 `skill://<name>/<relPath>` 形式访问该 skill 目录（**只读**）。实现上在 `resolveJailed` 前拦截该 scheme，映射到 `skills/<name>/`，并禁止 `..`。
- Skill 附属脚本要在沙箱里跑：`load_skill` 时自动把 `skills/<name>/` 以只读方式挂载到容器 `/skill`（docker 模式）或拷贝到 `workspace/.luoli-skill/<name>/`（jail 模式）。

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

`wrapMcpTool` 统一施加：
- 角色检查（`srv.minRole`）；
- 超时 `srv.timeoutMs`；
- 输出裁剪 + `<untrusted-content source="mcp:<server>">` 包裹（[05 §7](./05-tools-and-permissions.md#7-提示注入防护)）；
- 日志 span（`kind='tool.mcp'`，记 server 名与耗时）；
- 审批规则（默认 `mcp__*` risk=medium ⇒ 命中 `approval.rules` 时需批准）。

### 4.3 生命周期

- **懒连接**：首次有角色 ≥ `minRole` 的 turn 需要该 server 时才连接；连接结果缓存。
- 健康：每 `mcp.healthCheckCron`（默认 5 分钟）`list_tools` 探活；失败标 `state='down'`，工具从注册表移除并在 RUNTIME 块中消失（模型不会调用不存在的工具）。
- stdio server 崩溃 → 自动重启，指数退避，最多 5 次后标 `down` 并告警。
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
};
// 再按 activeTools 收窄（skill 的 allowed-tools ∩ 角色白名单）
```

**总量护栏**：`tools.maxRegistered`（默认 80）。超出时按优先级截断（内建 > agent > plugin > skill > MCP），记 `warn` 日志并在 RUNTIME 块告知「部分扩展工具因数量上限未加载」。工具描述总 token 也计入 `prompt.maxTokens` 预算。
