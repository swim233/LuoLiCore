import { z } from 'zod';
import type { ScheduleRepository } from '@luoli/db';
import type { Config } from '../config/schema.js';
import { createScheduledJob, scheduledJobView } from '../schedule/create.js';
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
 * 定时任务的三个工具。
 *
 * **`inputSchema` 里没有 `chatId` / `userId` / `key`**（docs/05 §8）：落点一律取自
 * `context.turn`。收下一个 chatId 参数就等于给任何 trusted 群成员一个跨会话写原语 ——
 * 他可以让 bot 每小时往别的群里发东西，而那个群里没人能解释这消息哪来的。
 * 同理 `list` / `cancel` 都按 `context.turn.key` 过滤，不接受任务 id。
 *
 * 校验与落库走 `createScheduledJob`，与 WebUI 的 `POST /api/schedules` 是同一份。
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
      const result = createScheduledJob(dependencies.jobs, dependencies.runner, input, {
        key: context.turn.key, chatId: context.turn.chatId, threadId: context.turn.threadId,
        createdBy: context.turn.initiatorUserId, timezone: timezoneOf(context), settings: settings(context),
      });
      return result.ok ? { ok: true, ...scheduledJobView(result.job, result.nextRun) } : { ok: false, error: result.error, hint: result.hint };
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
        jobs: jobs.map((job) => scheduledJobView(job, job.state === 'active' ? dependencies.runner.nextRun(job.id) : null)) };
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
