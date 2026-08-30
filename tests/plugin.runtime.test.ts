import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { ContextEngine, HOT_RELOAD_UNRELIABLE_HINT, LogSink, MemoryStore, PluginManager, QuotaGuard, ToolRegistry, TurnConcurrency, TurnRegistry, configSchema, isHotReloadReliable } from '@luoli/core';
import type { ToolExecutionContext } from '@luoli/core';
import { ArchiveRepository, OperationsRepository, PrincipalRepository, TurnRepository } from '@luoli/db';
import { createTelegramBot } from '@luoli/telegram';
import { logRows } from './support/logs.js';

const botInfo = { id: 1, is_bot: true as const, first_name: 'Bot', username: 'mybot', can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false };
const privateUpdate = (id: number, text: string): never => ({ update_id: id, message: { message_id: id, date: Math.floor(Date.now() / 1000),
  chat: { id: 500, type: 'private', first_name: 'User' }, from: { id: 500, is_bot: false, first_name: 'User' }, text } }) as never;

function setup() {
  const database = './data/plugin-runtime.test.db';
  const directory = './data/plugin-runtime-plugins';
  (globalThis as { __pluginUnloads?: number }).__pluginUnloads = 0;
  for (const suffix of ['', '-wal', '-shm', '-logs', '-logs-wal', '-logs-shm']) rmSync(`${database}${suffix}`, { force: true });
  rmSync(directory, { recursive: true, force: true }); mkdirSync(`${directory}/alpha`, { recursive: true }); mkdirSync(`${directory}/beta`, { recursive: true });
  for (const name of ['alpha', 'beta']) writeFileSync(`${directory}/${name}/plugin.js`, `export default { name:'${name}', hooks:{ ping: () => '${name}' }, onUnload: () => globalThis.__pluginUnloads = (globalThis.__pluginUnloads ?? 0) + 1, tools: () => ({ echo: { description:'echo', inputSchema:{}, execute: input => input } }) };`);
  const db = openDatabase(database); migrateDatabase(db);
  const insert = db.prepare('INSERT INTO plugins(name,path,min_role,enabled,config_json,updated_at) VALUES (?,?,?,1,?,?)');
  insert.run('alpha', `${directory}/alpha/plugin.js`, 'trusted', '{}', Date.now()); insert.run('beta', `${directory}/beta/plugin.js`, 'trusted', '{}', Date.now());
  const log = new LogSink(new OperationsRepository(db), [], { level: 'debug', console: 'off' });
  const registry = new ToolRegistry(log, { request: async () => true }, { maxRegistered: 80, maxCallsPerTurn: 40, maxConsecutiveErrors: 3 });
  return { db, registry, log, manager: new PluginManager(db, directory, 1000, 3, ['beta', 'alpha'], registry, undefined, log) };
}

/** 一个只有 hooks 的插件目录，用来单独测钩子失败那一路。 */
function hookOnly(name: string, body: string) {
  const database = `./data/${name}.test.db`;
  const directory = `./data/${name}-plugins`;
  for (const suffix of ['', '-wal', '-shm', '-logs', '-logs-wal', '-logs-shm']) rmSync(`${database}${suffix}`, { force: true });
  rmSync(directory, { recursive: true, force: true });
  rmSync(`./data/${name}-logs`, { recursive: true, force: true });
  mkdirSync(`${directory}/hooky`, { recursive: true });
  writeFileSync(`${directory}/hooky/plugin.js`, `export default { name:'hooky', hooks:{ beforeTurn: ${body} } };`);
  const db = openDatabase(database); migrateDatabase(db);
  db.prepare('INSERT INTO plugins(name,path,min_role,enabled,config_json,updated_at) VALUES (?,?,?,1,?,?)')
    .run('hooky', `${directory}/hooky/plugin.js`, 'trusted', '{}', Date.now());
  const log = new LogSink(new OperationsRepository(db), [], { level: 'debug', console: 'off' });
  // `hookTimeoutMs = 2000` → 慢钩子判据是 `max(50, 200) = 200ms`。
  return { db, log, manager: new PluginManager(db, directory, 2000, 3, [], undefined, undefined, log) };
}
const rowsOf = (db: ReturnType<typeof openDatabase>, kind: string): Array<{ level: string; summary: string; data: string | null }> =>
  logRows(db, kind);

