import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { SourceRepository, closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';

const REAL_MIGRATIONS = 'packages/db/migrations';
const TOOLS_MIGRATION = '0021_sources_tools.sql';

/**
 * 造一份「已到 0020」的库，写入存量 sources 行，再把 0021 补进迁移目录跑第二趟——手法同
 * `migration.0020.test.ts`：只有真的跨过这一版升级，断言的才是仓库里那份 SQL。
 */
function upgradeAcross0021(name: string): Database.Database {
  const root = `./data/${name}`;
  const database = `${root}/luoli.db`;
  const staging = `${root}/migrations`;
  rmSync(root, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  for (const entry of readdirSync(REAL_MIGRATIONS))
    if (entry.endsWith('.sql') && entry !== TOOLS_MIGRATION)
      copyFileSync(resolve(REAL_MIGRATIONS, entry), resolve(staging, entry));
  const db = openDatabase(database);
  migrateDatabase(db, staging);
  expect(
    db.prepare("SELECT COUNT(*) FROM pragma_table_info('sources') WHERE name='tools'").pluck().get(),
    '0021 之前 sources.tools 就已经在了 —— 这个用例没在测升级',
  ).toBe(0);

  db.prepare("INSERT INTO sources(id,kind,name,created_at) VALUES ('ACME','sdk','Acme',?)").run(Date.now());

  copyFileSync(resolve(REAL_MIGRATIONS, TOOLS_MIGRATION), resolve(staging, TOOLS_MIGRATION));
  migrateDatabase(db, staging);
  return db;
}

describe('0021 sources.tools', () => {
  /**
   * 这一条是整次迁移的要点：存量来源升级之后一律为 NULL，读侧回落到 SDK_AGENT_TOOLS，
   * 因此任何现有部署的行为一字不变。回填成一份具体的名单会把「默认」焊死在升级当天的取值上。
   */
  it('存量行升级后为 NULL（用默认），不回填具体名单', () => {
    const db = upgradeAcross0021('migration-0021-null');
    expect(new SourceRepository(db).get('ACME')?.tools).toBeNull();
    // 内建 telegram 行同样不受影响。
    expect(new SourceRepository(db).get('telegram')?.tools).toBeNull();
    closeDatabase(db);
  });

  it('升级后这一列可读可写，且不影响其余列', () => {
    const db = upgradeAcross0021('migration-0021-write');
    const sources = new SourceRepository(db);
    sources.setTools('ACME', ['read_file']);

    const row = sources.get('ACME');
    expect(row?.tools).toEqual(['read_file']);
    expect(row?.name).toBe('Acme');
    expect(row?.kind).toBe('sdk');
    closeDatabase(db);
  });
});
