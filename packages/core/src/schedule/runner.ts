import { Cron } from 'croner';
import { ulid } from 'ulid';
import type { Role, RuntimeTurnContext } from '@luoli/shared';
import { minRole } from '@luoli/shared';
import { contextKey, type AppendedMessage, type ArchiveRepository, type ScheduleRepository, type ScheduledJob, type Sqlite, type TurnRepository } from '@luoli/db';
import { resolveEffectiveRole } from '../access.js';
import type { TurnFailureStreak } from '../alerts.js';
import type { Config } from '../config/schema.js';
import { perChatConfig } from '../config/index.js';
import type { ContextEngine } from '../context/engine.js';
import type { LogSink } from '../log/sink.js';
import type { MemoryStore } from '../memory/store.js';
import type { QuotaGuard, QuotaReservation } from '../ledger/quota.js';
import type { Scheduler } from '../scheduler.js';
import type { TelegramToolBridge } from '../tools/builtins.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { TurnConcurrency } from '../turn/concurrency.js';
import type { TurnRegistry } from '../turn/registry.js';

/**
 * 合成触发消息的 `tg_message_id` 保留段。
 *
 * `openTurn` 的 `trigger` 必须是一条真实归档行，而 `messages.tg_message_id` 是 `NOT NULL`
 * 且有 `UNIQUE(chat_id, tg_message_id, revision)`。用负数会排在全部真实消息之前，
 * 把 `claimThroughMessageId` 的背景认领窗口整个搞坏；用 `MAX+1` 则可能撞上下一条真实消息，
 * 而 `append` 是 `INSERT OR IGNORE` —— 撞了会静静把真实用户消息丢掉。所以取一个真实
 * Telegram 消息号永远到不了的高位段（每会话计数，见 `#allocateTriggerId`）。
 */
export const SYNTHETIC_TG_MESSAGE_ID_BASE = 2_000_000_000;

/** 一次触发的最终状态，落在 `scheduled_jobs.last_state` 上。 */
export type ScheduledRunState = 'committed' | 'failed' | 'skipped' | 'missed' | 'cancelled';

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
   * 懒取：工具在 bot 建起来之前就注册好了，投递通道要到 `createTelegramBot` 之后才有。
   *
   * **装配方必须让它在 bot 真的起来之后才非空。** 它此前给的是那个「有 `BOT_TOKEN` 就立刻
   * 非空」的外层对象，于是下面 `fire()` 里那条 `telegram_unavailable` 的 skip 分支是死代码：
   * HTTP 从 `serve()` 起就在监听，启动窗口内经 `POST /api/schedules/:id/trigger` 手动触发的
   * 任务会正常开轮、跑完模型、记账，最后以 `delivery_failed:telegram_unavailable` 收尾且
   * **不提交** —— 钱花了、上下文没留下（docs/28 · L-SCH-01）。
   */
  telegram(): TelegramToolBridge | null;
  roleOf(kind: 'user' | 'chat', tgId: string): Role | null;
  /**
   * 连续失败计数。**与 Telegram 轮次共用同一份**（装配方建一个传两处）：这条告警说的是
   * 「这个部署坏了」，而它此前只存在于 `createTelegramBot` 的闭包里 —— 上游变黑洞时，
   * 没人聊天的部署里每次定时触发都超时，一次告警都不响（docs/28 · L-SCH-02）。
   */
  failures?: TurnFailureStreak;
  /**
   * `mode:'agent'` 的实际执行，签名照 `main.ts` 的 `onTurn` —— 装配方在那里注入
   * `runMainAgent`（非流式：定时轮次没有人盯着屏幕，也没有 Telegram 流消费者）。
   */
  runAgent(turn: RuntimeTurnContext, reservation: QuotaReservation | null): Promise<string>;
  approvals?: { releaseTurn(turnId: string): void };
  plugins?: { hook(name: string, payload: unknown): Promise<unknown> };
  estimateTurnCost?(inputTokens: number, key: string): number | null;
}

