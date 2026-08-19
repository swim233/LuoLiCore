export type LuoLiEvent = { type: string; data: unknown; at: number };

/**
 * `config.changed` 的载荷。`reconciled` 是「这次写入的发起方**自己**已经 reconcile 过的子系统」——
 * 订阅者见到就跳过对应的那一行。
 *
 * 为什么需要它：`emit` 是同步遍历，订阅者只能 `void loadConfig(...)` 后立刻返回，于是 HTTP
 * 端点接着 `await mcp.reconcile()` 时订阅者那条还没落地，两条 reconcile 重叠 —— 各 spawn 一个
 * stdio 子进程，只有后来的进得了 `#clients`（docs/28 · L-EXT-03）。端点那次必须留着（响应里要给出
 * 真实 state），所以让订阅者让位。`McpManager` 内部已经串行化，这个标记只是省掉一次无谓的重连窗口。
 */
export interface ConfigChangedEvent { keys: string[]; reconciled?: readonly string[] }
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
