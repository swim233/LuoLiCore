export type LuoLiEvent = { type: string; data: unknown; at: number };

/**
 * `config.changed` 的载荷。`reconciled` 表示本次写入的发起方已自行 reconcile 过的子系统，
 * 订阅者见到即跳过对应处理。
 *
 * 需要它的原因：`emit` 是同步遍历，订阅者只能在 `void loadConfig(...)` 后立即返回，于是 HTTP
 * 端点随后 `await mcp.reconcile()` 时订阅者那次尚未生效，两次 reconcile 重叠，各 spawn 一个
 * stdio 子进程，只有后启动的能进入 `#clients`（docs/28 · L-EXT-03）。端点那次必须保留（响应中要给出
 * 真实 state），因此由订阅者让出。`McpManager` 内部已串行化，该标记只是省去一次无谓的重连窗口。
 */
export interface ConfigChangedEvent {
  keys: string[];
  reconciled?: readonly string[];
}
export interface SubscribeOptions {
  /** 该订阅者背后有一个可做决定的人（当前只有 WebUI 的 SSE 连接）。审批据此判断
   *  是否存在裁决通道；不能使用 subscriberCount，进程自身的 config.changed 订阅者始终存在，
   *  该计数恒 ≥1，会让立即拒绝的分支成为死代码（docs/24 · R-APPR-01）。 */
  channel?: boolean;
}

export class EventBus {
  readonly #listeners = new Map<(event: LuoLiEvent) => void, boolean>();
  constructor(private readonly onListenerError?: (error: unknown) => void) {}

  get subscriberCount(): number {
    return this.#listeners.size;
  }
  get channelCount(): number {
    let count = 0;
    for (const isChannel of this.#listeners.values()) if (isChannel) count += 1;
    return count;
  }

  emit(type: string, data: unknown): void {
    const event = { type, data, at: Date.now() } satisfies LuoLiEvent;
    for (const listener of this.#listeners.keys())
      try {
        listener(event);
      } catch (error) {
        this.onListenerError?.(error);
      }
  }

  subscribe(
    listener: (event: LuoLiEvent) => void,
    options: SubscribeOptions = {},
  ): () => void {
    this.#listeners.set(listener, options.channel === true);
    return () => this.#listeners.delete(listener);
  }
}
