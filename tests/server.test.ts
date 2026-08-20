import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ArchiveRepository, OperationsRepository, PrincipalRepository, closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { ConfigStore, ContextEngine, DatabaseApprovalBroker, EventBus, LogSink, MaintenanceService, ProviderStore, Secrets, configSchema } from '@luoli/core';
import { createServer } from '@luoli/server';
import argon2 from 'argon2';

async function appHarness(overrides: Record<string, unknown> = {}) {
  const path = './data/server.test.db';
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
  const db = openDatabase(path);
  migrateDatabase(db);
  const validHash = await argon2.hash('current-password', { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
  const config = configSchema.parse({ access: { bootstrapOwnerId: '1' }, webui: { passwordHash: validHash }, ...overrides });
  const operations = new OperationsRepository(db);
  const events = new EventBus();
  const log = new LogSink(operations, './data/server-logs');
  const archive = new ArchiveRepository(db);
  const context = new ContextEngine(db, archive);
  const approvals = new DatabaseApprovalBroker(db, config, events, log);
  const app = createServer({ config, db, operations, principals: new PrincipalRepository(db), archive, context,
    providers: new ProviderStore(db, new Secrets('x'.repeat(32))), approvals,
    maintenance: new MaintenanceService(db, path, 2, 30), events, log, configSchema: {}, startedAt: Date.now(), setup: undefined });
  return { app, db, operations };
}

describe('server security', () => {
  it('requires authentication and CSRF for writes', async () => {
    const { app, db } = await appHarness();
    expect((await app.request('/api/chats')).status).toBe(401);
    const session = new OperationsRepository(db).createSession(1);
    const cookie = `luoli_sid=${session.id}`;
    expect((await app.request('/api/principals/user:1', { method: 'PATCH', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ role: 'owner' }) })).status).toBe(403);
    expect((await app.request('/api/principals/user:1', { method: 'PATCH', headers: { cookie, 'x-csrf-token': session.csrf, 'content-type': 'application/json' }, body: JSON.stringify({ role: 'owner' }) })).status).toBe(200);
    closeDatabase(db);
  });

  it('hands the session csrf back to an authenticated same-origin caller but not across origins', async () => {
    const { app, db } = await appHarness();
    const session = new OperationsRepository(db).createSession(1);
    const me = await app.request('/api/auth/me', { headers: { cookie: `luoli_sid=${session.id}` } });
    expect((await me.json() as { data: { csrf: string; expiresAt: number } }).data).toMatchObject({ csrf: session.csrf, expiresAt: session.expiresAt });
    expect((await app.request('/api/auth/me', { headers: { cookie: `luoli_sid=${session.id}`, origin: 'https://evil.example' } })).status).toBe(403);
    expect((await app.request('/api/auth/me')).status).toBe(401);
    closeDatabase(db);
  });

  it('adds documented security headers', async () => {
    const { app, db } = await appHarness();
    const response = await app.request('/api/health');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
    // 无鉴权的 /api/health 只说存活；provider / MCP / 沙箱拓扑必须留在鉴权后（docs/20 · W-API-01）。
    const health = await response.json() as Record<string, unknown>;
    expect(health).toMatchObject({ ok: true });
    expect(Object.keys(health).sort()).toEqual(['ok', 'uptimeMs']);
    expect((await app.request('/api/health/detail')).status).toBe(401);
    closeDatabase(db);
  });

  it('rejects cross-origin browser requests', async () => {
    const { app, db } = await appHarness();
    expect((await app.request('/api/auth/login', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: JSON.stringify({ password: 'wrong' }) })).status).toBe(403);
    closeDatabase(db);
  });

  /**
   * 同一道闸的另一侧：`pnpm webui:dev` 的浏览器请求必须过得去。dev server 与 `/api` 不同源
   * （5173 vs 8787），Origin 闸比的是请求头 Origin 与**服务端自己**的 origin，而后者由 Host 算出
   * —— 于是这两个头怎么被代理改造，决定了登录是 401（到了口令校验）还是 403（连门都没进）。
   * 这里照着 `vite.config.ts` 真实的代理配置算出那两个头再打一遍：`changeOrigin` 或
   * `headers.origin` 任缺其一，两个值就对不上，`webui:dev` 的每一个 /api 请求恒定 403。
   * 上一次就是这么坏的（对象形式的代理不会自动补 `changeOrigin`），而这件事在自动化里一直没人看着。
   */
  it('accepts what the dev proxy forwards', async () => {
    const { app, db } = await appHarness();
    const { server } = (await import('../packages/webui/vite.config.js')).default as
      { server: { port: number; proxy: Record<string, { target: string; changeOrigin?: boolean; headers?: Record<string, string> }> } };
    const api = server.proxy['/api']!;
    const host = api.changeOrigin === true ? new URL(api.target).host : `localhost:${server.port}`;
    const origin = api.headers?.origin ?? `http://localhost:${server.port}`;
    const response = await app.request(`http://${host}/api/auth/login`, { method: 'POST',
      headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'wrong' }) });
    expect(response.status).toBe(401);
    closeDatabase(db);
  });

  it('rotates the active password and revokes other sessions', async () => {
    const { app, db, operations } = await appHarness();
    const current = operations.createSession(1); const other = operations.createSession(1);
    const response = await app.request('/api/auth/password', { method: 'POST', headers: { cookie: `luoli_sid=${current.id}`, 'x-csrf-token': current.csrf, 'content-type': 'application/json' }, body: JSON.stringify({ current: 'current-password', next: 'next-password-123' }) });
    expect(response.status).toBe(200);
    expect(operations.session(other.id)).toBeNull();
    expect((await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'current-password' }) })).status).toBe(401);
    expect((await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'next-password-123' }) })).status).toBe(200);
    closeDatabase(db);
  });

  // 热重载落地之后不能再认那份闭包里的口令：`/api/auth/password` 写完到 configStore 换上新值
  // 之间有个窗口，覆盖位只能覆盖这个窗口。无条件缓存 = V-AUTH-02 原样复发，只是换了个入口
  // （PUT /api/config 写 passwordHash 返回 200、落库、登录还认旧的，docs/24 · R-AUTH-01）。
  it('hands the password back to the config layer once the hot reload lands', async () => {
    const path = './data/server-passwd.test.db';
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
    const db = openDatabase(path); migrateDatabase(db);
    const hashOf = (value: string) => argon2.hash(value, { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
    const withHash = async (value: string) => configSchema.parse({ access: { bootstrapOwnerId: '1' }, webui: { passwordHash: await hashOf(value) } });
    const store = new ConfigStore(await withHash('first-password'));
    const operations = new OperationsRepository(db); const events = new EventBus(); const log = new LogSink(operations, './data/server-logs');
    const archive = new ArchiveRepository(db); const context = new ContextEngine(db, archive);
    const app = createServer({ config: store, db, operations, principals: new PrincipalRepository(db), archive, context,
      providers: new ProviderStore(db, new Secrets('x'.repeat(32))), approvals: new DatabaseApprovalBroker(db, store.snapshot(), events, log),
      maintenance: new MaintenanceService(db, path, 2, 30), events, log, configSchema: {}, startedAt: Date.now(), setup: undefined });
    const login = (password: string) => app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
    const session = operations.createSession(1);
    expect((await app.request('/api/auth/password', { method: 'POST', headers: { cookie: `luoli_sid=${session.id}`, 'x-csrf-token': session.csrf, 'content-type': 'application/json' },
      body: JSON.stringify({ current: 'first-password', next: 'second-password' }) })).status).toBe(200);
    // 窗口内：configStore 还是旧值，覆盖位顶上。
    expect((await login('second-password')).status).toBe(200);
    expect((await login('first-password')).status).toBe(401);
    // 热重载落地：覆盖位与配置一致，交回配置层。
    store.replace(await withHash('second-password'), ['webui.passwordHash']);
    expect((await login('second-password')).status).toBe(200);
    // 之后有人从别的入口（PUT /api/config）又改了一次：必须认新的那份，不能继续认覆盖位。
    store.replace(await withHash('third-password'), ['webui.passwordHash']);
    expect((await login('third-password')).status).toBe(200);
    expect((await login('second-password')).status).toBe(401);
    closeDatabase(db);
  });

  it('uses the trusted proxy hop from the right and bounds attacker-controlled buckets', async () => {
    const { app, db } = await appHarness({ webui: { passwordHash: await argon2.hash('current-password'), trustProxy: true, trustedProxyHops: 1, loginRateLimit: { attempts: 2, windowMinutes: 15 } } });
    const request = (xff: string) => app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': xff }, body: JSON.stringify({ password: 'wrong' }) });
    expect((await request('spoof-a, 198.51.100.8')).status).toBe(401);
    expect((await request('spoof-b, 198.51.100.8')).status).toBe(401);
    expect((await request('spoof-c, 198.51.100.8')).status).toBe(429);
    closeDatabase(db);
  });

  // `trustProxy=false`（默认）**这条路径此前一次都没被测过**，于是桶键取自 `X-Real-IP` 的回归
  // 活了两轮：docs/18 · N-WEB-02 修过一次，docs/27 · S-01 实测 12 次轮换头值全部 401。
  // 没有这条用例它会第三次回来。
  it('ignores client headers for the login bucket when trustProxy is off', async () => {
    const { app, db } = await appHarness({ webui: { passwordHash: await argon2.hash('current-password'), loginRateLimit: { attempts: 2, windowMinutes: 15 } } });
    const request = (ip: string) => app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-real-ip': ip, 'x-forwarded-for': ip }, body: JSON.stringify({ password: 'wrong' }) });
    expect((await request('1.1.1.1')).status).toBe(401);
    expect((await request('2.2.2.2')).status).toBe(401);
    // 第三次换了第三个头值，仍然锁：桶键是连接的远端地址（`app.request()` 无 socket → 常量 local）。
    expect((await request('3.3.3.3')).status).toBe(429);
    closeDatabase(db);
  });

  // 未登录就能推的三条端点（/api/setup、两条登录）此前无请求体上界，`ctx.req.json()` 整份进内存。
  it('rejects oversized request bodies before reading them', async () => {
    const { app, db } = await appHarness();
    const response = await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'x'.repeat(2_000_000) }) });
    expect(response.status).toBe(413);
    expect((await response.json() as { error: { code: string } }).error.code).toBe('payload_too_large');
    closeDatabase(db);
  });
});
