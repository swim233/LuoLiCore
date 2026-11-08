import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Handler, MiddlewareHandler } from 'hono';

/** 构建好的网页面板（pnpm web:build 的输出），按仓库位置找，不受启动目录影响 */
export const webDist = fileURLToPath(new URL('../../dist/web/', import.meta.url));

export const notBuiltText = '网页还没有构建，先运行 pnpm web:build';

/** dist 里有没有构建好的网页 */
export function isBuilt(dist: string): boolean {
  return existsSync(join(dist, 'index.html'));
}

const notBuiltPage = `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<title>洛璃服务</title>
<p>${notBuiltText}</p>
</html>
`;

/** 带哈希的资源长缓存；index.html 等每次都要重新确认 */
const immutable = 'public, max-age=31536000, immutable';

/**
 * 网页面板的静态文件（GET、HEAD）。dist 里有的文件照给；/assets/ 下没有的返回 404；
 * 其余不认识的路径回退到 index.html，由页面自己处理。
 * 每次请求都看一眼有没有构建好，所以服务运行中跑完 pnpm web:build 就能用，不用重启；
 * 还没构建时返回一个提示页
 */
export function webPages(dist: string): Handler {
  // 在确认构建好之后才建：目录不存在时 serveStatic 会往 stderr 打一行
  let files: MiddlewareHandler | undefined;
  let index: MiddlewareHandler | undefined;
  const skip = async () => {};
  const cached = (response: Response, cacheControl: string) => {
    response.headers.set('Cache-Control', cacheControl);
    return response;
  };

  return async (c) => {
    const isAsset = c.req.path.startsWith('/assets/');
    if (!isBuilt(dist)) {
      if (isAsset) return c.notFound();
      return c.html(notBuiltPage, 503, { 'Cache-Control': 'no-store' });
    }
    files ??= serveStatic({ root: dist });
    index ??= serveStatic({ root: dist, path: 'index.html' });
    const found = await files(c, skip);
    if (found) return cached(found, isAsset ? immutable : 'no-cache');
    if (isAsset) return c.notFound();
    const page = await index(c, skip);
    return page ? cached(page, 'no-cache') : c.notFound();
  };
}
