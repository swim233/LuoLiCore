import { Cron } from "croner";

export interface ScheduleOptions {
  /** IANA 时区名。用户设定的每天早上 8 点是相对某个时区而言的，不传则取进程本地时区。 */
  timezone?: string;
  maxRuns?: number;
}

export class Scheduler {
  readonly #jobs = new Map<
    string,
    { stop(): void; trigger(): Promise<void>; nextRun(): Date | null }
  >();
  constructor(
    private readonly onError?: (name: string, error: unknown) => void,
  ) {}

  /**
   * @param expression cron 表达式，或一个绝对时间（一次性任务）。
   *
   * 重名直接抛出，与 `ToolRegistry.register` 规则一致：此前 `#jobs` 是数组且不去重，重名的第二个
   * 任务照常运行，而 `trigger(name)` / `remove(name)` 只作用于第一个。在定时任务可由用户增删
   * 之后，这种看似已删除实则仍在运行的状态是最难排查的一类。
   */
  add(
    expression: string | Date,
    task: () => void | Promise<void>,
    name = String(expression),
    options: ScheduleOptions = {},
  ): void {
    if (this.#jobs.has(name))
      throw new Error(`scheduled job already exists: ${name}`);
    const invoke = async (): Promise<void> => {
      try {
        await task();
      } catch (error) {
        this.onError?.(name, error);
      }
    };
    const cron = new Cron(
      expression,
      {
        protect: true,
        catch: true,
        ...(options.timezone ? { timezone: options.timezone } : {}),
        ...(options.maxRuns === undefined ? {} : { maxRuns: options.maxRuns }),
      },
      invoke,
    );
    this.#jobs.set(name, {
      stop: () => cron.stop(),
      trigger: invoke,
      nextRun: () => cron.nextRun(),
    });
  }

  names(): string[] {
    return [...this.#jobs.keys()];
  }

  has(name: string): boolean {
    return this.#jobs.has(name);
  }

  nextRun(name: string): Date | null {
    return this.#jobs.get(name)?.nextRun() ?? null;
  }

  /** 返回是否确实移除了一个：调用方（工具的取消路径）需要区分已停止与本就未注册。 */
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
