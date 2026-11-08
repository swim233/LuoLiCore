import type { Context } from 'hono';
import { streamSSE, type SSEStreamingApi } from 'hono/streaming';
import type { Logger } from '../core/index.js';
import type { Hello, ServerEvents } from './types.js';

/** 心跳的间隔：这么久发一次注释行，免得连接被中间环节当成空闲断掉 */
export const heartbeatMs = 25_000;

/**
 * 一个连接最多攒这么多条还没写出去的事件（含心跳），再多就断开它，让面板重连、从 hello 重新开始。
 * 逐字的片段约 50 毫秒合成一个事件，几个会话同时回复时每秒约一百个，这相当于连接卡住十来秒；
 * 平时只有零星几个事件，要卡住好几分钟才会到。操作系统的网络缓冲区满了之后才开始攒，
 * 一条事件通常几百字节，攒满也就几百 KB
 */
export const maxBacklog = 1000;

type Client = {
  stream: SSEStreamingApi;
  /** 这个连接的写入排成一串：不互相等，也不乱序 */
  queue: Promise<void>;
  /** 排上了、还没写完的写入有几个 */
  backlog: number;
  /** 攒得太多被断开了：之后的事件不再排 */
  dropped: boolean;
  /** 让处理函数返回、关掉这个连接 */
  release: () => void;
};

/**
 * SSE 的连接与广播。handle 是 GET /api/events 的处理函数：连上先发 hello，之后定时发心跳注释，
 * 断开时清理；broadcast 给所有连着的面板发一个事件；close 在退出时结束所有连接。
 * 连上的那一刻，hello 与加入广播名单在同一个同步步骤里完成：之前推过的事件都已包含在 hello 里，
 * 之后推的都排在 hello 后面，一个不缺、不重。事件在推的那一刻就转成 JSON，之后数据再变也不影响
 */
export function createEvents({
  hello,
  logger,
  heartbeat = heartbeatMs,
  backlogLimit = maxBacklog,
}: {
  /** 连上时的第一个事件：服务的状态与现场 */
  hello: () => Hello;
  logger: Logger;
  /** 心跳间隔（毫秒）；测试里调小 */
  heartbeat?: number;
  /** 一个连接最多攒几条没写出去的；测试里调小 */
  backlogLimit?: number;
}) {
  const clients = new Set<Client>();
  // 各连接的处理函数：结束（流已关闭）时兑现
  const handlers = new Set<Promise<void>>();
  let closed = false;

  /**
   * 排在这个连接已有的写入之后；写不出去（面板已断开）就算了，断开时另有清理。
   * 攒得太多时断开这个连接：中止它的流（还没写的立即失败，处理函数随之收尾），面板会自动重连
   */
  function enqueue(client: Client, write: () => Promise<unknown>): void {
    if (client.dropped) return;
    if (client.backlog >= backlogLimit) {
      client.dropped = true;
      logger.warn({ backlog: client.backlog, clients: clients.size }, 'web.events.overflow');
      client.stream.abort();
      client.release();
      return;
    }
    client.backlog++;
    client.queue = client.queue
      .then(write)
      .then(
        () => {},
        () => {},
      )
      .finally(() => {
        client.backlog--;
      });
  }

  function send(client: Client, event: keyof ServerEvents, text: string): void {
    enqueue(client, () => client.stream.writeSSE({ event, data: text }));
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
          const client: Client = {
            stream,
            queue: Promise.resolve(),
            backlog: 0,
            dropped: false,
            release,
          };
          let finish!: () => void;
          const finished = new Promise<void>((resolve) => (finish = resolve));
          handlers.add(finished);
          stream.onAbort(release);
          if (closed) release();
          clients.add(client);
          logger.info({ clients: clients.size }, 'web.events.open');
          // 与加入名单在同一个同步步骤里：见上面的说明
          send(client, 'hello', JSON.stringify(hello()));
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

    /** 给所有连着的面板发一个事件；没有面板连着时什么也不做 */
    broadcast<K extends keyof ServerEvents>(event: K, data: ServerEvents[K]): void {
      if (clients.size === 0) return;
      const text = JSON.stringify(data);
      for (const client of clients) send(client, event, text);
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
