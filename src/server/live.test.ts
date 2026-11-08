import type { TelegramChat, TelegramUser } from '@chat-adapter/telegram';
import { APICallError } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createMemoryFileStore,
  createMemoryStorage,
  defineTool,
  installTools,
  TextAndImages,
  type FileStore,
  type Message,
  type MessageChunk,
  type Storage,
} from '../core/index.js';
import { testPrompts } from '../core/test-prompts.js';
import { startFakeTelegram } from '../telegram/fake-api.js';
import { createLive } from './live.js';
import { createSessions } from './sessions.js';
import { startTelegramFrontend } from './telegram.js';
import { recordingLogger, testService } from './test-kit.js';
import type {
  Hello,
  LiveEvent,
  LiveReasoning,
  LiveReply,
  LiveSnapshot,
  LiveText,
  LiveTool,
  ServiceStatus,
} from './types.js';

// ─── 模型 ───────────────────────────────────────────────────────────────

type StreamResult = Awaited<ReturnType<MockLanguageModelV4['doStream']>>;
type StreamPart = StreamResult['stream'] extends ReadableStream<infer P> ? P : never;
/** 模型输出的一段；pause 停一会儿再接着，gate 等它放行（请求被中止时随之失败） */
type Item = StreamPart | { pause: number } | { gate: Promise<void> };

const usage = {
  inputTokens: { total: 120, noCache: 20, cacheRead: 100, cacheWrite: undefined },
  outputTokens: { total: 30, text: 25, reasoning: 5 },
};

const finish = (reason: 'stop' | 'tool-calls'): StreamPart => ({
  type: 'finish',
  finishReason: { unified: reason, raw: undefined },
  usage,
});

function text(id: string, deltas: string[], pause = 0): Item[] {
  return [
    { type: 'text-start', id },
    ...deltas.flatMap((delta): Item[] => [
      ...(pause ? [{ pause }] : []),
      { type: 'text-delta', id, delta },
    ]),
    { type: 'text-end', id },
  ];
}

function reasoning(id: string, deltas: string[], pause = 0): Item[] {
  return [
    { type: 'reasoning-start', id },
    ...deltas.flatMap((delta): Item[] => [
      ...(pause ? [{ pause }] : []),
      { type: 'reasoning-delta', id, delta },
    ]),
    { type: 'reasoning-end', id },
  ];
}

/** 一次工具调用，与 openai-compatible 一样先流式给出参数，再给完整的调用 */
function call(toolName: string, input: unknown, id: string): Item[] {
  const json = JSON.stringify(input);
  return [
    { type: 'tool-input-start', id, toolName },
    { type: 'tool-input-delta', id, delta: json },
    { type: 'tool-input-end', id },
    { type: 'tool-call', toolCallId: id, toolName, input: json },
  ];
}

