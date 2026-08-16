import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ArchiveRepository, OperationsRepository, PrincipalRepository, closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { ContextEngine, DatabaseApprovalBroker, EventBus, LogSink, MaintenanceService, PromptDocuments, ProviderStore, Secrets, configSchema } from '@luoli/core';
import { createServer } from '@luoli/server';

function harness() {
  const path = './data/config-write.test.db';
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
  const db = openDatabase(path); migrateDatabase(db);
  const config = configSchema.parse({ access: { bootstrapOwnerId: '1' }, webui: { passwordHash: 'secret-hash' } });
  const operations = new OperationsRepository(db); const events = new EventBus(); const log = new LogSink(operations, './data/config-write-logs'); const archive = new ArchiveRepository(db);
  const promptDocuments = new PromptDocuments(db, './data/config-prompts'); promptDocuments.ensure();
  const app = createServer({ config, db, operations, principals: new PrincipalRepository(db), archive, context: new ContextEngine(db, archive), providers: new ProviderStore(db, new Secrets('x'.repeat(32))), approvals: new DatabaseApprovalBroker(db, config, events, log), maintenance: new MaintenanceService(db, path, 2, 30), promptDocuments, events, log, configSchema: {}, startedAt: Date.now(), setup: undefined });
  const session = operations.createSession(1); const headers = { cookie: `luoli_sid=${session.id}`, 'x-csrf-token': session.csrf, 'content-type': 'application/json' };
  return { app, db, headers };
}

