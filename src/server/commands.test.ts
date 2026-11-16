import { APICallError } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryStorage, type Message } from '../core/index.js';
import { testService } from './test-kit.js';
import type {
  ApiMessage,
  ChatChunk,
  CommandEvent,
  CommandKind,
  ErrorResponse,
  MessagesResponse,
} from './types.js';

// 指令的接口（POST /api/conversations/:id/compact、/clear）：app.request 加 mock 模型，不起端口

// ─── 模型 ───────────────────────────────────────────────────────────────

type StreamResult = Awaited<ReturnType<MockLanguageModelV4['doStream']>>;
type StreamPart = StreamResult['stream'] extends ReadableStream<infer P> ? P : never;
/** 模型输出的一段；gate 等它放行（请求被中止时随之失败） */
type Item = StreamPart | { gate: Promise<void> };

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 2, text: 2, reasoning: undefined },
};
const finish = (): StreamPart => ({
  type: 'finish',
  finishReason: { unified: 'stop', raw: undefined },
  usage,
});
const text = (...deltas: string[]): Item[] => [
  { type: 'text-start', id: 't' },
  ...deltas.map((delta): Item => ({ type: 'text-delta', id: 't', delta })),
  { type: 'text-end', id: 't' },
];
const answer = (...deltas: string[]): Item[] => [...text(...deltas), finish()];
/** 等 hold 放行之后才回答 */
const held = (hold: { promise: Promise<void> }, ...deltas: string[]): Item[] => [
  { gate: hold.promise },
  ...answer(...deltas),
];

/** 按顺序回应每次请求（回复与摘要都算） */
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

function httpError(statusCode: number, message: string): APICallError {
  return new APICallError({
    message,
    url: 'http://mock.test/v1/chat/completions',
    requestBodyValues: {},
    statusCode,
    responseHeaders: { 'retry-after-ms': '0' },
    responseBody: '{}',
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(check: () => boolean, timeoutMs = 3000, what = '条件'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`等待${what}超时`);
    await sleep(5);
  }
}

/** 第 index 次模型请求里所有消息（含 system）的内容 */
const promptOf = (model: MockLanguageModelV4, index: number) =>
  JSON.stringify(model.doStreamCalls[index]?.prompt ?? []);

const textOf = (message: Message | undefined) =>
  (message?.parts ?? []).flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('');

// ─── 服务 ───────────────────────────────────────────────────────────────

const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(
  model: MockLanguageModelV4,
  options: Omit<NonNullable<Parameters<typeof testService>[0]>, 'model'> = {},
) {
  const service = await testService({ model, ...options });
  cleanups.push(() => service.sessions!.close(0, 300));
  const post = (path: string, body: unknown, init: RequestInit = {}) =>
    service.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...init,
    });
  /** 发一条消息（CLI 会话，发言人 Bob），回复的流在后台一直读 */
  async function chat(body: Record<string, unknown>) {
    const response = await post('/api/chat', { platform: 'cli', author: 'Bob', ...body });
    expect(response.status).toBe(200);
    return { response, id: response.headers.get('x-conversation-id')!, ...chatStream(response) };
  }
  /** 发一条指令；事件在后台一直读，order 给了时把「label:事件」按先后记进去 */
  async function command(
    id: string,
    kind: CommandKind,
    {
      author = 'Carol',
      init = {},
      order,
      label = kind,
    }: { author?: string; init?: RequestInit; order?: string[]; label?: string } = {},
  ) {
    const response = await post(`/api/conversations/${id}/${kind}`, { author }, init);
    return { response, ...eventStream(response, order, label) };
  }
  async function history(conversationId: string): Promise<ApiMessage[]> {
    const response = await service.request(`/api/conversations/${conversationId}/messages`);
    return ((await response.json()) as MessagesResponse).messages;
  }
  /** 各段的起点、原因、执行人 */
  async function segments(conversationId: string) {
    const store = await service.storage.openConversation(conversationId);
    return (await store.segments()).map((segment) => [
      segment.startSeq,
      segment.startReason,
      segment.startedBy?.name,
    ]);
  }
  async function calls(conversationId: string) {
    const store = await service.storage.openConversation(conversationId);
    return (await store.calls()).map((call) => [call.purpose, call.summaryReason, call.outcome]);
  }
  return { ...service, post, chat, command, history, segments, calls };
}

