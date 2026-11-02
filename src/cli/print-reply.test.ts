import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageChunk } from '../core/index.js';
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

function streamOf(chunks: MessageChunk[]): ReadableStream<MessageChunk> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

const textChunks = (text: string): MessageChunk[] => [
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
