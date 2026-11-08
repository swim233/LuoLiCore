import { createStore, useStore } from '../lib/store';

/* 页面上零碎的界面状态：toast、各群状态弹出框、收纳盒的悬停 */
export const ui = createStore<{
  toast: string;
  toastOn: boolean;
  popAnchor: HTMLElement | null;
  trayOver: boolean;
}>({
  toast: '',
  toastOn: false,
  popAnchor: null,
  trayOver: false,
});
export const useUi = <R>(sel: (s: ReturnType<typeof ui.get>) => R) => useStore(ui, sel);
let toastT: ReturnType<typeof setTimeout> | undefined;
export function toast(msg: string) {
  ui.set({ toast: msg, toastOn: true });
  clearTimeout(toastT);
  toastT = setTimeout(() => ui.set({ toastOn: false }), 2600);
}
export const pop = {
  show(a: HTMLElement) {
    ui.set({ popAnchor: a });
  },
  hide() {
    if (ui.get().popAnchor) ui.set({ popAnchor: null });
  },
};
