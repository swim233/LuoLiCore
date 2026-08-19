import type { Bot } from 'grammy';
import argon2 from 'argon2';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { ArchiveRepository, CustomToolRepository, OperationsRepository, PrincipalRepository, ScheduleRepository, TurnRepository, acquireInstanceLock, closeDatabase, migrateDatabase, modelAliasKey, openDatabase, readAppKv, readPersistedConfig, recomputeMessageTokens, recoverAfterCrash, writeAppKv } from '@luoli/db';
import { AgentManager, AgentResultStore, AlertDispatcher, BUNDLED_SKILLS, ConfigStore, CustomToolManager, mergeAgentDefinitions, scanAgentFiles, ContextEngine, DatabaseApprovalBroker, EventBus, FileTools, LogSink, MaintenanceService, McpManager, MemoryStore, ModelCatalog, ModelRegistry, PathJail, PluginManager, selfAuthoringDenyGlobs, PromptAssembler, PromptDocuments, ProviderStore, PROVIDER_FAILURES_TO_DOWN, PROVIDER_PROBE_TIMEOUT_MS, QuotaGuard, repairAgentResultRefs, repairLedgerCacheCost, runProviderHealthCheck, Sandbox, ScheduledJobRunner, Scheduler, Secrets, SkillLoader, STABLE_PROMPT_BLOCKS, TOOL_POLICY, ToolRegistry, TurnConcurrency, TurnFailureStreak, TurnRegistry, UsageLedger, assembleMainPrompt, configJsonSchema, loadConfig, perChatConfig, registerAuthoringTools, registerBuiltins, rejectedWakewords, runMainAgent, runSubAgent, streamMainAgent, type SubAgentRuntimeEvent } from '@luoli/core';
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
// **拿锁必须排在 `recoverAfterCrash` 之前**：那个函数假定「进程启动 ⇒ 上一个进程已死」，
// 而在这把锁之前没有任何东西保证这一点 —— 用同一个库起第二个实例会把在位实例**仍在执行**的
// 轮次就地判死、释放已认领的消息、清零在途预留，之后 A 才因为 409 关停（docs/28 · L-OPS-01）。
// 迁移排在前面是有意的：锁文件放在库旁边，而空库首启时目录可能还不存在。
const instanceLock = acquireInstanceLock(config.db.path);
if (!instanceLock.ok) {
  process.stderr.write(`[lock] 另一个实例正在使用这个库（pid ${instanceLock.holder.pid}@${instanceLock.holder.host}，`
    + `起于 ${new Date(instanceLock.holder.startedAt).toISOString()}）。\n`
    + `[lock] 同库双实例会互相清掉在途轮次与消息认领，所以这里拒绝启动。要换实例先停掉那一个；\n`
    + `[lock] 确认它已经死了但锁还在，删掉 ${config.db.path}.lock 再试。\n`);
  process.exit(1);
}
if (instanceLock.lock.stolenFrom) process.stdout.write(`[lock] 接手了 pid ${instanceLock.lock.stolenFrom} 留下的锁 —— 上一次不是正常退出。\n`);
// 报出来而不是静静收尾：`LogSink` 到下面才建得起来，所以先走 stdout，等 sink 有了再补一条
// `system.recovered`。此前它返回 void 也不记日志，一次非正常重启之后 reap 了什么只能靠翻
// `turns` 表反推（docs/28 · L-OPS-04）。
const recovered = recoverAfterCrash(db);
const recoveredAny = Object.values(recovered).some((count) => count > 0);
if (recoveredAny) process.stdout.write(`[recover] 上一个进程没有正常收尾：判死 ${recovered.turns} 条轮次 / ${recovered.tasks} 条任务 / ${recovered.agentRuns} 条子 agent，`
  + `释放 ${recovered.claims} 条消息认领，清零 ${recovered.reservations} 行在途预留。\n`);
// 一次性数据修复而不是迁移：迁移文件提交后不可修改，而这件事要用 TS 侧的估算器重算 parts。
// 修的是 token 校准失控期间落库的 tokens（实测系数最高约 26 倍，logs/2026-08-16）。
if (!readAppKv<boolean>(db, TOKEN_REPAIR_KEY)) {
  const repaired = recomputeMessageTokens(db);
  writeAppKv(db, TOKEN_REPAIR_KEY, true, 'startup');
  if (repaired.messages || repaired.contexts) process.stdout.write(`[context] 已按新估算器重算 ${repaired.messages} 条上下文消息的 tokens，并重置 ${repaired.contexts} 个会话的校准系数。\n`);
}
// 同一条路的第二次一次性修复：缓存 token 曾被双重计价，账面高估约 44%（docs/28 · L-COST-01）。
// 它自己带 `app_kv` 门闸，跑过一次就返回 null。
const ledgerRepair = repairLedgerCacheCost(db, config.general.timezone);
if (ledgerRepair?.rewritten) process.stdout.write(`[ledger] 已按新计价口径重算 ${ledgerRepair.rewritten} 条用量（受影响 ${ledgerRepair.affected} 条、跳过 ${ledgerRepair.skipped} 条），`
  + `合计 $${ledgerRepair.before.toFixed(6)} → $${ledgerRepair.after.toFixed(6)}；同时重算 ${ledgerRepair.turns} 条轮次与 ${ledgerRepair.counters} 行配额计数`
  + `${ledgerRepair.countersStale ? `（另有 ${ledgerRepair.countersStale} 行明细已过保留期，算不回来）` : ''}。\n`);
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
// 两条修复都发生在 sink 之前，所以补记在这里 —— stdout 那两行只有盯着终端的人看得见，
// 而「上一次崩溃 reap 了什么」正是事后才会有人来查的东西（docs/28 · L-OPS-04）。
if (recoveredAny) log.event({ level: 'warn', kind: 'system.recovered', summary: `上一个进程没有正常收尾：判死 ${recovered.turns} 条轮次`, data: recovered });
if (ledgerRepair?.rewritten) log.event({ level: 'warn', kind: 'maintenance.repair', summary: `按新计价口径重算了 ${ledgerRepair.rewritten} 条用量`, data: ledgerRepair });
// 告警要早于沙箱、plugin、模型注册表建起来：那三处的构造参数里就挂着告警回调。
// owner 私聊在 bot 建好之后再补（`alerts.bindOwner`），此前只走 webhook 与日志。
let notifyOwner: ((text: string) => Promise<unknown>) | null = null;
const alerts = new AlertDispatcher(() => configStore.snapshot().alerts, log,
  { owner: async (text: string) => { await notifyOwner?.(text); } }, () => configStore.snapshot().provider.allowPrivateBaseUrl);
