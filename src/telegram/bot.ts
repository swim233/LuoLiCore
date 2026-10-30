import {
  DuplicateMessageError,
  type Conversation,
  type Logger,
  type MessageChunk,
  type Storage,
} from '../core/index.js';
import { conversationTitle, isAllowed, toAppendInput, type TelegramRaw } from './message.js';
import { splitMessage } from './split.js';
import { isTriggered, type BotIdentity } from './trigger.js';

/** 往哪个聊天发：论坛群里回到触发消息所在的话题 */
export type ChatTarget = { chatId: number; messageThreadId?: number };

/** 发往 Telegram 的两种操作；由 Chat SDK 的适配器实现，测试里可以换成假的 */
export type Sender = {
  /** 显示「正在输入」，Telegram 几秒后自动消失 */
  typing(target: ChatTarget): Promise<void>;
  /** 发一条纯文本；replyTo 为被引用消息的 id */
  send(target: ChatTarget, text: string, replyTo?: number): Promise<void>;
};

type Session = {
  conversationId: string;
  conversation: Conversation;
  /** 会话标题，用来判断群名是否变了 */
  title?: string;
  /** 每个会话两种状态：空闲、回复中 */
  replying?: Promise<void>;
};

/**
 * Telegram 前端的会话与回复逻辑，不依赖 Chat SDK：收到一条原始消息时
 * 判断白名单、记录、判断触发，空闲时在后台回复。
 */
