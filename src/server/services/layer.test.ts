import { unlinkSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequester } from '../../net/index.js';
import {
  closeAll,
  ok,
  onClose,
  onlyLoopback,
  router,
  serve,
  type Handler,
  type TestServer,
} from '../../net/test-server.js';
import type { ServiceDefinition } from '../../plugin-api.js';
import type { Env } from '../../shared/config.js';
import { openFeedsDb, type FeedsDb } from '../feeds-db.js';
import { installServices } from './install.js';
import { createServiceLayer, ServiceError } from './layer.js';
import { fakeDocs, fakeService, recording, tempDir } from './test-services.js';

afterEach(closeAll);

/** 假的时间：测试里改 clock.now；每个测试从 2026-11-16 10:00（本地时间）开始 */
const clock = { now: new Date(2026, 10, 16, 10, 0) };
beforeEach(() => {
  clock.now = new Date(2026, 10, 16, 10, 0);
});

/** 一个刚刚还能连、现在没有人听的本机端口 */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/**
 * 装上这些服务，建服务层：请求器只放行 127.0.0.1，feeds.db 默认在内存里，时间取 clock.now。
 * 返回服务层、feeds.db 和记下的日志
 */
function layerFor(
  definitions: ServiceDefinition[],
  { env = {}, feeds, timeoutMs }: { env?: Env; feeds?: FeedsDb; timeoutMs?: number } = {},
) {
  const { logger, entries } = recording();
  const installed = installServices(definitions, env, { logger, report: () => {} });
  if (!installed.ok) throw new Error(installed.error);
  const db = feeds ?? openFeedsDb(':memory:');
  const requester = createRequester({ isBlocked: onlyLoopback });
  onClose(async () => {
    await requester.close();
    if (!feeds) db.close();
  });
  entries.length = 0;
  const layer = createServiceLayer({
    services: installed.services,
    feeds: db,
    requester,
    logger,
    now: () => clock.now,
    timeoutMs,
  });
  return { layer, feeds: db, entries };
}

/** 回 200 和 JSON：{ path }（收到的路径与查询串） */
const echoPath: Handler = (request, response) => {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ path: request.url }));
};

/** 起一个本地服务当外部服务，返回服务和以它为地址的假服务声明 */
async function local(handler: Handler, overrides: Partial<ServiceDefinition> = {}) {
  const server = await serve(handler);
  return { server, service: fakeService({ baseUrl: server.origin, ...overrides }) };
}

async function failure(promise: Promise<unknown>): Promise<ServiceError> {
  const error = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(error).toBeInstanceOf(ServiceError);
  return error as ServiceError;
}

const pathOf = (server: TestServer, index = 0) => new URL(server.requests[index]!.path, 'http://x');

