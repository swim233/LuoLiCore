import { DatabaseSync } from 'node:sqlite';
import { generateId } from 'ai';
import { DuplicateMessageError } from './errors.js';
import type { Author, Message } from '../message.js';
import type {
  ConversationInfo,
  ConversationOverview,
  ConversationStore,
  ModelCall,
  Segment,
  SeqRange,
  Storage,
  StoredConversation,
  StoredMessage,
  StoredSegment,
  ToolCall,
} from './types.js';

/** 概览里最后一条消息的文字默认取多少个字符 */
const defaultTextChars = 200;

// 会话的概览：最后一条消息按 messages_order 索引取序号最大的一条；条数、段数按各自的索引数。
// 最后一条消息只取要点：文字部分用 SQLite 的 JSON 函数取出来连起来，不把整条消息读回 JS
const overviewSelect = `
SELECT
  c.id, c.platform, c.platform_conversation_id, c.title, c.created_at,
  (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count,
  MAX(1, (SELECT COUNT(*) FROM segments s WHERE s.conversation_id = c.id)) AS segment_count,
  l.seq AS last_seq,
  l.created_at AS last_created_at,
  l.role AS last_role,
  json_extract(l.ui_message, '$.metadata.author') AS last_author,
  (SELECT substr(group_concat(json_extract(p.value, '$.text'), char(10)), 1, :chars)
     FROM json_each(l.ui_message, '$.parts') p
     WHERE json_extract(p.value, '$.type') = 'text') AS last_text,
  (SELECT COUNT(*) FROM json_each(l.ui_message, '$.parts') p
     WHERE json_extract(p.value, '$.type') = 'file') AS last_files
FROM conversations c
LEFT JOIN messages l ON l.conversation_id = c.id
  AND l.seq = (SELECT MAX(seq) FROM messages WHERE conversation_id = c.id)`;

// 表结构见 docs/adr/0005-sqlite-storage-in-core.md。第 i 项把版本 i 的库升到 i + 1：
// 新库（版本 0）依次执行全部，已有的库只执行比它新的部分
const migrations = [
  `
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
`,
  `
CREATE TABLE model_calls (
  id                INTEGER PRIMARY KEY,
  conversation_id   TEXT NOT NULL REFERENCES conversations(id),
  purpose           TEXT NOT NULL,
  summary_reason    TEXT,
  reply_id          TEXT,
  model             TEXT NOT NULL,
  started_at        TEXT NOT NULL,
  duration_ms       INTEGER NOT NULL,
  first_output_ms   INTEGER,
  attempts          INTEGER NOT NULL,
  outcome           TEXT NOT NULL,
  finish_reason     TEXT,
  input_tokens      INTEGER,
  cache_read_tokens INTEGER,
  output_tokens     INTEGER,
  reasoning_tokens  INTEGER,
  error             TEXT
);
CREATE INDEX model_calls_time         ON model_calls(started_at);
CREATE INDEX model_calls_conversation ON model_calls(conversation_id, started_at);
`,
  `
ALTER TABLE model_calls ADD COLUMN steps      INTEGER;
ALTER TABLE model_calls ADD COLUMN tool_calls INTEGER;

CREATE TABLE tool_calls (
  id              INTEGER PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  reply_id        TEXT NOT NULL,
  tool            TEXT NOT NULL,
  step            INTEGER NOT NULL,
  started_at      TEXT NOT NULL,
  duration_ms     INTEGER NOT NULL,
  outcome         TEXT NOT NULL,
  error           TEXT,
  output_chars    INTEGER
);
CREATE INDEX tool_calls_time ON tool_calls(started_at);
CREATE INDEX tool_calls_tool ON tool_calls(tool, started_at);
`,
];

