import { useSyncExternalStore } from 'react';
import { bus } from './bus';
import type { BusEventName } from './bus';
import { db } from './db';

/* 状态汇总：八种状态。几个群同时在回复时显示最忙的状态，并给出群数（数字只由事件推出来，UI 不自己猜） */
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
export interface Snap {
  state: State;
  tool?: string;
  count: number;
  list: { id: string; title: string; state: State; tool?: string }[];
}

class Status {
  online = true;
  lastReplyAt = 0;
  lastOnlineAt = Date.now();
  conv = new Map<string, { state: State; tool?: string; replyId?: string }>();
  errTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private snap: Snap = { state: 'idle', count: 0, list: [] };

  set(convId: string, state: State, extra: { tool?: string; replyId?: string } = {}) {
    const cur = this.conv.get(convId);
    if (cur && cur.state === state && cur.tool === extra.tool) return;
    this.conv.set(convId, Object.assign({ state }, extra));
    this.emit();
  }
  clear(convId: string) {
    if (this.conv.delete(convId)) this.emit();
  }
  private compute(): Snap {
    if (!this.online) return { state: 'offline', count: 0, list: [] };
    const list = [...this.conv].map(([id, s]) => ({
      id,
      title: db.conv(id)?.title || '会话',
      state: s.state,
      tool: s.tool,
    }));
    if (!list.length) return { state: 'idle', count: 0, list };
    const state = BUSY_ORDER.find((p) => list.some((x) => x.state === p)) || 'idle';
    const tool = list.find((x) => x.state === 'tool')?.tool;
    return { state, tool, count: list.length, list };
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

bus.on('reply:wait', ({ convId }) => status.set(convId, 'waiting'));
bus.on('reply:think', ({ convId }) => status.set(convId, 'thinking'));
bus.on('reply:delta', ({ convId }) => status.set(convId, 'replying'));
bus.on('tool:start', ({ convId, name }) => status.set(convId, 'tool', { tool: name }));
bus.on('tool:end', ({ convId }) => status.set(convId, 'thinking'));
bus.on('reply:retry', ({ convId }) => status.set(convId, 'retry'));
bus.on('reply:end', ({ convId }) => {
  status.lastReplyAt = Date.now();
  status.clear(convId);
});
bus.on('reply:abort', ({ convId }) => status.clear(convId));
bus.on('reply:error', ({ convId, replyId }) => {
  status.set(convId, 'error', { replyId });
  clearTimeout(status.errTimers.get(convId));
  status.errTimers.set(
    convId,
    setTimeout(() => {
      const cur = status.conv.get(convId);
      if (cur && cur.state === 'error' && cur.replyId === replyId) status.clear(convId);
    }, 3600),
  );
});
bus.on('conv:remove', ({ id }) => status.clear(id));
bus.on('bot:offline', () => {
  status.online = false;
  status.lastOnlineAt = Date.now();
  status.conv.clear();
  status.emit();
});
bus.on('bot:online', () => {
  status.online = true;
  status.emit();
});
bus.on('data:reset', () => {
  status.conv.clear();
  status.emit();
});

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
