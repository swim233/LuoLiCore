import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, describe, expect, it } from 'vitest';
import type { TelegramChat, TelegramUser } from '@chat-adapter/telegram';
import {
  createMemoryFileStore,
  createMemoryStorage,
  type Logger,
  type MessageChunk,
  type Storage,
} from '../core/index.js';
import { testPrompts } from '../core/test-prompts.js';
import { startTelegram } from '../telegram/app.js';
import { startFakeTelegram } from '../telegram/fake-api.js';
import { createSessions, type ReplyWatcher } from './sessions.js';

type StreamResult = Awaited<ReturnType<MockLanguageModelV4['doStream']>>;
type StreamPart = StreamResult['stream'] extends ReadableStream<infer P> ? P : never;

/** 依次回复这些文字；带 gate 的等它放行才输出 */
function replying(...turns: Array<string | { text: string; gate: Promise<void> }>) {
  let call = 0;
  return new MockLanguageModelV4({
    doStream: async ({ abortSignal }) => {
      const turn = turns[call++] ?? '（没有更多脚本）';
      const { text, gate } = typeof turn === 'string' ? { text: turn, gate: undefined } : turn;
      if (gate) {
        await new Promise<void>((resolve, reject) => {
          void gate.then(resolve);
          abortSignal?.addEventListener('abort', () => reject(abortSignal.reason), { once: true });
        });
      }
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
      return { stream: simulateReadableStream({ chunks: parts }) };
    },
  });
}

/**
 * 依次吐出 a～e 五段（像 HTTP 的响应体，核心拉一段给一段），然后挂住，直到被中止
 */
function stalling(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async ({ abortSignal }) => {
      const parts: StreamPart[] = [
        { type: 'text-start', id: 't' },
        ...['a', 'b', 'c', 'd', 'e'].map((delta) => ({
          type: 'text-delta' as const,
          id: 't',
          delta,
        })),
      ];
      let next = 0;
      const stream = new ReadableStream<StreamPart>(
        {
          pull(controller) {
            if (next < parts.length) {
              controller.enqueue(parts[next++]!);
              return;
            }
            return new Promise<void>((_, reject) => {
              abortSignal?.addEventListener('abort', () => reject(abortSignal.reason), {
                once: true,
              });
            });
          },
        },
        { highWaterMark: 0 },
      );
      return { stream };
    },
  });
}

function gate(): { gate: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { gate: promise, release };
}

type LogEntry = { level: string; msg: string; fields: Record<string, unknown> };

