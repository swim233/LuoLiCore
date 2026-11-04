// 导出脚本的时间：命令行里的写法（本机时区、带时区的 ISO、相对时间）与输出用的本机时区格式

/** 接受的时间写法，报错与 --help 里列出 */
export const timeFormats = [
  '2026-11-03                本机时区当天 0 点',
  "'2026-11-03 18:00'        本机时区，中间有空格要加引号（也可以写成 2026-11-03T18:00；可以带秒 18:00:30）",
  '2026-11-03T10:00:00Z      带时区的 ISO（Z 或 +08:00 这样的偏移）',
  '30m、3h、2d               现在往前推 30 分钟、3 小时、2 天',
].join('\n');

const units = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/**
 * 解析命令行里的时间；不认识的写法返回 undefined。
 * - 日期（2026-11-03）：本机时区当天 0 点；
 * - 日期加时间（2026-11-03 18:00、2026-11-03T18:00:30）：本机时区；
 * - 带时区的 ISO（…Z、…+08:00、…+0800）：照它；
 * - 相对时间（30m、3h、2d）：从 now 往前推
 */
export function parseTime(text: string, now: Date): Date | undefined {
  const relative = /^(\d+)([mhd])$/.exec(text);
  if (relative) {
    const unit = units[relative[2] as keyof typeof units];
    return valid(new Date(now.getTime() - Number(relative[1]) * unit));
  }

  const match =
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?)?$/.exec(
      text,
    );
  if (!match) return undefined;
  const [, year, month, day, hour = '00', minute = '00', second = '00', fraction, zone] = match;
  const fields = [year, month, day, hour, minute, second].map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const [y, mo, d, h, mi, s] = fields;
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo) || h > 23 || mi > 59 || s > 59) {
    return undefined;
  }
  // 秒的小数部分只在带时区的写法里接受（与 ISO 一致）
  if (fraction !== undefined && zone === undefined) return undefined;
  if (zone === undefined) {
    // 年份按字面：new Date(年, …) 会把 0–99 年当成 1900–1999 年
    const local = new Date(0);
    local.setFullYear(y, mo - 1, d);
    local.setHours(h, mi, s, 0);
    return valid(local);
  }
  const offset = zone === 'Z' ? 'Z' : `${zone.slice(0, 3)}:${zone.slice(-2)}`;
  const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}${fraction ?? ''}${offset}`;
  return valid(new Date(iso));
}

/** 公历这个月有几天（年份按字面，含 0–99 年） */
function daysInMonth(year: number, month: number): number {
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
}

function valid(date: Date): Date | undefined {
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** 本机时区的 `YYYY-MM-DD HH:mm:ss` */
export function formatLocalTime(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${String(date.getFullYear()).padStart(4, '0')}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}
