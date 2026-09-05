import argon2 from "argon2";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { serve } from "@hono/node-server";
import {
  acquireInstanceLock,
  closeDatabase,
  migrateDatabase,
  modelAliasKey,
  openDatabase,
  readAppKv,
  readPersistedConfig,
  recomputeMessageTokens,
  recoverAfterCrash,
  writeAppKv,
} from "@luoli/db";
import {
  ConfigStore,
  loadConfig,
  migrateMemoryLayout,
  perChatConfig,
  repairAgentResultRefs,
  repairLedgerCacheCost,
  streamMainAgent,
  tagged,
} from "@luoli/core";
import { issueLoginToken } from "@luoli/server";
import {
  UpdatePoller,
  approvalSettledText,
  createTelegramBot,
  staleApprovalOutcome,
} from "@luoli/telegram";
import { composeRuntime } from "./compose.js";

const startedAt = Date.now();
const TOKEN_REPAIR_KEY = "repair:context-tokens:v1";
const startupDatabasePath = process.env.LUOLI_DATA_DIR
  ? resolve(process.env.LUOLI_DATA_DIR, "luoli.db")
  : "./data/luoli.db";
// env 叠加抽成一个函数，启动与热重载共用：只在启动时叠的话，host 存在 DB 而口令只来自 env 的部署，
// 热重载会撞上 webui.passwordHash 的 superRefine 而整体失败（removeOverridePath 也删不掉它，
// 因为它根本不在 overrides 里），表现是配置改一次就再也不生效（docs/20 · W-CFG-03）。
const passwordHashFromEnvironment = process.env.WEBUI_PASSWORD
  ? await argon2.hash(process.env.WEBUI_PASSWORD, {
      type: argon2.argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    })
  : null;
const reportRejectedKey = (key: string): void =>
  void process.stderr.write(
    tagged(
      "warn",
      `[config] 已拒绝 config_kv 中的非法键：${key}（清理命令：DELETE FROM config_kv WHERE key='${key.replaceAll("'", "''")}';）\n`,
    ),
  );
const envOverlay = (
  overrides: Record<string, unknown>,
): Record<string, unknown> => {
  if (!process.env.LUOLI_WEBUI_HOST && !passwordHashFromEnvironment)
    return overrides;
  const webui =
    overrides.webui &&
    typeof overrides.webui === "object" &&
    !Array.isArray(overrides.webui)
      ? (overrides.webui as Record<string, unknown>)
      : {};
  if (process.env.LUOLI_WEBUI_HOST) webui.host = process.env.LUOLI_WEBUI_HOST;
  if (passwordHashFromEnvironment)
    webui.passwordHash = passwordHashFromEnvironment;
  overrides.webui = webui;
  return overrides;
};
const startupOverrides = envOverlay(
  readPersistedConfig(startupDatabasePath, reportRejectedKey),
);
const droppedOverrides: string[] = [];
const reportInvalidOverride = (dropped: string[], messages: string[]): void => {
  droppedOverrides.push(...dropped);
  process.stderr.write(
    tagged(
      "warn",
      `[config] 已忽略 ${dropped.length} 条非法持久化覆盖：\n  ${messages.join("\n  ")}\n` +
        `[config] 清理命令：DELETE FROM config_kv WHERE key IN (${dropped.map((key) => `'${key.replaceAll("'", "''")}'`).join(", ")});\n`,
    ),
  );
};
const config = await loadConfig({
  overrides: startupOverrides,
  onInvalidOverride: reportInvalidOverride,
});
const configStore = new ConfigStore(config);
for (const path of [
  resolve("data"),
  resolve("skills"),
  resolve("plugins"),
  resolve(config.memory.dir),
  resolve(config.sandbox.workspaceDir),
])
  mkdirSync(path, { recursive: true, mode: 0o700 });
