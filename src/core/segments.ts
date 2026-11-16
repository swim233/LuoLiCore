import { summarizeError } from './errors.js';
import type { Logger } from './logger.js';
import type { Author, Message, Usage } from './message.js';
import { formatTime, type SummaryScope } from './prompt.js';
import type { ConversationStore, StoredSegment } from './storage/types.js';

export type SegmentOptions = {
  /** 会话空闲多久后切段（毫秒），默认 240 分钟 */
  idleMs?: number;
  /** 一次回复的输入 token 超过它时压缩，默认 300000 */
  compressTokens?: number;
  /** 压缩时原样保留的最近消息条数，默认 20 */
  keepMessages?: number;
  /** 摘要的字数上限，默认 1500 */
  summaryMaxChars?: number;
};

/** 为什么摘要：空闲切段、自动压缩、有人手动压缩 */
type SummaryReason = 'idle' | 'compress' | 'manual';

/**
 * 生成摘要：沿用这一段的前缀（system 与 history），末尾追加摘要指令。
 * 指令按 scope 与 maxChars 填好，与 system 用同一次读到的提示词
 */
export type Summarize = (request: {
  reason: SummaryReason;
  segment: StoredSegment;
  history: Message[];
  scope: SummaryScope;
  maxChars: number;
  abortSignal: AbortSignal;
}) => Promise<{ text: string; usage?: Usage; stats: object }>;

export type CompactOptions = {
  /** 谁执行的：显示名，平台有不变的 id 时连同 id；记在新的一段上 */
  by: Author;
  /** 中止这次压缩：不切段，结果是 aborted */
  abortSignal?: AbortSignal;
};

export type ClearOptions = {
  /** 谁执行的：显示名，平台有不变的 id 时连同 id；记在清空的段上 */
  by: Author;
};

/**
 * 手动压缩的结果。compacted：新开了一段，带着新摘要；nothing-to-compact：当前段还没有消息，
 * 什么都没做；aborted：被中止（调用方的信号、会话关闭、或被清空接手），不切段
 */
export type CompactResult = 'compacted' | 'nothing-to-compact' | 'aborted';

/**
 * 清空的结果。cleared：之后的回复看不到之前的原文与摘要；already-empty：当前段本来就没有消息
 * 也没有摘要（新会话、刚清空过），什么都没做
 */
export type ClearResult = 'cleared' | 'already-empty';

/**
 * 会话正忙，压缩、清空不能进行，什么都没改：replying 是回复进行中，compacting 是另一次手动压缩
 * 还没结束。等它们结束再调用（排队是调用方的事）
 */
export class ConversationBusyError extends Error {
  constructor(readonly reason: 'replying' | 'compacting') {
    super(reason === 'replying' ? '回复进行中，不能压缩或清空上下文' : '上一次压缩还没结束');
    this.name = 'ConversationBusyError';
  }
}

/** 等 promise 兑现（返回 true）；signal 已经中止或先中止时马上返回 false */
function unlessAborted(
  promise: Promise<unknown>,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  if (!signal) return promise.then(() => true);
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const onAbort = () => resolve(false);
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    });
  });
}

/** 会话关闭之后调用清空 */
function closedError(): Error {
  return new Error('会话已关闭，不能清空上下文');
}

/** 一次切段：摘要 history（当前段到 toSeq 为止），成功后从 startSeq 开始新的一段 */
type Plan = {
  segment: StoredSegment;
  history: Message[];
  toSeq: number;
  startSeq: number;
  scope: SummaryScope;
};

/** 摘要的原因，手动压缩连同执行人 */
type Cause = { reason: 'idle' | 'compress' } | { reason: 'manual'; startedBy: Author };

/**
 * 正在进行的一次切段（空闲、自动压缩）或手动操作（手动压缩、清空）。同一会话同时只有一个
 */
type Job = {
  kind: 'idle' | 'compress' | 'manual' | 'clear';
  /** 结束时兑现（此时已经让出位置），从不 reject */
  done: Promise<void>;
  /** 中止这次摘要；清空很快、不能中止，对它是空操作 */
  abort(): void;
};

// setTimeout 超过 2^31-1 毫秒会立刻触发；更久的等待分几次，每次到时再检查
const maxDelayMs = 2 ** 31 - 1;

// 压缩失败后这么久之内不再尝试压缩：输入一直超过阈值时，不必每轮回复都重新请求一次
const compressBackoffMs = 10 * 60_000;

