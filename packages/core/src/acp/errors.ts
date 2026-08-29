import { elideMiddleBytes } from '@luoli/shared';
import type { StopReason } from '@agentclientprotocol/sdk';

/**
 * M13 · ACP 子系统的错误码与提示文案，单点定义，由 `manager.ts`、`session.ts` 与
 * `spawn_acp` 工具壳三处共用。
 *
 * 分散成三份会逐渐漂移，而 `docs/05 §3.5.1` 的错误契约表是它们的文档来源：先改文档再改代码这条
 * 规则只有在代码侧同样单点时才可验证。`tests/acp.runtime.test.ts` 中错误码与 docs/05 §3.5.1 契约表
 * 逐条对齐那条用例解析该表的第一列再与这里比对集合；在测试里手抄一份数组会与文档一同漂移，等于未验证。
 *
 * 每条 hint 写的是下一步做什么，而非仅声明出错。这一层的读者是模型：它会把 hint 原样转述给
 * 用户，或据此修改参数重试一次；一句 `spawn failed` 换来的是原样重试，且一次比一次昂贵。
 */
export const ACP_ERROR_HINTS = {
  acp_disabled: 'ACP 未启用：`agent.acp.enabled` 为 false，或 `agent.acp.allowedDirs` 为空（空列表即整个功能关闭）。需管理员在配置中列出允许的仓库路径。',
  // 与 `acp_disabled` 分为两档：那一档表示已安装但被关闭，运维改配置即可使用；这一档表示该运行时
  // 未安装 ACP 客户端，两者的后续处理完全不同。`available()` 判定的第一项就是它，因此生产环境到不了
  // 这一条（`main.ts` 恒传），但工具壳的二次硬拦截仍要复用同一份文案，不得另写。
  acp_unavailable: '当前运行时未安装 ACP 客户端，`spawn_acp` 不可用。这不是配置问题，请勿修改配置。',
  acp_no_agents: '`agent.acp.agents` 中没有已启用的 agent。请在配置页新增一个（至少填写 name 与 command），或将已有条目的 enabled 置为 true。',
  acp_agent_unknown: '不存在该名称的 agent，或它已停用。请从 schema 中 `agent` 参数列出的名称里选择，不要自行构造。',
  acp_forbidden: '仅 owner 在私聊中可用。群聊消息属于注入面，而该工具可修改仓库。',
  acp_dir_not_allowed: '该目录不在 `agent.acp.allowedDirs` 中。只能在白名单列出的路径及其子目录下执行。',
  acp_dir_missing: '该路径不存在，或不是目录。请先确认路径拼写。',
  // 目录互斥不是可稍后重试的软失败：第一个调用可能还要运行十几分钟。让模型更换目录，或者
  // 如实告知用户上一个任务仍在运行，比原地排队更有价值。
  acp_dir_busy: '该目录上已有一个 ACP agent 在运行，等待超时。两个 agent 同时修改同一仓库风险很高，此处为硬互斥。请更换目录，或等待上一次调用结束。',
  acp_spawn_failed: 'agent 的可执行文件无法启动（常见原因：未安装、`command` 拼写错误、不在 PATH 中）。请检查 `agent.acp.agents[].command`。',
  acp_handshake_failed: '进程已启动，但 ACP 握手失败。其 stderr 已记入日志 `acp.stderr`，请在该处查看原因。',
  acp_handshake_timeout: '进程已启动，但未在 `handshakeTimeoutMs` 内完成 initialize / session/new。子进程已回收，不留孤儿进程。常见原因是它在等待一个不存在的凭据。',
  acp_protocol_unsupported: '本客户端不支持对方协商出的 ACP 协议版本。请升级本项目，或将 agent 降级到支持 v1 的版本。',
  acp_auth_required: 'agent 要求先登录，而本客户端只以它已有的本机凭据尝试一次。请在该 agent 自身的 CLI 中登录一次（带外操作，照 harness 的先例）。',
  // 单行上界是本系统设置的闸，不是对方的问题，但它确实意味着本次产出无法取得。
  acp_line_too_long: 'agent 输出的单行 JSON-RPC 超过上界（默认 8 MB），连接已中断。请勿让它把整份文件放进一条消息：改为分步执行，或让它把结果写入文件后返回路径。',
  acp_connection_lost: 'agent 进程在本轮结束之前已退出。其退出码与 stderr 已记入日志 `acp.disconnect` / `acp.stderr`。',
  acp_timeout: '执行超过 `agent.acp.agents[].timeoutMs` 仍未结束，已按协议发送 `session/cancel`。请拆分任务，或由管理员调大该项（不应大于 `concurrency.turnTimeoutMs`）。',
  acp_cancelled: '本轮已取消（用户 `/cancel`，或 agent 自行报告 cancelled）。已写入的文件改动**不会**回滚。',
  acp_cost_exceeded: '本次调用的累计花费达到 `agent.acp.maxCostUsd`，已按协议发送 `session/cancel`。已写入的文件改动不会回滚。如需继续，请拆分任务或由管理员调高该项。',
  // 逐条审批（`permissionMode: ask`）的一种硬失败：结论已产生，但 agent 给出的 options 中没有一项能
  // 表达它。不返回 `cancelled` 伪装成取消：该词的协议含义是 client 取消了这一轮，
  // 把人工拒绝表述为用户取消会让 agent 误记本轮实际发生的事（前者应停止、后者应等待下一
  // 条指令）。因此该请求返回一个 JSON-RPC error，再按协议取消整轮，最后落到这个码上。
  acp_permission_unanswerable: 'agent 的权限请求未提供可表达本次结论的选项（通常是缺少拒绝档），本轮已按协议取消。这是该 agent 的协议实现缺陷，请勿原样重试：将 `agent.acp.permissionMode` 设为 `deny` 可稳定拒绝，或向其上游反馈。',
  // 下面三条是 StopReason 的非正常档。它们不属于本系统的失败，但也不代表任务完成：
  // 报成 ok:true 会让模型据此向用户宣布任务完成（"摘除比伪造安全"，docs/16 §5）。
  acp_max_tokens: 'agent 的上下文窗口耗尽而停止，任务可能只完成了一部分。请拆分为多次执行，或改用上下文窗口更大的模型（`agent.acp.agents[].model`）。',
  acp_max_turn_requests: 'agent 达到自身的单轮请求数上限而停止，任务可能只完成了一部分。请拆分任务。',
  acp_refusal: 'agent 拒绝了该任务。请勿原样重试：更换表述，或如实告知用户它已拒绝。',
  acp_prompt_failed: '`session/prompt` 调用失败。原始报错见 `detail`，其 stderr 见日志 `acp.stderr`。',
  acp_session_failed: '`session/new` 失败（进程已启动、initialize 已通过，但无法建立会话）。最常见的原因是它不接受给定的 `cwd`。原始报错见 `detail`。',
} as const;

