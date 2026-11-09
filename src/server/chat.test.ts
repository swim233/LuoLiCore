import { APICallError } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createMemoryStorage,
  defineTool,
  installTools,
  type Conversation,
  type Message,
} from '../core/index.js';
import { createChats, titleOf } from './chat.js';
import { pngBytes, recordingLogger, testService } from './test-kit.js';
import type {
  ApiMessage,
  ChatChunk,
  ConversationsResponse,
  ErrorResponse,
  LiveEvent,
  MessagesResponse,
  UploadResponse,
} from './types.js';

// ─── 模型 ───────────────────────────────────────────────────────────────

type StreamResult = Awaited<ReturnType<MockLanguageModelV4['doStream']>>;
type StreamPart = StreamResult['stream'] extends ReadableStream<infer P> ? P : never;
/** 模型输出的一段；pause 停一会儿，gate 等它放行（请求被中止时随之失败） */
type Item = StreamPart | { pause: number } | { gate: Promise<void> };

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 2, text: 2, reasoning: undefined },
};
const finish = (reason: 'stop' | 'tool-calls' = 'stop'): StreamPart => ({
  type: 'finish',
  finishReason: { unified: reason, raw: undefined },
  usage,
});
const text = (id: string, ...deltas: string[]): Item[] => [
  { type: 'text-start', id },
  ...deltas.map((delta): Item => ({ type: 'text-delta', id, delta })),
  { type: 'text-end', id },
];
const answer = (...deltas: string[]): Item[] => [...text('t', ...deltas), finish()];

function scripted(...steps: Array<Item[] | Error>): MockLanguageModelV4 {
  let index = 0;
  return new MockLanguageModelV4({
    doStream: async ({ abortSignal }) => {
      const step = steps[index++];
      if (step === undefined) throw new Error('mock 模型没有更多脚本');
      if (step instanceof Error) throw step;
      const items = [...step];
      return {
        stream: new ReadableStream<StreamPart>(
          {
            async pull(controller) {
              for (let item = items.shift(); item !== undefined; item = items.shift()) {
                if ('pause' in item) await sleep(item.pause);
                else if ('gate' in item) {
                  await new Promise<void>((resolve, reject) => {
                    void item.gate.then(resolve);
                    abortSignal?.addEventListener('abort', () => reject(abortSignal.reason), {
                      once: true,
                    });
                  });
                } else {
                  controller.enqueue(item);
                  return;
                }
              }
              controller.close();
            },
          },
          { highWaterMark: 0 },
        ),
      };
    },
  });
}

function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

function httpError(statusCode: number): APICallError {
  return new APICallError({
    message: `HTTP ${statusCode}`,
    url: 'http://mock.test/v1/chat/completions',
    requestBodyValues: {},
    statusCode,
    responseHeaders: { 'retry-after-ms': '0' },
    responseBody: '{}',
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(check: () => boolean, timeoutMs = 3000, what = '条件'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`等待${what}超时`);
    await sleep(5);
  }
}

/** 第 index 次模型请求里所有消息的内容 */
const promptOf = (model: MockLanguageModelV4, index: number) =>
  JSON.stringify(model.doStreamCalls[index]?.prompt ?? []);

// ─── 服务 ───────────────────────────────────────────────────────────────

const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(
  model: MockLanguageModelV4,
  options: Omit<NonNullable<Parameters<typeof testService>[0]>, 'model'> = {},
) {
  const service = await testService({ model, ...options });
  cleanups.push(() => service.sessions!.close(0, 300));
  const post = (path: string, body: unknown, init: RequestInit = {}) =>
    service.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...init,
    });
  /** 发一条消息（或重试），回复的流在后台一直读 */
  async function chat(body: unknown, init: RequestInit = {}) {
    const response = await post('/api/chat', body, init);
    return { response, ...stream(response) };
  }
  /** 上传一张图片 */
  async function upload(data: Uint8Array, mediaType = 'image/png') {
    const response = await service.request('/api/files', {
      method: 'POST',
      headers: { 'content-type': mediaType },
      body: data,
    });
    return (await response.json()) as UploadResponse;
  }
  async function history(conversationId: string): Promise<ApiMessage[]> {
    const response = await service.request(`/api/conversations/${conversationId}/messages`);
    return ((await response.json()) as MessagesResponse).messages;
  }
  return { ...service, post, chat, upload, history };
}

