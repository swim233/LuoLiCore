import type { Bot } from 'grammy';
import argon2 from 'argon2';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { ArchiveRepository, OperationsRepository, PrincipalRepository, TurnRepository, closeDatabase, migrateDatabase, modelAliasKey, openDatabase, readAppKv, readPersistedConfig, recomputeMessageTokens, recoverAfterCrash, writeAppKv } from '@luoli/db';
import { AgentManager, AgentResultStore, ConfigStore, ContextEngine, DatabaseApprovalBroker, EventBus, FileTools, LogSink, MaintenanceService, McpManager, MemoryStore, ModelCatalog, ModelRegistry, PathJail, PluginManager, PromptAssembler, PromptDocuments, ProviderStore, QuotaGuard, Sandbox, Scheduler, Secrets, SkillLoader, STABLE_PROMPT_BLOCKS, TOOL_POLICY, ToolRegistry, TurnConcurrency, TurnRegistry, UsageLedger, assembleMainPrompt, configJsonSchema, loadConfig, perChatConfig, registerBuiltins, rejectedWakewords, runSubAgent, streamMainAgent, type SubAgentRuntimeEvent } from '@luoli/core';
import { createServer, EventStreamRegistry, setupToken, type PromptPreviewResult } from '@luoli/server';
import type { RuntimeTurnContext } from '@luoli/shared';
import { TelegramTools, createTelegramBot } from '@luoli/telegram';

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
const context = new ContextEngine(db, archive, log);
const modelRegistry = new ModelRegistry(db, providers);
modelRegistry.rebuild();
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
skills.scan();
const agents = new AgentManager(db, new AgentResultStore(resolve('data/agent-results')), config.agent.agents, config.agent.maxDepth, config.agent.maxSubagentsPerTurn);
if (config.skills.watch) skills.startWatching();
const plugins = new PluginManager(db, config.plugins.dir, config.plugins.hookTimeoutMs, config.plugins.autoDisableAfterErrors, config.plugins.order);
await plugins.reconcile();
const mcp = new McpManager(db, () => configStore.snapshot().mcp, log);
await mcp.reconcile();
const maintenance = new MaintenanceService(db, config.db.path, config.db.backupKeep, config.logs.retentionDays, config.logs.dir);
const scheduler = new Scheduler((name, error) => log.event({ level: 'error', kind: 'scheduler.failed', summary: `${name} failed`, data: { error: error instanceof Error ? error.message : String(error) } }));
scheduler.add(config.general.maintenanceCron, () => { const result = maintenance.cleanup(); log.event({ level: 'info', kind: 'maintenance.cleanup', summary: 'Scheduled cleanup complete', data: result }); }, 'maintenance');
scheduler.add(config.db.vacuumCron, () => { maintenance.vacuum(); log.event({ level: 'info', kind: 'maintenance.vacuum', summary: 'Scheduled VACUUM complete' }); }, 'vacuum');
scheduler.add(config.memory.compactCron, () => { log.event({ level: 'info', kind: 'memory.compact', summary: 'Memory compaction review scheduled', data: { pending: memory.list().filter((entry) => entry.tokens > config.memory.softLimitTokens).length } }); }, 'memory-compact');
scheduler.add(config.provider.healthCheckCron, () => { modelRegistry.rebuild(); log.event({ level: 'info', kind: 'provider.health', summary: 'Provider registry health refreshed', data: { aliases: modelRegistry.aliases() } }); }, 'provider-health');
scheduler.add(config.mcp.healthCheckCron, () => mcp.reconcile(), 'mcp-health');
const promptAssembler = new PromptAssembler();
const promptDocuments = new PromptDocuments(db, config.memory.dir);
promptDocuments.ensure();
const approval = new DatabaseApprovalBroker(db, () => configStore.snapshot(), events, log);
if (!config.approval.enabled) log.event({ level: 'warn', kind: 'approval.disabled', summary: 'Approval flow disabled; dangerous tools execute without review' });
// 唤醒词在匹配时被静默跳过、或四个开关全关，表现都只是「bot 不理我」——启动时先把它说出来（docs/11 §启动校验）。
const unusableWakewords = rejectedWakewords(config.trigger.wakewords, config.trigger.wakewordMinLength);
if (unusableWakewords.length) log.event({ level: 'warn', kind: 'config.invalid', summary: `${unusableWakewords.length} 条唤醒词不会生效`, data: { rejected: unusableWakewords } });
if (!config.trigger.private && !config.trigger.mention && !config.trigger.reply && !config.trigger.command && config.trigger.wakewords.length === unusableWakewords.length) {
  log.event({ level: 'warn', kind: 'config.invalid', summary: 'No trigger source is enabled; the bot will never respond' });
}
const toolRegistry = new ToolRegistry(log, approval,
  () => { const live = configStore.snapshot(); return { maxRegistered: live.tools.maxRegistered, maxCallsPerTurn: live.tools.maxCallsPerTurn, maxConsecutiveErrors: live.tools.maxConsecutiveErrors, maxOutputBytes: live.tools.exec.maxOutputBytes }; },
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
}, undefined, undefined, (message) => log.event({ level: 'warn', kind: 'sandbox.weak_isolation', summary: message }));
const sandboxProbe = await sandbox.probe();
if (!sandboxProbe.available && config.sandbox.mode === 'docker') log.event({ level: 'error', kind: 'sandbox.unavailable', summary: sandboxProbe.error ?? 'Docker sandbox unavailable' });
// bot 要到最后才建得起来，而工具在这里就得注册完，所以桥拿的是 getter。**presence 即开关**：
// `available()` 判的就是 `telegram` 在不在，没有 BOT_TOKEN 时这一族工具必须整体不进目录，
// 而不是进了目录再在调用时失败。
let bot: Bot | null = null;
const telegramTools = process.env.BOT_TOKEN
  ? new TelegramTools({ bot: () => bot, archive, maxMessageChars: () => configStore.snapshot().output.maxMessageChars })
  : null;
