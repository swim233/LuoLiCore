# CLAUDE.md

LuoLiCore：群聊助手 agent，核心基于 Vercel AI SDK v7。术语见 `CONTEXT.md`，架构决策见 `docs/adr/`。

前身项目在 tag `archive/legacy-v0`（原 `main`）。新项目从零重写，旧代码只作参考，不复制。

## 当前阶段：第二阶段 · 持久化与 Telegram

第一阶段（CLI MVP：多轮对话、重试与日志、中止、用量）已完成。本阶段让会话落盘，并接入 Telegram 群聊。工具调用在 Telegram 跑通后另开一轮拷问。

实现步骤（每步按「开发流程」推进）：

1. 文档：本文件、`CONTEXT.md`、ADR-0004、ADR-0005
2. 持久化：SQLite 存储、会话与消息表、CLI `--resume`、`LUOLI_PROMPT`
3. 标签与超时：标签加 `uid`、`time`；超时
4. 分段与摘要：空闲切段、后台摘要与重启补做、超阈值压缩、system 拼装
5. 图片（core）：文件存储、消息里的图片发给模型
6. Telegram 基础：轮询、白名单、记录全部消息、触发、一次发出与引用、失败提示
7. Telegram 群聊细节：等待合并、回复中再触发、编辑、图片下载与占位、相册
8. 模型调用表：每次回复与摘要的用量、耗时与结果写进数据库
9. 提示词文件：内置提示搬到 `prompts/`，每次请求重读

已定的实现选择：

- 单包：`src/core`、`src/cli`，Telegram 前端另起目录。core 不得引用 cli 或任何平台代码，由 lint 规则保证。
- 核心是进程内的库，`reply()` 输出 UI message stream。现在用 `streamText`，加工具时再换 `ToolLoopAgent`。
- 存储：由 core 负责，SQLite（Node 自带的 `node:sqlite`），默认 `data/luoli.db`。表结构与取舍见 ADR-0005。core 的测试用内存存储。
- 上下文：按段拼接，见 ADR-0004。system 依次为人设、格式说明、会话标题、之前的摘要；之后是当前段的消息，只往后追加。空闲超过 4 小时切段，后台生成滚动摘要，重启后补做；上一轮输入超过 300k token 时压缩，保留最近 20 条。摘要请求沿用当前前缀，末尾追加摘要指令。数字均可配置。
- 送模型的用户消息：正文包在 `<message from="显示名" uid="发言人 id" time="2026-10-30 14:02">` 标签里，由 core 的格式化函数生成，以后的字段都加在这里。`uid` 只在平台提供不变的用户 id 时才有（CLI 没有）；`time` 按本机时区。正文只转义以 `<message`、`</message` 开头的 `<`，用户确认不再加严。core 在人设之后附上格式说明（`prompts/message-format.md`），逐个解释标签属性。
- 人设：`LUOLI_PROMPT` 指向人设文件（不进仓库），不设时用 `prompts/system.md`。
- 提示词文件：人设与内置提示都是文件。内置的在仓库 `prompts/`（按仓库位置找，不受启动目录影响）：消息格式说明、「当前会话」「之前的对话摘要」两节、摘要指令、三种摘要范围，一个提示一个文件，变量写成 `{{名字}}`。启动时全部读一遍并检查（缺文件、不认识的变量、漏了必需的变量），有错就退出；之后每次回复、每次摘要开始时重读，改完下一次请求就生效，期间的重试用同一份。运行中读到有错时，这次回复或摘要按失败处理，不写模型调用表。
- provider 只接 openai-compatible。配置只来自环境变量与命令行参数：`LUOLI_BASE_URL`、`LUOLI_API_KEY`、`LUOLI_MODEL` 等，写在 `.env`。
- 测试：核心用 `ai/test` 的 mock 模型写行为测试，不调用真实 API；CLI 与 Telegram 手动验证。
- 重试：用 AI SDK 内置重试，次数由 `LUOLI_MAX_RETRIES` 配置，默认 2。请求阶段（`maxRetries`）重试可重试错误；流式开始后服务端发来错误事件时也重试（`streamRetries`，次数相同），失败那次的半截不写入历史。连接中途断开不重试。
- 超时：等第一段输出超过 60 秒、或两段输出之间超过 30 秒，按失败处理（半截不写入）。由 `LUOLI_FIRST_CHUNK_TIMEOUT`、`LUOLI_CHUNK_TIMEOUT` 配置，单位秒。
- 模型调用出错：不写入助手消息，用户消息保留。
- 模型拒收图片：请求被拒（400、413、422）、还没有输出，且上一条助手回复之后有新图片时，把这些图片换成「[图片无法读取]」重试一次；重试没失败才把标记写进这些消息的 metadata，之后的请求都用占位。
- 中止：半截回复写入历史，metadata 标记 `aborted`；送模型时在副本末尾加「（回复被中止）」。一个字都没输出就被中止时不写入。
- 用量：回复正常完成时写入助手消息 metadata 的 `usage`（输入、输出、总数、缓存命中），只算最终成功的那次；中止、失败没有用量。
- 模型调用表：每次回复、每次摘要结束时（成功、失败、中止都算）在 `model_calls` 写一行（提示词文件出错、没发出请求的除外）：用途、模型、耗时、首字延迟、请求次数、结果、token（输入、缓存命中、输出、推理）、错误类型与状态码。不记金额。写入出错只记日志。表结构见 ADR-0005，常用查询在 `docs/queries/usage.sql`。
- 日志：pino 写 `logs/luoli.log`（JSON Lines）。记录调用失败、每次 HTTP 请求尝试、每轮回复概要；不记录对话正文；API key 抹为 `***`。core 只依赖 `Logger` 接口，不引用 pino。