describe('调一个接口', () => {
  it('路径参数、查询参数拼对了，地址可以带路径前缀；正文原样返回', async () => {
    const server = await serve(echoPath);
    const { layer } = layerFor([fakeService({ baseUrl: `${server.origin}/v1/` })]);

    const result = await layer.call('demo', 'item', { id: 42, lang: 'zh', q: '天 气' });

    expect(result.status).toBe(200);
    expect(result.mimeType).toBe('application/json');
    const url = pathOf(server);
    expect(url.pathname).toBe('/v1/items/42');
    expect([...url.searchParams]).toEqual([
      ['lang', 'zh'],
      ['q', '天 气'],
    ]);
    expect(JSON.parse(result.body)).toEqual({ path: server.requests[0]!.path });

    await layer.call('demo', 'search', { q: true });
    expect(server.requests[1]!.path).toBe('/v1/search?q=true');
    await layer.call('demo', 'search');
    expect(server.requests[2]!.path).toBe('/v1/search');
  });

  it('路径参数里有 /、?、..、空格、中文时整个值编码进一段，不改变路径的层次', async () => {
    const { server, service } = await local(echoPath);
    const { layer } = layerFor([service]);
    const values = ['a/b', 'x?y=1#z', '../../admin', '..%2F', 'a b', '上海', '...', 'a.b'];

    for (const value of values) await layer.call('demo', 'item', { id: value });

    expect(server.requests.map((_, index) => pathOf(server, index).pathname.split('/'))).toEqual(
      values.map((value) => ['', 'items', encodeURIComponent(value)]),
    );
    for (const [index, value] of values.entries()) {
      expect(decodeURIComponent(pathOf(server, index).pathname.split('/')[2]!)).toBe(value);
      expect(pathOf(server, index).search).toBe('');
    }
  });

  it('路径参数是空的、. 或 .. 时拒绝，不发请求', async () => {
    const { server, service } = await local(echoPath);
    const { layer } = layerFor([service]);
    for (const value of ['', '.', '..']) {
      const error = await failure(layer.call('demo', 'item', { id: value }));
      expect(error.kind).toBe('params');
      expect(error.message).toBe('路径参数 id 不能为空，也不能是 . 或 ..');
    }
    expect(server.requests).toHaveLength(0);
  });

  it('没有的服务、没有的接口、没声明的参数、缺路径参数、值的类型不对：拒绝，没有请求发出去，也不算次数', async () => {
    const { server, service } = await local(echoPath);
    const { layer, feeds } = layerFor([service]);
    const hint = '接口 item 可用的参数：id（路径参数，必填）、lang、q';
    const cases: Array<[string, string, unknown, string, string]> = [
      ['nope', 'item', { id: 1 }, 'unknown', '服务不存在：nope（可用的服务：demo）'],
      ['demo', 'nope', { id: 1 }, 'unknown', '服务 demo 没有接口 nope（可用的接口：item、search）'],
      ['demo', 'item', { id: 1, page: 2 }, 'params', `不支持参数 page。${hint}`],
      ['demo', 'item', { lang: 'zh' }, 'params', `缺少路径参数 id。${hint}`],
      ['demo', 'item', {}, 'params', `缺少路径参数 id。${hint}`],
      ['demo', 'item', { id: null }, 'params', '参数 id 的值只能是字符串、数字或布尔值'],
      ['demo', 'item', { id: { a: 1 } }, 'params', '参数 id 的值只能是字符串、数字或布尔值'],
      ['demo', 'item', { id: [1] }, 'params', '参数 id 的值只能是字符串、数字或布尔值'],
      ['demo', 'item', { id: Number.NaN }, 'params', '参数 id 的值只能是字符串、数字或布尔值'],
      ['demo', 'item', { id: Infinity }, 'params', '参数 id 的值只能是字符串、数字或布尔值'],
      ['demo', 'item', [1], 'params', `参数须为对象。${hint}`],
      ['demo', 'item', 'id=1', 'params', `参数须为对象。${hint}`],
    ];
    for (const [name, endpoint, params, kind, message] of cases) {
      const error = await failure(layer.call(name, endpoint, params));
      expect([error.kind, error.message]).toEqual([kind, message]);
    }
    expect(server.requests).toHaveLength(0);
    expect(feeds.requestsOn('demo', '2026-11-16')).toBe(0);
  });

  it('参数的值最多 2000 个字符：超了按参数不对拒绝，不发请求，也不算次数', async () => {
    const { server, service } = await local(echoPath);
    const { layer, feeds } = layerFor([service]);

    // 正好 2000 个字符的照常发出（太长的路径本地服务收不下，这里放在查询参数里）
    await layer.call('demo', 'item', { id: 'x', q: 'a'.repeat(2000) });
    expect(server.requests).toHaveLength(1);

    for (const params of [{ id: '字'.repeat(2001) }, { id: 1, q: 'a'.repeat(2001) }]) {
      const error = await failure(layer.call('demo', 'item', params));
      expect([error.kind, error.message]).toEqual([
        'params',
        `参数 ${Object.keys(params).at(-1)} 过长（最多 2000 个字符）`,
      ]);
    }
    expect(server.requests).toHaveLength(1);
    expect(feeds.requestsOn('demo', '2026-11-16')).toBe(1);
  });

  it('只发 GET，要 JSON，User-Agent 固定一个', async () => {
    const methods: string[] = [];
    const { server, service } = await local((request, response) => {
      methods.push(request.method ?? '');
      ok('{}')(request, response);
    });
    const { layer } = layerFor([service]);
    await layer.call('demo', 'search', { q: 'x' });
    expect(methods).toEqual(['GET']);
    expect(server.requests[0]!.headers.accept).toBe('application/json, */*;q=0.8');
    expect(server.requests[0]!.headers['user-agent']).toBe(
      'Mozilla/5.0 (compatible; LuoLiBot/1.0)',
    );
  });
});

