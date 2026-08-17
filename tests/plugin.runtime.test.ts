import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { LogSink, PluginManager, ToolRegistry } from '@luoli/core';
import type { ToolExecutionContext } from '@luoli/core';
import { OperationsRepository } from '@luoli/db';

function setup() {
  const database = './data/plugin-runtime.test.db';
  const directory = './data/plugin-runtime-plugins';
  (globalThis as { __pluginUnloads?: number }).__pluginUnloads = 0;
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${database}${suffix}`, { force: true });
  rmSync(directory, { recursive: true, force: true }); mkdirSync(`${directory}/alpha`, { recursive: true }); mkdirSync(`${directory}/beta`, { recursive: true });
  for (const name of ['alpha', 'beta']) writeFileSync(`${directory}/${name}/plugin.js`, `export default { name:'${name}', hooks:{ ping: () => '${name}' }, onUnload: () => globalThis.__pluginUnloads = (globalThis.__pluginUnloads ?? 0) + 1, tools: () => ({ echo: { description:'echo', inputSchema:{}, execute: input => input } }) };`);
  const db = openDatabase(database); migrateDatabase(db);
  const insert = db.prepare('INSERT INTO plugins(name,path,min_role,enabled,config_json,updated_at) VALUES (?,?,?,1,?,?)');
  insert.run('alpha', `${directory}/alpha/plugin.js`, 'trusted', '{}', Date.now()); insert.run('beta', `${directory}/beta/plugin.js`, 'trusted', '{}', Date.now());
  const log = new LogSink(new OperationsRepository(db), './data/plugin-runtime-logs');
  const registry = new ToolRegistry(log, { request: async () => true }, { maxRegistered: 80, maxCallsPerTurn: 40, maxConsecutiveErrors: 3 });
  return { db, registry, manager: new PluginManager(db, directory, 1000, 3, ['beta', 'alpha'], registry) };
}

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

  it('discovers files as disabled rows before any database seed', async () => {
    const database = './data/plugin-discovery.test.db'; const directory = './data/plugin-discovery-plugins';
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${database}${suffix}`, { force: true });
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
});
