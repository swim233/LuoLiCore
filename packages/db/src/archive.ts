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
  turnId?: string | null;
  replyToTgMessageId?: number | null;
  mediaParts?: unknown[];
  /** 被回复者的显示名。只在适配层现场构造的消息上出现（Telegram update 里带着），不落库。 */
  replyToName?: string;
}

export interface AppendMessageInput extends Omit<ArchivedMessage, 'id' | 'triggered' | 'triggerReason'> {
  tgUpdateId?: number | null;
  raw: unknown;
  triggered?: boolean;
  triggerReason?: string | null;
  revision?: number;
  mediaGroupId?: string | null;
  /** 立刻标成「已消费」。用于引用注入：那条消息本轮就已经进上下文了，不能下一轮再被当背景认领一次。 */
  claimed?: boolean;
}

/**
 * FTS5 的 MATCH 串是一门查询语言：`|` `"` `*` `:` `-` `^` `(` `)` 和 AND/OR/NOT/NEAR 都是语法。
 * 查询词来自模型和 WebUI 使用者，原样塞进去 —— 模型写一句 `名字|我是|叫|谁` 就把整次工具调用
 * 打成 `fts5: syntax error near "|"`，它只能瞎改参数重试。这里先切成词，再决定怎么查：
 * - 有 ≥3 字的词：逐个加引号 OR 起来走 FTS（trigram 匹配不了更短的词），bm25 负责排序；
 * - 一个都没有（中文两字词几乎全在这一档）：退回 LIKE，且用最长的那个词而不是原串 ——
 *   原串里还带着 `|`，`LIKE '%名字|我是%'` 永远匹配不到任何东西。
 * 多词之间取 OR 而不是 FTS 默认的隐式 AND：这个工具的调用方是模型，它写多个词就是在列同义词。
 *
 * **丢弃是对的，沉默不对。** 短词进不了 trigram 索引（`MATCH` 恒 0 命中），所以走 FTS 时把它们
 * 剔掉是正确降级；但混合查询（`search_messages("名字 李小明")`）里模型无从知道自己只查了
 * `李小明` —— 于是 `dropped` 把没参与的词交回给调用方，由它告诉模型「这几个词要单独查一次」
 * （单独查时它们就是全场最长的词，会走下面那条 LIKE 兜底）。docs/28 · L-DB-01。
 */
/**
 * LIKE 里 `_` 是「任意一个字符」、`%` 是「任意串」，而上面那个分词正则刻意把 `_` 当词内字符
 * 保留 —— 于是 `a_b` 变成 `LIKE '%a_b%'`，`axb` 也会命中（docs/27 · C-06）。不是注入（值是绑定
 * 参数），只影响检索精度。**转义了就必须配 `ESCAPE '\'`**，三条 LIKE 语句都带着它。
 */
const escapeLike = (value: string): string => value.replace(/[\\%_]/g, '\\$&');
/** 上面那句转义的另一半。加新的 LIKE 查询时跟着带上，否则 `\` 会被当成普通字符。 */
export const LIKE_ESCAPE = " ESCAPE '\\'";
/**
 * `dropped` 挂在交集上而不是单独一个返回值：`'like' in parsed` 是三个调用点共用的判别式，
 * 加一个平级字段会把那个判别弄坏。
 */
export type ArchiveQuery = ({ fts: string } | { like: string }) & {
  /** 切出来了但**没参与这次检索**的词（都短于 3 码点）。调用方有责任把它交回给使用者。 */
  dropped: string[];
};
export function archiveQuery(raw: string): ArchiveQuery {
  const tokens = [...new Set(raw.split(/[^\p{L}\p{N}_]+/u).filter(Boolean))];
  const matchable = tokens.filter((token) => [...token].length >= 3);
  if (matchable.length) return { fts: matchable.map((token) => `"${token.replaceAll('"', '""')}"`).join(' OR '), dropped: tokens.filter((token) => [...token].length < 3) };
  const longest = [...tokens].sort((left, right) => [...right].length - [...left].length)[0];
  // LIKE 那条路只用最长的一个词，其余同样没参与 —— 一并报出去。此时全部词都短于 3 码点，
  // 所以调用方那句「短于 3 个字」的措辞在两条路上都成立。
  return { like: `%${escapeLike(longest ?? raw)}%`, dropped: tokens.filter((token) => token !== longest) };
}

