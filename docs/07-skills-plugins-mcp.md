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

`skills.source` 列（[03 §2.12](./03-data-model.md)）三个取值：`bundled`（随包那四份说明文档）/
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
| `allowed-tools` | ✗ | 继承角色白名单 | 载入后**收窄**可用工具（只能是角色白名单的子集，不能扩权）。**空列表 `[]` 等同于不写这个字段**（＝不收窄），见 §2.2 |
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

  **`allowed-tools: []` 归到「未声明」这一档，而不是「收窄到零个工具」。** 判据要写成
  「列表非空才算声明」（`meta['allowed-tools']?.length`），空数组在 JS 里是 truthy，写成
  `if (meta['allowed-tools'])` 就落进了声明那一档 —— 于是交集恒为空，`load_skill` 对任何角色
  都回 `skill_tools_unavailable`（owner 也一样，因为 `[].includes(x)` 与角色无关），而这份 skill
  照旧挂在目录里等模型去撞。**写入侧同样不许生成这个值**：`SkillLoader.write()` 只在列表非空时
  才落 `allowed-tools` 这一行（与 `requires-tools` 同一条规矩），否则 WebUI 扩展页那个留空的
  「允许工具」框（placeholder 写着「留空 = 沿用当前角色全部可用工具」）与 `write_skill` 不给这个
  参数的调用，都会把 `[]` 写进 frontmatter —— 实测代价是一份 `install_skill` 装好的 skill 在扩展页
  点一次保存就废掉，以及 `write_skill` 写出的 skill 从落盘那一刻起就没能载入过一次。
  「清空已有的 `allowed-tools`」仍然靠传 `[]` 表达：那一档写盘时省掉这一行，语义正是「不再收窄」。

  **核心工具集 = `load_skill` · `send_message` · `report_progress` · `context_stats`**
  （单一数据源：`packages/core/tools/policy.ts` 的 `SKILL_NARROWING_EXEMPT`，`prepareStep` 与
  `ToolRegistry.execute` 两处都读它）。`allowed-tools` 表达的是「这件事要用哪些工具」，不是
  「这一轮不许再干别的」—— 一个 `allowed-tools: [bash]` 的 skill 此前把这四个一起关掉，于是模型
  跑完 skill 连一句话都追发不出去、worker 连进度都报不了。豁免它们不是放权：`allowed-tools`
  只能是角色白名单的子集（见上表），交回去的仍然是该角色本来就有的东西。
- skill 正文作为一条 `role='system'`、`origin='note'`、`prune_level=2` 的消息进入 **delta**（因此可审计、会被裁剪、不占 `instructions`）。
- 同一轮多次载入同一 skill → 幂等，返回 `{ok:true, alreadyLoaded:true}` 不重复注入。

> 为什么不把所有 skill 正文都塞进系统提示词？因为 10 个 skill 就能吃掉 10k+ token。渐进式披露是 skill 机制的**核心价值**，必须实现。

**`load_skill` 与 `search_tools` 是同一个思想的两个通道**：一个展开**正文**（SKILL.md 那几 KB 操作说明），
一个展开**schema**（工具的描述与完整 JSON Schema，[05 §3.12](./05-tools-and-permissions.md)）。两笔账是
同一笔 —— 10 个 skill 的正文能吃掉 10k token，一台话多的 MCP server 的 schema 也能，而后者每 step 都
重发。所以两者的档位也对齐：`sourcePriority` 同为 80，同在 `SKILL_NARROWING_EXEMPT`，同在折叠豁免表。

两者叠加之后，本步的允许集是：

```
activeTools = (常驻 ∪ 本轮已展开) ∩ skill 允许集 ∩ 开轮冻结的 toolSet
```

最后那一项容易漏掉。前两项都是**每步现算**的（合格集走 `active()` 的过滤链、展开集是活的），而
`toolSet` 在开轮那一刻就冻结了（`runMainAgentInternal`）—— 轮中 MCP `reconcile` 新接一台 server、
或热更新放宽了 `tools.overrides`，都会让现算的那份里出现冻结集之外的名字。AI SDK 那边
（`filterActiveTools`）做的是纯交集，多报的名字被**静默丢掉**，所以漏掉这一项不会报错，会说假话：
`search_tools` 对一个轮中新挂的工具回 `status:'expanded'`，而它这一轮永远发不出去。显式写出这一项是
为了让「本步到底发得出哪些」只有一个答案，也为了不把正确性押在某个 SDK 版本恰好选了宽容语义上。

**先扩张后收窄，收窄永远赢。** 载入一个 `allowed-tools: [bash]` 的 skill 之后，已展开的 MCP 工具照样被
滤掉：展开改变的是可见性，不是权限，压不过收窄。`search_tools` 自己豁免于收窄，但它必须把这种命中
如实标成 `status:'narrowed'`（[05 §3.12](./05-tools-and-permissions.md)）。

