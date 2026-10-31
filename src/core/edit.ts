import type { Message } from './message.js';
import type { ConversationStore } from './storage/types.js';

/**
 * 平台上编辑了一条消息：按平台消息 id 找到它，正文换成 text，图片等其他部分不变，
 * metadata 记下编辑时间。与 append 一样：有图片时空文字省略，没有图片时保留一个文字部分。
 * 找不到时返回 undefined。
 * 改的是历史本身，之后的请求从这条起前缀变了（ADR-0004 接受的代价）
 */
export async function editMessage(
  store: ConversationStore,
  {
    platformMessageId,
    text,
    editedAt,
  }: { platformMessageId: string; text: string; editedAt: string },
): Promise<Message | undefined> {
  const message = await store.findByPlatformMessageId(platformMessageId);
  if (!message) return undefined;
  const others = message.parts.filter((part) => part.type !== 'text');
  const edited: Message = {
    ...message,
    metadata: message.metadata && { ...message.metadata, editedAt },
    parts: [...(text || others.length === 0 ? [{ type: 'text' as const, text }] : []), ...others],
  };
  await store.update(edited);
  return edited;
}