const db = openDatabase(config.db.path);
// 第三个参数把日志库串进来：建 `logs.dbPath` → 迁移它 → ATTACH → 搬迁主库里的存量
// `log_events` → 最后才跑主库迁移。顺序在 `migrateDatabase` 里写死，理由见 docs/10 §3
// （`0017` 会删掉主库那张表，跑在搬迁之前就是把存量日志直接删了）。
// `legacyDir` 是上一版那个 `logs/` 目录：搬迁时要顺着 `file_ref` 把 blob 收回行上。
migrateDatabase(db, undefined, {
  path: config.logs.dbPath,
  legacyDir: resolve("logs"),
  compress: config.logs.compress,
});
// **拿锁必须排在 `recoverAfterCrash` 之前**：那个函数假定「进程启动 ⇒ 上一个进程已死」，
// 而在这把锁之前没有任何东西保证这一点 —— 用同一个库起第二个实例会把在位实例**仍在执行**的
// 轮次就地判死、释放已认领的消息、清零在途预留，之后 A 才因为 409 关停（docs/28 · L-OPS-01）。
// 迁移排在前面是有意的：锁文件放在库旁边，而空库首启时目录可能还不存在。
const instanceLock = acquireInstanceLock(config.db.path);
if (!instanceLock.ok) {
  process.stderr.write(
    tagged(
      "error",
      `[lock] 另一个实例正在使用该数据库（pid ${instanceLock.holder.pid}@${instanceLock.holder.host}，` +
        `启动于 ${new Date(instanceLock.holder.startedAt).toISOString()}）。\n` +
        `[lock] 同库双实例会相互清除在途轮次与消息认领，因此拒绝启动。更换实例前请先停止在位实例；\n` +
        `[lock] 确认在位进程已退出而锁文件仍在时，删除 ${config.db.path}.lock 后重启（同目录的 .lock.<n> 可一并删除）。\n`,
    ),
  );
  process.exit(1);
}
if (instanceLock.lock.stolenFrom)
  process.stdout.write(
    tagged(
      "warn",
      `[lock] 已接管 pid ${instanceLock.lock.stolenFrom} 遗留的锁：上一次进程非正常退出。\n`,
      process.stdout,
    ),
  );
// 报出来而不是静静收尾：`LogSink` 到下面才建得起来，所以先走 stdout，等 sink 有了再补一条
// `system.recovered`。此前它返回 void 也不记日志，一次非正常重启之后 reap 了什么只能靠翻
// `turns` 表反推（docs/28 · L-OPS-04）。
const recovered = recoverAfterCrash(db);
const recoveredAny = Object.values(recovered).some((count) => count > 0);
if (recoveredAny)
  process.stdout.write(
    tagged(
      "warn",
      `[recover] 上一个进程非正常退出：标记失败 ${recovered.turns} 条轮次 / ${recovered.tasks} 条任务 / ${recovered.agentRuns} 条子 agent，` +
        `释放 ${recovered.claims} 条消息认领，清零 ${recovered.reservations} 行在途预留。\n`,
      process.stdout,
    ),
  );
// 一次性数据修复而不是迁移：迁移文件提交后不可修改，而这件事要用 TS 侧的估算器重算 parts。
// 修的是 token 校准失控期间落库的 tokens（实测系数最高约 26 倍，logs/2026-08-16）。
if (!readAppKv<boolean>(db, TOKEN_REPAIR_KEY)) {
  const repaired = recomputeMessageTokens(db);
  writeAppKv(db, TOKEN_REPAIR_KEY, true, "startup");
  if (repaired.messages || repaired.contexts)
    process.stdout.write(
      tagged(
        "info",
        `[context] 已按新估算器重算 ${repaired.messages} 条上下文消息的 tokens，并重置 ${repaired.contexts} 个会话的校准系数。\n`,
        process.stdout,
      ),
    );
}
// 同一条路的第二次一次性修复：缓存 token 曾被双重计价，账面高估约 44%（docs/28 · L-COST-01）。
// 它自己带 `app_kv` 门闸，跑过一次就返回 null。
const ledgerRepair = repairLedgerCacheCost(db, config.general.timezone);
if (ledgerRepair?.rewritten)
  process.stdout.write(
    tagged(
      "info",
      `[ledger] 已按新计价口径重算 ${ledgerRepair.rewritten} 条用量（受影响 ${ledgerRepair.affected} 条、跳过 ${ledgerRepair.skipped} 条），` +
        `合计 $${ledgerRepair.before.toFixed(6)} → $${ledgerRepair.after.toFixed(6)}；同时重算 ${ledgerRepair.turns} 条轮次与 ${ledgerRepair.counters} 行配额计数` +
        `${ledgerRepair.countersStale ? `（另有 ${ledgerRepair.countersStale} 行明细已过保留期，无法重算）` : ""}。\n`,
      process.stdout,
    ),
  );
