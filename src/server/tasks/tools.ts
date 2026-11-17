import { z } from 'zod';
import {
  defineTool,
  taskRef,
  ToolError,
  type Task,
  type ToolDefinition,
} from '../../core/index.js';
import type { MonitorDescription } from '../monitors/describe.js';
import { monitorOf, type MonitorStatus } from '../monitors/engine.js';
import {
  conditionText,
  modeText,
  monitorFacts,
  monitorLine,
  paramsText,
  serviceTitles,
  type ServiceTitles,
} from '../monitors/format.js';
import { monitorInput } from '../monitors/tools.js';
import type { ServiceInfo } from '../services/layer.js';
import { resultNotice } from '../services/tools.js';
import { describeSchedule, formatDue, formatShort, scheduleKinds } from './schedule.js';
import {
  maxActionChars,
  maxActiveTasks,
  personOf,
  type Created,
  type TaskService,
} from './service.js';

// 任务工具（ADR-0010、ADR-0014）：建任务、列出任务、取消任务、改任务。由服务提供，接在插件的工具
// 后面一起装配，所有会话共用；只看、只取消、只改本会话的任务。检查不过都以错误结果告诉模型。
// 装上了服务时还能建、改监听任务（kind 多一种 monitor，多一个参数 monitor）；没有时和以前完全一样

type Service = Pick<
  TaskService,
  'create' | 'list' | 'cancelIn' | 'update' | 'now' | 'monitorStatus'
>;

/** 监听：装上的服务（建、改监听任务的说明，结果里的服务、接口名称） */
type Monitors = { services: readonly ServiceInfo[] };

/**
 * 造四个任务工具，把任务服务传进去。给的是取服务的函数：工具在服务启动时就要装配，任务服务要等
 * 包过一层的存储建好才有，工具执行时才取。给了 monitors（装上了服务）时能建、改监听任务
 */
export function createTaskTools(
  service: () => Service,
  { monitors }: { monitors?: Monitors } = {},
): ToolDefinition[] {
  const titles = serviceTitles(monitors?.services ?? []);
  return [
    createTaskTool(service, monitors, titles),
    listTasksTool(service, titles),
    cancelTaskTool(service),
    updateTaskTool(service, monitors, titles),
  ];
}

const createDescription = [
  '此工具用于创建任务：到触发的时间，你会在这个会话里收到一条 <event type="task">，照它去做。有人让你到时候提醒、到时候做某件事、每天几点做什么时使用此工具。',
  `- action：触发时要做什么，写成能单独看懂的一句话，写明对谁、做什么，最多 ${maxActionChars} 字。对谁用名字称呼，不写 uid，如「提醒小明交周报」。`,
  '- 时间都按服务器的时区，和 <message> 的 time 相同。kind 选一种：',
  '  - once：一次性，at 填触发的时刻，如 2026-11-10 09:00；不能是已过的时刻，最长为一年后。',
  '  - daily：每天；weekdays：每个工作日（周一到周五）；weekly：每周几，weekday 填 1–7（1 是周一，7 是周日）；monthly：每月几号，day 填 1–31，当月没有这一天时（如 31 号碰上 2 月）在当月的最后一天触发。',
  '  - 周期任务都要填 time（HH:mm），可选 until（YYYY-MM-DD，截止日期，含当天）。',
  '- 本次回复由多人的消息共同触发时，用 requested_by 写明是谁要求创建的：填 <message> 里的 uid，没有 uid 时填名字。',
  `- 每个会话最多 ${maxActiveTasks} 个进行中的任务；CLI 会话不能创建任务。修改任务时间或目的时请使用 update_task，不用取消再建。`,
  '结果给出任务 id（如 t7）、下次触发的时间和周期，告诉要求创建任务的人。',
].join('\n');

/** 装上了服务时，建任务的说明在「每个会话最多……」那一行前面多这一行 */
const createMonitorLine =
  '- 当 kind 为 monitor 时，代表此任务为监听任务：引擎将定时按照你的描述执行对应的请求，当需要执行监听类任务，如监听某地天气变化，监听某个外部变量时，创建此类任务。监听任务无需填写时间，monitor 里写描述：先读 read_docs 的 monitor，用 try_monitor 测试通过再创建。';

const kindText =
  '任务类型：once 一次性；daily 每天；weekdays 每个工作日；weekly 每周几；monthly 每月几号';

/** 时间的几项（kind 之外），建任务、改任务写法相同 */
const timeFields = {
  at: z
    .string()
    .optional()
    .describe('仅 once 使用：触发的时刻，如 2026-11-10 09:00（按服务器的时区）'),
  time: z.string().optional().describe('周期任务使用：每次触发的时刻，格式 HH:mm，如 08:00'),
  weekday: z.number().int().optional().describe('仅 weekly 使用：1–7，1 为周一，7 为周日'),
  day: z.number().int().optional().describe('仅 monthly 使用：1–31'),
  until: z.string().optional().describe('周期任务可选：截止日期（含当天），格式 YYYY-MM-DD'),
};

