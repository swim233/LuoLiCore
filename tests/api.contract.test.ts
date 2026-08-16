import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ArchiveRepository, OperationsRepository, PrincipalRepository, closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { ConfigStore, ContextEngine, DatabaseApprovalBroker, EventBus, LogSink, MaintenanceService, McpManager, ProviderStore, Secrets, SkillLoader, configSchema } from '@luoli/core';
import { createServer, type ServerDependencies } from '@luoli/server';

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
    mkdirSync('./data/attachment-test', { recursive: true });
    const png = './data/attachment-test/shot.png';
    writeFileSync(png, Buffer.from('89504e470d0a1a0a', 'hex'));
    const svg = './data/attachment-test/logo.svg';
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
    rmSync('./data/attachment-test', { recursive: true, force: true });
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

  it('previews the runtime prompt and streams an isolated Agent dry-run', async () => {
    const { app, db, headers } = harness(() => ({
      previewPrompt: async (key, role) => ({
        key, role, instructions: 'assembled prompt', blocks: [{ name: 'kernel', tokens: 5, content: 'abcde', truncated: false }],
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
});