/** 一个回复的流：后台一直读，段按顺序记下 */
function stream(response: Response) {
  const reader = response.body!.getReader();
  cleanups.push(() => reader.cancel().catch(() => {}));
  const chunks: ChatChunk[] = [];
  let ended = false;
  let buffer = '';
  const decoder = new TextDecoder();
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (let at = buffer.indexOf('\n\n'); at >= 0; at = buffer.indexOf('\n\n')) {
          const line = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          const data = line.startsWith('data: ') ? line.slice(6) : '';
          if (data && data !== '[DONE]') chunks.push(JSON.parse(data) as ChatChunk);
        }
      }
    } catch {
      // 取消
    } finally {
      ended = true;
    }
  })();
  return {
    chunks,
    reader,
    get ended() {
      return ended;
    },
    types: () => chunks.map((chunk) => chunk.type),
    text: () =>
      chunks.flatMap((chunk) => (chunk.type === 'text-delta' ? [chunk.delta] : [])).join(''),
    async until(check: (chunks: ChatChunk[]) => boolean, timeoutMs = 3000) {
      await waitUntil(() => check(chunks), timeoutMs, '回复的段');
    },
    async end(timeoutMs = 3000) {
      await waitUntil(() => ended, timeoutMs, '流结束');
    },
  };
}

const conversationOf = (chunks: ChatChunk[]) => {
  const first = chunks[0];
  return first?.type === 'data-conversation' ? first.data : undefined;
};

const textOf = (message: Message | undefined) =>
  (message?.parts ?? []).flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('');

// ─── 测试 ───────────────────────────────────────────────────────────────

