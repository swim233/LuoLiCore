import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TaskSchedule } from '../../core/index.js';
import {
  describeSchedule,
  endOfLocalDay,
  formatDue,
  nextDue,
  parseLocalTime,
  scheduleFrom,
  type ScheduleInput,
} from './schedule.js';

// 时间都按进程的本地时区：固定成上海（UTC+8，没有夏令时），结果不随机器变
let originalTz: string | undefined;
beforeAll(() => {
  originalTz = process.env.TZ;
  process.env.TZ = 'Asia/Shanghai';
});
afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

/** 上海的本地时刻 → Date */
const local = (text: string) => new Date(`${text.replace(' ', 'T')}:00+08:00`);
/** Date → 上海的本地时刻（带星期） */
const show = (date: Date | undefined) => (date ? formatDue(date) : undefined);

describe('下次到点', () => {
  it('一次性：时刻还没到时就是它，到了或过了就没有', () => {
    const schedule: TaskSchedule = { kind: 'once', at: local('2026-11-10 09:00').toISOString() };
    expect(show(nextDue(schedule, local('2026-11-09 21:30')))).toBe('2026-11-10 09:00（周二）');
    expect(nextDue(schedule, local('2026-11-10 09:00'))).toBeUndefined();
    expect(nextDue(schedule, local('2026-11-11 09:00'))).toBeUndefined();
  });

  it('每天：当天还没到就是当天，过了（或正好在那一刻）就是第二天', () => {
    const schedule: TaskSchedule = { kind: 'daily', time: '08:00' };
    expect(show(nextDue(schedule, local('2026-11-10 07:59')))).toBe('2026-11-10 08:00（周二）');
    expect(show(nextDue(schedule, local('2026-11-10 08:00')))).toBe('2026-11-11 08:00（周三）');
    expect(show(nextDue(schedule, local('2026-11-10 23:00')))).toBe('2026-11-11 08:00（周三）');
  });

  it('每个工作日：跳过周六周日', () => {
    const schedule: TaskSchedule = { kind: 'weekdays', time: '09:30' };
    // 2026-11-13 是周五
    expect(show(nextDue(schedule, local('2026-11-13 08:00')))).toBe('2026-11-13 09:30（周五）');
    expect(show(nextDue(schedule, local('2026-11-13 10:00')))).toBe('2026-11-16 09:30（周一）');
    expect(show(nextDue(schedule, local('2026-11-14 10:00')))).toBe('2026-11-16 09:30（周一）');
  });

  it('每周几：1 是周一，7 是周日；当天过了就是下一周', () => {
    const sunday: TaskSchedule = { kind: 'weekly', weekday: 7, time: '20:00' };
    const monday: TaskSchedule = { kind: 'weekly', weekday: 1, time: '08:00' };
    expect(show(nextDue(sunday, local('2026-11-10 12:00')))).toBe('2026-11-15 20:00（周日）');
    expect(show(nextDue(monday, local('2026-11-09 07:00')))).toBe('2026-11-09 08:00（周一）');
    expect(show(nextDue(monday, local('2026-11-09 08:00')))).toBe('2026-11-16 08:00（周一）');
  });

  it('每月几号：跨月、跨年', () => {
    const schedule: TaskSchedule = { kind: 'monthly', day: 15, time: '10:00' };
    expect(show(nextDue(schedule, local('2026-11-10 12:00')))).toBe('2026-11-15 10:00（周日）');
    expect(show(nextDue(schedule, local('2026-11-15 10:00')))).toBe('2026-12-15 10:00（周二）');
    expect(show(nextDue(schedule, local('2026-12-20 00:00')))).toBe('2027-01-15 10:00（周五）');
  });

  it('每月 31 号碰上短的月份：取那个月的最后一天（含闰年的 2 月）', () => {
    const schedule: TaskSchedule = { kind: 'monthly', day: 31, time: '09:00' };
    expect(show(nextDue(schedule, local('2026-11-01 00:00')))).toBe('2026-11-30 09:00（周一）');
    expect(show(nextDue(schedule, local('2026-11-30 09:00')))).toBe('2026-12-31 09:00（周四）');
    expect(show(nextDue(schedule, local('2027-01-31 09:00')))).toBe('2027-02-28 09:00（周日）');
    expect(show(nextDue(schedule, local('2028-02-01 00:00')))).toBe('2028-02-29 09:00（周二）');
    const day30: TaskSchedule = { kind: 'monthly', day: 30, time: '09:00' };
    expect(show(nextDue(day30, local('2027-02-01 00:00')))).toBe('2027-02-28 09:00（周日）');
    expect(show(nextDue(day30, local('2027-02-28 09:00')))).toBe('2027-03-30 09:00（周二）');
  });

  it('跨年的每天、每个工作日', () => {
    expect(show(nextDue({ kind: 'daily', time: '00:30' }, local('2026-12-31 23:00')))).toBe(
      '2027-01-01 00:30（周五）',
    );
    // 2027-01-01 是周五，之后是周末
    expect(show(nextDue({ kind: 'weekdays', time: '08:00' }, local('2027-01-01 09:00')))).toBe(
      '2027-01-04 08:00（周一）',
    );
  });

  it('截止日期：截止那天本地的 23:59:59.999（含这一天）；下一次晚于它就没有了', () => {
    const until = endOfLocalDay('2026-11-12')!;
    expect(until.toISOString()).toBe('2026-11-12T15:59:59.999Z');
    const schedule: TaskSchedule = { kind: 'daily', time: '23:00', until: until.toISOString() };
    expect(show(nextDue(schedule, local('2026-11-11 23:00')))).toBe('2026-11-12 23:00（周四）');
    expect(nextDue(schedule, local('2026-11-12 23:00'))).toBeUndefined();
    const weekly: TaskSchedule = {
      kind: 'weekly',
      weekday: 1,
      time: '08:00',
      until: endOfLocalDay('2026-11-15')!.toISOString(),
    };
    expect(nextDue(weekly, local('2026-11-10 00:00'))).toBeUndefined();
  });
});

