import { acpFailure, acpStopReasonError, type AcpFailure } from './errors.js';
import type { AcpAgentSettings } from './schema.js';
import type { ClientContext, SessionNotification, StopReason } from '@agentclientprotocol/sdk';

/**
 * M13 · 一次 `session/prompt` 的驱动：有界聚合 + 取消时序。
 *
 * 取消走协议（`session/cancel` → 等待 `stopReason: 'cancelled'` → 再回收进程），而非 SIGTERM。
 * 直接终止进程会使正在写文件的 agent 中途退出 —— 而 ACP 规定 agent 收到 cancel 后应
 * 停止模型请求、abort 在途工具调用、发完待发的 `session/update`，然后以 cancelled 应答。
 * 只有它不遵守协议（grace 内不应答）时才退回关闭连接，该步骤在 `manager.ts` 的关停梯上。
 */

/** `session/cancel` 之后等待 `stopReason: 'cancelled'` 的宽限期。超时则放弃等待，交给关停梯。 */
export const ACP_CANCEL_GRACE_MS = 10_000;

/** `permission` 表示逐条审批的结论无法表达（agent 未提供可用档位），见 `acp_permission_unanswerable`。 */
export type AcpCancelReason = 'abort' | 'timeout' | 'cost' | 'permission';

export interface AcpUpdateSinkOptions {
  /** 一次 prompt 最多接收的条数。超限只丢弃、不断连（`agent.acp.maxUpdatesPerPrompt`）。 */
  maxUpdates: number;
  /** 聚合正文的字节上界。取最终预算的 2 倍，末尾一次从中间截断即可保留头尾（同 `runHarness`）。 */
  maxTextBytes: number;
  /** 累计花费上界，0 表示不限。 */
  maxCostUsd: number;
  /** 呈现层（Telegram 进度卡片）挂载于此：每条 `session/update` 原样经过一次。被丢弃的不传给它 ——
   *  上界的含义即超出部分不再处理，绕过上界喂给呈现层等于上界失效。 */
  onUpdate?: (notification: SessionNotification) => void;
}

/**
 * `session/update` 的落点，有界：条数、正文字节数以及超限后的处理方式均在此确定。
 *
 * 不使用 SDK 的 `ActiveSession`：它把 update 灌入无界异步队列，而数据源是输出量不可信的
 * 子进程（实测 86 秒的任务 263 条，其中 `agent_thought_chunk` 89 条）。
 */
export class AcpUpdateSink {
  updates = 0;
  dropped = 0;
  toolCalls = 0;
  thoughts = 0;
  /** agent 自身工具调用中报告 `failed` 的条数。进度卡片终帧需要它 —— 已完成与已完成但半数步骤失败
   *  在界面上必须是两种表述。有界：至多 `maxUpdatesPerPrompt` 条。 */
  failures = 0;
  /** `usage_update.cost.amount` 是累计值，因此取观察到的最大值而非求和。 */
  costUsd: number | null = null;
  contextUsed: number | null = null;
  contextSize: number | null = null;
  /** 触及花费上界时调用一次（仅一次）。由 `runAcpPrompt` 装配，走 `session/cancel`。 */
  onOverBudget?: (() => void) | undefined;
  /**
   * 逐条审批无法表达结论时由权限处理器调用一次，同样走 `session/cancel`。
   *
   * 挂在 sink 上是因为它已是贯穿全程的对象（`#run` 创建、`#open` 的处理器可获取、
   * `runAcpPrompt` 装配回调）—— 为它另建一个 holder 对象只会增加需一并传递的参数。
   * 与 `onOverBudget` 结构一致：只有 `runAcpPrompt` 装配它，未装配时调用为 no-op（握手期间
   * 收到的 permission 请求落在该窗口内，此时尚无 prompt 可取消）。
   */
  onPermissionUnanswerable?: (() => void) | undefined;
  #text = '';
  #textBytes = 0;
  #textTruncated = false;
  #overBudget = false;
  readonly #failedIds = new Set<string>();

  constructor(private readonly options: AcpUpdateSinkOptions) {}