CLI 默认行为：

- 会话：默认每次新开，`--resume` 接着上次的 CLI 会话
- 发言人名字：`--name` 指定，默认取系统用户名
- 模型：`--model` 优先，其次 `LUOLI_MODEL`，都没有则报错退出
- 生成中按 Ctrl+C 中止当前回复，另起一行打印「（已中止）」，程序不退出；生成期间的其他按键不显示、不保留
- 空闲时：这一行有字按 Ctrl+C 清空这一行；空行按 Ctrl+C 提示「再按一次 Ctrl+C 退出」，紧接着再按才退出；Ctrl+D 直接退出
- 模型调用出错：打印错误，程序不退出，用户消息保留在历史里
- 每次重试在终端打印一行，如「请求失败（429），重试中（1/2）」；流式中途重试时保留已输出的半截，另起一行打印「输出中断，重新生成（1/2）」
- 用量行：回复正常完成后打印 `tokens 输入 1234（缓存 1000）· 输出 567`，服务端报了缓存数才显示括号；中止、失败不打印
- 提示类输出（重试提示、「（已中止）」、退出提示、用量行）写 stderr，终端里用暗色，管道输出与设置了 `NO_COLOR` 时不加颜色

Telegram 前端行为：

- Chat SDK（`chat`、`@chat-adapter/telegram`），轮询收消息，平台状态用内存适配器。一个群（或私聊）对应一个会话；论坛话题暂不区分。
- 白名单：只在允许的群、允许的用户私聊时工作；其余消息忽略，日志只记来源 id。
- 记录群里全部消息：需在 BotFather 关闭隐私模式，再把 bot 移出群重新加入。
- 触发：@助手、回复助手的消息、私聊、唤醒词（默认 `nori`，不分大小写，可配置）。
- 等待合并：触发后 2 秒内群里还有新消息就继续等，最多 8 秒。等待和生成期间显示「正在输入」。
- 合并回复：每个会话有「空闲 / 等待 / 回复中」三种状态；回复中再被触发，只记下有人在等，当前回复发出后再回复一次，这次看到期间所有新消息，引用期间最后一条触发消息。
- 回复的位置：排在它生成时看到的最后一条消息之后，生成期间新来的消息排在它后面。
- 发送：生成完一次发出，引用触发消息。
- 图片：照片（取不超过 1280 像素的那档）、静态贴纸、图片文件发给模型；其他记成文字占位，如「[语音 0:12]」「[贴纸 😀]」「[文件 报告.pdf]」。相册合成一条消息；说明文字照常记录，也参与唤醒词判断。图片下载失败记成「[图片下载失败]」。
- 编辑：改历史里的正文，metadata 记编辑时间；编辑不触发回复。删除收不到，不处理。
- 失败：引用触发消息发一句固定提示（可配置）；错误详情只进日志。
- 离线积压：发送时间早于 1 小时前的触发只记录、不回复（`LUOLI_TELEGRAM_STALE_MINUTES`，默认 60）。
- 名字：标签里用显示名（名 + 姓），`uid` 用 Telegram 用户 id。

本阶段非目标：工具调用（下一阶段）、Markdown 渲染、显示 reasoning、webhook 与 HTTP 服务、多实例部署、看动图与视频、语音转文字、处理消息删除、成员表、CLI 多会话切换（只有 `--resume`）。

AI SDK v7 与旧版本的差异（以 https://ai-sdk.dev 为准）：`system` 改为 `instructions`；`onFinish` / `onStepFinish` 改为 `onEnd` / `onStepEnd`；`fullStream` 改为 `stream`；`toUIMessageStream` 是独立函数；messages 中的 system 消息默认被拒绝；完整历史取 `result.responseMessages`。

