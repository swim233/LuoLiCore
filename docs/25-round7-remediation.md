# 25 · 第七轮：把散落在文档里的 🚧 逐条查干净

> 触发方式与前六轮不同：不是「再审一遍找新问题」，而是**把 25 份文档里所有 🚧 / 「未实现」/
> 「未接线」/ 「仍然开着的」标记捞出来，逐条回代码核对**，然后按需求方的决策收口。
> 方法：不采信文档自述，每一条都回到代码里看。
>
> 需求方决策：**全面推进**（含成组功能与 WebUI 中等成本项）；`docs/13` 只勾标 `(自动)` 且
> 真有用例的条目；WebUI **只补组件测试层、不重做 `D-UI-01` 的拆分**；补 SIGTERM 与资源上界两组测试。

---

## 0. 一句话

25 份文档里的 🚧 有三种命运：**1 条是文档滞后**（说没有、其实上一轮就接上了）、
**约 50 条是真没做**、**5 条留着只会误导运维**。查完之后：`docs/09` 的 🚧 计数从 11 到 **0**，
未接线配置键从 **65 到 12**，`docs/22 §4` 的 14 项改进从「11 项未处理」到 **0 项未处理**。

最能说明问题性质的一条：用量页的维度聚合。`UsageLedger.report(from, to, groupBy)` 六个维度
一个不少，**从来没有任何端点调用过它** —— 于是界面上只有一张不分维度的明细表，
「这个月钱花在哪个群」得靠人肉翻 1000 行。加一个端点就接上了。

而最能说明**验证**性质的一条：这一轮新建的 WebUI 组件测试层，第一次运行就抓到了我自己在上一个
提交里写错的 prop 类型（给只认字符串的 `UiSelect` 绑了个数字）。`docs/24` 把「没有组件级测试」
列成最大空白是对的。

---

## 1. 文档滞后（1 条）

| 位置 | 文档说 | 代码实际 |
|---|---|---|
| `docs/03 §2.11` 的 `approvals` 表注释 | 🚧「当前没有可用的审批通道，命中规则的调用当场写 `denied`，**不再产生 pending 行**，表保留为审计视图」 | **过时**。`R-APPR-01` 之后判据是 `EventBus.channelCount`：WebUI 的 SSE 挂着时正常写 pending 行并等裁决 / TTL / 轮次取消，只有零通道才当场拒绝。注释里连 `decision_channel` 的取值都是错的（写 `none`，实际写 `system`） |

顺带：`CLAUDE.md` 里 `docs/13` 的条数从 357 改成实际的 372。

---

## 2. `docs/22 §4` 的可改进条目：11 项未处理 → 0

