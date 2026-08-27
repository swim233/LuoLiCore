import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { closeDatabase, migrateDatabase, openDatabase, recoverAfterCrash } from '@luoli/db';
import { MaintenanceService } from '@luoli/core';

describe('migration backup', () => {
  it('creates a pre-migration backup before applying a pending migration', () => {
    const database = './data/migration-backup/luoli.db'; const migrations = './data/migration-backup/migrations';
    rmSync(dirname(database), { recursive: true, force: true }); mkdirSync(migrations, { recursive: true });
    writeFileSync(`${migrations}/0001_init.sql`, 'CREATE TABLE one(id INTEGER);');
    const db = openDatabase(database); migrateDatabase(db, migrations);
    writeFileSync(`${migrations}/0002_next.sql`, 'CREATE TABLE two(id INTEGER);');
    migrateDatabase(db, migrations);
    const backups = readdirSync(resolve(dirname(database), 'backup')).filter((name) => name.includes('-pre-0002.db'));
    expect(backups).toHaveLength(1); expect(existsSync(resolve(dirname(database), 'backup', backups[0]!))).toBe(true);
    closeDatabase(db);
  });

  /**
   * `AC-DB-005`。上一条只核对文件名，而**「有一个文件」不等于「备份成功了」** —— `VACUUM INTO`
   * 中途断电 / 盘满留下的同样是一个存在的文件，恢复的时候才发现它是半截的。所以这里真的开一个
   * 连接跑查询，并核对它是**迁移前**那一刻的库：备份里没有这次要建的表、`__drizzle_migrations`
   * 里也没有这一条，名字里那个 `pre-NNNN` 才对得上。编号取的是**待执行队列的第一条**，不是
   * 已应用的最大号也不是队尾 —— 恢复时要回到的正是它执行之前那个点。
   */
  it('AC-DB-005：备份名带即将执行那条迁移的编号，且能被 sqlite3 打开、查得出迁移前的数据', () => {
    const database = './data/ac-db-005/luoli.db'; const migrations = './data/ac-db-005/migrations';
    rmSync(dirname(database), { recursive: true, force: true }); mkdirSync(migrations, { recursive: true });
    writeFileSync(`${migrations}/0001_init.sql`, 'CREATE TABLE one(id INTEGER); INSERT INTO one(id) VALUES (7);');
    const db = openDatabase(database); migrateDatabase(db, migrations);
    writeFileSync(`${migrations}/0007_seven.sql`, 'CREATE TABLE seven(id INTEGER);');
    writeFileSync(`${migrations}/0008_eight.sql`, 'CREATE TABLE eight(id INTEGER);');
    migrateDatabase(db, migrations);
    const directory = resolve(dirname(database), 'backup');
    const all = readdirSync(directory);
    const backups = all.filter((name) => /^luoli-\d+-pre-0007\.db$/.test(name));
    expect(backups, `backup/ 里是 ${all.join()}`).toHaveLength(1);
    const restored = new Database(resolve(directory, backups[0]!), { readonly: true });
    expect(restored.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(restored.prepare('SELECT id FROM one').pluck().get()).toBe(7);
    expect(restored.prepare('SELECT name FROM __drizzle_migrations ORDER BY name').pluck().all()).toEqual(['0001_init.sql']);
    expect(restored.prepare("SELECT count(*) FROM sqlite_master WHERE name IN ('seven','eight')").pluck().get()).toBe(0);
    restored.close();
    // 主库那边两条都上了：`pre-` 是「迁移之前」的快照，不是「迁移失败」的残骸。
    expect(db.prepare("SELECT count(*) FROM sqlite_master WHERE name IN ('seven','eight')").pluck().get()).toBe(2);
    closeDatabase(db);
  });

  /**
   * `AC-SEC-011`。这条此前**没有提交断言**，而只勾「目录 0700」那半会让整条被判通过 ——
   * 备份仍然人人可读（docs/29 · `M-SEC-01`，S1 实测生产 `data/backup/*.db` 全是 `-rw-r--r--`）。
   * 成因是 `VACUUM INTO` 建出来的文件走 SQLite 自己的 `0666 & ~umask`，两处调用点之后都没有
   * `chmodSync`。目录的 0700 只挡住同机其他用户遍历，**而权限位跟着文件走** —— 备份一旦被复制、
   * 打包、同步出去，那道目录闸就不在了。所以这里**两个生产者各断言一次**：只焊住一处，
   * 另一处照旧产出 0644。
   */
  it('AC-SEC-011：两条路写出来的备份都是 0600，目录仍是 0700', () => {
    const database = './data/ac-sec-011/luoli.db'; const migrations = './data/ac-sec-011/migrations';
    rmSync(dirname(database), { recursive: true, force: true }); mkdirSync(migrations, { recursive: true });
    writeFileSync(`${migrations}/0001_init.sql`, 'CREATE TABLE one(id INTEGER);');
    const db = openDatabase(database); migrateDatabase(db, migrations);
    writeFileSync(`${migrations}/0002_next.sql`, 'CREATE TABLE two(id INTEGER);');
    migrateDatabase(db, migrations);
    const directory = resolve(dirname(database), 'backup');
    const mode = (name: string): number => statSync(resolve(directory, name)).mode & 0o777;
    const migrationBackup = readdirSync(directory).find((name) => name.includes('-pre-0002.db'))!;
    expect(mode(migrationBackup), '迁移前那份备份是全局可读的').toBe(0o600);
    // 另一个生产者：维护任务 / WebUI 的 `[立即备份]` 走的是 `MaintenanceService.backup()`。
    const written = new MaintenanceService(db, database, 5, 30).backup('test');
    expect(statSync(written).mode & 0o777, '维护任务写出来的备份是全局可读的').toBe(0o600);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    closeDatabase(db);
  });

  it('marks turns, tasks, agents and asks failed or timed out after restart', () => {
    const database = './data/recovery.test.db';
    rmSync(database, { force: true }); rmSync(`${database}-wal`, { force: true }); rmSync(`${database}-shm`, { force: true });
    const db = openDatabase(database); migrateDatabase(db);
    db.prepare("INSERT INTO turns(id,key,chat_id,initiator_user_id,effective_role,trigger_message_id,trigger_reason,state) VALUES ('t','k','c','u','trusted',1,'mention','running')").run();
    db.prepare("INSERT INTO tasks(id,turn_id,chat_id,user_id,title,state,created_at,updated_at) VALUES ('task','t','c','u','x','running',1,1)").run();
    db.prepare("INSERT INTO agent_runs(id,turn_id,depth,kind,agent_name,model_alias,effective_role,state,started_at) VALUES ('run','t',0,'main','main','main','trusted','running',1)").run();
    db.prepare("INSERT INTO agent_messages(id,turn_id,from_run_id,to_run_id,kind,payload_json,state,created_at) VALUES ('ask','t','run','run','ask','{}','sent',1)").run();
    recoverAfterCrash(db);
    expect(db.prepare('SELECT state FROM turns WHERE id=\'t\'').pluck().get()).toBe('failed');
    expect(db.prepare('SELECT state FROM tasks WHERE id=\'task\'').pluck().get()).toBe('failed');
    expect(db.prepare('SELECT state FROM agent_runs WHERE id=\'run\'').pluck().get()).toBe('failed');
    expect(db.prepare('SELECT state FROM agent_messages WHERE id=\'ask\'').pluck().get()).toBe('timeout');
    closeDatabase(db);
  });
});
