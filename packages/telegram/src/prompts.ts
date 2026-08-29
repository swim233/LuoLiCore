import type { Bot } from "grammy";
import type {
  ApprovalOutcome,
  LogSink,
  PromptChannel,
  PromptPost,
  PromptResolution,
  PromptTarget,
} from "@luoli/core";

export interface TelegramPromptDependencies {
  /** 惰性取值：`PendingPrompts` 在 bot 构造之前即完成装配（形状同 `TelegramTools`）。 */
  bot(): Bot | null;
  /**
   * 判定该会话中按钮是否可裁决。群内的有效角色封顶 `trusted`，`decidableBy:'owner'` 在任何群里
   * 都无人可满足 —— 因此判据就是「这个会话是不是 owner 私聊」。审批投递侧据此发送，两处必须
   * 同一口径：判的会话与按钮落地的会话不是同一个，等于可用性判据与可裁决性判据脱钩。
   * 缺省时退化为仅判定 bot 是否就绪，即可用性判据宽于可裁决性判据。
   */
  decidable?(chatId: string): boolean;
  log?: LogSink;
}

/**
 * `PromptChannel` 的 Telegram 实现（`docs/05 §6.1`）。core 只定义接口 —— 依赖方向
 * `core → telegram` 不允许，由 `main.ts` 通过 `bot()` getter 注入本实现，
 * 存在性即开关：没有 Telegram 入口时 `available()` 返回 false。
 */
export class TelegramPromptChannel implements PromptChannel {
  constructor(private readonly dependencies: TelegramPromptDependencies) {}

  /**
   * 判据是 bot 已就绪，而非有人在线：后者无法检测，且 owner 的手机推送不要求其在屏幕前。
   * 传入 `chatId` 时追加判定该会话是否可裁决，即它是否为 owner 私聊 —— 省略该判定会使可用性宽于
   * 可裁决性，表现为发出一排无法点击的按钮，随后本轮空等满 ttlMs。传入的必须是按钮**实际落地**
   * 的那个会话（审批传的是 owner 私聊，不是发起人会话）。
   */
  available(chatId?: string): boolean {
    if (this.dependencies.bot() === null) return false;
    return (
      chatId === undefined || this.dependencies.decidable?.(chatId) !== false
    );
  }

  /**
   * 不传 `parse_mode`、不分段。键盘挂在单条消息上，被 `segmentTelegramText` 切成两条会导致其中
   * 一条没有按钮；而正文中任何 `*` `_` `[` 都会使 MarkdownV2 返回 400，`sendWithFallback` 的降级
   * 会重发消息 —— 届时屏幕上存在两条各带一套按钮的消息，键盘状态失控。正文的硬截断在 core 侧
   * （`PROMPT_TEXT_MAX`），本方法只负责发送。
   */
  async post(post: PromptPost): Promise<PromptTarget | null> {
    const api = this.dependencies.bot()?.api;
    if (!api) return null;
    const sent = await api.sendMessage(post.chatId, post.text, {
      reply_markup: {
        inline_keyboard: [
          post.buttons.map((button) => ({
            text: button.label,
            callback_data: button.token,
          })),
        ],
      },
      ...(post.threadId === null ? {} : { message_thread_id: post.threadId }),
    });
    this.dependencies.log?.event({
      level: "debug",
      kind: "prompt.posted",
      summary: `${post.kind} → ${post.chatId}`,
      chatId: post.chatId,
      data: {
        kind: post.kind,
        messageId: sent.message_id,
        options: post.buttons.length,
      },
    });
    return { chatId: post.chatId, messageId: sent.message_id };
  }

