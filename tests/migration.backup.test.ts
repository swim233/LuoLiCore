import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { closeDatabase, migrateDatabase, openDatabase, recoverAfterCrash } from '@luoli/db';
import { MaintenanceService } from '@luoli/core';
import { code, codeIndex, source } from './support/source.js';

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

const REAL_MIGRATIONS = 'packages/db/migrations';
const WORKER_KIND_MIGRATION = '0018_agent_runs_worker_kind.sql';

/**
 * 迁移 `0018` 给 `agent_runs` 加 `worker_kind`（docs/03 §2.7）。
 *
 * 三条断言分别守住三件不同的事，缺任何一条都留下一个静默失败：
 * ① **回填**。不回填的话本轮名额那条 COUNT（`AgentManager.spawn`）要写成两分支，而第二支会把
 *    存量 ACP 行一起数进名额；这类错的表现是「升级之后 worker 突然派不出来了」，没有报错。
 * ② **`kind` 上那条 CHECK 一个字节没动**。它是本次迁移存在的全部理由 —— 要给 `kind` 加一档就得
 *    重建整张 trace 骨架表，而重建期间 `parent_run_id` / `tasks.agent_run_id` /
 *    `usage_ledger.agent_run_id` / `approvals.agent_run_id` 四处引用全在半空中（同 `0014`）。
 * ③ **幂等**。迁移账本认的是文件名，跑第二次时那条 `CREATE INDEX`（没有 `IF NOT EXISTS`）
 *    会直接抛，所以「只执行一次」这件事必须真的成立。
 */