describe('网页会话：发消息', () => {
  it('新会话：建会话、记标题，返回回复的流；历史里有用户消息与回复，列表里是网页会话、带标题', async () => {
    const model = scripted(answer('你好', '呀'));
    const { chat, history, request, chats } = await setup(model, { author: '小明' });

    const sent = await chat({ text: '今天的天气怎么样？适合出门吗？我想去公园' });
    await sent.end();

    expect(sent.response.status).toBe(200);
    const id = sent.response.headers.get('x-conversation-id')!;
    expect(conversationOf(sent.chunks)).toEqual({
      conversationId: id,
      seq: 1,
      title: '今天的天气怎么样？适合出门吗？我…',
    });
    expect(sent.types().slice(1)).toEqual(
      expect.arrayContaining(['start', 'text-delta', 'finish']),
    );
    expect(sent.text()).toBe('你好呀');
    const messages = await history(id);
    expect(messages.map((m) => [m.role, textOf(m.message)])).toEqual([
      ['user', '今天的天气怎么样？适合出门吗？我想去公园'],
      ['assistant', '你好呀'],
    ]);
    expect(messages[0]!.message.metadata?.author).toEqual({ name: '小明' });
    // 回复 id 就是写进历史的那条
    expect(sent.chunks.find((chunk) => chunk.type === 'start')).toMatchObject({
      messageId: messages[1]!.id,
    });
    const list = (await (await request('/api/conversations')).json()) as ConversationsResponse;
    expect(list.conversations).toEqual([
      expect.objectContaining({ id, kind: 'web', title: '今天的天气怎么样？适合出门吗？我…' }),
    ]);
    expect(chats!.busy(id)).toBe(false);
    // 标题只给面板：prompt 里没有「当前会话」一节
    expect(promptOf(model, 0)).not.toContain('今天的天气怎么样？适合出门吗？我…');
  });

  it('只发图片：标题叫「图片」；图片作为文件段交给模型，消息里是上传得到的地址', async () => {
    const model = scripted(answer('收到图片'));
    const { chat, upload, history } = await setup(model);
    const image = await upload(pngBytes(8, 6, 'only'));

    const sent = await chat({ files: [image.url] });
    await sent.end();

    expect(conversationOf(sent.chunks)?.title).toBe('图片');
    const [user] = await history(sent.response.headers.get('x-conversation-id')!);
    expect(user!.message.parts).toEqual([{ type: 'file', mediaType: 'image/png', url: image.url }]);
    expect(user!.images[image.url]).toEqual({ src: image.src, width: 8, height: 6 });
    const files = model.doStreamCalls[0]!.prompt.flatMap((message) =>
      Array.isArray(message.content) ? message.content.filter((part) => part.type === 'file') : [],
    );
    expect(files).toHaveLength(1);
  });

  it('接着发：同一个会话，第二次回复看到前面的对话', async () => {
    const model = scripted(answer('一'), answer('二'));
    const { chat, history } = await setup(model);
    const first = await chat({ text: '第一句' });
    await first.end();
    const id = first.response.headers.get('x-conversation-id')!;

    const second = await chat({ conversationId: id, text: '第二句' });
    await second.end();

    expect(conversationOf(second.chunks)).toEqual({ conversationId: id, seq: 3 });
    expect((await history(id)).map((m) => textOf(m.message))).toEqual([
      '第一句',
      '一',
      '第二句',
      '二',
    ]);
    expect(promptOf(model, 1)).toContain('第一句');
  });

  it('不收的请求：会话不存在 404，Telegram 的会话 400，空消息 400，图片不在 400，图片多于 10 张 400', async () => {
    const storage = createMemoryStorage();
    const group = await storage.createConversation({
      platform: 'telegram',
      platformConversationId: '-1001',
      title: '读书会',
    });
    const { post, upload } = await setup(scripted(), { storage });
    const image = await upload(pngBytes(2, 2, 'x'));
    const missing = `luoli-file:${'0'.repeat(64)}.png`;
    const errorOf = async (body: unknown) => {
      const response = await post('/api/chat', body);
      return [response.status, ((await response.json()) as ErrorResponse).error];
    };

    expect(await errorOf({ conversationId: 'nope', text: '在吗' })).toEqual([404, '没有这个会话']);
    expect(await errorOf({ conversationId: group, text: '在吗' })).toEqual([
      400,
      '只能在网页会话里对话',
    ]);
    expect(await errorOf({ text: '   ' })).toEqual([400, '消息是空的：要有文字或图片']);
    expect(await errorOf({ text: '看图', files: [image.url, missing] })).toEqual([
      400,
      '第 2 张图片不在文件存储里，先上传',
    ]);
    const [status] = await errorOf({ files: Array.from({ length: 11 }, () => image.url) });
    expect(status).toBe(400);
    const [bad] = await errorOf({ text: '在吗', files: ['https://example.com/a.png'] });
    expect(bad).toBe(400);
  });

  it('分块传输的请求体（没有 Content-Length）照收；超过 1 MB 的 413', async () => {
    const { request, history } = await setup(scripted(answer('收到')));
    const send = (text: string) => {
      const bytes = new TextEncoder().encode(JSON.stringify({ text }));
      return request('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            for (let at = 0; at < bytes.length; at += 5)
              controller.enqueue(bytes.slice(at, at + 5));
            controller.close();
          },
        }),
        duplex: 'half',
      } as RequestInit);
    };
    const response = await send('分块发来的一句话');
    expect(response.status).toBe(200);
    await response.text();
    const id = response.headers.get('x-conversation-id')!;
    expect((await history(id)).map((m) => textOf(m.message))).toEqual(['分块发来的一句话', '收到']);
    expect((await send('长'.repeat(400_000))).status).toBe(413);
  });

  it('客户端断开即中止：半截回复写进历史，标记中止', async () => {
    const hold = gate();
    const model = scripted([
      ...text('t', '说到一半'),
      { gate: hold.promise },
      ...text('u', '不该出现'),
      finish(),
    ]);
    const { chat, history, chats } = await setup(model);

    const sent = await chat({ text: '讲个故事' });
    await sent.until((chunks) => chunks.some((chunk) => chunk.type === 'text-end'));
    const id = sent.response.headers.get('x-conversation-id')!;
    await sent.reader.cancel();
    await waitUntil(() => !chats!.busy(id), 3000, '回复结束');

    const messages = await history(id);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(textOf(messages[1]!.message)).toBe('说到一半');
    expect(messages[1]!.message.metadata?.aborted).toBe(true);
    hold.open();
  });

  it('请求的中止信号（如页面关闭）也算断开', async () => {
    const hold = gate();
    const model = scripted([...text('t', '半句'), { gate: hold.promise }, finish()]);
    const { chat, history, chats } = await setup(model);
    const controller = new AbortController();

    const sent = await chat({ text: '在吗' }, { signal: controller.signal });
    await sent.until((chunks) => chunks.some((chunk) => chunk.type === 'text-end'));
    const id = sent.response.headers.get('x-conversation-id')!;
    controller.abort();
    await waitUntil(() => !chats!.busy(id), 3000, '回复结束');

    expect((await history(id)).at(-1)?.message.metadata?.aborted).toBe(true);
    hold.open();
  });

  it('两个会话同时生成，互不影响', async () => {
    const holdA = gate();
    const holdB = gate();
    const model = scripted(
      [...text('t', '甲的'), { gate: holdA.promise }, ...text('u', '回复'), finish()],
      [...text('t', '乙的'), { gate: holdB.promise }, ...text('u', '回复'), finish()],
    );
    const { chat, live } = await setup(model);

    const a = await chat({ text: '甲' });
    await a.until((chunks) => chunks.some((chunk) => chunk.type === 'text-end'));
    const b = await chat({ text: '乙' });
    await b.until((chunks) => chunks.some((chunk) => chunk.type === 'text-end'));
    expect(live.snapshot().replies).toHaveLength(2);

    holdB.open();
    await b.end();
    expect(a.ended).toBe(false);
    holdA.open();
    await a.end();
    expect([a.text(), b.text()]).toEqual(['甲的回复', '乙的回复']);
  });
});