// 日志自己写不进去时也要有人知道 —— 只写 stderr 的话运维通常永远看不到（docs/10 §6 db_write_failed）。
log.onWriteFailure = (error) => alerts.fire('db_write_failed', '日志写入失败', { error: error instanceof Error ? error.message : String(error) });
// 连续失败计数只此一份：Telegram 轮次与定时轮次记在同一个计数器上，否则「上游变黑洞」在
// 没人聊天的部署里一次告警都不响，两份各卡在 4 次（docs/28 · L-SCH-02）。
const turnFailures = new TurnFailureStreak(alerts);
const context = new ContextEngine(db, archive, log);
const modelRegistry = new ModelRegistry(db, providers,
  (providerId, reason) => log.event({ level: 'warn', kind: 'provider.health', summary: `provider ${providerId} 已跳过：${reason}`, data: { providerId, reason } }));
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
// 第四个参数：扫描结果真的变了才广播。没有它，扩展页只能靠 `health` 事件顺带刷新 ——
// 从 Telegram 装进来的东西要等下一次健康检查才出现（docs/21 §9 · G-EXT-05）。
// 第五个参数是 `LogSink`：`scan()` 的 per-skill catch 此前只写 `skills.load_error` 那一列，
// 「我加的那个 skill 为什么不存在」在日志里一个字都没有（docs/28 · L-LOG-01）。
const skills = new SkillLoader(db, config.skills.dir, () => configStore.snapshot().skills.defaultMinRole,
  () => events.emit('extensions.changed', { kind: 'skill' }), log);
// `skills.enabled=false` 时不扫盘也不监听：目录里的 SKILL.md 一个都不进工具目录。
// 关掉是整块关掉，而不是「扫出来但不给用」—— 后者会让工具目录里多出一批点不动的名字。
if (config.skills.enabled) skills.scan();
else log.event({ level: 'info', kind: 'skills.disabled', summary: 'Skills disabled by config' });
// 一份常量供两处用：写入方（AgentResultStore）与清理方（MaintenanceService.gcFiles）指向
// 不同目录时，gc 会把整棵结果目录当成孤儿删空。
// 跟着 `LUOLI_DATA_DIR` 走，和 `db.path` / `media.dir` 同一处（config/index.ts 的 envLayer）。
// 三者指向不同部署时 `gcFiles()` 会把别人的数据当孤儿删掉（docs/25 §10）。
// 这个值只用来**定位目录**：库里那一列存的是相对它的 ref（`AgentResultStore.put`）。
// 此前存的是 `resolve()` 出来的绝对路径，于是「同一次运行内两处指向不同目录」防住了，
// 而**时间性**错配没防住 —— 无 `LUOLI_DATA_DIR` 时它绑定的是启动那一刻的 cwd，换个目录
// 起一次进程，库里记的就是旧根、文件在新根，gc 把新根下的全文整批当孤儿删掉（docs/28 · L-OPS-06）。
const agentResultsDir = process.env.LUOLI_DATA_DIR ? resolve(process.env.LUOLI_DATA_DIR, 'agent-results') : resolve('data/agent-results');
// 存量绝对路径行的一次性归一化，门闸同上面那两条修复。指向另一个根的行**不动** ——
// 那是「这两套东西不是同一个部署」的唯一信号，`gcFiles()` 要靠它拒绝清理。
const resultRefs = repairAgentResultRefs(db, agentResultsDir);
if (resultRefs?.rewritten) process.stdout.write(`[agents] 已把 ${resultRefs.rewritten} 行子 agent 结果路径归一化成相对 ${agentResultsDir} 的 ref（另有 ${resultRefs.relative} 行本来就是）。\n`);
if (resultRefs?.foreign) {
  process.stderr.write(`[agents] ${resultRefs.foreign} 行子 agent 结果路径指向另一个部署根（例如 ${resultRefs.sample}），原样留下。\n`
    + `[agents] gc-files 会因此拒绝清理子 agent 结果目录 —— 先确认这个库与 ${agentResultsDir} 是不是同一个部署的。\n`);
  log.event({ level: 'warn', kind: 'maintenance.repair', summary: `${resultRefs.foreign} 行子 agent 结果路径指向另一个部署根`, data: resultRefs });
}
/**
 * `agents/<name>.md`（docs/14 §2 Q5）：文件是只读来源，`agent.agents`（DB / WebUI）同名覆盖它。
 * 解析失败**必须报出来** —— 一个写错 frontmatter 的 agent 悄悄不存在，表现是「我明明加了这个
 * agent，模型说没有」。所以每条错误一行 error 日志 + 一行 stderr，而不是让它消失在启动噪音里。
 * 不为此中止启动：一个 agent 定义写错，不该让整个 bot 起不来（同 skills 的取舍）。
 */
