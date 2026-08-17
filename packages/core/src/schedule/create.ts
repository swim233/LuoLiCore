import { Cron } from 'croner';
import { ulid } from 'ulid';
import type { ScheduleRepository, ScheduledJob } from '@luoli/db';
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

export function createScheduledJob(jobs: ScheduleRepository, registrar: ScheduleRegistrar,
  request: ScheduleCreateRequest, context: ScheduleCreateContext): ScheduleCreateResult {
  const live = context.settings;
  if (!live.enabled) return { ok: false, error: 'schedule_disabled', hint: '定时任务被运维关掉了（schedule.enabled）' };
  const name = request.name.trim();
  if (!name || name.length > 64) return { ok: false, error: 'invalid_name', hint: '任务名要有内容且不超过 64 个字符' };
  const text = request.text.trim();
  if (!text) return { ok: false, error: 'invalid_text', hint: request.mode === 'agent' ? '要给一句任务描述' : '要给一段要发出的正文' };
  if (text.length > live.maxPayloadChars) return { ok: false, error: 'text_too_long', hint: `正文最多 ${live.maxPayloadChars} 字（schedule.maxPayloadChars）` };
  if ((request.cron === undefined) === (request.at === undefined)) return { ok: false, error: 'invalid_schedule', hint: 'cron 与 at 必须给且只给一个' };
  let runAt: number | null = null;
  if (request.at !== undefined) {
    runAt = parseLocalTime(request.at, context.timezone);
    if (runAt === null) return { ok: false, error: 'invalid_at', hint: '时间读不出来，用 2026-08-18T15:00 这种写法' };
    if (runAt <= Date.now()) return { ok: false, error: 'at_in_the_past', hint: `${request.at}（${context.timezone}）已经过去了；错过的触发点不会补跑` };
  } else {
    let interval: number;
    try { interval = cronIntervalMs(request.cron!, context.timezone); }
    catch (error) { return { ok: false, error: 'invalid_cron', hint: `cron 表达式不合法：${error instanceof Error ? error.message : String(error)}` }; }
    if (interval < live.minIntervalMinutes * 60_000) {
      return { ok: false, error: 'interval_too_short', hint: `两次触发间隔不能小于 ${live.minIntervalMinutes} 分钟（schedule.minIntervalMinutes）` };
    }
  }
  if (jobs.countActive(context.key) >= live.maxPerChat) {
    return { ok: false, error: 'too_many_jobs', hint: `这个会话已经有 ${live.maxPerChat} 个活跃任务（schedule.maxPerChat），先取消不要的` };
  }
  if (jobs.byName(context.key, name)) {
    return { ok: false, error: 'duplicate_name', hint: `这个会话已经有叫「${name}」的活跃任务了，换个名字或先取消它` };
  }
  const job = jobs.create({ id: ulid(), key: context.key, chatId: context.chatId, threadId: context.threadId,
    createdBy: context.createdBy, name, mode: request.mode, cron: request.cron ?? null, runAt, timezone: context.timezone, payload: text });
  // 排不进调度器就回滚：留一条永远不会响的 active 行，比建失败难查得多。
  if (!registrar.register(job)) {
    jobs.finish(job.id, 'cancelled', 'failed');
    return { ok: false, error: 'schedule_register_failed', hint: '任务建好了但排不进调度器，已回滚' };
  }
  return { ok: true, job, nextRun: registrar.nextRun(job.id) };
}

/** 给模型与 WebUI 看的任务视图。两边同一份，免得「界面上写着 active、模型说没有」。 */
export function scheduledJobView(job: ScheduledJob, next: Date | null): Record<string, unknown> {
  return {
    name: job.name, mode: job.mode, state: job.state,
    ...(job.cron ? { cron: job.cron } : { at: new Date(job.runAt!).toISOString() }),
    timezone: job.timezone, payload: job.payload, runCount: job.runCount,
    ...(next ? { nextRun: next.toISOString() } : {}),
    ...(job.lastRunAt ? { lastRunAt: new Date(job.lastRunAt).toISOString(), lastState: job.lastState } : {}),
    ...(job.lastError ? { lastError: job.lastError } : {}),
  };
}
