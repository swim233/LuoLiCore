import { Cron } from 'croner';
import { ulid } from 'ulid';
import { z } from 'zod';
import type { ScheduleRepository, ScheduledJob } from '@luoli/db';
import type { Config } from '../config/schema.js';
import type { ScheduledJobRunner } from '../schedule/runner.js';
import { builtinPolicy, type ToolExecutionContext, type ToolRegistry } from './registry.js';

export interface ScheduleToolDependencies {
  jobs: ScheduleRepository;
  runner: ScheduledJobRunner;
  /** 有没有投递通道（Telegram 入口）。没有的话这三个工具整体不进目录 —— 排一个到点
   *  发不出去的任务，表现是每次触发只往日志里写一条 skipped，模型和用户都不知道。 */
  deliverable(): boolean;
}

const settings = (context: ToolExecutionContext): Config['schedule'] => (context.turn.config as Readonly<Config>).schedule;
const timezoneOf = (context: ToolExecutionContext): string => (context.turn.config as Readonly<Config>).general.timezone;

/**
 * `at` 是「用户所在时区的墙上时间」，不是 UTC。`new Date('2026-08-18T15:00:00')` 按**宿主**
 * 时区解析，宿主是 UTC 的部署里「下午三点」会变成晚上十一点。所以自己按 `general.timezone`
 * 折算：先当成 UTC 读进来，再用那个时区在该时刻的偏移量补回去。
 */
function parseLocal(value: string, timezone: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!match) { const direct = Date.parse(value); return Number.isNaN(direct) ? null : direct; }
  const [, y, mo, d, h, mi, s] = match;
  const asUtc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0));
  // 偏移量本身依赖时刻（夏令时），所以用「先按 UTC 猜一次、再用猜出来的时刻查偏移」这一步收敛。
  const offset = (probe: number): number => {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(probe)).reduce<Record<string, string>>((accumulator, part) => { accumulator[part.type] = part.value; return accumulator; }, {});
    const wall = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));
    return wall - probe;
  };
  return asUtc - offset(asUtc - offset(asUtc));
}

/** cron 两次触发之间的间隔（毫秒）。表达式非法时抛，由调用方翻成 `{ok:false}`。 */
function cronIntervalMs(expression: string, timezone: string): number {
  const cron = new Cron(expression, { timezone });
  const upcoming = cron.nextRuns(2);
  if (upcoming.length < 2) return Number.POSITIVE_INFINITY;
  return upcoming[1]!.getTime() - upcoming[0]!.getTime();
}

const view = (job: ScheduledJob, next: Date | null): Record<string, unknown> => ({
  name: job.name, mode: job.mode, state: job.state, ...(job.cron ? { cron: job.cron } : { at: new Date(job.runAt!).toISOString() }),
  timezone: job.timezone, payload: job.payload, runCount: job.runCount,
  ...(next ? { nextRun: next.toISOString() } : {}),
  ...(job.lastRunAt ? { lastRunAt: new Date(job.lastRunAt).toISOString(), lastState: job.lastState } : {}),
  ...(job.lastError ? { lastError: job.lastError } : {}),
});

/**
 * 定时任务的三个工具。
 *
 * **`inputSchema` 里没有 `chatId` / `userId` / `key`**（docs/05 §8）：落点一律取自
 * `context.turn`。收下一个 chatId 参数就等于给任何 trusted 群成员一个跨会话写原语 ——
 * 他可以让 bot 每小时往别的群里发东西，而那个群里没人能解释这消息哪来的。
 * 同理 `list` / `cancel` 都按 `context.turn.key` 过滤，不接受任务 id。
 */
