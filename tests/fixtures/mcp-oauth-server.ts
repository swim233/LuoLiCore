import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

/**
 * 一台**受 OAuth 保护**的 Streamable-HTTP MCP server，用来跑完整的登录回路。
 *
 * 它同时扮演资源服务器与授权服务器（真实部署里常常也是同一家）：
 *
 *   POST /mcp                                     没有有效 token → 401 + WWW-Authenticate
 *   GET  /.well-known/oauth-protected-resource    RFC 9728：这份资源由谁来授权
 *   GET  /.well-known/oauth-authorization-server  RFC 8414：端点在哪、支持 S256
 *   POST /register                                RFC 7591 动态注册
 *   GET  /authorize                               直接 302 回 redirect_uri（测试里没有人来点「同意」）
 *   POST /token                                   authorization_code + refresh_token 两种 grant
 *
 * 既能被 vitest `import`（`start()`），也能
 * `pnpm exec tsx tests/fixtures/mcp-oauth-server.ts --port 9931` 单独跑起来当演示对象 ——
 * 后者是给「在真浏览器里看一遍登录」用的。
 */

const S256 = (verifier: string): string => createHash('sha256').update(verifier).digest('base64url');

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers });
  res.end(payload);
}

const readBody = (req: IncomingMessage): Promise<string> => new Promise((resolve) => {
  let raw = '';
  req.on('data', (chunk: Buffer) => { raw += chunk.toString('utf8'); });
  req.on('end', () => resolve(raw));
});

export interface OAuthFixtureOptions {
  /** 0 = 让内核挑一个。 */
  port?: number;
  /** access token 的寿命。给 1 能让下一次调用必须走 refresh。 */
  accessTokenTtlSeconds?: number;
  /** false = 只认预置的 client_id（模拟不支持动态注册的对家）。 */
  requireRegistration?: boolean;
}

export interface OAuthFixture {
  /** 交给 `mcp.servers[].url` 的那一个。 */
  url: string;
  base: string;
  /** 记账，供用例断言「真的走过动态注册」「真的 refresh 过一次」。 */
  seen: { register: number; authorize: number; tokenExchange: number; tokenRefresh: number; unauthorized: number };
  /** 直接塞一个 token 进去：bearer 模式的用例不需要走整套授权。 */
  mintBearer(ttlSeconds?: number): string;
  /** 把已发出的 token 全部作废：模拟「对方撤销了凭据」。 */
  revokeAll(): void;
  close(): Promise<void>;
}

