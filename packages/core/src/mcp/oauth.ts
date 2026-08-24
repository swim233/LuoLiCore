import { randomBytes } from "node:crypto";
import {
  UnauthorizedError,
  auth,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { McpAuthRepository } from "@luoli/db";

/** 回调路径。写死而不是做成配置项：它同时出现在 provider 的 `redirectUrl`、服务端路由与
 *  Origin/鉴权白名单里，做成可配就是三处各读一遍同一个值。 */
export const MCP_OAUTH_CALLBACK_PATH = "/api/mcp/oauth/callback";

/** 一次授权的 TTL。够人切到浏览器、登录、点同意；不够久到一条陈旧的 state 还能被重放。 */
const PENDING_TTL_MS = 10 * 60_000;
/** 待授权表的上界。〔登录〕被连点时这张表不该无限涨。 */
const PENDING_MAX = 16;

export interface PendingAuthorization {
  server: string;
  authorizationUrl: string;
  expiresAt: number;
}

/**
 * 进行中的授权。**进程内、不落库、不记进日志** —— 照 `issueLoginToken` 的三条
 * （`packages/server/src/app.ts`）：一条能换到凭据的东西落进库或日志，泄露面比凭据本身还大。
 *
 * `state` 是 OAuth 自己的 CSRF 参数，这里同时把它当回调的**唯一**准入判据：
 * 单次使用（`take` 即删）、有 TTL、不可猜（32 字节随机）。
 */
export class PendingAuthorizations {
  readonly #entries = new Map<string, PendingAuthorization>();

  #sweep(): void {
    const now = Date.now();
    for (const [state, entry] of this.#entries)
      if (entry.expiresAt <= now) this.#entries.delete(state);
    while (this.#entries.size >= PENDING_MAX)
      this.#entries.delete(this.#entries.keys().next().value!);
  }

  put(
    state: string,
    server: string,
    authorizationUrl: string,
  ): PendingAuthorization {
    this.#sweep();
    // 同一台 server 的上一次授权作废：两条 state 同时有效时，先点的那一条回来会覆盖后点的。
    for (const [key, entry] of this.#entries)
      if (entry.server === server) this.#entries.delete(key);
    const entry: PendingAuthorization = {
      server,
      authorizationUrl,
      expiresAt: Date.now() + PENDING_TTL_MS,
    };
    this.#entries.set(state, entry);
    return entry;
  }

  /** 读即删。过期的按「不存在」处理 —— 「过期了」与「没这条」对调用方是同一件事。 */
  take(state: string): PendingAuthorization | null {
    const entry = this.#entries.get(state);
    this.#entries.delete(state);
    return entry && entry.expiresAt > Date.now() ? entry : null;
  }

  /** 界面要能在不消费掉 state 的前提下拿到那个链接（刷新页面之后〔登录〕还得能点）。 */
  peek(server: string): PendingAuthorization | null {
    this.#sweep();
    for (const entry of this.#entries.values())
      if (entry.server === server) return entry;
    return null;
  }

  forget(server: string): void {
    for (const [key, entry] of this.#entries)
      if (entry.server === server) this.#entries.delete(key);
  }
}

export interface McpOAuthConfig {
  /** `webui.publicUrl`。空字符串时整条流程不启动 —— 见 `redirectUrl`。 */
  publicUrl: string;
  scope?: string;
  clientId?: string;
}

/**
 * 一台 MCP server 的 `OAuthClientProvider`（SDK 1.30 `client/auth.js`）。
 *
 * 与 SDK 文档里那个「浏览器里的客户端」不同的两点，都是因为这里是**服务端代持**：
 *
 * - `redirectToAuthorization` **不重定向**。它把授权 URL 记进 `PendingAuthorizations`，
 *   随后 transport 抛 `UnauthorizedError`，manager 把这台 server 记成 `needs_auth`。
 *   人是在扩展页点〔登录〕才去那个 URL 的 —— 一次 reconcile 不该自己弹浏览器。
 * - 换码那一步**不需要留住 transport**。`finishAuth()` 是 transport 上的方法，而失败路径上那条
 *   transport 早就被 `#discard` 掉了；`auth(provider, { serverUrl, authorizationCode })` 走的是
 *   同一套逻辑而不依赖连接，换完 token 再让 manager 单台重连。
 */
export class McpOAuthProvider implements OAuthClientProvider {
  #pendingState: string | null = null;

  constructor(
    private readonly server: string,
    private readonly store: McpAuthRepository,
    private readonly pending: PendingAuthorizations,
    private readonly config: McpOAuthConfig,
  ) {}

  /**
   * 回调地址。`webui.publicUrl` 没配时**返回 undefined 而不是编一个 127.0.0.1 的地址**：
   * 授权服务器要把人重定向回来，编出来的地址在对方那里注册不上、也回不来，而
   * `redirect_uri` 一旦注册进去就不好改。`startAuthorization` 会因此抛，
   * 调用方把这件事原样说出来（照 `/webui` 命令没配 publicUrl 时那句话的做法）。
   */
  get redirectUrl(): string | undefined {
    const base = this.config.publicUrl.trim().replace(/\/$/, "");
    return base ? `${base}${MCP_OAUTH_CALLBACK_PATH}` : undefined;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "LuoLiCore",
      redirect_uris: this.redirectUrl ? [this.redirectUrl] : [],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      // PKCE 公共客户端：不存 client_secret。服务端代持一个 secret 也不会更安全 ——
      // 能读到它的人已经能读到 access token 本身。
      token_endpoint_auth_method: "none",
      ...(this.config.scope ? { scope: this.config.scope } : {}),
    };
  }

  state(): string {
    this.#pendingState = randomBytes(32).toString("base64url");
    return this.#pendingState;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    if (this.config.clientId) return { client_id: this.config.clientId };
    return (
      (this.store.readClient(
        this.server,
      ) as OAuthClientInformationMixed | null) ?? undefined
    );
  }

  saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
    this.store.writeClient(this.server, clientInformation);
  }

  tokens(): OAuthTokens | undefined {
    return (
      (this.store.readTokens(this.server) as OAuthTokens | null) ?? undefined
    );
  }

  saveTokens(tokens: OAuthTokens): void {
    // `expires_in` 是「从现在起多少秒」，存下来的必须是绝对时刻 —— 存相对值的话重启之后
    // 界面上那个「还有多久过期」会一直显示同一个数字。
    const expiresAt =
      typeof tokens.expires_in === "number"
        ? Date.now() + tokens.expires_in * 1000
        : null;
    this.store.writeTokens(
      this.server,
      tokens,
      expiresAt,
      tokens.scope ?? this.config.scope ?? null,
    );
    // 换到 token 了，PKCE verifier 与那条 pending 都没用了。留着 verifier 等于把一次性的东西留成常驻的。
    this.store.invalidate(this.server, "verifier");
    this.pending.forget(this.server);
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    // state 从 URL 里读而不是用 `#pendingState`：SDK 不保证先调 `state()` 再调这里，
    // 而真正会被授权服务器回传的就是 URL 上这一个。
    const state =
      authorizationUrl.searchParams.get("state") ?? this.#pendingState;
    if (!state) throw new Error("授权 URL 上没有 state，拒绝开始这次授权");
    this.pending.put(state, this.server, authorizationUrl.toString());
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.store.writeVerifier(this.server, codeVerifier);
  }

  codeVerifier(): string {
    const verifier = this.store.readVerifier(this.server);
    // 抛而不是回空串：空串会被当成一个合法的 verifier 发给 token 端点，换回来的是一句
    // 语焉不详的 `invalid_grant`，而真正的原因是本地这一份丢了。
    if (!verifier)
      throw new Error("本地没有这次授权的 code_verifier —— 重新点一次〔登录〕");
    return verifier;
  }

  invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): void {
    this.store.invalidate(this.server, scope);
    if (scope === "all" || scope === "verifier")
      this.pending.forget(this.server);
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.store.writeDiscovery(this.server, state);
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return (
      (this.store.readDiscovery(this.server) as OAuthDiscoveryState | null) ??
      undefined
    );
  }
}

/**
 * 一台 server「要登录」的判据。
 *
 * 三种来源都要认，因为它们分别对应三种 `auth.mode`：
 * - `UnauthorizedError` —— 挂了 provider（`oauth`）时 SDK 自己抛的；
 * - `StreamableHTTPError` 且 `code` 是 401/403 —— **没挂 provider**（`none` / `bearer`）时
 *   SDK 那条 401 分支被 `this._authProvider` 挡住，落到通用抛出。这是本仓库此前
 *   `UnauthorizedError` 压根构造不出来的原因；
 * - 兜底看消息里的 401 —— 有的中转会把状态码塞进正文而不是状态行。
 */
export function looksLikeAuthFailure(error: unknown): boolean {
  if (error instanceof UnauthorizedError) return true;
  if (error instanceof StreamableHTTPError)
    return error.code === 401 || error.code === 403;
  const message = error instanceof Error ? error.message : String(error);
  return (
    /\b(401|403)\b/.test(message) &&
    /unauthor|forbidden|invalid_token|insufficient_scope/i.test(message)
  );
}

/**
 * 用回调里那个 code 把 token 换出来。返回 `'AUTHORIZED'` 才算真换到了。
 *
 * `auth()` 内部会用 `provider.codeVerifier()` 与 `clientInformation()`，并在成功后
 * 调 `provider.saveTokens()` —— 所以这里不需要自己碰任何一列。
 */
export async function completeMcpAuthorization(
  provider: McpOAuthProvider,
  serverUrl: string,
  authorizationCode: string,
): Promise<"AUTHORIZED" | "REDIRECT"> {
  return auth(provider, { serverUrl, authorizationCode });
}

/** 主动开一次授权：拿到授权 URL（走 `redirectToAuthorization` 落进 pending 表）。 */
export async function beginMcpAuthorization(
  provider: McpOAuthProvider,
  serverUrl: string,
  scope?: string,
): Promise<"AUTHORIZED" | "REDIRECT"> {
  return auth(provider, { serverUrl, ...(scope ? { scope } : {}) });
}
