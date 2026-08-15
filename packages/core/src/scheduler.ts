import { Cron } from 'croner';

export class Scheduler {
  readonly #jobs: Array<{ name: string; stop(): void; trigger(): Promise<void> }> = [];

  add(expression: string, task: () => void | Promise<void>, name = expression): void {
    const invoke = async (): Promise<void> => { await task(); };
    const cron = new Cron(expression, { protect: true }, invoke);
    this.#jobs.push({ name, stop: () => cron.stop(), trigger: invoke });
  }

  names(): string[] { return this.#jobs.map((job) => job.name); }

  async trigger(name: string): Promise<void> {
    const job = this.#jobs.find((entry) => entry.name === name);
    if (!job) throw new Error(`scheduled job not found: ${name}`);
    await job.trigger();
  }

  stop(): void {
    for (const job of this.#jobs) job.stop();
    this.#jobs.length = 0;
  }
}
