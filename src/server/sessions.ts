import {
  createConversation,
  type Conversation,
  type FileStore,
  type InstalledTool,
  type Logger,
  type MessageChunk,
  type PromptSource,
  type ReplyOptions,
  type SegmentOptions,
  type Storage,
} from '../core/index.js';
import type { LiveTask } from './types.js';

/** 建会话对象的参数，所有会话共用这一份 */
export type SessionOptions = {
  model: Parameters<typeof createConversation>[0]['model'];
  prompts: PromptSource;
  tools?: readonly InstalledTool[];
  storage: Storage;
  fileStore: FileStore;
  logger: Logger;
  maxRetries?: number;
  timeouts?: { firstChunkMs?: number; chunkMs?: number; replyMs?: number; toolMs?: number };
  maxSteps?: number;
  toolHistoryChars?: number;
  segments?: SegmentOptions;
};

/**
 * 会话管理里回复的参数：核心的那些，加上 tasks（任务到点触发的回复：是哪几个任务）。tasks 不交给核心，
 * 只交给旁听者
 */
export type SessionReplyOptions = ReplyOptions & { tasks?: readonly LiveTask[] };

/** 会话管理给出的会话对象：reply 多收一个 tasks（见 SessionReplyOptions） */
export type SharedConversation = Omit<Conversation, 'reply'> & {
  reply(options?: SessionReplyOptions): ReadableStream<MessageChunk>;
};

/**
 * 旁听回复：每次回复开始时调用，返回的对象依次收到这次回复的每个段，结束时（读完、出错或被取消）
 * 收到 end。不想听这次回复时返回 undefined。抛错只记日志，不影响回复。
 * tasks：这次回复是任务到点触发的（见 SessionReplyOptions）
 */
export type ReplyListener = (reply: {
  conversationId: string;
  tasks?: readonly LiveTask[];
}) => ReplyWatcher | undefined;

export type ReplyWatcher = {
  chunk?(chunk: MessageChunk): void;
  end?(): void;
};

export type Sessions = ReturnType<typeof createSessions>;

/** 退出时等进行中的回复，最多等这么久，之后中止 */
export const defaultGraceMs = 10_000;

/** 退出时中止回复之后，每一段收尾最多等这么久（见 close） */
export const defaultSettleMs = 1_000;

/** 一次进行中的回复 */
type ActiveReply = {
  /** 回复结束（核心的流读完、出错或被前端取消）时兑现 */
  done: Promise<void>;
  /** 退出时前端不读了：会话管理接手把核心的流读完 */
  takeOver(): Promise<void>;
};

/**
 * 会话管理：洛璃服务里所有会话对象都从这里取。同一个会话 id 在进程里只有一个会话对象
 * （并发打开也一样）。取到的是核心会话对象的一层包装：
 * - reply() 的流经过这里，旁听者（onReply）收到一份；会话管理记着进行中的回复，退出时等它们。
 *   平时前端读一段，会话管理才从核心读一段（背压照旧）；
 * - close() 什么也不做：会话可能还有别的前端在用，由会话管理在退出时统一关闭。
 */
