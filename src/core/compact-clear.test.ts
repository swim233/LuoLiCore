import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { APICallError } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  ConversationBusyError,
  createConversation,
  createMemoryStore,
  defineTool,
  installTools,
  openSqliteStorage,
  PromptFileError,
  type Conversation,
  type ConversationStore,
  type InstalledTool,
  type Logger,
  type MessageChunk,
  type PromptSource,
  type SegmentOptions,
} from './index.js';
import { testPrompts } from './test-prompts.js';

type StreamResult = Awaited<ReturnType<MockLanguageModelV4['doStream']>>;
type StreamPart = StreamResult['stream'] extends ReadableStream<infer P> ? P : never;

const alice = { id: 'u-alice', name: 'Alice' };
/** 执行压缩、清空的人 */
const bob = { id: 'u-bob', name: 'Bob' };
const carol = { id: 'u-carol', name: 'Carol' };
const instructions = '你是测试助手';

// 固定时区与时钟：2026-10-30T06:02Z 在上海是 14:02。只假冒 Date，计时器照常走
const start = '2026-10-30T06:02:00.000Z';
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
  vi.useFakeTimers({ toFake: ['Date'], now: new Date(start) });
});
const opened: Conversation[] = [];
const cleanups: Array<() => Promise<void>> = [];
// 先放行测试里停住的存储（见 slowStore），关闭会话时才不会一直等着
const releases: Array<() => void> = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
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

/** 一个放行开关：gate 在 release() 之前一直挂着 */
function gated(): { gate: Promise<void>; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  return { gate, release };
}

/** 永远不放行 */
const never = new Promise<void>(() => {});

/**
 * 模型的一次调用：回复文本（可带输入用量，或等 gate 放行后才输出），或请求失败（fail：等 gate 放行后
 * 才失败）
 */
type Turn =
  | string
  | { text: string; input?: number; gate?: Promise<void> }
  | { fail: Error; gate: Promise<void> }
  | Error;

function textParts(text: string): StreamPart[] {
  return [
    { type: 'text-start', id: 't' },
    { type: 'text-delta', id: 't', delta: text },
    { type: 'text-end', id: 't' },
  ];
}

function finish(input: number): StreamPart {
  return {
    type: 'finish',
    finishReason: { unified: 'stop', raw: undefined },
    usage: {
      inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 1, text: 1, reasoning: undefined },
    },
  };
}

/** 按顺序回应每次调用（回复与摘要都算）；中止时像 fetch 一样以 AbortError 出错 */
function scripted(...turns: Turn[]): MockLanguageModelV4 {
  let call = 0;
  return new MockLanguageModelV4({
    doStream: async ({ abortSignal }) => {
      const turn = turns[call++];
      if (turn === undefined) throw new Error('mock 模型没有更多脚本');
      if (turn instanceof Error) throw turn;
      if (typeof turn !== 'string' && 'fail' in turn) {
        await turn.gate;
        throw turn.fail;
      }
      const { text, input = 1, gate } = typeof turn === 'string' ? { text: turn } : turn;
      let aborted = false;
      return {
        stream: new ReadableStream<StreamPart>({
          async start(controller) {
            abortSignal?.addEventListener(
              'abort',
              () => {
                aborted = true;
                controller.error(new DOMException('This operation was aborted', 'AbortError'));
              },
              { once: true },
            );
            await gate;
            if (aborted) return;
            for (const part of [...textParts(text), finish(input)]) controller.enqueue(part);
            controller.close();
          },
        }),
      };
    },
  });
}

function unauthorized(): APICallError {
  return new APICallError({
    message: 'Unauthorized',
    url: 'https://example.invalid/v1/chat/completions',
    requestBodyValues: {},
    statusCode: 401,
    isRetryable: false,
  });
}

/** 模型第 call 次调用收到的 prompt（含 system），每条消息的内容拼成一段文本 */
function promptOf(model: MockLanguageModelV4, call: number): Array<{ role: string; text: string }> {
  return (model.doStreamCalls[call]?.prompt ?? []).map((m) => ({
    role: m.role,
    text:
      typeof m.content === 'string'
        ? m.content
        : m.content.map((part) => (part.type === 'text' ? part.text : `<${part.type}>`)).join(''),
  }));
}

const systemOf = (model: MockLanguageModelV4, call: number) => promptOf(model, call)[0]?.text;
const messagesOf = (model: MockLanguageModelV4, call: number) =>
  promptOf(model, call)
    .slice(1)
    .map((m) => m.text);

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
  turns,
  segments,
  store = createMemoryStore({ title: '读书会' }),
  prompts = testPrompts(instructions),
  tools,
  timeouts,
}: {
  turns: Turn[];
  segments?: SegmentOptions;
  store?: ConversationStore;
  prompts?: PromptSource;
  tools?: readonly InstalledTool[];
  timeouts?: { firstChunkMs?: number };
}) {
  const { logger, entries } = recordingLogger();
  const model = scripted(...turns);
  const conversation = createConversation({
    model,
    prompts,
    store,
    logger,
    conversationId: 'c1',
    segments,
    tools,
    timeouts,
  });
  opened.push(conversation);
  const round = async (text: string) => {
    await conversation.append({ author: alice, text });
    return readAll(conversation.reply());
  };
  return { conversation, model, store, entries, round };
}

/** 模型看到的一条用户消息；time 为当前 Date 所在分钟 */
function tagged(text: string, time = '2026-10-30 14:02'): string {
  return `<message from="Alice" uid="u-alice" time="${time}">\n${text}\n</message>`;
}

// 逐字核对摘要指令（测试用固定提示的原文），{范围}、{上限} 由调用方替换
function instruction(scope: string, maxChars: number): string {
  return `（以下为系统指令，非对话消息）

现在暂停对话。请为以上内容写一份摘要，供你之后继续参与这个会话时参考。这份摘要会替代原文：之后你只能看到摘要，以及摘要之后的新消息。

摘要范围：
- 「之前的对话摘要」里的全部内容（如果有）；
- ${scope}

写法：
- 用中性的第三人称客观记录，不用你的角色口吻，不写感想或评价。
- 提到人时写显示名，第一次出现时附上 uid，如「小明（uid 123456）」；没有 uid 的只写名字。改过名的注明「原名 某某」。
- 只记事实，不推测；不确定的不写。
- 保留以后可能用得上的信息：
  1. 每个人的身份、关系、偏好、习惯，以及透露过的个人信息（如宠物、工作、计划）；
  2. 正在进行或悬而未决的话题、问题、约定、待办，以及由谁负责；
  3. 大家对你提出的要求或纠正（如称呼、说话方式、不要做的事）；
  4. 重要的结论、决定，以及数字、日期、链接等具体信息；
  5. 图片中与对话有关的内容，用文字描述。
- 闲聊、寒暄、重复的内容省略，或一笔带过。
- 与之前的摘要合并：新信息与旧信息冲突时以新的为准；仍然有效的旧信息保留，过时的删去。
- 按主题分组，用简短的条目；需要时注明大致时间，如「10 月 30 日晚」。
- 总长度不超过 ${maxChars} 字。

只输出摘要正文，不要标题、开场白或结束语。`;
}

