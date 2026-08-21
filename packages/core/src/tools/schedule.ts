import { z } from 'zod';
import type { ScheduleRepository } from '@luoli/db';
import type { Config } from '../config/schema.js';
import { createScheduledJob, scheduledJobView, updateScheduledJob } from '../schedule/create.js';
import type { ScheduledJobRunner } from '../schedule/runner.js';
import { builtinPolicy, type ToolExecutionContext, type ToolRegistry } from './registry.js';

export interface ScheduleToolDependencies {
  jobs: ScheduleRepository;
  runner: ScheduledJobRunner;
  /** 有没有投递通道（Telegram 入口）。没有的话这四个 `schedule_*` 整体不进目录 —— 排一个到点
   *  发不出去的任务，表现是每次触发只往日志里写一条 skipped，模型和用户都不知道。
   *  **`stay_silent` 不看这一条**：它的判据是本轮的 `silenceable`，而 runner 在投递通道
   *  不在时压根不开轮（docs/02 §10.1 最后一条）。 */
  deliverable(): boolean;
}

const settings = (context: ToolExecutionContext): Config['schedule'] => (context.turn.config as Readonly<Config>).schedule;
const timezoneOf = (context: ToolExecutionContext): string => (context.turn.config as Readonly<Config>).general.timezone;

/** 建与改共用同一句：两处写法一旦分叉，模型看到的就是两个开关（docs/02 §10.5 ①）。 */
const SILENT_FIELD = '允许这条任务到点那一轮宣布「本轮不用汇报」（用 stay_silent），产出照常进上下文但不发出来。'
  + '只对 mode=agent 有意义：notify 到点原样发出预写正文、不调模型，给了会被拒。默认关。';

