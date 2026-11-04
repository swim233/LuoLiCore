import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createConversation,
  createMemoryFileStore,
  createMemoryStore,
  createModel,
  createRequestRecorder,
  defineTool,
  installTools,
  openRequestLog,
  TextAndImages,
  type Conversation,
  type FileStore,
  type LoggedRequest,
  type Logger,
  type MessageChunk,
  type NewFile,
  type RequestContext,
  type RequestLog,
  type ToolDefinition,
} from '../index.js';
import { testPrompts } from '../test-prompts.js';
import { withRequestContext } from './capture.js';

const alice = { id: 'u-alice', name: 'Alice' };
const prompts = testPrompts('你是测试助手');
const apiKey = 'sk-test-"secret"\\key';

const opened: Array<{ close(): unknown }> = [];
afterEach(async () => {
  for (const item of opened.splice(0)) await item.close();
});

// ---- 假的服务端 ----

type Handler = (request: {
  body: string;
  signal: AbortSignal | undefined;
}) => Response | Promise<Response>;

/** 依次用这些处理函数回应请求；记下每次收到的请求体原文 */
function fakeServer(...handlers: Handler[]) {
  const bodies: string[] = [];
  const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    const body = String(init?.body);
    bodies.push(body);
    const handler = handlers[bodies.length - 1];
    if (!handler) throw new Error(`没有安排第 ${bodies.length} 次请求`);
    return handler({ body, signal: init?.signal ?? undefined });
  };
  return { fetch: fetch as typeof globalThis.fetch, bodies };
}

const chunk = (delta: object, finishReason: string | null = null) => ({
  id: 'x',
  object: 'chat.completion.chunk',
  created: 0,
  model: 'm',
  choices: [{ index: 0, delta, finish_reason: finishReason }],
});
const usageChunk = (usage: object) => ({
  id: 'x',
  object: 'chat.completion.chunk',
  created: 0,
  model: 'm',
  choices: [],
  usage,
});
const sseText = (events: object[], done = true) =>
  events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') +
  (done ? 'data: [DONE]\n\n' : '');
const sseHeaders = { 'content-type': 'text/event-stream' };

/** 一次完整的流式回应 */
const sse =
  (...events: object[]): Handler =>
  () =>
    new Response(sseText(events), { headers: sseHeaders });

const fullUsage = {
  prompt_tokens: 120,
  completion_tokens: 30,
  prompt_tokens_details: { cached_tokens: 100 },
  completion_tokens_details: { reasoning_tokens: 12 },
};

/** 回答一段文字 */
const answer = (text: string) =>
  sse(
    chunk({ role: 'assistant', content: text }),
    chunk({}, 'stop'),
    usageChunk({ prompt_tokens: 10, completion_tokens: 2 }),
  );

/** HTTP 错误；retry-after-ms 为 0，SDK 重试时不等待 */
const httpError =
  (status: number, body: string): Handler =>
  () =>
    new Response(body, {
      status,
      headers: { 'content-type': 'application/json', 'retry-after-ms': '0' },
    });

/**
 * 分段发出的流：字符串原样发出；'hang' 之后不再发，直到请求被中止（中止时流以中止原因出错）。
 * 请求被中止时 fetch 的流会出错，假服务端照样做
 */
function streaming(parts: Array<string | 'hang'>): Handler {
  return ({ signal }) => {
    const encoder = new TextEncoder();
    const queue = [...parts];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        signal?.addEventListener('abort', () => controller.error(signal.reason), { once: true });
      },
      async pull(controller) {
        const next = queue.shift();
        if (next === undefined) return controller.close();
        if (next === 'hang') return new Promise<void>(() => {});
        controller.enqueue(encoder.encode(next));
      },
    });
    return new Response(body, { headers: sseHeaders });
  };
}

// ---- 图片与工具 ----

/** 一张 PNG 的开头：文件存储认得出类型、读得出宽高 */
function png(seed: number): Uint8Array {
  return new Uint8Array([
    ...[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52],
    ...[0, 0, 0, 8, 0, 0, 0, 6, 8, 6, 0, 0, 0, seed],
  ]);
}
const base64 = (data: Uint8Array) => Buffer.from(data).toString('base64');

