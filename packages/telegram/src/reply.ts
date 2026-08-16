import type { Message } from 'grammy/types';
import type { ArchivedMessage, ScopedArchiveRepository } from '@luoli/db';

/** `TelegramMedia.process` 的最小形状，测试里可以换成不出网的替身。 */
export interface MediaProcessor {
  process(payload: Record<string, unknown>, row: ArchivedMessage): Promise<unknown[]>;
}

export function messageKind(message: Record<string, unknown>): string {
  const ordered = ['text', 'photo', 'document', 'voice', 'video', 'video_note', 'sticker', 'animation', 'audio', 'location', 'poll'];
  return ordered.find((key) => key in message) ?? 'other';
}

export function displayName(from: Message['from']): string | null {
  return from ? [from.first_name, from.last_name].filter(Boolean).join(' ') || (from.username ? `@${from.username}` : null) : null;
}

export async function attachMedia(media: MediaProcessor, scoped: ScopedArchiveRepository, payload: Message, row: ArchivedMessage): Promise<void> {
  if (row.mediaParts?.length) return;
  const parts = await media.process(payload as unknown as Record<string, unknown>, row);
  if (!parts.length) return;
  row.mediaParts = parts;
  scoped.attachMedia(row.id, parts);
}

/**
 * 取出被回复的那条消息，必要时现场归档 + 下载它的媒体。
 *
 * 这条链路以前根本不存在：回复一张图唤醒 bot，模型看到的只有「这张图描述了什么」几个字 ——
 * 图既不在上下文窗口里，也不会被背景认领（`claimBackground` 只覆盖水位到触发消息之间那一段），
 * 而在 `access.defaultUserRole=blocked` 的群里它压根没进过归档。关键事实是 Telegram 的 update
 * **自带被回复消息的完整副本**（含 file_id），所以「库里没有」不等于「拿不到」（docs/08 §7.4）。
 */
export async function resolveQuotedMessage(
  dependencies: { media: MediaProcessor; botId: number },
  scoped: ScopedArchiveRepository,
  message: Message,
  trigger: ArchivedMessage,
): Promise<ArchivedMessage | null> {
  const replied = message.reply_to_message;
  // 跨会话引用（关联频道、external_reply）不属于这个 context key，拉进来只会污染上下文。
  if (!replied || replied.chat.id !== message.chat.id) return null;
  const repliedName = displayName(replied.from);
  if (repliedName) trigger.replyToName = repliedName;
  const isBot = replied.from?.id === dependencies.botId;
  const row = scoped.byTgMessageId(replied.message_id) ?? scoped.append({
    chatId: String(replied.chat.id), messageThreadId: replied.message_thread_id ?? null, tgMessageId: replied.message_id,
    tgUpdateId: null, direction: isBot ? 'out' : 'in', fromKind: isBot ? 'bot' : 'user',
    fromUserId: replied.from ? String(replied.from.id) : null, fromName: repliedName, fromUsername: replied.from?.username ?? null,
    kind: messageKind(replied as unknown as Record<string, unknown>), text: replied.text ?? replied.caption ?? null,
    // Telegram 只展开一层 reply_to_message，被回复消息自己回复了谁这里拿不到。
    replyToTgMessageId: null, mediaGroupId: replied.media_group_id ?? null,
    tgDate: replied.date * 1000, raw: replied, triggered: false, triggerReason: null,
    // 本轮就把它送进上下文了；不标成已消费的话，下一轮 claimBackground 会把它当新的背景发言再认领一次。
    claimed: true,
  });
  await attachMedia(dependencies.media, scoped, replied, row);
  return row;
}
