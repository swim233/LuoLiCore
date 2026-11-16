import { DatabaseSync } from 'node:sqlite';

// 洛璃服务自己的 SQLite 文件（默认数据库所在目录下的 feeds.db，LUOLI_FEEDS_DB；ADR-0014），
// 不进核心的表。现在只有服务每天发了多少次请求；监视查到的动态以后也存在这里，到时往迁移里加表。
// 第 i 项把版本 i 的库升到 i + 1
const migrations = [
  `
CREATE TABLE service_requests (
  service TEXT NOT NULL,     -- 服务名
  day     TEXT NOT NULL,     -- 服务器时区的日期，YYYY-MM-DD
  count   INTEGER NOT NULL,  -- 这一天实际发出的请求数（不管结果）
  PRIMARY KEY (service, day)
);
`,
];

const schemaVersion = migrations.length;

export type FeedsDb = {
  /** 这个服务在这一天已经发了几次请求 */
  requestsOn(service: string, day: string): number;
  /**
   * 要发一次请求：这一天还没到 limit 次时记上一次，返回这是第几次；到了时不记，返回 undefined。
   * 检查和记数是一步，几个请求同时要发也不会超过 limit
   */
  reserveRequest(service: string, day: string, limit: number): number | undefined;
  close(): void;
};

/** 打开（不存在时新建）feeds.db。目录须已存在。打不开、版本比程序新时抛错 */
export function openFeedsDb(path: string): FeedsDb {
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 5000');
    const version = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
    if (version > schemaVersion) {
      throw new Error(`feeds.db 的版本比程序新（文件为 ${version}，程序支持 ${schemaVersion}）`);
    }
    if (version < schemaVersion) {
      transaction(db, () => {
        for (const migration of migrations.slice(version)) db.exec(migration);
        db.exec(`PRAGMA user_version = ${schemaVersion}`);
      });
    }
  } catch (error) {
    db.close();
    throw error;
  }

  const countOf = db.prepare('SELECT count FROM service_requests WHERE service = ? AND day = ?');
  const add = db.prepare(
    `INSERT INTO service_requests (service, day, count) VALUES (?, ?, 1)
     ON CONFLICT (service, day) DO UPDATE SET count = count + 1`,
  );
  const requestsOn = (service: string, day: string) =>
    Number(countOf.get(service, day)?.count ?? 0);

  return {
    requestsOn,
    // node:sqlite 是同步的：查和记之间不会插进别的请求
    reserveRequest(service, day, limit) {
      if (requestsOn(service, day) >= limit) return undefined;
      add.run(service, day);
      return requestsOn(service, day);
    },
    close() {
      if (db.isOpen) db.close();
    },
  };
}

function transaction(db: DatabaseSync, run: () => void): void {
  db.exec('BEGIN');
  try {
    run();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