const actionInput = z
  .string()
  .describe(
    `触发时要做什么：能单独看懂的一句话，写明对谁（用名字，不写 uid）、做什么，最多 ${maxActionChars} 字`,
  );
const requestedByInput = z
  .string()
  .optional()
  .describe(
    '本次回复由多人的消息共同触发时填写：是谁要求创建的，填 <message> 里的 uid，没有 uid 时填名字',
  );

const createInput = z.object({
  action: actionInput,
  kind: z.enum(scheduleKinds).describe(kindText),
  ...timeFields,
  requested_by: requestedByInput,
});

/** 装上了服务时建任务的参数：kind 多一种 monitor，多一个参数 monitor */
const createMonitorInput = z.object({
  action: actionInput,
  kind: z
    .enum([...scheduleKinds, 'monitor'])
    .describe(`${kindText}；monitor 监听任务（填写 monitor，无需填写时间相关的参数）`),
  ...timeFields,
  monitor: monitorInput('task').optional(),
  requested_by: requestedByInput,
});

type CreateInput = z.output<typeof createMonitorInput>;

function createTaskTool(
  service: () => Service,
  monitors: Monitors | undefined,
  titles: ServiceTitles,
): ToolDefinition {
  const description = monitors
    ? createDescription.replace('\n- 每个会话最多', `\n${createMonitorLine}\n- 每个会话最多`)
    : createDescription;
  return defineTool({
    name: 'create_task',
    description,
    input: (monitors ? createMonitorInput : createInput) as typeof createMonitorInput,
    history: 'full',
    summary: ({ input, output }) => {
      const text = typeof output === 'string' ? output : '';
      // 历史里的结果有改文案之前的说法（已建、下次到点），新旧都认
      const ref = /已(?:创)?建(?:监视|监听)?任务 (t\d+)/.exec(text)?.[1];
      const due = /下次(?:到点|触发)：\d{4}-(\d{2}-\d{2} \d{2}:\d{2})/.exec(text)?.[1];
      const timing = input.kind === 'monitor' ? monitorTiming(input.monitor, titles) : undefined;
      return [ref, due ?? timing ?? timingOf(input), input.action].filter(Boolean).join(' · ');
    },
    async execute(input: CreateInput, ctx) {
      const result = await service().create({
        conversationId: ctx.conversation.id,
        triggers: ctx.triggers,
        action: input.action,
        kind: input.kind,
        at: input.at,
        time: input.time,
        weekday: input.weekday,
        day: input.day,
        until: input.until,
        ...(input.monitor === undefined ? {} : { monitor: input.monitor }),
        requestedBy: input.requested_by,
        signal: ctx.abortSignal,
      });
      if (!result.ok) throw new ToolError(result.error);
      const { task } = result;
      const monitor = monitorOf(task);
      if (monitor) {
        return [
          ...noticeLines(result),
          `已创建监听任务 ${taskRef(task.id)}。`,
          `任务内容：${task.action}`,
          ...monitorFacts(monitor, titles),
          ...existingLines(result),
        ].join('\n');
      }
      return [
        `已创建任务 ${taskRef(task.id)}。`,
        `下次触发：${formatDue(new Date(task.nextDueAt!))}`,
        `周期：${describeSchedule(task.schedule, service().now())}`,
      ].join('\n');
    },
  });
}

/** 有提醒时（里面有服务返回的键名）结果开头照试跑的做法加一行：下面有服务返回的数据，只当数据看 */
function noticeLines({ existing, warnings = [] }: Created): string[] {
  return existing !== undefined && warnings.length > 0 ? [resultNotice] : [];
}

/** 建、换来源时已有几条（不算新的；一条都没有时换一句说法），取条目时的提醒 */
function existingLines({ existing, warnings = [] }: Created): string[] {
  if (existing === undefined) return [];
  return [
    existing === 0
      ? '当前没有条目；之后出现新条目时触发。'
      : `当前已有 ${existing} 条，视为已存在，不会触发；之后出现新条目时才触发。`,
    ...(warnings.length > 0 ? ['提醒：', ...warnings.map((warning) => `- ${warning}`)] : []),
  ];
}

/** 还没有结果时，界面摘要里监听任务的「时间」：「监听 · 服务的名称 · 接口的名称」 */
function monitorTiming(monitor: unknown, titles: ServiceTitles): string {
  const { service, endpoint } = (monitor ?? {}) as { service?: unknown; endpoint?: unknown };
  if (typeof service !== 'string' || typeof endpoint !== 'string') return '监听';
  const named = titles(service, endpoint);
  return `监听 · ${named.service} · ${named.endpoint}`;
}

