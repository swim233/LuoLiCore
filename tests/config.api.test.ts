import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ArchiveRepository, OperationsRepository, PrincipalRepository, closeDatabase, migrateDatabase, modelAliasKey, openDatabase, readAppKv, writeAppKv } from '@luoli/db';
import type { Sqlite } from '@luoli/db';
import { ContextEngine, DatabaseApprovalBroker, EventBus, LogSink, MaintenanceService, MemoryStore, PromptDocuments, ProviderStore, Secrets, configSchema } from '@luoli/core';
import { createServer } from '@luoli/server';
import { assignDotted, sortOverrideKeys } from '@luoli/shared';

function harness() {
  const path = './data/config-write.test.db';
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
  const db = openDatabase(path); migrateDatabase(db);
  // `memory.dir` 要和 PromptDocuments 的根一致：`GET /api/prompts/:id` 按 `config.memory.dir`
  // 做包含性校验（docs/27 · S-07），两处指不同目录的部署在生产里不存在。
  const config = configSchema.parse({ access: { bootstrapOwnerId: '1' }, webui: { passwordHash: 'secret-hash' }, memory: { dir: './data/config-prompts' } });
  const operations = new OperationsRepository(db); const events = new EventBus(); const log = new LogSink(operations, './data/config-write-logs'); const archive = new ArchiveRepository(db);
  const promptDocuments = new PromptDocuments(db, './data/config-prompts'); promptDocuments.ensure();
  const app = createServer({ config, db, operations, principals: new PrincipalRepository(db), archive, context: new ContextEngine(db, archive), providers: new ProviderStore(db, new Secrets('x'.repeat(32))), approvals: new DatabaseApprovalBroker(db, config, events, log), maintenance: new MaintenanceService(db, path, 2, 30), promptDocuments, memory: new MemoryStore(db, './data/config-prompts', 1500, 3000, 2, log), events, log, configSchema: {}, startedAt: Date.now(), setup: undefined });
  const session = operations.createSession(1); const headers = { cookie: `luoli_sid=${session.id}`, 'x-csrf-token': session.csrf, 'content-type': 'application/json' };
  return { app, db, headers };
}

const data = async <T>(response: Response): Promise<T> => (await response.json() as { data: T }).data;

/**
 * `config_kv` 展开成一棵树之后的**叶子集**——「生效覆盖」的真实计量。
 * 行数看不出 docs/28 · L-WEB-02：按顶层段落库时 `config_kv` 的行数反而**下降**
 * （祖先键吞掉后代行），而生效覆盖叶子从 73 涨到 171，全是那一刻的代码默认值。
 */
