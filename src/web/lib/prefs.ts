import { createStore, useStore } from './store';
import { storage } from './storage';
import { MQ } from './env';

/* 用户偏好：存 localStorage（键同第 4.1 版）。动画只有用户亲手拨过开关才记住，没拨过就跟随系统的「减少动态效果」 */
const PREFS_KEY = 'luoli-webui-demo-prefs-v2';
const stored: Record<string, unknown> =
  storage.get<Record<string, unknown> | null>(PREFS_KEY, {}) || {};
export interface Prefs {
  hover: 'B' | 'C' | 'D';
  collapse: 30 | 5;
  /** 有回复时「此刻」自动展开成浮窗（默认开） */
  autoNow: boolean;
  fps: boolean;
  motion: boolean;
  motionChosen: boolean;
}
const HOVERS: Prefs['hover'][] = ['B', 'C', 'D'];
export const prefs = createStore<Prefs>({
  hover: HOVERS.find((h) => h === stored.hover) ?? 'C',
  collapse: stored.collapse === 5 ? 5 : 30,
  autoNow: stored.autoNow !== false,
  fps: stored.fps === true,
  motionChosen: typeof stored.motion === 'boolean',
  motion: typeof stored.motion === 'boolean' ? stored.motion : !MQ.reduced.matches,
});
export const motionOn = () => prefs.get().motion;
export const usePrefs = <R>(sel: (p: Prefs) => R) => useStore(prefs, sel);
export function setPrefs(patch: Partial<Prefs>) {
  prefs.set(patch);
  const p = prefs.get();
  storage.set(
    PREFS_KEY,
    Object.assign(
      { hover: p.hover, collapse: p.collapse, autoNow: p.autoNow, fps: p.fps },
      p.motionChosen ? { motion: p.motion } : {},
    ),
  );
}
/* 用户亲手拨开关 */
export function chooseMotion(on: boolean) {
  setPrefs({ motion: on, motionChosen: true });
}
MQ.reduced.addEventListener('change', () => {
  if (prefs.get().motionChosen) return;
  prefs.set({ motion: !MQ.reduced.matches });
});
