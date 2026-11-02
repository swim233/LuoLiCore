import { lookup } from 'node:dns/promises';
import type { IncomingMessage } from 'node:http';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createRequester,
  defaultUserAgents,
  FetchError,
  type Requester,
  type RequesterOptions,
} from './request.js';
import { closeAll, ok, onClose, onlyLoopback, serve, type Handler } from './test-server.js';

afterEach(closeAll);

function requester(options: RequesterOptions = {}): Requester {
  const created = createRequester({ isBlocked: onlyLoopback, ...options });
  onClose(() => created.close());
  return created;
}

async function failure(promise: Promise<unknown>): Promise<FetchError> {
  const error = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(error).toBeInstanceOf(FetchError);
  return error as FetchError;
}

const userAgentOf = (request: IncomingMessage) => request.headers['user-agent'];
const [curl, bot, chrome] = defaultUserAgents as [string, string, string];

async function elapsed<T>(run: () => Promise<T>): Promise<[T, number]> {
  const start = performance.now();
  const result = await run();
  return [result, performance.now() - start];
}

// 只有 localhost 同时解析出 ::1 与 127.0.0.1 的机器上才能测「有一个被拦就拒绝」
const localhost = (await lookup('localhost', { all: true })).map(({ address }) => address);

describe('内网地址', () => {
  it('默认判断下本机地址都被拒绝，服务端一次连接都没收到，也不轮换 User-Agent', async () => {
    const v4 = await serve(ok('秘密'));
    const v6 = await serve(ok('秘密'), '::1');
    const fetcher = createRequester();
    onClose(() => fetcher.close());
    for (const url of [
      `http://127.0.0.1:${v4.port}/`,
      `http://localhost:${v4.port}/`,
      `http://[::1]:${v6.port}/`,
      `http://[::ffff:127.0.0.1]:${v4.port}/`,
    ]) {
      const error = await failure(fetcher.get(url));
      expect(error.kind).toBe('blocked');
      expect(error.message).toBe('不能访问内网地址');
    }
    expect(v4.sockets).toHaveLength(0);
    expect(v6.sockets).toHaveLength(0);
  });

  it('跳转到被拦的地址时拒绝，目标服务没收到连接，跳转前的服务只收到一次请求', async () => {
    const target = await serve(ok('秘密'), '127.0.0.2');
    const start = await serve((_request, response) => {
      response.writeHead(302, { location: `http://127.0.0.2:${target.port}/` });
      response.end();
    });
    const error = await failure(requester().get(`${start.origin}/`));
    expect(error.kind).toBe('blocked');
    expect(error.message).toBe('不能访问内网地址');
    expect(start.requests).toHaveLength(1);
    expect(target.sockets).toHaveLength(0);
  });

  it('域名解析出的地址照常检查：放行的地址能连上', async () => {
    const server = await serve(ok('你好'));
    const fetcher = requester({
      isBlocked: (address) => address !== '127.0.0.1' && address !== '::1',
    });
    const response = await fetcher.get(`http://localhost:${server.port}/`);
    expect(response.status).toBe(200);
    expect((await response.text()).text).toBe('你好');
  });

  it.skipIf(!localhost.includes('::1') || !localhost.includes('127.0.0.1'))(
    '域名解析出多个地址时，有一个被拦就拒绝',
    async () => {
      const server = await serve(ok('你好'));
      const error = await failure(requester().get(`http://localhost:${server.port}/`));
      expect(error.kind).toBe('blocked');
      expect(server.sockets).toHaveLength(0);
    },
  );
});