const schemaVersion = migrations.length;

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

  const insertCall = db.prepare(
    `INSERT INTO model_calls
       (conversation_id, purpose, summary_reason, reply_id, model, started_at, duration_ms,
        first_output_ms, attempts, outcome, finish_reason, input_tokens, cache_read_tokens,
        output_tokens, reasoning_tokens, error, steps, tool_calls)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const listCalls = db.prepare('SELECT * FROM model_calls WHERE conversation_id = ? ORDER BY id');
  const insertToolCall = db.prepare(
    `INSERT INTO tool_calls
       (conversation_id, reply_id, tool, step, started_at, duration_ms, outcome, error,
        output_chars)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const listToolCalls = db.prepare(
    'SELECT * FROM tool_calls WHERE conversation_id = ? ORDER BY id',
  );

  // 读取：都走已有的索引（messages_order、segments_order、model_calls_time）
  const entryById = db.prepare(
    'SELECT seq, created_at, ui_message FROM messages WHERE conversation_id = ? AND id = ?',
  );
  const pageBefore = db.prepare(
    `SELECT seq, created_at, ui_message FROM messages
     WHERE conversation_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?`,
  );
  const countAfter = db.prepare(
    'SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND seq > ?',
  );
  const countAfterByRole = db.prepare(
    'SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND seq > ? AND role = ?',
  );
  const listSegments = db.prepare(
    `SELECT start_seq, start_reason, conversation_title, prior_summary, created_at FROM segments
     WHERE conversation_id = ? ORDER BY start_seq`,
  );
  const conversationRow = db.prepare('SELECT title, created_at FROM conversations WHERE id = ?');
  const allOverviews = db.prepare(`${overviewSelect} ORDER BY c.created_at, c.rowid`);
  const oneOverview = db.prepare(`${overviewSelect} WHERE c.id = :id`);
  const callTotals = db.prepare(
    `SELECT
       COALESCE(SUM(purpose = 'reply' AND outcome = 'completed'), 0) AS replies,
       COALESCE(SUM(purpose = 'reply' AND outcome = 'failed'), 0) AS failed_replies,
       COALESCE(SUM(input_tokens), 0) AS input_tokens,
       COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
       COALESCE(SUM(output_tokens), 0) AS output_tokens
     FROM model_calls WHERE started_at >= ?`,
  );
  const repliesByConversation = db.prepare(
    `SELECT m.conversation_id, c.title, COUNT(*) AS replies
     FROM model_calls m JOIN conversations c ON c.id = m.conversation_id
     WHERE m.started_at >= ? AND m.purpose = 'reply' AND m.outcome = 'completed'
     GROUP BY m.conversation_id
     ORDER BY replies DESC, c.created_at, c.rowid`,
  );

  // 按结束时间（开始加耗时，毫秒）取最晚的，同一时刻的取后写入的。结束时间没有索引，
  // 要看一遍完成的回复；只在启动时查一次
  const latestReply = db.prepare(
    `SELECT conversation_id, reply_id, started_at, duration_ms FROM model_calls
     WHERE purpose = 'reply' AND outcome = 'completed'
     ORDER BY unixepoch(started_at, 'subsec') * 1000 + duration_ms DESC, id DESC LIMIT 1`,
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

  const storedMessage = (row: Record<string, unknown>): StoredMessage => ({
    seq: Number(row.seq),
    createdAt: String(row.created_at),
    message: JSON.parse(String(row.ui_message)) as Message,
  });

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
    async entry(id) {
      const row = entryById.get(conversationId, id);
      return row && storedMessage(row);
    },
    async page({ before, limit }) {
      // 多取一条，看这批之前还有没有
      const rows = pageBefore.all(conversationId, before ?? Number.MAX_SAFE_INTEGER, limit + 1);
      return {
        entries: rows.slice(0, limit).reverse().map(storedMessage),
        hasMore: rows.length > limit,
      };
    },
    async count({ after = 0, role } = {}) {
      const row =
        role === undefined
          ? countAfter.get(conversationId, after)
          : countAfterByRole.get(conversationId, after, role);
      return Number(row?.n ?? 0);
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
    async segments() {
      const rows = listSegments.all(conversationId);
      if (rows.length === 0) {
        // 第 2 步建的会话没有段：整个会话算第一段，同 currentSegment
        const conversation = conversationRow.get(conversationId);
        return [
          {
            startSeq: 1,
            startReason: 'first',
            conversationTitle: optional(conversation?.title),
            createdAt: String(conversation?.created_at),
          },
        ];
      }
      return rows.map((row): StoredSegment => ({
        startSeq: Number(row.start_seq),
        startReason: String(row.start_reason) as Segment['startReason'],
        conversationTitle: optional(row.conversation_title),
        priorSummary: optional(row.prior_summary),
        createdAt: String(row.created_at),
      }));
    },
    async addSegment(segment) {
      return addSegment(conversationId, segment);
    },
    async recordCall(call) {
      insertCall.run(
        conversationId,
        call.purpose,
        call.summaryReason ?? null,
        call.replyId ?? null,
        call.model,
        call.startedAt,
        call.durationMs,
        call.firstOutputMs ?? null,
        call.attempts,
        call.outcome,
        call.finishReason ?? null,
        call.inputTokens ?? null,
        call.cacheReadTokens ?? null,
        call.outputTokens ?? null,
        call.reasoningTokens ?? null,
        call.error ?? null,
        call.steps ?? null,
        call.toolCalls ?? null,
      );
    },
    async calls() {
      return listCalls.all(conversationId).map(modelCall);
    },
    async recordToolCall(call) {
      insertToolCall.run(
        conversationId,
        call.replyId,
        call.tool,
        call.step,
        call.startedAt,
        call.durationMs,
        call.outcome,
        call.error ?? null,
        call.outputChars ?? null,
      );
    },
    async toolCalls() {
      return listToolCalls.all(conversationId).map(toolCall);
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
    async overviews({ textChars = defaultTextChars } = {}) {
      return allOverviews.all({ chars: textChars }).map(overview);
    },
    async overview(id, { textChars = defaultTextChars } = {}) {
      const row = oneOverview.get({ id, chars: textChars });
      return row && overview(row);
    },
    async callSummary(since) {
      const totals = callTotals.get(since) ?? {};
      return {
        replies: Number(totals.replies ?? 0),
        failedReplies: Number(totals.failed_replies ?? 0),
        inputTokens: Number(totals.input_tokens ?? 0),
        cacheReadTokens: Number(totals.cache_read_tokens ?? 0),
        outputTokens: Number(totals.output_tokens ?? 0),
        repliesByConversation: repliesByConversation.all(since).map((row) => ({
          conversationId: String(row.conversation_id),
          title: optional(row.title),
          replies: Number(row.replies),
        })),
      };
    },
    async lastReply() {
      const row = latestReply.get();
      if (!row) return undefined;
      return {
        conversationId: String(row.conversation_id),
        replyId: optional(row.reply_id),
        endedAt: endOf(String(row.started_at), Number(row.duration_ms)),
      };
    },
    close() {
      if (db.isOpen) db.close();
    },
  };
}

/**
 * 只读打开数据库，读出全部会话（按建立先后）后关闭。不迁移、不写（不设 WAL 等要写的 pragma）；
 * 文件不存在时报错，不创建。表结构版本与程序不一致时报错。供导出等不写库的工具使用，
 * bot 运行时也能读
 */
export function readConversations(path: string): StoredConversation[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    // 另一个进程正在写时等它，而不是立即报 SQLITE_BUSY
    db.exec('PRAGMA busy_timeout = 5000');
    const version = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
    if (version !== schemaVersion) {
      throw new Error(
        version > schemaVersion
          ? `数据库版本比程序新（文件为 ${version}，程序支持 ${schemaVersion}）`
          : `数据库版本比程序旧（文件为 ${version}，程序为 ${schemaVersion}），先用新版本启动一次 CLI 或 bot`,
      );
    }
    return db
      .prepare(
        `SELECT id, platform, platform_conversation_id, title FROM conversations
         ORDER BY created_at, rowid`,
      )
      .all()
      .map((row) => ({ ...conversationInfo(row), platform: String(row.platform) }));
  } finally {
    db.close();
  }
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
  // 一个事务里升到最新：中途出错时库保持原来的版本，已有数据不动
  transaction(db, () => {
    for (const migration of migrations.slice(version)) db.exec(migration);
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

function overview(row: Record<string, unknown>): ConversationOverview {
  return {
    ...conversationInfo(row),
    platform: String(row.platform),
    createdAt: String(row.created_at),
    messages: Number(row.message_count),
    segments: Number(row.segment_count),
    ...(row.last_seq === null || row.last_seq === undefined
      ? {}
      : {
          last: {
            seq: Number(row.last_seq),
            createdAt: String(row.last_created_at),
            role: String(row.last_role) as Message['role'],
            ...(row.last_author === null || row.last_author === undefined
              ? {}
              : { author: JSON.parse(String(row.last_author)) as Author }),
            text: optional(row.last_text) ?? '',
            files: Number(row.last_files ?? 0),
          },
        }),
  };
}

function modelCall(row: Record<string, unknown>): ModelCall {
  return {
    purpose: String(row.purpose) as ModelCall['purpose'],
    summaryReason: optional(row.summary_reason) as ModelCall['summaryReason'],
    replyId: optional(row.reply_id),
    model: String(row.model),
    startedAt: String(row.started_at),
    durationMs: Number(row.duration_ms),
    firstOutputMs: optionalNumber(row.first_output_ms),
    attempts: Number(row.attempts),
    outcome: String(row.outcome) as ModelCall['outcome'],
    finishReason: optional(row.finish_reason),
    inputTokens: optionalNumber(row.input_tokens),
    cacheReadTokens: optionalNumber(row.cache_read_tokens),
    outputTokens: optionalNumber(row.output_tokens),
    reasoningTokens: optionalNumber(row.reasoning_tokens),
    error: optional(row.error),
    steps: optionalNumber(row.steps),
    toolCalls: optionalNumber(row.tool_calls),
  };
}

function toolCall(row: Record<string, unknown>): ToolCall {
  return {
    replyId: String(row.reply_id),
    tool: String(row.tool),
    step: Number(row.step),
    startedAt: String(row.started_at),
    durationMs: Number(row.duration_ms),
    outcome: String(row.outcome) as ToolCall['outcome'],
    error: optional(row.error),
    outputChars: optionalNumber(row.output_chars),
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
/** 开始时间（ISO）加上耗时（毫秒） */
function endOf(startedAt: string, durationMs: number): string {
  return new Date(Date.parse(startedAt) + durationMs).toISOString();
}

function optional(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

function optionalNumber(value: unknown): number | undefined {
  return value === null || value === undefined ? undefined : Number(value);
}
