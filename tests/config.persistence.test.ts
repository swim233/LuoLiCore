import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { closeDatabase, migrateDatabase, modelAliasKey, openDatabase, readAppKv, readPersistedConfig, writeAppKv } from '@luoli/db';
import { ENV_PINNED_CONFIG_KEYS, loadConfig, perChatConfig } from '@luoli/core';
import { assignDotted } from '@luoli/shared';

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

  // 覆盖层此前按 rowid（插入序）应用，而 assignDotted 是整叶覆盖：先点过工具页的
  // tools.overrides.<name>、后在表单里写过 tools.overrides 整块，那一项就永远赢不了 ——
  // 工具页每次点开关都是 200 OK + 刷新回弹，而工具禁用是硬边界（docs/21 · G-CFG-02）。
  it('更具体的点分键总是赢，与两行谁先落库无关', () => {
    for (const order of [['tools.overrides.web_fetch', 'tools.overrides'], ['tools.overrides', 'tools.overrides.web_fetch']] as const) {
      const { db, path } = database(`config-persistence-depth-${order[0].length}`);
      const now = Date.now();
      const values: Record<string, unknown> = { 'tools.overrides': { web_fetch: { enabled: true }, bash: { enabled: false } }, 'tools.overrides.web_fetch': { enabled: false } };
      for (const key of order) {
        db.prepare("INSERT INTO config_kv(key,value_json,updated_at,updated_by) VALUES (?,?,?,'webui')").run(key, JSON.stringify(values[key]), now);
      }
      const overrides = readPersistedConfig(path) as { tools: { overrides: Record<string, { enabled: boolean }> } };
      expect(overrides.tools.overrides.web_fetch, `插入顺序 ${order.join(' → ')}`).toEqual({ enabled: false });
      // 整块里的其他项不能被更细的那一行抹掉。
      expect(overrides.tools.overrides.bash).toEqual({ enabled: false });
      closeDatabase(db);
    }
  });

  // 这几个键的 config_kv 行注定无效：env 层在覆盖层之后合并。WebUI 因此不给控件（envPinned），
  // 写入端也直接 400 —— 「保存成功但运行时没变」是最误导的一类反馈（docs/21 · G-CFG-03）。
  it('ENV_PINNED_CONFIG_KEYS 里 loadConfig 那几条真的压过持久化覆盖层', async () => {
    const cases: Record<string, { value: string; expect: (config: Awaited<ReturnType<typeof loadConfig>>) => unknown; override: unknown }> = {
      LUOLI_OWNER_ID: { value: '424242', expect: (config) => config.access.bootstrapOwnerId, override: '999' },
      LUOLI_HOST_WORKSPACE_DIR: { value: '/srv/from-env', expect: (config) => config.sandbox.hostWorkspaceDir, override: '/srv/from-db' },
    };
    for (const entry of ENV_PINNED_CONFIG_KEYS.filter((item) => item.appliedIn === 'loadConfig')) {
      // db.path 的 env 值要过一次 resolve，单独断言；其余按表逐条跑。
      if (entry.env === 'LUOLI_DATA_DIR') continue;
      const probe = cases[entry.env];
      expect(probe, `${entry.env} 没有对应的断言`).toBeDefined();
      const overrides: Record<string, unknown> = {};
      assignDotted(overrides, entry.key, probe!.override);
      const previous = process.env[entry.env];
      process.env[entry.env] = probe!.value;
      try {
        const config = await loadConfig({ path: MISSING_FILE, overrides, requireOwner: false });
        expect(probe!.expect(config), `${entry.key} 应当由 ${entry.env} 决定`).toBe(probe!.value);
      } finally {
        if (previous === undefined) delete process.env[entry.env]; else process.env[entry.env] = previous;
      }
    }
  });

  it('perChat 覆盖会真正合并进本轮配置', () => {
    const base = { general: { timezone: 'UTC' }, output: { mode: 'stream' }, perChat: { 'chat:1': { output: { mode: 'once' } } } } as never;
    expect(perChatConfig(base, 'chat:1').output.mode).toBe('once');
    expect(perChatConfig(base, 'chat:2').output.mode).toBe('stream');
  });
});
