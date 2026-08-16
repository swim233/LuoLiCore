import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import argon2 from 'argon2';
import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import type { AgentManager, Config, ConfigStore, ContextEngine, DatabaseApprovalBroker, EventBus, LogSink, MaintenanceService, McpManager, MemoryStore, ModelCatalog, PluginManager, PromptDocuments, ProviderStore, Sandbox, SkillLoader, TurnRegistry } from '@luoli/core';
import { ALIAS_NAME_PATTERN, HOT_RELOADABLE_CONFIG_KEYS, KNOWN_UNIMPLEMENTED_CONFIG_KEYS, TOOL_POLICY, aliasSettingsSchema, checkWakeword, configSchema as runtimeConfigSchema, perChatConfig, probeProvider, rejectedWakewords } from '@luoli/core';
import type { CatalogIndex, ModelMetadata, ProviderProbe } from '@luoli/core';
import type { ArchiveRepository, OperationsRepository, PrincipalRepository, Sqlite } from '@luoli/db';
import { assignDotted } from '@luoli/shared';

export interface ServerDependencies {
  config: Readonly<Config> | ConfigStore;
  db: Sqlite;
  operations: OperationsRepository;
  principals: PrincipalRepository;
  archive: ArchiveRepository;
  context: ContextEngine;
  providers: ProviderStore;
  modelCatalog?: ModelCatalog;
  approvals: DatabaseApprovalBroker;
  rebuildModels?: () => void;
  maintenance: MaintenanceService;
  events: EventBus;
  memory?: MemoryStore;
  promptDocuments?: PromptDocuments;
  skills?: SkillLoader;
  plugins?: PluginManager;
  mcp?: McpManager;
  agents?: AgentManager;
  turnRegistry?: TurnRegistry;
  sandbox?: Sandbox;
  log: LogSink;
  configSchema: unknown;
  startedAt: number;
  setup: { token: string; expiresAt: number } | undefined;
}

interface AuthVariables {
  sessionId: string;
  csrf: string;
}

type ServerEnv = { Variables: AuthVariables };

function cookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const entry of header.split(';')) {
    const [key, ...value] = entry.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return null;
}

const apiError = (code: string, message: string, status: 400 | 401 | 403 | 404 | 429 | 500 | 502 = 400) => ({ body: { ok: false as const, error: { code, message } }, status });

/**
 * 展开一律走 `assignDotted`：裸的 `cursor[part]` 遇到 `__proto__` 会在**校验之前**污染 `Object.prototype`，
 * 之后每一次 `safeParse` 都会失败，一次合法登录态的请求就能把配置面板永久打死（docs/20 · W-CFG-01）。
 * 被拒的键必须 400，不能跳过后当成功 —— 写入端是这条路径的最后一道闸。
 */
function mergeDotted(base: unknown, updates: Record<string, unknown>): { ok: true; value: unknown } | { ok: false; key: string } {
  const clone = structuredClone(base) as Record<string, unknown>;
  for (const [key, value] of Object.entries(updates)) if (!assignDotted(clone, key, value)) return { ok: false, key };
  return { ok: true, value: clone };
}
const invalidKey = (result: { ok: false; key: string }) => apiError('invalid_config_key', `非法配置键：${result.key}`);
function page<T>(items: T[], pageNumber: number, size: number): { items: T[]; total: number; page: number; size: number } {
  return { items: items.slice((pageNumber - 1) * size, pageNumber * size), total: items.length, page: pageNumber, size };
}

