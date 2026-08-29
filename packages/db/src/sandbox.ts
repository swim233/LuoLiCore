import type { Sqlite } from "./database.js";

export interface SandboxContainer {
  chatId: string;
  name: string;
  containerId: string | null;
  image: string;
  specHash: string;
  hasSetsid: number;
  createdAt: number;
  lastUsedAt: number;
  expiresAt: number;
  /** `sandbox.persistent.maxLifetimeMs` 为 0 时取 null：0 统一表示不设上限（docs/11）。 */
  hardExpiresAt: number | null;
  pinned: number;
  execCount: number;
  lastError: string | null;
}

export interface NewSandboxContainer {
  chatId: string;
  name: string;
  containerId: string | null;
  image: string;
  specHash: string;
  hasSetsid: boolean;
  expiresAt: number;
  hardExpiresAt: number | null;
}

const COLUMNS = `chat_id AS chatId,name,container_id AS containerId,image,spec_hash AS specHash,has_setsid AS hasSetsid,
  created_at AS createdAt,last_used_at AS lastUsedAt,expires_at AS expiresAt,hard_expires_at AS hardExpiresAt,
  pinned,exec_count AS execCount,last_error AS lastError`;

/**
 * `sandbox_containers` 的唯一访问入口。
 *
 * 与 `ScopedArchiveRepository` / `ScheduleRepository` 形状一致：逐会话的方法都要求传入 `chatId`，
 * 且谓词以字面量写在 SQL 中（`tests/db.isolation.test.ts` 扫描的是源码里的 SQL 字面量，
 * 藏进模板变量后无法检出）。跨会话的三个方法（`list` / `dueFor` / `staleSpec`）专供回收与运维面板：
 * 容器管理工具整族为 owner-only，其用途本身就是跨会话运维（docs/05 §3.11）。
 */
export class SandboxContainerRepository {
  constructor(private readonly db: Sqlite) {}

  create(input: NewSandboxContainer): SandboxContainer {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO sandbox_containers(chat_id,name,container_id,image,spec_hash,has_setsid,created_at,last_used_at,expires_at,hard_expires_at)
      VALUES (@chatId,@name,@containerId,@image,@specHash,@hasSetsid,@now,@now,@expiresAt,@hardExpiresAt)`,
      )
      .run({ ...input, hasSetsid: input.hasSetsid ? 1 : 0, now });
    return this.byChat(input.chatId)!;
  }

  byChat(chatId: string): SandboxContainer | null {
    return (
      (this.db
        .prepare(`SELECT ${COLUMNS} FROM sandbox_containers WHERE chat_id=?`)
        .get(chatId) as SandboxContainer | undefined) ?? null
    );
  }

  /** 跨会话查询：用于回收对账与 `container_list` / WebUI 面板。 */
  list(): SandboxContainer[] {
    return this.db
      .prepare(
        `SELECT ${COLUMNS} FROM sandbox_containers ORDER BY last_used_at DESC`,
      )
      .all() as SandboxContainer[];
  }

  count(): number {
    return this.db
      .prepare("SELECT COUNT(*) FROM sandbox_containers")
      .pluck()
      .get() as number;
  }

  /**
   * 一次执行后推进滑动到期时间。`hard_expires_at` 不变：绝对上限自创建时刻起算，不因活跃而延长，
   * 否则它就不成其为上限（docs/05 §5.5）。
   */
  touch(chatId: string, expiresAt: number): void {
    this.db
      .prepare(
        "UPDATE sandbox_containers SET last_used_at=?,expires_at=?,exec_count=exec_count+1 WHERE chat_id=?",
      )
      .run(Date.now(), expiresAt, chatId);
  }

  /** `container_keep`：修改到期时刻或设置钉住，两者可分别单独传入。 */
  keep(
    chatId: string,
    patch: { expiresAt?: number; pinned?: boolean },
  ): boolean {
    const current = this.byChat(chatId);
    if (!current) return false;
    this.db
      .prepare(
        "UPDATE sandbox_containers SET expires_at=?,pinned=? WHERE chat_id=?",
      )
      .run(
        patch.expiresAt ?? current.expiresAt,
        (patch.pinned ?? current.pinned !== 0) ? 1 : 0,
        chatId,
      );
    return true;
  }

  noteError(chatId: string, error: string | null): void {
    this.db
      .prepare("UPDATE sandbox_containers SET last_error=? WHERE chat_id=?")
      .run(error, chatId);
  }

  remove(chatId: string): boolean {
    return (
      this.db
        .prepare("DELETE FROM sandbox_containers WHERE chat_id=?")
        .run(chatId).changes > 0
    );
  }
}
