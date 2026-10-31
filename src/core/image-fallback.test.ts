import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APICallError, simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createConversation,
  createMemoryFileStore,
  createMemoryStore,
  editMessage,
  openFileStore,
  openSqliteStorage,
  type Conversation,
  type ConversationStore,
  type FileStore,
  type Logger,
  type MessageChunk,
} from './index.js';
import { withUnreadable } from './image-fallback.js';

type StreamResult = Awaited<ReturnType<MockLanguageModelV4['doStream']>>;
type StreamPart = StreamResult['stream'] extends ReadableStream<infer P> ? P : never;
type Prompt = MockLanguageModelV4['doStreamCalls'][number]['prompt'];

const alice = { id: 'u-alice', name: 'Alice' };
const png = (...rest: number[]) => ({
  data: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...rest]),
  mediaType: 'image/png',
});
// 文件头完好、后面是乱码的图片：能通过文件头检查，模型服务会拒收
const broken = png(0xde, 0xad);
const fine = png(1, 2, 3);
const base64 = (data: Uint8Array) => Buffer.from(data).toString('base64');

const opened: Conversation[] = [];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const conversation of opened.splice(0)) await conversation.close();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function httpError(statusCode: number): APICallError {
  return new APICallError({
    message: `HTTP ${statusCode}`,
    url: 'http://mock.test/v1/chat/completions',
    requestBodyValues: {},
    statusCode,
    responseHeaders: { 'retry-after-ms': '0' },
    responseBody: `{"error":{"message":"status ${statusCode}"}}`,
  });
}

function textParts(text: string): StreamPart[] {
  return [
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
}

/** 请求里所有图片的数据（base64） */
function imagesIn(prompt: Prompt): string[] {
  return prompt.flatMap((message) =>
    Array.isArray(message.content)
      ? message.content.flatMap((part) =>
          part.type === 'file' && part.data.type === 'data' ? [String(part.data.data)] : [],
        )
      : [],
  );
}

/**
 * 模型：请求里有 rejected 这张图时以 status 拒收（status 为函数时按第几次请求给），
 * 否则依次给出 replies（用完后回复「好」）
 */
function rejecting({
  rejected = broken.data,
  status = 400,
  replies = [],
}: {
  rejected?: Uint8Array;
  status?: number | ((call: number) => number | undefined);
  replies?: Array<string | StreamPart[]>;
} = {}) {
  let call = 0;
  let reply = 0;
  return new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      const index = call++;
      const code = typeof status === 'function' ? status(index) : status;
      if (code !== undefined && imagesIn(prompt).includes(base64(rejected))) {
        throw httpError(code);
      }
      const next = replies[reply++] ?? '好';
      const chunks = typeof next === 'string' ? textParts(next) : next;
      return { stream: simulateReadableStream({ chunks }) };
    },
  });
}

/** 模型第 call 次请求里除 system 外的消息 */
function messagesOf(model: MockLanguageModelV4, call: number) {
  return (model.doStreamCalls[call]?.prompt ?? []).filter((m) => m.role !== 'system');
}

/** 请求里用户消息的内容，图片写成「<图片 前 8 位>」，便于看位置 */
function shapeOf(model: MockLanguageModelV4, call: number): string[] {
  return messagesOf(model, call).map((message) =>
    Array.isArray(message.content)
      ? message.content
          .map((part) =>
            part.type === 'text'
              ? part.text
              : part.type === 'file' && part.data.type === 'data'
                ? `<图片 ${String(part.data.data) === base64(broken.data) ? 'broken' : 'fine'}>`
                : `<${part.type}>`,
          )
          .join('|')
      : String(message.content),
  );
}

