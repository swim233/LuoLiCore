import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APICallError } from 'ai';
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
  type MessageChunk,
  type SegmentOptions,
  type ToolCall,
  type ToolDefinition,
} from './index.js';
import { testPrompts } from './test-prompts.js';

type StreamResult = Awaited<ReturnType<MockLanguageModelV4['doStream']>>;
type StreamPart = StreamResult['stream'] extends ReadableStream<infer P> ? P : never;
type FinishPart = Extract<StreamPart, { type: 'finish' }>;

const alice = { id: 'u-alice', name: 'Alice' };
const prompts = testPrompts('你是测试助手');

// 只假冒 Date：首字延迟、开始时间是确定的，计时器照常走
const now = '2026-10-30T06:02:00.000Z';
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date(now) });
});
const opened: Conversation[] = [];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const conversation of opened.splice(0)) await conversation.close();
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.useRealTimers();
});

/** 把 Date 往后拨 */
function advance(ms: number): void {
  vi.setSystemTime(Date.now() + ms);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 用真实时间轮询，直到 check 成立 */
async function until(check: () => Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!(await check())) {
    if (performance.now() > deadline) throw new Error('等待超时');
    await sleep(5);
  }
}

// ---- 模型的输出 ----

function usageOf(input: number, output: number): FinishPart['usage'] {
  return {
    inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: output, text: output, reasoning: undefined },
  };
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

