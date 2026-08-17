import { readFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ArchiveRepository, OperationsRepository, PrincipalRepository, ScheduleRepository, closeDatabase, migrateDatabase, openDatabase, type ScheduledJob } from '@luoli/db';
import { ContextEngine, DatabaseApprovalBroker, EventBus, LogSink, MaintenanceService, ProviderStore, Secrets, configSchema } from '@luoli/core';
import { createServer } from '@luoli/server';

/**
 * 定时任务的 WebUI 面板（docs/21 · `G-API-16`）。此前运维在界面上既看不到这个部署有哪些任务
 * 在排、也停不掉任何一条 —— 止损只能去 Telegram 让 bot 跑 `schedule_cancel`。
 *
 * 这里守四件事：跨会话看得见、建任务与工具**共用同一套校验**、停掉与手动触发都不撒谎、
 * 以及没装配运行时时如实说「没装配」而不是显示零条任务。
 */
function harness(name: string, extra: Record<string, unknown> = {}, wired = true) {
  const path = `./data/${name}.test.db`;
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
  const logDir = `./data/${name}-logs`; rmSync(logDir, { recursive: true, force: true }); mkdirSync(logDir, { recursive: true });
  const db = openDatabase(path); migrateDatabase(db);
  const config = configSchema.parse({ access: { bootstrapOwnerId: '1' }, general: { timezone: 'UTC' },
    webui: { passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$x$x' }, logs: { dir: logDir }, ...extra });
  const operations = new OperationsRepository(db);
  const events = new EventBus();
  const log = new LogSink(operations, logDir, [], { console: 'off' });
  const archive = new ArchiveRepository(db);
  const principals = new PrincipalRepository(db);
  const jobs = new ScheduleRepository(db);
  const registered = new Set<string>();
  const fired: string[] = [];
  const runner = {
    register: (job: ScheduledJob) => { registered.add(job.id); return true; },
    unregister: (id: string) => registered.delete(id),
    nextRun: (id: string) => (registered.has(id) ? new Date(1_900_000_000_000) : null),
    fire: (id: string) => { fired.push(id); return Promise.resolve(); },
  };
  // 两个会话：面板要跨会话看得见，而工具那边只看得见自己那一个。
  for (const [key, chatId] of [['chat:c1', 'c1'], ['chat:c2', '-100200']] as const) {
    db.prepare("INSERT INTO contexts(key,chat_id,thread_id,scope,claim_watermark,created_at,updated_at) VALUES (?,?,NULL,'chat',0,?,?)").run(key, chatId, Date.now(), Date.now());
  }
  principals.upsertSeen({ id: 'user:1', kind: 'user', tgId: '1', role: 'owner', displayName: '阿离', username: 'ali', chatType: null });
  principals.upsertSeen({ id: 'chat:-100200', kind: 'chat', tgId: '-100200', role: 'trusted', displayName: '开发组', username: null, chatType: 'supergroup' });
  const app = createServer({ config, db, operations, principals, archive, context: new ContextEngine(db, archive),
    providers: new ProviderStore(db, new Secrets('x'.repeat(32))), approvals: new DatabaseApprovalBroker(db, config, events, log),
    maintenance: new MaintenanceService(db, path, 2, 30, logDir), events, log,
    ...(wired ? { schedules: { jobs, runner } } : {}), configSchema: {}, startedAt: Date.now(), setup: undefined });
  const session = operations.createSession(1);
  return { app, db, jobs, runner, registered, fired,
    headers: { cookie: `luoli_sid=${session.id}`, 'x-csrf-token': session.csrf, 'content-type': 'application/json' },
    close: () => { closeDatabase(db); } };
}

const body = async <T>(response: Response): Promise<T> => (await response.json() as { data: T }).data;
const error = async (response: Response): Promise<string> => (await response.json() as { error: { code: string } }).error.code;

interface JobRow { id: string; key: string; name: string; mode: string; state: string; chatLabel: string | null; creatorLabel: string | null; nextRun?: string; cron?: string; at?: string; lastState?: string }
interface ListBody { available: boolean; enabled: boolean; timezone: string; jobs: JobRow[]; settings?: { maxPerChat: number } }

describe('定时任务面板端点', () => {
  it('跨会话列出任务，带会话名、创建者与下一次触发', async () => {
    const h = harness('sched-api-list');
    for (const [key, chatId, name] of [['chat:c1', 'c1', '每日早报'], ['chat:c2', '-100200', '周报']] as const) {
      await h.app.request('/api/schedules', { method: 'POST', headers: h.headers, body: JSON.stringify({ key, name, mode: 'notify', text: '正文', cron: '0 8 * * *' }) });
      expect(h.jobs.byName(key, name)?.chatId).toBe(chatId);
    }
    const list = await body<ListBody>(await h.app.request('/api/schedules', { headers: h.headers }));
    expect(list).toMatchObject({ available: true, enabled: true, timezone: 'UTC' });
    expect(list.settings).toMatchObject({ maxPerChat: 20 });
    expect(list.jobs.map((job) => job.name).sort()).toEqual(['周报', '每日早报']);
    const group = list.jobs.find((job) => job.key === 'chat:c2')!;
    expect(group).toMatchObject({ chatLabel: '开发组', creatorLabel: '阿离 (@ali)', state: 'active', mode: 'notify', cron: '0 8 * * *' });
    expect(group.nextRun).toBe(new Date(1_900_000_000_000).toISOString());
    h.close();
  });

  it('建任务与工具共用同一套校验，一条都不落库', async () => {
    const h = harness('sched-api-validate', { schedule: { maxPerChat: 1, minIntervalMinutes: 5 } });
    const post = async (payload: Record<string, unknown>): Promise<Response> =>
      h.app.request('/api/schedules', { method: 'POST', headers: h.headers, body: JSON.stringify({ key: 'chat:c1', name: 'a', mode: 'notify', text: 'x', ...payload }) });
    expect(await error(await post({}))).toBe('invalid_schedule');
    expect(await error(await post({ cron: '0 8 * * *', at: '2030-01-01T08:00' }))).toBe('invalid_schedule');
    expect(await error(await post({ cron: '不是 cron' }))).toBe('invalid_cron');
    expect(await error(await post({ cron: '* * * * *' }))).toBe('interval_too_short');
    expect(await error(await post({ at: '2020-01-01T08:00' }))).toBe('at_in_the_past');
    expect(await error(await post({ at: '不是时间' }))).toBe('invalid_at');
    expect(await error(await post({ cron: '0 8 * * *', mode: '随便' }))).toBe('invalid_mode');
    expect(await error(await post({ cron: '0 8 * * *', text: '' }))).toBe('invalid_text');
    // 落点从 contexts 反查：不存在的会话建不出来，客户端也无法自带 chatId 绕开这一步。
    expect(await error(await h.app.request('/api/schedules', { method: 'POST', headers: h.headers, body: JSON.stringify({ key: 'chat:nope', name: 'a', mode: 'notify', text: 'x', cron: '0 8 * * *' }) }))).toBe('chat_not_found');
    expect(h.jobs.listAll()).toEqual([]);
    // maxPerChat=1：第二条被拒，且重名与上限的判定跟工具那边同源。
    expect((await post({ cron: '0 8 * * *' })).status).toBe(200);
    expect(await error(await post({ cron: '0 9 * * *', name: 'b' }))).toBe('too_many_jobs');
    expect(await error(await post({ cron: '0 9 * * *' }))).toBe('too_many_jobs');
    h.close();
  });

  it('一次性任务按 general.timezone 解析，不是宿主时区', async () => {
    const h = harness('sched-api-tz', { general: { timezone: 'Asia/Shanghai' } });
    const created = await body<JobRow>(await h.app.request('/api/schedules', { method: 'POST', headers: h.headers,
      body: JSON.stringify({ key: 'chat:c1', name: '开会', mode: 'notify', text: '开会了', at: '2030-06-01T15:00' }) }));
    expect(created.at).toBe('2030-06-01T07:00:00.000Z');
    expect(h.jobs.byName('chat:c1', '开会')!.runAt).toBe(Date.parse('2030-06-01T07:00:00Z'));
    h.close();
  });

  it('停掉一条任务；已经停了的如实回 cancelled:false', async () => {
    const h = harness('sched-api-cancel');
    const created = await body<JobRow>(await h.app.request('/api/schedules', { method: 'POST', headers: h.headers,
      body: JSON.stringify({ key: 'chat:c1', name: '早报', mode: 'notify', text: '早', cron: '0 8 * * *' }) }));
    expect(h.registered.has(created.id)).toBe(true);
    expect(await body<{ cancelled: boolean }>(await h.app.request(`/api/schedules/${created.id}`, { method: 'DELETE', headers: h.headers }))).toEqual({ cancelled: true, name: '早报' });
    expect(h.jobs.byId(created.id)!.state).toBe('cancelled');
    // 从调度器里也摘掉了：只改库不摘 cron 等于「界面上停了、到点照样响」。
    expect(h.registered.has(created.id)).toBe(false);
    // 再停一次不是假成功。
    expect(await body<{ cancelled: boolean }>(await h.app.request(`/api/schedules/${created.id}`, { method: 'DELETE', headers: h.headers }))).toEqual({ cancelled: false, name: '早报' });
    expect((await h.app.request('/api/schedules/nope', { method: 'DELETE', headers: h.headers })).status).toBe(404);
    h.close();
  });

  it('立即触发：不等它跑完，且已结束的任务触发不了', async () => {
    const h = harness('sched-api-trigger');
    const created = await body<JobRow>(await h.app.request('/api/schedules', { method: 'POST', headers: h.headers,
      body: JSON.stringify({ key: 'chat:c1', name: '早报', mode: 'agent', text: '汇总', cron: '0 8 * * *' }) }));
    const started = await body<{ started: boolean; mode: string }>(await h.app.request(`/api/schedules/${created.id}/trigger`, { method: 'POST', headers: h.headers }));
    expect(started).toMatchObject({ started: true, mode: 'agent' });
    expect(h.fired).toEqual([created.id]);
    // 手动触发落一条 schedule.fired（带 manual:true），否则「谁在半夜点了这一下」查不出来。
    const logged = h.db.prepare("SELECT data_json AS data FROM log_events WHERE kind='schedule.fired' ORDER BY id DESC LIMIT 1").get() as { data: string };
    expect(JSON.parse(logged.data)).toMatchObject({ actor: 'webui', manual: true });
    h.jobs.finish(created.id, 'cancelled');
    expect((await h.app.request(`/api/schedules/${created.id}/trigger`, { method: 'POST', headers: h.headers })).status).toBe(409);
    expect((await h.app.request('/api/schedules/nope/trigger', { method: 'POST', headers: h.headers })).status).toBe(404);
    expect(h.fired).toHaveLength(1);
    h.close();
  });

  it('没装配运行时就说没装配，而不是显示零条任务', async () => {
    const h = harness('sched-api-absent', {}, false);
    const list = await body<ListBody>(await h.app.request('/api/schedules', { headers: h.headers }));
    // `available:false` 与「真的一条都没有」在运维眼里是两回事（docs/16 §5「摘除比伪造安全」）。
    expect(list).toMatchObject({ available: false, jobs: [] });
    for (const [path, method] of [['/api/schedules', 'POST'], ['/api/schedules/x', 'DELETE'], ['/api/schedules/x/trigger', 'POST']] as const) {
      const response = await h.app.request(path, { method, headers: h.headers, ...(method === 'POST' ? { body: '{}' } : {}) });
      expect(response.status, `${method} ${path}`).toBe(500);
      expect(await error(response)).toBe('not_implemented');
    }
    h.close();
  });

  it('没配 bootstrapOwnerId 时拒绝建，而不是建一条没人负责的任务', async () => {
    const h = harness('sched-api-noowner', { access: { bootstrapOwnerId: '' } });
    expect(await error(await h.app.request('/api/schedules', { method: 'POST', headers: h.headers,
      body: JSON.stringify({ key: 'chat:c1', name: '早报', mode: 'notify', text: '早', cron: '0 8 * * *' }) }))).toBe('owner_unset');
    h.close();
  });

  it('写操作要 CSRF', async () => {
    const h = harness('sched-api-csrf');
    const { 'x-csrf-token': _csrf, ...noCsrf } = h.headers;
    expect((await h.app.request('/api/schedules', { method: 'POST', headers: noCsrf, body: '{}' })).status).toBe(403);
    h.close();
  });
});

describe('装配', () => {
  it('main.ts 把定时任务运行时交给了 createServer', () => {
    // 依赖是可选的（跟 `ledger?` / `restart?` 同一写法），所以漏传不会有编译错误 ——
    // 表现是面板一直说「没装配运行时」。这条断言就是那个漏传的守卫。
    const source = readFileSync(resolve('apps/bot/src/main.ts'), 'utf8');
    expect(source).toMatch(/schedules:\s*\{\s*jobs:\s*scheduledJobs,\s*runner:\s*scheduleRunner\s*\}/);
    // 装载要在 bot 建好之后：早于它的话第一批任务触发时 telegram() 还是 null。
    expect(source).toContain('scheduleRunner.load()');
  });
});
