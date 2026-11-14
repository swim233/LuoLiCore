import { randomUUID } from 'node:crypto';
import {
  ConversationBusyError,
  mediaTypeOf,
  taskRef,
  type FileStore,
  type Logger,
  type Message,
  type MessageChunk,
  type Storage,
  type Trigger,
} from '../core/index.js';
import type { Live } from './live.js';
import type { StorageChange } from './observed-storage.js';
import type { Sessions, SharedConversation } from './sessions.js';
import type { TaskDue } from './tasks/service.js';
import { noSummaries, type Summarize } from './tool-summary.js';
import type {
  ChatChunk,
  ChatData,
  ChatRequest,
  CommandEvent,
  CommandKind,
  CommandResult,
  LiveTask,
} from './types.js';
import type { WebState } from './web-state.js';

/** 一条消息最多几张图 */
export const maxFiles = 10;
/** 一条消息的文字最多多少个字符 */
export const maxTextChars = 50_000;
/** 网页会话的标题取第一句的前几个字 */
export const titleChars = 16;
/**
 * 回复因为发起它的请求断开而中止、又有排队的补回复时，先等这么久再开始补回复：关掉页面时，
 * 同一个页面的几个请求是先后几毫秒断开的，等一下，排队的那几个断开了就不用补
 */
export const disconnectSettleMs = 300;

/** CLI 发言人的名字最多多少个字符 */
export const maxAuthorChars = 100;

/** 对话接口收的会话种类（会话的平台） */
type ChatPlatform = 'web' | 'cli';

/** 平台在提示里的叫法 */
const platformNames: Record<string, string> = { web: '网页', cli: 'CLI', telegram: 'Telegram' };
const platformName = (platform: string) => platformNames[platform] ?? platform;

/** 对话接口的结果：回复的流（ChatChunk），或拒绝的原因 */
export type ChatResult =
  | { ok: true; conversationId: string; stream: ReadableStream<ChatChunk> }
  | { ok: false; status: 400 | 404 | 409 | 503; error: string };

/** 指令接口的结果：事件的流，或拒绝的原因 */
export type CommandStart =
  | { ok: true; stream: ReadableStream<CommandEvent> }
  | { ok: false; status: 400 | 404 | 503; error: string };

/** 一个响应：往里写段；对面不读了（断开）时调 onCancel */
type Sink<T = ChatChunk> = {
  stream: ReadableStream<T>;
  write(chunk: T): void;
  /** 正常结束 */
  close(): void;
  /** 还开着：没结束、对面也没走 */
  readonly open: boolean;
  /** 对面走了（请求断开、取消读取）时调用一次；随这个响应的用处（在回复、在排队）而换 */
  onCancel: () => void;
};

/** 进行中的那次回复 */
type Running = {
  abort: AbortController;
  /**
   * 它回复期间排队的补回复被取消过（排队的请求断开、中止、退出）。这时留在最后的是没等到回复的
   * 排队消息，这次回复就算出错也不能重试：断开算中止，中止不能重试
   */
  queueCancelled?: boolean;
};

/**
 * 这一轮排队（当前回复结束后补一次回复）：排队的消息从 fromSeq 起；clients 是发了这一轮消息的
 * 客户端（请求带的 clientId，没带的每个请求算一个）。补回复的流交给 holder：排队的最后一个请求，
 * 一个会话最多只有它一个排队的请求连着（前面的马上以 merged 结束，省浏览器的连接）。
 * holder 断开了而这一轮还有别的客户端的消息、或者有任务到点时，holder 为空：补回复照常，流没人接。
 * triggers 是这一轮客户端发来的消息（补回复交给工具的触发者），tasks 是这一轮到点的任务
 * （它们不属于任何客户端，关页面、断开请求都不取消补回复；中止接口照常能取消）
 */
type Pending = {
  fromSeq: number;
  clients: Set<string>;
  holder?: { client: string; sink: Sink };
  triggers: Trigger[];
  tasks: LiveTask[];
};

/** 一次回复由谁触发：客户端发来的消息（交给工具），到点的任务（交给「此刻」） */
type Round = { triggers: Trigger[]; tasks?: LiveTask[] };

/**
 * 一条指令（压缩、清空），排在这个会话的指令队列里。conversation 在收到时就打开好：轮到它时同步地
 * 调用核心，中间不留空当让别的请求先开始回复
 */
