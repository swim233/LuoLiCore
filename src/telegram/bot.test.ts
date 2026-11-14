import { APICallError, simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { TelegramChat, TelegramUser } from '@chat-adapter/telegram';
import {
  createConversation,
  createMemoryStorage,
  defineTool,
  installTools,
  type Conversation,
  type InstalledTool,
  type Logger,
  type Storage,
} from '../core/index.js';
import { testPrompts } from '../core/test-prompts.js';
import { createTelegramBot, type ChatTarget, type RoundNotice } from './bot.js';
import { imageBytes } from './fake-api.js';
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
  wait = { idleMs: 5, maxMs: 50 },
  albums = [],
  failingDownloads = [],
  files = {},
  tools = [],
  sendDelayMs = 0,
  users = [],
  onRound,
}: {
  model: MockLanguageModelV4;
  storage?: Storage;
  typingIntervalMs?: number;
  typingFails?: boolean;
  wait?: { idleMs: number; maxMs: number };
  /** 相册：派发其中一条时，albumOf 取回整组 */
  albums?: TelegramRaw[][];
  failingDownloads?: string[];
  /** 下载到的内容；没给的为 jpeg 图片 */
  files?: Record<string, Uint8Array>;
  tools?: InstalledTool[];
  /** 每次发送要等这么久才发出（像真的网络请求） */
  sendDelayMs?: number;
  /** 白名单里能私聊的用户 id */
  users?: string[];
  onRound?: (notice: RoundNotice) => void;
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
        prompts: testPrompts('你是测试助手'),
        store: await storage.openConversation(id),
        conversationId: id,
        logger,
        checkIdleOnCreate,
        tools,
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
        if (sendDelayMs) await sleep(sendDelayMs);
        sent.push({ target, text, replyTo });
      },
    },
    download: async (fileId) => {
      if (failingDownloads.includes(fileId)) throw new Error('下载失败');
      return files[fileId] ?? imageBytes('image/jpeg', fileId);
    },
    albumOf: (raw) =>
      albums.find((album) => album.some((item) => item.message_id === raw.message_id)) ?? [raw],
    logger,
    bot: () => ({ id: '999', username: 'nori_bot' }),
    chats: new Set([String(group.id)]),
    users: new Set(users),
    wakeWords: ['nori'],
    errorText: '（出错了）',
    staleMs: 60 * 60_000,
    typingIntervalMs,
    wait,
    onRound,
  });
  cleanups.push(() => bot.close(0));
  return { bot, sent, typing, entries, storage, conversations };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 一次模型请求里所有消息的文字（含名字标签） */
function promptText(model: MockLanguageModelV4, index: number): string {
  return JSON.stringify(model.doStreamCalls[index]?.prompt ?? []);
}

/** 历史里的消息：正文与附件数 */
async function historyOf(storage: Storage) {
  const info = await storage.findConversation('telegram', String(group.id));
  if (!info) return [];
  const messages = await (await storage.openConversation(info.id)).list();
  return messages.map((message) => ({
    role: message.role,
    text: message.parts.map((part) => (part.type === 'text' ? part.text : '')).join(''),
    files: message.parts.filter((part) => part.type === 'file').length,
    editedAt: message.metadata?.editedAt,
  }));
}

/** 带闸门的模型：第 index 次调用等 release 才输出 */
function gated(...texts: string[]) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const calledAt: number[] = [];
  let call = 0;
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      calledAt.push(Date.now());
      const index = call++;
      if (index === 0) await gate;
      return replying(texts[index] ?? '').doStream(options);
    },
  });
  return { model, release: () => release(), calledAt };
}

describe('Telegram 前端的会话逻辑', () => {
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

describe('等待合并与合并回复', () => {
  it('触发后先等待并立即显示「正在输入」；等待期间每来一条消息就重置计时，到时回复一次，请求里有期间的消息', async () => {
    const model = replying('好');
    const { bot, sent, typing } = setup({ model, wait: { idleMs: 100, maxMs: 1000 } });

    const trigger = message({ text: 'nori 问个问题' });
    await bot.handle(trigger);
    const triggeredAt = Date.now();
    expect(typing).toHaveLength(1);
    await sleep(50);
    await bot.handle(message({ text: '补充一句' }));
    // 第一条触发的 100 毫秒已过，但第二条重置了计时
    await sleep(triggeredAt + 130 - Date.now());
    expect(model.doStreamCalls).toHaveLength(0);

    await bot.idle();
    expect(sent.map(({ text, replyTo }) => ({ text, replyTo }))).toEqual([
      { text: '好', replyTo: trigger.message_id },
    ]);
    expect(model.doStreamCalls).toHaveLength(1);
    expect(promptText(model, 0)).toContain('补充一句');
  });

  it('等待从第一条触发算起最多到上限：消息一直来也会开始回复', async () => {
    const { model, calledAt } = gated('好');
    const { bot } = setup({ model, wait: { idleMs: 60, maxMs: 200 } });

    await bot.handle(message({ text: 'nori 在吗' }));
    const triggeredAt = Date.now();
    const deadline = triggeredAt + 2000;
    while (calledAt.length === 0 && Date.now() < deadline) {
      await bot.handle(message({ text: '刷屏' }));
      await sleep(15);
    }

    expect(calledAt).toHaveLength(1);
    expect(calledAt[0]! - triggeredAt).toBeGreaterThanOrEqual(190);
  });

  it('等待期间再被触发：只回复一次，引用最后一条触发', async () => {
    const model = replying('一起回答', '不该出现');
    const { bot, sent } = setup({ model });

    await bot.handle(message({ text: 'nori 第一问' }));
    await bot.handle(message({ text: '闲聊' }));
    const last = message({ text: 'nori 第二问' });
    await bot.handle(last);
    await bot.handle(message({ text: '又一句闲聊' }));
    await bot.idle();

    expect(sent.map(({ text, replyTo }) => ({ text, replyTo }))).toEqual([
      { text: '一起回答', replyTo: last.message_id },
    ]);
    expect(model.doStreamCalls).toHaveLength(1);
  });

  it('回复中再被触发：这次发出后立即再回一次，引用期间最后一条触发，请求里有期间所有消息', async () => {
    const { model, release, calledAt } = gated('第一次', '第二次', '不该出现');
    const { bot, sent, typing } = setup({
      model,
      wait: { idleMs: 300, maxMs: 300 },
      typingIntervalMs: 20,
    });

    const first = message({ text: 'nori 讲个故事' });
    await bot.handle(first);
    const deadline = Date.now() + 2000;
    while (calledAt.length === 0 && Date.now() < deadline) await sleep(5);
    await bot.handle(message({ text: 'nori 我也要听' }));
    await bot.handle(message({ text: '期间的闲聊' }));
    const last = message({ text: 'nori 讲长一点' });
    await bot.handle(last);
    release();
    await bot.idle();

    expect(sent.map(({ text, replyTo }) => ({ text, replyTo }))).toEqual([
      { text: '第一次', replyTo: first.message_id },
      { text: '第二次', replyTo: last.message_id },
    ]);
    expect(model.doStreamCalls).toHaveLength(2);
    for (const text of ['nori 我也要听', '期间的闲聊', 'nori 讲长一点', '第一次']) {
      expect(promptText(model, 1)).toContain(text);
    }
    // 第二次不再等待（等待时长是 300 毫秒）
    expect(calledAt[1]! - calledAt[0]!).toBeLessThan(250);
    // 两次之间「正在输入」没有断：一轮结束后才停
    const count = typing.length;
    await sleep(60);
    expect(typing.length).toBe(count);
  });

  it('失败提示发出后，期间又被触发的同样再回一次', async () => {
    let call = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        if (call++ === 0) {
          await gate;
          throw new Error('模型挂了');
        }
        return replying('恢复了').doStream(options);
      },
    });
    const { bot, sent } = setup({ model });

    const first = message({ text: 'nori 在吗' });
    await bot.handle(first);
    while (model.doStreamCalls.length === 0) await sleep(5);
    const second = message({ text: 'nori 还在吗' });
    await bot.handle(second);
    release();
    await bot.idle();

    expect(sent.map(({ text, replyTo }) => ({ text, replyTo }))).toEqual([
      { text: '（出错了）', replyTo: first.message_id },
      { text: '恢复了', replyTo: second.message_id },
    ]);
  });

  it('过期的触发不进入等待、不设「还有人在等」，也不改引用的消息；但照常算作等待期间的新消息', async () => {
    const stale = () =>
      message({ text: 'nori 很久以前', date: Math.floor(Date.now() / 1000) - 2 * 3600 });
    const { model, release, calledAt } = gated('回复', '不该出现');
    const { bot, sent, entries } = setup({ model, wait: { idleMs: 100, maxMs: 1000 } });

    const trigger = message({ text: 'nori 现在' });
    await bot.handle(trigger);
    const triggeredAt = Date.now();
    await sleep(50);
    await bot.handle(stale());
    await sleep(triggeredAt + 130 - Date.now());
    expect(calledAt).toHaveLength(0);
    while (calledAt.length === 0) await sleep(5);
    await bot.handle(stale());
    release();
    await bot.idle();

    expect(sent.map(({ text, replyTo }) => ({ text, replyTo }))).toEqual([
      { text: '回复', replyTo: trigger.message_id },
    ]);
    expect(entries.filter((e) => e.msg === 'telegram.stale')).toHaveLength(2);
  });

  it('回复中又被触发后开始退出：宽限期内只把进行中的这次发完，不再开始下一次', async () => {
    const { model, release, calledAt } = gated('第一次', '不该出现');
    const { bot, sent } = setup({ model });

    await bot.handle(message({ text: 'nori 讲个故事' }));
    while (calledAt.length === 0) await sleep(5);
    await bot.handle(message({ text: 'nori 我也要听' }));
    const closed = bot.close(10_000);
    await sleep(20);
    release();
    const startedAt = Date.now();
    await closed;

    expect(sent.map((s) => s.text)).toEqual(['第一次']);
    expect(calledAt).toHaveLength(1);
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });

  it('退出时等待中的会话直接放弃：不生成、不发送，「正在输入」停止，不等宽限期', async () => {
    const model = replying('不该出现');
    const { bot, sent, typing } = setup({
      model,
      wait: { idleMs: 5000, maxMs: 8000 },
      typingIntervalMs: 20,
    });

    await bot.handle(message({ text: 'nori 在吗' }));
    await sleep(30);
    const startedAt = Date.now();
    await bot.close(10_000);
    const count = typing.length;
    await sleep(60);

    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(model.doStreamCalls).toHaveLength(0);
    expect(sent).toEqual([]);
    expect(typing.length).toBe(count);
  });
});

