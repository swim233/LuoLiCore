/* 滚动：窗格（Pane）、长列表（VirtualLog）、悬停高亮（useGlide、hideGlides）、滚轮缓动挂监听（installWheel）。
   入口只做转出，加载时不碰 DOM（node 里能 import）。样式在这个目录下的 css 文件里，由 ../styles.css 引。 */
export { installWheel } from './install-wheel';
export type { InstallWheelOptions } from './install-wheel';
export { hideGlides, useGlide } from './glide';
export { Pane } from './Pane';
export { VirtualLog } from './VirtualLog';
export type { LogItem, ScrollState } from './VirtualLog';
