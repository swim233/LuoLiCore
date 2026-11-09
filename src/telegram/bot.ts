import {
  DuplicateMessageError,
  editMessage,
  type Conversation,
  type Logger,
  type MessageChunk,
  type ReplyOptions,
  type Storage,
  type Trigger,
} from '../core/index.js';
import { editedText, toAppendInput } from './content.js';
import { conversationTitle, isAllowed, isAllowedChat, type TelegramRaw } from './message.js';
import { splitMessage } from './split.js';
import { isTriggered, type BotIdentity } from './trigger.js';

/** 往哪个聊天发：论坛群里回到触发消息所在的话题 */
export type ChatTarget = { chatId: number; messageThreadId?: number };

/** 发往 Telegram 的两种操作；由 Chat SDK 的适配器实现，测试里可以换成假的 */
export type Sender = {
  /** 显示「正在输入」，Telegram 几秒后自动消失 */
  typing(target: ChatTarget): Promise<void>;
  /**
   * 发一条纯文本；replyTo 为被引用消息的 id。被引用的消息不在了（删了、id 不对）时照样发出，
   * 只是不带引用（适配器带上 allow_sending_without_reply）
   */
  send(target: ChatTarget, text: string, replyTo?: number): Promise<void>;
};

/** 任务到点触发的回复带上的任务：「此刻」据此标出是哪个任务到点 */
export type RoundTask = { id: number; ref: string; action: string };

/**
 * bot 用的会话对象：核心的会话，reply 多收一个 tasks（任务到点触发的回复是哪几个任务）。
 * 洛璃服务里是会话管理给的会话对象，tasks 交给「此刻」，不交给核心
 */
export type BotConversation = Omit<Conversation, 'reply'> & {
  reply(
    options?: ReplyOptions & { tasks?: readonly RoundTask[] },
  ): ReturnType<Conversation['reply']>;
};

/**
 * 为存储里的会话取核心的会话对象。checkIdleOnCreate：创建时是否按现在的时间补做空闲切段；
 * 收到消息时打开的不补做（可能是离线积压，按消息时间判断），启动补做时、任务到点时打开的才补做
 */
export type OpenConversation = (
  conversationId: string,
  options: { checkIdleOnCreate: boolean },
) => Promise<BotConversation>;

/**
 * 一次任务到点（ADR-0010）：洛璃服务已经把事件写进会话，交给 bot 当作一次触发。
 * 同时到点的几个任务按先后；platformMessageId 是任务来源消息的 Telegram message_id，回复引用它
 */
export type TelegramDue = {
  conversationId: string;
  tasks: ReadonlyArray<RoundTask & { platformMessageId?: string }>;
};

/**
 * 一次触发：群里一条触发了的消息（连同写进核心后的触发者），或者任务到点（发到哪个群、
 * 是哪几个任务、引用哪条）
 */
type Incoming =
  | { kind: 'message'; raw: TelegramRaw; trigger: Trigger }
  | { kind: 'due'; target: ChatTarget; tasks: RoundTask[]; quote?: number };

/**
 * 一轮回复里只有 Telegram 前端知道的几件事，告诉洛璃服务（「此刻」显示用）：
 * - wait：被触发，进入等待合并；
 * - again：回复中又被触发，这次发出后再回复一次；
 * - end：这一轮结束（回复都发完了，或者等待被放弃、没有回复，如退出时）。
 * 回复本身的进展由洛璃服务从回复的流里旁听，不经这里
 */
export type RoundNotice = { type: 'wait' | 'again' | 'end'; conversationId: string };

/** 等待合并：触发后这么久内没有新消息才开始生成 */
export const waitMs = 2000;
/** 等待合并：从第一条触发算起最多等这么久 */
export const maxWaitMs = 8000;

/**
 * 一轮回复：从被触发进入等待，到最后一次回复发出。一轮之内「正在输入」一直在发
 */
