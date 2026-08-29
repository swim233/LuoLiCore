import { Cron } from "croner";
import { ulid } from "ulid";
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
    const pendingId = `job_${ulid()}`;
    const pending = this.dependencies.registry.register(
      {
        id: pendingId,
        key: job.key,
        chatId: job.chatId,
        userId: job.createdBy,
        role,
      },
      live.concurrency.turnTimeoutMs,
    );
    let release: (() => void) | null = null;
    // 与 `bot.ts` 使用同一判据（docs/28 · L-LOG-01）：只有确实排队时才记录 `turn.queued`，
    // `turn.start` 一律携带 `waitedMs`。定时轮次触发并发闸的概率不低于用户轮次 —— 它们常同时到期。
    const queuedAt = Date.now();
    const wasQueued = !this.dependencies.concurrency.available(job.key);
    const queueSnapshot = {
      active: this.dependencies.concurrency.active,
      queued: this.dependencies.concurrency.queued,
    };
    try {
      release = await this.dependencies.concurrency.acquire(
        job.key,
        pending.controller.signal,
      );
    } catch (error) {
      this.dependencies.registry.finish(pendingId);
      if (reservation) this.dependencies.quota.release(reservation);
      this.#skip(job, "turn_queue_rejected", {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    let turn: Awaited<ReturnType<ContextEngine["openTurn"]>>;
    let triggerMessageId: number;
    try {
      // 合成触发消息：`[定时任务 <名字>] <正文>` 作为一条 from_kind='system' 的入站消息写入归档，
      // 使上下文中呈现为一次正常对话，用户可直接接续 bot 的回答（需求方决策：照常进入上下文）。
      // 不使用 untrusted() 包裹：该文本是 owner 或 trusted 自行创建的任务，包裹等于告知模型忽略它。
      const trigger = this.#appendTrigger(job);
      triggerMessageId = trigger.id;
      // 群名从库中读取：该路径没有 Telegram update 可用，而 RUNTIME 的会话行需要它。
      // 权威副本是 `principals` 中的 `chat:<id>`（`upsertSeen` 每条消息刷新一次 `display_name`）。
      // 私聊查不到是预期结果、不是待修的 bug：私聊不占 `chat:` 行，而 `chatTitle` 的契约就是
      // 「群名 / 频道名，私聊无此值」（`chatDescription` 对私聊直接返回「私聊」，根本不读它）。
      // 回落去查同 id 的 `user:` 行会把对方的显示名漏进提示词。
      const chatTitle = this.dependencies.db
        .prepare(
          "SELECT display_name FROM principals WHERE kind='chat' AND tg_id=?",
        )
        .pluck()
        .get(job.chatId) as string | null;
      // `silenceable` 只从此处传入（docs/02 §10.5）：其余构造 turn 的位置一律不传，因此模型可以
      // 声明不投递这一能力在结构上只可能出现在启用 allow_silent 的定时轮次中。
      turn = await this.dependencies.context.openTurn({
        chatId: job.chatId,
        threadId: job.threadId,
        key: job.key,
        initiatorUserId: job.createdBy,
        effectiveRole: role,
        isPrivate,
        trigger,
        ...(chatTitle ? { chatTitle } : {}),
        ...(job.allowSilent ? { silenceable: true } : {}),
        abortSignal: pending.controller.signal,
        config: chatConfig,
      });
      this.dependencies.registry.finish(pendingId);
      const tracked = this.dependencies.registry.register(
        {
          id: turn.turnId,
          key: job.key,
          chatId: job.chatId,
          userId: job.createdBy,
          role,
        },
        live.concurrency.turnTimeoutMs,
      );
      Object.assign(turn, { abortSignal: tracked.controller.signal });
      this.dependencies.turns.create({
        id: turn.turnId,
        key: job.key,
        chatId: job.chatId,
        threadId: job.threadId,
        userId: job.createdBy,
        role,
        triggerMessageId,
        triggerReason: "schedule",
        baseCommitId: turn.baseCommitId,
      });
    } catch (error) {
      this.dependencies.registry.finish(pendingId);
      release();
      if (reservation) this.dependencies.quota.release(reservation);
      this.#failed(job, error);
      return;
    }
    const waitedMs = Date.now() - queuedAt;
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
    });
    if (wasQueued)
      this.dependencies.log.event({
        level: "info",
        kind: "turn.queued",
        summary: `Turn ${turn.turnId} waited ${waitedMs}ms in queue`,
        traceId: turn.turnId,
        ...this.#parent(turn),
        chatId: job.chatId,
        userId: job.createdBy,
        key: job.key,
        durationMs: waitedMs,
        data: { ...queueSnapshot, waitedMs },
      });
    this.dependencies.log.event({
      level: "info",
      kind: "turn.start",
      summary: `Turn ${turn.turnId} started`,
      traceId: turn.turnId,
      ...(turn.rootSpanId ? { spanId: turn.rootSpanId } : {}),
      chatId: job.chatId,
      userId: job.createdBy,
      key: job.key,
      data: { role, triggerReason: "schedule", waitedMs },
    });
    this.dependencies.log.publish("turn.started", {
      turnId: turn.turnId,
      key: job.key,
      chatId: job.chatId,
      user: job.createdBy,
      role,
      triggerReason: "schedule",
      at: Date.now(),
    });
    try {
      const answer =
        job.mode === "notify"
          ? job.payload
          : (await this.dependencies.runAgent(turn, reservation)).trim();
      // 空正文视为失败：无法发送（splitTelegramText('') 返回空数组），且会在上下文中留下一条
      // 无法解释的空消息（docs/16 §5 摘除比伪造安全）。
      // 该闸门对静默同样不放宽。静默加空正文等于上下文中没有任何记录，而让模型在下一轮知晓自己
      // 已执行过查询正是静默机制的全部目的（docs/02 §10.5）。
      if (!answer) throw new Error("model_returned_empty");
      // `notify` 恒为 false：该路径不调用模型，没有任何执行方能够置位 `turn.silenced`。
      const silenced = turn.silenced === true;
      if (!silenced) {
        const sent = (await bridge.sendMessage(
          {
            chatId: job.chatId,
            threadId: job.threadId,
            turnId: turn.turnId,
            ...(turn.rootSpanId ? { parentSpanId: turn.rootSpanId } : {}),
          },
          answer,
        )) as { ok?: boolean; error?: string };
        if (sent.ok === false)
          throw new Error(`delivery_failed:${sent.error ?? "unknown"}`);
      } else {
        // `job.silentStreak` 是本次触发之前的值，下方的 markRun 才会加 1 —— 日志需要表达这是连续
        // 第几次，因此此处先加。
        const streak = job.silentStreak + 1;
        this.dependencies.log.event({
          level: streak >= SILENT_STREAK_WARN ? "warn" : "info",
          kind: "schedule.silent",
          summary: `定时任务 ${job.name} 本轮不用汇报（连续第 ${streak} 次）`,
          traceId: turn.turnId,
          ...this.#parent(turn),
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
            reason: turn.silenceReason ?? null,
          },
        });
      }
      // 两条路径在此合流，`appendDelta` / `commitTurn` 必须位于合流点之后。将它们移入上方分支
      // （或直接写成 `if (silenced) return`）正好复现 docs/02 §10.1 当初否决的方案：节省的是
      // 一次 commit，代价是一次无法解释的记忆缺失 —— 用户次日询问查询结果而模型完全没有相关记录。
      this.dependencies.context.appendDelta(turn, {
        id: turn.turnId,
        role: "assistant",
        origin: "assistant",
        parts: [{ type: "text", text: answer }],
        textPreview: answer.slice(0, 240),
        pruneLevel: 0,
      });
      const committed = await this.dependencies.context.commitTurn(turn);
      // `turns.finish` 仍记录 `committed`：该轮确实已提交，静默属于投递侧的行为。区分手段在
      // `scheduled_jobs.last_state` 与 `schedule.silent` 那一行，不在此处新增一种轮次状态。
      const settled = this.dependencies.turns.finish(turn.turnId, {
        state: "committed",
        commitId: committed.commit.id,
        rebased: committed.rebased,
      });
      await this.dependencies.plugins?.hook("afterCommit", { turn, committed });
      // `silenced` 写入 `turn.end` 的 data：否则完整 trace 中会缺少 `tg.send`，读取者无从解释。
      this.dependencies.log.event({
        level: "info",
        kind: "turn.end",
        summary: "turn committed",
        traceId: turn.turnId,
        ...this.#parent(turn),
        chatId: job.chatId,
        userId: job.createdBy,
        key: job.key,
        data: {
          state: "committed",
          rebased: committed.rebased,
          waitedMs,
          schedule: job.id,
          ...(silenced ? { silenced: true } : {}),
        },
      });
      this.dependencies.log.publish("turn.finished", {
        turnId: turn.turnId,
        key: job.key,
        chatId: job.chatId,
        state: "committed",
        steps: settled?.steps ?? 0,
        toolCalls: settled?.toolCalls ?? 0,
        costUsd: settled?.costUsd ?? 0,
        rebased: committed.rebased,
        durationMs: settled?.durationMs ?? 0,
      });
      this.dependencies.memory.flush(turn.turnId);
      // `last_error` 在静默路径上恒为 NULL（markRun 不传 error），这是区分静默与
      // failed / skipped 的第二层手段。`silent_streak` 由 markRun 就地加 1。
      this.dependencies.jobs.markRun(job.id, {
        state: silenced ? "silent" : "committed",
      });
      // 与 Telegram 轮次共用同一份计数（docs/28 · L-SCH-02）：成功一次即归零，跨会话生效。
      // 静默同样计为成功：该轮已执行完成并提交，只是没有需要输出的内容。
      this.dependencies.failures?.succeeded();
    } catch (error) {
      // 超时不等于取消（`docs/04 §5.3` 的三档，同 `bot.ts`）。定时任务路径上尤为明显：不会有人去
      // 取消一个自动触发的任务，记为 cancelled 等于在上游故障期间每次触发都被静默地判为无效。
      const timedOut = turn.abortSignal.reason === "timeout";
      const cancelled = turn.abortSignal.aborted && !timedOut;
      // 同 `bot.ts` 中的处理：`abortTurn` 抛出会使下方的 `turns.finish` 不执行，该行永久停留在
      // `state='running'`。清理是尽力而为，而状态记录不是。
      try {
        await this.dependencies.context.abortTurn(
          turn,
          cancelled ? "cancelled" : "failed",
          error,
        );
      } catch (cleanup) {
        this.dependencies.log.event({
          level: "error",
          kind: "ctx.abort",
          summary: "abortTurn failed; turn still recorded as ended",
          traceId: turn.turnId,
          chatId: job.chatId,
          key: job.key,
          data: {
            error: cleanup instanceof Error ? cleanup.message : String(cleanup),
            schedule: job.id,
          },
        });
      }
      const settled = this.dependencies.turns.finish(
        turn.turnId,
        cancelled
          ? {
              state: "cancelled",
              cancelReason: String(turn.abortSignal.reason ?? "cancelled"),
            }
          : {
              state: "failed",
              error: timedOut
                ? "turn_timeout"
                : error instanceof Error
                  ? error.message
                  : String(error),
              ...(timedOut ? { cancelReason: "timeout" } : {}),
            },
      );
      this.dependencies.log.event({
        level: cancelled ? "warn" : "error",
        kind: "turn.end",
        summary: cancelled
          ? "turn cancelled"
          : timedOut
            ? "turn timed out"
            : error instanceof Error
              ? error.message
              : "turn failed",
        traceId: turn.turnId,
        ...this.#parent(turn),
        chatId: job.chatId,
        userId: job.createdBy,
        key: job.key,
        data: {
          state: cancelled ? "cancelled" : "failed",
          waitedMs,
          schedule: job.id,
        },
      });
      this.dependencies.log.publish("turn.finished", {
        turnId: turn.turnId,
        key: job.key,
        chatId: job.chatId,
        state: cancelled ? "cancelled" : "failed",
        steps: settled?.steps ?? 0,
        toolCalls: settled?.toolCalls ?? 0,
        costUsd: settled?.costUsd ?? 0,
        rebased: false,
        durationMs: settled?.durationMs ?? 0,
      });
      // 与 `bot.ts` 的两个出口一致：取消不计为故障，超时计入 —— 而上游无响应导致每次定时触发都
      // 超时，正是该告警最应覆盖的场景，也正是它此前从未触发的场景（docs/28 · L-SCH-02）。
      if (!cancelled)
        this.dependencies.failures?.failed(
          timedOut
            ? "turn_timeout"
            : error instanceof Error
              ? error.message
              : String(error),
        );
      this.#failed(job, error, turn.turnId);
    } finally {
      this.dependencies.tools.releaseTurn(turn.turnId);
      this.dependencies.approvals?.releaseTurn(turn.turnId);
      this.dependencies.memory.discard(turn.turnId);
      this.dependencies.registry.finish(turn.turnId);
      release();
      if (reservation) this.dependencies.quota.release(reservation);
      // 一次性任务执行完即结束，成功与否都不重试：15:00 的会议提醒在 15:05 才发出已无意义。
      if (job.runAt !== null) {
        this.dependencies.jobs.finish(job.id, "done");
        this.unregister(job.id);
      }
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
