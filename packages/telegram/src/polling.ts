import { GrammyError, type Bot } from 'grammy';
import type { Update } from 'grammy/types';

/**
 * 并发的 long polling 驱动。
 *
 * grammY 内建的 `bot.start()` **逐条串行**处理 update（`bot.js` 里那行注释就写着
 * `handle updates sequentially (!)`），而且整个拉取循环 `await handleUpdates(batch)`
 * 之后才发下一次 `getUpdates`。后果是 `TurnConcurrency`（`concurrency.global` / `perKey`
 * / `queueMax`，docs/01 §3）根本没有机会争用：入口一次只放一条消息进来，队列永远是空的，
 * 第二个人得等第一个人的整轮跑完 —— 包括模型流式输出和工具执行。
 * `concurrency.coalesceSameUserMs` 更是彻底失效：被合并的那条消息要等前一条**整轮结束**
 * 才会被读出来，等窗口早就过了，`supersede` 永远不会发生。
 *
 * 所以入口自己驱动：`bot.handleUpdate()` 是 grammY 明确留给这种用法的接口（它的 JSDoc
 * 直接指向 runner 插件）。这里只做四件事，其余仍由 grammY 的中间件链负责：
 *
 * - 并发派发，**有界**：在途 update 到 `maxInFlight` 就不再拉新的。backpressure 压回
 *   `getUpdates`（Telegram 替我们留着），而不是在进程里堆一堆待办的媒体下载；
 * - offset 在派发时前移（与 grammY 的 `lastTriedUpdateId` 同语义）：崩溃会丢在途的那几条，
 *   但重复投递由 `processed_updates` 去重（`claimUpdate`），两边都不会变成重复回复；
 * - 拉取错误按 grammY 的策略退避：429 认 `retry_after`，其余固定 3s；
 * - **handler 的错误必须在这里收口**。grammY 只在自家轮询里把它路由到 `bot.catch`，
 *   自己派发就得自己接 —— 漏一个就是 unhandledRejection，而 `main.ts` 那条路径会直接
 *   `process.exit(1)` 带走整个进程。
 *
 * 顺序不在这一层保证：同一个 chat 的入口段（认领 → 归档）由 `bot.ts` 里的 `KeyedMutex`
 * 串起来，轮次本身才是可以并行的那部分。
 */

/** Bot API 单次 `getUpdates` 的上限。 */
const MAX_BATCH = 100;
/** 拉取失败后的固定退避，与 grammY 的 `handlePollingError` 取同一个值。 */
const RETRY_SECONDS = 3;

export interface UpdatePollerOptions {
  allowedUpdates?: readonly string[];
  dropPendingUpdates?: boolean;
  /** 在途 update 上限。默认取 `concurrency.global + queueMax`：再多拉进来也只会被 `acquire` 拒掉。 */
  maxInFlight: number;
  /** long poll 的挂起秒数。 */
  timeoutSeconds?: number;
  onError: (error: unknown, phase: 'fetch' | 'handle') => void;
  /** 401 / 409：token 不该由本进程轮询，重试只会和另一个实例互相抢。 */
  onFatal: (error: unknown) => void;
}

export class UpdatePoller {
  #running = false;
  #offset = 0;
  #controller = new AbortController();
  #loop: Promise<void> | null = null;
  readonly #inFlight = new Set<Promise<void>>();
  readonly #maxInFlight: number;

  constructor(private readonly bot: Bot, private readonly options: UpdatePollerOptions) {
    this.#maxInFlight = Math.max(1, Math.trunc(options.maxInFlight));
  }

