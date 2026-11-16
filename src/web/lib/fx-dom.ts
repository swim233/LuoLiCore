import { edgeRun as run } from '@luoli/ui/fx';

/* 边缘流光（库的 edgeRun）加外壳的一条判断，出错脉冲（面板自己的） */
/* 全屏打开期间（含进出的过渡）一律不放：全屏窗口上不要流光；桌面上的被暗层盖着，攒到退出后再放就成了迟到的流光 */
export const edgeSkip = (host: Element) =>
  document.body.classList.contains('fs-open') || !!host.closest('#fs');
export function edgeRun(host: Element | null | undefined) {
  run(host, { skip: edgeSkip });
}
const pulseTimers = new WeakMap<Element, ReturnType<typeof setTimeout>>();
export function pulse(el: Element | null | undefined) {
  if (!el) return;
  el.classList.remove('fx-err');
  void (el as HTMLElement).offsetWidth;
  el.classList.add('fx-err');
  clearTimeout(pulseTimers.get(el));
  pulseTimers.set(
    el,
    setTimeout(() => el.classList.remove('fx-err'), 1900),
  );
}
