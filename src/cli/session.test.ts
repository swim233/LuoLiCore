import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryStorage } from '../core/index.js';
import { testPort, testService } from '../server/test-kit.js';
import type { ConversationsResponse, MessagesResponse } from '../server/types.js';
import { createClient, unreachableText, type Fetch } from './client.js';
import { createChatSession } from './session.js';

// CLI 连洛璃服务：会话、客户端对着真的服务接口（app.request，mock 模型，不起端口）

type StreamResult = Awaited<ReturnType<MockLanguageModelV4['doStream']>>;
type StreamPart = StreamResult['stream'] extends ReadableStream<infer P> ? P : never;
type Item = StreamPart | { gate: Promise<void> };

const usage = {
  inputTokens: { total: 10, noCache: 2, cacheRead: 8, cacheWrite: undefined },
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

function scripted(...steps: Item[][]): MockLanguageModelV4 {
  let index = 0;
  return new MockLanguageModelV4({
    doStream: async ({ abortSignal }) => {
      const items = [...(steps[index++] ?? [])];
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
async function waitUntil(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('等待超时');
    await sleep(5);
  }
}

/** stdout 与 stderr 按写入先后合成一份，stderr 的加 [err] 前缀 */
let output: string[] = [];
const printed = () => output.join('');
beforeEach(() => {
  output = [];
  vi.stubEnv('NO_COLOR', '1');
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    output.push(`[err]${String(chunk)}`);
    return true;
  });
});

const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/**
 * 一个服务和连它的 fetch。down 为真时像服务没在运行（连不上）；ignoreAbort 为真时中止接口什么也
 * 不做；breakAfter 给了时，回复的流读到含这段文字的数据后像连接断了一样出错
 */
async function setup(
  model: MockLanguageModelV4,
  options: { storage?: ReturnType<typeof createMemoryStorage> } = {},
) {
  const service = await testService({ model, ...options });
  cleanups.push(() => service.sessions!.close(0, 300));
  const net = { down: false, ignoreAbort: false, breakAfter: undefined as string | undefined };
  const fetch: Fetch = async (url, init = {}) => {
    if (init.signal?.aborted) throw init.signal.reason;
    if (net.down) throw new TypeError('fetch failed');
    const path = new URL(url).pathname;
    if (net.ignoreAbort && path.endsWith('/abort')) return Response.json({ aborted: false });
    const response = await service.request(path, init);
    const breakAfter = net.breakAfter;
    if (!breakAfter || !response.body) return response;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    return new Response(
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          const read = await reader.read();
          if (read.done) return controller.close();
          controller.enqueue(read.value);
          if (decoder.decode(read.value).includes(breakAfter)) {
            controller.error(new TypeError('terminated'));
            void reader.cancel();
          }
        },
      }),
      { status: response.status, headers: response.headers },
    );
  };
  const client = createClient({ port: testPort, fetch });
  const history = async (id: string) =>
    (
      (await (
        await service.request(`/api/conversations/${id}/messages`)
      ).json()) as MessagesResponse
    ).messages;
  return { ...service, net, client, history };
}

const unreachable = unreachableText(`127.0.0.1:${testPort}`);

