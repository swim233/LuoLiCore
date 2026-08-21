import { acpFailure, acpStopReasonError, type AcpFailure } from './errors.js';
import type { AcpAgentSettings } from './schema.js';
import type { ClientContext, SessionNotification, StopReason } from '@agentclientprotocol/sdk';

/**
 * M13 · 一次 `session/prompt` 的驱动：有界聚合 + 取消时序。
 *
 * **取消走的是协议**（`session/cancel` → 等 `stopReason: 'cancelled'` → 才收进程），不是 SIGTERM。
 * 直接杀进程会让一个正在写文件的 agent 死在半路 —— 而 ACP 明文规定 agent 收到 cancel 之后要
 * 停掉模型请求、abort 在途工具调用、把待发的 `session/update` 发完，然后才用 cancelled 应答。
 * 只有它不守规矩（grace 内不应答）时才落回关连接，那一步在 `manager.ts` 的关停梯上。
 */

/** `session/cancel` 之后等 `stopReason: 'cancelled'` 的宽限。等不到就放弃这次等待，交给关停梯。 */
export const ACP_CANCEL_GRACE_MS = 10_000;

export type AcpCancelReason = 'abort' | 'timeout' | 'cost';

export interface AcpUpdateSinkOptions {
  /** 一次 prompt 最多收多少条。撞上界后**只丢弃、不断连**（`agent.acp.maxUpdatesPerPrompt`）。 */
  maxUpdates: number;
  /** 聚合正文的字节上界。给 2× 最终预算，末尾那次从中间截断就能保住头尾（同 `runHarness`）。 */
  maxTextBytes: number;
  /** 累计花费上界，0 = 不限。 */
  maxCostUsd: number;
  /** 波 3 的呈现层挂在这里：每条 `session/update` 原样过一遍。**丢弃的那些不给它** ——
   *  上界的意义就是「后面这些我们不处理」，绕过上界喂给呈现层等于没有上界。 */
  onUpdate?: (notification: SessionNotification) => void;
}

/**
 * `session/update` 的落点。**有界**：条数、正文字节数、以及「撞上界之后怎么办」都在这里定。
 *
 * 不用 SDK 的 `ActiveSession`：它把 update 灌进一个**无界**异步队列，而喂它的是我们不信任其
 * 输出量的子进程（实测 86 秒的任务 263 条，其中 `agent_thought_chunk` 89 条）。
 */
export class AcpUpdateSink {
  updates = 0;
  dropped = 0;
  toolCalls = 0;
  thoughts = 0;
  /** `usage_update.cost.amount` 是**累计值**，所以取见过的最大值而不是求和。 */
  costUsd: number | null = null;
  contextUsed: number | null = null;
  contextSize: number | null = null;
  /** 撞上花费上界时调一次（只一次）。由 `runAcpPrompt` 装上，走的是 `session/cancel`。 */
  onOverBudget?: (() => void) | undefined;
  #text = '';
  #textBytes = 0;
  #textTruncated = false;
  #overBudget = false;

  constructor(private readonly options: AcpUpdateSinkOptions) {}

  accept(notification: SessionNotification): void {
    if (this.updates >= this.options.maxUpdates) { this.dropped += 1; return; }
    this.updates += 1;
    const update = notification.update;
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        // 只聚合 text：image / audio / resource 是不透明块，截半没有意义（同 docs/02 对不透明
        // part 的不变量）。波 3 的呈现层从 `onUpdate` 拿原件。
        if (update.content.type === 'text') this.#append(update.content.text);
        break;
      }
      // 思考链**不进聚合正文**：它是 agent 的内心戏，量级又是正文的几十倍（37–89 条 / 任务）。
      // 只记条数，好让呈现层与日志说得出「它想了多久」。
      case 'agent_thought_chunk': { this.thoughts += 1; break; }
      case 'tool_call': { this.toolCalls += 1; break; }
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
  /** 任务正文。**不经 shell、不进 argv** —— 它是 `session/prompt` 的一个 text content block。 */
  task: string;
  sink: AcpUpdateSink;
  abortSignal: AbortSignal;
  /** 连接关掉时 resolve。没有它的话，一个不应答 cancel 又不断连的 agent 能把这里挂到进程结束。 */
  closed: Promise<void>;
}

export interface AcpPromptOutcome {
  stopReason: StopReason | null;
  failure: AcpFailure | null;
  cancelReason: AcpCancelReason | null;
  /** `session/cancel` 真的发出去了。用例靠它证明取消走的是协议而不是信号。 */
  cancelSent: boolean;
}

