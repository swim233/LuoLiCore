import { GrammyError, type Bot } from "grammy";
import type { Update } from "grammy/types";

/**
 * 并发 long polling 驱动。
 *
 * grammY 内建的 `bot.start()` 串行处理 update（源码注释即 `handle updates sequentially (!)`），
 * 且在 `await handleUpdates(batch)` 完成后才发起下一次 `getUpdates`。后果是 `TurnConcurrency`
 * （`concurrency.global` / `perKey` / `queueMax`，docs/01 §3）不会被争用：入口一次只放行一条消息，
 * 队列恒为空，第二个用户需等待第一个用户的整轮结束，含模型流式输出与工具执行。
 * `concurrency.coalesceSameUserMs` 完全失效：被合并的消息要等前一条整轮结束才被读出，
 * 合并窗口已过期，`supersede` 不会发生。
 *
 * 因此由入口自行驱动：`bot.handleUpdate()` 是 grammY 为此用法提供的接口（其 JSDoc 指向 runner 插件）。
 * 本层只负责四项职责，其余仍由 grammY 中间件链处理：
 *
 * - 有界并发派发：在途 update 达到 `maxInFlight` 后停止拉取。背压回压至 `getUpdates`
 *   由 Telegram 侧保留，而非在进程内堆积待处理的媒体下载；
 * - offset 于派发时前移（语义同 grammY 的 `lastTriedUpdateId`）：崩溃会丢失在途的若干条，
 *   重复投递由 `processed_updates` 去重（`claimUpdate`），两种情形均不产生重复回复；
 * - 拉取错误按 grammY 策略退避：429 采用 `retry_after`，其余固定 3s；
 * - handler 错误必须在此收口。grammY 仅在自身轮询中将其路由至 `bot.catch`，自行派发需自行捕获；
 *   遗漏即 unhandledRejection，而 `main.ts` 的该路径会 `process.exit(1)` 终止整个进程。
 *
 * 顺序不由本层保证：同一 chat 的入口段（认领 → 归档）由 `bot.ts` 的 `KeyedMutex` 串行化，
 * 轮次本身才是可并行部分。
 */

/** Bot API 单次 `getUpdates` 的上限。 */
const MAX_BATCH = 100;
/** 拉取失败后的固定退避，与 grammY 的 `handlePollingError` 取同一个值。 */
const RETRY_SECONDS = 3;

export interface UpdatePollerOptions {
  allowedUpdates?: readonly string[];
  dropPendingUpdates?: boolean;
  /** 在途 update 上限。默认取 `concurrency.global + queueMax`：超出部分拉进来也只会被 `acquire` 拒绝。 */
  maxInFlight: number;
  /** long poll 的挂起秒数。 */
  timeoutSeconds?: number;
  onError: (error: unknown, phase: "fetch" | "handle") => void;
  /** 401 / 409：该 token 不应由本进程轮询，重试只会与另一实例互相抢占。 */
  onFatal: (error: unknown) => void;
}

export class UpdatePoller {
  #running = false;
  #offset = 0;
  #controller = new AbortController();
  #loop: Promise<void> | null = null;
  readonly #inFlight = new Set<Promise<void>>();
  readonly #maxInFlight: number;

  constructor(
    private readonly bot: Bot,
    private readonly options: UpdatePollerOptions,
  ) {
    this.#maxInFlight = Math.max(1, Math.trunc(options.maxInFlight));
  }

  get inFlight(): number {
    return this.#inFlight.size;
  }
  get running(): boolean {
    return this.#running;
  }
  /** 下一次 `getUpdates` 的 offset，供测试与运维排查使用。 */
  get offset(): number {
    return this.#offset;
  }