/**
 * 决定何时、从哪里切段（ADR-0004）：空闲切段与压缩，以及手动压缩与清空。同一会话同时只进行
 * 一次切段或手动操作，摘要成功后才插入新段，失败只写日志、不切段（手动压缩失败时抛出）。
 */
export function createSegmenter({
  store,
  logger,
  logFields,
  options: {
    idleMs = 240 * 60_000,
    compressTokens = 300_000,
    keepMessages = 20,
    summaryMaxChars = 1500,
  },
  summarize,
  isReplying,
  checkOnCreate = true,
}: {
  store: ConversationStore;
  logger: Logger;
  /** 每条 summary.* 日志都带上（会话 id、模型 id） */
  logFields: object;
  options: SegmentOptions;
  summarize: Summarize;
  /**
   * 回复进行中不做空闲检查：回复与它回答的消息不能分到两段。回复结束后会重新安排检查。
   * 回复进行中也不能手动压缩、清空
   */
  isReplying: () => boolean;
  /** 创建时是否立即检查一次空闲（见下）；前端要先处理完离线积压时传 false */
  checkOnCreate?: boolean;
}) {
  // 正在进行的切段（含压缩前读消息）或手动操作；结束时清空
  let cutting: Job | undefined;
  // 还没结束的手动操作（含还在等前一个让出位置的），从调用起到结束；期间不开始自动切段，
  // 回复开始前等它们结束
  const manual = new Set<Promise<unknown>>();
  // 有一次手动压缩还没结束（从调用起）：再调用压缩时拒绝
  let compacting = false;
  // 上次压缩失败后，到这个时刻之前不再压缩
  let compressAllowedAt = 0;
  // 空闲检查串行进行，读消息与决定切段之间不会插进另一次检查
  let checking: Promise<void> = Promise.resolve();
  let timer: NodeJS.Timeout | undefined;
  const closing = new AbortController();

  /**
   * 按计划摘要、切段，记 summary.* 日志。plan 返回 undefined 时什么都不做（skipped）。
   * 结果：cut（新段已写入）、duplicate（这个序号已经有一段：另一个进程刚切过，以已有的为准）、
   * aborted（被中止，不切段，不算失败）。失败（读消息出错、请求出错或超时、摘要为空、提示词文件
   * 有误）时记 summary.failed 并抛出
   */
  async function summarizeAndCut(
    cause: Cause,
    plan: () => Promise<Plan | undefined>,
    signal: AbortSignal,
  ): Promise<'cut' | 'duplicate' | 'aborted' | 'skipped'> {
    const { reason } = cause;
    const startedAt = Date.now();
    let fields: object = {
      ...logFields,
      reason,
      ...(cause.reason === 'manual' ? { byId: cause.startedBy.id } : {}),
    };
    try {
      const planned = await plan();
      if (!planned) return 'skipped';
      const { segment, history, toSeq, startSeq, scope } = planned;
      fields = { ...fields, fromSeq: segment.startSeq, toSeq, startSeq };
      signal.throwIfAborted();
      const result = await summarize({
        reason,
        segment,
        history,
        scope,
        maxChars: summaryMaxChars,
        abortSignal: signal,
      });
      const text = result.text.trim();
      if (!text) throw new Error('摘要为空');
      // 摘要好了才被中止（如手动压缩、清空要接手）：这次摘要作废，不切段
      signal.throwIfAborted();
      const added = await store.addSegment(
        cause.reason === 'manual'
          ? { startSeq, startReason: 'manual', priorSummary: text, startedBy: cause.startedBy }
          : { startSeq, startReason: cause.reason, priorSummary: text },
      );
      if (!added) {
        // 这个序号已经有一段：另一个进程（同一个库）刚切过。不算失败，以已有的段为准
        const current = await store.currentSegment();
        logger.info(
          { ...fields, currentStartSeq: current.startSeq, durationMs: Date.now() - startedAt },
          'summary.duplicate',
        );
        return 'duplicate';
      }
      logger.info(
        { ...fields, ...result.stats, usage: result.usage, durationMs: Date.now() - startedAt },
        'summary.end',
      );
      return 'cut';
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      // 被中止的摘要不算失败：关闭会话、手动操作接手、调用方中止手动压缩
      if (signal.aborted) {
        logger.info({ ...fields, durationMs }, 'summary.aborted');
        return 'aborted';
      }
      logger.error({ ...fields, durationMs, error: summarizeError(error) }, 'summary.failed');
      throw error;
    }
  }

  /** 在后台开始一次空闲切段或自动压缩；已经有切段、手动操作进行中或会话已关闭时不开始 */
  function begin(reason: 'idle' | 'compress', plan: () => Promise<Plan | undefined>): void {
    if (cutting || manual.size > 0 || closing.signal.aborted) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([closing.signal, controller.signal]);
    const done = summarizeAndCut({ reason }, plan, signal)
      .then(
        () => {},
        () => {
          // 自动压缩失败后一段时间内不再试；手动压缩失败不影响这个间隔
          if (reason === 'compress') compressAllowedAt = Date.now() + compressBackoffMs;
        },
      )
      .finally(() => {
        cutting = undefined;
      });
    cutting = { kind: reason, done, abort: () => controller.abort() };
  }

  /**
   * 手动操作：先等进行中的空闲检查做完，再等进行中的切段或手动操作让出位置（自动摘要、手动压缩
   * 先中止，清空等它做完），占住位置再执行 run，结束时让出。从调用起就算在 manual 里。
   * 等空闲检查：检查可能读消息读到一半，等它做完，它算好的计划才不会在手动操作之后才开始
   * （它看到有手动操作，不开始切段，见 begin）。空闲检查那边不等手动操作，不会互相等
   */
  function exclusive<T>(
    kind: 'manual' | 'clear',
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const operation = (async () => {
      for (;;) {
        await checking;
        const current = cutting;
        if (!current) break;
        current.abort();
        await current.done;
      }
      const controller = new AbortController();
      let finish!: () => void;
      const done = new Promise<void>((resolve) => (finish = resolve));
      cutting = { kind, done, abort: () => controller.abort() };
      try {
        return await run(controller.signal);
      } finally {
        cutting = undefined;
        finish();
      }
    })();
    manual.add(operation);
    const forget = () => manual.delete(operation);
    operation.then(forget, forget);
    return operation;
  }

  /** 到时检查是否空闲；没到时间就按剩余时间重新安排 */
  function schedule(delayMs: number): void {
    clearTimeout(timer);
    if (closing.signal.aborted) return;
    // unref：不因为等着切段而拖住进程退出
    timer = setTimeout(() => void checkIdle(), Math.min(delayMs, maxDelayMs)).unref();
  }

  /**
   * 最后一条消息距 at（默认为现在）超过空闲时长、且当前段有消息时，在后台切段。
   * 等到读完消息、决定好新段从哪里开始才返回，摘要不等；从不 reject
   */
  function checkIdle(at?: number): Promise<void> {
    checking = checking.then(async () => {
      // 有手动操作（含还在等着的）时不检查：手动操作会等这次检查做完
      if (cutting || manual.size > 0 || closing.signal.aborted || isReplying()) return;
      try {
        const last = await store.last();
        if (!last) return;
        const idleFor = (at ?? Date.now()) - Date.parse(last.createdAt);
        if (Number.isNaN(idleFor)) return;
        if (idleFor < idleMs) return schedule(idleMs - idleFor);
        const segment = await store.currentSegment();
        // 当前段还没有消息（如刚切过段）时不切
        if (last.seq < segment.startSeq) return;
        const history = await store.list({ from: segment.startSeq, before: last.seq + 1 });
        // 新段从最后那条消息之后开始：摘要生成期间写入的消息都归入新段
        const plan: Plan = {
          segment,
          history,
          toSeq: last.seq,
          startSeq: last.seq + 1,
          scope: { kind: 'idle' },
        };
        begin('idle', async () => plan);
      } catch (error) {
        logger.error(
          { ...logFields, reason: 'idle', error: summarizeError(error) },
          'summary.failed',
        );
      }
    });
    return checking;
  }

  async function planCompress(segment: StoredSegment, replySeq: number): Promise<Plan | undefined> {
    // 这次回复用的段已经被切过（回复期间另一次压缩完成了）：下一次回复用的是新段，由它重新判断
    if ((await store.currentSegment()).startSeq !== segment.startSeq) return undefined;
    // 摘要请求到刚完成的回复为止，与这次回复的前缀一致；回复期间写入的消息不在其中
    const entries = await store.entries({ from: segment.startSeq, before: replySeq + 1 });
    let keepFrom = entries.length - keepMessages;
    // 新段以用户消息开头：保留部分以助手回复开头时，向前多保留到最近的一条用户消息。
    // 往前找不到用户消息时照旧
    const user = entries.findLastIndex(
      (entry, index) => index <= keepFrom && entry.message.role === 'user',
    );
    if (user !== -1) keepFrom = user;
    const timeOf = (entry: { message: Message }) =>
      entry.message.role === 'user' ? formatTime(entry.message.metadata?.createdAt) : undefined;
    const firstUser = entries.find(
      (entry, index) => index >= keepFrom && entry.message.role === 'user',
    );
    const time = firstUser && timeOf(firstUser);
    // {T} 只精确到分钟：被摘要部分里与 {T} 同一分钟（或更晚）的用户消息，按指令不进摘要，
    // 又不在保留部分里，会丢失。所以继续向前扩，把它们连同夹在其间的回复都留在保留部分，
    // 直到保留部分之前的最后一条用户消息早于 {T}
    for (let index = keepFrom - 1; time && index >= 0; index--) {
      const entry = entries[index]!;
      if (entry.message.role !== 'user') continue;
      const entryTime = timeOf(entry);
      if (entryTime === undefined || entryTime < time) break;
      keepFrom = index;
    }
    if (keepFrom <= 0) {
      logger.warn(
        { ...logFields, reason: 'compress', messages: entries.length, keepMessages },
        'summary.skipped',
      );
      return undefined;
    }
    const kept = entries.slice(keepFrom);
    return {
      segment,
      history: entries.map((entry) => entry.message),
      toSeq: entries[keepFrom - 1]!.seq,
      startSeq: kept[0]!.seq,
      scope: time ? { kind: 'before', time } : { kind: 'recent', keep: keepMessages },
    };
  }

  // 创建时立即检查一次：上次退出时已经空闲太久的，在后台补做
  if (checkOnCreate) void checkIdle();

  return {
    checkIdle,

    /** 写入消息后调用：从现在起空闲满时长时检查 */
    wrote(): void {
      schedule(idleMs);
    },

    /**
     * 写入的回复正常结束后调用（含执行过工具、最后没有文字的回复）：最后一步的输入超过阈值时
     * 在后台压缩（压缩进行中、或刚失败过时不压缩）
     */
    replied({
      segment,
      seq,
      inputTokens,
    }: {
      segment: StoredSegment;
      seq: number;
      /** 这次回复最后一步的输入 token；多步时各步之和会把同一段上下文重复计算（ADR-0004） */
      inputTokens?: number;
    }): void {
      if (inputTokens === undefined || inputTokens <= compressTokens) return;
      if (Date.now() < compressAllowedAt) return;
      begin('compress', () => planCompress(segment, seq));
    },

    /**
     * 手动压缩：当前段到界线为止的消息连同之前的摘要并成新摘要（与空闲切段的请求相同），成功后
     * 从界线的下一个序号开始新的一段，原因 manual，记下执行人。界线是调用那一刻的最后一条消息：
     * 之后写入的消息（等自动摘要收尾、压缩进行中的时候）归入新段，不进这次摘要。
     * 进行中的自动摘要先中止。
     * 回复进行中、另一次手动压缩还没结束时以 ConversationBusyError 拒绝，什么都不改。
     * 失败时不切段、抛出错误（不影响自动压缩的间隔）；被中止（abortSignal、关闭会话、清空接手）
     * 时不切段，结果是 aborted
     */
    compact({ by, abortSignal }: CompactOptions): Promise<CompactResult> {
      if (isReplying()) return Promise.reject(new ConversationBusyError('replying'));
      if (compacting) return Promise.reject(new ConversationBusyError('compacting'));
      // 调用时就已经中止、会话已关闭：什么都不动，进行中的自动摘要也不打断
      if (abortSignal?.aborted || closing.signal.aborted) return Promise.resolve('aborted');
      compacting = true;
      // 界线在调用的那一刻取定：这时的最后一条消息。之后写入的消息（如等自动摘要收尾的时候）
      // 归入新的一段，不进这次摘要
      const boundary = store.last();
      boundary.catch(() => {});
      const operation = exclusive('manual', async (own): Promise<CompactResult> => {
        const signal = AbortSignal.any([
          closing.signal,
          own,
          ...(abortSignal === undefined ? [] : [abortSignal]),
        ]);
        if (signal.aborted) return 'aborted';
        // 摘要到界线为止，新段从界线的下一个序号开始：调用之后写入的消息都归入新段。
        // 当前段在轮到自己之后再读：被中止的自动摘要要是赶在中止之前切完了，按切完之后的当前段算，
        // 界线落在它之前时就是没有可压缩的内容
        const outcome = await summarizeAndCut(
          { reason: 'manual', startedBy: by },
          async () => {
            const last = await boundary;
            const segment = await store.currentSegment();
            if (!last || last.seq < segment.startSeq) return undefined;
            const history = await store.list({ from: segment.startSeq, before: last.seq + 1 });
            return {
              segment,
              history,
              toSeq: last.seq,
              startSeq: last.seq + 1,
              scope: { kind: 'idle' },
            };
          },
          signal,
        );
        if (outcome === 'skipped') return 'nothing-to-compact';
        return outcome === 'aborted' ? 'aborted' : 'compacted';
      });
      const release = () => {
        compacting = false;
      };
      operation.then(release, release);
      return operation;
    },

    /**
     * 清空：之后的回复看不到之前的原文与摘要，不请求模型。界线是调用那一刻的最后一条消息，之后
     * 写入的消息归入清空之后的一段、不被清掉。当前段有界线之前的消息时从界线之后新开一段清空的段
     * （没有摘要，记下执行人）；没有消息、带着摘要时把这一段改成清空的段；都没有时什么都不做。
     * 进行中的自动摘要、手动压缩先中止。回复进行中时以 ConversationBusyError 拒绝；
     * 会话已关闭时以普通的错误拒绝，什么都不写
     */
    clear({ by }: ClearOptions): Promise<ClearResult> {
      if (isReplying()) return Promise.reject(new ConversationBusyError('replying'));
      if (closing.signal.aborted) return Promise.reject(closedError());
      // 界线在调用的那一刻取定（同压缩）：之后写入的消息归入清空之后的一段，不被清掉
      const boundary = store.last();
      boundary.catch(() => {});
      return exclusive('clear', async () => {
        // 改写空段时，读当前段与写入之间可能刚写进一条消息（这时改写不成），按新的情况再来一次
        for (let attempt = 1; ; attempt++) {
          const segment = await store.currentSegment();
          const last = attempt === 1 ? await boundary : await store.last();
          // 等着的时候会话被关闭了：什么都不写
          if (closing.signal.aborted) throw closedError();
          const fields = { ...logFields, byId: by.id };
          let startSeq: number;
          let written: boolean;
          let rewritten: boolean;
          if (last && last.seq >= segment.startSeq) {
            startSeq = last.seq + 1;
            written = await store.addSegment({ startSeq, startReason: 'clear', startedBy: by });
            rewritten = false;
          } else if (segment.priorSummary) {
            startSeq = segment.startSeq;
            written = await store.clearSegment({ startSeq, startedBy: by });
            rewritten = true;
          } else {
            logger.info(
              { ...fields, result: 'already-empty', startSeq: segment.startSeq },
              'clear.end',
            );
            return 'already-empty';
          }
          if (written) {
            logger.info({ ...fields, result: 'cleared', startSeq, rewritten }, 'clear.end');
            return 'cleared';
          }
          if (attempt >= 3) throw new Error('清空时当前段一直在变，没有清空');
        }
      });
    },

    /**
     * 等正在进行的空闲检查、空闲切段与手动操作（手动压缩、清空）结束：之后读到的是它们之后的
     * 当前段。不等自动压缩：压缩进行中照常用当前段，压缩完成后，下一次读当前段时自然用上新段。
     * 等完返回 true。有要等的切段或手动操作，而 abortSignal 已经中止或等的时候中止了，马上返回
     * false，不再等（切段与手动操作照常做完）；没有要等的时不看 abortSignal
     */
    async settled(abortSignal?: AbortSignal): Promise<boolean> {
      for (;;) {
        await checking;
        const current = cutting;
        const wait =
          manual.size > 0
            ? Promise.allSettled([...manual])
            : current && current.kind !== 'compress'
              ? current.done
              : undefined;
        if (!wait) return true;
        if (!(await unlessAborted(wait, abortSignal))) return false;
      }
    },

    /** 停止定时器，中止进行中的摘要（含手动压缩）并等它们结束 */
    async close(): Promise<void> {
      closing.abort();
      clearTimeout(timer);
      await checking;
      await Promise.allSettled([...manual]);
      await cutting?.done;
    },
  };
}