  accept(notification: SessionNotification): void {
    if (this.updates >= this.options.maxUpdates) { this.dropped += 1; return; }
    this.updates += 1;
    const update = notification.update;
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        // 只聚合 text：image / audio / resource 是不透明块，截断无意义（同 docs/02 对不透明
        // part 的不变量）。呈现层从 `onUpdate` 获取原件，不受此处聚合影响。
        if (update.content.type === 'text') this.#append(update.content.text);
        break;
      }
      // 思考链不进入聚合正文：它是 agent 的中间推理，量级为正文的数十倍（37–89 条 / 任务）。
      // 只记录条数，使呈现层与日志能反映其推理时长。
      case 'agent_thought_chunk': { this.thoughts += 1; break; }
      // 失败按 `toolCallId` 去重：同一次调用先在 `tool_call` 中报 failed、再由 `tool_call_update`
      // 报一次 failed 是 agent 的常见写法，重复计数会使进度卡片终帧的数字为真实失败数的两倍。
      case 'tool_call': { this.toolCalls += 1; this.#failed(update.toolCallId, update.status); break; }
      case 'tool_call_update': { this.#failed(update.toolCallId, update.status); break; }
      case 'usage_update': {
        this.contextUsed = update.used;
        this.contextSize = update.size;
        const amount = update.cost?.amount;
        if (typeof amount === 'number') {
          this.costUsd = Math.max(this.costUsd ?? 0, amount);
          if (this.options.maxCostUsd > 0 && this.costUsd > this.options.maxCostUsd && !this.#overBudget) {
            this.#overBudget = true;
            this.onOverBudget?.();
          }
        }
        break;
      }
      default: break;
    }
    this.options.onUpdate?.(notification);
  }

  #failed(toolCallId: string | undefined, status: string | null | undefined): void {
    if (status !== 'failed' || !toolCallId || this.#failedIds.has(toolCallId)) return;
    this.#failedIds.add(toolCallId);
    this.failures += 1;
  }

  #append(text: string): void {
    if (this.#textBytes >= this.options.maxTextBytes) { this.#textTruncated = true; return; }
    this.#textBytes += Buffer.byteLength(text);
    this.#text += text;
  }

