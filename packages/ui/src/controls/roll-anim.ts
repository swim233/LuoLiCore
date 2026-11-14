import { bezierAt, EASE_OUT } from '../easing';

/* 数字滚动的动画：从 from 走到 to，ROLL_MS 毫秒，曲线是 EASE_OUT（和能量槽宽度的过渡同一条）。
   每帧用 requestAnimationFrame 算进度（bezierAt），写进 node；滚动期间 node 上有 data-rolling，结束后 ROLL_HOLD_MS 毫秒再去掉。
   不依赖 React 和 Motion：Roll 组件只是调它。返回「停掉」的函数（卸载、值又变了时调）：取消下一帧和还没到的收尾计时。 */
export const ROLL_MS = 900;
export const ROLL_HOLD_MS = 500;

/** 动画里要碰的节点：只用到这三样（测试里用假的，浏览器里是 HTMLElement） */
export interface RollNode {
  textContent: string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

/** 走到 elapsed 毫秒时的值 */
export const rollValue = (from: number, to: number, elapsed: number) =>
  from + (to - from) * bezierAt(EASE_OUT, elapsed / ROLL_MS);

export function runRoll(
  node: RollNode,
  from: number,
  to: number,
  fmt: (n: number) => string,
  onValue: (n: number) => void,
): () => void {
  node.setAttribute('data-rolling', '');
  let raf = 0;
  let hold: ReturnType<typeof setTimeout> | undefined;
  let t0 = -1;
  const step = (now: number) => {
    if (t0 < 0) t0 = now;
    const elapsed = now - t0;
    if (elapsed >= ROLL_MS) {
      onValue(to);
      node.textContent = fmt(to);
      hold = setTimeout(() => node.removeAttribute('data-rolling'), ROLL_HOLD_MS);
      return;
    }
    const cur = rollValue(from, to, elapsed);
    onValue(cur);
    node.textContent = fmt(cur);
    raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  return () => {
    cancelAnimationFrame(raf);
    clearTimeout(hold);
  };
}

/* 值变了该怎么走（Roll 组件的 effect 里就调这一个）：
   - 值和现在显示的数一样（比如 0→100→0 赶在同一帧之前：前一次滚动已经停掉、一帧都没走）：不用滚，只把 data-rolling 去掉（前一次开头加上的），字也写回这个数；
   - 动画关着：直接到新值，去掉 data-rolling；
   - 其他：滚（见 runRoll）。
   onValue 记着当前数（中途换值从这个数接着滚）。返回「停掉」的函数，没有滚动时没有。 */
export function rollTo(
  node: RollNode,
  from: number,
  to: number,
  fmt: (n: number) => string,
  animated: boolean,
  onValue: (n: number) => void,
): (() => void) | undefined {
  if (to === from || !animated) {
    onValue(to);
    node.textContent = fmt(to);
    node.removeAttribute('data-rolling');
    return undefined;
  }
  return runRoll(node, from, to, fmt, onValue);
}
