import type { Sqlite } from "./database.js";

function redactArchivePayload(value: unknown): unknown {
  if (typeof value === "string")
    return value.replace(
      /\bsk-[A-Za-z0-9_-]{16,}\b|Bearer\s+\S+|\b\d{8,10}:[A-Za-z0-9_-]{35}\b/gi,
      "«redacted»",
    );
  if (Array.isArray(value)) return value.map(redactArchivePayload);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        /api[_-]?key|secret|token|password|credential/i.test(key)
          ? "«redacted»"
          : redactArchivePayload(nested),
      ]),
    );
  return value;
}
export interface ArchivedMessage {
  id: number;
  chatId: string;
  messageThreadId: number | null;
  tgMessageId: number;
  direction: "in" | "out";
  fromKind: "user" | "bot" | "system";
  fromUserId: string | null;
  fromName: string | null;
  fromUsername: string | null;
  kind: string;
  text: string | null;
  tgDate: number;
  triggered: number;
  triggerReason: string | null;
  turnId?: string | null;
  /**
   * 同一条 Telegram 消息的版本号：0 为原文，>0 为编辑。读出侧必须携带此字段：渲染进上下文时
   * 用它标注「已编辑」，否则五分钟前的消息被编辑后，在模型看来与新发消息无法区分
   * （docs/29 · `M-TG-02`）。适配层现场构造的消息没有这一列，按 0 处理。
   */
  revision?: number;
  replyToTgMessageId?: number | null;
  mediaParts?: unknown[];
  /** 被回复者的显示名。只在适配层现场构造的消息上出现（Telegram update 里带着），不落库。 */
  replyToName?: string;
}

/**
 * `append()` 的返回值：目标行，外加本次是否真的插入。
 *
 * `INSERT OR IGNORE` 主键冲突时静默返回既有行，而回读是按入参 `tgMessageId` 查的，返回行的
 * `tgMessageId` 恒等于入参，调用方无法判断该行并非本次写入。定时轮次的冲突核对
 * （`runner.ts` 的 `schedule_trigger_conflict`）因此成为不可达代码（docs/28 · L-SCH-03）。
 * 标记挂在返回值而非另开方法：`info.changes` 仅在本次 `run()` 内有效，隔一条 SELECT 再查得到的是
 * 「当前是否存在该行」而非「本次是否插入」。
 */
export type AppendedMessage = ArchivedMessage & { inserted: boolean };

export interface AppendMessageInput extends Omit<
  ArchivedMessage,
  "id" | "triggered" | "triggerReason"
> {
  tgUpdateId?: number | null;
  raw: unknown;
  triggered?: boolean;
  triggerReason?: string | null;
  revision?: number;
  mediaGroupId?: string | null;
  /** 立即标记为已消费。用于引用注入：该消息本轮已进入上下文，不能在下一轮被再次认领为背景消息。 */
  claimed?: boolean;
}

/**
 * FTS5 的 MATCH 串是一门查询语言：`|` `"` `*` `:` `-` `^` `(` `)` 与 AND/OR/NOT/NEAR 均为语法元素。
 * 查询词来自模型与 WebUI 使用者，原样传入会导致语法错误：模型写 `名字|我是|叫|谁` 会使整次工具调用
 * 返回 `fts5: syntax error near "|"`，模型只能盲目改参数重试。这里先分词，再决定检索方式：
 * - 存在 ≥3 字的词：逐个加引号后 OR 连接走 FTS（trigram 索引不匹配更短的词），bm25 负责排序；
 * - 不存在（中文双字词几乎都属此类）：退回 LIKE，且用最长的词而非原串，因为原串含 `|`，
 *   `LIKE '%名字|我是%'` 匹配不到任何内容。
 * 多词间取 OR 而非 FTS 默认的隐式 AND：调用方是模型，它写多个词的意图是列举同义词。
 *
 * 丢弃短词是正确降级，静默丢弃不是。短词进不了 trigram 索引（`MATCH` 恒零命中），走 FTS 时必须剔除；
 * 但混合查询（`search_messages("名字 李小明")`）中模型无法得知自己只检索了 `李小明`。因此 `dropped`
 * 把未参与的词返回给调用方，由调用方提示模型单独检索这些词（单独检索时它们是最长词，走下面的
 * LIKE 兜底）。docs/28 · L-DB-01。
 */