type Round = {
  state: 'waiting' | 'replying';
  /** 回复发到哪里：最后一条触发消息所在的聊天（与话题）；只有任务到点时是会话所在的群 */
  target: ChatTarget;
  /** 回复引用哪条：最后一条触发消息，最后是任务到点时是任务的来源消息；没有时不引用 */
  quote?: number;
  /**
   * 下一次回复要回应的触发者与到点的任务，按先后。回复开始时取走：回复中又被触发时，
   * 补的那次只看回复期间新来的
   */
  triggers: Trigger[];
  tasks: RoundTask[];
  /** 回复中又被触发：这次发出后再回复一次 */
  again: boolean;
  /** 第一条触发的时间，等待的上限从这里算 */
  startedAt: number;
  timer?: NodeJS.Timeout;
  stopTyping: () => void;
  /** 这一轮结束时兑现 */
  done: Promise<void>;
  finish: () => void;
};

type Session = {
  conversationId: string;
  conversation: BotConversation;
  /** 会话标题，用来判断群名是否变了 */
  title?: string;
  /** 每个会话三种状态：空闲（没有 round）、等待、回复中 */
  round?: Round;
};

/**
 * Telegram 前端的会话与回复逻辑，不依赖 Chat SDK：收到一条原始消息（或一组相册）时
 * 判断白名单、记录（编辑则改历史）、判断触发；被触发后等待合并，再在后台回复。
 */
