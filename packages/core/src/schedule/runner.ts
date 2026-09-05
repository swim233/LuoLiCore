import { Cron } from "croner";
import type { Role, RuntimeTurnContext } from "@luoli/shared";
import { minRole } from "@luoli/shared";
import {
  contextKey,
  type AppendedMessage,
  type ArchiveRepository,
  type ScheduleRepository,
  type ScheduledJob,
  type Sqlite,
  type TurnRepository,
} from "@luoli/db";
import { resolveEffectiveRole } from "../access.js";
import type { TurnFailureStreak } from "../alerts.js";
import type { Config } from "../config/schema.js";
import { perChatConfig } from "../config/index.js";
import type { ContextEngine } from "../context/engine.js";
import type { LogSink } from "../log/sink.js";
import type { MemoryStore } from "../memory/store.js";
import type { QuotaGuard, QuotaReservation } from "../ledger/quota.js";
import type { Scheduler } from "../scheduler.js";
import type { TelegramToolBridge } from "../tools/builtins.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { TurnConcurrency } from "../turn/concurrency.js";
import { runTurn } from "../turn/pipeline.js";
import type { TurnRegistry } from "../turn/registry.js";

/**
 * 合成触发消息的 `tg_message_id` 保留段。
 *
 * `openTurn` 的 `trigger` 必须是一条真实归档行，而 `messages.tg_message_id` 为 `NOT NULL`
 * 且有 `UNIQUE(chat_id, tg_message_id, revision)`。使用负数会使其排在全部真实消息之前，
 * 破坏 `claimThroughMessageId` 的背景认领窗口；使用 `MAX+1` 则可能与下一条真实消息冲突，
 * 而 `append` 是 `INSERT OR IGNORE` —— 冲突时会静默丢弃真实用户消息。因此选取一个真实
 * Telegram 消息号永远无法到达的高位段（按会话计数，见 `#allocateTriggerId`）。
 */
export const SYNTHETIC_TG_MESSAGE_ID_BASE = 2_000_000_000;

/**
 * 一次触发的最终状态，写入 `scheduled_jobs.last_state`。
 *
 * 该联合类型即该列取值的权威定义 —— 迁移 0013 说明了该列为何没有 CHECK 约束。
 * `silent` 与 `committed` 必须分为两档：静默按设计不产生输出，并入 `committed` 后
 * 该任务持续处于静默这一事实在库中不再留下任何痕迹（docs/02 §10.5 的四层分辨手段之一）。
 */
export type ScheduledRunState =
  "committed" | "silent" | "failed" | "skipped" | "missed" | "cancelled";

/**
 * 连续静默多少次后 `schedule.silent` 由 info 提升为 warn。
 *
 * 采用代码常量而非配置键（沿用 `PROVIDER_FAILURES_TO_DOWN` 的先例）：这是发现定时器只产生费用
 * 而无输出的机制，不是需按部署调整的策略 —— 而每多一个配置键就多一处可被调到永不触发的位置。
 */
export const SILENT_STREAK_WARN = 10;

export interface ScheduledJobRunnerDependencies {
  db: Sqlite;
  jobs: ScheduleRepository;
  scheduler: Scheduler;
  context: ContextEngine;
  archive: ArchiveRepository;
  turns: TurnRepository;
  registry: TurnRegistry;
  concurrency: TurnConcurrency;
  quota: QuotaGuard;
  memory: MemoryStore;
  tools: ToolRegistry;
  log: LogSink;
  config(): Readonly<Config>;
  /**
   * 惰性取值：工具在 bot 构造之前即完成注册，而投递通道要到 `createTelegramBot` 之后才存在。
   *
   * 装配方必须保证它在 bot 真正启动之后才非空。它此前提供的是只要有 `BOT_TOKEN` 就立即非空的
   * 外层对象，导致下方 `fire()` 中的 `telegram_unavailable` skip 分支成为死代码：
   * HTTP 从 `serve()` 起即开始监听，启动窗口内经 `POST /api/schedules/:id/trigger` 手动触发的
   * 任务会正常开轮、执行模型调用、记账，最后以 `delivery_failed:telegram_unavailable` 收尾且
   * 不提交 —— 产生了费用而上下文中没有留下任何记录（docs/28 · L-SCH-01）。
   */
  telegram(): TelegramToolBridge | null;
  roleOf(kind: "user" | "chat", tgId: string): Role | null;
  /**
   * 连续失败计数。与 Telegram 轮次共用同一份（装配方创建一个并传入两处）：该告警表达的是
   * 本部署已故障，而它此前只存在于 `createTelegramBot` 的闭包中 —— 上游无响应时，
   * 无人聊天的部署中每次定时触发都超时，却一次告警都不触发（docs/28 · L-SCH-02）。
   */
  failures?: TurnFailureStreak;
  /**
   * `mode:'agent'` 的实际执行，签名与 `main.ts` 的 `onTurn` 一致 —— 装配方在那里注入
   * `runMainAgent`（非流式：定时轮次无人实时查看，也没有 Telegram 流消费者）。
   */
  runAgent(
    turn: RuntimeTurnContext,
    reservation: QuotaReservation | null,
  ): Promise<string>;
  approvals?: { releaseTurn(turnId: string): void };
  plugins?: { hook(name: string, payload: unknown): Promise<unknown> };
  estimateTurnCost?(inputTokens: number, key: string): number | null;
}

