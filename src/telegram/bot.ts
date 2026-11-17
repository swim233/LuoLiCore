import {
  ConversationBusyError,
  DuplicateMessageError,
  editMessage,
  type Author,
  type ClearResult,
  type CompactResult,
  type Conversation,
  type Logger,
  type MessageChunk,
  type ReplyOptions,
  type Storage,
  type Trigger,
} from '../core/index.js';
import { parseCommand, type TelegramCommand } from './command.js';
import { editedText, toAppendInput } from './content.js';
import { plainWithFooter, usageFooter, type MessageEntity } from './footer.js';
import { markdownBlocks } from './markdown.js';
import {
  conversationTitle,
  displayName,
  isAllowed,
  isAllowedChat,
  type TelegramRaw,
} from './message.js';
import { richMessage, RichMessageError, type InputRichMessage } from './rich.js';
import { splitMessage, splitRich, telegramMessageLimit, type RichPiece } from './split.js';
import { isTriggered, type BotIdentity } from './trigger.js';

/** 往哪个聊天发：论坛群里回到触发消息所在的话题 */
export type ChatTarget = { chatId: number; messageThreadId?: number };

/** 发往 Telegram 的几种操作；由 Chat SDK 的适配器实现，测试里可以换成假的 */
export type Sender = {
  /** 显示「正在输入」，Telegram 几秒后自动消失 */
  typing(target: ChatTarget): Promise<void>;
  /**
   * 发一条纯文本的普通消息；replyTo 为被引用消息的 id。被引用的消息不在了（删了、id 不对）时
   * 照样发出，只是不带引用（适配器带上 allow_sending_without_reply）。
   * entities 是文字里的格式标记（尾部的斜体），offset、length 对着 text 原样算；有它时文字要原样
   * 发出，不能被改动。没有时和以前一样
   */
  send(
    target: ChatTarget,
    text: string,
    replyTo?: number,
    entities?: readonly MessageEntity[],
  ): Promise<void>;
  /**
   * 发一条富文本消息（sendRichMessage），引用的规则同 send。服务端不认识这个接口、Telegram 拒收
   * 这一条时抛 RichMessageError（unsupported、rejected），由调用方改发普通消息；别的失败原样抛出
   */
  sendRich(target: ChatTarget, message: InputRichMessage, replyTo?: number): Promise<void>;
};

/**
 * 任务到点触发的回复带上的任务：「此刻」据此标出是哪个任务到点。event：监听任务写的是哪种事件
 * （monitor 查到了新的东西，monitor-failed 连续查不到）；定时任务没有。decide：处理方式是自行决定的
 * 监听任务查到了新的（见 decideRound）
 */
export type RoundTask = {
  id: number;
  ref: string;
  action: string;
  event?: 'monitor' | 'monitor-failed';
  decide?: true;
};

/**
 * 这一轮是不是「自行决定」的回复（ADR-0014）：触发全是带 decide 的任务，没有人的触发。这样的回复
 * 整条攒到最后再发：洛璃回了约定的标记时（finish 段的 metadata 带 discarded）什么都不发。
 * 规则同洛璃服务会话管理里的 decideRound（那边据此让核心认标记），两边拿的是同样的触发者与任务
 */
export function decideRound(tasks: readonly RoundTask[], triggers: readonly Trigger[]): boolean {
  return tasks.length > 0 && tasks.every((task) => task.decide === true) && triggers.length === 0;
}

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

/** 指令的结果：核心给的，或者失败 */
type CommandOutcome = CompactResult | ClearResult | 'failed';

/** 群里看到的提示；被中止（服务退出）时不发 */
const commandReplies: Record<Exclude<CommandOutcome, 'aborted' | 'failed'>, string> = {
  cleared: '已清空上下文',
  'already-empty': '上下文已经是空的',
  compacted: '已压缩',
  'nothing-to-compact': '没有可压缩的内容',
};
const failedReplies: Record<TelegramCommand, string> = { compact: '压缩失败', clear: '清空失败' };

