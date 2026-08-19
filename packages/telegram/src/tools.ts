import { InputFile, type Api, type Bot } from 'grammy';
import type { TelegramTarget, TelegramToolBridge } from '@luoli/core';
import type { ArchiveRepository } from '@luoli/db';
import { capMentions, deliveryOrder, segmentTelegramText, sendWithFallback, type ParseMode } from './output.js';

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
  /**
   * `output.maxMentions`。这条路此前**不过**这道闸，于是「投递侧收口」只收住了两条出站路径中的
   * 那两条：模型（或 `<untrusted-content>` 里被注入的一句话）调 `send_message` 就能绕开 @ 上限。
   */
  maxMentions(): number;
  /**
   * `output.parseMode`。这条路此前恒用默认的 MarkdownV2，于是运维把 `parseMode` 改成 `none`
   * 之后，`send_message` 发出去的仍是转义过的 MarkdownV2 文本 —— 三条出站路径两种渲染。
   */
  parseMode(): ParseMode;
}

export class TelegramTools implements TelegramToolBridge {
  constructor(private readonly dependencies: TelegramToolsDependencies) {}

  async sendMessage(target: TelegramTarget, text: string): Promise<object> {
    return this.guard(async (api) => {
      // 三条出站路径都要过 @ 上限这道闸，不然它不是边界只是建议。
      const capped = capMentions(text, this.dependencies.maxMentions());
      const parseMode = this.dependencies.parseMode();
      const { rendered, archived } = segmentTelegramText(capped, this.dependencies.maxMessageChars(), parseMode);
      if (!rendered.length) return { ok: false, error: 'empty_text' };
      const messageIds: number[] = [];
      // 这一批分段按 chat 串行，理由与 `bot.ts` 的定稿分段同一条（docs/28 · L-TG-02）：一条消息
      // 被切成的那几段中间挤进别的轮次的 `sendMessage`，用户看到的就是错序。
      await deliveryOrder.run(target.chatId, async () => {
        for (const [index, part] of rendered.entries()) {
          const sent = await sendWithFallback(api, target.chatId, part, this.thread(target), parseMode);
          // 归档存渲染前的正文而不是 `part`：三条出站路径（这里、`bot.ts` 的兜底、流式）必须在
          // `messages.text` 里放同一种东西，否则同一张表里一半带 MarkdownV2 转义符。**分片时存
          // 该段自己那一份**（docs/28 · L-TG-03）。存的是 `capMentions` 之后的那份 —— 归档要与
          // 真正发出去的一致，另外两条路径也都是收口后的。
          this.archiveOutgoing(target, sent.message_id, sent.date, archived[index] ?? capped, 'text', sent);
          messageIds.push(sent.message_id);
        }
      });
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
