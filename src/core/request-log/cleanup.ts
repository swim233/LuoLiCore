import { errorKind } from '../errors.js';
import type { Logger } from '../logger.js';
import type { RequestLog } from './log.js';

const day = 24 * 60 * 60 * 1000;

/**
 * 定时清理请求记录：立即清理一次，之后每 intervalMs（默认 24 小时）一次。上一次还没清完时
 * 跳过这一次。定时器不阻止进程退出。每次清理记一条日志（删了多少请求、多少内容、耗时）；
 * 出错只记日志。stop() 停止定时器，让进行中的清理在下一批之前停下并等它结束
 */
export function startRequestLogCleanup(
  log: Pick<RequestLog, 'cleanup'>,
  {
    logger,
    intervalMs = day,
    batchSize,
  }: { logger: Logger; intervalMs?: number; batchSize?: number },
): { stop(): Promise<void> } {
  const controller = new AbortController();
  let running: Promise<void> | undefined;

  const run = () => {
    if (running || controller.signal.aborted) return;
    const startedAt = Date.now();
    running = log
      .cleanup({ batchSize, signal: controller.signal })
      .then(
        ({ requests, contents }) => {
          logger.info(
            {
              requests,
              contents,
              durationMs: Date.now() - startedAt,
              ...(controller.signal.aborted ? { stopped: true } : {}),
            },
            'requests.cleanup',
          );
        },
        (error: unknown) => {
          logger.warn(
            { errorType: errorKind(error), durationMs: Date.now() - startedAt },
            'requests.cleanup_failed',
          );
        },
      )
      .finally(() => {
        running = undefined;
      });
  };

  run();
  const timer = setInterval(run, intervalMs);
  timer.unref();

  return {
    async stop() {
      clearInterval(timer);
      controller.abort();
      await running;
    },
  };
}
