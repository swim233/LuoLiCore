import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { APICallError } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createConversation,
  createMemoryStore,
  openSqliteStorage,
  type Conversation,
  type ConversationStore,
  type Logger,
  type Message,
  type MessageChunk,
  type SegmentOptions,
} from './index.js';
import { testPrompts } from './test-prompts.js';

type StreamResult = Awaited<ReturnType<MockLanguageModelV4['doStream']>>;
type StreamPart = StreamResult['stream'] extends ReadableStream<infer P> ? P : never;

const alice = { id: 'u-alice', name: 'Alice' };
const instructions = '你是测试助手';
const prompts = testPrompts(instructions);

// 固定时区与时钟：2026-10-30T06:02Z 在上海是 14:02。只假冒 Date，计时器照常走；
// 「过了多久」用 vi.setSystemTime 拨 Date，空闲检查的定时器按真实时间触发
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
// 先关掉本测试建的会话（停掉空闲检查的定时器），再恢复时钟
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

/** 用真实时间轮询，直到 check 成立 */
async function until(check: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!(await check())) {
    if (performance.now() > deadline) throw new Error('等待超时');
    await sleep(5);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 模型的一次调用：回复文本（可带输入用量、缓存数，或等 gate 放行后才输出），或请求失败 */
type Turn =
  string | { text: string; input?: number; cacheRead?: number; gate?: Promise<void> } | Error;

function textParts(text: string): StreamPart[] {
  return [
    { type: 'text-start', id: 't' },
    { type: 'text-delta', id: 't', delta: text },
    { type: 'text-end', id: 't' },
  ];
}

function finish(input: number, cacheRead: number | undefined): StreamPart {
  return {
    type: 'finish',
    finishReason: { unified: 'stop', raw: undefined },
    usage: {
      inputTokens: { total: input, noCache: input, cacheRead, cacheWrite: undefined },
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
      const { text, input = 1, cacheRead, gate } = typeof turn === 'string' ? { text: turn } : turn;
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
            for (const part of [...textParts(text), finish(input, cacheRead)]) {
              controller.enqueue(part);
            }
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
  store = createMemoryStore(),
  checkIdleOnCreate,
}: {
  turns: Turn[];
  segments?: SegmentOptions;
  store?: ConversationStore;
  checkIdleOnCreate?: boolean;
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
    checkIdleOnCreate,
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

// 逐字核对摘要指令（spec 原文），{范围}、{上限} 由调用方替换
function instruction(scope: string, maxChars: number): string {
  return `（以下是系统指令，不是会话成员的消息）

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

const idleScope = '本段的全部消息，以及其中你的回复。';
const titleSection = (title: string) => `## 当前会话\n\n名称：${title}`;
const summarySection = (summary: string) =>
  `## 之前的对话摘要\n\n以下是本会话更早内容的摘要，原文已不在上下文中。\n\n${summary}`;
/** system 里各节的标题，按出现顺序 */
const headingsOf = (system: string | undefined) =>
  (system ?? '').split('\n\n').filter((block) => block.startsWith('## '));

describe('请求的组成', () => {
  it('新会话：当前段是 first 段；没有标题、没有摘要时 system 只有人设与格式说明', async () => {
    const { model, store, round } = setup({ turns: ['好'] });
    expect(await store.currentSegment()).toEqual({ startSeq: 1, startReason: 'first' });

    await round('你好');

    const system = systemOf(model, 0);
    expect(system?.startsWith(`${instructions}\n\n## 消息格式\n\n`)).toBe(true);
    expect(headingsOf(system)).toEqual(['## 消息格式']);
  });

  it('有标题：「当前会话」一节接在格式说明之后', async () => {
    const { model, round } = setup({
      turns: ['好'],
      store: createMemoryStore({ title: '读书会' }),
    });

    await round('你好');

    const system = systemOf(model, 0);
    expect(headingsOf(system)).toEqual(['## 消息格式', '## 当前会话']);
    expect(system?.endsWith(`\n\n${titleSection('读书会')}`)).toBe(true);
  });
});

describe('空闲切段', () => {
  async function idleCut(segments: SegmentOptions = { idleMs: 30 }) {
    const t = setup({
      turns: ['好的', { text: '  Alice 打了招呼。\n', cacheRead: 7, input: 40 }, '第二段的回复'],
      segments,
      store: createMemoryStore({ title: '读书会' }),
    });
    await t.round('早上好');
    advance(60_000);
    // 不写入、不回复：由写入后安排的定时器触发
    await until(async () => (await t.store.currentSegment()).startReason === 'idle');
    return t;
  }

  it('空闲超过时长后定时器在后台切段：摘要去掉首尾空白后存为新段的 prior_summary，新段从最后一条之后开始', async () => {
    const { store, model, entries } = await idleCut();

    expect(model.doStreamCalls).toHaveLength(2);
    expect(await store.currentSegment()).toEqual({
      startSeq: 3,
      startReason: 'idle',
      conversationTitle: '读书会',
      priorSummary: 'Alice 打了招呼。',
    });
    expect(logsOf(entries, 'summary.end')[0]?.fields).toMatchObject({
      conversationId: 'c1',
      modelId: model.modelId,
      reason: 'idle',
      fromSeq: 1,
      toSeq: 2,
      startSeq: 3,
      usage: { input: 40, output: 1, total: 41, cacheRead: 7 },
      durationMs: expect.any(Number),
    });
  });

  it('之后的请求只含新段的消息，system 末尾依次是当前会话与摘要', async () => {
    const { model, round } = await idleCut();

    await round('又来了');

    expect(messagesOf(model, 2)).toEqual([tagged('又来了', '2026-10-30 14:03')]);
    const system = systemOf(model, 2);
    expect(headingsOf(system)).toEqual(['## 消息格式', '## 当前会话', '## 之前的对话摘要']);
    expect(
      system?.endsWith(`\n\n${titleSection('读书会')}\n\n${summarySection('Alice 打了招呼。')}`),
    ).toBe(true);
  });

  it('摘要请求沿用上一次回复的前缀：system 相同，消息是那次的消息加上回复，末尾一条不带标签的指令', async () => {
    const { model } = await idleCut({ idleMs: 30, summaryMaxChars: 800 });

    const reply = promptOf(model, 0);
    expect(promptOf(model, 1)).toEqual([
      ...reply,
      { role: 'assistant', text: '好的' },
      { role: 'user', text: instruction(idleScope, 800) },
    ]);
  });

  it('日志不含对话正文与摘要正文', async () => {
    const { entries } = await idleCut();

    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain('早上好');
    expect(serialized).not.toContain('打了招呼');
  });

  it('摘要生成期间写入的消息归入新段；期间调用 reply() 等切段完成后才请求', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { conversation, model, store, round } = setup({
      turns: ['好的', { text: '摘要', gate }, '新段的回复'],
      segments: { idleMs: 30 },
    });
    await round('早上好');
    advance(60_000);
    await until(() => model.doStreamCalls.length === 2);

    await conversation.append({ author: alice, text: '摘要期间说的话' });
    const replying = readAll(conversation.reply());
    await sleep(50);
    // 还在等切段：没有发出新的请求，也没有再开一次摘要
    expect(model.doStreamCalls).toHaveLength(2);

    release();
    await replying;
    expect(await store.currentSegment()).toMatchObject({ startSeq: 3, priorSummary: '摘要' });
    expect(messagesOf(model, 2)).toEqual([tagged('摘要期间说的话', '2026-10-30 14:03')]);
    expect(systemOf(model, 2)).toContain(summarySection('摘要'));
    expect((await store.entries({ from: 3 })).map((e) => [e.seq, e.message.role])).toEqual([
      [3, 'user'],
      [4, 'assistant'],
    ]);
  });

  it('会话对象创建时已经空闲太久：后台补做，摘要请求含原来的消息', async () => {
    const store = createMemoryStore();
    const old = new Date(Date.parse(start) - 5 * 3_600_000).toISOString();
    const saved: Message[] = [
      {
        id: 'u1',
        role: 'user',
        metadata: { author: alice, createdAt: old },
        parts: [{ type: 'text', text: '昨晚说的话' }],
      },
      {
        id: 'a1',
        role: 'assistant',
        metadata: { createdAt: old },
        parts: [{ type: 'text', text: '晚安' }],
      },
    ];
    for (const message of saved) await store.add(message);

    // 默认空闲时长 240 分钟；什么都不做
    const { model } = setup({ turns: ['昨晚的摘要'], store });

    await until(async () => (await store.currentSegment()).startReason === 'idle');
    expect(await store.currentSegment()).toMatchObject({ startSeq: 3, priorSummary: '昨晚的摘要' });
    expect(messagesOf(model, 0)).toEqual([
      tagged('昨晚说的话', '2026-10-30 09:02'),
      '晚安',
      instruction(idleScope, 1500),
    ]);
  });

  it('append 带着平台时间：按与上一条消息的间隔判断空闲，不按距今多久', async () => {
    const { conversation, model, store } = setup({ turns: ['两条之间的摘要'] });
    const hoursAgo = (hours: number, seconds = 0) =>
      new Date(Date.parse(start) - hours * 3_600_000 + seconds * 1000).toISOString();

    // 离线期间积压的消息：六小时前，彼此只隔几秒
    await conversation.append({ author: alice, text: '一', createdAt: hoursAgo(6) });
    await conversation.append({ author: alice, text: '二', createdAt: hoursAgo(6, 10) });
    await conversation.append({ author: alice, text: '三', createdAt: hoursAgo(6, 20) });
    await sleep(50);
    expect(model.doStreamCalls).toHaveLength(0);
    expect((await store.currentSegment()).startSeq).toBe(1);

    // 与上一条相隔超过空闲时长（默认 240 分钟）才切段，新消息归入新段
    await conversation.append({ author: alice, text: '四', createdAt: hoursAgo(1) });
    await until(async () => (await store.currentSegment()).startReason === 'idle');
    expect((await store.currentSegment()).startSeq).toBe(4);
    expect(model.doStreamCalls).toHaveLength(1);
  });

  it('checkIdleOnCreate 为 false：创建时不补做；写入前的检查照旧（按现在的时间）', async () => {
    const store = createMemoryStore();
    const old = new Date(Date.parse(start) - 5 * 3_600_000).toISOString();
    await store.add({
      id: 'u1',
      role: 'user',
      metadata: { author: alice, createdAt: old },
      parts: [{ type: 'text', text: '很久以前' }],
    });

    const { conversation, model } = setup({
      turns: ['写入时补做的摘要'],
      store,
      checkIdleOnCreate: false,
    });
    await sleep(100);
    expect(model.doStreamCalls).toHaveLength(0);
    expect((await store.currentSegment()).startReason).toBe('first');

    // 不带平台时间的写入：按现在的时间，与上一条相隔 5 小时，切段
    await conversation.append({ author: alice, text: '现在' });
    await until(async () => (await store.currentSegment()).startReason === 'idle');
    expect(await store.currentSegment()).toMatchObject({
      startSeq: 2,
      priorSummary: '写入时补做的摘要',
    });
  });

  it('checkIdleOnCreate 为 false：写入后的定时器照旧切段', async () => {
    const { store, round } = setup({
      turns: ['好的', '定时器触发的摘要'],
      segments: { idleMs: 30 },
      checkIdleOnCreate: false,
    });

    await round('早上好');
    advance(60_000);

    await until(async () => (await store.currentSegment()).startReason === 'idle');
    expect(await store.currentSegment()).toMatchObject({
      startSeq: 3,
      priorSummary: '定时器触发的摘要',
    });
  });

  it('当前段还没有消息（刚切过段）时不再切', async () => {
    const { store } = await idleCut();
    advance(5 * 3_600_000);

    // 同一个存储上再开一个会话对象：创建时检查，最后一条消息很早，但它在上一段里
    const { model } = setup({ turns: [], store, segments: { idleMs: 30 } });
    await sleep(100);

    expect(model.doStreamCalls).toHaveLength(0);
    expect((await store.currentSegment()).startSeq).toBe(3);
  });

  it('摘要为空：不切段，记 summary.failed；下一次写入消息时重试，成功后这条消息归入新段', async () => {
    const { model, store, entries, round } = setup({
      turns: ['好的', ' \n ', '重试的摘要', '回复'],
      segments: { idleMs: 30 },
    });
    await round('早上好');
    advance(60_000);
    await until(() => logsOf(entries, 'summary.failed').length === 1);

    expect(await store.currentSegment()).toMatchObject({ startSeq: 1, startReason: 'first' });
    expect(logsOf(entries, 'summary.failed')[0]?.fields).toMatchObject({
      reason: 'idle',
      error: { message: '摘要为空' },
    });

    await round('还在吗');
    expect(await store.currentSegment()).toMatchObject({ startSeq: 3, priorSummary: '重试的摘要' });
    expect(messagesOf(model, 3)).toEqual([tagged('还在吗', '2026-10-30 14:03')]);
  });

  it('关闭会话时中止进行中的摘要：不切段，记 summary.aborted 而不是失败', async () => {
    const { conversation, model, store, entries, round } = setup({
      turns: ['好的', { text: '摘要', gate: new Promise<void>(() => {}) }],
      segments: { idleMs: 30 },
    });
    await round('早上好');
    advance(60_000);
    await until(() => model.doStreamCalls.length === 2);

    await conversation.close();

    expect(await store.currentSegment()).toMatchObject({ startSeq: 1 });
    expect(logsOf(entries, 'summary.aborted')[0]?.fields).toMatchObject({
      modelId: model.modelId,
      reason: 'idle',
    });
    expect(logsOf(entries, 'summary.failed')).toHaveLength(0);
  });

  it('回复进行中不做空闲检查：回复结束后重新计时，回复与它回答的消息归入同一段', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { conversation, model, store } = setup({
      turns: [{ text: '慢慢回答', gate }, '摘要'],
      segments: { idleMs: 30 },
    });
    await conversation.append({ author: alice, text: '问个问题' });
    const replying = readAll(conversation.reply());
    await until(() => model.doStreamCalls.length === 1);
    // 回复还没结束时就已经「空闲」很久，定时器也到点了
    advance(60_000);
    await sleep(100);
    expect(model.doStreamCalls).toHaveLength(1);

    release();
    await replying;
    await until(async () => (await store.currentSegment()).startReason === 'idle');
    expect((await store.currentSegment()).startSeq).toBe(3);
    expect(messagesOf(model, 1).slice(0, -1)).toEqual([tagged('问个问题'), '慢慢回答']);
  });

  it('空闲检查的定时器不拖住进程退出（unref）', async () => {
    const { conversation } = setup({ turns: [] });
    const activeTimeouts = () =>
      process.getActiveResourcesInfo().filter((resource) => resource === 'Timeout').length;
    const before = activeTimeouts();

    await conversation.append({ author: alice, text: '你好' });

    expect(activeTimeouts()).toBe(before);
    // 对照：没有 unref 的定时器会被计入
    const probe = setTimeout(() => {}, 60_000);
    expect(activeTimeouts()).toBe(before + 1);
    clearTimeout(probe);
  });
});

describe('压缩', () => {
  /**
   * 聊 inputs.length 轮，默认每轮隔 3 分钟（14:02、14:05、14:08……；gapsMs 可改），第 n 轮回复的输入用量为 inputs[n-1]；
   * 模型之后的调用依次是 rest。最后一轮触发的压缩可能还在后台进行
   */
  async function rounds(
    segments: SegmentOptions,
    inputs: number[],
    rest: Turn[] = [],
    gapsMs: number[] = inputs.map(() => 3 * 60_000),
  ) {
    const t = setup({
      turns: [...inputs.map((input, i) => ({ text: `答${i + 1}`, input })), ...rest],
      segments: { compressTokens: 100, ...segments },
    });
    for (const [i] of inputs.entries()) {
      if (i > 0) advance(gapsMs[i - 1]!);
      await t.round(`第${i + 1}句`);
    }
    return t;
  }

  const scopeBefore = (time: string) =>
    `本段中 time 早于 ${time} 的消息，以及夹在其间的你的回复。time 为 ${time} 及之后的消息会原样保留，不要写进摘要。`;

  // 三轮之后当前段是 u1 a1 u2 a2 u3 a3（序号 1–6），第三轮输入超过阈值
  it.each([
    ['保留部分以用户消息开头', 2, 5, '2026-10-30 14:08'],
    ['保留部分以助手回复开头：向前多保留到用户消息', 3, 3, '2026-10-30 14:05'],
    ['只保留一条助手回复：向前多保留到用户消息', 1, 5, '2026-10-30 14:08'],
  ])(
    '输入超过阈值后压缩（%s）：新段从保留部分的第一条开始',
    async (_name, keepMessages, startSeq, time) => {
      const { model, store, entries, round } = await rounds(
        { keepMessages },
        [50, 50, 150],
        ['压缩后的摘要', '答4'],
      );
      await until(async () => (await store.currentSegment()).startReason === 'compress');

      // 摘要请求：第三轮回复的前缀加上那次回复，末尾是指令
      expect(promptOf(model, 3)).toEqual([
        ...promptOf(model, 2),
        { role: 'assistant', text: '答3' },
        { role: 'user', text: instruction(scopeBefore(time), 1500) },
      ]);
      expect(await store.currentSegment()).toEqual({
        startSeq,
        startReason: 'compress',
        priorSummary: '压缩后的摘要',
      });
      expect(logsOf(entries, 'summary.end')[0]?.fields).toMatchObject({
        modelId: model.modelId,
        reason: 'compress',
        fromSeq: 1,
        toSeq: startSeq - 1,
        startSeq,
      });

      await round('第4句');
      const all = [
        tagged('第1句'),
        '答1',
        tagged('第2句', '2026-10-30 14:05'),
        '答2',
        tagged('第3句', '2026-10-30 14:08'),
        '答3',
      ];
      // 新段以用户消息开头
      expect(messagesOf(model, 4)).toEqual([
        ...all.slice(startSeq - 1),
        tagged('第4句', '2026-10-30 14:08'),
      ]);
      expect(systemOf(model, 4)).toContain(summarySection('压缩后的摘要'));
    },
  );

  it('与 {T} 同一分钟的用户消息跨越边界：向前扩到早于 {T} 为止，它们与夹在其间的回复都留在保留部分', async () => {
    // 14:02、14:05:00、14:05:20、14:05:40 各一轮；keep 2 本来只保留第 4 轮
    const { model, store, round } = await rounds(
      { keepMessages: 2 },
      [50, 50, 50, 150],
      ['压缩后的摘要', '答5'],
      [3 * 60_000, 20_000, 20_000],
    );
    await until(async () => (await store.currentSegment()).startReason === 'compress');

    expect(await store.currentSegment()).toMatchObject({ startSeq: 3 });
    expect(promptOf(model, 4).at(-1)?.text).toBe(
      instruction(scopeBefore('2026-10-30 14:05'), 1500),
    );
    await round('第5句');
    expect(messagesOf(model, 5)).toEqual([
      tagged('第2句', '2026-10-30 14:05'),
      '答2',
      tagged('第3句', '2026-10-30 14:05'),
      '答3',
      tagged('第4句', '2026-10-30 14:05'),
      '答4',
      tagged('第5句', '2026-10-30 14:05'),
    ]);
  });

  it('向前扩只看到保留部分之前最后一条早于 {T} 的用户消息为止，更早的不再看', async () => {
    // 消息时间不按序号单调（平台给的发送时间）：u1 与 u3 同为 14:05，中间的 u2 是 14:03
    const store = createMemoryStore();
    const user = (id: string, createdAt: string): Message => ({
      id,
      role: 'user',
      metadata: { author: alice, createdAt },
      parts: [{ type: 'text', text: id }],
    });
    const reply = (id: string): Message => ({
      id,
      role: 'assistant',
      metadata: { createdAt: start },
      parts: [{ type: 'text', text: id }],
    });
    for (const message of [
      user('u1', '2026-10-30T06:05:00.000Z'),
      reply('a1'),
      user('u2', '2026-10-30T06:03:00.000Z'),
      reply('a2'),
      user('u3', '2026-10-30T06:05:30.000Z'),
    ]) {
      await store.add(message);
    }
    const { conversation } = setup({
      turns: [{ text: 'a3', input: 150 }, '摘要'],
      segments: { compressTokens: 100, keepMessages: 2 },
      store,
    });

    await readAll(conversation.reply());
    await until(async () => (await store.currentSegment()).startReason === 'compress');

    expect((await store.currentSegment()).startSeq).toBe(5);
  });

  it('保留部分之前找不到用户消息：照旧保留最后 keep 条，范围按条数说明', async () => {
    const store = createMemoryStore();
    for (const id of ['a1', 'a2']) {
      await store.add({
        id,
        role: 'assistant',
        metadata: { createdAt: new Date().toISOString() },
        parts: [{ type: 'text', text: id }],
      });
    }
    const { conversation, model } = setup({
      turns: [{ text: 'a3', input: 150 }, '摘要'],
      segments: { compressTokens: 100, keepMessages: 1 },
      store,
    });

    await readAll(conversation.reply());
    await until(async () => (await store.currentSegment()).startReason === 'compress');

    expect(promptOf(model, 1).at(-1)?.text).toBe(
      instruction('本段中除最后 1 条之外的全部消息。', 1500),
    );
    expect((await store.currentSegment()).startSeq).toBe(3);
  });

  it('输入等于阈值时不压缩', async () => {
    const { model, store } = await rounds({ keepMessages: 1 }, [50, 100]);
    await sleep(50);

    expect(model.doStreamCalls).toHaveLength(2);
    expect((await store.currentSegment()).startReason).toBe('first');
  });

  it.each([
    ['当前段的消息不超过 keep 条', 4, 3 * 60_000],
    ['向前多保留到用户消息后，保留部分就是整段', 3, 3 * 60_000],
    ['与 {T} 同一分钟的用户消息一直到段首，保留部分就是整段', 1, 20_000],
  ])('%s：不压缩，记一条 warn', async (_name, keepMessages, gapMs) => {
    const { model, store, entries } = await rounds({ keepMessages }, [50, 150], [], [gapMs]);
    await until(() => logsOf(entries, 'summary.skipped').length === 1);

    expect(model.doStreamCalls).toHaveLength(2);
    expect((await store.currentSegment()).startReason).toBe('first');
    expect(logsOf(entries, 'summary.skipped')[0]).toMatchObject({
      level: 'warn',
      fields: { modelId: model.modelId, reason: 'compress', messages: 4, keepMessages },
    });
  });

  it('摘要请求报错：不切段，summary.failed 带状态码；之后的请求仍用原来的段', async () => {
    const { model, store, entries, round } = await rounds(
      { keepMessages: 1 },
      [50, 150],
      [unauthorized(), '答3'],
    );
    await until(() => logsOf(entries, 'summary.failed').length === 1);

    expect(logsOf(entries, 'summary.failed')[0]?.fields).toMatchObject({
      modelId: model.modelId,
      reason: 'compress',
      error: { statusCode: 401 },
    });
    expect((await store.currentSegment()).startReason).toBe('first');

    await round('第3句');
    expect(messagesOf(model, 3)).toHaveLength(5);
    expect(systemOf(model, 3)).not.toContain('## 之前的对话摘要');
  });

  it('压缩失败后的退避不影响空闲切段', async () => {
    const { store, entries, round } = setup({
      turns: [
        { text: '答1', input: 50 },
        { text: '答2', input: 150 },
        unauthorized(),
        '空闲摘要',
        '答3',
      ],
      segments: { compressTokens: 100, keepMessages: 1, idleMs: 4 * 60_000 },
    });
    await round('第1句');
    advance(3 * 60_000);
    await round('第2句');
    await until(() => logsOf(entries, 'summary.failed').length === 1);

    // 仍在压缩的退避期内；空闲超过 4 分钟，写入前的检查照常切段
    advance(5 * 60_000);
    await round('第3句');
    expect(await store.currentSegment()).toMatchObject({
      startSeq: 5,
      startReason: 'idle',
      priorSummary: '空闲摘要',
    });
  });

  it('压缩失败后 10 分钟内的回复完成时不再压缩，满 10 分钟后再次压缩', async () => {
    const { model, store, entries, round } = await rounds(
      { keepMessages: 1 },
      [50, 150],
      [unauthorized(), { text: '答3', input: 150 }, { text: '答4', input: 150 }, '压缩后的摘要'],
    );
    await until(() => logsOf(entries, 'summary.failed').length === 1);

    advance(10 * 60_000 - 1000);
    await round('第3句');
    await sleep(50);
    expect(model.doStreamCalls).toHaveLength(4);

    advance(1000);
    await round('第4句');
    await until(async () => (await store.currentSegment()).startReason === 'compress');
    expect(model.doStreamCalls).toHaveLength(6);
  });

  it('压缩进行中回复不等它：请求用旧段，也不再发起第二次压缩；压缩完成后的回复用新段', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { model, store, round } = await rounds(
      { keepMessages: 2 },
      [50, 150],
      [{ text: '压缩后的摘要', gate }, { text: '答3', input: 150 }, '答4'],
    );
    await until(() => model.doStreamCalls.length === 3);

    // 摘要还挂着，这一轮照样完成
    await round('第3句');
    expect(messagesOf(model, 3)).toHaveLength(5);
    expect(systemOf(model, 3)).not.toContain('## 之前的对话摘要');

    release();
    await until(async () => (await store.currentSegment()).startReason === 'compress');
    await round('第4句');
    expect(model.doStreamCalls).toHaveLength(5);
    expect(messagesOf(model, 4)).toEqual([
      tagged('第2句', '2026-10-30 14:05'),
      '答2',
      tagged('第3句', '2026-10-30 14:05'),
      '答3',
      tagged('第4句', '2026-10-30 14:05'),
    ]);
    expect(systemOf(model, 4)).toContain(summarySection('压缩后的摘要'));
  });

  it('回复进行中压缩完成：这次回复用的是旧段，完成时不再压缩', async () => {
    let releaseSummary!: () => void;
    let releaseReply!: () => void;
    const { conversation, model, store } = await rounds(
      { keepMessages: 2 },
      [50, 150],
      [
        { text: '压缩后的摘要', gate: new Promise<void>((resolve) => (releaseSummary = resolve)) },
        { text: '答3', input: 150, gate: new Promise<void>((resolve) => (releaseReply = resolve)) },
      ],
    );
    await until(() => model.doStreamCalls.length === 3);
    await conversation.append({ author: alice, text: '第3句' });
    const replying = readAll(conversation.reply());
    await until(() => model.doStreamCalls.length === 4);

    releaseSummary();
    await until(async () => (await store.currentSegment()).startReason === 'compress');
    releaseReply();
    await replying;
    await sleep(50);

    expect(model.doStreamCalls).toHaveLength(4);
    expect((await store.currentSegment()).startSeq).toBe(3);
  });
});

describe('多个进程', () => {
  it('插入新段时同一序号已有一段（另一个连接刚切过）：不算失败，记 summary.duplicate，以已有的段为准', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'luolicore-db-'));
    const path = join(dir, 'luoli.db');
    const storage = openSqliteStorage(path);
    const other = openSqliteStorage(path);
    cleanups.push(async () => {
      storage.close();
      other.close();
      await rm(dir, { recursive: true, force: true });
    });
    const id = await storage.createConversation({ platform: 'cli' });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { model, entries, round } = setup({
      turns: ['好的', { text: '这边的摘要', gate }, '新段的回复'],
      segments: { idleMs: 30 },
      store: await storage.openConversation(id),
    });
    await round('早上好');
    advance(60_000);
    await until(() => model.doStreamCalls.length === 2);

    await (
      await other.openConversation(id)
    ).addSegment({ startSeq: 3, startReason: 'idle', priorSummary: '另一个进程的摘要' });
    release();
    await until(() => logsOf(entries, 'summary.duplicate').length === 1);

    expect(logsOf(entries, 'summary.duplicate')[0]).toMatchObject({
      level: 'info',
      fields: { modelId: model.modelId, reason: 'idle', startSeq: 3, currentStartSeq: 3 },
    });
    expect(logsOf(entries, 'summary.failed')).toHaveLength(0);
    await round('又来了');
    expect(messagesOf(model, 2)).toEqual([tagged('又来了', '2026-10-30 14:03')]);
    expect(systemOf(model, 2)).toContain(summarySection('另一个进程的摘要'));
  });
});

describe('旧会话', () => {
  it('第 2 步建的会话没有段：按从序号 1 开始、标题取会话标题的第一段处理', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'luolicore-db-'));
    const storage = openSqliteStorage(join(dir, 'luoli.db'));
    cleanups.push(async () => {
      storage.close();
      await rm(dir, { recursive: true, force: true });
    });
    const id = await storage.createConversation({ platform: 'cli', title: '老群' });
    const db = new DatabaseSync(join(dir, 'luoli.db'));
    db.exec('DELETE FROM segments');
    db.close();
    const store = await storage.openConversation(id);
    await store.add({
      id: 'u1',
      role: 'user',
      metadata: { author: alice, createdAt: new Date().toISOString() },
      parts: [{ type: 'text', text: '以前说的话' }],
    });

    const { model, round } = setup({ turns: ['好'], store });
    await round('现在说的话');

    expect(messagesOf(model, 0)).toEqual([tagged('以前说的话'), tagged('现在说的话')]);
    expect(systemOf(model, 0)?.endsWith(`\n\n${titleSection('老群')}`)).toBe(true);
  });
});
