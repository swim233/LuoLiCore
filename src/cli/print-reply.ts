import type { MessageChunk } from '../core/index.js';

export type PrintResult = { ok: true } | { ok: false; errorText: string };

/**
 * 遍历一次回复并打印：文本增量写 stdout，两类重试提示写 stderr。
 * 结束时保证 stdout 停在行首，调用方可以直接接着打印提示符或失败行。
 */
export async function printReply(stream: ReadableStream<MessageChunk>): Promise<PrintResult> {
  let errorText: string | undefined;
  let atLineStart = true;
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') {
      process.stdout.write(chunk.delta);
      if (chunk.delta) atLineStart = chunk.delta.endsWith('\n');
    } else if (chunk.type === 'data-retry') {
      const { phase, attempt, maxRetries, statusCode } = chunk.data;
      if (phase === 'stream') {
        // 已输出的半截保留，另起一行再提示
        if (!atLineStart) process.stdout.write('\n');
        atLineStart = true;
        console.error(`输出中断，重新生成（${attempt}/${maxRetries}）`);
      } else {
        console.error(
          `请求失败（${statusCode ?? '网络错误'}），重试中（${attempt}/${maxRetries}）`,
        );
      }
    } else if (chunk.type === 'error') {
      errorText ??= chunk.errorText;
    }
  }
  if (!atLineStart) process.stdout.write('\n');
  return errorText === undefined ? { ok: true } : { ok: false, errorText };
}
