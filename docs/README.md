# LuoLiCore — Telegram AI Bot 设计与验收文档

> 一个以 Telegram 为交互入口、以「上下文引擎 + 多 Agent + 可扩展工具生态」为核心的 AI Bot 系统。
> 本目录是**实现指导 + 验收标准**的唯一权威来源。实现与文档不一致时，先改文档再改代码。

---

## 0. 文档索引

文档分两层：**规格层**（本节，活的，实现与它不一致时先改文档再改代码）与
**复审层**（[§0.1](#01-复审层reviews已冻结)，历史快照，只读）。
「现在还欠什么」不在任何一份复审报告里，在 [`00-state.md`](./00-state.md)。

| 文档 | 内容 | 读者 |
|---|---|---|
| [00-state.md](./00-state.md) | **当前态**：还欠什么、哪些查过没问题、哪些 🚧 是有意留的。开工前先看这份 | 全体 |
| [01-architecture.md](./01-architecture.md) | 总体架构、模块边界、请求全链路时序、目录结构 | 全体 |
| [02-context-engine.md](./02-context-engine.md) | **核心**：快照 / rebase / 裁剪 / 并发语义的完整规格 | 后端 |
| [03-data-model.md](./03-data-model.md) | 数据库 DDL、索引、迁移、中文全文检索 | 后端 |
| [04-agents-and-providers.md](./04-agents-and-providers.md) | Agent 架构、subagent、双向通信、Provider/模型注册表 | 后端 |
| [05-tools-and-permissions.md](./05-tools-and-permissions.md) | 工具目录、角色矩阵、沙箱、审批 | 后端 / 安全 |
| [06-prompt-and-memory.md](./06-prompt-and-memory.md) | 系统提示词装配、ASSIST/CHARACTER/PUBMEMORY/PRIMEMORY | 后端 / 提示词 |
| [07-skills-plugins-mcp.md](./07-skills-plugins-mcp.md) | SKILL.md 规范、Plugin API、MCP 接入 | 后端 / 扩展开发 |
| [08-telegram-adapter.md](./08-telegram-adapter.md) | grammY 适配层、触发、流式输出、多模态、命令 | 后端 |
| [09-webui.md](./09-webui.md) | 管理端页面、REST/SSE API、鉴权 | 前端 / 后端 |
| [10-logging-and-observability.md](./10-logging-and-observability.md) | 独立日志、trace 模型、成本记账、配额 | 后端 / 运维 |
| [11-config-reference.md](./11-config-reference.md) | 全量配置项参考（含默认值与热更新语义） | 全体 |
| [12-implementation-plan.md](./12-implementation-plan.md) | M0–M10 分阶段实施指导与出口条件 | 全体 |
| [13-acceptance-criteria.md](./13-acceptance-criteria.md) | **验收文档**：可逐条勾选的验收用例 | QA / 验收 |
| [14-open-questions.md](./14-open-questions.md) | 未确认项、默认假设、已知取舍。**§2 的 Q1–Q13 已全部答复且全部落地**（Q1–Q12 于 2026-08-18，Q13 随 M12），开头那张表是结论速查。§3 的 `T*` 编号被源码当凭据引用（`T17` 6 处、`T19` 4 处），**不得重编号** | 全体 |
| [21-webui-coverage-gaps.md](./21-webui-coverage-gaps.md) | **WebUI 控制面覆盖缺口**：口径是「运行时有这个能力，但运维在 WebUI 里够不着」。动 WebUI 或从 `KNOWN_UNIMPLEMENTED_CONFIG_KEYS` 摘键之前先扫一眼 §1 的复算方法与 §5 的「不是缺口」清单 | 全体 / 运维 |
| [29-manual-acceptance-log.md](./29-manual-acceptance-log.md) | **手动验收台账**：13 里 `(手动)` 那些条目的装置、逐场剧本与实测记录。给它们打勾必须在这里留一条带证据指针的小节（`tests/acceptance.test.ts` 焊着）。**编号 29 归本文，复审层下一个用 30** | QA / 验收 |

### 0.1 复审层（`reviews/`，已冻结）

这**十轮**复审（13 份文件：十份报告 + 三份整改/复核）记录**当轮**的发现与整改，写完即冻结、不再更新 ——
想知道**现在**还欠什么，看 [`00-state.md`](./00-state.md)，不要读这里的结论。它们留着有两个理由：
条目编号（`W-CFG-02`、`S-01` 之类）是源码注释的溯源凭据（源码里 503 处引用）；每条的复现方式与根因分析
是下一轮不重复踩坑的依据。**这些文件不得重编号、不得删条目。**

⚠ **这条规矩靠人守，`tests/docs.test.ts` 只兜住一部分。** 实测：13 份里定义了 288 个编号，而「删掉这一条
就报错」只对 **18 个（6.3%）**成立 —— 判据用裸子串匹配（`S-01` 被 `L-OPS-01` 满足、`I-01` 被 `D-UI-01`
满足，于是 `27` 的 `S-*`/`T-*` 与 `22` 的 `I-*` 两整个家族没有保护），只认 `· 编号` 形式，且正则要求带
连字符（`Z4`/`Z5` 不在覆盖内）。反方向完全没有：`reviews/` 里 288 个编号有 **154 个源码从未引用过**。

⚠ **编号命名空间没有唯一性约束，已经撞过两次**，且两边都有活引用、测试对同名异义完全免疫：

| 撞号 | 一边 | 另一边 |
|---|---|---|
| `R-TG-01` | [19](./reviews/19-review-round4.md) —— IANA 时区非法值让群聊全灭（`tests/regression.round4.test.ts:75` 指这条） | [24](./reviews/24-review-round6-verification.md) —— `splitTelegramText` 5001 码点丢 1105 个（`packages/telegram/src/output.ts:590` 写 `docs/24 · R-TG-01` 指这条） |
| `G-EXT-01`–`05` · `G-SBX-01` | [15](./reviews/15-gap-review.md) 的扩展生态 / 沙箱缺口 | [21 §9](./21-webui-coverage-gaps.md) 的装 skill 包缺口（源码那两处 `G-EXT-05` 指的是 **21** 的） |

引这两组编号时**必须带文档号**（`docs/24 · R-TG-01`），裸写指不清。

⚠ **`27-full-scope-review.md` 含 3 个字面 NUL 字节**（`C-07` 条目在讲 `safeRender` 的 `\0<n>\0` 占位符），
`file` 判它为 `data`，**普通 `grep` 会静默跳过整份文件** —— 查它的编号要用 `grep -a`。这份承载 108 处引用，
是这套「编号即凭据」机制里最容易被漏查的一份。

| 文档 | 那一轮做了什么 |
|---|---|
| [15-gap-review.md](./reviews/15-gap-review.md) | 第一轮：实现与 01–13 号文档的差异，13 P0 / 39 P1 / 19 P2 + 逐条修改指导。⚠ P0 的条数**这份文件里有三个版本**（引言「12 项」/ §0 总览表「13」/ §1 实际 15 个 `### G-` 小节）——冻结层不改，核对以 §1 的小节为准。它定义的 74 个 `G-*` 编号**源码零引用**，且 6 个与 [21](./21-webui-coverage-gaps.md) 撞名 |
| [16-remediation-plan.md](./reviews/16-remediation-plan.md) | 第一轮的修复批次 R0–R6 与回归测试清单 |
| [17-followup-review.md](./reviews/17-followup-review.md) | 第二轮：复验第一轮 13 项 P0 + 独立新排查 |
| [18-review-round3.md](./reviews/18-review-round3.md) | 第三轮：复验第二轮 + 形状断言建议 |
| [19-review-round4.md](./reviews/19-review-round4.md) | 第四轮：新问题全部集中在配置持久化层。首次引入可运行探针（PROBE-*） |
| [20-review-round5.md](./reviews/20-review-round5.md) | 第五轮：主题是「本地对象交给外部依赖」的交接点 |
| [22-review-round6.md](./reviews/22-review-round6.md) | 第六轮：分漏洞 / 设计缺陷 / 可改进三段。主题是「资源上界」—— 五处都能拖垮单线程进程 |
| [23-review-round6-remediation-report.md](./reviews/23-review-round6-remediation-report.md) | 第六轮整改方提交的完成报告。**编号与 22 有错位**，核对时以 22 的原始编号为准，见 [24](./reviews/24-review-round6-verification.md) §1.2 |
| [24-review-round6-verification.md](./reviews/24-review-round6-verification.md) | 第六轮整改的复核与返修：24 项里 5 项没修对，含一次把 14 个控制台页面改空白。**改渲染层或改「没有 X 时怎么办」之前先看 §0** |
| [25-round7-remediation.md](./reviews/25-round7-remediation.md) | 第七轮：把当时 25 份文档里的 🚧 / 「未实现」标记逐条回代码核对。含一条**误报纠正**（`I-05`）—— 复审报告也会错 |
| [26-round8-tool-review.md](./reviews/26-round8-tool-review.md) | 第八轮：工具系统专项，`tools/` + 当时的 31 个内建工具（`TOOL_POLICY` 现为 **54** 个）。主题是「边界只写了一半」。**动 `packages/core/src/tools/` 之前先看 §6**（记了查过没问题的地方） |
| [27-full-scope-review.md](./reviews/27-full-scope-review.md) | 第九轮：全量源码，但**判据换成外部标准**（OWASP Top 10 / SOLID / JS·TS 实践）而非需求文档。主题是「同一件事有两套判据」。§7 列了查过没问题的 13 个面。§8 的 `Z4`/`Z5` 批次是 [`00 §2.1`](./00-state.md) 结构性三条的出处。⚠ 含 NUL 字节，`grep` 要加 `-a` |
| [28-round10-live-system-test.md](./reviews/28-round10-live-system-test.md) | **第十轮：停机活体测试**——换的是手段不是判据（真进程 / 真 Telegram / 真 docker / 真时钟 / 真上游），只找单元测试**结构性**看不见的问题。**全库被源码引用最多的一份（167 处）。** §6「跑过没问题的」是读码复审给不出来的那一节，§8 记了排除掉的 8 条假象——**下一轮沿用同一套装置前先读这两节** |

---

## 1. 一句话架构

```
Telegram ──► 准入(白名单/角色) ──► 归档(DB, 按 chat 隔离) ──► 触发判定
                                                              │
                                            ┌─────────────────┴─────────────────┐
                                            │        上下文引擎 (git 式)         │
                                            │  done(HEAD) ──snapshot──► turn     │
                                            └─────────────────┬─────────────────┘
                                                              ▼
                                       主 Agent (ToolLoopAgent, 固定头部系统提示词)
                                          │            │              │
                                     日常对话      工具调用        重任务
                                          │            │              │
                                          │      READ/WRITE/BASH  spawn subagent
                                          │      检索聊天记录     (独立上下文)
                                          │      Skill/Plugin/MCP  ◄─ask_parent─►
                                          ▼            ▼              ▼
                                     Telegram 输出(流式) + 出站消息入库 + commit/rebase/裁剪
```

---

## 2. 已确认的关键设计决策（Decision Log）

以下决策由需求方在设计问答中明确选定，**不得在实现阶段单方面变更**。

| # | 决策点 | 选定方案 | 详见 |
|---|---|---|---|
| D1 | 并发上下文模型 | **并行执行 + rebase 追加**：各轮次基于 `done` 快照并行运行，按**完成顺序**拼接进 `done`；后完成者的消息 rebase 到最新 HEAD 之后。允许「B 作答时未见 A」。 | [02](./02-context-engine.md#3-并发与-rebase) |
| D2 | 裁剪方向 | **丢弃最旧消息（滑动窗口）**。系统提示词与记忆永不裁剪。 | [02](./02-context-engine.md#5-裁剪轮后收敛) |
| D3 | 裁剪时机 | **轮后裁剪，轮内不裁**（单轮次限制，非单次调用限制）；另设「硬天花板」在轮内临时 prune，仅影响本次调用、不污染永久历史。 | [02](./02-context-engine.md#5-裁剪轮后收敛) |
| D4 | 限制度量 | **token 为主 + 消息数为副**，任一超限即裁剪。 | [11](./11-config-reference.md#2-configconfigyaml-全量参考) |
| D5 | 群聊触发条件 | @提及 bot、回复 bot 消息、bot 命令、自定义唤醒词/正则（四者并集，均可配置开关） | [08](./08-telegram-adapter.md#4-触发判定) |
| D6 | 背景消息 | **未触发的群消息进入上下文**，带 `[发言人 时间]` 前缀；单轮次注入条数上限可配置 | [02](./02-context-engine.md#4-背景消息认领) |
| D7 | 存储 | **单 SQLite 库 + `chat_id` 分区 + FTS5**，数据访问层强制注入 chat 过滤 | [03](./03-data-model.md) |
| D8 | 上下文粒度 | 默认整群共享（`contextScope='chat'`）；可切换按论坛 topic 隔离（`'thread'`）。`message_thread_id` 始终入库 | [02](./02-context-engine.md#2-上下文键) |
| D9 | 权限模型 | **分级角色 owner > trusted > limited > blocked**；`effective = min(role(user), role(chat))` | [05](./05-tools-and-permissions.md#2-角色与判定) |
| D10 | 沙箱 | **可开关**：`mode = none \| docker`；`bypassRoles=['owner']`（owner 宿主直跑）；非 owner 无沙箱时**工具直接禁用（fail-closed）** | [05](./05-tools-and-permissions.md#5-沙箱) |
| D11 | 私有记忆 | **每用户一份** `memory/private/<userId>/PRIMEMORY.md`；owner 可读写全部；群聊永不注入 | [06](./06-prompt-and-memory.md#3-作用域与注入矩阵) |
| D12 | 公开记忆 | **全局单一份** `memory/PUBMEMORY.md`（所有会话共享）；写入需 `pubWriteMinRole`（默认 `trusted`） | [06](./06-prompt-and-memory.md#3-作用域与注入矩阵) |
| D13 | Agent 通信 | **双向**：subagent 可 `ask_parent` 阻塞提问、`report_progress` 上报；`maxDepth=3` + 环路检测 + 待答超时 | [04](./04-agents-and-providers.md#4-agent-间通信) |
| D14 | 扩展生态 | **Anthropic SKILL.md 兼容 + JS/TS Plugin + MCP** | [07](./07-skills-plugins-mcp.md) |
| D15 | WebUI | **同进程内置**（Hono + 静态 SPA）+ 单管理员密码/Session + SSE 实时日志；默认仅监听 `127.0.0.1` | [09](./09-webui.md) |
| D16 | 多模态 | **图片 + 文档（pdf/txt/代码）**；语音/视频仅归档为占位符（不做 STT） | [08](./08-telegram-adapter.md#7-多模态) |
| D17 | 长任务 | **占位消息 + 进度编辑 + inline `/cancel`** | [08](./08-telegram-adapter.md#6-长任务与进度) |
| D18 | 输出方式 | **可配置，默认流式 `editMessageText`** | [08](./08-telegram-adapter.md#5-输出与流式) |
| D19 | 配额 | **记账 + 多级配额硬限**（global/chat/user，日/月，按角色覆盖），超额拒绝并提示 | [10](./10-logging-and-observability.md#5-配额) |
| D20 | 技术栈 | TypeScript / Node 22 / pnpm workspace / **AI SDK v7** / **grammY** / **better-sqlite3 + 原生 SQL（无 ORM 查询层）** / Hono / Vite + Vue 3（自建 UI 层）/ vitest。**原定 Drizzle ORM，实现阶段改为手写 SQL**：查询层要强制注入 chat 作用域过滤（D7），自己写比绕过 ORM 更直接；迁移相应改为手写 `NNNN_*.sql` + 自研执行器。账本表名 `__drizzle_migrations` 是那一版留下的名字，不代表还在用 | [01](./01-architecture.md#5-技术栈) |
| D21 | 定时 / 主动发言 | **做**（[14 §2 Q4](./14-open-questions.md) 已答复）：`mode='agent'` 起完整轮次、`mode='notify'` 只发预写文本；产出**照常进上下文**；停机错过**不补跑**；`minRole=trusted` 且落点绑死本会话 | [02 §10](./02-context-engine.md#10-定时轮次的上下文归属) |
| D22 | 子 agent 的 md 定义 | **做**（[14 §2 Q5](./14-open-questions.md)）：`agents/<name>.md` 是**只读**来源，DB / WebUI 同名定义覆盖它；加载失败报错而不是静默跳过 | [04](./04-agents-and-providers.md) |
| D23 | `HarnessAgent` | **做，排 [M11](./12-implementation-plan.md)**（[14 §2 Q8](./14-open-questions.md)）：仅 owner 且仅私聊、目录限白名单（默认空 = 关闭）、起 harness 整体走一次审批。它内部的工具调用**不受本系统权限模型约束**（T17） | [12 · M11](./12-implementation-plan.md) |
| D24 | 保留策略 | **媒体文件 90 天**（`media.retentionDays`，0 = 不清）删文件留元数据；`messages` / `context_messages` / `turns` / `tasks` **永久**（[14 §2 Q9](./14-open-questions.md)） | [03 §4](./03-data-model.md) |
| D25 | `ask_parent` 应答 | **实现 low 档仲裁**（[14](./14-open-questions.md) A7）：`agent.askArbiter` / `askTimeoutMs` 接线，不再返回 `ask_parent_not_implemented`。降级顺序 仲裁 → `default` → `ask_parent_unanswered`。**转人工（`askEscalateToUser`）仍未实现** —— 阻塞式人机通道本身已落地（`PendingPrompts`，[05 §6.1](./05-tools-and-permissions.md)），欠的是「问谁 / 选项从哪儿来 / 等人期间的并发槽与超时怎么算」这三条语义 | [04 §3.4](./04-agents-and-providers.md) |

---

## 3. AI SDK 适配性调研结论

**结论：适合。** `ai-sdk.dev` (v7) 覆盖了本系统 Agent 层约 70% 的需求，且抽象粒度与本设计高度吻合。

### 3.1 直接可用的能力

| 本系统需求 | AI SDK v7 对应能力 |
|---|---|
| 多 Provider / 多模型导入与管理 | `createProviderRegistry({...})`，字符串 id `provider:model` 寻址；`customProvider({ languageModels })` 做模型别名与能力裁剪；`fallbackProvider` 兜底 |
| 高费用 / 低费用模型指派 | `customProvider` 别名（`high` / `low` / `vision` / `title`）+ 运行期 `prepareStep` 动态换模型 |
| 主 Agent 工具循环 | `ToolLoopAgent`（自动管理 message 数组、step 循环、停止条件） |
| Subagent 分发重任务 | 官方 subagent 模式：把 agent 包在 `tool().execute` 里，**独立上下文窗口**；`toModelOutput` 只回灌摘要给主模型 |
| Subagent 流式进度 | `execute` 写成 `async function*`，`yield` 中间态；配合 `readUIMessageStream` |
| 单轮次上下文限制与裁剪 | `prepareStep` + `pruneMessages()`（可分级裁剪 reasoning / toolCalls / 空消息） |
| 步数/停止控制 | `stopWhen: [isStepCount(n), hasToolCall('final_answer')]`、`isLoopFinished()` |
| 受信 / 非受信工具白名单 | `prepareStep` 返回 `activeTools: string[]`；每 step 重算 |
| 高危工具人工审批 | `toolApproval`（`user-approval` → `tool-approval-request` part → 二次调用） |
| MCP 生态 | 原生 MCP client（stdio / HTTP），工具动态发现 |
| 运行时加载的 plugin/skill 工具 | `dynamicTool()`（schema 编译期未知） |
| 图片 / 文件入上下文 | 多模态 message parts；工具结果用 `toModelOutput` 返回 `file` part |
| 每次调用的独立日志 | `onStepFinish` / `onFinish` 提供 usage、finishReason、toolCalls、raw request/response |
| 跨 Agent 共享状态 | `runtimeContext`（租户/凭据/进度）、`toolsContext`（按工具的类型化上下文） |

### 3.2 AI SDK **不提供**、必须自建的部分

| 缺口 | 本项目方案 |
|---|---|
| Telegram 接入 | grammY 适配层（[08](./08-telegram-adapter.md)） |
| 持久化、git 式快照 / rebase / done 指针 | 自建上下文引擎（[02](./02-context-engine.md)、[03](./03-data-model.md)）。`pruneMessages` 只作用于内存中的 message 数组，**不负责持久化与并发合并** |
| SKILL.md 加载与渐进式披露 | 自建 Skill 加载器（[07](./07-skills-plugins-mcp.md#2-skill)） |
| Plugin 体系 / 钩子 | 自建 Plugin API（[07](./07-skills-plugins-mcp.md#3-plugin)） |
| 角色权限模型、沙箱 | 自建（[05](./05-tools-and-permissions.md)） |
| 成本记账与配额硬限 | 自建（AI SDK 只给 usage，不给定价与配额）（[10](./10-logging-and-observability.md)） |
| Agent 反向通信（`ask_parent`） | 自建 Agent Bus；AI SDK 的 subagent 是**单向**的（父调子、子返回） |
| WebUI 管理端 | 自建（[09](./09-webui.md)） |

### 3.3 需要注意的 AI SDK 约束

1. **Subagent 工具不支持 approval 流程**（官方文档明确：`Subagent tools cannot use approval flows`）。因此**高危工具的审批必须在主 Agent 层拦截**，或由我们自己的 Bus 在 subagent 内部实现审批（本设计采用后者：审批在工具执行器统一实现，不依赖 AI SDK 的 `toolApproval`，仅在主 Agent 交互式场景可选启用 `toolApproval`）。详见 [05 §6](./05-tools-and-permissions.md#6-审批流)。
2. **Subagent 每次调用都是全新上下文**，不继承父历史，除非显式传入。这与本设计一致（subagent 只拿任务描述 + 必要资料）。
3. **MCP 工具类型不安全**，官方建议生产环境优先自定义 AI SDK 工具。本设计：核心工具全部自建，MCP 仅作为用户可选扩展且默认 `minRole=trusted`。
4. `pruneMessages()` 的语义是「本次调用的临时裁剪」，与本设计 D3 的「硬天花板」一致；**永久裁剪走我们自己的 `window_start` 指针**，不要混用。

---

## 4. 快速开始（实现者视角）

```bash
pnpm install
cp .env.example .env          # 填 BOT_TOKEN、LUOLI_MASTER_KEY、WEBUI_PASSWORD
pnpm db:migrate
pnpm dev                      # 同进程拉起 bot(long polling) + http:8787
pnpm test                     # vitest
pnpm build && pnpm start      # 生产
```

必需环境变量见 [11 §1](./11-config-reference.md#1-环境变量env)。

### 4.1 两种生产部署形态

| | 容器（`docker compose up`） | 宿主（`pnpm build && pnpm start`） |
|---|---|---|
| 应用进程 | 容器内 | 宿主，建议挂 systemd |
| 沙箱 | 挂 `/var/run/docker.sock`，由容器调宿主 docker | 直接调宿主 `docker` CLI，**不需要挂 socket** |
| 沙箱镜像 | `docker compose --profile build-only build sandbox` | 同左 |
| 额外前置 | `.env` 里给 `DOCKER_GID`（socket 权限）；`LUOLI_HOST_WORKSPACE_DIR`（`-v` 路径映射，compose 已默认给出） | 无 |

容器形态要跑 docker 沙箱，三件事缺一不可，缺哪件都是**执行类工具直接消失**而不是报错降级：
镜像里有 `docker` 客户端（`docker/Dockerfile` 装了 `docker-ce-cli`，不装 daemon）、进程能读到 socket
（`group_add: ${DOCKER_GID}`）、`-v` 的宿主路径映射（`sandbox.hostWorkspaceDir`，见
[05 §5.3](./05-tools-and-permissions.md)）。注意挂 socket 等于把宿主 docker 的完全控制权交给容器，
其安全边界等同 root —— 这是本设计的既有取舍，不要再往这个容器里塞不受信任的东西。

两种形态共用一套产物布局：`tsc` emit 到 `dist/packages/<name>/src/`，`scripts/postbuild.ts`
把它搬到各包 `package.json` 的 `exports` 声明的 `packages/<name>/dist/`；根 `node_modules/@luoli/*`
由 pnpm 按根 `package.json` 的 workspace 依赖生成。**改 `tsconfig.build.json` 的 `outDir` / `rootDir`
或包的 `exports` 时，这三处要一起看** —— 对不上的表现是 `pnpm start` 报 `ERR_MODULE_NOT_FOUND: @luoli/db`。

`pnpm typecheck` 跑的是**两份 project**：根 `tsconfig.json` 与 `tsconfig.build.json`。两份的文件集不同 ——
构建那份排掉 `packages/webui/**`、`tests/**`，以及只在 dev server 上注入的 `scripts/copy/runtime/**`
（dev 文案校样面板，见 [`copy/README.md`](./copy/README.md)；它 `import` 一个 `.vue`，而 release
产物里没有任何一处引用得到它）。只跑根那份会漏掉「只在构建里存在」的错误：`*.vue` 的类型垫片在
`packages/webui/src/env.d.ts`，构建排掉了 webui，于是 `boot.ts` 那句 `import` 在根 project 下解析得到、
在构建下解析不到 —— `pnpm typecheck` 全绿而 `pnpm build` 恒定失败，实际漏了整整一轮才被发现。

`tsconfig.build.json` 的 `noEmitOnError: true` 是同一件事的另一半。tsc 默认**报错照样 emit**，而
`pnpm build` 的 `&&` 断在 tsc 上 —— `postbuild.ts` 不跑，磁盘上就留下**新 `dist/` + 旧
`packages/*/dist/`** 的混龄产物。这种状态下 `pnpm start` 不报错，它安静地跑一半新一半旧，
比构建硬失败难查得多。

不装 docker 也能跑，但执行类工具（`bash` 等）只剩 `sandbox.mode: none` 一个选项 ——
也就是对非 owner 角色 fail-closed 地整体消失。注意 `bypassRoles` 在
`Sandbox.plan()` 里先于 `mode` 判断 —— 即使 `mode: none`，owner 触发的命令仍在宿主直跑，
要彻底关掉得同时清空 `sandbox.bypassRoles`。

---

## 5. 术语表

| 术语 | 定义 |
|---|---|
| **context key（上下文键）** | 上下文隔离单位。`contextScope='chat'` 时为 `chat:<chatId>`；`'thread'` 时为 `chat:<chatId>:<threadId>` |
| **turn（轮次）** | 从一次触发开始，到最终回复发出、delta 提交为止的完整过程；内部可含多次模型调用与工具循环 |
| **delta** | 一个 turn 产生的有序消息序列（背景消息 + 触发消息 + 助手/工具消息） |
| **done / HEAD** | 某 context key 当前「已定稿」的 commit 指针 |
| **snapshot（快照）** | 由某个 commit 物化出的消息数组，turn 在其上运行 |
| **commit** | 不可变的上下文状态记录，含 parent、window_start、head_ordinal |
| **rebase** | 提交时发现 HEAD 已前移，将本 turn 的 delta 追加到新 HEAD 之后 |
| **ordinal** | 每个 context key 内单调递增的消息序号，**在 commit 时分配**（因此天然等于完成顺序） |
| **window_start** | 当前上下文窗口的起始 ordinal；裁剪 = 前移该指针 |
| **background message（背景消息）** | 群里未触发 bot 的普通消息 |
| **claim（认领）** | 把尚未进入上下文的原始消息折入某个 turn 的 delta |
| **principal（主体）** | 可被授予角色的对象：user 或 chat |
| **effective role（有效角色）** | `min(role(user), role(chat))` |
| **agent run** | 一次 agent 实例的执行（主 agent 或 subagent） |
| **trace** | 以 `turn_id` 为根的一整棵调用树（模型调用、工具调用、subagent） |
