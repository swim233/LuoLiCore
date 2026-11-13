/* 夜空窗口里那层更深更密的星空：两张静态的星点贴图（同一组星，640×390 和 900×548 两种大小），所有窗口、胶囊共用。
   启动时在主线程用 canvas 按固定的种子画一次，按 devicePixelRatio 画清楚；DPR 变了（浏览器缩放、换屏幕）重画。
   画好的图写成 :root 的 --ll-sky-stars-a、--ll-sky-stars-b（data: 地址，不请求外部地址），写在 <head> 里一个 <style> 里，
   和 easing.ts 一样不写 <html> 的行内样式。样式表里两个变量默认是 none，图还没画好时窗口只是没有这层星点。

   气泡的毛玻璃用实时模糊（lib/glass.ts），气泡自己 backdrop-filter，不需要糊好的星空。「预先糊好」那一做法用的星空在这里画：同样这两张星点贴图各糊一份，
   气泡里垫的一层背景（app.css 的 .bubble-sky）用它们代替清楚的星点。这一整套（糊贴图、读颜色、写样式规则，一次约 15～20 毫秒，
   大头是读颜色和写样式表引起的整页样式重算）只在用得到时做（ensureBubbleSky）：页面启动后等主线程空下来时备好一次（warmBubbleSky，
   会话窗口里列表和时间线整层淡入淡出时气泡要暂时按「预先糊好」画，不备好的话第一次开会话那一下要现糊，出一次长任务），
   备好之前就有垫层挂上（开发模式里切过去）时，由挂上的那一刻（components/bubble-sky.ts 调）现做。
   贴图是平铺的，糊的时候要把它平铺着画（上下左右各一份）再取中间一块，接缝才是连续的。
   糊开以后没有细节，所以只画原来的 1/4 大小（背景铺的时候放大回去，放大一张糊开的图看不出来），模糊半径跟着缩小（20 像素 → 5 像素）：
   图只有 1～2 KB，画起来不到一毫秒，也不随 DPR 变（上面的星点贴图 DPR 变了重画，糊好的这两张不用重画）。
   平铺只需要在四周多画模糊半径四倍的一圈（再远的星点对中间那一块没有影响），不用真的画 3×3 整份。
   这层背景写成一条样式规则放在自己的 <style id="bubble-sky-rule"> 里（skyRule），不放在 app.css：图和颜色都直接写在 background-image 里，没有 var()。
   气泡滚动时每帧要改这层的位移，样式每次重算，background-image 里要是有 var()，每次都得把整个值（含图片）重新代入、重新解析，
   十几个气泡每帧多花 1 毫秒多；写成字面的值就只剩位置和大小那几个短的 var()。颜色取自 app.css 里窗口背景用的那几个变量 */
const W = 1280,
  H = 780;
/* 两层贴图的大小（CSS 像素）和起点（相对窗口左上角，和 app.css 的 --ll-sky-bg 一致）：同一组星按比例缩小，越小越密 */
const TILES: [string, number, number, number, number][] = [
  ['--ll-sky-stars-a', 640, 390, -40, -30],
  ['--ll-sky-stars-b', 900, 548, -200, -90],
];
/** 糊好的贴图和上面的两张一一对应；模糊半径（CSS 像素，和实时的 blur(20px) 一样）；画的时候缩小到几分之一 */
const SKY_BLUR = 20;
const SKY_SCALE = 0.25;

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

/* 糊好的贴图：星点画在 (w + 2m) × (h + 2m) 的画布上，四周各多画一圈邻居（平铺），整张糊开，再取中间 w × h 那一块 */
function blurredTile(w: number, h: number) {
  const cw = Math.max(1, Math.round(w * SKY_SCALE)),
    ch = Math.max(1, Math.round(h * SKY_SCALE));
  const sigma = SKY_BLUR * SKY_SCALE;
  const m = Math.ceil(sigma * 4);
  const big = document.createElement('canvas');
  big.width = cw + 2 * m;
  big.height = ch + 2 * m;
  const g = big.getContext('2d');
  const out = document.createElement('canvas');
  out.width = cw;
  out.height = ch;
  const o = out.getContext('2d');
  if (!g || !o || !('filter' in o)) return 'none';
  g.fillStyle = '#fff';
  for (let i = -1; i <= 1; i++)
    for (let j = -1; j <= 1; j++) {
      g.save();
      g.translate(m + i * cw, m + j * ch);
      g.scale(cw / W, ch / H);
      for (const d of DOTS) {
        g.globalAlpha = d.a;
        g.beginPath();
        g.arc(d.x, d.y, d.r, 0, Math.PI * 2);
        g.fill();
      }
      g.restore();
    }
  o.filter = `blur(${sigma}px)`;
  o.drawImage(big, -m, -m);
  return `url(${out.toDataURL('image/png')})`;
}
let skyTiles: string[] | null = null;
/** 糊好的贴图（画一次，之后一直用）；画不出来就是一层透明的 */
const blurredTiles = () =>
  (skyTiles ??= TILES.map(([, w, h]) => blurredTile(w, h)).map((u) =>
    u === 'none' ? 'linear-gradient(transparent, transparent)' : u,
  ));

