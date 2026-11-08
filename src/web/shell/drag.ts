import { animate } from 'motion';
import { EASE_OUT } from '../lib/easing';
import { motionOn } from '../lib/prefs';
import { desk } from '../state/desk';
import { hideWidget, moveTo, unhideWidget } from '../state/actions';
import { ui } from '../state/ui';
import { markBusy } from './morph';
import { faces } from './faces';

/* 整理模式的拖动换位。鼠标：按下卡片任意处（除了尺寸按钮和「×」）拖；触屏：卡片只认拖动柄，胶囊整个可拖。
   移动超过 6px 才算拖动：原位置变成占位（半透明、虚线边），一个副本跟着指针走（放大 1.03 倍，金色阴影和边框）；
   指针下面是另一个同类部件时，把被拖的部件插到它的位置上（moveTo：其他部件由 Motion 的 layout 动画让位，只在悬停的目标变了的时候换）；
   放下：副本用 260 ms 飞回占位的位置；拖到收纳盒上放下：收进收纳盒；从收纳盒里拖出来放到桌面上：放回去。 */
let justDragged = false;
export const wasDragged = () => justDragged;
const inRect = (r: DOMRect, x: number, y: number) =>
  x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
function hitTest(x: number, y: number, id: string, kind: 'card' | 'cap' | 'tray') {
  for (const el of document.elementsFromPoint(x, y)) {
    const w = el.closest('.desk > .w, .shelf > .cap-wrap') as HTMLElement | null;
    if (!w) continue;
    if (w.dataset.id === id) return null;
    if (kind === 'card' && !w.matches('.desk > .w')) continue;
    if (kind === 'cap' && !w.matches('.shelf > .cap-wrap')) continue;
    return w.dataset.id!;
  }
  return null;
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
    lastHit: string | null = null;
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
    if (kind !== 'tray') src!.setAttribute('data-dragging', '');
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
    if (overTray || kind === 'tray') return;
    const hit = hitTest(e.clientX, e.clientY, id, kind);
    if (hit && hit !== lastHit) {
      lastHit = hit;
      moveTo(id, hit);
    } else if (!hit) lastHit = null;
  };
  const up = (e: PointerEvent) => {
    if (e.pointerId !== pid) return;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
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
      hideWidget(id);
      return;
    }
    if (kind === 'tray') {
      const hit = hitTest(e.clientX, e.clientY, id, kind);
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
