import { Hono, type MiddlewareHandler } from 'hono';
import type { Logger } from '../core/index.js';
import { accessControl } from './access.js';
import type { Events } from './events.js';
import { webPages } from './pages.js';
import type { ServiceStatus } from './types.js';

/**
 * 洛璃服务对外的 HTTP 接口（Hono）。按顺序：每个请求记一行日志；访问控制；接口；网页面板。
 * - GET /api/health：服务此刻的状态（JSON）；
 * - GET /api/events：SSE，见 events.ts；
 * - /api/ 下其余的路径：404 与 JSON；
 * - 其余 GET：网页面板的静态文件，不认识的路径回退到 index.html。
 */
export function createApp({
  port,
  dist,
  events,
  status,
  logger,
}: {
  /** 监听的端口：访问控制按它核对 Host 与 Origin */
  port: number;
  /** 构建好的网页面板所在的目录 */
  dist: string;
  events: Events;
  status: () => ServiceStatus;
  logger: Logger;
}) {
  const app = new Hono();
  app.use(requestLog(logger));
  app.use(accessControl({ port, logger }));

  app.get('/api/health', (c) => c.json(status()));
  app.get('/api/events', (c) => events.handle(c));
  app.all('/api', (c) => c.json({ error: '没有这个接口' }, 404));
  app.all('/api/*', (c) => c.json({ error: '没有这个接口' }, 404));

  app.get('*', webPages(dist));

  app.notFound((c) => c.json({ error: '没有这个地址' }, 404));
  app.onError((error, c) => {
    logger.error(
      { method: c.req.method, path: c.req.path, error: `${error.name}: ${error.message}` },
      'web.error',
    );
    return c.json({ error: '服务内部出错' }, 500);
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