**展开集「只增不减」是上面那条 `narrows` 教训的镜像。** 那一条栽在「分不清『收窄到这些』与『没收窄，
这些就是全部』」，只好另加一个标志位；这一条要分清的是「没展开过」与「展开了但一个都没命中」——
单调的集合天然区分这两种（前者是空集且永远不会被回收，后者只是这一次没往里加东西），所以不需要第二个
标志位。轮内不回收已展开的工具还有第二个理由：回收一次就是再打穿一次 tools 段的缓存前缀
（[04 §2.1](./04-agents-and-providers.md#21-prompt-缓存)）。

**行为悬崖有兜底，不只靠提示词引导。** 渐进披露的代价是模型看不见折叠工具的详情，因而可能想不到去检索
（[14 T20](./14-open-questions.md)）。`search_tools` 那侧挂了 `repairToolCall`：模型直接调一个
折叠工具时，这次调用被自动改写成一次 `search_tools({ names: [...] })`，下一步就真能调到
（[05 §3.12](./05-tools-and-permissions.md) 的「自愈」段）。`load_skill` 没有对应的兜底，因为 skill 名字
本来就整份列在目录里 —— 折叠工具是**名字在、详情不在**，两种缺口不同形。

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
  **随包那四份说明文档只放行启停**：改正文 / 描述 / 删除一律拒（`skill_reserved`）。
  `write_skill` 从一开始就拒改它们（§6.3），而 WebUI 侧此前能改能删 —— 同一条不变量只焊住了一半。

### 2.4 Skill 目录的文件访问

- Skill 目录在 fs jail 之外（`skills/` 与 `data/workspace/` 是不同的根）。
- `load_skill` 返回 `dir` 后，`read_file` 允许以 `skill://<name>/<relPath>` 形式访问该 skill 目录（**只读**）。实现上在 `resolveJailed` 前拦截该 scheme，映射到 `skills/<name>/`，并禁止 `..`。
- Skill 附属脚本要在沙箱里跑：`load_skill` 时自动把 `skills/<name>/` 以只读方式挂载到容器 `/skill`（docker 模式）。

### 2.5 装一个 skill 包（zip / 目录）

§2.1 的格式一开始就允许附属文件，但**在这之前没有任何途径把它们放进去**：`write_skill`
的入参只有 `body: string`，`SkillLoader` 也只写一个 `SKILL.md`；`write_file` / `edit_file`
被 `selfAuthoringDenyGlobs()` 对 `skills/**` 关死。实测代价（`logs/2026-08-18/tool.jsonl`
ts 1787036340–1787036441）：用户在 Telegram 丢了一个带 `scripts/` + `bin/`（4.9 MB ELF）的音乐
skill 包，模型把它解到**工作目录**、一路 `bash scripts/invoke.sh` 用了起来 —— 能用，
但它不是一个 skill：不进目录、不进 `skills` 表、扩展页看不见、`load_skill` 与 `skill://` 都够不着。

**那一整段里一次 `write_skill` 都没有，因为它不知道有这个工具。** `tools.selfExtend.skills.enabled`
出厂 `false` 且没人开过，被开关关掉的工具不进模型的工具目录，而**一个缺席的工具在模型侧没有任何
解释** —— 「这条通道存在但关着」这句话它拿不到，于是自己在工作区里凑了一套。运维侧那一半补上了
（扩展页的通道闸提示条，指名道姓说出真正关着的那个键，[09 §3.8](./09-webui.md)）；模型侧至今只有
§5 末尾 `maxRegistered` 截断那条 RUNTIME 告知算先例。§6.3 记的是反过来那一半：说明文档讲了一个
它没有的工具。

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

**畸形包只许让这一次装包失败，不许带崩进程。** 解每个条目的那条流上，error 闸必须挂在
`writePackageEntry` 的第一句、**早于它自己的第一个 `await`** —— 流拿到手时已经在流动
（`openReadStream` 内部就 pipe 上了 inflate），而随后那句 `open()` 是真的文件系统调用；
谎报大小的包会在这段窗口里吐 error，Node 对流上未处理的 error 直接抛。这条不变量由
AC-SKL-021 用一条「第一个 await 之前就带 error 死掉」的流确定性地钉住 —— 靠那个压缩炸弹去撞
是不确定的（并行跑全量测试时才崩，单跑十次都绿）。

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
- **热重载在 `pnpm dev`（tsx）下不生效，而且修不了。** tsx 的 ESM loader 按文件路径缓存模块、
  忽略 URL 上的 `?v=`，于是重载会照常跑完 `onUnload` / `onLoad`、更新数据库、不留 `load_error`，
  但加载到的仍是本进程第一次 import 的那份代码（实测改 11 版，每次 `onLoad` 打印的都是 v1，
  docs/28 · L-EXT-04）。生产不受影响 —— `pnpm start` 跑 `dist/` 的纯 node。
  按「摘除比伪造安全」，实现侧不假装修好，只把它说出来：`PluginManager.hotReloadReliable`
  （判据是「进程入口是不是 `.ts`」）为假时，启动落一条 `plugin.hot_reload_unreliable` 警告 +
  stderr，`POST /api/plugins/:name/reload` 的响应里带同一句话。要验证 plugin 改动就重启进程，
  或 `pnpm build && pnpm start`。
- cache-busting 本身**无界**（纯 node 下量化过，未修）：同一文件带唯一 `?v=` 连 import 30 次、
  每份模块级持有 4 MB → RSS 从 54 MB 涨到 175 MB，显式 `global.gc()` 后不回落。`onUnload` 能清掉
  规矩 plugin 注册的定时器与句柄，泄漏的是**模块记录本身与它持有的模块级内存** ——
  所以「反复重载」不是能长期跑的运维动作，重载多次之后该重启。

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
      # 「怎么登录」在配置里，**凭据本身不在**（见 §4.5）。none | bearer | oauth
      auth: { mode: oauth, scope: 'read write' }
      headers: { 'X-Tenant': acme }   # 非密用途；token 不放这里
      minRole: owner
      timeoutMs: 30000
```

> **`${env:NAME}` 只在 YAML 文件层展开**（`packages/core/src/config/index.ts`，理由见
> `docs/27 · S-06`：在 DB 覆盖层展开等于给了一条从任意非密配置键读出 `LUOLI_MASTER_KEY` 的路）。
> 所以 `headers: { Authorization: 'Bearer ${env:TOKEN}' }` 这个老写法**只在手写进
> `config/config.yaml` 时有效**；从 WebUI 或 `install_mcp` 建出来的 server 落在 `config_kv` 里，
> 那串 `${env:...}` 会被原样当成 header 值发出去。这条不对称是 §4.5 改用凭据库的原因之一。

**`toolAllow` / `toolDeny` 与目录折叠是两层，并存不冲突。** 前者是**连接期**过滤：`discover()` 在
`listTools()` 之后就把不匹配的条目丢掉（§4.2），那些工具**不存在** —— 不进注册表、不进 `toolSet`，
硬调撞 `admit()` 的 `unknown_tool`。折叠是**目录期**的：工具存在、可执行、只是在提示词里缩成折叠组里的
一行名字，`search_tools` 一调就回来（[05 §3.12](./05-tools-and-permissions.md)）。想真的不给就用
`toolDeny`（或 `tools.overrides.<name>.enabled=false`），想省 token 就让它折叠；拿折叠当访问控制是把
**可达性**误当**权限边界**，而前者由 AI SDK 的 `activeTools` 过滤决定、随时会变
（[05 §4](./05-tools-and-permissions.md#4-权限矩阵权威表) 末尾把这两层分开写了）。

一台 server 掉线时它的工具从注册表整批消失（§4.3），**折叠组那行摘要跟着一起消失** —— 摘要是每轮从
`active()` 现算的，不是缓存下来的一份清单。所以模型不会看着一行「`[mcp:github]` 12 个」去检索一台已经
连不上的 server。轮**中**掉线同理：已展开的名字在下一步的交集里自动掉出可见集，硬调由 `admit()` 兜住。

**折叠现在只对 lw-worker 生效，主 agent 那一侧根本没有可折叠的东西。** 这是 worker 重构翻过来的：
此前折叠服务于主 agent（工具全在它手里），而子 agent 的工具集由 `definition.tools` 白名单定死，
白名单比折叠更强，所以 `search_tools` 对它不可用。现在定义体系没了 —— lw-worker 拿的是调用者角色
下的**全集**，MCP / plugin / custom 那批全在它手里，折叠要省的正是这一份；而主 agent 的可调用集只剩
对话面与派发族，一个外部工具都没有。所以 `search_tools` 的那道闸从 `agentKind === 'main'` 翻成
`'lw'`（[05 §3.12](./05-tools-and-permissions.md) 不变量 4），展开集也跟着从 turn 挪到 run
—— 挂在 turn 上时 worker 展开的工具会写进主轮的展开集，而那正是原来那道闸存在的全部理由。

**主 agent 的 block 3 仍然列着全部折叠组**，但它描述的是 **worker 能做什么**，不是主 agent 能调什么
（[06 §1](./06-prompt-and-memory.md#1-系统提示词的固定结构)）—— 派发决策要看得见这些能力，
而 `WORKER_INTERNAL_TOOLS`（`ask_parent` / `report_progress` / `search_tools`）从这份目录里滤掉：
它们是 worker→父的通道，列出来会让模型以为自己可以派一个 worker 去上报进度。

### 4.2 接入实现

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const client = new Client({ name: 'luolicore', version: '0.1.0' });
const transport = srv.transport === 'stdio'
  // `stderr: 'pipe'` 不是可选项：SDK 默认 `'inherit'`，于是一台 server 打印的
  // 「打开这个链接授权」「缺 XXX_TOKEN」直接写进 bot 进程的 stderr —— 不进 LogSink、不落库、
  // 界面上一个字都没有，而那恰好是「它为什么连不上」的答案（§4.5）。
  ? new StdioClientTransport({ command: srv.command, args: srv.args, env: resolveEnv(srv.env), stderr: 'pipe' })
  // `authProvider` 只在 `auth.mode === 'oauth'` 时挂（§4.5 说明为什么不无条件挂）。
  : new StreamableHTTPClientTransport(new URL(srv.url), httpOptions(srv));
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
- **子进程死了要认得出来。** transport 的 `onclose` 把那条缓存标成非活，`connect()` 的短路判的是
  「指纹相同**且**还活着」—— 只比连接参数指纹的话，`kill -9` 之后那条死 client 永远命中，
  `mcp-health` cron 与 `POST /api/mcp/:name/reconnect` 走的是同一条路，于是两条恢复路一起变成死路
  （docs/28 · L-EXT-02）。**没有指数退避、没有重试上限**：判死之后就等下一次 `reconcile()`
  （健康检查 / 手动重连 / 配置变更）重连，连不上照旧记 `state='down'`。
- **`reconcile()` 整体串行，`connect()` 按 server 名串行**（`KeyedMutex`）。一次 `mcp.servers` 写入
  会触发两条重叠的 reconcile —— HTTP 端点自己 `await` 一条（响应里要给出真实 state），
  `config.changed` 的订阅者在 `loadConfig` 落地后再一条 —— 不串行化的话两条都会看到「还没连上」
  并各 spawn 一个 stdio 子进程，而缓存只留住后来的那个（docs/28 · L-EXT-03）。
  WebUI 那几个端点在 `config.changed` 载荷里带 `reconciled: ['mcp']` 让订阅者让位；
  模型侧的 `install_mcp` 不带，仍由订阅者负责。
- **工具目录是原子替换的**：先并行 `discover()` 到临时表，全部落定之后才在一个同步段里
  `unregisterBySource('mcp')` + 重新注册。反过来（先清空再逐台串行 await）会给模型开一段
  「一个 MCP 工具都没有」的窗口，每台最长 `mcp.connectTimeoutMs`（默认 15s），而健康检查默认
  5 分钟就开一次（docs/28 · L-EXT-05）。
- **配置里被移除或停用的 server 在下一次 `reconcile()` 就断开**（`state='disabled'`），连接参数
  （url/command/args/env/headers）变了也会先断旧连接再重连：只把工具从注册表摘掉的话，stdio 子进程
  会一直挂着，而缓存的 client 又会被当成「已连接」复用。`McpManager` 按 getter 读配置，
  `config.changed` 命中 `mcp.` 前缀时重跑 `reconcile()`，新增 server 不再需要重启（docs/20 · W-MCP-01）。
- 握手（或首次 `list_tools`）超时的那条**当场关掉**，不留到进程结束：不收的话健康检查每 5 分钟
  给一台「spawn 得起来但握不上手」的 server 多留一个子进程。
- 退出时关的是**所有建过、还没关完的 transport**，不只是缓存里那几条。MCP SDK 的
  `StdioClientTransport` 不 `unref` 子进程，而 `shutdown()` 只设 `process.exitCode` ——
  漏掉一条 refed handle，event loop 就不空，进程就不退（实测 SIGTERM 后存活 >100 秒，
  docs/28 · L-EXT-03）。
- WebUI：server 列表、状态（含 `needs_auth`）、凭据、工具清单（抽屉里带每个工具的描述）、启停、
  `toolAllow/Deny` 编辑、手动重连、登录 / 注销、最近错误。形状见 [09 §3.8](./09-webui.md)。

### 4.4 与自建工具的取舍（遵循 AI SDK 官方建议）

- **核心能力（fs、exec、检索、记忆、agent）一律自建**，不用 MCP —— 需要严格的 jail、审批、日志与类型安全。
- MCP 定位为「用户可选的第三方能力接入」，默认 `minRole=trusted`、默认全部 `enabled=0`。
- MCP 工具名冲突：加 `mcp__<server>__` 前缀天然隔离；同 server 内重名由上游负责。

### 4.4.1 浏览器类 MCP（JS 渲染 / 反爬 / 截图）

`web_fetch` 是一条 HTTP 请求：不跑 JS（SPA 只能取到空壳）、UA 是 `LuoLiCore/0.1`（不少站点直接
403）。要补上这一段的话，形态是**接一台浏览器 MCP**，而不是把渲染引擎接进 `web_fetch`。
[obscura](https://github.com/h4ckf0r0day/obscura)（Rust，Apache-2.0，自带 `obscura mcp`）是一个候选：

```yaml
mcp:
  enabled: true
  servers:
    - name: obscura
      transport: stdio
      command: obscura
      args: [mcp]
      minRole: owner        # ← 不要下调，理由见下
      enabled: false        # ← 默认关，运维自己开
```

> ⚠️ **它不受 `tools.web.allowlist` / `tools.web.denylist` 约束，也不走 `guardedFetch`。**
> 那一整套 SSRF 防护（`safeTarget` 的 DNS 钉定、私网/回环/元数据地址拦截、端口白名单、
> **每一跳重定向重新校验域名**）只长在 `web_fetch` 这条路上。`browser_navigate` 完全绕开它，
> 而且它**执行页面 JS** —— URL 预校验挡不住页面自己去打 `169.254.169.254` 或本机端口，
> DNS rebinding 也重新活了。换句话说：**开了它就等于给模型一个无限制的取网器。**
>
> 唯一的闸是 `mcp.servers[].minRole`（缺省取 `mcp.defaultMinRole`，默认 `owner`）。而
> `web_fetch` 对 `limited` 都是开的（且只在配了 allowlist 时才开），两者的门槛差着两档 ——
> 把这台 server 的 `minRole` 调到 `owner` 以下，等于把 `web_fetch` 那道白名单整个绕过去。
>
> 供应链上也值得单独拍一次板（截至 2026-08-20）：repo 建于 2026-04-13、owner 账号建于
> 2026-03-29 且无名无公司，21.7k star 对 72 watcher（正常基建项目在 10–30:1，这里 ~300:1），
> 同账号另一个 repo 是 reCAPTCHA solver。这些都不构成证据，但那个二进制会跑在持有
> `LUOLI_MASTER_KEY` 与 `BOT_TOKEN` 的进程旁边（stdio = 以 bot 进程的身份，沙箱之外）。
> 想降风险就用它的 docker 形态（`distroless/cc`，无 shell、无包管理器）或自己
> `cargo build --release -p obscura-cli --features render`，而不是下预编译产物。

它的 `browser_screenshot` 返回 MCP 图片，**这条路是通的** —— `ToolRegistry.bindMedia` 把
`{content:[{type:'image', data, mimeType}]}` 换成 `media`，走与 `web_fetch` 完全同一条落地路径
（`web_assets` → `webasset://` 顶层 part → 骑工具结果给本步，见 [05 §3.6](./05-tools-and-permissions.md)）。
不做这一步的话它会被 `#normalizeOutput` 截成半截 base64 当不可信文本交给模型：既看不见图，
又把整个 64KB 输出预算烧光。

值不值得深度集成（把渲染接进 `web_fetch`，代价是给它套 egress 限制才算真正闭合）是
[00 §待议](./00-state.md) 里的一条，先按上面这个形态验证效果：拿一个 SPA 比
`browser_snapshot` 与 `web_fetch` 的正文长度、一个 Cloudflare 站、一次 `browser_screenshot`。

### 4.5 需要登录的 server

远端 MCP server 常常要登录。此前这条路是**结构上走不通**的，而且看不出来走不通：

`StreamableHTTPClientTransport` 没有传 `authProvider`，而 SDK 那条 401 分支是
`if (response.status === 401 && this._authProvider)` —— 于是 `UnauthorizedError`
在本仓库**构造不出来**，一台要登录的 server 只留下 `state='down'` 加一句
`Error POSTing to endpoint: <原始响应体>`。stdio 那侧更糟：`stderr` 是 SDK 默认的 `'inherit'`，
server 打印的授权链接直接写进 bot 进程的 stderr，然后握手 15 秒超时判死、`mcp-health` 每 5 分钟
再来一次，无退避无上限。

界面那一半（要登录的行排最前、〔登录〕/〔注销〕两个动作、凭据只露末 4 位）在
[09 §3.8.1](./09-webui.md#381-需要登录的-mcp-server)。

#### 凭据存哪儿：`mcp_auth` 表，不在配置里

`migrations/0011_mcp_auth.sql` + `packages/db/src/mcp-auth.ts`（`McpAuthRepository`）。
一行一台 server，密文一律经 `Secrets`（AES-256-GCM + scrypt，`LUOLI_MASTER_KEY`），
`hint` 只留 bearer token 的末 4 位。加解密由调用方注入（`SecretCodec`）—— `Secrets` 住在
`packages/core`，而依赖方向是 `shared → db → core`。

**为什么不放 `mcp.servers` 配置里**（三条，缺一条都不够）：

1. `config_kv` 的每一行都会被 `loadConfig` 当**配置覆盖层**解析；
2. 配置写入要进 `config_revisions`（审计，存完整值）；
3. `GET /api/config/export` 与 `/api/config/yaml` 会把非密的行原样导出。

而按键名判密的那条正则是 `/key|secret|token|password/i`（`packages/core/src/config/redact.ts`），
它**匹配不到 `Authorization`**。于是一个只用 `headers: { Authorization: 'Bearer …' }` 的 server，
它的 token 明文进了 revision、也从配置导出里原样出来 —— `secretConfigRow` 的两个判据同时为假，
那一行压根不会被跳过。用 `env.XXX_TOKEN` 的 server 反而是安全的。**同一件事按用哪个通道决定
安不安全**，这本身就是要修的东西。凭据搬进 `mcp_auth` 之后，配置里只剩「用哪种方式登录」。

#### 三种 `auth.mode`

| mode | 谁在登录 | 实现 |
|---|---|---|
| `none` | 不需要 | 不挂 `authProvider`。撞上 401 时**照样记 `needs_auth`**（判据见下），提示语指向「去把 `auth.mode` 改掉」 |
| `bearer` | 运维把一个长期 token 填进来 | 连接时从 `mcp_auth` 取出、注入 `Authorization` header。**拿不到就不编一个空 Bearer 发出去** —— 那样对方回的是「token 无效」，而真相是本地没有这一份 |
| `oauth` | 人在浏览器里授权一次 | 挂 `McpOAuthProvider`（`packages/core/src/mcp/oauth.ts`），SDK 的 `auth()` 走完发现 → 动态注册 → PKCE 授权码 → 换 token → 自动 refresh |

**`none` 模式不挂 `authProvider` 是有意的。** 无条件挂上去能让 401 检测「免费」，但代价是：
一台运维还没决定要不要接的 server，我们会替他去对方那里跑一遍 RFC 7591 动态注册。
所以 `none` / `bearer` 走另一条判据 —— `StreamableHTTPError.code` 是 401/403
（没挂 provider 时 SDK 就是抛这个），加一条兜底的消息匹配。三种来源都归到
`looksLikeAuthFailure()` 一处。

#### `needs_auth` 是独立一档

`mcp_servers.state` 多这一个值（那一列没有 CHECK 约束，不需要迁移）。它跟 `down` 分开是因为
**运维动作完全不同**：前者要人去点一次授权，后者要人去看命令行 / 网络。`last_error` 换成一句
按 `auth.mode` 分岔的人话，而不是原始响应体。

#### OAuth 流程的四条纪律

1. **`redirectToAuthorization` 不重定向。** 它把授权 URL 记进进程内的 `PendingAuthorizations`，
   然后让 `connect()` 抛 `UnauthorizedError`、manager 记 `needs_auth`。人是在扩展页点〔登录〕
   才去那个 URL 的 —— 一次 reconcile 不该自己弹浏览器。
2. **待授权表照 `issueLoginToken` 的三条**（`packages/server/src/app.ts`）：进程内、不落库、
   不记进日志；`state` 单次使用（读即删）、10 分钟 TTL、最多 16 条。一台 server 只留最后一条，
   所以连点两次〔登录〕之后先点的那一条换不到凭据。
3. **换码不需要留住 transport。** `finishAuth()` 是 transport 上的方法，而失败路径上那条
   transport 早就被 `#discard` 掉了；`auth(provider, { serverUrl, authorizationCode })` 走同一套
   逻辑而不依赖连接。换完 token 再单台 `connect()`，不做整体 reconcile（那会让另外几台健康
   server 也跟着断一次）。
4. **`webui.publicUrl` 没配就不开始。** `redirect_uri` 一旦注册进对方那里就不好改，编一个
   127.0.0.1 的地址等于把这次授权变成一条注册完就废掉的死路。照 `/webui` 命令没配 publicUrl 时
   那句话的做法，指名道姓说缺什么。

#### 连接指纹必须带凭据版本

`fingerprint()` 原本是 `[transport, command, args, env, url, headers]`。凭据从 `headers` 搬进
`mcp_auth` 之后，**轮换一次 token 不会改变上面任何一项** —— `existing.fingerprint === print`
会命中旧连接，拿着已经作废的 token 一直用下去，而界面上那台 server 还显示「已连接」。
所以 `mcp_auth.version` 进指纹，且**所有写凭据的路径都走同一个 `#write`**（漏一条就是漏一次
强制重连）。`tests/mcp.oauth.test.ts` 里那条「轮换 token 真的换掉连接」焊的就是这件事。

#### stdio server：帮不上，但别把它说的话丢掉

一台 stdio server 的「登录」是它自己在带外做的 —— 它继承 `HOME`，所以 `~/.mcp-auth`
这类磁盘缓存本来就能用（照 `spawn_harness` 的先例：**harness 自己的登录态不进本项目的
`config_kv`** —— 那是它自己的凭据，我们既不管理也不代存，见 [05 §3.5](./05-tools-and-permissions.md)）。我们能做的就是 `stderr: 'pipe'`，逐行进 `LogSink`（新 kind `mcp.stderr`，
warn 级，单行截到 2 KB，缓冲上界 8 KB）。这一条独立于 OAuth，是这一整块里最便宜的一半。

#### 清理

`reconcile()` 顺手 `prune` 掉配置里已经没有的 server 的凭据（照 `SkillLoader.scan()` 末尾清陈行的
做法）。判据用**整份 `servers`** 而不是「本次要连的那些」—— 停用一台 server 不该把它的 token
一起丢掉，否则「停一下再开」等于要人重新登录一次。

#### 回路怎么焊住

`tests/mcp.oauth.test.ts` 对着 `tests/fixtures/mcp-oauth-server.ts` 跑 —— 一台自带授权服务器的
受保护 MCP server，**没有 mock**：PKCE 真的验（`code_challenge_method=S256`）、`code` 与 `state`
都是一次性的、access token 过期真的走 refresh 换新的且授权端点一次都不再被打。三层里任何一层的
形状写错这里都会红。条目见 [13 AC-MCP-013…021](./13-acceptance-criteria.md)。

---

## 5. 三者的统一注册流程

```ts
// ToolRegistry.forRole(role, ctx) 的组装顺序（后者不覆盖前者，冲突则报错并跳过）
const tools = {
  ...builtinTools(role, ctx),                       // 05 §3
  ...agentTools(role, ctx),                         // spawn_worker 等
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

**注册完之后再切一刀：常驻 / 折叠。** 上面那份 `tools` 是**全集**，它整份进 `toolSet`（开轮冻结，
[04 §2.1](./04-agents-and-providers.md#21-prompt-缓存)）；提示词的 TOOL CATALOG 块与 provider 的 tools 数组
看到的是它按 `tools.catalog.*` 二分出来的常驻那一半，折叠的那一半每组只留一行名字，靠 `search_tools`
按需展开（规格见 [05 §3.12](./05-tools-and-permissions.md)）。判据在**查询期**算、不在 `RegisteredTool`
上打标 —— 打标会被 MCP reconcile 与配置热更新弄脏：

判据按**代码里的顺序**读（前四级只要命中一条就「一律不折叠」，`#deferredFor` 立刻返回 false）：

```
① deferExternal 不为 true（或整段缺席）→ 一律不折叠            ← 总开关，管全部来源
② search_tools 被运维禁用            → 一律不折叠（梯子没了）
③ 本角色够不到 search_tools 的生效 minRole → 一律不折叠（同上，按角色）
④ 豁免表（search_tools / load_skill）      → 永不折叠
⑤ tools.catalog.resident 的 glob 命中     → 强制常驻（压得过 defer）
⑥ builtin / agent                        → 默认常驻，只有 tools.catalog.defer 的 glob 点名才折叠
⑦ 其余（mcp / plugin / custom）           → 折叠
```

**① 是总开关这一点要读准：**`deferExternal: false` 配上 `defer: ['bash']` 折叠的是**零个工具**，
不是「只折叠 bash」—— `defer` 与 `resident` 都只在折叠机制开着时才有意义。
**②③ 是同一条不变量的两半**（[05 §3.12](./05-tools-and-permissions.md) 不变量 3）：能展开的那个工具
一旦对当前角色不可用，折叠必须整体回退，否则就留下「看得见摘要却没有任何路径展开」的形态。
③ 判的是**生效** minRole（`TOOL_POLICY` 叠加 `tools.overrides.search_tools`），且**按角色**回退 ——
把它抬到 `owner` 的效果是 owner 那边照旧折叠、trusted 及以下整体回退。

折叠组的 key 从**既有命名空间**派生，不新增字段（[05 §3.9](./05-tools-and-permissions.md) 那套命名）：
`mcp__<server>__*` → `mcp:<server>`；`custom_*` → `custom`；plugin → `plugin`；被点名的内建 → `builtin`。

**`maxRegistered` 的语义不变，它作用于上面那个全集。** 折叠工具照占名额：名额护的是 `toolSet` 这个
**可执行面**，不是提示词长度。折叠解除的是「注册数 ∝ 每步 token」这条正比关系，所以运维现在可以放心
把它调大。代价是一条硬约束：**折叠组的摘要行严格从截断之后的集合生成** —— 被砍掉的名字不进摘要，
否则模型会去展开一个 `toolSet` 里压根没有的工具。

**「在 RUNTIME 块告知」从此是承诺而不是欠账。** 撞上截断时 RUNTIME 块输出一行事实：共注册 N 个、
按来源优先级只保留前 M 个、其余本轮不可用、以及那个配置键的名字（体例与措辞见
[06 §1.2](./06-prompt-and-memory.md#12-block-6-runtime-模板)）。它**不受 `prompt.runtimeBlock.show.*` 管**
—— 那些开关管的是「要不要显示某类状态」，而这一行说的是一件已经发生的事（照「上下文：刚被清空」那条
先例）。`AC-TOOL-020` 此前只落地了「按优先级截断 + warn 日志」，模型对自己少了什么完全不知情，
唯一凭据是一条没人看的 `tool.registry_truncated`。

---

## 6. 自我扩展：模型给自己写工具 / skill / plugin / 装 MCP（M12）

`docs/14 §2 Q13` 拍板后加的。四条通道复用的都是本文前面已有的运行时机制，模型侧只是多了八个工具
（清单与权限档见 [05 §3.10](./05-tools-and-permissions.md)）。**`tools.selfExtend.*` 出厂全关**
（一个主闸 + 四个子闸）：打开之后模型才能写自定义工具 / skill / plugin、登记 MCP server。

### 6.1 一条共同的纪律

**模型能创建，但不能让自己创建的东西生效。**

| 通道 | 落地状态 | 谁能让它生效 |
|---|---|---|
| `define_tool` → `custom_tools` 表 | `enabled=0` | owner 在扩展页点启用；或运维打开 `tools.selfExtend.customTools.autoEnable` |
| `write_plugin` → `plugins/<name>/plugin.js` | 库里那行 `enabled=0` | 仅 owner（plugin 是进程内全信任 = root，§3.2 / [14 A27](./14-open-questions.md)） |
| `install_mcp` → `mcp.servers` | `enabled: false` | 仅 owner |
| `write_skill` → `SKILL.md` | 直接生效 | —— skill 是纯文本，不含可执行代码；约束是 `min-role` 有配置下限，且随包发的四份说明文档不许覆写 |
| `install_skill` → `skills/<name>/` 一整棵 | `enabled=false` | 仅 owner（§6.5） |

**`write_skill` 直接生效而 `install_skill` 不行，差别在「纯文本」这个前提**：`write_skill`
写出去的就是一段 Markdown，最坏情况是一份误导性的说明文档；而一个包带着 `scripts/` 与
`bin/`（那个音乐包里是一个 4.9 MB 的 ELF），启用它等于让模型读到一份「去跑这个自带二进制」
的说明文档。那一步必须有人看过文件清单 —— 与 `write_plugin` / `install_mcp` 同一条理由。

**改动正文会把前三者打回未启用。** 没有这条，「先定义无害的、拿到启用、再改成恶意的」直接走通。
`write_plugin` 覆盖前还会把旧源码留一份 `plugin.js.bak-<ts>`（备份名不叫 `plugin.js`，`reconcile()`
不会去加载它）：这个入口现在也给模型用，而被覆盖的可能是运维手写的那份，`plugin.js` 没有
`write_file` 那样的回收站。
`custom_tools` 靠 `definition_hash` 判，plugin 靠 `PluginManager.writeSource` 里的内容比对
（那条不变量必须住在 manager 里：`reconcile()` 用 `sha256(文件+配置)` 当 ESM 的 cache-busting 签名，
改一个**已启用** plugin 的文件之后下一次 reconcile 就把新代码 import 进本进程了）。

**这条纪律的边界要读准：启用闸防的是「只有工具的模型」，不防一段已经在宿主上跑起来的脚本。**
`tools.selfExtend.customTools.requireSandbox` 出厂关着，此时一个自定义工具就是调用者的 `bash`
（owner 还命中 `sandbox.bypassRoles`），因而能直接写 `data/luoli.db` —— `tools.fs.denyGlobs` 只被
`PathJail` 执行，沙箱不看它，上面那张表里的 `enabled` 对它不成其为闸。**动这一块之前先读
[14 T18/T19](./14-open-questions.md)**：门总共只有四道（角色地板 + 沙箱判据 + 会话作用域 + 启用闸，
逐道挡什么见 [05 §3.10](./05-tools-and-permissions.md)），别以为脚本跑起来之后还有第五道；而
**授权时点与执行时点是分离的** —— 正文是若干轮之前写下的、写进了 SQLite，而 SQLite 不在提示词里。

### 6.2 自定义工具

一个自定义工具 = `{名字, 描述, 参数 JSON Schema, runtime: bash|python, 脚本正文, minRole, scope}`，
真相在 `custom_tools` 表（[03 §2.11](./03-data-model.md)），进程内那份是 `CustomToolManager` 的缓存、
每次 `reconcile()` 都能从库里重建（[01 §3.1](./01-architecture.md) 单实例纪律）。

- 注册：`jsonSchemaToZod`（与 MCP 共用）→ `registerExternal({source:'custom'})`，**逐行 try** ——
  一份畸形的 params 不能带走其余工具，更不能从这里抛到启动路径上（同 `docs/27 · C-04`）。
- 同步：每轮开始在 `runMainAgentInternal` 顶部调一次 `syncIfChanged()`，指纹是「条数 + max(updated_at)」。
  **条数不能省**：删掉一行不会推高 max，只看时间戳的话一次删除永远同步不过去。
  **只在主 agent 做** —— worker 跑在父轮内部，在那里重扫会把父轮已冻结的 `toolSet` 弄脱节。
- 执行与参数契约、以及那七道闸各自挡什么：[05 §3.10](./05-tools-and-permissions.md)。
- `skills/` 与 `plugins/` 对 fs 工具一律关死，而且**由 `skills.dir` / `plugins.dir` 推出来**、
  叠在运维那份 `tools.fs.denyGlobs` 之上（`selfAuthoringDenyGlobs()`）。写死在 schema 默认值里
  的话，改过目录或自己写过一份 denyGlobs 的部署就一条都不生效 —— 而那正是最需要它的时候：
  `allowHostFsForOwner` 打开时 `write_file` 能绕过 `writeSource` 直接改一个已启用 plugin 的源码。

### 6.3 给模型的说明文档

四份说明文档都带 `requires-tools`（[§2.1](#21-目录与格式anthropic-skillmd-兼容d14)），因为
`min-role` 挡不住这件事：说明文档讲的工具受 `tools.selfExtend.*` 控制、出厂是关的，而 skill 目录
只按角色过滤。**实测代价**：模型在目录里读到「用 `install_mcp` 装 MCP」，去调却没有这个工具，
于是花了八分钟用 `bash` 逆向代码库、从 `sessions` 表里取了一个 owner 会话去打 WebUI 的
`PUT /api/config` + `POST /api/mcp` 把事办了。一份「教你用一个你没有的工具」的说明文档，
比没有这份说明文档糟。

四份随包提交在 `skills/` 的 skill：`writing-tools` / `writing-skills` / `writing-plugins` /
`installing-mcp`，全部 `min-role: owner` + `requires-tools`。走的就是 §2.2 的渐进式披露 —— 平时只占目录里四行，
正文靠 `load_skill` 拉。新工具的 `description` 结尾指路（「编写前先调用 `load_skill("writing-tools")`」）。

`write_skill` 与 `install_skill` 都拒绝覆写这四个名字：模型把自己的说明文档改坏之后，
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
