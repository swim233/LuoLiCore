/* 徽记的粒子（在星尘 Worker 里）：每个徽记一张小画布，粒子、光点、光环、扫描弧都画在上面。
   参数照拷问时的演示页（.grill/badge/index.html）。消息的结构见 badge-msg.ts。
   - 只画有活的画布：没有粒子、没有持续特效时，这张画布不再请求下一帧；所有画布都没活就停掉 requestAnimationFrame。
   - 时间倍率（开发模式的慢放）：Worker 自己的时钟按倍率走，粒子的寿命、特效的节奏都跟着变；正式构建里倍率永远是 1。 */
import type { BadgeMsg, BadgeReply, BadgeStats, Col, ColKey, FxName, Op, Shape } from './badge-msg';

const TAU = Math.PI * 2;
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T>(a: readonly T[]) => a[Math.floor(Math.random() * a.length)];
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const many = (v: number) => Math.floor(v) + (Math.random() < v % 1 ? 1 : 0);

/* ---------- 时钟 ---------- */
let vBase = 0,
  rBase = performance.now(),
  rate = 1;
const clk = () => vBase + (performance.now() - rBase) * rate;

/* ---------- 颜色 ---------- */
const C: Record<Col, string> = {
  gold: '#e3c17a',
  pale: '#f4e6c0',
  white: '#ffffff',
  tool: '#8fa2e6',
  toolp: '#c9d3fa',
  amber: '#d9a35f',
  amberp: '#f0cf9a',
  red: '#e07a7a',
  redp: '#ffc4c4',
  flare: '#fff1cc',
};
const DUST = ['#c9d3ff', '#8fa2e6', '#6e82d2'];
const GROUPS: Record<ColKey, string[]> = {
  goldS: [C.gold, C.gold, C.pale, C.white, C.tool],
  spark: [C.pale, C.gold, C.white],
  sparkGP: [C.pale, C.gold],
  dust: DUST,
  dustGold: [...DUST, C.gold],
  dustWhite: [...DUST, C.white],
  amber: [C.amber, C.amberp, C.white],
  shatter: [C.red, C.red, C.redp, C.white],
};
/* 每个粒子是一张 32×32 的径向渐变小图 */
const sprites = new Map<string, OffscreenCanvas>();
function sprite(col: string) {
  let c = sprites.get(col);
  if (c) return c;
  c = new OffscreenCanvas(32, 32);
  const g = c.getContext('2d')!;
  const gr = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.22, col);
  gr.addColorStop(0.5, col + '55');
  gr.addColorStop(1, col + '00');
  g.fillStyle = gr;
  g.fillRect(0, 0, 32, 32);
  sprites.set(col, c);
  return c;
}

/* ---------- 形状：弯月和四角星上的点 ---------- */
const MS = 1.12;
const M = { ox: -4, oy: 4, R: 32, cx: 9, cy: -6, rc: 30 };
interface Pt {
  x: number;
  y: number;
}
const inMoon = (x: number, y: number) =>
  (x - M.ox) ** 2 + (y - M.oy) ** 2 <= M.R * M.R &&
  (x - M.cx) ** 2 + (y - M.cy) ** 2 >= M.rc * M.rc;
function moonPoints(n: number): Pt[] {
  const out: Pt[] = [];
  let guard = 0;
  while (out.length < n && guard++ < 6000) {
    const r = Math.random();
    if (r < 0.38) {
      const a = Math.random() * TAU,
        x = M.ox + M.R * Math.cos(a),
        y = M.oy + M.R * Math.sin(a);
      if ((x - M.cx) ** 2 + (y - M.cy) ** 2 >= M.rc * M.rc) out.push({ x, y });
    } else if (r < 0.6) {
      const a = Math.random() * TAU,
        x = M.cx + M.rc * Math.cos(a),
        y = M.cy + M.rc * Math.sin(a);
      if ((x - M.ox) ** 2 + (y - M.oy) ** 2 <= M.R * M.R) out.push({ x, y });
    } else {
      const x = rand(M.ox - M.R, M.ox + M.R),
        y = rand(M.oy - M.R, M.oy + M.R);
      if (inMoon(x, y)) out.push({ x, y });
    }
  }
  return out.map((q) => ({ x: q.x * MS, y: q.y * MS }));
}
/* 四角星：路径 M0-42 C3-14 14-3 42 0 C14 3 3 14 0 42 C-3 14 -14 3 -42 0 C-14 -3 -3 -14 0 -42 Z。
   取样成折线（带累计长度），轮廓上按长度取点，内部用多边形判断 */
