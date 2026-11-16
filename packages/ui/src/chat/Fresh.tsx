import { useLayoutEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { EASE_OUT_CSS } from '../easing';
import { motionOn } from '../motion';
import { DROP_MS } from './typing';
import type { Cut } from './typing';

/* 逐字输出时刚出现的字：每个字（开始时刻几乎相同的相邻几个字合成一批）包一个行内 span（.ll-drop），轻轻落下。
   - 只是行内元素加 position: relative 的 top 和透明度，不是 inline-block 加 transform：折行规则和不包的文字完全一样；
   - 落下用 Web Animations 做，开始时刻（startTime）直接设成这个字自己的开始时刻（和 Pacer 同一个时间轴：performance.now()）：
     每个字都从自己的时刻起完整落 DROP_MS，8 像素的位移加淡入；span 因为外面的高亮、Markdown 排版变了被重新建出来、
     或者组件重新渲染时，动画按它的开始时刻对时间，接着原来的进度落，既不从头再落一次，也不会被缩短。
     （用 CSS 动画加 animation-delay 做不到：delay 要按渲染的那一刻算，每次渲染都得重写，写一次缩短一次。） */

/** 落下的起点：上方 8 像素、透明；落完回到原位（top 不写死，动画结束就是普通文字） */
const DROP_FROM = { top: '-8px', opacity: 0 };
const DROP_TO = { top: '0px', opacity: 1 };

function Drop({ at, children }: { at: number; children: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !motionOn() || typeof el.animate !== 'function') return;
    // 开始时刻比现在晚的（不会有，轮到才出现）也行：fill backwards 让它在开始以前停在起点
    const a = el.animate([DROP_FROM, DROP_TO], {
      duration: DROP_MS,
      easing: EASE_OUT_CSS,
      fill: 'backwards',
    });
    a.startTime = at;
    // 落完就撤掉，页面里不留一长串结束了的动画
    a.onfinish = () => a.cancel();
    return () => a.cancel();
  }, [at]);
  return (
    <span ref={ref} className="ll-drop">
      {children}
    </span>
  );
}

/** str 是一段文字，从这一段文字（整段，cuts 是按它算的）的第 from 个字开始；cuts 是这一段文字末尾刚出现的那几批。
 *  返回切开、包好的节点 */
export function freshNodes(str: string, from: number, cuts: readonly Cut[]) {
  const cps = Array.from(str);
  const to = from + cps.length;
  const out: ReactNode[] = [];
  let pos = from;
  for (const c of cuts) {
    if (c.to <= pos || c.from >= to) continue;
    const a = Math.max(c.from, pos);
    const b = Math.min(c.to, to);
    if (a > pos) out.push(cps.slice(pos - from, a - from).join(''));
    out.push(
      <Drop key={c.id} at={c.at}>
        {cps.slice(a - from, b - from).join('')}
      </Drop>,
    );
    pos = b;
  }
  if (pos < to) out.push(cps.slice(pos - from).join(''));
  return out;
}