| 编号 | 修法 | 回归用例 |
|---|---|---|
| I-01 | `/api/messages` 非搜索分支改走 SQL `LIMIT/OFFSET` + 单独 `COUNT(*)`。此前 `LIMIT 1000` 拉回来再在内存里切，`size=50` 时**第 21 页起永远是空的**，`total` 封顶 1000 —— 界面上的页码全是假的 | `regression.round7.test.ts` |
| I-02 | `turns=turns+1` 从 `commit()`（每步都调）移到 `reserve()`（每轮一次）。此前 `quota_counters.turns` 统计的是**步数**，而配额页把它标成「轮次」 | 同上 |
| I-03 | `list`/`glob`/`grep` 的 `statSync` 包 try/catch，跳过读不到的条目并回 `skipped: n`。一个断链软链此前让整次调用 `ok:false` —— 同目录另外几百个好文件一并看不见 | 同上 |
| I-04 | 六行（3 scope × 2 window）从六条单行 UPDATE 合成一条行值 `IN` | 同上 |
| I-05 | **误报**，见 §3 | 同上 |
| I-06 | `PUT /api/config` 落库改用 `parsed.data`。此前落的是请求体原值：写祖先键时 zod 补的兄弟默认值一个都不进 `config_kv`，下次启动重放覆盖层就把它们抹回默认，而界面说「已保存」。顺带 schema 外的路径当场 400 而不是等 `loadConfig` 兜底 | 同上 |
| I-07 | 文本提取先按字节 `subarray` 粗截到 `maxChars*4` 再展开码点，末尾被切开的字符交给 `StringDecoder`。此前为了取 4 万个码点先把 20MB 文档展开成两千万元素的数组 | `resource-bounds.test.ts` |
| I-09 | `MaintenanceService.gcFiles()`（只删没有任何 DB 行指向的孤儿）+ 设置页按钮；子 agent 全文按 `logs.retentionDays` 过期，`result_summary` 留着。**媒体附件不自动过期** —— 那是 `docs/14 §2` Q9 的未决问题，不替需求方决定 | `regression.round7.test.ts` |
| I-10 | `dryRunAgent` 与提示词预览的 `finally` 里补 `releaseTurn`。此前每跑一次试跑就在工具注册表与审批记忆里永久多留两条 | 无（落在 `main.ts` 的装配里，见 §6） |
| I-12 | CSP 补 `object-src 'none'` / `base-uri 'self'` / `form-action 'self'` / `frame-ancestors 'none'` | `regression.round7.test.ts` |
| I-13 | 静态兜底之前加 `app.all('/api/*')` → 404 JSON。此前未匹配的 API 路径拿到 200 + `index.html`，前端在 `response.json()` 处抛 SyntaxError，报错信息与真实原因毫无关系 | 同上 |

九条各配一个**对着旧实现会红**的用例（已实测九条全红）。

---

## 3. `I-05` 是误报 —— 但同一处有另一个真问题

`docs/22 · I-05` 说 `MemoryStore.flush()` 是「无锁的读-改-写整份文档，两个并发轮次同时写
PUBMEMORY 会丢更新」，建议复用 `KeyedMutex`。

**这不成立**：`flush()` 从 `readFileSync` 到 `writeFileSync` **全程同步**，中间没有一个 await，
事件循环插不进来。加锁是在锁一件不会发生的事。

同一处真正会漏的是另一件：`queueWrite` 的**去重与硬上限判据取自工具调用那一刻的快照**，
而落盘发生在轮末。中间别的轮次写过同一份 PUBMEMORY 的话 —— 重复条目照样落盘，硬上限也会被越过。
两条判据改成在 `flush()` 里按新读到的内容再走一遍；顺带让来源标注不再参与相似度
（`<!-- src: … -->` 那串字母数字把字符集合的并集撑大，让「同一条」看起来只有六七成像）。

> 这条记在这里是为了下一轮别再照抄：**复审报告也会错**，而按错的诊断改出来的东西看起来同样像
> 「已修复」。

---

## 4. 配置键：65 → 12

### 4.1 摘除 5 条（从 schema 删）

留着的代价是运维在一个永远不生效的格子里改东西，或者在两个同义键里改错那一个。

| 键 | 理由 |
|---|---|
| `general.locale` | i18n 在 `docs/14 §4` 明确「第一版不做」 |
| `approval.allowInitiator` | WebUI 只有一个 owner 身份，裁决权下放不到发起人，当前架构里没有落点 |
| `quota.perTurn.maxToolCalls` / `maxSubagents` / `maxDurationMs` | 三个各有一个**真正在管这件事**的同义键（`tools.maxCallsPerTurn` / `agent.maxSubagentsPerTurn` / `concurrency.turnTimeoutMs`） |

顶层 schema 不带 `.strict()`，所以老 `config.yaml` 里的残留会被静默 strip、`config_kv` 的残留行由
`onInvalidOverride` 剔除告警 —— 升级不会卡住。

### 4.2 接线 48 条

