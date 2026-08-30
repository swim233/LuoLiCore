import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ArchiveRepository, OperationsRepository, PrincipalRepository, SandboxContainerRepository, closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { ConfigStore, ContainerManager, ContextEngine, DatabaseApprovalBroker, EventBus, LogSink, MaintenanceService, McpManager, ModelRegistry, ProviderStore, Sandbox, Secrets, SkillLoader, configSchema } from '@luoli/core';
import { createServer, type ServerDependencies } from '@luoli/server';
import { zipFixture } from './fixtures/zip.js';
import { logPayloads, logRows } from './support/logs.js';

function harness(extend: (base: { db: ReturnType<typeof openDatabase>; config: ConfigStore; events: EventBus; log: LogSink }) => Partial<ServerDependencies> = () => ({})) {
  const path = './data/api-contract.test.db'; for (const suffix of ['', '-wal', '-shm', '-logs', '-logs-wal', '-logs-shm']) rmSync(`${path}${suffix}`, { force: true });
  const db = openDatabase(path); migrateDatabase(db);
  const config = new ConfigStore(configSchema.parse({ access: { bootstrapOwnerId: '1' }, webui: { passwordHash: 'hash' } }));
  const operations = new OperationsRepository(db); const events = new EventBus(); const log = new LogSink(operations); const archive = new ArchiveRepository(db);
  const app = createServer({ config, db, operations, principals: new PrincipalRepository(db), archive, context: new ContextEngine(db, archive), providers: new ProviderStore(db, new Secrets('x'.repeat(32))), approvals: new DatabaseApprovalBroker(db, () => config.snapshot(), events, log), maintenance: new MaintenanceService(db, path, 2, 30), events, log, configSchema: {}, startedAt: Date.now(), setup: undefined, ...extend({ db, config, events, log }) });
  const session = operations.createSession(1); const headers = { cookie: `luoli_sid=${session.id}`, 'x-csrf-token': session.csrf, 'content-type': 'application/json' };
  return { app, db, config, headers };
}

