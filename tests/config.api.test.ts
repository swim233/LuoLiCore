import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ArchiveRepository, OperationsRepository, PrincipalRepository, closeDatabase, migrateDatabase, modelAliasKey, openDatabase, readAppKv, writeAppKv } from '@luoli/db';
import { ContextEngine, DatabaseApprovalBroker, EventBus, LogSink, MaintenanceService, PromptDocuments, ProviderStore, Secrets, configSchema } from '@luoli/core';
import { createServer } from '@luoli/server';

function harness() {
  const path = './data/config-write.test.db';
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
  const db = openDatabase(path); migrateDatabase(db);
  // `memory.dir` 要和 PromptDocuments 的根一致：`GET /api/prompts/:id` 按 `config.memory.dir`
  // 做包含性校验（docs/27 · S-07），两处指不同目录的部署在生产里不存在。
  const config = configSchema.parse({ access: { bootstrapOwnerId: '1' }, webui: { passwordHash: 'secret-hash' }, memory: { dir: './data/config-prompts' } });
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

  it('accepts backtracking shapes under the linear regex engine and reports incompatible syntax', async () => {
    const { app, db, headers } = harness();
    const linear = await app.request('/api/config', { method: 'PUT', headers, body: JSON.stringify({ 'trigger.wakewords': ['洛璃', '^(a+)+$'] }) });
    expect(linear.status).toBe(200);
    const incompatible = await app.request('/api/config', { method: 'PUT', headers, body: JSON.stringify({ 'trigger.wakewords': ['洛璃', '^(?=璃)'] }) });
    expect(incompatible.status).toBe(400);
    expect((await incompatible.json() as { error: { code: string; message: string } }).error).toMatchObject({ code: 'invalid_wakeword' });
    const tooShort = await app.request('/api/config', { method: 'PUT', headers, body: JSON.stringify({ 'trigger.wakewords': ['璃'] }) });
    expect(tooShort.status).toBe(400);
    const ok = await app.request('/api/config', { method: 'PUT', headers, body: JSON.stringify({ 'trigger.wakewords': ['洛璃', '^璃酱[，,、 ]'] }) });
    expect(ok.status).toBe(200);
    expect(db.prepare("SELECT value_json FROM config_kv WHERE key='trigger.wakewords'").pluck().get()).toBe('["洛璃","^璃酱[，,、 ]"]');
    const checked = await app.request('/api/config/wakewords/check', { method: 'POST', headers, body: JSON.stringify({ wakewords: ['洛璃', '^璃酱', '璃', '^(?=璃)'], minLength: 2 }) });
    expect((await checked.json() as { data: Array<{ kind: string; ok: boolean }> }).data).toMatchObject([{ kind: 'contains', ok: true }, { kind: 'regex', ok: true }, { ok: false }, { ok: false }]);
    closeDatabase(db);
  });

  it('validates per-chat wakeword overrides through the same rule', async () => {
    const { app, db, headers } = harness();
    const rejected = await app.request('/api/chats/chat:-100', { method: 'PATCH', headers, body: JSON.stringify({ trigger: { wakewords: ['^(?=璃)'] } }) });
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

  // 整块写入代表整棵子树：留着更细的那些行会把它局部否掉（界面上就是「JSON 里明明写着开着，
  // 刷新回来还是关的」）。作废也要进变更历史，否则历史瞒下了「谁把那条逐项覆盖弄掉的」。
  it('subsumes finer-grained rows when an ancestor key is written, and says so', async () => {
    const { app, db, headers } = harness();
    expect((await app.request('/api/tools/web_fetch', { method: 'PATCH', headers, body: JSON.stringify({ enabled: false }) })).status).toBe(200);
    expect(db.prepare("SELECT COUNT(*) FROM config_kv WHERE key='tools.overrides.web_fetch'").pluck().get()).toBe(1);
    const response = await app.request('/api/config', { method: 'PUT', headers, body: JSON.stringify({ 'tools.overrides': { web_fetch: { enabled: true } } }) });
    expect(response.status).toBe(200);
    expect((await response.json() as { data: { subsumed: string[] } }).data.subsumed).toEqual(['tools.overrides.web_fetch']);
    expect(db.prepare("SELECT COUNT(*) FROM config_kv WHERE key='tools.overrides.web_fetch'").pluck().get()).toBe(0);
    // 被作废的那一行留下一条 new_json 为空的 revision。
    const removal = db.prepare("SELECT old_json,new_json FROM config_revisions WHERE key='tools.overrides.web_fetch' ORDER BY rowid DESC").get() as { old_json: string | null; new_json: string | null };
    expect(removal).toMatchObject({ old_json: '{"enabled":false}', new_json: null });
    closeDatabase(db);
  });

  // 沙箱 mode / bypassRoles 是安全相关配置，此前 PUT /api/sandbox 只写 config_kv 不写 revision，
  // 「变更历史」里完全看不到它被谁改过（docs/21 · G-CFG-06）。
  it('records sandbox writes in the configuration history', async () => {
    const { app, db, headers } = harness();
    expect((await app.request('/api/sandbox', { method: 'PUT', headers, body: JSON.stringify({ mode: 'none' }) })).status).toBe(200);
    expect(db.prepare("SELECT new_json FROM config_revisions WHERE key='sandbox.mode'").pluck().get()).toBe('"none"');
    closeDatabase(db);
  });

  // 被环境变量钉住的键写进 config_kv 也会在下次 loadConfig 时被盖回去：拒收，而不是假成功。
  it('refuses to write config keys that the environment pins', async () => {
    const { app, db, headers } = harness();
    const previous = process.env.LUOLI_WEBUI_HOST;
    process.env.LUOLI_WEBUI_HOST = '0.0.0.0';
    try {
      const schema = await app.request('/api/config/schema', { headers: { cookie: headers.cookie } });
      expect((await schema.json() as { data: { envPinned: Array<{ key: string; env: string }> } }).data.envPinned)
        .toContainEqual({ key: 'webui.host', env: 'LUOLI_WEBUI_HOST' });
      const rejected = await app.request('/api/config', { method: 'PUT', headers, body: JSON.stringify({ 'webui.host': '127.0.0.1' }) });
      expect(rejected.status).toBe(400);
      expect((await rejected.json() as { error: { code: string } }).error.code).toBe('config_pinned_by_env');
      expect(db.prepare("SELECT COUNT(*) FROM config_kv WHERE key='webui.host'").pluck().get()).toBe(0);
      // 祖先写入对那个叶子同样无效，所以同样挡回去。
      expect((await app.request('/api/config', { method: 'PUT', headers, body: JSON.stringify({ webui: { host: '127.0.0.1' } }) })).status).toBe(400);
    } finally {
      if (previous === undefined) delete process.env.LUOLI_WEBUI_HOST; else process.env.LUOLI_WEBUI_HOST = previous;
    }
    closeDatabase(db);
  });

  it('refuses the change-password endpoint while WEBUI_PASSWORD pins the hash', async () => {
    const { app, db, headers } = harness();
    const previous = process.env.WEBUI_PASSWORD;
    process.env.WEBUI_PASSWORD = 'pinned-by-compose';
    try {
      const response = await app.request('/api/auth/password', { method: 'POST', headers, body: JSON.stringify({ current: 'whatever', next: 'a'.repeat(16) }) });
      expect(response.status).toBe(409);
      expect((await response.json() as { error: { code: string } }).error.code).toBe('password_pinned_by_env');
      expect(db.prepare("SELECT COUNT(*) FROM config_kv WHERE key='webui.passwordHash'").pluck().get()).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.WEBUI_PASSWORD; else process.env.WEBUI_PASSWORD = previous;
    }
    closeDatabase(db);
  });

  // 密钥字段在 GET /api/config 里是 «redacted»。把读出来的值原样提交回去（`mcp.servers` 那种
  // 整块 JSON 最容易）等于用五个字覆盖真密钥，而且那一行会一直赢。
  it('refuses values that still carry the «redacted» placeholder', async () => {
    const { app, db, headers } = harness();
    const response = await app.request('/api/config', { method: 'PUT', headers, body: JSON.stringify({ 'tools.web.searchApiKey': '«redacted»' }) });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: { code: string } }).error.code).toBe('redacted_placeholder');
    // 真值照常写得进去 —— 密钥字段在界面上是「只写」而不是只读。
    expect((await app.request('/api/config', { method: 'PUT', headers, body: JSON.stringify({ 'tools.web.searchApiKey': 'brave-key-1' }) })).status).toBe(200);
    expect(db.prepare("SELECT value_json FROM config_kv WHERE key='tools.web.searchApiKey'").pluck().get()).toBe('"brave-key-1"');
    // 但**变更历史里必须是脱敏的**（docs/09 §3.13 就是这么承诺的）：写第二次时新旧两侧都不许出现真值。
    expect((await app.request('/api/config', { method: 'PUT', headers, body: JSON.stringify({ 'tools.web.searchApiKey': 'brave-key-2' }) })).status).toBe(200);
    const revisions = db.prepare("SELECT old_json,new_json FROM config_revisions WHERE key='tools.web.searchApiKey' ORDER BY rowid").all() as Array<{ old_json: string | null; new_json: string | null }>;
    expect(revisions).toEqual([{ old_json: null, new_json: '"«redacted»"' }, { old_json: '"«redacted»"', new_json: '"«redacted»"' }]);
    // 嵌在结构里的密钥同样脱敏（`mcp.servers` 的 env / headers），而 config_kv 里存的还是真值。
    const server = [{ name: 'demo', transport: 'stdio', command: 'node', env: { API_TOKEN: 'super-secret' } }];
    expect((await app.request('/api/config', { method: 'PUT', headers, body: JSON.stringify({ 'mcp.servers': server }) })).status).toBe(200);
    expect(db.prepare("SELECT value_json FROM config_kv WHERE key='mcp.servers'").pluck().get()).toContain('super-secret');
    expect(db.prepare("SELECT new_json FROM config_revisions WHERE key='mcp.servers'").pluck().get()).not.toContain('super-secret');
    closeDatabase(db);
  });

  // 审批规则此前是 z.record(z.unknown())：字段名写错、正则编译不了的规则运行时被静默丢掉，
  // 而写入端一路 200 —— 一道「静默不生效」的审批门等于门开着（docs/21 · G-CFG-07）。
  it('validates approval rules at write time instead of dropping them at runtime', async () => {
    const { app, db, headers } = harness();
    const cases: Array<[string, unknown]> = [
      ['字段名写错', [{ toolName: 'delete_file', always: true }]],
      ['正则编译不了', [{ tool: 'bash', pattern: '(' }]],
      ['风险等级不在枚举里', [{ tool: 'bash', risk: 'huge' }]],
      ['always: false 运行时没有这个语义', [{ tool: 'bash', always: false }]],
    ];
    for (const [label, rules] of cases) {
      const response = await app.request('/api/config', { method: 'PUT', headers, body: JSON.stringify({ 'approval.rules': rules }) });
      expect(response.status, label).toBe(400);
    }
    const ok = await app.request('/api/config', { method: 'PUT', headers, body: JSON.stringify({ 'approval.rules': [{ tool: ['delete_file', 'move_file'], pattern: '(?i)\\.env', risk: 'high' }] }) });
    expect(ok.status).toBe(200);
    expect(db.prepare("SELECT COUNT(*) FROM config_kv WHERE key='approval.rules'").pluck().get()).toBe(1);
    closeDatabase(db);
  });

  // /model 写的是 app_kv，却压过 WebUI 能改的 agent.main.modelAlias：界面上得看得见、清得掉。
  it('surfaces the per-chat model alias from app_kv and clears it', async () => {
    const { app, db, headers } = harness();
    writeAppKv(db, modelAliasKey('chat:-100'), 'high', 'command:7');
    const detail = await app.request('/api/chats/chat%3A-100', { headers: { cookie: headers.cookie } });
    expect((await detail.json() as { data: { modelAlias: string | null } }).data.modelAlias).toBe('high');
    const cleared = await app.request('/api/chats/chat%3A-100/model-alias', { method: 'DELETE', headers });
    expect((await cleared.json() as { data: { cleared: boolean } }).data.cleared).toBe(true);
    expect(readAppKv(db, modelAliasKey('chat:-100'))).toBeUndefined();
    // 本来就没有别名时不谎报清除。
    expect((await (await app.request('/api/chats/chat%3A-100/model-alias', { method: 'DELETE', headers })).json() as { data: { cleared: boolean } }).data.cleared).toBe(false);
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
