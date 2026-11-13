import { useSyncExternalStore } from 'react';
import { bus } from './bus';
import type { BusEventName } from './bus';
import { fmtTime } from '@luoli/ui/util';
import { db } from './db';

/* 状态汇总：八种状态。几个会话同时在回复时显示最忙的状态，并给出会话数（数字只由事件推出来，UI 不自己猜）。
   每个会话的状态以服务给的为准（reply:state，数据源按 live 事件里的 state 发）；wait、think、delta 这些事件里也各自带着，
   给「对话」部件在开发模式里自己发的事件用 */
export type State =
  'offline' | 'idle' | 'waiting' | 'thinking' | 'replying' | 'tool' | 'retry' | 'error';
export const STATE_TEXT: Record<State, string> = {
  offline: '离线',
  idle: '空闲',
  waiting: '等待合并',
  thinking: '思考中',
  replying: '回复中',
  tool: '调用工具',
  retry: '重试中',
  error: '出错',
};
const BUSY_ORDER: State[] = ['error', 'retry', 'tool', 'replying', 'thinking', 'waiting'];
/** 一个会话是怎么离开「进行中」的：正常完成、中止、等待被放弃、出错后的 3.6 秒到了、别的原因（会话被删） */
export type EndKind = 'end' | 'abort' | 'cancel' | 'error' | 'removed';
export interface Snap {
  state: State;
  tool?: string;
  count: number;
  list: { id: string; title: string; state: State; tool?: string }[];
  /** 启动了 Telegram 前端。没启动时显示「空闲」，弹出框里写「Telegram 服务未启动」 */
  tgEnabled: boolean;
  /** 最近一个离开进行中的会话是怎么结束的（徽记靠它判断：最后一个会话正常完成才闪一下）；还没有过为 null */
  ended: EndKind | null;
}

class Status {
  /** 连得上 Telegram。没启动 Telegram 时不算离线（true） */
  online = true;
  /** 启动了 Telegram 前端 */
  tgEnabled = true;
  /** 上次回复的时间；没有过为 0 */
  lastReplyAt = 0;
  /** 上次回复在哪个会话 */
  lastReplyConv: string | null = null;
  /** 上次连上 Telegram 的时间；这次启动后没连上过为 null */
  lastOnlineAt: number | null = Date.now();
  conv = new Map<string, { state: State; tool?: string; replyId?: string }>();
  errTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** 最近一次 clear 是怎么结束的 */
  private lastEnd: EndKind | null = null;
  private snap: Snap = { state: 'idle', count: 0, list: [], tgEnabled: true, ended: null };

  set(convId: string, state: State, extra: { tool?: string; replyId?: string } = {}) {
    const cur = this.conv.get(convId);
    if (cur && cur.state === state && cur.tool === extra.tool) return;
    this.conv.set(convId, Object.assign({ state }, extra));
    this.emit();
  }
  clear(convId: string, how: EndKind = 'removed') {
    if (this.conv.delete(convId)) {
      this.lastEnd = how;
      this.emit();
    }
  }
  setLastReply(convId: string | null, at: number) {
    this.lastReplyConv = convId;
    this.lastReplyAt = at;
  }
  /** 各会话的状态全部清掉（开发模式切换数据） */
  reset() {
    for (const t of this.errTimers.values()) clearTimeout(t);
    this.errTimers.clear();
    this.conv.clear();
    this.lastEnd = null;
    this.emit();
  }
  private compute(): Snap {
    const tgEnabled = this.tgEnabled;
    const ended = this.lastEnd;
    if (!this.online) return { state: 'offline', count: 0, list: [], tgEnabled, ended };
    const list = [...this.conv].map(([id, s]) => ({
      id,
      title: db.conv(id)?.title || '会话',
      state: s.state,
      tool: s.tool,
    }));
    if (!list.length) return { state: 'idle', count: 0, list, tgEnabled, ended };
    const state = BUSY_ORDER.find((p) => list.some((x) => x.state === p)) || 'idle';
    const tool = list.find((x) => x.state === 'tool')?.tool;
    return { state, tool, count: list.length, list, tgEnabled, ended };
  }
  snapshot() {
    return this.snap;
  }
  emit() {
    this.snap = this.compute();
    bus.emit('status', this.snap);
  }
}
export const status = new Status();

bus.on('reply:wait', ({ convId, replyId }) => status.set(convId, 'waiting', { replyId }));
bus.on('reply:start', ({ convId, replyId }) => status.set(convId, 'thinking', { replyId }));
bus.on('reply:state', ({ convId, replyId, state, tool }) =>
  status.set(convId, state, { tool, replyId }),
);
bus.on('reply:think', ({ convId }) => status.set(convId, 'thinking'));
bus.on('reply:delta', ({ convId }) => status.set(convId, 'replying'));
bus.on('tool:start', ({ convId, name }) => status.set(convId, 'tool', { tool: name }));
bus.on('tool:end', ({ convId }) => status.set(convId, 'thinking'));
bus.on('reply:retry', ({ convId }) => status.set(convId, 'retry'));
bus.on('reply:end', ({ convId }) => {
  status.lastReplyAt = Date.now();
  status.lastReplyConv = convId;
  status.clear(convId, 'end');
});
bus.on('reply:abort', ({ convId }) => status.clear(convId, 'abort'));
bus.on('reply:cancel', ({ convId }) => status.clear(convId, 'cancel'));
bus.on('reply:error', ({ convId, replyId }) => {
  status.set(convId, 'error', { replyId });
  clearTimeout(status.errTimers.get(convId));
  status.errTimers.set(
    convId,
    setTimeout(() => {
      const cur = status.conv.get(convId);
      if (cur && cur.state === 'error' && cur.replyId === replyId) status.clear(convId, 'error');
    }, 3600),
  );
});
bus.on('conv:remove', ({ id }) => status.clear(id));
/* 连不上 Telegram：显示离线。各会话的状态不清掉（网页、CLI 的回复照样在进行，事件会继续更新它们） */
bus.on('bot:offline', (p) => {
  status.online = false;
  status.lastOnlineAt = p && 'lastOnlineAt' in p ? (p.lastOnlineAt ?? null) : Date.now();
  status.emit();
});
bus.on('bot:online', () => {
  status.online = true;
  status.emit();
});
/* 会话列表整批换了、会话改名：标题变了，重算一次（各会话的状态不动） */
bus.on('data:reset', () => status.emit());
bus.on('conv:add', () => status.conv.size && status.emit());
bus.on('conv:update', () => status.conv.size && status.emit());

/** 离线时的说明：上次连上 Telegram 的时间；这次启动后还没连上过就这么说 */
export function lastOnlineText(): string {
  return status.lastOnlineAt ? '上次在线 ' + fmtTime(status.lastOnlineAt) : '这次启动后还没连上过';
}

/* React：订阅汇总后的状态（快照在 emit 时才重算，引用稳定） */
export const subscribeStatus = (fn: () => void) => bus.on('status', fn);
export const useStatus = () => useSyncExternalStore(subscribeStatus, () => status.snapshot());
/* 订阅某个总线事件时，按事件序号触发重渲染（thumb 之类由数据算出的文字用） */
export function useBusTick(types: BusEventName[]) {
  return useSyncExternalStore(
    (fn) => {
      const offs = types.map((t) => bus.on(t, fn));
      return () => offs.forEach((f) => f());
    },
    () => db.rev,
  );
}
