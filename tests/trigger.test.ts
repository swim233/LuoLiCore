import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HANDLED_COMMANDS, matchTrigger } from '@luoli/telegram';
import { checkWakeword, configSchema, rejectedWakewords } from '@luoli/core';

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

  /**
   * `/webui` 的三条腿必须同时在（docs/09 §2.3 明写了要有这条断言）：命令白名单、bot 侧的
   * handler、服务端换取 session 的端点与签发函数。少任何一条，用户发出的 `/webui` 都会石沉大海
   * ——上一轮就是因为「名字留在白名单里但服务端没写」才把它整个摘掉的（docs/20 · W-TG-01）。
   */
  it('keeps /webui wired on both sides', () => {
    const bot = readFileSync('packages/telegram/src/bot.ts', 'utf8');
    const server = readFileSync('packages/server/src/app.ts', 'utf8');
    expect(HANDLED_COMMANDS.has('webui')).toBe(true);
    expect(bot).toContain("bot.command('webui'");
    expect(bot).toContain('issueLoginToken');
    expect(server).toContain("app.post('/api/auth/token'");
    expect(server).toContain('export function issueLoginToken');
    // 换 session 的端点必须在鉴权中间件的放行名单里，否则它自己就要求先登录。
    expect(server).toContain("ctx.req.path === '/api/auth/token'");
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
  /**
   * 编辑消息的内容在 `ctx.editedMessage`，`ctx.message` 是 undefined —— `matchTrigger` 只读后者时
   * 对任何 `edited_message` 恒返回 null，`bot.ts` 那条 `trigger.skipped` 于是一条都落不下
   * （docs/29 · M-TG-01）。归档不受影响（`triggered:false` 是写死的），坏的只是那条凭据。
   */
  it('takes an explicit message so edited updates can be judged too', () => {
    const edited = { chat: { id: 1, type: 'private' }, editedMessage: { text: '洛璃在吗', entities: [], edit_date: 1 } } as never;
    expect(matchTrigger(edited, trigger, 1, 'mybot')).toBeNull();
    expect(matchTrigger(edited, trigger, 1, 'mybot', (edited as { editedMessage: unknown }).editedMessage as never)).toBe('private');
    // 不给第五个参数时一个字都不变：普通消息照旧走 ctx.message。
    expect(matchTrigger(context('/new'), trigger, 1, 'mybot')).toBe('command');
  });
  it('rejects channels by default and ignores too-short wakewords', () => {
    expect(matchTrigger(context('洛璃', 'channel'), trigger, 1, 'mybot')).toBeNull();
    expect(matchTrigger(context('x'), { ...trigger, private: false, mention: false, reply: false, command: false, wakewords: ['x'], wakewordMinLength: 2 }, 1, 'mybot')).toBeNull();
  });
  // 手机输入法把句首自动大写，所以「配了 nori，发 Nori 不理我」是唤醒词最常见的失效方式：
  // 用户看到的只是 bot 时灵时不灵，日志里连一条记录都没有（根本没进 turn）。
  it('matches contains-style wakewords regardless of case, and leaves regex case to the author', () => {
    const off = { ...trigger, private: false, mention: false, reply: false, command: false };
    for (const text of ['nori 帮我查一下', 'Nori 帮我查一下', 'NORI 帮我查一下', '喂 Nori']) {
      expect(matchTrigger(context(text), { ...off, wakewords: ['nori'] }, 1, 'mybot')).toBe('wakeword');
    }
    // 配的是大写也一样：折叠发生在匹配时，不是写入时。
    expect(matchTrigger(context('nori 在吗'), { ...off, wakewords: ['Nori'] }, 1, 'mybot')).toBe('wakeword');
    // 正则按作者写的大小写求值……
    expect(matchTrigger(context('Nori 在吗'), { ...off, wakewords: ['^nori'] }, 1, 'mybot')).toBeNull();
    // ……要忽略大小写就自己写内联标志，两种拼法都得当成正则，否则用户拿到的是一个
    // 永远匹配不上、面板还标着「包含」的模式。
    for (const pattern of ['^(?i)nori', '(?i)^nori']) {
      expect(checkWakeword(pattern, 2).kind).toBe('regex');
      expect(matchTrigger(context('Nori 在吗'), { ...off, wakewords: [pattern] }, 1, 'mybot')).toBe('wakeword');
    }
  });
  /**
   * 不会生效的唤醒词是**逐条**跳过，不是整份作废：同一份里可用的那几条照常触发，坏的那几条
   * 连编译都不进行（`checkWakeword` 先判形态再 `new RE2`）。而跳过是静默的 —— 用户能看到的
   * 只有「bot 不理我」，所以启动时那条 `config.invalid` 必须把被跳过的模式**逐条**列出来，
   * 光说「有 N 条不生效」等于让运维自己一条条试。
   *
   * 写入端那一半在 `config.api.test.ts`（`PUT /api/config` 与 `PATCH /api/chats/:key` 都拿
   * 同一个 `rejectedWakewords` 当场拒收并把原因写进 `invalid_wakeword` 的 message）。
   */
  it('skips unusable wakewords one by one and names them in the startup warning', () => {
    const off = { ...trigger, private: false, mention: false, reply: false, command: false, wakewordMinLength: 2 };
    // 三种不生效的形态：太短、RE2 编译不过（反向引用）、超过 128 字符的正则。
    const wakewords = ['x', '^(a)\\1', `^${'a'.repeat(200)}`, 'nori'];
    const started = performance.now();
    expect(matchTrigger(context('x 一个字的唤醒词'), { ...off, wakewords }, 1, 'mybot')).toBeNull();
    expect(matchTrigger(context(`${'a'.repeat(300)}!`), { ...off, wakewords }, 1, 'mybot')).toBeNull();
    // 坏邻居不影响好邻居 —— 一条写歪的模式让整份唤醒词失效才是最难查的那种失效。
    expect(matchTrigger(context('nori 在吗'), { ...off, wakewords }, 1, 'mybot')).toBe('wakeword');
    expect(performance.now() - started).toBeLessThan(200);
    const rejected = rejectedWakewords(wakewords, 2);
    expect(rejected).toHaveLength(3);
    expect(rejected[0]).toBe('「x」短于 wakewordMinLength=2');
    expect(rejected[1]).toContain('RE2');
    expect(rejected[2]).toContain('128');
    expect(rejected.join('\n'), '可用的那条不该出现在被跳过的名单里').not.toContain('nori');
    const main = readFileSync('apps/bot/src/main.ts', 'utf8');
    const at = main.indexOf('rejectedWakewords(');
    expect(at, '启动时不再校验唤醒词 —— 被跳过的那几条从此一声不吭').toBeGreaterThan(0);
    const startup = main.slice(at, at + 500);
    expect(startup).toMatch(/kind:\s*["']config\.invalid["']/);
    expect(startup, '名单本身要进 data，只报条数等于没报').toMatch(/data:\s*\{\s*rejected:/);
  });

  it('matches nested quantifiers through the linear engine without blocking', () => {
    const started = performance.now();
    expect(matchTrigger(context(`${'a'.repeat(4095)}!`), { ...trigger, private: false, mention: false, reply: false, command: false, wakewords: ['^(a+)+$'] }, 1, 'mybot')).toBeNull();
    expect(performance.now() - started).toBeLessThan(100);
  });
});