describe('网页会话：生成中再发', () => {
  it('排队：消息马上写进历史；只补一次回复，看到期间所有新消息，流交给最后一个请求', async () => {
    const hold = gate();
    const model = scripted(
      [...text('t', '第一次'), { gate: hold.promise }, finish()],
      answer('补的回复'),
    );
    const { chat, history, live } = await setup(model);
    const lives: LiveEvent[] = [];
    const first = await chat({ text: '第一句' });
    await first.until((chunks) => chunks.some((chunk) => chunk.type === 'text-end'));
    const id = first.response.headers.get('x-conversation-id')!;

    const second = await chat({ conversationId: id, text: '补充一' });
    await second.until((chunks) => chunks.some((chunk) => chunk.type === 'data-queued'));
    expect(second.chunks.slice(0, 2)).toEqual([
      { type: 'data-conversation', data: { conversationId: id, seq: 3 }, transient: true },
      { type: 'data-queued', data: { fromSeq: 3 }, transient: true },
    ]);
    expect(live.snapshot().replies).toEqual([
      expect.objectContaining({ conversationId: id, again: true, queuedFrom: 3 }),
    ]);
    const third = await chat({ conversationId: id, text: '补充二' });
    await third.until((chunks) => chunks.some((chunk) => chunk.type === 'data-queued'));
    // 前一个排队的请求不带回复，正常结束；排队的起点不变
    await second.end();
    expect(second.types()).toEqual(['data-conversation', 'data-queued']);
    expect(third.chunks[1]).toEqual({ type: 'data-queued', data: { fromSeq: 3 }, transient: true });
    expect((await history(id)).map((m) => textOf(m.message))).toEqual([
      '第一句',
      '补充一',
      '补充二',
    ]);

    hold.open();
    await first.end();
    await third.end();
    expect(first.text()).toBe('第一次');
    expect(third.text()).toBe('补的回复');
    expect(model.doStreamCalls).toHaveLength(2);
    expect(promptOf(model, 1)).toContain('补充一');
    expect(promptOf(model, 1)).toContain('补充二');
    expect((await history(id)).map((m) => [m.role, textOf(m.message)])).toEqual([
      ['user', '第一句'],
      ['assistant', '第一次'],
      ['user', '补充一'],
      ['user', '补充二'],
      ['assistant', '补的回复'],
    ]);
    expect(live.snapshot().replies).toEqual([]);
    void lives;
  });

  it('当前回复出错，照样补一次', async () => {
    const hold = gate();
    const model = scripted(
      [{ gate: hold.promise }, { type: 'error', error: { message: '服务端过载' } }],
      answer('补上了'),
    );
    const { chat } = await setup(model);
    const first = await chat({ text: '第一句' });
    const id = first.response.headers.get('x-conversation-id')!;
    await waitUntil(() => model.doStreamCalls.length === 1);

    const second = await chat({ conversationId: id, text: '第二句' });
    await second.until((chunks) => chunks.some((chunk) => chunk.type === 'data-queued'));
    hold.open();
    await first.end();
    await second.end();

    expect(first.types()).toContain('error');
    expect(second.text()).toBe('补上了');
    expect(promptOf(model, 1)).toContain('第二句');
  });

  it('中止（POST abort）：中止当前回复，同时取消补回复；排队的消息留在历史里', async () => {
    const hold = gate();
    const model = scripted([...text('t', '说到'), { gate: hold.promise }, finish()]);
    const { chat, post, history, chats, live } = await setup(model);
    const first = await chat({ text: '第一句' });
    await first.until((chunks) => chunks.some((chunk) => chunk.type === 'text-end'));
    const id = first.response.headers.get('x-conversation-id')!;
    const second = await chat({ conversationId: id, text: '第二句' });
    await second.until((chunks) => chunks.some((chunk) => chunk.type === 'data-queued'));

    const aborted = await post(`/api/chat/${id}/abort`, {});
    expect(await aborted.json()).toEqual({ aborted: true });
    await first.end();
    await second.end();
    await waitUntil(() => !chats!.busy(id));

    expect(first.types()).toContain('abort');
    expect(second.types()).toEqual(['data-conversation', 'data-queued']);
    expect(model.doStreamCalls).toHaveLength(1);
    expect((await history(id)).map((m) => [m.role, textOf(m.message)])).toEqual([
      ['user', '第一句'],
      ['assistant', '说到'],
      ['user', '第二句'],
    ]);
    expect(live.snapshot().replies).toEqual([]);
    // 没有在回复的会话：没什么可中止
    expect(await (await post(`/api/chat/${id}/abort`, {})).json()).toEqual({ aborted: false });
    hold.open();
  });

  it('排队的请求断开：取消它的补回复，当前回复照常；「此刻」里推 dequeue', async () => {
    const hold = gate();
    const model = scripted([...text('t', '照常'), { gate: hold.promise }, finish()]);
    const { chat, chats, live, post } = await setup(model);
    const first = await chat({ text: '第一句' });
    await first.until((chunks) => chunks.some((chunk) => chunk.type === 'text-end'));
    const id = first.response.headers.get('x-conversation-id')!;
    const second = await chat({ conversationId: id, text: '第二句' });
    await second.until((chunks) => chunks.some((chunk) => chunk.type === 'data-queued'));

    await second.reader.cancel();
    await waitUntil(() => live.snapshot().replies[0]?.queuedFrom === undefined);
    expect(live.snapshot().replies).toEqual([expect.objectContaining({ again: false })]);
    hold.open();
    await first.end();
    await waitUntil(() => !chats!.busy(id));

    expect(first.text()).toBe('照常');
    expect(first.types()).toContain('finish');
    expect(model.doStreamCalls).toHaveLength(1);
    // 最后一条是没等到回复的排队消息，但不是出错留下的：不能重试
    expect((await post('/api/chat', { conversationId: id, retry: true })).status).toBe(409);
  });
});

