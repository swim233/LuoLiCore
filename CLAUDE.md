# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 语域

**与用户的每一条对话回复、以及一切中文文案，都按 `copy-restyle` skill 的判据写**
（`~/.claude-neko/skills/copy-restyle/`）。写或改按钮、标签、空态、二次确认、报错、告警、
配置项说明、系统提示词、工具描述与参数说明时整份加载；日常对话按本节这几条。

目标语域：**陈述句、并列短句、名词化、无连词**。专业、简约、不用比喻式表达。

不写：

- **框架句 / 总起句** —— `四类扩展各自扩充模型的能力：Skill 提供…、MCP 接入…`
- **因果连词串场** —— `…由 load_skill 加载时才注入，所以描述那一行决定模型能否判断何时该读它`
- 「平时…才…」「其实」「就是」「值得一提」；`真的 / 确实 / 本来 / 照常 / 反正` 一律删
- **拟人 / 场景化叙述** —— `它把自己的工具动态注册进模型目录`、`那一行会显示「要登录」`
- **面向读者的说教** —— `这一点要写在弹窗里 —— 否则运维会以为…`
- **长复句**（一句套三个从句）、口语量词与指代（`一台 MCP server`、`那一行`、`这一格`）
- **安抚 / 庆祝** —— `一切正常`、`没有等着人看的东西`
- 口语动词与可能补语：`跑` → 运行、`点一下` → 点击、`建不了容器` → 无法创建容器
- 破折号 `——` 引出的补充说明能拆就拆、是废话就删，**一条文案最多留一个**

**默认动作是删句，不是改词。** 命中上面任一条整句重写，不要贴着原句结构做局部替换 ——
判据是「如果现在从零写这一句，会写成什么样」。英文技术词保持原样（`token` / `cron` /
`schema` / `ordinal` / `fallback`），不硬译。

界面文案另有硬约束：一条只回答「这是什么 / 我该做什么 / 出事会怎样」，回答「为什么这样设计」
的整句删掉；空态 2–6 字、字段下小字 ≤ 25 字、区块说明 ≤ 40 字。安全警示、取值范围与单位、
操作指引、配置键名与错误码删掉即为不合格 —— 删的是叙述，不是事实。用户可见字符串里不出现
文档编号引用（`（docs/28 · L-EXT-04）`），注释里的溯源凭据照旧保留。

**发给模型的提示词反过来：精确优先于简约，不设字数上限。** 语义零变化，强度词
（不得 / 不要 / 必须 / 只能）与第二人称「你」不动，安全条款一字不改。

对话回复走界面文案的语域，不吃它的字数上限 —— 该说清的照说清，删掉的是铺垫、复述与感想。

## Commands

```bash
pnpm dev                      # 本地运行 bot（tsx apps/bot/src/main.ts）
                              # ⚠ tsx 下 plugin 热重载静默失效（运行旧代码，docs/07 §3.2）——
                              #   验证 plugin 更改需重启进程或 pnpm build && pnpm start
pnpm typecheck                # 两份 project：tsc --noEmit + tsc -p tsconfig.build.json --noEmit
                              # 两者文件集不同，仅执行前者会遗漏「仅在构建中存在」的错误
pnpm lint                     # eslint .
pnpm test                     # vitest run（全量）
pnpm test tests/context.test.ts          # 单文件
pnpm exec vitest run -t "部分用例名"      # 按用例名过滤
pnpm exec vitest tests/context.test.ts   # watch 模式
pnpm smoke                    # 端到端冒烟：20 update / 10 turn，覆盖全链路断言
pnpm db:migrate               # 单独执行迁移
pnpm config:schema            # 从 zod schema 重新生成 config/config.schema.json
pnpm webui:passwd <password>  # 生成 argon2id 口令哈希
pnpm build                    # WebUI + tsc -p tsconfig.build.json → dist/ + scripts/postbuild.ts
pnpm start                    # 运行 dist 产物（生产）
```

