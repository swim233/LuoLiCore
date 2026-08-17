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

  /** 定时任务可以被用户增删之后，这三件事才是必需的：单独摘掉一个、问下一次什么时候、别重名。 */
  it('removes one job without touching the others', async () => {
    const scheduler = new Scheduler(); const runs: string[] = [];
    scheduler.add('0 0 1 1 *', () => { runs.push('a'); }, 'job:a');
    scheduler.add('0 0 1 1 *', () => { runs.push('b'); }, 'job:b');
    expect(scheduler.remove('job:a')).toBe(true);
    expect(scheduler.remove('job:a')).toBe(false);
    expect(scheduler.has('job:a')).toBe(false);
    expect(scheduler.names()).toEqual(['job:b']);
    await scheduler.trigger('job:b');
    expect(runs).toEqual(['b']);
    scheduler.stop();
  });

  it('rejects duplicate names instead of quietly running two', () => {
    const scheduler = new Scheduler();
    scheduler.add('0 0 1 1 *', () => {}, 'job:x');
    expect(() => scheduler.add('0 0 1 1 *', () => {}, 'job:x')).toThrow(/already exists/);
    scheduler.stop();
  });

  it('takes an absolute time for one-shot jobs and honours the timezone', () => {
    const scheduler = new Scheduler();
    const at = new Date(Date.now() + 3_600_000);
    scheduler.add(at, () => {}, 'job:once');
    expect(scheduler.nextRun('job:once')?.getTime()).toBe(at.getTime());
    // 同一个表达式在两个时区里的下一次触发必须不同，否则「早上 8 点」跟着宿主时区漂。
    scheduler.add('0 8 * * *', () => {}, 'job:sh', { timezone: 'Asia/Shanghai' });
    scheduler.add('0 8 * * *', () => {}, 'job:utc', { timezone: 'UTC' });
    expect(scheduler.nextRun('job:sh')?.getTime()).not.toBe(scheduler.nextRun('job:utc')?.getTime());
    expect(scheduler.nextRun('job:missing')).toBeNull();
    scheduler.stop();
  });
});