describe('跳转', () => {
  // /hops/N 跳到 /hops/N-1，/hops/0 回正文；几种跳转状态码轮着用
  const chain: Handler = (request, response) => {
    const left = Number(request.url?.split('/').at(-1));
    if (left === 0) return ok('到了')(request, response);
    response.writeHead([301, 302, 303, 307, 308][left % 5]!, { location: `/hops/${left - 1}` });
    response.end();
  };

  it('跳转 2 次后拿到结果，给出最终 URL 与跳转次数', async () => {
    const server = await serve(chain);
    const response = await requester().get(`${server.origin}/hops/2`);
    expect(response.status).toBe(200);
    expect(response.url).toBe(`${server.origin}/hops/0`);
    expect(response.redirects).toBe(2);
    expect((await response.text()).text).toBe('到了');
  });

  it('最多跳 5 次，第 6 次报「跳转次数过多」', async () => {
    const server = await serve(chain);
    const fetcher = requester();
    const response = await fetcher.get(`${server.origin}/hops/5`);
    expect(response.redirects).toBe(5);
    await response.discard();

    const error = await failure(fetcher.get(`${server.origin}/hops/6`));
    expect(error.kind).toBe('redirects');
    expect(error.message).toBe('跳转次数过多');
  });

  it('跳到 http、https 以外的协议时报错', async () => {
    const server = await serve((_request, response) => {
      response.writeHead(301, { location: 'ftp://example.com/file' });
      response.end();
    });
    const error = await failure(requester().get(`${server.origin}/`));
    expect(error.kind).toBe('protocol');
    expect(server.requests).toHaveLength(1);
  });

  it('网址本身不是 http、https，或者解析不了时报错', async () => {
    const fetcher = requester();
    expect((await failure(fetcher.get('ftp://example.com/'))).kind).toBe('protocol');
    expect((await failure(fetcher.get('file:///etc/passwd'))).kind).toBe('protocol');
    expect((await failure(fetcher.get('不是网址'))).kind).toBe('invalid-url');
  });
});

describe('User-Agent 轮换', () => {
  it('前两个 User-Agent 被 403 时依次换下一个，拿到 200', async () => {
    const server = await serve((request, response) => {
      if (userAgentOf(request) === chrome) return ok('欢迎')(request, response);
      response.writeHead(403);
      response.end('不欢迎');
    });
    const response = await requester().get(`${server.origin}/`);
    expect(response.status).toBe(200);
    expect(response.userAgent).toBe(chrome);
    expect(response.rejected).toBe(false);
    expect(server.requests.map(({ headers }) => headers['user-agent'])).toEqual([
      curl,
      bot,
      chrome,
    ]);
  });

  it('429、503 同样换下一个；前几个 User-Agent 收到 429 不等待', async () => {
    const statuses = new Map([
      [curl, 429],
      [bot, 503],
    ]);
    const server = await serve((request, response) => {
      response.writeHead(statuses.get(userAgentOf(request) ?? '') ?? 200, { 'retry-after': '5' });
      response.end();
    });
    const [response, ms] = await elapsed(() => requester().get(`${server.origin}/`));
    expect(response.status).toBe(200);
    expect(response.userAgent).toBe(chrome);
    expect(ms).toBeLessThan(1000);
  });

  it('三个都被 403 时结果标明被拒', async () => {
    const server = await serve((_request, response) => {
      response.writeHead(403);
      response.end();
    });
    const response = await requester().get(`${server.origin}/`);
    expect(response.status).toBe(403);
    expect(response.rejected).toBe(true);
    expect(server.requests).toHaveLength(3);
  });

  it('第一个 User-Agent 就拿到 200 时只发一次', async () => {
    const server = await serve(ok('欢迎'));
    const response = await requester().get(`${server.origin}/`);
    expect(response.userAgent).toBe(curl);
    expect(server.requests).toHaveLength(1);
  });

  it('调用方指定 User-Agent 时只发一次，403 也不轮换', async () => {
    const server = await serve((_request, response) => {
      response.writeHead(403);
      response.end();
    });
    const response = await requester().get(`${server.origin}/`, { userAgent: 'LuoLiTest/1.0' });
    expect(response.status).toBe(403);
    expect(response.rejected).toBe(false);
    expect(server.requests.map(({ headers }) => headers['user-agent'])).toEqual(['LuoLiTest/1.0']);
  });

  it('网络错误时换下一个 User-Agent', async () => {
    const server = await serve((request, response) => {
      if (userAgentOf(request) === curl) return request.socket.destroy();
      ok('欢迎')(request, response);
    });
    const response = await requester().get(`${server.origin}/`);
    expect(response.status).toBe(200);
    expect(response.userAgent).toBe(bot);
  });

  it('三个 User-Agent 都遇到网络错误时抛错，带上原因', async () => {
    const server = await serve((request) => request.socket.destroy());
    const error = await failure(requester().get(`${server.origin}/`));
    expect(error.kind).toBe('network');
    expect(error.message).toMatch(/^网络错误：/);
    expect(error.cause).toBeInstanceOf(Error);
    expect(server.requests).toHaveLength(3);
  });

  it('非 2xx 不抛错，作为结果返回状态码与响应头', async () => {
    const server = await serve((_request, response) => {
      response.writeHead(404, { 'content-type': 'text/plain', 'x-reason': 'gone' });
      response.end('没有');
    });
    const response = await requester().get(`${server.origin}/`);
    expect(response.status).toBe(404);
    expect(response.rejected).toBe(false);
    expect(response.headers.get('x-reason')).toBe('gone');
    expect(response.mimeType).toBe('text/plain');
    expect((await response.text()).text).toBe('没有');
  });
});

