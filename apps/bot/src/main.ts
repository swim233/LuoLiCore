import type { Bot } from 'grammy';
import argon2 from 'argon2';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { ArchiveRepository, OperationsRepository, PrincipalRepository, TurnRepository, closeDatabase, migrateDatabase, modelAliasKey, openDatabase, readAppKv, readPersistedConfig, recoverAfterCrash } from '@luoli/db';
import { AgentManager, AgentResultStore, ConfigStore, ContextEngine, DatabaseApprovalBroker, EventBus, FileTools, LogSink, MaintenanceService, McpManager, MemoryStore, ModelRegistry, PathJail, PluginManager, PromptAssembler, PromptDocuments, ProviderStore, QuotaGuard, Sandbox, Scheduler, Secrets, SkillLoader, TOOL_POLICY, ToolRegistry, TurnConcurrency, TurnRegistry, UsageLedger, configSchema, loadConfig, perChatConfig, registerBuiltins, rejectedWakewords, streamMainAgent } from '@luoli/core';
import { createServer, setupToken } from '@luoli/server';
import { createTelegramBot } from '@luoli/telegram';

const startedAt = Date.now();
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
const principals = new PrincipalRepository(db);
principals.ensureOwner(config.access.bootstrapOwnerId);
const archive = new ArchiveRepository(db);
const operations = new OperationsRepository(db);
const turns = new TurnRepository(db);
const quota = new QuotaGuard(db, config.general.timezone);
const secrets = new Secrets(process.env.LUOLI_MASTER_KEY);
// scrypt 抬高了离线爆破成本，但抬不动一个短口令（docs/20 · W-SEC-02）。
if (secrets.weak) process.stderr.write('[secrets] LUOLI_MASTER_KEY 短于 32 字符：provider key 的加密强度取决于它，建议换成 32 字节随机值。\n');
const providers = new ProviderStore(db, secrets);
const events = new EventBus();
const ledger = new UsageLedger(db);
const turnRegistry = new TurnRegistry();
const turnConcurrency = new TurnConcurrency(config.concurrency);
const log = new LogSink(operations, config.logs.dir, [process.env.BOT_TOKEN ?? '', process.env.LUOLI_MASTER_KEY ?? ''], { level: config.logs.level, maxFileMb: config.logs.maxFileMb, bodyMaxBytes: config.logs.bodyMaxBytes, console: config.logs.console });
const context = new ContextEngine(db, archive, log);
const modelRegistry = new ModelRegistry(db, providers);
modelRegistry.rebuild();
// 零配置首启本来就没有 main 别名，拒绝启动会把补配置用的 WebUI 一起带走（docs/04 §5.2）。
// 缺 main 只告警：轮次会在 streamMainAgent 里失败，WebUI 写入别名后 rebuildModels() 即时生效。
if (!modelRegistry.aliases().includes('main')) {
  log.event({ level: 'error', kind: 'config.invalid', summary: 'Required model alias main is unavailable' });
  process.stderr.write('[config] 缺少必需的 main 模型别名：服务照常启动，但所有轮次都会以 model alias unavailable 失败。\n'
    + `[config] 去 WebUI（http://${config.webui.host}:${config.webui.port} → Provider 页）配置 provider / 模型 / main 别名，保存后即时生效，无需重启。\n`);
}
const memory = new MemoryStore(db, config.memory.dir, config.memory.softLimitTokens, config.memory.hardLimitTokens, config.memory.maxSections, config.memory.forgetMeRetentionDays, log);
const skills = new SkillLoader(db, config.skills.dir);
skills.scan();
const agents = new AgentManager(db, new AgentResultStore(resolve('data/agent-results')), config.agent.agents, config.agent.maxDepth, config.agent.maxSubagentsPerTurn);
if (config.skills.watch) skills.startWatching();
const plugins = new PluginManager(db, config.plugins.dir, config.plugins.hookTimeoutMs, config.plugins.autoDisableAfterErrors, config.plugins.order);
await plugins.reconcile();
const mcp = new McpManager(db, () => configStore.snapshot().mcp, log);
await mcp.reconcile();
const maintenance = new MaintenanceService(db, config.db.path, config.db.backupKeep, config.logs.retentionDays);
const scheduler = new Scheduler();
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
  () => configStore.snapshot().approval.rules);
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
registerBuiltins(toolRegistry, {
  db, filesFor: (workspace) => new FileTools(new PathJail(workspace, config.tools.fs.denyGlobs), config.tools.fs.maxReadBytes, config.tools.fs.maxWriteBytes, { showHidden: config.tools.fs.showHidden, trashDir: config.tools.fs.trashDir, backupDir: config.tools.fs.backupDir }),
  sandbox, archive, context, memory, skills, agents, models: modelRegistry, ledger, log, quota, pubWriteMinRole: config.memory.pubWriteMinRole,
  maxWebBytes: config.tools.web.maxResponseBytes, maxAsksPerRun: config.agent.maxAsksPerRun, askTimeoutMs: config.agent.askTimeoutMs,
  webSearch: { provider: config.tools.web.searchProvider, apiKey: config.tools.web.searchApiKey },
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
const server = createServer({ config: configStore, db, operations, principals, archive, context, providers, approvals: approval, rebuildModels: () => modelRegistry.rebuild(), maintenance, events, log,
  memory, promptDocuments, skills, plugins, mcp, agents, turnRegistry, sandbox, configSchema: zodToJsonSchema(configSchema, 'LuoLiConfig'), startedAt, setup });
const http = serve({ fetch: server.fetch, hostname: config.webui.host, port: config.webui.port });
events.subscribe((event) => {
  if (event.type !== 'config.changed') return;
  const keys = (event.data as { keys?: string[] }).keys ?? [];
  void loadConfig({ overrides: envOverlay(readPersistedConfig(config.db.path, reportRejectedKey)), onInvalidOverride: (dropped, reasons) => log.event({ level: 'error', kind: 'config.invalid', summary: `已忽略 ${dropped.length} 条非法覆盖`, data: { dropped, reasons } }) }).then((next) => {
    configStore.replace(next, keys);
    if (keys.some((key) => key.startsWith('logs.level'))) log.setLevel(next.logs.level);
    if (keys.some((key) => key.startsWith('provider.') || key.startsWith('model'))) modelRegistry.rebuild();
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
let bot: Bot | null = null;

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
  if (shuttingDown) return;
  shuttingDown = true;
  log.event({ level: 'info', kind: 'system.stop', summary: `Stopping on ${signal}` });
  bot?.stop();
  scheduler.stop();
  http.close();
  if (!(await turnRegistry.drain(config.general.shutdown.graceMs))) {
    turnRegistry.abortAll('shutdown');
    await turnRegistry.drain(Math.min(1000, config.general.shutdown.graceMs));
  }
  await mcp.close();
  await plugins.close();
  await skills.close();
  maintenance.checkpoint();
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
