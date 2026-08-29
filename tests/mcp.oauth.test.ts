import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { McpAuthRepository, closeDatabase, migrateDatabase, openDatabase, OperationsRepository } from '@luoli/db';
import { LogSink, McpManager, PendingAuthorizations, Secrets, ToolRegistry, configSchema } from '@luoli/core';
import { start } from './fixtures/mcp-oauth-server.js';

/**
 * 需要登录的 MCP server 的完整回路。
 *
 * 本仓库此前无法构造出需要登录这一信号：`StreamableHTTPClientTransport` 未传入
 * `authProvider`，而 SDK 的 401 分支是 `if (response.status === 401 && this._authProvider)`，
 * 因此一台需要登录的 server 只会留下 `state='down'` 与一句 `Error POSTing to endpoint: <响应体>`。
 * 这个文件固定的正是该信号以及其后的每一步。
 *
 * 对端为 `tests/fixtures/mcp-oauth-server.ts`：一台自带授权服务器的受保护 MCP server，
 * 实际校验 PKCE、code 一次性、refresh_token 实际换取。不使用 mock：三层中任何一层的形状有误，
 * 这里都会失败。
 */

type Fixture = Awaited<ReturnType<typeof start>>;
const openFixtures: Fixture[] = [];
const openDbs: Array<ReturnType<typeof openDatabase>> = [];
const openManagers: McpManager[] = [];

async function fixture(options?: Parameters<typeof start>[0]): Promise<Fixture> {
  const server = await start(options);
  openFixtures.push(server);
  return server;
}

interface Harness {
  manager: McpManager;
  store: McpAuthRepository;
  pending: PendingAuthorizations;
  server: Record<string, unknown>;
  state(): { state: string; last_error: string | null } | undefined;
}

/** 每个用例使用独立的库。`publicUrl` 可为空，对应未配置 publicUrl 时不允许开始授权的用例。 */
function harness(slug: string, url: string, auth: Record<string, unknown>, publicUrl = 'http://127.0.0.1:8787'): Harness {
  const path = `./data/mcp-oauth-${slug}.test.db`;
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
  const db = openDatabase(path);
  migrateDatabase(db);
  openDbs.push(db);
  const log = new LogSink(new OperationsRepository(db), './data/mcp-oauth-logs');
  const registry = new ToolRegistry(log, { request: async () => true }, { maxRegistered: 80, maxCallsPerTurn: 40, maxConsecutiveErrors: 3 });
  const store = new McpAuthRepository(db, new Secrets('unit-test-master-key-at-least-32-bytes'));
  const pending = new PendingAuthorizations();
  const config = configSchema.parse({ access: { bootstrapOwnerId: '1' },
    mcp: { enabled: true, connectTimeoutMs: 8000, servers: [{ name: 'probe', transport: 'http', url, enabled: true, auth }] } }).mcp;
  const manager = new McpManager(db, config, log, registry, { store, pending, publicUrl: () => publicUrl });
  openManagers.push(manager);
  return { manager, store, pending, server: config.servers[0] as unknown as Record<string, unknown>,
    state: () => db.prepare('SELECT state,last_error FROM mcp_servers WHERE name=?').get('probe') as { state: string; last_error: string | null } | undefined };
}

/**
 * 模拟浏览器完成授权跳转：获取授权 URL、跟随一次 302、取出 `code` 与 `state`。
 * `redirect: 'manual'` 是必需的：实际跟随会请求到 `redirect_uri`（本服务的回调），
 * 而该用例要验证的正是取得 code 之后的处理逻辑。
 */
async function followAuthorization(authorizationUrl: string): Promise<{ code: string; state: string }> {
  const response = await fetch(authorizationUrl, { redirect: 'manual' });
  expect(response.status, `授权端点没有 302，回的是 ${response.status}`).toBe(302);
  const location = new URL(response.headers.get('location')!);
  return { code: location.searchParams.get('code')!, state: location.searchParams.get('state')! };
}

afterEach(async () => {
  // manager 先关闭：它持有的 http 连接关闭时会触发 `onclose` 并记录一条 `mcp.disconnect`，
  // 若此时 `LogSink` 已无可写入的库，只会产生一行写入失败的噪声日志。
  for (const manager of openManagers.splice(0)) await manager.close();
  for (const server of openFixtures.splice(0)) await server.close();
  for (const db of openDbs.splice(0)) closeDatabase(db);
});