  /**
   * 收尾一条提示。带 `text` 时走 `editMessageText`：撤键盘与改正文合并为同一次调用 —— 省略
   * `reply_markup` 即撤除键盘，拆成两次调用会在 `perChatPerMinute` 的 20 个槽位中占用两次，
   * 而表达的是同一件事。不带 `text` 时仅撤键盘（`editMessageReplyMarkup`）。
   *
   * 正文遵循 `post()` 的同一规则：不传 `parse_mode`（单个 `*` 即 400，且此处没有 `sendWithFallback`
   * 那样的降级路径）。失败一律吞掉并记 debug：用户删除该消息、或同一条消息被二次收尾
   * （`message is not modified`）都会返回 400，这两种情形都不应影响任何等待者。
   */
  async settle(target: PromptTarget, text?: string): Promise<void> {
    const api = this.dependencies.bot()?.api;
    if (!api) return;
    try {
      await (text === undefined
        ? api.editMessageReplyMarkup(target.chatId, target.messageId)
        : api.editMessageText(target.chatId, target.messageId, text));
    } catch (error) {
      this.dependencies.log?.event({
        level: "debug",
        kind: "prompt.settle_failed",
        summary:
          text === undefined
            ? "keyboard removal rejected"
            : "receipt rewrite rejected",
        chatId: target.chatId,
        data: {
          messageId: target.messageId,
          rewrote: text !== undefined,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }
}

/**
 * 审批收场后的回执文案（`docs/13 · AC-APV-004`）。原正文中「N 秒内无人处理将自动拒绝」在任何一种
 * 收场之后都已不成立 —— 保留在屏幕上属于 `docs/21 §12` 所清理的界面陈述失真，故撤键盘的同时
 * 替换正文。
 *
 * 五种收场的文案必须彼此可区分：读者需要能分辨「在 Telegram 裁决」「在 WebUI 裁决」「超时无人处理」
 * 「本轮被取消」「进程重启导致作废」。前两种表示已有决定，后三种表示无人决定，模型侧交回的 hint
 * 也按此划分（`DENIED_HINT` / `EXPIRED_HINT` / `CANCELLED_HINT`）。
 *
 * 展示 `channel` 而非 `decided_by`：后者在 Telegram 路径上是 `user:<tgId>`，该数字对群内其他人没有
 * 意义，且会泄露 owner 的 Telegram id。裁决权仅授予 owner，故裁决者是常量。
 */
export function approvalSettledText(
  tool: string,
  outcome: ApprovalOutcome,
): string {
  // `decide()` 路径必然带 `channel`；缺失时整体省略括号，而不是输出「（owner ）」。
  const who =
    outcome.channel === "telegram"
      ? "（owner 在 Telegram 裁决）"
      : outcome.channel === "webui"
        ? "（owner 在 WebUI 审批页裁决）"
        : "";
  switch (outcome.kind) {
    case "approved":
      return `✅ ${tool} 已批准${who}，正在执行。`;
    case "denied":
      return `🚫 ${tool} 被拒绝${who}，未执行。`;
    case "expired":
      return `⌛ ${tool} 的审批窗口已超时，无人裁决，按拒绝处理，未执行。`;
    case "cancelled":
      return `⛔ ${tool} 等待审批期间本轮被取消，审批一并作废，未执行。`;
    case "stale":
      return `♻️ ${tool} 的审批因进程重启已作废，未执行。需要时请重新发起。`;
  }
}

/**
 * `approvals.state` → 启动扫描阶段（`staleKeyboards()`）应输出的收场。
 *
 * 只分两档，因为该阶段能观察到的真实状态也只有两种：`DatabaseApprovalBroker` 的构造函数先将
 * TTL 已过的 pending 行标记为 `expired`（「窗口到期」在重启前后均成立），剩余 pending 行属于
 * 「重启及时、TTL 未到」—— 等待者是进程内 Promise，无法跨重启，故这类行既未被裁决也永远不会被唤醒。
 * `approved` / `denied` 带着未清空的 `tg_message_id` 存活至此只有一种来源：`decide()` 已改状态、
 * `finish()` 尚未清该列时进程终止。这类行同样归入 `stale` —— 决定虽已作出，但承接它的轮次已不存在，
 * 对用户而言「已作废、需重新发起」才是准确陈述。
 */
export function staleApprovalOutcome(state: string): ApprovalOutcome {
  return { kind: state === "expired" ? "expired" : "stale" };
}

/**
 * 单次点击的应答文案。`show_alert` 只用于本次点击未产生效果的情形 —— 成功路径用轻提示，
 * 弹窗会使每次正常裁决多一步点击。
 *
 * 「已经处理过了」与「已过期（进程重启过）」传达的信息不同：前者表明已有人（可能是点击者本人）
 * 作出决定，后者表明该请求从未被受理。
 */
export function promptAckText(resolution: PromptResolution): {
  text: string;
  show_alert?: boolean;
} {
  switch (resolution.status) {
    case "accepted":
      return { text: `已${resolution.label}` };
    case "settled":
      return { text: "该请求已处理。", show_alert: true };
    case "invalid":
      return { text: "该选项不属于此请求。", show_alert: true };
    case "stale":
      return {
        text: "该请求已处理或已过期，本次点击无效。",
        show_alert: true,
      };
    case "unknown":
      return {
        text: "该请求已过期（进程已重启），需重新发起。",
        show_alert: true,
      };
    case "forbidden":
      return {
        text:
          resolution.required === "owner"
            ? "仅 owner 可裁决该请求。"
            : "仅发起人或 owner 可裁决该请求。",
        show_alert: true,
      };
  }
}