registerBuiltins(toolRegistry, {
  db, filesFor: (workspace) => new FileTools(new PathJail(workspace, config.tools.fs.denyGlobs), config.tools.fs.maxReadBytes, config.tools.fs.maxWriteBytes, { showHidden: config.tools.fs.showHidden, trashDir: config.tools.fs.trashDir, backupDir: config.tools.fs.backupDir }),
  sandbox, archive, context, memory, skills, agents, models: modelRegistry, ledger, log, quota,
  maxWebBytes: config.tools.web.maxResponseBytes, maxAsksPerRun: config.agent.maxAsksPerRun, askTimeoutMs: config.agent.askTimeoutMs,
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
  const snapshot = context.materialize(key, null);
  const turn = {
    turnId: 'webui:prompt-preview', key, chatId: contextRow.chatId, threadId: contextRow.threadId,
    initiatorUserId: latest?.userId ?? contextRow.chatId, effectiveRole: role,
    isPrivate: principal?.chatType ? principal.chatType === 'private' : !contextRow.chatId.startsWith('-'),
    baseCommitId: null, snapshot, delta: [], abortSignal: new AbortController().signal, config: live,
  } satisfies RuntimeTurnContext;
  const built = assembleMainPrompt(turn, { config: live, tools: toolRegistry, prompts: promptAssembler, documents: promptDocuments,
    workspace: resolve(live.sandbox.workspaceDir, contextRow.chatId), skills, agents });
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
  }
}

