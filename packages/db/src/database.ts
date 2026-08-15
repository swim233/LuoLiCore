import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Sqlite = Database.Database;

export function openDatabase(path: string): Sqlite {
  const absolute = resolve(path);
  mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
  const db = new Database(absolute);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('temp_store = MEMORY');
  db.pragma('mmap_size = 268435456');
  db.pragma('cache_size = -32000');
  return db;
}

export function migrateDatabase(db: Sqlite, migrationsDir = fileURLToPath(new URL('../migrations', import.meta.url))): void {
  db.exec('CREATE TABLE IF NOT EXISTS __drizzle_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const applied = db.prepare('SELECT name FROM __drizzle_migrations').all().map((row) => (row as { name: string }).name);
  const seen = new Set(applied);
  const pending = readdirSync(migrationsDir).filter((entry) => /^\d{4}_.+\.sql$/.test(entry)).sort().filter((entry) => !seen.has(entry));
  if (pending.length && applied.length) {
    const database = db.name;
    if (database && existsSync(database)) {
      const directory = resolve(dirname(database), 'backup');
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const path = join(directory, `luoli-${Date.now()}-pre-${pending[0]!.slice(0, 4)}.db`);
      db.exec(`VACUUM INTO '${path.replaceAll("'", "''")}'`);
    }
  }
  for (const name of pending) {
    const sql = readFileSync(join(migrationsDir, name), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO __drizzle_migrations(name, applied_at) VALUES (?, ?)').run(name, Date.now());
    })();
  }
}

export function recoverAfterCrash(db: Sqlite): void {
  const now = Date.now();
  db.transaction(() => {
    db.prepare("UPDATE turns SET state='failed', error='process_restarted', finished_at=? WHERE state IN ('queued','running')").run(now);
    db.prepare("UPDATE tasks SET state='failed',result_summary='process_restarted',updated_at=?,finished_at=? WHERE state='running'").run(now, now);
    db.prepare("UPDATE agent_runs SET state='failed',error='process_restarted',finished_at=? WHERE state='running'").run(now);
    db.prepare("UPDATE agent_messages SET state='timeout',answered_at=? WHERE state='sent' AND turn_id IN (SELECT id FROM turns WHERE state='failed' AND error='process_restarted')").run(now);
    db.prepare('UPDATE messages SET claimed_at=NULL,claimed_by_turn=NULL WHERE claimed_by_turn IS NOT NULL').run();
    db.prepare('UPDATE quota_counters SET reserved_usd=0, updated_at=? WHERE reserved_usd != 0').run(now);
  })();
}

export function closeDatabase(db: Sqlite): void {
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
}
