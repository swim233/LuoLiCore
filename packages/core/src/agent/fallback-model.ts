import { abortablePause, retryDelay } from '../provider/store.js';
import type { LanguageModel, LanguageModelMiddleware } from 'ai';
type V4LanguageModel = Exclude<LanguageModel, string> & { specificationVersion: 'v4' };
import { wrapLanguageModel } from 'ai';

export interface FallbackCandidate {
  model: V4LanguageModel;
  id: string;
}

export interface FallbackOptions {
  maxRetries: number;
  retryBaseMs: number;
  retryMaxMs: number;
  /**
   * 单次尝试从发出请求到拿到响应头的上限（`provider.requestTimeoutMs`）。上游不设超时时这一步
   * 可以永远不返回：AI SDK 不管，`http`/`fetch` 默认也不管，唯一兜底是 10 分钟的
   * `concurrency.turnTimeoutMs` —— 表现就是「工具调完之后 bot 再也不说话」，日志里连一行都没有
   * （logs/2026-08-17 有 7 轮只有 turn.start 没有 turn.end，最后一条都停在这一步）。
   */
  requestTimeoutMs?: number;
  /**
   * 流开着但不吐字的上限（`provider.streamIdleTimeoutMs`）。整体超时管不了这种情况：连接是活的，
   * 只是一个 token 都不来。只计「我们在等下一个 chunk」的时间 —— 消费侧慢（正在跑工具）不算。
   */
  streamIdleTimeoutMs?: number;
  abortSignal?: AbortSignal;
  onFallback?: (from: FallbackCandidate, to: FallbackCandidate) => void;
  onUnavailable?: (candidate: FallbackCandidate, error: unknown) => void;
  /**
   * 整条链都试完仍然失败、或流开到一半断掉时最后一次报告。AI SDK 会把步骤级失败吞进内部的
   * onError，让 `result.text` 安静地解析成空串 —— 不在这里抓一份，一次彻底的上游故障
   * 和「模型没话说」在调用方眼里就长得一模一样。
   */
  onExhausted?: (error: unknown) => void;
  /**
   * 实际服务了这一次调用的候选。包装之后 `step.model.modelId` 恒等于链首，
   * 不报一份的话，fallback 到第二个模型的那些步会被按链首的价格与别名记账（docs/20 · W-LEDGER-01）。
   */
  onServed?: (candidate: FallbackCandidate) => void;
}

function statusCode(error: unknown): number | null {
  return error && typeof error === 'object' && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : null;
}

function retryAfter(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  if ('responseHeaders' in error && error.responseHeaders && typeof error.responseHeaders === 'object') {
    const value = (error.responseHeaders as Record<string, unknown>)['retry-after'];
    if (typeof value === 'string') {
      const seconds = Number(value);
      if (Number.isFinite(seconds)) return seconds * 1000;
    }
  }
  return null;
}

function retriable(error: unknown): boolean {
  const status = statusCode(error);
  return status === null || status === 429 || status >= 500;
}

/**
 * 每次尝试自己的中止预算：调用方的信号（用户取消 / 轮次超时）与我们的超时合成一个，交给 provider。
 * 到点后 abort 的是**这一次尝试**，所以重试与链内 fallback 照常走；调用方的信号则是终点。
 */
class AttemptDeadline {
  readonly #controller = new AbortController();
  readonly signal: AbortSignal;
  #timer: ReturnType<typeof setTimeout> | undefined;
  constructor(source: AbortSignal | undefined) {
    this.signal = source ? AbortSignal.any([source, this.#controller.signal]) : this.#controller.signal;
  }
  /**
   * 到点后两件事都要做：abort 底层请求（释放连接），**以及停止等待**。只 abort 是不够的 ——
   * provider 实现不认这个 signal（第三方网关、自定义 fetch、SDK 版本差异）时那个 promise
   * 永远不 settle，我们就还是原地挂着。丢下的那次调用交给 GC，它晚到的拒绝已经被 race 接住。
   */
  async guard<T>(work: PromiseLike<T>, ms: number | undefined, label: string): Promise<T> {
    if (!ms) return await work;
    let expire!: (error: Error) => void;
    const expired = new Promise<never>((_, reject) => { expire = reject; });
    void expired.catch(() => undefined);
    this.#timer = setTimeout(() => { const error = new Error(`${label}_timeout_${ms}ms`); this.abort(error); expire(error); }, ms);
    try { return await Promise.race([Promise.resolve(work), expired]); } finally { this.disarm(); }
  }
  disarm(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
  }
  abort(error: Error): void {
    this.disarm();
    this.#controller.abort(error);
  }
}

/**
 * 流级看门狗。计时只在「已经向 provider 要下一个 chunk、还没拿到」期间跑：`pull` 只有在消费侧
 * 真的来取时才被调用，所以本轮正在执行工具、或投递侧在节流，都不会被误判成上游卡死。
 * 到点后除了让这条流报错，还要 abort 底层请求 —— 否则连接留着，进程退出前都不会释放。
 * 中途失败一律不重试：文字可能已经发出去一半，重发等于让用户看到两遍。
 */
function idleGuarded<T>(stream: ReadableStream<T>, idleMs: number | undefined, deadline: AttemptDeadline, caller: AbortSignal | undefined, onFailure?: (error: unknown) => void): ReadableStream<T> {
  if (!idleMs) return stream;
  const reader = stream.getReader();
  return new ReadableStream<T>({
    async pull(controller) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stalled = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { const error = new Error(`stream_idle_timeout_${idleMs}ms`); deadline.abort(error); reject(error); }, idleMs);
      });
      try {
        const next = await Promise.race([reader.read(), stalled]);
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        // 用户自己取消掉的那一次不算故障：报上去会在日志里留一条 model.error，也会让空正文的
        // 轮次以「上游挂了」而不是「已取消」收尾。
        if (!caller?.aborted) onFailure?.(error);
        controller.error(error);
        void reader.cancel(error).catch(() => undefined);
      } finally { clearTimeout(timer); }
    },
    cancel: async (reason) => { await reader.cancel(reason); },
  });
}

