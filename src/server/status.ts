import type { TelegramLink } from '../telegram/app.js';
import type { LastReply, ServiceStatus } from './types.js';

/**
 * 洛璃服务的状态（ServiceStatus）：启动时间、Telegram 的连接、助手的名字与唤醒词、上次回复。
 * Telegram 启动好之后用 attachTelegram 接上，之后每次都从它读此刻的连接
 */
export function createStatus({
  startedAt,
  name,
  telegram,
  lastReply,
  now = () => new Date(),
}: {
  startedAt: Date;
  /** 助手的显示名（LUOLI_NAME） */
  name: string;
  /** 启动了 Telegram 时：它的唤醒词；没启动时不给 */
  telegram?: { wakeWords: readonly string[] };
  /** 上次回复（见 live.lastReply） */
  lastReply: () => LastReply | undefined;
  now?: () => Date;
}) {
  let link: (() => TelegramLink) | undefined;

  return {
    status(): ServiceStatus {
      const current = link?.();
      const last = lastReply();
      return {
        startedAt: startedAt.toISOString(),
        uptimeSeconds: Math.floor((now().getTime() - startedAt.getTime()) / 1000),
        telegram: {
          enabled: telegram !== undefined,
          connected: current?.connected ?? false,
          ...(current?.lastOnlineAt ? { lastOnlineAt: current.lastOnlineAt.toISOString() } : {}),
        },
        assistant: {
          name,
          wakeWords: [...(telegram?.wakeWords ?? [])],
          ...(current?.username ? { username: current.username } : {}),
        },
        ...(last ? { lastReply: last } : {}),
      };
    },

    /** Telegram 启动好了：之后从 read 读此刻的连接与 bot 的用户名 */
    attachTelegram(read: () => TelegramLink): void {
      link = read;
    },
  };
}

export type Status = ReturnType<typeof createStatus>;