const wholeSegment = '本段的全部消息，以及其中你的回复。';
const titleSection = (title: string) => `## 当前会话\n\n名称：${title}`;
const summarySection = (summary: string) =>
  `## 之前的对话摘要\n\n以下是本会话更早内容的摘要，原文已不在上下文中。\n\n${summary}`;
const clearedSection = (time: string) => `## 之前的对话\n\n更早的对话已在 ${time} 被清空。`;
/** system 里各节的标题，按出现顺序 */
const headingsOf = (system: string | undefined) =>
  (system ?? '').split('\n\n').filter((block) => block.startsWith('## '));

/**
 * 包一层的存储：arm(method) 之后，下一次调用这个方法时停住，直到 release()；held 表示已经停住。
 * 用来让某一步「读到一半」，好插进别的操作
 */
function slowStore(base: ConversationStore = createMemoryStore({ title: '读书会' })) {
  let armed: 'list' | 'currentSegment' | undefined;
  const control = {
    held: false,
    ...gated(),
    arm: (method: 'list' | 'currentSegment') => (armed = method),
  };
  const hold = async (method: 'list' | 'currentSegment') => {
    if (armed !== method) return;
    armed = undefined;
    control.held = true;
    await control.gate;
  };
  const store: ConversationStore = {
    ...base,
    list: async (range) => {
      await hold('list');
      return base.list(range);
    },
    currentSegment: async () => {
      await hold('currentSegment');
      return base.currentSegment();
    },
  };
  releases.push(control.release);
  return { store, control };
}

/** 各段的起点与原因 */
async function segmentsOf(store: ConversationStore) {
  return (await store.segments()).map((segment) => [segment.startSeq, segment.startReason]);
}

/** 一个调用失败的 promise 的错误 */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('没有失败');
    },
    (error: unknown) => error,
  );
}

