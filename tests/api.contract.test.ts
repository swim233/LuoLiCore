import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ArchiveRepository, OperationsRepository, PrincipalRepository, SandboxContainerRepository, closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { ConfigStore, ContainerManager, ContextEngine, DatabaseApprovalBroker, EventBus, LogSink, MaintenanceService, McpManager, ModelRegistry, ProviderStore, Sandbox, Secrets, SkillLoader, configSchema } from '@luoli/core';
import { createServer, type ServerDependencies } from '@luoli/server';
import { zipFixture } from './fixtures/zip.js';

function harness(extend: (base: { db: ReturnType<typeof openDatabase>; config: ConfigStore; events: EventBus; log: LogSink }) => Partial<ServerDependencies> = () => ({})) {
  const path = './data/api-contract.test.db'; for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
  const db = openDatabase(path); migrateDatabase(db);
  const config = new ConfigStore(configSchema.parse({ access: { bootstrapOwnerId: '1' }, webui: { passwordHash: 'hash' } }));
  const operations = new OperationsRepository(db); const events = new EventBus(); const log = new LogSink(operations, './data/api-contract-logs'); const archive = new ArchiveRepository(db);
  const app = createServer({ config, db, operations, principals: new PrincipalRepository(db), archive, context: new ContextEngine(db, archive), providers: new ProviderStore(db, new Secrets('x'.repeat(32))), approvals: new DatabaseApprovalBroker(db, () => config.snapshot(), events, log), maintenance: new MaintenanceService(db, path, 2, 30), events, log, configSchema: {}, startedAt: Date.now(), setup: undefined, ...extend({ db, config, events, log }) });
  const session = operations.createSession(1); const headers = { cookie: `luoli_sid=${session.id}`, 'x-csrf-token': session.csrf, 'content-type': 'application/json' };
  return { app, db, config, headers };
}

