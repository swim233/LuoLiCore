# LuoLiCore — Telegram AI Bot 设计与验收文档

> 一个以 Telegram 为交互入口、以「上下文引擎 + 多 Agent + 可扩展工具生态」为核心的 AI Bot 系统。
> 本目录是**实现指导 + 验收标准**的唯一权威来源。实现与文档不一致时，先改文档再改代码。

---

## 0. 文档索引

| 文档 | 内容 | 读者 |
|---|---|---|
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
| [14-open-questions.md](./14-open-questions.md) | 未确认项、默认假设、已知取舍 | 全体 |
| [15-gap-review.md](./15-gap-review.md) | **实现与文档差异审阅**：13 项 P0 / 39 项 P1 / 19 项 P2 + 逐条修改指导 | 全体 |
| [16-remediation-plan.md](./16-remediation-plan.md) | 修复批次 R0–R6、回归测试补充清单、验收状态快照 | 全体 / QA |
| [17-followup-review.md](./17-followup-review.md) | **复审报告（修复后第二轮）**：13 项 P0 已修复 12 项；新增 4 P0 / 13 P1 / 13 P2 + F0–F3 批次 | 全体 / QA |
| [18-review-round3.md](./18-review-round3.md) | **复审报告（第三轮）**：第二轮 4 项 P0 全部修复；新增 4 P0 / 4 P1 / 4 P2 + T0–T1 批次与形状断言建议 | 全体 / QA |
| [19-review-round4.md](./19-review-round4.md) | **复审报告（第四轮）**：第三轮 12 项关闭 11 项半，上下文连环模式被打断；新增 3 P0 / 4 P1 / 5 P2，全部集中在配置持久化层 + R0–R1 批次 | 全体 / QA |
| [20-review-round5.md](./20-review-round5.md) | **复审报告（第五轮）**：第四轮 12 项全部关闭；新增 3 P0 / 6 P1 / 15 P2，集中在「本地对象交给外部依赖」的交接点 + W0–W1 批次与跨边界契约测试建议 | 全体 / QA |
| [21-webui-coverage-gaps.md](./21-webui-coverage-gaps.md) | **WebUI 控制面覆盖缺口**：三轮整改后已清零（153/153 个已接线配置项可写、12 条端点缺口 + 后端 5 条 + `G-SSE-01` 全部完成）。动 WebUI 或从 `KNOWN_UNIMPLEMENTED_CONFIG_KEYS` 摘键之前先扫一眼 §1 的复算方法与 §5 的「不是缺口」清单 | 全体 / 运维 |
| [22-review-round6.md](./22-review-round6.md) | **复审报告（第六轮）**：第五轮 24 项关闭 23 项；按需求方要求**分三段**列出 10 项漏洞（2 P0 实测）、13 项设计缺陷、14 项可改进条目 + X0–X2 批次。主题是「资源上界」——`grep` 的正则回溯、沙箱 stdout、流式渲染、日志文件、定时任务异常五处都能拖垮单线程进程 | 全体 / QA / 安全 |
| [23-review-round6-remediation-report.md](./23-review-round6-remediation-report.md) | 第六轮整改的完成报告（由整改方提交）。**编号与 22 有错位，核对时以 22 的原始编号为准**，见 [24](./24-review-round6-verification.md) §1.2 | 全体 / QA |
| [25-round7-remediation.md](./25-round7-remediation.md) | **第七轮：把 25 份文档里所有 🚧 / 「未实现」标记逐条查干净**。不是再审一遍，而是核对既有标记：1 条是文档滞后、约 50 条真没做、5 条留着只会误导。结果是 `docs/09` 的 🚧 从 11 到 0、未接线配置键从 65 到 12、`docs/22 §4` 的 11 项未处理改进全部收口、`docs/13` 从 0/372 到 93/372 且勾选由断言约束。含一条**误报纠正**（`I-05`）—— 复审报告也会错，按错的诊断改出来的东西看起来同样像「已修复」 | 全体 / QA |
| [24-review-round6-verification.md](./24-review-round6-verification.md) | **第六轮整改的复核与返修**：24 项里 19 项是根因修复；`D-UI-01` 的拆分让 14 个控制台页面全部空白（已回退）、`D-APPR-01` 修在了永远走不到的分支上，另有 3 处新引入的回归 —— 7 项返修 `R-*` 及其回归用例。改渲染层/改「没有 X 时怎么办」之前先看 §0 | 全体 / QA |

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
| D10 | 沙箱 | **可开关**：`mode = none \| jail \| docker`；`bypassRoles=['owner']`（owner 宿主直跑）；非 owner 无沙箱时**工具直接禁用（fail-closed）** | [05](./05-tools-and-permissions.md#5-沙箱) |
| D11 | 私有记忆 | **每用户一份** `memory/private/<userId>/PRIMEMORY.md`；owner 可读写全部；群聊永不注入 | [06](./06-prompt-and-memory.md#3-作用域与注入矩阵) |
| D12 | 公开记忆 | **全局单一份** `memory/PUBMEMORY.md`（所有会话共享）；写入需 `pubWriteMinRole`（默认 `trusted`） | [06](./06-prompt-and-memory.md#3-作用域与注入矩阵) |
| D13 | Agent 通信 | **双向**：subagent 可 `ask_parent` 阻塞提问、`report_progress` 上报；`maxDepth=3` + 环路检测 + 待答超时 | [04](./04-agents-and-providers.md#4-agent-间通信) |
| D14 | 扩展生态 | **Anthropic SKILL.md 兼容 + JS/TS Plugin + MCP** | [07](./07-skills-plugins-mcp.md) |
| D15 | WebUI | **同进程内置**（Hono + 静态 SPA）+ 单管理员密码/Session + SSE 实时日志；默认仅监听 `127.0.0.1` | [09](./09-webui.md) |
| D16 | 多模态 | **图片 + 文档（pdf/txt/代码）**；语音/视频仅归档为占位符（不做 STT） | [08](./08-telegram-adapter.md#7-多模态) |
| D17 | 长任务 | **占位消息 + 进度编辑 + inline `/cancel`** | [08](./08-telegram-adapter.md#6-长任务与进度) |
| D18 | 输出方式 | **可配置，默认流式 `editMessageText`** | [08](./08-telegram-adapter.md#5-输出与流式) |
| D19 | 配额 | **记账 + 多级配额硬限**（global/chat/user，日/月，按角色覆盖），超额拒绝并提示 | [10](./10-logging-and-observability.md#5-配额) |
| D20 | 技术栈 | TypeScript / Node 22 / pnpm workspace / **AI SDK v7** / **grammY** / **Drizzle + better-sqlite3** / Hono / Vite + Vue 3（自建 UI 层）/ vitest | [01](./01-architecture.md#5-技术栈) |

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

不装 docker 也能跑，但执行类工具（`bash` 等）只剩 `sandbox.mode: none | jail` 两个选项，
且 `jail` 不是安全边界（[05 §5.4](./05-tools-and-permissions.md)）。注意 `bypassRoles` 在
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
