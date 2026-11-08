import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import type { Hono } from 'hono';

/** 只监听本机：第六阶段不做登录 */
export const hostname = '127.0.0.1';

export type Listener = {
  /** 不再接受新连接；已有的连接（如 SSE）照常 */
  stopListening(): void;
  /** 断开所有连接（含开着的 SSE），等服务器关闭 */
  close(): Promise<void>;
};

/**
 * 在 127.0.0.1 的端口上跑 Hono 应用，开始监听后兑现。端口被占用等监听失败时抛错，
 * 消息可以直接给用户看。不替换全局的 Request、Response（同一进程里还有模型请求与 Telegram）
 */
export async function listen(app: Hono, port: number): Promise<Listener> {
  const server = serve({
    fetch: app.fetch,
    port,
    hostname,
    overrideGlobalObjects: false,
  }) as Server;
  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off('listening', onListening);
      reject(new Error(listenError(error, port), { cause: error }));
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
  });

  let closed: Promise<void> | undefined;
  const stopListening = () =>
    (closed ??= new Promise<void>((resolve) => {
      server.close(() => resolve());
    }));
  return {
    stopListening: () => void stopListening(),
    async close() {
      const done = stopListening();
      // 只调 close() 时，开着的 SSE 连接会让它一直等下去
      server.closeAllConnections();
      await done;
    },
  };
}

function listenError(error: NodeJS.ErrnoException, port: number): string {
  if (error.code === 'EADDRINUSE') {
    return `端口 ${port} 已被占用，用 LUOLI_WEB_PORT 换一个端口`;
  }
  if (error.code === 'EACCES') {
    return `没有权限监听端口 ${port}，用 LUOLI_WEB_PORT 换一个端口`;
  }
  return `网页服务启动失败（${hostname}:${port}）：${error.message}`;
}