/** 一个回复的流：后台一直读 */
function chatStream(response: Response) {
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
    get ended() {
      return ended;
    },
    async until(check: (chunks: ChatChunk[]) => boolean) {
      await waitUntil(() => check(chunks), 3000, '回复的段');
    },
    async end() {
      await waitUntil(() => ended, 3000, '回复的流结束');
    },
  };
}

/** 指令的事件流：后台一直读，事件按顺序记下 */
function eventStream(response: Response, order: string[] | undefined, label: string) {
  const events: CommandEvent[] = [];
  let raw = '';
  let ended = false;
  const reader = response.body?.getReader();
  if (reader) {
    cleanups.push(() => reader.cancel().catch(() => {}));
    const decoder = new TextDecoder();
    let buffer = '';
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const piece = decoder.decode(value, { stream: true });
          raw += piece;
          buffer += piece;
          for (let at = buffer.indexOf('\n\n'); at >= 0; at = buffer.indexOf('\n\n')) {
            const line = buffer.slice(0, at);
            buffer = buffer.slice(at + 2);
            const data = line.startsWith('data: ') ? line.slice(6) : '';
            if (!data || data === '[DONE]') continue;
            const event = JSON.parse(data) as CommandEvent;
            events.push(event);
            order?.push(`${label}:${event.type}`);
          }
        }
      } catch {
        // 取消
      } finally {
        ended = true;
      }
    })();
  }
  return {
    reader,
    events,
    /** 收到的原文（含心跳） */
    raw: () => raw,
    types: () => events.map((event) => event.type),
    async until(check: (events: CommandEvent[]) => boolean) {
      await waitUntil(() => check(events), 3000, '指令的事件');
    },
    async end() {
      await waitUntil(() => ended, 3000, '指令的流结束');
    },
  };
}

// ─── 测试 ───────────────────────────────────────────────────────────────