const jobCronName = (id: string): string => `job:${id}`;

/**
 * 定时任务的执行器。
 *
 * 开启轮次的流程严格沿用 `packages/telegram/src/bot.ts` 的路径（配额 → 并发闸 → openTurn →
 * turns.create → 产出 → appendDelta → commitTurn），仅去除流式输出、占位消息与 inline `/cancel`
 * —— 定时轮次无人实时查看。`turnRegistry.register` 这一步不可省略：未注册的轮次既无法
 * `/cancel`，也不出现在 `GET /api/turns/active` 中，一旦卡住运维完全无法观察到它。
 */
export class ScheduledJobRunner {
  #loaded = false;

  constructor(private readonly dependencies: ScheduledJobRunnerDependencies) {}

  /**
   * `load()` 是否已执行 —— 即投递通道是否已具备。
   *
   * `POST /api/schedules/:id/trigger` 用它拦截启动窗口：HTTP 从 `serve()` 起即开始监听，而 `load()`
   * 需等待 bot 启动（装配方的注释一直正确），因此 cron 触发本就安全，遗漏的只有手动触发
   * （docs/28 · L-SCH-01）。`telegram()` 的判据仍在 `fire()` 中兜底 —— 本条是为了让手动
   * 触发在响应中即可说明未执行的原因，而不是返回 `started:true` 后在日志中写一条 skipped。
   */
  get loaded(): boolean {
    return this.#loaded;
  }

  /**
   * 进程启动时将库中的活跃任务重新装载到 cron。
   *
   * 停机期间错过的任务不补跑（需求方决策）：一次性任务过期直接置为 `done` 并记录 `schedule.missed`，
   * 周期任务只记录一条 warn 后照常安排下一次。在 9 点补发一条 4 点的早报比不发更令人困惑，
   * 与 `telegram.dropPendingOnStart` 是同一取舍。
   */
  load(): { registered: number; missed: number } {
    let registered = 0;
    let missed = 0;
    this.#loaded = true;
    for (const job of this.dependencies.jobs.listActive()) {
      const skew = this.#missedSince(job);
      if (skew) {
        missed += 1;
        this.dependencies.log.event({
          level: "warn",
          kind: "schedule.missed",
          summary: `定时任务 ${job.name} 在停机期间错过了触发`,
          chatId: job.chatId,
          key: job.key,
          data: {
            job: job.id,
            name: job.name,
            expected: skew.toISOString(),
            mode: job.mode,
            catchUp: false,
          },
        });
        // 一次性任务的触发时间已过，保留 active 只会在库中长期留下一条永不触发的任务。
        if (job.runAt !== null) {
          this.dependencies.jobs.finish(job.id, "done", "missed");
          continue;
        }
      }
      if (this.register(job)) registered += 1;
    }
    return { registered, missed };
  }

