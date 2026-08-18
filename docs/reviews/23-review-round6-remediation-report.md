# 23 · 第六轮复审修复完成报告

> ❄️ **已冻结（2026-08-17 快照）** —— 本文只记录当轮的发现与整改，**不再更新**。文中所有
> 「未实现 / 未接线 / 仍然开着的」都是**当时**的状态，不代表现在；当前状态见
> [`00-state.md`](../00-state.md)。条目编号（`V-SSRF-01` 之类）是 240 处源码注释的溯源凭据，
> **不得重编号、不得删除**。

> 对照：`docs/22-review-round6.md`
> 范围：完成 §2「漏洞」与 §3「设计缺陷」；明确排除 §4「可改进条目」I-01～I-14。
> 结果：11 项漏洞、13 项设计缺陷全部完成；原复审文档未修改。

## 1. 修复结果

### 1.1 漏洞

| 编号 | 状态 | 完成内容 |
|---|---|---|
| V-DOS-01 | 已完成 | 文件 `grep` 与唤醒词统一改用 `re2-wasm`；限制表达式长度和扫描窗口，消除 JavaScript 正则回溯阻塞。 |
| V-DOS-02 | 已完成 | 沙箱对子进程 stdout/stderr 分别设置在线字节上限；达到上限立即终止进程组，并返回截断状态。 |
| V-SKILL-01 | 已完成 | skill 资源读取携带有效角色，执行阶段再次校验 skill/subagent 工具 allowlist，不能绕过权限边界。 |
| V-AUTH-01 | 已完成 | WebUI 密码验证读取当前配置；密码变更即时切换运行时 hash，并撤销当前会话之外的全部 session。 |
| V-AUTH-02 | 已完成 | XFF 按 `trustedProxyHops` 从右侧取可信地址；加入单 IP 桶、全局失败窗口、延迟响应及 1024 项有界清理；超长密码在 Argon2 前拒绝。 |
| V-SSRF-01 | 已完成 | provider 探测、provider 模型目录及 models.dev 目录统一接入受控出站请求：协议、端口、解析地址、重定向与响应体均受限。 |
| V-NET-01 | 已完成 | WebUI 默认监听回环地址；非回环监听必须配置密码。 |
| V-LOG-01 | 已完成 | provider/config 热更新后重新构建日志 secret 集合，轮换后的凭据继续脱敏。 |
| V-LOG-02 | 已完成 | 日志文件写入改为内存批次异步落盘；error/crash 强制刷新；关闭流程等待 flush。 |
| V-INFO-01 | 已完成 | 生产 API 错误使用稳定错误码和通用消息，详细异常只进入内部日志。 |
| V-CFG-01 | 已完成 | 生产环境要求 `LUOLI_MASTER_KEY` 和 Telegram token 通过环境变量提供，拒绝配置文件中的明文值。 |

### 1.2 设计缺陷

| 编号 | 状态 | 完成内容 |
|---|---|---|
| D-PLUGIN-01 | 已完成 | 插件目录文件会先被发现为禁用数据库记录；启用后可加载；补齐 `onMessage`、`onBeforeModel`、`onAfterModel`，卸载调用 `onUnload`。 |
| D-QUOTA-01 | 已完成 | 子 agent 每次模型步骤独立 reserve/commit/cancel；主 agent 释放 turn 配额状态，避免跨轮残留。 |
| D-STREAM-01 | 已完成 | 流式输出先按编辑节流判断，再做 Markdown 渲染；未到发送窗口不再重复渲染累计全文。 |
| D-APPR-01 | 已完成 | approval 开启但没有决策通道时立即拒绝，不再等待 180 秒；不创建无效 pending 记录。 |
| D-CFG-01 | 已完成 | per-chat `memory.pubWriteMinRole` 进入 allowlist、schema 校验与运行时授权。 |
| D-MEDIA-01 | 已完成 | 归档消息仅保存 `attachment://` 引用；上下文读取时从 attachment 文件按需恢复 data URL，不再把 base64 长期复制进消息归档。 |
| D-LOG-01 | 已完成 | 维护任务同时清理数据库日志、磁盘 JSONL、blob 载荷及过期 approvals/updates；受保留期和路径边界约束。 |
| D-OPS-01 | 已完成 | Scheduler 捕获每个任务的同步/异步失败并报告，单个维护任务不能形成未处理拒绝或击穿后续调度。 |
| D-OPS-02 | 已完成 | SSE 连接统一登记；abort/cancel/关机均清理 heartbeat、订阅与 stream；关机等待 server close 并有 grace-time 强制收口。 |
| D-EVENT-01 | 已完成 | EventBus 改为带映射的类型化事件接口；单个订阅者异常被隔离并报告，后续订阅者仍会收到事件。 |
| D-TOOL-01 | 已完成 | `ToolExecutionContext` 显式携带 subagent/skill allowlist；注册表执行前强制复验。 |
| D-ROLE-01 | 已完成 | Telegram `/new`、`/stop`、`/approve` 统一进入 `requireRole`，拒绝未授权调用。 |
| D-UI-01 | 已完成 | `ConsoleView.vue` 的页面模板拆为 15 个路由页模块和共享 composable；保留原有界面与交互，生产构建通过。 |

## 2. 关键回归覆盖

新增或扩展的回归覆盖包括：

- RE2 对灾难性回溯形状的线性执行，以及不兼容语法的配置拒绝；
- 沙箱双流输出上限和进程终止；
- skill 资源角色校验、subagent/skill 执行 allowlist；
- 密码轮换、可信代理跳数、失败桶边界、请求体长度；
- provider/catalog 出站防护；
- 插件无预置行发现、启用、重载和卸载；
- 无 approval 通道立即拒绝；
- attachment 引用持久化与上下文 hydration；
- scheduler 异常隔离、EventBus 订阅异常隔离、SSE 生命周期；
- Telegram 命令角色授权；
- WebUI 页面模块构建与控制台 API 合约。

## 3. 验证证据

| 检查 | 结果 |
|---|---|
| `pnpm typecheck` | 通过 |
| `pnpm lint` | 通过 |
| `pnpm test` | 通过：53 个测试文件，229 个测试 |
| `pnpm build` | 通过：WebUI 97 个模块完成 production build；6 个包产物生成 |
| `pnpm smoke` | 通过：`ok=true`，20 updates / 10 turns / 30 messages |
| 最终关键路径回归 | `tests/sse.events.test.ts` + `tests/trigger.test.ts`：2 文件 / 12 测试通过 |
| WebUI 实际表面 | 使用 agent-browser 打开 Vite 生产代码入口 `/login`；可访问树确认标题、密码输入框、登录按钮及主题按钮正常渲染 |

## 4. 范围说明

- 未修改 `docs/22-review-round6.md`。
- 未处理 §4 的 I-01～I-14；它们仍是后续可改进项，不计入本报告完成数。
- 本报告只陈述已实现并验证的 §2、§3 整改结果。
