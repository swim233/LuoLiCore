# 14 · 未确认项、默认假设与已知取舍

三类内容：
- **§1 默认假设** —— 设计问答中未逐条确认，我按合理默认写入了文档。**若与你的预期不符，改这里指出的那一处即可**。
- **§2 待确认问题** —— **2026-08-18 已全部答复**（Q1–Q13），逐条结论与理由都在那一节。
- **§3 已知取舍** —— 由已定决策直接推导出的代价，需求方已知情或应当知情。
- **§4 明确不做（第一版范围外）**。

---

## 1. 默认假设（未逐条确认，可随时推翻）

| # | 假设 | 依据 / 影响面 | 若要改动 |
|---|---|---|---|
| A1 | Telegram 接入默认**长轮询**，Webhook 作为配置项 | 长轮询无需公网 HTTPS，开发与自托管最省事 | `telegram.mode` |
| A2 | 文档与 WebUI 界面语言为**中文**，代码标识符与日志字段为英文 | 你全程用中文沟通 | 要改得先做 i18n（§4 里明确不做）：`webui/src/i18n` + 重新引入 `general.locale`。那个键已从 schema 摘除 —— 留一个运行时不读的语言开关只会让人以为改了有用 |
| A3 | 默认角色为 **blocked**（纯白名单准入） | 需求写「用户/来源白名单」，白名单语义即默认拒绝 | `access.defaultUserRole/defaultChatRole` |
| A4 | `blocked` 主体的消息**不入库** | 避免为陌生人存储数据；也省磁盘 | `access.archiveBlocked=true` 可改为入库不响应 |
| A5 | 论坛 topic 默认**不隔离**（`scope='chat'`） | 你说「同一群聊共享一个上下文」 | `context.scope='thread'` |
| A6 | 命令消息（除 `/ask`）**不进上下文** | 避免 `/new`、`/ctx` 之类污染对话 | `commands.archiveToContext=true` |
| A7 | `ask_parent` 默认由 **low 档模型仲裁**应答，不打扰用户 → **已确认（2026-08-18）**：仲裁真的实现了，`agent.askArbiter` 与 `askTimeoutMs` 接线；**`askEscalateToUser` 仍是 🚧** —— 转人工要一条阻塞式人机通道（Telegram inline 选项 + 等人点 + 回灌给正在等的子 agent），那条通道整体不存在，和 inline keyboard 审批是同一个缺口 | 你选了「双向通信」但未定应答方式；转人工会破坏体验 | `agent.askArbiter=false` 退回「不仲裁」（工具直接走 default / 明说没人应答）。降级顺序：仲裁 → 调用方自带 `default` → `ask_parent_unanswered`，**任何一级都不伪造答复** |
| A8 | ~~子 agent 定义为**配置数据**（YAML + WebUI），不是 markdown 文件~~ → **已推翻（2026-08-18，§2 Q5）**：两种来源都支持。`agents/<name>.md`（frontmatter 写 model/tools/minRole，正文是 instructions）是**只读**来源，DB / WebUI 里的同名定义覆盖它，界面标出「来自文件」 | 你选了「SKILL.md + JS plugin」而非含 agent md 的选项；但文件定义可 git 版本化，且能直接复用 Claude Code 生态的现成定义 | 两个来源静默打架比只有一个来源糟得多 —— 优先级写死为「DB 赢」，不做成配置项 |
| A9 | 子 agent 默认**不注入**任何记忆 | 减少 token 与泄露面 | 每 agent 的 `injectMemory: true` |
| A10 | 记忆写入采用**结构化 markdown + 来源标注**，不是自由文本 | 去重、精确更新、可审计都依赖结构 | `memory.requireSourceTag=false` |
| A11 | 记忆自动压缩结果**默认需 owner 审阅**才应用 | 自动覆盖记忆风险高 | `memory.autoApplyCompaction=true` |
| A12 | 群聊里 `limited` 角色**不能写公开记忆**（`pubWriteMinRole=trusted`） | 你选了全局单份 PUBMEMORY，这是防污染的必要安全阀 | `memory.pubWriteMinRole='limited'` |
| A13 | 语音**不做 STT**，只归档 | 你在多模态里没选语音 | 加一个 `transcribe` 工具或 plugin |
| A14 | 图片长边归一化到 **1568px** | 主流 vision 模型的性价比拐点 | `media.maxImageEdge` |
| A15 | WebUI 只有**单一 owner 身份**，无多用户 RBAC → **已确认（2026-08-18，§2 Q7 定为确定不做）** | 你选了单密码方案 | 不再改动。这条同时是 A26 与 T5 成立的前提 |
| A16 | WebUI 默认只监听 **127.0.0.1** | 单密码 + owner 全权限，公网暴露风险太高 | `webui.host` + 自行前置 TLS |
| A17 | ~~定价表由 owner 手工维护，不自动抓取~~ → **已推翻**：定价与窗口/能力/思考档位从 models.dev 拉取并缓存到本地（[04 §5.4.1](./04-agents-and-providers.md#541-模型元数据目录modelsdev)）。外部数据源的依赖靠三点收敛：只在运维点「拉取模型」时才可能出网、拉不到就降级用旧缓存、出处不确定时**价格留空而不是猜** | 上游只给模型名，不给价格与能力，全手填在 6000+ 模型面前不现实 | `provider.catalog.enabled=false` 退回全手填 |
| A18 | 配额单位为 **USD**，无汇率转换 | 所有 provider 定价都是 USD | 加 `quota.fxRate` |
| A19 | FTS 用 **trigram** tokenizer → **已确认（2026-08-18，§2 Q3）**：不引入 jieba。`db.ftsTokenizer` 已从 schema 摘除 —— `0001_init.sql:30` 把 `tokenize='trigram'` 写在建表语句里，换 tokenizer 必须追加迁移重建 `messages_fts`，留一个换不了的开关是假开关 | SQLite 内置、对中文可用、零依赖；jieba 会引入第二个 native（node-gyp）依赖 | 真要换：追加一份重建 `messages_fts` 的迁移，而不是加配置项 |
| A20 | **单进程单实例**部署 | SQLite + 进程内锁的直接推论 | §2 Q1 已答（2026-08-18）：**现在不实现多实例，但保留将来迁移的可能性** —— 不删为此预留的抽象，且新代码不得引入新的进程内状态假设（清单见 [01 §3.1](./01-architecture.md)） |
| A21 | 工作目录按 **chat 隔离**（`data/workspace/<chatId>`） | 与「按 chat id 隔离」的整体原则一致 | 改为按 user 或全局共享 |
| A22 | 主/子 agent **共享**同一个 workspace | 便于子 agent 交付产物给主 agent | 子 agent 独立 workspace + 显式拷贝 |
| A23 | 「重任务」判定交给**模型自己**（提示词 + 步数护栏），不做前置分类器 | 分类器错判的体验代价高于收益 | 加一个 `low` 档前置分类步骤 |
| A24 | 取消时**丢弃**已生成内容（`commitPartial=false`） | 取消通常意味着「这轮不算」 | `cancel.commitPartial=true` |
| A25 | 流式输出已发出内容后失败，**仍提交** delta | 上下文必须与用户看到的一致 | 不建议改 |
| A26 | 审批只有 **owner** 能批 → **已确认（2026-08-18）** | 否则 trusted 用户可自批自己的高危命令；且 WebUI 只有一个 owner 身份（A15），裁决权没有能下放到发起人的落点 | **不再改动**：§2 Q7 已定为确定不做多用户，`approval.allowInitiator` 永久不再引入（该键已从 schema 摘除） |
| A27 | Plugin **进程内全信任**运行，无沙箱 → **已确认（2026-08-18，§2 Q6）** | Node 内做可靠的 JS 沙箱代价极高且不可靠（`vm` 不是安全边界） | 不再改动。真边界是「只装自己审过的」+ `plugins.enabled` 默认关 |
| A28 | MCP 默认全部**关闭**且 `minRole=trusted` | 第三方工具不可控 | `mcp.enabled` + 每 server 配置 |

---

## 2. 待确认问题 —— **2026-08-18 已全部答复**

Q1–Q12 从第一版起挂了九轮（`docs/25 §8` 记着「从未答复」），其中 Q3 / Q9 分别卡着
`db.ftsTokenizer` 与媒体自动过期两件实事。**2026-08-18 逐条拍板，结论如下。**
Q13 是同日新提的（「让模型能修改项目自身」），一并拍板。

| # | 问题 | 结论 | 落点 |
|---|---|---|---|
| Q1 | 多实例 | 现在不做，**保留将来迁移的可能性**（不删预留抽象） | [01 §3.1](./01-architecture.md) |
| Q2 | 向量语义检索 | **不做** | §4 |
| Q3 | jieba 分词 | **不做**，`db.ftsTokenizer` 从 schema 摘除 | A19 |
| Q4 | 定时 / 主动发言 | **要做**（已实现） | [02 §10](./02-context-engine.md#10-定时轮次的上下文归属) |
| Q5 | `agents/<name>.md` | **要做**，文件只读 / DB 覆盖赢 | A8 |
| Q6 | Plugin 隔离 | **保持 (a) 进程内全信任** | A27 |
| Q7 | WebUI 多用户 | **确定不做**，`allowInitiator` 永久关闭 | A15 / A26 |
| Q8 | `HarnessAgent` | **要做**，排 M11（三条子决策见下） | [12 · M11](./12-implementation-plan.md) |
| Q9 | 保留策略 | 媒体 **90 天**删文件留元数据；结构化数据永久 | `media.retentionDays` |
| Q10 | 回复引用触发消息 | **保持无条件引用**，不加配置键 | [08 §5.1](./08-telegram-adapter.md) |
| Q11 | ordinal 稀疏 | **接受**，零改动 | — |
| Q12 | 上下文导出 / 导入 | **都不做**，删掉文档里未实现的 `/ctx export` | [02 §7](./02-context-engine.md) |
| Q13 | 模型能不能给自己写工具 / 装扩展 | **要做**，四条通道全上，排 M12（四条子决策见下） | [07 §6](./07-skills-plugins-mcp.md) |

---

**Q1. 是否需要多实例 / 横向扩展？** → **已答复：现在不做，但保留可能性。**

现设计是单进程 + SQLite + 进程内 `KeyedMutex`。若未来要多实例，需把锁换成 DB advisory lock 或迁 Postgres（表结构基本兼容，FTS 换 `tsvector`/pgvector）。

原问题问的是「若确定永远单机，可以删掉一些为将来预留的抽象」。**决策是不删**：那些所谓的预留主要就是
Repository 层的 key 参数与 `KeyedMutex` 的键，而 T7 明写「隔离靠代码纪律，不是物理边界」，缓解手段
第一条就是 Repository 层的类型强制。为了「代码更简单」拆掉现存的隔离护栏，是拿真实的安全面换观感。

代价要说清楚：**这条约束无法自动化**。没有断言能挡住「又加了一个只在本进程可见的 Map」，
只能靠 [01 §3.1](./01-architecture.md) 那份清单在复审时逐条对。

**Q2. 聊天记录检索要不要加语义检索（向量）？** → **已答复：不做。**

现在只有 FTS 关键词检索。加向量检索需要：embedding provider、`message_embeddings` 表、增量索引任务、混合排序（BM25 + 余弦）。

成本不在钱（embedding 很便宜），在长期维护面：写入路径多一个外部依赖（provider 挂了是阻塞还是静默
丢索引？），加上增量索引任务与混合排序调参。而**不做的代价可逆** —— 消息都在库里，任何时候想加都能
离线重建索引。等积累出真实的漏检案例再重判。

**Q3. 中文分词是否需要 jieba 预分词？** → **已答复：不做，并摘掉 `db.ftsTokenizer`。**

trigram 能用，但对长句召回精度不如分词。jieba 方案：写入时分词存影子列，FTS 索引影子列。

实质不是「哪种分词更准」，是**要不要为它引入第二个 native 依赖** —— jieba 的 node 绑定要编译，会把
`pnpm install` 与 docker 镜像一起拖进 node-gyp 的世界，而现在整个项目只有 better-sqlite3 一个。

配套决定：`db.ftsTokenizer` **从 schema 摘除**。`0001_init.sql:30` 把 `tokenize='trigram'` 写死在建表
语句里，换 tokenizer 必须追加迁移重建 `messages_fts`，而迁移文件不可修改 —— 留着这个键的唯一效果是
让运维以为改一行配置就能换（`docs/25 §4.3` 的「假开关」判据）。

**Q4. 是否需要「定时/主动发言」能力？** → **已答复：要做。** 见下方四条决策与
[02 §9](./02-context-engine.md#10-定时轮次的上下文归属)。

原问题：现设计**完全被动**（只在被触发时发言）。若要「每天早上推送摘要」「检测到关键词主动提醒」，
需要一个 scheduler + 主动发言的上下文归属规则（主动发言算哪一轮？如何进上下文？）。

| # | 决策点 | 选定方案 |
|---|---|---|
| Q4-a | 触发时做什么 | **两种模式都支持**：`mode='agent'` 起一轮完整 agent 轮次（模型带该会话上下文执行任务描述）；`mode='notify'` 只把预写文本原样发出，**不调模型**。纯提醒不该被迫烧一次模型调用 |
| Q4-b | 上下文归属 | **照常进上下文**：任务描述作为一条 `user` 消息（`[定时任务 <名字>] <正文>`、`from_kind='system'`）落进 delta，产出照常 `commitTurn`。历史里就是一次正常对话，用户能直接接着这条回话。`notify` 也开轮提交 —— 否则模型下一轮不知道自己刚提醒过什么 |
| Q4-c | 停机补跑 | **不补跑**。一次性任务过期置 `done`，周期任务照排下一次，每条错过的记一条 `schedule.missed` warn。9 点补发一条 4 点的早报比不发更让人困惑，与 `telegram.dropPendingOnStart` 同一取舍 |
| Q4-d | 权限 | `schedule_create` / `schedule_list` / `schedule_cancel` 都是 `minRole=trusted`、`approval=never`、`scope=chat`。**工具参数里没有 chatId** —— 落点绑死本会话（[05 §8](./05-tools-and-permissions.md)）。触发时**重算有效角色**：降级到 trusted 以下跳过这一次，`blocked` 则整条停用 |

未做的部分照旧记在 §4：**关键词触发的主动提醒**（「检测到 X 就主动说」）不在本次范围内 ——
它要的是消息流上的常驻匹配器，跟定时器是两套机制。

**Q5. 子 agent 是否要支持 markdown 文件定义（`agents/<name>.md`）？** → **已答复：要做。**

md 文件定义（frontmatter 写 model/tools/minRole，正文是 instructions）对「不写代码就加子 agent」更友好，
可以 git 版本化，也能直接复用 Claude Code 生态里现成的定义。约 0.5 天。

| # | 决策点 | 选定方案 |
|---|---|---|
| Q5-a | 两个来源的优先级 | **文件是只读来源，DB / WebUI 的同名定义覆盖它**。优先级写死，不做成配置项 |
| Q5-b | 界面表现 | 每条带 `source`：`file`（只在文件里）/ `file-overridden`（两边都有，跑的是配置那份）/ `config`。**编辑不置灰** —— 在 WebUI 改一条文件定义 = 建一份配置覆盖，那正是 Q5-a 那条优先级规则该有的入口；置灰会让「DB 赢」在界面上根本用不上。删除分两种：纯文件定义删不掉（说清楚去删 .md），覆盖则删掉覆盖回到文件那份 |
| Q5-c | 加载失败 | 报错并记日志（`agent.file_invalid` error + stderr），**不静默跳过**。一个写错 frontmatter 的 agent 悄悄不存在，比启动失败更难查。**不为此中止启动**：一个 agent 写错不该让整个 bot 起不来（同 skills 的取舍） |
| Q5-d | 什么时候重扫 | 启动时 + 每次 `agent.agents` / `agent.agentsDir` 热更新时。**没有文件监听**（skills 有 `skills.watch`，这里没有对应键）：光改 .md 不会自动生效，要么动一次配置要么重启 |

**Q6. Plugin 是否需要真正的隔离？** → **已答复：保持 (a) 进程内全信任。**

可选方案：(a) 现状，进程内全信任（只装自己写的）；(b) `worker_threads` + 受限 API 表面；(c) 子进程 + RPC。

理由不是省事，是 **(b)/(c) 换不到真东西**：Node 里做可靠的 JS 沙箱是伪命题（`vm` 模块不是安全边界，
官方文档自己写着），worker 也拦不住 plugin 通过被授予的 API 面做坏事。而代价是确定的 —— 所有 hook
变成异步消息传递，`beforeSend` 这种「改一下文本再发」的同步语义要整个重写。

真边界仍是 T14 那句「只装自己审过的」+ `plugins.enabled` 默认关。

**Q7. WebUI 是否需要多用户 / 只读账号？** → **已答复：确定不做。**

现在是单 owner 全权限（A15）。做只读账号约 1 天（`sessions` 加 `role` 列 + API 层角色检查）。

不做的理由是连带面：一旦引入角色，**每一个 API 端点从此都要回答「这个角色能不能看」**，而收益是
「给朋友一个只能看用量的账号」这种边缘场景。配套结论：`approval.allowInitiator` **永久不再引入**
（A26），下一轮复审不必再重判。

**Q8. 是否需要接入 `HarnessAgent`（把 Claude Code / Codex 当子 agent）？** → **已答复：要做，排 M11。**

接进来意味着「在 Telegram 里让 Claude Code 改你的仓库」。

⚠️ **原问题的前提是错的**（这是 Q10 / Q12 之外的第三处）：它写着「AI SDK v7 提供了这个抽象」，
但 `ai@7.0.65` 里只有 `ToolLoopAgent`，没有任何 Harness 抽象。实现方式因此是**起一个外部 CLI
子进程**（`claude -p "<任务>"`），不是接一个 SDK 类。连带影响：**配额与记账接不上** —— 花的是
harness 自己的额度，本系统数不到它的 token；能复用的只有取消（abortSignal → SIGTERM）与日志。

**风险前提要写在前面**：T8 说 owner 宿主直跑代码已经等于完整机器权限；再挂一个能改仓库的 harness，
注入面就从「本系统的工具集」扩大到「另一个 agent 的整个工具集」，而那套工具不受 `available()` 注册期
fail-closed 与 `execute()` 二次硬拦截的约束。三条子决策就是为了把这个面收窄：

| # | 决策点 | 选定方案 |
|---|---|---|
| Q8-a | 谁能起、在哪起 | **仅 `owner` 且仅私聊**。群聊一律拒绝 —— 群里任何人的发言都是注入面，而 harness 能改仓库 |
| Q8-b | 工作目录边界 | **另配白名单目录**（新增配置键显式列出 harness 能动的仓库路径，不在名单里的一律拒）。**默认空 = 功能关闭**，不复用 `data/workspace/<chatId>`（那样就失去了「改你的仓库」这个初衷），也不允许任务里写任意路径 |
| Q8-c | 审批粒度 | **起 harness 这一个动作整体走一次审批**，批了之后它内部怎么跑不再逐条拦。诚实口径：本系统本来就看不见 harness 的内部工具调用，假装能逐条审批等于伪造一道门（`docs/16 §5`） |

**Q9. 消息保留策略？** → **已答复：媒体 90 天，结构化数据永久。**

原状况：`messages` 与 `context_messages` 永久保留，媒体文件只增不减 —— `maintenance.ts` 里那条注释
（「未决问题，替需求方决定不合适」）正是这条问题挂着的直接后果，所以 `gcFiles()` 至今只敢删孤儿。

| # | 对象 | 策略 |
|---|---|---|
| Q9-a | 媒体文件 | **90 天后删文件，保留 `attachments` 行与元数据**。历史消息里「[图片]」还在、上下文不塌，只是点不开。新增 `media.retentionDays`（默认 90，**0 = 不清**） |
| Q9-b | `messages` / `context_messages` | **永久**。纯文本每万条才 5–15MB，十年也压不垮 SQLite |
| Q9-c | `turns` / `tasks` | **永久**。它们是 trace 骨架（[03 §4](./03-data-model.md) 已写明），删了等于历史轮次凭空消失 |

**Q10. 群聊回复是否需要 `reply_to_message_id`？** → **已答复：保持无条件引用，不加配置键。**

⚠️ **原问题的前提是错的**：它写着「现设计直接发新消息」，但实际 `bot.ts` 在流式路径上无条件传
`message.message_id`，`TelegramOutput` 的流式与 `mode='once'` 两条路都带 `reply_parameters` ——
现状是**私聊也在引用**，且唯一不带的是「没配可用模型」那条字符串兜底路径。

决策：保持无条件引用，**不引入 `output.replyToTrigger`**；只把那条兜底路径补齐，让两条投递路径一致。
（这个键从来没进过 schema，本条不产生新配置项。）

**Q11. `/undo` 之后的 ordinal 不复用，长期会让 ordinal 稀疏。** → **已答复：接受，零改动。**

这是有意的：ordinal 只在提交时分配，不复用是为了不与并发 turn 抢号 —— 正是 D1 那套并发模型成立的
前提。「复用空洞」意味着分配前要回头查哪些号没被用，**把一个纯递增计数器变成需要加锁的分配器**，
拿真实的并发正确性风险换 WebUI 上不跳号的观感。64 位整数实际不可能耗尽。

**以后不要把它当 bug 报。**

**Q12. 是否需要「上下文导出/导入」用于迁移或调试？** → **已答复：都不做。**

⚠️ **原问题的前提也是错的**：它写着「`/ctx export` 只导出当前窗口」，但 `/ctx` 命令只回统计摘要 ——
`/ctx export` **从来没有实现过**，只是被写进了 [02](./02-context-engine.md) 的命令表。

决策：完整导出/导入不做（导入等于给上下文引擎开一个不受信入口，§9 那 22 条红线多一个防守面，而收益
几乎用不上）；**同时把命令表里那行未实现的 `/ctx export` 删掉**，消掉这处文档-实现不符。

---

**Q13. 模型能不能给自己写工具、给自己装 skill / MCP / plugin？** → **已答复：四条通道全做。**

起因是「让模型能修改项目自身」。查下来三条运行时通道（`SkillLoader.create/update`、
`PluginManager.reconcile`、`McpManager.reconcile`）本来就实现好了且不需要重启，**只是只有 WebUI
够得着** —— 模型侧一个入口都没有。所以这次做的不是新机制，是把已有机制接到模型手上，
再加一条新的（自定义工具）。

| # | 决策点 | 选定方案 |
|---|---|---|
| Q13-a | 范围 | 四件都做：自定义工具 / `write_skill` / `write_plugin` / `install_mcp` |
| Q13-b | MCP 的闸门放在哪 | **能装，但落地即禁用**：模型可以写入一条完整的 server 记录（含 command / url），`enabled` 强制 `false`，自己开不了。保住「给自己装上」这个语义，同时把「这条 argv 会以 bot 进程身份长期跑在沙箱之外」交给人过目 |
| Q13-c | 新写的自定义工具多久能用 | **默认要 owner 在 WebUI 点启用**，`tools.selfExtend.customTools.autoEnable` 可关掉这道闸。改正文或参数会重置为未启用 |
| Q13-d | 自定义工具的执行边界 | **与 `bash` 一视同仁** —— owner 命中 `sandbox.bypassRoles` 时就在宿主上跑。`requireSandbox` 这个键留着（打开后自定义工具严格弱于 bash），但默认关 |

Q13-c 那道闸是这套东西的**主闸**，不是审批。四个写工具虽然都标了 `approval: 'always'`，但
`approval.skipForOwner` 默认为 `true` 而它们又是 owner-only —— 对 owner 实际无感。审批档位在表里
是诚实的，并且给了运维一个真实的杠杆（关掉 `skipForOwner`），但别把它当成拦得住的那道门。

---

## 3. 已知取舍

> 由已定决策直接推导出的代价，需求方应知情。

| # | 取舍 | 来源决策 | 缓解 |
|---|---|---|---|
| T1 | **并发轮次的回答可能过时**：B 作答时看不到 A 的对话，但历史里 B 排在 A 之后。用户可能觉得 bot「答了个不相关的」 | D1（你明确选择） | `meta.rebased` 标记 + `rebase.injectNotice` 可开 + `concurrency.mode='serial'` 作为逃生舱 |
| T2 | **并发下背景消息的时间序可能被打乱**：A 认领了 1–10、B 认领了 11–12，若 B 先完成，日志里 11,12 会排在 1–10 之前 | D1 | 每条背景消息带真实时间前缀 `[张三 10:02]`，模型仍能判断实际先后；实践中并发窗口只有几秒 |
| T3 | **失败/取消的轮次会「吃掉」它认领的背景消息**：水位不回退，这批消息永远不会进上下文 | D1 的原子认领要求 | 消息仍在归档中，`search_messages` / `read_messages` 可检索；可考虑将来做「未消费队列」 |
| T4 | **群 A 的公开记忆会流到群 B 和所有私聊** | D12（你明确选择全局单份） | `pubWriteMinRole=trusted` + 来源标注 + WebUI 可审查回滚 + `pubWriteRequiresApproval` 可开 |
| T5 | **owner 能读所有人的私有记忆** | D11（你明确选择） | 每次读取记 warn 日志 + 在该用户记忆页显示「最近被 owner 查看」 |
| T6 | **背景消息进上下文 ⇒ token 成本明显上升**：活跃群里每轮可能多几千 token | D6（你明确选择） | `background.maxPerTurn` 可调（你已要求做成配置项）+ prompt cache 抵消一部分 + 轮后裁剪兜住上限 |
| T7 | **单库单文件 ⇒ 隔离靠代码纪律，不是物理边界** | D7 | Repository 层类型强制 + 跨会话白名单 + CI 的 SQL 扫描测试（AC-DB-003） |
| T8 | **owner 宿主直跑代码 = 完整机器权限**。任何能让 owner 的轮次执行工具的注入路径都是完整的机器沦陷 | D10（你明确选择） | owner 在非受信群里角色被抿平为群角色（D9 的取交集正是为此）；`allowHostFsForOwner` 默认关；高危命令仍走审批 |
| T9 | **jail 模式不是安全边界** | D10 的 mode 选项 | 文档与 WebUI 明确警示；默认推荐 docker |
| T10 | **流式编辑会消耗大量 Bot API 调用**：一条长回复可能编辑 20+ 次 | D18 | 节流 1.5s + 最小增量 24 字符 + 429 时跳过；`output.mode='once'` 可关 |
| T11 | **`prepareStep` 每 step 重算工具集 ⇒ 工具描述 token 每 step 都发一遍**，而 TOOL CATALOG 块与 provider 的 tools 数组里那两份描述是重复的 | 安全需要 | **目录按需暴露**（`tools.catalog.*`，[05 §3.12](./05-tools-and-permissions.md) / [07 §5](./07-skills-plugins-mcp.md#5-三者的统一注册流程)）：默认只下发常驻集，外部工具折叠成每组一行、靠 `search_tools` 检索展开；外加目录块去重（`residentDescriptions`）把重复的那一份摘掉。prompt cache 与 `tools.maxRegistered` **退居兜底** —— 前者只在前缀不分叉时有效，后者是静默截断（截断本身现在会在 RUNTIME 块告知，见 `AC-TOOL-020`）|
| T12 | **子 agent 摘要回灌 ⇒ 主 agent 看不到细节**，可能重复提问或误解 | AI SDK subagent 模式 + 上下文预算 | `read_agent_result` 可按需读全文；`resultMaxChars` 可调 |
| T13 | **AI SDK v7 是较新的 API 表面**，升级可能有破坏性变更 | D20 | 锁 `^7`；升级前跑 AC-AGENT-* 与 AC-CTX-* 全集；provider 与 agent 装配集中在两个文件里，替换成本可控 |
| T14 | **Plugin 全信任 ⇒ 安装第三方 plugin 等于给 root** | A27 | 默认禁用 + 启用时二次确认 + 只装自己审过的 |
| T15 | **配额是「事后记账 + 事前预留估算」**，估算不准时可能小幅超支 | 成本只能在调用后才准确知道 | `perTurn.maxCostUsd` 硬止损 + `minReserveUsd` 缓冲 + 安全系数 1.5 |
| T16 | **90 天前的图片/文件点不开了**：`attachments` 行还在、正文里的「[图片]」还在，但磁盘上的文件已删 | §2 Q9-a | `media.retentionDays=0` 可整个关掉；删的是文件不是行，所以上下文与检索结果都不塌 |
| T17 | **HarnessAgent 内部的工具调用不受本系统的权限模型约束**：`available()` 注册期 fail-closed 与 `execute()` 二次硬拦截都看不见它 | §2 Q8-c（审批粒度定在「起 harness」这一层） | 准入收到最窄（仅 owner + 仅私聊）+ 目录白名单默认空 + 起 harness 走审批。**这三道是全部的门**，不要以为里面还有第四道 |
| T18 | **授权时点与执行时点是分离的**：模型调 `bash` 时命令正文在转录里、在 span 里、在人眼前；调 `custom_backup` 时提示词里只有 `{"target":"/etc"}`，正文是若干轮之前写下的，可能在另一个会话、可能是在一段注入的影响下写的。**审计面从转录挪进了 SQLite，而 SQLite 不在提示词里** | §2 Q13 | 落库即禁用 + 改正文即重置 + `definition_hash` 挡轮内改写 + `tool.custom_defined` / `webui.action`（启用记 warn）两条日志 + 扩展页可随时读回正文 |
| T19 | **`requireSandbox` 默认关 ⇒ 自定义工具就是调用者的 `bash`**。owner 命中 `bypassRoles` 时脚本在宿主上跑，因而能直接写 `data/luoli.db` —— `tools.fs.denyGlobs` 只被 `PathJail` 执行，沙箱不看它，所以启用闸对一段**已经在宿主上跑起来的脚本**是无效的 | §2 Q13-d（需求方明确选择与 bash 一视同仁） | 启用闸防的是「只有工具的模型」，不防已经拿到宿主执行的脚本。想要真边界就打开 `tools.selfExtend.customTools.requireSandbox`，此时自定义工具严格弱于 bash。**角色地板 + 沙箱判据 + 会话作用域 + 启用闸，这四道就是全部的门**，不要以为脚本跑起来之后还有第五道 |
| T20 | **折叠的工具模型不知其详 ⇒ 它可能想不到去检索**。折叠行只给名字，一台 MCP server 到底能干什么要检索一次才看得见；而检索是**多一跳** —— 多一个 step、多一对留在上下文里的 tool-call/result，以及本轮剩余步骤的缓存前缀作废（[04 §2.1](./04-agents-and-providers.md#21-prompt-缓存)）。最坏形态是模型答「我没有这个功能」，而那个工具就躺在折叠组里 | T11 的缓解（目录按需暴露） | 四层，缺一层就是一次「答我没有」：① 提示词引导恒有**两处**：KERNEL 那句无条件在，另一处随 `prompt.includeToolCatalog` 二选一 —— 目录开着时是折叠组行里内嵌的 `search_tools` 指引，目录关掉时是 RUNTIME 的折叠计数后缀（那个后缀挂在 `show.toolNames` 上，而 `show.toolNames = !includeToolCatalog`，[06 §1.2](./06-prompt-and-memory.md#12-block-6-runtime-模板)）。所以「三处同时在」是做不到的，也不必要：任一档下都有一处告诉模型有东西可取、一处告诉它怎么取；② `repairToolCall` 兜底：直接调折叠工具会被自动改写成一次检索（[05 §3.12](./05-tools-and-permissions.md)），所以模型不必先学会用 `search_tools`；③ `names` 通道让跨轮重展开只花一次调用；④ `tools.catalog.deferExternal: false` 是随时可退的逃生舱，退回去 block 3 与 RUNTIME 逐字节回到原样（KERNEL 那句引导语留着空转，见 [05 §3.12](./05-tools-and-permissions.md) 不变量 3） |

---

## 4. 明确不做（第一版范围外）

| 项 | 理由 |
|---|---|
| 语音转录（STT）/ 语音回复（TTS） | D16 未选；可作为 plugin 追加 |
| 图片生成 | 需求未提 |
| 多实例 / 分布式 | A20；SQLite + 进程内锁。§2 Q1 已答：**现在不做，但保留将来迁移的可能性** —— 预留抽象不删，新代码不得引入新的进程内状态假设 |
| Postgres 支持 | 第一版 SQLite 足够；schema 设计已尽量兼容 |
| 向量语义检索 | §2 Q2 **确定不做**（2026-08-18）。不做的代价可逆：消息都在库里，任何时候都能离线重建索引 |
| ~~主动发言 / 定时任务~~ | **已实现**：§2 Q4 已答复，见 [02 §9](./02-context-engine.md#10-定时轮次的上下文归属) 与 [05 §3.8](./05-tools-and-permissions.md) |
| 关键词触发的主动提醒 | §2 Q4 只覆盖了定时那一半。「检测到 X 就主动说」要在消息流上挂常驻匹配器，跟定时器不是一套机制 |
| WebUI 多用户 RBAC | §2 Q7 **确定不做**（2026-08-18）。连带：`approval.allowInitiator` 永久不再引入 |
| `WorkflowAgent` | 编排在自己的 `TurnRunner` 里，语义更强（[04 §6](./04-agents-and-providers.md#6-workflowagent-harnessagent-的取舍)） |
| ~~`HarnessAgent`（Claude Code 子 agent）~~ | **已移出本表**：§2 Q8 定为**要做**，排 [M11](./12-implementation-plan.md)。准入 = 仅 owner 且仅私聊，目录限白名单（默认空 = 关闭），起 harness 整体走一次审批 |
| 上下文分支 DAG（保留多分支 + merge） | D1 选了线性 rebase；数据模型（`parent_id`）已为将来预留 |
| 每群独立 PUBMEMORY | D12 选了全局单份；数据模型（`memory_docs.subject`）已预留 |
| Telegram Business / Stars / 支付 | 需求未提 |
| 频道（channel）支持 | `trigger.channels` 默认 false，未做完整验证 |
| i18n 多语言界面 | 第一版只有 zh-CN。**结构并没有预留** —— 原文写的 `i18n/` 目录从来没存在过，文案就在各 SFC 里（改写工具见 [`docs/copy/README.md`](./copy/README.md)）。真做时要连 `general.locale` 一起加回来 |