type Command = {
  kind: CommandKind;
  /** 执行人的名字 */
  author: string;
  conversation: SharedConversation;
  out: Sink<CommandEvent>;
  /** 收到的时刻（Date.now()），等了多久从这里算 */
  receivedAt: number;
  /** 开始执行的时刻；还在等时没有 */
  startedAt?: number;
  /** 中止进行中的压缩：客户端断开、服务退出 */
  abort: AbortController;
  /** 已经结束（结果写了、流关了、日志记了） */
  finished?: boolean;
  /** 结束时兑现（退出时等它） */
  done: () => void;
};

/**
 * 一个会话的状态：进行中的回复、这一轮排队的补回复、指令队列（第一条在执行或在等，其余的在等）。
 * 三样都没有时不留这个状态
 */
type ChatState = { running?: Running; pending?: Pending; commands?: Command[] };

/**
 * 网页会话与 CLI 会话的对话：发消息、生成中再发（排队，之后补一次回复）、重试（只有网页）、中止。
 * 会话管理里每个会话
 * 同一时间只有一个回复，排队与补回复在这里做。每个会话一份状态：
 * - running：进行中的回复（它的流交给发起它的那个请求）；
 * - pending：这一轮排队（补回复的流交给排队的最后一个请求；它断开时，这一轮还有别的客户端的消息就
 *   照常补、流没人接，全是它这个客户端的就取消）。
 * 回复的流由这里读完（不看对面读没读）：对面断开时中止这次回复，接着读到结尾，核心照常收尾、
 * 把中止的回复写进历史；服务退出时进行中的回复被中止，对面收到的是 abort 段，不是连接断了。
 * 转发时每个工具段之前加上它的界面摘要（data-tool-summary），错误文字抹掉秘密（redact）
 */
