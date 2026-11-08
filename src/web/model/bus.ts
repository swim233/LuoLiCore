import type { Conversation, ImagePart, MsgRow } from './types';
import type { Snap } from './status';

/* 事件总线：以后接真实的实时推送时，服务端推来的事件从这里进来，部件不用改。
   事件：
     message        {convId, row, trigger}       新消息（记录到会话）
     reply:wait     {convId, replyId, noWait}    触发，进入等待合并
     reply:queued   {convId, replyId}            回复中又被触发，发出后再回复一次（合并回复）
     reply:think    {convId, replyId}            模型开始输出思考内容
     reply:thinkEnd {convId, replyId, sec, text}
     reply:delta    {convId, replyId, text}      输出片段
     tool:start     {convId, replyId, callId, name, label}
     tool:end       {convId, replyId, callId, ok, ms, summary, image}
     reply:retry    {convId, replyId, attempt, max, status}
     reply:error    {convId, replyId, status, row}
     reply:abort    {convId, replyId, row}
     reply:end      {convId, replyId, ms, usage, row}
     bot:online / bot:offline
     conv:add {conv} / conv:remove {id} / conv:update {id} / unread {convId} / data:reset {}
     chat:switch
     status         汇总后的状态（status.ts 算出） */
type Empty = Record<string, never>;
export interface BusEvents {
  message: { convId: string; row: MsgRow | null; trigger?: boolean };
  'reply:wait': { convId: string; replyId: string; noWait?: boolean };
  'reply:queued': { convId: string; replyId: string };
  'reply:think': { convId: string; replyId: string };
  'reply:thinkEnd': { convId: string; replyId: string; sec: number; text: string };
  'reply:delta': { convId: string; replyId: string; text: string };
  'tool:start': { convId: string; replyId: string; callId: string; name: string; label?: string };
  'tool:end': {
    convId: string;
    replyId: string;
    callId: string;
    ok: boolean;
    ms: number;
    summary?: string;
    image: ImagePart | null;
  };
  'reply:retry': { convId: string; replyId: string; attempt: number; max: number; status: number };
  'reply:error': { convId: string; replyId: string; status: number; row: MsgRow | null };
  'reply:abort': { convId: string; replyId: string; row: MsgRow | null };
  'reply:end': {
    convId: string;
    replyId: string;
    ms: number;
    usage: { input: number; cache: number; output: number };
    row: MsgRow | null;
  };
  'bot:online': Empty;
  'bot:offline': Empty;
  'conv:add': { conv: Conversation };
  'conv:remove': { id: string };
  'conv:update': { id: string };
  unread: { convId: string };
  'data:reset': Empty;
  'chat:switch': Empty;
  status: Snap;
}
export type BusEventName = keyof BusEvents;
type Fn<K extends BusEventName> = (payload: BusEvents[K]) => void;
const map = new Map<BusEventName, Set<Fn<never>>>();
export const bus = {
  on<K extends BusEventName>(type: K, fn: Fn<K>) {
    if (!map.has(type)) map.set(type, new Set());
    map.get(type)!.add(fn as Fn<never>);
    return () => {
      map.get(type)!.delete(fn as Fn<never>);
    };
  },
  emit<K extends BusEventName>(type: K, payload: BusEvents[K] = {} as BusEvents[K]) {
    const set = map.get(type);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        (fn as Fn<K>)(payload);
      } catch (e) {
        console.error('[bus]', type, e);
      }
    }
  },
};