const scanAgents = (current: typeof config) => {
  const scan = scanAgentFiles(current.agent.agentsDir);
  for (const failure of scan.errors) {
    log.event({ level: 'error', kind: 'agent.file_invalid', summary: `子 agent 定义解析失败：${failure.file}`, data: failure });
    process.stderr.write(`[agents] ${failure.file}: ${failure.error}\n`);
  }
  return mergeAgentDefinitions(scan.definitions, current.agent.agents);
};
const agents = new AgentManager(db, new AgentResultStore(agentResultsDir), scanAgents(config), config.agent.maxDepth, config.agent.maxSubagentsPerTurn);
if (config.skills.enabled && config.skills.watch) skills.startWatching();
// 第八个参数是 `LogSink`：单次钩子失败此前完全静默（要累计到 `autoDisableAfterErrors` 才经告警
// 落一行，而那一行还受 `alerts.on` 默认 `[]` 与 `dedupeMinutes` 管）—— 实测一个三轮必抛的
// `beforeTurn`，与 plugin 有关的日志 0 条（docs/28 · L-LOG-01）。
const plugins = new PluginManager(db, config.plugins.dir, config.plugins.hookTimeoutMs, config.plugins.autoDisableAfterErrors, config.plugins.order, undefined,
  (name, error) => alerts.fire('plugin_auto_disabled', `plugin ${name} 连续出错已被自动禁用`, { plugin: name, error }, name), log);
// `plugins.enabled=false` 时不 reconcile：一个 plugin 都不加载，钩子链是空的。
// 「进程内全信任」（docs/14 A27）意味着这个开关是安全边界，不是性能开关。
if (config.plugins.enabled) {
  await plugins.reconcile();
  // 「装得像成功了、实际一直跑旧代码」是最贵的一种沉默：tsx 下 reload 每一次都回 ok
  // （docs/28 · L-EXT-04）。修不了就在启动时说出来，与 reload 端点同一句话。
  if (plugins.hotReloadWarning) {
    // kind 用单数 `plugin.` 前缀：`CATEGORY_BY_PREFIX` 只认这一个，复数会掉进 turn.jsonl。
    log.event({ level: 'warn', kind: 'plugin.hot_reload_unreliable', summary: '这个运行时下 plugin 热重载不可靠：重载会成功但仍跑旧代码', data: { entry: process.argv[1] ?? null } });
    process.stderr.write(`[plugins] ${plugins.hotReloadWarning}\n`);
  }
  // `plugins.watch`：目录变动后重新 reconcile。默认关 —— 热加载一个全信任的 JS 文件，
  // 风险面比省一次重启大得多，开它要自己清楚这一点。
  if (config.plugins.watch) plugins.startWatching();
} else log.event({ level: 'info', kind: 'plugins.disabled', summary: 'Plugins disabled by config' });
const mcp = new McpManager(db, () => configStore.snapshot().mcp, log);
await mcp.reconcile();
const maintenance = new MaintenanceService(db, config.db.path, config.db.backupKeep, config.logs.retentionDays, config.logs.dir,
  { files: config.media.dir, agentResults: agentResultsDir }, config.logs.gzipAfterDays, config.schedule.retentionDays,
  { usage: config.maintenance.retention.usageDays, quotaCounters: config.maintenance.retention.quotaCounterDays,
    configRevisions: config.maintenance.retention.configRevisionDays, memoryRevisions: config.maintenance.retention.memoryRevisionDays,
    media: config.media.retentionDays });
