import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, describe, expect, it } from 'vitest';
import type { TelegramChat, TelegramUser } from '@chat-adapter/telegram';
import {
  createConversation,
  createMemoryStorage,
  type Conversation,
  type Logger,
  type Storage,
} from '../core/index.js';
import { createTelegramBot, type ChatTarget } from './bot.js';
import type { TelegramRaw } from './message.js';
import { telegramMessageLimit } from './split.js';

type StreamResult = Awaited<ReturnType<MockLanguageModelV4['doStream']>>;
type StreamPart = StreamResult['stream'] extends ReadableStream<infer P> ? P : never;

const group: TelegramChat = { id: -1001, type: 'supergroup', title: '读书会' };
const alice: TelegramUser = { id: 11, is_bot: false, first_name: 'Alice' };

let nextMessageId = 1;
function message(fields: Partial<TelegramRaw>): TelegramRaw {
  return {
    message_id: nextMessageId++,
    date: Math.floor(Date.now() / 1000),
    chat: group,
    from: alice,
    ...fields,
  };
}

/** 依次回复；带 gate 的等它放行才输出，中止时像 fetch 一样出错 */
function replying(...turns: Array<string | { text: string; gate: Promise<void> }>) {
  let call = 0;
  return new MockLanguageModelV4({
    doStream: async ({ abortSignal }) => {
      const turn = turns[call++] ?? '';
      const { text, gate } = typeof turn === 'string' ? { text: turn, gate: undefined } : turn;
      const parts: StreamPart[] = [
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: text },
        { type: 'text-end', id: 't' },
        {
          type: 'finish',
          finishReason: { unified: 'stop', raw: undefined },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 1, text: 1, reasoning: undefined },
          },
        },
      ];
      if (!gate) return { stream: simulateReadableStream({ chunks: parts }) };
      return {
        stream: new ReadableStream<StreamPart>({
          async start(controller) {
            controller.enqueue(parts[0]!);
            controller.enqueue({ type: 'text-delta', id: 't', delta: '半截' });
            abortSignal?.addEventListener('abort', () =>
              controller.error(new DOMException('aborted', 'AbortError')),
            );
            await gate;
          },
        }),
      };
    },
  });
}

type Sent = { target: ChatTarget; text: string; replyTo?: number };

