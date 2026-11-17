import { silentLogger } from '../../core/index.js';
import { createRequester } from '../../net/index.js';
import { onClose, onlyLoopback, serve, type Handler } from '../../net/test-server.js';
import type { ServiceDefinition } from '../../plugin-api.js';
import { openFeedsDb } from '../feeds-db.js';
import { installServices } from '../services/install.js';
import { createServiceLayer } from '../services/layer.js';
import { fakeService } from '../services/test-services.js';

// 监听的测试用的东西：真的服务层（请求器只放行 127.0.0.1，feeds.db 在内存里），本地 HTTP 服务当假的
// 外部服务。都在 closeAll（src/net/test-server.ts）时关掉

/** 装上这些服务，建服务层 */
export function layerFor(definitions: ServiceDefinition[]) {
  const installed = installServices(definitions, {}, { logger: silentLogger, report: () => {} });
  if (!installed.ok) throw new Error(installed.error);
  const feeds = openFeedsDb(':memory:');
  const requester = createRequester({ isBlocked: onlyLoopback });
  onClose(async () => {
    await requester.close();
    feeds.close();
  });
  const layer = createServiceLayer({
    services: installed.services,
    feeds,
    requester,
    logger: silentLogger,
  });
  return { layer, feeds };
}

/**
 * 起一个本地服务，所有路径都回 200 和 body（手写的 JSON 原文，或者每次现算）；返回服务层和收到的请求。
 * 服务就是 fakeService 那个 demo（接口 item、search，最短间隔 60 秒），overrides 覆盖它的声明
 */
export async function serving(
  body: string | (() => string),
  {
    contentType = 'application/json',
    overrides = {},
  }: { contentType?: string; overrides?: Partial<ServiceDefinition> } = {},
) {
  const handler: Handler = (_request, response) => {
    response.writeHead(200, { 'content-type': contentType });
    response.end(typeof body === 'string' ? body : body());
  };
  return servingWith(handler, overrides);
}

/** 同 serving，由 handler 决定怎么回 */
export async function servingWith(handler: Handler, overrides: Partial<ServiceDefinition> = {}) {
  const server = await serve(handler);
  const { layer, feeds } = layerFor([fakeService({ baseUrl: server.origin, ...overrides })]);
  return { layer, feeds, server };
}
