import { createMemoryState } from '@chat-adapter/state-memory';
import { Chat, type StateAdapter } from 'chat';
import type { Logger, Storage } from '../core/index.js';
import { LuoliTelegramAdapter, sdkLogger } from './adapter.js';
import {
  createTelegramBot,
  type ChatTarget,
  type OpenConversation,
  type RoundNotice,
} from './bot.js';
import type { TelegramConfig } from './config.js';
import type { TelegramRaw } from './message.js';

/** 和 Telegram 的连接（洛璃服务的状态里用） */
export type TelegramLink = {
  /** 连得上 Telegram：最近一次拉取更新成功 */
  connected: boolean;
  /** 最近一次拉取更新成功的时间；还没成功过时没有 */
  lastOnlineAt?: Date;
  /** bot 的用户名（不带 @）；还没拿到 bot 的身份（getMe 没成功过）时没有 */
  username?: string;
};

/** 启动时登记的指令菜单（setMyCommands） */
export const menuCommands = [
  { command: 'compact', description: '压缩上下文：之前的对话并成摘要' },
  { command: 'clear', description: '清空上下文：忘掉之前的对话，不能撤销' },
] as const;

/**
 * 启动 Telegram 前端：Chat SDK 轮询收消息（平台状态放内存），每条消息交给 bot 处理。
 * 会话对象由 open 提供（洛璃服务里是会话管理）。
 * 返回 stop()：停止轮询、收尾进行中的回复，再对各会话对象调 close()。数据库由调用方关闭；
 * link()：此刻和 Telegram 的连接
 */
export async function startTelegram({
  config,
  open,
  storage,
  logger,
  pollTimeoutSeconds = 30,
  typingIntervalMs,
  wait,
  state = createMemoryState(),
  onRound,
  onConnectionChange,
}: {
  config: TelegramConfig;
  /** 按会话 id 取核心的会话对象，见 createTelegramBot */
  open: OpenConversation;
  /** 找会话、建会话、改标题、编辑消息用 */
  storage: Storage;
  logger: Logger;
  /** getUpdates 的长轮询时长（秒）；测试里调小 */
  pollTimeoutSeconds?: number;
  typingIntervalMs?: number;
  /** 等待合并的两个时长；测试里调小 */
  wait?: { idleMs: number; maxMs: number };
  /** Chat SDK 的平台状态（去重、轮询进度等），默认放内存；测试里可以换成记录调用的 */
  state?: StateAdapter;
  /** 一轮回复里的等待合并、回复中又被触发、这一轮结束，见 RoundNotice */
  onRound?: (notice: RoundNotice) => void;
  /** 连上、断开 Telegram 时调用（启动期间第一次连上也算），读 link() 得到此刻的连接 */
  onConnectionChange?: () => void;
}) {
  const adapter = new LuoliTelegramAdapter({
    botToken: config.token,
    apiUrl: config.apiUrl,
    mode: 'polling',
    longPolling: { timeout: pollTimeoutSeconds },
    // 显式给出，免得适配器去读 TELEGRAM_* 环境变量：白名单由前端自己判断
    allowedUserIds: [],
    mentionOnReply: false,
    logger: sdkLogger(logger, 'telegram'),
  });
  adapter.onConnectionChange = onConnectionChange && (() => onConnectionChange());
  const chat = new Chat({
    // 只是占位：适配器启动时用 getMe 拿到真正的用户名
    userName: 'bot',
    adapters: { telegram: adapter },
    state,
    // 不加锁、不排队：每条消息都要记录，回复中的状态由前端自己管
    concurrency: 'concurrent',
    logger: sdkLogger(logger),
  });

  const threadId = ({ chatId, messageThreadId }: ChatTarget) =>
    adapter.encodeThreadId({ chatId: String(chatId), messageThreadId });
  // bot 的用户名（不带 @）：拿到 bot 的身份（getMe 成功过）之前 userName 是占位的 bot，不算
  const username = () => (adapter.botUserId ? adapter.userName : undefined);
  const bot = createTelegramBot({
    storage,
    open,
    sender: {
      typing: (target) => adapter.startTyping(threadId(target)),
      // 传字符串：适配器按纯文本发送，不转 Markdown
      send: async (target, text, replyTo) => {
        if (replyTo === undefined) await adapter.postMessage(threadId(target), text);
        else await adapter.reply(threadId(target), String(replyTo), text);
      },
    },
    download: (fileId) => adapter.download(fileId),
    albumOf: (raw) => adapter.takeAlbum(raw),
    logger,
    bot: () => ({ id: adapter.botUserId, username: username() }),
    chats: config.chats,
    users: config.users,
    wakeWords: config.wakeWords,
    errorText: config.errorText,
    staleMs: config.staleMs,
    typingIntervalMs,
    wait,
    onRound,
  });

  // 不订阅任何线程：私聊进 onDirectMessage，@bot 进 onNewMention，其余进不带模式的
  // onNewMessage，每条消息恰好到其中一个。/命令 由适配器单独派发（开头是 bot_command 实体、没有
  // @ 或 @ 的是本 bot 时只走 onSlashCommand，不再进上面三个），同样交给 handle：/compact、/clear
  // 由 bot 认成指令，其余照普通消息处理
  const handle = (raw: unknown) => bot.handle(raw as TelegramRaw);
  chat.onDirectMessage((_thread, message) => handle(message.raw));
  chat.onNewMention((_thread, message) => handle(message.raw));
  chat.onNewMessage((_thread, message) => handle(message.raw));
  chat.onSlashCommand((event) => handle(event.raw));

  await chat.initialize();
  logger.info(
    {
      botUserId: adapter.botUserId,
      chats: config.chats.size,
      users: config.users.size,
    },
    'telegram.start',
  );
  // 登记指令菜单：每次启动一次，不拖住启动；失败（网络、token）只记日志，不重试
  const commandsRegistered = adapter.setCommands(menuCommands).then(
    () => logger.info({ commands: menuCommands.length }, 'telegram.commands_registered'),
    (error: unknown) => {
      logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'telegram.commands_failed',
      );
    },
  );
  // 离线积压（含相册）处理完之后，再打开其余的已知会话补做空闲切段。积压里的会话在收到消息时
  // 已经打开，按消息之间的间隔判断；先补做的话会按「距今」在停机前最后一条与积压之间多切一段
  const caughtUp = adapter.caughtUp
    .then(() => bot.openKnown())
    .then((opened) => logger.info({ opened }, 'telegram.caught_up'))
    .catch((error: unknown) => {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        'telegram.catch_up_failed',
      );
    });

  return {
    bot,
    adapter,
    /** 离线积压处理完、其余会话也已打开（测试用） */
    caughtUp,
    /** 指令菜单登记完（成功或失败都算，测试用） */
    commandsRegistered,
    link(): TelegramLink {
      return {
        connected: adapter.connected,
        lastOnlineAt: adapter.lastPolledAt,
        username: username(),
      };
    },
    async stop(): Promise<void> {
      await chat.shutdown();
      await bot.close();
      logger.info({}, 'telegram.stop');
    },
  };
}
