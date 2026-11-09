import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Logger } from '../core/index.js';
import { createApp } from './app.js';
import { createEvents } from './events.js';
import type { ServiceStatus } from './types.js';
import { emptyLive, emptyViews } from './test-kit.js';

const port = 7310;
const self = `127.0.0.1:${port}`;

type LogEntry = { level: string; msg: string; fields: Record<string, unknown> };

function recordingLogger(): { logger: Logger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const record = (level: string) => (fields: object, msg: string) => {
    entries.push({ level, msg, fields: fields as Record<string, unknown> });
  };
  return {
    logger: { info: record('info'), warn: record('warn'), error: record('error') },
    entries,
  };
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 假的构建产物：临时目录下的 dist/，里面有 index.html 与一个带哈希的资源 */
function fakeDist({ built = true } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'luoli-web-'));
  dirs.push(root);
  const dist = join(root, 'dist');
  mkdirSync(dist);
  if (built) {
    mkdirSync(join(dist, 'assets'));
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>面板</title>');
    writeFileSync(join(dist, 'assets', 'index-abc123.js'), 'console.log(1)');
  }
  return dist;
}

const status: ServiceStatus = {
  startedAt: '2026-11-08T00:00:00.000Z',
  uptimeSeconds: 42,
  telegram: { enabled: true, connected: false },
  assistant: { name: '洛璃', wakeWords: ['nori'] },
  web: { author: 'Alice' },
};

function setup({ dist = fakeDist(), heartbeat }: { dist?: string; heartbeat?: number } = {}) {
  const { logger, entries } = recordingLogger();
  const events = createEvents({ hello: () => ({ ...status, live: emptyLive }), logger, heartbeat });
  const app = createApp({ port, dist, events, views: emptyViews(), status: () => status, logger });
  /** 发一个请求，默认带上本机的 Host */
  const request = (path: string, init: RequestInit = {}) =>
    app.request(path, { ...init, headers: { host: self, ...init.headers } });
  return { app, events, request, entries, dist };
}

describe('访问控制', () => {
  it('Host 是 127.0.0.1:端口 或 localhost:端口 时通过（不分大小写）', async () => {
    const { request } = setup();

    for (const host of [self, `localhost:${port}`, `LOCALHOST:${port}`]) {
      expect((await request('/api/health', { headers: { host } })).status).toBe(200);
    }
  });

  it('Host 不对返回 403：别的域名（DNS 重绑定）、别的端口、没有端口、没有 Host', async () => {
    const { app, request, entries } = setup();

    for (const host of [`evil.example:${port}`, '127.0.0.1:8080', '127.0.0.1', `[::1]:${port}`]) {
      const response = await request('/api/health', { headers: { host } });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: '拒绝访问' });
    }
    expect((await app.request('/api/health')).status).toBe(403);
    expect(entries.filter((entry) => entry.msg === 'web.rejected')).toHaveLength(5);
    expect(entries.find((entry) => entry.msg === 'web.rejected')).toEqual({
      level: 'warn',
      msg: 'web.rejected',
      fields: { method: 'GET', path: '/api/health', reason: 'host' },
    });
  });

  it('带 Origin 时必须与这次请求的地址相同，否则 403；不带 Origin 的照常', async () => {
    const { request, entries } = setup();
    const withOrigin = (origin: string, host = self) =>
      request('/api/health', { headers: { host, origin } });

    expect((await withOrigin(`http://${self}`)).status).toBe(200);
    expect((await withOrigin(`http://localhost:${port}`, `localhost:${port}`)).status).toBe(200);
    for (const origin of [
      'https://evil.example',
      'null',
      `https://${self}`,
      `http://127.0.0.1:8080`,
      `http://localhost:${port}`,
    ]) {
      expect((await withOrigin(origin)).status).toBe(403);
    }
    expect((await request('/api/health')).status).toBe(200);
    expect(entries.filter((entry) => entry.fields.reason === 'origin')).toHaveLength(5);
  });

  it('GET、HEAD 以外的请求必须是 JSON，否则 415；是 JSON 的通过（这一步还没有这类接口，到 404）', async () => {
    const { request, entries } = setup();
    const post = (contentType?: string) =>
      request('/api/anything', {
        method: 'POST',
        headers: contentType ? { 'content-type': contentType } : {},
        body: contentType?.includes('json') ? '{}' : 'a=1',
      });

    for (const contentType of [
      undefined,
      'text/plain',
      'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=x',
      'application/jsonp',
    ]) {
      const response = await post(contentType);
      expect(response.status).toBe(415);
      expect(await response.json()).toEqual({ error: '请求体必须是 JSON' });
    }
    expect((await post('application/json')).status).toBe(404);
    expect((await post('Application/JSON; charset=utf-8')).status).toBe(404);
    expect(entries.find((entry) => entry.fields.reason === 'content-type')?.fields).toEqual({
      method: 'POST',
      path: '/api/anything',
      reason: 'content-type',
    });
    // 被拒的请求不记请求体
    expect(JSON.stringify(entries)).not.toContain('a=1');
  });

  it('先查 Host 与 Origin：跨站的 JSON 请求是 403 而不是 404', async () => {
    const { request } = setup();

    const response = await request('/api/anything', {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      body: '{}',
    });

    expect(response.status).toBe(403);
  });
});