  /** 注册（或重新注册）一个任务的 cron。返回 false 表示该任务不应再被安排。 */
  register(job: ScheduledJob): boolean {
    const name = jobCronName(job.id);
    this.dependencies.scheduler.remove(name);
    const when = job.runAt === null ? job.cron! : new Date(job.runAt);
    if (job.runAt !== null && job.runAt <= Date.now()) return false;
    try {
      this.dependencies.scheduler.add(when, () => this.fire(job.id), name, {
        timezone: job.timezone,
        ...(job.runAt === null ? {} : { maxRuns: 1 }),
      });
      return true;
    } catch (error) {
      // 非法表达式在创建时即被拦截，执行到此说明库中该行经手工修改或为跨版本残留 —— 停用并记录。
      this.dependencies.jobs.finish(job.id, "cancelled", "failed");
      this.dependencies.log.event({
        level: "error",
        kind: "schedule.failed",
        summary: `定时任务 ${job.name} 无法注册，已停用`,
        chatId: job.chatId,
        key: job.key,
        data: {
          job: job.id,
          cron: job.cron,
          runAt: job.runAt,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      return false;
    }
  }

  unregister(id: string): boolean {
    return this.dependencies.scheduler.remove(jobCronName(id));
  }

  nextRun(id: string): Date | null {
    return this.dependencies.scheduler.nextRun(jobCronName(id));
  }

  /** 一次触发。所有异常在此收口 —— 在 croner 的 `catch` 与 `Scheduler.onError` 之外再兜一层。 */
  async fire(id: string): Promise<void> {
    const job = this.dependencies.jobs.byId(id);
    if (!job || job.state !== "active") {
      this.unregister(id);
      return;
    }
    const live = this.dependencies.config();
    if (!live.schedule.enabled) {
      this.#skip(job, "schedule.disabled");
      return;
    }
    const { role, userRole, chatRole } = this.#effectiveRole(job, live);
    // 创建后被降级或拉黑的用户不应继续通过 bot 产生费用。blocked 是永久判定 —— 停用该任务；
    // 仅降至 trusted 以下（`schedule_create` 的 minRole）则跳过本次，权限恢复后任务仍在。
    if (role === "blocked") {
      this.dependencies.jobs.finish(job.id, "cancelled", "cancelled");
      this.unregister(job.id);
      // 文案需按实际命中的一侧生成。判据是「私聊只看用户角色，群 / 频道取两侧较高者再封顶
      // trusted」，而此处此前写死为创建者已被封禁 —— 被封的是会话时同样如此表述，会导致运维
      // 排查错误的对象（docs/28 · L-SCH-04）。取较高者不影响这条推理：`blocked` 是任一侧一票
      // 否决且先于抬升判定，因此有效角色为 blocked 而用户角色不是时，必定是会话一侧命中。
      const culprit =
        userRole === "blocked"
          ? `创建者 user:${job.createdBy}`
          : `会话 chat:${job.chatId}`;
      this.dependencies.log.event({
        level: "warn",
        kind: "schedule.cancelled",
        summary: `定时任务 ${job.name} 的${culprit}已被封禁，任务已停用`,
        chatId: job.chatId,
        key: job.key,
        data: { job: job.id, role, userRole, chatRole },
      });
      return;
    }
    if (minRole(role, "trusted") !== "trusted") {
      this.#skip(job, "role_downgraded", { role, userRole, chatRole });
      return;
    }
    // 该判据必须排在 `#run` 之前（配额预留、并发闸、`openTurn` 均在其中）：无法投递的轮次
    // 即使开启也没有意义，会产生模型费用而上下文中不留任何记录（docs/28 · L-SCH-01）。
    const bridge = this.dependencies.telegram();
    if (!bridge) {
      this.#skip(job, "telegram_unavailable");
      return;
    }
    await this.#run(job, role, live, bridge);
  }

  /** 轮次级事件挂在 trace 根节点之下（`docs/10 §1`）。 */
  #parent(turn: RuntimeTurnContext): { parentSpanId?: string } {
    return turn.rootSpanId ? { parentSpanId: turn.rootSpanId } : {};
  }

  /**
   * 轮次核心（配额预留之后、markRun 之前）交给 `runTurn()`（`docs/02` §10.6，`docs/12-sdk.md` §14.1
   * Q-A）：并发闸、`openTurn`/`turns.create`、`turn.queued`/`turn.start`/`turn.end`/
   * `turn.finished` 通用日志、四条不变量（并发槽释放、配额释放、`abortTurn` 抛出后仍
   * `turns.finish`、`appendDelta`/`commitTurn` 排在合流点之后）均由它保证，本方法只保留
   * 触发前的判定（配额是否需要预留）与三处调用方特有的逻辑：合成消息的归档与 id 核对
   * （`buildTrigger`）、投递（`deliver`）、模型产出或预写正文（`produce`）。
   */
  async #run(
    job: ScheduledJob,
    role: Role,
    live: Readonly<Config>,
    bridge: TelegramToolBridge,
  ): Promise<void> {
    const chatConfig = perChatConfig(live, job.key);
    const isPrivate = !job.chatId.startsWith("-");
    // notify 不调用模型，因此不占用额度；agent 走与用户轮次完全相同的配额闸。
    const reservation =
      job.mode === "agent" ? this.#reserve(job, role, live) : null;
    if (job.mode === "agent" && live.quota.enabled && !reservation) {
      this.#skip(job, "quota_exceeded");
      return;
    }
    // 群名从库中读取：该路径没有 Telegram update 可用，而 RUNTIME 的会话行需要它。
    // 权威副本是 `principals` 中的 `chat:<id>`（`upsertSeen` 每条消息刷新一次 `display_name`）。
    // 私聊查不到是预期结果、不是待修的 bug：私聊不占 `chat:` 行，而 `chatTitle` 的契约就是
    // 「群名 / 频道名，私聊无此值」（`chatDescription` 对私聊直接返回「私聊」，根本不读它）。
    // 回落去查同 id 的 `user:` 行会把对方的显示名漏进提示词。
    //
    // 这条查询在 `runTurn()` 之外、`reservation` 之后执行：`runTurn()` 只负责释放传给它的
    // reservation，这一步若抛出（DB 故障），reservation 还没交给 `runTurn()`，必须在这里
    // 自己兜底释放，否则它会永久卡在 `quota_counters.reserved_usd` 里——`fire()` 对 `#run()`
    // 没有外层 try，抛出还会带走整条触发链路（R-BOT-01 的同一类问题，只是发生在 `runTurn()`
    // 调用之前）。
    let chatTitle: string | null;
    try {
      chatTitle = this.dependencies.db
        .prepare(
          "SELECT display_name FROM principals WHERE kind='chat' AND tg_id=?",
        )
        .pluck()
        .get(job.chatId) as string | null;
    } catch (error) {
      if (reservation) this.dependencies.quota.release(reservation);
      this.#failed(job, error);
      return;
    }
    const result = await runTurn({
      dependencies: {
        context: this.dependencies.context,
        turns: this.dependencies.turns,
        registry: this.dependencies.registry,
        concurrency: this.dependencies.concurrency,
        quota: this.dependencies.quota,
        tools: this.dependencies.tools,
        memory: this.dependencies.memory,
        log: this.dependencies.log,
        ...(this.dependencies.approvals
          ? { approvals: this.dependencies.approvals }
          : {}),
        ...(this.dependencies.plugins
          ? { plugins: this.dependencies.plugins }
          : {}),
        ...(this.dependencies.failures
          ? { failures: this.dependencies.failures }
          : {}),
      },
      chatId: job.chatId,
      threadId: job.threadId,
      key: job.key,
      initiatorUserId: job.createdBy,
      effectiveRole: role,
      isPrivate,
      ...(chatTitle ? { chatTitle } : {}),
      // `silenceable` 只从此处传入（docs/02 §10.5）：其余构造 turn 的位置一律不传，因此模型可以
      // 声明不投递这一能力在结构上只可能出现在启用 allow_silent 的定时轮次中。
      ...(job.allowSilent ? { silenceable: true } : {}),
      config: chatConfig,
      turnTimeoutMs: live.concurrency.turnTimeoutMs,
      triggerReason: "schedule",
      reservation,
      logExtra: { schedule: job.id },
      // 合成触发消息：`[定时任务 <名字>] <正文>` 作为一条 from_kind='system' 的入站消息写入归档，
      // 使上下文中呈现为一次正常对话，用户可直接接续 bot 的回答（需求方决策：照常进入上下文）。
      // 不使用 untrusted() 包裹：该文本是 owner 或 trusted 自行创建的任务，包裹等于告知模型忽略它。
      buildTrigger: () => this.#appendTrigger(job),
      // `notify` 不调用模型，直接返回预写正文；`agent` 与 `bot.ts` 共用的 `runAgent` 依赖一致。
      produce:
        job.mode === "notify"
          ? () => Promise.resolve(job.payload)
          : (turn, turnReservation) =>
              this.dependencies.runAgent(turn, turnReservation),
      deliver: (turn, answer) =>
        bridge.sendMessage(
          {
            chatId: job.chatId,
            threadId: job.threadId,
            turnId: turn.turnId,
            ...(turn.rootSpanId ? { parentSpanId: turn.rootSpanId } : {}),
          },
          answer,
        ) as Promise<{ ok?: boolean; error?: string }>,
      onOpened: (turn) =>
        this.dependencies.log.event({
          level: "info",
          kind: "schedule.fired",
          summary: `定时任务 ${job.name} 触发`,
          traceId: turn.turnId,
          ...this.#parent(turn),
          chatId: job.chatId,
          userId: job.createdBy,
          key: job.key,
          data: {
            job: job.id,
            name: job.name,
            mode: job.mode,
            role,
            runCount: job.runCount,
          },
        }),
    });

    if (result.ok) {
      if (result.silenced) {
        // `job.silentStreak` 是本次触发之前的值，下面的 markRun 才会加 1 —— 日志需要表达这是
        // 连续第几次，因此此处先加。`last_error` 在静默路径上恒为 NULL（markRun 不传 error），
        // 这是区分静默与 failed / skipped 的第二层手段。
        const streak = job.silentStreak + 1;
        this.dependencies.log.event({
          level: streak >= SILENT_STREAK_WARN ? "warn" : "info",
          kind: "schedule.silent",
          summary: `定时任务 ${job.name} 本轮不用汇报（连续第 ${streak} 次）`,
          traceId: result.turn.turnId,
          ...this.#parent(result.turn),
          chatId: job.chatId,
          userId: job.createdBy,
          key: job.key,
          // 使用 `?? null` 而非条件展开：该日志是判断任务是否从此不再产生输出的唯一可读凭据，
          // 字段恒存在才便于 grep 与过滤。reason 缺失说明置位方只完成了一半（见 `silenceReason`）。
          data: {
            job: job.id,
            name: job.name,
            mode: job.mode,
            streak,
            warnAt: SILENT_STREAK_WARN,
            reason: result.turn.silenceReason ?? null,
          },
        });
        this.dependencies.jobs.markRun(job.id, { state: "silent" });
      } else {
        this.dependencies.jobs.markRun(job.id, { state: "committed" });
      }
    } else if (result.stage === "queue") {
      this.#skip(job, "turn_queue_rejected", { error: result.error });
    } else if (result.stage === "setup") {
      this.#failed(job, new Error(result.error));
    } else {
      this.#failed(job, new Error(result.error), result.turn.turnId);
    }

    // 一次性任务执行完即结束，成功与否都不重试：15:00 的会议提醒在 15:05 才发出已无意义。
    // 但「执行完」须以「轮次真的开过」为界——`result.ok` 或 `stage:'turn'` 都意味着
    // `openTurn`/`turns.create` 已经成功，之后无论产出/投递/提交是否失败都算「跑过一次」；
    // `stage:'queue'`（并发闸拒绝）与 `stage:'setup'`（`buildTrigger`/`openTurn`/`turns.create`
    // 本身抛出）与 `quota_exceeded`（更早处已 return，不会走到这里）是同一类"这一轮压根没开
    // 起来"的失败，与原实现一致地保留 `active`：调用方可通过
    // `POST /api/schedules/:id/trigger` 手动重试，而不是让一次瞬时故障（队列一时占满、
    // 触发消息撞号）直接把一次性任务判"死"。
    const turnOpened = result.ok || result.stage === "turn";
    if (turnOpened && job.runAt !== null) {
      this.dependencies.jobs.finish(job.id, "done");
      this.unregister(job.id);
    }
  }

  /**
   * 从保留高位段分配一个 `tg_message_id`。
   *
   * `append` 是 `INSERT OR IGNORE`：id 冲突时会静默返回既有行，导致本轮的触发消息实际上是
   * 上一次的那条，`claimThroughMessageId` 与 `turns.trigger_message_id` 一并错位。因此
   * 分配后必须核对返回值，不一致即抛出 —— 静默继续执行比直接失败更难排查。
   *
   * 判定 `inserted` 而非比较 `tgMessageId`。后者是本次核对此前的写法，而回读那一行是按入参的
   * id 查询的 —— 返回值的 `tgMessageId` 恒等于分配值，比较永远不成立（docs/28 · L-SCH-03）。
   */
  #appendTrigger(job: ScheduledJob): AppendedMessage {
    const scoped = this.dependencies.archive.scope(job.chatId, job.threadId);
    const highest = this.dependencies.db
      .prepare(
        "SELECT MAX(tg_message_id) FROM messages WHERE chat_id=? AND tg_message_id>=?",
      )
      .pluck()
      .get(job.chatId, SYNTHETIC_TG_MESSAGE_ID_BASE) as number | null;
    const tgMessageId = Math.max(
      SYNTHETIC_TG_MESSAGE_ID_BASE,
      (highest ?? 0) + 1,
    );
    const appended = scoped.append({
      chatId: job.chatId,
      messageThreadId: job.threadId,
      tgMessageId,
      direction: "in",
      fromKind: "system",
      fromUserId: job.createdBy,
      fromName: "定时任务",
      fromUsername: null,
      kind: "text",
      text: `[定时任务 ${job.name}] ${job.payload}`,
      tgDate: Date.now(),
      raw: { schedule: { id: job.id, name: job.name, mode: job.mode } },
      triggered: true,
      triggerReason: "schedule",
    });
    if (!appended.inserted)
      throw new Error(`schedule_trigger_conflict:${tgMessageId}`);
    return appended;
  }

