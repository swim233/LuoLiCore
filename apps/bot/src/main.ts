import type { Bot } from 'grammy';
import argon2 from 'argon2';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { ArchiveRepository, OperationsRepository, PrincipalRepository, TurnRepository, closeDatabase, migrateDatabase, modelAliasKey, openDatabase, readAppKv, readPersistedConfig, recomputeMessageTokens, recoverAfterCrash, writeAppKv } from '@luoli/db';
import { AgentManager, AgentResultStore, AlertDispatcher, ConfigStore, ContextEngine, DatabaseApprovalBroker, EventBus, FileTools, LogSink, MaintenanceService, McpManager, MemoryStore, ModelCatalog, ModelRegistry, PathJail, PluginManager, PromptAssembler, PromptDocuments, ProviderStore, QuotaGuard, Sandbox, Scheduler, Secrets, SkillLoader, STABLE_PROMPT_BLOCKS, TOOL_POLICY, ToolRegistry, TurnConcurrency, TurnRegistry, UsageLedger, assembleMainPrompt, configJsonSchema, loadConfig, perChatConfig, registerBuiltins, rejectedWakewords, runSubAgent, streamMainAgent, type SubAgentRuntimeEvent } from '@luoli/core';
import { createServer, EventStreamRegistry, issueLoginToken, setupToken, type PromptPreviewResult } from '@luoli/server';
import type { RuntimeTurnContext } from '@luoli/shared';
import { TelegramTools, UpdatePoller, createTelegramBot } from '@luoli/telegram';

const startedAt = Date.now();
const TOKEN_REPAIR_KEY = 'repair:context-tokens:v1';
const startupDatabasePath = process.env.LUOLI_DATA_DIR ? resolve(process.env.LUOLI_DATA_DIR, 'luoli.db') : './data/luoli.db';
// env 叠加抽成一个函数，启动与热重载共用：只在启动时叠的话，host 存在 DB 而口令只来自 env 的部署，
// 热重载会撞上 webui.passwordHash 的 superRefine 而整体失败（removeOverridePath 也删不掉它，
// 因为它根本不在 overrides 里），表现是配置改一次就再也不生效（docs/20 · W-CFG-03）。
const passwordHashFromEnvironment = process.env.WEBUI_PASSWORD
  ? await argon2.hash(process.env.WEBUI_PASSWORD, { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 })
  : null;
