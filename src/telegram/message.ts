import type { TelegramChat, TelegramMessage, TelegramUser } from '@chat-adapter/telegram';

/**
 * Telegram 原始消息。改群名的服务消息带 new_chat_title（适配器的类型里没有这一项）。
 * rich_message 的类型是适配器的，比文档旧；读它的 rich-received.ts 不靠这个类型，每一处都先看
 */
export type TelegramRaw = TelegramMessage & { new_chat_title?: string };

/** 显示名：名 + 空格 + 姓，没有姓时只有名 */
export function displayName(user: Pick<TelegramUser, 'first_name' | 'last_name'>): string {
  return [user.first_name, user.last_name].filter(Boolean).join(' ');
}

/** 会话标题：群为群名；私聊为「与 {显示名} 的私聊」 */
export function conversationTitle(chat: TelegramChat): string | undefined {
  if (chat.type !== 'private') return chat.title;
  return `与 ${displayName({ first_name: chat.first_name ?? '', last_name: chat.last_name })} 的私聊`;
}

/**
 * 白名单，只有 chat id 时（如任务到点，手里只有存下的会话）：私聊的 chat id 是正数，就是对方的
 * 用户 id，看用户；群（负数）看 chat id
 */
export function isAllowedChat(
  chatId: string,
  { chats, users }: { chats: ReadonlySet<string>; users: ReadonlySet<string> },
): boolean {
  return Number(chatId) > 0 ? users.has(chatId) : chats.has(chatId);
}

/** 白名单：群看 chat id，私聊看发送者 id；频道不工作 */
export function isAllowed(
  raw: TelegramRaw,
  { chats, users }: { chats: ReadonlySet<string>; users: ReadonlySet<string> },
): boolean {
  if (raw.chat.type === 'private') return raw.from !== undefined && users.has(String(raw.from.id));
  if (raw.chat.type === 'group' || raw.chat.type === 'supergroup') {
    return chats.has(String(raw.chat.id));
  }
  return false;
}
