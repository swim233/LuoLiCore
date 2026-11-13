import { useSyncExternalStore } from 'react';

/* 动画开关：跟随系统（默认）、强制开、强制关三种状态。动画开没开着只看这里，用 motionOn() 同步读，useMotionOn() 在组件里订阅。
   - 跟随系统时看系统的「减少动态效果」：系统那边改了，订阅的人跟着收到通知；
   - 库不存储：用它的项目自己记住用户的选择，启动时用 setMotionMode 交进来，用户拨开关时也经过 setMotionMode；
   - 加载时不碰 window：第一次读、第一次订阅时才查媒体查询。没有 window（node 里的测试）时当作系统没开「减少动态效果」 */
export type MotionMode = 'system' | 'on' | 'off';

let mode: MotionMode = 'system';
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

let reduced: MediaQueryList | null | undefined;
function reducedQuery() {
  if (reduced === undefined) {
    reduced =
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-motion: reduce)')
        : null;
    reduced?.addEventListener('change', () => {
      if (mode === 'system') emit();
    });
  }
  return reduced;
}

/** 此刻动画开着没有：强制开、强制关照选的；跟随系统时，系统没开「减少动态效果」就是开着 */
export const motionOn = () =>
  mode === 'system' ? reducedQuery()?.matches !== true : mode === 'on';
/** 现在是哪种状态 */
export const getMotionMode = () => mode;
/** 换一种状态（启动时交进存下的选择，用户拨开关） */
export function setMotionMode(m: MotionMode) {
  if (m === mode) return;
  mode = m;
  emit();
}
/** 动画开关可能变了（换了状态，或跟随系统时系统那边改了）就调 fn；返回取消订阅的函数 */
export function subscribeMotion(fn: () => void) {
  reducedQuery();
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}
/** 组件里读动画开着没有，变了就重新渲染 */
export const useMotionOn = () => useSyncExternalStore(subscribeMotion, motionOn);