describe('手动压缩', () => {
  it('摘要请求与同一时刻的回复相同：同样的 system、整段的消息与工具定义，末尾多一条摘要指令，范围是整段', async () => {
    const dice = defineTool({
      name: 'dice',
      description: '掷一个骰子',
      input: z.object({ sides: z.number() }),
      execute: async () => 4,
    });
    const { conversation, model, round } = setup({
      turns: ['答1', '答2', '摘要'],
      tools: installTools([dice], {}).tools,
      segments: { summaryMaxChars: 800 },
    });
    await round('第1句');
    advance(3 * 60_000);
    await round('第2句');

    expect(await conversation.compact({ by: bob })).toBe('compacted');

    // 此刻回复的请求是上一次回复的请求加上那次回复；摘要请求在它末尾多一条指令
    expect(promptOf(model, 2)).toEqual([
      ...promptOf(model, 1),
      { role: 'assistant', text: '答2' },
      { role: 'user', text: instruction(wholeSegment, 800) },
    ]);
    expect(messagesOf(model, 2).slice(0, 4)).toEqual([
      tagged('第1句'),
      '答1',
      tagged('第2句', '2026-10-30 14:05'),
      '答2',
    ]);
    expect(model.doStreamCalls[2]?.tools).toHaveLength(1);
    expect(model.doStreamCalls[2]?.tools).toEqual(model.doStreamCalls[1]?.tools);
  });

  it('成功：从最后一条消息之后新开一段，原因 manual，带摘要与执行人；之后的回复 system 里是新摘要，消息只有压缩之后的', async () => {
    const { conversation, model, store, entries, round } = setup({
      turns: ['答1', '  Alice 打了招呼。\n', '答2'],
    });
    await round('第1句');
    advance(60_000);

    expect(await conversation.compact({ by: bob })).toBe('compacted');

    expect(await store.currentSegment()).toEqual({
      startSeq: 3,
      startReason: 'manual',
      conversationTitle: '读书会',
      priorSummary: 'Alice 打了招呼。',
      startedBy: bob,
      createdAt: '2026-10-30T06:03:00.000Z',
    });
    expect(await segmentsOf(store)).toEqual([
      [1, 'first'],
      [3, 'manual'],
    ]);
    expect((await store.calls()).map((c) => [c.purpose, c.summaryReason, c.outcome])).toEqual([
      ['reply', undefined, 'completed'],
      ['summary', 'manual', 'completed'],
    ]);
    expect(logsOf(entries, 'summary.end')[0]?.fields).toMatchObject({
      conversationId: 'c1',
      modelId: model.modelId,
      reason: 'manual',
      byId: 'u-bob',
      fromSeq: 1,
      toSeq: 2,
      startSeq: 3,
    });

    await round('第2句');
    expect(messagesOf(model, 2)).toEqual([tagged('第2句', '2026-10-30 14:03')]);
    const system = systemOf(model, 2);
    expect(headingsOf(system)).toEqual(['## 消息格式', '## 当前会话', '## 之前的对话摘要']);
    expect(
      system?.endsWith(`\n\n${titleSection('读书会')}\n\n${summarySection('Alice 打了招呼。')}`),
    ).toBe(true);
  });

  it('当前段的摘要并进新摘要：摘要请求的 system 带着之前的摘要', async () => {
    const { conversation, model, round } = setup({ turns: ['答1', '第一次', '答2', '第二次'] });
    await round('第1句');
    await conversation.compact({ by: bob });
    await round('第2句');

    expect(await conversation.compact({ by: bob })).toBe('compacted');

    expect(systemOf(model, 3)).toBe(systemOf(model, 2));
    expect(systemOf(model, 3)).toContain(summarySection('第一次'));
    expect(messagesOf(model, 3)).toEqual([tagged('第2句'), '答2', instruction(wholeSegment, 1500)]);
  });

  it('当前段没有消息（新会话、刚压缩过、刚清空过）：结果是 nothing-to-compact，不请求模型，段不变', async () => {
    const { conversation, model, store, round } = setup({ turns: ['答1', '摘要'] });

    expect(await conversation.compact({ by: bob })).toBe('nothing-to-compact');
    expect(model.doStreamCalls).toHaveLength(0);
    expect(await segmentsOf(store)).toEqual([[1, 'first']]);

    await round('第1句');
    expect(await conversation.compact({ by: bob })).toBe('compacted');
    const compacted = await store.segments();
    expect(await conversation.compact({ by: carol })).toBe('nothing-to-compact');
    expect(await store.segments()).toEqual(compacted);

    expect(await conversation.clear({ by: bob })).toBe('cleared');
    const cleared = await store.segments();
    expect(await conversation.compact({ by: carol })).toBe('nothing-to-compact');
    expect(await store.segments()).toEqual(cleared);

    expect(model.doStreamCalls).toHaveLength(2);
    expect(await store.calls()).toHaveLength(2);
  });

  it('请求出错：抛出错误，段不变，模型调用表记 failed、原因 manual；接着的回复输入超过阈值时自动压缩照常开始', async () => {
    const { conversation, model, store, entries, round } = setup({
      turns: [
        { text: '答1', input: 50 },
        unauthorized(),
        { text: '答2', input: 150 },
        '自动压缩的摘要',
      ],
      segments: { compressTokens: 100, keepMessages: 1 },
    });
    await round('第1句');
    advance(3 * 60_000);

    const error = await rejection(conversation.compact({ by: bob }));

    expect(error).toBeInstanceOf(Error);
    expect(await segmentsOf(store)).toEqual([[1, 'first']]);
    expect((await store.calls())[1]).toMatchObject({
      purpose: 'summary',
      summaryReason: 'manual',
      outcome: 'failed',
      error: 'APICallError 401',
    });
    expect(logsOf(entries, 'summary.failed')[0]).toMatchObject({
      level: 'error',
      fields: { reason: 'manual', byId: 'u-bob', error: { statusCode: 401 } },
    });

    // 手动压缩的失败不挡自动压缩：这一轮输入 150 超过阈值，马上在后台压缩
    await round('第2句');
    await until(async () => (await store.currentSegment()).startReason === 'compress');
    expect(model.doStreamCalls).toHaveLength(4);
    expect(await segmentsOf(store)).toEqual([
      [1, 'first'],
      [3, 'compress'],
    ]);
  });

  it.each([
    ['摘要为空', ' \n ', { outcome: 'empty' }, '摘要为空'],
    [
      '等第一段输出超时',
      { text: '摘要', gate: never },
      { outcome: 'failed', error: 'TimeoutError' },
      undefined,
    ],
  ] as const)(
    '%s：抛出错误，段不变，模型调用表照现有规则记一行',
    async (_name, turn, row, message) => {
      const { conversation, store, round } = setup({
        turns: ['答1', turn],
        timeouts: { firstChunkMs: 50 },
      });
      await round('第1句');

      const error = await rejection(conversation.compact({ by: bob }));

      expect(error).toBeInstanceOf(Error);
      if (message) expect((error as Error).message).toBe(message);
      expect(await segmentsOf(store)).toEqual([[1, 'first']]);
      expect((await store.calls())[1]).toMatchObject({ summaryReason: 'manual', ...row });
    },
  );

  it('提示词文件有误：抛出 PromptFileError，段不变，没有发出请求，不记模型调用', async () => {
    const base = testPrompts(instructions);
    let loads = 0;
    // 第二次读（压缩时）读到有误
    const prompts: PromptSource = {
      load: async () => {
        if (++loads === 2)
          throw new PromptFileError([{ file: 'prompts/summary.md', problems: [] }]);
        return base.load();
      },
    };
    const { conversation, model, store, entries, round } = setup({ turns: ['答1'], prompts });
    await round('第1句');

    const error = await rejection(conversation.compact({ by: bob }));

    expect(error).toBeInstanceOf(PromptFileError);
    expect(model.doStreamCalls).toHaveLength(1);
    expect(await segmentsOf(store)).toEqual([[1, 'first']]);
    expect(await store.calls()).toHaveLength(1);
    expect(logsOf(entries, 'summary.failed')[0]?.fields).toMatchObject({ reason: 'manual' });
  });

  it('abortSignal 中止：结果是 aborted，段不变，模型调用表记 aborted，记 summary.aborted 而不是失败', async () => {
    const { conversation, model, store, entries, round } = setup({
      turns: ['答1', { text: '摘要', gate: never }],
    });
    await round('第1句');
    const controller = new AbortController();
    const compacting = conversation.compact({ by: bob, abortSignal: controller.signal });
    await until(() => model.doStreamCalls.length === 2);

    controller.abort();

    expect(await compacting).toBe('aborted');
    expect(await segmentsOf(store)).toEqual([[1, 'first']]);
    expect((await store.calls())[1]).toMatchObject({
      purpose: 'summary',
      summaryReason: 'manual',
      outcome: 'aborted',
    });
    expect(logsOf(entries, 'summary.aborted')[0]?.fields).toMatchObject({
      reason: 'manual',
      byId: 'u-bob',
    });
    expect(logsOf(entries, 'summary.failed')).toHaveLength(0);
  });

  it('调用时信号已经中止：结果是 aborted，不请求模型，也不打断进行中的自动摘要', async () => {
    const { release, gate } = gated();
    const { conversation, model, store, round } = setup({
      turns: ['答1', { text: '空闲摘要', gate }],
      segments: { idleMs: 30 },
    });
    await round('第1句');
    advance(60_000);
    await until(() => model.doStreamCalls.length === 2);

    expect(await conversation.compact({ by: bob, abortSignal: AbortSignal.abort() })).toBe(
      'aborted',
    );

    release();
    await until(async () => (await store.currentSegment()).startReason === 'idle');
    expect(model.doStreamCalls).toHaveLength(2);
  });

  it('会话被关闭：结果是 aborted，段不变，模型调用表记 aborted', async () => {
    const { conversation, model, store, round } = setup({
      turns: ['答1', { text: '摘要', gate: never }],
    });
    await round('第1句');
    const compacting = conversation.compact({ by: bob });
    await until(() => model.doStreamCalls.length === 2);

    await conversation.close();

    expect(await compacting).toBe('aborted');
    expect(await segmentsOf(store)).toEqual([[1, 'first']]);
    expect((await store.calls())[1]).toMatchObject({ summaryReason: 'manual', outcome: 'aborted' });
    expect(await conversation.compact({ by: bob })).toBe('aborted');
  });

  it('压缩期间写入的消息归入新段；期间开始的回复等压缩结束，用的是新段', async () => {
    const { gate, release } = gated();
    const { conversation, model, store, round } = setup({
      turns: ['答1', { text: '压缩的摘要', gate }, '答2'],
    });
    await round('第1句');
    const compacting = conversation.compact({ by: bob });
    await until(() => model.doStreamCalls.length === 2);

    const during = await conversation.append({ author: alice, text: '压缩期间说的话' });
    const replying = readAll(conversation.reply());
    await sleep(50);
    // 还在等压缩：没有发出回复的请求
    expect(model.doStreamCalls).toHaveLength(2);

    release();
    expect(await compacting).toBe('compacted');
    await replying;

    expect(await store.currentSegment()).toMatchObject({ startSeq: 3, startReason: 'manual' });
    expect((await store.entry(during.id))?.seq).toBe(3);
    // 摘要请求里没有压缩期间的消息
    expect(messagesOf(model, 1)).toEqual([tagged('第1句'), '答1', instruction(wholeSegment, 1500)]);
    expect(messagesOf(model, 2)).toEqual([tagged('压缩期间说的话')]);
    expect(systemOf(model, 2)).toContain(summarySection('压缩的摘要'));
  });

  it.each(['失败', '被中止'] as const)(
    '压缩%s：期间开始的回复等它结束，照常用原来的段',
    async (name) => {
      const { gate, release } = gated();
      const { conversation, model, store, round } = setup({
        turns: ['答1', { fail: unauthorized(), gate }, '答2'],
      });
      await round('第1句');
      const controller = new AbortController();
      const compacting = conversation
        .compact({ by: bob, abortSignal: controller.signal })
        .catch(() => 'failed');
      await until(() => model.doStreamCalls.length === 2);
      await conversation.append({ author: alice, text: '第2句' });
      const replying = readAll(conversation.reply());
      await sleep(50);
      expect(model.doStreamCalls).toHaveLength(2);

      if (name === '被中止') controller.abort();
      else release();

      expect(await compacting).toBe(name === '被中止' ? 'aborted' : 'failed');
      await replying;
      expect(await segmentsOf(store)).toEqual([[1, 'first']]);
      expect(messagesOf(model, 2)).toEqual([tagged('第1句'), '答1', tagged('第2句')]);
    },
  );

  it('空闲切段进行中：中止它（不产生段，模型调用表记 aborted），手动的这次覆盖到最新的消息', async () => {
    const { conversation, model, store, entries, round } = setup({
      turns: ['答1', { text: '空闲摘要', gate: never }, '手动摘要'],
      segments: { idleMs: 30 },
    });
    await round('第1句');
    advance(60_000);
    await until(() => model.doStreamCalls.length === 2);
    await conversation.append({ author: alice, text: '空闲切段期间说的话' });

    expect(await conversation.compact({ by: bob })).toBe('compacted');

    expect(logsOf(entries, 'summary.aborted').map((e) => e.fields.reason)).toEqual(['idle']);
    expect(await segmentsOf(store)).toEqual([
      [1, 'first'],
      [4, 'manual'],
    ]);
    expect(await store.currentSegment()).toMatchObject({ priorSummary: '手动摘要' });
    expect(messagesOf(model, 2)).toEqual([
      tagged('第1句'),
      '答1',
      tagged('空闲切段期间说的话', '2026-10-30 14:03'),
      instruction(wholeSegment, 1500),
    ]);
    expect((await store.calls()).map((c) => [c.summaryReason, c.outcome])).toEqual([
      [undefined, 'completed'],
      ['idle', 'aborted'],
      ['manual', 'completed'],
    ]);
  });

  it('自动压缩进行中：中止它（不产生段），手动的这次覆盖整段，含自动压缩要保留的最近几条', async () => {
    const { conversation, model, store, entries, round } = setup({
      turns: [
        { text: '答1', input: 50 },
        { text: '答2', input: 150 },
        { text: '自动压缩的摘要', gate: never },
        '手动摘要',
      ],
      segments: { compressTokens: 100, keepMessages: 1 },
    });
    await round('第1句');
    advance(3 * 60_000);
    await round('第2句');
    await until(() => model.doStreamCalls.length === 3);

    expect(await conversation.compact({ by: bob })).toBe('compacted');

    expect(logsOf(entries, 'summary.aborted').map((e) => e.fields.reason)).toEqual(['compress']);
    expect(await segmentsOf(store)).toEqual([
      [1, 'first'],
      [5, 'manual'],
    ]);
    expect(messagesOf(model, 3)).toEqual([
      tagged('第1句'),
      '答1',
      tagged('第2句', '2026-10-30 14:05'),
      '答2',
      instruction(wholeSegment, 1500),
    ]);
    expect((await store.calls()).map((c) => [c.summaryReason, c.outcome])).toEqual([
      [undefined, 'completed'],
      [undefined, 'completed'],
      ['compress', 'aborted'],
      ['manual', 'completed'],
    ]);
  });
});

