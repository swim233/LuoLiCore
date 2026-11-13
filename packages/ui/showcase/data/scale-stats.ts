/* 面板（src/web/styles/app.css）现在用到的字号、间距、圆角：写报告那天（2026-11-13，HEAD 是 16235df）数的一次性统计，写死在这里。
   面板以后换成刻度，这些数字就不再变了；它们只是「并到哪一档」对照表的数据，别的地方不用。

   怎么数的（先去掉注释，按「属性: 值;」一条条声明数）：
   - 字号：`font-size` 的每条声明数一处；另外 `font` 简写里的字号单独数一列（简写：`font: 12px/1.45 var(--ll-font-mono)` 这样的）。
     只统计 px；em 这样的相对写法和 `font: inherit` 不统计，列在「其他写法」里；
   - 间距：`gap`、`row-gap`、`column-gap`（算 gap）和 `padding`、`padding-top/right/bottom/left/block/inline`（算内边距）。
     一条声明里的每个 px 数值各数一处，同一个值在一条声明里只数一次（`padding: 8px 8px 8px 16px` 数 8 一处、16 一处）；0 不统计；
     含 calc/var/max/env 的、em 和 ch 这样的写法，整条声明记在「其他写法」里，不再往上数；
   - 圆角：`border-radius` 和四个角各自的 `border-top-left-radius` 等；规则同间距（同一个值在一条声明里只数一次）。
     `50%`、`inherit`、写成 var() 的单独列；
   - 窗口的 22 在面板里一直写成 var(--ll-radius-window)，不是 22px 字面，所以单独一行（专用，不并）；
   - 气泡的 16 和收尖的 5（`.bubble`、`.msg.is-me .bubble`、`.chat .msg.is-luoli .bubble` 三条声明）在「专用」那一列，
     不并；`decl` 列只算别的地方用到的。 */

export interface FontStat {
  px: number;
  /** font-size 声明的条数 */
  decl: number;
  /** font 简写里的 */
  shorthand: number;
}
export const FONT_STATS: FontStat[] = [
  { px: 10, decl: 0, shorthand: 1 },
  { px: 10.5, decl: 2, shorthand: 0 },
  { px: 11, decl: 10, shorthand: 0 },
  { px: 11.5, decl: 6, shorthand: 1 },
  { px: 12, decl: 35, shorthand: 3 },
  { px: 12.5, decl: 17, shorthand: 2 },
  { px: 13, decl: 14, shorthand: 1 },
  { px: 13.5, decl: 1, shorthand: 1 },
  { px: 14, decl: 4, shorthand: 1 },
  { px: 15, decl: 5, shorthand: 0 },
  { px: 16, decl: 1, shorthand: 0 },
  { px: 17, decl: 1, shorthand: 0 },
  { px: 28, decl: 1, shorthand: 0 },
  { px: 42, decl: 1, shorthand: 0 },
];
/** 不是 px 的写法：值 → 条数（font-size 5 条、font 简写 1 条） */
export const FONT_OTHER: { value: string; count: number }[] = [
  { value: '0.95em', count: 2 },
  { value: '1.05em', count: 1 },
  { value: '1.1em', count: 1 },
  { value: '1em', count: 1 },
  { value: 'font: 0.9em/1.4 …', count: 1 },
];

export interface SpaceStat {
  px: number;
  gap: number;
  padding: number;
}
export const SPACE_STATS: SpaceStat[] = [
  { px: 1, gap: 1, padding: 5 },
  { px: 1.5, gap: 0, padding: 1 },
  { px: 2, gap: 5, padding: 16 },
  { px: 3, gap: 0, padding: 5 },
  { px: 4, gap: 6, padding: 13 },
  { px: 5, gap: 1, padding: 2 },
  { px: 6, gap: 17, padding: 12 },
  { px: 7, gap: 0, padding: 6 },
  { px: 8, gap: 23, padding: 25 },
  { px: 9, gap: 1, padding: 8 },
  { px: 10, gap: 9, padding: 19 },
  { px: 11, gap: 1, padding: 7 },
  { px: 12, gap: 10, padding: 15 },
  { px: 13, gap: 0, padding: 4 },
  { px: 14, gap: 1, padding: 14 },
  { px: 16, gap: 0, padding: 8 },
  { px: 18, gap: 1, padding: 7 },
  { px: 22, gap: 1, padding: 0 },
  { px: 24, gap: 0, padding: 5 },
  { px: 28, gap: 0, padding: 2 },
  { px: 48, gap: 0, padding: 1 },
  { px: 112, gap: 0, padding: 1 },
];
/** 整条声明记在「其他写法」里的条数 */
export const SPACE_OTHER = { gap: 1, padding: 14 };

export interface RadiusStat {
  px: number;
  /** 别的地方用到的条数（要并的） */
  decl: number;
  /** 气泡里用到的条数（专用，不并） */
  bubble: number;
}
export const RADIUS_STATS: RadiusStat[] = [
  { px: 3, decl: 3, bubble: 0 },
  { px: 4, decl: 3, bubble: 0 },
  { px: 5, decl: 2, bubble: 3 },
  { px: 6, decl: 5, bubble: 0 },
  { px: 7, decl: 1, bubble: 0 },
  { px: 9, decl: 4, bubble: 0 },
  { px: 10, decl: 6, bubble: 0 },
  { px: 12, decl: 6, bubble: 0 },
  { px: 14, decl: 3, bubble: 0 },
  { px: 16, decl: 2, bubble: 3 },
  { px: 18, decl: 1, bubble: 0 },
  { px: 999, decl: 27, bubble: 0 },
];
/** 窗口的圆角：border-radius: var(--ll-radius-window) 的条数，和 app.css 里这个变量一共被引用的处数 */
export const RADIUS_WINDOW = { decl: 4, refs: 20 };
/** 不是 px 的写法：值 → 条数 */
export const RADIUS_OTHER: { value: string; count: number; note: string }[] = [
  { value: '50%', count: 8, note: '圆形，不并' },
  { value: 'inherit', count: 7, note: '跟着外框，不统计' },
  {
    value: 'var(--…)',
    count: 3,
    note: '写在元素上的变量（--rtl、--rtr、--rbl、--rbr、--hr），不统计',
  },
];