低成本 25 条（`general.name`、`telegram.dropPendingOnStart`、`trigger.cooldownMsPerUser`、
`concurrency.coalesceSameUserMs`、`context.background.showTime`/`includeNonText`、
`prompt.includeToolCatalog` + `runtimeBlock.*`、`tools.archive.*Limit`×4、
`agent.maxConcurrentSubagents`/`progressThrottleMs`、`provider.healthDownCooldownMinutes`、
`mcp.connectTimeoutMs`、`skills.enabled`、`plugins.enabled`/`watch`、`media.*`×4）
+ 成组功能 23 条，其中值得单说的：

- **告警链路**（新增 `core/alerts.ts`）：`docs/10 §6` 写了六类要私聊 owner 的告警，配置项也齐全，
  但**从来没有任何代码 raise 过它们**。六个发起点各自接上。webhook 走 `net/outbound.ts`，
  不另开第四条出网路径（`I-14` 的教训）。整条链路一律不抛 —— 调用点全在 catch 块和失败分支里。
- **出网域名策略**：`tools.web.allowlist` / `denylist` 落在 `safeTarget` 里，**每一跳重定向都复验**
  —— 只挡第一跳的话，一个放行域名的 302 就能把请求带去任何地方。
- **`quota.warnAtRatio`**：`reserve()` 此前只回 `null`，分不出是 global 还是某个人超限。补
  `lastRejection`，只有 global 档才惊动 owner；顺带让「额度用完了」那句话里的 `{spent}/{limit}`
  不再是两个破折号。
- **`memory.pubWriteRequiresApproval`** 走注册表新增的 `approvalFor` 钩子（**只能抬高审批档位
  不能放低**），审批路由仍只有一处。
- **`cancel.commitPartial`** 只对 `cancelled` 生效 —— `failed` 提交半截产出会把模型自己都没说完的
  话变成历史事实。
- **`trigger.cooldownMsPerUser`** / **`concurrency.coalesceSameUserMs`** 被压住的消息都降级成
  `triggered=0`：留着 `triggered=1` 会让它既不触发也不进背景认领，等于凭空消失（编辑消息踩过这个坑）。

### 4.3 留着的 12 条：每条都写明为什么

`schema.ts` 的注释与 `docs/11 §2.0.1` 各一份。「暂时没做」和「做不了 / 不该在这一层做」是两回事：
`memory.autoApplyCompaction` 是给一个**不存在的产物**配开关（压缩本身没实现）；
`agent.askArbiter` 那两个跟着未实现的 `ask_parent` 仲裁；`db.ftsTokenizer` 要追加迁移而方案本身是
`docs/14 §2` Q3 的未决问题。**不写理由的话下一轮还要重判一次。**

> `config.test.ts` 那条热更新标注断言在这一轮里抓出了 **11 处**标注与实现对不上（`alerts` 整段、
> `logs.redactPatterns`、`memory` 两项、`tools.fs`/`tools.web` 各一、`cancel`、
> `skills.enabled`/`plugins.enabled` 从「热更新」改成「需重启」……）。这正是它存在的理由。

---

## 5. WebUI：`docs/09` 的 11 处 🚧 → 0

