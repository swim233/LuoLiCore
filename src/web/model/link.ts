import { bus } from './bus';
import { createStore, useStore } from '@luoli/ui/store';

/* 和洛璃服务的连接：loading（第一次的数据还没到）、ready、down（连不上，会自动重连，连上后恢复）。
   开发模式的模拟数据源始终是 ready */
export type LinkPhase = 'loading' | 'ready' | 'down';
export const link = createStore<{ phase: LinkPhase }>({ phase: 'ready' });

export function setLink(phase: LinkPhase) {
  if (link.get().phase === phase) return;
  link.set({ phase });
  bus.emit('link');
}
export const useLinkPhase = () => useStore(link, (s) => s.phase);