export function createChats({
  sessions,
  storage,
  fileStore,
  webState,
  live,
  webAuthor,
  logger,
  notify,
  summarize = noSummaries,
  redact = (text) => text,
}: {
  sessions: Pick<Sessions, 'open'>;
  /** 包过一层的存储（写入有通知） */
  storage: Storage;
  fileStore: FileStore;
  webState: Pick<WebState, 'setTitle'>;
  live: Pick<Live, 'queue' | 'unqueue'>;
  /** 网页会话里发言人的名字（LUOLI_WEB_NAME）；CLI 的由请求带来 */
  webAuthor: string;
  logger: Logger;
  /** 记下新会话的标题之后，让会话列表的那一行重新推一次（服务里是 relay.onChange） */
  notify: (change: StorageChange) => void;
  /** 工具调用给界面看的一句话（与「此刻」同一个） */
  summarize?: Summarize;
  /** 抹掉错误文字里的 API key、Telegram token（与「此刻」、日志同一份秘密） */
  redact?: (text: string) => string;
}) {
  const states = new Map<string, ChatState>();
  // 回复出错、一步都没写进历史时，记下那时最后一条消息的 id：重试只认这种情况下的用户消息
  // （只在内存里，重启后这种重试不再可以；写进历史的出错回复有 metadata.failed，不靠它）
  const failedAt = new Map<string, string>();
  // 各回复把流读完时兑现（退出时等它们）
  const pumps = new Set<Promise<void>>();
  let closing = false;

  const refuse = (status: 400 | 404 | 409 | 503, error: string): ChatResult => ({
    ok: false,
    status,
    error,
  });
  const leaving = () => refuse(503, '洛璃服务正在退出');

  function stateOf(conversationId: string): ChatState {
    let state = states.get(conversationId);
    if (!state) {
      state = {};
      states.set(conversationId, state);
    }
    return state;
  }

  /** 没有进行中的、也没有排队的、也没有指令：不留空的状态 */
  function tidy(conversationId: string): void {
    const state = states.get(conversationId);
    if (state && !state.running && !state.pending && !state.commands?.length) {
      states.delete(conversationId);
    }
  }

  /** 序号最大的那条消息 */
  async function lastMessage(conversationId: string) {
    const page = await (await storage.openConversation(conversationId)).page({ limit: 1 });
    return page.entries[0]?.message;
  }

  /** 会话要存在（404），平台要和请求的一样（400）；refusal 是平台不对时的说法 */
  async function check(
    conversationId: string,
    platform: ChatPlatform,
    refusal: (actual: string) => string,
  ): Promise<ChatResult | undefined> {
    const overview = await storage.overview(conversationId);
    if (!overview) return refuse(404, '没有这个会话');
    if (overview.platform !== platform) return refuse(400, refusal(overview.platform));
    return undefined;
  }

  /** 开始回复，流写进 out；回复结束后看要不要补一次 */
  function start(
    conversationId: string,
    conversation: SharedConversation,
    out: Sink,
    { triggers, tasks }: Round,
  ): void {
    const state = stateOf(conversationId);
    const abort = new AbortController();
    let stream: ReadableStream<MessageChunk>;
    try {
      stream = conversation.reply({
        abortSignal: abort.signal,
        triggers,
        ...(tasks && tasks.length > 0 ? { tasks } : {}),
      });
    } catch (error) {
      // 服务正在退出，或核心那边上一次回复还没收尾（按约定不会发生）。这个请求以出错结束。
      // 补回复开始不了时，state.running 还是上一次的回复：一并清掉，免得这个会话一直「在回复」，
      // 之后发的消息只排队、重试一直 409；「此刻」里排队留下的等待中的一条也去掉
      logger.error(
        { conversationId, error: error instanceof Error ? error.message : String(error) },
        'chat.start_failed',
      );
      out.write({
        type: 'error',
        errorText: closing ? '洛璃服务正在退出' : redact((error as Error).message),
      });
      out.close();
      state.running = undefined;
      live.unqueue(conversationId);
      tidy(conversationId);
      runCommands(conversationId);
      return;
    }
    const running: Running = { abort };
    state.running = running;
    out.onCancel = () => abort.abort();
    // 对面在排队时就走了（补回复刚要开始）
    if (!out.open) abort.abort();
    const relay = relayChunks(summarize, redact);
    const pump = (async () => {
      const reader = stream.getReader();
      let failed = false;
      try {
        for (let read = await reader.read(); !read.done; read = await reader.read()) {
          if (read.value.type === 'error') failed = true;
          else if (read.value.type === 'abort') failed = false;
          for (const chunk of relay(read.value)) out.write(chunk);
        }
        // 发起它的请求断开了、回复因此中止：排队的补回复先等一下再说（见 disconnectSettleMs）
        if (!out.open && abort.signal.aborted && states.get(conversationId)?.pending) {
          await new Promise((resolve) => setTimeout(resolve, disconnectSettleMs));
        }
      } catch (error) {
        // 核心把错误都写成 error 段，这里只会是会话管理那层出错
        logger.error(
          { conversationId, error: error instanceof Error ? error.message : String(error) },
          'chat.stream_failed',
        );
      } finally {
        out.close();
      }
      await remember(conversationId, failed && !running.queueCancelled);
      await next(conversationId, conversation, running);
    })();
    pumps.add(pump);
    void pump.finally(() => pumps.delete(pump));
  }

  /** 取消排队的补回复（排队的消息留在历史里），排队的请求正常结束 */
  function cancelQueue(conversationId: string, state: ChatState): void {
    const pending = state.pending;
    if (!pending) return;
    state.pending = undefined;
    if (state.running) state.running.queueCancelled = true;
    endHolder(pending, 'cancelled');
    live.unqueue(conversationId);
  }

  /**
   * 重试时交给工具的触发者：出错的那次回复回答的那几条消息。从最后往前：跳过最后那条出错的助手回复，
   * 到上一条助手回复为止的用户消息（事件不算），按先后。读不到时为空
   */
  async function triggersBefore(conversationId: string): Promise<Trigger[]> {
    let messages: Message[];
    try {
      const page = await (await storage.openConversation(conversationId)).page({ limit: 50 });
      messages = page.entries.map((entry) => entry.message);
    } catch {
      return [];
    }
    if (messages.at(-1)?.role === 'assistant') messages.pop();
    const triggers: Trigger[] = [];
    for (const message of messages.reverse()) {
      if (message.role === 'assistant') break;
      const author = message.metadata?.author;
      if (!author || message.metadata?.event) continue;
      const platformMessageId = message.metadata?.platformMessageId;
      triggers.unshift({
        author,
        messageId: message.id,
        ...(platformMessageId === undefined ? {} : { platformMessageId }),
      });
    }
    return triggers;
  }

  /** 一次回复结束：出错的记下那时最后一条消息，别的结果清掉 */
  async function remember(conversationId: string, failed: boolean): Promise<void> {
    failedAt.delete(conversationId);
    if (!failed) return;
    try {
      const last = await lastMessage(conversationId);
      if (last) failedAt.set(conversationId, last.id);
    } catch {
      // 读不到就不记：最后一条是用户消息时不能重试
    }
  }

  /**
   * 一次回复结束：有排队的就补一次（看到期间所有新消息）。补之前看一眼历史：最后一条要是这次的
   * 回复（排队的消息其实在它开始读历史之前就写进去了，已经看到），就不用补了
   */
  async function next(conversationId: string, conversation: SharedConversation, done: Running) {
    const state = states.get(conversationId);
    if (!state || state.running !== done) return;
    if (state.pending && !closing) {
      let unseen = true;
      try {
        unseen = (await lastMessage(conversationId))?.role !== 'assistant';
      } catch {
        // 读不到就照补
      }
      // 读历史期间排队可能又进来了、被取消了
      const pending = state.pending;
      if (pending && !closing) {
        state.pending = undefined;
        if (unseen) {
          // 补回复的流交给排队的最后一个请求；它断开了（这一轮还有别人的消息）就没人接，由服务读完
          const sink = pending.holder?.sink.open ? pending.holder.sink : detachedSink();
          logger.info(
            { conversationId, detached: !pending.holder, tasks: pending.tasks.length },
            'chat.follow_up',
          );
          start(conversationId, conversation, sink, {
            triggers: pending.triggers,
            tasks: pending.tasks,
          });
          return;
        }
        // 这次回复已经看到了排队的消息
        endHolder(pending, 'answered');
      }
    }
    state.running = undefined;
    tidy(conversationId);
    // 回复全部结束：轮到等着的指令
    runCommands(conversationId);
  }

  /** 这个会话这一轮的排队；还没有时从 seq 起新开一轮 */
  function pendingOf(state: ChatState, seq: number): Pending {
    return (state.pending ??= { fromSeq: seq, clients: new Set(), triggers: [], tasks: [] });
  }

  /**
   * 生成中又发了一条：排队。补回复的流交给这个请求，前一个排队的请求马上以 merged 结束（一个会话
   * 最多只有一个排队的请求连着）。这个请求断开时：这一轮里有别的客户端发的消息、或者有任务到点，
   * 补回复照常、流没人接；全是这个客户端的（比如网页关掉了发这几条的标签页、只有一条），取消补回复
   */
  function queue(
    conversationId: string,
    out: Sink,
    seq: number,
    client: string,
    trigger: Trigger,
  ): void {
    const state = stateOf(conversationId);
    const pending = pendingOf(state, seq);
    pending.clients.add(client);
    pending.triggers.push(trigger);
    const previous = pending.holder;
    const holder = { client, sink: out };
    pending.holder = holder;
    out.onCancel = () => {
      // 这一轮已经结束（补回复开始了、被取消了）或者它已经被接替时不用管
      if (state.pending !== pending || pending.holder !== holder) return;
      if (pending.tasks.length > 0 || [...pending.clients].some((other) => other !== client)) {
        pending.holder = undefined;
        logger.info({ conversationId }, 'chat.queue_detached');
        return;
      }
      cancelQueue(conversationId, state);
      logger.info({ conversationId }, 'chat.queue_cancelled');
    };
    out.write({ type: 'data-queued', data: { fromSeq: pending.fromSeq }, transient: true });
    if (previous) {
      previous.sink.write(queueEnd('merged'));
      previous.sink.close();
    }
    live.queue(conversationId, pending.fromSeq);
  }

  /**
   * 会话空着（没有进行中的回复、排队的补回复，最前面的指令也还没开始）时，开始排在最前面的指令。
   * 正在退出时，等着的指令都以 aborted 结束，不再执行
   */
  function runCommands(conversationId: string): void {
    const state = states.get(conversationId);
    if (!state?.commands) return;
    if (closing) {
      for (const command of [...state.commands]) {
        if (command.startedAt === undefined) abandon(conversationId, state, command);
      }
      return;
    }
    const first = state.commands[0];
    if (!first || first.startedAt !== undefined || state.running || state.pending) return;
    execute(conversationId, state, first);
  }

  /**
   * 执行一条指令：写 start，同步地调用核心（这之前不 await，别的请求插不进来先开始回复），
   * 结束时写结果或出错
   */
  function execute(conversationId: string, state: ChatState, command: Command): void {
    command.startedAt = Date.now();
    command.out.write({ type: 'start' });
    const by = { name: command.author };
    let running: Promise<CommandResult>;
    try {
      running =
        command.kind === 'compact'
          ? command.conversation.compact({ by, abortSignal: command.abort.signal })
          : command.conversation.clear({ by });
    } catch (error) {
      running = Promise.reject(error);
    }
    void running.then(
      (result) => {
        command.out.write({ type: 'result', result });
        finish(conversationId, state, command, result);
      },
      (error: unknown) => {
        // 正忙：按排队的规矩不该发生（会话有回复在进行时指令只会等着）
        if (error instanceof ConversationBusyError) {
          logger.error(
            { conversationId, command: command.kind, reason: error.reason },
            'command.busy',
          );
        }
        const message = error instanceof Error ? error.message : String(error);
        command.out.write({ type: 'error', error: redact(message) });
        finish(conversationId, state, command, 'failed');
      },
    );
  }

  /** 还没开始的指令不再执行，以 aborted 结束（服务退出） */
  function abandon(conversationId: string, state: ChatState, command: Command): void {
    if (command.finished) return;
    command.out.write({ type: 'result', result: 'aborted' });
    finish(conversationId, state, command, 'aborted');
  }

  /**
   * 一条指令结束：关掉它的流，从队列里拿掉，记一行 command.end（会话、哪条指令、结果、等了多久、
   * 执行了多久；不记执行人的名字），然后看下一条能不能开始
   */
  function finish(
    conversationId: string,
    state: ChatState,
    command: Command,
    result: CommandResult | 'failed',
    { disconnected = false }: { disconnected?: boolean } = {},
  ): void {
    if (command.finished) return;
    command.finished = true;
    command.out.close();
    const commands = state.commands ?? [];
    commands.splice(commands.indexOf(command), 1);
    if (commands.length === 0) state.commands = undefined;
    const now = Date.now();
    const { startedAt, receivedAt } = command;
    logger.info(
      {
        conversationId,
        command: command.kind,
        result,
        waitedMs: (startedAt ?? now) - receivedAt,
        ...(startedAt === undefined ? {} : { ranMs: now - startedAt }),
        ...(disconnected ? { disconnected } : {}),
      },
      'command.end',
    );
    command.done();
    tidy(conversationId);
    runCommands(conversationId);
  }

  return {
    /**
     * 发一条消息（新会话不带 conversationId），会话的种类看 request.platform（不写时是网页）。
     * signal 是请求的中止信号
     */
    async send(
      request: Extract<ChatRequest, { retry?: undefined }>,
      signal?: AbortSignal,
    ): Promise<ChatResult> {
      if (closing) return leaving();
      const platform: ChatPlatform = request.platform ?? 'web';
      let author: string;
      if (platform === 'cli') {
        const name = request.author?.trim();
        if (!name) return refuse(400, 'CLI 的请求要带发言人的名字（author）');
        author = name;
      } else {
        if (request.author !== undefined) {
          return refuse(400, '网页的请求不带发言人的名字：网页会话的发言人是 LUOLI_WEB_NAME');
        }
        author = webAuthor;
      }
      const text = request.text?.trim() ? request.text : undefined;
      const files = request.files ?? [];
      if (text === undefined && files.length === 0) {
        return refuse(400, '消息是空的：要有文字或图片');
      }
      for (const [index, url] of files.entries()) {
        if (!(await fileStore.has(url))) {
          return refuse(400, `第 ${index + 1} 张图片不在文件存储里，先上传`);
        }
      }
      let conversationId = request.conversationId;
      let title: string | undefined;
      if (conversationId === undefined) {
        conversationId = await storage.createConversation({ platform });
        // 网页会话的标题只给面板看，存在 web.db；CLI 会话没有标题
        if (platform === 'web') {
          title = titleOf(text, files.length);
          webState.setTitle(conversationId, title);
          notify({ type: 'conversation', conversationId });
        }
        logger.info({ conversationId, platform }, 'chat.created');
      } else {
        const rejected = await check(
          conversationId,
          platform,
          (actual) =>
            `这是${platformName(actual)}的会话，不能从${platformName(platform)}往里发消息`,
        );
        if (rejected) return rejected;
      }
      if (closing) return leaving();
      let conversation: SharedConversation;
      try {
        conversation = await sessions.open(conversationId);
      } catch {
        return leaving();
      }
      const message = await conversation.append({
        author: { name: author },
        ...(text === undefined ? {} : { text }),
        files: files.map((url) => ({ url, mediaType: mediaTypeOf(url)! })),
      });
      const seq = (await (await storage.openConversation(conversationId)).entry(message.id))?.seq;
      // 交给工具的触发者：发言人是网页的 LUOLI_WEB_NAME，或 CLI 请求带的名字
      const trigger: Trigger = { author: { name: author }, messageId: message.id };

      const out = sink(signal);
      out.write({
        type: 'data-conversation',
        data: {
          conversationId,
          ...(seq === undefined ? {} : { seq }),
          ...(title === undefined ? {} : { title }),
        },
        transient: true,
      });
      const state = stateOf(conversationId);
      const queued = state.running !== undefined;
      logger.info({ conversationId, platform, files: files.length, queued }, 'chat.send');
      if (closing) out.close();
      else if (queued)
        queue(
          conversationId,
          out,
          seq ?? 0,
          request.clientId ?? `request:${randomUUID()}`,
          trigger,
        );
      else start(conversationId, conversation, out, { triggers: [trigger] });
      return { ok: true, conversationId, stream: out.stream };
    },

    /**
     * 重试（只有网页会话）：对着同样的历史再回复一次。会话在回复或有排队时不行。可以重试的只有两种：
     * - 最后一条是出错的助手回复（metadata.failed）；
     * - 最后一条是用户消息，而这个会话上一次回复出错、一步都没写进历史，之后也没有新消息
     *   （服务这次运行期间记下的；中止、排队被取消留下的用户消息不算）
     */
    async retry(conversationId: string, signal?: AbortSignal): Promise<ChatResult> {
      if (closing) return leaving();
      const rejected = await check(conversationId, 'web', () => '只有网页会话能重试');
      if (rejected) return rejected;
      const busy = () => states.get(conversationId) !== undefined;
      if (busy()) return refuse(409, '正在回复，等它结束再重试');
      const last = await lastMessage(conversationId);
      if (!last) return refuse(409, '会话里还没有消息');
      const failed =
        last.role === 'assistant'
          ? last.metadata?.failed === true
          : failedAt.get(conversationId) === last.id;
      if (!failed) return refuse(409, '最后一条不是出错的回复，不用重试');
      let conversation: SharedConversation;
      try {
        conversation = await sessions.open(conversationId);
      } catch {
        return leaving();
      }
      const triggers = await triggersBefore(conversationId);
      // 读历史期间别的请求开始了回复
      if (closing) return leaving();
      if (busy()) return refuse(409, '正在回复，等它结束再重试');
      const out = sink(signal);
      out.write({ type: 'data-conversation', data: { conversationId }, transient: true });
      logger.info({ conversationId }, 'chat.retry');
      start(conversationId, conversation, out, { triggers });
      return { ok: true, conversationId, stream: out.stream };
    },

    /**
     * 任务到点（服务的到点入口，网页会话用）：事件已经写进历史，这次触发不来自哪个请求。照排队的
     * 规矩走：空闲时开始回复，由服务把流读完；正在回复时排一个补回复，它不属于任何客户端，关页面、
     * 断开请求都不取消它，中止接口照常能取消。正在退出时什么也不做（事件留在历史里）
     */
    async due({ conversationId, tasks, fromSeq }: TaskDue): Promise<void> {
      if (closing) return;
      const refs: LiveTask[] = tasks.map(({ id, action }) => ({ id, ref: taskRef(id), action }));
      const conversation = await sessions.open(conversationId);
      // 打开会话期间可能开始了退出、开始了别的回复
      if (closing) return;
      const state = stateOf(conversationId);
      if (state.running) {
        const pending = pendingOf(state, fromSeq ?? 0);
        pending.tasks.push(...refs);
        logger.info({ conversationId, tasks: refs.length, queued: true }, 'chat.task_due');
        live.queue(conversationId, pending.fromSeq);
        return;
      }
      logger.info({ conversationId, tasks: refs.length, queued: false }, 'chat.task_due');
      start(conversationId, conversation, detachedSink(), { triggers: [], tasks: refs });
    },

    /**
     * 指令（压缩、清空，只收 CLI 会话），见 types.ts 的 CommandRequest：返回事件的流。会话空着时
     * 马上执行；有进行中的回复、排队的补回复或前面的指令时先写 waiting，等它们全部结束。
     * signal 是请求的中止信号：断开时还在等的不执行，进行中的压缩中止，进行中的清空照常做完
     */
    async command(
      conversationId: string,
      kind: CommandKind,
      author: string,
      signal?: AbortSignal,
    ): Promise<CommandStart> {
      const leavingCommand: CommandStart = { ok: false, status: 503, error: '洛璃服务正在退出' };
      if (closing) return leavingCommand;
      const name = author.trim();
      if (!name) return { ok: false, status: 400, error: '要带执行人的名字（author）' };
      const overview = await storage.overview(conversationId);
      if (!overview) return { ok: false, status: 404, error: '没有这个会话' };
      if (overview.platform !== 'cli') {
        return {
          ok: false,
          status: 400,
          error: `压缩、清空现在只给 CLI 会话用，这是${platformName(overview.platform)}的会话`,
        };
      }
      if (closing) return leavingCommand;
      let conversation: SharedConversation;
      try {
        conversation = await sessions.open(conversationId);
      } catch {
        return leavingCommand;
      }
      if (closing) return leavingCommand;

      const out = sink<CommandEvent>(signal);
      let done!: () => void;
      const ended = new Promise<void>((resolve) => (done = resolve));
      pumps.add(ended);
      void ended.finally(() => pumps.delete(ended));
      const command: Command = {
        kind,
        author: name,
        conversation,
        out,
        receivedAt: Date.now(),
        abort: new AbortController(),
        done,
      };
      const state = stateOf(conversationId);
      (state.commands ??= []).push(command);
      out.onCancel = () => {
        if (command.finished) return;
        // 还在等：不执行了。在执行：压缩中止（核心以 aborted 结束，段不变）；清空照常做完
        if (command.startedAt === undefined) {
          finish(conversationId, state, command, 'aborted', { disconnected: true });
        } else {
          command.abort.abort();
        }
      };
      // 请求在这之前就断开了（建好 sink 时已经调过一次空的 onCancel）：不执行
      if (!out.open) {
        out.onCancel();
        return { ok: true, stream: out.stream };
      }
      runCommands(conversationId);
      if (command.startedAt === undefined) out.write({ type: 'waiting' });
      return { ok: true, stream: out.stream };
    },

    /** 中止这个会话进行中的回复，同时取消排队的补回复；返回有没有可中止的 */
    abort(conversationId: string): boolean {
      const state = states.get(conversationId);
      if (!state) return false;
      let aborted = false;
      if (state.pending) {
        cancelQueue(conversationId, state);
        aborted = true;
      }
      if (state.running && !state.running.abort.signal.aborted) {
        state.running.abort.abort();
        aborted = true;
      }
      if (aborted) logger.info({ conversationId }, 'chat.abort');
      return aborted;
    },

    /** 这个会话在回复、有排队或有指令（测试用） */
    busy(conversationId: string): boolean {
      return states.has(conversationId);
    },

    /**
     * 退出的第一步：不再接新的消息与指令，排队的补回复都取消（排队的请求正常结束）；等着的指令
     * 以 aborted 结束、不执行，进行中的压缩中止（以 aborted 结束）。进行中的回复由会话管理等完或中止
     */
    close(): void {
      closing = true;
      for (const [conversationId, state] of [...states]) {
        cancelQueue(conversationId, state);
        for (const command of [...(state.commands ?? [])]) {
          if (command.startedAt === undefined) abandon(conversationId, state, command);
          else command.abort.abort();
        }
      }
    },

    /** 各回复与指令的流都写完（中止的写到 abort 段、aborted 的结果为止），最多等 timeoutMs */
    async settled(timeoutMs = 1000): Promise<void> {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.all(pumps),
        new Promise((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        }),
      ]);
      clearTimeout(timer);
    },
  };
}

