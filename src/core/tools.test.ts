import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { APICallError, simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createConversation,
  createMemoryStore,
  defineTool,
  installTools,
  ToolDefinitionError,
  type Conversation,
  type ConversationStore,
  type Logger,
  type Message,
  type MessageChunk,
  type ToolContext,
  type ToolDefinition,
} from './index.js';
import { fixturePrompts, testPrompts } from './test-prompts.js';

type StreamResult = Awaited<ReturnType<MockLanguageModelV4['doStream']>>;
type StreamPart = StreamResult['stream'] extends ReadableStream<infer P> ? P : never;
type CallOptions = MockLanguageModelV4['doStreamCalls'][number];

const alice = { id: 'u-alice', name: 'Alice' };
const prompts = testPrompts('你是测试助手');
const toolLimitText = (await readFile(join(fixturePrompts, 'tool-limit.md'), 'utf8')).trim();

// 只假冒 Date：总时长上限的测试里拨它，计时器照常走
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

/** 一次工具调用，与 openai-compatible 一样先流式给出参数，再给完整的调用 */
function call(toolName: string, input: unknown, id = `call-${toolName}`): StreamPart[] {
  const json = JSON.stringify(input);
  return [
    { type: 'tool-input-start', id, toolName },
    { type: 'tool-input-delta', id, delta: json },
    { type: 'tool-input-end', id },
    { type: 'tool-call', toolCallId: id, toolName, input: json },
  ];
}

/** 这一步调用工具（可以带一段文字） */
const calls = (...parts: StreamPart[][]): StreamPart[] => [...parts.flat(), finish('tool-calls')];
/** 这一步用文字回答 */
const answer = (...deltas: string[]): StreamPart[] => [...text(...deltas), finish('stop')];
/** 输出这些段后服务端在流中报错（与 provider 一致，不补收尾段） */
const failsAfter = (...parts: StreamPart[]): StreamPart[] => [
  ...parts,
  { type: 'error', error: { message: '服务端过载' } },
];

type Attempt =
  StreamPart[] | Error | ((abortSignal: AbortSignal | undefined) => ReadableStream<StreamPart>);

