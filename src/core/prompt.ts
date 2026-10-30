import type { Message } from './message.js';
import type { Segment } from './storage/types.js';

/**
 * 一段的 system：人设、格式说明、当前会话、之前的对话摘要，依次用空行隔开。
 * 越稳定的越靠前（ADR-0004）；后两节一段之内不变，没有内容时整节省略
 */
export function systemPrompt(instructions: string, segment: Segment): string {
  const sections = [instructions, messageFormatNote];
  if (segment.conversationTitle) {
    sections.push(`## 当前会话\n\n名称：${segment.conversationTitle}`);
  }
  if (segment.priorSummary) {
    sections.push(
      `## 之前的对话摘要\n\n以下是本会话更早内容的摘要，原文已不在上下文中。\n\n${segment.priorSummary}`,
    );
  }
  return sections.join('\n\n');
}

/** 摘要请求末尾追加的指令。scope 说明这次要摘要哪些消息，maxChars 是字数上限 */
export function summaryInstruction(scope: string, maxChars: number): string {
  return `（以下是系统指令，不是会话成员的消息）

现在暂停对话。请为以上内容写一份摘要，供你之后继续参与这个会话时参考。这份摘要会替代原文：之后你只能看到摘要，以及摘要之后的新消息。

摘要范围：
- 「之前的对话摘要」里的全部内容（如果有）；
- ${scope}

写法：
- 用中性的第三人称客观记录，不用你的角色口吻，不写感想或评价。
- 提到人时写显示名，第一次出现时附上 uid，如「小明（uid 123456）」；没有 uid 的只写名字。改过名的注明「原名 某某」。
- 只记事实，不推测；不确定的不写。
- 保留以后可能用得上的信息：
  1. 每个人的身份、关系、偏好、习惯，以及透露过的个人信息（如宠物、工作、计划）；
  2. 正在进行或悬而未决的话题、问题、约定、待办，以及由谁负责；
  3. 大家对你提出的要求或纠正（如称呼、说话方式、不要做的事）；
  4. 重要的结论、决定，以及数字、日期、链接等具体信息；
  5. 图片中与对话有关的内容，用文字描述。
- 闲聊、寒暄、重复的内容省略，或一笔带过。
- 与之前的摘要合并：新信息与旧信息冲突时以新的为准；仍然有效的旧信息保留，过时的删去。
- 按主题分组，用简短的条目；需要时注明大致时间，如「10 月 30 日晚」。
- 总长度不超过 ${maxChars} 字。

只输出摘要正文，不要标题、开场白或结束语。`;
}

// 送模型的用户消息格式。改格式或加字段时，同步修改下面的 messageFormatNote
const messageFormatNote = `## 消息格式

每条用户消息都包在 <message> 标签里，标签属性由平台提供：
- from：发言人当时的显示名，称呼对方时用它。
- uid：发言人不变的 id，有时没有。uid 相同就是同一个人，即使 from 不同（改过名）；from 相同而 uid 不同是两个人。没有 uid 时按 from 区分。
- time：消息发出的时间。最后一条消息的 time 可以当作现在的时间。
- 标签之间的图片是这条消息附带的。
你之前的回复若以「（回复被中止）」结尾，表示那条回复被用户中途打断，没有说完。
回复时只写正文，不要输出 <message> 标签或「（回复被中止）」，也不要在开头加自己的名字。`;

/**
 * 送模型前的格式化，只改送给模型的副本，存储里的消息不变：
 * 用户消息包成 `<message from="名字" uid="id" time="时间">…</message>`，带图片时图片在标签之间；被中止的助手回复末尾加「（回复被中止）」；
 * 其他消息原样返回。
 */
export function formatForModel(message: Message): Message {
  if (message.role === 'assistant') return markAborted(message);
  if (message.role !== 'user') return message;
  const texts = message.parts.flatMap((part) => (part.type === 'text' ? [part.text] : []));
  const files = message.parts.filter((part) => part.type === 'file');
  if (texts.length === 0 && files.length === 0) return message;

  // 标签属性，按顺序输出，值为 undefined 的不输出。以后加字段（回复对象等）在这里加一项
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

function markAborted(message: Message): Message {
  if (!message.metadata?.aborted) return message;
  const lastText = message.parts.findLastIndex((part) => part.type === 'text');
  if (lastText === -1) return message;
  return {
    ...message,
    parts: message.parts.map((part, index) =>
      index === lastText && part.type === 'text'
        ? { ...part, text: `${part.text}\n（回复被中止）` }
        : part,
    ),
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
