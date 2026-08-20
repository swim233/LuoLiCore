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

## 0. 一句话结论

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
| `memory` | 7 | `dir` `pubWriteMinRole` `softLimitTokens` `hardLimitTokens` `maxSections` `compactCron` `forgetMeRetentionDays` |
| `media` | 7 | `dir` `maxImageBytes` `maxDocBytes` `maxImageEdge` `extract.enabled` `extract.maxChars` `extract.inlineChars` |
| `logs` | 7 | `level` `dir` `captureBodies` `bodyMaxBytes` `maxFileMb` `retentionDays` `console` |
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
| `GET /api/logs/blob` | 被 `GET /api/logs/:id/data` 取代（后者带 `content-disposition`，且 blob 解引用一致） |
| `GET /api/messages/:id`、`GET /api/chats/:key/commits` | 列表端点已经返回同样的字段，单条端点是给外部集成留的 |
| `GET /api/models/catalog` | `GET /api/providers/:id/models` 的响应里已经带 `catalog` 状态块 |
| 工具的 `scope` 只读 | `scope` 在运行时不参与任何判定，只是给人看的标签 —— 做成可写等于放一个改了没效果的开关。`source` 同理，它由注册方式决定 |
| ~~工具的 `minRole` / `approval` 只读~~ **已推翻** | 原理由是「单一策略源 `TOOL_POLICY` 注册期 fail-closed，从界面调低最低角色 = 权限矩阵有两份会漂移的真相」。现按运维诉求开放为覆盖层（`tools.overrides.<name>.minRole` / `.approval` / `.timeoutMs`）：`TOOL_POLICY` 降级为默认值与对照基准，界面同时显示「代码默认」与「当前生效」，**放宽需二次确认**（409 `relax_requires_confirmation`）并在表上留标记。漂移风险用三条性质压住 —— 覆盖绕不过 `available()`、`approvalFor` 抬档只升不降、合并逻辑（`effectiveToolPolicy`）只有一份且 registry 与服务端共用。仅全局，不进 `perChat` 白名单。见 docs/09 §3.7 |
| 模型别名不能指向不存在的模型、别名链不能为空 | `PUT /api/aliases/:alias` 的校验，不是缺口 |
| 70 个 `KNOWN_UNIMPLEMENTED_CONFIG_KEYS` | 运行时没接线，**不该**有控件。接线时从白名单里摘掉，同时补控件、改 `docs/11` 的 🚧 清单、复算 §1 的数字 |

---

## 6. 第三轮结论

G-API-10/11/12 与 G-SRV-02/03/04 均已完成；按本文「运行时已有、WebUI 够不着」的口径，
当前没有剩余项。仍存在但**不属于本清单缺口**的边界：

- ~~`POST /api/maintenance/gc-files` 仍显式返回 `not_implemented`，界面继续不提供按钮。~~
  → 第五轮已实现并补上按钮（`G-SRV-05`）。
- Telegram inline keyboard 审批仍未实现（裁决只能在 WebUI 做），但**发起人回执已补上**（第七轮）：
  挂起 pending 行之后立刻往发起人所在会话发一句「需要 owner 在 WebUI 里批准，N 秒内没人处理就
  自动拒绝」。此前那一轮会静默停住最多 `approval.ttlMs`（默认 180s）而 Telegram 一个字都没有 ——
  发起人现在至少知道自己在等什么、等多久。待审角标照旧挂在导航上（§4.6）。
  一个裁决通道都没有时不等待，当场拒绝并把原因交给模型（[22](./reviews/22-review-round6.md) · `D-APPR-01`、
  [24](./reviews/24-review-round6-verification.md) · `R-APPR-01`）。

### 6.1 新增缺口（第六轮整改后）

| 编号 | 运行时已有 | 界面缺什么 | 状态 |
|---|---|---|---|
| **G-API-13** | `POST /api/auth/password {current, next}`：校验旧口令、写 `config_kv` + `config_revisions`、吊销其余 session、即时生效（[22](./reviews/22-review-round6.md) · `V-AUTH-02`） | 设置页没有改口令表单。泄露口令后的应急处置目前只能打 API 或线下 `pnpm webui:passwd` + 重启，而这正是 `V-AUTH-02` 要消灭的形态的另一半 | ✅ 第四轮：设置页首屏就是「修改登录口令」；`WEBUI_PASSWORD` 钉住口令时换成一条告警（改了重启就回退，见 G-CFG-03） |
| **G-API-14** | `app_kv` 的 `modelAlias:<contextKey>`（Telegram `/model` 写入）**压过** WebUI 能改的 `perChat.<key>.agent.main.modelAlias` 与全局 `agent.main.modelAlias`（`runtime.ts` 先读它） | 界面上只有覆盖面板里一行小字提到这件事：改了模型别名不生效时，运维在 WebUI 里既看不到那份别名、也清不掉 | ✅ 第四轮：`GET /api/chats/:key` 带回 `modelAlias`，会话页出黄色提示 + `[清除会话别名]`（`DELETE /api/chats/:key/model-alias`） |