describe('429', () => {
  // 前两个 User-Agent 回 403；最后一个第一次回 429（带 retryAfter），之后回 then
  function lastAgent429(retryAfter: string | undefined, then = 200) {
    let chromeRequests = 0;
    return serve((request, response) => {
      if (userAgentOf(request) !== chrome) {
        response.writeHead(403);
        return response.end();
      }
      chromeRequests++;
      const headers = retryAfter === undefined ? {} : { 'retry-after': retryAfter };
      response.writeHead(chromeRequests === 1 ? 429 : then, chromeRequests === 1 ? headers : {});
      response.end();
    });
  }

  it('最后一个 User-Agent 收到 429 时按 Retry-After 等 1 秒，用同一个重发成功', async () => {
    const server = await lastAgent429('1');
    const [response, ms] = await elapsed(() => requester().get(`${server.origin}/`));
    expect(response.status).toBe(200);
    expect(response.rejected).toBe(false);
    expect(ms).toBeGreaterThanOrEqual(950);
    expect(ms).toBeLessThan(3000);
    expect(server.requests.map(({ headers }) => headers['user-agent'])).toEqual([
      curl,
      bot,
      chrome,
      chrome,
    ]);
  });

  it('没给 Retry-After 时等 1 秒', async () => {
    const server = await lastAgent429(undefined);
    const [response, ms] = await elapsed(() => requester().get(`${server.origin}/`));
    expect(response.status).toBe(200);
    expect(ms).toBeGreaterThanOrEqual(950);
    expect(ms).toBeLessThan(3000);
  });

  it('Retry-After 是已过去的 HTTP 日期时不等', async () => {
    const server = await lastAgent429(new Date(Date.now() - 60_000).toUTCString());
    const [response, ms] = await elapsed(() => requester().get(`${server.origin}/`));
    expect(response.status).toBe(200);
    expect(ms).toBeLessThan(500);
  });

  it('Retry-After 超过上限时只等上限那么久', async () => {
    const server = await lastAgent429('60');
    const [response, ms] = await elapsed(() =>
      requester({ maxRetryWaitMs: 300 }).get(`${server.origin}/`),
    );
    expect(response.status).toBe(200);
    expect(ms).toBeGreaterThanOrEqual(280);
    expect(ms).toBeLessThan(2000);
  });

  it('重发后仍是 429 时结果标明被拒', async () => {
    const server = await lastAgent429('0', 429);
    const response = await requester().get(`${server.origin}/`);
    expect(response.status).toBe(429);
    expect(response.rejected).toBe(true);
    expect(server.requests).toHaveLength(4);
  });

  it('等待期间中止时立即结束', async () => {
    const server = await lastAgent429('5');
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const [error, ms] = await elapsed(() =>
      failure(requester().get(`${server.origin}/`, { signal: controller.signal })),
    );
    expect(error.kind).toBe('aborted');
    expect(ms).toBeLessThan(1000);
    expect(server.requests).toHaveLength(3);
  });

  it('等待期间时限到了也立即结束', async () => {
    const server = await lastAgent429('5');
    const [error, ms] = await elapsed(() =>
      failure(requester().get(`${server.origin}/`, { timeoutMs: 300 })),
    );
    expect(error.kind).toBe('timeout');
    expect(ms).toBeLessThan(1500);
  });
});

