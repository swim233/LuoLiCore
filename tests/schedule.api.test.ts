import { mkdirSync, rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ArchiveRepository, OperationsRepository, PrincipalRepository, ScheduleRepository, closeDatabase, migrateDatabase, openDatabase, type ScheduledJob } from '@luoli/db';
import { ContextEngine, DatabaseApprovalBroker, EventBus, LogSink, MaintenanceService, ProviderStore, Secrets, configSchema } from '@luoli/core';
import { createServer } from '@luoli/server';
import { lastLogPayload, logRows } from './support/logs.js';
import { code, source } from './support/source.js';

/**
 * 定时任务的 WebUI 面板（docs/21 · `G-API-16`）。此前运维在界面上既看不到部署里有哪些任务在排、
 * 也停不掉任何一条，止损只能去 Telegram 让 bot 执行 `schedule_cancel`。
 *
 * 覆盖四项判据：跨会话可见、建任务与工具共用同一套校验、停用与手动触发不返回假成功，
 * 以及运行时未装配时如实返回未装配而非零条任务。
 */
function harness(name: string, extra: Record<string, unknown> = {}, wired = true) {
  const path = `./data/${name}.test.db`;
  for (const suffix of ['', '-wal', '-shm', '-logs', '-logs-wal', '-logs-shm']) rmSync(`${path}${suffix}`, { force: true });
  const logDir = `./data/${name}-logs`; rmSync(logDir, { recursive: true, force: true }); mkdirSync(logDir, { recursive: true });
  const db = openDatabase(path); migrateDatabase(db);
  const config = configSchema.parse({ access: { bootstrapOwnerId: '1' }, general: { timezone: 'UTC' },
    webui: { passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$x$x' }, logs: { dir: logDir }, ...extra });
  const operations = new OperationsRepository(db);
  const events = new EventBus();
  const log = new LogSink(operations, [], { console: 'off' });
  const archive = new ArchiveRepository(db);
  const principals = new PrincipalRepository(db);
  const jobs = new ScheduleRepository(db);
  const registered = new Set<string>();
  // 创建时已 add 过一次，「改完仍在集合里」是恒真断言；此处要断言的是重新排期确实发生。
  const registerCalls: string[] = [];
  const fired: string[] = [];
  const runner = {
    // `loaded` 表示 `load()` 已执行、投递通道已具备。手动触发端点用它挡住启动窗口：HTTP 自
    // `serve()` 起即在监听，此时触发会开出一条无法投递的轮次（docs/28 · L-SCH-01）。
    loaded: true,
    register: (job: ScheduledJob) => { registered.add(job.id); registerCalls.push(job.id); return true; },
    unregister: (id: string) => registered.delete(id),
    nextRun: (id: string) => (registered.has(id) ? new Date(1_900_000_000_000) : null),
    fire: (id: string) => { fired.push(id); return Promise.resolve(); },
  };
  // 两个会话：面板需跨会话可见，工具侧只能看到自身所属的那一个。
  for (const [key, chatId] of [['chat:c1', 'c1'], ['chat:c2', '-100200']] as const) {
    db.prepare("INSERT INTO contexts(key,chat_id,thread_id,scope,claim_watermark,created_at,updated_at) VALUES (?,?,NULL,'chat',0,?,?)").run(key, chatId, Date.now(), Date.now());
  }
  principals.upsertSeen({ id: 'user:1', kind: 'user', tgId: '1', role: 'owner', displayName: '阿离', username: 'ali', chatType: null });
  principals.upsertSeen({ id: 'chat:-100200', kind: 'chat', tgId: '-100200', role: 'trusted', displayName: '开发组', username: null, chatType: 'supergroup' });
  const app = createServer({ config, db, operations, principals, archive, context: new ContextEngine(db, archive),
    providers: new ProviderStore(db, new Secrets('x'.repeat(32))), approvals: new DatabaseApprovalBroker(db, config, events, log),
    maintenance: new MaintenanceService(db, path, 2, 30), events, log,
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
    // 投递落点由 contexts 反查得出：不存在的会话建不出任务，客户端也无法自带 chatId 绕过该步。
    expect(await error(await h.app.request('/api/schedules', { method: 'POST', headers: h.headers, body: JSON.stringify({ key: 'chat:nope', name: 'a', mode: 'notify', text: 'x', cron: '0 8 * * *' }) }))).toBe('chat_not_found');
    expect(h.jobs.listAll()).toEqual([]);
    // maxPerChat=1：第二条被拒，且重名与上限的判定与工具侧同源。
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
    // 改时间使用行上记录的时区（`updateScheduledJob` 不接收 timezone 参数）。取错时区的表现是
    // 触发时间被静默平移数小时，且两次操作各自都不报错。
    const moved = await body<JobRow>(await h.app.request(`/api/schedules/${created.id}`, { method: 'PATCH', headers: h.headers, body: JSON.stringify({ at: '2030-06-01T16:30' }) }));
    expect(moved.at).toBe('2030-06-01T08:30:00.000Z');
    expect(h.jobs.byId(created.id)).toMatchObject({ cron: null, runAt: Date.parse('2030-06-01T08:30:00Z') });
    h.close();
  });

  /**
   * 改任务与 `schedule_update` 工具共用 `updateScheduledJob`，即建与改的校验只有一份（CLAUDE.md）。
   * 这一组逐条错误码即该结论的凭据，断言形状照建任务那条写，任一侧缺一条都会暴露。
   */
  it('改任务与工具共用同一套校验，一条都不落库', async () => {
    const h = harness('sched-api-patch', { schedule: { minIntervalMinutes: 5, maxPayloadChars: 20 } });
    const created = await body<JobRow>(await h.app.request('/api/schedules', { method: 'POST', headers: h.headers,
      body: JSON.stringify({ key: 'chat:c1', name: '早报', mode: 'agent', text: '汇总昨天', cron: '0 8 * * *' }) }));
    await h.app.request('/api/schedules', { method: 'POST', headers: h.headers, body: JSON.stringify({ key: 'chat:c1', name: '周报', mode: 'agent', text: '汇总上周', cron: '0 9 * * 1' }) });
    const patch = async (payload: Record<string, unknown>): Promise<Response> =>
      h.app.request(`/api/schedules/${created.id}`, { method: 'PATCH', headers: h.headers, body: JSON.stringify(payload) });
    // 未提供任何字段时不返回假成功：调用方（通常是模型）会认为修改已生效，而库中并无变更。
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
    // 改成自身当前名称不算重名（`gateDuplicate` 排除自身）。
    expect((await patch({ name: '早报' })).status).toBe(200);
    expect(h.jobs.byId(created.id)).toMatchObject({ name: '早报', payload: '汇总昨天', cron: '0 8 * * *', runAt: null, allowSilent: 0 });
    h.close();
  });

  /**
   * 总开关关闭时不能新建但可以修改（docs/09 §3.10.1）。该不对称是有意的：若拒绝编辑，运维要修正
   * 一条异常任务就必须先打开总开关，而那一步会把全部任务一起重新武装。修改一条不会触发的任务
   * 本身没有副作用（`fire()` 一侧照旧 skip，该半边由 `tests/schedule.test.ts` 覆盖）。
   */
  it('总开关关着时 PATCH 放行且真的落库，POST 仍回 schedule_disabled', async () => {
    const h = harness('sched-api-disabled', { schedule: { enabled: false } });
    // 总开关由运维事后关闭，因此库中先存在一条；此时走 POST 建不出来。
    h.jobs.create({ id: 'j1', key: 'chat:c1', chatId: 'c1', threadId: null, createdBy: '1', name: '早报', mode: 'agent', cron: '0 8 * * *', runAt: null, timezone: 'UTC', payload: '汇总' });
    const updated = await body<JobRow>(await h.app.request('/api/schedules/j1', { method: 'PATCH', headers: h.headers,
      body: JSON.stringify({ text: '改成这句', cron: '0 20 * * *' }) }));
    expect(updated).toMatchObject({ id: 'j1', payload: '改成这句', cron: '0 20 * * *' });
    // 库中确实发生了变更，而非只把回包字段拼装正确。
    expect(h.jobs.byId('j1')).toMatchObject({ payload: '改成这句', cron: '0 20 * * *', state: 'active' });
    expect(await error(await h.app.request('/api/schedules', { method: 'POST', headers: h.headers,
      body: JSON.stringify({ key: 'chat:c1', name: '晚报', mode: 'notify', text: '晚', cron: '0 21 * * *' }) }))).toBe('schedule_disabled');
    expect(h.jobs.byName('chat:c1', '晚报')).toBeNull();
    // 面板仍需知道总开关处于关闭状态（横幅据此渲染）：可修改不等于任务已恢复触发。
    expect(await body<ListBody>(await h.app.request('/api/schedules', { headers: h.headers }))).toMatchObject({ enabled: false });
    h.close();
  });

  /**
   * `key`/`chatId`/`threadId`/`createdBy` 是会话隔离与触发时重算有效角色的锚点，`mode` 同时决定
   * payload 语义与是否产生费用。接受其中任何一个，都等于凭单个字段把任务迁到别的群或换一个担保人。
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
    // 对外一律使用 `silent`（DB 列为 `allow_silent`）：三个名称中只有它可以出现在响应里。
    expect(updated).toMatchObject({ id: created.id, name: '早间简报', payload: '汇总昨天', cron: '0 9 * * *', silent: true, silentStreak: 0 });
    // 修改后必须重新排期：遗漏时在 WebUI 把 cron 从 08:00 改成 09:00，调度器上排的仍是 08:00。
    // 改完仍在 registered 中是恒真的（创建时已 add），此处要断言的是重排次数。
    expect(h.registerCalls.filter((id) => id === created.id)).toHaveLength(2);
    const logged = { data: lastLogPayload(h.db, 'schedule.updated') };
    const payload = JSON.parse(logged.data) as { actor: string; name: string; changed: string[] };
    expect(payload).toMatchObject({ actor: 'webui', job: created.id, name: '早间简报' });
    expect([...payload.changed].sort()).toEqual(['cron', 'name', 'silent', 'text']);
    // 停用后返回状态冲突（409）而非参数非法，界面据此提示任务已结束、需重新创建。
    h.jobs.finish(created.id, 'cancelled');
    const gone = await h.app.request(`/api/schedules/${created.id}`, { method: 'PATCH', headers: h.headers, body: JSON.stringify({ text: '再改一次' }) });
    expect(gone.status).toBe(409);
    expect(await error(gone)).toBe('not_active');
    // 且任务已不存在必须先于各道校验闸返回：否则在另一标签页停用的任务，此处保存收到的是
    // `interval_too_short`，运维会去改 cron 而不是重建。
    const stale = await h.app.request(`/api/schedules/${created.id}`, { method: 'PATCH', headers: h.headers, body: JSON.stringify({ cron: '* * * * *' }) });
    expect(stale.status).toBe(409);
    expect(await error(stale)).toBe('not_active');
    expect((await h.app.request('/api/schedules/nope', { method: 'PATCH', headers: h.headers, body: '{}' })).status).toBe(404);
    h.close();
  });

  /**
   * `[永久删除]` 与 `[停掉]` 是两个动词：停用后行仍在（可查触发次数），永久删除不留任何记录。
   * 执行顺序同样由此约束：顺序颠倒时，删行到下一次 cron 之间任务在 `Scheduler` 里仍排着，
   * 而界面上已不可见。
   */
  it('永久删除是硬删，与停掉的软取消分得开，且先摘 cron 再删行', async () => {
    const h = harness('sched-api-purge');
    const make = async (name: string): Promise<JobRow> => body<JobRow>(await h.app.request('/api/schedules', { method: 'POST', headers: h.headers,
      body: JSON.stringify({ key: 'chat:c1', name, mode: 'notify', text: '正文', cron: '0 8 * * *' }) }));
    const stopped = await make('早报');
    const alive = await make('周报');
    expect(await body(await h.app.request(`/api/schedules/${stopped.id}`, { method: 'DELETE', headers: h.headers }))).toEqual({ cancelled: true, name: '早报' });
    expect(h.jobs.byId(stopped.id)!.state).toBe('cancelled');
    // 摘除 cron 时行必须仍在：`unregister` 先于 `remove`，该位即固定这一顺序。
    const rowPresentAtUnregister: boolean[] = [];
    const original = h.runner.unregister;
    h.runner.unregister = (id: string) => { rowPresentAtUnregister.push(h.jobs.byId(id) !== null); return original(id); };
    expect(await body(await h.app.request(`/api/schedules/${alive.id}/purge`, { method: 'POST', headers: h.headers }))).toEqual({ removed: true, name: '周报', wasActive: true });
    expect(rowPresentAtUnregister).toEqual([true]);
    expect(h.jobs.byId(alive.id)).toBeNull();
    expect(h.registered.has(alive.id)).toBe(false);
    // 已停用的行同样可删除，只是没有 cron 需要摘除。
    expect(await body(await h.app.request(`/api/schedules/${stopped.id}/purge`, { method: 'POST', headers: h.headers }))).toEqual({ removed: true, name: '早报', wasActive: false });
    expect(h.jobs.listAll()).toEqual([]);
    // 硬删一条 active 任务后，bot 停止提醒在库中不留痕迹，这两条 warn 是唯一凭据。
    const events = logRows(h.db, 'schedule.purged');
    expect(events.map((row) => row.level)).toEqual(['warn', 'warn']);
    expect(JSON.parse(events[0]!.data!)).toMatchObject({ job: alive.id, name: '周报', state: 'active', wasActive: true, actor: 'webui' });
    expect(JSON.parse(events[1]!.data!)).toMatchObject({ state: 'cancelled', wasActive: false });
    expect((await h.app.request('/api/schedules/nope/purge', { method: 'POST', headers: h.headers })).status).toBe(404);
    h.close();
  });

  /**
   * 静默开关与连续静默次数必须在面板上可见：`silent_streak` 是发现任务持续消耗配额却从不投递的
   * 唯一凭据（docs/02 §10.5）。信封上的 `total`/`truncated` 管另一件事：`listAll` 有 500 条上限，
   * 触顶时不得静默截断。
   */
  it('列表带回 silent / silentStreak，撞 listAll 上限时说出来', async () => {
    const h = harness('sched-api-silent');
    const created = await body<JobRow>(await h.app.request('/api/schedules', { method: 'POST', headers: h.headers,
      body: JSON.stringify({ key: 'chat:c1', name: '查更新', mode: 'agent', text: '看看有没有新版本', cron: '0 12 * * *', silent: true }) }));
    // notify 到点原样发出预写正文、不调用模型，该路径上没有 `stay_silent` 的调用方：可写入但运行时
    // 不读取的开关比不提供更糟（docs/20 · W-CFG-02）。
    expect(await error(await h.app.request('/api/schedules', { method: 'POST', headers: h.headers,
      body: JSON.stringify({ key: 'chat:c1', name: '播报', mode: 'notify', text: '正文', cron: '0 8 * * *', silent: true }) }))).toBe('invalid_silent');
    h.jobs.markRun(created.id, { state: 'silent' });
    h.jobs.markRun(created.id, { state: 'silent' });
    const list = await body<ListBody>(await h.app.request('/api/schedules', { headers: h.headers }));
    expect(list).toMatchObject({ total: 1, truncated: false });
    expect(list.jobs[0]).toMatchObject({ silent: true, silentStreak: 2, lastState: 'silent' });
    // 触顶：界面需要能给出剩余条数，而不是展示一份无法判断是否被截断的列表。
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
    // 调度器中也已摘除：只改库不摘 cron 的结果是界面显示已停用、到点仍会触发。
    expect(h.registered.has(created.id)).toBe(false);
    // 重复停用不返回假成功。
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
    // 手动触发要落一条 schedule.fired（带 manual:true），否则无法追溯触发人与触发时刻。
    const logged = { data: lastLogPayload(h.db, 'schedule.fired') };
    expect(JSON.parse(logged.data)).toMatchObject({ actor: 'webui', manual: true });
    h.jobs.finish(created.id, 'cancelled');
    expect((await h.app.request(`/api/schedules/${created.id}/trigger`, { method: 'POST', headers: h.headers })).status).toBe(409);
    expect((await h.app.request('/api/schedules/nope/trigger', { method: 'POST', headers: h.headers })).status).toBe(404);
    expect(h.fired).toHaveLength(1);
    h.close();
  });

  /**
   * `docs/28 · L-SCH-01`：HTTP 自 `serve()` 起即在监听，而 runner 的 `load()` 需等 bot 启动完成。
   * 该窗口内手动触发会开出完整轮次、调用模型并计费（实测 $0.30），最终以
   * `delivery_failed:telegram_unavailable` 收尾且不提交：产生了费用，却没有留下上下文。
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
    // `available:false` 与确实一条都没有对运维是两种结论（docs/16 §5：摘除比伪造安全）。
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
    // 逐条列出而非只测 POST：改与硬删是本批新增的写动词，漏一条即留下一条无 CSRF 保护的删除通道。
    for (const [path, method] of [['/api/schedules', 'POST'], ['/api/schedules/x', 'PATCH'], ['/api/schedules/x', 'DELETE'], ['/api/schedules/x/purge', 'POST'], ['/api/schedules/x/trigger', 'POST']] as const) {
      const response = await h.app.request(path, { method, headers: noCsrf, ...(method === 'DELETE' ? {} : { body: '{}' }) });
      expect(response.status, `${method} ${path}`).toBe(403);
    }
    h.close();
  });
});

describe('装配', () => {
  it('main.ts 把定时任务运行时交给了 createServer', () => {
    // 依赖为可选（与 `ledger?` / `restart?` 同一写法），漏传不会产生编译错误，表现为面板持续提示
    // 运行时未装配。该断言即漏传的守卫。createServer 调用挪进了 composeRuntime（apps/bot/src/compose.ts）。
    const compose = source('apps/bot/src/compose.ts');
    expect(compose).toMatch(/schedules:\s*\{\s*jobs:\s*scheduledJobs,\s*runner:\s*scheduleRunner\s*\}/);
    // 装载须在 bot 构建完成之后：早于它时，第一批任务触发时 telegram() 仍为 null。这一步仍在 main.ts。
    const main = source('apps/bot/src/main.ts');
    expect(main).toContain(code('scheduleRunner.load()'));
  });
});