describe('手动操作与回复的先后', () => {
  // 回复照规矩不等自动压缩。手动操作还在等自动压缩停下时开始的回复，也要等手动操作结束
  it.each(['compact', 'clear'] as const)(
    '自动压缩进行中调用 %s、紧接着开始回复：回复等手动操作结束，用之后的段',
    async (operation) => {
      const manualGate = gated();
      const base = createMemoryStore({ title: '读书会' });
      // 清空写新段时停一下，好在这时写进一条消息（归入清空的段）
      const store: ConversationStore = {
        ...base,
        addSegment: async (segment) => {
          if (segment.startReason === 'clear') await manualGate.gate;
          return base.addSegment(segment);
        },
      };
      const { conversation, model, round } = setup({
        turns: [
          { text: '答1', input: 50 },
          { text: '答2', input: 150 },
          { text: '自动压缩的摘要', gate: never },
          ...(operation === 'compact' ? [{ text: '手动摘要', gate: manualGate.gate }] : []),
          '答3',
        ],
        segments: { compressTokens: 100, keepMessages: 1 },
        store,
      });
      await round('第1句');
      advance(3 * 60_000);
      await round('第2句');
      await until(() => model.doStreamCalls.length === 3);

      // 手动操作还在等自动压缩停下时，回复就开始了
      const manual =
        operation === 'compact'
          ? conversation.compact({ by: bob })
          : conversation.clear({ by: bob });
      const replying = readAll(conversation.reply());
      // 手动操作已经定好新段的起点（压缩发出了摘要请求、清空正在写新段）
      if (operation === 'compact') await until(() => model.doStreamCalls.length === 4);
      else await sleep(50);
      await conversation.append({ author: alice, text: '第3句' });
      manualGate.release();
      await manual;
      await replying;

      const reply = model.doStreamCalls.length - 1;
      expect(await store.currentSegment()).toMatchObject({
        startSeq: 5,
        startReason: operation === 'compact' ? 'manual' : 'clear',
      });
      expect(messagesOf(model, reply)).toEqual([tagged('第3句', '2026-10-30 14:05')]);
      expect(systemOf(model, reply)).toContain(
        operation === 'compact' ? summarySection('手动摘要') : clearedSection('2026-10-30 14:05'),
      );
    },
  );
});

describe('空闲检查读到一半时的手动操作', () => {
  it.each(['clear', 'compact'] as const)(
    '空闲检查正读着消息时调用 %s：手动操作等检查做完，检查不开始切段（不发摘要请求、不多出一段）',
    async (operation) => {
      const { store, control } = slowStore();
      const { conversation, model, entries, round } = setup({
        turns: operation === 'compact' ? ['答1', '手动摘要'] : ['答1'],
        segments: { idleMs: 30 },
        store,
      });
      await round('第1句');
      // 空闲检查读当前段的消息时停住：它已经算好要从哪里切段
      control.arm('list');
      advance(60_000);
      await until(() => control.held);

      const manual =
        operation === 'compact'
          ? conversation.compact({ by: bob })
          : conversation.clear({ by: bob });
      await sleep(30);
      // 手动操作在等这次检查做完
      expect(model.doStreamCalls).toHaveLength(1);
      expect(await segmentsOf(store)).toEqual([[1, 'first']]);

      control.release();
      expect(await manual).toBe(operation === 'compact' ? 'compacted' : 'cleared');
      await sleep(50);

      // 检查算好的计划没有开始：没有空闲摘要的请求，也没有多出一段
      expect(await segmentsOf(store)).toEqual([
        [1, 'first'],
        [3, operation === 'compact' ? 'manual' : 'clear'],
      ]);
      expect((await store.calls()).map((c) => [c.purpose, c.summaryReason])).toEqual([
        ['reply', undefined],
        ...(operation === 'compact' ? [['summary', 'manual']] : []),
      ]);
      expect(logsOf(entries, 'summary.duplicate')).toHaveLength(0);
      if (operation === 'compact') {
        // 手动的这次覆盖到最新的消息
        expect(model.doStreamCalls).toHaveLength(2);
        expect(messagesOf(model, 1)).toEqual([
          tagged('第1句'),
          '答1',
          instruction(wholeSegment, 1500),
        ]);
      } else {
        expect(model.doStreamCalls).toHaveLength(1);
      }
    },
  );
});

