import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatChunk } from '../server/types.js';
import { printReply } from './print-reply.js';

/** stdout 与 stderr 按写入先后合成一份，stderr 的行加 [err] 前缀 */
let output: string[] = [];
beforeEach(() => {
  output = [];
  vi.stubEnv('NO_COLOR', '1');
  vi.spyOn(process.stdout, 'write').mockImplementation((text) => {
    output.push(String(text));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((text) => {
    output.push(`[err]${String(text)}`);
    return true;
  });
  Object.defineProperty(process.stderr, 'columns', { value: 60, configurable: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** 服务的流读出来的段；broken 时读完这些段后像连接断了一样抛错 */
async function* streamOf(
  chunks: ChatChunk[],
  { broken = false }: { broken?: boolean } = {},
): AsyncGenerator<ChatChunk> {
  for (const chunk of chunks) yield chunk;
  if (broken) throw new Error('连接断了');
}

const textChunks = (text: string): ChatChunk[] => [
  { type: 'text-start', id: 't' },
  { type: 'text-delta', id: 't', delta: text },
  { type: 'text-end', id: 't' },
];

describe('CLI 打印工具调用', () => {
  it('调用、结果各一行：先把停在行中间的正文换行，下一步的正文从新的一行开始', async () => {
    const result = await printReply(
      streamOf([
        { type: 'start' },
        { type: 'start-step' },
        ...textChunks('我查一下'),
        { type: 'tool-input-start', toolCallId: 'c1', toolName: 'search' },
        {
          type: 'tool-input-available',
          toolCallId: 'c1',
          toolName: 'search',
          input: { q: '天气\n上海' },
        },
        { type: 'tool-output-available', toolCallId: 'c1', output: { temp: 21 } },
        { type: 'tool-input-available', toolCallId: 'c2', toolName: 'echo', input: {} },
        { type: 'tool-output-available', toolCallId: 'c2', output: '多行\n结果' },
        { type: 'finish-step' },
        { type: 'start-step' },
        ...textChunks('21 度'),
        { type: 'finish-step' },
        { type: 'finish' },
      ]),
    );

    expect(result).toEqual({ status: 'completed', usage: undefined });
    expect(output.join('')).toBe(
      [
        '我查一下',
        '[err]调用工具 search {"q":"天气\\n上海"}',
        '[err]工具结果 search {"temp":21}',
        '[err]调用工具 echo {}',
        '[err]工具结果 echo 多行 结果',
        '21 度',
        '',
      ].join('\n'),
    );
  });

  it('出错一行：执行出错、参数不合结构（两个段只打一行）', async () => {
    await printReply(
      streamOf([
        { type: 'tool-input-available', toolCallId: 'c1', toolName: 'search', input: {} },
        { type: 'tool-output-error', toolCallId: 'c1', errorText: 'Error: 网络不通' },
        {
          type: 'tool-input-error',
          toolCallId: 'c2',
          toolName: 'nope',
          input: {},
          errorText: 'AI_NoSuchToolError: 没有这个工具',
        },
        {
          type: 'tool-output-error',
          toolCallId: 'c2',
          errorText: 'AI_NoSuchToolError: 没有这个工具',
        },
        { type: 'finish' },
      ]),
    );

    expect(output).toEqual([
      '[err]调用工具 search {}\n',
      '[err]工具出错 search Error: 网络不通\n',
      '[err]工具出错 nope AI_NoSuchToolError: 没有这个工具\n',
    ]);
  });

  it('超过终端宽度的行截断，末尾加「…」', async () => {
    await printReply(
      streamOf([
        { type: 'tool-input-available', toolCallId: 'c1', toolName: 'echo', input: {} },
        { type: 'tool-output-available', toolCallId: 'c1', output: 'x'.repeat(200) },
        { type: 'finish' },
      ]),
    );

    const line = output[1]!.replace(/^\[err\]/, '').replace(/\n$/, '');
    // 宽 60：「工具结果 echo 」占 14 列，「…」占 1 列，剩 45 列
    expect(line).toBe(`工具结果 echo ${'x'.repeat(45)}…`);
  });

  // 带图片的工具结果在历史与流里的样子：文字与图片地址、描述
  const content = (text: string) => ({
    type: 'luoli-content',
    parts: [
      { type: 'text', text },
      {
        type: 'image',
        url: 'luoli-file:a.png',
        mediaType: 'image/png',
        width: 800,
        height: 600,
        bytes: 53_248,
      },
      { type: 'image', url: 'luoli-file:b.gif', mediaType: 'image/gif', bytes: 900 },
    ],
  });

  it('带图片的结果：文字后面每张图片接一段说明', async () => {
    Object.defineProperty(process.stderr, 'columns', { value: 120, configurable: true });
    await printReply(
      streamOf([
        { type: 'tool-input-available', toolCallId: 'c1', toolName: 'fetch', input: {} },
        { type: 'tool-output-available', toolCallId: 'c1', output: content('读到\n一张图') },
        { type: 'finish' },
      ]),
    );

    expect(output[1]).toBe(
      '[err]工具结果 fetch 读到 一张图 [图片 image/png 800×600 52 KB] [图片 image/gif 900 B]\n',
    );
  });

  it('带图片的结果超过终端宽度时只截文字，图片说明保留', async () => {
    Object.defineProperty(process.stderr, 'columns', { value: 120, configurable: true });
    await printReply(
      streamOf([
        { type: 'tool-input-available', toolCallId: 'c1', toolName: 'fetch', input: {} },
        { type: 'tool-output-available', toolCallId: 'c1', output: content('x'.repeat(200)) },
        { type: 'finish' },
      ]),
    );

    const line = output[1]!.replace(/^\[err\]/, '').replace(/\n$/, '');
    const images = ' [图片 image/png 800×600 52 KB] [图片 image/gif 900 B]';
    // 宽 120：图片说明占 54 列（「图片」两字各占两列），文字截到 66 列，含「工具结果 fetch 」15 列与「…」
    expect(line).toBe(`工具结果 fetch ${'x'.repeat(50)}…${images}`);
  });
});

describe('CLI 打印工具调用：服务给的摘要', () => {
  const summary = (toolCallId: string, text: string): ChatChunk => ({
    type: 'data-tool-summary',
    data: { toolCallId, summary: text },
    transient: true,
  });

  it('调用、结果用紧挨着的那段摘要；没有摘要的那一段照旧用参数、结果', async () => {
    Object.defineProperty(process.stderr, 'columns', { value: 120, configurable: true });
    await printReply(
      streamOf([
        summary('c1', 'https://a.test'),
        {
          type: 'tool-input-available',
          toolCallId: 'c1',
          toolName: 'fetch',
          input: { url: 'https://a.test' },
        },
        // 完成时没有摘要：不沿用调用时的那段
        { type: 'tool-output-available', toolCallId: 'c1', output: '正文' },
        { type: 'tool-input-available', toolCallId: 'c2', toolName: 'fetch', input: {} },
        summary('c2', 'https://b.test · 标题'),
        { type: 'tool-output-available', toolCallId: 'c2', output: '很长的正文' },
        { type: 'finish' },
      ]),
    );

    expect(output).toEqual([
      '[err]调用工具 fetch https://a.test\n',
      '[err]工具结果 fetch 正文\n',
      '[err]调用工具 fetch {}\n',
      '[err]工具结果 fetch https://b.test · 标题\n',
    ]);
  });

  it('带图片的结果：摘要后面照旧接图片说明；出错的照旧打错误', async () => {
    Object.defineProperty(process.stderr, 'columns', { value: 120, configurable: true });
    await printReply(
      streamOf([
        summary('c1', 'https://a.test/x.png'),
        { type: 'tool-input-available', toolCallId: 'c1', toolName: 'fetch', input: {} },
        summary('c1', 'https://a.test/x.png · 图'),
        {
          type: 'tool-output-available',
          toolCallId: 'c1',
          output: {
            type: 'luoli-content',
            parts: [
              { type: 'text', text: '一张图' },
              { type: 'image', url: 'luoli-file:a.png', mediaType: 'image/png', bytes: 900 },
            ],
          },
        },
        summary('c2', 'https://b.test'),
        { type: 'tool-input-available', toolCallId: 'c2', toolName: 'fetch', input: {} },
        summary('c2', 'https://b.test'),
        { type: 'tool-output-error', toolCallId: 'c2', errorText: '抓取失败：HTTP 404' },
        { type: 'finish' },
      ]),
    );

    expect(output).toEqual([
      '[err]调用工具 fetch https://a.test/x.png\n',
      '[err]工具结果 fetch https://a.test/x.png · 图 [图片 image/png 900 B]\n',
      '[err]调用工具 fetch https://b.test\n',
      '[err]工具出错 fetch 抓取失败：HTTP 404\n',
    ]);
  });
});

describe('CLI 读服务的流：结果', () => {
  it('完成时带用量；会话 id、回复开始告诉调用方', async () => {
    const seen: string[] = [];
    const result = await printReply(
      streamOf([
        { type: 'data-conversation', data: { conversationId: 'k1', seq: 1 }, transient: true },
        { type: 'start' },
        ...textChunks('好'),
        {
          type: 'finish',
          messageMetadata: {
            createdAt: '2026-11-09T00:00:00.000Z',
            usage: { input: 10, output: 2, total: 12 },
          },
        },
      ]),
      { onConversation: (id) => seen.push(`id:${id}`), onStart: () => seen.push('start') },
    );

    expect(result).toEqual({ status: 'completed', usage: { input: 10, output: 2, total: 12 } });
    expect(seen).toEqual(['id:k1', 'start']);
    expect(output).toEqual(['好', '\n']);
  });

  it('出错、中止', async () => {
    expect(
      await printReply(streamOf([{ type: 'start' }, { type: 'error', errorText: '坏了' }])),
    ).toEqual({ status: 'failed', errorText: '坏了' });
    expect(await printReply(streamOf([{ type: 'start' }, { type: 'abort' }]))).toEqual({
      status: 'aborted',
    });
  });

  it('排队：打一行「排队中」；不带回复就结束时给出原因', async () => {
    let queued = false;
    const result = await printReply(
      streamOf([
        { type: 'data-conversation', data: { conversationId: 'k1', seq: 3 }, transient: true },
        { type: 'data-queued', data: { fromSeq: 3 }, transient: true },
        { type: 'data-queue-end', data: { reason: 'merged' }, transient: true },
      ]),
      { onQueued: () => (queued = true) },
    );

    expect(result).toEqual({ status: 'queue-end', reason: 'merged' });
    expect(queued).toBe(true);
    expect(output).toEqual(['[err]（排队中，等前一个回复结束）\n']);
  });

  it('排队后补回复接在同一个流里：照常打印、完成', async () => {
    const result = await printReply(
      streamOf([
        { type: 'data-queued', data: { fromSeq: 3 }, transient: true },
        { type: 'start' },
        ...textChunks('一起回复'),
        { type: 'finish' },
      ]),
    );
    expect(result).toEqual({ status: 'completed', usage: undefined });
  });

  it('流断了：先把停在行中间的正文换行，返回 broken；没有结尾的段就结束了：ended', async () => {
    const broken = await printReply(
      streamOf([{ type: 'start' }, ...textChunks('说到一半')], { broken: true }),
    );
    expect(broken).toEqual({ status: 'broken' });
    expect(output).toEqual(['说到一半', '\n']);
    expect(await printReply(streamOf([{ type: 'start' }]))).toEqual({ status: 'ended' });
  });
});
