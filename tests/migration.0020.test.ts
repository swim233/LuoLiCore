import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';

const REAL_MIGRATIONS = 'packages/db/migrations';
const SDK_MIGRATION = '0020_sdk_keys_and_sessions.sql';

/**
 * 造一份「已到 0019」的库，插入迁移前的 contexts / usage_ledger fixture（此时两表都还没有
 * source_id 列），再把 0020 补进迁移目录跑第二趟 —— 手法同 `migration.0019.test.ts` 的
 * `upgradeAcross0019`：只有真的从 0019 升到 0020，断言的才是仓库里那份 SQL。
 *
 * `extraFixture` 在基础 fixture 写完、0020 执行前调用，供个别用例插入额外的行。
 */
function upgradeAcross0020(name: string, extraFixture?: (db: Database.Database) => void): Database.Database {
  const root = `./data/${name}`;
  const database = `${root}/luoli.db`;
  const staging = `${root}/migrations`;
  rmSync(root, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  for (const entry of readdirSync(REAL_MIGRATIONS))
    if (entry.endsWith('.sql') && entry !== SDK_MIGRATION)
      copyFileSync(resolve(REAL_MIGRATIONS, entry), resolve(staging, entry));
  const db = openDatabase(database);
  migrateDatabase(db, staging);
  expect(db.prepare("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='api_keys'").pluck().get(),
    '0020 之前 api_keys 就已经在了 —— 这个用例没在测升级').toBe(0);

  const now = Date.now();
  // 两条存量会话（迁移前 contexts 还没有 source_id / deleted_at 列）。
  db.prepare(`INSERT INTO contexts(key,chat_id,thread_id,scope,created_at,updated_at)
    VALUES (?,?,NULL,'chat',?,?)`).run('chat:-100111', '-100111', now, now);
  db.prepare(`INSERT INTO contexts(key,chat_id,thread_id,scope,created_at,updated_at)
    VALUES (?,?,88,'thread',?,?)`).run('chat:-100111:88', '-100111', now, now);

  // 两条存量记账（迁移前 usage_ledger 还没有 source_id 列）。
  const ledger = db.prepare(`INSERT INTO usage_ledger(ts,turn_id,chat_id,user_id,provider_id,model_id,model_alias,
    input_tokens,output_tokens,cost_usd) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  ledger.run(now, 'turn-1', '-100111', '1001', 'anthropic', 'claude', 'default', 10, 20, 0.01);
  ledger.run(now, 'turn-2', '-100111', '1002', 'anthropic', 'claude', 'default', 5, 15, 0.005);

  extraFixture?.(db);

  copyFileSync(resolve(REAL_MIGRATIONS, SDK_MIGRATION), resolve(staging, SDK_MIGRATION));
  migrateDatabase(db, staging);
  return db;
}

describe('迁移 0020 · SDK 密钥与会话', () => {
  it('执行成功，contexts.source_id 与 usage_ledger.source_id 存量全为 telegram', () => {
    const db = upgradeAcross0020('migration-0020-basic');

    // 验收 1：执行成功 —— upgradeAcross0020 内的第二次 migrateDatabase 若抛错，这条用例本身就会失败。
    expect(db.prepare('SELECT name FROM __drizzle_migrations WHERE name=?').pluck().get(SDK_MIGRATION)).toBe(SDK_MIGRATION);

    // 验收 2：存量 contexts.source_id 全为 telegram，deleted_at 为 NULL（未删除）。
    const contextRows = db.prepare('SELECT key,source_id,deleted_at FROM contexts ORDER BY key').all();
    expect(contextRows).toEqual([
      { key: 'chat:-100111', source_id: 'telegram', deleted_at: null },
      { key: 'chat:-100111:88', source_id: 'telegram', deleted_at: null },
    ]);

    // 验收 2：存量 usage_ledger.source_id 全为 telegram。
    const ledgerSources = db.prepare('SELECT source_id FROM usage_ledger ORDER BY turn_id').pluck().all();
    expect(ledgerSources).toEqual(['telegram', 'telegram']);

    closeDatabase(db);
  });

  it('三张新索引存在', () => {
    const db = upgradeAcross0020('migration-0020-indexes');
    const indexNames = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type='index'").pluck().all() as string[],
    );
    expect(indexNames.has('ix_api_keys_source')).toBe(true);
    expect(indexNames.has('ix_contexts_source')).toBe(true);
    expect(indexNames.has('ix_usage_source_ts')).toBe(true);
    closeDatabase(db);
  });

  it('sdk_sessions.output_format 的 CHECK 拒绝非法取值，接受 plain/markdown', () => {
    const db = upgradeAcross0020('migration-0020-output-format-check');
    db.prepare(`INSERT INTO contexts(key,chat_id,thread_id,scope,created_at,updated_at)
      VALUES ('chat:-100222','-100222',NULL,'chat',1,1)`).run();
    db.prepare(`INSERT INTO contexts(key,chat_id,thread_id,scope,created_at,updated_at)
      VALUES ('chat:-100333','-100333',NULL,'chat',1,1)`).run();

    expect(() => db.prepare(`INSERT INTO sdk_sessions(key,output_format,created_at)
      VALUES ('chat:-100222','plain',1)`).run()).not.toThrow();

    expect(() => db.prepare(`INSERT INTO sdk_sessions(key,output_format,created_at)
      VALUES ('chat:-100333','html',1)`).run()).toThrow(/CHECK constraint failed/);

    closeDatabase(db);
  });

  it('sdk_sessions.key 外键拒绝不存在的 contexts.key', () => {
    const db = upgradeAcross0020('migration-0020-sdk-sessions-fk');

    expect(() => db.prepare(`INSERT INTO sdk_sessions(key,output_format,created_at)
      VALUES ('chat:-100999','markdown',1)`).run()).toThrow(/FOREIGN KEY constraint failed/);

    closeDatabase(db);
  });

  it('api_keys.source_id 外键在 foreign_keys=ON 下拒绝不存在的来源，接受既有来源', () => {
    const db = upgradeAcross0020('migration-0020-api-keys-fk');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);

    expect(() => db.prepare(`INSERT INTO api_keys(id,source_id,secret_enc,created_at)
      VALUES ('key-bad','no-such-source','enc',1)`).run()).toThrow(/FOREIGN KEY constraint failed/);

    expect(() => db.prepare(`INSERT INTO api_keys(id,source_id,secret_enc,created_at)
      VALUES ('key-ok','telegram','enc',1)`).run()).not.toThrow();

    closeDatabase(db);
  });
});
