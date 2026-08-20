import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { McpAuthRepository, closeDatabase, migrateDatabase, openDatabase, OperationsRepository } from '@luoli/db';
import { LogSink, McpManager, PendingAuthorizations, Secrets, ToolRegistry, configSchema } from '@luoli/core';
import { start } from './fixtures/mcp-oauth-server.js';

/**
 * 需要登录的 MCP server，整条回路。
 *
 * 本仓库此前**构造不出**「要登录」这个信号：`StreamableHTTPClientTransport` 没传
 * `authProvider`，而 SDK 那条 401 分支是 `if (response.status === 401 && this._authProvider)` ——
 * 于是一台要登录的 server 只留下 `state='down'` 加一句 `Error POSTing to endpoint: <响应体>`。
 * 这个文件焊住的就是那个信号，以及它之后的每一步。
 *
 * 对家是 `tests/fixtures/mcp-oauth-server.ts`：一台自带授权服务器的受保护 MCP server，
 * PKCE 真的验、code 一次性、refresh_token 真的换。**没有 mock** —— 三层里任何一层的形状写错，
 * 这里都会红。
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

/** 每个用例自己的库。`publicUrl` 可为空 —— 那一条正是「没配 publicUrl 就不许开始」的用例。 */
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
 * 扮演浏览器走完授权那一跳：拿授权 URL、跟一次 302、把 `code` 与 `state` 摘出来。
 * `redirect: 'manual'` 是必须的 —— 真跟过去会打到 `redirect_uri`（我们自己的回调）上，
 * 而这个用例要测的正是「拿到 code 之后我们做了什么」。
 */
async function followAuthorization(authorizationUrl: string): Promise<{ code: string; state: string }> {
  const response = await fetch(authorizationUrl, { redirect: 'manual' });
  expect(response.status, `授权端点没有 302，回的是 ${response.status}`).toBe(302);
  const location = new URL(response.headers.get('location')!);
  return { code: location.searchParams.get('code')!, state: location.searchParams.get('state')! };
}

afterEach(async () => {
  // **manager 先关**：它握着的 http 连接关掉时会走 `onclose` → 记一条 `mcp.disconnect`，
  // 而 `LogSink` 那时要是已经没有库可写，就只剩一行「写入失败」的噪音。
  for (const manager of openManagers.splice(0)) await manager.close();
  for (const server of openFixtures.splice(0)) await server.close();
  for (const db of openDbs.splice(0)) closeDatabase(db);
});

