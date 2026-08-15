import type { Bot } from 'grammy';
import argon2 from 'argon2';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { ArchiveRepository, OperationsRepository, PrincipalRepository, TurnRepository, closeDatabase, migrateDatabase, modelAliasKey, openDatabase, readAppKv, readPersistedConfig, recoverAfterCrash } from '@luoli/db';
import { AgentManager, AgentResultStore, ConfigStore, ContextEngine, DatabaseApprovalBroker, EventBus, FileTools, LogSink, MaintenanceService, McpManager, MemoryStore, ModelRegistry, PathJail, PluginManager, PromptAssembler, PromptDocuments, ProviderStore, QuotaGuard, Sandbox, Scheduler, Secrets, SkillLoader, TOOL_POLICY, ToolRegistry, TurnConcurrency, TurnRegistry, UsageLedger, configSchema, loadConfig, perChatConfig, registerBuiltins, streamMainAgent } from '@luoli/core';
import { createServer, setupToken } from '@luoli/server';
import { createTelegramBot } from '@luoli/telegram';

const startedAt = Date.now();
const startupDatabasePath = process.env.LUOLI_DATA_DIR ? resolve(process.env.LUOLI_DATA_DIR, 'luoli.db') : './data/luoli.db';
const startupOverrides = readPersistedConfig(startupDatabasePath);
if (process.env.LUOLI_WEBUI_HOST || process.env.WEBUI_PASSWORD) {
  const webui = startupOverrides.webui && typeof startupOverrides.webui === 'object' && !Array.isArray(startupOverrides.webui)
    ? startupOverrides.webui as Record<string, unknown> : {};
  if (process.env.LUOLI_WEBUI_HOST) webui.host = process.env.LUOLI_WEBUI_HOST;
  if (process.env.WEBUI_PASSWORD) webui.passwordHash = await argon2.hash(process.env.WEBUI_PASSWORD, { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
  startupOverrides.webui = webui;
}
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
principals.upsertSeen({ id: `user:${config.access.bootstrapOwnerId}`, kind: 'user', tgId: config.access.bootstrapOwnerId, role: 'owner', displayName: 'Owner', username: null, chatType: null }, 'bootstrap');
const archive = new ArchiveRepository(db);
const operations = new OperationsRepository(db);
const turns = new TurnRepository(db);
const quota = new QuotaGuard(db, config.general.timezone);
const secrets = new Secrets(process.env.LUOLI_MASTER_KEY);
const providers = new ProviderStore(db, secrets);
const events = new EventBus();
const ledger = new UsageLedger(db);
const turnRegistry = new TurnRegistry();
const turnConcurrency = new TurnConcurrency(config.concurrency);
const log = new LogSink(operations, config.logs.dir, [process.env.BOT_TOKEN ?? '', process.env.LUOLI_MASTER_KEY ?? ''], { level: config.logs.level, maxFileMb: config.logs.maxFileMb, bodyMaxBytes: config.logs.bodyMaxBytes, console: config.logs.console });
const context = new ContextEngine(db, archive, log);
const modelRegistry = new ModelRegistry(db, providers);
modelRegistry.rebuild();
if (!modelRegistry.aliases().includes('main')) {
  log.event({ level: 'error', kind: 'config.invalid', summary: 'Required model alias main is unavailable' });
  if (process.env.BOT_TOKEN) throw new Error('model alias unavailable: main');
}
const memory = new MemoryStore(db, config.memory.dir, config.memory.softLimitTokens, config.memory.hardLimitTokens, config.memory.maxSections, config.memory.forgetMeRetentionDays, log);
const skills = new SkillLoader(db, config.skills.dir);
skills.scan();
const agents = new AgentManager(db, new AgentResultStore(resolve('data/agent-results')), config.agent.agents, config.agent.maxDepth, config.agent.maxSubagentsPerTurn);
if (config.skills.watch) skills.startWatching();
const plugins = new PluginManager(db, config.plugins.dir, config.plugins.hookTimeoutMs, config.plugins.autoDisableAfterErrors, config.plugins.order);
await plugins.reconcile();
const mcp = new McpManager(db, config.mcp, log);
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
const approval = new DatabaseApprovalBroker(db, config, events, log);
if (!config.approval.enabled) log.event({ level: 'warn', kind: 'approval.disabled', summary: 'Approval flow disabled; dangerous tools execute without review' });
const toolRegistry = new ToolRegistry(log, approval, { maxRegistered: config.tools.maxRegistered, maxCallsPerTurn: config.tools.maxCallsPerTurn, maxConsecutiveErrors: config.tools.maxConsecutiveErrors, maxOutputBytes: config.tools.exec.maxOutputBytes }, config.approval.rules);
toolRegistry.bindOverrides(() => configStore.snapshot().tools.overrides);
const sandbox = new Sandbox({ mode: config.sandbox.mode, bypassRoles: config.sandbox.bypassRoles, dockerBin: config.sandbox.dockerBin,
  image: config.sandbox.image, network: config.sandbox.network, memoryMb: config.sandbox.memoryMb, cpus: config.sandbox.cpus,
  pidsLimit: config.sandbox.pidsLimit, readOnlyRoot: config.sandbox.readOnlyRoot, tmpfsMb: config.sandbox.tmpfsMb,
  workspaceDir: config.sandbox.workspaceDir, hostWorkspaceDir: config.sandbox.hostWorkspaceDir,
  defaultTimeoutMs: config.tools.exec.defaultTimeoutMs, maxTimeoutMs: config.tools.exec.maxTimeoutMs, maxOutputBytes: config.tools.exec.maxOutputBytes });
const sandboxProbe = await sandbox.probe();
if (!sandboxProbe.available && config.sandbox.mode === 'docker') log.event({ level: 'error', kind: 'sandbox.unavailable', summary: sandboxProbe.error ?? 'Docker sandbox unavailable' });
registerBuiltins(toolRegistry, {
  db, filesFor: (workspace) => new FileTools(new PathJail(workspace, config.tools.fs.denyGlobs), config.tools.fs.maxReadBytes, config.tools.fs.maxWriteBytes, { showHidden: config.tools.fs.showHidden, trashDir: config.tools.fs.trashDir, backupDir: config.tools.fs.backupDir }),
  sandbox, archive, context, memory, skills, agents, models: modelRegistry, ledger, log, pubWriteMinRole: config.memory.pubWriteMinRole,
  maxWebBytes: config.tools.web.maxResponseBytes, maxAsksPerRun: config.agent.maxAsksPerRun, askTimeoutMs: config.agent.askTimeoutMs,
  webSearch: { provider: config.tools.web.searchProvider, apiKey: config.tools.web.searchApiKeyRef },
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
  void loadConfig({ overrides: readPersistedConfig(config.db.path), onInvalidOverride: (dropped, reasons) => log.event({ level: 'error', kind: 'config.invalid', summary: `已忽略 ${dropped.length} 条非法覆盖`, data: { dropped, reasons } }) }).then((next) => {
    configStore.replace(next, keys);
    if (keys.some((key) => key.startsWith('logs.level'))) log.setLevel(next.logs.level);
    if (keys.some((key) => key.startsWith('provider.') || key.startsWith('model'))) modelRegistry.rebuild();
    if (keys.some((key) => key.startsWith('skills.'))) skills.scan();
    if (keys.some((key) => key.startsWith('plugins.'))) void plugins.reconcile();
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
