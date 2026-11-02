import { getToolName, isToolUIPart } from 'ai';
import type { Message } from './message.js';
import {
  isStoredToolContent,
  toolContentImages,
  toolContentText,
  type StoredToolContent,
} from './tool-content.js';
import type { InstalledTool, ToolHistory } from './tools.js';

type Part = Message['parts'][number];
type ToolPart = Extract<Part, { toolCallId: string }>;

/** 没有结果的工具调用（回复中途结束、旧数据）以这句说明作为错误结果 */
export const unfinishedToolCall = '工具调用未完成';
const omitted = '（结果已省略）';
const unreadableImage = '[图片无法读取]';
const truncatedNote = (length: number) => `…（已截短，原文 ${length} 字符）`;

/** 有结果的工具段：执行完了（含以错误结束的）或被拒绝 */
function hasResult(part: ToolPart): boolean {
  return (
    (part.state === 'output-available' && part.preliminary !== true) ||
    part.state === 'output-error' ||
    part.state === 'output-denied'
  );
}

/**
 * 消息里有已经开始执行的工具调用：参数收全了（input-available 起），或已有结果（含参数不合结构、
 * 调了不存在的工具的）。工具可能已经产生副作用，回复中途结束时也要写入
 */
export function hasToolCalls(message: Message): boolean {
  return message.parts.some((part) => isToolUIPart(part) && part.state !== 'input-streaming');
}

/**
 * 工具段收尾，写入历史前与送模型前都做，历史里就没有「有调用、没结果」的工具段
 * （否则下一次请求会被 SDK 拒绝）：参数还没收全的丢掉；有参数、没结果的改成以
 * 「工具调用未完成」结束。其余段原样
 */
export function settleToolParts(parts: Part[]): Part[] {
  return parts.flatMap((part): Part[] => {
    if (!isToolUIPart(part) || hasResult(part)) return [part];
    if (part.state === 'input-streaming') return [];
    const settled: Record<string, unknown> = {
      ...part,
      state: 'output-error',
      errorText: unfinishedToolCall,
    };
    delete settled.approval;
    delete settled.output;
    delete settled.preliminary;
    return [settled as Part];
  });
}

/**
 * 以后的回复（和摘要）里怎么看到历史里的工具调用（ADR-0006）：按工具的 history 声明改写
 * 结果的副本，存储不变。按段的类型找装上的工具，找不到的（清单里删掉了、这次没装上）、
 * 没声明的都截短到 maxChars。错误说明也按 maxChars 截短。
 * 只由存下来的内容、声明与上限决定：同一条消息每次送模型都一样，前缀缓存照常命中。
 * 当次回复循环里的各步由 SDK 带着完整结果，不经过这里。
 * 带图片的结果：文字部分照上面处理，图片照样保留（发出时与当次回复一样以图片交给模型）；
 * 声明不保留（omit）时连同图片一起省略。消息 metadata 里标记为无法读取的图片换成「[图片无法读取]」。
 * 呈现函数出错时按默认处理；同一个调用（toolCallId）只报告一次，免得每次送模型都记日志
 */
export function toolHistory(
  tools: readonly InstalledTool[],
  maxChars: number,
): (message: Message, onRenderError: (tool: string, error: unknown) => void) => Message {
  const declared = new Map(tools.map(({ definition }) => [definition.name, definition.history]));
  const reported = new Set<string>();
  return (message, onRenderError) => {
    if (message.role !== 'assistant') return message;
    return {
      ...message,
      parts: settleToolParts(message.parts).map((part): Part => {
        if (!isToolUIPart(part)) return part;
        if (part.state === 'output-error') {
          return { ...part, errorText: capText(part.errorText, maxChars) };
        }
        if (part.state !== 'output-available') return part;
        const name = getToolName(part);
        const render = (output: unknown, history: ToolHistory | undefined): unknown => {
          if (history === undefined) return cap(output, maxChars);
          if (history === 'full') return output;
          if (history === 'omit') return omitted;
          if (typeof history === 'object') return cap(output, history.maxChars);
          // 自定义的呈现函数：抛错或返回值转不了 JSON 时按默认处理
          try {
            const value = history({ input: part.input, output });
            if (JSON.stringify(value) === undefined) {
              throw new TypeError('呈现函数的返回值不能转成 JSON');
            }
            return value;
          } catch (error) {
            if (!reported.has(part.toolCallId)) {
              reported.add(part.toolCallId);
              onRenderError(name, error);
            }
            return render(output, undefined);
          }
        };
        const history = declared.get(name);
        if (!isStoredToolContent(part.output)) {
          return { ...part, output: render(part.output, history) };
        }
        if (history === 'omit') return { ...part, output: omitted };
        const text = toolContentText(part.output);
        const unreadable = new Set(message.metadata?.unreadableFiles);
        const output: StoredToolContent = {
          type: 'luoli-content',
          parts: [
            ...(text === ''
              ? []
              : [{ type: 'text' as const, text: asText(render(text, history)) }]),
            ...toolContentImages(part.output).map((image) =>
              unreadable.has(image.url) ? { type: 'text' as const, text: unreadableImage } : image,
            ),
          ],
        };
        return { ...part, output };
      }),
    };
  };
}

/**
 * 结果交给模型的文字（字符串原样，其他转成 JSON，与 tool.end 的 resultLength 一致）超过 maxChars
 * 时截短成字符串，注明原文长度；没超过时原样
 */
function cap(output: unknown, maxChars: number): unknown {
  const text = typeof output === 'string' ? output : (JSON.stringify(output) ?? 'null');
  return text.length > maxChars ? truncate(text, maxChars) : output;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : (JSON.stringify(value) ?? 'null');
}

function capText(text: string, maxChars: number): string {
  return text.length > maxChars ? truncate(text, maxChars) : text;
}

/** 截成前 maxChars 个字符（UTF-16 码元）并注明原文长度；不切开代理对：切点落在中间时往前退一位 */
function truncate(text: string, maxChars: number): string {
  const code = text.charCodeAt(maxChars - 1);
  const end = code >= 0xd800 && code <= 0xdbff ? maxChars - 1 : maxChars;
  return `${text.slice(0, end)}${truncatedNote(text.length)}`;
}