/** `search_messages` 的过滤参数（docs/05 §3.2）。`from` 同时认 tg 用户 id 与 `@username`。 */
export interface SearchFilters { from?: string | null; after?: number | null; before?: number | null; kind?: string | null }
/**
 * 过滤条件一律写成 `@x IS NULL OR …` 的常量 SQL，而不是按传了哪几个参数拼串：语句文本固定
 * 才能吃到 better-sqlite3 的预编译缓存，而「没传的参数不出现在 SQL 里」还得在绑定侧同步剔掉
 * ——漏一处就是一个运行时的 `missing named parameter`。这也是本文件 `recent()` 已有的写法。
 */
function filterClause(prefix: string): string {
  return ` AND (@from IS NULL OR ${prefix}from_user_id = @from OR ${prefix}from_username = @from)
    AND (@after IS NULL OR ${prefix}tg_date >= @after) AND (@before IS NULL OR ${prefix}tg_date <= @before)
    AND (@kind IS NULL OR ${prefix}kind = @kind)`;
}
function filterParameters(filters: SearchFilters): Required<SearchFilters> {
  return { from: filters.from?.replace(/^@/, '') ?? null, after: filters.after ?? null, before: filters.before ?? null, kind: filters.kind ?? null };
}

const MESSAGE_COLUMNS = `m.id,m.chat_id AS chatId,m.message_thread_id AS messageThreadId,m.tg_message_id AS tgMessageId,m.direction,
  m.from_kind AS fromKind,m.from_user_id AS fromUserId,m.from_name AS fromName,m.from_username AS fromUsername,m.kind,m.text,m.tg_date AS tgDate,
  m.triggered,m.trigger_reason AS triggerReason,m.turn_id AS turnId,m.reply_to_tg_message_id AS replyToTgMessageId`;
const messageQuery = (prefix = '') => prefix ? MESSAGE_COLUMNS : MESSAGE_COLUMNS.replaceAll('m.', '');
const withMedia = (row: ArchivedMessage | null): ArchivedMessage | null => {
  if (!row) return null;
  const parts = (row as ArchivedMessage & { mediaPartsJson?: string | null }).mediaPartsJson;
  // 坏 JSON 当「这条消息没有媒体」：这个函数在每一条消息的读出路径上，抛出去会让整次检索、
  // 整次归档读取失败，而丢一条附件只是那条消息少了张图（docs/27 · T-06）。
  if (parts) { try { row.mediaParts = JSON.parse(parts) as unknown[]; } catch { /* 手工改库或历史坏行 */ } }
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
      ? this.db.prepare(`SELECT ${messageQuery()},media_parts_json AS mediaPartsJson FROM messages WHERE deleted_at IS NULL AND text LIKE ?${LIKE_ESCAPE} ORDER BY tg_date DESC LIMIT ?`).all(parsed.like, limit) as ArchivedMessage[]
      : this.db.prepare(`SELECT ${messageQuery('m')},m.media_parts_json AS mediaPartsJson FROM messages_fts f JOIN messages m ON m.id=f.rowid WHERE messages_fts MATCH ? AND m.deleted_at IS NULL ORDER BY bm25(messages_fts),m.tg_date DESC LIMIT ?`).all(parsed.fts, limit) as ArchivedMessage[];
    return rows.map((row) => withMedia(row)!);
  }

  /** 命中总数。分页页码依赖它：拿「已取回条数」当 total 的话，翻到后面页数会漂（docs/20 · W-API-03）。 */
  adminSearchCount(query: string): number {
    const parsed = archiveQuery(query);
    return 'like' in parsed
      ? this.db.prepare(`SELECT COUNT(*) FROM messages WHERE deleted_at IS NULL AND text LIKE ?${LIKE_ESCAPE}`).pluck().get(parsed.like) as number
      : this.db.prepare('SELECT COUNT(*) FROM messages_fts f JOIN messages m ON m.id=f.rowid WHERE messages_fts MATCH ? AND m.deleted_at IS NULL').pluck().get(parsed.fts) as number;
  }
}

export class ScopedArchiveRepository {
  constructor(private readonly db: Sqlite, readonly chatId: string, readonly threadId: number | null) {}