describe('摘要回来了才被中止', () => {
  // 摘要请求已经正常结束、还没写新段时被中止：这次摘要作废，不切段。
  // 在记模型调用的那一刻（摘要已经回来）触发中止
  it.each([
    ['abortSignal 中止手动压缩', 'compact', 'abort'],
    ['清空接手手动压缩', 'compact', 'clear'],
    ['清空接手空闲切段', 'idle', 'clear'],
  ] as const)('%s：这次摘要作废，不切段，结果是被中止', async (_name, summary, interrupt) => {
    const base = createMemoryStore({ title: '读书会' });
    const controller = new AbortController();
    let clearing: Promise<unknown> | undefined;
    const store: ConversationStore = {
      ...base,
      recordCall: async (call) => {
        if (call.purpose === 'summary') {
          if (interrupt === 'abort') controller.abort();
          else {
            clearing = conversation.clear({ by: carol });
            // 让清空先把这次摘要中止
            await sleep(20);
          }
        }
        return base.recordCall(call);
      },
    };
    const { conversation, model, entries, round } = setup({
      turns: ['答1', '这次的摘要'],
      segments: summary === 'idle' ? { idleMs: 30 } : {},
      store,
    });
    await round('第1句');

    if (summary === 'compact') {
      expect(await conversation.compact({ by: bob, abortSignal: controller.signal })).toBe(
        'aborted',
      );
    } else {
      advance(60_000);
      await until(() => logsOf(entries, 'summary.aborted').length > 0);
    }
    if (clearing) expect(await clearing).toBe('cleared');

    expect(model.doStreamCalls).toHaveLength(2);
    // 摘要请求本身正常结束了
    expect((await store.calls())[1]).toMatchObject({
      summaryReason: summary === 'compact' ? 'manual' : 'idle',
      outcome: 'completed',
    });
    expect(logsOf(entries, 'summary.aborted').map((e) => e.fields.reason)).toEqual([
      summary === 'compact' ? 'manual' : 'idle',
    ]);
    expect(logsOf(entries, 'summary.end')).toHaveLength(0);
    expect((await store.segments()).some((segment) => segment.priorSummary)).toBe(false);
    if (interrupt === 'abort') {
      expect(await segmentsOf(store)).toEqual([[1, 'first']]);
    } else {
      // 清空是在有消息的段之后新开一段，不是改写一段已经写进去的摘要段
      expect(await segmentsOf(store)).toEqual([
        [1, 'first'],
        [3, 'clear'],
      ]);
      expect(logsOf(entries, 'clear.end')[0]?.fields).toMatchObject({ rewritten: false });
    }
  });
});

describe('自动压缩失败后的间隔', () => {
  it.each(['失败', '成功'] as const)(
    '手动压缩%s不动原有的间隔：没有清掉（间隔结束前不自动压缩），也没有重设（到原来的时刻照常自动压缩）',
    async (manualOutcome) => {
      const { conversation, model, store, entries, round } = setup({
        turns: [
          { text: '答1', input: 50 },
          { text: '答2', input: 150 },
          unauthorized(),
          manualOutcome === '失败' ? unauthorized() : '手动摘要',
          { text: '答3', input: 150 },
          { text: '答4', input: 150 },
          { text: '答5', input: 150 },
          '自动压缩的摘要',
        ],
        segments: { compressTokens: 100, keepMessages: 1 },
      });
      await round('第1句');
      advance(3 * 60_000);
      // 14:05：输入超过阈值，自动压缩失败，10 分钟内（到 14:15）不再自动压缩
      await round('第2句');
      await until(() => logsOf(entries, 'summary.failed').length === 1);

      // 14:06：手动压缩
      advance(60_000);
      if (manualOutcome === '失败')
        await expect(conversation.compact({ by: bob })).rejects.toThrow();
      else expect(await conversation.compact({ by: bob })).toBe('compacted');
      const segments = await store.segments();

      // 14:07、14:14:59：间隔还没结束，输入超过阈值也不自动压缩
      advance(60_000);
      await round('第3句');
      advance(8 * 60_000 - 1000);
      await round('第4句');
      await sleep(50);
      // 到这里的请求：第 1、2 句的回复，失败的自动压缩，手动压缩，第 3、4 句的回复；没有新的自动压缩
      expect(model.doStreamCalls).toHaveLength(6);
      expect(await store.segments()).toEqual(segments);

      // 14:15:01：间隔结束，照常自动压缩
      advance(2000);
      await round('第5句');
      await until(async () => (await store.currentSegment()).startReason === 'compress');
      expect(model.doStreamCalls).toHaveLength(8);
    },
  );
});

describe('会话关闭之后', () => {
  it('清空：以普通的错误拒绝（不是正忙），什么都不写', async () => {
    const { conversation, store, entries, round } = setup({ turns: ['答1'] });
    await round('第1句');
    await conversation.close();

    const error = await rejection(conversation.clear({ by: bob }));

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ConversationBusyError);
    expect((error as Error).message).toBe('会话已关闭，不能清空上下文');
    expect(await segmentsOf(store)).toEqual([[1, 'first']]);
    expect(logsOf(entries, 'clear.end')).toHaveLength(0);
  });

  it('清空读当前段读到一半时会话被关闭：同样拒绝，什么都不写；关闭等它结束', async () => {
    const { store, control } = slowStore();
    const { conversation, entries, round } = setup({ turns: ['答1'], store });
    await round('第1句');
    control.arm('currentSegment');
    const clearing = rejection(conversation.clear({ by: bob }));
    await until(() => control.held);

    let closed = false;
    const closing = conversation.close().then(() => (closed = true));
    await sleep(20);
    expect(closed).toBe(false);
    control.release();

    expect(((await clearing) as Error).message).toBe('会话已关闭，不能清空上下文');
    await closing;
    expect(await segmentsOf(store)).toEqual([[1, 'first']]);
    expect(logsOf(entries, 'clear.end')).toHaveLength(0);
  });
});

