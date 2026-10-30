# CLAUDE.md

LuoLiCore：群聊助手 agent，核心基于 Vercel AI SDK v7。术语见 `CONTEXT.md`，架构决策见 `docs/adr/`。

前身项目在 tag `archive/legacy-v0`（原 `main`）。新项目从零重写，旧代码只作参考，不复制。

## 当前阶段：CLI MVP

命令行里的基础对话。CLI 是开发调试前端，用于验证核心。

实现步骤（每步按「开发流程」推进）：

0. 准备：tag、本文件、`CONTEXT.md`、ADR
1. 脚手架：pnpm、ESM、Node ≥22、TypeScript strict、ESLint + Prettier（含 core 禁止引用 cli 的规则）、vitest
2. 模型接入：从环境变量创建 openai-compatible provider，按 `--model` 或 `LUOLI_MODEL` 选模型
3. 会话核心：`Conversation`（`append`、`reply`）、内存存储、`UIMessage` 加发言人 metadata、送模型前加名字、读取 `prompts/system.md`
4. CLI 循环：readline 读输入、调用 `reply()`、逐段打印文本、`/exit`
5. 中止：Ctrl+C 中止当前生成，半截回复保留并在 metadata 标记 `aborted`
6. 用量：每轮结束打印一行 token 用量

已定的实现选择：

- 单包：`src/core`、`src/cli`。core 不得引用 cli 或任何平台代码，由 lint 规则保证。
- 核心是进程内的库，`reply()` 输出 UI message stream。MVP 用 `streamText`，加工具时再换 `ToolLoopAgent`。
- provider 只接 openai-compatible。配置只来自环境变量与命令行参数：`LUOLI_BASE_URL`、`LUOLI_API_KEY`、`LUOLI_MODEL`，写在 `.env`。
- 测试：核心用 `ai/test` 的 mock 模型写行为测试，不调用真实 API；CLI 手动验证。

CLI 默认行为：

- 发言人名字：`--name` 指定，默认取系统用户名
- 送模型时的名字格式：`名字: 正文`
- 模型：`--model` 优先，其次 `LUOLI_MODEL`，都没有则报错退出
- 生成中按 Ctrl+C 中止；空闲时按 Ctrl+C 或 Ctrl+D 退出
- 模型调用出错：打印错误，程序不退出，用户消息保留在历史里
- 用量行：`tokens 输入 1234 · 输出 567`

MVP 非目标：工具调用、Markdown 渲染、显示 reasoning、多会话切换、持久化、Telegram 接入、HTTP 服务。

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

1. 主会话写 `.handoff/step-N/spec.md`：目标、范围、验收标准、不做的事。
2. dev 实现，回报写 `.handoff/step-N/dev-report.md`。
3. QA 审核，结论写 `.handoff/step-N/qa-report.md`。不通过则打回 dev，循环至通过。
4. 主会话读改动，向用户讲解：做了什么、为什么这样设计、代码从哪里读起。
5. 用户确认后，主会话提交。

- dev 与 QA 各一个，跨步骤用 SendMessage 续用；用户要求时新开。
- 纯文档步骤由主会话完成，用户直接审阅。
- 允许实际调用模型验证，每步少量调用。key 只在 `.env`，不得写进代码、日志、报告或对话。

## 提交

- 只在 `refactor` 分支提交，不推送。
- 标题格式 `type(scope): 中文短句`，如 `feat(core): 新增会话核心`。type 用 feat、fix、refactor、test、docs、chore；scope 取模块或领域名，如 core、cli、adr、build。
- 标题一行，不超过 50 字符，不加句号。需要时空一行写正文，说明改了什么、为什么，每行不超过 72 字符。
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
