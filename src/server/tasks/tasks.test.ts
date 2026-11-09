import { MockLanguageModelV4 } from 'ai/test';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createMemoryStorage,
  defineTool,
  installTools,
  ToolError,
  type Message,
  type Storage,
  type Task,
  type ToolContext,
  type ToolDefinition,
  type Trigger,
} from '../../core/index.js';
import { fakeClock, testService } from '../test-kit.js';
import type {
  ChatChunk,
  ConversationsResponse,
  ErrorResponse,
  LiveEvent,
  MessagesResponse,
  ServerEvents,
  TaskRow,
  TasksResponse,
} from '../types.js';
import { createTaskTools } from './tools.js';

// 任务的工具、定时器、到点进网页会话、接口与 SSE。时间按上海（UTC+8）：结果里的时刻是确定的。
// 定时器用假时钟（只有 advance 时才走）；模型的流、「此刻」的合并照常用真的计时器

let originalTz: string | undefined;
beforeAll(() => {
  originalTz = process.env.TZ;
  process.env.TZ = 'Asia/Shanghai';
});
afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

/** 假时钟的起点：上海 2026-11-09 21:30（周一） */
const start = '2026-11-09T13:30:00.000Z';
const minute = 60_000;

// ─── 模型 ───────────────────────────────────────────────────────────────

type StreamResult = Awaited<ReturnType<MockLanguageModelV4['doStream']>>;
type StreamPart = StreamResult['stream'] extends ReadableStream<infer P> ? P : never;
type Item = StreamPart | { gate: Promise<void> };

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 2, text: 2, reasoning: undefined },
};
const finish = (reason: 'stop' | 'tool-calls' = 'stop'): StreamPart => ({
  type: 'finish',
  finishReason: { unified: reason, raw: undefined },
  usage,
});
const text = (...deltas: string[]): Item[] => [
  { type: 'text-start', id: 't' },
  ...deltas.map((delta): Item => ({ type: 'text-delta', id: 't', delta })),
  { type: 'text-end', id: 't' },
];
const answer = (...deltas: string[]): Item[] => [...text(...deltas), finish()];
/** 这一步调一个工具 */
const call = (toolName: string, input: unknown, id = `call-${toolName}`): Item[] => {
  const json = JSON.stringify(input);
  return [
    { type: 'tool-input-start', id, toolName },
    { type: 'tool-input-delta', id, delta: json },
    { type: 'tool-input-end', id },
    { type: 'tool-call', toolCallId: id, toolName, input: json },
    finish('tool-calls'),
  ];
};

