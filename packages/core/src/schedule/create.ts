import { Cron } from 'croner';
import { ulid } from 'ulid';
import type { ScheduleRepository, ScheduledJob, ScheduledJobPatch } from '@luoli/db';
import type { Config } from '../config/schema.js';

/**
 * 建一个定时任务时要过的那几道闸。
 *
 * **工具（`schedule_create`）与 WebUI（`POST /api/schedules`）共用这一份。** 两边各写一遍校验
 * 正是这个仓库反复踩的形态（docs/26 §1「同一道闸修过一次但漏了另一侧」）—— 差一条的后果是
 * WebUI 能建出工具建不出来的任务，比如每分钟一次的 agent 轮次。
 */
export interface ScheduleCreateRequest {
  name: string;
  mode: 'agent' | 'notify';
  text: string;
  /** 与 `at` 二者其一。`exactOptionalPropertyTypes` 下要显式收 undefined：zod 的可选字段
   *  解析出来就是 `string | undefined`，调用方不该为了过类型去做一次条件展开。 */
  cron?: string | undefined;
  at?: string | undefined;
  /** 允许这条任务的轮次调 `stay_silent`（DB 列 `allow_silent`，对外线上一律叫 `silent`）。 */
  silent?: boolean | undefined;
}

/**
 * 改一条任务。**不收 `mode`**：换 mode 会同时翻转 `payload` 的语义（任务描述 ↔ 要发出的原文）
 * 与花不花钱，落在同一个字段上的两件事没法只改一件。也不收 `key`/`chatId`/`createdBy` ——
 * 落点是隔离锚点，创建者是每次触发重算有效角色的依据，做成可写就是一个提权把手。
 */
export interface ScheduleUpdateRequest {
  name?: string | undefined;
  text?: string | undefined;
  cron?: string | undefined;
  at?: string | undefined;
  silent?: boolean | undefined;
}

export interface ScheduleCreateContext {
  key: string;
  chatId: string;
  threadId: number | null;
  createdBy: string;
  timezone: string;
  settings: Config['schedule'];
}

/** 只做「排得进去」这件事的注册器；`ScheduledJobRunner` 满足它。 */
export interface ScheduleRegistrar {
  register(job: ScheduledJob): boolean;
  nextRun(id: string): Date | null;
}

export type ScheduleCreateResult =
  | { ok: true; job: ScheduledJob; nextRun: Date | null }
  | { ok: false; error: string; hint: string };

/**
 * `at` 是「用户所在时区的墙上时间」，不是 UTC。`new Date('2026-08-18T15:00:00')` 按**宿主**
 * 时区解析，宿主是 UTC 的部署里「下午三点」会变成晚上十一点。所以自己按给定时区折算：
 * 先当成 UTC 读进来，再用那个时区在该时刻的偏移量补回去。
 */
export function parseLocalTime(value: string, timezone: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!match) { const direct = Date.parse(value); return Number.isNaN(direct) ? null : direct; }
  const [, y, mo, d, h, mi, s] = match;
  const asUtc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0));
  // 偏移量本身依赖时刻（夏令时），所以用「先按 UTC 猜一次、再用猜出来的时刻查偏移」收敛一步。
  const offset = (probe: number): number => {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(probe)).reduce<Record<string, string>>((accumulator, part) => { accumulator[part.type] = part.value; return accumulator; }, {});
    const wall = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));
    return wall - probe;
  };
  return asUtc - offset(asUtc - offset(asUtc));
}

/** cron 两次触发之间的间隔（毫秒）。表达式非法时抛，由调用方翻成 `{ok:false}`。 */
export function cronIntervalMs(expression: string, timezone: string): number {
  const upcoming = new Cron(expression, { timezone }).nextRuns(2);
  if (upcoming.length < 2) return Number.POSITIVE_INFINITY;
  return upcoming[1]!.getTime() - upcoming[0]!.getTime();
}

/**
 * 每道闸各自一个函数，**除 `gateEnabled` 外建与改共用**。提出来不是为了好看：`updateScheduledJob` 要能只跑其中
 * 几道（改一句正文时不该重算触发间隔），而在那边照抄一遍正是这个仓库反复踩的形态
 * （docs/26 §1）。`createScheduledJob` 的顺序与文案因此一个字都没动 —— 那两串逐条错误码断言
 * 就是这次重构的回归防线。
 */
