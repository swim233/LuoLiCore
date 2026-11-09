import { bus } from './bus';
import type { ImageInfo } from './types';

/* 每个会话里进行中的回复的详情，从总线事件（live-feed.ts 由服务的 live 事件转来）里记下来：
   - 有没有进行中的回复（包括等着补的那次）：对话部件的「中止」按钮、发送按钮的状态看它，几个标签页一致；
   - 排队：网页会话生成中又发了消息，排队的消息从第几条起（queuedFrom），对话里这些消息标「排队中」；
   - 思考用了几秒、工具的一句话摘要与耗时、工具结果里的图片：服务端打的时间和算出的摘要。
     自己这个标签页里正在逐字出的那条回复，对话里的气泡用它们（流里没有这些）；回复写入历史后，气泡改用历史消息里的同样的数据。
   回复结束后详情留着，到这个会话的下一次回复开始才清掉。 */
export interface ToolLive {
  part?: number;
  summary?: string;
  ms?: number;
  ok?: boolean;
  error?: string;
  images?: ImageInfo[];
}
export interface ReplyEntry {
  /** 回复进行中（含排队等着补的那次） */
  active: boolean;
  replyId?: string;
  /** 思考，按出现的顺序；part 是服务现场里的下标 */
  reasonings: { part: number; sec?: number }[];
  tools: Map<string, ToolLive>;
  /** 排队的消息从这个序号起（还没被回复看到） */
  queuedFrom?: number;
}

const entries = new Map<string, ReplyEntry>();
const fresh = (): ReplyEntry => ({ active: true, reasonings: [], tools: new Map() });
const touch = (convId: string) => {
  let e = entries.get(convId);
  if (!e) entries.set(convId, (e = fresh()));
  else e.active = true;
  return e;
};
const changed = (convId: string) => bus.emit('reply:info', { convId });

bus.on('reply:wait', ({ convId }) => {
  touch(convId);
  changed(convId);
});
bus.on('reply:start', ({ convId, replyId, queuedFrom }) => {
  const e: ReplyEntry = { ...fresh(), replyId, queuedFrom };
  entries.set(convId, e);
  changed(convId);
});
bus.on('reply:queued', ({ convId, queuedFrom }) => {
  const e = touch(convId);
  if (queuedFrom !== undefined) e.queuedFrom = queuedFrom;
  changed(convId);
});
bus.on('reply:dequeue', ({ convId }) => {
  const e = entries.get(convId);
  if (!e) return;
  delete e.queuedFrom;
  changed(convId);
});
bus.on('reply:think', ({ convId, part }) => {
  const e = touch(convId);
  e.reasonings.push({ part: part ?? e.reasonings.length });
  changed(convId);
});
bus.on('reply:thinkEnd', ({ convId, sec }) => {
  const e = entries.get(convId);
  const open = e?.reasonings.findLast((r) => r.sec === undefined);
  if (!e || !open) return;
  open.sec = sec;
  changed(convId);
});
bus.on('tool:start', ({ convId, callId, summary, part }) => {
  const e = touch(convId);
  e.tools.set(callId, { part, summary });
  changed(convId);
});
bus.on('tool:end', ({ convId, callId, ok, ms, error, images, summary }) => {
  const e = touch(convId);
  const t = e.tools.get(callId) ?? {};
  e.tools.set(callId, { ...t, ok, ms, error, images, summary: summary ?? t.summary });
  changed(convId);
});
// 流中途出错、重新生成：这一步已有的内容作废，只留前 keep 段
bus.on('reply:reset', ({ convId, keep }) => {
  const e = entries.get(convId);
  if (!e) return;
  e.reasonings = e.reasonings.filter((r) => r.part < keep);
  for (const [id, t] of e.tools) if (t.part !== undefined && t.part >= keep) e.tools.delete(id);
  changed(convId);
});
const ended = ({ convId }: { convId: string }) => {
  const e = entries.get(convId);
  if (!e) return;
  e.active = false;
  delete e.queuedFrom;
  changed(convId);
};
bus.on('reply:end', ended);
bus.on('reply:abort', ended);
bus.on('reply:error', ended);
bus.on('reply:cancel', ({ convId }) => {
  if (!entries.delete(convId)) return;
  changed(convId);
});

export const replyInfo = {
  /** 这个会话有进行中的回复（含排队等着补的那次） */
  active: (convId: string | null | undefined) => !!convId && !!entries.get(convId)?.active,
  /** 排队的消息从第几条起；没有排队时为 undefined */
  queuedFrom: (convId: string | null | undefined) =>
    convId ? entries.get(convId)?.queuedFrom : undefined,
  details: (convId: string | null | undefined) => (convId ? entries.get(convId) : undefined),
  /** 按服务的现场校正（连上、重连时）：现场里没有的会话，回复已经结束了（断开期间结束的） */
  reconcile(live: Set<string>) {
    for (const [id, e] of entries)
      if (!live.has(id) && e.active) {
        e.active = false;
        delete e.queuedFrom;
        changed(id);
      }
  },
  /** 全部清掉（开发模式切换数据） */
  reset() {
    entries.clear();
  },
};