const rebuildModels = (): void => { modelRegistry.rebuild(); const live = configStore.snapshot(); log.setSecrets([process.env.BOT_TOKEN ?? '', process.env.LUOLI_MASTER_KEY ?? '', live.tools.web.searchApiKey, ...providers.allDecryptedKeys()]); };
const eventStreams = new EventStreamRegistry();
const server = createServer({ config: configStore, db, operations, principals, archive, context, providers, modelCatalog, approvals: approval, rebuildModels, maintenance, events, log,
  memory, promptDocuments, skills, plugins, mcp, agents, turnRegistry, sandbox, eventStreams, previewPrompt, dryRunAgent, configSchema: configJsonSchema(), startedAt, setup });
const http = serve({ fetch: server.fetch, hostname: config.webui.host, port: config.webui.port });
events.subscribe((event) => {
  if (event.type !== 'config.changed') return;
  const keys = (event.data as { keys?: string[] }).keys ?? [];
  void loadConfig({ overrides: envOverlay(readPersistedConfig(config.db.path, reportRejectedKey)), onInvalidOverride: (dropped, reasons) => log.event({ level: 'error', kind: 'config.invalid', summary: `已忽略 ${dropped.length} 条非法覆盖`, data: { dropped, reasons } }) }).then((next) => {
    configStore.replace(next, keys);
    if (keys.some((key) => key.startsWith('logs.level'))) log.setLevel(next.logs.level);
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
log.event({ level: 'info', kind: 'system.start', summary: 'LuoLiCore started', data: { webui: `${config.webui.host}:${config.webui.port}`, providerSecrets: secrets.available } });
if (process.env.BOT_TOKEN) {
  bot = await createTelegramBot(process.env.BOT_TOKEN, { config: configStore, db, principals, archive, operations, context, turns, quota, memory, plugins, tools: toolRegistry, approvals: approval,
    registry: turnRegistry, concurrency: turnConcurrency, log,
    estimateTurnCost: (inputTokens, key) => modelRegistry.estimate(readAppKv<string>(db, modelAliasKey(key)) ?? perChatConfig(configStore.snapshot(), key).agent.main.modelAlias, inputTokens),
    // 用 turn.config 而不是全局快照：本轮的 perChat 覆盖已经在 openTurn 时合并进去了。
    onTurn: (turn, reservation) => { const live = turn.config as Readonly<typeof config>; return streamMainAgent(turn, { config: live, db, registry: modelRegistry, tools: toolRegistry,
      prompts: promptAssembler, documents: promptDocuments, skills, plugins, agents, ledger, context, quota, reservation, log, workspace: resolve(live.sandbox.workspaceDir, turn.chatId) }); } });
  if (config.telegram.mode === 'polling') void bot.start({ allowed_updates: config.telegram.allowedUpdates as never[] });
  // webhook 模式没有实现：既不 start 也不注册路由，静默不收任何消息比直接报错危险得多。
  else throw new Error(`telegram.mode=${config.telegram.mode} is not implemented; only polling is supported`);
} else {
  log.event({ level: 'warn', kind: 'system.start', summary: 'BOT_TOKEN missing; Telegram ingress disabled' });
}
let shuttingDown = false;
const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) return; shuttingDown = true;
  log.event({ level: 'info', kind: 'system.stop', summary: `Stopping on ${signal}` });
  scheduler.stop();
  eventStreams.closeAll();
  const { promise: closed, resolve: markClosed } = Promise.withResolvers<void>();
  http.close(() => markClosed());
  const force = setTimeout(() => { if ('closeAllConnections' in http) http.closeAllConnections(); markClosed(); }, config.general.shutdown.graceMs); force.unref?.();
  if (bot) await bot.stop();
  // 宽限期内没排空就主动中断：drain 只是等，等不来的轮次必须被 abort，否则它们要么把进程
  // 拖到 systemd 的 SIGKILL，要么在退出后留下 running 行等下次 recoverAfterCrash 认领（docs/24 · R-OPS-01）。
  if (!(await turnRegistry.drain(config.general.shutdown.graceMs))) {
    turnRegistry.abortAll('shutdown');
    await turnRegistry.drain(Math.min(1000, config.general.shutdown.graceMs));
  }
  await closed; clearTimeout(force);
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
