import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ArchiveRepository, OperationsRepository, PrincipalRepository, closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { ContextEngine, DatabaseApprovalBroker, EventBus, LogSink, MaintenanceService, ProviderStore, Secrets, configSchema } from '@luoli/core';
import { createServer } from '@luoli/server';

function appHarness() {
  const path = './data/server.test.db';
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
  const db = openDatabase(path);
  migrateDatabase(db);
  const config = configSchema.parse({ access: { bootstrapOwnerId: '1' }, webui: { passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$invalid$invalid' } });
  const operations = new OperationsRepository(db);
  const events = new EventBus();
  const log = new LogSink(operations, './data/server-logs');
  const archive = new ArchiveRepository(db);
  const context = new ContextEngine(db, archive);
  const approvals = new DatabaseApprovalBroker(db, config, events, log);
  const app = createServer({ config, db, operations, principals: new PrincipalRepository(db), archive, context,
    providers: new ProviderStore(db, new Secrets('x'.repeat(32))), approvals,
    maintenance: new MaintenanceService(db, path, 2, 30), events, log, configSchema: {}, startedAt: Date.now(), setup: undefined });
  return { app, db };
}

describe('server security', () => {
  it('requires authentication and CSRF for writes', async () => {
    const { app, db } = appHarness();
    expect((await app.request('/api/chats')).status).toBe(401);
    const session = new OperationsRepository(db).createSession(1);
    const cookie = `luoli_sid=${session.id}`;
    expect((await app.request('/api/principals/user:1', { method: 'PATCH', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ role: 'owner' }) })).status).toBe(403);
    expect((await app.request('/api/principals/user:1', { method: 'PATCH', headers: { cookie, 'x-csrf-token': session.csrf, 'content-type': 'application/json' }, body: JSON.stringify({ role: 'owner' }) })).status).toBe(200);
    closeDatabase(db);
  });

  it('adds documented security headers', async () => {
    const { app, db } = appHarness();
    const response = await app.request('/api/health');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
    const health = await response.json() as { db: { ok: boolean }; inFlightTurns: number; providers: unknown[] };
    expect(health).toMatchObject({ db: { ok: true }, inFlightTurns: 0 });
    closeDatabase(db);
  });

  it('rejects cross-origin browser requests', async () => {
    const { app, db } = appHarness();
    expect((await app.request('/api/auth/login', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: JSON.stringify({ password: 'wrong' }) })).status).toBe(403);
    closeDatabase(db);
  });
});