/** saturate(s) 的 3×3 矩阵（W3C filter effects 规范里的那个），按行排：[R' ← R G B, G' ← R G B, B' ← R G B] */
export function saturateMatrix(s: number): number[] {
  return [
    0.213 + 0.787 * s,
    0.715 - 0.715 * s,
    0.072 - 0.072 * s,
    0.213 - 0.213 * s,
    0.715 + 0.285 * s,
    0.072 - 0.072 * s,
    0.213 - 0.213 * s,
    0.715 - 0.715 * s,
    0.072 + 0.928 * s,
  ];
}
const SKY_SATURATE = 1.3;
/* 一个颜色做 saturate：就是把 (r, g, b) 乘上上面的矩阵，写成 CSS 的相对颜色（透明度不变）。
   颜色的叠加对 (r, g, b) 是线性的，所以先对各层的颜色做 saturate、再叠起来，和先叠起来再整体 saturate 一样（实时模糊的 backdrop-filter 就是后者）；
   这样不用给每个气泡一个 filter。星点是白的，矩阵不改它 */
function saturated(color: string, alpha: boolean) {
  const m = saturateMatrix(SKY_SATURATE).map((n) => n.toFixed(4));
  const ch = (i: number) => `calc(r * ${m[i]} + g * ${m[i + 1]} + b * ${m[i + 2]})`;
  return `rgb(from ${color} ${ch(0)} ${ch(3)} ${ch(6)}${alpha ? ' / alpha' : ''})`;
}
/* 气泡里垫的星空（.bubble-sky）的背景：和窗口的 --ll-sky-bg 同一套（压暗层、两层星点、左上一团紫、右下一团蓝、底色），星点换成糊好的两张，
   颜色整体 saturate(1.3)。窗口里的星空和光晕是按窗口的大小铺的，所以每一层都按窗口的大小铺、按「窗口的左上角相对这个气泡的
   左上角」（--sk-x、--sk-y，窗口的大小是 --sk-w、--sk-h，components/bubble-sky.ts 写在这一层自己身上）挪。
   CSS 还没有加载好、读不到颜色时返回空（ensureBubbleSky 下次再试） */
function skyRule() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string) => cs.getPropertyValue(name).trim();
  const [base, dark, glowA, glowB] = [
    '--ll-sky-base',
    '--ll-sky-shade',
    '--ll-sky-glow-a',
    '--ll-sky-glow-b',
  ].map(v);
  if (!base || !dark || !glowA || !glowB) return '';
  const d = saturated(dark, true);
  const [a, b] = blurredTiles();
  const [ta, tb] = TILES;
  const images = [
    `linear-gradient(${d}, ${d})`,
    a,
    b,
    `radial-gradient(520px 320px at 25% 0%, ${saturated(glowA, true)}, transparent 70%)`,
    `radial-gradient(420px 320px at 100% 100%, ${saturated(glowB, true)}, transparent 70%)`,
  ];
  const at = (ox: number, oy: number) => `calc(var(--sk-x) + ${ox}px) calc(var(--sk-y) + ${oy}px)`;
  const positions = [
    '0 0',
    at(ta[3], ta[4]),
    at(tb[3], tb[4]),
    'var(--sk-x) var(--sk-y)',
    'var(--sk-x) var(--sk-y)',
  ];
  const sizes = [
    '100% 100%',
    `${ta[1]}px ${ta[2]}px`,
    `${tb[1]}px ${tb[2]}px`,
    'var(--sk-w) var(--sk-h)',
    'var(--sk-w) var(--sk-h)',
  ];
  return `.bubble-sky{background-color:${saturated(base, false)};background-image:${images.join(',')};background-position:${positions.join(',')};background-size:${sizes.join(',')};background-repeat:no-repeat,repeat,repeat,no-repeat,no-repeat}`;
}

/* 「预先糊好」的气泡里垫的那层星空的样式规则：第一次有这样的气泡挂上时写（糊贴图、读颜色），写成功了就一直留着，不随 DPR 变。
   读不到颜色（样式表还没加载好）时没写成，下一个气泡挂上时再试。返回有没有这条规则 */
let skyStyle: HTMLStyleElement | null = null;
export function ensureBubbleSky(): boolean {
  if (skyStyle) return true;
  const rule = skyRule();
  if (!rule) return false;
  skyStyle = document.createElement('style');
  skyStyle.id = 'bubble-sky-rule';
  skyStyle.textContent = rule;
  document.head.append(skyStyle);
  return true;
}

/* 页面启动后，等主线程空闲时备好「预先糊好」的星空（ensureBubbleSky 一次约 15～20 毫秒，不能挡在第一次开会话那一下，也不能拖慢首屏）。
   先等 1 秒，让首屏的入场过去；之后用 requestIdleCallback（最多再等 3 秒，到时不管空不空都做），没有它的浏览器就直接在这个定时器里做。
   不要求这一段空闲有多长：页面上一直有动画时每帧的空档只有十来毫秒，要求够长就永远排不上；多出来的那一点（一两帧）发生在启动 1 秒之后、只有一次。
   备好之前气泡先挂上了也没关系，ensureBubbleSky 谁先调谁做，做过就不再做 */
const WARM_DELAY = 1000;
const WARM_TIMEOUT = 3000;
export function warmBubbleSky() {
  setTimeout(() => {
    if (typeof requestIdleCallback === 'function')
      requestIdleCallback(() => void ensureBubbleSky(), { timeout: WARM_TIMEOUT });
    else void ensureBubbleSky();
  }, WARM_DELAY);
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
