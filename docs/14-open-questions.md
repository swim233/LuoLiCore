# 14 · 未确认项、默认假设与已知取舍

**这份文档现在的性质是决策存档 + 取舍凭据，不是待办清单。** §2 的 Q1–Q13 已全部答复且全部落地
（Q1–Q12 于 2026-08-18 逐条拍板，Q13 同日提出、随 M12 落地），完整论证一律在「落点」那一列指的地方，
本文只留结论与指针 —— 同一段论证抄在两处，改的时候就会只改一处。

**编号（`A*` / `T*` / `Q*` 含 `Q8-c` 这类子号）一个都不许删、不许重编。** 源码注释拿它们当「这行代码
为什么长这样」的凭据（`A27`、`T17`、`A15`、`T19`、`A7` 都被多处引用），而 `tests/docs.test.ts` 的条目
判据只认带连字符的复审编号，**挡不住这份文档**。

四节：**§1 默认假设**（未逐条确认，与预期不符就改「若要改动」那一列指的那一处）、**§2 已答复的问题**、
**§3 已知取舍**（由已定决策直接推导出的代价）、**§4 明确不做（第一版范围外）**。

---

## 1. 默认假设（未逐条确认，可随时推翻）

| # | 假设 | 若要改动 |
|---|---|---|
| A1 | Telegram 接入默认**长轮询**，Webhook 作为配置项（无需公网 HTTPS） | `telegram.mode` |
| A2 | 文档与 WebUI 界面语言为**中文**，代码标识符与日志字段为英文 | 先做 i18n（§4 里明确不做）：`webui/src/i18n` + 重新引入已摘除的 `general.locale`。留一个运行时不读的语言开关只会让人以为改了有用 |
| A3 | 默认角色为 **blocked**（纯白名单准入，白名单语义即默认拒绝）。2026-08-30 把会话角色从上限翻成下限之后这条**不变** —— `blocked` 是任一侧一票否决且先于抬升判定，所以 `defaultChatRole=blocked` 仍表示「未登记的群整群静默」 | `access.defaultUserRole` / `defaultChatRole`。⚠ 抬 `defaultChatRole` 是抬**下限**：设成 `trusted` 等于把每个未被单独拉黑的成员在任何未登记的群里都抬到 `trusted` |
| A4 | `blocked` 主体的消息**不入库** | `access.archiveBlocked=true` 改为入库不响应 |
| A5 | 论坛 topic 默认**不隔离**（`scope='chat'`，同一群聊共享一个上下文） | `context.scope='thread'` |
| A6 | 命令消息（除 `/ask`）**不进上下文** —— 避免 `/new`、`/ctx` 之类污染对话 | `commands.archiveToContext=true` |
| A7 | `ask_parent` 由 **low 档模型仲裁**应答，不打扰用户。**已实现**（`agent.askArbiter` / `askTimeoutMs` 接线）：降级顺序是 仲裁 → 调用方自带 `default` → `ask_parent_unanswered`，**任何一级都不伪造答复**。转人工（`askEscalateToUser`）**仍未实现**：阻塞式人机通道本身已落地（`PendingPrompts` + `TelegramPromptChannel`，[05 §6.1](./05-tools-and-permissions.md)，inline keyboard 审批就跑在它上面），欠的是三条语义 —— 问谁（worker 的发起人还是 owner）、选项从哪儿来（自由文本 vs 固定选项）、等人期间那个 worker 占着的并发槽与 `askTimeoutMs` 怎么算 | `agent.askArbiter=false` 退回「不仲裁」（工具直接走 `default` / 明说没人应答）；`askEscalateToUser` 的当前态记在 [11 §2.0.1](./11-config-reference.md) |
| A8 | 子 agent 定义**两种来源都支持**：`agents/<name>.md`（frontmatter 写 model/tools/minRole，正文是 instructions）是**只读**来源，DB / WebUI 里的同名定义覆盖它，界面标出「来自文件」 | ⚠ **2026-08-30 整条作废**：两来源的定义体系整个删除 —— `agent.agents[]`、`agent.agentsDir`、`agents/<name>.md`、`packages/core/src/agent/definitions.ts`、`list_agents` 工具、WebUI 的「子 Agent」页与 `GET /api/agents` 一并摘掉。worker 只剩**一种**：内建的 lw-worker，没有定义、没有 per-agent 的 `minRole` / 工具白名单 / `instructions`，拿的是**调用者有效角色下的全集**（[04 §1](./04-agents-and-providers.md)、[05 §4](./05-tools-and-permissions.md)）。原来那句「优先级写死为 DB 赢、不做成配置项」现在无处可落 —— 一个来源都没有了，也就不存在打架。子决策见 §2 Q5 那一格的作废记录 |
| A9 | 子 agent 默认**不注入**任何记忆（减少 token 与泄露面） | ⚠ **2026-08-30 · 那个逃生舱随 A8 一并删除，而它从来没有被读过**：`injectMemory` 从进 schema 到被删，`runSubAgent` 一次都没有读过它 —— 写 `true` 与写 `false` 的产出逐字节相同，整轮里它是个假开关。**假设本身仍然成立**，只是现在没有开关：lw-worker 的 instructions 里一个记忆字节都没有（[04 §3.3](./04-agents-and-providers.md)、[06 §3.1](./06-prompt-and-memory.md)）。真要注入得新开一条路，而那条路要先回答「worker 看不到对话，凭什么它该看到记忆」 |
| A10 | 记忆写入采用**结构化 markdown + 来源标注**，不是自由文本 —— 去重、精确更新、可审计都依赖结构 | `memory.requireSourceTag=false`（关掉省 token，代价是「这条是谁在哪说的」再也查不回来） |
| A11 | 记忆自动压缩结果**默认需 owner 审阅**才应用 | `memory.autoApplyCompaction=true` |
| A12 | 群聊里 `limited` 角色**不能写公开记忆**（`pubWriteMinRole=trusted`）—— 全局单份 PUBMEMORY 下这是防污染的必要安全阀 | `memory.pubWriteMinRole='limited'` |
| A13 | 语音**不做 STT**，只归档（多模态里没选语音） | 加一个 `transcribe` 工具或 plugin |
| A14 | 图片长边归一化到 **1568px**（主流 vision 模型的性价比拐点） | `media.maxImageEdge` |
| A15 | WebUI 只有**单一 owner 身份**，无多用户 RBAC —— §2 Q7 已定为**确定不做** | **不再改动**。这条同时是 A26 与 T5 成立的前提 |
| A16 | WebUI 默认只监听 **127.0.0.1**（单密码 + owner 全权限，公网暴露风险太高） | `webui.host` + 自行前置 TLS |
| A17 | 定价与窗口 / 能力 / 思考档位**从 models.dev 拉取**并缓存到本地（[04 §5.4.1](./04-agents-and-providers.md#541-模型元数据目录modelsdev)）。外部数据源靠三点收敛：只在运维点「拉取模型」时才可能出网、拉不到就降级用旧缓存、出处不确定时**价格留空而不是猜** | `provider.catalog.enabled=false` 退回全手填（6000+ 模型面前不现实） |
| A18 | 配额单位为 **USD**，无汇率转换 | 加 `quota.fxRate` |
| A19 | FTS 用 **trigram** tokenizer，不引入 jieba（§2 Q3）。`db.ftsTokenizer` 已从 schema 摘除 —— `0001_init.sql:30` 把 `tokenize='trigram'` 写在建表语句里，换 tokenizer 必须追加迁移重建 `messages_fts`，留一个换不了的开关是假开关 | 真要换：追加一份重建 `messages_fts` 的迁移，而不是加配置项 |
| A20 | **单进程单实例**部署（SQLite + 进程内锁的直接推论） | §2 Q1：现在不实现多实例，但**保留将来迁移的可能性** —— 预留抽象不删，新代码不得引入新的进程内状态假设（清单见 [01 §3.1](./01-architecture.md)） |
| A21 | 工作目录按 **chat 隔离**（`data/workspace/<chatId>`） | 改为按 user 或全局共享 |
| A22 | 主 / 子 agent **共享**同一个 workspace（便于交付产物） | lw-worker 独立 workspace + 显式拷贝。⚠ **2026-08-30 · 这条现在要分 worker 种类说**：对 **lw-worker 仍然成立** —— 它与主 agent 共用 `data/workspace/<chatId>`，`PathJail` 也是同一个。对 **harness / ACP 不成立** —— `dir` 缺省时它们各跑在 `<sandbox.workspaceDir>/<chatId>/harness/<runId>` 这个每次 run 新建的子目录里（§2 Q8-b 的部分推翻记录），显式给 `dir` 时更是跑在白名单目录里、与 workspace 无关。产物要交回来得自己拷 |
| A23 | 「重任务」判定交给**模型自己**（提示词 + 步数护栏），不做前置分类器 —— 分类器错判的体验代价高于收益 | 加一个 `low` 档前置分类步骤 |
| A24 | 取消时**丢弃**已生成内容（`commitPartial=false`）—— 取消通常意味着「这轮不算」 | `cancel.commitPartial=true` |
| A25 | 流式输出已发出内容后失败，**仍提交** delta —— 上下文必须与用户看到的一致 | 不建议改 |
| A26 | 审批只有 **owner** 能批 —— 否则 trusted 用户可自批自己的高危命令；且 WebUI 只有一个 owner 身份（A15），裁决权没有能下放到发起人的落点 | **不再改动**：§2 Q7 已定为确定不做多用户，`approval.allowInitiator` 永久不再引入（键已从 schema 摘除） |
| A27 | Plugin **进程内全信任**运行，无沙箱（§2 Q6）—— Node 里做可靠的 JS 沙箱代价极高且不可靠（`vm` 不是安全边界，官方文档自己写着） | 不再改动。真边界是「只装自己审过的」+ `plugins.enabled` 默认关（T14） |
| A28 | MCP 默认全部**关闭**且 `minRole=trusted`（第三方工具不可控） | `mcp.enabled` + 每 server 配置 |

---

## 2. 已答复的问题（Q1–Q13）

Q1–Q12 从第一版起挂了九轮（`docs/25 §8` 记着「从未答复」），其中 Q3 / Q9 分别卡着 `db.ftsTokenizer`
与媒体自动过期两件实事；**2026-08-18 逐条拍板**，Q13 同日新提、一并拍板。**这一节没有一条待确认** ——
留着编号是因为落点文档与源码注释拿它当出处引。子决策（`Q4-a`…`Q13-d`）并进了各自那一格。

⚠ **已落地不等于至今成立**：`Q5` 整条、`Q8-b` 的中间那半已被后来的决策推翻。**原结论一字不改**，推翻记录追加在同一格里（体例同 §3 的 `T9`）—— 读到一格结论时先看完它，不要只读前半句。

| # | 问题 | 结论 | 落点 |
|---|---|---|---|
| Q1 | 多实例 | 现在不做，**保留将来迁移的可能性**：预留的就是 Repository 层的 key 参数与 `KeyedMutex` 的键，而 T7 明写「隔离靠代码纪律，不是物理边界」—— 为了「代码更简单」拆掉现存隔离护栏是拿真实的安全面换观感。代价说清楚：**这条约束无法自动化**，只能对着清单在复审时逐条对 | [01 §3.1](./01-architecture.md) |
| Q2 | 向量语义检索 | **不做**。成本不在钱（embedding 很便宜），在长期维护面：写入路径多一个外部依赖 + 增量索引任务 + 混合排序调参。而不做的代价**可逆** —— 消息都在库里，任何时候都能离线重建索引 | §4 |
| Q3 | jieba 分词 | **不做**：实质不是「哪种分词更准」，是要不要为它引入第二个 native（node-gyp）依赖 —— 现在整个项目只有 better-sqlite3 一个。配套把 `db.ftsTokenizer` 从 schema 摘除 | A19 |
| Q4 | 定时 / 主动发言 | **要做**，已实现。`Q4-a` 两种模式都支持：`mode='agent'` 起一轮完整 agent 轮次、`mode='notify'` 只把预写文本原样发出**不调模型**；`Q4-b` **照常进上下文**（任务描述作为一条 `from_kind='system'` 的 user 消息落 delta，`notify` 也开轮提交 —— 否则模型下一轮不知道自己刚提醒过什么）；`Q4-c` 停机**不补跑**，每条错过记一条 `schedule.missed` warn（9 点补发 4 点的早报比不发更让人困惑）；`Q4-d` 三个工具都是 `minRole=trusted` / `approval=never` / `scope=chat`，**参数里没有 chatId**（落点绑死本会话），触发时**重算有效角色** | [02 §10](./02-context-engine.md#10-定时轮次的上下文归属) · [05 §3.8](./05-tools-and-permissions.md) |
| Q5 | `agents/<name>.md` | **要做**。`Q5-a` 文件是只读来源，DB / WebUI 的同名定义覆盖它，优先级写死不做配置项；`Q5-b` 每条带 `source`（`file` / `file-overridden` / `config`），**编辑不置灰**（在 WebUI 改一条文件定义 = 建一份覆盖，置灰会让「DB 赢」在界面上根本用不上），纯文件定义删不掉、覆盖则删回文件那份；`Q5-c` 加载失败报错并记 `agent.file_invalid`，**不静默跳过**也**不为此中止启动**；`Q5-d` 启动时 + `agent.agents` / `agentsDir` 热更新时重扫，**没有文件监听**。<br>⚠ **2026-08-30 整条作废**：`agents/<name>.md` 这条来源随两来源定义体系一并删除（A8），Q5-a…Q5-d 四条子决策各自失去指代对象 —— 没有文件来源就没有覆盖优先级（a）、没有 `source` 三档（b）、没有要重扫的目录（d）；`agent.file_invalid` 这个日志 kind 也已从取值域里摘掉（c）。worker 只剩内建的一种，落点见 A8 与 [04 §1](./04-agents-and-providers.md) | [04](./04-agents-and-providers.md) · A8 |
| Q6 | Plugin 隔离 | **保持 (a) 进程内全信任**。不是省事：`worker_threads` / 子进程 RPC 换不到真东西（拦不住 plugin 用被授予的 API 面做坏事），代价却是确定的 —— 所有 hook 变成异步消息传递，`beforeSend` 那种同步语义要整个重写 | A27 · T14 |
| Q7 | WebUI 多用户 | **确定不做**。不做的理由是连带面：一旦引入角色，**每一个 API 端点从此都要回答「这个角色能不能看」**，而收益是「给朋友一个只能看用量的账号」这种边缘场景。配套：`approval.allowInitiator` 永久不再引入 | A15 · A26 |
| Q8 | `HarnessAgent` | **要做**（M11；M13 的 ACP 是同一条路，只是走协议不走 argv）。⚠ 原问题的前提是错的：`ai@7` 里只有 `ToolLoopAgent`，没有任何 Harness 抽象 —— 实现是起一个外部 CLI 子进程，连带**配额与记账接不上**（花的是 harness 自己的额度）。三条子决策就是为了收窄注入面（T8 说 owner 宿主直跑已等于完整机器权限）：`Q8-a` **仅 `owner` 且仅私聊**，群聊一律拒绝；`Q8-b` **另配白名单目录**、**默认空 = 功能关闭**，不复用 `data/workspace/<chatId>`，也不允许任务里写任意路径〔⚠ **2026-08-30 · 三半里只有中间那半被推翻**：`spawn_harness` / `spawn_acp` 的 `dir` 变可选，缺省落在 `<sandbox.workspaceDir>/<chatId>/harness/<runId>` —— 也就是**复用了** `data/workspace/<chatId>` 那棵树，只是一个 run 一个新目录、彼此不复用。另两半原样成立：白名单仍是白名单（越界的显式 `dir` 照旧当场拒），任务正文仍不许写任意路径。**而「默认空 = 功能关闭」这一半的成立方式变了** —— 现在是「`allowedDirs` 为空 **且** `agent.harness.workspaceFallback` / `agent.acp.workspaceFallback` 为关（出厂 `false`）」两个条件同时成立才是整体关闭；只看 `allowedDirs` 为空就断定功能关着，在开了 fallback 的部署上是错的。门的数目与性质未变，见 T17〕；`Q8-c` **起 harness 这一个动作整体走一次审批**，批了之后内部不再逐条拦 —— ACP 让「看得见每一次 `tool_call`」和「逐条拦」第一次真的做得到，但那是**建好了留着的机器，不是默认生效的门**，默认值仍是本条答复的语义（`agent.acp.permissionMode` / `agents[].approvalMode` 的当前默认值**只以 [05 §3.5.1](./05-tools-and-permissions.md) 为准**，别在这里复述 —— 它是会变的值，多一份拷贝就多一个漂移点） | [05 §3.5](./05-tools-and-permissions.md) · T17 |
| Q9 | 保留策略 | `Q9-a` 媒体文件 **90 天后删文件、保留 `attachments` 行与元数据**（`media.retentionDays`，默认 90，**0 = 不清**）：历史消息里的「[图片]」还在、上下文不塌，只是点不开；`Q9-b` `messages` / `context_messages` **永久**（纯文本每万条才 5–15MB）；`Q9-c` `turns` / `tasks` **永久** —— 它们是 trace 骨架，删了等于历史轮次凭空消失 | [03 §4](./03-data-model.md) · T16 |
| Q10 | 回复引用触发消息 | **保持无条件引用**，不引入 `output.replyToTrigger`（该键从未进过 schema）。⚠ 原问题的前提是错的：流式与 `mode='once'` 两条路本来就带 `reply_parameters`，私聊也在引用；只补齐了「没配可用模型」那条字符串兜底路径 | [08 §5.1](./08-telegram-adapter.md) |
| Q11 | ordinal 稀疏 | **接受，零改动**。ordinal 只在提交时分配、不复用，正是 D1 那套并发模型成立的前提；「复用空洞」意味着把一个纯递增计数器变成需要加锁的分配器，拿真实的并发正确性风险换 WebUI 上不跳号的观感。64 位整数实际不可能耗尽。**以后不要把它当 bug 报** | — |
| Q12 | 上下文导出 / 导入 | **都不做**：导入等于给上下文引擎开一个不受信入口（§9 那 22 条红线多一个防守面），收益几乎用不上。⚠ 原问题的前提也是错的：`/ctx export` **从来没有实现过**，只是被写进了命令表 —— 那一行已删掉 | [02 §7](./02-context-engine.md) |
| Q13 | 模型给自己写工具 / 装扩展 | **四条通道全做**（M12）。三条运行时通道本来就实现好了，只是**只有 WebUI 够得着** —— 这次做的不是新机制，是把已有机制接到模型手上。`Q13-a` 自定义工具 / `write_skill` / `write_plugin` / `install_mcp` 四件都做；`Q13-b` MCP **能装但落地即禁用**（`enabled` 强制 `false`，保住「给自己装上」的语义，把「这条 argv 会以 bot 进程身份长期跑在沙箱之外」交给人过目）；`Q13-c` 新写的自定义工具**默认要 owner 在 WebUI 点启用**（`tools.selfExtend.customTools.autoEnable` 可关，改正文或参数会重置）—— **这道闸是主闸，不是审批**：四个写工具虽标 `approval:'always'`，但 `approval.skipForOwner` 默认 `true` 而它们又是 owner-only，对 owner 实际无感；`Q13-d` 自定义工具**与 `bash` 一视同仁**，`requireSandbox` 留着但默认关 | [07 §6](./07-skills-plugins-mcp.md) · T18 · T19 |

Q1–Q13 之外没覆盖到的两件事各有去处：**关键词触发的主动提醒**（Q4 只覆盖了定时那一半）在 §4；
`trigger.ignoreEditedAsTrigger` 不在这十三条里，当前态见 [11 §2.0.1](./11-config-reference.md)。

---

## 3. 已知取舍

> 由已定决策直接推导出的代价，需求方应知情。**这一节整节是凭据层**：`T*` 编号被源码注释大量引用，不得重编号或删除。

| # | 取舍 | 来源决策 | 缓解 |
|---|---|---|---|
| T1 | **并发轮次的回答可能过时**：B 作答时看不到 A 的对话，但历史里 B 排在 A 之后。用户可能觉得 bot「答了个不相关的」 | D1（你明确选择） | `meta.rebased` 标记 + `rebase.injectNotice` 可开 + `concurrency.mode='serial'` 作为逃生舱 |
| T2 | **并发下背景消息的时间序可能被打乱**：A 认领了 1–10、B 认领了 11–12，若 B 先完成，日志里 11,12 会排在 1–10 之前 | D1 | 每条背景消息带真实时间前缀 `[张三 10:02]`，模型仍能判断实际先后；实践中并发窗口只有几秒 |
| T3 | **失败/取消的轮次会「吃掉」它认领的背景消息**：水位不回退，这批消息永远不会进上下文 | D1 的原子认领要求 | 消息仍在归档中，`search_messages` / `read_messages` 可检索；可考虑将来做「未消费队列」 |
| T4 | **群 A 的公开记忆会流到群 B 和所有私聊** | D12（你明确选择全局单份） | `pubWriteMinRole=trusted` + 来源标注 + WebUI 可审查回滚 + `pubWriteRequiresApproval` 可开 |
| T5 | **owner 能读所有人的私有记忆** | D11（你明确选择） | 每次读取记 warn 日志 + 在该用户记忆页显示「最近被 owner 查看」 |
| T6 | **背景消息进上下文 ⇒ token 成本明显上升**：活跃群里每轮可能多几千 token | D6（你明确选择） | `background.maxPerTurn` 可调（你已要求做成配置项）+ prompt cache 抵消一部分 + 轮后裁剪兜住上限 |
| T7 | **单库单文件 ⇒ 隔离靠代码纪律，不是物理边界** | D7 | Repository 层类型强制 + 跨会话白名单 + CI 的 SQL 扫描测试（AC-DB-003） |
| T8 | **owner 宿主直跑代码 = 完整机器权限**。任何能让 owner 的轮次执行工具的注入路径都是完整的机器沦陷 | D10（你明确选择） | **owner 只在私聊成立**：群 / 频道里的有效角色一律封顶 `trusted`（D9，2026-08-30 拍板），`effectiveRole === 'owner'` ⟹ `isPrivate` —— 群里的发言是任何人都能写的文本，够不着 owner 档的宿主直跑；`allowHostFsForOwner` 默认关；高危命令仍走审批 |
| T9 | **已随 `sandbox.mode` 的 `jail` 档一起摘除**（commit `99a87c8`）：只剩 `none \| docker` | D10 的 mode 选项 | 「看起来像隔离、实际不是隔离」这个选项本身就是风险来源；真隔离只有 docker 一档，`none` 是 fail-closed 而不是「弱隔离」 |
| T10 | **流式编辑会消耗大量 Bot API 调用**：一条长回复可能编辑 20+ 次 | D18 | 节流 1.5s + 最小增量 24 字符 + 429 时跳过；`output.mode='once'` 可关 |
| T11 | **`prepareStep` 每 step 重算工具集 ⇒ 工具描述 token 每 step 都发一遍**，而 TOOL CATALOG 块与 provider 的 tools 数组里那两份描述是重复的 | 安全需要 | **目录按需暴露**（`tools.catalog.*`，[05 §3.12](./05-tools-and-permissions.md) / [07 §5](./07-skills-plugins-mcp.md#5-三者的统一注册流程)）：默认只下发常驻集，外部工具折叠成每组一行、靠 `search_tools` 检索展开；外加目录块去重（`residentDescriptions`）把重复的那一份摘掉。prompt cache 与 `tools.maxRegistered` **退居兜底** —— 前者只在前缀不分叉时有效，后者是静默截断（截断本身现在会在 RUNTIME 块告知，见 `AC-TOOL-020`）|
| T12 | **worker 摘要回灌 ⇒ 主 agent 看不到细节**，可能重复提问或误解 | worker 拓扑 + 上下文预算 | `spawn_worker` 的 `resultMode: 'full'` 可以**事前**要全文（不再只能事后 `read_worker_result`），上界是 `agent.worker.maxResultChars`；`summary` 档按 `resultMaxChars` 截断并附 `agentresult://<runId>` 句柄，`read_worker_result` 分页读。⚠ **但 `full` 档并没有解决这一条，最容易被误读的正是这里**：回灌进去的仍然是一条**工具结果**，level 1 降级照旧把 `tool-result` 的 output **整体**换成 `[已省略工具结果]`（`packages/db/src/context.ts` 的 `elidePart`），改写还是持久化的 —— 跨过一次裁剪之后，拿全文的和拿摘要的手里是同一句占位符，连 `runId` 也一起没了。**要跨轮可靠仍然只有一条路**：让 worker 的结论进主 agent 的**回复正文**（那条消息 `pruneLevel: 0`）|
| T13 | **AI SDK v7 是较新的 API 表面**，升级可能有破坏性变更 | D20 | 锁 `^7`；升级前跑 AC-AGENT-* 与 AC-CTX-* 全集；provider 与 agent 装配集中在两个文件里，替换成本可控 |
| T14 | **Plugin 全信任 ⇒ 安装第三方 plugin 等于给 root** | A27 | 默认禁用 + 启用时二次确认 + 只装自己审过的 |
| T15 | **配额是「事后记账 + 事前预留估算」**，估算不准时可能小幅超支 | 成本只能在调用后才准确知道 | `perTurn.maxCostUsd` 硬止损 + `minReserveUsd` 缓冲 + 安全系数 1.5 |
| T16 | **90 天前的图片/文件点不开了**：`attachments` 行还在、正文里的「[图片]」还在，但磁盘上的文件已删 | §2 Q9-a | `media.retentionDays=0` 可整个关掉；删的是文件不是行，所以上下文与检索结果都不塌 |
| T17 | **HarnessAgent 内部的工具调用不受本系统的权限模型约束**：`available()` 注册期 fail-closed 与 `execute()` 二次硬拦截都看不见它 | §2 Q8-c（审批粒度定在「起 harness」这一层） | 准入收到最窄（仅 owner + 仅私聊）+ 目录白名单默认空 + 起 harness 走审批。**这三道是全部的门**，不要以为里面还有第四道。⚠ **2026-08-30 · 门的数目与性质一个字没变**：`dir` 变可选之后，「目录」那一道里多了一个**由本系统创建、每次 run 新建**的落点（`<sandbox.workspaceDir>/<chatId>/harness/<runId>`），由 `agent.harness.workspaceFallback` / `agent.acp.workspaceFallback` 开关，出厂关。它**不是第四道门**，也**不是少了一道** —— 那一道判的仍是「这次要跑的目录准不准」，只是「准」的集合里多了一个我们自己造的成员；显式给的 `dir` 照旧只认白名单。仍然是三道（§2 Q8-b 的部分推翻记录） |
| T18 | **授权时点与执行时点是分离的**：模型调 `bash` 时命令正文在转录里、在 span 里、在人眼前；调 `custom_backup` 时提示词里只有 `{"target":"/etc"}`，正文是若干轮之前写下的，可能在另一个会话、可能是在一段注入的影响下写的。**审计面从转录挪进了 SQLite，而 SQLite 不在提示词里** | §2 Q13 | 落库即禁用 + 改正文即重置 + `definition_hash` 挡轮内改写 + `tool.custom_defined` / `webui.action`（启用记 warn）两条日志 + 扩展页可随时读回正文 |
| T19 | **`requireSandbox` 默认关 ⇒ 自定义工具就是调用者的 `bash`**。owner 命中 `bypassRoles` 时脚本在宿主上跑，因而能直接写 `data/luoli.db` —— `tools.fs.denyGlobs` 只被 `PathJail` 执行，沙箱不看它，所以启用闸对一段**已经在宿主上跑起来的脚本**是无效的 | §2 Q13-d（需求方明确选择与 bash 一视同仁） | 启用闸防的是「只有工具的模型」，不防已经拿到宿主执行的脚本。想要真边界就打开 `tools.selfExtend.customTools.requireSandbox`，此时自定义工具严格弱于 bash。**角色地板 + 沙箱判据 + 会话作用域 + 启用闸，这四道就是全部的门**，不要以为脚本跑起来之后还有第五道 |
| T20 | **折叠的工具模型不知其详 ⇒ 它可能想不到去检索**。折叠行只给名字，一台 MCP server 到底能干什么要检索一次才看得见；而检索是**多一跳** —— 多一个 step、多一对留在上下文里的 tool-call/result，以及本轮剩余步骤的缓存前缀作废（[04 §2.1](./04-agents-and-providers.md#21-prompt-缓存)）。最坏形态是模型答「我没有这个功能」，而那个工具就躺在折叠组里 | T11 的缓解（目录按需暴露） | 四层，缺一层就是一次「答我没有」：① 提示词引导恒有**两处**：KERNEL 那句无条件在，另一处随 `prompt.includeToolCatalog` 二选一 —— 目录开着时是折叠组行里内嵌的 `search_tools` 指引，目录关掉时是 RUNTIME 的折叠计数后缀（那个后缀挂在 `show.toolNames` 上，而 `show.toolNames = !includeToolCatalog`，[06 §1.2](./06-prompt-and-memory.md#12-block-6-runtime-模板)）。所以「三处同时在」是做不到的，也不必要：任一档下都有一处告诉模型有东西可取、一处告诉它怎么取；② `repairToolCall` 兜底：直接调折叠工具会被自动改写成一次检索（[05 §3.12](./05-tools-and-permissions.md)），所以模型不必先学会用 `search_tools`；③ `names` 通道让跨轮重展开只花一次调用；④ `tools.catalog.deferExternal: false` 是随时可退的逃生舱，退回去 block 3 与 RUNTIME 逐字节回到原样（KERNEL 那句引导语留着空转，见 [05 §3.12](./05-tools-and-permissions.md) 不变量 3） |
| T21 | **这套拓扑给每一件要动手的事定了价：多一次模型往返，外加一份用不上的缓存**。主 agent 不再执行工具（`MAIN_AGENT_TOOLS`，[05 §4](./05-tools-and-permissions.md)），于是最短路径也是「主 agent 决定派发 → worker 跑完一整条 agent 循环 → 主 agent 读结论再组织回复」，至少两次主 agent 调用夹一条完整 worker 循环。而 **worker 每次都是全新前缀**：它的 instructions 是 `LW_WORKER_KERNEL`、messages 只有 `task`(+`context`)（[04 §3.3](./04-agents-and-providers.md)），主对话那份攒了整轮的 prompt cache 它一个 token 都用不上，两个 worker 之间也没有可复用的段。**日常轻任务的延迟与花费是上升的，不是下降的** —— 「读一个文件」这种一步就完的事代价最大：一次直接调用变成两次模型往返加一次冷启动 | 主 agent 只对话与派发（A8 之后 worker 只剩内建的一种） | **这不是能调优掉的东西**，它是拓扑本身的定价：换模型、调 `agent.worker.maxSteps`、缩 worker 的 kernel，动的都只是常数。换来的是三件确定的东西 —— 主 agent 的上下文里不再堆工具调用与工具结果（每轮重发量下降）、外部内容统一经 `untrusted()` 一道口子进来（`spawn_worker` 的 `untrustedOutput`）、以及一条把执行面整段隔开的边界。真嫌贵只有一条路：把工具搬回主 agent，也就是整体退掉这次重构 —— **没有中间档**，给主 agent 开一两个「便宜的」工具就等于同时失去这三件 |

---

## 4. 明确不做（第一版范围外）

> 已经做了的两条（定时/主动发言、`HarnessAgent`）**已从本表移走** —— 结论在 §2 Q4 / Q8。
> 一张「明确不做」的清单里放着已经做完的东西，读者只能靠日期猜哪一半是真的。

| 项 | 理由 |
|---|---|
| 语音转录（STT）/ 语音回复（TTS） | D16 未选；可作为 plugin 追加（A13） |
| 图片生成 | 需求未提 |
| 多实例 / 分布式 | A20；SQLite + 进程内锁。§2 Q1 已答：**现在不做，但保留将来迁移的可能性** —— 预留抽象不删，新代码不得引入新的进程内状态假设 |
| Postgres 支持 | 第一版 SQLite 足够；schema 设计已尽量兼容 |
| 向量语义检索 | §2 Q2 **确定不做**（2026-08-18）。不做的代价可逆：消息都在库里，任何时候都能离线重建索引 |
| 关键词触发的主动提醒 | §2 Q4 只覆盖了定时那一半。「检测到 X 就主动说」要在消息流上挂常驻匹配器，跟定时器不是一套机制 |
| WebUI 多用户 RBAC | §2 Q7 **确定不做**（2026-08-18）。连带：`approval.allowInitiator` 永久不再引入 |
| `WorkflowAgent` | 编排在自己的 `TurnRunner` 里，语义更强（[04 §6](./04-agents-and-providers.md#6-workflowagent-harnessagent-的取舍)） |
| 上下文分支 DAG（保留多分支 + merge） | D1 选了线性 rebase；数据模型（`parent_id`）已为将来预留 |
| 每群独立 PUBMEMORY | D12 选了全局单份；数据模型（`memory_docs.subject`）已预留 |
| Telegram Business / Stars / 支付 | 需求未提 |
| 频道（channel）支持 | `trigger.channels` 默认 false，未做完整验证 |
| i18n 多语言界面 | 第一版只有 zh-CN。**结构并没有预留** —— 原文写的 `i18n/` 目录从来没存在过，文案就在各 SFC 里（改写工具见 [`docs/copy/README.md`](./copy/README.md)）。真做时要连 `general.locale` 一起加回来（A2） |
