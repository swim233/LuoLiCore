export type LuoLiEvent = { type: string; data: unknown; at: number };
export interface SubscribeOptions {
  /** 这个订阅者背后坐着一个能做决定的人（当前只有 WebUI 的 SSE 连接）。审批用它判断
   *  「有没有裁决通道」——不能拿 subscriberCount，进程自己的 config.changed 订阅者永远在，
   *  那个计数恒 ≥1，当场拒绝的分支就成了死代码（docs/24 · R-APPR-01）。 */
  channel?: boolean;
}

export class EventBus {
  readonly #listeners = new Map<(event: LuoLiEvent) => void, boolean>();
  constructor(private readonly onListenerError?: (error: unknown) => void) {}

  get subscriberCount(): number { return this.#listeners.size; }
  get channelCount(): number {
    let count = 0;
    for (const isChannel of this.#listeners.values()) if (isChannel) count += 1;
    return count;
  }

  emit(type: string, data: unknown): void {
    const event = { type, data, at: Date.now() } satisfies LuoLiEvent;
    for (const listener of this.#listeners.keys()) try { listener(event); } catch (error) { this.onListenerError?.(error); }
  }

  subscribe(listener: (event: LuoLiEvent) => void, options: SubscribeOptions = {}): () => void {
    this.#listeners.set(listener, options.channel === true);
    return () => this.#listeners.delete(listener);
  }
}
