import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ArchiveRepository, OperationsRepository, PrincipalRepository, closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { ContextEngine, DatabaseApprovalBroker, EventBus, LogSink, MaintenanceService, ProviderStore, Secrets, TOOL_POLICY, configSchema } from '@luoli/core';
import type { ToolOverride } from '@luoli/core';
import { createServer } from '@luoli/server';

/**
 * `PATCH /api/tools/:name` 的写入契约（docs/09 §3.7）。
 *
 * 这个端点此前只收 `{enabled}`，现在还收 minRole / approval / timeoutMs。三条最容易写错的地方
 * 各有一条用例：**放宽必须先 409 且一个字都不落库**、**部分 PATCH 不能抹掉同一条 JSON 里其余的
 * 覆盖**、**显式 null 是恢复默认而不是写一个 null 进去**。
 */
function harness(name: string, overrides: Record<string, ToolOverride> = {}) {
  const path = `./data/${name}.test.db`;
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
  const db = openDatabase(path); migrateDatabase(db);
  const config = configSchema.parse({ access: { bootstrapOwnerId: '1' }, webui: { passwordHash: 'hash' }, tools: { overrides } });
  const operations = new OperationsRepository(db); const events = new EventBus(); const log = new LogSink(operations, `./data/${name}-logs`); const archive = new ArchiveRepository(db);
  const app = createServer({ config, db, operations, principals: new PrincipalRepository(db), archive, context: new ContextEngine(db, archive),
    providers: new ProviderStore(db, new Secrets('x'.repeat(32))), approvals: new DatabaseApprovalBroker(db, config, events, log),
    maintenance: new MaintenanceService(db, path, 2, 30), events, log, configSchema: {}, startedAt: Date.now(), setup: undefined });
  const session = operations.createSession(1);
  return { app, db, headers: { cookie: `luoli_sid=${session.id}`, 'x-csrf-token': session.csrf, 'content-type': 'application/json' } };
}

const stored = (db: ReturnType<typeof openDatabase>, tool: string): ToolOverride | null => {
  const row = db.prepare('SELECT value_json AS value FROM config_kv WHERE key=?').pluck().get(`tools.overrides.${tool}`) as string | undefined;
  return row ? JSON.parse(row) as ToolOverride : null;
};
const patch = (app: ReturnType<typeof harness>['app'], headers: Record<string, string>, tool: string, body: unknown) =>
  app.request(`/api/tools/${tool}`, { method: 'PATCH', headers, body: JSON.stringify(body) });

