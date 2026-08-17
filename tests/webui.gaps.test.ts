import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ArchiveRepository, OperationsRepository, PrincipalRepository, closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { ContextEngine, DatabaseApprovalBroker, EventBus, LogSink, MaintenanceService, ProviderStore, Secrets, UsageLedger, configSchema, testApprovalRules } from '@luoli/core';
import { createServer, issueLoginToken } from '@luoli/server';

/** 第五轮补掉的 11 处 WebUI 缺口，逐个钉住服务端那一半。 */

function harness(name: string, extra: Record<string, unknown> = {}) {
  const path = `./data/${name}.test.db`;
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
  const logDir = `./data/${name}-logs`;
  rmSync(logDir, { recursive: true, force: true });
  const workspace = resolve(`./data/${name}-workspace`);
  rmSync(workspace, { recursive: true, force: true });
  mkdirSync(workspace, { recursive: true });
  const db = openDatabase(path); migrateDatabase(db);
  const config = configSchema.parse({ access: { bootstrapOwnerId: '1' }, webui: { passwordHash: 'secret-hash' }, logs: { dir: logDir }, sandbox: { workspaceDir: workspace }, db: { path }, ...extra });
  const operations = new OperationsRepository(db); const events = new EventBus(); const log = new LogSink(operations, logDir);
  const archive = new ArchiveRepository(db);
  const app = createServer({ config, db, operations, principals: new PrincipalRepository(db), archive, context: new ContextEngine(db, archive),
    providers: new ProviderStore(db, new Secrets('x'.repeat(32))), approvals: new DatabaseApprovalBroker(db, config, events, log),
    maintenance: new MaintenanceService(db, path, 2, 30, logDir), ledger: new UsageLedger(db), events, log, configSchema: {}, startedAt: Date.now(), setup: undefined });
  const session = operations.createSession(1);
  return { app, db, workspace, headers: { cookie: `luoli_sid=${session.id}`, 'x-csrf-token': session.csrf, 'content-type': 'application/json' } };
}

const data = async <T>(response: Response): Promise<T> => (await response.json() as { data: T }).data;

describe('C3 · 最近错误按级别过滤', () => {
  it('minLevel=warn 时不返回 info/debug', async () => {
    const { app, db, headers } = harness('gaps-logs');
    for (const level of ['debug', 'info', 'warn', 'error'] as const) db.prepare('INSERT INTO log_events(ts,level,kind,summary) VALUES (?,?,?,?)').run(Date.now(), level, `k.${level}`, level);
    const filtered = await data<Array<{ level: string }>>(await app.request('/api/logs?minLevel=warn&size=10', { headers: { cookie: headers.cookie } }));
    expect(filtered.map((row) => row.level).sort()).toEqual(['error', 'warn']);
    // 不传 minLevel 时行为不变（日志页要的是全量流）。
    expect((await data<unknown[]>(await app.request('/api/logs', { headers: { cookie: headers.cookie } }))).length).toBe(4);
    closeDatabase(db);
  });
});

describe('C4 · 系统信息里的占用', () => {
  it('/api/health/detail 带回 DB / WAL / workspace 字节数', async () => {
    const { app, db, workspace, headers } = harness('gaps-health');
    writeFileSync(resolve(workspace, 'model-made-this.txt'), 'x'.repeat(4096));
    const detail = await data<{ db: { bytes: number; walBytes: number; workspaceBytes: number } }>(await app.request('/api/health/detail', { headers: { cookie: headers.cookie } }));
    expect(detail.db.bytes).toBeGreaterThan(0);
    expect(detail.db.workspaceBytes).toBeGreaterThanOrEqual(4096);
    expect(typeof detail.db.walBytes).toBe('number');
    closeDatabase(db);
  });
});

