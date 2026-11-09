/* 夜空窗口里那层更深更密的星空：两张静态的星点贴图（同一组星，640×390 和 900×548 两种大小），所有窗口、胶囊共用。
   启动时在主线程用 canvas 按固定的种子画一次，按 devicePixelRatio 画清楚；DPR 变了（浏览器缩放、换屏幕）重画。
   画好的图写成 :root 的 --win-stars-a、--win-stars-b（data: 地址，不请求外部地址），写在 <head> 里一个 <style> 里，
   和 easing.ts 一样不写 <html> 的行内样式。样式表里两个变量默认是 none，图还没画好时窗口只是没有这层星点 */
const W = 1280,
  H = 780;
/* 两层贴图的大小（CSS 像素）：同一组星按比例缩小，越小越密 */
const TILES: [string, number, number][] = [
  ['--win-stars-a', 640, 390],
  ['--win-stars-b', 900, 548],
];

interface Dot {
  x: number;
  y: number;
  r: number;
  a: number;
}
/* 固定的种子（和拷问演示页同一组星）：170 颗，九成是小星 */
function dots(): Dot[] {
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const out: Dot[] = [];
  for (let i = 0; i < 170; i++) {
    const x = rnd() * W,
      y = rnd() * H;
    const r = rnd() < 0.9 ? 0.5 + rnd() * 0.7 : 1.1 + rnd() * 0.6;
    out.push({ x, y, r, a: 0.25 + rnd() * 0.6 });
  }
  return out;
}
const DOTS = dots();

function tile(w: number, h: number, dpr: number) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * dpr));
  c.height = Math.max(1, Math.round(h * dpr));
  const g = c.getContext('2d');
  if (!g) return 'none';
  /* 先换到贴图自己的 CSS 像素，再按整张图缩小：星的位置、大小和「整张 1280×780 的图缩到这么大」一样，只是画得清楚 */
  g.scale(c.width / w, c.height / h);
  g.scale(w / W, h / H);
  g.fillStyle = '#fff';
  for (const d of DOTS) {
    g.globalAlpha = d.a;
    g.beginPath();
    g.arc(d.x, d.y, d.r, 0, Math.PI * 2);
    g.fill();
  }
  return `url(${c.toDataURL('image/png')})`;
}

let style: HTMLStyleElement | null = null;
let dprNow = 0;
function draw() {
  const dpr = window.devicePixelRatio || 1;
  if (dpr === dprNow) return;
  dprNow = dpr;
  if (!style) {
    style = document.createElement('style');
    style.id = 'win-sky';
    document.head.append(style);
  }
  style.textContent = `:root{${TILES.map(([v, w, h]) => `${v}:${tile(w, h, dpr)}`).join(';')}}`;
  /* 盯着现在这个 DPR：一变就重画，再盯新的 */
  window
    .matchMedia(`(resolution: ${dpr}dppx)`)
    .addEventListener('change', () => queueMicrotask(draw), { once: true });
}
export function startWinSky() {
  draw();
}