  /** 不返回 Promise：循环内部捕获全部错误，调用方没有可 await 的失败。 */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#controller = new AbortController();
    this.#loop = this.#run();
  }

  /** 停止拉取并将 offset 提交回 Telegram。不等待在途 handler，该职责属于 `drain`。 */
  async stop(): Promise<void> {
    if (!this.#running) return;
    this.#running = false;
    this.#controller.abort();
    await this.#loop?.catch(() => undefined);
    this.#loop = null;
    // 与 grammY 的 `stop()` 一致：确认 offset，避免重启后重新收取已派发的 update
    // （去重表可拦截，但重启后需先空跑一批 update 才能处理新消息）。
    if (this.#offset > 0)
      await this.bot.api
        .getUpdates({ offset: this.#offset, limit: 1, timeout: 0 })
        .catch(() => undefined);
  }

  /** 等待在途 handler 收尾，语义同 `TurnRegistry.drain`：宽限期内未排空则返回 false。 */
  async drain(graceMs: number, intervalMs = 25): Promise<boolean> {
    const deadline = Date.now() + graceMs;
    // 此处等待不能响应 abort 信号：`stop()` 之后信号已处于 aborted，响应会退化为忙等。
    while (this.#inFlight.size && Date.now() < deadline) {
      await Promise.race([
        ...this.#inFlight,
        sleep(Math.min(intervalMs, Math.max(1, deadline - Date.now()))),
      ]);
    }
    return this.#inFlight.size === 0;
  }

  async #run(): Promise<void> {
    // 先移除 webhook：设置过 webhook 的 token 调用 `getUpdates` 会持续返回 409，而 409 在下方被视为致命错误。
    // `drop_pending_updates` 也仅在此处生效（Bot API 将其挂在 deleteWebhook 上）。
    await this.bot.api
      .deleteWebhook(
        { drop_pending_updates: this.options.dropPendingUpdates ?? false },
        this.#signal(),
      )
      .catch((error: unknown) => this.options.onError(error, "fetch"));
    while (this.#running) {
      while (this.#running && this.#inFlight.size >= this.#maxInFlight)
        await Promise.race(this.#inFlight);
      if (!this.#running) break;
      const updates = await this.#fetch();
      if (!updates) break;
      for (const update of updates) {
        // 先前移 offset 再派发：派发同步启动、异步完成，若等 handler 结束才前移，
        // 同一批中靠后的若干条会在下一次拉取时重复出现。
        this.#offset = update.update_id + 1;
        this.#dispatch(update);
      }
    }
  }

  async #fetch(): Promise<Update[] | null> {
    const limit = Math.min(
      MAX_BATCH,
      Math.max(1, this.#maxInFlight - this.#inFlight.size),
    );
    while (this.#running) {
      try {
        return await this.bot.api.getUpdates(
          {
            offset: this.#offset,
            limit,
            timeout: this.options.timeoutSeconds ?? 30,
            ...(this.options.allowedUpdates
              ? { allowed_updates: [...this.options.allowedUpdates] as never }
              : {}),
          },
          this.#signal(),
        );
      } catch (error) {
        if (!this.#running) return null;
        if (
          error instanceof GrammyError &&
          (error.error_code === 401 || error.error_code === 409)
        ) {
          this.#running = false;
          this.options.onFatal(error);
          return null;
        }
        this.options.onError(error, "fetch");
        const retryAfter =
          error instanceof GrammyError && error.error_code === 429
            ? error.parameters.retry_after
            : undefined;
        await this.#backoff((retryAfter ?? RETRY_SECONDS) * 1000);
      }
    }
    return null;
  }

  #dispatch(update: Update): void {
    const task = this.bot
      .handleUpdate(update)
      .catch((error: unknown) => this.options.onError(error, "handle"));
    this.#inFlight.add(task);
    void task.finally(() => this.#inFlight.delete(task));
  }

  /** grammY 的 API 方法接收其自带的 abort-controller shim 类型，与原生 `AbortSignal` 不兼容。 */
  #signal(): never {
    return this.#controller.signal as never;
  }

  /** 可被 `stop()` 提前唤醒的退避：否则关停需等满 3s（或 `retry_after`）窗口。 */
  #backoff(ms: number): Promise<void> {
    const signal = this.#controller.signal;
    return new Promise<void>((resolve) => {
      const wake = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", wake);
        resolve();
      }, ms);
      timer.unref?.();
      signal.addEventListener("abort", wake, { once: true });
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