const agentResultsDir = process.env.LUOLI_DATA_DIR
  ? resolve(process.env.LUOLI_DATA_DIR, "agent-results")
  : resolve("data/agent-results");
// 存量绝对路径行的一次性归一化，门闸同上面那两条修复。指向另一个根的行**不动** ——
// 那是「这两套东西不是同一个部署」的唯一信号，`gcFiles()` 要靠它拒绝清理。
const resultRefs = repairAgentResultRefs(db, agentResultsDir);
if (resultRefs?.rewritten)
  process.stdout.write(
    tagged(
      "info",
      `[agents] 已将 ${resultRefs.rewritten} 行子 agent 结果路径归一化为相对 ${agentResultsDir} 的 ref（另有 ${resultRefs.relative} 行已是相对 ref）。\n`,
      process.stdout,
    ),
  );
if (resultRefs?.foreign) {
  process.stderr.write(
    tagged(
      "warn",
      `[agents] ${resultRefs.foreign} 行子 agent 结果路径指向另一个部署根（例如 ${resultRefs.sample}），已原样保留。\n` +
        `[agents] gc-files 会因此拒绝清理子 agent 结果目录，请先确认该数据库与 ${agentResultsDir} 属于同一部署。\n`,
    ),
  );
  // 结构化的那一份（`kind: "maintenance.repair"`）在 composeRuntime 内用 log 补记：
  // LogSink 要等 compose 建完才存在，三项启动期修复的日志因此都在那边一起落。
}
// 记忆磁盘布局从「全局单份」搬到「按来源分区」（docs/12-sdk.md T2.2，与 0019 迁移配套）：
// PUBMEMORY.md、每份 private/<userId>/PRIMEMORY.md 移动，CHARACTER.md、ASSIST.md 复制进
// memory/sources/telegram/，根目录两份留作模板。判据是文件系统而非门闸变量，重复执行天然幂等。
const memoryLayout = migrateMemoryLayout(
  db,
  resolve(config.memory.dir),
  dirname(resolve(config.db.path)),
);
if (memoryLayout.migrated)
  process.stdout.write(
    tagged(
      "info",
      `[memory] 已将 ${memoryLayout.migrated} 项记忆文件搬迁至按来源分区布局（跳过 ${memoryLayout.skipped} 项）。\n`,
      process.stdout,
    ),
  );
if (memoryLayout.conflicts)
  process.stderr.write(
    tagged(
      "warn",
      `[memory] ${memoryLayout.conflicts} 项记忆文件旧路径与新路径同时存在，已保留新文件未覆盖（例如 ${memoryLayout.conflictSample}）。\n`,
    ),
  );
if (memoryLayout.healed)
  process.stdout.write(
    tagged(
      "info",
      `[memory] 已修正 ${memoryLayout.healed} 行 memory_docs.path 记录：文件已在新路径，库记录此前未同步。\n`,
      process.stdout,
    ),
  );
