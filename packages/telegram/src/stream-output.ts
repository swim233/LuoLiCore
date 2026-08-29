import type { Bot } from "grammy";
import {
  deliveryOrder,
  holdReply,
  segmentTelegramText,
  sendWithFallback,
  splitTelegramText,
  type ParseFallbackInfo,
  type ParseMode,
} from "./output.js";

export interface StreamOutputOptions {
  mode: "stream" | "once";
  replyDelayMs: number;
  /** 首个 chunk 到达后再累积这段时长才发第一条，见 `consume` 中两道窗口的注释。 */
  bufferMs: number;
  intervalMs: number;
  minDeltaChars: number;
  maxChars: number;
  /** `output.parseMode`：分片、发送、编辑三处共用该值，见 `TelegramOutput.parseMode`。 */
  parseMode?: ParseMode;
  /** `output.flushOnSentence`：累积到句末标点即提前刷新，不等满 `intervalMs`。 */
  flushOnSentence?: boolean;
  /** `output.typingWhileWorking`：生成期间是否持续发送 typing。 */
  typingWhileWorking?: boolean;
  /** `output.placeholderAfterMs`：>0 且超过该时长仍无首个 chunk 时，先发一条占位消息。 */
  placeholderAfterMs?: number;
  /** `output.placeholderTexts`：占位消息的备选文案。空数组（或全为空白行）表示不发占位消息。 */
  placeholderTexts?: readonly string[];
  /** `output.placeholderPick` / `output.placeholderIndex`：随机选取，或恒用下标指定的那条。 */
  placeholderPick?: "random" | "fixed";
  placeholderIndex?: number;
}

/** 句末判据：中英文句号问号叹号与换行。判据取保守值 —— 逗号也刷新会使编辑次数回到无节流的水平。 */
const SENTENCE_END = /[。！？!?…\n]\s*$|[.](\s|$)/;
/** typing 的基础节拍。Telegram 侧输入状态约 5 秒过期，故持续显示打字状态的下限即此量级。 */
const TYPING_TICK_MS = 4000;
/**
 * 首条消息发出之后的 typing 节拍。`docs/08 §5.2` 的伪码即为「每 4s 续期，直到首条消息发出」——
 * 屏幕上一旦有正文在增长，typing 仅剩「仍在生成」这一层含义，而它与正文编辑共用同一份
 * per-chat 预算（`telegram.throttle.perChatPerMinute`，默认 20/分钟）。放宽至该节拍后指示器会
 * 闪断，这是有意取舍：闪断的输入状态优于「输出中途静止 14 秒」（docs/28 · L-TG-04）。
 */
const TYPING_QUIET_MS = 15_000;

/**
 * 选取一条占位文案。空白行在此过滤而非由 schema 拦截：schema 拦截的表现是整个进程无法启动
 * （`config_kv` 中多一个空行即可触发），在此过滤仅减少一条备选。全空时返回 `null` 表示不发占位
 * 消息，这也是关闭占位消息的唯一途径（`placeholderAfterMs` 约束为正数，无法填 0）。
 * `fixed` 下标越界时回落到第一条 —— 缩短列表不应导致占位消息完全消失。
 */
export function pickPlaceholder(
  texts: readonly string[] | undefined,
  pick: "random" | "fixed" | undefined,
  index: number | undefined,
): string | null {
  const candidates = (texts ?? []).map((entry) => entry.trim()).filter(Boolean);
  if (!candidates.length) return null;
  if (pick === "fixed") return candidates[index ?? 0] ?? candidates[0]!;
  return candidates[Math.floor(Math.random() * candidates.length)]!;
}