const scheduler = new Scheduler((name, error) => log.event({ level: 'error', kind: 'scheduler.failed', summary: `${name} failed`, data: { error: error instanceof Error ? error.message : String(error) } }));
scheduler.add(config.general.maintenanceCron, () => { const result = maintenance.cleanup(); log.event({ level: 'info', kind: 'maintenance.cleanup', summary: 'Scheduled cleanup complete', data: result }); }, 'maintenance');
scheduler.add(config.db.vacuumCron, () => { maintenance.vacuum(); log.event({ level: 'info', kind: 'maintenance.vacuum', summary: 'Scheduled VACUUM complete' }); }, 'vacuum');
scheduler.add(config.memory.compactCron, () => { log.event({ level: 'info', kind: 'memory.compact', summary: 'Memory compaction review scheduled', data: { pending: memory.list().filter((entry) => entry.tokens > config.memory.softLimitTokens).length } }); }, 'memory-compact');
scheduler.add(config.mcp.healthCheckCron, () => mcp.reconcile(), 'mcp-health');
// provider-health 不在这里注册，它要用 `rebuildModels`（见那一行）。
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
// **开着的开关 + 空规则表 = 门开着。** `approval.rules` 默认 `[]`，而 `ApprovalRules.evaluate()`
// 在规则表为空时恒回 `{needed:false}` —— 于是 `TOOL_POLICY` 里标 `conditional` 的六个工具
// （bash / python / write_file / edit_file / move_file / memory_write）在开箱配置下对 trusted
// 用户完全不经审批，而面板显示「审批已启用」、docs/05 的工具表写着「条件审批」（docs/27 · S-02）。
// 按 docs/16 §5「摘除比伪造安全」：宁可明说门是开的，也不替运维默认一份他没写过的高危规则。
else if (!config.approval.rules.length) {
  const conditional = Object.entries(TOOL_POLICY).filter(([, policy]) => policy.approval === 'conditional').map(([name]) => name);
  log.event({ level: 'warn', kind: 'approval.no_rules', summary: `approval.enabled=true 但规则表是空的：${conditional.length} 个 conditional 工具等于 never`, data: { conditional } });
  process.stderr.write(`[approval] 审批已启用但 approval.rules 是空的 —— 0 条规则时 conditional 等于 never，${conditional.join(' / ')} 全部不经审批直接执行。\n`
    + '[approval] 去 WebUI（审批页）加规则，或在 config/config.yaml 的 approval.rules 里写（那里有注释示例）。\n');
}
// 唤醒词在匹配时被静默跳过、或四个开关全关，表现都只是「bot 不理我」——启动时先把它说出来（docs/11 §启动校验）。
const unusableWakewords = rejectedWakewords(config.trigger.wakewords, config.trigger.wakewordMinLength);
if (unusableWakewords.length) log.event({ level: 'warn', kind: 'config.invalid', summary: `${unusableWakewords.length} 条唤醒词不会生效`, data: { rejected: unusableWakewords } });
if (!config.trigger.private && !config.trigger.mention && !config.trigger.reply && !config.trigger.command && config.trigger.wakewords.length === unusableWakewords.length) {
  log.event({ level: 'warn', kind: 'config.invalid', summary: 'No trigger source is enabled; the bot will never respond' });
}
const toolRegistry = new ToolRegistry(log, approval,
  () => { const live = configStore.snapshot(); return { maxRegistered: live.tools.maxRegistered, maxCallsPerTurn: live.tools.maxCallsPerTurn, maxConsecutiveErrors: live.tools.maxConsecutiveErrors, maxOutputBytes: live.tools.exec.maxOutputBytes, defaultTimeoutMs: live.tools.defaultTimeoutMs }; },
  () => configStore.snapshot().approval.rules, plugins, turns);
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
  (reason, role) => alerts.fire('sandbox_unavailable', `沙箱不可用，${role} 的执行请求被拒`, { reason, role }, role),
  // 第六个参数：每一次沙箱执行落一条 `sandbox.run`（docs/10 §2）。沙箱本身不认识 LogSink ——
  // 它是三条工具路径共用的底层，只交出事实。`turnId='adhoc'` 的那些（探测、非轮次调用）没有 trace。
  (run) => log.event({ level: run.ok ? 'info' : 'warn', kind: 'sandbox.run',
    summary: `${run.mode}${run.denied ? ` denied: ${run.denied}` : ` exit ${run.exitCode ?? 'null'}`}`,
    ...(run.turnId === 'adhoc' ? {} : { traceId: run.turnId }), durationMs: run.durationMs,
    data: { mode: run.mode, image: run.image, exitCode: run.exitCode, ms: run.durationMs, ok: run.ok, oom: run.oom, killed: run.killed, truncated: run.truncated, role: run.role, ...(run.denied ? { denied: run.denied } : {}) } }));
// 自撰写工具的注册器。真相在 `custom_tools` 表，进程内那份每次 `reconcile()` 都能重建
// （docs/01 §3.1）；`execMaxTimeoutMs` 单独传是因为它归 `tools.exec`，不在 selfExtend 那一段里。
const customToolRepo = new CustomToolRepository(db);
const customTools = new CustomToolManager(customToolRepo, () => configStore.snapshot().tools.selfExtend, sandbox, log,
  () => configStore.snapshot().tools.exec.maxTimeoutMs);
const sandboxProbe = await sandbox.probe();
if (!sandboxProbe.available && config.sandbox.mode === 'docker') log.event({ level: 'error', kind: 'sandbox.unavailable', summary: sandboxProbe.error ?? 'Docker sandbox unavailable' });
// bot 要到最后才建得起来，而工具在这里就得注册完，所以桥拿的是 getter。**presence 即开关**：
// `available()` 判的就是 `telegram` 在不在，没有 BOT_TOKEN 时这一族工具必须整体不进目录，
// 而不是进了目录再在调用时失败。
let bot: Bot | null = null;
let poller: UpdatePoller | null = null;
const telegramTools = process.env.BOT_TOKEN
  ? new TelegramTools({ bot: () => bot, archive, maxMessageChars: () => configStore.snapshot().output.maxMessageChars, maxMentions: () => configStore.snapshot().output.maxMentions, parseMode: () => configStore.snapshot().output.parseMode, log })
  : null;