- `health` 事件仍只在 provider 测试与 MCP 重连后发送，没有周期心跳；顶栏的新鲜度依据业务事件，
  不把连接状态伪装成周期健康检查。

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

| 编号 | 运行时已有 | 界面缺什么 | 状态 |
|---|---|---|---|
| **G-API-15** | `POST /api/plugins/:name/reload` 回 `hotReloadReliable` + `warning`：跑在 tsx（`pnpm dev`）下时热重载**静默跑旧代码**，reconcile 每次都真跑、`onLoad` 每次打印的都是第一版（`docs/28 · L-EXT-04`） | ~~扩展页仍只弹「已重载」~~ | ✅ 已接（`PluginCards.vue` + `ExtensionsPage.reloadPlugin`：`hotReloadReliable === false` 时弹**不自动消失**的 warn，并在卡片上常驻一条提示） |
| **G-API-16** | `mcp_servers.state` 在子进程被 `kill -9` 之后最长 5 分钟才被下一次 `mcp-health` reconcile 纠正 —— 期间界面显示 `up` 而那台 server 的工具已经不在模型目录里（`docs/28 · L-EXT-02` 的残留） | ~~扩展页没有「这一行可能是陈旧的」提示~~。**底层那件事没修也修不了**：不是在 `onclose` 里写库就能解决（那个回调从子进程的 `'close'` 事件同步跑，`closeDatabase()` 之后一条泄漏子进程自然死亡会让裸 `db.prepare` 抛在 handler 里 → `uncaughtException`），要秒级反映得先给它加一个「库还开着吗」的判据 | ✅ 界面这一半已接（`McpTable.vue`：「上次核对」列 + 超过一个 `healthCheckCron` 周期就标「可能已陈旧」。判据用 `updated_at` 而不是去解 cron 表达式）。**运行时那一半仍然开着**，见 [00 §2.3](./00-state.md) |

### 6.4 新增缺口（扩展页重设计 + MCP 登录这一轮）

| 编号 | 运行时已有 | 界面缺什么 | 状态 |
|---|---|---|---|
| **G-API-18** | `plugins.config_json` + `PATCH /api/plugins/:name` 收 `config`，而 `definePlugin` 的 `configSchema` 就是为它准备的 | 前端从来不发那个字段，也没有表单。`SchemaForm.vue` 已经能把一份 JSON Schema 渲染成表单（设置页「全部配置」在用），所以缺的是接线而不是控件 | 🚧 未接 |
| **G-API-19** | `skills.dir` / `skills.enabled` / `skills.watch` 运行时改了不生效：`SkillLoader` 在构造时就把 `directory` 拿走了，而 `main.ts` 对任何 `skills.*` 变更只是重扫**老目录**；运行时打开不会启动 watcher，关掉不会清空内存里那份目录 | `docs/11` 标的是「需重启」所以不算文档撒谎，但那条重扫的接线读起来像是支持热更新的。界面上没有任何提示 | 🚧 未接（本轮沿用，非新增） |

---

## 7. 第四轮改了什么

口径推进：前三轮问「有没有控件」，这一轮问「**这个控件说话算数吗**」。查法是拿 `configJsonSchema()`
的 226 个叶子 × `SchemaForm` 的真实渲染规则（`$ref` 解析、secret 正则、未接线过滤）× 六个写入端点
× 运行时真实读取路径逐条对齐，再单独复核 67 个未接线键有没有误判（**没有**：逐个全链路 grep 过）。

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

---

## 9. 装 skill 包这一轮

起因不是复算出来的缺口，是一次实测：用户在 Telegram 丢了一个带 `scripts/` + `bin/`
的音乐 skill 包，模型解到工作目录用了起来，而扩展页上一个字都没有。根因与通道见
[00 §2.3](./00-state.md) 与 [07 §2.5 / §6.5](./07-skills-plugins-mcp.md)。

| ID | 缺的是什么 | 优先级 | 状态 |
|---|---|---|---|
| G-EXT-01 | **装不了多文件 skill**。`docs/07 §2.1` 的格式一开始就允许附属文件，`SkillDefinition.files` 与 `skill://` 也是为它准备的，但没有任何途径把它们放进去：`write_skill` 只收 `body: string`，fs 工具对 `skills/**` 关死 | P1 | ✅ 本轮补（`installSkillPackage` + `install_skill` + `POST /api/skills/package`） |
| G-EXT-02 | `skills.source` 是死列 —— schema 有、`persist()` 从不写、WebUI 从不读，所有行都是默认值 `local`。装包进来的和随包发的四份说明书在界面上分不开 | P2 | ✅ 本轮补（`bundled`/`package`/`local` + 来源徽标 + 未审阅徽标） |
| G-EXT-03 | **陈行永不清理**。`persist()` 只 upsert，唯一会删行的是 `SkillLoader.remove()`；盘上删掉一个 skill 目录，那一行永远留在表里、永远显示在扩展页 | P2 | ✅ 本轮补（`scan()` 末尾清理，`ENOENT` 那支不清） |
| G-EXT-04 | 随包那四份说明书 WebUI 侧**能改能删**。`write_skill` 从一开始就拒改它们，同一条不变量只焊住了一半 | P2 | ✅ 本轮补（`DELETE` 与「改 `enabled` 以外任何字段」回 403） |
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

