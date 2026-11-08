import { getToolName, isToolUIPart } from 'ai';
import type { ImagePart, MsgRow, Part } from './types';

/* 读 UI 消息里的段：文字、思考、图片、工具调用。不认识的段（step-start、data-* 等）调用方忽略就行 */

export type TextPart = Extract<Part, { type: 'text' }>;
export type ReasoningPart = Extract<Part, { type: 'reasoning' }>;
export type FilePart = Extract<Part, { type: 'file' }>;
/** 工具调用的段（type 是 tool-<工具名>，或 dynamic-tool） */
export type ToolPart = Extract<Part, { toolCallId: string }>;

export const isText = (p: Part): p is TextPart => p.type === 'text';
export const isReasoning = (p: Part): p is ReasoningPart => p.type === 'reasoning';
export const isFile = (p: Part): p is FilePart => p.type === 'file';
export const isTool = (p: Part): p is ToolPart => isToolUIPart(p as never);
export const toolName = (p: ToolPart): string => getToolName(p as never);

/** 消息里的文字（各段连起来） */
export function textOf(row: MsgRow): string {
  return row.message.parts
    .filter(isText)
    .map((p) => p.text)
    .join('');
}

/** 消息作者：用户消息有，助手消息没有 */
export const authorOf = (row: MsgRow) => row.message.metadata?.author;

/** 工具的输入压成一行：只有一个字符串参数时就是它（如网址），否则是 JSON 的开头 */
export function inputLine(input: unknown, max = 80): string {
  let s: string;
  if (typeof input === 'string') s = input;
  else if (input && typeof input === 'object') {
    const vals = Object.values(input);
    s = vals.length === 1 && typeof vals[0] === 'string' ? vals[0] : (JSON.stringify(input) ?? '');
  } else s = input === undefined ? '' : String(input);
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/** 工具结果里的文字与图片：字符串、带图片的 luoli-content、其他能转成 JSON 的值 */
export function toolOutput(output: unknown): {
  text: string;
  images: { url: string; mediaType?: string }[];
} {
  if (typeof output === 'string') return { text: output, images: [] };
  if (
    output &&
    typeof output === 'object' &&
    (output as { type?: unknown }).type === 'luoli-content'
  ) {
    const parts = (output as { parts?: unknown }).parts;
    const text: string[] = [];
    const images: { url: string; mediaType?: string }[] = [];
    if (Array.isArray(parts))
      for (const p of parts as Record<string, unknown>[]) {
        if (p.type === 'text' && typeof p.text === 'string') text.push(p.text);
        else if (p.type === 'image' && typeof p.url === 'string')
          images.push({
            url: p.url,
            mediaType: typeof p.mediaType === 'string' ? p.mediaType : undefined,
          });
      }
    return { text: text.join('\n'), images };
  }
  if (output === undefined) return { text: '', images: [] };
  return { text: JSON.stringify(output, null, 2) ?? '', images: [] };
}

/* 模拟数据里挂在 part 上的演示字段：「此刻」「对话」还在读它们（思考秒数、工具耗时、一句话摘要、工具结果里的图）。
   真实数据没有；第 5、6 步换成真实来源后删 */
export interface Demo {
  sec?: number;
  ms?: number;
  summary?: string;
  image?: ImagePart | null;
}
export const demoOf = (p: unknown): Demo | undefined => (p as { demo?: Demo } | null)?.demo;
/** 给 part 挂上演示字段（模拟数据用） */
export const withDemo = <P extends Part>(p: P, demo: Demo): P => Object.assign(p, { demo });
