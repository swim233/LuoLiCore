import { daysFromToday, fmtClockIn, fmtDateTime, fmtWhen } from '../lib/zone';
import { db } from './db';
import type { TaskMonitor, TaskRow } from './types';

/* 任务：从 db 里取出来给任务部件、全屏会话的头部用。数据是服务给的那一行（TaskRow），按 id 放在 db.tasks 里，
   服务每次推 task 事件整行替换（sync.ts 的 applyTask）。时间都按服务器的时区显示（今日概况里的 timeZone） */

/** 已结束的只列最近这么多天里结束的（和服务给的一样；页面开得久了，旧的自己掉出去） */
const ENDED_DAYS = 30;

export const serverZone = () => db.today?.timeZone || undefined;

/** 取到任务了（没取到、取失败时界面不显示任务：任务部件写原因，全屏头部不显示任务数；见 db.taskLoad） */
export const tasksReady = () => db.taskLoad.state === 'ready';
/** 取任务失败时给人看的说法：接口是 404 说明服务的版本比网页旧；detail 是失败的原因（旧版本不用写） */
export function tasksProblem(): { title: string; detail?: string } | null {
  const load = db.taskLoad;
  if (load.state !== 'error') return null;
  if (load.status === 404) return { title: '核心服务版本过旧，请重启服务' };
  return { title: '获取任务时出错', detail: load.message };
}

const due = (t: TaskRow) => (t.nextDueAt ? Date.parse(t.nextDueAt) : Infinity);
const ended = (t: TaskRow) => (t.endedAt ? Date.parse(t.endedAt) : 0);

/** 进行中的任务，按下次到点排（没有的排在最后）；convId：只要这个会话的 */
export function activeTasks(convId?: string): TaskRow[] {
  return [...db.tasks.values()]
    .filter((t) => t.status === 'active' && (!convId || t.conversation.id === convId))
    .sort((a, b) => due(a) - due(b) || a.id - b.id);
}

/** 最近 30 天里完成和取消的任务，结束得晚的在前 */
export function endedTasks(now = Date.now()): TaskRow[] {
  const since = now - ENDED_DAYS * 864e5;
  return [...db.tasks.values()]
    .filter((t) => t.status !== 'active' && ended(t) >= since)
    .sort((a, b) => ended(b) - ended(a) || b.id - a.id);
}

export interface TaskGroup {
  conv: TaskRow['conversation'];
  tasks: TaskRow[];
}
/** 按会话分组：组按组里最近的下次到点排，组内也按下次到点排 */
export function groupTasks(tasks: TaskRow[]): TaskGroup[] {
  const groups = new Map<string, TaskGroup>();
  for (const t of tasks) {
    let g = groups.get(t.conversation.id);
    if (!g) groups.set(t.conversation.id, (g = { conv: t.conversation, tasks: [] }));
    g.tasks.push(t);
  }
  return [...groups.values()].sort((a, b) => due(a.tasks[0]) - due(b.tasks[0]));
}

/** 怎么结束的：一次性任务正常到点、超时都是 done，到点次数为 0、没有上次到点的是超时结束的 */
export type EndKind = 'done' | 'missed' | 'cancelled';
export function endKind(t: TaskRow): EndKind | null {
  if (t.status === 'cancelled') return 'cancelled';
  if (t.status === 'done') return t.dueCount === 0 && !t.lastDueAt ? 'missed' : 'done';
  return null;
}
export const END_TEXT: Record<EndKind, string> = {
  done: '已完成',
  missed: '已超时',
  cancelled: '已取消',
};

/** 周期：一次性的服务只给「一次性」，补上时刻（「一次性 · 11-10 09:00」）；周期的用服务给的那句人话 */
export function scheduleLine(t: TaskRow, tz = serverZone()): string {
  if (t.schedule.kind === 'once') return `一次性 · ${fmtDateTime(Date.parse(t.schedule.at), tz)}`;
  return t.scheduleText;
}

