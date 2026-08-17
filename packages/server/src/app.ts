import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import argon2 from 'argon2';
import { Hono } from 'hono';
import YAML from 'yaml';
import type { Context } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import type { AgentManager, Config, ConfigStore, ContextEngine, DatabaseApprovalBroker, EventBus, LogSink, MaintenanceService, McpManager, MemoryStore, ModelCatalog, PluginManager, PromptDocuments, ProviderStore, Sandbox, SkillLoader, SkillWriteInput, SubAgentRuntimeEvent, TurnRegistry } from '@luoli/core';
import { ALIAS_NAME_PATTERN, HOT_RELOADABLE_CONFIG_KEYS, testApprovalRules, KNOWN_UNIMPLEMENTED_CONFIG_KEYS, TOOL_POLICY, aliasSettingsSchema, checkWakeword, configSchema as runtimeConfigSchema, envPinnedConfigKeys, perChatConfig, probeProvider, quotaBucket, rejectedWakewords } from '@luoli/core';
import type { CatalogIndex, ModelMetadata, ProviderProbe } from '@luoli/core';
import type { ArchiveRepository, OperationsRepository, PrincipalRepository, Sqlite } from '@luoli/db';
import { deleteAppKv, modelAliasKey, readAppKv } from '@luoli/db';
import { assignDotted, readDotted, type Role } from '@luoli/shared';
import type { EventStreamRegistry } from './events.js';

export interface PromptPreviewResult {
  key: string;
  role: Role;
  instructions: string;
  /** `cached=false` 的块在缓存断点之后，每轮都要重新计费（docs/06 §1）。 */
  blocks: Array<{ name: string; tokens: number; content: string; truncated: boolean; cached: boolean }>;
  totalTokens: number;
  context: { messages: number; tokens: number };
}

export type AgentDryRunEvent = SubAgentRuntimeEvent
  | { type: 'final'; summary: string; fullRef: string; truncated: boolean }
  | { type: 'error'; message: string };

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
  /** 用量聚合（`GET /api/usage/report`）。缺它时那个端点回空数组而不是 500 —— 明细表照常。 */
  ledger?: { report(from: number, to: number, groupBy: 'day' | 'chat' | 'user' | 'model' | 'alias' | 'agent'): unknown[] };
  /** `POST /api/restart` 的落点。优雅关闭那套在 apps/bot，服务器包只负责把请求转过去。 */
  restart?: (reason: string) => Promise<void> | void;
  events: EventBus;
  memory?: MemoryStore;
  promptDocuments?: PromptDocuments;
  skills?: SkillLoader;
  plugins?: PluginManager;
  mcp?: McpManager;
  agents?: AgentManager;
  turnRegistry?: TurnRegistry;
  sandbox?: Sandbox;
  eventStreams?: EventStreamRegistry;
  previewPrompt?: (key: string, role: Role) => PromptPreviewResult | Promise<PromptPreviewResult>;
  dryRunAgent?: (name: string, task: string, signal: AbortSignal, emit: (event: SubAgentRuntimeEvent) => void | Promise<void>) => Promise<{ summary: string; fullRef: string; truncated: boolean }>;
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

const apiError = (code: string, message: string, status: 400 | 401 | 403 | 404 | 409 | 429 | 500 | 502 = 400) => ({ body: { ok: false as const, error: { code, message } }, status });

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

/** 可以内联渲染的 mime：只有光栅图，刻意不含 image/svg+xml（SVG 能带脚本）。 */
const INLINE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** 文件名来自 Telegram，是攻击者可控的：引号会破坏参数解析，CR/LF 会让 Response 构造直接抛错。 */
function contentDisposition(name: string): string {
  const ascii = [...name].map((char) => (char >= ' ' && char <= '~' && char !== '"' && char !== '\\' ? char : '_')).join('').slice(0, 120) || 'download';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * 系统信息里的三个占用（docs/09 §3.1）：DB 本体、WAL、workspace。**只统计不清理** ——
 * 这张卡片是「该不该去点维护操作」的判据，自己动手会让它变成一个有副作用的读端点。
 * 目录递归有深度上界：workspace 里放着模型自己造的目录树，一个软链自指就能让这次请求不返回。
 */
function directorySize(root: string, depth = 0): number {
  if (depth > 8) return 0;
  let total = 0;
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return 0; }
  for (const entry of entries) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) total += directorySize(path, depth + 1);
    else if (entry.isFile()) { try { total += statSync(path).size; } catch { /* 竞态删除 */ } }
  }
  return total;
}

function fileSize(path: string): number {
  try { return statSync(path).size; } catch { return 0; }
}

/**
 * 用量聚合按 chat / user 分组时 bucket 是裸 id，运维认不出 `-1002492583774` 是哪个群。
 * 反查规则与会话页那份一致：登记过就用显示名，没登记过就说清楚是「未登记」而不是留空。
 */
function principalLabel(db: Sqlite, kind: 'chat' | 'user', tgId: string | null): string | null {
  if (!tgId) return null;
  const row = db.prepare('SELECT display_name AS name,username FROM principals WHERE kind=? AND tg_id=?').get(kind, tgId) as { name: string | null; username: string | null } | undefined;
  if (row?.name) return row.username ? `${row.name} (@${row.username})` : row.name;
  return `未登记${kind === 'chat' ? '会话' : '用户'} ${tgId}`;
}

function diskUsage(config: Readonly<Config>): { bytes: number; walBytes: number; workspaceBytes: number } {
  return { bytes: fileSize(config.db.path), walBytes: fileSize(`${config.db.path}-wal`), workspaceBytes: directorySize(resolve(config.sandbox.workspaceDir)) };
}

function safeRef(root: string, reference: string): string {
  const absolute = resolve(root, reference);
  const base = resolve(root);
  if (absolute !== base && !absolute.startsWith(`${base}${sep}`)) throw new Error('invalid_file_ref');
  return absolute;
}

const SECRET_KEY_SEGMENT = /key|secret|token|password/i;
/**
 * 导出 / YAML 渲染时判断「这一行是不是密钥」。判据是**叶子段 + 值是非空字符串**，与
 * `publicConfig` / `revisionJson` 同一套口径 —— 拿整条点分路径去 test 会把
 * `context.limit.tokens` 也当成密钥（`/token/i` 匹配到 "tokens"），于是一份导出里
 * 静静地少了几项真配置。值不是字符串的行由 `publicConfig` 的 `«redacted»` 检查兜住。
 */
function looksSecret(key: string, value: unknown): boolean {
  return SECRET_KEY_SEGMENT.test(key.split('.').at(-1) ?? key) && typeof value === 'string' && value.length > 0;
}
function publicConfig(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(publicConfig);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, SECRET_KEY_SEGMENT.test(key) && typeof nested === 'string' && nested ? '«redacted»' : publicConfig(nested)]));
}
/**
 * 进 `config_revisions` 的那份值。`config_kv` 存真值，历史只存脱敏后的 ——
 * docs/09 §3.13 承诺「密钥类字段在写入时就已存成 «redacted»」，而按点分键写入时
 * `publicConfig` 拿不到键名（值是个裸字符串），于是密钥会明文躺在变更历史里。
 */
