import { AsyncLocalStorage } from 'node:async_hooks';
import { errorKind } from '../errors.js';
import type { Logger } from '../logger.js';
import { createRedactor } from '../redact.js';
import type { NewRequest, RequestLog, RequestResponse } from './log.js';
import {
  collectResponse,
  errorText,
  formatError,
  isStreamingRequest,
  type ErrorText,
  type ResponseCollector,
} from './response.js';

// 在 provider 的 fetch 处截获每一次请求与响应，写进请求记录（ADR-0008）。
//
// fetch 不知道这次请求属于哪个会话、哪一步：跟踪每次请求的中间件（trackAttempts）在调用下层的
// doStream 时用 AsyncLocalStorage 带上这次请求的说明，provider 在 doStream 的调用链里发起 fetch，
// 这里取出来。没有说明的请求照常发出，不记。发出的请求不加任何东西。
//
// 响应体换成一个按需读取的流：SDK 读一段，这里才从原来的流读一段、记下再交出，不预读、不缓存，
// SDK 看到的字节、状态码、响应头都不变。每次请求在正常读完、出错、中止、SDK 取消读取时
// 落到且只落到一条记录上；写入在这之后另起，不阻塞 SDK。记录器自己的任何异常只记日志。

/** 一次请求的说明：由跟踪请求的中间件带给 fetch */
export type RequestContext = Pick<
  NewRequest,
  'conversationId' | 'purpose' | 'replyId' | 'step' | 'attempt'
> & {
  /**
   * 请求被中止时怎么记：用户中止为 aborted；超时为 failed，error 写明是哪种超时；
   * 没有被中止时为 undefined。在请求结束时调用
   */
  aborted: () => { outcome: 'aborted' } | { outcome: 'failed'; error: string } | undefined;
};

const requestContext = new AsyncLocalStorage<RequestContext>();

/** 在 run 的调用链里发起的 fetch 都带着这次请求的说明 */
export function withRequestContext<T>(context: RequestContext, run: () => T): T {
  return requestContext.run(context, run);
}

export type RequestRecorder = {
  /** 交给 provider 的 fetch（createModel 的 fetch 选项） */
  fetch: typeof globalThis.fetch;
  /** 等已经开始的写入都完成；出错的写入只记日志，这里不抛 */
  flush(): Promise<void>;
};

/**
 * 记录器：包住 fetch，把带着说明的请求写进 log。secrets（API key 等）出现在 error 里时抹成 `***`，
 * 与日志同一套抹法
 */
export function createRequestRecorder({
  log,
  logger,
  secrets = [],
  fetch: baseFetch = globalThis.fetch,
}: {
  log: Pick<RequestLog, 'record'>;
  logger: Logger;
  secrets?: ReadonlyArray<string | undefined>;
  /** 实际发请求的 fetch，默认全局的；测试里换成假的服务端 */
  fetch?: typeof globalThis.fetch;
}): RequestRecorder {
  const redact = createRedactor(secrets);
  const pending = new Set<Promise<void>>();

  const write = (request: NewRequest) => {
    // 下一轮事件循环再写：拆请求体、算哈希不占用 SDK 读完这次响应的那一轮
    const promise = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => log.record(request))
      .catch((error: unknown) => {
        logger.warn(
          {
            conversationId: request.conversationId,
            replyId: request.replyId,
            errorType: errorKind(error),
          },
          'requests.write_failed',
        );
      });
    pending.add(promise);
    void promise.finally(() => pending.delete(promise));
  };

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const context = requestContext.getStore();
    const body = init?.body;
    if (!context || typeof body !== 'string') return baseFetch(input, init);

    let capture: Capture | undefined;
    try {
      capture = startCapture({ context, body, signal: init?.signal, redact, logger, write });
    } catch (error) {
      captureFailed(logger, context, error);
    }
    let response: Response;
    try {
      response = await baseFetch(input, init);
    } catch (error) {
      capture?.failed(error);
      throw error;
    }
    return capture ? capture.respond(response) : response;
  };

  return {
    fetch,
    async flush() {
      while (pending.size > 0) await Promise.all(pending);
    },
  };
}

type Capture = {
  /** fetch 本身失败（连不上、发出前或收到响应头前被中止） */
  failed(error: unknown): void;
  /** 收到响应：返回给 SDK 的响应，内容与原来的相同 */
  respond(response: Response): Response;
};

