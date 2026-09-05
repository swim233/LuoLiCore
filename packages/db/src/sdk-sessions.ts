import { randomUUID } from "node:crypto";
import { contextKey } from "./context.js";
import type { Sqlite } from "./database.js";

export interface SdkSessionRow {
  /** `contexts.key` / `sdk_sessions.key` 的原始形态（`chat:<uuid>`），不是对外的 `chatId`。 */
  key: string;
  /** 创建时分配的 uuid，跨来源全局唯一（docs/12-sdk.md 已定结论 3）。 */
  chatId: string;
  sourceId: string;
  outputFormat: "plain" | "markdown";
  label: string | null;
  createdAt: number;
  /** 非空即已软停用（SDK 会话动词 `delete`）。 */
  deletedAt: number | null;
}

export interface NewSdkSession {
  label?: string | null;
  outputFormat?: "plain" | "markdown";
}

export interface SdkSessionPatch {
  label?: string | null;
}

export interface SdkSessionPage {
  items: SdkSessionRow[];
  /** 还有下一页时非 null；把它原样传回 `listBySource` 的 `cursor` 继续翻页。 */
  nextCursor: string | null;
}

export interface SdkSessionPurgeResult {
  key: string;
  chatId: string;
  sourceId: string;
  /**
   * 该会话 primemory 文档的磁盘路径。db 层不碰文件系统——磁盘删除由调用方完成，
   * 见 `packages/core/src/memory/purge.ts` 的 `purgeSdkSession()`。
   */
  memoryDocPaths: string[];
}

const ROW_COLUMNS = `s.key,c.chat_id AS chatId,c.source_id AS sourceId,s.output_format AS outputFormat,
  s.label,s.created_at AS createdAt,c.deleted_at AS deletedAt`;
const FROM = "FROM sdk_sessions s JOIN contexts c ON c.key=s.key";

/** 分页游标：`(created_at, key)` 的 keyset，避免 OFFSET 分页在并发插入下的漂移/重复。 */
function decodeCursor(
  cursor: string,
): { createdAt: number; key: string } | null {
  try {
    const [createdAt, key] = Buffer.from(cursor, "base64url")
      .toString("utf8")
      .split(" ");
    const value = Number(createdAt);
    return key && Number.isFinite(value) ? { createdAt: value, key } : null;
  } catch {
    // 调用方传入的游标已损坏或被篡改：按「无游标」处理，从头翻页，而不是抛错中断列表请求。
    return null;
  }
}
function encodeCursor(row: { createdAt: number; key: string }): string {
  return Buffer.from(`${row.createdAt} ${row.key}`, "utf8").toString(
    "base64url",
  );
}

/**
 * TypeScript 的必填参数在编译期挡住「不传 key 就列全部」的调用形状，但类型在运行时会被擦除——
 * 一次绕过类型检查的调用（JS 调用方、`as any`）不该退化成「查询条件恒真」。空字符串同样拒绝：
 * SQL 里 `key=''` 不会匹配任何真实行，看起来「安全」，但那只是这批测试数据的巧合。
 */
function requireScope(sourceId: string, key: string): void {
  if (!sourceId || !key) throw new Error("sdk_session_scope_required");
}

/**
 * SDK 会话（`sdk_sessions` 叠加在 `contexts` 之上）的唯一访问入口（docs/12-sdk.md T3.2）。
 *
 * 逐会话方法一律要求同时传入 `sourceId` 与 `key`（形状同 `ScopedArchiveRepository` 的
 * `chatId`/`threadId`），跨来源隔离靠 SQL 的 `source_id=?` 过滤强制，不靠应用层判断——
 * 漏一次过滤就是跨来源读到、改到或删掉别的接入方的会话。
 *
 * `key` 是 `contexts.key`（`chat:<uuid>`），不是对外暴露的 `chatId`：上层（`/sdk/v1/*`）
 * 若以裸 uuid 作 URL 段，调用前用 `contextKey({chatId, messageThreadId: null}, "chat")` 换算。
 */
export class SdkSessionRepository {
  constructor(private readonly db: Sqlite) {}

