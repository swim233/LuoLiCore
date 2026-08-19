import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import argon2 from 'argon2';
import { Hono } from 'hono';
import YAML from 'yaml';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getConnInfo } from '@hono/node-server/conninfo';
import { serveStatic } from '@hono/node-server/serve-static';
import type { AgentManager, Config, ConfigChangedEvent, ConfigStore, ContextEngine, DatabaseApprovalBroker, EventBus, LogSink, MaintenanceService, McpManager, MemoryStore, ModelCatalog, PluginManager, PromptDocuments, ProviderStore, Sandbox, SkillLoader, SkillWriteInput, SubAgentRuntimeEvent, TurnRegistry } from '@luoli/core';
import { ALIAS_NAME_PATTERN, HOT_RELOADABLE_CONFIG_KEYS, chatCandidates, createScheduledJob, mergeAgentDefinitions, scanAgentFiles, scheduledJobView, testApprovalRules, KNOWN_UNIMPLEMENTED_CONFIG_KEYS, TOOL_POLICY, aliasSettingsSchema, checkWakeword, configSchema as runtimeConfigSchema, envPinnedConfigKeys, perChatConfig, probeProvider, quotaBucket, rejectedWakewords } from '@luoli/core';
import { APPROVAL_POLICIES, BUNDLED_SKILLS, SkillPackageError, effectiveToolPolicy, installSkillPackage, looksSecret, persistMcpServers as persistMcpServersShared, publicConfig, relaxedFields, revisionJson } from '@luoli/core';
import type { CatalogIndex, ContainerManager, CustomToolManager, ModelMetadata, ProviderProbe, ToolOverride, ToolRegistry } from '@luoli/core';
import type { ArchiveRepository, CustomToolRepository, OperationsRepository, PrincipalRepository, ScheduleRepository, ScheduledJob, Sqlite } from '@luoli/db';
import { deleteAppKv, modelAliasKey, readAppKv, writeConfigRows as writeConfigRowsToDatabase } from '@luoli/db';
import { assignDotted, readDotted, ROLES, TG_ID_PATTERN, type Role } from '@luoli/shared';
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
  ledger?: { report(from: number, to: number, groupBy: 'day' | 'chat' | 'user' | 'model' | 'alias' | 'agent', timezone?: string): unknown[] };
  /** `POST /api/restart` 的落点。优雅关闭那套在 apps/bot，服务器包只负责把请求转过去。 */
  restart?: (reason: string) => Promise<void> | void;
  /**
   * 定时任务的运行时（`ScheduleRepository` + `ScheduledJobRunner`）。缺它时那四个端点回
   * `schedule_unavailable`，界面据此说「这个部署没接定时任务运行时」——**不是显示零条任务**：
   * 空列表和「读不到」在运维眼里是两回事（docs/16 §5「摘除比伪造安全」）。
   */
  schedules?: {
    jobs: ScheduleRepository;
    runner: { loaded: boolean; register(job: ScheduledJob): boolean; unregister(id: string): boolean; nextRun(id: string): Date | null; fire(id: string): Promise<void> };
  };
  events: EventBus;
  memory?: MemoryStore;
  promptDocuments?: PromptDocuments;
  skills?: SkillLoader;
  plugins?: PluginManager;
  mcp?: McpManager;
  agents?: AgentManager;
  /**
   * 工具注册表。缺它时 `GET /api/tools` 退回「`TOOL_POLICY` + 覆盖层」那份静态表 —— 少了
   * MCP / plugin 注册进来的工具和每个工具声明的超时，但策略与启停仍然是对的。
   */
  tools?: ToolRegistry;
  /** 自撰写工具的库与注册器。缺它时 `/api/custom-tools` 一律 `not_implemented` —— 空列表和
   *  「这个部署压根没装」在运维眼里是两回事（docs/16 §5「摘除比伪造安全」）。 */
  customTools?: CustomToolRepository;
  customToolManager?: CustomToolManager;
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

const apiError = (code: string, message: string, status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500 | 502 = 400) => ({ body: { ok: false as const, error: { code, message } }, status });

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
/**
 * 一棵配置树里的**叶子路径**。`PUT /api/config/yaml` 的落库粒度：按顶层段落库时 zod 已经把每个
 * `.default()` 填满，写回去的是填满之后那整棵子树，一次「一个字不改」的往返就把那一刻的代码默认值
 * 永久钉死（docs/28 · L-WEB-02）。
 *
 * 两条刻意的取舍：**数组当叶子** —— `approval.rules` / `mcp.servers` / `agent.agents` 是整块语义，
 * 逐个下标落库既没人这么读、也会被 `sortOverrideKeys` 拼回原样；**空对象不产生叶子** —— 它表达的是
 * 「这里什么都不覆盖」，而写成一行 `{}` 会让 `writeConfigRows` 顺手删掉同一子树下的密钥行，
 * 那正是 docs/28 · L-WEB-04 的形态。
 */
function configLeafPaths(node: unknown, prefix = ''): string[] {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return prefix ? [prefix] : [];
  return Object.entries(node as Record<string, unknown>)
    .flatMap(([key, value]) => configLeafPaths(value, prefix ? `${prefix}.${key}` : key));
}
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
/**
 * 库里存下来的那种路径的包含性校验。与 `safeRef` 的区别只在一点：**先绝对化再判包含**，
 * 不把它当成相对 `root` 的引用 —— `attachments.local_path` 是 `join('./data/files', chatId, …)`
 * 这种相对 cwd 的路径，交给 `safeRef` 会被拼成 `<root>/data/files/…`，一个都对不上。
 *
 * 这两列今天只由本进程写，所以这是纵深防御；但「DB 里的路径值可信」是一个会随时间失效的假设
 * ——导入、迁移、手工修库都能改它，而同一个文件里读日志目录早就是过闸的（docs/27 · S-07）。
 */
function storedPathWithin(root: string, stored: string): string {
  const absolute = resolve(stored);
  const base = resolve(root);
  if (absolute !== base && !absolute.startsWith(`${base}${sep}`)) throw new Error('invalid_file_ref');
  return absolute;
}

/**
 * 登录限流的桶键与 `sessions.ip` 的来源。**`trustProxy` 为假时一个请求头都不看** ——
 * 桶键要是请求头，限流的代价就只是「再换一个头值」：docs/18 · N-WEB-02 那一轮的修复原文写的是
 * 「`trustProxy` 为假时恒返回 `local`」，后来丢了这一半，于是 docs/27 · S-01 实测 12 次轮换
 * `X-Real-IP` 全部 401、一次 429 都没有。直连时只认连接的远端地址；拿不到（`app.request()`
 * 这类没有底层 socket 的调用）就全落进同一个 `local` 桶 —— fail-closed 的那一侧是「一起锁」。
 */
