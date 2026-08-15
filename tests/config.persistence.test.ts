import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { closeDatabase, migrateDatabase, modelAliasKey, openDatabase, readAppKv, readPersistedConfig, writeAppKv } from '@luoli/db';
import { loadConfig, perChatConfig } from '@luoli/core';

const MISSING_FILE = './config/__no-such-config.yaml';

function database(name: string) {
  const path = `./data/${name}.test.db`;
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
  const db = openDatabase(path);
  migrateDatabase(db);
  return { db, path };
}

describe('配置持久化往返', () => {
  it('运行时 KV 走 app_kv，不会污染配置覆盖层', () => {
    const { db, path } = database('config-persistence-appkv');
    writeAppKv(db, modelAliasKey('chat:-1001234567'), 'high', 'command:1');
    expect(readAppKv<string>(db, modelAliasKey('chat:-1001234567'))).toBe('high');
    expect(db.prepare('SELECT COUNT(*) FROM config_kv').pluck().get()).toBe(0);
    expect(readPersistedConfig(path)).toEqual({});
    closeDatabase(db);
  });

  it('0005 迁移把历史遗留的 perChat.modelAlias / plugin 键搬出 config_kv', () => {
    const path = './data/config-persistence-migrate.test.db';
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
    const db = openDatabase(path);
    // 先迁到 0004，写入旧格式，再迁到最新，模拟已在运行的实例升级。
    migrateDatabase(db, 'packages/db/migrations');
    db.prepare('DELETE FROM __drizzle_migrations WHERE name >= ?').run('0005');
    db.exec('DROP TABLE IF EXISTS app_kv');
    const now = Date.now();
    for (const [key, value] of [['perChat.modelAlias.chat:-100', '"high"'], ['plugin.demo.counter', '7']] as const) {
      db.prepare("INSERT INTO config_kv(key,value_json,updated_at,updated_by) VALUES (?,?,?,'legacy')").run(key, value, now);
    }
    migrateDatabase(db, 'packages/db/migrations');
    expect(db.prepare("SELECT COUNT(*) FROM config_kv WHERE key LIKE 'perChat.modelAlias.%' OR key LIKE 'plugin.%'").pluck().get()).toBe(0);
    expect(readAppKv<string>(db, modelAliasKey('chat:-100'))).toBe('high');
    expect(readAppKv<number>(db, 'plugin:demo.counter')).toBe(7);
    closeDatabase(db);
  });

  it('覆盖层里的非法路径被剔除并上报，而不是让启动失败', async () => {
    const { db, path } = database('config-persistence-selfheal');
    const now = Date.now();
    db.prepare("INSERT INTO config_kv(key,value_json,updated_at,updated_by) VALUES (?,?,?,'legacy')")
      .run('perChat.chat:abc', JSON.stringify({ access: { defaultUserRole: 'owner' } }), now);
    db.prepare("INSERT INTO config_kv(key,value_json,updated_at,updated_by) VALUES (?,?,?,'legacy')")
      .run('logs.level', JSON.stringify('debug'), now);
    const dropped: string[] = [];
    const config = await loadConfig({ path: MISSING_FILE, overrides: readPersistedConfig(path), requireOwner: false, onInvalidOverride: (keys) => dropped.push(...keys) });
    expect(dropped).toEqual(['perChat.chat:abc.access.defaultUserRole']);
    expect(config.perChat).toEqual({});
    // 合法的覆盖不能被误伤。
    expect(config.logs.level).toBe('debug');
    closeDatabase(db);
  });

  it('config.yaml 自身非法时仍然直接抛出，不静默降级', async () => {
    await expect(loadConfig({ path: MISSING_FILE, overrides: { concurrency: { perKey: 20, global: 8 } }, requireOwner: false }))
      .resolves.toBeDefined();
    await expect(loadConfig({ path: 'tests/fixtures/invalid-config.yaml', requireOwner: false })).rejects.toThrow();
  });

  it('perChat 覆盖会真正合并进本轮配置', () => {
    const base = { general: { timezone: 'UTC' }, output: { mode: 'stream' }, perChat: { 'chat:1': { output: { mode: 'once' } } } } as never;
    expect(perChatConfig(base, 'chat:1').output.mode).toBe('once');
    expect(perChatConfig(base, 'chat:2').output.mode).toBe('stream');
  });
});
