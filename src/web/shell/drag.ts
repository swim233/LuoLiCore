import { animate } from 'motion';
import { EASE_OUT } from '@luoli/ui/easing';
import { motionOn } from '@luoli/ui/motion';
import { desk, spanOf } from '../state/desk';
import { hideWidget, placeBefore, unhideWidget } from '../state/actions';
import { ui } from '../state/ui';
import { realignSky } from '../components/bubble-sky';
import { markBusy } from './morph';
import { faces } from './faces';
import { chooseOrder, flowWrap, packDense } from './dragLayout';
import type { Pt, Size } from './dragLayout';

/* 整理模式的拖动换位。鼠标：按下卡片任意处（除了尺寸按钮和「×」）拖；触屏：卡片只认拖动柄，胶囊整个可拖。
   移动超过 6px 才算拖动：原位置变成占位（半透明、虚线边），一个副本跟着指针走（放大 1.03 倍，金色阴影和边框）；
   往哪里换位：不看指针下面「现在」是哪张卡（那是动画途中的位置，让位的卡片滑过指针会再触发一次换位，来回不停），
   而是看卡片排好以后的位置：量出指针所在的格子（胶囊那一排是像素位置），把被拖的部件放到「排好以后能盖住指针」的位置，算法在 dragLayout.ts；
   换位用 placeBefore（其他部件由 Motion 的 layout 动画让位）；
   「放到最后」（指针在最后一行的空白格、网格下沿一小条里）要停够 END_DWELL 才算，路过不算：往收纳盒拖时会经过这些地方；
   放下：副本用 260 ms 飞回占位的位置；拖到收纳盒上放下：先放回拖动开始时的位置再收进收纳盒（路上换过位也不改顺序）；
   从收纳盒里拖出来放到桌面上：放回去。 */
let justDragged = false;
export const wasDragged = () => justDragged;
const inRect = (r: DOMRect, x: number, y: number) =>
  x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;

/* 从收纳盒里拖出来放下时，指针下面的部件（这时桌面是静止的，没有让位的动画） */
function hitTest(x: number, y: number, id: string) {
  for (const el of document.elementsFromPoint(x, y)) {
    const w = el.closest('.desk > .w, .shelf > .cap-wrap') as HTMLElement | null;
    if (!w) continue;
    return w.dataset.id === id ? null : w.dataset.id!;
  }
  return null;
}

/* 指针停在「最后面」的空白处这么多毫秒，才把被拖的部件放到最后 */
const END_DWELL = 300;
/* 指针在两格交界处、抖一两像素就换了格子：现在的排布盖住指针这么多像素以内的点，就不动 */
const STICKY = 6;
const around = (x: number, y: number): [number, number][] => [
  [x + STICKY, y],
  [x - STICKY, y],
  [x, y + STICKY],
  [x, y - STICKY],
];
const num = (v: string) => (Number.isFinite(parseFloat(v)) ? parseFloat(v) : 0);
const tracks = (v: string) => v.split(/\s+/).map(parseFloat).filter(Number.isFinite);
/* 第几条轨道（轨道之间隔着 gap）；落在缝里是 -1 */
function trackAt(v: number, sizes: number[], gap: number) {
  let s = 0;
  for (let i = 0; i < sizes.length; i++) {
    if (v >= s && v < s + sizes[i]) return i;
    s += sizes[i] + gap;
  }
  return -1;
}

/* 桌面网格的量法：列数、每列每行的宽高、缝，都取自浏览器排好的样式（grid-template-columns、grid-template-rows 的计算值，
   含隐式的行），所以和 CSS 里的媒体查询（几列）、行高对得上。动画不影响它：量的是网格的轨道，不是卡片 */
