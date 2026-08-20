import { lookup } from 'node:dns/promises';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classifyResponse, guardedFetch, searchRequest, searchResults, webFetch, withWebRetries } from '@luoli/core';

describe('web fetch SSRF guard', () => {
  it('rejects private, reserved, tunneled, and non-HTTP ports before fetching', async () => {
    for (const url of ['http://169.254.169.254/latest/meta-data', 'http://[::ffff:127.0.0.1]/', 'http://0.0.0.0/',
      'http://198.18.0.1/', 'http://192.0.2.1/', 'http://198.51.100.1/', 'http://203.0.113.1/', 'http://[64:ff9b::7f00:1]/', 'http://[2002:7f00:1::]/']) {
      await expect(webFetch(url, 1024, new AbortController().signal)).rejects.toThrow('ssrf_blocked');
    }
    await expect(webFetch('http://127.0.0.1:8787', 1024, new AbortController().signal)).rejects.toThrow('port_blocked');
    await expect(webFetch('http://example.com:6379/', 1024, new AbortController().signal)).rejects.toThrow('port_blocked');
  });
});

// 上面那一组只走拒绝路径，于是「放行之后能不能真的取回内容」一次都没被断言过 —— DNS 钉死用的
// lookup 回调不认 `{ all: true }`，Node ≥20 的 autoSelectFamily 拿到字符串后读出 undefined，
// web_fetch 在现代 Node 上 100% 抛 `Invalid IP address: undefined`，而测试全绿。
// 必须用**主机名**（localhost）而不是 IP：net.connect 对 IP 字面量直接短路，压根不调 lookup。
describe('guarded fetch allow path', () => {
  let server: Server;
  let port = 0;
  beforeAll(async () => {
    server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/plain' }); response.end('pinned-ok'); });
    // 绑到 localhost 解析结果的**第一条**：safeTarget 钉的就是 addresses[0]，而 /etc/hosts 常把
    // ::1 排在 127.0.0.1 前面。写死 127.0.0.1 的话这条用例只是在测本机的 hosts 顺序。
    const [first] = await lookup('localhost', { all: true });
    await new Promise<void>((resolve) => server.listen(0, first!.address, resolve));
    port = (server.address() as { port: number }).port;
  });
  afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

  it('resolves a hostname, pins the address and still returns the body', async () => {
    const response = await guardedFetch(`http://localhost:${port}/`, {}, { allowPrivate: true, maxBytes: 1024 });
    expect(response.status).toBe(200);
    expect(response.body.toString('utf8')).toBe('pinned-ok');
  });
});

