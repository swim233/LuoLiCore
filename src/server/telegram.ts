import { taskRef, type Logger, type Storage } from '../core/index.js';
import { startTelegram } from '../telegram/app.js';
import type { TelegramConfig } from '../telegram/config.js';
import type { Events } from './events.js';
import type { Live } from './live.js';
import type { Sessions } from './sessions.js';
import type { Status } from './status.js';
import type { TaskService } from './tasks/service.js';

/**
 * 在洛璃服务里启动 Telegram 前端：会话对象从会话管理取；等待合并、回复中又被触发等通知交给「此刻」；
 * 连上、断开 Telegram 时推 status 事件。启动好之后状态改从它读连接，并推一次 status
 * （这时已经拿到 bot 的用户名）。启动期间的连接变化不单独推，由启动好后的那一次带上。
 * 给了任务服务时，启动好之后登记 Telegram 的到点入口：交给 bot 当作一次触发，马上返回。
 * 其余参数原样交给 startTelegram（测试里调小轮询、等待的时长）
 */
export async function startTelegramFrontend({
  config,
  sessions,
  storage,
  logger,
  live,
  status,
  events,
  tasks,
  ...options
}: {
  config: TelegramConfig;
  sessions: Pick<Sessions, 'open'>;
  /** 包过一层的存储（写入有通知） */
  storage: Storage;
  logger: Logger;
  live: Pick<Live, 'round'>;
  status: Status;
  /** 网页服务关着时没有 */
  events?: Pick<Events, 'broadcast'>;
  /** 任务服务：登记到点入口 */
  tasks?: Pick<TaskService, 'setEntrance'>;
} & Pick<
  Parameters<typeof startTelegram>[0],
  'pollTimeoutSeconds' | 'typingIntervalMs' | 'wait' | 'state'
>) {
  let started = false;
  const announce = () => events?.broadcast('status', status.status());
  const telegram = await startTelegram({
    config,
    open: (conversationId, openOptions) => sessions.open(conversationId, openOptions),
    storage,
    logger,
    onRound: (notice) => live.round(notice),
    onConnectionChange: () => {
      if (started) announce();
    },
    ...options,
  });
  status.attachTelegram(() => telegram.link());
  tasks?.setEntrance('telegram', ({ conversationId, tasks: due }) =>
    telegram.bot.due({
      conversationId,
      tasks: due.map((task) => ({ ...task, ref: taskRef(task.id) })),
    }),
  );
  started = true;
  announce();
  return telegram;
}
