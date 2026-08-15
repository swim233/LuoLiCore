import { describe, expect, it, vi } from 'vitest';
import { TurnConcurrency, TurnRegistry, configSchema } from '@luoli/core';

describe('turn lifecycle', () => {
  it('serializes same-key turns in serial mode without bypassing FIFO', async () => {
    const config = configSchema.parse({ concurrency: { mode: 'serial', global: 3, perKey: 3, queueMax: 10 } });
    const gate = new TurnConcurrency(config.concurrency);
    const first = await gate.acquire('chat:1');
    let secondEntered = false;
    const secondPromise = gate.acquire('chat:1').then((release) => { secondEntered = true; return release; });
    await Promise.resolve();
    expect(secondEntered).toBe(false);
    first();
    const second = await secondPromise;
    expect(secondEntered).toBe(true);
    second();
    expect(gate.active).toBe(0);
    const held = await gate.acquire('chat:2');
    const controller = new AbortController();
    const queued = gate.acquire('chat:2', controller.signal);
    controller.abort();
    await expect(queued).rejects.toThrow('turn_queue_cancelled');
    held();
    expect(gate.queued).toBe(0);
  });

  it('aborts only the initiator or owner and enforces hard timeout', () => {
    vi.useFakeTimers();
    const registry = new TurnRegistry();
    const active = registry.register({ id: 'turn', key: 'chat:1', chatId: '1', userId: '2', role: 'trusted' }, 1000);
    expect(registry.cancel('turn', '3', 'trusted')).toBe(false);
    expect(active.controller.signal.aborted).toBe(false);
    expect(registry.cancel('turn', '9', 'owner')).toBe(true);
    expect(active.controller.signal.aborted).toBe(true);
    registry.finish('turn');
    const timed = registry.register({ id: 'timed', key: 'chat:1', chatId: '1', userId: '2', role: 'trusted' }, 1000);
    vi.advanceTimersByTime(1000);
    expect(timed.controller.signal.aborted).toBe(true);
    expect(timed.controller.signal.reason).toBe('timeout');
    registry.finish('timed');
    vi.useRealTimers();
  });
});