/** 排在会话里的一条指令（压缩、清空） */
type QueuedCommand = {
  kind: TelegramCommand;
  /** 指令那条消息：提示引用它，发到它所在的聊天（与话题） */
  raw: TelegramRaw;
  /** 执行人：发指令的人 */
  by: Author;
  /** 收到的时刻（Date.now()） */
  receivedAt: number;
  /** 开始执行的时刻；还在等时没有 */
  startedAt?: number;
  /** 中止进行中的压缩（关闭时） */
  abort: AbortController;
};

type Session = {
  conversationId: string;
  conversation: BotConversation;
  /** 会话标题，用来判断群名是否变了 */
  title?: string;
  /** 每个会话三种状态：空闲（没有 round）、等待、回复中 */
  round?: Round;
  /**
   * 指令队列，按收到的先后：第一条在执行（有 startedAt）或在等，其余的在等。一轮回复还没结束时
   * 都等着；一轮结束、或前一条执行完，开始下一条
   */
  commands: QueuedCommand[];
  /** 正在执行的那条指令结束时兑现 */
  running?: Promise<void>;
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
  rich,
  usage,
  now = () => performance.now(),
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
  /** 回复发富文本消息；false 时发普通消息，和以前一样 */
  rich: boolean;
  /** 回复的最后一条消息末尾带一行用量（尾部）；false 时不带 */
  usage: boolean;
  /** 量回复用时的时钟（毫秒，只用差值）；测试里换成可控的 */
  now?: () => number;
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
  // 回复先试富文本消息：开着富文本，而且这次运行里还没发现服务端不认识这个接口
  let richAvailable = rich;

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

  function newSession(
    conversationId: string,
    conversation: BotConversation,
    title: string | undefined,
  ): Session {
    return { conversationId, conversation, title, commands: [] };
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
          const conversation = await open(found.id, { checkIdleOnCreate: false });
          return newSession(found.id, conversation, found.title);
        }
        const title = conversationTitle(raw.chat);
        const id = await storage.createConversation({
          platform: 'telegram',
          platformConversationId: chatId,
          title,
        });
        return newSession(id, await open(id, { checkIdleOnCreate: false }), title);
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

  /**
   * 收到的富文本消息转换出错（这条记成「[不支持的消息]」）：日志一行，只有消息 id 和错误的类型，
   * 不带内容
   */
  function richUnreadable(fields: object, raw: TelegramRaw, error: unknown): void {
    logger.warn(
      {
        ...fields,
        messageId: String(raw.message_id),
        error: { type: error instanceof Error ? error.name : typeof error },
      },
      'telegram.rich_unreadable',
    );
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
        text: editedText(raw, {
          onRichUnreadable: (error) => richUnreadable({ conversationId: info.id }, raw, error),
        }),
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
    // 这一轮全部结束：轮到排着的指令（正在关闭时不开始）
    runCommands(session);
  }

  /**
   * 一次回复，分条发出：每一步的文字在这一步的模型输出结束时发出。
   * - 调了工具的步：工具段之前的话在第一个工具段出现时发（核心在请求正常结束后才放出工具段，之前的
   *   文字已经齐了）；工具段之后又说的话在这一步的 finish-step 时发。这一步不会是最后一步（核心
   *   执行完工具一定再请求一次，收尾的那步不提供工具），所以都不带尾部。
   * - 没调工具的步：finish-step 时先留着，看下一个段：是 finish（回复正常结束）就是最后一条，带上
   *   尾部发出；是 abort 就不发（中止的不发）；是别的（又开始了一步、请求重试、出错）就照原样发出、
   *   不带尾部，这是兜底。流结束了都没有 finish 的也不发。
   * 没有文字的步不发；最后一步没有文字时没有地方挂尾部，这次就不显示。一步的文字拆成几条时，
   * 第一条引用 quote（没有时不引用），后面的不引用。流中途重试只清掉这一步还没发出的文字；失败时
   * 失败那一步的文字不发，之前发出的保留，再发失败提示。群里看到的正好是核心写进历史的那些完成的步。
   * 一步的文字怎么拆成几条见 piecesOf，每条怎么发见 deliver；尾部挂在最后一条。失败提示总是普通
   * 消息，不解析、不带尾部。用时从调用 reply() 之前量到 finish 段到达，不含等待合并、不含发最后一条。
   * 触发者交给核心（工具据此知道是谁让做的），到点的任务交给会话管理（「此刻」标出）。
   * 「自行决定」的回复（见 decideRound）：本来要发的每一条先按先后攒着（「正在输入」照常），流结束时
   * 再看：回了约定的标记（finish 段带 discarded）就一条都不发；否则攒下的照原样发出（出错时之后再发
   * 失败提示），和普通回复发出的内容、先后一样，只是都在最后才发
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
    const decide = decideRound(tasks, triggers);
    // 「自行决定」的回复攒着的几条（文字、尾部），流结束时再决定发不发
    const kept: Array<{ text: string; footer?: string }> = [];
    let discarded = false;
    // 流以 abort 段结束（只有服务退出时会有）
    let aborted = false;
    // 这一步还没发出的文字
    let pending = '';
    // 结束了的一步的文字，等下一个段决定带不带尾部
    let held: string | undefined;
    // 这一步出现过工具段：finish-step 时直接发，不留
    let toolInStep = false;
    let failed = false;
    const sendNow = async (text: string, footer?: string) => {
      // 关闭时被中止的回复不再发出；全是空白的不发
      if (stopping.signal.aborted || !text.trim()) return;
      const pieces = piecesOf(text);
      for (const [index, piece] of pieces.entries()) {
        // 第一条引用触发消息，后面的接着发；尾部挂在最后一条
        const last = index === pieces.length - 1;
        const sent = await deliver(target, piece, {
          replyTo: index === 0 ? quote : undefined,
          footer: last ? footer : undefined,
          fields,
        });
        if (!sent) break;
      }
    };
    // 普通回复马上发；「自行决定」的回复先攒着
    const flush = async (text: string, footer?: string) => {
      if (decide) kept.push({ text, ...(footer === undefined ? {} : { footer }) });
      else await sendNow(text, footer);
    };
    const startedAt = now();
    const stream = session.conversation.reply({
      abortSignal: stopping.signal,
      triggers,
      ...(tasks.length > 0 ? { tasks } : {}),
    });
    for await (const chunk of stream) {
      // 正常完成：「自行决定」的回复回了约定的标记时 finish 段带着 discarded
      if (chunk.type === 'finish') discarded = chunk.messageMetadata?.discarded === true;
      if (chunk.type === 'abort') aborted = true;
      if (held !== undefined) {
        const text = held;
        held = undefined;
        if (chunk.type === 'finish') {
          const footer = usage
            ? usageFooter(chunk.messageMetadata?.usage, now() - startedAt)
            : undefined;
          await flush(text, footer);
          continue;
        }
        // 中止的不发；别的段说明还没结束（又开始了一步，或出错），这一条照原样发出
        if (chunk.type !== 'abort') await flush(text);
      }
      if (chunk.type === 'text-delta') pending += chunk.delta;
      else if (chunk.type === 'start-step') toolInStep = false;
      else if (chunk.type === 'reset-step') {
        // 这一步重新生成：之前的输出作废（核心只在请求正常结束后放出工具段，所以这时其实不会有）
        pending = '';
        toolInStep = false;
      } else if (chunk.type === 'error') {
        failed = true;
        pending = '';
      } else if (startsToolCall(chunk)) {
        toolInStep = true;
        const text = pending;
        pending = '';
        await flush(text);
      } else if (chunk.type === 'finish-step' && !failed) {
        const text = pending;
        pending = '';
        // 调了工具的步后面还有一步，直接发；别的步留着等下一个段。没有可发的字时不留
        if (toolInStep) await flush(text);
        else if (text.trim()) held = text;
      }
    }
    // Telegram 在关了；或者这是「自行决定」的回复而且被中止了，攒下的一条都不发。服务退出时总是
    // 会话管理先中止回复（Telegram 要先等轮询停下才开始它的宽限），那时这里的 stopping 还没中止
    if (stopping.signal.aborted || (decide && aborted)) return;
    // 「自行决定」的回复：回了标记就都不发，否则把攒下的按先后发出
    if (decide) {
      if (discarded) logger.info({ ...fields, kept: kept.length }, 'telegram.decide_discarded');
      else for (const { text, footer } of kept) await sendNow(text, footer);
    }
    // 错误详情由核心记进日志；群里只发固定提示
    if (failed) await send(target, errorText, quote, fields);
  }

  // 不属于哪个会话的后台任务（还没有会话的聊天里回的提示）：idle、close 等它们
  const background = new Set<Promise<unknown>>();
  function track(task: Promise<unknown>): void {
    background.add(task);
    void task.finally(() => background.delete(task));
  }

  /**
   * 指令结束（或不执行）时记一行 telegram.command：会话 id（还没有会话时是 chat id）、哪条指令、
   * 执行人的 id、结果、等了多久；开始执行过的还有执行了多久（到核心给出结果为止）。
   * 不记正文，不记名字
   */
  function logCommand(
    command: { kind: TelegramCommand; by: Author; receivedAt: number; startedAt?: number },
    result: CommandOutcome | 'stale' | 'closing',
    fields: object,
    endedAt = Date.now(),
  ): void {
    const { startedAt, receivedAt } = command;
    logger.info(
      {
        ...fields,
        command: command.kind,
        byId: command.by.id,
        result,
        waitedMs: (startedAt ?? endedAt) - receivedAt,
        ...(startedAt === undefined ? {} : { ranMs: endedAt - startedAt }),
      },
      'telegram.command',
    );
  }

  /** 从会话的指令队列里拿掉这一条（已经不在时什么都不做） */
  function dequeue(session: Session, command: QueuedCommand): void {
    const index = session.commands.indexOf(command);
    if (index >= 0) session.commands.splice(index, 1);
  }

  /**
   * 收到一条指令（已过白名单、不是编辑）：过期的、正在关闭时的不执行，只记日志；这个聊天还没有
   * 会话时不建会话，直接回提示；有会话时排进它的指令队列。不等执行完就返回
   */
  async function onCommand(kind: TelegramCommand, raw: TelegramRaw): Promise<void> {
    const chatId = String(raw.chat.id);
    const from = raw.from!;
    const command = {
      kind,
      raw,
      by: { id: String(from.id), name: displayName(from) },
      receivedAt: Date.now(),
    };
    const ageMs = Date.now() - raw.date * 1000;
    if (ageMs > staleMs) {
      logCommand(command, 'stale', { chatId, ageMinutes: Math.floor(ageMs / 60_000) });
      return;
    }
    if (closing) return logCommand(command, 'closing', { chatId });
    // 这个聊天还没有会话（从没说过话）：不建会话，上下文本来就是空的
    const known = sessions.has(chatId) || (await storage.findConversation('telegram', chatId));
    if (closing) return logCommand(command, 'closing', { chatId });
    if (!known) {
      const result = kind === 'clear' ? 'already-empty' : 'nothing-to-compact';
      const done = { ...command, startedAt: Date.now() };
      track(
        (async () => {
          await send(targetOf(raw), commandReplies[result], raw.message_id, { chatId });
          logCommand(done, result, { chatId }, done.startedAt);
        })(),
      );
      return;
    }
    const session = await sessionFor(raw);
    if (closing) {
      return logCommand(command, 'closing', { conversationId: session.conversationId });
    }
    session.commands.push({ ...command, abort: new AbortController() });
    runCommands(session);
  }

  /**
   * 会话空着（没有一轮回复在进行，最前面的指令也还没开始）时，开始排在最前面的指令。
   * 正在关闭时不开始
   */
  function runCommands(session: Session): void {
    if (closing) return;
    const first = session.commands[0];
    if (!first || first.startedAt !== undefined || session.round) return;
    execute(session, first);
  }

  /**
   * 执行一条指令：同步调用核心（这之前不 await，核心取到的界线就是这一刻的最后一条消息）；压缩
   * 期间对指令所在的聊天显示「正在输入」。结束后引用指令那条消息发一句提示（被中止、正在关闭时
   * 不发），再看下一条能不能开始
   */
  function execute(session: Session, command: QueuedCommand): void {
    command.startedAt = Date.now();
    const fields = { conversationId: session.conversationId };
    const target = targetOf(command.raw);
    let running: Promise<CompactResult | ClearResult>;
    try {
      running =
        command.kind === 'compact'
          ? session.conversation.compact({ by: command.by, abortSignal: command.abort.signal })
          : session.conversation.clear({ by: command.by });
    } catch (error) {
      running = Promise.reject(error);
    }
    const stopTyping = command.kind === 'compact' ? keepTyping(target, fields) : () => {};
    session.running = (async () => {
      try {
        let outcome: CommandOutcome;
        // 失败的详情只进日志：压缩的核心已经记了 summary.failed，清空的记在指令的那一行
        let failure: object = {};
        try {
          outcome = await running;
        } catch (error) {
          outcome = 'failed';
          if (command.kind === 'clear') failure = { error: describe(error) };
          // 正忙：按排队的规矩不该发生（一轮回复还没结束时指令只会等着）
          if (error instanceof ConversationBusyError) {
            logger.error(
              { ...fields, command: command.kind, reason: error.reason },
              'telegram.command_busy',
            );
          }
        } finally {
          stopTyping();
        }
        const endedAt = Date.now();
        // 群里只发固定的一句；被中止（关闭时）、正在关闭时不发
        const text =
          outcome === 'failed'
            ? failedReplies[command.kind]
            : outcome === 'aborted'
              ? undefined
              : commandReplies[outcome];
        if (text !== undefined && !closing) {
          await send(target, text, command.raw.message_id, fields);
        }
        logCommand(command, outcome, { ...fields, ...failure }, endedAt);
      } finally {
        session.running = undefined;
        dequeue(session, command);
        runCommands(session);
      }
    })();
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
   * 存储里的会话对应哪个聊天：Telegram 的会话、平台 id 是能当 chat id 的整数时给出 chatId，
   * 否则（别的平台、没有平台 id）没有
   */
  async function chatOf(conversationId: string) {
    const overview = await storage.overview(conversationId, { textChars: 0 });
    const id = overview?.platform === 'telegram' ? overview.platformConversationId : undefined;
    const chatId = id !== undefined && Number.isSafeInteger(Number(id)) ? id : undefined;
    return { overview, chatId };
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
      session = open(conversationId, { checkIdleOnCreate: true }).then((conversation) =>
        newSession(conversationId, conversation, title),
      );
      session.catch(() => sessions.delete(chatId));
      sessions.set(chatId, session);
    }
    return session;
  }

  /**
   * 一步的文字拆成几条：
   * - 富文本开着、服务端也认识这个接口：按 Markdown 转成块（markdown.ts），按富文本消息的上限在顶层的块之间
   *   装成几条（split.ts 的 splitRich）；单独一个块就超限、层数超了的，单独一条发它的原文。转出来一个块都没有
   *   （比如只有链接定义）时整段原文发普通消息；
   * - 富文本关着，或者已经知道服务端不认识这个接口：整段原文一条普通消息（发的时候满 4096 拆），和以前一样
   */
  function piecesOf(text: string): RichPiece[] {
    if (!richAvailable) return [{ raw: text }];
    const parts = markdownBlocks(text);
    return parts.length ? splitRich(parts) : [{ raw: text }];
  }

  /**
   * 发一条（见 piecesOf）。有块的先试富文本消息，有尾部时块的最后加分隔线和下标的一行：
   * - Telegram 拒收这一条：改发它的原文的普通消息，记 telegram.rich_fallback；下一条照常先试富文本；
   * - 服务端不认识这个接口：改发原文，之后都直接发普通消息，telegram.rich_unavailable 只记一次；
   * - 别的失败：和普通消息发送失败一样只记日志，不改发、不重试。
   * 没有块的（退路）、改发的，都是原文的普通消息，见 sendPlain。日志不带正文。返回是否发出
   */
  async function deliver(
    target: ChatTarget,
    piece: RichPiece,
    { replyTo, footer, fields }: { replyTo?: number; footer?: string; fields: object },
  ): Promise<boolean> {
    if (piece.rich && richAvailable) {
      try {
        await sender.sendRich(target, richMessage(piece.rich, footer), replyTo);
        return true;
      } catch (error) {
        if (!(error instanceof RichMessageError)) {
          sendFailed('sendRichMessage', error, fields);
          return false;
        }
        if (error.kind === 'rejected') {
          logger.warn(
            { ...fields, reason: 'rejected', error: describe(error.cause) },
            'telegram.rich_fallback',
          );
        } else if (richAvailable) {
          // 几个会话同时在发时可能都碰上，只有第一个记
          richAvailable = false;
          logger.warn({ ...fields, error: describe(error.cause) }, 'telegram.rich_unavailable');
        }
      }
    }
    return sendPlain(target, piece.raw, { replyTo, footer, fields });
  }

  /**
   * 原文发普通消息：满 4096 拆成几段，第一段引用 replyTo，尾部是最后一段末尾斜体的一行（加上尾部超过
   * 上限时，尾部单独成一条，不引用）。全是空白的段不发。返回是否都发出了
   */
  async function sendPlain(
    target: ChatTarget,
    text: string,
    { replyTo, footer, fields }: { replyTo?: number; footer?: string; fields: object },
  ): Promise<boolean> {
    const chunks = splitMessage(text).filter((chunk) => chunk.trim());
    for (const [index, chunk] of chunks.entries()) {
      const quoted = index === 0 ? replyTo : undefined;
      const last = index === chunks.length - 1;
      if (!last || footer === undefined) {
        if (!(await send(target, chunk, quoted, fields))) return false;
        continue;
      }
      const withFooter = plainWithFooter(chunk, footer);
      if (withFooter.text.length <= telegramMessageLimit) {
        return send(target, withFooter.text, quoted, fields, withFooter.entities);
      }
      if (!(await send(target, chunk, quoted, fields))) return false;
      const alone = plainWithFooter('', footer);
      return send(target, alone.text, undefined, fields, alone.entities);
    }
    return true;
  }

  /**
   * 发一条普通消息，entities 是尾部的斜体（没有时和以前一样）。发送失败只记日志，不重试；
   * 返回是否发出
   */
  async function send(
    target: ChatTarget,
    text: string,
    replyTo: number | undefined,
    fields: object,
    entities?: readonly MessageEntity[],
  ): Promise<boolean> {
    try {
      if (entities) await sender.send(target, text, replyTo, entities);
      else await sender.send(target, text, replyTo);
      return true;
    } catch (error) {
      sendFailed('sendMessage', error, fields);
      return false;
    }
  }

  function sendFailed(method: string, error: unknown, fields: object): void {
    logger.warn({ ...fields, method, error: describe(error) }, 'telegram.send_failed');
  }

  return {
    /**
     * 处理一条原始消息（相册由适配器攒齐后只派发一条，各条由 albumOf 取回）。
     * 等到记录完成才返回，等待与回复在后台进行；从不抛错。
     * 指令（`/compact`、`/clear`，见 parseCommand）不记录：等这个会话一整轮回复（等待合并、
     * 回复中、补回复）结束再执行，同一个会话的按先后一个个执行，结束后引用指令发一句提示。
     * 排进队列就返回，不等执行完（适配器按聊天排队处理，压缩期间这个群的消息照常记录）
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
        // 指令：不写进历史、不触发回复、不参与等待合并；在判断触发之前拦下（群里的 /clear@本bot
        // 带着对 bot 的 @，会被当成「@助手」）
        const command = parseCommand(raw, bot());
        if (command) {
          await onCommand(command, raw);
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
          onRichUnreadable: (error) => richUnreadable(fields, raw, error),
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
     * 任务服务问：这个会话现在还收不收任务到点（ADR-0014）。照白名单答：群看群的白名单，私聊看
     * 用户的白名单；会话不是 Telegram 的、取不到 chat id 的也算不收。正在关闭不算不收（那是服务
     * 要停了），照样答白名单。不收时任务服务把这次到点的任务取消，不写事件
     */
    async accepts(conversationId: string): Promise<boolean> {
      const { chatId } = await chatOf(conversationId);
      return chatId !== undefined && isAllowedChat(chatId, { chats, users });
    },

    /**
     * 任务到点（ADR-0010）：事件已经写进会话，当作一次触发，走等待合并那一套（空闲时等待合并，
     * 等待中并进这一轮，回复中这次发出后再回复一次），回复引用最后一个任务的来源消息。
     * 发到会话的平台 id（chat id）那个群。以下情况不回复，只记一行 telegram.due_skipped
     * （会话 id、任务 id、原因），事件已经在历史里，不撤回：
     * - no_chat：会话不是 Telegram 的，或者取不到 chat id；
     * - not_allowed：这个群（私聊则那个用户）现在不在白名单里。任务服务到点前先问过 accepts，
     *   不收的已经取消、不会走到这里；这一条留着兜底；
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
        const { overview, chatId } = await chatOf(conversationId);
        if (chatId === undefined) return skip('no_chat', { platform: overview?.platform });
        if (!isAllowedChat(chatId, { chats, users })) return skip('not_allowed');
        const session = await sessionById(conversationId, chatId, overview?.title);
        if (!session || closing) return skip('closing');
        logger.info(fields, 'telegram.due');
        const source = tasks.at(-1)?.platformMessageId;
        onMessage(session, {
          kind: 'due',
          target: { chatId: Number(chatId) },
          tasks: tasks.map(({ id, ref, action, event, decide }) => ({
            id,
            ref,
            action,
            ...(event ? { event } : {}),
            ...(decide ? { decide } : {}),
          })),
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
          open(id, { checkIdleOnCreate: true }).then((conversation) =>
            newSession(id, conversation, title),
          ),
        );
      }
      await Promise.all(sessions.values());
      return opened;
    },

    /** 等待中与回复中的、排着的指令都结束（测试用） */
    async idle(): Promise<void> {
      for (const session of await openedSessions()) {
        // 一轮结束时会开始排着的指令，指令执行完又可能轮到下一条
        while (session.round || session.running) {
          await Promise.all([session.round?.done, session.running]);
        }
      }
      await Promise.all(background);
    },

    /**
     * 关闭：不再开始新的一轮与指令；等待中的直接放弃；还在等的指令丢掉（不执行、不发提示），
     * 进行中的压缩马上中止（不发提示），进行中的清空照常做完；回复中的最多等 graceMs，仍未完成的
     * 中止（不发出）；等进行中的指令结束，再关闭各会话（中止进行中的摘要）
     */
    async close(graceMs = 10_000): Promise<void> {
      closing = true;
      const opened = await openedSessions();
      for (const session of opened) {
        for (const command of [...session.commands]) {
          // 进行中的：压缩马上中止，清空不理会这个信号、照常做完
          if (command.startedAt !== undefined) {
            command.abort.abort();
            continue;
          }
          dequeue(session, command);
          logCommand(command, 'closing', { conversationId: session.conversationId });
        }
        // 放弃等待中的一轮：正在关闭，不会因此开始排着的指令
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
      await Promise.all([...opened.map((session) => session.running), ...background]);
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