/**
 * 跑一次 prompt。
 *
 * 正常路径上**不套任何 race**：`session/prompt` 自己会答，多一层 race 只会在它答之前先返回一个
 * 假结论。三条取消源（用户 abort / `timeoutMs` / `maxCostUsd`）各自先发 `session/cancel`，
 * 然后才起宽限计时 —— 反过来的话 grace 从「决定取消」而不是「取消已送达」起算。
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
    catch { /* 连接已经断了 —— 下面的 race 会从 `closed` 那一支出来 */ }
    grace = setTimeout(() => gaveUp.resolve(), ACP_CANCEL_GRACE_MS);
    grace.unref?.();
  };
  // **进门先看一眼有没有已经被取消。** 握手最长四跳 × `handshakeTimeoutMs`，`/cancel` 完全可能落在
  // 那一段里；此前这里只是「照发 `session/cancel` 再照发 `session/prompt`」—— 而 ACP 没有「预先
  // 取消」这个语义，agent 会把那条 cancel 丢掉、把任务整个跑完、答一句 `end_turn`，于是一轮**已经
  // 取消**的调用改完了整个仓库还报 ok:true，目录锁也一直被它按着。
  if (abortSignal.aborted) return { stopReason: null, failure: acpFailure('acp_cancelled'), cancelReason: 'abort', cancelSent: false };
  const onAbort = (): void => { void cancel('abort'); };
  sink.onOverBudget = () => { void cancel('cost'); };
  abortSignal.addEventListener('abort', onAbort, { once: true });
  // 握手期间就已经撞线的花费：`#overBudget` 那时已经置位，而 `onOverBudget` 还没装上 —— 那一位
  // 是一次性的，不在这里补一刀的话这次调用**永远不会**因为超预算被取消。
  if (sink.overBudget()) void cancel('cost');
  const deadline = setTimeout(() => { void cancel('timeout'); }, agent.timeoutMs);
  deadline.unref?.();
  try {
    const prompt = cx.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: options.task }] });
    // 判别字段叫 `via` 而不是 `kind`：本仓里「`kind` 冒号接一个字符串字面量」是日志事件的形状，
    // `tests/docs.test.ts` 按这个形状扫源码，会把它当成一个没进 `docs/10 §2` 那张表的日志 kind 报红。
    const raced = await Promise.race([
      prompt.then((response) => ({ via: 'response' as const, response }), (error: unknown) => ({ via: 'failed' as const, error })),
      gaveUp.promise.then(() => ({ via: 'gave_up' as const })),
      options.closed.then(() => ({ via: 'closed' as const })),
    ]);
    /**
     * **取消过就一定不算成功**，哪怕 agent 回的是 `end_turn`。
     *
     * 三条取消源各有自己的码：`timeout` / `cost` 的 hint 里有下一步该做什么，而 agent 只会如实回
     * 一句 cancelled —— 那句话对模型没有可操作性。`abort` 此前落在了「按 stopReason 判」那一支，
     * 于是「取消之后 agent 恰好跑完了」被报成 ok:true：文件已经被改，而这一轮本该是取消的。
     * 现在这一档如实交回 `acp_cancelled` + 真实的 `stopReason`，两件事都说得出来。
     */
    const cancelled = (): 'acp_timeout' | 'acp_cost_exceeded' | 'acp_cancelled' | null =>
      cancelReason === 'timeout' ? 'acp_timeout' : cancelReason === 'cost' ? 'acp_cost_exceeded' : cancelReason === 'abort' ? 'acp_cancelled' : null;
    if (raced.via === 'response') {
      const stopReason = raced.response.stopReason;
      const code = cancelled() ?? acpStopReasonError(stopReason);
      return { stopReason, failure: code ? acpFailure(code) : null, cancelReason, cancelSent };
    }
    if (raced.via === 'failed') return { stopReason: null, failure: acpFailure(cancelled() ?? 'acp_prompt_failed', raced.error), cancelReason, cancelSent };
    // 没答复就走到这里。取消过 = 它不守规矩（grace 内没有用 cancelled 应答）；没取消过 = 连接
    // 自己断了，那是 `acp_connection_lost`。manager 会用子进程的退出码与 stderr 把它补全。
    return { stopReason: null, failure: acpFailure(cancelled() ?? 'acp_connection_lost'), cancelReason, cancelSent };
  } finally {
    clearTimeout(deadline);
    if (grace) clearTimeout(grace);
    abortSignal.removeEventListener('abort', onAbort);
    sink.onOverBudget = undefined;
  }
}
