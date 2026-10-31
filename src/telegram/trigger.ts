import type { TelegramRaw } from './message.js';

/** bot 自己的身份；启动时由 getMe 得到，拿到之前为空 */
export type BotIdentity = { id?: string; username?: string };

/**
 * 是否触发回复：私聊；@bot；回复 bot 的消息；文字里含唤醒词（不分大小写）。
 * 图片等消息的说明文字与文字一样看待
 */
export function isTriggered(
  raw: TelegramRaw,
  { bot, wakeWords }: { bot: BotIdentity; wakeWords: string[] },
): boolean {
  if (raw.chat.type === 'private') return true;
  return (
    mentionsBot(raw, bot) ||
    repliesToBot(raw, bot) ||
    hasWakeWord(raw.text ?? raw.caption, wakeWords)
  );
}

function mentionsBot(raw: TelegramRaw, bot: BotIdentity): boolean {
  const text = raw.text ?? raw.caption ?? '';
  // 没有用户名的人被提到时是 text_mention，带着用户对象
  const byEntity = (raw.entities ?? raw.caption_entities ?? []).some(
    (entity) => entity.type === 'text_mention' && bot.id && String(entity.user?.id) === bot.id,
  );
  if (byEntity) return true;
  if (!bot.username) return false;
  // @用户名，后面不能紧跟用户名里能出现的字符（@nori_bot 不算 @nori）
  const escaped = bot.username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`@${escaped}(?![A-Za-z0-9_])`, 'i').test(text);
}

function repliesToBot(raw: TelegramRaw, bot: BotIdentity): boolean {
  const replied = raw.reply_to_message;
  if (!replied?.from || !bot.id || String(replied.from.id) !== bot.id) return false;
  // 论坛话题里的每条消息都「回复」话题的第一条，那不算回复 bot
  return !(raw.is_topic_message && replied.message_id === raw.message_thread_id);
}

function hasWakeWord(text: string | undefined, wakeWords: string[]): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return wakeWords.some((word) => lower.includes(word));
}
