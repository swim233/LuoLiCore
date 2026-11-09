import type { Trigger } from '../message.js';
import type { Task, TaskChanges, TaskFilter, TaskSchedule } from './types.js';

/**
 * 任务的时间换成 toISOString 的写法（UTC）再存、再比较：到点按字符串比较，写法不一
 * （没有毫秒、带时区偏移）会比错。不是合法的时间时抛错
 */
export function isoTime(value: string): string {
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) throw new Error(`不是合法的时间：${value}`);
  return time.toISOString();
}

/**
 * 要存的 schedule：经过一次 JSON（与 SQLite 存的相同），已知种类里的时刻（一次性的 at、
 * 周期的 until）换成 isoTime 的写法；time、weekday、day 与不认识的种类原样
 */
export function normalizeSchedule(schedule: TaskSchedule): TaskSchedule {
  const copy = JSON.parse(JSON.stringify(schedule)) as TaskSchedule;
  switch (copy.kind) {
    case 'once':
      return { ...copy, at: isoTime(copy.at) };
    case 'daily':
    case 'weekdays':
    case 'weekly':
    case 'monthly':
      return copy.until === undefined ? copy : { ...copy, until: isoTime(copy.until) };
    default:
      return copy;
  }
}

/** 修改里的时间换成同一种写法；null（清掉）与没给的项原样 */
export function normalizeChanges(changes: TaskChanges): TaskChanges {
  const time = (value: string | null | undefined) =>
    value === null || value === undefined ? value : isoTime(value);
  return {
    ...changes,
    ...('nextDueAt' in changes ? { nextDueAt: time(changes.nextDueAt) } : {}),
    ...('lastDueAt' in changes ? { lastDueAt: time(changes.lastDueAt) } : {}),
    ...('endedAt' in changes ? { endedAt: time(changes.endedAt) } : {}),
  };
}

/** 任务的来源只留认得的几项，没有的项不写（与 SQLite 读回的形状一致） */
export function taskSource({ author, messageId, platformMessageId }: Trigger): Trigger {
  return {
    author: { ...(author.id === undefined ? {} : { id: author.id }), name: author.name },
    messageId,
    ...(platformMessageId === undefined ? {} : { platformMessageId }),
  };
}

/**
 * 内存存储按 TaskFilter 筛选，口径同 SQLite 的查询：已结束的（不是进行中的）只要结束时间
 * 不早于 endedSince 的。endedSince 由调用方先换成 isoTime 的写法
 */
export function matchesTask(
  task: Task,
  { conversationId, status, endedSince }: TaskFilter,
): boolean {
  return (
    (conversationId === undefined || task.conversationId === conversationId) &&
    (status === undefined || task.status === status) &&
    (endedSince === undefined ||
      task.status === 'active' ||
      (task.endedAt !== undefined && task.endedAt >= endedSince))
  );
}
