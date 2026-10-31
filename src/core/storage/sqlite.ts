import { DatabaseSync } from 'node:sqlite';
import { generateId } from 'ai';
import { DuplicateMessageError } from './errors.js';
import type { Message } from '../message.js';
import type { ConversationInfo, ConversationStore, Segment, SeqRange, Storage } from './types.js';

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
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const listMessages = db.prepare(
    `SELECT seq, ui_message FROM messages
     WHERE conversation_id = ? AND seq >= ? AND seq < ? ORDER BY seq`,
  );
  const messageById = db.prepare(
    'SELECT ui_message FROM messages WHERE conversation_id = ? AND id = ?',
  );
  const messageByPlatformId = db.prepare(
    'SELECT ui_message FROM messages WHERE conversation_id = ? AND platform_message_id = ?',
  );
  const updateMessage = db.prepare(
    'UPDATE messages SET ui_message = ? WHERE conversation_id = ? AND id = ?',
  );
  const lastMessage = db.prepare(
    'SELECT seq, created_at FROM messages WHERE conversation_id = ? ORDER BY seq DESC LIMIT 1',
  );
  const currentSegment = db.prepare(
    `SELECT start_seq, start_reason, conversation_title, prior_summary FROM segments
     WHERE conversation_id = ? ORDER BY start_seq DESC LIMIT 1`,
  );
  const conversationTitle = db.prepare('SELECT title FROM conversations WHERE id = ?');
  // 标题取会话此刻的标题，与插入在同一条语句里。同一序号已有一段时什么也不做
  const insertSegment = db.prepare(
    `INSERT INTO segments
       (id, conversation_id, start_seq, start_reason, conversation_title, prior_summary, created_at)
     SELECT ?, id, ?, ?, title, ?, ? FROM conversations WHERE id = ?
     ON CONFLICT (conversation_id, start_seq) DO NOTHING`,
  );
  // 最后一条消息最新的会话；时间相同时按写入先后（rowid）
  const findConversation = db.prepare(
    `SELECT id, platform_conversation_id, title FROM conversations
     WHERE platform = ? AND platform_conversation_id = ?`,
  );
  const listConversations = db.prepare(
    `SELECT id, platform_conversation_id, title FROM conversations
     WHERE platform = ? ORDER BY created_at, rowid`,
  );
  const updateTitle = db.prepare('UPDATE conversations SET title = ? WHERE id = ?');
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

  const entries = (conversationId: string, { from, before }: SeqRange = {}) =>
    listMessages.all(conversationId, from ?? 0, before ?? Number.MAX_SAFE_INTEGER).map((row) => ({
      seq: Number(row.seq),
      message: JSON.parse(String(row.ui_message)) as Message,
    }));

  const addSegment = (
    conversationId: string,
    { startSeq, startReason, priorSummary }: Omit<Segment, 'conversationTitle'>,
  ): boolean => {
    const { changes } = insertSegment.run(
      generateId(),
      startSeq,
      startReason,
      priorSummary ?? null,
      new Date().toISOString(),
      conversationId,
    );
    return Number(changes) > 0;
  };

  const store = (conversationId: string): ConversationStore => ({
    async list(range) {
      return entries(conversationId, range).map((entry) => entry.message);
    },
    async entries(range) {
      return entries(conversationId, range);
    },
    async get(id) {
      const row = messageById.get(conversationId, id);
      return row && (JSON.parse(String(row.ui_message)) as Message);
    },
    async findByPlatformMessageId(platformMessageId) {
      const row = messageByPlatformId.get(conversationId, platformMessageId);
      return row && (JSON.parse(String(row.ui_message)) as Message);
    },
    async update(message) {
      const { changes } = updateMessage.run(JSON.stringify(message), conversationId, message.id);
      if (Number(changes) === 0) throw new Error(`消息 ${message.id} 不存在`);
    },
    async last() {
      const row = lastMessage.get(conversationId);
      return row && { seq: Number(row.seq), createdAt: String(row.created_at) };
    },
    async add(message, seq = reserve(conversationId)) {
      const platformMessageId = message.metadata?.platformMessageId;
      try {
        // 这几列是 ui_message 的副本，用于查询；读取以 ui_message 为准
        insertMessage.run(
          message.id,
          conversationId,
          seq,
          message.role,
          message.metadata?.author?.id ?? null,
          platformMessageId ?? null,
          message.metadata?.createdAt ?? new Date().toISOString(),
          JSON.stringify(message),
        );
      } catch (error) {
        // 撞上 messages_platform 唯一索引：这条平台消息已经写入过
        if (platformMessageId !== undefined && isPlatformMessageConflict(error)) {
          throw new DuplicateMessageError(platformMessageId);
        }
        throw error;
      }
    },
    async reserve() {
      return reserve(conversationId);
    },
    async currentSegment() {
      const row = currentSegment.get(conversationId);
      if (!row) {
        // 第 2 步建的会话没有段：整个会话算第一段
        const title = conversationTitle.get(conversationId)?.title;
        return { startSeq: 1, startReason: 'first', conversationTitle: optional(title) };
      }
      return {
        startSeq: Number(row.start_seq),
        startReason: String(row.start_reason) as Segment['startReason'],
        conversationTitle: optional(row.conversation_title),
        priorSummary: optional(row.prior_summary),
      };
    },
    async addSegment(segment) {
      return addSegment(conversationId, segment);
    },
  });

  return {
    async createConversation({ platform, platformConversationId, title }) {
      const id = generateId();
      transaction(db, () => {
        insertConversation.run(
          id,
          platform,
          platformConversationId ?? null,
          title ?? null,
          new Date().toISOString(),
        );
        addSegment(id, { startSeq: 1, startReason: 'first' });
      });
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
    async findConversation(platform, platformConversationId) {
      const row = findConversation.get(platform, platformConversationId);
      return row && conversationInfo(row);
    },
    async listConversations(platform) {
      return listConversations.all(platform).map(conversationInfo);
    },
    async updateTitle(id, title) {
      if (updateTitle.run(title ?? null, id).changes === 0) throw new Error(`会话 ${id} 不存在`);
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
  transaction(db, () => {
    db.exec(schema);
    db.exec(`PRAGMA user_version = ${schemaVersion}`);
  });
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

function conversationInfo(row: Record<string, unknown>): ConversationInfo {
  return {
    id: String(row.id),
    platformConversationId: optional(row.platform_conversation_id),
    title: optional(row.title),
  };
}

// SQLITE_CONSTRAINT_UNIQUE；同一错误码也用于序号冲突，再看是哪一列
function isPlatformMessageConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as { errcode?: number }).errcode === 2067 &&
    error.message.includes('platform_message_id')
  );
}

// NULL 列读成 undefined
function optional(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}
