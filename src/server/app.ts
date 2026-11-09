import { Hono, type MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { FileStore, Logger } from '../core/index.js';
import { accessControl } from './access.js';
import { apiRoutes, chatRoutes } from './api.js';
import type { Chats } from './chat.js';
import type { Events } from './events.js';
import { webPages } from './pages.js';
import type { ErrorResponse, ServiceStatus } from './types.js';
import { uploadRoutes } from './upload.js';
import type { Views } from './views.js';

/**
 * 洛璃服务对外的 HTTP 接口（Hono）。按顺序：每个请求记一行日志；访问控制；接口；网页面板。
 * - GET /api/health：服务此刻的状态（JSON）；
 * - GET /api/events：SSE，见 events.ts；
 * - 会话、消息、已读、今日概况、文件：见 api.ts；
 * - 对话（发消息、重试、中止）：见 api.ts 的 chatRoutes；上传图片：见 upload.ts；
 * - /api/ 下其余的路径：404 与 JSON；
 * - 其余 GET：网页面板的静态文件，不认识的路径回退到 index.html。
 */
export function createApp({
  port,
  dist,
  events,
  views,
  status,
  logger,
  chats,
  fileStore,
  chatHeartbeat,
}: {
  /** 监听的端口：访问控制按它核对 Host 与 Origin */
  port: number;
  /** 构建好的网页面板所在的目录 */
  dist: string;
  events: Events;
  /** 会话、消息等数据 */
  views: Views;
  status: () => ServiceStatus;
  logger: Logger;
  /** 网页会话的对话；不给时没有对话接口（只测别的接口时） */
  chats?: Chats;
  /** 上传的图片存在这里；不给时没有上传接口 */
  fileStore?: FileStore;
  /** 对话的流里心跳的间隔（毫秒），默认 25 秒（测试里改短） */
  chatHeartbeat?: number;
}) {
  const app = new Hono();
  app.use(requestLog(logger));
  app.use(accessControl({ port, logger }));

  app.get('/api/health', (c) => c.json(status()));
  app.get('/api/events', (c) => events.handle(c));
  app.route('/api', apiRoutes({ views, events }));
  if (chats) app.route('/api', chatRoutes({ chats, heartbeat: chatHeartbeat }));
  if (fileStore) app.route('/api', uploadRoutes({ fileStore, logger }));
  app.all('/api', (c) => c.json({ error: '没有这个接口' }, 404));
  app.all('/api/*', (c) => c.json({ error: '没有这个接口' }, 404));

  app.get('*', webPages(dist));

  app.notFound((c) => c.json({ error: '没有这个地址' }, 404));
  app.onError((error, c) => {
    // 请求本身不对（如请求体不是合法的 JSON）：照它的状态码返回，不算服务出错
    if (error instanceof HTTPException) {
      const message = /json/i.test(error.message)
        ? '请求参数不对：请求体不是合法的 JSON'
        : `请求不对（${error.status}）`;
      return c.json<ErrorResponse>({ error: message }, error.status);
    }
    logger.error(
      { method: c.req.method, path: c.req.path, error: `${error.name}: ${error.message}` },
      'web.error',
    );
    return c.json<ErrorResponse>({ error: '服务内部出错' }, 500);
  });
  return app;
}

/**
 * 每个请求记一行 web.request：方法、路径（不含查询参数）、状态码、耗时（毫秒，到响应头发出为止；
 * SSE 是连上的那一刻）。不记请求体与响应体
 */
function requestLog(logger: Logger): MiddlewareHandler {
  return async (c, next) => {
    const started = performance.now();
    await next();
    logger.info(
      {
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        ms: Math.round(performance.now() - started),
      },
      'web.request',
    );
  };
}