describe('C7 · 用量维度聚合', () => {
  it('六个维度都能聚合，chat/user 带回显示名，非法维度 400', async () => {
    const { app, db, headers } = harness('gaps-usage');
    db.prepare("INSERT INTO principals(id,kind,tg_id,role,display_name,username,first_seen_at,updated_at,updated_by) VALUES ('chat:-100','chat','-100','trusted','研发群','devs',1,1,'test')").run();
    const insert = db.prepare(`INSERT INTO usage_ledger(ts,turn_id,agent_run_id,chat_id,user_id,provider_id,model_id,model_alias,input_tokens,output_tokens,cost_usd,ok)
      VALUES (?,?,?,?,?,'p','gpt','main',100,50,?,?)`);
    insert.run(Date.now(), 't1', 'r1', '-100', 'u1', 0.5, 1);
    insert.run(Date.now(), 't2', 'r1', '-100', 'u1', 0.25, 0);
    for (const groupBy of ['day', 'chat', 'user', 'model', 'alias', 'agent']) {
      const report = await data<{ groupBy: string; rows: unknown[] }>(await app.request(`/api/usage/report?groupBy=${groupBy}`, { headers: { cookie: headers.cookie } }));
      expect(report.groupBy).toBe(groupBy);
      expect(report.rows.length).toBeGreaterThan(0);
    }
    // 裸 id 认不出是哪个群 —— 显示名在服务端补，前端不再实现第二份反查规则。
    const byChat = await data<{ rows: Array<{ bucket: string; label: string; costUsd: number; calls: number; successes: number }> }>(await app.request('/api/usage/report?groupBy=chat', { headers: { cookie: headers.cookie } }));
    expect(byChat.rows[0]).toMatchObject({ bucket: '-100', label: '研发群 (@devs)', calls: 2, successes: 1 });
    expect(byChat.rows[0]!.costUsd).toBeCloseTo(0.75, 6);
    expect((await app.request('/api/usage/report?groupBy=nope', { headers: { cookie: headers.cookie } })).status).toBe(400);
    expect((await app.request('/api/usage/report?from=99&to=1', { headers: { cookie: headers.cookie } })).status).toBe(400);
    closeDatabase(db);
  });
});

describe('C11 · 配置导出 / 导入', () => {
  it('导出覆盖层、跳过密钥键；导入走同一条校验路径', async () => {
    const { app, db, headers } = harness('gaps-export');
    expect((await app.request('/api/config', { method: 'PUT', headers, body: JSON.stringify({ 'context.limit.tokens': 40_000 }) })).status).toBe(200);
    expect((await app.request('/api/config', { method: 'PUT', headers, body: JSON.stringify({ 'tools.web.searchApiKey': 'brave-secret' }) })).status).toBe(200);
    const exported = await data<{ overrides: Record<string, unknown>; skipped: string[] }>(await app.request('/api/config/export', { headers: { cookie: headers.cookie } }));
    expect(exported.overrides['context.limit.tokens']).toBe(40_000);
    // 密钥键不导出，也**不导成 `«redacted»`** —— 那样导入端会把真密钥覆盖成一个字面量。
    expect(exported.overrides['tools.web.searchApiKey']).toBeUndefined();
    expect(exported.skipped).toContain('tools.web.searchApiKey');
    expect(JSON.stringify(exported)).not.toContain('brave-secret');
    // 导入：合法的进去，schema 外的整批拒掉。
    const imported = await app.request('/api/config/import', { method: 'POST', headers, body: JSON.stringify({ overrides: { 'context.limit.maxMessages': 150 } }) });
    expect(imported.status).toBe(200);
    expect(JSON.parse(db.prepare("SELECT value_json FROM config_kv WHERE key='context.limit.maxMessages'").pluck().get() as string)).toBe(150);
    const bad = await app.request('/api/config/import', { method: 'POST', headers, body: JSON.stringify({ overrides: { 'context.limit.tokens': 1 } }) });
    expect(bad.status).toBe(400);
    expect(JSON.parse(db.prepare("SELECT value_json FROM config_kv WHERE key='context.limit.tokens'").pluck().get() as string)).toBe(40_000);
    closeDatabase(db);
  });
});

describe('C9 · 原始 YAML', () => {
  it('解析在服务端；语法错误带行号，校验错误带路径', async () => {
    const { app, db, headers } = harness('gaps-yaml');
    expect((await app.request('/api/config', { method: 'PUT', headers, body: JSON.stringify({ 'context.limit.tokens': 40_000 }) })).status).toBe(200);
    const rendered = await data<{ yaml: string }>(await app.request('/api/config/yaml', { headers: { cookie: headers.cookie } }));
    expect(rendered.yaml).toContain('tokens: 40000');
    // 语法错误：行号必须交回去，否则界面上「错误定位到行」做不到。
    const broken = await app.request('/api/config/yaml', { method: 'PUT', headers, body: JSON.stringify({ yaml: 'context:\n  limit:\n   tokens: [unclosed' }) });
    expect(broken.status).toBe(400);
    const brokenBody = await broken.json() as { error: { code: string; line?: number } };
    expect(brokenBody.error.code).toBe('invalid_yaml');
    expect(brokenBody.error.line).toBeGreaterThan(0);
    // 校验错误：带 zod 的路径。
    const invalid = await app.request('/api/config/yaml', { method: 'PUT', headers, body: JSON.stringify({ yaml: 'context:\n  limit:\n    tokens: 1\n' }) });
    expect(invalid.status).toBe(400);
    expect((await invalid.json() as { error: { details: Array<{ path: string }> } }).error.details.some((entry) => entry.path === 'context.limit.tokens')).toBe(true);
    // 合法的写进去，按顶层段落库（粒度是点分键，不是一整棵树写成一行）。
    const ok = await app.request('/api/config/yaml', { method: 'PUT', headers, body: JSON.stringify({ yaml: 'context:\n  limit:\n    tokens: 48000\n' }) });
    expect(ok.status).toBe(200);
    expect(db.prepare("SELECT COUNT(*) FROM config_kv WHERE key='context'").pluck().get()).toBe(1);
    closeDatabase(db);
  });
});