const dice = defineTool({
  name: 'dice',
  description: '掷一个骰子',
  input: z.object({ sides: z.number().optional() }),
  execute: async () => ({ value: 4 }),
});

const snap = defineTool({
  name: 'snap',
  description: '截一张图',
  input: z.object({}),
  execute: async () =>
    new TextAndImages({ text: '截图', images: [{ data: png(9), mediaType: 'image/png' }] }),
});

const toolCall = (name: string, args: string) =>
  chunk({
    role: 'assistant',
    tool_calls: [
      { index: 0, id: `call-${name}`, type: 'function', function: { name, arguments: args } },
    ],
  });

// ---- 日志 ----

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

const logsOf = (entries: LogEntry[], msg: string) => entries.filter((entry) => entry.msg === msg);

async function readAll(stream: ReadableStream<MessageChunk>): Promise<MessageChunk[]> {
  const chunks: MessageChunk[] = [];
  for await (const item of stream) chunks.push(item);
  return chunks;
}

async function until(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!check()) {
    if (performance.now() > deadline) throw new Error('等待超时');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// ---- 搭起来 ----

function setup({
  handlers,
  tools = [],
  log,
  record = true,
  fileStore = createMemoryFileStore(),
  ...options
}: {
  handlers: Handler[];
  tools?: ToolDefinition[];
  /** 换掉请求记录（如写入会出错的） */
  log?: Pick<RequestLog, 'record'>;
  /** false 时不包 fetch：与关闭请求记录时一样 */
  record?: boolean;
  fileStore?: FileStore;
} & Omit<Parameters<typeof createConversation>[0], 'model' | 'prompts' | 'tools' | 'store'>) {
  const { logger, entries } = recordingLogger();
  const store = createMemoryStore();
  const requestLog = openRequestLog({ path: ':memory:', fileStore, retentionDays: 0 });
  opened.push(requestLog);
  const server = fakeServer(...handlers);
  const recorder = createRequestRecorder({
    log: log ?? requestLog,
    logger,
    secrets: [apiKey],
    fetch: server.fetch,
  });
  const model = createModel({
    baseURL: 'http://fake.test/v1',
    apiKey,
    modelId: 'm',
    fetch: record ? recorder.fetch : server.fetch,
  });
  const conversation: Conversation = createConversation({
    model,
    prompts,
    store,
    fileStore,
    logger,
    conversationId: 'c1',
    tools: installTools(tools, {}).tools,
    ...options,
  });
  opened.push(conversation);
  const round = async (
    text: string,
    { abortSignal, files }: { abortSignal?: AbortSignal; files?: NewFile[] } = {},
  ) => {
    await conversation.append({ author: alice, text, files });
    const chunks = await readAll(conversation.reply({ abortSignal }));
    await recorder.flush();
    return chunks;
  };
  const records = (embedImages = false) => requestLog.list({}, { embedImages });
  return { conversation, store, fileStore, entries, server, recorder, round, records, logger };
}

/** 记录里的说明字段（不含请求体、响应与时间） */
const labels = (items: LoggedRequest[]) =>
  items.map(({ purpose, replyId, step, attempt, outcome }) => ({
    purpose,
    replyId,
    step,
    attempt,
    outcome,
  }));

/** model.attempt 日志的步与累计序号 */
const attemptLogs = (entries: LogEntry[]) =>
  logsOf(entries, 'model.attempt').map((entry) => entry.fields.step);

describe('回复的每一次请求', () => {
  it('两步的回复：两条，步 1、2，尝试都是 1；请求体与服务端收到的一字不差；响应整理正确', async () => {
    const t = setup({
      tools: [dice],
      handlers: [
        sse(
          toolCall('dice', '{"sides":'),
          chunk({ tool_calls: [{ index: 0, function: { arguments: '6}' } }] }),
          chunk({}, 'tool_calls'),
          usageChunk({ prompt_tokens: 50, completion_tokens: 5 }),
        ),
        sse(
          chunk({ role: 'assistant', content: '掷出了' }),
          chunk({ content: ' 4' }),
          chunk({}, 'stop'),
          usageChunk(fullUsage),
        ),
      ],
    });

    await t.round('掷个骰子');
    const records = await t.records();

    const [reply] = (await t.store.list()).filter((message) => message.role === 'assistant');
    expect(labels(records)).toEqual([
      { purpose: 'reply', replyId: reply!.id, step: 1, attempt: 1, outcome: 'completed' },
      { purpose: 'reply', replyId: reply!.id, step: 2, attempt: 1, outcome: 'completed' },
    ]);
    expect(records.map((record) => JSON.stringify(record.body))).toEqual(t.server.bodies);
    expect(records.map((record) => record.response)).toEqual([
      {
        status: 200,
        toolCalls: [{ id: 'call-dice', name: 'dice', arguments: '{"sides":6}' }],
        finishReason: 'tool_calls',
        usage: { input: 50, output: 5 },
      },
      {
        status: 200,
        text: '掷出了 4',
        finishReason: 'stop',
        usage: { input: 120, cacheRead: 100, output: 30, reasoning: 12 },
      },
    ]);
    expect(records.every((record) => record.conversationId === 'c1')).toBe(true);
    expect(records[0]!.startedAt <= records[1]!.startedAt).toBe(true);
    expect(records.every((record) => record.durationMs >= 0)).toBe(true);
    // 条数等于模型调用表的 attempts；按写入先后与 model.attempt 日志一一对应，步相同
    const [call] = await t.store.calls();
    expect(call!.attempts).toBe(2);
    expect(attemptLogs(t.entries)).toEqual(records.map((record) => record.step));
  });

  it('思考内容：reasoning_content（或 reasoning）连起来', async () => {
    const t = setup({
      handlers: [
        sse(
          chunk({ role: 'assistant', reasoning_content: '先想' }),
          chunk({ reasoning_content: '一想' }),
          chunk({ content: '好' }),
          chunk({}, 'stop'),
        ),
        sse(
          chunk({ role: 'assistant', reasoning: '另一种写法' }),
          chunk({ content: '嗯' }),
          chunk({}, 'stop'),
        ),
      ],
    });

    await t.round('想一想');
    await t.round('再想想');
    const records = await t.records();

    expect(records.map((record) => [record.response.reasoning, record.response.text])).toEqual([
      ['先想一想', '好'],
      ['另一种写法', '嗯'],
    ]);
  });

  it('请求阶段重试：同一步两条，尝试 1、2；第一条 failed、状态码与响应体原文，key 抹掉', async () => {
    const errorBody = JSON.stringify({
      error: { message: `rate limited for key ${apiKey}`, echo: JSON.stringify({ key: apiKey }) },
    });
    const t = setup({ handlers: [httpError(429, errorBody), answer('好的')] });

    await t.round('你好');
    const records = await t.records();

    expect(labels(records).map(({ step, attempt, outcome }) => [step, attempt, outcome])).toEqual([
      [1, 1, 'failed'],
      [1, 2, 'completed'],
    ]);
    expect(records[0]!.response.status).toBe(429);
    const redacted = errorBody
      .replaceAll(JSON.stringify(JSON.stringify(apiKey).slice(1, -1)).slice(1, -1), '***')
      .replaceAll(JSON.stringify(apiKey).slice(1, -1), '***');
    expect(records[0]!.response.error).toBe(redacted);
    expect(records[0]!.response.error).not.toContain('secret');
    expect(records.map((record) => JSON.stringify(record.body))).toEqual(t.server.bodies);
    const [call] = await t.store.calls();
    expect(call!.attempts).toBe(records.length);
    expect(attemptLogs(t.entries)).toEqual([1, 1]);
  });

  it('流中途出错后重新生成：第一条 failed，带半截文字与错误事件；第二条 completed', async () => {
    const t = setup({
      handlers: [
        streaming([
          sseText([chunk({ role: 'assistant', content: '半截' })], false),
          `data: ${JSON.stringify({ error: { message: 'overloaded', type: 'server_error' } })}\n\n`,
        ]),
        answer('完整'),
      ],
    });

    await t.round('你好');
    const records = await t.records();

    expect(labels(records).map(({ step, attempt, outcome }) => [step, attempt, outcome])).toEqual([
      [1, 1, 'failed'],
      [1, 2, 'completed'],
    ]);
    expect(records[0]!.response).toEqual({
      status: 200,
      text: '半截',
      error: JSON.stringify({ error: { message: 'overloaded', type: 'server_error' } }),
    });
    expect(records[1]!.response.text).toBe('完整');
    expect(attemptLogs(t.entries)).toEqual([1, 1]);
  });

  it('连接中途断开：failed，带半截与错误类型、消息', async () => {
    const t = setup({
      maxRetries: 0,
      handlers: [
        () => {
          let sent = false;
          const body = new ReadableStream<Uint8Array>({
            pull(controller) {
              if (sent)
                return controller.error(
                  new TypeError('terminated', { cause: new Error('other side closed') }),
                );
              sent = true;
              controller.enqueue(
                new TextEncoder().encode(sseText([chunk({ content: '一半' })], false)),
              );
            },
          });
          return new Response(body, { headers: sseHeaders });
        },
      ],
    });

    await t.round('你好');
    const [record] = await t.records();

    expect(record!.outcome).toBe('failed');
    expect(record!.response).toEqual({
      status: 200,
      text: '一半',
      error: 'TypeError: terminated（Error: other side closed）',
    });
  });

  it('连不上：failed，没有状态码，error 是错误类型与消息', async () => {
    const t = setup({
      maxRetries: 0,
      handlers: [
        () => {
          throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED') });
        },
      ],
    });

    await t.round('你好');
    const [record] = await t.records();

    expect(record!.outcome).toBe('failed');
    expect(record!.response).toEqual({
      error: 'TypeError: fetch failed（Error: connect ECONNREFUSED）',
    });
  });
});

describe('拒收图片后的重发', () => {
  it('工具图片被拒（400）换占位重发：同一步两条，第二条请求体里是占位；步与 model.attempt 日志一致', async () => {
    const t = setup({
      tools: [snap],
      handlers: [
        sse(toolCall('snap', '{}'), chunk({}, 'tool_calls')),
        httpError(400, '{"error":{"message":"bad image"}}'),
        answer('看不清'),
      ],
    });

    await t.round('截个图');
    const records = await t.records(true);

    expect(labels(records).map(({ step, attempt, outcome }) => [step, attempt, outcome])).toEqual([
      [1, 1, 'completed'],
      [2, 1, 'failed'],
      [2, 2, 'completed'],
    ]);
    expect(attemptLogs(t.entries)).toEqual([1, 2, 2]);
    expect(records[1]!.response).toEqual({
      status: 400,
      error: '{"error":{"message":"bad image"}}',
    });
    expect(JSON.stringify(records[2]!.body)).toContain('[图片无法读取]');
    expect(records.map((record) => JSON.stringify(record.body))).toEqual(t.server.bodies);
    const [call] = await t.store.calls();
    expect(call!.attempts).toBe(3);
  });

  it('用户图片被拒后另起一次调用：两条，都是第 1 步，尝试 1、2', async () => {
    const t = setup({
      handlers: [httpError(400, '{"error":{"message":"bad image"}}'), answer('看不清')],
    });

    await t.round('看图', { files: [{ data: png(1), mediaType: 'image/png' }] });
    const records = await t.records(true);

    expect(labels(records).map(({ step, attempt, outcome }) => [step, attempt, outcome])).toEqual([
      [1, 1, 'failed'],
      [1, 2, 'completed'],
    ]);
    expect(attemptLogs(t.entries)).toEqual([1, 1]);
    expect(JSON.stringify(records[1]!.body)).toContain('[图片无法读取]');
    expect(records.map((record) => JSON.stringify(record.body))).toEqual(t.server.bodies);
    const [call] = await t.store.calls();
    expect(call!.attempts).toBe(2);
  });
});

describe('中止与超时', () => {
  it('生成中途用户中止：aborted，带半截', async () => {
    const t = setup({
      handlers: [
        streaming([sseText([chunk({ role: 'assistant', content: '说到一半' })], false), 'hang']),
      ],
    });
    const controller = new AbortController();
    await t.conversation.append({ author: alice, text: '你好' });

    for await (const part of t.conversation.reply({ abortSignal: controller.signal })) {
      if (part.type === 'text-delta') controller.abort();
    }
    await t.recorder.flush();
    const [record] = await t.records();

    expect(record!.outcome).toBe('aborted');
    expect(record!.response).toEqual({ status: 200, text: '说到一半' });
  });

  it('响应头之后迟迟没有内容（首段超时）：failed，error 写明是首段超时', async () => {
    const t = setup({
      timeouts: { firstChunkMs: 50 },
      handlers: [streaming(['hang'])],
    });

    await t.round('你好');
    const [record] = await t.records();

    expect(record!.outcome).toBe('failed');
    expect(record!.response).toEqual({
      status: 200,
      error: '等待模型输出超时：0.05 秒内没有收到第一段输出',
    });
  });

  it('服务端迟迟不回响应头（首段超时）：failed，没有状态码', async () => {
    const t = setup({
      timeouts: { firstChunkMs: 50 },
      handlers: [
        ({ signal }) =>
          new Promise<Response>((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
      ],
    });

    await t.round('你好');
    const [record] = await t.records();

    expect(record!.outcome).toBe('failed');
    expect(record!.response).toEqual({ error: '等待模型输出超时：0.05 秒内没有收到第一段输出' });
  });

  it('输出到一半停住（段间超时）：failed，带半截，error 写明是段间超时', async () => {
    const t = setup({
      timeouts: { chunkMs: 50 },
      handlers: [
        streaming([sseText([chunk({ role: 'assistant', content: '一半' })], false), 'hang']),
      ],
    });

    await t.round('你好');
    const [record] = await t.records();

    expect(record!.outcome).toBe('failed');
    expect(record!.response).toEqual({
      status: 200,
      text: '一半',
      error: '等待模型输出超时：两段输出之间超过 0.05 秒',
    });
  });
});

describe('断在半个 SSE 事件上', () => {
  // 一个完整的事件，再加半个事件（没有换行）：真实网络里读到的一段字节常在事件中间截断
  const halfEvent = 'data: {"id":"x","cho';
  const firstEvent = sseText([chunk({ role: 'assistant', content: '半' })], false);

  it('用户中止：aborted，半截文字照常整理，半个事件不当成解析不了的数据', async () => {
    const t = setup({ handlers: [streaming([firstEvent, halfEvent, 'hang'])] });
    const controller = new AbortController();
    await t.conversation.append({ author: alice, text: '你好' });

    for await (const part of t.conversation.reply({ abortSignal: controller.signal })) {
      if (part.type === 'text-delta') controller.abort();
    }
    await t.recorder.flush();
    const [record] = await t.records();

    expect(record!.outcome).toBe('aborted');
    expect(record!.response).toEqual({ status: 200, text: '半' });
  });

  it('段间超时：failed，error 写明段间超时', async () => {
    const t = setup({
      timeouts: { chunkMs: 50 },
      handlers: [streaming([firstEvent, halfEvent, 'hang'])],
    });

    await t.round('你好');
    const [record] = await t.records();

    expect(record!.outcome).toBe('failed');
    expect(record!.response).toEqual({
      status: 200,
      text: '半',
      error: '等待模型输出超时：两段输出之间超过 0.05 秒',
    });
  });

  it('连接断开：failed，error 是错误类型与消息', async () => {
    const t = setup({
      maxRetries: 0,
      handlers: [
        () => {
          const parts = [firstEvent, halfEvent];
          const body = new ReadableStream<Uint8Array>({
            pull(controller) {
              const next = parts.shift();
              if (next === undefined) {
                controller.error(
                  new TypeError('terminated', { cause: new Error('other side closed') }),
                );
                return;
              }
              controller.enqueue(new TextEncoder().encode(next));
            },
          });
          return new Response(body, { headers: sseHeaders });
        },
      ],
    });

    await t.round('你好');
    const [record] = await t.records();

    expect(record!.outcome).toBe('failed');
    expect(record!.response).toEqual({
      status: 200,
      text: '半',
      error: 'TypeError: terminated（Error: other side closed）',
    });
  });
});

describe('流式请求没有正常结束的响应', () => {
  const plainJson = JSON.stringify({
    id: 'x',
    object: 'chat.completion',
    choices: [
      { index: 0, message: { role: 'assistant', content: '非流式' }, finish_reason: 'stop' },
    ],
    usage: { prompt_tokens: 3, completion_tokens: 2 },
  });
  const respond =
    (body: string, contentType: string): Handler =>
    () =>
      new Response(body, { headers: { 'content-type': contentType } });

  it('200 加非流式的 JSON：failed，注明非流式响应与 content-type，字段照常整理；与 model.attempt 一致', async () => {
    const t = setup({ handlers: [respond(plainJson, 'application/json'), answer('好')] });

    await t.round('你好');
    const records = await t.records();

    expect(labels(records).map(({ step, attempt, outcome }) => [step, attempt, outcome])).toEqual([
      [1, 1, 'failed'],
      [1, 2, 'completed'],
    ]);
    expect(records[0]!.response).toEqual({
      status: 200,
      text: '非流式',
      finishReason: 'stop',
      usage: { input: 3, output: 2 },
      error: '服务端返回了非流式响应（content-type: application/json）',
    });
    expect(logsOf(t.entries, 'model.attempt').map((entry) => entry.fields.ok)).toEqual([
      false,
      true,
    ]);
    const [call] = await t.store.calls();
    expect(call!.attempts).toBe(2);
  });

  it('200 加 JSON 错误体：failed，error 是原文', async () => {
    const body = '{"error":{"message":"quota exceeded"}}';
    const t = setup({ maxRetries: 0, handlers: [respond(body, 'application/json')] });

    await t.round('你好');
    const [record] = await t.records();

    expect(record!.outcome).toBe('failed');
    expect(record!.response).toEqual({ status: 200, error: body });
  });

  it('200 加不是 JSON 的页面：failed，注明非流式响应并带原文', async () => {
    const t = setup({ maxRetries: 0, handlers: [respond('<html>维护中</html>', 'text/html')] });

    await t.round('你好');
    const [record] = await t.records();

    expect(record!.response).toEqual({
      status: 200,
      error: '服务端返回了非流式响应（content-type: text/html）：<html>维护中</html>',
    });
  });

  it('有内容却没有结束原因：failed，半截照常整理', async () => {
    const t = setup({
      maxRetries: 0,
      handlers: [sse(chunk({ role: 'assistant', content: '没说完' }))],
    });

    await t.round('你好');
    const [record] = await t.records();

    expect(record!.outcome).toBe('failed');
    expect(record!.response).toEqual({
      status: 200,
      text: '没说完',
      error: '响应流结束时没有结束原因',
    });
  });

  it('SSE 的 content-type 写错（与 SDK 一样照 SSE 解析）：completed', async () => {
    const t = setup({
      handlers: [
        respond(
          sseText([chunk({ role: 'assistant', content: '好' }), chunk({}, 'stop')]),
          'application/json',
        ),
      ],
    });

    await t.round('你好');
    const [record] = await t.records();

    expect(record!.outcome).toBe('completed');
    expect(record!.response).toEqual({ status: 200, text: '好', finishReason: 'stop' });
  });
});

describe('摘要请求', () => {
  it('purpose 为 summary，没有回复 id 与步', async () => {
    const t = setup({
      segments: { idleMs: 30 },
      handlers: [answer('好的'), answer('Alice 打了招呼。')],
    });

    await t.round('早上好');
    await until(() => logsOf(t.entries, 'summary.end').length > 0);
    await t.recorder.flush();
    const records = await t.records();

    expect(records).toHaveLength(2);
    const summary = records[1]!;
    expect(summary).toMatchObject({ purpose: 'summary', attempt: 1, outcome: 'completed' });
    expect(summary).not.toHaveProperty('replyId', expect.anything());
    expect(summary.replyId).toBeUndefined();
    expect(summary.step).toBeUndefined();
    expect(summary.response.text).toBe('Alice 打了招呼。');
    expect(JSON.stringify(summary.body)).toBe(t.server.bodies[1]);
  });
});

describe('图片', () => {
  it('用户发的图：库里存 luoli-file 引用，embedImages 时与发出的请求体一字不差', async () => {
    const t = setup({ handlers: [answer('一张图')] });
    const image = png(3);

    await t.round('看图', { files: [{ data: image, mediaType: 'image/png' }] });
    const [plain] = await t.records();
    const [embedded] = await t.records(true);

    const sent = t.server.bodies[0]!;
    expect(sent).toContain(`data:image/png;base64,${base64(image)}`);
    expect(JSON.stringify(plain!.body)).not.toContain(base64(image));
    expect(JSON.stringify(plain!.body)).toContain(
      `luoli-file:${(t.fileStore as ReturnType<typeof createMemoryFileStore>).names()[0]}`,
    );
    expect(JSON.stringify(embedded!.body)).toBe(sent);
  });
});

describe('记录不影响回复', () => {
  it('写入出错：回复照常完成，有一条 warn 日志，只有错误类型', async () => {
    const t = setup({
      handlers: [answer('好的')],
      log: {
        record: async () => {
          throw new Error('磁盘满了，正文：机密');
        },
      },
    });

    const chunks = await t.round('你好');

    expect(chunks.filter((part) => part.type === 'text-delta').map((part) => part.delta)).toEqual([
      '好的',
    ]);
    expect(chunks.some((part) => part.type === 'error')).toBe(false);
    const warnings = logsOf(t.entries, 'requests.write_failed');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ level: 'warn', fields: { errorType: 'Error' } });
    expect(JSON.stringify(warnings[0])).not.toContain('机密');
  });

  it('打开与关闭记录时：服务端收到的请求体逐字相同，回复的 UI 流相同', async () => {
    const run = async (record: boolean) => {
      const t = setup({
        record,
        tools: [dice],
        handlers: [
          httpError(429, '{"error":{"message":"slow down"}}'),
          sse(toolCall('dice', '{}'), chunk({}, 'tool_calls')),
          streaming([
            sseText([chunk({ role: 'assistant', content: '半' })], false),
            'data: {"error":{"message":"x"}}\n\n',
          ]),
          answer('四'),
        ],
      });
      const chunks = await t.round('掷骰子');
      const replyId = (await t.store.list()).find((message) => message.role === 'assistant')!.id;
      // 回复 id、时间、SDK 生成的文字段 id 每次不同，换成固定的再比较
      const ui = JSON.stringify(chunks)
        .replaceAll(replyId, 'R')
        .replace(/"createdAt":"[^"]+"/g, '"createdAt":"T"')
        .replace(/aitxt-\w+/g, 'aitxt-X');
      return { bodies: t.server.bodies, ui, records: (await t.records()).length };
    };

    const on = await run(true);
    const off = await run(false);

    expect(on.records).toBe(4);
    expect(off.records).toBe(0);
    expect(on.bodies).toEqual(off.bodies);
    expect(on.ui).toBe(off.ui);
  });

  it('没有带说明的请求照常发出，不记', async () => {
    const t = setup({ handlers: [answer('直接调')] });

    const response = await t.recorder.fetch('http://fake.test/v1/chat/completions', {
      method: 'POST',
      body: '{"model":"m","messages":[]}',
    });
    await response.text();
    await t.recorder.flush();

    expect(t.server.bodies).toEqual(['{"model":"m","messages":[]}']);
    expect(await t.records()).toEqual([]);
  });
});

describe('记录器本身', () => {
  const context = (fields: Partial<RequestContext> = {}): RequestContext => ({
    conversationId: 'c1',
    purpose: 'reply',
    replyId: 'r1',
    step: 1,
    attempt: 1,
    aborted: () => undefined,
    ...fields,
  });

  function recorderWith(handler: Handler) {
    const { logger, entries } = recordingLogger();
    const log = openRequestLog({
      path: ':memory:',
      fileStore: createMemoryFileStore(),
      retentionDays: 0,
    });
    opened.push(log);
    const server = fakeServer(handler);
    const recorder = createRequestRecorder({ log, logger, secrets: [apiKey], fetch: server.fetch });
    const send = (fields?: Partial<RequestContext>, signal?: AbortSignal) =>
      withRequestContext(context(fields), () =>
        recorder.fetch('http://fake.test/v1/chat/completions', {
          method: 'POST',
          body: '{"model":"m","messages":[]}',
          signal,
        }),
      );
    const records = async () => {
      await recorder.flush();
      return log.list();
    };
    return { send, records, entries };
  }

  it('没有中止时 SDK 取消读取：aborted，注明读取被提前取消，带已读到的部分', async () => {
    const t = recorderWith(streaming([sseText([chunk({ content: '前半' })], false), 'hang']));

    const response = await t.send();
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    const [record] = await t.records();

    expect(record!.outcome).toBe('aborted');
    expect(record!.response).toEqual({ status: 200, text: '前半', error: '读取被提前取消' });
  });

  it('中止后没人再读响应体：中止时就落一条记录', async () => {
    const t = recorderWith(streaming([sseText([chunk({ content: '开头' })], false), 'hang']));
    const controller = new AbortController();

    const response = await t.send({ aborted: () => ({ outcome: 'aborted' }) }, controller.signal);
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort();
    const [record] = await t.records();

    expect(record!.outcome).toBe('aborted');
    expect(record!.response).toEqual({ status: 200, text: '开头' });
  });

  it('非流式的 JSON 响应照同样的字段整理；响应原样交给调用方', async () => {
    const json = JSON.stringify({
      id: 'x',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: '你好',
            reasoning_content: '想',
            tool_calls: [
              { id: 't1', type: 'function', function: { name: 'dice', arguments: '{}' } },
            ],
          },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 4 },
    });
    const t = recorderWith(
      () => new Response(json, { headers: { 'content-type': 'application/json' } }),
    );

    const response = await t.send();
    expect(await response.text()).toBe(json);
    expect(response.headers.get('content-type')).toBe('application/json');
    const [record] = await t.records();

    expect(record!.outcome).toBe('completed');
    expect(record!.response).toEqual({
      status: 200,
      text: '你好',
      reasoning: '想',
      toolCalls: [{ id: 't1', name: 'dice', arguments: '{}' }],
      finishReason: 'stop',
      usage: { input: 3, output: 4 },
    });
  });

  it('很长的错误体截到 64 KB 并注明；调用方读到完整的', async () => {
    const body = 'x'.repeat(70_000);
    const t = recorderWith(() => new Response(body, { status: 500 }));

    const response = await t.send();
    expect(await response.text()).toBe(body);
    const [record] = await t.records();

    expect(record!.response.status).toBe(500);
    expect(record!.response.error).toBe(`${'x'.repeat(64 * 1024)}…（已截断，共 70000 字符）`);
  });

  it('key 正好跨在截断处：先抹掉再截，不留前半截', async () => {
    const body = `${'x'.repeat(64 * 1024 - 5)}${apiKey}${'y'.repeat(10_000)}`;
    const t = recorderWith(() => new Response(body, { status: 500 }));

    await (await t.send()).text();
    const [record] = await t.records();

    expect(record!.response.error).toBe(
      `${'x'.repeat(64 * 1024 - 5)}***yy…（已截断，共 ${body.length} 字符）`,
    );
  });

  it('记录器内部出错：调用方照常读完，只记一条 warn，这次请求不写', async () => {
    const t = recorderWith(answer('好'));

    const response = await t.send({
      aborted: () => {
        throw new Error('内部出错');
      },
    });
    const text = await response.text();
    const records = await t.records();

    expect(text).toContain('"content":"好"');
    expect(records).toEqual([]);
    expect(logsOf(t.entries, 'requests.capture_failed')).toEqual([
      {
        level: 'warn',
        msg: 'requests.capture_failed',
        fields: { conversationId: 'c1', replyId: 'r1', errorType: 'Error' },
      },
    ]);
  });

  it('中途结束时已收全的 data 行照常整理（事件还没有空行结尾）', async () => {
    const t = recorderWith(
      streaming([`data: ${JSON.stringify(chunk({ content: '甲' }))}\n`, 'data: {"cho', 'hang']),
    );
    const controller = new AbortController();

    const response = await t.send({ aborted: () => ({ outcome: 'aborted' }) }, controller.signal);
    const reader = response.body!.getReader();
    await reader.read();
    await reader.read();
    controller.abort();
    const [record] = await t.records();

    expect(record!.outcome).toBe('aborted');
    expect(record!.response).toEqual({ status: 200, text: '甲' });
  });

  it('SSE 的行可能在任意位置断开（含 \\r\\n 之间）', async () => {
    const text = sseText([chunk({ content: '甲乙' }), chunk({ content: '丙' }, 'stop')]).replaceAll(
      '\n',
      '\r\n',
    );
    const bytes = new TextEncoder().encode(text);
    // 每 3 个字节一段：中文字符与 \r\n 都会被切开
    const pieces: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i += 3) pieces.push(bytes.slice(i, i + 3));
    const t = recorderWith(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              const next = pieces.shift();
              if (next) controller.enqueue(next);
              else controller.close();
            },
          }),
          { headers: sseHeaders },
        ),
    );

    await (await t.send()).text();
    const [record] = await t.records();

    expect(record!.response).toEqual({ status: 200, text: '甲乙丙', finishReason: 'stop' });
  });
});