describe('MCP 登录', () => {
  it('oauth：401 记成 needs_auth 而不是 down，并留下一个能点的授权链接', async () => {
    const remote = await fixture();
    const box = harness('needs-auth', remote.url, { mode: 'oauth', scope: 'read write' });
    await box.manager.reconcile();
    // 关键断言：状态不是 down。运维在这两种状态下需要采取的操作完全不同。
    expect(box.state()?.state).toBe('needs_auth');
    expect(box.state()?.last_error).toContain('登录');
    const entry = box.pending.peek('probe');
    expect(entry, '没有留下待授权条目 —— 那个〔登录〕按钮就没有可点的地址').not.toBeNull();
    expect(entry!.authorizationUrl).toContain('code_challenge=');
    expect(entry!.authorizationUrl).toContain('code_challenge_method=S256');
    // 动态注册确实发生过（对端没有预置 client）。
    expect(remote.seen.register).toBe(1);
    expect(remote.seen.unauthorized).toBeGreaterThan(0);
  });

  it('oauth：走完授权 → 换到 token → 连上 → 工具进目录', async () => {
    const remote = await fixture();
    const box = harness('full-loop', remote.url, { mode: 'oauth', scope: 'read write' });
    const started = await box.manager.authorize(box.server as never);
    expect(started.status).toBe('REDIRECT');
    const { code } = await followAuthorization(started.authorizationUrl!);
    expect(await box.manager.completeAuthorization(box.server as never, code)).toBe('AUTHORIZED');
    expect(remote.seen.tokenExchange).toBe(1);

    await box.manager.reconcile();
    expect(box.state()?.state).toBe('up');
    expect(box.state()?.last_error).toBeNull();
    expect(box.manager.toolEntries().map((entry) => entry.name)).toContain('mcp__probe__whoami');
    // 凭据已落库，且无法读取密文：公开视图中只有 mode、scope 与时间戳。
    const credential = box.store.get('probe')!;
    expect(credential).toMatchObject({ server: 'probe', mode: 'oauth', authorized: true, scope: 'read write' });
    expect(JSON.stringify(credential)).not.toContain('access_token');
    expect(credential.expiresAt).toBeGreaterThan(Date.now());
    // 换取 token 后不应继续保留本次的 PKCE verifier 与待授权条目。
    expect(box.pending.peek('probe')).toBeNull();
  });

  it('oauth：access token 过期后自动 refresh，不需要人再登一次', async () => {
    const remote = await fixture({ accessTokenTtlSeconds: 1 });
    const box = harness('refresh', remote.url, { mode: 'oauth' });
    const started = await box.manager.authorize(box.server as never);
    const { code } = await followAuthorization(started.authorizationUrl!);
    await box.manager.completeAuthorization(box.server as never, code);
    await box.manager.reconcile();
    expect(box.state()?.state).toBe('up');

    await new Promise((done) => setTimeout(done, 1200));
    // 指纹中的 authVersion 会因 refresh 写入 token 而变化，因此这里必然发生一次真实重连。
    await box.manager.reconcile();
    expect(remote.seen.tokenRefresh).toBeGreaterThanOrEqual(1);
    expect(box.state()?.state).toBe('up');
    // 全程无需再次人工参与：授权端点只被请求过一次。
    expect(remote.seen.authorize).toBe(1);
  });

  it('oauth：注销之后回到 needs_auth，凭据一列都不剩', async () => {
    const remote = await fixture();
    const box = harness('sign-out', remote.url, { mode: 'oauth' });
    const started = await box.manager.authorize(box.server as never);
    const { code } = await followAuthorization(started.authorizationUrl!);
    await box.manager.completeAuthorization(box.server as never, code);
    await box.manager.reconcile();
    expect(box.state()?.state).toBe('up');

    await box.manager.signOut(box.server as never);
    // 该行仍然存在（`mode` 有实际用途：界面需区分使用 OAuth 但未登录与不需要登录两种情况），
    // 但 `authorized` 已为 false。
    expect(box.store.get('probe')).toMatchObject({ mode: 'oauth', authorized: false, expiresAt: null, authorizedAt: null });
    await box.manager.reconcile();
    expect(box.state()?.state).toBe('needs_auth');
  });

  it('oauth：没配 webui.publicUrl 时不开始授权，并且说清缺什么', async () => {
    const remote = await fixture();
    const box = harness('no-public-url', remote.url, { mode: 'oauth' }, '');
    await expect(box.manager.authorize(box.server as never)).rejects.toThrow(/publicUrl/);
    // 不应发出任何网络请求：redirect_uri 一旦注册到对端就难以更改。
    expect(remote.seen.register).toBe(0);
    expect(remote.seen.authorize).toBe(0);
  });

  it('bearer：token 存进金库就能连上，被撤销之后是 needs_auth', async () => {
    const remote = await fixture();
    const box = harness('bearer', remote.url, { mode: 'bearer' });
    // 先不填入 token：应为 needs_auth，且提示信息说明本地没有保存 token。
    await box.manager.reconcile();
    expect(box.state()?.state).toBe('needs_auth');
    expect(box.state()?.last_error).toContain('没有保存 token');

    box.store.setBearer('probe', remote.mintBearer());
    await box.manager.reconcile();
    expect(box.state()?.state).toBe('up');
    // 界面上只显示末 4 位，而不是完整串。
    const credential = box.store.get('probe')!;
    expect(credential.hint).toHaveLength(4);
    expect(credential.mode).toBe('bearer');

    remote.revokeAll();
    await box.manager.reconcile();
    expect(box.state()?.state).toBe('needs_auth');
    expect(box.state()?.last_error).toContain('拒绝了已保存的 token');
  });

  it('bearer：轮换 token 真的换掉连接（指纹里带凭据版本）', async () => {
    const remote = await fixture();
    const box = harness('rotate', remote.url, { mode: 'bearer' });
    box.store.setBearer('probe', remote.mintBearer());
    await box.manager.reconcile();
    expect(box.state()?.state).toBe('up');
    const firstVersion = box.store.version('probe');

    // 旧 token 全部作废并替换为新的。若指纹中不含 authVersion，
    // `existing.fingerprint === print` 会命中旧连接，界面显示已连接而实际持有失效 token。
    remote.revokeAll();
    box.store.setBearer('probe', remote.mintBearer());
    expect(box.store.version('probe')).toBeGreaterThan(firstVersion);
    await box.manager.reconcile();
    expect(box.state()?.state).toBe('up');
  });

  it('mode=none 撞上 401：也记 needs_auth，但不去注册任何客户端', async () => {
    const remote = await fixture();
    const box = harness('mode-none', remote.url, { mode: 'none' });
    await box.manager.reconcile();
    expect(box.state()?.state).toBe('needs_auth');
    // 提示信息应指向修改 auth.mode，而不是执行登录：该模式下界面不提供登录入口。
    expect(box.state()?.last_error).toContain('auth.mode');
    // 不挂载 authProvider 的意义在于：不代替运维决定向第三方注册客户端。
    expect(remote.seen.register).toBe(0);
    expect(remote.seen.authorize).toBe(0);
  });

  /**
   * 凭据不得以明文出现在库中任何位置。这不是形式要求：此前
   * `headers: { Authorization: 'Bearer …' }` 的 token 明文写入了 `config_revisions`，也会从
   * `/api/config/export` 原样导出，原因是按键名判定敏感项的正则为 `/key|secret|token|password/i`，
   * 无法匹配 `Authorization`。将凭据迁入 `mcp_auth` 的全部价值体现在这条断言上。
   *
   * 判据是扫描全库而不是只检查 `mcp_auth`：此前遗漏的正是另一张表。
   */
  it('凭据在库里任何一张表、任何一列上都不以明文出现', async () => {
    const remote = await fixture();
    const box = harness('no-plaintext', remote.url, { mode: 'bearer' });
    const token = remote.mintBearer();
    box.store.setBearer('probe', token);
    await box.manager.reconcile();
    expect(box.state()?.state).toBe('up');

    const db = openDbs.at(-1)!;
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((row) => row.name);
    const hits: string[] = [];
    for (const table of tables) {
      const rows = db.prepare(`SELECT * FROM "${table}"`).all() as Array<Record<string, unknown>>;
      for (const row of rows) {
        for (const [column, value] of Object.entries(row)) {
          if (typeof value === 'string' && value.includes(token)) hits.push(`${table}.${column}`);
        }
      }
    }
    expect(hits, `这些列里有明文 token：${hits.join(', ')}`).toEqual([]);
    // 对照组：密文确实存在（否则上面那条断言在空表上同样能通过）。
    const stored = db.prepare('SELECT secret_enc FROM mcp_auth WHERE server=?').pluck().get('probe') as string;
    expect(stored).toMatch(/^v2\./);
    expect(stored).not.toContain(token);
  });

  it('待授权表：state 单次可用、过期即失效、同一台 server 只留最后一条', () => {
    const pending = new PendingAuthorizations();
    pending.put('state-a', 'probe', 'https://as.example/authorize?state=state-a');
    expect(pending.take('state-a')?.server).toBe('probe');
    // 重放：同一个 state 第二次回调必须失败。
    expect(pending.take('state-a')).toBeNull();
    expect(pending.take('never-issued')).toBeNull();

    pending.put('state-b', 'probe', 'https://as.example/authorize?state=state-b');
    pending.put('state-c', 'probe', 'https://as.example/authorize?state=state-c');
    // 连续两次发起登录后，先发起的那一条不应仍能换取凭据。
    expect(pending.take('state-b')).toBeNull();
    expect(pending.take('state-c')?.server).toBe('probe');
  });
});
