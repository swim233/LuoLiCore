# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm dev                      # 本地运行 bot（tsx apps/bot/src/main.ts）
pnpm typecheck                # tsc --noEmit
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

环境变量（见 `.env.example`）：`LUOLI_OWNER_ID` 必需，缺失时 `loadConfig` 直接拒绝启动；
`BOT_TOKEN` 缺失时 Telegram 入口禁用但 WebUI 仍可跑；`LUOLI_MASTER_KEY` 用于加密 provider API key。

测试直接对真实 SQLite 跑（`./data/*.test.db`），每个用例自己 `rmSync` 清库，不要引入 mock 层。

## 架构

pnpm workspace，依赖方向严格单向：`shared → db → core → {telegram, server} → apps/bot`。
`packages/core` 是绝大部分逻辑所在（约 35 个源文件），`apps/bot/src/main.ts` 只做装配与生命周期。
路径别名同时存在于三处，加新包时要一起改：`tsconfig.json` 的 `paths`、`vitest.config.ts` 的
`resolve.alias`、以及各 `package.json` 的 `dependencies`。

### 上下文引擎（`packages/core/src/context/engine.ts` + `packages/db/src/context.ts`）

这是系统的核心，也是历史上出问题最集中的地方（`docs/15`–`docs/19` 四轮复审）。git 式模型：

- `context_messages` 只追加；`context_commits` 不可变；`refs(name='done')` 指向 HEAD
- **ordinal 只在提交时分配**，`appendDelta` 拿到带 ordinal 的消息会抛错
- 裁剪 = 推进 `window_start`（按 turn 边界，不切开一个 turn），然后分级降级
  （level 2 = 工具调用参数，level 1 = 工具结果），最后才做字符级硬截断
- 一轮 = `openTurn` → 多次 `appendDelta` → `commitTurn` / `abortTurn`；
  `finalized` 置位后再 `appendDelta` 会抛错，而不是静默丢弃

**改这块之前先读 `docs/02-context-engine.md` 的不变量清单（14 条）。** 尤其是：

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
（`available(role, ctx)` 返回 false 的工具根本不进模型的工具目录）。沙箱 `none | jail | docker`，
`bypassRoles: ['owner']`。运维在 WebUI 关掉的工具走 `tools.overrides`，目录过滤 + `execute()`
二次硬拦截 —— 模型可能沿用上一步的工具名，禁用必须是硬边界。

一切外部内容（工具输出、网页、文件、群聊背景发言）经 `untrusted()` 包裹，
带随机 nonce 边界并转义闭合标记。**用户自己的触发消息不包裹** —— 包裹它等于告诉模型
"忽略这个人的请求"。群聊背景发言用语义较弱的 `<group-message>`。

### 定时任务（`packages/core/src/schedule/runner.ts` + `packages/db/src/schedule.ts`）

`docs/14 §2 Q4` 拍板后加的。触发时**开一条完整轮次**（照 `bot.ts` 那条路：配额 → 并发闸 →
`openTurn` → `commitTurn`），产出照常进上下文；`mode='notify'` 也开轮，否则模型下一轮不知道
自己刚提醒过什么。改这块前先读 `docs/02 §10` 的四条规则。两个容易踩的地方：

- **合成触发消息的 `tg_message_id` 取自保留高位段 `2_000_000_000`**，且 `append` 之后必须核对
  返回值。`ScopedArchiveRepository.append` 是 `INSERT OR IGNORE` —— 撞号会静静返回既有那一行，
  表现是一条真实用户消息凭空消失。用负数同样不行（会把背景认领窗口算空）。
- **每次触发都重算有效角色**，不能信创建时那个：降级到 `trusted` 以下跳过这一次、`blocked`
  整条停用。任务是在创建那一刻的角色下被允许的，而它此后每天都触发。

`Scheduler` 现在有 `remove` / `has` / `nextRun` 与时区参数。**用户任务按行上记的 timezone 触发，
而五个 `*Cron` 维护任务仍跑在进程本地时区** —— 这是既有行为，`docs/11` 的 `schedule` 段写明了。

WebUI 在「任务与审批」页有管理面（列 / 建 / 停 / 立即触发，`docs/09 §3.10.1`）。
**建任务的校验只有一份**：`packages/core/src/schedule/create.ts` 的 `createScheduledJob`，
工具与 `POST /api/schedules` 共用 —— 端点自己抄一遍的话，WebUI 迟早能建出工具建不出来的任务。

### 数据库（`packages/db/`）

better-sqlite3 + 原生 SQL，无 ORM 查询层。WAL 模式。迁移是 `packages/db/migrations/NNNN_*.sql`，
按文件名排序执行，每个文件在一个事务里；有待执行迁移且已有历史迁移时会先 `VACUUM INTO` 备份。
**迁移文件一旦提交就不可修改**，只能追加新文件。改 DDL 时同步更新 `docs/03-data-model.md`。

## 项目约定

- **文档是权威来源。实现与文档不一致时，先改文档再改代码**（`docs/README.md` 开头即声明）。
  `docs/13-acceptance-criteria.md` 是 407 条可逐条勾选的验收条目（改动条数时同步该文件末尾的签署表）。
  `docs/21-webui-coverage-gaps.md` 记录 WebUI 控制面还够不着哪些已实现的能力，动 WebUI 前先扫一眼。
- 修不了的东西不要假装修好。已确立的先例：`PUT /api/quota` 返回 `not_implemented` 而不是假成功；
  `ask_parent` 在父 agent 仲裁未实现时返回 `ask_parent_not_implemented` 而不是拿默认值伪造答复。
  "摘除比伪造安全"（`docs/16 §5`）。
- 代码风格：单文件内密度高、少空行、注释只写"为什么"不写"做了什么"。跟着邻近代码写。
- 复审报告 `docs/15`–`docs/26` 记录了每一轮的缺陷与根因，改到相关模块前值得先扫一眼对应条目。
  `docs/25` 仍是**当前 🚧 清单的权威来源**（哪些留着、为什么留着都在 §4.3 与 §8）。
  `docs/26` 是最近一轮，只审工具系统：动 `packages/core/src/tools/` 或任何内建工具之前先看它，
  §6 列了「查过没问题」的地方，§2–§4 每条都带复现方式。
- `docs/13` 的勾选由 `tests/acceptance.test.ts` 约束：`[x]` 必须带 `〔用例文件〕`、只有标 `(自动)`
  的能勾、签署表的分子分母必须等于文档里数出来的条数。**改动条目时那张表会自己报错**，不用手算。

## 其他 AI 工具配置

检测到 `~/.codex/config.toml` 与 `~/.gemini/settings.json`。如果想把其中的 MCP server、
slash command、subagent、skill 或指令导入 Claude Code，回复 `/import` 查看可导入项清单，
再用 `/import --yes=<digest>` 应用（digest 由扫描结果给出）。若当前环境没有 `/import`，
在终端执行 `claude import`。
