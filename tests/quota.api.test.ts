import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ArchiveRepository, OperationsRepository, PrincipalRepository, closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { ContextEngine, DatabaseApprovalBroker, EventBus, LogSink, MaintenanceService, ProviderStore, Secrets, configSchema } from '@luoli/core';
import { createServer } from '@luoli/server';

function harness(quota: Record<string, unknown> = {}) {
  const path = './data/quota-api.test.db'; for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
  const db = openDatabase(path); migrateDatabase(db);
  const config = configSchema.parse({ access: { bootstrapOwnerId: '1' }, webui: { passwordHash: 'hash' }, general: { timezone: 'UTC' }, quota });
  const operations = new OperationsRepository(db); const events = new EventBus(); const log = new LogSink(operations, './data/quota-api-logs'); const archive = new ArchiveRepository(db);
  const changed: string[] = [];
  events.subscribe((event) => { if (event.type === 'config.changed') changed.push(...(event.data as { keys: string[] }).keys); });
  const app = createServer({ config, db, operations, principals: new PrincipalRepository(db), archive, context: new ContextEngine(db, archive), providers: new ProviderStore(db, new Secrets('x'.repeat(32))), approvals: new DatabaseApprovalBroker(db, config, events, log), maintenance: new MaintenanceService(db, path, 2, 30), events, log, configSchema: {}, startedAt: Date.now(), setup: undefined });
  const session = operations.createSession(1); const headers = { cookie: `luoli_sid=${session.id}`, 'x-csrf-token': session.csrf, 'content-type': 'application/json' };
  return { app, db, headers, changed };
}
const counter = (db: ReturnType<typeof openDatabase>, row: { scope: string; subject: string; window: string; bucket: string; cost?: number; reserved?: number }): void => {
  db.prepare('INSERT INTO quota_counters(scope,subject,window,bucket,cost_usd,reserved_usd,turns,updated_at) VALUES (?,?,?,?,?,?,1,?)')
    .run(row.scope, row.subject, row.window, row.bucket, row.cost ?? 0, row.reserved ?? 0, Date.now());
};
const today = (): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
interface QuotaData { buckets: { day: string; month: string }; unimplemented: string[]; unpricedTotal: number;
  counters: Array<{ scope: string; subject: string; window: string; limit: number | null; limitApprox: boolean; current: boolean; role: string | null; label: string | null }> }
const errorCode = async (response: Response): Promise<string> => (await response.json() as { error: { code: string } }).error.code;

describe('GET /api/quota', () => {
  it('合成 limit 时套用 byRole 覆盖，并标出当前 bucket 与不精确的那几行', async () => {
    const { app, db, headers } = harness({ global: { daily: 5 }, perUser: { daily: 0.5, byRole: { trusted: { daily: 2 } } } });
    new PrincipalRepository(db).upsertSeen({ id: 'user:42', kind: 'user', tgId: '42', role: 'trusted', displayName: '小明', username: 'ming', chatType: null });
    counter(db, { scope: 'global', subject: 'global', window: 'day', bucket: today(), cost: 1.25, reserved: 0.25 });
    counter(db, { scope: 'user', subject: '42', window: 'day', bucket: today(), cost: 0.1 });
    counter(db, { scope: 'user', subject: '42', window: 'day', bucket: '2000-01-01', cost: 9 });
    const body = await (await app.request('/api/quota', { headers: { cookie: headers.cookie } })).json() as { ok: boolean; data: QuotaData };
    expect(body.ok).toBe(true);
    expect(body.data.buckets.day).toBe(today());
    const global = body.data.counters.find((row) => row.scope === 'global')!;
    expect(global).toMatchObject({ limit: 5, current: true, limitApprox: false });
    // 这个人是 trusted，byRole 覆盖掉 perUser.daily=0.5；群里的有效角色取两档中较高者再封顶
    // trusted，未必等于用户自己这一档，所以同时标 limitApprox。
    const user = body.data.counters.find((row) => row.scope === 'user' && row.current)!;
    expect(user).toMatchObject({ limit: 2, limitApprox: true, role: 'trusted', label: '小明' });
    expect(body.data.counters.filter((row) => !row.current)).toHaveLength(1);
    // 未接线的键名由服务端转发，界面不再维护第二份清单。第五轮把 quota 那几个键全接了
    // （`warnAtRatio` 与 `onExceeded.notifyOwner` 各有告警链路上的落点），所以这里现在是空的 ——
    // 断言的是**这份清单仍然由服务端算**，不是「它永远非空」。
    expect(body.data.unimplemented).toEqual([]);
    expect(body.data.unimplemented.every((key) => key.startsWith('quota.'))).toBe(true);
    closeDatabase(db);
  });

  it('把启用中但缺定价的模型数报出来 —— 这些轮次的花费按 0 记账', async () => {
    const { app, db, headers } = harness();
    db.prepare("INSERT INTO providers(id,name,kind,enabled,created_at,updated_at) VALUES ('p','p','openai',1,0,0)").run();
    db.prepare(`INSERT INTO models(id,provider_id,model_id,context_window,max_output,capabilities_json,price_in,price_out,enabled,sort,created_at,updated_at)
      VALUES ('m1','p','free',1000,100,'{}',NULL,NULL,1,0,0,0),('m2','p','paid',1000,100,'{}',1,2,1,0,0,0),('m3','p','off',1000,100,'{}',NULL,NULL,0,0,0,0)`).run();
    const body = await (await app.request('/api/quota', { headers: { cookie: headers.cookie } })).json() as { data: QuotaData };
    expect(body.data.unpricedTotal).toBe(1);
    closeDatabase(db);
  });
});

