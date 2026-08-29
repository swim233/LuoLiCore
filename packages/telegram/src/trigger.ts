import type { Context } from "grammy";
import { checkWakeword, matchesWakeword } from "@luoli/core";

export type TriggerReason =
  "private" | "mention" | "reply" | "command" | "wakeword" | "ask";

export interface TriggerConfig {
  private: boolean;
  mention: boolean;
  reply: boolean;
  command: boolean;
  channels: boolean;
  wakewords: string[];
  wakewordMinLength: number;
  requireTextAfterMention: boolean;
  strictCommandSuffix?: boolean;
}

/**
 * 已注册 handler 的命令名。判定为 `command` 的消息不进入 AI 流程，只能由各自的 handler 响应；
 * 名字列在此处却没有 handler 时，用户发出的命令不会得到任何回复（`/start` 曾出现该问题，
 * docs/20 · W-TG-01）。`tests/trigger.test.ts` 断言本集合与 `bot.ts` 中 `bot.command(...)` 注册的名字
 * 一一对应。唯一例外是 `/ask`：按 docs/08 §8 它等价于 @bot，走 AI 流程而非 handler，故不在此列。
 * `/webui`（一次性登录链接）与 `/wake`（会话唤醒词）已移除，改由 WebUI 提供（docs/08 §8 🚧）。
 */
export const HANDLED_COMMANDS: ReadonlySet<string> = new Set([
  "start",
  "help",
  "new",
  "undo",
  "ctx",
  "cancel",
  "tasks",
  "model",
  "memory",
  "whoami",
  "whois",
  "grant",
  "revoke",
  "usage",
  "ping",
  // `/webui`、`POST /api/auth/token` 与 `issueLoginToken` 三者互相依赖：缺任何一个，该命令都不会有
  // 回复（docs/20 · W-TG-01 即由此产生）。`tests/api.contract.test.ts` 有一条断言把三者锁在一起。
  "webui",
]);

/** 从 offset 0 的 `bot_command` 实体解析命令名（转小写、去掉 `@suffix`）。非命令或后缀不匹配时返回 null。 */
export function commandNameOf(
  text: string,
  entities: ReadonlyArray<{ type: string; offset: number; length: number }>,
  botUsername: string,
  strictSuffix = false,
): string | null {
  const command = entities.find(
    (entity) => entity.type === "bot_command" && entity.offset === 0,
  );
  if (!command) return null;
  const [name, suffix] = text
    .slice(0, command.length)
    .toLocaleLowerCase()
    .slice(1)
    .split("@");
  if (!name) return null;
  return (
    suffix === undefined
      ? !strictSuffix
      : suffix === botUsername.toLocaleLowerCase()
  )
    ? name
    : null;
}

/**
 * `message` 需显式传入：编辑消息的内容位于 `ctx.editedMessage` 而非 `ctx.message`，只读后者会使任何
 * `edited_message` 更新恒返回 null，`bot.ts` 中的 `trigger.skipped` 因此成为不可达代码，一条都记不下
 * （docs/29 · M-TG-01）。不传时沿用 `ctx.message`，普通消息路径无需改动。
 */
export function matchTrigger(
  ctx: Context,
  config: TriggerConfig,
  botId: number,
  botUsername: string,
  message: Context["message"] = ctx.message,
): TriggerReason | null {
  const chat = ctx.chat;
  if (!chat || !message) return null;
  if (chat.type === "channel" && !config.channels) return null;
  const text = message.text ?? message.caption ?? "";
  const entities = message.entities ?? message.caption_entities ?? [];
  // 命令必须先判定：私聊分支若排在前面，`/new` 会被当作普通对话，既开一轮又执行 handler。
  // 反之，裸 `/` 前缀不能一律视为命令：私聊中的「/home/app 这个目录满了」应当正常回答。
  const command = commandNameOf(
    text,
    entities,
    botUsername,
    config.strictCommandSuffix,
  );
  if (command !== null) {
    // `/ask <text>`：docs/08 §8 明确其等价于 @bot，是唯一进入 AI 流程的命令。
    if (config.command && command === "ask") return "ask";
    if (HANDLED_COMMANDS.has(command)) return config.command ? "command" : null;
  }
  if (chat.type === "private") return config.private ? "private" : null;
  if (config.mention) {
    for (const entity of entities) {
      if (
        entity.type === "mention" &&
        text
          .slice(entity.offset, entity.offset + entity.length)
          .toLocaleLowerCase() === `@${botUsername.toLocaleLowerCase()}`
      ) {
        if (
          !config.requireTextAfterMention ||
          text
            .replace(
              text.slice(entity.offset, entity.offset + entity.length),
              "",
            )
            .trim()
        )
          return "mention";
      }
      if (entity.type === "text_mention" && entity.user.id === botId)
        return "mention";
    }
  }
  if (config.reply && message.reply_to_message?.from?.id === botId)
    return "reply";
  for (const wakeword of config.wakewords) {
    if (
      matchesWakeword(checkWakeword(wakeword, config.wakewordMinLength), text)
    )
      return "wakeword";
  }
  return null;
}
