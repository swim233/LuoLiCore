import { useSyncExternalStore } from 'react';
import { getMotionMode, setMotionMode, subscribeMotion } from '../../src/motion';
import type { MotionMode } from '../../src/motion';
import { storage } from '../../src/storage';
import { createStore, useStore } from '../../src/store';

/* 展示页自己的偏好：动画开关（跟随系统、开、关）、缩放。存 localStorage（storage 里读写都包了 try/catch，存不了就当没存）。
   动画开关本身在库里（@luoli/ui/motion），库不存储：这里替它记住选择，启动时交回去 */
export type Zoom = 1 | 1.1 | 1.25;
export const ZOOMS: readonly Zoom[] = [1, 1.1, 1.25];
const MODES: readonly MotionMode[] = ['system', 'on', 'off'];
const KEY = 'll-showcase-prefs';

interface Saved {
  motion?: unknown;
  zoom?: unknown;
}
const raw = storage.get<Saved | null>(KEY, null);
const saved: Saved = raw && typeof raw === 'object' ? raw : {};

const zoomStore = createStore<{ zoom: Zoom }>({
  zoom: ZOOMS.find((z) => z === saved.zoom) ?? 1,
});
const savedMode = MODES.find((m) => m === saved.motion);
if (savedMode) setMotionMode(savedMode);

const persist = () => storage.set(KEY, { motion: getMotionMode(), zoom: zoomStore.get().zoom });

export const chooseMotion = (m: MotionMode) => {
  setMotionMode(m);
  persist();
};
export const chooseZoom = (zoom: Zoom) => {
  zoomStore.set({ zoom });
  persist();
};
export const useZoom = () => useStore(zoomStore, (s) => s.zoom);
/** 动画开关现在是哪一档（跟随系统、开、关）；换了档，或跟随系统时系统那边改了，都会重新渲染 */
export const useMotionMode = () => useSyncExternalStore(subscribeMotion, getMotionMode);
