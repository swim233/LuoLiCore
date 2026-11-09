import {
  mediaTypeOf,
  type Conversation,
  type FileStore,
  type Logger,
  type MessageChunk,
  type Storage,
} from '../core/index.js';
import type { Live } from './live.js';
import type { StorageChange } from './observed-storage.js';
import type { Sessions } from './sessions.js';
import type { ChatChunk, ChatRequest } from './types.js';
import type { WebState } from './web-state.js';

/** 一条消息最多几张图 */
export const maxFiles = 10;
/** 一条消息的文字最多多少个字符 */
export const maxTextChars = 50_000;
/** 网页会话的标题取第一句的前几个字 */
export const titleChars = 16;

/** 对话接口的结果：回复的流（ChatChunk），或拒绝的原因 */
export type ChatResult =
  | { ok: true; conversationId: string; stream: ReadableStream<ChatChunk> }
  | { ok: false; status: 400 | 404 | 409 | 503; error: string };

/** 一个响应：往里写段；对面不读了（断开）时调 onCancel */
type Sink = {
  stream: ReadableStream<ChatChunk>;
  write(chunk: ChatChunk): void;
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

/** 排队等补回复：排队的消息从 fromSeq 起，补回复的流交给 sink（排队的最后一个请求） */
type Pending = { fromSeq: number; sink: Sink };

type ChatState = { running?: Running; pending?: Pending };

/**
 * 网页会话的对话：发消息、生成中再发（排队，之后补一次回复）、重试、中止。会话管理里每个会话
 * 同一时间只有一个回复，排队与补回复在这里做。每个会话一份状态：
 * - running：进行中的回复（它的流交给发起它的那个请求）；
 * - pending：排队的补回复（流交给排队的最后一个请求）。
 * 回复的流由这里读完（不看对面读没读）：对面断开时中止这次回复，接着读到结尾，核心照常收尾、
 * 把中止的回复写进历史；服务退出时进行中的回复被中止，对面收到的是 abort 段，不是连接断了
 */
export function createChats({
  sessions,
  storage,
  fileStore,
  webState,
  live,
  author,
  logger,
  notify,
}: {
  sessions: Pick<Sessions, 'open'>;
  /** 包过一层的存储（写入有通知） */
  storage: Storage;
  fileStore: FileStore;
  webState: Pick<WebState, 'setTitle'>;
  live: Pick<Live, 'queue' | 'unqueue'>;
  /** 发言人的名字（LUOLI_WEB_NAME） */
  author: string;
  logger: Logger;
  /** 记下新会话的标题之后，让会话列表的那一行重新推一次（服务里是 relay.onChange） */
  notify: (change: StorageChange) => void;
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

  /** 没有进行中的、也没有排队的：不留空的状态 */
  function tidy(conversationId: string): void {
    const state = states.get(conversationId);
    if (state && !state.running && !state.pending) states.delete(conversationId);
  }

  /** 序号最大的那条消息 */
  async function lastMessage(conversationId: string) {
    const page = await (await storage.openConversation(conversationId)).page({ limit: 1 });
    return page.entries[0]?.message;
  }

  /** 会话要是网页会话；不存在 404，别的平台 400 */
  async function check(conversationId: string): Promise<ChatResult | undefined> {
    const overview = await storage.overview(conversationId);
    if (!overview) return refuse(404, '没有这个会话');
    if (overview.platform !== 'web') return refuse(400, '只能在网页会话里对话');
    return undefined;
  }

  /** 开始回复，流写进 out；回复结束后看要不要补一次 */
  function start(conversationId: string, conversation: Conversation, out: Sink): void {
    const state = stateOf(conversationId);
    const abort = new AbortController();
    let stream: ReadableStream<MessageChunk>;
    try {
      stream = conversation.reply({ abortSignal: abort.signal });
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
        errorText: closing ? '洛璃服务正在退出' : (error as Error).message,
      });
      out.close();
      state.running = undefined;
      live.unqueue(conversationId);
      tidy(conversationId);
      return;
    }
    const running: Running = { abort };
    state.running = running;
    out.onCancel = () => abort.abort();
    // 对面在排队时就走了（补回复刚要开始）
    if (!out.open) abort.abort();
    const pump = (async () => {
      const reader = stream.getReader();
      let failed = false;
      try {
        for (let read = await reader.read(); !read.done; read = await reader.read()) {
          if (read.value.type === 'error') failed = true;
          else if (read.value.type === 'abort') failed = false;
          out.write(read.value as ChatChunk);
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
    pending.sink.close();
    live.unqueue(conversationId);
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
  async function next(conversationId: string, conversation: Conversation, done: Running) {
    const state = states.get(conversationId);
    if (!state || state.running !== done) return;
    if (state.pending && !closing) {
      let unseen = true;
      try {
        unseen = (await lastMessage(conversationId))?.role !== 'assistant';
      } catch {
        // 读不到就照补
      }
      // 读历史期间排队可能换了、被取消了
      const pending = state.pending;
      if (pending && !closing) {
        state.pending = undefined;
        if (unseen && pending.sink.open) {
          logger.info({ conversationId }, 'chat.follow_up');
          start(conversationId, conversation, pending.sink);
          return;
        }
        pending.sink.close();
      }
    }
    state.running = undefined;
    tidy(conversationId);
  }

  /** 生成中又发了一条：排队。之前排队的请求不带回复、正常结束，补回复的流交给这一个 */
  function queue(conversationId: string, out: Sink, seq: number): void {
    const state = stateOf(conversationId);
    const previous = state.pending;
    const fromSeq = previous?.fromSeq ?? seq;
    const pending: Pending = { fromSeq, sink: out };
    state.pending = pending;
    out.onCancel = () => {
      // 排队的请求断开：取消它的补回复（之后又排进来的不受影响）
      if (state.pending !== pending) return;
      cancelQueue(conversationId, state);
      logger.info({ conversationId }, 'chat.queue_cancelled');
    };
    out.write({ type: 'data-queued', data: { fromSeq }, transient: true });
    previous?.sink.close();
    live.queue(conversationId, fromSeq);
  }

  return {
    /** 发一条消息（新会话不带 conversationId）。signal 是请求的中止信号 */
    async send(
      request: Extract<ChatRequest, { retry?: undefined }>,
      signal?: AbortSignal,
    ): Promise<ChatResult> {
      if (closing) return leaving();
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
        conversationId = await storage.createConversation({ platform: 'web' });
        title = titleOf(text, files.length);
        webState.setTitle(conversationId, title);
        notify({ type: 'conversation', conversationId });
        logger.info({ conversationId }, 'chat.created');
      } else {
        const rejected = await check(conversationId);
        if (rejected) return rejected;
      }
      if (closing) return leaving();
      let conversation: Conversation;
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
      logger.info({ conversationId, files: files.length, queued }, 'chat.send');
      if (closing) out.close();
      else if (queued) queue(conversationId, out, seq ?? 0);
      else start(conversationId, conversation, out);
      return { ok: true, conversationId, stream: out.stream };
    },

    /**
     * 重试：对着同样的历史再回复一次。会话在回复或有排队时不行。可以重试的只有两种：
     * - 最后一条是出错的助手回复（metadata.failed）；
     * - 最后一条是用户消息，而这个会话上一次回复出错、一步都没写进历史，之后也没有新消息
     *   （服务这次运行期间记下的；中止、排队被取消留下的用户消息不算）
     */
    async retry(conversationId: string, signal?: AbortSignal): Promise<ChatResult> {
      if (closing) return leaving();
      const rejected = await check(conversationId);
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
      let conversation: Conversation;
      try {
        conversation = await sessions.open(conversationId);
      } catch {
        return leaving();
      }
      // 读历史期间别的请求开始了回复
      if (closing) return leaving();
      if (busy()) return refuse(409, '正在回复，等它结束再重试');
      const out = sink(signal);
      out.write({ type: 'data-conversation', data: { conversationId }, transient: true });
      logger.info({ conversationId }, 'chat.retry');
      start(conversationId, conversation, out);
      return { ok: true, conversationId, stream: out.stream };
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

    /** 这个会话在回复或有排队（测试用） */
    busy(conversationId: string): boolean {
      return states.has(conversationId);
    },

    /**
     * 退出的第一步：不再接新的消息，排队的补回复都取消（排队的请求正常结束）。进行中的回复由
     * 会话管理等完或中止
     */
    close(): void {
      closing = true;
      for (const [conversationId, state] of states) cancelQueue(conversationId, state);
    },

    /** 各回复的流都写完（中止的写到 abort 段为止），最多等 timeoutMs */
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
function sink(signal?: AbortSignal): Sink {
  let controller!: ReadableStreamDefaultController<ChatChunk>;
  let open = true;
  const out: Sink = {
    stream: new ReadableStream<ChatChunk>({
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
