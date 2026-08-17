import { z } from 'zod';
import { roleRank } from '@luoli/shared';

const role = z.enum(['owner', 'trusted', 'limited', 'blocked']);
const nullableMoney = z.number().nonnegative().nullable();
const mcpServerBase = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  enabled: z.boolean().default(true),
  minRole: role.optional(),
  toolAllow: z.array(z.string()).default([]),
  toolDeny: z.array(z.string()).default([]),
  timeoutMs: z.number().int().positive().optional(),
});
const mcpServerSchema = z.discriminatedUnion('transport', [
  mcpServerBase.extend({ transport: z.literal('stdio'), command: z.string().min(1), args: z.array(z.string()).default([]), env: z.record(z.string()).default({}) }),
  mcpServerBase.extend({ transport: z.literal('http'), url: z.string().url(), headers: z.record(z.string()).default({}) }),
]);
/**
 * 审批规则此前是 `z.record(z.unknown())`：写入端什么都收，运行时 `ApprovalRules` 却会把没有 `tool`
 * 的规则整条丢掉、`pattern` 编译不了的规则永不命中、`risk` 写错时当 medium ——「静默不生效」的
 * 审批门等于门开着，而界面上一路 200 OK。收严之后写错当场 400。
 * `always` 只收 `true`：运行时没有「命中但不需要审批」这个语义，收下 `false` 等于再造一个假开关。
 */
const approvalRuleSchema = z.object({
  tool: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  pattern: z.string().min(1).optional(),
  when: z.literal('target_exists').optional(),
  always: z.literal(true).optional(),
  risk: z.enum(['low', 'medium', 'high']).optional(),
}).strict().superRefine((rule, ctx) => {
  if (rule.pattern === undefined) return;
  // 与 `compilePattern`（approval/rules.ts）同一套解析：`(?i)` 前缀 + JS 正则。
  const insensitive = rule.pattern.startsWith('(?i)');
  try { new RegExp(insensitive ? rule.pattern.slice(4) : rule.pattern, insensitive ? 'i' : undefined); }
  catch (error) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['pattern'], message: `不是合法正则，这条规则在运行时永不命中：${error instanceof Error ? error.message : String(error)}` });
  }
});
/** 拼错的时区只在群聊分支炸（私聊不走 Intl），漏到运行时会让整个群会话开不了轮次。 */
const ianaTimezone = z.string().refine((zone) => {
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return true; } catch { return false; }
}, { message: '不是合法的 IANA 时区名' });
/**
 * 真正会跟着 `config.changed` 生效的键（前缀匹配）。判据只有一个：**运行时读的是 getter
 * （`configStore.snapshot()` / `turn.config` / bot.ts 的 config Proxy），而不是启动时那份快照**。
 * doc 11 里标 `热更新` 的键必须落在这个白名单里，`tests/config.test.ts` 逐条断言 ——
 * 上一轮有十组键标着热更新而实际冻在启动时，其中三组还是「出事时运维会去点的那个开关」
 * （docs/20 · W-CFG-02）。往这里加键之前，先确认那条读取路径真的每次都取新值。
 */