describe('会话空着时马上执行', () => {
  it('清空：事件是开始、已清空，没有等待；多一段清空的段，执行人是请求带的名字；流以 [DONE] 结束；记一行 command.end', async () => {
    const model = scripted(answer('好'));
    const { chat, command, segments, chats, entries } = await setup(model);
    const sent = await chat({ text: '第一句' });
    await sent.end();

    const cleared = await command(sent.id, 'clear', { author: '  Carol ' });
    await cleared.end();

    expect(cleared.response.status).toBe(200);
    expect(cleared.response.headers.get('content-type')).toBe('text/event-stream');
    expect(cleared.events).toEqual([{ type: 'start' }, { type: 'result', result: 'cleared' }]);
    expect(cleared.raw().endsWith('data: [DONE]\n\n')).toBe(true);
    expect(await segments(sent.id)).toEqual([
      [1, 'first', undefined],
      [3, 'clear', 'Carol'],
    ]);
    expect(chats!.busy(sent.id)).toBe(false);
    const ended = entries.filter((entry) => entry.msg === 'command.end');
    expect(ended).toHaveLength(1);
    expect(ended[0]!.fields).toEqual({
      conversationId: sent.id,
      command: 'clear',
      result: 'cleared',
      waitedMs: expect.any(Number),
      ranMs: expect.any(Number),
    });
    // 日志不记执行人的名字与正文
    expect(JSON.stringify(entries)).not.toContain('Carol');
    expect(JSON.stringify(entries)).not.toContain('第一句');
  });

  it('压缩：开始、已压缩；之后再发消息，发给模型的 system 里是新摘要，消息只有压缩之后的', async () => {
    const model = scripted(answer('好'), answer('Bob 打了招呼。'), answer('又好'));
    const { chat, command, segments, calls } = await setup(model);
    const sent = await chat({ text: '第一句' });
    await sent.end();

    const compacted = await command(sent.id, 'compact');
    await compacted.end();

    expect(compacted.events).toEqual([{ type: 'start' }, { type: 'result', result: 'compacted' }]);
    expect(await segments(sent.id)).toEqual([
      [1, 'first', undefined],
      [3, 'manual', 'Carol'],
    ]);
    const next = await chat({ conversationId: sent.id, text: '第二句' });
    await next.end();
    expect(promptOf(model, 2)).toContain('之前的对话摘要');
    expect(promptOf(model, 2)).toContain('Bob 打了招呼。');
    expect(promptOf(model, 2)).toContain('第二句');
    expect(promptOf(model, 2)).not.toContain('第一句');
    expect(await calls(sent.id)).toEqual([
      ['reply', undefined, 'completed'],
      ['summary', 'manual', 'completed'],
      ['reply', undefined, 'completed'],
    ]);
  });

  it('上下文本来就是空的：新建还没回复过的会话清空、连着清空两次是「已经是空的」，段里没有消息时压缩是「没有可压缩的内容」，都不请求模型', async () => {
    const storage = createMemoryStorage();
    const fresh = await storage.createConversation({ platform: 'cli' });
    const model = scripted(answer('好'));
    const { chat, command, segments } = await setup(model, { storage });

    const first = await command(fresh, 'clear');
    await first.end();
    const compactFresh = await command(fresh, 'compact');
    await compactFresh.end();
    expect(first.events.at(-1)).toEqual({ type: 'result', result: 'already-empty' });
    expect(compactFresh.events.at(-1)).toEqual({ type: 'result', result: 'nothing-to-compact' });
    expect(await segments(fresh)).toEqual([[1, 'first', undefined]]);

    const sent = await chat({ text: '第一句' });
    await sent.end();
    const once = await command(sent.id, 'clear');
    await once.end();
    const twice = await command(sent.id, 'clear');
    await twice.end();
    const compactCleared = await command(sent.id, 'compact');
    await compactCleared.end();

    expect(once.events.at(-1)).toEqual({ type: 'result', result: 'cleared' });
    expect(twice.events).toEqual([{ type: 'start' }, { type: 'result', result: 'already-empty' }]);
    expect(compactCleared.events.at(-1)).toEqual({
      type: 'result',
      result: 'nothing-to-compact',
    });
    expect(model.doStreamCalls).toHaveLength(1);
  });
});

