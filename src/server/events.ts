import type { Context } from 'hono';
import { streamSSE, type SSEStreamingApi } from 'hono/streaming';
import type { Logger } from '../core/index.js';
import type { ServerEvents, ServiceStatus } from './types.js';

/** 心跳的间隔：这么久发一次注释行，免得连接被中间环节当成空闲断掉 */
export const heartbeatMs = 25_000;

type Client = {
  stream: SSEStreamingApi;
  /** 这个连接的写入排成一串：不互相等，也不乱序 */
  queue: Promise<void>;
  /** 让处理函数返回、关掉这个连接 */
  release: () => void;
};

/**
 * SSE 的连接与广播。handle 是 GET /api/events 的处理函数：连上先发 hello，之后定时发心跳注释，
 * 断开时清理；broadcast 给所有连着的面板发一个事件；close 在退出时结束所有连接
 */
export function createEvents({
  status,
  logger,
  heartbeat = heartbeatMs,
}: {
  status: () => ServiceStatus;
  logger: Logger;
  /** 心跳间隔（毫秒）；测试里调小 */
  heartbeat?: number;
}) {
  const clients = new Set<Client>();
  // 各连接的处理函数：结束（流已关闭）时兑现
  const handlers = new Set<Promise<void>>();
  let closed = false;

  /** 排在这个连接已有的写入之后；写不出去（面板已断开）就算了，断开时另有清理 */
  function enqueue(client: Client, write: () => Promise<unknown>): void {
    client.queue = client.queue.then(write).then(
      () => {},
      () => {},
    );
  }

  function send<K extends keyof ServerEvents>(
    client: Client,
    event: K,
    data: ServerEvents[K],
  ): void {
    enqueue(client, () => client.stream.writeSSE({ event, data: JSON.stringify(data) }));
  }

  return {
    handle(c: Context): Response {
      const headers = {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        // 反向代理（如 nginx）不要攒着
        'X-Accel-Buffering': 'no',
      };
      // HEAD 只给响应头。Hono 处理 HEAD 时调用这个处理函数、丢掉响应体，却不取消它：
      // 照常开流的话，这个连接永远不会断开，心跳和事件一直往它的队列里攒
      if (c.req.method === 'HEAD') return c.body(null, 200, headers);
      c.header('X-Accel-Buffering', headers['X-Accel-Buffering']);
      return streamSSE(
        c,
        async (stream) => {
          let release!: () => void;
          const gone = new Promise<void>((resolve) => (release = resolve));
          const client: Client = { stream, queue: Promise.resolve(), release };
          let finish!: () => void;
          const finished = new Promise<void>((resolve) => (finish = resolve));
          handlers.add(finished);
          stream.onAbort(release);
          if (closed) release();
          clients.add(client);
          logger.info({ clients: clients.size }, 'web.events.open');
          send(client, 'hello', status());
          const timer = setInterval(
            () => enqueue(client, () => stream.write(': ping\n\n')),
            heartbeat,
          );
          try {
            await gone;
          } finally {
            clearInterval(timer);
            clients.delete(client);
            logger.info({ clients: clients.size }, 'web.events.close');
            // 已经排上的事件写完再结束；面板已断开时写入立即失败，不会卡住
            await client.queue;
            await stream.close();
            handlers.delete(finished);
            finish();
          }
        },
        async (error) => {
          logger.error({ error: `${error.name}: ${error.message}` }, 'web.events.error');
        },
      );
    },

    /** 给所有连着的面板发一个事件 */
    broadcast<K extends keyof ServerEvents>(event: K, data: ServerEvents[K]): void {
      for (const client of clients) send(client, event, data);
    },

    /** 连着的面板有几个 */
    get size(): number {
      return clients.size;
    },

    /**
     * 退出：结束所有连接，等各自写完、正常收尾（面板那边看到流结束，不是连接被掐断），
     * 最多等 timeoutMs：不读数据的连接会一直写不完，留给调用方断开。
     * 之后新连上的收到 hello 后也立即结束
     */
    async close(timeoutMs = 1000): Promise<void> {
      closed = true;
      for (const client of clients) client.release();
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.all(handlers),
        new Promise((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        }),
      ]);
      clearTimeout(timer);
    },
  };
}

export type Events = ReturnType<typeof createEvents>;
