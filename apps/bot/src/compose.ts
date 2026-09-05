/**
 * 运行时装配：把 `main.ts` 里「建对象、接线、注册」的那一大段收进一个函数。
 *
 * 纯装配，不碰进程生命周期 —— `http` 监听、Telegram 启动块、`process` 信号 / 异常处理器、
 * `shutdown()` 本体都留在 `main.ts`（原欠账 `D-04`，`docs/reviews/27 §8`）。`bot` / `poller` / `notifyOwner`
 * 三者要到 Telegram 启动块跑完才有值，此前多处闭包已经在读它们（审批回执、`TelegramTools` 桥、
 * 定时任务的投递判据），因此改成 `slots` 上的可写字段，由 main.ts 在建完 bot 之后回填。
 *
 * `probeSandbox` / `reconcileExtensions` 两个开关只为测试装置存在：`tests/support/runtime.ts`
 * （T1.2）要在没有 docker、没有真实 plugin / MCP 网络的环境下反复装起一份可用的运行时，
 * 默认都为真，生产路径（`main.ts`）不传即为原行为。
 */
import type { Bot } from "grammy";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  ApiKeyRepository,
  ArchiveRepository,
  CustomToolRepository,
  OperationsRepository,
  PrincipalRepository,
  McpAuthRepository,
  SandboxContainerRepository,
  ScheduleRepository,
  SdkSessionRepository,
  SourceRepository,
  TurnRepository,
  modelAliasKey,
  readAppKv,
  type CrashRecovery,
  type Sqlite,
} from "@luoli/db";
import {
  AcpManager,
  AcpRunRecorder,
  AgentManager,
  AgentResultStore,
  AlertDispatcher,
  BUNDLED_SKILLS,
  ConfigStore,
  ContainerManager,
  CustomToolManager,
  ContextEngine,
  DatabaseApprovalBroker,
  EventBus,
  FileTools,
  LogSink,
  MaintenanceService,
  McpManager,
  MemoryStore,
  ModelCatalog,
  ModelRegistry,
  PathJail,
  PendingAuthorizations,
  PendingPrompts,
  PluginManager,
  selfAuthoringDenyGlobs,
  PromptAssembler,
  PromptDocuments,
  ProviderStore,
  PROVIDER_FAILURES_TO_DOWN,
  PROVIDER_PROBE_TIMEOUT_MS,
  QuotaGuard,
  runProviderHealthCheck,
  Sandbox,
  ScheduledJobRunner,
  Scheduler,
  Secrets,
  SkillLoader,
  STABLE_PROMPT_BLOCKS,
  TOOL_POLICY,
  ToolRegistry,
  TurnConcurrency,
  TurnFailureStreak,
  TurnRegistry,
  UsageLedger,
  WebAssetStore,
  assembleMainPrompt,
  canSeeImages,
  captureImage,
  configJsonSchema,
  highlight,
  perChatConfig,
  registerAuthoringTools,
  registerBuiltins,
  registerCatalogTools,
  registerContainerTools,
  rejectedWakewords,
  runMainAgent,
  runLwWorker,
  tagged,
  type AgentKind,
  type AgentResultRefRepair,
  type Config,
  type ContainerEvent,
  type LedgerCacheCostRepair,
  type LwWorkerRuntimeEvent,
} from "@luoli/core";
import {
  createServer,
  EventStreamRegistry,
  setupToken,
  type PromptPreviewResult,
} from "@luoli/server";
import type { RuntimeTurnContext } from "@luoli/shared";
import {
  TelegramPromptChannel,
  TelegramTools,
  UpdatePoller,
  approvalSettledText,
} from "@luoli/telegram";

export interface RuntimeSlots {
  bot: Bot | null;
  poller: UpdatePoller | null;
  notifyOwner: ((text: string) => Promise<unknown>) | null;
}

export interface ComposeRuntimeInput {
  config: Readonly<Config>;
  configStore: ConfigStore;
  db: Sqlite;
  startedAt: number;
  /** 子 agent 结果文件根目录，main.ts 在调用前算好（跟随 `LUOLI_DATA_DIR`，docs/28 · L-OPS-06）。 */
  agentResultsDir: string;
  /** 三项启动期一次性修复的结果，main.ts 已经用 stdout 报过一遍，这里只补记结构化日志。 */
  startup: {
    recovered: CrashRecovery;
    ledgerRepair: LedgerCacheCostRepair | null;
    resultRefs: AgentResultRefRepair | null;
  };
  /** WebUI「重启进程」与 SIGTERM 等走的是同一条优雅关闭路径，实现留在 main.ts。 */
  restart: (reason: string) => Promise<void>;
  /** 测试关：跳过 `sandbox.probe()`（拉 docker）。 */
  probeSandbox?: boolean;
  /** 测试关：跳过 plugins / mcp 的 reconcile（网络与子进程）。 */
  reconcileExtensions?: boolean;
}