describe('通知洛璃服务（onRound）', () => {
  async function conversationId(storage: Storage): Promise<string> {
    return (await storage.findConversation('telegram', String(group.id)))!.id;
  }

  it('进入等待、回复中又被触发、这一轮结束：各通知一次，带会话 id', async () => {
    const notices: RoundNotice[] = [];
    const { model, release, calledAt } = gated('第一次', '第二次');
    const { bot, sent, storage } = setup({ model, onRound: (notice) => notices.push(notice) });

    await bot.handle(message({ text: 'nori 讲个故事' }));
    expect(notices.map((notice) => notice.type)).toEqual(['wait']);
    while (calledAt.length === 0) await sleep(5);
    await bot.handle(message({ text: 'nori 我也要听' }));
    expect(notices.map((notice) => notice.type)).toEqual(['wait', 'again']);
    release();
    await bot.idle();

    expect(sent.map((s) => s.text)).toEqual(['第一次', '第二次']);
    const id = await conversationId(storage);
    expect(notices).toEqual([
      { type: 'wait', conversationId: id },
      { type: 'again', conversationId: id },
      { type: 'end', conversationId: id },
    ]);
  });

  it('退出时放弃等待：通知等待与结束，没有回复', async () => {
    const notices: RoundNotice[] = [];
    const model = replying('不该出现');
    const { bot, storage } = setup({
      model,
      wait: { idleMs: 5000, maxMs: 8000 },
      onRound: (notice) => notices.push(notice),
    });

    await bot.handle(message({ text: 'nori 在吗' }));
    await bot.close(0);

    const id = await conversationId(storage);
    expect(notices).toEqual([
      { type: 'wait', conversationId: id },
      { type: 'end', conversationId: id },
    ]);
    expect(model.doStreamCalls).toHaveLength(0);
  });

  it('回调出错不影响 Telegram：照常回复，日志多一条 telegram.notify_failed', async () => {
    const { model, release, calledAt } = gated('第一次', '第二次');
    const { bot, sent, entries } = setup({
      model,
      onRound: () => {
        throw new Error('推不出去');
      },
    });

    const first = message({ text: 'nori 讲个故事' });
    await bot.handle(first);
    while (calledAt.length === 0) await sleep(5);
    const second = message({ text: 'nori 我也要听' });
    await bot.handle(second);
    release();
    await bot.idle();

    expect(sent.map(({ text, replyTo }) => ({ text, replyTo }))).toEqual([
      { text: '第一次', replyTo: first.message_id },
      { text: '第二次', replyTo: second.message_id },
    ]);
    const failures = entries.filter((entry) => entry.msg === 'telegram.notify_failed');
    expect(failures.map((entry) => [entry.level, entry.fields.notice])).toEqual([
      ['warn', 'wait'],
      ['warn', 'again'],
      ['warn', 'end'],
    ]);
    expect(failures[0]!.fields.error).toEqual({ type: 'Error', message: '推不出去' });
  });
});