export const HOT_RELOADABLE_CONFIG_KEYS = [
  'telegram.allowBots', 'telegram.strictCommandSuffix',
  'access.defaultUserRole', 'access.defaultChatRole', 'access.archiveBlocked',
  'trigger',
  'context.limit', 'context.hardCapRatio', 'context.background', 'context.rebase.injectNotice', 'context.tokenRatioAlpha',
  'concurrency.turnTimeoutMs',
  'prompt.maxTokens',
  'agent.main', 'agent.agents',
  'provider.maxRetries', 'provider.retryBaseMs', 'provider.retryMaxMs', 'provider.catalog',
  // 出网放行开关每次探测现读（app.ts 的 probeProvider 调用点、ModelCatalog 的 options getter）。
  // 它是「出事时运维会去点的那个开关」那一类，冻住等于界面说改成功了、下一次探测照样打私网。
  'provider.allowPrivateBaseUrl',
  // memory_write 读的是本轮那份 turn.config（perChatConfig 每轮重算），不再是启动快照（docs/22 · D-CFG-01）。
  'memory.pubWriteMinRole',
  'tools.maxRegistered', 'tools.maxCallsPerTurn', 'tools.maxConsecutiveErrors', 'tools.overrides', 'tools.exec', 'tools.tg',
  'approval.enabled', 'approval.ttlMs', 'approval.rules', 'approval.skipForOwner', 'approval.rememberWithinTurn',
  // captureBodies 是每轮从 turn.config 现读的（runtime.ts 的 bodyForLog、/api/turns/:id/detail），
  // 改完下一轮就生效。漏在白名单外时 WebUI 会对着排障时最常翻的这个开关说「需重启」。
  'sandbox', 'skills.defaultMinRole', 'quota', 'logs.level', 'logs.captureBodies',
  // mcp 整段曾在这里，但 `mcp.healthCheckCron` 是 `scheduler.add(config.mcp.healthCheckCron, …)`
  // 在启动时拿走的，Scheduler 也没有重配入口 —— 整段标热更新等于对着那一项说谎（docs/20 · W-CFG-02）。
  // 这三项才是真的按 getter 读（`McpManager` 的 config getter + config.changed 后的 reconcile）。
  'mcp.enabled', 'mcp.defaultMinRole', 'mcp.servers',
  // WebUI 自己那几项是每请求从 currentConfig() 现读的（app.ts 的 requestIp / allowedOrigin /
  // 登录限流 / createSession / activePasswordHash），改完下一次请求就按新值走。只有 host / port
  // 例外：它们在 `serve()` 时就绑定了，必须重启。
  'webui.sessionTtlHours', 'webui.passwordHash', 'webui.trustProxy', 'webui.trustedProxyHops', 'webui.allowOrigins', 'webui.loginRateLimit',
  // bot.ts 的 config Proxy 每次访问都取新快照，输出节奏是在每轮开始时读的：改了下一轮生效，
  // 在途那一轮沿用开轮时的值（编辑节流的定时器已经在跑，中途换节拍只会让这条消息的刷新变乱）。
  'output',
] as const;

export const KNOWN_UNIMPLEMENTED_CONFIG_KEYS = [
  // 运行时从来没有读过它：doc 11 说「仅用于日志与 WebUI 标题」，但两处都没接线（docs/20 · W-CFG-02）。
  'general.name',
  'general.locale',
  'telegram.dropPendingOnStart',
  'telegram.webhook.url',
  'telegram.webhook.path',
  'telegram.webhook.secretToken',
  'telegram.notifyEdits',
  'trigger.cooldownMsPerUser',
  // 编辑消息永远不开新轮次（docs/20 · W-TG-05）。开关留着是为了未来兼容，但当前一律按背景消息归档。
  'trigger.ignoreEditedAsTrigger',
  'context.background.showTime',
  'context.background.includeNonText',
  'context.rebase.markMeta',
  'context.cacheCommits',
  'concurrency.coalesceSameUserMs',
  'cancel.commitPartial',
  'prompt.includeToolCatalog',
  'prompt.runtimeBlock.showQuota',
  'prompt.runtimeBlock.showContextWatermark',
  'prompt.runtimeBlock.showWorkspace',
  'memory.pubWriteRequiresApproval',
  'memory.autoApplyCompaction',
  'memory.requireSourceTag',
  'agent.maxConcurrentSubagents',
  'agent.askArbiter',
  'agent.askEscalateToUser',
  'agent.progressThrottleMs',
  'provider.healthDownCooldownMinutes',
  'provider.requestTimeoutMs',
  'provider.streamIdleTimeoutMs',
  'tools.fs.allowHostFsForOwner',
  'tools.archive.defaultSearchLimit',
  'tools.archive.maxSearchLimit',
  'tools.archive.defaultReadLimit',
  'tools.archive.maxReadLimit',
  'tools.web.summarizeWithAlias',
  'tools.web.allowlist',
  'tools.web.denylist',
  'approval.allowInitiator',
  'output.flushOnSentence',
  'output.parseMode',
  'output.typingWhileWorking',
  'output.placeholderAfterMs',
  'output.maxMentions',
  'media.maxImagesPerTurn',
  'media.groupDebounceMs',
  'media.stickerAsImage',
  'media.downloadVoice',
  'media.extract.codeExtensions',
  'skills.enabled',
  'plugins.enabled',
  'plugins.watch',
  'mcp.connectTimeoutMs',
  'db.ftsTokenizer',
  'logs.gzipAfterDays',
  'logs.redactPatterns',
  'quota.perTurn.maxToolCalls',
  'quota.perTurn.maxSubagents',
  'quota.perTurn.maxDurationMs',
  'quota.onExceeded.notifyOwner',
  'quota.warnAtRatio',
  'webui.enabled',
  'webui.basePath',
  'webui.publicUrl',
  'alerts.notifyOwner',
  'alerts.dedupeMinutes',
  'alerts.webhookUrl',
  'alerts.on',
] as const;