**不要直接执行 `tsc -p tsconfig.json` 或 `tsc --build`。** 根 tsconfig 未设 `noEmit`，编译产物 `.js`
会散落到 `packages/`、`apps/`、`tests/` 的源码目录。类型检查一律使用 `pnpm typecheck`。

`tsc` 输出到 `dist/packages/<name>/src/`，各包 `package.json` 的 `exports` 指向
`packages/<name>/dist/`，由 `scripts/postbuild.ts` 移动产物，宿主与容器共用该布局。
**修改 `tsconfig.build.json` 的 `outDir`/`rootDir`、包的 `exports`、根 `package.json` 的
`@luoli/*` workspace 依赖时，三处需同步检查**；不一致的表现为 `pnpm start` 报
`ERR_MODULE_NOT_FOUND: @luoli/db`（`pnpm dev` 使用 tsx + tsconfig paths，无法发现）。

`tsconfig.build.json` 排除 `packages/webui/**`、`tests/**` 与 `scripts/copy/runtime/**`（dev 文案面板，
`import` 了 `.vue`，而 `*.vue` 垫片位于被排除的 webui 中）。**向 `scripts/` 添加 import 非 `.ts` 资源的
文件时需注意**：构建的文件集比根 project 窄，此类错误仅 `pnpm typecheck` 的第二趟可见（docs/README §4.1）。

环境变量（见 `.env.example`）：`LUOLI_OWNER_ID` 必需，缺失时 `loadConfig` 直接拒绝启动；
`BOT_TOKEN` 缺失时 Telegram 入口禁用，WebUI 仍可运行；`LUOLI_MASTER_KEY` 用于加密 provider API key。

测试直接对真实 SQLite 运行（`./data/*.test.db`），每个用例自行 `rmSync` 清库，不引入 mock 层。

**读源码文本做断言的用例一律使用 `tests/support/source.ts` 的 `source()` / `code()` / `codeIndex()`**
（判据长在源码结构上、无法以行为断言表达的那些：「关停路径仍然调用 `abortAll`」「处理器注册在
`serve()` 之前」「命令白名单与 `/help` 同步」）。该读取口将引号归一为 `"`、压平空白，
**断言两侧都要经过它**。自行 `readFileSync` + `toContain("...'x'...")` 的写法在 `b7e24ae`
（一次纯格式化）之后集体失败十条 —— 失败的判据与恒真的判据，对「谁来守住这件事」是同一个答案。
需按行判断时才自行读取原文，并在注释中写明原因。

## 架构

pnpm workspace，依赖方向严格单向：`shared → db → core → {telegram, server} → apps/bot`。
`packages/core` 承载绝大部分逻辑（约 75 个源文件），`apps/bot/src/main.ts` 只做装配与生命周期。
路径别名同时存在于三处，新增包时需同步修改：`tsconfig.json` 的 `paths`、`vitest.config.ts` 的
`resolve.alias`、各 `package.json` 的 `dependencies`。

**单实例纪律**（`docs/01 §3.1`，`docs/14 §2 Q1` 拍板）：部署为单进程，但**保留横向扩展的可能**。
由此两条约束：为多实例预留的抽象（Repository 层的 key 参数、`KeyedMutex`）不得以单机部署为由删除；
新代码不得引入**新的**进程内状态假设 —— 进程内缓存作为唯一真相、进程内的锁与限流、
仅本进程可见的广播、启动时扫描一次此后只信内存的表。**无断言可约束此条**，只能在修改这几类代码时
对照 `docs/01 §3.1` 的表逐条核查。纯函数记忆化、单请求内缓存、per-instance 语义的指标计数不在此列。

### 上下文引擎（`packages/core/src/context/engine.ts` + `packages/db/src/context.ts`）

系统核心，历史缺陷最集中的模块（`docs/reviews/15`–`19` 四轮复审）。git 式模型：