describe('documented API surface', () => {
  it('serves read endpoints and audits every authenticated write', async () => {
    const { app, db, headers } = harness(); const cookie = { cookie: headers.cookie };
    // 只断言 200 是条假绿灯：没有注册的 /api/* 会掉进 SPA fallback，拿到 200 + index.html。
    // `GET /api/quota` 就这样「通过」了很久，实际上端点根本不存在。必须连 JSON 信封一起断言。
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
   * 持久容器的三个端点（docs/09 §3.7）。**没装配运行时时回 `not_implemented` 而不是空列表** ——
   * 「读不到」和「一个容器都没有」在运维眼里是两回事（docs/16 §5「摘除比伪造安全」），
   * 而面板正是靠这一位决定显示「这个部署没装配」还是「现在没有容器」。
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
    // 会话名从 principals join 出来 —— 面板上只显示裸 chatId 的话，运维认不出这是哪个群。
    expect(payload.containers[0]).toMatchObject({ chatLabel: '隆福饭搭子', pinned: false });

    // 钉住走 keep，并且**只豁免闲置回收**：这里没有绝对上限，所以 hardExpiresAt 仍是 null。
    const kept = await app.request('/api/containers/-1001/keep', { method: 'POST', headers, body: JSON.stringify({ pin: true }) });
    expect(kept.status).toBe(200);
    expect((await kept.json() as { data: { pinned: boolean; hardExpiresAt: number | null } }).data).toMatchObject({ pinned: true, hardExpiresAt: null });
    const absent = await app.request('/api/containers/-9999/keep', { method: 'POST', headers, body: JSON.stringify({ pin: true }) });
    expect(absent.status).toBe(404);
    expect((await absent.json() as { error: { code: string } }).error.code).toBe('container_not_found');
    // 写操作照常进审计流水。
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

  // 图片与文件此前在管理端完全不可见：消息行不带 attachment id（docs/21 · G-API-08）。
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
    // 磁盘路径对界面没用，泄漏出去只是白送一份部署布局。
    expect(body).not.toContain('attachment-test/shot.png');
    const download = await app.request('/api/files/att-png', { headers: cookie });
    expect(download.headers.get('content-disposition')).toContain('attachment');
    expect((await app.request('/api/files/att-png?inline=1', { headers: cookie })).headers.get('content-disposition')).toBe('inline');
    // SVG 能带脚本：同源内联它等于把用户上传的内容变成本站脚本，白名单外一律照旧当附件下载。
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
    // 空链、非法别名名、白名单外的采样参数都要在写入前挡下来，别名表里不该出现「存在但不可用」的行。
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
   * 人工标记模型的看图能力（docs/21 §10）。`capabilities_json` 是按**模型名**从 models.dev 抄来的，
   * 中转站照抄官方模型名却不真的转发图片时，抄来的 `vision:true` 让含图轮次不切 `vision` 别名 ——
   * 图就留在一个看不见它的模型上（实测 `logs/2026-08-19`：那家网关的 grok-4.5 收下 image_url、
   * 200 返回、usage 里没有 image_tokens，四次全在瞎猜；同一家的 grok-4.3 正常）。
   *
   * 这条断言链要求的是「界面上标一下 → 运行时真的改了路」，所以它拿真的 `ModelRegistry` 复算，
   * 而不是只看库里那行 JSON。
   */
  it('marks a relayed model as blind and the runtime registry follows', async () => {
    const { app, db, headers } = harness();
    const now = Date.now();
    db.prepare("INSERT INTO providers(id,name,kind,base_url,enabled,created_at,updated_at) VALUES('p','relay','openai-compatible','http://127.0.0.1:9/v1',1,?,?)").run(now, now);
    // 目录抄来的那份：vision=true，而这家网关根本不转发图片。
    db.prepare(`INSERT INTO models(id,provider_id,model_id,context_window,max_output,capabilities_json,enabled,sort,created_at,updated_at)
      VALUES('m','p','grok-4.5',128000,8192,'{"vision":true,"tools":true,"catalog":{"source":"models.dev","match":"official","priceSource":null}}',1,0,?,?)`).run(now, now);
    db.prepare('INSERT INTO model_aliases(alias,model_ids_json,updated_at) VALUES (?,?,?)').run('main', JSON.stringify(['m']), now);
    const registry = new ModelRegistry(db, new ProviderStore(db, new Secrets('x'.repeat(32))));
    registry.rebuild();
    expect(registry.supportsVision('main')).toBe(true);

    // 白名单外的能力位一律报错：让人以为标了「不支持工具」就不会发工具目录，比不给这个选项糟。
    const stray = await app.request('/api/models/m', { method: 'PATCH', headers, body: JSON.stringify({ capabilities: { tools: false } }) });
    expect(stray.status).toBe(400);
    expect((await stray.json() as { error: { message: string } }).error.message).toContain('运行时不读');
    expect((await app.request('/api/models/m', { method: 'PATCH', headers, body: JSON.stringify({ capabilities: { vision: 'no' } }) })).status).toBe(400);
    expect(JSON.parse(db.prepare('SELECT capabilities_json FROM models WHERE id=?').pluck().get('m') as string)).toMatchObject({ vision: true });

    const marked = await app.request('/api/models/m', { method: 'PATCH', headers, body: JSON.stringify({ capabilities: { vision: false } }) });
    expect(marked.status).toBe(200);
    expect((await marked.json() as { data: { changes: number } }).data.changes).toBe(1);
    // 生效值写顶层（运行时与界面徽章都读那里），意图记 manual（「补齐元数据」据它盖回来）。
    const block = JSON.parse(db.prepare('SELECT capabilities_json FROM models WHERE id=?').pluck().get('m') as string) as Record<string, unknown>;
    expect(block).toMatchObject({ vision: false, tools: true, manual: { vision: false } });
    expect(block.catalog).toBeTruthy();
    registry.rebuild();
    expect(registry.supportsVision('main')).toBe(false);
    // 改一路的记账要能查：中间件那条只记方法与路径，认不出这一次动的是哪个模型的哪一位。
    expect(db.prepare("SELECT COUNT(*) FROM log_events WHERE kind='webui.action' AND summary='model capability marked'").pluck().get()).toBe(1);

    // 取消标记：只摘掉 manual，顶层维持现值（不出网重查目录），下一次「补齐元数据」再按目录重填。
    expect((await app.request('/api/models/m', { method: 'PATCH', headers, body: JSON.stringify({ capabilities: { vision: null } }) })).status).toBe(200);
    const cleared = JSON.parse(db.prepare('SELECT capabilities_json FROM models WHERE id=?').pluck().get('m') as string) as Record<string, unknown>;
    expect(cleared.manual).toBeUndefined();
    expect(cleared.vision).toBe(false);
    // 空 patch 与不存在的行都不该造出一条 UPDATE。
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
    // 重名是「名字被占了」而不是「你发的东西不合法」：混在 400 里前端分不开这两种提示。
    const duplicateSkill = await app.request('/api/skills', { method: 'POST', headers, body: JSON.stringify({ name: 'web-skill', description: 'Again', body: 'Again.' }) });
    expect(duplicateSkill.status).toBe(409);
    expect(await duplicateSkill.json()).toMatchObject({ ok: false, error: { code: 'conflict' } });
    // PATCH 与 PUT 必须是同一条路径：两个动词各抄一份 body 映射时，漏掉的那个会静默丢字段。
    const patchedSkill = await app.request('/api/skills/web-skill', { method: 'PATCH', headers, body: JSON.stringify({ enabled: true }) });
    expect(await patchedSkill.json()).toMatchObject({ ok: true, data: { description: 'Edited', minRole: 'limited', enabled: true } });
    expect((await app.request('/api/skills/absent-skill', { method: 'PUT', headers, body: JSON.stringify({ enabled: true }) })).status).toBe(404);

    const createMcp = await app.request('/api/mcp', { method: 'POST', headers, body: JSON.stringify({ name: 'disabled-fixture', transport: 'stdio', command: process.execPath, enabled: false }) });
    expect(createMcp.status).toBe(201);
    expect(config.snapshot().mcp.servers).toMatchObject([{ name: 'disabled-fixture', transport: 'stdio', enabled: false }]);
    expect(await (await app.request('/api/mcp', { headers: { cookie: headers.cookie } })).text()).toContain('disabled-fixture');
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
   * 列表端点的形状是个契约：`SELECT *` 会把 `path`（宿主文件系统路径）、`content_hash` 与整份
   * `frontmatter_json` 一起发出去，而前端一个都不用。多发的字段没人会注意到，直到它变成
   * 一条泄露 —— 所以把列集合焊在这里。
   */
  it('narrows the skill list payload and refuses to mutate bundled skills', async () => {
    const skillsDir = './data/api-contract-skill-list';
    rmSync(skillsDir, { recursive: true, force: true });
    mkdirSync(`${skillsDir}/writing-tools`, { recursive: true });
    writeFileSync(`${skillsDir}/writing-tools/SKILL.md`, '---\nname: writing-tools\ndescription: 随包说明书\nmin-role: owner\n---\n正文\n');
    const { app, db, headers } = harness(({ db: database, config: liveConfig }) => {
      const skills = new SkillLoader(database, skillsDir, () => liveConfig.snapshot().skills.defaultMinRole);
      skills.scan();
      return { skills };
    });
    const rows = (await (await app.request('/api/skills', { headers: { cookie: headers.cookie } })).json()) as { data: Array<Record<string, unknown>> };
    expect(Object.keys(rows.data[0]!).sort()).toEqual(['description', 'enabled', 'load_error', 'min_role', 'name', 'source', 'updated_at']);
    expect(rows.data[0]).toMatchObject({ name: 'writing-tools', source: 'bundled' });
    // 随包说明书只放行启停：`write_skill` 一直拒改它们，这一侧此前能改能删。
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
      // multipart 的 content-type 由 FormData 自己带（里面有 boundary），显式写死会解不出字段。
      return app.request('/api/skills/package', { method: 'POST', headers: { cookie: headers.cookie, 'x-csrf-token': headers['x-csrf-token'] }, body: form });
    };
    const body = '---\nname: packaged\ndescription: 装进来的\n---\n照说明跑 scripts/invoke.sh\n';
    const created = await post(zipFixture([{ name: 'packaged/SKILL.md', content: body }, { name: 'packaged/scripts/invoke.sh', content: 'echo hi', mode: 0o100755 }]));
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ ok: true, data: { name: 'packaged', files: expect.arrayContaining(['scripts/invoke.sh']) } });
    expect(loaded.skills?.read('packaged')).toMatchObject({ enabled: false });
    // 重名是 409（前端据此提示「要覆盖吗」），不是「你发的东西不合法」。
    expect((await post(zipFixture([{ name: 'packaged/SKILL.md', content: body }]))).status).toBe(409);
    // 包根有歧义时必须把候选带回去 —— 只说「有歧义」等于让运维自己猜 subdir 填什么。
    const ambiguous = await post(zipFixture([{ name: 'a/SKILL.md', content: body }, { name: 'b/SKILL.md', content: body }]));
    expect(ambiguous.status).toBe(400);
    expect(await ambiguous.json()).toMatchObject({ ok: false, error: { code: 'skill_ambiguous_root', details: { candidates: expect.arrayContaining(['a', 'b']) } } });
    expect((await post(zipFixture([{ name: 'a/SKILL.md', content: body }, { name: 'b/SKILL.md', content: body }]), { subdir: 'a', name: 'picked' })).status).toBe(201);
    rmSync(skillsDir, { recursive: true, force: true });
    closeDatabase(db);
  });

  /**
   * **信封没有例外，失败路径也一样。** 前端 `api()` 里那句 `response.json()` 遇到一份
   * `text/plain` 就抛 `SyntaxError: Unexpected token 'I'`，报错和真实原因毫无关系。
   * 未匹配 `/api/*` 的 404 早就修过了（docs/22 · I-13），这两条焊的是同一个病在 500 上的那一半：
   * Hono 的默认 onError 回的正是 `text/plain "Internal Server Error"`。
   */
  it('坏请求体回 400 invalid_json 而不是 text/plain 500', async () => {
    const { app, db, headers } = harness();
    // `PUT /api/config` 是那 17 个没有自己 `.catch()` 的 `ctx.req.json()` 站点之一 ——
    // 这一条不是给它单独打的补丁，`app.onError` 里那个 SyntaxError 分支把整类都收了口。
    const response = await app.request('/api/config', { method: 'PUT', headers, body: '{not json' });
    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toMatch(/application\/json/);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: 'invalid_json' } });
    closeDatabase(db);
  });

  it('端点里抛出的异常回 500 信封 + ref，异常原文只进 webui.error 那一行', async () => {
    const path = './data/api-contract.test.db';
    const { app, db, headers } = harness(({ db: database }) => ({
      // `POST /api/maintenance/:action` 直接调依赖、没有自己的 try —— 拿它当真实的抛出点，
      // 比塞一条假路由更能说明问题。
      maintenance: Object.assign(new MaintenanceService(database, path, 2, 30),
        { vacuum: () => { throw new Error('sqlite disk image is malformed at /srv/luoli/data/luoli.db'); } }),
    }));
    const response = await app.request('/api/maintenance/vacuum', { method: 'POST', headers });
    expect(response.status).toBe(500);
    expect(response.headers.get('content-type')).toMatch(/application\/json/);
    const body = await response.json() as { ok: boolean; error: { code: string; message: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('internal');
    // 异常原文里带着库的绝对路径，**不许出网**：回给前端的只有那一行日志的 id。
    expect(body.error.message).not.toContain('/srv/luoli');
    expect(body.error.message).toMatch(/ref: \d+/);
    const logged = db.prepare("SELECT summary,data_json FROM log_events WHERE kind='webui.error'").get() as { summary: string; data_json: string };
    expect(logged.summary).toContain('/api/maintenance/vacuum');
    expect(logged.data_json).toContain('disk image is malformed');
    // ref 指的就是那一行，否则运维照着它去日志页搜是搜不到的。
    expect(body.error.message).toContain(String(db.prepare("SELECT id FROM log_events WHERE kind='webui.error'").pluck().get()));
    closeDatabase(db);
  });
});
