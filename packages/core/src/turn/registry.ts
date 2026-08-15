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