describe('等会话空下来再执行', () => {
  it('会话正在回复：先收到等待；回复结束后才开始、给出结果；那次回复完整写进历史，在旧的一段里', async () => {
    const hold = gate();
    const model = scripted(held(hold, '慢慢', '回答'));
    const { chat, command, segments, history, chats } = await setup(model);
    const sent = await chat({ text: '问个问题' });

    const cleared = await command(sent.id, 'clear');
    await cleared.until((events) => events.length === 1);
    expect(cleared.types()).toEqual(['waiting']);
    await sleep(30);
    expect(cleared.types()).toEqual(['waiting']);

    hold.open();
    await cleared.end();
    await sent.end();

    expect(cleared.types()).toEqual(['waiting', 'start', 'result']);
    expect(cleared.events.at(-1)).toEqual({ type: 'result', result: 'cleared' });
    const messages = await history(sent.id);
    expect(messages.map((m) => [m.seq, m.role, textOf(m.message)])).toEqual([
      [1, 'user', '问个问题'],
      [2, 'assistant', '慢慢回答'],
    ]);
    expect(messages[1]!.message.metadata?.aborted).toBeUndefined();
    expect(await segments(sent.id)).toEqual([
      [1, 'first', undefined],
      [3, 'clear', 'Carol'],
    ]);
    expect(chats!.busy(sent.id)).toBe(false);
  });

  it('等待期间又有消息排队：补回复也结束之后才执行；补回复看得到排队的消息', async () => {
    const hold = gate();
    const followUpHold = gate();
    const model = scripted(held(hold, '一'), held(followUpHold, '二'));
    const { chat, command, segments } = await setup(model);
    const sent = await chat({ text: '第一句' });
    await sent.until(() => model.doStreamCalls.length === 1);

    const cleared = await command(sent.id, 'clear');
    await cleared.until((events) => events.length === 1);
    const queued = await chat({ conversationId: sent.id, text: '排队的一句' });
    await queued.until((chunks) => chunks.some((chunk) => chunk.type === 'data-queued'));

    hold.open();
    await sent.end();
    await queued.until(() => model.doStreamCalls.length === 2);
    await sleep(30);
    // 补回复还没结束：指令还在等
    expect(cleared.types()).toEqual(['waiting']);

    followUpHold.open();
    await queued.end();
    await cleared.end();

    expect(cleared.types()).toEqual(['waiting', 'start', 'result']);
    expect(promptOf(model, 1)).toContain('排队的一句');
    // 补回复（序号 4）在旧的一段里
    expect(await segments(sent.id)).toEqual([
      [1, 'first', undefined],
      [5, 'clear', 'Carol'],
    ]);
  });

  it('两条指令先后到（先压缩后清空）：按先后执行，清空在压缩的结果之后才开始', async () => {
    const summaryHold = gate();
    const model = scripted(answer('好'), held(summaryHold, '摘要'));
    const { chat, command, segments } = await setup(model);
    const sent = await chat({ text: '第一句' });
    await sent.end();
    const order: string[] = [];

    const compacted = await command(sent.id, 'compact', { order });
    await compacted.until((events) => events.length === 1);
    const cleared = await command(sent.id, 'clear', { order, author: 'Dave' });
    await cleared.until((events) => events.length === 1);
    await sleep(30);
    expect(order).toEqual(['compact:start', 'clear:waiting']);

    summaryHold.open();
    await compacted.end();
    await cleared.end();

    expect(order).toEqual([
      'compact:start',
      'clear:waiting',
      'compact:result',
      'clear:start',
      'clear:result',
    ]);
    expect(compacted.events.at(-1)).toEqual({ type: 'result', result: 'compacted' });
    expect(cleared.events.at(-1)).toEqual({ type: 'result', result: 'cleared' });
    // 压缩之后还没有消息：清空把那一段改成清空的段
    expect(await segments(sent.id)).toEqual([
      [1, 'first', undefined],
      [3, 'clear', 'Dave'],
    ]);
  });

  it('压缩期间发消息：消息写进历史；它的回复在压缩结束后才请求模型，system 里是新摘要、消息里有这条新消息', async () => {
    const summaryHold = gate();
    const model = scripted(answer('好'), held(summaryHold, '压缩的摘要'), answer('收到'));
    const { chat, command, history } = await setup(model);
    const sent = await chat({ text: '第一句' });
    await sent.end();
    const compacted = await command(sent.id, 'compact');
    await compacted.until(() => model.doStreamCalls.length === 2);

    const during = await chat({ conversationId: sent.id, text: '压缩期间说的话' });
    await waitUntil(() => during.chunks.length > 0);
    expect((await history(sent.id)).map((m) => textOf(m.message))).toContain('压缩期间说的话');
    await sleep(30);
    expect(model.doStreamCalls).toHaveLength(2);

    summaryHold.open();
    await compacted.end();
    await during.end();

    expect(compacted.events.at(-1)).toEqual({ type: 'result', result: 'compacted' });
    expect(model.doStreamCalls).toHaveLength(3);
    expect(promptOf(model, 2)).toContain('压缩的摘要');
    expect(promptOf(model, 2)).toContain('压缩期间说的话');
    expect(promptOf(model, 2)).not.toContain('第一句');
  });
});

