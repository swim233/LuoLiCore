import { APICallError, type LanguageModelMiddleware } from 'ai';
import type { Logger } from './logger.js';
import type { MessageChunk, MessageData } from './message.js';

type WrapStream = NonNullable<LanguageModelMiddleware['wrapStream']>;
type ModelStream = Awaited<ReturnType<WrapStream>>['stream'];
type ModelStreamPart = ModelStream extends ReadableStream<infer P> ? P : never;

export type AttemptStats = {
  /** 模型请求次数，含重试 */
  attempts: number;
  /** 请求阶段（流开始前）的重试次数，由 SDK 的 maxRetries 执行 */
  requestRetries: number;
  /** 流中出现错误事件后的重新生成次数，由 SDK 的 streamRetries 执行 */
  streamRetries: number;
};

/**
 * 跟踪一轮回复里的每次模型请求：写 `model.attempt` 日志、统计两类重试、通知前端。
 * 是否会重试的判断照搬 SDK，SDK 本身没有逐次重试的回调。
 */
export function trackAttempts({
  logger,
  logFields,
  maxRetries,
  abortSignal,
  firstChunkMs,
  onFirstChunkTimeout,
  notify,
}: {
  logger: Logger;
  logFields: object;
  maxRetries: number;
  /** 用户的中止信号；请求被中止而它没有中止时，就是超时 */
  abortSignal?: AbortSignal;
  /** 每次请求从发出起到第一段内容的时限；到时调用 onFirstChunkTimeout */
  firstChunkMs: number;
  onFirstChunkTimeout: () => void;
  /** 请求阶段的重试提示，发生在流开始前，直接写进外层流 */
  notify: (chunk: MessageChunk) => void;
}): {
  middleware: LanguageModelMiddleware;
  /** 包在 UI 流上：在新一次尝试的内容之前插入流式重试的提示与 reset-step */
  markStreamRetries: () => TransformStream<MessageChunk, MessageChunk>;
  /**
   * 同一轮回复里另起一次 streamText 调用（拒收图片后的重试）：按新调用重新计数，
   * 丢掉上一次调用还没插入的流式重试提示（上一次调用的 UI 流整个不发出）。stats 照常累计
   */
  restart: () => void;
  /**
   * 刚失败的那次请求被外层的中间件接住、重发了（工具图片被拒收后换成占位），SDK 没有看到这次失败：
   * 不算进请求阶段的连续失败，之后的重试序号与 SDK 一致
   */
  discountFailure: () => void;
  stats: AttemptStats;
  /**
   * 第一次出现输出（非空的文字、推理、工具调用参数，完整的工具调用）的时间（Date.now()），
   * 之后被流式重试作废的也算；还没有时为 undefined
   */
  firstOutputAt: () => number | undefined;
  /** 发出过请求的步数；拒收图片后的重试从第 1 步重新数，这里取两次调用里多的那个 */
  steps: () => number;
  /**
   * 最近一次请求是否已有输出（文字、推理、工具调用）。超时结束回复时据此区分
   * 首段超时与段间超时：超时那次请求就是最近一次
   */
  attemptHasOutput: () => boolean;
} {
  const stats: AttemptStats = { attempts: 0, requestRetries: 0, streamRetries: 0 };
  let firstOutputAt: number | undefined;
  // 当前这次调用里请求阶段连续失败的次数。SDK 每次调用（包括流式重试发起的那次）
  // 都重新计算请求重试次数，这个计数与 SDK 的 tryNumber 对应
  let requestFailures = 0;
  // 当前这一步里流式重试的次数（SDK 的 streamRetries 按步计）
  let stepStreamRetries = 0;
  // 当前是这次 streamText 调用的第几步（从 0 数）。SDK 不告诉中间件，按请求推断：
  // 一次请求正常结束后的下一次请求是新的一步，失败后的下一次是同一步的重试
  let step = 0;
  let stepDone = false;
  let steps = 0;
  // 最近一次请求是否已有输出
  let attemptOutput = false;
  // UI 流里已出现的内容段起点数（见 modelStarts），用来在 UI 流里定位尝试的边界
  let contentStarts = 0;
  // 等待插入 UI 流的流式重试提示。notices 首项是重新生成提示，其后是这次重新生成的
  // 请求阶段重试提示：它们若直接写出，会排到「输出中断」之前，甚至夹在失败那次的半截中间。
  // step 是出错的那一步：UI 流可能还没走完前一步，不能在前一步的结尾插入
  const pendingStreamRetries: Array<{
    notices: MessageChunk[];
    step: number;
    afterStarts: number;
  }> = [];

  const retryNotice = (data: MessageData['retry']): MessageChunk => ({
    type: 'data-retry',
    data,
    transient: true,
  });

  const middleware: LanguageModelMiddleware = {
    wrapStream: async ({ doStream, params }) => {
      if (stepDone) {
        step++;
        stepDone = false;
        stepStreamRetries = 0;
      }
      const attempt = ++stats.attempts;
      steps = Math.max(steps, step + 1);
      attemptOutput = false;
      const startedAt = Date.now();
      const fields = () => ({
        ...logFields,
        attempt,
        step: step + 1,
        durationMs: Date.now() - startedAt,
      });
      // 这次请求是怎么被中止的：用户中止，或超时（SDK 合并进 params.abortSignal 的超时、
      // 以及下面的首段计时都会中止它，而用户的信号不变）
      const abortedBy = () =>
        abortSignal?.aborted ? 'user' : params.abortSignal?.aborted ? 'timeout' : undefined;
      // 被用户中止的请求不算失败、不算重试；超时算失败，SDK 不重试
      const logAborted = (phase: 'request' | 'stream') => {
        if (abortedBy() === 'user') {
          logger.info({ ...fields(), phase, aborted: true, willRetry: false }, 'model.attempt');
        } else {
          logger.warn(
            { ...fields(), phase, ok: false, timeout: true, willRetry: false },
            'model.attempt',
          );
        }
      };

      // SDK 的 firstChunkMs 从收到响应头才开始计时，服务端迟迟不响应时等不到超时。
      // 这里从发出请求起计时，到第一段内容为止；每次请求（含重试）重新计时，重试等待不算在内
      let firstChunkTimer: NodeJS.Timeout | undefined = setTimeout(
        onFirstChunkTimeout,
        firstChunkMs,
      );
      const clearFirstChunkTimer = () => {
        clearTimeout(firstChunkTimer);
        firstChunkTimer = undefined;
      };

      let result;
      try {
        result = await doStream();
      } catch (error) {
        clearFirstChunkTimer();
        if (abortedBy()) {
          logAborted('request');
          throw error;
        }
        requestFailures++;
        // SDK：APICallError 且可重试，且本次调用的失败次数未超过 maxRetries
        const willRetry =
          APICallError.isInstance(error) && error.isRetryable && requestFailures <= maxRetries;
        logger.warn(
          { ...fields(), phase: 'request', ok: false, ...describeFailure(error), willRetry },
          'model.attempt',
        );
        if (willRetry) {
          stats.requestRetries++;
          const statusCode = APICallError.isInstance(error) ? error.statusCode : undefined;
          const notice = retryNotice({
            phase: 'request',
            attempt: requestFailures,
            maxRetries,
            statusCode,
          });
          const pending = pendingStreamRetries.at(-1);
          if (pending) pending.notices.push(notice);
          else notify(notice);
        }
        throw error;
      }
      requestFailures = 0;

      let logged = false;
      // 收尾步（toolChoice 为 none）里 SDK 不放出工具段，也不因它们缓冲之后的段
      const withholdsTools = params.toolChoice?.type === 'none';
      // 这次请求从第一个工具段起，SDK 把之后的段都缓冲到请求正常结束才放出，失败时整批丢弃。
      // held 是缓冲着的内容段起点数
      let buffering = false;
      let held = 0;
      let failed = false;
      const stream = observe(result.stream, {
        onPart(part) {
          const visible = !(withholdsTools && part.type.startsWith('tool-'));
          if (visible && part.type.startsWith('tool-')) buffering = true;
          if (visible && modelStarts.has(part.type)) {
            if (buffering) held++;
            else contentStarts++;
          }
          if (visible && isOutput(part)) {
            clearFirstChunkTimer();
            attemptOutput = true;
            firstOutputAt ??= Date.now();
          }
          if (part.type === 'finish' && !failed) {
            contentStarts += held;
            held = 0;
            stepDone = true;
          }
          if (part.type === 'error') {
            clearFirstChunkTimer();
            failed = true;
          }
          if (part.type !== 'error' || logged) return;
          logged = true;
          // SDK：流中的任何错误事件都会重新生成，直到次数用完；不看是否可重试
          const willRetry = stepStreamRetries < maxRetries;
          const statusCode = statusCodeOf(part.error);
          logger.warn(
            { ...fields(), phase: 'stream', ok: false, statusCode, willRetry },
            'model.attempt',
          );
          if (willRetry) {
            stats.streamRetries++;
            stepStreamRetries++;
            pendingStreamRetries.push({
              notices: [
                retryNotice({
                  phase: 'stream',
                  attempt: stepStreamRetries,
                  maxRetries,
                  statusCode,
                }),
              ],
              step,
              afterStarts: contentStarts,
            });
          }
        },
        onClose() {
          clearFirstChunkTimer();
          if (logged) return;
          logged = true;
          if (abortedBy()) logAborted('stream');
          else logger.info({ ...fields(), phase: 'stream', ok: true }, 'model.attempt');
        },
        // 读流时抛错（如连接中途断开）SDK 不重试；中止时 fetch 也以这种方式结束
        onError(error) {
          clearFirstChunkTimer();
          if (logged) return;
          logged = true;
          if (abortedBy()) return logAborted('stream');
          logger.warn(
            {
              ...fields(),
              phase: 'stream',
              ok: false,
              ...describeFailure(error),
              willRetry: false,
            },
            'model.attempt',
          );
        },
        // SDK 因中止或超时不再读这个流。通常挂起的读取随后以 done 返回、由 onClose 记下；
        // 这里兜住当时没有挂起读取的情况。回复流被消费方取消不会传到这里（请求在后台照常读完）
        onCancel() {
          clearFirstChunkTimer();
          if (logged || !abortedBy()) return;
          logged = true;
          logAborted('stream');
        },
      });
      return { ...result, stream };
    },
  };

  // 中间件看到错误事件时，UI 流可能还没处理完失败那次的内容（中间有缓冲），甚至还没走完前一步，
  // 所以不按时间、而按步与内容段的个数定位：失败那次（及之前）在 UI 流里共有 afterStarts 个内容段，
  // 那一步里之后的第一个内容段属于新的尝试。SDK 在重试前会补发 text-end 收尾，
  // 所以插入点之前失败那次的段都已结束，reset-step 能把它们从这一步里整段去掉。
  // 前提：模型流的内容段起点与 UI 流一一对应（不关 sendReasoning；见 modelStarts、uiStarts）
  const markStreamRetries = () => {
    let starts = 0;
    // UI 流里已开始的步数（start-step 段数）
    let uiSteps = 0;
    return new TransformStream<MessageChunk, MessageChunk>({
      transform(chunk, controller) {
        if (chunk.type === 'start-step') uiSteps++;
        const isStart = uiStarts.has(chunk.type);
        // 新的尝试一个内容段都没给就结束、失败或被中止时，在结束段之前插入，
        // 失败那次的半截也就不会随中止写入历史。一步结束时只插入这一步的
        const endsReply =
          chunk.type === 'finish' || chunk.type === 'error' || chunk.type === 'abort';
        const endsStep = chunk.type === 'finish-step';
        while (pendingStreamRetries[0]) {
          const { step: retryStep, afterStarts } = pendingStreamRetries[0];
          const inStep = uiSteps > retryStep;
          if (!(endsReply || (inStep && (endsStep || (isStart && afterStarts <= starts))))) break;
          const [streamNotice, ...requestNotices] = pendingStreamRetries.shift()!.notices;
          controller.enqueue(streamNotice!);
          controller.enqueue({ type: 'reset-step' });
          for (const notice of requestNotices) controller.enqueue(notice);
        }
        if (isStart) starts++;
        controller.enqueue(chunk);
      },
    });
  };

  const restart = () => {
    requestFailures = 0;
    stepStreamRetries = 0;
    step = 0;
    stepDone = false;
    contentStarts = 0;
    pendingStreamRetries.length = 0;
  };

  const discountFailure = () => {
    requestFailures = Math.max(0, requestFailures - 1);
  };

  return {
    middleware,
    markStreamRetries,
    restart,
    discountFailure,
    stats,
    firstOutputAt: () => firstOutputAt,
    steps: () => steps,
    attemptHasOutput: () => attemptOutput,
  };
}