export function registerScheduleTools(registry: ToolRegistry, dependencies: ScheduleToolDependencies): void {
  registry.register({
    name: 'schedule_create',
    description: '排一个定时任务。cron 与 at 二者给一个：cron 是周期任务（五段式，如 "0 8 * * *" 每天早八点），at 是一次性任务（本地时间，如 "2026-08-18T15:00"）。'
      + 'mode=agent 时 text 是给你自己的任务描述，到点会像用户找你一样起一轮完整对话（会花钱）；mode=notify 时 text 会被原样发出，不调模型，适合纯提醒。任务只作用于当前会话。',
    inputSchema: z.object({
      name: z.string().min(1).max(64).describe('任务名，同一会话内唯一，取消时用它'),
      mode: z.enum(['agent', 'notify']).describe('agent=到点起一轮对话执行 text；notify=到点原样发出 text'),
      text: z.string().min(1).describe('agent 模式是任务描述，notify 模式是要发出的原文'),
      cron: z.string().min(1).optional().describe('五段式 cron 表达式，周期任务'),
      at: z.string().min(1).optional().describe('一次性任务的时间，本地时区，形如 2026-08-18T15:00'),
    }),
    // 上限随配置走，让模型看到的 schema 就是真实上限（docs/26 §5）。
    inputSchemaFor: (context) => z.object({
      name: z.string().min(1).max(64), mode: z.enum(['agent', 'notify']),
      text: z.string().min(1).max(settings(context).maxPayloadChars),
      cron: z.string().min(1).optional(), at: z.string().min(1).optional(),
    }),
    policy: builtinPolicy('schedule_create'), sourcePriority: 100, available: () => dependencies.deliverable(),
    execute: (input, context) => {
      const live = settings(context);
      if (!live.enabled) return { ok: false, error: 'schedule_disabled', hint: '定时任务被运维关掉了（schedule.enabled）' };
      if ((input.cron === undefined) === (input.at === undefined)) return { ok: false, error: 'invalid_schedule', hint: 'cron 与 at 必须给且只给一个' };
      const timezone = timezoneOf(context);
      let runAt: number | null = null;
      if (input.at !== undefined) {
        runAt = parseLocal(input.at, timezone);
        if (runAt === null) return { ok: false, error: 'invalid_at', hint: '时间读不出来，用 2026-08-18T15:00 这种写法' };
        if (runAt <= Date.now()) return { ok: false, error: 'at_in_the_past', hint: `${input.at}（${timezone}）已经过去了；错过的触发点不会补跑` };
      } else {
        let interval: number;
        try { interval = cronIntervalMs(input.cron!, timezone); }
        catch (error) { return { ok: false, error: 'invalid_cron', hint: `cron 表达式不合法：${error instanceof Error ? error.message : String(error)}` }; }
        if (interval < live.minIntervalMinutes * 60_000) {
          return { ok: false, error: 'interval_too_short', hint: `两次触发间隔不能小于 ${live.minIntervalMinutes} 分钟（schedule.minIntervalMinutes）` };
        }
      }
      if (dependencies.jobs.countActive(context.turn.key) >= live.maxPerChat) {
        return { ok: false, error: 'too_many_jobs', hint: `这个会话已经有 ${live.maxPerChat} 个活跃任务（schedule.maxPerChat），先用 schedule_cancel 清掉不要的` };
      }
      if (dependencies.jobs.byName(context.turn.key, input.name)) {
        return { ok: false, error: 'duplicate_name', hint: `这个会话已经有叫「${input.name}」的活跃任务了，换个名字或先取消它` };
      }
      const job = dependencies.jobs.create({ id: ulid(), key: context.turn.key, chatId: context.turn.chatId, threadId: context.turn.threadId,
        createdBy: context.turn.initiatorUserId, name: input.name, mode: input.mode, cron: input.cron ?? null, runAt, timezone, payload: input.text });
      if (!dependencies.runner.register(job)) {
        dependencies.jobs.finish(job.id, 'cancelled', 'failed');
        return { ok: false, error: 'schedule_register_failed', hint: '任务建好了但排不进调度器，已回滚' };
      }
      return { ok: true, ...view(job, dependencies.runner.nextRun(job.id)) };
    },
  });

  registry.register({
    name: 'schedule_list',
    description: '列出当前会话的定时任务：活跃的在前，带下一次触发时间与上一次的结果。',
    inputSchema: z.object({}),
    policy: builtinPolicy('schedule_list'), sourcePriority: 100, available: () => dependencies.deliverable(),
    execute: (_input, context) => {
      const jobs = dependencies.jobs.listByKey(context.turn.key);
      return { ok: true, enabled: settings(context).enabled, timezone: timezoneOf(context),
        jobs: jobs.map((job) => view(job, job.state === 'active' ? dependencies.runner.nextRun(job.id) : null)) };
    },
  });

  registry.register({
    name: 'schedule_cancel',
    description: '取消当前会话里某个定时任务（按名字）。已经结束的任务不用取消。',
    inputSchema: z.object({ name: z.string().min(1).max(64) }),
    policy: builtinPolicy('schedule_cancel'), sourcePriority: 100, available: () => dependencies.deliverable(),
    execute: (input, context) => {
      // 只按 (key, name) 找：拿 id 直接删等于让别的会话的任务也能被点掉。
      const job = dependencies.jobs.byName(context.turn.key, input.name);
      if (!job) return { ok: false, error: 'not_found', hint: `这个会话里没有叫「${input.name}」的活跃任务，用 schedule_list 看看` };
      dependencies.jobs.finish(job.id, 'cancelled');
      dependencies.runner.unregister(job.id);
      return { ok: true, name: job.name, cancelled: true };
    },
  });
}