// 定时任务（docs/14 §2 Q4）。这里只**建**不**装**：`load()` 要等 bot 起来，否则第一批任务触发时
// `telegram()` 还是 null，只会往日志里写一串 skipped。工具反过来在这里就得拿到 runner。
const scheduledJobs = new ScheduleRepository(db);
const scheduleRunner = new ScheduledJobRunner({
  db, jobs: scheduledJobs, scheduler, context, archive, turns, registry: turnRegistry, concurrency: turnConcurrency,
  quota, memory, tools: toolRegistry, log, plugins, approvals: approval,
  config: () => configStore.snapshot(),
  // **bot 起来之后才非空**：给外层对象会让 runner 里那条 `telegram_unavailable` 的 skip 分支变成
  // 死代码，启动窗口内经 HTTP 手动触发的任务会开一整轮、跑完模型、记完账，最后不提交
  // （docs/28 · L-SCH-01）。
  telegram: () => (bot ? telegramTools : null),
  failures: turnFailures,
  roleOf: (kind, tgId) => principals.roleOf(kind, tgId),
  estimateTurnCost: (inputTokens, key) => modelRegistry.estimate(readAppKv<string>(db, modelAliasKey(key)) ?? perChatConfig(configStore.snapshot(), key).agent.main.modelAlias, inputTokens),
  // 非流式：定时轮次没有 Telegram 流消费者，也没人盯着屏幕等增量。其余依赖与 `onTurn` 完全一致。
  runAgent: (turn, reservation) => { const live = turn.config as Readonly<typeof config>; return runMainAgent(turn, { config: live, db, registry: modelRegistry, tools: toolRegistry,
    prompts: promptAssembler, documents: promptDocuments, skills, plugins, agents, customTools, ledger, context, quota, reservation, log, turns, workspace: resolve(live.sandbox.workspaceDir, turn.chatId) }); },
});
registerBuiltins(toolRegistry, {
  // `tools.fs.allowHostFsForOwner`：owner 的 fs 工具 jail 到 `/` 而不是本会话 workspace。
  // 这是 docs/14 T8 那条取舍的**显式**开关：开了之后任何能让 owner 的轮次执行工具的注入路径
  // 都是完整的机器读写权限。默认关，`denyGlobs` 照样生效（它是绝对路径 glob，不依赖 root）。
  // 判据用工具执行上下文里的有效角色 —— owner 在非受信群里已经被抿平成群角色（D9），
  // 所以「owner 在陌生群里被诱导读 /etc/shadow」走不到这条路。
  // `base` 恒为 workspace：绝对路径能到整机（这个开关的本意），而模型写出来的相对路径仍然是
  // 「我的工作目录」—— 后者才是它实际写出来的形态（docs/28 · L-TOOL-02）。非 host-fs 模式下
  // base 就等于 root，行为一个字不变。
  db, filesFor: (workspace, role) => new FileTools(
    new PathJail(role === 'owner' && configStore.snapshot().tools.fs.allowHostFsForOwner ? '/' : workspace,
      [...config.tools.fs.denyGlobs, ...selfAuthoringDenyGlobs({ skillsDir: config.skills.dir, pluginsDir: config.plugins.dir })], { base: workspace }),
    config.tools.fs.maxReadBytes, config.tools.fs.maxWriteBytes, { showHidden: config.tools.fs.showHidden, trashDir: config.tools.fs.trashDir, backupDir: config.tools.fs.backupDir }),
  sandbox, archive, context, memory, skills, agents, models: modelRegistry, ledger, log, quota,
  maxWebBytes: config.tools.web.maxResponseBytes, maxAsksPerRun: config.agent.maxAsksPerRun,
  web: { timeoutMs: config.tools.web.timeoutMs, retries: config.tools.web.retries },
  webSearch: { provider: config.tools.web.searchProvider, apiKey: config.tools.web.searchApiKey },
  telegram: telegramTools,
  // 没有投递通道时这三个工具整体不进目录：排一个到点发不出去的任务是纯粹的假承诺。
  schedule: { jobs: scheduledJobs, runner: scheduleRunner, deliverable: () => telegramTools !== null },
});
registerAuthoringTools(toolRegistry, { customTools, skills, plugins, reservedSkills: BUNDLED_SKILLS,
  mcp: { db, config: () => configStore.snapshot(), apply: (next, keys) => configStore.replace(next, keys), emit: (keys) => events.emit('config.changed', { keys }) } });