export function createSessions(options: SessionOptions) {
  const { storage, logger } = options;
  // 按会话 id；正在打开的也在这里，并发打开只建一个
  const opened = new Map<string, Promise<{ core: Conversation; shared: SharedConversation }>>();
  // 进行中的回复
  const replies = new Set<ActiveReply>();
  const listeners = new Set<ReplyListener>();
  // 宽限期过后中止还没完成的回复
  const stopping = new AbortController();
  let closing = false;

  /** 包一层：reply 经过会话管理，close 留给会话管理；压缩、清空原样交给核心 */
  function share(conversationId: string, core: Conversation): SharedConversation {
    return {
      append: (input) => core.append(input),
      reply: (replyOptions) => reply(conversationId, core, replyOptions),
      compact: (compactOptions) => core.compact(compactOptions),
      clear: (clearOptions) => core.clear(clearOptions),
      messages: () => core.messages(),
      close: async () => {},
    };
  }

  function reply(
    conversationId: string,
    core: Conversation,
    { tasks, ...replyOptions }: SessionReplyOptions = {},
  ): ReadableStream<MessageChunk> {
    if (closing) throw new Error('洛璃服务正在退出，不再开始新的回复');
    const { abortSignal } = replyOptions;
    const source = core.reply({
      ...replyOptions,
      abortSignal: abortSignal ? AbortSignal.any([abortSignal, stopping.signal]) : stopping.signal,
    });
    const watchers = watch(conversationId, tasks);
    const hear = (chunk: MessageChunk) => {
      for (const watcher of watchers) safely(conversationId, () => watcher.chunk?.(chunk));
    };
    const reader = source.getReader();
    let wrapper!: ReadableStreamDefaultController<MessageChunk>;
    let wrapperClosed = false;
    const closeWrapper = (error?: unknown) => {
      if (wrapperClosed) return;
      wrapperClosed = true;
      try {
        if (error === undefined) wrapper.close();
        else wrapper.error(error);
      } catch {
        // 前端那边已经结束
      }
    };

    let finish!: () => void;
    let ended = false;
    let takenOver = false;
    const active: ActiveReply = {
      done: new Promise<void>((resolve) => (finish = resolve)),
      /**
       * 核心要等它的流被读到结尾，才会收尾、把回复写入历史（AI SDK 在流的 flush 里调 onEnd）。
       * 前端读了一部分就不读、也不取消时，退出会一直等下去，中止的回复也写不进去。这时由会话管理
       * 接手：把核心的流读完，段照样给旁听者，不再交给前端；读完后前端那边的流也结束
       */
      async takeOver() {
        if (ended || takenOver) return;
        takenOver = true;
        try {
          for (let result = await reader.read(); !result.done; result = await reader.read()) {
            hear(result.value);
          }
        } catch {
          // 核心的流出错：照样算结束
        }
        end();
        closeWrapper();
      },
    };
    replies.add(active);
    const end = () => {
      if (ended) return;
      ended = true;
      replies.delete(active);
      finish();
      for (const watcher of watchers) safely(conversationId, () => watcher.end?.());
    };

    return new ReadableStream<MessageChunk>({
      start(controller) {
        wrapper = controller;
      },
      async pull() {
        if (takenOver) return;
        let result: Awaited<ReturnType<typeof reader.read>>;
        try {
          result = await reader.read();
        } catch (error) {
          end();
          closeWrapper(error);
          return;
        }
        if (result.done) {
          end();
          closeWrapper();
          return;
        }
        hear(result.value);
        // 接手之前已经在读的这一段：给了旁听者，不再交给前端
        if (!takenOver && !wrapperClosed) wrapper.enqueue(result.value);
      },
      async cancel(reason) {
        wrapperClosed = true;
        try {
          await reader.cancel(reason);
        } finally {
          end();
        }
      },
    });
  }

  /** 这次回复的旁听者 */
  function watch(conversationId: string, tasks?: readonly LiveTask[]): ReplyWatcher[] {
    return [...listeners].flatMap((listener) => {
      let watcher: ReplyWatcher | undefined;
      safely(conversationId, () => {
        watcher = listener({ conversationId, ...(tasks && tasks.length > 0 ? { tasks } : {}) });
      });
      return watcher ? [watcher] : [];
    });
  }

  function safely(conversationId: string, run: () => void): void {
    try {
      run();
    } catch (error) {
      logger.error(
        {
          conversationId,
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        },
        'sessions.listener_failed',
      );
    }
  }

  return {
    /**
     * 按会话 id 取会话对象：同一个 id 只打开一次，之后都返回同一个对象。会话必须已经在存储里。
     * checkIdleOnCreate 只在第一次打开时起作用（见 createConversation）。打开失败时不留下，下次再试。
     * 开始退出之后不再打开
     */
    open(
      conversationId: string,
      { checkIdleOnCreate = true }: { checkIdleOnCreate?: boolean } = {},
    ): Promise<SharedConversation> {
      if (closing) return Promise.reject(new Error('洛璃服务正在退出，不再打开会话'));
      let entry = opened.get(conversationId);
      if (!entry) {
        const created = (async () => {
          const store = await storage.openConversation(conversationId);
          const core = createConversation({
            model: options.model,
            prompts: options.prompts,
            tools: options.tools,
            store,
            fileStore: options.fileStore,
            logger,
            maxRetries: options.maxRetries,
            timeouts: options.timeouts,
            maxSteps: options.maxSteps,
            toolHistoryChars: options.toolHistoryChars,
            segments: options.segments,
            conversationId,
            checkIdleOnCreate,
          });
          logger.info({ conversationId }, 'sessions.open');
          return { core, shared: share(conversationId, core) };
        })();
        created.catch(() => {
          if (opened.get(conversationId) === created) opened.delete(conversationId);
        });
        opened.set(conversationId, created);
        entry = created;
      }
      return entry.then(({ shared }) => shared);
    },

    /** 旁听之后开始的每次回复；返回取消旁听的函数 */
    onReply(listener: ReplyListener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** 进行中的回复有几个 */
    get replying(): number {
      return replies.size;
    },

    /**
     * 退出：不再打开会话、不再开始回复。进行中的回复最多等 graceMs，仍没完成的中止；
     * 中止后再等 settleMs，让前端读到结尾。前端读了一部分就不读了的，会话管理接手把核心的流读完
     * （核心照常收尾，中止的回复照它的规则写入历史），再等最多 settleMs；核心自己也收不了尾的
     * 不再等。然后关闭各会话（中止进行中的摘要）。数据库由调用方之后关闭
     */
    async close(graceMs = defaultGraceMs, settleMs = defaultSettleMs): Promise<void> {
      closing = true;
      const settled = () => Promise.all([...replies].map((active) => active.done));
      await within(settled(), graceMs);
      const aborted = replies.size;
      stopping.abort();
      await within(settled(), settleMs);
      const takenOver = replies.size;
      for (const active of replies) void active.takeOver();
      await within(settled(), settleMs);
      const unfinished = replies.size;
      const entries = await Promise.allSettled(opened.values());
      const conversations = entries.flatMap((entry) =>
        entry.status === 'fulfilled' ? [entry.value.core] : [],
      );
      await Promise.all(conversations.map((conversation) => conversation.close()));
      opened.clear();
      logger.info(
        { conversations: conversations.length, aborted, takenOver, unfinished },
        'sessions.close',
      );
    },
  };
}

/** 等 promise，最多等 ms 毫秒 */
async function within(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]);
  clearTimeout(timer);
}
