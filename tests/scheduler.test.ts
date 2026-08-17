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

  it('contains task failures and reports them', async () => {
    const failures: Array<{ name: string; error: unknown }> = [];
    const scheduler = new Scheduler((name, error) => failures.push({ name, error }));
    scheduler.add('0 0 1 1 *', () => { throw new Error('maintenance failed'); }, 'maintenance');
    await expect(scheduler.trigger('maintenance')).resolves.toBeUndefined();
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ name: 'maintenance', error: expect.objectContaining({ message: 'maintenance failed' }) });
    scheduler.stop();
  });
});