**新增缺口：无。** 另有两条与本轮同源但不属本文口径的事实记在 [00 §2.3](./00-state.md)：
`vision` 是目前唯一被运行时读取的能力位（其余五位只喂徽章），以及别名链的顺序本身就能让一个
瞎模型排在含图轮次前面 —— 那是配置问题，别名编辑器一直够得着。

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

## 13. 界面不显示 `min()` 的结果（2026-08-20）

又一条本文 [§1.2](#12-假控件界面上能点运行时不读) 的形态，且与 [§12](#12-界面在说谎的三处2026-08-19)
的 G-UI-01 同源：**服务端已经算得出来的判据，界面咽了回去**。起因同样是一次实际使用 ——
运维在主体页把某人改成 `trusted`，模型此后每一轮仍说自己面对 `limited`，而两边各自都没错。

| 编号 | 运行时的事实 | 界面此前给的 | 状态 |
|---|---|---|---|
| **G-UI-03** | 一个私聊在 `principals` 里占两行（`user:X` + `chat:X`），有效角色 = `resolveEffectiveRole` = `min(两行)`，模型系统提示里那个 `role` 就是它 | 两行的显示名与 tg_id 完全一样、只差一个类型标签，角色列各显示各的 `role`，`min()` 的结果**一处都不显示**；`list()` 又按 `updated_at DESC` 排，刚 PATCH 过的那行必然置顶 —— 于是「只改了 `chat:X`」与「改对了」长得一模一样 | ✅ 本轮修 |

实测那次：`user:1445849516` 停在 `limited`（被一次批量降权扫进去），`chat:1445849516` 前后被
PATCH 成 `trusted` 三次而 `user:` 那行一次都没被点到，期间 10 轮 `turn.start` 全部记着
`role=limited`。对照组是同期另一个人 —— 两行都改了，所以他一直是对的；差别只在于有没有人
记得改第二行。弹窗里那句「要放行这个人，改 `user:X` 那行更直接」当时**已经在了**，没挡住。

改法与四处取舍：

- **算在服务端。** `GET /api/principals` 每行多回一个 `effectiveRole`，用 core 的
  `resolveEffectiveRole` 算。前端不重算第二份 —— 与 G-UI-01 把类型判据合并成一份是同一条规矩。
- **配对本身就是判据，不看第三次 `chat_type`。** Telegram 用户 id 恒正、群 / 频道 id 恒负，
  `user:X` 与 `chat:X` 同时在表里就只可能是一对私聊。再引一次「先信 `chat_type`，缺了看正负号」
  等于把那条判据抄成第三份。
- **群 / 频道回 `null`，不回它自己的 `role`。** 那一行是上限，每个成员的有效角色各不相同；
  给一个看起来确定的值是「摘除比伪造安全」的反面（[16 §5](./reviews/16-remediation-plan.md)）。
- **只在不一致时出红字。** 这一页有几十行，逐行挂一个「有效 X」是噪声；要显眼的是「你以为改了
  但没生效」这一种行。

**留了一条没做**：弹窗里「同时把 `user:X` 也改成同一角色」的一键补齐。本轮先把判据显出来 ——
一键补齐会替运维改第二个主体，语义上要单独定（批量改角色那条路要不要一起补齐？），下一轮做。

---

## 14. web_fetch 抓回来的图这一轮（2026-08-20）

| 编号 | 运行时已有 | 界面缺什么 | 状态 |
|---|---|---|---|
| **G-API-20** | `web_assets` 表 + `media.dir/web/<key>/` 下的文件：`web_fetch` 抓回来的图与 MCP 工具交回的截图（[05 §3.6](./05-tools-and-permissions.md)、[03 §2.4](./03-data-model.md)） | 三处都够不着：① 上下文里那条注入消息渲染出来只有文本，**图看不到**（`G-API-08` 给 `attachments` 补的那条附件带子只认 `attachment://`，`webasset://` 走的是另一张表）；② 总览页的占盘统计只算 `attachments`，这一部分不计入；③ 没有任何地方能看「这个会话抓过哪些图」或手动清掉一张 | 🚧 未补 |

优先级 P2：它不影响运行时正确性（保留期与 `gcFiles` 都已接上，见 [03 §4](./03-data-model.md) 那两行），
缺的是**可见性** —— 运维看不出模型这一轮到底看到了哪张图。眼下唯一的凭据是
`media.web_asset` 日志（[10 §2](./10-logging-and-observability.md)）。要补的话最小形态是给
`GET /api/files/:id` 加一条 `webasset://` 分支，让消息卡片那条附件带子对两张表一视同仁。