const reportRejectedKey = (key: string): void => void process.stderr.write(`[config] 拒绝了 config_kv 里的非法键：${key}（清理：DELETE FROM config_kv WHERE key='${key.replaceAll("'", "''")}';）\n`);
const envOverlay = (overrides: Record<string, unknown>): Record<string, unknown> => {
  if (!process.env.LUOLI_WEBUI_HOST && !passwordHashFromEnvironment) return overrides;
  const webui = overrides.webui && typeof overrides.webui === 'object' && !Array.isArray(overrides.webui)
    ? overrides.webui as Record<string, unknown> : {};
  if (process.env.LUOLI_WEBUI_HOST) webui.host = process.env.LUOLI_WEBUI_HOST;
  if (passwordHashFromEnvironment) webui.passwordHash = passwordHashFromEnvironment;
  overrides.webui = webui;
  return overrides;
};
const startupOverrides = envOverlay(readPersistedConfig(startupDatabasePath, reportRejectedKey));
const droppedOverrides: string[] = [];
const reportInvalidOverride = (dropped: string[], messages: string[]): void => {
  droppedOverrides.push(...dropped);
  process.stderr.write(`[config] 已忽略 ${dropped.length} 条非法的持久化覆盖：\n  ${messages.join('\n  ')}\n`
    + `[config] 清理命令：DELETE FROM config_kv WHERE key IN (${dropped.map((key) => `'${key.replaceAll("'", "''")}'`).join(', ')});\n`);
};
const config = await loadConfig({ overrides: startupOverrides, onInvalidOverride: reportInvalidOverride });
const configStore = new ConfigStore(config);
for (const path of [resolve('data'), resolve('logs'), resolve('skills'), resolve('plugins'), resolve(config.memory.dir), resolve(config.sandbox.workspaceDir)]) mkdirSync(path, { recursive: true, mode: 0o700 });
const db = openDatabase(config.db.path);
migrateDatabase(db);
recoverAfterCrash(db);
// 一次性数据修复而不是迁移：迁移文件提交后不可修改，而这件事要用 TS 侧的估算器重算 parts。
// 修的是 token 校准失控期间落库的 tokens（实测系数最高约 26 倍，logs/2026-08-16）。
if (!readAppKv<boolean>(db, TOKEN_REPAIR_KEY)) {
  const repaired = recomputeMessageTokens(db);
  writeAppKv(db, TOKEN_REPAIR_KEY, true, 'startup');
  if (repaired.messages || repaired.contexts) process.stdout.write(`[context] 已按新估算器重算 ${repaired.messages} 条上下文消息的 tokens，并重置 ${repaired.contexts} 个会话的校准系数。\n`);
}
const principals = new PrincipalRepository(db);
principals.ensureOwner(config.access.bootstrapOwnerId);
const archive = new ArchiveRepository(db);
const operations = new OperationsRepository(db);
const turns = new TurnRepository(db);
// EventBus 要早于 quota / log 建：这两个是 SSE 上 `quota` 与 `log` 事件的发源地，
// 少给一个的表现就是那一类事件永远不到（docs/21 · G-SSE-01）。
const events = new EventBus();
const quota = new QuotaGuard(db, config.general.timezone, events);
const secrets = new Secrets(process.env.LUOLI_MASTER_KEY);
// scrypt 抬高了离线爆破成本，但抬不动一个短口令（docs/20 · W-SEC-02）。
if (secrets.weak) process.stderr.write('[secrets] LUOLI_MASTER_KEY 短于 32 字符：provider key 的加密强度取决于它，建议换成 32 字节随机值。\n');
const providers = new ProviderStore(db, secrets);
// 只在 WebUI 主动拉取模型时才可能出网；缓存命中的路径不碰网络（docs/04 §5.4.1）。
const modelCatalog = new ModelCatalog(db, () => ({ ...configStore.snapshot().provider.catalog, allowPrivate: configStore.snapshot().provider.allowPrivateBaseUrl }));
const ledger = new UsageLedger(db);
const turnRegistry = new TurnRegistry();
const turnConcurrency = new TurnConcurrency(config.concurrency);
const log = new LogSink(operations, config.logs.dir, [process.env.BOT_TOKEN ?? '', process.env.LUOLI_MASTER_KEY ?? ''], { level: config.logs.level, maxFileMb: config.logs.maxFileMb, bodyMaxBytes: config.logs.bodyMaxBytes, console: config.logs.console, events });
log.redactPatterns = config.logs.redactPatterns;
// 告警要早于沙箱、plugin、模型注册表建起来：那三处的构造参数里就挂着告警回调。
// owner 私聊在 bot 建好之后再补（`alerts.bindOwner`），此前只走 webhook 与日志。
let notifyOwner: ((text: string) => Promise<unknown>) | null = null;
const alerts = new AlertDispatcher(() => configStore.snapshot().alerts, log,
  { owner: async (text: string) => { await notifyOwner?.(text); } }, () => configStore.snapshot().provider.allowPrivateBaseUrl);
// 日志自己写不进去时也要有人知道 —— 只写 stderr 的话运维通常永远看不到（docs/10 §6 db_write_failed）。
log.onWriteFailure = (error) => alerts.fire('db_write_failed', '日志写入失败', { error: error instanceof Error ? error.message : String(error) });
const context = new ContextEngine(db, archive, log);
const modelRegistry = new ModelRegistry(db, providers);
modelRegistry.rebuild(config.provider.healthDownCooldownMinutes);
log.setSecrets([process.env.BOT_TOKEN ?? '', process.env.LUOLI_MASTER_KEY ?? '', config.tools.web.searchApiKey, ...providers.allDecryptedKeys()]);
// 零配置首启本来就没有 main 别名，拒绝启动会把补配置用的 WebUI 一起带走（docs/04 §5.2）。
// 缺 main 只告警：轮次会在 streamMainAgent 里失败，WebUI 写入别名后 rebuildModels() 即时生效。
if (!modelRegistry.aliases().includes('main')) {
  log.event({ level: 'error', kind: 'config.invalid', summary: 'Required model alias main is unavailable' });
  process.stderr.write('[config] 缺少必需的 main 模型别名：服务照常启动，但所有轮次都会以 model alias unavailable 失败。\n'
    + `[config] 去 WebUI（http://${config.webui.host}:${config.webui.port} → Provider 页）配置 provider / 模型 / main 别名，保存后即时生效，无需重启。\n`);
}
const memory = new MemoryStore(db, config.memory.dir, config.memory.softLimitTokens, config.memory.hardLimitTokens, config.memory.maxSections, config.memory.forgetMeRetentionDays, log);
const skills = new SkillLoader(db, config.skills.dir, () => configStore.snapshot().skills.defaultMinRole);
// `skills.enabled=false` 时不扫盘也不监听：目录里的 SKILL.md 一个都不进工具目录。
// 关掉是整块关掉，而不是「扫出来但不给用」—— 后者会让工具目录里多出一批点不动的名字。
if (config.skills.enabled) skills.scan();
else log.event({ level: 'info', kind: 'skills.disabled', summary: 'Skills disabled by config' });
// 一份常量供两处用：写入方（AgentResultStore）与清理方（MaintenanceService.gcFiles）指向
// 不同目录时，gc 会把整棵结果目录当成孤儿删空。
// 跟着 `LUOLI_DATA_DIR` 走，和 `db.path` / `media.dir` 同一处（config/index.ts 的 envLayer）。
// 三者指向不同部署时 `gcFiles()` 会把别人的数据当孤儿删掉（docs/25 §10）。
const agentResultsDir = process.env.LUOLI_DATA_DIR ? resolve(process.env.LUOLI_DATA_DIR, 'agent-results') : resolve('data/agent-results');
const agents = new AgentManager(db, new AgentResultStore(agentResultsDir), config.agent.agents, config.agent.maxDepth, config.agent.maxSubagentsPerTurn);
if (config.skills.enabled && config.skills.watch) skills.startWatching();
const plugins = new PluginManager(db, config.plugins.dir, config.plugins.hookTimeoutMs, config.plugins.autoDisableAfterErrors, config.plugins.order, undefined,
  (name, error) => alerts.fire('plugin_auto_disabled', `plugin ${name} 连续出错已被自动禁用`, { plugin: name, error }, name));
// `plugins.enabled=false` 时不 reconcile：一个 plugin 都不加载，钩子链是空的。
// 「进程内全信任」（docs/14 A27）意味着这个开关是安全边界，不是性能开关。
if (config.plugins.enabled) {
  await plugins.reconcile();
  // `plugins.watch`：目录变动后重新 reconcile。默认关 —— 热加载一个全信任的 JS 文件，
  // 风险面比省一次重启大得多，开它要自己清楚这一点。
  if (config.plugins.watch) plugins.startWatching();
} else log.event({ level: 'info', kind: 'plugins.disabled', summary: 'Plugins disabled by config' });
const mcp = new McpManager(db, () => configStore.snapshot().mcp, log);
await mcp.reconcile();
const maintenance = new MaintenanceService(db, config.db.path, config.db.backupKeep, config.logs.retentionDays, config.logs.dir,
  { files: config.media.dir, agentResults: agentResultsDir }, config.logs.gzipAfterDays);
const scheduler = new Scheduler((name, error) => log.event({ level: 'error', kind: 'scheduler.failed', summary: `${name} failed`, data: { error: error instanceof Error ? error.message : String(error) } }));
scheduler.add(config.general.maintenanceCron, () => { const result = maintenance.cleanup(); log.event({ level: 'info', kind: 'maintenance.cleanup', summary: 'Scheduled cleanup complete', data: result }); }, 'maintenance');
scheduler.add(config.db.vacuumCron, () => { maintenance.vacuum(); log.event({ level: 'info', kind: 'maintenance.vacuum', summary: 'Scheduled VACUUM complete' }); }, 'vacuum');
scheduler.add(config.memory.compactCron, () => { log.event({ level: 'info', kind: 'memory.compact', summary: 'Memory compaction review scheduled', data: { pending: memory.list().filter((entry) => entry.tokens > config.memory.softLimitTokens).length } }); }, 'memory-compact');
scheduler.add(config.provider.healthCheckCron, () => { modelRegistry.rebuild(configStore.snapshot().provider.healthDownCooldownMinutes); log.event({ level: 'info', kind: 'provider.health', summary: 'Provider registry health refreshed', data: { aliases: modelRegistry.aliases() } }); }, 'provider-health');
scheduler.add(config.mcp.healthCheckCron, () => mcp.reconcile(), 'mcp-health');
const promptAssembler = new PromptAssembler();
const promptDocuments = new PromptDocuments(db, config.memory.dir);
promptDocuments.ensure();
// 审批回执发给**发起人所在的会话**（`docs/22 · D-APPR-01`）：有裁决通道时这一轮会静静挂满
// ttlMs，用户看到的是 bot 收了消息然后沉默三分钟。bot 要到最后才建得起来，所以这里吃 getter。
const approval = new DatabaseApprovalBroker(db, () => configStore.snapshot(), events, log, async (pending) => {
  if (!bot) return;
  const risk = pending.risk === 'high' ? '高风险' : pending.risk === 'medium' ? '中风险' : '低风险';
  await bot.api.sendMessage(pending.chatId,
    `⏳ \`${pending.tool}\` 是${risk}操作，需要 owner 在 WebUI 里批准。${Math.round(pending.ttlMs / 1000)} 秒内没人处理就会自动拒绝，我会接着往下说。`,
    { parse_mode: 'MarkdownV2', ...(pending.threadId ? { message_thread_id: pending.threadId } : {}) })
    .catch(() => bot!.api.sendMessage(pending.chatId, `⏳ ${pending.tool} 是${risk}操作，需要 owner 在 WebUI 里批准。${Math.round(pending.ttlMs / 1000)} 秒内没人处理就会自动拒绝。`,
      pending.threadId ? { message_thread_id: pending.threadId } : {}));
});
if (!config.approval.enabled) log.event({ level: 'warn', kind: 'approval.disabled', summary: 'Approval flow disabled; dangerous tools execute without review' });
// 唤醒词在匹配时被静默跳过、或四个开关全关，表现都只是「bot 不理我」——启动时先把它说出来（docs/11 §启动校验）。
const unusableWakewords = rejectedWakewords(config.trigger.wakewords, config.trigger.wakewordMinLength);
if (unusableWakewords.length) log.event({ level: 'warn', kind: 'config.invalid', summary: `${unusableWakewords.length} 条唤醒词不会生效`, data: { rejected: unusableWakewords } });
if (!config.trigger.private && !config.trigger.mention && !config.trigger.reply && !config.trigger.command && config.trigger.wakewords.length === unusableWakewords.length) {
  log.event({ level: 'warn', kind: 'config.invalid', summary: 'No trigger source is enabled; the bot will never respond' });
}
const toolRegistry = new ToolRegistry(log, approval,
  () => { const live = configStore.snapshot(); return { maxRegistered: live.tools.maxRegistered, maxCallsPerTurn: live.tools.maxCallsPerTurn, maxConsecutiveErrors: live.tools.maxConsecutiveErrors, maxOutputBytes: live.tools.exec.maxOutputBytes, defaultTimeoutMs: live.tools.defaultTimeoutMs }; },
  () => configStore.snapshot().approval.rules, plugins);
toolRegistry.bindOverrides(() => configStore.snapshot().tools.overrides);
// 吃 getter 而不是启动快照：sandbox.mode 是「出事时运维会去点的那个开关」，冻住它等于
// 界面说改成功了、bash 照跑（docs/20 · W-CFG-02）。
const sandbox = new Sandbox(() => {
  const live = configStore.snapshot();
  return { mode: live.sandbox.mode, bypassRoles: live.sandbox.bypassRoles, dockerBin: live.sandbox.dockerBin,
    image: live.sandbox.image, network: live.sandbox.network, memoryMb: live.sandbox.memoryMb, cpus: live.sandbox.cpus,
    pidsLimit: live.sandbox.pidsLimit, readOnlyRoot: live.sandbox.readOnlyRoot, tmpfsMb: live.sandbox.tmpfsMb,
    workspaceDir: live.sandbox.workspaceDir, hostWorkspaceDir: live.sandbox.hostWorkspaceDir,
    defaultTimeoutMs: live.tools.exec.defaultTimeoutMs, maxTimeoutMs: live.tools.exec.maxTimeoutMs, maxOutputBytes: live.tools.exec.maxOutputBytes };
}, undefined, undefined, (message) => log.event({ level: 'warn', kind: 'sandbox.weak_isolation', summary: message }),
  (reason, role) => alerts.fire('sandbox_unavailable', `沙箱不可用，${role} 的执行请求被拒`, { reason, role }, role));
const sandboxProbe = await sandbox.probe();
if (!sandboxProbe.available && config.sandbox.mode === 'docker') log.event({ level: 'error', kind: 'sandbox.unavailable', summary: sandboxProbe.error ?? 'Docker sandbox unavailable' });
// bot 要到最后才建得起来，而工具在这里就得注册完，所以桥拿的是 getter。**presence 即开关**：
// `available()` 判的就是 `telegram` 在不在，没有 BOT_TOKEN 时这一族工具必须整体不进目录，
// 而不是进了目录再在调用时失败。
let bot: Bot | null = null;
let poller: UpdatePoller | null = null;
const telegramTools = process.env.BOT_TOKEN
  ? new TelegramTools({ bot: () => bot, archive, maxMessageChars: () => configStore.snapshot().output.maxMessageChars })
  : null;
registerBuiltins(toolRegistry, {
  // `tools.fs.allowHostFsForOwner`：owner 的 fs 工具 jail 到 `/` 而不是本会话 workspace。
  // 这是 docs/14 T8 那条取舍的**显式**开关：开了之后任何能让 owner 的轮次执行工具的注入路径
  // 都是完整的机器读写权限。默认关，`denyGlobs` 照样生效（它是绝对路径 glob，不依赖 root）。
  // 判据用工具执行上下文里的有效角色 —— owner 在非受信群里已经被抿平成群角色（D9），
  // 所以「owner 在陌生群里被诱导读 /etc/shadow」走不到这条路。
  db, filesFor: (workspace, role) => new FileTools(
    new PathJail(role === 'owner' && configStore.snapshot().tools.fs.allowHostFsForOwner ? '/' : workspace, config.tools.fs.denyGlobs),
    config.tools.fs.maxReadBytes, config.tools.fs.maxWriteBytes, { showHidden: config.tools.fs.showHidden, trashDir: config.tools.fs.trashDir, backupDir: config.tools.fs.backupDir }),
  sandbox, archive, context, memory, skills, agents, models: modelRegistry, ledger, log, quota,
  maxWebBytes: config.tools.web.maxResponseBytes, maxAsksPerRun: config.agent.maxAsksPerRun, askTimeoutMs: config.agent.askTimeoutMs,
  web: { timeoutMs: config.tools.web.timeoutMs, retries: config.tools.web.retries },
  webSearch: { provider: config.tools.web.searchProvider, apiKey: config.tools.web.searchApiKey },
  telegram: telegramTools,
});
plugins.bindRegistry(toolRegistry);
mcp.bindRegistry(toolRegistry);
await plugins.reconcile();
await mcp.reconcile();
for (const name of Object.keys(TOOL_POLICY)) if (!toolRegistry.has(name)) throw new Error(`tool policy is not registered: ${name}`);
let setup: { token: string; expiresAt: number } | undefined;
if (!config.webui.passwordHash) {
  setup = setupToken();
  process.stdout.write(`LuoLiCore setup token: ${setup.token}\nOpen http://${config.webui.host}:${config.webui.port}/setup\n`);
}
const previewPrompt = (key: string, role: RuntimeTurnContext['effectiveRole']): PromptPreviewResult => {
  const contextRow = db.prepare('SELECT chat_id AS chatId,thread_id AS threadId FROM contexts WHERE key=?').get(key) as { chatId: string; threadId: number | null } | undefined;
  if (!contextRow) throw new Error('会话不存在');
  const latest = db.prepare('SELECT initiator_user_id AS userId FROM turns WHERE key=? ORDER BY COALESCE(started_at,queued_at) DESC,rowid DESC LIMIT 1').get(key) as { userId: string } | undefined;
  const principal = db.prepare("SELECT chat_type AS chatType FROM principals WHERE kind='chat' AND tg_id=?").get(contextRow.chatId) as { chatType: string | null } | undefined;
  const live = perChatConfig(configStore.snapshot(), key);
  const snapshot = context.materialize(key, null, live.context.cacheCommits);
  const turn = {
    turnId: 'webui:prompt-preview', key, chatId: contextRow.chatId, threadId: contextRow.threadId,
    initiatorUserId: latest?.userId ?? contextRow.chatId, effectiveRole: role,
    isPrivate: principal?.chatType ? principal.chatType === 'private' : !contextRow.chatId.startsWith('-'),
    baseCommitId: null, snapshot, delta: [], abortSignal: new AbortController().signal, config: live,
  } satisfies RuntimeTurnContext;
  // 预览也会在 `toolRegistry` 里落一条按 turnId 挂的状态。turnId 是个常量所以不会堆积，
  // 但留着等于让下一次预览沿用上一次的工具调用计数 —— 顺手清掉（docs/22 · I-10）。
  const built = ((): ReturnType<typeof assembleMainPrompt> => {
    try {
      return assembleMainPrompt(turn, { config: live, tools: toolRegistry, prompts: promptAssembler, documents: promptDocuments,
        workspace: resolve(live.sandbox.workspaceDir, contextRow.chatId), skills, agents });
    } finally { toolRegistry.releaseTurn(turn.turnId); }
  })();
  const order = ['kernel', 'character', 'assist', 'catalog', 'pubmemory', 'primemory', 'runtime'];
  const blocks = order.filter((name) => name !== 'primemory' || built.instructions.includes('=== PRIMEMORY ==='))
    .map((name) => ({ name, tokens: built.blocks[name] ?? 0, content: built.contents[name] ?? '', truncated: built.truncated.includes(name),
      cached: (STABLE_PROMPT_BLOCKS as readonly string[]).includes(name) }));
  return { key, role, instructions: built.instructions, blocks, totalTokens: blocks.reduce((sum, block) => sum + block.tokens, 0),
    context: { messages: snapshot.messages.length, tokens: snapshot.tokens } };
};

/** 试跑的 chat/user 计数落在这个合成 subject 上：它花的是真钱，但不该记到某个真实会话头上。 */
const DRY_RUN_SUBJECT = 'webui-dryrun';

async function dryRunAgent(name: string, task: string, signal: AbortSignal, emit: (event: SubAgentRuntimeEvent) => void | Promise<void>): Promise<{ summary: string; fullRef: string; truncated: boolean }> {
  const { run, definition } = agents.createDryRun(name, task, 'owner');
  const live = configStore.snapshot();
  const workspace = resolve(live.sandbox.workspaceDir, DRY_RUN_SUBJECT);
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  // 试跑跑的是真实模型调用。不接配额的话 usage_ledger 看得见这笔花费、quota_counters 却不涨，
  // global.daily 对试跑一概无效 —— 和 docs/20 · W-QUOTA-01 是同一个成因（subagent.ts 的注释）。
  const roleLimits = live.quota.perUser.byRole[run.effectiveRole];
  const estimate = modelRegistry.estimate(definition.modelAlias, Math.max(live.context.limit.tokens / 4, 1000));
  if (live.quota.enabled && live.quota.requirePricing && estimate === null) throw new Error(`别名 ${definition.modelAlias} 缺少定价，无法预估试跑花费（quota.requirePricing=true）`);
  const reservation = live.quota.enabled ? quota.reserve({ chatId: DRY_RUN_SUBJECT, userId: DRY_RUN_SUBJECT,
    estimateUsd: Math.max(live.quota.minReserveUsd, estimate ?? live.quota.minReserveUsd),
    limits: { globalDaily: live.quota.global.daily, globalMonthly: live.quota.global.monthly,
      chatDaily: live.quota.perChat.daily, chatMonthly: live.quota.perChat.monthly,
      userDaily: roleLimits?.daily ?? live.quota.perUser.daily, userMonthly: roleLimits?.monthly ?? live.quota.perUser.monthly } }) : null;
  if (live.quota.enabled && !reservation) {
    agents.fail(run, 'quota_exceeded');
    throw new Error('额度不足：试跑与正常轮次共用同一份全局额度，当前窗口已经用满');
  }
  const turn = { turnId: run.turnId, key: run.turnId, chatId: DRY_RUN_SUBJECT, threadId: null, initiatorUserId: 'webui',
    effectiveRole: run.effectiveRole, isPrivate: false, baseCommitId: null,
    snapshot: { messages: [], ordinals: [], tokens: 0, windowStart: 1, headOrdinal: 0 }, delta: [], abortSignal: signal, config: live } satisfies RuntimeTurnContext;
  try {
    return await runSubAgent(run, definition, task, undefined, turn, { db, agents, registry: modelRegistry, tools: toolRegistry, ledger, log, workspace,
      provider: { maxRetries: live.provider.maxRetries, retryBaseMs: live.provider.retryBaseMs, retryMaxMs: live.provider.retryMaxMs },
      quota, reservation, onEvent: emit });
  } finally {
    // commit 只退掉已结算的那部分，剩下的预留必须还回去，否则一次试跑就永久占住一份额度。
    if (reservation) quota.release(reservation);
    // 试跑的 turnId 每次都是新的，而工具调用计数与审批记忆都按 turnId 挂在两张 Map 上。
    // `releaseTurn` 此前只在 `bot.ts` 的正常轮次收尾里调 —— 每跑一次试跑就永久多两条记录
    // （docs/22 · I-10）。
    toolRegistry.releaseTurn(run.turnId);
    approval.releaseTurn(run.turnId);
  }
}

const rebuildModels = (): void => { const live = configStore.snapshot(); modelRegistry.rebuild(live.provider.healthDownCooldownMinutes);
  // 一个可用别名都不剩 = 所有 provider 都下线了（docs/10 §6 all_providers_down）。用户侧的表现
  // 是每一轮都以 model alias unavailable 失败，而运维那边只有一条 config.invalid 躺在日志里。
  if (!modelRegistry.aliases().length) alerts.fire('all_providers_down', '没有任何可用的模型别名：所有 provider 都不可用或未配置'); log.setSecrets([process.env.BOT_TOKEN ?? '', process.env.LUOLI_MASTER_KEY ?? '', live.tools.web.searchApiKey, ...providers.allDecryptedKeys()]); };
const eventStreams = new EventStreamRegistry();
const server = createServer({ config: configStore, db, operations, principals, archive, context, providers, modelCatalog, approvals: approval, rebuildModels, maintenance, ledger, restart: (reason) => restart(reason), events, log,
  memory, promptDocuments, skills, plugins, mcp, agents, turnRegistry, sandbox, eventStreams, previewPrompt, dryRunAgent, configSchema: configJsonSchema(), startedAt, setup });
// `webui.enabled=false`：整个 HTTP 面不监听。这不只是省一个端口 —— 单口令 + owner 全权限的
// 控制台是这个部署最大的攻击面，只跑 Telegram 的场景该能把它整个关掉。
// 代价要说清楚：**没有 WebUI 就没有审批裁决通道**，命中审批规则的调用会被当场拒绝
// （`EventBus.channelCount === 0`，docs/24 · R-APPR-01）。
const http = config.webui.enabled ? serve({ fetch: server.fetch, hostname: config.webui.host, port: config.webui.port }) : null;
if (!config.webui.enabled) log.event({ level: 'warn', kind: 'webui.disabled', summary: 'WebUI disabled by config; approvals will be rejected outright' });
events.subscribe((event) => {
  if (event.type !== 'config.changed') return;
  const keys = (event.data as { keys?: string[] }).keys ?? [];
  void loadConfig({ overrides: envOverlay(readPersistedConfig(config.db.path, reportRejectedKey)), onInvalidOverride: (dropped, reasons) => log.event({ level: 'error', kind: 'config.invalid', summary: `已忽略 ${dropped.length} 条非法覆盖`, data: { dropped, reasons } }) }).then((next) => {
    configStore.replace(next, keys);
    if (keys.some((key) => key.startsWith('logs.level'))) log.setLevel(next.logs.level);
    if (keys.some((key) => key.startsWith('logs.redactPatterns'))) log.redactPatterns = next.logs.redactPatterns;
    if (keys.some((key) => key.startsWith('provider.') || key.startsWith('model') || key === 'tools.web.searchApiKey')) rebuildModels();
    if (keys.some((key) => key.startsWith('agent.agents'))) agents.replaceDefinitions(next.agent.agents);
    if (keys.some((key) => key.startsWith('skills.'))) skills.scan();
    if (keys.some((key) => key.startsWith('plugins.'))) void plugins.reconcile();
    // McpManager 现在按 getter 读配置，但连接是有状态的：改了 servers 必须重跑一次 reconcile
    // 才会真的连上/断开（docs/20 · W-CFG-02）。
    if (keys.some((key) => key.startsWith('mcp.'))) void mcp.reconcile();
    log.event({ level: 'info', kind: 'config.changed', summary: 'Runtime configuration reloaded', data: { keys } });
  }).catch((error) => log.event({ level: 'error', kind: 'config.invalid', summary: error instanceof Error ? error.message : String(error) }));
});
log.event({ level: 'info', kind: 'system.start', summary: `${config.general.name} started`, data: { name: config.general.name, webui: `${config.webui.host}:${config.webui.port}`, providerSecrets: secrets.available } });
if (process.env.BOT_TOKEN) {
  bot = await createTelegramBot(process.env.BOT_TOKEN, { config: configStore, db, principals, archive, operations, context, turns, quota, memory, plugins, tools: toolRegistry, approvals: approval,
    registry: turnRegistry, concurrency: turnConcurrency, log, alerts, issueLoginToken: () => issueLoginToken(),
    estimateTurnCost: (inputTokens, key) => modelRegistry.estimate(readAppKv<string>(db, modelAliasKey(key)) ?? perChatConfig(configStore.snapshot(), key).agent.main.modelAlias, inputTokens),
    // 用 turn.config 而不是全局快照：本轮的 perChat 覆盖已经在 openTurn 时合并进去了。
    onTurn: (turn, reservation) => { const live = turn.config as Readonly<typeof config>; return streamMainAgent(turn, { config: live, db, registry: modelRegistry, tools: toolRegistry,
      prompts: promptAssembler, documents: promptDocuments, skills, plugins, agents, ledger, context, quota, reservation, log, workspace: resolve(live.sandbox.workspaceDir, turn.chatId) }); } });
  // `dropPendingOnStart`：停机期间积压的 update 直接丢掉，不补跑。默认关 —— 丢的是真实用户
  // 发过的消息。开它的场景是长时间停机后重启，不想让 bot 对着一小时前的话题连开几十轮。
  //
  // 不用 grammY 的 `bot.start()`：它逐条串行处理 update，`TurnConcurrency` 因此永远争用不到
  // （第二个人得等第一个人整轮跑完，docs/01 §3 的 global / perKey / queueMax 形同虚设）。
  // 在途上限取 `global + queueMax`：超出这个数再拉进来的轮次也只会被 `acquire` 顶回去。
  if (config.telegram.mode === 'polling') {
    poller = new UpdatePoller(bot, {
      allowedUpdates: config.telegram.allowedUpdates,
      dropPendingUpdates: config.telegram.dropPendingOnStart,
      maxInFlight: config.concurrency.global + config.concurrency.queueMax,
      onError: (error, phase) => log.event({ level: phase === 'fetch' ? 'warn' : 'error', kind: 'tg.error',
        summary: error instanceof Error ? error.message : String(error), data: { phase } }),
      // 401 / 409 说明这个 token 不该由本进程轮询（撤销了，或者另一个实例正在拉）。原先
      // `void bot.start()` 在这两种错误上 rethrow，经 unhandledRejection 变成 exit(1)；
      // 保留「死掉让 supervisor 重启」这一半，但走优雅关闭，别把 WAL 和日志留在半截状态。
      onFatal: (error) => {
        log.event({ level: 'error', kind: 'tg.error', summary: `polling aborted: ${error instanceof Error ? error.message : String(error)}`, data: { fatal: true } });
        process.stderr.write(`[telegram] 轮询被 Telegram 拒绝（token 失效或另有实例在拉同一个 bot）：${error instanceof Error ? error.message : String(error)}\n`);
        void shutdown('telegram:fatal').then(() => { process.exitCode = 1; });
      },
    });
    poller.start();
  } else {
    // webhook 模式没有实现：既不 start 也不注册路由，静默不收任何消息比直接报错危险得多。
    throw new Error(`telegram.mode=${config.telegram.mode} is not implemented; only polling is supported`);
  }
  // owner 私聊通道到这里才具备。`sendMessage` 失败由 AlertDispatcher 自己吞掉并记一条
  // `alert.deliver_failed` —— owner 没跟 bot 说过话时 Telegram 会拒发，那不该把告警链路带崩。
  const ownerChatId = configStore.snapshot().access.bootstrapOwnerId;
  if (ownerChatId) notifyOwner = (text) => bot!.api.sendMessage(ownerChatId, text);
} else {
  log.event({ level: 'warn', kind: 'system.start', summary: 'BOT_TOKEN missing; Telegram ingress disabled' });
}
let shuttingDown = false;
/**
 * WebUI 的 `[重启进程]`：走同一条优雅关闭路径，只是把退出码设成 `SIGTERM` 之外的一档，
 * 好让 supervisor 明确区分「运维要求重启」与「系统在停机」。**没有 supervisor 时进程不会
 * 自己回来** —— 端点的响应里写着这句话，界面的二次确认也要写。
 */
const restart = async (reason: string): Promise<void> => {
  log.event({ level: 'warn', kind: 'system.restart', summary: `Restart requested by ${reason}` });
  await shutdown(`restart:${reason}`);
  process.exitCode = 0;
};
const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) return; shuttingDown = true;
  log.event({ level: 'info', kind: 'system.stop', summary: `Stopping on ${signal}` });
  scheduler.stop();
  eventStreams.closeAll();
  const { promise: closed, resolve: markClosed } = Promise.withResolvers<void>();
  let force: ReturnType<typeof setTimeout> | null = null;
  if (http) {
    http.close(() => markClosed());
    force = setTimeout(() => { if ('closeAllConnections' in http) http.closeAllConnections(); markClosed(); }, config.general.shutdown.graceMs); force.unref?.();
  } else markClosed();
  // 先停拉取（`stop()` 顺手把 offset 交回 Telegram），在途的 update 交给下面的 drain。
  if (poller) await poller.stop();
  if (bot) await bot.stop();
  // 宽限期内没排空就主动中断：drain 只是等，等不来的轮次必须被 abort，否则它们要么把进程
  // 拖到 systemd 的 SIGKILL，要么在退出后留下 running 行等下次 recoverAfterCrash 认领（docs/24 · R-OPS-01）。
  if (!(await turnRegistry.drain(config.general.shutdown.graceMs))) {
    turnRegistry.abortAll('shutdown');
    await turnRegistry.drain(Math.min(1000, config.general.shutdown.graceMs));
  }
  // 还没开成轮次的那些 update（正在归档、正在下载媒体）不在 turnRegistry 里。不等它们收尾就
  // `closeDatabase`，那几条写会撞上「database is not open」，消息凭空消失且只留一行 tg.error。
  if (poller) await poller.drain(Math.min(2000, config.general.shutdown.graceMs));
  await closed; if (force) clearTimeout(force);
  await plugins.close();
  await mcp.close();
  await skills.close();
  log.close();
  closeDatabase(db);
  process.exitCode = 0;
};
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
// 一次 uncaught 的流错误可以直接带走进程，而日志里一个字都不留 —— 上一次排查只能靠翻数据库
// 猜「最后一条 turn.start 之后发生了什么」。行为不变（照旧退出，恢复交给下次启动的
// recoverAfterCrash），但崩之前必须留下原因。LogSink 是 appendFileSync，写得完。
for (const fatal of ['uncaughtException', 'unhandledRejection'] as const) {
  process.on(fatal, (error: unknown) => {
    const detail = error instanceof Error ? error.stack ?? error.message : String(error);
    log.event({ level: 'error', kind: 'system.crash', summary: `${fatal}: ${error instanceof Error ? error.message : String(error)}`, data: { event: fatal, detail } });
    process.stderr.write(`[crash] ${fatal}: ${detail}\n`);
    process.exit(1);
  });
}