plugins.bindRegistry(toolRegistry);
mcp.bindRegistry(toolRegistry);
customTools.bindRegistry(toolRegistry);
await plugins.reconcile();
await mcp.reconcile();
// 自撰写的工具**最后注册**：重名时先注册的赢（`registerExternal` 拒绝跨来源覆盖），让运维显式
// 配的 plugin / MCP 压过模型自己造的那份，方向是 fail-safe。
customTools.reconcile();
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
  // 群名也从这一行取：RUNTIME 的「会话」行要它，而预览必须逐字等于下一轮真正发出去的那一份。
  const principal = db.prepare("SELECT chat_type AS chatType, display_name AS title FROM principals WHERE kind='chat' AND tg_id=?").get(contextRow.chatId) as { chatType: string | null; title: string | null } | undefined;
  const live = perChatConfig(configStore.snapshot(), key);
  const snapshot = context.materialize(key, null, live.context.cacheCommits);
  const turn = {
    turnId: 'webui:prompt-preview', key, chatId: contextRow.chatId, threadId: contextRow.threadId,
    initiatorUserId: latest?.userId ?? contextRow.chatId, effectiveRole: role,
    isPrivate: principal?.chatType ? principal.chatType === 'private' : !contextRow.chatId.startsWith('-'),
    baseCommitId: null, snapshot, delta: [], abortSignal: new AbortController().signal, config: live,
    ...(principal?.title ? { chatTitle: principal.title } : {}),
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
// 这个任务此前只调 `rebuild()`：一次探测都不发，于是「上游连上了但不返回」没有任何一处会记住，
// 链首每一步都要重新熬满 `(maxRetries+1) × requestTimeoutMs`（logs/2026-08-18 的三轮各 363 秒，
// 最后全部以「这一轮太久没有进展」收尾）。现在照 `docs/04 §5.3` 真的探一遍。
// 走 `rebuildModels()` 而不是裸 `rebuild()`：那条尾巴还管 `all_providers_down` 与 `log.setSecrets`。
// **注册点必须在 `rebuildModels` 之后**：cron 是构造即排期，而上面那几个 `await`（sandbox.probe
// 要拉 docker）足够让它在 `const rebuildModels` 求值之前就到点 —— 那一次会以 TDZ 的
// ReferenceError 收场，只在 `scheduler.failed` 里留一行，健康检查静静少跑一轮。
scheduler.add(config.provider.healthCheckCron, async () => {
  // **先 rebuild 再探。** `#probes` 是上一次 rebuild 的产物：反过来的话，刚过完 30 分钟冷却、
  // 这一轮才被放回链里的那个 provider 探不到（`probeCandidate` 返回 null → 整个跳过），它会带着
  // 上一次的判定承接一整个 cron 间隔的真实流量。探完再 rebuild 一次是因为探测本身会改状态
  // （新判死的要出链、探回 up 的要进链）—— 这一次也顺带管 `all_providers_down` 与 `log.setSecrets`。
  rebuildModels();
  const outcomes = await runProviderHealthCheck({ db, models: modelRegistry, log, keyFor: (providerId) => { try { return providers.key(providerId); } catch { return null; } } },
    { timeoutMs: PROVIDER_PROBE_TIMEOUT_MS, failuresToDown: PROVIDER_FAILURES_TO_DOWN });
  rebuildModels();
  log.event({ level: 'info', kind: 'provider.health', summary: 'Provider registry health refreshed',
    data: { aliases: modelRegistry.aliases(), probed: outcomes.length, down: outcomes.filter((outcome) => outcome.state === 'down').map((outcome) => outcome.name) } });
}, 'provider-health');
// `shutdown` 要关它，所以它比那一块更早。
const eventStreams = new EventStreamRegistry();
/**
 * **关停 / 重启 / 崩溃处理器必须排在 HTTP 开始监听之前。** 此前它们排在 `main.ts` 末尾，而
 * `serve()` 在八十行之上就已经在听了，于是有一个从「/api/health 回 ok」到这里的窗口
 * （实测 1.0–1.1 秒，Telegram 慢时更长，`await createTelegramBot` 就在里面）：
 *
 * - 窗口内 `POST /api/restart` 打进来 → `restart` 还在 TDZ 里 → `ReferenceError` 裸崩，
 *   而 `uncaughtException` 也还没挂上，于是没有 `system.crash`、没有优雅关停、没有 WAL
 *   checkpoint，日志里一个字都不落（docs/28 · L-OPS-02，复现 2/2）。
 * - 同一个窗口里 `process.once('SIGTERM')` 也还没挂上。
 *
 * 所以顺序是：先把这一整块装好，再 `createServer` / `serve`。`http` 因此必须是 `let` ——
 * 换成 `const` 排在下面的话，TDZ 只是从 `restart` 挪到了 `http` 上。
 */
let http: ReturnType<typeof serve> | null = null;
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
  // 绑成局部 const：`http` 现在是 `let`（见上面那段注释），闭包里 TS 收窄不住它。
  const listening = http;
  if (listening) {
    listening.close(() => markClosed());
    force = setTimeout(() => { if ('closeAllConnections' in listening) listening.closeAllConnections(); markClosed(); }, config.general.shutdown.graceMs); force.unref?.();
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
  // 锁最后才放：库关完了才轮到下一个实例进来。留着不放也只是让下一次启动多走一次 stale 接手，
  // 不会把人锁在外面（`acquireInstanceLock` 判的是 PID 还活着没有）。
  instanceLock.lock.release();
  process.exitCode = 0;
};
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
// 一次 uncaught 的流错误可以直接带走进程，而日志里一个字都不留 —— 上一次排查只能靠翻数据库
// 猜「最后一条 turn.start 之后发生了什么」。所以崩之前必须留下原因。
//
// **stderr 先写、`log.event` 后调、`process.exit` 最后。** 原先是反的，于是整个处理器
// 依赖「log.event 不会抛」这条当时并不成立的假设：`insertLog` 曾是裸的，库满/被锁/已 close
// 时它抛出来，这个处理器自己变成新的 uncaughtException —— 原因没留下，退出码也没设上。
// sink 侧现在也不抛了（`LogSink.event` 入库失败返回 0），但顺序不该赌另一个文件的实现细节。
const fatalDetail = (error: unknown): string => (error instanceof Error ? error.stack ?? error.message : String(error));
const fatalSummary = (event: string, error: unknown): string => `${event}: ${error instanceof Error ? error.message : String(error)}`;
process.on('uncaughtException', (error: unknown) => {
  const detail = fatalDetail(error);
  process.stderr.write(`[crash] uncaughtException: ${detail}\n`);
  // `system.crash` 在 LogSink 里被标成 urgent（appendFileSync 立刻落盘），所以这一行在
  // 下面那个 exit 之前是真的写完了的，不是靠 200ms 的缓冲定时器。
  log.event({ level: 'error', kind: 'system.crash', summary: fatalSummary('uncaughtException', error), data: { event: 'uncaughtException', detail } });
  process.exit(1);
});
/**
 * **unhandledRejection 不退出。**
 *
 * 上一版这两个共用一个处理器、一律 `exit(1)`。代价在 2026-08-18 兑现了两次：`runtime.ts` 那条
 * `final` 链有一个「创建之后、`bot.ts` 挂上 catch 之前」的窗口（`consume` 开头要等
 * `sendChatAction`，实测 561ms），上游一次 0 步返回落在窗口里，**一条私聊里泄漏的一个 promise
 * 就把整个进程带走了** —— 连带杀掉当时所有并发轮次，`bot.ts` 那三处 catch 一次都没跑到，
 * `model.error` 也来不及写，事后只能靠 `turns` 表里两行 `process_restarted` 反推。
 *
 * 那个窗口已经堵上了（`void final.catch(...)`），但「一个悬着的 promise = 整个进程」这条兑换率
 * 本身就不该存在：rejection 是**某一次调用**的失败，不是进程级不可恢复状态（那是
 * `uncaughtException` 的语义）。所以这里只留证据、不退出；轮次侧该记 failed 的自有它自己的路。
 */
process.on('unhandledRejection', (error: unknown) => {
  const detail = fatalDetail(error);
  process.stderr.write(`[unhandled] unhandledRejection: ${detail}\n`);
  log.event({ level: 'error', kind: 'system.unhandled_rejection', summary: fatalSummary('unhandledRejection', error), data: { event: 'unhandledRejection', detail } });
});

// webhook 模式整体没有实现（docs/11 §2.0.1）。**判在 HTTP 监听之前** —— 它排在下面 Telegram
// 那一段里的时候，`/api/health` 已经回了一整个窗口的 ok，而这个进程接下来就要死。
if (process.env.BOT_TOKEN && config.telegram.mode !== 'polling') {
  throw new Error(`telegram.mode=${config.telegram.mode} is not implemented; only polling is supported`);
}
const server = createServer({ config: configStore, db, operations, principals, archive, context, providers, modelCatalog, approvals: approval, rebuildModels, maintenance, ledger, restart: (reason) => restart(reason), events, log,
  memory, promptDocuments, skills, plugins, mcp, agents, tools: toolRegistry, customTools: customToolRepo, customToolManager: customTools, turnRegistry, sandbox, eventStreams, previewPrompt, dryRunAgent,
  schedules: { jobs: scheduledJobs, runner: scheduleRunner }, configSchema: configJsonSchema(), startedAt, setup });
// `webui.enabled=false`：整个 HTTP 面不监听。这不只是省一个端口 —— 单口令 + owner 全权限的
// 控制台是这个部署最大的攻击面，只跑 Telegram 的场景该能把它整个关掉。
// 代价要说清楚：**没有 WebUI 就没有审批裁决通道**，命中审批规则的调用会被当场拒绝
// （`EventBus.channelCount === 0`，docs/24 · R-APPR-01）。
http = config.webui.enabled ? serve({ fetch: server.fetch, hostname: config.webui.host, port: config.webui.port }) : null;
if (!config.webui.enabled) log.event({ level: 'warn', kind: 'webui.disabled', summary: 'WebUI disabled by config; approvals will be rejected outright' });
events.subscribe((event) => {
  if (event.type !== 'config.changed') return;
  // 载荷形状与它的理由在 `packages/core/src/events.ts` 的 `ConfigChangedEvent`。
  const changed = event.data as { keys?: string[]; reconciled?: readonly string[] };
  const keys = changed.keys ?? [];
  const reconciled = changed.reconciled ?? [];
  void loadConfig({ overrides: envOverlay(readPersistedConfig(config.db.path, reportRejectedKey)), onInvalidOverride: (dropped, reasons) => log.event({ level: 'error', kind: 'config.invalid', summary: `已忽略 ${dropped.length} 条非法覆盖`, data: { dropped, reasons } }) }).then((next) => {
    configStore.replace(next, keys);
    if (keys.some((key) => key.startsWith('logs.level'))) log.setLevel(next.logs.level);
    if (keys.some((key) => key.startsWith('logs.redactPatterns'))) log.redactPatterns = next.logs.redactPatterns;
    if (keys.some((key) => key.startsWith('provider.') || key.startsWith('model') || key === 'tools.web.searchApiKey')) rebuildModels();
    // `agentsDir` 也要触发重扫：改了目录却还用着旧目录扫出来的定义，是最难查的一种「没生效」。
    // 写成两个显式判据而不是 `startsWith('agent.agents')` —— 后者顺带匹配上 `agentsDir` 是巧合，
    // 而巧合会在下一次改键名时安静地失效。
    if (keys.some((key) => key === 'agent.agentsDir' || key.startsWith('agent.agents.') || key === 'agent.agents')) agents.replaceDefinitions(scanAgents(next));
    if (keys.some((key) => key.startsWith('skills.'))) skills.scan();
    if (keys.some((key) => key.startsWith('plugins.'))) void plugins.reconcile();
    // McpManager 现在按 getter 读配置，但连接是有状态的：改了 servers 必须重跑一次 reconcile
    // 才会真的连上/断开（docs/20 · W-CFG-02）。
    // `reconciled` 里带 'mcp' 的是 WebUI 的 `/api/mcp*` —— 那几个端点自己 `await` 了一次
    // reconcile（响应里要给出真实 state），这里再跑就是两条重叠（docs/28 · L-EXT-03）。
    // 模型侧的 `install_mcp` 不带这个标记，仍由这一行负责。
    if (!reconciled.includes('mcp') && keys.some((key) => key.startsWith('mcp.'))) void mcp.reconcile();
    // `tools.selfExtend` 在 `HOT_RELOADABLE_CONFIG_KEYS` 里，靠的就是这一行：关掉
    // `customTools.enabled` 之后下一轮那批工具要真的从目录里消失，而不是等重启（docs/20 · W-CFG-02）。
    if (keys.some((key) => key.startsWith('tools.selfExtend'))) customTools.reconcile();
    log.event({ level: 'info', kind: 'config.changed', summary: 'Runtime configuration reloaded', data: { keys } });
  }).catch((error) => log.event({ level: 'error', kind: 'config.invalid', summary: error instanceof Error ? error.message : String(error) }));
});
log.event({ level: 'info', kind: 'system.start', summary: `${config.general.name} started`, data: { name: config.general.name, webui: `${config.webui.host}:${config.webui.port}`, providerSecrets: secrets.available } });
if (process.env.BOT_TOKEN) {
  /**
   * **`bot.init()` 的 401 要接住，不能让它从这个顶层 await 逃出去。**
   *
   * 换 token / token 被撤销是常规运维动作，而撞上之后异常从这里逃逸 → 进程反复起不来 ——
   * 偏偏**你恰恰需要 WebUI 才能改 token**。这违背 `main.ts` 自己在缺 `main` 别名那里确立的
   * 原则（只警告、不 fatal，好让 WebUI 还能进去改）。`BOT_TOKEN` **缺失**一直是被正确处理的，
   * **失效**却无人接，两条路不一致（docs/28 · L-OPS-03）。
   *
   * 与 `poller.onFatal` 的分工：那一条只覆盖**轮询**阶段（进程已经跑起来之后 token 被撤销），
   * 这一条覆盖**启动**阶段。前者优雅关停并退出码 1 让 supervisor 重启是对的；后者不能退，
   * 退了就没有能改 token 的地方了。
   */
  try {
    bot = await createTelegramBot(process.env.BOT_TOKEN, { config: configStore, db, principals, archive, operations, context, turns, quota, memory, plugins, tools: toolRegistry, approvals: approval,
      registry: turnRegistry, concurrency: turnConcurrency, log, alerts, failures: turnFailures, issueLoginToken: () => issueLoginToken(),
      // 关停期间被 abort 的长轮询记 info 而不是 error（docs/28 · L-TG-01）。
      stopping: () => shuttingDown,
      estimateTurnCost: (inputTokens, key) => modelRegistry.estimate(readAppKv<string>(db, modelAliasKey(key)) ?? perChatConfig(configStore.snapshot(), key).agent.main.modelAlias, inputTokens),
      // 用 turn.config 而不是全局快照：本轮的 perChat 覆盖已经在 openTurn 时合并进去了。
      onTurn: (turn, reservation) => { const live = turn.config as Readonly<typeof config>; return streamMainAgent(turn, { config: live, db, registry: modelRegistry, tools: toolRegistry,
        prompts: promptAssembler, documents: promptDocuments, skills, plugins, agents, customTools, ledger, context, quota, reservation, log, turns, workspace: resolve(live.sandbox.workspaceDir, turn.chatId) }); } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.event({ level: 'error', kind: 'tg.error', summary: `Telegram 入口启动失败：${message}`, data: { phase: 'init', fatal: false } });
    process.stderr.write(`[telegram] 建不起 bot（token 失效、被撤销，或网络不通）：${message}\n`
      + `[telegram] Telegram 入口已禁用，WebUI 照常启动 —— 去 http://${config.webui.host}:${config.webui.port} 换掉 BOT_TOKEN 再重启。\n`);
  }
}
if (bot) {
  // `dropPendingOnStart`：停机期间积压的 update 直接丢掉，不补跑。默认关 —— 丢的是真实用户
  // 发过的消息。开它的场景是长时间停机后重启，不想让 bot 对着一小时前的话题连开几十轮。
  //
  // 不用 grammY 的 `bot.start()`：它逐条串行处理 update，`TurnConcurrency` 因此永远争用不到
  // （第二个人得等第一个人整轮跑完，docs/01 §3 的 global / perKey / queueMax 形同虚设）。
  // 在途上限取 `global + queueMax`：超出这个数再拉进来的轮次也只会被 `acquire` 顶回去。
  {
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
  }
  // owner 私聊通道到这里才具备。`sendMessage` 失败由 AlertDispatcher 自己吞掉并记一条
  // `alert.deliver_failed` —— owner 没跟 bot 说过话时 Telegram 会拒发，那不该把告警链路带崩。
  const ownerChatId = configStore.snapshot().access.bootstrapOwnerId;
  if (ownerChatId) notifyOwner = (text) => bot!.api.sendMessage(ownerChatId, text);
  // 到这里投递通道才具备，定时任务可以装回 cron 了。停机期间错过的不补跑，只在日志里说出来
  // （需求方决策；`load()` 每条错过的任务记一条 schedule.missed）。
  const loaded = scheduleRunner.load();
  log.event({ level: 'info', kind: 'schedule.loaded', summary: `装载 ${loaded.registered} 个定时任务`, data: { ...loaded, enabled: config.schedule.enabled } });
} else {
  // 缺 token 与 token 失效（上面那个 catch）从这里起走同一条路。
  log.event({ level: 'warn', kind: 'system.start', summary: process.env.BOT_TOKEN ? 'Telegram ingress disabled: bot init failed' : 'BOT_TOKEN missing; Telegram ingress disabled' });
  // 没有 Telegram 就没有投递通道。不装载而不是装载后每次触发失败：库里的任务原样留着，
  // 配上 token 重启就会继续跑。
  const pending = scheduledJobs.listActive().length;
  if (pending) log.event({ level: 'warn', kind: 'schedule.skipped', summary: `${pending} 个定时任务未装载：没有 Telegram 投递通道`, data: { reason: 'telegram_unavailable', pending } });
}
