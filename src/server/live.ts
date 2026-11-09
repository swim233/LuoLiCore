import {
  isStoredToolContent,
  type Logger,
  type MessageChunk,
  type RecentReply,
  type Usage,
} from '../core/index.js';
import type { RoundNotice } from '../telegram/bot.js';
import { errorLine, type ErrorLine } from './error-line.js';
import type { ReplyWatcher } from './sessions.js';
import { noSummaries, type Summarize } from './tool-summary.js';
import { fileScheme, fileSrc } from './views.js';
import type {
  ImageInfo,
  LastReply,
  LiveEvent,
  LivePart,
  LiveReasoning,
  LiveReply,
  LiveSnapshot,
  LiveState,
  LiveTask,
  LiveText,
  LiveTool,
} from './types.js';

/** 逐字的文字、思考攒这么久（毫秒）再推一次 */
export const flushMs = 50;

/** 工具参数、错误说明最多留这么多个字符 */
const briefChars = 200;

/** 回复结束时还没结束的工具调用：与核心写进历史的说法相同 */
const unfinishedTool = '工具调用未完成';

/** 推 live 事件：seq 由这里分配，调用方只给其余的字段 */
type Draft = LiveEvent extends infer E ? (E extends unknown ? Omit<E, 'seq'> : never) : never;

/**
 * 「此刻」：旁听会话管理里的每次回复，转成 live 事件推给面板；记着每个进行中回复的现场。
 *
 * - 现场只由推出去的事件改变：每个事件先改现场、再在同一个同步步骤里推出去。面板连上时拿到的现场
 *   （hello 里的 live）正好是此前全部事件的结果，之后的事件接着它往下，不丢不重。
 * - 逐字的文字与思考先攒在每个回复自己的缓冲里，最多 flushMs 毫秒（或这个回复有别的事件要推时）
 *   一并推出、写进现场；缓冲里的内容不在现场里，也还没推，所以连上的那一刻正好在攒也不会丢或重。
 * - 没有面板连着时照样维护现场，只是推出去的事件没人收。
 * - 旁听只做同步的小事（记下、拼字符串、排进各连接的队列），不拖慢前端读流；出错只记日志，
 *   不影响回复。
 */