/** 文件名来自 Telegram，是攻击者可控的：引号会破坏参数解析，CR/LF 会让 Response 构造直接抛错。 */
function contentDisposition(name: string): string {
  const ascii = [...name].map((char) => (char >= ' ' && char <= '~' && char !== '"' && char !== '\\' ? char : '_')).join('').slice(0, 120) || 'download';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function safeRef(root: string, reference: string): string {
  const absolute = resolve(root, reference);
  const base = resolve(root);
  if (absolute !== base && !absolute.startsWith(`${base}${sep}`)) throw new Error('invalid_file_ref');
  return absolute;
}

function publicConfig(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(publicConfig);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, /key|secret|token|password/i.test(key) && typeof nested === 'string' && nested ? '«redacted»' : publicConfig(nested)]));
}
function requestIp(ctx: { req: { header(name: string): string | undefined } }, config: Readonly<Config>): string {
  if (!config.webui.trustProxy) return 'local';
  return ctx.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
}
function requestIsSecure(ctx: { req: { header(name: string): string | undefined; url: string } }, config: Readonly<Config>): boolean {
  return ctx.req.url.startsWith('https:') || (config.webui.trustProxy && ctx.req.header('x-forwarded-proto')?.split(',')[0]?.trim() === 'https');
}
function allowedOrigin(ctx: { req: { header(name: string): string | undefined; url: string } }, config: Readonly<Config>): boolean {
  const origin = ctx.req.header('origin');
  if (!origin) return true;
  const own = new URL(ctx.req.url).origin;
  return origin === own || config.webui.allowOrigins.includes(origin);
}
export function createServer(dependencies: ServerDependencies): Hono<ServerEnv> {
  const app = new Hono<ServerEnv>();
  const currentConfig = (): Readonly<Config> => 'snapshot' in dependencies.config ? dependencies.config.snapshot() : dependencies.config;
  let passwordHash = currentConfig().webui.passwordHash;
  const failures = new Map<string, { count: number; lockedUntil: number }>();

  app.use('*', async (ctx, next) => {
    ctx.header('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'");
    ctx.header('X-Frame-Options', 'DENY');
    ctx.header('X-Content-Type-Options', 'nosniff');
    ctx.header('Referrer-Policy', 'no-referrer');
    await next();
  });
  app.use('/api/*', async (ctx, next) => {
    if (!allowedOrigin(ctx, currentConfig())) return ctx.json(apiError('origin', 'Origin 不允许', 403).body, 403);
    await next();
  });

  // 无鉴权的那份只回存活状态。provider 列表（含 baseUrl）、MCP 服务器、沙箱 plan、在途轮次数
  // 都是内部拓扑：默认绑 127.0.0.1 时影响有限，但 `webui.host` 一放开就是无鉴权信息泄露
  // （docs/20 · W-API-01）。详细信息移到鉴权后的 /api/health/detail。
  app.get('/api/health', (ctx) => {
    let dbOk = true;
    try { dependencies.db.prepare('SELECT 1').get(); } catch { dbOk = false; }
    return ctx.json({ ok: dbOk, uptimeMs: Date.now() - dependencies.startedAt });
  });

  app.post('/api/setup', async (ctx) => {
    const body = await ctx.req.json<{ token?: string; password?: string }>();
    const expected = dependencies.setup?.token ?? '';
    const validToken = Boolean(dependencies.setup && Date.now() <= dependencies.setup.expiresAt && body.token && body.token.length === expected.length && timingSafeEqual(Buffer.from(body.token), Buffer.from(expected)));
    if (!validToken) return ctx.json(apiError('invalid_setup', 'Setup token is invalid', 403).body, 403);
    if (!body.password || body.password.length < 12) return ctx.json(apiError('weak_password', 'Password must have at least 12 characters').body, 400);
    passwordHash = await argon2.hash(body.password, { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
    const now = Date.now();
    dependencies.db.prepare(`INSERT INTO config_kv(key,value_json,updated_at,updated_by) VALUES ('webui.passwordHash',?,?,?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at,updated_by=excluded.updated_by`).run(JSON.stringify(passwordHash), now, 'setup');
    dependencies.db.prepare('INSERT INTO config_revisions(id,ts,actor,key,old_json,new_json) VALUES (?,?,?,?,?,?)').run(randomBytes(16).toString('hex'), now, 'setup', 'webui.passwordHash', JSON.stringify(''), JSON.stringify('«redacted»'));
    dependencies.setup = undefined;
    const session = dependencies.operations.createSession(currentConfig().webui.sessionTtlHours, requestIp(ctx, currentConfig()), ctx.req.header('user-agent'));
    const secure = requestIsSecure(ctx, currentConfig()) ? '; Secure' : '';
    ctx.header('Set-Cookie', `luoli_sid=${encodeURIComponent(session.id)}; HttpOnly; SameSite=Strict; Path=/${secure}`);
    return ctx.json({ ok: true, data: { csrf: session.csrf, expiresAt: session.expiresAt } });
  });

  app.post('/api/auth/login', async (ctx) => {
    const ip = requestIp(ctx, currentConfig());
    const failure = failures.get(ip);
    if (failure && failure.lockedUntil > Date.now()) return ctx.json(apiError('locked', '登录失败次数过多，请稍后再试', 429).body, 429);
    const body = await ctx.req.json<{ password?: string }>();
    let valid = false;
    try { valid = Boolean(body.password && passwordHash && await argon2.verify(passwordHash, body.password)); } catch { valid = false; }
    if (!valid) {
      const count = (failure?.count ?? 0) + 1;
      const webui = currentConfig().webui;
      failures.set(ip, { count, lockedUntil: count >= webui.loginRateLimit.attempts ? Date.now() + webui.loginRateLimit.windowMinutes * 60_000 : 0 });
      dependencies.log.event({ level: 'warn', kind: 'webui.action', summary: 'login failed', data: { ip } });
      return ctx.json(apiError('invalid_credentials', '密码错误', 401).body, 401);
    }
    failures.delete(ip);
    const session = dependencies.operations.createSession(currentConfig().webui.sessionTtlHours, ip, ctx.req.header('user-agent'));
    const secure = requestIsSecure(ctx, currentConfig()) ? '; Secure' : '';
    ctx.header('Set-Cookie', `luoli_sid=${encodeURIComponent(session.id)}; HttpOnly; SameSite=Strict; Path=/${secure}`);
    return ctx.json({ ok: true, data: { csrf: session.csrf, expiresAt: session.expiresAt } });
  });

  app.use('/api/*', async (ctx, next) => {
    if (ctx.req.path === '/api/health' || ctx.req.path === '/api/auth/login' || ctx.req.path === '/api/setup') return next();
    const id = cookie(ctx.req.header('cookie'), 'luoli_sid');
    const session = id ? dependencies.operations.session(id) : null;
    if (!session) return ctx.json(apiError('unauthorized', '未登录', 401).body, 401);
    ctx.set('sessionId', session.id);
    ctx.set('csrf', session.csrf);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(ctx.req.method) && ctx.req.header('x-csrf-token') !== session.csrf) return ctx.json(apiError('csrf', 'CSRF token 无效', 403).body, 403);
    await next();
  });

  app.use('/api/*', async (ctx, next) => {
    await next();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(ctx.req.method)) dependencies.log.event({ level: 'info', kind: 'webui.action', summary: `${ctx.req.method} ${ctx.req.path}`, data: { method: ctx.req.method, path: ctx.req.path } });
  });
  app.get('/api/health/detail', (ctx) => {
    let dbOk = true;
    try { dependencies.db.prepare('SELECT 1').get(); } catch { dbOk = false; }
    const providers = dependencies.providers.list() as Array<{ enabled?: number; healthState?: string | null }>;
    const mcp = dependencies.db.prepare('SELECT name,state,last_error AS error FROM mcp_servers ORDER BY name').all();
    return ctx.json({ ok: dbOk, data: { ok: dbOk, version: process.env.npm_package_version ?? 'dev', uptimeMs: Date.now() - dependencies.startedAt,
      db: { ok: dbOk }, providers, mcp, sandbox: dependencies.sandbox?.plan('trusted') ?? { allowed: false }, inFlightTurns: dependencies.turnRegistry?.size ?? 0 } });
  });
  app.post('/api/auth/logout', (ctx) => {
    dependencies.operations.deleteSession(ctx.get('sessionId'));
    ctx.header('Set-Cookie', 'luoli_sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    return ctx.json({ ok: true });
  });
  // SPA 只把 csrf 放在内存里，刷新页面就丢了；不在这里发回去，刷新之后每个写操作都是 403。
  // 这不削弱 CSRF 防护：跨站请求既读不到响应（无 CORS 放行），也过不了上面的 Origin 中间件。
  app.get('/api/auth/me', (ctx) => ctx.json({ ok: true, data: { role: 'owner', csrf: ctx.get('csrf'), expiresAt: dependencies.operations.session(ctx.get('sessionId'))?.expiresAt ?? null } }));
  app.get('/api/dashboard', (ctx) => ctx.json({ ok: true, data: dependencies.operations.dashboard() }));
  app.get('/api/chats', (ctx) => ctx.json({ ok: true, data: dependencies.db.prepare(`SELECT c.key,c.chat_id AS chatId,c.thread_id AS threadId,c.scope,c.claim_watermark AS claimWatermark,
    cc.head_ordinal AS headOrdinal,cc.tokens_total AS tokens,cc.msg_count AS messages FROM contexts c LEFT JOIN refs r ON r.key=c.key AND r.name='done' LEFT JOIN context_commits cc ON cc.id=r.commit_id ORDER BY c.updated_at DESC`).all() }));
  app.get('/api/config', (ctx) => ctx.json({ ok: true, data: publicConfig(currentConfig()) }));
  // 带上热更新前缀：不在 hotReloadable 里的键保存后需要重启才生效，WebUI 据此显示待重启徽标
  // ——「保存成功」但运行时没变，是 docs/20 · W-CFG-02 里最误导的一类。
  app.get('/api/config/schema', (ctx) => ctx.json({ ok: true, data: dependencies.configSchema, hotReloadable: HOT_RELOADABLE_CONFIG_KEYS, unimplemented: KNOWN_UNIMPLEMENTED_CONFIG_KEYS }));
  // 不安全或过短的唤醒词在匹配时被静默跳过（trigger.ts）。收下这种模式等于让运维以为配好了，
  // 实际表现是「bot 不理我」，所以写入端直接挡回去；只在这次写操作真的动了唤醒词时校验。
  app.post('/api/config/wakewords/check', async (ctx) => {
    const body = await ctx.req.json<{ wakewords?: unknown; minLength?: unknown }>();
    const patterns = Array.isArray(body.wakewords) ? body.wakewords.filter((entry): entry is string => typeof entry === 'string') : [];
    const minLength = typeof body.minLength === 'number' ? body.minLength : currentConfig().trigger.wakewordMinLength;
    return ctx.json({ ok: true, data: patterns.map((pattern) => { const checked = checkWakeword(pattern, minLength); return { pattern, kind: checked.kind, ok: checked.ok, reason: checked.ok ? null : checked.reason }; }) });
  });
  app.put('/api/config', async (ctx) => {
    const body = await ctx.req.json<Record<string, unknown>>();
    const merged = mergeDotted(currentConfig(), body);
    if (!merged.ok) return ctx.json(invalidKey(merged).body, 400);
    const parsed = runtimeConfigSchema.safeParse(merged.value);
    if (!parsed.success) return ctx.json({ ok: false, error: { code: 'invalid_config', message: '配置校验失败', details: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) } }, 400);
    if (Object.keys(body).some((key) => key === 'trigger' || key.startsWith('trigger.'))) {
      const rejected = rejectedWakewords(parsed.data.trigger.wakewords, parsed.data.trigger.wakewordMinLength);
      if (rejected.length) return ctx.json(apiError('invalid_wakeword', `唤醒词不会生效：${rejected.join('；')}`).body, 400);
    }
    const now = Date.now();
    const write = dependencies.db.prepare(`INSERT INTO config_kv(key,value_json,updated_at,updated_by) VALUES (?,?,?,'webui') ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at,updated_by=excluded.updated_by`);
    const revision = dependencies.db.prepare('INSERT INTO config_revisions(id,ts,actor,key,old_json,new_json) VALUES (?,?,?,?,?,?)');
    dependencies.db.transaction(() => {
      for (const [key, value] of Object.entries(body)) {
        const previous = dependencies.db.prepare('SELECT value_json AS value FROM config_kv WHERE key=?').get(key) as { value: string } | undefined;
        write.run(key, JSON.stringify(value), now);
        revision.run(randomBytes(16).toString('hex'), now, 'webui', key, previous?.value ?? null, JSON.stringify(value));
      }
    })();
    dependencies.events.emit('config.changed', { keys: Object.keys(body) });
    return ctx.json({ ok: true, data: { keys: Object.keys(body) } });
  });
  app.get('/api/chats/:key', (ctx) => ctx.json({ ok: true, data: dependencies.context.stats(ctx.req.param('key')) }));
  app.patch('/api/chats/:key', async (ctx) => {
    const body = await ctx.req.json<Record<string, unknown>>(); const key = `perChat.${ctx.req.param('key')}`; const now = Date.now();
    // 必须走 schema：perChat 覆盖白名单是安全边界（[11 §2.1]），绕过它既能给单个群关掉权限检查，
    // 又会让下次启动时的配置校验失败（docs/19-review-round4.md · R-CFG-02）。
    const merged = mergeDotted(currentConfig(), { [key]: body });
    if (!merged.ok) return ctx.json(invalidKey(merged).body, 400);
    const parsed = runtimeConfigSchema.safeParse(merged.value);
    if (!parsed.success) return ctx.json({ ok: false, error: { code: 'invalid_config', message: '会话覆盖校验失败', details: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) } }, 400);
    if (body.trigger) {
      const merged = perChatConfig(parsed.data, ctx.req.param('key')).trigger;
      const rejected = rejectedWakewords(merged.wakewords, merged.wakewordMinLength);
      if (rejected.length) return ctx.json(apiError('invalid_wakeword', `唤醒词不会生效：${rejected.join('；')}`).body, 400);
    }
    dependencies.db.prepare("INSERT INTO config_kv(key,value_json,updated_at,updated_by) VALUES (?,?,?,'webui') ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at,updated_by='webui'").run(key, JSON.stringify(body), now);
    dependencies.db.prepare('INSERT INTO config_revisions(id,ts,actor,key,old_json,new_json) VALUES (?,?,?,?,?,?)').run(randomBytes(16).toString('hex'), now, 'webui', key, null, JSON.stringify(body));
    dependencies.events.emit('config.changed', { keys: [key] }); return ctx.json({ ok: true, data: body });
  });
  app.get('/api/config/revisions', (ctx) => ctx.json({ ok: true, data: dependencies.db.prepare('SELECT * FROM config_revisions ORDER BY ts DESC LIMIT 500').all() }));
  // 策略本身是代码里的单一来源（TOOL_POLICY），但「现在这台机器上开着没有」只在 tools.overrides 里，
  // 不一起返回的话工具页只能显示一份与运行时无关的静态表。
  app.get('/api/tools', (ctx) => {
    const overrides = currentConfig().tools.overrides;
    return ctx.json({ ok: true, data: Object.fromEntries(Object.entries(TOOL_POLICY).map(([name, policy]) => [name, { ...policy, enabled: overrides[name]?.enabled !== false }])) });
  });
  app.get('/api/principals', (ctx) => ctx.json({ ok: true, data: dependencies.principals.list() }));
  app.patch('/api/principals/:id', async (ctx) => {
    const body = await ctx.req.json<{ role: 'owner' | 'trusted' | 'limited' | 'blocked' }>();
    const changed = dependencies.principals.setRole(ctx.req.param('id'), body.role, 'webui');
    dependencies.log.event({ level: 'info', kind: 'webui.action', summary: 'principal role changed', data: { id: ctx.req.param('id'), role: body.role } });
    return ctx.json({ ok: true, data: { changed } });
  });
  interface ProviderRow { id: string; name: string; kind: string; baseUrl: string | null; headers: string | null }
  const providerProbe = async (id: string, overrides: { kind?: unknown; baseUrl?: unknown; apiKey?: unknown } = {}): Promise<{ row: ProviderRow; result: ProviderProbe; adhoc: boolean } | null> => {
    const row = dependencies.db.prepare('SELECT id,name,kind,base_url AS baseUrl,headers_json AS headers FROM providers WHERE id=?').get(id) as ProviderRow | undefined;
    if (!row) return null;
    const overrideKey = typeof overrides.apiKey === 'string' && overrides.apiKey ? overrides.apiKey : null;
    const adhoc = Boolean(overrideKey) || typeof overrides.baseUrl === 'string' || typeof overrides.kind === 'string';
    let apiKey = overrideKey;
    // 停用的 provider 也要能在启用前先探一次，所以 includeDisabled。
    if (!apiKey) try { apiKey = dependencies.providers.key(row.id, true); } catch {
      return { row, adhoc, result: { reachable: false, code: 'no_master_key', message: 'LUOLI_MASTER_KEY 缺失或已更换，无法解密该 provider 的 API Key', status: null, latencyMs: 0, models: [] } };
    }
    let headers: Record<string, string> | null = null;
    try { headers = row.headers ? JSON.parse(row.headers) as Record<string, string> : null; } catch { headers = null; }
    const kind = typeof overrides.kind === 'string' && overrides.kind ? overrides.kind : row.kind;
    const baseUrl = typeof overrides.baseUrl === 'string' ? overrides.baseUrl : row.baseUrl;
    return { row, adhoc, result: await probeProvider({ name: row.name, kind, baseUrl, headers }, apiKey) };
  };
  app.get('/api/providers', (ctx) => ctx.json({ ok: true, data: dependencies.providers.list() }));
  app.post('/api/providers', async (ctx) => { try { const id = dependencies.providers.save(await ctx.req.json()); dependencies.rebuildModels?.(); return ctx.json({ ok: true, data: { id } }); } catch (error) { return ctx.json(apiError('provider_invalid', error instanceof Error ? error.message : 'Provider 配置无效').body, 400); } });
  app.get('/api/models', (ctx) => ctx.json({ ok: true, data: dependencies.db.prepare('SELECT * FROM models ORDER BY provider_id,sort').all() }));
  app.post('/api/models', async (ctx) => {
    const body = await ctx.req.json<Record<string, unknown>>();
    if (typeof body.providerId !== 'string' || !body.providerId || typeof body.modelId !== 'string' || !body.modelId) return ctx.json(apiError('model_invalid', 'providerId 与 modelId 必填').body, 400);
    const contextWindow = Number(body.contextWindow); const maxOutput = Number(body.maxOutput);
    if (!Number.isInteger(contextWindow) || contextWindow <= 0 || !Number.isInteger(maxOutput) || maxOutput <= 0) return ctx.json(apiError('model_invalid', 'contextWindow 与 maxOutput 必须是正整数').body, 400);
    const id = typeof body.id === 'string' && body.id ? body.id : randomBytes(16).toString('hex');
    try { dependencies.db.prepare(`INSERT INTO models(id,provider_id,model_id,display_name,context_window,max_output,capabilities_json,price_in,price_out,price_cache_read,price_cache_write,enabled,sort,created_at,updated_at)
      VALUES (@id,@providerId,@modelId,@displayName,@contextWindow,@maxOutput,@capabilities,@priceIn,@priceOut,@priceCacheRead,@priceCacheWrite,@enabled,@sort,@now,@now)`).run({ id, providerId: body.providerId, modelId: body.modelId, displayName: body.displayName ?? null, contextWindow, maxOutput, capabilities: JSON.stringify(body.capabilities ?? {}), priceIn: body.priceIn ?? null, priceOut: body.priceOut ?? null, priceCacheRead: body.priceCacheRead ?? null, priceCacheWrite: body.priceCacheWrite ?? null, enabled: body.enabled === false ? 0 : 1, sort: body.sort ?? 0, now: Date.now() }); }
    catch (error) { return ctx.json(apiError('model_invalid', error instanceof Error ? error.message : '模型配置无效').body, 400); }
    dependencies.rebuildModels?.();
    return ctx.json({ ok: true, data: { id } });
  });
  app.patch('/api/providers/:id', async (ctx) => { try { const id = dependencies.providers.save({ ...(await ctx.req.json()), id: ctx.req.param('id') }); dependencies.rebuildModels?.(); return ctx.json({ ok: true, data: { id } }); } catch (error) { return ctx.json(apiError('provider_invalid', error instanceof Error ? error.message : 'Provider 配置无效').body, 400); } });
  app.delete('/api/providers/:id', (ctx) => { const changes = dependencies.db.prepare('DELETE FROM providers WHERE id=?').run(ctx.req.param('id')).changes; dependencies.rebuildModels?.(); return ctx.json({ ok: true, data: { changes } }); });
  app.post('/api/providers/:id/test', async (ctx) => {
    const body = await ctx.req.json<Record<string, unknown>>().catch(() => ({}));
    const probe = await providerProbe(ctx.req.param('id'), body);
    if (!probe) return ctx.json(apiError('not_found', 'Provider 不存在', 404).body, 404);
    const { row, result, adhoc } = probe;
    // 只有测「库里那份配置」才动健康状态：拿临时 key 试错不该把线上 provider 摘掉。
    // 成功写回 up 是 markProviderDown 之后唯一的人工恢复路径；而 404/超时/5xx 不写 down ——
    // 网关缺 /models 不等于对话不可用，据此摘掉 provider 会把能用的模型链整条打断。
    if (!adhoc) {
      const now = Date.now();
      if (result.reachable) dependencies.db.prepare("UPDATE providers SET health_state='up',health_checked_at=?,health_error=NULL WHERE id=?").run(now, row.id);
      else if (result.code === 'unauthorized') dependencies.db.prepare("UPDATE providers SET health_state='down',health_checked_at=?,health_error=? WHERE id=?").run(now, result.message.slice(0, 500), row.id);
      else dependencies.db.prepare('UPDATE providers SET health_checked_at=? WHERE id=?').run(now, row.id);
      dependencies.rebuildModels?.();
    }
    dependencies.log.event({ level: result.reachable ? 'info' : 'warn', kind: 'provider.health', summary: `provider test ${result.code}`,
      data: { provider: row.name, code: result.code, status: result.status, latencyMs: result.latencyMs, models: result.models.length, adhoc } });
    return ctx.json({ ok: true, data: { reachable: result.reachable, code: result.code, message: result.message, status: result.status, latencyMs: result.latencyMs, models: result.models.length } });
  });
  // 上游的 /models 只给模型名（Google 额外给窗口/输出）。窗口、最大输出、定价、输入模态、
  // 可用思考档位来自 models.dev 的本地缓存目录（docs/04 §5.4.1）；缓存缺失或过期时才出网一次。
  const catalogMeta = async (force = false): Promise<{ index: CatalogIndex | null; status: Record<string, unknown> }> => {
    if (!dependencies.modelCatalog) return { index: null, status: { enabled: false, available: false, outcome: 'disabled' } };
    const load = await dependencies.modelCatalog.ensure(force);
    return { index: load.index, status: { ...dependencies.modelCatalog.status(), outcome: load.outcome, error: load.error } };
  };
  /** capabilities_json 里那份元数据快照：能力布尔值 + 思考档位 + 模态 + 这次匹配的来龙去脉。
   *  `priceSource` 记的是「这一行的价格是谁给的」，owner 手改价格后会翻成 manual —— 界面上的
   *  「官方价」徽标必须能被推翻，否则改完价还显示官方价就是在骗人。 */
  const capabilityBlock = (meta: ModelMetadata, fetchedAt: number | null, priceSource: string | null): string => JSON.stringify({
    ...meta.capabilities, reasoningControl: meta.reasoningControl, reasoningEfforts: meta.reasoningEfforts,
    modalities: meta.modalities, knowledge: meta.knowledge, releaseDate: meta.releaseDate,
    catalog: { source: 'models.dev', match: meta.match, providerId: meta.catalogProviderId, modelId: meta.catalogModelId, normalized: meta.normalized, priceRange: meta.priceRange, priceSource, fetchedAt },
  });
  app.get('/api/providers/:id/models', async (ctx) => {
    const probe = await providerProbe(ctx.req.param('id'));
    if (!probe) return ctx.json(apiError('not_found', 'Provider 不存在', 404).body, 404);
    const { row, result } = probe;
    if (!result.reachable) {
      const status = result.code === 'unauthorized' ? 403 : result.code === 'missing_base_url' || result.code === 'no_master_key' ? 400 : 502;
      return ctx.json(apiError(result.code, result.message, status).body, status);
    }
    const catalog = await catalogMeta();
    const models = result.models.map((entry) => {
      const meta = dependencies.modelCatalog?.lookup(catalog.index, { kind: row.kind, baseUrl: row.baseUrl }, entry.modelId) ?? null;
      return {
        ...entry,
        // 上游自己报的窗口/输出是它这台机器上的事实，比目录更权威；只有上游没给才用目录补。
        contextWindow: entry.contextWindow ?? meta?.contextWindow ?? null,
        maxOutput: entry.maxOutput ?? meta?.maxOutput ?? null,
        limitSource: entry.contextWindow !== null || entry.maxOutput !== null ? 'upstream' : meta?.contextWindow ? 'models.dev' : null,
        displayName: entry.displayName ?? meta?.displayName ?? null,
        priceIn: meta?.priceIn ?? null, priceOut: meta?.priceOut ?? null, priceCacheRead: meta?.priceCacheRead ?? null, priceCacheWrite: meta?.priceCacheWrite ?? null,
        meta: meta ?? null,
      };
    });
    return ctx.json({ ok: true, data: { models, latencyMs: result.latencyMs, catalog: catalog.status } });
  });
  app.get('/api/models/catalog', async (ctx) => ctx.json({ ok: true, data: dependencies.modelCatalog?.status() ?? { enabled: false, available: false } }));
  app.post('/api/models/catalog/refresh', async (ctx) => {
    if (!dependencies.modelCatalog) return ctx.json(apiError('catalog_disabled', '模型元数据目录未启用').body, 400);
    const load = await dependencies.modelCatalog.ensure(true);
    dependencies.log.event({ level: load.error ? 'warn' : 'info', kind: 'provider.catalog', summary: `models.dev ${load.outcome}`, data: { outcome: load.outcome, error: load.error, models: load.state?.models ?? 0 } });
    // 出网失败但盘上还有旧缓存时返回 200 + error：目录是降级可用的，硬报错会让界面以为一条都没有。
    if (load.outcome === 'unavailable') return ctx.json(apiError('catalog_unavailable', load.error ?? '无法拉取模型元数据目录', 502).body, 502);
    return ctx.json({ ok: true, data: { ...dependencies.modelCatalog.status(), outcome: load.outcome, error: load.error } });
  });
  app.post('/api/models/import', async (ctx) => {
    const body = await ctx.req.json<{ providerId?: unknown; models?: unknown; contextWindow?: unknown; maxOutput?: unknown }>();
    const providerId = typeof body.providerId === 'string' ? body.providerId : '';
    const provider = dependencies.db.prepare('SELECT kind,base_url AS baseUrl FROM providers WHERE id=?').get(providerId) as { kind: string; baseUrl: string | null } | undefined;
    if (!providerId || !provider) return ctx.json(apiError('not_found', 'providerId 不存在', 404).body, 404);
    if (!Array.isArray(body.models) || body.models.length === 0) return ctx.json(apiError('model_invalid', 'models 必须是非空数组').body, 400);
    if (body.models.length > 200) return ctx.json(apiError('model_invalid', '单次最多导入 200 个模型').body, 400);
    const int = (value: unknown): number | null => (Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : null);
    const price = (value: unknown): number | null => (value === null || value === undefined || value === '' ? null : Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null);
    const fallbackWindow = int(body.contextWindow) ?? 128_000;
    const fallbackOutput = int(body.maxOutput) ?? 8192;
    const entries: Array<{ modelId: string; displayName: string | null; contextWindow: number; maxOutput: number; prices: Array<number | null> }> = [];
    for (const raw of body.models) {
      const entry = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null;
      const modelId = entry && typeof entry.modelId === 'string' ? entry.modelId.trim() : '';
      if (!modelId) return ctx.json(apiError('model_invalid', '每一项都必须带非空的 modelId').body, 400);
      entries.push({ modelId, displayName: typeof entry?.displayName === 'string' && entry.displayName ? entry.displayName : null,
        contextWindow: int(entry?.contextWindow) ?? fallbackWindow, maxOutput: int(entry?.maxOutput) ?? fallbackOutput,
        prices: [price(entry?.priceIn), price(entry?.priceOut), price(entry?.priceCacheRead), price(entry?.priceCacheWrite)] });
    }
    // 能力与定价出处一律在服务端重新解析：请求体里的 capabilities 是客户端说的，落库的必须是目录里实际有的那条。
    const catalog = await catalogMeta();
    // 已存在的 (provider,model) 跳过而不是覆盖 —— 覆盖会把调好的定价冲掉；补齐已有行走 /api/models/enrich。
    const insert = dependencies.db.prepare(`INSERT INTO models(id,provider_id,model_id,display_name,context_window,max_output,capabilities_json,price_in,price_out,price_cache_read,price_cache_write,enabled,sort,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,1,0,?,?) ON CONFLICT(provider_id,model_id) DO NOTHING`);
    const ids: string[] = [];
    const now = Date.now();
    const fetchedAt = typeof catalog.status.fetchedAt === 'number' ? catalog.status.fetchedAt : null;
    let priced = 0;
    dependencies.db.transaction(() => {
      for (const entry of entries) {
        const id = randomBytes(16).toString('hex');
        const meta = dependencies.modelCatalog?.lookup(catalog.index, provider, entry.modelId) ?? null;
        const capabilities = meta ? capabilityBlock(meta, fetchedAt, entry.prices[0] !== null ? meta.match : null) : '{}';
        if (insert.run(id, providerId, entry.modelId, entry.displayName, entry.contextWindow, entry.maxOutput, capabilities, ...entry.prices, now, now).changes > 0) { ids.push(id); if (entry.prices[0] !== null) priced += 1; }
      }
    })();
    dependencies.rebuildModels?.();
    return ctx.json({ ok: true, data: { inserted: ids.length, skipped: entries.length - ids.length, priced, ids } });
  });
  /** 已经导入过的模型行补元数据：能力块照写（纯信息），定价只填空着的那几个，
   *  窗口/最大输出默认不动 —— 运维可能按自己的预算调小过，覆盖要显式 overwrite。 */
  app.post('/api/models/enrich', async (ctx) => {
    const body = await ctx.req.json<{ ids?: unknown; overwrite?: unknown }>().catch((): { ids?: unknown; overwrite?: unknown } => ({}));
    const wanted = Array.isArray(body.ids) ? new Set(body.ids.filter((entry): entry is string => typeof entry === 'string')) : null;
    const overwrite = body.overwrite === true;
    const rows = dependencies.db.prepare(`SELECT m.id,m.model_id AS modelId,m.context_window AS contextWindow,m.max_output AS maxOutput,m.price_in AS priceIn,m.price_out AS priceOut,
      m.price_cache_read AS priceCacheRead,m.price_cache_write AS priceCacheWrite,p.kind,p.base_url AS baseUrl FROM models m JOIN providers p ON p.id=m.provider_id`).all() as Array<Record<string, unknown>>;
    const targets = rows.filter((row) => !wanted || wanted.has(String(row.id)));
    if (!targets.length) return ctx.json({ ok: true, data: { updated: 0, priced: 0, unmatched: 0, scanned: 0 } });
    const catalog = await catalogMeta();
    if (!catalog.index) return ctx.json(apiError('catalog_unavailable', String(catalog.status.error ?? '模型元数据目录不可用，无法补齐'), 502).body, 502);
    const fetchedAt = typeof catalog.status.fetchedAt === 'number' ? catalog.status.fetchedAt : null;
    const update = dependencies.db.prepare(`UPDATE models SET capabilities_json=?,context_window=?,max_output=?,price_in=?,price_out=?,price_cache_read=?,price_cache_write=?,updated_at=? WHERE id=?`);
    let updated = 0; let priced = 0; let unmatched = 0;
    const now = Date.now();
    dependencies.db.transaction(() => {
      for (const row of targets) {
        const meta = dependencies.modelCatalog!.lookup(catalog.index, { kind: String(row.kind), baseUrl: row.baseUrl as string | null }, String(row.modelId));
        if (meta.match === 'none') { unmatched += 1; continue; }
        const keep = (current: unknown, next: number | null): number | null => (current !== null && current !== undefined ? Number(current) : next);
        const nextPrices = [keep(row.priceIn, meta.priceIn), keep(row.priceOut, meta.priceOut), keep(row.priceCacheRead, meta.priceCacheRead), keep(row.priceCacheWrite, meta.priceCacheWrite)];
        const filled = row.priceIn === null && nextPrices[0] !== null;
        const priceSource = row.priceIn !== null ? 'manual' : nextPrices[0] !== null ? meta.match : null;
        update.run(capabilityBlock(meta, fetchedAt, priceSource),
          overwrite ? meta.contextWindow ?? Number(row.contextWindow) : Number(row.contextWindow),
          overwrite ? meta.maxOutput ?? Number(row.maxOutput) : Number(row.maxOutput),
          ...nextPrices, now, row.id);
        updated += 1;
        if (filled) priced += 1;
      }
    })();
    dependencies.rebuildModels?.();
    dependencies.log.event({ level: 'info', kind: 'webui.action', summary: 'model metadata enriched', data: { scanned: targets.length, updated, priced, unmatched, overwrite } });
    return ctx.json({ ok: true, data: { scanned: targets.length, updated, priced, unmatched } });
  });
  app.get('/api/aliases', (ctx) => ctx.json({ ok: true, data: dependencies.db.prepare('SELECT * FROM model_aliases ORDER BY alias').all() }));
  app.put('/api/aliases/:alias', async (ctx) => {
    const body = await ctx.req.json<{ modelIds?: string[]; settings?: unknown; description?: string }>();
    const alias = ctx.req.param('alias');
    if (!ALIAS_NAME_PATTERN.test(alias)) return ctx.json(apiError('alias_invalid', '别名只能是小写字母开头的 1-32 位 [a-z0-9_-]').body, 400);
    if (!Array.isArray(body.modelIds) || body.modelIds.some((id) => typeof id !== 'string')) return ctx.json(apiError('alias_invalid', 'modelIds 必须是模型 ID 数组').body, 400);
    // 空链会让别名在 registry 里静默消失（chain[0] 不存在就整条跳过），删别名要走 DELETE。
    if (!body.modelIds.length) return ctx.json(apiError('alias_invalid', 'fallback 链至少要有一个模型；要移除别名请用 DELETE').body, 400);
    const placeholders = body.modelIds.map(() => '?').join(',');
    const found = Number(dependencies.db.prepare(`SELECT COUNT(*) FROM models WHERE id IN (${placeholders})`).pluck().get(...body.modelIds));
    if (found !== body.modelIds.length) return ctx.json(apiError('alias_invalid', 'fallback 链包含不存在的模型').body, 400);
    const settings = aliasSettingsSchema.safeParse(body.settings ?? {});
    if (!settings.success) return ctx.json(apiError('alias_invalid', settings.error.issues.map((issue) => `settings${issue.path.length ? `.${issue.path.join('.')}` : ''}: ${issue.message}`).join('；')).body, 400);
    const hasSettings = Object.keys(settings.data).length > 0;
    dependencies.db.prepare(`INSERT INTO model_aliases(alias,model_ids_json,settings_json,description,updated_at) VALUES (?,?,?,?,?)
      ON CONFLICT(alias) DO UPDATE SET model_ids_json=excluded.model_ids_json,settings_json=excluded.settings_json,description=excluded.description,updated_at=excluded.updated_at`).run(alias, JSON.stringify(body.modelIds), hasSettings ? JSON.stringify(settings.data) : null, body.description ?? null, Date.now());
    dependencies.rebuildModels?.();
    return ctx.json({ ok: true });
  });
  app.delete('/api/aliases/:alias', (ctx) => {
    const changed = dependencies.db.prepare('DELETE FROM model_aliases WHERE alias=?').run(ctx.req.param('alias')).changes;
    if (!changed) return ctx.json(apiError('not_found', '别名不存在', 404).body, 404);
    dependencies.rebuildModels?.();
    return ctx.json({ ok: true });
  });
  // 触发消息自己不带 turn_id（只有回复落盘时才写那一列），可「这条消息触发的那一轮到底发了什么」
  // 恰恰是检索结果里最想点开的东西 —— 回填一次，让搜索命中也能跳到对话详情。
  const attachTurnIds = (rows: unknown[]): unknown[] => {
    const items = rows as Array<Record<string, unknown>>;
    const pending = items.filter((row) => !row.turnId).map((row) => Number(row.id));
    if (!pending.length) return items;
    const owners = new Map((dependencies.db.prepare(`SELECT trigger_message_id AS messageId,id FROM turns WHERE trigger_message_id IN (${pending.map(() => '?').join(',')})`)
      .all(...pending) as Array<{ messageId: number; id: string }>).map((row) => [row.messageId, row.id]));
    for (const row of items) if (!row.turnId) row.turnId = owners.get(Number(row.id)) ?? null;
    return items;
  };
  app.get('/api/messages', (ctx) => {
    const query = ctx.req.query('q') ?? '';
    const pageNumber = Math.max(1, Number(ctx.req.query('page') ?? 1));
    const size = Math.min(200, Math.max(1, Number(ctx.req.query('size') ?? 50)));
    const items = query ? dependencies.archive.adminSearchAll(query, pageNumber * size) : dependencies.db.prepare('SELECT id,chat_id AS chatId,message_thread_id AS threadId,tg_message_id AS tgMessageId,direction,from_kind AS fromKind,from_user_id AS fromUserId,from_name AS fromName,from_username AS fromUsername,kind,text,tg_date AS tgDate,triggered,trigger_reason AS triggerReason,turn_id AS turnId,revision,deleted_at AS deletedAt FROM messages WHERE deleted_at IS NULL ORDER BY tg_date DESC LIMIT 1000').all();
    const paged = page(items, pageNumber, size);
    // 搜索分支只取回了 page*size 条，`items.length` 不是命中总数 —— total 必须单独数（docs/20 · W-API-03）。
    const total = query ? dependencies.archive.adminSearchCount(query) : paged.total;
    return ctx.json({ ok: true, data: { ...paged, total, items: attachTurnIds(paged.items) } });
  });
  // 消息页默认看的是「最近几次模型对话」而不是逐条消息流：一次 turn 的提问与回答分散在多行里，
  // 按行翻页读不出对话的样子。分页走 SQL 的 LIMIT/OFFSET，turns 表可能很大，不整表拉回来再切。
  app.get('/api/turns', (ctx) => {
    const pageNumber = Math.max(1, Number(ctx.req.query('page') ?? 1));
    const size = Math.min(100, Math.max(1, Number(ctx.req.query('size') ?? 20)));
    const total = Number(dependencies.db.prepare('SELECT COUNT(*) FROM turns').pluck().get());
    const items = dependencies.db.prepare(`SELECT t.id,t.key,t.chat_id AS chatId,t.initiator_user_id AS userId,t.effective_role AS role,t.state,t.trigger_reason AS triggerReason,
      COALESCE(t.started_at,t.queued_at) AS startedAt,t.finished_at AS finishedAt,t.steps,t.tool_calls AS toolCalls,t.input_tokens AS inputTokens,t.output_tokens AS outputTokens,t.cost_usd AS costUsd,t.error,t.rebased,
      m.text AS prompt,m.kind AS promptKind,m.from_name AS fromName,m.from_username AS fromUsername
      FROM turns t LEFT JOIN messages m ON m.id=t.trigger_message_id
      ORDER BY COALESCE(t.started_at,t.queued_at) DESC,t.rowid DESC LIMIT ? OFFSET ?`).all(size, (pageNumber - 1) * size) as Array<Record<string, unknown>>;
    if (items.length) {
      const placeholders = items.map(() => '?').join(',');
      const replies = dependencies.db.prepare(`SELECT turn_id AS turnId,text FROM messages WHERE turn_id IN (${placeholders}) AND direction='out' AND deleted_at IS NULL ORDER BY id`)
        .all(...items.map((item) => item.id)) as Array<{ turnId: string; text: string | null }>;
      // 流式回复被切成多条 Telegram 消息时，归档里每条存的都是同一份全文（archive.append 拿的是 answer），
      // 直接拼会把回答重复 N 遍，所以按内容去重。
      const grouped = new Map<string, string[]>();
      for (const row of replies) {
        const previous = grouped.get(row.turnId) ?? [];
        if (row.text && !previous.includes(row.text)) grouped.set(row.turnId, [...previous, row.text]);
      }
      for (const item of items) item.reply = (grouped.get(String(item.id)) ?? []).join('\n\n');
    }
    return ctx.json({ ok: true, data: { items, total, page: pageNumber, size } });
  });
  // 「这一轮到底往上游发了什么」只有日志里那一份：turns 表存的是统计，messages 表存的是最终文本。
  // trace_id 就是 turn id，把该轮的 span 连同 data 一起读出来即可；超过 logs.bodyMaxBytes 的 data
  // 已经被 LogSink 挪进 logs/<day>/blobs/*.json，不跟着解引用的话详情里只剩一行 {"fileRef":…}。
  const DETAIL_MAX_CHARS = 120_000;
  interface DetailPayload { text: string | null; bytes: number; truncated: boolean; fileRef: string | null }
  const blobRef = (value: unknown): string | null => (value && typeof value === 'object' && !Array.isArray(value) && typeof (value as { fileRef?: unknown }).fileRef === 'string' ? (value as { fileRef: string }).fileRef : null);
  const readBlob = (reference: string): unknown => JSON.parse(readFileSync(safeRef(currentConfig().logs.dir, reference), 'utf8'));
  const detailPayload = (raw: string | null): DetailPayload => {
    if (!raw) return { text: null, bytes: 0, truncated: false, fileRef: null };
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return { text: raw.slice(0, DETAIL_MAX_CHARS), bytes: Buffer.byteLength(raw), truncated: raw.length > DETAIL_MAX_CHARS, fileRef: null }; }
    const reference = blobRef(parsed);
    let value = parsed;
    // 保留期一过 blobs/ 就被清掉，行还在。返回 text=null + fileRef，让界面说「载荷已清理」而不是显示那个占位对象。
    if (reference) { try { value = readBlob(reference); } catch { return { text: null, bytes: Number((parsed as { bytes?: unknown }).bytes ?? 0), truncated: false, fileRef: reference }; } }
    const text = JSON.stringify(value, null, 2) ?? '';
    return { text: text.slice(0, DETAIL_MAX_CHARS), bytes: Buffer.byteLength(text), truncated: text.length > DETAIL_MAX_CHARS, fileRef: reference };
  };
  app.get('/api/turns/:id/detail', (ctx) => {
    const id = ctx.req.param('id');
    const turn = dependencies.db.prepare(`SELECT t.id,t.key,t.chat_id AS chatId,t.initiator_user_id AS userId,t.effective_role AS role,t.state,t.trigger_reason AS triggerReason,
      COALESCE(t.started_at,t.queued_at) AS startedAt,t.finished_at AS finishedAt,t.steps,t.model_calls AS modelCalls,t.tool_calls AS toolCalls,t.input_tokens AS inputTokens,
      t.output_tokens AS outputTokens,t.cost_usd AS costUsd,t.error,t.rebased,m.text AS prompt,m.kind AS promptKind,m.from_name AS fromName,m.from_username AS fromUsername
      FROM turns t LEFT JOIN messages m ON m.id=t.trigger_message_id WHERE t.id=?`).get(id) as Record<string, unknown> | undefined;
    if (!turn) return ctx.json(apiError('not_found', '这一轮不存在（可能已被日志/数据清理）', 404).body, 404);
    const rows = dependencies.db.prepare(`SELECT id,ts,level,kind,summary,span_id AS spanId,parent_span_id AS parentSpanId,duration_ms AS durationMs,data_json AS data
      FROM log_events WHERE trace_id=? ORDER BY ts,id LIMIT 500`).all(id) as Array<Record<string, unknown> & { data: string | null }>;
    const events = rows.map(({ data, ...row }) => ({ ...row, ...detailPayload(data) }));
    return ctx.json({ ok: true, data: { turn, captureBodies: currentConfig().logs.captureBodies, events } });
  });
  app.get('/api/messages/:id', (ctx) => { const row = dependencies.db.prepare('SELECT id,chat_id AS chatId,message_thread_id AS threadId,tg_message_id AS tgMessageId,direction,from_kind AS fromKind,from_user_id AS fromUserId,from_name AS fromName,from_username AS fromUsername,kind,text,tg_date AS tgDate,triggered,trigger_reason AS triggerReason,turn_id AS turnId,revision,deleted_at AS deletedAt FROM messages WHERE id=?').get(Number(ctx.req.param('id'))); return row ? ctx.json({ ok: true, data: row }) : ctx.json(apiError('not_found', '消息不存在', 404).body, 404); });
  app.delete('/api/messages/:id', (ctx) => { const changes = dependencies.db.prepare('UPDATE messages SET deleted_at=? WHERE id=? AND deleted_at IS NULL').run(Date.now(), Number(ctx.req.param('id'))).changes; return ctx.json({ ok: true, data: { changes } }); });
  app.get('/api/files/:attachmentId', (ctx) => { const row = dependencies.db.prepare('SELECT local_path AS path,mime,file_name AS name FROM attachments WHERE id=?').get(ctx.req.param('attachmentId')) as { path: string | null; mime: string | null; name: string | null } | undefined; if (!row?.path || !existsSync(row.path)) return ctx.json(apiError('not_found', '附件不存在', 404).body, 404); return new Response(readFileSync(row.path), { headers: { 'content-type': row.mime ?? 'application/octet-stream', 'content-disposition': contentDisposition(row.name ?? ctx.req.param('attachmentId')) } }); });
  app.get('/api/chats/:key/context', (ctx) => ctx.json({ ok: true, data: dependencies.context.materialize(ctx.req.param('key'), ctx.req.query('commit') ?? null) }));
  app.get('/api/chats/:key/commits', (ctx) => ctx.json({ ok: true, data: dependencies.context.stats(ctx.req.param('key')) }));
  app.post('/api/chats/:key/commits/:id/checkout', (ctx) => ctx.json({ ok: true, data: dependencies.context.setHead(ctx.req.param('key'), ctx.req.param('id'), 'webui') }));
  app.post('/api/chats/:key/reset', (ctx) => ctx.json({ ok: true, data: dependencies.context.reset(ctx.req.param('key'), 'webui') }));
  app.post('/api/chats/:key/undo', (ctx) => ctx.json({ ok: true, data: dependencies.context.undo(ctx.req.param('key')) }));
  app.patch('/api/models/:id', async (ctx) => {
    const body = await ctx.req.json<Record<string, unknown>>();
    const map: Record<string, string> = { displayName: 'display_name', contextWindow: 'context_window', maxOutput: 'max_output', priceIn: 'price_in', priceOut: 'price_out', priceCacheRead: 'price_cache_read', priceCacheWrite: 'price_cache_write', enabled: 'enabled', sort: 'sort' };
    const entries = Object.entries(body).filter(([key]) => map[key]);
    if (!entries.length) return ctx.json({ ok: true, data: { changes: 0 } });
    const sql = entries.map(([key]) => `${map[key]}=?`).join(',');
    const values = entries.map(([key, value]) => key === 'enabled' ? (value ? 1 : 0) : value);
    const changes = dependencies.db.prepare(`UPDATE models SET ${sql},updated_at=? WHERE id=?`).run(...values, Date.now(), ctx.req.param('id')).changes;
    // 手改过价格之后还挂着「官方价」徽标就是在骗人：把出处翻成 manual，界面据此改标。
    if (changes && entries.some(([key]) => key.startsWith('price'))) {
      const row = dependencies.db.prepare('SELECT capabilities_json AS capabilities FROM models WHERE id=?').get(ctx.req.param('id')) as { capabilities: string | null } | undefined;
      try {
        const parsed = row?.capabilities ? JSON.parse(row.capabilities) as Record<string, unknown> : {};
        const catalog = parsed.catalog && typeof parsed.catalog === 'object' ? parsed.catalog as Record<string, unknown> : null;
        if (catalog) { catalog.priceSource = 'manual'; dependencies.db.prepare('UPDATE models SET capabilities_json=? WHERE id=?').run(JSON.stringify(parsed), ctx.req.param('id')); }
      } catch { /* 历史行里可能是坏 JSON，改价不该因此失败 */ }
    }
    dependencies.rebuildModels?.();
    return ctx.json({ ok: true, data: { changes } });
  });
  app.delete('/api/models/:id', (ctx) => { const changes = dependencies.db.prepare('DELETE FROM models WHERE id=?').run(ctx.req.param('id')).changes; dependencies.rebuildModels?.(); return ctx.json({ ok: true, data: { changes } }); });
  app.post('/api/principals/bulk', async (ctx) => {
    const body = await ctx.req.json<{ ids?: unknown; role?: unknown; kind?: unknown }>();
    const kind = body.kind === 'chat' ? 'chat' : 'user';
    const role = body.role;
    if (role !== 'owner' && role !== 'trusted' && role !== 'limited' && role !== 'blocked') return ctx.json(apiError('invalid_role', 'role 必须是 owner / trusted / limited / blocked 之一').body, 400);
    const raw = Array.isArray(body.ids) ? body.ids : [];
    const ids = [...new Set(raw.filter((entry): entry is string | number => typeof entry === 'string' || typeof entry === 'number').map((entry) => String(entry).trim()).filter(Boolean))];
    if (!ids.length) return ctx.json(apiError('invalid_ids', 'ids 至少要有一个 Telegram 数字 ID').body, 400);
    if (ids.length > 500) return ctx.json(apiError('invalid_ids', '单次最多导入 500 个主体').body, 400);
    // Telegram ID 是整数（群/频道为负）。放行 @username 只会写出一条永远匹配不到任何消息的主体记录。
    const malformed = ids.filter((id) => !/^-?\d{1,20}$/.test(id));
    if (malformed.length) return ctx.json(apiError('invalid_ids', `不是合法的 Telegram 数字 ID：${malformed.slice(0, 5).join('、')}${malformed.length > 5 ? ` 等 ${malformed.length} 个` : ''}`).body, 400);
    // upsertSeen 的 ON CONFLICT 分支刻意不动 role（避免每条消息把手工设的角色冲掉），
    // 所以只调它的话已存在的主体会「导入成功」却什么都没变 —— 角色必须再走一次 setRole。
    // 已存在的行也不能再走一次 upsertSeen：这里的 displayName/username 只有 null，
    // 而 ON CONFLICT 分支会照写，等于把 Telegram 那边同步来的真名清空。
    let created = 0; let updated = 0;
    dependencies.db.transaction(() => {
      for (const tgId of ids) {
        const id = `${kind}:${tgId}`;
        if (dependencies.principals.has(id)) { if (dependencies.principals.setRole(id, role, 'webui')) updated += 1; continue; }
        dependencies.principals.upsertSeen({ id, kind, tgId, role, displayName: null, username: null, chatType: null }, 'webui');
        created += 1;
      }
    })();
    dependencies.log.event({ level: 'info', kind: 'webui.action', summary: 'principals bulk import', data: { kind, role, created, updated } });
    return ctx.json({ ok: true, data: { count: ids.length, created, updated } });
  });
  // 表格里勾一批人改角色：只动已存在的主体，不建新行 —— 新建走 /api/principals/bulk（那边收的是 Telegram 数字 ID）。
  app.post('/api/principals/roles', async (ctx) => {
    const body = await ctx.req.json<{ ids?: unknown; role?: unknown }>();
    const role = body.role;
    if (role !== 'owner' && role !== 'trusted' && role !== 'limited' && role !== 'blocked') return ctx.json(apiError('invalid_role', 'role 必须是 owner / trusted / limited / blocked 之一').body, 400);
    const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean))];
    if (!ids.length) return ctx.json(apiError('invalid_ids', 'ids 至少要有一个主体 id').body, 400);
    if (ids.length > 500) return ctx.json(apiError('invalid_ids', '单次最多改 500 个主体').body, 400);
    // 不存在的 id 单独报回去而不是静默跳过：勾选来自表格，出现缺失说明这一批和库里对不上了。
    const missing: string[] = [];
    let changed = 0;
    dependencies.db.transaction(() => {
      for (const id of ids) {
        if (!dependencies.principals.has(id)) { missing.push(id); continue; }
        if (dependencies.principals.setRole(id, role, 'webui')) changed += 1;
      }
    })();
    dependencies.log.event({ level: 'info', kind: 'webui.action', summary: 'principal roles changed', data: { role, changed, missing: missing.length, ids: ids.slice(0, 50) } });
    return ctx.json({ ok: true, data: { count: ids.length, changed, missing } });
  });
  app.patch('/api/tools/:name', async (ctx) => {
    const name = ctx.req.param('name');
    const body = await ctx.req.json<{ enabled?: boolean }>();
    if (typeof body.enabled !== 'boolean') return ctx.json(apiError('invalid_tool_override', 'enabled 必须是布尔值').body, 400);
    if (!Object.hasOwn(TOOL_POLICY, name)) return ctx.json(apiError('not_found', '工具不存在', 404).body, 404);
    const key = `tools.overrides.${name}`; const now = Date.now();
    const merged = mergeDotted(currentConfig(), { [key]: { enabled: body.enabled } });
    if (!merged.ok) return ctx.json(invalidKey(merged).body, 400);
    const parsed = runtimeConfigSchema.safeParse(merged.value);
    if (!parsed.success) return ctx.json({ ok: false, error: { code: 'invalid_config', message: '工具开关校验失败', details: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) } }, 400);
    dependencies.db.prepare("INSERT INTO config_kv(key,value_json,updated_at,updated_by) VALUES (?,?,?,'webui') ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at,updated_by=excluded.updated_by").run(key, JSON.stringify({ enabled: body.enabled }), now);
    dependencies.db.prepare('INSERT INTO config_revisions(id,ts,actor,key,old_json,new_json) VALUES (?,?,?,?,?,?)').run(randomBytes(16).toString('hex'), now, 'webui', key, null, JSON.stringify({ enabled: body.enabled }));
    dependencies.events.emit('config.changed', { keys: [key] });
    return ctx.json({ ok: true, data: { name, enabled: body.enabled } });
  });
  app.get('/api/sandbox', (ctx) => ctx.json({ ok: true, data: { config: publicConfig(currentConfig().sandbox), plan: dependencies.sandbox?.plan('owner') } }));
  app.put('/api/sandbox', async (ctx) => {
    const body = await ctx.req.json<Record<string, unknown>>();
    const dotted = Object.fromEntries(Object.entries(body).map(([key, value]) => [`sandbox.${key}`, value]));
    const merged = mergeDotted(currentConfig(), dotted);
    if (!merged.ok) return ctx.json(invalidKey(merged).body, 400);
    const parsed = runtimeConfigSchema.safeParse(merged.value);
    if (!parsed.success) return ctx.json({ ok: false, error: { code: 'invalid_config', message: '沙箱配置校验失败', details: parsed.error.issues } }, 400);
    const now = Date.now();
    const write = dependencies.db.prepare("INSERT INTO config_kv(key,value_json,updated_at,updated_by) VALUES (?,?,?,'webui') ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at,updated_by=excluded.updated_by");
    dependencies.db.transaction(() => { for (const [key, value] of Object.entries(dotted)) write.run(key, JSON.stringify(value), now); })();
    dependencies.events.emit('config.changed', { keys: Object.keys(dotted) });
    return ctx.json({ ok: true, data: body });
  });
  app.post('/api/sandbox/probe', async (ctx) => ctx.json({ ok: true, data: await dependencies.sandbox?.probe() ?? { available: false, error: 'sandbox_unconfigured' } }));
  app.get('/api/prompts', (ctx) => ctx.json({ ok: true, data: dependencies.db.prepare('SELECT * FROM memory_docs ORDER BY scope,subject').all() }));
  app.get('/api/prompts/:id', (ctx) => { const row = dependencies.db.prepare('SELECT * FROM memory_docs WHERE id=?').get(ctx.req.param('id')) as { path?: string } | undefined; if (!row?.path) return ctx.json(apiError('not_found', '文档不存在', 404).body, 404); return ctx.json({ ok: true, data: { ...row, content: readFileSync(row.path, 'utf8') } }); });
  app.get('/api/prompts/:id/revisions', (ctx) => ctx.json({ ok: true, data: dependencies.db.prepare('SELECT id,doc_id AS docId,ts,actor,turn_id AS turnId,chat_id AS chatId,user_id AS userId,op,diff,bytes_after AS bytesAfter FROM memory_revisions WHERE doc_id=? ORDER BY ts DESC,id DESC LIMIT 200').all(ctx.req.param('id')) }));
  app.put('/api/prompts/:id', async (ctx) => {
    const body = await ctx.req.json<{ content?: string }>();
    const row = dependencies.db.prepare('SELECT scope,subject FROM memory_docs WHERE id=?').get(ctx.req.param('id')) as { scope: 'assist'|'character'|'pubmemory'|'primemory'; subject: string | null } | undefined;
    if (!row || !dependencies.promptDocuments) return ctx.json(apiError('not_found', '文档不存在', 404).body, 404);
    if (typeof body.content !== 'string') return ctx.json(apiError('invalid_content', 'content 必须是字符串').body, 400);
    dependencies.promptDocuments.save(row.scope, row.subject, body.content, 'webui');
    return ctx.json({ ok: true, data: { id: ctx.req.param('id'), bytes: Buffer.byteLength(body.content) } });
  });
  app.post('/api/prompts/:id/rollback', async (ctx) => {
    const body = await ctx.req.json<{ revisionId?: string }>();
    if (!body.revisionId || !dependencies.promptDocuments) return ctx.json(apiError('invalid_revision', 'revisionId 必填').body, 400);
    try { return ctx.json({ ok: true, data: dependencies.promptDocuments.rollback(ctx.req.param('id'), body.revisionId, 'webui') }); }
    catch (error) { return ctx.json(apiError('rollback_failed', error instanceof Error ? error.message : '回滚失败', 500).body, 500); }
  });
  app.post('/api/prompts/preview', async (ctx) => { const body = await ctx.req.json<{ key?: string; role?: string }>(); return ctx.json({ ok: true, data: { ...body, context: body.key ? dependencies.context.materialize(body.key, null) : null } }); });
  app.get('/api/approvals', (ctx) => ctx.json({ ok: true, data: dependencies.db.prepare('SELECT * FROM approvals ORDER BY requested_at DESC LIMIT 200').all() }));
  app.post('/api/approvals/:id/decide', async (ctx) => { const body = await ctx.req.json<{ approved: boolean }>(); return ctx.json({ ok: true, data: { changed: dependencies.approvals.decide(ctx.req.param('id'), body.approved, 'owner', 'webui') } }); });
  app.get('/api/skills', (ctx) => ctx.json({ ok: true, data: dependencies.db.prepare('SELECT * FROM skills ORDER BY name').all() }));
  app.patch('/api/skills/:name', async (ctx) => { const body = await ctx.req.json<{ enabled: boolean }>(); const changes = dependencies.db.prepare('UPDATE skills SET enabled=?,updated_at=? WHERE name=?').run(body.enabled ? 1 : 0, Date.now(), ctx.req.param('name')).changes; dependencies.skills?.scan(); return ctx.json({ ok: true, data: { changes } }); });
  app.delete('/api/skills/:name', (ctx) => ctx.json({ ok: true, data: { changes: dependencies.db.prepare('DELETE FROM skills WHERE name=?').run(ctx.req.param('name')).changes } }));
  app.get('/api/plugins', (ctx) => ctx.json({ ok: true, data: dependencies.db.prepare('SELECT * FROM plugins ORDER BY name').all() }));
  app.patch('/api/plugins/:name', async (ctx) => { const body = await ctx.req.json<{ enabled?: boolean; config?: unknown }>(); const changes = dependencies.db.prepare('UPDATE plugins SET enabled=COALESCE(?,enabled),config_json=COALESCE(?,config_json),updated_at=? WHERE name=?').run(body.enabled === undefined ? null : body.enabled ? 1 : 0, body.config === undefined ? null : JSON.stringify(body.config), Date.now(), ctx.req.param('name')).changes; await dependencies.plugins?.reconcile(); return ctx.json({ ok: true, data: { changes } }); });
  app.post('/api/plugins/:name/reload', async (ctx) => { await dependencies.plugins?.reconcile(); return ctx.json({ ok: true, data: { name: ctx.req.param('name') } }); });
  app.get('/api/mcp', (ctx) => ctx.json({ ok: true, data: dependencies.db.prepare('SELECT * FROM mcp_servers ORDER BY name').all() }));
  app.post('/api/mcp/:name/reconnect', async (ctx) => { await dependencies.mcp?.reconcile(); return ctx.json({ ok: true, data: { name: ctx.req.param('name') } }); });
  app.get('/api/agents', (ctx) => ctx.json({ ok: true, data: currentConfig().agent.agents }));
  app.get('/api/logs', (ctx) => ctx.json({ ok: true, data: dependencies.operations.logs(Math.min(1000, Number(ctx.req.query('size') ?? 200)), ctx.req.query('traceId')) }));
  app.get('/api/logs/trace/:traceId', (ctx) => ctx.json({ ok: true, data: dependencies.operations.logs(2000, ctx.req.param('traceId')) }));
  app.get('/api/logs/blob', (ctx) => { try { const path = safeRef(currentConfig().logs.dir, ctx.req.query('ref') ?? ''); return existsSync(path) ? ctx.text(readFileSync(path, 'utf8')) : ctx.json(apiError('not_found', '日志载荷不存在', 404).body, 404); } catch { return ctx.json(apiError('invalid_ref', '非法日志引用', 403).body, 403); } });
  // 对话详情里的 JSON 按 DETAIL_MAX_CHARS 截断（单个 span 的请求体能到几百 KB），排查时要能拿到完整的那一份。
  app.get('/api/logs/:id/data', (ctx) => {
    const row = dependencies.db.prepare('SELECT kind,data_json AS data FROM log_events WHERE id=?').get(Number(ctx.req.param('id'))) as { kind: string; data: string | null } | undefined;
    if (!row?.data) return ctx.json(apiError('not_found', '该事件没有载荷', 404).body, 404);
    let value: unknown;
    try { value = JSON.parse(row.data); } catch { value = row.data; }
    const reference = blobRef(value);
    if (reference) { try { value = readBlob(reference); } catch { return ctx.json(apiError('not_found', '载荷文件已被日志清理删除', 404).body, 404); } }
    return new Response(JSON.stringify(value, null, 2), { headers: { 'content-type': 'application/json; charset=utf-8', 'content-disposition': contentDisposition(`${row.kind}-${ctx.req.param('id')}.json`) } });
  });
  app.get('/api/usage', (ctx) => ctx.json({ ok: true, data: dependencies.db.prepare('SELECT * FROM usage_ledger ORDER BY ts DESC LIMIT 1000').all() }));
  app.put('/api/quota', (ctx) => ctx.json(apiError('not_implemented', '配额配置端点尚不可用', 500).body, 500));
  app.post('/api/quota/reset', (ctx) => { const changes = dependencies.db.prepare('DELETE FROM quota_counters').run().changes; return ctx.json({ ok: true, data: { changes } }); });
  app.get('/api/tasks', (ctx) => ctx.json({ ok: true, data: dependencies.db.prepare('SELECT * FROM tasks ORDER BY updated_at DESC LIMIT 500').all() }));
  app.post('/api/maintenance/:action', (ctx) => { const action = ctx.req.param('action'); if (action === 'gc-files') return ctx.json(apiError('not_implemented', '孤儿文件清理尚不可用', 500).body, 500); const result = action === 'backup' ? dependencies.maintenance.backup() : action === 'vacuum' ? (dependencies.maintenance.vacuum(), 'ok') : action === 'cleanup-logs' ? dependencies.maintenance.cleanup() : action === 'rebuild-fts' ? (dependencies.maintenance.rebuildFts(), 'ok') : null; return result === null ? ctx.json(apiError('unknown_action', '未知维护操作', 404).body, 404) : ctx.json({ ok: true, data: result }); });
  app.get('/api/events', (ctx) => { const stream = new ReadableStream({ start(controller) { const encoder = new TextEncoder(); controller.enqueue(encoder.encode(': connected\n\n')); const unsubscribe = dependencies.events.subscribe((event) => controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`))); const heartbeat = setInterval(() => controller.enqueue(encoder.encode(': ping\n\n')), 20_000); ctx.req.raw.signal.addEventListener('abort', () => { clearInterval(heartbeat); unsubscribe(); controller.close(); }, { once: true }); } }); return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' } }); });
  const webRoot = fileURLToPath(new URL('../../webui/dist', import.meta.url));
  app.use('/*', serveStatic({ root: webRoot }));
  app.get('*', (ctx) => existsSync(resolve(webRoot, 'index.html')) ? ctx.html(readFileSync(resolve(webRoot, 'index.html'), 'utf8')) : ctx.text('LuoLiCore WebUI 尚未构建', 503));
  return app;
}

export function setupToken(): { token: string; expiresAt: number } {
  return { token: randomBytes(24).toString('base64url'), expiresAt: Date.now() + 15 * 60_000 };
}
