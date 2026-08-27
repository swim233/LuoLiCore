import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ArchiveRepository, CustomToolRepository, OperationsRepository, PrincipalRepository, closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { ContextEngine, CustomToolManager, DatabaseApprovalBroker, EventBus, LogSink, MaintenanceService, PluginManager, ProviderStore, Sandbox, Secrets, ToolRegistry, configSchema } from '@luoli/core';
import { createServer } from '@luoli/server';

/**
 * 复审面的端点契约：`/api/custom-tools` 与 plugin 的源码 / 删除。
 *
 * 这两组是「模型能创建，但不能让自己创建的东西生效」那条纪律在 WebUI 侧的落点 —— 没有它们，
 * owner 复审就只能是句口号（读不到正文，也点不动那个开关）。
 */
function harness(name: string) {
  const path = `./data/${name}.test.db`;
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
  const root = resolve(`./data/${name}-root`);
  rmSync(root, { recursive: true, force: true });
  for (const dir of ['workspace', 'plugins']) mkdirSync(`${root}/${dir}`, { recursive: true });
  const db = openDatabase(path); migrateDatabase(db);
  const config = configSchema.parse({ access: { bootstrapOwnerId: '1' }, webui: { passwordHash: 'hash' },
    tools: { selfExtend: { enabled: true, customTools: { enabled: true } } } });
  const operations = new OperationsRepository(db); const events = new EventBus();
  const log = new LogSink(operations, `./data/${name}-logs`); const archive = new ArchiveRepository(db);
  const registry = new ToolRegistry(log, { request: async () => true }, { maxRegistered: 200, maxCallsPerTurn: 50, maxConsecutiveErrors: 10 });
  const sandbox = new Sandbox(() => ({ mode: 'docker', bypassRoles: ['owner'], dockerBin: 'docker', image: 'x', network: 'none',
    memoryMb: 256, cpus: 1, pidsLimit: 64, readOnlyRoot: false, tmpfsMb: 16, workspaceDir: `${root}/workspace`, hostWorkspaceDir: '',
    defaultTimeoutMs: 10_000, maxTimeoutMs: 30_000, maxOutputBytes: 65_536 }));
  const repo = new CustomToolRepository(db);
  const manager = new CustomToolManager(repo, () => config.tools.selfExtend, sandbox, log, () => config.tools.exec.maxTimeoutMs);
  manager.bindRegistry(registry);
  const plugins = new PluginManager(db, `${root}/plugins`, 1000, 3, [], registry);
  const app = createServer({ config, db, operations, principals: new PrincipalRepository(db), archive, context: new ContextEngine(db, archive),
    providers: new ProviderStore(db, new Secrets('x'.repeat(32))), approvals: new DatabaseApprovalBroker(db, config, events, log),
    maintenance: new MaintenanceService(db, path, 2, 30), events, log, configSchema: {}, startedAt: Date.now(), setup: undefined,
    tools: registry, customTools: repo, customToolManager: manager, plugins });
  const session = operations.createSession(1);
  return { app, db, repo, manager, registry, plugins, root,
    headers: { cookie: `luoli_sid=${session.id}`, 'x-csrf-token': session.csrf, 'content-type': 'application/json' } };
}

const json = async (response: Response): Promise<{ ok: boolean; data?: unknown; error?: { code: string } }> => {
  expect(response.headers.get('content-type')).toContain('application/json');
  return await response.json() as { ok: boolean; data?: unknown };
};

