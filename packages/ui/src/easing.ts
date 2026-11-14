/* 动画的曲线和时长：每一条只在这里定义一次，别处都引用，不再自己写数字。
   - TS 里直接用这里的常量；
   - CSS 用的几个（--ll-ease-out、--ll-dur-hover、--ll-dur-card，悬停高亮的 --ll-dur-glide*，模糊淡入的 --ll-dur-blur-in）在模块加载时写成 <head> 里一个 <style> 的 :root 自定义属性，样式表里只有 var(...)，没有写死的数字。
     样式表在这个模块之后才会用到它们：应用要等 main.tsx 里的 import 全部执行完才渲染。
   - 同样的值在 tokens.css（@luoli/ui/styles.css）里静态地也写了一份，给只引样式、没有加载这个模块的项目用；两处的值必须一样（改一处要改另一处）。
     这里写的 <style> 不在层里，有 JS 时盖过 tokens.css 里的。两处的写法不一定逐字相同（prettier 会给曲线加空格，构建压缩会把 200ms 写成 .2s），比的时候要按数值比。
   曲线的分工见 .handoff/phase-6/easing-inventory.md */

export type Bezier = [number, number, number, number];
export const cssBezier = (b: Bezier) => `cubic-bezier(${b.join(',')})`;

/* ---------- 曲线 ---------- */
/* 形变、位移：外框形变（打开、退出、切换、缩成胶囊、胶囊变卡片、改大小）和其他卡片让位。慢起步、长尾 */
export const EASE_MORPH: Bezier = [0.35, 0.2, 0.15, 1];
/* 出现、进入、到位：很快到位再收尾。部件出现、新行淡入、新条目、整理模式和拖动的位移、数字滚动和能量条 */
export const EASE_OUT: Bezier = [0.2, 0.8, 0.2, 1];
export const EASE_OUT_CSS = cssBezier(EASE_OUT);

/** 按 CSS 的 cubic-bezier(x1, y1, x2, y2) 求值（端点是 (0,0) 和 (1,1)）：t 是 0–1 的时间比例，返回 0–1 的进度。
    给不用 CSS 过渡、自己每帧算进度的地方用（比如数字滚动），曲线和 CSS 里同一条是一样的 */
export function bezierAt([x1, y1, x2, y2]: Bezier, t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const ax = 3 * x1 - 3 * x2 + 1;
  const bx = 3 * x2 - 6 * x1;
  const cx = 3 * x1;
  const ay = 3 * y1 - 3 * y2 + 1;
  const by = 3 * y2 - 6 * y1;
  const cy = 3 * y1;
  const x = (u: number) => ((ax * u + bx) * u + cx) * u;
  const y = (u: number) => ((ay * u + by) * u + cy) * u;
  const dx = (u: number) => (3 * ax * u + 2 * bx) * u + cx;
  /* 先用牛顿法解 x(u) = t（几步就收敛）；导数太小或没收敛，退回二分 */
  let u = t;
  for (let i = 0; i < 8; i++) {
    const err = x(u) - t;
    if (Math.abs(err) < 1e-7) return y(u);
    const d = dx(u);
    if (Math.abs(d) < 1e-6) break;
    u -= err / d;
  }
  let lo = 0;
  let hi = 1;
  u = t;
  for (let i = 0; i < 60 && lo < hi; i++) {
    const err = x(u);
    if (Math.abs(err - t) < 1e-7) break;
    if (t > err) lo = u;
    else hi = u;
    u = (lo + hi) / 2;
  }
  return y(u);
}
/* 列表的悬停高亮从一行滑到另一行，到位时回弹（components/glide.ts 用 Web Animations 的三段关键帧）：
   - 先滑过目标 GLIDE_OVERSHOOT 像素，在全程的 GLIDE_PEAK 处到最远、速度减到 0（EASE_GLIDE_GO），再回到目标（EASE_GLIDE_BACK）；
   - 过冲的距离固定，和滑多远无关（一行到下一行、跨好几行都是这么多），方向跟着滑动的方向；
     剩下的路不到过冲的 4 倍时（中途换回附近的行）按 1/4 缩小，免得几像素的挪动冲得比走得还远；
   - 高度、宽度的变化不回弹，用 EASE_OUT */
export const EASE_GLIDE_GO: Bezier = [0.25, 0.8, 0.35, 1];
export const EASE_GLIDE_BACK: Bezier = [0.45, 0, 0.55, 1];
export const GLIDE_PEAK = 0.6;
export const GLIDE_OVERSHOOT = 4;

/* ---------- 时长（毫秒） ---------- */
/* 外框形变的基准时长（桌面上的形变比它略长，见 actions.ts） */
export const DUR_MORPH = 500;
/* 悬停：顶栏按钮、标题栏按钮、胶囊这类按钮的底色和边框过渡（曲线是 CSS 默认的 ease） */
export const DUR_HOVER = 200;
/* 卡片的边框、阴影和边缘发光的过渡（曲线是 ease） */
export const DUR_CARD = 300;
/* 消失（ease-in）：部件消失的空壳、「新」标记、会话列表里被移除的条目。形变里的淡出（200）是另一回事，不在这里 */
export const DUR_VANISH = 320;
/* 列表的悬停高亮：滑到另一行（位置连同回弹、高度、宽度）、从隐藏到显示的淡入、离开列表的淡出 */
export const DUR_GLIDE = 300;
export const DUR_GLIDE_IN = 140;
export const DUR_GLIDE_OUT = 250;
/* 窗格的模糊：形变结束后换回模糊时的淡入（模糊半径从 0 长到原样，渐变的底一直在） */
export const DUR_BLUR_IN = 200;
/* 会话部件在窗口里的两层（列表、时间线）互相切换：位移加淡入，曲线用 EASE_OUT */
export const DUR_LAYER = 260;
/* 切换时两层各自平移的距离（像素），进来的从这里滑到位，出去的滑向反方向 */
export const LAYER_SHIFT = 28;

/* CSS 变量：写进 <head> 里的一个 <style>（不写 <html> 的行内样式，免得和「结束后没有残留的行内样式」的检查混在一起）。
   没有 document（node 里的测试、服务端渲染）时不写：常量和 bezierAt 在哪里都能用。 */
if (typeof document !== 'undefined') {
  document.getElementById('easing-vars')?.remove();
  const vars = document.createElement('style');
  vars.id = 'easing-vars';
  vars.textContent =
    `:root{--ll-ease-out:${EASE_OUT_CSS};--ll-dur-hover:${DUR_HOVER}ms;--ll-dur-card:${DUR_CARD}ms;` +
    `--ll-dur-glide:${DUR_GLIDE}ms;--ll-dur-glide-in:${DUR_GLIDE_IN}ms;` +
    `--ll-dur-glide-out:${DUR_GLIDE_OUT}ms;--ll-dur-blur-in:${DUR_BLUR_IN}ms}`;
  document.head.append(vars);
}
