import type { Role } from "@luoli/shared";
import type { Sqlite } from "./database.js";

export interface Principal {
  id: string;
  kind: "user" | "chat";
  tgId: string;
  role: Role;
  displayName: string | null;
  username: string | null;
  chatType: string | null;
}

export class PrincipalRepository {
  constructor(private readonly db: Sqlite) {}

  roleOf(kind: "user" | "chat", tgId: string): Role | null {
    const row = this.db
      .prepare("SELECT role FROM principals WHERE kind = ? AND tg_id = ?")
      .get(kind, tgId) as { role: Role } | undefined;
    return row?.role ?? null;
  }

  upsertSeen(input: Principal, updatedBy = "bootstrap"): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO principals(id,kind,tg_id,role,display_name,username,chat_type,first_seen_at,updated_at,updated_by)
      VALUES (@id,@kind,@tgId,@role,@displayName,@username,@chatType,@now,@now,@updatedBy)
      ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name, username=excluded.username,
      chat_type=excluded.chat_type, updated_at=excluded.updated_at`,
      )
      .run({ ...input, now, updatedBy });
  }

  /**
   * 引导 owner 每次启动都要存在，但显示名与用户名只能由 Telegram 那边写进来：
   * 走 upsertSeen 的话 ON CONFLICT 会拿占位的 'Owner'/null 覆盖真名，重启一次主体页就打回占位符。
   * 已存在的行一律不动（含 role）—— 与 upsertSeen 一致，不把手工改过的角色冲掉。
   */
  ensureOwner(tgId: string): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO principals(id,kind,tg_id,role,display_name,username,chat_type,first_seen_at,updated_at,updated_by)
      VALUES (?,'user',?,'owner','Owner',NULL,NULL,?,?,'bootstrap') ON CONFLICT(id) DO NOTHING`,
      )
      .run(`user:${tgId}`, tgId, now, now);
  }

  setRole(id: string, role: Role, actor: string): boolean {
    return (
      this.db
        .prepare(
          "UPDATE principals SET role=?, updated_at=?, updated_by=? WHERE id=?",
        )
        .run(role, Date.now(), actor, id).changes === 1
    );
  }

  has(id: string): boolean {
    return (
      this.db.prepare("SELECT 1 FROM principals WHERE id=?").pluck().get(id) !==
      undefined
    );
  }

  list(): Principal[] {
    return this.db
      .prepare(
        "SELECT id,kind,tg_id AS tgId,role,display_name AS displayName,username,chat_type AS chatType FROM principals ORDER BY updated_at DESC",
      )
      .all() as Principal[];
  }
}
