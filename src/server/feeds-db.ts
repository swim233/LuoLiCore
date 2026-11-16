import { DatabaseSync } from 'node:sqlite';

// 洛璃服务自己的 SQLite 文件（默认数据库所在目录下的 feeds.db，LUOLI_FEEDS_DB；ADR-0014），
// 不进核心的表：服务每天发了多少次请求；监视的来源、查到的动态、谁在盯哪个来源。
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
  `
-- 来源：服务、接口、参数、条目在哪、认新旧都相同的一处，只查一次，分给盯着它的每个监视任务
CREATE TABLE sources (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  identity         TEXT NOT NULL UNIQUE,      -- 认来源用的 JSON（见 sourceIdentity）
  service          TEXT NOT NULL,
  endpoint         TEXT NOT NULL,
  params           TEXT NOT NULL,             -- 参数的 JSON，按名字排好
  items            TEXT NOT NULL,             -- 条目在哪（路径）
  item_key         TEXT NOT NULL,             -- 认新旧的字段（路径）
  created_at       TEXT NOT NULL,
  last_checked_at  TEXT,                      -- 上次检查（成功、失败都算）
  last_success_at  TEXT,
  next_check_at    TEXT,                      -- 下次什么时候查
  failing_since    TEXT,                      -- 从什么时候起连续失败；没在失败时为 NULL
  failures         INTEGER NOT NULL DEFAULT 0,-- 连续失败了几次
  failure_kind     TEXT,                      -- 最近一次失败的类别
  failure_status   INTEGER,                   -- 最近一次失败的状态码（服务回了错误时）
  failure_text     TEXT,                      -- 最近一次失败的说明
  failure_reported INTEGER NOT NULL DEFAULT 0 -- 这一轮故障在会话里说过没有
);
-- 动态：一个来源查到的每一条，同一个编号只存一次，以后内容变了不更新；一直保留
CREATE TABLE feed_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id     INTEGER NOT NULL REFERENCES sources(id),
  item_key      TEXT NOT NULL,                -- 编号（key 的值，数字照原文的写法）
  first_seen_at TEXT NOT NULL,
  data          TEXT NOT NULL,                -- 这一条的 JSON 原文（数字照原文），最多 64 KB
  truncated     INTEGER NOT NULL DEFAULT 0,   -- data 超过 64 KB、截掉了
  UNIQUE (source_id, item_key)
);
-- 谁在盯：每个监视任务盯着哪个来源、看到了哪里（游标：处理过的最后一条动态）
CREATE TABLE watchers (
  task_id    INTEGER PRIMARY KEY,
  source_id  INTEGER NOT NULL REFERENCES sources(id),
  cursor     INTEGER,                         -- NULL：刚补上，下一次查到的只存不到点
  created_at TEXT NOT NULL
);
CREATE INDEX watchers_source ON watchers(source_id);
`,
];

/** 一条动态最多存多少字节 */
export const maxItemBytes = 64 * 1024;

/** 来源是什么：服务、接口、参数（值是字符串、数字、布尔值）、条目在哪、认新旧的字段 */
export type SourceSpec = {
  service: string;
  endpoint: string;
  params: Readonly<Record<string, string | number | boolean>>;
  items: string;
  key: string;
};

/**
 * 认来源用的写法：参数按名字排好、值按文字比（10 和 "10" 是同一个来源），连同服务、接口、条目在哪、
 * 认新旧写成 JSON
 */