function revisionJson(key: string, value: unknown): string {
  const leaf = key.split('.').at(-1) ?? key;
  if (SECRET_KEY_SEGMENT.test(leaf) && typeof value === 'string' && value) return JSON.stringify('«redacted»');
  return JSON.stringify(publicConfig(value));
}
/** 旧值同样脱敏：它是从 `config_kv` 里读出来的真值。 */
function previousJson(key: string, previous: { value: string } | undefined): string | null {
  if (!previous?.value) return null;
  try { return revisionJson(key, JSON.parse(previous.value) as unknown); } catch { return null; }
}
function requestIp(ctx: { req: { header(name: string): string | undefined } }, config: Readonly<Config>): string {
  if (!config.webui.trustProxy) return ctx.req.header('x-real-ip')?.trim() || 'direct';
  const chain = ctx.req.header('x-forwarded-for')?.split(',').map((entry) => entry.trim()).filter(Boolean) ?? [];
  return chain.at(-config.webui.trustedProxyHops) ?? 'direct';
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
  const validRoles: Record<Role, true> = { owner: true, trusted: true, limited: true, blocked: true };
  /**
   * 配置写入的唯一出口：落 `config_kv` + `config_revisions`，并**删掉被这次写入吞掉的后代行**。
   * 覆盖层按点分深度应用（`sortOverrideKeys`：更具体的路径赢），所以写 `tools.overrides` 整块时若
   * 库里还留着此前逐项写下的 `tools.overrides.<name>`，那一项会把整块的对应位置局部否掉 ——
   * 界面上表现为「JSON 里明明写着开着，刷新回来还是关的」。祖先键代表整棵子树，后代行因此作废；
   * 作废也要进变更历史，否则历史会瞒下「你那条逐项覆盖是谁弄掉的」。
   * 顺带把六个写入点的四条重复语句收成一处：`PUT /api/sandbox` 此前只写 `config_kv` 不写
   * `config_revisions`，沙箱 mode / bypassRoles 这种安全相关改动压根不进「变更历史」。
   */
  const writeConfigRows = (entries: Array<[string, unknown]>, actor: string): string[] => {
    const now = Date.now();
    const keys = entries.map(([key]) => key);
    const stale = (dependencies.db.prepare('SELECT key FROM config_kv').pluck().all() as string[])
      .filter((row) => keys.some((key) => row.startsWith(`${key}.`)));
    const read = dependencies.db.prepare('SELECT value_json AS value FROM config_kv WHERE key=?');
    const write = dependencies.db.prepare(`INSERT INTO config_kv(key,value_json,updated_at,updated_by) VALUES (?,?,?,?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at,updated_by=excluded.updated_by`);
    const drop = dependencies.db.prepare('DELETE FROM config_kv WHERE key=?');
    const revision = dependencies.db.prepare('INSERT INTO config_revisions(id,ts,actor,key,old_json,new_json) VALUES (?,?,?,?,?,?)');
    dependencies.db.transaction(() => {
      for (const key of stale) {
        const previous = read.get(key) as { value: string } | undefined;
        drop.run(key);
        revision.run(randomBytes(16).toString('hex'), now, actor, key, previousJson(key, previous), null);
      }
      for (const [key, value] of entries) {
        const previous = read.get(key) as { value: string } | undefined;
        write.run(key, JSON.stringify(value), now, actor);
        revision.run(randomBytes(16).toString('hex'), now, actor, key, previousJson(key, previous), revisionJson(key, value));
      }
    })();
    return stale;
  };
  /**
   * 被环境变量钉住的键一律拒收，而不是写库之后让 `loadConfig` 悄悄交回 env 的值。
   * 祖先写入（`webui` 整块）同样命中：它对那个叶子照样不会生效。
   */
  const envConflicts = (keys: string[]): Array<{ key: string; env: string }> => envPinnedConfigKeys()
    .filter((pinned) => keys.some((key) => key === pinned.key || pinned.key.startsWith(`${key}.`) || key.startsWith(`${pinned.key}.`)));
  const envPinnedError = (conflicts: Array<{ key: string; env: string }>) => apiError('config_pinned_by_env',
    `${conflicts.map((entry) => `${entry.key} 由环境变量 ${entry.env} 决定`).join('；')} —— 改这里不会生效，请改环境变量后重启`);
  /**
   * `«redacted»` 是 `GET /api/config` 的脱敏占位符，不是任何配置项的合法值。原样发回来只可能是
   * 界面把读出来的脱敏值当真值又提交了一遍（`mcp.servers` 那种整块 JSON 里就嵌着它）——
   * 收下就等于把真密钥替换成这五个字，且 `config_kv` 里那行会一直赢。
   */
  const redactedKeys = (body: Record<string, unknown>): string[] => Object.entries(body)
    .filter(([, value]) => JSON.stringify(value ?? null).includes('«redacted»')).map(([key]) => key);
  const persistMcpServers = (servers: unknown[]): { ok: true; servers: Readonly<Config['mcp']['servers']> } | { ok: false; details: unknown } => {
    const merged = mergeDotted(currentConfig(), { 'mcp.servers': servers });
    if (!merged.ok) return { ok: false, details: [{ path: merged.key, message: '非法配置键' }] };
    const parsed = runtimeConfigSchema.safeParse(merged.value);
    if (!parsed.success) return { ok: false, details: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) };
    const key = 'mcp.servers';
    writeConfigRows([[key, parsed.data.mcp.servers]], 'webui');
    if ('replace' in dependencies.config) dependencies.config.replace(parsed.data, [key]);
    dependencies.events.emit('config.changed', { keys: [key] });
    return { ok: true, servers: parsed.data.mcp.servers };
  };
  // 刚写进 config_kv、但 config.changed 的重载还没落到 configStore 的那一份口令。只在「快照仍是
  // 写入前那个值」时顶上；快照一旦变成别的（比如 PUT /api/config 又改了一次），立刻交回配置——
  // 无条件缓存就是 V-AUTH-02 换个位置复发：写入返回 200，登录还认旧的（docs/24 · R-AUTH-01）。
  let pendingHash: { next: string; previous: string } | null = null;
  const activePasswordHash = (): string => {
    const stored = currentConfig().webui.passwordHash;
    if (!pendingHash) return stored;
    if (stored === pendingHash.previous) return pendingHash.next;
    pendingHash = null;
    return stored;
  };
  const failures = new Map<string, { count: number; lockedUntil: number; touchedAt: number }>();
  let globalFailures: number[] = [];
  const pruneFailures = (now: number, windowMs: number): void => {
    globalFailures = globalFailures.filter((at) => now - at < windowMs);
    for (const [key, entry] of failures) if (entry.lockedUntil <= now && now - entry.touchedAt >= windowMs) failures.delete(key);
    while (failures.size > 1024) failures.delete(failures.keys().next().value!);
  };

  app.use('*', async (ctx, next) => {
    // `frame-ancestors` 写进 CSP 而不是只靠 `X-Frame-Options`（后者已过时，且不覆盖嵌套框架）；
    // `object-src` 挡 <embed>/<object>，`base-uri` 挡注入 <base> 改写所有相对 URL，
    // `form-action` 挡把表单 POST 到外站（docs/22 · I-12）。X-Frame-Options 保留给老浏览器。
    ctx.header('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
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
    const body = await ctx.req.json<{ token?: string; password?: string }>().catch((): { token?: string; password?: string } => ({}));
    const expected = dependencies.setup?.token ?? '';
    const validToken = Boolean(dependencies.setup && Date.now() <= dependencies.setup.expiresAt && body.token && body.token.length === expected.length && timingSafeEqual(Buffer.from(body.token), Buffer.from(expected)));
    if (!validToken) return ctx.json(apiError('invalid_setup', 'Setup token is invalid', 403).body, 403);
    if (!body.password || body.password.length < 12 || body.password.length > 1024) return ctx.json(apiError('weak_password', 'Password must contain 12–1024 characters').body, 400);
    const hash = await argon2.hash(body.password, { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
    pendingHash = { next: hash, previous: currentConfig().webui.passwordHash };
    const now = Date.now();
    dependencies.db.prepare(`INSERT INTO config_kv(key,value_json,updated_at,updated_by) VALUES ('webui.passwordHash',?,?,?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at,updated_by=excluded.updated_by`).run(JSON.stringify(hash), now, 'setup');
    dependencies.db.prepare('INSERT INTO config_revisions(id,ts,actor,key,old_json,new_json) VALUES (?,?,?,?,?,?)').run(randomBytes(16).toString('hex'), now, 'setup', 'webui.passwordHash', JSON.stringify(''), JSON.stringify('«redacted»'));
    dependencies.setup = undefined;
    dependencies.events.emit('config.changed', { keys: ['webui.passwordHash'] });
    const session = dependencies.operations.createSession(currentConfig().webui.sessionTtlHours, requestIp(ctx, currentConfig()), ctx.req.header('user-agent'));
    const secure = requestIsSecure(ctx, currentConfig()) ? '; Secure' : '';
    ctx.header('Set-Cookie', `luoli_sid=${encodeURIComponent(session.id)}; HttpOnly; SameSite=Strict; Path=/${secure}`);
    return ctx.json({ ok: true, data: { csrf: session.csrf, expiresAt: session.expiresAt } });
  });

  app.post('/api/auth/login', async (ctx) => {
    const now = Date.now();
    const webui = currentConfig().webui;
    const windowMs = webui.loginRateLimit.windowMinutes * 60_000;
    pruneFailures(now, windowMs);
    const ip = requestIp(ctx, currentConfig());
    const failure = failures.get(ip);
    if (failure && failure.lockedUntil > now) return ctx.json(apiError('locked', '登录失败次数过多，请稍后再试', 429).body, 429);
    if (globalFailures.length >= webui.loginRateLimit.attempts * 20) {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 250);
      await promise;
    }
    const body = await ctx.req.json<{ password?: string }>().catch((): { password?: string } => ({}));
    if (!body.password || body.password.length > 1024) return ctx.json(apiError('invalid_credentials', '密码错误', 401).body, 401);
    let valid = false;
    try { const hash = activePasswordHash(); valid = Boolean(hash && await argon2.verify(hash, body.password)); } catch { valid = false; }
    if (!valid) {
      const count = (failure?.count ?? 0) + 1;
      failures.delete(ip);
      failures.set(ip, { count, lockedUntil: count >= webui.loginRateLimit.attempts ? now + windowMs : 0, touchedAt: now });
      globalFailures.push(now);
      dependencies.log.event({ level: 'warn', kind: 'webui.action', summary: 'login failed', data: { ip } });
      return ctx.json(apiError('invalid_credentials', '密码错误', 401).body, 401);
    }
    failures.delete(ip);
    const session = dependencies.operations.createSession(webui.sessionTtlHours, ip, ctx.req.header('user-agent'));
    const secure = requestIsSecure(ctx, currentConfig()) ? '; Secure' : '';
    ctx.header('Set-Cookie', `luoli_sid=${encodeURIComponent(session.id)}; HttpOnly; SameSite=Strict; Path=/${secure}`);
    return ctx.json({ ok: true, data: { csrf: session.csrf, expiresAt: session.expiresAt } });
  });

  /**
   * Telegram `/webui` 发来的一次性登录（docs/09 §2.3）。token **存在内存里**：进程重启即失效，
   * 而且它就该是这个语义 —— 一条能换取 owner 全权限 session 的链接落进数据库或日志，
   * 泄露面比口令本身还大。所以这里也**不记 token 本身**，只记用掉/失败这件事。
   *
   * 三道闸：单次使用（取出即删）、5 分钟过期、常量时间比较。
   */
  app.post('/api/auth/token', async (ctx) => {
    const body = await ctx.req.json<{ token?: string }>().catch((): { token?: string } => ({}));
    const now = Date.now();
    for (const [value, entry] of loginTokens) if (entry.expiresAt <= now) loginTokens.delete(value);
    const supplied = typeof body.token === 'string' ? body.token : '';
    // 先删再判：一个错误的 token 不该让攻击者反复试同一个值。
    const entry = supplied ? loginTokens.get(supplied) : undefined;
    if (entry) loginTokens.delete(supplied);
    if (!entry || entry.expiresAt <= now) {
      dependencies.log.event({ level: 'warn', kind: 'webui.action', summary: 'one-time login token rejected', data: { ip: requestIp(ctx, currentConfig()) } });
      return ctx.json(apiError('invalid_token', '登录链接无效或已过期', 401).body, 401);
    }
    const webui = currentConfig().webui;
    const session = dependencies.operations.createSession(webui.sessionTtlHours, requestIp(ctx, currentConfig()), ctx.req.header('user-agent'));
    const secure = requestIsSecure(ctx, currentConfig()) ? '; Secure' : '';
    ctx.header('Set-Cookie', `luoli_sid=${encodeURIComponent(session.id)}; HttpOnly; SameSite=Strict; Path=/${secure}`);
    dependencies.log.event({ level: 'info', kind: 'webui.action', summary: 'logged in via one-time token' });
    return ctx.json({ ok: true, data: { csrf: session.csrf, expiresAt: session.expiresAt } });
  });

  app.use('/api/*', async (ctx, next) => {
    if (ctx.req.path === '/api/health' || ctx.req.path === '/api/auth/login' || ctx.req.path === '/api/auth/token' || ctx.req.path === '/api/setup') return next();
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
  app.post('/api/auth/password', async (ctx) => {
    const body = await ctx.req.json<{ current?: string; next?: string }>().catch((): { current?: string; next?: string } => ({}));
    // WEBUI_PASSWORD 在环境里时，改口令写得进 config_kv、当前进程也认新口令，但重启后 envOverlay
    // 会把 env 那份哈希再盖回来 —— 那是「改了口令以为安全了」的最坏形态，宁可当场拒绝（摘除比伪造安全）。
    const pinned = envConflicts(['webui.passwordHash']);
    if (pinned.length) return ctx.json(apiError('password_pinned_by_env', '口令由环境变量 WEBUI_PASSWORD 固定：在这里改，重启后会被环境变量盖回去。请改环境变量（或清掉它后再用这里）。', 409).body, 409);
    if (!body.current || body.current.length > 1024 || !body.next || body.next.length < 12 || body.next.length > 1024) return ctx.json(apiError('invalid_password', '新口令必须为 12–1024 个字符').body, 400);
    let valid = false;
    try { const hash = activePasswordHash(); valid = Boolean(hash && await argon2.verify(hash, body.current)); } catch { valid = false; }
    if (!valid) return ctx.json(apiError('invalid_credentials', '当前口令错误', 401).body, 401);
    const nextHash = await argon2.hash(body.next, { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
    const now = Date.now();
    const staleHash = currentConfig().webui.passwordHash;
    const currentSession = ctx.get('sessionId');
    const previous = dependencies.db.prepare('SELECT value_json AS value FROM config_kv WHERE key=?').get('webui.passwordHash') as { value: string } | undefined;
    dependencies.db.transaction(() => {
      dependencies.db.prepare("INSERT INTO config_kv(key,value_json,updated_at,updated_by) VALUES ('webui.passwordHash',?,?,'webui') ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at,updated_by=excluded.updated_by").run(JSON.stringify(nextHash), now);
      dependencies.db.prepare('INSERT INTO config_revisions(id,ts,actor,key,old_json,new_json) VALUES (?,?,?,?,?,?)').run(randomBytes(16).toString('hex'), now, 'webui', 'webui.passwordHash', previous?.value ? JSON.stringify('«redacted»') : null, JSON.stringify('«redacted»'));
      dependencies.db.prepare('DELETE FROM sessions WHERE id<>?').run(currentSession);
    })();
    pendingHash = { next: nextHash, previous: staleHash };
    dependencies.events.emit('config.changed', { keys: ['webui.passwordHash'] });
    return ctx.json({ ok: true, data: { sessionsRevoked: true } });
  });
  app.get('/api/health/detail', (ctx) => {
    let dbOk = true;
    try { dependencies.db.prepare('SELECT 1').get(); } catch { dbOk = false; }
    const providers = dependencies.providers.list() as Array<{ enabled?: number; healthState?: string | null }>;
    const mcp = dependencies.db.prepare('SELECT name,state,last_error AS error FROM mcp_servers ORDER BY name').all();
    return ctx.json({ ok: dbOk, data: { ok: dbOk, version: process.env.npm_package_version ?? 'dev', uptimeMs: Date.now() - dependencies.startedAt,
      db: { ok: dbOk, ...diskUsage(currentConfig()) }, providers, mcp, sandbox: dependencies.sandbox?.plan('trusted') ?? { allowed: false }, inFlightTurns: dependencies.turnRegistry?.size ?? 0 } });
  });
  app.post('/api/auth/logout', (ctx) => {
    dependencies.operations.deleteSession(ctx.get('sessionId'));
    ctx.header('Set-Cookie', 'luoli_sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    return ctx.json({ ok: true });
  });
  // SPA 只把 csrf 放在内存里，刷新页面就丢了；不在这里发回去，刷新之后每个写操作都是 403。
  // 这不削弱 CSRF 防护：跨站请求既读不到响应（无 CORS 放行），也过不了上面的 Origin 中间件。
  app.get('/api/auth/me', (ctx) => ctx.json({ ok: true, data: { role: 'owner', csrf: ctx.get('csrf'), expiresAt: dependencies.operations.session(ctx.get('sessionId'))?.expiresAt ?? null } }));
  app.get('/api/dashboard', (ctx) => ctx.json({ ok: true, data: dependencies.operations.dashboard(currentConfig().general.timezone) }));
  app.get('/api/chats', (ctx) => ctx.json({ ok: true, data: dependencies.db.prepare(`SELECT c.key,c.chat_id AS chatId,c.thread_id AS threadId,c.scope,c.claim_watermark AS claimWatermark,
    cc.head_ordinal AS headOrdinal,cc.tokens_total AS tokens,cc.msg_count AS messages FROM contexts c LEFT JOIN refs r ON r.key=c.key AND r.name='done' LEFT JOIN context_commits cc ON cc.id=r.commit_id ORDER BY c.updated_at DESC`).all() }));
  app.get('/api/config', (ctx) => ctx.json({ ok: true, data: publicConfig(currentConfig()) }));
  // 带上热更新前缀：不在 hotReloadable 里的键保存后需要重启才生效，WebUI 据此显示待重启徽标
  // ——「保存成功」但运行时没变，是 docs/20 · W-CFG-02 里最误导的一类。
  // 三件套一律放进 `data`：统一信封的客户端只解 `data`，挂在信封顶层的兄弟键会被静默丢掉 ——
  // 自动生成的表单正是靠这两份前缀表判断「热更新 / 需重启」与「未接线」的。
  // `envPinned` 是第三份前缀表：这些键的 config_kv 行会被 env 层压掉，表单据此禁控件并点名环境变量。
  app.get('/api/config/schema', (ctx) => ctx.json({ ok: true, data: { schema: dependencies.configSchema, hotReloadable: HOT_RELOADABLE_CONFIG_KEYS, unimplemented: KNOWN_UNIMPLEMENTED_CONFIG_KEYS, envPinned: envPinnedConfigKeys() } }));
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
    const pinned = envConflicts(Object.keys(body));
    if (pinned.length) return ctx.json(envPinnedError(pinned).body, 400);
    const redacted = redactedKeys(body);
    if (redacted.length) return ctx.json(apiError('redacted_placeholder', `${redacted.join('、')} 的值里含脱敏占位符 «redacted» —— 那不是真值，写进去会把真密钥覆盖掉`).body, 400);
    const merged = mergeDotted(currentConfig(), body);
    if (!merged.ok) return ctx.json(invalidKey(merged).body, 400);
    const parsed = runtimeConfigSchema.safeParse(merged.value);
    if (!parsed.success) return ctx.json({ ok: false, error: { code: 'invalid_config', message: '配置校验失败', details: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) } }, 400);
    if (Object.keys(body).some((key) => key === 'trigger' || key.startsWith('trigger.'))) {
      const rejected = rejectedWakewords(parsed.data.trigger.wakewords, parsed.data.trigger.wakewordMinLength);
      if (rejected.length) return ctx.json(apiError('invalid_wakeword', `唤醒词不会生效：${rejected.join('；')}`).body, 400);
    }
    // 落库的是**校验后**的值，不是请求体原值：zod 的默认值与强制转换否则不会进 `config_kv`，
    // 下次启动重放覆盖层拿到的就是另一份东西（docs/22 · I-06）。键仍以请求体为准 ——
    // 「只发真正改过的那几项」是这个端点的契约，不能顺手把整棵树写下去。
    const rows: Array<[string, unknown]> = Object.keys(body).map((key) => [key, readDotted(parsed.data, key)]);
    // JSON 里表达不出 undefined，所以校验后取不到值只有一个原因：这个路径不在 schema 里，被 zod
    // 整段剥掉了。此前这种键会照样落进 `config_kv`，`loadConfig` 下次启动再逐条剔除并告警 ——
    // 那是兜底不是许可（CLAUDE.md）。当场拒掉，别让「保存成功」把垃圾键留在库里。
    const unknownKeys = rows.filter(([, value]) => value === undefined).map(([key]) => key);
    if (unknownKeys.length) return ctx.json(apiError('unknown_config_key', `${unknownKeys.join('、')} 不是 schema 里的配置路径`).body, 400);
    const subsumed = writeConfigRows(rows, 'webui');
    dependencies.events.emit('config.changed', { keys: Object.keys(body) });
    // `subsumed` 交回前端点名：整块写入作废掉的逐项覆盖必须说出来，否则运维只会看到「保存成功」，
    // 而工具页上某个开关的状态被这次保存悄悄改掉了。
    return ctx.json({ ok: true, data: { keys: Object.keys(body), subsumed } });
  });
  /**
   * `modelAlias` 是 Telegram `/model` 写进 `app_kv` 的那份会话别名，它**压过** WebUI 能改的
   * `perChat.<key>.agent.main.modelAlias` 与全局 `agent.main.modelAlias`（`runtime.ts` 先读它）。
   * 界面上此前只有一行小字提到这件事，运维改了全局别名却不生效时无从下手 —— 现在能看见也能清掉。
   */
  app.get('/api/chats/:key', (ctx) => {
    const key = ctx.req.param('key');
    return ctx.json({ ok: true, data: { ...dependencies.context.stats(key), modelAlias: readAppKv<string>(dependencies.db, modelAliasKey(key)) ?? null } });
  });
  app.delete('/api/chats/:key/model-alias', (ctx) => {
    const key = ctx.req.param('key');
    const changes = deleteAppKv(dependencies.db, modelAliasKey(key));
    return ctx.json({ ok: true, data: { cleared: changes > 0 } });
  });
  app.patch('/api/chats/:key', async (ctx) => {
    const body = await ctx.req.json<Record<string, unknown>>(); const key = `perChat.${ctx.req.param('key')}`;
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
    writeConfigRows([[key, body]], 'webui');
    dependencies.events.emit('config.changed', { keys: [key] }); return ctx.json({ ok: true, data: body });
  });
  app.get('/api/config/revisions', (ctx) => ctx.json({ ok: true, data: dependencies.db.prepare('SELECT * FROM config_revisions ORDER BY ts DESC LIMIT 500').all() }));
  /**
   * 配置导出（docs/09 §3.13）。导的是 **`config_kv` 里的覆盖层**，不是合并后的全量配置 ——
   * 全量里绝大多数是代码默认值，导进另一个部署等于把那一刻的默认值全部钉死，此后升级
   * 再也拿不到新默认。密钥类键（`publicConfig` 那套判据）直接**不导出**而不是导成
   * `«redacted»`：导成占位符的话，导入端会把真密钥覆盖成一个字面量。
   */
  app.get('/api/config/export', (ctx) => {
    const rows = dependencies.db.prepare('SELECT key,value_json AS value FROM config_kv ORDER BY key').all() as Array<{ key: string; value: string }>;
    const overrides: Record<string, unknown> = {};
    const skipped: string[] = [];
    for (const row of rows) {
      const value = JSON.parse(row.value) as unknown;
      if (looksSecret(row.key, value)) { skipped.push(row.key); continue; }
      const cleaned = publicConfig(value);
      // 整块写入（`mcp.servers`）里也可能埋着密钥字段，`publicConfig` 会把它们变成占位符 ——
      // 那种块同样不能导。
      if (JSON.stringify(cleaned).includes('«redacted»')) { skipped.push(row.key); continue; }
      overrides[row.key] = value;
    }
    return ctx.json({ ok: true, data: { exportedAt: Date.now(), overrides, skipped } });
  });
  /**
   * `[原始 YAML]` 模式（docs/09 §3.13）。**解析在服务端**：`loadConfig` 用的就是这个 YAML
   * 解析器，放到前端等于让两处方言各自漂移（缩进 tab、锚点、`yes/no` 当布尔这些边角都有差异），
   * 而「界面上过了、启动时炸了」是最难查的一类。顺带省掉前端 40KB 的 yaml bundle。
   *
   * GET 渲染的是**覆盖层**而不是合并后的全量 —— 与导出同一个理由：全量里绝大多数是代码默认值。
   */
  app.get('/api/config/yaml', (ctx) => {
    const rows = dependencies.db.prepare('SELECT key,value_json AS value FROM config_kv ORDER BY key').all() as Array<{ key: string; value: string }>;
    const tree: Record<string, unknown> = {};
    const skipped: string[] = [];
    for (const row of rows) {
      const value = JSON.parse(row.value) as unknown;
      if (looksSecret(row.key, value) || JSON.stringify(publicConfig(value)).includes('«redacted»')) { skipped.push(row.key); continue; }
      assignDotted(tree, row.key, value);
    }
    return ctx.json({ ok: true, data: { yaml: YAML.stringify(tree, { indent: 2 }), skipped } });
  });
  app.put('/api/config/yaml', async (ctx) => {
    const body = await ctx.req.json<{ yaml?: string }>().catch(() => null);
    if (typeof body?.yaml !== 'string') return ctx.json(apiError('invalid_body', 'body 需要 { yaml: "…" }').body, 400);
    let tree: unknown;
    try { tree = YAML.parse(body.yaml) ?? {}; }
    catch (error) {
      // yaml 的错误自带 linePos —— 把行号交回去，界面才能「错误定位到行」。
      const cause = error as { message?: string; linePos?: Array<{ line: number; col: number }> };
      const at = cause.linePos?.[0];
      return ctx.json({ ok: false, error: { code: 'invalid_yaml', message: cause.message ?? 'YAML 解析失败', ...(at ? { line: at.line, column: at.col } : {}) } }, 400);
    }
    if (!tree || typeof tree !== 'object' || Array.isArray(tree)) return ctx.json(apiError('invalid_yaml', '顶层必须是一个映射（key: value），不是数组或标量').body, 400);
    const parsed = runtimeConfigSchema.safeParse(tree);
    if (!parsed.success) return ctx.json({ ok: false, error: { code: 'invalid_config', message: '配置校验失败', details: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) } }, 400);
    // 落库仍是**顶层段**的逐段覆盖，而不是一整棵树写成一行：`config_kv` 的粒度是点分键，
    // 写成一行 `''` 会让工具页那种更细的覆盖全部被作废（G-CFG-02 的整块吞并问题）。
    const sections = Object.keys(tree as Record<string, unknown>);
    const pinnedConflicts = envConflicts(sections);
    const applicable = sections.filter((key) => !pinnedConflicts.some((entry) => key === entry.key || entry.key.startsWith(`${key}.`)));
    const rows: Array<[string, unknown]> = applicable.map((key) => [key, readDotted(parsed.data, key)]);
    const unknownSections = rows.filter(([, value]) => value === undefined).map(([key]) => key);
    if (unknownSections.length) return ctx.json(apiError('unknown_config_key', `${unknownSections.join('、')} 不是 schema 里的配置段`).body, 400);
    const subsumed = writeConfigRows(rows, 'webui:yaml');
    dependencies.events.emit('config.changed', { keys: applicable });
    return ctx.json({ ok: true, data: { keys: applicable, skipped: pinnedConflicts.map((entry) => entry.key), subsumed } });
  });
  /**
   * 配置导入：走和 `PUT /api/config` 完全一样的校验与落库路径（点分键 → mergeDotted →
   * `runtimeConfigSchema` → `writeConfigRows`），只是一次多条。**不是恢复快照** ——
   * 导入不删除现有覆盖行，只按键覆盖；要清空得自己去改那几项。
   */
  app.post('/api/config/import', async (ctx) => {
    const body = await ctx.req.json<{ overrides?: Record<string, unknown> }>().catch(() => null);
    const overrides = body?.overrides;
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return ctx.json(apiError('invalid_body', 'body 需要 { overrides: { 点分键: 值 } }').body, 400);
    const keys = Object.keys(overrides);
    if (!keys.length) return ctx.json({ ok: true, data: { keys: [], skipped: [] } });
    // 被 env 钉住的键不该让整次导入失败：跳过并点名，比让人先去删环境变量再导一次好。
    const conflicts = envConflicts(keys);
    const pinned = new Set(conflicts.map((entry) => entry.key));
    const applicable = keys.filter((key) => !conflicts.some((entry) => key === entry.key || key.startsWith(`${entry.key}.`) || entry.key.startsWith(`${key}.`)));
    const merged = mergeDotted(currentConfig(), Object.fromEntries(applicable.map((key) => [key, overrides[key]])));
    if (!merged.ok) return ctx.json(invalidKey(merged).body, 400);
    const parsed = runtimeConfigSchema.safeParse(merged.value);
    if (!parsed.success) return ctx.json({ ok: false, error: { code: 'invalid_config', message: '导入的配置校验失败', details: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) } }, 400);
    const rows: Array<[string, unknown]> = applicable.map((key) => [key, readDotted(parsed.data, key)]);
    const unknownKeys = rows.filter(([, value]) => value === undefined).map(([key]) => key);
    if (unknownKeys.length) return ctx.json(apiError('unknown_config_key', `${unknownKeys.join('、')} 不是 schema 里的配置路径`).body, 400);
    const subsumed = writeConfigRows(rows, 'webui:import');
    dependencies.events.emit('config.changed', { keys: applicable });
    return ctx.json({ ok: true, data: { keys: applicable, skipped: [...pinned], subsumed } });
  });
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
    return { row, adhoc, result: await probeProvider({ name: row.name, kind, baseUrl, headers }, apiKey, 15_000, currentConfig().provider.allowPrivateBaseUrl) };
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
    if (!adhoc) dependencies.events.emit('health', { source: 'provider', name: row.name, ok: result.reachable, code: result.code });
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
  // 图片与文件此前在管理端完全不可见：消息行不带 attachment id，界面上也就没有任何地方能点开
  // （docs/21 · G-API-08）。一次 IN 查询按 message_id 归组，不返回 local_path ——
  // 磁盘路径对界面没用，泄漏出去只是白送一份部署布局。
  const withAttachments = (rows: unknown[]): unknown[] => {
    const items = rows as Array<Record<string, unknown>>;
    const ids = [...new Set(items.map((row) => Number(row.id)).filter((id) => Number.isInteger(id)))];
    if (!ids.length) return items;
    const grouped = new Map<number, Array<Record<string, unknown>>>();
    for (const row of dependencies.db.prepare(`SELECT id,message_id AS messageId,kind,mime,file_name AS fileName,size_bytes AS sizeBytes,width,height,
      duration_sec AS durationSec,download_state AS downloadState,download_error AS downloadError,extract_state AS extractState,
      local_path IS NOT NULL AS hasLocal FROM attachments WHERE message_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`).all(...ids) as Array<Record<string, unknown>>) {
      const list = grouped.get(Number(row.messageId)) ?? [];
      list.push(row);
      grouped.set(Number(row.messageId), list);
    }
    for (const row of items) row.attachments = grouped.get(Number(row.id)) ?? [];
    return items;
  };
  app.get('/api/messages', (ctx) => {
    const query = ctx.req.query('q') ?? '';
    const pageNumber = Math.max(1, Number(ctx.req.query('page') ?? 1));
    const size = Math.min(200, Math.max(1, Number(ctx.req.query('size') ?? 50)));
    // 非搜索分支此前是 `LIMIT 1000` 拉回来再在内存里切：`size=50` 时第 21 页起永远是空的，
    // `total` 也封顶在 1000，界面上的页码是假的（docs/22 · I-01）。改成和 /api/turns 一样
    // 走 SQL 的 LIMIT/OFFSET + 单独 COUNT(*)。搜索分支仍走 FTS，它自己有命中上限。
    if (!query) {
      const total = Number(dependencies.db.prepare('SELECT COUNT(*) FROM messages WHERE deleted_at IS NULL').pluck().get());
      const items = dependencies.db.prepare(`SELECT id,chat_id AS chatId,message_thread_id AS threadId,tg_message_id AS tgMessageId,direction,from_kind AS fromKind,from_user_id AS fromUserId,from_name AS fromName,from_username AS fromUsername,kind,text,tg_date AS tgDate,triggered,trigger_reason AS triggerReason,turn_id AS turnId,revision,deleted_at AS deletedAt
        FROM messages WHERE deleted_at IS NULL ORDER BY tg_date DESC,id DESC LIMIT ? OFFSET ?`).all(size, (pageNumber - 1) * size);
      return ctx.json({ ok: true, data: { page: pageNumber, size, total, items: withAttachments(attachTurnIds(items)) } });
    }
    const paged = page(dependencies.archive.adminSearchAll(query, pageNumber * size), pageNumber, size);
    // 搜索分支只取回了 page*size 条，`items.length` 不是命中总数 —— total 必须单独数（docs/20 · W-API-03）。
    return ctx.json({ ok: true, data: { ...paged, total: dependencies.archive.adminSearchCount(query), items: withAttachments(attachTurnIds(paged.items)) } });
  });
  // 消息页默认看的是「最近几次模型对话」而不是逐条消息流：一次 turn 的提问与回答分散在多行里，
  // 按行翻页读不出对话的样子。分页走 SQL 的 LIMIT/OFFSET，turns 表可能很大，不整表拉回来再切。
  app.get('/api/turns', (ctx) => {
    const pageNumber = Math.max(1, Number(ctx.req.query('page') ?? 1));
    const size = Math.min(100, Math.max(1, Number(ctx.req.query('size') ?? 20)));
    const total = Number(dependencies.db.prepare('SELECT COUNT(*) FROM turns').pluck().get());
    const items = dependencies.db.prepare(`SELECT t.id,t.key,t.chat_id AS chatId,t.initiator_user_id AS userId,t.effective_role AS role,t.state,t.trigger_reason AS triggerReason,
      COALESCE(t.started_at,t.queued_at) AS startedAt,t.finished_at AS finishedAt,t.steps,t.tool_calls AS toolCalls,t.input_tokens AS inputTokens,t.output_tokens AS outputTokens,t.cost_usd AS costUsd,t.error,t.rebased,
      m.id AS promptMessageId,m.text AS prompt,m.kind AS promptKind,m.from_name AS fromName,m.from_username AS fromUsername
      FROM turns t LEFT JOIN messages m ON m.id=t.trigger_message_id AND m.deleted_at IS NULL
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
      // 附件挂在触发消息上，不是 turn 上：借 promptMessageId 走同一条归组逻辑，再搬回 turn 行。
      const carriers: Array<Record<string, unknown>> = items.filter((item) => item.promptMessageId !== null).map((item) => ({ id: item.promptMessageId }));
      withAttachments(carriers);
      const byMessage = new Map(carriers.map((row) => [Number(row.id), row.attachments]));
      for (const item of items) item.attachments = byMessage.get(Number(item.promptMessageId)) ?? [];
    }
    return ctx.json({ ok: true, data: { items, total, page: pageNumber, size } });
  });
  // 在途 turn 的权威来源是进程内的 TurnRegistry，不是 turns 表：崩溃残留的 running 行要等
  // 下次启动的 recoverAfterCrash 才归零，只读表会把它们也画成「正在跑」。步数与花费仍来自表
  // （记账侧一直在写），一次 IN 查询取回。
  app.get('/api/turns/active', (ctx) => {
    const active = dependencies.turnRegistry?.list() ?? [];
    if (!active.length) return ctx.json({ ok: true, data: [] });
    const stats = new Map((dependencies.db.prepare(`SELECT id,steps,tool_calls AS toolCalls,cost_usd AS costUsd,input_tokens AS inputTokens,output_tokens AS outputTokens
      FROM turns WHERE id IN (${active.map(() => '?').join(',')})`).all(...active.map((turn) => turn.id)) as Array<Record<string, unknown>>).map((row) => [String(row.id), row]));
    return ctx.json({ ok: true, data: active.map((turn) => ({ id: turn.id, key: turn.key, chatId: turn.chatId, userId: turn.userId, role: turn.role, startedAt: turn.startedAt,
      steps: 0, toolCalls: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, ...stats.get(turn.id) })) });
  });
  // WebUI 此前没有任何取消通道：Telegram 侧有 /cancel 与流式消息上的取消按钮，管理端只能干等
  // 到 concurrency.turnTimeoutMs（docs/21 · G-SRV-01）。取消是 abort 信号，不是删除：
  // 该轮走 abortTurn 落成 cancelled，上下文与已发出的消息都还在。
  app.post('/api/turns/:id/cancel', (ctx) => {
    if (!dependencies.turnRegistry) return ctx.json(apiError('not_implemented', '这个部署没有装配 TurnRegistry，无法取消', 500).body, 500);
    // WebUI 是单角色 owner（GET /api/auth/me），owner 可以取消任何人的轮次。
    const cancelled = dependencies.turnRegistry.cancel(ctx.req.param('id'), 'webui', 'owner');
    dependencies.log.event({ level: 'info', kind: 'turn.cancel', summary: cancelled ? 'turn cancelled from webui' : 'turn already finished', traceId: ctx.req.param('id'), data: { cancelled } });
    return ctx.json({ ok: true, data: { cancelled } });
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
      FROM turns t LEFT JOIN messages m ON m.id=t.trigger_message_id AND m.deleted_at IS NULL WHERE t.id=?`).get(id) as Record<string, unknown> | undefined;
    if (!turn) return ctx.json(apiError('not_found', '这一轮不存在（可能已被日志/数据清理）', 404).body, 404);
    const rows = dependencies.db.prepare(`SELECT id,ts,level,kind,summary,span_id AS spanId,parent_span_id AS parentSpanId,duration_ms AS durationMs,data_json AS data
      FROM log_events WHERE trace_id=? ORDER BY ts,id LIMIT 500`).all(id) as Array<Record<string, unknown> & { data: string | null }>;
    const events = rows.map(({ data, ...row }) => ({ ...row, ...detailPayload(data) }));
    return ctx.json({ ok: true, data: { turn, captureBodies: currentConfig().logs.captureBodies, events } });
  });
  app.get('/api/messages/:id', (ctx) => { const row = dependencies.db.prepare('SELECT id,chat_id AS chatId,message_thread_id AS threadId,tg_message_id AS tgMessageId,direction,from_kind AS fromKind,from_user_id AS fromUserId,from_name AS fromName,from_username AS fromUsername,kind,text,tg_date AS tgDate,triggered,trigger_reason AS triggerReason,turn_id AS turnId,revision,deleted_at AS deletedAt FROM messages WHERE id=?').get(Number(ctx.req.param('id'))); return row ? ctx.json({ ok: true, data: row }) : ctx.json(apiError('not_found', '消息不存在', 404).body, 404); });
  app.delete('/api/messages/:id', (ctx) => {
    const id = Number(ctx.req.param('id'));
    if (!Number.isSafeInteger(id) || id <= 0) return ctx.json(apiError('invalid_message_id', '消息 id 无效').body, 400);
    const changes = dependencies.db.prepare('UPDATE messages SET deleted_at=? WHERE id=? AND deleted_at IS NULL').run(Date.now(), id).changes;
    dependencies.log.event({ level: 'info', kind: 'webui.action', summary: changes ? 'archive message soft-deleted' : 'archive message already absent', data: { id, changes } });
    return ctx.json({ ok: true, data: { id, changes } });
  });
  app.get('/api/files/:attachmentId', (ctx) => {
    const row = dependencies.db.prepare('SELECT local_path AS path,mime,file_name AS name FROM attachments WHERE id=?').get(ctx.req.param('attachmentId')) as { path: string | null; mime: string | null; name: string | null } | undefined;
    if (!row?.path || !existsSync(row.path)) return ctx.json(apiError('not_found', '附件不存在', 404).body, 404);
    // `?inline=1` 只对光栅图放行。同源内联渲染 SVG/HTML 等于把用户上传的内容变成本站脚本，
    // 而附件的 mime 来自 Telegram、是发送方可控的 —— 白名单之外一律照旧当附件下载。
    const inline = ctx.req.query('inline') === '1' && INLINE_MIME.has(row.mime ?? '');
    return new Response(readFileSync(row.path), { headers: { 'content-type': row.mime ?? 'application/octet-stream',
      'content-disposition': inline ? 'inline' : contentDisposition(row.name ?? ctx.req.param('attachmentId')) } });
  });
  app.get('/api/chats/:key/context', (ctx) => ctx.json({ ok: true, data: dependencies.context.materialize(ctx.req.param('key'), ctx.req.query('commit') ?? null, currentConfig().context.cacheCommits) }));
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
    const key = `tools.overrides.${name}`;
    const merged = mergeDotted(currentConfig(), { [key]: { enabled: body.enabled } });
    if (!merged.ok) return ctx.json(invalidKey(merged).body, 400);
    const parsed = runtimeConfigSchema.safeParse(merged.value);
    if (!parsed.success) return ctx.json({ ok: false, error: { code: 'invalid_config', message: '工具开关校验失败', details: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) } }, 400);
    writeConfigRows([[key, { enabled: body.enabled }]], 'webui');
    dependencies.events.emit('config.changed', { keys: [key] });
    return ctx.json({ ok: true, data: { name, enabled: body.enabled } });
  });
  app.get('/api/sandbox', (ctx) => ctx.json({ ok: true, data: { config: publicConfig(currentConfig().sandbox), plan: dependencies.sandbox?.plan('owner') } }));
  app.put('/api/sandbox', async (ctx) => {
    const body = await ctx.req.json<Record<string, unknown>>();
    const dotted = Object.fromEntries(Object.entries(body).map(([key, value]) => [`sandbox.${key}`, value]));
    const pinned = envConflicts(Object.keys(dotted));
    if (pinned.length) return ctx.json(envPinnedError(pinned).body, 400);
    const redacted = redactedKeys(dotted);
    if (redacted.length) return ctx.json(apiError('redacted_placeholder', `${redacted.join('、')} 的值里含脱敏占位符 «redacted»`).body, 400);
    const merged = mergeDotted(currentConfig(), dotted);
    if (!merged.ok) return ctx.json(invalidKey(merged).body, 400);
    const parsed = runtimeConfigSchema.safeParse(merged.value);
    if (!parsed.success) return ctx.json({ ok: false, error: { code: 'invalid_config', message: '沙箱配置校验失败', details: parsed.error.issues } }, 400);
    writeConfigRows(Object.entries(dotted), 'webui');
    dependencies.events.emit('config.changed', { keys: Object.keys(dotted) });
    return ctx.json({ ok: true, data: body });
  });
  app.post('/api/sandbox/probe', async (ctx) => ctx.json({ ok: true, data: await dependencies.sandbox?.probe() ?? { available: false, error: 'sandbox_unconfigured' } }));
  /**
   * 拉取沙箱镜像（docs/09 §3.7）。**只做 pull，不做 build** —— build 要有 Dockerfile 上下文、
   * 会跑任意构建指令、耗时以分钟计，那是部署动作不是控制台按钮。镜像名取自当前配置，
   * 不收请求体里的名字：让 owner 从界面上指定任意镜像等于绕开 `sandbox.image` 这道配置。
   */
  app.post('/api/sandbox/image', async (ctx) => {
    if (!dependencies.sandbox) return ctx.json(apiError('not_implemented', '这个部署没有装配 Sandbox', 500).body, 500);
    const config = currentConfig().sandbox;
    if (config.mode !== 'docker') return ctx.json(apiError('sandbox_not_docker', `当前 sandbox.mode=${config.mode}，没有镜像可拉`).body, 400);
    const result = await dependencies.sandbox.pullImage();
    return result.ok ? ctx.json({ ok: true, data: result }) : ctx.json(apiError('image_pull_failed', result.error ?? '拉取失败').body, 502);
  });
  /**
   * 审批规则的逐行试跑（docs/09 §3.7）：拿一条样例输入过一遍**运行时那份** `ApprovalRules`，
   * 回报哪几条命中、最终风险档位。在界面上自己再实现一遍匹配必然与运行时漂移 —— 而「以为配了
   * 审批其实永不命中」正是这条规则最容易出的错。
   */
  app.post('/api/approvals/test', async (ctx) => {
    const body = await ctx.req.json<{ rules?: unknown[]; tool?: string; input?: unknown }>().catch(() => null);
    if (!body?.tool) return ctx.json(apiError('invalid_body', 'body 需要 { tool, input?, rules? }').body, 400);
    // 规则先过一遍完整 schema（`approval.rules` 的那条 superRefine 会拦下编译不了的正则），
    // 再交给运行时那份匹配器 —— 试跑一个自己都不合法的规则表毫无意义。
    const rules = body.rules ?? currentConfig().approval.rules;
    const merged = mergeDotted(currentConfig(), { 'approval.rules': rules });
    if (!merged.ok) return ctx.json(invalidKey(merged).body, 400);
    const parsed = runtimeConfigSchema.safeParse(merged.value);
    if (!parsed.success) return ctx.json({ ok: false, error: { code: 'invalid_config', message: '规则校验失败', details: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) } }, 400);
    const matched = testApprovalRules(parsed.data.approval.rules, body.tool, body.input ?? {});
    return ctx.json({ ok: true, data: matched });
  });
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
  app.post('/api/prompts/preview', async (ctx) => {
    const body = await ctx.req.json<{ key?: unknown; role?: unknown }>().catch((): { key?: unknown; role?: unknown } => ({}));
    if (typeof body.key !== 'string' || !body.key) return ctx.json(apiError('invalid_key', 'key 必填').body, 400);
    if (typeof body.role !== 'string' || !(body.role in validRoles)) return ctx.json(apiError('invalid_role', 'role 必须是 owner / trusted / limited / blocked').body, 400);
    if (!dependencies.previewPrompt) return ctx.json(apiError('not_implemented', '提示词预览未接入运行时', 500).body, 500);
    try { return ctx.json({ ok: true, data: await dependencies.previewPrompt(body.key, body.role as Role) }); }
    catch (error) { return ctx.json(apiError('preview_failed', error instanceof Error ? error.message : '提示词组装失败', 404).body, 404); }
  });
  app.get('/api/approvals', (ctx) => {
    const now = Date.now();
    dependencies.db.prepare("UPDATE approvals SET state='expired',decided_by='system',decided_at=?,decision_channel='system' WHERE state='pending' AND expires_at<=?").run(now, now);
    return ctx.json({ ok: true, data: dependencies.db.prepare('SELECT * FROM approvals ORDER BY requested_at DESC LIMIT 200').all() });
  });
  app.post('/api/approvals/:id/decide', async (ctx) => {
    const body = await ctx.req.json<{ approved?: unknown }>().catch((): { approved?: unknown } => ({}));
    if (typeof body.approved !== 'boolean') return ctx.json(apiError('invalid_decision', 'approved 必须是布尔值').body, 400);
    return ctx.json({ ok: true, data: { changed: dependencies.approvals.decide(ctx.req.param('id'), body.approved, 'owner', 'webui') } });
  });
  app.get('/api/skills', (ctx) => ctx.json({ ok: true, data: dependencies.db.prepare('SELECT * FROM skills ORDER BY name').all() }));
  app.get('/api/skills/:name', (ctx) => {
    const skill = dependencies.skills?.read(ctx.req.param('name'));
    return skill ? ctx.json({ ok: true, data: skill }) : ctx.json(apiError('not_found', 'Skill 不存在', 404).body, 404);
  });
  // PUT 与 PATCH 走同一条路：SkillLoader.update 本来就是「只覆盖给到的字段」，
  // 两个动词分别抄一份 body 映射，改 frontmatter 字段时必然漏掉其中一个。
  const skillWriteInput = (body: Record<string, unknown>): SkillWriteInput => ({ description: body.description as string | undefined, body: body.body as string | undefined,
    allowedTools: body.allowedTools as string[] | undefined, minRole: body.minRole as Role | undefined, model: body.model as string | null | undefined, enabled: body.enabled as boolean | undefined });
  const updateSkill = async (ctx: Context<ServerEnv>): Promise<Response> => {
    if (!dependencies.skills) return ctx.json(apiError('not_implemented', 'SkillLoader 未配置', 500).body, 500);
    const body = await ctx.req.json<Record<string, unknown>>().catch((): Record<string, unknown> => ({}));
    try { return ctx.json({ ok: true, data: dependencies.skills.update(ctx.req.param('name') ?? '', skillWriteInput(body)) }); }
    catch (error) {
      const message = error instanceof Error ? error.message : 'Skill 更新失败';
      return message === 'skill_not_found'
        ? ctx.json(apiError('not_found', 'Skill 不存在', 404).body, 404)
        : ctx.json(apiError('skill_update_failed', message, 400).body, 400);
    }
  };
  app.post('/api/skills', async (ctx) => {
    if (!dependencies.skills) return ctx.json(apiError('not_implemented', 'SkillLoader 未配置', 500).body, 500);
    const body = await ctx.req.json<Record<string, unknown>>().catch((): Record<string, unknown> => ({}));
    if (typeof body.name !== 'string') return ctx.json(apiError('invalid_skill_name', 'name 必填').body, 400);
    try {
      return ctx.json({ ok: true, data: dependencies.skills.create(body.name, skillWriteInput(body)) }, 201);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Skill 新建失败';
      // 重名是「这个名字已经被占了」而不是「你发的东西不合法」：409 让前端能把它和校验错误分开提示。
      return message === 'skill_already_exists'
        ? ctx.json(apiError('conflict', `Skill ${body.name} 已存在`, 409).body, 409)
        : ctx.json(apiError('invalid_skill', message, 400).body, 400);
    }
  });
  app.put('/api/skills/:name', updateSkill);
  app.patch('/api/skills/:name', updateSkill);
  app.delete('/api/skills/:name', (ctx) => {
    if (!dependencies.skills) return ctx.json(apiError('not_implemented', 'SkillLoader 未配置', 500).body, 500);
    try { return ctx.json({ ok: true, data: { removed: dependencies.skills.remove(ctx.req.param('name')) } }); }
    catch (error) { return ctx.json(apiError('skill_delete_failed', error instanceof Error ? error.message : 'Skill 删除失败', 400).body, 400); }
  });
  app.get('/api/plugins', (ctx) => ctx.json({ ok: true, data: dependencies.db.prepare('SELECT * FROM plugins ORDER BY name').all() }));
  app.patch('/api/plugins/:name', async (ctx) => {
    const body = await ctx.req.json<{ enabled?: boolean; config?: unknown }>();
    const changes = dependencies.db.prepare('UPDATE plugins SET enabled=COALESCE(?,enabled),config_json=COALESCE(?,config_json),updated_at=? WHERE name=?').run(body.enabled === undefined ? null : body.enabled ? 1 : 0, body.config === undefined ? null : JSON.stringify(body.config), Date.now(), ctx.req.param('name')).changes;
    if (!changes) return ctx.json(apiError('not_found', 'Plugin 不存在', 404).body, 404);
    await dependencies.plugins?.reconcile();
    return ctx.json({ ok: true, data: { changes } });
  });
  app.post('/api/plugins/:name/reload', async (ctx) => { await dependencies.plugins?.reconcile(); return ctx.json({ ok: true, data: { name: ctx.req.param('name') } }); });
  app.get('/api/mcp', (ctx) => {
    const persisted = dependencies.db.prepare('SELECT * FROM mcp_servers ORDER BY name').all() as Array<Record<string, unknown>>;
    const byName = new Map(persisted.map((row) => [String(row.name), row]));
    const data = currentConfig().mcp.servers.map((server) => {
      const row = byName.get(server.name) ?? {};
      let tools: unknown[] = [];
      try { tools = row.tools_json ? JSON.parse(String(row.tools_json)) as unknown[] : []; } catch { tools = []; }
      return { ...row, ...server, min_role: server.minRole ?? currentConfig().mcp.defaultMinRole, enabled: server.enabled === false ? 0 : 1,
        state: server.enabled === false ? 'disabled' : row.state ?? 'pending', last_error: row.last_error ?? null, tools };
    });
    return ctx.json({ ok: true, data });
  });
  app.post('/api/mcp', async (ctx) => {
    const body = await ctx.req.json<Record<string, unknown>>().catch((): Record<string, unknown> => ({}));
    const existing = [...currentConfig().mcp.servers];
    if (typeof body.name !== 'string') return ctx.json(apiError('invalid_mcp_name', 'name 必填').body, 400);
    if (existing.some((server) => server.name === body.name)) return ctx.json(apiError('conflict', '同名 MCP server 已存在').body, 400);
    if (redactedKeys({ server: body }).length) return ctx.json(apiError('redacted_placeholder', 'env / headers 里含脱敏占位符 «redacted»，那不是真值').body, 400);
    const saved = persistMcpServers([...existing, body]);
    if (!saved.ok) return ctx.json({ ok: false, error: { code: 'invalid_mcp', message: 'MCP 配置校验失败', details: saved.details } }, 400);
    await dependencies.mcp?.reconcile();
    return ctx.json({ ok: true, data: saved.servers.find((server) => server.name === body.name) }, 201);
  });
  app.patch('/api/mcp/:name', async (ctx) => {
    const name = ctx.req.param('name');
    const body = await ctx.req.json<Record<string, unknown>>().catch((): Record<string, unknown> => ({}));
    const existing = [...currentConfig().mcp.servers];
    const index = existing.findIndex((server) => server.name === name);
    if (index < 0) return ctx.json(apiError('not_found', 'MCP server 不存在', 404).body, 404);
    if (redactedKeys({ server: body }).length) return ctx.json(apiError('redacted_placeholder', 'env / headers 里含脱敏占位符 «redacted»，那不是真值').body, 400);
    existing[index] = { ...existing[index]!, ...body, name } as Config['mcp']['servers'][number];
    const saved = persistMcpServers(existing);
    if (!saved.ok) return ctx.json({ ok: false, error: { code: 'invalid_mcp', message: 'MCP 配置校验失败', details: saved.details } }, 400);
    await dependencies.mcp?.reconcile();
    return ctx.json({ ok: true, data: saved.servers[index] });
  });
  app.delete('/api/mcp/:name', async (ctx) => {
    const name = ctx.req.param('name');
    const existing = [...currentConfig().mcp.servers];
    if (!existing.some((server) => server.name === name)) return ctx.json({ ok: true, data: { removed: false } });
    const saved = persistMcpServers(existing.filter((server) => server.name !== name));
    if (!saved.ok) return ctx.json({ ok: false, error: { code: 'invalid_mcp', message: 'MCP 配置校验失败', details: saved.details } }, 400);
    await dependencies.mcp?.reconcile();
    dependencies.db.prepare('DELETE FROM mcp_servers WHERE name=?').run(name);
    return ctx.json({ ok: true, data: { removed: true } });
  });
  app.post('/api/mcp/:name/reconnect', async (ctx) => {
    await dependencies.mcp?.reconcile();
    const row = dependencies.db.prepare('SELECT state,last_error AS error FROM mcp_servers WHERE name=?').get(ctx.req.param('name')) as { state: string; error: string | null } | undefined;
    dependencies.events.emit('health', { source: 'mcp', name: ctx.req.param('name'), ok: row?.state === 'up', code: row?.state ?? 'unknown' });
    return ctx.json({ ok: true, data: { name: ctx.req.param('name'), state: row?.state ?? null, error: row?.error ?? null } });
  });
  app.get('/api/agents', (ctx) => ctx.json({ ok: true, data: currentConfig().agent.agents }));
  app.post('/api/agents/:name/dryrun', async (ctx) => {
    if (!dependencies.dryRunAgent) return ctx.json(apiError('not_implemented', 'Agent 试跑未接入运行时', 500).body, 500);
    const body = await ctx.req.json<{ task?: unknown }>().catch((): { task?: unknown } => ({}));
    if (typeof body.task !== 'string' || !body.task.trim()) return ctx.json(apiError('invalid_task', 'task 必填').body, 400);
    if (body.task.length > 20_000) return ctx.json(apiError('task_too_large', 'task 最多 20000 字符').body, 400);
    const task = body.task.trim();
    const abort = new AbortController();
    const requestSignal = ctx.req.raw.signal;
    const onRequestAbort = (): void => abort.abort();
    requestSignal.addEventListener('abort', onRequestAbort, { once: true });
    const encoder = new TextEncoder();
    let closed = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (event: AgentDryRunEvent): void => {
          if (!closed) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        };
        void dependencies.dryRunAgent!(ctx.req.param('name'), task, abort.signal, send)
          .then((result) => send({ type: 'final', ...result }))
          .catch((error) => send({ type: 'error', message: error instanceof Error ? error.message : String(error) }))
          .finally(() => {
            requestSignal.removeEventListener('abort', onRequestAbort);
            if (!closed) { closed = true; controller.close(); }
          });
      },
      cancel() {
        closed = true;
        abort.abort();
        requestSignal.removeEventListener('abort', onRequestAbort);
      },
    });
    return new Response(stream, { headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
  });
  // `minLevel` 让总览页的「最近错误」卡片真的只看 warn 以上（docs/09 §3.1）。
  app.get('/api/logs', (ctx) => {
    const minLevel = ctx.req.query('minLevel');
    const level = minLevel && ['debug', 'info', 'warn', 'error'].includes(minLevel) ? minLevel as 'debug' | 'info' | 'warn' | 'error' : undefined;
    return ctx.json({ ok: true, data: dependencies.operations.logs(Math.min(1000, Number(ctx.req.query('size') ?? 200)), ctx.req.query('traceId'), level) });
  });
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
  /**
   * 用量的时间范围 + 维度聚合（docs/09 §3.11）。**聚合逻辑早就写好了**——
   * `UsageLedger.report(from,to,groupBy)` 六个维度一个不少，只是从来没有端点调过它，
   * 界面上因此只有一张不分维度的明细表。这里就是把那条路接上。
   */
  app.get('/api/usage/report', (ctx) => {
    const groupBy = ctx.req.query('groupBy') ?? 'day';
    if (!['day', 'chat', 'user', 'model', 'alias', 'agent'].includes(groupBy)) return ctx.json(apiError('invalid_group_by', `维度只能是 day|chat|user|model|alias|agent，收到 ${groupBy}`).body, 400);
    const now = Date.now();
    const from = Number(ctx.req.query('from') ?? now - 30 * 86_400_000);
    const to = Number(ctx.req.query('to') ?? now);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) return ctx.json(apiError('invalid_range', 'from/to 必须是毫秒时间戳且 from ≤ to').body, 400);
    const rows = dependencies.ledger?.report(from, to, groupBy as 'day') ?? [];
    // chat / user 维度的 bucket 是裸 id，界面上认不出是谁。在这里补显示名，别让前端再实现一遍
    // `principals` 的反查规则（会话页已经有一份，两份必然漂移）。
    const labelled = ['chat', 'user'].includes(groupBy)
      ? (rows as Array<{ bucket: string | null }>).map((row) => ({ ...row, label: principalLabel(dependencies.db, groupBy === 'chat' ? 'chat' : 'user', row.bucket) }))
      : rows;
    return ctx.json({ ok: true, data: { groupBy, from, to, rows: labelled } });
  });
  const QUOTA_UNIMPLEMENTED = KNOWN_UNIMPLEMENTED_CONFIG_KEYS.filter((key) => key.startsWith('quota.'));
  interface CounterRow { scope: 'global' | 'chat' | 'user'; subject: string; window: 'day' | 'month'; bucket: string; costUsd: number; reservedUsd: number; turns: number; updatedAt: number }
  /** 「花了多少」在 quota_counters 里，「上限是多少」在配置里，两边只有 (scope,window) 能对上。
   *  分开返回等于让界面自己再实现一遍 bot.ts 的取值规则（含 byRole 覆盖），所以在这里就合成好。 */
  app.get('/api/quota', (ctx) => {
    const config = currentConfig();
    const now = new Date();
    const buckets = { day: quotaBucket(now, config.general.timezone, 'day'), month: quotaBucket(now, config.general.timezone, 'month') };
    const rows = dependencies.db.prepare(`SELECT scope,subject,window,bucket,cost_usd AS costUsd,reserved_usd AS reservedUsd,turns,updated_at AS updatedAt
      FROM quota_counters ORDER BY bucket DESC,scope,subject LIMIT 500`).all() as CounterRow[];
    const byRole = config.quota.perUser.byRole;
    const scopedRoles = Object.keys(byRole).length > 0;
    // 一次取回而不是逐行点查：这一页会被反复刷新，500 行 × 一条 SELECT 是白烧的 IO。
    const principals = new Map((dependencies.db.prepare('SELECT kind,tg_id AS tgId,role,display_name AS displayName,username FROM principals')
      .all() as Array<{ kind: string; tgId: string; role: string; displayName: string | null; username: string | null }>).map((entry) => [`${entry.kind}:${entry.tgId}`, entry]));
    const counters = rows.map((row) => {
      const principal = row.scope === 'global' ? null : principals.get(`${row.scope}:${row.subject}`) ?? null;
      const base = row.scope === 'global' ? config.quota.global : row.scope === 'chat' ? config.quota.perChat : config.quota.perUser;
      const override = row.scope === 'user' && principal ? byRole[principal.role] : undefined;
      const limit = (row.scope === 'user' ? override?.[row.window === 'day' ? 'daily' : 'monthly'] : undefined) ?? base[row.window === 'day' ? 'daily' : 'monthly'];
      // 有效角色是 min(用户角色, 会话角色)：这里只看得到用户自己那一档，配了 byRole 时实际生效的可能更低。
      return { ...row, current: buckets[row.window] === row.bucket, limit, limitApprox: row.scope === 'user' && scopedRoles,
        role: principal?.role ?? null, label: principal?.displayName ?? null, username: principal?.username ?? null };
    });
    // 缺定价的模型花费按 0 记账 —— 配额页把限额说得再准，这些轮次也不会被计进去。
    const unpriced = dependencies.db.prepare('SELECT provider_id AS providerId,model_id AS modelId FROM models WHERE enabled=1 AND (price_in IS NULL OR price_out IS NULL) ORDER BY provider_id,model_id LIMIT 20').all() as Array<{ providerId: string; modelId: string }>;
    return ctx.json({ ok: true, data: { quota: config.quota, timezone: config.general.timezone, buckets, counters,
      unpriced, unpricedTotal: Number(dependencies.db.prepare('SELECT COUNT(*) FROM models WHERE enabled=1 AND (price_in IS NULL OR price_out IS NULL)').pluck().get()),
      unimplemented: QUOTA_UNIMPLEMENTED } });
  });
  // body 是相对 quota 的点分键（`global.daily`），与 PUT /api/sandbox 一致；校验与审计同 PUT /api/config。
  app.put('/api/quota', async (ctx) => {
    const body = await ctx.req.json<Record<string, unknown>>().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return ctx.json(apiError('invalid_body', 'body 必须是点分键对象').body, 400);
    const dotted = Object.fromEntries(Object.entries(body).map(([key, value]) => [`quota.${key}`, value]));
    if (!Object.keys(dotted).length) return ctx.json({ ok: true, data: { keys: [] } });
    const merged = mergeDotted(currentConfig(), dotted);
    if (!merged.ok) return ctx.json(invalidKey(merged).body, 400);
    const parsed = runtimeConfigSchema.safeParse(merged.value);
    if (!parsed.success) return ctx.json({ ok: false, error: { code: 'invalid_config', message: '配额配置校验失败', details: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) } }, 400);
    writeConfigRows(Object.entries(dotted), 'webui');
    dependencies.events.emit('config.changed', { keys: Object.keys(dotted) });
    return ctx.json({ ok: true, data: { keys: Object.keys(dotted) } });
  });
  // 不带 body 仍然是「全部清零」（旧行为）；带 scope/subject/window/bucket 时只删那一行 ——
  // 一个人撞满了当日额度，没有理由把全局与其他所有人的当月计数一起抹掉。
  app.post('/api/quota/reset', async (ctx) => {
    const body = await ctx.req.json<Record<string, unknown>>().catch((): Record<string, unknown> => ({}));
    const filters: Array<[string, string]> = [];
    for (const field of ['scope', 'subject', 'window', 'bucket'] as const) { const value = body[field]; if (typeof value === 'string' && value) filters.push([field, value]); }
    if (filters.length && !filters.some(([field]) => field === 'scope')) return ctx.json(apiError('invalid_filter', '按条件重置时必须给出 scope').body, 400);
    const where = filters.length ? ` WHERE ${filters.map(([field]) => `${field}=?`).join(' AND ')}` : '';
    const changes = dependencies.db.prepare(`DELETE FROM quota_counters${where}`).run(...filters.map(([, value]) => value)).changes;
    dependencies.log.event({ level: 'info', kind: 'webui.action', summary: 'quota counters reset', data: { filters: Object.fromEntries(filters), changes } });
    return ctx.json({ ok: true, data: { changes } });
  });
  app.get('/api/tasks', (ctx) => ctx.json({ ok: true, data: dependencies.db.prepare('SELECT * FROM tasks ORDER BY updated_at DESC LIMIT 500').all() }));
  app.post('/api/maintenance/:action', (ctx) => { const action = ctx.req.param('action'); const result = action === 'backup' ? dependencies.maintenance.backup() : action === 'vacuum' ? (dependencies.maintenance.vacuum(), 'ok') : action === 'cleanup-logs' ? dependencies.maintenance.cleanup() : action === 'gc-files' ? dependencies.maintenance.gcFiles() : action === 'rebuild-fts' ? (dependencies.maintenance.rebuildFts(), 'ok') : null; return result === null ? ctx.json(apiError('unknown_action', '未知维护操作', 404).body, 404) : ctx.json({ ok: true, data: result }); });
  /**
   * `[重启进程]`（docs/09 §3.13）。**先回响应再退出** —— 在同一个 tick 里 `process.exit` 会让
   * 这次请求连响应都收不到，界面上表现成「点了没反应」。走 `dependencies.restart` 而不是
   * 直接 `process.exit`：优雅关闭的那套（排空轮次、刷日志、WAL checkpoint）在 `main.ts` 里，
   * 服务器包不该也不能重实现一遍。
   *
   * **没有 supervisor 时进程不会自己回来** —— 界面上的二次确认必须写明这一点。
   */
  app.post('/api/restart', (ctx) => {
    if (!dependencies.restart) return ctx.json(apiError('not_implemented', '这个部署没有装配重启入口', 500).body, 500);
    setTimeout(() => { void dependencies.restart?.('webui'); }, 100).unref?.();
    return ctx.json({ ok: true, data: { restarting: true, note: '没有 systemd / docker 这类 supervisor 时进程不会自动拉起' } });
  });
  app.get('/api/events', (ctx) => {
    let cleanup = (): void => undefined;
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder(); let closed = false;
        let unsubscribe = (): void => undefined;
        let unregister = (): void => undefined;
        controller.enqueue(encoder.encode(': connected\n\n'));
        // channel:true —— 这根管子对面坐着能点「批准」的人，审批据此判断有没有裁决通道（docs/24 · R-APPR-01）。
        unsubscribe = dependencies.events.subscribe((event) => { if (!closed) controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`)); }, { channel: true });
        const heartbeat = setInterval(() => { if (!closed) controller.enqueue(encoder.encode(': ping\n\n')); }, 20_000); heartbeat.unref?.();
        const close = (): void => { if (closed) return; closed = true; clearInterval(heartbeat); unsubscribe(); unregister(); try { controller.close(); } catch { /* already closed */ } };
        unregister = dependencies.eventStreams?.add({ close }) ?? (() => undefined);
        cleanup = close;
        ctx.req.raw.signal.addEventListener('abort', close, { once: true });
      },
      cancel() { cleanup(); },
    });
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' } });
  });
  const webRoot = fileURLToPath(new URL('../../webui/dist', import.meta.url));
  // 未匹配的 /api/* 必须在静态兜底**之前**拦下来：否则它们拿到 200 + index.html，前端的 `api()`
  // 在 `response.json()` 处抛 SyntaxError，报错信息与真实原因（路径写错了）毫无关系（docs/22 · I-13）。
  app.all('/api/*', (ctx) => ctx.json(apiError('not_found', `没有这个端点：${ctx.req.method} ${new URL(ctx.req.url).pathname}`, 404).body, 404));
  app.use('/*', serveStatic({ root: webRoot }));
  app.get('*', (ctx) => existsSync(resolve(webRoot, 'index.html')) ? ctx.html(readFileSync(resolve(webRoot, 'index.html'), 'utf8')) : ctx.text('LuoLiCore WebUI 尚未构建', 503));
  return app;
}

/**
 * 一次性登录 token 的内存表。**导出的是签发函数而不是这张表** —— 让装配方直接往里塞
 * 等于多一个能凭空造 owner session 的入口。
 */
const loginTokens = new Map<string, { expiresAt: number }>();

/** 由 Telegram 的 `/webui` 命令调用（owner 私聊）。返回明文 token，调用方负责只发给 owner 本人。 */
export function issueLoginToken(ttlMs = 5 * 60_000): { token: string; expiresAt: number } {
  const now = Date.now();
  for (const [value, entry] of loginTokens) if (entry.expiresAt <= now) loginTokens.delete(value);
  // 有界：`/webui` 被连点时不该让这张表无限涨。最多留 16 个未用的。
  while (loginTokens.size >= 16) loginTokens.delete(loginTokens.keys().next().value!);
  const token = randomBytes(32).toString('base64url');
  const expiresAt = now + ttlMs;
  loginTokens.set(token, { expiresAt });
  return { token, expiresAt };
}

export function setupToken(): { token: string; expiresAt: number } {
  return { token: randomBytes(24).toString('base64url'), expiresAt: Date.now() + 15 * 60_000 };
}