describe('接口', () => {
  it('/api/health 返回服务的状态', async () => {
    const { request } = setup();

    const response = await request('/api/health');

    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual(status);
  });

  it('/api/ 下不认识的路径返回 404 与 JSON，不回退到页面', async () => {
    const { request } = setup();

    for (const path of ['/api', '/api/', '/api/nope', '/api/nope/deeper']) {
      const response = await request(path);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: '没有这个接口' });
    }
  });

  it('每个请求记一行：方法、路径（不含查询参数）、状态码、耗时', async () => {
    const { request, entries } = setup();

    await request('/api/health?token=secret');

    const lines = entries.filter((entry) => entry.msg === 'web.request');
    expect(lines).toEqual([
      {
        level: 'info',
        msg: 'web.request',
        fields: { method: 'GET', path: '/api/health', status: 200, ms: expect.any(Number) },
      },
    ]);
    expect(JSON.stringify(entries)).not.toContain('secret');
  });
});

describe('网页面板的页面', () => {
  it('/ 与 index.html：页面本身，不缓存', async () => {
    const { request } = setup();

    for (const path of ['/', '/index.html']) {
      const response = await request(path);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/html');
      expect(response.headers.get('cache-control')).toBe('no-cache');
      expect(await response.text()).toContain('<title>面板</title>');
    }
  });

  it('带哈希的资源：长缓存', async () => {
    const { request } = setup();

    const response = await request('/assets/index-abc123.js');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('javascript');
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(await response.text()).toBe('console.log(1)');
  });

  it('HEAD 也可以', async () => {
    const { request } = setup();

    const response = await request('/assets/index-abc123.js', { method: 'HEAD' });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-length')).toBe('14');
  });

  it('不认识的路径回退到 index.html；/assets/ 下没有的返回 404', async () => {
    const { request } = setup();

    for (const path of ['/conversations/42', '/some/deep/path', '/favicon.ico']) {
      const response = await request(path);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-cache');
      expect(await response.text()).toContain('<title>面板</title>');
    }
    expect((await request('/assets/missing-000.js')).status).toBe(404);
  });

  it('读不到构建目录以外的文件', async () => {
    const { request, dist } = setup();
    writeFileSync(join(dist, '..', 'secret-luoli.txt'), '机密');

    for (const path of [
      '/../secret-luoli.txt',
      '/assets/../../secret-luoli.txt',
      '/%2e%2e/secret-luoli.txt',
      '/assets/%2e%2e/%2e%2e/secret-luoli.txt',
      '/assets/..%2f..%2fsecret-luoli.txt',
    ]) {
      expect(await (await request(path)).text()).not.toContain('机密');
    }
  });

  it('还没有构建：页面返回提示，资源 404；构建好之后不用重启就能打开', async () => {
    const dist = fakeDist({ built: false });
    const { request } = setup({ dist });

    const page = await request('/');
    expect(page.status).toBe(503);
    expect(await page.text()).toContain('网页还没有构建，先运行 pnpm web:build');
    expect((await request('/assets/index-abc123.js')).status).toBe(404);
    expect((await request('/api/health')).status).toBe(200);

    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>面板</title>');
    expect(await (await request('/')).text()).toContain('<title>面板</title>');
  });

  it('页面只回应 GET、HEAD：别的方法 404', async () => {
    const { request } = setup();

    const response = await request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(response.status).toBe(404);
  });
});
