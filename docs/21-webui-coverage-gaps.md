# 21 · WebUI 控制面覆盖缺口

> **口径**：本文只回答一个问题 —— **「运行时真的有这个能力，但运维在 WebUI 里够不着」**。
> 三类东西不算缺口，单独列在 §5：运行时压根没接线的配置项（那是 `KNOWN_UNIMPLEMENTED_CONFIG_KEYS`
> 的事）、被别的端点取代的重复端点、以及有意做成只读的地方。
>
> 盘点时间：2026-08-16。数字口径见 §1 开头的复算方法，改了 schema 或页面之后重跑一遍即可。
>
> **第二轮（2026-08-16 下午）**：完成 G-SSE-01、G-SRV-01、G-API-08、G-API-09 与自动生成配置表单，
> 可写配置覆盖率达到 151/151（其中 2 项密钥字段只读）。**第三轮**继续完成 G-API-10/11/12 与
> G-SRV-02/03/04；本文口径内的 WebUI 控制面缺口已清零，注册 API 端点从 82 条增至 **89 条**（该数字是第三轮当时的；此后仍在涨，2026-08-18 复算为 **110 条**——M12 的自我扩展复审面又加了 5 条：`/api/custom-tools` 的读/启停/删，以及 plugin 的源码只读与删除）。
> 第三轮顺带把 `approval.ttlMs` 与 `mcp.enabled` 接了线（从 `KNOWN_UNIMPLEMENTED_CONFIG_KEYS` 摘掉），
> 分母因此从 151 变成 **153**，覆盖率仍是满的。
>
> **第四轮（2026-08-17）**：口径从「有没有控件」推进到「**这个控件真的说话算数吗**」——
> 前三轮把覆盖率做满之后，剩下的缺口全是「界面上改得动、运行时不认」那一类。查出七条
> （G-CFG-02 ~ G-CFG-07、G-API-14）并全部修掉，见 [§7](#7-第四轮改了什么)。§1 的三个数字同时复算。

---

## 0. 现在还开着什么（先看这一节）

本文 800 多行里，**八成只服务于已经闭合的条目** —— 这一节把还活着的挑出来，免得像
`G-UI-05` / `G-UI-06` 那样最新的缺口排在第 800 多行、没人翻得到。

| 编号 | 一句话 | 在哪 |
|---|---|---|
| `G-API-18` | 插件的 `config_json` 没有表单，只能改文件 | [§6.4](#64-新增缺口扩展页重设计--mcp-登录这一轮) |
| `G-API-19` | `skills.dir` 改了要重启，界面上看不出来 | [§6.4](#64-新增缺口扩展页重设计--mcp-登录这一轮) |
| `G-API-20` | `web_assets` 抓回来的图，界面上没有任何地方看得到 | [§14](#14-web_fetch-抓回来的图这一轮2026-08-21) |
| `G-API-23` | 轮次详情看不到 `tool.expanded`，无法直接核对本轮展开的工具 | [§16](#16-工具目录按需暴露这一轮) |
| `G-CFG-09` | `agent.acp.agents` 只有裸 JSON 够得着，没有专用表 | [§18](#18-acp-客户端这一轮m132026-08-22) |
| `G-UI-05` | 权限矩阵视图（拿界面这张表跟 `docs/05 §4` 那张权威表对） | [§19](#19-手动验收这一轮2026-08-25) |
| `G-UI-06` | 别名链上看不出谁能看图 —— `vision` 链首配错时界面毫无提示 | [§20](#20-别名链上看不出谁能看图2026-08-27) |
| `G-API-28` | 日志页没有「只看这条 run」的过滤器，worker 详情只能跳到整轮的 trace | [§21](#21-worker-重构这一轮) |
| `G-API-29` | 会话列表混列 SDK 会话，无来源标识与过滤 | [§22](#22-sdk-接入这一轮2026-09-05) |
| `G-API-30` | 消息浏览页对 SDK 会话无 Telegram 元数据可显示 | [§22](#22-sdk-接入这一轮2026-09-05) |
| `G-API-31` | `sourceUsage()` 无 HTTP 端点，WebUI 无按来源用量视图 | [§22](#22-sdk-接入这一轮2026-09-05) |

后六条标着「记录，不当轮闭合」，理由各自写在所属小节里 —— **不是忘了做，是位置/判据没定**。

### 0.1 已闭合的（索引）

正文一行没动，都在原节。这张表只是为了不必从头翻。

| 节 | 编号 | 哪一轮 |
|---|---|---|
| [§1.2](#12-假控件界面上能点运行时不读) 假控件 | `G-CFG-01`–`07` | 第一轮 / 第四轮 |
| [§2.1](#21-后端有前端没有入口真缺口) 后端有前端没有 | `G-API-01`–`12` | 第一 / 二 / 三轮 |
| [§2.2](#22-docs09-4-承诺了后端也没有) docs/09 承诺后端也没有 | `G-SRV-01`–`05` | 第二 / 三 / 五轮 |
| [§3](#g-sse-01p0webui-的实时刷新从来没有工作过--已修) SSE 实时刷新 | `G-SSE-01`（P0） | 第二轮 |
| §6.1 第六轮整改后 | `G-API-13` `G-API-14` | 第四轮 |
| §6.3 第十轮活体测试后 | `G-API-26` `G-API-27` | 界面这一半已接 |
| §8.1 · §8.2 日志详情 / 定时任务管理面 | `G-API-15` `G-API-16` | 定时任务轮 |
| [§9](#9-装-skill-包这一轮) 装 skill 包 | `G-EXT-01`–`07` | 本轮补 |
| §10 标记模型能力 | `G-API-17` | 2026-08-19 |
| §11 会话级持久容器 | `G-SBX-01`–`03` | 2026-08-19 |
| §12 界面在说谎的三处 | `G-UI-01` `G-UI-02` `G-CFG-08` | 2026-08-19 |
| §13 界面不显示合成出来的有效角色 | `G-UI-03` | 2026-08-20（2026-08-30 结案） |
| §15 任务卡与定时任务编辑 | `G-API-21` `G-API-22` | 2026-08-21 |
| §17 Telegram 审批裁决通道 | `G-API-24` | 2026-08-21 |
| §18 ACP | `G-UI-04` | 2026-08-22 |

⚠ **`G-EXT-01`–`05` 与 `G-SBX-01` 跟 [`reviews/15`](./reviews/15-gap-review.md) 撞号**，指着完全不同的东西
（那份是第一轮的扩展生态/沙箱缺口）。源码里那两处 `G-EXT-05` 引的是**本文**的。引这几个编号必须带
文档号，`tests/docs.test.ts` 对同名异义完全免疫 —— 详见 [`README §0.1`](./README.md) 的警示表。

---

## 0.2 一句话结论（前四轮的快照）

盘点前，`config.schema` 的 **151 个已接线配置叶子里只有 15 个**能在 WebUI 改；配额、沙箱、
维护操作、扩展启停、配置历史、退出登录六块能力后端已有、前端无入口。第一轮把这六块接上，
可写覆盖率从 15/151 提到 44/151。

第二轮修复唯一 P0：G-SSE-01（WebUI 实时刷新完全没工作过），同时补齐取消、附件、会话级覆盖与
schema 自动表单，可写覆盖率达到 151/151（第三轮接线两项后是 **153/153**）。第三轮把最后六项补齐：真实运行时提示词预览、
归档消息软删、可等待且可裁决的审批流、MCP transport CRUD、Skill 正文 CRUD 与 Agent 隔离试跑。
除 §5 明确列出的重复端点、只读策略和未接线运行时配置外，**没有剩余控制面覆盖缺口**。

第四轮换了个问法：控件都有了，但**它说话算数吗**。答案是七处不算数 —— 工具开关会被整块 JSON
永久吞掉、五个键被环境变量压着还照样回报「已保存」、密钥只读把 `web_search` 变成空开关、
两处热更新徽标说反了、沙箱改动不进变更历史、审批规则写错静默不生效。都在 §1.2 与 §7。

---

## 1. 配置项覆盖

复算方法（改了 schema 或页面之后重跑）：拿 `config/config.schema.json` 展平成叶子路径，
扣掉 `KNOWN_UNIMPLEMENTED_CONFIG_KEYS` 与 `perChat`（它是覆盖层容器不是配置项），
再和页面上实际能写的键取差集。

**当前值（2026-08-30 worker 重构后复算，跑的就是上面那套方法）：**

带 〔实测〕 的三行由 `tests/docs.test.ts` 焊住 —— 改了 schema 或摘了未接线键，这张表会自己报错，
不用记得回来手改。（这正是它此前烂掉的原因：没有闸的计数快照一定会漂。）

| | 数量 |
|---|---|
| schema 叶子总数 | **284** 〔实测〕 |
| 运行时从不读（`KNOWN_UNIMPLEMENTED_CONFIG_KEYS`） | **10** 〔实测〕 —— 权威在 [11 §2.0.1](./11-config-reference.md)，由 `tests/config.test.ts` 双向焊住 |
| `perChat`（覆盖层容器，不是配置项） | 1 |
| **已接线** | **273** 〔实测〕 |

⚠ **下面那张 2026-08-18 的表在 2026-08-27 之前一直被当成现值读，而它的「67」当时已经是「10」。**
同一个数字在本文里曾有三个版本（§1 的 67、§5 的 70、§7 的 67），全部对着代码里的 10。
教训写在这儿而不是删掉：**这类计数快照必须标死日期，且不许在别处复述** —— 复述的那两处
（§5、§7）没有一处标了日期，于是它们比表本身更像现值。现在三处都指回 [11 §2.0.1](./11-config-reference.md)。

<details><summary>2026-08-18 的历史快照（分项拆解，勿当现值读）</summary>

| | 数量（2026-08-18 复算） |
|---|---|
| schema 叶子总数 | 240（+14：M12 的 `tools.selfExtend.*` 整块） |
| 运行时从不读（`KNOWN_UNIMPLEMENTED_CONFIG_KEYS`） | 67（−5，见下） |
| `perChat`（覆盖层容器，不是配置项） | 1 |
| **已接线** | **172** |
| ├ 第一轮之前 WebUI 可写 | 15 |
| ├ 第一轮新增可写 | 29（配额 17 + 沙箱 12） |
| ├ 第二轮新增可写 | 107（自动生成的表单一次覆盖剩下全部，§4.3） |
| ├ 此后新增接线 | 5（见下）＋ 2 个新叶子，表单自动跟着长 |
| ├ M12 自我扩展 | 14（`tools.selfExtend.*`，全部由自动生成的表单覆盖） |
| ├ 其中环境变量钉住、界面刻意不给改 | 5（G-CFG-03；`envPinned`） |
| ├ 其中只读（要 argon2 哈希，走改口令表单） | 1（`webui.passwordHash`） |
| └ **仍然只能改 `config.yaml`** | **0** |

</details>

五项已从白名单摘掉（真接了线）：`approval.ttlMs` 随可等待审批被 `DatabaseApprovalBroker.request`
读起来（G-API-12）；`mcp.enabled` 本来就是 `McpManager.reconcile` 的总开关（当初进白名单是错判）；
`context.background.showUsername`、`tools.tg.maxExtraMessagesPerTurn`、`tools.tg.maxFileSendMb`
在后续几轮接线。摘的时候要同步四处：`schema.ts` 的两张表、`docs/11` 的 🚧 清单、本节这几个数字，
以及 `docs/13` 的相关验收条目。

> 上一版这三个数字（224 / 70 / 153）与当时的代码已经差了两项 —— 表格里的数不像断言那样会自己响，
> 所以复算方法写在本节开头：改过 schema 或白名单之后重跑一遍再改这张表。密钥字段那一行也变了：
> 曾经是「2 项只读」，现在密钥是**只写**（不回显、留空表示不改），只剩 `webui.passwordHash` 只读。

### 1.1 曾经「已接线但 WebUI 改不了」的那 109 项 —— ✅ 第二 / 三轮全部接上

**现在这一张表只剩存档价值**：设置页的「全部配置」由 `config/config.schema.json` 自动生成，
下面每一项都能在界面上改（§4.3）。留着这张分组表是为了下次复算时对得上号 ——
**表里每一项都是运行时真的会读的值**。

⚠ **键名按 2026-08-16 那天写死，此后没有跟着改。** worker 重构（2026-08-30）删了
`agent.maxDepth`，并把 `agent.maxSubagentsPerTurn` / `agent.maxConcurrentSubagents` 改名成
`agent.maxWorkersPerTurn` / `agent.maxConcurrentWorkers`（**没有迁移**，见
[11 §2.0.0](./11-config-reference.md)）。**要现值去查 schema，不要照这张表抄** —— 它记的是
那一天的分组与条数，不是键名的现状。

> 「改得动」之后剩下的那半个缺口是「敢不敢改」：表单一度只给点分键名，键名认不出来就只能回去翻
> `docs/11`。现在每一格都带一句作用说明，来源是 `CONFIG_DESCRIPTIONS` 注入 schema 的 `description`
> （[09 §3.13](./09-webui.md)），`tests/config.test.ts` 断言它与 schema 叶子一一对应 ——
> 新增配置项时不写说明就过不了 CI。
>
> 还有第三个问题不在本文口径内但同一张表单上：**「这个部署到底改过什么」**。覆盖率做满之后
> 243 个叶子平铺在一起，而实测一个真实部署只有 **21 个偏离默认值** —— 此前唯一能查的是
> 「原始 YAML」，可那里是**覆盖层不是差异集**（专用面板保存时整组写回，`config_kv` 实测 50 行、
> 大半与默认值相同）。表单现在有「只看非默认值」筛选，判据是当前值 ≠ schema 的 `default`
> （[09 §3.13](./09-webui.md)）。

| 分组 | 数量 | 键 |
|---|---|---|
| `tools` | 16 | `maxRegistered` `maxCallsPerTurn` `maxConsecutiveErrors` `defaultTimeoutMs` `fs.maxReadBytes` `fs.maxWriteBytes` `fs.showHidden` `fs.denyGlobs` `fs.trashDir` `fs.backupDir` `exec.defaultTimeoutMs` `exec.maxTimeoutMs` `exec.maxOutputBytes` `web.maxResponseBytes` `web.searchProvider` `web.searchApiKey` |
| `context` | 9 | `scope` `limit.tokens` `limit.maxMessages` `limit.minKeepTurns` `hardCapRatio` `background.enabled` `background.maxPerTurn` `rebase.injectNotice` `tokenRatioAlpha` |
| `provider` | 9 | `maxRetries` `retryBaseMs` `retryMaxMs` `healthCheckCron` `catalog.enabled` `catalog.url` `catalog.cacheFile` `catalog.ttlHours` `catalog.timeoutMs` |
| `webui` | 8 | `host` `port` `sessionTtlHours` `passwordHash` `trustProxy` `allowOrigins` `loginRateLimit.attempts` `loginRateLimit.windowMinutes` |
| `agent` | 7 | `main.modelAlias` `main.maxSteps` `main.downgradeAfterStep` `maxDepth` `maxSubagentsPerTurn` `askTimeoutMs` `maxAsksPerRun` |
| `memory` | 6 | `dir` `pubWriteMinRole` `softLimitTokens` `hardLimitTokens` `maxSections` `compactCron` |
| `media` | 7 | `dir` `maxImageBytes` `maxDocBytes` `maxImageEdge` `extract.enabled` `extract.maxChars` `extract.inlineChars` |
| `logs` | 6 | `level` `dbPath` `captureBodies` `compress` `retentionDays` `console` |
| `telegram` | 6 | `mode` `allowedUpdates` `allowBots` `strictCommandSuffix` `throttle.globalPerSecond` `throttle.perChatPerMinute` |
| `concurrency` | 5 | `mode` `perKey` `global` `queueMax` `turnTimeoutMs` |
| `access` | 4 | `defaultUserRole` `defaultChatRole` `archiveBlocked` `bootstrapOwnerId` |
| `approval` | 5 | `enabled` `ttlMs` `skipForOwner` `rememberWithinTurn` `rules` |
| `plugins` | 4 | `dir` `hookTimeoutMs` `order` `autoDisableAfterErrors` |
| `general` | 3 | `timezone` `maintenanceCron` `shutdown.graceMs` |
| `skills` | 3 | `dir` `watch` `defaultMinRole` |
| `mcp` | 4 | `enabled` `healthCheckCron` `defaultMinRole` `servers` |
| `db` | 3 | `path` `backupKeep` `vacuumCron` |
| `prompt` | 1 | `maxTokens` |
| `output` | 1 | `maxMessageChars` |

当时点名「最该先补」的那几项（`logs.level` / `logs.captureBodies`、`access.*`、`approval.*`、
`agent.main.*`、`context.limit.*`、`tools.maxCallsPerTurn` / `tools.exec.*`）现在都带着「热更新」
徽标摆在设置页上，改完下一条消息即生效。

> 顺带修掉一个会直接反映到界面上的错标：`logs.captureBodies` 是每轮从 `turn.config` 现读的
> （`runtime.ts` 的 `bodyForLog`、`GET /api/turns/:id/detail`），**真的是热更新**，却漏在
> `HOT_RELOADABLE_CONFIG_KEYS` 外 —— 表单会对着排障时最常翻的这个开关说「需重启」。
> 第三轮把 `skills.defaultMinRole` 接进了 `SkillLoader.create()`，新建表单也从当前配置快照取默认值，
> 因而现在确实是热更新；`plugins.order` 仍由 `PluginManager` 在构造时拿走，必须重启。
> `tests/config.test.ts` 会逐段检查 docs/11 的热更新标记，避免 `logs` / `skills` / `plugins`
> 整段漏检。

### 1.2 假控件：界面上能点，运行时不读

| ID | 位置 | 说明 | 状态 |
|---|---|---|---|
| G-CFG-01 | 设置 › 触发与唤醒词 › `编辑旧消息不重新触发` | `trigger.ignoreEditedAsTrigger` 在 `KNOWN_UNIMPLEMENTED_CONFIG_KEYS` 里：编辑消息一律按背景消息归档（docs/20 · W-TG-05）。这个勾选框存得下、运行时没人读 | ✅ 第一轮改成禁用 + 「未接线」徽标 |
| **G-CFG-02** | 工具页的每一个启停开关 | 覆盖层按 `config_kv` 的 rowid（插入序）应用，而 `assignDotted` 是整叶覆盖 —— **先**点过工具页的 `tools.overrides.<name>`、**后**在「全部配置」里编辑过 `tools.overrides` 整块，那一行 rowid 更小、永远先被应用：此后每次点开关都是 200 OK，刷新回来还是原样。工具禁用是硬边界（CLAUDE.md），不能这么失效 | ✅ 第四轮：载入侧按点分深度排序（更具体的赢，`sortOverrideKeys`），写入侧写祖先键时删掉后代行并记进变更历史 |
| **G-CFG-03** | 5 个被环境变量钉住的键 | env 层在覆盖层**之后**合并（`config/index.ts`、`main.ts` 的 `envOverlay`），所以 `access.bootstrapOwnerId`（`LUOLI_OWNER_ID` 必填 → 恒被钉住）、`webui.host`、`webui.passwordHash`、`db.path`、`sandbox.hostWorkspaceDir` 的写入注定无效：表单给可编辑控件、Toast 说已保存、`config_revisions` 也记了一笔，下次加载照旧交回 env 的值。`sandbox.hostWorkspaceDir` 还挂着「热更新」徽标 | ✅ 第四轮：`ENV_PINNED_CONFIG_KEYS` + `GET /api/config/schema` 的 `envPinned`，表单禁用并点名该改哪个变量，写入端 400 `config_pinned_by_env`，改口令端点在 `WEBUI_PASSWORD` 存在时 409 |
| **G-CFG-04** | `tools.web.searchProvider` | 密钥字段一律只读，于是 `tools.web.searchApiKey` 在 WebUI 里压根配不了；而 `web_search` 的 `available()` 要求 provider 与 key **同时**有值 —— 那个可写的下拉框选了也不会有工具进目录，纯 WebUI 部署永远开不出 web_search | ✅ 第四轮：密钥改成**只写**字段（不回显、留空表示不改、另给清空），同时前后端都拒收把 `«redacted»` 原样提交回来的值 |
| **G-CFG-05** | `mcp.healthCheckCron` 的「热更新」徽标；7 个 `webui.*` 的「需重启」徽标 | 热更新白名单里写的是整段 `mcp`，但那个 cron 是 `scheduler.add()` 在启动时拿走的、`Scheduler` 也没有重配入口 —— 界面对它说谎（docs/20 · W-CFG-02 同一形态）。反方向同样错：`webui.sessionTtlHours` / `passwordHash` / `trustProxy` / `trustedProxyHops` / `allowOrigins` / `loginRateLimit.*` 都是每请求从 `currentConfig()` 现读的，标「需重启」等于让人白重启一次 | ✅ 第四轮：白名单精确到 `mcp.enabled`/`defaultMinRole`/`servers`，补上那 7 个 `webui.*`，`docs/11` 同步标注 |
| **G-CFG-06** | 沙箱卡片的每一次保存 | `PUT /api/sandbox` 只写 `config_kv`、**不写 `config_revisions`** —— `sandbox.mode`、`bypassRoles` 这种安全相关改动在「变更历史」里完全查不到 | ✅ 第四轮：六个写入点统一走 `writeConfigRows`，审计与作废都在一处 |
| **G-CFG-07** | 「全部配置」里的 `approval.rules` | schema 是 `z.array(z.record(z.unknown()))`：字段名写错（`toolName`）、正则编译不了、`risk` 写成 `huge`、`always: false` 一律 200 收下，而运行时 `ApprovalRules` 会把这些规则静默丢掉或永不命中 —— 一道「静默不生效」的审批门等于门开着 | ✅ 第四轮：换成真 schema（`.strict()` + 正则编译校验 + `always` 只收 `true`），写错当场 400 |

除上述之外没有别的假控件 —— 配额页新增的 5 个未接线键刻意不给控件，只列名字。

---

## 2. API 端点覆盖

服务端现注册 **91** 条 `/api/*` 路由：第二轮增加 2 条 turn 取消路由，第三轮再增加 7 条
（MCP CRUD 3、Skill 详情/新建/完整更新 3、Agent 试跑 1；prompt preview、消息软删与审批裁决原本已有端点），
第六轮补 `POST /api/auth/password`（当时漏改这个数），第四轮补
`DELETE /api/chats/:key/model-alias`（G-API-14）。逐条比对 WebUI 的调用点后：

### 2.1 后端有、前端没有入口（真缺口）

| ID | 端点 | 缺的是什么 | 优先级 | 状态 |
|---|---|---|---|---|
| G-API-01 | `GET/PUT /api/quota` `POST /api/quota/reset` | 配额限额与实时计数器 | P1 | ✅ 第一轮补（新增「配额」页；`GET` 此前根本不存在、`PUT` 是 `not_implemented` 桩） |
| G-API-02 | `GET/PUT /api/sandbox` `POST /api/sandbox/probe` | 沙箱 mode / 资源限制 / `bypassRoles` / 可用性探测 | P1 | ✅ 第一轮补（工具页新增沙箱卡片） |
| G-API-03 | `POST /api/maintenance/*` | 备份 / VACUUM / 清理日志 / 重建 FTS | P1 | ✅ 第一轮补（设置页） |
| G-API-04 | `PATCH /api/skills/:name` `DELETE /api/skills/:name` `PATCH /api/plugins/:name` `POST /api/plugins/:name/reload` `POST /api/mcp/:name/reconnect` | 扩展页此前是纯只读卡片，启停与重连都没有 | P1 | ✅ 第一轮补 |
| G-API-05 | `GET /api/config/revisions` | 配置变更历史（谁在什么时候把哪个键改成了什么） | P2 | ✅ 第一轮补（设置页「变更历史」） |
| G-API-06 | `POST /api/auth/logout` | **界面上没有退出登录** —— 只能等 session 过期或手删 cookie | P2 | ✅ 第一轮补（顶栏） |
| G-API-07 | `GET /api/health/detail` | 总览页「依赖健康」四行是**写死的字**，沙箱恒显示「Docker」，与 `sandbox.mode` 无关 | P1 | ✅ 第一轮补（改为真实数据 + MCP / 在途 turn / 版本 / 运行时长） |
| G-API-08 | `GET /api/files/:attachmentId` | **图片与文件在 WebUI 里完全不可见**：消息列表不返回 attachment id，也没有任何地方能点开。当时库里有 8 条附件、9 条非文本消息 | P1 | ✅ 第二轮补（消息卡片与检索结果下面的附件带子：图片出缩略图可点开大图，其余给下载；`?inline=1` 只对光栅图放行） |
| G-API-09 | `PATCH /api/chats/:key` | 会话级配置覆盖（`perChat.<key>.trigger` / `.output` 等白名单项）。docs/09 §3.13 写明「设置页不提供」，但会话页也没提供 —— 这个端点当时**只能用 curl 打** | P2 | ✅ 第二轮补（会话页「只对这个会话生效的设置」卡片：白名单内的项按 schema 生成控件，覆盖项以 chip 列出并可逐条取消） |
| G-API-10 | `POST /api/prompts/preview` | 提示词组装预览（「这个会话下最终发给模型的 system prompt 长什么样」） | P2 | ✅ 第三轮补（与真实轮次共用 `assembleMainPrompt`，展示每个 block 的正文、token 与截断状态） |
| G-API-11 | `DELETE /api/messages/:id` | 归档消息软删。合规/隐私诉求下唯一的删除通道 | P2 | ✅ 第三轮补（检索结果与会话卡片均有二次确认；turn 列表/详情不再回显已删 prompt） |
| G-API-12 | `POST /api/approvals/:id/decide` | 审批裁决按钮；命中规则的调用必须保持 pending，裁决后才能继续或拒绝 | P3 | ✅ 第三轮补（WebUI owner 可批准/拒绝；TTL 与轮次取消均 fail-closed） |

### 2.2 docs/09 §4 承诺了、后端也没有

补 UI 之前得先补后端。

| ID | 端点 | 对应的界面承诺 | 优先级 | 状态 |
|---|---|---|---|---|
| G-SRV-01 | ~~`POST /api/tasks/:id/cancel`~~ → `GET /api/turns/active` + `POST /api/turns/:id/cancel` | docs §3.1 在途 turn 表的 `[取消]`、§3.12 任务表的 `[取消]`。**Telegram 侧有 `/cancel`，WebUI 侧没有任何取消通道** | P1 | ✅ 第二轮补（换了端点名，理由见 §4.2） |
| G-SRV-02 | `POST /api/agents/:name/dryrun` | docs §3.9 的 `[试跑]` | P3 | ✅ 第三轮补（NDJSON 流式 step / usage / final / error；断开请求即 abort） |
| G-SRV-03 | `POST/PATCH/DELETE /api/mcp[/:name]` | docs §3.8 的 MCP transport 配置表单与启停 | P2 | ✅ 第三轮补（transport-aware schema 校验，写 `config_kv` / revision 并立即 reconcile） |
| G-SRV-04 | `POST /api/skills` `PUT /api/skills/:name` | docs §3.8 的 Skill 新建与正文编辑（含正文读写） | P3 | ✅ 第三轮补（安全写 `SKILL.md`、重扫并同步数据库；另有详情与删除端点） |
| G-SRV-05 | `POST /api/maintenance/gc-files` | 孤儿文件清理 | P3 | ✅ 第五轮实现（`MaintenanceService.gcFiles()` 扫 `data/files/**` 与 `data/agent-results/**` 里没有 DB 行指向的文件；设置页补按钮。**不含**媒体过期策略，那是 docs/14 Q9） |

### 2.3 契约测试的假绿灯（已修）

`tests/api.contract.test.ts` 对当时那 21 条读端点只断言 `status === 200`（现在是 23 条）。未注册的 `/api/*` 会掉进
SPA fallback（`app.get('*')` 返回 `index.html`，200），所以 **`GET /api/quota` 这条断言在端点
根本不存在的情况下绿了很久**。第一轮改成同时断言 `content-type: application/json` 与信封的 `ok:true`。

**成因本身也已经堵掉**：静态兜底之前加了 `app.all('/api/*', …)` → 404 JSON。此前未匹配的 API 路径
会拿到 200 + `index.html`，前端 `api()` 在 `response.json()` 处抛 SyntaxError，报错信息与真实原因
（路径写错了）毫无关系（docs/22 · I-13）。

---

## 3. SSE 事件覆盖

### G-SSE-01（P0）：WebUI 的实时刷新从来没有工作过 —— ✅ 已修

**修之前**：docs/09 §5 列了 9 种事件，实际 `events.emit(...)` 的调用点只有两处
（`config.changed` 与未列在文档里的 `approval.decided`）。`ConsoleView.vue` 唯一监听的 `log`
永远不会到达，因为 **`LogSink` 的构造函数根本没有 `EventBus` 参数**，日志写入路径上没有任何 emit。
后果：

- 首屏 `load()` 之后界面再也不会自己刷新，看到的永远是打开那一刻的快照（已实测：另一进程往库里
  写了 skill / plugin / mcp 行，界面上要手动刷新页面才出现）。
- 顶栏与日志页的「实时 / 在线」徽标只反映 **EventSource 连上了**，不反映有数据在流动。
- 源码里多处注释写着「日志 SSE 每来一条事件就重跑 `load()`，所以表单要防回写覆盖」——
  **那套防回写机制是为一个从不发生的事件写的**。

**修之后**的事件覆盖（发送点见 [09 §5](./09-webui.md#5-sse-事件)）：

| 事件 | 文档 | 实际 |
|---|---|---|
| `log` | ✓ | ✅ `LogSink.event()` 落库之后广播摘要 |
| `turn.started` `turn.finished` | ✓ | ✅ `bot.ts` 已有的 `turn.start` / `turn.end` 日志点旁边 |
| `turn.progress` | ✓ | ✅ `runtime.ts` 的 `onStepStart`（模型）与 `onStepEnd`（工具） |
| `usage` | ✓ | ✅ `runtime.ts` 的 `onStepEnd`，与 `ledger.record` 同一处 |
| `quota` | ✓ | ✅ `QuotaGuard.commit`，事务提交之后 |
| `task.updated` | ✓ | ✅ `spawn_agent` 的三次状态迁移 + `report_progress` |
| `health` | ✓ | ⚠️ 只在健康状态**真的会变**的两处发（`POST /api/providers/:id/test`、`POST /api/mcp/:name/reconnect`）。没有独立的健康轮询器，它不是周期心跳 |
| `config.changed` | ✓ | ✅ 会发（`PUT /api/config`、`PATCH /api/chats/:key`、`PATCH /api/tools/:name`、`PUT /api/sandbox`、`PUT /api/quota`） |
| `approval.decided` | 未列在文档里 | ✅ 会发（已补进 docs/09 §5 的表） |
| `approval.pending` | ✓ | ✅ 命中审批规则后写 pending 行并广播；任务页定向刷新，owner 可批准或拒绝 |

三条硬约束（[10 §3](./10-logging-and-observability.md#3-落盘格式) 有完整说明）：
`log` **只发摘要不发 `data`**；`debug` 不广播；同一 `kind` 在 200 ms 内合并成一条并带 `merged: n`。
阈值与窗口写死在 `LogSink` 里，不做成配置项 —— 调松它们的唯一效果是把 SSE 连接和前端一起打爆。

前端同步换掉了「收到任何事件就重跑 `load()`」（那是一次 18 个端点，接上事件之后立刻会变成
自我 DDoS）：每种事件映射到固定的几组数据，**且只刷当前页面看得见的那几组**，同组 400 ms 内合并，
切页时由 `watch(active)` 补拉。`turn.progress` 直接用载荷更新在途表，不回查。
那几处描述「日志心跳」的注释也改成了现在真正会发生的事。

---

## 4. 改了什么

### 4.1 第一轮（配额 / 沙箱 / 维护 / 扩展启停 / 变更历史 / 退出登录）

| 改动 | 文件 |
|---|---|
| 新增 `GET /api/quota`（限额 + 计数器 + 服务端合成的 `limit` + 缺定价模型 + 未接线键名） | `packages/server/src/app.ts` |
| `PUT /api/quota` 从 `not_implemented` 桩改成真实写入（点分键 → `configSchema` → `config_kv` + `config_revisions` + `config.changed`） | 同上 |
| `POST /api/quota/reset` 支持 `{scope, subject, window, bucket}` 精确重置（不带 body 仍是全表清零；只给非 `scope` 过滤条件返回 400） | 同上 |
| 导出 `quotaBucket`，服务端与记账侧共用同一份 bucket 计算 | `packages/core/src/ledger/quota.ts` |
| 新增「配额」页；工具页新增沙箱卡片；设置页新增维护操作与配置变更历史；扩展页支持启停 / 重载 / 重连；顶栏新增退出登录；总览页依赖健康改为真实数据 | `packages/webui/src/views/ConsoleView.vue` |
| MCP 卡片改读 `state` / `last_error`（此前只看 `load_error`，连不上的 server 显示成「可用」） | 同上 |
| `trigger.ignoreEditedAsTrigger` 勾选框禁用并标「未接线」 | 同上 |
| 契约测试补 `content-type` + `ok:true` 断言，堵掉 SPA fallback 造成的假绿灯 | `tests/api.contract.test.ts` |
| 新增配额 API 的 6 条用例（byRole 合成、`limitApprox`、缺定价统计、点分键落库与广播、原型污染键、精确重置） | `tests/quota.api.test.ts` |

### 4.2 第二轮（G-SSE-01 + G-SRV-01）

| 改动 | 文件 |
|---|---|
| `LogSink` 接 `EventBus`：落库后广播摘要（`{id, ts, level, kind, traceId, summary}`），`debug` 不广播，同 `kind` 200 ms 合并并带 `merged`；尾包定时器 `unref()`，另加 `close()` 供关停时丢弃 | `packages/core/src/log/sink.ts` |
| `LogSink.publish(type, data)`：结构化事件不落库只广播。**每个已经持有 `log` 的调用点直接发**，不把 `EventBus` 再挨个穿进 bot / runtime / builtins 的依赖对象 —— 漏穿一个的表现就是某一类事件永远不到，而这正是 G-SSE-01 的成因。只有拿不到 `LogSink` 的 `QuotaGuard` 是显式收 `EventBus` 的 | 同上 |
| `turn.started` / `turn.finished` 在已有的 `turn.start` / `turn.end` 日志点旁边发 | `packages/telegram/src/bot.ts` |
| `turn.progress`（模型/工具两个相位）与 `usage` 在 `onStepStart` / `onStepEnd` 发 | `packages/core/src/agent/runtime.ts` |
| `TurnRepository.finish` 改用 `UPDATE … RETURNING` 回一份结算统计（steps / toolCalls / costUsd / durationMs），供 `turn.finished` 用；不额外查一次 | `packages/db/src/operations.ts` |
| `QuotaGuard` 接 `EventBus`：`commit` 用 `RETURNING` 顺手拿回已花金额，事务提交后发 `quota`；`QuotaReservation.rows` 多带一个 `limit`（结算时已经拿不到本轮限额了） | `packages/core/src/ledger/quota.ts` |
| `task.updated`：`spawn_agent` 的 running / done / failed 三次迁移 + `report_progress` | `packages/core/src/tools/builtins.ts` |
| `health` 事件在 provider 测试与 MCP 重连之后发；`reconnect` 顺带返回该 server 的 `{state, error}` | `packages/server/src/app.ts` |
| 新增 `GET /api/turns/active`（读进程内 `TurnRegistry`，统计从 `turns` 表一次 IN 取回，缺行补零）与 `POST /api/turns/:id/cancel`（abort 信号，已结束的轮次回 `{cancelled:false}`） | 同上 |
| `EventBus` 提到 `QuotaGuard` / `LogSink` 之前构造；关停时 `log.close()` | `apps/bot/src/main.ts` |
| 前端：事件按类型定向刷新（9 组数据 + 页面可见性过滤 + 400 ms 合并），总览页新增在途 turn 表与 `[取消]`，任务页 running 行加 `[取消]`（说明取消的是整轮），审批卡片写明为什么不给裁决按钮，SSE 徽标区分「连上了」与「有数据在流动」 | `packages/webui/src/views/ConsoleView.vue` |
| 新增 6 条用例：广播阈值与合并窗口、`publish` 不落库、`/api/events` 流上真的收得到、配额事件载荷、`/api/turns/active` 形状、取消端点两种结果与审计 | `tests/sse.events.test.ts` |
| 契约测试补 `/api/turns`、`/api/turns/active` 两条读端点 | `tests/api.contract.test.ts` |

**为什么端点名从 `POST /api/tasks/:id/cancel` 换成 `POST /api/turns/:id/cancel`**：
`tasks` 行由 `spawn_agent` 派发，子 agent 跑在**父轮次**的 abort 信号下，没有独立的取消句柄。
按原名做一个「取消这条任务」的端点，实际行为却是把整轮连同其他子 agent 一起停 —— 那是个会误导人的名字。
界面上任务表的 `[取消]` 仍在，只是打的是轮次取消，并在二次确认里说清楚它停的是什么。

### 4.3 第二轮（G-API-08：附件可见）

| 改动 | 文件 |
|---|---|
| `GET /api/messages` 与 `GET /api/turns` 返回 `attachments`（按 `message_id` 一次 IN 查询归组，**不含 `local_path`**） | `packages/server/src/app.ts` |
| `GET /api/files/:attachmentId?inline=1` 只对光栅图（png/jpeg/gif/webp）放行内联，其余照旧当附件下载 —— mime 来自 Telegram、是发送方可控的，同源内联 SVG/HTML 等于自造 XSS | 同上 |
| 新组件：消息卡片与检索结果下面的附件带子。图片出 92px 缩略图、点开是大图 + 下载；其余按类型出图标 chip（文件名 / mime / 大小 / 尺寸 / 时长 / 「已提取正文」）。`download_state` 不是 `done` 的行打「下载失败 / 超限未下载」徽标并**不给下载链接** —— 点开必然 404 | `packages/webui/src/ui/AttachmentStrip.vue` |
| 契约测试补一条：附件元数据形状、响应里不出现磁盘路径、`?inline=1` 对 png 给 `inline` 而对 svg 仍给 `attachment` | `tests/api.contract.test.ts` |

### 4.4 第二轮（§1.1 的自动生成表单 + G-API-09 的会话级覆盖）

| 改动 | 文件 |
|---|---|
| `GET /api/config/schema` 的 `{schema, hotReloadable, unimplemented}` 三件套改为**放进 `data` 信封**：统一客户端只解 `data`，挂在顶层的兄弟键会被静默丢掉，表单会把每一项都当成需重启 | `packages/server/src/app.ts` |
| 新组件 `SchemaForm`：走一遍 JSON Schema（含 `$ref` 解析、`anyOf[number,null]` 的「不限」）推出控件形态 —— 布尔/枚举/整数小数/字符串/字符串数组（一行一条）/对象与对象数组（JSON 文本域）；每项显示键路径、默认值、取值范围、「热更新 / 需重启 / 未接线」徽标；未接线项默认隐藏且控件禁用；**值为 `«redacted»` 或名字像密钥的字符串一律只读**（写回去等于用字面量覆盖真值）；按键名过滤、只看热更新项、分组折叠、只发真正改过的那几项 | `packages/webui/src/ui/SchemaForm.vue` |
| 设置页接上「全部配置」；保存后按 `hotReloadable` 分类回报，**需重启的键在 Toast 里点名**。保存成功后把表单基线推上去 —— 落库是同步的但 bot 进程要等 `config.changed` 才 `loadConfig()`，紧接着那次 `GET /api/config` 可能还是旧值，不推基线的话保存完按钮还挂着「保存 N 项改动」 | `packages/webui/src/views/ConsoleView.vue` |
| 会话页新增「只对这个会话生效的设置」：当前覆盖以 chip 列出并可逐条 `[取消覆盖]`（空掉的中间层一并收掉），下面复用 `SchemaForm` 但只渲染 `docs/11 §2.1` 白名单内的子树，控件里显示的是**这个会话实际生效的值**（全局 + 覆盖）。`PATCH` 是整体替换而不是合并，所以每次都把完整覆盖对象发回去 | 同上 |
| `logs.captureBodies` 补进 `HOT_RELOADABLE_CONFIG_KEYS`（每轮现读，真的是热更新）；当时将尚未接线的 `skills.defaultMinRole` 改标「需重启」，第三轮接入 Skill 新建默认角色后再改为热更新 | `packages/core/src/config/schema.ts`、`docs/11-config-reference.md` |
| 那条「docs/11 标热更新的键必须真在白名单里」的断言改成**逐段扫全部 yaml 块**（此前只查第一段，`logs` / `skills` / `plugins` 整段漏在外面，三个错标就是这么活下来的） | `tests/config.test.ts` |
| 新增两条用例：`/api/config/schema` 的三件套在同一个 `data` 信封里；`PATCH /api/chats/:key` 是整体替换而不是合并（界面的「取消覆盖」正是靠这条语义） | `tests/config.api.test.ts` |

**一个只有真跑起来才会撞上的坑**：`config` 是深响应式 ref，读出来的嵌套对象是 Proxy，
而 `structuredClone(Proxy)` 直接抛 `DataCloneError` —— 表现是「点了取消覆盖没反应，连报错都没有」。
配置本来就是 JSON 安全的，改走一遍序列化，并把整段包进 try/catch 让失败能冒到 Toast 上。

### 4.5 第三轮（最后六项缺口）

| 改动 | 文件 |
|---|---|
| 抽出并导出 `assembleMainPrompt`，真实轮次与 `POST /api/prompts/preview` 共用工具目录、Skill 目录、Agent 目录、PromptDocuments、per-chat 配置与上下文组装路径；前端展示 block 正文、token 占比与截断状态 | `packages/core/src/agent/runtime.ts`、`apps/bot/src/main.ts`、`packages/server/src/app.ts`、`packages/webui/src/views/ConsoleView.vue` |
| 归档检索与会话卡片接软删入口；`/api/turns` 和 turn detail 的 prompt join 排除 `deleted_at` 非空行，避免删后从轮次视图泄回 | `packages/server/src/app.ts`、`packages/webui/src/views/ConsoleView.vue` |
| `DatabaseApprovalBroker` 改为 pending Promise：插入后发 `approval.pending`，WebUI 裁决、TTL、abort 三条路径原子改状态并唤醒等待调用；批准才继续执行工具 | `packages/core/src/approvals.ts`、`packages/webui/src/views/ConsoleView.vue` |
| MCP server 改用 stdio / HTTP 判别联合 schema；CRUD 统一校验并写 `mcp.servers`、配置 revision、`config.changed`，随后热 reconcile；前端表单覆盖 transport、参数、环境、headers、角色、工具白/黑名单与超时 | `packages/core/src/config/schema.ts`、`packages/server/src/app.ts`、`packages/webui/src/views/ConsoleView.vue` |
| `SkillLoader` 新增安全 create/read/update/remove，正文与 frontmatter 同写 `SKILL.md` 后重扫；`skills.defaultMinRole` 成为新建默认值并热读；扩展页新增正文编辑器 | `packages/core/src/skills/loader.ts`、`apps/bot/src/main.ts`、`packages/webui/src/views/ConsoleView.vue` |
| Agent 试跑创建可审计的隔离 `agent_run`，复用 `runSubAgent` 并以 NDJSON 推 step / usage / final / error；前端可查看工具输入输出、用量并取消流 | `packages/core/src/agent/manager.ts`、`packages/core/src/agent/subagent.ts`、`packages/server/src/app.ts`、`packages/webui/src/api/client.ts` |
| 契约覆盖 pending/批准/拒绝/过期/取消、Skill 文件生命周期、提示词/试跑 API、软删隐藏、MCP/Skill 管理路由 | `tests/approval.rules.test.ts`、`tests/skill.runtime.test.ts`、`tests/api.contract.test.ts` |

### 4.6 第三轮复查补漏

第三轮自查时发现六处「补上了能力但留了口子」，一并修掉：

| 改动 | 文件 |
|---|---|
| **试跑接上配额**：先 `quota.reserve` 再逐步 `commit`，额度不足直接拒绝开跑，`finally` 里 `release` 剩余预留。此前只传了 `ledger` 不传 `quota` —— 用量报表看得见这笔花费、`quota_counters` 却不涨，`global.daily` 对试跑一概无效（`subagent.ts` 的注释警告的正是这个，docs/20 · W-QUOTA-01）。chat/user 计数落在合成 subject `webui-dryrun` 上：试跑花的是真钱，但不该记到某个真实会话头上 | `apps/bot/src/main.ts` |
| **`mcp.enabled` 总开关摆到界面上**：它出厂是 `false` 且 `reconcile` 一上来就对它 early-return，新建 server 会拿到 `ok:true` 加一条永远停在「等待连接」的行。扩展页顶部与新建对话框在它关着时给横幅 + `[打开总开关]`，保存后的 Toast 也改成告警而不是「已连接」 | `packages/webui/src/views/ConsoleView.vue`、`docs/11` |
| **待审角标挂到导航上**：`approval.pending` 原本只刷 `tasks` 组，而该组只在任务页可见 —— 运维不切过去就不知道有个真实轮次正卡着。拆出独立的 `approvals` 刷新组（全页面可见，事件本身很稀疏），左侧导航「任务与审批」出红色计数 | 同上、`packages/webui/src/styles.css` |
| **过期/取消的 hint 不再被记成「已拒绝」**：`rememberWithinTurn` 原本只记布尔，同轮重试一个刚过期的调用会拿到 `DENIED_HINT`，模型据此告诉用户「管理员拒绝了」，而真相是没人来得及看 | `packages/core/src/approvals.ts` |
| Skill 重名从 400 改 409（`apiError` 放行 409），`PUT` / `PATCH /api/skills/:name` 合并成一个 handler —— 两个动词各抄一份 body 映射，改 frontmatter 字段时必然漏掉其中一个 | `packages/server/src/app.ts` |
| `docs/11` 的 🚧 清单里摘掉已接线的 `approval.ttlMs` 与 `mcp.enabled`（`config.test.ts` 那条断言只查白名单 → 文档单向，查不出文档里多标的 🚧）；`docs/13` 补 AC-APV-010/011 与 AC-WEB-049~054，并改掉与新行为矛盾的 AC-APV-008、AC-WEB-043 | `docs/11-config-reference.md`、`docs/13-acceptance-criteria.md` |

---

## 5. 判定为「不是缺口」

| 项 | 理由 |
|---|---|
| `GET /api/health` | 无鉴权探活端点，是给外部监控用的；SPA 该用 `/api/health/detail` |
| `GET /api/messages/:id`、`GET /api/chats/:key/commits` | 列表端点已经返回同样的字段，单条端点是给外部集成留的 |
| `GET /api/models/catalog` | `GET /api/providers/:id/models` 的响应里已经带 `catalog` 状态块 |
| 工具的 `scope` 只读 | `scope` 在运行时不参与任何判定，只是给人看的标签 —— 做成可写等于放一个改了没效果的开关。`source` 同理，它由注册方式决定 |
| ~~工具的 `minRole` / `approval` 只读~~ **已推翻** | 原理由是「单一策略源 `TOOL_POLICY` 注册期 fail-closed，从界面调低最低角色 = 权限矩阵有两份会漂移的真相」。现按运维诉求开放为覆盖层（`tools.overrides.<name>.minRole` / `.approval` / `.timeoutMs`）：`TOOL_POLICY` 降级为默认值与对照基准，界面同时显示「代码默认」与「当前生效」，**放宽需二次确认**（409 `relax_requires_confirmation`）并在表上留标记。漂移风险用三条性质压住 —— 覆盖不绕过 `available()`、`approvalFor` 只提档不降档、合并逻辑（`effectiveToolPolicy`）只有一份且 registry 与服务端共用。仅全局，不进 `perChat` 白名单。见 docs/09 §3.7 |
| 模型别名不能指向不存在的模型、别名链不能为空 | `PUT /api/aliases/:alias` 的校验，不是缺口 |
| `KNOWN_UNIMPLEMENTED_CONFIG_KEYS` 里的键（**条数一律看 [11 §2.0.1](./11-config-reference.md)，别在这儿记数**） | 运行时没接线，**不该**有控件。接线时从白名单里摘掉，同时补控件、改 `docs/11` 的 🚧 清单、复算 §1 的数字 |
| `ACP_DIR_WAIT_MS`（30 s，M13） | 它是 `acp/manager.ts` 里的**模块常量**，压根不是配置项 —— 目录互斥的等待上界。本文的口径是「运行时有这个能力而界面够不着」，而这里没有可够的东西：要它可配就先加配置键（连带 `docs/11` 一行、`CONFIG_DESCRIPTIONS` 一条、以及「等锁等多久」这件事到底该不该给运维调的判断） |

---

## 6. 第三轮结论

G-API-10/11/12 与 G-SRV-02/03/04 均已完成；按本文「运行时已有、WebUI 够不着」的口径，
当前没有剩余项。仍存在但**不属于本清单缺口**的边界：

- ~~`POST /api/maintenance/gc-files` 仍显式返回 `not_implemented`，界面继续不提供按钮。~~
  → 第五轮已实现并补上按钮（`G-SRV-05`）。
- ~~Telegram inline keyboard 审批仍未实现（裁决只能在 WebUI 做）~~ → **已实现**：带〔批准〕〔拒绝〕的
  审批消息**发到 owner 私聊**（`access.bootstrapOwnerId`），owner 点了落 `decision_channel='telegram'`
  （[05 §6](./05-tools-and-permissions.md)）。那条消息在收场时换成结局（撤键盘的同一次
  `editMessageText`），不留那句已经不成立的倒计时 —— 正是本文 §12「界面在说谎」那一类。
  待审角标照旧挂在导航上（§4.6）。
  **投递目标是拍板过的边界（2026-08-30 改，取代 2026-08-21 那次「不做」）**：群 / 频道里有效角色
  封顶 `trusted`，`decidableBy:'owner'` 在群里无人可满足，所以换的是投递目标而不是角色判据 ——
  按钮因此在**任何来源**的审批上都点得动；发起人会话只留一条**不含倒计时、不含状态**的报信，
  它不需要收场编辑，也就不会过期成谎话。owner 私聊不可达（403）时不往群里贴点不动的按钮，
  只留那条报信；WebUI 也没有通道时当场拒。代价是每条审批两条消息。这**不是**本清单口径下的缺口
  （运行时能力与 WebUI 控制面都在）。
  两条裁决通道都没有时不等待，当场拒绝并把原因交给模型（[22](./reviews/22-review-round6.md) · `D-APPR-01`、
  [24](./reviews/24-review-round6-verification.md) · `R-APPR-01`）。

### 6.1 新增缺口（第六轮整改后）

| 编号 | 运行时已有 | 界面缺什么 | 状态 |
|---|---|---|---|
| **G-API-13** | `POST /api/auth/password {current, next}`：校验旧口令、写 `config_kv` + `config_revisions`、吊销其余 session、即时生效（[22](./reviews/22-review-round6.md) · `V-AUTH-02`） | 设置页没有改口令表单。泄露口令后的应急处置目前只能打 API 或线下 `pnpm webui:passwd` + 重启，而这正是 `V-AUTH-02` 要消灭的形态的另一半 | ✅ 第四轮：设置页首屏就是「修改登录口令」；`WEBUI_PASSWORD` 钉住口令时换成一条告警（改了重启就回退，见 G-CFG-03） |
| **G-API-14** | `app_kv` 的 `modelAlias:<contextKey>`（Telegram `/model` 写入）**压过** WebUI 能改的 `perChat.<key>.agent.main.modelAlias` 与全局 `agent.main.modelAlias`（`runtime.ts` 先读它） | 界面上只有覆盖面板里一行小字提到这件事：改了模型别名不生效时，运维在 WebUI 里既看不到那份别名、也清不掉 | ✅ 第四轮：`GET /api/chats/:key` 带回 `modelAlias`，会话页出黄色提示 + `[清除会话别名]`（`DELETE /api/chats/:key/model-alias`） |

- `health` 事件仍只在 provider 测试与 MCP 重连后发送，没有周期心跳；顶栏的新鲜度依据业务事件，
  不把连接状态伪装成周期健康检查。
- **Telegram 命令没有任何控制面**（2026-08-27 记）：`minRole` / 启停 / 说明文案全写死在
  `bot.ts` 的命令注册表里，运维改不了，也没有任何一页列得出「现在有哪些命令、谁能用」。
  需求方已拍板**后期单开一个 tab 统一管理命令**，所以这一条不按缺陷逐个修 ——
  `docs/08 §8` 那张表与实现之间目前已知有一处对不上（`/usage` 文档写 `limited`、实现是 `owner`），
  见 [`00 §2.3`](./00-state.md)。

### 6.2 第五轮：docs/09 的 11 处 🚧 已清零

按需求方「全面推进」的决定，`docs/09` 里那 11 处 `🚧` 全部补上（doc 09 的 🚧 计数现在是 **0**）：

| 项 | 落点 |
|---|---|
| 一次性登录链接 | `/webui` 命令 + `issueLoginToken()` + `POST /api/auth/token`，三者由 CI 断言锁死 |
| Dashboard 趋势折线 + 额度环 | `/api/dashboard` 带回 7 天 trend（本地日分桶、缺的天补 0）；环只画 global 档 |
| 最近错误分级 | `GET /api/logs?minLevel=warn&size=10`，过滤在服务端 |
| 系统信息占用 | `/api/health/detail` 的 DB / WAL / workspace 字节数，只统计不清理 |
| 沙箱拉取镜像 | `POST /api/sandbox/image`（只 pull 不 build） |
| 审批规则试跑 | `POST /api/approvals/test`，用运行时那份 `ApprovalRules` |
| 用量维度 + 图表 | `GET /api/usage/report`（聚合本来就实现好了，只是没人调过）+ 自建 SVG 图表原语 |
| 原始 YAML | `GET/PUT /api/config/yaml`，解析在服务端 |
| 重启进程 | `POST /api/restart`，先回响应再走优雅关闭 |
| 配置导出 / 导入 | `GET /api/config/export` + `POST /api/config/import` |

**顺带修掉一个会静默丢配置的判据**：导出侧原本拿整条点分路径去测 `/key|secret|token|password/i`，
于是 `context.limit.tokens`（叶子是 "tokens"）会被当成密钥跳过 —— 一份导出里静静地少几项真配置。
改成「叶子段 + 值是非空字符串」，与 `publicConfig` / `revisionJson` 同一套口径。
- ~~`perChat` 白名单里的 `character` 仍是兼容性保留项；会话专属人设继续走
  `memory/CHARACTER.<chat>.md`，覆盖面板不展示这项。~~ **这条判断是错的，已作废**（docs/27 · C-08）：
  `CHARACTER.<chat>.md` 那个机制并不存在（`PromptDocuments.paths` 从不按 chat 分文件），
  所以 `character` 是当时唯一的落点，而它没接线 —— 于是「会话专属人设」这件事在两处各缺一半。
  现在读侧已接线（`assembleMainPrompt` → `paths(userId, characterOverride)`，带一道文件名形态闸），
  控制面也补上了：会话页的覆盖面板里有一个**独立的**「会话人格文件」输入行 —— 它不是 schema
  叶子键（`perChat` 是 `z.record(z.unknown())`），`SchemaForm` 渲染不出它，所以只能单独给一个控件。

### 6.3 新增缺口（第十轮活体测试整改后）

> **2026-08-27 重编号**：这两条原本占的是 `G-API-15` / `G-API-16`，与 §8.1 / §8.2 撞号 —— 同一个编号
> 指着两件毫不相干的事，而 `app.ts:3889`、`SchedulesCard.vue:24`、`schedule.api.test.ts:9` 三处注释写着
> `G-API-16`、**光看编号分不出指哪一条**。改这一对（源码零引用，只有 `docs/00` 引），§8 那对保持不动。
> 编号唯一性现在由 `tests/docs.test.ts` 焊住。

| 编号 | 运行时已有 | 界面缺什么 | 状态 |
|---|---|---|---|
| **G-API-26** | `POST /api/plugins/:name/reload` 回 `hotReloadReliable` + `warning`：跑在 tsx（`pnpm dev`）下时热重载**静默跑旧代码**，reconcile 每次都真跑、`onLoad` 每次打印的都是第一版（`docs/28 · L-EXT-04`） | ~~扩展页仍只弹「已重载」~~ | ✅ 已接（`PluginCards.vue` + `ExtensionsPage.reloadPlugin`：`hotReloadReliable === false` 时弹**不自动消失**的 warn，并在卡片上常驻一条提示） |
| **G-API-27** | `mcp_servers.state` 在子进程被 `kill -9` 之后最长 5 分钟才被下一次 `mcp-health` reconcile 纠正 —— 期间界面显示 `up` 而那台 server 的工具已经不在模型目录里（`docs/28 · L-EXT-02` 的残留） | ~~扩展页没有「这一行可能是陈旧的」提示~~。**底层那件事没修也修不了**：不是在 `onclose` 里写库就能解决（那个回调从子进程的 `'close'` 事件同步跑，`closeDatabase()` 之后一条泄漏子进程自然死亡会让裸 `db.prepare` 抛在 handler 里 → `uncaughtException`），要秒级反映得先给它加一个「库还开着吗」的判据 | ✅ 界面这一半已接（`McpTable.vue`：「上次核对」列 + 超过一个 `healthCheckCron` 周期就标「可能已陈旧」。判据用 `updated_at` 而不是去解 cron 表达式）。**运行时那一半仍然开着**，见 [00 §2.3](./00-state.md) |

### 6.4 新增缺口（扩展页重设计 + MCP 登录这一轮）

| 编号 | 运行时已有 | 界面缺什么 | 状态 |
|---|---|---|---|
| **G-API-18** | `plugins.config_json` + `PATCH /api/plugins/:name` 收 `config`，而 `definePlugin` 的 `configSchema` 就是为它准备的 | 前端从来不发那个字段，也没有表单。`SchemaForm.vue` 已经能把一份 JSON Schema 渲染成表单（设置页「全部配置」在用），所以缺的是接线而不是控件 | 🚧 未接 |
| **G-API-19** | `skills.dir` / `skills.enabled` / `skills.watch` 运行时改了不生效：`SkillLoader` 在构造时就把 `directory` 拿走了，而 `main.ts` 对任何 `skills.*` 变更只是重扫**老目录**；运行时打开不会启动 watcher，关掉不会清空内存里那份目录 | `docs/11` 标的是「需重启」所以不算文档撒谎，但那条重扫的接线读起来像是支持热更新的。界面上没有任何提示 | 🚧 未接（本轮沿用，非新增） |

---

## 7. 第四轮改了什么

口径推进：前三轮问「有没有控件」，这一轮问「**这个控件说话算数吗**」。查法是拿 `configJsonSchema()`
的 226 个叶子 × `SchemaForm` 的真实渲染规则（`$ref` 解析、secret 正则、未接线过滤）× 六个写入端点
× 运行时真实读取路径逐条对齐，再单独复核当时那 67 个未接线键有没有误判（**没有**：逐个全链路 grep 过）。
（那个 67 是**第四轮当时**的数，现值见 §1 顶部与 [11 §2.0.1](./11-config-reference.md)。）

| 改动 | 文件 |
|---|---|
| `sortOverrideKeys`：点分覆盖层按深度排序应用（先浅后深），`readPersistedConfig` 与 `dottedOverrides` 共用 —— 更具体的路径总是赢，与两行谁先落库无关 | `packages/shared/src/index.ts`、`packages/db/src/config.ts`、`packages/core/src/config/index.ts` |
| `writeConfigRows`：配置写入的唯一出口。落 `config_kv` + `config_revisions`，写祖先键时删掉被它取代的后代行（作废也记一条 `new_json` 为空的 revision）。六个写入点（`PUT /api/config`、`PUT /api/sandbox`、`PUT /api/quota`、`PATCH /api/tools/:name`、`PATCH /api/chats/:key`、MCP CRUD）收成一处，`PUT /api/sandbox` 因此第一次有了审计 | `packages/server/src/app.ts` |
| `ENV_PINNED_CONFIG_KEYS` + `envPinnedConfigKeys()`：env→键 的映射表，`loadConfig` 与 `apps/bot` 的 `envOverlay` 共用一份声明；`GET /api/config/schema` 增 `envPinned`，写入端 `config_pinned_by_env` 400，`POST /api/auth/password` 在 `WEBUI_PASSWORD` 下 409 | `packages/core/src/config/index.ts`、`packages/server/src/app.ts` |
| `SchemaForm`：密钥字段从只读改成**只写**（不回显、留空表示不改、另给「清空 / 撤销清空」）；env 锁定项禁用并点名变量；含 `«redacted»` 的整块 JSON 拒绝提交；`mcp.servers` / `approval.rules` 补专用面板指引 | `packages/webui/src/ui/SchemaForm.vue`、`packages/webui/src/styles.css` |
| 服务端也拒收 `«redacted»`（`PUT /api/config`、`PUT /api/sandbox`、MCP `POST`/`PATCH`）：读出来的脱敏值原样提交回来只会把真密钥换成那五个字，而那一行还会一直赢 | `packages/server/src/app.ts` |
| `HOT_RELOADABLE_CONFIG_KEYS`：整段 `mcp` → `mcp.enabled`/`defaultMinRole`/`servers`（`healthCheckCron` 冻在启动时）；补 6 条 `webui.*` 前缀（每请求现读，只有 host/port 要重启） | `packages/core/src/config/schema.ts`、`docs/11` |
| `approval.rules` 换成真 schema：`tool: string \| string[]`、`pattern` 编译校验（与 `compilePattern` 同一套 `(?i)` 解析）、`when: 'target_exists'`、`always` 只收 `true`、`risk` 三档，`.strict()` 让字段名写错当场 400 | `packages/core/src/config/schema.ts`、`config/config.schema.json` |
| 设置页新增「修改登录口令」；会话页新增会话模型别名提示与 `[清除会话别名]`；保存配置时把被整块写入作废掉的更细覆盖点名报出；变更历史区分「此前没有覆盖」与「这条覆盖已被删除」 | `packages/webui/src/views/ConsoleView.vue`、`packages/server/src/app.ts`、`packages/db/src/config.ts` |
| 新增 9 条用例：深度优先的覆盖应用（两种插入顺序）、env 钉住的键真的压过覆盖层、祖先写入作废后代行并留审计、沙箱写入进变更历史、env 锁定键与改口令端点被拒、`«redacted»` 被拒而真值写得进、审批规则四种写错方式当场 400、会话别名可见可清 | `tests/config.persistence.test.ts`、`tests/config.api.test.ts` |

### 7.1 查出来但没动的

- **审批规则的正则跑在回溯引擎上**：`ApprovalRules.evaluate` 用 `new RegExp` 去测
  `JSON.stringify(input)`，而 input 是模型可控内容 —— 一条写歪的 `pattern` 加上模型挑的输入
  就能把整轮卡住。唤醒词那条路径已经换成 RE2（`checkWakeword`），这里没换：RE2 不收 lookahead
  与反向引用，直接换会让现存规则失效。**这不是「WebUI 控制不了」，所以留给下一轮单独决定**。
- `GET /api/mcp` 不脱敏（`GET /api/config` 会），MCP 表单因此能改 env / headers 里的密钥。
  两个端点都在鉴权之后，属于有意的分工，不当缺口；`SchemaForm` 那一格已经指路过去。

---

## 8. 定时任务这一轮（新增能力带来的一个新缺口）

定时任务（[14 §2 Q4](./14-open-questions.md)、[02 §10](./02-context-engine.md#10-定时轮次的上下文归属)）
接进来之后，按本文的口径复算一次：

### 8.1 已闭合

| 编号 | 运行时已有 | 界面缺什么 | 状态 |
|---|---|---|---|
| **G-API-15** | `log_events.data_json`（含 blob 解引用）—— 列表把 15 列里的 10 列连同整份载荷都传给了浏览器，而界面只用 5 列 | 日志页点一行只会去重建 trace，`trace_id` 为空的那些（`system.start`、`config.changed`、`maintenance.*`、`webui.action`）**点了什么都不发生**；有 trace 的也只得到一串 kind/summary，载荷从没露过面。docs/09 §3.10 那句「每个节点可展开看完整 payload」一直没实现 | ✅ 本轮：新增 `GET /api/logs/:id`（复用 `detailPayload`），日志行点开进详情弹窗；列表 SELECT 同时收窄成不带 `data_json`（原先每次刷新最坏推 ~50 MB） |
| — | `context_messages.parts_json` 里工具调用的原始参数 | 消息→查看详情只有工具**输出**没有**输入**。根因在 `LogSink.span` 而不是界面（见 [10 §2](./10-logging-and-observability.md) 的 `tool.call` 行），但历史轮次的日志补不回来 | ✅ 本轮：`GET /api/turns/:id/detail` 增 `contextMessages`（直读列、绕开 `elidePart`），详情弹窗多一组「工具输入输出」，对老轮次同样有效 |

### 8.2 `G-API-16` —— 已闭合（定时任务管理面）

| 编号 | 运行时已有 | 界面缺什么 | 状态 |
|---|---|---|---|
| **G-API-16** | `scheduled_jobs` 全表 + `ScheduledJobRunner`（`nextRun` / `unregister` / `fire` 都在进程内） | **WebUI 没有定时任务面**：运维看不到「这个部署里现在有哪些任务在排、下一次什么时候、上一次是成是败」，也不能停掉某一条。止损只能去 Telegram 让 bot 跑 `schedule_list` / `schedule_cancel`，或在工具页关掉 `schedule_create`（那只阻止新建，不影响已有任务） | ✅ 已补：「任务与审批」页第三张卡片 + 四个端点（`GET/POST /api/schedules`、`DELETE /api/schedules/:id`、`POST /api/schedules/:id/trigger`），见 [09 §3.10.1](./09-webui.md) |

两处值得记下来的取舍：

- **建任务与工具共用 `createScheduledJob`**（`packages/core/src/schedule/create.ts`）。端点自己抄一遍
  校验的话，WebUI 迟早能建出工具建不出来的任务 —— 这正是 [26](./reviews/26-round8-tool-review.md) §1
  「同一道闸修过一次但漏了另一侧」的形态。落点也不收客户端给的 `chatId`：按 `key` 从 `contexts`
  反查，与 [05 §8](./05-tools-and-permissions.md) 对工具参数的要求同源。
- **没装配运行时时 `available:false` 而不是空数组**。「一条都没有」和「读不到」在运维眼里是两回事
  （[16](./reviews/16-remediation-plan.md) §5「摘除比伪造安全」）。前端也按这个归一化：形状对不上的响应
  不该让整页崩在 `DataGrid` 的 `rows` 上（[24](./reviews/24-review-round6-verification.md) · `R-UI-01`）。

**新增缺口：无。** 定时任务的运行时能力（列、建、停、手动触发）现在都够得着；
`schedule.*` 五个配置键走通用配置表单。

> **指针（后加）**：上面那句「四个端点」是**当轮的记录**，不改数字。此后又加了
> `PATCH /api/schedules/:id`（改任务）与 `POST /api/schedules/:id/purge`（硬删行），
> 连同任务卡与审批卡的补齐一起记在 [§15](#15-任务卡详情与定时任务编辑这一轮2026-08-21)。
> 那两条**不是本文口径下的缺口** —— 它们在运行时本来也不存在，是同一轮新加的能力。

---

## 9. 装 skill 包这一轮

起因不是复算出来的缺口，是一次实测：用户在 Telegram 丢了一个带 `scripts/` + `bin/`
的音乐 skill 包，模型解到工作目录用了起来，而扩展页上一个字都没有。根因与通道见
[07 §2.5 / §6.5](./07-skills-plugins-mcp.md)。**两条根因只闭合了一条**：通道本身有了，而
「一条被开关关掉的通道，模型无从知道它存在」仍然开着 —— 那条不属本文口径（运行时压根没有
这个能力，不是界面够不着），记在 [`00 §2`](./00-state.md)。

| ID | 缺的是什么 | 优先级 | 状态 |
|---|---|---|---|
| G-EXT-01 | **装不了多文件 skill**。`docs/07 §2.1` 的格式一开始就允许附属文件，`SkillDefinition.files` 与 `skill://` 也是为它准备的，但没有任何途径把它们放进去：`write_skill` 只收 `body: string`，fs 工具对 `skills/**` 关死 | P1 | ✅ 本轮补（`installSkillPackage` + `install_skill` + `POST /api/skills/package`） |
| G-EXT-02 | `skills.source` 是死列 —— schema 有、`persist()` 从不写、WebUI 从不读，所有行都是默认值 `local`。装包进来的和随包发的四份说明文档在界面上分不开 | P2 | ✅ 本轮补（`bundled`/`package`/`local` + 来源徽标 + 未审阅徽标） |
| G-EXT-03 | **陈行永不清理**。`persist()` 只 upsert，唯一会删行的是 `SkillLoader.remove()`；盘上删掉一个 skill 目录，那一行永远留在表里、永远显示在扩展页 | P2 | ✅ 本轮补（`scan()` 末尾清理，`ENOENT` 那支不清） |
| G-EXT-04 | 随包那四份说明文档 WebUI 侧**能改能删**。`write_skill` 从一开始就拒改它们，同一条不变量只焊住了一半 | P2 | ✅ 本轮补（`DELETE` 与「改 `enabled` 以外任何字段」回 403） |
| G-EXT-05 | `skills` 的变更不进 SSE。`EVENT_REFRESH` 里没有对应事件，扩展页只靠 `health` 顺带刷新 —— 从 Telegram 装进来的东西要等下一次健康检查才出现（`docs/07 §2.3` 写着广播 `EventBus('skills.changed')`，而那个 emit 从来没有实现过） | P2 | ✅ 本轮补（`extensions.changed`，只在 `name → content_hash` 真变时发） |
| G-EXT-06 | `GET /api/skills` 是 `SELECT *`，把 `path`（宿主文件系统路径）、`content_hash`、整份 `frontmatter_json` 全发给前端，而 `interface Extension` 只声明了 5 个字段 | P3 | ✅ 本轮补（收窄到 7 列） |
| G-EXT-07 | 通道关着时界面上没有任何解释。`tools.selfExtend.skills.enabled` 默认 `false`，而扩展页只给 MCP 做了总开关提示条 | P3 | ✅ 本轮补（skills 侧同形状的提示条） |

**新增缺口**：`skills.dir` 改成运行时可改仍然无效 —— `SkillLoader` 在构造时就把 `directory`
拿走了，而 `main.ts` 对任何 `skills.*` 变更都只是重扫**老目录**。`docs/11` 标的是「需重启」，
所以不算文档撒谎，但那条重扫的接线读起来像是支持热更新的。同类的还有 `skills.enabled` /
`skills.watch`：运行时打开不会启动 watcher，关掉不会清空内存里那份目录。

---

## 10. 标记模型能力这一轮（2026-08-19）

起因也不是复算出来的，是一次实测：用户发图，模型连着几轮回的都是与图无关的内容 —— 而链路是好的。
`logs/2026-08-19/blobs/` 里 11 份带图请求逐份解开看过：`{"type":"image_url","image_url":{"url":"data:image/jpeg;base64,…"}}`
形状对、挂在带用户文字的那条 user 消息里、base64 解回来是完整可看的 JPEG（一张 Minecraft 方块、
一张明日方舟立绘、一张 DRAM 现货价截图、一张白发猫耳娘），含图轮次也确实记了
`provider.fallback … reason: vision_required`。**问题在链路末端那个模型**：拿同一张合成图
（三条竖色块 紫/黄/黑）直接打三次探针 —— 该网关的 `grok-4.5` 四次答案全错且每次不同
（`black/white/black`、`蓝色/黄色/青色`、`蓝/白/红`、`紫色/靛蓝色/蓝色`），`prompt_tokens` 恒为 2266
且 `prompt_tokens_details` **没有 `image_tokens`**，每次烧 600–2500 reasoning token 瞎猜；
同一家网关的 `grok-4.3` 一次就对，usage 里有 `image_tokens: 42`。

而 `capabilities_json` 是按**模型名**从 models.dev 抄来的（[04 §5.4.1](./04-agents-and-providers.md)），
官方 `grok-4.5` 确实有 vision —— 于是这一行写着 `vision:true`，含图轮次**不切** `vision` 别名，
图就留在那个看不见它的模型上。两条路都通向它：`main` 打头是它时自动切换整个不触发；
`main` 打头看不了图时切到 `vision`，而 `vision` 的第一顺位也是它。

> **后记（2026-08-19）**：该网关的 `grok-4.5` 上游已修好，现在真的转发图片。这一节留下来的是
> **形态与判据**（探针用一张三色块合成图；判据是 usage 的 `prompt_tokens_details` 里有没有
> `image_tokens`，而不是目录里那一位），不是那个模型的现状 —— 换一家网关就会再来一次，
> 而 `G-API-17` 补的界面正是为了那时候不必再直连 SQL。

| 编号 | 运行时已有 | 界面缺什么 | 状态 |
|---|---|---|---|
| **G-API-17** | `capabilities_json.vision` 有运行时行为（`ModelRegistry.supportsVision` → 含图轮次自动切 `vision`），而它的值是从目录按模型名抄来的、可以是假的 | **界面上推翻不了它**：`PATCH /api/models/:id` 的字段白名单里没有 `capabilities`（只有九个列名），模型对话框也没有对应控件。唯一的路是直连 SQL 改 `capabilities_json` 再重启进程 —— 而这是一个用户凭一张图就能撞上的日常故障 | ✅ 本轮补 |

改法与三处取舍：

- **`PATCH /api/models/:id` 收 `capabilities`**，三态：`true` / `false` / `null`（取消标记）。
  生效值写 `capabilities_json` 顶层 —— 运行时与界面徽标都读那里，不必各自再懂一层「人工优先于目录」；
  意图另记 `manual`。落库后 `rebuildModels()` 即时生效，不需要重启。
- **白名单只放运行时真的会读的能力位**（现在只有 `vision`），其余键回 400 而不是静静吞掉。
  放开它们等于给运维一个「关掉工具」的开关而代码照旧把工具目录发上去 ——
  假控件正是 [§1.2](#12-假控件界面上能点运行时不读) 与第四轮整整一轮在修的东西。
- **`enrich` 要把标记盖回去**（`keepManualCapabilities`）。`POST /api/models/enrich` 原本「能力块照写」，
  注释里写的理由是「纯信息」—— 那句话在 `supportsVision` 落地之后就不成立了。不盖回来的话，
  一次「补齐元数据」静默撤销运维的修正，而含图轮次立刻回到那个瞎的模型上。

取消标记时**不做目录查询**：只摘掉 `manual` 的键、顶层维持现值，下一次「补齐元数据」再按目录重填。
撤销一个标记不该依赖出网，界面上那行提示写的就是这件事。

**新增缺口：无。** 另有两条与本轮同源但不属本文口径的事实，现记在
[04 §5.2](./04-agents-and-providers.md)（连同「怎么认出一个撒谎的能力位」那套探针与判据）：
`vision` 是目前唯一被运行时读取的能力位（其余五位只喂徽章），以及别名链的顺序本身就能让一个
瞎模型排在含图轮次前面 —— 那是配置问题，别名编辑器一直够得着。

**但「够得着」不等于「看得见」，所以后来补登了一条缺口**，见 [§20](#20-别名链上看不出谁能看图)。

---

## 11. 会话级持久容器（2026-08-19）

运行时刚落地（`sandbox.persistent`，[05 §5.5](./05-tools-and-permissions.md)），控制面**随同一轮补齐**，
所以这一节不留缺口，只记「界面上必须说出口的三件事」—— 它们都属于本文 [§1.2](#12-假控件界面上能点运行时不读)
的反面：不是「能点但不生效」，而是「生效了但界面不说」。

| 编号 | 运行时已有 | 界面给了什么 | 状态 |
|---|---|---|---|
| **G-SBX-01** | 每个会话一个常驻容器，到期回收；`docker ps` 里看得见，而运维在界面上看不见 | 工具页沙箱块下方的容器面板：会话名、容器名、上次用 / 执行次数、还剩多久、钉住状态，表头带 `used/max`。行内「钉住 / +24h / 重置 / 重置并清工作区」 | ✅ 本轮补 |
| **G-SBX-02** | `sandbox.persistent.*` 六个键全部接线 | 沙箱设置里六个控件。TTL 两档按**小时**收（配置里是 `Ms`）——「24」比「86400000」好核对得多 | ✅ 本轮补 |
| **G-SBX-03** | 打开持久化会把持久容器的网络默认设成 `bridge` | `enabled` 旁边的红色警示写明这件事，并点出 `persistent.network` 与上面那个 `sandbox.network` 是**两个键** | ✅ 本轮补 |

三处取舍：

- **「重置」与「清工作区」是两个按钮，不是一个按钮加一个勾。** 容器是环境、workspace 是数据，
  在持久模式下这两件事第一次变得可分；做成一个控件迟早有人点错。清那一档的 `confirm()`
  把代价写全（文件挪进 `.luoli-trash`，不真删），与 `container_reset` 的 `wipeWorkspace` 默认 `false` 同源。
- **关掉 `enabled` 不会立刻销毁已有容器**，它们由下一次回收对账收走。界面必须说这句话 ——
  否则运维关掉开关之后在 `docker ps` 里还看得见容器，会以为没生效。
- **`GET /api/containers` 没装配运行时时回 `not_implemented` 而不是空列表**，面板显示
  「这个部署没有装配持久容器运行时」。「读不到」和「一个都没有」是两回事（[16 §5](./reviews/16-remediation-plan.md)）。

**新增缺口：无。**

---

## 12. 界面在说谎的三处（2026-08-19）

三条都不是「够不着」，而是本文 [§1.2](#12-假控件界面上能点运行时不读) 的另外两种形态：
**界面把一件事说错了**（把私聊叫成群聊、把没有处理器的更新类型和有处理器的画成一样），
以及**界面把服务端已经说清楚的事咽了回去**（校验失败只剩一句「配置校验失败」）。
起因是一次实际使用，不是复算。

| 编号 | 运行时的事实 | 界面此前给的 | 状态 |
|---|---|---|---|
| **G-UI-01** | `principals.kind` 只有 `user` / `chat`，`chat` = 一个 Telegram 会话；类型在 `principals.chat_type` 里（会话页的 `chatIdentity()` 一直在读它） | 主体页把 `kind === 'chat'` 直接当标签用，于是**每个私聊都显示成「群聊」**（实测库里 5 行 chat 主体有 4 行是 `private`）；弹窗里那句「私聊会话不看这一行」还挂在私聊自己的行上 | ✅ 本轮修 |
| **G-UI-02** | `telegram.allowedUpdates` 的取值是 Bot API 定死的 23 类，而本适配器只有 4 类有处理器（`message` / `edited_message` / `callback_query` / `my_chat_member`） | 一个自由文本域，运维自己回忆拼写。拼错一个名字 Telegram 整条 `getUpdates` 400 —— 表现是「一条消息都收不到」，与那句绿色的「保存成功」隔着一次重启 | ✅ 本轮修 |
| **G-CFG-08** | `PUT /api/config` 校验失败时 `error.details` 里逐条给着 path 与原因 | toast 只念 `error.message`，也就是一句「配置校验失败」。跨字段的那几条（`memory.softLimitTokens` 与硬上限、`concurrency.perKey` 与全局并发）因此变成哑巴 400：报错说的是「你改的这一格和另一格冲突」，而运维连是哪两格都不知道 | ✅ 本轮修 |

改法与四处取舍：

- **判据只有一份。** 主体页复用会话页那套「先信 `chat_type`，缺了回落到 id 正负号」，
  不再各写一份；筛选页签跟着拆成 全部 / 用户 / 私聊 / 群与频道。
- **复选框那一档是 schema 驱动的，不是给某个键开的特例**：`items.enum` 的数组一律渲染成复选框
  （`multiEnum`）。内部仍以「一行一条的文本」持有值 —— `changed` 是拿 `!==` 跟基线比的，
  数组每次重建都是新引用，那样每一格都会永远显示「待保存」。
- **逐个取值的说明走 `CONFIG_ENUM_NOTES`**（core 的唯一来源，随三件套进 `GET /api/config/schema`
  的 `enumNotes`）：23 个取值里哪 4 个有处理器，这件事一句 `description` 装不下，而前端不维护
  第二份清单是这张表单从第二轮起就定下的规矩。`tests/config.test.ts` 断言它与 enum 严格一一对应。
- **原因拼进 `message` 而不是只留在 `details`**：`details` 仍然保留（结构化、能按 path 定位控件），
  但 toast 念的是 `message`。同时 `configSchema` 那三条跨字段约束改成中文并**点名对方那一格现在
  是多少** —— 只说「必须小于硬上限」的话，运维仍要去 200 多个值里翻硬上限是几。

**顺带修掉的两个假默认**（都属「存得下、跑不出任何行为」）：`telegram.allowedUpdates` 的默认值里
去掉 `message_reaction`（从来没有处理器，而它的说明文字写着「去掉后表情回应不再入库」——
是假的），空数组也一并拒掉（Bot API 把它读作「几乎全都收」，与界面上一条都不勾正好相反）。

**新增缺口：一条**（不属本轮范围，记在这里）：`trigger.channels` 点不亮 —— 频道消息走
`channel_post` 更新，而适配器没有这个处理器，配置项与 `evaluateTrigger` 里那半条判断都在等它。
现在至少在界面上说出口了（那个取值标着「无处理器」）。

---

## 13. 界面不显示合成出来的有效角色（2026-08-20）

又一条本文 [§1.2](#12-假控件界面上能点运行时不读) 的形态，且与 [§12](#12-界面在说谎的三处2026-08-19)
的 G-UI-01 同源：**服务端已经算得出来的判据，界面咽了回去**。起因同样是一次实际使用 ——
运维在主体页把某人改成 `trusted`，模型此后每一轮仍说自己面对 `limited`，而两边各自都没错。

| 编号 | 运行时的事实 | 界面此前给的 | 状态 |
|---|---|---|---|
| **G-UI-03** | 一个私聊在 `principals` 里占两行（`user:X` + `chat:X`），有效角色由 `resolveEffectiveRole` 合成，模型系统提示里那个 `role` 就是它 | 两行的显示名与 tg_id 完全一样、只差一个类型标签，角色列各显示各的 `role`，合成的结果**一处都不显示**；`list()` 又按 `updated_at DESC` 排，刚 PATCH 过的那行必然置顶 —— 于是「只改了 `chat:X`」与「改对了」长得一模一样 | ✅ 本轮修；**2026-08-30 结案**（见下） |

实测那次：`user:1445849516` 停在 `limited`（被一次批量降权扫进去），`chat:1445849516` 前后被
PATCH 成 `trusted` 三次而 `user:` 那行一次都没被点到，期间 10 轮 `turn.start` 全部记着
`role=limited`。对照组是同期另一个人 —— 两行都改了，所以他一直是对的；差别只在于有没有人
记得改第二行。弹窗里那句「要放行这个人，改 `user:X` 那行更直接」当时**已经在了**，没挡住。

当时的改法与四处取舍：

- **算在服务端。** `GET /api/principals` 每行多回一个 `effectiveRole`，用 core 的
  `resolveEffectiveRole` 算。前端不重算第二份 —— 与 G-UI-01 把类型判据合并成一份是同一条规矩。
- **配对本身就是判据，不看第三次 `chat_type`。** Telegram 用户 id 恒正、群 / 频道 id 恒负，
  `user:X` 与 `chat:X` 同时在表里就只可能是一对私聊。再引一次「先信 `chat_type`，缺了看正负号」
  等于把那条判据抄成第三份。
- **群 / 频道回 `null`，不回它自己的 `role`。** 那一行对每个成员的含义都不同；
  给一个看起来确定的值是「摘除比伪造安全」的反面（[16 §5](./reviews/16-remediation-plan.md)）。
- **只在不一致时出红字。** 这一页有几十行，逐行挂一个「有效 X」是噪声；要显眼的是「你以为改了
  但没生效」这一种行。

**已随 2026-08-30 的权限模型改动结案。** 新规则下**私聊不再占两行**（`kind='chat'` 恒为群 / 频道，
`user:` 那一行就是全部），产生这条缺口的形态本身不存在了：改哪一行与改对了是同一件事。因此
`GET /api/principals` 的 `effectiveRole` 与角色列下面那行红字**一并删掉** —— 群 / 频道那一行现在是
**下限**（把成员抬到那一档，封顶 `trusted`，[05 §2.2](./05-tools-and-permissions.md#22-有效角色)），
每个成员的有效角色仍各不相同，服务端合不出一个对谁都成立的值；界面上少一个合成字段，比留一个
只在旧库残留行上才有意义的字段更诚实。**编号与上面那段事故记录保留**：源码在引它，而那次
「两边各自都没错、合起来是错的」仍是这类界面缺口的样本。

**留下的那条没做也随之作废**：弹窗里「同时把 `user:X` 也改成同一角色」的一键补齐 —— 没有第二行
要补齐了。

---

## 14. web_fetch 抓回来的图这一轮（2026-08-20）

| 编号 | 运行时已有 | 界面缺什么 | 状态 |
|---|---|---|---|
| **G-API-20** | `web_assets` 表 + `media.dir/web/<key>/` 下的文件：`web_fetch` 抓回来的图与 MCP 工具交回的截图（[05 §3.6](./05-tools-and-permissions.md)、[03 §2.4](./03-data-model.md)） | 三处都够不着：① 上下文里那条注入消息渲染出来只有文本，**图看不到**（`G-API-08` 给 `attachments` 补的那条附件带子只认 `attachment://`，`webasset://` 走的是另一张表）；② 总览页的占盘统计只算 `attachments`，这一部分不计入；③ 没有任何地方能看「这个会话抓过哪些图」或手动清掉一张 | 🚧 未补 |

优先级 P2：它不影响运行时正确性（保留期与 `gcFiles` 都已接上，见 [03 §4](./03-data-model.md) 那两行），
缺的是**可见性** —— 运维看不出模型这一轮到底看到了哪张图。眼下唯一的凭据是
`media.web_asset` 日志（[10 §2](./10-logging-and-observability.md)）。要补的话最小形态是给
`GET /api/files/:id` 加一条 `webasset://` 分支，让消息卡片那条附件带子对两张表一视同仁。

---

## 15. 任务卡详情与定时任务编辑这一轮（2026-08-21）

这一轮同时动了三张卡，但**按本文的口径只有一半算缺口**，先把这条线划清楚，否则下一轮复审
一定会拿口径来问：

- **算缺口的**：`tasks.progress_json` 与 `agent_runs` 那份 join 数据 —— 运行时一直在写，
  界面从来看不到；`tasks` 的历史行也从来删不掉。这正是本文第一句那个问题
  （「运行时真的有这个能力，但运维在 WebUI 里够不着」），编号沿用 `G-API-2x`。
- **不算缺口的**：定时任务的**编辑**与**硬删**。这两件事在运行时**本来也不存在** ——
  `ScheduleRepository` 只有 `create / finish / markRun / purge(before)`，模型侧也只有
  `create / list / cancel`。不是「界面够不着」，是这个能力压根没有；同一轮里连
  `PATCH` / `remove` / `schedule_update` 一起造出来，属于新增能力，
  与 [§11](#11-会话级持久容器2026-08-19) 那种「运行时刚落地、控制面随同一轮补齐」同形。
  静默（[02 §10.5](./02-context-engine.md)）同理，它是一条全新的运行时语义。

| 编号 | 运行时已有 | 界面缺什么 | 状态 |
|---|---|---|---|
| **G-API-21** | `tasks.progress_json`（`AgentManager.progress` 每一步都在覆写）、`tasks.result_summary`，以及按 `turn_id` / `agent_run_id` join 得到的那一轮与那次子运行（`turns` 的步数 / 工具数 / 花费 / 错误，`agent_runs` 的 agent 名 / 模型别名 / 结果摘要，[03 §2.6–2.7](./03-data-model.md)） | 任务表只有标题、状态、更新时间三列，**点开什么都没有**。「这个子 agent 卡在哪一步」「它到底交回了什么」在界面上一个字都没有，唯一的路是直连 SQL 读 `progress_json`，或者绕到轮次详情去猜哪一条是它 | ✅ 本轮补（`GET /api/tasks/:id` + 只读详情弹窗） |
| **G-API-22** | `tasks` 是**永久保留**表（[03 §4](./03-data-model.md)，刻意不给保留期），而它每派一个子 agent 就长一行 | **删不掉**：既没有端点也没有按钮，一次跑歪的批量派发留下的几十行会永远排在最前面（表按更新时间倒序）。同一张卡上的审批表还有第二个形态 —— 服务端硬 `LIMIT 200`，撞上限是**静默截断**，被截掉的恰好是最老的历史行，界面上看不出少了东西 | ✅ 本轮补（`DELETE /api/tasks/:id` + 任务与审批两张表都改服务端分页） |

四处值得记下来的取舍：

- **只读详情，不做编辑。** 一条任务记录是某一轮真实发生过的事，给它一个编辑入口等于给历史开一个
  写口子。要「重来一次」的正确形态是重新派发，不是改那一行。
- **删记录与取消是两个动词，端点也是两条。** `DELETE /api/tasks/:id` 删的是记录，对
  `state='running'` 直接 409；取消仍然走 `POST /api/turns/:id/cancel`（子 agent 没有独立的
  取消句柄，[09 §4](./09-webui.md) 那一行从第一版起就写着）。合成一个「删除」按钮既取消又删行，
  是本文 [§12](#12-界面在说谎的三处2026-08-19) 那种「界面把一件事说错了」的下一步 —— 界面把两件事做成了一件。
- **审批角标那个数必须是服务端全表计数。** 分页之后「当前页里的 pending 条数」与「一共有几个人
  在等」第一次不再相等，而 `AC-WEB-049` 要的是后者（不切到任务页也看得见）。拿页内条数去推的话，
  翻到第 2 页角标悄悄变成 0 —— 这是整次分页改造里唯一一处**静默的功能退化**：界面不报错，
  只是不再告诉你有人在等。所以信封里 `pending` 与 `total` 是两个字段。
- **`purge` 那一路留 warn 而不是 info。** 硬删一条 active 的定时任务之后，「bot 怎么突然不提醒了」
  在库里再没有任何痕迹（行没了，`schedule.*` 的其余日志都挂在触发上）。那条 `schedule.purged`
  就是唯一的凭据 —— 与 [03 §4](./03-data-model.md) 里「活跃任务永不清」那句话的**理由**是同一条，
  只是这次由人负责按下去。

**新增缺口：无。** 另记两条不属本文口径、但会被误当成缺口的事实：
① 定时任务的**运行历史**仍然只有「上一次」一档（`last_run_at` / `last_state` / `last_error` 三列覆写），
没有逐次的运行记录表 —— 那是数据模型的选择，不是界面够不着（要逐次记录得先加表）；
② 静默的四层分辨手段里，界面只暴露了「上一次 = 静默」与连续静默提示这一层，
其余三层（`last_error` 恒空、日志 kind、trace 里少一跳 `tg.send`）留在日志页与轮次详情里，
[02 §10.5](./02-context-engine.md) 那张表说明了为什么这样够用。

---

## 16. 工具目录按需暴露这一轮

先划口径，同 [§15](#15-任务卡详情与定时任务编辑这一轮2026-08-21)：`tools.catalog.*` 那五个键本身
**不算缺口** —— 它们经 §1.1 那套自动生成表单在配置页可改，不需要专门的控件。原缺口分成两部分：
工具页的常驻 / 折叠状态已显示；轮次详情仍看不到本轮展开记录。

| 编号 | 运行时已有 | 界面缺什么 | 状态 |
|---|---|---|---|
| **G-API-23** | 每次 `active()` 都算得出常驻 / 折叠的二分与折叠组（`mcp:<server>` / `plugin` / `custom` / `builtin`），`GET /api/tools` 已经透传 `deferred` 字段；轮内的展开事实另有一条 `tool.expanded` 日志（[05 §3.12](./05-tools-and-permissions.md)、[10 §2](./10-logging-and-observability.md)） | ~~工具页看不出哪些工具模型默认看不见。~~ **工具页已闭合**：策略列表显示「常驻 / 折叠」，支持筛选，并与主 agent / worker 可达侧并列。仍缺轮次详情中的 `tool.expanded` 记录；「本轮展开了哪些工具」目前只能在日志页检索。 | ⚠️ 部分闭合（2026-08-31） |

优先级 P2：它不影响运行时正确性（折叠只是可见性，权限判定一个字未改，见
[05 §4](./05-tools-and-permissions.md#4-权限矩阵权威表) 末尾那三层），缺的是**可见性** ——
而这一次缺的可见性正好落在「运维对模型能力的心智模型」上，比 `G-API-20` 那种事后取证更容易误事。
工具页已显示常驻 / 折叠状态；剩余形态是在轮次详情里把 `tool.expanded` 与工具调用并排显示。工具页的
「可达侧」与「常驻 / 折叠」均由服务端现算、只读展示（[09 §3.7](./09-webui.md)）。**不要做成开关** —— 单个工具的折叠与否由
`tools.catalog.resident` / `defer` 的 glob 决定，那两个键在配置页已经改得到；在工具表上再加一个
per-tool 开关就是第二份真相，[§1.2](#12-假控件界面上能点运行时不读) 那类「界面上能点、运行时不读」
的老问题会从这里长回来。

---

## 17. Telegram 审批裁决通道这一轮（2026-08-21）

inline keyboard 审批落地（[05 §6.1](./05-tools-and-permissions.md)）之后，裁决**来源**变成两个，
而审批卡只认得其中一个的写法。**这一条当轮就闭合了** —— 它不是「运行时已有而界面够不着」，而是
「我们刚让界面读到一个它读不懂的新格式」，性质不同：留成缺口比在服务端补一行接上既有 helper 更贵。

| 编号 | 运行时已有 | 界面缺什么 | 状态 |
|---|---|---|---|
| **G-API-24** | `approvals.decided_by` 现在有三种格式：Telegram 点的写 `user:<tgId>`、WebUI 裁的写字面量 `owner`、系统写 `system`；`decision_channel` 同步区分 `telegram` / `webui` / `system`（[03](./03-data-model.md) 的 `approvals` 段） | ~~审批卡把 `decided_by` 原样渲染，于是同一列里一半行写着 `owner`、一半行写着 `user:123456789`；`GET /api/approvals` 走 `SELECT *`，没接 `principalLabel()` 那层~~ | ✅ 已闭合（2026-08-21） |

闭合方式：`GET /api/approvals` 那条查询接上 `decidedByLabel()` → `principalLabel()`（与用量聚合、
任务页、定时任务页同一个 helper），并把 `SELECT *` 收窄成与 `ApprovalRow` 逐字对齐的显式列 ——
**没有新增裸 SQL 语句**，就是原来那一条不再靠 `*` 猜（`D-01` 那个数字不许再涨）。
`decided_by` 的格式解析走 `parsePrincipal`（三个 Telegram 命令与 `POST /api/principals/bulk` 共用的
那一份），不在这里手写 `slice(5)`。前端显示 `decidedByLabel ?? decided_by ?? 'system'` 再挂一个
`decision_channel` —— 「谁批的」与「在哪儿批的」是两件事，后者是这一轮才有的。
**前端一个字节都不拆 `user:` 前缀**：那等于把 `decided_by` 的格式变成前后端各存一半的暗契约，
下一种写法（比如将来 ACP 的裁决者）出现时前端会静静把它渲染成乱码。用例：`webui.gaps.test.ts`。

---

## 18. ACP 客户端这一轮（M13，2026-08-22）

三条。**一条当轮闭合** —— 它正是 [§17](#17-telegram-审批裁决通道这一轮2026-08-21) 结尾预言的那件事
（「下一种写法（比如将来 ACP 的裁决者）出现时前端会静静把它渲染成乱码」），而它真的出现了，所以
按 §17 同一条口径当轮修掉：这不是「运行时已有而界面够不着」，是我们刚往一列里写进一个界面读不懂
的值。**另两条如实记着不闭合**，理由写在各自下面 —— 都不是「懒得做」，而是做错的代价高于不做。

| 编号 | 运行时已有 | 界面缺什么 | 状态 |
|---|---|---|---|
| **G-UI-04** | `approvals.decision_channel` 的取值域是**通道**（`telegram` / `webui` / `system`），主体在 `decided_by`（[03](./03-data-model.md) 的 `approvals` 段） | ~~`recordDecided()` 把裁决者原样写进了通道列，于是 ACP 会话内 `allow_always` 命中时两列同值，审批卡那一格（渲染的正是 `decided_by · decision_channel`）把 `acp:always` 印两遍；按通道分桶的查询还会多出一个取值域外的桶~~ | ✅ 已闭合（2026-08-22） |
| **G-API-25** | 一次 ACP 调用跑完在 `agent_runs` 上留一行，外部花费与用量在迁移 `0014` 新加的 `external_cost_usd` / `external_usage_json` 上（写入侧 `packages/core/src/acp/runs.ts`，[03 §2.7](./03-data-model.md)） | **WebUI 里没有任何一处读得到那一行** —— 不只是花费，是整行。全仓唯一读 `agent_runs` 的地方是 `GET /api/tasks/:id` 那条 join，而它的入口是 `tasks.agent_run_id`；ACP 这条路**不建 `tasks` 行**，所以那条 join 永远够不着它。用量页聚合的是 `usage_ledger` 与 `turns`，而 ACP 一行都不进那两张表（刻意的） | ✅ 已闭合（2026-08-30，只闭合了一半，见下） |
| **G-CFG-09** | `agent.acp.agents` 是对象数组，每一项里有 `approvalMode`（agent 内部的自动放行档）与 `tools`（下发成 flag 的工具白名单）—— 两个都是权限相关字段 | 只有自动生成的「全部配置」表单够得着它，而对象数组在那张表单里就是**一格裸 JSON**。MCP transport 有专用的 CRUD 表（[§4.5](#45-第三轮最后六项缺口)、`G-API-11`），这一格没有：改错一个字母时 zod 会拒，但回给运维的是一条路径式报错，而不是「这一档是什么意思」 | 📋 记录，不当轮闭合 |

**G-UI-04 的闭合方式**：`decision_channel` 的取值域加第四个值 `acp`（`ACP_DECISION_CHANNEL`，
`packages/core/src/acp/permission.ts`），`recordDecided` 的入参把 `channel` 与 `decidedBy` 拆成两项。
主体仍然写 `acp:always` —— 那是**刻意**的、`parsePrincipal` 解不出来也是刻意的：它不是一个人。
前端一个字节都不改，仍然是「`decidedByLabel ?? decided_by ?? 'system'` 再挂一个通道」。
用例：`acp.permission.test.ts`（那条断言原来钉的正是两列同值）。

**G-API-25 为什么不当轮闭合。** 它读起来像「给那条 join 加两列」，但那条路走不通：ACP 不建 `tasks`
行，所以要闭合就得**新开一个呈现面**（按 turn 列 `agent_runs` 的端点 + 界面上的一块），那是一个
WebUI 功能而不是一行 SQL。更要紧的是它有个坑：这个数字**刻意**不进任何聚合（迁移 `0014` 的注释
写了为什么 —— 那不是我们的钱、口径由外部 agent 定、我们无法核对），所以把它接到用量页上就是
「摆在自己的成本旁边邀请人把两者相加」，而那恰恰是它被单独开一列的理由。**做错比不做贵**，所以
先记着，等有人真的要这块面板时连位置一起定。

运维今天不是全瞎：`acp.run` 那条日志带 `costUsd` / `degraded` / `filesWritten` / `terminals`，
日志页看得见 —— 缺的是聚合与「挂在那一轮上」，不是这次调用花了多少钱本身。

**2026-08-30 闭合，而且只闭合了上面那两半理由里的第一半。** 原文一个字不改，是因为第二半仍然成立。

- **①「要新开一个呈现面」这一半自动消解。** worker 重构把「子 Agent」页整页替换成
  [09 §3.9](./09-webui.md) 的 Worker 运行记录页 —— 那个面本来就要开。`agent_runs` 上新加一列
  `worker_kind`（迁移 `0018`，`'lw'` / `'harness'` / `'acp'`，主 run 为 NULL）之后，
  `GET /api/worker-runs` 与 `GET /api/worker-runs/:id` 按它取数，ACP 那一行连同
  `external_cost_usd` / `external_usage_json` 一起读得到了；`GET /api/turns/:id/detail` 另带
  `workerRuns`，那一行也挂到了它所属的那一轮上。
- **②「接到用量页上就是邀请人把两者相加」这一半一个字都不推翻。** 闭合形态是
  **「读得到那一行」，不是「把那个数并进聚合」**：`external_cost_usd` 在列表与详情里都**单独占一格**，
  与 `cost_usd` 并排显示且**绝不相加**，格子旁写明它是外部 agent 自报、未经核对、不进任何聚合；
  `—` 表示它一次 `usage_update` 都没报过，与「它报了 0」分得开。用量页（`usage_ledger` / `turns`
  的聚合）**一个字节都没动**，ACP 照旧一行都不进那两张表。
- 判据由 `tests/webui/worker-runs.card.test.ts` 与 `tests/api.contract.test.ts` 焊住：两个数字必须落在
  两个不同的格子里，且任何一格都不得是两者之和。**把它并进聚合就是把一条有意为之的边界当缺口修掉**
  —— 那正是这条缺口当初不当轮闭合的理由。

**G-CFG-09 为什么不当轮闭合。** 专用表要照 MCP transport 那张的规格做（逐字段控件 + 校验回显 +
每一档的说明），那是一块真界面。而这一格的实际风险比它看起来小：`approvalMode` 与 `tools` 是
**一等配置键**（`acp/schema.ts` 里 `ACP_MANAGED_FLAGS` 拒收把它们塞进 `extraArgs` 的写法），
所以裸 JSON 里改错的结果是 zod 拒收整块、配置不生效，**不是静默失去一道权限门**。

`docs/13` 的验收覆盖：`AC-LOG-024` 覆盖那一行的落库形状，`AC-SEC-028` / `AC-SEC-030` 覆盖两个默认
档位。**闭合之后它有了自己的验收条目** —— 「那一行读得到」与「那个数不进聚合」都是可验收行为
（见 [13](./13-acceptance-criteria.md)），当初写「缺口不是可验收行为」是因为当时缺的是一整个
呈现面，而不是这句话本身成立。

§1 那三个数字是 **2026-08-18** 的快照，这一轮没有复算：M13 往 schema 里加了 `agent.acp.*` 整块
（叶子数上涨），同时从 `KNOWN_UNIMPLEMENTED_CONFIG_KEYS` 里摘掉了两个 acp 键。可写覆盖率不受影响
（自动生成的表单一次覆盖全部新叶子，`G-CFG-09` 说的是那一格的**形式**不是有没有）。

## 19. 手动验收这一轮（2026-08-25）

一条。它不是这一轮**做**出来的缺口，是这一轮**数**出来的 —— 排 [13](./13-acceptance-criteria.md)
的手动验收场次时逐条回代码核对，发现 `AC-WEB-016` 验的东西压根不存在，而它已经在验收文档里
挂了很多轮。这正是本文 §1 那套复算方法要抓的形态：**承诺写在规格文档里、验收条目照着它去验、
而实现从来没有过** —— 三份文档互相印证，唯独没有一份去问代码。

| 编号 | 运行时已有 | 界面缺什么 | 状态 |
|---|---|---|---|
| **G-UI-05** | `TOOL_POLICY` 加 `tools.overrides` 的合并结果由 `effectiveToolPolicy()` 算出，`GET /api/tools` 把每个工具的 `minRole` / `approval` / `enabled` / 来源全带出来了；「以某角色视角」要的判据也在（`available(role, ctx)` 与 `admit()`） | **权限矩阵只读视图整个不存在**：`packages/webui/src` 里 `视角` / `权限矩阵` 零命中。工具页只有工具表 + 审批规则卡 + 沙箱卡 + 持久容器卡 + 容器表 —— 逐行读得到某个工具的档位，但读不到 [05 §4](./05-tools-and-permissions.md#4-权限矩阵权威表) 那张「角色 × 工具」的全表，也不能切到某个角色去看它到底能用哪些 | 记录，不当轮闭合 |

**为什么不当轮闭合。** 数据全在，端点也在，所以它读起来像「渲染一张表」。不做的理由是位置未定：
这张表的价值在于**核对**（拿它跟 `docs/05 §4` 那张权威表对），而权威表现在由
`tests/tools.overrides.test.ts` 那族断言焊着 —— 界面上再画一张，就有了第三份需要同步的副本，
而本文 §1 记的教训恰好是「同一个事实有两份副本，迟早会漂」。真要做，判据得先定成
「界面这张表是从 `GET /api/tools` 现算的、不许有第二份静态清单」。

**连带的三处文档改动**（2026-08-25 一并做了）：[09 §3.6](./09-webui.md) 那句承诺标明未实现并指到
这里；`AC-WEB-016` 在 [13](./13-acceptance-criteria.md) 里记豁免；
豁免理由展开在 [29 §3](./29-manual-acceptance-log.md)。**先改文档再改代码**在这里的具体含义是：
不许让一句没兑现的承诺继续替一条验收项背书。

---

## 20. 别名链上看不出谁能看图（2026-08-27）

一条。来源与 §19 同类：**不是这一轮做出来的缺口，是清理 [`00 §2`](./00-state.md) 时数出来的**。
那一节的「能力位可以撒谎」整行搬进了 [04 §5.2](./04-agents-and-providers.md)（探针与判据留在那儿，
它会随下一家网关复发），搬的过程中剩下半句没有归宿：**别名链的顺序本身就能让一个瞎模型排在含图
轮次最前面，而此时那套推翻机制一条都不会响** —— 它只问「当前别名能不能看图」，答案为真就到此为止。

| 编号 | 运行时已有 | 界面缺什么 | 状态 |
|---|---|---|---|
| **G-UI-06** | `ModelRegistry.supportsVision(alias)` 逐个模型可判；`capabilities_json` 顶层的 `vision` 是运行时唯一读取的能力位；`PATCH /api/models/:id` 可人工推翻 | 别名编辑器**按顺序列出链上的模型，却不显示每一个能不能看图**。于是「把 `vision` 链首配成一个瞎模型」这个纯配置错误在界面上和正确配置长得一模一样，而它的后果是含图轮次静默答非所问 | 🚧 未做 |

**为什么它是缺口而不是配置问题。** 「运维配错了」当然是配置问题，但本文的口径是「运行时有这个
能力、界面够不着」—— `supportsVision()` 就在那儿，一次调用的事，而别名编辑器一个字都没显示。
`vision` 链尤其值得标：其余别名配错了顶多贵一点或慢一点，这一条配错了是**模型看不见图却不知道
自己看不见**（[04 §5.2](./04-agents-and-providers.md) 那次实测：绕 11 步去 cp 文件、python 读尺寸、
开本地 http 服务器、拿 agent-browser 截图）。

**判据。** 徽章取 `capabilities_json` 顶层（运行时读哪个就显示哪个，不要在前端再懂一层优先级，
这是 [§10](#10-标记模型能力) 定下的纪律）；`vision` 链首不能看图时要显式警示，而不只是少一个徽章 ——
**一个缺席的徽章和一个没查过的徽章长得一样**。
---

## 21. worker 重构这一轮

两来源的子 agent 定义体系整个删除（`agent.agents[]` / `agent.agentsDir` / `agents/<name>.md` /
`list_agents`），主 agent 不再直接调工具、只对话与派发，执行整体下沉给 **lw-worker**；
`spawn_harness` / `spawn_acp` 两条外部路合称 **harness-worker**。控制面这一侧的三处改动
（Worker 运行记录页、工具表的「可达侧」列、`GET /api/tools` 的 `sides`）在
[09 §3.7 / §3.9](./09-webui.md) 里，不在本文重复。

这一轮**闭合**了 [`G-API-25`](#18-acp-客户端这一轮m132026-08-22) 的第一半（理由与形态写在那一节，
第二半原样成立），**新开**一条：

| 编号 | 运行时已有 | 界面缺什么 | 状态 |
|---|---|---|---|
| **G-API-28** | `log_events.agent_run_id` 这一列接线了（派发时写进 worker 那份 `ToolExecutionContext`，worker 内部的每一条日志沿它带上 `agentRunId`；主 agent 自己的事件不带，与 `agent_runs.worker_kind` 上主 run 为 NULL 同一个口径，[10 §1](./10-logging-and-observability.md#1-trace-模型)） | `GET /api/logs` 只收 `traceId` 与 `minLevel`，**没有「只看这条 run」的过滤器**。于是 Worker 运行记录页的详情只能跳到**整轮**的 trace —— 一轮里派了三个 worker 时，运维得在三份交错的日志里靠 span 父链自己认哪几条是这一个的，而一次查询只取 500 行、父完全可能不在这一页里 | 🚧 未补 |

优先级 P2：它不影响运行时正确性，缺的是排障时的收窄能力，而那一列**已经在写**了 ——
最小形态是 `GET /api/logs` 多收一个 `agentRunId` 查询参数（判据就是那一列，不需要新表也不需要
新索引之外的东西），Worker 详情的 footer 多一个 `[只看这条 run 的日志]`。**不要用 span 父链去推**：
父链要一路爬到 `agent.run`，而 500 行的窗口保证不了父在同一页里，那正是「环与悬挂父按 depth 0
渲染」那条兜底存在的理由。

### 21.1 判定为「不是缺口」

- **Worker 没有独立的取消入口。** 与 `tasks` 同源：worker 跑在**父轮**的 abort 信号下，
  没有独立句柄，能取消的只有整轮（`POST /api/turns/:id/cancel`）。造一个只能取消整轮的
  `POST /api/worker-runs/:id/cancel` 等于起一个会误导人的名字，与 `GET /api/tasks` 那条
  「没有 `POST /api/tasks/:id/cancel`」是同一个判断。
  **但这件事必须写在页面上** —— 否则运维看到一条跑了 20 分钟的 harness 会去找一个不存在的入口，
  所以 Worker 运行记录页上直接写明「这里没有取消」并指到总览页的在途轮次
  （[09 §3.9](./09-webui.md)，`tests/webui/worker-runs.card.test.ts` 焊住这句话在)。

## 22. SDK 接入这一轮（2026-09-05）

`docs/12` 落地的 SDK 会话（`/sdk/v1`、来源与密钥）在既有 WebUI 页面上留下三处缺口：会话与
消息两张既有页面从一开始就只按 Telegram 单一来源设计，SDK 会话经既有代码路径混进同一批
数据后没有任何一处专门处理它；第三处是记账读口本身就没有对应的运行时能力（[§9](#9-记账)，
非「有能力接不上」而是「能力本身没做」）。

| 编号 | 运行时已有 | 界面缺什么 | 状态 |
|---|---|---|---|
| **G-API-29** | `GET /api/chats` 已返回 `sourceId`（[09 §3.9a](./09-webui.md#39a-sdk-接入来源--密钥)，`docs/12 §2`） | 会话页的会话列表把 Telegram 会话与 SDK 会话混排成同一份列表，没有来源列、没有按来源过滤——`sourceId` 已经在响应体里，界面上一处都没读它 | 🚧 未补 |
| **G-API-30** | `messages.from_user_id` 对 SDK 会话形如 `<sourceId>:<endUserId>`（`docs/12 §7`），与 Telegram 侧的数字 tg id 形态不同 | 消息浏览页按 Telegram 的字段假设渲染发送者（用户名、头像、tg id），SDK 会话的消息没有对应的 Telegram 元数据可显示，界面上要么空白要么显示原始复合字符串，没有专门的呈现分支 | 🚧 未补 |
| **G-API-31** | `UsageLedger.sourceUsage(sourceId)` 已实现并可用（`packages/core/src/ledger/usage.ts`，[03 §2.15](./03-data-model.md#215-sdk-密钥与会话)、`docs/12 §9`） | 没有任何 HTTP 端点读取它，WebUI 用量页只按 chat/user/全局聚合，没有「按来源」这个维度可选，因此也没有界面能展示 SDK 来源各自的花费 | 🚧 未补，前置：先加端点 |

三条均记录、不当轮闭合：前两条需要先定「会话列表 / 消息浏览页要不要对 SDK 会话做区别呈现」
这个产品问题（不是纯粹的接线工作），第三条 `sourceUsage()` 本身缺 HTTP 端点，是比「界面接不上
已有能力」更靠前一步的欠账。与 `docs/00 §2.1` 的 `SDK-01`/`SDK-02`（限额欠账）成因相邻但不是
同一条：三者共享「SDK 按来源维度尚未在运维侧充分展开」这个背景，`G-API-31` 只记在本文，
不重复登记进 `docs/00`。
