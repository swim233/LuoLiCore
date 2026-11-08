/** 服务器所在的时区（IANA 名字，如 Asia/Singapore） */
export function serverTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * now 在 timeZone 里是哪一天（YYYY-MM-DD），以及那一天 0 点的时刻。
 * 0 点因夏令时不存在时（少数时区在 0 点拨钟），取那天最早的时刻。
 * 0 点出现两次时（夏令时结束时从 01:00 拨回 00:00，如 Asia/Gaza 的某些年份），取的是第二个
 * 0 点：这一天最早的那一小时（第一个 0 点到拨钟）不算进「今天」。只影响极少数时区的那一天，
 * 不值得为它多绕一圈
 */
export function startOfDay(now: Date, timeZone: string): { date: string; since: Date } {
  const parts = wallClock(now, timeZone);
  const date = `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
  // 先把当地 0 点当成 UTC，再减去那时的时差；时差在这一天里变过时再校正一次
  const midnightAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day);
  let since = midnightAsUtc - offset(midnightAsUtc, timeZone);
  since = midnightAsUtc - offset(since, timeZone);
  // 0 点被拨过去了：当地时间已经不是这一天的 0 点，退到这一天开始的那一刻
  const check = wallClock(new Date(since), timeZone);
  if (check.day !== parts.day) since += 3_600_000;
  return { date, since: new Date(since) };
}

type WallClock = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

const formatters = new Map<string, Intl.DateTimeFormat>();

/** 某时刻在 timeZone 里的钟面时间 */
function wallClock(at: Date, timeZone: string): WallClock {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, format);
  }
  const parts = format.formatToParts(at);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour: value('hour'),
    minute: value('minute'),
    second: value('second'),
  };
}

/** timeZone 在某时刻比 UTC 快多少毫秒 */
function offset(at: number, timeZone: string): number {
  const wall = wallClock(new Date(at), timeZone);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return asUtc - Math.floor(at / 1000) * 1000;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