function deskGeometry(grid: HTMLElement) {
  const cs = getComputedStyle(grid);
  const cols = tracks(cs.gridTemplateColumns),
    rows = tracks(cs.gridTemplateRows);
  const gx = num(cs.columnGap),
    gy = num(cs.rowGap);
  const r = grid.getBoundingClientRect();
  const left = r.left + num(cs.borderLeftWidth) + num(cs.paddingLeft);
  const top = r.top + num(cs.borderTopWidth) + num(cs.paddingTop);
  const width = cols.reduce((a, b) => a + b, 0) + gx * Math.max(0, cols.length - 1);
  const height = rows.reduce((a, b) => a + b, 0) + gy * Math.max(0, rows.length - 1);
  /* 最后一行下面这么高的一条算「网格下面」：再往下（比如往收纳盒去的路上）不算 */
  const strip = (rows.at(-1) ?? 0) / 2;
  /* 指针所在的格子（格子单位，取格子中间）；在缝里、在网格左右、上面、网格下面一条之外：null；在网格下面一条里：y 为无穷大 */
  const at = (x: number, y: number): Pt | null => {
    if (!cols.length || x < left || x >= left + width || y < top) return null;
    if (y >= top + height) return y < top + height + strip ? { x: 0, y: Infinity } : null;
    const c = trackAt(x - left, cols, gx),
      rr = trackAt(y - top, rows, gy);
    return c < 0 || rr < 0 ? null : { x: c + 0.5, y: rr + 0.5 };
  };
  return { cols: cols.length, at };
}

function planCards(x: number, y: number, id: string, end: boolean): string[] | null {
  const grid = document.getElementById('desk');
  if (!grid) return null;
  const geo = deskGeometry(grid);
  const point = geo.at(x, y);
  if (!point) return null;
  const order = [...grid.children]
    .filter((el): el is HTMLElement => el.matches('.w'))
    .map((el) => el.dataset.id!);
  const spans = new Map(order.map((i) => [i, spanOf(i, geo.cols)] as const));
  return chooseOrder({
    order,
    dragged: id,
    layout: (o) =>
      packDense(
        geo.cols,
        o.map((i) => spans.get(i)!),
      ),
    point,
    near: around(x, y)
      .map(([nx, ny]) => geo.at(nx, ny))
      .filter((p): p is Pt => !!p),
    end,
  });
}

/* 胶囊那一排（flex-wrap）：量每个胶囊的大小、这一排的宽度和缝，按「放不下就换行」排一遍。位置是相对这一排左上角的像素 */
function planCaps(x: number, y: number, id: string, end: boolean): string[] | null {
  const shelf = document.getElementById('shelf');
  if (!shelf) return null;
  const r = shelf.getBoundingClientRect();
  if (x < r.left || x > r.right || y < r.top || y > r.bottom) return null;
  const cs = getComputedStyle(shelf);
  const caps = [...shelf.children].filter((el): el is HTMLElement => el.matches('.cap-wrap'));
  const order = caps.map((el) => el.dataset.id!);
  const sizes = new Map<string, Size>(
    caps.map((el) => {
      const b = el.getBoundingClientRect();
      return [el.dataset.id!, { w: b.width, h: b.height }];
    }),
  );
  const gx = num(cs.columnGap),
    gy = num(cs.rowGap);
  return chooseOrder({
    order,
    dragged: id,
    layout: (o) =>
      flowWrap(
        r.width,
        gx,
        gy,
        o.map((i) => sizes.get(i)!),
      ),
    point: { x: x - r.left, y: y - r.top },
    near: around(x, y).map(([nx, ny]) => ({ x: nx - r.left, y: ny - r.top })),
    end,
  });
}

