import { APICallError, simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createConversation,
  createMemoryFileStore,
  createMemoryStore,
  createModel,
  defineTool,
  installTools,
  TextAndImages,
  type Conversation,
  type ConversationStore,
  type Logger,
  type Message,
  type MessageChunk,
  type ToolDefinition,
} from './index.js';
import { testPrompts } from './test-prompts.js';

type StreamResult = Awaited<ReturnType<MockLanguageModelV4['doStream']>>;
type StreamPart = StreamResult['stream'] extends ReadableStream<infer P> ? P : never;
type CallOptions = MockLanguageModelV4['doStreamCalls'][number];

const alice = { id: 'u-alice', name: 'Alice' };
const prompts = testPrompts('你是测试助手');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-30T06:02:00.000Z') });
});
const opened: Conversation[] = [];
afterEach(async () => {
  for (const conversation of opened.splice(0)) await conversation.close();
  vi.useRealTimers();
});

// ---- 图片 ----

const u32be = (value: number) => [
  value >>> 24,
  (value >> 16) & 0xff,
  (value >> 8) & 0xff,
  value & 0xff,
];

/** 一张 PNG 的开头：签名与 IHDR，够文件存储认出类型、够读出宽高 */
function png(width: number, height: number, seed = 0): Uint8Array {
  return new Uint8Array([
    ...[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    ...u32be(13),
    ...[0x49, 0x48, 0x44, 0x52],
    ...u32be(width),
    ...u32be(height),
    ...[8, 6, 0, 0, 0, seed],
  ]);
}

const base64 = (data: Uint8Array) => Buffer.from(data).toString('base64');

// ---- 模型的输出 ----

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

function finish(reason: 'stop' | 'tool-calls'): StreamPart {
  return { type: 'finish', finishReason: { unified: reason, raw: undefined }, usage };
}

function call(toolName: string, input: unknown, id = `call-${toolName}`): StreamPart[] {
  const json = JSON.stringify(input);
  return [
    { type: 'tool-input-start', id, toolName },
    { type: 'tool-input-delta', id, delta: json },
    { type: 'tool-input-end', id },
    { type: 'tool-call', toolCallId: id, toolName, input: json },
  ];
}

const calls = (...parts: StreamPart[][]): StreamPart[] => [...parts.flat(), finish('tool-calls')];
const answer = (text: string): StreamPart[] => [
  { type: 'text-start', id: 't' },
  { type: 'text-delta', id: 't', delta: text },
  { type: 'text-end', id: 't' },
  finish('stop'),
];

const rejected = () =>
  new APICallError({
    message: 'image not supported',
    url: 'http://fake.test/v1/chat/completions',
    requestBodyValues: {},
    statusCode: 400,
    isRetryable: false,
  });

/** 可重试的 429；retry-after-ms 为 0，SDK 重试时不等待 */
const overloaded = () =>
  new APICallError({
    message: 'HTTP 429',
    url: 'http://fake.test/v1/chat/completions',
    requestBodyValues: {},
    statusCode: 429,
    isRetryable: true,
    responseHeaders: { 'retry-after-ms': '0' },
  });

type Reply = StreamPart[] | Error | ReadableStream<StreamPart>;
type Attempt = Reply | ((options: CallOptions) => Reply);

/** 依次处理每次请求；函数可以看着请求决定怎么回。用完后回答「好」 */
function scriptedModel(...attempts: Attempt[]): MockLanguageModelV4 {
  let index = 0;
  return new MockLanguageModelV4({
    doStream: async (options) => {
      const attempt = attempts[index++] ?? answer('好');
      const next = typeof attempt === 'function' ? attempt(options) : attempt;
      if (next instanceof Error) throw next;
      if (next instanceof ReadableStream) return { stream: next };
      return { stream: simulateReadableStream({ chunks: next }) };
    },
  });
}

/** 给出这些段后挂起，直到请求被中止 */
function hanging(signal: AbortSignal | undefined): ReadableStream<StreamPart> {
  return new ReadableStream<StreamPart>({
    start(controller) {
      controller.enqueue({ type: 'stream-start', warnings: [] });
      signal?.addEventListener(
        'abort',
        () => controller.error(new DOMException('This operation was aborted', 'AbortError')),
        { once: true },
      );
    },
  });
}

// ---- 请求与结果 ----

function requestOf(model: MockLanguageModelV4, index: number): CallOptions {
  const request = model.doStreamCalls[index];
  if (!request) throw new Error(`没有第 ${index} 次请求`);
  return request;
}

/** 请求里各工具结果交给模型的内容，按 toolCallId */
function toolResultsOf(request: CallOptions): Record<string, unknown> {
  return Object.fromEntries(
    request.prompt.flatMap((message) =>
      message.role === 'tool'
        ? message.content.flatMap((part) =>
            part.type === 'tool-result' ? [[part.toolCallId, part.output]] : [],
          )
        : [],
    ),
  );
}

/** 请求里有没有工具结果带着的图片 */
const hasToolImage = (request: CallOptions) =>
  Object.values(toolResultsOf(request)).some(
    (output) =>
      (output as { type: string }).type === 'content' &&
      (output as { value: Array<{ type: string }> }).value.some((part) => part.type === 'file'),
  );

/** 请求里有没有用户消息带着的图片 */
const hasUserImage = (request: CallOptions) =>
  request.prompt.some(
    (message) => message.role === 'user' && message.content.some((part) => part.type === 'file'),
  );

/** 不带标记的图片部件（以后的回复里的样子） */
const imagePart = (data: Uint8Array) => ({
  type: 'file',
  mediaType: 'image/png',
  data: { type: 'data', data },
});

async function readAll(stream: ReadableStream<MessageChunk>): Promise<MessageChunk[]> {
  const chunks: MessageChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

type LogEntry = { level: 'info' | 'warn' | 'error'; msg: string; fields: Record<string, unknown> };

function recordingLogger(): { logger: Logger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const record = (level: LogEntry['level']) => (fields: object, msg: string) => {
    entries.push({ level, msg, fields: fields as Record<string, unknown> });
  };
  return {
    logger: { info: record('info'), warn: record('warn'), error: record('error') },
    entries,
  };
}

const logsOf = (entries: LogEntry[], msg: string) => entries.filter((e) => e.msg === msg);

function toolPartsOf(message: Message | undefined) {
  return (message?.parts ?? []).flatMap((part) =>
    part.type.startsWith('tool-')
      ? [part as Extract<Message['parts'][number], { toolCallId: string }>]
      : [],
  );
}

// ---- 测试用的工具 ----

/** 截图：返回一段文字和几张图片（只给字节的按 PNG） */
function snapTool({
  images = [png(800, 600)],
  text = '截图',
  history,
}: {
  images?: Array<Uint8Array | { data: Uint8Array; mediaType: string }>;
  text?: string;
  history?: { maxChars: number };
} = {}): ToolDefinition {
  return defineTool({
    name: 'snap',
    description: '截一张图',
    input: z.object({}),
    ...(history === undefined ? {} : { history }),
    execute: async () =>
      new TextAndImages({
        text,
        images: images.map((image) =>
          image instanceof Uint8Array ? { data: image, mediaType: 'image/png' } : image,
        ),
      }),
  });
}

const dice = defineTool({
  name: 'dice',
  description: '掷一个骰子',
  input: z.object({}),
  execute: async () => ({ value: 4 }),
});

function setup({
  model,
  definitions,
  store = createMemoryStore({ title: '读书会' }),
  ...options
}: {
  model: Parameters<typeof createConversation>[0]['model'];
  definitions: ToolDefinition[];
  store?: ConversationStore;
} & Omit<Parameters<typeof createConversation>[0], 'model' | 'prompts' | 'tools' | 'store'>) {
  const { logger, entries } = recordingLogger();
  const fileStore = createMemoryFileStore();
  const conversation = createConversation({
    model,
    prompts,
    logger,
    store,
    fileStore,
    conversationId: 'c1',
    tools: installTools(definitions, {}).tools,
    ...options,
  });
  opened.push(conversation);
  const round = async (userText: string, abortSignal?: AbortSignal) => {
    await conversation.append({ author: alice, text: userText });
    return readAll(conversation.reply({ abortSignal }));
  };
  const lastReply = async () =>
    (await store.list()).findLast((message) => message.role === 'assistant');
  return { conversation, store, fileStore, entries, round, lastReply };
}

describe('当次回复', () => {
  it('下一步的请求里结果是内容部件：文字在前、图片在后，图片数据从文件存储读出', async () => {
    const image = png(800, 600);
    const model = scriptedModel(calls(call('snap', {})), answer('看到了'));
    const { round, fileStore } = setup({ model, definitions: [snapTool({ images: [image] })] });

    await round('截个图');

    // 本次回复新出现的图片带着标记（拒收时据此找出可疑的图片），provider 不会把它发出去
    const url = `luoli-file:${fileStore.names()[0]}`;
    expect(toolResultsOf(requestOf(model, 1))).toEqual({
      'call-snap': {
        type: 'content',
        value: [
          { type: 'text', text: '截图' },
          {
            type: 'file',
            mediaType: 'image/png',
            data: { type: 'data', data: image },
            providerOptions: { luoli: { freshToolImage: url } },
          },
        ],
      },
    });
  });

  it('历史里的工具结果只有地址、类型、宽高、字节数，没有图片数据；文件存储里有这张图', async () => {
    const image = png(800, 600);
    const model = scriptedModel(calls(call('snap', {})), answer('看到了'));
    const { round, lastReply, fileStore } = setup({
      model,
      definitions: [snapTool({ images: [image] })],
    });

    await round('截个图');

    const [part] = toolPartsOf(await lastReply());
    const [name] = fileStore.names();
    expect(part).toMatchObject({
      state: 'output-available',
      output: {
        type: 'luoli-content',
        parts: [
          { type: 'text', text: '截图' },
          {
            type: 'image',
            url: `luoli-file:${name}`,
            mediaType: 'image/png',
            width: 800,
            height: 600,
            bytes: image.length,
          },
        ],
      },
    });
    expect(JSON.stringify(await lastReply())).not.toContain(base64(image));
    expect(await fileStore.read(`luoli-file:${name}`)).toEqual(image);
  });

  it('同一张图返回两次只存一份；不同的图各存一份', async () => {
    const model = scriptedModel(
      calls(call('snap', {}, 'a'), call('snap', {}, 'b')),
      answer('看到了'),
    );
    const { round, fileStore } = setup({
      model,
      definitions: [snapTool({ images: [png(800, 600), png(800, 600), png(10, 10)] })],
    });

    await round('截两次图');

    expect(fileStore.names()).toHaveLength(2);
  });

  it('存不了的图片换成说明，调用照常完成，记一条 warn（不记内容）', async () => {
    const fake = new TextEncoder().encode('不是图片');
    const model = scriptedModel(calls(call('snap', {})), answer('好'));
    const { round, entries, lastReply } = setup({
      model,
      definitions: [
        snapTool({
          images: [
            { data: fake, mediaType: 'image/png' },
            { data: png(1, 1), mediaType: 'image/bmp' },
            { data: png(2, 2), mediaType: 'image/png' },
          ],
        }),
      ],
    });

    await round('截个图');

    expect(toolResultsOf(requestOf(model, 1))['call-snap']).toMatchObject({
      type: 'content',
      value: [
        { type: 'text', text: '截图' },
        { type: 'text', text: '[图片无法保存：image/png]' },
        { type: 'text', text: '[图片无法保存：image/bmp]' },
        { type: 'file', mediaType: 'image/png' },
      ],
    });
    expect(toolPartsOf(await lastReply())[0]).toMatchObject({ state: 'output-available' });
    const warnings = logsOf(entries, 'tool.image_unsaved');
    expect(warnings.map(({ level, fields }) => [level, fields.mediaType])).toEqual([
      ['warn', 'image/png'],
      ['warn', 'image/bmp'],
    ]);
    expect(JSON.stringify(warnings)).not.toContain('不是图片');
    expect(logsOf(entries, 'tool.end')[0]!.fields).toMatchObject({ outcome: 'completed' });
  });

  it('工具调用表与 tool.end 的结果长度只算文字，tool.end 另记图片张数', async () => {
    const model = scriptedModel(calls(call('snap', {})), answer('好'));
    const { round, store, entries } = setup({
      model,
      definitions: [snapTool({ text: '五个字符啊', images: [png(8, 8), png(9, 9)] })],
    });

    await round('截个图');

    expect((await store.toolCalls()).map((row) => row.outputChars)).toEqual([5]);
    expect(logsOf(entries, 'tool.end')[0]!.fields).toMatchObject({
      resultLength: 5,
      images: 2,
    });
  });
});

describe('发出的请求', () => {
  /** openai-compatible 的服务端：第一次回两个工具调用，之后回「好」；记下每次请求的正文 */
  function fakeServer() {
    const bodies: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
    const chunk = (delta: object, finishReason: string | null) => ({
      id: 'x',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'm',
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    });
    const toolCall = (index: number, name: string) => ({
      index,
      id: `call-${name}`,
      type: 'function',
      function: { name, arguments: '{}' },
    });
    const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      const events =
        bodies.length === 1
          ? [
              chunk(
                { role: 'assistant', tool_calls: [toolCall(0, 'snap'), toolCall(1, 'dice')] },
                null,
              ),
              chunk({}, 'tool_calls'),
            ]
          : [chunk({ role: 'assistant', content: '好' }, null), chunk({}, 'stop')];
      const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`;
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    };
    const model = createModel({ baseURL: 'http://fake.test/v1', modelId: 'm', fetch });
    return { model, bodies };
  }

  it('带图片的结果是文字加 image_url 部件的数组，普通结果仍是字符串', async () => {
    const image = png(800, 600);
    const server = fakeServer();
    const { round } = setup({
      model: server.model,
      definitions: [snapTool({ images: [image] }), dice],
    });

    await round('截图，再掷个骰子');

    const tools = server.bodies[1]!.messages.filter((message) => message.role === 'tool');
    expect(tools).toEqual([
      {
        role: 'tool',
        tool_call_id: 'call-snap',
        content: [
          { type: 'text', text: '截图' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${base64(image)}` } },
        ],
      },
      { role: 'tool', tool_call_id: 'call-dice', content: '{"value":4}' },
    ]);
  });
});