/** 依次处理每次请求：段数组原样输出；Error 则请求失败；函数则由它给出流 */
function scriptedModel(...attempts: Attempt[]): MockLanguageModelV4 {
  let index = 0;
  return new MockLanguageModelV4({
    doStream: async ({ abortSignal }) => {
      const next = attempts[index++];
      if (next === undefined) throw new Error('mock 模型没有更多脚本');
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

// ---- 请求与结果 ----

/** 第 index 次请求的消息（不含 system），每条写成一行：角色、文字、工具调用与结果 */
function messagesOf(model: MockLanguageModelV4, index: number): string[] {
  return requestOf(model, index)
    .prompt.filter((message) => message.role !== 'system')
    .map((message) => {
      const content =
        typeof message.content === 'string'
          ? message.content
          : message.content
              .map((part) => {
                if (part.type === 'text') return part.text;
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

function requestOf(model: MockLanguageModelV4, index: number): CallOptions {
  const request = model.doStreamCalls[index];
  if (!request) throw new Error(`没有第 ${index} 次请求`);
  return request;
}

/** 第 index 次请求里各工具结果交给模型的内容，按 toolCallId */
function toolResultsOf(model: MockLanguageModelV4, index: number): Record<string, unknown> {
  return Object.fromEntries(
    requestOf(model, index).prompt.flatMap((message) =>
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

/** 写入历史的助手消息里的工具段 */
function toolPartsOf(message: Message | undefined) {
  return (message?.parts ?? []).flatMap((part) =>
    part.type.startsWith('tool-') || part.type === 'dynamic-tool'
      ? [part as Extract<Message['parts'][number], { toolCallId: string }>]
      : [],
  );
}

/** 只留与尝试、步的边界有关的段，写成短串 */
function trace(chunks: MessageChunk[]): string[] {
  return chunks.flatMap((chunk) => {
    if (chunk.type === 'text-delta') return [`text:${chunk.delta}`];
    if (chunk.type === 'data-retry') return [`retry:${chunk.data.phase}/${chunk.data.attempt}`];
    if (['start', 'finish', 'message-metadata', 'tool-input-delta'].includes(chunk.type)) {
      return [];
    }
    return [chunk.type];
  });
}

// ---- 测试用的工具 ----

/** 掷骰子：返回 sides - 2（固定值便于断言），记下每次收到的参数与上下文 */
function diceTool() {
  const received: Array<{ input: { sides: number; label: string }; ctx: ToolContext }> = [];
  const definition = defineTool({
    name: 'dice',
    description: '掷一个骰子',
    input: z.object({ sides: z.number().int().min(2), label: z.string().default('d') }),
    env: ['LUOLI_TEST_DICE_KEY'],
    execute: async (input, ctx) => {
      received.push({ input, ctx });
      return { value: input.sides - 2, label: input.label };
    },
  });
  return { definition, received };
}

function setup({
  model,
  definitions,
  env = { LUOLI_TEST_DICE_KEY: 'k' },
  store = createMemoryStore({ title: '读书会' }),
  ...options
}: {
  model: MockLanguageModelV4;
  definitions: ToolDefinition[];
  env?: Record<string, string>;
  store?: ConversationStore;
} & Omit<Parameters<typeof createConversation>[0], 'model' | 'prompts' | 'tools' | 'store'>) {
  const { logger, entries } = recordingLogger();
  const conversation = createConversation({
    model,
    prompts,
    logger,
    store,
    conversationId: 'c1',
    tools: installTools(definitions, env).tools,
    ...options,
  });
  opened.push(conversation);
  const round = async (userText: string, abortSignal?: AbortSignal) => {
    await conversation.append({ author: alice, text: userText });
    return readAll(conversation.reply({ abortSignal }));
  };
  return { conversation, store, entries, round };
}

describe('装配', () => {
  const named = (name: string) =>
    defineTool({ name, description: '测试', input: z.object({}), execute: () => 'ok' });

  function installError(definitions: ToolDefinition[]): ToolDefinitionError {
    try {
      installTools(definitions, {});
    } catch (error) {
      expect(error).toBeInstanceOf(ToolDefinitionError);
      return error as ToolDefinitionError;
    }
    throw new Error('应当抛错');
  }

  it('名字不合规、重名：抛 ToolDefinitionError，信息里有工具名与原因，几个问题一起列出', () => {
    const error = installError([
      named('Dice'),
      named('ok_1'),
      named('web-search'),
      named('ok_1'),
      named('1st'),
      named(''),
    ]);

    const naming = '名字只能用小写字母、数字和下划线，以字母开头';
    expect(error.problems).toEqual([
      { tool: 'Dice', problems: [naming] },
      { tool: 'ok_1', problems: ['重名'] },
      { tool: 'web-search', problems: [naming] },
      { tool: '1st', problems: [naming] },
      { tool: '', problems: [naming] },
    ]);
    expect(error.message).toBe(
      `工具定义有误：Dice（${naming}）；ok_1（重名）；web-search（${naming}）；` +
        `1st（${naming}）；（空）（${naming}）`,
    );
  });

  it('timeoutMs 与 history 不合规也报错；合规的写法都能装', () => {
    const base = { description: '测试', input: z.object({}), execute: () => 'ok' };
    const error = installError([
      defineTool({ ...base, name: 'a', timeoutMs: 0 }),
      defineTool({ ...base, name: 'b', history: { maxChars: 1.5 } }),
      defineTool({ ...base, name: 'c', history: 'some' as 'full' }),
    ]);
    expect(error.problems.map((entry) => entry.tool)).toEqual(['a', 'b', 'c']);
    expect(error.message).toContain('a（timeoutMs 必须是 1 到 2147483647 之间的整数（毫秒））');
    expect(error.message).toContain('b（history 只能是 full、omit、{ maxChars: 正整数 } 或函数）');

    const setup = installTools(
      [
        defineTool({ ...base, name: 'full', history: 'full', timeoutMs: 1000 }),
        defineTool({ ...base, name: 'omit', history: 'omit' }),
        defineTool({ ...base, name: 'short', history: { maxChars: 500 } }),
        defineTool({ ...base, name: 'custom', history: ({ output }) => output }),
      ],
      {},
    );
    expect(setup.tools.map((tool) => tool.definition.name)).toEqual([
      'full',
      'omit',
      'short',
      'custom',
    ]);
  });

  it('缺环境变量（空字符串也算缺）的工具不装，出现在不装的名单里；其余按清单顺序装上', () => {
    const base = { description: '测试', input: z.object({}), execute: () => 'ok' };
    const setup = installTools(
      [
        defineTool({ ...base, name: 'first' }),
        defineTool({ ...base, name: 'search', env: ['LUOLI_TEST_KEY', 'LUOLI_TEST_URL'] }),
        defineTool({ ...base, name: 'mail', env: ['LUOLI_TEST_MAIL'] }),
        defineTool({ ...base, name: 'last', env: ['LUOLI_TEST_KEY'] }),
      ],
      { LUOLI_TEST_KEY: 'k', LUOLI_TEST_URL: '' },
    );

    expect(setup.tools.map((tool) => tool.definition.name)).toEqual(['first', 'last']);
    expect(setup.skipped).toEqual([
      { name: 'search', missing: ['LUOLI_TEST_URL'] },
      { name: 'mail', missing: ['LUOLI_TEST_MAIL'] },
    ]);
  });
});

/** 一个会回复「好」的 openai-compatible 服务，记下每次请求的 JSON 正文 */
function fakeServer() {
  const bodies: Array<Record<string, unknown>> = [];
  const chunk = (delta: object, finishReason: string | null) => ({
    id: 'x',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'm',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
  const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    const events = [chunk({ role: 'assistant', content: '好' }, null), chunk({}, 'stop')];
    const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`;
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  };
  const model = createOpenAICompatible({ name: 'fake', baseURL: 'http://fake.test/v1', fetch })(
    'm',
  );
  return { model, bodies };
}

describe('没装工具', () => {
  it('请求正文里没有 tools 与 tool_choice，与传空的工具列表逐字相同；装了工具才有', async () => {
    const server = fakeServer();
    for (const tools of [
      undefined,
      [],
      installTools([diceTool().definition], { LUOLI_TEST_DICE_KEY: 'k' }).tools,
    ]) {
      const conversation = createConversation({ model: server.model, prompts, tools });
      opened.push(conversation);
      await conversation.append({ author: alice, text: '在吗' });
      await readAll(conversation.reply());
    }

    const [none, empty, withTools] = server.bodies;
    expect(none).not.toHaveProperty('tools');
    expect(none).not.toHaveProperty('tool_choice');
    expect(empty).toEqual(none);
    expect(withTools).toMatchObject({
      tool_choice: 'auto',
      tools: [{ type: 'function', function: { name: 'dice', description: '掷一个骰子' } }],
    });
  });

  it('mock 模型收到的请求没有工具定义，toolChoice 是 SDK 的默认值（与之前相同）', async () => {
    const model = scriptedModel(answer('好'));
    const { round } = setup({ model, definitions: [] });

    await round('在吗');

    expect(requestOf(model, 0).tools).toBeUndefined();
    expect(requestOf(model, 0).toolChoice).toEqual({ type: 'auto' });
  });
});

describe('多步回复', () => {
  it('第一步调工具、第二步回答：工具收到解析过的参数与 ctx，第二次请求里有结果，历史里有工具段与回答', async () => {
    const dice = diceTool();
    const model = scriptedModel(calls(call('dice', { sides: 6 })), answer('掷出了 4'));
    const { conversation, entries, round } = setup({
      model,
      definitions: [dice.definition],
      env: { LUOLI_TEST_DICE_KEY: 'k', LUOLI_OTHER: 'x' },
    });

    const chunks = await round('掷个骰子');

    // 参数按 schema 解析（补上了默认值）
    expect(dice.received).toHaveLength(1);
    const [{ input, ctx }] = dice.received as [(typeof dice.received)[number]];
    expect(input).toEqual({ sides: 6, label: 'd' });
    expect(ctx.conversation).toEqual({ id: 'c1', title: '读书会' });
    expect(ctx.abortSignal).toBeInstanceOf(AbortSignal);
    expect(ctx.abortSignal.aborted).toBe(false);
    expect(ctx.env).toEqual({ LUOLI_TEST_DICE_KEY: 'k' });

    // 工具定义随每一步发出；第二次请求末尾是这次调用与结果
    expect(requestOf(model, 0).tools).toMatchObject([
      { type: 'function', name: 'dice', description: '掷一个骰子' },
    ]);
    expect(requestOf(model, 0).toolChoice).toEqual({ type: 'auto' });
    expect(requestOf(model, 1).tools).toEqual(requestOf(model, 0).tools);
    expect(messagesOf(model, 1).slice(-2)).toEqual([
      'assistant: <call dice {"sides":6,"label":"d"}>',
      'tool: <result dice {"type":"json","value":{"value":4,"label":"d"}}>',
    ]);

    expect(chunks.some((chunk) => chunk.type === 'error')).toBe(false);
    const reply = (await conversation.messages())[1];
    expect(reply?.parts).toMatchObject([
      { type: 'step-start' },
      {
        type: 'tool-dice',
        toolCallId: 'call-dice',
        state: 'output-available',
        input: { sides: 6, label: 'd' },
        output: { value: 4, label: 'd' },
      },
      { type: 'step-start' },
      { type: 'text', text: '掷出了 4' },
    ]);
    expect(logsOf(entries, 'reply.end')[0]?.fields).toMatchObject({
      outcome: 'completed',
      steps: 2,
      toolCalls: 1,
    });
  });

  it('工具的日志每条自动带上会话 id、回复 id、工具名与 toolCallId', async () => {
    const noisy = defineTool({
      name: 'noisy',
      description: '记日志',
      input: z.object({}),
      execute: (_input, ctx) => {
        ctx.logger.info({ detail: 1 }, 'noisy.info');
        ctx.logger.warn({ toolCallId: '伪造' }, 'noisy.warn');
        return 'ok';
      },
    });
    const model = scriptedModel(calls(call('noisy', {}, 'call-7')), answer('好'));
    const { entries, round } = setup({ model, definitions: [noisy] });

    await round('记一下');

    const replyId = logsOf(entries, 'reply.end')[0]?.fields.replyId;
    expect(replyId).toEqual(expect.any(String));
    const own = { conversationId: 'c1', replyId, tool: 'noisy', toolCallId: 'call-7' };
    expect(logsOf(entries, 'noisy.info')[0]).toMatchObject({
      level: 'info',
      fields: { ...own, detail: 1 },
    });
    expect(logsOf(entries, 'noisy.warn')[0]).toMatchObject({ level: 'warn', fields: own });
    // 字符串结果原样交给模型，结果长度是它的字符数
    expect(logsOf(entries, 'tool.end')[0]?.fields.resultLength).toBe(2);
  });

  it('一步里的两个调用并发执行：两个都等到对方开始才返回', async () => {
    let started = 0;
    let bothStarted: () => void = () => {};
    const together = new Promise<void>((resolve) => (bothStarted = resolve));
    const meet = defineTool({
      name: 'meet',
      description: '等对方',
      input: z.object({ who: z.string() }),
      execute: async ({ who }) => {
        if (++started === 2) bothStarted();
        await together;
        return `${who} 到了`;
      },
    });
    const model = scriptedModel(
      calls(call('meet', { who: 'a' }, 'call-a'), call('meet', { who: 'b' }, 'call-b')),
      answer('都到了'),
    );
    // 串行执行时第一个永远等不到第二个，到时限以超时结束
    const { entries, round } = setup({ model, definitions: [meet], timeouts: { toolMs: 500 } });

    await round('集合');

    expect(toolResultsOf(model, 1)).toEqual({
      'call-a': { type: 'text', value: 'a 到了' },
      'call-b': { type: 'text', value: 'b 到了' },
    });
    expect(logsOf(entries, 'tool.end').map((e) => e.fields.outcome)).toEqual([
      'completed',
      'completed',
    ]);
  });
});

describe('上限与收尾', () => {
  it('maxSteps 为 2：第 2 步是收尾步，toolChoice 为 none，工具定义与 system 照旧，末尾是收尾提示；历史里没有这条提示', async () => {
    const dice = diceTool();
    const model = scriptedModel(calls(call('dice', { sides: 6 })), answer('先到这里'));
    const { conversation, entries, round } = setup({
      model,
      definitions: [dice.definition],
      maxSteps: 2,
    });

    await round('一直掷');

    expect(model.doStreamCalls).toHaveLength(2);
    expect(requestOf(model, 0).toolChoice).toEqual({ type: 'auto' });
    expect(requestOf(model, 1).toolChoice).toEqual({ type: 'none' });
    expect(requestOf(model, 1).tools).toEqual(requestOf(model, 0).tools);
    expect(requestOf(model, 1).prompt[0]).toEqual(requestOf(model, 0).prompt[0]);
    // 第 2 步的消息：第 1 步的全部、这次调用与结果，末尾是不包标签的收尾提示
    expect(messagesOf(model, 1)).toEqual([
      ...messagesOf(model, 0),
      'assistant: <call dice {"sides":6,"label":"d"}>',
      'tool: <result dice {"type":"json","value":{"value":4,"label":"d"}}>',
      `user: ${toolLimitText}`,
    ]);

    const stored = JSON.stringify(await conversation.messages());
    expect(stored).not.toContain(toolLimitText);
    expect(logsOf(entries, 'reply.limit').map((e) => [e.level, e.fields])).toEqual([
      ['info', expect.objectContaining({ conversationId: 'c1', reason: 'steps', step: 2 })],
    ]);
    expect(logsOf(entries, 'reply.end')[0]?.fields).toMatchObject({
      outcome: 'completed',
      steps: 2,
      toolCalls: 1,
    });
  });

  it('maxSteps 为 1：第一步就是收尾步', async () => {
    const model = scriptedModel(answer('不调工具'));
    const { entries, round } = setup({ model, definitions: [diceTool().definition], maxSteps: 1 });

    await round('掷一下');

    expect(requestOf(model, 0).toolChoice).toEqual({ type: 'none' });
    expect(requestOf(model, 0).tools).toHaveLength(1);
    expect(messagesOf(model, 0).at(-1)).toBe(`user: ${toolLimitText}`);
    expect(logsOf(entries, 'reply.limit')[0]?.fields).toMatchObject({ reason: 'steps', step: 1 });
  });

  it('总时长：回复开始已超过 replyMs 时，下一步是收尾步', async () => {
    const slow = defineTool({
      name: 'slow',
      description: '耗时',
      input: z.object({}),
      execute: () => {
        vi.setSystemTime(Date.now() + 2000);
        return 'done';
      },
    });
    const model = scriptedModel(calls(call('slow', {})), answer('超时了，先说到这'));
    const { entries, round } = setup({
      model,
      definitions: [slow],
      timeouts: { replyMs: 1000 },
    });

    await round('慢慢来');

    expect(requestOf(model, 0).toolChoice).toEqual({ type: 'auto' });
    expect(requestOf(model, 1).toolChoice).toEqual({ type: 'none' });
    expect(messagesOf(model, 1).at(-1)).toBe(`user: ${toolLimitText}`);
    expect(logsOf(entries, 'reply.limit')[0]?.fields).toMatchObject({ reason: 'time', step: 2 });
  });

  it('收尾步里模型不理会 toolChoice 仍调工具：工具不执行、不再请求，SDK 按 ToolChoiceViolationError 报错，回复失败', async () => {
    const dice = diceTool();
    const model = scriptedModel(
      calls(call('dice', { sides: 6 }, 'c1')),
      calls(text('再掷一次'), call('dice', { sides: 8 }, 'c2')),
    );
    const { conversation, entries, round } = setup({
      model,
      definitions: [dice.definition],
      maxSteps: 2,
    });

    const chunks = await round('一直掷');

    expect(model.doStreamCalls).toHaveLength(2);
    expect(dice.received).toHaveLength(1);
    expect(chunks.filter((chunk) => chunk.type === 'error')).toHaveLength(1);
    expect((await conversation.messages()).map((m) => m.role)).toEqual(['user']);
    expect(logsOf(entries, 'reply.failed')[0]?.fields).toMatchObject({
      error: { type: 'AI_ToolChoiceViolationError' },
      steps: 2,
      toolCalls: 1,
    });
  });
});

describe('工具出错', () => {
  it('工具抛错：模型收到错误说明，循环继续，回复正常完成；存进历史的 errorText 与模型看到的相同，以后的回复里也一样', async () => {
    const weather = defineTool({
      name: 'weather',
      description: '查天气',
      input: z.object({ city: z.string() }),
      execute: (): string => {
        throw new Error('城市不存在');
      },
    });
    const model = scriptedModel(
      calls(call('weather', { city: '火星' })),
      answer('查不到'),
      answer('还是查不到'),
    );
    const { conversation, entries, round } = setup({ model, definitions: [weather] });

    const chunks = await round('火星天气');

    const seen = { type: 'error-text', value: 'Error: 城市不存在' };
    expect(toolResultsOf(model, 1)).toEqual({ 'call-weather': seen });
    expect(chunks.some((chunk) => chunk.type === 'error')).toBe(false);
    expect(logsOf(entries, 'reply.end')[0]?.fields).toMatchObject({ outcome: 'completed' });
    expect(logsOf(entries, 'reply.failed')).toHaveLength(0);
    expect(logsOf(entries, 'tool.end').map((e) => [e.level, e.fields])).toEqual([
      ['warn', expect.objectContaining({ outcome: 'failed', errorType: 'Error' })],
    ]);

    const [part] = toolPartsOf((await conversation.messages())[1]);
    expect(part).toMatchObject({ state: 'output-error', errorText: seen.value });

    await round('再查一次');
    expect(toolResultsOf(model, 2)).toEqual({ 'call-weather': seen });
  });

  it('工具超时：不理会中止信号、永不返回的工具到时以超时结束，模型收到超时说明，循环继续；它的中止信号已触发；工具自己的时限优先', async () => {
    let signal: AbortSignal | undefined;
    const stuck = defineTool({
      name: 'stuck',
      description: '卡住',
      input: z.object({}),
      timeoutMs: 50,
      execute: (_input, ctx) => {
        signal = ctx.abortSignal;
        return new Promise<never>(() => {});
      },
    });
    const model = scriptedModel(calls(call('stuck', {})), answer('工具超时了'));
    // 默认时限很长：用的是工具自己的 50 毫秒
    const { conversation, entries, round } = setup({
      model,
      definitions: [stuck],
      timeouts: { toolMs: 60_000 },
    });

    const chunks = await round('试试');

    expect(toolResultsOf(model, 1)).toEqual({
      'call-stuck': { type: 'error-text', value: '工具执行超时（0.05 秒）' },
    });
    expect(signal?.aborted).toBe(true);
    expect(chunks.some((chunk) => chunk.type === 'error')).toBe(false);
    expect(logsOf(entries, 'tool.end').map((e) => [e.level, e.fields.outcome])).toEqual([
      ['warn', 'timeout'],
    ]);
    expect(logsOf(entries, 'reply.end')[0]?.fields).toMatchObject({ outcome: 'completed' });
    const [part] = toolPartsOf((await conversation.messages())[1]);
    expect(part).toMatchObject({ state: 'output-error', errorText: '工具执行超时（0.05 秒）' });
  });

  it('工具没有声明时限时用会话的默认值', async () => {
    const stuck = defineTool({
      name: 'stuck',
      description: '卡住',
      input: z.object({}),
      execute: () => new Promise<never>(() => {}),
    });
    const model = scriptedModel(calls(call('stuck', {})), answer('工具超时了'));
    const { round } = setup({ model, definitions: [stuck], timeouts: { toolMs: 30 } });

    await round('试试');

    expect(toolResultsOf(model, 1)).toEqual({
      'call-stuck': { type: 'error-text', value: '工具执行超时（0.03 秒）' },
    });
  });

  it('参数不合结构、调了不存在的工具：不执行，模型收到错误说明，循环继续，各记一条 tool.end', async () => {
    const dice = diceTool();
    const model = scriptedModel(
      calls(call('dice', { sides: 'six' }, 'c1'), call('nope', {}, 'c2')),
      answer('参数错了'),
    );
    const { conversation, entries, round } = setup({ model, definitions: [dice.definition] });

    const chunks = await round('掷个骰子');

    expect(dice.received).toHaveLength(0);
    const results = toolResultsOf(model, 1) as Record<string, { type: string; value: string }>;
    expect(results.c1?.type).toBe('error-text');
    expect(results.c1?.value).toMatch(/^AI_InvalidToolInputError: /);
    expect(results.c2?.type).toBe('error-text');
    expect(results.c2?.value).toMatch(/^AI_NoSuchToolError: /);
    expect(chunks.some((chunk) => chunk.type === 'error')).toBe(false);
    expect(logsOf(entries, 'reply.end')[0]?.fields).toMatchObject({
      outcome: 'completed',
      toolCalls: 2,
    });
    expect(logsOf(entries, 'tool.end').map((e) => [e.level, e.fields])).toEqual([
      [
        'warn',
        expect.objectContaining({
          tool: 'dice',
          toolCallId: 'c1',
          step: 1,
          outcome: 'failed',
          errorType: 'InvalidToolInputError',
        }),
      ],
      [
        'warn',
        expect.objectContaining({
          tool: 'nope',
          toolCallId: 'c2',
          step: 1,
          outcome: 'failed',
          errorType: 'NoSuchToolError',
        }),
      ],
    ]);
    // 存进历史的 errorText 与模型看到的相同
    const parts = toolPartsOf((await conversation.messages())[1]);
    expect(parts.map((part) => [part.toolCallId, part.state, part.errorText])).toEqual([
      ['c1', 'output-error', results.c1?.value],
      ['c2', 'output-error', results.c2?.value],
    ]);
  });

  it('结果转不成 JSON：按失败处理，模型收到说明，回复照常完成', async () => {
    const big = defineTool({
      name: 'big',
      description: '大数',
      input: z.object({}),
      execute: () => ({ value: 1n }),
    });
    const model = scriptedModel(calls(call('big', {})), answer('出错了'));
    const { entries, round } = setup({ model, definitions: [big] });

    await round('算一下');

    const results = toolResultsOf(model, 1) as Record<string, { type: string; value: string }>;
    expect(results['call-big']?.type).toBe('error-text');
    expect(results['call-big']?.value).toMatch(/^工具的结果无法转成 JSON：TypeError: /);
    expect(logsOf(entries, 'tool.end')[0]?.fields).toMatchObject({
      outcome: 'failed',
      errorType: 'TypeError',
    });
    expect(logsOf(entries, 'reply.end')[0]?.fields).toMatchObject({ outcome: 'completed' });
  });
});

describe('中止', () => {
  it('工具执行中用户中止：工具的中止信号触发，回复按中止结束，tool.end 为 aborted；之后照常回复', async () => {
    const controller = new AbortController();
    let signal: AbortSignal | undefined;
    const slow = defineTool({
      name: 'slow',
      description: '耗时',
      input: z.object({}),
      execute: (_input, ctx) => {
        signal = ctx.abortSignal;
        setTimeout(() => controller.abort(), 10);
        return new Promise<never>(() => {});
      },
    });
    const model = scriptedModel(calls(text('我查一下'), call('slow', {})), answer('接着说'));
    const { conversation, entries, round } = setup({ model, definitions: [slow] });

    const chunks = await round('查查看', controller.signal);

    expect(signal?.aborted).toBe(true);
    expect(chunks.at(-1)?.type).toBe('abort');
    expect(chunks.some((chunk) => chunk.type === 'error')).toBe(false);
    expect(logsOf(entries, 'reply.end')[0]?.fields).toMatchObject({
      outcome: 'aborted',
      saved: true,
      steps: 1,
      toolCalls: 1,
    });
    expect(logsOf(entries, 'reply.failed')).toHaveLength(0);
    expect(logsOf(entries, 'tool.end').map((e) => [e.level, e.fields.outcome])).toEqual([
      ['info', 'aborted'],
    ]);
    // 半截照常写入并标记；工具段停在没有结果的状态
    const saved = (await conversation.messages())[1];
    expect(saved?.metadata?.aborted).toBe(true);
    expect(toolPartsOf(saved).map((part) => part.state)).toEqual(['input-available']);

    // 没有结果的工具调用不发给模型，下一次请求不会被拒
    const next = await round('然后呢');
    expect(next.some((chunk) => chunk.type === 'error')).toBe(false);
    expect(messagesOf(model, 1).slice(1)).toEqual([
      'assistant: 我查一下\n（回复被中止）',
      expect.stringContaining('然后呢'),
    ]);
  });
});

describe('与重试、超时的配合', () => {
  it('第 2 步流式重试：第 1 步的工具只执行一次；重试按步计数，每步都有自己的次数；历史里没有失败那次的半截', async () => {
    const dice = diceTool();
    const model = scriptedModel(
      // 第 1 步：先说了半句、开始调工具时出错，重新生成后调工具
      failsAfter(...text('让我').slice(0, -1), ...call('dice', { sides: 6 }, 'c0').slice(0, 1)),
      calls(call('dice', { sides: 6 }, 'c1')),
      // 第 2 步：说了半句出错，重新生成后回答
      failsAfter(...text('结果').slice(0, -1)),
      answer('掷出了 4'),
    );
    const { conversation, entries, round } = setup({
      model,
      definitions: [dice.definition],
      maxRetries: 1,
    });

    const chunks = await round('掷个骰子');

    expect(dice.received).toHaveLength(1);
    expect(trace(chunks)).toEqual([
      'start-step',
      'text-start',
      'text:让我',
      'text-end',
      'retry:stream/1',
      'reset-step',
      'tool-input-start',
      'tool-input-available',
      'tool-output-available',
      'finish-step',
      'start-step',
      'text-start',
      'text:结果',
      'text-end',
      'retry:stream/1',
      'reset-step',
      'text-start',
      'text:掷出了 4',
      'text-end',
      'finish-step',
    ]);
    const reply = (await conversation.messages())[1];
    expect(reply?.parts).toMatchObject([
      { type: 'step-start' },
      { type: 'tool-dice', toolCallId: 'c1', state: 'output-available' },
      { type: 'step-start' },
      { type: 'text', text: '掷出了 4' },
    ]);
    expect(reply?.parts).toHaveLength(4);
    expect(
      logsOf(entries, 'model.attempt').map((e) => [e.fields.step, e.fields.willRetry]),
    ).toEqual([
      [1, true],
      [1, undefined],
      [2, true],
      [2, undefined],
    ]);
    expect(logsOf(entries, 'reply.end')[0]?.fields).toMatchObject({
      outcome: 'completed',
      attempts: 4,
      streamRetries: 2,
      steps: 2,
      toolCalls: 1,
    });
  });

  it('请求阶段的重试同样按步计数', async () => {
    const httpError = new APICallError({
      message: 'HTTP 429',
      url: 'http://mock.test/v1/chat/completions',
      requestBodyValues: {},
      statusCode: 429,
      responseHeaders: { 'retry-after-ms': '0' },
    });
    const model = scriptedModel(
      httpError,
      calls(call('dice', { sides: 6 })),
      httpError,
      answer('好'),
    );
    const { round } = setup({ model, definitions: [diceTool().definition], maxRetries: 1 });

    const chunks = await round('掷');

    expect(chunks.filter((chunk) => chunk.type === 'data-retry').map((c) => c.data)).toEqual([
      { phase: 'request', attempt: 1, maxRetries: 1, statusCode: 429 },
      { phase: 'request', attempt: 1, maxRetries: 1, statusCode: 429 },
    ]);
    expect(chunks.at(-1)?.type).toBe('finish');
  });

  it('工具执行期间不计模型的首段与段间超时', async () => {
    const slow = defineTool({
      name: 'slow',
      description: '耗时',
      input: z.object({}),
      execute: () => new Promise((resolve) => setTimeout(() => resolve('done'), 150)),
    });
    const model = scriptedModel(calls(text('稍等'), call('slow', {})), answer('好了'));
    const { conversation, round } = setup({
      model,
      definitions: [slow],
      timeouts: { firstChunkMs: 50, chunkMs: 50 },
    });

    const chunks = await round('慢慢来');

    expect(chunks.at(-1)?.type).toBe('finish');
    expect((await conversation.messages()).map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('第 2 步等不到第一段输出：报首段超时（看这一步，不受第 1 步的输出影响）；回复失败，有 steps 与 toolCalls', async () => {
    const model = scriptedModel(calls(text('我查一下'), call('dice', { sides: 6 })), hanging([]));
    const { conversation, entries, round } = setup({
      model,
      definitions: [diceTool().definition],
      timeouts: { firstChunkMs: 50, chunkMs: 50 },
    });

    const chunks = await round('掷');

    expect(chunks.at(-1)).toEqual({
      type: 'error',
      errorText: '等待模型输出超时：0.05 秒内没有收到第一段输出',
    });
    expect((await conversation.messages()).map((m) => m.role)).toEqual(['user']);
    expect(logsOf(entries, 'reply.failed')[0]?.fields).toMatchObject({ steps: 2, toolCalls: 1 });
  });

  it('只输出了工具调用参数就停住：算已有输出，报段间超时', async () => {
    const model = scriptedModel(hanging(call('dice', { sides: 6 }).slice(0, 2)));
    const { round } = setup({
      model,
      definitions: [diceTool().definition],
      timeouts: { firstChunkMs: 50, chunkMs: 80 },
    });

    const chunks = await round('掷');

    expect(chunks.at(-1)).toEqual({
      type: 'error',
      errorText: '等待模型输出超时：两段输出之间超过 0.08 秒',
    });
  });
});

describe('拒收图片后的恢复', () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
  const rejected = new APICallError({
    message: 'HTTP 400',
    url: 'http://mock.test/v1/chat/completions',
    requestBodyValues: {},
    statusCode: 400,
  });

  it('第 1 步还没有输出就被拒收：换成占位重试，重试的请求照旧带工具，从第 1 步数起', async () => {
    const dice = diceTool();
    const model = scriptedModel(
      rejected,
      calls(call('dice', { sides: 6 })),
      answer('图片看不了，骰子是 4'),
    );
    const { conversation, entries } = setup({ model, definitions: [dice.definition], maxSteps: 2 });

    await conversation.append({
      author: alice,
      text: '看图',
      files: [{ data: png, mediaType: 'image/png' }],
    });
    await readAll(conversation.reply());

    expect(model.doStreamCalls).toHaveLength(3);
    expect(messagesOf(model, 1)[0]).toContain('[图片无法读取]');
    expect(requestOf(model, 1).tools).toEqual(requestOf(model, 0).tools);
    expect(requestOf(model, 1).toolChoice).toEqual({ type: 'auto' });
    expect(requestOf(model, 2).toolChoice).toEqual({ type: 'none' });
    expect(logsOf(entries, 'reply.end')[0]?.fields).toMatchObject({
      outcome: 'completed',
      imageFallback: true,
      steps: 2,
      toolCalls: 1,
    });
  });

  it('第 1 步已经调过工具、第 2 步才被拒收：不恢复，回复失败', async () => {
    const model = scriptedModel(calls(call('dice', { sides: 6 })), rejected, answer('不该用到'));
    const { conversation, entries } = setup({ model, definitions: [diceTool().definition] });

    await conversation.append({
      author: alice,
      text: '看图',
      files: [{ data: png, mediaType: 'image/png' }],
    });
    const chunks = await readAll(conversation.reply());

    expect(model.doStreamCalls).toHaveLength(2);
    expect(chunks).toContainEqual({ type: 'error', errorText: 'HTTP 400' });
    expect(logsOf(entries, 'reply.failed')).toHaveLength(1);
    expect(logsOf(entries, 'reply.image_fallback')).toHaveLength(0);
  });
});

describe('日志', () => {
  it('tool.end 字段齐全（结果长度是结果转成 JSON 的字符数），日志里找不到参数与结果的内容；reply.end 有 steps 与 toolCalls', async () => {
    const echo = defineTool({
      name: 'echo',
      description: '回声',
      input: z.object({ query: z.string() }),
      execute: ({ query }) => ({ echoed: `${query}-结果特征-5d7e` }),
    });
    const model = scriptedModel(calls(call('echo', { query: '参数特征-91c2' })), answer('好'));
    const { entries, round } = setup({ model, definitions: [echo] });

    await round('回声');

    const output = JSON.stringify({ echoed: '参数特征-91c2-结果特征-5d7e' });
    expect(logsOf(entries, 'tool.end')).toEqual([
      {
        level: 'info',
        msg: 'tool.end',
        fields: {
          conversationId: 'c1',
          replyId: expect.any(String),
          modelId: 'mock-model-id',
          tool: 'echo',
          toolCallId: 'call-echo',
          step: 1,
          durationMs: expect.any(Number),
          outcome: 'completed',
          resultLength: output.length,
        },
      },
    ]);
    expect(logsOf(entries, 'reply.end')[0]?.fields).toMatchObject({ steps: 2, toolCalls: 1 });
    const all = JSON.stringify(entries);
    expect(all).not.toContain('参数特征-91c2');
    expect(all).not.toContain('结果特征-5d7e');
  });

  it('工具抛出的错误只记类型，不记错误消息', async () => {
    const leaky = defineTool({
      name: 'leaky',
      description: '出错',
      input: z.object({ query: z.string() }),
      execute: ({ query }): string => {
        throw new TypeError(`查不到 ${query}`);
      },
    });
    const model = scriptedModel(
      calls(call('leaky', { query: '参数特征-91c2' }), call('leaky', { oops: 1 }, 'c2')),
      answer('好'),
    );
    const { entries, round } = setup({ model, definitions: [leaky] });

    await round('查');

    // 不合规的调用在流里记，执行出错的在执行时记，先后不定
    expect(
      logsOf(entries, 'tool.end')
        .map((e) => e.fields.errorType)
        .sort(),
    ).toEqual(['InvalidToolInputError', 'TypeError']);
    expect(JSON.stringify(entries)).not.toContain('参数特征-91c2');
    expect(JSON.stringify(entries)).not.toContain('oops');
  });
});

describe('摘要请求', () => {
  it('装了工具时带上同样的工具定义与 system，toolChoice 为 none，历史里的工具调用照常发出，不执行工具', async () => {
    const dice = diceTool();
    const model = scriptedModel(
      calls(call('dice', { sides: 6 })),
      answer('掷出了 4'),
      answer('Alice 掷了骰子，得 4。'),
    );
    const { store, round } = setup({
      model,
      definitions: [dice.definition],
      segments: { idleMs: 30 },
    });

    await round('掷个骰子');
    vi.setSystemTime(Date.now() + 60_000);
    await until(async () => (await store.currentSegment()).startReason === 'idle');

    const summary = requestOf(model, 2);
    expect(summary.tools).toEqual(requestOf(model, 0).tools);
    expect(summary.toolChoice).toEqual({ type: 'none' });
    expect(summary.prompt[0]).toEqual(requestOf(model, 0).prompt[0]);
    expect(messagesOf(model, 2).slice(1, 3)).toEqual([
      'assistant: <call dice {"sides":6,"label":"d"}>',
      'tool: <result dice {"type":"json","value":{"value":4,"label":"d"}}>',
    ]);
    expect(dice.received).toHaveLength(1);
    expect((await store.currentSegment()).priorSummary).toBe('Alice 掷了骰子，得 4。');
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