export function dragStart(
  ev: React.PointerEvent | PointerEvent,
  id: string,
  kind: 'card' | 'cap' | 'tray',
) {
  const e0 = 'nativeEvent' in ev ? ev.nativeEvent : ev;
  if (!desk.get().arranging || e0.button !== 0) return;
  const target = e0.target as Element;
  if (target.closest('.chip, .cap-x')) return;
  /* 触屏上卡片只认拖动柄，其余地方留给页面滚动 */
  if (e0.pointerType === 'touch' && kind === 'card' && !target.closest('.w-grip')) return;
  const f = faces(id);
  const src = (
    kind === 'card' ? f.wrap : kind === 'cap' ? f.cap : (e0.currentTarget as HTMLElement)
  ) as HTMLElement | null;
  if (!src) return;
  const sx = e0.clientX,
    sy = e0.clientY,
    pid = e0.pointerId;
  let dragging = false,
    clone: HTMLElement | null = null,
    offX = 0,
    offY = 0,
    lastX = sx,
    lastY = sy,
    endSince: number | null = null,
    endTimer: ReturnType<typeof setTimeout> | undefined;
  /* 拖动开始时它在完整顺序里排在谁的前面（null：在最后）：拖进收纳盒时先放回这里 */
  const order0 = desk.get().layout.order;
  const orderNext = order0[order0.indexOf(id) + 1] ?? null;
  e0.preventDefault();
  const tray = document.getElementById('tray')!;
  function begin() {
    const r = src!.getBoundingClientRect();
    offX = sx - r.left;
    offY = sy - r.top;
    clone = src!.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
    clone.classList.remove('is-active', 'is-float', 'is-island');
    clone.removeAttribute('data-dragging');
    clone.classList.add('drag-clone');
    clone.style.cssText = `left:0;top:0;width:${r.width}px;height:${r.height}px;transform:translate(${r.left}px,${r.top}px)`;
    document.body.append(clone);
    realignSky(clone);
    if (kind !== 'tray') src!.setAttribute('data-dragging', '');
  }
  const cancelEnd = () => {
    endSince = null;
    clearTimeout(endTimer);
  };
  /* 按指针现在的位置换位。「放到最后」不立刻做：指针在最后面的空白处停够 END_DWELL（到时由定时器再算一次）才放 */
  function reorder() {
    const plan = kind === 'card' ? planCards : planCaps;
    const place = (next: string[]) => placeBefore(id, next[next.indexOf(id) + 1] ?? null);
    const next = plan(lastX, lastY, id, false);
    if (next) {
      cancelEnd();
      place(next);
      return;
    }
    const atEnd = plan(lastX, lastY, id, true);
    if (!atEnd) return cancelEnd();
    if (endSince === null) {
      endSince = performance.now();
      endTimer = setTimeout(() => dragging && reorder(), END_DWELL);
    } else if (performance.now() - endSince >= END_DWELL - 8) {
      cancelEnd();
      place(atEnd);
    }
  }
  const move = (e: PointerEvent) => {
    if (e.pointerId !== pid) return;
    if (!dragging) {
      if (Math.hypot(e.clientX - sx, e.clientY - sy) < 6) return;
      dragging = true;
      begin();
    }
    clone!.style.transform = `translate(${e.clientX - offX}px, ${e.clientY - offY}px) scale(1.03)`;
    const overTray = kind !== 'tray' && inRect(tray.getBoundingClientRect(), e.clientX, e.clientY);
    if (ui.get().trayOver !== overTray) ui.set({ trayOver: overTray });
    if (overTray || kind === 'tray') return cancelEnd();
    lastX = e.clientX;
    lastY = e.clientY;
    reorder();
  };
  const up = (e: PointerEvent) => {
    if (e.pointerId !== pid) return;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    cancelEnd();
    if (!dragging) return;
    justDragged = true;
    setTimeout(() => {
      justDragged = false;
    }, 0);
    ui.set({ trayOver: false });
    if (kind !== 'tray') src!.removeAttribute('data-dragging');
    const overTray = kind !== 'tray' && inRect(tray.getBoundingClientRect(), e.clientX, e.clientY);
    if (overTray) {
      clone!.remove();
      hideWidget(id, orderNext);
      return;
    }
    if (kind === 'tray') {
      const hit = hitTest(e.clientX, e.clientY, id);
      const onDesk =
        hit ||
        inRect(document.getElementById('desk-wrap')!.getBoundingClientRect(), e.clientX, e.clientY);
      clone!.remove();
      if (onDesk) unhideWidget(id, hit);
      return;
    }
    const t = (kind === 'card' ? faces(id).wrap : faces(id).cap)!.getBoundingClientRect();
    if (!motionOn()) {
      clone!.remove();
      return;
    }
    const c = clone!;
    /* Motion 的 animate 要求两端的 transform 写成同样的函数序列（translate 加 scale），否则缺的那个会按 0 算：起点缺 scale 就补上 scale(1) */
    const from = /scale\(/.test(c.style.transform)
      ? c.style.transform
      : `${c.style.transform || 'translate(0px, 0px)'} scale(1)`;
    markBusy(400);
    animate(
      c,
      { transform: [from, `translate(${t.left}px, ${t.top}px) scale(1)`] },
      { duration: 0.26, ease: EASE_OUT },
    ).finished.then(
      () => c.remove(),
      () => c.remove(),
    );
    c.style.transform = `translate(${t.left}px, ${t.top}px) scale(1)`;
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}
