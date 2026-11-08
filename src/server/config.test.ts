import { describe, expect, it } from 'vitest';
import { parseServerConfig } from './config.js';

const token = '123456:ABC-def_ghi';
const base = {
  LUOLI_BASE_URL: 'https://api.example.com/v1',
  LUOLI_MODEL: 'some-model',
};

function parse(env: Record<string, string | undefined>) {
  return parseServerConfig({ ...base, ...env });
}

function errorOf(env: Record<string, string | undefined>): string {
  const result = parse(env);
  if (result.ok) throw new Error('应当报错');
  return result.error;
}

describe('洛璃服务的配置', () => {
  it('默认值：网页服务开、端口 7310；没有 token 时不启动 Telegram；共用配置与 CLI 相同', () => {
    expect(parse({})).toEqual({
      ok: true,
      config: {
        model: { baseURL: 'https://api.example.com/v1', apiKey: undefined, modelId: 'some-model' },
        maxRetries: undefined,
        timeouts: {},
        segments: {},
        dbPath: 'data/luoli.db',
        filesDir: 'data/files',
        promptPath: undefined,
        requestLog: { path: 'data/requests.db', retentionDays: 30 },
        name: '洛璃',
        telegram: undefined,
        web: { port: 7310, dbPath: 'data/web.db' },
      },
    });
  });

  it('LUOLI_NAME：助手的显示名，去掉首尾空白；空的、只有空白的按没设，用「洛璃」', () => {
    const nameOf = (value: string | undefined) => {
      const result = parse({ LUOLI_NAME: value });
      return result.ok ? result.config.name : undefined;
    };
    expect(nameOf(undefined)).toBe('洛璃');
    expect(nameOf('Nori')).toBe('Nori');
    expect(nameOf('  小璃 ')).toBe('小璃');
    expect(nameOf('')).toBe('洛璃');
    expect(nameOf('   ')).toBe('洛璃');
  });

  it('token 为空字符串也按没设处理：不启动 Telegram，Telegram 的其余变量不检查', () => {
    const result = parse({
      LUOLI_TELEGRAM_TOKEN: '',
      LUOLI_TELEGRAM_CHATS: 'abc',
      LUOLI_WAKE_WORDS: ' , ',
    });

    expect(result.ok && result.config.telegram).toBeUndefined();
  });

  it('设了 token 时解析 Telegram 的配置，错误照样报出来', () => {
    const result = parse({ LUOLI_TELEGRAM_TOKEN: token, LUOLI_TELEGRAM_CHATS: '-1001' });

    expect(result.ok && result.config.telegram?.token).toBe(token);
    expect(result.ok && [...(result.config.telegram?.chats ?? [])]).toEqual(['-1001']);
    expect(errorOf({ LUOLI_TELEGRAM_TOKEN: 'not-a-token' })).toBe(
      'LUOLI_TELEGRAM_TOKEN 格式不对，应为「数字:字符串」',
    );
    expect(errorOf({ LUOLI_TELEGRAM_TOKEN: token, LUOLI_TELEGRAM_USERS: 'abc' })).toBe(
      'LUOLI_TELEGRAM_USERS 的第 1 项不是数字 id',
    );
  });

  it('LUOLI_WEB=off 关闭网页服务，端口不检查；LUOLI_WEB_PORT 改端口', () => {
    const off = parse({ LUOLI_WEB: 'off', LUOLI_WEB_PORT: 'abc', LUOLI_TELEGRAM_TOKEN: token });
    const port = parse({ LUOLI_WEB_PORT: '8080' });

    expect(off.ok && off.config.web).toBeUndefined();
    expect(off.ok && off.config.telegram?.token).toBe(token);
    expect(port.ok && port.config.web).toEqual({ port: 8080, dbPath: 'data/web.db' });
  });

  it('web.db 默认在数据库所在目录下；LUOLI_WEB_DB 改路径，空字符串按没设处理', () => {
    const near = parse({ LUOLI_DB: '/srv/luoli/main.db' });
    const set = parse({ LUOLI_WEB_DB: '/tmp/panel.db' });
    const empty = parse({ LUOLI_WEB_DB: '' });

    expect(near.ok && near.config.web?.dbPath).toBe('/srv/luoli/web.db');
    expect(set.ok && set.config.web?.dbPath).toBe('/tmp/panel.db');
    expect(empty.ok && empty.config.web?.dbPath).toBe('data/web.db');
  });

  it('Telegram 和网页都没开时报错', () => {
    expect(errorOf({ LUOLI_WEB: 'off' })).toBe('Telegram 和网页都没有开，服务没有事可做');
    expect(errorOf({ LUOLI_WEB: 'off', LUOLI_TELEGRAM_TOKEN: '' })).toBe(
      'Telegram 和网页都没有开，服务没有事可做',
    );
  });

  it('不合法的值报错', () => {
    const errors = [
      errorOf({ LUOLI_MODEL: '' }),
      errorOf({ LUOLI_MAX_RETRIES: '-1' }),
      errorOf({ LUOLI_WEB: 'on' }),
      ...['0', '65536', 'abc', '-1', '80.5'].map((value) => errorOf({ LUOLI_WEB_PORT: value })),
    ];

    expect(errors).toEqual([
      '缺少模型：设置环境变量 LUOLI_MODEL',
      'LUOLI_MAX_RETRIES 必须是非负整数，当前为 "-1"',
      'LUOLI_WEB 只能是 off（关闭网页服务；不设时打开），当前为 "on"',
      'LUOLI_WEB_PORT 必须是 1 到 65535 之间的整数，当前为 "0"',
      'LUOLI_WEB_PORT 必须是 1 到 65535 之间的整数，当前为 "65536"',
      'LUOLI_WEB_PORT 必须是 1 到 65535 之间的整数，当前为 "abc"',
      'LUOLI_WEB_PORT 必须是 1 到 65535 之间的整数，当前为 "-1"',
      'LUOLI_WEB_PORT 必须是 1 到 65535 之间的整数，当前为 "80.5"',
    ]);
  });

  it('LUOLI_PROMPT 设了时原样保留路径；不设或为空时为 undefined，由 core 用仓库里的 prompts/system.md', () => {
    const set = parse({ LUOLI_PROMPT: 'my/persona.md' });
    const empty = parse({ LUOLI_PROMPT: '' });

    expect(set.ok && set.config.promptPath).toBe('my/persona.md');
    expect(empty.ok && empty.config.promptPath).toBeUndefined();
  });
});