describe('CLI 的会话：发消息', () => {
  it('发第一句时才建会话（平台 cli，发言人是 CLI 的名字）；之后接着用；打印回复与用量行', async () => {
    const { client, history, request } = await setup(scripted(answer('你好'), answer('还在')));
    const session = createChatSession({ client, author: 'Bob' });
    expect(session.conversationId).toBeUndefined();
    const before = (await (await request('/api/conversations')).json()) as ConversationsResponse;
    expect(before.conversations).toEqual([]);

    await session.say('在吗');
    const id = session.conversationId!;
    expect(id).toBeDefined();
    await session.say('还在吗');

    expect(session.conversationId).toBe(id);
    const messages = await history(id);
    expect(messages.map((m) => m.message.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(messages[0]!.message.metadata?.author).toEqual({ name: 'Bob' });
    const { conversations } = (await (
      await request('/api/conversations')
    ).json()) as ConversationsResponse;
    expect(conversations).toEqual([expect.objectContaining({ id, platform: 'cli' })]);
    expect(printed()).toBe(
      [
        '你好',
        '[err]tokens 输入 10（缓存 8）· 输出 2',
        '还在',
        '[err]tokens 输入 10（缓存 8）· 输出 2',
        '',
      ].join('\n'),
    );
  });

  it('接着用 --resume 的会话：第一句就发进那个会话', async () => {
    const { client, history } = await setup(scripted(answer('一'), answer('二')));
    const first = createChatSession({ client, author: 'Bob' });
    await first.say('第一句');
    const resumed = createChatSession({
      client,
      author: 'Bob',
      conversationId: first.conversationId,
    });
    await resumed.say('第二句');

    expect((await history(first.conversationId!)).length).toBe(4);
  });

  it('服务没在运行：打印提示，不抛错、不退出，这句话没发出去；服务起来后照常用', async () => {
    const { client, net, request } = await setup(scripted(answer('来了')));
    const session = createChatSession({ client, author: 'Bob' });
    net.down = true;
    expect(await session.say('在吗')).toBe('unreachable');

    expect(printed()).toBe(`[err]${unreachable}\n`);
    expect(session.conversationId).toBeUndefined();
    const { conversations } = (await (
      await request('/api/conversations')
    ).json()) as ConversationsResponse;
    expect(conversations).toEqual([]);

    net.down = false;
    output = [];
    expect(await session.say('现在呢')).toBe('done');
    expect(printed()).toContain('来了');
  });

  it('回复到一半连接断了（服务被强行结束）：另起一行打印提示，不退出；会话照旧', async () => {
    const { client, net } = await setup(scripted(answer('说到一半', '后面'), answer('接着说')));
    const session = createChatSession({ client, author: 'Bob' });
    net.breakAfter = '说到一半';
    expect(await session.say('在吗')).toBe('unreachable');

    expect(printed()).toBe(`说到一半\n[err]${unreachable}\n`);
    const id = session.conversationId;
    net.breakAfter = undefined;
    output = [];
    await session.say('继续');
    expect(session.conversationId).toBe(id);
    expect(printed()).toContain('接着说');
  });

  it('出错：打印「回复出错：…（详见服务的日志）」', async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => {
        throw Object.assign(new Error('上游坏了'), { name: 'AI_APICallError' });
      },
    });
    const { client } = await setup(model);
    // 模型出错不算连不上：管道模式下照常接着处理下一行
    expect(await createChatSession({ client, author: 'Bob' }).say('在吗')).toBe('done');

    expect(printed()).toMatch(/^\[err\]回复出错：.*上游坏了.*（详见服务的日志）\n$/);
  });
});

describe('CLI 的会话：Ctrl+C', () => {
  it('回复进行中：请服务中止，等到 abort 段，打「（已中止）」；半截写进历史', async () => {
    const hold = gate();
    const { client, history } = await setup(
      scripted([...text('说到'), { gate: hold.promise }, finish()]),
    );
    const session = createChatSession({ client, author: 'Bob' });
    const ctrlC = new AbortController();
    const said = session.say('在吗', ctrlC.signal);
    await waitUntil(() => printed().includes('说到'));
    ctrlC.abort();
    await said;
    hold.open();

    expect(printed()).toBe('说到\n[err]（已中止）\n');
    const messages = await history(session.conversationId!);
    expect(messages.at(-1)!.message.metadata?.aborted).toBe(true);
  });

  it('服务没理会中止：等到时限就断开请求，服务把断开当作中止；照样打「（已中止）」', async () => {
    const hold = gate();
    const { client, net, history, chats } = await setup(
      scripted([...text('说到'), { gate: hold.promise }, finish()]),
    );
    const session = createChatSession({ client, author: 'Bob', abortWait: 50 });
    const ctrlC = new AbortController();
    const said = session.say('在吗', ctrlC.signal);
    await waitUntil(() => printed().includes('说到'));
    net.ignoreAbort = true;
    ctrlC.abort();
    await said;
    await waitUntil(() => !chats!.busy(session.conversationId!));
    hold.open();

    expect(printed()).toBe('说到\n[err]（已中止）\n');
    expect((await history(session.conversationId!)).at(-1)!.message.metadata?.aborted).toBe(true);
  });

  it('新会话的请求还没回来（不知道会话 id）：直接断开', async () => {
    const { client, request } = await setup(scripted(answer('不会说出来')));
    const session = createChatSession({ client, author: 'Bob' });
    const ctrlC = new AbortController();
    ctrlC.abort();
    await session.say('在吗', ctrlC.signal);

    expect(printed()).toBe('[err]（已中止）\n');
    const { conversations } = (await (
      await request('/api/conversations')
    ).json()) as ConversationsResponse;
    expect(conversations).toEqual([]);
  });
});

