import { createStore, useStore } from '../lib/store';

/* 演示控制面板自己的状态：面板是否展开、当前的数据档位 */
export type Dataset = 'empty' | 'normal' | 'big';
export const devUi = createStore<{ open: boolean; dataset: Dataset }>({
  open: false,
  dataset: 'normal',
});
export const useDevUi = <R>(sel: (s: ReturnType<typeof devUi.get>) => R) => useStore(devUi, sel);
export const toggleDemo = (open = !devUi.get().open) => devUi.set({ open });
