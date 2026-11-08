import { describe, expect, it } from 'vitest';
import { defaultErrorText, parseTelegramConfig } from './config.js';

const token = '123456:ABC-def_ghi';
const base = { LUOLI_TELEGRAM_TOKEN: token };

function parse(env: Record<string, string | undefined>) {
  return parseTelegramConfig({ ...base, ...env });
}

function errorOf(env: Record<string, string | undefined>): string {
  const result = parse(env);
  if (result.ok) throw new Error('应当报错');
  return result.error;
}

describe('Telegram 配置', () => {
  it('默认值：白名单为空，唤醒词 nori，固定提示，官方 API 地址；只有 Telegram 自己的配置', () => {
    const result = parse({});

    expect(result).toEqual({
      ok: true,
      config: {
        token,
        chats: new Set(),
        users: new Set(),
        wakeWords: ['nori'],
        errorText: defaultErrorText,
        staleMs: 60 * 60_000,
        apiUrl: 'https://api.telegram.org',
      },
    });
  });

  it('白名单逗号分隔，去掉空白与空项；id 规范成 Telegram 的写法', () => {
    const result = parse({
      LUOLI_TELEGRAM_CHATS: ' -1001 , ,-1002',
      LUOLI_TELEGRAM_USERS: '011,22',
    });

    expect(result.ok && [...result.config.chats]).toEqual(['-1001', '-1002']);
    expect(result.ok && [...result.config.users]).toEqual(['11', '22']);
  });

  it('唤醒词逗号分隔、转小写；提示文字与 API 地址可改', () => {
    const result = parse({
      LUOLI_WAKE_WORDS: 'Nori, 小诺 ,',
      LUOLI_TELEGRAM_ERROR_TEXT: '稍等',
      LUOLI_TELEGRAM_API_URL: 'http://127.0.0.1:8081',
      LUOLI_TELEGRAM_STALE_MINUTES: '30',
    });

    expect(result.ok && result.config.wakeWords).toEqual(['nori', '小诺']);
    expect(result.ok && result.config.errorText).toBe('稍等');
    expect(result.ok && result.config.apiUrl).toBe('http://127.0.0.1:8081');
    expect(result.ok && result.config.staleMs).toBe(30 * 60_000);
  });

  it('缺少 token 时报错', () => {
    expect(errorOf({ LUOLI_TELEGRAM_TOKEN: undefined })).toBe('缺少环境变量 LUOLI_TELEGRAM_TOKEN');
  });

  it('不合法的值报错，错误信息里不出现 token', () => {
    const errors = [
      errorOf({ LUOLI_TELEGRAM_TOKEN: 'not-a-token' }),
      errorOf({ LUOLI_TELEGRAM_CHATS: `-1001,${token}` }),
      errorOf({ LUOLI_TELEGRAM_USERS: 'abc' }),
      errorOf({ LUOLI_WAKE_WORDS: ' , ' }),
      errorOf({ LUOLI_TELEGRAM_API_URL: 'not a url' }),
      ...['0', 'abc', '-5', '1.5'].map((value) => errorOf({ LUOLI_TELEGRAM_STALE_MINUTES: value })),
    ];

    expect(errors).toEqual([
      'LUOLI_TELEGRAM_TOKEN 格式不对，应为「数字:字符串」',
      'LUOLI_TELEGRAM_CHATS 的第 2 项不是数字 id',
      'LUOLI_TELEGRAM_USERS 的第 1 项不是数字 id',
      'LUOLI_WAKE_WORDS 里没有唤醒词',
      'LUOLI_TELEGRAM_API_URL 不是合法的 URL',
      ...Array(4).fill('LUOLI_TELEGRAM_STALE_MINUTES 必须是正整数（分钟）'),
    ]);
    expect(errors.join('\n')).not.toContain('ABC-def');
  });
});