describe('PATCH /api/tools/:name', () => {
  it('未知工具 404，非法取值 400，且都不落库', async () => {
    const { app, db, headers } = harness('tools-api-reject');
    expect((await patch(app, headers, 'not_a_tool', { enabled: false })).status).toBe(404);
    expect((await patch(app, headers, 'bash', { enabled: 'no' })).status).toBe(400);
    expect((await patch(app, headers, 'bash', { minRole: 'god' })).status).toBe(400);
    expect((await patch(app, headers, 'bash', { approval: 'sometimes' })).status).toBe(400);
    expect((await patch(app, headers, 'bash', { timeoutMs: 0 })).status).toBe(400);
    expect((await patch(app, headers, 'bash', { timeoutMs: 1.5 })).status).toBe(400);
    expect(db.prepare('SELECT COUNT(*) FROM config_kv').pluck().get()).toBe(0);
    closeDatabase(db);
  });

  it('收紧直接存，放宽先 409 且一个字都不落库，确认后才写入', async () => {
    const { app, db, headers } = harness('tools-api-relax');
    // delete_file 的代码默认是 trusted + always。
    expect(TOOL_POLICY.delete_file).toMatchObject({ minRole: 'trusted', approval: 'always' });

    // 收紧：minRole 调高，不需要确认。
    expect((await patch(app, headers, 'delete_file', { minRole: 'owner' })).status).toBe(200);
    expect(stored(db, 'delete_file')).toMatchObject({ minRole: 'owner' });

    // 放宽：审批降档 → 409，且库里那一行没被动过。
    const refused = await patch(app, headers, 'delete_file', { approval: 'never' });
    expect(refused.status).toBe(409);
    const body = await refused.json() as { error: { code: string; details: Array<{ path: string; from: string; to: string }> } };
    expect(body.error.code).toBe('relax_requires_confirmation');
    expect(body.error.details).toEqual([{ path: 'approval', from: 'always', to: 'never' }]);
    expect(stored(db, 'delete_file')).toMatchObject({ minRole: 'owner' });
    expect(stored(db, 'delete_file')?.approval).toBeUndefined();

    // 带确认才写入。
    const confirmed = await patch(app, headers, 'delete_file', { approval: 'never', confirmRelax: true });
    expect(confirmed.status).toBe(200);
    expect((await confirmed.json() as { data: { relaxed: string[] } }).data.relaxed).toEqual(['approval']);
    expect(stored(db, 'delete_file')).toMatchObject({ minRole: 'owner', approval: 'never' });
    closeDatabase(db);
  });

  it('minRole 调低同样要确认，报出的 from/to 是代码默认 → 目标值', async () => {
    const { app, db, headers } = harness('tools-api-role');
    const refused = await patch(app, headers, 'delete_file', { minRole: 'limited' });
    expect(refused.status).toBe(409);
    expect((await refused.json() as { error: { details: unknown } }).error.details).toEqual([{ path: 'minRole', from: 'trusted', to: 'limited' }]);
    expect(stored(db, 'delete_file')).toBeNull();
    closeDatabase(db);
  });

  it('部分 PATCH 不会抹掉同一条 JSON 里其余的覆盖', async () => {
    const { app, db, headers } = harness('tools-api-merge');
    expect((await patch(app, headers, 'web_fetch', { minRole: 'owner' })).status).toBe(200);
    expect((await patch(app, headers, 'web_fetch', { timeoutMs: 45_000 })).status).toBe(200);
    // 第二次只带了 timeoutMs —— minRole 必须还在。配置重载是异步的，所以基准取的是库里那一行。
    expect(stored(db, 'web_fetch')).toMatchObject({ minRole: 'owner', timeoutMs: 45_000 });
    expect((await patch(app, headers, 'web_fetch', { enabled: false })).status).toBe(200);
    expect(stored(db, 'web_fetch')).toMatchObject({ minRole: 'owner', timeoutMs: 45_000, enabled: false });
    closeDatabase(db);
  });

  it('显式 null 是恢复默认：字段从覆盖里消失，而不是写一个 null 进去', async () => {
    const { app, db, headers } = harness('tools-api-reset');
    expect((await patch(app, headers, 'web_fetch', { minRole: 'owner', timeoutMs: 45_000 })).status).toBe(200);
    expect((await patch(app, headers, 'web_fetch', { minRole: null })).status).toBe(200);
    const after = stored(db, 'web_fetch')!;
    expect(Object.hasOwn(after, 'minRole')).toBe(false);
    expect(after).toMatchObject({ timeoutMs: 45_000 });
    // 写回去的那条 JSON 仍然过 schema —— 落库前它就是这么校验的。
    expect(configSchema.parse({ tools: { overrides: { web_fetch: after } } }).tools.overrides.web_fetch).toMatchObject({ timeoutMs: 45_000 });
    closeDatabase(db);
  });
});

describe('GET /api/tools', () => {
  // 这个部署没有装配 `ToolRegistry`，走的是「TOOL_POLICY + 覆盖层」那条退回分支 —— 工具页
  // 读的就是它，所以生效值必须在这条分支上也算对。覆盖直接给进配置快照而不是先 PATCH 一次：
  // `config.changed` 之后的重载是异步的（`main.ts`），拿写入去驱动读取会把两件事混在一起测。
  it('扁平字段是生效值，defaults 是代码那份，relaxed 列出更松的项', async () => {
    const { app, db, headers } = harness('tools-api-get', { delete_file: { minRole: 'limited' }, bash: { enabled: false } });
    const response = await app.request('/api/tools', { headers: { cookie: headers.cookie } });
    const data = (await response.json() as { data: Record<string, { minRole: string; approval: string; scope: string; enabled: boolean; defaults: { minRole: string; approval: string }; relaxed: string[] }> }).data;
    expect(data.delete_file!.minRole).toBe('limited');
    expect(data.delete_file!.defaults.minRole).toBe('trusted');
    expect(data.delete_file!.relaxed).toEqual(['minRole']);
    // 覆盖里没有 approval / scope，这两项照旧来自代码。
    expect(data.delete_file!.approval).toBe(TOOL_POLICY.delete_file.approval);
    expect(data.delete_file!.scope).toBe(TOOL_POLICY.delete_file.scope);
    expect(data.bash!.minRole).toBe(TOOL_POLICY.bash.minRole);
    expect(data.bash!.enabled).toBe(false);
    expect(data.bash!.relaxed).toEqual([]);
    closeDatabase(db);
  });
});
