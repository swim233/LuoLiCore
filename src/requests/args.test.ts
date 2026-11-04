import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseExportArgs, usage } from './args.js';
import { formatLocalTime, parseTime } from './time.js';

// 固定本机时区：本机时区的写法按东八区算
let originalTz: string | undefined;
beforeAll(() => {
  originalTz = process.env.TZ;
  process.env.TZ = 'Asia/Shanghai';
});
afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

const now = new Date('2026-11-04T10:00:00.000Z');
const iso = (text: string) => parseTime(text, now)?.toISOString();

describe('时间的写法', () => {
  it('日期：本机时区当天 0 点', () => {
    expect(iso('2026-11-03')).toBe('2026-11-02T16:00:00.000Z');
    expect(iso('2024-02-29')).toBe('2024-02-28T16:00:00.000Z');
  });

  it('日期加时间（空格或 T，可带秒）：本机时区', () => {
    expect(iso('2026-11-03 18:00')).toBe('2026-11-03T10:00:00.000Z');
    expect(iso('2026-11-03T18:00')).toBe('2026-11-03T10:00:00.000Z');
    expect(iso('2026-11-03 18:00:30')).toBe('2026-11-03T10:00:30.000Z');
    expect(iso('2026-11-03T00:00:00')).toBe('2026-11-02T16:00:00.000Z');
  });

  it('带时区的 ISO：照它', () => {
    expect(iso('2026-11-03T10:00:00Z')).toBe('2026-11-03T10:00:00.000Z');
    expect(iso('2026-11-03T10:00:00.250Z')).toBe('2026-11-03T10:00:00.250Z');
    expect(iso('2026-11-03T18:00:00+08:00')).toBe('2026-11-03T10:00:00.000Z');
    expect(iso('2026-11-03 18:00+0800')).toBe('2026-11-03T10:00:00.000Z');
    expect(iso('2026-11-03T05:00-05:00')).toBe('2026-11-03T10:00:00.000Z');
  });

  it('相对时间：从现在往前推', () => {
    expect(iso('30m')).toBe('2026-11-04T09:30:00.000Z');
    expect(iso('3h')).toBe('2026-11-04T07:00:00.000Z');
    expect(iso('2d')).toBe('2026-11-02T10:00:00.000Z');
    expect(iso('0m')).toBe(now.toISOString());
  });

  it('其他写法不认', () => {
    for (const text of [
      '',
      'yesterday',
      '2026/11/03',
      '2026-11-3',
      '2026-13-01',
      '2026-02-30',
      '2025-02-29',
      '2026-11-03 24:00',
      '2026-11-03 18:60',
      '2026-11-03 18',
      '2026-11-03Z',
      '2026-11-03 18:00:00.5',
      '30s',
      '1w',
      '-3h',
      '3 h',
      '99999999999d',
    ]) {
      expect(parseTime(text, now), text).toBeUndefined();
    }
  });

  it('年份按字面：0–99 年不当成 1900 年代', () => {
    expect(parseTime('0099-01-01', now)?.getFullYear()).toBe(99);
    expect(parseTime('0099-01-01', now)?.getMonth()).toBe(0);
    expect(parseTime('0099-01-01', now)?.getDate()).toBe(1);
    expect(parseTime('0005-03-04 12:30', now)?.getFullYear()).toBe(5);
    expect(parseTime('0005-03-04 12:30', now)?.getHours()).toBe(12);
    expect(iso('0099-01-01T00:00:00Z')).toBe('0099-01-01T00:00:00.000Z');
    // 闰年也按字面：0 年与 2000 年是闰年，1900 年不是
    expect(parseTime('0000-02-29', now)?.getFullYear()).toBe(0);
    expect(parseTime('1900-02-29', now)).toBeUndefined();
    expect(formatLocalTime(parseTime('0099-01-01 08:00', now)!)).toBe('0099-01-01 08:00:00');
  });

  it('输出用本机时区的 YYYY-MM-DD HH:mm:ss', () => {
    expect(formatLocalTime(new Date('2026-11-03T10:02:03.900Z'))).toBe('2026-11-03 18:02:03');
    expect(formatLocalTime(new Date('2026-12-31T16:00:00.000Z'))).toBe('2027-01-01 00:00:00');
  });
});

