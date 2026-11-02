import type { MessageChunk, Usage } from '../core/index.js';
import { notice } from './notice.js';
import { oneLine } from './one-line.js';

export type PrintResult =
  | { status: 'completed'; usage?: Usage }
  | { status: 'failed'; errorText: string }
  | { status: 'aborted' };

/**
 * 遍历一次回复并打印：文本增量写 stdout；两类重试提示、工具调用的参数、结果与出错写 stderr，
 * 工具的每次调用、结果各截成一行。打这些行之前 stdout 停在行中间时先换行，之后的正文从新的一行开始。
 * 结束时保证 stdout 停在行首，调用方可以直接接着打印提示符、失败行或中止提示。
 * 完成时一并返回 finish 段带来的用量。
 */
export async function printReply(stream: ReadableStream<MessageChunk>): Promise<PrintResult> {
  let errorText: string | undefined;
  let aborted = false;
  let usage: Usage | undefined;
  let atLineStart = true;
  // 工具名按 toolCallId：结果、出错的段只带 toolCallId
  const toolNames = new Map<string, string>();
  // 参数不合结构、调了不存在的工具时，先后有 tool-input-error 与 tool-output-error，只打一行
  const failedCalls = new Set<string>();
  const toolLine = (text: string) => {
    if (!atLineStart) process.stdout.write('\n');
    atLineStart = true;
    notice(oneLine(text, process.stderr.columns ?? 120));
  };
  for await (const chunk of stream) {
    if (chunk.type === 'tool-input-available') {
      toolNames.set(chunk.toolCallId, chunk.toolName);
      toolLine(`调用工具 ${chunk.toolName} ${json(chunk.input)}`);
    } else if (chunk.type === 'tool-output-available') {
      if (chunk.preliminary) continue;
      const name = toolNames.get(chunk.toolCallId) ?? '?';
      // 字符串结果原样，其他转成 JSON（与交给模型的文字相同）
      const { output } = chunk;
      toolLine(`工具结果 ${name} ${typeof output === 'string' ? output : json(output)}`);
    } else if (chunk.type === 'tool-input-error' || chunk.type === 'tool-output-error') {
      if (chunk.type === 'tool-input-error') toolNames.set(chunk.toolCallId, chunk.toolName);
      if (failedCalls.has(chunk.toolCallId)) continue;
      failedCalls.add(chunk.toolCallId);
      toolLine(`工具出错 ${toolNames.get(chunk.toolCallId) ?? '?'} ${chunk.errorText}`);
    } else if (chunk.type === 'text-delta') {
      process.stdout.write(chunk.delta);
      if (chunk.delta) atLineStart = chunk.delta.endsWith('\n');
    } else if (chunk.type === 'data-retry') {
      const { phase, attempt, maxRetries, statusCode } = chunk.data;
      if (phase === 'stream') {
        // 已输出的半截保留，另起一行再提示
        if (!atLineStart) process.stdout.write('\n');
        atLineStart = true;
        notice(`输出中断，重新生成（${attempt}/${maxRetries}）`);
      } else {
        notice(`请求失败（${statusCode ?? '网络错误'}），重试中（${attempt}/${maxRetries}）`);
      }
    } else if (chunk.type === 'error') {
      errorText ??= chunk.errorText;
    } else if (chunk.type === 'abort') {
      aborted = true;
    } else if (chunk.type === 'finish') {
      usage = chunk.messageMetadata?.usage;
    }
  }
  if (!atLineStart) process.stdout.write('\n');
  if (errorText !== undefined) return { status: 'failed', errorText };
  return aborted ? { status: 'aborted' } : { status: 'completed', usage };
}

function json(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
