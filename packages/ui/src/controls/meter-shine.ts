/* 能量槽的光什么时候扫：只在数值变大时扫一次；第一次渲染（还没有「上一次的值」，记成 -1）不扫，不变、变小也不扫。
   拆成纯函数，Meter 组件的 effect 只调它（扫的动作本身是给光那一层写 data-run，见 Meter.tsx）。 */
export const NO_PREV = -1;
export const shouldShine = (prev: number, next: number) => prev >= 0 && next > prev;
