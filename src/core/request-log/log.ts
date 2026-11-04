import { DatabaseSync } from 'node:sqlite';
import type { FileStore } from '../files.js';
import { embedImages, fileToDataUrl, joinBody, splitBody } from './body.js';

/** 一次实际发出的请求：写入时的说明与内容（ADR-0008） */
export type NewRequest = {
  conversationId: string;
  purpose: 'reply' | 'summary';
  /** 回复 id；摘要没有 */
  replyId?: string;
  /** 回复的第几步，从 1 开始；摘要没有 */
  step?: number;
  /** 这一步的第几次尝试，从 1 开始 */
  attempt: number;
  /** 开始时间（ISO）；存成 UTC */
  startedAt: string;
  durationMs: number;
  outcome: 'completed' | 'failed' | 'aborted';
  /** 实际发出的请求体，原样的字符串 */
  body: string;
  response: RequestResponse;
};

/** 整理过的响应。存储只原样存取，不解读 */
export type RequestResponse = {
  status?: number;
  text?: string;
  reasoning?: string;
  /** arguments 是模型给的原样字符串 */
  toolCalls?: Array<{ id?: string; name: string; arguments: string }>;
  finishReason?: string;
  usage?: { input?: number; cacheRead?: number; output?: number; reasoning?: number };
  /** 失败时的错误体 */
  error?: string;
};

/** 读出的一次请求 */
export type LoggedRequest = Omit<NewRequest, 'body'> & {
  /** 读出用的 id，按写入先后递增 */
  id: number;
  /** 拼回的完整请求体；原样存的（不是紧凑的 JSON 对象）是写入时的字符串 */
  body: Record<string, unknown> | string;
  /** embedImages 时，文件存储里读不到、照旧是 `luoli-file:` 地址的图片；没有时不出现 */
  missingImages?: string[];
};

/** 读出的条件；都不给时返回全部 */
export type RequestFilter = {
  /** 属于这些会话之一；空数组什么也不匹配 */
  conversationIds?: string[];
  /** 开始时间不早于它（含） */
  since?: Date | string;
  /** 开始时间早于它（不含） */
  until?: Date | string;
  replyId?: string;
  /** 只看结果是 failed 的 */
  failedOnly?: boolean;
};

export type RequestListOptions = {
  /** 把图片的 `luoli-file:` 地址换回 data URL，请求体与发出时一字不差 */
  embedImages?: boolean;
};

/** 清理删掉的条数 */
export type RequestCleanup = { requests: number; contents: number };

export type RequestCleanupOptions = {
  /** 「现在」，默认当前时间（测试用） */
  now?: Date;
  /** 每批最多删几条请求（默认 100）；每批一个事务，批与批之间让出事件循环 */
  batchSize?: number;
  /** 中止时在下一批开始前停下，返回已删的条数 */
  signal?: AbortSignal;
};

export type RequestLog = {
  /** 写入一次请求；在一个事务里完成。只读时抛错 */
  record(request: NewRequest): Promise<void>;
  /** 按条件读出，按开始时间升序，相同时按写入先后 */
  list(filter?: RequestFilter, options?: RequestListOptions): Promise<LoggedRequest[]>;
  /**
   * 删掉开始时间早于「now 减保留天数」的请求，再删掉剩下的请求都不再引用的内容。分批进行：
   * 每批按开始时间从早到晚取一些过期请求，在一个事务里删掉它们与只被它们引用的内容；
   * 批与批之间让出事件循环（node:sqlite 等锁、删除都是同步的，一次删很多会长时间卡住进程）。
   * 保留天数为 0 时什么也不删。只读时抛错。不碰文件存储
   */
  cleanup(options?: RequestCleanupOptions): Promise<RequestCleanup>;
  close(): void;
};

