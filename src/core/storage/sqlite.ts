import { DatabaseSync } from 'node:sqlite';
import { generateId } from 'ai';
import { DuplicateMessageError } from './errors.js';
import { isoTime, normalizeChanges, normalizeSchedule, taskSource } from './tasks.js';
import type { Author, Message } from '../message.js';
import type {
  ConversationInfo,
  ConversationOverview,
  ConversationStore,
  MessageGlance,
  ModelCall,
  NewSegment,
  SegmentReason,
  SeqRange,
  Storage,
  StoredConversation,
  StoredMessage,
  StoredSegment,
  Task,
  TaskChanges,
  TaskSchedule,
  TaskStatus,
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
  json_extract(l.ui_message, '$.metadata.event.type') AS last_event,
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
  `
ALTER TABLE tool_calls ADD COLUMN tool_call_id TEXT;
`,
  `
CREATE TABLE tasks (
  id                         INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id            TEXT NOT NULL REFERENCES conversations(id),
  action                     TEXT NOT NULL,
  schedule                   TEXT NOT NULL,
  source_author_id           TEXT,
  source_author_name         TEXT NOT NULL,
  source_message_id          TEXT NOT NULL,
  source_platform_message_id TEXT,
  status                     TEXT NOT NULL,
  next_due_at                TEXT,
  last_due_at                TEXT,
  due_count                  INTEGER NOT NULL DEFAULT 0,
  created_at                 TEXT NOT NULL,
  ended_at                   TEXT
);
CREATE INDEX tasks_due          ON tasks(status, next_due_at);
CREATE INDEX tasks_conversation ON tasks(conversation_id, status);
`,
  `
ALTER TABLE segments ADD COLUMN started_by    TEXT;
ALTER TABLE segments ADD COLUMN started_by_id TEXT;
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
  const segmentColumns =
    'start_seq, start_reason, conversation_title, prior_summary, started_by, started_by_id, created_at';
  const currentSegment = db.prepare(
    `SELECT ${segmentColumns} FROM segments
     WHERE conversation_id = ? ORDER BY start_seq DESC LIMIT 1`,
  );
  // 标题取会话此刻的标题，与插入在同一条语句里。同一序号已有一段时什么也不做
  const insertSegment = db.prepare(
    `INSERT INTO segments
       (id, conversation_id, start_seq, start_reason, conversation_title, prior_summary,
        started_by, started_by_id, created_at)
     SELECT ?, id, ?, ?, title, ?, ?, ?, ? FROM conversations WHERE id = ?
     ON CONFLICT (conversation_id, start_seq) DO NOTHING`,
  );
  // 把还没有消息的当前段改成清空的段。条件与改写在同一条语句里，是一次原子的写入：
  // 这一段还是当前段（startSeq 最大），而且序号不小于它的消息一条都没有
  const clearSegment = db.prepare(
    `UPDATE segments
     SET start_reason = 'clear', prior_summary = NULL, started_by = :name, started_by_id = :authorId,
         created_at = :at,
         conversation_title = (SELECT title FROM conversations WHERE id = :conversation)
     WHERE conversation_id = :conversation AND start_seq = :start
       AND start_seq = (SELECT MAX(start_seq) FROM segments WHERE conversation_id = :conversation)
       AND NOT EXISTS
         (SELECT 1 FROM messages WHERE conversation_id = :conversation AND seq >= :start)`,
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
        output_chars, tool_call_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
  // 条件为 NULL 的一项不筛；不数事件时看 ui_message 里的 metadata.event（事件不另存一列）。
  // 走 messages_order：会话加序号的范围
  const countAfter = db.prepare(
    `SELECT COUNT(*) AS n FROM messages
     WHERE conversation_id = :conversation AND seq > :after
       AND (:role IS NULL OR role = :role)
       AND (:events = 1 OR json_extract(ui_message, '$.metadata.event') IS NULL)`,
  );
  const listSegments = db.prepare(
    `SELECT ${segmentColumns} FROM segments WHERE conversation_id = ? ORDER BY start_seq`,
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

  // 任务：要到点的、最近的到点走 tasks_due，按会话列出走 tasks_conversation
  const insertTask = db.prepare(
    `INSERT INTO tasks
       (conversation_id, action, schedule, source_author_id, source_author_name,
        source_message_id, source_platform_message_id, status, next_due_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
     RETURNING *`,
  );
  const taskById = db.prepare('SELECT * FROM tasks WHERE id = ?');
  // 条件为 NULL 的一项不筛；已结束的（不是进行中的）只要结束时间不早于 since 的。
  // 按会话列出另用一条：写成 (:conversation IS NULL OR …) 时 SQLite 用不上 tasks_conversation
  const taskFilter = `(:status IS NULL OR status = :status)
       AND (:since IS NULL OR status = 'active' OR ended_at >= :since)`;
  const listTasks = db.prepare(`SELECT * FROM tasks WHERE ${taskFilter} ORDER BY id`);
  const listConversationTasks = db.prepare(
    `SELECT * FROM tasks WHERE conversation_id = :conversation AND ${taskFilter} ORDER BY id`,
  );
  const dueTasks = db.prepare(
    `SELECT * FROM tasks WHERE status = 'active' AND next_due_at <= ? ORDER BY next_due_at, id`,
  );
  const nextDueAt = db.prepare("SELECT MIN(next_due_at) AS at FROM tasks WHERE status = 'active'");

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
    segment: NewSegment | { startSeq: 1; startReason: 'first' },
  ): boolean => {
    const startedBy = 'startedBy' in segment ? segment.startedBy : undefined;
    const { changes } = insertSegment.run(
      generateId(),
      segment.startSeq,
      segment.startReason,
      'priorSummary' in segment ? segment.priorSummary : null,
      startedBy?.name ?? null,
      startedBy?.id ?? null,
      new Date().toISOString(),
      conversationId,
    );
    return Number(changes) > 0;
  };

  /** 第 2 步建的会话没有段时，视为一段：从 1 开始、标题取会话标题、时间取会话的建立时间 */
  const implicitFirstSegment = (conversationId: string): StoredSegment => {
    const conversation = conversationRow.get(conversationId);
    return {
      startSeq: 1,
      startReason: 'first',
      conversationTitle: optional(conversation?.title),
      createdAt: String(conversation?.created_at),
    };
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
    async count({ after = 0, role, excludeEvents = false } = {}) {
      const row = countAfter.get({
        conversation: conversationId,
        after,
        role: role ?? null,
        events: excludeEvents ? 0 : 1,
      });
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
      // 第 2 步建的会话没有段：整个会话算第一段
      return row ? storedSegment(row) : implicitFirstSegment(conversationId);
    },
    async segments() {
      const rows = listSegments.all(conversationId);
      // 第 2 步建的会话没有段：整个会话算第一段，同 currentSegment
      if (rows.length === 0) return [implicitFirstSegment(conversationId)];
      return rows.map(storedSegment);
    },
    async addSegment(segment) {
      return addSegment(conversationId, segment);
    },
    async clearSegment({ startSeq, startedBy }) {
      const { changes } = clearSegment.run({
        conversation: conversationId,
        start: startSeq,
        name: startedBy.name,
        authorId: startedBy.id ?? null,
        at: new Date().toISOString(),
      });
      return Number(changes) > 0;
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
        call.toolCallId ?? null,
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
    async createTask({ conversationId, action, schedule, source, nextDueAt, createdAt }) {
      // 外键也会拦，这里先查，报错与内存存储一致
      if (!conversationExists.get(conversationId)) throw new Error(`会话 ${conversationId} 不存在`);
      const row = insertTask.get(
        conversationId,
        action,
        JSON.stringify(normalizeSchedule(schedule)),
        source.author.id ?? null,
        source.author.name,
        source.messageId,
        source.platformMessageId ?? null,
        nextDueAt === undefined ? null : isoTime(nextDueAt),
        isoTime(createdAt ?? new Date().toISOString()),
      );
      return task(row!);
    },
    async getTask(id) {
      const row = taskById.get(id);
      return row && task(row);
    },
    async listTasks({ conversationId, status, endedSince } = {}) {
      const filter = {
        status: status ?? null,
        since: endedSince === undefined ? null : isoTime(endedSince),
      };
      const rows =
        conversationId === undefined
          ? listTasks.all(filter)
          : listConversationTasks.all({ ...filter, conversation: conversationId });
      return rows.map(task);
    },
    async updateTask(id, changes) {
      // 先换好写法：时间不合法时抛错，任务不变。只改给出的项（null 也是给出，清掉这一列）
      const normalized = normalizeChanges(changes);
      const given = (Object.keys(taskColumns) as Array<keyof TaskChanges>).filter(
        (key) => normalized[key] !== undefined,
      );
      const row =
        given.length === 0
          ? taskById.get(id)
          : db
              .prepare(
                `UPDATE tasks SET ${given.map((key) => `${taskColumns[key]} = ?`).join(', ')}
                 WHERE id = ? RETURNING *`,
              )
              .get(...given.map((key) => normalized[key] ?? null), id);
      if (!row) throw new Error(`任务 ${id} 不存在`);
      return task(row);
    },
    async dueTasks(at) {
      return dueTasks.all(isoTime(at)).map(task);
    },
    async nextDueAt() {
      return optional(nextDueAt.get()?.at);
    },
    close() {
      if (db.isOpen) db.close();
    },
  };
}

/**
 * 只读打开数据库，读出全部会话（按建立先后）后关闭。不迁移、不写（不设 WAL 等要写的 pragma）；
 * 文件不存在时报错，不创建。表结构版本与程序不一致时报错。供导出等不写库的工具使用，
 * 洛璃服务运行时也能读
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
          : `数据库版本比程序旧（文件为 ${version}，程序为 ${schemaVersion}），先启动一次洛璃服务`,
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

/** segments 的一行；started_by 为 NULL 时（以前的行、其他原因的段）没有执行人 */
function storedSegment(row: Record<string, unknown>): StoredSegment {
  const priorSummary = optional(row.prior_summary);
  const name = optional(row.started_by);
  const authorId = optional(row.started_by_id);
  return {
    startSeq: Number(row.start_seq),
    startReason: String(row.start_reason) as SegmentReason,
    conversationTitle: optional(row.conversation_title),
    ...(priorSummary === undefined ? {} : { priorSummary }),
    ...(name === undefined
      ? {}
      : { startedBy: authorId === undefined ? { name } : { id: authorId, name } }),
    createdAt: String(row.created_at),
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
            ...(row.last_event === null || row.last_event === undefined
              ? {}
              : { event: String(row.last_event) as NonNullable<MessageGlance['event']> }),
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

/** 修改任务时能改的几项与对应的列 */
const taskColumns = {
  status: 'status',
  nextDueAt: 'next_due_at',
  lastDueAt: 'last_due_at',
  dueCount: 'due_count',
  endedAt: 'ended_at',
} as const satisfies Record<keyof TaskChanges, string>;

/** tasks 的一行；为 NULL 的项不写（与内存存储的形状一致） */
function task(row: Record<string, unknown>): Task {
  const nextDueAt = optional(row.next_due_at);
  const lastDueAt = optional(row.last_due_at);
  const endedAt = optional(row.ended_at);
  return {
    id: Number(row.id),
    conversationId: String(row.conversation_id),
    action: String(row.action),
    schedule: JSON.parse(String(row.schedule)) as TaskSchedule,
    source: taskSource({
      author: { id: optional(row.source_author_id), name: String(row.source_author_name) },
      messageId: String(row.source_message_id),
      platformMessageId: optional(row.source_platform_message_id),
    }),
    status: String(row.status) as TaskStatus,
    ...(nextDueAt === undefined ? {} : { nextDueAt }),
    ...(lastDueAt === undefined ? {} : { lastDueAt }),
    dueCount: Number(row.due_count),
    createdAt: String(row.created_at),
    ...(endedAt === undefined ? {} : { endedAt }),
  };
}

function toolCall(row: Record<string, unknown>): ToolCall {
  return {
    replyId: String(row.reply_id),
    toolCallId: optional(row.tool_call_id),
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