describe('以后的回复与摘要', () => {
  it('图片照样以图片部件发出（不带标记）；文字部分照工具的历史声明截短；同一条消息每次发出都一样', async () => {
    const image = png(800, 600);
    const model = scriptedModel(
      calls(call('snap', {})),
      answer('看到了'),
      answer('好'),
      answer('好'),
    );
    const { round } = setup({
      model,
      definitions: [
        snapTool({ text: '一二三四五六七', images: [image], history: { maxChars: 3 } }),
      ],
    });

    await round('截个图');
    await round('再说说');
    await round('还有呢');

    const expected = {
      type: 'content',
      value: [{ type: 'text', text: '一二三…（已截短，原文 7 字符）' }, imagePart(image)],
    };
    expect(toolResultsOf(requestOf(model, 2))['call-snap']).toEqual(expected);
    expect(toolResultsOf(requestOf(model, 3))['call-snap']).toEqual(expected);
  });

  it('没有文字时只有图片；没声明时文字按默认上限截短；读不到的文件换成「[图片已丢失]」', async () => {
    const kept = png(4, 3);
    const lost = png(5, 5);
    const model = scriptedModel(
      calls(call('snap', {})),
      answer('看到了'),
      answer('好'),
      answer('好'),
    );
    // 文件存储包一层：deleted 里的地址读不到，像文件被删了
    const deleted = new Set<string>();
    const fileStore = createMemoryFileStore();
    const { round, entries } = setup({
      model,
      fileStore: {
        ...fileStore,
        read: async (url) => (deleted.has(url) ? undefined : fileStore.read(url)),
      },
      definitions: [snapTool({ text: '', images: [kept, lost] })],
    });

    await round('截个图');
    await round('再说说');
    expect(toolResultsOf(requestOf(model, 2))['call-snap']).toEqual({
      type: 'content',
      value: [imagePart(kept), imagePart(lost)],
    });

    // 文件丢了：换成文字，记一条 warn
    const lostUrl = (await fileStore.save({ data: lost, mediaType: 'image/png' }))!;
    deleted.add(lostUrl);
    await round('还有呢');
    expect(toolResultsOf(requestOf(model, 3))['call-snap']).toEqual({
      type: 'content',
      value: [imagePart(kept), { type: 'text', text: '[图片已丢失]' }],
    });
    expect(logsOf(entries, 'file.missing').map(({ fields }) => fields.url)).toContain(lostUrl);
  });

  it('文字超过默认上限时截短，图片照样保留', async () => {
    const model = scriptedModel(calls(call('snap', {})), answer('看到了'), answer('好'));
    const { round } = setup({
      model,
      definitions: [snapTool({ text: 'x'.repeat(30) })],
      toolHistoryChars: 10,
    });

    await round('截个图');
    await round('再说说');

    expect(toolResultsOf(requestOf(model, 2))['call-snap']).toEqual({
      type: 'content',
      value: [
        { type: 'text', text: `${'x'.repeat(10)}…（已截短，原文 30 字符）` },
        imagePart(png(800, 600)),
      ],
    });
  });

  it('工具声明不保留结果（omit）时连同图片一起省略', async () => {
    const model = scriptedModel(calls(call('snap', {})), answer('看到了'), answer('好'));
    const { round } = setup({
      model,
      definitions: [
        defineTool({
          name: 'snap',
          description: '截一张图',
          input: z.object({}),
          history: 'omit',
          execute: async () =>
            new TextAndImages({
              text: '截图',
              images: [{ data: png(8, 8), mediaType: 'image/png' }],
            }),
        }),
      ],
    });

    await round('截个图');
    await round('再说说');

    expect(toolResultsOf(requestOf(model, 2))['call-snap']).toEqual({
      type: 'text',
      value: '（结果已省略）',
    });
  });

  it('自定义的呈现函数拿到文字，图片照样保留', async () => {
    const received: unknown[] = [];
    const model = scriptedModel(calls(call('snap', {})), answer('看到了'), answer('好'));
    const { round } = setup({
      model,
      definitions: [
        defineTool({
          name: 'snap',
          description: '截一张图',
          input: z.object({}),
          history: ({ output }) => {
            received.push(output);
            return `摘要：${output.length} 字`;
          },
          execute: async () =>
            new TextAndImages({
              text: '截图',
              images: [{ data: png(8, 8), mediaType: 'image/png' }],
            }),
        }),
      ],
    });

    await round('截个图');
    await round('再说说');

    expect(received).toEqual(['截图']);
    expect(toolResultsOf(requestOf(model, 2))['call-snap']).toEqual({
      type: 'content',
      value: [{ type: 'text', text: '摘要：2 字' }, imagePart(png(8, 8))],
    });
  });

  it('摘要请求里同样带着图片', async () => {
    const model = scriptedModel(
      calls(call('snap', {})),
      answer('看到了'),
      answer('Alice 截了图。'),
    );
    const { store, round } = setup({
      model,
      definitions: [snapTool()],
      segments: { idleMs: 30 },
    });

    await round('截个图');
    vi.setSystemTime(Date.now() + 60_000);
    await until(async () => (await store.currentSegment()).startReason === 'idle');

    expect(toolResultsOf(requestOf(model, 2))['call-snap']).toEqual({
      type: 'content',
      value: [{ type: 'text', text: '截图' }, imagePart(png(800, 600))],
    });
  });
});

