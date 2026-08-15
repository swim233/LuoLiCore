import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ArchiveRepository, OperationsRepository, PrincipalRepository, closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { ContextEngine, DatabaseApprovalBroker, EventBus, LogSink, MaintenanceService, ProviderStore, Secrets, configSchema } from '@luoli/core';
import { createServer } from '@luoli/server';

function harness(name: string) {
  const path = `./data/${name}.test.db`;
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
  const db = openDatabase(path);
  migrateDatabase(db);
  const config = configSchema.parse({ access: { bootstrapOwnerId: '1' }, webui: { passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$invalid$invalid' }, tools: { overrides: { bash: { enabled: false } } } });
  const operations = new OperationsRepository(db);
  const events = new EventBus();
  const log = new LogSink(operations, './data/server-logs');
  const archive = new ArchiveRepository(db);
  const principals = new PrincipalRepository(db);
  const app = createServer({ config, db, operations, principals, archive, context: new ContextEngine(db, archive),
    providers: new ProviderStore(db, new Secrets('x'.repeat(32))), approvals: new DatabaseApprovalBroker(db, config, events, log),
    maintenance: new MaintenanceService(db, path, 2, 30), events, log, configSchema: {}, startedAt: Date.now(), setup: undefined });
  const session = operations.createSession(1);
  return { app, db, principals, headers: { cookie: `luoli_sid=${session.id}`, 'x-csrf-token': session.csrf, 'content-type': 'application/json' } };
}

const body = async <T>(response: Response): Promise<T> => (await response.json() as { data: T }).data;

describe('console endpoints', () => {
  it('pages recent turns with their prompt and de-duplicated reply', async () => {
    const { app, db, headers } = harness('turns');
    const scoped = new ArchiveRepository(db).scope('chat-1', null);
    for (let index = 0; index < 25; index += 1) {
      const trigger = scoped.append({ chatId: 'chat-1', messageThreadId: null, tgMessageId: 1000 + index, direction: 'in', fromKind: 'user', fromUserId: '7',
        fromName: '阿离', fromUsername: 'ali', kind: 'text', text: `问题 ${index}`, tgDate: 1_700_000_000_000 + index * 1000, raw: {}, triggered: true, triggerReason: 'wakeword' });
      db.prepare(`INSERT INTO turns(id,key,chat_id,initiator_user_id,effective_role,trigger_message_id,trigger_reason,state,started_at,steps,model_calls,tool_calls,subagents,cost_usd)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(`turn-${index}`, 'chat:chat-1', 'chat-1', '7', 'trusted', trigger.id, 'wakeword', 'committed', 1_700_000_000_000 + index * 1000, 3, 2, 1, 0, 0.01);
      // 流式回复被切成多条 Telegram 消息时，归档里每条存的都是同一份全文——读出来不能重复 N 遍。
      for (const tgMessageId of [2000 + index * 2, 2001 + index * 2]) {
        scoped.append({ chatId: 'chat-1', messageThreadId: null, tgMessageId, direction: 'out', fromKind: 'bot', fromUserId: 'bot', fromName: '洛璃', fromUsername: 'luoli',
          kind: 'text', text: `回答 ${index}`, tgDate: 1_700_000_000_500 + index * 1000, raw: {}, triggered: false, turnId: `turn-${index}` });
      }
    }
    const first = await body<{ items: Array<{ id: string; prompt: string; reply: string }>; total: number; page: number }>(await app.request('/api/turns', { headers }));
    expect(first.total).toBe(25);
    expect(first.items).toHaveLength(20);
    expect(first.items[0]).toMatchObject({ id: 'turn-24', prompt: '问题 24', reply: '回答 24' });
    const second = await body<{ items: unknown[]; page: number }>(await app.request('/api/turns?page=2', { headers }));
    expect(second).toMatchObject({ page: 2 });
    expect(second.items).toHaveLength(5);
    closeDatabase(db);
  });

  it('reports the live enabled flag alongside the static tool policy', async () => {
    const { app, db, headers } = harness('tools-state');
    const tools = await body<Record<string, { minRole: string; enabled: boolean }>>(await app.request('/api/tools', { headers }));
    expect(tools.bash).toMatchObject({ minRole: 'trusted', enabled: false });
    expect(tools.read_file).toMatchObject({ enabled: true });
    closeDatabase(db);
  });

  it('bulk import changes the role of principals that already exist', async () => {
    const { app, db, principals, headers } = harness('bulk');
    principals.upsertSeen({ id: 'user:42', kind: 'user', tgId: '42', role: 'blocked', displayName: '老用户', username: null, chatType: null });
    const result = await body<{ count: number; created: number; updated: number }>(await app.request('/api/principals/bulk', { method: 'POST', headers, body: JSON.stringify({ ids: ['42', '43', '43'], role: 'trusted' }) }));
    expect(result).toEqual({ count: 2, created: 1, updated: 1 });
    expect(principals.roleOf('user', '42')).toBe('trusted');
    expect(principals.roleOf('user', '43')).toBe('trusted');
    // @username 与非法角色都是「导入成功但永远匹配不到」的来源，写入端要挡回去。
    expect((await app.request('/api/principals/bulk', { method: 'POST', headers, body: JSON.stringify({ ids: ['@someone'], role: 'trusted' }) })).status).toBe(400);
    expect((await app.request('/api/principals/bulk', { method: 'POST', headers, body: JSON.stringify({ ids: ['44'], role: 'admin' }) })).status).toBe(400);
    expect((await app.request('/api/principals/bulk', { method: 'POST', headers, body: JSON.stringify({ ids: [], role: 'trusted' }) })).status).toBe(400);
    closeDatabase(db);
  });

  it('persists edited sub agents through the config override layer', async () => {
    const { app, db, headers } = harness('agents');
    const definition = { name: 'research', description: '查资料', modelAlias: 'high', maxSteps: 6, minRole: 'trusted', tools: ['web_fetch'], resultMaxChars: 4000, instructions: '只做检索', injectMemory: false };
    expect((await app.request('/api/config', { method: 'PUT', headers, body: JSON.stringify({ 'agent.agents': [definition] }) })).status).toBe(200);
    const stored = db.prepare('SELECT value_json AS value FROM config_kv WHERE key=?').get('agent.agents') as { value: string };
    expect(JSON.parse(stored.value)).toEqual([definition]);
    // 缺 instructions 这类必填字段要在写入端就被 schema 挡掉，而不是等下次启动。
    expect((await app.request('/api/config', { method: 'PUT', headers, body: JSON.stringify({ 'agent.agents': [{ name: 'broken' }] }) })).status).toBe(400);
    closeDatabase(db);
  });
});