  text(): string { return this.#text; }
  textTruncated(): boolean { return this.#textTruncated; }
  overBudget(): boolean { return this.#overBudget; }
}

export interface AcpPromptOptions {
  agent: AcpAgentSettings;
  sessionId: string;
  /** 任务正文。不经 shell、不进 argv —— 它是 `session/prompt` 的一个 text content block。 */
  task: string;
  sink: AcpUpdateSink;
  abortSignal: AbortSignal;
  /** 连接关闭时 resolve。缺少它时，不应答 cancel 又不断连的 agent 会使此处阻塞至进程结束。 */
  closed: Promise<void>;
}

export interface AcpPromptOutcome {
  stopReason: StopReason | null;
  failure: AcpFailure | null;
  cancelReason: AcpCancelReason | null;
  /** `session/cancel` 已实际发出。用例据此验证取消走协议而非信号。 */
  cancelSent: boolean;
}

/**
 * 执行一次 prompt。
 *
 * 正常路径上不套任何 race：`session/prompt` 自身会应答，额外的 race 只会在其应答前返回
 * 错误结论。三条取消源（用户 abort / `timeoutMs` / `maxCostUsd`）均先发 `session/cancel`，
 * 之后才启动宽限计时 —— 顺序相反时 grace 会从决定取消而非取消已送达起算。
 */
export async function runAcpPrompt(cx: ClientContext, options: AcpPromptOptions): Promise<AcpPromptOutcome> {
  const { agent, sessionId, sink, abortSignal } = options;
  let cancelReason: AcpCancelReason | null = null;
  let cancelSent = false;
  const gaveUp = Promise.withResolvers<void>();
  let grace: ReturnType<typeof setTimeout> | undefined;
  const cancel = async (reason: AcpCancelReason): Promise<void> => {
    if (cancelReason) return;
    cancelReason = reason;
    try { await cx.notify('session/cancel', { sessionId }); cancelSent = true; }
    catch { /* 连接已断开 —— 下方的 race 会从 `closed` 分支返回 */ }
    grace = setTimeout(() => gaveUp.resolve(), ACP_CANCEL_GRACE_MS);
    grace.unref?.();
  };
  // 入口处先检查是否已被取消。握手最长四跳 × `handshakeTimeoutMs`，`/cancel` 完全可能落在
  // 该区间内；此前此处只是先发 `session/cancel` 再发 `session/prompt` —— 而 ACP 没有预先取消
  // 的语义，agent 会丢弃该 cancel、完整执行任务并以 `end_turn` 应答，导致一轮已取消的调用
  // 修改完整个仓库后仍报 ok:true，目录锁也持续被占用。
  if (abortSignal.aborted) return { stopReason: null, failure: acpFailure('acp_cancelled'), cancelReason: 'abort', cancelSent: false };
  const onAbort = (): void => { void cancel('abort'); };
  sink.onOverBudget = () => { void cancel('cost'); };
  sink.onPermissionUnanswerable = () => { void cancel('permission'); };
  abortSignal.addEventListener('abort', onAbort, { once: true });
  // 握手期间即已超出花费上界：`#overBudget` 此时已置位，而 `onOverBudget` 尚未装配 —— 该标志位
  // 是一次性的，若不在此处补一次触发，本次调用将永远不会因超预算被取消。
  if (sink.overBudget()) void cancel('cost');
  const deadline = setTimeout(() => { void cancel('timeout'); }, agent.timeoutMs);
  deadline.unref?.();
  try {
    const prompt = cx.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: options.task }] });
    // 判别字段命名为 `via` 而非 `kind`：本仓库中 `kind` 后接字符串字面量是日志事件的形态，
    // `tests/docs.test.ts` 按该形态扫描源码，会将其判定为未登记在 `docs/10 §2` 表中的日志 kind。
    const raced = await Promise.race([
      prompt.then((response) => ({ via: 'response' as const, response }), (error: unknown) => ({ via: 'failed' as const, error })),
      gaveUp.promise.then(() => ({ via: 'gave_up' as const })),
      options.closed.then(() => ({ via: 'closed' as const })),
    ]);
    /**
     * 发生过取消即不计为成功，即使 agent 返回 `end_turn`。
     *
     * 三条取消源各有独立错误码：`timeout` / `cost` 的 hint 包含后续操作指引，而 agent 只会返回
     * 一句 cancelled —— 该信息对模型不具可操作性。`abort` 此前落入按 stopReason 判定的分支，
     * 导致取消后 agent 恰好执行完成的情形被报为 ok:true：文件已被修改，而该轮本应为取消。
     * 现在该档如实返回 `acp_cancelled` 与真实的 `stopReason`，两项信息均可表达。
     */
    const cancelled = (): 'acp_timeout' | 'acp_cost_exceeded' | 'acp_permission_unanswerable' | 'acp_cancelled' | null =>
      cancelReason === 'timeout' ? 'acp_timeout' : cancelReason === 'cost' ? 'acp_cost_exceeded'
        : cancelReason === 'permission' ? 'acp_permission_unanswerable' : cancelReason === 'abort' ? 'acp_cancelled' : null;
    if (raced.via === 'response') {
      const stopReason = raced.response.stopReason;
      const code = cancelled() ?? acpStopReasonError(stopReason);
      return { stopReason, failure: code ? acpFailure(code) : null, cancelReason, cancelSent };
    }
    if (raced.via === 'failed') return { stopReason: null, failure: acpFailure(cancelled() ?? 'acp_prompt_failed', raced.error), cancelReason, cancelSent };
    // 无应答时进入此分支。发生过取消表示 agent 不遵守协议（grace 内未以 cancelled 应答）；
    // 未取消则表示连接自行断开，对应 `acp_connection_lost`。manager 会用子进程的退出码与 stderr 补全信息。
    return { stopReason: null, failure: acpFailure(cancelled() ?? 'acp_connection_lost'), cancelReason, cancelSent };
  } finally {
    clearTimeout(deadline);
    if (grace) clearTimeout(grace);
    abortSignal.removeEventListener('abort', onAbort);
    sink.onOverBudget = undefined;
    sink.onPermissionUnanswerable = undefined;
  }
}