- `context_messages` 只追加；`context_commits` 不可变；`refs(name='done')` 指向 HEAD
- **ordinal 只在提交时分配**，`appendDelta` 接收到带 ordinal 的消息会抛错
- 裁剪 = 推进 `window_start`（按 turn 边界，不拆分单个 turn），随后分级降级
  （level 2 = 工具调用参数，level 1 = 工具结果），最后执行字符级硬截断
- 一轮 = `openTurn` → 多次 `appendDelta` → `commitTurn` / `abortTurn`；
  `finalized` 置位后再 `appendDelta` 会抛错，而非静默丢弃

**修改此模块前先阅读 `docs/02-context-engine.md` §9 的实现红线清单（22 条）。** 其中：

- 任何改写 parts 的逻辑（`elidePart`、`truncatePartStrings`）**不得修改判别字段**
  （`type` / `toolCallId` / `toolName` / `mediaType`）。改错时 provider 拒收整个请求，
  而改写结果已持久化 —— 会话在 `/new` 之前每轮均失败
- 不透明 part（image / file）要么原样保留，要么整体替换为占位文本，不得部分截断
- `assertValidShape` 在 `openTurn`、`materialize`、`commitTurn` 三处均执行：读出侧与写入侧都要拦截
- `tests/context.invariants.test.ts` 用 6 个确定性种子做属性式断言，是该模块的主要防线；
  新增裁剪 / 降级逻辑时优先在此添加不变量，而非逐 bug 的回归用例

### 配置（`packages/core/src/config/`）

三层合并：`config/config.yaml` → DB 覆盖层 → 环境变量，全部经 `configSchema`（zod）校验。

**`config_kv` 表的每一行都会被 `loadConfig` 解析为配置覆盖层。** 写入非配置键
（按点分路径展开后落在 schema 之外，或落入 `perChat` 但不在白名单中）会导致下次进程启动失败。
运行时 KV 一律写 `app_kv` 表（`readAppKv` / `writeAppKv`），例如会话模型别名、插件存储。
`loadConfig` 对覆盖层中的非法路径逐条剔除并经 `onInvalidOverride` 上报，但那是兜底不是许可。

WebUI 的写端点必须经 `runtimeConfigSchema.safeParse(mergeDotted(...))` 再落库 ——
`perChat` 覆盖白名单是安全边界（`docs/11 §2.1`），绕过它可为单个会话关闭权限检查。

`tests/config.test.ts` 有一条 CI 断言：**每个 schema 叶子键要么在 `packages/`、`apps/`
中存在路径级引用，要么进入 `KNOWN_UNIMPLEMENTED_CONFIG_KEYS` 白名单，且
`docs/11-config-reference.md` 中有一行同时包含该键与 `🚧`。** 新增配置项时受此约束。

### 派发层（`packages/core/src/tools/policy.ts` + `agent/subagent.ts` + `agent/manager.ts`）

**主 agent 不调工具，只对话与派发**（2026-08-30 重构）。工具整体下沉至 **lw-worker**：单一内建、
**叶子**（不可再派）、获得调用者有效角色下的工具全集。判据只有一份 —— `MAIN_AGENT_TOOLS`
（主 agent 的白名单：记忆读写、Telegram 输出五件、`schedule_*` 四件、归档检索、`stay_silent`、
`set_model`、派发族与 `read_worker_result`）/ `MAIN_ONLY_TOOLS`（worker 的黑名单）/
`toolCallableBy()`，强制点位于 `#eligible()`（目录过滤，理由是成本：未过滤的数十个工具的
JSON Schema 每步重发）与 `admit()`（准入，**该层才是安全闸**）两处。**两来源的子 agent
定义体系整体删除**（`agent.agents[]` / `agentsDir` / `agents/<name>.md` / `list_agents` /
WebUI「子 Agent」页 / `GET /api/agents`），环路检测与 `agent.maxDepth` 一并删除 ——
叶子拓扑下二者判定的均为恒假条件。

