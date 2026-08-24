import type { Sqlite } from "./database.js";

/**
 * `mcp_auth` 的唯一访问入口（裸 SQL 不出 `packages/db`，docs/00 §2.1 D-01）。
 *
 * 加解密由调用方注入：`Secrets` 住在 `packages/core`，而依赖方向是 `shared → db → core`，
 * 这里 import 它就成了反向依赖。接口只要两个方法，`ProviderStore` 用的也是同一个 `Secrets`。
 */
export interface SecretCodec {
  readonly available: boolean;
  encrypt(value: string): string;
  decrypt(value: string): string;
}

export type McpAuthMode = "bearer" | "oauth";

/** 界面与 API 拿到的那一份：**没有任何密文**，也不含 verifier 与 discovery。 */
export interface McpAuthPublic {
  server: string;
  mode: McpAuthMode;
  scope: string | null;
  /** bearer 的末 4 位。oauth 没有可显示的片段，恒为 null。 */
  hint: string | null;
  expiresAt: number | null;
  authorizedAt: number | null;
  /** 有没有一份能用的凭据。oauth 下为 false 表示「登记了但还没授权」。 */
  authorized: boolean;
  version: number;
  updatedAt: number;
}

interface Row {
  server: string;
  mode: McpAuthMode;
  secretEnc: string | null;
  clientEnc: string | null;
  verifierEnc: string | null;
  discoveryJson: string | null;
  scope: string | null;
  hint: string | null;
  expiresAt: number | null;
  authorizedAt: number | null;
  version: number;
  updatedAt: number;
}

/** `#write` 的入参。`'key' in patch` 才算「要改这一列」，所以显式的 `null` 与「不动」是两回事。 */
type AuthPatch = Partial<{
  secretEnc: string | null;
  clientEnc: string | null;
  verifierEnc: string | null;
  discoveryJson: string | null;
  scope: string | null;
  hint: string | null;
  expiresAt: number | null;
  authorizedAt: number | null;
}>;

const COLUMNS = `server,mode,secret_enc AS secretEnc,client_enc AS clientEnc,verifier_enc AS verifierEnc,
  discovery_json AS discoveryJson,scope,hint,expires_at AS expiresAt,authorized_at AS authorizedAt,
  version,updated_at AS updatedAt`;

/** 末 4 位。太短的 token 一个字符都不给 —— 露出「全部」等于没脱敏。 */
function hintOf(token: string): string | null {
  return token.length >= 8 ? token.slice(-4) : null;
}

export class McpAuthRepository {
  constructor(
    private readonly db: Sqlite,
    private readonly secrets: SecretCodec,
  ) {}

