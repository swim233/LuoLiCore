import type { MiddlewareHandler } from 'hono';

/**
 * 请求体的大小限制。不用 hono/body-limit：它在没有 Content-Length 时会 new Request(c.req.raw)，
 * 而 @hono/node-server 的 Request 不能这样用，分块传输的请求一律变成 500。
 * - 有 Content-Length（没有 Transfer-Encoding）：超过 maxBytes 直接拒，一个字节都不读；没超过的
 *   照常往下走，读取时 Node 按这个长度收；
 * - 没有 Content-Length（分块传输）：边读边数，超了就停止读取并拒绝；没超的读完，放进 Hono 的请求体
 *   缓存，之后的 c.req.json()、c.req.arrayBuffer() 都从缓存里取。c.req.raw 不换，请求的中止信号照旧
 */
export function limitBody(maxBytes: number, tooLarge: () => Response): MiddlewareHandler {
  return async (c, next) => {
    const body = c.req.raw.body;
    if (!body) return next();
    const length = c.req.header('content-length');
    if (length !== undefined && c.req.header('transfer-encoding') === undefined) {
      if (Number(length) > maxBytes) return tooLarge();
      return next();
    }
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (let read = await reader.read(); !read.done; read = await reader.read()) {
      size += read.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        return tooLarge();
      }
      chunks.push(read.value);
    }
    const data = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.byteLength;
    }
    // Hono 的类型把缓存写成 ArrayBuffer，实际存的是 Promise（它自己读出来的也是 Promise，
    // 别的读法从这里 .then 转换），所以照它的做法存 Promise
    (c.req.bodyCache as Record<string, Promise<ArrayBuffer>>).arrayBuffer = Promise.resolve(
      data.buffer,
    );
    return next();
  };
}
