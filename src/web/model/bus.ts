import type { Conversation, ImageInfo, MsgRow } from './types';
import type { Snap } from './status';
import type { LiveState } from '../../server/types';

/* 事件总线：数据层（db、status、nowModel）和部件之间的事件。服务端推来的事件由数据源转成这里的事件（live-feed.ts、sync.ts），部件不直接认服务的事件。
   事件：
     message        {convId, row, trigger}       新消息（记录到会话）
     reply:wait     {convId, replyId?, noWait, at?}  Telegram 被触发，进入等待合并（noWait：不等待）
     reply:start    {convId, replyId, at?}       回复开始
     reply:state    {convId, replyId?, state, tool?}  这个回复此刻的状态（服务给的，以它为准）
     reply:queued   {convId, replyId?}           回复中又被触发，发出后再回复一次（合并回复）
     reply:cancel   {convId}                     等待合并被放弃，不回复了
     reply:think    {convId, replyId, part?, at?}  开始一段思考
     reply:thinkEnd {convId, replyId, sec, text}   这段思考结束
     reply:delta    {convId, replyId, text, part?, at?}  输出片段（part：第几段，换了一段就是新的一行）
     tool:start     {convId, replyId, callId, name, label?, part?, at?}
     tool:end       {convId, replyId, callId, ok, ms, error?, images?}
     reply:retry    {convId, replyId, attempt, max, status?, phase?}
     reply:reset    {convId, replyId, keep}      流中途出错、重新生成：parts 只留前 keep 段，后面的行作废
     reply:error    {convId, replyId, status, message?, row?}
     reply:abort    {convId, replyId, row?}
     reply:end      {convId, replyId, ms, usage, row?}
     bot:online / bot:offline {lastOnlineAt?}    连得上、连不上 Telegram
     assistant                                   助手的名字、唤醒词变了
     conv:add {conv} / conv:remove {id} / conv:update {id} / unread {convId} / data:reset {}
     conv:messages {convId}   某个会话已取到的消息、段或加载状态变了
     today:update             今日概况有了新数据
     link                     和洛璃服务的连接状态变了
     chat:switch
     status         汇总后的状态（status.ts 算出） */
type Empty = Record<string, never>;
export interface BusEvents {
  message: { convId: string; row: MsgRow | null; trigger?: boolean };
  'reply:wait': { convId: string; replyId?: string; noWait?: boolean; at?: number };
  'reply:start': { convId: string; replyId: string; at?: number };
  'reply:state': { convId: string; replyId?: string; state: LiveState; tool?: string };
  'reply:queued': { convId: string; replyId?: string };
  'reply:cancel': { convId: string };
  'reply:think': { convId: string; replyId: string; part?: number; at?: number };
  'reply:thinkEnd': { convId: string; replyId: string; sec: number; text: string };
  'reply:delta': { convId: string; replyId: string; text: string; part?: number; at?: number };
  'tool:start': {
    convId: string;
    replyId: string;
    callId: string;
    name: string;
    label?: string;
    part?: number;
    at?: number;
  };
  'tool:end': {
    convId: string;
    replyId: string;
    callId: string;
    ok: boolean;
    ms: number;
    error?: string;
    images?: ImageInfo[];
  };
  'reply:retry': {
    convId: string;
    replyId: string;
    attempt: number;
    max: number;
    status?: number;
    phase?: 'request' | 'stream';
    at?: number;
  };
  'reply:reset': { convId: string; replyId: string; keep: number };
  'reply:error': {
    convId: string;
    replyId: string;
    status?: number;
    message?: string;
    row?: MsgRow | null;
  };
  'reply:abort': { convId: string; replyId: string; row?: MsgRow | null };
  'reply:end': {
    convId: string;
    replyId: string;
    ms: number;
    usage: { input?: number; cache?: number; output?: number };
    row?: MsgRow | null;
  };
  'bot:online': Empty;
  'bot:offline': { lastOnlineAt?: number | null };
  assistant: Empty;
  'conv:add': { conv: Conversation };
  'conv:remove': { id: string };
  'conv:update': { id: string };
  unread: { convId: string };
  'data:reset': Empty;
  'conv:messages': { convId: string };
  'today:update': Empty;
  link: Empty;
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
