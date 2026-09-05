import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ArchiveRepository, OperationsRepository, PrincipalRepository, closeDatabase, migrateDatabase, modelAliasKey, openDatabase, readAppKv, writeAppKv } from '@luoli/db';
import type { Sqlite } from '@luoli/db';
import { ContextEngine, DatabaseApprovalBroker, EventBus, LogSink, MaintenanceService, MemoryStore, PromptDocuments, ProviderStore, Secrets, configSchema } from '@luoli/core';
import { createServer } from '@luoli/server';
import { assignDotted, sortOverrideKeys } from '@luoli/shared';

function harness() {
  const path = './data/config-write.test.db';
  for (const suffix of ['', '-wal', '-shm', '-logs', '-logs-wal', '-logs-shm']) rmSync(`${path}${suffix}`, { force: true });
  const db = openDatabase(path); migrateDatabase(db);
  // `memory.dir` 需与 PromptDocuments 的根一致：`GET /api/prompts/:id` 按 `config.memory.dir`
  // 做包含性校验（docs/27 · S-07），两者指向不同目录的部署在生产中不存在。
  const config = configSchema.parse({ access: { bootstrapOwnerId: '1' }, webui: { passwordHash: 'secret-hash' }, memory: { dir: './data/config-prompts' } });
  const operations = new OperationsRepository(db); const events = new EventBus(); const log = new LogSink(operations); const archive = new ArchiveRepository(db);
  const promptDocuments = new PromptDocuments(db, './data/config-prompts'); promptDocuments.ensure();
  const memory = new MemoryStore(db, './data/config-prompts', 1500, 3000, 2, log);
  const app = createServer({ config, db, operations, principals: new PrincipalRepository(db), archive, context: new ContextEngine(db, archive), providers: new ProviderStore(db, new Secrets('x'.repeat(32))), approvals: new DatabaseApprovalBroker(db, config, events, log), maintenance: new MaintenanceService(db, path, 2, 30), promptDocuments, memory, events, log, configSchema: {}, startedAt: Date.now(), setup: undefined });
  const session = operations.createSession(1); const headers = { cookie: `luoli_sid=${session.id}`, 'x-csrf-token': session.csrf, 'content-type': 'application/json' };
  return { app, db, headers, memory };
}

const data = async <T>(response: Response): Promise<T> => (await response.json() as { data: T }).data;

