import { describe, expect, it } from 'vitest';
import { Scheduler } from '@luoli/core';

describe('operations scheduler', () => {
  it('registers, triggers, and stops named jobs', async () => {
    const scheduler = new Scheduler(); let runs = 0;
    scheduler.add('0 0 1 1 *', () => { runs += 1; }, 'maintenance');
    expect(scheduler.names()).toEqual(['maintenance']);
    await scheduler.trigger('maintenance');
    expect(runs).toBe(1);
    scheduler.stop();
    expect(scheduler.names()).toEqual([]);
  });
});
