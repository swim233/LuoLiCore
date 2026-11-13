import { createStore, useStore } from '@luoli/ui/store';
import { storage } from '@luoli/ui/storage';
import { getMotionMode, setMotionMode } from '@luoli/ui/motion';

/* 用户偏好：存 localStorage（键同第 4.1 版）。
   动画开关只在组件库里（@luoli/ui/motion，读它用 motionOn()、useMotionOn()），库不存储：这里替它记住用户的选择。
   只有用户亲手拨过开关才记住（存成 motion: true/false），启动时交给库；没拨过不存这一项，库跟随系统的「减少动态效果」 */
const PREFS_KEY = 'luoli-webui-demo-prefs-v2';
const stored: Record<string, unknown> =
  storage.get<Record<string, unknown> | null>(PREFS_KEY, {}) || {};
export interface Prefs {
  hover: 'B' | 'C' | 'D';
  collapse: 30 | 5;
  /** 有回复时「此刻」自动展开成浮窗（默认开） */
  autoNow: boolean;
  fps: boolean;
}
const HOVERS: Prefs['hover'][] = ['B', 'C', 'D'];
export const prefs = createStore<Prefs>({
  hover: HOVERS.find((h) => h === stored.hover) ?? 'C',
  collapse: stored.collapse === 5 ? 5 : 30,
  autoNow: stored.autoNow !== false,
  fps: stored.fps === true,
});
if (typeof stored.motion === 'boolean') setMotionMode(stored.motion ? 'on' : 'off');
export const usePrefs = <R>(sel: (p: Prefs) => R) => useStore(prefs, sel);

function save() {
  const p = prefs.get();
  const motion = getMotionMode();
  storage.set(
    PREFS_KEY,
    Object.assign(
      { hover: p.hover, collapse: p.collapse, autoNow: p.autoNow, fps: p.fps },
      motion === 'system' ? {} : { motion: motion === 'on' },
    ),
  );
}
export function setPrefs(patch: Partial<Prefs>) {
  prefs.set(patch);
  save();
}
/* 用户亲手拨开关 */
export function chooseMotion(on: boolean) {
  setMotionMode(on ? 'on' : 'off');
  save();
}