describe('正文', () => {
  const megabytes = (n: number) => Buffer.alloc(n * 1024 * 1024, 'a');

  it('默认最多读 5 MB，超出时停下并标明截短', async () => {
    const server = await serve(ok(megabytes(6)));
    const response = await requester().get(`${server.origin}/`);
    const { bytes, truncated } = await response.bytes();
    expect(bytes.length).toBe(5 * 1024 * 1024);
    expect(truncated).toBe(true);
  });

  it('调用方可以改上限', async () => {
    const server = await serve(ok(megabytes(6)));
    const fetcher = requester();
    const small = await (await fetcher.get(`${server.origin}/`)).text({ maxBytes: 1024 });
    expect(small.text).toBe('a'.repeat(1024));
    expect(small.truncated).toBe(true);
    const large = await (
      await fetcher.get(`${server.origin}/`)
    ).bytes({ maxBytes: 8 * 1024 * 1024 });
    expect(large.bytes.length).toBe(6 * 1024 * 1024);
    expect(large.truncated).toBe(false);
  });

  it('正好等于上限时不算截短', async () => {
    const server = await serve(ok('a'.repeat(1024)));
    const { bytes, truncated } = await (
      await requester().get(`${server.origin}/`)
    ).bytes({
      maxBytes: 1024,
    });
    expect(bytes.length).toBe(1024);
    expect(truncated).toBe(false);
  });

  it('不读正文时连接回到池里，下一个请求复用它', async () => {
    // 100 KB：比缓冲区大，不读完连接就一直占着；又不超过丢弃时读掉的上限
    const body = 'a'.repeat(100 * 1024);
    const server = await serve(ok(body));
    const fetcher = requester();
    await (await fetcher.get(`${server.origin}/a`)).discard();
    // undici 在下一轮事件循环才把连接标记为空闲；没释放的连接一直占着，下一个请求只能新开
    await new Promise((resolve) => setImmediate(resolve));
    const response = await fetcher.get(`${server.origin}/b`);
    expect((await response.text()).text).toBe(body);
    expect(server.requests).toHaveLength(2);
    expect(server.sockets).toHaveLength(1);
  });

  it('不读的正文很长时断开连接，请求器照常发下一个请求', async () => {
    const server = await serve(ok(megabytes(6)));
    const fetcher = requester();
    await (await fetcher.get(`${server.origin}/a`)).discard();
    const [first] = server.sockets;
    await new Promise((resolve) => (first!.closed ? resolve(null) : first!.once('close', resolve)));
    const response = await fetcher.get(`${server.origin}/b`);
    expect(response.status).toBe(200);
    await response.discard();
  });

  it('正文只能处理一次', async () => {
    const server = await serve(ok('一次'));
    const response = await requester().get(`${server.origin}/`);
    await response.text();
    await expect(response.text()).rejects.toThrow('正文只能处理一次');
  });
});

describe('字符集', () => {
  // GBK 的「中文」
  const gbkChinese = [0xd6, 0xd0, 0xce, 0xc4];
  const bytes = (...parts: Array<string | number[]>) =>
    Buffer.concat(
      parts.map((part) => (typeof part === 'string' ? Buffer.from(part) : Buffer.from(part))),
    );

  async function decode(body: Buffer, contentType?: string, maxBytes?: number) {
    const server = await serve(
      ok(body, contentType === undefined ? {} : { 'content-type': contentType }),
    );
    const response = await requester().get(`${server.origin}/`);
    return response.text({ maxBytes });
  }

  it.each([
    [
      'Content-Type 带 charset=gbk',
      bytes('<p>', gbkChinese, '</p>'),
      'text/html; charset=gbk',
      '<p>中文</p>',
      'gbk',
    ],
    [
      '只在 <meta charset> 里',
      bytes('<meta charset="gb2312"><p>', gbkChinese, '</p>'),
      'text/html',
      '<meta charset="gb2312"><p>中文</p>',
      'gbk',
    ],
    [
      '只在 http-equiv 里',
      bytes('<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=GBK"><p>', gbkChinese),
      'text/html',
      '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=GBK"><p>中文',
      'gbk',
    ],
    [
      '没写类型时也找 <meta>',
      bytes('<meta charset=gbk>', gbkChinese),
      undefined,
      '<meta charset=gbk>中文',
      'gbk',
    ],
    ['都没有时用 UTF-8', bytes('<p>中文</p>'), 'text/html', '<p>中文</p>', 'utf-8'],
    ['带 BOM 时去掉 BOM', bytes([0xef, 0xbb, 0xbf], '中文'), 'text/plain', '中文', 'utf-8'],
    [
      'BOM 优先于声明的字符集',
      bytes([0xef, 0xbb, 0xbf], '中文'),
      'text/plain; charset=gbk',
      '中文',
      'utf-8',
    ],
    [
      '不认识的编码名退回 UTF-8',
      bytes('中文'),
      'text/html; charset=no-such-charset',
      '中文',
      'utf-8',
    ],
    ['Big5', bytes([0xa4, 0xa4, 0xa4, 0xe5]), 'text/plain; charset=big5', '中文', 'big5'],
    [
      'Shift_JIS',
      bytes([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea]),
      'text/plain; charset="Shift_JIS"',
      '日本語',
      'shift_jis',
    ],
  ])('%s', async (_name, body, contentType, text, charset) => {
    expect(await decode(body, contentType, undefined)).toEqual({ text, truncated: false, charset });
  });

  it('不是 HTML 时不看 <meta>', async () => {
    const { charset } = await decode(bytes('<meta charset="gbk">', gbkChinese), 'text/plain');
    expect(charset).toBe('utf-8');
  });

  it('截短处在半个字符中间时丢掉这半个，不出乱码', async () => {
    expect(await decode(bytes('中文'), 'text/plain', 4)).toEqual({
      text: '中',
      truncated: true,
      charset: 'utf-8',
    });
  });
});

