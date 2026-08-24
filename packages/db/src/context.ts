import {
  estimateMessageTokens,
  type NewContextMessage,
  type Role,
} from "@luoli/shared";
import { ulid } from "ulid";
import type { ArchivedMessage } from "./archive.js";
import type { Sqlite } from "./database.js";

export interface ContextRow {
  key: string;
  chatId: string;
  threadId: number | null;
  scope: "chat" | "thread";
  nextOrdinal: number;
  claimWatermark: number;
  tokenRatio: number;
}

export interface CommitRow {
  id: string;
  key: string;
  seq: number;
  parentId: string | null;
  kind: "turn" | "prune" | "reset" | "manual" | "revert";
  turnId: string | null;
  baseCommitId: string | null;
  rebased: number;
  rebaseOver: string | null;
  windowStart: number;
  headOrdinal: number;
  tokensTotal: number;
  msgCount: number;
  meta: string | null;
  createdAt: number;
}

export interface StoredContextMessage extends NewContextMessage {
  ordinal: number;
  turnId: string;
  key: string;
  pruneApplied: number;
  createdAt: number;
}

const COMMIT_COLUMNS = `id,key,seq,parent_id AS parentId,kind,turn_id AS turnId,base_commit_id AS baseCommitId,
  rebased,rebase_over_json AS rebaseOver,window_start AS windowStart,head_ordinal AS headOrdinal,
  tokens_total AS tokensTotal,msg_count AS msgCount,meta_json AS meta,created_at AS createdAt`;

const JOINED_COMMIT_COLUMNS = `c.id,c.key,c.seq,c.parent_id AS parentId,c.kind,c.turn_id AS turnId,c.base_commit_id AS baseCommitId,
  c.rebased,c.rebase_over_json AS rebaseOver,c.window_start AS windowStart,c.head_ordinal AS headOrdinal,
  c.tokens_total AS tokensTotal,c.msg_count AS msgCount,c.meta_json AS meta,c.created_at AS createdAt`;
function elidePart(part: unknown, level: number): unknown {
  if (!part || typeof part !== "object")
    return { type: "text", text: "[已省略]" };
  const value = part as Record<string, unknown>;
  if (value.type === "tool-call") return { ...value, input: { elided: true } };
  if (value.type === "tool-result")
    return { ...value, output: { type: "text", value: "[已省略工具结果]" } };
  return {
    type: "text",
    text: level === 1 ? "[已省略工具结果]" : "[已省略工具调用参数]",
  };
}

export class ContextRepository {
  constructor(
    private readonly db: Sqlite,
    readonly key: string,
  ) {}

