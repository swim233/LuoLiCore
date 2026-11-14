/* 夜空窗口里那层更深更密的星空：两张静态的星点贴图（同一组星，640×390 和 900×548 两种大小），所有窗口、胶囊共用（.ll-sky 的底，见 surfaces/sky.css）。
   startSkyStars() 在主线程用 canvas 按固定的种子画一次，按 devicePixelRatio 画清楚；DPR 变了（浏览器缩放、换屏幕）重画。
   画好的图写成 :root 的 --ll-sky-stars-a、--ll-sky-stars-b（data: 地址，不请求外部地址），写在 <head> 里一个 <style id="ll-sky-stars"> 里，
   和 easing.ts 一样不写 <html> 的行内样式。tokens.css 里这两个变量默认是 none，图还没画好时窗口只是没有这层星点。
   加载这个模块时不碰 DOM（只算那一组星点，是纯计算）；调 startSkyStars() 才画。

   贴图的起点和大小（SKY_TILES）和 tokens.css 里 --ll-sky-bg 写的那两层（-40px -30px / 640px 390px、-200px -90px / 900px 548px）是同一组数写了两份：
   样式要静态可用（不能以这里为准），所以两处各留一份，要一样。展示页加载后按数值核对一次（showcase/lib/sky-check.ts），对不上就报错。
   SKY_DOTS、SKY_W、SKY_H、SKY_TILES 导出，是给用同一组星点的别的东西用的（面板里「预先糊好」的气泡星空）。 */
/** 星点画在 SKY_W × SKY_H 的画布里（CSS 像素），贴图按比例缩小 */
export const SKY_W = 1280;
export const SKY_H = 780;

/** 两层贴图：变量名、贴图的 CSS 像素宽高、背景起点（相对窗口左上角）。同一组星按比例缩小，越小越密 */
export type SkyTile = readonly [name: string, width: number, height: number, x: number, y: number];
export const SKY_TILES: readonly SkyTile[] = [
  ['--ll-sky-stars-a', 640, 390, -40, -30],
  ['--ll-sky-stars-b', 900, 548, -200, -90],
];

export interface SkyDot {
  x: number;
  y: number;
  r: number;
  a: number;
}
/* 固定的种子：170 颗，九成是小星（半径 0.5–1.2），一成大星（1.1–1.7），透明度 0.25–0.85 */
function makeDots(): SkyDot[] {
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const out: SkyDot[] = [];
  for (let i = 0; i < 170; i++) {
    const x = rnd() * SKY_W,
      y = rnd() * SKY_H;
    const r = rnd() < 0.9 ? 0.5 + rnd() * 0.7 : 1.1 + rnd() * 0.6;
    out.push({ x, y, r, a: 0.25 + rnd() * 0.6 });
  }
  return out;
}
export const SKY_DOTS: readonly SkyDot[] = makeDots();

function tile(w: number, h: number, dpr: number) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * dpr));
  c.height = Math.max(1, Math.round(h * dpr));
  const g = c.getContext('2d');
  if (!g) return 'none';
  /* 先换到贴图自己的 CSS 像素，再按整张图缩小：星的位置、大小和「整张 1280×780 的图缩到这么大」一样，只是画得清楚 */
  g.scale(c.width / w, c.height / h);
  g.scale(w / SKY_W, h / SKY_H);
  g.fillStyle = '#fff';
  for (const d of SKY_DOTS) {
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
    style.id = 'll-sky-stars';
    document.head.append(style);
  }
  style.textContent = `:root{${SKY_TILES.map(([v, w, h]) => `${v}:${tile(w, h, dpr)}`).join(';')}}`;
  /* 盯着现在这个 DPR：一变就重画，再盯新的 */
  window
    .matchMedia(`(resolution: ${dpr}dppx)`)
    .addEventListener('change', () => queueMicrotask(draw), { once: true });
}

/** 画星点贴图、写进 --ll-sky-stars-a、--ll-sky-stars-b；DPR 变了自动重画。启动时调一次（同步，在主线程画，约几毫秒） */
export function startSkyStars() {
  draw();
}