## 约束规则

- 核心不 import 任何平台代码。平台差异只存在于前端。
- 功能凭具体用例进入范围。非目标写进文档。
- 文档轻量：`CONTEXT.md` 术语表加必要的 ADR，不写多轮 review 文档。
- 新增依赖需说明用途并经用户确认。
- 测试只测行为，不写读源码文本做断言的测试。

## 开发流程

小步推进：每步一个可运行的增量，用户读懂并确认后再进入下一步。

角色：

- 主会话：写每步的 spec，派发 dev 与 QA，向用户讲解，提交。
- dev agent：`subagent_type: "general-purpose"`、`model: "opus"`。在主工作区的 `refactor` 分支上改代码，不提交。
- QA agent：另开，`model: "opus"`。对照 spec 与本文件审核改动，运行 typecheck、lint、test；涉及 CLI 的步骤实际运行验证。不改代码。

每步流程：

1. 主会话写 `.handoff/step-N/spec.md`（第二阶段为 `.handoff/phase-2/step-N/spec.md`）：目标、范围、验收标准、不做的事。
2. dev 实现，回报写在同目录 `dev-report.md`。
3. QA 审核，结论写在同目录 `qa-report.md`。不通过则打回 dev，循环至通过。
4. 主会话读改动，向用户讲解：做了什么、为什么这样设计、代码从哪里读起。
5. 用户确认后，主会话提交。

- dev 与 QA 各一个，跨步骤用 SendMessage 续用；用户要求时新开。
- 纯文档步骤由主会话完成，用户直接审阅。
- 允许实际调用模型验证，每步少量调用。key 只在 `.env`，不得写进代码、日志、报告或对话。
- 用户的人设文件只供程序读取，agent 不读其内容；查看请求时过滤 system。
- 测试产生的日志行用 `truncate -s` 原地截断（测试前记下字节数），不得移动、删除或替换 `logs/luoli.log`：正在运行的会话会继续写旧文件。

## 提交

- 只在 `refactor` 分支提交，不推送。
- 标题格式 `type(scope): 中文短句`，如 `feat(core): 新增会话核心`。type 用 feat、fix、refactor、test、docs、chore；scope 取模块或领域名，如 core、cli、adr、build。
- 只写标题一行，不超过 50 字符，不加句号，不写正文。
- 不加 `Co-Authored-By` 等任何署名行。

## 需求阶段（grill 拷问）

做法参考 `~/code/ProjectMilkRepo/workflow.md`「需求阶段」，实现参考 `~/code/ProjectMilkRepo/_domain/board/`。

- 新需求先拷问，用户确认实现清单后才动代码。
- 每轮问题做成可点选的 Artifact 决策台，不在终端列 Q1/Q2 文字题。终端只给链接和一行本轮摘要。
- 决策台交给**新开的 Sonnet agent** 写（`subagent_type: "general-purpose"`、`model: "sonnet"`）。主会话只写 brief：背景要点、题目、选项、推荐项、单选或多选、提交格式。
  - brief 存 `.grill/<主题>/brief-rN.md`，agent 读文件照做。
  - 后续轮次用 SendMessage 续用同一个 agent；它不在了就新开，brief 里给出 `url.txt` 的链接。
- 页面要求：
  - 每题一张卡：题号、标题、说明、选项卡片、补充说明文本框。推荐项标「推荐」，默认不预选。
  - 题目放在页面脚本的数据结构里，换轮只换数据和 `ROUND`。题目可带 `details` 列表。
  - 声明 capability `{"artifact": {}}`。提交用 files 形式 `artifact.publish({"answers-rN.json": …})`，只写答案文件，页面本体不变。
  - 答案格式：`{"round":N,"submitted_at":"<ISO>","answers":{"q1":{"choice":"A","note":""},"q2":{"choice":["a","b"],"note":""}}}`。单选为字母字符串，多选为字母数组；未答为 `null`，多选一项未选为 `[]`。
  - 允许改后重复提交，覆盖上一次。加载时读回本轮已发布的答案并回填；草稿存 localStorage，读写包 try/catch。
  - 简体中文，系统字体栈，页面本体小。
- 同一主题每轮发布到同一文件 `.grill/<主题>/index.html`，链接不变。链接记在 `.grill/<主题>/url.txt`，跨会话发布时带上该 `url`。
- 页面提交会生成新版本：再次发布前先 `Artifact read`，否则冲突。
- 用户在终端说明已提交后，主会话用 `Artifact read` 加 `path: "answers-rN.json"` 读答案，核对 `round`，复制一份到 `.grill/<主题>/`，再算下一轮。
- 最后一轮确认实现清单。执行安排默认按「开发流程」。
- `.grill/` 不进版本库。定下的结论写进正式文档。
