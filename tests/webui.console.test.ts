import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ArchiveRepository, OperationsRepository, PrincipalRepository, closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { ContextEngine, DatabaseApprovalBroker, EventBus, LogSink, MaintenanceService, ProviderStore, Secrets, configSchema } from '@luoli/core';
import { createServer } from '@luoli/server';

function harness(name: string, extra: Record<string, unknown> = {}) {
  const path = `./data/${name}.test.db`;
  for (const suffix of ['', '-wal', '-shm', '-logs', '-logs-wal', '-logs-shm']) rmSync(`${path}${suffix}`, { force: true });
  // 日志目录按用例分开：对话详情要解引用 logs/<day>/blobs/*.json，上一次跑剩下的 blob 会串进来。
  const db = openDatabase(path);
  migrateDatabase(db);
  const config = configSchema.parse({ access: { bootstrapOwnerId: '1' }, webui: { passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$invalid$invalid' }, tools: { overrides: { bash: { enabled: false } } }, ...extra });
  const operations = new OperationsRepository(db);
  const events = new EventBus();
  const log = new LogSink(operations, [], { console: 'off' });
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

  /**
   * 守两件事（docs/05 §2.2）。其一：`GET /api/principals` 不再合成 `effectiveRole` —— 私聊只占
   * `user:X` 一行，那一行的角色就是有效角色；群那行是下限而非有效角色，成员各不相同，编一个
   * 确定值出来比不给更坏。其二：写入端拒收两类在全库零效果的 chat 主体（正数 id = 私聊、
   * chat 行的 owner 档），否则界面能改出一个改了不生效的角色。
   * 迁移 0015 负责清掉旧库里的私聊 `chat:` 行，读端不做过滤 —— 这里就用一行残留断言这一点。
   */
  it('主体表原样返回，不再合成有效角色；chat 主体拒收正数 id 与 owner', async () => {
    const { app, db, principals, headers } = harness('principals-effective');
    principals.upsertSeen({ id: 'user:7', kind: 'user', tgId: '7', role: 'limited', displayName: '某人', username: null, chatType: null });
    // 旧库残留的私聊 chat 行：API 照旧原样返回它，只是不再据此算什么。
    principals.upsertSeen({ id: 'chat:7', kind: 'chat', tgId: '7', role: 'trusted', displayName: '某人', username: null, chatType: 'private' });
    principals.upsertSeen({ id: 'chat:-100', kind: 'chat', tgId: '-100', role: 'trusted', displayName: '某群', username: null, chatType: 'supergroup' });
    const rows = await body<Array<{ id: string; role: string; effectiveRole?: unknown }>>(await app.request('/api/principals', { headers }));
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get('user:7')).toMatchObject({ role: 'limited' });
    expect(byId.get('chat:7')).toMatchObject({ role: 'trusted' });
    expect(byId.get('chat:-100')).toMatchObject({ role: 'trusted' });
    for (const row of rows) expect(row).not.toHaveProperty('effectiveRole');
    // 群里的有效角色封顶 trusted，chat 行的 owner 在全库零效果。
    expect((await app.request('/api/principals/chat:-100', { method: 'PATCH', headers, body: JSON.stringify({ role: 'owner' }) })).status).toBe(400);
    expect((await app.request('/api/principals/roles', { method: 'POST', headers, body: JSON.stringify({ ids: ['chat:-100'], role: 'owner' }) })).status).toBe(400);
    // 正数 id 是私聊，不占 chat 行 —— 建出来只是一行永远不参与判定的死数据。
    expect((await app.request('/api/principals/bulk', { method: 'POST', headers, body: JSON.stringify({ kind: 'chat', ids: ['7'], role: 'trusted' }) })).status).toBe(400);
    expect((await app.request('/api/principals/chat:7', { method: 'PATCH', headers, body: JSON.stringify({ role: 'trusted' }) })).status).toBe(400);
    // user 主体的 owner 与群主体的 trusted 照旧放行。
    expect((await app.request('/api/principals/user:7', { method: 'PATCH', headers, body: JSON.stringify({ role: 'owner' }) })).status).toBe(200);
    expect((await app.request('/api/principals/bulk', { method: 'POST', headers, body: JSON.stringify({ kind: 'chat', ids: ['-1001'], role: 'trusted' }) })).status).toBe(200);
    expect(principals.roleOf('user', '7')).toBe('owner');
    closeDatabase(db);
  });

  it('serves the JSON that was actually sent upstream for one turn, blobs included', async () => {
    const { app, db, log, headers } = harness('turn-detail');
    db.prepare(`INSERT INTO turns(id,key,chat_id,initiator_user_id,effective_role,trigger_reason,state,started_at,finished_at,steps,model_calls,tool_calls,input_tokens,output_tokens,cost_usd)
      VALUES ('turn-x','chat:c1','c1','7','trusted','wakeword','committed',1000,3400,2,2,1,900,120,0.02)`).run();
    log.event({ level: 'info', kind: 'tool.call', summary: 'read_file', traceId: 'turn-x', data: { input: { path: 'a.md' } } });
    log.event({ level: 'info', kind: 'model.call', summary: 'openai/gpt', traceId: 'turn-x', durationMs: 1200, data: { request: { body: { model: 'gpt', input: 'hi' } } } });
    // 压过的载荷（默认阈值以上一律 zstd）读出侧要按 data_codec 解开 —— 不解的话详情里就没有请求体。
    log.event({ level: 'info', kind: 'model.call', summary: 'openai/gpt big', traceId: 'turn-x', data: { request: { body: { model: 'gpt', input: 'x'.repeat(4000) } } } });
    log.event({ level: 'info', kind: 'model.call', summary: 'openai/gpt huge', traceId: 'turn-x', data: { request: { body: { input: 'y'.repeat(200_000) } } } });
    log.event({ level: 'info', kind: 'model.call', summary: '别的轮次', traceId: 'turn-y', data: { request: { body: {} } } });
    interface DetailEvent { id: number; kind: string; text: string | null; bytes: number; truncated: boolean }
    const detail = await body<{ turn: { id: string; costUsd: number }; captureBodies: boolean; events: DetailEvent[] }>(await app.request('/api/turns/turn-x/detail', { headers }));
    expect(detail.turn).toMatchObject({ id: 'turn-x', costUsd: 0.02 });
    expect(detail.captureBodies).toBe(true);
    expect(detail.events.map((entry) => entry.kind)).toEqual(['tool.call', 'model.call', 'model.call', 'model.call']);
    expect(JSON.parse(detail.events[1]!.text!)).toMatchObject({ request: { body: { model: 'gpt', input: 'hi' } } });
    const big = detail.events[2]!;
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

  /**
   * 工具调用的**输入**此前在详情里根本不存在：`LogSink.span` 把开始时的 `{input}` 用结束时的
   * `{output}` 顶掉了（见 tests/log.span.test.ts）。那条修完之后新轮次有了，但老轮次的日志
   * 补不回来 —— 所以详情还要读 `context_messages` 的原始 parts，这条路不受
   * `logs.retentionDays` / `logs.captureBodies` 影响，且**降级过的行里参数也还在**。
   */
  it('recovers tool inputs from the raw context parts, elision flag and all', async () => {
    const { app, db, headers } = harness('turn-detail-parts');
    db.prepare(`INSERT INTO turns(id,key,chat_id,initiator_user_id,effective_role,trigger_reason,state,started_at,steps,model_calls,tool_calls,cost_usd)
      VALUES ('turn-p','chat:c1','c1','7','trusted','wakeword','committed',1000,1,1,1,0)`).run();
    const insert = db.prepare(`INSERT INTO context_messages(key,ordinal,id,turn_id,role,origin,prune_level,prune_applied,parts_json,text_preview,tokens,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    insert.run('chat:c1', 1, 'trigger:1', 'turn-p', 'user', 'trigger', 0, 0, JSON.stringify([{ type: 'text', text: '看下 a.md' }]), '看下 a.md', 5, 1000);
    insert.run('chat:c1', 2, 'call:c-1', 'turn-p', 'assistant', 'tool_call', 2, 0,
      JSON.stringify([{ type: 'tool-call', toolCallId: 'c-1', toolName: 'read_file', input: { path: 'a.md' } }]), 'read_file({"path":"a.md"})', 9, 1001);
    insert.run('chat:c1', 3, 'result:c-1', 'turn-p', 'tool', 'tool_result', 1, 1,
      JSON.stringify([{ type: 'tool-result', toolCallId: 'c-1', toolName: 'read_file', output: { type: 'json', value: { ok: true } } }]), 'read_file: {"ok":true}', 7, 1002);
    insert.run('chat:other', 9, 'call:x', 'turn-p', 'assistant', 'tool_call', 2, 0, JSON.stringify([{ type: 'tool-call', toolCallId: 'x', toolName: 'bash', input: {} }]), 'bash({})', 3, 1003);
    interface Part { ordinal: number; origin: string; pruneApplied: boolean; pruneLevel: number; text: string | null; textPreview: string | null }
    const detail = await body<{ contextMessages: Part[] }>(await app.request('/api/turns/turn-p/detail', { headers }));
    // 只取本轮本会话的：`key` 也进了 where，否则同名 turn_id 会把别的会话的 parts 带进来。
    expect(detail.contextMessages.map((entry) => entry.ordinal)).toEqual([1, 2, 3]);
    const call = detail.contextMessages.find((entry) => entry.origin === 'tool_call')!;
    expect(JSON.parse(call.text!)).toEqual([{ type: 'tool-call', toolCallId: 'c-1', toolName: 'read_file', input: { path: 'a.md' } }]);
    expect(call.textPreview).toBe('read_file({"path":"a.md"})');
    // prune_applied 的那条：模型看到的是占位符，但库里的原文必须原样出来（这是走列而不走
    // ContextRepository.messages() 的全部理由 —— 后者会跑 elidePart）。
    const result = detail.contextMessages.find((entry) => entry.pruneApplied)!;
    expect(result).toMatchObject({ origin: 'tool_result', pruneLevel: 1, pruneApplied: true });
    expect(JSON.parse(result.text!)).toEqual([{ type: 'tool-result', toolCallId: 'c-1', toolName: 'read_file', output: { type: 'json', value: { ok: true } } }]);
    closeDatabase(db);
  });

  it('serves one log event with its payload, and keeps the sibling log routes reachable', async () => {
    const { app, db, log, headers } = harness('log-detail');
    log.event({ level: 'warn', kind: 'tool.call', summary: 'bash', traceId: 'turn-z', chatId: 'c1', userId: '7', key: 'chat:c1', durationMs: 42,
      data: { input: { command: 'ls' }, error: 'exit 1' } });
    const plainId = log.event({ level: 'info', kind: 'system.start', summary: '启动' });
    const bigId = log.event({ level: 'info', kind: 'model.call', summary: 'big', data: { body: 'x'.repeat(4000) } });
    interface Detail { id: number; kind: string; level: string; traceId: string | null; chatId: string | null; key: string | null; durationMs: number | null; text: string | null; bytes: number }
    const first = await body<Detail>(await app.request('/api/logs/1', { headers }));
    expect(first).toMatchObject({ kind: 'tool.call', level: 'warn', traceId: 'turn-z', chatId: 'c1', key: 'chat:c1', durationMs: 42 });
    expect(JSON.parse(first.text!)).toEqual({ input: { command: 'ls' }, error: 'exit 1' });
    // 没有 trace、没有载荷的那些行以前点了什么都不发生；现在也要能取回来。
    const bare = await body<Detail>(await app.request(`/api/logs/${plainId}`, { headers }));
    expect(bare).toMatchObject({ kind: 'system.start', traceId: null, text: null, bytes: 0 });
    // 解码跟对话详情共用同一套语义：压过的行照样给出完整正文。
    const big = await body<Detail>(await app.request(`/api/logs/${bigId}`, { headers }));
    expect((JSON.parse(big.text!) as { body: string }).body).toHaveLength(4000);
    expect((await app.request('/api/logs/999999', { headers })).status).toBe(404);
    // `:id` 注册在 trace 之后，且非数字直接 404 —— 否则那一条会被 Number('trace')=NaN 吃掉。
    expect((await app.request('/api/logs/nope', { headers })).status).toBe(404);
    expect((await app.request('/api/logs/trace/turn-z', { headers })).status).toBe(200);
    // 列表只给摘要与载荷字节数：一条 model.call 的载荷实测均 29 KB、且没有上限，列表一次上千行。
    const list = await body<Array<Record<string, unknown>>>(await app.request('/api/logs', { headers }));
    expect(list.every((row) => !('data' in row) && !('data_codec' in row))).toBe(true);
    expect(list.find((row) => row.id === bigId)!.data_bytes).toBeGreaterThan(0);
    expect(list.find((row) => row.id === plainId)!.data_bytes).toBe(0);
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

  /**
   * 数组叶子整块落库、非法值在写入端就被 schema 挡掉。判据原先挂在 `agent.agents` 上，而
   * 子 agent 定义体系已整个删除 —— 换 `approval.rules` 继续守同一件事，并把「那个键真的没了」
   * 一并焊住：写不进去比留一个静默被丢弃的键安全（`config_kv` 里的每一行都会被 `loadConfig` 解析）。
   */
  it('persists array leaves through the config override layer and rejects the deleted agent keys', async () => {
    const { app, db, headers } = harness('array-leaves');
    const rules = [{ tool: 'bash', pattern: 'rm -rf', risk: 'high' }];
    expect((await app.request('/api/config', { method: 'PUT', headers, body: JSON.stringify({ 'approval.rules': rules }) })).status).toBe(200);
    const stored = db.prepare('SELECT value_json AS value FROM config_kv WHERE key=?').get('approval.rules') as { value: string };
    expect(JSON.parse(stored.value)).toEqual(rules);
    // 字段拼错要在写入端被挡掉，而不是等下次启动才发现审批规则不生效。
    expect((await app.request('/api/config', { method: 'PUT', headers, body: JSON.stringify({ 'approval.rules': [{ toool: 'bash' }] }) })).status).toBe(400);
    // 已删除的三个键：一个都不许落库。
    for (const key of ['agent.agents', 'agent.agentsDir', 'agent.maxDepth'])
      expect((await app.request('/api/config', { method: 'PUT', headers, body: JSON.stringify({ [key]: key === 'agent.maxDepth' ? 3 : [] }) })).status, key).toBe(400);
    expect(db.prepare("SELECT COUNT(*) FROM config_kv WHERE key LIKE 'agent.agents%' OR key='agent.maxDepth'").pluck().get()).toBe(0);
    closeDatabase(db);
  });
});
