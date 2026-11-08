import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryFileStore, editMessage } from '../core/index.js';
import { testPrompts } from '../core/test-prompts.js';
import { createSessions } from './sessions.js';
import { testService } from './test-kit.js';
import type { ConversationRow, MessageEvent, ServerEvents, TodaySummary } from './types.js';

type StreamResult = Awaited<ReturnType<MockLanguageModelV4['doStream']>>;
type StreamPart = StreamResult['stream'] extends ReadableStream<infer P> ? P : never;

function replying(text: string): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async () => {
      const parts: StreamPart[] = [
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: text },
        { type: 'text-end', id: 't' },
        {
          type: 'finish',
          finishReason: { unified: 'stop', raw: undefined },
          usage: {
            inputTokens: { total: 10, noCache: 4, cacheRead: 6, cacheWrite: undefined },
            outputTokens: { total: 3, text: 3, reasoning: undefined },
          },
        },
      ];
      return { stream: simulateReadableStream({ chunks: parts }) };
    },
  });
}

type Received = {
  [K in keyof ServerEvents]: { event: K; data: ServerEvents[K] };
}[keyof ServerEvents];

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
  const fileStore = createMemoryFileStore();
  const service = await testService({ fileStore });
  const sessions = createSessions({
    model: replying('你好呀'),
    prompts: testPrompts('你是测试助手'),
    storage: service.observed,
    fileStore,
    logger: { info() {}, warn() {}, error() {} },
    maxRetries: 0,
  });
  cleanups.push(() => sessions.close(0));

  // 面板连着 SSE：把收到的事件按顺序记下来（hello 除外）
  const response = await service.request('/api/events');
  const reader = response.body!.getReader();
  cleanups.push(() => reader.cancel());
  const received: Received[] = [];
  let buffer = '';
  const decoder = new TextDecoder();
  void (async () => {
    for (let r = await reader.read(); !r.done; r = await reader.read()) {
      buffer += decoder.decode(r.value, { stream: true });
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop()!;
      for (const block of blocks) {
        const lines = block.split('\n');
        const event = lines.find((l) => l.startsWith('event: '))?.slice(7);
        const data = lines.find((l) => l.startsWith('data: '))?.slice(6);
        if (event && data && event !== 'hello')
          received.push({ event, data: JSON.parse(data) } as Received);
      }
    }
  })().catch(() => {});
  while (service.events.size === 0) await new Promise((resolve) => setTimeout(resolve, 5));

  /** 等到收到 count 个事件，返回并清空 */
  async function take(count: number): Promise<Received[]> {
    const deadline = Date.now() + 3000;
    await service.relay.settled();
    while (received.length < count) {
      if (Date.now() > deadline)
        throw new Error(`只收到 ${JSON.stringify(received.map((r) => r.event))}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    // 多出来的事件也一并返回，好让断言看到
    await new Promise((resolve) => setTimeout(resolve, 20));
    return received.splice(0);
  }
  return { ...service, sessions, take };
}

const row = (event: Received) => event.data as ConversationRow;

describe('写入转成 SSE 事件', () => {
  it('新会话、用户消息、回复、改名、编辑：面板依次收到对应的事件', async () => {
    const { observed, sessions, take } = await setup();

    // 新建会话：推这一行
    const id = await observed.createConversation({
      platform: 'telegram',
      platformConversationId: '-1001',
      title: '读书会',
    });
    const created = await take(1);
    expect(created.map((e) => e.event)).toEqual(['conversation']);
    expect(row(created[0]!)).toMatchObject({ id, title: '读书会', messages: 0, unread: 0 });

    // 用户消息：推这条消息，再推这一行（未读加一、预览）
    const conversation = await sessions.open(id);
    await conversation.append({
      author: { id: '11', name: 'Alice' },
      text: 'nori 在吗',
      platformMessageId: '100',
    });
    const appended = await take(2);
    expect(appended.map((e) => e.event)).toEqual(['message', 'conversation']);
    const userMessage = appended[0]!.data as MessageEvent;
    expect(userMessage).toMatchObject({
      conversationId: id,
      edited: false,
      message: { seq: 1, role: 'user', tools: {}, images: {} },
    });
    expect(userMessage.message.message.parts).toEqual([{ type: 'text', text: 'nori 在吗' }]);
    expect(row(appended[1]!)).toMatchObject({
      messages: 1,
      unread: 1,
      last: { seq: 1, author: 'Alice', text: 'nori 在吗' },
    });

    // 回复：助手的消息与这一行（洛璃的回复不算未读），模型调用写入后推今日概况
    for await (const _ of conversation.reply()) void _;
    const replied = await take(3);
    expect(replied.map((e) => e.event).sort()).toEqual(['conversation', 'message', 'today']);
    const assistant = replied.find((e) => e.event === 'message')!.data as MessageEvent;
    expect(assistant.message).toMatchObject({ seq: 2, role: 'assistant' });
    expect(
      assistant.message.message.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])),
    ).toEqual(['你好呀']);
    expect(row(replied.find((e) => e.event === 'conversation')!)).toMatchObject({
      messages: 2,
      unread: 1,
      last: { seq: 2, role: 'assistant', text: '你好呀' },
    });
    expect(replied.find((e) => e.event === 'today')!.data as TodaySummary).toMatchObject({
      replies: 1,
      inputTokens: 10,
      cacheReadTokens: 6,
      outputTokens: 3,
      conversations: [{ id, title: '读书会', replies: 1 }],
    });

    // 改名：推这一行
    await observed.updateTitle(id, '新群名');
    const renamed = await take(1);
    expect(renamed.map((e) => e.event)).toEqual(['conversation']);
    expect(row(renamed[0]!)).toMatchObject({ id, title: '新群名' });

    // 编辑（Telegram 前端经包过的存储改历史）：推编辑过的消息与这一行
    await editMessage(await observed.openConversation(id), {
      platformMessageId: '100',
      text: 'nori 还在吗',
      editedAt: '2026-11-08T01:00:00.000Z',
    });
    const edited = await take(2);
    expect(edited.map((e) => e.event)).toEqual(['message', 'conversation']);
    expect(edited[0]!.data as MessageEvent).toMatchObject({
      conversationId: id,
      edited: true,
      message: { seq: 1, message: { metadata: { editedAt: '2026-11-08T01:00:00.000Z' } } },
    });
  });

  it('没有面板连着时不做事；写入照常', async () => {
    const service = await testService();
    const id = await service.observed.createConversation({ platform: 'cli' });
    const store = await service.observed.openConversation(id);
    await store.add({
      id: 'x',
      role: 'user',
      metadata: { createdAt: '2026-11-08T00:00:00.000Z' },
      parts: [{ type: 'text', text: '一' }],
    });
    await service.relay.settled();

    expect(await (await service.storage.openConversation(id)).count()).toBe(1);
    expect(service.entries.filter((e) => e.level === 'error')).toEqual([]);
  });

  it('写入出错时不通知，错误照样抛出', async () => {
    const service = await testService();
    const id = await service.observed.createConversation({ platform: 'telegram' });
    await service.relay.settled();
    const store = await service.observed.openConversation(id);
    const message = {
      id: 'dup',
      role: 'user' as const,
      metadata: { createdAt: '2026-11-08T00:00:00.000Z', platformMessageId: '1' },
      parts: [{ type: 'text' as const, text: '一' }],
    };
    await store.add(message);

    await expect(store.add({ ...message, id: 'dup2' })).rejects.toThrow();
    await expect(service.observed.updateTitle('nope', 'x')).rejects.toThrow();
  });
});