describe('plugin runtime', () => {
  it('loads enabled plugins, preserves configured order, exposes tools, and runs hooks', async () => {
    const { db, manager, registry } = setup(); await manager.reconcile();
    expect(manager.list().map((entry) => entry.name)).toEqual(['beta', 'alpha']);
    expect(manager.toolEntries().map((entry) => entry.name)).toEqual(['beta_echo', 'alpha_echo']);
    expect(registry.names()).toEqual(['alpha_echo', 'beta_echo']);
    const context: ToolExecutionContext = { turn: { turnId: 't', key: 'k', chatId: 'c', threadId: null, initiatorUserId: 'u', effectiveRole: 'trusted', isPrivate: false, baseCommitId: null, snapshot: { messages: [], ordinals: [], tokens: 0, windowStart: 1, headOrdinal: 0 }, delta: [], abortSignal: new AbortController().signal, config: {} }, workspace: '.', agentKind: 'main' };
    expect(registry.activeNames('limited', context)).toEqual([]);
    expect(registry.activeNames('trusted', context)).toEqual(['alpha_echo', 'beta_echo']);
    expect((await manager.hook('ping')).map((entry) => entry.result)).toEqual(['beta', 'alpha']);
    await manager.reconcile();
    expect((globalThis as { __pluginUnloads?: number }).__pluginUnloads ?? 0).toBe(0);
    writeFileSync('./data/plugin-runtime-plugins/alpha/plugin.js', `export default { name:'alpha', hooks:{ ping: () => 'alpha-v2' }, onUnload: () => globalThis.__pluginUnloads = (globalThis.__pluginUnloads ?? 0) + 1, tools: () => ({ echo: { description:'echo', inputSchema:{}, execute: input => input } }) };`);
    await manager.reconcile();
    expect((globalThis as { __pluginUnloads?: number }).__pluginUnloads).toBe(1);
    expect((await manager.hook('ping')).map((entry) => entry.result)).toEqual(['beta', 'alpha-v2']);
    await manager.close(); closeDatabase(db);
  });

  /**
   * `version` 与 `provides_json` 这两列建表时就有、扩展页也一直认真读（`pluginProvides` 把它渲染成
   * 「2 个工具 · 1 个 hook」），而在这之前**没有任何一条 SQL 写过它们** —— 于是每张卡片都说
   * 「没有声明任何 tool / hook / command」，哪怕这份 plugin 已经注册了工具（docs/29 · `M-WEB-14`）。
   */
  it('装载成功写下 version 与 provides_json，装不起来就清空它', async () => {
    const { db, manager } = setup();
    writeFileSync('./data/plugin-runtime-plugins/alpha/plugin.js',
      "export default { name:'alpha', version:'2.1.0', hooks:{ ping: () => 'a', beforeTurn: () => undefined }, tools: () => ({ echo: { description:'echo', inputSchema:{}, execute: input => input } }) };");
    await manager.reconcile();
    const row = () => db.prepare('SELECT version,provides_json AS provides,load_error AS error FROM plugins WHERE name=?')
      .get('alpha') as { version: string | null; provides: string | null; error: string | null };
    expect(row().version).toBe('2.1.0');
    // 写的是**这一次真的装载到的**东西，不是清单里的声明。
    expect(JSON.parse(row().provides!)).toEqual({ tools: ['echo'], hooks: ['ping', 'beforeTurn'] });
    // 没声明 version 的照旧是 null，不要编一个出来。
    expect((db.prepare('SELECT version FROM plugins WHERE name=?').get('beta') as { version: string | null }).version).toBeNull();
    // 装不起来就什么都没提供：留着上一次的清单，卡片会一边显红一边说「1 个工具」。
    writeFileSync('./data/plugin-runtime-plugins/alpha/plugin.js', 'export default { name:');
    await manager.reconcile();
    expect(row().error).toBeTruthy();
    expect(row().provides).toBeNull();
    await manager.close(); closeDatabase(db);
  });

  it('discovers files as disabled rows before any database seed', async () => {
    const database = './data/plugin-discovery.test.db'; const directory = './data/plugin-discovery-plugins';
    for (const suffix of ['', '-wal', '-shm', '-logs', '-logs-wal', '-logs-shm']) rmSync(`${database}${suffix}`, { force: true });
    rmSync(directory, { recursive: true, force: true }); mkdirSync(`${directory}/new-plugin`, { recursive: true });
    writeFileSync(`${directory}/new-plugin/plugin.js`, "export default { name:'new-plugin', minRole:'owner', tools:() => ({}) };");
    const db = openDatabase(database); migrateDatabase(db); const manager = new PluginManager(db, directory, 1000, 3);
    await manager.reconcile();
    expect(db.prepare('SELECT name,path,min_role AS minRole,enabled FROM plugins').get()).toMatchObject({ name: 'new-plugin', minRole: 'trusted', enabled: 0 });
    db.prepare('UPDATE plugins SET enabled=1 WHERE name=?').run('new-plugin'); await manager.reconcile();
    expect(manager.list().map((plugin) => plugin.name)).toEqual(['new-plugin']);
    expect(db.prepare('SELECT min_role AS minRole FROM plugins WHERE name=?').get('new-plugin')).toEqual({ minRole: 'owner' });
    await manager.close(); closeDatabase(db);
  });

  /**
   * `AC-PLG-004`：钩子抛异常被 catch 住、**只记 `plugin.error`**、轮次照常完成。
   *
   * 此前单次失败只 `plugin.errors += 1`，要累计到 `plugins.autoDisableAfterErrors` 才经告警落一行，
   * 而那一行还受 `alerts.on`（默认 `[]`）与 `dedupeMinutes` 管 —— 实测一个三轮必抛的 `beforeTurn`，
   * 与 plugin 有关的日志 **0 条**（docs/28 · L-LOG-01）。
   */
  it('单次钩子失败就记一条 plugin.error，第三次连带自动禁用', async () => {
    const { db, manager } = hookOnly('plugin-hook-error', "() => { throw new Error('boom'); }");
    await manager.reconcile();
    // 第一次：只有 plugin.error，插件还开着 —— 「前 disableAfter-1 次静默」正是被修掉的那件事。
    expect(await manager.hook('beforeTurn')).toEqual([]);
    let errors = rowsOf(db, 'plugin.error');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.level).toBe('warn');
    expect(errors[0]!.summary).toContain('hooky.beforeTurn');
    expect(JSON.parse(errors[0]!.data!)).toMatchObject({ plugin: 'hooky', hook: 'beforeTurn', errors: 1, disabled: false });
    await manager.hook('beforeTurn');
    await manager.hook('beforeTurn');
    errors = rowsOf(db, 'plugin.error');
    expect(errors).toHaveLength(3);
    expect(JSON.parse(errors[2]!.data!)).toMatchObject({ errors: 3, disabled: true });
    // 失败之外一条别的都不记：`plugin.hook` 是给「慢」用的，抛错的那次没有耗时可言。
    expect(rowsOf(db, 'plugin.hook')).toHaveLength(0);
    await manager.close(); closeDatabase(db);
  });

  /**
   * `plugin.hook` 只记慢的那一次。钩子每轮要跑好几次（`onToolCall` 是每次工具调用一次），
   * 逐次记会把 `logs.level='debug'` 的部署刷爆 —— 判据与门槛都写在 `docs/10 §2` 那一行里。
   */
  it('快钩子一条都不记，慢钩子记一条带耗时', async () => {
    const fast = hookOnly('plugin-hook-fast', '() => 1');
    await fast.manager.reconcile();
    await fast.manager.hook('beforeTurn');
    expect(rowsOf(fast.db, 'plugin.hook')).toHaveLength(0);
    await fast.manager.close(); closeDatabase(fast.db);

    const slow = hookOnly('plugin-hook-slow', '() => new Promise((resolve) => setTimeout(resolve, 260))');
    await slow.manager.reconcile();
    await slow.manager.hook('beforeTurn');
    const rows = slow.db.prepare("SELECT level,summary,duration_ms AS ms FROM log_events WHERE kind='plugin.hook'").all() as Array<{ level: string; summary: string; ms: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.level).toBe('debug');
    expect(rows[0]!.ms).toBeGreaterThanOrEqual(200);
    await slow.manager.close(); closeDatabase(slow.db);
  });

  /**
   * `AC-PLG-008`：`onMessage` 回 `{drop:true}` 的那条消息**既不入库也不开轮**。
   *
   * 两半都要断。只挡触发的话消息照旧进 `messages` 表，下一轮以背景发言的身份被 `claimBackground`
   * 读回上下文里 —— 「这条别让它看见」在用户那边看着生效了，在模型那边一个字没少。反过来只挡入库
   * 也不行：一条不在库里的消息照样能把轮次开起来，然后模型对着一条查不到出处的话回答。
   */
  it('onMessage 回 {drop:true} 的消息不入库也不开轮，同一条路上不 drop 的照常', async () => {
    const name = 'plugin-drop-message';
    const database = `./data/${name}.test.db`;
    const directory = `./data/${name}-plugins`;
    for (const suffix of ['', '-wal', '-shm', '-logs', '-logs-wal', '-logs-shm']) rmSync(`${database}${suffix}`, { force: true });
    for (const path of [directory, `./data/${name}-logs`, `./data/${name}-memory`]) rmSync(path, { recursive: true, force: true });
    mkdirSync(`${directory}/dropper`, { recursive: true });
    // 按正文挑着 drop：同一个插件、同一条钩子里出两种答复，正对照就不必换一套装配。
    writeFileSync(`${directory}/dropper/plugin.js`,
      "export default { name:'dropper', hooks:{ onMessage: (ctx) => ({ drop: String(ctx.message?.text ?? '').includes('别看') }) } };");
    const db = openDatabase(database); migrateDatabase(db);
    db.prepare('INSERT INTO plugins(name,path,min_role,enabled,config_json,updated_at) VALUES (?,?,?,1,?,?)')
      .run('dropper', `${directory}/dropper/plugin.js`, 'trusted', '{}', Date.now());
    const manager = new PluginManager(db, directory, 1000, 3);
    await manager.reconcile();
    const config = configSchema.parse({ access: { defaultUserRole: 'trusted', defaultChatRole: 'trusted', bootstrapOwnerId: '1' },
      quota: { enabled: false }, output: { mode: 'once', replyDelayMs: 0 } });
    const archive = new ArchiveRepository(db); const operations = new OperationsRepository(db);
    const opened: string[] = [];
    const bot = await createTelegramBot('12345678:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', {
      config, db, principals: new PrincipalRepository(db), archive, operations, context: new ContextEngine(db, archive), turns: new TurnRepository(db),
      quota: new QuotaGuard(db, 'UTC'), memory: new MemoryStore(db, `./data/${name}-memory`, 1500, 3000), registry: new TurnRegistry(),
      concurrency: new TurnConcurrency(config.concurrency), log: new LogSink(operations), botInfo, plugins: manager,
      onTurn: async (turn) => { opened.push(turn.turnId); return '好的'; } });
    bot.api.config.use((async (_prev: unknown, method: string, payload: Record<string, unknown>) => ({ ok: true,
      result: method === 'sendMessage' || method === 'editMessageText'
        ? { message_id: 900, date: 0, chat: { id: 500, type: 'private' }, text: String(payload.text ?? '') } : true })) as never);
    // 私聊，本来必触发。drop 之后归档表整张空 —— 连 `direction='out'` 都不该有，因为轮次压根没开。
    await bot.handleUpdate(privateUpdate(1, '这条别看'));
    expect(db.prepare('SELECT COUNT(*) FROM messages').pluck().get()).toBe(0);
    expect(opened).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) FROM turns').pluck().get()).toBe(0);
    // 正对照：同一个插件回 `{drop:false}` 的那条，两件事都照常发生。
    await bot.handleUpdate(privateUpdate(2, '这条可以看'));
    expect(db.prepare("SELECT text FROM messages WHERE direction='in'").pluck().all()).toEqual(['这条可以看']);
    expect(opened).toHaveLength(1);
    await manager.close(); closeDatabase(db);
  }, 20_000);

  /**
   * tsx 的 ESM loader 按路径缓存模块、忽略 `?v=`，于是 `pnpm dev` 下 reload 每次都回 ok 而跑的
   * 一直是第一份代码 —— 修不了，只能说出来（docs/28 · L-EXT-04）。
   * 断言判据本身（纯函数，不去真的起一次 tsx），以及「启动告警与 reload 响应共用同一句话」。
   */
  it('把 .ts 入口的运行时判成热重载不可靠', async () => {
    expect(isHotReloadReliable('/srv/luoli/dist/apps/bot/src/main.js')).toBe(true);
    expect(isHotReloadReliable('/srv/luoli/apps/bot/src/main.ts')).toBe(false);
    expect(isHotReloadReliable('/srv/luoli/apps/bot/src/main.mts')).toBe(false);
    expect(isHotReloadReliable(undefined)).toBe(true);
    const { db, manager } = setup();
    expect(manager.hotReloadReliable).toBe(isHotReloadReliable());
    expect(manager.hotReloadWarning).toBe(manager.hotReloadReliable ? null : HOT_RELOAD_UNRELIABLE_HINT);
    expect(HOT_RELOAD_UNRELIABLE_HINT).toContain('pnpm dev');
    await manager.close(); closeDatabase(db);
  });
});
