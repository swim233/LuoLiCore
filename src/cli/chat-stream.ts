import type { ChatChunk } from '../server/types.js';

/** 回复的流断了：连接中途断开、读出错，或者没等到结尾的 [DONE] 就结束了 */
export class StreamBroken extends Error {
  constructor(cause?: unknown) {
    super('回复的流断了', { cause });
    this.name = 'StreamBroken';
  }
}

/**
 * 读对话接口的响应体（UI message stream：一行一个 `data: {段的 JSON}`，段之间空一行，最后是
 * `data: [DONE]`），按顺序给出各段。不是 data 的行（注释、空行）跳过，解析不了的段跳过。
 * 读出错，或者没读到 [DONE] 就结束了，抛 StreamBroken。中途不读了（break）时取消读取
 */
export async function* readChatStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<ChatChunk, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finished = false;
  try {
    for (;;) {
      let read: Awaited<ReturnType<typeof reader.read>>;
      try {
        read = await reader.read();
      } catch (error) {
        throw new StreamBroken(error);
      }
      if (read.done) break;
      buffer += decoder.decode(read.value, { stream: true });
      for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
        const line = buffer.slice(0, at).replace(/\r$/, '');
        buffer = buffer.slice(at + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice('data:'.length).trimStart();
        if (data === '[DONE]') {
          finished = true;
          continue;
        }
        let chunk: ChatChunk;
        try {
          chunk = JSON.parse(data) as ChatChunk;
        } catch {
          continue;
        }
        yield chunk;
      }
    }
  } finally {
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (!finished) throw new StreamBroken();
}
