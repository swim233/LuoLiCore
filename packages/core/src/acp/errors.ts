import { elideMiddleBytes } from '@luoli/shared';
import type { StopReason } from '@agentclientprotocol/sdk';

/**
 * M13 · ACP 子系统的错误码与提示文案。**一处定义** —— `manager.ts`、`session.ts` 与
 * `spawn_acp` 工具壳三处共用。
 *
 * 散成三份会慢慢漂，而 `docs/05 §3.5.1` 的错误契约表是它们的文档来源：「先改文档再改代码」只有在
 * 代码侧也只有一处时才验得动。`tests/acp.runtime.test.ts` 的「错误码与 docs/05 §3.5.1 的契约表逐条
 * 对得上」**解析那张表的第一列**再与这里比集合 —— 在测试里手抄一份数组会跟文档一起漂，等于没量。
 *
 * 每条 hint 写的是**下一步做什么**，不是「出错了」。这一层的读者是模型：它会把 hint 原样转述给
 * 用户，或者据此改参数重试一次；一句 `spawn failed` 换来的是原样重试，一次比一次贵。
 */
export const ACP_ERROR_HINTS = {
  acp_disabled: 'ACP 没打开：`agent.acp.enabled` 为 false，或者 `agent.acp.allowedDirs` 是空的（空 = 整个功能关闭）。要用先让运维在配置里列出允许的仓库路径。',
  // 与 `acp_disabled` 分开一档：那一档是「装了但关着，运维改配置就能用」，这一档是「这个运行时
  // 压根没装 ACP 客户端」，两者的下一步完全不同。`available()` 判的第一项就是它，所以生产里到不了
  // 这条（`main.ts` 恒传）—— 但工具壳那道二次硬拦截照旧要走同一份文案，不许自己另写一句。
  acp_unavailable: '这个运行时没有装 ACP 客户端，`spawn_acp` 做不了任何事。不是配置问题，别去改配置。',
  acp_no_agents: '`agent.acp.agents` 里一台启用的 agent 都没有。去配置页加一台（至少要 name 与 command），或把已有那台的 enabled 打开。',
  acp_agent_unknown: '没有这个名字的 agent（或者它被停用了）。按 schema 里 `agent` 参数列出的名字选一个，不要自己编。',
  acp_forbidden: '仅 owner 在私聊里可用。群里任何人的发言都是注入面，而它能改仓库。',
  acp_dir_not_allowed: '这个目录不在 `agent.acp.allowedDirs` 里。只能在白名单列出的路径（或其子目录）下跑。',
  acp_dir_missing: '这个路径不存在，或者不是一个目录。先确认它拼对了。',
  // 目录互斥不是「稍后重试」那种软失败：第一个调用可能还要跑十几分钟。让模型换个目录、或者
  // 如实告诉用户「上一个任务还在跑」，比原地排队更有用。
  acp_dir_busy: '同一个目录上已经有一个 ACP agent 在跑，等待超时。两个 agent 同时改一个仓库是实打实的危险，所以这里是硬互斥 —— 换个目录，或者等上一个跑完再说。',
  acp_spawn_failed: 'agent 的可执行文件起不来（通常是没装、或者 `command` 拼错、或者不在 PATH 上）。检查 `agent.acp.agents[].command`。',
  acp_handshake_failed: '进程起来了但 ACP 握手没成。它的 stderr 已经进日志（`acp.stderr`），去那里看它说了什么。',
  acp_handshake_timeout: '进程起来了但在 `handshakeTimeoutMs` 内没答完 initialize / session/new。子进程已被收掉，不会留孤儿。常见原因是它在等一个不存在的凭据。',
  acp_protocol_unsupported: '对方谈出来的 ACP 协议版本本客户端不支持。升级本项目，或把 agent 降回它支持 v1 的版本。',
  acp_auth_required: 'agent 说它需要先登录，而本客户端只会拿它已有的本机凭据试一次。去那台 agent 自己的 CLI 里登录一次（那件事在带外做，照 harness 的先例）。',
  // 单行上界是我们自己设的闸，不是对方的错 —— 但它确实意味着这次的产出拿不到了。
  acp_line_too_long: 'agent 吐了一行超过上界的 JSON-RPC（默认 8 MB），连接已中断。让它别把整份文件塞进一条消息 —— 换成分步做、或者让它把结果写进文件再告诉你路径。',
  acp_connection_lost: 'agent 进程在这一轮跑完之前就消失了。它的退出码与 stderr 已进日志（`acp.disconnect` / `acp.stderr`）。',
  acp_timeout: '超过 `agent.acp.agents[].timeoutMs` 还没跑完，已按协议发过 `session/cancel`。把任务拆小，或者让运维调大那一项（注意它不该大于 `concurrency.turnTimeoutMs`）。',
  acp_cancelled: '这一轮被取消了（用户 `/cancel`、或者 agent 自己报的 cancelled）。已经落地的文件改动**不会**回滚。',
  acp_cost_exceeded: '这次调用的累计花费撞上 `agent.acp.maxCostUsd`，已按协议发过 `session/cancel`。已经落地的文件改动不会回滚。要接着做就把任务拆小，或者让运维调高那一项。',
  // 下面三条是 StopReason 的非正常档。它们不是本系统的失败，但也不是「做完了」——
  // 说成 ok:true 会让模型据此向用户宣布任务完成（"摘除比伪造安全"，docs/16 §5）。
  acp_max_tokens: 'agent 把自己的上下文窗口用满了就停了，任务大概只做了一半。把任务拆成几次，或者给它换一个窗口更大的模型（`agent.acp.agents[].model`）。',
  acp_max_turn_requests: 'agent 撞上了它自己的单轮请求数上限就停了，任务大概只做了一半。把任务拆小。',
  acp_refusal: 'agent 拒绝了这个任务。别原样重试 —— 换个说法，或者如实告诉用户它拒绝了。',
  acp_prompt_failed: '`session/prompt` 本身报错了。原始报错在 `detail` 里，它的 stderr 在日志的 `acp.stderr` 里。',
  acp_session_failed: '`session/new` 报错了（agent 起来了、initialize 也过了，但它开不出会话）。最常见的是 `cwd` 它不接受。原始报错在 `detail` 里。',
} as const;