// 建对象、接线、注册的那一大段收在 `composeRuntime` 里（原欠账 `D-04`，`docs/reviews/27 §8`）；
// 这里只装配不动生命周期 —— `http` 监听、Telegram 启动块、`process` 信号 / 异常处理器、
// `shutdown()` 本体留在这个文件里，理由见 `compose.ts` 顶部注释。
// `restart` 转发给下面才声明的同名函数：`composeRuntime` 立即求值这个箭头函数本身（不是调用它），
// 真正的调用发生在 `/api/restart` 命中的那一刻，那时 `const restart = ...` 早已跑过。
const composed = await composeRuntime({
  config,
  configStore,
  db,
  startedAt,
  agentResultsDir,
  startup: { recovered, ledgerRepair, resultRefs },
  restart: (reason) => restart(reason),
  probeSandbox: true,
  reconcileExtensions: true,
});
const { deps, server, slots, dispose } = composed;
const {
  principals,
  archive,
  operations,
  turns,
  events,
  quota,
  secrets,
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
  mcp,
  scheduler,
  promptAssembler,
  promptDocuments,
  approvalPrompts,
  approval,
  toolRegistry,
  containers,
  reapContainers,
  customTools,
  scheduledJobs,
  scheduleRunner,
  rebuildModels,
} = deps;

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
 * 所以顺序是：先把这一整块装好，再 `http = serve(...)`。`http` 因此必须是 `let` ——
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
  log.event({
    level: "warn",
    kind: "system.restart",
    summary: `Restart requested by ${reason}`,
  });
  await shutdown(`restart:${reason}`);
  process.exitCode = 0;
};
const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  log.event({
    level: "info",
    kind: "system.stop",
    summary: `Stopping on ${signal}`,
  });
  // 前三件（scheduler / eventStreams / approvalPrompts）收在 `dispose.quiesce()` 里：
  // 它们与 http / poller / bot 无关，compose.ts 里有它们各自「为什么」的注释。
  await dispose.quiesce();
  const { promise: closed, resolve: markClosed } =
    Promise.withResolvers<void>();
  let force: ReturnType<typeof setTimeout> | null = null;
  // 绑成局部 const：`http` 现在是 `let`（见上面那段注释），闭包里 TS 收窄不住它。
  const listening = http;
  if (listening) {
    listening.close(() => markClosed());
    force = setTimeout(() => {
      if ("closeAllConnections" in listening) listening.closeAllConnections();
      markClosed();
    }, config.general.shutdown.graceMs);
    force.unref?.();
  } else markClosed();
  // 先停拉取（`stop()` 顺手把 offset 交回 Telegram），在途的 update 交给下面的 drain。
  if (slots.poller) await slots.poller.stop();
  if (slots.bot) await slots.bot.stop();
  // 宽限期内没排空就主动中断：drain 只是等，等不来的轮次必须被 abort，否则它们要么把进程
  // 拖到 systemd 的 SIGKILL，要么在退出后留下 running 行等下次 recoverAfterCrash 认领（docs/24 · R-OPS-01）。
  if (!(await turnRegistry.drain(config.general.shutdown.graceMs))) {
    turnRegistry.abortAll("shutdown");
    await turnRegistry.drain(Math.min(1000, config.general.shutdown.graceMs));
  }
  // 还没开成轮次的那些 update（正在归档、正在下载媒体）不在 turnRegistry 里。不等它们收尾就
  // `closeDatabase`，那几条写会撞上「database is not open」，消息凭空消失且只留一行 tg.error。
  if (slots.poller)
    await slots.poller.drain(Math.min(2000, config.general.shutdown.graceMs));
  await closed;
  if (force) clearTimeout(force);
  // 后五件（plugins / mcp / acp / skills / log）收在 `dispose.close()` 里，顺序与「为什么排在
  // turnRegistry.abortAll 之后」的注释同样在 compose.ts。
  await dispose.close();
  closeDatabase(db);
  // 锁最后才放：库关完了才轮到下一个实例进来。留着不放也只是让下一次启动多走一次 stale 接手，
  // 不会把人锁在外面（`acquireInstanceLock` 判的是 PID 还活着没有）。
  instanceLock.lock.release();
  process.exitCode = 0;
};
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
// 一次 uncaught 的流错误可以直接带走进程，而日志里一个字都不留 —— 上一次排查只能靠翻数据库
// 猜「最后一条 turn.start 之后发生了什么」。所以崩之前必须留下原因。
//
// **stderr 先写、`log.event` 后调、`process.exit` 最后。** 原先是反的，于是整个处理器
// 依赖「log.event 不会抛」这条当时并不成立的假设：`insertLog` 曾是裸的，库满/被锁/已 close
// 时它抛出来，这个处理器自己变成新的 uncaughtException —— 原因没留下，退出码也没设上。
// sink 侧现在也不抛了（`LogSink.event` 入库失败返回 0），但顺序不该赌另一个文件的实现细节。
const fatalDetail = (error: unknown): string =>
  error instanceof Error ? (error.stack ?? error.message) : String(error);
const fatalSummary = (event: string, error: unknown): string =>
  `${event}: ${error instanceof Error ? error.message : String(error)}`;
