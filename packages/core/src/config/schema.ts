import { z } from 'zod';

const role = z.enum(['owner', 'trusted', 'limited', 'blocked']);
const nullableMoney = z.number().nonnegative().nullable();
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
  'provider.maxRetries', 'provider.retryBaseMs', 'provider.retryMaxMs',
  'tools.maxRegistered', 'tools.maxCallsPerTurn', 'tools.maxConsecutiveErrors', 'tools.overrides', 'tools.exec',
  'approval.enabled', 'approval.rules', 'approval.skipForOwner', 'approval.rememberWithinTurn',
  'sandbox', 'mcp', 'quota', 'logs.level',
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
  'context.background.showUsername',
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
  'tools.tg.maxExtraMessagesPerTurn',
  'tools.tg.maxFileSendMb',
  'tools.web.summarizeWithAlias',
  'tools.web.allowlist',
  'tools.web.denylist',
  'approval.allowInitiator',
  // 审批没有可用的交互通道（Telegram 那半从未实现），命中规则的调用当场被拒，
  // 因此没有等待窗口、也没有 TTL 可言（docs/20 · W-APPR-01）。
  'approval.ttlMs',
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
  'mcp.enabled',
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
  provider: z.object({ maxRetries: z.number().int().nonnegative().default(2), retryBaseMs: z.number().int().positive().default(1000), retryMaxMs: z.number().int().positive().default(30_000), healthCheckCron: z.string().default('*/10 * * * *'), healthDownCooldownMinutes: z.number().positive().default(30), requestTimeoutMs: z.number().int().positive().default(120_000), streamIdleTimeoutMs: z.number().int().positive().default(60_000) }).default({}),
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
  approval: z.object({ enabled: z.boolean().default(true), ttlMs: z.number().int().positive().default(180_000), skipForOwner: z.boolean().default(true), allowInitiator: z.boolean().default(false), rememberWithinTurn: z.boolean().default(true), rules: z.array(z.record(z.unknown())).default([]) }).default({}),
  output: z.object({ mode: z.enum(['stream', 'once']).default('stream'), replyDelayMs: z.number().int().nonnegative().max(30_000).default(2000), streamIntervalMs: z.number().int().positive().default(2000), streamMinDeltaChars: z.number().int().positive().default(24), flushOnSentence: z.boolean().default(true), maxMessageChars: z.number().int().min(100).max(4000).default(3900), parseMode: z.enum(['MarkdownV2', 'HTML', 'none']).default('MarkdownV2'), typingWhileWorking: z.boolean().default(true), placeholderAfterMs: z.number().int().positive().default(4000), maxMentions: z.number().int().nonnegative().default(3) }).default({}),
  media: z.object({ dir: z.string().default('./data/files'), maxImageBytes: z.number().int().positive().default(8_388_608), maxDocBytes: z.number().int().positive().default(20_971_520), maxImageEdge: z.number().int().positive().default(1568), maxImagesPerTurn: z.number().int().positive().default(4), groupDebounceMs: z.number().int().positive().default(1500), stickerAsImage: z.boolean().default(false), downloadVoice: z.boolean().default(true), extract: z.object({ enabled: z.boolean().default(true), maxChars: z.number().int().positive().default(40_000), inlineChars: z.number().int().positive().default(4000), codeExtensions: z.array(z.string()).default([]) }).default({}) }).default({}),
  skills: z.object({ enabled: z.boolean().default(true), dir: z.string().default('./skills'), watch: z.boolean().default(true), defaultMinRole: role.default('trusted') }).default({}),
  plugins: z.object({ enabled: z.boolean().default(true), dir: z.string().default('./plugins'), watch: z.boolean().default(false), hookTimeoutMs: z.number().int().positive().default(5000), order: z.array(z.string()).default([]), autoDisableAfterErrors: z.number().int().positive().default(3) }).default({}),
  mcp: z.object({ enabled: z.boolean().default(false), connectTimeoutMs: z.number().int().positive().default(15_000), healthCheckCron: z.string().default('*/5 * * * *'), defaultMinRole: role.default('trusted'), servers: z.array(z.record(z.unknown())).default([]) }).default({}),
  db: z.object({ path: z.string().default('./data/luoli.db'), backupKeep: z.number().int().nonnegative().default(5), vacuumCron: z.string().default('0 5 * * 0'), ftsTokenizer: z.enum(['trigram', 'unicode61']).default('trigram') }).default({}),
  logs: z.object({ level: z.enum(['debug', 'info', 'warn', 'error']).default('info'), dir: z.string().default('./logs'), captureBodies: z.boolean().default(true), bodyMaxBytes: z.number().int().positive().default(262_144), maxFileMb: z.number().positive().default(128), retentionDays: z.number().int().nonnegative().default(30), gzipAfterDays: z.number().int().nonnegative().default(3), console: z.enum(['pretty', 'json', 'off']).default('pretty'), redactPatterns: z.array(z.string()).default([]) }).default({}),
  quota: z.object({ enabled: z.boolean().default(true), requirePricing: z.boolean().default(true), minReserveUsd: z.number().nonnegative().default(0.02), global: z.object({ daily: nullableMoney.default(5), monthly: nullableMoney.default(100) }).default({}), perChat: z.object({ daily: nullableMoney.default(1), monthly: nullableMoney.default(null) }).default({}), perUser: z.object({ daily: nullableMoney.default(0.5), monthly: nullableMoney.default(null), byRole: z.record(z.object({ daily: nullableMoney.optional(), monthly: nullableMoney.optional() })).default({}) }).default({}), perTurn: z.object({ maxCostUsd: z.number().positive().default(0.5), maxSteps: z.number().int().positive().default(12), maxToolCalls: z.number().int().positive().default(40), maxSubagents: z.number().int().positive().default(10), maxDurationMs: z.number().int().positive().default(600_000) }).default({}), rateLimit: z.object({ turnsPerUserPerHour: z.number().int().positive().default(30), turnsPerChatPerHour: z.number().int().positive().default(100), concurrentPerUser: z.number().int().positive().default(2) }).default({}), onExceeded: z.object({ reply: z.boolean().default(true), message: z.string().default('今天的额度用完了（已用 {spent}/{limit}），{resetAt} 重置。'), notifyOwner: z.boolean().default(true) }).default({}), warnAtRatio: z.number().gt(0).lte(1).default(0.8) }).default({}),
  webui: z.object({ enabled: z.boolean().default(true), host: z.string().default('127.0.0.1'), port: z.number().int().positive().default(8787), basePath: z.string().default('/'), publicUrl: z.string().default(''), sessionTtlHours: z.number().positive().default(168), passwordHash: z.string().default(''), trustProxy: z.boolean().default(false), allowOrigins: z.array(z.string()).default([]), loginRateLimit: z.object({ attempts: z.number().int().positive().default(5), windowMinutes: z.number().int().positive().default(15) }).default({}) }).default({}),
  alerts: z.object({ notifyOwner: z.boolean().default(true), dedupeMinutes: z.number().positive().default(30), webhookUrl: z.string().default(''), on: z.array(z.string()).default([]) }).default({}),
  perChat: z.record(z.unknown()).default({}),
}).superRefine((cfg, ctx) => {
  if (cfg.concurrency.perKey > cfg.concurrency.global) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['concurrency', 'perKey'], message: 'perKey must be <= global' });
  if (cfg.memory.softLimitTokens >= cfg.memory.hardLimitTokens) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['memory', 'softLimitTokens'], message: 'softLimitTokens must be < hardLimitTokens' });
  if (cfg.webui.host !== '127.0.0.1' && cfg.webui.passwordHash.length === 0) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['webui', 'passwordHash'], message: 'password is required when binding beyond loopback' });
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
  }
});

export type Config = z.infer<typeof configSchema>;
