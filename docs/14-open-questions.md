# 14 · 未确认项、默认假设与已知取舍

三类内容：
- **§1 默认假设** —— 设计问答中未逐条确认，我按合理默认写入了文档。**若与你的预期不符，改这里指出的那一处即可**。
- **§2 待确认问题** —— 需要你决定，但不阻塞 M0–M3 开工。
- **§3 已知取舍** —— 由已定决策直接推导出的代价，需求方已知情或应当知情。
- **§4 明确不做（第一版范围外）**。

---

## 1. 默认假设（未逐条确认，可随时推翻）

| # | 假设 | 依据 / 影响面 | 若要改动 |
|---|---|---|---|
| A1 | Telegram 接入默认**长轮询**，Webhook 作为配置项 | 长轮询无需公网 HTTPS，开发与自托管最省事 | `telegram.mode` |
| A2 | 文档与 WebUI 界面语言为**中文**，代码标识符与日志字段为英文 | 你全程用中文沟通 | `general.locale` + `webui/src/i18n` |
| A3 | 默认角色为 **blocked**（纯白名单准入） | 需求写「用户/来源白名单」，白名单语义即默认拒绝 | `access.defaultUserRole/defaultChatRole` |
| A4 | `blocked` 主体的消息**不入库** | 避免为陌生人存储数据；也省磁盘 | `access.archiveBlocked=true` 可改为入库不响应 |
| A5 | 论坛 topic 默认**不隔离**（`scope='chat'`） | 你说「同一群聊共享一个上下文」 | `context.scope='thread'` |
| A6 | 命令消息（除 `/ask`）**不进上下文** | 避免 `/new`、`/ctx` 之类污染对话 | `commands.archiveToContext=true` |
| A7 | `ask_parent` 默认由 **low 档模型仲裁**应答，不打扰用户 | 你选了「双向通信」但未定应答方式；转人工会破坏体验 | `agent.askArbiter=false` + `askEscalateToUser=true` |
| A8 | 子 agent 定义为**配置数据**（YAML + WebUI），不是 markdown 文件 | 你选了「SKILL.md + JS plugin」而非含 agent md 的选项 | 若想要 `agents/<name>.md`，见 §2 Q5 |
| A9 | 子 agent 默认**不注入**任何记忆 | 减少 token 与泄露面 | 每 agent 的 `injectMemory: true` |
| A10 | 记忆写入采用**结构化 markdown + 来源标注**，不是自由文本 | 去重、精确更新、可审计都依赖结构 | `memory.requireSourceTag=false` |
| A11 | 记忆自动压缩结果**默认需 owner 审阅**才应用 | 自动覆盖记忆风险高 | `memory.autoApplyCompaction=true` |
| A12 | 群聊里 `limited` 角色**不能写公开记忆**（`pubWriteMinRole=trusted`） | 你选了全局单份 PUBMEMORY，这是防污染的必要安全阀 | `memory.pubWriteMinRole='limited'` |
| A13 | 语音**不做 STT**，只归档 | 你在多模态里没选语音 | 加一个 `transcribe` 工具或 plugin |
| A14 | 图片长边归一化到 **1568px** | 主流 vision 模型的性价比拐点 | `media.maxImageEdge` |
| A15 | WebUI 只有**单一 owner 身份**，无多用户 RBAC | 你选了单密码方案 | 见 §2 Q7 |
| A16 | WebUI 默认只监听 **127.0.0.1** | 单密码 + owner 全权限，公网暴露风险太高 | `webui.host` + 自行前置 TLS |
| A17 | ~~定价表由 owner 手工维护，不自动抓取~~ → **已推翻**：定价与窗口/能力/思考档位从 models.dev 拉取并缓存到本地（[04 §5.4.1](./04-agents-and-providers.md#541-模型元数据目录modelsdev)）。外部数据源的依赖靠三点收敛：只在运维点「拉取模型」时才可能出网、拉不到就降级用旧缓存、出处不确定时**价格留空而不是猜** | 上游只给模型名，不给价格与能力，全手填在 6000+ 模型面前不现实 | `provider.catalog.enabled=false` 退回全手填 |
| A18 | 配额单位为 **USD**，无汇率转换 | 所有 provider 定价都是 USD | 加 `quota.fxRate` |
| A19 | FTS 用 **trigram** tokenizer | SQLite 内置、对中文可用、零依赖 | `db.ftsTokenizer` 或改 jieba 预分词（见 §2 Q3） |
| A20 | **单进程单实例**部署 | SQLite + 进程内锁的直接推论 | 见 §2 Q1 |
| A21 | 工作目录按 **chat 隔离**（`data/workspace/<chatId>`） | 与「按 chat id 隔离」的整体原则一致 | 改为按 user 或全局共享 |
| A22 | 主/子 agent **共享**同一个 workspace | 便于子 agent 交付产物给主 agent | 子 agent 独立 workspace + 显式拷贝 |
| A23 | 「重任务」判定交给**模型自己**（提示词 + 步数护栏），不做前置分类器 | 分类器错判的体验代价高于收益 | 加一个 `low` 档前置分类步骤 |
| A24 | 取消时**丢弃**已生成内容（`commitPartial=false`） | 取消通常意味着「这轮不算」 | `cancel.commitPartial=true` |
| A25 | 流式输出已发出内容后失败，**仍提交** delta | 上下文必须与用户看到的一致 | 不建议改 |
| A26 | 审批只有 **owner** 能批（`allowInitiator=false`） | 否则 trusted 用户可自批自己的高危命令 | `approval.allowInitiator=true` |
| A27 | Plugin **进程内全信任**运行，无沙箱 | Node 内做可靠的 JS 沙箱代价极高且不可靠 | 见 §2 Q6 |
| A28 | MCP 默认全部**关闭**且 `minRole=trusted` | 第三方工具不可控 | `mcp.enabled` + 每 server 配置 |

---

## 2. 待确认问题（不阻塞开工，建议在 M4 之前答复）

**Q1. 是否需要多实例 / 横向扩展？**
现设计是单进程 + SQLite + 进程内 `KeyedMutex`。若未来要多实例，需把锁换成 DB advisory lock 或迁 Postgres（表结构基本兼容，FTS 换 `tsvector`/pgvector）。
→ *若确定永远单机，可以删掉一些为将来预留的抽象，代码更简单。*

**Q2. 聊天记录检索要不要加语义检索（向量）？**
现在只有 FTS 关键词检索。「上次说的那家店」这类模糊回忆，关键词经常打不中。加向量检索需要：embedding provider、`message_embeddings` 表、增量索引任务、混合排序（BM25 + 余弦）。成本：每条消息一次 embedding 调用（很便宜）+ 约 3–5 天工作量。
→ *要做吗？做的话在 M8 之后追加一个 M8.5。*

**Q3. 中文分词是否需要 jieba 预分词？**
trigram 能用，但对长句召回精度不如分词。jieba 方案：写入时分词存影子列，FTS 索引影子列。代价：多一个 native 依赖 + 索引重建。
→ *建议先上 trigram，实测不满意再加（数据可重建索引，不阻塞）。*

**Q4. 是否需要「定时/主动发言」能力？**
现设计**完全被动**（只在被触发时发言）。若要「每天早上推送摘要」「检测到关键词主动提醒」，需要一个 scheduler + 主动发言的上下文归属规则（主动发言算哪一轮？如何进上下文？）。
→ *这会引入新的上下文语义，需要单独设计一节。*

**Q5. 子 agent 是否要支持 markdown 文件定义（`agents/<name>.md`）？**
你在选项里选了「SKILL.md + JS plugin」，所以我把子 agent 做成了配置数据。但 md 文件定义（frontmatter 写 model/tools/minRole，正文是 instructions）对「不写代码就加子 agent」更友好，且与 Claude Code 生态一致。加它约 0.5 天。
→ *要加吗？*

**Q6. Plugin 是否需要真正的隔离？**
可选方案：(a) 现状，进程内全信任（只装自己写的）；(b) `worker_threads` + 受限 API 表面；(c) 子进程 + RPC。(b)/(c) 会让 plugin API 变成异步消息传递，复杂度显著上升。
→ *如果只有你自己写 plugin，建议保持 (a)。*

**Q7. WebUI 是否需要多用户 / 只读账号？**
比如给朋友一个只能看用量和日志的账号。现在是单 owner 全权限。
→ *需要的话，`sessions` 表加 `role` 列 + API 层加角色检查，约 1 天。*

**Q8. 是否需要接入 `HarnessAgent`（把 Claude Code / Codex 当子 agent）？**
AI SDK v7 提供了这个抽象。接进来意味着「在 Telegram 里让 Claude Code 改你的仓库」。管线（权限、记账、进度、取消）已经复用现成的，主要成本是 harness 的安装与凭据管理。
→ *有兴趣的话作为 M11。*

**Q9. 消息保留策略？**
现在 `messages` 与 `context_messages` **永久保留**，不自动清理。长期会持续增长（纯文本群聊约每万条 5–15MB，加媒体会更多）。
→ *需要自动过期策略吗（例如媒体文件 180 天后删除、只留元数据）？*

**Q10. 群聊回复是否需要 `reply_to_message_id`？**
现设计直接发新消息。在活跃群里，回复时引用触发消息会更清晰。
→ *默认要不要开（`output.replyToTrigger`）？我倾向于群聊开、私聊关。*

**Q11. `/undo` 之后的 ordinal 不复用，长期会让 ordinal 稀疏。**
这是有意的（避免与并发 turn 冲突）。ordinal 是 64 位整数，实际不可能耗尽，只是 WebUI 上会看到跳号。
→ *能接受吗？（接受则无需改动。）*

**Q12. 是否需要「上下文导出/导入」用于迁移或调试？**
`/ctx export` 只导出当前窗口。完整导出（含 commit 树）可用于把一个会话搬到另一个部署。
→ *需要的话在 WebUI 加导出/导入按钮。*

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
| T11 | **`prepareStep` 每 step 重算工具集 ⇒ 工具描述 token 每 step 都发一遍** | 安全需要 | prompt cache 覆盖工具定义（大多数 provider 会缓存 tools 段）；`tools.maxRegistered` 限总量 |
| T12 | **子 agent 摘要回灌 ⇒ 主 agent 看不到细节**，可能重复提问或误解 | AI SDK subagent 模式 + 上下文预算 | `read_agent_result` 可按需读全文；`resultMaxChars` 可调 |
| T13 | **AI SDK v7 是较新的 API 表面**，升级可能有破坏性变更 | D20 | 锁 `^7`；升级前跑 AC-AGENT-* 与 AC-CTX-* 全集；provider 与 agent 装配集中在两个文件里，替换成本可控 |
| T14 | **Plugin 全信任 ⇒ 安装第三方 plugin 等于给 root** | A27 | 默认禁用 + 启用时二次确认 + 只装自己审过的 |
| T15 | **配额是「事后记账 + 事前预留估算」**，估算不准时可能小幅超支 | 成本只能在调用后才准确知道 | `perTurn.maxCostUsd` 硬止损 + `minReserveUsd` 缓冲 + 安全系数 1.5 |

---

## 4. 明确不做（第一版范围外）

| 项 | 理由 |
|---|---|
| 语音转录（STT）/ 语音回复（TTS） | D16 未选；可作为 plugin 追加 |
| 图片生成 | 需求未提 |
| 多实例 / 分布式 | A20；SQLite + 进程内锁 |
| Postgres 支持 | 第一版 SQLite 足够；schema 设计已尽量兼容 |
| 向量语义检索 | §2 Q2 待定 |
| 主动发言 / 定时任务 | §2 Q4 待定（会引入新的上下文语义） |
| WebUI 多用户 RBAC | §2 Q7 待定 |
| `WorkflowAgent` | 编排在自己的 `TurnRunner` 里，语义更强（[04 §6](./04-agents-and-providers.md#6-workflowagent-harnessagent-的取舍)） |
| `HarnessAgent`（Claude Code 子 agent） | §2 Q8 待定 |
| 上下文分支 DAG（保留多分支 + merge） | D1 选了线性 rebase；数据模型（`parent_id`）已为将来预留 |
| 每群独立 PUBMEMORY | D12 选了全局单份；数据模型（`memory_docs.subject`）已预留 |
| Telegram Business / Stars / 支付 | 需求未提 |
| 频道（channel）支持 | `trigger.channels` 默认 false，未做完整验证 |
| i18n 多语言界面 | 结构已预留（`i18n/`），第一版只有 zh-CN |
