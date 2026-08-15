import type { Context } from 'grammy';
import { WAKEWORD_SCAN_LIMIT, checkWakeword } from '@luoli/core';

export type TriggerReason = 'private' | 'mention' | 'reply' | 'command' | 'wakeword';

export interface TriggerConfig {
  private: boolean;
  mention: boolean;
  reply: boolean;
  command: boolean;
  channels: boolean;
  wakewords: string[];
  wakewordMinLength: number;
  requireTextAfterMention: boolean;
  strictCommandSuffix?: boolean;
}
export function matchTrigger(ctx: Context, config: TriggerConfig, botId: number, botUsername: string): TriggerReason | null {
  const chat = ctx.chat;
  const message = ctx.message;
  if (!chat || !message) return null;
  if (chat.type === 'private') return config.private ? 'private' : null;
  if (chat.type === 'channel' && !config.channels) return null;
  const text = message.text ?? message.caption ?? '';
  const entities = message.entities ?? message.caption_entities ?? [];
  if (config.mention) {
    for (const entity of entities) {
      if (entity.type === 'mention' && text.slice(entity.offset, entity.offset + entity.length).toLocaleLowerCase() === `@${botUsername.toLocaleLowerCase()}`) {
        if (!config.requireTextAfterMention || text.replace(text.slice(entity.offset, entity.offset + entity.length), '').trim()) return 'mention';
      }
      if (entity.type === 'text_mention' && entity.user.id === botId) return 'mention';
    }
  }
  if (config.reply && message.reply_to_message?.from?.id === botId) return 'reply';
  if (config.command) {
    const command = entities.find((entity) => entity.type === 'bot_command' && entity.offset === 0);
    if (command) {
      const token = text.slice(0, command.length).toLocaleLowerCase();
      const [name, suffix] = token.slice(1).split('@');
      // 判成 command 的消息在 bot.on('message') 里被丢弃，只剩各自的 handler 能回话。名字列在这里
      // 却没注册 handler，用户发出去就石沉大海——/wake（会话唤醒词管理）因此摘除，改在 WebUI 配。
      const ours = new Set(['start', 'help', 'ask', 'new', 'undo', 'ctx', 'cancel', 'tasks', 'model', 'memory', 'forgetme', 'whoami', 'whois', 'grant', 'revoke', 'usage', 'webui', 'ping']);
      if (name && ours.has(name) && (suffix === undefined ? !config.strictCommandSuffix : suffix === botUsername.toLocaleLowerCase())) return 'command';
    }
  }
  for (const wakeword of config.wakewords) {
    const checked = checkWakeword(wakeword, config.wakewordMinLength);
    if (!checked.ok) continue;
    if (checked.kind === 'regex') { if (checked.regex.test(text.slice(0, WAKEWORD_SCAN_LIMIT))) return 'wakeword'; }
    else if (text.includes(wakeword)) return 'wakeword';
  }
  return null;
}