describe('网页会话：重试', () => {
  it('上一次出错（一步都没完成，没写进历史）：重试对着同样的历史再回复一次', async () => {
    const model = scripted(httpError(401), answer('这次好了'));
    const { chat, history } = await setup(model);
    const first = await chat({ text: '在吗' });
    await first.end();
    const id = first.response.headers.get('x-conversation-id')!;
    expect(first.types()).toContain('error');

    const retried = await chat({ conversationId: id, retry: true });
    await retried.end();

    expect(retried.chunks[0]).toEqual({
      type: 'data-conversation',
      data: { conversationId: id },
      transient: true,
    });
    expect(retried.text()).toBe('这次好了');
    expect((await history(id)).map((m) => [m.role, textOf(m.message)])).toEqual([
      ['user', '在吗'],
      ['assistant', '这次好了'],
    ]);
    expect(promptOf(model, 1)).toBe(promptOf(model, 0));
  });

  it('最后一条是出错的回复（写进了历史）时可以重试', async () => {
    const tools = installTools(
      [defineTool({ name: 'noop', description: '无', input: z.object({}), execute: () => 'ok' })],
      {},
    ).tools;
    const model = scripted(
      [
        { type: 'tool-call', toolCallId: 'c1', toolName: 'noop', input: '{}' },
        finish('tool-calls'),
      ],
      [{ type: 'error', error: { message: '服务端过载' } }],
      answer('好了'),
    );
    const { chat, history } = await setup(model, { tools });
    const first = await chat({ text: '在吗' });
    await first.end();
    const id = first.response.headers.get('x-conversation-id')!;
    expect((await history(id)).at(-1)?.message.metadata?.failed).toBe(true);

    const retried = await chat({ conversationId: id, retry: true });
    await retried.end();
    expect(retried.text()).toBe('好了');
  });

  it('不能重试：最后一条是正常完成或中止的回复；正在生成；会话不存在', async () => {
    const hold = gate();
    const model = scripted(answer('好的'), [
      ...text('t', '说到'),
      { gate: hold.promise },
      finish(),
    ]);
    const { chat, post } = await setup(model);
    const errorOf = async (body: unknown) => {
      const response = await post('/api/chat', body);
      return [response.status, ((await response.json()) as ErrorResponse).error];
    };
    const done = await chat({ text: '一' });
    await done.end();
    const id = done.response.headers.get('x-conversation-id')!;

    expect(await errorOf({ conversationId: id, retry: true })).toEqual([
      409,
      '最后一条不是出错的回复，不用重试',
    ]);
    const running = await chat({ conversationId: id, text: '二' });
    await running.until((chunks) => chunks.some((chunk) => chunk.type === 'text-end'));
    expect(await errorOf({ conversationId: id, retry: true })).toEqual([
      409,
      '正在回复，等它结束再重试',
    ]);
    await post(`/api/chat/${id}/abort`, {});
    await running.end();
    expect(await errorOf({ conversationId: id, retry: true })).toEqual([
      409,
      '最后一条不是出错的回复，不用重试',
    ]);
    expect((await errorOf({ conversationId: 'nope', retry: true }))[0]).toBe(404);
    hold.open();
  });

  it('不能重试：最后一条是没有回复的用户消息，但不是出错留下的（中止时取消了补回复、一个字没说就被中止）', async () => {
    const hold = gate();
    const silent = gate();
    const model = scripted(
      [...text('t', '说到'), { gate: hold.promise }, finish()],
      [{ gate: silent.promise }, ...text('t', '不会说出来'), finish()],
    );
    const { chat, post, history, chats } = await setup(model);
    const refusal = async (id: string) => {
      const response = await post('/api/chat', { conversationId: id, retry: true });
      return [response.status, ((await response.json()) as ErrorResponse).error];
    };

    // 中止时取消了补回复：排队的消息留在最后
    const first = await chat({ text: '第一句' });
    await first.until((chunks) => chunks.some((chunk) => chunk.type === 'text-end'));
    const id = first.response.headers.get('x-conversation-id')!;
    const queued = await chat({ conversationId: id, text: '第二句' });
    await queued.until((chunks) => chunks.some((chunk) => chunk.type === 'data-queued'));
    await post(`/api/chat/${id}/abort`, {});
    await first.end();
    await queued.end();
    await waitUntil(() => !chats!.busy(id));
    expect((await history(id)).at(-1)?.role).toBe('user');
    expect(await refusal(id)).toEqual([409, '最后一条不是出错的回复，不用重试']);

    // 一个字没说就被中止：回复没写进历史，最后一条还是用户消息
    const quiet = await chat({ conversationId: id, text: '第三句' });
    await waitUntil(() => model.doStreamCalls.length === 2);
    await post(`/api/chat/${id}/abort`, {});
    await quiet.end();
    await waitUntil(() => !chats!.busy(id));
    expect(quiet.types()).toContain('abort');
    expect((await history(id)).map((m) => textOf(m.message))).toEqual([
      '第一句',
      '说到',
      '第二句',
      '第三句',
    ]);
    expect(await refusal(id)).toEqual([409, '最后一条不是出错的回复，不用重试']);
    hold.open();
    silent.open();
  });

  it('当前回复出错，但排队的请求先断开了：留下的是没等到回复的消息，断开算中止，不能重试', async () => {
    const tools = installTools(
      [defineTool({ name: 'noop', description: '无', input: z.object({}), execute: () => 'ok' })],
      {},
    ).tools;
    for (const savedStep of [false, true]) {
      const hold = gate();
      // 第一步完成（调了工具）时出错的回复会写进历史，标记 failed；否则一步都没写
      const failing: Item[][] = savedStep
        ? [
            [
              { type: 'tool-call', toolCallId: 'c1', toolName: 'noop', input: '{}' },
              finish('tool-calls'),
            ],
            [{ gate: hold.promise }, { type: 'error', error: { message: '服务端过载' } }],
          ]
        : [
            [
              ...text('t', '说到'),
              { gate: hold.promise },
              { type: 'error', error: { message: '服务端过载' } },
            ],
          ];
      const model = scripted(...failing);
      const { chat, post, history, chats } = await setup(model, { tools });
      const first = await chat({ text: '第一句' });
      await waitUntil(() => model.doStreamCalls.length === failing.length);
      const id = first.response.headers.get('x-conversation-id')!;
      const queued = await chat({ conversationId: id, text: '第二句' });
      await queued.until((chunks) => chunks.some((chunk) => chunk.type === 'data-queued'));
      await queued.reader.cancel();
      await waitUntil(() => chats!.busy(id) && first.types().length > 0);
      hold.open();
      await first.end();
      await waitUntil(() => !chats!.busy(id));

      expect(first.types()).toContain('error');
      const saved = await history(id);
      expect(saved.at(-1)).toMatchObject({ role: 'user' });
      expect(textOf(saved.at(-1)!.message)).toBe('第二句');
      expect(saved.some((m) => m.message.metadata?.failed === true)).toBe(savedStep);
      const response = await post('/api/chat', { conversationId: id, retry: true });
      expect([response.status, ((await response.json()) as ErrorResponse).error]).toEqual([
        409,
        '最后一条不是出错的回复，不用重试',
      ]);
      expect(model.doStreamCalls).toHaveLength(failing.length);
    }
  });

  it('出错没写进历史之后又发了新消息并且回复了：之前的出错不再算', async () => {
    const model = scripted(httpError(401), answer('好的'), answer('不该有这次'));
    const { chat, post } = await setup(model);
    const first = await chat({ text: '在吗' });
    await first.end();
    const id = first.response.headers.get('x-conversation-id')!;
    const second = await chat({ conversationId: id, text: '再问一次' });
    await second.end();
    expect(second.text()).toBe('好的');
    expect((await post('/api/chat', { conversationId: id, retry: true })).status).toBe(409);
    expect(model.doStreamCalls).toHaveLength(2);
  });
});