describe('时间的写法', () => {
  it('本地时刻：和 <message> 的 time 同一种写法，也收 T；日期不存在、超出范围的不收', () => {
    expect(parseLocalTime('2026-11-10 09:00')?.toISOString()).toBe('2026-11-10T01:00:00.000Z');
    expect(parseLocalTime(' 2026-11-10T9:05 ')?.toISOString()).toBe('2026-11-10T01:05:00.000Z');
    for (const bad of ['2026-02-30 09:00', '2026-13-01 09:00', '2026-11-10 24:00', '明天 9 点']) {
      expect(parseLocalTime(bad)).toBeUndefined();
    }
    expect(endOfLocalDay('2026-02-29')).toBeUndefined();
  });

  it('一句人话的周期：截止日期和现在同一年时只写月日', () => {
    const now = local('2026-11-09 21:30');
    const until = endOfLocalDay('2026-12-31')!.toISOString();
    const nextYear = endOfLocalDay('2027-01-15')!.toISOString();
    expect(describeSchedule({ kind: 'once', at: now.toISOString() }, now)).toBe('一次性');
    expect(describeSchedule({ kind: 'daily', time: '08:00' }, now)).toBe('每天 08:00');
    expect(describeSchedule({ kind: 'weekdays', time: '08:00', until }, now)).toBe(
      '每个工作日 08:00，到 12-31 为止',
    );
    expect(describeSchedule({ kind: 'weekly', weekday: 7, time: '20:00' }, now)).toBe(
      '每周日 20:00',
    );
    expect(
      describeSchedule({ kind: 'monthly', day: 31, time: '09:00', until: nextYear }, now),
    ).toBe('每月 31 号 09:00，到 2027-01-15 为止');
  });
});