describe('MCP 登录', () => {
  it('oauth：401 记成 needs_auth 而不是 down，并留下一个能点的授权链接', async () => {
    const remote = await fixture();
    const box = harness('needs-auth', remote.url, { mode: 'oauth', scope: 'read write' });
    await box.manager.reconcile();
    // 关键的一条：**不是 down**。运维在这两种状态下要做的事完全不同。
    expect(box.state()?.state).toBe('needs_auth');
    expect(box.state()?.last_error).toContain('登录');
    const entry = box.pending.peek('probe');
    expect(entry, '没有留下待授权条目 —— 那个〔登录〕按钮就没有可点的地址').not.toBeNull();
    expect(entry!.authorizationUrl).toContain('code_challenge=');
    expect(entry!.authorizationUrl).toContain('code_challenge_method=S256');
    // 动态注册真的发生过（对家没有预置 client）。
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
    // 凭据落库了，而且**读不到密文**：公开视图里只有 mode / scope / 时间戳。
    const credential = box.store.get('probe')!;
    expect(credential).toMatchObject({ server: 'probe', mode: 'oauth', authorized: true, scope: 'read write' });
    expect(JSON.stringify(credential)).not.toContain('access_token');
    expect(credential.expiresAt).toBeGreaterThan(Date.now());
    // 换完 token 就不该再留着那一次的 PKCE verifier 与待授权条目。
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
    // 指纹里的 authVersion 会因为 refresh 写 token 而变，所以这里必然是一次真的重连。
    await box.manager.reconcile();
    expect(remote.seen.tokenRefresh).toBeGreaterThanOrEqual(1);
    expect(box.state()?.state).toBe('up');
    // 人一次都没有再参与：授权端点只被打过一次。
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
    // 那一行还在（`mode` 有用：界面要能区分「用 OAuth 但没登录」与「压根不需要登录」），
    // 但 `authorized` 已经是 false。
    expect(box.store.get('probe')).toMatchObject({ mode: 'oauth', authorized: false, expiresAt: null, authorizedAt: null });
    await box.manager.reconcile();
    expect(box.state()?.state).toBe('needs_auth');
  });

  it('oauth：没配 webui.publicUrl 时不开始授权，并且说清缺什么', async () => {
    const remote = await fixture();
    const box = harness('no-public-url', remote.url, { mode: 'oauth' }, '');
    await expect(box.manager.authorize(box.server as never)).rejects.toThrow(/publicUrl/);
    // 一次网络请求都不该发出去：redirect_uri 注册进对方那里之后就不好改了。
    expect(remote.seen.register).toBe(0);
    expect(remote.seen.authorize).toBe(0);
  });

  it('bearer：token 存进金库就能连上，被撤销之后是 needs_auth', async () => {
    const remote = await fixture();
    const box = harness('bearer', remote.url, { mode: 'bearer' });
    // 先不填 token：应当是 needs_auth，且提示语说的是「本地没有保存 token」。
    await box.manager.reconcile();
    expect(box.state()?.state).toBe('needs_auth');
    expect(box.state()?.last_error).toContain('没有保存 token');

    box.store.setBearer('probe', remote.mintBearer());
    await box.manager.reconcile();
    expect(box.state()?.state).toBe('up');
    // 界面上只看得到末 4 位，不是整串。
    const credential = box.store.get('probe')!;
    expect(credential.hint).toHaveLength(4);
    expect(credential.mode).toBe('bearer');

    remote.revokeAll();
    await box.manager.reconcile();
    expect(box.state()?.state).toBe('needs_auth');
    expect(box.state()?.last_error).toContain('拒收');
  });

  it('bearer：轮换 token 真的换掉连接（指纹里带凭据版本）', async () => {
    const remote = await fixture();
    const box = harness('rotate', remote.url, { mode: 'bearer' });
    box.store.setBearer('probe', remote.mintBearer());
    await box.manager.reconcile();
    expect(box.state()?.state).toBe('up');
    const firstVersion = box.store.version('probe');

    // 旧 token 全部作废，同时换上一个新的。指纹里没有 authVersion 的话，
    // `existing.fingerprint === print` 会命中旧连接 —— 界面显示「已连接」而它拿着废 token。
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
    // 提示语要指向「去把 auth.mode 改掉」，而不是「点登录」——后者在这个模式下没有按钮。
    expect(box.state()?.last_error).toContain('auth.mode');
    // **不挂 authProvider 的意义就在这里**：不替运维决定去第三方那里注册一个客户端。
    expect(remote.seen.register).toBe(0);
    expect(remote.seen.authorize).toBe(0);
  });

  /**
   * **凭据不能以明文出现在库里任何地方。** 这条不是形式主义：此前
   * `headers: { Authorization: 'Bearer …' }` 的 token 明文进了 `config_revisions`、也从
   * `/api/config/export` 原样出来 —— 因为按键名判密的那条正则是 `/key|secret|token|password/i`，
   * 它匹配不到 `Authorization`。把凭据搬进 `mcp_auth` 的全部意义就在这一条断言上。
   *
   * 判据是**扫全库**而不是只看 `mcp_auth`：漏的那次正是漏在另一张表里。
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
    // 对照组：密文确实在那儿（否则上面那条断言用一张空表也能过）。
    const stored = db.prepare('SELECT secret_enc FROM mcp_auth WHERE server=?').pluck().get('probe') as string;
    expect(stored).toMatch(/^v2\./);
    expect(stored).not.toContain(token);
  });

  it('待授权表：state 单次可用、过期即失效、同一台 server 只留最后一条', () => {
    const pending = new PendingAuthorizations();
    pending.put('state-a', 'probe', 'https://as.example/authorize?state=state-a');
    expect(pending.take('state-a')?.server).toBe('probe');
    // 重放：同一个 state 第二次回来必须落空。
    expect(pending.take('state-a')).toBeNull();
    expect(pending.take('never-issued')).toBeNull();

    pending.put('state-b', 'probe', 'https://as.example/authorize?state=state-b');
    pending.put('state-c', 'probe', 'https://as.example/authorize?state=state-c');
    // 点两次〔登录〕之后，先点的那一条不该还能换到凭据。
    expect(pending.take('state-b')).toBeNull();
    expect(pending.take('state-c')?.server).toBe('probe');
  });
});