- `spawn_worker`（旧 `spawn_agent`）带 `resultMode: summary|full` 与 `untrustedOutput: true`。
  **两档都要经 `untrusted()` 包裹**：worker 是外部内容进入主上下文的唯一通道，worker 侧已包裹的
  网页与文件写入产出交回时包装即丢失。`full` 只是更长，不是更可信。
- **`full` 未解决 `docs/14` T12**：回灌的仍是工具结果，`pruneLevel: 1` 仍将其整体替换为占位符，
  `runId` 一并丢失。跨轮可靠的唯一方式是让结论进入主 agent 的回复正文。
- 折叠目录与 `search_tools` **仅在 worker 侧**；`loadedSkills` / `skillAllowedTools` /
  `expandedTools` 三个 Set 位于 `ToolExecutionContext`、**per-run**，不再挂载于 turn。
- 三档 worker（`lw` / `harness` / `acp`）在 `agent_runs.worker_kind` 上各占一档，主 run 为 NULL
  （迁移 `0018`，`kind` 上的 CHECK 未改动）。本轮名额 `agent.maxWorkersPerTurn` 仅统计
  `worker_kind='lw'`，另两档消耗各自的额度。
- **该拓扑的成本记于 `docs/14` T21**：每一项需要执行的操作多一次模型往返，且 worker 每次使用
  全新前缀，无法命中主对话的 prompt cache。**日常轻任务更慢且更贵，该开销无法通过调优消除。**

### 权限与工具

角色 `owner > trusted > limited > blocked`。有效角色：私聊 = 用户角色；群 / 频道任一侧 `blocked`
即 `blocked`，否则取两侧**较高者**再**封顶 `trusted`**（2026-08-30 改口径，`docs/05 §2.2`）。
群角色是**下限**不是上限；封顶保留了旧规则防止群内注入借权的效果 —— 由此
`effectiveRole === 'owner'` ⟹ `isPrivate`。私聊只占 `principals` 的 `user:` 一行。
工具在 `packages/core/src/tools/registry.ts` 注册，权限在注册期 fail-closed
（`available(role, ctx)` 返回 false 的工具不进入注册表的合格集 `active()`，因而既不进入模型的
工具目录，也无法通过 `execute()` 的复查）。沙箱 `none | docker`，`bypassRoles: ['owner']`。
运维在 WebUI 停用的工具走 `tools.overrides`，目录过滤 + `execute()` 二次拦截 ——
模型可能沿用上一步的工具名，禁用必须是硬边界。

**目录分常驻与折叠两类**（`tools.catalog.*`，`docs/05 §3.12`）：外部工具（MCP / plugin / custom）
默认折叠为每组一行名称，**worker** 经 `search_tools` 检索后写入自身的 `expandedTools`
（per-run，见上一节）；本轮后续 step 的
`activeTools = (常驻 ∪ 已展开) ∩ skill 允许集`（先扩张后收窄，收窄优先；展开集在 run 内只增不减、
不跨 run 也不跨轮保留）。**折叠不是权限边界**：`active()` / `admit()` / `execute()` 的判据中不含
折叠判据，到达 `execute()` 的调用仍逐条全判。未展开的工具在模型侧不可达，成因是 AI SDK 先按
`activeTools` 过滤 toolSet 再 `parseToolCall`（触发 `NoSuchToolError`），属**可达性**收缩 ——
更换 SDK 版本后该层即失效，不得作为安全边界使用。确需禁止时使用
`tools.overrides.<name>.enabled=false` 或 MCP 的 `toolDeny`。

一切外部内容（工具输出、网页、文件、群聊背景发言）经 `untrusted()` 包裹，
带随机 nonce 边界并转义闭合标记。**用户自身的触发消息不包裹** —— 包裹等同于指示模型
忽略该用户的请求。群聊背景发言使用语义较弱的 `<group-message>`。

