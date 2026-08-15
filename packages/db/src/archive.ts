import type { Sqlite } from './database.js';

function redactArchivePayload(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(/\bsk-[A-Za-z0-9_-]{16,}\b|Bearer\s+\S+|\b\d{8,10}:[A-Za-z0-9_-]{35}\b/gi, '«redacted»');
  if (Array.isArray(value)) return value.map(redactArchivePayload);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, /api[_-]?key|secret|token|password|credential/i.test(key) ? '«redacted»' : redactArchivePayload(nested)]));
  return value;
}
export interface ArchivedMessage {
  id: number;
  chatId: string;
  messageThreadId: number | null;
  tgMessageId: number;
  direction: 'in' | 'out';
  fromKind: 'user' | 'bot' | 'system';
  fromUserId: string | null;
  fromName: string | null;
  fromUsername: string | null;
  kind: string;
  text: string | null;
  tgDate: number;
  triggered: number;
  triggerReason: string | null;
  mediaParts?: unknown[];
}

export interface AppendMessageInput extends Omit<ArchivedMessage, 'id' | 'triggered' | 'triggerReason'> {
  tgUpdateId?: number | null;
  raw: unknown;
  triggered?: boolean;
  triggerReason?: string | null;
  turnId?: string | null;
  revision?: number;
  mediaGroupId?: string | null;
  replyToTgMessageId?: number | null;
}

/**
 * FTS5 的 MATCH 串是一门查询语言：`|` `"` `*` `:` `-` `^` `(` `)` 和 AND/OR/NOT/NEAR 都是语法。
 * 查询词来自模型和 WebUI 使用者，原样塞进去 —— 模型写一句 `名字|我是|叫|谁` 就把整次工具调用
 * 打成 `fts5: syntax error near "|"`，它只能瞎改参数重试。这里先切成词，再决定怎么查：
 * - 有 ≥3 字的词：逐个加引号 OR 起来走 FTS（trigram 匹配不了更短的词），bm25 负责排序；
 * - 一个都没有（中文两字词几乎全在这一档）：退回 LIKE，且用最长的那个词而不是原串 ——
 *   原串里还带着 `|`，`LIKE '%名字|我是%'` 永远匹配不到任何东西。
 * 多词之间取 OR 而不是 FTS 默认的隐式 AND：这个工具的调用方是模型，它写多个词就是在列同义词。
 */
export function archiveQuery(raw: string): { fts: string } | { like: string } {
  const tokens = [...new Set(raw.split(/[^\p{L}\p{N}_]+/u).filter(Boolean))];
  const matchable = tokens.filter((token) => [...token].length >= 3);
  if (matchable.length) return { fts: matchable.map((token) => `"${token.replaceAll('"', '""')}"`).join(' OR ') };
  const longest = [...tokens].sort((left, right) => [...right].length - [...left].length)[0];
  return { like: `%${longest ?? raw}%` };
}

const MESSAGE_COLUMNS = `m.id,m.chat_id AS chatId,m.message_thread_id AS messageThreadId,m.tg_message_id AS tgMessageId,m.direction,
  m.from_kind AS fromKind,m.from_user_id AS fromUserId,m.from_name AS fromName,m.from_username AS fromUsername,m.kind,m.text,m.tg_date AS tgDate,
  m.triggered,m.trigger_reason AS triggerReason`;
const messageQuery = (prefix = '') => prefix ? MESSAGE_COLUMNS : MESSAGE_COLUMNS.replaceAll('m.', '');
const withMedia = (row: ArchivedMessage | null): ArchivedMessage | null => {
  if (!row) return null;
  const parts = (row as ArchivedMessage & { mediaPartsJson?: string | null }).mediaPartsJson;
  if (parts) row.mediaParts = JSON.parse(parts) as unknown[];
  delete (row as ArchivedMessage & { mediaPartsJson?: string }).mediaPartsJson;
  return row;
};
export class ArchiveRepository {
  constructor(private readonly db: Sqlite) {}

  scope(chatId: string, threadId: number | null = null): ScopedArchiveRepository {
    return new ScopedArchiveRepository(this.db, chatId, threadId);
  }

  adminSearchAll(query: string, limit = 50): ArchivedMessage[] {
    const parsed = archiveQuery(query);
    const rows = 'like' in parsed
      ? this.db.prepare(`SELECT ${messageQuery()},media_parts_json AS mediaPartsJson FROM messages WHERE deleted_at IS NULL AND text LIKE ? ORDER BY tg_date DESC LIMIT ?`).all(parsed.like, limit) as ArchivedMessage[]
      : this.db.prepare(`SELECT ${messageQuery('m')},m.media_parts_json AS mediaPartsJson FROM messages_fts f JOIN messages m ON m.id=f.rowid WHERE messages_fts MATCH ? AND m.deleted_at IS NULL ORDER BY bm25(messages_fts),m.tg_date DESC LIMIT ?`).all(parsed.fts, limit) as ArchivedMessage[];
    return rows.map((row) => withMedia(row)!);
  }
}

export class ScopedArchiveRepository {
  constructor(private readonly db: Sqlite, readonly chatId: string, readonly threadId: number | null) {}