describe('客户端断开', () => {
  it('等待中断开：指令不执行，段不变；会话的状态随后清掉', async () => {
    const hold = gate();
    const model = scripted(held(hold, '好'));
    const { chat, command, segments, chats, entries } = await setup(model);
    const sent = await chat({ text: '第一句' });
    const cleared = await command(sent.id, 'clear');
    await cleared.until((events) => events.length === 1);

    await cleared.reader!.cancel();
    hold.open();
    await sent.end();
    await waitUntil(() => !chats!.busy(sent.id));

    expect(cleared.types()).toEqual(['waiting']);
    expect(await segments(sent.id)).toEqual([[1, 'first', undefined]]);
    expect(entries.find((entry) => entry.msg === 'command.end')?.fields).toMatchObject({
      command: 'clear',
      result: 'aborted',
      disconnected: true,
    });
  });

  it('压缩中断开（请求的中止信号）：压缩被中止，段不变，模型调用表那一行是 aborted', async () => {
    const summaryHold = gate();
    const model = scripted(answer('好'), held(summaryHold, '不会用上的摘要'));
    const { chat, command, segments, calls, chats } = await setup(model);
    const sent = await chat({ text: '第一句' });
    await sent.end();
    const request = new AbortController();
    const compacted = await command(sent.id, 'compact', { init: { signal: request.signal } });
    await compacted.until(() => model.doStreamCalls.length === 2);

    request.abort();
    await waitUntil(() => !chats!.busy(sent.id));

    expect(await segments(sent.id)).toEqual([[1, 'first', undefined]]);
    expect(await calls(sent.id)).toEqual([
      ['reply', undefined, 'completed'],
      ['summary', 'manual', 'aborted'],
    ]);
    summaryHold.open();
  });
});

describe('出错与拒绝', () => {
  it('压缩失败：收到出错和原因（API key 抹掉）；段不变；之后还能再压缩', async () => {
    const key = 'sk-test/secret"42';
    const model = scripted(
      answer('好'),
      httpError(401, `bad key ${key} / ${JSON.stringify(key)}`),
      answer('第二次的摘要'),
    );
    const { chat, command, segments } = await setup(model, { secrets: [key] });
    const sent = await chat({ text: '第一句' });
    await sent.end();

    const failed = await command(sent.id, 'compact');
    await failed.end();

    expect(failed.types()).toEqual(['start', 'error']);
    const error = (failed.events[1] as { error: string }).error;
    expect(error).toContain('***');
    expect(error).not.toContain('secret');
    expect(await segments(sent.id)).toEqual([[1, 'first', undefined]]);

    const again = await command(sent.id, 'compact');
    await again.end();
    expect(again.events.at(-1)).toEqual({ type: 'result', result: 'compacted' });
  });

  it('核心以「正忙」拒绝（不经对话接口在回复）：当作出错写进流里，记一行日志', async () => {
    const hold = gate();
    const model = scripted(answer('好'), held(hold, '旁路的回复'));
    const { chat, command, sessions, entries } = await setup(model);
    const sent = await chat({ text: '第一句' });
    await sent.end();
    const conversation = await sessions!.open(sent.id);
    const bypass = conversation.reply().getReader();
    cleanups.push(() => bypass.cancel().catch(() => {}));
    await waitUntil(() => model.doStreamCalls.length === 2);

    const cleared = await command(sent.id, 'clear');
    await cleared.end();

    expect(cleared.types()).toEqual(['start', 'error']);
    expect(entries.find((entry) => entry.msg === 'command.busy')).toMatchObject({
      level: 'error',
      fields: { conversationId: sent.id, command: 'clear', reason: 'replying' },
    });
    hold.open();
  });

  it('拒绝：不存在的会话 404；网页、Telegram 会话 400；author 缺失、为空、超过 100 个字符 400；不是 JSON 415；正在退出 503', async () => {
    const storage = createMemoryStorage();
    const group = await storage.createConversation({
      platform: 'telegram',
      platformConversationId: '-1001',
      title: '读书会',
    });
    const web = await storage.createConversation({ platform: 'web' });
    const cli = await storage.createConversation({ platform: 'cli' });
    const { post, request, chats } = await setup(scripted(), { storage });
    const errorOf = async (path: string, body: unknown) => {
      const response = await post(path, body);
      return [response.status, ((await response.json()) as ErrorResponse).error];
    };

    expect(await errorOf('/api/conversations/nope/clear', { author: 'Bob' })).toEqual([
      404,
      '没有这个会话',
    ]);
    expect(await errorOf(`/api/conversations/${web}/compact`, { author: 'Bob' })).toEqual([
      400,
      '压缩、清空现在只给 CLI 会话用，这是网页的会话',
    ]);
    expect(await errorOf(`/api/conversations/${group}/clear`, { author: 'Bob' })).toEqual([
      400,
      '压缩、清空现在只给 CLI 会话用，这是Telegram的会话',
    ]);
    for (const body of [{}, { author: '' }, { author: '   ' }, { author: 'x'.repeat(101) }]) {
      const [status] = await errorOf(`/api/conversations/${cli}/clear`, body);
      expect(status).toBe(400);
    }
    const text = await request(`/api/conversations/${cli}/clear`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'Bob',
    });
    expect(text.status).toBe(415);
    // 100 个字符可以
    expect(
      (await post(`/api/conversations/${cli}/clear`, { author: 'x'.repeat(100) })).status,
    ).toBe(200);

    chats!.close();
    expect(await errorOf(`/api/conversations/${cli}/clear`, { author: 'Bob' })).toEqual([
      503,
      '洛璃服务正在退出',
    ]);
  });
});