### 定时任务（`packages/core/src/schedule/runner.ts` + `packages/db/src/schedule.ts`）

`docs/14 §2 Q4` 拍板后新增。触发时**开启一条完整轮次**（与 `bot.ts` 同一路径：配额 → 并发闸 →
`openTurn` → `commitTurn`），产出仍进入上下文；`mode='notify'` 同样开轮，否则模型在下一轮
无法得知自己刚发出过提醒。修改此模块前先阅读 `docs/02 §10` 的五条规则。三处易错点：

- **合成触发消息的 `tg_message_id` 取自保留高位段 `2_000_000_000`**，且 `append` 之后必须核对
  返回值。`ScopedArchiveRepository.append` 为 `INSERT OR IGNORE` —— ID 冲突时静默返回既有行，
  表现为一条真实用户消息丢失。使用负数同样不可行，会使背景认领窗口计算为空。
- **每次触发重新计算有效角色**，不得沿用创建时的角色：降级至 `trusted` 以下时跳过本次，
  `blocked` 时停用整条任务。任务仅在创建时刻的角色下获得许可，而其此后每天触发。
- **静默（`docs/02 §10.5`）指不投递，不是不开轮，也不是不提交。** `appendDelta` 与
  `commitTurn` 必须位于两条路径的合流点**之后** —— 写成 `if (silenced) return` 省下一次 commit，
  代价是上下文中出现一段无法解释的缺失。`stay_silent` 的 fail-closed 有三道：它在
  `MAIN_ONLY_TOOLS` 中（worker 侧先在 `toolCallableBy()` 处被拒），`available()` 另判
  `agentKind === 'main' && turn.silenceable === true`（两道都需要：worker 拿到的是父轮的同一个
  turn 对象），而模型可设置的 `silenced` / `silenceReason` **仅 runner 读取** —— 若此后有其他
  路径传入 `silenceable`，最坏结果也只是多一个无人读取的标志位。

`Scheduler` 提供 `remove` / `has` / `nextRun` 与时区参数。**用户任务按行内记录的 timezone 触发，
五个 `*Cron` 维护任务仍运行于进程本地时区** —— 该行为是既有设计，`docs/11` 的 `schedule` 段已说明。

WebUI 的「任务与审批」页提供管理面（列出 / 创建 / 修改 / 停用 / 彻底删除 / 立即触发，
`docs/09 §3.10.1`）。**建与改的校验只有一份**：`packages/core/src/schedule/create.ts` 中的
`createScheduledJob` 与 `updateScheduledJob`，二者共用同一组闸函数（`gateEnabled` / `gateName` /
`gateText` / `gateSilent` / `gateCron` / `gateAt` / `gateDuplicate`）；工具与
`POST`/`PATCH /api/schedules` 四条路径均经过它 —— 端点自行重复实现的话，WebUI 迟早能创建或
修改出工具无法创建的任务。`updateScheduledJob` 有一条反直觉的规则：**仅校验本次实际提供的字段**，
两个触发字段均未提供时触发时间原样保留且不重新校验（运维事后调大 `minIntervalMinutes` 后，
仅修改正文不应以 `interval_too_short` 失败），时区一律取 `job.timezone` 而非 `general.timezone`。
「停用」（`DELETE`，软取消，行保留）与「彻底删除」（`POST …/purge`，硬删整行）是两个动词，
后者留一条 warn `schedule.purged` 作为唯一凭据。

### 数据库（`packages/db/`）

better-sqlite3 + 原生 SQL，无 ORM 查询层。WAL 模式。迁移文件为 `packages/db/migrations/NNNN_*.sql`，
按文件名排序执行，每个文件在一个事务内；存在待执行迁移且已有历史迁移时先 `VACUUM INTO` 备份。
**迁移文件一旦提交即不可修改**，只能追加新文件。修改 DDL 时同步更新 `docs/03-data-model.md`。