/**
 * LIKE 中 `_` 匹配任意单字符、`%` 匹配任意串，而上面的分词正则刻意把 `_` 保留为词内字符：
 * `a_b` 变成 `LIKE '%a_b%'`，`axb` 也会命中（docs/27 · C-06）。这不是注入（值走绑定参数），
 * 只影响检索精度。转义后必须配 `ESCAPE '\'`，三条 LIKE 语句都带着它。
 */
const escapeLike = (value: string): string => value.replace(/[\\%_]/g, "\\$&");
/** 上述转义的配套子句。新增 LIKE 查询时必须一并带上，否则 `\` 会被当作普通字符。 */
export const LIKE_ESCAPE = " ESCAPE '\\'";
/**
 * `dropped` 挂在交叉类型上而非作为平级字段：`'like' in parsed` 是三个调用点共用的判别式，
 * 增加平级字段会破坏该判别。
 */
export type ArchiveQuery = ({ fts: string } | { like: string }) & {
  /** 已分词但未参与本次检索的词（长度均小于 3 码点）。调用方有责任把它返回给使用者。 */
  dropped: string[];
};
export function archiveQuery(raw: string): ArchiveQuery {
  const tokens = [...new Set(raw.split(/[^\p{L}\p{N}_]+/u).filter(Boolean))];
  const matchable = tokens.filter((token) => [...token].length >= 3);
  if (matchable.length)
    return {
      fts: matchable
        .map((token) => `"${token.replaceAll('"', '""')}"`)
        .join(" OR "),
      dropped: tokens.filter((token) => [...token].length < 3),
    };
  const longest = [...tokens].sort(
    (left, right) => [...right].length - [...left].length,
  )[0];
  // LIKE 分支只使用最长的一个词，其余同样未参与，一并报出。此时所有词都短于 3 码点，
  // 因此调用方「短于 3 个字」的措辞在两条分支上都成立。
  return {
    like: `%${escapeLike(longest ?? raw)}%`,
    dropped: tokens.filter((token) => token !== longest),
  };
}

/**
 * `search_messages` 的过滤参数（docs/05 §3.2）。`from` 同时接受 tg 用户 id 与 `@username`。
 *
 * `minId` 不是模型可填的参数，而是回忆隔断（`context.recallBarrier`）注入的下限，取值为清空上下文
 * 时刻的 `messages.id`。放在 SQL 条件而非工具层过滤返回值：后者会使 `limit:20` 先取 20 条再削减到
 * 3 条，模型看到的是「总共只有 3 条」。
 */
export interface SearchFilters {
  from?: string | null;
  after?: number | null;
  before?: number | null;
  kind?: string | null;
  minId?: number | null;
}
/**
 * 过滤条件一律写成 `@x IS NULL OR …` 的常量 SQL，而非按传入参数拼接：语句文本固定才能命中
 * better-sqlite3 的预编译缓存；且「未传的参数不出现在 SQL 里」还需在绑定侧同步剔除，漏一处即为
 * 运行时的 `missing named parameter`。本文件 `recent()` 已采用同一写法。
 */
function filterClause(prefix: string): string {
  return ` AND (@from IS NULL OR ${prefix}from_user_id = @from OR ${prefix}from_username = @from)
    AND (@after IS NULL OR ${prefix}tg_date >= @after) AND (@before IS NULL OR ${prefix}tg_date <= @before)
    AND (@kind IS NULL OR ${prefix}kind = @kind) AND (@minId IS NULL OR ${prefix}id > @minId)`;
}
function filterParameters(filters: SearchFilters): Required<SearchFilters> {
  return {
    from: filters.from?.replace(/^@/, "") ?? null,
    after: filters.after ?? null,
    before: filters.before ?? null,
    kind: filters.kind ?? null,
    minId: filters.minId ?? null,
  };
}

