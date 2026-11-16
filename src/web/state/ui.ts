import { createPopoverHandle } from '@luoli/ui/overlay';
import { createStore, useStore } from '@luoli/ui/store';

/* 页面上零碎的界面状态：收纳盒的悬停。
   toast 用库的（@luoli/ui/overlay 的 toast()，调用处照旧 import { toast } from state/ui）；
   popHandle 是各群状态弹出框的 handle：顶栏的状态按钮、「此刻」的胶囊和大徽记是它的三个触发元素，Overlays.tsx 的 Pop 是它的根；
   要把弹出框收起来的地方（点状态按钮、按 Esc、开始拖「此刻」的胶囊、展开收起、进出全屏）直接调 popHandle.close() */
export const ui = createStore<{ trayOver: boolean }>({ trayOver: false });
export const useUi = <R>(sel: (s: ReturnType<typeof ui.get>) => R) => useStore(ui, sel);
export { toast } from '@luoli/ui/overlay';
export const popHandle = createPopoverHandle();