  append(input: AppendMessageInput): ArchivedMessage {
    const info = this.db.prepare(`INSERT OR IGNORE INTO messages(chat_id,message_thread_id,tg_message_id,tg_update_id,direction,from_kind,
      from_user_id,from_name,from_username,reply_to_tg_message_id,media_group_id,kind,text,raw_json,media_parts_json,tg_date,received_at,
      triggered,trigger_reason,turn_id,revision,claimed_at) VALUES (@chatId,@messageThreadId,@tgMessageId,@tgUpdateId,@direction,@fromKind,
      @fromUserId,@fromName,@fromUsername,@replyToTgMessageId,@mediaGroupId,@kind,@text,@rawJson,@mediaPartsJson,@tgDate,@receivedAt,
      @triggered,@triggerReason,@turnId,@revision,@claimedAt)`).run({ ...input, tgUpdateId: input.tgUpdateId ?? null,
        replyToTgMessageId: input.replyToTgMessageId ?? null, mediaGroupId: input.mediaGroupId ?? null,
        rawJson: JSON.stringify(redactArchivePayload(input.raw)), mediaPartsJson: input.mediaParts ? JSON.stringify(input.mediaParts) : null, receivedAt: Date.now(), triggered: input.triggered ? 1 : 0,
        triggerReason: input.triggerReason ?? null, turnId: input.turnId ?? null, revision: input.revision ?? 0,
        // claimed_by_turn 留空：这条消息已经被消费掉了，但不属于任何在途轮次，abortTurn 的 releaseClaims 不该把它放回去。
        claimedAt: input.claimed ? Date.now() : null });
    if (info.changes) return this.byId(Number(info.lastInsertRowid))!;
    return withMedia(this.db.prepare(`SELECT ${messageQuery()},media_parts_json AS mediaPartsJson FROM messages WHERE chat_id=? AND tg_message_id=? AND revision=?`).get(this.chatId, input.tgMessageId, input.revision ?? 0) as ArchivedMessage) !;
  }

  /** 最新 revision 的那一行：编辑过的消息会有多行，引用时要拿用户此刻看到的那一版。 */
  byTgMessageId(tgMessageId: number): ArchivedMessage | null {
    return withMedia(this.db.prepare(`SELECT ${messageQuery()},media_parts_json AS mediaPartsJson FROM messages
      WHERE chat_id=? AND tg_message_id=? AND deleted_at IS NULL ORDER BY revision DESC LIMIT 1`).get(this.chatId, tgMessageId) as ArchivedMessage | undefined ?? null);
  }

  attachMedia(id: number, parts: unknown[]): void {
    this.db.prepare('UPDATE messages SET media_parts_json=? WHERE id=?').run(JSON.stringify(parts), id);
  }

  /**
   * 判成触发、但最终没人为它开轮次的消息改记成背景消息（`trigger.cooldownMsPerUser` 压住的那些）。
   * `claimBackground` 只认领 `triggered=0`，留着 `triggered=1` 的话这条消息**既不触发也不进上下文**，
   * 等于凭空消失 —— 编辑消息踩过同一个坑（docs/20 · W-TG-05）。
   */
  demoteToBackground(id: number): void {
    this.db.prepare("UPDATE messages SET triggered=0,trigger_reason=NULL WHERE id=? AND chat_id=? AND turn_id IS NULL").run(id, this.chatId);
  }

  byId(id: number): ArchivedMessage | null {
    return withMedia(this.db.prepare(`SELECT ${messageQuery()},media_parts_json AS mediaPartsJson FROM messages WHERE chat_id = ? AND id = ?`).get(this.chatId, id) as ArchivedMessage | undefined ?? null);
  }

  search(query: string, limit = 20, filters: SearchFilters = {}): ArchivedMessage[] {
    const thread = this.threadId === null ? '' : ' AND message_thread_id = @threadId';
    const columns = `id,chat_id AS chatId,message_thread_id AS messageThreadId,tg_message_id AS tgMessageId,direction,
      from_kind AS fromKind,from_user_id AS fromUserId,from_name AS fromName,from_username AS fromUsername,kind,text,tg_date AS tgDate,triggered,trigger_reason AS triggerReason`;
    const parsed = archiveQuery(query);
    const bound = { chatId: this.chatId, threadId: this.threadId, limit, ...filterParameters(filters) };
    const rows = 'like' in parsed ? this.db.prepare(`SELECT ${columns},media_parts_json AS mediaPartsJson FROM messages WHERE chat_id = @chatId${thread} AND deleted_at IS NULL AND text LIKE @query${LIKE_ESCAPE}${filterClause('')} ORDER BY tg_date DESC LIMIT @limit`).all({ ...bound, query: parsed.like }) as ArchivedMessage[]
      : this.db.prepare(`SELECT ${messageQuery('m')},m.media_parts_json AS mediaPartsJson FROM messages_fts f JOIN messages m ON m.id=f.rowid WHERE m.chat_id = @chatId${thread ? ' AND m.message_thread_id = @threadId' : ''} AND messages_fts MATCH @query AND m.deleted_at IS NULL${filterClause('m.')} ORDER BY bm25(messages_fts),m.tg_date DESC LIMIT @limit`).all({ ...bound, query: parsed.fts }) as ArchivedMessage[];
    return rows.map((row) => withMedia(row)!);
  }