describe('压缩', () => {
  const text = '压缩过的正文'.repeat(100);

  it.each([
    ['gzip', gzipSync],
    ['br', brotliCompressSync],
    ['deflate', deflateSync],
  ])('%s 的响应解压后读出', async (encoding, compress) => {
    const server = await serve(
      ok(compress(Buffer.from(text)), {
        'content-encoding': encoding,
        'content-type': 'text/plain',
      }),
    );
    const response = await requester().get(`${server.origin}/`);
    expect((await response.text()).text).toBe(text);
    expect(server.requests[0]!.headers['accept-encoding']).toBe('gzip, deflate, br');
  });

  it('上限按解压后的字节算', async () => {
    const server = await serve(
      ok(gzipSync(Buffer.alloc(6 * 1024 * 1024)), { 'content-encoding': 'gzip' }),
    );
    const { bytes, truncated } = await (await requester().get(`${server.origin}/`)).bytes();
    expect(bytes.length).toBe(5 * 1024 * 1024);
    expect(truncated).toBe(true);
  });
});

describe('时限与中止', () => {
  // 收到请求后一直不回
  const silent: Handler = () => {};

  it('单次时限到了中止请求，不换 User-Agent', async () => {
    const server = await serve(silent);
    const [error, ms] = await elapsed(() =>
      failure(requester().get(`${server.origin}/`, { timeoutMs: 200 })),
    );
    expect(error.kind).toBe('timeout');
    expect(error.message).toBe('请求超时（0.2 秒）');
    expect(ms).toBeLessThan(1500);
    expect(server.requests).toHaveLength(1);
  });

  it('外部信号中止请求', async () => {
    const server = await serve(silent);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const error = await failure(
      requester().get(`${server.origin}/`, { signal: controller.signal }),
    );
    expect(error.kind).toBe('aborted');
    expect(server.requests).toHaveLength(1);
  });

  it('信号已经中止时不发请求', async () => {
    const server = await serve(ok('不该收到'));
    const error = await failure(
      requester().get(`${server.origin}/`, { signal: AbortSignal.abort() }),
    );
    expect(error.kind).toBe('aborted');
    expect(server.requests).toHaveLength(0);
  });

  // 先回响应头和一点正文，之后不再发
  const stalled: Handler = (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.write('开头');
  };

  it('时限也管读正文', async () => {
    const server = await serve(stalled);
    const response = await requester().get(`${server.origin}/`, { timeoutMs: 300 });
    const [error, ms] = await elapsed(() => failure(response.text()));
    expect(error.kind).toBe('timeout');
    expect(ms).toBeLessThan(1500);
  });

  it('读正文时外部信号中止', async () => {
    const server = await serve(stalled);
    const controller = new AbortController();
    const response = await requester().get(`${server.origin}/`, { signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    const error = await failure(response.bytes());
    expect(error.kind).toBe('aborted');
  });
});

describe('请求头', () => {
  it('默认发出 Accept、Accept-Language、Accept-Encoding', async () => {
    const server = await serve(ok(''));
    await (await requester().get(`${server.origin}/`)).discard();
    expect(server.requests[0]!.headers).toMatchObject({
      accept: 'text/markdown, text/html;q=0.9, application/xhtml+xml;q=0.9, */*;q=0.8',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'accept-encoding': 'gzip, deflate, br',
      'user-agent': curl,
    });
  });

  it('调用方覆盖（不分大小写）或追加的请求头照发', async () => {
    const server = await serve(ok('{}'));
    const response = await requester().get(`${server.origin}/`, {
      userAgent: 'LuoLiTest/1.0',
      headers: { Accept: 'application/json', 'ACCEPT-LANGUAGE': 'en', 'X-Test': '1' },
    });
    await response.discard();
    expect(server.requests[0]!.headers).toMatchObject({
      accept: 'application/json',
      'accept-language': 'en',
      'accept-encoding': 'gzip, deflate, br',
      'x-test': '1',
      'user-agent': 'LuoLiTest/1.0',
    });
  });
});
