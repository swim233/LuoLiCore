import { describe, expect, it } from 'vitest';
import { TurnRegistry } from '@luoli/core';

describe('turn registry drain', () => {
  it('waits for in-flight turns and reports timeout before aborting', async () => {
    const registry = new TurnRegistry();
    registry.register({ id: 't1', key: 'k', chatId: 'c', userId: 'u', role: 'limited' }, 1000);
    setTimeout(() => registry.finish('t1'), 10);
    expect(await registry.drain(100)).toBe(true);
    const active = registry.register({ id: 't2', key: 'k', chatId: 'c', userId: 'u', role: 'limited' }, 1000);
    expect(await registry.drain(5, 1)).toBe(false);
    registry.abortAll('shutdown');
    expect(active.controller.signal.aborted).toBe(true);
    registry.finish('t2');
  });
});