describe('拒收后换成占位重试', () => {
  const placeholder = { type: 'text', text: '[图片无法读取]' };

  it('第 2 步带着工具图片被拒收：换成占位重试成功，请求次数多 1，流里没有错误与半截；第 3 步也用占位；标记写进助手消息，以后的请求也用占位', async () => {
    const model = scriptedModel(
      calls(call('snap', {}, 'a')),
      (request) => (hasToolImage(request) ? rejected() : new Error('应当带着图片')),
      (request) => (hasToolImage(request) ? rejected() : calls(call('snap', {}, 'b'))),
      (request) => (hasToolImage(request) ? rejected() : answer('看不清图')),
      (request) => (hasToolImage(request) ? rejected() : answer('好')),
    );
    const { round, store, entries, lastReply, fileStore } = setup({
      model,
      definitions: [snapTool()],
    });

    const chunks = await round('截个图');

    expect(chunks.some((chunk) => chunk.type === 'error' || chunk.type === 'reset-step')).toBe(
      false,
    );
    expect(chunks.filter((chunk) => chunk.type === 'data-retry')).toEqual([]);
    expect(model.doStreamCalls).toHaveLength(4);
    const replaced = { type: 'content', value: [{ type: 'text', text: '截图' }, placeholder] };
    expect(toolResultsOf(requestOf(model, 2))).toEqual({ a: replaced });
    expect(toolResultsOf(requestOf(model, 3))).toEqual({ a: replaced, b: replaced });
    const [row] = await store.calls();
    expect(row).toMatchObject({ outcome: 'completed', attempts: 4, steps: 3 });
    const url = `luoli-file:${fileStore.names()[0]}`;
    expect(logsOf(entries, 'reply.tool_image_fallback')[0]!.fields).toMatchObject({
      replaced: 1,
      urls: [url],
    });
    expect(logsOf(entries, 'reply.end')[0]!.fields).toMatchObject({
      outcome: 'completed',
      toolImageFallback: true,
    });
    // 历史照旧存地址，助手消息记下被拒收的图片
    const reply = await lastReply();
    expect(reply?.metadata?.unreadableFiles).toEqual([url]);
    expect(toolPartsOf(reply).map((part) => (part.output as { type: string }).type)).toEqual([
      'luoli-content',
      'luoli-content',
    ]);

    await round('再说说');
    expect(toolResultsOf(requestOf(model, 4))).toEqual({ a: replaced, b: replaced });
  });

  it('被拒收之后新出现的图片照常发出；它也被拒收时同样换掉', async () => {
    const first = png(800, 600);
    const second = png(10, 10);
    let snaps = 0;
    const model = scriptedModel(
      calls(call('snap', {}, 'a')),
      rejected(),
      calls(call('snap', {}, 'b')),
      (request) =>
        JSON.stringify(toolResultsOf(request).b).includes('"file"') ? rejected() : answer('好'),
      answer('好'),
    );
    const { round, lastReply, fileStore } = setup({
      model,
      definitions: [
        defineTool({
          name: 'snap',
          description: '截一张图',
          input: z.object({}),
          execute: async () =>
            new TextAndImages({
              images: [{ data: snaps++ === 0 ? first : second, mediaType: 'image/png' }],
            }),
        }),
      ],
    });

    await round('截两张图');

    expect(toolResultsOf(requestOf(model, 3)).b).toMatchObject({
      value: [{ type: 'file', data: { data: second } }],
    });
    expect(toolResultsOf(requestOf(model, 4))).toEqual({
      a: { type: 'content', value: [placeholder] },
      b: { type: 'content', value: [placeholder] },
    });
    const urls = await Promise.all(
      [first, second].map((data) => fileStore.save({ data, mediaType: 'image/png' })),
    );
    expect(new Set((await lastReply())?.metadata?.unreadableFiles)).toEqual(new Set(urls));
  });

  it('本次回复里已被接受的图片不算可疑：后面的请求因新图片被拒收时只换新图片', async () => {
    const first = png(800, 600);
    const second = png(10, 10);
    let snaps = 0;
    const hasSecond = (request: CallOptions) =>
      JSON.stringify(toolResultsOf(request).b ?? null).includes('"file"');
    const model = scriptedModel(
      calls(call('snap', {}, 'a')),
      calls(call('snap', {}, 'b')),
      (request) => (hasSecond(request) ? rejected() : answer('第一张是大图')),
      (request) => (hasSecond(request) ? rejected() : answer('第一张是大图')),
    );
    const { round, entries, lastReply, fileStore } = setup({
      model,
      definitions: [
        defineTool({
          name: 'snap',
          description: '截一张图',
          input: z.object({}),
          execute: async () =>
            new TextAndImages({
              images: [{ data: snaps++ === 0 ? first : second, mediaType: 'image/png' }],
            }),
        }),
      ],
    });

    await round('截两张图');

    expect(model.doStreamCalls).toHaveLength(4);
    const [firstUrl, secondUrl] = await Promise.all(
      [first, second].map((data) => fileStore.save({ data, mediaType: 'image/png' })),
    );
    // 第 3 步重发：第一张照样发出，只有第二张换成占位
    expect(toolResultsOf(requestOf(model, 3))).toMatchObject({
      a: { type: 'content', value: [{ type: 'file', data: { data: first } }] },
      b: { type: 'content', value: [placeholder] },
    });
    expect(logsOf(entries, 'reply.tool_image_fallback')[0]!.fields).toMatchObject({
      replaced: 1,
      urls: [secondUrl],
    });
    expect((await lastReply())?.metadata?.unreadableFiles).toEqual([secondUrl]);
    expect(firstUrl).not.toEqual(secondUrl);

    await round('再说说');
    expect(toolResultsOf(requestOf(model, 4))).toEqual({
      a: { type: 'content', value: [imagePart(first)] },
      b: { type: 'content', value: [placeholder] },
    });
  });

  it('重试仍被拒收：按出错处理，写入完成的第 1 步，带着标记', async () => {
    const model = scriptedModel(calls(call('snap', {})), rejected(), rejected());
    const { round, store, lastReply, fileStore } = setup({ model, definitions: [snapTool()] });

    const chunks = await round('截个图');

    expect(chunks.some((chunk) => chunk.type === 'error')).toBe(true);
    expect(model.doStreamCalls).toHaveLength(3);
    expect(requestOf(model, 2).prompt).not.toEqual(requestOf(model, 1).prompt);
    expect((await store.calls())[0]).toMatchObject({ outcome: 'failed', attempts: 3 });
    expect((await lastReply())?.metadata).toMatchObject({
      failed: true,
      unreadableFiles: [`luoli-file:${fileStore.names()[0]}`],
    });
  });

  it('请求里没有工具图片时的拒收不触发这条重试', async () => {
    const model = scriptedModel(calls(call('dice', {})), rejected());
    const { round, store, entries } = setup({ model, definitions: [dice] });

    const chunks = await round('掷个骰子');

    expect(chunks.some((chunk) => chunk.type === 'error')).toBe(true);
    expect(model.doStreamCalls).toHaveLength(2);
    expect((await store.calls())[0]).toMatchObject({ outcome: 'failed', attempts: 2 });
    expect(logsOf(entries, 'reply.tool_image_fallback')).toEqual([]);
  });

  it('历史里的工具图片不算可疑：带着它们的请求被拒收时不换，按出错处理', async () => {
    const model = scriptedModel(calls(call('snap', {})), answer('看到了'), rejected());
    const { round, entries } = setup({ model, definitions: [snapTool()] });

    await round('截个图');
    const chunks = await round('再说说');

    expect(chunks.some((chunk) => chunk.type === 'error')).toBe(true);
    expect(model.doStreamCalls).toHaveLength(3);
    expect(logsOf(entries, 'reply.tool_image_fallback')).toEqual([]);
  });

  it('换占位重发后遇到 429：重试序号与 SDK 一致', async () => {
    const model = scriptedModel(calls(call('snap', {})), rejected(), overloaded(), answer('好'));
    const { round, store, entries } = setup({ model, definitions: [snapTool()] });

    const chunks = await round('截个图');

    expect(
      chunks.filter((chunk) => chunk.type === 'data-retry').map((chunk) => chunk.data),
    ).toEqual([{ phase: 'request', attempt: 1, maxRetries: 2, statusCode: 429 }]);
    expect(model.doStreamCalls).toHaveLength(4);
    expect((await store.calls())[0]).toMatchObject({ outcome: 'completed', attempts: 4 });
    expect(
      logsOf(entries, 'model.attempt').map(({ fields }) => [fields.statusCode, fields.willRetry]),
    ).toEqual([
      [undefined, undefined],
      [400, false],
      [429, true],
      [undefined, undefined],
    ]);
    expect(logsOf(entries, 'reply.end')[0]!.fields).toMatchObject({ requestRetries: 1 });
  });

  it('同一次回复里先因用户图片被拒、换占位后第 2 步又因工具图片被拒：两处都换成占位，各自记下标记', async () => {
    const userImage = png(10, 10);
    const toolImage = png(800, 600);
    const model = scriptedModel(
      (request) => (hasUserImage(request) ? rejected() : new Error('应当带着用户的图片')),
      (request) => (hasUserImage(request) ? rejected() : calls(call('snap', {}))),
      (request) => (hasToolImage(request) ? rejected() : new Error('应当带着工具的图片')),
      (request) =>
        hasToolImage(request) || hasUserImage(request) ? rejected() : answer('都看不清'),
      (request) => (hasToolImage(request) || hasUserImage(request) ? rejected() : answer('好')),
    );
    const { conversation, store, fileStore } = setup({
      model,
      definitions: [snapTool({ images: [toolImage] })],
    });

    await conversation.append({
      author: alice,
      text: '看看这张，再截个图',
      files: [{ data: userImage, mediaType: 'image/png' }],
    });
    const chunks = await readAll(conversation.reply());

    expect(chunks.some((chunk) => chunk.type === 'error')).toBe(false);
    expect(model.doStreamCalls).toHaveLength(4);
    const [userUrl, toolUrl] = await Promise.all(
      [userImage, toolImage].map((data) => fileStore.save({ data, mediaType: 'image/png' })),
    );
    const [user, assistant] = await store.list();
    expect(user?.metadata?.unreadableFiles).toEqual([userUrl]);
    expect(assistant?.metadata?.unreadableFiles).toEqual([toolUrl]);
    expect((await store.calls())[0]).toMatchObject({ outcome: 'completed', attempts: 4 });

    await conversation.append({ author: alice, text: '再说说' });
    await readAll(conversation.reply());
    const next = requestOf(model, 4);
    expect(hasUserImage(next) || hasToolImage(next)).toBe(false);
    expect(toolResultsOf(next)['call-snap']).toEqual({
      type: 'content',
      value: [{ type: 'text', text: '截图' }, placeholder],
    });
  });
});