function setup({
  model,
  storage = createMemoryStorage(),
  typingIntervalMs = 4000,
  typingFails = false,
}: {
  model: MockLanguageModelV4;
  storage?: Storage;
  typingIntervalMs?: number;
  typingFails?: boolean;
}) {
  const sent: Sent[] = [];
  const typing: ChatTarget[] = [];
  const entries: Array<{ level: string; msg: string; fields: Record<string, unknown> }> = [];
  const record = (level: string) => (fields: object, msg: string) =>
    entries.push({ level, msg, fields: fields as Record<string, unknown> });
  const logger: Logger = { info: record('info'), warn: record('warn'), error: record('error') };
  const conversations: Conversation[] = [];
  const bot = createTelegramBot({
    storage,
    open: async (id, { checkIdleOnCreate }) => {
      const conversation = createConversation({
        model,
        instructions: '你是测试助手',
        store: await storage.openConversation(id),
        conversationId: id,
        logger,
        checkIdleOnCreate,
      });
      conversations.push(conversation);
      return conversation;
    },
    sender: {
      typing: async (target) => {
        typing.push(target);
        if (typingFails) throw new Error('网络不通');
      },
      send: async (target, text, replyTo) => {
        sent.push({ target, text, replyTo });
      },
    },
    logger,
    bot: () => ({ id: '999', username: 'nori_bot' }),
    chats: new Set([String(group.id)]),
    users: new Set(),
    wakeWords: ['nori'],
    errorText: '（出错了）',
    staleMs: 60 * 60_000,
    typingIntervalMs,
  });
  cleanups.push(() => bot.close(0));
  return { bot, sent, typing, entries, storage, conversations };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Telegram 前端的会话逻辑', () => {
  it('编辑过的消息不记录、不触发（第 7 步处理）', async () => {
    const { bot, sent, storage } = setup({ model: replying('好') });

    await bot.handle(message({ text: 'nori 改过的', edit_date: 1 }));
    await bot.idle();

    expect(sent).toEqual([]);
    expect(await storage.listConversations('telegram')).toEqual([]);
  });

  it('Telegram 重发已处理过的消息：识别为重复，记 info 级 telegram.duplicate，不再回复', async () => {
    const { bot, sent, entries } = setup({ model: replying('好', '不该出现') });
    const trigger = message({ text: 'nori 在吗' });

    await bot.handle(trigger);
    await bot.idle();
    await bot.handle(trigger);
    await bot.idle();

    expect(sent.map((s) => s.text)).toEqual(['好']);
    expect(entries.filter((e) => e.msg.startsWith('telegram.'))).toEqual([
      {
        level: 'info',
        msg: 'telegram.duplicate',
        fields: expect.objectContaining({ messageId: String(trigger.message_id) }),
      },
    ]);
  });

  it('触发消息的发送时间早于时限：只记录；时限之内照常回复', async () => {
    const { bot, sent, typing, storage, entries } = setup({ model: replying('好') });
    const minutesAgo = (minutes: number) => Math.floor(Date.now() / 1000) - minutes * 60;

    await bot.handle(message({ text: 'nori 61 分钟前', date: minutesAgo(61) }));
    await bot.idle();
    expect(sent).toEqual([]);
    expect(typing).toEqual([]);
    expect(entries.filter((e) => e.msg === 'telegram.stale')).toEqual([
      {
        level: 'info',
        msg: 'telegram.stale',
        fields: expect.objectContaining({ chatId: String(group.id), ageMinutes: 61 }),
      },
    ]);

    await bot.handle(message({ text: 'nori 59 分钟前', date: minutesAgo(59) }));
    await bot.idle();
    expect(sent.map((s) => s.text)).toEqual(['好']);
    const info = await storage.findConversation('telegram', String(group.id));
    expect(await (await storage.openConversation(info!.id)).list()).toHaveLength(3);
  });

  it('回复为空时不发送', async () => {
    const { bot, sent } = setup({ model: replying('  \n ') });

    await bot.handle(message({ text: 'nori 在吗' }));
    await bot.idle();

    expect(sent).toEqual([]);
  });

  it('长回复拆成几条：第一条引用触发消息，后面的接着发', async () => {
    const long = `${'a'.repeat(telegramMessageLimit)}${'b'.repeat(10)}`;
    const { bot, sent } = setup({ model: replying(long) });

    const trigger = message({ text: 'nori 讲长一点' });
    await bot.handle(trigger);
    await bot.idle();

    expect(sent.map(({ text, replyTo }) => ({ length: text.length, replyTo }))).toEqual([
      { length: telegramMessageLimit, replyTo: trigger.message_id },
      { length: 10, replyTo: undefined },
    ]);
    expect(sent.map((s) => s.text).join('')).toBe(long);
  });

  it('生成期间定期重发「正在输入」，发出回复后停止；论坛话题里发到触发消息所在的话题', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const model = new MockLanguageModelV4({
      doStream: async () => {
        await gate;
        return replying('好').doStream({ prompt: [] } as never);
      },
    });
    const { bot, typing, sent } = setup({ model, typingIntervalMs: 20 });

    await bot.handle(
      message({ text: 'nori 慢慢想', is_topic_message: true, message_thread_id: 77 }),
    );
    await sleep(70);
    release();
    await bot.idle();
    const count = typing.length;
    await sleep(60);

    expect(count).toBeGreaterThanOrEqual(3);
    expect(typing.length).toBe(count);
    expect(typing[0]).toEqual({ chatId: group.id, messageThreadId: 77 });
    expect(sent[0]?.target).toEqual({ chatId: group.id, messageThreadId: 77 });
  });

  it('「正在输入」发送失败：一次回复只记一条 telegram.send_failed，回复照常', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const model = new MockLanguageModelV4({
      doStream: async () => {
        await gate;
        return replying('好').doStream({ prompt: [] } as never);
      },
    });
    const { bot, entries, sent } = setup({ model, typingIntervalMs: 10, typingFails: true });

    await bot.handle(message({ text: 'nori 在吗' }));
    await sleep(50);
    release();
    await bot.idle();

    expect(entries.filter((e) => e.msg === 'telegram.send_failed')).toEqual([
      {
        level: 'warn',
        msg: 'telegram.send_failed',
        fields: expect.objectContaining({ method: 'sendChatAction' }),
      },
    ]);
    expect(sent.map((s) => s.text)).toEqual(['好']);
  });

  it('关闭：进行中的回复等到宽限期后中止，不发出；各会话被关闭', async () => {
    const { bot, sent, conversations } = setup({
      model: replying({ text: '永远等不到', gate: new Promise<void>(() => {}) }),
    });
    await bot.handle(message({ text: 'nori 在吗' }));
    await sleep(20);

    await bot.close(30);

    expect(sent).toEqual([]);
    expect(conversations).toHaveLength(1);
    // 关闭之后不再开始新的回复
    await bot.handle(message({ text: 'nori 还在吗' }));
    await bot.idle();
    expect(sent).toEqual([]);
  });

  it('启动时打开白名单内的已知会话：核心补做漏掉的空闲切段；白名单外的不打开', async () => {
    const storage = createMemoryStorage();
    const old = new Date(Date.now() - 5 * 3_600_000).toISOString();
    for (const chatId of [String(group.id), '-1009']) {
      const id = await storage.createConversation({
        platform: 'telegram',
        platformConversationId: chatId,
        title: chatId,
      });
      await (
        await storage.openConversation(id)
      ).add({
        id: `m${chatId}`,
        role: 'user',
        metadata: { author: { id: '11', name: 'Alice' }, createdAt: old },
        parts: [{ type: 'text', text: '很久以前' }],
      });
    }
    const model = replying('摘要');
    const { bot, conversations } = setup({ model, storage });

    await bot.openKnown();
    const deadline = Date.now() + 2000;
    while (model.doStreamCalls.length === 0 && Date.now() < deadline) await sleep(5);

    expect(conversations).toHaveLength(1);
    expect(model.doStreamCalls).toHaveLength(1);
  });

  describe('退出与启动补做撞在一起', () => {
    /** 库里有一个白名单内的旧会话：打开时会补做摘要，摘要请求挂起直到被中止 */
    async function oldConversation() {
      const storage = createMemoryStorage();
      const id = await storage.createConversation({
        platform: 'telegram',
        platformConversationId: String(group.id),
      });
      await (
        await storage.openConversation(id)
      ).add({
        id: 'old',
        role: 'user',
        metadata: {
          author: { id: '11', name: 'Alice' },
          createdAt: new Date(Date.now() - 5 * 3_600_000).toISOString(),
        },
        parts: [{ type: 'text', text: '很久以前' }],
      });
      return storage;
    }
    const neverEnding = () => replying({ text: '摘要', gate: new Promise<void>(() => {}) });

    it('已经开始关闭时 openKnown 直接返回，不打开会话，也不再读库（数据库可能已关闭）', async () => {
      const model = neverEnding();
      const storage = await oldConversation();
      const { bot, conversations } = setup({ model, storage });

      await bot.close(0);
      storage.listConversations = async () => {
        throw new Error('数据库已关闭');
      };

      expect(await bot.openKnown()).toBe(0);
      expect(conversations).toEqual([]);
      expect(model.doStreamCalls).toHaveLength(0);
    });

    it('openKnown 读列表时开始关闭：不再打开会话', async () => {
      const model = neverEnding();
      const { bot, conversations } = setup({ model, storage: await oldConversation() });

      const [opened] = await Promise.all([bot.openKnown(), bot.close(0)]);

      expect(opened).toBe(0);
      expect(conversations).toEqual([]);
    });

    it('补做已经打开了会话再关闭：这些会话也被关闭，摘要记 aborted 而不是 failed', async () => {
      const model = neverEnding();
      const { bot, entries } = setup({ model, storage: await oldConversation() });

      expect(await bot.openKnown()).toBe(1);
      const deadline = Date.now() + 2000;
      while (model.doStreamCalls.length === 0 && Date.now() < deadline) await sleep(5);
      await bot.close(0);

      expect(entries.map((e) => e.msg)).toContain('summary.aborted');
      expect(entries.map((e) => e.msg)).not.toContain('summary.failed');
    });
  });
});