describe('心跳', () => {
  it('等待期间流里有心跳注释', async () => {
    const hold = gate();
    const model = scripted(held(hold, '好'));
    const { chat, command } = await setup(model, { heartbeat: 20 });
    const sent = await chat({ text: '第一句' });
    const cleared = await command(sent.id, 'clear');

    await waitUntil(() => cleared.raw().includes(': ping'), 3000, '心跳');

    expect(cleared.raw()).toContain('data: {"type":"waiting"}\n\n');
    expect(cleared.raw()).toContain('\n\n: ping\n\n');
    hold.open();
    await cleared.end();
    expect(cleared.events.at(-1)).toEqual({ type: 'result', result: 'cleared' });
  });
});

describe('服务退出', () => {
  it('还在等的指令以「被中止」结束，没有执行', async () => {
    const hold = gate();
    const model = scripted(held(hold, '好'));
    const { chat, command, segments, chats, sessions } = await setup(model);
    const sent = await chat({ text: '第一句' });
    const cleared = await command(sent.id, 'clear');
    await cleared.until((events) => events.length === 1);

    chats!.close();
    await cleared.end();

    expect(cleared.events).toEqual([{ type: 'waiting' }, { type: 'result', result: 'aborted' }]);
    hold.open();
    await sent.end();
    await sessions!.close(0, 300);
    await chats!.settled();
    expect(await segments(sent.id)).toEqual([[1, 'first', undefined]]);
  });

  it('进行中的压缩被中止，以「被中止」结束，段不变；settled 等这条流写完', async () => {
    const summaryHold = gate();
    const model = scripted(answer('好'), held(summaryHold, '不会用上的摘要'));
    const { chat, command, segments, calls, chats } = await setup(model);
    const sent = await chat({ text: '第一句' });
    await sent.end();
    const compacted = await command(sent.id, 'compact');
    await compacted.until(() => model.doStreamCalls.length === 2);

    chats!.close();
    await chats!.settled();

    expect(compacted.events).toEqual([{ type: 'start' }, { type: 'result', result: 'aborted' }]);
    expect(await segments(sent.id)).toEqual([[1, 'first', undefined]]);
    expect((await calls(sent.id)).at(-1)).toEqual(['summary', 'manual', 'aborted']);
    summaryHold.open();
  });
});

describe('原有的行为', () => {
  it('指令结束后会话的状态清掉；别的会话（网页）的重试不受这个会话的指令影响', async () => {
    const hold = gate();
    const model = scripted(httpError(500, '上游坏了'), held(hold, '慢慢说'), answer('重试成功'));
    const { post, chat, command, chats } = await setup(model);
    // 网页会话：出错，一步都没写进历史，可以重试
    const webSent = await post('/api/chat', { text: '网页的一句' });
    const web = webSent.headers.get('x-conversation-id')!;
    await webSent.text();
    // CLI 会话：回复进行中，指令在等
    const sent = await chat({ text: '第一句' });
    await sent.until(() => model.doStreamCalls.length === 2);
    const cleared = await command(sent.id, 'clear');
    await cleared.until((events) => events.length === 1);

    const retry = await post('/api/chat', { conversationId: web, retry: true });
    expect(retry.status).toBe(200);
    await retry.text();

    hold.open();
    await cleared.end();
    await waitUntil(() => !chats!.busy(sent.id));
    expect(cleared.events.at(-1)).toEqual({ type: 'result', result: 'cleared' });
    expect(chats!.busy(web)).toBe(false);
  });
});
