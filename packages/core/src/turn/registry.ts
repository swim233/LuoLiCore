import type { Role } from '@luoli/shared';

export interface ActiveTurn {
  id: string;
  key: string;
  chatId: string;
  userId: string;
  role: Role;
  startedAt: number;
  controller: AbortController;
  timeout: ReturnType<typeof setTimeout>;
}

export class TurnRegistry {
  readonly #turns = new Map<string, ActiveTurn>();

  register(input: Omit<ActiveTurn, 'controller' | 'timeout' | 'startedAt'>, timeoutMs: number): ActiveTurn {
    const controller = new AbortController();
    const active: ActiveTurn = { ...input, controller, startedAt: Date.now(), timeout: setTimeout(() => controller.abort('timeout'), timeoutMs) };
    this.#turns.set(input.id, active);
    return active;
  }

  finish(id: string): void {
    const active = this.#turns.get(id);
    if (!active) return;
    clearTimeout(active.timeout);
    this.#turns.delete(id);
  }

  cancel(id: string, actorUserId: string, actorRole: Role, reason: 'user' | 'timeout' | 'shutdown' = 'user'): boolean {
    const active = this.#turns.get(id);
    if (!active || (actorRole !== 'owner' && actorUserId !== active.userId)) return false;
    active.controller.abort(reason);
    return true;
  }

  latest(chatId: string, userId: string): ActiveTurn | null {
    return [...this.#turns.values()].filter((turn) => turn.chatId === chatId && turn.userId === userId).sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;
  }

  list(chatId?: string): ActiveTurn[] {
    return [...this.#turns.values()].filter((turn) => chatId === undefined || turn.chatId === chatId);
  }

  /**
   * 该用户在途的轮次数（跨会话），是 `quota.rateLimit.concurrentPerUser` 的权威判据：
   * `turns` 表那一行要到 `openTurn` 之后才写入，而 `canStart` 与它之间隔着配额预留、并发闸排队
   * 与整个 `openTurn`；并发派发之后同一用户的两条消息可以同时通过检查（docs/27 · R-04）。
   */
  countForUser(userId: string): number {
    let count = 0;
    for (const turn of this.#turns.values()) if (turn.userId === userId) count += 1;
    return count;
  }

  abortAll(reason: 'shutdown' | 'timeout' = 'shutdown'): void {
    for (const turn of this.#turns.values()) turn.controller.abort(reason);
  }
  async drain(graceMs: number, intervalMs = 25): Promise<boolean> {
    const deadline = Date.now() + graceMs;
    while (this.#turns.size && Date.now() < deadline) await new Promise<void>((resolve) => setTimeout(resolve, Math.min(intervalMs, Math.max(1, deadline - Date.now()))));
    return this.#turns.size === 0;
  }

  get size(): number { return this.#turns.size; }
}