  /**
   * 一个事务内建 `contexts` 行（`chat_id` 为新分配的 uuid，与 `ContextEngine.ensure()` 同样的
   * 默认列取值，仅显式写入 `source_id`）与 `sdk_sessions` 行。`chat_id` 用 `randomUUID()`
   * 而非 `ulid()`——plan 已定结论 3 点名的是 uuid，与 `sources.create()` 的 ulid 是两回事。
   */
  createSession(sourceId: string, input: NewSdkSession = {}): SdkSessionRow {
    const chatId = randomUUID();
    const key = contextKey({ chatId, messageThreadId: null }, "chat");
    const now = Date.now();
    const outputFormat = input.outputFormat ?? "markdown";
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO contexts(key,chat_id,thread_id,scope,source_id,created_at,updated_at)
          VALUES (?,?,NULL,'chat',?,?,?)`,
        )
        .run(key, chatId, sourceId, now, now);
      this.db
        .prepare(
          `INSERT INTO sdk_sessions(key,output_format,label,created_at) VALUES (?,?,?,?)`,
        )
        .run(key, outputFormat, input.label ?? null, now);
    })();
    return this.getBySource(sourceId, key)!;
  }

  /** 按来源分页列出未软删的会话，`created_at,key` 升序（游标向后翻页）。 */
  listBySource(
    sourceId: string,
    options: { cursor?: string | null; limit?: number } = {},
  ): SdkSessionPage {
    if (!sourceId) throw new Error("sdk_session_scope_required");
    const limit = Math.max(1, Math.min(200, options.limit ?? 50));
    const cursor = options.cursor ? decodeCursor(options.cursor) : null;
    const rows = this.db
      .prepare(
        `SELECT ${ROW_COLUMNS} ${FROM}
        WHERE c.source_id=@sourceId AND c.deleted_at IS NULL
          AND (@hasCursor=0 OR s.created_at>@createdAt OR (s.created_at=@createdAt AND s.key>@key))
        ORDER BY s.created_at,s.key LIMIT @fetchLimit`,
      )
      .all({
        sourceId,
        hasCursor: cursor ? 1 : 0,
        createdAt: cursor?.createdAt ?? 0,
        key: cursor?.key ?? "",
        // 多取一行以判断是否还有下一页，返回前裁掉。
        fetchLimit: limit + 1,
      }) as SdkSessionRow[];
    const items = rows.slice(0, limit);
    const nextCursor =
      rows.length > limit ? encodeCursor(items[items.length - 1]!) : null;
    return { items, nextCursor };
  }

  /** 跨来源返回 null，不区分「不存在」与「属于别的来源」——不泄漏存在性。 */
  getBySource(sourceId: string, key: string): SdkSessionRow | null {
    requireScope(sourceId, key);
    return (
      (this.db
        .prepare(
          `SELECT ${ROW_COLUMNS} ${FROM} WHERE c.source_id=? AND s.key=?`,
        )
        .get(sourceId, key) as SdkSessionRow | undefined) ?? null
    );
  }

  /**
   * 软停用：置 `contexts.deleted_at`。跨来源不生效（`source_id` 过滤在 WHERE 里），
   * changes=0 时调用方应按「不存在」处理，不暴露该会话其实属于别的来源。
   * 已停用的再次调用保持幂等，不覆盖原时间戳，但仍匹配到行、返回 true。
   */
  softDelete(sourceId: string, key: string): boolean {
    requireScope(sourceId, key);
    return (
      this.db
        .prepare(
          "UPDATE contexts SET deleted_at=COALESCE(deleted_at,?) WHERE key=? AND source_id=?",
        )
        .run(Date.now(), key, sourceId).changes === 1
    );
  }

  /** 目前只有 `label` 可改——`modelAlias` 落 `app_kv`，不在 `sdk_sessions` 这张表上。 */
  update(
    sourceId: string,
    key: string,
    patch: SdkSessionPatch,
  ): SdkSessionRow | null {
    requireScope(sourceId, key);
    if (patch.label === undefined) return this.getBySource(sourceId, key);
    const changed = this.db
      .prepare(
        `UPDATE sdk_sessions SET label=@label WHERE key=@key
        AND EXISTS (SELECT 1 FROM contexts c WHERE c.key=sdk_sessions.key AND c.source_id=@sourceId)`,
      )
      .run({ label: patch.label, key, sourceId }).changes;
    return changed === 1 ? this.getBySource(sourceId, key) : null;
  }

  /**
   * 硬删除面（docs/12-sdk.md T3.2），按外键顺序、一个事务内完成：
   * `sdk_sessions` → `memory_revisions`（该会话 primemory 行）→ `memory_docs` 行（磁盘文件由
   * 调用方删，见 `packages/core` 的 `purgeSdkSession()`）→ `messages`（FTS 触发器自动跟随）→
   * `turns` → `context_messages`/`context_commits`/`refs` → `contexts`。
   * 保留 `usage_ledger` / `agent_runs` / `approvals` / 日志。跨来源返回 null，不执行任何删除、
   * 不泄漏该会话其实属于别的来源。
   *
   * primemory 的 doc id 现算而非现查：`memoryScopeSubjects(sourceId, chatId).primemory` 的
   * 复合键格式是 `<sourceId>:<chatId>`（SDK 会话的「会话」即 chatId 本身，
   * `packages/core/src/memory/scope.ts` 文档已定），`MemoryStore` 内部据此拼出
   * `primemory:<sourceId>:<chatId>` 作为 `memory_docs.id`——两处算法必须一致，
   * 否则这里删的和实际写入的不是同一行。
   */
  purge(sourceId: string, key: string): SdkSessionPurgeResult | null {
    requireScope(sourceId, key);
    return this.db.transaction((): SdkSessionPurgeResult | null => {
      const context = this.db
        .prepare(
          "SELECT chat_id AS chatId, source_id AS sourceId FROM contexts WHERE key=?",
        )
        .get(key) as { chatId: string; sourceId: string } | undefined;
      if (!context || context.sourceId !== sourceId) return null;
      this.db.prepare("DELETE FROM sdk_sessions WHERE key=?").run(key);
      const docId = `primemory:${sourceId}:${context.chatId}`;
      this.db.prepare("DELETE FROM memory_revisions WHERE doc_id=?").run(docId);
      const paths = this.db
        .prepare("SELECT path FROM memory_docs WHERE id=?")
        .all(docId) as Array<{ path: string }>;
      this.db.prepare("DELETE FROM memory_docs WHERE id=?").run(docId);
      this.db
        .prepare("DELETE FROM messages WHERE chat_id=?")
        .run(context.chatId);
      this.db.prepare("DELETE FROM turns WHERE key=?").run(key);
      this.db.prepare("DELETE FROM context_messages WHERE key=?").run(key);
      this.db.prepare("DELETE FROM context_commits WHERE key=?").run(key);
      this.db.prepare("DELETE FROM refs WHERE key=?").run(key);
      this.db.prepare("DELETE FROM contexts WHERE key=?").run(key);
      return {
        key,
        chatId: context.chatId,
        sourceId,
        memoryDocPaths: paths.map((row) => row.path),
      };
    })();
  }
}