async function readAll(stream: ReadableStream<MessageChunk>): Promise<MessageChunk[]> {
  const chunks: MessageChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

type LogEntry = { level: string; msg: string; fields: Record<string, unknown> };

function setup({
  model,
  store = createMemoryStore(),
  fileStore = createMemoryFileStore(),
  maxRetries = 2,
  timeouts,
  segments,
}: {
  model: MockLanguageModelV4;
  store?: ConversationStore;
  fileStore?: FileStore;
  maxRetries?: number;
  timeouts?: { firstChunkMs?: number; chunkMs?: number };
  segments?: Parameters<typeof createConversation>[0]['segments'];
}) {
  const entries: LogEntry[] = [];
  const record = (level: string) => (fields: object, msg: string) =>
    entries.push({ level, msg, fields: fields as Record<string, unknown> });
  const logger: Logger = { info: record('info'), warn: record('warn'), error: record('error') };
  const conversation = createConversation({
    model,
    instructions: '你是测试助手',
    store,
    fileStore,
    logger,
    maxRetries,
    timeouts,
    segments,
  });
  opened.push(conversation);
  return { conversation, store, fileStore, entries };
}

const errorsOf = (chunks: MessageChunk[]) => chunks.filter((chunk) => chunk.type === 'error');
const textOf = (chunks: MessageChunk[]) =>
  chunks.flatMap((chunk) => (chunk.type === 'text-delta' ? [chunk.delta] : [])).join('');

describe('模型拒收图片时恢复', () => {
  it('还没输出就被 400 拒收：可疑图片换成占位重试一次，流里只有重试的输出；标记写进消息，之后的请求逐字沿用', async () => {
    const model = rejecting({ replies: ['看不清这张图', '记得'] });
    const { conversation, store, fileStore, entries } = setup({ model });
    const message = await conversation.append({ author: alice, text: '看图', files: [broken] });
    const url = await fileStore.save(broken);

    const chunks = await readAll(conversation.reply());

    expect(errorsOf(chunks)).toEqual([]);
    expect(chunks.filter((chunk) => chunk.type === 'data-retry')).toEqual([]);
    expect(chunks.filter((chunk) => chunk.type === 'start')).toHaveLength(1);
    expect(textOf(chunks)).toBe('看不清这张图');
    expect(model.doStreamCalls).toHaveLength(2);
    expect(shapeOf(model, 0)[0]).toContain('<图片 broken>');
    expect(shapeOf(model, 1)[0]).toMatch(/看图\|\[图片无法读取\]\|<\/message>$/);

    const [user, reply] = await store.list();
    expect(reply?.parts).toContainEqual(expect.objectContaining({ text: '看不清这张图' }));
    expect(user?.parts).toEqual(message.parts);
    expect(user?.metadata).toEqual({ ...message.metadata, unreadableFiles: [url] });

    // 之后的请求：那个位置是占位，前缀与恢复那次的请求逐字一致
    await conversation.append({ author: alice, text: '还记得吗' });
    await readAll(conversation.reply());
    expect(model.doStreamCalls).toHaveLength(3);
    expect(messagesOf(model, 2).slice(0, 1)).toEqual(messagesOf(model, 1));
    expect(imagesIn(model.doStreamCalls[2]!.prompt)).toEqual([]);

    expect(entries.filter((e) => e.msg === 'reply.image_fallback')).toEqual([
      {
        level: 'warn',
        msg: 'reply.image_fallback',
        fields: expect.objectContaining({
          replaced: 1,
          urls: [url],
          error: expect.objectContaining({ statusCode: 400 }),
        }),
      },
    ]);
    expect(entries.filter((e) => e.msg === 'reply.end').map((e) => e.fields)).toEqual([
      expect.objectContaining({
        outcome: 'completed',
        imageFallback: true,
        markedUnreadable: 1,
        attempts: 2,
      }),
      expect.not.objectContaining({ imageFallback: expect.anything() }),
    ]);
    // 日志里没有图片数据
    expect(JSON.stringify(entries)).not.toContain(base64(broken.data));
  });

  it.each([413, 422])('%i 同样恢复', async (status) => {
    const model = rejecting({ status });
    const { conversation, store } = setup({ model });
    await conversation.append({ author: alice, text: '看图', files: [broken] });

    expect(errorsOf(await readAll(conversation.reply()))).toEqual([]);
    expect((await store.list()).map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('只换可疑图片：最后一条助手回复之前的图片照常发出，也不标记', async () => {
    const model = rejecting({ replies: ['第一张看到了', '第二张看不清'] });
    const { conversation, store } = setup({ model });
    await conversation.append({ author: alice, text: '第一张', files: [fine] });
    await readAll(conversation.reply());
    await conversation.append({ author: alice, text: '第二张', files: [broken] });
    await conversation.append({ author: alice, text: '还有一张', files: [fine] });

    const chunks = await readAll(conversation.reply());

    expect(errorsOf(chunks)).toEqual([]);
    expect(shapeOf(model, 2)).toEqual([
      expect.stringContaining('第一张|<图片 fine>|'),
      '第一张看到了',
      expect.stringMatching(/第二张\|\[图片无法读取\]\|<\/message>$/),
      expect.stringMatching(/还有一张\|\[图片无法读取\]\|<\/message>$/),
    ]);
    const marks = (await store.list()).map((m) => m.metadata?.unreadableFiles?.length ?? 0);
    expect(marks).toEqual([0, 0, 1, 1, 0]);
  });

  it('被中止但有文字的助手回复也算上一条回复：它之前的图片不可疑', async () => {
    const model = rejecting();
    const { conversation, store } = setup({ model });
    await conversation.append({ author: alice, text: '看图', files: [broken] });
    await store.add({
      id: 'half',
      role: 'assistant',
      metadata: { createdAt: new Date().toISOString(), aborted: true },
      parts: [{ type: 'text', text: '说到一半' }],
    });
    await conversation.append({ author: alice, text: '继续' });

    const chunks = await readAll(conversation.reply());

    expect(errorsOf(chunks)).toHaveLength(1);
    expect(model.doStreamCalls).toHaveLength(1);
  });

  it('没有可疑图片时被 400 拒收：只请求一次，照旧按失败处理', async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => {
        throw httpError(400);
      },
    });
    const { conversation, store, entries } = setup({ model });
    await conversation.append({ author: alice, text: '没有图片' });

    const chunks = await readAll(conversation.reply());

    expect(errorsOf(chunks)).toHaveLength(1);
    expect(model.doStreamCalls).toHaveLength(1);
    expect((await store.list()).map((m) => m.role)).toEqual(['user']);
    expect(entries.map((e) => e.msg)).not.toContain('reply.image_fallback');
    expect(entries.find((e) => e.msg === 'reply.failed')?.fields).not.toHaveProperty(
      'imageFallback',
    );
  });

  it('读不到的图片不算可疑：照旧是「[图片已丢失]」，不恢复', async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => {
        throw httpError(400);
      },
    });
    const store = createMemoryStore();
    // 消息由另一个文件存储写入：这次的文件存储里读不到
    const writer = setup({ model: rejecting(), store });
    await writer.conversation.append({ author: alice, text: '看图', files: [broken] });
    const { conversation } = setup({ model, store });

    expect(errorsOf(await readAll(conversation.reply()))).toHaveLength(1);
    expect(model.doStreamCalls).toHaveLength(1);
  });

  it('重试也被拒收：不再请求第三次；流里只有重试的错误，回复不写入，消息不标记', async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => {
        throw httpError(400);
      },
    });
    const { conversation, store, entries } = setup({ model });
    await conversation.append({ author: alice, text: '看图', files: [broken] });

    const chunks = await readAll(conversation.reply());

    expect(model.doStreamCalls).toHaveLength(2);
    expect(errorsOf(chunks)).toHaveLength(1);
    expect(imagesIn(model.doStreamCalls[1]!.prompt)).toEqual([]);
    const messages = await store.list();
    expect(messages.map((m) => m.role)).toEqual(['user']);
    expect(messages[0]?.metadata).not.toHaveProperty('unreadableFiles');
    expect(entries.find((e) => e.msg === 'reply.failed')?.fields).toMatchObject({
      imageFallback: true,
      attempts: 2,
      error: { statusCode: 400 },
    });
  });

  it('先 429 重试、再 400（RetryError 包着 400）：恢复', async () => {
    const model = rejecting({ status: (call) => (call === 0 ? 429 : 400) });
    const { conversation, store } = setup({ model });
    await conversation.append({ author: alice, text: '看图', files: [broken] });

    const chunks = await readAll(conversation.reply());

    expect(errorsOf(chunks)).toEqual([]);
    expect(model.doStreamCalls).toHaveLength(3);
    expect((await store.list())[0]?.metadata?.unreadableFiles).toHaveLength(1);
  });

  it('重试那次按新的调用计数：它自己的 429 照常重试并提示；第一次调用里流式重试的提示不带过去', async () => {
    let call = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        switch (call++) {
          // 第一次调用：流里一开始就出错（还没输出）→ SDK 流式重试 → 这次请求被 400 拒收
          case 0:
            return {
              stream: simulateReadableStream<StreamPart>({
                chunks: [{ type: 'error', error: { message: '服务端过载' } }],
              }),
            };
          case 1:
            throw httpError(400);
          // 重试那次：先 429，再成功
          case 2:
            throw httpError(429);
          default:
            return { stream: simulateReadableStream({ chunks: textParts('看不清') }) };
        }
      },
    });
    const { conversation, entries } = setup({ model, maxRetries: 1 });
    await conversation.append({ author: alice, text: '看图', files: [broken] });

    const chunks = await readAll(conversation.reply());

    expect(model.doStreamCalls).toHaveLength(4);
    expect(errorsOf(chunks)).toEqual([]);
    expect(chunks.some((chunk) => chunk.type === 'reset-step')).toBe(false);
    expect(chunks.filter((chunk) => chunk.type === 'data-retry').map((c) => c.data)).toEqual([
      { phase: 'request', attempt: 1, maxRetries: 1, statusCode: 429 },
    ]);
    expect(textOf(chunks)).toBe('看不清');
    const attempts = entries.filter((e) => e.msg === 'model.attempt').map((e) => e.fields);
    expect(attempts.map((a) => [a.attempt, a.statusCode, a.willRetry])).toEqual([
      [1, undefined, true],
      [2, 400, false],
      [3, 429, true],
      [4, undefined, undefined],
    ]);
  });

  it('重试那次自己的流式重试照常：提示与 reset-step 落在它的内容之前，写入的是重新生成的回复', async () => {
    let call = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        switch (call++) {
          // 第一次调用：开了一个文字段就出错（没有输出）→ SDK 流式重试 → 这次请求被 400 拒收
          case 0:
            return {
              stream: simulateReadableStream<StreamPart>({
                chunks: [
                  { type: 'text-start', id: 't' },
                  { type: 'error', error: { message: '服务端过载' } },
                ],
              }),
            };
          case 1:
            throw httpError(400);
          // 重试那次：输出一段后流中出错 → 它自己的流式重试
          case 2:
            return {
              stream: simulateReadableStream<StreamPart>({
                chunks: [
                  { type: 'text-start', id: 't' },
                  { type: 'text-delta', id: 't', delta: '作废的半截' },
                  { type: 'error', error: { message: '服务端过载' } },
                ],
              }),
            };
          default:
            return { stream: simulateReadableStream({ chunks: textParts('看不清') }) };
        }
      },
    });
    const { conversation, store } = setup({ model, maxRetries: 1 });
    await conversation.append({ author: alice, text: '看图', files: [broken] });

    const chunks = await readAll(conversation.reply());

    expect(model.doStreamCalls).toHaveLength(4);
    expect(errorsOf(chunks)).toEqual([]);
    const trace = chunks.flatMap((chunk) =>
      chunk.type === 'text-delta'
        ? [chunk.delta]
        : chunk.type === 'data-retry' || chunk.type === 'reset-step'
          ? [chunk.type]
          : [],
    );
    expect(trace).toEqual(['作废的半截', 'data-retry', 'reset-step', '看不清']);
    const [, reply] = await store.list();
    expect(reply?.parts.filter((part) => part.type === 'text')).toMatchObject([{ text: '看不清' }]);
  });

  describe('不恢复的情况：与原来一致', () => {
    it.each([401, 403, 404])('%i：只请求一次', async (status) => {
      const model = rejecting({ status });
      const { conversation, store } = setup({ model });
      await conversation.append({ author: alice, text: '看图', files: [broken] });

      expect(errorsOf(await readAll(conversation.reply()))).toHaveLength(1);
      expect(model.doStreamCalls).toHaveLength(1);
      expect((await store.list())[0]?.metadata).not.toHaveProperty('unreadableFiles');
    });

    it.each([429, 500])('%i：重试用完后失败，不再恢复', async (status) => {
      const model = rejecting({ status });
      const { conversation } = setup({ model, maxRetries: 1 });
      await conversation.append({ author: alice, text: '看图', files: [broken] });

      expect(errorsOf(await readAll(conversation.reply()))).toHaveLength(1);
      expect(model.doStreamCalls).toHaveLength(2);
    });

    it('等第一段输出超时', async () => {
      const model = new MockLanguageModelV4({
        doStream: ({ abortSignal }) =>
          new Promise<never>((_, reject) =>
            abortSignal?.addEventListener(
              'abort',
              () => reject(new DOMException('aborted', 'AbortError')),
              { once: true },
            ),
          ),
      });
      const { conversation } = setup({ model, timeouts: { firstChunkMs: 50, chunkMs: 50 } });
      await conversation.append({ author: alice, text: '看图', files: [broken] });

      expect(errorsOf(await readAll(conversation.reply()))).toHaveLength(1);
      expect(model.doStreamCalls).toHaveLength(1);
    });

    it('已经输出过内容之后流中出错（即使是 400）：不恢复', async () => {
      const model = rejecting({
        status: () => undefined,
        replies: [
          [
            { type: 'text-start', id: 't' },
            { type: 'text-delta', id: 't', delta: '我看到' },
            { type: 'error', error: httpError(400) },
          ],
        ],
      });
      const { conversation, store } = setup({ model, maxRetries: 0 });
      await conversation.append({ author: alice, text: '看图', files: [broken] });

      expect(errorsOf(await readAll(conversation.reply()))).toHaveLength(1);
      expect(model.doStreamCalls).toHaveLength(1);
      expect((await store.list())[0]?.metadata).not.toHaveProperty('unreadableFiles');
    });
  });

  it('重试时被用户中止：输出过文字的照常写入半截并标记；一字未出的不写入、不标记', async () => {
    for (const afterOutput of [true, false]) {
      const controller = new AbortController();
      let call = 0;
      const model = new MockLanguageModelV4({
        doStream: async ({ abortSignal }) => {
          if (call++ === 0) throw httpError(400);
          return {
            stream: new ReadableStream<StreamPart>({
              start(stream) {
                stream.enqueue({ type: 'text-start', id: 't' });
                if (afterOutput) stream.enqueue({ type: 'text-delta', id: 't', delta: '说到' });
                abortSignal?.addEventListener('abort', () =>
                  stream.error(new DOMException('aborted', 'AbortError')),
                );
                setTimeout(() => controller.abort(), 20);
              },
            }),
          };
        },
      });
      const { conversation, store } = setup({ model });
      await conversation.append({ author: alice, text: '看图', files: [broken] });

      await readAll(conversation.reply({ abortSignal: controller.signal }));

      const messages = await store.list();
      expect(messages.map((m) => m.role)).toEqual(afterOutput ? ['user', 'assistant'] : ['user']);
      expect(messages[0]?.metadata?.unreadableFiles?.length ?? 0).toBe(afterOutput ? 1 : 0);
    }
  });

  it('重试的回复为空（不写入回复）：标记照样写入', async () => {
    const model = rejecting({ replies: ['   '] });
    const { conversation, store, entries } = setup({ model });
    await conversation.append({ author: alice, text: '看图', files: [broken] });

    await readAll(conversation.reply());

    expect((await store.list()).map((m) => m.metadata?.unreadableFiles?.length ?? 0)).toEqual([1]);
    expect(entries.find((e) => e.msg === 'reply.end')?.fields).toMatchObject({
      outcome: 'empty',
      imageFallback: true,
      markedUnreadable: 1,
    });
  });

  it('已标记的图片不再算可疑：之后再被 400 拒收（别的原因）时只请求一次', async () => {
    let call = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        // 第一次拒收图片；重试给出空回复（不写入回复，标记照样写入）；之后一律 400
        if (call++ === 1) return { stream: simulateReadableStream({ chunks: textParts('') }) };
        throw httpError(400);
      },
    });
    const { conversation, store } = setup({ model });
    await conversation.append({ author: alice, text: '看图', files: [broken] });
    await readAll(conversation.reply());
    expect((await store.list())[0]?.metadata?.unreadableFiles).toHaveLength(1);

    // 历史里仍没有助手回复，那张图还在「上一条回复之后」，但已经标记过
    const chunks = await readAll(conversation.reply());

    expect(errorsOf(chunks)).toHaveLength(1);
    expect(model.doStreamCalls).toHaveLength(3);
  });

  it('生成期间编辑了那条消息：写入标记以最新版本为基础，编辑的正文与 editedAt 都在', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let call = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        if (call++ === 0) throw httpError(400);
        await gate;
        return { stream: simulateReadableStream({ chunks: textParts('看不清') }) };
      },
    });
    const { conversation, store } = setup({ model });
    await conversation.append({
      author: alice,
      text: '原来的说明',
      files: [broken],
      platformMessageId: '42',
    });

    const replying = readAll(conversation.reply());
    while (model.doStreamCalls.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
    await editMessage(store, {
      platformMessageId: '42',
      text: '改过的说明',
      editedAt: '2026-10-30T06:05:00.000Z',
    });
    release();
    await replying;

    const [user] = await store.list();
    expect(user?.parts[0]).toEqual({ type: 'text', text: '改过的说明' });
    expect(user?.metadata).toMatchObject({
      editedAt: '2026-10-30T06:05:00.000Z',
      unreadableFiles: [expect.stringMatching(/^luoli-file:/)],
    });
  });

  it('标记之后再编辑：标记仍在，发给模型的仍是占位', async () => {
    const model = rejecting({ replies: ['看不清', '好'] });
    const { conversation, store } = setup({ model });
    await conversation.append({
      author: alice,
      text: '原来的说明',
      files: [broken],
      platformMessageId: '42',
    });
    await readAll(conversation.reply());

    await editMessage(store, { platformMessageId: '42', text: '改过的说明', editedAt: 'x' });
    await conversation.append({ author: alice, text: '再看看' });
    await readAll(conversation.reply());

    expect((await store.list())[0]?.metadata?.unreadableFiles).toHaveLength(1);
    expect(shapeOf(model, 2)[0]).toMatch(/改过的说明\|\[图片无法读取\]\|<\/message>$/);
    expect(model.doStreamCalls).toHaveLength(3);
  });

  it('SQLite 存储：标记写入后重新打开，发给模型的仍是占位', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'luolicore-fallback-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const fileStore = openFileStore(join(dir, 'files'));
    const first = openSqliteStorage(join(dir, 'luoli.db'));
    const id = await first.createConversation({ platform: 'cli' });
    const writer = setup({
      model: rejecting(),
      store: await first.openConversation(id),
      fileStore,
    });
    await writer.conversation.append({ author: alice, text: '看图', files: [broken] });
    await readAll(writer.conversation.reply());
    await writer.conversation.close();
    first.close();

    const second = openSqliteStorage(join(dir, 'luoli.db'));
    cleanups.push(async () => second.close());
    const model = rejecting();
    const { conversation } = setup({ model, store: await second.openConversation(id), fileStore });
    await conversation.append({ author: alice, text: '还在吗' });
    await readAll(conversation.reply());

    expect(model.doStreamCalls).toHaveLength(1);
    expect(shapeOf(model, 0)[0]).toMatch(/看图\|\[图片无法读取\]\|<\/message>$/);
  });

  it('摘要请求：消息已标记时用占位（摘要本身不做恢复）', async () => {
    const model = rejecting({ replies: ['看不清', '摘要'] });
    const { conversation, store } = setup({ model, segments: { idleMs: 30 } });
    await conversation.append({ author: alice, text: '看图', files: [broken] });
    await readAll(conversation.reply());

    const deadline = Date.now() + 2000;
    while ((await store.currentSegment()).startReason !== 'idle') {
      if (Date.now() > deadline) throw new Error('等待超时');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(model.doStreamCalls).toHaveLength(3);
    expect(imagesIn(model.doStreamCalls[2]!.prompt)).toEqual([]);
    expect(shapeOf(model, 2)[0]).toMatch(/看图\|\[图片无法读取\]\|<\/message>$/);
  });
});

describe('withUnreadable', () => {
  it('与已有的标记合并、去重，metadata 的其他字段不变', () => {
    const message = {
      id: 'm',
      role: 'user' as const,
      metadata: { createdAt: 'x', editedAt: 'y', unreadableFiles: ['luoli-file:a'] },
      parts: [],
    };

    expect(withUnreadable(message, ['luoli-file:b', 'luoli-file:a'])).toEqual({
      ...message,
      metadata: { ...message.metadata, unreadableFiles: ['luoli-file:a', 'luoli-file:b'] },
    });
    expect(message.metadata.unreadableFiles).toEqual(['luoli-file:a']);
  });
});