/** 这一步调用工具，用量为 usage */
const calls = (usage: FinishPart['usage'], ...parts: StreamPart[][]): StreamPart[] => [
  ...parts.flat(),
  { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage },
];
/** 这一步用文字回答，用量为 usage */
const answer = (content: string, usage = usageOf(1, 1)): StreamPart[] => [
  ...text(content),
  { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
];

type Turn =
  StreamPart[] | Error | { hang: StreamPart[] } | { before: () => void; parts: StreamPart[] };

/**
 * 依次处理每次请求：段数组原样输出；Error 则请求失败；{ hang } 输出后挂起到被中止；
 * { before } 先执行它（如拨 Date）再输出。用完后回答「好」
 */
function scripted(...turns: Turn[]): MockLanguageModelV4 {
  let index = 0;
  return new MockLanguageModelV4({
    doStream: async ({ abortSignal }) => {
      const turn = turns[index++] ?? answer('好');
      if (turn instanceof Error) throw turn;
      if ('before' in turn) turn.before();
      const parts = Array.isArray(turn) ? turn : 'hang' in turn ? turn.hang : turn.parts;
      return {
        stream: new ReadableStream<StreamPart>({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            if (!('hang' in turn)) return controller.close();
            abortSignal?.addEventListener(
              'abort',
              () => controller.error(new DOMException('aborted', 'AbortError')),
              { once: true },
            );
          },
        }),
      };
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

function setup({
  turns = [],
  model = scripted(...turns),
  definitions = [],
  store = createMemoryStore(),
  segments,
  maxRetries,
}: {
  turns?: Turn[];
  model?: MockLanguageModelV4;
  definitions?: ToolDefinition[];
  store?: ConversationStore;
  segments?: SegmentOptions;
  maxRetries?: number;
}) {
  const { logger, entries } = recordingLogger();
  const conversation = createConversation({
    model,
    prompts,
    store,
    logger,
    conversationId: 'c1',
    tools: installTools(definitions, {}).tools,
    segments,
    maxRetries,
  });
  opened.push(conversation);
  const round = async (content: string, abortSignal?: AbortSignal) => {
    await conversation.append({ author: alice, text: content });
    return readAll(conversation.reply({ abortSignal }));
  };
  return { conversation, model, store, entries, round };
}

// ---- 测试用的工具 ----

const empty = z.object({});
const dice = defineTool({
  name: 'dice',
  description: '掷骰子',
  input: z.object({ sides: z.number() }),
  execute: ({ sides }) => ({ value: sides - 2 }),
});

describe('模型调用表的步数与工具调用次数', () => {
  it('两步回复：steps 2，tool_calls 含参数不合结构的调用；没有工具的回复为 1 与 0', async () => {
    const { store, round } = setup({
      definitions: [dice],
      turns: [
        calls(usageOf(1, 1), call('dice', { sides: 6 }, 'c1'), call('dice', { sides: 'x' }, 'c2')),
        answer('掷出了 4'),
        answer('好'),
      ],
    });

    await round('掷');
    await round('谢谢');

    expect((await store.calls()).map((row) => [row.outcome, row.steps, row.toolCalls])).toEqual([
      ['completed', 2, 2],
      ['completed', 1, 0],
    ]);
  });

  it('失败、中止的回复也有这两列', async () => {
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
    const { store, round } = setup({
      definitions: [dice, slow],
      maxRetries: 0,
      turns: [
        calls(usageOf(1, 1), call('dice', { sides: 6 })),
        serverError(),
        calls(usageOf(1, 1), call('slow', {})),
      ],
    });

    await round('掷');
    await round('等等', controller.signal);

    expect((await store.calls()).map((row) => [row.outcome, row.steps, row.toolCalls])).toEqual([
      ['failed', 2, 1],
      ['aborted', 1, 1],
    ]);
  });

  it('摘要：steps 1，tool_calls 0', async () => {
    const { store, round } = setup({
      definitions: [dice],
      segments: { idleMs: 30 },
      turns: [calls(usageOf(1, 1), call('dice', { sides: 6 })), answer('掷出了 4'), answer('摘要')],
    });

    await round('掷');
    advance(60_000);
    await until(async () => (await store.currentSegment()).startReason === 'idle');

    const [, summary] = await store.calls();
    expect(summary).toMatchObject({ purpose: 'summary', steps: 1, toolCalls: 0 });
  });
});

describe('工具调用表', () => {
  /** 一次回复里各种结果的工具调用：第 1 步五个，第 2 步一个被中止 */
  async function everyOutcome(store: ConversationStore) {
    const controller = new AbortController();
    const tools = [
      dice,
      defineTool({
        name: 'boom',
        description: '抛错',
        input: empty,
        execute: (): string => {
          throw new TypeError('机密-错误消息');
        },
      }),
      defineTool({
        name: 'stuck',
        description: '卡住',
        input: empty,
        timeoutMs: 30,
        execute: () => new Promise<never>(() => {}),
      }),
      defineTool({
        name: 'slow',
        description: '耗时',
        input: empty,
        execute: () => {
          setTimeout(() => controller.abort(), 10);
          return new Promise<never>(() => {});
        },
      }),
    ];
    const t = setup({
      store,
      definitions: tools,
      turns: [
        calls(
          usageOf(1, 1),
          call('dice', { sides: 6 }, 'c1'),
          call('boom', {}, 'c2'),
          call('stuck', {}, 'c3'),
          call('dice', { sides: '机密-参数' }, 'c4'),
          call('nope', {}, 'c5'),
        ),
        calls(usageOf(1, 1), call('slow', {}, 'c6')),
      ],
    });
    await t.round('都试试', controller.signal);
    const replyId = logsOf(t.entries, 'reply.end')[0]?.fields.replyId;
    return { ...t, replyId };
  }

  /** 按工具名排序（执行出错的在执行时写，不合规的在流上写，先后不定） */
  const byTool = (rows: ToolCall[]) =>
    [...rows].sort((a, b) =>
      `${a.step}${a.tool}${a.outcome}`.localeCompare(`${b.step}${b.tool}${b.outcome}`),
    );

  it('completed、failed、timeout、aborted、参数不合结构、不存在的工具各一行，字段与 tool.end 一致；不存参数、结果与错误消息', async () => {
    const { store, entries, replyId } = await everyOutcome(createMemoryStore());

    const rows = await store.toolCalls();
    const base = { replyId, startedAt: now, durationMs: 0 };
    // 每行带上调用 id（与消息里工具段的 toolCallId 相同），执行的与不合规的都有
    expect(byTool(rows)).toEqual([
      { ...base, toolCallId: 'c2', tool: 'boom', step: 1, outcome: 'failed', error: 'TypeError' },
      { ...base, toolCallId: 'c1', tool: 'dice', step: 1, outcome: 'completed', outputChars: 11 },
      {
        ...base,
        toolCallId: 'c4',
        tool: 'dice',
        step: 1,
        outcome: 'failed',
        error: 'InvalidToolInputError',
      },
      {
        ...base,
        toolCallId: 'c5',
        tool: 'nope',
        step: 1,
        outcome: 'failed',
        error: 'NoSuchToolError',
      },
      { ...base, toolCallId: 'c3', tool: 'stuck', step: 1, outcome: 'timeout' },
      { ...base, toolCallId: 'c6', tool: 'slow', step: 2, outcome: 'aborted' },
    ]);
    // 每行都有一条同样的 tool.end
    const ends = logsOf(entries, 'tool.end').map((e) => ({
      replyId: e.fields.replyId,
      toolCallId: e.fields.toolCallId,
      tool: e.fields.tool,
      step: e.fields.step,
      outcome: e.fields.outcome,
      error: e.fields.errorType,
      outputChars: e.fields.resultLength,
    }));
    expect(byTool(ends as ToolCall[])).toEqual(
      byTool(rows).map(({ replyId, toolCallId, tool, step, outcome, error, outputChars }) => ({
        replyId,
        toolCallId,
        tool,
        step,
        outcome,
        error,
        outputChars,
      })),
    );
    expect(JSON.stringify(rows)).not.toContain('机密');
  });

  it('SQLite 存储与内存存储写下的一样', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'luolicore-records-'));
    const storage = openSqliteStorage(join(dir, 'luoli.db'));
    cleanups.push(async () => {
      storage.close();
      await rm(dir, { recursive: true, force: true });
    });
    const sqlite = await everyOutcome(
      await storage.openConversation(await storage.createConversation({ platform: 'cli' })),
    );
    const memory = await everyOutcome(createMemoryStore());

    const normalize = (rows: ToolCall[]) => byTool(rows).map((row) => ({ ...row, replyId: '' }));
    expect(normalize(await sqlite.store.toolCalls())).toEqual(
      normalize(await memory.store.toolCalls()),
    );
  });

  it('超时的耗时算到超时为止', async () => {
    const stuck = defineTool({
      name: 'stuck',
      description: '卡住',
      input: empty,
      timeoutMs: 50,
      execute: () => {
        advance(50);
        return new Promise<never>(() => {});
      },
    });
    const { store, round } = setup({
      definitions: [stuck],
      turns: [calls(usageOf(1, 1), call('stuck', {})), answer('超时了')],
    });

    await round('试试');

    expect(await store.toolCalls()).toMatchObject([{ outcome: 'timeout', durationMs: 50 }]);
  });

  it('写入出错：工具调用与回复照常，记一条 tool_call.record_failed', async () => {
    const inner = createMemoryStore();
    const store: ConversationStore = {
      ...inner,
      recordToolCall: async () => {
        throw new Error('database is locked');
      },
    };
    const { conversation, entries, round } = setup({
      store,
      definitions: [dice],
      turns: [
        calls(usageOf(1, 1), call('dice', { sides: 6 }), call('nope', {}, 'c2')),
        answer('掷出了 4'),
      ],
    });

    const chunks = await round('掷');

    expect(chunks.some((chunk) => chunk.type === 'error')).toBe(false);
    expect((await conversation.messages()).map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(logsOf(entries, 'tool.end')).toHaveLength(2);
    expect(logsOf(entries, 'tool_call.record_failed').map((e) => [e.level, e.fields])).toEqual([
      [
        'error',
        expect.objectContaining({
          tool: expect.any(String),
          error: expect.objectContaining({ message: 'database is locked' }),
        }),
      ],
      ['error', expect.objectContaining({ tool: expect.any(String) })],
    ]);
    expect(logsOf(entries, 'reply.end')[0]?.fields).toMatchObject({ outcome: 'completed' });
  });
});

describe('用量', () => {
  it('两步回复：metadata 的 usage 与模型调用表的 token 都是两步之和', async () => {
    const { conversation, store, round } = setup({
      definitions: [dice],
      turns: [
        calls(usageOf(100, 10), call('dice', { sides: 6 })),
        answer('掷出了 4', usageOf(150, 20)),
      ],
    });

    await round('掷');

    const reply = (await conversation.messages())[1];
    expect(reply?.metadata?.usage).toEqual({ input: 250, output: 30, total: 280 });
    expect(await store.calls()).toMatchObject([{ inputTokens: 250, outputTokens: 30 }]);
  });
});

describe('多步回复的缓存命中与推理 token：按各步判断服务端报没报', () => {
  /**
   * 带 openai 格式原始用量的一步：cached、reasoning 不给时原始用量里没有这一项，
   * 而 SDK 照 openai-compatible 的做法填 0
   */
  function rawUsage(
    input: number,
    output: number,
    { cached, reasoning }: { cached?: number; reasoning?: number } = {},
  ): FinishPart['usage'] {
    return {
      inputTokens: {
        total: input,
        noCache: input - (cached ?? 0),
        cacheRead: cached ?? 0,
        cacheWrite: undefined,
      },
      outputTokens: { total: output, text: output - (reasoning ?? 0), reasoning: reasoning ?? 0 },
      raw: {
        prompt_tokens: input,
        completion_tokens: output,
        total_tokens: input + output,
        ...(cached === undefined ? {} : { prompt_tokens_details: { cached_tokens: cached } }),
        ...(reasoning === undefined
          ? {}
          : { completion_tokens_details: { reasoning_tokens: reasoning } }),
      },
    };
  }

  async function twoSteps(first: FinishPart['usage'], second: FinishPart['usage']) {
    const t = setup({
      definitions: [dice],
      turns: [calls(first, call('dice', { sides: 6 })), answer('掷出了 4', second)],
    });
    await t.round('掷');
    const reply = (await t.conversation.messages())[1];
    const [row] = await t.store.calls();
    return { usage: reply?.metadata?.usage, row };
  }

  it('两步都没报：metadata 没有 cacheRead，模型调用表两列为空；输入、输出、总数照旧是两步之和', async () => {
    const { usage, row } = await twoSteps(rawUsage(100, 10), rawUsage(150, 20));

    expect(usage).toEqual({ input: 250, output: 30, total: 280 });
    expect(usage).not.toHaveProperty('cacheRead', 0);
    expect(row).toMatchObject({ inputTokens: 250, outputTokens: 30 });
    expect(row?.cacheReadTokens).toBeUndefined();
    expect(row?.reasoningTokens).toBeUndefined();
  });

  it('两步都报了：是两步之和（报了 0 也算报了）', async () => {
    const { usage, row } = await twoSteps(
      rawUsage(100, 10, { cached: 30, reasoning: 0 }),
      rawUsage(150, 20, { cached: 50, reasoning: 7 }),
    );

    expect(usage).toEqual({ input: 250, output: 30, total: 280, cacheRead: 80 });
    expect(row).toMatchObject({ cacheReadTokens: 80, reasoningTokens: 7 });
  });

  it('只有一步报了：是报了的那一步的值', async () => {
    const { usage, row } = await twoSteps(
      rawUsage(100, 10),
      rawUsage(150, 20, { cached: 40, reasoning: 3 }),
    );

    expect(usage).toEqual({ input: 250, output: 30, total: 280, cacheRead: 40 });
    expect(row).toMatchObject({ cacheReadTokens: 40, reasoningTokens: 3 });
  });
});

describe('压缩按最后一步的输入判断', () => {
  // 先聊一轮（输入很小），3 分钟后第二轮是两步回复；压缩时第一轮并入摘要，保留第二轮
  const segments = { compressTokens: 200, keepMessages: 1 };
  const first = answer('早', usageOf(10, 1));

  it('两步之和超过阈值、最后一步没超过：不压缩', async () => {
    const { model, store, round } = setup({
      definitions: [dice],
      segments,
      turns: [
        first,
        calls(usageOf(150, 1), call('dice', { sides: 6 })),
        answer('掷出了 4', usageOf(160, 1)),
      ],
    });

    await round('早');
    advance(3 * 60_000);
    await round('掷');
    await sleep(50);

    expect(model.doStreamCalls).toHaveLength(3);
    expect((await store.currentSegment()).startReason).toBe('first');
  });

  it('最后一步超过阈值：压缩', async () => {
    const { model, store, round } = setup({
      definitions: [dice],
      segments,
      turns: [
        first,
        calls(usageOf(150, 1), call('dice', { sides: 6 })),
        answer('掷出了 4', usageOf(250, 1)),
        answer('压缩后的摘要'),
      ],
    });

    await round('早');
    advance(3 * 60_000);
    await round('掷');
    await until(async () => (await store.currentSegment()).startReason === 'compress');

    expect(model.doStreamCalls).toHaveLength(4);
  });

  it('执行过工具、最后没有文字的写入回复：最后一步超过阈值也压缩', async () => {
    const { conversation, store, entries, round } = setup({
      definitions: [dice],
      segments,
      turns: [
        first,
        calls(usageOf(150, 1), call('dice', { sides: 6 })),
        answer('', usageOf(250, 1)),
        answer('压缩后的摘要'),
      ],
    });

    await round('早');
    advance(3 * 60_000);
    await round('掷');
    await until(async () => (await store.currentSegment()).startReason === 'compress');

    expect(logsOf(entries, 'reply.end')[1]?.fields).toMatchObject({
      outcome: 'empty',
      saved: true,
    });
    expect((await conversation.messages()).map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
  });
});

describe('首字延迟', () => {
  it('第 1 步只调工具：是工具调用开始输出的时间，不等第 2 步出字', async () => {
    const slow = defineTool({
      name: 'slow',
      description: '耗时',
      input: empty,
      execute: () => {
        advance(100);
        return 'done';
      },
    });
    const { store, round } = setup({
      definitions: [slow],
      turns: [
        { before: () => advance(40), parts: calls(usageOf(1, 1), call('slow', {})) },
        { before: () => advance(30), parts: answer('好了') },
      ],
    });

    await round('慢慢来');

    expect(await store.calls()).toMatchObject([{ firstOutputMs: 40, durationMs: 170 }]);
  });
});
