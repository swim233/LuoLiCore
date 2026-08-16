import type { Bot } from 'grammy';
import { holdReply, sendWithFallback, splitTelegramText } from './output.js';

export interface StreamOutputOptions {
  mode: 'stream' | 'once';
  replyDelayMs: number;
  intervalMs: number;
  minDeltaChars: number;
  maxChars: number;
}

export class TelegramOutput {
  constructor(private readonly bot: Bot, private readonly chatId: string, private readonly options: StreamOutputOptions, private readonly onDeliveryError?: (error: unknown) => void,
    /** 起算点是用户那条消息的到达时刻，不是这个对象被构造的时刻：模型本来就想了 3 秒时不该再压 2 秒。 */
    private readonly since: number = Date.now()) {}

  async send(text: string, replyToMessageId?: number): Promise<number[]> {
    await holdReply(this.since, this.options.replyDelayMs);
    const parts = splitTelegramText(text, this.options.maxChars);
    const ids: number[] = [];
    for (const part of parts) {
      const message = await sendWithFallback(this.bot.api, this.chatId, part, replyToMessageId ? { reply_parameters: { message_id: replyToMessageId } } : {});
      ids.push(message.message_id);
    }
    return ids;
  }

  async consume(stream: AsyncIterable<string>, replyToMessageId?: number): Promise<{ text: string; messageIds: number[]; interrupted: boolean }> {
    let text = '';
    const messageIds: number[] = [];
    let interrupted = false;
    let lastEdit = 0;
    let lastRenderedLength = 0;
    const typing = setInterval(() => void this.bot.api.sendChatAction(this.chatId, 'typing').catch(() => undefined), 4000);
    const edit = async (messageId: number, rendered: string): Promise<void> => {
      try { await this.bot.api.editMessageText(this.chatId, messageId, rendered, { parse_mode: 'MarkdownV2' }); }
      catch (error) {
        const description = error instanceof Error ? error.message : String(error);
        if (/message is not modified|429/i.test(description)) return;
        if (/parse entities/i.test(description)) { await this.bot.api.editMessageText(this.chatId, messageId, rendered); return; }
        throw error;
      }
    };
    // 投递失败不等于生成中断：把两者混为一谈会让网络抖动被记成 stream_interrupted，
    // 并给用户一句本不该出现的「（生成中断）」（docs/19-review-round4.md · R-TG-02）。
    const deliver = async <T>(action: () => Promise<T>): Promise<T | null> => {
      try { return await action(); }
      catch (error) { this.onDeliveryError?.(error); return null; }
    };
    try {
      await deliver(() => this.bot.api.sendChatAction(this.chatId, 'typing'));
      const iterator = stream[Symbol.asyncIterator]();
      for (;;) {
        let step: IteratorResult<string>;
        try { step = await iterator.next(); }
        catch { interrupted = true; break; }
        if (step.done) break;
        text += step.value;
        if (this.options.mode === 'once') continue;
        // 延迟窗口内只攒不发。攒到的文本不会丢：流在窗口内就结束时下面走 send()，它自己也会等满。
        if (Date.now() - this.since < this.options.replyDelayMs) continue;
        const rendered = splitTelegramText(text, this.options.maxChars);
        while (messageIds.length < rendered.length) {
          const index = messageIds.length;
          const sent = await deliver(() => sendWithFallback(this.bot.api, this.chatId, rendered[index]!, index === 0 && replyToMessageId ? { reply_parameters: { message_id: replyToMessageId } } : {}));
          if (!sent) break;
          messageIds.push(sent.message_id);
        }
        const current = rendered.at(-1)!;
        if (Date.now() - lastEdit >= this.options.intervalMs && [...current].length - lastRenderedLength >= this.options.minDeltaChars) {
          await deliver(() => edit(messageIds.at(-1)!, current));
          lastRenderedLength = [...current].length;
          lastEdit = Date.now();
        }
      }
    } finally {
      clearInterval(typing);
    }
    if (this.options.mode === 'once' || !messageIds.length) return { text, interrupted, messageIds: await this.send(text + (interrupted ? '\n\n（生成中断）' : ''), replyToMessageId) };
    const rendered = splitTelegramText(text + (interrupted ? '\n\n（生成中断）' : ''), this.options.maxChars);
    // 收尾也要走 deliver + 降级：这里抛出去会把一轮已经发出大半的回复整个记成 failed（docs/20 · W-TG-04）。
    for (let index = 0; index < rendered.length; index += 1) {
      if (index < messageIds.length) { await deliver(() => edit(messageIds[index]!, rendered[index]!)); continue; }
      const sent = await deliver(() => sendWithFallback(this.bot.api, this.chatId, rendered[index]!));
      if (!sent) break;
      messageIds.push(sent.message_id);
    }
    return { text: text + (interrupted ? '\n\n（生成中断）' : ''), interrupted, messageIds };
  }
}
