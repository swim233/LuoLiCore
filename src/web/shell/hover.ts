import { env } from '@luoli/ui/env';
import { prefs } from '../lib/prefs';
import { motionOn } from '@luoli/ui/motion';
import { desk } from '../state/desk';
import { edgeRun } from '../lib/fx-dom';

/* 悬停的动效与发光（B 边缘流光、C 边缘发光、D 卡牌倾斜 + 边缘发光），只在有鼠标时 */
export function hoverHandlers(isFull: boolean) {
  return {
    onPointerEnter(e: React.PointerEvent<HTMLElement>) {
      if (e.pointerType !== 'mouse' || !env.hover) return;
      e.currentTarget.classList.add('is-hot');
      if (prefs.get().hover === 'B') edgeRun(e.currentTarget);
    },
    onPointerMove(e: React.PointerEvent<HTMLElement>) {
      if (e.pointerType !== 'mouse' || !env.hover) return;
      const card = e.currentTarget;
      const r = card.getBoundingClientRect();
      const x = e.clientX - r.left,
        y = e.clientY - r.top;
      card.style.setProperty('--mx', x.toFixed(0) + 'px');
      card.style.setProperty('--my', y.toFixed(0) + 'px');
      if (prefs.get().hover === 'D' && !isFull && !desk.get().arranging && motionOn()) {
        card.style.setProperty('--rx', ((y / r.height - 0.5) * -6).toFixed(2) + 'deg');
        card.style.setProperty('--ry', ((x / r.width - 0.5) * 6).toFixed(2) + 'deg');
      }
    },
    onPointerLeave(e: React.PointerEvent<HTMLElement>) {
      const card = e.currentTarget;
      card.classList.remove('is-hot');
      card.style.removeProperty('--rx');
      card.style.removeProperty('--ry');
    },
  };
}