describe('回复在等切段时被中止', () => {
  it.each(['手动压缩', '空闲切段'] as const)(
    '等%s时中止：回复马上以中止结束（不发请求、不写进历史），不等摘要；那次切段照常完成',
    async (kind) => {
      const { gate, release } = gated();
      const { conversation, model, store, entries, round } = setup({
        turns: ['答1', { text: '这次的摘要', gate }, '答2'],
        segments: kind === '空闲切段' ? { idleMs: 30 } : {},
      });
      await round('第1句');
      const compacting = kind === '手动压缩' ? conversation.compact({ by: bob }) : undefined;
      if (kind === '空闲切段') advance(60_000);
      await until(() => model.doStreamCalls.length === 2);
      await conversation.append({ author: alice, text: '第2句' });
      const controller = new AbortController();
      const replying = readAll(conversation.reply({ abortSignal: controller.signal }));
      await sleep(30);

      controller.abort();
      // 摘要还挂着，回复已经结束
      const chunks = await replying;

      expect(chunks.map((chunk) => chunk.type)).toEqual(['start', 'abort']);
      expect(model.doStreamCalls).toHaveLength(2);
      expect((await conversation.messages()).map((m) => m.role)).toEqual([
        'user',
        'assistant',
        'user',
      ]);
      expect(logsOf(entries, 'reply.end').at(-1)?.fields).toMatchObject({
        outcome: 'aborted',
        saved: false,
      });
      // 没发出请求，模型调用表里没有这次回复：只有第一轮的回复（摘要还没结束）
      expect((await store.calls()).map((call) => [call.purpose, call.outcome])).toEqual([
        ['reply', 'completed'],
      ]);

      release();
      if (compacting) expect(await compacting).toBe('compacted');
      else await until(async () => (await store.currentSegment()).startReason === 'idle');
      expect(await store.currentSegment()).toMatchObject({
        startSeq: 3,
        priorSummary: '这次的摘要',
      });
      // 之后的回复照常，用的是新的一段
      await readAll(conversation.reply());
      expect((await store.calls()).map((call) => [call.purpose, call.outcome])).toEqual([
        ['reply', 'completed'],
        ['summary', 'completed'],
        ['reply', 'completed'],
      ]);
      expect(messagesOf(model, 2)).toEqual([
        tagged(
          '第2句',
          // 空闲切段那条把时钟拨过一分钟
          kind === '空闲切段' ? '2026-10-30 14:03' : '2026-10-30 14:02',
        ),
      ]);
    },
  );
});

describe('以调用那一刻为界', () => {
  /**
   * 包一层的存储：被中止的自动摘要记模型调用时停住（它在收尾，手动操作在等它），
   * reached 表示已经停住，release 放行
   */
  function slowAbortStore() {
    const base = createMemoryStore({ title: '读书会' });
    const hold = { ...gated(), reached: false };
    const store: ConversationStore = {
      ...base,
      recordCall: async (call) => {
        if (call.purpose === 'summary' && call.outcome === 'aborted' && !hold.reached) {
          hold.reached = true;
          await hold.gate;
        }
        return base.recordCall(call);
      },
    };
    releases.push(hold.release);
    return { store, hold };
  }

  it.each([
    ['空闲切段', 'compact'],
    ['自动压缩', 'compact'],
    ['空闲切段', 'clear'],
    ['自动压缩', 'clear'],
  ] as const)(
    '%s进行中调用 %s，等它收尾时写进一条消息并开始回复：这条消息归入之后的一段，不进摘要、不被清掉；回复正常完成',
    async (auto, operation) => {
      const { store, hold } = slowAbortStore();
      const idle = auto === '空闲切段';
      const { conversation, model, round } = setup({
        turns: [
          ...(idle
            ? ['答1']
            : [
                { text: '答1', input: 50 },
                { text: '答2', input: 150 },
              ]),
          { text: '自动的摘要', gate: never },
          ...(operation === 'compact' ? ['手动摘要'] : []),
          '收到',
        ],
        segments: idle ? { idleMs: 30 } : { compressTokens: 100, keepMessages: 1 },
        store,
      });
      await round('第1句');
      advance(idle ? 60_000 : 3 * 60_000);
      if (!idle) await round('第2句');
      // 调用那一刻的最后一条消息
      const boundary = idle ? 2 : 4;
      const autoCall = idle ? 1 : 2;
      await until(() => model.doStreamCalls.length === autoCall + 1);

      const manual =
        operation === 'compact'
          ? conversation.compact({ by: bob })
          : conversation.clear({ by: bob });
      await until(() => hold.reached);
      const during = await conversation.append({ author: alice, text: '收尾期间说的话' });
      const replying = readAll(conversation.reply());
      hold.release();

      expect(await manual).toBe(operation === 'compact' ? 'compacted' : 'cleared');
      const chunks = await replying;
      expect(chunks.filter((chunk) => chunk.type === 'error')).toEqual([]);
      expect(await store.currentSegment()).toMatchObject({
        startSeq: boundary + 1,
        startReason: operation === 'compact' ? 'manual' : 'clear',
      });
      expect((await store.entry(during.id))?.seq).toBe(boundary + 1);
      if (operation === 'compact') {
        // 摘要请求到界线为止
        const summary = messagesOf(model, autoCall + 1);
        expect(summary.some((text) => text.includes('收尾期间说的话'))).toBe(false);
        expect(summary.at(-1)).toBe(instruction(wholeSegment, 1500));
      }
      const reply = model.doStreamCalls.length - 1;
      expect(messagesOf(model, reply)).toEqual([
        tagged('收尾期间说的话', idle ? '2026-10-30 14:03' : '2026-10-30 14:05'),
      ]);
      expect(systemOf(model, reply)).toContain(
        operation === 'compact'
          ? summarySection('手动摘要')
          : clearedSection(idle ? '2026-10-30 14:03' : '2026-10-30 14:05'),
      );
      expect((await conversation.messages()).at(-1)?.role).toBe('assistant');
    },
  );

  it('自动的那次赶在被中止之前切完了：按切完之后的当前段算，界线落在它之前，没有可压缩的内容；之后写入的消息留在那一段', async () => {
    const base = createMemoryStore({ title: '读书会' });
    // 空闲切段写新段时停住：摘要已经回来，中止赶不上它
    const hold = { ...gated(), reached: false };
    const store: ConversationStore = {
      ...base,
      addSegment: async (segment) => {
        if (segment.startReason === 'idle') {
          hold.reached = true;
          await hold.gate;
        }
        return base.addSegment(segment);
      },
    };
    releases.push(hold.release);
    const { conversation, model, round } = setup({
      turns: ['答1', '空闲摘要'],
      segments: { idleMs: 30 },
      store,
    });
    await round('第1句');
    advance(60_000);
    await until(() => hold.reached);

    const compacting = conversation.compact({ by: bob });
    const during = await conversation.append({ author: alice, text: '切段收尾时说的话' });
    hold.release();

    expect(await compacting).toBe('nothing-to-compact');
    expect(await segmentsOf(store)).toEqual([
      [1, 'first'],
      [3, 'idle'],
    ]);
    expect((await store.entry(during.id))?.seq).toBe(3);
    expect(model.doStreamCalls).toHaveLength(2);
  });
});