export type RequestLogOptions = {
  /** 数据库文件；写模式下不存在就创建（目录须已存在），只读时不存在就报错 */
  path: string;
  /** 会话用的文件存储：写入时看图片在不在，读出时把图片嵌回 */
  fileStore: FileStore;
} & (
  | { readOnly?: false; /** 保留天数，0 为永久 */ retentionDays: number }
  | { readOnly: true; retentionDays?: number }
);

// ADR-0008「怎么存」的表结构。与 data/luoli.db 是两个文件，会话 id、回复 id 只是对应，没有外键。
// 第 i 项把版本 i 的库升到 i + 1：新库（版本 0）依次执行全部，已有的库只执行比它新的部分
const migrations = [
  `
CREATE TABLE requests (
  id              INTEGER PRIMARY KEY,
  conversation_id TEXT NOT NULL,     -- 会话 id，对应 data/luoli.db 的 conversations.id
  purpose         TEXT NOT NULL,     -- 'reply' | 'summary'
  reply_id        TEXT,              -- 回复 id；摘要为空
  step            INTEGER,           -- 回复的第几步，从 1 开始；摘要为空
  attempt         INTEGER NOT NULL,  -- 这一步的第几次尝试，从 1 开始
  started_at      TEXT NOT NULL,     -- 开始时间（ISO，UTC）
  duration_ms     INTEGER NOT NULL,
  outcome         TEXT NOT NULL,     -- 'completed' | 'failed' | 'aborted'
  body_format     TEXT NOT NULL,     -- 'split'：拆开存（见 body.ts）；'raw'：原样的字符串
  body            TEXT NOT NULL,     -- split 时 messages 换成哈希的数组，tools 换成只含一个哈希的数组
  response        TEXT NOT NULL      -- 整理过的响应（JSON）
);
CREATE INDEX requests_time         ON requests(started_at);
CREATE INDEX requests_conversation ON requests(conversation_id, started_at);
CREATE INDEX requests_reply        ON requests(reply_id) WHERE reply_id IS NOT NULL;

-- 按内容去重：一条消息（图片已换成 luoli-file: 地址），或整份工具定义
CREATE TABLE contents (
  hash    TEXT PRIMARY KEY,          -- content 的 SHA-256（UTF-8，十六进制）
  content TEXT NOT NULL              -- JSON
);

-- 请求引用了哪些内容（同一请求里重复的只记一次）；清理时据此找出没人引用的内容
CREATE TABLE request_contents (
  request_id   INTEGER NOT NULL REFERENCES requests(id),
  content_hash TEXT NOT NULL REFERENCES contents(hash),
  PRIMARY KEY (request_id, content_hash)
) WITHOUT ROWID;
CREATE INDEX request_contents_hash ON request_contents(content_hash);
`,
];

const schemaVersion = migrations.length;

const day = 24 * 60 * 60 * 1000;

