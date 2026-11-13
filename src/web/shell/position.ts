import { colsNow } from '../lib/useCols';
import { clamp } from '@luoli/ui/util';
import { desk, spanOf } from '../state/desk';
import { faces } from './faces';

/* 「此刻」浮起来的位置：从胶囊的位置长出去，尽量不盖住正在操作的部件 */
export function positionFloat(el: HTMLElement) {
  const f = faces('now');
  const cap = f.cap;
  const wrapEl = document.getElementById('desk-wrap')!;
  const deskEl = document.getElementById('desk')!;
  if (!cap) return;
  const capR = cap.getBoundingClientRect(),
    wr = wrapEl.getBoundingClientRect();
  const cs = getComputedStyle(deskEl);
  const n = colsNow(),
    gap = parseFloat(cs.columnGap) || 16,
    rowH = parseFloat(cs.gridAutoRows) || 232;
  const colW = (wr.width - (n - 1) * gap) / n;
  const [c, r] = spanOf('now', n);
  const w = c * colW + (c - 1) * gap,
    ht = r * rowH + (r - 1) * gap;
  /* 页面滚过以后胶囊可能在视口外：浮起的位置放进视口里，记住它，之后重排时不再跳 */
  let top = desk.get().floatTop;
  if (top == null) {
    const topB = document.getElementById('top')!.getBoundingClientRect().bottom;
    const capOnScreen = capR.top >= topB - capR.height / 2 && capR.bottom <= window.innerHeight;
    const vTop = capOnScreen
      ? capR.top
      : clamp(capR.top, topB + 8, Math.max(topB + 8, window.innerHeight - ht - 16));
    top = vTop - wr.top;
    desk.get().floatTop = top; /* 不触发渲染：只是记住 */
  }
  const cands = [capR.left - wr.left, capR.right - wr.left - w, 0, wr.width - w].map((x) =>
    clamp(x, 0, Math.max(0, wr.width - w)),
  );
  let best = cands[0];
  const actId = desk.get().activeId;
  const act = actId && actId !== 'now' ? faces(actId).wrap : null;
  if (act && act.isConnected) {
    const ar = act.getBoundingClientRect();
    const ov = (x: number) => {
      const L = wr.left + x,
        T = wr.top + top!;
      return (
        Math.max(0, Math.min(L + w, ar.right) - Math.max(L, ar.left)) *
        Math.max(0, Math.min(T + ht, ar.bottom) - Math.max(T, ar.top))
      );
    };
    best = cands.reduce((a, b) => (ov(b) < ov(a) - 1 ? b : a));
  }
  Object.assign(el.style, {
    left: best + 'px',
    top: top + 'px',
    width: w + 'px',
    height: ht + 'px',
  });
}
/* 窄屏：胶囊在顶部正中，展开时向下长成窗口 */
export function positionIsland(el: HTMLElement) {
  const cap = faces('now').cap;
  if (!cap) return;
  const capR = cap.getBoundingClientRect();
  const vw = document.documentElement.clientWidth,
    vh = window.innerHeight;
  const w = Math.min(vw - 32, 560);
  Object.assign(el.style, {
    left: (vw - w) / 2 + 'px',
    top: Math.max(8, capR.top) + 'px',
    width: w + 'px',
    height: Math.max(240, Math.round(vh * 0.45)) + 'px',
  });
}