describe('config API validation', () => {
  it('rejects invalid merged config without persisting and redacts sensitive fields', async () => {
    const { app, db, headers } = harness();
    const invalid = await app.request('/api/config', { method: 'PUT', headers, body: JSON.stringify({ 'context.limit.tokens': 1 }) });
    expect(invalid.status).toBe(400);
    expect(db.prepare("SELECT COUNT(*) FROM config_kv WHERE key='context.limit.tokens'").pluck().get()).toBe(0);
    const response = await app.request('/api/config', { headers: { cookie: headers.cookie } });
    expect((await response.json() as { data: { webui: { passwordHash: string } } }).data.webui.passwordHash).toBe('«redacted»');
    closeDatabase(db);
  });

  it('refuses wakewords that would never match and reports why', async () => {
    const { app, db, headers } = harness();
    const unsafe = await app.request('/api/config', { method: 'PUT', headers, body: JSON.stringify({ 'trigger.wakewords': ['洛璃', '^(a+)+$'] }) });
    expect(unsafe.status).toBe(400);
    expect((await unsafe.json() as { error: { code: string; message: string } }).error).toMatchObject({ code: 'invalid_wakeword' });
    const tooShort = await app.request('/api/config', { method: 'PUT', headers, body: JSON.stringify({ 'trigger.wakewords': ['璃'] }) });
    expect(tooShort.status).toBe(400);
    expect(db.prepare("SELECT COUNT(*) FROM config_kv WHERE key='trigger.wakewords'").pluck().get()).toBe(0);
    const ok = await app.request('/api/config', { method: 'PUT', headers, body: JSON.stringify({ 'trigger.wakewords': ['洛璃', '^璃酱[，,、 ]'] }) });
    expect(ok.status).toBe(200);
    expect(db.prepare("SELECT value_json FROM config_kv WHERE key='trigger.wakewords'").pluck().get()).toBe('["洛璃","^璃酱[，,、 ]"]');
    const checked = await app.request('/api/config/wakewords/check', { method: 'POST', headers, body: JSON.stringify({ wakewords: ['洛璃', '^璃酱', '璃', '^(a+)+$'], minLength: 2 }) });
    expect((await checked.json() as { data: Array<{ kind: string; ok: boolean }> }).data).toMatchObject([{ kind: 'contains', ok: true }, { kind: 'regex', ok: true }, { ok: false }, { ok: false }]);
    closeDatabase(db);
  });

  it('validates per-chat wakeword overrides through the same rule', async () => {
    const { app, db, headers } = harness();
    const rejected = await app.request('/api/chats/chat:-100', { method: 'PATCH', headers, body: JSON.stringify({ trigger: { wakewords: ['^(a+)+$'] } }) });
    expect(rejected.status).toBe(400);
    expect(db.prepare("SELECT COUNT(*) FROM config_kv WHERE key='perChat.chat:-100'").pluck().get()).toBe(0);
    const accepted = await app.request('/api/chats/chat:-100', { method: 'PATCH', headers, body: JSON.stringify({ trigger: { wakewords: ['璃酱'] } }) });
    expect(accepted.status).toBe(200);
    expect(db.prepare("SELECT value_json FROM config_kv WHERE key='perChat.chat:-100'").pluck().get()).toBe('{"trigger":{"wakewords":["璃酱"]}}');
    closeDatabase(db);
  });

  it('persists the output pacing form and refuses a zero edit interval', async () => {
    const { app, db, headers } = harness();
    const ok = await app.request('/api/config', { method: 'PUT', headers, body: JSON.stringify({ 'output.streamBufferMs': 3000, 'output.streamIntervalMs': 1500, 'output.streamMinDeltaChars': 12 }) });
    expect(ok.status).toBe(200);
    expect(db.prepare("SELECT value_json FROM config_kv WHERE key='output.streamBufferMs'").pluck().get()).toBe('3000');
    // config_kv 的每一行都会成为下次启动的覆盖层：设置页写进去的键必须仍然过得了 configSchema。
    expect(configSchema.parse({ output: { streamBufferMs: 3000 } }).output.streamBufferMs).toBe(3000);
    const invalid = await app.request('/api/config', { method: 'PUT', headers, body: JSON.stringify({ 'output.streamIntervalMs': 0 }) });
    expect(invalid.status).toBe(400);
    expect(db.prepare("SELECT value_json FROM config_kv WHERE key='output.streamIntervalMs'").pluck().get()).toBe('1500');
    closeDatabase(db);
  });

  // 会话页的覆盖面板依赖这条语义：PATCH 是**整体替换**而不是合并，所以界面每次都要把「要保留的
  // 那几项」一起发回来，取消覆盖也是靠发一份不含它的对象（docs/21 · G-API-09）。
  it('replaces the whole per-chat override object instead of merging', async () => {
    const { app, db, headers } = harness();
    const key = 'chat%3A-100';
    expect((await app.request(`/api/chats/${key}`, { method: 'PATCH', headers, body: JSON.stringify({ output: { mode: 'once' }, trigger: { mention: false } }) })).status).toBe(200);
    expect(JSON.parse(db.prepare("SELECT value_json FROM config_kv WHERE key='perChat.chat:-100'").pluck().get() as string))
      .toEqual({ output: { mode: 'once' }, trigger: { mention: false } });
    // 只发 output 那一半：trigger 那一半会被整体替换掉，而不是留在库里。
    expect((await app.request(`/api/chats/${key}`, { method: 'PATCH', headers, body: JSON.stringify({ output: { mode: 'once' } }) })).status).toBe(200);
    expect(JSON.parse(db.prepare("SELECT value_json FROM config_kv WHERE key='perChat.chat:-100'").pluck().get() as string)).toEqual({ output: { mode: 'once' } });
    // 空对象 = 这个会话什么都不覆盖，且仍然过得了 configSchema（下次启动不会因此拒绝加载）。
    expect((await app.request(`/api/chats/${key}`, { method: 'PATCH', headers, body: '{}' })).status).toBe(200);
    expect(configSchema.parse({ perChat: { 'chat:-100': {} } }).perChat).toEqual({ 'chat:-100': {} });
    closeDatabase(db);
  });

  // 自动生成的表单靠这三件套决定控件形态与「热更新 / 需重启 / 未接线」徽标：挂在信封顶层的
  // 兄弟键会被只解 `data` 的客户端静默丢掉，那样表单会把每一项都当成需重启（docs/21 §1.1）。
  it('serves schema, hot-reload prefixes, and unimplemented keys inside one data envelope', async () => {
    const { app, db, headers } = harness();
    const response = await app.request('/api/config/schema', { headers: { cookie: headers.cookie } });
    const payload = await response.json() as { ok: boolean; data: { schema: unknown; hotReloadable: string[]; unimplemented: string[] } };
    expect(payload.ok).toBe(true);
    expect(payload.data.schema).toBeDefined();
    expect(payload.data.hotReloadable).toContain('logs.level');
    expect(payload.data.unimplemented).toContain('trigger.ignoreEditedAsTrigger');
    closeDatabase(db);
  });

  it('persists prompt edits with a unified diff revision', async () => {
    const { app, db, headers } = harness();
    const response = await app.request('/api/prompts/assist:global', { method: 'PUT', headers, body: JSON.stringify({ content: '# Assist\n\nupdated\n' }) });
    expect(response.status).toBe(200);
    const revision = db.prepare("SELECT diff FROM memory_revisions WHERE doc_id='assist:global' ORDER BY ts DESC").pluck().get() as string;
    expect(revision).toContain('--- before');
    expect(revision).toContain('+++ after');
    const revisionId = db.prepare("SELECT id FROM memory_revisions WHERE doc_id='assist:global' ORDER BY ts DESC").pluck().get() as string;
    const rollback = await app.request('/api/prompts/assist:global/rollback', { method: 'POST', headers, body: JSON.stringify({ revisionId }) });
    expect(rollback.status).toBe(200);
    expect((await app.request('/api/prompts/assist:global', { headers: { cookie: headers.cookie } })).status).toBe(200);
    closeDatabase(db);
  });
});