export type Chats = ReturnType<typeof createChats>;

/** 一个响应的流；请求断开（signal）或对面取消读取时调 onCancel，之后写的都丢掉 */
function sink<T = ChatChunk>(signal?: AbortSignal): Sink<T> {
  let controller!: ReadableStreamDefaultController<T>;
  let open = true;
  const out: Sink<T> = {
    stream: new ReadableStream<T>({
      start(c) {
        controller = c;
      },
      cancel() {
        gone();
      },
    }),
    write(chunk) {
      if (open) controller.enqueue(chunk);
    },
    close() {
      if (!open) return;
      open = false;
      controller.close();
    },
    get open() {
      return open;
    },
    onCancel: () => {},
  };
  function gone(): void {
    if (!open) return;
    open = false;
    out.onCancel();
  }
  if (signal?.aborted) gone();
  signal?.addEventListener(
    'abort',
    () => {
      gone();
      try {
        controller.close();
      } catch {
        // 已经关了
      }
    },
    { once: true },
  );
  return out;
}

/** 排队的请求（还连着的话）以 reason 结束 */
function endHolder(pending: Pending, reason: ChatData['queue-end']['reason']): void {
  pending.holder?.sink.write(queueEnd(reason));
  pending.holder?.sink.close();
}

/** 没有请求接的流（接补回复的请求断开了，补回复照常进行）：写进来的段都丢掉 */
function detachedSink(): Sink {
  let open = true;
  return {
    stream: new ReadableStream<ChatChunk>(),
    write() {},
    close() {
      open = false;
    },
    get open() {
      return open;
    },
    onCancel: () => {},
  };
}