describe('PUT /api/quota', () => {
  it('点分键落 config_kv + config_revisions 并广播 config.changed', async () => {
    const { app, db, headers, changed } = harness();
    const response = await app.request('/api/quota', { method: 'PUT', headers, body: JSON.stringify({ 'global.daily': 12, 'perUser.byRole': { trusted: { daily: 3 } }, enabled: false }) });
    expect(response.status).toBe(200);
    expect(db.prepare("SELECT value_json FROM config_kv WHERE key='quota.global.daily'").pluck().get()).toBe('12');
    expect(db.prepare("SELECT value_json FROM config_kv WHERE key='quota.enabled'").pluck().get()).toBe('false');
    expect(Number(db.prepare("SELECT COUNT(*) FROM config_revisions WHERE key LIKE 'quota.%'").pluck().get())).toBe(3);
    expect(changed).toEqual(['quota.global.daily', 'quota.perUser.byRole', 'quota.enabled']);
    // 写进去的覆盖层下次启动必须还能被 loadConfig 解析，否则进程直接起不来（docs/19 · R-CFG-02）。
    expect(configSchema.safeParse({ access: { bootstrapOwnerId: '1' }, quota: { global: { daily: 12 }, perUser: { byRole: { trusted: { daily: 3 } } }, enabled: false } }).success).toBe(true);
    closeDatabase(db);
  });

  it('校验失败与原型污染键都在写库之前挡回去', async () => {
    const { app, db, headers } = harness();
    expect(await errorCode(await app.request('/api/quota', { method: 'PUT', headers, body: JSON.stringify({ 'perTurn.maxCostUsd': -1 }) }))).toBe('invalid_config');
    expect(await errorCode(await app.request('/api/quota', { method: 'PUT', headers, body: JSON.stringify({ 'rateLimit.concurrentPerUser': 1.5 }) }))).toBe('invalid_config');
    expect(await errorCode(await app.request('/api/quota', { method: 'PUT', headers, body: JSON.stringify({ '__proto__.polluted': 1 }) }))).toBe('invalid_config_key');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Number(db.prepare('SELECT COUNT(*) FROM config_kv').pluck().get())).toBe(0);
    closeDatabase(db);
  });
});

describe('POST /api/quota/reset', () => {
  it('带过滤条件时只删那一行，不带 body 才是全表清零', async () => {
    const { app, db, headers } = harness();
    counter(db, { scope: 'global', subject: 'global', window: 'day', bucket: today(), cost: 1 });
    counter(db, { scope: 'user', subject: '42', window: 'day', bucket: today(), cost: 1 });
    counter(db, { scope: 'user', subject: '42', window: 'month', bucket: today().slice(0, 7), cost: 1 });
    const one = await app.request('/api/quota/reset', { method: 'POST', headers, body: JSON.stringify({ scope: 'user', subject: '42', window: 'day', bucket: today() }) });
    expect((await one.json() as { data: { changes: number } }).data.changes).toBe(1);
    expect(Number(db.prepare('SELECT COUNT(*) FROM quota_counters').pluck().get())).toBe(2);
    const all = await app.request('/api/quota/reset', { method: 'POST', headers, body: '{}' });
    expect((await all.json() as { data: { changes: number } }).data.changes).toBe(2);
    expect(Number(db.prepare('SELECT COUNT(*) FROM quota_counters').pluck().get())).toBe(0);
    closeDatabase(db);
  });

  it('只给 bucket 不给 scope 会跨 scope 误伤，直接 400', async () => {
    const { app, db, headers } = harness();
    counter(db, { scope: 'global', subject: 'global', window: 'day', bucket: today(), cost: 1 });
    expect(await errorCode(await app.request('/api/quota/reset', { method: 'POST', headers, body: JSON.stringify({ bucket: today() }) }))).toBe('invalid_filter');
    expect(Number(db.prepare('SELECT COUNT(*) FROM quota_counters').pluck().get())).toBe(1);
    closeDatabase(db);
  });
});
