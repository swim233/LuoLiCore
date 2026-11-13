import { createStore, useStore } from '@luoli/ui/store';

/** 模拟的网页会话发言人名字（真实的服务里是 LUOLI_WEB_NAME）：模拟的状态、对话接口、演示数据里的网页会话都用它 */
export const WEB_AUTHOR = '星河';

/* 演示控制面板自己的状态：面板是否展开、当前的数据档位 */
export type Dataset = 'empty' | 'normal' | 'big';
export const devUi = createStore<{ open: boolean; dataset: Dataset }>({
  open: false,
  dataset: 'normal',
});
export const useDevUi = <R>(sel: (s: ReturnType<typeof devUi.get>) => R) => useStore(devUi, sel);
export const toggleDemo = (open = !devUi.get().open) => devUi.set({ open });