describe('建任务给的时间', () => {
  const now = local('2026-11-09 21:30');
  const from = (input: ScheduleInput) => scheduleFrom(input, now);
  const error = (input: ScheduleInput) => {
    const result = from(input);
    return result.ok ? undefined : result.error;
  };

  it('一次性：换成 ISO 存，下次到点就是它', () => {
    const result = from({ kind: 'once', at: '2026-11-10 09:00' });
    expect(result).toEqual({
      ok: true,
      schedule: { kind: 'once', at: '2026-11-10T01:00:00.000Z' },
      next: local('2026-11-10 09:00'),
    });
  });

  it('周期的：time 规整成两位，until 换成截止那天的最后一刻；下次到点从现在起算', () => {
    const result = from({ kind: 'weekdays', time: '8:00', until: '2026-12-31' });
    expect(result).toEqual({
      ok: true,
      schedule: { kind: 'weekdays', time: '08:00', until: '2026-12-31T15:59:59.999Z' },
      next: local('2026-11-10 08:00'),
    });
    expect(from({ kind: 'monthly', day: 31, time: '09:00' })).toMatchObject({
      ok: true,
      next: local('2026-11-30 09:00'),
    });
    // 空字符串当作没写
    expect(from({ kind: 'daily', time: '08:00', at: '', until: '' })).toMatchObject({ ok: true });
  });

  it('一次性：已经过了、晚于一年后、写法不对、多写了周期的字段，都说明哪里不对', () => {
    expect(error({ kind: 'once', at: '2026-11-09 21:30' })).toContain('这个时刻已经过了');
    expect(error({ kind: 'once', at: '2026-11-09 21:00' })).toContain(
      '现在是 2026-11-09 21:30（周一）',
    );
    expect(error({ kind: 'once', at: '2027-11-09 21:30' })).toBeUndefined();
    expect(error({ kind: 'once', at: '2027-11-09 21:31' })).toContain('最远只能约到一年后');
    expect(error({ kind: 'once', at: '11-10 9 点' })).toContain('at 的写法不对');
    expect(error({ kind: 'once' })).toContain('一次性任务要写 at');
    expect(error({ kind: 'once', at: '2026-11-10 09:00', time: '09:00' })).toContain(
      '一次性任务只写 at，不用 time',
    );
  });

  it('周期的：缺 time、写法不对、weekday 与 day 缺了或超出范围、字段用错了种类、截止日期已经过了', () => {
    expect(error({ kind: 'daily' })).toContain('周期任务要写 time');
    expect(error({ kind: 'daily', time: '25:00' })).toContain('time 的写法不对');
    expect(error({ kind: 'daily', time: '08:00', at: '2026-11-10 08:00' })).toContain(
      '周期任务不用 at',
    );
    expect(error({ kind: 'weekly', time: '08:00' })).toContain('weekly 要写 weekday');
    expect(error({ kind: 'weekly', time: '08:00', weekday: 0 })).toContain('weekday 只能是 1–7');
    expect(error({ kind: 'weekly', time: '08:00', weekday: 8 })).toContain('weekday 只能是 1–7');
    expect(error({ kind: 'monthly', time: '08:00' })).toContain('monthly 要写 day');
    expect(error({ kind: 'monthly', time: '08:00', day: 32 })).toContain('day 只能是 1–31');
    expect(error({ kind: 'daily', time: '08:00', weekday: 1 })).toContain('只有 weekly 用 weekday');
    expect(error({ kind: 'weekly', time: '08:00', weekday: 1, day: 1 })).toContain(
      '只有 monthly 用 day',
    );
    expect(error({ kind: 'daily', time: '08:00', until: '12-31' })).toContain('until 的写法不对');
    expect(error({ kind: 'daily', time: '08:00', until: '2026-11-08' })).toContain(
      '截止日期已经过了',
    );
    // 截止就是今天，今天的时刻已经过了：没有能到点的时间
    expect(error({ kind: 'daily', time: '08:00', until: '2026-11-09' })).toContain(
      '截止日期之前没有能到点的时间了',
    );
  });
});