export async function composeRuntime(input: ComposeRuntimeInput) {
  const {
    config,
    configStore,
    db,
    startedAt,
    agentResultsDir,
    startup,
    restart,
    probeSandbox = true,
    reconcileExtensions = true,
  } = input;

  const principals = new PrincipalRepository(db);
  principals.ensureOwner(config.access.bootstrapOwnerId);
  const archive = new ArchiveRepository(db);
  const operations = new OperationsRepository(db);
  const turns = new TurnRepository(db);
  // `sources` 的种子行（`telegram`）由 0019 迁移写入，这里只建仓储不建行。SDK 密钥的签发/校验
  // 在 `packages/core/src/sdk/keys.ts`（T3.3），这两个仓储只负责落库与查询。
  const sources = new SourceRepository(db);
  const apiKeys = new ApiKeyRepository(db);
  const sdkSessions = new SdkSessionRepository(db);
  // EventBus 要早于 quota / log 建：这两个是 SSE 上 `quota` 与 `log` 事件的发源地，
  // 少给一个的表现就是那一类事件永远不到（docs/21 · G-SSE-01）。
  const events = new EventBus();
  const quota = new QuotaGuard(db, config.general.timezone, events);
  const secrets = new Secrets(process.env.LUOLI_MASTER_KEY);
  // scrypt 抬高了离线爆破成本，但抬不动一个短口令（docs/20 · W-SEC-02）。
  if (secrets.weak)
    process.stderr.write(
      tagged(
        "warn",
        "[secrets] LUOLI_MASTER_KEY 短于 32 字符：provider key 的加密强度取决于它，建议换成 32 字节随机值。\n",
      ),
    );
  const providers = new ProviderStore(db, secrets);
  // 只在 WebUI 主动拉取模型时才可能出网；缓存命中的路径不碰网络（docs/04 §5.4.1）。
  const modelCatalog = new ModelCatalog(db, () => ({
    ...configStore.snapshot().provider.catalog,
    allowPrivate: configStore.snapshot().provider.allowPrivateBaseUrl,
  }));
  const ledger = new UsageLedger(db);
  const turnRegistry = new TurnRegistry();
  const turnConcurrency = new TurnConcurrency(config.concurrency);
  const log = new LogSink(
    operations,
    [process.env.BOT_TOKEN ?? "", process.env.LUOLI_MASTER_KEY ?? ""],
    { level: config.logs.level, console: config.logs.console, events },
  );
  log.redactPatterns = config.logs.redactPatterns;
  operations.compressLogPayloads = config.logs.compress;
  // 两条修复都发生在 sink 之前，所以补记在这里 —— stdout 那两行只有盯着终端的人看得见，
  // 而「上一次崩溃 reap 了什么」正是事后才会有人来查的东西（docs/28 · L-OPS-04）。
  if (
    startup.recovered &&
    Object.values(startup.recovered).some((count) => count > 0)
  )
    log.event({
      level: "warn",
      kind: "system.recovered",
      summary: `上一个进程非正常退出：标记失败 ${startup.recovered.turns} 条轮次`,
      data: startup.recovered,
    });
  if (startup.ledgerRepair?.rewritten)
    log.event({
      level: "warn",
      kind: "maintenance.repair",
      summary: `已按新计价口径重算 ${startup.ledgerRepair.rewritten} 条用量`,
      data: startup.ledgerRepair,
    });
  // resultRefs 的补记与上两项同一批：三项启动期修复的结果都只在这里落一次结构化日志。
  if (startup.resultRefs?.foreign)
    log.event({
      level: "warn",
      kind: "maintenance.repair",
      summary: `${startup.resultRefs.foreign} 行子 agent 结果路径指向另一个部署根`,
      data: startup.resultRefs,
    });
  // 告警要早于沙箱、plugin、模型注册表建起来：那三处的构造参数里就挂着告警回调。
  // owner 私聊在 bot 建好之后再补（`alerts.bindOwner`），此前只走 webhook 与日志。
  const slots: RuntimeSlots = { bot: null, poller: null, notifyOwner: null };
  const alerts = new AlertDispatcher(
    () => configStore.snapshot().alerts,
    log,
    {
      owner: async (text: string) => {
        await slots.notifyOwner?.(text);
      },
    },
    () => configStore.snapshot().provider.allowPrivateBaseUrl,
  );
  // 日志自己写不进去时也要有人知道 —— 只写 stderr 的话运维通常永远看不到（docs/10 §6 db_write_failed）。
  log.onWriteFailure = (error) =>
    alerts.fire("db_write_failed", "日志写入失败", {
      error: error instanceof Error ? error.message : String(error),
    });
  // 连续失败计数只此一份：Telegram 轮次与定时轮次记在同一个计数器上，否则「上游变黑洞」在
  // 没人聊天的部署里一次告警都不响，两份各卡在 4 次（docs/28 · L-SCH-02）。
  const turnFailures = new TurnFailureStreak(alerts);
  const context = new ContextEngine(db, archive, log);
  const modelRegistry = new ModelRegistry(db, providers, (providerId, reason) =>
    log.event({
      level: "warn",
      kind: "provider.health",
      summary: `provider ${providerId} 已跳过：${reason}`,
      data: { providerId, reason },
    }),
  );
  modelRegistry.rebuild(config.provider.healthDownCooldownMinutes);
  log.setSecrets([
    process.env.BOT_TOKEN ?? "",
    process.env.LUOLI_MASTER_KEY ?? "",
    config.tools.web.searchApiKey,
    ...providers.allDecryptedKeys(),
  ]);
  // 零配置首启本来就没有 main 别名，拒绝启动会把补配置用的 WebUI 一起带走（docs/04 §5.2）。
  // 缺 main 只告警：轮次会在 streamMainAgent 里失败，WebUI 写入别名后 rebuildModels() 即时生效。
  if (!modelRegistry.aliases().includes("main")) {
    log.event({
      level: "error",
      kind: "config.invalid",
      summary: "Required model alias main is unavailable",
    });
    process.stderr.write(
      tagged(
        "error",
        "[config] 缺少必需的 main 模型别名：服务仍会启动，但所有轮次都会以 model alias unavailable 失败。\n" +
          `[config] 请在 WebUI（http://${config.webui.host}:${config.webui.port} → Provider 页）配置 provider / 模型 / main 别名，保存后即时生效，无需重启。\n`,
      ),
    );
  }
  const memory = new MemoryStore(
    db,
    config.memory.dir,
    config.memory.softLimitTokens,
    config.memory.hardLimitTokens,
    config.memory.maxSections,
    log,
  );
  // 第四个参数：扫描结果真的变了才广播。没有它，扩展页只能靠 `health` 事件顺带刷新 ——
  // 从 Telegram 装进来的东西要等下一次健康检查才出现（docs/21 §9 · G-EXT-05）。
  // 第五个参数是 `LogSink`：`scan()` 的 per-skill catch 此前只写 `skills.load_error` 那一列，
  // 「我加的那个 skill 为什么不存在」在日志里一个字都没有（docs/28 · L-LOG-01）。
  const skills = new SkillLoader(
    db,
    config.skills.dir,
    () => configStore.snapshot().skills.defaultMinRole,
    () => events.emit("extensions.changed", { kind: "skill" }),
    log,
  );
  // `skills.enabled=false` 时不扫盘也不监听：目录里的 SKILL.md 一个都不进工具目录。
  // 关掉是整块关掉，而不是「扫出来但不给用」—— 后者会让工具目录里多出一批点不动的名字。
  if (config.skills.enabled) skills.scan();
  else
    log.event({
      level: "info",
      kind: "skills.disabled",
      summary: "Skills disabled by config",
    });
  // 一份常量供两处用：写入方（AgentResultStore）与清理方（MaintenanceService.gcFiles）指向
  // 不同目录时，gc 会把整棵结果目录当成孤儿删空。
  // 跟着 `LUOLI_DATA_DIR` 走，和 `db.path` / `media.dir` 同一处（config/index.ts 的 envLayer）。
  // 三者指向不同部署时 `gcFiles()` 会把别人的数据当孤儿删掉（docs/25 §10）。
  // 这个值只用来**定位目录**：库里那一列存的是相对它的 ref（`AgentResultStore.put`）。
  // 此前存的是 `resolve()` 出来的绝对路径，于是「同一次运行内两处指向不同目录」防住了，
  // 而**时间性**错配没防住 —— 无 `LUOLI_DATA_DIR` 时它绑定的是启动那一刻的 cwd，换个目录
  // 起一次进程，库里记的就是旧根、文件在新根，gc 把新根下的全文整批当孤儿删掉（docs/28 · L-OPS-06）。
  const agents = new AgentManager(
    db,
    new AgentResultStore(agentResultsDir),
    config.agent.maxWorkersPerTurn,
  );
  if (config.skills.enabled && config.skills.watch) skills.startWatching();
  // 第八个参数是 `LogSink`：单次钩子失败此前完全静默（要累计到 `autoDisableAfterErrors` 才经告警
  // 落一行，而那一行还受 `alerts.on` 默认 `[]` 与 `dedupeMinutes` 管）—— 实测一个三轮必抛的
  // `beforeTurn`，与 plugin 有关的日志 0 条（docs/28 · L-LOG-01）。
  const plugins = new PluginManager(
    db,
    config.plugins.dir,
    config.plugins.hookTimeoutMs,
    config.plugins.autoDisableAfterErrors,
    config.plugins.order,
    undefined,
    (name, error) =>
      alerts.fire(
        "plugin_auto_disabled",
        `plugin ${name} 连续出错已被自动禁用`,
        { plugin: name, error },
        name,
      ),
    log,
  );
  // `plugins.enabled=false` 时不 reconcile：一个 plugin 都不加载，钩子链是空的。
  // 「进程内全信任」（docs/14 A27）意味着这个开关是安全边界，不是性能开关。
  if (config.plugins.enabled) {
    if (reconcileExtensions) await plugins.reconcile();
    // 「装得像成功了、实际一直跑旧代码」是最贵的一种沉默：tsx 下 reload 每一次都回 ok
    // （docs/28 · L-EXT-04）。修不了就在启动时说出来，与 reload 端点同一句话。
    if (plugins.hotReloadWarning) {
      // kind 用单数 `plugin.` 前缀：`CATEGORY_BY_PREFIX` 只认这一个，复数会掉进 turn.jsonl。
      log.event({
        level: "warn",
        kind: "plugin.hot_reload_unreliable",
        summary: "当前运行时下 plugin 热重载不可靠：重载返回成功但仍执行旧代码",
        data: { entry: process.argv[1] ?? null },
      });
      process.stderr.write(
        tagged("warn", `[plugins] ${plugins.hotReloadWarning}\n`),
      );
    }
    // `plugins.watch`：目录变动后重新 reconcile。默认关 —— 热加载一个全信任的 JS 文件，
    // 风险面比省一次重启大得多，开它要自己清楚这一点。
    if (config.plugins.watch) plugins.startWatching();
  } else
    log.event({
      level: "info",
      kind: "plugins.disabled",
      summary: "Plugins disabled by config",
    });
  // MCP 的凭据库与待授权表。`publicUrl` 传 getter 而不是快照：运维在设置页补完它之后
  // 不该还要重启才登得上（照 `configStore.snapshot()` 在这一行上下的一贯做法）。
  const mcpAuth = new McpAuthRepository(db, secrets);
  const mcpPending = new PendingAuthorizations();
  const mcp = new McpManager(
    db,
    () => configStore.snapshot().mcp,
    log,
    undefined,
    {
      store: mcpAuth,
      pending: mcpPending,
      publicUrl: () => configStore.snapshot().webui.publicUrl,
    },
  );
  if (reconcileExtensions) await mcp.reconcile();
  // M13 · ACP 客户端（`docs/04 §6.2`）。**不吃配置** —— 连接与会话都不缓存，`spawn_acp` 每次调用
  // 从本轮 `turn.config` 现读 `agent.acp` 交给它。所以这里只有日志口与记账口，没有 config getter。
  // `shutdown()` 里紧挨着 `await mcp.close()` 等它（见那一行）。
  // 记账口落的是 `agent_runs` 上的一行：外部花费进 `external_cost_usd`（迁移 0014），`cost_usd`
  // 恒 0 —— 那个数不是我们的钱，**不进 `usage_ledger`、不进配额、不进用量页的聚合**（`acp/runs.ts`）。
  const acp = new AcpManager(log, new AcpRunRecorder(db));
  // `web_fetch` / MCP 抓回来的图片。落在 `media.dir` 之下 —— 跟着同一个目录走，`gcFiles()` 那道
  // 「库与目录来自两套部署」的 fail-closed 守卫才继续适用（docs/25 §10）。
  const webAssets = new WebAssetStore(
    db,
    config.media.dir,
    config.media.maxImageEdge,
  );
  const maintenance = new MaintenanceService(
    db,
    config.db.path,
    config.db.backupKeep,
    config.logs.retentionDays,
    { files: config.media.dir, agentResults: agentResultsDir },
    config.schedule.retentionDays,
    {
      usage: config.maintenance.retention.usageDays,
      quotaCounters: config.maintenance.retention.quotaCounterDays,
      configRevisions: config.maintenance.retention.configRevisionDays,
      memoryRevisions: config.maintenance.retention.memoryRevisionDays,
      media: config.media.retentionDays,
    },
    // `maintenance.*` 由服务自己落，不再由下面那两条 cron 的包装层落 —— 否则从 WebUI 那个入口
    // 跑同一个动作就只剩一条「方法 + 路径」的 webui.action（docs/29 · M-LOG-01）。
    log,
  );
  const scheduler = new Scheduler((name, error) =>
    log.event({
      level: "error",
      kind: "scheduler.failed",
      summary: `${name} failed`,
      data: { error: error instanceof Error ? error.message : String(error) },
    }),
  );
  // 两条 cron 都不再自己落日志：`maintenance.cleanup` / `maintenance.vacuum` 由服务内部发，
  // 于是 cron 与 `POST /api/maintenance/:action` 两条路留下的凭据一模一样。
  scheduler.add(
    config.general.maintenanceCron,
    () => void maintenance.cleanup(),
    "maintenance",
  );
  scheduler.add(config.db.vacuumCron, () => maintenance.vacuum(), "vacuum");
  scheduler.add(
    config.memory.compactCron,
    () => {
      log.event({
        level: "info",
        kind: "memory.compact",
        summary: "Memory compaction review scheduled",
        data: {
          pending: memory
            .list()
            .filter((entry) => entry.tokens > config.memory.softLimitTokens)
            .length,
        },
      });
    },
    "memory-compact",
  );
  scheduler.add(
    config.mcp.healthCheckCron,
    () => mcp.reconcile(),
    "mcp-health",
  );
  // provider-health 不在这里注册，它要用 `rebuildModels`（见那一行）。
  const promptAssembler = new PromptAssembler();
  const promptDocuments = new PromptDocuments(db, config.memory.dir);
  promptDocuments.ensure();
  // 审批回执有裁决通道时这一轮会静静挂满 ttlMs，用户看到的是 bot 收了消息然后沉默三分钟
  // （`docs/22 · D-APPR-01`）。bot 要到最后才建得起来，所以这里吃 getter ——`TelegramPromptChannel`
  // 的 presence 就是这条通道的开关（`docs/05 §6.1`）。
  //
  // `decidable` 是这条通道的真判据，而现在它只认一个会话：**owner 私聊**。群内的有效角色封顶
  // `trusted`，`decidableBy:'owner'` 在任何群里都无人可点 —— 不管那个群挂的是什么会话角色。
  // 于是「按发起人会话投递」这条路整条走不通了：按钮贴在群里就是一排点不动的按钮，而
  // `resolve()` 的会话绑定（`waiter.request.chatId === actor.chatId`）会把每一次点击都判成
  // unknown。带按钮的那条因此改发 owner 私聊，发起人会话只留一条纯文本报信（见下面的
  // `notifyInitiator`）；私聊的有效角色就是用户自身的角色，绑定与裁决权在那里天然成立。
  // owner 的私聊 chatId 就是他的 userId，也就是 `bootstrapOwnerId`。
  const approvalPrompts = new PendingPrompts(
    new TelegramPromptChannel({
      bot: () => slots.bot,
      log,
      decidable: (chatId) =>
        chatId === configStore.snapshot().access.bootstrapOwnerId,
    }),
    log,
  );
  // 回执上挂 inline keyboard：**裁决权只给 owner**（`approval.allowInitiator` 已永久摘除，docs/14 A26），按下去走
  // `claim` → `approval.decide(..., 'telegram')`，也就是与 WebUI 共用那句
  // `UPDATE … WHERE state='pending' AND expires_at>?` —— 两条通道之间唯一的原子抢夺点。
  // 带按钮的那条发**owner 私聊**，发起人会话只留一条纯文本报信：群内有效角色封顶 `trusted`，
  // 群里的按钮谁都点不动。`PendingPrompts.ask` 的 `chatId` 同时是投递目标与裁决绑定
  // （`resolve()` 校验 `waiter.request.chatId === actor.chatId`），换成私聊 id 之后两者一起跟着走。
  // 正文不传 `parse_mode`：键盘挂在一条消息上，MarkdownV2 一 400 就会被 `sendWithFallback` 重发一遍，
  // 屏幕上于是有两条各带一套按钮的消息。
  const approval = new DatabaseApprovalBroker(
    db,
    () => configStore.snapshot(),
    events,
    log,
    async (pending) => {
      const bot = slots.bot;
      if (!bot) return;
      const risk =
        pending.risk === "high"
          ? "高风险"
          : pending.risk === "medium"
            ? "中风险"
            : "低风险";
      const seconds = Math.round(pending.ttlMs / 1000);
      const thread =
        pending.threadId === null
          ? {}
          : { message_thread_id: pending.threadId };
      const owner = configStore.snapshot().access.bootstrapOwnerId;
      // 没配 owner 的部署（`loadConfig` 会拒绝启动，但配置热更新后这个值理论上仍可为空）退回原会话：
      // 与 broker 那道可用性闸同一口径，两处必须一起改，否则闸放行的会话与投递的会话不是一个。
      const target = owner || pending.chatId;
      const sameChat = target === pending.chatId;
      // 按钮点不动（`decidable` 为假，即 bot 没起来或 owner 私聊发不了）时**不贴按钮**，只报信 ——
      // 走到这儿说明 WebUI 那条 SSE 通道在，否则上面那道闸已经当场拒了。贴一排点不动的按钮比不贴更糟。
      if (!approvalPrompts.available(target)) {
        await bot.api.sendMessage(
          pending.chatId,
          `⏳ ${pending.tool} 属于${risk}操作，需 owner 在 WebUI 审批页批准。${seconds} 秒内未处理将自动拒绝，我会继续本轮。`,
          thread,
        );
        return;
      }
      // 发起人会话里那条只报信、不带按钮，也**不写倒计时、不带任何状态**：它没有 `settle` 句柄，
      // 收场时无人回来改它 —— 写了倒计时就等于在群里留下一句迟早不成立的话（`docs/21 §12`）。
      if (!sameChat)
        await bot.api
          .sendMessage(
            pending.chatId,
            `⏳ ${pending.tool} 属于${risk}操作，已请求 owner 批准，结果随本轮回复给出。`,
            thread,
          )
          .catch(() => undefined);
      // owner 私聊里那条脱离了原会话上下文：只给工具名的话，他要批的是「哪个群、谁发起、干什么」
      // 三样全不知道。显示名与 id 一起给 —— 显示名是用户自己填的，同名冒充只需改一次昵称。
      const initiatorName = db
        .prepare(
          "SELECT display_name FROM principals WHERE kind='user' AND tg_id=?",
        )
        .pluck()
        .get(pending.requesterUserId) as string | null | undefined;
      const rawInput = JSON.stringify(pending.input);
      const inputLine =
        !rawInput || rawInput === "{}" || rawInput === "null"
          ? ""
          : `入参：${rawInput.length > 300 ? `${rawInput.slice(0, 300)}…` : rawInput}\n`;
      // owner 自己私聊里触发时「来源 / 发起人」两项都是他自己，整行省掉。
      const sourceLine = sameChat
        ? ""
        : `来源：${pending.chatTitle ?? pending.chatId} · 发起人 ${initiatorName ? `${initiatorName}（${pending.requesterUserId}）` : pending.requesterUserId}\n`;
      const handle = approvalPrompts.ask({
        kind: "approval",
        chatId: target,
        // 私聊没有 forum thread，把群的 threadId 带过去 Telegram 直接 400。
        threadId: sameChat ? pending.threadId : null,
        decidableBy: "owner",
        initiatorUserId: pending.requesterUserId,
        text:
          `⏳ ${pending.tool} 属于${risk}操作，需你批准。\n${sourceLine}${inputLine}` +
          `点击下方按钮，或前往 WebUI 审批页。${seconds} 秒内未处理将自动拒绝，我会继续本轮。`,
        options: [
          { id: "approve", label: "批准" },
          { id: "deny", label: "拒绝" },
        ],
        ttlMs: pending.ttlMs,
        claim: (optionId, actor) =>
          approval.decide(
            pending.id,
            optionId === "approve",
            actor,
            "telegram",
          ),
      });
      const posted = await handle.posted;
      // owner 从没跟 bot 说过话时 Telegram 拒发私聊（403）。不改往群里贴按钮 —— 那儿谁都点不动 ——
      // 只补一条说清楚该去哪儿；WebUI 也没通道时由 `#receiptUndeliverable` 当场拒，这条不会发出。
      if (!posted && !sameChat)
        await bot.api
          .sendMessage(
            pending.chatId,
            `⏳ ${pending.tool} 属于${risk}操作，需 owner 在 WebUI 审批页批准。${seconds} 秒内未处理将自动拒绝，我会继续本轮。`,
            thread,
          )
          .catch(() => undefined);
      // `tg_message_id` 落库是为了下次启动能把残留回执收掉（`staleKeyboards`），`tg_chat_id` 与它同写：
      // 回执落在 owner 私聊而 `approvals.chat_id` 是发起人会话，少了这一列那趟扫描会拿群 id 配私聊的
      // message_id。`settle` 让 Telegram 点了 / WebUI 抢先裁决 / TTL 到点 / 轮次取消时那两个按钮当场
      // 消失 —— 留着就是下一次误点 —— **并且把正文换成结局**：上面那句「${seconds} 秒内没人处理就会
      // 自动拒绝」这时已经不成立，让它停在屏幕上就是 `docs/21 §12` 那类「界面在说谎」（`AC-APV-004`）。
      // 撤键盘与改正文合成一次 `editMessageText`（见 `TelegramPromptChannel.settle`），两次调用要排两回
      // 20/分钟 的队。`settle` 交回「那次编辑真落地了吗」——`tg_message_id` 只在为真时才清
      // （待办队列不是历史记录）。
      //
      // `delivered: false`：这条带按钮的回执**发不出去**。上面那道可用性闸是按 owner 私聊点得动才放行的，
      // 所以走到这儿时 Telegram 可能是唯一的通道 —— 由 broker 两边一起判（`#receiptUndeliverable`）。
      return posted
        ? {
            tgChatId: posted.chatId,
            tgMessageId: posted.messageId,
            settle: (outcome) =>
              approvalPrompts.dismiss(
                posted,
                approvalSettledText(pending.tool, outcome),
              ),
          }
        : { delivered: false };
    },
    approvalPrompts,
  );
  if (!config.approval.enabled)
    log.event({
      level: "warn",
      kind: "approval.disabled",
      summary: "Approval flow disabled; dangerous tools execute without review",
    });
  // **开着的开关 + 空规则表 = 门开着。** `approval.rules` 默认 `[]`，而 `ApprovalRules.evaluate()`
  // 在规则表为空时恒回 `{needed:false}` —— 于是 `TOOL_POLICY` 里标 `conditional` 的六个工具
  // （bash / python / write_file / edit_file / move_file / memory_write）在开箱配置下对 trusted
  // 用户完全不经审批，而面板显示「审批已启用」、docs/05 的工具表写着「条件审批」（docs/27 · S-02）。
  // 按 docs/16 §5「摘除比伪造安全」：宁可明说门是开的，也不替运维默认一份他没写过的高危规则。
  else if (!config.approval.rules.length) {
    const conditional = Object.entries(TOOL_POLICY)
      .filter(([, policy]) => policy.approval === "conditional")
      .map(([name]) => name);
    log.event({
      level: "warn",
      kind: "approval.no_rules",
      summary: `approval.enabled=true 但规则表为空：${conditional.length} 个 conditional 工具等同于 never`,
      data: { conditional },
    });
    process.stderr.write(
      tagged(
        "warn",
        `[approval] 审批已启用但 approval.rules 为空：0 条规则时 conditional 等同于 never，${conditional.join(" / ")} 全部不经审批直接执行。\n` +
          "[approval] 请在 WebUI 审批页添加规则，或写入 config/config.yaml 的 approval.rules（其中附有注释示例）。\n",
      ),
    );
  }
  // 唤醒词在匹配时被静默跳过、或四个开关全关，表现都只是「bot 不理我」——启动时先把它说出来（docs/11 §启动校验）。
  const unusableWakewords = rejectedWakewords(
    config.trigger.wakewords,
    config.trigger.wakewordMinLength,
  );
  if (unusableWakewords.length)
    log.event({
      level: "warn",
      kind: "config.invalid",
      summary: `${unusableWakewords.length} 条唤醒词不会生效`,
      data: { rejected: unusableWakewords },
    });
  if (
    !config.trigger.private &&
    !config.trigger.mention &&
    !config.trigger.reply &&
    !config.trigger.command &&
    config.trigger.wakewords.length === unusableWakewords.length
  ) {
    log.event({
      level: "warn",
      kind: "config.invalid",
      summary: "No trigger source is enabled; the bot will never respond",
    });
  }
  // **`concurrency.turnTimeoutMs` 是所有长工具的实际天花板**（`docs/11` 那条已写明，代码侧的告知是
  // 这一轮补的，`docs/14` F13）。ACP agent 配了 15 分钟而轮次上限 10 分钟时，那 15 分钟从来没有机会
  // 生效：轮次先超时 → abortSignal → `session/cancel`，而运维看到的是「我配的是 15 分钟」。
  // 照 `approval.no_rules` 的先例只 warn 不拒启动 —— 这是一个错配而不是一个非法值。
  // 名单里也带上 harness：同一个坑、同一个默认值，而运维踩的是哪一个由配置决定。
  const overlongLongTools = [
    ...config.agent.acp.agents,
    ...(config.agent.harness.timeoutMs > config.concurrency.turnTimeoutMs
      ? [{ name: "agent.harness", timeoutMs: config.agent.harness.timeoutMs }]
      : []),
  ].filter((agent) => agent.timeoutMs > config.concurrency.turnTimeoutMs);
  if (overlongLongTools.length) {
    log.event({
      level: "warn",
      kind: "config.invalid",
      summary: `${overlongLongTools.length} 个长工具的 timeoutMs 大于 concurrency.turnTimeoutMs（${config.concurrency.turnTimeoutMs}），超出部分不会生效`,
      data: {
        turnTimeoutMs: config.concurrency.turnTimeoutMs,
        overlong: overlongLongTools.map((agent) => ({
          name: agent.name,
          timeoutMs: agent.timeoutMs,
        })),
      },
    });
  }
  const toolRegistry = new ToolRegistry(
    log,
    approval,
    // `catalog` 那一段是折叠判据的**唯一**入口（`#deferredFor` 每次查询都从这个 getter 现读，
    // 所以它天然跟着热更新走）。漏掉这一行的表现是「配置页改了 tools.catalog.*，运行时一个字没变」，
    // 而 `tests/config.test.ts` 那条「路径级引用」断言挡不住它：`descriptions.ts` 里的点分键字面
    // 已经让 `tools.catalog.*` 各叶子匹配上了，接线漏没漏它看不出来。
    () => {
      const live = configStore.snapshot();
      return {
        maxRegistered: live.tools.maxRegistered,
        maxCallsPerTurn: live.tools.maxCallsPerTurn,
        maxConsecutiveErrors: live.tools.maxConsecutiveErrors,
        maxOutputBytes: live.tools.exec.maxOutputBytes,
        defaultTimeoutMs: live.tools.defaultTimeoutMs,
        catalog: live.tools.catalog,
      };
    },
    () => configStore.snapshot().approval.rules,
    plugins,
    turns,
  );
  toolRegistry.bindOverrides(() => configStore.snapshot().tools.overrides);
  // 判据本身在 core（`canSeeImages`，与两处 vision 切换一字对齐）；这里只补它问不到的那一半：
  // 主轮此刻用的是哪个别名 —— `set_model` 的当轮覆盖、会话固定别名、配置默认值，按这个顺序。
  const imageAudience = (toolContext: {
    agentKind: AgentKind;
    worker?: { alias: string } | undefined;
    turn: RuntimeTurnContext;
  }): boolean =>
    canSeeImages(
      modelRegistry,
      toolContext,
      () =>
        toolContext.turn.modelAliasOverride ??
        readAppKv<string>(db, modelAliasKey(toolContext.turn.key)) ??
        perChatConfig(configStore.snapshot(), toolContext.turn.key).agent.main
          .modelAlias,
    );
  // MCP / plugin 交回的图片走与 `web_fetch` 完全同一条路（存 `web_assets` → 注入 `webasset://`
  // 顶层 part → 骑工具结果给本步）。不绑的话浏览器类 MCP 的 `browser_screenshot` 会被
  // `#normalizeOutput` 截成半截 base64 当不可信文本交给模型 —— 既看不见图又烧光输出预算。
  toolRegistry.bindMedia({
    capture: (toolContext, input) =>
      captureImage(
        {
          assets: webAssets,
          appendDelta: (turn, message) =>
            context.appendDelta(turn, message as never),
          visionAvailable: () => imageAudience(toolContext),
          log,
          // 与 `web_fetch` 同一条路：worker 的截图在父轮只留文字痕迹（docs/04 §5.2）。
          ...(toolContext.worker
            ? {
                worker: {
                  name: toolContext.worker.name,
                  images: toolContext.worker.images,
                  onInjected: toolContext.worker.onMediaInjected,
                },
              }
            : {}),
        },
        toolContext.turn,
        {
          url: input.label,
          mediaType: input.mediaType,
          body: input.body,
          label: `MCP 工具 ${input.label}`,
        },
      ),
  });
  // 吃 getter 而不是启动快照：sandbox.mode 是「出事时运维会去点的那个开关」，冻住它等于
  // 界面说改成功了、bash 照跑（docs/20 · W-CFG-02）。
  const sandbox = new Sandbox(
    () => {
      const live = configStore.snapshot();
      return {
        mode: live.sandbox.mode,
        bypassRoles: live.sandbox.bypassRoles,
        dockerBin: live.sandbox.dockerBin,
        image: live.sandbox.image,
        network: live.sandbox.network,
        memoryMb: live.sandbox.memoryMb,
        cpus: live.sandbox.cpus,
        pidsLimit: live.sandbox.pidsLimit,
        readOnlyRoot: live.sandbox.readOnlyRoot,
        tmpfsMb: live.sandbox.tmpfsMb,
        workspaceDir: live.sandbox.workspaceDir,
        hostWorkspaceDir: live.sandbox.hostWorkspaceDir,
        persistent: live.sandbox.persistent,
        defaultTimeoutMs: live.tools.exec.defaultTimeoutMs,
        maxTimeoutMs: live.tools.exec.maxTimeoutMs,
        maxOutputBytes: live.tools.exec.maxOutputBytes,
      };
    },
    undefined,
    undefined,
    (message) =>
      log.event({
        level: "warn",
        kind: "sandbox.weak_isolation",
        summary: message,
      }),
    (reason, role) =>
      alerts.fire(
        "sandbox_unavailable",
        `沙箱不可用，${role} 的执行请求被拒`,
        { reason, role },
        role,
      ),
    // 第六个参数：每一次沙箱执行落一条 `sandbox.run`（docs/10 §2）。沙箱本身不认识 LogSink ——
    // 它是三条工具路径共用的底层，只交出事实。`turnId='adhoc'` 的那些（探测、非轮次调用）没有 trace。
    (run) =>
      log.event({
        level: run.ok ? "info" : "warn",
        kind: "sandbox.run",
        summary: `${run.mode}${run.denied ? ` denied: ${run.denied}` : ` exit ${run.exitCode ?? "null"}`}`,
        ...(run.turnId === "adhoc" ? {} : { traceId: run.turnId }),
        // 挂到调用它的那次 `tool.call` 之下。缺席（非轮次调用 / 探测）时照旧只有 traceId ——
        // 少了这一项它在 Trace 视图里画在 depth 0，与 `turn.start` 同级（docs/29 · M-LOG-02）。
        ...(run.parentSpanId ? { parentSpanId: run.parentSpanId } : {}),
        durationMs: run.durationMs,
        data: {
          mode: run.mode,
          image: run.image,
          exitCode: run.exitCode,
          ms: run.durationMs,
          ok: run.ok,
          oom: run.oom,
          killed: run.killed,
          truncated: run.truncated,
          role: run.role,
          ...(run.denied ? { denied: run.denied } : {}),
        },
      }),
  );
  // 会话级持久容器（docs/05 §5.5）。**装配期注入而不是构造参数**：`Sandbox` 一直是「不认识仓储层」
  // 的底层，而这个管理器要 DB 句柄。没绑上时整块降级成一次性容器，行为与落地之前一致。
  const containers = new ContainerManager(
    db,
    new SandboxContainerRepository(db),
    () => {
      const live = configStore.snapshot();
      return {
        dockerBin: live.sandbox.dockerBin,
        image: live.sandbox.image,
        memoryMb: live.sandbox.memoryMb,
        cpus: live.sandbox.cpus,
        pidsLimit: live.sandbox.pidsLimit,
        readOnlyRoot: live.sandbox.readOnlyRoot,
        tmpfsMb: live.sandbox.tmpfsMb,
        maxOutputBytes: live.tools.exec.maxOutputBytes,
        persistent: live.sandbox.persistent,
      };
    },
    (event: ContainerEvent) => {
      // **kind 写成四条字面量而不是拼串**：`tests/docs.test.ts` 把源码里的 `kind:` 与 `docs/10 §2`
      // 那张表双向焊死，而模板串在那道扫描里是隐形的 ——「表与实现差了 54 个」正是这么来的。
      const shared = {
        level: (event.type === "limit" || event.ok === false
          ? "warn"
          : "info") as "warn" | "info",
        summary: `${event.type}${event.name ? ` ${event.name}` : ""}`,
        ...(event.durationMs === undefined
          ? {}
          : { durationMs: event.durationMs }),
        data: {
          ...(event.chatId ? { chatId: event.chatId } : {}),
          ...(event.name ? { name: event.name } : {}),
          ...event.data,
        },
      };
      if (event.type === "created")
        log.event({ kind: "sandbox.container.created", ...shared });
      else if (event.type === "reaped")
        log.event({ kind: "sandbox.container.reaped", ...shared });
      else if (event.type === "limit")
        log.event({ kind: "sandbox.container.limit", ...shared });
      else log.event({ kind: "sandbox.container.exec", ...shared });
    },
  );
  sandbox.bindContainers(containers);
  /**
   * 回收 + 对账。**注册点必须在 `containers` 之后**（同 `provider-health` 那条注释的理由：cron 是
   * 构造即排期，排在声明之前那一次会以 TDZ 的 ReferenceError 收场，只在 `scheduler.failed` 里留一行）。
   *
   * 名字不能和用户任务的 `job:<id>` 命名空间撞 —— `Scheduler.add` 撞名直接抛。
   * `croner` 的 `protect:true` 让重叠的一次被跳过而不是排队，所以 `ContainerManager` 里
   * 每一条 docker 调用都有超时：一次不返回的回收会把这条 cron 永久打死。
   */
  const reapContainers = async (): Promise<void> => {
    const result = await containers.reap();
    // `legacy` 非零 = 宿主上有带 `luoli.managed=1` 却没有实例标签的容器（加这个标签之前建的）。
    // 认不出主人所以一个都没动，得有人去看一眼 —— 全部重建过一轮之后它自然归零。
    log.event({
      level: result.orphans > 0 || result.legacy > 0 ? "warn" : "info",
      kind: "sandbox.container.reconciled",
      summary: "Sandbox container reap complete",
      data: { ...result, instance: containers.instanceLabel },
    });
  };
  scheduler.add(
    config.sandbox.persistent.reapCron,
    reapContainers,
    "sandbox-reap",
  );
  // 启动时先对账一次而不是全杀：24h 的 TTL 要扛得住一次进程重启（docs/05 §5.5）。
  void reapContainers().catch((error) =>
    log.event({
      level: "error",
      kind: "scheduler.failed",
      summary: "sandbox-reap 首次对账失败",
      data: { error: error instanceof Error ? error.message : String(error) },
    }),
  );
  // 自撰写工具的注册器。真相在 `custom_tools` 表，进程内那份每次 `reconcile()` 都能重建
  // （docs/01 §3.1）；`execMaxTimeoutMs` 单独传是因为它归 `tools.exec`，不在 selfExtend 那一段里。
  const customToolRepo = new CustomToolRepository(db);
  const customTools = new CustomToolManager(
    customToolRepo,
    () => configStore.snapshot().tools.selfExtend,
    sandbox,
    log,
    () => configStore.snapshot().tools.exec.maxTimeoutMs,
  );
  if (probeSandbox) {
    const sandboxProbe = await sandbox.probe();
    if (!sandboxProbe.available && config.sandbox.mode === "docker")
      log.event({
        level: "error",
        kind: "sandbox.unavailable",
        summary: sandboxProbe.error ?? "Docker sandbox unavailable",
      });
  }
  // bot 要到最后才建得起来，而工具在这里就得注册完，所以桥拿的是 getter。**presence 即开关**：
  // `available()` 判的就是 `telegram` 在不在，没有 BOT_TOKEN 时这一族工具必须整体不进目录，
  // 而不是进了目录再在调用时失败。
  const telegramTools = process.env.BOT_TOKEN
    ? new TelegramTools({
        bot: () => slots.bot,
        archive,
        maxMessageChars: () => configStore.snapshot().output.maxMessageChars,
        maxMentions: () => configStore.snapshot().output.maxMentions,
        parseMode: () => configStore.snapshot().output.parseMode,
        log,
      })
    : null;
  // 定时任务（docs/14 §2 Q4）。这里只**建**不**装**：`load()` 要等 bot 起来，否则第一批任务触发时
  // `telegram()` 还是 null，只会往日志里写一串 skipped。工具反过来在这里就得拿到 runner。
  const scheduledJobs = new ScheduleRepository(db);
  const scheduleRunner = new ScheduledJobRunner({
    db,
    jobs: scheduledJobs,
    scheduler,
    context,
    archive,
    turns,
    registry: turnRegistry,
    concurrency: turnConcurrency,
    quota,
    memory,
    tools: toolRegistry,
    log,
    plugins,
    approvals: approval,
    config: () => configStore.snapshot(),
    // **bot 起来之后才非空**：给外层对象会让 runner 里那条 `telegram_unavailable` 的 skip 分支变成
    // 死代码，启动窗口内经 HTTP 手动触发的任务会开一整轮、跑完模型、记完账，最后不提交
    // （docs/28 · L-SCH-01）。
    telegram: () => (slots.bot ? telegramTools : null),
    failures: turnFailures,
    roleOf: (kind, tgId) => principals.roleOf(kind, tgId),
    estimateTurnCost: (inputTokens, key) =>
      modelRegistry.estimate(
        readAppKv<string>(db, modelAliasKey(key)) ??
          perChatConfig(configStore.snapshot(), key).agent.main.modelAlias,
        inputTokens,
      ),
    // 非流式：定时轮次没有 Telegram 流消费者，也没人盯着屏幕等增量。其余依赖与 `onTurn` 完全一致。
    runAgent: (turn, reservation) => {
      const live = turn.config as Readonly<typeof config>;
      return runMainAgent(turn, {
        config: live,
        db,
        registry: modelRegistry,
        tools: toolRegistry,
        prompts: promptAssembler,
        documents: promptDocuments,
        skills,
        plugins,
        agents,
        customTools,
        containers,
        ledger,
        context,
        quota,
        reservation,
        log,
        turns,
        workspace: resolve(live.sandbox.workspaceDir, turn.chatId),
      });
    },
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
    db,
    filesFor: (workspace, role) =>
      new FileTools(
        new PathJail(
          role === "owner" &&
            configStore.snapshot().tools.fs.allowHostFsForOwner
            ? "/"
            : workspace,
          [
            ...config.tools.fs.denyGlobs,
            ...selfAuthoringDenyGlobs({
              skillsDir: config.skills.dir,
              pluginsDir: config.plugins.dir,
            }),
          ],
          { base: workspace },
        ),
        config.tools.fs.maxReadBytes,
        config.tools.fs.maxWriteBytes,
        {
          showHidden: config.tools.fs.showHidden,
          trashDir: config.tools.fs.trashDir,
          backupDir: config.tools.fs.backupDir,
        },
      ),
    sandbox,
    archive,
    context,
    memory,
    skills,
    agents,
    models: modelRegistry,
    ledger,
    log,
    quota,
    maxWebBytes: config.tools.web.maxResponseBytes,
    maxAsksPerRun: config.agent.maxAsksPerRun,
    web: {
      timeoutMs: config.tools.web.timeoutMs,
      retries: config.tools.web.retries,
    },
    webSearch: {
      provider: config.tools.web.searchProvider,
      apiKey: config.tools.web.searchApiKey,
    },
    // 抓回来的图片进上下文。`visionAvailable` 的判据与 `runMainAgent` / `runLwWorker` 里那两次切换
    // **必须一致**：一边说能看、另一边把图换成占位文本，模型就会收到「图已放进上下文」加一句
    // 「当前模型不看图」。别名按次现算（`set_model` 能在轮内换掉它），所以这里是个函数而不是快照。
    webMedia: { assets: webAssets, visionAvailable: imageAudience },
    telegram: telegramTools,
    // 没有投递通道时这三个工具整体不进目录：排一个到点发不出去的任务是纯粹的假承诺。
    schedule: {
      jobs: scheduledJobs,
      runner: scheduleRunner,
      deliverable: () => telegramTools !== null,
    },
    acp,
    // ACP 的逐条 permission 走同一条审批链（`docs/05 §3.5.3`）：同一张 `approvals` 表、同一套
    // `approval.rules` / TTL / 双通道裁决。**默认档是 `auto`，这条链默认不生效** —— 运维把
    // `permissionMode` 拨到 `ask` 才会用上它，而那时漏传它是一道真的门：没有 broker 时 `spawn_acp`
    // 直接不进工具目录（不是「悄悄放行」）。
    approvals: approval,
  });
  registerAuthoringTools(toolRegistry, {
    customTools,
    skills,
    plugins,
    reservedSkills: BUNDLED_SKILLS,
    mcp: {
      db,
      config: () => configStore.snapshot(),
      apply: (next, keys) => configStore.replace(next, keys),
      emit: (keys) => events.emit("config.changed", { keys }),
    },
  });
  // 容器管理（docs/05 §3.11）。**无条件注册，开关放在 `available()` 里** —— 按配置跳过注册会撞上
  // 下面那条「每个 TOOL_POLICY 条目都必须已注册」的启动断言，表现是关掉持久化之后进程起不来
  // （同 authoring.ts 那八个）。
  registerContainerTools(toolRegistry, { sandbox, db });
  // 折叠目录的检索入口（docs/05 §3.12）。同上：无条件注册，开关（`agentKind==='main'` + 本角色
  // 折叠集非空）焊在 `available()` 里 —— 它在 `TOOL_POLICY` 里，跳过注册会让下面那条启动断言
  // 直接把进程拦死。
  registerCatalogTools(toolRegistry, { log });
  plugins.bindRegistry(toolRegistry);
  mcp.bindRegistry(toolRegistry);
  customTools.bindRegistry(toolRegistry);
  if (reconcileExtensions) {
    await plugins.reconcile();
    await mcp.reconcile();
  }
  // 自撰写的工具**最后注册**：重名时先注册的赢（`registerExternal` 拒绝跨来源覆盖），让运维显式
  // 配的 plugin / MCP 压过模型自己造的那份，方向是 fail-safe。
  customTools.reconcile();
  for (const name of Object.keys(TOOL_POLICY))
    if (!toolRegistry.has(name))
      throw new Error(`tool policy is not registered: ${name}`);
  /**
   * 工具改名之后，存量的 `tools.overrides.<旧名>` 会变成孤儿。
   *
   * `tools.overrides` 是 `z.record`：孤儿键既不报错也不生效，`loadConfig` 的 `onInvalidOverride`
   * 那条路也拦不到它（它挡的是 schema 之外的路径，而 record 下任何键都在 schema 之内）。表现是
   * 运维当初在工具页关掉的那个工具，升级之后静静地重新打开了 —— 而界面上不会显示它被关过。
   *
   * 只报不迁移：迁移等于替运维改一条他没看过的权限设置。`config.invalid` 是既有 kind
   * （`docs/10 §2` 那张表与源码双向焊死，不新增），它表达的正是「这条覆盖没生效」。
   */
  const RENAMED_TOOLS: ReadonlyArray<[string, string]> = [
    ["spawn_agent", "spawn_worker"],
    ["read_agent_result", "read_worker_result"],
  ];
  for (const [old, current] of RENAMED_TOOLS) {
    if (!(old in config.tools.overrides)) continue;
    const summary = `tools.overrides.${old} 已改名为 ${current}，这条覆盖当前不生效，请在工具页重新设置`;
    log.event({
      level: "warn",
      kind: "config.invalid",
      summary,
      data: { key: `tools.overrides.${old}`, renamedTo: current },
    });
    process.stderr.write(tagged("error", `[config] ${summary}\n`));
  }
  let setup: { token: string; expiresAt: number } | undefined;
  if (!config.webui.passwordHash) {
    setup = setupToken();
    process.stdout.write(
      `LuoLiCore setup token: ${highlight(setup.token)}\n` +
        `Open ${highlight(`http://${config.webui.host}:${config.webui.port}/setup`)}\n`,
    );
  }
  const previewPrompt = (
    key: string,
    role: RuntimeTurnContext["effectiveRole"],
  ): PromptPreviewResult => {
    const contextRow = db
      .prepare(
        "SELECT chat_id AS chatId,thread_id AS threadId FROM contexts WHERE key=?",
      )
      .get(key) as { chatId: string; threadId: number | null } | undefined;
    if (!contextRow) throw new Error("会话不存在");
    const latest = db
      .prepare(
        "SELECT initiator_user_id AS userId FROM turns WHERE key=? ORDER BY COALESCE(started_at,queued_at) DESC,rowid DESC LIMIT 1",
      )
      .get(key) as { userId: string } | undefined;
    // 群名也从这一行取：RUNTIME 的「会话」行要它，而预览必须逐字等于下一轮真正发出去的那一份。
    // 私聊查不到是**预期**的，不要回落去查 `kind='user'`：私聊不占 `chat:` 行，而 `chatTitle` 的契约
    // 就是「群名 / 频道名，私聊无此值」（`packages/shared`），`chatDescription` 对私聊直接输出「私聊」、
    // 根本不读这个值。填上对方显示名等于破坏契约。`isPrivate` 那一侧另有 Telegram id 正负号的回落。
    const principal = db
      .prepare(
        "SELECT chat_type AS chatType, display_name AS title FROM principals WHERE kind='chat' AND tg_id=?",
      )
      .get(contextRow.chatId) as
      { chatType: string | null; title: string | null } | undefined;
    const live = perChatConfig(configStore.snapshot(), key);
    const snapshot = context.materialize(key, null, live.context.cacheCommits);
    const turn = {
      turnId: "webui:prompt-preview",
      key,
      chatId: contextRow.chatId,
      threadId: contextRow.threadId,
      initiatorUserId: latest?.userId ?? contextRow.chatId,
      effectiveRole: role,
      isPrivate: principal?.chatType
        ? principal.chatType === "private"
        : !contextRow.chatId.startsWith("-"),
      baseCommitId: null,
      snapshot,
      delta: [],
      abortSignal: new AbortController().signal,
      config: live,
      ...(principal?.title ? { chatTitle: principal.title } : {}),
    } satisfies RuntimeTurnContext;
    // 预览也会在 `toolRegistry` 里落一条按 turnId 挂的状态。turnId 是个常量所以不会堆积，
    // 但留着等于让下一次预览沿用上一次的工具调用计数 —— 顺手清掉（docs/22 · I-10）。
    const built = ((): ReturnType<typeof assembleMainPrompt> => {
      try {
        return assembleMainPrompt(turn, {
          config: live,
          tools: toolRegistry,
          prompts: promptAssembler,
          documents: promptDocuments,
          workspace: resolve(live.sandbox.workspaceDir, contextRow.chatId),
          skills,
          agents,
          containers,
        });
      } finally {
        toolRegistry.releaseTurn(turn.turnId);
      }
    })();
    const order = [
      "kernel",
      "character",
      "assist",
      "catalog",
      "pubmemory",
      "primemory",
      "runtime",
    ];
    const blocks = order
      .filter(
        (name) =>
          name !== "primemory" ||
          built.instructions.includes("=== PRIMEMORY ==="),
      )
      .map((name) => ({
        name,
        tokens: built.blocks[name] ?? 0,
        content: built.contents[name] ?? "",
        truncated: built.truncated.includes(name),
        cached: (STABLE_PROMPT_BLOCKS as readonly string[]).includes(name),
      }));
    return {
      key,
      role,
      instructions: built.instructions,
      blocks,
      totalTokens: blocks.reduce((sum, block) => sum + block.tokens, 0),
      context: { messages: snapshot.messages.length, tokens: snapshot.tokens },
    };
  };

  /** 试跑的 chat/user 计数落在这个合成 subject 上：它花的是真钱，但不该记到某个真实会话头上。 */
  const DRY_RUN_SUBJECT = "webui-dryrun";

  async function dryRunWorker(
    input: { task: string; tools?: string[]; modelAlias?: string },
    signal: AbortSignal,
    emit: (event: LwWorkerRuntimeEvent) => void | Promise<void>,
  ): Promise<{ summary: string; fullRef: string; truncated: boolean }> {
    const live = configStore.snapshot();
    const alias = input.modelAlias ?? live.agent.worker.modelAlias;
    const run = agents.createDryRun(input.task, alias, "owner");
    const workspace = resolve(live.sandbox.workspaceDir, DRY_RUN_SUBJECT);
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    // 试跑跑的是真实模型调用。不接配额的话 usage_ledger 看得见这笔花费、quota_counters 却不涨，
    // global.daily 对试跑一概无效 —— 和 docs/20 · W-QUOTA-01 是同一个成因（agent/subagent.ts 的注释）。
    const roleLimits = live.quota.perUser.byRole[run.effectiveRole];
    const estimate = modelRegistry.estimate(
      alias,
      Math.max(live.context.limit.tokens / 4, 1000),
    );
    if (live.quota.enabled && live.quota.requirePricing && estimate === null)
      throw new Error(
        `别名 ${alias} 缺少定价，无法预估试跑花费（quota.requirePricing=true）`,
      );
    const reservation = live.quota.enabled
      ? quota.reserve({
          chatId: DRY_RUN_SUBJECT,
          userId: DRY_RUN_SUBJECT,
          estimateUsd: Math.max(
            live.quota.minReserveUsd,
            estimate ?? live.quota.minReserveUsd,
          ),
          limits: {
            globalDaily: live.quota.global.daily,
            globalMonthly: live.quota.global.monthly,
            chatDaily: live.quota.perChat.daily,
            chatMonthly: live.quota.perChat.monthly,
            userDaily: roleLimits?.daily ?? live.quota.perUser.daily,
            userMonthly: roleLimits?.monthly ?? live.quota.perUser.monthly,
          },
        })
      : null;
    if (live.quota.enabled && !reservation) {
      agents.fail(run, "quota_exceeded");
      throw new Error(
        "额度不足：试跑与正常轮次共用同一份全局额度，当前窗口已经用满",
      );
    }
    const turn = {
      turnId: run.turnId,
      key: run.turnId,
      chatId: DRY_RUN_SUBJECT,
      threadId: null,
      initiatorUserId: "webui",
      effectiveRole: run.effectiveRole,
      isPrivate: false,
      baseCommitId: null,
      snapshot: {
        messages: [],
        ordinals: [],
        tokens: 0,
        windowStart: 1,
        headOrdinal: 0,
      },
      delta: [],
      abortSignal: signal,
      config: live,
    } satisfies RuntimeTurnContext;
    try {
      return await runLwWorker(
        run,
        input.task,
        undefined,
        turn,
        {
          db,
          agents,
          registry: modelRegistry,
          tools: toolRegistry,
          ledger,
          log,
          workspace,
          provider: {
            maxRetries: live.provider.maxRetries,
            retryBaseMs: live.provider.retryBaseMs,
            retryMaxMs: live.provider.retryMaxMs,
          },
          quota,
          reservation,
          onEvent: emit,
        },
        {
          modelAlias: alias,
          // 面板上勾了一组工具才收窄；不勾即照正常派发那样拿全集，两者是同一条路上的两个档位。
          ...(input.tools?.length ? { tools: input.tools } : {}),
        },
      );
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

  const rebuildModels = (): void => {
    const live = configStore.snapshot();
    modelRegistry.rebuild(live.provider.healthDownCooldownMinutes);
    // 一个可用别名都不剩 = 所有 provider 都下线了（docs/10 §6 all_providers_down）。用户侧的表现
    // 是每一轮都以 model alias unavailable 失败，而运维那边只有一条 config.invalid 躺在日志里。
    if (!modelRegistry.aliases().length)
      alerts.fire(
        "all_providers_down",
        "没有任何可用的模型别名：所有 provider 都不可用或未配置",
      );
    log.setSecrets([
      process.env.BOT_TOKEN ?? "",
      process.env.LUOLI_MASTER_KEY ?? "",
      live.tools.web.searchApiKey,
      ...providers.allDecryptedKeys(),
    ]);
  };
  // 这个任务此前只调 `rebuild()`：一次探测都不发，于是「上游连上了但不返回」没有任何一处会记住，
  // 链首每一步都要重新熬满 `(maxRetries+1) × requestTimeoutMs`（logs/2026-08-18 的三轮各 363 秒，
  // 最后全部以「这一轮太久没有进展」收尾）。现在照 `docs/04 §5.3` 真的探一遍。
  // 走 `rebuildModels()` 而不是裸 `rebuild()`：那条尾巴还管 `all_providers_down` 与 `log.setSecrets`。
  // **注册点必须在 `rebuildModels` 之后**：cron 是构造即排期，而上面那几个 `await`（sandbox.probe
  // 要拉 docker）足够让它在 `const rebuildModels` 求值之前就到点 —— 那一次会以 TDZ 的
  // ReferenceError 收场，只在 `scheduler.failed` 里留一行，健康检查静静少跑一轮。
  scheduler.add(
    config.provider.healthCheckCron,
    async () => {
      // **先 rebuild 再探。** 探测只覆盖 `health_state <> 'down'` 的行，而把冷却到期的那一行写回
      // `up` 的正是 `rebuild()`：反过来的话，刚过完 30 分钟冷却的那个 provider 本轮探不到，
      // 它会带着上一次的判定承接一整个 cron 间隔的真实流量。探完再 rebuild 一次是因为探测本身会改
      // 状态（新判死的要出链、探回 up 的要进链）—— 这一次也顺带管 `all_providers_down` 与
      // `log.setSecrets`。
      rebuildModels();
      const outcomes = await runProviderHealthCheck(
        { db, log, keyFor: (providerId) => providers.key(providerId) },
        {
          timeoutMs: PROVIDER_PROBE_TIMEOUT_MS,
          failuresToDown: PROVIDER_FAILURES_TO_DOWN,
          allowPrivate: configStore.snapshot().provider.allowPrivateBaseUrl,
        },
      );
      rebuildModels();
      log.event({
        level: "info",
        kind: "provider.health",
        summary: "Provider registry health refreshed",
        data: {
          aliases: modelRegistry.aliases(),
          probed: outcomes.length,
          down: outcomes
            .filter((outcome) => outcome.state === "down")
            .map((outcome) => outcome.name),
        },
      });
    },
    "provider-health",
  );
  // main.ts 的 `dispose.quiesce()` 要关它：构造留在这里，收尾的顺序说明见 main.ts。
  const eventStreams = new EventStreamRegistry();
  const server = createServer({
    config: configStore,
    db,
    operations,
    principals,
    archive,
    context,
    providers,
    modelCatalog,
    approvals: approval,
    rebuildModels,
    maintenance,
    ledger,
    restart,
    events,
    log,
    sources,
    apiKeys,
    secrets,
    // `/sdk/v1/*` 的轮次执行依赖（docs/12-sdk.md T3.6）。字段分组直接对应 `runTurn()`/`runMainAgent()`
    // 的入参形状（`ServerDependencies.sdk` 的文档注释）；`approvals`/`plugins`/`failures` 与
    // `scheduleRunner` 共用同一批实例——三条不变量（并发槽释放、配额释放、审批/插件钩子）已经
    // 在 `runTurn()` 内部只维护一份，这里没有理由再分叉出第二套引用。
    sdk: {
      sessions: sdkSessions,
      turn: {
        context,
        turns,
        registry: turnRegistry,
        concurrency: turnConcurrency,
        quota,
        tools: toolRegistry,
        memory,
        log,
        approvals: approval,
        plugins,
        failures: turnFailures,
      },
      agent: {
        db,
        registry: modelRegistry,
        tools: toolRegistry,
        prompts: promptAssembler,
        documents: promptDocuments,
        skills,
        plugins,
        agents,
        customTools,
        containers,
        ledger,
        context,
        quota,
        log,
        turns,
      },
      workspaceRoot: config.sandbox.workspaceDir,
    },
    memory,
    promptDocuments,
    skills,
    plugins,
    mcp,
    mcpAuth: { store: mcpAuth, pending: mcpPending },
    agents,
    tools: toolRegistry,
    customTools: customToolRepo,
    customToolManager: customTools,
    turnRegistry,
    sandbox,
    eventStreams,
    previewPrompt,
    dryRunWorker,
    schedules: { jobs: scheduledJobs, runner: scheduleRunner },
    configSchema: configJsonSchema(),
    startedAt,
    setup,
  });

  /**
   * 两阶段 dispose，供不需要完整 HTTP / Telegram 生命周期的调用方使用（`tests/support/runtime.ts`）。
   * `main.ts` 自己的 `shutdown()` 中段要插 http / poller / bot / drain / abortAll，
   * 单个 `dispose()` 塞不进那一刀，因此拆成 `quiesce()`（停 scheduler / eventStreams /
   * approvalPrompts）与 `close()`（关 plugins / mcp / acp / skills / log）两段，中段由调用方自己写。
   */
  const dispose = {
    quiesce: async (): Promise<void> => {
      scheduler.stop();
      eventStreams.closeAll();
      // 只清 timer 与等待者，**不撤键盘** —— 那几次编辑会被紧随其后的 `bot.stop()` 掐断，而残留键盘
      // 由下一次启动那趟 `staleKeyboards()` 负责（`docs/05 §6.1`）。两条路里那一条才是可靠的。
      approvalPrompts.dispose();
    },
    close: async (): Promise<void> => {
      await plugins.close();
      await mcp.close();
      // ACP 的子进程与 MCP 的同类：**不 unref**，所以必须等它们真死，否则 event loop 不空、
      // `shutdown()` 只设 `process.exitCode` 的进程就是不退（docs/28 · L-EXT-03）。
      // 排在调用方 `turnRegistry.abortAll` 之后：在途那一轮先收到 abort，`spawn_acp` 走
      // `session/cancel` 让 agent 自己收尾，这一行只负责兜没收干净的那些。
      await acp.close();
      await skills.close();
      log.close();
    },
  };

  return {
    deps: {
      principals,
      archive,
      operations,
      turns,
      events,
      quota,
      secrets,
      sources,
      apiKeys,
      providers,
      modelCatalog,
      ledger,
      turnRegistry,
      turnConcurrency,
      log,
      alerts,
      turnFailures,
      context,
      modelRegistry,
      memory,
      skills,
      agents,
      plugins,
      mcpAuth,
      mcpPending,
      mcp,
      acp,
      webAssets,
      maintenance,
      scheduler,
      promptAssembler,
      promptDocuments,
      approvalPrompts,
      approval,
      toolRegistry,
      sandbox,
      containers,
      reapContainers,
      customToolRepo,
      customTools,
      scheduledJobs,
      scheduleRunner,
      setup,
      previewPrompt,
      dryRunWorker,
      rebuildModels,
      eventStreams,
    },
    server,
    slots,
    dispose,
  };
}

export type ComposedRuntime = Awaited<ReturnType<typeof composeRuntime>>;
