import type { TaskSchedule } from '../../core/index.js';

// 任务的时间（ADR-0010）：都按服务器的时区，即进程的本地时区（Date 的本地时间）。纯函数；
// 测试里固定 TZ。夏令时这类本地时间不存在或重复的情况跟着 Date 走，不另外处理

/** 一次性任务最远能约到几年后 */
export const maxYearsAhead = 1;

/** 周期任务的种类，加上一次性的：建任务工具的 kind */
export const scheduleKinds = ['once', 'daily', 'weekdays', 'weekly', 'monthly'] as const;
export type ScheduleKind = (typeof scheduleKinds)[number];

/** 建任务工具给的时间（参数写平：一个种类加几个可选的字段，组合在 scheduleFrom 里检查） */
export type ScheduleInput = {
  kind: ScheduleKind;
  /** once：本地时刻 YYYY-MM-DD HH:mm */
  at?: string;
  /** 周期的：HH:mm */
  time?: string;
  /** weekly：1–7，1 是周一 */
  weekday?: number;
  /** monthly：1–31 */
  day?: number;
  /** 周期的，可选：YYYY-MM-DD，含这一天 */
  until?: string;
};

const weekdayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const pad = (n: number) => String(n).padStart(2, '0');

/** 本地时间 YYYY-MM-DD HH:mm（和 <message> 的 time 同一种写法） */
export function formatLocal(date: Date): string {
  return `${localDate(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 本地时间 YYYY-MM-DD HH:mm（周二） */
export function formatDue(date: Date): string {
  return `${formatLocal(date)}（${weekdayNames[date.getDay()]}）`;
}

/** 本地时间 MM-DD HH:mm */
export function formatShort(date: Date): string {
  return formatLocal(date).slice(5);
}

/** 本地日期 YYYY-MM-DD */
function localDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

/** 年月日在范围里（月 1–12，日不超过那个月的天数） */
function validDate(year: number, month: number, day: number): boolean {
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month - 1);
}

/** HH:mm（时可以是一位）→ 两位的 HH:mm；不对时 undefined */
export function parseClock(text: string): string | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return undefined;
  return `${pad(hour)}:${pad(minute)}`;
}

/** YYYY-MM-DD HH:mm（中间的空格也可以是 T）→ 本地时间；格式不对、日期不存在时 undefined */
export function parseLocalTime(text: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}:\d{2})$/.exec(text.trim());
  if (!match) return undefined;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const clock = parseClock(match[4]!);
  if (!clock || !validDate(year, month, day)) return undefined;
  const [hour, minute] = clock.split(':').map(Number) as [number, number];
  return new Date(year, month - 1, day, hour, minute);
}

/** YYYY-MM-DD → 那一天本地的 23:59:59.999（截止日期含这一天）；不对时 undefined */
export function endOfLocalDay(text: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  if (!match) return undefined;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (!validDate(year, month, day)) return undefined;
  return new Date(year, month - 1, day, 23, 59, 59, 999);
}

/** ISO 的星期：1 是周一，7 是周日 */
function isoWeekday(date: Date): number {
  return date.getDay() === 0 ? 7 : date.getDay();
}

/** 周期任务在这一天（本地日期）到不到点 */
function onDay(schedule: Exclude<TaskSchedule, { kind: 'once' }>, day: Date): boolean {
  switch (schedule.kind) {
    case 'daily':
      return true;
    case 'weekdays':
      return isoWeekday(day) <= 5;
    case 'weekly':
      return isoWeekday(day) === schedule.weekday;
    case 'monthly':
      // 那个月没有这一天（如 31 号碰上 2 月）时，在那个月的最后一天
      return (
        day.getDate() === Math.min(schedule.day, daysInMonth(day.getFullYear(), day.getMonth()))
      );
    default:
      return false;
  }
}

/**
 * 在 after 之后（不含）第一次到点的时刻。一次性的：at 还没到时就是它，否则没有。
 * 周期的：从 after 那一天起往后找第一个到点的日子，取那天的 time；晚于截止（until）时没有，
 * 任务就该完成了。不认识的种类没有
 */
export function nextDue(schedule: TaskSchedule, after: Date): Date | undefined {
  if (schedule.kind === 'once') {
    const at = new Date(schedule.at);
    return at.getTime() > after.getTime() ? at : undefined;
  }
  const clock = parseClock(schedule.time);
  if (!clock) return undefined;
  const [hour, minute] = clock.split(':').map(Number) as [number, number];
  const until = schedule.until === undefined ? undefined : Date.parse(schedule.until);
  // 最长的间隔是每月几号：一个多月；多看几天也无妨
  for (let offset = 0; offset <= 400; offset++) {
    const day = new Date(after.getFullYear(), after.getMonth(), after.getDate() + offset);
    if (!onDay(schedule, day)) continue;
    const candidate = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute);
    if (candidate.getTime() <= after.getTime()) continue;
    if (until !== undefined && candidate.getTime() > until) return undefined;
    return candidate;
  }
  return undefined;
}

/**
 * 一句人话的周期：「一次性」「每天 08:00」「每个工作日 08:00，到 12-31 为止」「每周二 20:00」
 * 「每月 31 号 10:00」。截止日期和 now 同一年时只写月日
 */
export function describeSchedule(schedule: TaskSchedule, now: Date): string {
  if (schedule.kind === 'once') return '一次性';
  const base = (() => {
    switch (schedule.kind) {
      case 'daily':
        return `每天 ${schedule.time}`;
      case 'weekdays':
        return `每个工作日 ${schedule.time}`;
      case 'weekly':
        return `每${weekdayNames[schedule.weekday % 7] ?? `周${schedule.weekday}`} ${schedule.time}`;
      case 'monthly':
        return `每月 ${schedule.day} 号 ${schedule.time}`;
      default:
        return '周期任务';
    }
  })();
  if (schedule.until === undefined) return base;
  const until = new Date(schedule.until);
  const date = localDate(until);
  return `${base}，到 ${until.getFullYear() === now.getFullYear() ? date.slice(5) : date} 为止`;
}

/**
 * 建任务工具给的时间换成要存的 schedule，连同第一次到点。组合不对、超出范围、时刻已经过了、
 * 晚于一年后、截止日期已经过了时，error 说明哪里不对（给模型看）
 */
export function scheduleFrom(
  input: ScheduleInput,
  now: Date,
): { ok: true; schedule: TaskSchedule; next: Date } | { ok: false; error: string } {
  const fail = (error: string) => ({ ok: false as const, error });
  const given = (value: string | number | undefined) => value !== undefined && value !== '';
  const nowText = `现在是 ${formatDue(now)}`;

  if (input.kind === 'once') {
    const extra = (['time', 'weekday', 'day', 'until'] as const).filter((key) => given(input[key]));
    if (extra.length > 0) {
      return fail(`一次性任务只写 at，不用 ${extra.join('、')}`);
    }
    if (!given(input.at)) return fail('一次性任务要写 at：到点的时刻，如 2026-11-10 09:00');
    const at = parseLocalTime(input.at!);
    if (!at) return fail('at 的写法不对：写成 2026-11-10 09:00（按服务器的时区，日期要存在）');
    if (at.getTime() <= now.getTime()) return fail(`这个时刻已经过了（${nowText}）`);
    const latest = new Date(now);
    latest.setFullYear(latest.getFullYear() + maxYearsAhead);
    if (at.getTime() > latest.getTime()) {
      return fail(`最远只能约到一年后（${formatLocal(latest)}）`);
    }
    return { ok: true, schedule: { kind: 'once', at: at.toISOString() }, next: at };
  }

  if (given(input.at)) return fail('周期任务不用 at，到点的时刻写在 time 里（HH:mm）');
  if (!given(input.time)) return fail('周期任务要写 time：每次到点的时刻，如 08:00');
  const time = parseClock(input.time!);
  if (!time) return fail('time 的写法不对：写成 HH:mm，如 08:00');
  if (input.kind !== 'weekly' && given(input.weekday)) return fail('只有 weekly 用 weekday');
  if (input.kind !== 'monthly' && given(input.day)) return fail('只有 monthly 用 day');

  let until: string | undefined;
  if (given(input.until)) {
    const end = endOfLocalDay(input.until!);
    if (!end) return fail('until 的写法不对：写成 2026-12-31（含这一天，日期要存在）');
    if (end.getTime() < now.getTime()) return fail(`截止日期已经过了（${nowText}）`);
    until = end.toISOString();
  }
  const limit = until === undefined ? {} : { until };

  let schedule: TaskSchedule;
  switch (input.kind) {
    case 'daily':
    case 'weekdays':
      schedule = { kind: input.kind, time, ...limit };
      break;
    case 'weekly': {
      const weekday = input.weekday;
      if (weekday === undefined) return fail('weekly 要写 weekday：1–7，1 是周一，7 是周日');
      if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) {
        return fail('weekday 只能是 1–7 的整数：1 是周一，7 是周日');
      }
      schedule = { kind: 'weekly', weekday, time, ...limit };
      break;
    }
    case 'monthly': {
      const day = input.day;
      if (day === undefined) return fail('monthly 要写 day：1–31');
      if (!Number.isInteger(day) || day < 1 || day > 31) return fail('day 只能是 1–31 的整数');
      schedule = { kind: 'monthly', day, time, ...limit };
      break;
    }
    default:
      return fail('kind 只能是 once、daily、weekdays、weekly、monthly');
  }
  const next = nextDue(schedule, now);
  if (!next) return fail(`截止日期之前没有能到点的时间了（${nowText}）`);
  return { ok: true, schedule, next };
}
