import { asSchema } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  silentLogger,
  ToolError,
  type ToolContext,
  type ToolDefinition,
  type Trigger,
} from '../../core/index.js';
import { createRequester } from '../../net/index.js';
import { closeAll, onClose, onlyLoopback, serve, type Handler } from '../../net/test-server.js';
import { openFeedsDb } from '../feeds-db.js';
import { installServices } from '../services/install.js';
import { createServiceLayer } from '../services/layer.js';
import { fakeService } from '../services/test-services.js';
import { resultNotice } from '../services/tools.js';
import { createTaskTools } from '../tasks/tools.js';
import { fakeClock, testService } from '../test-kit.js';
import { feedLimits, type FeedLimits } from './feed.js';
import { createReadFeedTool } from './tools.js';

// 查动态（read_feed，ADR-0014）：翻看监听任务存下来的条目。时间按上海（UTC+8）；外部服务是本地
// HTTP 服务，经真的服务层；feeds.db 在内存里；定时器用假时钟

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

type StreamResult = Awaited<ReturnType<MockLanguageModelV4['doStream']>>;
type StreamPart = StreamResult['stream'] extends ReadableStream<infer P> ? P : never;

/** 每次请求都回一句话（任务到点时的回复） */
function replying(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: new ReadableStream<StreamPart>({
        start(controller) {
          for (const part of [
            { type: 'text-start', id: 't' },
            { type: 'text-delta', id: 't', delta: '好的' },
            { type: 'text-end', id: 't' },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: undefined },
              usage: {
                inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
                outputTokens: { total: 1, text: 1, reasoning: undefined },
              },
            },
          ] as StreamPart[]) {
            controller.enqueue(part);
          }
          controller.close();
        },
      }),
    }),
  });
}

/** 一条：编号、标题、级别 */
const item = (id: string, level = 'red') => ({ id, title: `标题 ${id}`, level });

/** 描述：盯 demo 的 search（q=sh），每分钟查一次，条目在 list，认 id，标题 title，给她看 level */
const description = {
  service: 'demo',
  endpoint: 'search',
  params: { q: 'sh' },
  interval_minutes: 1,
  items: 'list',
  key: 'id',
  title: 'title',
  show: ['level'],
  mode: 'record',
};

const red = { field: 'level', op: 'eq', value: 'red' };

const alice = { id: 'u-alice', name: 'Alice' };
const trigger: Trigger = { author: alice, messageId: 'm-src' };

const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await closeAll();
});

