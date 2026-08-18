import type { Bot } from 'grammy';
import { holdReply, sendWithFallback, splitTelegramText, type ParseFallbackInfo, type ParseMode } from './output.js';

export interface StreamOutputOptions {
  mode: 'stream' | 'once';
  replyDelayMs: number;
  /** 首个 chunk 到达后再攒这么久才发第一条，见下面 `consume` 里两道窗口的注释。 */
  bufferMs: number;
  intervalMs: number;
  minDeltaChars: number;
  maxChars: number;
  /** `output.parseMode`：分片、发送、编辑三处共用它，见 `TelegramOutput.parseMode`。 */
  parseMode?: ParseMode;
  /** `output.flushOnSentence`：攒到句末标点就提前刷一次，不等满 `intervalMs`。 */
  flushOnSentence?: boolean;
  /** `output.typingWhileWorking`：生成期间是否持续发 typing。 */
  typingWhileWorking?: boolean;
  /** `output.placeholderAfterMs`：>0 且这么久还没有第一个 chunk 时，先发一条占位消息顶住。 */
  placeholderAfterMs?: number;
  /** `output.placeholderTexts`：占位消息的备选文案。空数组（或全是空白行）= 不发占位消息。 */
  placeholderTexts?: readonly string[];
  /** `output.placeholderPick` / `output.placeholderIndex`：随机挑一条，还是恒用下标指的那条。 */
  placeholderPick?: 'random' | 'fixed';
  placeholderIndex?: number;
}

/** 句末：中英文的句号问号叹号与换行。判据故意保守 —— 逗号也刷会让编辑次数回到没有节流的水平。 */
const SENTENCE_END = /[。！？!?…\n]\s*$|[.](\s|$)/;

/**
 * 挑一条占位文案。空白行在这里滤掉而不是在 schema 里拦：schema 拦下来的表现是整个进程起不来
 * （`config_kv` 里多敲一个空行就够），在这里滤掉只是少一条备选。全空 → `null` = 不发占位消息，
 * 这也是关掉占位消息的唯一途径（`placeholderAfterMs` 是 positive，填不了 0）。
 * `fixed` 的下标越界回落到第一条 —— 改短了列表不该让占位消息整个消失。
 */
export function pickPlaceholder(texts: readonly string[] | undefined, pick: 'random' | 'fixed' | undefined, index: number | undefined): string | null {
  const candidates = (texts ?? []).map((entry) => entry.trim()).filter(Boolean);
  if (!candidates.length) return null;
  if (pick === 'fixed') return candidates[index ?? 0] ?? candidates[0]!;
  return candidates[Math.floor(Math.random() * candidates.length)]!;
}

export class TelegramOutput {
  constructor(private readonly bot: Bot, private readonly chatId: string, private readonly options: StreamOutputOptions, private readonly onDeliveryError?: (error: unknown) => void,
    /** 起算点是用户那条消息的到达时刻，不是这个对象被构造的时刻：模型本来就想了 3 秒时不该再压 2 秒。 */
    private readonly since: number = Date.now(),
    /**
     * 插件的 `beforeSend` 钩子：**只在定稿时跑一次**。挂到每次流式编辑上会让它一轮触发十几次，
     * 那是改语义不是修 bug。
     */
    private readonly beforeSend?: (text: string) => Promise<string>,
    /**
     * 同步、廉价的投递侧收口（当前是 `output.maxMentions`）：**每次刷新都跑**。
     * 此前它和 `beforeSend` 合在一个 async 闭包里、只在 `send()` 里被调用，而流式那条路
     * （下面两处 `splitTelegramText`）直接绕过去了 —— 于是「@ 全群上限」在每个流式轮次都没生效，
     * 尽管 `bot.ts` 的注释写着它「在投递侧收口」。
     */
    private readonly sanitize?: (text: string) => string) {}

  /**
   * 解析失败降级成纯文本时回调一次（`tg.parse_fallback`）。做成可赋值字段而不是第八个构造参数：
   * 构造签名已经有七个位置参数了，再加一个没人能记住顺序。装配方（`bot.ts`）在 new 之后挂上。
   */
  onParseFallback?: (info: ParseFallbackInfo) => void;

  /**
   * `output.parseMode`。**分片、发送、编辑三处必须读同一个值** —— 三档各有自己的渲染器，
   * 分片按一档渲染、投递按另一档声明就是「用户看到转义符本身」那类 bug（docs/08 §5.3）。
   * 此前四处 send 写死 MarkdownV2、而 `edit` 读 options，`none` 档于是满屏 `\-`。
   */
  private get parseMode(): ParseMode {
    return this.options.parseMode ?? 'MarkdownV2';
  }