  ensure(
    chatId: string,
    threadId: number | null,
    scope: "chat" | "thread",
  ): ContextRow {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO contexts(key,chat_id,thread_id,scope,created_at,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(key) DO NOTHING`,
      )
      .run(this.key, chatId, threadId, scope, now, now);
    return this.db
      .prepare(
        `SELECT key,chat_id AS chatId,thread_id AS threadId,scope,next_ordinal AS nextOrdinal,
      claim_watermark AS claimWatermark,token_ratio AS tokenRatio FROM contexts WHERE key = ?`,
      )
      .get(this.key) as ContextRow;
  }

  context(): ContextRow | null {
    return (
      (this.db
        .prepare(
          `SELECT key,chat_id AS chatId,thread_id AS threadId,scope,next_ordinal AS nextOrdinal,
      claim_watermark AS claimWatermark,token_ratio AS tokenRatio FROM contexts WHERE key = ?`,
        )
        .get(this.key) as ContextRow | undefined) ?? null
    );
  }

  advanceWatermark(messageId: number): void {
    this.db
      .prepare(
        "UPDATE contexts SET claim_watermark=MAX(claim_watermark,?),updated_at=? WHERE key=?",
      )
      .run(messageId, Date.now(), this.key);
  }

  head(): CommitRow | null {
    return (
      (this.db
        .prepare(
          `SELECT ${JOINED_COMMIT_COLUMNS} FROM refs r JOIN context_commits c ON c.id=r.commit_id WHERE r.key=? AND r.name='done'`,
        )
        .get(this.key) as CommitRow | undefined) ?? null
    );
  }

  commit(id: string): CommitRow | null {
    return (
      (this.db
        .prepare(
          `SELECT ${COMMIT_COLUMNS} FROM context_commits WHERE key=? AND id=?`,
        )
        .get(this.key, id) as CommitRow | undefined) ?? null
    );
  }

  maxOrdinal(): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(MAX(ordinal),0) AS value FROM context_messages WHERE key=?",
      )
      .get(this.key) as { value: number };
    return row.value;
  }
  turnStartOrdinals(from: number, to: number): number[] {
    return (
      this.db
        .prepare(
          `SELECT MIN(ordinal) AS ordinal FROM context_messages
      WHERE key=? AND ordinal BETWEEN ? AND ? GROUP BY turn_id ORDER BY ordinal`,
        )
        .all(this.key, from, to) as Array<{ ordinal: number }>
    ).map((row) => row.ordinal);
  }

  isAncestor(ancestorId: string | null, descendantId: string | null): boolean {
    if (ancestorId === null) return true;
    if (descendantId === null) return false;
    return Boolean(
      this.db
        .prepare(
          `WITH RECURSIVE chain(id,parent_id) AS (
      SELECT id,parent_id FROM context_commits WHERE key=? AND id=?
      UNION ALL SELECT c.id,c.parent_id FROM context_commits c JOIN chain ON c.id=chain.parent_id WHERE c.key=?
    ) SELECT 1 FROM chain WHERE id=? LIMIT 1`,
        )
        .get(this.key, descendantId, this.key, ancestorId),
    );
  }

  effectiveStats(from: number, to: number): { tokens: number; count: number } {
    if (from > to) return { tokens: 0, count: 0 };
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(CASE
        WHEN prune_applied=1 AND prune_level=1 THEN 12
        WHEN prune_applied=1 AND prune_level=2 THEN 12
        WHEN json_extract(meta_json,'$.truncated.tokens') IS NOT NULL THEN json_extract(meta_json,'$.truncated.tokens')
        ELSE tokens END),0) AS tokens,COUNT(*) AS count
      FROM context_messages WHERE key=? AND ordinal BETWEEN ? AND ?`,
      )
      .get(this.key, from, to) as { tokens: number; count: number };
    return row;
  }
  /**
   * 回忆隔断的水位（`context.recallBarrier`）：HEAD 之前（含）最近那次 `reset` commit 记下的
   * `meta.archiveFloor` —— 也就是「最后一次清空发生时，归档里最大的 messages.id」。0 = 没设过。
   *
   * 按 **seq** 取而不是按祖先链取，与 `hasResetAfter` 同一套语义。好处是 `/undo` 把 HEAD 退回
   * 那次清空之前时隔断随之解除（head.seq 小于它了）；代价是 WebUI 的「回滚到此」解除不了 ——
   * 它插的是一条 seq 更大的 `manual` commit。那条路本来就把旧窗口整段搬回来了，窗口里的消息
   * 模型照样看得见，只是再往前翻不动。
   */
  recallFloor(): number {
    const head = this.head();
    if (!head) return 0;
    const meta = this.db
      .prepare(
        "SELECT meta_json FROM context_commits WHERE key=? AND kind='reset' AND seq<=? ORDER BY seq DESC LIMIT 1",
      )
      .pluck()
      .get(this.key, head.seq) as string | null | undefined;
    if (!meta) return 0;
    // 坏 JSON 当「没设过」：这个方法在每次归档检索的路径上，抛出去等于把三个工具一起打死。
    try {
      const floor = (JSON.parse(meta) as { archiveFloor?: unknown })
        .archiveFloor;
      return typeof floor === "number" && floor > 0 ? floor : 0;
    } catch {
      return 0;
    }
  }

  hasResetAfter(baseId: string | null, throughSeq: number): boolean {
    const baseSeq = baseId ? (this.commit(baseId)?.seq ?? -1) : -1;
    return Boolean(
      this.db
        .prepare(
          "SELECT 1 FROM context_commits WHERE key=? AND kind='reset' AND seq>? AND seq<=? LIMIT 1",
        )
        .get(this.key, baseSeq, throughSeq),
    );
  }

