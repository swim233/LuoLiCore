import { fx } from '@luoli/ui/fx';
import type { BadgeReply, BadgeStats, Op } from './badge-msg';

/* 徽记的小画布的主线程这一头，加上和整屏星尘（库的 @luoli/ui/fx 的 fx）共用的那个 Worker。
   整屏的星空、星尘在库里（fx.worker.ts 是这个 Worker 的入口：先问徽记，再问库的 particleMessage）；这里只留徽记的部分 */
const dprOf = () => Math.min(2, window.devicePixelRatio || 1);
let fxW: Worker | null = null;
/* 星尘 Worker：整屏的星尘和徽记的小画布共用一个，由这里建好、app.tsx 交给库的 fx.start。徽记可能比整屏画布先挂上，所以谁先用谁创建 */
export function fxWorker() {
  if (!fxW) {
    fxW = new Worker(new URL('./fx.worker.ts', import.meta.url), { type: 'module' });
    fxW.onmessage = (e: MessageEvent<BadgeReply>) => {
      if (e.data.type === 'bd-stats') statsWait.splice(0).forEach((f) => f(e.data.stats));
    };
  }
  return fxW;
}
const statsWait: ((s: BadgeStats[]) => void)[] = [];
/* 徽记的小画布：每个徽记一张，交给同一个 Worker。消息的结构见 badge-msg.ts */
const badgeIds = new Set<number>();
let badgeSeq = 0;
export const badgeFx = {
  add(canvas: HTMLCanvasElement, s: number): number {
    const id = ++badgeSeq;
    badgeIds.add(id);
    const off = canvas.transferControlToOffscreen();
    fxWorker().postMessage({ type: 'bd-add', id, canvas: off, s, dpr: dprOf() }, [off]);
    return id;
  },
  del(id: number) {
    badgeIds.delete(id);
    fxW?.postMessage({ type: 'bd-del', id });
  },
  post(id: number, ops: Op[]) {
    fxW?.postMessage({ type: 'bd-do', id, ops });
  },
  /* 缩放页面、窗口换到另一个屏幕时 DPR 变了：小画布按新的 DPR 重设像素尺寸 */
  size() {
    for (const id of badgeIds) fxW?.postMessage({ type: 'bd-size', id, dpr: dprOf() });
  },
  /* 清空（看不见了、关掉动画、重建）：粒子和特效都不淡出 */
  reset(id: number) {
    fxW?.postMessage({ type: 'bd-reset', id });
  },
  /* 现有的特效淡出 */
  stop(id: number) {
    fxW?.postMessage({ type: 'bd-stop', id });
  },
  /* 时间倍率：只有开发模式的实验台会改它 */
  rate(rate: number) {
    fxW?.postMessage({ type: 'bd-rate', rate });
  },
  /* 每个徽记画了多少帧、此刻有多少粒子（检查看不见的徽记有没有在画） */
  stats(): Promise<BadgeStats[]> {
    return new Promise((res) => {
      statsWait.push(res);
      fxWorker().postMessage({ type: 'bd-stats' });
    });
  },
};
/* 窗口大小、像素比变了：整屏的星尘重设大小时（fx.size），徽记的小画布也跟着重设 */
fx.onResize(() => badgeFx.size());
(window as Window & { __badgeStats?: () => Promise<BadgeStats[]> }).__badgeStats = () =>
  badgeFx.stats();
/* DPR 变了（缩放 110%、125%，换屏）：不一定有 resize 事件，用分辨率的媒体查询盯着 */
function watchDpr() {
  const mq = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
  mq.addEventListener(
    'change',
    () => {
      badgeFx.size();
      watchDpr();
    },
    { once: true },
  );
}
watchDpr();
