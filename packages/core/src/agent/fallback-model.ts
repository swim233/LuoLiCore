import { abortablePause, retryDelay } from "../provider/store.js";
import type { LanguageModel, LanguageModelMiddleware } from "ai";
type V4LanguageModel = Exclude<LanguageModel, string> & {
  specificationVersion: "v4";
};
import { wrapLanguageModel } from "ai";

export interface FallbackCandidate {
  model: V4LanguageModel;
  id: string;
  /**
   * `models.id`（唯一）。标记 down 属破坏性操作，不能依据 `id`（即 `model_id`）反查：同一个
   * `model_id` 可挂在两个 provider 下（本部署的 `deepseek-v4-flash` 同时存在于 ksm-api 与
   * deepseek-official），按名字反查会误判健康的那一个。
   */
  rowId?: string;
}

/**
 * 超时使用独立类型，而不要求调用方解析 message。`kind` 决定本次失败是否计入连续失败
 * （docs/04 §5.3）：只有超时视为上游无响应，429/5xx 表示上游有响应、401/403 属配置问题。
 * message 保持 `<label>_timeout_<ms>ms` 不变 —— 既有用例断言于此，日志摘要也据此区分两类超时。
 */
export class ProviderTimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label}_timeout_${ms}ms`);
    this.name = "ProviderTimeoutError";
  }
}

export interface CandidateFailure {
  /** 本次是该候选的第几次尝试（从 0 起）。 */
  attempt: number;
  kind: "timeout" | "status" | "network";
  status: number | null;
  /** 同一候选还将再尝试一次。 */
  willRetry: boolean;
  /** 不再尝试该候选，且链上仍有下一个。两者均为 false 表示本次失败将终止整条链。 */
  willFallback: boolean;
  elapsedMs: number;
  error: unknown;
}

export interface FallbackOptions {
  maxRetries: number;
  retryBaseMs: number;
  retryMaxMs: number;
  /**
   * 单次尝试从发出请求到收到响应头的上限（`provider.requestTimeoutMs`）。上游不设超时时该步骤
   * 可能永不返回：AI SDK 不处理，`http`/`fetch` 默认也不处理，唯一兜底是 10 分钟的
   * `concurrency.turnTimeoutMs` —— 表现为工具调用完成后 bot 不再输出，且日志中没有任何记录
   * （logs/2026-08-17 有 7 轮只有 turn.start 没有 turn.end，最后一条均停在此步）。
   */
  requestTimeoutMs?: number;
  /**
   * 流已建立但无输出的上限（`provider.streamIdleTimeoutMs`）。整体超时无法覆盖该情形：连接存活，
   * 但没有任何 token 到达。只统计等待下一个 chunk 的时间 —— 消费侧慢（正在执行工具）不计入。
   */
  streamIdleTimeoutMs?: number;
  abortSignal?: AbortSignal;
  /**
   * 已被判定为 `down` 的候选（`docs/04 §5.3`「从 fallback 链临时跳过」）。每次调用实时查询，
   * 因此同一轮内刚记满三次的链首在下一步即不再被尝试 —— 若等到下一次 `rebuild()` 才生效，
   * 一轮 12 步中每步都要耗满 `(maxRetries+1) × requestTimeoutMs`（本次事故为每步 363 秒）。
   *
   * 最后一个候选永不跳过：整条链均被标记 down 时，宁可发出一次注定失败的请求，也不能不发 ——
   * 否则调用方得到的是模型无输出，而非一个可识别的上游故障。
   */
  isDown?: (candidate: FallbackCandidate) => boolean;
  /** `to` 报告的是实际会被尝试的下一个候选（跳过已 down 的），而非链数组中的下一项。 */
  onFallback?: (from: FallbackCandidate, to: FallbackCandidate) => void;
  /**
   * 某个候选因已被判定为 `down` 而未被尝试。缺少该事件时，链 A→B→C 且 B 已 down 的情况下日志中
   * 只有 A → C（更早的实现更糟：记为 A → B 而实际服务的是 C），跳过行为不留任何痕迹，
   * 而当前哪个 provider 不在服务正是排障时首先要确认的（docs/10 · `provider.fallback`）。
   */
  onSkipped?: (
    candidate: FallbackCandidate,
    next: FallbackCandidate | undefined,
  ) => void;
  onUnavailable?: (candidate: FallbackCandidate, error: unknown) => void;
  /**
   * 每次失败的尝试报告一份（`docs/10` 为 `model.error` 定义的 `retryAttempt` / `willFallback` 即此）。
   * 缺少该事件时，三次尝试耗满超时后再 fallback 的过程在日志中是一段空白：本次事故的
   * 363 秒内只有开头的 `turn.start` 与结尾的 `provider.fallback`，中间过程需按
   * `3 × requestTimeoutMs + 退避` 反推。
   *
   * 调用方主动 abort 的那次不报告（`/cancel`、`turnTimeoutMs`）：那不是 provider 故障，
   * 记录会将健康的 provider 推向 `down`。
   */
  onCandidateFailed?: (
    candidate: FallbackCandidate,
    failure: CandidateFailure,
  ) => void;
  /**
   * 整条链尝试完毕仍失败、或流在中途断开时的最后一次报告。AI SDK 会把步骤级失败吞入内部的
   * onError，使 `result.text` 静默解析为空串 —— 若不在此处捕获，彻底的上游故障
   * 与模型无输出在调用方看来完全相同。
   */
  onExhausted?: (error: unknown) => void;
  /**
   * 实际服务本次调用的候选。包装之后 `step.model.modelId` 恒等于链首，
   * 若不报告，fallback 到第二个模型的步骤会按链首的价格与别名计费（docs/20 · W-LEDGER-01）。
   */
  onServed?: (candidate: FallbackCandidate) => void;
}

function statusCode(error: unknown): number | null {
  return error &&
    typeof error === "object" &&
    "statusCode" in error &&
    typeof error.statusCode === "number"
    ? error.statusCode
    : null;
}

function retryAfter(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  if (
    "responseHeaders" in error &&
    error.responseHeaders &&
    typeof error.responseHeaders === "object"
  ) {
    const value = (error.responseHeaders as Record<string, unknown>)[
      "retry-after"
    ];
    if (typeof value === "string") {
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

function describeFailure(
  error: unknown,
  attempt: number,
  startedAt: number,
  willRetry: boolean,
  willFallback: boolean,
): CandidateFailure {
  const status = statusCode(error);
  return {
    attempt,
    kind:
      error instanceof ProviderTimeoutError
        ? "timeout"
        : status !== null
          ? "status"
          : "network",
    status,
    willRetry,
    willFallback,
    elapsedMs: Date.now() - startedAt,
    error,
  };
}

/**
 * 每次尝试各自的中止预算：调用方的信号（用户取消 / 轮次超时）与本模块的超时合并后交给 provider。
 * 超时后 abort 的是本次尝试，因此重试与链内 fallback 照常进行；调用方的信号则是终止条件。
 */
export class AttemptDeadline {
  readonly #controller = new AbortController();
  readonly signal: AbortSignal;
  #timer: ReturnType<typeof setTimeout> | undefined;
  constructor(source: AbortSignal | undefined) {
    this.signal = source
      ? AbortSignal.any([source, this.#controller.signal])
      : this.#controller.signal;
  }
  /**
   * 超时后两件事都要做：abort 底层请求以释放连接，以及停止等待。仅 abort 不足够 ——
   * provider 实现不响应该 signal（第三方网关、自定义 fetch、SDK 版本差异）时该 promise
   * 永不 settle，调用仍会阻塞。被放弃的那次调用交由 GC 回收，其迟到的拒绝已被 race 接住。
   */
  async guard<T>(
    work: PromiseLike<T>,
    ms: number | undefined,
    label: string,
  ): Promise<T> {
    if (!ms) return await work;
    let expire!: (error: Error) => void;
    const expired = new Promise<never>((_, reject) => {
      expire = reject;
    });
    void expired.catch(() => undefined);
    this.#timer = setTimeout(() => {
      const error = new ProviderTimeoutError(label, ms);
      this.abort(error);
      expire(error);
    }, ms);
    try {
      return await Promise.race([Promise.resolve(work), expired]);
    } finally {
      this.disarm();
    }
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
 * 流级看门狗。计时仅在已向 provider 请求下一个 chunk 但尚未收到期间进行：`pull` 只有在消费侧
 * 实际取数时才被调用，因此本轮正在执行工具或投递侧正在节流都不会被误判为上游阻塞。
 * 超时后除使该流报错外，还要 abort 底层请求 —— 否则连接会保留至进程退出。
 * 中途失败一律不重试：文本可能已发出一部分，重发会导致用户看到两遍。
 */
function idleGuarded<T>(
  stream: ReadableStream<T>,
  idleMs: number | undefined,
  deadline: AttemptDeadline,
  caller: AbortSignal | undefined,
  onFailure?: (error: unknown) => void,
): ReadableStream<T> {
  if (!idleMs) return stream;
  const reader = stream.getReader();
  return new ReadableStream<T>({
    async pull(controller) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stalled = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new ProviderTimeoutError("stream_idle", idleMs);
          deadline.abort(error);
          reject(error);
        }, idleMs);
      });
      try {
        const next = await Promise.race([reader.read(), stalled]);
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        // 用户主动取消的那次不计为故障：上报会在日志中留下一条 model.error，并使空正文的
        // 轮次以上游故障而非已取消收尾。
        if (!caller?.aborted) onFailure?.(error);
        controller.error(error);
        void reader.cancel(error).catch(() => undefined);
      } finally {
        clearTimeout(timer);
      }
    },
    cancel: async (reason) => {
      await reader.cancel(reason);
    },
  });
}

export function fallbackLanguageModel(
  candidates: FallbackCandidate[],
  options: FallbackOptions,
): LanguageModel {
  const [first] = candidates;
  if (!first) throw new Error("fallback chain is empty");
  const reporting = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      options.onExhausted?.(error);
      throw error;
    }
  };
  /**
   * 跳过已 down 的候选后实际会被尝试的下一个。`onFallback` 的 `to` 必须报告该值：链 A→B→C
   * 且 B 已 down 时若报 B，日志记为 A → B 而实际服务的是 C —— 本中间件存在的理由之一即是
   * 使那 363 秒的空白可读，报告错误的链路比不报告更糟。跳过判据与下方两个循环共用一份，
   * 包括最后一个候选永不跳过这一条。
   */
  const nextServable = (index: number): FallbackCandidate | undefined => {
    for (let next = index + 1; next < candidates.length; next += 1) {
      if (next < candidates.length - 1 && options.isDown?.(candidates[next]!))
        continue;
      return candidates[next];
    }
    return undefined;
  };
  const middleware: LanguageModelMiddleware = {
    wrapGenerate: ({ params }) =>
      reporting(async () => {
        let last: unknown;
        for (let index = 0; index < candidates.length; index += 1) {
          const candidate = candidates[index]!;
          if (index < candidates.length - 1 && options.isDown?.(candidate)) {
            options.onSkipped?.(candidate, nextServable(index));
            continue;
          }
          const model = candidate.model;
          for (let attempt = 0; attempt <= options.maxRetries; attempt += 1) {
            const deadline = new AttemptDeadline(params.abortSignal);
            const startedAt = Date.now();
            try {
              const result = (await deadline.guard(
                model.doGenerate({ ...params, abortSignal: deadline.signal }),
                options.requestTimeoutMs,
                "request",
              )) as Awaited<ReturnType<V4LanguageModel["doGenerate"]>>;
              options.onServed?.(candidate);
              return result;
            } catch (error) {
              last = error;
              // 调用方的信号已中止（用户 /cancel、轮次超时）：继续尝试等于为无人等待的轮次占用槽位。
              if (params.abortSignal?.aborted) throw error;
              const status = statusCode(error);
              const willRetry =
                retriable(error) && attempt < options.maxRetries;
              options.onCandidateFailed?.(
                candidate,
                describeFailure(
                  error,
                  attempt,
                  startedAt,
                  willRetry,
                  !willRetry &&
                    retriable(error) &&
                    Boolean(candidates[index + 1]),
                ),
              );
              if (status === 401 || status === 403) {
                options.onUnavailable?.(candidate, error);
                throw error;
              }
              if (!retriable(error)) throw error;
              if (attempt < options.maxRetries)
                await abortablePause(
                  retryDelay(
                    attempt,
                    retryAfter(error),
                    options.retryBaseMs,
                    options.retryMaxMs,
                  ),
                  options.abortSignal,
                );
            }
          }
          const next = nextServable(index);
          if (next) options.onFallback?.(candidate, next);
        }
        throw last ?? new Error("all providers unavailable");
      }),
    wrapStream: ({ params }) =>
      reporting(async () => {
        let last: unknown;
        for (let index = 0; index < candidates.length; index += 1) {
          const candidate = candidates[index]!;
          if (index < candidates.length - 1 && options.isDown?.(candidate)) {
            options.onSkipped?.(candidate, nextServable(index));
            continue;
          }
          const model = candidate.model;
          for (let attempt = 0; attempt <= options.maxRetries; attempt += 1) {
            const deadline = new AttemptDeadline(params.abortSignal);
            const startedAt = Date.now();
            try {
              // guard 覆盖发出请求到收到响应头的阶段；此后监控的是下一个 chunk 是否到达，改用 idleGuarded。
              const result = (await deadline.guard(
                model.doStream({ ...params, abortSignal: deadline.signal }),
                options.requestTimeoutMs,
                "request",
              )) as Awaited<ReturnType<V4LanguageModel["doStream"]>>;
              options.onServed?.(candidate);
              // 流中途空转同样属于上游无响应，也要计入 —— 但此时已 return，报告只能由流内发出。
              return {
                ...result,
                stream: idleGuarded(
                  result.stream,
                  options.streamIdleTimeoutMs,
                  deadline,
                  params.abortSignal,
                  (error) => {
                    options.onCandidateFailed?.(
                      candidate,
                      describeFailure(error, attempt, startedAt, false, false),
                    );
                    options.onExhausted?.(error);
                  },
                ),
              };
            } catch (error) {
              last = error;
              if (params.abortSignal?.aborted) throw error;
              const status = statusCode(error);
              const willRetry =
                retriable(error) && attempt < options.maxRetries;
              options.onCandidateFailed?.(
                candidate,
                describeFailure(
                  error,
                  attempt,
                  startedAt,
                  willRetry,
                  !willRetry &&
                    retriable(error) &&
                    Boolean(candidates[index + 1]),
                ),
              );
              if (status === 401 || status === 403) {
                options.onUnavailable?.(candidate, error);
                throw error;
              }
              if (!retriable(error)) throw error;
              if (attempt < options.maxRetries)
                await abortablePause(
                  retryDelay(
                    attempt,
                    retryAfter(error),
                    options.retryBaseMs,
                    options.retryMaxMs,
                  ),
                  options.abortSignal,
                );
            }
          }
          const next = nextServable(index);
          if (next) options.onFallback?.(candidate, next);
        }
        throw last ?? new Error("all providers unavailable");
      }),
  };
  return wrapLanguageModel({ model: first.model, middleware });
}
