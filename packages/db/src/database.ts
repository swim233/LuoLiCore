import Database from "better-sqlite3";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type Sqlite = Database.Database;

export function openDatabase(path: string): Sqlite {
  const absolute = resolve(path);
  mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
  const db = new Database(absolute);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("temp_store = MEMORY");
  db.pragma("mmap_size = 268435456");
  db.pragma("cache_size = -32000");
  return db;
}

export function migrateDatabase(
  db: Sqlite,
  migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url)),
): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS __drizzle_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)",
  );
  const applied = db
    .prepare("SELECT name FROM __drizzle_migrations")
    .all()
    .map((row) => (row as { name: string }).name);
  const seen = new Set(applied);
  const pending = readdirSync(migrationsDir)
    .filter((entry) => /^\d{4}_.+\.sql$/.test(entry))
    .sort()
    .filter((entry) => !seen.has(entry));
  if (pending.length && applied.length) {
    const database = db.name;
    if (database && existsSync(database)) {
      const directory = resolve(dirname(database), "backup");
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const path = join(
        directory,
        `luoli-${Date.now()}-pre-${pending[0]!.slice(0, 4)}.db`,
      );
      // `VACUUM INTO` 收的是 SQL 表达式，所以能绑参数。这里的 path 不含外部输入，
      // 但「自己转义 SQL 引号」不该是仓库里留着的先例（docs/27 · T-05）。
      db.prepare("VACUUM INTO ?").run(path);
      // 同 `MaintenanceService.backup()`：`VACUUM INTO` 建的文件是 `0666 & ~umask`，
      // 默认落成 0644 —— 一份全局可读的整库快照（docs/29 · `M-SEC-01`）。
      chmodSync(path, 0o600);
    }
  }
  for (const name of pending) {
    const sql = readFileSync(join(migrationsDir, name), "utf8");
    db.transaction(() => {
      db.exec(sql);
      db.prepare(
        "INSERT INTO __drizzle_migrations(name, applied_at) VALUES (?, ?)",
      ).run(name, Date.now());
    })();
  }
}

/** 一次非正常重启到底 reap 了什么。**必须报出来** —— 见 `recoverAfterCrash` 的注释。 */
export interface CrashRecovery {
  turns: number;
  tasks: number;
  agentRuns: number;
  agentMessages: number;
  claims: number;
  reservations: number;
}

/**
 * **返回计数而不是 void。** 这个函数在 `main.ts` 里比 `LogSink` 早 26 行被调用，结构上没法自己
 * 记日志，于是一次非正常重启之后「reap 了几条 turn / task / agent_run、释放了多少认领、清了
 * 多少预留」在日志里一个字都没有 —— `docs/00 §2` 自述 8-18 那两次崩溃「只能靠 `turns` 表里两行
 * `process_restarted` 反推」，正是这条造成的（`docs/reviews/28 · L-OPS-04`）。
 * 调用方拿这份计数先 `process.stdout.write`，等 sink 建好之后再补一条 `system.recovered`。
 *
 * **它假定「进程启动 ⇒ 上一个进程已死」**，而保证这件事的是 `acquireInstanceLock`
 * （`L-OPS-01`：在它之前，第二个实例启动会把在位实例正在跑的轮次就地判死）。
 * 调用顺序因此是 open → migrate → **拿锁** → recover。
 */
export function recoverAfterCrash(db: Sqlite): CrashRecovery {
  const now = Date.now();
  return db.transaction((): CrashRecovery => ({
    turns: db
      .prepare(
        "UPDATE turns SET state='failed', error='process_restarted', finished_at=? WHERE state IN ('queued','running')",
      )
      .run(now).changes,
    tasks: db
      .prepare(
        "UPDATE tasks SET state='failed',result_summary='process_restarted',updated_at=?,finished_at=? WHERE state='running'",
      )
      .run(now, now).changes,
    agentRuns: db
      .prepare(
        "UPDATE agent_runs SET state='failed',error='process_restarted',finished_at=? WHERE state='running'",
      )
      .run(now).changes,
    agentMessages: db
      .prepare(
        "UPDATE agent_messages SET state='timeout',answered_at=? WHERE state='sent' AND turn_id IN (SELECT id FROM turns WHERE state='failed' AND error='process_restarted')",
      )
      .run(now).changes,
    claims: db
      .prepare(
        "UPDATE messages SET claimed_at=NULL,claimed_by_turn=NULL WHERE claimed_by_turn IS NOT NULL",
      )
      .run().changes,
    reservations: db
      .prepare(
        "UPDATE quota_counters SET reserved_usd=0, updated_at=? WHERE reserved_usd != 0",
      )
      .run(now).changes,
  }))();
}

export function closeDatabase(db: Sqlite): void {
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.close();
}
