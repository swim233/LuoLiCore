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
 * Telegram 只接受这一组固定的 reaction emoji（Bot API `ReactionTypeEmoji`），其余一律返回 400
 * `REACTION_INVALID`。本地拦截一道是为了让模型拿到候选集而非一句上游报错 ——
 * 内核提示词要求「工具报错只修正参数、最多重试两次」，没有候选集只能盲猜两次后放弃。
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
 * 变体选择符（U+FE0F）必须在比较前剥除：`❤️`（带 VS16）与 Telegram 接受的 `❤` 是两个不同字符串，
 * 而模型输出的通常是带 VS16 的形式 —— 按字面比较会把最常用的几个 emoji 全部判为不支持。
 */
const canonical = new Map(
  REACTIONS.map((emoji) => [emoji.replaceAll("️", ""), emoji]),
);

export interface TelegramToolsDependencies {
  /** 惰性取值：工具在 bot 构造之前即完成注册（`registerBuiltins` 先于 `createTelegramBot` 执行）。 */
  bot(): Bot | null;
  archive: ArchiveRepository;
  maxMessageChars(): number;
  /**
   * `output.maxMentions`。该路径此前不经过这道闸，导致投递侧收口只覆盖了三条出站路径中的两条：
   * 模型（或 `<untrusted-content>` 中被注入的指令）调用 `send_message` 即可绕过 @ 上限。
   */
  maxMentions(): number;
  /**
   * `output.parseMode`。该路径此前恒用默认的 MarkdownV2，导致运维将 `parseMode` 改为 `none`
   * 之后，`send_message` 发出的仍是转义过的 MarkdownV2 文本 —— 三条出站路径出现两种渲染。
   */
  parseMode(): ParseMode;
  /**
   * 投递层的语义 span（`docs/10 §2` 的 `tg.send`）。`tg.api` 位于 grammY 的 transformer 中，
   * 取不到 turn 上下文（docs/28 · L-LOG-02），而此处 `TelegramTarget` 携带 turnId 与
   * 本次 `tool.call` 的 span id。可选：测试无需提供。
   */
  log?: LogSink;
}

export class TelegramTools implements TelegramToolBridge {
  constructor(private readonly dependencies: TelegramToolsDependencies) {}

  /** 每次出站投递记录一行。`method` 用于区分具体方法（sendMessage / sendPhoto / …）。 */
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
      // 三条出站路径都必须经过 @ 上限这道闸，否则它只是建议而非边界。
      const capped = capMentions(text, this.dependencies.maxMentions());
      const parseMode = this.dependencies.parseMode();
      const { rendered, archived } = segmentTelegramText(
        capped,
        this.dependencies.maxMessageChars(),
        parseMode,
      );
      if (!rendered.length) return { ok: false, error: "empty_text" };
      const messageIds: number[] = [];
      // 本批分段按 chat 串行，理由同 `bot.ts` 的定稿分段（docs/28 · L-TG-02）：若在一条消息的
      // 各分段之间插入其他轮次的 `sendMessage`，用户看到的即为乱序。
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
          // 归档写入渲染前的正文而非 `part`：三条出站路径（本处、`bot.ts` 的兜底、流式）必须在
          // `messages.text` 中写入同一形态，否则同一张表内会有一半带 MarkdownV2 转义符。分片时
          // 写入该段自身对应的那一份（docs/28 · L-TG-03）。写入的是 `capMentions` 之后的文本 ——
          // 归档需与实际发出内容一致，另外两条路径同样是收口后的。
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
   * 单次 ACP 运行的进度卡片（`docs/08 §6.1`）。`null` 表示没有 Telegram 入口 —— ACP 正常执行，
   * 仅无卡片：呈现层不可用不应导致启动外部 agent 失败，这也是 `catch` 兜底为 `null` 而非向外
   * 抛出的原因。
   *
   * `parseMode` / `maxMessageChars` / `intervalMs` 由调用方传入，而非在此读取 `dependencies`：
   * 调用方持有的是本轮合并后的配置（`output.*` 位于 `perChat` 白名单内，`docs/11 §2.1`），
   * 且同一会话中卡片与主回复必须采用同一渲染档位 —— 渲染分叉的代价已经付过一次。
   */
  async openProgressCard(
    target: AcpCardTarget & { turnId?: string; parentSpanId?: string },
    options: AcpCardOptions,
  ): Promise<AcpProgressCard | null> {
    const bot = this.dependencies.bot();
    if (!bot) return null;
    try {
      // 不挂 `onDeliveryError`：send 失败已由一条 `ok:false` 的 `tg.send` 记录，edit 失败
      // 由聚合记录带出（`docs/10 §2`：`tg.edit` 每轮一条）。两处都挂会使同一次失败记录两行。
      // `turnId` 在卡片中有第二个用途：取消按钮的 `callback_data`（`c:<turnId>`，`docs/08 §6.1`）。
      // 缺失时不挂按钮 —— 提供一个必然回复「只有发起人或管理员可以取消」的按钮比不提供更差。
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

  /** 卡片投递事件 → `tg.send` / `tg.edit`（`docs/10 §2`）。形状与 `bot.ts` 为 `TelegramOutput`
   *  挂载的一致；`traceId` 仅在调用方提供 turnId 时存在 —— 卡片自身不依赖它。 */
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
   * 上游报错一律转为 `ok:false`：向外抛出会被注册表记为工具异常，模型只能看到堆栈式的
   * `Call to "pinChatMessage" failed!`，而「bot 没有置顶权限」这类信息本可据以改换做法。
   *
   * 被吞掉的这一跳必须自行记录一行 `tg.send`（失败档 warn，`docs/10 §2`）。否则「模型发出的
   * 消息被 Telegram 拒收」在带 turn 上下文的日志中完全不可见：`tg.api` 那条没有 traceId，
   * 无法回答本轮实际发出了什么（docs/28 · L-LOG-02）。`durationMs` 自进入本方法起计 ——
   * 分段投递会在 `deliveryOrder` 中排队，而失败时需要的正是本次工具调用等待多久才失败。
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
   * 主动发出的消息必须回写归档，理由同 bot.ts 中回写自身回复：不回写则 `read_messages`、
   * WebUI 会话页、以及「回复这条消息」的取回链路均缺失该条，模型自己发过的内容下一轮即丢失。
   * `direction='out'` 使其不会被 `claimBackground` 当作群背景发言重复认领。
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