  recent(limit = 50): ArchivedMessage[] {
    const rows = this.db.prepare(`SELECT ${messageQuery()},media_parts_json AS mediaPartsJson FROM messages WHERE chat_id = ?
      AND (? IS NULL OR message_thread_id = ?) AND deleted_at IS NULL ORDER BY id DESC LIMIT ?`).all(this.chatId, this.threadId, this.threadId, limit) as ArchivedMessage[];
    return rows.map((row) => withMedia(row)!);
  }

  /**
   * 「按顺序读取聊天记录」（docs/05 §3.2）：`anchor` 之前 / 之后 / 两侧各一半。此前这个工具
   * 只有 `{limit}`，模型除了「最近 N 条」没有任何往前翻的手段 —— 要找一句三天前的话只能
   * 把 limit 一路加到上限，而那正是把上下文吃满的做法。
   *
   * 一律按 id 升序交回：`recent()` 那种「最新在最前」在 `direction:'after'` 上会让读出来的
   * 一段反着念，而模型是照顺序理解对话的。
   */
  window(input: { anchorId?: number | null | undefined; anchorDate?: number | null | undefined; direction?: 'before' | 'after' | 'around' | undefined; limit?: number | undefined }): ArchivedMessage[] {
    const limit = input.limit ?? 50;
    const anchor = input.anchorId ?? (input.anchorDate === null || input.anchorDate === undefined ? null : this.#anchorAt(input.anchorDate));
    if (anchor === null) return this.recent(limit).reverse();
    if (input.direction === 'after') return this.#slice('id >= @anchor', 'ASC', limit, anchor);
    if (input.direction !== 'around') return this.#slice('id <= @anchor', 'DESC', limit, anchor).reverse();
    const before = Math.floor((limit - 1) / 2);
    return [...this.#slice('id < @anchor', 'DESC', before, anchor).reverse(), ...this.#slice('id >= @anchor', 'ASC', limit - before, anchor)];
  }

  /**
   * ISO 时间锚点先落到一条真实消息上（该时刻起的第一条，之后没有了就取最后一条），后面一律按 id 走。
   * 两条 SQL 把会话过滤写全而不是抽成变量：`db.isolation.test.ts` 的扫描器读的是源码里的字符串
   * 字面量，藏在 `${scope}` 后面它看不见 —— 那条断言存在的意义就是没人能这么绕过去。
   */
  #anchorAt(date: number): number | null {
    const bound = { chatId: this.chatId, threadId: this.threadId, date };
    return (this.db.prepare('SELECT id FROM messages WHERE chat_id = @chatId AND (@threadId IS NULL OR message_thread_id = @threadId) AND deleted_at IS NULL AND tg_date >= @date ORDER BY tg_date, id LIMIT 1').pluck().get(bound)
      ?? this.db.prepare('SELECT id FROM messages WHERE chat_id = @chatId AND (@threadId IS NULL OR message_thread_id = @threadId) AND deleted_at IS NULL ORDER BY id DESC LIMIT 1').pluck().get(bound) ?? null) as number | null;
  }

  #slice(comparison: string, order: 'ASC' | 'DESC', limit: number, anchor: number): ArchivedMessage[] {
    if (limit <= 0) return [];
    const rows = this.db.prepare(`SELECT ${messageQuery()},media_parts_json AS mediaPartsJson FROM messages
      WHERE chat_id = @chatId AND (@threadId IS NULL OR message_thread_id = @threadId) AND deleted_at IS NULL AND ${comparison}
      ORDER BY id ${order} LIMIT @limit`).all({ chatId: this.chatId, threadId: this.threadId, anchor, limit }) as ArchivedMessage[];
    return rows.map((row) => withMedia(row)!);
  }

  /**
   * 一批 Telegram 消息编号 → 归档 id（取最新 revision）。渲染回复标记要用它换一次：两套编号
   * 不通用，把 Telegram 那个当 `#id` 交给模型，它照着 `get_message` 回查会取到另一条消息。
   * 一次查完整批而不是逐条查 —— 一页 50 条就是 50 次查询。
   */
  archiveIdsByTgMessageIds(tgMessageIds: readonly number[]): Map<number, number> {
    if (!tgMessageIds.length) return new Map();
    const placeholders = tgMessageIds.map(() => '?').join(',');
    const rows = this.db.prepare(`SELECT tg_message_id AS tg, MAX(id) AS id FROM messages WHERE chat_id = ?
      AND (? IS NULL OR message_thread_id = ?) AND tg_message_id IN (${placeholders}) AND deleted_at IS NULL
      GROUP BY tg_message_id`).all(this.chatId, this.threadId, this.threadId, ...tgMessageIds) as Array<{ tg: number; id: number }>;
    return new Map(rows.map((row) => [row.tg, row.id]));
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
