import { createMemoryState } from '@chat-adapter/state-memory';
import { Chat, type StateAdapter } from 'chat';
import {
  createConversation,
  type FileStore,
  type InstalledTool,
  type Logger,
  type PromptSource,
  type Storage,
} from '../core/index.js';
import { LuoliTelegramAdapter, sdkLogger } from './adapter.js';
import { createTelegramBot, type ChatTarget } from './bot.js';
import type { TelegramConfig } from './config.js';
import type { TelegramRaw } from './message.js';

/**
 * 启动 Telegram 前端：Chat SDK 轮询收消息（平台状态放内存），每条消息交给 bot 处理。
 * 返回 stop()：停止轮询、收尾进行中的回复、关闭各会话。数据库由调用方关闭
 */
export async function startTelegram({
  config,
  model,
  prompts,
  tools = [],
  storage,
  fileStore,
  logger,
  pollTimeoutSeconds = 30,
  typingIntervalMs,
  wait,
  state = createMemoryState(),
}: {
  config: Pick<
    TelegramConfig,
    | 'token'
    | 'apiUrl'
    | 'chats'
    | 'users'
    | 'wakeWords'
    | 'errorText'
    | 'staleMs'
    | 'maxRetries'
    | 'timeouts'
    | 'maxSteps'
    | 'toolHistoryChars'
    | 'segments'
  >;
  model: Parameters<typeof createConversation>[0]['model'];
  /** 提示词来源，所有会话共用 */
  prompts: PromptSource;
  /** 装好的工具，所有会话共用 */
  tools?: readonly InstalledTool[];
  storage: Storage;
  fileStore: FileStore;
  logger: Logger;
  /** getUpdates 的长轮询时长（秒）；测试里调小 */
  pollTimeoutSeconds?: number;
  typingIntervalMs?: number;
  /** 等待合并的两个时长；测试里调小 */
  wait?: { idleMs: number; maxMs: number };
  /** Chat SDK 的平台状态（去重、轮询进度等），默认放内存；测试里可以换成记录调用的 */
  state?: StateAdapter;
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
  const bot = createTelegramBot({
    storage,
    open: async (conversationId, { checkIdleOnCreate }) =>
      createConversation({
        model,
        prompts,
        tools,
        store: await storage.openConversation(conversationId),
        fileStore,
        logger,
        maxRetries: config.maxRetries,
        timeouts: config.timeouts,
        maxSteps: config.maxSteps,
        toolHistoryChars: config.toolHistoryChars,
        segments: config.segments,
        conversationId,
        checkIdleOnCreate,
      }),
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
    bot: () => ({ id: adapter.botUserId, username: adapter.userName }),
    chats: config.chats,
    users: config.users,
    wakeWords: config.wakeWords,
    errorText: config.errorText,
    staleMs: config.staleMs,
    typingIntervalMs,
    wait,
  });

  // 不订阅任何线程：私聊进 onDirectMessage，@bot 进 onNewMention，其余进不带模式的
  // onNewMessage，每条消息恰好到其中一个。/命令 由适配器单独派发，也按普通消息处理
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
    async stop(): Promise<void> {
      await chat.shutdown();
      await bot.close();
      logger.info({}, 'telegram.stop');
    },
  };
}
