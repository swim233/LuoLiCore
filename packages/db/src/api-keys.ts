import type { Sqlite } from "./database.js";

export interface ApiKeyRow {
  id: string;
  sourceId: string;
  secretEnc: string;
  label: string | null;
  createdAt: number;
  expiresAt: number | null;
  disabledAt: number | null;
  lastUsedAt: number | null;
  /** 所属来源的停用时间，供校验逻辑（T3.3）把「来源已停用」与「密钥本身停用」分开判断。 */
  sourceDisabledAt: number | null;
}

export interface NewApiKey {
  id: string;
  sourceId: string;
  secretEnc: string;
  label?: string | null;
  expiresAt?: number | null;
}

const ROW_COLUMNS = `k.id,k.source_id AS sourceId,k.secret_enc AS secretEnc,k.label,
  k.created_at AS createdAt,k.expires_at AS expiresAt,k.disabled_at AS disabledAt,
  k.last_used_at AS lastUsedAt,s.disabled_at AS sourceDisabledAt`;
const LIST_COLUMNS = `k.id,k.source_id AS sourceId,k.label,k.created_at AS createdAt,
  k.expires_at AS expiresAt,k.disabled_at AS disabledAt,k.last_used_at AS lastUsedAt,
  s.disabled_at AS sourceDisabledAt`;
const FROM = "FROM api_keys k JOIN sources s ON s.id=k.source_id";

/**
 * `api_keys` 的唯一访问入口（docs/12-sdk.md T3.2）。密钥的生成、解密、`timingSafeEqual`
 * 校验不在此层——那些是 T3.3 的职责，这里只管落库与查询。
 */
export class ApiKeyRepository {
  constructor(private readonly db: Sqlite) {}

  /** `source_id` 外键在 `foreign_keys=ON` 下强制：来源不存在时插入抛外键错误，不静默失败。 */
  insert(input: NewApiKey): ApiKeyRow {
    this.db
      .prepare(
        `INSERT INTO api_keys(id,source_id,secret_enc,label,created_at,expires_at)
        VALUES (@id,@sourceId,@secretEnc,@label,@createdAt,@expiresAt)`,
      )
      .run({
        id: input.id,
        sourceId: input.sourceId,
        secretEnc: input.secretEnc,
        label: input.label ?? null,
        createdAt: Date.now(),
        expiresAt: input.expiresAt ?? null,
      });
    return this.get(input.id)!;
  }

  get(id: string): ApiKeyRow | null {
    return (
      (this.db.prepare(`SELECT ${ROW_COLUMNS} ${FROM} WHERE k.id=?`).get(id) as
        ApiKeyRow | undefined) ?? null
    );
  }

  /** 不返回 `secret_enc`：列表用于展示，密文没有展示价值，只会增加泄漏面。 */
  listBySource(sourceId: string): Array<Omit<ApiKeyRow, "secretEnc">> {
    if (!sourceId) throw new Error("api_key_scope_required");
    return this.db
      .prepare(
        `SELECT ${LIST_COLUMNS} ${FROM} WHERE k.source_id=? ORDER BY k.created_at DESC`,
      )
      .all(sourceId) as Array<Omit<ApiKeyRow, "secretEnc">>;
  }

  /** 软停用，留行。已停用的再次调用保持幂等，不覆盖原时间戳。 */
  disable(id: string): boolean {
    return (
      this.db
        .prepare(
          "UPDATE api_keys SET disabled_at=COALESCE(disabled_at,?) WHERE id=?",
        )
        .run(Date.now(), id).changes === 1
    );
  }

  touchLastUsed(id: string, ts: number): void {
    this.db
      .prepare("UPDATE api_keys SET last_used_at=? WHERE id=?")
      .run(ts, id);
  }
}
