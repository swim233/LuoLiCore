import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ArchiveRepository, OperationsRepository, PrincipalRepository, closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { ContextEngine, DatabaseApprovalBroker, EventBus, LogSink, MaintenanceService, ProviderStore, Secrets, configSchema } from '@luoli/core';
import { createServer } from '@luoli/server';

function harness() {
  const path = './data/api-contract.test.db'; for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
  const db = openDatabase(path); migrateDatabase(db); const config = configSchema.parse({ access: { bootstrapOwnerId: '1' }, webui: { passwordHash: 'hash' } });
  const operations = new OperationsRepository(db); const events = new EventBus(); const log = new LogSink(operations, './data/api-contract-logs'); const archive = new ArchiveRepository(db);
  const app = createServer({ config, db, operations, principals: new PrincipalRepository(db), archive, context: new ContextEngine(db, archive), providers: new ProviderStore(db, new Secrets('x'.repeat(32))), approvals: new DatabaseApprovalBroker(db, config, events, log), maintenance: new MaintenanceService(db, path, 2, 30), events, log, configSchema: {}, startedAt: Date.now(), setup: undefined });
  const session = operations.createSession(1); const headers = { cookie: `luoli_sid=${session.id}`, 'x-csrf-token': session.csrf, 'content-type': 'application/json' };
  return { app, db, headers };
}

describe('documented API surface', () => {
  it('serves read endpoints and audits every authenticated write', async () => {
    const { app, db, headers } = harness(); const cookie = { cookie: headers.cookie };
    for (const path of ['/api/dashboard','/api/chats','/api/messages','/api/providers','/api/models','/api/aliases','/api/principals','/api/tools','/api/sandbox','/api/skills','/api/plugins','/api/mcp','/api/agents','/api/logs','/api/usage','/api/quota','/api/tasks','/api/approvals','/api/config','/api/config/schema','/api/config/revisions']) expect((await app.request(path, { headers: cookie })).status, path).toBe(200);
    const response = await app.request('/api/quota/reset', { method: 'POST', headers }); expect(response.status).toBe(200);
    expect(db.prepare("SELECT COUNT(*) FROM log_events WHERE kind='webui.action' AND summary='POST /api/quota/reset'").pluck().get()).toBe(1);
    closeDatabase(db);
  });

  it('returns full context history and creates an audited checkout commit', async () => {
    const { app, db, headers } = harness();
    const archive = new ArchiveRepository(db);
    const context = new ContextEngine(db, archive);
    const config = configSchema.parse({ access: { bootstrapOwnerId: '1' }, webui: { passwordHash: 'hash' } });
    const scoped = archive.scope('chat');
    const trigger = scoped.append({ chatId: 'chat', messageThreadId: null, tgMessageId: 1, direction: 'in', fromKind: 'user', fromUserId: 'user', fromName: 'User', fromUsername: null, kind: 'text', text: 'hello', tgDate: Date.now(), raw: {}, triggered: true, triggerReason: 'mention' });
    const turn = await context.openTurn({ chatId: 'chat', threadId: null, key: 'chat:chat', initiatorUserId: 'user', effectiveRole: 'trusted', isPrivate: false, trigger, abortSignal: new AbortController().signal, config });
    context.appendDelta(turn, { id: 'answer', role: 'assistant', origin: 'assistant', parts: [{ type: 'text', text: 'ok' }] });
    const committed = await context.commitTurn(turn);
    context.reset('chat:chat', 'test');
    const detail = await app.request('/api/chats/chat%3Achat', { headers: { cookie: headers.cookie } });
    const payload = await detail.json() as { data: { messages: Array<{ inWindow: boolean }>; commits: unknown[] } };
    expect(payload.data.messages).toHaveLength(2);
    expect(payload.data.messages.every((message) => message.inWindow === false)).toBe(true);
    const checkout = await app.request(`/api/chats/chat%3Achat/commits/${committed.commit.id}/checkout`, { method: 'POST', headers });
    expect(checkout.status).toBe(200);
    expect(db.prepare("SELECT kind,json_extract(meta_json,'$.targetCommitId') AS target FROM context_commits WHERE key='chat:chat' ORDER BY seq DESC LIMIT 1").get()).toEqual({ kind: 'manual', target: committed.commit.id });
    closeDatabase(db);
  });

  it('persists providers, models, and aliases without exposing provider keys', async () => {
    const { app, db, headers } = harness();
    const provider = await app.request('/api/providers', { method: 'POST', headers, body: JSON.stringify({ name: 'local-openai', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:9999', apiKey: 'secret-api-key' }) });
    expect(provider.status).toBe(200);
    const providerId = (await provider.json() as { data: { id: string } }).data.id;
    const listed = await app.request('/api/providers', { headers: { cookie: headers.cookie } });
    const text = await listed.text();
    expect(text).not.toContain('secret-api-key');
    expect(text).toContain('…-key');
    const model = await app.request('/api/models', { method: 'POST', headers, body: JSON.stringify({ providerId, modelId: 'test-model', contextWindow: 128000, maxOutput: 8192, priceIn: 1.5, priceOut: 6 }) });
    expect(model.status).toBe(200);
    const modelId = (await model.json() as { data: { id: string } }).data.id;
    expect((await app.request('/api/aliases/main', { method: 'PUT', headers, body: JSON.stringify({ modelIds: [modelId], settings: { temperature: 0.2 } }) })).status).toBe(200);
    expect(db.prepare("SELECT model_ids_json FROM model_aliases WHERE alias='main'").pluck().get()).toBe(JSON.stringify([modelId]));
    expect((await app.request('/api/aliases/main', { method: 'PUT', headers, body: JSON.stringify({ modelIds: ['missing'] }) })).status).toBe(400);
    closeDatabase(db);
  });
});