describe('只检查、不发请求', () => {
  it('服务、接口、参数的检查和 call 的一样；通过时什么都不做，不发请求，也不算次数', async () => {
    const { server, service } = await local(echoPath);
    const { layer, feeds, entries } = layerFor([service]);

    expect(() => layer.check('demo', 'item', { id: '7', q: 'x' })).not.toThrow();
    expect(() => layer.check('demo', 'search')).not.toThrow();
    for (const [args, kind, message] of [
      [['nope', 'item', {}], 'unknown', '服务不存在：nope（可用的服务：demo）'],
      [['demo', 'nope', {}], 'unknown', '服务 demo 没有接口 nope（可用的接口：item、search）'],
      [['demo', 'search', { x: 1 }], 'params', '不支持参数 x。接口 search 可用的参数：q'],
      [
        ['demo', 'item', {}],
        'params',
        '缺少路径参数 id。接口 item 可用的参数：id（路径参数，必填）、lang、q',
      ],
      [['demo', 'item', { id: '..' }], 'params', '路径参数 id 不能为空，也不能是 . 或 ..'],
      [['demo', 'search', []], 'params', '参数须为对象。接口 search 可用的参数：q'],
    ] as const) {
      let caught: unknown;
      try {
        layer.check(...(args as unknown as [string, string, unknown]));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ServiceError);
      expect([(caught as ServiceError).kind, (caught as ServiceError).message]).toEqual([
        kind,
        message,
      ]);
      // call 的说明一样
      const viaCall = await failure(layer.call(...(args as unknown as [string, string, unknown])));
      expect(viaCall.message).toBe(message);
    }
    expect(server.requests).toEqual([]);
    expect(feeds.requestsOn('demo', '2026-11-16')).toBe(0);
    // 日志只有那几次 call 的：检查不记日志
    expect(entries.map((entry) => entry.msg)).toEqual(Array(6).fill('service.call'));
  });
});

describe('正文里的数字', () => {
  it('JSON 规整、排版时数字照原文：超过安全整数的编号、1.10 都不走样', async () => {
    const { service } = await local(
      ok('{"alerts":[{"id":202611161600008896177761,"level":1.10,"n":9007199254740993}]}', {
        'content-type': 'application/json',
      }),
    );
    const { layer } = layerFor([service]);

    const { body } = await layer.call('demo', 'search');

    expect(body).toContain('"id": 202611161600008896177761');
    expect(body).toContain('"level": 1.10');
    expect(body).toContain('"n": 9007199254740993');
  });
});

describe('认证', () => {
  it('写在声明里的：环境变量的值加前缀放进请求头', async () => {
    const { server, service } = await local(ok('{}'), {
      env: ['LUOLI_TEST_KEY'],
      auth: { type: 'header', header: 'X-Api-Key', env: 'LUOLI_TEST_KEY', prefix: 'Key ' },
    });
    const { layer } = layerFor([service], { env: { LUOLI_TEST_KEY: 'key-value-123' } });
    await layer.call('demo', 'search');
    expect(server.requests[0]!.headers['x-api-key']).toBe('Key key-value-123');
  });

  it('自己写的：装配时拿到环境变量，每次请求前拿到服务层给的时间，返回的请求头贴上去', async () => {
    const seen: Array<{ env: Record<string, string>; now: Date }> = [];
    const { server, service } = await local(ok('{}'), {
      env: ['LUOLI_TEST_ID'],
      auth: {
        type: 'custom',
        setup: (env) => {
          return ({ now }) => {
            seen.push({ env: { ...env }, now });
            return { Authorization: `Bearer signed-at-${now.toISOString()}` };
          };
        },
      },
    });
    const { layer } = layerFor([service], { env: { LUOLI_TEST_ID: 'id-0001' } });
    clock.now = new Date('2026-11-16T02:00:00Z');
    await layer.call('demo', 'search');
    clock.now = new Date('2026-11-16T02:05:00Z');
    await layer.call('demo', 'search');

    expect(server.requests.map((request) => request.headers.authorization)).toEqual([
      'Bearer signed-at-2026-11-16T02:00:00.000Z',
      'Bearer signed-at-2026-11-16T02:05:00.000Z',
    ]);
    expect(seen.map(({ env }) => env)).toEqual([
      { LUOLI_TEST_ID: 'id-0001' },
      { LUOLI_TEST_ID: 'id-0001' },
    ]);
  });

  it('服务回 302 指向另一个服务时不跟随：另一个服务一个请求都没收到，按出错处理', async () => {
    const other = await serve(ok('别处'));
    const { server, service } = await local(
      (_request, response) => {
        response.writeHead(302, { location: `${other.origin}/steal` });
        response.end();
      },
      {
        env: ['LUOLI_TEST_KEY'],
        auth: { type: 'header', header: 'X-Api-Key', env: 'LUOLI_TEST_KEY' },
      },
    );
    const { layer } = layerFor([service], { env: { LUOLI_TEST_KEY: 'key-value-123' } });

    const error = await failure(layer.call('demo', 'search'));

    expect([error.kind, error.status]).toEqual(['status', 302]);
    expect(error.message).toBe('服务 demo 返回 HTTP 302（要求跳转，未跟随）');
    expect(server.requests).toHaveLength(1);
    expect(other.requests).toHaveLength(0);
    expect(other.sockets).toHaveLength(0);
  });

  it('认证的函数出错时不发请求', async () => {
    const { server, service } = await local(ok('{}'), {
      auth: {
        type: 'custom',
        setup: () => () => {
          throw new Error('签不出来');
        },
      },
    });
    const { layer } = layerFor([service]);
    const error = await failure(layer.call('demo', 'search'));
    expect([error.kind, error.message]).toEqual(['auth', '服务 demo 认证出错，请求未发出']);
    expect(server.requests).toHaveLength(0);
  });
});

