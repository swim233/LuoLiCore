import type { PointerEvent as ReactPointerEvent } from 'react';
import { motionOn } from '../motion';
import { edgeRun } from './edge';

/* 窗口上悬停的三种效果的 JS 这一半（样式见 fx.css）。只在有鼠标时：指针是鼠标、设备是能悬停的细指针（媒体查询）。
   - sweep 流光：进入时放一圈流光（edgeRun），窗口多一圈淡光；
   - glow 边光：鼠标附近那段边被照亮（写 --ll-hover-x、--ll-hover-y）；
   - tilt 倾斜：边光，加卡牌倾斜（写 --ll-tilt-x、--ll-tilt-y，最大 ±3 度，动画关着不写）。
   用哪一种由 data-ll-hover 说：写在页面根元素上（setHoverEffect 写）整页一种，也可以写在窗口自己身上、一个窗口一种；
   处理函数每次事件时现读（离窗口最近的那一个），所以中途换了下一次事件就生效。 */
export type HoverEffect = 'sweep' | 'glow' | 'tilt';
const ATTR = 'data-ll-hover';

/** 换一种悬停的效果（样式靠根元素上的这个属性选，处理函数也读它） */
export function setHoverEffect(effect: HoverEffect) {
  document.documentElement.setAttribute(ATTR, effect);
}
/* 窗口自己或离它最近的、写了 data-ll-hover 的祖先（通常是根元素）说的那一种 */
const effectOf = (el: Element) => el.closest(`[${ATTR}]`)?.getAttribute(ATTR);

let mq: MediaQueryList | undefined;
const canHover = () => (mq ??= matchMedia('(hover: hover) and (pointer: fine)')).matches;

export interface HoverOptions {
  /** 这时候倾不倾斜（外壳的全屏、整理时不倾斜）；不给就是总是倾斜。动画关着时库自己不倾斜 */
  canTilt?: () => boolean;
  /** 进入时放流光的话，这时候不放（传给 edgeRun 的 skip） */
  skipEdge?: (host: Element) => boolean;
}
type Ev = ReactPointerEvent<HTMLElement>;

/** 窗口（带 ll-hover 类）上的三个指针处理函数：onPointerEnter、onPointerMove、onPointerLeave */
export function hoverHandlers({ canTilt, skipEdge }: HoverOptions = {}) {
  return {
    onPointerEnter(e: Ev) {
      if (e.pointerType !== 'mouse' || !canHover()) return;
      e.currentTarget.classList.add('ll-hot');
      if (effectOf(e.currentTarget) === 'sweep') edgeRun(e.currentTarget, { skip: skipEdge });
    },
    onPointerMove(e: Ev) {
      if (e.pointerType !== 'mouse' || !canHover()) return;
      const card = e.currentTarget;
      const r = card.getBoundingClientRect();
      const x = e.clientX - r.left,
        y = e.clientY - r.top;
      card.style.setProperty('--ll-hover-x', x.toFixed(0) + 'px');
      card.style.setProperty('--ll-hover-y', y.toFixed(0) + 'px');
      if (effectOf(card) === 'tilt' && (canTilt?.() ?? true) && motionOn()) {
        card.style.setProperty('--ll-tilt-x', ((y / r.height - 0.5) * -6).toFixed(2) + 'deg');
        card.style.setProperty('--ll-tilt-y', ((x / r.width - 0.5) * 6).toFixed(2) + 'deg');
      }
    },
    onPointerLeave(e: Ev) {
      const card = e.currentTarget;
      card.classList.remove('ll-hot');
      card.style.removeProperty('--ll-tilt-x');
      card.style.removeProperty('--ll-tilt-y');
    },
  };
}
