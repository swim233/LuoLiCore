import { DatabaseSync } from 'node:sqlite';
import { generateId } from 'ai';
import type { Message } from '../message.js';
import type { ConversationStore, Storage } from './types.js';

const schemaVersion = 1;

// 表结构见 docs/adr/0005-sqlite-storage-in-core.md
const schema = `
CREATE TABLE conversations (
  id                       TEXT PRIMARY KEY,
  platform                 TEXT NOT NULL,
  platform_conversation_id TEXT,
  title                    TEXT,
  next_seq                 INTEGER NOT NULL DEFAULT 1,
  created_at               TEXT NOT NULL
);
CREATE UNIQUE INDEX conversations_platform
  ON conversations(platform, platform_conversation_id) WHERE platform_conversation_id IS NOT NULL;

CREATE TABLE messages (
  id                  TEXT PRIMARY KEY,
  conversation_id     TEXT NOT NULL REFERENCES conversations(id),
  seq                 INTEGER NOT NULL,
  role                TEXT NOT NULL,
  author_id           TEXT,
  platform_message_id TEXT,
  created_at          TEXT NOT NULL,
  ui_message          TEXT NOT NULL
);
CREATE UNIQUE INDEX messages_order    ON messages(conversation_id, seq);
CREATE UNIQUE INDEX messages_platform ON messages(conversation_id, platform_message_id)
  WHERE platform_message_id IS NOT NULL;

CREATE TABLE segments (
  id                 TEXT PRIMARY KEY,
  conversation_id    TEXT NOT NULL REFERENCES conversations(id),
  start_seq          INTEGER NOT NULL,
  start_reason       TEXT NOT NULL,
  conversation_title TEXT,
  prior_summary      TEXT,
  created_at         TEXT NOT NULL
);
CREATE UNIQUE INDEX segments_order ON segments(conversation_id, start_seq);
`;

/** 打开（不存在时新建）一个 SQLite 数据库文件作为存储。目录须已存在 */
export function openSqliteStorage(path: string): Storage {
  const db = new DatabaseSync(path);
  try {
    migrate(db);
  } catch (error) {
    db.close();
    throw error;
  }

  const insertConversation = db.prepare(
    `INSERT INTO conversations (id, platform, platform_conversation_id, title, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const conversationExists = db.prepare('SELECT 1 FROM conversations WHERE id = ?');
  // 单条 UPDATE … RETURNING：读出并加一在同一条语句里完成，多个连接（进程）同时取也不重号
  const reserveSeq = db.prepare(
    'UPDATE conversations SET next_seq = next_seq + 1 WHERE id = ? RETURNING next_seq - 1 AS seq',
  );
  const insertMessage = db.prepare(
    `INSERT INTO messages
       (id, conversation_id, seq, role, author_id, platform_message_id, created_at, ui_message)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
  );
  const listMessages = db.prepare(
    'SELECT ui_message FROM messages WHERE conversation_id = ? AND seq < ? ORDER BY seq',
  );
  // 最后一条消息最新的会话；时间相同时按写入先后（rowid）
  const latestConversation = db.prepare(
    `SELECT c.id FROM conversations c JOIN messages m ON m.conversation_id = c.id
     WHERE c.platform = ?
     GROUP BY c.id
     ORDER BY MAX(m.created_at) DESC, MAX(m.rowid) DESC
     LIMIT 1`,
  );

  const reserve = (conversationId: string): number => {
    const row = reserveSeq.get(conversationId);
    if (!row) throw new Error(`会话 ${conversationId} 不存在`);
    return Number(row.seq);
  };

  const store = (conversationId: string): ConversationStore => ({
    async list({ before } = {}) {
      return listMessages
        .all(conversationId, before ?? Number.MAX_SAFE_INTEGER)
        .map((row) => JSON.parse(String(row.ui_message)) as Message);
    },
    async add(message, seq = reserve(conversationId)) {
      // 这几列是 ui_message 的副本，用于查询；读取以 ui_message 为准
      insertMessage.run(
        message.id,
        conversationId,
        seq,
        message.role,
        message.metadata?.author?.id ?? null,
        message.metadata?.createdAt ?? new Date().toISOString(),
        JSON.stringify(message),
      );
    },
    async reserve() {
      return reserve(conversationId);
    },
  });

  return {
    async createConversation({ platform, platformConversationId, title }) {
      const id = generateId();
      insertConversation.run(
        id,
        platform,
        platformConversationId ?? null,
        title ?? null,
        new Date().toISOString(),
      );
      return id;
    },
    async openConversation(id) {
      if (!conversationExists.get(id)) throw new Error(`会话 ${id} 不存在`);
      return store(id);
    },
    async findLatestConversation(platform) {
      const row = latestConversation.get(platform);
      return row ? String(row.id) : undefined;
    },
    close() {
      if (db.isOpen) db.close();
    },
  };
}

function migrate(db: DatabaseSync): void {
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  // 另一个进程正在写时等它，而不是立即报 SQLITE_BUSY
  db.exec('PRAGMA busy_timeout = 5000');
  const version = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
  if (version > schemaVersion) {
    throw new Error(`数据库版本比程序新（文件为 ${version}，程序支持 ${schemaVersion}）`);
  }
  if (version === schemaVersion) return;
  db.exec('BEGIN');
  try {
    db.exec(schema);
    db.exec(`PRAGMA user_version = ${schemaVersion}`);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