describe('响应', () => {
  it('gzip 压缩的响应能读', async () => {
    const { service } = await local((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
      response.end(gzipSync(JSON.stringify({ text: '晴' })));
    });
    const { layer } = layerFor([service]);
    expect(JSON.parse((await layer.call('demo', 'search')).body)).toEqual({ text: '晴' });
  });

  it('2xx 以外的状态是带状态码和原因（正文的前 500 个字符）的错误', async () => {
    const reason = JSON.stringify({ error: { status: 400, title: 'Invalid Parameters' } });
    const { service } = await local(
      router({
        '/items/bad': (_request, response) => {
          response.writeHead(400, { 'content-type': 'application/json' });
          response.end(reason);
        },
        '/items/long': (_request, response) => {
          response.writeHead(500);
          response.end('长'.repeat(800));
        },
        '/items/empty': (_request, response) => {
          response.writeHead(503);
          response.end();
        },
      }),
    );
    const { layer } = layerFor([service]);

    const bad = await failure(layer.call('demo', 'item', { id: 'bad' }));
    expect([bad.kind, bad.status, bad.message]).toEqual([
      'status',
      400,
      `服务 demo 返回 HTTP 400：${reason}`,
    ]);
    const long = await failure(layer.call('demo', 'item', { id: 'long' }));
    expect(long.message).toBe(`服务 demo 返回 HTTP 500：${'长'.repeat(500)}`);
    const empty = await failure(layer.call('demo', 'item', { id: 'empty' }));
    expect(empty.message).toBe('服务 demo 返回 HTTP 503');
  });

  it('超时、被中止、网络错误各是各的类别', async () => {
    let received!: () => void;
    const arrived = new Promise<void>((resolve) => (received = resolve));
    const { service } = await local(() => {
      received();
      // 不回应
    });
    const { layer } = layerFor([service], { timeoutMs: 200 });

    const timeout = await failure(layer.call('demo', 'search'));
    expect([timeout.kind, timeout.message]).toEqual(['timeout', '服务 demo 超过 0.2 秒未响应']);

    const controller = new AbortController();
    const pending = layer.call('demo', 'search', {}, { signal: controller.signal });
    await arrived;
    controller.abort();
    const aborted = await failure(pending);
    expect([aborted.kind, aborted.message]).toEqual(['aborted', '对服务 demo 的调用已中止']);

    const { layer: unreachable } = layerFor([
      fakeService({ name: 'gone', baseUrl: `http://127.0.0.1:${await closedPort()}` }),
    ]);
    const network = await failure(unreachable.call('gone', 'search'));
    expect(network.kind).toBe('network');
    expect(network.message).toMatch(/^服务 gone 请求出错：/);
  });

  it('响应正文、错误说明里出现凭据（环境变量的值、贴上去的请求头、算出来的主机名）时抹成 ***', async () => {
    const echo: Handler = (request, response) => {
      const text = `收到 ${request.headers['x-api-key']} 与 ${request.headers.authorization} 来自 ${request.headers.host} key-value-123`;
      const status = request.url?.startsWith('/items/fail') ? 401 : 200;
      response.writeHead(status, { 'content-type': 'text/plain' });
      response.end(text);
    };
    const server = await serve(echo);
    const { layer } = layerFor(
      [
        fakeService({
          env: ['LUOLI_TEST_KEY', 'LUOLI_TEST_PORT'],
          // 地址由环境变量算出来：主机名也算凭据
          baseUrl: (env) => `http://127.0.0.1:${env.LUOLI_TEST_PORT}`,
          auth: { type: 'header', header: 'X-Api-Key', env: 'LUOLI_TEST_KEY' },
        }),
        fakeService({
          name: 'signed',
          baseUrl: server.origin,
          auth: {
            type: 'custom',
            setup: () => () => ({ Authorization: 'Bearer abcdefghijkl.mnop' }),
          },
        }),
      ],
      { env: { LUOLI_TEST_KEY: 'key-value-123', LUOLI_TEST_PORT: String(server.port) } },
    );

    const body = (await layer.call('demo', 'search')).body;
    expect(body).toBe('收到 *** 与 undefined 来自 *** ***');
    const error = await failure(layer.call('demo', 'item', { id: 'fail' }));
    expect(error.message).toBe('服务 demo 返回 HTTP 401：收到 *** 与 undefined 来自 *** ***');

    const signed = (await layer.call('signed', 'search')).body;
    expect(signed).not.toContain('abcdefghijkl');
    expect(signed).toContain('与 *** 来自');
  });
});