  append(input: AppendMessageInput): ArchivedMessage {
    const info = this.db.prepare(`INSERT OR IGNORE INTO messages(chat_id,message_thread_id,tg_message_id,tg_update_id,direction,from_kind,
      from_user_id,from_name,from_username,reply_to_tg_message_id,media_group_id,kind,text,raw_json,media_parts_json,tg_date,received_at,
      triggered,trigger_reason,turn_id,revision) VALUES (@chatId,@messageThreadId,@tgMessageId,@tgUpdateId,@direction,@fromKind,
      @fromUserId,@fromName,@fromUsername,@replyToTgMessageId,@mediaGroupId,@kind,@text,@rawJson,@mediaPartsJson,@tgDate,@receivedAt,
      @triggered,@triggerReason,@turnId,@revision)`).run({ ...input, tgUpdateId: input.tgUpdateId ?? null,
        replyToTgMessageId: input.replyToTgMessageId ?? null, mediaGroupId: input.mediaGroupId ?? null,
        rawJson: JSON.stringify(redactArchivePayload(input.raw)), mediaPartsJson: input.mediaParts ? JSON.stringify(input.mediaParts) : null, receivedAt: Date.now(), triggered: input.triggered ? 1 : 0,
        triggerReason: input.triggerReason ?? null, turnId: input.turnId ?? null, revision: input.revision ?? 0 });
    if (info.changes) return this.byId(Number(info.lastInsertRowid))!;
    return withMedia(this.db.prepare(`SELECT ${messageQuery()},media_parts_json AS mediaPartsJson FROM messages WHERE chat_id=? AND tg_message_id=? AND revision=?`).get(this.chatId, input.tgMessageId, input.revision ?? 0) as ArchivedMessage) !;
  }

  byId(id: number): ArchivedMessage | null {
    return withMedia(this.db.prepare(`SELECT ${messageQuery()},media_parts_json AS mediaPartsJson FROM messages WHERE chat_id = ? AND id = ?`).get(this.chatId, id) as ArchivedMessage | undefined ?? null);
  }

  search(query: string, limit = 20): ArchivedMessage[] {
    const thread = this.threadId === null ? '' : ' AND message_thread_id = @threadId';
    const columns = `id,chat_id AS chatId,message_thread_id AS messageThreadId,tg_message_id AS tgMessageId,direction,
      from_kind AS fromKind,from_user_id AS fromUserId,from_name AS fromName,from_username AS fromUsername,kind,text,tg_date AS tgDate,triggered,trigger_reason AS triggerReason`;
    const parsed = archiveQuery(query);
    const rows = 'like' in parsed ? this.db.prepare(`SELECT ${columns},media_parts_json AS mediaPartsJson FROM messages WHERE chat_id = @chatId${thread} AND deleted_at IS NULL AND text LIKE @query ORDER BY tg_date DESC LIMIT @limit`).all({ chatId: this.chatId, threadId: this.threadId, query: parsed.like, limit }) as ArchivedMessage[]
      : this.db.prepare(`SELECT ${messageQuery('m')},m.media_parts_json AS mediaPartsJson FROM messages_fts f JOIN messages m ON m.id=f.rowid WHERE m.chat_id = @chatId${thread ? ' AND m.message_thread_id = @threadId' : ''} AND messages_fts MATCH @query AND m.deleted_at IS NULL ORDER BY bm25(messages_fts),m.tg_date DESC LIMIT @limit`).all({ chatId: this.chatId, threadId: this.threadId, query: parsed.fts, limit }) as ArchivedMessage[];
    return rows.map((row) => withMedia(row)!);
  }

  recent(limit = 50): ArchivedMessage[] {
    const rows = this.db.prepare(`SELECT ${messageQuery()},media_parts_json AS mediaPartsJson FROM messages WHERE chat_id = ?
      AND (? IS NULL OR message_thread_id = ?) AND deleted_at IS NULL ORDER BY id DESC LIMIT ?`).all(this.chatId, this.threadId, this.threadId, limit) as ArchivedMessage[];
    return rows.map((row) => withMedia(row)!);
  }

  claimBackground(afterId: number, throughId: number, max: number, turnId: string): { rows: ArchivedMessage[]; omitted: number } {
    return this.db.transaction(() => {
      const all = this.db.prepare(`SELECT ${messageQuery()},media_parts_json AS mediaPartsJson FROM messages WHERE chat_id = ?
        AND (? IS NULL OR message_thread_id = ?) AND id > ? AND id <= ? AND claimed_at IS NULL
        AND direction='in' AND from_kind='user' AND triggered=0 AND deleted_at IS NULL AND NOT EXISTS (
          SELECT 1 FROM principals p WHERE p.kind='user' AND p.tg_id=messages.from_user_id AND p.role='blocked'
        ) ORDER BY id`).all(this.chatId, this.threadId, this.threadId, afterId, throughId) as ArchivedMessage[];
      for (const row of all) withMedia(row);
      const rows = max === 0 ? [] : all.slice(-max);
      if (rows.length) {
        const placeholders = rows.map(() => '?').join(',');
        this.db.prepare(`UPDATE messages SET claimed_at=?,claimed_by_turn=? WHERE chat_id=? AND claimed_at IS NULL AND id IN (${placeholders})`).run(Date.now(), turnId, this.chatId, ...rows.map((row) => row.id));
      }
      return { rows, omitted: all.length - rows.length };
    })();
  }

  releaseClaims(turnId: string): number {
    return this.db.prepare('UPDATE messages SET claimed_at=NULL,claimed_by_turn=NULL WHERE claimed_by_turn=?').run(turnId).changes;
  }
}
