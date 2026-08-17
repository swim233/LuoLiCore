export interface EventStreamHandle {
  close(): void;
}

export class EventStreamRegistry {
  readonly #streams = new Set<EventStreamHandle>();
  add(stream: EventStreamHandle): () => void {
    this.#streams.add(stream);
    return () => this.#streams.delete(stream);
  }
  closeAll(): void {
    for (const stream of this.#streams) try { stream.close(); } catch { /* already closed */ }
    this.#streams.clear();
  }
  get size(): number { return this.#streams.size; }
}