describe('抹凭据：先规整 JSON，再抹', () => {
  // 带 / 和 + 的凭据：PHP 的 json_encode 默认把 / 写成 \/
  const secret = 'tok/en+Secret=ABC123xyz';
  const slashed = secret.replaceAll('/', '\\/');
  const unicode = [...secret]
    .map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
    .join('');
  const upper = unicode.toUpperCase().replaceAll('\\U', '\\u');

  /** 本地服务把 json 原样写进正文（手写的 JSON，凭据用各种转义写法），/items/fail 回 400 */
  async function echoing(json: string, contentType = 'application/json') {
    const { service } = await local(
      (request, response) => {
        response.writeHead(request.url?.startsWith('/items/fail') ? 400 : 200, {
          'content-type': contentType,
        });
        response.end(json);
      },
      {
        env: ['LUOLI_TEST_TOKEN'],
        auth: {
          type: 'header',
          header: 'Authorization',
          env: 'LUOLI_TEST_TOKEN',
          prefix: 'Bearer ',
        },
      },
    );
    return layerFor([service], { env: { LUOLI_TEST_TOKEN: secret } }).layer;
  }

  it('成功的正文：凭据写成 \\/、\\uXXXX（大小写、混着写）时，规整以后照样抹掉；JSON 用 2 个空格排版', async () => {
    const mixed = `${unicode.slice(0, 18)}${secret.slice(3).replaceAll('/', '\\/')}`;
    const json = `{"auth":"Bearer ${slashed}","u":"${unicode}","U":"${upper}","mixed":"${mixed}","ok":"晴\\/多云"}`;
    const layer = await echoing(json);

    const { body } = await layer.call('demo', 'search');

    expect(body).toBe(
      // 整个请求头的值（含 Bearer）也是凭据，整段抹掉
      JSON.stringify({ auth: '***', u: '***', U: '***', mixed: '***', ok: '晴/多云' }, null, 2),
    );
    expect(body).not.toContain('Secret');
  });

  it('错误说明里的原因：同样先规整、再抹、再截短', async () => {
    const layer = await echoing(`{"error":"bad token ${slashed}","echo":"${unicode}"}`);

    const error = await failure(layer.call('demo', 'item', { id: 'fail' }));

    expect(error.message).toBe('服务 demo 返回 HTTP 400：{"error":"bad token ***","echo":"***"}');
  });

  it('不是 JSON 的正文（如截断了的 JSON、网页里嵌的 JSON）：各种转义写法也认得出', async () => {
    const text = `<script>var a = "${slashed}"; var b = "${unicode}"; var c = "${upper}"; var d = "${secret}"</script>`;
    const layer = await echoing(text, 'text/html');

    const { body } = await layer.call('demo', 'search');
    expect(body).toBe(
      '<script>var a = "***"; var b = "***"; var c = "***"; var d = "***"</script>',
    );

    const error = await failure(layer.call('demo', 'item', { id: 'fail' }));
    expect(error.message).toBe(`服务 demo 返回 HTTP 400：${body}`);
  });

  it('短于 6 个字符的不抹，环境变量的值、请求头的值、请求头里切开的各段都按这一条；Bearer 这样的认证方式不算凭据', async () => {
    const echo: Handler = (request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end(
        `short=${request.headers['x-short']} keyed=${request.headers['x-keyed']} bearer=${request.headers.authorization} 正文 ab12 Bearer 之后 abc12x`,
      );
    };
    const server = await serve(echo);
    const { layer } = layerFor(
      [
        fakeService({
          name: 'short',
          baseUrl: server.origin,
          env: ['LUOLI_TEST_SHORT'],
          auth: { type: 'header', header: 'X-Short', env: 'LUOLI_TEST_SHORT' },
        }),
        fakeService({
          name: 'keyed',
          baseUrl: server.origin,
          env: ['LUOLI_TEST_KEYED'],
          auth: { type: 'header', header: 'X-Keyed', env: 'LUOLI_TEST_KEYED', prefix: 'Key ' },
        }),
        fakeService({
          name: 'bearer',
          baseUrl: server.origin,
          auth: { type: 'custom', setup: () => () => ({ Authorization: 'Bearer abc12x' }) },
        }),
      ],
      { env: { LUOLI_TEST_SHORT: 'ab12', LUOLI_TEST_KEYED: 'ab12x' } },
    );

    // 4 个字符的值不抹；正文里的 ab12 也就留着
    expect((await layer.call('short', 'search')).body).toBe(
      'short=ab12 keyed=undefined bearer=undefined 正文 ab12 Bearer 之后 abc12x',
    );
    // 请求头的值「Key ab12x」整个抹；单独出现的 ab12x（5 个字符）不抹
    expect((await layer.call('keyed', 'search')).body).toBe(
      'short=undefined keyed=*** bearer=undefined 正文 ab12 Bearer 之后 abc12x',
    );
    // 「Bearer abc12x」整个抹，abc12x（6 个字符）单独出现也抹；Bearer 这个词不抹
    expect((await layer.call('bearer', 'search')).body).toBe(
      'short=undefined keyed=undefined bearer=*** 正文 ab12 Bearer 之后 ***',
    );
  });
});

