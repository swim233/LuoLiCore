import type { Bot } from 'grammy';
import { holdReply, sendWithFallback, splitTelegramText } from './output.js';

export interface StreamOutputOptions {
  mode: 'stream' | 'once';
  replyDelayMs: number;
  /** 首个 chunk 到达后再攒这么久才发第一条，见下面 `consume` 里两道窗口的注释。 */
  bufferMs: number;
  intervalMs: number;
  minDeltaChars: number;
  maxChars: number;
  /** `output.parseMode`：编辑与发送时用的解析模式。`none` 时一律发纯文本。 */
  parseMode?: 'MarkdownV2' | 'HTML' | 'none';
  /** `output.flushOnSentence`：攒到句末标点就提前刷一次，不等满 `intervalMs`。 */
  flushOnSentence?: boolean;
  /** `output.typingWhileWorking`：生成期间是否持续发 typing。 */
  typingWhileWorking?: boolean;
  /** `output.placeholderAfterMs`：>0 且这么久还没有第一个 chunk 时，先发一条占位消息顶住。 */
  placeholderAfterMs?: number;
}

/** 句末：中英文的句号问号叹号与换行。判据故意保守 —— 逗号也刷会让编辑次数回到没有节流的水平。 */
const SENTENCE_END = /[。！？!?…\n]\s*$|[.](\s|$)/;

export class TelegramOutput {
  constructor(private readonly bot: Bot, private readonly chatId: string, private readonly options: StreamOutputOptions, private readonly onDeliveryError?: (error: unknown) => void,
    /** 起算点是用户那条消息的到达时刻，不是这个对象被构造的时刻：模型本来就想了 3 秒时不该再压 2 秒。 */
    private readonly since: number = Date.now(), private readonly beforeSend?: (text: string) => Promise<string>) {}

  async send(text: string, replyToMessageId?: number): Promise<number[]> {
    await holdReply(this.since, this.options.replyDelayMs);
    const finalText = this.beforeSend ? await this.beforeSend(text) : text;
    const parts = splitTelegramText(finalText, this.options.maxChars);
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
    let firstChunkAt = 0;
    // `output.typingWhileWorking`：关掉之后整轮一次 typing 都不发。默认开 —— 没有它，一次
    // 三十秒的工具调用在用户那边和「bot 死了」完全一样。
    const typing = this.options.typingWhileWorking === false ? null
      : setInterval(() => void this.bot.api.sendChatAction(this.chatId, 'typing').catch(() => undefined), 4000);
    const parseMode = this.options.parseMode ?? 'MarkdownV2';
    const edit = async (messageId: number, rendered: string): Promise<void> => {
      try {
        if (parseMode === 'none') { await this.bot.api.editMessageText(this.chatId, messageId, rendered); return; }
        await this.bot.api.editMessageText(this.chatId, messageId, rendered, { parse_mode: parseMode });
      } catch (error) {
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
    // `output.placeholderAfterMs`：上游迟迟不吐第一个 chunk 时先占个位。这条消息就是后面被
    // 编辑的那一条 —— 另发一条会让用户先看到「正在想…」再看到答案分两条躺在那里。
    let placeholder: ReturnType<typeof setTimeout> | null = null;
    const placeholderAfterMs = this.options.placeholderAfterMs ?? 0;
    if (this.options.mode === 'stream' && placeholderAfterMs > 0) {
      placeholder = setTimeout(() => void (async () => {
        if (messageIds.length || text) return;
        const sent = await deliver(() => sendWithFallback(this.bot.api, this.chatId, '…', replyToMessageId ? { reply_parameters: { message_id: replyToMessageId } } : {}));
        if (sent) { messageIds.push(sent.message_id); lastRenderedLength = 1; lastEdit = Date.now(); }
      })(), placeholderAfterMs);
      placeholder.unref?.();
    }
    try {
      if (this.options.typingWhileWorking !== false) await deliver(() => this.bot.api.sendChatAction(this.chatId, 'typing'));
      const iterator = stream[Symbol.asyncIterator]();
      for (;;) {
        let step: IteratorResult<string>;
        try { step = await iterator.next(); }
        catch { interrupted = true; break; }
        if (step.done) break;
        text += step.value;
        if (this.options.mode === 'once') continue;
        if (!firstChunkAt) firstChunkAt = Date.now();
        // 两道窗口，都只攒不发：replyDelayMs 防秒回，锚点是用户那条消息；bufferMs 攒首帧，
        // 锚点是上游第一个 chunk。只看前者时，模型思考一旦超过 replyDelayMs（几乎总是如此），
        // 首个 chunk 就会被原样发出去 —— 用户先收到一条只有一个字的消息，剩下的全靠编辑补，
        // 这正是「先发一个字再编辑」的来源。攒到的文本不会丢：流在窗口内就结束时下面走 send()。
        if (Date.now() < Math.max(this.since + this.options.replyDelayMs, firstChunkAt + this.options.bufferMs)) continue;
        // `output.flushOnSentence`：一句话说完就刷，不等满 intervalMs。代价是编辑次数上升
        // （docs/14 T10），收益是长回复读起来是一句一句出来的，而不是一段一段跳。
        const atSentenceEnd = this.options.flushOnSentence === true && SENTENCE_END.test(text);
        if (messageIds.length && !atSentenceEnd && Date.now() - lastEdit < this.options.intervalMs) continue;
        const rendered = splitTelegramText(text, this.options.maxChars);
        const before = messageIds.length;
        while (messageIds.length < rendered.length) {
          const index = messageIds.length;
          const sent = await deliver(() => sendWithFallback(this.bot.api, this.chatId, rendered[index]!, index === 0 && replyToMessageId ? { reply_parameters: { message_id: replyToMessageId } } : {}));
          if (!sent) break;
          messageIds.push(sent.message_id);
        }
        const current = rendered.at(-1)!;
        // 刚发出去的那条消息已经带着全文，紧接着再编辑一次是纯粹的抖动（还白占一次编辑配额）：
        // 把它算作一次「刷新」，下一次编辑照样要等满 intervalMs。
        if (messageIds.length > before) { lastRenderedLength = [...current].length; lastEdit = Date.now(); continue; }
        // 首条压根没发出去（限流、被拉黑）时没有可编辑的目标：下一个 chunk 重试发送，而不是拿
        // undefined 当 message_id 去调 editMessageText。
        if (!messageIds.length) continue;
        if ((atSentenceEnd || Date.now() - lastEdit >= this.options.intervalMs) && [...current].length - lastRenderedLength >= this.options.minDeltaChars) {
          await deliver(() => edit(messageIds.at(-1)!, current));
          lastRenderedLength = [...current].length;
          lastEdit = Date.now();
        }
      }
    } finally {
      if (typing) clearInterval(typing);
      if (placeholder) clearTimeout(placeholder);
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