describe('正忙', () => {
  it('回复进行中（含刚调用 reply、还没发出请求）：压缩、清空都以 ConversationBusyError 拒绝，段不变，没有请求模型', async () => {
    const { gate, release } = gated();
    const { conversation, model, store } = setup({ turns: [{ text: '慢慢回答', gate }] });
    await conversation.append({ author: alice, text: '问个问题' });
    const before = await store.segments();

    const replying = readAll(conversation.reply());
    const early = await rejection(conversation.compact({ by: bob }));
    expect(early).toBeInstanceOf(ConversationBusyError);
    expect((early as ConversationBusyError).reason).toBe('replying');

    await until(() => model.doStreamCalls.length === 1);
    const compactError = await rejection(conversation.compact({ by: bob }));
    const clearError = await rejection(conversation.clear({ by: bob }));
    expect(compactError).toBeInstanceOf(ConversationBusyError);
    expect(clearError).toBeInstanceOf(ConversationBusyError);
    expect((clearError as ConversationBusyError).reason).toBe('replying');

    release();
    await replying;
    expect(model.doStreamCalls).toHaveLength(1);
    expect(await store.segments()).toEqual(before);
    // 回复结束后照常可以做
    expect(await conversation.clear({ by: bob })).toBe('cleared');
  });

  it('手动压缩进行中再压缩：以 ConversationBusyError（compacting）拒绝；清空则中止那次压缩，清空生效', async () => {
    const { conversation, model, store, round } = setup({
      turns: ['答1', { text: '摘要', gate: never }],
    });
    await round('第1句');
    const first = conversation.compact({ by: bob });
    await until(() => model.doStreamCalls.length === 2);

    const again = await rejection(conversation.compact({ by: carol }));
    expect(again).toBeInstanceOf(ConversationBusyError);
    expect((again as ConversationBusyError).reason).toBe('compacting');
    expect(model.doStreamCalls).toHaveLength(2);

    expect(await conversation.clear({ by: carol })).toBe('cleared');
    expect(await first).toBe('aborted');
    expect(await segmentsOf(store)).toEqual([
      [1, 'first'],
      [3, 'clear'],
    ]);
    expect(await store.currentSegment()).toMatchObject({ startedBy: carol });
    expect(await store.currentSegment()).not.toHaveProperty('priorSummary');
    expect((await store.calls())[1]).toMatchObject({ summaryReason: 'manual', outcome: 'aborted' });
  });
});

describe('清空', () => {
  it('当前段有消息：新开一段，没有摘要，原因 clear，带执行人；之后的回复 system 里没有摘要、有清空的那一节，消息只有清空之后的', async () => {
    const { conversation, model, store, entries, round } = setup({
      turns: ['答1', '之前的摘要', '答2', '答3'],
    });
    await round('第1句');
    await conversation.compact({ by: bob });
    await round('第2句');
    advance(8 * 60_000);

    expect(await conversation.clear({ by: carol })).toBe('cleared');

    expect(await store.currentSegment()).toEqual({
      startSeq: 5,
      startReason: 'clear',
      conversationTitle: '读书会',
      startedBy: carol,
      createdAt: '2026-10-30T06:10:00.000Z',
    });
    expect(await segmentsOf(store)).toEqual([
      [1, 'first'],
      [3, 'manual'],
      [5, 'clear'],
    ]);
    expect(logsOf(entries, 'clear.end')).toEqual([
      {
        level: 'info',
        msg: 'clear.end',
        fields: {
          conversationId: 'c1',
          modelId: model.modelId,
          byId: 'u-carol',
          result: 'cleared',
          startSeq: 5,
          rewritten: false,
        },
      },
    ]);

    advance(60_000);
    await round('第3句');
    expect(messagesOf(model, 3)).toEqual([tagged('第3句', '2026-10-30 14:11')]);
    const system = systemOf(model, 3);
    expect(headingsOf(system)).toEqual(['## 消息格式', '## 当前会话', '## 之前的对话']);
    expect(
      system?.endsWith(`\n\n${titleSection('读书会')}\n\n${clearedSection('2026-10-30 14:10')}`),
    ).toBe(true);
    expect(system).not.toContain('之前的摘要');
    // 不请求模型
    expect(model.doStreamCalls).toHaveLength(4);
  });

  it('没有标题的会话：清空的那一节接在格式说明之后', async () => {
    const { conversation, model, round } = setup({
      turns: ['答1', '答2'],
      store: createMemoryStore(),
    });
    await round('第1句');
    await conversation.clear({ by: bob });
    await round('第2句');

    expect(headingsOf(systemOf(model, 1))).toEqual(['## 消息格式', '## 之前的对话']);
    expect(systemOf(model, 1)?.endsWith(`\n\n${clearedSection('2026-10-30 14:02')}`)).toBe(true);
  });

  it.each([
    ['手动压缩之后', 'manual', 60_000],
    ['空闲切段之后', 'idle', 60_000],
  ] as const)(
    '当前段没有消息、带着摘要（%s）：把这一段改成清空的段，段数不变，没有摘要，有执行人，时间是清空的时刻',
    async (_name, reason, wait) => {
      const { conversation, model, store, entries, round } = setup({
        turns: ['答1', '摘要', '答2'],
        segments: reason === 'idle' ? { idleMs: 30 } : {},
      });
      await round('第1句');
      advance(wait);
      if (reason === 'manual') await conversation.compact({ by: bob });
      else await until(async () => (await store.currentSegment()).startReason === 'idle');
      expect(await store.currentSegment()).toMatchObject({ startSeq: 3, priorSummary: '摘要' });
      advance(5 * 60_000);

      expect(await conversation.clear({ by: carol })).toBe('cleared');

      expect(await segmentsOf(store)).toEqual([
        [1, 'first'],
        [3, 'clear'],
      ]);
      expect(await store.currentSegment()).toEqual({
        startSeq: 3,
        startReason: 'clear',
        conversationTitle: '读书会',
        startedBy: carol,
        createdAt: '2026-10-30T06:08:00.000Z',
      });
      expect(logsOf(entries, 'clear.end')[0]?.fields).toMatchObject({
        result: 'cleared',
        startSeq: 3,
        rewritten: true,
        byId: 'u-carol',
      });

      await round('第2句');
      expect(messagesOf(model, 2)).toEqual([tagged('第2句', '2026-10-30 14:08')]);
      expect(systemOf(model, 2)?.endsWith(clearedSection('2026-10-30 14:08'))).toBe(true);
      expect(systemOf(model, 2)).not.toContain('## 之前的对话摘要');
    },
  );

  it('新会话、连着清空两次：结果是 already-empty，什么都不写', async () => {
    const { conversation, store, entries, round } = setup({ turns: ['答1'] });
    const fresh = await store.segments();

    expect(await conversation.clear({ by: bob })).toBe('already-empty');
    expect(await store.segments()).toEqual(fresh);

    await round('第1句');
    expect(await conversation.clear({ by: bob })).toBe('cleared');
    const cleared = await store.segments();
    advance(60_000);
    expect(await conversation.clear({ by: carol })).toBe('already-empty');
    expect(await store.segments()).toEqual(cleared);
    expect(logsOf(entries, 'clear.end').map((e) => e.fields.result)).toEqual([
      'already-empty',
      'cleared',
      'already-empty',
    ]);
  });

  it('进行中的空闲切段被中止：不产生带摘要的段，模型调用表记 aborted', async () => {
    const { gate, release } = gated();
    const { conversation, model, store, entries, round } = setup({
      turns: ['答1', { text: '空闲摘要', gate }],
      segments: { idleMs: 30 },
    });
    await round('第1句');
    advance(60_000);
    await until(() => model.doStreamCalls.length === 2);

    expect(await conversation.clear({ by: bob })).toBe('cleared');
    // 被中止的那次请求已经以出错结束（mock 在中止时让流出错），放行之后也不会再有输出；
    // 这里确认之后也没有补出带摘要的段。摘要已经回来、写段之前才被中止的情况见「摘要回来了才被中止」
    release();
    await sleep(50);

    expect(await segmentsOf(store)).toEqual([
      [1, 'first'],
      [3, 'clear'],
    ]);
    expect((await store.segments()).some((segment) => segment.priorSummary)).toBe(false);
    expect(logsOf(entries, 'summary.aborted').map((e) => e.fields.reason)).toEqual(['idle']);
    expect((await store.calls())[1]).toMatchObject({ summaryReason: 'idle', outcome: 'aborted' });
  });

  it('清空的段之后空闲切段：摘要请求的 system 里有清空的那一节（与回复的前缀相同）；新的一段带摘要，没有那一节', async () => {
    const { conversation, model, store, round } = setup({
      turns: ['答1', '答2', '清空之后的摘要', '答3'],
      segments: { idleMs: 30 },
    });
    await round('第1句');
    await conversation.clear({ by: bob });
    await round('第2句');
    expect(systemOf(model, 1)?.endsWith(clearedSection('2026-10-30 14:02'))).toBe(true);
    advance(60_000);

    await until(async () => (await store.currentSegment()).startReason === 'idle');

    expect(promptOf(model, 2)).toEqual([
      ...promptOf(model, 1),
      { role: 'assistant', text: '答2' },
      { role: 'user', text: instruction(wholeSegment, 1500) },
    ]);
    expect(await store.currentSegment()).toMatchObject({
      startSeq: 5,
      priorSummary: '清空之后的摘要',
    });
    await round('第3句');
    const system = systemOf(model, 3);
    expect(headingsOf(system)).toEqual(['## 消息格式', '## 当前会话', '## 之前的对话摘要']);
    expect(system).not.toContain('被清空');
  });

  it('清空之后手动压缩：摘要请求带着清空的那一节；新的一段带摘要，没有那一节', async () => {
    const { conversation, model, round } = setup({
      turns: ['答1', '答2', '清空之后的摘要', '答3'],
    });
    await round('第1句');
    await conversation.clear({ by: bob });
    await round('第2句');

    expect(await conversation.compact({ by: bob })).toBe('compacted');
    expect(systemOf(model, 2)).toBe(systemOf(model, 1));
    expect(systemOf(model, 2)?.endsWith(clearedSection('2026-10-30 14:02'))).toBe(true);

    await round('第3句');
    expect(systemOf(model, 3)?.endsWith(summarySection('清空之后的摘要'))).toBe(true);
    expect(systemOf(model, 3)).not.toContain('被清空');
  });

  it('日志不含对话正文与执行人的名字', async () => {
    const { conversation, entries, round } = setup({ turns: ['答1', '摘要', '答2'] });
    await round('早上好');
    await conversation.compact({ by: bob });
    await round('还在吗');
    await conversation.clear({ by: carol });

    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain('早上好');
    expect(serialized).not.toContain('Bob');
    expect(serialized).not.toContain('Carol');
  });
});

