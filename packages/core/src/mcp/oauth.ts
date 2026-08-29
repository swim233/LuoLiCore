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

/** 回调路径。固定而不设为配置项：它同时出现在 provider 的 `redirectUrl`、服务端路由与
 *  Origin/鉴权白名单中，设为可配置会导致三处各自读取同一个值。 */
export const MCP_OAUTH_CALLBACK_PATH = "/api/mcp/oauth/callback";

/** 一次授权的 TTL。足以完成切换浏览器、登录与确认授权；又不足以让陈旧的 state 被重放。 */
const PENDING_TTL_MS = 10 * 60_000;
/** 待授权表的上界。〔登录〕被连续点击时该表不应无限增长。 */
const PENDING_MAX = 16;

export interface PendingAuthorization {
  server: string;
  authorizationUrl: string;
  expiresAt: number;
}

/**
 * 进行中的授权，保存在进程内，不落库、不写日志 —— 遵循 `issueLoginToken` 的三条约束
 * （`packages/server/src/app.ts`）：可兑换凭据的数据写入库或日志，泄露面大于凭据本身。
 *
 * `state` 是 OAuth 的 CSRF 参数，此处同时作为回调的唯一准入判据：
 * 单次使用（`take` 即删除）、带 TTL、不可猜测（32 字节随机）。
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
    // 使同一台 server 的上一次授权失效：两条 state 同时有效时，先发起的回调会覆盖后发起的。
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

  /** 读取即删除。过期项按不存在处理 —— 已过期与不存在对调用方是同一结果。 */
  take(state: string): PendingAuthorization | null {
    const entry = this.#entries.get(state);
    this.#entries.delete(state);
    return entry && entry.expiresAt > Date.now() ? entry : null;
  }

  /** 界面需在不消费 state 的前提下获取该链接（刷新页面后〔登录〕仍须可用）。 */
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
  /** `webui.publicUrl`。为空字符串时整条流程不启动 —— 见 `redirectUrl`。 */
  publicUrl: string;
  scope?: string;
  clientId?: string;
}

/**
 * 一台 MCP server 的 `OAuthClientProvider`（SDK 1.30 `client/auth.js`）。
 *
 * 与 SDK 文档中的浏览器客户端有两点不同，均源于此处是服务端代持：
 *
 * - `redirectToAuthorization` 不执行重定向。它把授权 URL 记入 `PendingAuthorizations`，
 *   随后 transport 抛 `UnauthorizedError`，manager 将该 server 标记为 `needs_auth`。
 *   用户在扩展页点击〔登录〕后才访问该 URL —— 一次 reconcile 不应自动打开浏览器。
 * - 换码步骤不需要保留 transport。`finishAuth()` 是 transport 上的方法，而失败路径上的
 *   transport 已被 `#discard`；`auth(provider, { serverUrl, authorizationCode })` 执行
 *   同一套逻辑且不依赖连接，换取 token 后再由 manager 对该台单独重连。
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
   * 回调地址。`webui.publicUrl` 未配置时返回 undefined，而不是构造一个 127.0.0.1 地址：
   * 授权服务器需将用户重定向回来，构造的地址在对方处无法注册也无法回调，而
   * `redirect_uri` 一旦注册便不易修改。`startAuthorization` 会因此抛出，
   * 由调用方如实说明（参照 `/webui` 命令在未配置 publicUrl 时的处理）。
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
      // PKCE 公共客户端：不存储 client_secret。服务端代持 secret 并不提升安全性 ——
      // 能读到它的主体同样能读到 access token 本身。
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
    // `expires_in` 表示自当前起的秒数，存储时必须转为绝对时刻 —— 存相对值会导致重启后
    // 界面上的剩余有效期始终显示同一数值。
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
    // 已换取 token，PKCE verifier 与该条 pending 均已无用。保留 verifier 会把一次性数据变为常驻数据。
    this.store.invalidate(this.server, "verifier");
    this.pending.forget(this.server);
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    // state 从 URL 中读取而非使用 `#pendingState`：SDK 不保证先调用 `state()` 再调用此处，
    // 而授权服务器实际回传的正是 URL 上的这一个。
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
    // 抛出而非返回空串：空串会被当作合法 verifier 发送至 token 端点，得到的是含义模糊的
    // `invalid_grant`，而真实原因是本地的 verifier 已丢失。
    if (!verifier)
      throw new Error("本地没有此次授权的 code_verifier，请重新点击〔登录〕");
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
 * 三种来源都需识别，因为它们分别对应三种 `auth.mode`：
 * - `UnauthorizedError` —— 挂载了 provider（`oauth`）时由 SDK 抛出；
 * - `StreamableHTTPError` 且 `code` 为 401/403 —— 未挂载 provider（`none` / `bearer`）时
 *   SDK 的 401 分支被 `this._authProvider` 拦截，落入通用抛出。这是本仓库此前
 *   无法构造出 `UnauthorizedError` 的原因；
 * - 兜底匹配消息中的 401 —— 部分中转会把状态码放入正文而非状态行。
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
 * 用回调中的 code 换取 token。仅返回 `'AUTHORIZED'` 时才表示换取成功。
 *
 * `auth()` 内部会使用 `provider.codeVerifier()` 与 `clientInformation()`，并在成功后
 * 调用 `provider.saveTokens()` —— 因此此处无需直接操作任何列。
 */
export async function completeMcpAuthorization(
  provider: McpOAuthProvider,
  serverUrl: string,
  authorizationCode: string,
): Promise<"AUTHORIZED" | "REDIRECT"> {
  return auth(provider, { serverUrl, authorizationCode });
}

/** 主动发起一次授权：获取授权 URL（经 `redirectToAuthorization` 写入 pending 表）。 */
export async function beginMcpAuthorization(
  provider: McpOAuthProvider,
  serverUrl: string,
  scope?: string,
): Promise<"AUTHORIZED" | "REDIRECT"> {
  return auth(provider, { serverUrl, ...(scope ? { scope } : {}) });
}