describe('中途结束', () => {
  it('带图片的工具调用之后被中止：写入的工具结果是地址，以后照样以图片发出', async () => {
    const image = png(800, 600);
    const controller = new AbortController();
    const model = scriptedModel(
      calls(call('snap', {})),
      (request) => {
        setTimeout(() => controller.abort(), 10);
        return hanging(request.abortSignal);
      },
      answer('好'),
    );
    const { round, lastReply } = setup({ model, definitions: [snapTool({ images: [image] })] });

    await round('截个图', controller.signal);
    const aborted = await lastReply();
    expect(aborted?.metadata).toMatchObject({ aborted: true });
    expect(aborted?.metadata).not.toHaveProperty('unreadableFiles');
    expect(toolPartsOf(aborted)[0]?.output).toMatchObject({
      type: 'luoli-content',
      parts: [{ type: 'text' }, { type: 'image', mediaType: 'image/png' }],
    });

    await round('继续');
    expect(toolResultsOf(requestOf(model, 2))['call-snap']).toEqual({
      type: 'content',
      value: [{ type: 'text', text: '截图' }, imagePart(image)],
    });
  });

  it('换占位重试之后被中止：写入历史时带着标记', async () => {
    const controller = new AbortController();
    const model = scriptedModel(calls(call('snap', {})), rejected(), (request) => {
      setTimeout(() => controller.abort(), 10);
      return hanging(request.abortSignal);
    });
    const { round, lastReply, fileStore } = setup({ model, definitions: [snapTool()] });

    await round('截个图', controller.signal);

    expect((await lastReply())?.metadata).toMatchObject({
      aborted: true,
      unreadableFiles: [`luoli-file:${fileStore.names()[0]}`],
    });
  });

  it('带图片的工具调用之后出错：写入的工具结果同样是地址', async () => {
    const model = scriptedModel(calls(call('snap', {})), new Error('连接断开'));
    const { round, lastReply } = setup({ model, definitions: [snapTool()], maxRetries: 0 });

    await round('截个图');

    const failed = await lastReply();
    expect(failed?.metadata).toMatchObject({ failed: true });
    expect(toolPartsOf(failed)[0]?.output).toMatchObject({ type: 'luoli-content' });
  });
});

/** 用真实时间轮询，直到 check 成立 */
async function until(check: () => Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!(await check())) {
    if (performance.now() > deadline) throw new Error('等待超时');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
