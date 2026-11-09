import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool, installTools, type ToolCall } from '../core/index.js';
import { testService } from './test-kit.js';
import { toolSummaries } from './tool-summary.js';
import type { LiveEvent, MessagesResponse, TodaySummary } from './types.js';
import { toolDurations } from './views.js';

type StreamResult = Awaited<ReturnType<MockLanguageModelV4['doStream']>>;
type StreamPart = StreamResult['stream'] extends ReadableStream<infer P> ? P : never;
type Item = StreamPart | { pause: number };

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 2, text: 2, reasoning: undefined },
};
const finish = (reason: 'stop' | 'tool-calls'): StreamPart => ({
  type: 'finish',
  finishReason: { unified: reason, raw: undefined },
  usage,
});
const call = (toolName: string, input: unknown, id: string): Item[] => [
  { type: 'tool-input-start', id, toolName },
  { type: 'tool-input-delta', id, delta: JSON.stringify(input) },
  { type: 'tool-input-end', id },
  { type: 'tool-call', toolCallId: id, toolName, input: JSON.stringify(input) },
];

function scripted(...steps: Item[][]): MockLanguageModelV4 {
  let index = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const items = [...(steps[index++] ?? [])];
      return {
        stream: new ReadableStream<StreamPart>(
          {
            async pull(controller) {
              for (let item = items.shift(); item !== undefined; item = items.shift()) {
                if ('pause' in item) await new Promise((r) => setTimeout(r, item.pause));
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const tools = installTools(
  [
    defineTool({
      name: 'look',
      description: '看一个网址',
      input: z.object({ url: z.string() }),
      summary: ({ input, output }) =>
        output === undefined ? input.url : `${input.url} · ${output}`,
      execute: async () => {
        await sleep(40);
        return '标题';
      },
    }),
    defineTool({
      name: 'broken',
      description: '总是出错',
      input: z.object({ url: z.string() }),
      summary: ({ input }) => `坏的 ${input.url}`,
      execute: () => {
        throw new Error('坏了');
      },
    }),
    defineTool({
      name: 'plain',
      description: '没写摘要',
      input: z.object({}),
      execute: () => 'ok',
    }),
    defineTool({
      name: 'oops',
      description: '摘要函数自己出错',
      input: z.object({}),
      summary: () => {
        throw new Error('摘要坏了');
      },
      execute: () => 'ok',
    }),
  ],
  {},
).tools;

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('回复的细节：思考秒数、工具摘要、工具耗时', () => {
  it('整理过的消息与实时事件里都有；网页会话的标题也进今日概况', async () => {
    const model = scripted(
      [
        { type: 'reasoning-start', id: 'r' },
        { type: 'reasoning-delta', id: 'r', delta: '想' },
        { pause: 50 },
        { type: 'reasoning-end', id: 'r' },
        ...call('look', { url: 'https://a.test' }, 'c1'),
        ...call('broken', { url: 'https://b.test' }, 'c2'),
        ...call('plain', {}, 'c3'),
        ...call('oops', {}, 'c4'),
        finish('tool-calls'),
      ],
      [
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: '看完了' },
        { type: 'text-end', id: 't' },
        finish('stop'),
      ],
    );
    const service = await testService({ model, tools });
    cleanups.push(() => service.sessions!.close(0, 200));
    // 收 live 事件：在 SSE 上连一个面板
    const lives: LiveEvent[] = [];
    const sse = (await service.request('/api/events')).body!.getReader();
    cleanups.push(() => sse.cancel());
    void (async () => {
      const decoder = new TextDecoder();
      let buffer = '';
      for (let read = await sse.read(); !read.done; read = await sse.read()) {
        buffer += decoder.decode(read.value, { stream: true });
        for (let at = buffer.indexOf('\n\n'); at >= 0; at = buffer.indexOf('\n\n')) {
          const lines = buffer.slice(0, at).split('\n');
          buffer = buffer.slice(at + 2);
          if (lines.includes('event: live')) {
            const data = lines.find((line) => line.startsWith('data: '))!.slice(6);
            lives.push(JSON.parse(data) as LiveEvent);
          }
        }
      }
    })().catch(() => {});

    const response = await service.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '帮我看看这几个网址' }),
    });
    await response.text();
    const id = response.headers.get('x-conversation-id')!;

    const { messages } = (await (
      await service.request(`/api/conversations/${id}/messages`)
    ).json()) as MessagesResponse;
    const reply = messages.at(-1)!;
    // 思考秒数来自 metadata
    expect(reply.message.metadata?.reasoningMs).toHaveLength(1);
    expect(reply.message.metadata!.reasoningMs![0]).toBeGreaterThanOrEqual(45);
    // 工具：摘要（有结果的按结果、出错的只按参数）、耗时取自工具调用表
    expect(reply.tools.c1).toMatchObject({ summary: 'https://a.test · 标题' });
    expect(reply.tools.c1!.durationMs).toBeGreaterThanOrEqual(35);
    expect(reply.tools.c2).toMatchObject({ summary: '坏的 https://b.test' });
    expect(reply.tools.c2!.durationMs).toBeGreaterThanOrEqual(0);
    expect(reply.tools.c3).not.toHaveProperty('summary');
    expect(reply.tools.c3!.durationMs).toBeGreaterThanOrEqual(0);
    expect(reply.tools.c4).not.toHaveProperty('summary');

    // 实时事件：开始时按参数，结束时按参数与结果
    const deadline = Date.now() + 3000;
    while (!lives.some((event) => event.type === 'end') && Date.now() < deadline) await sleep(5);
    const starts = lives.filter((event) => event.type === 'tool-start');
    const ends = lives.filter((event) => event.type === 'tool-end');
    const by = (events: LiveEvent[], callId: string) =>
      events.find((event) => 'callId' in event && event.callId === callId) as
        (LiveEvent & { summary?: string }) | undefined;
    expect(by(starts, 'c1')?.summary).toBe('https://a.test');
    expect(by(ends, 'c1')?.summary).toBe('https://a.test · 标题');
    expect(by(starts, 'c2')?.summary).toBe('坏的 https://b.test');
    expect(by(ends, 'c2')?.summary).toBe('坏的 https://b.test');
    expect(by(starts, 'c3')).not.toHaveProperty('summary');
    expect(by(ends, 'c4')).not.toHaveProperty('summary');

    const today = (await (await service.request('/api/today')).json()) as TodaySummary;
    expect(today.conversations).toEqual([{ id, title: '帮我看看这几个网址', replies: 1 }]);
  });
});

describe('工具耗时：同一步里同一个工具调两次', () => {
  it('先调的慢、后调的快（同一毫秒开始、结果相同）：按调用 id 对上，不会对反', async () => {
    const wait = installTools(
      [
        defineTool({
          name: 'wait',
          description: '等一会儿',
          input: z.object({ ms: z.number() }),
          execute: async ({ ms }) => {
            await sleep(ms);
            return `等了 ${ms}`;
          },
        }),
      ],
      {},
    ).tools;
    const model = scripted(
      [
        ...call('wait', { ms: 400 }, 'slow'),
        ...call('wait', { ms: 40 }, 'fast'),
        finish('tool-calls'),
      ],
      [
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: '好了' },
        { type: 'text-end', id: 't' },
        finish('stop'),
      ],
    );
    const service = await testService({ model, tools: wait });
    cleanups.push(() => service.sessions!.close(0, 200));
    const response = await service.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '等两次' }),
    });
    await response.text();
    const id = response.headers.get('x-conversation-id')!;

    // 表里先写的是先结束的那次（fast）
    const rows = await (await service.storage.openConversation(id)).toolCalls();
    expect(rows.map((row) => row.toolCallId)).toEqual(['fast', 'slow']);
    const { messages } = (await (
      await service.request(`/api/conversations/${id}/messages`)
    ).json()) as MessagesResponse;
    const { tools: details } = messages.at(-1)!;
    expect(details.slow!.durationMs).toBeGreaterThanOrEqual(350);
    expect(details.fast!.durationMs).toBeLessThan(300);
  });
});