describe('编辑', () => {
  it('改历史里那条消息的正文并记 editedAt；附件不变；记 telegram.edited；不触发、不发送', async () => {
    const model = replying('好', '不该出现');
    const { bot, sent, storage, entries } = setup({ model });
    const original = message({ photo: [{ file_id: 'p', width: 8, height: 8 }], caption: '原来的' });
    await bot.handle(original);
    await bot.idle();

    const editDate = Math.floor(Date.now() / 1000);
    await bot.handle({ ...original, caption: 'nori 改过的', edit_date: editDate });
    await bot.idle();

    expect(sent).toEqual([]);
    expect(model.doStreamCalls).toHaveLength(0);
    expect(await historyOf(storage)).toEqual([
      {
        role: 'user',
        text: 'nori 改过的',
        files: 1,
        editedAt: new Date(editDate * 1000).toISOString(),
      },
    ]);
    expect(entries.filter((e) => e.msg.startsWith('telegram.'))).toEqual([
      {
        level: 'info',
        msg: 'telegram.edited',
        fields: { conversationId: expect.any(String), messageId: String(original.message_id) },
      },
    ]);
  });

  it('找不到被编辑的消息：记 telegram.edit_missing，不建会话、不做别的', async () => {
    const { bot, sent, storage, entries } = setup({ model: replying('不该出现') });

    await bot.handle(message({ message_id: 4242, text: 'nori 改过的', edit_date: 1 }));
    await bot.idle();

    expect(sent).toEqual([]);
    expect(await storage.listConversations('telegram')).toEqual([]);
    expect(entries.filter((e) => e.msg.startsWith('telegram.'))).toEqual([
      {
        level: 'info',
        msg: 'telegram.edit_missing',
        fields: { chatId: String(group.id), messageId: '4242' },
      },
    ]);
  });

  it('白名单外的编辑照旧忽略', async () => {
    const { bot, entries } = setup({ model: replying() });

    await bot.handle(message({ chat: { ...group, id: -1002 }, text: '改过的', edit_date: 1 }));

    expect(entries.map((e) => e.msg)).toEqual(['telegram.ignored']);
  });

  it('编辑不影响等待计时：编辑之后的回复里是新正文', async () => {
    const { model, calledAt } = gated('好');
    const { bot } = setup({ model, wait: { idleMs: 200, maxMs: 1000 } });
    const before = message({ text: '原来的说法' });
    await bot.handle(before);

    await bot.handle(message({ text: 'nori 帮我看看' }));
    const triggeredAt = Date.now();
    await sleep(150);
    await bot.handle({ ...before, text: '改过的说法', edit_date: 1 });
    while (calledAt.length === 0 && Date.now() < triggeredAt + 2000) await sleep(5);

    // 编辑若重置了计时，要到 350 毫秒之后才开始
    expect(calledAt[0]! - triggeredAt).toBeLessThan(330);
    expect(promptText(model, 0)).toContain('改过的说法');
    expect(promptText(model, 0)).not.toContain('原来的说法');
  });
});

describe('非文字消息', () => {
  it('照片下载后作为图片记录；相册由 albumOf 取回整组，合成一条，任一条触发即回复，引用第一条', async () => {
    const album = [
      message({ media_group_id: 'g', photo: [{ file_id: 'a', width: 8, height: 8 }] }),
      message({
        media_group_id: 'g',
        photo: [{ file_id: 'b', width: 8, height: 8 }],
        caption: 'nori 看看这两张',
      }),
    ];
    const model = replying('看到了');
    const { bot, sent, storage } = setup({ model, albums: [album] });

    // 适配器攒齐后派发的是最后一条
    await bot.handle(album[1]!);
    await bot.idle();

    expect(await historyOf(storage)).toMatchObject([
      { role: 'user', text: 'nori 看看这两张', files: 2 },
      { role: 'assistant', text: '看到了' },
    ]);
    expect(sent.map(({ replyTo }) => replyTo)).toEqual([album[0]!.message_id]);
    const prompt = model.doStreamCalls[0]!.prompt;
    const files = prompt.flatMap((m) =>
      Array.isArray(m.content) ? m.content.filter((part) => part.type === 'file') : [],
    );
    expect(files).toHaveLength(2);
  });

  it('「图片」内容与声明的类型不符：记占位，不作为图片；warn 日志 telegram.image_rejected 只有种类与大小，回复照常', async () => {
    const fake = new TextEncoder().encode('其实是文字');
    const model = replying('这是个文件');
    const { bot, storage, entries, sent } = setup({ model, files: { fake } });

    await bot.handle(
      message({
        document: { file_id: 'fake', file_name: 'fake.png', mime_type: 'image/png' },
        caption: 'nori 这个文件里是什么',
      }),
    );
    await bot.idle();

    expect(await historyOf(storage)).toMatchObject([
      { role: 'user', text: '[文件 fake.png]\nnori 这个文件里是什么', files: 0 },
      { role: 'assistant', text: '这是个文件' },
    ]);
    expect(sent.map((s) => s.text)).toEqual(['这是个文件']);
    expect(entries.filter((e) => e.msg === 'telegram.image_rejected')).toEqual([
      {
        level: 'warn',
        msg: 'telegram.image_rejected',
        fields: { conversationId: expect.any(String), kind: 'document', size: fake.length },
      },
    ]);
  });

  it('下载失败：记「[图片下载失败]」，warn 日志 telegram.download_failed 只有文件种类与大小', async () => {
    const { bot, storage, entries } = setup({ model: replying(), failingDownloads: ['bad'] });

    await bot.handle(message({ photo: [{ file_id: 'bad', width: 8, height: 8, file_size: 64 }] }));

    expect(await historyOf(storage)).toMatchObject([{ text: '[图片下载失败]', files: 0 }]);
    expect(entries.filter((e) => e.msg === 'telegram.download_failed')).toEqual([
      {
        level: 'warn',
        msg: 'telegram.download_failed',
        fields: { conversationId: expect.any(String), kind: 'photo', size: 64 },
      },
    ]);
  });
});