describe('每天的上限', () => {
  it('到了上限就不发，错误的类别是 quota；不管结果，发出去的都算；过了 0 点重新算', async () => {
    const { server, service } = await local(
      router({
        '/search': ok('{}'),
        '/items/x': (_q, response) => (response.writeHead(500), response.end()),
      }),
      { limits: { minIntervalSeconds: 60, maxRequestsPerDay: 3 } },
    );
    const { layer, feeds } = layerFor([service]);
    clock.now = new Date(2026, 10, 16, 23, 59);

    await layer.call('demo', 'search');
    await failure(layer.call('demo', 'item', { id: 'x' }));
    await layer.call('demo', 'search');
    const quota = await failure(layer.call('demo', 'search'));

    expect([quota.kind, quota.message]).toEqual([
      'quota',
      '今日额度已用完（服务 demo 每天最多 3 次请求），请明天再试',
    ]);
    expect(server.requests).toHaveLength(3);
    expect(feeds.requestsOn('demo', '2026-11-16')).toBe(3);

    clock.now = new Date(2026, 10, 17, 0, 1);
    await layer.call('demo', 'search');
    expect(server.requests).toHaveLength(4);
    expect(feeds.requestsOn('demo', '2026-11-17')).toBe(1);
  });

  it('计数存在 feeds.db 里：关掉再打开，计数还在；两个服务各算各的', async () => {
    const path = join(tempDir(), 'feeds.db');
    const server = await serve(ok('{}'));
    const services = () => [
      fakeService({
        baseUrl: server.origin,
        limits: { minIntervalSeconds: 60, maxRequestsPerDay: 2 },
      }),
      fakeService({ name: 'other', baseUrl: server.origin }),
    ];
    clock.now = new Date(2026, 10, 16, 12, 0);

    const first = openFeedsDb(path);
    const { layer } = layerFor(services(), { feeds: first });
    await layer.call('demo', 'search');
    await layer.call('demo', 'search');
    first.close();

    const second = openFeedsDb(path);
    onClose(async () => second.close());
    const { layer: again } = layerFor(services(), { feeds: second });
    expect((await failure(again.call('demo', 'search'))).kind).toBe('quota');
    await again.call('other', 'search');
    expect(second.requestsOn('demo', '2026-11-16')).toBe(2);
    expect(second.requestsOn('other', '2026-11-16')).toBe(1);
  });
});