export function createLive({
  broadcast,
  logger,
  lastReply,
  now = () => new Date(),
  delayMs = flushMs,
  redact = (text) => text,
  summarize = noSummaries,
}: {
  /** 推一个 live 事件（服务里是 events.broadcast('live', …)） */
  broadcast: (event: LiveEvent) => void;
  logger: Logger;
  /** 启动时数据库里最近一次正常完成的回复 */
  lastReply?: RecentReply;
  now?: () => Date;
  /** 逐字片段攒多久；测试里可以调 */
  delayMs?: number;
  /** 抹掉错误说明里的 key、token */
  redact?: (text: string) => string;
  /** 工具调用给界面看的一句话（见 tool-summary.ts）；不给时都没有 */
  summarize?: Summarize;
}) {
  // 按会话 id：每个会话同一时间最多一个进行中的回复（含等待合并的）
  const replies = new Map<string, LiveReply>();
  let seq = 0;
  let last: LastReply | undefined = lastReply && {
    conversationId: lastReply.conversationId,
    at: lastReply.endedAt,
  };

  const iso = () => now().toISOString();

  /** 通知（Telegram、排队）出错只记日志 */
  function report(conversationId: string, failure: unknown): void {
    logger.error(
      {
        conversationId,
        error: failure instanceof Error ? `${failure.name}: ${failure.message}` : String(failure),
      },
      'live.failed',
    );
  }

  function emit(draft: Draft): void {
    seq++;
    broadcast({ ...draft, seq } as LiveEvent);
  }

  /** 回复还在进行的事件都带上的：会话、回复 id、时间、此刻的状态 */
  function progress(reply: LiveReply, at = iso()) {
    return {
      conversationId: reply.conversationId,
      ...(reply.replyId ? { replyId: reply.replyId } : {}),
      at,
      state: reply.state,
      ...(reply.state === 'tool' && reply.toolName ? { toolName: reply.toolName } : {}),
    };
  }

  /** 一次回复的旁听者（sessions.onReply 的返回）；tasks：任务到点触发的回复是哪几个任务 */
  function watch(conversationId: string, tasks?: readonly LiveTask[]): ReplyWatcher {
    const startedAt = iso();
    // 这次回复开始时现场里已有的那条（等待合并中的，或上一次回复刚结束时又被触发而建的）
    const before = replies.get(conversationId);
    let reply: LiveReply | undefined;
    let replyId: string | undefined;
    // 还开着的文字段、思考段：流里的 id → parts 的下标（文字段在第一个非空片段推出时才建）
    const texts = new Map<string, number | undefined>();
    const reasonings = new Map<string, number>();
    // 工具调用：调用 id → 工具名（参数开始流出时就知道），以及 parts 的下标（开始调用后）
    const tools = new Map<string, { name: string; input?: unknown; part?: number }>();
    // 这一步从 parts 的哪个下标开始（reset-step 时从这里截掉）、第几步
    let stepStart = 0;
    let step = 0;
    // 还没推的逐字片段：都属于同一段
    let pending: { kind: 'text' | 'reasoning'; id: string; part: number; text: string } | undefined;
    let timer: NodeJS.Timeout | undefined;
    let finished = false;
    let aborted = false;
    let error: ErrorLine | undefined;
    let usage: Usage | undefined;
    let failed = false;
    let ended = false;

    /**
     * 旁听出错只记一次日志（会话 id 与错误），之后的段照样处理。旁听的每个入口（收到一段、结束、
     * 合并计时器到点）都经过它：出错绝不能抛到会话管理或计时器里（计时器里抛出会让进程退出）
     */
    let reported = false;
    function report(failure: unknown): void {
      if (reported) return;
      reported = true;
      logger.error(
        {
          conversationId,
          error: failure instanceof Error ? `${failure.name}: ${failure.message}` : String(failure),
        },
        'live.failed',
      );
    }
    const guarded =
      <A extends unknown[]>(run: (...args: A) => void) =>
      (...args: A) => {
        try {
          run(...args);
        } catch (failure) {
          report(failure);
        }
      };

    /** 回复开始：接着用等待合并的那条现场，或者新建一条 */
    function start(): LiveReply {
      if (reply) return reply;
      const existing = replies.get(conversationId);
      if (existing?.startedAt !== undefined) {
        // 同一个会话上一个回复的旁听者还没收尾（不该发生）：新的接替它，旧的不再推事件
        logger.warn({ conversationId }, 'live.replaced');
      }
      // 还没开始的那条（等待中）：
      // - 等待合并的（有等待时间），或这次回复开始之后才建的（开始了、还没出第一段时又被触发、
      //   网页又发了消息）：接着用它的等待时间、「又被触发」与排队；
      // - 这次回复开始之前就有、又没有等待时间的：上一次回复刚结束时又被触发而建的，这次就是
      //   「再回复一次」，不再带着它
      const pending = existing?.startedAt === undefined ? existing : undefined;
      const carry =
        pending !== undefined && (pending.waitingSince !== undefined || pending !== before);
      reply = {
        conversationId,
        ...(replyId ? { replyId } : {}),
        state: 'thinking',
        ...(pending?.waitingSince ? { waitingSince: pending.waitingSince } : {}),
        startedAt,
        again: carry && pending.again,
        ...(carry && pending.queuedFrom !== undefined ? { queuedFrom: pending.queuedFrom } : {}),
        parts: [],
        ...(tasks && tasks.length > 0 ? { tasks: structuredClone([...tasks]) } : {}),
      };
      replies.set(conversationId, reply);
      emit({
        type: 'start',
        ...progress(reply, startedAt),
        again: reply.again,
        ...(reply.queuedFrom !== undefined ? { queuedFrom: reply.queuedFrom } : {}),
        ...(reply.tasks ? { tasks: reply.tasks } : {}),
      });
      return reply;
    }

    function setState(current: LiveReply, state: LiveState, toolName?: string): void {
      current.state = state;
      if (state === 'tool' && toolName) current.toolName = toolName;
      else delete current.toolName;
    }

    /** 工具结束之后：还有别的工具在跑就仍是调用工具（显示最近开始的那个），否则回到思考中 */
    function afterTool(current: LiveReply): void {
      const running = current.parts.filter(
        (part): part is LiveTool => part.type === 'tool' && part.endedAt === undefined,
      );
      const latest = running.at(-1);
      if (latest) setState(current, 'tool', latest.name);
      else setState(current, 'thinking');
    }

    /** 把攒着的逐字片段推出去、写进现场 */
    function flush(): void {
      clearTimeout(timer);
      timer = undefined;
      const chunk = pending;
      pending = undefined;
      if (!chunk || !reply) return;
      if (chunk.kind === 'text') {
        // 这一段还没建：建在末尾（攒的期间 parts 不会变，下标就是攒的时候定的那个）
        let index = chunk.part;
        let part = reply.parts[index] as LiveText | undefined;
        if (part?.type !== 'text') {
          part = { type: 'text', step, text: '' };
          index = reply.parts.push(part) - 1;
          texts.set(chunk.id, index);
        }
        part.text += chunk.text;
        setState(reply, 'replying');
        emit({
          type: 'text-delta',
          ...progress(reply),
          part: index,
          step: part.step,
          text: chunk.text,
        });
      } else {
        const part = reply.parts[chunk.part] as LiveReasoning;
        part.text += chunk.text;
        setState(reply, 'thinking');
        emit({ type: 'reasoning-delta', ...progress(reply), part: chunk.part, text: chunk.text });
      }
    }

    /** 攒一个逐字片段：和攒着的不是同一段时，先把攒着的推出去 */
    function hold(kind: 'text' | 'reasoning', id: string, part: number, text: string): void {
      if (pending && (pending.kind !== kind || pending.id !== id)) flush();
      if (pending) {
        pending.text += text;
        return;
      }
      pending = { kind, id, part, text };
      timer = setTimeout(guarded(flush), delayMs);
      timer.unref();
    }

    function startReasoning(current: LiveReply, id: string): number {
      const part: LiveReasoning = { type: 'reasoning', step, text: '', startedAt: iso() };
      const index = current.parts.push(part) - 1;
      reasonings.set(id, index);
      setState(current, 'thinking');
      emit({
        type: 'reasoning-start',
        ...progress(current, part.startedAt),
        part: index,
        step,
      });
      return index;
    }

    function endReasoning(current: LiveReply, index: number): void {
      const part = current.parts[index] as LiveReasoning;
      if (part.endedAt !== undefined) return;
      part.endedAt = iso();
      emit({
        type: 'reasoning-end',
        ...progress(current, part.endedAt),
        part: index,
        startedAt: part.startedAt,
      });
    }

    function startTool(current: LiveReply, callId: string, name: string, input: unknown): number {
      const known = tools.get(callId);
      if (known?.part !== undefined) return known.part;
      const summary = summarize(name, input);
      const part: LiveTool = {
        type: 'tool',
        step,
        callId,
        name,
        input: brief(json(input)),
        startedAt: iso(),
        ...(summary !== undefined ? { summary } : {}),
      };
      const index = current.parts.push(part) - 1;
      tools.set(callId, { name, input, part: index });
      setState(current, 'tool', name);
      emit({
        type: 'tool-start',
        ...progress(current, part.startedAt),
        part: index,
        step,
        callId,
        name,
        input: part.input,
        ...(summary !== undefined ? { summary } : {}),
      });
      return index;
    }

    function endTool(
      current: LiveReply,
      callId: string,
      result: { ok: true; output: unknown } | { ok: false; error: string },
    ): void {
      const known = tools.get(callId);
      const index = known?.part ?? startTool(current, callId, known?.name ?? '?', undefined);
      const part = current.parts[index] as LiveTool;
      if (part.endedAt !== undefined) return;
      part.endedAt = iso();
      part.ok = result.ok;
      if (result.ok) {
        const images = outputImages(result.output);
        if (images.length > 0) part.images = images;
      } else {
        part.error = brief(firstLine(redact(result.error)));
      }
      // 有了结果（出错时没有）再给一次摘要
      const summary = summarize(
        part.name,
        tools.get(callId)?.input,
        result.ok ? result.output : undefined,
      );
      if (summary !== undefined) part.summary = summary;
      else delete part.summary;
      afterTool(current);
      emit({
        type: 'tool-end',
        ...progress(current, part.endedAt),
        part: index,
        callId,
        startedAt: part.startedAt,
        ok: part.ok,
        ...(part.error !== undefined ? { error: part.error } : {}),
        ...(part.images ? { images: part.images } : {}),
        ...(part.summary !== undefined ? { summary: part.summary } : {}),
      });
    }

    /**
     * 被同一个会话的新回复接替了（见 start，不该发生）：这个旁听者不再推任何事件，
     * 否则面板会把它的事件算到新回复头上
     */
    function replaced(): boolean {
      if (!reply || replies.get(conversationId) === reply) return false;
      ended = true;
      clearTimeout(timer);
      return true;
    }

    function handle(chunk: MessageChunk): void {
      if (ended || replaced()) return;
      if (chunk.type === 'start') {
        replyId ??= chunk.messageId;
        start();
        return;
      }
      const current = start();
      switch (chunk.type) {
        case 'start-step':
          flush();
          step++;
          stepStart = current.parts.length;
          return;
        case 'finish-step':
          flush();
          return;
        case 'reasoning-start':
          flush();
          startReasoning(current, chunk.id);
          return;
        case 'reasoning-delta': {
          if (!chunk.delta) return;
          const index = reasonings.get(chunk.id);
          if (index === undefined) {
            flush();
            hold('reasoning', chunk.id, startReasoning(current, chunk.id), chunk.delta);
          } else {
            hold('reasoning', chunk.id, index, chunk.delta);
          }
          return;
        }
        case 'reasoning-end': {
          flush();
          const index = reasonings.get(chunk.id);
          if (index !== undefined) endReasoning(current, index);
          reasonings.delete(chunk.id);
          return;
        }
        case 'text-start':
          flush();
          texts.set(chunk.id, undefined);
          return;
        case 'text-delta': {
          if (!chunk.delta) return;
          const known = texts.get(chunk.id);
          // 这一段还没推出过：推的时候在末尾新建（攒着的是别的段时，先推它）
          if (pending && (pending.kind !== 'text' || pending.id !== chunk.id)) flush();
          hold('text', chunk.id, known ?? pending?.part ?? current.parts.length, chunk.delta);
          return;
        }
        case 'text-end':
          flush();
          texts.delete(chunk.id);
          return;
        case 'tool-input-start':
          flush();
          tools.set(chunk.toolCallId, { name: chunk.toolName });
          return;
        case 'tool-input-available':
        case 'tool-input-error':
          flush();
          startTool(current, chunk.toolCallId, chunk.toolName, chunk.input);
          return;
        case 'tool-output-available':
          if (chunk.preliminary) return;
          flush();
          endTool(current, chunk.toolCallId, { ok: true, output: chunk.output });
          return;
        case 'tool-output-error':
          flush();
          endTool(current, chunk.toolCallId, { ok: false, error: chunk.errorText });
          return;
        case 'tool-output-denied':
          flush();
          endTool(current, chunk.toolCallId, { ok: false, error: '工具调用被拒绝' });
          return;
        case 'data-retry': {
          flush();
          const { phase, attempt, maxRetries, statusCode } = chunk.data;
          current.retry = {
            phase,
            attempt,
            maxRetries,
            ...(statusCode !== undefined ? { statusCode } : {}),
            at: iso(),
          };
          setState(current, 'retry');
          emit({ type: 'retry', ...progress(current, current.retry.at), retry: current.retry });
          return;
        }
        case 'reset-step': {
          // 失败那次的内容作废：攒着的不推，已推的截掉
          clearTimeout(timer);
          timer = undefined;
          pending = undefined;
          current.parts.splice(stepStart);
          texts.clear();
          reasonings.clear();
          for (const [callId, known] of tools) {
            if (known.part !== undefined && known.part >= stepStart) tools.delete(callId);
          }
          setState(current, 'thinking');
          emit({ type: 'reset', ...progress(current), step, keep: stepStart });
          return;
        }
        case 'finish':
          flush();
          finished = true;
          usage = chunk.messageMetadata?.usage;
          return;
        case 'error':
          flush();
          failed = true;
          error ??= errorLine(redact(chunk.errorText));
          return;
        case 'abort':
          flush();
          aborted = true;
          return;
        default:
          // 其余的段（message-metadata、来源、文件等）「此刻」不显示
          return;
      }
    }

    /** 回复结束：收尾还开着的思考与工具调用，推 end，从现场里去掉 */
    function end(): void {
      if (ended || replaced()) return;
      // 一个段都没收到就结束（如前端立刻取消）：等待合并中的也要收尾，否则什么都不推
      if (!reply) {
        if (replies.get(conversationId)?.startedAt !== undefined || !replies.has(conversationId)) {
          ended = true;
          return;
        }
        start();
      }
      const current = reply!;
      ended = true;
      // 收尾推的事件出错也要接着往下：这条一定从现场里去掉、一定推 end，不然它会一直停在现场里
      try {
        flush();
        current.parts.forEach((part, index) => {
          if (part.type === 'reasoning' && part.endedAt === undefined) endReasoning(current, index);
        });
        for (const [callId, known] of tools) {
          if (known.part === undefined) continue;
          const part = current.parts[known.part] as LiveTool;
          if (part.endedAt === undefined) {
            endTool(current, callId, { ok: false, error: unfinishedTool });
          }
        }
      } catch (failure) {
        report(failure);
      }
      const outcome = failed ? 'failed' : aborted || !finished ? 'aborted' : 'completed';
      const at = iso();
      if (outcome === 'completed') last = { conversationId, at };
      replies.delete(conversationId);
      emit({
        type: 'end',
        conversationId,
        ...(current.replyId ? { replyId: current.replyId } : {}),
        at,
        outcome,
        startedAt: current.startedAt!,
        ...(outcome === 'completed' && usage ? { usage } : {}),
        ...(outcome === 'failed' && error !== undefined
          ? { error: error.text, ...(error.statusCode ? { statusCode: error.statusCode } : {}) }
          : {}),
        ...(last ? { lastReply: last } : {}),
      });
    }

    return { chunk: guarded(handle), end: guarded(end) };
  }

  return {
    /** 给 sessions.onReply：每次回复开始时调用，返回这次回复的旁听者 */
    listener: ({
      conversationId,
      tasks,
    }: {
      conversationId: string;
      tasks?: readonly LiveTask[];
    }): ReplyWatcher => watch(conversationId, tasks),

    /** Telegram 的等待合并、回复中又被触发、一轮结束（见 RoundNotice） */
    round(notice: RoundNotice): void {
      try {
        const { conversationId } = notice;
        const existing = replies.get(conversationId);
        if (notice.type === 'wait') {
          // 已经有进行中的（不该发生）：不改
          if (existing) return;
          const reply: LiveReply = {
            conversationId,
            state: 'waiting',
            waitingSince: iso(),
            again: false,
            parts: [],
          };
          replies.set(conversationId, reply);
          emit({ type: 'wait', ...progress(reply, reply.waitingSince) });
        } else if (notice.type === 'again') {
          if (existing) {
            if (existing.again) return;
            existing.again = true;
            emit({ type: 'again', ...progress(existing) });
            return;
          }
          // 上一次回复的流刚结束、Telegram 还在发最后几条时被触发：等着下一次回复。
          // 没有等待时间：不是等待合并，下一次回复开始时不再带着「又被触发」
          const reply: LiveReply = {
            conversationId,
            state: 'waiting',
            again: true,
            parts: [],
          };
          replies.set(conversationId, reply);
          emit({ type: 'again', ...progress(reply) });
        } else if (existing && existing.startedAt === undefined) {
          // 这一轮结束了，还在等待：等待被放弃，没有回复
          replies.delete(conversationId);
          emit({ type: 'cancel', conversationId, at: iso() });
        }
      } catch (failure) {
        report(notice.conversationId, failure);
      }
    },

    /**
     * 网页会话生成中又发了消息（排队）：现场里那条记上「又被触发」与排队的起点 fromSeq，推 again
     * （已经在排队时不变）。现场里没有这个会话（回复刚结束、补的那次还没开始）时新建一条等待中的
     */
    queue(conversationId: string, fromSeq: number): void {
      try {
        const existing = replies.get(conversationId);
        if (existing) {
          if (existing.again && existing.queuedFrom !== undefined) return;
          existing.again = true;
          existing.queuedFrom = fromSeq;
          emit({ type: 'again', ...progress(existing), queuedFrom: fromSeq });
          return;
        }
        const reply: LiveReply = {
          conversationId,
          state: 'waiting',
          again: true,
          queuedFrom: fromSeq,
          parts: [],
        };
        replies.set(conversationId, reply);
        emit({ type: 'again', ...progress(reply), queuedFrom: fromSeq });
      } catch (failure) {
        report(conversationId, failure);
      }
    },

    /**
     * 网页会话排队的补回复取消了：进行中的那条去掉「又被触发」与排队，推 dequeue；
     * 只是在等补回复的那条（还没开始）整条去掉，推 cancel
     */
    unqueue(conversationId: string): void {
      try {
        const existing = replies.get(conversationId);
        if (!existing || existing.queuedFrom === undefined) return;
        if (existing.startedAt === undefined) {
          replies.delete(conversationId);
          emit({ type: 'cancel', conversationId, at: iso() });
          return;
        }
        existing.again = false;
        delete existing.queuedFrom;
        emit({ type: 'dequeue', ...progress(existing) });
      } catch (failure) {
        report(conversationId, failure);
      }
    },

    /** 现场：全部进行中的回复（深拷贝），以及它包含到的最后一个事件的序号 */
    snapshot(): LiveSnapshot {
      return { seq, replies: structuredClone([...replies.values()]) };
    },

    /** 上次回复：启动时取自数据库，之后每次回复正常完成时更新 */
    get lastReply(): LastReply | undefined {
      return last;
    },
  };
}

export type Live = ReturnType<typeof createLive>;

/** 工具结果里的图片 */
function outputImages(output: unknown): ImageInfo[] {
  if (!isStoredToolContent(output)) return [];
  return output.parts.flatMap((part): ImageInfo[] => {
    if (!isRecord(part) || part.type !== 'image') return [];
    if (typeof part.url !== 'string' || !part.url.startsWith(fileScheme)) return [];
    return [
      {
        src: fileSrc(part.url),
        ...(typeof part.width === 'number' && typeof part.height === 'number'
          ? { width: part.width, height: part.height }
          : {}),
      },
    ];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function json(value: unknown): string {
  if (value === undefined) return '';
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/, 1)[0] ?? '';
}

/** 最多 briefChars 个字符（按 Unicode 字符计），截了以「…」结尾 */
function brief(text: string): string {
  const chars = [...text];
  return chars.length <= briefChars ? text : `${chars.slice(0, briefChars - 1).join('')}…`;
}

export type { LivePart };