export const configSchema = z.object({
  general: z.object({
    name: z.string().default('洛璃'),
    timezone: ianaTimezone.default('Asia/Shanghai'),
    locale: z.string().default('zh-CN'),
    maintenanceCron: z.string().default('0 4 * * *'),
    shutdown: z.object({ graceMs: z.number().int().positive().default(30_000) }).default({}),
  }).default({}),
  telegram: z.object({
    mode: z.enum(['polling', 'webhook']).default('polling'),
    dropPendingOnStart: z.boolean().default(false),
    allowedUpdates: z.array(z.string()).default(['message', 'edited_message', 'callback_query', 'my_chat_member', 'message_reaction']),
    webhook: z.object({ url: z.string().default(''), path: z.string().default('/webhook/telegram'), secretToken: z.string().default('') }).default({}),
    allowBots: z.array(z.string()).default([]),
    notifyEdits: z.boolean().default(true),
    strictCommandSuffix: z.boolean().default(false),
    throttle: z.object({ globalPerSecond: z.number().positive().default(30), perChatPerMinute: z.number().positive().default(20) }).default({}),
  }).default({}),
  access: z.object({
    defaultUserRole: role.default('blocked'),
    defaultChatRole: role.default('blocked'),
    archiveBlocked: z.boolean().default(false),
    bootstrapOwnerId: z.string().default(''),
  }).default({}),
  trigger: z.object({
    private: z.boolean().default(true), mention: z.boolean().default(true), reply: z.boolean().default(true), command: z.boolean().default(true),
    channels: z.boolean().default(false), wakewords: z.array(z.string()).default(['洛璃']), wakewordMinLength: z.number().int().min(1).default(2),
    requireTextAfterMention: z.boolean().default(false), ignoreEditedAsTrigger: z.boolean().default(true), cooldownMsPerUser: z.number().int().nonnegative().default(0),
  }).default({}),
  context: z.object({
    scope: z.enum(['chat', 'thread']).default('chat'),
    limit: z.object({ tokens: z.number().int().min(4000).max(500_000).default(32_000), maxMessages: z.number().int().positive().default(200), minKeepTurns: z.number().int().positive().default(1) }).default({}),
    hardCapRatio: z.number().gt(0.3).max(0.95).default(0.85),
    background: z.object({ enabled: z.boolean().default(true), maxPerTurn: z.number().int().nonnegative().default(20), showUsername: z.boolean().default(true), showTime: z.boolean().default(true), includeNonText: z.boolean().default(true) }).default({}),
    rebase: z.object({ injectNotice: z.boolean().default(false), markMeta: z.boolean().default(true) }).default({}),
    cacheCommits: z.number().int().positive().default(64), tokenRatioAlpha: z.number().gt(0).lte(1).default(0.2),
  }).default({}),
  concurrency: z.object({ mode: z.enum(['parallel', 'serial']).default('parallel'), perKey: z.number().int().positive().default(3), global: z.number().int().positive().default(8), queueMax: z.number().int().nonnegative().default(20), coalesceSameUserMs: z.number().int().nonnegative().default(0), turnTimeoutMs: z.number().int().positive().default(600_000) }).default({}),
  cancel: z.object({ commitPartial: z.boolean().default(false) }).default({}),
  prompt: z.object({ maxTokens: z.number().int().positive().default(12_000), includeToolCatalog: z.boolean().default(true), runtimeBlock: z.object({ showQuota: z.boolean().default(true), showContextWatermark: z.boolean().default(true), showWorkspace: z.boolean().default(true) }).default({}) }).default({}),
  memory: z.object({ dir: z.string().default('./memory'), pubWriteMinRole: role.default('trusted'), pubWriteRequiresApproval: z.boolean().default(false), softLimitTokens: z.number().int().positive().default(1500), hardLimitTokens: z.number().int().positive().default(3000), maxSections: z.number().int().positive().default(12), compactCron: z.string().default('0 3 * * 0'), autoApplyCompaction: z.boolean().default(false), requireSourceTag: z.boolean().default(true), forgetMeRetentionDays: z.number().int().nonnegative().default(30) }).default({}),
  agent: z.object({
    main: z.object({ modelAlias: z.string().default('main'), maxSteps: z.number().int().positive().default(12), downgradeAfterStep: z.number().int().positive().default(8) }).default({}),
    maxDepth: z.number().int().positive().default(3), maxConcurrentSubagents: z.number().int().positive().default(3), maxSubagentsPerTurn: z.number().int().positive().default(10), askTimeoutMs: z.number().int().positive().default(120_000), maxAsksPerRun: z.number().int().positive().default(5), askArbiter: z.boolean().default(true), askEscalateToUser: z.boolean().default(false), progressThrottleMs: z.number().int().positive().default(3000),
    agents: z.array(z.object({ name: z.string(), description: z.string(), modelAlias: z.string(), maxSteps: z.number().int().positive(), minRole: role.default('limited'), tools: z.array(z.string()).default([]), resultMaxChars: z.number().int().positive().default(4000), instructions: z.string(), injectMemory: z.boolean().default(false) })).default([]),
  }).default({}),
  provider: z.object({ maxRetries: z.number().int().nonnegative().default(2), retryBaseMs: z.number().int().positive().default(1000), retryMaxMs: z.number().int().positive().default(30_000), healthCheckCron: z.string().default('*/10 * * * *'), healthDownCooldownMinutes: z.number().positive().default(30), requestTimeoutMs: z.number().int().positive().default(120_000), streamIdleTimeoutMs: z.number().int().positive().default(60_000), allowPrivateBaseUrl: z.boolean().default(false),
    // 模型元数据目录（models.dev）。只在 WebUI 主动拉取时出网，缓存到 cacheFile 后按 ttlHours 用
    // ETag 条件请求续期；关掉之后拉取模型只剩上游 /models 给的那点信息（docs/04 §5.4.1）。
    catalog: z.object({ enabled: z.boolean().default(true), url: z.string().url().default('https://models.dev/api.json'), cacheFile: z.string().default('./data/cache/models.dev.json'), ttlHours: z.number().positive().default(168), timeoutMs: z.number().int().positive().default(30_000) }).default({}),
  }).default({}),
  tools: z.object({
    maxRegistered: z.number().int().positive().default(80), maxCallsPerTurn: z.number().int().positive().default(40), maxConsecutiveErrors: z.number().int().positive().default(3), defaultTimeoutMs: z.number().int().positive().default(60_000),
    overrides: z.record(z.object({ enabled: z.boolean().default(true) })).default({}),
    fs: z.object({ maxReadBytes: z.number().int().positive().default(262_144), maxWriteBytes: z.number().int().positive().default(5_242_880), showHidden: z.boolean().default(false), allowHostFsForOwner: z.boolean().default(false), denyGlobs: z.array(z.string()).default(['**/.env*', '**/*.pem', '**/*.key', '**/id_rsa*', '**/.ssh/**', '**/.git/config', '<root>/config/**', '<root>/data/luoli.db*', '<root>/memory/**']), trashDir: z.string().default('.luoli-trash'), backupDir: z.string().default('.luoli-bak') }).default({}),
    exec: z.object({ defaultTimeoutMs: z.number().int().positive().default(60_000), maxTimeoutMs: z.number().int().positive().default(300_000), maxOutputBytes: z.number().int().positive().default(65_536) }).default({}),
    archive: z.object({ defaultSearchLimit: z.number().int().positive().default(20), maxSearchLimit: z.number().int().positive().default(100), defaultReadLimit: z.number().int().positive().default(50), maxReadLimit: z.number().int().positive().default(200) }).default({}),
    tg: z.object({ maxExtraMessagesPerTurn: z.number().int().nonnegative().default(3), maxFileSendMb: z.number().positive().default(50) }).default({}),
    web: z.object({ maxResponseBytes: z.number().int().positive().default(2_097_152), summarizeWithAlias: z.string().default('low'), allowlist: z.array(z.string()).default([]), denylist: z.array(z.string()).default(['*.local', '*.internal']), searchProvider: z.enum(['', 'brave', 'serper', 'tavily']).default(''), searchApiKey: z.string().default('') }).default({}),
  }).default({}),
  sandbox: z.object({ mode: z.enum(['none', 'jail', 'docker']).default('docker'), bypassRoles: z.array(role).default(['owner']), image: z.string().default('luoli-sandbox:latest'), network: z.enum(['none', 'bridge']).default('none'), memoryMb: z.number().positive().default(512), cpus: z.number().positive().default(1), pidsLimit: z.number().int().positive().default(128), readOnlyRoot: z.boolean().default(true), tmpfsMb: z.number().positive().default(64), workspaceDir: z.string().default('./data/workspace'), hostWorkspaceDir: z.string().default(''), dockerBin: z.string().default('docker') }).default({}),
  approval: z.object({ enabled: z.boolean().default(true), ttlMs: z.number().int().positive().default(180_000), skipForOwner: z.boolean().default(true), allowInitiator: z.boolean().default(false), rememberWithinTurn: z.boolean().default(true), rules: z.array(approvalRuleSchema).default([]) }).default({}),
  output: z.object({ mode: z.enum(['stream', 'once']).default('stream'), replyDelayMs: z.number().int().nonnegative().max(30_000).default(2000), streamBufferMs: z.number().int().nonnegative().max(30_000).default(2000), streamIntervalMs: z.number().int().positive().default(2000), streamMinDeltaChars: z.number().int().positive().default(24), flushOnSentence: z.boolean().default(true), maxMessageChars: z.number().int().min(100).max(4000).default(3900), parseMode: z.enum(['MarkdownV2', 'HTML', 'none']).default('MarkdownV2'), typingWhileWorking: z.boolean().default(true), placeholderAfterMs: z.number().int().positive().default(4000), maxMentions: z.number().int().nonnegative().default(3) }).default({}),
  media: z.object({ dir: z.string().default('./data/files'), maxImageBytes: z.number().int().positive().default(8_388_608), maxDocBytes: z.number().int().positive().default(20_971_520), maxImageEdge: z.number().int().positive().default(1568), maxImagesPerTurn: z.number().int().positive().default(4), groupDebounceMs: z.number().int().positive().default(1500), stickerAsImage: z.boolean().default(false), downloadVoice: z.boolean().default(true), extract: z.object({ enabled: z.boolean().default(true), maxChars: z.number().int().positive().default(40_000), inlineChars: z.number().int().positive().default(4000), codeExtensions: z.array(z.string()).default([]) }).default({}) }).default({}),
  skills: z.object({ enabled: z.boolean().default(true), dir: z.string().default('./skills'), watch: z.boolean().default(true), defaultMinRole: role.default('trusted') }).default({}),
  plugins: z.object({ enabled: z.boolean().default(true), dir: z.string().default('./plugins'), watch: z.boolean().default(false), hookTimeoutMs: z.number().int().positive().default(5000), order: z.array(z.string()).default([]), autoDisableAfterErrors: z.number().int().positive().default(3) }).default({}),
  mcp: z.object({ enabled: z.boolean().default(false), connectTimeoutMs: z.number().int().positive().default(15_000), healthCheckCron: z.string().default('*/5 * * * *'), defaultMinRole: role.default('trusted'), servers: z.array(mcpServerSchema).default([]) }).default({}),
  db: z.object({ path: z.string().default('./data/luoli.db'), backupKeep: z.number().int().nonnegative().default(5), vacuumCron: z.string().default('0 5 * * 0'), ftsTokenizer: z.enum(['trigram', 'unicode61']).default('trigram') }).default({}),
  logs: z.object({ level: z.enum(['debug', 'info', 'warn', 'error']).default('info'), dir: z.string().default('./logs'), captureBodies: z.boolean().default(true), bodyMaxBytes: z.number().int().positive().default(262_144), maxFileMb: z.number().positive().default(128), retentionDays: z.number().int().nonnegative().default(30), gzipAfterDays: z.number().int().nonnegative().default(3), console: z.enum(['pretty', 'json', 'off']).default('pretty'), redactPatterns: z.array(z.string()).default([]) }).default({}),
  quota: z.object({ enabled: z.boolean().default(true), requirePricing: z.boolean().default(true), minReserveUsd: z.number().nonnegative().default(0.02), global: z.object({ daily: nullableMoney.default(5), monthly: nullableMoney.default(100) }).default({}), perChat: z.object({ daily: nullableMoney.default(1), monthly: nullableMoney.default(null) }).default({}), perUser: z.object({ daily: nullableMoney.default(0.5), monthly: nullableMoney.default(null), byRole: z.record(z.object({ daily: nullableMoney.optional(), monthly: nullableMoney.optional() })).default({}) }).default({}), perTurn: z.object({ maxCostUsd: z.number().positive().default(0.5), maxSteps: z.number().int().positive().default(12), maxToolCalls: z.number().int().positive().default(40), maxSubagents: z.number().int().positive().default(10), maxDurationMs: z.number().int().positive().default(600_000) }).default({}), rateLimit: z.object({ turnsPerUserPerHour: z.number().int().positive().default(30), turnsPerChatPerHour: z.number().int().positive().default(100), concurrentPerUser: z.number().int().positive().default(2) }).default({}), onExceeded: z.object({ reply: z.boolean().default(true), message: z.string().default('今天的额度用完了（已用 {spent}/{limit}），{resetAt} 重置。'), notifyOwner: z.boolean().default(true) }).default({}), warnAtRatio: z.number().gt(0).lte(1).default(0.8) }).default({}),
  webui: z.object({ enabled: z.boolean().default(true), host: z.string().default('127.0.0.1'), port: z.number().int().positive().default(8787), basePath: z.string().default('/'), publicUrl: z.string().default(''), sessionTtlHours: z.number().positive().default(168), passwordHash: z.string().default(''), trustProxy: z.boolean().default(false), trustedProxyHops: z.number().int().min(1).max(16).default(1), allowOrigins: z.array(z.string()).default([]), loginRateLimit: z.object({ attempts: z.number().int().positive().default(5), windowMinutes: z.number().int().positive().default(15) }).default({}) }).default({}),
  alerts: z.object({ notifyOwner: z.boolean().default(true), dedupeMinutes: z.number().positive().default(30), webhookUrl: z.string().default(''), on: z.array(z.string()).default([]) }).default({}),
  perChat: z.record(z.unknown()).default({}),
}).superRefine((cfg, ctx) => {
  if (cfg.concurrency.perKey > cfg.concurrency.global) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['concurrency', 'perKey'], message: 'perKey must be <= global' });
  if (cfg.memory.softLimitTokens >= cfg.memory.hardLimitTokens) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['memory', 'softLimitTokens'], message: 'softLimitTokens must be < hardLimitTokens' });
  if (cfg.webui.host !== '127.0.0.1' && cfg.webui.host !== '::1' && !cfg.webui.passwordHash) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['webui', 'passwordHash'], message: 'password is required when binding beyond loopback' });
  const allowed = [/^output\./, /^context\.(limit|background)\./, /^context\.scope$/, /^trigger\./, /^agent\.main\./, /^character$/, /^memory\.pubWriteMinRole$/];
  for (const [key, value] of Object.entries(cfg.perChat)) {
    const walk = (node: unknown, prefix = ''): void => {
      if (!node || typeof node !== 'object' || Array.isArray(node)) {
        if (!allowed.some((pattern) => pattern.test(prefix))) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['perChat', key, ...prefix.split('.')], message: 'path is not in perChat override allowlist' });
        return;
      }
      for (const [part, child] of Object.entries(node)) walk(child, prefix ? `${prefix}.${part}` : part);
    };
    walk(value);
    const memoryRole = (value as { memory?: { pubWriteMinRole?: unknown } }).memory?.pubWriteMinRole;
    if (typeof memoryRole === 'string' && ['blocked', 'limited', 'trusted', 'owner'].includes(memoryRole)
      && roleRank(memoryRole as 'blocked' | 'limited' | 'trusted' | 'owner') < roleRank(cfg.memory.pubWriteMinRole)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['perChat', key, 'memory', 'pubWriteMinRole'], message: '会话级公开记忆写入角色只能比全局更严格' });
    }
  }
});

export type Config = z.infer<typeof configSchema>;