/**
 * 投递层的语义事件（`docs/10 §2` 的 `tg.send` / `tg.edit` / `tg.action`）。
 *
 * `tg.api` 位于 grammY 的 API transformer 中，取不到 turn/chat 上下文 —— 生产库 9745 条
 * `tg.api` 中 `trace_id IS NULL` 的为 9745 条（100%），人工窗口的 14 轮按 trace 归轮结果每轮
 * 均为 0，且 `data` 只有 `{method, ok}`：无 chars、无 messageId（docs/28 · L-LOG-02）。
 * 因此语义 span 在本层发出 —— 此处可获得 turnId、chatId、chars 与 messageId。
 *
 * `edit` 与 `action` 按轮聚合为一条：一次流式回复可产生数十次编辑，逐次记录只会产生噪声。
 */
export interface TelegramDeliveryEvent {
  kind: "send" | "edit" | "action";
  ok: boolean;
  ms: number;
  /** `send`：本条的 message_id。`edit`：最后一次编辑所针对的那条。 */
  messageId?: number;
  chars?: number;
  /** `edit` / `action` 的聚合次数。 */
  count?: number;
  /** `send` 的来源：流式首发、`once` 档、收尾补发。 */
  path?: "stream" | "once" | "final";
  error?: string;
}

export class TelegramOutput {
  constructor(
    private readonly bot: Bot,
    private readonly chatId: string,
    private readonly options: StreamOutputOptions,
    private readonly onDeliveryError?: (error: unknown) => void,
    /** 起算点为用户消息的到达时刻，而非本对象的构造时刻：模型已思考 3 秒时不应再追加 2 秒延迟。 */
    private readonly since: number = Date.now(),
    /**
     * 插件的 `beforeSend` 钩子：仅在定稿时执行一次。挂载到每次流式编辑会使其单轮触发十余次，
     * 那属于修改语义而非修复缺陷。
     */
    private readonly beforeSend?: (text: string) => Promise<string>,
    /**
     * 同步、低开销的投递侧收口（当前为 `output.maxMentions`）：每次刷新均执行。
     * 此前它与 `beforeSend` 合并在同一个 async 闭包内、仅在 `send()` 中被调用，而流式路径
     * （下方两处 `splitTelegramText`）直接绕过 —— 导致 @ 全群上限在每个流式轮次均未生效，
     * 尽管 `bot.ts` 的注释声明它在投递侧收口。
     */
    private readonly sanitize?: (text: string) => string,
  ) {}

  /**
   * 解析失败降级为纯文本时回调一次（`tg.parse_fallback`）。设计为可赋值字段而非第八个构造参数：
   * 构造签名已有七个位置参数，再增加一个则顺序难以记忆。由装配方（`bot.ts`）在 new 之后挂载。
   */
  onParseFallback?: (info: ParseFallbackInfo) => void;

  /**
   * 投递层的语义事件（见 `TelegramDeliveryEvent`）。同样设计为可赋值字段而非第八个位置参数。
   * 缺省时整段为空操作（用于测试与不关心观测的调用点）。
   */
  onDelivery?: (event: TelegramDeliveryEvent) => void;