describe('工具耗时：从工具调用表对上消息里的工具调用', () => {
  const row = (fields: Partial<ToolCall>): ToolCall => ({
    replyId: 'r1',
    tool: 'fetch',
    step: 1,
    startedAt: '2026-11-09T10:00:00.000Z',
    durationMs: 100,
    outcome: 'completed',
    ...fields,
  });
  const tool = (name: string, id: string, ok = true) => ({
    type: `tool-${name}`,
    toolCallId: id,
    state: ok ? 'output-available' : 'output-error',
  });

  it('有调用 id 的行按 id 对上，不看开始时间与写入的先后', () => {
    const parts = [{ type: 'step-start' }, tool('fetch', 'a'), tool('fetch', 'b')];
    const durations = toolDurations(parts, [
      row({ toolCallId: 'b', durationMs: 40 }),
      row({ toolCallId: 'a', durationMs: 400 }),
    ]);
    expect(Object.fromEntries(durations)).toEqual({ a: 400, b: 40 });
  });

  it('新旧行混在一起：有 id 的按 id，对不上 id 的调用退回按先后对以前的行；有 id 但对不上的行不拿来凑', () => {
    const parts = [
      { type: 'step-start' },
      tool('fetch', 'new'),
      tool('fetch', 'old1'),
      tool('fetch', 'old2'),
    ];
    const durations = toolDurations(parts, [
      row({ toolCallId: 'new', durationMs: 5 }),
      row({ toolCallId: 'elsewhere', durationMs: 999 }),
      row({ startedAt: '2026-11-09T10:00:00.002Z', durationMs: 20 }),
      row({ startedAt: '2026-11-09T10:00:00.001Z', durationMs: 10 }),
    ]);
    expect(Object.fromEntries(durations)).toEqual({ new: 5, old1: 10, old2: 20 });
  });

  it('以前的行（没有调用 id）：按第几步、工具名分组，组里按开始时间先后对上', () => {
    const parts = [
      { type: 'step-start' },
      tool('fetch', 'a'),
      tool('fetch', 'b'),
      tool('look', 'c'),
      { type: 'step-start' },
      tool('fetch', 'd'),
    ];
    const durations = toolDurations(parts, [
      // 表里按结束先后写入：b 先结束
      row({ startedAt: '2026-11-09T10:00:00.002Z', durationMs: 20 }),
      row({ startedAt: '2026-11-09T10:00:00.001Z', durationMs: 900 }),
      row({ tool: 'look', durationMs: 5 }),
      row({ step: 2, durationMs: 7 }),
    ]);
    expect(Object.fromEntries(durations)).toEqual({ a: 900, b: 20, c: 5, d: 7 });
  });

  it('同一时刻开始的同名调用：先按结果（成功、出错）对上', () => {
    const parts = [{ type: 'step-start' }, tool('fetch', 'ok'), tool('fetch', 'bad', false)];
    const durations = toolDurations(parts, [
      row({ outcome: 'failed', durationMs: 3 }),
      row({ outcome: 'completed', durationMs: 800 }),
    ]);
    expect(Object.fromEntries(durations)).toEqual({ ok: 800, bad: 3 });
  });

  it('对不上的不给：表里没有、行数不够、没有 step-start 的旧消息按第 1 步算', () => {
    expect(toolDurations([{ type: 'step-start' }, tool('fetch', 'a')], [])).toEqual(new Map());
    const durations = toolDurations(
      [
        tool('fetch', 'a'),
        tool('fetch', 'b'),
        { type: 'dynamic-tool', toolName: 'x', toolCallId: 'c' },
      ],
      [row({ durationMs: 11 }), row({ tool: 'x', durationMs: 4 })],
    );
    expect(Object.fromEntries(durations)).toEqual({ a: 11, c: 4 });
  });
});

