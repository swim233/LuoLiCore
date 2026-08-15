import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ArchiveRepository, OperationsRepository, PrincipalRepository, closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { ContextEngine, DatabaseApprovalBroker, EventBus, LogSink, MaintenanceService, ProviderStore, Secrets, configSchema } from '@luoli/core';
import { createServer } from '@luoli/server';

function harness(name: string, extra: Record<string, unknown> = {}) {
  const path = `./data/${name}.test.db`;
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
  // 日志目录按用例分开：对话详情要解引用 logs/<day>/blobs/*.json，上一次跑剩下的 blob 会串进来。
  const logDir = `./data/${name}-logs`;
  rmSync(logDir, { force: true, recursive: true });
  const db = openDatabase(path);
  migrateDatabase(db);
  const config = configSchema.parse({ access: { bootstrapOwnerId: '1' }, webui: { passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$invalid$invalid' }, tools: { overrides: { bash: { enabled: false } } }, logs: { dir: logDir }, ...extra });
  const operations = new OperationsRepository(db);
  const events = new EventBus();
  const log = new LogSink(operations, logDir, [], { bodyMaxBytes: config.logs.bodyMaxBytes });
  const archive = new ArchiveRepository(db);
  const principals = new PrincipalRepository(db);
  const app = createServer({ config, db, operations, principals, archive, context: new ContextEngine(db, archive),
    providers: new ProviderStore(db, new Secrets('x'.repeat(32))), approvals: new DatabaseApprovalBroker(db, config, events, log),
    maintenance: new MaintenanceService(db, path, 2, 30), events, log, configSchema: {}, startedAt: Date.now(), setup: undefined });
  const session = operations.createSession(1);
  return { app, db, principals, log, headers: { cookie: `luoli_sid=${session.id}`, 'x-csrf-token': session.csrf, 'content-type': 'application/json' } };
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

  it('serves the JSON that was actually sent upstream for one turn, blobs included', async () => {
    const { app, db, log, headers } = harness('turn-detail', { logs: { dir: './data/turn-detail-logs', bodyMaxBytes: 512 } });
    db.prepare(`INSERT INTO turns(id,key,chat_id,initiator_user_id,effective_role,trigger_reason,state,started_at,finished_at,steps,model_calls,tool_calls,input_tokens,output_tokens,cost_usd)
      VALUES ('turn-x','chat:c1','c1','7','trusted','wakeword','committed',1000,3400,2,2,1,900,120,0.02)`).run();
    log.event({ level: 'info', kind: 'tool.call', summary: 'read_file', traceId: 'turn-x', data: { input: { path: 'a.md' } } });
    log.event({ level: 'info', kind: 'model.call', summary: 'openai/gpt', traceId: 'turn-x', durationMs: 1200, data: { request: { body: { model: 'gpt', input: 'hi' } } } });
    // 超过 bodyMaxBytes 的 data 被 LogSink 挪进 blobs/，库里只剩 {fileRef,bytes} —— 不解引用的话详情里就没有请求体。
    log.event({ level: 'info', kind: 'model.call', summary: 'openai/gpt big', traceId: 'turn-x', data: { request: { body: { model: 'gpt', input: 'x'.repeat(4000) } } } });
    log.event({ level: 'info', kind: 'model.call', summary: 'openai/gpt huge', traceId: 'turn-x', data: { request: { body: { input: 'y'.repeat(200_000) } } } });
    log.event({ level: 'info', kind: 'model.call', summary: '别的轮次', traceId: 'turn-y', data: { request: { body: {} } } });
    interface DetailEvent { id: number; kind: string; text: string | null; bytes: number; truncated: boolean; fileRef: string | null }
    const detail = await body<{ turn: { id: string; costUsd: number }; captureBodies: boolean; events: DetailEvent[] }>(await app.request('/api/turns/turn-x/detail', { headers }));
    expect(detail.turn).toMatchObject({ id: 'turn-x', costUsd: 0.02 });
    expect(detail.captureBodies).toBe(true);
    expect(detail.events.map((entry) => entry.kind)).toEqual(['tool.call', 'model.call', 'model.call', 'model.call']);
    expect(JSON.parse(detail.events[1]!.text!)).toMatchObject({ request: { body: { model: 'gpt', input: 'hi' } } });
    const big = detail.events[2]!;
    expect(big.fileRef).toMatch(/blobs\//);
    expect((JSON.parse(big.text!) as { request: { body: { input: string } } }).request.body.input).toHaveLength(4000);
    // 20 万字符的请求体不能整段塞给浏览器：截断并标出来，完整那份走原始端点。
    const huge = detail.events[3]!;
    expect(huge.truncated).toBe(true);
    expect(huge.text).toHaveLength(120_000);
    expect(huge.bytes).toBeGreaterThan(200_000);
    // 界面上的 JSON 会被截断，复制/下载要拿到完整那一份。
    const raw = await app.request(`/api/logs/${big.id}/data`, { headers });
    expect(raw.headers.get('content-type')).toContain('application/json');
    expect((JSON.parse(await raw.text()) as { request: { body: { input: string } } }).request.body.input).toHaveLength(4000);
    expect((await app.request('/api/turns/nope/detail', { headers })).status).toBe(404);
    closeDatabase(db);
  });

  it('changes the role of every checked principal and reports the ones it could not find', async () => {
    const { app, db, principals, headers } = harness('roles');
    principals.upsertSeen({ id: 'user:10', kind: 'user', tgId: '10', role: 'limited', displayName: '甲', username: 'jia', chatType: null });
    principals.upsertSeen({ id: 'chat:-100', kind: 'chat', tgId: '-100', role: 'limited', displayName: '某群', username: null, chatType: 'supergroup' });
    const result = await body<{ count: number; changed: number; missing: string[] }>(await app.request('/api/principals/roles', { method: 'POST', headers, body: JSON.stringify({ ids: ['user:10', 'chat:-100', 'user:999'], role: 'blocked' }) }));
    expect(result).toEqual({ count: 3, changed: 2, missing: ['user:999'] });
    expect(principals.roleOf('user', '10')).toBe('blocked');
    expect(principals.roleOf('chat', '-100')).toBe('blocked');
    // 勾选来自表格，不该在这里新建主体：找不到就报回去。
    expect(principals.roleOf('user', '999')).toBeNull();
    expect((await app.request('/api/principals/roles', { method: 'POST', headers, body: JSON.stringify({ ids: ['user:10'], role: 'admin' }) })).status).toBe(400);
    expect((await app.request('/api/principals/roles', { method: 'POST', headers, body: JSON.stringify({ ids: [], role: 'blocked' }) })).status).toBe(400);
    closeDatabase(db);
  });

  it('keeps the display name Telegram gave us when bootstrap and bulk import touch the same principal', async () => {
    const { app, db, principals, headers } = harness('owner-name');
    principals.ensureOwner('1');
    principals.upsertSeen({ id: 'user:1', kind: 'user', tgId: '1', role: 'owner', displayName: '萝莉赛高', username: 'TheSw1m', chatType: null });
    // 每次启动都跑一遍 bootstrap：以前它走 upsertSeen，占位的 'Owner'/null 会把真名冲掉，主体页重启一次就变回 Owner。
    principals.ensureOwner('1');
    await app.request('/api/principals/bulk', { method: 'POST', headers, body: JSON.stringify({ ids: ['1'], role: 'owner' }) });
    const owner = principals.list().find((entry) => entry.id === 'user:1');
    expect(owner).toMatchObject({ role: 'owner', displayName: '萝莉赛高', username: 'TheSw1m' });
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