  hardTruncateLargest(from: number, to: number, targetTotal: number): boolean {
    const stats = this.effectiveStats(from, to);
    const excess = stats.tokens - targetTotal;
    if (excess <= 0) return false;
    const row = this.db
      .prepare(
        `SELECT ordinal,parts_json AS parts,meta_json AS meta,tokens,
        COALESCE(json_extract(meta_json,'$.truncated.tokens'),tokens) AS effective
      FROM context_messages WHERE key=? AND ordinal BETWEEN ? AND ? AND prune_applied=0
        AND COALESCE(json_extract(meta_json,'$.truncated.tokens'),tokens) > 1
      ORDER BY effective DESC,ordinal LIMIT 1`,
      )
      .get(this.key, from, to) as
      | {
          ordinal: number;
          parts: string;
          meta: string | null;
          tokens: number;
          effective: number;
        }
      | undefined;
    if (!row) return false;
    const original = JSON.parse(row.parts) as unknown[];
    const textChars = original.reduce<number>(
      (sum, part) =>
        sum +
        (part &&
        typeof part === "object" &&
        "text" in part &&
        typeof part.text === "string"
          ? [...part.text].length
          : 0),
      0,
    );
    if (!textChars) return false;
    const targetTokens = Math.max(1, row.effective - excess);
    if (targetTokens >= row.effective) return false;
    const chars = Math.max(
      1,
      Math.floor((textChars * targetTokens) / Math.max(1, row.tokens)),
    );
    const meta = row.meta
      ? (JSON.parse(row.meta) as Record<string, unknown>)
      : {};
    meta.truncated = {
      chars,
      tokens: targetTokens,
      originalTokens: row.tokens,
    };
    this.db
      .prepare(
        "UPDATE context_messages SET meta_json=? WHERE key=? AND ordinal=?",
      )
      .run(JSON.stringify(meta), this.key, row.ordinal);
    return true;
  }