function upgradeAcross0018(name: string): Database.Database {
  const root = `./data/${name}`;
  const database = `${root}/luoli.db`;
  const staging = `${root}/migrations`;
  rmSync(root, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  // 真迁移目录里除 0018 之外的每一份，先跑到 0017 那个点上 —— 这正是升级时库所处的状态。
  // 自己手写一份 agent_runs 建表语句是不行的：那样断言的是用例里那份 DDL，不是仓库里那份。
  for (const entry of readdirSync(REAL_MIGRATIONS))
    if (entry.endsWith('.sql') && entry !== WORKER_KIND_MIGRATION)
      copyFileSync(resolve(REAL_MIGRATIONS, entry), resolve(staging, entry));
  const db = openDatabase(database);
  migrateDatabase(db, staging);
  expect(db.prepare("SELECT COUNT(*) FROM pragma_table_info('agent_runs') WHERE name='worker_kind'").pluck().get(),
    '0018 之前 worker_kind 就已经在了 —— 这个用例没在测升级').toBe(0);
  const insert = db.prepare(`INSERT INTO agent_runs(id,turn_id,depth,kind,agent_name,model_alias,effective_role,state,started_at)
    VALUES (?,'t',?,?,?,?,'owner','done',1)`);
  insert.run('main-run', 0, 'main', 'main', 'main');
  insert.run('acp-run', 1, 'sub', 'acp:omp', 'external');
  insert.run('sub-run', 1, 'sub', 'researcher', 'low');
  // 两个诱饵：判据要**两个都中**才算 ACP。`agent.agents[].name` 当年是裸 `z.string()`，
  // 运维真能从 DB / WebUI 建一个叫 `acp:x` 的子 agent，而它是我们付钱的模型调用，得占名额。
  insert.run('lookalike-name', 1, 'sub', 'acp:x', 'low');
  insert.run('lookalike-alias', 1, 'sub', 'researcher', 'external');
  copyFileSync(resolve(REAL_MIGRATIONS, WORKER_KIND_MIGRATION), resolve(staging, WORKER_KIND_MIGRATION));
  migrateDatabase(db, staging);
  return db;
}

describe('迁移 0018 · agent_runs.worker_kind', () => {
  it('加列并按三条规则回填：ACP 认 acp、其余 sub 认 lw、主 run 留 NULL', () => {
    const db = upgradeAcross0018('migration-0018-backfill');
    const kindOf = (id: string): string | null =>
      db.prepare('SELECT worker_kind FROM agent_runs WHERE id=?').pluck().get(id) as string | null;
    expect(kindOf('acp-run')).toBe('acp');
    expect(kindOf('sub-run')).toBe('lw');
    expect(kindOf('lookalike-name'), 'agent_name 像 ACP 但别名不是 external，它是我们自己的 worker').toBe('lw');
    expect(kindOf('lookalike-alias'), '别名是 external 但名字不带 acp: 前缀，同上').toBe('lw');
    // 主 run 不是 worker —— 留 NULL，与 `AgentManager.createMain` 此后写入的一致。
    expect(kindOf('main-run')).toBeNull();
    // 名额那条 COUNT 靠的就是这一列，回填漏了它会静默把存量 ACP 行数进去。
    expect(db.prepare("SELECT COUNT(*) FROM agent_runs WHERE turn_id='t' AND worker_kind='lw'").pluck().get()).toBe(3);
    // 部分索引真的建出来了（只覆盖 worker 行：主 run 在这张表里是绝大多数）。
    expect(db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='ix_agentruns_worker'").pluck().get())
      .toContain('WHERE worker_kind IS NOT NULL');
    closeDatabase(db);
  });

  it('kind 上那条 CHECK 一个字节没动，迁移文件里没有 DROP TABLE / RENAME', () => {
    const db = upgradeAcross0018('migration-0018-check');
    const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_runs'").pluck().get() as string;
    expect(ddl, 'kind 上那条 CHECK 被改过 —— 那意味着整张 trace 骨架表被重建了').toContain("CHECK (kind IN ('main','sub'))");
    // 三种 worker 照旧记 kind='sub'：CHECK 没动，认它靠新列。
    expect(() => db.prepare(`INSERT INTO agent_runs(id,turn_id,depth,kind,worker_kind,agent_name,model_alias,effective_role,state,started_at)
      VALUES ('h','t',1,'sub','harness','harness:claude','external','owner','done',1)`).run()).not.toThrow();
    expect(db.prepare("SELECT worker_kind FROM agent_runs WHERE id='h'").pluck().get()).toBe('harness');
    // 新列刻意不加 CHECK：0018 存在的理由就是「kind 上那个 CHECK 扩不动」，在同一张表上再加一个
    // 同样扩不动的枚举，下一种 worker 出现时会撞上一模一样的墙。取值域焊在 TS 与唯一那个插入口上。
    expect(() => db.prepare(`INSERT INTO agent_runs(id,turn_id,depth,kind,worker_kind,agent_name,model_alias,effective_role,state,started_at)
      VALUES ('future','t',1,'sub','something-new','x','external','owner','done',1)`).run()).not.toThrow();
    closeDatabase(db);

    // 源码级：整表重建走的是 `DROP TABLE` / `ALTER TABLE … RENAME`，两者在这份文件里一个都不许有。
    // 上面那条读的是结果，这条读的是手法 —— 一次「先建新表再改名」同样能让结果看起来对。
    const text = source(`${REAL_MIGRATIONS}/${WORKER_KIND_MIGRATION}`);
    expect(text).not.toContain(code('DROP TABLE'));
    expect(text).not.toContain(code('RENAME'));
    expect(text).toContain(code('ALTER TABLE agent_runs ADD COLUMN worker_kind TEXT;'));
    // 回填的顺序不能反：ACP 是 kind='sub' 的子集，先认它，剩下的 sub 才是 lw。
    // 反过来写的话第一条会把 ACP 行一起认成 lw，而第二条再也改不回来（它只看 IS NULL）。
    const acpAt = codeIndex(text, "UPDATE agent_runs SET worker_kind = 'acp'");
    const lwAt = codeIndex(text, "UPDATE agent_runs SET worker_kind = 'lw'");
    expect(acpAt, '找不到 ACP 那条回填').toBeGreaterThan(0);
    expect(lwAt, '找不到 lw 那条回填').toBeGreaterThan(0);
    expect(acpAt, 'ACP 那条回填排在 lw 之后，存量 ACP 行会被认成 lw').toBeLessThan(lwAt);
  });

  it('同一个库跑两次迁移，0018 只执行一次', () => {
    const db = upgradeAcross0018('migration-0018-idempotent');
    const applied = (): number =>
      db.prepare('SELECT COUNT(*) FROM __drizzle_migrations WHERE name=?').pluck().get(WORKER_KIND_MIGRATION) as number;
    expect(applied()).toBe(1);
    // 第二趟：`CREATE INDEX` 没有 `IF NOT EXISTS`，真的再执行一次会当场抛。
    expect(() => migrateDatabase(db, './data/migration-0018-idempotent/migrations')).not.toThrow();
    expect(applied()).toBe(1);
    expect(db.prepare("SELECT COUNT(*) FROM pragma_table_info('agent_runs') WHERE name='worker_kind'").pluck().get()).toBe(1);
    closeDatabase(db);
  });
});