## 项目约定

- **文档是权威来源。实现与文档不一致时，先改文档再改代码**（`docs/README.md` 开头声明）。
  文档分两层：`docs/00`–`docs/21` 与 `docs/29` 是**活的规格层**，`docs/reviews/` 是**冻结的历史复审**。
  **`docs/00-state.md` 是当前欠项与已核查项的唯一入口**，开工前先阅读 ——
  复审报告中的结论均为当轮快照，不代表当前状态。
  `docs/13-acceptance-criteria.md` 是 588 条可逐条勾选的验收条目（条数变动时同步该文件末尾的签署表）。
  每条标 `(自动)` 或 `(手动)`：前者勾选需点名 `〔用例文件〕`，后者需点名 `〔手测 YYYY-MM-DD · S<n>〕`，
  且 `docs/29-manual-acceptance-log.md` 对应场次中存在 `### <条目编号>` 小节 —— 两条均由
  `tests/acceptance.test.ts` 焊住。**编号 29 归手动验收台账，下一份复审报告用 30。**
  `docs/21-webui-coverage-gaps.md` 记录 WebUI 控制面尚未覆盖的已实现能力，修改 WebUI 前先查阅。
- 修不了的问题不假装修好。已确立的先例：`PUT /api/quota` 返回 `not_implemented` 而非伪造成功；
  `ask_parent` 在父 agent 仲裁未实现时返回 `ask_parent_not_implemented`，而非以默认值伪造答复。
  "摘除比伪造安全"（`docs/reviews/16 §5`）。
- 代码风格：单文件内密度高、少空行、注释只写"为什么"不写"做了什么"。跟随邻近代码。
- 复审报告在 `docs/reviews/`（十轮 / 13 份，`15`–`20` / `22`–`28`），记录每一轮的缺陷与根因，
  修改相关模块前先查阅对应条目 —— 但**仅作历史阅读**：每份都带 frozen header，结论为当轮快照。
  当前状态一律以 `docs/00-state.md` 为准，🚧 配置键一律以 `docs/11 §2.0.1` 为准（由 `config.test.ts` 焊住）。
  `docs/reviews/26` 只审工具系统：修改 `packages/core/src/tools/` 或任何内建工具前先阅读，
  §6 列出已核查无问题的部分，§2–§4 每条附复现方式。
  `docs/reviews/28` 是**活体测试**（真实进程 / Telegram / docker / 上游），全库被源码引用最多的一份；
  查找单元测试在结构上无法覆盖的问题时，先读 §6（已验证无问题）与 §8（排除的 8 条假象）。
  **复审文档的条目编号（`W-CFG-02`、`S-01` 等）被源码注释大量引用为溯源凭据，不得重编号或删除**
  —— `tests/docs.test.ts` 只覆盖其中一部分（288 个编号中的 18 个），另有裸子串匹配等三层松弛，
  详见 `docs/README §0.1` 的警示块。引用 `R-TG-01` / `G-EXT-0x` 这类**曾经冲突**的编号必须带文档号。
  ⚠ `reviews/27` 含 NUL 字节，`grep` 检索它需加 `-a`（不加会静默跳过整份文件）。
- `docs/13` 的勾选由 `tests/acceptance.test.ts` 约束：`[x]` 必须带 `〔用例文件〕`、只有标 `(自动)`
  的可勾选、签署表的分子分母必须等于文档中数出的条数。**条目变动时该表自行报错**，无需手算。

## 其他 AI 工具配置

检测到 `~/.codex/config.toml` 与 `~/.gemini/settings.json`。如需将其中的 MCP server、
slash command、subagent、skill 或指令导入 Claude Code，回复 `/import` 查看可导入项清单，
再用 `/import --yes=<digest>` 应用（digest 由扫描结果给出）。当前环境无 `/import` 时，
在终端执行 `claude import`。