  /** 观测不得打断投递：本回调的实现方是 `LogSink.event`（保证不抛），但契约上不应依赖该保证。 */
  #emit(event: TelegramDeliveryEvent): void {
    try {
      this.onDelivery?.(event);
    } catch {
      /* 日志写入失败不应阻止消息发出 */
    }
  }

  /**
   * `output.parseMode`。分片、发送、编辑三处必须读取同一个值 —— 三档各有独立渲染器，
   * 分片按一档渲染、投递按另一档声明会产生「用户看到转义符本身」类缺陷（docs/08 §5.3）。
   * 此前四处 send 硬编码 MarkdownV2，而 `edit` 读 options，`none` 档因此满屏 `\-`。
   */
  private get parseMode(): ParseMode {
    return this.options.parseMode ?? "MarkdownV2";
  }

  /** 每次刷新均需执行。在渲染前执行，因为 `capMentions` 统计的是正文中的 `@` 而非转义后的。 */
  private guard(text: string): string {
    return this.sanitize ? this.sanitize(text) : text;
  }

  /**
   * `segments[i]` 为 `messageIds[i]` 对应消息应归档的正文，仅在实际分片时非空：单条时
   * 归档口径不变（`bot.ts` 写入的仍是模型原文，而此处 `finalText` 已经过 `capMentions` 与插件
   * 钩子处理）。见 `segmentTelegramText`（docs/28 · L-TG-03）。
   */
  async send(
    text: string,
    replyToMessageId?: number,
  ): Promise<{ messageIds: number[]; segments: string[] }> {
    await holdReply(this.since, this.options.replyDelayMs);
    const finalText = this.guard(
      this.beforeSend ? await this.beforeSend(text) : text,
    );
    const { rendered, archived } = segmentTelegramText(
      finalText,
      this.options.maxChars,
      this.parseMode,
    );
    const ids: number[] = [];
    // 本批分段按 chat 串行（docs/28 · L-TG-02）：`holdReply` 的等待放在锁外 —— 持锁等待会使
    // 并发轮次额外排队 `replyDelayMs`。
    await deliveryOrder.run(this.chatId, async () => {
      // 只有第一条分片携带引用，与 `consume()` 的收尾分片一致：全部携带会导致一条被切成五段的
      // 长回复在群内产生五个引用块（docs/14 §2 Q10）。
      for (const [index, part] of rendered.entries()) {
        const at = Date.now();
        // 本档向外抛出（由上层记为 turn 失败），但失败同样要记录投递侧的那一行（`docs/10 §2` 的
        // 失败档 warn）：否则「本轮发出了什么」只剩下没有 traceId 的 `tg.api`（docs/28 · L-LOG-02）。
        const message = await sendWithFallback(
          this.bot.api,
          this.chatId,
          part,
          index === 0 && replyToMessageId
            ? { reply_parameters: { message_id: replyToMessageId } }
            : {},
          this.parseMode,
          this.onParseFallback,
        ).catch((error: unknown) => {
          this.#emit({
            kind: "send",
            ok: false,
            ms: Date.now() - at,
            chars: part.length,
            path: "once",
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        });
        ids.push(message.message_id);
        this.#emit({
          kind: "send",
          ok: true,
          ms: Date.now() - at,
          messageId: message.message_id,
          chars: part.length,
          path: "once",
        });
      }
    });
    return { messageIds: ids, segments: rendered.length > 1 ? archived : [] };
  }

  /** `segments` 的语义见 `send()` 上方注释：逐段归档，仅在实际分片时非空。 */
  async consume(
    stream: AsyncIterable<string>,
    replyToMessageId?: number,
  ): Promise<{
    text: string;
    messageIds: number[];
    interrupted: boolean;
    segments: string[];
  }> {
    let text = "";
    const messageIds: number[] = [];
    let interrupted = false;
    let lastEdit = 0;
    let lastRenderedLength = 0;
    let firstChunkAt = 0;
    /**
     * `output.typingWhileWorking`：关闭后整轮不发送任何 typing。默认开启 —— 缺少它时，一次三十秒的
     * 工具调用在用户侧与进程崩溃无法区分。
     *
     * typing 可丢弃、正文不可丢弃，因此 typing 为正文让出槽位。typing 仅在当前时刻有意义
     * （Telegram 侧约 5 秒过期），丢失一拍不可察觉；而 `editMessageText` 丢失一次即导致用户永远
     * 看不到该段内容。两者共用同一份 per-chat 预算（`telegram.throttle.perChatPerMinute`，默认
     * 20/分钟），让可丢弃请求占用不可丢弃请求的槽位本身即为错误。三道判据：
     *
     * - `typingInFlight`：上一拍未完成即不再发送。4 秒一次即 15/分钟，同一群内两轮并行即超出
     *   预算，超出部分全部排队且排在真正的消息之前 —— 实测 logs/2026-08-18：19:13:03 至 19:16:04
     *   每分钟稳定发出 20 条 sendChatAction，而本轮的收尾 editMessageText 位于队尾，轮次已在
     *   19:13:03 被 `turnTimeoutMs` 中断，用户又等待 3 分钟才看到最后一次编辑。
     * - `bodyInFlight`：本轮存在在途正文（含被节流器排队的部分）时整拍跳过。上一条判据只减少了
     *   typing 的数量，且与这两个计数器同为 per `TelegramOutput` 实例（即 per 轮次）
     *   —— 队列停止增长只在单轮成立，而 20/分钟 的桶是 per chat 的。实测群内 6 轮并发 17 秒
     *   耗尽储备，随后连续 14 秒零投递，此时队首的 `sendChatAction` 排队 14455ms，占用的正是
     *   其后 `editMessageText`（14028ms）所需的槽位，用户观察到的现象是输出中途静止。
     *   判据虽为 per 轮次，但每轮都将槽位让给自身正文，合计后预算即流向正文。
     * - `lastBodyAt` + `TYPING_QUIET_MS`：首条消息发出后放宽节拍，正文刚落地时整拍跳过。
     *
     * 不调整 grammY 的桶 —— 那是 Telegram 侧的真实限制（docs/28 · L-TG-04）。
     */
    let typingInFlight = false;
    let lastTypingAt = 0;
    let bodyInFlight = 0;
    let lastBodyAt = 0;
    // 聚合计数（`docs/10 §2`）：`tg.edit` / `tg.action` 各只记录一条，携带次数与总耗时。
    let actionCount = 0;
    let actionMs = 0;
    let editCount = 0;
    let editMs = 0;
    let lastEditChars = 0;
    let lastEditMessageId: number | undefined;
    const typing =
      this.options.typingWhileWorking === false
        ? null
        : setInterval(() => {
            if (typingInFlight || bodyInFlight > 0) return;
            const now = Date.now();
            // 首条消息发出之前，typing 是唯一的进行中信号，节拍保持 4 秒。之后放宽，且正文刚落地时
            // 整拍跳过 —— 正文持续增长本身即为最有效的进行中信号。
            if (
              messageIds.length &&
              now - Math.max(lastTypingAt, lastBodyAt) < TYPING_QUIET_MS
            )
              return;
            lastTypingAt = now;
            typingInFlight = true;
            actionCount += 1;
            void this.bot.api
              .sendChatAction(this.chatId, "typing")
              .catch(() => undefined)
              .finally(() => {
                typingInFlight = false;
                actionMs += Date.now() - now;
              });
          }, TYPING_TICK_MS);
    const edit = async (messageId: number, rendered: string): Promise<void> => {
      const at = Date.now();
      editCount += 1;
      lastEditChars = rendered.length;
      lastEditMessageId = messageId;
      try {
        if (this.parseMode === "none") {
          await this.bot.api.editMessageText(this.chatId, messageId, rendered);
          return;
        }
        await this.bot.api.editMessageText(this.chatId, messageId, rendered, {
          parse_mode: this.parseMode,
        });
      } catch (error) {
        const description =
          error instanceof Error ? error.message : String(error);
        if (/message is not modified|429/i.test(description)) return;
        // 与 `sendWithFallback` 属同一跳、同一条 warn。此处无需为纯文本重编辑再包一层：
        // 两个调用点（下方 163 / 179）均经过 `deliver()`，二次失败会走 `onDeliveryError`。
        if (/parse entities/i.test(description)) {
          await this.bot.api.editMessageText(this.chatId, messageId, rendered);
          this.onParseFallback?.({
            chars: rendered.length,
            error: description,
            phase: "edit",
          });
          return;
        }
        throw error;
      } finally {
        editMs += Date.now() - at;
      }
    };
    /**
     * `tg.edit` / `tg.action` 每轮各只记录一条（`docs/10 §1`）。三个 return 点都必须经过此处 ——
     * 遗漏其一的表现是某类轮次的编辑次数恒为 0，而那正是最需要观测的一类
     * （被打断、仅发出占位、`once` 档）。
     */
    const flushAggregates = (): void => {
      if (editCount)
        this.#emit({
          kind: "edit",
          ok: true,
          ms: editMs,
          count: editCount,
          chars: lastEditChars,
          ...(lastEditMessageId === undefined
            ? {}
            : { messageId: lastEditMessageId }),
        });
      if (actionCount)
        this.#emit({
          kind: "action",
          ok: true,
          ms: actionMs,
          count: actionCount,
        });
    };
    // 投递失败不等同于生成中断：混淆两者会使网络抖动被记为 stream_interrupted，
    // 并向用户输出本不应出现的「（生成中断）」（docs/19-review-round4.md · R-TG-02）。
    const deliver = async <T>(action: () => Promise<T>): Promise<T | null> => {
      try {
        return await action();
      } catch (error) {
        this.onDeliveryError?.(error);
        return null;
      }
    };
    // 正文投递（占位、send、edit）：`bodyInFlight` 在途期间上方的 typing 整拍跳过，`lastBodyAt`
    // 使刚落地后的若干拍同样跳过。排队时间计入在途 —— 被 `apiThrottler` 压制的正文正是需保护的部分。
    const body = async <T>(action: () => Promise<T>): Promise<T | null> => {
      bodyInFlight += 1;
      try {
        return await deliver(action);
      } finally {
        bodyInFlight -= 1;
        lastBodyAt = Date.now();
      }
    };
    // `output.placeholderAfterMs`：上游长时间未产出首个 chunk 时先发占位消息。该消息即为后续被
    // 编辑的那一条 —— 另发一条会导致占位与答案作为两条消息并存。
    let placeholder: ReturnType<typeof setTimeout> | null = null;
    const placeholderAfterMs = this.options.placeholderAfterMs ?? 0;
    // 文案在定时器外部选定：随机档若在回调内选取，该消息的内容与后续的 lastRenderedLength
    // 将处于两个不同时刻，且无法在选不出文案时省略整个 setTimeout。
    const placeholderText = pickPlaceholder(
      this.options.placeholderTexts,
      this.options.placeholderPick,
      this.options.placeholderIndex,
    );
    if (
      this.options.mode === "stream" &&
      placeholderAfterMs > 0 &&
      placeholderText
    ) {
      placeholder = setTimeout(
        () =>
          void (async () => {
            if (messageIds.length || text) return;
            const at = Date.now();
            const sent = await body(() =>
              sendWithFallback(
                this.bot.api,
                this.chatId,
                placeholderText,
                replyToMessageId
                  ? { reply_parameters: { message_id: replyToMessageId } }
                  : {},
                this.parseMode,
                this.onParseFallback,
              ),
            );
            // 基线归 0 而非占位文案长度：`lastRenderedLength` 度量的是答复已渲染的字数，
            // 占位消息不包含任何答复内容。若记为文案长度，十余字的文案会使首次编辑额外等待
            // 十余字才满足 minDeltaChars —— 占位消息的驻留时长反而随文案变长。原先硬编码的 1
            // 是文案只能为「…」时两种解释恰好重合的产物。
            if (sent) {
              messageIds.push(sent.message_id);
              lastRenderedLength = 0;
              lastEdit = Date.now();
            }
            this.#emit({
              kind: "send",
              ok: sent !== null,
              ms: Date.now() - at,
              ...(sent ? { messageId: sent.message_id } : {}),
              chars: placeholderText.length,
              path: "stream",
            });
          })(),
        placeholderAfterMs,
      );
      placeholder.unref?.();
    }
    try {
      // 开轮的首发无条件送出：`docs/08 §5.2` 要求呈现进行中而非卡死状态，而此刻屏幕上没有任何
      // 内容，typing 是唯一信号。记录时刻，使首条消息发出后的第一拍沿用该起点。
      if (this.options.typingWhileWorking !== false) {
        lastTypingAt = Date.now();
        actionCount += 1;
        await deliver(() => this.bot.api.sendChatAction(this.chatId, "typing"));
        actionMs += Date.now() - lastTypingAt;
      }
      const iterator = stream[Symbol.asyncIterator]();
      for (;;) {
        let step: IteratorResult<string>;
        try {
          step = await iterator.next();
        } catch {
          interrupted = true;
          break;
        }
        if (step.done) break;
        text += step.value;
        if (this.options.mode === "once") continue;
        // 纯空白的累积文本一律不发送：`SENTENCE_END` 的白名单包含 `\n`，因此只含换行的累积
        // 会命中句末判据并被刷出，而 `sendWithFallback` 只降级 `parse entities` 一类
        // —— Telegram 的 `400: text must be non-empty` 会直接传至 `onDeliveryError`
        // （logs/2026-08-18 14:55:14）。上游归一化（`stepSeparatedText`）已不再产出此类流，
        // 本行是不依赖调用方的硬性兜底。
        if (!text.trim()) continue;
        if (!firstChunkAt) firstChunkAt = Date.now();
        // 两道窗口均只累积不发送：replyDelayMs 抑制秒回，锚点为用户消息；bufferMs 累积首帧，
        // 锚点为上游首个 chunk。仅使用前者时，模型思考时长一旦超过 replyDelayMs（通常如此），
        // 首个 chunk 会被原样发出 —— 用户先收到只有一个字符的消息，其余靠编辑补齐，
        // 即「先发一个字再编辑」的成因。累积的文本不会丢失：流在窗口内结束时走下方的 send()。
        if (
          Date.now() <
          Math.max(
            this.since + this.options.replyDelayMs,
            firstChunkAt + this.options.bufferMs,
          )
        )
          continue;
        // `output.flushOnSentence`：一句结束即刷新，不等满 intervalMs。代价是编辑次数上升
        // （docs/14 T10），收益是长回复按句输出，而非按段跳变。
        const atSentenceEnd =
          this.options.flushOnSentence === true && SENTENCE_END.test(text);
        if (
          messageIds.length &&
          !atSentenceEnd &&
          Date.now() - lastEdit < this.options.intervalMs
        )
          continue;
        const rendered = splitTelegramText(
          this.guard(text),
          this.options.maxChars,
          this.parseMode,
        );
        const before = messageIds.length;
        while (messageIds.length < rendered.length) {
          const index = messageIds.length;
          const at = Date.now();
          const sent = await body(() =>
            sendWithFallback(
              this.bot.api,
              this.chatId,
              rendered[index]!,
              index === 0 && replyToMessageId
                ? { reply_parameters: { message_id: replyToMessageId } }
                : {},
              this.parseMode,
              this.onParseFallback,
            ),
          );
          this.#emit({
            kind: "send",
            ok: sent !== null,
            ms: Date.now() - at,
            ...(sent ? { messageId: sent.message_id } : {}),
            chars: rendered[index]!.length,
            path: "stream",
          });
          if (!sent) break;
          messageIds.push(sent.message_id);
        }
        const current = rendered.at(-1)!;
        // 刚发出的消息已包含全文，紧接着再编辑一次纯属抖动且额外消耗一次编辑配额：
        // 将其计为一次刷新，下一次编辑仍需等满 intervalMs。
        if (messageIds.length > before) {
          lastRenderedLength = [...current].length;
          lastEdit = Date.now();
          continue;
        }
        // 首条未能发出（限流、被封禁）时没有可编辑的目标：由下一个 chunk 重试发送，而不是以
        // undefined 作为 message_id 调用 editMessageText。
        if (!messageIds.length) continue;
        if (
          (atSentenceEnd || Date.now() - lastEdit >= this.options.intervalMs) &&
          [...current].length - lastRenderedLength >= this.options.minDeltaChars
        ) {
          await body(() => edit(messageIds.at(-1)!, current));
          lastRenderedLength = [...current].length;
          lastEdit = Date.now();
        }
      }
    } finally {
      if (typing) clearInterval(typing);
      if (placeholder) clearTimeout(placeholder);
    }
    /**
     * 收尾文本只计算一次，两个 return 共用：
     *
     * - 返回的 `text` 与实际发出的内容必须一致（`bot.ts` 以它归档并提交上下文，注释规定一律存
     *   实际发出的那份）。此前 `once` 档以及流式档首条未发出的情形，后缀只追加到发出的那份上 ——
     *   用户看到「（生成中断）」而上下文中是一句看似完整的话，下一轮模型不知道自己曾被打断。
     *   流式档始终带后缀，两处不应存在两种口径。
     * - 无任何输出时不追加后缀：该标记用于屏幕上已有的半截内容。空内容追加后即产生一条只有
     *   「（生成中断）」的消息，用户无法判断发生了什么，而 `bot.ts` 还会将该空壳当作有内容的
     *   一轮提交进上下文。此情形应走失败路径 —— 那里给出可理解的原因。
     */
    const closing =
      text + (interrupted && text.trim() ? "\n\n（生成中断）" : "");
    /**
     * 无任何输出时，已发出的占位消息必须撤除。上述后缀不追加，故 `closing` 为空串、
     * `splitTelegramText('')` 为空数组、下方收尾循环不发起任何调用 —— 占位文案会永久停留在
     * 屏幕上（`logs/2026-08-18` 的主路径即为此情形：占位于 4 秒发出、600 秒超时 abort，未收到任何
     * chunk）。占位消息不携带内容，撤除它比留下一条无法解释的孤儿消息更安全（docs/16 §5）；
     * 可理解的原因由失败路径给出（`bot.ts` 的超时提示 / `failureText`）。
     * 返回空 `messageIds` 是同一处理的另一半：归档侧据此写入 out 行，保留则会产生一行空正文的机器人消息。
     */
    if (interrupted && !closing.trim() && messageIds.length) {
      for (const messageId of messageIds)
        await deliver(() => this.bot.api.deleteMessage(this.chatId, messageId));
      flushAggregates();
      return { text: closing, interrupted, messageIds: [], segments: [] };
    }
    if (this.options.mode === "once" || !messageIds.length) {
      const once = await this.send(closing, replyToMessageId);
      flushAggregates();
      return {
        text: closing,
        interrupted,
        messageIds: once.messageIds,
        segments: once.segments,
      };
    }
    // 仅在定稿时执行插件的 `beforeSend`（每帧执行等于把钩子语义从「每条消息一次」改为
    // 「每次编辑一次」）。改写只影响发出的文本，`text` 仍为模型原文 —— 归档与上下文存原文。
    const { rendered, archived } = segmentTelegramText(
      this.guard(this.beforeSend ? await this.beforeSend(closing) : closing),
      this.options.maxChars,
      this.parseMode,
    );
    // 定稿分段按 chat 串行（docs/28 · L-TG-02）：只覆盖这一批，流中途的增量编辑一律在锁外 ——
    // 覆盖到那里会使同一群内的并发轮次退化为实质串行。
    await deliveryOrder.run(this.chatId, async () => {
      // 收尾同样走 deliver + 降级：此处抛出会将一轮已发出大半的回复整体记为 failed（docs/20 · W-TG-04）。
      for (let index = 0; index < rendered.length; index += 1) {
        if (index < messageIds.length) {
          await deliver(() => edit(messageIds[index]!, rendered[index]!));
          continue;
        }
        const at = Date.now();
        const sent = await deliver(() =>
          sendWithFallback(
            this.bot.api,
            this.chatId,
            rendered[index]!,
            {},
            this.parseMode,
            this.onParseFallback,
          ),
        );
        this.#emit({
          kind: "send",
          ok: sent !== null,
          ms: Date.now() - at,
          ...(sent ? { messageId: sent.message_id } : {}),
          chars: rendered[index]!.length,
          path: "final",
        });
        if (!sent) break;
        messageIds.push(sent.message_id);
      }
    });
    flushAggregates();
    return {
      text: closing,
      interrupted,
      messageIds,
      segments: rendered.length > 1 ? archived : [],
    };
  }
}