| 项 | 落点 | 值得记的取舍 |
|---|---|---|
| `/webui` 一次性登录 | 命令 + `issueLoginToken()` + `POST /api/auth/token` | token 存内存、单次使用、5 分钟过期、签发表有界；**群里直接拒绝**；服务端不记 token 本身。三者由 CI 断言锁死 |
| Dashboard 趋势 + 额度环 | `/api/dashboard` 的 7 天 trend | 按 `general.timezone` 的**本地日**分桶；缺的那天补 0 —— 折线图上「没有点」和「是 0」是两回事。`limit === null` 时不画环只写「不限」 |
| 最近错误 | `?minLevel=warn&size=10` | 过滤在服务端：前端过滤会因为日志页只取最近 200 条而漏掉更早的错误 |
| 系统信息占用 | `/api/health/detail` | **只统计不清理**；目录递归有 8 层上界（workspace 里是模型自己造的树） |
| 拉取镜像 | `POST /api/sandbox/image` | 只 pull 不 build；镜像名取自已保存的配置，不收请求体 |
| 审批规则试跑 | `POST /api/approvals/test` | 用**运行时那份** `ApprovalRules`，逐条说出**为什么没命中**；`when: target_exists` 一律记成「取决于运行时」 |
| 用量维度 + 图表 | `GET /api/usage/report` + 自建 SVG 原语 | 聚合早就实现好了，只是没人调过。条形图只画前 10 并合成「其余 N 项」，**不静默截断** |
| 原始 YAML | `GET/PUT /api/config/yaml` | **解析在服务端**，用 `loadConfig` 那个解析器 —— 放前端等于让两处方言各自漂移 |
| 重启进程 | `POST /api/restart` | **先回响应再退出**；二次确认写明没有 supervisor 时进程不会自己回来 |
| 导出 / 导入 | `/api/config/export` + `/api/config/import` | 密钥类键**不导出**而不是导成 `«redacted»` —— 后者会让导入端把真密钥覆盖成一个字面量 |

**顺带修掉一个会静默丢配置的判据**：导出侧原本拿整条点分路径去测 `/key|secret|token|password/i`，
`context.limit.tokens` 的叶子是 "tokens" 于是被当成密钥跳过 —— 一份导出里静静地少几项真配置。
改成「叶子段 + 值是非空字符串」，与 `publicConfig` / `revisionJson` 同一套口径。

---

## 6. 测试层：`docs/24 §3` 点名的两处空白

- **WebUI 组件级测试**（`tests/webui/` + happy-dom + `@vitejs/plugin-vue`）。逐个切过 14 个导航项，
  断言内容区**有实际文本**且整个过程零 Vue 警告。`docs/24` 把这层列成「重做 `D-UI-01` 的前置条件」
  —— 现在它有了，而且**第一次跑就红了**（抓到我自己写错的 prop 类型）。
  **`D-UI-01` 的拆分本身仍未做**（需求方决定），回退状态保持。
- **SIGTERM**（`tests/shutdown.test.ts`）两条腿，边界写清楚：真实进程 + SSE 连接 + SIGTERM 断言在
  `graceMs + 1s` 内以 0 退出（挡 `D-OPS-02`）；源码级断言关停路径仍调 `abortAll`（挡 `R-OPS-01`）。
  **为什么第二条不用真实进程**：要触发它得有一个宽限期内排不空的在途轮次，而在途轮次只能从
  Telegram 入口开出来，而这个测试必须清空 `BOT_TOKEN`（否则会抢走本机在跑的 bot 的长轮询）。
  源码断言比一条测不到的空话诚实。
- **资源上界**（`tests/resource-bounds.test.ts`）：沙箱 stdout 8MB 截断、20 万个三字节字符不在 chunk
  边界被切坏、7M 字符文档提取只读 `maxChars*4` 字节、日志单文件轮转、超限 payload 外置。
  每条都写明「对着旧实现会怎样」—— `R-SEC-01` 那种「用 4 个 `a` 测正则回溯」的断言是在验证守卫
  自己的公理，不能再出。
- **`AC-DB-003` 的 SQL 扫描**（`tests/db.isolation.test.ts`）：`docs/14` T7 那条取舍写着
  「隔离靠代码纪律，不是物理边界」，缓解手段之一是「CI 的 SQL 扫描测试（AC-DB-003）」——
  **那条测试根本不存在**。现在扫的是每个作用域化仓库方法的 SQL，「按设计跨会话」的四个方法
  逐条写明理由，而且**反向也断言**：豁免名单里的每一项都必须真的还在扫描结果里。

---

## 7. `docs/13`：0 / 372 → 93 / 372，而且勾选说话算数

