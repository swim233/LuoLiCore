import { motionOn } from '../motion';

/* 流光：给窗口里的 .ll-edge 加 data-run，放一圈绕着窗口边缘的光（样式见 fx.css）。窗口、悬停效果之外的事件也能用（新消息来了那个窗口闪一圈）。 */
export interface EdgeRunOptions {
  /** 这时候不放（比如外壳全屏打开期间、全屏窗口里）：返回 true 就什么也不做。库不认识外壳，由用的地方判断 */
  skip?: (host: Element) => boolean;
}
/** host 是窗口，或者窗口外面再包一层的元素：.ll-edge 在它的下面一层或两层（host > .ll-edge，或 host > 窗口 > .ll-edge）。
 *  动画关着、host 是空、skip 说不放、找不到 .ll-edge，都什么也不做。放的时候重新触发（上一圈没放完也重来） */
export function edgeRun(host: Element | null | undefined, opts: EdgeRunOptions = {}) {
  if (!host || !motionOn() || opts.skip?.(host)) return;
  const e = host.querySelector(':scope > .ll-edge, :scope > * > .ll-edge');
  if (!e) return;
  e.removeAttribute('data-run');
  void (e as HTMLElement).offsetWidth;
  e.setAttribute('data-run', '');
}
