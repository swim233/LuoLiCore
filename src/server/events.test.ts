import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Logger } from '../core/index.js';
import { createApp } from './app.js';
import { createEvents } from './events.js';
import type { ServiceStatus } from './types.js';
import { emptyLive, emptyViews } from './test-kit.js';

const port = 7310;

type LogEntry = { level: string; msg: string; fields: Record<string, unknown> };

const dirs: string[] = [];
const readers: Array<ReadableStreamDefaultReader<Uint8Array>> = [];
afterEach(async () => {
  for (const reader of readers.splice(0)) await reader.cancel().catch(() => {});
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup({
  heartbeat = 60_000,
  backlogLimit,
}: { heartbeat?: number; backlogLimit?: number } = {}) {
  const entries: LogEntry[] = [];
  const record = (level: string) => (fields: object, msg: string) => {
    entries.push({ level, msg, fields: fields as Record<string, unknown> });
  };
  const logger: Logger = { info: record('info'), warn: record('warn'), error: record('error') };
  let status: ServiceStatus = statusAt(1, true);
  const events = createEvents({
    hello: () => ({ ...status, live: emptyLive }),
    logger,
    heartbeat,
    backlogLimit,
  });
  const dist = mkdtempSync(join(tmpdir(), 'luoli-web-'));
  dirs.push(dist);
  const app = createApp({ port, dist, events, views: emptyViews(), status: () => status, logger });

  /** 连上 SSE，返回响应与一个按需读文字的读取器 */
  async function connect() {
    const response = await app.request('/api/events', { headers: { host: `127.0.0.1:${port}` } });
    const reader = response.body!.getReader();
    readers.push(reader);
    const decoder = new TextDecoder();
    let text = '';
    return {
      response,
      reader,
      /** 读到满足条件为止，返回目前读到的全部文字 */
      async readUntil(done: (text: string) => boolean, timeoutMs = 2000): Promise<string> {
        const deadline = Date.now() + timeoutMs;
        while (!done(text)) {
          let timer: NodeJS.Timeout | undefined;
          const result = await Promise.race([
            reader.read(),
            new Promise<undefined>((resolve) => {
              timer = setTimeout(() => resolve(undefined), Math.max(0, deadline - Date.now()));
            }),
          ]);
          clearTimeout(timer);
          if (!result) throw new Error(`等待 SSE 超时，已收到：${text}`);
          if (result.done) throw new Error(`SSE 已结束，已收到：${text}`);
          text += decoder.decode(result.value, { stream: true });
        }
        return text;
      },
    };
  }

  return {
    events,
    entries,
    connect,
    head: () =>
      app.request('/api/events', { method: 'HEAD', headers: { host: `127.0.0.1:${port}` } }),
    setStatus: (next: ServiceStatus) => (status = next),
  };
}

function statusAt(uptimeSeconds: number, connected = false): ServiceStatus {
  return {
    startedAt: '2026-11-08T00:00:00.000Z',
    uptimeSeconds,
    telegram: { enabled: true, connected },
    assistant: { name: '洛璃', wakeWords: ['nori'] },
    web: { author: 'Alice' },
  };
}

/** 文字里的 SSE 事件（不含注释行） */
function parse(text: string): Array<{ event?: string; data: unknown }> {
  return text
    .split('\n\n')
    .filter((block) => block.split('\n').some((line) => line.startsWith('data:')))
    .map((block) => {
      const lines = block.split('\n');
      const event = lines.find((line) => line.startsWith('event: '))?.slice('event: '.length);
      const data = lines
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice('data: '.length))
        .join('\n');
      return { event, data: JSON.parse(data) };
    });
}

const waitUntil = async (check: () => boolean, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('等待超时');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

describe('SSE：GET /api/events', () => {
  it('连上先收到 hello，带服务的状态与现场；响应头是 SSE、不缓存、不让反向代理攒着', async () => {
    const { connect, setStatus } = setup();
    const status: ServiceStatus = { ...statusAt(7), startedAt: '2026-11-08T01:02:03.000Z' };
    setStatus(status);

    const { response, readUntil } = await connect();
    const text = await readUntil((t) => t.includes('\n\n'));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    expect(parse(text)).toEqual([{ event: 'hello', data: { ...status, live: emptyLive } }]);
  });

  it('之后按间隔发心跳注释', async () => {
    const { connect } = setup({ heartbeat: 20 });

    const { readUntil } = await connect();
    const text = await readUntil((t) => t.split(': ping\n\n').length > 2);

    // 先是 hello，之后是两次以上的心跳
    expect(text.startsWith('event: hello\n')).toBe(true);
    expect(parse(text)).toHaveLength(1);
  });

  it('broadcast 发给每个连着的面板', async () => {
    const { connect, events } = setup();
    const first = await connect();
    const second = await connect();
    await first.readUntil((t) => t.includes('\n\n'));
    await second.readUntil((t) => t.includes('\n\n'));
    const next = statusAt(99);

    events.broadcast('status', next);

    for (const client of [first, second]) {
      const text = await client.readUntil((t) => parse(t).length === 2);
      expect(parse(text)[1]).toEqual({ event: 'status', data: next });
    }
  });

  it('断开后清理：连接数归零，日志记连上与断开各一行', async () => {
    const { connect, events, entries } = setup({ heartbeat: 10 });

    const { reader, readUntil } = await connect();
    await readUntil((t) => t.includes('\n\n'));
    expect(events.size).toBe(1);
    await reader.cancel();
    await waitUntil(() => events.size === 0);

    expect(entries.filter((entry) => entry.msg.startsWith('web.events.'))).toEqual([
      { level: 'info', msg: 'web.events.open', fields: { clients: 1 } },
      { level: 'info', msg: 'web.events.close', fields: { clients: 0 } },
    ]);
    // 断开之后心跳也停了：不再有别的日志
    const count = entries.length;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(entries.length).toBe(count);
  });

  it('退出时 close 结束所有连接；之后新连上的收到 hello 后立即结束', async () => {
    const { connect, events } = setup();
    const { reader, readUntil } = await connect();
    await readUntil((t) => t.includes('\n\n'));

    await events.close();
    expect(events.size).toBe(0);
    let result = await reader.read();
    while (!result.done) result = await reader.read();

    const late = await connect();
    let text = '';
    const decoder = new TextDecoder();
    for (let next = await late.reader.read(); !next.done; next = await late.reader.read()) {
      text += decoder.decode(next.value, { stream: true });
    }
    expect(parse(text).map((event) => event.event)).toEqual(['hello']);
  });

  it('退出时不读数据的连接不会卡住：最多等 timeoutMs', async () => {
    const { connect, events } = setup();
    // 连上之后一直不读：hello 与之后的事件都写不出去
    await connect();
    for (let i = 0; i < 5; i++) events.broadcast('status', statusAt(i));

    const startedAt = Date.now();
    await events.close(50);

    expect(Date.now() - startedAt).toBeLessThan(1000);
  });

  it('积压：不读数据的连接攒到上限后被断开（流正常结束），别的连接照常收到全部事件', async () => {
    const { connect, events, entries } = setup({ backlogLimit: 5 });
    const reading = await connect();
    await reading.readUntil((t) => t.includes('\n\n'));
    // 连上之后一直不读
    const stalled = await connect();
    await waitUntil(() => events.size === 2);

    // 读的那个一直在读；事件一个个推（同一时刻推出的一批，在写出去之前都算攒着）
    const received = reading.readUntil((t) => parse(t).length === 31);
    for (let i = 0; i < 30; i++) {
      events.broadcast('status', statusAt(i));
      await new Promise((resolve) => setImmediate(resolve));
    }

    const text = await received;
    expect(parse(text).slice(1)).toEqual(
      Array.from({ length: 30 }, (_, i) => ({ event: 'status', data: statusAt(i) })),
    );
    await waitUntil(() => events.size === 1);
    expect(entries.filter((entry) => entry.msg === 'web.events.overflow')).toEqual([
      { level: 'warn', msg: 'web.events.overflow', fields: { backlog: 5, clients: 2 } },
    ]);
    // 被断开的那个：读得到已经写出去的几个事件，之后流结束（面板据此重连）
    let rest = '';
    const decoder = new TextDecoder();
    for (let next = await stalled.reader.read(); !next.done; next = await stalled.reader.read()) {
      rest += decoder.decode(next.value, { stream: true });
    }
    expect(parse(rest)[0]?.event).toBe('hello');
    expect(parse(rest).length).toBeLessThan(31);
    // 之后的事件不再发给它，也不再记日志
    events.broadcast('status', statusAt(99));
    expect(entries.filter((entry) => entry.msg === 'web.events.overflow')).toHaveLength(1);
  });

  it('HEAD 只给响应头：不登记连接、不起心跳，退出不用等', async () => {
    const { head, events, entries } = setup({ heartbeat: 10 });

    for (let i = 0; i < 3; i++) {
      const response = await head();
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/event-stream');
      expect(response.headers.get('cache-control')).toBe('no-cache');
      expect(response.headers.get('x-accel-buffering')).toBe('no');
      expect(response.body).toBeNull();
    }
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(events.size).toBe(0);
    expect(entries.filter((entry) => entry.msg.startsWith('web.events.'))).toEqual([]);
    const startedAt = Date.now();
    await events.close(500);
    expect(Date.now() - startedAt).toBeLessThan(100);
  });
});