describe('CLI 的会话：两个终端开着同一个会话', () => {
  it('后发的排队；再排进来一条时，前一个马上打「（会和后面的消息一起回复）」，最后一个收到回复', async () => {
    const hold = gate();
    const model = scripted([...text('说到'), { gate: hold.promise }, finish()], answer('一起回复'));
    const { client, chats } = await setup(model);
    const a = createChatSession({ client, author: 'A' });
    const saidA = a.say('第一句');
    await waitUntil(() => printed().includes('说到'));
    const id = a.conversationId!;
    const b = createChatSession({ client, author: 'B', conversationId: id });
    const c = createChatSession({ client, author: 'C', conversationId: id });
    const saidB = b.say('第二句');
    await waitUntil(() => printed().includes('排队中'));
    const saidC = c.say('第三句');
    // C 排进来时 B 马上结束（一个会话最多只有一个排队的请求连着）
    await saidB;
    expect(printed()).toContain('[err]（会和后面的消息一起回复）\n');
    hold.open();
    await saidA;
    await saidC;
    await waitUntil(() => !chats!.busy(id));

    expect(printed()).toContain('一起回复');
    const prompt = JSON.stringify(model.doStreamCalls[1]!.prompt);
    expect(prompt).toContain('第二句');
    expect(prompt).toContain('第三句');
  });

  it('排队时按 Ctrl+C：只断开自己的请求、取消自己的补回复，前一个回复照常完成', async () => {
    const hold = gate();
    const model = scripted([...text('说到'), { gate: hold.promise }, ...text('完'), finish()]);
    const { client, chats } = await setup(model);
    const a = createChatSession({ client, author: 'A' });
    const saidA = a.say('第一句');
    await waitUntil(() => printed().includes('说到'));
    const id = a.conversationId!;
    const b = createChatSession({ client, author: 'B', conversationId: id });
    const ctrlC = new AbortController();
    const saidB = b.say('第二句', ctrlC.signal);
    await waitUntil(() => printed().includes('排队中'));
    ctrlC.abort();
    await saidB;
    hold.open();
    await saidA;
    await waitUntil(() => !chats!.busy(id));

    expect(printed()).toContain('[err]（排队中，等前一个回复结束）\n[err]（已中止）\n');
    expect(printed()).toContain('完');
    expect(printed()).not.toMatch(/说到\n\[err\]（已中止）/);
    expect(model.doStreamCalls).toHaveLength(1);
  });
});

describe('CLI 的客户端', () => {
  it('健康检查：服务在运行为真；连不上、回的不是洛璃服务的状态为假', async () => {
    const { client } = await setup(scripted());
    expect(await client.healthy()).toBe(true);

    const down = createClient({
      port: testPort,
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    });
    expect(await down.healthy()).toBe(false);
    const other = createClient({
      port: testPort,
      fetch: async () => new Response('<html>别的服务</html>', { status: 200 }),
    });
    expect(await other.healthy()).toBe(false);
    const json = createClient({ port: testPort, fetch: async () => Response.json({ ok: true }) });
    expect(await json.healthy()).toBe(false);
  });

  it('--resume 用的会话：最后消息最新的 CLI 会话，不看网页、Telegram 的；没有时 undefined', async () => {
    const storage = createMemoryStorage();
    const { client } = await setup(scripted(answer('一'), answer('二'), answer('三')), { storage });
    expect(await client.latestCliConversation()).toBeUndefined();

    const older = createChatSession({ client, author: 'Bob' });
    await older.say('旧的');
    const newer = createChatSession({ client, author: 'Bob' });
    await newer.say('新的');
    // 网页会话更新，但不算
    await storage.createConversation({ platform: 'web' });
    await older.say('旧会话里又说了一句');

    expect(await client.latestCliConversation()).toMatchObject({
      id: older.conversationId,
      platform: 'cli',
      messages: 4,
    });
  });
});