async function setup() {
  // 假的外部服务：回 { list: lists[q] }
  const lists: Record<string, unknown[]> = { sh: [] };
  let requests = 0;
  const handler: Handler = (request, response) => {
    requests++;
    const q = new URL(request.url ?? '/', 'http://x').searchParams.get('q') ?? '';
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ list: lists[q] ?? [] }));
  };
  const server = await serve(handler);
  const installed = installServices(
    [fakeService({ baseUrl: server.origin })],
    {},
    {
      logger: silentLogger,
      report: () => {},
    },
  );
  if (!installed.ok) throw new Error(installed.error);
  const feeds = openFeedsDb(':memory:');
  const requester = createRequester({ isBlocked: onlyLoopback });
  onClose(async () => {
    await requester.close();
    feeds.close();
  });
  const layer = createServiceLayer({
    services: installed.services,
    feeds,
    requester,
    logger: silentLogger,
  });
  const clock = fakeClock(start);
  const service = await testService({
    model: replying(),
    taskTools: true,
    clock,
    now: () => clock.now(),
    monitors: { layer, feeds },
  });
  const tasks = service.tasks!;
  cleanups.push(() => service.sessions!.close(0, 300));
  cleanups.push(() => tasks.stop());
  const taskTools = Object.fromEntries(
    createTaskTools(() => tasks, { monitors: { services: layer.services } }).map((tool) => [
      tool.name,
      tool,
    ]),
  ) as Record<string, ToolDefinition>;
  const ctx = (conversationId: string): ToolContext => ({
    conversation: { id: conversationId },
    triggers: [trigger],
    abortSignal: new AbortController().signal,
    logger: silentLogger,
    env: {},
  });
  async function call(tool: ToolDefinition, input: unknown, conversationId: string) {
    return (await tool.execute(tool.input.parse(input), ctx(conversationId))) as string;
  }
  /** 建任务、改任务、取消任务 */
  const run = (name: string, input: unknown, conversationId: string) =>
    call(taskTools[name]!, input, conversationId);
  /** 查动态；limits 给了时用换小了的上限 */
  const read = (input: unknown, conversationId: string, limits?: FeedLimits) =>
    call(createReadFeedTool({ tasks: () => tasks, limits }), input, conversationId);
  async function refused(input: unknown, conversationId: string): Promise<string> {
    try {
      await read(input, conversationId);
    } catch (error) {
      expect(error).toBeInstanceOf(ToolError);
      return (error as ToolError).message;
    }
    throw new Error('应当以错误结果结束');
  }
  /** 新建一个网页会话，在里面建监听任务（已有 initial 这几条），开始盯 */
  async function watch(initial: unknown[], fields: Record<string, unknown> = {}) {
    lists.sh = initial;
    const id = await service.observed.createConversation({ platform: 'web' });
    await run(
      'create_task',
      { action: '有新的就记一下', kind: 'monitor', monitor: { ...description, ...fields } },
      id,
    );
    tasks.start();
    await tasks.settled();
    return id;
  }
  /** 往前走 ms，等定时器、查的请求、处理都做完 */
  async function advance(ms: number): Promise<void> {
    clock.advance(ms);
    await tasks.settled();
  }
  return {
    ...service,
    tasks,
    feeds,
    lists,
    run,
    read,
    refused,
    watch,
    advance,
    requests: () => requests,
  };
}

/** 结果里给出的序号，按出现的先后 */
const ids = (text: string) =>
  [...text.matchAll(/^序号 (\d+)（/gm)].map((match) => Number(match[1]));