// 模型流里在 UI 流中各有一段与之对应的起点：文字、推理段的开始，工具调用参数的开始，
// 完整的工具调用（UI 流里依次是 text-start、reasoning-start、tool-input-start，
// 以及 tool-input-available 或不合规时的 tool-input-error）
const modelStarts = new Set(['text-start', 'reasoning-start', 'tool-input-start', 'tool-call']);
const uiStarts = new Set<string>([
  'text-start',
  'reasoning-start',
  'tool-input-start',
  'tool-input-available',
  'tool-input-error',
]);

/** 算作模型输出的段，与 SDK 计首段、段间超时时一致：非空的增量、完整的工具调用、文件 */
function isOutput(part: ModelStreamPart): boolean {
  switch (part.type) {
    case 'text-delta':
    case 'reasoning-delta':
    case 'tool-input-delta':
      return part.delta !== '';
    case 'tool-call':
    case 'file':
    case 'reasoning-file':
      return true;
    default:
      return false;
  }
}

function observe(
  source: ModelStream,
  handlers: {
    onPart: (part: ModelStreamPart) => void;
    onClose: () => void;
    onError: (error: unknown) => void;
    onCancel: () => void;
  },
): ModelStream {
  const reader = source.getReader();
  return new ReadableStream<ModelStreamPart>({
    async pull(controller) {
      let next;
      try {
        next = await reader.read();
      } catch (error) {
        handlers.onError(error);
        controller.error(error);
        return;
      }
      if (next.done) {
        handlers.onClose();
        controller.close();
        return;
      }
      handlers.onPart(next.value);
      controller.enqueue(next.value);
    },
    cancel(reason) {
      handlers.onCancel();
      return reader.cancel(reason);
    },
  });
}

function describeFailure(error: unknown): object {
  if (!APICallError.isInstance(error)) {
    return { errorType: error instanceof Error ? error.name : typeof error };
  }
  return error.statusCode === undefined ? { networkError: true } : { statusCode: error.statusCode };
}

function statusCodeOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('statusCode' in error)) return undefined;
  return typeof error.statusCode === 'number' ? error.statusCode : undefined;
}
