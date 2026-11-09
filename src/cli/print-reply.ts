import type { Usage } from '../core/message.js';
import {
  describeImage,
  isStoredToolContent,
  toolContentImages,
  toolContentText,
} from '../core/tool-content.js';
import type { ChatChunk, ChatData } from '../server/types.js';
import { notice } from './notice.js';
import { displayWidth, oneLine } from './one-line.js';

export type PrintResult =
  | { status: 'completed'; usage?: Usage }
  | { status: 'failed'; errorText: string }
  | { status: 'aborted' }
  /** 排在队里的这条没有自己的回复：并进了后面的回复、前一个回复已经看到它、补回复被取消 */
  | { status: 'queue-end'; reason: ChatData['queue-end']['reason'] }
  /** 流结束了，但没有结尾的段（完成、出错、中止都没有） */
  | { status: 'ended' }
  /** 流断了（连接断开、读出错） */
  | { status: 'broken' };

/** 读流时的进展，给 Ctrl+C 用：知道了会话 id、排上了队、回复开始了 */
export type ReplyProgress = {
  onConversation?: (conversationId: string) => void;
  onQueued?: () => void;
  onStart?: () => void;
};

/**
 * 读一次回复的流并打印：文本增量写 stdout；两类重试提示、排队、工具调用的摘要（或参数、结果）与
 * 出错写 stderr，工具的每次调用、结果各截成一行；结果带图片时，每张图片在末尾接一段说明，截断时
 * 只截文字。打这些行之前 stdout 停在行中间时先换行，之后的正文从新的一行开始。
 * 工具行优先用服务给的摘要（data-tool-summary，只管紧接着的那一段），没有时用参数、结果的前一截。
 * 结束时保证 stdout 停在行首，调用方可以直接接着打印提示符、失败行或中止提示。
 * 完成时一并返回 finish 段带来的用量。读流出错（连接断了）时返回 broken，不抛出
 */
export async function printReply(
  chunks: AsyncIterable<ChatChunk>,
  progress: ReplyProgress = {},
): Promise<PrintResult> {
  let errorText: string | undefined;
  let aborted = false;
  let finished = false;
  let usage: Usage | undefined;
  let queueEnd: ChatData['queue-end']['reason'] | undefined;
  let atLineStart = true;
  // 工具名按 toolCallId：结果、出错的段只带 toolCallId
  const toolNames = new Map<string, string>();
  // 服务给的摘要，只用于紧接着的那一段工具段
  const summaries = new Map<string, string>();
  const takeSummary = (toolCallId: string) => {
    const summary = summaries.get(toolCallId);
    summaries.delete(toolCallId);
    return summary;
  };
  // 参数不合结构、调了不存在的工具时，先后有 tool-input-error 与 tool-output-error，只打一行
  const failedCalls = new Set<string>();
  const newLine = () => {
    if (!atLineStart) process.stdout.write('\n');
    atLineStart = true;
  };
  // suffix 不截断，接在截好的 text 之后
  const toolLine = (text: string, suffix = '') => {
    newLine();
    // 不是终端、或者终端报不出宽度（0）时按 120 列
    const width = process.stderr.columns || 120;
    notice(oneLine(text, Math.max(width - displayWidth(suffix), 1)) + suffix);
  };
  try {
    for await (const chunk of chunks) {
      if (chunk.type === 'data-conversation') {
        progress.onConversation?.(chunk.data.conversationId);
      } else if (chunk.type === 'data-queued') {
        progress.onQueued?.();
        notice('（排队中，等前一个回复结束）');
      } else if (chunk.type === 'data-queue-end') {
        queueEnd = chunk.data.reason;
      } else if (chunk.type === 'start') {
        progress.onStart?.();
      } else if (chunk.type === 'data-tool-summary') {
        summaries.set(chunk.data.toolCallId, chunk.data.summary);
      } else if (chunk.type === 'tool-input-available') {
        toolNames.set(chunk.toolCallId, chunk.toolName);
        const summary = takeSummary(chunk.toolCallId);
        toolLine(`调用工具 ${chunk.toolName} ${summary ?? json(chunk.input)}`);
      } else if (chunk.type === 'tool-output-available') {
        if (chunk.preliminary) continue;
        const name = toolNames.get(chunk.toolCallId) ?? '?';
        const summary = takeSummary(chunk.toolCallId);
        // 字符串结果原样，其他转成 JSON（与交给模型的文字相同）；带图片的结果是文字加图片说明
        const { output } = chunk;
        if (isStoredToolContent(output)) {
          const images = toolContentImages(output).map(describeImage);
          toolLine(
            `工具结果 ${name} ${summary ?? toolContentText(output)}`,
            images.map((image) => ` ${image}`).join(''),
          );
        } else {
          const text = summary ?? (typeof output === 'string' ? output : json(output));
          toolLine(`工具结果 ${name} ${text}`);
        }
      } else if (chunk.type === 'tool-input-error' || chunk.type === 'tool-output-error') {
        takeSummary(chunk.toolCallId);
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
          newLine();
          notice(`输出中断，重新生成（${attempt}/${maxRetries}）`);
        } else {
          notice(`请求失败（${statusCode ?? '网络错误'}），重试中（${attempt}/${maxRetries}）`);
        }
      } else if (chunk.type === 'error') {
        errorText ??= chunk.errorText;
      } else if (chunk.type === 'abort') {
        aborted = true;
      } else if (chunk.type === 'finish') {
        finished = true;
        usage = chunk.messageMetadata?.usage;
      }
    }
  } catch {
    newLine();
    return { status: 'broken' };
  }
  newLine();
  if (errorText !== undefined) return { status: 'failed', errorText };
  if (aborted) return { status: 'aborted' };
  if (finished) return { status: 'completed', usage };
  if (queueEnd !== undefined) return { status: 'queue-end', reason: queueEnd };
  return { status: 'ended' };
}

function json(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