function recordingLogger(): { logger: Logger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const record = (level: string) => (fields: object, msg: string) => {
    entries.push({ level, msg, fields: fields as Record<string, unknown> });
  };
  return {
    logger: { info: record('info'), warn: record('warn'), error: record('error') },
    entries,
  };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function setup(model: MockLanguageModelV4, { storage = createMemoryStorage() } = {}) {
  const { logger, entries } = recordingLogger();
  const sessions = createSessions({
    model,
    prompts: testPrompts('你是测试助手'),
    storage,
    fileStore: createMemoryFileStore(),
    logger,
    maxRetries: 0,
  });
  let closed = false;
  cleanups.push(async () => {
    if (!closed) await sessions.close(0);
  });
  return {
    sessions,
    storage,
    entries,
    close: async (graceMs?: number, settleMs?: number) => {
      closed = true;
      await sessions.close(graceMs, settleMs);
    },
  };
}

async function newConversation(storage: Storage, platform = 'web'): Promise<string> {
  return storage.createConversation({ platform });
}

async function readAll(stream: ReadableStream<MessageChunk>): Promise<MessageChunk[]> {
  const chunks: MessageChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

const textOf = (chunks: MessageChunk[]) =>
  chunks.map((chunk) => (chunk.type === 'text-delta' ? chunk.delta : '')).join('');

async function historyOf(storage: Storage, id: string) {
  const store = await storage.openConversation(id);
  return (await store.list()).map((message) => ({
    role: message.role,
    text: message.parts.map((part) => (part.type === 'text' ? part.text : '')).join(''),
    aborted: message.metadata?.aborted,
  }));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const author = { id: 'u1', name: 'Alice' };

describe('会话管理', () => {
  it('同一个会话只打开一次：并发打开、之后再打开都是同一个对象', async () => {
    const { sessions, storage, entries } = setup(replying('好'));
    const id = await newConversation(storage);
    const openConversation = storage.openConversation.bind(storage);
    let opens = 0;
    storage.openConversation = async (conversationId) => {
      opens++;
      return openConversation(conversationId);
    };

    const [a, b] = await Promise.all([sessions.open(id), sessions.open(id)]);
    const c = await sessions.open(id, { checkIdleOnCreate: false });

    expect(a).toBe(b);
    expect(a).toBe(c);
    expect(opens).toBe(1);
    expect(entries.filter((entry) => entry.msg === 'sessions.open')).toEqual([
      { level: 'info', msg: 'sessions.open', fields: { conversationId: id } },
    ]);
  });

  it('不同的会话各是各的对象', async () => {
    const { sessions, storage } = setup(replying('好'));
    const [first, second] = [await newConversation(storage), await newConversation(storage)];

    expect(await sessions.open(first)).not.toBe(await sessions.open(second));
  });

  it('打开失败（会话不存在）时不留下，之后可以再试', async () => {
    const { sessions, storage } = setup(replying('好'));
    const openConversation = storage.openConversation.bind(storage);
    let fail = true;
    storage.openConversation = async (conversationId) => {
      if (fail) throw new Error('数据库忙');
      return openConversation(conversationId);
    };
    const id = await newConversation(storage);

    await expect(sessions.open(id)).rejects.toThrow('数据库忙');
    fail = false;
    await expect(sessions.open(id)).resolves.toBeDefined();
  });

  it('回复经过会话管理：输出与核心的一样，写入历史；旁听者依次收到每个段和结束', async () => {
    const { sessions, storage } = setup(replying('你好呀'));
    const id = await newConversation(storage);
    const heard: Array<{ conversationId: string; chunks: string[]; ended: boolean }> = [];
    sessions.onReply(({ conversationId }) => {
      const record = { conversationId, chunks: [] as string[], ended: false };
      heard.push(record);
      return {
        chunk: (chunk) => record.chunks.push(chunk.type),
        end: () => (record.ended = true),
      };
    });

    const conversation = await sessions.open(id);
    await conversation.append({ author, text: '在吗' });
    const chunks = await readAll(conversation.reply());

    expect(textOf(chunks)).toBe('你好呀');
    expect(heard).toEqual([
      { conversationId: id, chunks: chunks.map((chunk) => chunk.type), ended: true },
    ]);
    expect(sessions.replying).toBe(0);
    expect(await historyOf(storage, id)).toEqual([
      { role: 'user', text: '在吗', aborted: undefined },
      { role: 'assistant', text: '你好呀', aborted: undefined },
    ]);
  });

  it('取消旁听之后的回复不再收到；旁听者出错只记日志，不影响回复', async () => {
    const { sessions, storage, entries } = setup(replying('一', '二'));
    const id = await newConversation(storage);
    const heard: string[] = [];
    const stop = sessions.onReply(() => ({ end: () => heard.push('end') }));
    sessions.onReply(() => ({
      chunk: () => {
        throw new Error('旁听者坏了');
      },
    }));
    const conversation = await sessions.open(id);

    await conversation.append({ author, text: '一' });
    expect(textOf(await readAll(conversation.reply()))).toBe('一');
    stop();
    await conversation.append({ author, text: '二' });
    expect(textOf(await readAll(conversation.reply()))).toBe('二');

    expect(heard).toEqual(['end']);
    expect(
      entries.filter((entry) => entry.msg === 'sessions.listener_failed').length,
    ).toBeGreaterThan(0);
  });

  it('消费方中途取消流：这次回复算结束，旁听者收到结束', async () => {
    const { release, gate: wait } = gate();
    const { sessions, storage } = setup(replying({ text: '很长的回复', gate: wait }));
    const id = await newConversation(storage);
    const ended: string[] = [];
    sessions.onReply(({ conversationId }) => ({ end: () => ended.push(conversationId) }));
    const conversation = await sessions.open(id);
    await conversation.append({ author, text: '在吗' });

    const reader = conversation.reply().getReader();
    await reader.read();
    expect(sessions.replying).toBe(1);
    await reader.cancel();
    release();

    expect(ended).toEqual([id]);
    expect(sessions.replying).toBe(0);
  });

  it('前端调会话对象的 close() 不关闭它：会话由会话管理统一关闭，之后照常回复', async () => {
    const { sessions, storage } = setup(replying('还在'));
    const id = await newConversation(storage);
    const conversation = await sessions.open(id);

    await conversation.close();
    await conversation.append({ author, text: '在吗' });

    expect(textOf(await readAll(conversation.reply()))).toBe('还在');
    expect(await sessions.open(id)).toBe(conversation);
  });

  describe('关闭', () => {
    it('等进行中的回复完成再关闭；回复照常写入历史', async () => {
      const { release, gate: wait } = gate();
      const { sessions, storage, close } = setup(replying({ text: '说完了', gate: wait }));
      const id = await newConversation(storage);
      const conversation = await sessions.open(id);
      await conversation.append({ author, text: '讲个故事' });
      const reading = readAll(conversation.reply());
      await sleep(20);

      let closed = false;
      const closing = close(10_000).then(() => (closed = true));
      await sleep(30);
      expect(closed).toBe(false);
      release();
      await closing;

      expect(textOf(await reading)).toBe('说完了');
      expect(await historyOf(storage, id)).toEqual([
        { role: 'user', text: '讲个故事', aborted: undefined },
        { role: 'assistant', text: '说完了', aborted: undefined },
      ]);
    });

    it('宽限期过后中止还没完成的回复，等它收尾再关闭', async () => {
      const never = new Promise<void>(() => {});
      const { sessions, storage, close, entries } = setup(
        replying({ text: '等不到', gate: never }),
      );
      const id = await newConversation(storage);
      const conversation = await sessions.open(id);
      await conversation.append({ author, text: '讲个故事' });
      const reading = readAll(conversation.reply());
      await sleep(20);

      const startedAt = Date.now();
      await close(50);

      expect(Date.now() - startedAt).toBeLessThan(1000);
      expect((await reading).map((chunk) => chunk.type)).toContain('abort');
      expect(sessions.replying).toBe(0);
      expect(entries.find((entry) => entry.msg === 'sessions.close')?.fields).toEqual({
        conversations: 1,
        aborted: 1,
        takenOver: 0,
        unfinished: 0,
      });
    });

    it('前端读了一段就不读、也不取消：按时结束，会话管理接手读完，中止的回复照规则写入历史', async () => {
      const { sessions, storage, close, entries } = setup(stalling());
      const id = await newConversation(storage);
      const heard: string[] = [];
      let ended = false;
      sessions.onReply(() => ({
        chunk: (chunk) => heard.push(chunk.type),
        end: () => (ended = true),
      }));
      const conversation = await sessions.open(id);
      await conversation.append({ author, text: '讲个故事' });
      const reader = conversation.reply().getReader();
      await reader.read();
      await sleep(20);

      const startedAt = Date.now();
      await close(30, 50);

      expect(Date.now() - startedAt).toBeLessThan(1000);
      expect(sessions.replying).toBe(0);
      expect(ended).toBe(true);
      expect(heard).toContain('abort');
      expect(entries.find((entry) => entry.msg === 'sessions.close')?.fields).toEqual({
        conversations: 1,
        aborted: 1,
        takenOver: 1,
        unfinished: 0,
      });
      expect(await historyOf(storage, id)).toEqual([
        { role: 'user', text: '讲个故事', aborted: undefined },
        { role: 'assistant', text: 'abcde', aborted: true },
      ]);
      // 前端之后再读，看到流结束，不会挂住
      let result = await reader.read();
      while (!result.done) result = await reader.read();
    });

    it('前端自己的中止信号照常起作用', async () => {
      const never = new Promise<void>(() => {});
      const { sessions, storage } = setup(replying({ text: '等不到', gate: never }));
      const id = await newConversation(storage);
      const conversation = await sessions.open(id);
      await conversation.append({ author, text: '讲个故事' });
      const controller = new AbortController();

      const reading = readAll(conversation.reply({ abortSignal: controller.signal }));
      await sleep(20);
      controller.abort();

      expect((await reading).map((chunk) => chunk.type)).toContain('abort');
    });

    it('关闭之后不再打开会话，也不再开始回复', async () => {
      const { sessions, storage, close } = setup(replying('好'));
      const id = await newConversation(storage);
      const conversation = await sessions.open(id);
      await close();

      await expect(sessions.open(id)).rejects.toThrow('洛璃服务正在退出');
      expect(() => conversation.reply()).toThrow('洛璃服务正在退出');
    });

    it('关闭各会话：进行中的摘要被中止，记 summary.aborted', async () => {
      const storage = createMemoryStorage();
      const id = await newConversation(storage);
      await (
        await storage.openConversation(id)
      ).add({
        id: 'old',
        role: 'user',
        metadata: { author, createdAt: new Date(Date.now() - 5 * 3_600_000).toISOString() },
        parts: [{ type: 'text', text: '很久以前' }],
      });
      const model = replying({ text: '摘要', gate: new Promise<void>(() => {}) });
      const { sessions, close, entries } = setup(model, { storage });

      // 打开时按现在的时间补做空闲切段：摘要请求挂起
      await sessions.open(id);
      const deadline = Date.now() + 2000;
      while (model.doStreamCalls.length === 0 && Date.now() < deadline) await sleep(5);
      await close(0);

      expect(entries.map((entry) => entry.msg)).toContain('summary.aborted');
    });
  });
});

describe('Telegram 前端从会话管理取会话', () => {
  const token = '123456:TEST-token_abc';
  const group: TelegramChat = { id: -1001, type: 'supergroup', title: '读书会' };
  const alice: TelegramUser = { id: 11, is_bot: false, first_name: 'Alice' };

  it('群里的回复经过会话管理：旁听者收到这次回复；会话对象就是会话管理里的那一个', async () => {
    const api = await startFakeTelegram();
    cleanups.push(() => api.close());
    const { sessions, storage } = setup(replying('你好呀'));
    const heard: Array<{ conversationId: string; text: string }> = [];
    sessions.onReply(({ conversationId }) => {
      const record = { conversationId, text: '' };
      heard.push(record);
      const watcher: ReplyWatcher = {
        chunk: (chunk) => {
          if (chunk.type === 'text-delta') record.text += chunk.delta;
        },
      };
      return watcher;
    });
    const { logger } = recordingLogger();
    const app = await startTelegram({
      config: {
        token,
        apiUrl: api.url,
        chats: new Set([String(group.id)]),
        users: new Set(),
        wakeWords: ['nori'],
        errorText: '（出了点问题）',
        staleMs: 60 * 60_000,
        rich: true,
      },
      open: (conversationId, options) => sessions.open(conversationId, options),
      storage,
      logger,
      pollTimeoutSeconds: 1,
      wait: { idleMs: 20, maxMs: 200 },
    });
    let stopped = false;
    cleanups.push(async () => {
      if (!stopped) await app.stop();
    });

    api.push({ chat: group, from: alice, text: 'nori 在吗' });
    await api.waitFor(() => api.delivered.length > 0);
    await app.bot.idle();

    const info = await storage.findConversation('telegram', String(group.id));
    expect(heard).toEqual([{ conversationId: info?.id, text: '你好呀' }]);
    // 群里看到的（富文本消息或普通消息）
    expect(api.delivered.map((message) => message.text)).toEqual(['你好呀']);
    // Telegram 前端退出时对会话对象调 close()，会话仍由会话管理关闭
    stopped = true;
    await app.stop();
    const conversation = await sessions.open(info!.id);
    await conversation.append({ author, text: '还在吗' });
    expect(textOf(await readAll(conversation.reply()))).toBe('（没有更多脚本）');
  });
});