// http.request 默认没有任何超时。连上之后一个字节都不发的服务器（限流网关、被墙的站点、
// 半开连接）会让这个 promise 永远不 settle —— 卡住的是整轮对话，唯一兜底是 10 分钟的
// turnTimeoutMs，用户看到的就是 bot 收了消息然后再也不说话。
describe('guarded fetch deadline', () => {
  let server: Server;
  let port = 0;
  const sockets: Array<{ destroy: () => void }> = [];
  beforeAll(async () => {
    server = createServer((request) => { sockets.push(request.socket); });
    const [first] = await lookup('localhost', { all: true });
    await new Promise<void>((resolve) => server.listen(0, first!.address, resolve));
    port = (server.address() as { port: number }).port;
  });
  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('gives up on a server that accepts the connection and never answers', async () => {
    const started = Date.now();
    await expect(guardedFetch(`http://localhost:${port}/`, {}, { allowPrivate: true, maxBytes: 1024, timeoutMs: 300 })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

/**
 * `webFetch` 此前对**任何**响应都是 `body.toString('utf8')`。对 `image/png` 之类那是最多 2MB
 * 乱码，再被 `tools.maxOutputBytes`（64KB）截断塞进上下文 —— 比「取不到」更糟：整个工具输出
 * 预算烧在噪声上，而模型还以为自己读到了页面。
 *
 * 分档抽成纯函数才穷举得起来：`webFetch` 自己写死 `allowPrivate: false`，放行路径在测试里跑不到。
 */
describe('web_fetch 按 content-type 分档，二进制不许当文本倒出来', () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  it('image/* 与常见二进制走各自那一档', () => {
    expect(classifyResponse('image/png', png)).toBe('image');
    expect(classifyResponse('image/jpeg; charset=binary', png)).toBe('image');
    expect(classifyResponse('application/pdf', Buffer.from('%PDF-1.7\n'))).toBe('binary');
    expect(classifyResponse('application/octet-stream', png)).toBe('binary');
    expect(classifyResponse('application/zip', png)).toBe('binary');
  });

  it('文本类照旧当文本，`+json` / `+xml` 后缀族一起收', () => {
    expect(classifyResponse('text/plain', Buffer.from('hi'))).toBe('text');
    expect(classifyResponse('application/json', Buffer.from('{"a":1}'))).toBe('text');
    expect(classifyResponse('application/ld+json', Buffer.from('{}'))).toBe('text');
    expect(classifyResponse('application/atom+xml', Buffer.from('<feed/>'))).toBe('text');
    expect(classifyResponse('text/html; charset=utf-8', Buffer.from('<html>'))).toBe('html');
    expect(classifyResponse('application/xhtml+xml', Buffer.from('<html>'))).toBe('html');
  });

  it('content-type 一个字都没说时才去看字节 —— NUL 与替换字符是二进制的凭据', () => {
    expect(classifyResponse('', Buffer.from('<!doctype html><html>'))).toBe('html');
    expect(classifyResponse('', Buffer.from('just words'))).toBe('text');
    expect(classifyResponse('', png)).toBe('binary');
    // 没有 NUL 但满是非法 UTF-8 的字节（JPEG 尾段那种）同样不该当文本。
    expect(classifyResponse('', Buffer.from(Array.from({ length: 512 }, () => 0xff)))).toBe('binary');
    // 空响应不是二进制：一个 200 空正文该按文本档交回去，而不是「不许读」。
    expect(classifyResponse('', Buffer.alloc(0))).toBe('text');
  });

  it('content-type 撒谎时最坏也只是降到 text 档，仍然可读', () => {
    // 把 HTML 标成 text/plain 的站点不少 —— 抽取层没跑，但正文原样交出去了，不是乱码。
    expect(classifyResponse('text/plain', Buffer.from('<html><body>x</body></html>'))).toBe('text');
  });
});

describe('web tool retries', () => {
  const signal = (): AbortSignal => new AbortController().signal;
  const fast = { timeoutMs: 50, retries: 2 };

  it('retries transient failures and reports how many attempts it took', async () => {
    let calls = 0;
    const result = await withWebRetries<Record<string, unknown>>(fast, signal(), async (attempt) => {
      calls += 1;
      return calls < 3 ? { retry: 'web_http_503', afterMs: 1 } : { done: { ok: true, attempts: attempt + 1 } };
    }, (failure, attempts) => ({ ok: false, error: failure, attempts }));
    expect(result).toEqual({ ok: true, attempts: 3 });
    expect(calls).toBe(3);
  });

  // 耗尽之后必须是**结果**而不是异常：模型看得见「试了 3 次、卡在 web_timeout」才会换个 URL，
  // 而不是把同一个地址原样再调一遍（或者干脆停在那里等）。
  it('hands the model a structured failure once the retries are spent', async () => {
    let calls = 0;
    const result = await withWebRetries<Record<string, unknown>>(fast, signal(), async () => { calls += 1; return { retry: 'web_timeout', afterMs: 1 }; },
      (failure, attempts) => ({ ok: false, error: failure, attempts }));
    expect(result).toEqual({ ok: false, error: 'web_timeout', attempts: 3 });
    expect(calls).toBe(3);
  });

  it('stops immediately when the turn is cancelled mid-backoff', async () => {
    const controller = new AbortController();
    let calls = 0;
    const pending = withWebRetries<string>({ timeoutMs: 50, retries: 3 }, controller.signal, async () => { calls += 1; return { retry: 'web_http_502', afterMs: 5000 }; }, () => 'exhausted');
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort(new Error('cancelled'));
    await expect(pending).rejects.toThrow('cancelled');
    expect(calls).toBe(1);
  });

  // 站点自己答的 404 是答案，不是「这一次没打通」：重试它只是白等三倍时间。
  it('does not retry a target that refuses on policy grounds', async () => {
    await expect(webFetch('http://169.254.169.254/latest/meta-data', 1024, signal(), fast)).rejects.toThrow('ssrf_blocked');
  });
});

/**
 * 四家搜索 API 的请求形态与结果位置（docs/11 的 `tools.web.searchProvider`）。
 *
 * 断言的是不出网就能查的那四件事：打哪个地址、key 挂在哪个头上、请求体的字段名、结果数组藏在
 * 哪个键下面。加一家 provider 时错的正是它们，而错了的表现是「搜索永远 0 条」或「key 根本没送
 * 上去」—— 两者都要真打一次上游才看得见，于是它们此前一条断言都没有。
 */
describe('web search provider shapes', () => {
  it('builds each provider request with its own auth header and body', () => {
    expect(searchRequest('brave', 'k', '洛璃 是谁', 5)).toMatchObject({
      target: 'https://api.search.brave.com/res/v1/web/search?q=%E6%B4%9B%E7%92%83%20%E6%98%AF%E8%B0%81&count=5',
      method: 'GET', headers: { 'x-subscription-token': 'k' },
    });
    expect(searchRequest('brave', 'k', 'q', 5).body).toBeUndefined();
    expect(searchRequest('serper', 'k', 'q', 3)).toMatchObject({ target: 'https://google.serper.dev/search', method: 'POST', headers: { 'x-api-key': 'k' }, body: '{"q":"q","num":3}' });
    // tavily 的 key 在**请求体**里而不是头上 —— 照着别家抄成 header 的话它会一路 401。
    expect(JSON.parse(searchRequest('tavily', 'k', 'q', 3).body!)).toEqual({ api_key: 'k', query: 'q', max_results: 3 });
    expect(searchRequest('exa', 'k', 'q', 4)).toMatchObject({ target: 'https://api.exa.ai/search', method: 'POST', headers: { 'x-api-key': 'k' } });
    // exa 不带 contents 时每条只有标题和 URL；highlights 是这个实现刻意要的那一档（全文按页计费）。
    expect(JSON.parse(searchRequest('exa', 'k', 'q', 4).body!)).toEqual({ query: 'q', numResults: 4, contents: { highlights: true } });
  });

  it('reads the result array out of each provider response, and gives [] for a shape it does not know', () => {
    expect(searchResults('brave', { web: { results: [{ title: 'a' }] } })).toEqual([{ title: 'a' }]);
    expect(searchResults('serper', { organic: [{ title: 'b' }] })).toEqual([{ title: 'b' }]);
    expect(searchResults('tavily', { results: [{ title: 'c' }] })).toEqual([{ title: 'c' }]);
    expect(searchResults('exa', { requestId: 'x', results: [{ title: 'd', highlights: ['片段'] }], costDollars: { total: 0.007 } })).toEqual([{ title: 'd', highlights: ['片段'] }]);
    // 上游改了形状（或答了一份错误体）时给空数组，而不是把一个对象当成结果往上送。
    expect(searchResults('exa', { error: 'nope' })).toEqual([]);
    expect(searchResults('brave', {})).toEqual([]);
  });
});
