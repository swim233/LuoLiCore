import type { ArchivedMessage } from "@luoli/db";

function formatMoment(timestamp: number, timezone: string): string {
  const options = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  } as const;
  const render = (zone: string): string =>
    new Intl.DateTimeFormat("sv-SE", { ...options, timeZone: zone }).format(
      new Date(timestamp),
    );
  // `sv-SE` 给的是 `2026-08-14 10:02`，正好是 doc §3.2 那个格式；`zh-CN` 会给 `2026/08/14`。
  try {
    return render(timezone);
  } catch {
    return render("UTC");
  }
}

/**
 * `search_messages` / `read_messages` / `admin_search_messages` 的统一返回格式（docs/05 §3.2）：
 *
 *     #12841 [2026-08-14 10:02] 张三(@zhangsan): 今天去哪吃
 *     #12842 [2026-08-14 10:03] 李四: 隆福吧   ↩︎#12841
 *
 * 交回渲染好的行而不是原始行对象：`read_messages` 默认取 50 条，用行对象要多花两千多 token 在
 * `chatId` / `direction` / `fromKind` / `triggered` / `triggerReason` 这些每条都一样、或者对模型
 * 压根没用的字段上。模型真正要的是「谁、什么时候、说了什么、回复的哪条」，加一个能拿去
 * `get_message` 回查的 `#id` —— 附件元数据与完整回复链留给那个工具，那才是「放大看一条」。
 *
 * 正文里的换行折成 `⏎`：这个格式一条消息一行，而多行正文能在结果里伪造出好几条别人的发言。
 * 整份结果另外还在 `untrusted()` 边界里（`untrustedOutput: true`），这一层管的是格式本身不被撬开。
 */
export function citeArchivedMessage(
  message: ArchivedMessage,
  options: {
    timezone: string;
    replyIds?: Map<number, number>;
    withChat?: boolean;
  },
): string {
  const who =
    message.fromKind === "bot"
      ? "我"
      : `${message.fromName ?? message.fromUserId ?? "未知"}${message.fromUsername ? `(@${message.fromUsername})` : ""}`;
  const body = (message.text ?? `[${message.kind}]`).replaceAll("\n", " ⏎ ");
  // 回复标记要换成**归档 id**：`reply_to_tg_message_id` 是 Telegram 的编号，和模型引用用的 `#id`
  // 不是一套编号。原样当 `#` 渲染出去，模型照着 `get_message` 回查会取到另一条消息，或者什么都
  // 取不到 —— 而它没有办法知道自己拿错了。换不到就不渲染这个标记，宁可少一条线索。
  const replied = message.replyToTgMessageId
    ? options.replyIds?.get(message.replyToTgMessageId)
    : undefined;
  return `#${message.id}${options.withChat ? ` [chat:${message.chatId}]` : ""} [${formatMoment(message.tgDate, options.timezone)}] ${who}: ${body}${replied ? `   ↩︎#${replied}` : ""}`;
}

/** 一批消息渲染成行，顺带把回复指向的 Telegram 编号一次换成归档 id（不是逐条查）。 */
export function citeArchivedMessages(
  messages: readonly ArchivedMessage[],
  options: {
    timezone: string;
    withChat?: boolean;
    resolveReplies?: (tgMessageIds: readonly number[]) => Map<number, number>;
  },
): string[] {
  const pending = [
    ...new Set(
      messages
        .map((message) => message.replyToTgMessageId)
        .filter((value): value is number => typeof value === "number"),
    ),
  ];
  const replyIds =
    pending.length && options.resolveReplies
      ? options.resolveReplies(pending)
      : new Map<number, number>();
  return messages.map((message) =>
    citeArchivedMessage(message, {
      timezone: options.timezone,
      replyIds,
      ...(options.withChat ? { withChat: true } : {}),
    }),
  );
}
