# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm dev                      # 本地运行 bot（tsx apps/bot/src/main.ts）
                              # ⚠ tsx 下 plugin 热重载静默失效（跑旧代码，docs/07 §3.2）——
                              #   验 plugin 改动要重启进程或 pnpm build && pnpm start
pnpm typecheck                # 两份 project：tsc --noEmit + tsc -p tsconfig.build.json --noEmit
                              # 两者文件集不同，只跑前者会漏掉「只在构建里存在」的错误
pnpm lint                     # eslint .
pnpm test                     # vitest run（全量）
pnpm test tests/context.test.ts          # 单文件
pnpm exec vitest run -t "部分用例名"      # 按用例名过滤
pnpm exec vitest tests/context.test.ts   # watch 模式
pnpm smoke                    # 端到端冒烟：20 update / 10 turn，跑通全链路断言
pnpm db:migrate               # 单独执行迁移
pnpm config:schema            # 从 zod schema 重新生成 config/config.schema.json
pnpm webui:passwd <password>  # 生成 argon2id 口令哈希
pnpm build                    # WebUI + tsc -p tsconfig.build.json → dist/ + scripts/postbuild.ts
pnpm start                    # 跑 dist 产物（生产）
```

**不要直接跑 `tsc -p tsconfig.json` 或 `tsc --build`。** 根 tsconfig 没有 `noEmit`，会把编译产物 `.js`
散落到 `packages/`、`apps/`、`tests/` 的源码目录里。类型检查一律用 `pnpm typecheck`。

`tsc` emit 到 `dist/packages/<name>/src/`，而各包 `package.json` 的 `exports` 指向
`packages/<name>/dist/` —— `scripts/postbuild.ts` 负责把产物搬过去，宿主与容器共用这一套布局。
**改 `tsconfig.build.json` 的 `outDir`/`rootDir`、包的 `exports`、或根 `package.json` 里的
`@luoli/*` workspace 依赖时，这三处要一起看**；对不上的表现是 `pnpm start` 报
`ERR_MODULE_NOT_FOUND: @luoli/db`（`pnpm dev` 走 tsx + tsconfig paths，发现不了）。

`tsconfig.build.json` 排掉 `packages/webui/**`、`tests/**` 与 `scripts/copy/runtime/**`（dev 文案面板，
`import` 了 `.vue` 而 `*.vue` 垫片在被排掉的 webui 里）—— **往 `scripts/` 加 import 非 `.ts` 资源的文件时
记得它**，构建的文件集比根 project 窄，这类错误只有 `pnpm typecheck` 的第二趟能看见（docs/README §4.1）。

环境变量（见 `.env.example`）：`LUOLI_OWNER_ID` 必需，缺失时 `loadConfig` 直接拒绝启动；
`BOT_TOKEN` 缺失时 Telegram 入口禁用但 WebUI 仍可跑；`LUOLI_MASTER_KEY` 用于加密 provider API key。

测试直接对真实 SQLite 跑（`./data/*.test.db`），每个用例自己 `rmSync` 清库，不要引入 mock 层。

**读源码文本来断言的用例一律走 `tests/support/source.ts` 的 `source()` / `code()` / `codeIndex()`**
（判据长在源码结构上、行为化装不起来的那些：「关停路径仍然调 `abortAll`」「处理器装在 `serve()`
之前」「命令白名单与 `/help` 同步」）。那个读取口把引号归一成 `"`、把空白压平，**断言两侧都要过**。
自己 `readFileSync` + `toContain("...'x'...")` 的写法在 `b7e24ae`（一次纯格式化）之后集体变红过
十条 —— 而红着的判据与恒真的判据，对「谁来守住这件事」是同一个答案。需要按行判断时才自己读原文，
并在注释里写明为什么。

## 架构

pnpm workspace，依赖方向严格单向：`shared → db → core → {telegram, server} → apps/bot`。
`packages/core` 是绝大部分逻辑所在（约 65 个源文件），`apps/bot/src/main.ts` 只做装配与生命周期。
路径别名同时存在于三处，加新包时要一起改：`tsconfig.json` 的 `paths`、`vitest.config.ts` 的
`resolve.alias`、以及各 `package.json` 的 `dependencies`。

**单实例纪律**（`docs/01 §3.1`，`docs/14 §2 Q1` 拍板）：部署是单进程，但**保留了将来横向扩展的可能**。
所以两条约束：为多实例预留的抽象（Repository 层的 key 参数、`KeyedMutex`）不许为了"反正单机"删掉；
新代码不许引入**新的**进程内状态假设 —— 进程内缓存当唯一真相、进程内的锁/限流、只在本进程可见的广播、
"启动时扫一遍之后只信内存"的表。**没有断言能挡住这条**，只能改到这几类东西时对着 `docs/01 §3.1` 那张
表逐条看。纯函数记忆化、单请求内缓存、per-instance 语义的指标计数不算。

### 上下文引擎（`packages/core/src/context/engine.ts` + `packages/db/src/context.ts`）

这是系统的核心，也是历史上出问题最集中的地方（`docs/reviews/15`–`19` 四轮复审）。git 式模型：

- `context_messages` 只追加；`context_commits` 不可变；`refs(name='done')` 指向 HEAD
- **ordinal 只在提交时分配**，`appendDelta` 拿到带 ordinal 的消息会抛错
- 裁剪 = 推进 `window_start`（按 turn 边界，不切开一个 turn），然后分级降级
  （level 2 = 工具调用参数，level 1 = 工具结果），最后才做字符级硬截断
- 一轮 = `openTurn` → 多次 `appendDelta` → `commitTurn` / `abortTurn`；
  `finalized` 置位后再 `appendDelta` 会抛错，而不是静默丢弃

**改这块之前先读 `docs/02-context-engine.md` §9 的实现红线清单（22 条）。** 尤其是：

- 任何改写 parts 的逻辑（`elidePart`、`truncatePartStrings`）**绝不能碰判别字段**
  （`type` / `toolCallId` / `toolName` / `mediaType`）。改坏了 provider 会拒收整个请求，
  而改写结果是持久化的 —— 会话在 `/new` 之前每轮都失败
- 不透明 part（image / file）要么原样保留，要么整体换成占位文本，不能截半
- `assertValidShape` 在 `openTurn`、`materialize`、`commitTurn` 三处都跑：读出侧和写入侧都要挡
- `tests/context.invariants.test.ts` 用 6 个确定性种子做属性式断言，是这块的主要防线；
  新增裁剪/降级逻辑时优先往这里加不变量，而不是加逐 bug 的回归用例

### 配置（`packages/core/src/config/`）

三层合并：`config/config.yaml` → DB 覆盖层 → 环境变量，全部经 `configSchema`（zod）校验。

**`config_kv` 表的每一行都会被 `loadConfig` 当成配置覆盖层解析。** 往里写非配置键
（例如按点分路径展开后落在 schema 之外，或落进 `perChat` 但不在白名单里）会让下次进程启动失败。
运行时 KV 一律写 `app_kv` 表（`readAppKv` / `writeAppKv`），例如会话模型别名、插件存储。
`loadConfig` 对覆盖层里的非法路径会逐条剔除并通过 `onInvalidOverride` 上报，但这是兜底不是许可。

WebUI 的写端点必须走 `runtimeConfigSchema.safeParse(mergeDotted(...))` 再落库 ——
`perChat` 覆盖白名单是安全边界（`docs/11 §2.1`），绕过它可以给单个会话关掉权限检查。

`tests/config.test.ts` 有一条 CI 断言：**每个 schema 叶子键要么能在 `packages/`、`apps/`
里找到路径级引用，要么必须进 `KNOWN_UNIMPLEMENTED_CONFIG_KEYS` 白名单，且在
`docs/11-config-reference.md` 里有一行同时含该键与 `🚧`。** 加配置项时会撞上这条。

### 权限与工具

角色 `owner > trusted > limited > blocked`，有效角色 = min(用户角色, 会话角色)。
工具在 `packages/core/src/tools/registry.ts` 注册，权限在注册期 fail-closed
（`available(role, ctx)` 返回 false 的工具连注册表的合格集 `active()` 都进不去，因而既不进模型的
工具目录、也过不了 `execute()` 的复查）。沙箱 `none | docker`，`bypassRoles: ['owner']`。
运维在 WebUI 关掉的工具走 `tools.overrides`，目录过滤 + `execute()` 二次硬拦截 ——
模型可能沿用上一步的工具名，禁用必须是硬边界。

**目录本身还分常驻 / 折叠**（`tools.catalog.*`，`docs/05 §3.12`）：外部工具（MCP / plugin / custom）
默认折叠成每组一行名字，模型用 `search_tools` 检索后写进 `turn.expandedTools`，本轮后续 step 的
`activeTools = (常驻 ∪ 已展开) ∩ skill 允许集`（先扩张后收窄，收窄永远赢；展开集轮内只增不减、
不跨轮保留）。**折叠不是权限边界**：`active()` / `admit()` / `execute()` 的判据里不出现折叠判据，
到达 `execute()` 的调用照旧逐条全判。未展开的工具在模型侧事实上不可达，那是 AI SDK 先按
`activeTools` 过滤 toolSet 再 `parseToolCall` 造成的**可达性**收缩（撞 `NoSuchToolError`）——
换 SDK 版本这层就没了，别把它当安全边界用。要真的不给就用 `tools.overrides.<name>.enabled=false`
或 MCP 的 `toolDeny`。

一切外部内容（工具输出、网页、文件、群聊背景发言）经 `untrusted()` 包裹，
带随机 nonce 边界并转义闭合标记。**用户自己的触发消息不包裹** —— 包裹它等于告诉模型
"忽略这个人的请求"。群聊背景发言用语义较弱的 `<group-message>`。

### 定时任务（`packages/core/src/schedule/runner.ts` + `packages/db/src/schedule.ts`）

`docs/14 §2 Q4` 拍板后加的。触发时**开一条完整轮次**（照 `bot.ts` 那条路：配额 → 并发闸 →
`openTurn` → `commitTurn`），产出照常进上下文；`mode='notify'` 也开轮，否则模型下一轮不知道
自己刚提醒过什么。改这块前先读 `docs/02 §10` 的五条规则。三个容易踩的地方：

- **合成触发消息的 `tg_message_id` 取自保留高位段 `2_000_000_000`**，且 `append` 之后必须核对
  返回值。`ScopedArchiveRepository.append` 是 `INSERT OR IGNORE` —— 撞号会静静返回既有那一行，
  表现是一条真实用户消息凭空消失。用负数同样不行（会把背景认领窗口算空）。
- **每次触发都重算有效角色**，不能信创建时那个：降级到 `trusted` 以下跳过这一次、`blocked`
  整条停用。任务是在创建那一刻的角色下被允许的，而它此后每天都触发。
- **静默（`docs/02 §10.5`）是「不投递」，不是「不开轮」更不是「不提交」。** `appendDelta` 与
  `commitTurn` 必须在两条路的合流点**之后** —— 写成 `if (silenced) return` 省下的是一次 commit，
  代价是一次说不清的失忆。`stay_silent` 的 `available()` 是 fail-closed 的
  （`agentKind === 'main' && turn.silenceable === true`，两道闸都要：子 agent 拿到的是父轮同一个
  turn 对象），而模型能置的 `silenced` / `silenceReason` **只有 runner 读** —— 哪天有人给别的
  路径传了 `silenceable`，最坏也只是多一个没人读的标志位。

`Scheduler` 现在有 `remove` / `has` / `nextRun` 与时区参数。**用户任务按行上记的 timezone 触发，
而五个 `*Cron` 维护任务仍跑在进程本地时区** —— 这是既有行为，`docs/11` 的 `schedule` 段写明了。

WebUI 在「任务与审批」页有管理面（列 / 建 / 改 / 停 / 彻底删除 / 立即触发，`docs/09 §3.10.1`）。
**建与改的校验只有一份**：`packages/core/src/schedule/create.ts` 里的 `createScheduledJob` 与
`updateScheduledJob`，两者共用同一组闸函数（`gateEnabled` / `gateName` / `gateText` / `gateSilent` /
`gateCron` / `gateAt` / `gateDuplicate`）；工具与 `POST`/`PATCH /api/schedules` 四条路都走它 ——
端点自己抄一遍的话，WebUI 迟早能建出（改出）工具建不出来的任务。`updateScheduledJob` 有一条
反直觉的规矩：**只校验这次真的给了的字段**，两个触发字段都没给时触发时间原样保留且不重新校验
（运维事后调大 `minIntervalMinutes` 时，「我只改了一句正文」不该以 `interval_too_short` 失败），
时区一律取 `job.timezone` 而不是 `general.timezone`。「停掉」（`DELETE`，软取消、行还在）与
「彻底删除」（`POST …/purge`，硬删整行）是两个动词，后者留一条 warn `schedule.purged` 当唯一凭据。

### 数据库（`packages/db/`）

better-sqlite3 + 原生 SQL，无 ORM 查询层。WAL 模式。迁移是 `packages/db/migrations/NNNN_*.sql`，
按文件名排序执行，每个文件在一个事务里；有待执行迁移且已有历史迁移时会先 `VACUUM INTO` 备份。
**迁移文件一旦提交就不可修改**，只能追加新文件。改 DDL 时同步更新 `docs/03-data-model.md`。

## 项目约定

- **文档是权威来源。实现与文档不一致时，先改文档再改代码**（`docs/README.md` 开头即声明）。
  文档分两层：`docs/00`–`docs/21` 与 `docs/29` 是**活的规格层**，`docs/reviews/` 是**冻结的历史复审**。
  **`docs/00-state.md` 是「现在还欠什么 / 哪些查过没问题」的唯一入口**，开工前先看它 ——
  复审报告里的结论一律是当轮快照，不代表现在。
  `docs/13-acceptance-criteria.md` 是 522 条可逐条勾选的验收条目（改动条数时同步该文件末尾的签署表）。
  每条标 `(自动)` 或 `(手动)`：前者勾选要点名 `〔用例文件〕`，后者要点名 `〔手测 YYYY-MM-DD · S<n>〕`
  且 `docs/29-manual-acceptance-log.md` 的那一场里真有 `### <条目编号>` 小节 —— 两条都由
  `tests/acceptance.test.ts` 焊住。**编号 29 归手动验收台账，下一份复审报告用 30。**
  `docs/21-webui-coverage-gaps.md` 记录 WebUI 控制面还够不着哪些已实现的能力，动 WebUI 前先扫一眼。
- 修不了的东西不要假装修好。已确立的先例：`PUT /api/quota` 返回 `not_implemented` 而不是假成功；
  `ask_parent` 在父 agent 仲裁未实现时返回 `ask_parent_not_implemented` 而不是拿默认值伪造答复。
  "摘除比伪造安全"（`docs/reviews/16 §5`）。
- 代码风格：单文件内密度高、少空行、注释只写"为什么"不写"做了什么"。跟着邻近代码写。
- 复审报告在 `docs/reviews/`（十轮 / 13 份，`15`–`20` / `22`–`28`），记录每一轮的缺陷与根因，改到相关模块前
  值得先扫一眼对应条目 —— 但**只当历史读**：每份都带 frozen header，结论是当轮快照。
  当前状态一律以 `docs/00-state.md` 为准，🚧 配置键一律以 `docs/11 §2.0.1` 为准（由 `config.test.ts` 焊住）。
  `docs/reviews/26` 只审工具系统：动 `packages/core/src/tools/` 或任何内建工具之前先看它，
  §6 列了「查过没问题」的地方，§2–§4 每条都带复现方式。
  `docs/reviews/28` 是**活体测试**（真进程 / 真 Telegram / 真 docker / 真上游），全库被源码引用最多的一份；
  要找「单元测试结构性看不见」的那类问题，先读它的 §6（跑过没问题的）与 §8（排除掉的 8 条假象）。
  **复审文档的条目编号（`W-CFG-02`、`S-01` 之类）被源码注释当溯源凭据大量引用，不得重编号或删除**
  —— `tests/docs.test.ts` 会挡住，但**只挡住一部分**（288 个编号里 18 个），另有裸子串匹配等三层松弛，
  详见 `docs/README §0.1` 的警示块。引 `R-TG-01` / `G-EXT-0x` 这类**撞过号**的编号必须带文档号。
  ⚠ `reviews/27` 含 NUL 字节，`grep` 查它要加 `-a`（不加会静默跳过整份文件）。
- `docs/13` 的勾选由 `tests/acceptance.test.ts` 约束：`[x]` 必须带 `〔用例文件〕`、只有标 `(自动)`
  的能勾、签署表的分子分母必须等于文档里数出来的条数。**改动条目时那张表会自己报错**，不用手算。

## 其他 AI 工具配置

检测到 `~/.codex/config.toml` 与 `~/.gemini/settings.json`。如果想把其中的 MCP server、
slash command、subagent、skill 或指令导入 Claude Code，回复 `/import` 查看可导入项清单，
再用 `/import --yes=<digest>` 应用（digest 由扫描结果给出）。若当前环境没有 `/import`，
在终端执行 `claude import`。
