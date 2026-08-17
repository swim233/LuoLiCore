import { lookup } from 'node:dns/promises';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guardedFetch, webFetch } from '@luoli/core';

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