describe('self-extension review endpoints', () => {
  it('lists, enables and deletes a custom tool, and the toggle drives the registry', async () => {
    const h = harness('selfextend-api-tools');
    const context = { turn: { turnId: 't', key: 'chat:1', chatId: '1', initiatorUserId: '2', effectiveRole: 'owner' }, workspace: `${h.root}/workspace`, agentKind: 'main' } as never;
    h.manager.define({ name: 'probe', description: 'x', runtime: 'bash', body: 'true' }, context);

    const listed = await json(await h.app.request('/api/custom-tools', { headers: h.headers }));
    expect(listed.data).toMatchObject([{ name: 'probe', enabled: 0, reviewedAt: null }]);
    expect(h.registry.has('custom_probe')).toBe(false);

    const enabled = await json(await h.app.request('/api/custom-tools/probe', { method: 'PATCH', headers: h.headers, body: JSON.stringify({ enabled: true }) }));
    expect(enabled.data).toMatchObject({ name: 'probe', enabled: 1 });
    expect((enabled.data as { reviewedAt: number | null }).reviewedAt).not.toBeNull();
    // 端点必须顺手 reconcile：只改库不重扫的话，界面说启用了而模型下一轮还是看不见。
    expect(h.registry.has('custom_probe')).toBe(true);
    // 启用一段模型写的脚本记 warn，运维在日志页一眼能看见。
    expect(h.db.prepare("SELECT COUNT(*) FROM log_events WHERE kind='webui.action' AND level='warn' AND summary LIKE 'custom tool enabled%'").pluck().get()).toBe(1);

    expect((await h.app.request('/api/custom-tools/probe', { method: 'DELETE', headers: h.headers })).status).toBe(200);
    expect(h.registry.has('custom_probe')).toBe(false);
    expect((await h.app.request('/api/custom-tools/probe', { method: 'DELETE', headers: h.headers })).status).toBe(404);
    closeDatabase(h.db);
  });

  it('serves plugin source for review and deletes the directory with the row', async () => {
    const h = harness('selfextend-api-plugins');
    await h.plugins.writeSource('demo', 'export default { name: "demo" };\n');
    const source = await json(await h.app.request('/api/plugins/demo/source', { headers: h.headers }));
    expect(source.data).toMatchObject({ name: 'demo', source: 'export default { name: "demo" };\n' });
    expect((await h.app.request('/api/plugins/nope/source', { headers: h.headers })).status).toBe(404);
    // **名字是目录段，必须过正则。** Hono 的 `ctx.req.param()` 会做百分号解码，少这一道就是
    // 「读到磁盘上任何一个 plugin.js」加一个目录存在性探针。
    for (const evil of ['..%2F..%2Fetc', '..%2F..%2F..%2Fpackages', 'a%2Fb']) {
      expect((await h.app.request(`/api/plugins/${evil}/source`, { headers: h.headers })).status, evil).toBe(400);
    }

    expect((await h.app.request('/api/plugins/demo', { method: 'DELETE', headers: h.headers })).status).toBe(200);
    expect(h.db.prepare('SELECT COUNT(*) FROM plugins').pluck().get()).toBe(0);
    expect((await h.app.request('/api/plugins/demo/source', { headers: h.headers })).status).toBe(404);
    // 什么都没删掉时 404，与 custom-tools 同口径 —— 回 200 的话界面会对着一个拼错的名字弹「已删除」。
    expect((await h.app.request('/api/plugins/demo', { method: 'DELETE', headers: h.headers })).status).toBe(404);
    closeDatabase(h.db);
  });

  it('keeps a backup of the source it overwrites', async () => {
    const h = harness('selfextend-api-backup');
    await h.plugins.writeSource('demo', 'operator wrote this\n');
    const written = await h.plugins.writeSource('demo', 'model wrote this\n');
    // 这个入口现在也给模型用，而被覆盖的可能是运维手写的那份 —— plugin.js 没有 write_file
    // 那样的 backupDir / 回收站，不留档就是真的没了。
    expect(written.backup).not.toBeNull();
    expect(readFileSync(written.backup!, 'utf8')).toBe('operator wrote this\n');
    expect(h.plugins.readSource('demo')).toBe('model wrote this\n');
    // 备份文件不叫 plugin.js，所以 reconcile 不会去加载它。
    expect(readdirSync(`${h.root}/plugins/demo`).filter((entry) => entry === 'plugin.js')).toHaveLength(1);
    closeDatabase(h.db);
  });

  it('reports not_implemented instead of an empty list when the deployment lacks the wiring', async () => {
    const path = './data/selfextend-api-bare.test.db';
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
    const db = openDatabase(path); migrateDatabase(db);
    const config = configSchema.parse({ access: { bootstrapOwnerId: '1' }, webui: { passwordHash: 'hash' } });
    const operations = new OperationsRepository(db); const events = new EventBus();
    const log = new LogSink(operations, './data/selfextend-api-bare-logs'); const archive = new ArchiveRepository(db);
    const app = createServer({ config, db, operations, principals: new PrincipalRepository(db), archive, context: new ContextEngine(db, archive),
      providers: new ProviderStore(db, new Secrets('x'.repeat(32))), approvals: new DatabaseApprovalBroker(db, config, events, log),
      maintenance: new MaintenanceService(db, path, 2, 30), events, log, configSchema: {}, startedAt: Date.now(), setup: undefined });
    const session = operations.createSession(1);
    const headers = { cookie: `luoli_sid=${session.id}`, 'x-csrf-token': session.csrf, 'content-type': 'application/json' };
    // 空列表和「这个部署压根没装」在运维眼里是两回事（docs/16 §5「摘除比伪造安全」）。
    const response = await app.request('/api/custom-tools', { headers });
    expect(response.status).toBe(500);
    expect((await json(response)).error).toMatchObject({ code: 'not_implemented' });
    closeDatabase(db);
  });
});
