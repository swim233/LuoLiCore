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
  // `sv-SE` 输出 `2026-08-14 10:02`，恰为 doc §3.2 规定的格式；`zh-CN` 输出 `2026/08/14`。
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
 * 返回渲染后的文本行而非原始行对象：`read_messages` 默认取 50 条，使用行对象会额外消耗两千多 token 在
 * `chatId` / `direction` / `fromKind` / `triggered` / `triggerReason` 这些逐条相同、或对模型
 * 无用的字段上。模型真正需要的是发言人、时间、内容与被回复的消息，再加一个可用于
 * `get_message` 回查的 `#id`；附件元数据与完整回复链交由该工具提供，那才是单条详情的场景。
 *
 * 正文中的换行折叠为 `⏎`：该格式一条消息占一行，而多行正文可在结果中伪造出多条他人发言。
 * 整份结果另外处于 `untrusted()` 边界内（`untrustedOutput: true`），这一层负责保证格式本身不被撬开。
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
  // 回复标记必须换成归档 id：`reply_to_tg_message_id` 是 Telegram 的编号，与模型引用用的 `#id`
  // 不属于同一套编号。原样按 `#` 渲染时，模型据此调用 `get_message` 回查会取到另一条消息，或
  // 取不到任何结果，且无法察觉取错。换不到时不渲染该标记，宁可少一条线索。
  const replied = message.replyToTgMessageId
    ? options.replyIds?.get(message.replyToTgMessageId)
    : undefined;
  return `#${message.id}${options.withChat ? ` [chat:${message.chatId}]` : ""} [${formatMoment(message.tgDate, options.timezone)}] ${who}: ${body}${replied ? `   ↩︎#${replied}` : ""}`;
}

/** 将一批消息渲染成文本行，并一次性把回复指向的 Telegram 编号换成归档 id（而非逐条查询）。 */
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