  /**
   * 有效角色：私聊只看用户角色；群 / 频道任一侧 blocked 即 blocked，否则取两侧较高者再封顶
   * trusted（docs/05 §2.2）。两侧一并返回：告警文案需说明是哪一侧命中
   * （docs/28 · L-SCH-04），而判据本身仍只有 `resolveEffectiveRole` 一份 —— 在此重新计算默认值
   * 规则即构成第二份判据。`chatRole` 是库中存储的值，null 表示使用了默认值。
   */
  #effectiveRole(
    job: ScheduledJob,
    live: Readonly<Config>,
  ): { role: Role; userRole: Role; chatRole: Role | null } {
    const userRole =
      this.dependencies.roleOf("user", job.createdBy) ??
      live.access.defaultUserRole;
    const chatRole = this.dependencies.roleOf("chat", job.chatId);
    return {
      role: resolveEffectiveRole({
        userRole,
        ...(chatRole ? { chatRole } : {}),
        isPrivate: !job.chatId.startsWith("-"),
        defaultChatRole: live.access.defaultChatRole,
      }),
      userRole,
      chatRole,
    };
  }

  #reserve(
    job: ScheduledJob,
    role: Role,
    live: Readonly<Config>,
  ): ReturnType<QuotaGuard["reserve"]> | null {
    if (!live.quota.enabled) return null;
    const roleLimits = live.quota.perUser.byRole[role];
    const estimatedTokens = Math.max(
      this.dependencies.context.windowTokens(job.key) + live.prompt.maxTokens,
      1000,
    );
    const estimate =
      this.dependencies.estimateTurnCost?.(estimatedTokens, job.key) ?? null;
    return this.dependencies.quota.reserve({
      chatId: job.chatId,
      userId: job.createdBy,
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
    });
  }

  /** 跳过一次触发：任务保留，下次照常执行。计一次 run，使 `schedule_list` 能看出它在空转。 */
  #skip(
    job: ScheduledJob,
    reason: string,
    data: Record<string, unknown> = {},
  ): void {
    this.dependencies.jobs.markRun(job.id, { state: "skipped", error: reason });
    this.dependencies.log.event({
      level: "warn",
      kind: "schedule.skipped",
      summary: `定时任务 ${job.name} 本次跳过：${reason}`,
      chatId: job.chatId,
      key: job.key,
      data: { job: job.id, name: job.name, reason, ...data },
    });
  }

  #failed(job: ScheduledJob, error: unknown, turnId?: string): void {
    const message = error instanceof Error ? error.message : String(error);
    this.dependencies.jobs.markRun(job.id, { state: "failed", error: message });
    this.dependencies.log.event({
      level: "error",
      kind: "schedule.failed",
      summary: `定时任务 ${job.name} 失败：${message}`,
      ...(turnId ? { traceId: turnId } : {}),
      chatId: job.chatId,
      key: job.key,
      data: { job: job.id, name: job.name, error: message },
    });
  }

  /** 上一次触发（或创建）之后是否存在已过去的触发时间点。存在则返回该时刻，否则返回 null。 */
  #missedSince(job: ScheduledJob): Date | null {
    const now = Date.now();
    if (job.runAt !== null)
      return job.runAt <= now ? new Date(job.runAt) : null;
    try {
      const since = new Date(job.lastRunAt ?? job.createdAt);
      const expected = new Cron(job.cron!, { timezone: job.timezone }).nextRun(
        since,
      );
      return expected && expected.getTime() <= now ? expected : null;
    } catch {
      return null;
    }
  }
}

/** 工具侧与装配侧共用：会话键的计算方式只有一份实现。 */
export const scheduleContextKey = (
  chatId: string,
  threadId: number | null,
  scope: "chat" | "thread",
): string => contextKey({ chatId, messageThreadId: threadId }, scope);