describe('documented API surface', () => {
  it('serves read endpoints and audits every authenticated write', async () => {
    const { app, db, headers } = harness(); const cookie = { cookie: headers.cookie };
    // 只断言 200 会形成假通过：未注册的 /api/* 会落入 SPA fallback，得到 200 与 index.html。
    // `GET /api/quota` 曾因此长期通过，而该端点实际并不存在。必须连同 JSON 信封一起断言。
    for (const path of ['/api/dashboard','/api/chats','/api/messages','/api/turns','/api/turns/active','/api/providers','/api/models','/api/aliases','/api/principals','/api/tools','/api/sandbox','/api/skills','/api/plugins','/api/mcp','/api/agents','/api/logs','/api/usage','/api/quota','/api/tasks','/api/approvals','/api/config','/api/config/schema','/api/config/revisions']) {
      const read = await app.request(path, { headers: cookie });
      expect(read.status, path).toBe(200);
      expect(read.headers.get('content-type'), path).toMatch(/application\/json/);
      expect((await read.json() as { ok: boolean }).ok, path).toBe(true);
    }
    const response = await app.request('/api/quota/reset', { method: 'POST', headers }); expect(response.status).toBe(200);
    expect(db.prepare("SELECT COUNT(*) FROM log_events WHERE kind='webui.action' AND summary='POST /api/quota/reset'").pluck().get()).toBe(1);
    closeDatabase(db);
  });

  /**
   * 分页信封属于契约，而上面那条循环只断言 `ok:true`：某个端点从 `{items,total,page,size}` 退回
   * 裸数组，或 `total` 变成本页条数，它都无法拦截。`/api/approvals` 与 `/api/tasks` 刚从
   * 固定 `LIMIT` 加裸数组改为服务端分页，缺少这条守卫时该破坏性改造没有任何回归防线。
   *
   * `pending` 单独固定：它是全表 `COUNT(*) WHERE state='pending'`，左侧导航的角标读取的正是它
   * （`AC-WEB-049` 要求无需切换到任务页即可看到）。若按当前页统计，翻到第 2 页角标即归零，
   * 这是整次分页改造中唯一会静默造成功能退化的位置。
   */
  it('四条分页端点信封一致、?page= 真的翻页，approvals 的 pending 是全表数', async () => {
    const { app, db, headers } = harness();
    const cookie = { cookie: headers.cookie };
    const now = Date.now();
    const scoped = new ArchiveRepository(db).scope('chat');
    for (let index = 0; index < 3; index += 1) {
      scoped.append({ chatId: 'chat', messageThreadId: null, tgMessageId: 100 + index, direction: 'in', fromKind: 'user',
        fromUserId: 'user', fromName: 'User', fromUsername: null, kind: 'text', text: `第 ${index} 条`, tgDate: now + index, raw: {}, triggered: false, triggerReason: null });
      db.prepare("INSERT INTO turns(id,key,chat_id,initiator_user_id,effective_role,state,queued_at,started_at) VALUES (?,'chat:chat','chat','user','trusted','committed',?,?)").run(`turn-${index}`, now + index, now + index);
      db.prepare("INSERT INTO approvals(id,turn_id,chat_id,requester_user_id,tool_name,input_json,risk,state,requested_at,expires_at) VALUES (?,?,'chat','user','bash','{}','high',?,?,?)")
        .run(`appr-${index}`, `turn-${index}`, index === 2 ? 'approved' : 'pending', now + index, now + 3_600_000);
      db.prepare("INSERT INTO tasks(id,turn_id,chat_id,user_id,title,state,created_at,updated_at) VALUES (?,?,'chat','user',?,'done',?,?)")
        .run(`task-${index}`, `turn-${index}`, `任务 ${index}`, now + index, now + index);
    }
    const envelope = async (path: string): Promise<Record<string, unknown>> =>
      ((await (await app.request(path, { headers: cookie })).json()) as { data: Record<string, unknown> }).data;
    for (const path of ['/api/messages', '/api/turns', '/api/approvals', '/api/tasks']) {
      const first = await envelope(`${path}?page=1&size=1`);
      expect(Object.keys(first).sort(), path).toEqual(path === '/api/approvals' ? ['items', 'page', 'pending', 'size', 'total'] : ['items', 'page', 'size', 'total']);
      expect(first, path).toMatchObject({ total: 3, page: 1, size: 1 });
      expect(first.items as unknown[], path).toHaveLength(1);
      const second = await envelope(`${path}?page=2&size=1`);
      expect(second, path).toMatchObject({ total: 3, page: 2, size: 1 });
      // 确实使用了 SQL 的 OFFSET：先取一大批再在内存中切分的写法，第 2 页要么重复要么恒为空（docs/22 · I-01）。
      expect((second.items as Array<{ id: unknown }>)[0]?.id, path).not.toEqual((first.items as Array<{ id: unknown }>)[0]?.id);
    }
    // 待办项排在最前，且翻页不改变角标。
    const listed = await envelope('/api/approvals?page=1&size=3');
    expect((listed.items as Array<{ state: string }>).map((row) => row.state)).toEqual(['pending', 'pending', 'approved']);
    for (const pageNumber of [1, 2, 3]) expect((await envelope(`/api/approvals?page=${pageNumber}&size=1`)).pending, `page ${pageNumber}`).toBe(2);
    // 过期扫描置于 COUNT 与 SELECT 之前：若夹在两者之间，total 与 pending 统计的是扫描前的状态，
    // 而页内容是扫描后的状态，两个数值不一致且无法解释。
    db.prepare("INSERT INTO approvals(id,turn_id,chat_id,requester_user_id,tool_name,input_json,risk,state,requested_at,expires_at) VALUES ('appr-stale','turn-0','chat','user','bash','{}','high','pending',?,?)")
      .run(now - 10_000, now - 1_000);
    const scanned = await envelope('/api/approvals?page=1&size=10');
    expect(scanned).toMatchObject({ total: 4, pending: 2 });
    expect((scanned.items as Array<{ state: string }>).filter((row) => row.state === 'pending')).toHaveLength(2);
    expect(db.prepare("SELECT state FROM approvals WHERE id='appr-stale'").pluck().get()).toBe('expired');
    closeDatabase(db);
  });

  /**
   * `?size=abc` 曾返回 500 而非 400：`Number('abc')` 为 `NaN`，而 `NaN` 作为 better-sqlite3 的绑定参数
   * 不会被当作 0，而是让整条查询抛出 `TypeError: datatype mismatch`。四个端点原先各自写
   * `Math.min(max, Math.max(1, Number(...)))`，都无法拦截，因为 `Math.max(1, NaN)` 仍返回 `NaN`。
   *
   * 共用 `pageParams` 之后，非法输入一律回退到各端点自身的默认值与上限（这是健壮性修复而非参数调整：
   * 四个端点的默认值与上限在本用例中逐一固定，把 `/api/turns` 的 20/100 改成 50/200 会导致失败）。
   */
  it('脏 ?page=/?size= 退化成各端点的默认值与上限，而不是 500', async () => {
    const { app, db, headers } = harness();
    const cookie = { cookie: headers.cookie };
    const now = Date.now();
    new ArchiveRepository(db).scope('chat').append({ chatId: 'chat', messageThreadId: null, tgMessageId: 1, direction: 'in', fromKind: 'user',
      fromUserId: 'user', fromName: 'User', fromUsername: null, kind: 'text', text: 'hello', tgDate: now, raw: {}, triggered: false, triggerReason: null });
    db.prepare("INSERT INTO turns(id,key,chat_id,initiator_user_id,effective_role,state,queued_at,started_at) VALUES ('turn-x','chat:chat','chat','user','trusted','committed',?,?)").run(now, now);
    db.prepare("INSERT INTO approvals(id,turn_id,chat_id,requester_user_id,tool_name,input_json,risk,state,requested_at,expires_at) VALUES ('appr-x','turn-x','chat','user','bash','{}','high','pending',?,?)")
      .run(now, now + 3_600_000);
    db.prepare("INSERT INTO tasks(id,turn_id,chat_id,user_id,title,state,created_at,updated_at) VALUES ('task-x','turn-x','chat','user','任务','done',?,?)").run(now, now);
    for (const [path, defaultSize, maxSize] of [['/api/messages', 50, 200], ['/api/turns', 20, 100], ['/api/approvals', 50, 200], ['/api/tasks', 50, 200]] as const) {
      for (const [query, expected] of [['size=abc&page=xyz', defaultSize], ['size=-1', defaultSize], ['size=0', defaultSize],
        ['size=1.5', defaultSize], ['size=', defaultSize], ['page=0', defaultSize], ['size=99999', maxSize]] as const) {
        const label = `${path}?${query}`;
        const response = await app.request(`${path}?${query}`, { headers: cookie });
        expect(response.status, label).toBe(200);
        const body = await response.json() as { ok: boolean; data: { page: number; size: number; items: unknown[] } };
        expect(body.ok, label).toBe(true);
        expect(body.data.size, label).toBe(expected);
        // `page` 同样不能为 NaN：它用于计算 OFFSET，非法值或缺省都回退到第 1 页。
        expect(body.data.page, label).toBe(1);
        expect(body.data.items, label).toHaveLength(1);
      }
    }
    // 搜索分支不使用 LIMIT/OFFSET，但 `adminSearchAll(query, page*size)` 的上限同样是绑定参数。
    const searched = await app.request('/api/messages?q=hello&size=abc', { headers: cookie });
    expect(searched.status).toBe(200);
    expect(((await searched.json()) as { data: { page: number; size: number } }).data).toMatchObject({ page: 1, size: 50 });
    closeDatabase(db);
  });

  /**
   * `tasks` 表的 `progress_json` 与 `result_summary` 运行时持续写入，界面上从未展示，行也无法删除
   * （docs/21 §8）。本条固定三件事：列表不携带进度、详情通过 join 得出执行步数与所属 agent，
   * 以及删除的是记录而非取消通道：不存在 `POST /api/tasks/:id/cancel`，因此 running 一律返回 409。
   */
  it('任务详情 join 出轮次与子 agent；列表不带进度，running 的记录删不掉', async () => {
    const { app, db, headers } = harness();
    const cookie = { cookie: headers.cookie };
    const now = Date.now();
    const principals = new PrincipalRepository(db);
    principals.upsertSeen({ id: 'chat:-1001', kind: 'chat', tgId: '-1001', role: 'trusted', displayName: '隆福饭搭子', username: null, chatType: 'supergroup' });
    principals.upsertSeen({ id: 'user:9', kind: 'user', tgId: '9', role: 'owner', displayName: '阿离', username: 'ali', chatType: null });
    db.prepare("INSERT INTO turns(id,key,chat_id,initiator_user_id,effective_role,state,queued_at,steps,tool_calls,cost_usd) VALUES ('turn-t','chat:-1001','-1001','9','owner','running',?,4,2,0.5)").run(now);
    db.prepare("INSERT INTO agent_runs(id,turn_id,depth,kind,agent_name,model_alias,effective_role,state,started_at) VALUES ('run-t','turn-t',1,'sub','researcher','sub','owner','running',?)").run(now);
    db.prepare("INSERT INTO tasks(id,turn_id,agent_run_id,chat_id,user_id,title,state,progress_json,created_at,updated_at) VALUES ('task-run','turn-t','run-t','-1001','9','查资料','running',?,?,?)")
      .run(JSON.stringify({ step: 3, note: '读第 2 页' }), now, now);
    db.prepare("INSERT INTO tasks(id,turn_id,chat_id,user_id,title,state,result_summary,created_at,updated_at,finished_at) VALUES ('task-done','turn-t','-1001','9','写摘要','done','写完了',?,?,?)")
      .run(now - 1000, now - 1000, now);
    const listed = ((await (await app.request('/api/tasks', { headers: cookie })).json()) as { data: { items: Array<Record<string, unknown>> } }).data;
    // 运行中的排在最前，那几条才是需要关注的。
    expect(listed.items.map((row) => row.id)).toEqual(['task-run', 'task-done']);
    // 单帧进度可达数 KB，而列表只显示标题与状态（与 `GET /api/logs` 不下发 data_json 同理）。
    expect(Object.keys(listed.items[0]!)).not.toContain('progress_json');
    // 仅凭 chat_id 无法辨别是哪个群：显示名由服务端补全，前端不实现第二份反查规则（docs/09 §3.11）。
    expect(listed.items[0]).toMatchObject({ title: '查资料', state: 'running', chatLabel: '隆福饭搭子', userLabel: '阿离 (@ali)' });

    const detail = ((await (await app.request('/api/tasks/task-run', { headers: cookie })).json()) as { data: Record<string, unknown> }).data;
    expect(detail).toMatchObject({ id: 'task-run', progress: { step: 3, note: '读第 2 页' },
      turn: { state: 'running', steps: 4, toolCalls: 2, costUsd: 0.5, error: null },
      agentRun: { agentName: 'researcher', modelAlias: 'sub', state: 'running', resultSummary: null } });
    // 解析后的那一份即全部内容：原始 JSON 串不再重复下发。
    expect(detail.progress_json).toBeUndefined();
    expect((await app.request('/api/tasks/nope', { headers: cookie })).status).toBe(404);

    const running = await app.request('/api/tasks/task-run', { method: 'DELETE', headers });
    expect(running.status).toBe(409);
    expect((await running.json() as { error: { code: string } }).error.code).toBe('task_running');
    expect((await app.request('/api/tasks/task-done', { method: 'DELETE', headers })).status).toBe(200);
    expect(db.prepare('SELECT COUNT(*) FROM tasks').pluck().get()).toBe(1);
    // 未删除任何内容时不返回 200，口径与 `DELETE /api/custom-tools/:name` 一致。
    expect((await app.request('/api/tasks/nope', { method: 'DELETE', headers })).status).toBe(404);
    closeDatabase(db);
  });

  /**
   * 持久容器的三个端点（docs/09 §3.7）。未装配运行时时返回 `not_implemented` 而非空列表：
   * 无法读取与当前没有容器对运维而言是两回事（docs/16 §5 摘除比伪造安全），
   * 面板正是依据这一标志决定显示该部署未装配还是当前没有容器。
   */
  it('container endpoints tell "not wired" apart from "none", and list carries chat labels', async () => {
    const bare = harness();
    const missing = await bare.app.request('/api/containers', { headers: { cookie: bare.headers.cookie } });
    expect(missing.status).toBe(500);
    expect((await missing.json() as { error: { code: string } }).error.code).toBe('not_implemented');
    closeDatabase(bare.db);

    const { app, db, config, headers } = harness(({ db: database, config: store }) => {
      const sandbox = new Sandbox(() => ({ ...store.snapshot().sandbox, defaultTimeoutMs: 1000, maxTimeoutMs: 1000, maxOutputBytes: 1024 }));
      sandbox.bindContainers(new ContainerManager(database, new SandboxContainerRepository(database), () => ({
        dockerBin: 'docker', image: 'i', memoryMb: 512, cpus: 1, pidsLimit: 128, readOnlyRoot: true, tmpfsMb: 64,
        maxOutputBytes: 1024, persistent: store.snapshot().sandbox.persistent })));
      return { sandbox };
    });
    config.replace(configSchema.parse({ access: { bootstrapOwnerId: '1' }, webui: { passwordHash: 'hash' },
      sandbox: { persistent: { enabled: true } } }), ['sandbox.persistent.enabled']);
    new PrincipalRepository(db).upsertSeen({ id: 'chat:-1001', kind: 'chat', tgId: '-1001', role: 'trusted', displayName: '隆福饭搭子', username: null, chatType: 'supergroup' });
    new SandboxContainerRepository(db).create({ chatId: '-1001', name: 'luoli-box-n1001', containerId: null, image: 'i', specHash: 'h',
      hasSetsid: true, expiresAt: Date.now() + 3_600_000, hardExpiresAt: null });
    const listed = await app.request('/api/containers', { headers: { cookie: headers.cookie } });
    expect(listed.status).toBe(200);
    const payload = (await listed.json() as { data: { enabled: boolean; used: number; max: number; containers: Array<{ chatLabel: string; pinned: boolean }> } }).data;
    expect(payload).toMatchObject({ enabled: true, used: 1 });
    // 会话名通过 principals join 得出：面板上只显示 chatId 时运维无法辨别是哪个群。
    expect(payload.containers[0]).toMatchObject({ chatLabel: '隆福饭搭子', pinned: false });

    // 钉住走 keep，且仅豁免闲置回收：此处没有绝对上限，因此 hardExpiresAt 仍为 null。
    const kept = await app.request('/api/containers/-1001/keep', { method: 'POST', headers, body: JSON.stringify({ pin: true }) });
    expect(kept.status).toBe(200);
    expect((await kept.json() as { data: { pinned: boolean; hardExpiresAt: number | null } }).data).toMatchObject({ pinned: true, hardExpiresAt: null });
    const absent = await app.request('/api/containers/-9999/keep', { method: 'POST', headers, body: JSON.stringify({ pin: true }) });
    expect(absent.status).toBe(404);
    expect((await absent.json() as { error: { code: string } }).error.code).toBe('container_not_found');
    // 写操作照常记入审计流水。
    expect(db.prepare("SELECT COUNT(*) FROM log_events WHERE kind='webui.action' AND summary LIKE 'POST /api/containers%'").pluck().get()).toBe(2);
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

  // 图片与文件此前在管理端完全不可见：消息行不携带 attachment id（docs/21 · G-API-08）。
  it('carries attachment metadata on message rows and only inlines raster images', async () => {
    const { app, db, headers } = harness();
    const cookie = { cookie: headers.cookie };
    mkdirSync('./data/files/attachment-test', { recursive: true });
    const png = './data/files/attachment-test/shot.png';
    writeFileSync(png, Buffer.from('89504e470d0a1a0a', 'hex'));
    const svg = './data/files/attachment-test/logo.svg';
    writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const message = new ArchiveRepository(db).scope('chat').append({ chatId: 'chat', messageThreadId: null, tgMessageId: 7, direction: 'in', fromKind: 'user',
      fromUserId: 'user', fromName: 'User', fromUsername: null, kind: 'photo', text: null, tgDate: Date.now(), raw: {}, triggered: false, triggerReason: null });
    const insert = db.prepare(`INSERT INTO attachments(id,message_id,chat_id,kind,tg_file_id,tg_file_unique_id,file_name,mime,size_bytes,width,height,duration_sec,local_path,download_state,extract_state,created_at)
      VALUES (@id,@messageId,'chat',@kind,@id,@id,@name,@mime,8,10,10,NULL,@path,'done','skipped',@now)`);
    insert.run({ id: 'att-png', messageId: message.id, kind: 'photo', name: 'shot.png', mime: 'image/png', path: png, now: Date.now() });
    insert.run({ id: 'att-svg', messageId: message.id, kind: 'document', name: 'logo.svg', mime: 'image/svg+xml', path: svg, now: Date.now() });
    const listed = await app.request('/api/messages', { headers: cookie });
    const body = await listed.text();
    const row = (JSON.parse(body) as { data: { items: Array<{ id: number; attachments: Array<Record<string, unknown>> }> } }).data.items.find((item) => item.id === message.id);
    expect(row?.attachments).toHaveLength(2);
    expect(row?.attachments[0]).toMatchObject({ id: 'att-png', kind: 'photo', mime: 'image/png', fileName: 'shot.png', downloadState: 'done', hasLocal: 1 });
    // 磁盘路径对界面没有用途，泄漏出去只会暴露部署布局。
    expect(body).not.toContain('attachment-test/shot.png');
    const download = await app.request('/api/files/att-png', { headers: cookie });
    expect(download.headers.get('content-disposition')).toContain('attachment');
    expect((await app.request('/api/files/att-png?inline=1', { headers: cookie })).headers.get('content-disposition')).toBe('inline');
    // SVG 可携带脚本：同源内联它等于把用户上传的内容变成本站脚本，白名单之外一律按附件下载处理。
    expect((await app.request('/api/files/att-svg?inline=1', { headers: cookie })).headers.get('content-disposition')).toContain('attachment');
    expect((await app.request('/api/files/missing', { headers: cookie })).status).toBe(404);
    rmSync('./data/files/attachment-test', { recursive: true, force: true });
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
    expect(db.prepare("SELECT settings_json FROM model_aliases WHERE alias='main'").pluck().get()).toBe(JSON.stringify({ temperature: 0.2 }));
    // 空链、非法别名名、白名单外的采样参数都要在写入前拦截，别名表中不应出现存在但不可用的行。
    expect((await app.request('/api/aliases/main', { method: 'PUT', headers, body: JSON.stringify({ modelIds: [] }) })).status).toBe(400);
    expect((await app.request('/api/aliases/%E4%B8%BB%E6%A8%A1%E5%9E%8B', { method: 'PUT', headers, body: JSON.stringify({ modelIds: [modelId] }) })).status).toBe(400);
    const badSettings = await app.request('/api/aliases/main', { method: 'PUT', headers, body: JSON.stringify({ modelIds: [modelId], settings: { temperature: 9, wat: 1 } }) });
    expect(badSettings.status).toBe(400);
    expect((await badSettings.json() as { error: { message: string } }).error.message).toContain('settings');
    expect((await app.request('/api/aliases/main', { method: 'PUT', headers, body: JSON.stringify({ modelIds: [modelId], settings: {} }) })).status).toBe(200);
    expect(db.prepare("SELECT settings_json FROM model_aliases WHERE alias='main'").pluck().get()).toBeNull();
    expect((await app.request('/api/aliases/main', { method: 'DELETE', headers })).status).toBe(200);
    expect((await app.request('/api/aliases/main', { method: 'DELETE', headers })).status).toBe(404);
    expect(db.prepare("SELECT COUNT(*) FROM model_aliases WHERE alias='main'").pluck().get()).toBe(0);
    closeDatabase(db);
  });

  /**
   * 人工标记模型的看图能力（docs/21 §10）。`capabilities_json` 按模型名从 models.dev 获取，
   * 当中转站沿用官方模型名却不实际转发图片时，该 `vision:true` 会让含图轮次不切换到 `vision` 别名，
   * 图片留在一个无法读取它的模型上（实测 `logs/2026-08-19`：该网关的 grok-4.5 接收 image_url、
   * 返回 200、usage 中没有 image_tokens，四次全为推测；同一家的 grok-4.3 正常）。
   *
   * 本断言链要求界面标记后运行时确实改变路由，因此它使用真实的 `ModelRegistry` 重新计算，
   * 而不是只检查数据库中的那行 JSON。
   */
  it('marks a relayed model as blind and the runtime registry follows', async () => {
    const { app, db, headers } = harness();
    const now = Date.now();
    db.prepare("INSERT INTO providers(id,name,kind,base_url,enabled,created_at,updated_at) VALUES('p','relay','openai-compatible','http://127.0.0.1:9/v1',1,?,?)").run(now, now);
    // 从目录获取的那份为 vision=true，而该网关实际不转发图片。
    db.prepare(`INSERT INTO models(id,provider_id,model_id,context_window,max_output,capabilities_json,enabled,sort,created_at,updated_at)
      VALUES('m','p','grok-4.5',128000,8192,'{"vision":true,"tools":true,"catalog":{"source":"models.dev","match":"official","priceSource":null}}',1,0,?,?)`).run(now, now);
    db.prepare('INSERT INTO model_aliases(alias,model_ids_json,updated_at) VALUES (?,?,?)').run('main', JSON.stringify(['m']), now);
    const registry = new ModelRegistry(db, new ProviderStore(db, new Secrets('x'.repeat(32))));
    registry.rebuild();
    expect(registry.supportsVision('main')).toBe(true);

    // 白名单之外的能力位一律报错：让用户误以为标记不支持工具后就不会下发工具目录，比不提供该选项更糟。
    const stray = await app.request('/api/models/m', { method: 'PATCH', headers, body: JSON.stringify({ capabilities: { tools: false } }) });
    expect(stray.status).toBe(400);
    expect((await stray.json() as { error: { message: string } }).error.message).toContain('运行时不读');
    expect((await app.request('/api/models/m', { method: 'PATCH', headers, body: JSON.stringify({ capabilities: { vision: 'no' } }) })).status).toBe(400);
    expect(JSON.parse(db.prepare('SELECT capabilities_json FROM models WHERE id=?').pluck().get('m') as string)).toMatchObject({ vision: true });

    const marked = await app.request('/api/models/m', { method: 'PATCH', headers, body: JSON.stringify({ capabilities: { vision: false } }) });
    expect(marked.status).toBe(200);
    expect((await marked.json() as { data: { changes: number } }).data.changes).toBe(1);
    // 生效值写入顶层（运行时与界面徽标都读取该处），意图记为 manual（补齐元数据时据此覆盖）。
    const block = JSON.parse(db.prepare('SELECT capabilities_json FROM models WHERE id=?').pluck().get('m') as string) as Record<string, unknown>;
    expect(block).toMatchObject({ vision: false, tools: true, manual: { vision: false } });
    expect(block.catalog).toBeTruthy();
    registry.rebuild();
    expect(registry.supportsVision('main')).toBe(false);
    // 单次修改的记账必须可查：中间件那条只记录方法与路径，无法识别本次改动的是哪个模型的哪一位。
    expect(db.prepare("SELECT COUNT(*) FROM log_events WHERE kind='webui.action' AND summary='model capability marked'").pluck().get()).toBe(1);

    // 取消标记：只移除 manual，顶层保持当前值（不出网重新查询目录），下一次补齐元数据时再按目录填充。
    expect((await app.request('/api/models/m', { method: 'PATCH', headers, body: JSON.stringify({ capabilities: { vision: null } }) })).status).toBe(200);
    const cleared = JSON.parse(db.prepare('SELECT capabilities_json FROM models WHERE id=?').pluck().get('m') as string) as Record<string, unknown>;
    expect(cleared.manual).toBeUndefined();
    expect(cleared.vision).toBe(false);
    // 空 patch 与不存在的行都不应产生 UPDATE。
    expect((await (await app.request('/api/models/m', { method: 'PATCH', headers, body: JSON.stringify({ capabilities: {} }) })).json() as { data: { changes: number } }).data.changes).toBe(0);
    expect((await (await app.request('/api/models/missing', { method: 'PATCH', headers, body: JSON.stringify({ capabilities: { vision: false } }) })).json() as { data: { changes: number } }).data.changes).toBe(0);
    closeDatabase(db);
  });

  it('previews the runtime prompt and streams an isolated Agent dry-run', async () => {
    const { app, db, headers } = harness(() => ({
      previewPrompt: async (key, role) => ({
        key, role, instructions: 'assembled prompt', blocks: [{ name: 'kernel', tokens: 5, content: 'abcde', truncated: false, cached: true }],
        totalTokens: 5, context: { messages: 2, tokens: 4 },
      }),
      dryRunAgent: async (_name, task, _signal, emit) => {
        await emit({ type: 'step', step: 1, finishReason: 'stop', text: task, toolCalls: [], toolResults: [] });
        await emit({ type: 'usage', step: 1, inputTokens: 3, outputTokens: 2, costUsd: 0.01 });
        return { summary: 'done', fullRef: 'artifact://dry-run', truncated: false };
      },
    }));
    const preview = await app.request('/api/prompts/preview', { method: 'POST', headers, body: JSON.stringify({ key: 'chat:1', role: 'trusted' }) });
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ ok: true, data: { key: 'chat:1', role: 'trusted', instructions: 'assembled prompt', totalTokens: 5 } });
    const dryRun = await app.request('/api/agents/researcher/dryrun', { method: 'POST', headers, body: JSON.stringify({ task: 'inspect state' }) });
    expect(dryRun.status).toBe(200);
    expect(dryRun.headers.get('content-type')).toContain('application/x-ndjson');
    const events = (await dryRun.text()).trim().split('\n').map((line) => JSON.parse(line) as unknown);
    expect(events).toEqual([
      { type: 'step', step: 1, finishReason: 'stop', text: 'inspect state', toolCalls: [], toolResults: [] },
      { type: 'usage', step: 1, inputTokens: 3, outputTokens: 2, costUsd: 0.01 },
      { type: 'final', summary: 'done', fullRef: 'artifact://dry-run', truncated: false },
    ]);
    closeDatabase(db);
  });

  it('soft-deletes archive messages from search and turn prompt joins', async () => {
    const { app, db, headers } = harness();
    const archived = new ArchiveRepository(db).scope('chat').append({ chatId: 'chat', messageThreadId: null, tgMessageId: 91, direction: 'in', fromKind: 'user',
      fromUserId: 'user', fromName: 'User', fromUsername: null, kind: 'text', text: 'remove-me-unique', tgDate: Date.now(), raw: {}, triggered: true, triggerReason: 'mention' });
    db.prepare(`INSERT INTO turns(id,key,chat_id,thread_id,initiator_user_id,effective_role,trigger_message_id,state,queued_at)
      VALUES ('turn-delete','chat:chat','chat',NULL,'user','trusted',?,'committed',?)`).run(archived.id, Date.now());
    expect(await (await app.request('/api/turns', { headers: { cookie: headers.cookie } })).text()).toContain('remove-me-unique');
    expect((await app.request(`/api/messages/${archived.id}`, { method: 'DELETE', headers })).status).toBe(200);
    expect(await (await app.request('/api/messages?q=remove-me-unique', { headers: { cookie: headers.cookie } })).text()).not.toContain('remove-me-unique');
    expect(await (await app.request('/api/turns', { headers: { cookie: headers.cookie } })).text()).not.toContain('remove-me-unique');
    expect(await (await app.request('/api/turns/turn-delete/detail', { headers: { cookie: headers.cookie } })).text()).not.toContain('remove-me-unique');
    closeDatabase(db);
  });

  /**
   * `AC-WEB-011` 的第三条判据要求 `raw_json` 可查看。该列自 `0001_init.sql` 起即在写入，而在此
   * 之前全仓没有任何一处读取它，`get_message` 也没有（`MESSAGE_COLUMNS` 中不含该列），
   * 因此界面上没有任何入口可查看 Telegram 实际下发的内容（docs/29 · `M-WEB-06`）。
   * 只在单条详情中下发：列表一页 50 条各带一份完整 update，一次检索即达数 MB。
   */
  it('serves the redacted raw payload on the single-message detail, never in the list', async () => {
    const { app, db, headers } = harness();
    const archived = new ArchiveRepository(db).scope('chat').append({ chatId: 'chat', messageThreadId: null, tgMessageId: 92, direction: 'in', fromKind: 'user',
      fromUserId: 'user', fromName: 'User', fromUsername: null, kind: 'text', text: 'raw-payload-probe', tgDate: Date.now(), triggered: true, triggerReason: 'mention',
      raw: { message_id: 92, text: 'raw-payload-probe', entities: [{ type: 'bold', offset: 0, length: 3 }], api_key: `sk-${'a'.repeat(20)}` } });
    const detail = await (await app.request(`/api/messages/${archived.id}`, { headers: { cookie: headers.cookie } })).json() as { data: { rawJson: string | null } };
    const raw = JSON.parse(detail.data.rawJson ?? 'null') as Record<string, unknown>;
    // entities 正是运维需要查看的内容：解析出错的消息在正文中看不出任何异常。
    expect(raw.entities).toEqual([{ type: 'bold', offset: 0, length: 3 }]);
    // 下发的是入库时脱敏后的版本，而非原始 update 的逐字副本。
    expect(raw.api_key).toBe('«redacted»');
    const listed = await (await app.request('/api/messages?q=raw-payload-probe', { headers: { cookie: headers.cookie } })).text();
    expect(listed).toContain('raw-payload-probe');
    expect(listed, '列表端点把整份 update 也带上了').not.toContain('rawJson');
    closeDatabase(db);
  });

  /**
   * `docs/29 · M-WEB-05`：此前 `DELETE /api/providers/:id` 是一句没有 try/catch 的裸 `DELETE`，
   * 触发 `models.provider_id` 的 `NO ACTION` 外键后抛出 `SqliteError` 并返回 500，
   * 界面上只显示一句服务端出错并已记录，无法说明原因，而审计的 `webui.action` 照常记录一行，
   * 看起来像已删除成功。当时 WebUI 也没有删除模型的入口，先删模型再删 provider 这条自救
   * 路径同样不存在。
   *
   * 现在两个动作分离（参照 `schedules` 的 `DELETE` 与 `purge`）：默认返回 409，仅 `?cascade=1` 才级联。
   */
  it('refuses to delete a provider that still has models, and cascades only when asked', async () => {
    const { app, db, headers } = harness();
    const now = Date.now();
    db.prepare("INSERT INTO providers(id,name,kind,base_url,api_key_enc,enabled,created_at,updated_at) VALUES ('p1','P','openai','http://x',NULL,1,?,?)").run(now, now);
    for (const [id, model] of [['m1', 'a'], ['m2', 'b']] as const)
      db.prepare("INSERT INTO models(id,provider_id,model_id,context_window,max_output,capabilities_json,enabled,sort,created_at,updated_at) VALUES (?,'p1',?,1000,100,'{}',1,0,?,?)").run(id, model, now, now);
    // `high` 仍有一个候选时链变短；`vision` 只指向被删除的那个时整行删除并记录 warn。
    db.prepare("INSERT INTO model_aliases(alias,model_ids_json,updated_at) VALUES ('high',?,?)").run(JSON.stringify(['m1', 'kept']), now);
    db.prepare("INSERT INTO model_aliases(alias,model_ids_json,updated_at) VALUES ('vision',?,?)").run(JSON.stringify(['m2']), now);

    const refused = await app.request('/api/providers/p1', { method: 'DELETE', headers });
    expect(refused.status, '名下还有模型时不该删得掉').toBe(409);
    expect(await refused.json()).toMatchObject({ ok: false, error: { code: 'provider_has_models' } });
    // 拒绝意味着没有任何改动：删除一半而保留一半比返回 500 更糟。
    expect(db.prepare('SELECT COUNT(*) FROM providers').pluck().get()).toBe(1);
    expect(db.prepare('SELECT COUNT(*) FROM models').pluck().get()).toBe(2);

    const cascaded = await app.request('/api/providers/p1?cascade=1', { method: 'DELETE', headers });
    expect(cascaded.status).toBe(200);
    expect(await cascaded.json()).toMatchObject({ ok: true, data: { changes: 1, models: 2 } });
    expect(db.prepare('SELECT COUNT(*) FROM providers').pluck().get()).toBe(0);
    expect(db.prepare('SELECT COUNT(*) FROM models').pluck().get()).toBe(0);
    // 别名链：指向该 id 的引用清除，链为空的整行删除。
    expect(db.prepare("SELECT model_ids_json FROM model_aliases WHERE alias='high'").pluck().get()).toBe(JSON.stringify(['kept']));
    expect(db.prepare("SELECT COUNT(*) FROM model_aliases WHERE alias='vision'").pluck().get()).toBe(0);
    // 运行时对链为空没有任何提示（不注册，`#pick` 回退到 main），因此那条 warn 是唯一凭据。
    const warned = logPayloads(db, 'model.alias_emptied');
    expect(warned).toHaveLength(1);
    expect(JSON.parse(warned[0]!)).toMatchObject({ alias: 'vision' });
    closeDatabase(db);
  });

  it('prunes alias chains when a single model is deleted', async () => {
    const { app, db, headers } = harness();
    const now = Date.now();
    db.prepare("INSERT INTO providers(id,name,kind,base_url,api_key_enc,enabled,created_at,updated_at) VALUES ('p1','P','openai','http://x',NULL,1,?,?)").run(now, now);
    db.prepare("INSERT INTO models(id,provider_id,model_id,context_window,max_output,capabilities_json,enabled,sort,created_at,updated_at) VALUES ('m1','p1','a',1000,100,'{}',1,0,?,?)").run(now, now);
    db.prepare("INSERT INTO model_aliases(alias,model_ids_json,updated_at) VALUES ('vision',?,?)").run(JSON.stringify(['m1']), now);
    // 同一种悬空状态经另一入口同样会发生，而该入口（模型表的行内删除）才是日常使用的那个。
    expect((await app.request('/api/models/m1', { method: 'DELETE', headers })).status).toBe(200);
    expect(db.prepare("SELECT COUNT(*) FROM model_aliases WHERE alias='vision'").pluck().get()).toBe(0);
    expect(db.prepare("SELECT COUNT(*) FROM log_events WHERE kind='model.alias_emptied'").pluck().get()).toBe(1);
    closeDatabase(db);
  });

  it('persists MCP CRUD and writes Skill source files through management routes', async () => {
    const skillsDir = './data/api-contract-skills';
    rmSync(skillsDir, { recursive: true, force: true });
    const resources: { mcp?: McpManager } = {};
    const { app, db, config, headers } = harness(({ db: database, config: liveConfig, log }) => {
      const skills = new SkillLoader(database, skillsDir, () => liveConfig.snapshot().skills.defaultMinRole);
      skills.scan();
      resources.mcp = new McpManager(database, () => liveConfig.snapshot().mcp, log);
      return { skills, mcp: resources.mcp };
    });
    const createdSkill = await app.request('/api/skills', { method: 'POST', headers, body: JSON.stringify({ name: 'web-skill', description: 'Created in UI', body: 'Do the thing.' }) });
    expect(createdSkill.status).toBe(201);
    expect(await createdSkill.json()).toMatchObject({ ok: true, data: { name: 'web-skill', minRole: 'trusted', body: 'Do the thing.' } });
    expect((await app.request('/api/skills/web-skill', { headers: { cookie: headers.cookie } })).status).toBe(200);
    const editedSkill = await app.request('/api/skills/web-skill', { method: 'PUT', headers, body: JSON.stringify({ description: 'Edited', body: 'Updated.', minRole: 'limited', enabled: false }) });
    expect(await editedSkill.json()).toMatchObject({ ok: true, data: { description: 'Edited', minRole: 'limited', enabled: false } });
    // 重名表示名称已被占用，而非提交内容不合法：混入 400 时前端无法区分这两种提示。
    const duplicateSkill = await app.request('/api/skills', { method: 'POST', headers, body: JSON.stringify({ name: 'web-skill', description: 'Again', body: 'Again.' }) });
    expect(duplicateSkill.status).toBe(409);
    expect(await duplicateSkill.json()).toMatchObject({ ok: false, error: { code: 'conflict' } });
    // PATCH 与 PUT 必须走同一条路径：两个动词各写一份 body 映射时，遗漏的那个会静默丢失字段。
    const patchedSkill = await app.request('/api/skills/web-skill', { method: 'PATCH', headers, body: JSON.stringify({ enabled: true }) });
    expect(await patchedSkill.json()).toMatchObject({ ok: true, data: { description: 'Edited', minRole: 'limited', enabled: true } });
    expect((await app.request('/api/skills/absent-skill', { method: 'PUT', headers, body: JSON.stringify({ enabled: true }) })).status).toBe(404);

    const createMcp = await app.request('/api/mcp', { method: 'POST', headers, body: JSON.stringify({ name: 'disabled-fixture', transport: 'stdio', command: process.execPath, enabled: false }) });
    expect(createMcp.status).toBe(201);
    expect(config.snapshot().mcp.servers).toMatchObject([{ name: 'disabled-fixture', transport: 'stdio', enabled: false }]);
    expect(await (await app.request('/api/mcp', { headers: { cookie: headers.cookie } })).text()).toContain('disabled-fixture');
    // 与上面 skills 那条同理，MCP 侧此前返回 400，与 `invalid_mcp` 混在一起（docs/29 · M-WEB-12）。
    const duplicateMcp = await app.request('/api/mcp', { method: 'POST', headers, body: JSON.stringify({ name: 'disabled-fixture', transport: 'stdio', command: process.execPath }) });
    expect(duplicateMcp.status).toBe(409);
    expect(await duplicateMcp.json()).toMatchObject({ ok: false, error: { code: 'conflict' } });
    expect((await app.request('/api/mcp/disabled-fixture', { method: 'PATCH', headers, body: JSON.stringify({ minRole: 'owner' }) })).status).toBe(200);
    expect(config.snapshot().mcp.servers[0]?.minRole).toBe('owner');
    expect((await app.request('/api/mcp/disabled-fixture', { method: 'DELETE', headers })).status).toBe(200);
    expect(config.snapshot().mcp.servers).toEqual([]);
    expect((await app.request('/api/skills/web-skill', { method: 'DELETE', headers })).status).toBe(200);
    expect((await app.request('/api/skills/web-skill', { headers: { cookie: headers.cookie } })).status).toBe(404);
    await resources.mcp?.close();
    rmSync(skillsDir, { recursive: true, force: true });
    closeDatabase(db);
  });

  /**
   * 列表端点的结构属于契约：`SELECT *` 会把 `path`（宿主文件系统路径）、`content_hash` 与整份
   * `frontmatter_json` 一并下发，而前端全部不使用。多下发的字段不会被察觉，直到构成
   * 一次泄漏，因此在这里固定列集合。
   */
  it('narrows the skill list payload and refuses to mutate bundled skills', async () => {
    const skillsDir = './data/api-contract-skill-list';
    rmSync(skillsDir, { recursive: true, force: true });
    mkdirSync(`${skillsDir}/writing-tools`, { recursive: true });
    writeFileSync(`${skillsDir}/writing-tools/SKILL.md`, '---\nname: writing-tools\ndescription: 随包说明文档\nmin-role: owner\n---\n正文\n');
    const { app, db, headers } = harness(({ db: database, config: liveConfig }) => {
      const skills = new SkillLoader(database, skillsDir, () => liveConfig.snapshot().skills.defaultMinRole);
      skills.scan();
      return { skills };
    });
    const rows = (await (await app.request('/api/skills', { headers: { cookie: headers.cookie } })).json()) as { data: Array<Record<string, unknown>> };
    // 恰好九列：`path`（宿主文件系统路径）、`content_hash` 与整份 `frontmatter_json` 都不下发。
    // `allowed_tools` 与 `requires_tools` 只从 `frontmatter_json` 中取这两个字段再下发：
    // `requires-tools` 未满足的 skill 不会进入模型目录，该状态必须在扩展页列表上可见（docs/09 §3.8）。
    expect(Object.keys(rows.data[0]!).sort()).toEqual(['allowed_tools', 'description', 'enabled', 'load_error', 'min_role', 'name', 'requires_tools', 'source', 'updated_at']);
    expect(rows.data[0]).toMatchObject({ name: 'writing-tools', source: 'bundled' });
    // 随包说明文档只允许启停：`write_skill` 一直拒绝修改它们，而这一侧此前可改可删。
    expect((await app.request('/api/skills/writing-tools', { method: 'DELETE', headers })).status).toBe(403);
    expect((await app.request('/api/skills/writing-tools', { method: 'PUT', headers, body: JSON.stringify({ body: '改坏它' }) })).status).toBe(403);
    expect((await app.request('/api/skills/writing-tools', { method: 'PATCH', headers, body: JSON.stringify({ enabled: false }) })).status).toBe(200);
    rmSync(skillsDir, { recursive: true, force: true });
    closeDatabase(db);
  });

  it('installs a skill package through multipart upload and lands it disabled', async () => {
    const skillsDir = './data/api-contract-skill-package';
    rmSync(skillsDir, { recursive: true, force: true });
    mkdirSync(skillsDir, { recursive: true });
    const loaded: { skills?: SkillLoader } = {};
    const { app, db, headers } = harness(({ db: database, config: liveConfig }) => {
      loaded.skills = new SkillLoader(database, skillsDir, () => liveConfig.snapshot().skills.defaultMinRole);
      loaded.skills.scan();
      return { skills: loaded.skills };
    });
    const post = async (zip: Buffer, fields: Record<string, string> = {}): Promise<Response> => {
      const form = new FormData();
      form.append('file', new File([new Uint8Array(zip)], 'pack.zip', { type: 'application/zip' }));
      for (const [key, value] of Object.entries(fields)) form.append(key, value);
      // multipart 的 content-type 由 FormData 自行携带（其中包含 boundary），显式写死会导致字段解析失败。
      return app.request('/api/skills/package', { method: 'POST', headers: { cookie: headers.cookie, 'x-csrf-token': headers['x-csrf-token'] }, body: form });
    };
    const body = '---\nname: packaged\ndescription: 装进来的\n---\n照说明跑 scripts/invoke.sh\n';
    const created = await post(zipFixture([{ name: 'packaged/SKILL.md', content: body }, { name: 'packaged/scripts/invoke.sh', content: 'echo hi', mode: 0o100755 }]));
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ ok: true, data: { name: 'packaged', files: expect.arrayContaining(['scripts/invoke.sh']) } });
    expect(loaded.skills?.read('packaged')).toMatchObject({ enabled: false });
    // 重名返回 409（前端据此提示是否覆盖），而不是提交内容不合法。
    expect((await post(zipFixture([{ name: 'packaged/SKILL.md', content: body }]))).status).toBe(409);
    // 包根存在歧义时必须返回候选项：只提示存在歧义等于让运维自行推测 subdir 应填什么。
    const ambiguous = await post(zipFixture([{ name: 'a/SKILL.md', content: body }, { name: 'b/SKILL.md', content: body }]));
    expect(ambiguous.status).toBe(400);
    expect(await ambiguous.json()).toMatchObject({ ok: false, error: { code: 'skill_ambiguous_root', details: { candidates: expect.arrayContaining(['a', 'b']) } } });
    expect((await post(zipFixture([{ name: 'a/SKILL.md', content: body }, { name: 'b/SKILL.md', content: body }]), { subdir: 'a', name: 'picked' })).status).toBe(201);
    rmSync(skillsDir, { recursive: true, force: true });
    closeDatabase(db);
  });

  /**
   * 信封没有例外，失败路径同样适用。前端 `api()` 中的 `response.json()` 遇到
   * `text/plain` 会抛出 `SyntaxError: Unexpected token 'I'`，报错内容与真实原因无关。
   * 未匹配 `/api/*` 的 404 已修复（docs/22 · I-13），这两条固定的是同一问题在 500 上的另一半：
   * Hono 默认的 onError 返回的正是 `text/plain "Internal Server Error"`。
   */
  it('坏请求体回 400 invalid_json 而不是 text/plain 500', async () => {
    const { app, db, headers } = harness();
    // `PUT /api/config` 是那 17 个没有自身 `.catch()` 的 `ctx.req.json()` 调用点之一；
    // 本条不是针对它的单独修补，`app.onError` 中的 SyntaxError 分支统一覆盖了这一整类。
    const response = await app.request('/api/config', { method: 'PUT', headers, body: '{not json' });
    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toMatch(/application\/json/);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: 'invalid_json' } });
    closeDatabase(db);
  });

  it('端点里抛出的异常回 500 信封 + ref，异常原文只进 webui.error 那一行', async () => {
    const path = './data/api-contract.test.db';
    const { app, db, headers } = harness(({ db: database }) => ({
      // `POST /api/maintenance/:action` 直接调用依赖且没有自身的 try，以它作为真实抛出点，
      // 比构造一条伪造路由更具说明力。
      maintenance: Object.assign(new MaintenanceService(database, path, 2, 30),
        { vacuum: () => { throw new Error('sqlite disk image is malformed at /srv/luoli/data/luoli.db'); } }),
    }));
    const response = await app.request('/api/maintenance/vacuum', { method: 'POST', headers });
    expect(response.status).toBe(500);
    expect(response.headers.get('content-type')).toMatch(/application\/json/);
    const body = await response.json() as { ok: boolean; error: { code: string; message: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('internal');
    // 异常原文包含数据库的绝对路径，不得对外返回：回传给前端的只有那一行日志的 id。
    expect(body.error.message).not.toContain('/srv/luoli');
    expect(body.error.message).toMatch(/ref: \d+/);
    const logged = logRows(db, 'webui.error')[0]!;
    expect(logged.summary).toContain('/api/maintenance/vacuum');
    expect(logged.data).toContain('disk image is malformed');
    // ref 指向的正是那一行，否则运维据此在日志页搜索将无结果。
    expect(body.error.message).toContain(String(db.prepare("SELECT id FROM log_events WHERE kind='webui.error'").pluck().get()));
    closeDatabase(db);
  });
});
