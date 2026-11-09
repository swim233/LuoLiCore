import { badgeFx } from '../../fx/client';

/* 徽记的时间倍率：只有开发模式的切换实验台会改它（慢放 ½、¼），正式构建里永远是 1。
   徽记自己创建的 Web Animations 设 playbackRate、计时器按倍率换算、倍率发给 Worker；不改 Element.prototype.animate。
   vnow() 是按倍率走的「徽记时间」：停留 0.8 秒、回复完留 3 秒这些都按它算。 */
let rate = 1;
let vBase = 0;
let rBase = performance.now();
const subs = new Set<(r: number) => void>();

export const timeRate = () => rate;
/** 徽记时间（毫秒）：倍率是 1 时就是 performance.now() 的增量 */
export const vnow = () => vBase + (performance.now() - rBase) * rate;
/** 徽记时间的 ms 毫秒，换算成真实等待的毫秒（给 setTimeout 用） */
export const real = (ms: number) => ms / rate;
export function setTimeRate(r: number) {
  if (r === rate) return;
  vBase = vnow();
  rBase = performance.now();
  rate = r;
  badgeFx.rate(r);
  subs.forEach((f) => f(r));
}
export function onTimeRate(fn: (r: number) => void) {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}