  get inFlight(): number { return this.#inFlight.size; }
  get running(): boolean { return this.#running; }
  /** 下一次 `getUpdates` 的 offset。测试与运维排查用。 */
  get offset(): number { return this.#offset; }

  /** 不返回 Promise：循环自己吞掉所有错误，调用方没有可 await 的失败。 */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#controller = new AbortController();
    this.#loop = this.#run();
  }

  /** 停止拉取并把 offset 交回 Telegram。**不等在途 handler** —— 那是 `drain` 的事。 */
  async stop(): Promise<void> {
    if (!this.#running) return;
    this.#running = false;
    this.#controller.abort();
    await this.#loop?.catch(() => undefined);
    this.#loop = null;
    // 与 grammY 的 `stop()` 一致：确认 offset，重启后不会把已经派发过的 update 再收一遍
    // （去重表挡得住，但那意味着重启后要先空跑一批 update 才轮到新消息）。
    if (this.#offset > 0) await this.bot.api.getUpdates({ offset: this.#offset, limit: 1, timeout: 0 }).catch(() => undefined);
  }

  /** 等在途 handler 收尾，语义与 `TurnRegistry.drain` 一致：宽限期内没排空就返回 false。 */
  async drain(graceMs: number, intervalMs = 25): Promise<boolean> {
    const deadline = Date.now() + graceMs;
    // 这里的等待不能认 abort 信号：`stop()` 之后信号已经是 aborted，认了就退化成忙等。
    while (this.#inFlight.size && Date.now() < deadline) {
      await Promise.race([...this.#inFlight, sleep(Math.min(intervalMs, Math.max(1, deadline - Date.now())))]);
    }
    return this.#inFlight.size === 0;
  }

  async #run(): Promise<void> {
    // 先摘 webhook：设过 webhook 的 token 上 `getUpdates` 会一直 409，而 409 在下面是致命错误。
    // `drop_pending_updates` 也只有这一处能生效（Bot API 把它挂在 deleteWebhook 上）。
    await this.bot.api.deleteWebhook({ drop_pending_updates: this.options.dropPendingUpdates ?? false }, this.#signal())
      .catch((error: unknown) => this.options.onError(error, 'fetch'));
    while (this.#running) {
      while (this.#running && this.#inFlight.size >= this.#maxInFlight) await Promise.race(this.#inFlight);
      if (!this.#running) break;
      const updates = await this.#fetch();
      if (!updates) break;
      for (const update of updates) {
        // 先前移 offset 再派发：派发是同步启动、异步完成的，等 handler 结束才前移
        // 会让同一批里的后几条在下一次拉取时重复出现。
        this.#offset = update.update_id + 1;
        this.#dispatch(update);
      }
    }
  }

  async #fetch(): Promise<Update[] | null> {
    const limit = Math.min(MAX_BATCH, Math.max(1, this.#maxInFlight - this.#inFlight.size));
    while (this.#running) {
      try {
        return await this.bot.api.getUpdates({ offset: this.#offset, limit, timeout: this.options.timeoutSeconds ?? 30,
          ...(this.options.allowedUpdates ? { allowed_updates: [...this.options.allowedUpdates] as never } : {}) }, this.#signal());
      } catch (error) {
        if (!this.#running) return null;
        if (error instanceof GrammyError && (error.error_code === 401 || error.error_code === 409)) {
          this.#running = false;
          this.options.onFatal(error);
          return null;
        }
        this.options.onError(error, 'fetch');
        const retryAfter = error instanceof GrammyError && error.error_code === 429 ? error.parameters.retry_after : undefined;
        await this.#backoff((retryAfter ?? RETRY_SECONDS) * 1000);
      }
    }
    return null;
  }

  #dispatch(update: Update): void {
    const task = this.bot.handleUpdate(update).catch((error: unknown) => this.options.onError(error, 'handle'));
    this.#inFlight.add(task);
    void task.finally(() => this.#inFlight.delete(task));
  }

  /** grammY 的 API 方法收的是它自带的 abort-controller shim 类型，原生 `AbortSignal` 对不上。 */
  #signal(): never {
    return this.#controller.signal as never;
  }

  /** 可被 `stop()` 提前唤醒的退避：否则关机要陪着 3s（或 `retry_after`）的窗口一起等。 */
  #backoff(ms: number): Promise<void> {
    const signal = this.#controller.signal;
    return new Promise<void>((resolve) => {
      const wake = (): void => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', wake); resolve(); }, ms);
      timer.unref?.();
      signal.addEventListener('abort', wake, { once: true });
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => { const timer = setTimeout(resolve, ms); timer.unref?.(); });
}
