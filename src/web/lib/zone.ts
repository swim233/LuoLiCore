import { pad2 } from '@luoli/ui/util';

/* 服务器时区里的日期与时刻：任务的时间都是 ISO（UTC），「今天、明天」「09:00」要按服务器的时区算
   （今日概况里的 timeZone），不是浏览器本机的。时区读不出来（还没取到、写法不认识）时用本机的 */
const formats = new Map<string, Intl.DateTimeFormat>();
function formatOf(tz: string | undefined): Intl.DateTimeFormat {
  const key = tz ?? '';
  let f = formats.get(key);
  if (!f) {
    const opts: Intl.DateTimeFormatOptions = {
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    };
    try {
      f = new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: tz || undefined });
    } catch {
      f = new Intl.DateTimeFormat('en-GB', opts);
    }
    formats.set(key, f);
  }
  return f;
}

export interface Zoned {
  y: number;
  m: number;
  d: number;
  hh: number;
  mm: number;
}
export function zoned(ms: number, tz?: string): Zoned {
  const parts = formatOf(tz).formatToParts(ms);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { y: get('year'), m: get('month'), d: get('day'), hh: get('hour'), mm: get('minute') };
}

const dayNo = (z: Zoned) => Math.floor(Date.UTC(z.y, z.m - 1, z.d) / 864e5);
const clockOf = (z: Zoned) => `${pad2(z.hh)}:${pad2(z.mm)}`;
/** 月-日，不是今年的带上年 */
const dateOf = (z: Zoned, now: Zoned) =>
  `${z.y === now.y ? '' : z.y + '-'}${pad2(z.m)}-${pad2(z.d)}`;

/** 这个时刻比今天晚几天（服务器时区的日历天），过去的为负 */
export function daysFromToday(ms: number, tz?: string, now = Date.now()): number {
  return dayNo(zoned(ms, tz)) - dayNo(zoned(now, tz));
}

/** 「今天 09:00」「明天 09:00」「昨天 09:00」，再远的是「11-12 09:00」（不是今年的带上年） */
export function fmtWhen(ms: number, tz?: string, now = Date.now()): string {
  const z = zoned(ms, tz);
  const n = zoned(now, tz);
  const diff = dayNo(z) - dayNo(n);
  const day = diff === 0 ? '今天' : diff === 1 ? '明天' : diff === -1 ? '昨天' : dateOf(z, n);
  return `${day} ${clockOf(z)}`;
}

/** 「11-10 09:00」：日期加时刻，不说今天、明天 */
export function fmtDateTime(ms: number, tz?: string, now = Date.now()): string {
  const z = zoned(ms, tz);
  return `${dateOf(z, zoned(now, tz))} ${clockOf(z)}`;
}

/** 「09:00」 */
export const fmtClockIn = (ms: number, tz?: string) => clockOf(zoned(ms, tz));
