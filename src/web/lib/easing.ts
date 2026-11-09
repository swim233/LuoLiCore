/* 动画的曲线和时长：每一条只在这里定义一次，别处都引用，不再自己写数字。
   - TS 里直接用这里的常量；
   - CSS 用的几个（--ease-out、--dur-hover、--dur-card，悬停高亮的 --dur-glide*，模糊淡入的 --dur-blur-in）在模块加载时写成 <head> 里一个 <style> 的 :root 自定义属性，样式表里只有 var(...)，没有写死的数字。
     样式表在这个模块之后才会用到它们：应用要等 main.tsx 里的 import 全部执行完才渲染。
   曲线的分工见 .handoff/phase-6/easing-inventory.md */

export type Bezier = [number, number, number, number];
export const cssBezier = (b: Bezier) => `cubic-bezier(${b.join(',')})`;

/* ---------- 曲线 ---------- */
/* 形变、位移：外框形变（打开、退出、切换、缩成胶囊、胶囊变卡片、改大小）和其他卡片让位。慢起步、长尾 */
export const EASE_MORPH: Bezier = [0.35, 0.2, 0.15, 1];
/* 出现、进入、到位：很快到位再收尾。部件出现、新行淡入、新条目、整理模式和拖动的位移、数字滚动和能量条 */
export const EASE_OUT: Bezier = [0.2, 0.8, 0.2, 1];
export const EASE_OUT_CSS = cssBezier(EASE_OUT);
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

/* CSS 变量：写进 <head> 里的一个 <style>（不写 <html> 的行内样式，免得和「结束后没有残留的行内样式」的检查混在一起） */
document.getElementById('easing-vars')?.remove();
const vars = document.createElement('style');
vars.id = 'easing-vars';
vars.textContent =
  `:root{--ease-out:${EASE_OUT_CSS};--dur-hover:${DUR_HOVER}ms;--dur-card:${DUR_CARD}ms;` +
  `--dur-glide:${DUR_GLIDE}ms;--dur-glide-in:${DUR_GLIDE_IN}ms;` +
  `--dur-glide-out:${DUR_GLIDE_OUT}ms;--dur-blur-in:${DUR_BLUR_IN}ms}`;
document.head.append(vars);