export type AcpErrorCode = keyof typeof ACP_ERROR_HINTS;

export interface AcpFailure {
  ok: false;
  error: AcpErrorCode;
  hint: string;
  /** 对方的原始报错（已截短）。不并入 hint：hint 是本系统给出的可执行指引，两者混在一起
   *  会让模型把一段 JSON-RPC 报错当成操作指引。 */
  detail?: string;
}

/** 上界为 512 字节（而非码元）：`detail` 转述的是外部报错，不应与正文争抢 `maxOutputBytes` 预算，
 *  而 `slice(0, 512)` 截取的是 UTF-16 码元，一段中文报错按其截取后是 1536 字节。 */
const DETAIL_MAX_BYTES = 512;

export function acpFailure(code: AcpErrorCode, detail?: unknown): AcpFailure {
  const text = detail === undefined || detail === null ? ''
    : (detail instanceof Error ? detail.message : typeof detail === 'string' ? detail : JSON.stringify(detail)) ?? '';
  const clipped = text ? elideMiddleBytes(text, DETAIL_MAX_BYTES, (omitted) => `…（略去 ${omitted} 字节）…`).value : '';
  return { ok: false, error: code, hint: ACP_ERROR_HINTS[code], ...(clipped ? { detail: clipped } : {}) };
}

/**
 * StopReason 五档映射，只有 `end_turn` 视为成功。
 *
 * 另外四档都属于已停止但未完成：`max_tokens` / `max_turn_requests` 是产出被截断
 * （最危险的一档，外观最接近成功），`refusal` 是对方拒绝执行，`cancelled` 是任一方取消。
 * 将它们并入 ok:true 会让模型带着一份只完成一半的改动向用户宣布完成。
 */
export function acpStopReasonError(stopReason: StopReason): AcpErrorCode | null {
  switch (stopReason) {
    case 'end_turn': return null;
    case 'max_tokens': return 'acp_max_tokens';
    case 'max_turn_requests': return 'acp_max_turn_requests';
    case 'refusal': return 'acp_refusal';
    case 'cancelled': return 'acp_cancelled';
  }
}