describe('分条发送（装了工具时）', () => {
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 1, text: 1, reasoning: undefined },
  };
  const text = (content: string): StreamPart[] => [
    { type: 'text-start', id: 't' },
    { type: 'text-delta', id: 't', delta: content },
    { type: 'text-end', id: 't' },
  ];
  const call = (id = 'c1'): StreamPart[] => [
    { type: 'tool-input-start', id, toolName: 'lookup' },
    { type: 'tool-input-delta', id, delta: '{}' },
    { type: 'tool-input-end', id },
    { type: 'tool-call', toolCallId: id, toolName: 'lookup', input: '{}' },
  ];
  const finish = (reason: 'stop' | 'tool-calls'): StreamPart => ({
    type: 'finish',
    finishReason: { unified: reason, raw: undefined },
    usage,
  });
  /** 这一步说了 content（可以为空）再调工具 */
  const callsTool = (content = ''): StreamPart[] => [
    ...(content ? text(content) : []),
    ...call(),
    finish('tool-calls'),
  ];
  const answer = (content: string): StreamPart[] => [...text(content), finish('stop')];
  /** 输出 content 后在流中报错 */
  const failsAfter = (content: string): StreamPart[] => [
    ...text(content).slice(0, -1),
    { type: 'error', error: { message: '服务端过载' } },
  ];
  const serverError = () =>
    new APICallError({
      message: 'HTTP 500',
      url: 'http://mock.test/v1/chat/completions',
      requestBodyValues: {},
      statusCode: 500,
      responseHeaders: { 'retry-after-ms': '0' },
    });

  /** 依次处理每次请求：段数组原样输出；Error 则请求失败 */
  function steps(...turns: Array<StreamPart[] | Error>) {
    let index = 0;
    return new MockLanguageModelV4({
      doStream: async () => {
        const turn = turns[index++] ?? answer('');
        if (turn instanceof Error) throw turn;
        return { stream: simulateReadableStream({ chunks: turn }) };
      },
    });
  }

  /**
   * 装上 lookup 工具的 bot：工具执行时记下群里已经发出的消息（seen，也用来知道工具开始执行了），
   * gate 给出时等它放行
   */
  function setupWithTool(model: MockLanguageModelV4, gate?: Promise<void>) {
    const seen: string[][] = [];
    let sentNow: () => string[] = () => [];
    const lookup = defineTool({
      name: 'lookup',
      description: '查一下',
      input: z.object({}),
      execute: async () => {
        seen.push(sentNow());
        await gate;
        return '查到了';
      },
    });
    // 发送要花一点时间，像真的网络请求：与工具执行并行
    const t = setup({ model, tools: installTools([lookup], {}).tools, sendDelayMs: 20 });
    sentNow = () => t.sent.map((s) => s.text);
    return { ...t, seen };
  }

  const quoted = (sent: Sent[]) => sent.map(({ text, replyTo }) => ({ text, replyTo }));

  it('两步回复：调工具前说的话在这一步结束时发出（回复还没结束），最后的回答另发，都引用触发消息', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { bot, sent } = setupWithTool(steps(callsTool('我查一下'), answer('查到了，是 4')), gate);

    const trigger = message({ text: 'nori 查一下' });
    await bot.handle(trigger);
    // 工具还卡在闸门上、回复没有结束：第一条已经发出
    const deadline = Date.now() + 2000;
    while (sent.length === 0 && Date.now() < deadline) await sleep(5);
    expect(quoted(sent)).toEqual([{ text: '我查一下', replyTo: trigger.message_id }]);
    release();
    await bot.idle();

    expect(quoted(sent)).toEqual([
      { text: '我查一下', replyTo: trigger.message_id },
      { text: '查到了，是 4', replyTo: trigger.message_id },
    ]);
  });

  it('只调工具、没说话的步不发', async () => {
    const { bot, sent } = setupWithTool(steps(callsTool(), answer('查到了')));

    const trigger = message({ text: 'nori 查一下' });
    await bot.handle(trigger);
    await bot.idle();

    expect(quoted(sent)).toEqual([{ text: '查到了', replyTo: trigger.message_id }]);
  });

  it('第 2 步失败：第 1 步的文字已发，第 2 步的半截不发，随后引用触发消息发失败提示', async () => {
    const { bot, sent } = setupWithTool(
      steps(callsTool('我查一下'), failsAfter('结果'), failsAfter('结果'), failsAfter('结果')),
    );

    const trigger = message({ text: 'nori 查一下' });
    await bot.handle(trigger);
    await bot.idle();

    expect(quoted(sent)).toEqual([
      { text: '我查一下', replyTo: trigger.message_id },
      { text: '（出错了）', replyTo: trigger.message_id },
    ]);
  });

  it('第 2 步请求失败：同样先有第 1 步的文字，再有失败提示', async () => {
    const { bot, sent } = setupWithTool(
      steps(callsTool('我查一下'), serverError(), serverError(), serverError()),
    );

    await bot.handle(message({ text: 'nori 查一下' }));
    await bot.idle();

    expect(sent.map((s) => s.text)).toEqual(['我查一下', '（出错了）']);
  });

  it('第 2 步流中途重试：第 1 步的文字只发一次，第 2 步只发重新生成后的文字', async () => {
    const { bot, sent } = setupWithTool(
      steps(callsTool('我查一下'), failsAfter('结果'), answer('结果是 4')),
    );

    const trigger = message({ text: 'nori 查一下' });
    await bot.handle(trigger);
    await bot.idle();

    expect(quoted(sent)).toEqual([
      { text: '我查一下', replyTo: trigger.message_id },
      { text: '结果是 4', replyTo: trigger.message_id },
    ]);
  });

  it('长文字拆分：每一步的第一段引用触发消息，其余不引用', async () => {
    const long = `${'a'.repeat(telegramMessageLimit)}${'b'.repeat(10)}`;
    const { bot, sent } = setupWithTool(steps(callsTool(long), answer(`${long}c`)));

    const trigger = message({ text: 'nori 讲长一点' });
    await bot.handle(trigger);
    await bot.idle();

    expect(sent.map(({ text, replyTo }) => ({ length: text.length, replyTo }))).toEqual([
      { length: telegramMessageLimit, replyTo: trigger.message_id },
      { length: 10, replyTo: undefined },
      { length: telegramMessageLimit, replyTo: trigger.message_id },
      { length: 11, replyTo: undefined },
    ]);
  });

  it('执行过工具、最后一步没有文字：不发失败提示，之前发出的保留', async () => {
    const { bot, sent } = setupWithTool(steps(callsTool('我查一下'), answer('')));

    await bot.handle(message({ text: 'nori 查一下' }));
    await bot.idle();

    expect(sent.map((s) => s.text)).toEqual(['我查一下']);
  });

  it('合并回复：工具执行期间又被触发，这次的各条都引用原来的触发，下一次的引用期间最后一条触发', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { bot, sent, seen } = setupWithTool(
      steps(callsTool('我查一下'), answer('查到了'), answer('第二次')),
      gate,
    );

    const first = message({ text: 'nori 查一下' });
    await bot.handle(first);
    const deadline = Date.now() + 2000;
    while (seen.length === 0 && Date.now() < deadline) await sleep(5);
    await bot.handle(message({ text: 'nori 还有我' }));
    const last = message({ text: 'nori 也查查我' });
    await bot.handle(last);
    release();
    await bot.idle();

    expect(quoted(sent)).toEqual([
      { text: '我查一下', replyTo: first.message_id },
      { text: '查到了', replyTo: first.message_id },
      { text: '第二次', replyTo: last.message_id },
    ]);
  });
});

