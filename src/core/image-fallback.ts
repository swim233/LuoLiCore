import { APICallError, RetryError, type TextStreamPart, type ToolSet } from 'ai';
import type { Message } from './message.js';

type Part = TextStreamPart<ToolSet>;

// 模型服务拒收请求的状态码：图片损坏、格式或尺寸不被接受时常见这几种
const rejectedStatus = new Set([400, 413, 422]);

/** 请求被模型服务拒收（400、413、422）；先重试过、最后一次是这种的也算 */
export function isRejectedRequest(error: unknown): boolean {
  if (RetryError.isInstance(error)) return isRejectedRequest(error.lastError);
  return APICallError.isInstance(error) && rejectedStatus.has(error.statusCode ?? 0);
}

/**
 * 可疑图片：最后一条助手消息之后的用户消息里、还没被标记的 `luoli-file:` 图片，按消息 id 分组；
 * 没有助手消息时整段都算。读不到的文件不算（发给模型的是「[图片已丢失]」）
 */
export async function suspectImages(
  history: Message[],
  readable: (url: string) => Promise<boolean>,
): Promise<Map<string, string[]>> {
  const lastReply = history.findLastIndex((message) => message.role === 'assistant');
  const suspects = new Map<string, string[]>();
  for (const message of history.slice(lastReply + 1)) {
    if (message.role !== 'user') continue;
    const urls: string[] = [];
    for (const part of message.parts) {
      if (part.type !== 'file' || !part.url.startsWith('luoli-file:')) continue;
      if (message.metadata?.unreadableFiles?.includes(part.url)) continue;
      if (await readable(part.url)) urls.push(part.url);
    }
    if (urls.length > 0) suspects.set(message.id, urls);
  }
  return suspects;
}

/** 给消息的 metadata 加上无法读取的图片标记（与已有的合并），其他字段不变 */
export function withUnreadable(message: Message, urls: string[]): Message {
  const metadata = message.metadata!;
  const unreadableFiles = [...new Set([...(metadata.unreadableFiles ?? []), ...urls])];
  return { ...message, metadata: { ...metadata, unreadableFiles } };
}

/**
 * 包住第一次请求的流：出现任何输出之前先攒着开头的段（start-step 等；整个流的 start 段照常放出）。
 * 还没输出就出错时问 recover：它给出新的流，就丢掉攒着的段和这个错误，改读新的流（跳过它的
 * start 段，已经放出过）；否则照原样放出。最多换一次
 */
export function withFallback(
  first: ReadableStream<Part>,
  recover: (error: unknown) => Promise<ReadableStream<Part> | undefined>,
): ReadableStream<Part> {
  let reader = first.getReader();
  // 还在等第一段输出；一旦有输出、出错或结束就不再攒，也不再换
  let deciding = true;
  let held: Part[] = [];
  // 换成的新流开头的 start 段不再放出
  let skipStart = false;
  return new ReadableStream<Part>({
    async pull(controller) {
      for (;;) {
        const next = await reader.read();
        if (next.done) {
          for (const part of held) controller.enqueue(part);
          held = [];
          controller.close();
          return;
        }
        const part = next.value;
        if (skipStart && part.type === 'start') {
          skipStart = false;
          continue;
        }
        if (!deciding || part.type === 'start') {
          controller.enqueue(part);
          return;
        }
        if (part.type === 'error') {
          deciding = false;
          const replacement = await recover(part.error);
          if (replacement) {
            // 第一次请求出错后流就结束了；读完再换
            while (!(await reader.read()).done);
            held = [];
            reader = replacement.getReader();
            skipStart = true;
            continue;
          }
        }
        if (part.type === 'error' || !isQuiet(part)) {
          deciding = false;
          for (const item of held) controller.enqueue(item);
          held = [];
          controller.enqueue(part);
          return;
        }
        held.push(part);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

// 还不算输出的段：流与步骤的开始、内容段的起止、空的增量
function isQuiet(part: Part): boolean {
  switch (part.type) {
    case 'start-step':
    case 'text-start':
    case 'text-end':
    case 'reasoning-start':
    case 'reasoning-end':
    case 'raw':
      return true;
    case 'text-delta':
    case 'reasoning-delta':
      return part.text === '';
    default:
      return false;
  }
}
