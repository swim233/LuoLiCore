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
  // 建的时候就 add 过一次，所以「改完还在集合里」是个恒真断言 —— 要看的是**又排了一遍**。
  const registerCalls: string[] = [];
  const fired: string[] = [];
  const runner = {
    // `loaded` = 「`load()` 跑过了，投递通道已具备」。手动触发端点拿它挡启动窗口：HTTP 从
    // `serve()` 起就在监听，此时触发会开一条发不出去的轮次（docs/28 · L-SCH-01）。
    loaded: true,
    register: (job: ScheduledJob) => { registered.add(job.id); registerCalls.push(job.id); return true; },
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
  return { app, db, jobs, runner, registered, registerCalls, fired,
    headers: { cookie: `luoli_sid=${session.id}`, 'x-csrf-token': session.csrf, 'content-type': 'application/json' },
    close: () => { closeDatabase(db); } };
}

const body = async <T>(response: Response): Promise<T> => (await response.json() as { data: T }).data;
const error = async (response: Response): Promise<string> => (await response.json() as { error: { code: string } }).error.code;

interface JobRow { id: string; key: string; name: string; mode: string; state: string; chatLabel: string | null; creatorLabel: string | null; nextRun?: string; cron?: string; at?: string; lastState?: string; payload?: string; silent?: boolean; silentStreak?: number }
interface ListBody { available: boolean; enabled: boolean; timezone: string; jobs: JobRow[]; settings?: { maxPerChat: number }; total?: number; truncated?: boolean }

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
    // 改时间走的是**行上那个时区**（`updateScheduledJob` 不收 timezone 参数）。搞错方向的表现是
    // 任务被静默挪走几小时，两次操作各自都不报错。
    const moved = await body<JobRow>(await h.app.request(`/api/schedules/${created.id}`, { method: 'PATCH', headers: h.headers, body: JSON.stringify({ at: '2030-06-01T16:30' }) }));
    expect(moved.at).toBe('2030-06-01T08:30:00.000Z');
    expect(h.jobs.byId(created.id)).toMatchObject({ cron: null, runAt: Date.parse('2030-06-01T08:30:00Z') });
    h.close();
  });

  /**
   * 改任务与 `schedule_update` 工具共用 `updateScheduledJob`（CLAUDE.md：「建与改的校验只有一份」）。
   * 这一串逐条错误码就是那件事的证明 —— 形状照建任务那条写，两边少一条都能看出来。
   */
  it('改任务与工具共用同一套校验，一条都不落库', async () => {
    const h = harness('sched-api-patch', { schedule: { minIntervalMinutes: 5, maxPayloadChars: 20 } });
    const created = await body<JobRow>(await h.app.request('/api/schedules', { method: 'POST', headers: h.headers,
      body: JSON.stringify({ key: 'chat:c1', name: '早报', mode: 'agent', text: '汇总昨天', cron: '0 8 * * *' }) }));
    await h.app.request('/api/schedules', { method: 'POST', headers: h.headers, body: JSON.stringify({ key: 'chat:c1', name: '周报', mode: 'agent', text: '汇总上周', cron: '0 9 * * 1' }) });
    const patch = async (payload: Record<string, unknown>): Promise<Response> =>
      h.app.request(`/api/schedules/${created.id}`, { method: 'PATCH', headers: h.headers, body: JSON.stringify(payload) });
    // 一个字段都没给不回假成功：调用方（多半是模型）会以为自己改了东西，而库里一个字没动。
    expect(await error(await patch({}))).toBe('nothing_to_update');
    expect(await error(await patch({ name: '   ' }))).toBe('invalid_name');
    expect(await error(await patch({ name: '周报' }))).toBe('duplicate_name');
    expect(await error(await patch({ text: '' }))).toBe('invalid_text');
    expect(await error(await patch({ text: 'x'.repeat(21) }))).toBe('text_too_long');
    expect(await error(await patch({ cron: '0 8 * * *', at: '2030-01-01T08:00' }))).toBe('invalid_schedule');
    expect(await error(await patch({ cron: '不是 cron' }))).toBe('invalid_cron');
    expect(await error(await patch({ cron: '* * * * *' }))).toBe('interval_too_short');
    expect(await error(await patch({ at: '2020-01-01T08:00' }))).toBe('at_in_the_past');
    expect(await error(await patch({ at: '不是时间' }))).toBe('invalid_at');
    // 改名成自己现在的名字不是重名（`gateDuplicate` 排除了自己）。
    expect((await patch({ name: '早报' })).status).toBe(200);
    expect(h.jobs.byId(created.id)).toMatchObject({ name: '早报', payload: '汇总昨天', cron: '0 8 * * *', runAt: null, allowSilent: 0 });
    h.close();
  });

  /**
   * **总开关关着时建不了但改得了**（docs/09 §3.10.1），这个不对称是有意的：拒掉编辑的代价是
   * 要修一条跑飞的任务，运维必须先把总开关打开 —— 那一下会把**所有**任务一起重新武装。
   * 而改一条根本不会触发的任务本身没有副作用（`fire()` 那一侧照旧 skip，那半边焊在
   * `tests/schedule.test.ts`）。
   */
  it('总开关关着时 PATCH 放行且真的落库，POST 仍回 schedule_disabled', async () => {
    const h = harness('sched-api-disabled', { schedule: { enabled: false } });
    // 总开关是运维事后关的，所以库里先有一条 —— 走 POST 建不出来。
    h.jobs.create({ id: 'j1', key: 'chat:c1', chatId: 'c1', threadId: null, createdBy: '1', name: '早报', mode: 'agent', cron: '0 8 * * *', runAt: null, timezone: 'UTC', payload: '汇总' });
    const updated = await body<JobRow>(await h.app.request('/api/schedules/j1', { method: 'PATCH', headers: h.headers,
      body: JSON.stringify({ text: '改成这句', cron: '0 20 * * *' }) }));
    expect(updated).toMatchObject({ id: 'j1', payload: '改成这句', cron: '0 20 * * *' });
    // 库里真的变了，不是只把回包拼漂亮。
    expect(h.jobs.byId('j1')).toMatchObject({ payload: '改成这句', cron: '0 20 * * *', state: 'active' });
    expect(await error(await h.app.request('/api/schedules', { method: 'POST', headers: h.headers,
      body: JSON.stringify({ key: 'chat:c1', name: '晚报', mode: 'notify', text: '晚', cron: '0 21 * * *' }) }))).toBe('schedule_disabled');
    expect(h.jobs.byName('chat:c1', '晚报')).toBeNull();
    // 面板照旧知道总开关是关的（横幅据此出）—— 别把「改得动」读成「它现在会响了」。
    expect(await body<ListBody>(await h.app.request('/api/schedules', { headers: h.headers }))).toMatchObject({ enabled: false });
    h.close();
  });

  /**
   * `key`/`chatId`/`threadId`/`createdBy` 是会话隔离与「触发时按谁重算角色」的锚点，`mode` 会
   * 同时翻转 payload 的语义与花不花钱。收下任何一个都等于凭一个字段把任务搬进别的群 / 换个人担保。
   */
  it('改任务不收落点、创建者与模式，只发这些时也不是假成功', async () => {
    const h = harness('sched-api-patch-anchors');
    const created = await body<JobRow>(await h.app.request('/api/schedules', { method: 'POST', headers: h.headers,
      body: JSON.stringify({ key: 'chat:c1', name: '早报', mode: 'agent', text: '汇总', cron: '0 8 * * *' }) }));
    const patch = async (payload: Record<string, unknown>): Promise<Response> =>
      h.app.request(`/api/schedules/${created.id}`, { method: 'PATCH', headers: h.headers, body: JSON.stringify(payload) });
    expect(await error(await patch({ key: 'chat:c2', chatId: '-100200', threadId: 7, createdBy: '999', mode: 'notify' }))).toBe('nothing_to_update');
    expect((await patch({ key: 'chat:c2', chatId: '-100200', threadId: 7, createdBy: '999', mode: 'notify', text: '新正文' })).status).toBe(200);
    expect(h.jobs.byId(created.id)).toMatchObject({ key: 'chat:c1', chatId: 'c1', threadId: null, createdBy: '1', mode: 'agent', payload: '新正文' });
    h.close();
  });

  it('改成功后重排调度器并留一条 schedule.updated；已结束的改不了', async () => {
    const h = harness('sched-api-patch-ok');
    const created = await body<JobRow>(await h.app.request('/api/schedules', { method: 'POST', headers: h.headers,
      body: JSON.stringify({ key: 'chat:c1', name: '早报', mode: 'agent', text: '汇总', cron: '0 8 * * *' }) }));
    const updated = await body<JobRow>(await h.app.request(`/api/schedules/${created.id}`, { method: 'PATCH', headers: h.headers,
      body: JSON.stringify({ name: '早间简报', text: '汇总昨天', cron: '0 9 * * *', silent: true }) }));
    // 对外线上一律叫 `silent`（DB 列 `allow_silent`）—— 三个名字里只有这一个该出现在响应里。
    expect(updated).toMatchObject({ id: created.id, name: '早间简报', payload: '汇总昨天', cron: '0 9 * * *', silent: true, silentStreak: 0 });
    // 改完必须**重排一次**：漏掉的话在 WebUI 上把 cron 从早八点改成早九点，调度器上排着的还是八点。
    // 「改完还在 registered 里」是恒真的（建的时候就 add 过），要看的是这个计数。
    expect(h.registerCalls.filter((id) => id === created.id)).toHaveLength(2);
    const logged = h.db.prepare("SELECT data_json AS data FROM log_events WHERE kind='schedule.updated' ORDER BY id DESC LIMIT 1").get() as { data: string };
    const payload = JSON.parse(logged.data) as { actor: string; name: string; changed: string[] };
    expect(payload).toMatchObject({ actor: 'webui', job: created.id, name: '早间简报' });
    expect([...payload.changed].sort()).toEqual(['cron', 'name', 'silent', 'text']);
    // 停掉之后是状态冲突（409），不是「你发的东西不合法」—— 界面据此说「这条已经结束了，重建一个」。
    h.jobs.finish(created.id, 'cancelled');
    const gone = await h.app.request(`/api/schedules/${created.id}`, { method: 'PATCH', headers: h.headers, body: JSON.stringify({ text: '再改一次' }) });
    expect(gone.status).toBe(409);
    expect(await error(gone)).toBe('not_active');
    // 而且「这条没了」要抢在几道校验闸之前说出来：不然在另一个标签页里停掉的任务，这边点保存
    // 收到的是 `interval_too_short`，运维会去改 cron 而不是重建。
    const stale = await h.app.request(`/api/schedules/${created.id}`, { method: 'PATCH', headers: h.headers, body: JSON.stringify({ cron: '* * * * *' }) });
    expect(stale.status).toBe(409);
    expect(await error(stale)).toBe('not_active');
    expect((await h.app.request('/api/schedules/nope', { method: 'PATCH', headers: h.headers, body: '{}' })).status).toBe(404);
    h.close();
  });

  /**
   * `[永久删除]` 与 `[停掉]` 是两件事：停掉的行还在（还能看见它跑过多少次），删掉的什么都不剩。
   * 顺序也焊在这里 —— 反过来的话，删行到下一次 cron 之间那条任务在 `Scheduler` 里还排着，
   * 而界面上已经看不见它了。
   */
  it('永久删除是硬删，与停掉的软取消分得开，且先摘 cron 再删行', async () => {
    const h = harness('sched-api-purge');
    const make = async (name: string): Promise<JobRow> => body<JobRow>(await h.app.request('/api/schedules', { method: 'POST', headers: h.headers,
      body: JSON.stringify({ key: 'chat:c1', name, mode: 'notify', text: '正文', cron: '0 8 * * *' }) }));
    const stopped = await make('早报');
    const alive = await make('周报');
    expect(await body(await h.app.request(`/api/schedules/${stopped.id}`, { method: 'DELETE', headers: h.headers }))).toEqual({ cancelled: true, name: '早报' });
    expect(h.jobs.byId(stopped.id)!.state).toBe('cancelled');
    // 摘 cron 那一刻行必须还在：`unregister` 排在 `remove` 之前，这一位就是那个顺序。
    const rowPresentAtUnregister: boolean[] = [];
    const original = h.runner.unregister;
    h.runner.unregister = (id: string) => { rowPresentAtUnregister.push(h.jobs.byId(id) !== null); return original(id); };
    expect(await body(await h.app.request(`/api/schedules/${alive.id}/purge`, { method: 'POST', headers: h.headers }))).toEqual({ removed: true, name: '周报', wasActive: true });
    expect(rowPresentAtUnregister).toEqual([true]);
    expect(h.jobs.byId(alive.id)).toBeNull();
    expect(h.registered.has(alive.id)).toBe(false);
    // 已经停掉的行同样删得掉，只是没有 cron 要摘。
    expect(await body(await h.app.request(`/api/schedules/${stopped.id}/purge`, { method: 'POST', headers: h.headers }))).toEqual({ removed: true, name: '早报', wasActive: false });
    expect(h.jobs.listAll()).toEqual([]);
    // 硬删一条 active 任务之后「bot 突然不再提醒了」在库里再无痕迹，这两行 warn 就是那个痕迹。
    const events = h.db.prepare("SELECT level,data_json AS data FROM log_events WHERE kind='schedule.purged' ORDER BY id").all() as Array<{ level: string; data: string }>;
    expect(events.map((row) => row.level)).toEqual(['warn', 'warn']);
    expect(JSON.parse(events[0]!.data)).toMatchObject({ job: alive.id, name: '周报', state: 'active', wasActive: true, actor: 'webui' });
    expect(JSON.parse(events[1]!.data)).toMatchObject({ state: 'cancelled', wasActive: false });
    expect((await h.app.request('/api/schedules/nope/purge', { method: 'POST', headers: h.headers })).status).toBe(404);
    h.close();
  });

  /**
   * 静默开关与连续静默次数要在面板上看得见：`silent_streak` 是唯一能发现「这条任务已经变成
   * 一台只烧钱不说话的定时器」的凭据（docs/02 §10.5）。信封上的 `total`/`truncated` 管另一件事 ——
   * `listAll` 有 500 条上限，撞上去不许静默截断。
   */
  it('列表带回 silent / silentStreak，撞 listAll 上限时说出来', async () => {
    const h = harness('sched-api-silent');
    const created = await body<JobRow>(await h.app.request('/api/schedules', { method: 'POST', headers: h.headers,
      body: JSON.stringify({ key: 'chat:c1', name: '查更新', mode: 'agent', text: '看看有没有新版本', cron: '0 12 * * *', silent: true }) }));
    // notify 到点原样发出预写正文、不调模型，`stay_silent` 在那条路上没人调用 —— 存得下但运行时
    // 不读的开关比没有更糟（docs/20 · W-CFG-02）。
    expect(await error(await h.app.request('/api/schedules', { method: 'POST', headers: h.headers,
      body: JSON.stringify({ key: 'chat:c1', name: '播报', mode: 'notify', text: '正文', cron: '0 8 * * *', silent: true }) }))).toBe('invalid_silent');
    h.jobs.markRun(created.id, { state: 'silent' });
    h.jobs.markRun(created.id, { state: 'silent' });
    const list = await body<ListBody>(await h.app.request('/api/schedules', { headers: h.headers }));
    expect(list).toMatchObject({ total: 1, truncated: false });
    expect(list.jobs[0]).toMatchObject({ silent: true, silentStreak: 2, lastState: 'silent' });
    // 撞上限：界面要能说「还有 N 条」，而不是显示一份看不出来是截断过的列表。
    const bulk = h.db.transaction((count: number) => {
      for (let index = 0; index < count; index += 1) {
        h.jobs.create({ id: `bulk-${index}`, key: 'chat:c1', chatId: 'c1', threadId: null, createdBy: '1', name: `批量 ${index}`, mode: 'notify', cron: '0 8 * * *', runAt: null, timezone: 'UTC', payload: '正文' });
      }
    });
    bulk(500);
    const full = await body<ListBody>(await h.app.request('/api/schedules', { headers: h.headers }));
    expect(full.jobs).toHaveLength(500);
    expect(full).toMatchObject({ total: 501, truncated: true });
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

  /**
   * `docs/28 · L-SCH-01`：HTTP 从 `serve()` 起就在监听，而 runner 的 `load()` 要等 bot 起来。
   * 这中间手动触发会开一整轮、跑完模型、记完账（实测 $0.30），最后以
   * `delivery_failed:telegram_unavailable` 收尾且**不提交** —— 钱花了、上下文没留下。
   */
  it('runner 还没 load() 时手动触发回 400 并说明理由，而不是白跑一整轮', async () => {
    const h = harness('sched-api-not-loaded');
    const created = await body<JobRow>(await h.app.request('/api/schedules', { method: 'POST', headers: h.headers,
      body: JSON.stringify({ key: 'chat:c1', name: '早报', mode: 'agent', text: '汇总', cron: '0 8 * * *' }) }));
    h.runner.loaded = false;
    const response = await h.app.request(`/api/schedules/${created.id}/trigger`, { method: 'POST', headers: h.headers });
    expect(response.status).toBe(400);
    expect(await error(response)).toBe('not_ready');
    expect(h.fired).toHaveLength(0);
    h.close();
  });

  it('没装配运行时就说没装配，而不是显示零条任务', async () => {
    const h = harness('sched-api-absent', {}, false);
    const list = await body<ListBody>(await h.app.request('/api/schedules', { headers: h.headers }));
    // `available:false` 与「真的一条都没有」在运维眼里是两回事（docs/16 §5「摘除比伪造安全」）。
    expect(list).toMatchObject({ available: false, jobs: [], total: 0, truncated: false });
    for (const [path, method] of [['/api/schedules', 'POST'], ['/api/schedules/x', 'PATCH'], ['/api/schedules/x', 'DELETE'], ['/api/schedules/x/purge', 'POST'], ['/api/schedules/x/trigger', 'POST']] as const) {
      const response = await h.app.request(path, { method, headers: h.headers, ...(method === 'DELETE' ? {} : { body: '{}' }) });
      expect(response.status, `${method} ${path}`).toBe(500);
      expect(await error(response), `${method} ${path}`).toBe('not_implemented');
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
    // 逐个列出来而不是只测 POST：改 / 硬删是这一批新加的写动词，漏一个就是一条无 CSRF 的删除通道。
    for (const [path, method] of [['/api/schedules', 'POST'], ['/api/schedules/x', 'PATCH'], ['/api/schedules/x', 'DELETE'], ['/api/schedules/x/purge', 'POST'], ['/api/schedules/x/trigger', 'POST']] as const) {
      const response = await h.app.request(path, { method, headers: noCsrf, ...(method === 'DELETE' ? {} : { body: '{}' }) });
      expect(response.status, `${method} ${path}`).toBe(403);
    }
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
