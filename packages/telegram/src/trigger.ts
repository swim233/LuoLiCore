import type { Context } from 'grammy';
import { WAKEWORD_SCAN_LIMIT, checkWakeword } from '@luoli/core';

export type TriggerReason = 'private' | 'mention' | 'reply' | 'command' | 'wakeword' | 'ask';

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

/**
 * 已注册 handler 的命令名。判成 `command` 的消息不进 AI 流程，只剩各自的 handler 能回话——
 * 名字列在这里却没有 handler，用户发出去就石沉大海（`/start` 曾经就是这样，docs/20 · W-TG-01）。
 * `tests/trigger.test.ts` 断言这个集合与 `bot.ts` 里 `bot.command(...)` 注册的名字一一对应。
 * 例外只有 `/ask`：它按 doc 08 §8 等价于 @bot，走 AI 流程而不是 handler，所以不在这里。
 * `/webui`（一次性登录链接）与 `/wake`（会话唤醒词）已摘除，改在 WebUI 做（docs/08 §8 🚧）。
 */
export const HANDLED_COMMANDS: ReadonlySet<string> = new Set([
  'start', 'help', 'new', 'undo', 'ctx', 'cancel', 'tasks', 'model', 'memory', 'forgetme', 'whoami', 'whois', 'grant', 'revoke', 'usage', 'ping',
]);

/** offset 0 的 `bot_command` 实体解析出的命令名（小写、去掉 `@suffix`）。不是命令、或后缀不匹配时返回 null。 */
export function commandNameOf(text: string, entities: ReadonlyArray<{ type: string; offset: number; length: number }>, botUsername: string, strictSuffix = false): string | null {
  const command = entities.find((entity) => entity.type === 'bot_command' && entity.offset === 0);
  if (!command) return null;
  const [name, suffix] = text.slice(0, command.length).toLocaleLowerCase().slice(1).split('@');
  if (!name) return null;
  return (suffix === undefined ? !strictSuffix : suffix === botUsername.toLocaleLowerCase()) ? name : null;
}

export function matchTrigger(ctx: Context, config: TriggerConfig, botId: number, botUsername: string): TriggerReason | null {
  const chat = ctx.chat;
  const message = ctx.message;
  if (!chat || !message) return null;
  if (chat.type === 'channel' && !config.channels) return null;
  const text = message.text ?? message.caption ?? '';
  const entities = message.entities ?? message.caption_entities ?? [];
  // 命令必须先判，私聊分支在它前面的话 `/new` 会被当成普通对话：既开一轮，又跑 handler。
  // 反过来，裸的 `/` 前缀不能一律当命令——私聊里一句「/home/app 这个目录满了」应当照常回答。
  const command = commandNameOf(text, entities, botUsername, config.strictCommandSuffix);
  if (command !== null) {
    // `/ask <text>`：doc 08 §8 明确它等价于 @bot，是唯一进 AI 流程的命令。
    if (config.command && command === 'ask') return 'ask';
    if (HANDLED_COMMANDS.has(command)) return config.command ? 'command' : null;
  }
  if (chat.type === 'private') return config.private ? 'private' : null;
  if (config.mention) {
    for (const entity of entities) {
      if (entity.type === 'mention' && text.slice(entity.offset, entity.offset + entity.length).toLocaleLowerCase() === `@${botUsername.toLocaleLowerCase()}`) {
        if (!config.requireTextAfterMention || text.replace(text.slice(entity.offset, entity.offset + entity.length), '').trim()) return 'mention';
      }
      if (entity.type === 'text_mention' && entity.user.id === botId) return 'mention';
    }
  }
  if (config.reply && message.reply_to_message?.from?.id === botId) return 'reply';
  for (const wakeword of config.wakewords) {
    const checked = checkWakeword(wakeword, config.wakewordMinLength);
    if (!checked.ok) continue;
    if (checked.kind === 'regex') { if (checked.regex.test(text.slice(0, WAKEWORD_SCAN_LIMIT))) return 'wakeword'; }
    else if (text.includes(wakeword)) return 'wakeword';
  }
  return null;
}