export function createTelegramBot({
  storage,
  open,
  sender,
  download,
  albumOf = (raw) => [raw],
  logger,
  bot,
  chats,
  users,
  wakeWords,
  errorText,
  staleMs,
  typingIntervalMs = 4000,
  wait = { idleMs: waitMs, maxMs: maxWaitMs },
  onRound,
}: {
  storage: Storage;
  /** 为存储里的会话取核心的会话对象，每个聊天只取一次 */
  open: OpenConversation;
  sender: Sender;
  /** 按 Telegram 的 file_id 下载文件 */
  download: (fileId: string) => Promise<Uint8Array>;
  /** 相册（带 media_group_id）的全部条目，按原顺序；适配器攒齐后只派发其中一条 */
  albumOf?: (raw: TelegramRaw) => TelegramRaw[];
  logger: Logger;
  /** 读 bot 当前的身份（启动后由 getMe 补上） */
  bot: () => BotIdentity;
  chats: ReadonlySet<string>;
  users: ReadonlySet<string>;
  wakeWords: string[];
  errorText: string;
  /** 触发消息的发送时间早于这么久之前（毫秒）时只记录、不回复 */
  staleMs: number;
  /** 等待与生成期间每隔多久重发「正在输入」 */
  typingIntervalMs?: number;
  /** 等待合并的两个时长；测试里调小 */
  wait?: { idleMs: number; maxMs: number };
  /** 一轮回复里的几件事（见 RoundNotice）；出错只记日志，不影响 Telegram */
  onRound?: (notice: RoundNotice) => void;
}) {
  // 按 chat id；正在打开的也在这里，同一个聊天不会建两个会话
  const sessions = new Map<string, Promise<Session>>();
  // 关闭时中止还没完成的回复
  const stopping = new AbortController();
  // 一开始关闭就置位：之后不再打开会话、不再开始新的一轮
  let closing = false;

  function notify(type: RoundNotice['type'], session: Session): void {
    if (!onRound) return;
    try {
      onRound({ type, conversationId: session.conversationId });
    } catch (error) {
      logger.warn(
        { conversationId: session.conversationId, notice: type, error: describe(error) },
        'telegram.notify_failed',
      );
    }
  }

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

  /** 编辑：改历史里那条消息的正文，不触发回复，也不影响等待计时 */
  async function edit(raw: TelegramRaw): Promise<void> {
    const chatId = String(raw.chat.id);
    const messageId = String(raw.message_id);
    const info = await storage.findConversation('telegram', chatId);
    const edited =
      info &&
      (await editMessage(await storage.openConversation(info.id), {
        platformMessageId: messageId,
        text: editedText(raw),
        editedAt: new Date((raw.edit_date ?? raw.date) * 1000).toISOString(),
      }));
    if (!info || !edited) {
      // 没记录过（如加入白名单之前发的）
      logger.info({ chatId, messageId }, 'telegram.edit_missing');
      return;
    }
    logger.info({ conversationId: info.id, messageId }, 'telegram.edited');
  }

  /**
   * 记录一条新消息、或任务到点之后：等待中则并进这一轮、重置计时；被触发时，空闲进入等待，
   * 回复中记下「还有人在等」。incoming 为这次触发（未过期且触发了的消息，或任务到点），
   * 只记录的消息为 undefined
   */
  function onMessage(session: Session, incoming: Incoming | undefined): void {
    const { round } = session;
    if (round?.state === 'waiting') {
      if (incoming) add(round, incoming);
      schedule(session, round);
      return;
    }
    if (!incoming || closing) return;
    if (round?.state === 'replying') {
      round.again = true;
      add(round, incoming);
      notify('again', session);
      return;
    }
    let finish!: () => void;
    const done = new Promise<void>((resolve) => (finish = resolve));
    const target = incoming.kind === 'message' ? targetOf(incoming.raw) : incoming.target;
    const created: Round = {
      state: 'waiting',
      target,
      triggers: [],
      tasks: [],
      again: false,
      startedAt: Date.now(),
      stopTyping: keepTyping(target, { conversationId: session.conversationId }),
      done,
      finish,
    };
    add(created, incoming);
    session.round = created;
    notify('wait', session);
    schedule(session, created);
  }

  /** 一次触发并进这一轮：记下触发者或任务；回复引用它，发到它所在的聊天 */
  function add(round: Round, incoming: Incoming): void {
    if (incoming.kind === 'message') {
      round.triggers.push(incoming.trigger);
      round.target = targetOf(incoming.raw);
      round.quote = incoming.raw.message_id;
    } else {
      round.tasks.push(...incoming.tasks);
      round.quote = incoming.quote;
    }
  }

  /** 等待计时：重置为 wait.idleMs，但不超过从第一条触发算起的 wait.maxMs */
  function schedule(session: Session, round: Round): void {
    clearTimeout(round.timer);
    const delay = Math.min(wait.idleMs, round.startedAt + wait.maxMs - Date.now());
    round.timer = setTimeout(() => void replyRound(session, round), Math.max(0, delay));
  }

  /**
   * 等待结束：回复；期间又被触发就接着再回一次，引用期间最后一条触发。每次回复取走到这时为止的
   * 触发者与到点的任务
   */
  async function replyRound(session: Session, round: Round): Promise<void> {
    round.state = 'replying';
    try {
      do {
        round.again = false;
        const { target, quote, triggers, tasks } = round;
        round.triggers = [];
        round.tasks = [];
        await reply(session, { target, quote, triggers, tasks });
        // 开始关闭后不再开始新的生成：宽限期只等进行中的那次
      } while (round.again && !closing);
    } catch (error) {
      logger.error(
        { conversationId: session.conversationId, error: describe(error) },
        'telegram.reply_failed',
      );
    } finally {
      endRound(session, round);
    }
  }

  function endRound(session: Session, round: Round): void {
    clearTimeout(round.timer);
    round.stopTyping();
    if (session.round === round) session.round = undefined;
    round.finish();
    notify('end', session);
  }

  /**
   * 一次回复，分条发出：每一步的文字在这一步的模型输出结束时发出。这一步调了工具时，
   * 在它的第一个工具段出现时发（核心在请求正常结束后才放出工具段，之前的文字已经齐了）；
   * 最后一步的文字在这一步结束时发。没有文字的步不发。每条都引用 quote（没有时不引用）。
   * 流中途重试只清掉这一步还没发出的文字；失败时失败那一步的文字不发，之前发出的保留，
   * 再发失败提示。群里看到的正好是核心写进历史的那些完成的步。
   * 触发者交给核心（工具据此知道是谁让做的），到点的任务交给会话管理（「此刻」标出）
   */
  async function reply(
    session: Session,
    {
      target,
      quote,
      triggers,
      tasks,
    }: { target: ChatTarget; quote?: number; triggers: Trigger[]; tasks: RoundTask[] },
  ): Promise<void> {
    const fields = { conversationId: session.conversationId };
    // 这一步还没发出的文字
    let pending = '';
    let failed = false;
    const flush = async () => {
      const text = pending;
      pending = '';
      // 关闭时被中止的回复不再发出
      if (stopping.signal.aborted) return;
      const chunks = splitMessage(text).filter((chunk) => chunk.trim());
      for (const [index, chunk] of chunks.entries()) {
        // 第一段引用触发消息，后面的接着发
        const sent = await send(target, chunk, index === 0 ? quote : undefined, fields);
        if (!sent) break;
      }
    };
    const stream = session.conversation.reply({
      abortSignal: stopping.signal,
      triggers,
      ...(tasks.length > 0 ? { tasks } : {}),
    });
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') pending += chunk.delta;
      else if (chunk.type === 'reset-step') pending = '';
      else if (chunk.type === 'error') {
        failed = true;
        pending = '';
      } else if (startsToolCall(chunk) || (chunk.type === 'finish-step' && !failed)) {
        await flush();
      }
    }
    if (stopping.signal.aborted) return;
    // 错误详情由核心记进日志；群里只发固定提示
    if (failed) await send(target, errorText, quote, fields);
  }

  /** 从现在起显示「正在输入」，每隔一段时间重发，直到调用返回的函数 */
  function keepTyping(target: ChatTarget, fields: object): () => void {
    let failed = false;
    const typing = () => {
      sender.typing(target).catch((error: unknown) => {
        // 网络不通时每次都会失败，一轮只记一条
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

  /**
   * 到点时找 bot 里这个群的会话，还没有时打开（服务刚启动、这个群还没人说话），和群里来消息时
   * 用同一张表。正在关闭时不再打开，为 undefined
   */
  async function sessionById(
    conversationId: string,
    chatId: string,
    title: string | undefined,
  ): Promise<Session | undefined> {
    let session = sessions.get(chatId);
    if (!session) {
      if (closing) return undefined;
      // 到点按现在的时间：创建时补做漏掉的空闲切段（会话管理里多半已经打开，这时不起作用）
      session = open(conversationId, { checkIdleOnCreate: true }).then((conversation) => ({
        conversationId,
        conversation,
        title,
      }));
      session.catch(() => sessions.delete(chatId));
      sessions.set(chatId, session);
    }
    return session;
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
    /**
     * 处理一条原始消息（相册由适配器攒齐后只派发一条，各条由 albumOf 取回）。
     * 等到记录完成才返回，等待与回复在后台进行；从不抛错
     */
    async handle(raw: TelegramRaw): Promise<void> {
      try {
        // 相册先取回各条（白名单外的也要取走）；编辑只改那一条
        const raws = raw.media_group_id && raw.edit_date === undefined ? albumOf(raw) : [raw];
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
        if (raw.edit_date !== undefined) {
          await edit(raw);
          return;
        }
        const session = await sessionFor(raw);
        await syncTitle(session, raw);
        const fields = { conversationId: session.conversationId };
        const input = await toAppendInput(raws, {
          download,
          // 只记文件种类与大小：文件地址含 token
          onDownloadFailed: (image) =>
            logger.warn(
              { ...fields, kind: image.kind, size: image.size },
              'telegram.download_failed',
            ),
          onImageRejected: (image, size) =>
            logger.warn({ ...fields, kind: image.kind, size }, 'telegram.image_rejected'),
        });
        if (!input) return;
        let message: Awaited<ReturnType<BotConversation['append']>>;
        try {
          message = await session.conversation.append(input);
        } catch (error) {
          // Telegram 重发了已经处理过的更新（如进程在确认前退出）：已记录过，也已按当时的状态回复过
          if (!(error instanceof DuplicateMessageError)) throw error;
          logger.info({ ...fields, messageId: input.platformMessageId }, 'telegram.duplicate');
          return;
        }
        // 相册任一条触发即整条触发，回复引用相册的第一条
        const [first] = raws as [TelegramRaw, ...TelegramRaw[]];
        let trigger = raws.some((r) => isTriggered(r, { bot: bot(), wakeWords }))
          ? first
          : undefined;
        // 太久以前的触发（如离线期间积压的）：只记录，不回复，也不发「正在输入」
        const ageMs = Date.now() - first.date * 1000;
        if (trigger && ageMs > staleMs) {
          logger.info(
            {
              ...fields,
              chatId: String(raw.chat.id),
              messageId: input.platformMessageId,
              ageMinutes: Math.floor(ageMs / 60_000),
            },
            'telegram.stale',
          );
          trigger = undefined;
        }
        onMessage(
          session,
          trigger && {
            kind: 'message',
            raw: trigger,
            // 相册的发言人与消息 id 取第一条，和回复引用的是同一条
            trigger: {
              author: input.author,
              messageId: message.id,
              platformMessageId: input.platformMessageId,
            },
          },
        );
      } catch (error) {
        logger.error(
          { chatId: String(raw.chat.id), error: describe(error) },
          'telegram.handle_failed',
        );
      }
    },

    /**
     * 任务到点（ADR-0010）：事件已经写进会话，当作一次触发，走等待合并那一套（空闲时等待合并，
     * 等待中并进这一轮，回复中这次发出后再回复一次），回复引用最后一个任务的来源消息。
     * 发到会话的平台 id（chat id）那个群。以下情况不回复，只记一行 telegram.due_skipped
     * （会话 id、任务 id、原因），事件已经在历史里，不撤回：
     * - no_chat：会话不是 Telegram 的，或者取不到 chat id；
     * - not_allowed：这个群（私聊则那个用户）现在不在白名单里，比如建任务之后被移出了；
     * - closing：正在关闭，不再开始新的一轮。
     * 过期触发的规则只管群里来的消息，这里不看。马上返回，不等合并、不等回复：
     * 任务服务里排着的建任务、取消任务都在等它。从不抛错
     */
    due({ conversationId, tasks }: TelegramDue): void {
      const fields = { conversationId, tasks: tasks.map((task) => task.id) };
      const skip = (reason: 'no_chat' | 'not_allowed' | 'closing', extra: object = {}) =>
        logger[reason === 'no_chat' ? 'warn' : 'info'](
          { ...fields, reason, ...extra },
          'telegram.due_skipped',
        );
      void (async () => {
        if (closing) return skip('closing');
        const overview = await storage.overview(conversationId, { textChars: 0 });
        const chatId =
          overview?.platform === 'telegram' ? overview.platformConversationId : undefined;
        if (chatId === undefined || !Number.isSafeInteger(Number(chatId))) {
          return skip('no_chat', { platform: overview?.platform });
        }
        if (!isAllowedChat(chatId, { chats, users })) return skip('not_allowed');
        const session = await sessionById(conversationId, chatId, overview?.title);
        if (!session || closing) return skip('closing');
        logger.info(fields, 'telegram.due');
        const source = tasks.at(-1)?.platformMessageId;
        onMessage(session, {
          kind: 'due',
          target: { chatId: Number(chatId) },
          tasks: tasks.map(({ id, ref, action }) => ({ id, ref, action })),
          quote: source !== undefined && /^\d+$/.test(source) ? Number(source) : undefined,
        });
      })().catch((error: unknown) => {
        logger.error({ ...fields, error: describe(error) }, 'telegram.due_failed');
      });
    },

    /**
     * 打开白名单内还没打开的已知会话，核心按现在的时间补做漏掉的空闲切段。
     * 在离线积压（含相册）处理完之后调用：积压里的会话已经打开，按消息之间的间隔判断
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

    /** 等待中与回复中的都结束（测试用） */
    async idle(): Promise<void> {
      for (const session of await openedSessions()) await session.round?.done;
    },

    /**
     * 关闭：不再开始新的一轮；等待中的直接放弃；回复中的最多等 graceMs，仍未完成的中止
     * （不发出）；再关闭各会话（中止进行中的摘要）
     */
    async close(graceMs = 10_000): Promise<void> {
      closing = true;
      const opened = await openedSessions();
      for (const session of opened) {
        if (session.round?.state === 'waiting') endRound(session, session.round);
      }
      const rounds = Promise.all(opened.map((session) => session.round?.done));
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        rounds,
        new Promise((resolve) => {
          timer = setTimeout(resolve, graceMs);
        }),
      ]);
      clearTimeout(timer);
      stopping.abort();
      await rounds;
      await Promise.all(opened.map((session) => session.conversation.close()));
    },
  };
}

/** 回复发到触发消息所在的聊天；论坛群里回到它所在的话题 */
function targetOf(trigger: TelegramRaw): ChatTarget {
  return {
    chatId: trigger.chat.id,
    messageThreadId: trigger.is_topic_message ? trigger.message_thread_id : undefined,
  };
}

/** 一次工具调用在回复流里的头一个段：参数开始流出、完整的调用、或不合规的调用 */
function startsToolCall(chunk: MessageChunk): boolean {
  return (
    chunk.type === 'tool-input-start' ||
    chunk.type === 'tool-input-available' ||
    chunk.type === 'tool-input-error'
  );
}

// 只取错误的类型与消息，不把原始对象交给日志（可能带请求正文）
function describe(error: unknown): { type?: string; message: string } {
  return error instanceof Error
    ? { type: error.name, message: error.message }
    : { message: String(error) };
}