describe('查动态的工具', () => {
  it('定义：名字、说明、参数（task 必填；limit 1 到 20；before 正整数）；时限、历史呈现用默认的；界面摘要', async () => {
    const tool = createReadFeedTool({
      tasks: () => ({ readFeed: async () => ({ ok: true, text: '' }) }),
    });
    expect([tool.name, tool.timeoutMs, tool.history]).toEqual(['read_feed', undefined, undefined]);
    expect(tool.description).toBe(
      [
        '此工具用于查看监听任务已保存的条目。引擎每次执行时会保存获取到的新条目，创建任务时已存在的条目也在其中，任务取消后仍保留。',
        '事件里仅列出标题的条目、之前触发过的内容、「最近有过什么」这类问题，用此工具查看；此工具不向服务发起请求。',
        '仅能查看此会话的监听任务，task 填任务 id，如 t7。结果由新到旧，仅包含符合监听范围（where）的条目，每个条目给出标题和 show 的字段。',
      ].join('\n'),
    );
    const schema = (await asSchema(tool.input).jsonSchema) as {
      properties: Record<string, { description: string; type: string; minimum?: number }>;
      required: string[];
    };
    expect(schema.required).toEqual(['task']);
    expect(schema.properties.task).toMatchObject({
      type: 'string',
      description: '监听任务的 id，如 t7',
    });
    expect(schema.properties.limit).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: 20,
      description: '返回的条目数，1 到 20，默认为 10',
    });
    expect(schema.properties.before).toMatchObject({
      type: 'integer',
      description: '仅返回序号小于此值的条目，用于接着查看更早的条目；未填写时从最新的开始',
    });
    for (const bad of [
      { task: 't1', limit: 0 },
      { task: 't1', limit: 21 },
      { task: 't1', limit: 1.5 },
      { task: 't1', before: 0 },
    ]) {
      expect(tool.input.safeParse(bad).success).toBe(false);
    }

    const summary = (task: unknown) => tool.summary!({ input: { task } });
    expect(summary('t7')).toBe('条目 · t7');
    expect(summary(' T7 ')).toBe('条目 · t7');
    expect(summary('7')).toBe('条目 · t7');
    expect(summary('第七个')).toBe('条目');
  });

  it('由新到旧，创建时已有的条目也在；没写 where 时全都给；不发请求', async () => {
    const s = await setup();
    const id = await s.watch([item('a'), item('b', 'blue')]);
    s.lists.sh = [item('c', 'blue'), item('a'), item('b', 'blue')];
    await s.advance(minute);
    const before = s.requests();

    const text = await s.read({ task: 't1' }, id);
    expect(text).toBe(
      [
        resultNotice,
        '监听任务 t1 已保存 3 条。以下为最新的 3 条，由新到旧。',
        '---',
        '序号 3（2026-11-09 21:31 获取）：\n标题 c\nlevel: blue',
        '',
        '序号 2（2026-11-09 21:30 获取）：\n标题 b\nlevel: blue',
        '',
        '序号 1（2026-11-09 21:30 获取）：\n标题 a\nlevel: red',
        '---',
        '没有更早的条目。',
      ].join('\n'),
    );
    expect(s.requests()).toBe(before);
    // 任务 id 也认 1、T1
    expect(await s.read({ task: '1' }, id)).toBe(text);
    expect(await s.read({ task: 'T1' }, id)).toBe(text);
  });

  it('按任务现在的 where、title、show：改过以后照新的', async () => {
    const s = await setup();
    const id = await s.watch([item('a'), item('b', 'blue'), item('c')], { where: red });

    expect(await s.read({ task: 't1' }, id)).toBe(
      [
        resultNotice,
        '监听任务 t1 已保存 3 条。以下 2 条符合监听范围，由新到旧。',
        '---',
        '序号 3（2026-11-09 21:30 获取）：\n标题 c\nlevel: red',
        '',
        '序号 1（2026-11-09 21:30 获取）：\n标题 a\nlevel: red',
        '---',
        '没有更早的条目。',
      ].join('\n'),
    );

    await s.run(
      'update_task',
      {
        task: 't1',
        monitor: {
          where: { field: 'level', op: 'eq', value: 'blue' },
          title: 'id',
          show: ['title'],
        },
      },
      id,
    );
    expect(await s.read({ task: 't1' }, id)).toBe(
      [
        resultNotice,
        '监听任务 t1 已保存 3 条。以下 1 条符合监听范围，由新到旧。',
        '---',
        '序号 2（2026-11-09 21:30 获取）：\nb\ntitle: 标题 b',
        '---',
        '没有更早的条目。',
      ].join('\n'),
    );
  });

  it('limit、before 翻页：接着上一次结尾给的序号往前看，不重不漏，翻到头是「没有更早的条目。」', async () => {
    const s = await setup();
    const keys = Array.from({ length: 25 }, (_, i) => `k${i + 1}`);
    const id = await s.watch(keys.map((key) => item(key)));

    const first = await s.read({ task: 't1' }, id);
    expect(first).toContain('监听任务 t1 已保存 25 条。以下为最新的 10 条，由新到旧。');
    expect(ids(first)).toEqual([25, 24, 23, 22, 21, 20, 19, 18, 17, 16]);
    expect(first.endsWith('---\n更早的条目：before 填 16。')).toBe(true);

    const second = await s.read({ task: 't1', limit: 12, before: 16 }, id);
    expect(second).toContain('监听任务 t1 已保存 25 条。以下为序号小于 16 的 12 条，由新到旧。');
    expect(ids(second)).toEqual([15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4]);
    expect(second.endsWith('更早的条目：before 填 4。')).toBe(true);

    // 正好取到最后一条：没有更早的
    const third = await s.read({ task: 't1', limit: 3, before: 4 }, id);
    expect(ids(third)).toEqual([3, 2, 1]);
    expect(third.endsWith('---\n没有更早的条目。')).toBe(true);

    // 有 where 时第二行的说法
    await s.run('update_task', { task: 't1', monitor: { where: red } }, id);
    const filtered = await s.read({ task: 't1', limit: 2, before: 10 }, id);
    expect(filtered).toContain(
      '监听任务 t1 已保存 25 条。以下 2 条符合监听范围、序号小于 10，由新到旧。',
    );
    expect(ids(filtered)).toEqual([9, 8]);
  });

  it('已经取消的任务照样能查；别的会话的、不存在的、认不出的：任务不存在；定时任务另有一句', async () => {
    const s = await setup();
    const id = await s.watch([item('a')]);
    await s.run('cancel_task', { task: 't1' }, id);
    expect(ids(await s.read({ task: 't1' }, id))).toEqual([1]);

    const other = await s.observed.createConversation({ platform: 'web' });
    expect(await s.refused({ task: 't1' }, other)).toBe('任务不存在');
    expect(await s.refused({ task: 't99' }, id)).toBe('任务不存在');
    expect(await s.refused({ task: '第一个' }, id)).toBe('任务不存在');
    const cli = await s.observed.createConversation({ platform: 'cli' });
    expect(await s.refused({ task: 't1' }, cli)).toBe('任务不存在');

    await s.run('create_task', { action: '提醒交周报', kind: 'once', at: '2026-11-10 09:00' }, id);
    expect(await s.refused({ task: 't2' }, id)).toBe('此任务为定时任务，没有保存的条目');
  });

  it('一条都没有：四种说法，都只有一行', async () => {
    const s = await setup();
    // 来源还不存在（没有查过）
    const unseen = await s.observed.createConversation({ platform: 'web' });
    await s.storage.createTask({
      conversationId: unseen,
      action: '有新的就记一下',
      schedule: { kind: 'monitor', monitor: { ...description, params: { q: 'gz' } } },
      source: trigger,
      createdAt: start,
    });
    expect(await s.read({ task: 't1' }, unseen)).toBe('监听任务 t1 尚未保存任何条目。');

    // 来源有了，一条都没存
    const empty = await s.watch([]);
    expect(await s.read({ task: 't2' }, empty)).toBe('监听任务 t2 尚未保存任何条目。');

    // 存了，没有符合的
    s.lists.sh = [item('a', 'blue'), item('b', 'blue')];
    await s.advance(minute);
    await s.run('update_task', { task: 't2', monitor: { where: red } }, empty);
    expect(await s.read({ task: 't2' }, empty)).toBe(
      '监听任务 t2 已保存 2 条，其中没有符合监听范围的条目。',
    );
    // 给了 before，翻到头都没有
    expect(await s.read({ task: 't2', before: 2 }, empty)).toBe(
      '监听任务 t2 没有序号小于 2 且符合监听范围的条目。',
    );
    await s.run('update_task', { task: 't2', monitor: { where: null } }, empty);
    expect(await s.read({ task: 't2', before: 1 }, empty)).toBe(
      '监听任务 t2 没有序号小于 1 的条目。',
    );
  });

  it('翻满上限（测试里换成 3 条）还没凑够：写明翻到了哪里，接着从那里往前翻', async () => {
    const s = await setup();
    const limits: FeedLimits = { ...feedLimits, maxScan: 3, batch: 2 };
    // 序号 1–6，只有 2、5 是红的
    const id = await s.watch(
      ['a', 'b', 'c', 'd', 'e', 'f'].map((key) =>
        item(key, key === 'b' || key === 'e' ? 'red' : 'blue'),
      ),
      { where: red },
    );

    const first = await s.read({ task: 't1' }, id, limits);
    expect(ids(first)).toEqual([5]);
    expect(first.endsWith('---\n已检索至序号 4，尚未检索完。更早的条目：before 填 4。')).toBe(true);
    const second = await s.read({ task: 't1', before: 4 }, id, limits);
    expect(ids(second)).toEqual([2]);
    expect(second.endsWith('---\n没有更早的条目。')).toBe(true);

    // 一条符合的都没翻到
    await s.run(
      'update_task',
      { task: 't1', monitor: { where: { field: 'level', op: 'eq', value: 'green' } } },
      id,
    );
    expect(await s.read({ task: 't1' }, id, limits)).toBe(
      '监听任务 t1 已保存 6 条，已检索至序号 4，尚未找到符合监听范围的条目。更早的条目：before 填 4。',
    );
    expect(await s.read({ task: 't1', before: 4 }, id, limits)).toBe(
      '监听任务 t1 没有序号小于 4 且符合监听范围的条目。',
    );
    // 正好翻满、也正好到头：不说没翻完
    expect(await s.read({ task: 't1', before: 3 }, id, { ...limits, maxScan: 2 })).toBe(
      '监听任务 t1 没有序号小于 3 且符合监听范围的条目。',
    );
  });

  it('整个结果有字数上限：下一条放不下就停在上一条，接着往前看；第一条自己就超了也照样给出', async () => {
    const s = await setup();
    const long = '长'.repeat(300);
    const id = await s.watch(['a', 'b', 'c', 'd'].map((key) => ({ ...item(key), level: long })));

    const all = await s.read({ task: 't1' }, id);
    expect(ids(all)).toEqual([4, 3, 2, 1]);
    // 放得下三条、放不下四条的上限
    const three = [...(await s.read({ task: 't1', limit: 3 }, id))].length;
    const limits: FeedLimits = { ...feedLimits, maxChars: three + 10 };
    const cut = await s.read({ task: 't1' }, id, limits);
    expect(cut).toContain('以下为最新的 3 条，由新到旧。');
    expect(ids(cut)).toEqual([4, 3, 2]);
    expect(cut.endsWith('---\n更早的条目：before 填 2。')).toBe(true);
    expect([...cut].length).toBeLessThanOrEqual(limits.maxChars);

    const tiny = await s.read({ task: 't1' }, id, { ...feedLimits, maxChars: 50 });
    expect(ids(tiny)).toEqual([4]);
    expect(tiny.endsWith('---\n更早的条目：before 填 4。')).toBe(true);
  });

  it('存的时候截掉了的条目：照样列出（过滤时算符合），内容写一句说明', async () => {
    const s = await setup();
    const huge = { ...item('big', 'blue'), note: '大'.repeat(30_000) };
    const id = await s.watch([item('a'), huge], { where: red });
    expect(s.feeds.items(s.feeds.watcher(1)!.sourceId).map(({ truncated }) => truncated)).toEqual([
      false,
      true,
    ]);

    expect(await s.read({ task: 't1' }, id)).toBe(
      [
        resultNotice,
        '监听任务 t1 已保存 2 条。以下 2 条符合监听范围，由新到旧。',
        '---',
        '序号 2（2026-11-09 21:30 获取）：\n（此条目过长，保存时已截断，无法显示）',
        '',
        '序号 1（2026-11-09 21:30 获取）：\n标题 a\nlevel: red',
        '---',
        '没有更早的条目。',
      ].join('\n'),
    );
  });

  it('两个任务共用一个来源：比任务早的条目也算；各自按自己的 where', async () => {
    const s = await setup();
    const id = await s.watch([item('a'), item('b', 'blue')]);
    s.lists.sh = [item('c', 'blue'), item('a'), item('b', 'blue')];
    await s.advance(minute);
    await s.run(
      'create_task',
      {
        action: '蓝色的记一下',
        kind: 'monitor',
        monitor: { ...description, where: { field: 'level', op: 'eq', value: 'blue' } },
      },
      id,
    );
    await s.tasks.settled();
    expect(s.feeds.watcher(2)!.sourceId).toBe(s.feeds.watcher(1)!.sourceId);

    expect(ids(await s.read({ task: 't1' }, id))).toEqual([3, 2, 1]);
    expect(ids(await s.read({ task: 't2' }, id))).toEqual([3, 2]);
  });
});
