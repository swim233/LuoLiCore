import { isToolUIPart } from 'ai';
import type { Message } from './message.js';
import { fill, type PromptTexts } from './prompt-files.js';
import type { Segment } from './storage/types.js';

/**
 * 一段的 system：人设、格式说明、当前会话、之前的对话摘要，依次用空行隔开。
 * 越稳定的越靠前（ADR-0004）；后两节一段之内不变，没有内容时整节省略。
 * 各节的文字来自这次读到的提示词文件
 */
export function systemPrompt(texts: PromptTexts, segment: Segment): string {
  const sections = [texts.persona, texts.messageFormat];
  if (segment.conversationTitle) {
    sections.push(fill(texts.conversation, { title: segment.conversationTitle }));
  }
  if (segment.priorSummary) {
    sections.push(fill(texts.priorSummary, { summary: segment.priorSummary }));
  }
  return sections.join('\n\n');
}

/**
 * 这次摘要哪些消息：空闲切段是本段全部；压缩时是 time 早于某一分钟的消息，
 * 或（保留部分里没有带时间的用户消息时）除最后 keep 条之外的
 */
export type SummaryScope =
  { kind: 'idle' } | { kind: 'before'; time: string } | { kind: 'recent'; keep: number };

/** 摘要请求末尾追加的指令。scope 说明这次要摘要哪些消息，maxChars 是字数上限 */
export function summaryInstruction(
  texts: PromptTexts,
  scope: SummaryScope,
  maxChars: number,
): string {
  const scopeText =
    scope.kind === 'idle'
      ? texts.scopeIdle
      : scope.kind === 'before'
        ? fill(texts.scopeBefore, { time: scope.time })
        : fill(texts.scopeRecent, { keep: String(scope.keep) });
  return fill(texts.summary, { scope: scopeText, maxChars: String(maxChars) });
}

/**
 * 送模型前的格式化，只改送给模型的副本，存储里的消息不变：
 * 用户消息包成 `<message from="名字" uid="id" time="时间">…</message>`，带图片时图片在标签之间；
 * 被中止的助手回复末尾加「（回复被中止）」，出错中断的加「（回复出错中断）」；其他消息原样返回。
 */
export function formatForModel(message: Message): Message {
  if (message.role === 'assistant') return markEnded(message);
  if (message.role !== 'user') return message;
  const texts = message.parts.flatMap((part) => (part.type === 'text' ? [part.text] : []));
  const files = message.parts.filter((part) => part.type === 'file');
  if (texts.length === 0 && files.length === 0) return message;

  // 标签属性，按顺序输出，值为 undefined 的不输出。以后加字段（回复对象等）在这里加一项，
  // 并在 prompts/message-format.md 里说明
  const attributes: Record<string, string | undefined> = {
    from: message.metadata?.author?.name,
    uid: message.metadata?.author?.id,
    time: formatTime(message.metadata?.createdAt),
  };
  const attributeText = Object.entries(attributes)
    .flatMap(([name, value]) =>
      value === undefined ? [] : [` ${name}="${escapeAttribute(value)}"`],
    )
    .join('');
  const open = `<message${attributeText}>`;
  const body = texts.length > 0 ? `\n${escapeBody(texts.join('\n'))}` : '';

  if (files.length === 0) {
    // 所有 text part 合成一个，放在第一个 text part 的位置；其他 part 原样保留
    const text = `${open}${body}\n</message>`;
    const firstText = message.parts.findIndex((part) => part.type === 'text');
    return {
      ...message,
      parts: message.parts.flatMap((part, index): Message['parts'] => {
        if (part.type !== 'text') return [part];
        return index === firstText ? [{ ...part, text }] : [];
      }),
    };
  }
  // 带图片：标签拆成两段，把图片包在中间。没有图片的消息仍是上面一个 text part，前缀不变
  return {
    ...message,
    parts: [
      { type: 'text', text: `${open}${body}` },
      ...message.parts.filter((part) => part.type !== 'text'),
      { type: 'text', text: '</message>' },
    ],
  };
}

/**
 * 中途结束的回复在送模型的内容最末加标记：最后一段是文字时接在它后面；最后是工具段时另起一步，
 * 模型看到的是工具结果之后的一条助手消息；其他（如推理）在末尾加一个文字段
 */
function markEnded(message: Message): Message {
  const marker = message.metadata?.aborted
    ? '（回复被中止）'
    : message.metadata?.failed
      ? '（回复出错中断）'
      : undefined;
  if (marker === undefined) return message;
  const last = message.parts.findLastIndex((part) => part.type !== 'step-start');
  const lastPart = message.parts[last];
  if (lastPart?.type === 'text') {
    return {
      ...message,
      parts: message.parts.map((part, index) =>
        index === last ? { ...lastPart, text: `${lastPart.text}\n${marker}` } : part,
      ),
    };
  }
  const markerPart = { type: 'text' as const, text: marker };
  return {
    ...message,
    parts:
      lastPart && isToolUIPart(lastPart)
        ? [...message.parts, { type: 'step-start' }, markerPart]
        : [...message.parts, markerPart],
  };
}

/** ISO 时间按进程所在时区格式化为 `YYYY-MM-DD HH:mm`；无法解析时不输出 */
export function formatTime(iso: string | undefined): string | undefined {
  if (iso === undefined) return undefined;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return undefined;
  const pad = (n: number) => String(n).padStart(2, '0');
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

// 正文只处理会被当成标签的部分：<message、</message 开头的 <（不分大小写）。
// 代码里的 a < b、<div> 等保持原样
function escapeBody(text: string): string {
  return text.replace(/<(?=\/?message)/gi, '&lt;');
}