describe('日志', () => {
  it('每次调用一条 service.call：服务名、接口、状态码或错误的类别、耗时、正文长度、今天第几次；不记参数、地址、正文', async () => {
    const { service } = await local(ok('{"a":"正文的内容"}'));
    const { layer, entries } = layerFor([service]);
    clock.now = new Date(2026, 10, 16, 8, 0);

    await layer.call('demo', 'item', { id: 'secret-param', q: '查询的词' });
    await failure(layer.call('demo', 'item', { bad: 1 }));
    await failure(layer.call('模型编的服务名', 'item'));
    await failure(layer.call('demo', '模型编的接口'));

    expect(entries.map(({ level, msg }) => [level, msg])).toEqual([
      ['info', 'service.call'],
      ['info', 'service.call'],
      ['info', 'service.call'],
      ['info', 'service.call'],
    ]);
    const [done, rejected, noService, noEndpoint] = entries.map(({ fields }) => fields);
    expect(done).toEqual({
      service: 'demo',
      endpoint: 'item',
      status: 200,
      bodyLength: 13,
      durationMs: expect.any(Number),
      requestsToday: 1,
    });
    expect(rejected).toEqual({
      service: 'demo',
      endpoint: 'item',
      error: 'params',
      durationMs: expect.any(Number),
      requestsToday: 1,
    });
    // 认不出的服务名、接口不记原文
    expect(noService).toEqual({
      error: 'unknown',
      durationMs: expect.any(Number),
      requestsToday: undefined,
    });
    expect(noEndpoint).toEqual({
      service: 'demo',
      error: 'unknown',
      durationMs: expect.any(Number),
      requestsToday: 1,
    });
    const text = JSON.stringify(entries);
    for (const word of ['secret-param', '查询的词', '正文的内容', '127.0.0.1', '模型编的']) {
      expect(text).not.toContain(word);
    }
  });
});

describe('读文档', () => {
  it('总说明、某一节；每次都重新读文件', async () => {
    const docs = fakeDocs('demo', ['item', 'search']);
    const { layer } = layerFor([fakeService({ docs })]);

    expect(await layer.readDoc('demo')).toBe('# demo 的总说明\n\n这是假的文档。\n');
    expect(await layer.readDoc('demo', 'item')).toBe('# demo 的 item 一节\n');

    writeFileSync(join(fileURLToPath(docs), 'item.md'), '改过的一节\n');
    expect(await layer.readDoc('demo', 'item')).toBe('改过的一节\n');
  });

  it('不存在的服务、节：unknown，列出有哪些；运行中文件读不到：docs', async () => {
    const docs = fakeDocs('demo', ['item', 'search']);
    const { layer } = layerFor([fakeService({ docs })]);

    const service = await failure(layer.readDoc('nope'));
    expect([service.kind, service.message]).toEqual([
      'unknown',
      '服务不存在：nope（可用的服务：demo）',
    ]);
    const section = await failure(layer.readDoc('demo', 'nope'));
    expect([section.kind, section.message]).toEqual([
      'unknown',
      '服务 demo 的文档没有此章节：nope（可用的章节：item、search）',
    ]);

    unlinkSync(join(fileURLToPath(docs), 'search.md'));
    const missing = await failure(layer.readDoc('demo', 'search'));
    expect([missing.kind, missing.message]).toEqual([
      'docs',
      '服务 demo 的文档读取失败：search.md',
    ]);
  });

  it('装上的服务列在 services 里：名字、名称、简介、接口（id、名称、路径参数、查询参数）、最短间隔、每天的上限', () => {
    const { layer } = layerFor([fakeService()]);
    expect(layer.services).toEqual([
      {
        name: 'demo',
        title: '示例服务',
        summary: '测试用的假服务',
        endpoints: [
          { id: 'item', title: '条目', pathParams: ['id'], query: ['lang', 'q'] },
          { id: 'search', title: '搜索', pathParams: [], query: ['q'] },
        ],
        minIntervalSeconds: 60,
        maxRequestsPerDay: 100,
      },
    ]);
  });
});