const MESSAGE_COLUMNS = `m.id,m.chat_id AS chatId,m.message_thread_id AS messageThreadId,m.tg_message_id AS tgMessageId,m.direction,
  m.from_kind AS fromKind,m.from_user_id AS fromUserId,m.from_name AS fromName,m.from_username AS fromUsername,m.kind,m.text,m.tg_date AS tgDate,
  m.triggered,m.trigger_reason AS triggerReason,m.turn_id AS turnId,m.revision,m.reply_to_tg_message_id AS replyToTgMessageId`;
const messageQuery = (prefix = "") =>
  prefix ? MESSAGE_COLUMNS : MESSAGE_COLUMNS.replaceAll("m.", "");
const withMedia = (row: ArchivedMessage | null): ArchivedMessage | null => {
  if (!row) return null;
  const parts = (row as ArchivedMessage & { mediaPartsJson?: string | null })
    .mediaPartsJson;
  // 无法解析的 JSON 按「该消息无媒体」处理：本函数位于每条消息的读出路径上，抛异常会导致整次检索、
  // 整次归档读取失败，而丢弃一条附件只是该消息少一张图（docs/27 · T-06）。
  if (parts) {
    try {
      row.mediaParts = JSON.parse(parts) as unknown[];
    } catch {
      /* 手工改库或历史脏数据 */
    }
  }
  delete (row as ArchivedMessage & { mediaPartsJson?: string }).mediaPartsJson;
  return row;
};
export class ArchiveRepository {
  constructor(private readonly db: Sqlite) {}

  scope(
    chatId: string,
    threadId: number | null = null,
  ): ScopedArchiveRepository {
    return new ScopedArchiveRepository(this.db, chatId, threadId);
  }

  adminSearchAll(query: string, limit = 50): ArchivedMessage[] {
    const parsed = archiveQuery(query);
    const rows =
      "like" in parsed
        ? (this.db
            .prepare(
              `SELECT ${messageQuery()},media_parts_json AS mediaPartsJson FROM messages WHERE deleted_at IS NULL AND text LIKE ?${LIKE_ESCAPE} ORDER BY tg_date DESC LIMIT ?`,
            )
            .all(parsed.like, limit) as ArchivedMessage[])
        : (this.db
            .prepare(
              `SELECT ${messageQuery("m")},m.media_parts_json AS mediaPartsJson FROM messages_fts f JOIN messages m ON m.id=f.rowid WHERE messages_fts MATCH ? AND m.deleted_at IS NULL ORDER BY bm25(messages_fts),m.tg_date DESC LIMIT ?`,
            )
            .all(parsed.fts, limit) as ArchivedMessage[]);
    return rows.map((row) => withMedia(row)!);
  }

  /** 命中总数。分页页码依赖此值：用「已取回条数」充当 total 会导致翻页时页数漂移（docs/20 · W-API-03）。 */
  adminSearchCount(query: string): number {
    const parsed = archiveQuery(query);
    return "like" in parsed
      ? (this.db
          .prepare(
            `SELECT COUNT(*) FROM messages WHERE deleted_at IS NULL AND text LIKE ?${LIKE_ESCAPE}`,
          )
          .pluck()
          .get(parsed.like) as number)
      : (this.db
          .prepare(
            "SELECT COUNT(*) FROM messages_fts f JOIN messages m ON m.id=f.rowid WHERE messages_fts MATCH ? AND m.deleted_at IS NULL",
          )
          .pluck()
          .get(parsed.fts) as number);
  }
}

export class ScopedArchiveRepository {
  constructor(
    private readonly db: Sqlite,
    readonly chatId: string,
    readonly threadId: number | null,
  ) {}