/* ---------- 监听任务（ADR-0014）：没有下次到点，右边放检查的情况；展开能看服务写成人话的几行、检查的情况、到点的次数、描述原文 ---------- */

/** 上次检查的情况：还没查过、查得通（上次查通的时刻）、现在查不到（从什么时候起、最近一次的原因）。
    服务给的 failing 优先：查不到时 lastCheckedAt 也是最近那次失败的检查，不能当成「查得通」 */
export type CheckState =
  | { kind: 'never' }
  | { kind: 'ok'; at: number }
  | { kind: 'failing'; since: number; reason: string };

export function checkState(m: TaskMonitor): CheckState {
  if (m.failing)
    return { kind: 'failing', since: Date.parse(m.failing.since), reason: m.failing.reason };
  const at = m.lastCheckedAt ?? m.lastSuccessAt;
  return at ? { kind: 'ok', at: Date.parse(at) } : { kind: 'never' };
}

/** 现在查不到的监听任务有几个（只数进行中的） */
export const failingCount = (list: TaskRow[]) =>
  list.filter((t) => t.status === 'active' && t.monitor?.failing).length;

/** 行右边的一小格：「上次执行 21:38」（今天只写时刻，别的天带日期）、「尚未执行」、「执行失败」。hint 是悬停的说明 */
export function checkBrief(
  m: TaskMonitor,
  tz = serverZone(),
  now = Date.now(),
): { kind: CheckState['kind']; text: string; hint: string } {
  const st = checkState(m);
  if (st.kind === 'failing')
    return {
      kind: 'failing',
      text: '执行失败',
      hint: `自 ${fmtDateTime(st.since, tz, now)} 起执行失败：${st.reason}`,
    };
  if (st.kind === 'never') return { kind: 'never', text: '尚未执行', hint: '此任务尚未执行' };
  const when =
    daysFromToday(st.at, tz, now) === 0 ? fmtClockIn(st.at, tz) : fmtWhen(st.at, tz, now);
  return { kind: 'ok', text: `上次执行 ${when}`, hint: '上次执行的时间' };
}

/** 展开里检查情况那一句 */
export function checkSentence(m: TaskMonitor, tz = serverZone(), now = Date.now()): string {
  const st = checkState(m);
  if (st.kind === 'failing') return `自 ${fmtDateTime(st.since, tz, now)} 起执行失败：${st.reason}`;
  if (st.kind === 'never') return '尚未执行';
  return `上次执行 ${fmtDateTime(st.at, tz, now)}，正常`;
}

/** 展开里到点次数那一句；一次都没到过点时没有 */
export function dueSentence(t: TaskRow, tz = serverZone(), now = Date.now()): string | null {
  if (t.dueCount <= 0) return null;
  const last = t.lastDueAt ? `，上次触发 ${fmtDateTime(Date.parse(t.lastDueAt), tz, now)}` : '';
  return `触发 ${t.dueCount} 次${last}`;
}

/** 描述原文：排好版的 JSON */
export const descriptionText = (m: TaskMonitor) => JSON.stringify(m.description, null, 2);

/** 胶囊：「当前有 3 个任务 · 下一个 09:00」，下一个不在今天时写日期；有执行失败的监听任务时后面加「 · 1 个执行失败」；没有任务写「当前没有任务」 */
export function tasksThumb(now = Date.now()): string {
  const problem = tasksProblem();
  if (problem) return problem.title;
  const list = activeTasks();
  if (!list.length) return '当前没有任务';
  const bad = failingCount(list);
  const tail = bad ? ` · ${bad} 个执行失败` : '';
  const next = list[0].nextDueAt ? Date.parse(list[0].nextDueAt) : 0;
  if (!next) return `当前有 ${list.length} 个任务${tail}`;
  const tz = serverZone();
  const when =
    daysFromToday(next, tz, now) === 0 ? fmtClockIn(next, tz) : fmtDateTime(next, tz, now);
  return `当前有 ${list.length} 个任务 · 下一个 ${when}${tail}`;
}