describe('SQLite', () => {
  async function sqlite() {
    const dir = await mkdtemp(join(tmpdir(), 'luolicore-db-'));
    const path = join(dir, 'luoli.db');
    const storage = openSqliteStorage(path);
    cleanups.push(async () => {
      storage.close();
      await rm(dir, { recursive: true, force: true });
    });
    return { path, storage };
  }

  it('清空、压缩都不动消息表、任务表里已有的行；执行人没有 id（CLI）时段上只有名字；模型调用的原因 manual 能读回', async () => {
    const { path, storage } = await sqlite();
    const id = await storage.createConversation({ platform: 'cli' });
    const cli = { name: 'cli-user' };
    const { conversation, round } = setup({
      turns: ['答1', '摘要', '答2'],
      store: await storage.openConversation(id),
    });
    await round('明早九点提醒我交周报');
    const [source] = await conversation.messages();
    await storage.createTask({
      conversationId: id,
      action: '提醒 Alice 交周报',
      schedule: { kind: 'once', at: '2026-10-31T01:00:00.000Z' },
      source: { author: alice, messageId: source!.id },
      nextDueAt: '2026-10-31T01:00:00.000Z',
    });
    const raw = new DatabaseSync(path, { readOnly: true });
    cleanups.unshift(async () => raw.close());
    const dump = () =>
      ['messages', 'tasks'].map((table) =>
        raw
          .prepare(`SELECT * FROM ${table} ORDER BY rowid`)
          .all()
          .map((row) => ({ ...row })),
      );
    const before = dump();

    expect(await conversation.compact({ by: cli })).toBe('compacted');
    expect(dump()).toEqual(before);
    await round('第2句');
    const afterRound = dump();
    expect(await conversation.clear({ by: cli })).toBe('cleared');
    expect(dump()).toEqual(afterRound);

    const store = await storage.openConversation(id);
    const segments = await store.segments();
    expect(segments.map((s) => [s.startSeq, s.startReason, s.startedBy])).toEqual([
      [1, 'first', undefined],
      [3, 'manual', { name: 'cli-user' }],
      [5, 'clear', { name: 'cli-user' }],
    ]);
    expect(segments[1]).not.toHaveProperty('startedBy.id');
    expect(
      raw
        .prepare('SELECT start_reason, started_by, started_by_id FROM segments ORDER BY start_seq')
        .all()
        .map((row) => ({ ...row })),
    ).toEqual([
      { start_reason: 'first', started_by: null, started_by_id: null },
      { start_reason: 'manual', started_by: 'cli-user', started_by_id: null },
      { start_reason: 'clear', started_by: 'cli-user', started_by_id: null },
    ]);
    expect((await store.calls()).map((c) => [c.purpose, c.summaryReason])).toEqual([
      ['reply', undefined],
      ['summary', 'manual'],
      ['reply', undefined],
    ]);
  });
});