describe('网页会话：补回复开始不了', () => {
  it('reply() 抛错：排队的请求以出错结束，会话不卡在「在回复」，之后照常回复', async () => {
    const hold = gate();
    const model = scripted(
      [...text('t', '说到'), { gate: hold.promise }, finish()],
      answer('好了'),
    );
    const service = await testService({ model });
    cleanups.push(() => service.sessions!.close(0, 300));
    // 第二次开始回复（补回复）时抛错，像核心那边上一个回复还没收尾
    let replies = 0;
    const chats = createChats({
      sessions: {
        open: async (conversationId) => {
          const conversation = await service.sessions!.open(conversationId);
          return {
            ...conversation,
            reply: (options) => {
              if (++replies === 2) throw new Error('上一个回复还没收尾');
              return conversation.reply(options);
            },
          } satisfies Conversation;
        },
      },
      storage: service.observed,
      fileStore: service.fileStore,
      webState: service.webState,
      live: service.live,
      author: 'Alice',
      logger: recordingLogger().logger,
      notify: service.relay.onChange,
    });
    const readAll = async (stream: ReadableStream<ChatChunk>) => {
      const chunks: ChatChunk[] = [];
      for await (const chunk of stream) chunks.push(chunk);
      return chunks;
    };

    const first = await chats.send({ text: '第一句' });
    if (!first.ok) throw new Error(first.error);
    const id = first.conversationId;
    const firstChunks = readAll(first.stream);
    await waitUntil(() => model.doStreamCalls.length === 1);
    const second = await chats.send({ conversationId: id, text: '第二句' });
    if (!second.ok) throw new Error(second.error);
    const secondChunks = readAll(second.stream);
    await waitUntil(() => service.live.snapshot().replies[0]?.queuedFrom !== undefined);
    hold.open();

    expect((await firstChunks).map((chunk) => chunk.type)).toContain('finish');
    expect((await secondChunks).map((chunk) => chunk.type)).toEqual([
      'data-conversation',
      'data-queued',
      'error',
    ]);
    await waitUntil(() => !chats.busy(id));
    expect(service.live.snapshot().replies).toEqual([]);

    // 之后发的消息照常开始回复，不再只是排队
    const third = await chats.send({ conversationId: id, text: '第三句' });
    if (!third.ok) throw new Error(third.error);
    const thirdChunks = await readAll(third.stream);
    expect(thirdChunks.map((chunk) => chunk.type)).not.toContain('data-queued');
    expect(thirdChunks).toContainEqual(
      expect.objectContaining({ type: 'text-delta', delta: '好了' }),
    );
  });
});