/** 依次回应每次请求；gate 处停住，等它放行（请求被中止时随之失败） */
function scripted(...steps: Item[][]): MockLanguageModelV4 {
  let index = 0;
  return new MockLanguageModelV4({
    doStream: async ({ abortSignal }) => {
      const step = steps[index++];
      if (step === undefined) throw new Error('mock 模型没有更多脚本');
      const items = [...step];
      return {
        stream: new ReadableStream<StreamPart>(
          {
            async pull(controller) {
              for (let item = items.shift(); item !== undefined; item = items.shift()) {
                if ('gate' in item) {
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(check: () => boolean, what = '条件', timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`等待${what}超时`);
    await sleep(5);
  }
}

/** 第 index 次模型请求里所有消息的内容 */
const promptOf = (model: MockLanguageModelV4, index: number) =>
  JSON.stringify(model.doStreamCalls[index]?.prompt ?? []);

const textOf = (message: Message) =>
  message.parts.map((part) => (part.type === 'text' ? part.text : '')).join('');

// ─── 服务 ───────────────────────────────────────────────────────────────

const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const alice = { id: 'u-alice', name: 'Alice' };
const bob = { id: 'u-bob', name: 'Bob' };
const trigger = (author: Trigger['author'], messageId: string): Trigger => ({ author, messageId });

async function setup(
  model: MockLanguageModelV4 = scripted(),
  options: Omit<NonNullable<Parameters<typeof testService>[0]>, 'model'> = {},
) {
  const clock = fakeClock(start);
  const service = await testService({
    model,
    taskTools: true,
    clock,
    now: () => clock.now(),
    ...options,
  });
  const tasks = service.tasks!;
  cleanups.push(() => service.sessions!.close(0, 300));
  cleanups.push(() => tasks.stop());
  const post = (path: string, body: unknown, init: RequestInit = {}) =>
    service.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...init,
    });
  async function chat(body: unknown) {
    const response = await post('/api/chat', body);
    return { response, ...stream(response) };
  }
  /** 会话里的消息（核心存的原样） */
  async function messages(conversationId: string): Promise<Message[]> {
    return (await service.storage.openConversation(conversationId)).list();
  }
  /** 往前走 ms，等定时器把这次要做的做完 */
  async function advance(ms: number): Promise<void> {
    clock.advance(ms);
    await tasks.settled();
  }
  /** 「此刻」推出去的事件 */
  const broadcast = vi.spyOn(service.events, 'broadcast');
  const lives = () =>
    broadcast.mock.calls.flatMap(([name, data]) => (name === 'live' ? [data as LiveEvent] : []));
  // 直接调工具：ctx 照核心给的样子
  const tools = Object.fromEntries(
    createTaskTools(() => tasks).map((definition) => [definition.name, definition]),
  ) as Record<'create_task' | 'list_tasks' | 'cancel_task', ToolDefinition>;
  async function run(
    name: keyof typeof tools,
    input: unknown,
    { conversationId, triggers = [] }: { conversationId?: string; triggers?: Trigger[] },
  ): Promise<string> {
    const tool = tools[name];
    const ctx: ToolContext = {
      conversation: { id: conversationId },
      triggers,
      abortSignal: new AbortController().signal,
      logger: { info() {}, warn() {}, error() {} },
      env: {},
    };
    return (await tool.execute(tool.input.parse(input), ctx)) as string;
  }
  /** 调工具，应当以错误结果结束：返回模型看到的说明 */
  async function refused(...args: Parameters<typeof run>): Promise<string> {
    try {
      await run(...args);
    } catch (error) {
      expect(error).toBeInstanceOf(ToolError);
      return (error as ToolError).message;
    }
    throw new Error('应当以错误结果结束');
  }
  return {
    ...service,
    tasks,
    clock,
    post,
    chat,
    messages,
    advance,
    lives,
    tools,
    run,
    refused,
  };
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
    async until(check: (chunks: ChatChunk[]) => boolean) {
      await waitUntil(() => check(chunks), '回复的段');
    },
    async end() {
      await waitUntil(() => ended, '流结束');
    },
  };
}

type Received = {
  [K in keyof ServerEvents]: { event: K; data: ServerEvents[K] };
}[keyof ServerEvents];

/** 连一个面板：收下 SSE 事件（hello 除外） */
async function panel(service: Awaited<ReturnType<typeof setup>>) {
  const response = await service.request('/api/events');
  const reader = response.body!.getReader();
  cleanups.push(() => reader.cancel().catch(() => {}));
  const received: Received[] = [];
  let buffer = '';
  const decoder = new TextDecoder();
  void (async () => {
    for (let read = await reader.read(); !read.done; read = await reader.read()) {
      buffer += decoder.decode(read.value, { stream: true });
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop()!;
      for (const block of blocks) {
        const lines = block.split('\n');
        const event = lines.find((line) => line.startsWith('event: '))?.slice(7);
        const data = lines.find((line) => line.startsWith('data: '))?.slice(6);
        if (event && data && event !== 'hello') {
          received.push({ event, data: JSON.parse(data) } as Received);
        }
      }
    }
  })().catch(() => {});
  await waitUntil(() => service.events.size > 0, 'SSE 连上');
  return {
    /** 收到的 task 事件 */
    async tasks(count: number): Promise<TaskRow[]> {
      await service.relay.settled();
      const pick = () => received.flatMap((item) => (item.event === 'task' ? [item.data] : []));
      await waitUntil(() => pick().length >= count, `${count} 个 task 事件`);
      return pick();
    },
  };
}

// ─── 工具 ───────────────────────────────────────────────────────────────

describe('任务工具', () => {
  it('建一次性任务：结果给出任务 id、下次到点（带星期）与周期；记下是谁、哪条消息让建的', async () => {
    const { observed, run, tasks, storage } = await setup();
    const id = await observed.createConversation({ platform: 'web' });

    const output = await run(
      'create_task',
      { action: '提醒 Alice 交周报', kind: 'once', at: '2026-11-10 09:00' },
      { conversationId: id, triggers: [trigger(alice, 'm-1')] },
    );

    expect(output).toBe('已建任务 t1。\n下次到点：2026-11-10 09:00（周二）\n周期：一次性');
    expect(await storage.getTask(1)).toStrictEqual({
      id: 1,
      conversationId: id,
      action: '提醒 Alice 交周报',
      schedule: { kind: 'once', at: '2026-11-10T01:00:00.000Z' },
      source: { author: alice, messageId: 'm-1' },
      status: 'active',
      nextDueAt: '2026-11-10T01:00:00.000Z',
      dueCount: 0,
      createdAt: start,
    } satisfies Task);
    expect(tasks.now().toISOString()).toBe(start);
  });

  it('建周期任务：一句人话的周期，截止日期含那一天', async () => {
    const { observed, run } = await setup();
    const id = await observed.createConversation({ platform: 'web' });

    const output = await run(
      'create_task',
      { action: '说说今天的天气', kind: 'weekdays', time: '8:00', until: '2026-12-31' },
      { conversationId: id, triggers: [trigger(alice, 'm-1')] },
    );

    expect(output).toBe(
      '已建任务 t1。\n下次到点：2026-11-10 08:00（周二）\n周期：每个工作日 08:00，到 12-31 为止',
    );
  });

  it('列出：只列本会话进行中的任务，给出 id、做什么、周期、下次到点、谁让建的；没有时说没有', async () => {
    const { observed, run } = await setup();
    const id = await observed.createConversation({ platform: 'web' });
    const other = await observed.createConversation({ platform: 'web' });
    const by = { conversationId: id, triggers: [trigger(alice, 'm-1')] };
    await run('create_task', { action: '提醒交周报', kind: 'once', at: '2026-11-10 09:00' }, by);
    await run(
      'create_task',
      { action: '不该列出', kind: 'daily', time: '08:00' },
      {
        conversationId: other,
        triggers: [trigger(bob, 'm-2')],
      },
    );
    await run(
      'create_task',
      { action: '说天气', kind: 'weekly', weekday: 7, time: '20:00' },
      {
        conversationId: id,
        triggers: [trigger({ name: '网页用户' }, 'm-3')],
      },
    );
    await run('create_task', { action: '已经取消的', kind: 'daily', time: '09:00' }, by);
    await run('cancel_task', { task: 't4' }, by);

    expect(await run('list_tasks', {}, by)).toBe(
      [
        '这个会话进行中的任务有 2 个：',
        '- t1：提醒交周报（一次性，下次到点 2026-11-10 09:00（周二），Alice（uid u-alice）让建的）',
        '- t3：说天气（每周日 20:00，下次到点 2026-11-15 20:00（周日），网页用户让建的）',
      ].join('\n'),
    );
    const empty = await observed.createConversation({ platform: 'web' });
    expect(await run('list_tasks', {}, { conversationId: empty })).toBe('这个会话没有进行中的任务');
  });

  it('取消：t7 或 7 都收；状态改为已取消、记下结束时间', async () => {
    const { observed, run, storage, clock } = await setup();
    const id = await observed.createConversation({ platform: 'web' });
    const by = { conversationId: id, triggers: [trigger(alice, 'm-1')] };
    await run('create_task', { action: '提醒交周报', kind: 'once', at: '2026-11-10 09:00' }, by);
    await run('create_task', { action: '说天气', kind: 'daily', time: '08:00' }, by);
    clock.advance(minute);

    expect(await run('cancel_task', { task: 't1' }, by)).toBe('已取消 t1：提醒交周报');
    expect(await run('cancel_task', { task: ' 2 ' }, by)).toBe('已取消 t2：说天气');
    const cancelled = await storage.getTask(1);
    expect(cancelled).toMatchObject({ status: 'cancelled', endedAt: '2026-11-09T13:31:00.000Z' });
    expect(cancelled).not.toHaveProperty('nextDueAt');
  });

  it('界面摘要：建任务的是「t1 · 11-10 09:00 · 做什么」，列出、取消的照这个意思', async () => {
    const { tools } = await setup();
    const input = { action: '提醒交周报', kind: 'once', at: '2026-11-10 09:00' };
    const created = '已建任务 t1。\n下次到点：2026-11-10 09:00（周二）\n周期：一次性';
    const summary = (name: keyof typeof tools, args: unknown, output?: unknown) =>
      tools[name].summary!({ input: tools[name].input.parse(args), output });

    expect(summary('create_task', input)).toBe('11-10 09:00 · 提醒交周报');
    expect(summary('create_task', input, created)).toBe('t1 · 11-10 09:00 · 提醒交周报');
    expect(summary('create_task', { action: '说天气', kind: 'daily', time: '08:00' })).toBe(
      '每天 08:00 · 说天气',
    );
    expect(summary('list_tasks', {})).toBe('列出任务');
    expect(summary('list_tasks', {}, '这个会话进行中的任务有 3 个：\n- …')).toBe('3 个任务');
    expect(summary('list_tasks', {}, '这个会话没有进行中的任务')).toBe('没有任务');
    expect(summary('cancel_task', { task: 't1' })).toBe('取消 t1');
    expect(summary('cancel_task', { task: 't1' }, '已取消 t1：提醒交周报')).toBe(
      '取消 t1 · 提醒交周报',
    );
  });

  it('CLI 会话：三个工具都回「CLI 会话不能建任务」', async () => {
    const { observed, refused } = await setup();
    const id = await observed.createConversation({ platform: 'cli' });
    const by = { conversationId: id, triggers: [trigger({ name: 'swim' }, 'm-1')] };

    for (const [name, input] of [
      ['create_task', { action: '提醒', kind: 'once', at: '2026-11-10 09:00' }],
      ['list_tasks', {}],
      ['cancel_task', { task: 't1' }],
    ] as const) {
      expect(await refused(name, input, by)).toBe('CLI 会话不能建任务');
    }
  });

  it('时间不对：已经过了、超过一年、周期参数不完整或超出范围、截止日期过了，都以错误结果说明', async () => {
    const { observed, refused, storage } = await setup();
    const id = await observed.createConversation({ platform: 'web' });
    const by = { conversationId: id, triggers: [trigger(alice, 'm-1')] };
    const create = (input: object) => refused('create_task', { action: '提醒', ...input }, by);

    expect(await create({ kind: 'once', at: '2026-11-09 21:00' })).toBe(
      '这个时刻已经过了（现在是 2026-11-09 21:30（周一））',
    );
    expect(await create({ kind: 'once', at: '2027-12-01 09:00' })).toBe(
      '最远只能约到一年后（2027-11-09 21:30）',
    );
    expect(await create({ kind: 'daily' })).toContain('周期任务要写 time');
    expect(await create({ kind: 'weekly', time: '08:00', weekday: 9 })).toContain(
      'weekday 只能是 1–7',
    );
    expect(await create({ kind: 'monthly', time: '08:00' })).toContain('monthly 要写 day');
    expect(await create({ kind: 'daily', time: '08:00', until: '2026-11-01' })).toContain(
      '截止日期已经过了',
    );
    expect(
      await refused('create_task', { action: ' ', kind: 'daily', time: '08:00' }, by),
    ).toContain('action 不能是空的');
    expect(
      await refused('create_task', { action: '长'.repeat(201), kind: 'daily', time: '08:00' }, by),
    ).toContain('action 最多 200 个字');
    expect(await storage.listTasks()).toEqual([]);
  });

  it('满 20 个进行中的任务：回「这个会话的任务满了，先取消几个」；取消一个后又能建，别的会话不受影响', async () => {
    const { observed, run, refused } = await setup();
    const id = await observed.createConversation({ platform: 'web' });
    const other = await observed.createConversation({ platform: 'web' });
    const by = { conversationId: id, triggers: [trigger(alice, 'm-1')] };
    const input = { action: '提醒', kind: 'daily', time: '08:00' };
    for (let i = 0; i < 20; i++) await run('create_task', input, by);

    expect(await refused('create_task', input, by)).toBe('这个会话的任务满了，先取消几个');
    await run('create_task', input, { ...by, conversationId: other });
    await run('cancel_task', { task: 't3' }, by);
    expect(await run('create_task', input, by)).toContain('已建任务 t22。');
  });

  it('同时建好几个（同一步里的并发调用）也不会超过 20 个', async () => {
    const { observed, run, storage } = await setup();
    const id = await observed.createConversation({ platform: 'web' });
    const by = { conversationId: id, triggers: [trigger(alice, 'm-1')] };
    const input = { action: '提醒', kind: 'daily', time: '08:00' };

    const results = await Promise.allSettled(
      Array.from({ length: 25 }, () => run('create_task', input, by)),
    );

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(20);
    expect(await storage.listTasks({ conversationId: id, status: 'active' })).toHaveLength(20);
  });

  it('触发者：为空时只能拒绝；几个人一起触发时要写明是谁（uid 或名字），对不上也拒绝；同一个人发了几条就用最后一条', async () => {
    const { observed, run, refused, storage } = await setup();
    const id = await observed.createConversation({
      platform: 'telegram',
      platformConversationId: '-1',
    });
    const input = { action: '提醒', kind: 'daily', time: '08:00' };
    const merged = [trigger(alice, 'm-1'), trigger(bob, 'm-2'), trigger(alice, 'm-3')];

    expect(await refused('create_task', input, { conversationId: id })).toBe(
      '只能在有人让你建任务时建：这次回复不是哪个人的消息触发的',
    );
    expect(await refused('create_task', input, { conversationId: id, triggers: merged })).toBe(
      '这次回复是几个人的消息一起触发的（Alice（uid u-alice）、Bob（uid u-bob）），用 requested_by 写明是谁让建的：<message> 里的 uid，没有 uid 时写名字',
    );
    expect(
      await refused(
        'create_task',
        { ...input, requested_by: 'u-carol' },
        { conversationId: id, triggers: merged },
      ),
    ).toBe('requested_by 对不上这次触发的人：Alice（uid u-alice）、Bob（uid u-bob）');

    await run(
      'create_task',
      { ...input, requested_by: 'u-alice' },
      { conversationId: id, triggers: merged },
    );
    await run(
      'create_task',
      { ...input, requested_by: 'Bob' },
      { conversationId: id, triggers: merged },
    );
    await run('create_task', input, {
      conversationId: id,
      triggers: [trigger(bob, 'm-4'), trigger(bob, 'm-5')],
    });
    expect((await storage.listTasks()).map((task) => task.source)).toEqual([
      { author: alice, messageId: 'm-3' },
      { author: bob, messageId: 'm-2' },
      { author: bob, messageId: 'm-5' },
    ]);
  });

  it('取消别的会话的任务、已经结束的、不存在的：一律「没有这个任务」，不动那个任务', async () => {
    const { observed, run, refused, storage } = await setup();
    const id = await observed.createConversation({ platform: 'web' });
    const other = await observed.createConversation({ platform: 'web' });
    const input = { action: '提醒', kind: 'daily', time: '08:00' };
    await run('create_task', input, { conversationId: other, triggers: [trigger(bob, 'm-1')] });
    const by = { conversationId: id, triggers: [trigger(alice, 'm-2')] };
    await run('create_task', input, by);
    await run('cancel_task', { task: 't2' }, by);

    for (const task of ['t1', 't2', 't99', '第一个']) {
      expect(await refused('cancel_task', { task }, by)).toBe('没有这个任务');
    }
    expect((await storage.getTask(1))?.status).toBe('active');
  });
});

// ─── 定时器 ─────────────────────────────────────────────────────────────

describe('定时器', () => {
  /** 一个网页会话里，Alice 让建的任务 */
  async function withTask(
    s: Awaited<ReturnType<typeof setup>>,
    input: Record<string, unknown>,
    conversationId?: string,
  ) {
    const id = conversationId ?? (await s.observed.createConversation({ platform: 'web' }));
    await s.run(
      'create_task',
      { action: '提醒 Alice 喝水', ...input },
      {
        conversationId: id,
        triggers: [trigger(alice, 'm-src')],
      },
    );
    return id;
  }

  it('准时到点（网页会话空闲）：写一条事件、发起回复（由服务读完）；一次性的完成；「此刻」的 start 带着任务', async () => {
    const model = scripted(answer('该喝水啦'));
    const s = await setup(model);
    const id = await withTask(s, { kind: 'once', at: '2026-11-09 21:32' });
    s.tasks.start();
    await s.tasks.settled();
    // 等待封顶 60 秒：第一分钟时还没到
    expect(s.clock.pending()).toEqual([minute]);
    await s.advance(minute);
    expect(model.doStreamCalls).toHaveLength(0);

    await s.advance(minute);
    await waitUntil(() => model.doStreamCalls.length === 1 && !s.chats!.busy(id), '到点的回复');

    const [event, reply] = await s.messages(id);
    expect(event).toMatchObject({
      role: 'user',
      metadata: { event: { type: 'task', taskId: 1 } },
    });
    expect(event!.metadata).not.toHaveProperty('author');
    expect(textOf(event!)).toBe(
      '任务到点：提醒 Alice 喝水。Alice（uid u-alice）在 11-09 21:30 让你建的，一次性任务。',
    );
    expect(reply).toMatchObject({ role: 'assistant' });
    expect(textOf(reply!)).toBe('该喝水啦');
    expect(promptOf(model, 0)).toContain('<event type=\\"task\\" task=\\"t1\\"');
    expect(await s.storage.getTask(1)).toMatchObject({
      status: 'done',
      dueCount: 1,
      lastDueAt: '2026-11-09T13:32:00.000Z',
      endedAt: '2026-11-09T13:32:00.000Z',
    });
    const startEvent = s.lives().find((event) => event.type === 'start');
    expect(startEvent).toMatchObject({
      conversationId: id,
      tasks: [{ id: 1, ref: 't1', action: '提醒 Alice 喝水' }],
    });
    // 没有要到点的了：不再等
    expect(s.clock.pending()).toEqual([]);
  });

  it('到点的回复进行中：现场里这条带着任务，面板新连上时也拿得到', async () => {
    const hold = gate();
    const model = scripted([...text('该喝'), { gate: hold.promise }, finish()]);
    const s = await setup(model);
    const id = await withTask(s, { kind: 'once', at: '2026-11-09 21:31' });
    s.tasks.start();

    await s.advance(minute);
    await waitUntil(() => s.live.snapshot().replies.length === 1, '现场里的回复');

    expect(s.live.snapshot().replies[0]).toMatchObject({
      conversationId: id,
      tasks: [{ id: 1, ref: 't1', action: '提醒 Alice 喝水' }],
    });
    hold.open();
    await waitUntil(() => !s.chats!.busy(id), '回复结束');
  });

  it('周期任务到点：到点次数加一、记上次到点，算出下一次，仍在进行中', async () => {
    const model = scripted(answer('今天晴'));
    const s = await setup(model);
    const id = await withTask(s, { kind: 'daily', time: '21:31' });
    s.tasks.start();

    await s.advance(minute);
    await waitUntil(() => model.doStreamCalls.length === 1 && !s.chats!.busy(id), '到点的回复');

    expect(await s.storage.getTask(1)).toMatchObject({
      status: 'active',
      dueCount: 1,
      lastDueAt: '2026-11-09T13:31:00.000Z',
      nextDueAt: '2026-11-10T13:31:00.000Z',
    });
    expect(textOf((await s.messages(id))[0]!)).toContain('周期任务（每天 21:31）');
  });

  it('同一时刻同一个会话有几个任务到点：各写各的事件，只回复一次，回复看到全部', async () => {
    const model = scripted(answer('两件事都提醒一下'));
    const s = await setup(model);
    const id = await withTask(s, { kind: 'once', at: '2026-11-09 21:31' });
    await withTask(s, { kind: 'daily', time: '21:31', action: '说说天气' }, id);
    s.tasks.start();

    await s.advance(minute);
    await waitUntil(() => model.doStreamCalls.length === 1 && !s.chats!.busy(id), '到点的回复');
    await sleep(50);

    expect(model.doStreamCalls).toHaveLength(1);
    expect((await s.messages(id)).map((m) => m.metadata?.event?.taskId ?? m.role)).toEqual([
      1,
      2,
      'assistant',
    ]);
    expect(s.lives().find((event) => event.type === 'start')).toMatchObject({
      tasks: [
        { id: 1, ref: 't1' },
        { id: 2, ref: 't2', action: '说说天气' },
      ],
    });
  });

  it('晚了超过 5 分钟算错过：写一条 task-missed（用写入的时刻），不回复；一次性的改为已完成', async () => {
    const model = scripted();
    const s = await setup(model);
    const id = await withTask(s, { kind: 'once', at: '2026-11-09 21:32' });
    // 服务停着（定时器没开始）的时候过了到点时间
    s.clock.advance(10 * minute);

    const before = Date.now();
    s.tasks.start();
    await s.tasks.settled();
    const after = Date.now();
    await sleep(30);

    expect(model.doStreamCalls).toHaveLength(0);
    expect(s.chats!.busy(id)).toBe(false);
    const [event, ...rest] = await s.messages(id);
    expect(rest).toEqual([]);
    expect(event!.metadata?.event).toEqual({ type: 'task-missed', taskId: 1 });
    expect(textOf(event!)).toBe(
      '任务超时：提醒 Alice 喝水（本该 11-09 21:32 到点，那时洛璃服务没在运行）。这个一次性任务已经结束。',
    );
    // createdAt 是写入的时刻（核心取的系统时间），不是该到点的时刻
    const createdAt = Date.parse(event!.metadata!.createdAt);
    expect(createdAt).toBeGreaterThanOrEqual(before);
    expect(createdAt).toBeLessThanOrEqual(after);
    expect(await s.storage.getTask(1)).toMatchObject({
      status: 'done',
      dueCount: 0,
      endedAt: '2026-11-09T13:40:00.000Z',
    });
  });

  it('周期任务错过好几次：只写一条「任务超时」，说超时几次、最近一次本该几点；从现在起算下一次', async () => {
    const model = scripted();
    const s = await setup(model);
    const id = await withTask(s, { kind: 'daily', time: '21:35' });
    // 停了三天多：11-09、10、11、12 的 21:35 都错过了
    s.clock.advance(3 * 24 * 60 * minute + 60 * minute);

    s.tasks.start();
    await s.tasks.settled();

    expect(model.doStreamCalls).toHaveLength(0);
    const events = await s.messages(id);
    expect(events).toHaveLength(1);
    expect(textOf(events[0]!)).toBe(
      '任务超时：提醒 Alice 喝水（每天 21:35；超时 4 次，最近一次本该 11-12 21:35 到点，那时洛璃服务没在运行）。下次到点是 2026-11-13 21:35（周五）。',
    );
    expect(await s.storage.getTask(1)).toMatchObject({
      status: 'active',
      dueCount: 0,
      nextDueAt: '2026-11-13T13:35:00.000Z',
    });
  });

  it('错过之后的下一次正好在 5 分钟里：先写错过，再照常到点、回复', async () => {
    const model = scripted(answer('补上今天的'));
    const s = await setup(model);
    const id = await withTask(s, { kind: 'daily', time: '21:35' });
    // 到第二天 21:37：昨天那次错过了，今天这次只晚了 2 分钟
    s.clock.advance(24 * 60 * minute + 7 * minute);

    s.tasks.start();
    await s.tasks.settled();
    await waitUntil(() => model.doStreamCalls.length === 1 && !s.chats!.busy(id), '到点的回复');

    expect((await s.messages(id)).map((m) => m.metadata?.event?.type ?? m.role)).toEqual([
      'task-missed',
      'task',
      'assistant',
    ]);
    expect(await s.storage.getTask(1)).toMatchObject({
      dueCount: 1,
      lastDueAt: '2026-11-10T13:35:00.000Z',
      nextDueAt: '2026-11-11T13:35:00.000Z',
    });
  });

  it('新建、取消后重排：等到最近的那个（最多 60 秒）；没有任务时不等', async () => {
    const s = await setup();
    const id = await s.observed.createConversation({ platform: 'web' });
    const by = { conversationId: id, triggers: [trigger(alice, 'm-1')] };
    s.tasks.start();
    await s.tasks.settled();
    expect(s.clock.pending()).toEqual([]);

    await s.run('create_task', { action: '晚点', kind: 'once', at: '2026-11-09 21:40' }, by);
    await s.tasks.settled();
    expect(s.clock.pending()).toEqual([minute]);
    // 到时候看一眼，还没到点：再等
    await s.advance(30_000);
    await s.run('create_task', { action: '早点', kind: 'once', at: '2026-11-09 21:31' }, by);
    await s.tasks.settled();
    expect(s.clock.pending()).toEqual([30_000]);

    await s.run('cancel_task', { task: 't2' }, by);
    await s.tasks.settled();
    expect(s.clock.pending()).toEqual([minute]);
    await s.run('cancel_task', { task: 't1' }, by);
    await s.tasks.settled();
    expect(s.clock.pending()).toEqual([]);
  });

  /** 改任务一直失败的存储（别的照常） */
  function brokenUpdates(): Storage {
    const storage = createMemoryStorage();
    return {
      ...storage,
      updateTask: async () => {
        throw new Error('写不进去');
      },
    };
  }

  it('改任务一直失败时不重试：同一次到点只写一条事件、只交给前端一次；之后按 60 秒再看，不原地空转', async () => {
    const model = scripted(answer('该喝水啦'));
    const s = await setup(model, { storage: brokenUpdates() });
    const delivered = vi.spyOn(s.chats!, 'due');
    const id = await withTask(s, { kind: 'once', at: '2026-11-09 21:31' });
    s.tasks.start();

    await s.advance(minute);
    await waitUntil(() => model.doStreamCalls.length === 1 && !s.chats!.busy(id), '到点的回复');
    // 任务还停在过去的下次到点：下一次照样等 60 秒，不是马上
    expect(s.clock.pending()).toEqual([minute]);
    for (let i = 0; i < 3; i++) await s.advance(minute);
    await sleep(30);

    expect((await s.messages(id)).map((m) => m.metadata?.event?.type ?? m.role)).toEqual([
      'task',
      'assistant',
    ]);
    expect(delivered).toHaveBeenCalledTimes(1);
    expect(model.doStreamCalls).toHaveLength(1);
    expect(s.entries.filter((entry) => entry.msg === 'task.due')).toHaveLength(1);
    expect(s.entries.filter((entry) => entry.msg === 'task.update_failed')).toHaveLength(1);
    expect(s.clock.pending()).toEqual([minute]);
  });

  it('改任务一直失败时，任务超时那条路也只写一条事件', async () => {
    const model = scripted();
    const s = await setup(model, { storage: brokenUpdates() });
    const delivered = vi.spyOn(s.chats!, 'due');
    const id = await withTask(s, { kind: 'daily', time: '21:32' });
    s.clock.advance(10 * minute);

    s.tasks.start();
    await s.tasks.settled();
    expect(s.clock.pending()).toEqual([minute]);
    for (let i = 0; i < 3; i++) await s.advance(minute);

    expect((await s.messages(id)).map((m) => m.metadata?.event?.type)).toEqual(['task-missed']);
    expect(delivered).not.toHaveBeenCalled();
    expect(model.doStreamCalls).toHaveLength(0);
    expect(s.entries.filter((entry) => entry.msg === 'task.missed')).toHaveLength(1);
  });

  it('退出后不再触发：停掉定时器，过了到点时间也不写事件、不回复', async () => {
    const model = scripted(answer('不该有'));
    const s = await setup(model);
    const id = await withTask(s, { kind: 'once', at: '2026-11-09 21:31' });
    s.tasks.start();
    await s.tasks.settled();

    await s.tasks.stop();
    expect(s.clock.pending()).toEqual([]);
    await s.advance(5 * minute);

    expect(await s.messages(id)).toEqual([]);
    expect(model.doStreamCalls).toHaveLength(0);
    expect((await s.storage.getTask(1))?.status).toBe('active');
  });

  it('Telegram 会话到点：只写事件、不回复（第 4 步再接），记一行日志', async () => {
    const model = scripted();
    const s = await setup(model);
    const id = await s.observed.createConversation({
      platform: 'telegram',
      platformConversationId: '-100',
    });
    await withTask(s, { kind: 'once', at: '2026-11-09 21:31' }, id);
    s.tasks.start();

    await s.advance(minute);

    expect((await s.messages(id)).map((m) => m.metadata?.event?.type)).toEqual(['task']);
    expect(model.doStreamCalls).toHaveLength(0);
    expect(s.entries.find((entry) => entry.msg === 'task.no_entrance')?.fields).toMatchObject({
      conversationId: id,
      platform: 'telegram',
    });
  });

  it('日志：到点、错过各一行，只有任务 id、会话 id、晚了多久，没有「做什么」', async () => {
    const model = scripted(answer('好'));
    const s = await setup(model);
    const id = await withTask(s, { kind: 'once', at: '2026-11-09 21:31' });
    await withTask(s, { kind: 'once', at: '2026-11-09 21:31' }, id);
    s.clock.advance(minute + 10_000);
    // 只有第 2 个错过：把第 1 个的到点时间往后挪到 1 分钟前
    await s.storage.updateTask(1, { nextDueAt: '2026-11-09T13:31:00.000Z' });
    await s.storage.updateTask(2, { nextDueAt: '2026-11-09T13:20:00.000Z' });
    s.tasks.start();
    await s.tasks.settled();
    await waitUntil(() => !s.chats!.busy(id), '回复结束');

    const due = s.entries.find((entry) => entry.msg === 'task.due')!;
    const missed = s.entries.find((entry) => entry.msg === 'task.missed')!;
    expect(due.fields).toEqual({ taskId: 1, conversationId: id, lateMs: 10_000 });
    expect(missed.fields).toEqual({
      taskId: 2,
      conversationId: id,
      lateMs: 11 * minute + 10_000,
      missed: 1,
    });
    expect(JSON.stringify(s.entries)).not.toContain('喝水');
  });
});

// ─── 到点进网页会话 ─────────────────────────────────────────────────────

describe('到点进网页会话', () => {
  it('正在回复时到点：事件排在这次回复后面，回复结束后补一次，补的那次看得到事件、带着任务', async () => {
    const hold = gate();
    const model = scripted(
      [...text('先说到这'), { gate: hold.promise }, finish()],
      answer('喝水时间到'),
    );
    const s = await setup(model);
    const first = await s.chat({ text: '你好' });
    await first.until((chunks) => chunks.some((chunk) => chunk.type === 'text-end'));
    const id = first.response.headers.get('x-conversation-id')!;
    await s.run(
      'create_task',
      { action: '提醒 Alice 喝水', kind: 'once', at: '2026-11-09 21:31' },
      {
        conversationId: id,
        triggers: [trigger(alice, 'm-src')],
      },
    );
    s.tasks.start();

    await s.advance(minute);
    // 事件马上写进历史，补回复排着；「此刻」里这条记上又被触发
    expect((await s.messages(id)).map((m) => m.metadata?.event?.type ?? m.role)).toEqual([
      'user',
      'task',
    ]);
    expect(s.live.snapshot().replies).toEqual([
      expect.objectContaining({ conversationId: id, again: true, queuedFrom: 3 }),
    ]);

    hold.open();
    await first.end();
    await waitUntil(() => model.doStreamCalls.length === 2 && !s.chats!.busy(id), '补回复');

    const history = await s.messages(id);
    expect(history.map((m) => m.metadata?.event?.type ?? m.role)).toEqual([
      'user',
      'assistant',
      'task',
      'assistant',
    ]);
    expect(textOf(history[1]!)).toBe('先说到这');
    expect(textOf(history[3]!)).toBe('喝水时间到');
    expect(promptOf(model, 1)).toContain('task=\\"t1\\"');
    // 补回复的流没有请求接：发起第一次回复的请求只收到第一次的
    expect(first.chunks.filter((chunk) => chunk.type === 'text-delta').length).toBeGreaterThan(0);
    expect(JSON.stringify(first.chunks)).not.toContain('喝水时间到');
    const starts = s.lives().filter((event) => event.type === 'start');
    expect(starts).toHaveLength(2);
    expect(starts[0]).not.toHaveProperty('tasks');
    expect(starts[1]).toMatchObject({ tasks: [{ id: 1, ref: 't1' }] });
  });

  it('关掉页面不会取消到点的补回复：回复中的请求、排队的请求都断开，补回复照常、由服务读完', async () => {
    const hold = gate();
    const model = scripted(
      [...text('说到'), { gate: hold.promise }, finish()],
      answer('该喝水了，顺便回你'),
    );
    const s = await setup(model);
    const first = await s.chat({ clientId: 'tab', text: '第一句' });
    await first.until((chunks) => chunks.some((chunk) => chunk.type === 'text-end'));
    const id = first.response.headers.get('x-conversation-id')!;
    const queued = await s.chat({ conversationId: id, clientId: 'tab', text: '第二句' });
    await queued.until((chunks) => chunks.some((chunk) => chunk.type === 'data-queued'));
    await s.run(
      'create_task',
      { action: '提醒喝水', kind: 'once', at: '2026-11-09 21:31' },
      {
        conversationId: id,
        triggers: [trigger(alice, 'm-src')],
      },
    );
    s.tasks.start();
    await s.advance(minute);

    // 关掉页面：两个请求先后断开
    await first.reader.cancel();
    await sleep(15);
    await queued.reader.cancel();
    await waitUntil(() => model.doStreamCalls.length === 2 && !s.chats!.busy(id), '补回复');
    hold.open();

    const history = await s.messages(id);
    expect(history.map((m) => m.metadata?.event?.type ?? textOf(m))).toEqual([
      '第一句',
      '说到',
      '第二句',
      'task',
      '该喝水了，顺便回你',
    ]);
    expect(history[1]!.metadata?.aborted).toBe(true);
    expect(promptOf(model, 1)).toContain('第二句');
    expect(promptOf(model, 1)).toContain('task=\\"t1\\"');
  });

  it('中止接口照常能取消到点的补回复：事件留在历史里', async () => {
    const hold = gate();
    const model = scripted([...text('说到'), { gate: hold.promise }, finish()], answer('不该有'));
    const s = await setup(model);
    const first = await s.chat({ text: '第一句' });
    await first.until((chunks) => chunks.some((chunk) => chunk.type === 'text-end'));
    const id = first.response.headers.get('x-conversation-id')!;
    await s.run(
      'create_task',
      { action: '提醒喝水', kind: 'once', at: '2026-11-09 21:31' },
      {
        conversationId: id,
        triggers: [trigger(alice, 'm-src')],
      },
    );
    s.tasks.start();
    await s.advance(minute);

    const aborted = await s.post(`/api/chat/${id}/abort`, {});
    expect(await aborted.json()).toEqual({ aborted: true });
    await first.end();
    await waitUntil(() => !s.chats!.busy(id), '回复结束');
    hold.open();
    await sleep(30);

    expect(model.doStreamCalls).toHaveLength(1);
    expect((await s.messages(id)).map((m) => m.metadata?.event?.type ?? m.role)).toEqual([
      'user',
      'assistant',
      'task',
    ]);
  });

  it('网页会话里让洛璃建任务：工具在 ctx.triggers 拿到这条消息，发言人是 LUOLI_WEB_NAME', async () => {
    const model = scripted(
      call('create_task', { action: '提醒我喝水', kind: 'once', at: '2026-11-09 21:32' }),
      answer('好，21:32 提醒你'),
    );
    const s = await setup(model, { author: 'Carol' });
    const sent = await s.chat({ text: '两分钟后提醒我喝水' });
    await sent.end();
    const id = sent.response.headers.get('x-conversation-id')!;
    const [message] = await s.messages(id);

    expect(await s.storage.getTask(1)).toMatchObject({
      conversationId: id,
      action: '提醒我喝水',
      source: { author: { name: 'Carol' }, messageId: message!.id },
    });
    expect(promptOf(model, 1)).toContain('已建任务 t1');
    // 流里给界面看的摘要
    expect(sent.chunks).toContainEqual({
      type: 'data-tool-summary',
      data: { toolCallId: 'call-create_task', summary: 't1 · 11-09 21:32 · 提醒我喝水' },
      transient: true,
    });
  });
});

describe('对话接口传触发者', () => {
  /** 记下每次调用时 ctx.triggers 的工具 */
  function probe() {
    const seen: Array<readonly Trigger[]> = [];
    const definition = defineTool({
      name: 'probe',
      description: '记下触发者',
      input: z.object({}),
      execute: (_input, ctx) => {
        seen.push(ctx.triggers);
        return 'ok';
      },
    });
    return { tools: installTools([definition], {}).tools, seen };
  }

  it('网页会话：直接回复的是这条消息；排队的补回复是这一轮排队的几条，按先后', async () => {
    const hold = gate();
    const { tools, seen } = probe();
    const model = scripted(
      call('probe', {}, 'p1'),
      [...text('第一次'), { gate: hold.promise }, finish()],
      call('probe', {}, 'p2'),
      answer('补的'),
    );
    const s = await setup(model, { tools, author: 'Dana' });
    const first = await s.chat({ text: '第一句' });
    await first.until((chunks) => chunks.some((chunk) => chunk.type === 'text-end'));
    const id = first.response.headers.get('x-conversation-id')!;
    const b = await s.chat({ conversationId: id, text: '第二句' });
    await b.until((chunks) => chunks.some((chunk) => chunk.type === 'data-queued'));
    const c = await s.chat({ conversationId: id, text: '第三句' });
    await c.until((chunks) => chunks.some((chunk) => chunk.type === 'data-queued'));
    hold.open();
    await c.end();
    await waitUntil(() => seen.length === 2 && !s.chats!.busy(id), '补回复');

    const ids = (await s.messages(id)).filter((m) => m.role === 'user').map((m) => m.id);
    const dana = { name: 'Dana' };
    expect(seen[0]).toEqual([{ author: dana, messageId: ids[0] }]);
    expect(seen[1]).toEqual([
      { author: dana, messageId: ids[1] },
      { author: dana, messageId: ids[2] },
    ]);
  });

  it('CLI 会话：发言人是请求带的 author', async () => {
    const { tools, seen } = probe();
    const model = scripted(call('probe', {}), answer('好'));
    const s = await setup(model, { tools });
    const sent = await s.chat({ platform: 'cli', author: 'swim', text: '在吗' });
    await sent.end();
    const id = sent.response.headers.get('x-conversation-id')!;
    const [message] = await s.messages(id);

    expect(seen).toEqual([[{ author: { name: 'swim' }, messageId: message!.id }]]);
  });

  it('重试：交给工具的是出错的那次回答的消息', async () => {
    const { tools, seen } = probe();
    const model = new MockLanguageModelV4({
      doStream: (() => {
        let index = 0;
        const steps = [
          () => {
            throw Object.assign(new Error('坏了'), { statusCode: 400 });
          },
          () => scriptedStream(call('probe', {})),
          () => scriptedStream(answer('好了')),
        ];
        return async () => steps[index++]!();
      })(),
    });
    const s = await setup(model, { tools, author: 'Eve' });
    const sent = await s.chat({ text: '帮我看看' });
    await sent.end();
    const id = sent.response.headers.get('x-conversation-id')!;
    await waitUntil(() => !s.chats!.busy(id), '回复结束');

    const retried = await s.chat({ conversationId: id, retry: true });
    await retried.end();
    const [message] = await s.messages(id);

    expect(seen).toEqual([[{ author: { name: 'Eve' }, messageId: message!.id }]]);
  });
});

/** 一次请求的流：给 MockLanguageModelV4 的 doStream 用 */
function scriptedStream(items: Item[]) {
  return {
    stream: new ReadableStream<StreamPart>({
      start(controller) {
        for (const item of items) if (!('gate' in item)) controller.enqueue(item);
        controller.close();
      },
    }),
  };
}

// ─── 接口与 SSE ─────────────────────────────────────────────────────────

describe('任务的接口', () => {
  it('GET /api/tasks：进行中的，加上最近 30 天里结束的；每个给出会话、周期（结构与人话）、谁让建的等', async () => {
    const s = await setup();
    const web = await s.observed.createConversation({ platform: 'web' });
    s.webState.setTitle(web, '喝水提醒');
    const group = await s.observed.createConversation({
      platform: 'telegram',
      platformConversationId: '-100',
      title: '读书会',
    });
    await s.run(
      'create_task',
      { action: '提醒喝水', kind: 'once', at: '2026-11-10 09:00' },
      {
        conversationId: web,
        triggers: [trigger({ name: 'Alice' }, 'm-1')],
      },
    );
    await s.run(
      'create_task',
      { action: '说天气', kind: 'weekdays', time: '08:00', until: '2026-12-31' },
      {
        conversationId: group,
        triggers: [trigger(bob, 'm-2')],
      },
    );
    // 31 天前结束的不列，29 天前结束的列
    const old = await s.storage.createTask({
      conversationId: group,
      action: '很久以前',
      schedule: { kind: 'daily', time: '08:00' },
      source: { author: bob, messageId: 'm-3' },
    });
    await s.storage.updateTask(old.id, {
      status: 'cancelled',
      endedAt: new Date(Date.parse(start) - 31 * 86_400_000).toISOString(),
    });
    const recent = await s.storage.createTask({
      conversationId: group,
      action: '前不久',
      schedule: { kind: 'daily', time: '08:00' },
      source: { author: bob, messageId: 'm-4' },
    });
    await s.storage.updateTask(recent.id, {
      status: 'done',
      endedAt: new Date(Date.parse(start) - 29 * 86_400_000).toISOString(),
    });

    const response = await s.request('/api/tasks');
    const { tasks } = (await response.json()) as TasksResponse;

    expect(response.status).toBe(200);
    expect(tasks.map((task) => task.ref)).toEqual(['t1', 't2', 't4']);
    expect(tasks[0]).toStrictEqual({
      id: 1,
      ref: 't1',
      action: '提醒喝水',
      scheduleText: '一次性',
      conversation: { id: web, platform: 'web', kind: 'web', title: '喝水提醒' },
      schedule: { kind: 'once', at: '2026-11-10T01:00:00.000Z' },
      status: 'active',
      nextDueAt: '2026-11-10T01:00:00.000Z',
      dueCount: 0,
      requestedBy: { name: 'Alice' },
      createdAt: start,
    } satisfies TaskRow);
    expect(tasks[1]).toMatchObject({
      conversation: { id: group, platform: 'telegram', kind: 'group', title: '读书会' },
      scheduleText: '每个工作日 08:00，到 12-31 为止',
      requestedBy: bob,
    });
    expect(tasks[2]).toMatchObject({ status: 'done', endedAt: expect.any(String) });
  });

  it('POST /api/tasks/:id/cancel：取消任何会话的任务，返回取消后的一行，定时器重排；没有 404，已经结束 409', async () => {
    const s = await setup();
    const id = await s.observed.createConversation({ platform: 'web' });
    await s.run(
      'create_task',
      { action: '提醒喝水', kind: 'once', at: '2026-11-09 21:40' },
      {
        conversationId: id,
        triggers: [trigger(alice, 'm-1')],
      },
    );
    s.tasks.start();
    await s.tasks.settled();
    expect(s.clock.pending()).toEqual([minute]);

    const response = await s.post('/api/tasks/1/cancel', {});
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: 1,
      status: 'cancelled',
      endedAt: start,
    } satisfies Partial<TaskRow>);
    await s.tasks.settled();
    expect(s.clock.pending()).toEqual([]);

    const again = await s.post('/api/tasks/1/cancel', {});
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: '任务已经结束了' } satisfies ErrorResponse);
    const missing = await s.post('/api/tasks/99/cancel', {});
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: '没有这个任务' } satisfies ErrorResponse);
    expect((await s.post('/api/tasks/t1/cancel', {})).status).toBe(400);
  });

  it('取消接口照现有的访问控制：要 JSON，Origin 要对', async () => {
    const s = await setup();
    const id = await s.observed.createConversation({ platform: 'web' });
    await s.run(
      'create_task',
      { action: '提醒', kind: 'daily', time: '08:00' },
      {
        conversationId: id,
        triggers: [trigger(alice, 'm-1')],
      },
    );

    const form = await s.request('/api/tasks/1/cancel', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{}',
    });
    expect(form.status).toBe(415);
    const crossSite = await s.post(
      '/api/tasks/1/cancel',
      {},
      {
        headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
      },
    );
    expect(crossSite.status).toBe(403);
    expect((await s.storage.getTask(1))?.status).toBe('active');
  });

  it('SSE：任务新建、到点、取消时各推一个 task 事件，带这一行的新样子', async () => {
    const model = scripted(answer('到点了'));
    const s = await setup(model);
    const listening = await panel(s);
    const id = await s.observed.createConversation({ platform: 'web' });
    const by = { conversationId: id, triggers: [trigger(alice, 'm-1')] };
    await s.run('create_task', { action: '说天气', kind: 'daily', time: '21:31' }, by);
    s.tasks.start();
    await s.advance(minute);
    await waitUntil(() => !s.chats!.busy(id) && model.doStreamCalls.length === 1, '到点的回复');
    await s.run('cancel_task', { task: 't1' }, by);

    const rows = await listening.tasks(3);
    expect(rows.map((row) => [row.ref, row.status, row.dueCount])).toEqual([
      ['t1', 'active', 0],
      ['t1', 'active', 1],
      ['t1', 'cancelled', 1],
    ]);
    expect(rows[1]).toMatchObject({
      lastDueAt: '2026-11-09T13:31:00.000Z',
      nextDueAt: '2026-11-10T13:31:00.000Z',
    });
  });
});