type Rejection = { ok: false; error: string; hint: string };

/** **只有 `createScheduledJob` 过这一道**，改不过 —— 理由写在 `updateScheduledJob` 的注释里。 */
const gateEnabled = (settings: Config['schedule']): Rejection | null =>
  settings.enabled ? null : { ok: false, error: 'schedule_disabled', hint: '定时任务被运维关掉了（schedule.enabled）' };

/** 收的是**已经 trim 过**的名字：调用方还要拿它去查重名与落库，trim 两遍就是两份判据。 */
const gateName = (name: string): Rejection | null =>
  name && name.length <= 64 ? null : { ok: false, error: 'invalid_name', hint: '任务名要有内容且不超过 64 个字符' };

const gateText = (text: string, mode: 'agent' | 'notify', settings: Config['schedule']): Rejection | null => {
  if (!text) return { ok: false, error: 'invalid_text', hint: mode === 'agent' ? '要给一句任务描述' : '要给一段要发出的正文' };
  if (text.length > settings.maxPayloadChars) return { ok: false, error: 'text_too_long', hint: `正文最多 ${settings.maxPayloadChars} 字（schedule.maxPayloadChars）` };
  return null;
};

/**
 * `notify` 不调模型，`stay_silent` 在那条路上根本没人调用 —— 存得下但运行时不读的开关比没有
 * 更糟（docs/20 · W-CFG-02：运维照着它调完发现什么都没变）。
 */
const gateSilent = (silent: boolean | undefined, mode: 'agent' | 'notify'): Rejection | null =>
  silent && mode === 'notify' ? { ok: false, error: 'invalid_silent', hint: 'notify 模式到点原样发出预写正文，不调模型，没有「本轮不用汇报」这回事' } : null;

const gateCron = (expression: string, timezone: string, settings: Config['schedule']): Rejection | null => {
  let interval: number;
  try { interval = cronIntervalMs(expression, timezone); }
  catch (error) { return { ok: false, error: 'invalid_cron', hint: `cron 表达式不合法：${error instanceof Error ? error.message : String(error)}` }; }
  if (interval < settings.minIntervalMinutes * 60_000) {
    return { ok: false, error: 'interval_too_short', hint: `两次触发间隔不能小于 ${settings.minIntervalMinutes} 分钟（schedule.minIntervalMinutes）` };
  }
  return null;
};

/** 过了就交回那个时刻：让调用方自己再 parse 一次等于第二份判据，而两次之间夏令时的边界还会漂。 */
function gateAt(at: string, timezone: string): number | Rejection {
  const runAt = parseLocalTime(at, timezone);
  if (runAt === null) return { ok: false, error: 'invalid_at', hint: '时间读不出来，用 2026-08-18T15:00 这种写法' };
  if (runAt <= Date.now()) return { ok: false, error: 'at_in_the_past', hint: `${at}（${timezone}）已经过去了；错过的触发点不会补跑` };
  return runAt;
}

/** `excludeId` 给改名用：一条任务改成自己现在的名字不是重名。 */
function gateDuplicate(jobs: ScheduleRepository, key: string, name: string, excludeId?: string): Rejection | null {
  const existing = jobs.byName(key, name);
  if (!existing || existing.id === excludeId) return null;
  return { ok: false, error: 'duplicate_name', hint: `这个会话已经有叫「${name}」的活跃任务了，换个名字或先取消它` };
}

/**
 * `ux_sched_name` 是部分唯一索引，预检与写入之间有窗口（`db/src/schedule.ts` 的 `create` 已立过这条规矩）。
 *
 * **判 `code` 而不是 `String(error)`**：better-sqlite3 的 `SqliteError.message` 是
 * 「UNIQUE constraint failed: scheduled_jobs.key, scheduled_jobs.name」，`toString()` 出来
 * 一个 `SQLITE_CONSTRAINT` 的字样都没有 —— 按文本判这个 catch 恒等于原样重抛，多实例下
 * 撞上那道窗口时 HTTP 侧回的是 500 而不是 `duplicate_name`。
 */