export async function start(options: OAuthFixtureOptions = {}): Promise<OAuthFixture> {
  const accessTokenTtlSeconds = options.accessTokenTtlSeconds ?? 3600;
  const requireRegistration = options.requireRegistration !== false;

  /** 发出去的 access token → 过期时刻。过期的当场按 401 处理，逼客户端去 refresh。 */
  const accessTokens = new Map<string, number>();
  const refreshTokens = new Set<string>();
  const clients = new Set<string>(requireRegistration ? [] : ['preset-client']);
  /** 授权码 → PKCE 挑战与回调地址。一次性。 */
  const codes = new Map<string, { challenge: string; redirectUri: string; clientId: string }>();
  const seen = { register: 0, authorize: 0, tokenExchange: 0, tokenRefresh: 0, unauthorized: 0 };

  /**
   * **每个请求一套 Server + transport。** 这是无状态模式的既定用法：一个长命的
   * `StreamableHTTPServerTransport` 只服务得了第一个请求，之后一律 500（实测：initialize 回
   * 200，紧跟着的 `notifications/initialized` 与 `tools/list` 全是 500 空体）。
   * 复用一套的写法看起来更省，而它坏得很隐蔽 —— 握手成功、第一个 RPC 就死。
   */
  const openTransports = new Set<StreamableHTTPServerTransport>();
  async function serveMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const mcp = new Server({ name: 'oauth-probe', version: '1.0.0' }, { capabilities: { tools: {} } });
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: 'whoami', description: '回一句固定的话，只用来证明连上了', inputSchema: { type: 'object', properties: {} } }],
    }));
    mcp.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: 'text' as const, text: 'authorized' }] }));
    // `sessionIdGenerator` **整个省掉**就是无状态模式（SDK 文档：不提供即禁用会话管理）。
    // 显式写 `sessionIdGenerator: undefined` 过不了 `exactOptionalPropertyTypes`。
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    openTransports.add(transport);
    res.on('close', () => {
      openTransports.delete(transport);
      void transport.close().catch(() => undefined);
      void mcp.close().catch(() => undefined);
    });
    // SDK 自己的 `Transport` 接口没按 `exactOptionalPropertyTypes` 写（`onclose?` 与 `onclose`）。
    // 与 `McpManager` 里那一处 cast 同一个原因，不是这里的类型出了问题。
    await mcp.connect(transport as Parameters<Server['connect']>[0]);
    // **不预读 body**：`handleRequest` 的 node 版会把 `req` 转成 web 标准 `Request`，
    // 我们先把流读干的话它拿到的是一个已经耗尽的流。
    return transport.handleRequest(req, res);
  }

  const http = createServer((req, res) => { void handle(req, res); });
  await new Promise<void>((resolve) => http.listen(options.port ?? 0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;

  function issueTokens(): Record<string, unknown> {
    const access = randomBytes(24).toString('base64url');
    const refresh = randomBytes(24).toString('base64url');
    accessTokens.set(access, Date.now() + accessTokenTtlSeconds * 1000);
    refreshTokens.add(refresh);
    return { access_token: access, token_type: 'Bearer', expires_in: accessTokenTtlSeconds, refresh_token: refresh, scope: 'read write' };
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', base);
    const path = url.pathname;

    // ── 发现。SDK 会按 RFC 8414 与 OIDC 两套路径试，且带路径的资源还会试
    //    `/.well-known/oauth-authorization-server/<path>` —— 一律按包含关系兜住。
    if (path.endsWith('/.well-known/oauth-protected-resource')) {
      return json(res, 200, { resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ['read', 'write'] });
    }
    if (path.includes('/.well-known/oauth-authorization-server') || path.includes('/.well-known/openid-configuration')) {
      return json(res, 200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        ...(requireRegistration ? { registration_endpoint: `${base}/register` } : {}),
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        scopes_supported: ['read', 'write'],
      });
    }

    if (path === '/register' && req.method === 'POST') {
      if (!requireRegistration) return json(res, 404, { error: 'not_supported' });
      const body = JSON.parse((await readBody(req)) || '{}') as { redirect_uris?: string[] };
      seen.register += 1;
      const clientId = `client-${randomUUID()}`;
      clients.add(clientId);
      return json(res, 201, { client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000),
        redirect_uris: body.redirect_uris ?? [], token_endpoint_auth_method: 'none' });
    }

    if (path === '/authorize') {
      seen.authorize += 1;
      const clientId = url.searchParams.get('client_id');
      const redirectUri = url.searchParams.get('redirect_uri');
      const challenge = url.searchParams.get('code_challenge');
      const state = url.searchParams.get('state');
      if (!clientId || !clients.has(clientId)) return json(res, 400, { error: 'invalid_client' });
      if (!redirectUri || !challenge || url.searchParams.get('code_challenge_method') !== 'S256') return json(res, 400, { error: 'invalid_request' });
      const code = randomBytes(24).toString('base64url');
      codes.set(code, { challenge, redirectUri, clientId });
      // 真部署里这里是一屏「要不要授权给 LuoLiCore」。测试里直接同意 —— 要测的是我们这一侧。
      res.writeHead(302, { location: `${redirectUri}?code=${encodeURIComponent(code)}${state ? `&state=${encodeURIComponent(state)}` : ''}` });
      res.end();
      return;
    }

    if (path === '/token' && req.method === 'POST') {
      const params = new URLSearchParams(await readBody(req));
      const grant = params.get('grant_type');
      if (grant === 'authorization_code') {
        const code = params.get('code') ?? '';
        const entry = codes.get(code);
        codes.delete(code);
        if (!entry) return json(res, 400, { error: 'invalid_grant', error_description: 'code 无效或已用过' });
        // PKCE 真的验。不验的话「verifier 丢了」这类 bug 在用例里是看不见的。
        if (S256(params.get('code_verifier') ?? '') !== entry.challenge) return json(res, 400, { error: 'invalid_grant', error_description: 'PKCE 校验失败' });
        if (params.get('redirect_uri') !== entry.redirectUri) return json(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri 不一致' });
        seen.tokenExchange += 1;
        return json(res, 200, issueTokens());
      }
      if (grant === 'refresh_token') {
        if (!refreshTokens.has(params.get('refresh_token') ?? '')) return json(res, 400, { error: 'invalid_grant' });
        seen.tokenRefresh += 1;
        return json(res, 200, issueTokens());
      }
      return json(res, 400, { error: 'unsupported_grant_type' });
    }

    if (path === '/mcp') {
      const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      const expiresAt = accessTokens.get(token);
      if (!token || expiresAt === undefined || expiresAt <= Date.now()) {
        seen.unauthorized += 1;
        // `resource_metadata` 是 SDK 找到授权服务器的起点（`extractWWWAuthenticateParams`）。
        return json(res, 401, { error: 'invalid_token' },
          { 'www-authenticate': `Bearer realm="mcp", resource_metadata="${base}/.well-known/oauth-protected-resource"` });
      }
      return serveMcp(req, res);
    }

    return json(res, 404, { error: 'not_found' });
  }

  return {
    url: `${base}/mcp`,
    base,
    seen,
    mintBearer(ttlSeconds = accessTokenTtlSeconds) {
      const token = randomBytes(24).toString('base64url');
      accessTokens.set(token, Date.now() + ttlSeconds * 1000);
      return token;
    },
    revokeAll() { accessTokens.clear(); },
    async close() {
      for (const transport of [...openTransports]) await transport.close().catch(() => undefined);
      openTransports.clear();
      await new Promise<void>((resolve) => { http.close(() => resolve()); });
    },
  };
}

// 单独跑：给「在真浏览器里看一遍登录」用。
if (process.argv[1]?.endsWith('mcp-oauth-server.ts')) {
  const portIndex = process.argv.indexOf('--port');
  const server = await start(portIndex > 0 ? { port: Number(process.argv[portIndex + 1]) } : {});
  process.stdout.write(`${server.url}\n`);
  const bye = (): void => void server.close().then(() => process.exit(0));
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}