  insertTurn(
    turnId: string,
    baseCommitId: string | null,
    messages: NewContextMessage[],
    injectRebaseNotice: boolean,
    claimThroughMessageId?: number,
    markMeta = true,
  ): { commit: CommitRow; rebased: boolean; from: number; to: number } {
    return this.db.transaction(() => {
      const head = this.head();
      const rebased = (head?.id ?? null) !== baseCommitId;
      const base = baseCommitId ? this.commit(baseCommitId) : null;
      const start = this.maxOrdinal() + 1;
      const skipped = rebased ? this.commitsAfter(baseCommitId) : [];
      const delta = [...messages];
      const baseInvalid = Boolean(
        head &&
        (!this.isAncestor(baseCommitId, head.id) ||
          this.hasResetAfter(baseCommitId, head.seq)),
      );
      // 旁白一律 role:'user'：provider 只接受 user/assistant/tool，system 消息会让整个 prompt 被拒收，
      // 而这条 note 是持久化的 —— 写坏一次，该会话在 /new 之前每轮都失败（docs/20 · W-CTX-01）。
      if (baseInvalid)
        delta.unshift({
          id: ulid(),
          role: "user",
          origin: "note",
          parts: [
            { type: "text", text: "（上下文已被重置；本轮基于旧快照产生）" },
          ],
          textPreview: "上下文已被重置",
          tokens: 28,
          pruneLevel: 0,
        });
      if (rebased && !baseInvalid && injectRebaseNotice)
        delta.unshift({
          id: ulid(),
          role: "user",
          origin: "note",
          parts: [
            {
              type: "text",
              text: "（以下回复由并发轮次产生，作者未看到上方最新消息）",
            },
          ],
          textPreview: "并发轮次说明",
          tokens: 22,
          pruneLevel: 0,
        });
      const unseen: [number, number] | null =
        rebased && head
          ? [(base?.headOrdinal ?? 0) + 1, head.headOrdinal]
          : null;
      const insert = this.db
        .prepare(`INSERT INTO context_messages(key,ordinal,id,turn_id,role,origin,prune_level,parts_json,
        text_preview,speaker,speaker_user_id,source_message_id,source_ts,tokens,meta_json,created_at)
        VALUES (@key,@ordinal,@id,@turnId,@role,@origin,@pruneLevel,@parts,@textPreview,@speaker,@speakerUserId,
        @sourceMessageId,@sourceTs,@tokens,@meta,@createdAt)`);
      let ordinal = start - 1;
      for (const message of delta) {
        ordinal += 1;
        // `context.rebase.markMeta`：关掉之后 rebase 过的 assistant 消息不再带 `meta.rebased`。
        // 影响面不只是好看 —— WebUI 的上下文视图与 `docs/13` 的 AC 都按这个标记判断「这一条是
        // 并发轮次产出的」，关掉等于把那条线索从库里抹掉，只剩日志里的 ctx.rebase。
        const meta =
          markMeta && message.role === "assistant" && unseen
            ? { ...message.meta, rebased: true, unseenOrdinals: unseen }
            : message.meta;
        const tokenCount = message.tokens ?? 0;
        insert.run({
          key: this.key,
          ordinal,
          id: message.id,
          turnId,
          role: message.role,
          origin: message.origin,
          pruneLevel: message.pruneLevel ?? 0,
          parts: JSON.stringify(message.parts),
          textPreview: message.textPreview ?? null,
          speaker: message.speaker ?? null,
          speakerUserId: message.speakerUserId ?? null,
          sourceMessageId: message.sourceMessageId ?? null,
          sourceTs: message.sourceTs ?? null,
          tokens: tokenCount,
          meta: meta ? JSON.stringify(meta) : null,
          createdAt: Date.now(),
        });
      }
      const id = ulid();
      const seq = this.nextSeq();
      const windowStart = head?.windowStart ?? start;
      const totals = this.effectiveStats(windowStart, ordinal);
      this.db
        .prepare(
          `INSERT INTO context_commits(id,key,seq,parent_id,kind,turn_id,base_commit_id,rebased,rebase_over_json,
        window_start,head_ordinal,tokens_total,msg_count,created_at,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          this.key,
          seq,
          head?.id ?? null,
          "turn",
          turnId,
          baseCommitId,
          rebased ? 1 : 0,
          rebased ? JSON.stringify(skipped.map((entry) => entry.id)) : null,
          windowStart,
          ordinal,
          totals.tokens,
          totals.count,
          Date.now(),
          "system",
        );
      this.setHead(id);
      if (claimThroughMessageId !== undefined)
        this.advanceWatermark(claimThroughMessageId);
      this.db
        .prepare(
          "UPDATE messages SET claimed_by_turn=NULL WHERE claimed_by_turn=?",
        )
        .run(turnId);
      this.db
        .prepare("UPDATE contexts SET next_ordinal=?,updated_at=? WHERE key=?")
        .run(ordinal + 1, Date.now(), this.key);
      return { commit: this.commit(id)!, rebased, from: start, to: ordinal };
    })();
  }

  /**
   * seq 是这张表的插入序号，只能按 MAX(seq) 递推。按 HEAD 递推的话，`/undo` 把 HEAD 退回上一个
   * commit 之后，下一次写入就会撞 `ux_commits_key_seq` —— 撤销过的会话下一条消息直接失败，
   * WebUI 的「回滚到此」也一并 500（docs/02 §7）。commitsAfter / hasResetAfter 要的都是
   * 「插入得比它晚」，与 HEAD 位置无关，因此这个语义对它们也是对的。
   */
  nextSeq(): number {
    return (
      (
        this.db
          .prepare(
            "SELECT COALESCE(MAX(seq),0) AS value FROM context_commits WHERE key=?",
          )
          .get(this.key) as { value: number }
      ).value + 1
    );
  }

  insertControl(
    kind: "reset" | "manual" | "revert" | "prune",
    input: {
      windowStart: number;
      headOrdinal: number;
      parentId?: string | null;
      meta?: unknown;
      createdBy: string;
    },
  ): CommitRow {
    const head = this.head();
    const id = ulid();
    const totals = this.effectiveStats(input.windowStart, input.headOrdinal);
    this.db
      .prepare(
        `INSERT INTO context_commits(id,key,seq,parent_id,kind,window_start,head_ordinal,tokens_total,msg_count,meta_json,created_at,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        this.key,
        this.nextSeq(),
        input.parentId ?? head?.id ?? null,
        kind,
        input.windowStart,
        input.headOrdinal,
        totals.tokens,
        totals.count,
        input.meta ? JSON.stringify(input.meta) : null,
        Date.now(),
        input.createdBy,
      );
    this.setHead(id);
    return this.commit(id)!;
  }

  setHead(commitId: string): void {
    this.db
      .prepare(
        `INSERT INTO refs(key,name,commit_id,updated_at) VALUES (?,'done',?,?)
      ON CONFLICT(key,name) DO UPDATE SET commit_id=excluded.commit_id,updated_at=excluded.updated_at`,
      )
      .run(this.key, commitId, Date.now());
  }

  messages(commit: CommitRow | null): StoredContextMessage[] {
    if (!commit || commit.windowStart > commit.headOrdinal) return [];
    const rows = this.db
      .prepare(
        `SELECT key,ordinal,id,turn_id AS turnId,role,origin,prune_level AS pruneLevel,
      prune_applied AS pruneApplied,parts_json AS parts,text_preview AS textPreview,speaker,speaker_user_id AS speakerUserId,
      source_message_id AS sourceMessageId,source_ts AS sourceTs,tokens,meta_json AS meta,created_at AS createdAt
      FROM context_messages WHERE key=? AND ordinal BETWEEN ? AND ? ORDER BY ordinal`,
      )
      .all(this.key, commit.windowStart, commit.headOrdinal) as Array<
      Omit<StoredContextMessage, "parts" | "meta"> & {
        parts: string;
        meta: string | null;
      }
    >;
    return rows.map((row) => {
      const originalParts = JSON.parse(row.parts) as unknown[];
      const parsedMeta = row.meta
        ? (JSON.parse(row.meta) as Record<string, unknown>)
        : undefined;
      const truncation = parsedMeta?.truncated as
        { chars?: number; tokens?: number } | undefined;
      const parts = row.pruneApplied
        ? originalParts.map((part) => elidePart(part, row.pruneLevel ?? 0))
        : truncation?.chars
          ? truncatePartStrings(originalParts, truncation.chars)
          : originalParts;
      const firstText = originalParts.find(
        (part) =>
          part &&
          typeof part === "object" &&
          "text" in part &&
          typeof part.text === "string",
      );
      const textPreview =
        row.textPreview ??
        (firstText && typeof firstText === "object" && "text" in firstText
          ? String(firstText.text).slice(0, 240)
          : undefined);
      const tokens = truncation?.tokens ?? row.tokens ?? 0;
      const base =
        textPreview === undefined
          ? { ...row, parts, tokens }
          : { ...row, parts, tokens, textPreview };
      if (parsedMeta) return { ...base, meta: parsedMeta };
      const { meta: _, ...withoutMeta } = base;
      return withoutMeta;
    });
  }
  messagesThrough(to: number): StoredContextMessage[] {
    if (to < 1) return [];
    const synthetic: CommitRow = {
      id: "history",
      key: this.key,
      seq: 0,
      parentId: null,
      kind: "manual",
      turnId: null,
      baseCommitId: null,
      rebased: 0,
      rebaseOver: null,
      windowStart: 1,
      headOrdinal: to,
      tokensTotal: 0,
      msgCount: 0,
      meta: null,
      createdAt: 0,
    };
    return this.messages(synthetic);
  }

  commitsAfter(baseId: string | null): CommitRow[] {
    const base = baseId ? this.commit(baseId) : null;
    return this.db
      .prepare(
        `SELECT ${COMMIT_COLUMNS} FROM context_commits WHERE key=? AND seq>? ORDER BY seq`,
      )
      .all(this.key, base?.seq ?? 0) as CommitRow[];
  }

  commits(limit = 100): CommitRow[] {
    return this.db
      .prepare(
        `SELECT ${COMMIT_COLUMNS} FROM context_commits WHERE key=? ORDER BY seq DESC LIMIT ?`,
      )
      .all(this.key, limit) as CommitRow[];
  }

  markPruned(from: number, to: number, level: number): void {
    this.db
      .prepare(
        "UPDATE context_messages SET prune_applied=1 WHERE key=? AND ordinal BETWEEN ? AND ? AND prune_level=?",
      )
      .run(this.key, from, to, level);
  }

  /**
   * 校准系数只用来吸收分词器差异，量级必须被夹住。曾经没有夹：首轮空上下文时 estimated 只有几十
   * （真实输入还含着上万 token 的系统提示词与工具 schema），一次采样就把 ratio 推到 26 —— 之后
   * 每条消息都按 26 倍存 tokens，窗口水位虚高一个数量级，裁剪提前触发（实测 logs/2026-08-16）。
   * 上游必须传可比的两个量（见 `runtime.ts` 的整请求体估算）；这里是最后一道闸。
   */
  updateTokenRatio(real: number, estimated: number, alpha: number): number {
    const context = this.context();
    if (!context || estimated <= 0 || real <= 0)
      return context?.tokenRatio ?? 1;
    const sample = Math.min(4, Math.max(0.25, real / estimated));
    const next = Math.min(
      2,
      Math.max(0.5, alpha * sample + (1 - alpha) * context.tokenRatio),
    );
    this.db
      .prepare("UPDATE contexts SET token_ratio=?,updated_at=? WHERE key=?")
      .run(next, Date.now(), this.key);
    return next;
  }
}

/**
 * 一次性修复：把 `context_messages.tokens` 按当前估算器重算，并把所有 `contexts.token_ratio` 归 1。
 * 旧数据是按当时失控的校准系数（实测最高约 26 倍）存下来的，而 tokens 是持久化的 ——
 * 不重算的话，已经在窗口里的消息会一直按虚高的数字参与裁剪判定，直到 `/new` 或自然滚出窗口为止。
 * `context_commits` 不动（不可变）：它的 `tokens_total` 只用于展示，下一次提交会按 `effectiveStats` 重算。
 */
export function recomputeMessageTokens(db: Sqlite): {
  messages: number;
  contexts: number;
} {
  return db.transaction(() => {
    const rows = db
      .prepare("SELECT key,ordinal,parts_json AS parts FROM context_messages")
      .all() as Array<{ key: string; ordinal: number; parts: string }>;
    const update = db.prepare(
      "UPDATE context_messages SET tokens=? WHERE key=? AND ordinal=?",
    );
    for (const row of rows) {
      let parts: unknown[] = [];
      try {
        parts = JSON.parse(row.parts) as unknown[];
      } catch {
        continue;
      }
      update.run(
        estimateMessageTokens(Array.isArray(parts) ? parts : []),
        row.key,
        row.ordinal,
      );
    }
    const contexts = db
      .prepare(
        "UPDATE contexts SET token_ratio=1,updated_at=? WHERE token_ratio<>1",
      )
      .run(Date.now()).changes;
    return { messages: rows.length, contexts };
  })();
}

export function contextKey(
  input: { chatId: string; messageThreadId: number | null },
  scope: "chat" | "thread",
): string {
  return scope === "thread" && input.messageThreadId !== null
    ? `chat:${input.chatId}:${input.messageThreadId}`
    : `chat:${input.chatId}`;
}

export interface OpenTurnInput {
  turnId: string;
  key: string;
  chatId: string;
  threadId: number | null;
  initiatorUserId: string;
  effectiveRole: Role;
  trigger: ArchivedMessage;
}

/**
 * 硬截断只削减载荷，绝不碰判别字段。`type` 被截掉会让 part 变成 provider 无法识别的形状，
 * 而截断结果会写进 meta_json 并在每次物化时重放，等于会话级永久损坏。
 */
const STRUCTURAL_PART_KEYS = new Set([
  "type",
  "toolCallId",
  "toolName",
  "mediaType",
  "filename",
  "providerExecuted",
  "state",
]);

/** 非文本 part（图片、文件引用）的载荷必须保持良构：截一半的 data URI 与截掉 type 一样会被 provider 拒绝。 */
const OPAQUE_PART_TYPES = new Set(["image", "file", "image_url"]);

function truncatePartStrings(parts: unknown[], maxChars: number): unknown[] {
  let remaining = maxChars;
  const visit = (value: unknown): unknown => {
    if (typeof value === "string") {
      const chars = [...value];
      if (chars.length <= remaining) {
        remaining -= chars.length;
        return value;
      }
      const output = `${chars.slice(0, Math.max(0, remaining)).join("")}…[已硬截断]`;
      remaining = 0;
      return output;
    }
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [
          key,
          STRUCTURAL_PART_KEYS.has(key) ? child : visit(child),
        ]),
      );
    return value;
  };
  return parts.map((part) => {
    const type =
      part && typeof part === "object"
        ? (part as { type?: unknown }).type
        : undefined;
    // 不透明 part 要么原样保留，要么整体换成占位文本——绝不半截。
    if (typeof type === "string" && OPAQUE_PART_TYPES.has(type))
      return remaining > 0
        ? part
        : { type: "text", text: "[附件已因上下文超限省略]" };
    return visit(part);
  });
}