describe('参数', () => {
  const parse = (...argv: string[]) => parseExportArgs(argv, now);
  const options = (...argv: string[]) => {
    const result = parse(...argv);
    if (!result.ok || result.help) throw new Error('应当解析出条件');
    return result.options;
  };
  const errorOf = (...argv: string[]) => {
    const result = parse(...argv);
    if (result.ok) throw new Error('应当报错');
    return result.error;
  };

  it('什么都不给：最近 24 小时，其余不筛', () => {
    expect(options()).toEqual({
      conversations: [],
      since: new Date('2026-11-03T10:00:00.000Z'),
      until: undefined,
      defaultRange: true,
      replyId: undefined,
      failedOnly: false,
      embedImages: false,
      output: undefined,
    });
  });

  it('给了 --reply 时不限时间；给了时间时照给的', () => {
    expect(options('--reply', 'r1')).toMatchObject({
      replyId: 'r1',
      since: undefined,
      until: undefined,
      defaultRange: false,
    });
    expect(options('--until', '2026-11-04')).toMatchObject({
      since: undefined,
      until: new Date('2026-11-03T16:00:00.000Z'),
      defaultRange: false,
    });
    expect(options('--since', '3h')).toMatchObject({
      since: new Date('2026-11-04T07:00:00.000Z'),
      until: undefined,
    });
  });

  it('全部参数：--conversation 可以给多次，-o 与 --output 相同', () => {
    expect(
      options(
        '--conversation',
        '读书会',
        '--conversation',
        '-1001',
        '--since',
        '2026-11-03',
        '--until',
        '2026-11-04 12:00',
        '--reply',
        'r9',
        '--failed',
        '--embed-images',
        '-o',
        'out.json',
      ),
    ).toEqual({
      conversations: ['读书会', '-1001'],
      since: new Date('2026-11-02T16:00:00.000Z'),
      until: new Date('2026-11-04T04:00:00.000Z'),
      defaultRange: false,
      replyId: 'r9',
      failedOnly: true,
      embedImages: true,
      output: 'out.json',
    });
    expect(options('--output', 'a.json').output).toBe('a.json');
  });

  it('时间写法不对、since 不早于 until 时报错，说明接受哪些写法', () => {
    const wrong = errorOf('--since', 'yesterday');
    expect(wrong).toContain('--since 的时间写法不对：「yesterday」');
    expect(wrong).toContain('30m、3h、2d');
    expect(errorOf('--until', '2026/11/04')).toContain('--until 的时间写法不对');
    expect(errorOf('--since', '2026-11-04', '--until', '2026-11-04')).toBe(
      '--since 必须早于 --until',
    );
    expect(errorOf('--since', '1h', '--until', '2h')).toBe('--since 必须早于 --until');
  });

  it('日期和时间之间的空格没加引号：提示加引号', () => {
    expect(errorOf('--since', '2026-11-04', '19:00')).toBe(
      "--since 的日期和时间之间有空格，要加引号：--since '2026-11-04 19:00'",
    );
    expect(errorOf('--failed', '--until=2026-11-04', '9:05:30')).toBe(
      "--until 的日期和时间之间有空格，要加引号：--until '2026-11-04 9:05:30'",
    );
    // 加了引号的照常
    expect(options('--since', '2026-11-04 19:00').since).toEqual(
      new Date('2026-11-04T11:00:00.000Z'),
    );
    // 别的多余参数仍是 parseArgs 的报错
    expect(errorOf('--since', '2026-11-04', 'extra')).toMatch(/^参数错误：/);
  });

  it('不认识的参数、多余的位置参数、缺值、空值报错', () => {
    expect(errorOf('--bogus')).toMatch(/^参数错误：/);
    expect(errorOf('extra')).toMatch(/^参数错误：/);
    expect(errorOf('--since')).toMatch(/^参数错误：/);
    expect(errorOf('--conversation', ' ')).toBe('--conversation 不能为空');
    expect(errorOf('--reply', '')).toBe('--reply 不能为空');
    expect(errorOf('-o', '')).toBe('--output 不能为空');
  });

  it('--help、-h：用法说明列出全部参数、时间写法、默认范围与输出结构', () => {
    expect(parse('--help')).toEqual({ ok: true, help: true });
    expect(parse('-h', '--bogus-is-ignored-after-help')).toMatchObject({ ok: false });
    expect(parse('-h')).toEqual({ ok: true, help: true });
    for (const text of [
      '--conversation',
      '--since',
      '--until',
      '--reply',
      '--failed',
      '--embed-images',
      '-o, --output',
      '-h, --help',
      "'2026-11-03 18:00'",
      '30m、3h、2d',
      '最近 24 小时',
      'missingImages',
      'conversation',
    ]) {
      expect(usage).toContain(text);
    }
  });
});