export function fallbackLanguageModel(candidates: FallbackCandidate[], options: FallbackOptions): LanguageModel {
  const [first] = candidates;
  if (!first) throw new Error('fallback chain is empty');
  const reporting = async <T>(run: () => Promise<T>): Promise<T> => {
    try { return await run(); }
    catch (error) { options.onExhausted?.(error); throw error; }
  };
  const middleware: LanguageModelMiddleware = {
    wrapGenerate: ({ params }) => reporting(async () => {
      let last: unknown;
      for (let index = 0; index < candidates.length; index += 1) {
        const candidate = candidates[index]!;
        const model = candidate.model;
        for (let attempt = 0; attempt <= options.maxRetries; attempt += 1) {
          const deadline = new AttemptDeadline(params.abortSignal);
          try { const result = await deadline.guard(model.doGenerate({ ...params, abortSignal: deadline.signal }), options.requestTimeoutMs, 'request') as Awaited<ReturnType<V4LanguageModel['doGenerate']>>; options.onServed?.(candidate); return result; }
          catch (error) {
            last = error;
            // 调用方的信号已经断了（用户 /cancel、轮次超时）：再试就是替一个没人等的轮次占着槽位。
            if (params.abortSignal?.aborted) throw error;
            const status = statusCode(error);
            if (status === 401 || status === 403) { options.onUnavailable?.(candidate, error); throw error; }
            if (!retriable(error)) throw error;
            if (attempt < options.maxRetries) await abortablePause(retryDelay(attempt, retryAfter(error), options.retryBaseMs, options.retryMaxMs), options.abortSignal);
          }
        }
        const next = candidates[index + 1];
        if (next) options.onFallback?.(candidate, next);
      }
      throw last ?? new Error('all providers unavailable');
    }),
    wrapStream: ({ params }) => reporting(async () => {
      let last: unknown;
      for (let index = 0; index < candidates.length; index += 1) {
        const candidate = candidates[index]!;
        const model = candidate.model;
        for (let attempt = 0; attempt <= options.maxRetries; attempt += 1) {
          const deadline = new AttemptDeadline(params.abortSignal);
          try {
            // guard 覆盖「发出请求到拿到响应头」；之后盯的是「有没有下一个 chunk」，换 idleGuarded。
            const result = await deadline.guard(model.doStream({ ...params, abortSignal: deadline.signal }), options.requestTimeoutMs, 'request') as Awaited<ReturnType<V4LanguageModel['doStream']>>;
            options.onServed?.(candidate);
            return { ...result, stream: idleGuarded(result.stream, options.streamIdleTimeoutMs, deadline, params.abortSignal, options.onExhausted) };
          }
          catch (error) {
            last = error;
            if (params.abortSignal?.aborted) throw error;
            const status = statusCode(error);
            if (status === 401 || status === 403) { options.onUnavailable?.(candidate, error); throw error; }
            if (!retriable(error)) throw error;
            if (attempt < options.maxRetries) await abortablePause(retryDelay(attempt, retryAfter(error), options.retryBaseMs, options.retryMaxMs), options.abortSignal);
          }
        }
        const next = candidates[index + 1];
        if (next) options.onFallback?.(candidate, next);
      }
      throw last ?? new Error('all providers unavailable');
    }),
  };
  return wrapLanguageModel({ model: first.model, middleware });
}
