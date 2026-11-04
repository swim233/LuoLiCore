import { afterEach, describe, expect, it } from 'vitest';
import type { Logger, RequestCleanupOptions } from '../index.js';
import { startRequestLogCleanup } from './cleanup.js';

type LogEntry = { level: string; msg: string; fields: Record<string, unknown> };

function recordingLogger(): { logger: Logger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const record = (level: string) => (fields: object, msg: string) => {
    entries.push({ level, msg, fields: fields as Record<string, unknown> });
  };
  return {
    logger: { info: record('info'), warn: record('warn'), error: record('error') },
    entries,
  };
}

const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!check()) {
    if (performance.now() > deadline) throw new Error('等待超时');
    await sleep(5);
  }
}

describe('定时清理', () => {
  it('立即清理一次，之后每隔一段时间一次；每次一条日志：删了多少、耗时', async () => {
    const { logger, entries } = recordingLogger();
    const calls: RequestCleanupOptions[] = [];
    const log = {
      cleanup: async (options: RequestCleanupOptions = {}) => {
        calls.push(options);
        return { requests: 3, contents: 7 };
      },
    };

    const cleanup = startRequestLogCleanup(log, { logger, intervalMs: 30, batchSize: 50 });
    stops.push(cleanup.stop);
    expect(calls).toHaveLength(1);
    await until(() => calls.length >= 3);
    await cleanup.stop();
    const count = calls.length;
    await sleep(80);

    expect(calls).toHaveLength(count);
    expect(calls[0]).toMatchObject({ batchSize: 50 });
    const logs = entries.filter((entry) => entry.msg === 'requests.cleanup');
    expect(logs.length).toBeGreaterThanOrEqual(3);
    expect(logs[0]).toMatchObject({ level: 'info', fields: { requests: 3, contents: 7 } });
    expect(typeof logs[0]!.fields.durationMs).toBe('number');
  });

  it('上一次还没清完时跳过这一次', async () => {
    const { logger } = recordingLogger();
    let calls = 0;
    let finish: () => void = () => {};
    const log = {
      cleanup: () => {
        calls++;
        return new Promise<{ requests: number; contents: number }>((resolve) => {
          finish = () => resolve({ requests: 0, contents: 0 });
        });
      },
    };

    const cleanup = startRequestLogCleanup(log, { logger, intervalMs: 10 });
    stops.push(cleanup.stop);
    await sleep(60);
    expect(calls).toBe(1);
    finish();
    await until(() => calls >= 2);
    finish();
  });

  it('stop：中止进行中的清理并等它结束，日志注明 stopped', async () => {
    const { logger, entries } = recordingLogger();
    let signal: AbortSignal | undefined;
    const log = {
      cleanup: async (options: RequestCleanupOptions = {}) => {
        signal = options.signal;
        await new Promise((resolve) => options.signal?.addEventListener('abort', resolve));
        return { requests: 2, contents: 1 };
      },
    };

    const cleanup = startRequestLogCleanup(log, { logger });
    await cleanup.stop();

    expect(signal?.aborted).toBe(true);
    expect(entries).toEqual([
      expect.objectContaining({
        msg: 'requests.cleanup',
        fields: expect.objectContaining({ requests: 2, contents: 1, stopped: true }),
      }),
    ]);
  });

  it('出错只记一条 warn（错误类型），之后照常定时', async () => {
    const { logger, entries } = recordingLogger();
    let calls = 0;
    const log = {
      cleanup: async () => {
        calls++;
        if (calls === 1) throw new RangeError('坏了');
        return { requests: 0, contents: 0 };
      },
    };

    const cleanup = startRequestLogCleanup(log, { logger, intervalMs: 20 });
    stops.push(cleanup.stop);
    await until(() => calls >= 2);

    const failed = entries.filter((entry) => entry.msg === 'requests.cleanup_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ level: 'warn', fields: { errorType: 'RangeError' } });
    expect(JSON.stringify(failed[0])).not.toContain('坏了');
  });
});
