import { InputFile, type Api, type Bot } from "grammy";
import type { LogSink, TelegramTarget, TelegramToolBridge } from "@luoli/core";
import type { ArchiveRepository } from "@luoli/db";
import {
  capMentions,
  deliveryOrder,
  segmentTelegramText,
  sendWithFallback,
  type ParseFallbackInfo,
  type ParseMode,
} from "./output.js";
import {
  openAcpProgressCard,
  type AcpCardOptions,
  type AcpCardTarget,
  type AcpProgressCard,
} from "./acp-card.js";
import type { TelegramDeliveryEvent } from "./stream-output.js";

/**
 * Telegram 只接受这一组固定的 reaction emoji（Bot API `ReactionTypeEmoji`）；别的一律 400
 * `REACTION_INVALID`。放在本地挡一道是为了让模型拿到「可选哪些」而不是一句上游报错 ——
 * 内核提示词让它「工具报错只修正参数、最多重试两次」，没有候选集它只能瞎猜两次然后放弃。
 */
const REACTIONS = [
  "👍",
  "👎",
  "❤",
  "🔥",
  "🥰",
  "👏",
  "😁",
  "🤔",
  "🤯",
  "😱",
  "🤬",
  "😢",
  "🎉",
  "🤩",
  "🤮",
  "💩",
  "🙏",
  "👌",
  "🕊",
  "🤡",
  "🥱",
  "🥴",
  "😍",
  "🐳",
  "❤‍🔥",
  "🌚",
  "🌭",
  "💯",
  "🤣",
  "⚡",
  "🍌",
  "🏆",
  "💔",
  "🤨",
  "😐",
  "🍓",
  "🍾",
  "💋",
  "🖕",
  "😈",
  "😴",
  "😭",
  "🤓",
  "👻",
  "👨‍💻",
  "👀",
  "🎃",
  "🙈",
  "😇",
  "😨",
  "🤝",
  "✍",
  "🤗",
  "🫡",
  "🎅",
  "🎄",
  "☃",
  "💅",
  "🤪",
  "🗿",
  "🆒",
  "💘",
  "🙉",
  "🦄",
  "😘",
  "💊",
  "🙊",
  "😎",
  "👾",
  "🤷‍♂",
  "🤷",
  "🤷‍♀",
  "😡",
] as const;
/**
 * 变体选择符（U+FE0F）必须在比较前抹掉：`❤️`（带 VS16）与 Telegram 认的 `❤` 是两个字符串，
 * 而模型十有八九打出来的是带 VS16 的那个 —— 按字面比会把最常用的几个 emoji 全判成不支持。
 */
const canonical = new Map(
  REACTIONS.map((emoji) => [emoji.replaceAll("️", ""), emoji]),
);

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
  /**
   * 投递层的语义 span（`docs/10 §2` 的 `tg.send`）。`tg.api` 那条在 grammY 的 transformer 里，
   * 拿不到 turn 上下文（docs/28 · L-LOG-02），而这里 `TelegramTarget` 带着 turnId 与
   * 本次 `tool.call` 的 span id。可选：测试不必给。
   */
  log?: LogSink;
}

export class TelegramTools implements TelegramToolBridge {
  constructor(private readonly dependencies: TelegramToolsDependencies) {}

