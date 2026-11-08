import { describe, expect, it } from 'vitest';
import { startOfDay } from './today.js';

const at = (iso: string) => new Date(iso);
const day = (iso: string, timeZone: string) => {
  const { date, since } = startOfDay(at(iso), timeZone);
  return { date, since: since.toISOString() };
};

describe('「今天」按时区算', () => {
  it('UTC+8：当地 0 点前后分属两天', () => {
    expect(day('2026-11-08T15:59:59.999Z', 'Asia/Singapore')).toEqual({
      date: '2026-11-08',
      since: '2026-11-07T16:00:00.000Z',
    });
    expect(day('2026-11-08T16:00:00.000Z', 'Asia/Singapore')).toEqual({
      date: '2026-11-09',
      since: '2026-11-08T16:00:00.000Z',
    });
  });

  it('UTC 与 UTC 以西的时区', () => {
    expect(day('2026-11-08T00:00:00.000Z', 'UTC')).toEqual({
      date: '2026-11-08',
      since: '2026-11-08T00:00:00.000Z',
    });
    // 纽约此时是 11 月 7 日晚上 7 点（冬令时 UTC−5）
    expect(day('2026-11-08T00:00:00.000Z', 'America/New_York')).toEqual({
      date: '2026-11-07',
      since: '2026-11-07T05:00:00.000Z',
    });
  });

  it('夏令时切换的那一天：0 点按那一天开始时的时差算', () => {
    // 纽约 2026-11-01 凌晨 2 点结束夏令时：这一天 0 点还是夏令时（UTC−4）
    expect(day('2026-11-01T20:00:00.000Z', 'America/New_York')).toEqual({
      date: '2026-11-01',
      since: '2026-11-01T04:00:00.000Z',
    });
    // 2026-03-08 凌晨 2 点开始夏令时：这一天 0 点还是冬令时（UTC−5）
    expect(day('2026-03-08T20:00:00.000Z', 'America/New_York')).toEqual({
      date: '2026-03-08',
      since: '2026-03-08T05:00:00.000Z',
    });
  });

  it('当地 0 点不存在（在 0 点拨钟）时取这一天最早的时刻', () => {
    // 圣地亚哥 2026-09-06 的 0 点直接拨到 1 点（UTC−4 → UTC−3）
    const { date, since } = day('2026-09-06T12:00:00.000Z', 'America/Santiago');
    expect(date).toBe('2026-09-06');
    expect(since).toBe('2026-09-06T04:00:00.000Z');
  });
});
