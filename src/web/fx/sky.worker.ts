/// <reference lib="webworker" />
/* 背景星空：在 Worker 里用 OffscreenCanvas 画，不占主线程。
   恢复第 3 版的观感：每颗星各自漂移（方向、速度各自随机，每秒一两个像素）、所有星点都闪烁（亮度按正弦在 0.1a 和 a 之间来回，角速度 tw rad/s，相位随机）。
   星座的点和线是各自独立的对象，各有自己的透明度数组（dotAlpha、lineAlpha）：第 6 版要让星座「逐段画出来、一颗颗亮起来」时，
   直接改这两个数组（见 setConstellation），不用动星点那一层。 */
interface Star {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  size: number;
  sq: boolean;
  a: number;
  tw: number;
  ph: number;
  c: number;
  big: boolean;
}
interface Con {
  pts: { x: number; y: number }[];
  dotAlpha: number[];
  lineAlpha: number[];
  vx: number;
  vy: number;
  ox: number;
  oy: number;
}
type Msg =
  | {
      type: 'init';
      canvas: OffscreenCanvas;
      w: number;
      h: number;
      dpr: number;
      colors: Record<string, string>;
      narrow: boolean;
      lowPower: boolean;
      motion: boolean;
      fps: number;
    }
  | { type: 'size'; w: number; h: number; dpr: number; narrow: boolean }
  | { type: 'motion'; on: boolean }
  | { type: 'hold'; on: boolean }
  | { type: 'con'; id: number; dotAlpha?: number[]; lineAlpha?: number[] };

let cv: OffscreenCanvas, ctx: OffscreenCanvasRenderingContext2D;
let W = 0,
  H = 0,
  dpr = 1;
let stars: Star[] = [];
let cons: Con[] = [];
let colors: Record<string, string> = {};
let narrow = false,
  lowPower = false,
  motion = true,
  held = false,
  frameMs = 1000 / 30;
let raf = 0,
  last = 0,
  t = 0;
const rand = (a: number, b: number) => a + Math.random() * (b - a);

