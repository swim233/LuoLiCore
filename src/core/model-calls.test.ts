import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APICallError, simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createConversation,
  createMemoryStore,
  openSqliteStorage,
  type Conversation,
  type ConversationStore,
  type Logger,
  type MessageChunk,
  type ModelCall,
  type SegmentOptions,
} from './index.js';
import { testPrompts } from './test-prompts.js';

type StreamResult = Awaited<ReturnType<MockLanguageModelV4['doStream']>>;
type StreamPart = StreamResult['stream'] extends ReadableStream<infer P> ? P : never;
type FinishPart = Extract<StreamPart, { type: 'finish' }>;

const alice = { id: 'u-alice', name: 'Alice' };
const instructions = '你是测试助手';
const prompts = testPrompts(instructions);

// 只假冒 Date，计时器照常走：时间列是确定的（不拨 Date 时耗时都是 0），SDK 的重试与超时不受影响
const now = '2026-10-30T06:02:00.000Z';
let originalTz: string | undefined;
beforeAll(() => {
  originalTz = process.env.TZ;
  process.env.TZ = 'Asia/Shanghai';
});
afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});
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
async function until(check: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!(await check())) {
    if (performance.now() > deadline) throw new Error('等待超时');
    await sleep(5);
  }
}

/** 模型报的用量：输入 input（其中缓存命中 cacheRead）、输出 output（其中推理 reasoning） */
function usageOf(
  input: number,
  output: number,
  {
    cacheRead,
    reasoning,
    raw,
  }: { cacheRead?: number; reasoning?: number; raw?: FinishPart['usage']['raw'] } = {},
): FinishPart['usage'] {
  return {
    inputTokens: {
      total: input,
      noCache: input - (cacheRead ?? 0),
      cacheRead,
      cacheWrite: undefined,
    },
    outputTokens: { total: output, text: output - (reasoning ?? 0), reasoning },
    ...(raw ? { raw } : {}),
  };
}

const noUsage: FinishPart['usage'] = {
  inputTokens: {
    total: undefined,
    noCache: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
};

function textParts(...deltas: string[]): StreamPart[] {
  return [
    { type: 'text-start', id: 't' },
    ...deltas.map((delta): StreamPart => ({ type: 'text-delta', id: 't', delta })),
    { type: 'text-end', id: 't' },
  ];
}

function finish(usage: FinishPart['usage'] = usageOf(10, 2)): StreamPart {
  return { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage };
}

/** 一次完整的回复 */
function answer(text: string, usage?: FinishPart['usage']): StreamPart[] {
  return [...textParts(text), finish(usage)];
}

/** 输出若干段后服务端在流中发来错误事件 */
function streamError(text: string): StreamPart[] {
  return [...textParts(text).slice(0, -1), { type: 'error', error: { message: '服务端过载' } }];
}

const abortError = () => new DOMException('This operation was aborted', 'AbortError');

/**
 * 模型的一次请求：Error 则请求失败；段的数组则依次输出后结束；
 * { hang } 则输出这些段后挂起，直到被中止时像 fetch 一样以 AbortError 出错
 */
type Turn = Error | StreamPart[] | { hang: StreamPart[] };

function scripted(...turns: Turn[]): MockLanguageModelV4 {
  let call = 0;
  return new MockLanguageModelV4({
    doStream: async ({ abortSignal }) => {
      const turn = turns[call++];
      if (turn === undefined) throw new Error('mock 模型没有更多脚本');
      if (turn instanceof Error) throw turn;
      const parts = Array.isArray(turn) ? turn : turn.hang;
      return {
        stream: new ReadableStream<StreamPart>({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            if (Array.isArray(turn)) return controller.close();
            abortSignal?.addEventListener('abort', () => controller.error(abortError()), {
              once: true,
            });
          },
        }),
      };
    },
  });
}

