import { InputFile, type Api, type Bot } from 'grammy';
import type { TelegramTarget, TelegramToolBridge } from '@luoli/core';
import type { ArchiveRepository } from '@luoli/db';
import { sendWithFallback, splitTelegramText } from './output.js';

/**
 * Telegram 只接受这一组固定的 reaction emoji（Bot API `ReactionTypeEmoji`）；别的一律 400
 * `REACTION_INVALID`。放在本地挡一道是为了让模型拿到「可选哪些」而不是一句上游报错 ——
 * 内核提示词让它「工具报错只修正参数、最多重试两次」，没有候选集它只能瞎猜两次然后放弃。
 */
const REACTIONS = ['👍', '👎', '❤', '🔥', '🥰', '👏', '😁', '🤔', '🤯', '😱', '🤬', '😢', '🎉', '🤩', '🤮', '💩',
  '🙏', '👌', '🕊', '🤡', '🥱', '🥴', '😍', '🐳', '❤‍🔥', '🌚', '🌭', '💯', '🤣', '⚡', '🍌', '🏆', '💔', '🤨',
  '😐', '🍓', '🍾', '💋', '🖕', '😈', '😴', '😭', '🤓', '👻', '👨‍💻', '👀', '🎃', '🙈', '😇', '😨', '🤝', '✍',
  '🤗', '🫡', '🎅', '🎄', '☃', '💅', '🤪', '🗿', '🆒', '💘', '🙉', '🦄', '😘', '💊', '🙊', '😎', '👾',
  '🤷‍♂', '🤷', '🤷‍♀', '😡'] as const;
/**
 * 变体选择符（U+FE0F）必须在比较前抹掉：`❤️`（带 VS16）与 Telegram 认的 `❤` 是两个字符串，
 * 而模型十有八九打出来的是带 VS16 的那个 —— 按字面比会把最常用的几个 emoji 全判成不支持。
 */
const canonical = new Map(REACTIONS.map((emoji) => [emoji.replaceAll('️', ''), emoji]));

export interface TelegramToolsDependencies {
  /** 懒取：工具在 bot 建起来之前就注册好了（`registerBuiltins` 在 `createTelegramBot` 之前跑）。 */
  bot(): Bot | null;
  archive: ArchiveRepository;
  maxMessageChars(): number;
}

export class TelegramTools implements TelegramToolBridge {
  constructor(private readonly dependencies: TelegramToolsDependencies) {}

  async sendMessage(target: TelegramTarget, text: string): Promise<object> {
    return this.guard(async (api) => {
      const parts = splitTelegramText(text, this.dependencies.maxMessageChars());
      if (!parts.length) return { ok: false, error: 'empty_text' };
      const messageIds: number[] = [];
      for (const part of parts) {
        const sent = await sendWithFallback(api, target.chatId, part, this.thread(target));
        this.archiveOutgoing(target, sent.message_id, sent.date, part, 'text', sent);
        messageIds.push(sent.message_id);
      }
      return { ok: true, messageIds };
    });
  }

  async sendPhoto(target: TelegramTarget, absolutePath: string, caption?: string): Promise<object> {
    return this.guard(async (api) => {
      const sent = await api.sendPhoto(target.chatId, new InputFile(absolutePath), { ...this.thread(target), ...(caption ? { caption } : {}) });
      this.archiveOutgoing(target, sent.message_id, sent.date, caption ?? '[图片]', 'photo', sent);
      return { ok: true, messageId: sent.message_id };
    });
  }

  async sendFile(target: TelegramTarget, absolutePath: string, caption?: string): Promise<object> {
    return this.guard(async (api) => {
      const sent = await api.sendDocument(target.chatId, new InputFile(absolutePath), { ...this.thread(target), ...(caption ? { caption } : {}) });
      this.archiveOutgoing(target, sent.message_id, sent.date, caption ?? `[文档 ${sent.document?.file_name ?? ''}]`, 'document', sent);
      return { ok: true, messageId: sent.message_id };
    });
  }

  async react(target: TelegramTarget, messageId: number, emoji: string): Promise<object> {
    const resolved = canonical.get(emoji.replaceAll('️', ''));
    if (!resolved) return { ok: false, error: 'unsupported_emoji', hint: 'Telegram 只接受固定的一组 reaction emoji', allowed: [...canonical.values()] };
    return this.guard(async (api) => {
      await api.setMessageReaction(target.chatId, messageId, [{ type: 'emoji', emoji: resolved }]);
      return { ok: true, messageId, emoji: resolved };
    });
  }

  async pin(target: TelegramTarget, messageId: number): Promise<object> {
    return this.guard(async (api) => {
      await api.pinChatMessage(target.chatId, messageId);
      return { ok: true, messageId };
    });
  }

  /**
   * 上游报错一律转成 `ok:false`：抛出去会被注册表记成工具异常，模型看到的只有一句堆栈式的
   * `Call to "pinChatMessage" failed!`，而「bot 没有置顶权限」这种事它本可以据此换个做法。
   */
  private async guard(run: (api: Api) => Promise<object>): Promise<object> {
    const api = this.dependencies.bot()?.api;
    if (!api) return { ok: false, error: 'telegram_unavailable', hint: 'Telegram 入口未启用' };
    try { return await run(api); }
    catch (error) { return { ok: false, error: 'telegram_api_error', hint: error instanceof Error ? error.message : String(error) }; }
  }

  private thread(target: TelegramTarget): Record<string, unknown> {
    return target.threadId === null ? {} : { message_thread_id: target.threadId };
  }

  /**
   * 追发出去的消息必须回写归档，理由和 bot.ts 里回复自己那条一样：不写的话 `read_messages`、
   * WebUI 会话页、以及「回复这条消息」的取回链路里都缺这一条，模型自己发过的东西下一轮就不见了。
   * `direction='out'` 让它天然不会被 `claimBackground` 当成群背景发言再认领一次。
   */
  private archiveOutgoing(target: TelegramTarget, tgMessageId: number, date: number | undefined, text: string, kind: string, raw: unknown): void {
    const info = this.dependencies.bot()?.botInfo;
    this.dependencies.archive.scope(target.chatId, target.threadId).append({
      chatId: target.chatId, messageThreadId: target.threadId, tgMessageId, direction: 'out', fromKind: 'bot',
      fromUserId: info ? String(info.id) : null, fromName: info?.first_name ?? null, fromUsername: info?.username ?? null,
      kind, text, tgDate: (date ?? Math.floor(Date.now() / 1000)) * 1000, raw, triggered: false, turnId: target.turnId,
    });
  }
}