function startCapture({
  context,
  body,
  signal,
  redact,
  logger,
  write,
}: {
  context: RequestContext;
  body: string;
  signal: AbortSignal | null | undefined;
  redact: (text: string) => string;
  logger: Logger;
  write: (request: NewRequest) => void;
}): Capture {
  const startedAt = Date.now();
  let status: number | undefined;
  let collector: ResponseCollector | undefined;
  let done = false;
  // 记录器自己出错后不再整理，这次请求不写
  let broken = false;

  const guard = (run: () => void) => {
    if (broken) return;
    try {
      run();
    } catch (error) {
      broken = true;
      signal?.removeEventListener('abort', onAbort);
      captureFailed(logger, context, error);
    }
  };

  /** 结束这次请求：how 是怎么结束的 */
  const finish = (how: { type: 'end' } | { type: 'cancel' } | { type: 'error'; error: unknown }) =>
    guard(() => {
      if (done) return;
      done = true;
      signal?.removeEventListener('abort', onAbort);
      const collected = collector?.end(how.type === 'end');
      const result = outcomeOf(how, status, collected?.error, context.aborted());
      const response: RequestResponse = {
        ...(status === undefined ? {} : { status }),
        ...collected?.fields,
        ...(result.error === undefined ? {} : { error: formatError(result.error, redact) }),
      };
      write({
        conversationId: context.conversationId,
        purpose: context.purpose,
        replyId: context.replyId,
        step: context.step,
        attempt: context.attempt,
        startedAt: new Date(startedAt).toISOString(),
        durationMs: Date.now() - startedAt,
        outcome: result.outcome,
        body,
        response,
      });
    });

  // 中止时 SDK 可能已不再读响应体：不等读取那边报错，在这里就结束这次请求
  const onAbort = () => finish({ type: 'error', error: signal?.reason });
  signal?.addEventListener('abort', onAbort, { once: true });

  return {
    failed: (error) => finish({ type: 'error', error }),
    respond(response) {
      guard(() => {
        status = response.status;
        collector = collectResponse(response.status, response.headers.get('content-type'), () =>
          isStreamingRequest(body),
        );
      });
      // 没有响应体，或状态码不能用来新建 Response（fetch 实际不会给出）：原样交出
      if (broken || !response.body || response.status < 200 || response.status > 599) {
        finish({ type: 'end' });
        return response;
      }
      const reader = response.body.getReader();
      const observed = new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            let next: Awaited<ReturnType<typeof reader.read>>;
            try {
              next = await reader.read();
            } catch (error) {
              finish({ type: 'error', error });
              controller.error(error);
              return;
            }
            if (next.done) {
              finish({ type: 'end' });
              controller.close();
              return;
            }
            guard(() => collector?.chunk(next.value));
            controller.enqueue(next.value);
          },
          cancel(reason) {
            finish({ type: 'cancel' });
            return reader.cancel(reason);
          },
        },
        // 不预读：SDK 要一段才读一段
        { highWaterMark: 0 },
      );
      return new Response(observed, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    },
  };
}

/**
 * 这次请求的结果：
 * - 正常读完：非 2xx、流里有错误事件、流式请求没有结束原因（含服务端回了非流式响应）为 failed，
 *   否则 completed；
 * - 2xx 的流里已有错误事件（之后 SDK 取消读取、重新生成）：failed，error 是那个错误事件；
 * - 被中止（含读取时中止）：用户中止为 aborted，超时为 failed 并写明哪种超时；
 * - 非 2xx 的响应体没读完：failed，error 是已读到的部分；
 * - SDK 取消读取（没有中止）：aborted，注明读取被提前取消；
 * - 其他出错（连不上、连接中途断开）：failed，error 是错误类型与消息
 */
function outcomeOf(
  how: { type: 'end' } | { type: 'cancel' } | { type: 'error'; error: unknown },
  status: number | undefined,
  collectedError: ErrorText | undefined,
  aborted: ReturnType<RequestContext['aborted']>,
): { outcome: NewRequest['outcome']; error?: ErrorText } {
  const httpFailed = status !== undefined && (status < 200 || status >= 300);
  const failed = (error: ErrorText | undefined) => ({
    outcome: 'failed' as const,
    error: error ?? errorText(''),
  });
  if (how.type === 'end') {
    return httpFailed || collectedError !== undefined
      ? failed(collectedError)
      : { outcome: 'completed' };
  }
  if (!httpFailed && collectedError !== undefined) return failed(collectedError);
  if (aborted?.outcome === 'aborted') return { outcome: 'aborted' };
  if (aborted) return failed(errorText(aborted.error));
  if (httpFailed) return failed(collectedError);
  if (how.type === 'cancel') return { outcome: 'aborted', error: errorText('读取被提前取消') };
  return failed(errorText(describeError(how.error)));
}

/** 错误类型与消息，连同 cause（如 undici 的连接错误） */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const text = `${error.name}: ${error.message}`;
  const cause = error.cause;
  if (cause instanceof Error) return `${text}（${cause.name}: ${cause.message}）`;
  return cause === undefined ? text : `${text}（${String(cause)}）`;
}

function captureFailed(logger: Logger, context: RequestContext, error: unknown): void {
  logger.warn(
    {
      conversationId: context.conversationId,
      replyId: context.replyId,
      errorType: errorKind(error),
    },
    'requests.capture_failed',
  );
}
