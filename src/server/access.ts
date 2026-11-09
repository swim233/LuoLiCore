import type { MiddlewareHandler } from 'hono';
import type { Logger } from '../core/index.js';
import { mediaTypeOfHeader, uploadTypes } from './upload.js';

/**
 * 访问控制：挡住浏览器里别的网页发往本机的请求（服务只监听 127.0.0.1，不做登录）。依次检查：
 * 1. Host 必须是 127.0.0.1:端口 或 localhost:端口，否则 403：防 DNS 重绑定（别的域名解析到本机）；
 * 2. 带 Origin 的请求，Origin 必须是 http://（这次请求的 Host），否则 403：别的网页的跨站请求；
 * 3. GET、HEAD 以外的请求必须是 Content-Type: application/json，否则 415：表单、text/plain 这类
 *    不用预检就能跨站发出的请求一律不收。唯一的例外是上传图片（POST /api/files）：请求体是图片的
 *    原始字节，Content-Type 是图片类型。图片类型同样不在浏览器「简单请求」的类型之列，别的网页
 *    跨站发这种请求要先过预检，过不去；Host、Origin 的检查照旧。
 * 被拒的请求记一条 web.rejected，只有方法、路径与原因，不记请求体
 */
export function accessControl({
  port,
  logger,
}: {
  port: number;
  logger: Logger;
}): MiddlewareHandler {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  return async (c, next) => {
    const reject = (status: 403 | 415, reason: 'host' | 'origin' | 'content-type') => {
      logger.warn({ method: c.req.method, path: c.req.path, reason }, 'web.rejected');
      return c.json({ error: status === 415 ? '请求体必须是 JSON' : '拒绝访问' }, status);
    };
    const host = c.req.header('host')?.toLowerCase();
    if (!host || !hosts.has(host)) return reject(403, 'host');
    const origin = c.req.header('origin');
    if (origin !== undefined && origin.toLowerCase() !== `http://${host}`) {
      return reject(403, 'origin');
    }
    const contentType = c.req.header('content-type');
    const upload =
      c.req.method === 'POST' &&
      c.req.path === '/api/files' &&
      uploadTypes.has(mediaTypeOfHeader(contentType) ?? '');
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && !isJson(contentType) && !upload) {
      return reject(415, 'content-type');
    }
    await next();
  };
}

/** application/json，可以带参数（如 charset） */
function isJson(contentType: string | undefined): boolean {
  return contentType?.split(';')[0]?.trim().toLowerCase() === 'application/json';
}
