import { z } from 'zod';
import {
  defineTool,
  taskRef,
  ToolError,
  type Task,
  type ToolDefinition,
} from '../../core/index.js';
import { describeSchedule, formatDue, scheduleKinds } from './schedule.js';
import { maxActionChars, maxActiveTasks, personOf, type TaskService } from './service.js';

// 任务工具（ADR-0010）：建任务、列出任务、取消任务。由服务提供，接在插件的工具后面一起装配，
// 所有会话共用；只看、只取消本会话的任务。检查不过都以错误结果告诉模型

type Service = Pick<TaskService, 'create' | 'list' | 'cancelIn' | 'now'>;

/**
 * 造三个任务工具，把任务服务传进去。给的是取服务的函数：工具在服务启动时就要装配，任务服务要等
 * 包过一层的存储建好才有，工具执行时才取
 */
export function createTaskTools(service: () => Service): ToolDefinition[] {
  return [createTaskTool(service), listTasksTool(service), cancelTaskTool(service)];
}

const createDescription = [
  '建一个任务：到约好的时间，你会在这个会话里收到一条 <event type="task">，照它去做。有人让你到时候提醒、到时候做某件事、每天几点做什么时用它。',
  `- action：到点时要做什么，写成能单独看懂的一句话，写明对谁、做什么（到点时原来的对话可能只剩摘要），最多 ${maxActionChars} 字。对谁用名字称呼，不写 uid，如「提醒小明交周报」。`,
  '- 时间都按服务器的时区，和 <message> 的 time 相同。kind 选一种：',
  '  - once：一次性，at 写到点的时刻，如 2026-11-10 09:00；不能是已经过了的时刻，最远一年后。',
  '  - daily：每天；weekdays：每个工作日（周一到周五）；weekly：每周几，weekday 写 1–7（1 是周一，7 是周日）；monthly：每月几号，day 写 1–31，那个月没有这一天时（如 31 号碰上 2 月）在那个月的最后一天到点。',
  '  - 周期的都要写 time（HH:mm），可以写 until（YYYY-MM-DD，到这一天为止，含这一天）。',
  '- 这次回复是几个人的消息一起触发的时，用 requested_by 写明是谁让建的：<message> 里的 uid，没有 uid 时写名字。',
  `- 每个会话最多 ${maxActiveTasks} 个进行中的任务；CLI 会话不能建。任务改不了，要改时间就取消再建。`,
  '结果给出任务 id（如 t7）、下次到点和周期，告诉让你建任务的人。',
].join('\n');

const createInput = z.object({
  action: z
    .string()
    .describe(
      `到点时要做什么：能单独看懂的一句话，写明对谁（用名字，不写 uid）、做什么，最多 ${maxActionChars} 字`,
    ),
  kind: z
    .enum(scheduleKinds)
    .describe('once 一次性；daily 每天；weekdays 每个工作日；weekly 每周几；monthly 每月几号'),
  at: z.string().optional().describe('once 用：到点的时刻，如 2026-11-10 09:00（服务器的时区）'),
  time: z.string().optional().describe('周期的用：每次到点的时刻，HH:mm，如 08:00'),
  weekday: z.number().int().optional().describe('weekly 用：1–7，1 是周一，7 是周日'),
  day: z.number().int().optional().describe('monthly 用：1–31'),
  until: z.string().optional().describe('周期的可选：到这一天为止（含这一天），YYYY-MM-DD'),
  requested_by: z
    .string()
    .optional()
    .describe('几个人一起触发这次回复时：是谁让建的，<message> 里的 uid，没有 uid 时写名字'),
});

function createTaskTool(service: () => Service): ToolDefinition {
  return defineTool({
    name: 'create_task',
    description: createDescription,
    input: createInput,
    history: 'full',
    summary: ({ input, output }) => {
      const text = typeof output === 'string' ? output : '';
      const ref = /已建任务 (t\d+)/.exec(text)?.[1];
      const due = /下次到点：\d{4}-(\d{2}-\d{2} \d{2}:\d{2})/.exec(text)?.[1];
      return [ref, due ?? timingOf(input), input.action].filter(Boolean).join(' · ');
    },
    async execute(input, ctx) {
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
        requestedBy: input.requested_by,
      });
      if (!result.ok) throw new ToolError(result.error);
      const { task } = result;
      return [
        `已建任务 ${taskRef(task.id)}。`,
        `下次到点：${formatDue(new Date(task.nextDueAt!))}`,
        `周期：${describeSchedule(task.schedule, service().now())}`,
      ].join('\n');
    },
  });
}

function listTasksTool(service: () => Service): ToolDefinition {
  return defineTool({
    name: 'list_tasks',
    description:
      '列出这个会话进行中的任务：任务 id、做什么、周期、下次到点、谁让建的。有人问起有哪些任务、要取消任务又不知道 id 时用它。',
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
      if (result.tasks.length === 0) return '这个会话没有进行中的任务';
      const now = service().now();
      return [
        `这个会话进行中的任务有 ${result.tasks.length} 个：`,
        ...result.tasks.map((task) => `- ${taskLine(task, now)}`),
      ].join('\n');
    },
  });
}

function cancelTaskTool(service: () => Service): ToolDefinition {
  return defineTool({
    name: 'cancel_task',
    description:
      '取消这个会话里一个进行中的任务，之后它不再到点。task 写任务 id，如 t7；不知道 id 时先用 list_tasks。',
    input: z.object({ task: z.string().describe('任务 id，如 t7') }),
    history: 'full',
    summary: ({ input, output }) => {
      const done = typeof output === 'string' ? /^已取消 (t\d+)：(.*)$/.exec(output) : null;
      return done ? `取消 ${done[1]} · ${done[2]}` : `取消 ${input.task}`;
    },
    async execute({ task }, ctx) {
      const result = await service().cancelIn(ctx.conversation.id, task);
      if (!result.ok) throw new ToolError(result.error);
      return `已取消 ${taskRef(result.task.id)}：${result.task.action}`;
    },
  });
}

/** 列出任务时的一行 */
function taskLine(task: Task, now: Date): string {
  const next =
    task.nextDueAt === undefined ? '' : `，下次到点 ${formatDue(new Date(task.nextDueAt))}`;
  return `${taskRef(task.id)}：${task.action}（${describeSchedule(task.schedule, now)}${next}，${personOf(task.source.author)}让建的）`;
}

/** 还没有结果时，界面摘要里的时间：照参数写个大概 */
function timingOf(input: z.output<typeof createInput>): string | undefined {
  const names: Record<string, string> = {
    daily: '每天',
    weekdays: '每个工作日',
    weekly: `每周${input.weekday ?? ''}`,
    monthly: `每月 ${input.day ?? ''} 号`,
  };
  if (input.kind === 'once') return input.at?.trim().slice(5) || undefined;
  return [names[input.kind], input.time].filter(Boolean).join(' ') || undefined;
}
