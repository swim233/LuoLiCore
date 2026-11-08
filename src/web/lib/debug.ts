/* 调试用：?slow=10 把所有转场放慢 10 倍，方便在中途截图、逐帧检查（平时是 1） */
export const SLOW = Math.max(1, Number(new URLSearchParams(location.search).get('slow')) || 1);

if (new URLSearchParams(location.search).get('bare'))
  document.documentElement.classList.add('bare');

for (const k of (new URLSearchParams(location.search).get('dbg') || '').split(',').filter(Boolean))
  document.documentElement.classList.add('dbg-' + k);

/* ?freeze=0.4：转场走到 40% 就停住（只对 ?frame=pieces 有效），逐像素检查中间状态用 */
export const FREEZE = new URLSearchParams(location.search).has('freeze')
  ? Number(new URLSearchParams(location.search).get('freeze'))
  : -1;
export const freezeAt = (): number => (window as Window & { __freeze?: number }).__freeze ?? FREEZE;
