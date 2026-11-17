import type { ApiMessage, MessagePreview, TaskBrief } from './types';
import type { LiveTask } from '../../server/types';

/* 事件：洛璃服务写进会话的、没有发言人的消息（任务触发、任务超时、监听触发、监听失败）。
   认它只看 message.metadata.event，不能按「没有 author」判断：网页会话里发言人没有 uid，但有名字。
   时间线里不画成气泡，是居中的一行灰字；会话列表的预览、「此刻」也用同一句 */
export type EventType = NonNullable<MessagePreview['event']>;

const LABEL: Record<EventType, string> = {
  task: '任务触发',
  'task-missed': '任务超时',
  monitor: '监听触发',
  'monitor-failed': '监听失败',
};

/** 这条消息是事件的话，它的类型 */
export const eventOf = (row: ApiMessage): EventType | undefined =>
  row.message.metadata?.event?.type;

/** 点一下能展开正文的事件：监视查到的东西、查不到的原因（正文可能有几千个字，不放进悬停的说明）。
    任务触发、任务超时的正文只有一两句，照旧悬停看 */
export const hasFoldedBody = (type: EventType): boolean =>
  type === 'monitor' || type === 'monitor-failed';

/** 「此刻」里标出一个触发的任务：「任务触发 · 做什么」；监视任务按服务给的 event 写「监听触发 · …」「监听失败 · …」 */
export function liveTaskLine(t: Pick<LiveTask, 'action' | 'event'>): string {
  return `${LABEL[t.event ?? 'task']} · ${t.action}`;
}

/* 事件正文开头的前缀。数据库里以前写下的事件正文永远是旧的前缀（任务到点、监视到点、监视查不到），
   新写的是新的（任务触发、监听触发、监听失败），所以两套都认 */
const BODY_PREFIX = /^(任务到点|任务触发|任务超时|监视到点|监听触发|监视查不到|监听失败)[:：]\s*/;
/* 任务超时的正文在做什么后面跟一句括号里的说明，开头的写法旧的是「（本该」「（每」「（周期任务」，新的是「（原定」，同样两套都认 */
const MISSED_NOTE = /^（(本该|原定|每|周期任务)/;

/** 事件正文的第一句，开头的「任务触发：」换成「任务触发 · 」。任务已经不在了、预览里只有正文开头一截时用它 */
export function firstSentence(type: EventType, body: string): string {
  const head = body.split(/[。！？\n]/)[0].trim();
  let rest = head.replace(BODY_PREFIX, '');
  // 任务超时的正文在做什么后面跟一句括号里的说明（「（原定 11-15 09:00 触发，当时核心服务未运行）」「（每天 08:00；超时 3 次，……）」），
  // 预览、一行字只要做什么。预览只有开头一截时括号可能没写完，所以从这一句最后一个「（」起去掉，且只认说明开头的写法
  if (type === 'task-missed') {
    const i = rest.lastIndexOf('（');
    if (i > 0 && MISSED_NOTE.test(rest.slice(i))) rest = rest.slice(0, i);
  }
  return `${LABEL[type]} · ${rest}`;
}

/** 事件的一行字：任务触发是「任务触发 · 做什么」，任务超时周期的前面再加周期（一次性的没有）。拼不出来用正文的第一句 */
export function eventLine(type: EventType, task: TaskBrief | undefined, body: string): string {
  if (!task) return firstSentence(type, body);
  const what =
    type === 'task-missed' && task.scheduleText !== '一次性'
      ? `${task.scheduleText} ${task.action}`
      : task.action;
  return `${LABEL[type]} · ${what}`;
}