const STAR_SEGS: number[][] = [
  [0, -42, 3, -14, 14, -3, 42, 0],
  [42, 0, 14, 3, 3, 14, 0, 42],
  [0, 42, -3, 14, -14, 3, -42, 0],
  [-42, 0, -14, -3, -3, -14, 0, -42],
];
const STAR_POLY: Pt[] = [];
const STAR_LEN: number[] = [0];
for (const s of STAR_SEGS) {
  for (let i = 0; i < 40; i++) {
    const t = i / 40,
      u = 1 - t;
    const x = u * u * u * s[0] + 3 * u * u * t * s[2] + 3 * u * t * t * s[4] + t * t * t * s[6];
    const y = u * u * u * s[1] + 3 * u * u * t * s[3] + 3 * u * t * t * s[5] + t * t * t * s[7];
    STAR_POLY.push({ x, y });
  }
}
for (let i = 1; i <= STAR_POLY.length; i++) {
  const a = STAR_POLY[i - 1],
    b = STAR_POLY[i % STAR_POLY.length];
  STAR_LEN.push(STAR_LEN[i - 1] + Math.hypot(b.x - a.x, b.y - a.y));
}
function inStar(x: number, y: number) {
  let inside = false;
  for (let i = 0, j = STAR_POLY.length - 1; i < STAR_POLY.length; j = i++) {
    const a = STAR_POLY[i],
      b = STAR_POLY[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
function starEdge(): Pt {
  const total = STAR_LEN[STAR_LEN.length - 1],
    u = Math.random() * total;
  let lo = 0,
    hi = STAR_LEN.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (STAR_LEN[mid] <= u) lo = mid;
    else hi = mid;
  }
  const a = STAR_POLY[lo],
    b = STAR_POLY[(lo + 1) % STAR_POLY.length],
    f = (u - STAR_LEN[lo]) / (STAR_LEN[lo + 1] - STAR_LEN[lo] || 1);
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
}
function starPoints(n: number): Pt[] {
  const out: Pt[] = [];
  let guard = 0;
  while (out.length < n && guard++ < 6000) {
    if (Math.random() < 0.68) out.push(starEdge());
    else {
      const x = rand(-30, 30),
        y = rand(-30, 30);
      if (inStar(x, y)) out.push({ x, y });
    }
  }
  return out;
}
const byAngle = (pts: Pt[]) => pts.sort((a, b) => Math.atan2(a.y, a.x) - Math.atan2(b.y, b.x));
function shapePoints(s: Shape, n: number): Pt[] {
  switch (s.t) {
    case 'moon':
      return moonPoints(n);
    case 'star': {
      const k = s.k ?? 1;
      return starPoints(n).map((q) => ({ x: q.x * k, y: q.y * k }));
    }
    case 'ring':
      return Array.from({ length: n }, () => {
        const a = Math.random() * TAU,
          r = rand(s.r[0], s.r[1]);
        return { x: Math.cos(a) * r, y: Math.sin(a) * r };
      });
    case 'at': {
      const j = s.j ?? 0;
      return Array.from({ length: n }, () => ({ x: s.x + rand(-j, j), y: s.y + rand(-j, j) }));
    }
  }
}

/* ---------- 粒子与特效 ---------- */
type Part =
  | {
      k: 'move';
      x0: number;
      y0: number;
      x1: number;
      y1: number;
      qx: number;
      qy: number;
      t0: number;
      dur: number;
      r: number;
      col: string;
      fo: number;
    }
  | {
      k: 'drift' | 'grav';
      x0: number;
      y0: number;
      vx: number;
      vy: number;
      g: number;
      t0: number;
      life: number;
      r: number;
      col: string;
    };
/* 持续的特效和一次性的光点、光环。kill：开始淡出的时刻（0.32 秒） */
interface Ent {
  kind: FxName | 'ring' | 'pulse';
  t0: number;
  fin: number;
  kill: number;
  fixed?: number;
  /** 发射器：下一次放粒子的时刻 */
  next?: number;
  every?: number;
  p?: number;
  n?: number;
  /** 一次性的：位置、颜色、寿命 */
  x?: number;
  y?: number;
  r?: number;
  r0?: number;
  r1?: number;
  w?: number;
  a?: number;
  col?: string;
  dur?: number;
}
const KILL_MS = 320;
/* 持续特效淡入的默认时长（毫秒） */
const FIN: Partial<Record<FxName, number>> = { motes: 500, scan: 400, redglow: 200 };

interface G {
  dot(x: number, y: number, r: number, a: number, col: string): void;
  ring(r: number, w: number, a: number, col: string): void;
  arc(r: number, a0: number, a1: number, w: number, a: number, col: string): void;
}

class BadgeCanvas {
  readonly id: number;
  private cv: OffscreenCanvas;
  private ctx: OffscreenCanvasRenderingContext2D;
  /** 画布的边长（CSS 像素，徽记边长的 3 倍），和每个单位（徽记的 1/100）多少 CSS 像素 */
  private W: number;
  private k: number;
  private px = 1;
  private minR: number;
  private parts: Part[] = [];
  private ents: Ent[] = [];
  /** 有新内容、尺寸变了：至少再画一帧（只有固定的静态内容时，画完就不再请求帧） */
  private dirty = true;
  frames = 0;

  constructor(id: number, cv: OffscreenCanvas, s: number, dpr: number) {
    this.id = id;
    this.cv = cv;
    this.ctx = cv.getContext('2d')!;
    this.W = s * 3;
    this.k = s / 100;
    this.minR = s < 30 ? 1.5 : 1.3;
    this.resize(dpr);
  }
  resize(dpr: number) {
    /* 画布的像素尺寸取整，按取整后的比例画：CSS 尺寸是整数，缩放 110%、125% 时画面也不糊、不留边 */
    this.cv.width = Math.round(this.W * dpr);
    this.cv.height = Math.round(this.W * dpr);
    this.px = this.cv.width / this.W;
    this.dirty = true;
  }
  stats(): BadgeStats {
    return { id: this.id, frames: this.frames, parts: this.parts.length, fx: this.ents.length };
  }
  reset() {
    this.parts = [];
    this.ents = [];
    this.dirty = true;
  }
  stop() {
    const now = clk();
    for (const e of this.ents) if (!e.kill) e.kill = now;
  }
  run(op: Op) {
    switch (op.op) {
      case 'move': {
        const from = shapePoints(op.from, op.n),
          to = shapePoints(op.to, op.n);
        if (op.sort) {
          byAngle(from);
          byAngle(to);
        }
        this.move(from, to, op);
        break;
      }
      case 'drift':
        this.drift(op.x, op.y, op);
        break;
      case 'flash':
        this.parts.push({
          k: 'drift',
          x0: op.x,
          y0: op.y,
          vx: 0,
          vy: 0,
          g: 0,
          t0: clk(),
          life: op.life ?? 240,
          r: op.r,
          col: C[op.col],
        });
        break;
      case 'pulse':
        this.ents.push({
          kind: 'pulse',
          t0: clk(),
          fin: 0,
          kill: 0,
          x: op.x,
          y: op.y,
          r: op.r,
          col: C[op.col],
          dur: op.dur,
        });
        break;
      case 'ring':
        this.ents.push({
          kind: 'ring',
          t0: clk(),
          fin: 0,
          kill: 0,
          r0: op.r0,
          r1: op.r1,
          w: op.w,
          a: op.a,
          col: C[op.col],
          dur: op.dur,
        });
        break;
      case 'shatter': {
        const now = clk();
        for (const q of starPoints(op.n))
          this.parts.push({
            k: 'grav',
            x0: q.x,
            y0: q.y,
            vx: q.x * rand(0.4, 1.2) + rand(-10, 10),
            vy: rand(-45, -5),
            g: 170,
            t0: now,
            life: rand(1100, 1600),
            r: rand(1, 2),
            col: pick(GROUPS.shatter),
          });
        break;
      }
      case 'fx': {
        const fixed = op.fixed;
        const fin = op.fin ?? (fixed != null ? 0 : (FIN[op.fx] ?? 0));
        const now = clk();
        this.ents.push({
          kind: op.fx,
          t0: now,
          fin,
          kill: 0,
          fixed,
          next: now,
          every: op.every,
          p: op.p,
          n: op.n,
        });
        break;
      }
    }
    this.dirty = true;
  }
  private move(from: Pt[], to: Pt[], o: Extract<Op, { op: 'move' }>) {
    const now = clk();
    const n = Math.min(from.length, to.length);
    const cols = GROUPS[o.cols];
    for (let i = 0; i < n; i++) {
      const a = from[i],
        b = to[(i + (o.shift || 0)) % n];
      const mx = (a.x + b.x) / 2,
        my = (a.y + b.y) / 2;
      const ang = Math.atan2(my, mx) + (o.swirl || 0.8);
      const rr = Math.hypot(mx, my) * 1.15 + 8;
      this.parts.push({
        k: 'move',
        x0: a.x,
        y0: a.y,
        x1: b.x,
        y1: b.y,
        qx: Math.cos(ang) * rr,
        qy: Math.sin(ang) * rr,
        t0: now + (o.delay || 0) + Math.random() * (o.stagger || 0),
        dur: rand(o.dur[0], o.dur[1]),
        r: rand(o.r[0], o.r[1]),
        col: pick(cols),
        fo: o.fo == null ? 0.8 : o.fo,
      });
    }
  }
  private drift(x: number, y: number, o: Extract<Op, { op: 'drift' }>) {
    const now = clk();
    const cols = GROUPS[o.cols];
    for (let i = 0; i < o.n; i++) {
      const ang =
        o.ang != null ? o.ang + rand(-(o.spread || 0.5), o.spread || 0.5) : Math.random() * TAU;
      const sp = rand(o.sp[0], o.sp[1]);
      const j = o.jit || 0;
      this.parts.push({
        k: o.g ? 'grav' : 'drift',
        x0: x + rand(-j, j),
        y0: y + rand(-j, j),
        vx: Math.cos(ang) * sp,
        vy: Math.sin(ang) * sp - (o.up || 0),
        g: o.g || 0,
        t0: now + (o.delay || 0),
        life: rand(o.life[0], o.life[1]),
        r: rand(o.r[0], o.r[1]),
        col: pick(cols),
      });
    }
  }

  /* 持续的特效怎么画 */
  private drawEnt(e: Ent, now: number, g: G, f: number) {
    switch (e.kind) {
      case 'ring': {
        const t = (now - e.t0) / e.dur!;
        if (t >= 1) return false;
        const q = easeOut(t);
        g.ring(e.r0! + (e.r1! - e.r0!) * q, e.w! * (1 - 0.6 * t), e.a! * (1 - t) * f, e.col!);
        return true;
      }
      case 'pulse': {
        const t = (now - e.t0) / e.dur!;
        if (t >= 1) return false;
        g.dot(e.x!, e.y!, e.r!, Math.sin(Math.PI * t) * 0.9 * f, e.col!);
        return true;
      }
      case 'motes': {
        const t = e.fixed ?? now;
        const list: [number, number, number, number, number, string][] = [
          [62, 18, -0.5, 1300, 0, C.pale],
          [55, 25, 0.8, 1900, 2.1, C.white],
          [68, 13, 0.15, 2600, 4.2, C.gold],
        ];
        for (const [rx, ry, tl, per, ph, col] of list) {
          const a0 = ph + (t / per) * TAU,
            ct = Math.cos(tl),
            stl = Math.sin(tl);
          for (let j = 11; j >= 0; j--) {
            const a = a0 - j * 0.085,
              x = rx * Math.cos(a),
              y = ry * Math.sin(a);
            const front = Math.sin(a) > 0;
            const al = (j === 0 ? 1 : (1 - j / 12) * 0.6) * (front ? 1 : 0.45) * f;
            g.dot(
              x * ct - y * stl,
              x * stl + y * ct,
              (j === 0 ? 2.8 : 1.8 * (1 - j / 14)) * (front ? 1 : 0.75),
              al,
              col,
            );
          }
        }
        return true;
      }
      case 'scan': {
        const t = e.fixed ?? now;
        const a = (t / 1400) * TAU;
        for (let j = 0; j < 14; j++)
          g.arc(48, a - (j + 1) * 0.075, a - j * 0.075, 2.4, 0.75 * (1 - j / 14) * f, C.tool);
        g.dot(Math.cos(a) * 48, Math.sin(a) * 48, 2, f, C.toolp);
        if (e.fixed == null && !e.kill && now >= e.next!) {
          if (now - e.next! > 500) e.next = now;
          this.ents.push({
            kind: 'ring',
            t0: now,
            fin: 0,
            kill: 0,
            r0: 30,
            r1: 68,
            w: 1.6,
            a: 0.55,
            col: C.tool,
            dur: 850,
          });
          e.next! += 1400;
        }
        return true;
      }
      case 'redglow':
        g.dot(0, 6, 3.4, (0.45 + 0.3 * Math.sin(now / 260)) * f, C.red);
        return true;
      case 'tipsWait':
        for (let i = 0; i < 6; i++) {
          const a = i * 1.05 + 0.4;
          g.dot(Math.cos(a) * 64, Math.sin(a) * 64, 1.4, 0.7, C.pale);
        }
        return true;
      case 'tipsReply':
        g.dot(0, -41, 4.4, 0.9, C.flare);
        g.dot(41, 0, 3.4, 0.7, C.flare);
        return true;
      case 'charge': {
        /* 星尘从四周往弯月里聚 */
        if (!e.kill)
          this.emit(e, now, () => {
            const a = Math.random() * TAU,
              r = rand(62, 80),
              q = moonPoints(1)[0];
            if (q)
              this.move(
                [{ x: Math.cos(a) * r, y: Math.sin(a) * r }],
                [{ x: q.x * 0.9, y: q.y * 0.9 }],
                {
                  op: 'move',
                  from: { t: 'moon' },
                  to: { t: 'moon' },
                  n: 1,
                  dur: [650, 850],
                  r: [0.8, 1.5],
                  cols: 'spark',
                  swirl: 0.5,
                  fo: 0.7,
                },
              );
          });
        return true;
      }
      case 'rain':
        /* 金粉不断往下落 */
        if (!e.kill)
          this.emit(e, now, () => {
            if (Math.random() < (e.p ?? 1))
              this.drift(rand(-6, 6), rand(26, 38), {
                op: 'drift',
                x: 0,
                y: 0,
                n: many(e.n ?? 1),
                g: 55,
                ang: Math.PI / 2,
                spread: 1.3,
                sp: [6, 22],
                life: [1100, 1700],
                r: [0.8, 1.5],
                cols: 'spark',
              });
          });
        return true;
    }
    return true;
  }
  private emit(e: Ent, now: number, fn: () => void) {
    const every = e.every || 100;
    if (now - e.next! > 500) e.next = now;
    while (now >= e.next!) {
      fn();
      e.next! += every;
    }
  }

  /** 画一帧。返回还要不要下一帧 */
  frame(now: number) {
    this.frames++;
    this.dirty = false;
    const c = this.ctx,
      k = this.k,
      W = this.W,
      h = W / 2;
    c.setTransform(this.px, 0, 0, this.px, 0, 0);
    c.clearRect(0, 0, W, W);
    c.globalCompositeOperation = 'lighter';
    const minR = this.minR;
    const dot = (x: number, y: number, r: number, a: number, col: string) => {
      if (a <= 0.01) return;
      const R = Math.max(r * k * 2.4, minR * 1.8);
      c.globalAlpha = Math.min(1, a);
      c.drawImage(sprite(col), h + x * k - R, h + y * k - R, R * 2, R * 2);
    };
    const g: G = {
      dot,
      ring: (r, w, a, col) => {
        if (a <= 0.01) return;
        c.globalAlpha = Math.min(1, a);
        c.strokeStyle = col;
        c.lineWidth = Math.max(w * k, 0.8);
        c.beginPath();
        c.arc(h, h, r * k, 0, TAU);
        c.stroke();
      },
      arc: (r, a0, a1, w, a, col) => {
        if (a <= 0.01) return;
        c.globalAlpha = Math.min(1, a);
        c.strokeStyle = col;
        c.lineWidth = Math.max(w * k, 0.8);
        c.lineCap = 'round';
        c.beginPath();
        c.arc(h, h, r * k, a0, a1);
        c.stroke();
      },
    };
    const next: Part[] = [];
    for (const pt of this.parts) {
      const el = now - pt.t0;
      if (pt.k === 'move') {
        const t = el / pt.dur;
        if (t < 0) {
          next.push(pt);
          continue;
        }
        if (t >= 1) continue;
        const e = easeInOut(t),
          ie = 1 - e;
        const x = ie * ie * pt.x0 + 2 * ie * e * pt.qx + e * e * pt.x1;
        const y = ie * ie * pt.y0 + 2 * ie * e * pt.qy + e * e * pt.y1;
        const a = t < 0.12 ? t / 0.12 : t > pt.fo ? (1 - t) / (1 - pt.fo) : 1;
        dot(x, y, pt.r * (1 + 0.3 * Math.sin(t * Math.PI)), a, pt.col);
        next.push(pt);
        continue;
      }
      const t = el / pt.life;
      if (t < 0) {
        next.push(pt);
        continue;
      }
      if (t >= 1) continue;
      let x: number, y: number;
      if (pt.k === 'grav') {
        const s = el / 1000;
        x = pt.x0 + pt.vx * s;
        y = pt.y0 + pt.vy * s + 0.5 * pt.g * s * s;
      } else {
        const d = (easeOut(t) * pt.life) / 1000;
        x = pt.x0 + pt.vx * d;
        y = pt.y0 + pt.vy * d;
      }
      dot(x, y, pt.r * (1 - 0.45 * t), Math.pow(1 - t, 1.3) * (t < 0.08 ? t / 0.08 : 1), pt.col);
      next.push(pt);
    }
    this.parts = next;
    /* 发射器会往 ents 里加东西，先拷一份再过滤 */
    const ents = this.ents;
    this.ents = [];
    for (const e of ents) {
      const f0 = e.kill ? 1 - (now - e.kill) / KILL_MS : 1;
      const f = e.fin ? f0 * Math.min(1, Math.max(0, (now - e.t0) / e.fin)) : f0;
      if (f0 <= 0 || this.drawEnt(e, now, g, f) === false) continue;
      this.ents.push(e);
    }
    c.globalAlpha = 1;
    return this.parts.length > 0 || this.ents.some((e) => e.fixed == null || e.kill) || this.dirty;
  }
}

/* ---------- 所有画布的循环 ---------- */
const canvases = new Map<number, BadgeCanvas>();
const active = new Set<BadgeCanvas>();
let raf = 0;
function kick(c: BadgeCanvas) {
  active.add(c);
  if (!raf) raf = self.requestAnimationFrame(loop);
}
function loop() {
  raf = 0;
  const now = clk();
  for (const c of active) if (!c.frame(now)) active.delete(c);
  if (active.size) raf = self.requestAnimationFrame(loop);
}

/** Worker 的 onmessage 里调：认得的消息处理掉，返回 true */
export function badgeMessage(m: { type: string }): m is BadgeMsg {
  if (!m.type.startsWith('bd-')) return false;
  const msg = m as BadgeMsg;
  switch (msg.type) {
    case 'bd-add': {
      canvases.get(msg.id)?.reset();
      const c = new BadgeCanvas(msg.id, msg.canvas, msg.s, msg.dpr);
      canvases.set(msg.id, c);
      break;
    }
    case 'bd-size': {
      const c = canvases.get(msg.id);
      if (c) {
        c.resize(msg.dpr);
        kick(c);
      }
      break;
    }
    case 'bd-del': {
      const c = canvases.get(msg.id);
      if (c) active.delete(c);
      canvases.delete(msg.id);
      break;
    }
    case 'bd-reset': {
      const c = canvases.get(msg.id);
      if (c) {
        c.reset();
        kick(c);
      }
      break;
    }
    case 'bd-stop': {
      const c = canvases.get(msg.id);
      if (c) {
        c.stop();
        kick(c);
      }
      break;
    }
    case 'bd-do': {
      const c = canvases.get(msg.id);
      if (!c) break;
      for (const op of msg.ops) c.run(op);
      kick(c);
      break;
    }
    case 'bd-rate':
      vBase = clk();
      rBase = performance.now();
      rate = msg.rate;
      break;
    case 'bd-stats': {
      const reply: BadgeReply = {
        type: 'bd-stats',
        stats: [...canvases.values()].map((c) => c.stats()),
        rafs: raf ? 1 : 0,
      };
      self.postMessage(reply);
      break;
    }
  }
  return true;
}
