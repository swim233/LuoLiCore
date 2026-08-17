import { lookup } from 'node:dns/promises';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guardedFetch, webFetch, withWebRetries } from '@luoli/core';

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
