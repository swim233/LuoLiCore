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
import {
  LOG_SCHEMA,
  attachLogDatabase,
  importLegacyLogEvents,
} from "./logs.js";

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

/** 日志库的位置与搬迁参数。默认值只服务于测试与 CLI —— 生产由 `logs.dbPath` 指定。 */
export interface LogStoreOptions {
  /** 默认从主库路径派生，使两者在同一目录里成对出现（也让测试的清理循环能一并扫到）。 */
  path?: string;
  /** 存量 `logs/<day>/blobs/*.json` 的所在目录，搬迁时解引用用。 */
  legacyDir?: string;
  compress?: boolean;
}

/**
 * 第三个参数是日志库。四件事的**顺序不能动**（docs/10 §3）：
 * ① 先把 `logs.db` 建好、迁移、ATTACH 上来；② 照常做迁移前那份整库备份；③ 把主库里的存量
 * `log_events` 搬过去；④ 最后才应用主库迁移 —— `0017` 会删掉主库那张表，跑在搬迁之前就是
 * 把存量日志直接删了。而不删又不行：它只要还在就会按 main 优先的解析顺序一直遮住附加库那张。
 *
 * ② 排在 ③ 前面是有意的：那份备份的语义是「动手之前的快照」，而搬迁**就是动手** ——
 * 排在它后面的话，一次搬坏了的结果会被原样备份下来，那份文件也就不再是退路。
 */
export function migrateDatabase(
  db: Sqlite,
  migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url)),
  logs: LogStoreOptions = {},
): void {
  attachLogDatabase(db, logs.path ?? `${db.name}-logs`);
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
      // `VACUUM INTO` 接受 SQL 表达式，因此可以绑定参数。此处的 path 不含外部输入，
      // 但手工转义 SQL 引号不应作为本仓的先例保留（docs/27 · T-05）。
      db.prepare("VACUUM INTO ?").run(path);
      // 同 `MaintenanceService.backup()`：`VACUUM INTO` 创建的文件权限为 `0666 & ~umask`，
      // 默认为 0644，即一份全局可读的整库快照（docs/29 · `M-SEC-01`）。
      chmodSync(path, 0o600);
    }
  }
  const moved = importLegacyLogEvents(
    db,
    logs.legacyDir ?? "./logs",
    logs.compress ?? true,
  );
  // 搬完 VACUUM 一次主库。`DROP TABLE` 只把页标成空闲，文件一个字节都不会小 ——
  // 实测 `log_events` 占了 88 MB 主库的 70%，不收的话运维会看到「日志搬走了而主库没变小」，
  // 而下一次 `maintenance.vacuumCron` 可能是六天以后。只在真搬过东西时做，一个部署就一次。
  if (moved && moved.rows > 0) db.exec("VACUUM");
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

/** 一次非正常重启回收了哪些资源。必须上报，理由见 `recoverAfterCrash` 的注释。 */
export interface CrashRecovery {
  turns: number;
  tasks: number;
  agentRuns: number;
  agentMessages: number;
  claims: number;
  reservations: number;
}

/**
 * 返回计数而非 void。本函数在 `main.ts` 中比 `LogSink` 早 26 行调用，结构上无法自行记日志，
 * 因此一次非正常重启后「回收了几条 turn / task / agent_run、释放了多少认领、清理了多少预留」
 * 在日志中完全缺失。`docs/00 §2` 记录的 8-18 那两次崩溃只能靠 `turns` 表里两行 `process_restarted`
 * 反推，成因即此（`docs/reviews/28 · L-OPS-04`）。
 * 调用方先用 `process.stdout.write` 输出该计数，待 sink 建立后补记一条 `system.recovered`。
 *
 * 本函数假定「进程启动即上一个进程已终止」，该前提由 `acquireInstanceLock` 保证
 * （`L-OPS-01`：在此之前，第二个实例启动会把在位实例正在执行的轮次就地判为失败）。
 * 因此调用顺序为 open → migrate → 获取锁 → recover。
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
    // 判据是 `state='running'`，**不看 `worker_kind`**（迁移 `0018`）—— 这一条收的是「上一个进程
    // 还没来得及收尾的那些行」，而那与它是主 run、lw-worker 还是外部那两条路无关。此前它事实上
    // 只命中主 run 与子 agent：ACP 的行跑完才一次性插入，落库即终态。哪条 worker 路径开出
    // running 窗口，这一条就第一次开始命中它 —— 那是插入侧的性质，不是本语句的边界，所以
    // 不许在这里补 `worker_kind` 判据把它写死成「只收自家的」。
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
  // 不带库名的 checkpoint 按文档覆盖全部附加库，但这里写明是为了让「日志库也要收尾」这件事
  // 在读代码时看得见 —— 它是一个独立文件，漏掉的表现是关停后留下一个不断长大的 logs.db-wal。
  //
  // 要先判它挂没挂：`openDatabase` 单独用而不跑 `migrateDatabase` 是合法的（只读连接就这么开），
  // 那种连接上 `PRAGMA logs.…` 会抛 `unknown database logs`，把「关个库」变成关停路径上的异常。
  db.pragma("wal_checkpoint(TRUNCATE)");
  if (
    (db.pragma("database_list") as Array<{ name: string }>).some(
      (row) => row.name === LOG_SCHEMA,
    )
  )
    db.pragma(`${LOG_SCHEMA}.wal_checkpoint(TRUNCATE)`);
  db.close();
}
