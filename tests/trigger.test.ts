import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HANDLED_COMMANDS, matchTrigger } from '@luoli/telegram';
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
  // 白名单和 handler 分成两份就会漂移：`/start` `/help` `/ask` `/whois` `/webui` 曾经全在白名单里
  // 而一个 handler 都没有，判成 command 之后被直接丢弃（docs/20 · W-TG-01）。
  it('keeps the command whitelist, the registered handlers and /help in sync', () => {
    const source = readFileSync('packages/telegram/src/bot.ts', 'utf8');
    const registered = new Set([...source.matchAll(/bot\.command\('([a-z_]+)'/g)].map((match) => match[1]!));
    const documented = new Set([...source.matchAll(/\{ name: '([a-z_]+)', minRole:/g)].map((match) => match[1]!));
    expect([...registered].sort()).toEqual([...HANDLED_COMMANDS].sort());
    expect([...documented].sort()).toEqual([...HANDLED_COMMANDS].sort());
  });
  it('routes /ask into the AI flow and leaves unknown slash text alone', () => {
    // doc 08 §8：/ask 等价 @bot，是唯一进 AI 流程的命令。
    expect(matchTrigger(context('/ask 今天几号'), trigger, 1, 'mybot')).toBe('ask');
    // 裸 `/` 前缀不是命令：私聊里的「/home/app 这个目录满了」照常触发对话。
    const privateChat = { chat: { id: 1, type: 'private' }, message: { text: '/home/app 这个目录满了', entities: [] } } as never;
    expect(matchTrigger(privateChat, trigger, 1, 'mybot')).toBe('private');
    // 已注册命令在私聊里仍然是 command：否则 /new 会既重置上下文又开一轮对话。
    const privateCommand = { chat: { id: 1, type: 'private' }, message: { text: '/new', entities: [{ type: 'bot_command', offset: 0, length: 4 }] } } as never;
    expect(matchTrigger(privateCommand, trigger, 1, 'mybot')).toBe('command');
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