describe('工具给界面看的摘要', () => {
  it('没写、出错、返回空的都当作没写；带图片的结果给文字部分；换行压成空格，太长截断', () => {
    const summarize = toolSummaries(
      installTools(
        [
          defineTool({
            name: 'echo',
            description: '原样',
            input: z.object({ word: z.string() }),
            summary: ({ input, output }) =>
              input.word === 'empty' ? '  ' : `${input.word}\n${String(output ?? '')}`,
            execute: ({ word }) => word,
          }),
        ],
        {},
      ).tools,
    );
    expect(summarize('echo', { word: 'hi' }, 'there')).toBe('hi there');
    expect(summarize('echo', { word: 'hi' })).toBe('hi');
    expect(summarize('echo', { word: 'empty' })).toBeUndefined();
    expect(summarize('nope', {})).toBeUndefined();
    expect(
      summarize(
        'echo',
        { word: 'img' },
        { type: 'luoli-content', parts: [{ type: 'text', text: '图的说明' }, { type: 'image' }] },
      ),
    ).toBe('img 图的说明');
    const long = summarize('echo', { word: '长'.repeat(300) })!;
    expect([...long]).toHaveLength(200);
    expect(long.endsWith('…')).toBe(true);
    // 参数不是它要的形状，摘要函数抛错：当作没写
    expect(summarize('echo', undefined)).toBeUndefined();
  });
});