/**
 * `config_kv` 展开成树之后的叶子集，即生效覆盖的真实计量。
 * 行数无法反映 docs/28 · L-WEB-02：按顶层段落库时 `config_kv` 的行数反而下降
 * （祖先键覆盖后代行），而生效覆盖叶子从 73 增至 171，新增部分全是当时的代码默认值。
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
   * 跨字段约束的报错必须自身表述清楚（docs/21 · G-CFG-08）。前端的 toast 只读取 `message`，
   * 而 `details` 此前无人读取，因此一次软上限被调大在界面上只显示配置校验失败，
   * 看不出与哪一项冲突。本条固定两件事：出问题的 path 进入 `message`，且 `details` 仍然存在。
   */
  it('names the offending key and the other side of a cross-field rule in the message itself', async () => {
    const { app, db, headers } = harness();
    const response = await app.request('/api/config', { method: 'PUT', headers, body: JSON.stringify({ 'memory.softLimitTokens': 4000 }) });
    expect(response.status).toBe(400);
    const error = (await response.json() as { error: { code: string; message: string; details: Array<{ path: string; message: string }> } }).error;
    expect(error.code).toBe('invalid_config');
    expect(error.message).toContain('memory.softLimitTokens');
    // 相关项的当前取值也要给出，否则运维需要在 200 多个值中查找硬上限。
    expect(error.message).toContain('3000');
    expect(error.details[0]).toMatchObject({ path: 'memory.softLimitTokens' });
    expect(db.prepare("SELECT COUNT(*) FROM config_kv WHERE key='memory.softLimitTokens'").pluck().get()).toBe(0);
    // 两项同时修改即可通过：该约束描述的是两项之间的关系，而非某一项不可修改。
    expect((await app.request('/api/config', { method: 'PUT', headers, body: JSON.stringify({ 'memory.softLimitTokens': 4000, 'memory.hardLimitTokens': 9000 }) })).status).toBe(200);
    closeDatabase(db);
  });

  it('accepts backtracking shapes under the linear regex engine and reports incompatible syntax', async () => {
    const { app, db, headers } = harness();
    const linear = await app.request('/api/config', { method: 'PUT', headers, body: JSON.stringify({ 'trigger.wakewords': ['洛璃', '^(a+)+$'] }) });
    expect(linear.status).toBe(200);
    const incompatible = await app.request('/api/config', { method: 'PUT', headers, body: JSON.stringify({ 'trigger.wakewords': ['洛璃', '^(?=璃)'] }) });
    expect(incompatible.status).toBe(400);
    // 拒绝时必须说明原因并指明具体条目：一份唤醒词中出错的通常只有一条，只返回 code
    // 等于要求运维逐条删除试错。
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
    // config_kv 的每一行都会成为下次启动的覆盖层：设置页写入的键必须仍能通过 configSchema 校验。
    expect(configSchema.parse({ output: { streamBufferMs: 3000 } }).output.streamBufferMs).toBe(3000);
    const invalid = await app.request('/api/config', { method: 'PUT', headers, body: JSON.stringify({ 'output.streamIntervalMs': 0 }) });
    expect(invalid.status).toBe(400);
    expect(db.prepare("SELECT value_json FROM config_kv WHERE key='output.streamIntervalMs'").pluck().get()).toBe('1500');
    closeDatabase(db);
  });

  // 会话页的覆盖面板依赖该语义：PATCH 是整体替换而非合并，因此界面每次都要连同需保留的
  // 项一起提交，取消覆盖同样通过提交一份不含该项的对象实现（docs/21 · G-API-09）。
  it('replaces the whole per-chat override object instead of merging', async () => {
    const { app, db, headers } = harness();
    const key = 'chat%3A-100';
    expect((await app.request(`/api/chats/${key}`, { method: 'PATCH', headers, body: JSON.stringify({ output: { mode: 'once' }, trigger: { mention: false } }) })).status).toBe(200);
    expect(JSON.parse(db.prepare("SELECT value_json FROM config_kv WHERE key='perChat.chat:-100'").pluck().get() as string))
      .toEqual({ output: { mode: 'once' }, trigger: { mention: false } });
    // 只提交 output 部分：trigger 部分会被整体替换，而不会保留在数据库中。
    expect((await app.request(`/api/chats/${key}`, { method: 'PATCH', headers, body: JSON.stringify({ output: { mode: 'once' } }) })).status).toBe(200);
    expect(JSON.parse(db.prepare("SELECT value_json FROM config_kv WHERE key='perChat.chat:-100'").pluck().get() as string)).toEqual({ output: { mode: 'once' } });
    // 空对象表示该会话不覆盖任何配置，且仍能通过 configSchema 校验（下次启动不会因此拒绝加载）。
    expect((await app.request(`/api/chats/${key}`, { method: 'PATCH', headers, body: '{}' })).status).toBe(200);
    expect(configSchema.parse({ perChat: { 'chat:-100': {} } }).perChat).toEqual({ 'chat:-100': {} });
    closeDatabase(db);
  });

  // 自动生成的表单依据这三项决定控件形态与热更新、需重启、未接线徽标：挂在信封顶层的
  // 兄弟键会被只解析 `data` 的客户端静默丢弃，导致表单把每一项都视为需重启（docs/21 §1.1）。
  it('serves schema, hot-reload prefixes, and unimplemented keys inside one data envelope', async () => {
    const { app, db, headers } = harness();
    const response = await app.request('/api/config/schema', { headers: { cookie: headers.cookie } });
    const payload = await response.json() as { ok: boolean; data: { schema: unknown; hotReloadable: string[]; unimplemented: string[]; enumNotes: Record<string, Record<string, string>> } };
    expect(payload.ok).toBe(true);
    expect(payload.data.schema).toBeDefined();
    expect(payload.data.hotReloadable).toContain('logs.level');
    expect(payload.data.unimplemented).toContain('trigger.ignoreEditedAsTrigger');
    // 第四份是逐取值的说明。缺少它时，取值受限的那几项会渲染成一排没有说明的复选框。
    expect(payload.data.enumNotes['telegram.allowedUpdates']?.message).toContain('已处理');
    expect(payload.data.enumNotes['telegram.allowedUpdates']?.message_reaction).toContain('无处理器');
    closeDatabase(db);
  });

  // 整块写入代表整棵子树：保留更细粒度的行会局部覆盖它（界面表现为 JSON 中显示为开启而
  // 刷新后仍为关闭）。作废同样要记入变更历史，否则历史中缺少该逐项覆盖被谁移除的记录。
  it('subsumes finer-grained rows when an ancestor key is written, and says so', async () => {
    const { app, db, headers } = harness();
    expect((await app.request('/api/tools/web_fetch', { method: 'PATCH', headers, body: JSON.stringify({ enabled: false }) })).status).toBe(200);
    expect(db.prepare("SELECT COUNT(*) FROM config_kv WHERE key='tools.overrides.web_fetch'").pluck().get()).toBe(1);
    const response = await app.request('/api/config', { method: 'PUT', headers, body: JSON.stringify({ 'tools.overrides': { web_fetch: { enabled: true } } }) });
    expect(response.status).toBe(200);
    expect((await response.json() as { data: { subsumed: string[] } }).data.subsumed).toEqual(['tools.overrides.web_fetch']);
    expect(db.prepare("SELECT COUNT(*) FROM config_kv WHERE key='tools.overrides.web_fetch'").pluck().get()).toBe(0);
    // 被作废的那一行留下一条 new_json 为空的 revision 记录。
    const removal = db.prepare("SELECT old_json,new_json FROM config_revisions WHERE key='tools.overrides.web_fetch' ORDER BY rowid DESC").get() as { old_json: string | null; new_json: string | null };
    expect(removal).toMatchObject({ old_json: '{"enabled":false}', new_json: null });
    closeDatabase(db);
  });

  // 沙箱的 mode 与 bypassRoles 属于安全相关配置，此前 PUT /api/sandbox 只写 config_kv 而不写 revision，
  // 变更历史中完全无法看到它被谁修改过（docs/21 · G-CFG-06）。
  it('records sandbox writes in the configuration history', async () => {
    const { app, db, headers } = harness();
    expect((await app.request('/api/sandbox', { method: 'PUT', headers, body: JSON.stringify({ mode: 'none' }) })).status).toBe(200);
    expect(db.prepare("SELECT new_json FROM config_revisions WHERE key='sandbox.mode'").pluck().get()).toBe('"none"');
    closeDatabase(db);
  });

  // `tools.fs.allowHostFsForOwner` 不在 `sandbox.*` 之下（PUT /api/sandbox 会为每个键添加前缀），
  // 但它管理的是同一问题的另一半：谁可以绕过隔离。沙箱页需要展示它，因此 GET 要携带该字段；
  // 此前该页面上搜索它零命中，只能从全部配置中修改（docs/29 · M-WEB-10）。
  it('沙箱详情带上 allowHostFsForOwner，写回仍走配置那条路', async () => {
    const { app, db, headers } = harness();
    const detail = await data<{ allowHostFsForOwner: boolean; config: Record<string, unknown> }>(await app.request('/api/sandbox', { headers: { cookie: headers.cookie } }));
    expect(detail.allowHostFsForOwner).toBe(false);
    // 写回未一并迁移到 `PUT /api/sandbox`：该路径会为每个键添加 `sandbox.` 前缀，
    // 写入后只会产生一个 schema 中不存在的 `sandbox.allowHostFsForOwner`。仍走配置路径。
    expect((await app.request('/api/config', { method: 'PUT', headers, body: JSON.stringify({ 'tools.fs.allowHostFsForOwner': true }) })).status).toBe(200);
    expect(db.prepare("SELECT value_json FROM config_kv WHERE key='tools.fs.allowHostFsForOwner'").pluck().get()).toBe('true');
    closeDatabase(db);
  });

  // 被环境变量固定的键即使写入 config_kv，也会在下次 loadConfig 时被覆盖：应拒绝而非返回虚假成功。
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
      // 通过祖先键写入对该叶子同样无效，因此同样拒绝。
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

  // 密钥字段在 GET /api/config 中显示为 «redacted»。把读取到的值原样提交回去（`mcp.servers` 这类
  // 整块 JSON 最易发生）等于用占位文本覆盖真实密钥，且该行会持续生效。
  it('refuses values that still carry the «redacted» placeholder', async () => {
    const { app, db, headers } = harness();
    const response = await app.request('/api/config', { method: 'PUT', headers, body: JSON.stringify({ 'tools.web.searchApiKey': '«redacted»' }) });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: { code: string } }).error.code).toBe('redacted_placeholder');
    // 真实值仍可正常写入：密钥字段在界面上是只写而非只读。
    expect((await app.request('/api/config', { method: 'PUT', headers, body: JSON.stringify({ 'tools.web.searchApiKey': 'brave-key-1' }) })).status).toBe(200);
    expect(db.prepare("SELECT value_json FROM config_kv WHERE key='tools.web.searchApiKey'").pluck().get()).toBe('"brave-key-1"');
    // 但变更历史中必须脱敏（docs/09 §3.13 的承诺）：第二次写入时新旧两侧都不得出现真实值。
    expect((await app.request('/api/config', { method: 'PUT', headers, body: JSON.stringify({ 'tools.web.searchApiKey': 'brave-key-2' }) })).status).toBe(200);
    const revisions = db.prepare("SELECT old_json,new_json FROM config_revisions WHERE key='tools.web.searchApiKey' ORDER BY rowid").all() as Array<{ old_json: string | null; new_json: string | null }>;
    expect(revisions).toEqual([{ old_json: null, new_json: '"«redacted»"' }, { old_json: '"«redacted»"', new_json: '"«redacted»"' }]);
    // 嵌套在结构中的密钥同样脱敏（`mcp.servers` 的 env 与 headers），而 config_kv 中存储的仍是真实值。
    const server = [{ name: 'demo', transport: 'stdio', command: 'node', env: { API_TOKEN: 'super-secret' } }];
    expect((await app.request('/api/config', { method: 'PUT', headers, body: JSON.stringify({ 'mcp.servers': server }) })).status).toBe(200);
    expect(db.prepare("SELECT value_json FROM config_kv WHERE key='mcp.servers'").pluck().get()).toContain('super-secret');
    expect(db.prepare("SELECT new_json FROM config_revisions WHERE key='mcp.servers'").pluck().get()).not.toContain('super-secret');
    closeDatabase(db);
  });

  // 审批规则此前是 z.record(z.unknown())：字段名写错或正则无法编译的规则在运行时被静默丢弃，
  // 而写入端一律返回 200；一道静默失效的审批门等同于未设防（docs/21 · G-CFG-07）。
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

  // /model 写入的是 app_kv，却优先于 WebUI 可修改的 agent.main.modelAlias：界面上必须可见且可清除。
  it('surfaces the per-chat model alias from app_kv and clears it', async () => {
    const { app, db, headers } = harness();
    writeAppKv(db, modelAliasKey('chat:-100'), 'high', 'command:7');
    const detail = await app.request('/api/chats/chat%3A-100', { headers: { cookie: headers.cookie } });
    expect((await detail.json() as { data: { modelAlias: string | null } }).data.modelAlias).toBe('high');
    const cleared = await app.request('/api/chats/chat%3A-100/model-alias', { method: 'DELETE', headers });
    expect((await cleared.json() as { data: { cleared: boolean } }).data.cleared).toBe(true);
    expect(readAppKv(db, modelAliasKey('chat:-100'))).toBeUndefined();
    // 本就不存在别名时不报告已清除。
    expect((await (await app.request('/api/chats/chat%3A-100/model-alias', { method: 'DELETE', headers })).json() as { data: { cleared: boolean } }).data.cleared).toBe(false);
    closeDatabase(db);
  });

  /**
   * 设置页的高级 tab 流程为 `GET /api/config/yaml` → 编辑 → `PUT`。密钥类行不在 GET 返回的树中
   * （整行跳过），因此树中不存在绝不能视为运维已删除；该往返曾经清除了 `webui.passwordHash`，
   * `main.ts` 的 `if (!config.webui.passwordHash)` 随即生效、进程静默退回 setup-token 形态，
   * 而 `host` 为默认回环地址时 schema 的 `superRefine` 不会拦截（docs/28 · L-WEB-04）。
   */
  it('never drops secret overlay rows through a YAML round trip', async () => {
    const { app, db, headers } = harness();
    const hash = '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2g';
    // 同一段中必须还有其他键，否则该段根本不会被提交，也就不会被误删，真实部署即如此。
    expect((await app.request('/api/config', { method: 'PUT', headers, body: JSON.stringify({
      'webui.passwordHash': hash, 'webui.sessionTtlHours': 24, 'tools.web.searchApiKey': 'brave-key', 'tools.web.searchProvider': 'brave' }) })).status).toBe(200);
    const rendered = await data<{ yaml: string; skipped: string[] }>(await app.request('/api/config/yaml', { headers: { cookie: headers.cookie } }));
    expect(rendered.skipped).toEqual(expect.arrayContaining(['webui.passwordHash', 'tools.web.searchApiKey']));
    expect(rendered.yaml).not.toContain(hash);
    // 顶部生成的注释逐条列出：响应中的 `skipped` 数组在编辑器中不可见（docs/09 §3.13）。
    expect(rendered.yaml).toContain('#   webui.passwordHash');
    expect(rendered.yaml).toContain('#   tools.web.searchApiKey');
    expect(rendered.yaml).toContain('删除这段注释也不会');
    const saved = await app.request('/api/config/yaml', { method: 'PUT', headers, body: JSON.stringify({ yaml: rendered.yaml }) });
    expect(saved.status).toBe(200);
    expect(db.prepare("SELECT value_json FROM config_kv WHERE key='webui.passwordHash'").pluck().get()).toBe(JSON.stringify(hash));
    expect(db.prepare("SELECT value_json FROM config_kv WHERE key='tools.web.searchApiKey'").pluck().get()).toBe('"brave-key"');
    // 该信息需同时返回给运维：注释可能随整段被删除，响应是第二道说明。
    expect((await data<{ preserved: string[]; pruned: string[] }>(saved)).preserved)
      .toEqual(expect.arrayContaining(['webui.passwordHash', 'tools.web.searchApiKey']));
    closeDatabase(db);
  });

  // 未做任何修改的往返必须是恒等变换。按段落库时 zod 已填满每个 `.default()`，写回的是填充
  // 之后的整棵子树，导致生效覆盖叶子从 73 增至 171，凭空多出 98 个从未被覆盖的键，取值全等于当时的
  // 代码默认值；从第二次往返起又恢复幂等，界面上无法再察觉（docs/28 · L-WEB-02）。
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
    // 数组仍按整块落库（`approval.rules` 逐下标落库既无人如此读取，也会被 sortOverrideKeys 还原）。
    expect(db.prepare("SELECT COUNT(*) FROM config_kv WHERE key='approval.rules'").pluck().get()).toBe(1);
    // 再次执行仍为恒等：幂等本身不是问题，把默认值固化下来才是。
    const second = await data<{ yaml: string }>(await app.request('/api/config/yaml', { headers: { cookie: headers.cookie } }));
    expect(second.yaml).toBe(rendered.yaml);
    closeDatabase(db);
  });

  // 该 YAML 是所提交段落的完整视图：段中删除一个键时，对应行必须真正从数据库中移除。此前依靠
  // `writeConfigRows` 删除祖先键的后代行实现，改为叶子粒度之后必须显式计算删除集。
  it('drops overlay keys that the submitted YAML no longer carries', async () => {
    const { app, db, headers } = harness();
    expect((await app.request('/api/config', { method: 'PUT', headers, body: JSON.stringify({ 'context.limit.tokens': 48_000, 'context.limit.maxMessages': 150, 'output.mode': 'once' }) })).status).toBe(200);
    const saved = await app.request('/api/config/yaml', { method: 'PUT', headers, body: JSON.stringify({ yaml: 'context:\n  limit:\n    tokens: 48000\n' }) });
    expect(saved.status).toBe(200);
    expect((await data<{ pruned: string[] }>(saved)).pruned).toEqual(['context.limit.maxMessages']);
    expect(db.prepare("SELECT COUNT(*) FROM config_kv WHERE key='context.limit.maxMessages'").pluck().get()).toBe(0);
    // 删除同样要记入变更历史，否则历史中缺少该覆盖被谁移除的记录。
    expect(db.prepare("SELECT old_json,new_json FROM config_revisions WHERE key='context.limit.maxMessages' ORDER BY rowid DESC").get())
      .toMatchObject({ old_json: '150', new_json: null });
    // 未提交的顶层段不做任何改动：本段不处理与本段清空无法区分，因此选择不删除。
    expect(db.prepare("SELECT value_json FROM config_kv WHERE key='output.mode'").pluck().get()).toBe('"once"');
    closeDatabase(db);
  });

  // 被 env 固定的是该叶子而非它所在的整个顶层段：此前一条 LUOLI_WEBUI_HOST 就会导致
  // `webui` 段其余的键在这条路径上全部无法保存。
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
    // T2.5：ensure() 按来源 upsert，id 从 `assist:global` 改为 `assist:<sourceId>`——
    // harness() 只有内建 telegram 来源，因此是 `assist:telegram`。
    const response = await app.request('/api/prompts/assist:telegram', { method: 'PUT', headers, body: JSON.stringify({ content: '# Assist\n\nupdated\n' }) });
    expect(response.status).toBe(200);
    const revision = db.prepare("SELECT diff FROM memory_revisions WHERE doc_id='assist:telegram' ORDER BY ts DESC").pluck().get() as string;
    expect(revision).toContain('--- before');
    expect(revision).toContain('+++ after');
    const revisionId = db.prepare("SELECT id FROM memory_revisions WHERE doc_id='assist:telegram' ORDER BY ts DESC").pluck().get() as string;
    const rollback = await app.request('/api/prompts/assist:telegram/rollback', { method: 'POST', headers, body: JSON.stringify({ revisionId }) });
    expect(rollback.status).toBe(200);
    expect((await app.request('/api/prompts/assist:telegram', { headers: { cookie: headers.cookie } })).status).toBe(200);
    closeDatabase(db);
  });

  /**
   * 提示词页那张卡的副标题声明查看他人内容会被记录，而这条路径根本不经过 `MemoryStore`：
   * `GET /api/prompts/:id` 按 `memory_docs.path` 直接读取文件，不产生任何日志（连 `memory.read`
   * 都没有），而同一组端点的 `PUT` 还可修改他人的内容（docs/29 · `M-MEM-01`）。
   */
  it('看 / 改他人的私有记忆都留痕，看自己那份不留', async () => {
    // `harness()` 只清库文件，不清 `./data/config-prompts` 目录：F-2② 的两条 `existsSync`
    // 断言按磁盘落点判定，跨测试重跑残留的旧文件会让它们读到假阳性，因此这里先清一次。
    rmSync('./data/config-prompts', { recursive: true, force: true });
    const { app, db, headers, memory } = harness();
    const seed = db.prepare("INSERT INTO memory_docs(id,scope,subject,path,bytes,tokens,content_hash,updated_at) VALUES (?,'primemory',?,?,0,0,'seed',?)");
    mkdirSync('./data/config-prompts', { recursive: true });
    // T2.5：primemory 的 subject 自 0019 迁移起是复合键 `<sourceId>:<sessionId>`——裸 `'b'`/`'1'`
    // 会在 `save()` 内 `splitPrimemorySubject()` 处直接抛错（PUT 500）。这里的 `path` 仍是这条
    // 用例自定义的旧式扁平路径：`GET` 按 `memory_docs.path` 直接读文件，与 subject 形态无关。
    for (const subject of ['b', '1']) {
      writeFileSync(`./data/config-prompts/PRIMEMORY.${subject}.md`, '# 私有记忆\n');
      seed.run(`primemory:telegram:${subject}`, `telegram:${subject}`, `./data/config-prompts/PRIMEMORY.${subject}.md`, Date.now());
    }
    const audits = (): Array<{ userId: string | null; op: string }> => (db
      .prepare("SELECT user_id AS userId,data,data_codec AS codec FROM log_events WHERE kind='memory.owner_read_private' ORDER BY id")
      .all() as Array<{ userId: string | null; data: string }>)
      .map((row) => ({ userId: row.userId, op: String((JSON.parse(row.data) as { op: string }).op) }));

    expect((await app.request('/api/prompts/primemory:telegram:b', { headers: { cookie: headers.cookie } })).status).toBe(200);
    // F-2①（qa-T2-3）：审计的 userId 是裸 sessionId（'b'），不是复合 subject（'telegram:b'）——
    // 否则 `lastOwnerRead('b')`（bot.ts 的 /memory 命令读它）恒查不到这条记录。
    expect(audits()).toEqual([{ userId: 'b', op: 'read' }]);
    expect(memory.lastOwnerRead('b')).not.toBeNull();
    expect((await app.request('/api/prompts/primemory:telegram:b', { method: 'PUT', headers, body: JSON.stringify({ content: '# 私有记忆\n\n改过\n' }) })).status).toBe(200);
    expect(audits().at(-1)).toEqual({ userId: 'b', op: 'write' });
    // F-2②（qa-T2-3）：`save()` 按新布局把复合 subject 拆开落盘到
    // `sources/<sourceId>/private/<sessionId>/PRIMEMORY.md`，目录名不含 `:`——旧实现会把整段
    // 复合 subject 当成一个目录名（`private/telegram:b/`），`MemoryStore` 永远读不到那份内容。
    const newPath = './data/config-prompts/sources/telegram/private/b/PRIMEMORY.md';
    expect(existsSync(newPath)).toBe(true);
    expect(readFileSync(newPath, 'utf8')).toContain('改过');
    expect(existsSync('./data/config-prompts/private/telegram:b')).toBe(false);
    // owner 查看自己的内容不记录：`bootstrapOwnerId` 为 '1'。全部记录会让该日志被自身噪声淹没。
    expect((await app.request('/api/prompts/primemory:telegram:1', { headers: { cookie: headers.cookie } })).status).toBe(200);
    expect(audits()).toHaveLength(2);
    // 读取不到文件时返回 404，那不构成一次查看，不应留下记录。
    seed.run('primemory:telegram:gone', 'telegram:gone', './data/config-prompts/PRIMEMORY.gone.md', Date.now());
    expect((await app.request('/api/prompts/primemory:telegram:gone', { headers: { cookie: headers.cookie } })).status).toBe(404);
    expect(audits()).toHaveLength(2);
    closeDatabase(db);
  });
});