/** 模拟 HTTP 错误；不给状态码时是网络错误。retry-after-ms 为 0，SDK 重试时不等待 */
function httpError(statusCode?: number): APICallError {
  return new APICallError({
    message: statusCode === undefined ? 'Cannot connect to API' : `HTTP ${statusCode}`,
    url: 'http://mock.test/v1/chat/completions',
    requestBodyValues: {},
    statusCode,
    responseHeaders: { 'retry-after-ms': '0' },
    isRetryable: statusCode === undefined ? true : undefined,
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
  store = createMemoryStore(),
  segments,
  timeouts,
}: {
  turns?: Turn[];
  model?: MockLanguageModelV4;
  store?: ConversationStore;
  segments?: SegmentOptions;
  timeouts?: { firstChunkMs?: number; chunkMs?: number };
}) {
  const { logger, entries } = recordingLogger();
  const conversation = createConversation({
    model,
    prompts,
    store,
    logger,
    conversationId: 'c1',
    segments,
    timeouts,
  });
  opened.push(conversation);
  const round = async (text: string, abortSignal?: AbortSignal) => {
    await conversation.append({ author: alice, text });
    return readAll(conversation.reply({ abortSignal }));
  };
  return { conversation, model, store, entries, round };
}

/** 没有用量的调用：4 个 token 列都为空 */
const noTokens = {
  inputTokens: undefined,
  cacheReadTokens: undefined,
  outputTokens: undefined,
  reasoningTokens: undefined,
};

/** 结束时取值有变化的列：结果、错误、请求次数、首字延迟、结束原因与 4 个 token 列 */
const endColumns = [
  'outcome',
  'error',
  'attempts',
  'firstOutputMs',
  'finishReason',
  'inputTokens',
  'cacheReadTokens',
  'outputTokens',
  'reasoningTokens',
] as const;

/**
 * 一行里的这几列。空的列为 undefined；与 toEqual 一起用时，期望里没写的列就要求为空
 * （toMatchObject 会要求写成 undefined 的键存在，内存存储里没有值的键可能不存在）
 */
function columnsOf<K extends keyof ModelCall>(
  row: ModelCall | undefined,
  keys: readonly K[],
): Partial<Pick<ModelCall, K>> {
  return Object.fromEntries(keys.map((key) => [key, row?.[key]])) as Partial<Pick<ModelCall, K>>;
}

/** 一行的 endColumns */
const endOf = (row: ModelCall | undefined) => columnsOf(row, endColumns);

/** 本会话每次模型调用的 endColumns */
async function endsOf(store: ConversationStore) {
  return (await store.calls()).map(endOf);
}

describe('模型调用表：回复', () => {
  it('正常完成：一行，回复 id 与写入历史的助手消息相同，token 与 metadata 的 usage 一致', async () => {
    const raw = {
      prompt_tokens: 120,
      completion_tokens: 30,
      total_tokens: 150,
      prompt_tokens_details: { cached_tokens: 100 },
      completion_tokens_details: { reasoning_tokens: 12 },
    };
    const { model, store, entries, round } = setup({
      turns: [answer('你好', usageOf(120, 30, { cacheRead: 100, reasoning: 12, raw }))],
    });

    await round('嗨');

    const [, reply] = await store.list();
    const calls = await store.calls();
    expect(calls).toEqual([
      {
        purpose: 'reply',
        replyId: reply?.id,
        model: model.modelId,
        startedAt: now,
        durationMs: 0,
        firstOutputMs: 0,
        attempts: 1,
        outcome: 'completed',
        finishReason: 'stop',
        inputTokens: 120,
        cacheReadTokens: 100,
        outputTokens: 30,
        reasoningTokens: 12,
        steps: 1,
        toolCalls: 0,
      },
    ]);
    expect(calls[0]).not.toHaveProperty('summaryReason');
    expect(calls[0]).not.toHaveProperty('error');
    expect(reply?.metadata?.usage).toEqual({ input: 120, output: 30, total: 150, cacheRead: 100 });
    expect(logsOf(entries, 'reply.end')[0]?.fields).toMatchObject({
      replyId: reply?.id,
      attempts: 1,
      outcome: 'completed',
      finishReason: 'stop',
    });
  });

  it('started_at 是第一次请求发出的时间：之前读历史等花的时间不算在耗时与首字延迟里', async () => {
    const base = createMemoryStore();
    // 读当前段的消息时 Date 往后走 5 秒
    const store: ConversationStore = {
      ...base,
      list: async (range) => {
        if (range) advance(5000);
        return base.list(range);
      },
    };
    const { round } = setup({ turns: [answer('好')], store });

    await round('在吗');

    expect(await store.calls()).toMatchObject([
      { startedAt: '2026-10-30T06:02:05.000Z', durationMs: 0, firstOutputMs: 0 },
    ]);
  });

  it('首字延迟：从请求发出到第一段输出；耗时到调用结束', async () => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const model = new MockLanguageModelV4({
      doStream: async () => {
        advance(30);
        return {
          stream: new ReadableStream<StreamPart>({
            async start(controller) {
              advance(70);
              for (const part of textParts('好').slice(0, -1)) controller.enqueue(part);
              await released;
              advance(50);
              controller.enqueue({ type: 'text-end', id: 't' });
              controller.enqueue(finish());
              controller.close();
            },
          }),
        };
      },
    });
    const { conversation, store } = setup({ model });
    await conversation.append({ author: alice, text: '在吗' });

    for await (const chunk of conversation.reply()) {
      if (chunk.type === 'text-delta') release();
    }

    expect(await store.calls()).toMatchObject([
      { startedAt: now, firstOutputMs: 100, durationMs: 150, outcome: 'completed' },
    ]);
  });

  it('正常结束但没有文字：empty，照常记结束原因与用量', async () => {
    const { store, entries, round } = setup({ turns: [answer(' \n ', usageOf(5, 1))] });

    await round('在吗');

    expect(await store.calls()).toMatchObject([
      { outcome: 'empty', finishReason: 'stop', inputTokens: 5, outputTokens: 1 },
    ]);
    expect((await store.calls())[0]).not.toHaveProperty('error');
    expect(logsOf(entries, 'reply.end')[0]?.fields).toMatchObject({ outcome: 'empty' });
  });

  it('输出几段后中止：aborted，有首字延迟，没有结束原因、用量与错误', async () => {
    const { store, round } = setup({ turns: [{ hang: textParts('说到一半').slice(0, -1) }] });
    const controller = new AbortController();

    const replying = round('讲个故事', controller.signal);
    await until(async () => (await store.list()).length === 1);
    await sleep(20);
    controller.abort();
    await replying;

    const [row] = await store.calls();
    expect(row).toEqual({
      purpose: 'reply',
      replyId: (await store.list())[1]?.id,
      model: expect.any(String),
      startedAt: now,
      durationMs: 0,
      firstOutputMs: 0,
      attempts: 1,
      outcome: 'aborted',
      finishReason: undefined,
      ...noTokens,
      error: undefined,
      steps: 1,
      toolCalls: 0,
    });
  });

  it('一字未出就中止：aborted，首字延迟为空', async () => {
    const { model, store, round } = setup({ turns: [{ hang: [] }] });
    const controller = new AbortController();

    const replying = round('在吗', controller.signal);
    await until(() => model.doStreamCalls.length === 1);
    controller.abort();
    await replying;

    expect(await endsOf(store)).toEqual([{ outcome: 'aborted', attempts: 1 }]);
  });

  it('调用方取消回复流：cancelled，没有用量', async () => {
    const model = new MockLanguageModelV4({
      doStream: {
        stream: simulateReadableStream({ chunks: answer('一二三'), chunkDelayInMs: 10 }),
      },
    });
    const { conversation, store } = setup({ model });
    await conversation.append({ author: alice, text: '数数' });

    const reader = conversation.reply().getReader();
    while ((await reader.read()).value?.type !== 'text-delta');
    await reader.cancel();

    expect(await endsOf(store)).toEqual([{ outcome: 'cancelled', attempts: 1, firstOutputMs: 0 }]);
  });

  it.each([
    ['不可重试的状态码', [httpError(401)], 'APICallError 401', 1, false],
    [
      '可重试的错误耗尽（取最后一次）',
      [httpError(503), httpError(503), httpError(503)],
      'APICallError 503',
      3,
      false,
    ],
    ['网络错误没有状态码', [httpError(), httpError(), httpError()], 'APICallError', 3, false],
    [
      '流中错误耗尽',
      [streamError('一'), streamError('二'), streamError('三')],
      'StreamProviderError',
      3,
      true,
    ],
  ] satisfies Array<[string, Turn[], string, number, boolean]>)(
    '模型失败（%s）：failed，记错误类型与状态码，没有用量',
    async (_name, turns, error, attempts, hadOutput) => {
      const { store, entries, round } = setup({ turns });

      await round('在吗');

      expect(await endsOf(store)).toEqual([
        { outcome: 'failed', error, attempts, firstOutputMs: hadOutput ? 0 : undefined },
      ]);
      expect(logsOf(entries, 'reply.failed')[0]?.fields).toMatchObject({ attempts });
    },
  );

  it('错误信息与正文不进 error 列', async () => {
    const { store, round } = setup({
      turns: [
        new APICallError({
          message: '机密正文-7f3a',
          url: 'http://mock.test/v1/chat/completions',
          requestBodyValues: { messages: [{ role: 'user', content: '机密正文-7f3a' }] },
          statusCode: 400,
          responseBody: '{"error":{"message":"机密正文-7f3a"}}',
        }),
      ],
    });

    await round('机密正文-7f3a');

    expect(await endsOf(store)).toEqual([
      { outcome: 'failed', error: 'APICallError 400', attempts: 1 },
    ]);
  });

  it('首段超时：failed，TimeoutError，首字延迟为空', async () => {
    const { store, round } = setup({
      turns: [{ hang: [] }],
      timeouts: { firstChunkMs: 50, chunkMs: 50 },
    });

    await round('在吗');

    expect(await endsOf(store)).toEqual([
      { outcome: 'failed', error: 'TimeoutError', attempts: 1 },
    ]);
  });

  it('两段间超时：failed，TimeoutError，有首字延迟', async () => {
    const { store, round } = setup({
      turns: [{ hang: textParts('半截').slice(0, -1) }],
      timeouts: { firstChunkMs: 50, chunkMs: 50 },
    });

    await round('在吗');

    expect(await endsOf(store)).toEqual([
      { outcome: 'failed', error: 'TimeoutError', attempts: 1, firstOutputMs: 0 },
    ]);
  });

  it('请求阶段重试（先 429 后成功）：一行，attempts 计入重试', async () => {
    const { store, round } = setup({ turns: [httpError(429), answer('好', usageOf(10, 2))] });

    await round('在吗');

    expect(await endsOf(store)).toEqual([
      {
        outcome: 'completed',
        attempts: 2,
        firstOutputMs: 0,
        finishReason: 'stop',
        inputTokens: 10,
        outputTokens: 2,
      },
    ]);
  });

  it('流式重试后成功：一行，attempts 计入重试；被作废的那次输出也算首字', async () => {
    let call = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        if (call++ === 0) {
          advance(40);
          return { stream: simulateReadableStream({ chunks: streamError('半截') }) };
        }
        advance(60);
        return { stream: simulateReadableStream({ chunks: answer('完整', usageOf(50, 5)) }) };
      },
    });
    const { store, round } = setup({ model });

    await round('在吗');

    const calls = await store.calls();
    expect(calls.map(endOf)).toEqual([
      {
        outcome: 'completed',
        attempts: 2,
        firstOutputMs: 40,
        finishReason: 'stop',
        inputTokens: 50,
        outputTokens: 5,
      },
    ]);
    expect(calls[0]?.durationMs).toBe(100);
  });

  it('拒收图片后的恢复：一行，attempts 计入恢复的那次', async () => {
    const { conversation, store } = setup({
      turns: [httpError(400), answer('看不清', usageOf(10, 2))],
    });
    await conversation.append({
      author: alice,
      text: '看图',
      files: [
        {
          data: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]),
          mediaType: 'image/png',
        },
      ],
    });

    await readAll(conversation.reply());

    expect(await endsOf(store)).toEqual([
      {
        outcome: 'completed',
        attempts: 2,
        firstOutputMs: 0,
        finishReason: 'stop',
        inputTokens: 10,
        outputTokens: 2,
      },
    ]);
  });

  it('服务端没报缓存数与推理 token 时两列为空，报了 0 时为 0；输入输出照常', async () => {
    // openai-compatible 的 provider 没报时也把两项填成 0，只能看原始用量区分
    const notReported = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 };
    const reportedZero = {
      ...notReported,
      prompt_tokens_details: { cached_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 0 },
    };
    const zeros = { cacheRead: 0, reasoning: 0 };
    const { store, round } = setup({
      turns: [
        answer('一', usageOf(10, 2, { ...zeros, raw: notReported })),
        answer('二', usageOf(10, 2, { ...zeros, raw: reportedZero })),
      ],
    });

    await round('一');
    await round('二');

    const tokens = ['inputTokens', 'cacheReadTokens', 'outputTokens', 'reasoningTokens'] as const;
    const [first, second] = await store.calls();
    expect(columnsOf(first, tokens)).toEqual({ inputTokens: 10, outputTokens: 2 });
    expect(columnsOf(second, tokens)).toEqual({
      inputTokens: 10,
      cacheReadTokens: 0,
      outputTokens: 2,
      reasoningTokens: 0,
    });
  });

  it('只报缓存数、不报推理 token：缓存命中有值，推理 token 为空', async () => {
    const raw = {
      prompt_tokens: 10,
      completion_tokens: 2,
      total_tokens: 12,
      prompt_tokens_details: { cached_tokens: 6 },
    };
    const { store, round } = setup({
      turns: [answer('好', usageOf(10, 2, { cacheRead: 6, reasoning: 0, raw }))],
    });

    await round('在吗');

    const tokens = ['inputTokens', 'cacheReadTokens', 'outputTokens', 'reasoningTokens'] as const;
    expect(columnsOf((await store.calls())[0], tokens)).toEqual({
      inputTokens: 10,
      cacheReadTokens: 6,
      outputTokens: 2,
    });
  });

  it('服务端没报用量：4 个 token 列都为空', async () => {
    const { store, round } = setup({ turns: [answer('好', noUsage)] });

    await round('在吗');

    expect(await endsOf(store)).toEqual([
      { outcome: 'completed', attempts: 1, firstOutputMs: 0, finishReason: 'stop' },
    ]);
  });

  it('写入模型调用出错：回复照常完成、写入历史，记一条 model_call.record_failed', async () => {
    const base = createMemoryStore();
    const store: ConversationStore = {
      ...base,
      recordCall: async () => {
        throw new Error('磁盘满了');
      },
    };
    const { entries, round } = setup({ turns: [answer('好')], store });

    const chunks = await round('在吗');

    expect(chunks.some((c) => c.type === 'error')).toBe(false);
    expect(chunks.at(-1)?.type).toBe('finish');
    const [, reply] = await store.list();
    expect(reply?.role).toBe('assistant');
    const failed = logsOf(entries, 'model_call.record_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      level: 'error',
      fields: {
        conversationId: 'c1',
        purpose: 'reply',
        replyId: reply?.id,
        error: { message: '磁盘满了' },
      },
    });
    expect(logsOf(entries, 'reply.end')[0]?.fields).toMatchObject({ outcome: 'completed' });
  });
});

