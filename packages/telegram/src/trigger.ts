import type { Context } from 'grammy';

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
function safeWakeRegex(source: string): RegExp | null {
  if ([...source].length > 128 || /\\[1-9]|\(\?[=!<]|(\([^)]*[+*][^)]*\))[+*]|\{\d+,\d*\}\s*[+*{]/.test(source)) return null;
  try { return new RegExp(source, 'u'); } catch { return null; }
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
      const ours = new Set(['start', 'help', 'ask', 'new', 'undo', 'ctx', 'cancel', 'tasks', 'model', 'memory', 'forgetme', 'whoami', 'whois', 'grant', 'revoke', 'wake', 'usage', 'webui', 'ping']);
      if (name && ours.has(name) && (suffix === undefined ? !config.strictCommandSuffix : suffix === botUsername.toLocaleLowerCase())) return 'command';
    }
  }
  for (const wakeword of config.wakewords.filter((value) => [...value.replace(/^\^/, '')].length >= config.wakewordMinLength)) {
    if (wakeword.startsWith('^')) {
      const regex = safeWakeRegex(wakeword);
      if (regex?.test(text.slice(0, 4096))) return 'wakeword';
    } else if (text.includes(wakeword)) return 'wakeword';
  }
  return null;
}
