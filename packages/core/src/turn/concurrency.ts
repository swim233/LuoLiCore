import type { Config } from '../config/schema.js';

interface Waiter { key: string; resolve: (release: () => void) => void; reject: (error: Error) => void; signal?: AbortSignal; onAbort?: () => void }

export class TurnConcurrency {
  readonly #activeByKey = new Map<string, number>();
  readonly #queue: Waiter[] = [];
  #activeGlobal = 0;

  constructor(private readonly config: Readonly<Config['concurrency']>) {}

  acquire(key: string, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new Error('turn_queue_cancelled'));
    if (this.#canRun(key)) return Promise.resolve(this.#take(key));
    if (this.#queue.length >= this.config.queueMax) return Promise.reject(new Error('turn_queue_full'));
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { key, resolve, reject, ...(signal ? { signal } : {}) };
      if (signal) waiter.onAbort = () => { const index = this.#queue.indexOf(waiter); if (index >= 0) this.#queue.splice(index, 1); reject(new Error('turn_queue_cancelled')); };
      signal?.addEventListener('abort', waiter.onAbort!, { once: true });
      this.#queue.push(waiter);
    });
  }

  get active(): number { return this.#activeGlobal; }
  get queued(): number { return this.#queue.length; }
  /**
   * 这一刻 `acquire` 会不会**立刻**放行。只读判据，两个开轮入口拿它决定要不要记一条
   * `turn.queued`：无条件记等于每轮多一行 info，而「排过队」才是排障要找的那件事
   * （`docs/10 §2` 的 `turn.queued`，docs/28 · L-LOG-01）。
   */
  available(key: string): boolean { return this.#canRun(key); }

  #canRun(key: string): boolean {
    const perKey = this.config.mode === 'serial' ? 1 : this.config.perKey;
    return this.#activeGlobal < this.config.global && (this.#activeByKey.get(key) ?? 0) < perKey;
  }

  #take(key: string): () => void {
    this.#activeGlobal += 1;
    this.#activeByKey.set(key, (this.#activeByKey.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#activeGlobal -= 1;
      const remaining = (this.#activeByKey.get(key) ?? 1) - 1;
      if (remaining) this.#activeByKey.set(key, remaining); else this.#activeByKey.delete(key);
      this.#drain();
    };
  }

  #drain(): void {
    for (let index = 0; index < this.#queue.length;) {
      const waiter = this.#queue[index]!;
      if (!this.#canRun(waiter.key)) { index += 1; continue; }
      this.#queue.splice(index, 1);
      waiter.signal?.removeEventListener('abort', waiter.onAbort!);
      waiter.resolve(this.#take(waiter.key));
    }
  }
}