describe('C6 · 审批规则试跑', () => {
  it('逐条报告命中与否，并说得出为什么没命中', async () => {
    const { app, db, headers } = harness('gaps-rules');
    const rules = [{ tool: 'bash', pattern: '(?i)rm\\s+-rf', risk: 'high' }, { tool: 'write_file', when: 'target_exists' }];
    const hit = await data<{ needed: boolean; risk: string; rules: Array<{ matched: boolean; reason: string }> }>(
      await app.request('/api/approvals/test', { method: 'POST', headers, body: JSON.stringify({ rules, tool: 'bash', input: { command: 'RM -RF /tmp' } }) }));
    expect(hit).toMatchObject({ needed: true, risk: 'high' });
    expect(hit.rules[0]!.matched).toBe(true);
    // 没命中的那条要说出原因，而不是只给一个 false。
    expect(hit.rules[1]!.matched).toBe(false);
    expect(hit.rules[1]!.reason).toContain('工具名不匹配');
    const miss = await data<{ needed: boolean }>(await app.request('/api/approvals/test', { method: 'POST', headers, body: JSON.stringify({ rules, tool: 'bash', input: { command: 'ls' } }) }));
    expect(miss.needed).toBe(false);
    // `target_exists` 的最终判定取决于运行时，试跑不许编一个答案。
    const runtime = testApprovalRules(rules, 'write_file', { path: 'a.txt' });
    expect(runtime.runtimeDependent).toBe(true);
    // 规则自己不合法时整批拒掉 —— 试跑一个不合法的规则表毫无意义。
    expect((await app.request('/api/approvals/test', { method: 'POST', headers, body: JSON.stringify({ rules: [{ tool: 'bash', pattern: '(' }], tool: 'bash' }) })).status).toBe(400);
    closeDatabase(db);
  });
});

describe('C1 · /webui 一次性登录', () => {
  it('token 单次使用、会过期，用掉之后再用就是 401', async () => {
    const { app, db } = harness('gaps-login');
    const issued = issueLoginToken();
    const first = await app.request('/api/auth/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: issued.token }) });
    expect(first.status).toBe(200);
    expect(first.headers.get('set-cookie')).toContain('luoli_sid=');
    // 单次使用：同一个 token 再来一次必须失败。
    expect((await app.request('/api/auth/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: issued.token }) })).status).toBe(401);
    expect((await app.request('/api/auth/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'not-a-token' }) })).status).toBe(401);
    // 已过期的 token 也不认。
    const expired = issueLoginToken(-1);
    expect((await app.request('/api/auth/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: expired.token }) })).status).toBe(401);
    closeDatabase(db);
  });
});

describe('C2 · 总览趋势', () => {
  it('按本地日分桶，没有数据的那天补 0 而不是跳过', async () => {
    const { app, db, headers } = harness('gaps-trend');
    db.prepare(`INSERT INTO messages(chat_id,tg_message_id,direction,from_kind,kind,raw_json,tg_date,received_at) VALUES ('c',1,'in','user','text','{}',?,?)`).run(Date.now(), Date.now());
    const dashboard = await data<{ trend: Array<{ day: string; messages: number }> }>(await app.request('/api/dashboard', { headers: { cookie: headers.cookie } }));
    expect(dashboard.trend).toHaveLength(7);
    expect(dashboard.trend.at(-1)!.messages).toBe(1);
    // 空的那几天是 0，不是缺失 —— 折线图上「那天没有点」和「那天是 0」是两回事。
    expect(dashboard.trend.slice(0, 6).every((point) => point.messages === 0)).toBe(true);
    closeDatabase(db);
  });
});