  #row(server: string): Row | null {
    return (
      (this.db
        .prepare(`SELECT ${COLUMNS} FROM mcp_auth WHERE server=?`)
        .get(server) as Row | undefined) ?? null
    );
  }

  #publicOf(row: Row): McpAuthPublic {
    const { secretEnc, clientEnc, verifierEnc, discoveryJson, ...rest } = row;
    void clientEnc;
    void verifierEnc;
    void discoveryJson;
    return { ...rest, authorized: secretEnc !== null };
  }

  get(server: string): McpAuthPublic | null {
    const row = this.#row(server);
    return row ? this.#publicOf(row) : null;
  }

  list(): McpAuthPublic[] {
    return (
      this.db
        .prepare(`SELECT ${COLUMNS} FROM mcp_auth ORDER BY server`)
        .all() as Row[]
    ).map((row) => this.#publicOf(row));
  }

  /**
   * 「凭据现在是第几版」—— 进 `McpManager` 的连接指纹。没有行时是 0，所以「从没配过」与
   * 「配过第一版」在指纹上分得开。
   */
  version(server: string): number {
    return (
      (this.db
        .prepare("SELECT version FROM mcp_auth WHERE server=?")
        .pluck()
        .get(server) as number | undefined) ?? 0
    );
  }

  /** 一次写入把 `version` 推一格。所有写路径都走这里，漏一条就等于漏一次强制重连。 */
  #write(server: string, mode: McpAuthMode, patch: AuthPatch): void {
    const existing = this.#row(server);
    const now = Date.now();
    const merged = {
      server,
      mode,
      now,
      secretEnc:
        "secretEnc" in patch ? patch.secretEnc : (existing?.secretEnc ?? null),
      clientEnc:
        "clientEnc" in patch ? patch.clientEnc : (existing?.clientEnc ?? null),
      verifierEnc:
        "verifierEnc" in patch
          ? patch.verifierEnc
          : (existing?.verifierEnc ?? null),
      discoveryJson:
        "discoveryJson" in patch
          ? patch.discoveryJson
          : (existing?.discoveryJson ?? null),
      scope: "scope" in patch ? patch.scope : (existing?.scope ?? null),
      hint: "hint" in patch ? patch.hint : (existing?.hint ?? null),
      expiresAt:
        "expiresAt" in patch ? patch.expiresAt : (existing?.expiresAt ?? null),
      authorizedAt:
        "authorizedAt" in patch
          ? patch.authorizedAt
          : (existing?.authorizedAt ?? null),
    };
    this.db
      .prepare(
        `INSERT INTO mcp_auth(server,mode,secret_enc,client_enc,verifier_enc,discovery_json,scope,hint,expires_at,authorized_at,version,updated_at)
      VALUES (@server,@mode,@secretEnc,@clientEnc,@verifierEnc,@discoveryJson,@scope,@hint,@expiresAt,@authorizedAt,1,@now)
      ON CONFLICT(server) DO UPDATE SET mode=excluded.mode,secret_enc=excluded.secret_enc,client_enc=excluded.client_enc,
        verifier_enc=excluded.verifier_enc,discovery_json=excluded.discovery_json,scope=excluded.scope,hint=excluded.hint,
        expires_at=excluded.expires_at,authorized_at=excluded.authorized_at,version=mcp_auth.version+1,updated_at=excluded.updated_at`,
      )
      .run(merged);
  }

  /** 静态 bearer token。写入即加密，此后任何读路径都不回明文（除了 `bearerToken()`）。 */
  setBearer(server: string, token: string): void {
    this.#write(server, "bearer", {
      secretEnc: this.secrets.encrypt(token),
      hint: hintOf(token),
      authorizedAt: Date.now(),
      expiresAt: null,
      clientEnc: null,
      verifierEnc: null,
      discoveryJson: null,
      scope: null,
    });
  }

  /** 连接时取。解不开就当没有 —— 换过 `LUOLI_MASTER_KEY` 的部署应该看到「要登录」而不是崩在握手里。 */
  bearerToken(server: string): string | null {
    const row = this.#row(server);
    if (!row || row.mode !== "bearer" || !row.secretEnc) return null;
    try {
      return this.secrets.decrypt(row.secretEnc);
    } catch {
      return null;
    }
  }

  /** OAuth：把这台 server 登记成 oauth 模式（还没有任何 token）。 */
  ensureOAuth(server: string, scope: string | null): void {
    const row = this.#row(server);
    if (row?.mode === "oauth") return;
    this.#write(server, "oauth", {
      scope,
      secretEnc: null,
      hint: null,
      authorizedAt: null,
      expiresAt: null,
    });
  }

  readTokens(server: string): unknown | null {
    return this.#decodeJson(this.#row(server)?.secretEnc ?? null);
  }

  writeTokens(
    server: string,
    tokens: unknown,
    expiresAt: number | null,
    scope: string | null,
  ): void {
    this.#write(server, "oauth", {
      secretEnc: this.secrets.encrypt(JSON.stringify(tokens)),
      expiresAt,
      authorizedAt: Date.now(),
      scope,
      hint: null,
    });
  }

  readClient(server: string): unknown | null {
    return this.#decodeJson(this.#row(server)?.clientEnc ?? null);
  }

  writeClient(server: string, client: unknown): void {
    this.#write(server, "oauth", {
      clientEnc: this.secrets.encrypt(JSON.stringify(client)),
    });
  }

  readVerifier(server: string): string | null {
    const encrypted = this.#row(server)?.verifierEnc ?? null;
    if (!encrypted) return null;
    try {
      return this.secrets.decrypt(encrypted);
    } catch {
      return null;
    }
  }

  writeVerifier(server: string, verifier: string): void {
    this.#write(server, "oauth", {
      verifierEnc: this.secrets.encrypt(verifier),
    });
  }

  readDiscovery(server: string): unknown | null {
    const raw = this.#row(server)?.discoveryJson ?? null;
    if (!raw) return null;
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }

  writeDiscovery(server: string, state: unknown): void {
    this.#write(server, "oauth", { discoveryJson: JSON.stringify(state) });
  }

  /**
   * 按 scope 作废。`'all'` 保留那一行（`mode` 还有用：界面要能区分「这台用 OAuth 但没登录」
   * 与「这台压根不需要登录」），只把凭据清空并推高 `version` —— 于是下一次 reconcile 必然重连。
   */
  invalidate(
    server: string,
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): void {
    const row = this.#row(server);
    if (!row) return;
    const patch: AuthPatch =
      scope === "all"
        ? {
            secretEnc: null,
            clientEnc: null,
            verifierEnc: null,
            discoveryJson: null,
            hint: null,
            expiresAt: null,
            authorizedAt: null,
          }
        : scope === "client"
          ? { clientEnc: null }
          : scope === "tokens"
            ? {
                secretEnc: null,
                hint: null,
                expiresAt: null,
                authorizedAt: null,
              }
            : scope === "verifier"
              ? { verifierEnc: null }
              : { discoveryJson: null };
    this.#write(server, row.mode, patch);
  }

  /** 整行删掉：`auth.mode` 改回 `none` 或 server 被删时用。 */
  remove(server: string): boolean {
    return (
      this.db.prepare("DELETE FROM mcp_auth WHERE server=?").run(server)
        .changes === 1
    );
  }

  /** 配置里已经没有的 server，它的凭据不该永远留着（照 `SkillLoader.scan()` 末尾清陈行的做法）。 */
  prune(keep: readonly string[]): number {
    if (!keep.length)
      return this.db.prepare("DELETE FROM mcp_auth").run().changes;
    const placeholders = keep.map(() => "?").join(",");
    return this.db
      .prepare(`DELETE FROM mcp_auth WHERE server NOT IN (${placeholders})`)
      .run(...keep).changes;
  }

  #decodeJson(encrypted: string | null): unknown | null {
    if (!encrypted) return null;
    try {
      return JSON.parse(this.secrets.decrypt(encrypted)) as unknown;
    } catch {
      return null;
    }
  }
}
