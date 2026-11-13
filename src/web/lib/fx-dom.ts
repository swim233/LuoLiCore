import { motionOn } from '@luoli/ui/motion';

/* 边缘流光、出错脉冲：给元素加类名触发 CSS 动画 */
export function edgeRun(host: Element | null | undefined) {
  /* 全屏打开期间（含进出的过渡）一律不放：全屏窗口上不要流光；桌面上的被暗层盖着，攒到退出后再放就成了迟到的流光 */
  if (!host || !motionOn() || document.body.classList.contains('fs-open') || host.closest('#fs'))
    return;
  const e = host.querySelector(
    ':scope > .w-edge, :scope > .w-card > .w-edge, :scope > .cap > .w-edge',
  );
  if (!e) return;
  e.classList.remove('run');
  void (e as HTMLElement).offsetWidth;
  e.classList.add('run');
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