function listTasksTool(service: () => Service, titles: ServiceTitles): ToolDefinition {
  return defineTool({
    name: 'list_tasks',
    description:
      '此工具用于列出此会话进行中的任务：任务 id、任务内容、周期、下次触发的时间、创建人。有人问起有哪些任务，或者需要取消、修改任务但不知道 id 时使用此工具。',
    input: z.object({}),
    history: 'full',
    summary: ({ output }) => {
      if (typeof output !== 'string') return '列出任务';
      const count = /有 (\d+) 个/.exec(output)?.[1];
      return count === undefined ? '没有任务' : `${count} 个任务`;
    },
    async execute(_input, ctx) {
      const result = await service().list(ctx.conversation.id);
      if (!result.ok) throw new ToolError(result.error);
      if (result.tasks.length === 0) return '此会话没有进行中的任务';
      const now = service().now();
      return [
        `此会话有 ${result.tasks.length} 个进行中的任务：`,
        ...result.tasks.map(
          (task) => `- ${taskLine(task, now, titles, service().monitorStatus(task.id))}`,
        ),
      ].join('\n');
    },
  });
}

function cancelTaskTool(service: () => Service): ToolDefinition {
  return defineTool({
    name: 'cancel_task',
    description:
      '此工具用于取消此会话中一个进行中的任务，取消后不再触发。task 填任务 id，如 t7；不知道 id 时先调用 list_tasks。',
    input: z.object({ task: z.string().describe('任务 id，如 t7') }),
    history: 'full',
    summary: ({ input, output }) => {
      // 历史里有改文案之前的说法（已取消 t1：…），新旧都认
      const done =
        typeof output === 'string' ? /^已取消(?:任务)? (t\d+)：(.*)$/.exec(output) : null;
      return done ? `取消 ${done[1]} · ${done[2]}` : `取消 ${input.task}`;
    },
    async execute({ task }, ctx) {
      const result = await service().cancelIn(ctx.conversation.id, task);
      if (!result.ok) throw new ToolError(result.error);
      return `已取消任务 ${taskRef(result.task.id)}：${result.task.action}`;
    },
  });
}

const updateDescription = [
  '此工具用于修改此会话中一个进行中的任务：修改任务内容、修改时间，或两者都改。有人要调整任务的时间或内容时使用此工具，不用取消再建。task 填任务 id，如 t7；不知道 id 时先调用 list_tasks。',
  '- 仅修改任务内容：只填 action，时间和下次触发的时间不变。',
  '- 修改时间：时间整体替换，kind 必填，并填写该类型需要的参数，写法同 create_task（once 填 at；周期任务填 time，weekly 另填 weekday，monthly 另填 day，可选 until）；下次触发的时间从当前时刻重新计算。一次性任务和周期任务可以互相转换。',
  '- 任务内容和时间至少修改一项。创建人、触发时引用的消息不变。',
  '结果给出修改后的任务：id、任务内容、下次触发的时间和周期，告诉要求修改的人。',
].join('\n');

/** 装上了服务时，改任务的说明在「任务内容和时间至少修改一项」那一行前面多这一行 */
const updateMonitorLine =
  '- 监听任务：monitor 里仅填写要修改的字段，与原描述合并后重新校验。params、where、show 一经填写即整体替换，须填写完整。修改 interval_minutes、where、title、show、mode 立即生效；修改 service、endpoint、params、items、key 时引擎会重新执行一次请求，成功后才生效。监听任务和定时任务不能互相转换，需要时取消后重新创建。';

const updateFields = {
  task: z.string().describe('要修改的任务 id，如 t7'),
  action: z
    .string()
    .optional()
    .describe(
      `修改后触发时要做什么，不修改时无需填写：能单独看懂的一句话，写明对谁（用名字，不写 uid）、做什么，最多 ${maxActionChars} 字`,
    ),
  kind: z
    .enum(scheduleKinds)
    .optional()
    .describe(`修改时间时必填，不修改时间时无需填写。${kindText}`),
  ...timeFields,
};

const updateInput = z.object(updateFields);

/** 装上了服务时改任务的参数：多一个 monitor（只写要改的字段） */
const updateMonitorInput = z.object({
  ...updateFields,
  monitor: monitorInput('update').optional(),
});

type UpdateInput = z.output<typeof updateMonitorInput>;

