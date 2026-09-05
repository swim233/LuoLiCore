import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';

const REAL_MIGRATIONS = 'packages/db/migrations';
const SCOPE_MIGRATION = '0019_sources_and_memory_scope.sql';

/**
 * 造一份「已到 0018」的库，插入迁移前的 memory_docs / memory_revisions fixture，
 * 再把 0019 补进迁移目录跑第二趟 —— 与 `migration.backup.test.ts` 的 `upgradeAcross0018` 同一手法：
 * 只有真的从 0018 升到 0019，断言的才是仓库里那份 SQL，而不是用例自己另起的一份 DDL。
 * 第二趟同时是「有历史迁移 + 有待执行迁移」，会触发 `migrateDatabase` 的备份路径。
 *
 * `extraFixture` 在基础 fixture 写完、0019 执行前调用，供个别用例插入基础 fixture 之外的行——
 * 不能在 0019 跑完之后再插，那样插入的行根本没经过这份迁移的任何一条 UPDATE。
 */
function upgradeAcross0019(name: string, extraFixture?: (db: Database.Database) => void): Database.Database {
  const root = `./data/${name}`;
  const database = `${root}/luoli.db`;
  const staging = `${root}/migrations`;
  rmSync(root, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  for (const entry of readdirSync(REAL_MIGRATIONS))
    if (entry.endsWith('.sql') && entry !== SCOPE_MIGRATION)
      copyFileSync(resolve(REAL_MIGRATIONS, entry), resolve(staging, entry));
  const db = openDatabase(database);
  migrateDatabase(db, staging);
  expect(db.prepare("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='sources'").pluck().get(),
    '0019 之前 sources 就已经在了 —— 这个用例没在测升级').toBe(0);

  const doc = db.prepare(`INSERT INTO memory_docs(id,scope,subject,path,bytes,tokens,content_hash,updated_at)
    VALUES (?,?,?,?,1,1,'h',1)`);
  // 三个来源级 scope 的全局单例：迁移前 subject 为 NULL，id 形如 '<scope>:global'。
  doc.run('assist:global', 'assist', null, '/memory/ASSIST.md');
  doc.run('character:global', 'character', null, '/memory/CHARACTER.md');
  doc.run('pubmemory:global', 'pubmemory', null, '/memory/PUBMEMORY.md');
  // character 的 per-chat 覆盖行：subject 已经是 chatId，0019 不改写该行。
  doc.run('character:-100999', 'character', '-100999', '/memory/private/-100999/CHARACTER.md');
  // 两个用户的 primemory：迁移前 subject 为纯 userId。
  doc.run('primemory:1001', 'primemory', '1001', '/memory/private/1001/PRIMEMORY.md');
  doc.run('primemory:1002', 'primemory', '1002', '/memory/private/1002/PRIMEMORY.md');

  const rev = db.prepare(`INSERT INTO memory_revisions(id,doc_id,ts,actor,op,diff,bytes_after) VALUES (?,?,1,'model','append','d',1)`);
  rev.run('r-assist', 'assist:global');
  rev.run('r-character', 'character:global');
  rev.run('r-pubmemory', 'pubmemory:global');
  rev.run('r-character-chat', 'character:-100999');
  rev.run('r-prime-1001-a', 'primemory:1001');
  rev.run('r-prime-1001-b', 'primemory:1001');
  rev.run('r-prime-1002', 'primemory:1002');

  extraFixture?.(db);

  copyFileSync(resolve(REAL_MIGRATIONS, SCOPE_MIGRATION), resolve(staging, SCOPE_MIGRATION));
  migrateDatabase(db, staging);
  return db;
}

describe('迁移 0019 · sources 与记忆按来源分区', () => {
  it('在含存量 memory_docs / memory_revisions 的库上执行成功，两表行数不变，doc_id 全部可解析，sources 恰一行 telegram', () => {
    const db = upgradeAcross0019('migration-0019-basic');

    // 验收 1：执行成功 —— upgradeAcross0019 内的第二次 migrateDatabase 若抛错，这条用例本身就会失败。
    expect(db.prepare('SELECT name FROM __drizzle_migrations WHERE name=?').pluck().get(SCOPE_MIGRATION)).toBe(SCOPE_MIGRATION);

    // 验收 2：无 subject 为 NULL 的行；每条 revision 的 doc_id 都能在 memory_docs 中找到。
    expect(db.prepare('SELECT COUNT(*) FROM memory_docs WHERE subject IS NULL').pluck().get()).toBe(0);
    const orphaned = db.prepare(`SELECT COUNT(*) FROM memory_revisions r
      WHERE NOT EXISTS (SELECT 1 FROM memory_docs d WHERE d.id = r.doc_id)`).pluck().get();
    expect(orphaned, '存在指向不存在 memory_docs 行的 doc_id').toBe(0);

    // 验收 3：两表行数与执行前一致（改写而非增删）。fixture 写入 6 行 memory_docs、7 行 memory_revisions。
    expect(db.prepare('SELECT COUNT(*) FROM memory_docs').pluck().get()).toBe(6);
    expect(db.prepare('SELECT COUNT(*) FROM memory_revisions').pluck().get()).toBe(7);

    // 验收 4：sources 有且仅有 telegram 一行。
    const sources = db.prepare('SELECT id,kind,name FROM sources').all();
    expect(sources).toEqual([{ id: 'telegram', kind: 'telegram', name: 'Telegram' }]);
    // created_at 是库内既有单位（毫秒，见 operations.ts 的 tg_date / 1000 换算），不是秒或文本。
    const createdAt = db.prepare("SELECT created_at FROM sources WHERE id='telegram'").pluck().get() as number;
    expect(createdAt).toBeGreaterThan(1e12);

    closeDatabase(db);
  });

  it('按 scope 精确核对改写后的 id / subject，且 per-chat 覆盖行不受影响', () => {
    const db = upgradeAcross0019('migration-0019-exact');
    const docRow = (id: string) => db.prepare('SELECT id,scope,subject FROM memory_docs WHERE id=?').get(id) as
      { id: string; scope: string; subject: string | null } | undefined;

    // 三个来源级 scope：':global' 改写为 ':telegram'，subject 落为来源 id。
    expect(docRow('assist:telegram')).toEqual({ id: 'assist:telegram', scope: 'assist', subject: 'telegram' });
    expect(docRow('character:telegram')).toEqual({ id: 'character:telegram', scope: 'character', subject: 'telegram' });
    expect(docRow('pubmemory:telegram')).toEqual({ id: 'pubmemory:telegram', scope: 'pubmemory', subject: 'telegram' });
    // 旧 id 已不存在 —— 是改写，不是新增一行。
    expect(docRow('assist:global')).toBeUndefined();

    // primemory：id 与 subject 都带上来源前缀。
    expect(docRow('primemory:telegram:1001')).toEqual({ id: 'primemory:telegram:1001', scope: 'primemory', subject: 'telegram:1001' });
    expect(docRow('primemory:telegram:1002')).toEqual({ id: 'primemory:telegram:1002', scope: 'primemory', subject: 'telegram:1002' });

    // per-chat 覆盖行：subject 迁移前已非空，0019 不改写该行。
    expect(docRow('character:-100999')).toEqual({ id: 'character:-100999', scope: 'character', subject: '-100999' });

    // memory_revisions.doc_id 同步指向新 id。
    const revDocId = (id: string) => db.prepare('SELECT doc_id FROM memory_revisions WHERE id=?').pluck().get(id);
    expect(revDocId('r-assist')).toBe('assist:telegram');
    expect(revDocId('r-character')).toBe('character:telegram');
    expect(revDocId('r-pubmemory')).toBe('pubmemory:telegram');
    expect(revDocId('r-character-chat')).toBe('character:-100999');
    expect(revDocId('r-prime-1001-a')).toBe('primemory:telegram:1001');
    expect(revDocId('r-prime-1001-b')).toBe('primemory:telegram:1001');
    expect(revDocId('r-prime-1002')).toBe('primemory:telegram:1002');

    closeDatabase(db);
  });

  /**
   * 第 1 轮修复（qa-T2-1 兜底建议）：primemory 行 subject 为 NULL 时不动 memory_docs 那一行——
   * 不加这个判断，`'primemory:telegram:' || subject` 拼接遇 NULL 会把整个 id 变成 NULL。
   * 当前三条写 memory_docs 的路径下这一行不可达，这里只验证「万一出现」时迁移不炸、
   * 不该改的那一行原样不动，不验证 memory_revisions 那一侧（它没有 subject 列可判，
   * 见迁移文件里的注释）。
   */
  it('primemory 行 subject 为 NULL 时不改写该行（不可达数据的兜底，其余行照常改写）', () => {
    // 补一行不该在正常路径下出现的脏数据：raw SQL 直接写库，绕过 store.ts 的写入闸。
    // 必须在 extraFixture 里插——插在 upgradeAcross0019 返回之后，0019 根本不会碰这一行。
    const db = upgradeAcross0019('migration-0019-null-subject-guard', (database) => {
      database.prepare(`INSERT INTO memory_docs(id,scope,subject,path,bytes,tokens,content_hash,updated_at)
        VALUES ('primemory:phantom','primemory',NULL,'/memory/private/phantom/PRIMEMORY.md',1,1,'h',1)`).run();
    });

    const guarded = db.prepare('SELECT id,scope,subject FROM memory_docs WHERE id=?').get('primemory:phantom');
    expect(guarded, '守卫没生效——这一行被当成正常 primemory 行改写了').toEqual(
      { id: 'primemory:phantom', scope: 'primemory', subject: null });
    // 其余正常行不受这一行拖累，照常改写。
    expect(db.prepare('SELECT id FROM memory_docs WHERE id=?').pluck().get('primemory:telegram:1001')).toBe('primemory:telegram:1001');

    closeDatabase(db);
  });
});