/** 排队的请求不带回复就结束时，结束前写的那一段 */
function queueEnd(reason: ChatData['queue-end']['reason']): ChatChunk {
  return { type: 'data-queue-end', data: { reason }, transient: true };
}

/**
 * 转发一次回复的流时逐段加工（一次回复一份，记着这次的工具调用）：
 * - 工具的 tool-input-available、tool-output-available、tool-output-error 之前，先写一段
 *   data-tool-summary（调用时按参数，完成时按参数与结果，出错时按参数）；没有摘要时不写；
 * - error 段与工具出错的 errorText 抹掉秘密
 */
export function relayChunks(
  summarize: Summarize,
  redact: (text: string) => string,
): (chunk: MessageChunk) => ChatChunk[] {
  const calls = new Map<string, { name: string; input?: unknown }>();
  const summary = (toolCallId: string, text: string | undefined): ChatChunk[] =>
    text === undefined
      ? []
      : [{ type: 'data-tool-summary', data: { toolCallId, summary: text }, transient: true }];
  const summarizeCall = (toolCallId: string, output?: unknown) => {
    const call = calls.get(toolCallId);
    return call && summarize(call.name, call.input, output);
  };
  return (chunk) => {
    switch (chunk.type) {
      case 'tool-input-start':
        calls.set(chunk.toolCallId, { name: chunk.toolName });
        return [chunk];
      case 'tool-input-available':
        calls.set(chunk.toolCallId, { name: chunk.toolName, input: chunk.input });
        return [...summary(chunk.toolCallId, summarizeCall(chunk.toolCallId)), chunk];
      case 'tool-input-error':
        calls.set(chunk.toolCallId, { name: chunk.toolName, input: chunk.input });
        return [{ ...chunk, errorText: redact(chunk.errorText) }];
      case 'tool-output-available':
        if (chunk.preliminary) return [chunk];
        return [...summary(chunk.toolCallId, summarizeCall(chunk.toolCallId, chunk.output)), chunk];
      case 'tool-output-error':
        return [
          ...summary(chunk.toolCallId, summarizeCall(chunk.toolCallId)),
          { ...chunk, errorText: redact(chunk.errorText) },
        ];
      case 'error':
        return [{ ...chunk, errorText: redact(chunk.errorText) }];
      default:
        return [chunk as ChatChunk];
    }
  };
}

/**
 * 网页会话的标题：第一句的前 titleChars 个字（空白合成一个空格），超出加「…」；
 * 只有图片时为「图片」
 */
export function titleOf(text: string | undefined, files: number): string {
  const line = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!line) return files > 0 ? '图片' : '新对话';
  const chars = [...line];
  return chars.length <= titleChars ? line : `${chars.slice(0, titleChars).join('')}…`;
}