  append(input: AppendMessageInput): AppendedMessage {
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO messages(chat_id,message_thread_id,tg_message_id,tg_update_id,direction,from_kind,
      from_user_id,from_name,from_username,reply_to_tg_message_id,media_group_id,kind,text,raw_json,media_parts_json,tg_date,received_at,
      triggered,trigger_reason,turn_id,revision,claimed_at) VALUES (@chatId,@messageThreadId,@tgMessageId,@tgUpdateId,@direction,@fromKind,
      @fromUserId,@fromName,@fromUsername,@replyToTgMessageId,@mediaGroupId,@kind,@text,@rawJson,@mediaPartsJson,@tgDate,@receivedAt,
      @triggered,@triggerReason,@turnId,@revision,@claimedAt)`,
      )
      .run({
        ...input,
        tgUpdateId: input.tgUpdateId ?? null,
        replyToTgMessageId: input.replyToTgMessageId ?? null,
        mediaGroupId: input.mediaGroupId ?? null,
        rawJson: JSON.stringify(redactArchivePayload(input.raw)),
        mediaPartsJson: input.mediaParts
          ? JSON.stringify(input.mediaParts)
          : null,
        receivedAt: Date.now(),
        triggered: input.triggered ? 1 : 0,
        triggerReason: input.triggerReason ?? null,
        turnId: input.turnId ?? null,
        revision: input.revision ?? 0,
        // claimed_by_turn 留空：该消息已被消费，但不属于任何在途轮次，abortTurn 的 releaseClaims 不应回滚它。
        claimedAt: input.claimed ? Date.now() : null,
      });
    if (info.changes)
      return Object.assign(this.byId(Number(info.lastInsertRowid))!, {
        inserted: true,
      });
    return Object.assign(
      withMedia(
        this.db
          .prepare(
            `SELECT ${messageQuery()},media_parts_json AS mediaPartsJson FROM messages WHERE chat_id=? AND tg_message_id=? AND revision=?`,
          )
          .get(
            this.chatId,
            input.tgMessageId,
            input.revision ?? 0,
          ) as ArchivedMessage,
      )!,
      { inserted: false },
    );
  }

  /** 取最新 revision 的行：编辑过的消息有多行，引用时应取用户当前看到的那一版。 */
  byTgMessageId(tgMessageId: number): ArchivedMessage | null {
    return withMedia(
      (this.db
        .prepare(
          `SELECT ${messageQuery()},media_parts_json AS mediaPartsJson FROM messages
      WHERE chat_id=? AND tg_message_id=? AND deleted_at IS NULL ORDER BY revision DESC LIMIT 1`,
        )
        .get(this.chatId, tgMessageId) as ArchivedMessage | undefined) ?? null,
    );
  }

  attachMedia(id: number, parts: unknown[]): void {
    this.db
      .prepare("UPDATE messages SET media_parts_json=? WHERE id=?")
      .run(JSON.stringify(parts), id);
  }

  /**
   * 把判定为触发但最终未开轮次的消息改记为背景消息（被 `trigger.cooldownMsPerUser` 拦下的那些）。
   * `claimBackground` 只认领 `triggered=0`，保留 `triggered=1` 会使该消息既不触发也不进上下文，
   * 等同于丢失。编辑消息曾出现同一缺陷（docs/20 · W-TG-05）。
   */
  demoteToBackground(id: number): void {
    this.db
      .prepare(
        "UPDATE messages SET triggered=0,trigger_reason=NULL WHERE id=? AND chat_id=? AND turn_id IS NULL",
      )
      .run(id, this.chatId);
  }

  /** @param minId 回忆隔断的下限（`context.recallBarrier`）；0 表示不限制，见 `SearchFilters.minId`。 */
  byId(id: number, minId = 0): ArchivedMessage | null {
    return withMedia(
      (this.db
        .prepare(
          `SELECT ${messageQuery()},media_parts_json AS mediaPartsJson FROM messages WHERE chat_id = ? AND id = ? AND id > ?`,
        )
        .get(this.chatId, id, minId) as ArchivedMessage | undefined) ?? null,
    );
  }

  /** 本会话归档中最大的 `messages.id`。清空上下文时以它作为回忆隔断的水位（`ContextEngine.reset`）。 */
  maxMessageId(): number {
    return (this.db
      .prepare(
        "SELECT COALESCE(MAX(id),0) AS value FROM messages WHERE chat_id = ? AND (? IS NULL OR message_thread_id = ?)",
      )
      .pluck()
      .get(this.chatId, this.threadId, this.threadId) ?? 0) as number;
  }

  search(
    query: string,
    limit = 20,
    filters: SearchFilters = {},
  ): ArchivedMessage[] {
    const thread =
      this.threadId === null ? "" : " AND message_thread_id = @threadId";
    const columns = `id,chat_id AS chatId,message_thread_id AS messageThreadId,tg_message_id AS tgMessageId,direction,
      from_kind AS fromKind,from_user_id AS fromUserId,from_name AS fromName,from_username AS fromUsername,kind,text,tg_date AS tgDate,triggered,trigger_reason AS triggerReason`;
    const parsed = archiveQuery(query);
    const bound = {
      chatId: this.chatId,
      threadId: this.threadId,
      limit,
      ...filterParameters(filters),
    };
    const rows =
      "like" in parsed
        ? (this.db
            .prepare(
              `SELECT ${columns},media_parts_json AS mediaPartsJson FROM messages WHERE chat_id = @chatId${thread} AND deleted_at IS NULL AND text LIKE @query${LIKE_ESCAPE}${filterClause("")} ORDER BY tg_date DESC LIMIT @limit`,
            )
            .all({ ...bound, query: parsed.like }) as ArchivedMessage[])
        : (this.db
            .prepare(
              `SELECT ${messageQuery("m")},m.media_parts_json AS mediaPartsJson FROM messages_fts f JOIN messages m ON m.id=f.rowid WHERE m.chat_id = @chatId${thread ? " AND m.message_thread_id = @threadId" : ""} AND messages_fts MATCH @query AND m.deleted_at IS NULL${filterClause("m.")} ORDER BY bm25(messages_fts),m.tg_date DESC LIMIT @limit`,
            )
            .all({ ...bound, query: parsed.fts }) as ArchivedMessage[]);
    return rows.map((row) => withMedia(row)!);
  }

  recent(limit = 50, minId = 0): ArchivedMessage[] {
    const rows = this.db
      .prepare(
        `SELECT ${messageQuery()},media_parts_json AS mediaPartsJson FROM messages WHERE chat_id = ?
      AND (? IS NULL OR message_thread_id = ?) AND deleted_at IS NULL AND id > ? ORDER BY id DESC LIMIT ?`,
      )
      .all(
        this.chatId,
        this.threadId,
        this.threadId,
        minId,
        limit,
      ) as ArchivedMessage[];
    return rows.map((row) => withMedia(row)!);
  }

  /**
   * 按顺序读取聊天记录（docs/05 §3.2）：取 `anchor` 之前 / 之后 / 两侧各一半。此前该工具只有
   * `{limit}` 参数，模型除「最近 N 条」外没有任何回溯手段，要找三天前的一句话只能把 limit 加到上限，
   * 而这正是耗尽上下文的做法。
   *
   * 一律按 id 升序返回：`recent()` 的「最新在前」在 `direction:'after'` 下会使读出的片段逆序，
   * 而模型按顺序理解对话。
   */
  window(input: {
    anchorId?: number | null | undefined;
    anchorDate?: number | null | undefined;
    direction?: "before" | "after" | "around" | undefined;
    limit?: number | undefined;
    minId?: number | null | undefined;
  }): ArchivedMessage[] {
    const limit = input.limit ?? 50;
    const floor = input.minId ?? 0;
    const anchor =
      input.anchorId ??
      (input.anchorDate === null || input.anchorDate === undefined
        ? null
        : this.#anchorAt(input.anchorDate));
    if (anchor === null) return this.recent(limit, floor).reverse();
    if (input.direction === "after")
      return this.#slice("id >= @anchor", "ASC", limit, anchor, floor);
    if (input.direction !== "around")
      return this.#slice(
        "id <= @anchor",
        "DESC",
        limit,
        anchor,
        floor,
      ).reverse();
    const before = Math.floor((limit - 1) / 2);
    return [
      ...this.#slice("id < @anchor", "DESC", before, anchor, floor).reverse(),
      ...this.#slice("id >= @anchor", "ASC", limit - before, anchor, floor),
    ];
  }

  /**
   * ISO 时间锚点先落到一条真实消息上（该时刻起的第一条，若无则取最后一条），此后一律按 id 定位。
   * 两条 SQL 各自写全会话过滤而不抽成变量：`db.isolation.test.ts` 的扫描器读的是源码里的字符串
   * 字面量，藏进 `${scope}` 后它就检测不到，而该断言的意义正是不允许以这种方式绕过。
   */
  #anchorAt(date: number): number | null {
    const bound = { chatId: this.chatId, threadId: this.threadId, date };
    return (this.db
      .prepare(
        "SELECT id FROM messages WHERE chat_id = @chatId AND (@threadId IS NULL OR message_thread_id = @threadId) AND deleted_at IS NULL AND tg_date >= @date ORDER BY tg_date, id LIMIT 1",
      )
      .pluck()
      .get(bound) ??
      this.db
        .prepare(
          "SELECT id FROM messages WHERE chat_id = @chatId AND (@threadId IS NULL OR message_thread_id = @threadId) AND deleted_at IS NULL ORDER BY id DESC LIMIT 1",
        )
        .pluck()
        .get(bound) ??
      null) as number | null;
  }

  #slice(
    comparison: string,
    order: "ASC" | "DESC",
    limit: number,
    anchor: number,
    minId = 0,
  ): ArchivedMessage[] {
    if (limit <= 0) return [];
    const rows = this.db
      .prepare(
        `SELECT ${messageQuery()},media_parts_json AS mediaPartsJson FROM messages
      WHERE chat_id = @chatId AND (@threadId IS NULL OR message_thread_id = @threadId) AND deleted_at IS NULL AND id > @minId AND ${comparison}
      ORDER BY id ${order} LIMIT @limit`,
      )
      .all({
        chatId: this.chatId,
        threadId: this.threadId,
        anchor,
        limit,
        minId,
      }) as ArchivedMessage[];
    return rows.map((row) => withMedia(row)!);
  }

  /**
   * 批量把 Telegram 消息编号映射到归档 id（取最新 revision）。渲染回复标记时必须做一次转换：
   * 两套编号不通用，把 Telegram 编号当作 `#id` 交给模型，它用 `get_message` 回查会取到另一条消息。
   * 整批一次查询而非逐条查询：一页 50 条即 50 次查询。
   */
  archiveIdsByTgMessageIds(
    tgMessageIds: readonly number[],
  ): Map<number, number> {
    if (!tgMessageIds.length) return new Map();
    const placeholders = tgMessageIds.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT tg_message_id AS tg, MAX(id) AS id FROM messages WHERE chat_id = ?
      AND (? IS NULL OR message_thread_id = ?) AND tg_message_id IN (${placeholders}) AND deleted_at IS NULL
      GROUP BY tg_message_id`,
      )
      .all(
        this.chatId,
        this.threadId,
        this.threadId,
        ...tgMessageIds,
      ) as Array<{ tg: number; id: number }>;
    return new Map(rows.map((row) => [row.tg, row.id]));
  }

  claimBackground(
    afterId: number,
    throughId: number,
    max: number,
    turnId: string,
  ): { rows: ArchivedMessage[]; omitted: number } {
    return this.db.transaction(() => {
      const all = this.db
        .prepare(
          `SELECT ${messageQuery()},media_parts_json AS mediaPartsJson FROM messages WHERE chat_id = ?
        AND (? IS NULL OR message_thread_id = ?) AND id > ? AND id <= ? AND claimed_at IS NULL
        AND direction='in' AND from_kind='user' AND triggered=0 AND deleted_at IS NULL AND NOT EXISTS (
          SELECT 1 FROM principals p WHERE p.kind='user' AND p.tg_id=messages.from_user_id AND p.role='blocked'
        ) ORDER BY id`,
        )
        .all(
          this.chatId,
          this.threadId,
          this.threadId,
          afterId,
          throughId,
        ) as ArchivedMessage[];
      for (const row of all) withMedia(row);
      const rows = max === 0 ? [] : all.slice(-max);
      if (rows.length) {
        const placeholders = rows.map(() => "?").join(",");
        this.db
          .prepare(
            `UPDATE messages SET claimed_at=?,claimed_by_turn=? WHERE chat_id=? AND claimed_at IS NULL AND id IN (${placeholders})`,
          )
          .run(Date.now(), turnId, this.chatId, ...rows.map((row) => row.id));
      }
      return { rows, omitted: all.length - rows.length };
    })();
  }

  releaseClaims(turnId: string): number {
    return this.db
      .prepare(
        "UPDATE messages SET claimed_at=NULL,claimed_by_turn=NULL WHERE claimed_by_turn=?",
      )
      .run(turnId).changes;
  }
}
