/// <reference lib="webworker" />
import { badgeMessage } from './badge-canvas';
import type { BadgeMsg } from './badge-msg';
/* 星尘粒子：新增部件时汇聚、移除时散开、回复完成时迸发。画在一张固定的整屏画布上（OffscreenCanvas，在 Worker 里画），
   每个粒子是一张 32×32 的径向渐变小图（中心 100% 不透明，25% 处 85%，边缘 0%）。参数照第 4.1 版；
   速度的阻尼原来是每帧乘 0.985（按帧算），换成按时间：0.985^(60·t)。
   徽记的小画布也在这个 Worker 里画（bd- 开头的消息，见 badge-canvas.ts），和整屏的星尘各画各的 */
interface P {
  x: number;
  y: number;
  vx: number;
  vy: number;
  g: number;
  age: number;
  life: number;
  s: number;
  c: string;
  fx?: number;
  fy?: number;
  to?: { x: number; y: number };
}
type Msg =
  | { type: 'init'; canvas: OffscreenCanvas; w: number; h: number; dpr: number }
  | { type: 'size'; w: number; h: number; dpr: number }
  | { type: 'burst'; x: number; y: number; n: number; speed: number; palette: string[] }
  | {
      type: 'assemble';
      r: {
        left: number;
        top: number;
        width: number;
        height: number;
        right: number;
        bottom: number;
      };
      n: number;
      ms: number;
      palette: string[];
    }
  | {
      type: 'scatter';
      r: {
        left: number;
        top: number;
        width: number;
        height: number;
        right: number;
        bottom: number;
      };
      n: number;
      palette: string[];
    };

let cv: OffscreenCanvas, ctx: OffscreenCanvasRenderingContext2D;
let W = 0,
  H = 0,
  dpr = 1,
  raf = 0,
  last = 0;
const ps: P[] = [];
const sprites: Record<string, OffscreenCanvas> = {};
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)];
function sprite(rgb: string) {
  if (sprites[rgb]) return sprites[rgb];
  const c = new OffscreenCanvas(32, 32);
  const g = c.getContext('2d')!;
  const gr = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  gr.addColorStop(0, `rgba(${rgb},1)`);
  gr.addColorStop(0.25, `rgba(${rgb},.85)`);
  gr.addColorStop(1, `rgba(${rgb},0)`);
  g.fillStyle = gr;
  g.fillRect(0, 0, 32, 32);
  return (sprites[rgb] = c);
}
function kick() {
  if (!raf) {
    last = 0;
    raf = self.requestAnimationFrame(loop);
  }
}
function loop(t: number) {
  const dt = last ? Math.min(0.05, (t - last) / 1000) : 0.016;
  last = t;
  ctx.clearRect(0, 0, W, H);
  const damp = Math.pow(0.985, 60 * dt);
  for (let i = ps.length - 1; i >= 0; i--) {
    const p = ps[i];
    p.age += dt;
    if (p.age >= p.life) {
      ps.splice(i, 1);
      continue;
    }
    const k = p.age / p.life;
    if (p.to) {
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      p.x = p.fx! + (p.to.x - p.fx!) * e;
      p.y = p.fy! + (p.to.y - p.fy!) * e;
    } else {
      p.vx *= damp;
      p.vy = p.vy * damp + p.g * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
    const a = p.to
      ? Math.min(1, k * 3) * (k > 0.9 ? (1 - k) * 10 : 1)
      : (1 - k) * (k < 0.1 ? k * 10 : 1);
    const s = p.s * (p.to ? 1 : 1 - k * 0.5);
    ctx.globalAlpha = a;
    ctx.drawImage(sprite(p.c), p.x - s, p.y - s, s * 2, s * 2);
  }
  ctx.globalAlpha = 1;
  if (ps.length) raf = self.requestAnimationFrame(loop);
  else {
    raf = 0;
    ctx.clearRect(0, 0, W, H);
  }
}
function size() {
  cv.width = Math.round(W * dpr);
  cv.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
self.onmessage = (e: MessageEvent<Msg | BadgeMsg>) => {
  const m = e.data;
  if (badgeMessage(m)) return;
  if (m.type === 'init') {
    cv = m.canvas;
    ctx = cv.getContext('2d')!;
    W = m.w;
    H = m.h;
    dpr = m.dpr;
    size();
  } else if (m.type === 'size') {
    W = m.w;
    H = m.h;
    dpr = m.dpr;
    size();
  } else if (m.type === 'burst') {
    /* 回复完成：星尘散开（角度随机，速度 rand(.3,1)×150，略偏上；垂直加速度 −16 px/s²；寿命 .8–1.5 秒） */
    for (let i = 0; i < m.n; i++) {
      const ang = rand(0, Math.PI * 2),
        v = rand(0.3, 1) * m.speed;
      ps.push({
        x: m.x,
        y: m.y,
        vx: Math.cos(ang) * v,
        vy: Math.sin(ang) * v - 20,
        g: -16,
        age: 0,
        life: rand(0.8, 1.5),
        s: rand(2, 5.5),
        c: pick(m.palette),
      });
    }
    kick();
  } else if (m.type === 'assemble') {
    /* 新增部件：星点从四周汇聚成形（三分之二落在轮廓上，三分之一在内部；起始延迟 0–.25 秒；缓入缓出的三次曲线） */
    const r = m.r;
    const cx = r.left + r.width / 2,
      cy = r.top + r.height / 2,
      R = Math.max(r.width, r.height) * 0.9 + 80;
    for (let i = 0; i < m.n; i++) {
      const ang = rand(0, Math.PI * 2),
        d = rand(0.6, 1) * R;
      let tx: number, ty: number;
      if (i % 3) {
        const e = rand(0, 1),
          side = i % 4;
        tx = side < 2 ? r.left + e * r.width : side === 2 ? r.left : r.right;
        ty = side < 2 ? (side ? r.bottom : r.top) : r.top + e * r.height;
      } else {
        tx = rand(r.left, r.right);
        ty = rand(r.top, r.bottom);
      }
      ps.push({
        fx: cx + Math.cos(ang) * d,
        fy: cy + Math.sin(ang) * d,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        g: 0,
        to: { x: tx, y: ty },
        age: -rand(0, 0.25),
        life: m.ms / 1000,
        s: rand(2, 4.5),
        c: pick(m.palette),
      });
    }
    kick();
  } else if (m.type === 'scatter') {
    /* 部件消散：粒子在矩形内随机，从中心指向这个点，水平和垂直速度各 30–120 px/s，向上飘 −30 px/s² */
    const r = m.r;
    for (let i = 0; i < m.n; i++) {
      const x = rand(r.left, r.right),
        y = rand(r.top, r.bottom),
        ang = Math.atan2(y - (r.top + r.height / 2), x - (r.left + r.width / 2));
      ps.push({
        x,
        y,
        vx: Math.cos(ang) * rand(30, 120),
        vy: Math.sin(ang) * rand(30, 120),
        g: -30,
        age: 0,
        life: rand(0.7, 1.2),
        s: rand(2, 4.5),
        c: pick(m.palette),
      });
    }
    kick();
  }
};
export {};
