import { createStore, useStore } from '../../src/store';

/* 从页面上实际读到的计算值：展示页显示的都是这个，不是 tokens.css 里写的字面。
   样式热更新（改了 tokens.css）以后 bump 一下，用到的组件重新读 */
export const cssVar = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const rev = createStore({ n: 0 });
export const bumpCss = () => rev.set((s) => ({ n: s.n + 1 }));
export const useCssRev = () => useStore(rev, (s) => s.n);
