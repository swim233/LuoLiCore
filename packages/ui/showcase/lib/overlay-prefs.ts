import { storage } from '../../src/storage';
import { createStore, useStore } from '../../src/store';

/* 「浮层」一节自己的偏好：toast 的停留时间、Toaster 现在挂着没有（演示「挂上之前发的补得出来」用）。
   存 localStorage（storage 里读写都包了 try/catch），刷新以后还是你选的 */
export const TOAST_DURATIONS = [2600, 4000, 6000] as const;

const KEY = 'll-showcase-overlay';
interface Saved {
  duration?: unknown;
}
const raw = storage.get<Saved | null>(KEY, null);
const saved: Saved = raw && typeof raw === 'object' ? raw : {};

const store = createStore<{
  duration: number;
  toasterOn: boolean;
}>({
  duration: TOAST_DURATIONS.find((d) => d === saved.duration) ?? 4000,
  toasterOn: true,
});

export const useToastDuration = () => useStore(store, (s) => s.duration);
export const useToasterOn = () => useStore(store, (s) => s.toasterOn);
export const chooseToastDuration = (duration: number) => {
  store.set({ duration });
  storage.set(KEY, { duration });
};
export const setToasterOn = (toasterOn: boolean) => store.set({ toasterOn });