/** 依次处理每次请求：段的数组按顺序输出；Error 则请求失败 */
function scripted(...steps: Array<Item[] | Error>): MockLanguageModelV4 {
  let index = 0;
  return new MockLanguageModelV4({
    doStream: async ({ abortSignal }) => {
      const step = steps[index++];
      if (step === undefined) throw new Error('mock 模型没有更多脚本');
      if (step instanceof Error) throw step;
      const items = [...step];
      return {
        stream: new ReadableStream<StreamPart>(
          {
            async pull(controller) {
              for (let item = items.shift(); item !== undefined; item = items.shift()) {
                if ('pause' in item) await sleep(item.pause);
                else if ('gate' in item) await abortable(item.gate, abortSignal);
                else {
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

/** 模拟 HTTP 错误。retry-after-ms 为 0，SDK 重试时不等待 */
function httpError(statusCode: number): APICallError {
  return new APICallError({
    message: `HTTP ${statusCode}`,
    url: 'http://mock.test/v1/chat/completions',
    requestBodyValues: {},
    statusCode,
    responseHeaders: { 'retry-after-ms': '0' },
    responseBody: `{"error":"status ${statusCode}"}`,
  });
}

function abortable(gate: Promise<void>, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    void gate.then(resolve);
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(check: () => boolean, timeoutMs = 3000, what = '条件'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`等待${what}超时`);
    await sleep(5);
  }
}

// ─── 工具 ───────────────────────────────────────────────────────────────

/** 1×1 的 PNG */
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

const tools = installTools(
  [
    defineTool({
      name: 'look',
      description: '看一张图',
      input: z.object({ url: z.string() }),
      execute: async () => {
        await sleep(30);
        return new TextAndImages({
          text: '一张图',
          images: [{ data: png, mediaType: 'image/png' }],
        });
      },
    }),
    defineTool({
      name: 'broken',
      description: '总是出错',
      input: z.object({}),
      execute: async () => {
        throw new Error('坏了\n第二行不该出现');
      },
    }),
    defineTool({
      name: 'stuck',
      description: '一直不结束，直到被中止',
      input: z.object({}),
      execute: (_input, ctx) =>
        new Promise((_, reject) => {
          ctx.abortSignal.addEventListener('abort', () => reject(new Error('被中止')), {
            once: true,
          });
        }),
    }),
  ],
  {},
).tools;

// ─── 服务与面板 ─────────────────────────────────────────────────────────

const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** 服务的网页部分加会话管理，会话管理的回复由「此刻」旁听（与 main.ts 的接法相同） */
async function setup({
  model,
  storage = createMemoryStorage(),
  fileStore = createMemoryFileStore(),
  ...options
}: {
  model: MockLanguageModelV4;
  storage?: Storage;
  fileStore?: FileStore;
} & NonNullable<Parameters<typeof testService>[0]>) {
  const service = await testService({ storage, fileStore, ...options });
  const { logger } = recordingLogger();
  const sessions = createSessions({
    model,
    prompts: testPrompts('你是测试助手'),
    tools,
    storage: service.observed,
    fileStore,
    logger,
    maxRetries: 2,
  });
  sessions.onReply(service.live.listener);
  cleanups.push(() => sessions.close(0, 200));
  return { ...service, sessions };
}

/** 新建一个会话，记一条用户消息 */
async function conversationWith(
  { observed, sessions }: Awaited<ReturnType<typeof setup>>,
  platform = 'cli',
) {
  const id = await observed.createConversation({ platform });
  const conversation = await sessions.open(id);
  await conversation.append({ author: { name: 'Alice' }, text: '你好' });
  return { id, conversation };
}

/** 读完一次回复 */
async function readAll(stream: ReadableStream<MessageChunk>): Promise<MessageChunk[]> {
  const chunks: MessageChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

type Received = { event: string; data: unknown };

/** 连上 SSE 的面板：在后台一直读，收到的事件按顺序记下 */
async function panel(request: (path: string) => Response | Promise<Response>) {
  const response = await request('/api/events');
  const reader = response.body!.getReader();
  cleanups.push(() => reader.cancel().catch(() => {}));
  const decoder = new TextDecoder();
  const received: Received[] = [];
  let buffer = '';
  let ended = false;
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (let at = buffer.indexOf('\n\n'); at >= 0; at = buffer.indexOf('\n\n')) {
          const lines = buffer.slice(0, at).split('\n');
          buffer = buffer.slice(at + 2);
          const event = lines.find((line) => line.startsWith('event: '))?.slice(7);
          const data = lines
            .filter((line) => line.startsWith('data: '))
            .map((line) => line.slice(6))
            .join('\n');
          if (event) received.push({ event, data: JSON.parse(data) });
        }
      }
    } catch {
      // 测试结束时取消
    } finally {
      ended = true;
    }
  })();
  const live = () =>
    received.filter((item) => item.event === 'live').map((item) => item.data as LiveEvent);
  await waitUntil(() => received.length > 0, 3000, 'hello');
  return {
    received,
    hello: received[0]!.data as Hello,
    live,
    get ended() {
      return ended;
    },
    /** 等到收到满足条件的 live 事件，返回它 */
    async next(check: (event: LiveEvent) => boolean, timeoutMs = 3000): Promise<LiveEvent> {
      await waitUntil(() => live().some(check), timeoutMs, 'live 事件');
      return live().find(check)!;
    },
    /** 等到收到 seq 为 seq 的 live 事件（已收到全部事件） */
    async upTo(seq: number): Promise<void> {
      await waitUntil(
        () => (live().at(-1)?.seq ?? (received[0]!.data as Hello).live.seq) >= seq,
        3000,
        `第 ${seq} 个 live 事件`,
      );
    },
    statuses: () =>
      received.filter((item) => item.event === 'status').map((item) => item.data as ServiceStatus),
  };
}

/**
 * 面板该做的：从 hello 的现场出发，依次应用 live 事件。序号必须一个接一个（不丢不重），
 * 否则抛错。返回重建出的现场
 */
function rebuild(snapshot: LiveSnapshot, events: LiveEvent[]): LiveSnapshot {
  const replies = new Map(
    structuredClone(snapshot.replies).map((reply) => [reply.conversationId, reply]),
  );
  let seq = snapshot.seq;
  for (const event of events) {
    if (event.seq !== seq + 1) throw new Error(`序号不连续：${seq} 之后是 ${event.seq}`);
    seq = event.seq;
    const id = event.conversationId;
    let reply = replies.get(id);
    switch (event.type) {
      case 'cancel':
      case 'end':
        replies.delete(id);
        continue;
      case 'wait':
        reply = {
          conversationId: id,
          state: event.state,
          waitingSince: event.at,
          again: false,
          parts: [],
        };
        replies.set(id, reply);
        break;
      case 'again':
        if (reply) reply.again = true;
        else {
          reply = { conversationId: id, state: event.state, again: true, parts: [] };
          replies.set(id, reply);
        }
        break;
      case 'start': {
        const waiting = reply?.startedAt === undefined ? reply?.waitingSince : undefined;
        reply = {
          conversationId: id,
          ...(event.replyId ? { replyId: event.replyId } : {}),
          state: event.state,
          ...(waiting ? { waitingSince: waiting } : {}),
          startedAt: event.at,
          again: waiting !== undefined && reply!.again,
          parts: [],
        };
        replies.set(id, reply);
        break;
      }
      case 'reasoning-start':
        reply!.parts[event.part] = {
          type: 'reasoning',
          step: event.step,
          text: '',
          startedAt: event.at,
        };
        break;
      case 'reasoning-delta':
        (reply!.parts[event.part] as LiveReasoning).text += event.text;
        break;
      case 'reasoning-end':
        (reply!.parts[event.part] as LiveReasoning).endedAt = event.at;
        break;
      case 'text-delta': {
        reply!.parts[event.part] ??= { type: 'text', step: event.step, text: '' };
        (reply!.parts[event.part] as LiveText).text += event.text;
        break;
      }
      case 'tool-start':
        reply!.parts[event.part] = {
          type: 'tool',
          step: event.step,
          callId: event.callId,
          name: event.name,
          input: event.input,
          startedAt: event.at,
        };
        break;
      case 'tool-end':
        Object.assign(reply!.parts[event.part]!, {
          endedAt: event.at,
          ok: event.ok,
          ...(event.error !== undefined ? { error: event.error } : {}),
          ...(event.images ? { images: event.images } : {}),
        });
        break;
      case 'retry':
        reply!.retry = event.retry;
        break;
      case 'reset':
        reply!.parts.splice(event.keep);
        break;
    }
    reply!.state = event.state;
    if (event.toolName) reply!.toolName = event.toolName;
    else delete reply!.toolName;
  }
  return { seq, replies: [...replies.values()] };
}

const byConversation = (snapshot: LiveSnapshot) =>
  [...snapshot.replies].sort((a, b) => a.conversationId.localeCompare(b.conversationId));

/** 一段一段地列出类型，连续同类型的逐字片段合成一项 */
function outline(events: LiveEvent[]): string[] {
  const types: string[] = [];
  for (const event of events) {
    const type =
      event.type === 'tool-start' || event.type === 'tool-end'
        ? `${event.type}:${event.callId}`
        : event.type;
    if (type.endsWith('-delta') && types.at(-1) === type) continue;
    types.push(type);
  }
  return types;
}

function textOf(events: LiveEvent[], part: number): string {
  return events
    .flatMap((event) => (event.type === 'text-delta' && event.part === part ? [event.text] : []))
    .join('');
}

function partsText(reply: LiveReply | undefined, type: 'text' | 'reasoning'): string[] {
  return (reply?.parts ?? []).flatMap((part) => (part.type === type ? [part.text] : []));
}

// ─── 测试 ───────────────────────────────────────────────────────────────

describe('「此刻」：回复的实时事件', () => {
  it('一次回复：思考、文字、成功与出错的工具调用依次到达，时间与内容都对，逐字片段合并后拼起来与原文相同', async () => {
    const thought = ['想', '一', '想'];
    const before = [...'我去查一下'];
    const after = [...'查到了，是一张 1×1 的图。'];
    const model = scripted(
      [
        ...reasoning('r', thought),
        ...text('t1', before),
        ...call('look', { url: 'https://example.com/a.png' }, 'c1'),
        ...call('broken', {}, 'c2'),
        finish('tool-calls'),
      ],
      [...text('t2', after), finish('stop')],
    );
    const service = await setup({ model });
    const watcher = await panel(service.request);
    const { id, conversation } = await conversationWith(service);

    await readAll(conversation.reply());
    const end = await watcher.next((event) => event.type === 'end');
    const events = watcher.live();
    const stored = (await conversation.messages()).at(-1)!;

    expect(outline(events)).toEqual([
      'start',
      'reasoning-start',
      'reasoning-delta',
      'reasoning-end',
      'text-delta',
      'tool-start:c1',
      'tool-start:c2',
      'tool-end:c2',
      'tool-end:c1',
      'text-delta',
      'end',
    ]);
    // 序号从 1 起一个接一个；都属于这个会话、这次回复（回复 id 就是写进历史的那条）
    expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1));
    expect(events.every((event) => event.conversationId === id)).toBe(true);
    expect(events.every((event) => event.replyId === stored.id)).toBe(true);

    const find = <T extends LiveEvent['type']>(
      type: T,
      check: (e: LiveEvent) => boolean = () => true,
    ) =>
      events.find((event) => event.type === type && check(event)) as Extract<
        LiveEvent,
        { type: T }
      >;
    const start = find('start');
    expect(start.state).toBe('thinking');

    // 思考：开始、内容、结束（结束带开始时间）
    const thinking = find('reasoning-start');
    expect(thinking).toMatchObject({ part: 0, step: 1, state: 'thinking' });
    expect(events.flatMap((e) => (e.type === 'reasoning-delta' ? [e.text] : [])).join('')).toBe(
      thought.join(''),
    );
    const thought_end = find('reasoning-end');
    expect(thought_end.startedAt).toBe(thinking.at);
    expect(Date.parse(thought_end.at)).toBeGreaterThanOrEqual(Date.parse(thinking.at));

    // 文字：两步各一段，拼起来与原文相同；逐字片段被合并了
    expect(textOf(events, 1)).toBe(before.join(''));
    expect(textOf(events, 4)).toBe(after.join(''));
    expect(find('text-delta', (e) => e.type === 'text-delta' && e.part === 4)).toMatchObject({
      step: 2,
      state: 'replying',
    });
    const deltas = events.filter((event) => event.type === 'text-delta').length;
    expect(deltas).toBeLessThan(before.length + after.length);

    // 工具：开始带名字、参数的前一截、开始时间；结束带结果（成功的图片、出错的一句话）与耗时
    const look = find('tool-start', (e) => e.type === 'tool-start' && e.callId === 'c1');
    expect(look).toMatchObject({
      part: 2,
      step: 1,
      name: 'look',
      input: '{"url":"https://example.com/a.png"}',
      state: 'tool',
      toolName: 'look',
    });
    const lookEnd = find('tool-end', (e) => e.type === 'tool-end' && e.callId === 'c1');
    const [image] = (
      stored.parts.find((part) => part.type === 'tool-look') as {
        output: { parts: Array<{ type: string; url?: string }> };
      }
    ).output.parts.filter((part) => part.type === 'image');
    expect(lookEnd).toMatchObject({
      part: 2,
      ok: true,
      startedAt: look.at,
      images: [
        { src: `/api/files/${image!.url!.slice('luoli-file:'.length)}`, width: 1, height: 1 },
      ],
      state: 'thinking',
    });
    expect(Date.parse(lookEnd.at) - Date.parse(look.at)).toBeGreaterThanOrEqual(25);
    const broken = find('tool-end', (e) => e.type === 'tool-end' && e.callId === 'c2');
    const errorText = (
      stored.parts.find((part) => part.type === 'tool-broken') as {
        errorText: string;
      }
    ).errorText;
    expect(broken).toMatchObject({ part: 3, ok: false, error: errorText.split('\n')[0] });
    expect(broken.error).not.toContain('第二行');
    // c2 结束时 c1 还在跑：仍是调用工具，显示还在跑的那个
    expect(broken).toMatchObject({ state: 'tool', toolName: 'look' });

    // 结束：用时、用量与写进历史的相同；上次回复就是这一次
    expect(end).toMatchObject({
      type: 'end',
      outcome: 'completed',
      startedAt: start.at,
      usage: stored.metadata!.usage,
      lastReply: { conversationId: id, at: end.at },
    });
    expect(end.type === 'end' && end.usage?.cacheRead).toBe(200);

    // 结束后现场里没有了；新连上的面板拿到的上次回复也是这一次
    expect(service.live.snapshot().replies).toEqual([]);
    const late = await panel(service.request);
    expect(late.hello.live).toEqual({ seq: events.length, replies: [] });
    expect(late.hello.lastReply).toEqual({ conversationId: id, at: end.at });
    // 从空的现场重建：与收到的事件一致
    expect(rebuild({ seq: 0, replies: [] }, events)).toEqual({ seq: events.length, replies: [] });
  });

  it('逐字片段约 50 毫秒合并一次：一个字一个事件的不会有，拼起来与原文相同', async () => {
    const chars = [...'一二三四五六七八九十'.repeat(4)];
    const model = scripted([...text('t', chars, 8), finish('stop')]);
    const service = await setup({ model });
    const watcher = await panel(service.request);
    const { conversation } = await conversationWith(service);

    const startedAt = Date.now();
    await readAll(conversation.reply());
    const elapsed = Date.now() - startedAt;
    await watcher.next((event) => event.type === 'end');
    const deltas = watcher.live().filter((event) => event.type === 'text-delta');

    expect(deltas.map((event) => event.type === 'text-delta' && event.text).join('')).toBe(
      chars.join(''),
    );
    // 40 个字、每隔约 8 毫秒一个：合并后大约每 50 毫秒一个事件
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.length).toBeLessThanOrEqual(Math.ceil(elapsed / 40) + 2);
    expect(deltas.length).toBeLessThan(chars.length / 2);
  });

  it('重试与重新生成：推出重试；reset 之后作废的那一步不在现场里，重连拿到的也没有', async () => {
    const regenerate = gate();
    const model = scripted(
      httpError(429),
      [
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: '作废' },
        { type: 'text-delta', id: 't', delta: '的半截' },
        { type: 'error', error: { message: '服务端过载' } },
      ],
      // 重新生成的那次：SDK 在它的第一段出来时才放出重试提示与 reset-step，之后停住
      [
        { type: 'text-start', id: 't' },
        { gate: regenerate.promise },
        { type: 'text-delta', id: 't', delta: '完整' },
        { type: 'text-delta', id: 't', delta: '回复' },
        { type: 'text-end', id: 't' },
        finish('stop'),
      ],
    );
    const service = await setup({ model });
    const watcher = await panel(service.request);
    const { id, conversation } = await conversationWith(service);

    const done = readAll(conversation.reply());
    const reset = await watcher.next((event) => event.type === 'reset');
    const retries = watcher.live().filter((event) => event.type === 'retry');
    expect(retries.map((event) => event.type === 'retry' && event.retry)).toEqual([
      { phase: 'request', attempt: 1, maxRetries: 2, statusCode: 429, at: retries[0]!.at },
      { phase: 'stream', attempt: 1, maxRetries: 2, at: retries[1]!.at },
    ]);
    expect(retries[0]).toMatchObject({ state: 'retry' });
    expect(reset).toMatchObject({ step: 1, keep: 0, state: 'thinking' });
    expect(outline(watcher.live())).toEqual(['start', 'retry', 'text-delta', 'retry', 'reset']);

    // 正在重新生成：现场里没有作废的文字，最近一次重试是流中途的那次
    const [reply] = service.live.snapshot().replies;
    expect(reply).toMatchObject({ conversationId: id, parts: [], state: 'thinking' });
    expect(reply!.retry).toMatchObject({ phase: 'stream', attempt: 1 });
    const late = await panel(service.request);
    expect(late.hello.live).toEqual(service.live.snapshot());

    regenerate.open();
    await done;
    await watcher.next((event) => event.type === 'end');
    await late.next((event) => event.type === 'end');
    // 收尾前的那一刻：两个面板重建出来的都只有重新生成的文字
    for (const [seen, from] of [
      [watcher.live(), { seq: 0, replies: [] } as LiveSnapshot],
      [late.live(), late.hello.live],
    ] as const) {
      const beforeEnd = rebuild(from, seen.slice(0, -1));
      expect(partsText(beforeEnd.replies[0], 'text')).toEqual(['完整回复']);
    }
  });

  it('出错：end 带错误的一句话与状态码，没有用量；现场里去掉，上次回复不变', async () => {
    const model = scripted(httpError(401));
    const service = await setup({ model });
    const watcher = await panel(service.request);
    const { id, conversation } = await conversationWith(service);

    await readAll(conversation.reply());
    const end = await watcher.next((event) => event.type === 'end');

    expect(outline(watcher.live())).toEqual(['start', 'end']);
    expect(end).toEqual({
      type: 'end',
      seq: 2,
      conversationId: id,
      replyId: watcher.live()[0]!.replyId,
      at: end.at,
      outcome: 'failed',
      startedAt: watcher.live()[0]!.at,
      error: '请求失败（401）',
      statusCode: 401,
    });
    expect(service.live.snapshot()).toEqual({ seq: 2, replies: [] });
    expect(service.live.lastReply).toBeUndefined();
  });

  it('重试用尽：经 SDK 包了一层的错误也认出状态码；重试事件各推一次', async () => {
    const model = scripted(httpError(503), httpError(503), httpError(503));
    const service = await setup({ model });
    const watcher = await panel(service.request);
    const { conversation } = await conversationWith(service);

    const chunks = await readAll(conversation.reply());
    const end = await watcher.next((event) => event.type === 'end');

    // 核心给的原文是 SDK 的重试错误
    expect(chunks.find((chunk) => chunk.type === 'error')).toMatchObject({
      errorText: 'Failed after 3 attempts. Last error: AI_APICallError: HTTP 503',
    });
    expect(outline(watcher.live())).toEqual(['start', 'retry', 'retry', 'end']);
    expect(end).toMatchObject({ outcome: 'failed', error: '请求失败（503）', statusCode: 503 });
  });

  it('中止：end 为 aborted；还开着的思考与工具调用先各自收尾；现场里去掉', async () => {
    const model = scripted([
      ...reasoning('r', ['想']),
      ...text('t', ['先说一句']),
      ...call('stuck', {}, 'c1'),
      finish('tool-calls'),
    ]);
    const service = await setup({ model });
    const watcher = await panel(service.request);
    const { conversation } = await conversationWith(service);

    const controller = new AbortController();
    const done = readAll(conversation.reply({ abortSignal: controller.signal }));
    await watcher.next((event) => event.type === 'tool-start');
    controller.abort();
    await done;
    const end = await watcher.next((event) => event.type === 'end');

    expect(end).toMatchObject({ outcome: 'aborted' });
    expect(end.type === 'end' && end.usage).toBeUndefined();
    const toolEnd = watcher.live().find((event) => event.type === 'tool-end');
    expect(toolEnd).toMatchObject({ callId: 'c1', ok: false });
    expect(watcher.live().indexOf(toolEnd!)).toBeLessThan(watcher.live().indexOf(end));
    expect(service.live.snapshot().replies).toEqual([]);
  });

  it('前端不读了、取消回复：也算中止，现场里去掉', async () => {
    const hold = gate();
    const model = scripted([
      ...text('t', ['一半']),
      { gate: hold.promise },
      ...text('u', ['另一半']),
      finish('stop'),
    ]);
    const service = await setup({ model });
    const watcher = await panel(service.request);
    const { conversation } = await conversationWith(service);

    const reader = conversation.reply().getReader();
    for (let read = await reader.read(); !read.done; read = await reader.read()) {
      if (read.value.type === 'text-end') break;
    }
    await reader.cancel();
    const end = await watcher.next((event) => event.type === 'end');

    expect(end).toMatchObject({ outcome: 'aborted' });
    expect(service.live.snapshot().replies).toEqual([]);
    hold.open();
  });

  it('回复进行到一半时连上：先拿到现场，再接着收；拼起来与完整的流一致，不丢不重', async () => {
    const thought = [...'先想一想这个问题该怎么回答'];
    const first = [...'这是第一段话，'.repeat(6)];
    const second = [...'这是查完之后的第二段话。'.repeat(6)];
    const pause = gate();
    const model = scripted(
      [
        ...reasoning('r', thought, 4),
        ...text('t1', first, 4),
        ...call('look', { url: 'https://example.com/b.png' }, 'c1'),
        finish('tool-calls'),
      ],
      [
        ...text('t2', second.slice(0, 20), 4),
        { gate: pause.promise },
        ...text('t3', second.slice(20), 4),
        finish('stop'),
      ],
    );
    const service = await setup({ model });
    const early = await panel(service.request);
    const { id, conversation } = await conversationWith(service);

    const done = readAll(conversation.reply());
    // 回复进行期间每隔一会儿连上一个面板：有的正好在攒逐字片段时连上
    const panels: Array<Awaited<ReturnType<typeof panel>>> = [];
    const joining = (async () => {
      while (panels.length < 12) {
        await sleep(23);
        panels.push(await panel(service.request));
      }
    })();
    await joining;
    // 停在第二步中间：现场就是迄今推出的全部事件的结果，面板重建出的与它相同
    await waitUntil(
      () => service.live.snapshot().replies[0]?.parts.length === 4,
      5000,
      '停在第二步',
    );
    const paused = service.live.snapshot();
    for (const watcher of [early, ...panels]) {
      await watcher.upTo(paused.seq);
      expect(byConversation(rebuild(watcher.hello.live, watcher.live()))).toEqual(
        byConversation(paused),
      );
    }
    const middle = await panel(service.request);
    expect(middle.hello.live).toEqual(paused);
    expect(panels.some((watcher) => watcher.hello.live.replies.length > 0)).toBe(true);

    pause.open();
    await done;
    for (const watcher of [early, middle, ...panels]) {
      await watcher.next((event) => event.type === 'end');
      // 结束前的那一刻：文字、思考与模型输出的完全相同
      const seen = watcher.live();
      const last = rebuild(watcher.hello.live, seen.slice(0, -1)).replies.find(
        (reply) => reply.conversationId === id,
      );
      expect(partsText(last, 'reasoning')).toEqual([thought.join('')]);
      expect(partsText(last, 'text')).toEqual([
        first.join(''),
        second.slice(0, 20).join(''),
        second.slice(20).join(''),
      ]);
      expect(last!.parts.filter((part): part is LiveTool => part.type === 'tool')).toEqual([
        expect.objectContaining({ callId: 'c1', ok: true }),
      ]);
      // 收到的第一个 live 事件正好接着 hello 的现场
      expect(seen[0]!.seq).toBe(watcher.hello.live.seq + 1);
    }
  });

  /** 只有会话管理与「此刻」（broadcast 由测试给），不装网页服务 */
  async function bare(model: MockLanguageModelV4, broadcast: (event: LiveEvent) => void) {
    const storage = createMemoryStorage();
    const { logger, entries } = recordingLogger();
    const live = createLive({ broadcast, logger });
    const sessions = createSessions({
      model,
      prompts: testPrompts('你是测试助手'),
      storage,
      fileStore: createMemoryFileStore(),
      logger,
    });
    sessions.onReply(live.listener);
    cleanups.push(() => sessions.close(0, 200));
    const id = await storage.createConversation({ platform: 'cli' });
    const conversation = await sessions.open(id);
    await conversation.append({ author: { name: 'Alice' }, text: '你好' });
    return { live, sessions, conversation, entries };
  }

  it('旁听出错不影响回复：推事件总是出错（含合并计时器到点时），回复照常写入历史，现场里不留，日志只记一次', async () => {
    // 片段之间隔 80 毫秒，超过合并的 50 毫秒：逐字片段由计时器到点推出（计时器里出错不能让进程退出）
    const { live, sessions, conversation, entries } = await bare(
      scripted([
        ...reasoning('r', ['想', '一想'], 80),
        ...text('t', ['照', '常'], 80),
        finish('stop'),
      ]),
      () => {
        throw new Error('推不出去');
      },
    );

    const chunks = await readAll(conversation.reply());
    // 再等过一个合并窗口：计时器都到点过了
    await sleep(120);

    expect(chunks.some((chunk) => chunk.type === 'finish')).toBe(true);
    const messages: Message[] = await conversation.messages();
    expect(messages.at(-1)?.parts.find((part) => part.type === 'text')).toMatchObject({
      text: '照常',
    });
    expect(sessions.replying).toBe(0);
    expect(live.snapshot().replies).toEqual([]);
    expect(entries.filter((entry) => entry.msg === 'live.failed')).toHaveLength(1);
    expect(entries.filter((entry) => entry.msg === 'sessions.listener_failed')).toEqual([]);
  });

  it('结束时收尾推事件出错：这一条照样从现场里去掉，end 照样推出', async () => {
    const hold = gate();
    const sent: LiveEvent[] = [];
    let failures = 0;
    // 只在推 reasoning-end（中止时给还在想的那段收尾）时出错一次
    const { live, conversation, entries } = await bare(
      scripted([
        { type: 'reasoning-start', id: 'r' },
        { type: 'reasoning-delta', id: 'r', delta: '想' },
        { gate: hold.promise },
        finish('stop'),
      ]),
      (event) => {
        if (event.type === 'reasoning-end' && failures++ === 0) throw new Error('推不出去');
        sent.push(event);
      },
    );

    const controller = new AbortController();
    const done = readAll(conversation.reply({ abortSignal: controller.signal }));
    await waitUntil(() => sent.some((event) => event.type === 'reasoning-delta'));
    expect(live.snapshot().replies).toEqual([expect.objectContaining({ state: 'thinking' })]);
    controller.abort();
    await done;

    expect(failures).toBe(1);
    expect(live.snapshot().replies).toEqual([]);
    expect(sent.at(-1)).toMatchObject({ type: 'end', outcome: 'aborted' });
    expect(entries.filter((entry) => entry.msg === 'live.failed')).toHaveLength(1);
    hold.open();
  });
});

describe('服务的状态', () => {
  it('没启动 Telegram 时：hello 里 Telegram 没启动、没连上，助手名默认，唤醒词为空，没有用户名与上次回复', async () => {
    const service = await testService();
    const watcher = await panel(service.request);

    expect(watcher.hello).toEqual({
      startedAt: '2026-11-08T00:00:00.000Z',
      uptimeSeconds: watcher.hello.uptimeSeconds,
      telegram: { enabled: false, connected: false },
      assistant: { name: '洛璃', wakeWords: [] },
      live: { seq: 0, replies: [] },
    });
    const health = (await (await service.request('/api/health')).json()) as ServiceStatus;
    expect(health).toEqual({
      ...watcher.hello,
      uptimeSeconds: health.uptimeSeconds,
      live: undefined,
    });
  });

  it('助手名取配置（LUOLI_NAME）', async () => {
    const service = await testService({ name: 'Nori', telegram: { wakeWords: ['nori', '小璃'] } });
    const watcher = await panel(service.request);

    expect(watcher.hello.assistant).toEqual({ name: 'Nori', wakeWords: ['nori', '小璃'] });
    expect(watcher.hello.telegram).toEqual({ enabled: true, connected: false });
  });

  it('上次回复：启动时取自数据库；回复正常完成后更新，出错的不算', async () => {
    const storage = createMemoryStorage();
    const old = await storage.createConversation({ platform: 'telegram', title: '读书会' });
    await (
      await storage.openConversation(old)
    ).recordCall({
      purpose: 'reply',
      replyId: 'r-old',
      model: 'test-model',
      startedAt: '2026-11-07T10:00:00.000Z',
      durationMs: 2500,
      attempts: 1,
      outcome: 'completed',
    });
    const model = scripted([...text('t', ['好']), finish('stop')], httpError(401));
    const service = await setup({ model, storage });

    const first = await panel(service.request);
    expect(first.hello.lastReply).toEqual({ conversationId: old, at: '2026-11-07T10:00:02.500Z' });

    const { id, conversation } = await conversationWith(service);
    await readAll(conversation.reply());
    const end = await first.next((event) => event.type === 'end');
    const latest = { conversationId: id, at: end.at };
    expect(end.type === 'end' && end.lastReply).toEqual(latest);

    await conversation.append({ author: { name: 'Alice' }, text: '再来' });
    await readAll(conversation.reply());
    const failed = await first.next((event) => event.type === 'end' && event.outcome === 'failed');
    expect(failed.type === 'end' && failed.lastReply).toEqual(latest);

    const second = await panel(service.request);
    expect(second.hello.lastReply).toEqual(latest);
    expect(
      ((await (await service.request('/api/health')).json()) as ServiceStatus).lastReply,
    ).toEqual(latest);
  });
});

describe('Telegram：等待合并、再次触发与连接状态', () => {
  const token = '123456:TEST-token_abc';
  const group: TelegramChat = { id: -1001, type: 'supergroup', title: '读书会' };
  const alice: TelegramUser = { id: 11, is_bot: false, first_name: 'Alice' };

  async function startBot(
    model: MockLanguageModelV4,
    wait = { idleMs: 150, maxMs: 1000 },
    pollTimeoutSeconds = 1,
  ) {
    const api = await startFakeTelegram();
    cleanups.push(() => api.close());
    const service = await setup({ model, telegram: { wakeWords: ['nori'] } });
    const watcher = await panel(service.request);
    const { logger } = recordingLogger();
    const telegram = await startTelegramFrontend({
      config: {
        token,
        apiUrl: api.url,
        chats: new Set([String(group.id)]),
        users: new Set<string>(),
        wakeWords: ['nori'],
        errorText: '（出了点问题）',
        staleMs: 60 * 60_000,
      },
      sessions: service.sessions,
      storage: service.observed,
      logger,
      live: service.live,
      status: service.status,
      events: service.events,
      pollTimeoutSeconds,
      wait,
    });
    let stopped = false;
    const stop = async () => {
      if (stopped) return;
      stopped = true;
      await telegram.stop();
    };
    cleanups.push(stop);
    return { api, service, watcher, telegram, stop };
  }

  it('被触发：先推 wait，现场里是等待合并；回复开始接着用这条现场', async () => {
    const { api, service, watcher } = await startBot(
      scripted([...text('t', ['在的']), finish('stop')]),
    );

    api.push({ chat: group, from: alice, text: 'nori 在吗' });
    const wait = await watcher.next((event) => event.type === 'wait');
    expect(wait).toMatchObject({ state: 'waiting' });
    expect(wait.replyId).toBeUndefined();
    const waiting = await panel(service.request);
    expect(waiting.hello.live.replies).toEqual([
      {
        conversationId: wait.conversationId,
        state: 'waiting',
        waitingSince: wait.at,
        again: false,
        parts: [],
      },
    ]);

    const start = await watcher.next((event) => event.type === 'start');
    await watcher.next((event) => event.type === 'end');
    expect(start.conversationId).toBe(wait.conversationId);
    for (const seen of [watcher, waiting]) {
      const beforeEnd = rebuild(seen.hello.live, seen.live().slice(0, -1));
      expect(beforeEnd.replies).toEqual([
        expect.objectContaining({ waitingSince: wait.at, startedAt: start.at, again: false }),
      ]);
    }
  });

  it('回复中又被触发：推 again，现场里记着；这次结束后的下一次回复不再带着它', async () => {
    const hold = gate();
    const { api, service, watcher } = await startBot(
      scripted(
        [...text('t', ['第一']), { gate: hold.promise }, finish('stop')],
        [...text('t', ['第二']), finish('stop')],
      ),
    );

    api.push({ chat: group, from: alice, text: 'nori 在吗' });
    await watcher.next((event) => event.type === 'text-delta');
    api.push({ chat: group, from: alice, text: 'nori 还有一件事' });
    const again = await watcher.next((event) => event.type === 'again');
    expect(again).toMatchObject({ state: 'replying' });
    expect(service.live.snapshot().replies).toEqual([
      expect.objectContaining({ conversationId: again.conversationId, again: true }),
    ]);

    hold.open();
    await waitUntil(() => watcher.live().filter((event) => event.type === 'end').length === 2);
    const starts = watcher.live().filter((event) => event.type === 'start');
    expect(starts).toHaveLength(2);
    const seen = watcher.live();
    const second = rebuild({ seq: 0, replies: [] }, seen.slice(0, -1)).replies[0];
    expect(second).toMatchObject({ replyId: starts[1]!.replyId, again: false });
    expect(service.live.snapshot().replies).toEqual([]);
  });

  it('等待被放弃（退出时还在等）：推 cancel，现场里去掉', async () => {
    const { api, service, watcher, stop } = await startBot(
      scripted([...text('t', ['不该用到']), finish('stop')]),
      { idleMs: 5000, maxMs: 8000 },
    );

    api.push({ chat: group, from: alice, text: 'nori 在吗' });
    const wait = await watcher.next((event) => event.type === 'wait');
    await stop();
    const cancel = await watcher.next((event) => event.type === 'cancel');

    expect(cancel).toEqual({
      type: 'cancel',
      seq: wait.seq + 1,
      conversationId: wait.conversationId,
      at: cancel.at,
    });
    expect(service.live.snapshot().replies).toEqual([]);
    expect(outline(watcher.live())).toEqual(['wait', 'cancel']);
  });

  it('连接状态：启动后推一次带用户名的状态；断开、恢复时各推一次，离线时带上次在线的时间', async () => {
    const { api, watcher } = await startBot(scripted());

    await waitUntil(() => watcher.statuses().some((status) => status.telegram.connected));
    const online = watcher.statuses().find((status) => status.telegram.connected)!;
    expect(online.assistant).toEqual({
      name: '洛璃',
      wakeWords: ['nori'],
      username: 'nori_test_bot',
    });
    expect(online.telegram.lastOnlineAt).toBeDefined();
    const count = watcher.statuses().length;

    api.failPolls(true);
    await waitUntil(
      () => watcher.statuses().length > count && !watcher.statuses().at(-1)!.telegram.connected,
    );
    const offline = watcher.statuses().at(-1)!;
    expect(offline.telegram).toEqual({
      enabled: true,
      connected: false,
      lastOnlineAt: offline.telegram.lastOnlineAt,
    });
    expect(Date.parse(offline.telegram.lastOnlineAt!)).toBeLessThanOrEqual(Date.now());

    api.failPolls(false);
    await waitUntil(() => watcher.statuses().at(-1)!.telegram.connected, 5000);
    expect(watcher.statuses().at(-1)!.assistant.username).toBe('nori_test_bot');
  });

  it('断开后恢复：下一次拉取就变回在线（不等长轮询），之后照旧长轮询，不空转', async () => {
    // 长轮询 30 秒：恢复后要是还长轮询，要等它返回才知道连上了
    const { api, watcher } = await startBot(scripted(), undefined, 30);
    await waitUntil(() => watcher.statuses().some((status) => status.telegram.connected));
    // 连着时是长轮询
    await waitUntil(() => api.polls.some((poll) => poll.timeout === 30));

    api.failPolls(true);
    await waitUntil(() => !watcher.statuses().at(-1)!.telegram.connected);
    const mark = api.polls.length;
    const recoveredAt = Date.now();
    api.failPolls(false);

    // 失败后的第一次重试在 1 秒后（SDK 的退避）：立即返回、变回在线
    await waitUntil(() => watcher.statuses().at(-1)!.telegram.connected, 4000);
    expect(Date.now() - recoveredAt).toBeLessThan(4000);
    // 再等一会儿：恢复后只有那一次立即返回的拉取，接着是长轮询，没有空转
    await sleep(300);
    expect(api.polls.slice(mark).map((poll) => poll.timeout)).toEqual([0, 30]);
  });
});