process.on("uncaughtException", (error: unknown) => {
  const detail = fatalDetail(error);
  process.stderr.write(
    tagged("error", `[crash] uncaughtException: ${detail}\n`),
  );
  // `system.crash` 在 LogSink 里被标成 urgent（appendFileSync 立刻落盘），所以这一行在
  // 下面那个 exit 之前是真的写完了的，不是靠 200ms 的缓冲定时器。
  log.event({
    level: "error",
    kind: "system.crash",
    summary: fatalSummary("uncaughtException", error),
    data: { event: "uncaughtException", detail },
  });
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
process.on("unhandledRejection", (error: unknown) => {
  const detail = fatalDetail(error);
  process.stderr.write(
    tagged("error", `[unhandled] unhandledRejection: ${detail}\n`),
  );
  log.event({
    level: "error",
    kind: "system.unhandled_rejection",
    summary: fatalSummary("unhandledRejection", error),
    data: { event: "unhandledRejection", detail },
  });
});

// webhook 模式整体没有实现（docs/11 §2.0.1）。**判在 HTTP 监听之前** —— 它排在下面 Telegram
// 那一段里的时候，`/api/health` 已经回了一整个窗口的 ok，而这个进程接下来就要死。
if (process.env.BOT_TOKEN && config.telegram.mode !== "polling") {
  throw new Error(
    `telegram.mode=${config.telegram.mode} is not implemented; only polling is supported`,
  );
}
// `webui.enabled=false`：整个 HTTP 面不监听。这不只是省一个端口 —— 单口令 + owner 全权限的
// 控制台是这个部署最大的攻击面，只跑 Telegram 的场景该能把它整个关掉。
// 代价要说清楚：**审批只剩 Telegram 那一条裁决通道**（回执上的 inline keyboard，docs/05 §6.1）。
// 连 `BOT_TOKEN` 都没有时两条都没有，命中审批规则的调用会被当场拒绝（docs/24 · R-APPR-01）。
http = config.webui.enabled
  ? serve({
      fetch: server.fetch,
      hostname: config.webui.host,
      port: config.webui.port,
    })
  : null;
if (!config.webui.enabled)
  log.event({
    level: "warn",
    kind: "webui.disabled",
    summary: process.env.BOT_TOKEN
      ? "WebUI disabled by config; approvals can only be decided from Telegram"
      : "WebUI disabled by config and no BOT_TOKEN; approvals will be rejected outright",
  });
events.subscribe((event) => {
  if (event.type !== "config.changed") return;
  // 载荷形状与它的理由在 `packages/core/src/events.ts` 的 `ConfigChangedEvent`。
  const changed = event.data as {
    keys?: string[];
    reconciled?: readonly string[];
  };
  const keys = changed.keys ?? [];
  const reconciled = changed.reconciled ?? [];
  void loadConfig({
    overrides: envOverlay(
      readPersistedConfig(config.db.path, reportRejectedKey),
    ),
    onInvalidOverride: (dropped, reasons) =>
      log.event({
        level: "error",
        kind: "config.invalid",
        summary: `已忽略 ${dropped.length} 条非法覆盖`,
        data: { dropped, reasons },
      }),
  })
    .then((next) => {
      configStore.replace(next, keys);
      if (keys.some((key) => key.startsWith("logs.level")))
        log.setLevel(next.logs.level);
      if (keys.some((key) => key.startsWith("logs.redactPatterns")))
        log.redactPatterns = next.logs.redactPatterns;
      // 编码方式逐行记在 `data_codec` 上，所以这个开关只作用于**此后**写入的行，
      // 已压缩的照读 —— 它因此能安全热更新（`logs.dbPath` 不能，它在启动时就被 ATTACH 走了）。
      if (keys.some((key) => key.startsWith("logs.compress")))
        operations.compressLogPayloads = next.logs.compress;
      if (
        keys.some(
          (key) =>
            key.startsWith("provider.") ||
            key.startsWith("model") ||
            key === "tools.web.searchApiKey",
        )
      )
        rebuildModels();
      if (keys.some((key) => key.startsWith("skills."))) skills.scan();
      if (keys.some((key) => key.startsWith("plugins.")))
        void plugins.reconcile();
      // McpManager 现在按 getter 读配置，但连接是有状态的：改了 servers 必须重跑一次 reconcile
      // 才会真的连上/断开（docs/20 · W-CFG-02）。
      // `reconciled` 里带 'mcp' 的是 WebUI 的 `/api/mcp*` —— 那几个端点自己 `await` 了一次
      // reconcile（响应里要给出真实 state），这里再跑就是两条重叠（docs/28 · L-EXT-03）。
      // 模型侧的 `install_mcp` 不带这个标记，仍由这一行负责。
      if (
        !reconciled.includes("mcp") &&
        keys.some((key) => key.startsWith("mcp."))
      )
        void mcp.reconcile();
      // `tools.selfExtend` 在 `HOT_RELOADABLE_CONFIG_KEYS` 里，靠的就是这一行：关掉
      // `customTools.enabled` 之后下一轮那批工具要真的从目录里消失，而不是等重启（docs/20 · W-CFG-02）。
      if (keys.some((key) => key.startsWith("tools.selfExtend")))
        customTools.reconcile();
      // cron 是「构造即排期」，改配置不会自己重挂 —— `mcp.healthCheckCron` 正是因为缺这条线，
      // 整段 `mcp` 才被移出热更新白名单（见那一段注释）。整段 `sandbox` 要留在白名单里就得接上它。
      if (keys.some((key) => key === "sandbox.persistent.reapCron")) {
        scheduler.remove("sandbox-reap");
        scheduler.add(
          next.sandbox.persistent.reapCron,
          reapContainers,
          "sandbox-reap",
        );
      }
      log.event({
        level: "info",
        kind: "config.changed",
        summary: "Runtime configuration reloaded",
        data: { keys },
      });
    })
    .catch((error) =>
      log.event({
        level: "error",
        kind: "config.invalid",
        summary: error instanceof Error ? error.message : String(error),
      }),
    );
});
log.event({
  level: "info",
  kind: "system.start",
  summary: `${config.general.name} started`,
  data: {
    name: config.general.name,
    webui: `${config.webui.host}:${config.webui.port}`,
    providerSecrets: secrets.available,
  },
});
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
    slots.bot = await createTelegramBot(process.env.BOT_TOKEN, {
      config: configStore,
      db,
      principals,
      archive,
      operations,
      context,
      turns,
      quota,
      memory,
      plugins,
      tools: toolRegistry,
      approvals: approval,
      // `a:` 那批回调（inline keyboard 审批）从这里查等待者；裁决本身仍走 `claim` → `approval.decide`。
      prompts: approvalPrompts,
      registry: turnRegistry,
      concurrency: turnConcurrency,
      log,
      // `/usage` 读它而不是 `turns`：试跑写 ledger 但不建 turns 行（docs/29 · M-QUOTA-01）。
      ledger,
      // `/ping` 的上线时长。与 `createServer` 收的是同一个值。
      startedAt,
      alerts,
      failures: turnFailures,
      issueLoginToken: () => issueLoginToken(),
      // 关停期间被 abort 的长轮询记 info 而不是 error（docs/28 · L-TG-01）。
      stopping: () => shuttingDown,
      estimateTurnCost: (inputTokens, key) =>
        modelRegistry.estimate(
          readAppKv<string>(db, modelAliasKey(key)) ??
            perChatConfig(configStore.snapshot(), key).agent.main.modelAlias,
          inputTokens,
        ),
      // 用 turn.config 而不是全局快照：本轮的 perChat 覆盖已经在 openTurn 时合并进去了。
      onTurn: (turn, reservation) => {
        const live = turn.config as Readonly<typeof config>;
        return streamMainAgent(turn, {
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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.event({
      level: "error",
      kind: "tg.error",
      summary: `Telegram 入口启动失败：${message}`,
      data: { phase: "init", fatal: false },
    });
    process.stderr.write(
      tagged(
        "error",
        `[telegram] bot 初始化失败（token 失效、已撤销，或网络不可达）：${message}\n` +
          `[telegram] Telegram 入口已禁用，WebUI 正常启动；请在 http://${config.webui.host}:${config.webui.port} 更换 BOT_TOKEN 后重启。\n`,
      ),
    );
  }
}
if (slots.bot) {
  // 上一次进程留在屏幕上的那些审批按钮此刻已经点不动了（等待者是进程内的 Promise，跨不了重启），
  // 而一排点不动的按钮就是下一次误点。`staleKeyboards()` 读完顺手清列，所以这一趟只跑一次
  // （`docs/05 §6.1`；那一列存在的意义就是这个待办队列）。正文也一起换掉：那些消息还写着
  // 「N 秒内没人处理就会自动拒绝」，而它们等的那个进程已经不在了（`AC-APV-004` 同一条理由）。
  //
  // **排在 `poller.start()` 之前**：拉到的第一条 update 就可能命中审批规则并往那一列写一行，
  // 而这趟扫描不认「这一行是刚写的」—— 反过来就会把一条活着的键盘当残留撤掉。
  for (const stale of approval.staleKeyboards())
    approvalPrompts.dismiss(
      stale,
      approvalSettledText(stale.tool, staleApprovalOutcome(stale.state)),
    );
  // `dropPendingOnStart`：停机期间积压的 update 直接丢掉，不补跑。默认关 —— 丢的是真实用户
  // 发过的消息。开它的场景是长时间停机后重启，不想让 bot 对着一小时前的话题连开几十轮。
  //
  // 不用 grammY 的 `bot.start()`：它逐条串行处理 update，`TurnConcurrency` 因此永远争用不到
  // （第二个人得等第一个人整轮跑完，docs/01 §3 的 global / perKey / queueMax 形同虚设）。
  // 在途上限取 `global + queueMax`：超出这个数再拉进来的轮次也只会被 `acquire` 顶回去。
  {
    slots.poller = new UpdatePoller(slots.bot, {
      allowedUpdates: config.telegram.allowedUpdates,
      dropPendingUpdates: config.telegram.dropPendingOnStart,
      maxInFlight: config.concurrency.global + config.concurrency.queueMax,
      onError: (error, phase) =>
        log.event({
          level: phase === "fetch" ? "warn" : "error",
          kind: "tg.error",
          summary: error instanceof Error ? error.message : String(error),
          data: { phase },
        }),
      // 401 / 409 说明这个 token 不该由本进程轮询（撤销了，或者另一个实例正在拉）。原先
      // `void bot.start()` 在这两种错误上 rethrow，经 unhandledRejection 变成 exit(1)；
      // 保留「死掉让 supervisor 重启」这一半，但走优雅关闭，别把 WAL 和日志留在半截状态。
      onFatal: (error) => {
        log.event({
          level: "error",
          kind: "tg.error",
          summary: `polling aborted: ${error instanceof Error ? error.message : String(error)}`,
          data: { fatal: true },
        });
        process.stderr.write(
          tagged(
            "error",
            `[telegram] 轮询被 Telegram 拒绝（token 失效，或另有实例正在轮询同一个 bot）：${error instanceof Error ? error.message : String(error)}\n`,
          ),
        );
        void shutdown("telegram:fatal").then(() => {
          process.exitCode = 1;
        });
      },
    });
    slots.poller.start();
  }
  // owner 私聊通道到这里才具备。`sendMessage` 失败由 AlertDispatcher 自己吞掉并记一条
  // `alert.deliver_failed` —— owner 没跟 bot 说过话时 Telegram 会拒发，那不该把告警链路带崩。
  const ownerChatId = configStore.snapshot().access.bootstrapOwnerId;
  if (ownerChatId)
    slots.notifyOwner = (text) => slots.bot!.api.sendMessage(ownerChatId, text);
  // 到这里投递通道才具备，定时任务可以装回 cron 了。停机期间错过的不补跑，只在日志里说出来
  // （需求方决策；`load()` 每条错过的任务记一条 schedule.missed）。
  const loaded = scheduleRunner.load();
  log.event({
    level: "info",
    kind: "schedule.loaded",
    summary: `装载 ${loaded.registered} 个定时任务`,
    data: { ...loaded, enabled: config.schedule.enabled },
  });
} else {
  // 缺 token 与 token 失效（上面那个 catch）从这里起走同一条路。
  log.event({
    level: "warn",
    kind: "system.start",
    summary: process.env.BOT_TOKEN
      ? "Telegram ingress disabled: bot init failed"
      : "BOT_TOKEN missing; Telegram ingress disabled",
  });
  // 没有 Telegram 就没有投递通道。不装载而不是装载后每次触发失败：库里的任务原样留着，
  // 配上 token 重启就会继续跑。
  const pending = scheduledJobs.listActive().length;
  if (pending)
    log.event({
      level: "warn",
      kind: "schedule.skipped",
      summary: `${pending} 个定时任务未装载：没有 Telegram 投递通道`,
      data: { reason: "telegram_unavailable", pending },
    });
}