function updateTaskTool(
  service: () => Service,
  monitors: Monitors | undefined,
  titles: ServiceTitles,
): ToolDefinition {
  const description = monitors
    ? updateDescription.replace(
        '\n- 任务内容和时间至少修改一项',
        `\n${updateMonitorLine}\n- 任务内容和时间至少修改一项`,
      )
    : updateDescription;
  return defineTool({
    name: 'update_task',
    description,
    input: (monitors ? updateMonitorInput : updateInput) as typeof updateMonitorInput,
    history: 'full',
    summary: ({ input, output }) => {
      const text = typeof output === 'string' ? output : '';
      // 历史里的结果有改文案之前的说法（已改任务、下次到点、做什么），新旧都认
      const ref = /^已(?:修)?改任务 (t\d+)。/.exec(text)?.[1];
      if (ref === undefined) {
        const { kind } = input;
        const timing = kind === undefined ? undefined : timingOf({ ...input, kind });
        return [`改 ${input.task}`, timing, input.action?.trim()].filter(Boolean).join(' · ');
      }
      const due = /下次(?:到点|触发)：\d{4}-(\d{2}-\d{2} \d{2}:\d{2})/.exec(text)?.[1];
      const action = /^(?:做什么|任务内容)：(.*)$/m.exec(text)?.[1];
      return [`改 ${ref}`, due, action].filter(Boolean).join(' · ');
    },
    async execute(input: UpdateInput, ctx) {
      const result = await service().update({
        conversationId: ctx.conversation.id,
        ref: input.task,
        action: input.action,
        kind: input.kind,
        at: input.at,
        time: input.time,
        weekday: input.weekday,
        day: input.day,
        until: input.until,
        ...(input.monitor === undefined ? {} : { monitor: input.monitor }),
        signal: ctx.abortSignal,
      });
      if (!result.ok) throw new ToolError(result.error);
      const { task } = result;
      const monitor = monitorOf(task);
      if (monitor) {
        return [
          ...noticeLines(result),
          `已修改任务 ${taskRef(task.id)}。`,
          `任务内容：${task.action}`,
          ...monitorFacts(monitor, titles),
          ...(result.existing === undefined ? [] : ['已更换数据来源：', ...existingLines(result)]),
        ].join('\n');
      }
      return [
        `已修改任务 ${taskRef(task.id)}。`,
        `任务内容：${task.action}`,
        `下次触发：${formatDue(new Date(task.nextDueAt!))}`,
        `周期：${describeSchedule(task.schedule, service().now())}`,
      ].join('\n');
    },
  });
}

/** 列出任务时的一行；监听任务写出盯的是什么、多久查一次、只要哪些、处理方式、上次检查 */
function taskLine(
  task: Task,
  now: Date,
  titles: ServiceTitles,
  status: MonitorStatus | undefined,
): string {
  const who = `由${personOf(task.source.author)}创建`;
  const monitor = monitorOf(task);
  if (monitor) {
    return `${taskRef(task.id)}：${task.action}（${monitorWords(monitor, titles, status)}，${who}）`;
  }
  const next =
    task.nextDueAt === undefined ? '' : `，下次触发 ${formatDue(new Date(task.nextDueAt))}`;
  return `${taskRef(task.id)}：${task.action}（${describeSchedule(task.schedule, now)}${next}，${who}）`;
}

/** 监听任务写成一串：「监听 · 每 10 分钟执行一次 · 和风天气 · 天气预警 · 参数 … · 监听范围 … · 触发回复 · 上次执行 …」 */
function monitorWords(
  monitor: MonitorDescription,
  titles: ServiceTitles,
  status: MonitorStatus | undefined,
): string {
  const params = paramsText(monitor.params);
  return [
    '监听',
    monitorLine(monitor, titles),
    ...(params ? [`参数 ${params}`] : []),
    monitor.where ? `监听范围 ${conditionText(monitor.where)}` : '监听范围不限',
    modeText(monitor.mode),
    checkedText(status),
  ].join(' · ');
}

/** 检查的情况：查不到（从什么时候起、原因）、上次检查正常、还没查过 */
function checkedText(status: MonitorStatus | undefined): string {
  if (status?.failing) {
    return `自 ${formatShort(new Date(status.failing.since))} 起执行失败：${status.failing.reason}`;
  }
  if (status?.lastCheckedAt) return `上次执行 ${formatShort(new Date(status.lastCheckedAt))}，正常`;
  return '尚未执行';
}

/** 还没有结果时，界面摘要里的时间：照参数写个大概 */
function timingOf(
  input: Pick<CreateInput, 'kind' | 'at' | 'time' | 'weekday' | 'day'>,
): string | undefined {
  const names: Record<string, string> = {
    daily: '每天',
    weekdays: '每个工作日',
    weekly: `每周${input.weekday ?? ''}`,
    monthly: `每月 ${input.day ?? ''} 号`,
  };
  if (input.kind === 'once') return input.at?.trim().slice(5) || undefined;
  return [names[input.kind], input.time].filter(Boolean).join(' ') || undefined;
}