describe('网页会话：退出', () => {
  it('退出时进行中的回复以中止结束：流里有 abort 段，正常结束；半截写进历史', async () => {
    const hold = gate();
    const model = scripted([...text('t', '说到一半'), { gate: hold.promise }, finish()]);
    const { chat, sessions, chats, history } = await setup(model);
    const sent = await chat({ text: '讲个故事' });
    await sent.until((chunks) => chunks.some((chunk) => chunk.type === 'text-end'));
    const id = sent.response.headers.get('x-conversation-id')!;

    chats!.close();
    await sessions!.close(0, 500);
    await chats!.settled();
    await sent.end();

    expect(sent.types().at(-1)).toBe('abort');
    expect((await history(id)).at(-1)?.message.metadata?.aborted).toBe(true);
    // 退出之后不再接消息
    const late = await chat({ conversationId: id, text: '还在吗' });
    expect(late.response.status).toBe(503);
    hold.open();
  });

  it('退出时排队的请求正常结束，不再补回复', async () => {
    const hold = gate();
    const model = scripted([...text('t', '第一次'), { gate: hold.promise }, finish()]);
    const { chat, sessions, chats } = await setup(model);
    const first = await chat({ text: '第一句' });
    await first.until((chunks) => chunks.some((chunk) => chunk.type === 'text-end'));
    const id = first.response.headers.get('x-conversation-id')!;
    const second = await chat({ conversationId: id, text: '第二句' });
    await second.until((chunks) => chunks.some((chunk) => chunk.type === 'data-queued'));

    chats!.close();
    await second.end();
    expect(second.types()).toEqual(['data-conversation', 'data-queued']);
    await sessions!.close(0, 500);
    await first.end();
    expect(model.doStreamCalls).toHaveLength(1);
    hold.open();
  });
});

describe('网页会话的标题', () => {
  it('前 16 个字，超出加「…」；空白合成一个空格；只有图片时为「图片」', () => {
    expect(titleOf('你好', 0)).toBe('你好');
    expect(titleOf('一二三四五六七八九十一二三四五六', 0)).toBe('一二三四五六七八九十一二三四五六');
    expect(titleOf('一二三四五六七八九十一二三四五六七', 0)).toBe(
      '一二三四五六七八九十一二三四五六…',
    );
    expect(titleOf('  早上\n\n好  ', 1)).toBe('早上 好');
    expect(titleOf(undefined, 2)).toBe('图片');
    expect(titleOf('😀'.repeat(20), 0)).toBe(`${'😀'.repeat(16)}…`);
  });
});