function requestIp(ctx: Context, config: Readonly<Config>): string {
  if (config.webui.trustProxy) {
    const chain = ctx.req.header('x-forwarded-for')?.split(',').map((entry) => entry.trim()).filter(Boolean) ?? [];
    return chain.at(-config.webui.trustedProxyHops) ?? ctx.req.header('x-real-ip')?.trim() ?? 'direct';
  }
  try { return getConnInfo(ctx).remote.address?.trim() || 'local'; } catch { return 'local'; }
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
   * `prune` 是显式删除集（只有叶子粒度的 YAML 端点用得上），和被吞并的后代行走同一个事务。
   */
  const writeConfigRows = (entries: Array<[string, unknown]>, actor: string, prune: readonly string[] = []): string[] =>
    writeConfigRowsToDatabase(dependencies.db, entries, actor, revisionJson, prune);
  const persistedConfigRows = (): Array<{ key: string; value: unknown }> =>
    (dependencies.db.prepare('SELECT key,value_json AS value FROM config_kv ORDER BY key').all() as Array<{ key: string; value: string }>)
      .map((row) => ({ key: row.key, value: JSON.parse(row.value) as unknown }));
  /**
   * 「这一行是密钥，不参与 YAML 往返」的唯一判据。`GET` 用它决定整行跳过哪些，`PUT` 用它决定哪些
   * 旧键永不删 —— 两次是**独立请求**，`PUT` 必须自己重算一次而不能信客户端交回来的 `skipped`
   * （docs/28 · L-WEB-04）。整块写入（`mcp.servers`）里也可能埋着密钥字段，`publicConfig` 会把它们
   * 变成占位符，那种块同样不能出现在往返里。
   */
  const secretConfigRow = (key: string, value: unknown): boolean =>
    looksSecret(key, value) || JSON.stringify(publicConfig(value)).includes('«redacted»');
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
  // 与 `install_mcp` 工具共用同一份校验与写入（`persistMcpServers`，core）：抄两份的必然结果是
  // WebUI 建得出来的 server 工具建不出来，或者反过来。
  // `reconciled: ['mcp']`：这三个端点每一个都在写完之后自己 `await dependencies.mcp.reconcile()`
  // （响应里要给出真实 state），所以 `main.ts` 的订阅者不能再跑一次 —— 两条重叠的 reconcile 会
  // 各 spawn 一个 stdio 子进程（`ConfigChangedEvent`，docs/28 · L-EXT-03）。
  const persistMcpServers = (servers: unknown[]): { ok: true; servers: Readonly<Config['mcp']['servers']> } | { ok: false; details: unknown } =>
    persistMcpServersShared({ db: dependencies.db, config: currentConfig,
      apply: (next, keys) => { if ('replace' in dependencies.config) dependencies.config.replace(next, keys); },
      emit: (keys) => dependencies.events.emit('config.changed', { keys, reconciled: ['mcp'] } satisfies ConfigChangedEvent) }, servers, 'webui');
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
  /**
   * 请求体上界。`ctx.req.json()` 把整份请求体读进内存，而 `/api/setup` 与两条登录端点注册在鉴权
   * 中间件**之前** —— 未登录就能推一个任意大的请求体进来（docs/27 · S-05）。`login` 那条
   * `password.length > 1024` 的检查发生在 `await ctx.req.json()` 之后，挡不住这件事。
   * 挂在 Origin 闸之后、所有路由之前：`bodyLimit` 也要在真正读体之前拦，装在具体端点上就晚了。
   * 三条业务上就大的端点各自放宽，其余一律 1 MiB —— 上界要按端点给，不是找一个「都够用」的数。
   */
  const DEFAULT_BODY_LIMIT = 1_048_576;
  const WIDE_BODY_LIMITS: Array<[RegExp, number]> = [
    [/^\/api\/config\/yaml$/, 4_194_304],
    [/^\/api\/models\/import$/, 4_194_304],
    [/^\/api\/prompts\/[^/]+$/, 2_097_152],
  ];
  const bodyLimiters = new Map<number, ReturnType<typeof bodyLimit>>();
  const limiterFor = (max: number): ReturnType<typeof bodyLimit> => {
    const existing = bodyLimiters.get(max);
    if (existing) return existing;
    const created = bodyLimit({ maxSize: max, onError: (ctx) => ctx.json(apiError('payload_too_large', `请求体超过 ${Math.round(max / 1024)} KiB 上限`, 413).body, 413) });
    bodyLimiters.set(max, created);
    return created;
  };
  /**
   * 装 skill 包这条走配置而不是常量：`skills.package.maxTotalBytes` 默认 64 MiB，而这里的默认
   * 上界是 1 MiB —— 不接过来的话，一个 4.9 MB 的包在读到端点之前就被 413 掉了，而那条错误里
   * 一个字都不会提到「去把上限调大」。多给 1 MiB 是 multipart 信封的余量，好让报错来自
   * 端点里那句说得清楚的，而不是这道闸。
   */
  const bodyLimitFor = (path: string): number => (path === '/api/skills/package'
    ? currentConfig().skills.package.maxTotalBytes + 1_048_576
    : WIDE_BODY_LIMITS.find(([pattern]) => pattern.test(path))?.[1] ?? DEFAULT_BODY_LIMIT);
  app.use('/api/*', (ctx, next) => limiterFor(bodyLimitFor(ctx.req.path))(ctx, next));

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
    // `timeline: true`：会话页要 commit 列表与逐条消息。工具那一侧刻意只拿摘要（docs/27 · R-03）。
    return ctx.json({ ok: true, data: { ...dependencies.context.stats(key, { timeline: true }), modelAlias: readAppKv<string>(dependencies.db, modelAliasKey(key)) ?? null } });
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
    const overrides: Record<string, unknown> = {};
    const skipped: string[] = [];
    // 判据与 YAML 那条路共用 `secretConfigRow`：整块写入（`mcp.servers`）里也可能埋着密钥字段，
    // 而两份各自演化的判据最终必然在其中一条路上把真密钥漏出去。
    for (const row of persistedConfigRows()) {
      if (secretConfigRow(row.key, row.value)) { skipped.push(row.key); continue; }
      overrides[row.key] = row.value;
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
    const tree: Record<string, unknown> = {};
    const skipped: string[] = [];
    for (const row of persistedConfigRows()) {
      if (secretConfigRow(row.key, row.value)) { skipped.push(row.key); continue; }
      assignDotted(tree, row.key, row.value);
    }
    // 被跳过的键在 YAML **顶部生成注释**逐条点名：此前界面上只有一个 `skipped` 数组，运维看不出
    // 「我提交的这份少了什么」，而提交一份少了 `webui.passwordHash` 的树曾经等于把口令哈希删掉
    // （docs/28 · L-WEB-04）。注释拼在 `YAML.stringify` 的结果**前面** —— 进配置树就是一个键了。
    const banner = skipped.length
      ? `# 这份 YAML 里不含以下 ${skipped.length} 个密钥类键（值一律不回显）：\n${skipped.map((key) => `#   ${key}\n`).join('')}# 它们保持原值：提交这份 YAML 不会删掉它们，删掉这段注释也不会。\n`
      : '';
    return ctx.json({ ok: true, data: { yaml: banner + YAML.stringify(tree, { indent: 2 }), skipped } });
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
    // 落库粒度是**提交的那棵树的叶子**（`configLeafPaths`），不是顶层段：按段落库时写回去的是
    // zod 把 `.default()` 填满之后那整棵子树，一次「一个字不改」的往返就把生效覆盖叶子从 73 涨到
    // 171、把那一刻的代码默认值永久钉死（docs/28 · L-WEB-02）。键取自**提交的树**、值取自
    // `parsed.data` —— 后者保住「落库的是校验后的值」这条既有契约（同 `PUT /api/config` 的注释）。
    const sections = Object.keys(tree as Record<string, unknown>);
    const leaves = configLeafPaths(tree);
    // env 钉住的也按叶子跳过：此前是含被钉键的**整个顶层段**一起跳过，一条 `LUOLI_WEBUI_HOST`
    // 就能让 `webui` 段其余的键在这条路上全都存不进去。
    const pinnedConflicts = envConflicts(leaves);
    const applicable = leaves.filter((leaf) => !pinnedConflicts.some((entry) => leaf === entry.key || entry.key.startsWith(`${leaf}.`) || leaf.startsWith(`${entry.key}.`)));
    const rows: Array<[string, unknown]> = applicable.map((key) => [key, readDotted(parsed.data, key)]);
    const unknownKeys = rows.filter(([, value]) => value === undefined).map(([key]) => key);
    if (unknownKeys.length) return ctx.json(apiError('unknown_config_key', `${unknownKeys.join('、')} 不是 schema 里的配置路径`).body, 400);
    // 「这份 YAML 是所提交段落的全量视图」此前靠 `writeConfigRows` 删掉祖先键的后代行来实现；
    // 叶子粒度之后没有祖先键可依赖了，删除必须显式算出来，否则从 YAML 里删掉一个键什么也不会发生。
    const written = new Set(applicable);
    const submitted = new Set(sections);
    const pinnedNames = new Set(envPinnedConfigKeys().map((entry) => entry.key));
    const prune: string[] = [];
    const preserved: string[] = [];
    for (const row of persistedConfigRows()) {
      if (!submitted.has(row.key.split('.')[0]!) || written.has(row.key)) continue;
      // 密钥行与被 env 钉住的键**永不删**：前者压根没出现在运维手上那棵树里（`GET` 整行跳过），
      // 把「树里没有」当成「运维删掉了」就是 docs/28 · L-WEB-04 —— 一次往返擦掉 `webui.passwordHash`、
      // 进程静静掉回 setup-token 形态。
      if (secretConfigRow(row.key, row.value) || pinnedNames.has(row.key)) { preserved.push(row.key); continue; }
      prune.push(row.key);
    }
    const subsumed = writeConfigRows(rows, 'webui:yaml', prune);
    dependencies.events.emit('config.changed', { keys: [...new Set([...applicable, ...prune])] });
    return ctx.json({ ok: true, data: { keys: applicable, skipped: pinnedConflicts.map((entry) => entry.key), pruned: prune, preserved, subsumed } });
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
  /**
   * 工具页那张表。扁平的 `minRole` / `approval` / `scope` / `source` / `enabled` / `timeoutMs`
   * 一律是**生效值**（旧消费点因此不用改），`defaults` 是代码里那份，`relaxed` 是比默认更松的
   * 字段名 —— 两者都给才看得出「我现在偏离了多少」（docs/09 §3.7）。
   *
   * 有注册表就问它（合并逻辑只有一份，还能顺带列出 MCP / plugin 的工具）；没有就退回静态表。
   */
  app.get('/api/tools', (ctx) => {
    const overrides = currentConfig().tools.overrides;
    if (dependencies.tools) {
      return ctx.json({ ok: true, data: Object.fromEntries(dependencies.tools.describe().map((entry) => [entry.name, {
        ...entry.effective, enabled: entry.enabled, timeoutMs: entry.timeoutMs, selfManagedTimeout: entry.selfManagedTimeout,
        defaults: { minRole: entry.defaults.minRole, approval: entry.defaults.approval, timeoutMs: entry.defaultTimeoutMs },
        relaxed: entry.relaxed }])) });
    }
    return ctx.json({ ok: true, data: Object.fromEntries(Object.entries(TOOL_POLICY).map(([name, policy]) => {
      const override = overrides[name];
      return [name, { ...effectiveToolPolicy(policy, override), enabled: override?.enabled !== false,
        timeoutMs: override?.timeoutMs ?? null, selfManagedTimeout: false,
        defaults: { minRole: policy.minRole, approval: policy.approval, timeoutMs: null }, relaxed: relaxedFields(policy, override) }];
    })) });
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
  /**
   * 能力位里**运行时真的会读**的那几个 —— 目前只有 `vision`（`ModelRegistry.supportsVision`，
   * 含图轮次据它自动切 `vision` 别名，见 `docs/04 §5.2`）。其余能力位只喂 WebUI 的徽章，放开它们
   * 等于给运维一个「关掉工具」的开关而代码照旧把工具目录发上去 —— 假开关比没开关糟
   * （`reviews/16` §5「摘除比伪造安全」）。**运行时开始读某个能力位时，才把它加进这里。**
   */
  const OVERRIDABLE_CAPABILITIES = ['vision'] as const;
  /**
   * 把 owner 的能力标记合进 `capabilities_json`。**生效值写顶层** —— 运行时与界面徽章都读那里，
   * 不必各自再懂一层「人工优先于目录」；而「这是人标的」记在 `manual` 里：`enrich` / `import`
   * 拿目录那份整块覆盖能力位，不留下这个意图的话一次「补齐元数据」就把标记静默撤销了。
   *
   * `null` = 取消标记：只摘掉 `manual` 的键，顶层维持现状（这里不做目录查询，撤销不该依赖出网），
   * 下一次「补齐元数据」再按目录重填 —— 界面上那行提示写的就是这件事。
   *
   * @returns 新的 JSON 串；这次 patch 一个字段都没动到时回 `null`，调用方据此跳过 UPDATE。
   */
  const applyManualCapabilities = (current: string | null, patch: Record<string, unknown>): string | null => {
    let block: Record<string, unknown> = {};
    try { block = current ? JSON.parse(current) as Record<string, unknown> : {}; } catch { block = {}; }
    const previous = block.manual;
    const manual: Record<string, unknown> = previous && typeof previous === 'object' && !Array.isArray(previous) ? { ...previous as Record<string, unknown> } : {};
    let touched = false;
    for (const key of OVERRIDABLE_CAPABILITIES) {
      if (!(key in patch)) continue;
      const value = patch[key];
      if (value === null) { if (key in manual) { delete manual[key]; touched = true; } continue; }
      if (typeof value !== 'boolean') continue;
      manual[key] = value; block[key] = value; touched = true;
    }
    if (!touched) return null;
    if (Object.keys(manual).length) block.manual = manual; else delete block.manual;
    return JSON.stringify(block);
  };
  /** 把某一行现存的人工标记盖回新算出来的能力块（`enrich` 用）。坏 JSON 一律当「没有标记」。 */
  const keepManualCapabilities = (next: string, current: string | null): string => {
    let block: Record<string, unknown> = {};
    try { block = current ? JSON.parse(current) as Record<string, unknown> : {}; } catch { return next; }
    const manual = block.manual;
    if (!manual || typeof manual !== 'object' || Array.isArray(manual)) return next;
    return applyManualCapabilities(next, manual as Record<string, unknown>) ?? next;
  };
  app.get('/api/models', (ctx) => ctx.json({ ok: true, data: dependencies.db.prepare('SELECT * FROM models ORDER BY provider_id,sort').all() }));
  app.post('/api/models', async (ctx) => {
    const body = await ctx.req.json<Record<string, unknown>>();
    if (typeof body.providerId !== 'string' || !body.providerId || typeof body.modelId !== 'string' || !body.modelId) return ctx.json(apiError('model_invalid', 'providerId 与 modelId 必填').body, 400);
    const contextWindow = Number(body.contextWindow); const maxOutput = Number(body.maxOutput);
    if (!Number.isInteger(contextWindow) || contextWindow <= 0 || !Number.isInteger(maxOutput) || maxOutput <= 0) return ctx.json(apiError('model_invalid', 'contextWindow 与 maxOutput 必须是正整数').body, 400);
    const id = typeof body.id === 'string' && body.id ? body.id : randomBytes(16).toString('hex');
    // 手工建的行没有目录来源，`capabilities` 整块就是人说的 —— 其中可覆盖的那几个位同时记进
    // `manual`，否则第一次「补齐元数据」就把它们按目录改掉了。（这里不校验键名：这条路也承载
    // 备份导入的完整能力块；「标记」那个手势只在 PATCH 上，那里才逐键挡。）
    const declared = body.capabilities && typeof body.capabilities === 'object' && !Array.isArray(body.capabilities) ? body.capabilities as Record<string, unknown> : {};
    const capabilities = applyManualCapabilities(JSON.stringify(declared), declared) ?? JSON.stringify(declared);
    try { dependencies.db.prepare(`INSERT INTO models(id,provider_id,model_id,display_name,context_window,max_output,capabilities_json,price_in,price_out,price_cache_read,price_cache_write,enabled,sort,created_at,updated_at)
      VALUES (@id,@providerId,@modelId,@displayName,@contextWindow,@maxOutput,@capabilities,@priceIn,@priceOut,@priceCacheRead,@priceCacheWrite,@enabled,@sort,@now,@now)`).run({ id, providerId: body.providerId, modelId: body.modelId, displayName: body.displayName ?? null, contextWindow, maxOutput, capabilities, priceIn: body.priceIn ?? null, priceOut: body.priceOut ?? null, priceCacheRead: body.priceCacheRead ?? null, priceCacheWrite: body.priceCacheWrite ?? null, enabled: body.enabled === false ? 0 : 1, sort: body.sort ?? 0, now: Date.now() }); }
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
  /** 已经导入过的模型行补元数据：能力块照写（**但人工标记盖回去** —— 能力块不再是纯信息，
   *  `vision` 有运行时行为），定价只填空着的那几个，
   *  窗口/最大输出默认不动 —— 运维可能按自己的预算调小过，覆盖要显式 overwrite。 */
  app.post('/api/models/enrich', async (ctx) => {
    const body = await ctx.req.json<{ ids?: unknown; overwrite?: unknown }>().catch((): { ids?: unknown; overwrite?: unknown } => ({}));
    const wanted = Array.isArray(body.ids) ? new Set(body.ids.filter((entry): entry is string => typeof entry === 'string')) : null;
    const overwrite = body.overwrite === true;
    const rows = dependencies.db.prepare(`SELECT m.id,m.model_id AS modelId,m.context_window AS contextWindow,m.max_output AS maxOutput,m.price_in AS priceIn,m.price_out AS priceOut,
      m.price_cache_read AS priceCacheRead,m.price_cache_write AS priceCacheWrite,m.capabilities_json AS capabilities,p.kind,p.base_url AS baseUrl FROM models m JOIN providers p ON p.id=m.provider_id`).all() as Array<Record<string, unknown>>;
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
        update.run(keepManualCapabilities(capabilityBlock(meta, fetchedAt, priceSource), row.capabilities as string | null),
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
    // 工具输入的第二个来源，也是**唯一对历史轮次有效**的那个：`log_events` 按 logs.retentionDays 清，
    // 且 `logs.captureBodies=false` 时压根不带请求体，而 `context_messages.parts_json` 永久保留。
    // 刻意不走 `ContextRepository.messages()` —— 那条路会跑 elidePart，把降级过的行改写成
    // `{elided:true}`。分级降级只翻 prune_applied 标志位、原始 parts 一直在（docs/02 §裁剪）,
    // 所以这里直读列，并把 prune 状态一起送出去：界面要能说「模型已经看不到这段参数，但它长这样」。
    const contextRows = dependencies.db.prepare(`SELECT ordinal,id,role,origin,prune_level AS pruneLevel,prune_applied AS pruneApplied,
      parts_json AS parts,text_preview AS textPreview,tokens,created_at AS createdAt
      FROM context_messages WHERE key=? AND turn_id=? ORDER BY ordinal LIMIT 500`).all(turn.key, id) as Array<Record<string, unknown> & { parts: string }>;
    const contextMessages = contextRows.map(({ parts, ...row }) => ({ ...row, pruneApplied: Boolean(row.pruneApplied), ...detailPayload(parts) }));
    return ctx.json({ ok: true, data: { turn, captureBodies: currentConfig().logs.captureBodies, events, contextMessages } });
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
    if (!row?.path) return ctx.json(apiError('not_found', '附件不存在', 404).body, 404);
    let absolute: string;
    try { absolute = storedPathWithin(currentConfig().media.dir, row.path); }
    catch { return ctx.json(apiError('not_found', '附件路径不在媒体目录内', 404).body, 404); }
    if (!existsSync(absolute)) return ctx.json(apiError('not_found', '附件不存在', 404).body, 404);
    // `?inline=1` 只对光栅图放行。同源内联渲染 SVG/HTML 等于把用户上传的内容变成本站脚本，
    // 而附件的 mime 来自 Telegram、是发送方可控的 —— 白名单之外一律照旧当附件下载。
    const inline = ctx.req.query('inline') === '1' && INLINE_MIME.has(row.mime ?? '');
    // 流式而不是 `readFileSync`：一份 20 MB 的文档此前是一次 20 MB 堆分配加一次 20 MB 响应缓冲，
    // 而 `media.maxDocBytes` 就是 20 MiB（docs/27 · S-07）。
    return new Response(Readable.toWeb(createReadStream(absolute)) as ReadableStream, { headers: { 'content-type': row.mime ?? 'application/octet-stream',
      'content-length': String(statSync(absolute).size),
      'content-disposition': inline ? 'inline' : contentDisposition(row.name ?? ctx.req.param('attachmentId')) } });
  });
  app.get('/api/chats/:key/context', (ctx) => ctx.json({ ok: true, data: dependencies.context.materialize(ctx.req.param('key'), ctx.req.query('commit') ?? null, currentConfig().context.cacheCommits) }));
  app.get('/api/chats/:key/commits', (ctx) => ctx.json({ ok: true, data: dependencies.context.stats(ctx.req.param('key'), { timeline: true }) }));
  app.post('/api/chats/:key/commits/:id/checkout', (ctx) => ctx.json({ ok: true, data: dependencies.context.setHead(ctx.req.param('key'), ctx.req.param('id'), 'webui') }));
  // `advanceClaims` 跟着 `context.recallBarrier`：开着时清空要连背景认领水位一起推，否则清空前
  // 那些没被认领的群发言会从另一扇门进到新窗口里（`ContextEngine.reset` 的 docstring）。
  app.post('/api/chats/:key/reset', (ctx) => ctx.json({ ok: true, data: dependencies.context.reset(ctx.req.param('key'), 'webui', { advanceClaims: currentConfig().context.recallBarrier }) }));
  app.post('/api/chats/:key/undo', (ctx) => ctx.json({ ok: true, data: dependencies.context.undo(ctx.req.param('key')) }));
  app.patch('/api/models/:id', async (ctx) => {
    const body = await ctx.req.json<Record<string, unknown>>();
    const map: Record<string, string> = { displayName: 'display_name', contextWindow: 'context_window', maxOutput: 'max_output', priceIn: 'price_in', priceOut: 'price_out', priceCacheRead: 'price_cache_read', priceCacheWrite: 'price_cache_write', enabled: 'enabled', sort: 'sort' };
    const entries = Object.entries(body).filter(([key]) => map[key]);
    /**
     * 能力标记：中转站照抄官方模型名却不真的转发图片时，`capabilities_json` 抄来的
     * `vision:true` 会让含图轮次**不切** `vision` 别名，图就留在一个看不见它的模型上
     * （实测 `logs/2026-08-19`：同一家网关的 grok-4.5 收下 image_url、200 返回、
     * usage 里没有 image_tokens，四次全在瞎猜；同一家的 grok-4.3 正常）。目录改不了那个事实，
     * 所以要给运维一条推翻它的路 —— 这是本条唯一的存在理由。
     *
     * 白名单外的键**报错而不是静静吞掉**：让人以为标了「不支持工具」就不会发工具目录，
     * 比不给这个选项糟得多。
     */
    const patch = body.capabilities && typeof body.capabilities === 'object' && !Array.isArray(body.capabilities) ? body.capabilities as Record<string, unknown> : null;
    if (patch) {
      const stray = Object.keys(patch).filter((key) => !(OVERRIDABLE_CAPABILITIES as readonly string[]).includes(key));
      if (stray.length) return ctx.json(apiError('model_invalid', `只有 ${OVERRIDABLE_CAPABILITIES.join(' / ')} 能人工标记；${stray.join('、')} 运行时不读，标了也不会改变行为`).body, 400);
      if (Object.values(patch).some((value) => value !== null && typeof value !== 'boolean')) return ctx.json(apiError('model_invalid', '能力标记只能是 true / false / null（null = 取消标记，回到目录判断）').body, 400);
    }
    if (!entries.length && !patch) return ctx.json({ ok: true, data: { changes: 0 } });
    let changes = 0;
    if (entries.length) {
      const sql = entries.map(([key]) => `${map[key]}=?`).join(',');
      const values = entries.map(([key, value]) => key === 'enabled' ? (value ? 1 : 0) : value);
      changes = dependencies.db.prepare(`UPDATE models SET ${sql},updated_at=? WHERE id=?`).run(...values, Date.now(), ctx.req.param('id')).changes;
    }
    // 手改过价格之后还挂着「官方价」徽标就是在骗人：把出处翻成 manual，界面据此改标。
    if (changes && entries.some(([key]) => key.startsWith('price'))) {
      const row = dependencies.db.prepare('SELECT capabilities_json AS capabilities FROM models WHERE id=?').get(ctx.req.param('id')) as { capabilities: string | null } | undefined;
      try {
        const parsed = row?.capabilities ? JSON.parse(row.capabilities) as Record<string, unknown> : {};
        const catalog = parsed.catalog && typeof parsed.catalog === 'object' ? parsed.catalog as Record<string, unknown> : null;
        if (catalog) { catalog.priceSource = 'manual'; dependencies.db.prepare('UPDATE models SET capabilities_json=? WHERE id=?').run(JSON.stringify(parsed), ctx.req.param('id')); }
      } catch { /* 历史行里可能是坏 JSON，改价不该因此失败 */ }
    }
    if (patch) {
      // 上面那段可能刚改过 capabilities_json（priceSource），所以在它之后再读一次。
      const row = dependencies.db.prepare('SELECT capabilities_json AS capabilities FROM models WHERE id=?').get(ctx.req.param('id')) as { capabilities: string | null } | undefined;
      const next = row ? applyManualCapabilities(row.capabilities, patch) : null;
      if (next !== null) {
        changes = Math.max(changes, dependencies.db.prepare('UPDATE models SET capabilities_json=?,updated_at=? WHERE id=?').run(next, Date.now(), ctx.req.param('id')).changes);
        // 这条标记会改变含图轮次走哪个模型，值得单独留一行 —— 中间件那条只记方法与路径。
        dependencies.log.event({ level: 'info', kind: 'webui.action', summary: 'model capability marked', data: { id: ctx.req.param('id'), capabilities: patch } });
      }
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
    // 判据与三个 Telegram 命令共用一份（`TG_ID_PATTERN` / `parsePrincipal`，docs/27 · C-05）。
    const malformed = ids.filter((id) => !TG_ID_PATTERN.test(id));
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
    const body = await ctx.req.json<{ enabled?: boolean; minRole?: unknown; approval?: unknown; timeoutMs?: unknown; confirmRelax?: boolean }>();
    const known = dependencies.tools?.describe().find((entry) => entry.name === name);
    if (!known && !Object.hasOwn(TOOL_POLICY, name)) return ctx.json(apiError('not_found', '工具不存在', 404).body, 404);
    const base = known?.defaults ?? TOOL_POLICY[name as keyof typeof TOOL_POLICY];
    const key = `tools.overrides.${name}`;
    const pinned = envConflicts([key]);
    if (pinned.length) return ctx.json(envPinnedError(pinned).body, 400);
    // 一个 key 就是 `config_kv` 里一条整叶 JSON，所以必须**先读当前覆盖再整体写回**：只写请求里
    // 带来的那个字段，会把同一条 JSON 里其余的覆盖一起抹掉（点一下启停就丢掉刚调好的 minRole）。
    // 三个策略字段显式给 `null` = 恢复默认，也就是从这条 JSON 里删掉它。
    //
    // 基准优先取**库里那一行**而不是 `currentConfig()`：`config.changed` 之后的重载是异步的
    // （`main.ts` 里 `void loadConfig(...).then(...)`），连着改两次的话第二次会读到重载前的旧快照，
    // 把第一次的改动原样覆盖掉。没有那一行时才回落到快照 —— 覆盖也可能来自 config.yaml 或
    // `tools.overrides` 整块那一层，那两层只有快照看得见。
    const persisted = dependencies.db.prepare('SELECT value_json AS value FROM config_kv WHERE key=?').get(key) as { value: string } | undefined;
    const current: ToolOverride = persisted ? JSON.parse(persisted.value) as ToolOverride : { ...currentConfig().tools.overrides[name] };
    const next: ToolOverride = { ...current };
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') return ctx.json(apiError('invalid_tool_override', 'enabled 必须是布尔值').body, 400);
      next.enabled = body.enabled;
    }
    if (body.minRole !== undefined) {
      if (body.minRole !== null && !ROLES.includes(body.minRole as Role)) return ctx.json(apiError('invalid_tool_override', `minRole 必须是 ${ROLES.join(' / ')} 之一`).body, 400);
      if (body.minRole === null) delete next.minRole; else next.minRole = body.minRole as Role;
    }
    if (body.approval !== undefined) {
      if (body.approval !== null && !APPROVAL_POLICIES.includes(body.approval as (typeof APPROVAL_POLICIES)[number])) return ctx.json(apiError('invalid_tool_override', `approval 必须是 ${APPROVAL_POLICIES.join(' / ')} 之一`).body, 400);
      if (body.approval === null) delete next.approval; else next.approval = body.approval as (typeof APPROVAL_POLICIES)[number];
    }
    if (body.timeoutMs !== undefined) {
      if (body.timeoutMs !== null && (typeof body.timeoutMs !== 'number' || !Number.isInteger(body.timeoutMs) || body.timeoutMs <= 0)) return ctx.json(apiError('invalid_tool_override', 'timeoutMs 必须是正整数毫秒').body, 400);
      if (body.timeoutMs === null) delete next.timeoutMs; else next.timeoutMs = body.timeoutMs;
    }
    // 放宽（minRole 调低 / 审批降档）要二次确认。**校验在落库之前**：没确认时一个字都不写，
    // 否则「先存了再问」的确认框只是事后通知（docs/09 §3.7）。超时与启停不在其列。
    const relaxed = relaxedFields(base, next);
    if (relaxed.length && body.confirmRelax !== true) {
      const effective = effectiveToolPolicy(base, next);
      return ctx.json({ ok: false, error: { code: 'relax_requires_confirmation', message: `${name} 的${relaxed.map((field) => field === 'minRole' ? '最低角色' : '审批策略').join(' 与 ')}比代码里的默认更松，需要二次确认`,
        details: relaxed.map((field) => ({ path: field, from: base[field], to: effective[field] })) } }, 409);
    }
    const merged = mergeDotted(currentConfig(), { [key]: next });
    if (!merged.ok) return ctx.json(invalidKey(merged).body, 400);
    const parsed = runtimeConfigSchema.safeParse(merged.value);
    if (!parsed.success) return ctx.json({ ok: false, error: { code: 'invalid_config', message: '工具覆盖校验失败', details: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) } }, 400);
    writeConfigRows([[key, readDotted(parsed.data, key)]], 'webui');
    dependencies.events.emit('config.changed', { keys: [key] });
    // 放宽记 warn 而不是 info：这是日志页上最该一眼看见的运维动作。这个端点此前一条日志都不记。
    dependencies.log.event({ level: relaxed.length ? 'warn' : 'info', kind: 'webui.action',
      summary: relaxed.length ? `tool policy relaxed: ${name}` : `tool override changed: ${name}`, data: { tool: name, override: next, relaxed } });
    return ctx.json({ ok: true, data: { name, override: next, relaxed, effective: { ...effectiveToolPolicy(base, next), enabled: next.enabled !== false } } });
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
   * 会话级持久容器（docs/09 §3.7，语义见 docs/05 §5.5）。三个端点共用这一道：运行时没装配时
   * 回 `not_implemented` 而**不是空列表** —— 「读不到」和「一个都没有」在运维眼里是两回事。
   */
  const containersOr501 = (): ContainerManager | null => dependencies.sandbox?.containers() ?? null;
  app.get('/api/containers', (ctx) => {
    const boxes = containersOr501();
    if (!boxes) return ctx.json(apiError('not_implemented', '这个部署没有装配持久容器运行时', 500).body, 500);
    const labels = new Map(chatCandidates(dependencies.db).map((candidate) => [candidate.chatId, candidate.label]));
    return ctx.json({ ok: true, data: { enabled: boxes.enabled(), ...boxes.capacity(),
      containers: boxes.list().map((row) => ({ ...row, pinned: row.pinned !== 0, hasSetsid: row.hasSetsid !== 0,
        chatLabel: labels.get(row.chatId) ?? null })) } });
  });
  app.delete('/api/containers/:chatId', async (ctx) => {
    const boxes = containersOr501();
    if (!boxes) return ctx.json(apiError('not_implemented', '这个部署没有装配持久容器运行时', 500).body, 500);
    const chatId = ctx.req.param('chatId');
    const workspace = dependencies.sandbox!.hostWorkspaceFor(chatId);
    if (workspace === null) return ctx.json(apiError('workspace_unmappable', '这个会话的工作目录换算不到宿主路径，建不了容器').body, 400);
    // `?wipe=1` 才动文件。**「换环境」和「删数据」是两件事**，默认那一档一个文件都不碰
    // （同 `container_reset` 的默认值，docs/05 §3.11）。
    if (ctx.req.query('wipe') === '1') {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const wipe = await boxes.exec({ chatId, mountedWorkspace: workspace, timeoutMs: 60_000, abortSignal: AbortSignal.timeout(90_000),
        command: `set -e; mkdir -p .luoli-trash/${stamp}; for entry in * .[!.]*; do [ -e "$entry" ] || continue; case "$entry" in .luoli-trash) continue;; esac; mv -- "$entry" .luoli-trash/${stamp}/; done` });
      if ('error' in wipe) return ctx.json(apiError(wipe.error, wipe.hint ?? '清理工作区失败，容器也没动').body, 400);
      if (!wipe.ok) return ctx.json(apiError('workspace_wipe_failed', `文件没能挪进回收站，容器也没动：${wipe.stderr.slice(0, 400)}`).body, 400);
    }
    const reset = await boxes.reset(chatId, workspace);
    if (!reset.ok) return ctx.json(apiError(reset.error, reset.hint ?? '重置失败').body, 400);
    return ctx.json({ ok: true, data: { chatId, name: reset.row.name, wiped: ctx.req.query('wipe') === '1' } });
  });
  app.post('/api/containers/:chatId/keep', async (ctx) => {
    const boxes = containersOr501();
    if (!boxes) return ctx.json(apiError('not_implemented', '这个部署没有装配持久容器运行时', 500).body, 500);
    const body = await ctx.req.json<{ hours?: number; pin?: boolean }>();
    const kept = boxes.keep(ctx.req.param('chatId'), { ...(body.hours === undefined ? {} : { hours: body.hours }), ...(body.pin === undefined ? {} : { pin: body.pin }) });
    if (!kept.ok) return ctx.json(apiError(kept.error, kept.hint ?? '改不了到期时间').body, 404);
    return ctx.json({ ok: true, data: { ...kept.row, pinned: kept.row.pinned !== 0, hasSetsid: kept.row.hasSetsid !== 0 } });
  });
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
  app.get('/api/prompts/:id', (ctx) => {
    const row = dependencies.db.prepare('SELECT * FROM memory_docs WHERE id=?').get(ctx.req.param('id')) as { path?: string } | undefined;
    if (!row?.path) return ctx.json(apiError('not_found', '文档不存在', 404).body, 404);
    // `memory_docs.path` 今天只由本进程写，但「库里的路径值可信」是一个会随时间失效的假设
    // （导入、迁移、手工修库）。同一个文件里读日志目录就是过 `safeRef()` 的（docs/27 · S-07）。
    let content: string;
    try { content = readFileSync(storedPathWithin(currentConfig().memory.dir, row.path), 'utf8'); }
    catch { return ctx.json(apiError('not_found', '文档文件读不到或不在记忆目录内', 404).body, 404); }
    return ctx.json({ ok: true, data: { ...row, content } });
  });
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
  /**
   * 定时任务面板（docs/21 · `G-API-16`）。此前运维在 WebUI 里既看不到这个部署有哪些任务在排、
   * 也停不掉任何一条 —— 止损只能去 Telegram 让 bot 跑 `schedule_cancel`。
   *
   * **建任务与工具共用 `createScheduledJob`**：两边各写一遍校验的话，WebUI 迟早能建出工具
   * 建不出来的任务（比如每分钟一次的 agent 轮次）。
   */
  const scheduleRuntime = (): NonNullable<ServerDependencies['schedules']> | null => dependencies.schedules ?? null;
  const scheduleRow = (job: ScheduledJob): Record<string, unknown> => ({
    id: job.id, key: job.key, chatId: job.chatId, threadId: job.threadId, createdBy: job.createdBy,
    chatLabel: principalLabel(dependencies.db, 'chat', job.chatId),
    creatorLabel: principalLabel(dependencies.db, 'user', job.createdBy),
    createdAt: job.createdAt, updatedAt: job.updatedAt,
    ...scheduledJobView(job, job.state === 'active' ? (scheduleRuntime()?.runner.nextRun(job.id) ?? null) : null),
  });
  app.get('/api/schedules', (ctx) => {
    const runtime = scheduleRuntime();
    const live = currentConfig();
    if (!runtime) return ctx.json({ ok: true, data: { available: false, enabled: live.schedule.enabled, timezone: live.general.timezone, jobs: [] } });
    return ctx.json({ ok: true, data: { available: true, enabled: live.schedule.enabled, timezone: live.general.timezone,
      settings: { maxPerChat: live.schedule.maxPerChat, minIntervalMinutes: live.schedule.minIntervalMinutes, maxPayloadChars: live.schedule.maxPayloadChars },
      jobs: runtime.jobs.listAll().map(scheduleRow) } });
  });
  app.post('/api/schedules', async (ctx) => {
    const runtime = scheduleRuntime();
    if (!runtime) return ctx.json(apiError('not_implemented', '这个部署没有装配定时任务运行时', 500).body, 500);
    const body = await ctx.req.json<Record<string, unknown>>().catch((): Record<string, unknown> => ({}));
    const key = typeof body.key === 'string' ? body.key : '';
    // 落点从 `contexts` 反查，不收客户端给的 chatId/threadId：那一对是会话隔离的锚点，
    // 让调用方自己拼等于凭一个字段就能把任务塞进任意会话（同 docs/05 §8 对工具的要求）。
    const target = dependencies.db.prepare('SELECT chat_id AS chatId,thread_id AS threadId FROM contexts WHERE key=?').get(key) as { chatId: string; threadId: number | null } | undefined;
    if (!target) return ctx.json(apiError('chat_not_found', '会话不存在：只能给已经有上下文的会话排任务').body, 400);
    const mode = body.mode === 'agent' || body.mode === 'notify' ? body.mode : null;
    if (!mode) return ctx.json(apiError('invalid_mode', 'mode 只能是 agent 或 notify').body, 400);
    const live = currentConfig();
    // WebUI 只有 owner 一个身份（docs/14 A15），所以任务归属 `access.bootstrapOwnerId`。
    // 它仍然要过 D9：触发时按 min(用户角色, 会话角色) 重算，在不受信的群里不会因为「owner 建的」而提权。
    const createdBy = live.access.bootstrapOwnerId;
    if (!createdBy) return ctx.json(apiError('owner_unset', '没有配 access.bootstrapOwnerId：任务需要一个归属身份才能在触发时重算权限').body, 400);
    const result = createScheduledJob(runtime.jobs, runtime.runner,
      { name: String(body.name ?? ''), mode, text: String(body.text ?? ''), ...(typeof body.cron === 'string' && body.cron ? { cron: body.cron } : {}), ...(typeof body.at === 'string' && body.at ? { at: body.at } : {}) },
      { key, chatId: target.chatId, threadId: target.threadId, createdBy, timezone: live.general.timezone, settings: live.schedule });
    if (!result.ok) return ctx.json(apiError(result.error, result.hint).body, 400);
    dependencies.log.event({ level: 'info', kind: 'schedule.created', summary: `WebUI 新建定时任务 ${result.job.name}`, chatId: result.job.chatId, key: result.job.key,
      data: { job: result.job.id, name: result.job.name, mode: result.job.mode, cron: result.job.cron, runAt: result.job.runAt, actor: 'webui' } });
    return ctx.json({ ok: true, data: scheduleRow(result.job) });
  });
  app.delete('/api/schedules/:id', (ctx) => {
    const runtime = scheduleRuntime();
    if (!runtime) return ctx.json(apiError('not_implemented', '这个部署没有装配定时任务运行时', 500).body, 500);
    const id = ctx.req.param('id');
    const job = runtime.jobs.byId(id);
    if (!job) return ctx.json(apiError('not_found', '任务不存在（可能已被保留策略清理）', 404).body, 404);
    // 已结束的行返回 `cancelled:false` 而不是假成功：界面据此说「这条本来就已经停了」。
    const changed = runtime.jobs.finish(id, 'cancelled');
    runtime.runner.unregister(id);
    if (changed) {
      dependencies.log.event({ level: 'warn', kind: 'schedule.cancelled', summary: `WebUI 停用定时任务 ${job.name}`, chatId: job.chatId, key: job.key,
        data: { job: id, name: job.name, actor: 'webui' } });
    }
    return ctx.json({ ok: true, data: { cancelled: changed, name: job.name } });
  });
  /**
   * 立即触发一次。**不等它跑完**：`mode='agent'` 的一次触发是一整轮真实模型调用，
   * 同步等下去会把这个请求挂到 `concurrency.turnTimeoutMs`。所以先回响应（同
   * `POST /api/restart` 的做法），结果落在这一行的 `lastState` / `lastError` 与日志里。
   * 不影响下一次的正常触发 —— cron 那边的计时器没被动过。
   */
  app.post('/api/schedules/:id/trigger', (ctx) => {
    const runtime = scheduleRuntime();
    if (!runtime) return ctx.json(apiError('not_implemented', '这个部署没有装配定时任务运行时', 500).body, 500);
    // 启动窗口：HTTP 从 `serve()` 起就在监听，而 runner 的 `load()` 要等 bot 起来 —— 这中间触发
    // 一条任务会开一整轮、跑完模型、记完账，最后以 `delivery_failed:telegram_unavailable` 收尾且
    // 不提交（docs/28 · L-SCH-01）。**理由要写进响应**，否则界面上只剩一句「触发失败」。
    if (!runtime.runner.loaded) return ctx.json(apiError('not_ready', '定时任务运行时还没装载完（Telegram 投递通道未就绪），过几秒再试；这个部署没有配可用的 BOT_TOKEN 时手动触发一直不可用', 400).body, 400);
    const id = ctx.req.param('id');
    const job = runtime.jobs.byId(id);
    if (!job) return ctx.json(apiError('not_found', '任务不存在', 404).body, 404);
    if (job.state !== 'active') return ctx.json(apiError('not_active', `这条任务是 ${job.state}，不会再触发`, 409).body, 409);
    dependencies.log.event({ level: 'info', kind: 'schedule.fired', summary: `WebUI 手动触发定时任务 ${job.name}`, chatId: job.chatId, key: job.key,
      data: { job: id, name: job.name, mode: job.mode, actor: 'webui', manual: true } });
    void runtime.runner.fire(id).catch((error: unknown) => dependencies.log.event({ level: 'error', kind: 'schedule.failed',
      summary: `手动触发 ${job.name} 失败`, chatId: job.chatId, key: job.key, data: { job: id, error: error instanceof Error ? error.message : String(error) } }));
    return ctx.json({ ok: true, data: { started: true, name: job.name, mode: job.mode } });
  });
  // **不是 `SELECT *`**：那会把 `path`（宿主文件系统路径）、`content_hash` 与整份
  // `frontmatter_json` 一起发给前端，而扩展页只用得上这七列。
  app.get('/api/skills', (ctx) => ctx.json({ ok: true, data: dependencies.db.prepare(
    'SELECT name,description,min_role,enabled,source,load_error,updated_at FROM skills ORDER BY name').all() }));
  app.get('/api/skills/:name', (ctx) => {
    const skill = dependencies.skills?.read(ctx.req.param('name'));
    return skill ? ctx.json({ ok: true, data: skill }) : ctx.json(apiError('not_found', 'Skill 不存在', 404).body, 404);
  });
  /**
   * 随包发的四份说明书**只放行启停**。`write_skill` 从一开始就拒改它们（模型把自己的说明书
   * 改坏之后，下一次它就是照着改坏的那份写的），而这一侧此前能改能删 —— 同一条不变量只焊住了一半。
   * 停用是正当的运维动作，所以只挡「改 `enabled` 以外的字段」和删除。
   */
  const reservedSkill = (ctx: Context<ServerEnv>, body?: Record<string, unknown>): Response | null => {
    const name = ctx.req.param('name') ?? '';
    if (!(BUNDLED_SKILLS as readonly string[]).includes(name)) return null;
    if (body && Object.keys(body).every((key) => key === 'enabled')) return null;
    return ctx.json(apiError('skill_reserved', `${name} 是随包发的说明书，只能启停，不能改正文或删除`, 403).body, 403);
  };
  // PUT 与 PATCH 走同一条路：SkillLoader.update 本来就是「只覆盖给到的字段」，
  // 两个动词分别抄一份 body 映射，改 frontmatter 字段时必然漏掉其中一个。
  const skillWriteInput = (body: Record<string, unknown>): SkillWriteInput => ({ description: body.description as string | undefined, body: body.body as string | undefined,
    allowedTools: body.allowedTools as string[] | undefined, minRole: body.minRole as Role | undefined, model: body.model as string | null | undefined, enabled: body.enabled as boolean | undefined });
  const updateSkill = async (ctx: Context<ServerEnv>): Promise<Response> => {
    if (!dependencies.skills) return ctx.json(apiError('not_implemented', 'SkillLoader 未配置', 500).body, 500);
    const body = await ctx.req.json<Record<string, unknown>>().catch((): Record<string, unknown> => ({}));
    const reserved = reservedSkill(ctx, body);
    if (reserved) return reserved;
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
  /**
   * 装一个 skill 包（docs/07 §2.5）。**与 `install_skill` 工具共用 `installSkillPackage`** ——
   * 端点自己抄一遍解包逻辑的话，两条路迟早在校验上分叉，而那里的每一条都是安全判据。
   *
   * 上传的 zip 落在 `<skillsDir>/.uploads/` 而不是 `os.tmpdir()`：装的目标就在同一个卷上，
   * 而且点号开头的目录 `SkillLoader.scan()` 不看。用完即删。
   */
  app.post('/api/skills/package', async (ctx) => {
    if (!dependencies.skills) return ctx.json(apiError('not_implemented', 'SkillLoader 未配置', 500).body, 500);
    const limits = currentConfig().skills.package;
    const body = await ctx.req.parseBody().catch(() => null);
    const file = body?.file;
    if (!(file instanceof File)) return ctx.json(apiError('invalid_package', '需要 multipart 表单里的 file 字段').body, 400);
    if (file.size > limits.maxTotalBytes) return ctx.json(apiError('skill_package_too_large', `压缩包超过 ${limits.maxTotalBytes} 字节`, 413).body, 413);
    const uploads = join(dependencies.skills.directory, '.uploads');
    mkdirSync(uploads, { recursive: true, mode: 0o700 });
    const staged = join(uploads, `${Date.now()}-${randomBytes(8).toString('hex')}.zip`);
    const text = (key: string): string | undefined => (typeof body?.[key] === 'string' && body[key] ? body[key] : undefined);
    try {
      writeFileSync(staged, Buffer.from(await file.arrayBuffer()), { mode: 0o600 });
      const installed = await installSkillPackage(dependencies.skills, staged, {
        limits, minRoleFloor: currentConfig().tools.selfExtend.skills.minRole, origin: file.name,
        ...(text('name') ? { name: text('name') } : {}), ...(text('subdir') ? { subdir: text('subdir') } : {}),
        ...(body?.overwrite === 'true' ? { overwrite: true } : {}),
      });
      return ctx.json({ ok: true, data: installed }, 201);
    } catch (error) {
      if (!(error instanceof SkillPackageError)) {
        return ctx.json(apiError('skill_package_failed', error instanceof Error ? error.message : '装包失败').body, 400);
      }
      const status = error.code === 'skill_already_exists' ? 409 : error.code === 'skill_reserved' ? 403 : 400;
      // 包根有歧义时**必须把候选带回去**：前端要拿它渲染一个「装哪一个」的选择，
      // 只回一句「有歧义」等于让运维自己去猜 subdir 该填什么。
      return ctx.json({ ok: false as const, error: { code: error.code, message: error.hint ?? error.code, ...(error.candidates ? { details: { candidates: error.candidates } } : {}) } }, status);
    } finally { rmSync(staged, { force: true }); }
  });
  app.put('/api/skills/:name', updateSkill);
  app.patch('/api/skills/:name', updateSkill);
  app.delete('/api/skills/:name', (ctx) => {
    if (!dependencies.skills) return ctx.json(apiError('not_implemented', 'SkillLoader 未配置', 500).body, 500);
    const reserved = reservedSkill(ctx);
    if (reserved) return reserved;
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
  // 重载在 tsx（`pnpm dev`）下装得像成功了、实际一直跑旧代码，而这是修不掉的（tsx 的 loader
  // 按路径缓存、忽略 cache-busting 查询串）。回 200 就必须把这件事带在响应里，否则界面上
  // 「已重载」是一句假话（docs/28 · L-EXT-04）。与启动告警共用同一句 `hotReloadWarning`。
  app.post('/api/plugins/:name/reload', async (ctx) => {
    await dependencies.plugins?.reconcile();
    const warning = dependencies.plugins?.hotReloadWarning ?? null;
    return ctx.json({ ok: true, data: { name: ctx.req.param('name'), hotReloadReliable: warning === null, ...(warning ? { warning } : {}) } });
  });
  // 「启用前先看过源码」是 plugin 那道闸的**全部**内容（进程内全信任 = root，docs/14 A27），
  // 而模型现在能往 `plugins/` 里写文件了 —— 没有这个读端点，那句话就只是口号。
  app.get('/api/plugins/:name/source', (ctx) => {
    if (!dependencies.plugins) return ctx.json(apiError('not_implemented', 'PluginManager 未配置', 500).body, 500);
    try {
      const source = dependencies.plugins.readSource(ctx.req.param('name'));
      return source === null ? ctx.json(apiError('not_found', 'plugin.js 不存在', 404).body, 404) : ctx.json({ ok: true, data: { name: ctx.req.param('name'), source } });
    } catch { return ctx.json(apiError('invalid_plugin_name', '名字要是 kebab-case').body, 400); }
  });
  app.delete('/api/plugins/:name', async (ctx) => {
    if (!dependencies.plugins) return ctx.json(apiError('not_implemented', 'PluginManager 未配置', 500).body, 500);
    try {
      // 什么都没删掉时 404，与隔壁 `DELETE /api/custom-tools/:name` 同一口径 —— 回 200 的话
      // 界面会对着一个拼错的名字弹「已删除」。
      const removed = await dependencies.plugins.remove(ctx.req.param('name'));
      return removed ? ctx.json({ ok: true, data: { removed } }) : ctx.json(apiError('not_found', 'Plugin 不存在', 404).body, 404);
    } catch (error) { return ctx.json(apiError('plugin_delete_failed', error instanceof Error ? error.message : 'plugin 删除失败', 400).body, 400); }
  });
  /**
   * 自撰写工具的复审面。与工具页那条 `PATCH /api/tools/:name` 是**两个动词**：这里管
   * 「这个工具存不存在、审没审过」，那边管「现在开着没有」。合并的话，一次运维停用会看起来像
   * 把复审记录也撤了。
   */
  app.get('/api/custom-tools', (ctx) => {
    if (!dependencies.customTools) return ctx.json(apiError('not_implemented', '这个部署没有装配自撰写工具', 500).body, 500);
    return ctx.json({ ok: true, data: dependencies.customTools.list() });
  });
  app.patch('/api/custom-tools/:name', async (ctx) => {
    if (!dependencies.customTools || !dependencies.customToolManager) return ctx.json(apiError('not_implemented', '这个部署没有装配自撰写工具', 500).body, 500);
    // 只收 `enabled`。`scope` / `minRole` 归模型那侧的定义（改了要重新复审），从这里改会让
    // `definition_hash` 与模型以为的那份定义脱节 —— 声明一个读不到的字段比不声明更糟。
    const body = await ctx.req.json<{ enabled?: boolean }>().catch(() => ({}) as { enabled?: boolean });
    const name = ctx.req.param('name');
    if (!dependencies.customTools.get(name)) return ctx.json(apiError('not_found', '自定义工具不存在', 404).body, 404);
    if (typeof body.enabled !== 'boolean') return ctx.json(apiError('invalid_custom_tool', 'enabled 必须是布尔值').body, 400);
    dependencies.customTools.setEnabled(name, body.enabled);
    dependencies.customToolManager.reconcile();
    // 启用一段模型写的脚本是最该在日志页一眼看见的运维动作，记 warn 而不是 info。
    dependencies.log.event({ level: body.enabled ? 'warn' : 'info', kind: 'webui.action',
      summary: `custom tool ${body.enabled ? 'enabled' : 'disabled'}: ${name}`, data: { tool: name, enabled: body.enabled } });
    return ctx.json({ ok: true, data: dependencies.customTools.get(name) });
  });
  app.delete('/api/custom-tools/:name', (ctx) => {
    if (!dependencies.customTools || !dependencies.customToolManager) return ctx.json(apiError('not_implemented', '这个部署没有装配自撰写工具', 500).body, 500);
    const removed = dependencies.customTools.remove(ctx.req.param('name'));
    if (!removed) return ctx.json(apiError('not_found', '自定义工具不存在', 404).body, 404);
    dependencies.customToolManager.reconcile();
    return ctx.json({ ok: true, data: { removed } });
  });
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
  // 文件定义（`agents/<name>.md`）与配置定义合并后一起交出去，每条带 `source`（docs/14 §2 Q5-b）：
  // 界面上要能一眼看出哪条来自文件、哪条被 WebUI 覆盖过。**只回不可编辑的事实，不回文件路径**。
  // 合并逻辑与 `main.ts` 共用 `mergeAgentDefinitions` —— 端点自己抄一遍的话，WebUI 迟早会显示出
  // 一份运行时并不生效的名单。
  app.get('/api/agents', (ctx) => {
    const config = currentConfig();
    const scan = scanAgentFiles(config.agent.agentsDir);
    const fromFiles = new Set(scan.definitions.map((definition) => definition.name));
    const overridden = new Set(config.agent.agents.map((definition) => definition.name));
    const data = mergeAgentDefinitions(scan.definitions, config.agent.agents).map((definition) => ({ ...definition,
      source: fromFiles.has(definition.name) ? (overridden.has(definition.name) ? 'file-overridden' : 'file') : 'config' }));
    // 解析失败的文件不混进这张表（它们没有可展示的定义），走日志：启动与每次配置热更新时
    // `main.ts` 各记一条 `agent.file_invalid` error + 一行 stderr。**没有文件监听** —— 光改
    // agents/ 下的 .md 不会自动重扫，要么改一次配置要么重启。
    for (const failure of scan.errors) dependencies.log.event({ level: 'error', kind: 'agent.file_invalid', summary: `子 agent 定义解析失败：${failure.file}`, data: failure });
    return ctx.json({ ok: true, data });
  });
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
  /**
   * 单条日志事件的详情（日志页点开一行）。**必须注册在 `/api/logs/blob` 与
   * `/api/logs/trace/:traceId` 之后** —— Hono 按注册序匹配，`:id` 放前面会把那两条整个吃掉。
   * 非数字 id 直接 404，别让 `blob` / `trace` 这种字符串走进 `Number()` 变成 NaN 查询。
   *
   * 列表刻意不带载荷（`OperationsRepository.logs` 的注释），所以正文只有这条路能拿到，
   * 并且跟对话详情共用 `detailPayload`：同一套 blob 解引用与截断语义（docs/10 §读出侧必须解引用）。
   */
  app.get('/api/logs/:id', (ctx) => {
    const raw = ctx.req.param('id');
    if (!/^\d+$/.test(raw)) return ctx.json(apiError('not_found', '日志 id 无效', 404).body, 404);
    const row = dependencies.db.prepare(`SELECT id,ts,level,kind,trace_id AS traceId,span_id AS spanId,parent_span_id AS parentSpanId,
      chat_id AS chatId,user_id AS userId,key,summary,file_ref AS fileRefColumn,duration_ms AS durationMs,data_json AS data
      FROM log_events WHERE id=?`).get(Number(raw)) as (Record<string, unknown> & { data: string | null }) | undefined;
    if (!row) return ctx.json(apiError('not_found', '这条日志不存在（可能已被保留策略清理）', 404).body, 404);
    const { data, fileRefColumn, ...rest } = row;
    const payload = detailPayload(data);
    return ctx.json({ ok: true, data: { ...rest, ...payload, fileRef: payload.fileRef ?? (fileRefColumn as string | null) } });
  });
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
    if (!['day', 'chat', 'user', 'model', 'alias', 'agent', 'provider'].includes(groupBy)) return ctx.json(apiError('invalid_group_by', `维度只能是 day|chat|user|model|alias|agent|provider，收到 ${groupBy}`).body, 400);
    const now = Date.now();
    const from = Number(ctx.req.query('from') ?? now - 30 * 86_400_000);
    const to = Number(ctx.req.query('to') ?? now);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) return ctx.json(apiError('invalid_range', 'from/to 必须是毫秒时间戳且 from ≤ to').body, 400);
    // 时区必须传：日界与总览趋势、配额窗口用同一个口径，否则同一天在两个页面上是两个数字（docs/27 · C-02）。
    const rows = dependencies.ledger?.report(from, to, groupBy as 'day', currentConfig().general.timezone) ?? [];
    // chat / user / provider 维度的 bucket 是裸 id，界面上认不出是谁。在这里补显示名，别让前端再实现一遍
    // `principals` 的反查规则（会话页已经有一份，两份必然漂移）。
    const labelled = ['chat', 'user'].includes(groupBy)
      ? (rows as Array<{ bucket: string | null }>).map((row) => ({ ...row, label: principalLabel(dependencies.db, groupBy === 'chat' ? 'chat' : 'user', row.bucket) }))
      : groupBy === 'provider'
        ? (rows as Array<{ bucket: string | null }>).map((row) => ({ ...row,
          label: (row.bucket ? dependencies.db.prepare('SELECT name FROM providers WHERE id=?').pluck().get(row.bucket) as string | undefined : undefined) ?? row.bucket }))
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
  /**
   * I-13 的**另一半**。那一轮修的是「未匹配的 `/api/*` 拿到 200 + index.html，前端在
   * `response.json()` 处抛 SyntaxError，报错与真实原因毫无关系」；下面那行 `app.all` 就是它。
   * 但端点里**抛出来**的异常走的是 Hono 的默认处理器 —— 实测回的是
   * `text/plain "Internal Server Error"`，同一个病在 500 上原样复发：界面上看到的是
   * `Unexpected token 'I'`，而不是任何人话。这个部署里最常见的触发方式是坏请求体：
   * 39 处 `ctx.req.json()` 有 17 处没有自己的 `.catch()`。
   *
   * 三个分支，顺序有意义：
   * - `HTTPException`（`bodyLimit` 之类中间件扔的）原样交回，与 Hono 默认处理器一致 ——
   *   它们自己已经带好了状态码和响应体。
   * - `SyntaxError` = `ctx.req.json()` 里那次 `JSON.parse` 崩了。**这一条把那 17 个站点
   *   一次性收口**，也不会在下一个新端点上重新漏一遍：逐个加 `.catch()` 修的是今天，
   *   这里修的是这一类。
   * - 其余一律 500，**异常消息不进响应** —— 它可能带库路径、SQL、密钥片段。全文只落
   *   `webui.error` 那一行，回给前端的只有它的 id（`ref:`，与 `bot.ts` 给用户的形状一致）。
   *
   * 非 `/api/` 路径回纯文本：给静态资源套 JSON 信封只会让浏览器拿到一份它不认识的东西。
   */
  app.onError((error, ctx) => {
    if (typeof error === 'object' && error !== null && 'getResponse' in error) return (error as { getResponse: () => Response }).getResponse();
    if (!ctx.req.path.startsWith('/api/')) return ctx.text('Internal Server Error', 500);
    if (error instanceof SyntaxError) return ctx.json(apiError('invalid_json', '请求体不是合法 JSON', 400).body, 400);
    const id = dependencies.log.event({ level: 'error', kind: 'webui.error', summary: `${ctx.req.method} ${ctx.req.path} 未处理异常`,
      data: { method: ctx.req.method, path: ctx.req.path, error: error instanceof Error ? error.stack ?? error.message : String(error) } });
    return ctx.json(apiError('internal', `服务端出错，已记录（ref: ${id}）`, 500).body, 500);
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
