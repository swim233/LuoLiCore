import { describe, expect, it } from 'vitest';
import { parseCommonConfig, type Env } from './config.js';

const base = { LUOLI_BASE_URL: 'https://api.example.com/v1' };

function parse(env: Env) {
  return parseCommonConfig({ ...base, ...env }, 'some-model');
}

function errorOf(env: Env): string {
  const result = parse(env);
  if (result.ok) throw new Error('应当报错');
  return result.error;
}

describe('工具结果在历史里的默认长度', () => {
  it('LUOLI_TOOL_HISTORY_CHARS 是正整数；不设或为空时为 undefined，用核心的默认值', () => {
    const set = parse({ LUOLI_TOOL_HISTORY_CHARS: '500' });
    expect(set.ok && set.config.toolHistoryChars).toBe(500);
    for (const env of [{}, { LUOLI_TOOL_HISTORY_CHARS: '' }]) {
      const result = parse(env);
      expect(result.ok && result.config.toolHistoryChars).toBeUndefined();
    }
  });

  it('不合法的值报错', () => {
    const invalid = ['0', '-1', '1.5', 'abc', '99999999999999999999'];
    expect(invalid.map((value) => errorOf({ LUOLI_TOOL_HISTORY_CHARS: value }))).toEqual(
      invalid.map((value) => `LUOLI_TOOL_HISTORY_CHARS 必须是正整数，当前为 "${value}"`),
    );
  });
});

describe('步数上限与回复、工具的超时', () => {
  it('不设或为空时为 undefined，用核心的默认值', () => {
    const unset = parse({});
    const empty = parse({ LUOLI_MAX_STEPS: '', LUOLI_REPLY_TIMEOUT: '', LUOLI_TOOL_TIMEOUT: '' });

    for (const result of [unset, empty]) {
      expect(result.ok && result.config.maxSteps).toBeUndefined();
      expect(result.ok && result.config.timeouts).toEqual({});
    }
  });

  it('LUOLI_MAX_STEPS 是不小于 2 的整数；两个超时以秒为单位，换成毫秒', () => {
    const result = parse({
      LUOLI_MAX_STEPS: '8',
      LUOLI_REPLY_TIMEOUT: '300',
      LUOLI_TOOL_TIMEOUT: '20',
      LUOLI_FIRST_CHUNK_TIMEOUT: '30',
    });

    expect(result.ok && result.config.maxSteps).toBe(8);
    const two = parse({ LUOLI_MAX_STEPS: '2' });
    expect(two.ok && two.config.maxSteps).toBe(2);
    expect(result.ok && result.config.timeouts).toEqual({
      firstChunkMs: 30_000,
      replyMs: 300_000,
      toolMs: 20_000,
    });
  });

  it('不合法的值报错：步数必须是不小于 2 的整数（1 也不行），超时与现有超时的范围相同', () => {
    const invalidSteps = ['1', '0', '-1', '1.5', 'abc', '99999999999999999999'];
    expect(invalidSteps.map((value) => errorOf({ LUOLI_MAX_STEPS: value }))).toEqual(
      invalidSteps.map((value) => `LUOLI_MAX_STEPS 必须是不小于 2 的整数，当前为 "${value}"`),
    );

    for (const variable of ['LUOLI_REPLY_TIMEOUT', 'LUOLI_TOOL_TIMEOUT']) {
      for (const value of ['0', '-5', '1.5', 'abc', '2147484']) {
        expect(errorOf({ [variable]: value })).toBe(
          `${variable} 必须是 1 到 2147483 之间的整数（秒），当前为 "${value}"`,
        );
      }
      expect(parse({ [variable]: '2147483' }).ok).toBe(true);
    }
  });
});
