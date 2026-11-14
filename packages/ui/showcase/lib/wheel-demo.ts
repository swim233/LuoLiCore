import { useSyncExternalStore } from 'react';
import { installWheel } from '../../src/scroll';

/* 展示页的滚轮缓动：启动时装上（main.tsx），「滚动」一节里有个开关能拆掉、再装上，对着原生的滚动比。
   库的 installWheel 整个页面只装一份：这里记着拆掉的函数，开关切换就是调它或者再装一次 */
let off: (() => void) | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

export function setWheelEase(on: boolean) {
  if (on === (off !== null)) return;
  if (on) off = installWheel();
  else {
    off?.();
    off = null;
  }
  emit();
}
export const useWheelEase = () =>
  useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => off !== null,
  );
