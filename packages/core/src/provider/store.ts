import { randomBytes, randomInt } from "node:crypto";
import type { Sqlite } from "@luoli/db";
import { Secrets } from "../secrets.js";

export interface ProviderInput {
  id?: string;
  name: string;
  kind: string;
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}

export class ProviderStore {
  constructor(
    private readonly db: Sqlite,
    private readonly secrets: Secrets,
  ) {}

  save(input: ProviderInput): string {
    const id = input.id ?? randomBytes(16).toString("hex");
    const current = this.db
      .prepare(
        "SELECT api_key_enc AS encrypted,api_key_hint AS hint FROM providers WHERE id=?",
      )
      .get(id) as { encrypted: string | null; hint: string | null } | undefined;
    let encrypted = current?.encrypted ?? null;
    let hint = current?.hint ?? null;
    if (input.apiKey) {
      if (!this.secrets.available)
        throw new Error("LUOLI_MASTER_KEY is unavailable");
      encrypted = this.secrets.encrypt(input.apiKey);
      hint = input.apiKey.length > 4 ? `…${input.apiKey.slice(-4)}` : "set";
    }
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO providers(id,name,kind,base_url,api_key_enc,api_key_hint,headers_json,enabled,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind,base_url=excluded.base_url,
      api_key_enc=excluded.api_key_enc,api_key_hint=excluded.api_key_hint,headers_json=excluded.headers_json,enabled=excluded.enabled,updated_at=excluded.updated_at`,
      )
      .run(
        id,
        input.name,
        input.kind,
        input.baseUrl ?? null,
        encrypted,
        hint,
        input.headers ? JSON.stringify(input.headers) : null,
        input.enabled === false ? 0 : 1,
        now,
        now,
      );
    return id;
  }

  list(): unknown[] {
    return this.db
      .prepare(
        "SELECT id,name,kind,base_url AS baseUrl,api_key_hint AS apiKeyHint,enabled,health_state AS healthState,health_error AS healthError FROM providers ORDER BY name",
      )
      .all();
  }

  /** `includeDisabled` 只给「测试连接」用：停用的 provider 也要能在启用前先探一次。 */
  key(id: string, includeDisabled = false): string | null {
    const row = this.db
      .prepare(
        `SELECT api_key_enc AS encrypted FROM providers WHERE id=?${includeDisabled ? "" : " AND enabled=1"}`,
      )
      .get(id) as { encrypted: string | null } | undefined;
    if (!row?.encrypted) return null;
    const plaintext = this.secrets.decrypt(row.encrypted);
    // 读到弱派生的历史密文就地升级到 v2（docs/20 · W-SEC-02）。不需要迁移脚本，也不影响本次调用。
    if (Secrets.isLegacy(row.encrypted))
      this.db
        .prepare("UPDATE providers SET api_key_enc=? WHERE id=?")
        .run(this.secrets.encrypt(plaintext), id);
    return plaintext;
  }
  allDecryptedKeys(): string[] {
    if (!this.secrets.available) return [];
    const rows = this.db
      .prepare(
        "SELECT api_key_enc AS encrypted FROM providers WHERE api_key_enc IS NOT NULL",
      )
      .all() as Array<{ encrypted: string }>;
    return rows.flatMap((row) => {
      try {
        return [this.secrets.decrypt(row.encrypted)];
      } catch {
        return [];
      }
    });
  }

  get secretsAvailable(): boolean {
    return this.secrets.available;
  }
}

/**
 * 抖动必须是真随机：`sha256(attempt)` 对同一个 attempt 是常量，所有并发请求会退避到同一时刻
 * 再一起打过去，等于没有抖动（docs/20 · W-PROV-01）。
 */
export function retryDelay(
  attempt: number,
  retryAfterMs: number | null,
  baseMs: number,
  maxMs: number,
): number {
  if (retryAfterMs !== null) return Math.min(retryAfterMs, maxMs);
  const jitter = randomInt(0, 10_000) / 10_000;
  return Math.min(baseMs * 2 ** attempt * (0.8 + jitter * 0.4), maxMs);
}

/**
 * 退避必须可中断：轮次被取消或整轮超时之后还躺在 setTimeout 里，等于替一个没人等的轮次占着槽位。
 *
 * **监听器要摘。** `{ once: true }` 只在真的 abort 时自摘，而正常退避走完（绝大多数情况）监听器
 * 会留在**轮次**那个信号上 —— 一轮里几十次重试就是几十个永不触发的监听器，直到轮次结束
 * （docs/27 · R-07）。同 `net/outbound.ts` 的 `abortable`。
 */
export async function abortablePause(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted)
    throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
  let onAbort: (() => void) | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      onAbort = (): void => {
        clearTimeout(timer);
        reject(
          signal!.reason instanceof Error
            ? signal!.reason
            : new Error("aborted"),
        );
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  } finally {
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}