// ─── 事件在面板的数据里 ─────────────────────────────────────────────────

describe('事件在面板的数据里', () => {
  it('未读不算事件：Telegram 群里已读位置之后的事件不算，人发的照算', async () => {
    const s = await setup();
    const id = await s.storage.createConversation({
      platform: 'telegram',
      platformConversationId: '-100',
      title: '读书会',
    });
    const store = await s.storage.openConversation(id);
    const at = '2026-11-09T13:00:00.000Z';
    const add = (metadata: Message['metadata'], body: string) =>
      store.add({ id: `m-${body}`, role: 'user', metadata, parts: [{ type: 'text', text: body }] });
    await add({ author: alice, createdAt: at }, '早');
    await add({ event: { type: 'task', taskId: 1 }, createdAt: at }, '任务到点');
    await add({ event: { type: 'task-missed', taskId: 2 }, createdAt: at }, '任务超时');
    await add({ author: bob, createdAt: at }, '在吗');

    const { conversations } = (await (
      await s.request('/api/conversations')
    ).json()) as ConversationsResponse;

    expect(conversations.find((row) => row.id === id)?.unread).toBe(2);
  });

  it('事件是最后一条时，预览带事件的类型、没有发言人；消息带着它说的任务', async () => {
    const s = await setup();
    const id = await s.observed.createConversation({ platform: 'web' });
    await s.run(
      'create_task',
      { action: '提醒喝水', kind: 'daily', time: '08:00' },
      {
        conversationId: id,
        triggers: [trigger(alice, 'm-1')],
      },
    );
    const conversation = await s.sessions!.open(id);
    await conversation.append({ event: { type: 'task', taskId: 1 }, text: '任务到点：提醒喝水。' });
    await conversation.append({ event: { type: 'task', taskId: 9 }, text: '任务不在了' });

    const { conversations } = (await (
      await s.request('/api/conversations')
    ).json()) as ConversationsResponse;
    expect(conversations.find((row) => row.id === id)?.last).toStrictEqual({
      seq: 2,
      createdAt: expect.any(String),
      role: 'user',
      event: 'task',
      text: '任务不在了',
    });
    const { messages } = (await (
      await s.request(`/api/conversations/${id}/messages`)
    ).json()) as MessagesResponse;
    expect(messages[0]!.task).toStrictEqual({
      id: 1,
      ref: 't1',
      action: '提醒喝水',
      scheduleText: '每天 08:00',
    });
    expect(messages[1]).not.toHaveProperty('task');
  });
});
