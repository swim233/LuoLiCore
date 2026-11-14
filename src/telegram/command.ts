import type { TelegramRaw } from './message.js';
import type { BotIdentity } from './trigger.js';

/** Telegram 里的两条指令：compact 是手动压缩，clear 是清空上下文 */
export type TelegramCommand = 'compact' | 'clear';

// 整条文字就是指令，可以紧跟 @用户名（Telegram 的用户名是字母、数字、下划线）
const pattern = /^\/(compact|clear)(?:@([A-Za-z0-9_]+))?$/i;

/**
 * 一条消息是不是指令：有发送者的文字消息，整条文字去掉前后空白后不分大小写等于 `/compact`、
 * `/clear`，或者后面紧跟本 bot 的 `@用户名`（不分大小写）。带了别的 bot 的用户名、或者还不知道
 * 自己的用户名（getMe 还没成功过）时不算。后面跟了字的、写在图片说明里的、相册、别的 `/` 开头的
 * （`/start` 等）都不是，照普通消息处理。群里不带 @ 的也算
 */
export function parseCommand(raw: TelegramRaw, bot: BotIdentity): TelegramCommand | undefined {
  if (!raw.from || raw.text === undefined || raw.media_group_id !== undefined) return undefined;
  const match = pattern.exec(raw.text.trim());
  if (!match) return undefined;
  const [, name, username] = match as unknown as [string, string, string | undefined];
  if (username !== undefined && username.toLowerCase() !== bot.username?.toLowerCase()) {
    return undefined;
  }
  return name.toLowerCase() as TelegramCommand;
}
