import { describe, expect, it } from 'vitest';
import { matchTrigger } from '@luoli/telegram';
import { configSchema } from '@luoli/core';

function context(text: string, chatType: 'group' | 'channel' = 'group') {
  return { chat: { id: 1, type: chatType }, message: { text, entities: text.startsWith('/') ? [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]!.length }] : [] } } as never;
}

describe('Telegram trigger matching', () => {
  const trigger = configSchema.parse({}).trigger;
  it('accepts only owned commands with valid suffixes', () => {
    expect(matchTrigger(context('/new@mybot'), { ...trigger, strictCommandSuffix: true }, 1, 'mybot')).toBe('command');
    expect(matchTrigger(context('/new@other'), { ...trigger, strictCommandSuffix: true }, 1, 'mybot')).toBeNull();
    expect(matchTrigger(context('/unknown@mybot'), { ...trigger, strictCommandSuffix: true }, 1, 'mybot')).toBeNull();
    // 没有 handler 的名字不能留在白名单里，否则用户发出去只会石沉大海。
    expect(matchTrigger(context('/wake list'), { ...trigger, strictCommandSuffix: true }, 1, 'mybot')).toBeNull();
  });
  it('rejects channels by default and ignores too-short wakewords', () => {
    expect(matchTrigger(context('洛璃', 'channel'), trigger, 1, 'mybot')).toBeNull();
    expect(matchTrigger(context('x'), { ...trigger, private: false, mention: false, reply: false, command: false, wakewords: ['x'], wakewordMinLength: 2 }, 1, 'mybot')).toBeNull();
  });
  it('rejects nested-quantifier wake regexes without evaluating them', () => {
    const started = performance.now();
    expect(matchTrigger(context(`${'a'.repeat(20_000)}!`), { ...trigger, private: false, mention: false, reply: false, command: false, wakewords: ['^(a+)+$'] }, 1, 'mybot')).toBeNull();
    expect(performance.now() - started).toBeLessThan(100);
  });
});