export type AcpErrorCode = keyof typeof ACP_ERROR_HINTS;

export interface AcpFailure {
  ok: false;
  error: AcpErrorCode;
  hint: string;
  /** 对方原话（已截短）。**不进 hint** —— hint 是我们写的、可以照着做的那一句，两者混在一起
   *  之后模型会把一段 JSON-RPC 报错当成操作指引。 */
  detail?: string;
}

/** 上界 512 **字节**（不是码元）：`detail` 是转述别人的话，不该跟正文抢 `maxOutputBytes` 的预算，
 *  而 `slice(0, 512)` 切的是 UTF-16 码元 —— 一段中文报错按那个切出来是 1536 字节。 */
const DETAIL_MAX_BYTES = 512;

export function acpFailure(code: AcpErrorCode, detail?: unknown): AcpFailure {
  const text = detail === undefined || detail === null ? ''
    : (detail instanceof Error ? detail.message : typeof detail === 'string' ? detail : JSON.stringify(detail)) ?? '';
  const clipped = text ? elideMiddleBytes(text, DETAIL_MAX_BYTES, (omitted) => `…（略去 ${omitted} 字节）…`).value : '';
  return { ok: false, error: code, hint: ACP_ERROR_HINTS[code], ...(clipped ? { detail: clipped } : {}) };
}

/**
 * StopReason 五档映射。**只有 `end_turn` 算成功。**
 *
 * 另外四档都是「停下来了，但不是因为做完了」：`max_tokens` / `max_turn_requests` 是产出被截断
 * （最危险的一档 —— 它长得最像成功），`refusal` 是对方不干，`cancelled` 是我们或它取消了。
 * 把它们并进 ok:true 的话，模型会拿着一份做了一半的改动向用户宣布完成。
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
