import { Cron } from 'croner';

export interface ScheduleOptions {
  /** IANA 时区名。用户排的「每天早上 8 点」是按某个时区说的，不传就是进程本地时区。 */
  timezone?: string;
  maxRuns?: number;
}

export class Scheduler {
  readonly #jobs = new Map<string, { stop(): void; trigger(): Promise<void>; nextRun(): Date | null }>();
  constructor(private readonly onError?: (name: string, error: unknown) => void) {}

  /**
   * @param expression cron 表达式，或一个绝对时间（一次性任务）。
   *
   * 重名直接抛，跟 `ToolRegistry.register` 一个规矩：此前 `#jobs` 是数组且不查重，重名的第二个
   * 任务照样跑，而 `trigger(name)` / `remove(name)` 只会打到第一个 —— 定时任务可以被用户增删
   * 之后，这种「看着删掉了其实还在跑」是最难查的一类。
   */
  add(expression: string | Date, task: () => void | Promise<void>, name = String(expression), options: ScheduleOptions = {}): void {
    if (this.#jobs.has(name)) throw new Error(`scheduled job already exists: ${name}`);
    const invoke = async (): Promise<void> => { try { await task(); } catch (error) { this.onError?.(name, error); } };
    const cron = new Cron(expression, { protect: true, catch: true, ...(options.timezone ? { timezone: options.timezone } : {}), ...(options.maxRuns === undefined ? {} : { maxRuns: options.maxRuns }) }, invoke);
    this.#jobs.set(name, { stop: () => cron.stop(), trigger: invoke, nextRun: () => cron.nextRun() });
  }

  names(): string[] { return [...this.#jobs.keys()]; }

  has(name: string): boolean { return this.#jobs.has(name); }

  nextRun(name: string): Date | null { return this.#jobs.get(name)?.nextRun() ?? null; }

  /** 返回是否真的摘掉了一个：调用方（工具的取消路径）要能区分「停了」和「本来就没注册」。 */
  remove(name: string): boolean {
    const job = this.#jobs.get(name);
    if (!job) return false;
    job.stop();
    this.#jobs.delete(name);
    return true;
  }

  async trigger(name: string): Promise<void> {
    const job = this.#jobs.get(name);
    if (!job) throw new Error(`scheduled job not found: ${name}`);
    await job.trigger();
  }

  stop(): void {
    for (const job of this.#jobs.values()) job.stop();
    this.#jobs.clear();
  }
}
