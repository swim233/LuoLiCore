import type { ApiMessage, MessagePreview, TaskBrief } from './types';

/* 事件：洛璃服务写进会话的、没有发言人的消息（任务到点、任务超时、监视到点、监视查不到）。
   认它只看 message.metadata.event，不能按「没有 author」判断：网页会话里发言人没有 uid，但有名字。
   时间线里不画成气泡，是居中的一行灰字；会话列表的预览、「此刻」也用同一句 */
export type EventType = NonNullable<MessagePreview['event']>;

const LABEL: Record<EventType, string> = {
  task: '任务到点',
  'task-missed': '任务超时',
  monitor: '监视到点',
  'monitor-failed': '监视查不到',
};

/** 这条消息是事件的话，它的类型 */
export const eventOf = (row: ApiMessage): EventType | undefined =>
  row.message.metadata?.event?.type;

/** 事件正文的第一句，开头的「任务到点：」换成「任务到点 · 」。任务已经不在了、预览里只有正文开头一截时用它 */
export function firstSentence(type: EventType, body: string): string {
  const head = body.split(/[。！？\n]/)[0].trim();
  let rest = head.replace(/^(任务到点|任务超时|监视到点|监视查不到)[:：]\s*/, '');
  // 任务超时的正文在做什么后面跟一句括号里的说明（「（本该 11-10 09:00 到点，那时……）」「（每天 08:00；超时 3 次，……）」），
  // 预览、一行字只要做什么。预览只有开头一截时括号可能没写完，所以从这一句最后一个「（」起去掉，且只认说明开头的写法
  if (type === 'task-missed') {
    const i = rest.lastIndexOf('（');
    if (i > 0 && /^（(本该|每|周期任务)/.test(rest.slice(i))) rest = rest.slice(0, i);
  }
  return `${LABEL[type]} · ${rest}`;
}

/** 事件的一行字：任务到点是「任务到点 · 做什么」，任务超时周期的前面再加周期（一次性的没有）。拼不出来用正文的第一句 */
export function eventLine(type: EventType, task: TaskBrief | undefined, body: string): string {
  if (!task) return firstSentence(type, body);
  const what =
    type === 'task-missed' && task.scheduleText !== '一次性'
      ? `${task.scheduleText} ${task.action}`
      : task.action;
  return `${LABEL[type]} · ${what}`;
}
