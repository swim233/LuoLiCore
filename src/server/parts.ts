import { isStoredToolContent, type StoredImage } from '../core/index.js';

// 读存下来的消息段：消息是核心写的，形状本来就对；这里仍不完全信它，缺字段、类型不对的跳过

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** 工具调用段：type 为 tool-<工具名>，或 dynamic-tool（与 ai 的 isToolUIPart 相同，但不怕缺字段） */
export function isToolPart(part: Record<string, unknown>): boolean {
  return (
    typeof part.type === 'string' && (part.type.startsWith('tool-') || part.type === 'dynamic-tool')
  );
}

/** 工具调用段的工具名 */
export function toolNameOf(part: Record<string, unknown>): string {
  if (part.type === 'dynamic-tool') return typeof part.toolName === 'string' ? part.toolName : '';
  return String(part.type).slice('tool-'.length);
}

/** 带图片的工具结果的文字（同 core 的 toolContentText），不是对象、没有文字的段跳过 */
export function contentText(output: unknown): string {
  if (!isStoredToolContent(output)) return '';
  return (output.parts as unknown[])
    .flatMap((part) =>
      isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? [part.text] : [],
    )
    .join('\n');
}

/** 带图片的工具结果里的图片（同 core 的 toolContentImages），没有地址的跳过 */
export function contentImages(output: unknown): StoredImage[] {
  if (!isStoredToolContent(output)) return [];
  return (output.parts as unknown[]).filter(
    (part): part is StoredImage =>
      isRecord(part) && part.type === 'image' && typeof part.url === 'string',
  );
}
