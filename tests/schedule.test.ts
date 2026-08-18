import { mkdirSync, rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ArchiveRepository, OperationsRepository, PrincipalRepository, ScheduleRepository, TurnRepository, closeDatabase, migrateDatabase, openDatabase } from '@luoli/db';
import { ContextEngine, EventBus, LogSink, MemoryStore, QuotaGuard, SYNTHETIC_TG_MESSAGE_ID_BASE, ScheduledJobRunner, Scheduler, ToolRegistry, TurnConcurrency, TurnRegistry, configSchema, registerScheduleTools } from '@luoli/core';
import type { Config } from '@luoli/core';
import type { RuntimeTurnContext } from '@luoli/shared';

/**
 * 定时任务（docs/14 §2 Q4 的四条决策）。这里守的是那四条本身：
 *
 * - 触发时**起一条完整轮次并提交**（notify 也提交），所以定时产出照常进上下文；
 * - 停机期间错过的**不补跑**，只记 `schedule.missed`；
 * - 落点绑死本会话 —— 工具参数里没有 chatId，list / cancel 也跨不过 key；
 * - 触发时**重算有效角色**，创建之后被降级/拉黑的人排的任务不该继续花钱。
 */
function harness(name: string, extra: Record<string, unknown> = {}) {
  const path = `./data/${name}.test.db`;
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
  const directory = `./data/${name}-logs`; rmSync(directory, { recursive: true, force: true }); mkdirSync(directory, { recursive: true });
  const memoryDir = `./data/${name}-memory`; rmSync(memoryDir, { recursive: true, force: true }); mkdirSync(memoryDir, { recursive: true });
  const db = openDatabase(path); migrateDatabase(db);
  const config = configSchema.parse({ access: { bootstrapOwnerId: '1' }, general: { timezone: 'UTC' }, quota: { enabled: false }, ...extra }) as Config;
  const events = new EventBus();
  const log = new LogSink(new OperationsRepository(db), directory, [], { level: 'debug', console: 'off' });
  const archive = new ArchiveRepository(db);
  const jobs = new ScheduleRepository(db);
  const scheduler = new Scheduler();
  const principals = new PrincipalRepository(db);
  const sent: Array<{ chatId: string; text: string }> = [];
  const agentCalls: RuntimeTurnContext[] = [];
  let live = config;
  const context = new ContextEngine(db, archive);
  const runner = new ScheduledJobRunner({
    db, jobs, scheduler, context, archive, turns: new TurnRepository(db),
    registry: new TurnRegistry(), concurrency: new TurnConcurrency(config.concurrency),
    quota: new QuotaGuard(db, config.general.timezone, events), memory: new MemoryStore(db, memoryDir, 1500, 3000),
    tools: new ToolRegistry(log, { request: async () => true }, { maxRegistered: 200, maxCallsPerTurn: 50, maxConsecutiveErrors: 10 }), log,
    config: () => live,
    telegram: () => ({ sendMessage: (target, text) => { sent.push({ chatId: target.chatId, text }); return Promise.resolve({ ok: true, messageIds: [1] }); },
      sendPhoto: () => Promise.resolve({ ok: true }), sendFile: () => Promise.resolve({ ok: true }), react: () => Promise.resolve({ ok: true }), pin: () => Promise.resolve({ ok: true }) }),
    roleOf: (kind, tgId) => principals.roleOf(kind, tgId),
    runAgent: (turn) => { agentCalls.push(turn); return Promise.resolve('早报：昨天聊了三件事。'); },
  });
  const registry = new ToolRegistry(log, { request: async () => true }, { maxRegistered: 200, maxCallsPerTurn: 50, maxConsecutiveErrors: 10 });
  registerScheduleTools(registry, { jobs, runner, deliverable: () => true });
  const contextFor = (chatId: string, userId = '7'): unknown => ({
    turn: { turnId: `t-${chatId}`, key: `chat:${chatId}`, chatId, threadId: null, initiatorUserId: userId, effectiveRole: 'trusted',
      isPrivate: true, baseCommitId: null, config: live, snapshot: { messages: [], ordinals: [], tokens: 0, windowStart: 1, headOrdinal: 0 },
      delta: [], abortSignal: new AbortController().signal },
    workspace: `./data/${name}-workspace`, agentKind: 'main',
  });
  principals.upsertSeen({ id: 'user:7', kind: 'user', tgId: '7', role: 'trusted', displayName: '阿离', username: null, chatType: null });
  return { db, jobs, runner, registry, scheduler, principals, sent, agentCalls, contextFor, context,
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
    // 上海是 UTC+8，所以「6 月 1 日下午三点」= 当天 07:00Z。宿主时区是什么都不影响这个结果。
    expect(h.jobs.byName('chat:c1', '开会')!.runAt).toBe(Date.parse('2030-06-01T07:00:00Z'));
    expect(result).toMatchObject({ ok: true, at: '2030-06-01T07:00:00.000Z', timezone: 'Asia/Shanghai' });
    h.close();
  });

  it('同会话不许重名，跨会话同名互不干扰，且取消跨不过会话', async () => {
    const h = harness('sched-scope');
    expect(await call(h, 'schedule_create', { name: '早报', mode: 'notify', text: '早', cron: '0 8 * * *' }, 'c1')).toMatchObject({ ok: true });
    expect(await call(h, 'schedule_create', { name: '早报', mode: 'notify', text: '早', cron: '0 8 * * *' }, 'c1')).toMatchObject({ ok: false, error: 'duplicate_name' });
    expect(await call(h, 'schedule_create', { name: '早报', mode: 'notify', text: '早', cron: '0 9 * * *' }, 'c2')).toMatchObject({ ok: true });
    // c2 只看得见自己那一个。
    expect((await call(h, 'schedule_list', {}, 'c2')).jobs).toHaveLength(1);
    // 关键一条：c2 取消「早报」只能取消自己那个，c1 的还在（工具里没有 chatId 参数，也不收 id）。
    expect(await call(h, 'schedule_cancel', { name: '早报' }, 'c2')).toMatchObject({ ok: true });
    expect(h.jobs.byName('chat:c1', '早报')).not.toBeNull();
    expect(h.jobs.byName('chat:c2', '早报')).toBeNull();
    // 取消之后名字腾出来了，可以重建。
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
    // 「照常进上下文」的实证：触发消息 + 助手回复都提交进了 context_messages，而且是同一轮。
    const rows = h.db.prepare("SELECT role,origin,text_preview AS preview FROM context_messages WHERE key='chat:c1' ORDER BY ordinal").all() as Array<{ role: string; origin: string; preview: string }>;
    expect(rows).toEqual([
      { role: 'user', origin: 'trigger', preview: '[定时任务 喝水提醒] 该喝水了' },
      { role: 'assistant', origin: 'assistant', preview: '该喝水了' },
    ]);
    expect(h.db.prepare("SELECT state,trigger_reason AS reason FROM turns").get()).toMatchObject({ state: 'committed', reason: 'schedule' });
    // 合成触发消息落在保留高位段，不会跟真实 Telegram 消息号撞上。
    const trigger = h.db.prepare("SELECT tg_message_id AS id,from_kind AS kind FROM messages WHERE direction='in'").get() as { id: number; kind: string };
    expect(trigger.kind).toBe('system');
    expect(trigger.id).toBeGreaterThanOrEqual(SYNTHETIC_TG_MESSAGE_ID_BASE);
    expect(h.jobs.byId(job.id)).toMatchObject({ state: 'active', runCount: 1, lastState: 'committed' });
    h.close();
  });

  /**
   * `abortTurn` 也在写库（`releaseClaims`，`cancel.commitPartial` 开着时还会跑一整个
   * `commitTurn`）。它此前排在 `turns.finish` **前面**且没有自己的 try，抛出来那行就永久停在
   * `state='running'` —— `GET /api/turns/active` 与总览页的 running 计数在整个进程生命周期内
   * 都是错的，直到下次重启的 `recoverAfterCrash` 才收拾。清理是尽力而为，记状态不是。
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
    // 清理失败自己也要留痕，否则「认领没释放」是查不出来的。
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
    // 撞号会让 INSERT OR IGNORE 静静返回上一次那一行，于是第二轮的触发消息其实是第一轮的。
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
    // 模型拿到的是一条真实的轮次上下文：任务描述已经作为触发消息进了快照。
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
    // trusted → limited：`schedule_create` 的 minRole 是 trusted，所以这一次不跑，但任务留着。
    h.principals.setRole('user:7', 'limited', 'test');
    await h.runner.fire(job.id);
    expect(h.sent).toHaveLength(0);
    expect(h.jobs.byId(job.id)).toMatchObject({ state: 'active', lastState: 'skipped', lastError: 'role_downgraded' });
    // 权限回来了，任务照跑 —— 这就是「跳过」而不是「停用」的意义。
    h.principals.setRole('user:7', 'trusted', 'test');
    await h.runner.fire(job.id);
    expect(h.sent).toHaveLength(1);
    // blocked 是永久判定：任务停用并从调度器摘掉。
    h.principals.setRole('user:7', 'blocked', 'test');
    await h.runner.fire(job.id);
    expect(h.sent).toHaveLength(1);
    expect(h.jobs.byId(job.id)).toMatchObject({ state: 'cancelled' });
    expect(h.scheduler.names()).toHaveLength(0);
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
    // 过期的一次性任务不留在 active 里空转，也没有被补跑（没有任何消息发出去）。
    expect(h.jobs.byId('j-past')).toMatchObject({ state: 'done', lastState: 'missed', runCount: 0 });
    expect(h.jobs.byId('j-cron')).toMatchObject({ state: 'active', runCount: 0 });
    expect(h.sent).toHaveLength(0);
    expect(new Set(h.scheduler.names())).toEqual(new Set(['job:j-future', 'job:j-cron']));
    // 每条错过的都在日志里说出来了，否则「今天早报没发」查无实据。
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
    // 迁移之后手改库、或跨版本残留：CHECK 管不到表达式本身。
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
    // 活跃的那条也故意标成很旧：它不该因为「很久没动」被清掉。
    h.db.prepare('UPDATE scheduled_jobs SET updated_at=? WHERE id=?').run(Date.now() - 40 * 86_400_000, 'j-live');
    expect(h.jobs.purge(Date.now() - 30 * 86_400_000)).toBe(1);
    expect(h.jobs.byId('j-old')).toBeNull();
    expect(h.jobs.byId('j-live')).not.toBeNull();
    h.close();
  });
});