  /** 一次出站投递落一行。`method` 只用来说清是哪一种（sendMessage / sendPhoto / …）。 */
  #sent(
    target: TelegramTarget,
    method: string,
    ok: boolean,
    startedAt: number,
    data: Record<string, unknown>,
  ): void {
    this.dependencies.log?.event({
      level: ok ? "debug" : "warn",
      kind: "tg.send",
      summary: `${method} → ${target.chatId}`,
      traceId: target.turnId,
      ...(target.parentSpanId ? { parentSpanId: target.parentSpanId } : {}),
      chatId: target.chatId,
      durationMs: Math.round(performance.now() - startedAt),
      data: { method, ok, path: "tool", ...data },
    });
  }

  async sendMessage(target: TelegramTarget, text: string): Promise<object> {
    return this.guard(target, "sendMessage", async (api) => {
      // 三条出站路径都要过 @ 上限这道闸，不然它不是边界只是建议。
      const capped = capMentions(text, this.dependencies.maxMentions());
      const parseMode = this.dependencies.parseMode();
      const { rendered, archived } = segmentTelegramText(
        capped,
        this.dependencies.maxMessageChars(),
        parseMode,
      );
      if (!rendered.length) return { ok: false, error: "empty_text" };
      const messageIds: number[] = [];
      // 这一批分段按 chat 串行，理由与 `bot.ts` 的定稿分段同一条（docs/28 · L-TG-02）：一条消息
      // 被切成的那几段中间挤进别的轮次的 `sendMessage`，用户看到的就是错序。
      await deliveryOrder.run(target.chatId, async () => {
        for (const [index, part] of rendered.entries()) {
          const startedAt = performance.now();
          const sent = await sendWithFallback(
            api,
            target.chatId,
            part,
            this.thread(target),
            parseMode,
          );
          this.#sent(target, "sendMessage", true, startedAt, {
            messageId: sent.message_id,
            chars: part.length,
          });
          // 归档存渲染前的正文而不是 `part`：三条出站路径（这里、`bot.ts` 的兜底、流式）必须在
          // `messages.text` 里放同一种东西，否则同一张表里一半带 MarkdownV2 转义符。**分片时存
          // 该段自己那一份**（docs/28 · L-TG-03）。存的是 `capMentions` 之后的那份 —— 归档要与
          // 真正发出去的一致，另外两条路径也都是收口后的。
          this.archiveOutgoing(
            target,
            sent.message_id,
            sent.date,
            archived[index] ?? capped,
            "text",
            sent,
          );
          messageIds.push(sent.message_id);
        }
      });
      return { ok: true, messageIds };
    });
  }

  async sendPhoto(
    target: TelegramTarget,
    absolutePath: string,
    caption?: string,
  ): Promise<object> {
    return this.guard(target, "sendPhoto", async (api) => {
      const startedAt = performance.now();
      const sent = await api.sendPhoto(
        target.chatId,
        new InputFile(absolutePath),
        { ...this.thread(target), ...(caption ? { caption } : {}) },
      );
      this.#sent(target, "sendPhoto", true, startedAt, {
        messageId: sent.message_id,
        chars: caption?.length ?? 0,
      });
      this.archiveOutgoing(
        target,
        sent.message_id,
        sent.date,
        caption ?? "[图片]",
        "photo",
        sent,
      );
      return { ok: true, messageId: sent.message_id };
    });
  }

  async sendFile(
    target: TelegramTarget,
    absolutePath: string,
    caption?: string,
  ): Promise<object> {
    return this.guard(target, "sendDocument", async (api) => {
      const startedAt = performance.now();
      const sent = await api.sendDocument(
        target.chatId,
        new InputFile(absolutePath),
        { ...this.thread(target), ...(caption ? { caption } : {}) },
      );
      this.#sent(target, "sendDocument", true, startedAt, {
        messageId: sent.message_id,
        chars: caption?.length ?? 0,
      });
      this.archiveOutgoing(
        target,
        sent.message_id,
        sent.date,
        caption ?? `[文档 ${sent.document?.file_name ?? ""}]`,
        "document",
        sent,
      );
      return { ok: true, messageId: sent.message_id };
    });
  }

  async react(
    target: TelegramTarget,
    messageId: number,
    emoji: string,
  ): Promise<object> {
    const resolved = canonical.get(emoji.replaceAll("️", ""));
    if (!resolved)
      return {
        ok: false,
        error: "unsupported_emoji",
        hint: "Telegram 只接受固定的一组 reaction emoji",
        allowed: [...canonical.values()],
      };
    return this.guard(target, "setMessageReaction", async (api) => {
      const startedAt = performance.now();
      await api.setMessageReaction(target.chatId, messageId, [
        { type: "emoji", emoji: resolved },
      ]);
      this.#sent(target, "setMessageReaction", true, startedAt, {
        messageId,
        emoji: resolved,
      });
      return { ok: true, messageId, emoji: resolved };
    });
  }

  async pin(target: TelegramTarget, messageId: number): Promise<object> {
    return this.guard(target, "pinChatMessage", async (api) => {
      const startedAt = performance.now();
      await api.pinChatMessage(target.chatId, messageId);
      this.#sent(target, "pinChatMessage", true, startedAt, { messageId });
      return { ok: true, messageId };
    });
  }

  /**
   * 一次 ACP 运行的进度卡片（`docs/08 §6.1`）。**`null` = 没有 Telegram 入口** —— ACP 照跑，
   * 只是没有卡片：呈现层起不来不该让「起一台外部 agent」这件事失败，这也是 `catch` 兜到 `null`
   * 而不是往外抛的理由。
   *
   * `parseMode` / `maxMessageChars` / `intervalMs` 由调用方给，而不是在这里读 `dependencies`：
   * 调用方拿的是**本轮**那份合并后的配置（`output.*` 在 `perChat` 白名单里，`docs/11 §2.1`），
   * 而同一个会话里卡片与主回复必须是同一档渲染 —— 三条出站路径两种渲染的账已经付过一次了。
   */
  async openProgressCard(
    target: AcpCardTarget & { turnId?: string; parentSpanId?: string },
    options: AcpCardOptions,
  ): Promise<AcpProgressCard | null> {
    const bot = this.dependencies.bot();
    if (!bot) return null;
    try {
      // 不挂 `onDeliveryError`：send 失败那一跳已经有一条 `ok:false` 的 `tg.send`，edit 失败
      // 由聚合那一条带出来（`docs/10 §2`：`tg.edit` 一轮一条）。两处都挂等于同一次失败落两行。
      // `turnId` 在卡片里有第二个用途：取消按钮的 `callback_data`（`c:<turnId>`，`docs/08 §6.1`）。
      // 缺席时不挂按钮 —— 交回一个必然答「只有发起人或管理员可以取消」的按钮比没有按钮更坏。
      return await openAcpProgressCard(
        bot,
        {
          chatId: target.chatId,
          threadId: target.threadId,
          ...(target.turnId ? { turnId: target.turnId } : {}),
        },
        options,
        {
          onDelivery: (event) => this.#card(target, event),
          onParseFallback: (info) => this.#cardFallback(target, info),
        },
      );
    } catch {
      return null;
    }
  }

  /** 卡片的投递事件 → `tg.send` / `tg.edit`（`docs/10 §2`）。形状与 `bot.ts` 给 `TelegramOutput`
   *  挂的那个一致；`traceId` 只在调用方给了 turnId 时才有 —— 卡片本身不需要它。 */
  #card(
    target: { chatId: string; turnId?: string; parentSpanId?: string },
    event: TelegramDeliveryEvent,
  ): void {
    this.dependencies.log?.event({
      level: event.ok ? "debug" : "warn",
      kind: event.kind === "send" ? "tg.send" : "tg.edit",
      summary: `acp card ${event.kind}${event.count ? ` ×${event.count}` : ""} → ${target.chatId}`,
      ...(target.turnId ? { traceId: target.turnId } : {}),
      ...(target.parentSpanId ? { parentSpanId: target.parentSpanId } : {}),
      chatId: target.chatId,
      durationMs: event.ms,
      data: {
        method: event.kind === "send" ? "sendMessage" : "editMessageText",
        ok: event.ok,
        path: "tool",
        ...(event.messageId === undefined
          ? {}
          : { messageId: event.messageId }),
        ...(event.chars === undefined ? {} : { chars: event.chars }),
        ...(event.count === undefined ? {} : { editCount: event.count }),
        ...(event.path ? { frame: event.path } : {}),
        ...(event.error ? { error: event.error } : {}),
      },
    });
  }

  #cardFallback(
    target: { chatId: string; turnId?: string },
    info: ParseFallbackInfo,
  ): void {
    this.dependencies.log?.event({
      level: "warn",
      kind: "tg.parse_fallback",
      summary: `acp 卡片渲染被拒，已降级成纯文本${info.phase === "edit" ? "重编辑" : "重发"}`,
      ...(target.turnId ? { traceId: target.turnId } : {}),
      chatId: target.chatId,
      data: { chars: info.chars, error: info.error, phase: info.phase },
    });
  }

  /**
   * 上游报错一律转成 `ok:false`：抛出去会被注册表记成工具异常，模型看到的只有一句堆栈式的
   * `Call to "pinChatMessage" failed!`，而「bot 没有置顶权限」这种事它本可以据此换个做法。
   *
   * **吞掉的那一跳必须自己落一行 `tg.send`（失败档 warn，`docs/10 §2`）。** 不落的话「模型发的
   * 消息被 Telegram 拒收」在带 turn 上下文的日志里一个字都没有：`tg.api` 那条没有 traceId，
   * 回答不了「这一轮到底发出去了什么」（docs/28 · L-LOG-02）。`durationMs` 从进这道门算起 ——
   * 分段投递会在 `deliveryOrder` 里排队，而失败那一刻要的就是「这次工具调用等了多久才失败」。
   */
  private async guard(
    target: TelegramTarget,
    method: string,
    run: (api: Api) => Promise<object>,
  ): Promise<object> {
    const api = this.dependencies.bot()?.api;
    if (!api)
      return {
        ok: false,
        error: "telegram_unavailable",
        hint: "Telegram 入口未启用",
      };
    const startedAt = performance.now();
    try {
      return await run(api);
    } catch (error) {
      const hint = error instanceof Error ? error.message : String(error);
      this.#sent(target, method, false, startedAt, { error: hint });
      return { ok: false, error: "telegram_api_error", hint };
    }
  }

  private thread(target: TelegramTarget): Record<string, unknown> {
    return target.threadId === null
      ? {}
      : { message_thread_id: target.threadId };
  }

  /**
   * 追发出去的消息必须回写归档，理由和 bot.ts 里回复自己那条一样：不写的话 `read_messages`、
   * WebUI 会话页、以及「回复这条消息」的取回链路里都缺这一条，模型自己发过的东西下一轮就不见了。
   * `direction='out'` 让它天然不会被 `claimBackground` 当成群背景发言再认领一次。
   */
  private archiveOutgoing(
    target: TelegramTarget,
    tgMessageId: number,
    date: number | undefined,
    text: string,
    kind: string,
    raw: unknown,
  ): void {
    const info = this.dependencies.bot()?.botInfo;
    this.dependencies.archive.scope(target.chatId, target.threadId).append({
      chatId: target.chatId,
      messageThreadId: target.threadId,
      tgMessageId,
      direction: "out",
      fromKind: "bot",
      fromUserId: info ? String(info.id) : null,
      fromName: info?.first_name ?? null,
      fromUsername: info?.username ?? null,
      kind,
      text,
      tgDate: (date ?? Math.floor(Date.now() / 1000)) * 1000,
      raw,
      triggered: false,
      turnId: target.turnId,
    });
  }
}