const jobCronName = (id: string): string => `job:${id}`;

/**
 * 定时任务的执行器。
 *
 * 轮次的开法严格照 `packages/telegram/src/bot.ts` 的那条路（配额 → 并发闸 → openTurn →
 * turns.create → 产出 → appendDelta → commitTurn），只砍掉流式、占位消息与 inline `/cancel`
 * —— 定时轮次没有人盯着屏幕。**`turnRegistry.register` 一步不能砍**：不注册的轮次既不可
 * `/cancel`、也不出现在 `GET /api/turns/active` 里，卡住之后运维完全看不见它。
 */
export class ScheduledJobRunner {
  #loaded = false;

  constructor(private readonly dependencies: ScheduledJobRunnerDependencies) {}

  /**
   * `load()` 跑过没有 —— 也就是「投递通道已经具备」。
   *
   * `POST /api/schedules/:id/trigger` 拿它挡启动窗口：HTTP 从 `serve()` 起就在监听，而 `load()`
   * 要等 bot 起来（装配方的注释一直是对的），所以 cron 触发本来就安全，漏的只有那条手动触发
   * （docs/28 · L-SCH-01）。`telegram()` 那道判据仍在 `fire()` 里兜着 —— 这一条是为了让手动
   * 触发**在响应里就能说清为什么没跑**，而不是回 `started:true` 然后往日志里写一条 skipped。
   */
  get loaded(): boolean { return this.#loaded; }

  /**
   * 进程启动时把库里的活跃任务装回 cron。
   *
   * 停机期间错过的**不补跑**（需求方决策）：一次性任务过期直接置 `done` 并记 `schedule.missed`，
   * 周期任务只记一条 warn 然后照常排下一次。9 点补跑一条 4 点的早报比不发更让人困惑，
   * 跟 `telegram.dropPendingOnStart` 是同一个取舍。
   */
  load(): { registered: number; missed: number } {
    let registered = 0; let missed = 0;
    this.#loaded = true;
    for (const job of this.dependencies.jobs.listActive()) {
      const skew = this.#missedSince(job);
      if (skew) {
        missed += 1;
        this.dependencies.log.event({ level: 'warn', kind: 'schedule.missed', summary: `定时任务 ${job.name} 在停机期间错过了触发`, chatId: job.chatId, key: job.key,
          data: { job: job.id, name: job.name, expected: skew.toISOString(), mode: job.mode, catchUp: false } });
        // 一次性任务的触发点已经过去了，留着 active 只会在库里永远挂着一条不会响的任务。
        if (job.runAt !== null) { this.dependencies.jobs.finish(job.id, 'done', 'missed'); continue; }
      }
      if (this.register(job)) registered += 1;
    }
    return { registered, missed };
  }

  /** 注册（或重新注册）一个任务的 cron。返回 false 表示这条任务已经不该再排了。 */
  register(job: ScheduledJob): boolean {
    const name = jobCronName(job.id);
    this.dependencies.scheduler.remove(name);
    const when = job.runAt === null ? job.cron! : new Date(job.runAt);
    if (job.runAt !== null && job.runAt <= Date.now()) return false;
    try {
      this.dependencies.scheduler.add(when, () => this.fire(job.id), name, { timezone: job.timezone, ...(job.runAt === null ? {} : { maxRuns: 1 }) });
      return true;
    } catch (error) {
      // 坏表达式在创建时就被挡了，走到这里说明库里那行是手改的或跨版本残留 —— 停掉它并说出来。
      this.dependencies.jobs.finish(job.id, 'cancelled', 'failed');
      this.dependencies.log.event({ level: 'error', kind: 'schedule.failed', summary: `定时任务 ${job.name} 无法注册，已停用`, chatId: job.chatId, key: job.key,
        data: { job: job.id, cron: job.cron, runAt: job.runAt, error: error instanceof Error ? error.message : String(error) } });
      return false;
    }
  }

  unregister(id: string): boolean { return this.dependencies.scheduler.remove(jobCronName(id)); }

  nextRun(id: string): Date | null { return this.dependencies.scheduler.nextRun(jobCronName(id)); }

  /** 一次触发。任何异常都在这里收口 —— croner 的 `catch` 与 `Scheduler.onError` 之外再兜一层。 */
  async fire(id: string): Promise<void> {
    const job = this.dependencies.jobs.byId(id);
    if (!job || job.state !== 'active') { this.unregister(id); return; }
    const live = this.dependencies.config();
    if (!live.schedule.enabled) { this.#skip(job, 'schedule.disabled'); return; }
    const { role, userRole, chatRole } = this.#effectiveRole(job, live);
    // 创建之后被降级/拉黑的人不该继续借 bot 的手花钱。blocked 是永久判定 —— 停掉任务；
    // 只是掉到 trusted 以下（`schedule_create` 的 minRole）则跳过这一次，权限回来了任务还在。
    if (role === 'blocked') {
      this.dependencies.jobs.finish(job.id, 'cancelled', 'cancelled');
      this.unregister(job.id);
      // **文案按实际命中的那一侧写。** 判据是 `min(用户角色, 会话角色)`，而这里此前写死「创建者
      // 已被封禁」—— 封的是会话时同样这么说，运维会去查错的对象（docs/28 · L-SCH-04）。
      // `minRole` 的定义保证了：有效角色是 blocked 而用户不是，那一定是会话这一侧。
      const culprit = userRole === 'blocked' ? `创建者 user:${job.createdBy}` : `会话 chat:${job.chatId}`;
      this.dependencies.log.event({ level: 'warn', kind: 'schedule.cancelled', summary: `定时任务 ${job.name} 的${culprit}已被封禁，任务已停用`, chatId: job.chatId, key: job.key, data: { job: job.id, role, userRole, chatRole } });
      return;
    }
    if (minRole(role, 'trusted') !== 'trusted') { this.#skip(job, 'role_downgraded', { role, userRole, chatRole }); return; }
    // **这道判据必须排在 `#run` 之前**（配额预留、并发闸、`openTurn` 都在里面）：发不出去的
    // 一轮开了也是白开，模型钱花掉、上下文一个字都留不下（docs/28 · L-SCH-01）。
    const bridge = this.dependencies.telegram();
    if (!bridge) { this.#skip(job, 'telegram_unavailable'); return; }
    await this.#run(job, role, live, bridge);
  }

  /** 轮次级事件挂在 trace 根之下（`docs/10 §1`）。 */
  #parent(turn: RuntimeTurnContext): { parentSpanId?: string } {
    return turn.rootSpanId ? { parentSpanId: turn.rootSpanId } : {};
  }

  async #run(job: ScheduledJob, role: Role, live: Readonly<Config>, bridge: TelegramToolBridge): Promise<void> {
    const chatConfig = perChatConfig(live, job.key);
    const isPrivate = !job.chatId.startsWith('-');
    // notify 不调模型，所以不占额度；agent 走和用户轮次完全相同的配额闸。
    const reservation = job.mode === 'agent' ? this.#reserve(job, role, live) : null;
    if (job.mode === 'agent' && live.quota.enabled && !reservation) { this.#skip(job, 'quota_exceeded'); return; }
    const pendingId = `job_${ulid()}`;
    const pending = this.dependencies.registry.register({ id: pendingId, key: job.key, chatId: job.chatId, userId: job.createdBy, role }, live.concurrency.turnTimeoutMs);
    let release: (() => void) | null = null;
    // 与 `bot.ts` 同一条判据（docs/28 · L-LOG-01）：只在真的排过队时记 `turn.queued`，
    // `turn.start` 一律带 `waitedMs`。定时轮次撞上并发闸的概率不比用户轮次低 —— 它们常常同时到点。
    const queuedAt = Date.now();
    const wasQueued = !this.dependencies.concurrency.available(job.key);
    const queueSnapshot = { active: this.dependencies.concurrency.active, queued: this.dependencies.concurrency.queued };
    try { release = await this.dependencies.concurrency.acquire(job.key, pending.controller.signal); }
    catch (error) {
      this.dependencies.registry.finish(pendingId);
      if (reservation) this.dependencies.quota.release(reservation);
      this.#skip(job, 'turn_queue_rejected', { error: error instanceof Error ? error.message : String(error) });
      return;
    }
    let turn: Awaited<ReturnType<ContextEngine['openTurn']>>;
    let triggerMessageId: number;
    try {
      // 合成触发消息：`[定时任务 <名字>] <正文>` 作为一条 from_kind='system' 的入站消息落进归档，
      // 这样上下文里就是一次正常对话，用户能直接接着 bot 的回答说下去（需求方决策：照常进上下文）。
      // **不包 untrusted()**：这条文本是 owner/trusted 自己排的任务，包起来等于告诉模型别理它。
      const trigger = this.#appendTrigger(job);
      triggerMessageId = trigger.id;
      // 群名从库里读：这条路没有 Telegram update 可取，而 RUNTIME 的「会话」行要它。
      // 权威副本是 `principals` 的 `chat:<id>`（`upsertSeen` 每条消息刷新一次 `display_name`）。
      const chatTitle = this.dependencies.db.prepare("SELECT display_name FROM principals WHERE kind='chat' AND tg_id=?").pluck().get(job.chatId) as string | null;
      turn = await this.dependencies.context.openTurn({ chatId: job.chatId, threadId: job.threadId, key: job.key, initiatorUserId: job.createdBy,
        effectiveRole: role, isPrivate, trigger, ...(chatTitle ? { chatTitle } : {}), abortSignal: pending.controller.signal, config: chatConfig });
      this.dependencies.registry.finish(pendingId);
      const tracked = this.dependencies.registry.register({ id: turn.turnId, key: job.key, chatId: job.chatId, userId: job.createdBy, role }, live.concurrency.turnTimeoutMs);
      Object.assign(turn, { abortSignal: tracked.controller.signal });
      this.dependencies.turns.create({ id: turn.turnId, key: job.key, chatId: job.chatId, threadId: job.threadId, userId: job.createdBy, role,
        triggerMessageId, triggerReason: 'schedule', baseCommitId: turn.baseCommitId });
    } catch (error) {
      this.dependencies.registry.finish(pendingId);
      release();
      if (reservation) this.dependencies.quota.release(reservation);
      this.#failed(job, error);
      return;
    }
    const waitedMs = Date.now() - queuedAt;
    this.dependencies.log.event({ level: 'info', kind: 'schedule.fired', summary: `定时任务 ${job.name} 触发`, traceId: turn.turnId, ...this.#parent(turn), chatId: job.chatId, userId: job.createdBy, key: job.key,
      data: { job: job.id, name: job.name, mode: job.mode, role, runCount: job.runCount } });
    if (wasQueued) this.dependencies.log.event({ level: 'info', kind: 'turn.queued', summary: `Turn ${turn.turnId} waited ${waitedMs}ms in queue`,
      traceId: turn.turnId, ...this.#parent(turn), chatId: job.chatId, userId: job.createdBy, key: job.key, durationMs: waitedMs, data: { ...queueSnapshot, waitedMs } });
    this.dependencies.log.event({ level: 'info', kind: 'turn.start', summary: `Turn ${turn.turnId} started`, traceId: turn.turnId, ...(turn.rootSpanId ? { spanId: turn.rootSpanId } : {}), chatId: job.chatId, userId: job.createdBy, key: job.key, data: { role, triggerReason: 'schedule', waitedMs } });
    this.dependencies.log.publish('turn.started', { turnId: turn.turnId, key: job.key, chatId: job.chatId, user: job.createdBy, role, triggerReason: 'schedule', at: Date.now() });
    try {
      const answer = job.mode === 'notify' ? job.payload : (await this.dependencies.runAgent(turn, reservation)).trim();
      // 空正文当成失败：发不出去（splitTelegramText('') 是空数组）、还会往上下文里留一条
      // 谁都解释不了的空消息（docs/16 §5「摘除比伪造安全」）。
      if (!answer) throw new Error('model_returned_empty');
      const sent = await bridge.sendMessage({ chatId: job.chatId, threadId: job.threadId, turnId: turn.turnId, ...(turn.rootSpanId ? { parentSpanId: turn.rootSpanId } : {}) }, answer) as { ok?: boolean; error?: string };
      if (sent.ok === false) throw new Error(`delivery_failed:${sent.error ?? 'unknown'}`);
      this.dependencies.context.appendDelta(turn, { id: turn.turnId, role: 'assistant', origin: 'assistant', parts: [{ type: 'text', text: answer }], textPreview: answer.slice(0, 240), pruneLevel: 0 });
      const committed = await this.dependencies.context.commitTurn(turn);
      const settled = this.dependencies.turns.finish(turn.turnId, { state: 'committed', commitId: committed.commit.id, rebased: committed.rebased });
      await this.dependencies.plugins?.hook('afterCommit', { turn, committed });
      this.dependencies.log.event({ level: 'info', kind: 'turn.end', summary: 'turn committed', traceId: turn.turnId, ...this.#parent(turn), chatId: job.chatId, userId: job.createdBy, key: job.key, data: { state: 'committed', rebased: committed.rebased, waitedMs, schedule: job.id } });
      this.dependencies.log.publish('turn.finished', { turnId: turn.turnId, key: job.key, chatId: job.chatId, state: 'committed', steps: settled?.steps ?? 0, toolCalls: settled?.toolCalls ?? 0, costUsd: settled?.costUsd ?? 0, rebased: committed.rebased, durationMs: settled?.durationMs ?? 0 });
      this.dependencies.memory.flush(turn.turnId);
      this.dependencies.jobs.markRun(job.id, { state: 'committed' });
      // 与 Telegram 轮次共用同一份计数（docs/28 · L-SCH-02）：成功一次归零，跨会话。
      this.dependencies.failures?.succeeded();
    } catch (error) {
      // 超时不是取消（`docs/04 §5.3` 的三档，同 `bot.ts`）。定时任务这条路上尤其明显：**没有人会去
      // 取消一个自己触发的任务**，记成 cancelled 等于「上游黑着的那几天里，每次触发都安静地算不了数」。
      const timedOut = turn.abortSignal.reason === 'timeout';
      const cancelled = turn.abortSignal.aborted && !timedOut;
      // 同 `bot.ts` 那条：`abortTurn` 抛出去会让下面的 `turns.finish` 不执行，那行永久卡在
      // `state='running'`。清理是尽力而为，**记状态不是**。
      try { await this.dependencies.context.abortTurn(turn, cancelled ? 'cancelled' : 'failed', error); }
      catch (cleanup) { this.dependencies.log.event({ level: 'error', kind: 'ctx.abort', summary: 'abortTurn failed; turn still recorded as ended', traceId: turn.turnId, chatId: job.chatId, key: job.key, data: { error: cleanup instanceof Error ? cleanup.message : String(cleanup), schedule: job.id } }); }
      const settled = this.dependencies.turns.finish(turn.turnId, cancelled
        ? { state: 'cancelled', cancelReason: String(turn.abortSignal.reason ?? 'cancelled') }
        : { state: 'failed', error: timedOut ? 'turn_timeout' : error instanceof Error ? error.message : String(error), ...(timedOut ? { cancelReason: 'timeout' } : {}) });
      this.dependencies.log.event({ level: cancelled ? 'warn' : 'error', kind: 'turn.end', summary: cancelled ? 'turn cancelled' : timedOut ? 'turn timed out' : error instanceof Error ? error.message : 'turn failed', traceId: turn.turnId, ...this.#parent(turn), chatId: job.chatId, userId: job.createdBy, key: job.key, data: { state: cancelled ? 'cancelled' : 'failed', waitedMs, schedule: job.id } });
      this.dependencies.log.publish('turn.finished', { turnId: turn.turnId, key: job.key, chatId: job.chatId, state: cancelled ? 'cancelled' : 'failed', steps: settled?.steps ?? 0, toolCalls: settled?.toolCalls ?? 0, costUsd: settled?.costUsd ?? 0, rebased: false, durationMs: settled?.durationMs ?? 0 });
      // 同 `bot.ts` 的两个出口：取消不算故障，超时算 —— 而「上游变黑洞、每次定时触发都超时」
      // 正是这条告警最该覆盖的场景，也正是它此前一次都不响的那个（docs/28 · L-SCH-02）。
      if (!cancelled) this.dependencies.failures?.failed(timedOut ? 'turn_timeout' : error instanceof Error ? error.message : String(error));
      this.#failed(job, error, turn.turnId);
    } finally {
      this.dependencies.tools.releaseTurn(turn.turnId);
      this.dependencies.approvals?.releaseTurn(turn.turnId);
      this.dependencies.memory.discard(turn.turnId);
      this.dependencies.registry.finish(turn.turnId);
      release();
      if (reservation) this.dependencies.quota.release(reservation);
      // 一次性任务跑完就收摊，成败都不重试：重试一个「提醒我 15:00 开会」在 15:05 才发出去没有意义。
      if (job.runAt !== null) { this.dependencies.jobs.finish(job.id, 'done'); this.unregister(job.id); }
    }
  }

  /**
   * 从保留高位段分配一个 `tg_message_id`。
   *
   * `append` 是 `INSERT OR IGNORE`：撞号会静静返回既有那一行，于是这一轮的触发消息其实是
   * 上一次的那条，`claimThroughMessageId` 与 `turns.trigger_message_id` 一起错位。所以
   * 分配完必须核对返回值，不等就抛 —— 静默走下去比失败难查得多。
   *
   * **判 `inserted` 而不是比 `tgMessageId`。** 后者是这条核对此前的写法，而回读那一行是按入参
   * 的 id 查的 —— 返回值的 `tgMessageId` 恒等于分配值，比较永远为假（docs/28 · L-SCH-03）。
   */
  #appendTrigger(job: ScheduledJob): AppendedMessage {
    const scoped = this.dependencies.archive.scope(job.chatId, job.threadId);
    const highest = this.dependencies.db.prepare('SELECT MAX(tg_message_id) FROM messages WHERE chat_id=? AND tg_message_id>=?')
      .pluck().get(job.chatId, SYNTHETIC_TG_MESSAGE_ID_BASE) as number | null;
    const tgMessageId = Math.max(SYNTHETIC_TG_MESSAGE_ID_BASE, (highest ?? 0) + 1);
    const appended = scoped.append({ chatId: job.chatId, messageThreadId: job.threadId, tgMessageId, direction: 'in', fromKind: 'system',
      fromUserId: job.createdBy, fromName: '定时任务', fromUsername: null, kind: 'text',
      text: `[定时任务 ${job.name}] ${job.payload}`, tgDate: Date.now(), raw: { schedule: { id: job.id, name: job.name, mode: job.mode } },
      triggered: true, triggerReason: 'schedule' });
    if (!appended.inserted) throw new Error(`schedule_trigger_conflict:${tgMessageId}`);
    return appended;
  }

  /**
   * 有效角色 = min(用户角色, 会话角色)。两侧一起交回去：告警文案要说清是**哪一侧**命中的
   * （docs/28 · L-SCH-04），而判据本身仍只有 `resolveEffectiveRole` 一份 —— 在这里把默认值
   * 那套规则再算一遍就是第二份判据。`chatRole` 是**库里存的**那个，null 表示走了默认。
   */
  #effectiveRole(job: ScheduledJob, live: Readonly<Config>): { role: Role; userRole: Role; chatRole: Role | null } {
    const userRole = this.dependencies.roleOf('user', job.createdBy) ?? live.access.defaultUserRole;
    const chatRole = this.dependencies.roleOf('chat', job.chatId);
    return { role: resolveEffectiveRole({ userRole, ...(chatRole ? { chatRole } : {}), isPrivate: !job.chatId.startsWith('-'), defaultChatRole: live.access.defaultChatRole }), userRole, chatRole };
  }

  #reserve(job: ScheduledJob, role: Role, live: Readonly<Config>): ReturnType<QuotaGuard['reserve']> | null {
    if (!live.quota.enabled) return null;
    const roleLimits = live.quota.perUser.byRole[role];
    const estimatedTokens = Math.max(this.dependencies.context.windowTokens(job.key) + live.prompt.maxTokens, 1000);
    const estimate = this.dependencies.estimateTurnCost?.(estimatedTokens, job.key) ?? null;
    return this.dependencies.quota.reserve({ chatId: job.chatId, userId: job.createdBy,
      estimateUsd: Math.max(live.quota.minReserveUsd, estimate ?? live.quota.minReserveUsd),
      limits: { globalDaily: live.quota.global.daily, globalMonthly: live.quota.global.monthly,
        chatDaily: live.quota.perChat.daily, chatMonthly: live.quota.perChat.monthly,
        userDaily: roleLimits?.daily ?? live.quota.perUser.daily, userMonthly: roleLimits?.monthly ?? live.quota.perUser.monthly } });
  }

  /** 跳过一次触发：任务留着，下次照常。计一次 run 好让 `schedule_list` 能看出它在打空转。 */
  #skip(job: ScheduledJob, reason: string, data: Record<string, unknown> = {}): void {
    this.dependencies.jobs.markRun(job.id, { state: 'skipped', error: reason });
    this.dependencies.log.event({ level: 'warn', kind: 'schedule.skipped', summary: `定时任务 ${job.name} 本次跳过：${reason}`, chatId: job.chatId, key: job.key,
      data: { job: job.id, name: job.name, reason, ...data } });
  }

  #failed(job: ScheduledJob, error: unknown, turnId?: string): void {
    const message = error instanceof Error ? error.message : String(error);
    this.dependencies.jobs.markRun(job.id, { state: 'failed', error: message });
    this.dependencies.log.event({ level: 'error', kind: 'schedule.failed', summary: `定时任务 ${job.name} 失败：${message}`, ...(turnId ? { traceId: turnId } : {}),
      chatId: job.chatId, key: job.key, data: { job: job.id, name: job.name, error: message } });
  }

  /** 上一次触发（或创建）之后是否有一个已经过去的触发点。返回那个时刻，没有则 null。 */
  #missedSince(job: ScheduledJob): Date | null {
    const now = Date.now();
    if (job.runAt !== null) return job.runAt <= now ? new Date(job.runAt) : null;
    try {
      const since = new Date(job.lastRunAt ?? job.createdAt);
      const expected = new Cron(job.cron!, { timezone: job.timezone }).nextRun(since);
      return expected && expected.getTime() <= now ? expected : null;
    } catch { return null; }
  }
}

/** 工具侧与装配侧共用：会话键的算法只有一份。 */
export const scheduleContextKey = (chatId: string, threadId: number | null, scope: 'chat' | 'thread'): string =>
  contextKey({ chatId, messageThreadId: threadId }, scope);