  /** 每次刷新都要过的那一道。渲染前做，因为 `capMentions` 数的是正文里的 `@`，不是转义后的。 */
  private guard(text: string): string {
    return this.sanitize ? this.sanitize(text) : text;
  }

  async send(text: string, replyToMessageId?: number): Promise<number[]> {
    await holdReply(this.since, this.options.replyDelayMs);
    const finalText = this.guard(this.beforeSend ? await this.beforeSend(text) : text);
    const parts = splitTelegramText(finalText, this.options.maxChars, this.parseMode);
    const ids: number[] = [];
    // **只有第一条分片带引用**，与 `consume()` 的收尾分片一致：整份都带的话，一条被切成五段的
    // 长回复会在群里刷出五个引用块（docs/14 §2 Q10）。
    for (const [index, part] of parts.entries()) {
      const message = await sendWithFallback(this.bot.api, this.chatId, part, index === 0 && replyToMessageId ? { reply_parameters: { message_id: replyToMessageId } } : {}, this.parseMode, this.onParseFallback);
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
    // **上一次还没落地就不再发。** typing 只在「现在」有意义，而 `apiThrottler` 给群聊的预算是
    // `telegram.throttle.perChatPerMinute`（默认 20/分钟）—— 4 秒一次是 15/分钟，同一个群里两轮
    // 并行就已经超了预算，多出来的每一条都排在队里，并且**排在真正的消息前面**。实测
    // logs/2026-08-18：19:13:03 到 19:16:04 每分钟准点吐 20 条 sendChatAction，而这一轮的收尾
    // editMessageText 就压在队尾 —— 轮次早在 19:13:03 就被 `turnTimeoutMs` 掐了，用户又多等了
    // 3 分钟才看到最后一次编辑。丢掉比排队正确：少一次 typing 没人看得出来。
    let typingInFlight = false;
    const typing = this.options.typingWhileWorking === false ? null
      : setInterval(() => {
        if (typingInFlight) return;
        typingInFlight = true;
        void this.bot.api.sendChatAction(this.chatId, 'typing').catch(() => undefined).finally(() => { typingInFlight = false; });
      }, 4000);
    const edit = async (messageId: number, rendered: string): Promise<void> => {
      try {
        if (this.parseMode === 'none') { await this.bot.api.editMessageText(this.chatId, messageId, rendered); return; }
        await this.bot.api.editMessageText(this.chatId, messageId, rendered, { parse_mode: this.parseMode });
      } catch (error) {
        const description = error instanceof Error ? error.message : String(error);
        if (/message is not modified|429/i.test(description)) return;
        // 与 `sendWithFallback` 同一跳，同一条 warn。这里不用给纯文本重编辑再包一层：
        // 两个调用点（下面 163 / 179）都过 `deliver()`，第二次失败会走 `onDeliveryError`。
        if (/parse entities/i.test(description)) {
          await this.bot.api.editMessageText(this.chatId, messageId, rendered);
          this.onParseFallback?.({ chars: rendered.length, error: description, phase: 'edit' });
          return;
        }
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
    // 文案在定时器**外面**挑好：随机档要是挑在回调里，这条消息的内容就和后面的 lastRenderedLength
    // 分处两个时刻，而且没法在挑不出文案时省掉整个 setTimeout。
    const placeholderText = pickPlaceholder(this.options.placeholderTexts, this.options.placeholderPick, this.options.placeholderIndex);
    if (this.options.mode === 'stream' && placeholderAfterMs > 0 && placeholderText) {
      placeholder = setTimeout(() => void (async () => {
        if (messageIds.length || text) return;
        const sent = await deliver(() => sendWithFallback(this.bot.api, this.chatId, placeholderText, replyToMessageId ? { reply_parameters: { message_id: replyToMessageId } } : {}, this.parseMode, this.onParseFallback));
        // 基线归 0 而不是占位文案的长度：`lastRenderedLength` 量的是「答复已经渲染了多少字」，
        // 占位消息里一个字都不是答复。记成文案长度的话，一句十来个字的文案会让第一次编辑多等
        // 十来个字才够 minDeltaChars —— 占位消息挂着的时间反倒随文案变长。原先写死的 1 是它
        // 还只能是「…」时两种读法恰好重合的产物。
        if (sent) { messageIds.push(sent.message_id); lastRenderedLength = 0; lastEdit = Date.now(); }
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
        // 纯空白的累积文本一次都不许发：`SENTENCE_END` 的白名单里有 `\n`，于是一段只有换行的
        // 累积会命中「一句话说完了」被刷出去，而 `sendWithFallback` 只降级 `parse entities` 那一类
        // —— Telegram 的 `400: text must be non-empty` 直接穿到 `onDeliveryError`
        // （logs/2026-08-18 14:55:14）。上游的归一化（`stepSeparatedText`）已经不产出这种流了，
        // 这一行是不信调用方的那道硬底。
        if (!text.trim()) continue;
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
        const rendered = splitTelegramText(this.guard(text), this.options.maxChars, this.parseMode);
        const before = messageIds.length;
        while (messageIds.length < rendered.length) {
          const index = messageIds.length;
          const sent = await deliver(() => sendWithFallback(this.bot.api, this.chatId, rendered[index]!, index === 0 && replyToMessageId ? { reply_parameters: { message_id: replyToMessageId } } : {}, this.parseMode, this.onParseFallback));
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
    /**
     * 收尾文本只算一次，两个 return 共用：
     *
     * - **返回的 `text` 与发出去的必须是同一份**（`bot.ts` 拿它去归档与提交上下文，注释写着「一律存
     *   真正发出去的那份」）。此前 `once` 档、以及流式档首条压根没发出去的那次，后缀只加在发出去的
     *   那份上 —— 用户看到「（生成中断）」而上下文里是一句看起来说完了的话，下一轮模型不知道自己
     *   被打断过。流式那一档从来是带后缀的，两处不该有两种口径。
     * - **一个字都没吐出来时不加后缀**：那个标记是给已经在屏幕上的半截内容用的。空内容加上它就是
     *   一条只有「（生成中断）」的消息，用户看不出发生了什么，而 `bot.ts` 还会把这条空壳当成
     *   「有内容的一轮」提交进上下文。这种情况该走失败那条路 —— 那里有能看懂的原因。
     */
    const closing = text + (interrupted && text.trim() ? '\n\n（生成中断）' : '');
    /**
     * **一个字都没吐出来时，已经发出去的占位消息要摘掉。** 上面那个后缀不加，于是 `closing` 是空串、
     * `splitTelegramText('')` 是空数组、下面那个收尾循环一次调用都不发 —— 「正在想…」就永久停在
     * 屏幕上（`logs/2026-08-18` 的主路径正是这一条：占位 4 秒发出、600 秒到点 abort，一个 chunk
     * 都没来）。占位消息不携带任何内容，摘掉它比留一条谁都解释不了的孤儿消息安全（docs/16 §5）；
     * 能看懂的原因在失败那条路上（`bot.ts` 的超时提示 / `failureText`）。
     * 返回空 `messageIds` 是同一件事的另一半：归档侧按它落 out 行，留着就是一行空正文的机器人消息。
     */
    if (interrupted && !closing.trim() && messageIds.length) {
      for (const messageId of messageIds) await deliver(() => this.bot.api.deleteMessage(this.chatId, messageId));
      return { text: closing, interrupted, messageIds: [] };
    }
    if (this.options.mode === 'once' || !messageIds.length) {
      return { text: closing, interrupted, messageIds: await this.send(closing, replyToMessageId) };
    }
    // 定稿这一次才跑插件的 `beforeSend`（每帧都跑等于把钩子的语义从「一条消息一次」改成
    // 「一次编辑一次」）。改写只影响发出去的文本，`text` 仍是模型的原话 —— 归档与上下文存原话。
    const rendered = splitTelegramText(this.guard(this.beforeSend ? await this.beforeSend(closing) : closing), this.options.maxChars, this.parseMode);
    // 收尾也要走 deliver + 降级：这里抛出去会把一轮已经发出大半的回复整个记成 failed（docs/20 · W-TG-04）。
    for (let index = 0; index < rendered.length; index += 1) {
      if (index < messageIds.length) { await deliver(() => edit(messageIds[index]!, rendered[index]!)); continue; }
      const sent = await deliver(() => sendWithFallback(this.bot.api, this.chatId, rendered[index]!, {}, this.parseMode, this.onParseFallback));
      if (!sent) break;
      messageIds.push(sent.message_id);
    }
    return { text: closing, interrupted, messageIds };
  }
}