describe('指令（/compact、/clear）', () => {
  const alicePrivate: TelegramChat = { id: alice.id, type: 'private', first_name: 'Alice' };
  const byAlice = { id: String(alice.id), name: 'Alice' };
  const quoted = (sent: Sent[]) => sent.map(({ text, replyTo }) => ({ text, replyTo }));

  async function waitFor(check: () => boolean, what = '条件'): Promise<void> {
    const deadline = Date.now() + 3000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`等待${what}超时`);
      await sleep(5);
    }
  }

  /** 在 ms 毫秒内返回为 true；被拖住时为 false（不让测试一直挂着） */
  async function returnsWithin(task: Promise<unknown>, ms = 1000): Promise<boolean> {
    return Promise.race([task.then(() => true), sleep(ms).then(() => false)]);
  }

  async function storeOf(storage: Storage, chatId: number = group.id) {
    const info = await storage.findConversation('telegram', String(chatId));
    return info && { id: info.id, store: await storage.openConversation(info.id) };
  }

  /** 各段：起点、原因、摘要、执行人 */
  async function segmentsOf(storage: Storage, chatId: number = group.id) {
    const found = await storeOf(storage, chatId);
    if (!found) return [];
    return (await found.store.segments()).map((segment) => ({
      startSeq: segment.startSeq,
      reason: segment.startReason,
      summary: segment.priorSummary,
      by: segment.startedBy,
    }));
  }

  /** 历史里的消息：序号、角色、正文 */
  async function entriesOf(storage: Storage, chatId: number = group.id) {
    const found = await storeOf(storage, chatId);
    if (!found) return [];
    return (await found.store.entries()).map(({ seq, message }) => ({
      seq,
      role: message.role,
      text: message.parts.map((part) => (part.type === 'text' ? part.text : '')).join(''),
    }));
  }

  type Entry = { level: string; msg: string; fields: Record<string, unknown> };
  const commandLogs = (entries: Entry[]) =>
    entries.filter((e) => e.msg === 'telegram.command').map((e) => e.fields);

  const minutesAgo = (minutes: number) => Math.floor(Date.now() / 1000) - minutes * 60;

  describe('执行', () => {
    it('群里发 /clear：不进历史、不触发回复；多一段清空的段，执行人是发指令的人；引用指令回「已清空上下文」。再发一次回「上下文已经是空的」，段不变', async () => {
      const model = replying('不该出现');
      const { bot, sent, typing, storage } = setup({ model });
      await bot.handle(message({ text: '今天读到第三章' }));

      const clear = message({ text: '/clear' });
      await bot.handle(clear);
      await bot.idle();

      expect(quoted(sent)).toEqual([{ text: '已清空上下文', replyTo: clear.message_id }]);
      expect(sent[0]!.target).toEqual({ chatId: group.id });
      expect(await entriesOf(storage)).toEqual([{ seq: 1, role: 'user', text: '今天读到第三章' }]);
      const segments = await segmentsOf(storage);
      expect(segments.at(-1)).toEqual({
        startSeq: 2,
        reason: 'clear',
        summary: undefined,
        by: byAlice,
      });
      expect(model.doStreamCalls).toHaveLength(0);
      // 清空不显示「正在输入」
      expect(typing).toEqual([]);

      const again = message({ text: '/clear' });
      await bot.handle(again);
      await bot.idle();

      expect(quoted(sent)).toEqual([
        { text: '已清空上下文', replyTo: clear.message_id },
        { text: '上下文已经是空的', replyTo: again.message_id },
      ]);
      expect(await segmentsOf(storage)).toEqual(segments);
      expect(model.doStreamCalls).toHaveLength(0);
    });

    it('群里发 /compact：执行期间发「正在输入」；多一段手动压缩的段，带摘要与执行人；引用指令回「已压缩」；之后的回复里 system 是新摘要、消息只有压缩之后的。段里没有消息时回「没有可压缩的内容」，不请求模型', async () => {
      const { model, release, calledAt } = gated('读书会的新摘要', '回复');
      const { bot, sent, typing, storage } = setup({ model, typingIntervalMs: 20 });
      await bot.handle(message({ text: '今天读到第三章' }));

      const compact = message({ text: '/compact' });
      await bot.handle(compact);
      await waitFor(() => calledAt.length === 1, '摘要请求');
      await sleep(50);
      // 压缩还没结束：「正在输入」一直在发，提示还没发
      expect(typing.length).toBeGreaterThanOrEqual(2);
      expect(typing[0]).toEqual({ chatId: group.id });
      expect(sent).toEqual([]);
      release();
      await bot.idle();
      const count = typing.length;
      await sleep(60);
      expect(typing.length).toBe(count);

      expect(quoted(sent)).toEqual([{ text: '已压缩', replyTo: compact.message_id }]);
      expect(promptText(model, 0)).toContain('今天读到第三章');
      expect((await segmentsOf(storage)).at(-1)).toEqual({
        startSeq: 2,
        reason: 'manual',
        summary: '读书会的新摘要',
        by: byAlice,
      });

      const again = message({ text: '/compact' });
      await bot.handle(again);
      await bot.idle();
      expect(quoted(sent).at(-1)).toEqual({ text: '没有可压缩的内容', replyTo: again.message_id });
      expect(model.doStreamCalls).toHaveLength(1);

      await bot.handle(message({ text: 'nori 我们读到哪了' }));
      await bot.idle();
      expect(sent.at(-1)!.text).toBe('回复');
      const prompt = promptText(model, 1);
      expect(prompt).toContain('读书会的新摘要');
      expect(prompt).toContain('nori 我们读到哪了');
      expect(prompt).not.toContain('今天读到第三章');
      // 指令本身不进历史，也不会出现在请求里
      expect(prompt).not.toContain('/compact');
      expect((await entriesOf(storage)).map((entry) => entry.text)).toEqual([
        '今天读到第三章',
        'nori 我们读到哪了',
        '回复',
      ]);
    });

    it('私聊里同样能用，提示发回私聊；指令不触发回复', async () => {
      const model = replying('好', '不该出现');
      const { bot, sent, storage } = setup({ model, users: [String(alice.id)] });
      await bot.handle(message({ chat: alicePrivate, text: '在吗' }));
      await bot.idle();

      const clear = message({ chat: alicePrivate, text: '/clear' });
      await bot.handle(clear);
      await bot.idle();

      expect(sent.map(({ target, text, replyTo }) => ({ target, text, replyTo }))).toEqual([
        { target: { chatId: alice.id }, text: '好', replyTo: expect.any(Number) },
        { target: { chatId: alice.id }, text: '已清空上下文', replyTo: clear.message_id },
      ]);
      expect(model.doStreamCalls).toHaveLength(1);
      expect((await segmentsOf(storage, alice.id)).at(-1)).toMatchObject({
        startSeq: 3,
        reason: 'clear',
        by: byAlice,
      });
      expect(await entriesOf(storage, alice.id)).toHaveLength(2);
    });

    it('论坛群的话题里：「正在输入」和提示都发回指令所在的话题', async () => {
      const model = replying('话题里的摘要');
      const { bot, sent, typing } = setup({ model });
      const topic = { is_topic_message: true, message_thread_id: 77 };
      await bot.handle(message({ text: '话题里的闲聊', ...topic }));

      const compact = message({ text: '/compact@nori_bot', ...topic });
      await bot.handle(compact);
      await bot.idle();

      expect(typing[0]).toEqual({ chatId: group.id, messageThreadId: 77 });
      expect(sent).toEqual([
        {
          target: { chatId: group.id, messageThreadId: 77 },
          text: '已压缩',
          replyTo: compact.message_id,
        },
      ]);
    });

    it('还没有会话的聊天（白名单里、从没说过话）：不建会话，/clear 回「上下文已经是空的」，/compact 回「没有可压缩的内容」', async () => {
      const model = replying('不该出现');
      const { bot, sent, storage, entries } = setup({ model, users: [String(alice.id)] });

      const clear = message({ text: '/clear' });
      await bot.handle(clear);
      const compact = message({ chat: alicePrivate, text: '/compact' });
      await bot.handle(compact);
      await bot.idle();

      expect(sent).toEqual([
        { target: { chatId: group.id }, text: '上下文已经是空的', replyTo: clear.message_id },
        { target: { chatId: alice.id }, text: '没有可压缩的内容', replyTo: compact.message_id },
      ]);
      expect(await storage.listConversations('telegram')).toEqual([]);
      expect(model.doStreamCalls).toHaveLength(0);
      expect(commandLogs(entries)).toEqual([
        {
          chatId: String(group.id),
          command: 'clear',
          byId: '11',
          result: 'already-empty',
          waitedMs: expect.any(Number),
          ranMs: expect.any(Number),
        },
        {
          chatId: String(alice.id),
          command: 'compact',
          byId: '11',
          result: 'nothing-to-compact',
          waitedMs: expect.any(Number),
          ranMs: expect.any(Number),
        },
      ]);
    });

    it('白名单之外的群、私聊发指令：没有任何动作，日志只有 telegram.ignored', async () => {
      const model = replying('不该出现');
      const { bot, sent, typing, storage, entries } = setup({ model });

      await bot.handle(message({ chat: { ...group, id: -1002 }, text: '/clear' }));
      await bot.handle(message({ chat: alicePrivate, text: '/compact' }));
      await bot.idle();

      expect(sent).toEqual([]);
      expect(typing).toEqual([]);
      expect(await storage.listConversations('telegram')).toEqual([]);
      expect(model.doStreamCalls).toHaveLength(0);
      expect(entries.map((e) => e.msg)).toEqual(['telegram.ignored', 'telegram.ignored']);
    });

    it('指令结束的那行日志：会话 id、指令、执行人的 id、结果、等了多久、执行了多久，没有正文和名字', async () => {
      const { bot, storage, entries } = setup({ model: replying('不该出现') });
      await bot.handle(message({ text: '今天读到第三章' }));
      await bot.handle(message({ text: '/clear' }));
      await bot.idle();

      const id = (await storage.findConversation('telegram', String(group.id)))!.id;
      const logs = commandLogs(entries);
      expect(logs).toEqual([
        {
          conversationId: id,
          command: 'clear',
          byId: '11',
          result: 'cleared',
          waitedMs: expect.any(Number),
          ranMs: expect.any(Number),
        },
      ]);
      expect(logs[0]!.waitedMs).toBeGreaterThanOrEqual(0);
      expect(logs[0]!.ranMs).toBeGreaterThanOrEqual(0);
      const telegramLines = JSON.stringify(entries.filter((e) => e.msg.startsWith('telegram.')));
      expect(telegramLines).not.toContain('Alice');
      expect(telegramLines).not.toContain('/clear');
      expect(telegramLines).not.toContain('第三章');
    });
  });

  describe('等一轮回复结束', () => {
    it('等待合并期间发 /clear：不重置等待的计时；这一轮照常回复，回复发出后才清空并回提示；那次回复和它回答的消息都在旧的一段里', async () => {
      const { model, release, calledAt } = gated('回复');
      release();
      const { bot, sent, storage } = setup({ model, wait: { idleMs: 150, maxMs: 1000 } });

      const trigger = message({ text: 'nori 第三章讲了什么' });
      await bot.handle(trigger);
      const triggeredAt = Date.now();
      await sleep(100);
      const clear = message({ text: '/clear' });
      await bot.handle(clear);
      await bot.idle();

      // 指令若重置了计时，要到 250 毫秒之后才开始
      expect(calledAt[0]! - triggeredAt).toBeLessThan(240);
      expect(quoted(sent)).toEqual([
        { text: '回复', replyTo: trigger.message_id },
        { text: '已清空上下文', replyTo: clear.message_id },
      ]);
      expect(promptText(model, 0)).toContain('nori 第三章讲了什么');
      expect(await entriesOf(storage)).toEqual([
        { seq: 1, role: 'user', text: 'nori 第三章讲了什么' },
        { seq: 2, role: 'assistant', text: '回复' },
      ]);
      expect((await segmentsOf(storage)).at(-1)).toMatchObject({ startSeq: 3, reason: 'clear' });
    });

    it('回复中发 /clear，之后又有人触发：补回复也发出后才清空；补回复看得到期间的新消息', async () => {
      const { model, release, calledAt } = gated('第一次', '第二次');
      const { bot, sent, storage } = setup({ model });

      const first = message({ text: 'nori 讲个故事' });
      await bot.handle(first);
      await waitFor(() => calledAt.length === 1, '第一次请求');
      const clear = message({ text: '/clear' });
      await bot.handle(clear);
      const second = message({ text: 'nori 我也要听' });
      await bot.handle(second);
      release();
      await bot.idle();

      expect(quoted(sent)).toEqual([
        { text: '第一次', replyTo: first.message_id },
        { text: '第二次', replyTo: second.message_id },
        { text: '已清空上下文', replyTo: clear.message_id },
      ]);
      expect(promptText(model, 1)).toContain('nori 我也要听');
      expect(promptText(model, 1)).not.toContain('/clear');
      const entries = await entriesOf(storage);
      expect(entries.map((entry) => entry.text)).toEqual([
        'nori 讲个故事',
        '第一次',
        'nori 我也要听',
        '第二次',
      ]);
      expect((await segmentsOf(storage)).at(-1)).toMatchObject({
        startSeq: entries.at(-1)!.seq + 1,
        reason: 'clear',
      });
    });

    it('回复中先后发 /compact、/clear：这一轮结束后按先后执行，两句提示按先后发出', async () => {
      const { model, release, calledAt } = gated('第一次', '摘要');
      const { bot, sent, entries } = setup({ model });

      const first = message({ text: 'nori 讲个故事' });
      await bot.handle(first);
      await waitFor(() => calledAt.length === 1, '第一次请求');
      const compact = message({ text: '/compact' });
      await bot.handle(compact);
      const clear = message({ text: '/clear' });
      await bot.handle(clear);
      await sleep(30);
      // 回复还没结束：两条都在等
      expect(calledAt).toHaveLength(1);
      expect(sent).toEqual([]);
      release();
      await bot.idle();

      expect(quoted(sent)).toEqual([
        { text: '第一次', replyTo: first.message_id },
        { text: '已压缩', replyTo: compact.message_id },
        { text: '已清空上下文', replyTo: clear.message_id },
      ]);
      expect(calledAt).toHaveLength(2);
      expect(commandLogs(entries).map((fields) => [fields.command, fields.result])).toEqual([
        ['compact', 'compacted'],
        ['clear', 'cleared'],
      ]);
    });

    it('压缩进行中有人触发：回复在压缩结束后才请求模型，system 里是新摘要、消息里有这条触发；这一轮回复期间再发的指令等它结束才执行', async () => {
      const { model, release, calledAt } = gated('压缩出来的摘要', '回复');
      const { bot, sent, storage } = setup({ model });
      await bot.handle(message({ text: '压缩之前的话' }));

      const compact = message({ text: '/compact' });
      await bot.handle(compact);
      await waitFor(() => calledAt.length === 1, '摘要请求');
      const trigger = message({ text: 'nori 在吗' });
      await bot.handle(trigger);
      // 等待合并（5 毫秒）早就过了，回复已经开始，在等压缩
      await sleep(60);
      expect(calledAt).toHaveLength(1);
      const clear = message({ text: '/clear' });
      await bot.handle(clear);
      const releasedAt = Date.now();
      release();
      await bot.idle();

      expect(calledAt).toHaveLength(2);
      expect(calledAt[1]!).toBeGreaterThanOrEqual(releasedAt);
      const prompt = promptText(model, 1);
      expect(prompt).toContain('压缩出来的摘要');
      expect(prompt).toContain('nori 在吗');
      expect(prompt).not.toContain('压缩之前的话');
      // 压缩的提示和回复谁先发出不一定；清空等这一轮结束，最后才发
      expect(quoted(sent)).toEqual(
        expect.arrayContaining([
          { text: '已压缩', replyTo: compact.message_id },
          { text: '回复', replyTo: trigger.message_id },
        ]),
      );
      expect(quoted(sent)).toHaveLength(3);
      expect(quoted(sent)[2]).toEqual({ text: '已清空上下文', replyTo: clear.message_id });
      const entries = await entriesOf(storage);
      expect(entries.map((entry) => entry.text)).toEqual(['压缩之前的话', 'nori 在吗', '回复']);
      const segments = await segmentsOf(storage);
      expect(segments.slice(-2)).toEqual([
        { startSeq: 2, reason: 'manual', summary: '压缩出来的摘要', by: byAlice },
        { startSeq: entries.at(-1)!.seq + 1, reason: 'clear', summary: undefined, by: byAlice },
      ]);
    });

    it('压缩进行中群里有普通消息：handle 没有被压缩拖住，消息照常记录，在新的一段里', async () => {
      const { model, release, calledAt } = gated('摘要');
      const { bot, sent, storage } = setup({ model });
      await bot.handle(message({ text: '压缩之前的话' }));

      expect(await returnsWithin(bot.handle(message({ text: '/compact' })))).toBe(true);
      await waitFor(() => calledAt.length === 1, '摘要请求');
      expect(await returnsWithin(bot.handle(message({ text: '压缩期间的闲聊' })))).toBe(true);
      expect((await entriesOf(storage)).map((entry) => entry.text)).toEqual([
        '压缩之前的话',
        '压缩期间的闲聊',
      ]);
      expect(sent).toEqual([]);
      release();
      await bot.idle();

      expect(sent.map((s) => s.text)).toEqual(['已压缩']);
      expect(promptText(model, 0)).not.toContain('压缩期间的闲聊');
      // 期间的闲聊是 2 号，新的一段从它开始
      expect((await segmentsOf(storage)).at(-1)).toMatchObject({
        startSeq: 2,
        reason: 'manual',
      });
    });

    it('一轮结束的那一刻就执行，中间不留空当：「这一轮结束」的通知里紧接着来的消息，在清空之后的一段里', async () => {
      const { model, release, calledAt } = gated('回复');
      let next: Promise<void> | undefined;
      const { bot, sent, storage } = setup({
        model,
        // 收到这一轮结束的通知时马上来一条普通消息。执行指令之前要是先等了一下（哪怕一个
        // setTimeout(0)），它就会抢在清空之前写进历史，落进被清掉的旧段
        onRound: (notice) => {
          if (notice.type === 'end' && !next) {
            next = bot.handle(message({ text: '紧接着的一句' }));
          }
        },
      });

      const trigger = message({ text: 'nori 讲个故事' });
      await bot.handle(trigger);
      await waitFor(() => calledAt.length === 1, '第一次请求');
      const clear = message({ text: '/clear' });
      await bot.handle(clear);
      release();
      await bot.idle();
      await next;

      expect(quoted(sent)).toEqual([
        { text: '回复', replyTo: trigger.message_id },
        { text: '已清空上下文', replyTo: clear.message_id },
      ]);
      expect(await entriesOf(storage)).toEqual([
        { seq: 1, role: 'user', text: 'nori 讲个故事' },
        { seq: 2, role: 'assistant', text: '回复' },
        { seq: 3, role: 'user', text: '紧接着的一句' },
      ]);
      // 清空的段从这条消息开始：它不在被清掉的旧段里
      expect((await segmentsOf(storage)).at(-1)).toEqual({
        startSeq: 3,
        reason: 'clear',
        summary: undefined,
        by: byAlice,
      });
    });
  });

  describe('失败与不执行', () => {
    it('压缩失败（模型报错）：引用指令回「压缩失败」，段不变；之后还能再压缩', async () => {
      let call = 0;
      const model = new MockLanguageModelV4({
        doStream: async (options) => {
          if (call++ === 0) throw new Error('模型挂了');
          return replying('第二次的摘要').doStream(options);
        },
      });
      const { bot, sent, storage, entries } = setup({ model });
      await bot.handle(message({ text: '今天读到第三章' }));
      const segments = await segmentsOf(storage);

      const compact = message({ text: '/compact' });
      await bot.handle(compact);
      await bot.idle();

      expect(quoted(sent)).toEqual([{ text: '压缩失败', replyTo: compact.message_id }]);
      expect(await segmentsOf(storage)).toEqual(segments);
      expect(entries.map((e) => e.msg)).toContain('summary.failed');
      expect(commandLogs(entries).map((fields) => fields.result)).toEqual(['failed']);
      // 详情只在核心的 summary.failed 里，群里只有那句话
      expect(sent.map((s) => s.text).join('')).not.toContain('模型挂了');

      const again = message({ text: '/compact' });
      await bot.handle(again);
      await bot.idle();
      expect(quoted(sent).at(-1)).toEqual({ text: '已压缩', replyTo: again.message_id });
      expect((await segmentsOf(storage)).at(-1)).toMatchObject({
        reason: 'manual',
        summary: '第二次的摘要',
      });
    });

    it('清空失败（存储出错）：引用指令回「清空失败」，段不变；错误记在指令的那一行', async () => {
      const storage = createMemoryStorage();
      const openConversation = storage.openConversation.bind(storage);
      storage.openConversation = async (id) => {
        const store = await openConversation(id);
        return {
          ...store,
          addSegment: async () => {
            throw new Error('磁盘满了');
          },
        };
      };
      const { bot, sent, entries } = setup({ model: replying('不该出现'), storage });
      await bot.handle(message({ text: '今天读到第三章' }));
      const segments = await segmentsOf(storage);

      const clear = message({ text: '/clear' });
      await bot.handle(clear);
      await bot.idle();

      expect(quoted(sent)).toEqual([{ text: '清空失败', replyTo: clear.message_id }]);
      expect(await segmentsOf(storage)).toEqual(segments);
      expect(commandLogs(entries)).toEqual([
        expect.objectContaining({
          command: 'clear',
          result: 'failed',
          error: { type: 'Error', message: '磁盘满了' },
        }),
      ]);
    });

    it('核心以「正忙」拒绝（绕开 bot 直接开始了一次回复）：当作失败回「清空失败」，另记一行 telegram.command_busy', async () => {
      const { model, release, calledAt } = gated('不经 bot 的回复');
      const { bot, sent, storage, entries, conversations } = setup({ model });
      await bot.handle(message({ text: '你好' }));
      const reading = conversations[0]!.reply().pipeTo(new WritableStream());
      await waitFor(() => calledAt.length === 1, '回复的请求');

      const clear = message({ text: '/clear' });
      await bot.handle(clear);
      await bot.idle();

      expect(quoted(sent)).toEqual([{ text: '清空失败', replyTo: clear.message_id }]);
      const id = (await storage.findConversation('telegram', String(group.id)))!.id;
      expect(entries.filter((e) => e.msg === 'telegram.command_busy')).toEqual([
        {
          level: 'error',
          msg: 'telegram.command_busy',
          fields: { conversationId: id, command: 'clear', reason: 'replying' },
        },
      ]);
      expect(commandLogs(entries).map((fields) => fields.result)).toEqual(['failed']);
      release();
      await reading;
    });

    it('过期的指令（发送时间早于时限）：不执行、不回提示，日志一行', async () => {
      const model = replying('不该出现');
      const { bot, sent, typing, storage, entries } = setup({ model });
      await bot.handle(message({ text: '今天读到第三章' }));
      const segments = await segmentsOf(storage);

      await bot.handle(message({ text: '/compact', date: minutesAgo(61) }));
      await bot.idle();

      expect(sent).toEqual([]);
      expect(typing).toEqual([]);
      expect(model.doStreamCalls).toHaveLength(0);
      expect(await segmentsOf(storage)).toEqual(segments);
      expect(await entriesOf(storage)).toHaveLength(1);
      expect(commandLogs(entries)).toEqual([
        {
          chatId: String(group.id),
          ageMinutes: 61,
          command: 'compact',
          byId: '11',
          result: 'stale',
          waitedMs: expect.any(Number),
        },
      ]);
    });

    it('把一条旧消息编辑成 /clear：照编辑处理（历史里那条的正文变了），没有清空', async () => {
      const { bot, sent, storage, entries } = setup({ model: replying('不该出现') });
      const original = message({ text: '原来的话' });
      await bot.handle(original);
      const segments = await segmentsOf(storage);

      await bot.handle({ ...original, text: '/clear', edit_date: Math.floor(Date.now() / 1000) });
      await bot.idle();

      expect(await entriesOf(storage)).toEqual([{ seq: 1, role: 'user', text: '/clear' }]);
      expect(await segmentsOf(storage)).toEqual(segments);
      expect(sent).toEqual([]);
      expect(commandLogs(entries)).toEqual([]);
      expect(entries.map((e) => e.msg)).toContain('telegram.edited');
    });

    it('不算指令的（/clear 现在、/clear@别的bot、说明文字是 /clear 的图片）：照普通消息记录；私聊里照常触发回复', async () => {
      const model = replying('私聊里的回复');
      const { bot, sent, storage, entries } = setup({ model, users: [String(alice.id)] });

      await bot.handle(message({ text: '/clear 现在' }));
      await bot.handle(message({ text: '/clear@other_bot' }));
      await bot.handle(
        message({ photo: [{ file_id: 'p', width: 8, height: 8 }], caption: '/clear' }),
      );
      await bot.idle();
      expect(sent).toEqual([]);
      expect((await entriesOf(storage)).map((entry) => entry.text)).toEqual([
        '/clear 现在',
        '/clear@other_bot',
        '/clear',
      ]);
      expect(await segmentsOf(storage)).toHaveLength(1);

      const privately = message({ chat: alicePrivate, text: '/compact 记住旅行计划' });
      await bot.handle(privately);
      await bot.idle();
      expect(quoted(sent)).toEqual([{ text: '私聊里的回复', replyTo: privately.message_id }]);
      expect(promptText(model, 0)).toContain('/compact 记住旅行计划');
      expect(commandLogs(entries)).toEqual([]);
    });
  });

  describe('关闭', () => {
    it('还在等的指令丢掉：不执行、不发提示，各记一行 closing', async () => {
      const model = replying({ text: '永远等不到', gate: new Promise<void>(() => {}) });
      const { bot, sent, storage, entries } = setup({ model });
      await bot.handle(message({ text: 'nori 在吗' }));
      await waitFor(() => model.doStreamCalls.length === 1, '回复的请求');
      const segments = await segmentsOf(storage);
      await bot.handle(message({ text: '/clear' }));
      await bot.handle(message({ text: '/compact' }));

      await bot.close(30);
      await sleep(30);

      expect(sent).toEqual([]);
      expect(model.doStreamCalls).toHaveLength(1);
      expect(await segmentsOf(storage)).toEqual(segments);
      expect(commandLogs(entries).map((fields) => [fields.command, fields.result])).toEqual([
        ['clear', 'closing'],
        ['compact', 'closing'],
      ]);
    });

    it('进行中的压缩马上中止：段不变、没有提示；不等满宽限期（回复在等这次压缩时也一样）', async () => {
      const model = replying({ text: '不会用上的摘要', gate: new Promise<void>(() => {}) }, '回复');
      const { bot, sent, storage, entries } = setup({ model });
      await bot.handle(message({ text: '今天读到第三章' }));
      const segments = await segmentsOf(storage);
      await bot.handle(message({ text: '/compact' }));
      await waitFor(() => model.doStreamCalls.length === 1, '摘要请求');
      // 一轮回复已经开始，在核心里等这次压缩
      await bot.handle(message({ text: 'nori 在吗' }));
      await sleep(30);

      const startedAt = Date.now();
      await bot.close(10_000);

      expect(Date.now() - startedAt).toBeLessThan(1000);
      expect(await segmentsOf(storage)).toEqual(segments);
      // 宽限期内回复照常发完（关闭的原有规则）；压缩没有提示
      expect(sent.map((s) => s.text)).toEqual(['回复']);
      expect(entries.map((e) => e.msg)).toContain('summary.aborted');
      expect(commandLogs(entries).map((fields) => [fields.command, fields.result])).toEqual([
        ['compact', 'aborted'],
      ]);
    });

    it('关闭时被放弃的等待中的一轮，没有带出排着的指令的执行', async () => {
      const model = replying('不该出现');
      const { bot, sent, storage, entries } = setup({
        model,
        wait: { idleMs: 5000, maxMs: 8000 },
      });
      await bot.handle(message({ text: '今天读到第三章' }));
      await bot.handle(message({ text: 'nori 在吗' }));
      const segments = await segmentsOf(storage);
      await bot.handle(message({ text: '/clear' }));

      await bot.close(10_000);
      await sleep(30);

      expect(sent).toEqual([]);
      expect(model.doStreamCalls).toHaveLength(0);
      expect(await segmentsOf(storage)).toEqual(segments);
      expect(commandLogs(entries).map((fields) => fields.result)).toEqual(['closing']);
    });

    it('进行中的清空照常做完（不发提示）；各会话等它结束才关闭', async () => {
      const storage = createMemoryStorage();
      const openConversation = storage.openConversation.bind(storage);
      let slow = false;
      storage.openConversation = async (id) => {
        const store = await openConversation(id);
        return {
          ...store,
          currentSegment: async () => {
            if (slow) await sleep(50);
            return store.currentSegment();
          },
        };
      };
      const { bot, sent, entries } = setup({ model: replying('不该出现'), storage });
      await bot.handle(message({ text: '今天读到第三章' }));
      slow = true;

      await bot.handle(message({ text: '/clear' }));
      await bot.close(0);

      expect(sent).toEqual([]);
      expect((await segmentsOf(storage)).at(-1)).toMatchObject({ startSeq: 2, reason: 'clear' });
      expect(commandLogs(entries).map((fields) => fields.result)).toEqual(['cleared']);
    });

    it('关闭之后再发指令：不执行，记一行 closing', async () => {
      const { bot, sent, storage, entries } = setup({ model: replying('不该出现') });
      await bot.handle(message({ text: '今天读到第三章' }));
      const segments = await segmentsOf(storage);
      await bot.close(0);

      await bot.handle(message({ text: '/clear' }));
      await bot.idle();

      expect(sent).toEqual([]);
      expect(await segmentsOf(storage)).toEqual(segments);
      expect(commandLogs(entries).map((fields) => fields.result)).toEqual(['closing']);
    });
  });
});