这份文档自第二轮起没更新过：372 条全是 `[ ]`、签署表 12 行全空。光把框勾上没有意义 ——
下一轮谁也分不清那个 `[x]` 背后是真有用例还是有人手快。所以勾选形式被定死成
`[x] AC-… (自动) | … 〔用例文件〕`，由 `tests/acceptance.test.ts` 四条断言约束：

1. 勾了就必须点名用例文件，而且文件真的存在；
2. 没勾的不许挂用例注记（防「注记先写上、框以后再勾」）；
3. **只有标 `(自动)` 的条目能勾**（人工条目要人签字）；
4. 签署表每个模块的分子分母必须等于文档里真实数出来的条数。

第 4 条是这份文档此前最容易腐烂的地方。它在上线时就抓到两处：`AC-TG-014` **有两条完全不同的
验收项共用一个编号**（后一条改成 `AC-TG-023`），以及签署表漏了 `AC-QUOTA` 那 12 条
（原表把它和日志成本合在一行，分母 23 = LOG 11 + QUOTA 12）。

**93 / 372 是真实数字，不是「验收通过率」**：剩下的 `(自动)` 条目里还有约 120 条**没有对应用例**
（不是没核对，是真的没有）。那是下一轮该补的测试，而不是该勾的框。

---

## 8. 仍然开着的

| 项 | 状态 |
|---|---|
| `D-UI-01`（`ConsoleView.vue` 1700+ 行的拆分） | 需求方决定本轮不做。**前置条件已满足**（组件测试层已在） |
| Telegram inline keyboard 审批 | 仍未实现，裁决只能在 WebUI 做。**但发起人回执已补**：挂起时往发起人所在会话发一句「需要 owner 批准，N 秒内没人处理就自动拒绝」——此前那一轮会静默停住最多 180 秒而 Telegram 一个字都没有 |
| 12 个未接线配置键 | 每条都在 `docs/11 §2.0.1` 与 `schema.ts` 里写明了为什么 |
| `docs/13` 剩下约 120 条 `(自动)` 条目 | 没有对应 vitest 用例。人工条目 149 条一律保持 `[ ]` |
| `docs/14 §2` 的 Q1–Q12 | 从未答复。其中 Q3（jieba 分词）、Q4（主动发言）、Q9（消息/媒体保留策略）已经**分别挡住**了 `db.ftsTokenizer`、定时发言、媒体自动过期三件事 —— 这三个 🚧 的前置条件是需求方拍板，不是工作量 |
| `I-10` 的回归用例 | 落在 `main.ts` 的装配里，没有单测能覆盖。这是本轮唯一一条「改了但没有用例」的 |

---

## 9. 验证

| 检查 | 结果 |
|---|---|
| `pnpm typecheck` | 通过 |
| `pnpm lint` | 通过 |
| `pnpm test` | 63 文件 / **312** 用例通过（本轮开始时 270） |
| `pnpm build` | 通过 |
| `pnpm smoke` | 通过（顺带把它手搓的 `as never` 配置换成 `configSchema.parse` —— 冒烟脚本不该因为无关的新配置项而变红） |
| 生产构建起真实进程 | 通过（`BOT_TOKEN` 清空，避免挤掉本机在跑的 bot） |
| 控制台 14 页渲染 | 由 `tests/webui/console.render.test.ts` 自动断言 |

顺带两处与本轮主题无关但顺手修掉的：
- `log_events.file_ref` 这一列**从来没被写过**（引用只藏在 `data_json` 里），而 `docs/03` 的 DDL
  里就有它 —— 照那份 DDL 查库的人会以为「没有 file_ref 就是没有大载荷」。
- 8 个测试文件里手搓的 `{...} as Config` 换成 `configSchema.parse(...)`：手搓的那份每新增一处
  配置读取都会在无关用例里炸成 undefined。两条**故意**用 schema 外的值的用例（`tokens: 1` 压硬截断、
  拼错的时区压渲染回退）改成先 parse 再覆盖那一个字段。