const duplicateOrThrow = (error: unknown, name: string): Rejection => {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code !== 'string' || !code.startsWith('SQLITE_CONSTRAINT')) throw error;
  return { ok: false, error: 'duplicate_name', hint: `这个会话已经有叫「${name}」的活跃任务了，换个名字或先取消它` };
};

export function createScheduledJob(jobs: ScheduleRepository, registrar: ScheduleRegistrar,
  request: ScheduleCreateRequest, context: ScheduleCreateContext): ScheduleCreateResult {
  const live = context.settings;
  const disabled = gateEnabled(live); if (disabled) return disabled;
  const name = request.name.trim();
  const badName = gateName(name); if (badName) return badName;
  const text = request.text.trim();
  const badText = gateText(text, request.mode, live); if (badText) return badText;
  const badSilent = gateSilent(request.silent, request.mode); if (badSilent) return badSilent;
  if ((request.cron === undefined) === (request.at === undefined)) return { ok: false, error: 'invalid_schedule', hint: 'cron 与 at 必须给且只给一个' };
  let runAt: number | null = null;
  if (request.at !== undefined) {
    const parsed = gateAt(request.at, context.timezone);
    if (typeof parsed !== 'number') return parsed;
    runAt = parsed;
  } else {
    const badCron = gateCron(request.cron!, context.timezone, live); if (badCron) return badCron;
  }
  if (jobs.countActive(context.key) >= live.maxPerChat) {
    return { ok: false, error: 'too_many_jobs', hint: `这个会话已经有 ${live.maxPerChat} 个活跃任务（schedule.maxPerChat），先取消不要的` };
  }
  const duplicate = gateDuplicate(jobs, context.key, name); if (duplicate) return duplicate;
  const job = jobs.create({ id: ulid(), key: context.key, chatId: context.chatId, threadId: context.threadId,
    createdBy: context.createdBy, name, mode: request.mode, cron: request.cron ?? null, runAt, timezone: context.timezone,
    payload: text, allowSilent: request.silent === true });
  // 排不进调度器就回滚：留一条永远不会响的 active 行，比建失败难查得多。
  if (!registrar.register(job)) {
    jobs.finish(job.id, 'cancelled', 'failed');
    return { ok: false, error: 'schedule_register_failed', hint: '任务建好了但排不进调度器，已回滚' };
  }
  return { ok: true, job, nextRun: registrar.nextRun(job.id) };
}

/**
 * 改一条活跃任务。**工具（`schedule_update`）与 WebUI（`PATCH /api/schedules/:id`）共用这一份**，
 * 理由同 `createScheduledJob`。
 *
 * **不过 `gateEnabled` —— 这个与 `createScheduledJob` 的不对称是有意的，别当成漏写补回来。**
 * `schedule.enabled=false` 时一条任务根本不会触发（`ScheduledJobRunner.fire` 那一侧照旧 skip），
 * 所以改它没有任何副作用；而拒掉编辑的代价是：要修一条跑飞的任务，运维必须**先把总开关打开**，
 * 那一下会把**所有**任务一起重新武装。建则仍然拒 —— 总开关关着时新建一条不会响的任务，
 * 除了让人以为它排上了之外没有别的作用。
 *
 * 另两处最容易写错的：
 *
 * - **`cron` 与 `at` 都没给时触发时间原样保留，且不重新校验。** 运维事后把 `minIntervalMinutes`
 *   从 5 调到 60，「我只改了一句正文」不该以 `interval_too_short` 失败 —— 那条任务是在旧规则下
 *   合法建出来的，收紧规则的语义是「别再建新的」，不是「存量全部冻结」。
 * - **时区一律取 `job.timezone`**，不是 `general.timezone`。任务的含义锚在创建时那个时区上
 *   （迁移 0007 的注释），拿全局时区解释 `at` 会把一个「早八点」静默挪走几小时，两侧都不报错。
 *
 * `too_many_jobs` 不判：改不增加活跃任务数。
 */