export function createTelegramBot({
  storage,
  open,
  sender,
  logger,
  bot,
  chats,
  users,
  wakeWords,
  errorText,
  staleMs,
  typingIntervalMs = 4000,
}: {
  storage: Storage;
  /**
   * 为存储里的会话建核心的会话对象。checkIdleOnCreate：创建时是否按现在的时间补做空闲切段；
   * 收到消息时打开的不补做（可能是离线积压，按消息时间判断），启动补做时打开的才补做
   */
  open: (conversationId: string, options: { checkIdleOnCreate: boolean }) => Promise<Conversation>;
  sender: Sender;
  logger: Logger;
  /** 读 bot 当前的身份（启动后由 getMe 补上） */
  bot: () => BotIdentity;
  chats: ReadonlySet<string>;
  users: ReadonlySet<string>;
  wakeWords: string[];
  errorText: string;
  /** 触发消息的发送时间早于这么久之前（毫秒）时只记录、不回复 */
  staleMs: number;
  /** 生成期间每隔多久重发「正在输入」 */
  typingIntervalMs?: number;
}) {
  // 按 chat id；正在打开的也在这里，同一个聊天不会建两个会话
  const sessions = new Map<string, Promise<Session>>();
  // 关闭时中止还没完成的回复
  const stopping = new AbortController();
  // 一开始关闭就置位：之后不再打开会话（补做恰好在退出时进行，打开的会话会没人关闭）
  let closing = false;

  /** 已经打开好的会话（打开失败的不算） */
  async function openedSessions(): Promise<Session[]> {
    const all = await Promise.allSettled(sessions.values());
    return all.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
  }

  function sessionFor(raw: TelegramRaw): Promise<Session> {
    const chatId = String(raw.chat.id);
    let session = sessions.get(chatId);
    if (!session) {
      session = (async () => {
        const found = await storage.findConversation('telegram', chatId);
        if (found) {
          return {
            conversationId: found.id,
            conversation: await open(found.id, { checkIdleOnCreate: false }),
            title: found.title,
          };
        }
        const title = conversationTitle(raw.chat);
        const id = await storage.createConversation({
          platform: 'telegram',
          platformConversationId: chatId,
          title,
        });
        return {
          conversationId: id,
          conversation: await open(id, { checkIdleOnCreate: false }),
          title,
        };
      })();
      // 打开失败时不留下坏的条目，下一条消息再试
      session.catch(() => sessions.delete(chatId));
      sessions.set(chatId, session);
    }
    return session;
  }

  /** 群名变了（改群名的服务消息，或离线期间改过）：更新会话标题，下一段生效 */
  async function syncTitle(session: Session, raw: TelegramRaw): Promise<void> {
    if (raw.chat.type === 'private') return;
    const title = raw.new_chat_title ?? raw.chat.title;
    if (title === undefined || title === session.title) return;
    await storage.updateTitle(session.conversationId, title);
    session.title = title;
  }

  async function reply(session: Session, raw: TelegramRaw): Promise<void> {
    const target: ChatTarget = {
      chatId: raw.chat.id,
      messageThreadId: raw.is_topic_message ? raw.message_thread_id : undefined,
    };
    const fields = { conversationId: session.conversationId };
    const stopTyping = keepTyping(target, fields);
    let result: { ok: boolean; text: string };
    try {
      result = await readReply(session.conversation.reply({ abortSignal: stopping.signal }));
    } finally {
      stopTyping();
    }
    if (stopping.signal.aborted) return;
    if (!result.ok) {
      // 错误详情由核心记进日志；群里只发固定提示
      await send(target, errorText, raw.message_id, fields);
      return;
    }
    const chunks = splitMessage(result.text).filter((chunk) => chunk.trim());
    for (const [index, chunk] of chunks.entries()) {
      // 第一段引用触发消息，后面的接着发
      const sent = await send(target, chunk, index === 0 ? raw.message_id : undefined, fields);
      if (!sent) break;
    }
  }

  /** 从现在起显示「正在输入」，每隔一段时间重发，直到调用返回的函数 */
  function keepTyping(target: ChatTarget, fields: object): () => void {
    let failed = false;
    const typing = () => {
      sender.typing(target).catch((error: unknown) => {
        // 网络不通时每次都会失败，一次回复只记一条
        if (failed) return;
        failed = true;
        logger.warn(
          { ...fields, method: 'sendChatAction', error: describe(error) },
          'telegram.send_failed',
        );
      });
    };
    typing();
    const timer = setInterval(typing, typingIntervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  /** 发送失败只记日志，不重试；返回是否发出 */
  async function send(
    target: ChatTarget,
    text: string,
    replyTo: number | undefined,
    fields: object,
  ): Promise<boolean> {
    try {
      await sender.send(target, text, replyTo);
      return true;
    } catch (error) {
      logger.warn(
        { ...fields, method: 'sendMessage', error: describe(error) },
        'telegram.send_failed',
      );
      return false;
    }
  }

  return {
    /** 处理一条原始消息。等到记录完成才返回，回复在后台进行；从不抛错 */
    async handle(raw: TelegramRaw): Promise<void> {
      try {
        // 编辑过的消息（第 7 步处理）
        if (raw.edit_date !== undefined) return;
        if (!isAllowed(raw, { chats, users })) {
          logger.info(
            {
              chatType: raw.chat.type,
              chatId: String(raw.chat.id),
              userId: raw.from && String(raw.from.id),
            },
            'telegram.ignored',
          );
          return;
        }
        const session = await sessionFor(raw);
        await syncTitle(session, raw);
        const input = toAppendInput(raw);
        if (!input) return;
        try {
          await session.conversation.append(input);
        } catch (error) {
          // Telegram 重发了已经处理过的更新（如进程在确认前退出）：已记录过，也已按当时的状态回复过
          if (!(error instanceof DuplicateMessageError)) throw error;
          logger.info(
            { conversationId: session.conversationId, messageId: input.platformMessageId },
            'telegram.duplicate',
          );
          return;
        }
        if (!isTriggered(raw, { bot: bot(), wakeWords })) return;
        // 太久以前的触发（如离线期间积压的）：只记录，不回复，也不发「正在输入」
        const ageMs = Date.now() - raw.date * 1000;
        if (ageMs > staleMs) {
          logger.info(
            {
              conversationId: session.conversationId,
              chatId: String(raw.chat.id),
              messageId: input.platformMessageId,
              ageMinutes: Math.floor(ageMs / 60_000),
            },
            'telegram.stale',
          );
          return;
        }
        // 回复中再被触发：只记录，不回复
        if (session.replying || stopping.signal.aborted) return;
        session.replying = reply(session, raw)
          .catch((error: unknown) => {
            logger.error(
              { conversationId: session.conversationId, error: describe(error) },
              'telegram.reply_failed',
            );
          })
          .finally(() => {
            session.replying = undefined;
          });
      } catch (error) {
        logger.error(
          { chatId: String(raw.chat.id), error: describe(error) },
          'telegram.handle_failed',
        );
      }
    },

    /**
     * 打开白名单内还没打开的已知会话，核心按现在的时间补做漏掉的空闲切段。
     * 在离线积压处理完之后调用：积压里出现过的会话已经按消息时间判断过，不再打开
     */
    async openKnown(): Promise<number> {
      if (closing) return 0;
      const known = await storage.listConversations('telegram');
      // 读列表期间开始关闭了
      if (closing) return 0;
      let opened = 0;
      for (const { id, platformConversationId, title } of known) {
        if (!platformConversationId || sessions.has(platformConversationId)) continue;
        // 已移出白名单的聊天收不到消息，不必为它补做摘要
        if (!chats.has(platformConversationId) && !users.has(platformConversationId)) continue;
        opened++;
        sessions.set(
          platformConversationId,
          open(id, { checkIdleOnCreate: true }).then((conversation) => ({
            conversationId: id,
            conversation,
            title,
          })),
        );
      }
      await Promise.all(sessions.values());
      return opened;
    },

    /** 正在进行的回复都结束（测试用） */
    async idle(): Promise<void> {
      for (const session of await Promise.all(sessions.values())) await session.replying;
    },

    /**
     * 关闭：不再开始新的回复；进行中的回复最多等 graceMs，仍未完成的中止（不发出）；
     * 再关闭各会话（中止进行中的摘要）
     */
    async close(graceMs = 10_000): Promise<void> {
      closing = true;
      const opened = await openedSessions();
      const replies = Promise.all(opened.map((session) => session.replying));
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        replies,
        new Promise((resolve) => {
          timer = setTimeout(resolve, graceMs);
        }),
      ]);
      clearTimeout(timer);
      stopping.abort();
      await replies;
      await Promise.all(opened.map((session) => session.conversation.close()));
    },
  };
}

/** 读完回复流：拼出最终正文。流式重试的 reset-step 之后重新开始；出现 error 段就是失败 */
async function readReply(
  stream: ReadableStream<MessageChunk>,
): Promise<{ ok: boolean; text: string }> {
  let text = '';
  let ok = true;
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') text += chunk.delta;
    else if (chunk.type === 'reset-step') text = '';
    else if (chunk.type === 'error') ok = false;
  }
  return { ok, text };
}

// 只取错误的类型与消息，不把原始对象交给日志（可能带请求正文）
function describe(error: unknown): { type?: string; message: string } {
  return error instanceof Error
    ? { type: error.name, message: error.message }
    : { message: String(error) };
}