function effectiveLeaves(db: Sqlite): string[] {
  const rows = db.prepare('SELECT key,value_json AS valueJson FROM config_kv').all() as Array<{ key: string; valueJson: string }>;
  const root: Record<string, unknown> = {};
  for (const row of sortOverrideKeys(rows)) assignDotted(root, row.key, JSON.parse(row.valueJson));
  const walk = (node: unknown, prefix: string): string[] => !node || typeof node !== 'object' || Array.isArray(node)
    ? [prefix]
    : Object.entries(node as Record<string, unknown>).flatMap(([key, value]) => walk(value, prefix ? `${prefix}.${key}` : key));
  return walk(root, '').sort();
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

  /**
   * 跨字段约束的报错要**自己说得清**（docs/21 · G-CFG-08）。前端的 toast 只念 `message`，
   * 而 `details` 此前谁都不读 —— 一次「软上限调大了」在界面上就是一句「配置校验失败」，
   * 看不出跟哪一格冲突。这条锁两件事：出问题的 path 进了 `message`，`details` 仍在。
   */
  it('names the offending key and the other side of a cross-field rule in the message itself', async () => {
    const { app, db, headers } = harness();
    const response = await app.request('/api/config', { method: 'PUT', headers, body: JSON.stringify({ 'memory.softLimitTokens': 4000 }) });
    expect(response.status).toBe(400);
    const error = (await response.json() as { error: { code: string; message: string; details: Array<{ path: string; message: string }> } }).error;
    expect(error.code).toBe('invalid_config');
    expect(error.message).toContain('memory.softLimitTokens');
    // 对方那一格现在是多少也要说出来，否则运维还得去 200 多个值里翻硬上限。
    expect(error.message).toContain('3000');
    expect(error.details[0]).toMatchObject({ path: 'memory.softLimitTokens' });
    expect(db.prepare("SELECT COUNT(*) FROM config_kv WHERE key='memory.softLimitTokens'").pluck().get()).toBe(0);
    // 两格一起改就过：这条约束本来就是「这两格的关系」，而不是「这一格不能动」。
    expect((await app.request('/api/config', { method: 'PUT', headers, body: JSON.stringify({ 'memory.softLimitTokens': 4000, 'memory.hardLimitTokens': 9000 }) })).status).toBe(200);
    closeDatabase(db);
  });

  it('accepts backtracking shapes under the linear regex engine and reports incompatible syntax', async () => {
    const { app, db, headers } = harness();
    const linear = await app.request('/api/config', { method: 'PUT', headers, body: JSON.stringify({ 'trigger.wakewords': ['洛璃', '^(a+)+$'] }) });
    expect(linear.status).toBe(200);
    const incompatible = await app.request('/api/config', { method: 'PUT', headers, body: JSON.stringify({ 'trigger.wakewords': ['洛璃', '^(?=璃)'] }) });
    expect(incompatible.status).toBe(400);
    // 拒绝要**说明原因**，而且要点名是哪一条：一份唤醒词里坏的通常只有一条，只回个 code
    // 等于让运维把整份逐条删着试。
    expect((await incompatible.json() as { error: { code: string; message: string } }).error)
      .toMatchObject({ code: 'invalid_wakeword', message: expect.stringContaining('「^(?=璃)」') });
    const tooShort = await app.request('/api/config', { method: 'PUT', headers, body: JSON.stringify({ 'trigger.wakewords': ['璃'] }) });
    expect(tooShort.status).toBe(400);
    expect((await tooShort.json() as { error: { message: string } }).error.message).toContain('wakewordMinLength');
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
    const payload = await response.json() as { ok: boolean; data: { schema: unknown; hotReloadable: string[]; unimplemented: string[]; enumNotes: Record<string, Record<string, string>> } };
    expect(payload.ok).toBe(true);
    expect(payload.data.schema).toBeDefined();
    expect(payload.data.hotReloadable).toContain('logs.level');
    expect(payload.data.unimplemented).toContain('trigger.ignoreEditedAsTrigger');
    // 第四份：逐个取值的说明。缺了它，取值受限的那几格会渲染成一排没有说明的复选框。
    expect(payload.data.enumNotes['telegram.allowedUpdates']?.message).toContain('已处理');
    expect(payload.data.enumNotes['telegram.allowedUpdates']?.message_reaction).toContain('无处理器');
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

  // `tools.fs.allowHostFsForOwner` 不在 `sandbox.*` 下（PUT /api/sandbox 会给每个键加前缀），
  // 但它管的是同一件事的另一半：谁能绕过隔离。沙箱页要能看见它，所以 GET 得把它带上
  // ——此前那一页上 grep 都是零命中，只能从「全部配置」里拨（docs/29 · M-WEB-10）。
  it('沙箱详情带上 allowHostFsForOwner，写回仍走配置那条路', async () => {
    const { app, db, headers } = harness();
    const detail = await data<{ allowHostFsForOwner: boolean; config: Record<string, unknown> }>(await app.request('/api/sandbox', { headers: { cookie: headers.cookie } }));
    expect(detail.allowHostFsForOwner).toBe(false);
    // 写回**没有**跟着搬去 `PUT /api/sandbox`：那条路给每个键加 `sandbox.` 前缀，
    // 塞进去只会造出一个 schema 里不存在的 `sandbox.allowHostFsForOwner`。照旧走配置那条路。
    expect((await app.request('/api/config', { method: 'PUT', headers, body: JSON.stringify({ 'tools.fs.allowHostFsForOwner': true }) })).status).toBe(200);
    expect(db.prepare("SELECT value_json FROM config_kv WHERE key='tools.fs.allowHostFsForOwner'").pluck().get()).toBe('true');
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

  /**
   * 「设置 → 高级」tab 就是 `GET /api/config/yaml` → 编辑 → `PUT`。密钥类行**不在 GET 那棵树里**
   * （整行跳过），所以「树里没有」绝不能当成「运维删掉了」—— 那一次往返曾经把 `webui.passwordHash`
   * 擦掉，`main.ts` 的 `if (!config.webui.passwordHash)` 随即生效、进程静静掉回 setup-token 形态，
   * 而 `host` 是默认回环时 schema 的 `superRefine` 不拦（docs/28 · L-WEB-04）。
   */
  it('never drops secret overlay rows through a YAML round trip', async () => {
    const { app, db, headers } = harness();
    const hash = '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2g';
    // 同一段里必须还有别的键，否则那个段压根不会被提交、也就无从被误删 —— 真实部署正是这样。
    expect((await app.request('/api/config', { method: 'PUT', headers, body: JSON.stringify({
      'webui.passwordHash': hash, 'webui.sessionTtlHours': 24, 'tools.web.searchApiKey': 'brave-key', 'tools.web.searchProvider': 'brave' }) })).status).toBe(200);
    const rendered = await data<{ yaml: string; skipped: string[] }>(await app.request('/api/config/yaml', { headers: { cookie: headers.cookie } }));
    expect(rendered.skipped).toEqual(expect.arrayContaining(['webui.passwordHash', 'tools.web.searchApiKey']));
    expect(rendered.yaml).not.toContain(hash);
    // 顶部生成注释逐条点名：响应里那个 `skipped` 数组在编辑器里看不见（docs/09 §3.13）。
    expect(rendered.yaml).toContain('#   webui.passwordHash');
    expect(rendered.yaml).toContain('#   tools.web.searchApiKey');
    expect(rendered.yaml).toContain('删掉这段注释也不会');
    const saved = await app.request('/api/config/yaml', { method: 'PUT', headers, body: JSON.stringify({ yaml: rendered.yaml }) });
    expect(saved.status).toBe(200);
    expect(db.prepare("SELECT value_json FROM config_kv WHERE key='webui.passwordHash'").pluck().get()).toBe(JSON.stringify(hash));
    expect(db.prepare("SELECT value_json FROM config_kv WHERE key='tools.web.searchApiKey'").pluck().get()).toBe('"brave-key"');
    // 保住这件事要交回给运维：注释可能被连同整段删掉，响应是第二道说明。
    expect((await data<{ preserved: string[]; pruned: string[] }>(saved)).preserved)
      .toEqual(expect.arrayContaining(['webui.passwordHash', 'tools.web.searchApiKey']));
    closeDatabase(db);
  });

  // 一个字不改的往返必须是恒等变换。按段落库时 zod 已经把每个 `.default()` 填满，写回去的是填满
  // 之后那整棵子树 —— 生效覆盖叶子 73 → 171，凭空多出 98 个从没被覆盖过的键，值全等于当时的
  // 代码默认值；第二次往返起还幂等，界面上再也看不出来（docs/28 · L-WEB-02）。
  it('keeps a no-op YAML round trip identical instead of pinning code defaults', async () => {
    const { app, db, headers } = harness();
    expect((await app.request('/api/config', { method: 'PUT', headers, body: JSON.stringify({
      'context.limit.tokens': 48_000, 'output.mode': 'once', 'approval.rules': [{ tool: 'bash', pattern: 'rm\\s+-rf', risk: 'high' }],
      'tools.overrides': { web_fetch: { enabled: false } } }) })).status).toBe(200);
    expect((await app.request('/api/chats/chat%3A-100', { method: 'PATCH', headers, body: JSON.stringify({ output: { mode: 'once' } }) })).status).toBe(200);
    const before = effectiveLeaves(db);
    const rendered = await data<{ yaml: string }>(await app.request('/api/config/yaml', { headers: { cookie: headers.cookie } }));
    expect((await app.request('/api/config/yaml', { method: 'PUT', headers, body: JSON.stringify({ yaml: rendered.yaml }) })).status).toBe(200);
    expect(effectiveLeaves(db)).toEqual(before);
    // 数组仍按整块落库（`approval.rules` 逐个下标落库既没人这么读，也会被 sortOverrideKeys 拼回原样）。
    expect(db.prepare("SELECT COUNT(*) FROM config_kv WHERE key='approval.rules'").pluck().get()).toBe(1);
    // 再来一次仍然是恒等：幂等本身不是问题，钉死默认值才是。
    const second = await data<{ yaml: string }>(await app.request('/api/config/yaml', { headers: { cookie: headers.cookie } }));
    expect(second.yaml).toBe(rendered.yaml);
    closeDatabase(db);
  });

  // 「这份 YAML 是所提交段落的全量视图」：段里删掉一个键，那一行要真的从库里消失。此前靠
  // `writeConfigRows` 删掉祖先键的后代行来实现，改成叶子粒度之后必须显式算出删除集。
  it('drops overlay keys that the submitted YAML no longer carries', async () => {
    const { app, db, headers } = harness();
    expect((await app.request('/api/config', { method: 'PUT', headers, body: JSON.stringify({ 'context.limit.tokens': 48_000, 'context.limit.maxMessages': 150, 'output.mode': 'once' }) })).status).toBe(200);
    const saved = await app.request('/api/config/yaml', { method: 'PUT', headers, body: JSON.stringify({ yaml: 'context:\n  limit:\n    tokens: 48000\n' }) });
    expect(saved.status).toBe(200);
    expect((await data<{ pruned: string[] }>(saved)).pruned).toEqual(['context.limit.maxMessages']);
    expect(db.prepare("SELECT COUNT(*) FROM config_kv WHERE key='context.limit.maxMessages'").pluck().get()).toBe(0);
    // 删除也要进变更历史，否则历史瞒下了「谁把那条覆盖弄掉的」。
    expect(db.prepare("SELECT old_json,new_json FROM config_revisions WHERE key='context.limit.maxMessages' ORDER BY rowid DESC").get())
      .toMatchObject({ old_json: '150', new_json: null });
    // 没提交的那个顶层段一个字都不动：「这一段我不管」与「这一段清空」区分不出来，宁可不删。
    expect(db.prepare("SELECT value_json FROM config_kv WHERE key='output.mode'").pluck().get()).toBe('"once"');
    closeDatabase(db);
  });

  // 被 env 钉住的是**那个叶子**而不是它所在的整个顶层段：此前一条 LUOLI_WEBUI_HOST 就能让
  // `webui` 段其余的键在这条路上全都存不进去。
  it('skips only the env-pinned leaf on the YAML path', async () => {
    const { app, db, headers } = harness();
    const previous = process.env.LUOLI_WEBUI_HOST;
    process.env.LUOLI_WEBUI_HOST = '0.0.0.0';
    try {
      const saved = await app.request('/api/config/yaml', { method: 'PUT', headers, body: JSON.stringify({ yaml: 'webui:\n  host: 127.0.0.1\n  sessionTtlHours: 24\n' }) });
      expect(saved.status).toBe(200);
      const body = await data<{ keys: string[]; skipped: string[] }>(saved);
      expect(body.keys).toEqual(['webui.sessionTtlHours']);
      expect(body.skipped).toEqual(['webui.host']);
      expect(db.prepare("SELECT COUNT(*) FROM config_kv WHERE key='webui.host'").pluck().get()).toBe(0);
      expect(db.prepare("SELECT value_json FROM config_kv WHERE key='webui.sessionTtlHours'").pluck().get()).toBe('24');
    } finally {
      if (previous === undefined) delete process.env.LUOLI_WEBUI_HOST; else process.env.LUOLI_WEBUI_HOST = previous;
    }
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

  /**
   * 提示词页那张卡的副标题写着「查看他人的这份会被记录」，而这条路**根本不经过 `MemoryStore`**：
   * `GET /api/prompts/:id` 照 `memory_docs.path` 直接读文件，一条日志都不落（连 `memory.read`
   * 都没有），而同一组端点的 `PUT` 还能改别人那份（docs/29 · `M-MEM-01`）。
   */
  it('看 / 改他人的私有记忆都留痕，看自己那份不留', async () => {
    const { app, db, headers } = harness();
    const seed = db.prepare("INSERT INTO memory_docs(id,scope,subject,path,bytes,tokens,content_hash,updated_at) VALUES (?,'primemory',?,?,0,0,'seed',?)");
    mkdirSync('./data/config-prompts', { recursive: true });
    for (const subject of ['b', '1']) {
      writeFileSync(`./data/config-prompts/PRIMEMORY.${subject}.md`, '# 私有记忆\n');
      seed.run(`primemory:${subject}`, subject, `./data/config-prompts/PRIMEMORY.${subject}.md`, Date.now());
    }
    const audits = (): Array<{ userId: string | null; op: string }> => (db
      .prepare("SELECT user_id AS userId,data_json AS data FROM log_events WHERE kind='memory.owner_read_private' ORDER BY id")
      .all() as Array<{ userId: string | null; data: string }>)
      .map((row) => ({ userId: row.userId, op: String((JSON.parse(row.data) as { op: string }).op) }));

    expect((await app.request('/api/prompts/primemory:b', { headers: { cookie: headers.cookie } })).status).toBe(200);
    expect(audits()).toEqual([{ userId: 'b', op: 'read' }]);
    expect((await app.request('/api/prompts/primemory:b', { method: 'PUT', headers, body: JSON.stringify({ content: '# 私有记忆\n\n改过\n' }) })).status).toBe(200);
    expect(audits().at(-1)).toEqual({ userId: 'b', op: 'write' });
    // owner 看自己那份不记：`bootstrapOwnerId` 是 '1'。全记的话这条日志会被自己的噪声淹掉。
    expect((await app.request('/api/prompts/primemory:1', { headers: { cookie: headers.cookie } })).status).toBe(200);
    expect(audits()).toHaveLength(2);
    // 读不到文件时回 404，那不是一次「查看」，不该留痕。
    seed.run('primemory:gone', 'gone', './data/config-prompts/PRIMEMORY.gone.md', Date.now());
    expect((await app.request('/api/prompts/primemory:gone', { headers: { cookie: headers.cookie } })).status).toBe(404);
    expect(audits()).toHaveLength(2);
    closeDatabase(db);
  });
});
