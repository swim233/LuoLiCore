import { EventEmitter } from 'node:events';

export type LuoLiEvent = { type: string; data: unknown; at: number };

export class EventBus {
  readonly #emitter = new EventEmitter();

  emit(type: string, data: unknown): void {
    this.#emitter.emit('event', { type, data, at: Date.now() } satisfies LuoLiEvent);
  }

  subscribe(listener: (event: LuoLiEvent) => void): () => void {
    this.#emitter.on('event', listener);
    return () => this.#emitter.off('event', listener);
  }
}
