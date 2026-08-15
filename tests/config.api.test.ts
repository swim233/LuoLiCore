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