/**
 * 定时任务那四个工具，外加只在静默轮次里存在的 `stay_silent`（docs/05 §3.8）。
 *
 * **`inputSchema` 里没有 `chatId` / `userId` / `key`**（docs/05 §8）：落点一律取自
 * `context.turn`。收下一个 chatId 参数就等于给任何 trusted 群成员一个跨会话写原语 ——
 * 他可以让 bot 每小时往别的群里发东西，而那个群里没人能解释这消息哪来的。
 * 同理 `list` / `cancel` / `update` 都按 `context.turn.key` 过滤，不接受任务 id。
 *
 * 校验与落库走 `createScheduledJob` / `updateScheduledJob`，与 WebUI 的
 * `POST /api/schedules`、`PATCH /api/schedules/:id` 是同一份。
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
      silent: z.boolean().optional().describe(SILENT_FIELD),
    }),
    // 上限随配置走，让模型看到的 schema 就是真实上限（docs/26 §5）。**新字段两份都要加**：
    // 这一份才是模型真正看到的，只加上面那份等于这个开关对模型不存在。
    inputSchemaFor: (context) => z.object({
      name: z.string().min(1).max(64), mode: z.enum(['agent', 'notify']),
      text: z.string().min(1).max(settings(context).maxPayloadChars),
      cron: z.string().min(1).optional(), at: z.string().min(1).optional(),
      silent: z.boolean().optional().describe(SILENT_FIELD),
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
    name: 'schedule_update',
    description: '改当前会话里一个活跃的定时任务（按名字找）。newName / text / cron / at / silent 给几个改几个，没给的原样保留 —— '
      + '两个时间字段都不给就是「触发时间不动」。cron 与 at 只能给一个，给了就是换触发方式；at 按这条任务自己的时区读，不是你现在这个时区。'
      + '改不了 mode（换模式会同时翻转 text 的语义与花不花钱），要换模式就取消重建 —— 代价是 run_count 与运行历史归零。',
    inputSchema: z.object({
      name: z.string().min(1).max(64).describe('要改哪一个：任务现在的名字'),
      newName: z.string().min(1).max(64).optional().describe('改名，同一会话内仍要唯一；改成它现在这个名字不算重名'),
      text: z.string().min(1).optional().describe('新的正文：agent 模式是任务描述，notify 模式是要发出的原文'),
      cron: z.string().min(1).optional().describe('换成周期任务，五段式 cron'),
      at: z.string().min(1).optional().describe('换成一次性任务，按任务自己的时区，形如 2026-08-18T15:00'),
      silent: z.boolean().optional().describe(SILENT_FIELD),
    }),
    inputSchemaFor: (context) => z.object({
      name: z.string().min(1).max(64), newName: z.string().min(1).max(64).optional(),
      text: z.string().min(1).max(settings(context).maxPayloadChars).optional(),
      cron: z.string().min(1).optional(), at: z.string().min(1).optional(),
      silent: z.boolean().optional().describe(SILENT_FIELD),
    }),
    policy: builtinPolicy('schedule_update'), sourcePriority: 100, available: () => dependencies.deliverable(),
    execute: (input, context) => {
      // 只按 (key, name) 找：拿 id 直接改等于让别的会话的任务也能被点掉。
      // HTTP 那一侧用 `:id` 定位是另一回事（owner 单身份的跨会话面板），所以那边 body 里的
      // `name` 是新名字，这边 `name` 是定位符、`newName` 才是新名字（docs/05 §3.8）。
      const job = dependencies.jobs.byName(context.turn.key, input.name);
      if (!job) return { ok: false, error: 'not_found', hint: `这个会话里没有叫「${input.name}」的活跃任务，用 schedule_list 看看` };
      // 缺席就原样传 undefined：`updateScheduledJob` 按「给没给」决定校验哪几道，在这里
      // 用旧值补齐等于每次改正文都重算一遍触发间隔（docs/05 §3.8 那条红线）。
      const result = updateScheduledJob(dependencies.jobs, dependencies.runner, job,
        { name: input.newName, text: input.text, cron: input.cron, at: input.at, silent: input.silent }, settings(context));
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

  /**
   * 「这一轮不用汇报」（docs/02 §10.5）。**注册无条件**：`main.ts` 那条启动断言要求
   * `TOOL_POLICY` 的每个键都注册过，包在 `if` 里的表现是关掉某个开关之后进程起不来。
   * 该不该出现由 `available()` 说了算。
   */
  registry.register({
    name: 'stay_silent',
    description: '宣布这一轮不用汇报：结论照常写进上下文（下一轮的你看得见自己这次查了什么），只是不发到聊天里。'
      + '只有「允许静默」的定时任务轮次才有这个工具 —— 有人在等回话的那种轮次里它不存在。'
      + '确实有事要说就别调它，直接说；调了之后请在同一步里把这次的结论写完。',
    inputSchema: z.object({
      reason: z.string().min(1).max(200).describe('为什么这一轮不用说，一句话。它进日志，是运维判断「这条任务是不是已经变成一台只烧钱不说话的定时器」的唯一凭据'),
    }),
    policy: builtinPolicy('stay_silent'), sourcePriority: 100,
    // 两道闸。`silenceable` 的唯一置位方是 `ScheduledJobRunner`，缺席即假，于是 Telegram 轮次、
    // 提示词预览、agent 隔离试跑全部 fail-closed；主 agent 那道不是冗余 —— **子 agent 拿到的是
    // 父轮的同一个 turn 对象**（`agent/subagent.ts` 的 `runSubAgent` 直接收 `turn`），少了它，
    // 一个 researcher 就能替整轮闭嘴，而派它出去的主 agent 全程不知情。
    // 写在 `available()` 而不是像 `memory_write` 那样硬编码进 `registry.ts` 的 `admit()`：
    // `admit()` 本来就会复查一遍 `available()`，一处判据同时管住目录过滤与硬拦截。
    available: (_role, context) => context.agentKind === 'main' && context.turn.silenceable === true,
    execute: (input, context) => {
      // **两个键必须一起置**：只置 `silenced` 会让每条 `schedule.silent` 的 `reason` 恒为 null，
      // 而那是这条任务「是不是从此再也不说话了」唯一可读的凭据。轮次对象随轮次消亡，
      // 不引入新的进程内表（同 `builtins.ts` 的 `claimExtraMessage`）。
      Object.assign(context.turn, { silenced: true, silenceReason: input.reason });
      // 带工具调用的那一步通常没有正文，而「没正文 + 调过工具」正好命中 `wrapUpIfNeeded` 的
      // 前两道闸 —— 不 nudge 的话每次静默都要多付一次模型调用（docs/02 §10.5 ⑤）。
      return { ok: true, silenced: true,
        hint: '这一轮不会发出去了。现在就把这次的结论写下来（就写在这一步的正文里）—— 它只进上下文，下一轮的你要靠它知道自己查过什么。' };
    },
  });
}
