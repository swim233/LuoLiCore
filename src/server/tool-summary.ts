import { isStoredToolContent, type InstalledTool } from '../core/index.js';
import { contentText } from './parts.js';

/** 摘要最多这么多个字符 */
export const summaryChars = 200;

/**
 * 工具调用给界面看的一句话：按工具名找到定义里的摘要函数（defineTool 的 summary），交给它参数与
 * 结果（还没有结果、出错时不给；带图片的结果只给文字部分，与 history 一样）。没写摘要、摘要函数
 * 出错、返回的不是非空的字符串，都当作没写（undefined）：界面显示工具名加参数的前一截。
 * 换行压成空格，最多 summaryChars 个字符
 */
export type Summarize = (name: string, input: unknown, output?: unknown) => string | undefined;

export function toolSummaries(tools: readonly InstalledTool[]): Summarize {
  const byName = new Map(
    tools.flatMap(({ definition }) =>
      definition.summary ? [[definition.name, definition.summary] as const] : [],
    ),
  );
  return (name, input, output) => {
    const summary = byName.get(name);
    if (!summary) return undefined;
    let text: unknown;
    try {
      text = summary({
        input,
        ...(output === undefined
          ? {}
          : { output: isStoredToolContent(output) ? contentText(output) : output }),
      });
    } catch {
      return undefined;
    }
    if (typeof text !== 'string') return undefined;
    const line = text.replace(/\s+/g, ' ').trim();
    if (!line) return undefined;
    const chars = [...line];
    return chars.length <= summaryChars ? line : `${chars.slice(0, summaryChars - 1).join('')}…`;
  };
}

/** 没有装工具时：都没有摘要 */
export const noSummaries: Summarize = () => undefined;
