import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APICallError, generateId, simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createConversation,
  createMemoryStore,
  defineTool,
  installTools,
  openSqliteStorage,
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
type Part = Message['parts'][number];

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

// ---- 模型的输出 ----

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

function finish(reason: 'stop' | 'tool-calls'): StreamPart {
  return { type: 'finish', finishReason: { unified: reason, raw: undefined }, usage };
}

function text(...deltas: string[]): StreamPart[] {
  return [
    { type: 'text-start', id: 't' },
    ...deltas.map((delta): StreamPart => ({ type: 'text-delta', id: 't', delta })),
    { type: 'text-end', id: 't' },
  ];
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
const answer = (...deltas: string[]): StreamPart[] => [...text(...deltas), finish('stop')];

type Attempt =
  StreamPart[] | Error | ((abortSignal: AbortSignal | undefined) => ReadableStream<StreamPart>);

/** 依次处理每次请求：段数组原样输出；Error 则请求失败；函数则由它给出流。用完后回答「好」 */
function scriptedModel(...attempts: Attempt[]): MockLanguageModelV4 {
  let index = 0;
  return new MockLanguageModelV4({
    doStream: async ({ abortSignal }) => {
      const next = attempts[index++] ?? answer('好');
      if (next instanceof Error) throw next;
      if (typeof next === 'function') return { stream: next(abortSignal) };
      return { stream: simulateReadableStream({ chunks: next }) };
    },
  });
}

/** 给出这些段后挂起，直到请求被中止 */
function hanging(parts: StreamPart[]) {
  return (signal: AbortSignal | undefined) =>
    new ReadableStream<StreamPart>({
      start(controller) {
        for (const part of parts) controller.enqueue(part);
        signal?.addEventListener(
          'abort',
          () => controller.error(new DOMException('This operation was aborted', 'AbortError')),
          { once: true },
        );
      },
    });
}

/** 给出这些段后读流抛错（连接中途断开） */
function dropsAfter(parts: StreamPart[]) {
  return () =>
    new ReadableStream<StreamPart>({
      start(controller) {
        for (const part of parts) controller.enqueue(part);
        controller.error(new Error('连接中途断开'));
      },
    });
}

function serverError(): APICallError {
  return new APICallError({
    message: 'HTTP 500',
    url: 'http://mock.test/v1/chat/completions',
    requestBodyValues: {},
    statusCode: 500,
    responseHeaders: { 'retry-after-ms': '0' },
  });
}

// ---- 请求与结果 ----

/** 第 index 次请求的消息（不含 system），每条写成一行 */
function messagesOf(model: MockLanguageModelV4, index: number): string[] {
  const request = model.doStreamCalls[index];
  if (!request) throw new Error(`没有第 ${index} 次请求`);
  return request.prompt
    .filter((message) => message.role !== 'system')
    .map((message) => {
      const content =
        typeof message.content === 'string'
          ? message.content
          : message.content
              .map((part) => {
                if (part.type === 'text') return part.text;
                if (part.type === 'reasoning') return `<reasoning ${part.text}>`;
                if (part.type === 'tool-call') {
                  return `<call ${part.toolName} ${JSON.stringify(part.input)}>`;
                }
                if (part.type === 'tool-result') {
                  return `<result ${part.toolName} ${JSON.stringify(part.output)}>`;
                }
                return `<${part.type}>`;
              })
              .join('');
      return `${message.role}: ${content}`;
    });
}

/** 第 index 次请求里各工具结果交给模型的内容，按 toolCallId */
function toolResultsOf(model: MockLanguageModelV4, index: number): Record<string, unknown> {
  return Object.fromEntries(
    (model.doStreamCalls[index]?.prompt ?? []).flatMap((message) =>
      message.role === 'tool'
        ? message.content.flatMap((part) =>
            part.type === 'tool-result' ? [[part.toolCallId, part.output]] : [],
          )
        : [],
    ),
  );
}

async function readAll(stream: ReadableStream<MessageChunk>): Promise<MessageChunk[]> {
  const chunks: MessageChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

/** 读回复流，读到满足 until 的段时中止 */
async function readUntilAbort(
  stream: ReadableStream<MessageChunk>,
  controller: AbortController,
  until: (chunk: MessageChunk) => boolean,
): Promise<MessageChunk[]> {
  const chunks: MessageChunk[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
    if (until(chunk)) controller.abort();
  }
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

/** 历史里的一条助手消息，直接写进存储 */
function assistant(parts: Part[], metadata: Partial<Message['metadata']> = {}): Message {
  return {
    id: generateId(),
    role: 'assistant',
    metadata: { createdAt: new Date().toISOString(), ...metadata },
    parts,
  };
}

/** 已执行完的工具段 */
function done(tool: string, id: string, input: unknown, output: unknown): Part {
  return { type: `tool-${tool}`, toolCallId: id, state: 'output-available', input, output };
}

function setup({
  model,
  definitions = [],
  store = createMemoryStore(),
  ...options
}: {
  model: MockLanguageModelV4;
  definitions?: ToolDefinition[];
  store?: ConversationStore;
} & Omit<Parameters<typeof createConversation>[0], 'model' | 'prompts' | 'tools' | 'store'>) {
  const { logger, entries } = recordingLogger();
  const conversation = createConversation({
    model,
    prompts,
    logger,
    store,
    tools: installTools(definitions, {}).tools,
    ...options,
  });
  opened.push(conversation);
  const round = async (userText: string, abortSignal?: AbortSignal) => {
    await conversation.append({ author: alice, text: userText });
    return readAll(conversation.reply({ abortSignal }));
  };
  return { conversation, store, entries, round };
}

// ---- 测试用的工具 ----

const empty = z.object({});
const tool = (name: string, history?: ToolDefinition['history']) =>
  defineTool({ name, description: name, input: empty, history, execute: () => 'ok' });

describe('以后的回复里的呈现', () => {
  const long = 'x'.repeat(2500);
  const custom = defineTool({
    name: 'custom',
    description: '自定义呈现',
    input: z.object({ q: z.string() }),
    history: ({ input, output }) => `${input.q} 共 ${output.items.length} 条`,
    execute: () => ({ items: [1, 2, 3] }),
  });

  it('按声明呈现：full 原样、omit 换成说明、maxChars 超过才截短、函数的返回值、没声明与不在清单里的按默认 2000', async () => {
    const store = createMemoryStore();
    const model = scriptedModel();
    const { conversation } = setup({
      model,
      store,
      definitions: [
        tool('full', 'full'),
        tool('omit', 'omit'),
        tool('short', { maxChars: 10 }),
        custom,
        tool('plain'),
      ],
    });
    await conversation.append({ author: alice, text: '查' });
    await store.add(
      assistant([
        { type: 'step-start' },
        done('full', 'c1', {}, long),
        done('omit', 'c2', {}, { secret: 1 }),
        done('short', 'c3', {}, { value: '0123456789abc' }),
        done('short', 'c4', {}, '0123456789'),
        done('custom', 'c5', { q: '书' }, { items: [1, 2, 3] }),
        done('plain', 'c6', {}, long),
        done('plain', 'c7', {}, 'ok'),
        done('gone', 'c8', {}, long),
        { type: 'step-start' },
        { type: 'text', text: '查到了', state: 'done' },
      ]),
    );
    await conversation.append({ author: alice, text: '再说说' });
    const stored = await conversation.messages();

    await readAll(conversation.reply());

    const note = (n: number) => `…（已截短，原文 ${n} 字符）`;
    expect(toolResultsOf(model, 0)).toEqual({
      c1: { type: 'text', value: long },
      c2: { type: 'text', value: '（结果已省略）' },
      // {"value":"0123456789abc"} 共 25 字符，截成前 10 个
      c3: { type: 'text', value: `{"value":"${note(25)}` },
      c4: { type: 'text', value: '0123456789' },
      c5: { type: 'text', value: '书 共 3 条' },
      c6: { type: 'text', value: `${'x'.repeat(2000)}${note(2500)}` },
      c7: { type: 'text', value: 'ok' },
      c8: { type: 'text', value: `${'x'.repeat(2000)}${note(2500)}` },
    });
    // 参数照常发出；存储不变
    expect(messagesOf(model, 0)[1]).toContain('<call custom {"q":"书"}>');
    expect((await conversation.messages()).slice(0, 3)).toEqual(stored);
  });

  it('默认上限可配置；没截短的 JSON 结果原样作为 JSON 发出', async () => {
    const store = createMemoryStore();
    const model = scriptedModel();
    const { conversation } = setup({
      model,
      store,
      definitions: [tool('plain')],
      toolHistoryChars: 12,
    });
    await conversation.append({ author: alice, text: '查' });
    await store.add(
      assistant([
        { type: 'step-start' },
        done('plain', 'c1', {}, { a: 1 }),
        done('plain', 'c2', {}, 'abcdefghijklmn'),
        { type: 'step-start' },
        { type: 'text', text: '好', state: 'done' },
      ]),
    );

    await readAll(conversation.reply());

    expect(toolResultsOf(model, 0)).toEqual({
      c1: { type: 'json', value: { a: 1 } },
      c2: { type: 'text', value: 'abcdefghijkl…（已截短，原文 14 字符）' },
    });
  });

  it('呈现函数抛错或返回值转不了 JSON：按默认处理，记一条 warn，只有工具名与错误类型；同一个调用只记一次', async () => {
    const store = createMemoryStore();
    const model = scriptedModel();
    const throws = tool('throws', () => {
      throw new Error('呈现出错-机密-4a1f');
    });
    const bigint = tool('bigint', () => 1n);
    const { conversation, entries } = setup({
      model,
      store,
      definitions: [throws, bigint],
      toolHistoryChars: 5,
    });
    await conversation.append({ author: alice, text: '查' });
    await store.add(
      assistant([
        { type: 'step-start' },
        done('throws', 'c1', {}, '结果内容-机密-9b2e'),
        done('bigint', 'c2', {}, 'abc'),
        { type: 'step-start' },
        { type: 'text', text: '好', state: 'done' },
      ]),
    );

    await readAll(conversation.reply());
    // 同一段历史再送一次模型：同一个调用不再记日志
    await conversation.append({ author: alice, text: '再说说' });
    await readAll(conversation.reply());

    expect(toolResultsOf(model, 0)).toEqual({
      c1: { type: 'text', value: '结果内容-…（已截短，原文 12 字符）' },
      c2: { type: 'text', value: 'abc' },
    });
    expect(toolResultsOf(model, 1)).toEqual(toolResultsOf(model, 0));
    expect(logsOf(entries, 'tool.history_failed').map((e) => [e.level, e.fields])).toEqual([
      ['warn', expect.objectContaining({ tool: 'throws', errorType: 'Error' })],
      ['warn', expect.objectContaining({ tool: 'bigint', errorType: 'TypeError' })],
    ]);
    const all = JSON.stringify(entries);
    expect(all).not.toContain('机密');
  });

  it('错误说明也按默认上限截短；截短不切开代理对', async () => {
    const store = createMemoryStore();
    const model = scriptedModel();
    const { conversation } = setup({
      model,
      store,
      definitions: [tool('emoji'), tool('fails')],
      toolHistoryChars: 3,
    });
    await conversation.append({ author: alice, text: '查' });
    await store.add(
      assistant([
        { type: 'step-start' },
        done('emoji', 'c1', {}, 'ab😀cd'),
        done('emoji', 'c2', {}, 'a😀bcd'),
        {
          type: 'tool-fails',
          toolCallId: 'c3',
          state: 'output-error',
          input: {},
          errorText: 'Error: 很长的错误说明',
        },
        {
          type: 'dynamic-tool',
          toolName: 'nope',
          toolCallId: 'c4',
          state: 'output-error',
          input: { q: '很长的参数' },
          errorText: 'AI_NoSuchToolError: 很长',
        },
        { type: 'step-start' },
        { type: 'text', text: '好', state: 'done' },
      ]),
    );

    await readAll(conversation.reply());

    expect(toolResultsOf(model, 0)).toEqual({
      // 第 3 个码元是 😀 的前一半：退到它之前
      c1: { type: 'text', value: 'ab…（已截短，原文 6 字符）' },
      c2: { type: 'text', value: 'a😀…（已截短，原文 6 字符）' },
      c3: { type: 'error-text', value: 'Err…（已截短，原文 14 字符）' },
      c4: { type: 'error-text', value: 'AI_…（已截短，原文 22 字符）' },
    });
  });

  it('当次回复的循环里是完整结果，下一次回复才按声明呈现；摘要看到的与以后的回复相同', async () => {
    const secret = defineTool({
      name: 'secret',
      description: '机密',
      input: empty,
      history: 'omit',
      execute: () => ({ code: 42 }),
    });
    const model = scriptedModel(
      calls(call('secret', {})),
      answer('是 42'),
      answer('刚才查过了'),
      answer('Alice 查了机密。'),
    );
    const { store, round } = setup({
      model,
      definitions: [secret],
      segments: { idleMs: 30 },
    });

    await round('查机密');
    await round('再说一次');
    vi.setSystemTime(Date.now() + 60_000);
    await until(async () => (await store.currentSegment()).startReason === 'idle');

    expect(toolResultsOf(model, 1)).toEqual({
      'call-secret': { type: 'json', value: { code: 42 } },
    });
    expect(toolResultsOf(model, 2)).toEqual({
      'call-secret': { type: 'text', value: '（结果已省略）' },
    });
    // 摘要请求：同样的历史，同样的呈现
    expect(toolResultsOf(model, 3)).toEqual(toolResultsOf(model, 2));
    expect(messagesOf(model, 3).slice(0, 4)).toEqual(messagesOf(model, 2).slice(0, 4));
  });

  it('同一段历史两次送模型，请求逐字相同', async () => {
    const model = scriptedModel(
      calls(call('custom', { q: '书' }), call('plain', {}, 'c2')),
      answer('三条'),
      answer('好'),
      answer('好'),
    );
    const plain = defineTool({
      name: 'plain',
      description: 'plain',
      input: empty,
      execute: () => 'y'.repeat(3000),
    });
    const { round } = setup({ model, definitions: [custom, plain] });

    await round('查');
    await round('一');
    await round('二');

    // 第 3 次请求的消息是第 4 次请求的前缀
    const third = model.doStreamCalls[2]!.prompt;
    const fourth = model.doStreamCalls[3]!.prompt;
    expect(fourth.slice(0, third.length)).toEqual(third);
    expect(toolResultsOf(model, 2)).toEqual(toolResultsOf(model, 3));
  });
});

describe('没有结果的工具段', () => {
  it('历史里的旧消息有参数没结果（input-available）：送模型时当作「工具调用未完成」；参数还没收全的丢掉；请求正常', async () => {
    const store = createMemoryStore();
    const model = scriptedModel();
    const { conversation, round } = setup({ model, store, definitions: [tool('plain')] });
    await conversation.append({ author: alice, text: '查' });
    await store.add(
      assistant([
        { type: 'step-start' },
        { type: 'text', text: '我查一下', state: 'done' },
        { type: 'tool-plain', toolCallId: 'c1', state: 'input-available', input: {} },
        { type: 'tool-plain', toolCallId: 'c2', state: 'input-streaming', input: undefined },
      ]),
    );

    const chunks = await round('然后呢');

    expect(chunks.some((chunk) => chunk.type === 'error')).toBe(false);
    expect(messagesOf(model, 0).slice(1, 3)).toEqual([
      'assistant: 我查一下<call plain {}>',
      'tool: <result plain {"type":"error-text","value":"工具调用未完成"}>',
    ]);
  });
});

describe('送模型时的标记', () => {
  async function markedRequest(parts: Part[], metadata: Partial<Message['metadata']>) {
    const store = createMemoryStore();
    const model = scriptedModel();
    const { conversation, round } = setup({ model, store, definitions: [tool('plain')] });
    await conversation.append({ author: alice, text: '查' });
    await store.add(assistant(parts, metadata));
    await round('然后呢');
    return messagesOf(model, 0).slice(1, -1);
  }

  it('出错中断、最后是工具段：在末尾另起一步，模型看到工具结果之后的一条助手消息', async () => {
    expect(
      await markedRequest([{ type: 'step-start' }, done('plain', 'c1', {}, 'ok')], {
        failed: true,
      }),
    ).toEqual([
      'assistant: <call plain {}>',
      'tool: <result plain {"type":"text","value":"ok"}>',
      'assistant: （回复出错中断）',
    ]);
  });

  it('最后是文字：接在它后面；最后是推理：在同一条消息末尾加一个文字段', async () => {
    const parts: Part[] = [
      { type: 'step-start' },
      done('plain', 'c1', {}, 'ok'),
      { type: 'step-start' },
      { type: 'text', text: '说到一半', state: 'done' },
    ];
    expect(await markedRequest(parts, { failed: true })).toEqual([
      'assistant: <call plain {}>',
      'tool: <result plain {"type":"text","value":"ok"}>',
      'assistant: 说到一半\n（回复出错中断）',
    ]);
    expect(
      await markedRequest(
        [
          { type: 'step-start' },
          { type: 'text', text: '先说', state: 'done' },
          { type: 'reasoning', text: '想', state: 'done' },
        ],
        { aborted: true },
      ),
    ).toEqual(['assistant: 先说<reasoning 想>（回复被中止）']);
  });
});

describe('中途结束时写入已完成的部分', () => {
  const dice = defineTool({
    name: 'dice',
    description: '掷骰子',
    input: z.object({ sides: z.number() }),
    execute: ({ sides }) => ({ value: sides - 2 }),
  });

  it('第 2 步请求失败（重试用完）：只写入第 1 步，标记 failed、没有用量；reply.failed 有 saved；下一次请求末尾是「（回复出错中断）」', async () => {
    const model = scriptedModel(
      calls(text('我掷一下'), call('dice', { sides: 6 })),
      serverError(),
      serverError(),
      answer('刚才出错了'),
    );
    const { conversation, store, entries, round } = setup({
      model,
      definitions: [dice],
      maxRetries: 1,
    });

    const chunks = await round('掷');

    expect(chunks.some((chunk) => chunk.type === 'error')).toBe(true);
    const reply = (await conversation.messages())[1];
    expect(reply?.role).toBe('assistant');
    expect(reply?.parts).toEqual([
      { type: 'step-start' },
      { type: 'text', text: '我掷一下', state: 'done' },
      {
        type: 'tool-dice',
        toolCallId: 'call-dice',
        state: 'output-available',
        input: { sides: 6 },
        output: { value: 4 },
      },
    ]);
    expect(reply?.metadata).toMatchObject({ failed: true });
    expect(reply?.metadata).not.toHaveProperty('usage');
    expect(reply?.metadata).not.toHaveProperty('aborted');
    expect(logsOf(entries, 'reply.failed')[0]?.fields).toMatchObject({
      saved: true,
      steps: 2,
      toolCalls: 1,
      error: { statusCode: 500 },
    });
    expect((await store.calls()).map((row) => row.outcome)).toEqual(['failed']);

    await round('怎么了');
    expect(messagesOf(model, 3).slice(1, 4)).toEqual([
      'assistant: 我掷一下<call dice {"sides":6}>',
      'tool: <result dice {"type":"json","value":{"value":4}}>',
      'assistant: （回复出错中断）',
    ]);
  });

  it('第 2 步输出了半截文字后连接断开：半截不写，只写第 1 步', async () => {
    const model = scriptedModel(
      calls(call('dice', { sides: 6 })),
      dropsAfter(text('结果是').slice(0, -1)),
    );
    const { conversation, entries, round } = setup({ model, definitions: [dice] });

    await round('掷');

    const reply = (await conversation.messages())[1];
    expect(reply?.metadata?.failed).toBe(true);
    expect(reply?.parts.map((part) => part.type)).toEqual(['step-start', 'tool-dice']);
    expect(JSON.stringify(reply)).not.toContain('结果是');
    expect(logsOf(entries, 'reply.failed')[0]?.fields).toMatchObject({ saved: true });
  });

  it('拒收图片后换成占位重试、第 1 步完成、第 2 步失败：写入第 1 步，图片的标记照写，之后的请求用占位', async () => {
    const rejected = new APICallError({
      message: 'HTTP 400',
      url: 'http://mock.test/v1/chat/completions',
      requestBodyValues: {},
      statusCode: 400,
    });
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
    const model = scriptedModel(rejected, calls(call('dice', { sides: 6 })), serverError());
    const { conversation, entries, round } = setup({
      model,
      definitions: [dice],
      maxRetries: 0,
    });
    await conversation.append({ author: alice, files: [{ data: png, mediaType: 'image/png' }] });

    await readAll(conversation.reply());

    const [image, reply] = await conversation.messages();
    expect(reply?.metadata?.failed).toBe(true);
    expect(image?.metadata?.unreadableFiles).toHaveLength(1);
    expect(logsOf(entries, 'reply.failed')[0]?.fields).toMatchObject({
      saved: true,
      markedUnreadable: 1,
    });

    await round('怎么了');
    expect(messagesOf(model, 3)[0]).toContain('[图片无法读取]');
  });

  it('SQLite 存储：中止后写入的消息重新打开后接着回复，请求正常、标记照旧', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'luolicore-tool-history-'));
    try {
      const controller = new AbortController();
      const slow = defineTool({
        name: 'slow',
        description: '耗时',
        input: empty,
        execute: () => {
          setTimeout(() => controller.abort(), 10);
          return new Promise<never>(() => {});
        },
      });
      const first = openSqliteStorage(join(dir, 'luoli.db'));
      const id = await first.createConversation({ platform: 'cli' });
      const writer = setup({
        model: scriptedModel(calls(call('dice', { sides: 6 })), calls(call('slow', {}))),
        definitions: [dice, slow],
        store: await first.openConversation(id),
      });
      await writer.round('掷', controller.signal);
      await writer.conversation.close();
      first.close();

      const second = openSqliteStorage(join(dir, 'luoli.db'));
      try {
        const model = scriptedModel(answer('接着说'));
        const { conversation, round } = setup({
          model,
          definitions: [dice, slow],
          store: await second.openConversation(id),
        });
        const chunks = await round('然后呢');
        await conversation.close();

        expect(chunks.some((chunk) => chunk.type === 'error')).toBe(false);
        expect(messagesOf(model, 0).slice(1, 6)).toEqual([
          'assistant: <call dice {"sides":6}>',
          'tool: <result dice {"type":"json","value":{"value":4}}>',
          'assistant: <call slow {}>',
          'tool: <result slow {"type":"error-text","value":"工具调用未完成"}>',
          'assistant: （回复被中止）',
        ]);
      } finally {
        second.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('第 1 步就失败：不写入，reply.failed 的 saved 为 false', async () => {
    const model = scriptedModel(dropsAfter(text('半截').slice(0, -1)));
    const { conversation, entries, round } = setup({ model, definitions: [dice] });

    await round('掷');

    expect((await conversation.messages()).map((m) => m.role)).toEqual(['user']);
    expect(logsOf(entries, 'reply.failed')[0]?.fields).toMatchObject({ saved: false });
  });

  it('第 2 步执行工具时中止、没有文字：第 1 步的工具已执行完，照样写入；没完成的调用以「工具调用未完成」结束', async () => {
    const controller = new AbortController();
    const slow = defineTool({
      name: 'slow',
      description: '耗时',
      input: empty,
      execute: () => {
        setTimeout(() => controller.abort(), 10);
        return new Promise<never>(() => {});
      },
    });
    const model = scriptedModel(calls(call('dice', { sides: 6 })), calls(call('slow', {})));
    const { conversation, entries, round } = setup({ model, definitions: [dice, slow] });

    await round('掷', controller.signal);

    const reply = (await conversation.messages())[1];
    expect(reply?.metadata?.aborted).toBe(true);
    expect(reply?.parts).toMatchObject([
      { type: 'step-start' },
      { type: 'tool-dice', state: 'output-available' },
      { type: 'step-start' },
      { type: 'tool-slow', state: 'output-error', errorText: '工具调用未完成' },
    ]);
    expect(logsOf(entries, 'reply.end')[0]?.fields).toMatchObject({
      outcome: 'aborted',
      saved: true,
    });
  });

  it('第 1 步执行工具时中止、没有文字：工具已经开始执行，照样写入；它以「工具调用未完成」结束，下一次请求末尾另起一步是「（回复被中止）」', async () => {
    const controller = new AbortController();
    const slow = defineTool({
      name: 'slow',
      description: '耗时',
      input: empty,
      execute: () => {
        setTimeout(() => controller.abort(), 10);
        return new Promise<never>(() => {});
      },
    });
    const model = scriptedModel(calls(call('slow', {})), answer('接着说'));
    const { conversation, entries, round } = setup({ model, definitions: [slow] });

    await round('等等', controller.signal);

    const reply = (await conversation.messages())[1];
    expect(reply?.metadata?.aborted).toBe(true);
    expect(reply?.parts).toEqual([
      { type: 'step-start' },
      {
        type: 'tool-slow',
        toolCallId: 'call-slow',
        state: 'output-error',
        input: {},
        errorText: '工具调用未完成',
      },
    ]);
    expect(logsOf(entries, 'reply.end')[0]?.fields).toMatchObject({
      outcome: 'aborted',
      saved: true,
    });

    const next = await round('然后呢');
    expect(next.some((chunk) => chunk.type === 'error')).toBe(false);
    expect(messagesOf(model, 1).slice(1, 4)).toEqual([
      'assistant: <call slow {}>',
      'tool: <result slow {"type":"error-text","value":"工具调用未完成"}>',
      'assistant: （回复被中止）',
    ]);
  });

  it('模型还在输出工具参数时中止：参数没收全的调用不写入，文字照常写入，下一次请求里没有这次调用', async () => {
    const controller = new AbortController();
    const model = scriptedModel(
      hanging([...text('我查').slice(0, -1), ...call('dice', { sides: 6 }).slice(0, 2)]),
    );
    const { conversation, round } = setup({ model, definitions: [dice] });
    await conversation.append({ author: alice, text: '掷' });

    // 参数已经流出了一半；SDK 把工具段缓冲到这次请求结束，回复里还看不到它
    await readUntilAbort(
      conversation.reply({ abortSignal: controller.signal }),
      controller,
      (chunk) => chunk.type === 'text-delta',
    );

    const reply = (await conversation.messages())[1];
    expect(reply?.metadata?.aborted).toBe(true);
    expect(reply?.parts).toEqual([
      { type: 'step-start' },
      { type: 'text', text: '我查', state: 'done' },
    ]);
    await round('然后呢');
    expect(messagesOf(model, 1)[1]).toBe('assistant: 我查\n（回复被中止）');
  });

  it('执行过工具、最后没有文字：写入（empty、saved）；没执行过工具的空回复照旧不写', async () => {
    const model = scriptedModel(calls(call('dice', { sides: 6 })), answer(''), answer(''));
    const { conversation, store, entries, round } = setup({ model, definitions: [dice] });

    await round('掷');
    await round('再说');

    const messages = await conversation.messages();
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    // 第 2 步只有一个空的文字段：去掉，连同它的 step-start
    expect(messages[1]?.parts).toMatchObject([
      { type: 'step-start' },
      { type: 'tool-dice', state: 'output-available' },
    ]);
    expect(messages[1]?.parts).toHaveLength(2);
    expect(messages[1]?.metadata?.usage).toEqual({ input: 2, output: 2, total: 4 });
    expect(logsOf(entries, 'reply.end').map((e) => [e.fields.outcome, e.fields.saved])).toEqual([
      ['empty', true],
      ['empty', false],
    ]);
    expect((await store.calls()).map((row) => row.outcome)).toEqual(['empty', 'empty']);
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