/** 打开请求记录的数据库（ADR-0008） */
export function openRequestLog(options: RequestLogOptions): RequestLog {
  const { path, fileStore, readOnly = false } = options;
  const retentionDays = options.retentionDays ?? 0;
  if (!Number.isFinite(retentionDays) || retentionDays < 0) {
    throw new RangeError(`保留天数须为不小于 0 的数：${retentionDays}`);
  }

  const db = new DatabaseSync(path, { readOnly });
  try {
    // 另一个进程正在写时等它，而不是立即报 SQLITE_BUSY
    db.exec('PRAGMA busy_timeout = 5000');
    if (readOnly) checkVersion(db);
    else migrate(db);
  } catch (error) {
    db.close();
    throw error;
  }

  const insertContent = db.prepare(
    'INSERT INTO contents (hash, content) VALUES (?, ?) ON CONFLICT (hash) DO NOTHING',
  );
  const insertRequest = db.prepare(
    `INSERT INTO requests
       (conversation_id, purpose, reply_id, step, attempt, started_at, duration_ms, outcome,
        body_format, body, response)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertLink = db.prepare(
    'INSERT INTO request_contents (request_id, content_hash) VALUES (?, ?)',
  );
  const selectContent = db.prepare('SELECT content FROM contents WHERE hash = ?');
  // 一批过期请求：开始时间最早的 batchSize 条。同一个事务里两次取到的是同一批
  const expiredBatch =
    'SELECT id FROM requests WHERE started_at < ? ORDER BY started_at, id LIMIT ?';
  // 先摘下这批请求的引用，记下它们引用过的内容，再删请求，最后删其中没人再引用的内容：
  // 只看这批请求引用过的内容，不扫整张表
  const unlinkExpired = db.prepare(
    `DELETE FROM request_contents WHERE request_id IN (${expiredBatch}) RETURNING content_hash`,
  );
  const deleteExpired = db.prepare(`DELETE FROM requests WHERE id IN (${expiredBatch})`);
  const deleteUnused = db.prepare(
    `DELETE FROM contents
     WHERE hash = ? AND NOT EXISTS (SELECT 1 FROM request_contents WHERE content_hash = ?)`,
  );

  const writable = (action: string) => {
    if (readOnly) throw new Error(`请求记录是只读打开的，不能${action}`);
  };

  return {
    async record(request) {
      writable('写入');
      const startedAt = isoTime(request.startedAt);
      const { format, body, contents } = await splitBody(request.body, fileStore);
      transaction(db, 'IMMEDIATE', () => {
        for (const [hash, content] of contents) insertContent.run(hash, content);
        const { lastInsertRowid } = insertRequest.run(
          request.conversationId,
          request.purpose,
          request.replyId ?? null,
          request.step ?? null,
          request.attempt,
          startedAt,
          request.durationMs,
          request.outcome,
          format,
          body,
          JSON.stringify(request.response),
        );
        for (const hash of contents.keys()) insertLink.run(lastInsertRowid, hash);
      });
    },

    async list(filter = {}, { embedImages: embed = false } = {}) {
      const { sql, params } = query(filter);
      const statement = db.prepare(sql);
      // 同一条内容在一次读出里只查一次库；在一个读事务里读完，期间别的连接清理也不会缺内容
      const contents = new Map<string, string>();
      const content = (hash: string): string => {
        let text = contents.get(hash);
        if (text === undefined) {
          const row = selectContent.get(hash);
          if (!row) throw new Error(`请求记录缺少内容 ${hash}`);
          text = String(row.content);
          contents.set(hash, text);
        }
        return text;
      };
      const requests = transaction(db, 'DEFERRED', () =>
        statement.all(...params).map((row) => loggedRequest(row, content)),
      );
      if (!embed) return requests;

      // 同一张图只读一次文件
      const images = new Map<string, Promise<string | undefined>>();
      const read = (url: string) => {
        let image = images.get(url);
        if (image === undefined) {
          image = fileToDataUrl(url, fileStore);
          images.set(url, image);
        }
        return image;
      };
      for (const request of requests) {
        if (typeof request.body === 'string') continue;
        const missing = await embedImages(request.body, read);
        if (missing.length > 0) request.missingImages = missing;
      }
      return requests;
    },

    async cleanup({ now = new Date(), batchSize = 100, signal } = {}) {
      writable('清理');
      if (!(Number.isSafeInteger(batchSize) && batchSize > 0)) {
        throw new RangeError(`每批条数须为正整数：${batchSize}`);
      }
      const total = { requests: 0, contents: 0 };
      if (retentionDays === 0) return total;
      const cutoff = new Date(now.getTime() - retentionDays * day).toISOString();
      for (;;) {
        if (signal?.aborted) return total;
        const batch = transaction(db, 'IMMEDIATE', () => {
          const hashes = new Set(
            unlinkExpired.all(cutoff, batchSize).map((row) => String(row.content_hash)),
          );
          const requests = Number(deleteExpired.run(cutoff, batchSize).changes);
          let contents = 0;
          for (const hash of hashes) contents += Number(deleteUnused.run(hash, hash).changes);
          return { requests, contents };
        });
        total.requests += batch.requests;
        total.contents += batch.contents;
        if (batch.requests < batchSize) return total;
        await new Promise((resolve) => setImmediate(resolve));
      }
    },

    close() {
      if (db.isOpen) db.close();
    },
  };
}

function migrate(db: DatabaseSync): void {
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  if (version(db) === schemaVersion) return;
  // 一个事务里升到最新；两个进程同时打开新文件时，后拿到锁的那个重新看版本，不重复建表
  transaction(db, 'IMMEDIATE', () => {
    const current = version(db);
    if (current > schemaVersion) throw newerError(current);
    if (current === schemaVersion) return;
    for (const migration of migrations.slice(current)) db.exec(migration);
    db.exec(`PRAGMA user_version = ${schemaVersion}`);
  });
}

/** 只读打开时不能升级：版本须与程序一致 */
function checkVersion(db: DatabaseSync): void {
  const current = version(db);
  if (current > schemaVersion) throw newerError(current);
  if (current < schemaVersion) {
    throw new Error(
      `请求记录的数据库版本比程序旧（文件为 ${current}，程序为 ${schemaVersion}），先用写模式打开一次`,
    );
  }
}

function version(db: DatabaseSync): number {
  return Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
}

function newerError(current: number): Error {
  return new Error(`请求记录的数据库版本比程序新（文件为 ${current}，程序支持 ${schemaVersion}）`);
}

/**
 * 在事务里执行。写用 IMMEDIATE：开始时就拿写锁，拿不到按 busy_timeout 等；先读后写的
 * DEFERRED 事务升级写锁时等不了，会直接报 SQLITE_BUSY
 */
function transaction<T>(db: DatabaseSync, mode: 'IMMEDIATE' | 'DEFERRED', run: () => T): T {
  db.exec(`BEGIN ${mode}`);
  try {
    const result = run();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function query(filter: RequestFilter): { sql: string; params: Array<string> } {
  const conditions: string[] = [];
  const params: string[] = [];
  if (filter.conversationIds !== undefined) {
    conditions.push(`conversation_id IN (${filter.conversationIds.map(() => '?').join(', ')})`);
    params.push(...filter.conversationIds);
  }
  if (filter.since !== undefined) {
    conditions.push('started_at >= ?');
    params.push(isoTime(filter.since));
  }
  if (filter.until !== undefined) {
    conditions.push('started_at < ?');
    params.push(isoTime(filter.until));
  }
  if (filter.replyId !== undefined) {
    conditions.push('reply_id = ?');
    params.push(filter.replyId);
  }
  if (filter.failedOnly) conditions.push(`outcome = 'failed'`);
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return { sql: `SELECT * FROM requests ${where} ORDER BY started_at, id`, params };
}

/** 时间统一成 UTC 的 ISO 字符串：库里按字符串比较，格式须一致 */
function isoTime(time: Date | string): string {
  const date = new Date(time);
  if (Number.isNaN(date.getTime())) throw new RangeError(`时间格式不对：${String(time)}`);
  return date.toISOString();
}

function loggedRequest(
  row: Record<string, unknown>,
  content: (hash: string) => string,
): LoggedRequest {
  const body = String(row.body);
  return {
    id: Number(row.id),
    conversationId: String(row.conversation_id),
    purpose: String(row.purpose) as LoggedRequest['purpose'],
    replyId: optional(row.reply_id),
    step: optionalNumber(row.step),
    attempt: Number(row.attempt),
    startedAt: String(row.started_at),
    durationMs: Number(row.duration_ms),
    outcome: String(row.outcome) as LoggedRequest['outcome'],
    body: row.body_format === 'split' ? joinBody(body, content) : body,
    response: JSON.parse(String(row.response)) as RequestResponse,
  };
}

// NULL 列读成 undefined
function optional(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

function optionalNumber(value: unknown): number | undefined {
  return value === null || value === undefined ? undefined : Number(value);
}