describe('模型调用表：摘要', () => {
  /** 聊一轮后空闲，等后台的空闲切段结束（成功或失败都算） */
  async function idleSummary(summary: Turn, options: { store?: ConversationStore } = {}) {
    const t = setup({ turns: [answer('好的'), summary], segments: { idleMs: 30 }, ...options });
    await t.round('早上好');
    advance(60_000);
    await until(() =>
      ['summary.end', 'summary.failed', 'summary.duplicate'].some(
        (msg) => logsOf(t.entries, msg).length > 0,
      ),
    );
    return t;
  }

  it('空闲切段：回复与摘要各一行；摘要的一行记 idle，没有回复 id', async () => {
    const { model, store } = await idleSummary(
      answer('Alice 打了招呼。', usageOf(40, 8, { cacheRead: 30 })),
    );

    const [reply, summary] = await store.calls();
    expect(reply).toMatchObject({ purpose: 'reply', outcome: 'completed' });
    expect(summary).toEqual({
      purpose: 'summary',
      summaryReason: 'idle',
      model: model.modelId,
      startedAt: '2026-10-30T06:03:00.000Z',
      durationMs: 0,
      firstOutputMs: 0,
      attempts: 1,
      outcome: 'completed',
      finishReason: 'stop',
      inputTokens: 40,
      cacheReadTokens: 30,
      outputTokens: 8,
      reasoningTokens: undefined,
      steps: 1,
      toolCalls: 0,
    });
    expect(summary).not.toHaveProperty('replyId');
    expect(summary).not.toHaveProperty('error');
  });

  it('压缩：记一行 compress', async () => {
    const { store, round } = setup({
      turns: [
        answer('答1', usageOf(50, 1)),
        answer('答2', usageOf(150, 1)),
        answer('压缩后的摘要'),
      ],
      segments: { compressTokens: 100, keepMessages: 1 },
    });
    await round('第1句');
    advance(3 * 60_000);
    await round('第2句');
    await until(async () => (await store.currentSegment()).startReason === 'compress');

    const calls = await store.calls();
    expect(calls.map((c) => [c.purpose, c.summaryReason, c.outcome])).toEqual([
      ['reply', undefined, 'completed'],
      ['reply', undefined, 'completed'],
      ['summary', 'compress', 'completed'],
    ]);
  });

  it('摘要请求失败：failed，记错误类型与状态码', async () => {
    const { store } = await idleSummary(httpError(401));

    const [, summary] = await store.calls();
    expect(summary).toMatchObject({ purpose: 'summary', summaryReason: 'idle' });
    expect(endOf(summary)).toEqual({
      outcome: 'failed',
      error: 'APICallError 401',
      attempts: 1,
    });
  });

  it('摘要等第一段输出超时：failed，TimeoutError', async () => {
    const t = setup({
      turns: [answer('好的'), { hang: [] }],
      segments: { idleMs: 30 },
      timeouts: { firstChunkMs: 50 },
    });
    await t.round('早上好');
    advance(60_000);
    await until(() => logsOf(t.entries, 'summary.failed').length > 0);

    const [, summary] = await t.store.calls();
    expect(summary?.purpose).toBe('summary');
    expect(endOf(summary)).toEqual({ outcome: 'failed', error: 'TimeoutError', attempts: 1 });
  });

  it('摘要为空：empty，照常记结束原因与用量（切段那边记 summary.failed）', async () => {
    const { store, entries } = await idleSummary(answer(' \n ', usageOf(40, 1)));

    expect(logsOf(entries, 'summary.failed')).toHaveLength(1);
    const [, summary] = await store.calls();
    expect(summary?.purpose).toBe('summary');
    expect(endOf(summary)).toEqual({
      outcome: 'empty',
      attempts: 1,
      firstOutputMs: 0,
      finishReason: 'stop',
      inputTokens: 40,
      outputTokens: 1,
    });
  });

  it('摘要被判为重复（同一序号已有一段）：这次调用本身完成了，记 completed', async () => {
    const base = createMemoryStore();
    const { store, entries } = await idleSummary(answer('摘要'), {
      store: { ...base, addSegment: async () => false },
    });

    expect(logsOf(entries, 'summary.duplicate')).toHaveLength(1);
    expect((await store.calls())[1]).toMatchObject({ purpose: 'summary', outcome: 'completed' });
  });

  it('关闭会话时中止进行中的摘要：aborted，没有错误；关闭结束时这一行已经写好', async () => {
    const { conversation, model, store, round } = setup({
      turns: [answer('好的'), { hang: textParts('写到一半').slice(0, -1) }],
      segments: { idleMs: 30 },
    });
    await round('早上好');
    advance(60_000);
    await until(() => model.doStreamCalls.length === 2);
    await sleep(20);

    await conversation.close();

    const [, summary] = await store.calls();
    expect(summary?.purpose).toBe('summary');
    expect(endOf(summary)).toEqual({ outcome: 'aborted', attempts: 1, firstOutputMs: 0 });
  });

  it('写入模型调用出错：摘要照常切段，记一条 model_call.record_failed', async () => {
    const base = createMemoryStore();
    const { store, entries } = await idleSummary(answer('摘要'), {
      store: {
        ...base,
        recordCall: async () => {
          throw new Error('磁盘满了');
        },
      },
    });

    expect(await store.currentSegment()).toMatchObject({
      startReason: 'idle',
      priorSummary: '摘要',
    });
    expect(logsOf(entries, 'model_call.record_failed').map((e) => e.fields)).toMatchObject([
      { conversationId: 'c1', purpose: 'reply' },
      { conversationId: 'c1', purpose: 'summary', reason: 'idle', error: { message: '磁盘满了' } },
    ]);
  });

  it('数据库在摘要进行中被关闭：写不进去只记日志，不崩溃', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'luolicore-db-'));
    const storage = openSqliteStorage(join(dir, 'luoli.db'));
    cleanups.push(async () => {
      storage.close();
      await rm(dir, { recursive: true, force: true });
    });
    const store = await storage.openConversation(
      await storage.createConversation({ platform: 'cli' }),
    );
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let call = 0;
    const model = new MockLanguageModelV4({
      doStream: async () =>
        call++ === 0
          ? { stream: simulateReadableStream({ chunks: answer('好的') }) }
          : {
              stream: new ReadableStream<StreamPart>({
                async start(controller) {
                  await released;
                  for (const part of answer('摘要')) controller.enqueue(part);
                  controller.close();
                },
              }),
            },
    });
    const { entries, round } = setup({ model, store, segments: { idleMs: 30 } });
    await round('早上好');
    advance(60_000);
    await until(() => model.doStreamCalls.length === 2);

    storage.close();
    release();
    await until(() => logsOf(entries, 'summary.failed').length > 0);

    expect(logsOf(entries, 'model_call.record_failed')[0]?.fields).toMatchObject({
      purpose: 'summary',
      reason: 'idle',
    });
  });
});
