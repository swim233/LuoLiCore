import { useEffect, useState } from 'react';

/* 列数按窗口宽度：≥1200px 4 列，960–1199 3 列，720–959 2 列，<720 1 列（和 CSS 里的媒体查询一致） */
export const colsFor = (w: number) => (w >= 1200 ? 4 : w >= 960 ? 3 : w >= 720 ? 2 : 1);
export const colsNow = () => colsFor(window.innerWidth);
/* 窗口大小变化后 140 ms 才重新布局 */
export function useCols() {
  const [cols, setCols] = useState(colsNow);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const on = () => {
      clearTimeout(t);
      t = setTimeout(() => setCols(colsNow()), 140);
    };
    window.addEventListener('resize', on);
    return () => {
      window.removeEventListener('resize', on);
      clearTimeout(t);
    };
  }, []);
  return cols;
}
export function useResizeTick() {
  const [n, setN] = useState(0);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const on = () => {
      clearTimeout(t);
      t = setTimeout(() => setN((x) => x + 1), 140);
    };
    window.addEventListener('resize', on);
    return () => {
      window.removeEventListener('resize', on);
      clearTimeout(t);
    };
  }, []);
  return n;
}
