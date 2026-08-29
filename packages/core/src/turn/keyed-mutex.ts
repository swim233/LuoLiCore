export class KeyedMutex {
  readonly #tails = new Map<string, Promise<void>>();

  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => (release = resolve));
    /**
     * 存入 map 的对象与 `finally` 中比较的对象必须是同一个。此前存入的是
     * `previous.then(() => current)`（一个新 promise）而比较的是 `current`，两者永不相等，
     * 于是每个用过的键都在 map 中留下一条永久条目。这对互斥语义无害（`get` 到的仍是真实尾部），
     * 但键空间由调用方决定时即构成真实泄漏：`AcpManager` 的键是 `dir:<realpath>`，
     * 模型每更换一个目录就新增一条，进程生命周期内不回收。
     */
    const tail = previous.then(() => current);
    this.#tails.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      // 只有当前是最后一个排队者时才删除：后面仍有排队者时，map 中那份已经是后来者的 tail。
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    }
  }

  /** 该键上是否仍有排队或持锁者。仅供用例使用，用于执行结束后 map 中不再保留该键那条断言。 */
  pending(key: string): boolean { return this.#tails.has(key); }
}
