import { mkdirSync, rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ArchiveRepository, OperationsRepository, PrincipalRepository, ScheduleRepository, TurnRepository, closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { ContextEngine, EventBus, LogSink, MemoryStore, QuotaGuard, SILENT_STREAK_WARN, SYNTHETIC_TG_MESSAGE_ID_BASE, ScheduledJobRunner, Scheduler, ToolRegistry, TurnConcurrency, TurnFailureStreak, TurnRegistry, configSchema, registerScheduleTools, updateScheduledJob } from '@luoli/core';
import type { Config, TelegramToolBridge } from '@luoli/core';
import type { RuntimeTurnContext } from '@luoli/shared';
import { logPayload, logRows } from './support/logs.js';

/**
 * 定时任务（docs/14 §2 Q4 的四条决策）。本文件验证的正是那四条：
 *
 * - 触发时开一条完整轮次并提交（notify 同样提交），因此定时产出照常进入上下文；
 * - 停机期间错过的不补跑，只记录 `schedule.missed`；
 * - 落点绑定本会话：工具参数中没有 chatId，list 与 cancel 也无法跨越 key；
 * - 触发时重算有效角色，创建后被降级或封禁的用户所排的任务不应继续产生费用。
 */
function harness(name: string, extra: Record<string, unknown> = {}) {
  const path = `./data/${name}.test.db`;
  for (const suffix of ['', '-wal', '-shm', '-logs', '-logs-wal', '-logs-shm']) rmSync(`${path}${suffix}`, { force: true });
  const directory = `./data/${name}-logs`; rmSync(directory, { recursive: true, force: true }); mkdirSync(directory, { recursive: true });
  const memoryDir = `./data/${name}-memory`; rmSync(memoryDir, { recursive: true, force: true }); mkdirSync(memoryDir, { recursive: true });
  const db = openDatabase(path); migrateDatabase(db);
  const config = configSchema.parse({ access: { bootstrapOwnerId: '1' }, general: { timezone: 'UTC' }, quota: { enabled: false }, ...extra }) as Config;
  const events = new EventBus();
  const log = new LogSink(new OperationsRepository(db), [], { level: 'debug', console: 'off' });
  const archive = new ArchiveRepository(db);
  const jobs = new ScheduleRepository(db);
  const scheduler = new Scheduler();
  const principals = new PrincipalRepository(db);
  const sent: Array<{ chatId: string; text: string }> = [];
  const agentCalls: RuntimeTurnContext[] = [];
  let live = config;
  const context = new ContextEngine(db, archive);
  // 投递通道可缺失：`telegram()` 在 bot 启动之前必须为 null，那条 skip 分支依赖它才有效
  // （docs/28 · L-SCH-01）。用例自行传入 getter，不依赖 main.ts 的装配。
  let bridge: TelegramToolBridge | null = {
    sendMessage: (target, text) => { sent.push({ chatId: target.chatId, text }); return Promise.resolve({ ok: true, messageIds: [1] }); },
    sendPhoto: () => Promise.resolve({ ok: true }), sendFile: () => Promise.resolve({ ok: true }), react: () => Promise.resolve({ ok: true }), pin: () => Promise.resolve({ ok: true }),
  };
  const fired: Array<{ kind: string; count: unknown }> = [];
  // `mode:'agent'` 那一步。默认返回一句正文；静默相关用例改为先调用 stay_silent 再写入结论。
  let agent: (turn: RuntimeTurnContext) => Promise<string> = () => Promise.resolve('早报：昨天聊了三件事。');
  const failures = new TurnFailureStreak({ fire: (kind, _summary, data) => { fired.push({ kind, count: (data as { count?: unknown } | undefined)?.count }); } }, 2);
  const runner = new ScheduledJobRunner({
    db, jobs, scheduler, context, archive, turns: new TurnRepository(db),
    registry: new TurnRegistry(), concurrency: new TurnConcurrency(config.concurrency),
    quota: new QuotaGuard(db, config.general.timezone, events), memory: new MemoryStore(db, memoryDir, 1500, 3000),
    tools: new ToolRegistry(log, { request: async () => true }, { maxRegistered: 200, maxCallsPerTurn: 50, maxConsecutiveErrors: 10 }), log, failures,
    config: () => live,
    telegram: () => bridge,
    roleOf: (kind, tgId) => principals.roleOf(kind, tgId),
    runAgent: (turn) => { agentCalls.push(turn); return agent(turn); },
  });
  const registry = new ToolRegistry(log, { request: async () => true }, { maxRegistered: 200, maxCallsPerTurn: 50, maxConsecutiveErrors: 10 });
  registerScheduleTools(registry, { jobs, runner, deliverable: () => true });
  const contextFor = (chatId: string, userId = '7'): unknown => ({
    turn: { turnId: `t-${chatId}`, key: `chat:${chatId}`, chatId, threadId: null, initiatorUserId: userId, effectiveRole: 'trusted',
      isPrivate: true, baseCommitId: null, config: live, snapshot: { messages: [], ordinals: [], tokens: 0, windowStart: 1, headOrdinal: 0 },
      delta: [], abortSignal: new AbortController().signal },
    workspace: `./data/${name}-workspace`, agentKind: 'main',
  });
  // 静默相关用例必须用真实轮次对象调用工具：`stay_silent` 判定的正是 runner 在 `openTurn` 上设置的
  // `silenceable`，用 `contextFor` 手工构造的 turn 测试等于绕过判据本身。
  const turnContext = (turn: RuntimeTurnContext, agentKind: 'main' | 'sub' = 'main'): unknown =>
    ({ turn, workspace: `./data/${name}-workspace`, agentKind });
  principals.upsertSeen({ id: 'user:7', kind: 'user', tgId: '7', role: 'trusted', displayName: '阿离', username: null, chatType: null });
  return { db, jobs, runner, registry, scheduler, principals, sent, agentCalls, contextFor, context, archive, fired, failures, turnContext,
    scheduleSettings: (): Config['schedule'] => live.schedule,
    setAgent: (fn: (turn: RuntimeTurnContext) => Promise<string>) => { agent = fn; },
    unplugTelegram: () => { bridge = null; },
    setConfig: (patch: Record<string, unknown>) => { live = configSchema.parse({ access: { bootstrapOwnerId: '1' }, general: { timezone: 'UTC' }, quota: { enabled: false }, ...extra, ...patch }) as Config; },
    close: () => { scheduler.stop(); closeDatabase(db); } };
}

const call = (h: ReturnType<typeof harness>, name: string, input: unknown, chatId = 'c1', userId = '7'): Promise<Record<string, unknown>> =>
  h.registry.execute(name, input, h.contextFor(chatId, userId) as never) as Promise<Record<string, unknown>>;

describe('定时任务工具', () => {
  it('建一个周期任务，落库并排进调度器', async () => {
    const h = harness('sched-create');
    const result = await call(h, 'schedule_create', { name: '每日早报', mode: 'agent', cron: '0 8 * * *', text: '汇总昨天群里聊了什么' });
    expect(result).toMatchObject({ ok: true, name: '每日早报', mode: 'agent', cron: '0 8 * * *', timezone: 'UTC' });
    expect(typeof result.nextRun).toBe('string');
    expect(h.jobs.countActive('chat:c1')).toBe(1);
    expect(h.scheduler.names()).toHaveLength(1);
    h.close();
  });

  it('把非法与过密的时间挡在建之前', async () => {
    const h = harness('sched-validate');
    expect(await call(h, 'schedule_create', { name: 'a', mode: 'notify', text: 'x' })).toMatchObject({ ok: false, error: 'invalid_schedule' });
    expect(await call(h, 'schedule_create', { name: 'a', mode: 'notify', text: 'x', cron: '0 8 * * *', at: '2030-01-01T08:00' })).toMatchObject({ ok: false, error: 'invalid_schedule' });
    expect(await call(h, 'schedule_create', { name: 'a', mode: 'notify', text: 'x', cron: '不是 cron' })).toMatchObject({ ok: false, error: 'invalid_cron' });
    // 每分钟一次在 agent 模式下就是每分钟一次真实模型调用。
    expect(await call(h, 'schedule_create', { name: 'a', mode: 'agent', text: 'x', cron: '* * * * *' })).toMatchObject({ ok: false, error: 'interval_too_short' });
    expect(await call(h, 'schedule_create', { name: 'a', mode: 'notify', text: 'x', at: '2020-01-01T08:00' })).toMatchObject({ ok: false, error: 'at_in_the_past' });
    expect(await call(h, 'schedule_create', { name: 'a', mode: 'notify', text: 'x', at: '不是时间' })).toMatchObject({ ok: false, error: 'invalid_at' });
    expect(h.jobs.countActive('chat:c1')).toBe(0);
    h.close();
  });

  it('at 按 general.timezone 解析，而不是宿主时区', async () => {
    const h = harness('sched-tz', { general: { timezone: 'Asia/Shanghai' } });
    const result = await call(h, 'schedule_create', { name: '开会', mode: 'notify', text: '开会了', at: '2030-06-01T15:00' });
    // 上海为 UTC+8，因此 6 月 1 日 15:00 对应当天 07:00Z。宿主时区不影响该结果。
    expect(h.jobs.byName('chat:c1', '开会')!.runAt).toBe(Date.parse('2030-06-01T07:00:00Z'));
    expect(result).toMatchObject({ ok: true, at: '2030-06-01T07:00:00.000Z', timezone: 'Asia/Shanghai' });
    h.close();
  });

  it('同会话不许重名，跨会话同名互不干扰，且取消跨不过会话', async () => {
    const h = harness('sched-scope');
    expect(await call(h, 'schedule_create', { name: '早报', mode: 'notify', text: '早', cron: '0 8 * * *' }, 'c1')).toMatchObject({ ok: true });
    expect(await call(h, 'schedule_create', { name: '早报', mode: 'notify', text: '早', cron: '0 8 * * *' }, 'c1')).toMatchObject({ ok: false, error: 'duplicate_name' });
    expect(await call(h, 'schedule_create', { name: '早报', mode: 'notify', text: '早', cron: '0 9 * * *' }, 'c2')).toMatchObject({ ok: true });
    // c2 只能看到自己的那一个。
    expect((await call(h, 'schedule_list', {}, 'c2')).jobs).toHaveLength(1);
    // 关键判据：c2 取消同名任务只会取消自己的那个，c1 的仍然存在（工具没有 chatId 参数，也不接受 id）。
    expect(await call(h, 'schedule_cancel', { name: '早报' }, 'c2')).toMatchObject({ ok: true });
    expect(h.jobs.byName('chat:c1', '早报')).not.toBeNull();
    expect(h.jobs.byName('chat:c2', '早报')).toBeNull();
    // 取消之后名字被释放，可以重新创建。
    expect(await call(h, 'schedule_create', { name: '早报', mode: 'notify', text: '早', cron: '0 9 * * *' }, 'c2')).toMatchObject({ ok: true });
    expect(await call(h, 'schedule_cancel', { name: '不存在' }, 'c1')).toMatchObject({ ok: false, error: 'not_found' });
    h.close();
  });

  it('单会话活跃任务数有上界，关掉总开关后建不了', async () => {
    const h = harness('sched-cap', { schedule: { maxPerChat: 2 } });
    expect(await call(h, 'schedule_create', { name: 'a', mode: 'notify', text: 'x', cron: '0 8 * * *' })).toMatchObject({ ok: true });
    expect(await call(h, 'schedule_create', { name: 'b', mode: 'notify', text: 'x', cron: '0 9 * * *' })).toMatchObject({ ok: true });
    expect(await call(h, 'schedule_create', { name: 'c', mode: 'notify', text: 'x', cron: '0 10 * * *' })).toMatchObject({ ok: false, error: 'too_many_jobs' });
    h.setConfig({ schedule: { maxPerChat: 2, enabled: false } });
    expect(await call(h, 'schedule_cancel', { name: 'a' })).toMatchObject({ ok: true });
    expect(await call(h, 'schedule_create', { name: 'c', mode: 'notify', text: 'x', cron: '0 10 * * *' })).toMatchObject({ ok: false, error: 'schedule_disabled' });
    h.close();
  });
});

describe('定时任务触发', () => {
  it('notify 模式发出预写文本，并且照常进上下文', async () => {
    const h = harness('sched-fire-notify');
    await call(h, 'schedule_create', { name: '喝水提醒', mode: 'notify', text: '该喝水了', cron: '0 * * * *' });
    const job = h.jobs.byName('chat:c1', '喝水提醒')!;
    await h.runner.fire(job.id);
    expect(h.sent).toEqual([{ chatId: 'c1', text: '该喝水了' }]);
    // notify 不调模型。
    expect(h.agentCalls).toHaveLength(0);
    // 照常进入上下文的实证：触发消息与助手回复都提交进了 context_messages，且属于同一轮。
    const rows = h.db.prepare("SELECT role,origin,text_preview AS preview FROM context_messages WHERE key='chat:c1' ORDER BY ordinal").all() as Array<{ role: string; origin: string; preview: string }>;
    expect(rows).toEqual([
      { role: 'user', origin: 'trigger', preview: '[定时任务 喝水提醒] 该喝水了' },
      { role: 'assistant', origin: 'assistant', preview: '该喝水了' },
    ]);
    expect(h.db.prepare("SELECT state,trigger_reason AS reason FROM turns").get()).toMatchObject({ state: 'committed', reason: 'schedule' });
    // 合成触发消息落在保留高位段，不会与真实 Telegram 消息号冲突。
    const trigger = h.db.prepare("SELECT tg_message_id AS id,from_kind AS kind FROM messages WHERE direction='in'").get() as { id: number; kind: string };
    expect(trigger.kind).toBe('system');
    expect(trigger.id).toBeGreaterThanOrEqual(SYNTHETIC_TG_MESSAGE_ID_BASE);
    expect(h.jobs.byId(job.id)).toMatchObject({ state: 'active', runCount: 1, lastState: 'committed' });
    h.close();
  });

  /**
   * `abortTurn` 同样会写库（`releaseClaims`，`cancel.commitPartial` 开启时还会执行一整个
   * `commitTurn`）。它此前排在 `turns.finish` 之前且没有独立的 try，抛错后那一行会永久停留在
   * `state='running'`：`GET /api/turns/active` 与总览页的 running 计数在整个进程生命周期内
   * 都是错的，直到下次重启的 `recoverAfterCrash` 才修正。清理属于尽力而为，记录状态不是。
   */
  it('abortTurn 抛出时轮次仍记成 failed，而不是永久卡在 running', async () => {
    const h = harness('sched-abort-throws');
    await call(h, 'schedule_create', { name: '早报', mode: 'notify', text: '早上好', cron: '0 * * * *' });
    const job = h.jobs.byName('chat:c1', '早报')!;
    Object.assign(h.context, {
      commitTurn: () => Promise.reject(new Error('sqlite disk image is malformed')),
      abortTurn: () => Promise.reject(new Error('releaseClaims 也写不进去')),
    });
    await h.runner.fire(job.id);
    expect(h.db.prepare('SELECT state,error FROM turns').get()).toMatchObject({ state: 'failed', error: 'sqlite disk image is malformed' });
    // 清理失败自身也要留下记录，否则认领未释放无法排查。
    expect(h.db.prepare("SELECT COUNT(*) FROM log_events WHERE kind='ctx.abort' AND level='error'").pluck().get()).toBe(1);
    // 任务本身照旧记一次失败，下次还会跑。
    expect(h.jobs.byId(job.id)).toMatchObject({ state: 'active', lastState: 'failed' });
    h.close();
  });

  it('连续两次触发各自分到一个新的合成消息号', async () => {
    const h = harness('sched-fire-twice');
    await call(h, 'schedule_create', { name: '提醒', mode: 'notify', text: '喂', cron: '0 * * * *' });
    const job = h.jobs.byName('chat:c1', '提醒')!;
    await h.runner.fire(job.id); await h.runner.fire(job.id);
    // 冲突会让 INSERT OR IGNORE 静默返回上一次那一行，于是第二轮的触发消息实际是第一轮的。
    const ids = (h.db.prepare("SELECT tg_message_id AS id FROM messages WHERE direction='in' ORDER BY id").all() as Array<{ id: number }>).map((row) => row.id);
    expect(new Set(ids).size).toBe(2);
    expect(h.sent).toHaveLength(2);
    expect(h.jobs.byId(job.id)!.runCount).toBe(2);
    h.close();
  });

  it('agent 模式走模型，产出发出去并提交', async () => {
    const h = harness('sched-fire-agent');
    await call(h, 'schedule_create', { name: '每日早报', mode: 'agent', cron: '0 8 * * *', text: '汇总昨天群里聊了什么' });
    const job = h.jobs.byName('chat:c1', '每日早报')!;
    await h.runner.fire(job.id);
    expect(h.agentCalls).toHaveLength(1);
    // 模型收到的是真实的轮次上下文：任务描述已作为触发消息进入快照。
    expect(h.agentCalls[0]!.key).toBe('chat:c1');
    expect(h.sent).toEqual([{ chatId: 'c1', text: '早报：昨天聊了三件事。' }]);
    expect(h.db.prepare("SELECT text_preview AS preview FROM context_messages WHERE origin='assistant'").get()).toMatchObject({ preview: '早报：昨天聊了三件事。' });
    h.close();
  });

  it('一次性任务跑完就结束，并从调度器里摘掉', async () => {
    const h = harness('sched-once');
    await call(h, 'schedule_create', { name: '开会', mode: 'notify', text: '开会了', at: new Date(Date.now() + 3_600_000).toISOString().slice(0, 16) });
    const job = h.jobs.byName('chat:c1', '开会')!;
    expect(h.scheduler.names()).toHaveLength(1);
    await h.runner.fire(job.id);
    expect(h.jobs.byId(job.id)).toMatchObject({ state: 'done', runCount: 1 });
    expect(h.scheduler.names()).toHaveLength(0);
    h.close();
  });

  it('触发时重算角色：降级的跳过一次，被封禁的整条停用', async () => {
    const h = harness('sched-role');
    await call(h, 'schedule_create', { name: '早报', mode: 'notify', text: '早', cron: '0 8 * * *' });
    const job = h.jobs.byName('chat:c1', '早报')!;
    // 任务落在私聊（`c1` 不以 `-` 开头），有效角色就是用户角色 —— 降级必然命中。搬到群里这条
    // 会失效：群角色是下限，一个 trusted 群能把降级后的成员重新抬回 trusted（docs/05 §2.2）。
    // trusted 降为 limited：`schedule_create` 的 minRole 为 trusted，因此本次不执行，但任务保留。
    h.principals.setRole('user:7', 'limited', 'test');
    await h.runner.fire(job.id);
    expect(h.sent).toHaveLength(0);
    expect(h.jobs.byId(job.id)).toMatchObject({ state: 'active', lastState: 'skipped', lastError: 'role_downgraded' });
    // 权限恢复后任务照常执行，这正是跳过而非停用的意义。
    h.principals.setRole('user:7', 'trusted', 'test');
    await h.runner.fire(job.id);
    expect(h.sent).toHaveLength(1);
    // blocked 是永久判定：任务停用并从调度器移除。
    h.principals.setRole('user:7', 'blocked', 'test');
    await h.runner.fire(job.id);
    expect(h.sent).toHaveLength(1);
    expect(h.jobs.byId(job.id)).toMatchObject({ state: 'cancelled' });
    expect(h.scheduler.names()).toHaveLength(0);
    // 提示指向实际被封禁的那一方（此处为创建者）。
    expect(h.db.prepare("SELECT summary FROM log_events WHERE kind='schedule.cancelled'").pluck().get()).toContain('创建者 user:7');
    h.close();
  });

  /**
   * 告警文案此前写死为创建者已被封禁：封禁的是会话时同样这样表述，会导致运维排查错误的对象
   * （docs/28 · L-SCH-04）。判据是「私聊只看用户角色，群 / 频道取两侧较高者再封顶 trusted」，
   * 而 `blocked` 任一侧一票否决且先于抬升判定 —— 这条推理在新判据下原样成立。
   *
   * 任务必须落在**群**里：私聊不再看会话角色，`chat:` 那一行封不封都不改变有效角色。
   */
  it('封的是会话时，告警说的就是会话而不是创建者', async () => {
    const h = harness('sched-role-chat');
    await call(h, 'schedule_create', { name: '早报', mode: 'notify', text: '早', cron: '0 8 * * *' }, '-1001');
    const job = h.jobs.byName('chat:-1001', '早报')!;
    h.principals.upsertSeen({ id: 'chat:-1001', kind: 'chat', tgId: '-1001', role: 'blocked', displayName: null, username: null, chatType: 'supergroup' });
    await h.runner.fire(job.id);
    expect(h.sent).toHaveLength(0);
    expect(h.jobs.byId(job.id)).toMatchObject({ state: 'cancelled' });
    const summary = h.db.prepare("SELECT summary FROM log_events WHERE kind='schedule.cancelled'").pluck().get() as string;
    expect(summary).toContain('会话 chat:-1001');
    expect(summary).not.toContain('创建者');
    // 两侧的角色都写入 data，运维无需再推断是哪一方。
    expect(logPayload(h.db, 'schedule.cancelled')).toContain('"userRole":"trusted"');
    h.close();
  });

  /**
   * `telegram()` 返回 null 时不得继续执行任何一步：配额预留、并发闸、`openTurn` 全在 `#run` 中，
   * 而一轮无法投递的执行没有意义。实测（docs/28 · L-SCH-01）在启动窗口内经
   * `POST /api/schedules/:id/trigger` 触发的任务执行完 2 步、`usage_ledger` 记录 $0.30，
   * 最终以 `delivery_failed:telegram_unavailable` 收尾且不提交：产生了费用而上下文没有保留。
   * 那条 skip 分支当时是死代码，因为装配方提供的 getter 判定的是外层对象是否存在 BOT_TOKEN。
   */
  it('投递通道不在时不开轮：不记账、只落一条 skipped、任务留存', async () => {
    const h = harness('sched-no-telegram', { quota: { enabled: true, minReserveUsd: 0.02, global: { daily: 5 } } });
    await call(h, 'schedule_create', { name: '早报', mode: 'agent', text: '汇总', cron: '0 8 * * *' });
    const job = h.jobs.byName('chat:c1', '早报')!;
    h.unplugTelegram();
    await h.runner.fire(job.id);
    expect(h.sent).toHaveLength(0);
    expect(h.agentCalls).toHaveLength(0);
    // 以下均不应产生记录：轮次、合成触发消息、上下文、账目、配额预留。
    expect(h.db.prepare('SELECT COUNT(*) FROM turns').pluck().get()).toBe(0);
    expect(h.db.prepare('SELECT COUNT(*) FROM messages').pluck().get()).toBe(0);
    expect(h.db.prepare('SELECT COUNT(*) FROM context_messages').pluck().get()).toBe(0);
    expect(h.db.prepare('SELECT COUNT(*) FROM usage_ledger').pluck().get()).toBe(0);
    expect(h.db.prepare('SELECT COUNT(*) FROM quota_counters').pluck().get()).toBe(0);
    expect(logPayload(h.db, 'schedule.skipped')).toContain('telegram_unavailable');
    // 任务保留：通道恢复后它照常执行，这不属于停用。
    expect(h.jobs.byId(job.id)).toMatchObject({ state: 'active', lastState: 'skipped', lastError: 'telegram_unavailable' });
    expect(h.scheduler.names()).toEqual([`job:${job.id}`]);
    h.close();
  });

  /**
   * `POST /api/schedules/:id/trigger` 用 `loaded` 拦截启动窗口：HTTP 自 `serve()` 起即开始监听，
   * 而 `load()` 需等待 bot 启动（docs/28 · L-SCH-01）。
   */
  it('load() 之前 loaded 为假 —— 手动触发端点的判据', () => {
    const h = harness('sched-loaded');
    expect(h.runner.loaded).toBe(false);
    h.runner.load();
    expect(h.runner.loaded).toBe(true);
    h.close();
  });

  /**
   * 定时轮次的失败要计入 `consecutive_turn_failures`（docs/28 · L-SCH-02）。上游无响应、
   * 每次定时触发都超时这类故障，在无人聊天的部署中此前不会触发任何告警，而 docs/10 §6 将该
   * 告警定义为整个部署故障的信号。计数由装配方创建一份，与 Telegram 轮次共用。
   */
  it('定时轮次的失败计入连续失败告警，成功一次归零', async () => {
    const h = harness('sched-failure-streak');
    await call(h, 'schedule_create', { name: '早报', mode: 'notify', text: '早', cron: '0 * * * *' });
    const job = h.jobs.byName('chat:c1', '早报')!;
    const healthy = { commitTurn: h.context.commitTurn.bind(h.context) };
    const broken = { commitTurn: () => Promise.reject(new Error('上游黑了')) };
    Object.assign(h.context, broken);
    await h.runner.fire(job.id);
    expect(h.failures.count).toBe(1);
    expect(h.fired).toHaveLength(0);
    // 成功一次即归零：阈值统计的是连续次数。
    Object.assign(h.context, healthy);
    await h.runner.fire(job.id);
    expect(h.failures.count).toBe(0);
    Object.assign(h.context, broken);
    await h.runner.fire(job.id); await h.runner.fire(job.id);
    expect(h.fired).toEqual([{ kind: 'consecutive_turn_failures', count: 2 }]);
    h.close();
  });

  /**
   * 合成 id 冲突的核对（`docs/02 §10.2`）此前是死代码：`append` 回读既有行时按入参
   * `tg_message_id` 查询，返回值恒等于分配值（docs/28 · L-SCH-03）。判据改为 `inserted`。
   * 单进程内 `MAX+1` 不会冲突（SELECT 与 INSERT 之间没有 await），因此这里模拟另一个实例
   * 在这两步之间抢先插入了同一个号：冲突的表现是一条真实消息消失，必须失败而非静默处理。
   */
  it('合成触发消息撞号时抛 schedule_trigger_conflict，不认领别人那一行', async () => {
    const h = harness('sched-id-conflict');
    await call(h, 'schedule_create', { name: '早报', mode: 'notify', text: '早', cron: '0 * * * *' });
    const job = h.jobs.byName('chat:c1', '早报')!;
    const scopeOf = h.archive.scope.bind(h.archive);
    Object.assign(h.archive, { scope: (chatId: string, threadId: number | null = null) => {
      const scoped = scopeOf(chatId, threadId);
      const append = scoped.append.bind(scoped);
      return Object.assign(scoped, { append: (input: Parameters<typeof append>[0]) => {
        append({ ...input, text: '另一个实例抢先写的', fromKind: 'user', triggered: false, triggerReason: null });
        return append(input);
      } });
    } });
    await h.runner.fire(job.id);
    expect(h.sent).toHaveLength(0);
    expect(h.jobs.byId(job.id)).toMatchObject({ state: 'active', lastState: 'failed' });
    expect(h.jobs.byId(job.id)!.lastError).toContain('schedule_trigger_conflict');
    expect(h.db.prepare("SELECT COUNT(*) FROM log_events WHERE kind='schedule.failed'").pluck().get()).toBe(1);
    // 抢先插入的那一行保持不变；若静默继续执行，它会被当作本轮的触发消息使用。
    expect(h.db.prepare('SELECT text FROM messages').pluck().get()).toBe('另一个实例抢先写的');
    expect(h.db.prepare('SELECT COUNT(*) FROM turns').pluck().get()).toBe(0);
    h.close();
  });

  it('总开关关掉之后只跳过，不删任务', async () => {
    const h = harness('sched-disabled');
    await call(h, 'schedule_create', { name: '早报', mode: 'notify', text: '早', cron: '0 8 * * *' });
    const job = h.jobs.byName('chat:c1', '早报')!;
    h.setConfig({ schedule: { enabled: false } });
    await h.runner.fire(job.id);
    expect(h.sent).toHaveLength(0);
    expect(h.jobs.byId(job.id)).toMatchObject({ state: 'active', lastState: 'skipped' });
    h.close();
  });

  it('取消过的任务即使 cron 还在也不会跑', async () => {
    const h = harness('sched-cancelled-fire');
    await call(h, 'schedule_create', { name: '早报', mode: 'notify', text: '早', cron: '0 8 * * *' });
    const job = h.jobs.byName('chat:c1', '早报')!;
    h.jobs.finish(job.id, 'cancelled');
    await h.runner.fire(job.id);
    expect(h.sent).toHaveLength(0);
    expect(h.scheduler.names()).toHaveLength(0);
    h.close();
  });
});

/**
 * 修改一条任务（`schedule_update` 与 `PATCH /api/schedules/:id` 共用 `updateScheduledJob`）。
 * 本节验证工具侧：定位方式、只校验改动项、时区取任务行上的值、失败时整行回滚。
 */
describe('改任务', () => {
  it('改正文 / cron / 名字，重新排进调度器，而 run_count 与运行历史留着', async () => {
    const h = harness('sched-update');
    await call(h, 'schedule_create', { name: '早报', mode: 'agent', text: '汇总昨天', cron: '0 8 * * *' });
    const job = h.jobs.byName('chat:c1', '早报')!;
    await h.runner.fire(job.id);
    expect(h.scheduler.nextRun(`job:${job.id}`)!.getUTCHours()).toBe(8);
    const result = await call(h, 'schedule_update', { name: '早报', newName: '晚报', text: '汇总今天', cron: '0 20 * * *' });
    expect(result).toMatchObject({ ok: true, name: '晚报', cron: '0 20 * * *', payload: '汇总今天', runCount: 1 });
    // 停用后重建会把 run_count 与全部运行历史清零，而这正是本工具要替代的做法。
    expect(h.jobs.byId(job.id)).toMatchObject({ name: '晚报', payload: '汇总今天', cron: '0 20 * * *', runCount: 1, lastState: 'committed' });
    expect(h.scheduler.names()).toEqual([`job:${job.id}`]);
    expect(h.scheduler.nextRun(`job:${job.id}`)!.getUTCHours()).toBe(20);
    h.close();
  });

  it('改名撞同会话另一条回 duplicate_name，改成自己原来的名字放行', async () => {
    const h = harness('sched-update-dup');
    await call(h, 'schedule_create', { name: '早报', mode: 'notify', text: '早', cron: '0 8 * * *' });
    await call(h, 'schedule_create', { name: '晚报', mode: 'notify', text: '晚', cron: '0 20 * * *' });
    expect(await call(h, 'schedule_update', { name: '早报', newName: '晚报' })).toMatchObject({ ok: false, error: 'duplicate_name' });
    expect(h.jobs.byName('chat:c1', '早报')).not.toBeNull();
    // 把一条任务改成它当前的名字不算重名（`gateDuplicate` 排除自身），否则一并填写名字
    // 这一最常见的写法会持续失败。
    expect(await call(h, 'schedule_update', { name: '早报', newName: '早报', text: '早上好' })).toMatchObject({ ok: true, name: '早报', payload: '早上好' });
    h.close();
  });

  /** 本设计中最易出错的一处：收紧规则的语义是不再创建新任务，而非冻结全部存量任务。 */
  it('只改正文时不重新校验 cron —— 运维事后调大 minIntervalMinutes 也改得动', async () => {
    const h = harness('sched-update-keep-cron');
    await call(h, 'schedule_create', { name: '早报', mode: 'agent', text: '汇总', cron: '0 * * * *' });
    h.setConfig({ schedule: { minIntervalMinutes: 120 } });
    expect(await call(h, 'schedule_update', { name: '早报', text: '换一句' })).toMatchObject({ ok: true, payload: '换一句', cron: '0 * * * *' });
    // 放行并非因为该闸不存在，而是本次未提供该字段：实际修改 cron 时它仍会拦截。
    expect(await call(h, 'schedule_update', { name: '早报', cron: '0 * * * *' })).toMatchObject({ ok: false, error: 'interval_too_short' });
    h.close();
  });

  /**
   * 创建与修改在总开关上有意不对称，本用例即该不对称的正面凭据，后续不要将其当作
   * `updateScheduledJob` 遗漏了 `gateEnabled` 而补回去。`schedule.enabled=false` 时任务根本
   * 不会触发（`fire` 侧照常 skip），修改它没有副作用；而拒绝编辑的代价是：要修复一条异常任务，
   * 运维必须先打开总开关，而该操作会同时重新启用所有任务。
   */
  it('总开关关着时改得动，但仍然建不了，也不会因此就开始响', async () => {
    const h = harness('sched-update-disabled');
    await call(h, 'schedule_create', { name: '早报', mode: 'agent', text: '汇总', cron: '0 8 * * *' });
    const job = h.jobs.byName('chat:c1', '早报')!;
    h.setConfig({ schedule: { enabled: false } });
    expect(await call(h, 'schedule_update', { name: '早报', text: '改成这句', cron: '0 20 * * *' })).toMatchObject({ ok: true, payload: '改成这句', cron: '0 20 * * *' });
    expect(h.jobs.byId(job.id)).toMatchObject({ payload: '改成这句', cron: '0 20 * * *', state: 'active' });
    // 可修改不等于已排程：总开关仍然关闭，本轮不发送任何内容也不调用模型。
    await h.runner.fire(job.id);
    expect(h.sent).toHaveLength(0);
    expect(h.agentCalls).toHaveLength(0);
    expect(h.jobs.byId(job.id)).toMatchObject({ lastState: 'skipped' });
    // 创建仍然拒绝：总开关关闭时新建一条不会触发的任务，只会让人误以为它已排程。
    expect(await call(h, 'schedule_create', { name: '晚报', mode: 'notify', text: '晚', cron: '0 21 * * *' })).toMatchObject({ ok: false, error: 'schedule_disabled' });
    h.close();
  });

  it('at 按任务行上的时区解析，事后改 general.timezone 不改变已有任务的含义', async () => {
    const h = harness('sched-update-tz', { general: { timezone: 'Asia/Shanghai' } });
    await call(h, 'schedule_create', { name: '开会', mode: 'notify', text: '开会了', at: '2030-06-01T15:00' });
    const job = h.jobs.byName('chat:c1', '开会')!;
    expect(job.timezone).toBe('Asia/Shanghai');
    h.setConfig({ general: { timezone: 'UTC' } });
    // 若按 general.timezone 解释，18:00 会变成 18:00Z，任务被静默偏移 8 小时，且两侧都不报错。
    expect(await call(h, 'schedule_update', { name: '开会', at: '2030-06-01T18:00' })).toMatchObject({ ok: true, at: '2030-06-01T10:00:00.000Z', timezone: 'Asia/Shanghai' });
    expect(h.jobs.byId(job.id)!.runAt).toBe(Date.parse('2030-06-01T10:00:00Z'));
    h.close();
  });

  it('排不进调度器就整行回滚，旧的 name / payload / cron 都回来', async () => {
    const h = harness('sched-update-rollback');
    await call(h, 'schedule_create', { name: '早报', mode: 'notify', text: '早', cron: '0 8 * * *' });
    const job = h.jobs.byName('chat:c1', '早报')!;
    Object.assign(h.runner, { register: () => false });
    expect(await call(h, 'schedule_update', { name: '早报', newName: '晚报', text: '晚', cron: '0 20 * * *' })).toMatchObject({ ok: false, error: 'schedule_register_failed' });
    // 部分生效是最差的结果：数据库中已改名而调度器上排的仍是原时间。
    expect(h.jobs.byId(job.id)).toMatchObject({ state: 'active', name: '早报', payload: '早', cron: '0 8 * * *' });
    h.close();
  });

  it('跨会话改不到别人的同名任务，找不到就说找不到', async () => {
    const h = harness('sched-update-scope');
    await call(h, 'schedule_create', { name: '早报', mode: 'notify', text: 'c1 的', cron: '0 8 * * *' }, 'c1');
    await call(h, 'schedule_create', { name: '早报', mode: 'notify', text: 'c2 的', cron: '0 9 * * *' }, 'c2');
    expect(await call(h, 'schedule_update', { name: '早报', text: 'c2 改过了' }, 'c2')).toMatchObject({ ok: true });
    expect(h.jobs.byName('chat:c1', '早报')!.payload).toBe('c1 的');
    expect(h.jobs.byName('chat:c2', '早报')!.payload).toBe('c2 改过了');
    expect(await call(h, 'schedule_update', { name: '不存在', text: 'x' }, 'c1')).toMatchObject({ ok: false, error: 'not_found' });
    h.close();
  });

  /**
   * 预检（`gateDuplicate`）与写入之间存在窗口：`ux_sched_name` 是部分唯一索引，多实例下两个
   * 进程可能同时通过预检。这里禁用预检以确定性地复现该情形，固定的是判据本身：better-sqlite3 的
   * 消息是 UNIQUE constraint failed，按 `String(error).includes('SQLITE_CONSTRAINT')`
   * 判定永远为假，那个 catch 就等同于原样重抛（HTTP 侧表现为 500，模型侧表现为一句 tool_failed）。
   */
  it('撞上唯一索引时翻成 duplicate_name，而不是把 SqliteError 抛出去', async () => {
    const h = harness('sched-update-race');
    await call(h, 'schedule_create', { name: '早报', mode: 'notify', text: '早', cron: '0 8 * * *' });
    await call(h, 'schedule_create', { name: '晚报', mode: 'notify', text: '晚', cron: '0 20 * * *' });
    const job = h.jobs.byName('chat:c1', '早报')!;
    const racing = { byName: () => null, update: h.jobs.update.bind(h.jobs) } as unknown as ScheduleRepository;
    expect(updateScheduledJob(racing, h.runner, job, { name: '晚报' }, h.scheduleSettings()))
      .toMatchObject({ ok: false, error: 'duplicate_name' });
    expect(h.jobs.byId(job.id)!.name).toBe('早报');
    // 非 SQLITE_CONSTRAINT 的异常仍然抛出：不要把数据库故障也归为重名。
    const broken = { byName: () => null, update: () => { throw new Error('disk I/O error'); } } as unknown as ScheduleRepository;
    expect(() => updateScheduledJob(broken, h.runner, job, { name: '晚报' }, h.scheduleSettings())).toThrow('disk I/O error');
    h.close();
  });

  it('一个字段都不给回 nothing_to_update，两个触发字段都给回 invalid_schedule', async () => {
    const h = harness('sched-update-empty');
    await call(h, 'schedule_create', { name: '早报', mode: 'notify', text: '早', cron: '0 8 * * *' });
    // 不返回虚假成功：调用方（通常是模型）会认为已完成修改，而数据库中没有任何变化。
    expect(await call(h, 'schedule_update', { name: '早报' })).toMatchObject({ ok: false, error: 'nothing_to_update' });
    expect(await call(h, 'schedule_update', { name: '早报', cron: '0 9 * * *', at: '2030-01-01T08:00' })).toMatchObject({ ok: false, error: 'invalid_schedule' });
    expect(h.jobs.byName('chat:c1', '早报')).toMatchObject({ cron: '0 8 * * *', payload: '早' });
    h.close();
  });
});

/** 静默（docs/02 §10.5）。本节验证工具的两道闸与不投递但照常提交这一语义。 */
describe('本轮不用汇报（静默）', () => {
  /** 先调用 stay_silent 再把结论写入正文，`hint` 引导的正是这一形态。 */
  const silentAgent = (h: ReturnType<typeof harness>, reason: string, answer = '查过了，还是 1.4.2，没有更新。') =>
    h.setAgent(async (turn) => {
      expect(await h.registry.execute('stay_silent', { reason }, h.turnContext(turn) as never)).toMatchObject({ ok: true, silenced: true });
      return answer;
    });

  it('notify 收不了这个开关，agent 建与改都收得下', async () => {
    const h = harness('sched-silent-gate');
    // notify 到点原样发送预写正文、不调用模型，无人能触及 `stay_silent`：一个可存储但运行时
    // 不读取的开关比不存在更糟。
    expect(await call(h, 'schedule_create', { name: '喝水', mode: 'notify', text: '喝水', cron: '0 * * * *', silent: true })).toMatchObject({ ok: false, error: 'invalid_silent' });
    await call(h, 'schedule_create', { name: '喝水', mode: 'notify', text: '喝水', cron: '0 * * * *' });
    expect(await call(h, 'schedule_update', { name: '喝水', silent: true })).toMatchObject({ ok: false, error: 'invalid_silent' });
    expect(await call(h, 'schedule_create', { name: '查更新', mode: 'agent', text: '看看有没有新版本', cron: '0 12 * * *', silent: true })).toMatchObject({ ok: true, silent: true });
    expect(h.jobs.byName('chat:c1', '查更新')!.allowSilent).toBe(1);
    expect(await call(h, 'schedule_update', { name: '查更新', silent: false })).toMatchObject({ ok: true, silent: false });
    expect(h.jobs.byName('chat:c1', '查更新')!.allowSilent).toBe(0);
    h.close();
  });

  it('开了静默：一条消息都不发，但触发消息与产出两行都进上下文且轮次记 committed', async () => {
    const h = harness('sched-silent-commit');
    await call(h, 'schedule_create', { name: '查更新', mode: 'agent', text: '看看有没有新版本', cron: '0 12 * * *', silent: true });
    const job = h.jobs.byName('chat:c1', '查更新')!;
    silentAgent(h, '版本号没变');
    await h.runner.fire(job.id);
    expect(h.sent).toEqual([]);
    // 本需求的全部目的：让模型在下一轮知道自己已经查询过。省去的只有 sendMessage 这一步。
    const rows = h.db.prepare("SELECT role,origin,text_preview AS preview FROM context_messages WHERE key='chat:c1' ORDER BY ordinal").all() as Array<{ role: string; origin: string; preview: string }>;
    expect(rows).toEqual([
      { role: 'user', origin: 'trigger', preview: '[定时任务 查更新] 看看有没有新版本' },
      { role: 'assistant', origin: 'assistant', preview: '查过了，还是 1.4.2，没有更新。' },
    ]);
    // 该轮确实已提交：静默属于投递侧行为，区分依据在 last_state 与日志上。
    expect(h.db.prepare('SELECT state FROM turns').pluck().get()).toBe('committed');
    expect(h.jobs.byId(job.id)).toMatchObject({ state: 'active', runCount: 1, lastState: 'silent', lastError: null, silentStreak: 1 });
    const silent = logRows(h.db, 'schedule.silent')[0]!;
    expect(silent.level).toBe('info');
    // reason 始终存在：它是判断该任务是否已长期静默的唯一可读凭据。
    expect(JSON.parse(silent.data!)).toMatchObject({ streak: 1, warnAt: SILENT_STREAK_WARN, reason: '版本号没变' });
    // 一条正常提交的轮次缺少 tg.send，没有这一标志位时在 trace 中无法解释。
    expect(logPayload(h.db, 'turn.end')).toContain('"silenced":true');
    h.close();
  });

  it('没开静默：工具不进目录，硬调回 tool_unavailable，产出照常发出去', async () => {
    const h = harness('sched-silent-off');
    await call(h, 'schedule_create', { name: '早报', mode: 'agent', text: '汇总', cron: '0 8 * * *' });
    const job = h.jobs.byName('chat:c1', '早报')!;
    h.setAgent(async (turn) => {
      expect(h.registry.activeNames('trusted', h.turnContext(turn) as never)).not.toContain('stay_silent');
      // 目录过滤不是唯一边界：模型完全可能沿用上一轮的工具名直接调用，`admit()` 复查
      // `available()` 正是为此。
      expect(await h.registry.execute('stay_silent', { reason: '我不想说' }, h.turnContext(turn) as never)).toMatchObject({ ok: false, error: 'tool_unavailable' });
      return '早报：昨天聊了三件事。';
    });
    await h.runner.fire(job.id);
    expect(h.sent).toEqual([{ chatId: 'c1', text: '早报：昨天聊了三件事。' }]);
    expect(h.jobs.byId(job.id)).toMatchObject({ lastState: 'committed', silentStreak: 0 });
    expect(h.db.prepare("SELECT COUNT(*) FROM log_events WHERE kind='schedule.silent'").pluck().get()).toBe(0);
    h.close();
  });

  /** 子 agent 拿到的是父轮同一个 turn 对象：缺少主 agent 那道闸时，一个 researcher 即可让整轮静默。 */
  it('子 agent 拿不到这个工具，哪怕本轮确实允许静默', async () => {
    const h = harness('sched-silent-sub');
    await call(h, 'schedule_create', { name: '查更新', mode: 'agent', text: '看看', cron: '0 12 * * *', silent: true });
    const job = h.jobs.byName('chat:c1', '查更新')!;
    h.setAgent(async (turn) => {
      expect(turn.silenceable).toBe(true);
      expect(h.registry.activeNames('trusted', h.turnContext(turn, 'sub') as never)).not.toContain('stay_silent');
      expect(await h.registry.execute('stay_silent', { reason: '我是 researcher' }, h.turnContext(turn, 'sub') as never)).toMatchObject({ ok: false, error: 'tool_unavailable' });
      // 派发它的主 agent 全程不知情，因此本轮照常发送。
      expect(turn.silenced).toBeUndefined();
      return '查到了：1.5.0 发布了。';
    });
    await h.runner.fire(job.id);
    expect(h.sent).toEqual([{ chatId: 'c1', text: '查到了：1.5.0 发布了。' }]);
    expect(h.jobs.byId(job.id)).toMatchObject({ lastState: 'committed', silentStreak: 0 });
    h.close();
  });

  /**
   * 静默会掩盖任务持续失败：一条每天静默的任务与一条每天消耗一次模型调用却始终无法确定该输出什么的任务，
   * 在界面上都表现为没有消息。自动升级为 warn 是唯一的发现机制。
   */
  it('连续静默到阈值之后日志升 warn，成功说一次话就归零', async () => {
    const h = harness('sched-silent-streak');
    await call(h, 'schedule_create', { name: '查更新', mode: 'agent', text: '看看', cron: '0 12 * * *', silent: true });
    const job = h.jobs.byName('chat:c1', '查更新')!;
    silentAgent(h, '还是没有更新');
    for (let index = 0; index < SILENT_STREAK_WARN; index += 1) await h.runner.fire(job.id);
    const levels = (h.db.prepare("SELECT level FROM log_events WHERE kind='schedule.silent' ORDER BY id").all() as Array<{ level: string }>).map((row) => row.level);
    expect(levels).toEqual([...Array.from({ length: SILENT_STREAK_WARN - 1 }, () => 'info'), 'warn']);
    expect(h.jobs.byId(job.id)!.silentStreak).toBe(SILENT_STREAK_WARN);
    // 只要输出过一次即说明它仍能判断何时应当输出，任何非 silent 的结果都归零。
    h.setAgent(() => Promise.resolve('1.5.0 发布了。'));
    await h.runner.fire(job.id);
    expect(h.jobs.byId(job.id)).toMatchObject({ lastState: 'committed', silentStreak: 0 });
    h.close();
  });

  /**
   * `model_returned_empty` 这道闸不对静默开例外：静默加空正文意味着上下文中没有留下任何内容，
   * 而让模型在下一轮知道自己已经查询过正是该功能的全部目的。
   */
  it('静默 + 空正文仍然记 failed，上下文里一行都不留', async () => {
    const h = harness('sched-silent-empty');
    await call(h, 'schedule_create', { name: '查更新', mode: 'agent', text: '看看', cron: '0 12 * * *', silent: true });
    const job = h.jobs.byName('chat:c1', '查更新')!;
    silentAgent(h, '没什么可说的', '   ');
    await h.runner.fire(job.id);
    expect(h.sent).toEqual([]);
    expect(h.db.prepare('SELECT COUNT(*) FROM context_messages').pluck().get()).toBe(0);
    expect(h.db.prepare('SELECT state,error FROM turns').get()).toMatchObject({ state: 'failed', error: 'model_returned_empty' });
    expect(h.jobs.byId(job.id)).toMatchObject({ lastState: 'failed', lastError: 'model_returned_empty', silentStreak: 0 });
    // 未投递不等于静默：本轮走的是失败路径，不应产生任何 `schedule.silent` 记录。
    expect(h.db.prepare("SELECT COUNT(*) FROM log_events WHERE kind='schedule.silent'").pluck().get()).toBe(0);
    expect(h.db.prepare("SELECT COUNT(*) FROM log_events WHERE kind='schedule.failed'").pluck().get()).toBe(1);
    h.close();
  });
});

describe('装载与错过', () => {
  it('停机期间错过的不补跑：一次性任务置 done，周期任务照排下一次', () => {
    const h = harness('sched-load');
    const now = Date.now();
    h.jobs.create({ id: 'j-past', key: 'chat:c1', chatId: 'c1', threadId: null, createdBy: '7', name: '过期的会', mode: 'notify', cron: null, runAt: now - 3_600_000, timezone: 'UTC', payload: '开会' });
    h.jobs.create({ id: 'j-future', key: 'chat:c1', chatId: 'c1', threadId: null, createdBy: '7', name: '将来的会', mode: 'notify', cron: null, runAt: now + 3_600_000, timezone: 'UTC', payload: '开会' });
    // 上次触发在两天前的周期任务：中间的触发点都错过了。
    h.jobs.create({ id: 'j-cron', key: 'chat:c1', chatId: 'c1', threadId: null, createdBy: '7', name: '早报', mode: 'notify', cron: '0 8 * * *', runAt: null, timezone: 'UTC', payload: '早' });
    h.db.prepare('UPDATE scheduled_jobs SET last_run_at=? WHERE id=?').run(now - 2 * 86_400_000, 'j-cron');
    const loaded = h.runner.load();
    expect(loaded).toEqual({ registered: 2, missed: 2 });
    // 过期的一次性任务不会留在 active 中空转，也不会被补跑（没有发送任何消息）。
    expect(h.jobs.byId('j-past')).toMatchObject({ state: 'done', lastState: 'missed', runCount: 0 });
    expect(h.jobs.byId('j-cron')).toMatchObject({ state: 'active', runCount: 0 });
    expect(h.sent).toHaveLength(0);
    expect(new Set(h.scheduler.names())).toEqual(new Set(['job:j-future', 'job:j-cron']));
    // 每条错过的触发都记录在日志中，否则任务未按时执行将无据可查。
    const missed = h.db.prepare("SELECT COUNT(*) FROM log_events WHERE kind='schedule.missed'").pluck().get();
    expect(missed).toBe(2);
    h.close();
  });

  it('刚建好、还没到第一次触发的任务不算错过', () => {
    const h = harness('sched-load-fresh');
    h.jobs.create({ id: 'j-new', key: 'chat:c1', chatId: 'c1', threadId: null, createdBy: '7', name: '早报', mode: 'notify', cron: '0 8 * * *', runAt: null, timezone: 'UTC', payload: '早' });
    expect(h.runner.load()).toEqual({ registered: 1, missed: 0 });
    h.close();
  });

  it('库里那行的 cron 坏了就停用它，而不是让装载整个失败', () => {
    const h = harness('sched-load-broken');
    // 迁移之后手工改库，或跨版本残留：CHECK 无法约束表达式本身。
    h.db.prepare(`INSERT INTO scheduled_jobs(id,key,chat_id,thread_id,created_by,name,mode,cron,run_at,timezone,payload,state,created_at,updated_at)
      VALUES ('j-bad','chat:c1','c1',NULL,'7','坏的','notify','根本不是 cron',NULL,'UTC','x','active',?,?)`).run(Date.now(), Date.now());
    h.jobs.create({ id: 'j-ok', key: 'chat:c1', chatId: 'c1', threadId: null, createdBy: '7', name: '好的', mode: 'notify', cron: '0 8 * * *', runAt: null, timezone: 'UTC', payload: 'x' });
    expect(h.runner.load()).toMatchObject({ registered: 1 });
    expect(h.jobs.byId('j-bad')).toMatchObject({ state: 'cancelled', lastState: 'failed' });
    expect(h.scheduler.names()).toEqual(['job:j-ok']);
    h.close();
  });
});

describe('保留清理', () => {
  it('结束的任务按 schedule.retentionDays 清，活跃的永不清', () => {
    const h = harness('sched-purge');
    h.jobs.create({ id: 'j-old', key: 'chat:c1', chatId: 'c1', threadId: null, createdBy: '7', name: '旧的', mode: 'notify', cron: '0 8 * * *', runAt: null, timezone: 'UTC', payload: 'x' });
    h.jobs.create({ id: 'j-live', key: 'chat:c1', chatId: 'c1', threadId: null, createdBy: '7', name: '活的', mode: 'notify', cron: '0 9 * * *', runAt: null, timezone: 'UTC', payload: 'x' });
    h.jobs.finish('j-old', 'cancelled');
    h.db.prepare('UPDATE scheduled_jobs SET updated_at=? WHERE id=?').run(Date.now() - 40 * 86_400_000, 'j-old');
    // 活跃的那条同样刻意标记为很旧：它不应因长期未变动而被清理。
    h.db.prepare('UPDATE scheduled_jobs SET updated_at=? WHERE id=?').run(Date.now() - 40 * 86_400_000, 'j-live');
    expect(h.jobs.purge(Date.now() - 30 * 86_400_000)).toBe(1);
    expect(h.jobs.byId('j-old')).toBeNull();
    expect(h.jobs.byId('j-live')).not.toBeNull();
    h.close();
  });
});
