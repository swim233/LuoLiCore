import { describe, expect, it } from 'vitest';
import type { ChatChunk } from '../server/types.js';
import { readChatStream, StreamBroken } from './chat-stream.js';

/** 把文字按给定的切法分成几块字节，做成响应体；error 时最后像连接断了一样出错 */
function body(pieces: string[], { error = false }: { error?: boolean } = {}) {
  const encoder = new TextEncoder();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const piece of pieces) controller.enqueue(encoder.encode(piece));
      if (error) controller.error(new TypeError('terminated'));
      else controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  return { stream, cancelled: () => cancelled };
}

async function collect(stream: ReadableStream<Uint8Array>) {
  const chunks: ChatChunk[] = [];
  for await (const chunk of readChatStream(stream)) chunks.push(chunk);
  return chunks;
}

const sse = (chunk: unknown) => `data: ${JSON.stringify(chunk)}\n\n`;

describe('读对话接口的流', () => {
  it('一段一行，按顺序给出；一块字节里切开的行、多字节字符照样拼好；读到 [DONE] 结束', async () => {
    const text =
      sse({ type: 'start' }) +
      sse({ type: 'text-delta', id: 't', delta: '你好' }) +
      'data: [DONE]\n\n';
    // 每 3 个字节切一刀：会切开行，也会切开「你」「好」的 UTF-8 字节
    const bytes = new TextEncoder().encode(text);
    const pieces: Uint8Array[] = [];
    for (let at = 0; at < bytes.length; at += 3) pieces.push(bytes.slice(at, at + 3));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const piece of pieces) controller.enqueue(piece);
        controller.close();
      },
    });

    expect(await collect(stream)).toEqual([
      { type: 'start' },
      { type: 'text-delta', id: 't', delta: '你好' },
    ]);
  });

  it('注释、空行、解析不了的段跳过；\\r\\n 换行也认', async () => {
    const { stream } = body([
      ': 心跳\n\n',
      'data: {坏的\n\n',
      `data: ${JSON.stringify({ type: 'start' })}\r\n\r\n`,
      'data: [DONE]\n\n',
    ]);
    expect(await collect(stream)).toEqual([{ type: 'start' }]);
  });

  it('没读到 [DONE] 就结束了、读出错：已经读到的段照样给出，然后抛 StreamBroken', async () => {
    const chunks: ChatChunk[] = [];
    await expect(async () => {
      for await (const chunk of readChatStream(body([sse({ type: 'start' })]).stream)) {
        chunks.push(chunk);
      }
    }).rejects.toBeInstanceOf(StreamBroken);
    expect(chunks).toEqual([{ type: 'start' }]);
    await expect(
      collect(body([sse({ type: 'start' })], { error: true }).stream),
    ).rejects.toBeInstanceOf(StreamBroken);
  });

  it('中途不读了：取消读取', async () => {
    const { stream, cancelled } = body([sse({ type: 'start' }), sse({ type: 'finish' })]);
    for await (const chunk of readChatStream(stream)) {
      expect(chunk).toEqual({ type: 'start' });
      break;
    }
    expect(cancelled()).toBe(true);
  });
});
