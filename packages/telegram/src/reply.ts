import type { Message } from "grammy/types";
import type { ArchivedMessage, ScopedArchiveRepository } from "@luoli/db";

/** `TelegramMedia.process` 的最小接口，测试中可替换为不发起网络请求的实现。 */
export interface MediaProcessor {
  process(
    payload: Record<string, unknown>,
    row: ArchivedMessage,
  ): Promise<unknown[]>;
}

export function messageKind(message: Record<string, unknown>): string {
  const ordered = [
    "text",
    "photo",
    "document",
    "voice",
    "video",
    "video_note",
    "sticker",
    "animation",
    "audio",
    "location",
    "poll",
  ];
  return ordered.find((key) => key in message) ?? "other";
}

export function displayName(from: Message["from"]): string | null {
  return from
    ? [from.first_name, from.last_name].filter(Boolean).join(" ") ||
        (from.username ? `@${from.username}` : null)
    : null;
}

/**
 * 挂载媒体是幂等的补写：归档行已经落库，本步骤只补充 parts。调用方据此把它放在按 chat 串行的入口锁
 * 之外：它会调用 pdf-parse / mammoth / sharp 解析用户上传的文件，放在锁内会导致一个畸形 PDF 就能让
 * 该会话此后的每条消息都无法归档（docs/27 · R-01）。
 */
export async function attachMedia(
  media: MediaProcessor,
  scoped: ScopedArchiveRepository,
  payload: Message,
  row: ArchivedMessage,
): Promise<void> {
  if (row.mediaParts?.length) return;
  const parts = await media.process(
    payload as unknown as Record<string, unknown>,
    row,
  );
  if (!parts.length) return;
  row.mediaParts = parts;
  scoped.attachMedia(row.id, parts);
}

/**
 * 取出被回复的那条消息，必要时现场归档 + 下载它的媒体。
 *
 * 此前该链路不存在：用户回复一张图片唤醒 bot 时，模型只能看到文字部分。图片既不在上下文窗口内，
 * 也不会被背景认领（`claimBackground` 只覆盖水位到触发消息之间的区间），而在
 * `access.defaultUserRole=blocked` 的群里它根本没有进过归档。关键前提是 Telegram 的 update 自带被回复
 * 消息的完整副本（含 file_id），因此「库中没有」不等于「无法获取」（docs/08 §7.4）。
 */
export async function resolveQuotedMessage(
  dependencies: { media: MediaProcessor; botId: number },
  scoped: ScopedArchiveRepository,
  message: Message,
  trigger: ArchivedMessage,
): Promise<ArchivedMessage | null> {
  const found = archiveQuotedMessage(
    dependencies.botId,
    scoped,
    message,
    trigger,
  );
  if (!found) return null;
  await attachMedia(dependencies.media, scoped, found.payload, found.row);
  return found.row;
}

/**
 * 上述流程的同步部分：归档行落库（含把被回复者的名字挂到触发消息上），不下载媒体。
 * 拆分的唯一原因是：归档顺序必须在入口锁内（`messages.id` 顺序即上下文顺序），而下载与解析必须在锁外
 * （docs/27 · R-01）。`resolveQuotedMessage` 是两部分的组合，两条路径共用同一实现。
 */
export function archiveQuotedMessage(
  botId: number,
  scoped: ScopedArchiveRepository,
  message: Message,
  trigger: ArchivedMessage,
): { row: ArchivedMessage; payload: Message } | null {
  const replied = message.reply_to_message;
  // 跨会话引用（关联频道、external_reply）不属于当前 context key，引入只会污染上下文。
  if (!replied || replied.chat.id !== message.chat.id) return null;
  const repliedName = displayName(replied.from);
  if (repliedName) trigger.replyToName = repliedName;
  const isBot = replied.from?.id === botId;
  const row =
    scoped.byTgMessageId(replied.message_id) ??
    scoped.append({
      chatId: String(replied.chat.id),
      messageThreadId: replied.message_thread_id ?? null,
      tgMessageId: replied.message_id,
      tgUpdateId: null,
      direction: isBot ? "out" : "in",
      fromKind: isBot ? "bot" : "user",
      fromUserId: replied.from ? String(replied.from.id) : null,
      fromName: repliedName,
      fromUsername: replied.from?.username ?? null,
      kind: messageKind(replied as unknown as Record<string, unknown>),
      text: replied.text ?? replied.caption ?? null,
      // Telegram 只展开一层 reply_to_message，无法得知被回复消息自身回复了谁。
      replyToTgMessageId: null,
      mediaGroupId: replied.media_group_id ?? null,
      tgDate: replied.date * 1000,
      raw: replied,
      triggered: false,
      triggerReason: null,
      // 本轮已将其送入上下文；不标记为已消费时，下一轮 claimBackground 会把它当作新的背景消息重复认领。
      claimed: true,
    });
  return { row, payload: replied };
}