export function updateScheduledJob(jobs: ScheduleRepository, registrar: ScheduleRegistrar, job: ScheduledJob,
  request: ScheduleUpdateRequest, settings: Config['schedule']): ScheduleCreateResult {
  if (request.name === undefined && request.text === undefined && request.cron === undefined
    && request.at === undefined && request.silent === undefined) {
    // 不回假成功：调用方（多半是模型）以为自己改了东西，而库里一个字没动。
    return { ok: false, error: 'nothing_to_update', hint: 'name / text / cron / at / silent 至少给一个' };
  }
  // 「这条已经结束了」要先说出来，不能让下面那几道闸抢答：`PATCH {cron:'* * * * *'}` 打在一条
  // 已取消的任务上此前回的是 `interval_too_short`，而运维要听的是「这条没了，重建一个」。
  // 权威判据仍是 `jobs.update` 的 `WHERE state='active'`（那一句才防得住并发），这里只管口径。
  if (job.state !== 'active') return { ok: false, error: 'not_active', hint: '这条任务已经结束或被取消了，改不了；重新建一个' };
  const patch: ScheduledJobPatch = {};
  if (request.name !== undefined) {
    const name = request.name.trim();
    const badName = gateName(name); if (badName) return badName;
    const duplicate = gateDuplicate(jobs, job.key, name, job.id); if (duplicate) return duplicate;
    patch.name = name;
  }
  if (request.text !== undefined) {
    const text = request.text.trim();
    const badText = gateText(text, job.mode, settings); if (badText) return badText;
    patch.payload = text;
  }
  if (request.silent !== undefined) {
    const badSilent = gateSilent(request.silent, job.mode); if (badSilent) return badSilent;
    patch.allowSilent = request.silent;
  }
  if (request.cron !== undefined && request.at !== undefined) return { ok: false, error: 'invalid_schedule', hint: 'cron 与 at 只能给一个（都不给就是保持原样）' };
  if (request.cron !== undefined) {
    const badCron = gateCron(request.cron, job.timezone, settings); if (badCron) return badCron;
    patch.trigger = { cron: request.cron, runAt: null };
  } else if (request.at !== undefined) {
    const parsed = gateAt(request.at, job.timezone);
    if (typeof parsed !== 'number') return parsed;
    patch.trigger = { cron: null, runAt: parsed };
  }
  let updated: ScheduledJob | null;
  try { updated = jobs.update(job.id, patch); }
  catch (error) { return duplicateOrThrow(error, patch.name ?? job.name); }
  if (!updated) return { ok: false, error: 'not_active', hint: '这条任务已经结束或被取消了，改不了；重新建一个' };
  // 无条件重排：`register` 第一步就 `scheduler.remove(name)`，重注册本来就幂等，而「触发时间变没变」
  // 多一个分支就多一个漏排的可能。排不进去就整行回滚 —— 旧 name/payload/cron 都回来，旧 cron 排回去。
  if (!registrar.register(updated)) {
    jobs.update(job.id, { name: job.name, payload: job.payload, allowSilent: job.allowSilent === 1,
      trigger: job.cron === null ? { cron: null, runAt: job.runAt! } : { cron: job.cron, runAt: null } });
    registrar.register(job);
    return { ok: false, error: 'schedule_register_failed', hint: '改动排不进调度器，已回滚到改之前' };
  }
  return { ok: true, job: updated, nextRun: registrar.nextRun(updated.id) };
}

/** 给模型与 WebUI 看的任务视图。两边同一份，免得「界面上写着 active、模型说没有」。 */
export function scheduledJobView(job: ScheduledJob, next: Date | null): Record<string, unknown> {
  return {
    name: job.name, mode: job.mode, state: job.state,
    ...(job.cron ? { cron: job.cron } : { at: new Date(job.runAt!).toISOString() }),
    timezone: job.timezone, payload: job.payload, runCount: job.runCount,
    // 对外线上一律叫 `silent`（DB 列 `allow_silent`、repo 字段 `allowSilent`）。映射点只有这里
    // 与 `app.ts` 的 `scheduleRow` 两处 —— 多一处就会有人对着三个名字猜哪个是权威。
    silent: job.allowSilent === 1,
    ...(next ? { nextRun: next.toISOString() } : {}),
    ...(job.lastRunAt ? { lastRunAt: new Date(job.lastRunAt).toISOString(), lastState: job.lastState } : {}),
    ...(job.lastError ? { lastError: job.lastError } : {}),
  };
}