export function sourceIdentity({ service, endpoint, params, items, key }: SourceSpec): string {
  const sorted = Object.entries(params)
    .map(([name, value]): [string, string] => [name, String(value)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify([service, endpoint, sorted, items, key]);
}

/** 一个来源，连同它的检查状态 */
export type FeedSource = SourceSpec & {
  id: number;
  createdAt: string;
  lastCheckedAt?: string;
  lastSuccessAt?: string;
  nextCheckAt?: string;
  /** 正在连续失败时有 */
  failure?: {
    since: string;
    /** 连续失败了几次 */
    count: number;
    kind: string;
    status?: number;
    text: string;
    /** 这一轮故障在会话里说过了 */
    reported: boolean;
  };
};

/** 一条动态 */
export type FeedItem = {
  id: number;
  key: string;
  firstSeenAt: string;
  data: string;
  truncated: boolean;
};

/** 一个监视任务盯着哪个来源、看到了哪里 */
export type Watcher = { taskId: number; sourceId: number; cursor?: number; createdAt: string };

const schemaVersion = migrations.length;

export type FeedsDb = {
  /** 这个服务在这一天已经发了几次请求 */
  requestsOn(service: string, day: string): number;
  /**
   * 要发一次请求：这一天还没到 limit 次时记上一次，返回这是第几次；到了时不记，返回 undefined。
   * 检查和记数是一步，几个请求同时要发也不会超过 limit
   */
  reserveRequest(service: string, day: string, limit: number): number | undefined;
  /** 找来源（按 sourceIdentity），没有时建一个 */
  ensureSource(spec: SourceSpec, at: string): FeedSource;
  source(id: number): FeedSource | undefined;
  /**
   * 存一次查到的条目：没见过的编号存进来（按给的先后），见过的不动。data 超过 maxItemBytes 的截掉并标出。
   * 返回新存的几条
   */
  storeItems(
    sourceId: number,
    items: ReadonlyArray<{ key: string; data: string }>,
    at: string,
  ): number;
  /** 这个来源最后一条动态的 id；还没有时为 0 */
  lastItemId(sourceId: number): number;
  /** 这个来源 id 大于 after 的动态，按 id 的先后 */
  itemsAfter(sourceId: number, after: number): FeedItem[];
  /** 这个来源的全部动态，按 id 的先后（测试、查看用） */
  items(sourceId: number): FeedItem[];
  /** 查通了：记上次检查、上次成功的时间，清掉失败的记录 */
  recordSuccess(sourceId: number, at: string): void;
  /**
   * 查不到：记上次检查的时间、连续失败（第一次失败时记下从什么时候起）、最近一次的类别与说明。
   * restart：这一轮从这一次重新算（从什么时候起是 at，次数从 1 起；说过没有不变）
   */
  recordFailure(
    sourceId: number,
    at: string,
    failure: { kind: string; status?: number; text: string; restart?: boolean },
  ): void;
  /** 这一轮故障在会话里说过了 */
  markReported(sourceId: number): void;
  setNextCheck(sourceId: number, at: string | undefined): void;
  /** 开始盯：一个任务只盯一个来源，再盯时换成新的 */
  watch(taskId: number, sourceId: number, cursor: number | undefined, at: string): void;
  unwatch(taskId: number): void;
  watcher(taskId: number): Watcher | undefined;
  watchers(): Watcher[];
  setCursor(taskId: number, cursor: number): void;
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

  const sourceByIdentity = db.prepare('SELECT * FROM sources WHERE identity = ?');
  const sourceById = db.prepare('SELECT * FROM sources WHERE id = ?');
  const insertSource = db.prepare(
    `INSERT INTO sources (identity, service, endpoint, params, items, item_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
  );
  const insertItem = db.prepare(
    `INSERT INTO feed_items (source_id, item_key, first_seen_at, data, truncated)
     VALUES (?, ?, ?, ?, ?) ON CONFLICT (source_id, item_key) DO NOTHING`,
  );
  const lastItem = db.prepare('SELECT MAX(id) AS id FROM feed_items WHERE source_id = ?');
  const itemsAfter = db.prepare(
    'SELECT * FROM feed_items WHERE source_id = ? AND id > ? ORDER BY id',
  );
  const success = db.prepare(
    `UPDATE sources SET last_checked_at = ?, last_success_at = ?, failing_since = NULL,
       failures = 0, failure_kind = NULL, failure_status = NULL, failure_text = NULL,
       failure_reported = 0
     WHERE id = ?`,
  );
  const failure = db.prepare(
    `UPDATE sources SET last_checked_at = :at, failing_since = COALESCE(failing_since, :at),
       failures = failures + 1, failure_kind = :kind, failure_status = :status,
       failure_text = :text
     WHERE id = :id`,
  );
  const restartedFailure = db.prepare(
    `UPDATE sources SET last_checked_at = :at, failing_since = :at, failures = 1,
       failure_kind = :kind, failure_status = :status, failure_text = :text
     WHERE id = :id`,
  );
  const reported = db.prepare('UPDATE sources SET failure_reported = 1 WHERE id = ?');
  const nextCheck = db.prepare('UPDATE sources SET next_check_at = ? WHERE id = ?');
  const upsertWatcher = db.prepare(
    `INSERT INTO watchers (task_id, source_id, cursor, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (task_id) DO UPDATE SET source_id = excluded.source_id,
       cursor = excluded.cursor, created_at = excluded.created_at`,
  );
  const deleteWatcher = db.prepare('DELETE FROM watchers WHERE task_id = ?');
  const watcherById = db.prepare('SELECT * FROM watchers WHERE task_id = ?');
  const allWatchers = db.prepare('SELECT * FROM watchers ORDER BY task_id');
  const cursorOf = db.prepare('UPDATE watchers SET cursor = ? WHERE task_id = ?');

  return {
    requestsOn,
    // node:sqlite 是同步的：查和记之间不会插进别的请求
    reserveRequest(service, day, limit) {
      if (requestsOn(service, day) >= limit) return undefined;
      add.run(service, day);
      return requestsOn(service, day);
    },
    ensureSource(spec, at) {
      const identity = sourceIdentity(spec);
      const found = sourceByIdentity.get(identity);
      if (found) return source(found);
      const params = Object.fromEntries(
        Object.entries(spec.params).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
      return source(
        insertSource.get(
          identity,
          spec.service,
          spec.endpoint,
          JSON.stringify(params),
          spec.items,
          spec.key,
          at,
        )!,
      );
    },
    source(id) {
      const row = sourceById.get(id);
      return row && source(row);
    },
    storeItems(sourceId, items, at) {
      let stored = 0;
      transaction(db, () => {
        for (const { key, data } of items) {
          const bytes = Buffer.from(data, 'utf8');
          const truncated = bytes.length > maxItemBytes;
          // 截在一个字的开头（UTF-8 的后续字节是 10xxxxxx），不留半个字
          let end = maxItemBytes;
          while (truncated && end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
          const text = truncated ? bytes.subarray(0, end).toString('utf8') : data;
          stored += Number(insertItem.run(sourceId, key, at, text, truncated ? 1 : 0).changes);
        }
      });
      return stored;
    },
    lastItemId: (sourceId) => Number(lastItem.get(sourceId)?.id ?? 0),
    itemsAfter: (sourceId, after) => itemsAfter.all(sourceId, after).map(feedItem),
    items: (sourceId) => itemsAfter.all(sourceId, 0).map(feedItem),
    recordSuccess(sourceId, at) {
      success.run(at, at, sourceId);
    },
    recordFailure(sourceId, at, { kind, status, text, restart = false }) {
      (restart ? restartedFailure : failure).run({
        id: sourceId,
        at,
        kind,
        status: status ?? null,
        text,
      });
    },
    markReported(sourceId) {
      reported.run(sourceId);
    },
    setNextCheck(sourceId, at) {
      nextCheck.run(at ?? null, sourceId);
    },
    watch(taskId, sourceId, cursor, at) {
      upsertWatcher.run(taskId, sourceId, cursor ?? null, at);
    },
    unwatch(taskId) {
      deleteWatcher.run(taskId);
    },
    watcher(taskId) {
      const row = watcherById.get(taskId);
      return row && watcher(row);
    },
    watchers: () => allWatchers.all().map(watcher),
    setCursor(taskId, cursor) {
      cursorOf.run(cursor, taskId);
    },
    close() {
      if (db.isOpen) db.close();
    },
  };
}

type Row = Record<string, unknown>;
const optional = (value: unknown) =>
  value === null || value === undefined ? undefined : String(value);

function source(row: Row): FeedSource {
  const since = optional(row.failing_since);
  const failureStatus = row.failure_status === null ? undefined : Number(row.failure_status);
  const times = {
    lastCheckedAt: optional(row.last_checked_at),
    lastSuccessAt: optional(row.last_success_at),
    nextCheckAt: optional(row.next_check_at),
  };
  return {
    id: Number(row.id),
    service: String(row.service),
    endpoint: String(row.endpoint),
    params: JSON.parse(String(row.params)) as SourceSpec['params'],
    items: String(row.items),
    key: String(row.item_key),
    createdAt: String(row.created_at),
    ...Object.fromEntries(Object.entries(times).filter(([, value]) => value !== undefined)),
    ...(since === undefined
      ? {}
      : {
          failure: {
            since,
            count: Number(row.failures),
            kind: String(row.failure_kind),
            ...(failureStatus === undefined ? {} : { status: failureStatus }),
            text: String(row.failure_text),
            reported: Number(row.failure_reported) === 1,
          },
        }),
  };
}

function feedItem(row: Row): FeedItem {
  return {
    id: Number(row.id),
    key: String(row.item_key),
    firstSeenAt: String(row.first_seen_at),
    data: String(row.data),
    truncated: Number(row.truncated) === 1,
  };
}

function watcher(row: Row): Watcher {
  return {
    taskId: Number(row.task_id),
    sourceId: Number(row.source_id),
    ...(row.cursor === null ? {} : { cursor: Number(row.cursor) }),
    createdAt: String(row.created_at),
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
