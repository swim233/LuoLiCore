import { summarizeError } from './errors.js';
import type { Logger } from './logger.js';
import type { Message, Usage } from './message.js';
import { formatTime, summaryInstruction } from './prompt.js';
import type { ConversationStore, Segment } from './storage/types.js';

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

type Reason = 'idle' | 'compress';

/** 生成摘要：沿用这一段的前缀（system 与 history），末尾追加 instruction */
export type Summarize = (request: {
  reason: Reason;
  segment: Segment;
  history: Message[];
  instruction: string;
  abortSignal: AbortSignal;
}) => Promise<{ text: string; usage?: Usage; stats: object }>;

/** 一次切段：摘要 history（当前段到 toSeq 为止），成功后从 startSeq 开始新的一段 */
type Plan = {
  segment: Segment;
  history: Message[];
  toSeq: number;
  startSeq: number;
  scope: string;
};

// setTimeout 超过 2^31-1 毫秒会立刻触发；更久的等待分几次，每次到时再检查
const maxDelayMs = 2 ** 31 - 1;

// 压缩失败后这么久之内不再尝试压缩：输入一直超过阈值时，不必每轮回复都重新请求一次
const compressBackoffMs = 10 * 60_000;

/**
 * 决定何时、从哪里切段（ADR-0004）：空闲切段与压缩。同一会话同时只进行一次切段，
 * 摘要成功后才插入新段，失败只写日志、不切段。
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
}: {
  store: ConversationStore;
  logger: Logger;
  /** 每条 summary.* 日志都带上（会话 id、模型 id） */
  logFields: object;
  options: SegmentOptions;
  summarize: Summarize;
  /** 回复进行中不做空闲检查：回复与它回答的消息不能分到两段。回复结束后会重新安排检查 */
  isReplying: () => boolean;
}) {
  // 正在进行的切段（含压缩前读消息）；结束时清空，done 从不 reject
  let cutting: { reason: Reason; done: Promise<void> } | undefined;
  // 上次压缩失败后，到这个时刻之前不再压缩
  let compressAllowedAt = 0;
  // 空闲检查串行进行，读消息与决定切段之间不会插进另一次检查
  let checking: Promise<void> = Promise.resolve();
  let timer: NodeJS.Timeout | undefined;
  const closing = new AbortController();

  function begin(reason: Reason, plan: () => Promise<Plan | undefined>): void {
    if (cutting || closing.signal.aborted) return;
    const done = (async () => {
      const startedAt = Date.now();
      let fields: object = { ...logFields, reason };
      try {
        const planned = await plan();
        if (!planned) return;
        const { segment, history, toSeq, startSeq, scope } = planned;
        fields = { ...fields, fromSeq: segment.startSeq, toSeq, startSeq };
        const result = await summarize({
          reason,
          segment,
          history,
          instruction: summaryInstruction(scope, summaryMaxChars),
          abortSignal: closing.signal,
        });
        const text = result.text.trim();
        if (!text) throw new Error('摘要为空');
        if (!(await store.addSegment({ startSeq, startReason: reason, priorSummary: text }))) {
          // 这个序号已经有一段：另一个进程（同一个库）刚切过。不算失败，以已有的段为准
          const current = await store.currentSegment();
          logger.info(
            { ...fields, currentStartSeq: current.startSeq, durationMs: Date.now() - startedAt },
            'summary.duplicate',
          );
          return;
        }
        logger.info(
          { ...fields, ...result.stats, usage: result.usage, durationMs: Date.now() - startedAt },
          'summary.end',
        );
      } catch (error) {
        const durationMs = Date.now() - startedAt;
        // 关闭会话时中止的摘要不算失败：下次检查（空闲）或下次回复（压缩）会重做
        if (closing.signal.aborted) {
          logger.info({ ...fields, durationMs }, 'summary.aborted');
          return;
        }
        if (reason === 'compress') compressAllowedAt = Date.now() + compressBackoffMs;
        logger.error({ ...fields, durationMs, error: summarizeError(error) }, 'summary.failed');
      } finally {
        cutting = undefined;
      }
    })();
    cutting = { reason, done };
  }

  /** 到时检查是否空闲；没到时间就按剩余时间重新安排 */
  function schedule(delayMs: number): void {
    clearTimeout(timer);
    if (closing.signal.aborted) return;
    // unref：不因为等着切段而拖住进程退出
    timer = setTimeout(() => void checkIdle(), Math.min(delayMs, maxDelayMs)).unref();
  }

  /**
   * 最后一条消息距今超过空闲时长、且当前段有消息时，在后台切段。
   * 等到读完消息、决定好新段从哪里开始才返回，摘要不等；从不 reject
   */
  function checkIdle(): Promise<void> {
    checking = checking.then(async () => {
      if (cutting || closing.signal.aborted || isReplying()) return;
      try {
        const last = await store.last();
        if (!last) return;
        const idleFor = Date.now() - Date.parse(last.createdAt);
        if (Number.isNaN(idleFor)) return;
        if (idleFor < idleMs) return schedule(idleMs - idleFor);
        const segment = await store.currentSegment();
        // 当前段还没有消息（如刚切过段）时不切
        if (last.seq < segment.startSeq) return;
        const history = await store.list({ from: segment.startSeq, before: last.seq + 1 });
        // 新段从最后那条消息之后开始：摘要生成期间写入的消息都归入新段
        const plan = {
          segment,
          history,
          toSeq: last.seq,
          startSeq: last.seq + 1,
          scope: idleScope,
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

  async function planCompress(segment: Segment, replySeq: number): Promise<Plan | undefined> {
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
      scope: time
        ? `本段中 time 早于 ${time} 的消息，以及夹在其间的你的回复。time 为 ${time} 及之后的消息会原样保留，不要写进摘要。`
        : `本段中除最后 ${keepMessages} 条之外的全部消息。`,
    };
  }

  // 创建时立即检查一次：上次退出时已经空闲太久的，在后台补做
  void checkIdle();

  return {
    checkIdle,

    /** 写入消息后调用：从现在起空闲满时长时检查 */
    wrote(): void {
      schedule(idleMs);
    },

    /** 回复正常完成后调用：输入超过阈值时在后台压缩（压缩进行中、或刚失败过时不压缩） */
    replied({ segment, seq, usage }: { segment: Segment; seq: number; usage?: Usage }): void {
      if (usage?.input === undefined || usage.input <= compressTokens) return;
      if (Date.now() < compressAllowedAt) return;
      begin('compress', () => planCompress(segment, seq));
    },

    /**
     * 等正在进行的空闲检查与空闲切段结束。不等压缩：压缩进行中照常用当前段，
     * 压缩完成后，下一次读当前段时自然用上新段
     */
    async settled(): Promise<void> {
      await checking;
      if (cutting?.reason === 'idle') await cutting.done;
    },

    /** 停止定时器，中止进行中的摘要并等它结束 */
    async close(): Promise<void> {
      closing.abort();
      clearTimeout(timer);
      await checking;
      await cutting?.done;
    },
  };
}

const idleScope = '本段的全部消息，以及其中你的回复。';
