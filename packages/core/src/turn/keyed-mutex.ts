export class KeyedMutex {
  readonly #tails = new Map<string, Promise<void>>();

  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => (release = resolve));
    /**
     * **存进 map 的和 `finally` 里比的必须是同一个对象。** 此前存的是
     * `previous.then(() => current)`（一个新 promise）而比的是 `current` —— 两者永远不相等，
     * 于是每个用过的键都在 map 里留一条永久条目。对互斥语义无害（`get` 到的仍是真尾巴），
     * 但键空间由调用方决定时就是一条真泄漏：`AcpManager` 的键是 `dir:<realpath>`，
     * 模型每换一个目录就多一条，进程生命周期内不回收。
     */
    const tail = previous.then(() => current);
    this.#tails.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      // 只有「我是最后一个排队的」才删：后面还有人排队时 map 里那份已经是他的 tail 了。
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    }
  }

  /** 这个键上还有没有在排队/持锁的。**只给用例用** —— 「跑完之后 map 里不再有它」那条断言。 */
  pending(key: string): boolean { return this.#tails.has(key); }
}
