import { describe, expect, it } from 'vitest';
import { maxAuthorChars } from '../server/chat.js';
import { maxNameChars, parseConfig } from './config.js';

describe('CLI 的参数', () => {
  it('默认：新开会话、名字由调用方取、端口 7310', () => {
    expect(parseConfig([], {})).toEqual({ ok: true, config: { resume: false, port: 7310 } });
  });

  it('--name（去掉首尾空白，空的按没给）、--resume', () => {
    expect(parseConfig(['--name', '  Bob ', '--resume'], {})).toEqual({
      ok: true,
      config: { name: 'Bob', resume: true, port: 7310 },
    });
    expect(parseConfig(['--name', '   '], {})).toMatchObject({
      ok: true,
      config: { name: undefined },
    });
  });

  it('端口取 LUOLI_WEB_PORT；空的按没设；不是 1~65535 的整数时报错', () => {
    expect(parseConfig([], { LUOLI_WEB_PORT: '7400' })).toMatchObject({ config: { port: 7400 } });
    expect(parseConfig([], { LUOLI_WEB_PORT: '' })).toMatchObject({ config: { port: 7310 } });
    for (const bad of ['0', '70000', '12.5', 'abc']) {
      expect(parseConfig([], { LUOLI_WEB_PORT: bad })).toEqual({
        ok: false,
        error: `LUOLI_WEB_PORT 必须是 1 到 65535 之间的整数，当前为 "${bad}"`,
        showUsage: false,
      });
    }
  });

  it('不认识的参数（包括去掉了的 --model）报错并显示用法；模型、key 不再读', () => {
    expect(parseConfig(['--model', 'x'], {})).toMatchObject({ ok: false, showUsage: true });
    expect(parseConfig(['hello'], {})).toMatchObject({ ok: false, showUsage: true });
    expect(parseConfig([], { LUOLI_MODEL: 'm', LUOLI_API_KEY: 'k', LUOLI_BASE_URL: 'u' })).toEqual({
      ok: true,
      config: { resume: false, port: 7310 },
    });
  });
});

describe('CLI 的名字长度', () => {
  it('上限与服务对话接口收的 author 相同；超了启动时就报参数错误、显示用法', () => {
    expect(maxNameChars).toBe(maxAuthorChars);
    expect(parseConfig(['--name', '名'.repeat(maxNameChars)], {})).toMatchObject({ ok: true });
    expect(parseConfig(['--name', ` ${'名'.repeat(maxNameChars)} `], {})).toMatchObject({
      ok: true,
    });
    expect(parseConfig(['--name', 'x'.repeat(maxNameChars + 1)], {})).toEqual({
      ok: false,
      error: `参数错误：--name 最多 ${maxNameChars} 个字符，现在是 ${maxNameChars + 1} 个`,
      showUsage: true,
    });
  });
});
