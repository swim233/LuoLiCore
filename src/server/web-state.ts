import { DatabaseSync } from 'node:sqlite';

// 网页面板自己的状态，存在服务自己的 SQLite 文件（默认 data/web.db，LUOLI_WEB_DB）里，不进核心的表
// （ADR-0009）。第 i 项把版本 i 的库升到 i + 1
const migrations = [
  `
CREATE TABLE read_marks (
  conversation_id TEXT PRIMARY KEY,  -- 核心的会话 id
  seq             INTEGER NOT NULL,  -- 已读位置：看到了第几条（消息的序号）
  updated_at      TEXT NOT NULL      -- 最后一次往前推的时间（ISO）
);
`,
  `
CREATE TABLE titles (
  conversation_id TEXT PRIMARY KEY,  -- 网页会话的 id（核心的会话 id）
  title           TEXT NOT NULL,     -- 发出第一句时取的标题，只给面板显示，不进 prompt
  created_at      TEXT NOT NULL
);
`,
];

const schemaVersion = migrations.length;

export type WebState = {
  /** 会话的已读位置（看到了第几条，序号）；没有记过时为 0，从头算 */
  readSeq(conversationId: string): number;
  /** 把已读位置往前推到 seq；不比现在的大时不变。返回之后的位置 */
  advanceRead(conversationId: string, seq: number): number;
  /** 网页会话的标题；没有记过时为 undefined */
  title(conversationId: string): string | undefined;
  /** 记下网页会话的标题（已有的照样覆盖） */
  setTitle(conversationId: string, title: string): void;
  close(): void;
};

/**
 * 打开（不存在时新建）网页面板的状态库。目录须已存在。
 * 文件第一次建立时，用 initialReads() 给出的「会话 id → 序号」初始化已读位置：现有的会话以当时
 * 最后一条消息为已读，以前的历史不算未读；之后新建的会话没有已读位置，从头算。
 * 打不开、版本比程序新时抛错
 */
export async function openWebState(
  path: string,
  initialReads: () => Promise<Iterable<readonly [string, number]>>,
): Promise<WebState> {
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 5000');
    const version = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
    if (version > schemaVersion) {
      throw new Error(`网页状态库的版本比程序新（文件为 ${version}，程序支持 ${schemaVersion}）`);
    }
    if (version < schemaVersion) {
      const initial = version === 0 ? [...(await initialReads())] : [];
      const now = new Date().toISOString();
      transaction(db, () => {
        for (const migration of migrations.slice(version)) db.exec(migration);
        const insert = db.prepare(
          'INSERT INTO read_marks (conversation_id, seq, updated_at) VALUES (?, ?, ?)',
        );
        for (const [conversationId, seq] of initial) insert.run(conversationId, seq, now);
        db.exec(`PRAGMA user_version = ${schemaVersion}`);
      });
    }
  } catch (error) {
    db.close();
    throw error;
  }

  const readMark = db.prepare('SELECT seq FROM read_marks WHERE conversation_id = ?');
  // 只往前走：已有的位置不比新的小时不改
  const advance = db.prepare(
    `INSERT INTO read_marks (conversation_id, seq, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (conversation_id) DO UPDATE SET seq = excluded.seq, updated_at = excluded.updated_at
     WHERE excluded.seq > read_marks.seq`,
  );
  const readSeq = (conversationId: string) => Number(readMark.get(conversationId)?.seq ?? 0);
  const titleOf = db.prepare('SELECT title FROM titles WHERE conversation_id = ?');
  const writeTitle = db.prepare(
    `INSERT INTO titles (conversation_id, title, created_at) VALUES (?, ?, ?)
     ON CONFLICT (conversation_id) DO UPDATE SET title = excluded.title`,
  );

  return {
    readSeq,
    advanceRead(conversationId, seq) {
      advance.run(conversationId, seq, new Date().toISOString());
      return readSeq(conversationId);
    },
    title(conversationId) {
      const row = titleOf.get(conversationId);
      return row ? String(row.title) : undefined;
    },
    setTitle(conversationId, title) {
      writeTitle.run(conversationId, title, new Date().toISOString());
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