function build() {
  /* 星点更细、更少：不和卡片抢；只留极少数亮一点的（带十字光芒） */
  let n = Math.round((W * H) / 9800);
  n = Math.round(Math.min(n, 190) * (narrow ? 0.6 : 1) * (lowPower ? 0.55 : 1));
  stars = [];
  for (let i = 0; i < n; i++) {
    const r = Math.random() < 0.04 ? rand(1.15, 1.45) : rand(0.3, 1.02);
    const a0 = rand(0.12, 0.58);
    const c = Math.random() < 0.22 ? 1 : Math.random() < 0.3 ? 2 : 0;
    const sq = r < 0.8,
      raw = sq ? r * 1.6 : r * 2,
      size = Math.max(1, raw);
    const a = a0 * (raw < 1 ? raw * raw : 1); /* 不到 1px 的点按面积把亮度压下去 */
    const ang = rand(0, Math.PI * 2),
      sp = rand(0.4, 1.6);
    stars.push({
      x: rand(-48, W),
      y: rand(0, H + 30),
      vx: Math.cos(ang) * sp,
      vy: Math.sin(ang) * sp,
      r,
      size,
      sq,
      a,
      tw: rand(0.25, 1.1),
      ph: rand(0, 6.28),
      c,
      big: !sq && r > 1.25 && c === 1,
    });
  }
  /* 两组淡淡的星座连线：呼应她裙摆上的星座 */
  cons = [0, 1].map((k) => {
    const cx = W * (k ? 0.78 : 0.16),
      cy = H * (k ? 0.7 : 0.3),
      s = Math.min(W, H) * 0.16;
    const shape = k
      ? [
          [0, 0],
          [0.5, -0.3],
          [1, -0.15],
          [1.4, 0.25],
          [0.9, 0.55],
          [0.45, 0.4],
        ]
      : [
          [0, 0],
          [0.35, 0.45],
          [0.8, 0.35],
          [1.1, 0.8],
          [0.6, 1.05],
        ];
    const pts = shape.map(([qx, qy]) => ({ x: cx + qx * s, y: cy + qy * s }));
    return {
      pts,
      dotAlpha: pts.map(() => 1),
      lineAlpha: pts.slice(1).map(() => 1),
      vx: (k ? -1.2 : 1) * (60 / 60),
      vy: (k ? -0.5 : 0.4) * (60 / 60),
      ox: 0,
      oy: 0,
    };
  });
}
function draw() {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const live = motion && !held;
  /* 星点 */
  for (const s of stars) {
    const tw = live
      ? 0.5 + 0.5 * Math.sin(s.tw * t + s.ph)
      : 0.5; /* 停住 / 静止时停在亮度的中间值 */
    const al = s.a * (0.1 + 0.9 * tw);
    ctx.globalAlpha = al;
    const col = s.c === 1 ? colors.goldStar : s.c === 2 ? colors.fg2 : colors.fg;
    ctx.fillStyle = col;
    if (s.sq) ctx.fillRect(s.x - s.size / 2, s.y - s.size / 2, s.size, s.size);
    else {
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.size / 2, 0, 6.2832);
      ctx.fill();
    }
    if (s.big) {
      ctx.globalAlpha = al * 0.5;
      ctx.fillStyle = colors.goldStar;
      ctx.fillRect(s.x - 4, s.y - 0.5, 8, 1);
      ctx.fillRect(s.x - 0.5, s.y - 4, 1, 8);
    }
  }
  /* 星座：线和点各自的透明度 */
  for (const c of cons) {
    ctx.save();
    ctx.translate(c.ox, c.oy);
    ctx.lineWidth = 0.7;
    ctx.strokeStyle = colors.goldLine;
    for (let i = 1; i < c.pts.length; i++) {
      ctx.globalAlpha = c.lineAlpha[i - 1];
      ctx.beginPath();
      ctx.moveTo(c.pts[i - 1].x, c.pts[i - 1].y);
      ctx.lineTo(c.pts[i].x, c.pts[i].y);
      ctx.stroke();
    }
    ctx.fillStyle = colors.goldDot;
    for (let i = 0; i < c.pts.length; i++) {
      ctx.globalAlpha = c.dotAlpha[i];
      ctx.beginPath();
      ctx.arc(c.pts[i].x, c.pts[i].y, 1.3, 0, 6.2832);
      ctx.fill();
    }
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}
function step(dt: number) {
  t += dt;
  for (const s of stars) {
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    if (s.x < -50) s.x = W + 2;
    else if (s.x > W + 2) s.x = -48;
    if (s.y < -2) s.y = H + 30;
    else if (s.y > H + 32) s.y = 0;
  }
  /* 星座各漂各的（60 秒来回，幅度 60px 左右），相位随机 */
  cons.forEach((c, k) => {
    const A = k ? 72 : 60,
      B = k ? 30 : 24,
      per = 60;
    const ph = ((t + k * 17) % (2 * per)) / per,
      tri = ph < 1 ? ph : 2 - ph;
    c.ox = (k ? -1 : 1) * A * tri;
    c.oy = (k ? -1 : 1) * B * tri;
  });
}
function loop(now: number) {
  raf = self.requestAnimationFrame(loop);
  if (last && now - last < frameMs - 2) return;
  const dt = last ? (now - last) / 1000 : 0;
  last = now;
  step(Math.min(dt, 0.25));
  draw();
}
function start() {
  if (raf || !motion || held) return;
  last = 0;
  raf = self.requestAnimationFrame(loop);
}
function stop() {
  if (raf) {
    self.cancelAnimationFrame(raf);
    raf = 0;
  }
}
function resize() {
  cv.width = Math.round(W * dpr);
  cv.height = Math.round(H * dpr);
}
self.onmessage = (e: MessageEvent<Msg>) => {
  const m = e.data;
  if (m.type === 'init') {
    cv = m.canvas;
    ctx = cv.getContext('2d', { alpha: true })!;
    W = m.w;
    H = m.h;
    dpr = m.dpr;
    colors = m.colors;
    narrow = m.narrow;
    lowPower = m.lowPower;
    motion = m.motion;
    frameMs = 1000 / m.fps;
    resize();
    build();
    draw();
    start();
  } else if (m.type === 'size') {
    W = m.w;
    H = m.h;
    dpr = m.dpr;
    narrow = m.narrow;
    resize();
    build();
    draw();
  } else if (m.type === 'motion') {
    motion = m.on;
    if (motion) start();
    else {
      stop();
      draw();
    }
  } else if (m.type === 'hold') {
    held = m.on;
    if (held) {
      stop();
      draw();
    } else {
      start();
      draw();
    }
  } else if (m.type === 'con') {
    const c = cons[m.id];
    if (!c) return;
    if (m.dotAlpha) c.dotAlpha = m.dotAlpha;
    if (m.lineAlpha) c.lineAlpha = m.lineAlpha;
    if (!raf) draw();
  }
};
export {};
