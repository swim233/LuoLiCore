import { useLayoutEffect, useRef } from 'react';
import { motion } from 'motion/react';
import { animate, cancelFrame, frame, motionValue, type MotionValue } from 'motion';
import { realignSky } from '../components/bubble-sky';
import { createStore, useStore } from '../lib/store';
import { clamp } from '../lib/util';
import { cssBezier, EASE_MORPH } from '../lib/easing';
import { fpsMeter } from '../lib/fps';
import { freezeAt, SLOW } from '../lib/debug';
import { createShell } from './shell';

/* 外框的做法：?frame=layout 用 Motion 的 layout 动画（两个并列的 layout 元素，对比用）；?frame=pieces 用只动 transform、opacity 的小件（默认） */
const DEFAULT_FRAME: 'layout' | 'pieces' = 'pieces';
const FRAME_MODE = new URLSearchParams(location.search).get('frame') || DEFAULT_FRAME;
export const PIECES = FRAME_MODE === 'pieces';
/* ?reverse=snap：反向用原来干脆折返的做法（整段时长、同一条缓动、不带速度），留给对比。默认是带着速度、按距离缩放时长的 glide */
export const REVERSE_SNAP = new URLSearchParams(location.search).get('reverse') === 'snap';
/* 反向的最短时长（毫秒）：按要走的距离缩放，但不短于这个 */
export const REV_MIN = 180;
/* 往目标方向接着走时，起点斜率（以 d 为单位）的上限：超过 3，Hermite 会冲过目标 */
const REV_FWD_SLOPE = 3;
/* 往回折时，转折前外框多往原方向走的距离上限（占整段行程的比例）。开头就按 Esc 要马上收回，多走一截会让人觉得 Esc 没反应：
   至少 2%（约 20 px）；还要走的距离 |d| 大、速度快的时候（几十毫秒内硬折回会像一下子弹回去）放宽到 0.15·|d|，取两者里大的 */
const REV_OVERSHOOT = 0.02;
const REV_OVERSHOOT_REL = 0.15;
/* 为了满足上面的限制缩短后的时长，不短于这个（毫秒，乘 SLOW），约两帧 */
const REV_SHRINK_MIN = 30;

/* ---------- 形变舞台 ----------
   一次形变 = 一个外框（Motion 的 layout 动画）+ 若干内容层（旧内容、新内容）+ 暗层等。
   - 外框（MorphFrame）：一个 position: fixed 的盒子，起点矩形渲染一次，再换成终点矩形，Motion 的 layout 动画做 transform 缩放，
     圆角由 Motion 校正；边线不能校正，用外层盒子的 1px 内边距画（外层是边线色，里面一层是底色，两层各自是 layout 元素，圆角各自校正）。
   - 内容层（旧内容是复制的 DOM，新内容是全屏窗口或复制的新元素）：每一帧读外框此刻的矩形，等比缩放、居中放进去，透明度和模糊由外框的进度 g 决定。
     g 也是从外框的矩形反推的：外框、内容、暗层任何一帧都在同一个进度上，反向时一起退回。 */
export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}
export interface FrameSpec extends Rect {
  radius: number;
  bg: string; // 不透明的底色
  bd: string; // 不透明的边线色（半透明的边线色事先压在底色上）
  opacity: number;
}
export interface LayerSpec {
  el: HTMLElement; // 整层（挂 transform）
  rect: Rect; // 它自己排版的矩形
  tgt?: HTMLElement; // 接透明度和模糊的那一层（默认 el.firstElementChild）
  role: 'in' | 'out';
  blur: number; // 屏幕上看到的最大模糊半径
  win: [number, number];
  maxS: number;
  /** 局部进度的起点：中途改去别的目标时新加的层，从加进来的那一刻（进度 from）起才开始出现；undefined 就是整段 */
  from?: number;
  /** 中途改去别的目标时，这一层要淡出：记下改道那一刻的进度，之后的透明度再乘上 (1 − 淡出量) */
  fades?: number[];
  at?: (g: number) => Rect;
}
export interface MorphRec {
  key: number;
  id: string;
  host: 'ghosts' | 'fs';
  dur: number;
  /** 起点和终点：进度 p 从 A 走到 B（按创建时的方向）；反向就是 p 走回 A */
  A: FrameSpec;
  B: FrameSpec;
  /** 现在要去的那端：1 去 B，0 回 A */
  dir: 0 | 1;
  layers: LayerSpec[];
  /** 跟着外框走的内容层以外的小件（光晕、胶囊的底纹）：挂进内容层容器，形变结束时一起移除 */
  extras: HTMLElement[];
  /** 每一帧收到进度 p（0 在起点，1 在终点），用来驱动暗层、光晕、图标条这些不跟矩形走的东西 */
  drivers: ((g: number) => void)[];
  /** 到达某一端（0 起点、1 终点）时调用；完成后外框和复制的内容层都会被移除 */
  settle: (dir: 0 | 1) => void;
  kind?: string;
  /** 桌面上的形变：起点（重排之前）是哪种样子（card、now、cap）；反向时用来判断新的操作是不是把它变回去 */
  beforeKind?: string;
  /** 桌面上的形变：终点是哪种样子；faceTarget 为真表示终点矩形就是那个真实元素的位置（可以跟着它走） */
  afterKind?: string;
  faceTarget?: boolean;
  /** 桌面上的形变期间藏着的那个真实元素（反向时换成新的那个） */
  hide?: HTMLElement;
  /** 外框的矩形不动（切换部件）：进度由计时给，不从矩形反推 */
  timeDriven?: boolean;
  pv?: MotionValue<number>;
  pAnim?: { stop: () => void };
  pTarget?: number;
  shell?: { update: (p: number, R?: Rect) => void };
  /** 终点跟着真实元素走：别的重排把它的位置挪了，外框不跳，平滑地落到它此刻的位置上（off 是改道那一刻的差，随进度走到 1 衰减成 0） */
  fb?: { rect: Rect; off: Rect; p0: number } | null;
  frameEl?: HTMLElement | null;
  layersHost?: HTMLElement | null;
  dead?: boolean;
  g: number;
  doneTimer?: ReturnType<typeof setTimeout>;
  startTimer?: number;
  go: boolean;
}
export const morphStore = createStore<{ list: MorphRec[]; rev: number }>({ list: [], rev: 0 });
let keySeq = 0;
export const sstep = (x: number, a: number, b: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
/* 胶囊和全屏窗口的长宽比差十几倍：胶囊的内容最多放大到 1.25 倍、晚一点才浮出来 */
export const CAP_MAX = 1.25;
export function lay(
  el: HTMLElement,
  rect: Rect,
  role: 'in' | 'out',
  o: Partial<LayerSpec> = {},
): LayerSpec {
  return Object.assign(
    {
      el,
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      role,
      blur: role === 'out' ? 8 : 10,
      win: [0.16, 0.7] as [number, number],
      maxS: Infinity,
    },
    o,
  );
}
export const capLay = (el: HTMLElement, rect: Rect, role: 'in' | 'out') =>
  lay(
    el,
    rect,
    role,
    role === 'out'
      ? { win: [0, 0.4], blur: 6, maxS: CAP_MAX }
      : { win: [0.4, 0.84], blur: 6, maxS: CAP_MAX },
  );

export const dirOf = (m: MorphRec) => m.dir;
/* 还有动画在走吗：形变、桌面卡片让位的 layout 动画（relayout 里记下它会走到什么时候）、拖动副本飞回。
   「动画」开关在这时候拨，新设置要等它们都走完才生效：否则 html 上的 .still（所有过渡变成 .12 秒）会立刻套在逐帧写的小件上，速度突变，拨回来又跳一次 */
let busyUntil = 0;
export const markBusy = (ms: number) => {
  busyUntil = Math.max(busyUntil, performance.now() + ms);
};
export const motionBusy = () =>
  morphStore.get().list.some((m) => !m.dead) || performance.now() < busyUntil;
const active = () => morphStore.get().list;
export function findMorph(pred: (m: MorphRec) => boolean) {
  return active().find((m) => !m.dead && pred(m));
}

/* 外框在两端矩形之间走到哪了：用四条边的位置反推（外框动画对每条边都是同一条缓动，所以每条边的进度都一样） */
function progressOf(m: MorphRec, R: DOMRect) {
  const a = [m.A.left, m.A.top, m.A.left + m.A.width, m.A.top + m.A.height];
  const b = [m.B.left, m.B.top, m.B.left + m.B.width, m.B.top + m.B.height];
  const r = [R.left, R.top, R.right, R.bottom];
  let num = 0,
    den = 0;
  for (let i = 0; i < 4; i++) {
    const d = b[i] - a[i];
    num += (r[i] - a[i]) * d;
    den += d * d;
  }
  return den < 1e-6 ? m.dir : clamp(num / den, 0, 1);
}

function applyLayer(L: LayerSpec, R: Rect, g: number) {
  const gl =
    L.from === undefined ? g : L.from >= 0.999 ? 0 : clamp((g - L.from) / (1 - L.from), 0, 1);
  const b = L.at ? L.at(gl) : R;
  const s = Math.min(b.width / L.rect.width, b.height / L.rect.height, L.maxS);
  const x = b.left + (b.width - L.rect.width * s) / 2 - L.rect.left;
  const y = b.top + (b.height - L.rect.height * s) / 2 - L.rect.top;
  const q = sstep(gl, L.win[0], L.win[1]);
  let o = L.role === 'out' ? 1 - q : q;
  let bl = (L.role === 'out' ? q : (1 - q) * (1 - q)) * L.blur;
  if (L.fades) {
    for (const p0 of L.fades) {
      const f = sstep(p0 >= 0.999 ? 1 : clamp((g - p0) / (1 - p0), 0, 1), 0, 0.6);
      o *= 1 - f;
      bl = Math.max(bl, f * L.blur);
    }
  }
  L.el.style.transform = `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px) scale(${s.toFixed(4)})`;
  const t = L.tgt || (L.el.firstElementChild as HTMLElement) || L.el;
  t.style.opacity = o < 0.004 ? '0' : o > 0.996 ? '1' : o.toFixed(3);
  t.style.filter = bl > 0.08 ? `blur(${(bl / s).toFixed(2)}px)` : 'none';
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/* 终点此刻在哪：普通情况就是 B；跟着真实元素走时，是它现在的位置加上改道那一刻留下的差（差随进度走到 1 衰减成 0，反向时保持原样） */
function bAt(m: MorphRec, p: number): Rect {
  const fb = m.fb;
  if (!fb) return m.B;
  const r = fb.rect;
  const f = p >= fb.p0 ? (fb.p0 >= 0.999 ? 0 : (1 - p) / (1 - fb.p0)) : 1;
  return {
    left: r.left + fb.off.left * f,
    top: r.top + fb.off.top * f,
    width: r.width + fb.off.width * f,
    height: r.height + fb.off.height * f,
  };
}
function frameRectAt(m: MorphRec, p: number): Rect {
  const B = bAt(m, p);
  return {
    left: lerp(m.A.left, B.left, p),
    top: lerp(m.A.top, B.top, p),
    width: lerp(m.A.width, B.width, p),
    height: lerp(m.A.height, B.height, p),
  };
}
/* 终点换成新的矩形 r（别的重排把那个真实元素挪到了这里，用重排之后的最终位置，不读正在位移的元素）：
   从此刻起外框的矩形不变，之后平滑地落到 r 上 */
export function followTarget(m: MorphRec, r: Rect) {
  if (m.dead) return;
  const p = clamp(m.pv!.get(), 0, 1);
  const cur = bAt(m, p);
  m.fb = {
    rect: r,
    p0: p,
    off: {
      left: cur.left - r.left,
      top: cur.top - r.top,
      width: cur.width - r.width,
      height: cur.height - r.height,
    },
  };
}
let loopOn = false;
/* 立刻按此刻的进度把所有层的样式写一遍（新加的层要在浏览器画下一帧之前就位，不然会闪一帧） */
export function applyNow() {
  tick();
}
function tick() {
  const list = active();
  let any = false;
  for (const m of list) {
    if (m.dead || !m.frameEl) continue;
    any = true;
    const g = clamp(m.pv!.get(), 0, 1);
    const R = frameRectAt(m, g);
    const dbg = (window as Window & { __morphDebug?: unknown[] }).__morphDebug;
    if (dbg) dbg.push([performance.now(), g, progressOf(m, m.frameEl.getBoundingClientRect())]);
    m.g = g;
    const rr = R;
    for (const L of m.layers) applyLayer(L, rr, g);
    m.shell?.update(g, R);
    for (const d of m.drivers) d(g);
  }
  if (!any && !list.some((m) => !m.dead)) stopLoop();
}
function startLoop() {
  if (loopOn) return;
  loopOn = true;
  frame.postRender(tick, true);
}
function stopLoop() {
  if (!loopOn) return;
  loopOn = false;
  cancelFrame(tick);
}

export function startMorph(
  spec: Omit<MorphRec, 'key' | 'dir' | 'g' | 'go' | 'dead' | 'extras'> & { extras?: HTMLElement[] },
): MorphRec {
  spec.dur *= SLOW;
  const m: MorphRec = Object.assign(spec, {
    extras: spec.extras || [],
    key: ++keySeq,
    dir: 1 as 0 | 1,
    g: 0,
    go: false,
    dead: false,
  });
  m.pv = motionValue(0);
  fpsMeter.begin();
  morphStore.set((s) => ({ list: [...s.list, m], rev: s.rev + 1 }));
  return m;
}
/* 反向（或再反向）：外框从此刻的位置走向新的那一端，内容层跟着走 */
export function setDir(m: MorphRec, dir: 0 | 1) {
  if (m.dead || m.dir === dir) return;
  m.dir = dir;
  m.go = true;
  clearTimeout(m.doneTimer);
  m.pTarget = undefined;
  if (PIECES) {
    if (REVERSE_SNAP) snap(m);
    else glide(m);
  } else {
    m.doneTimer = setTimeout(() => finishMorph(m, m.dir), m.dur + 260);
    setTimeout(() => {
      if (!m.dead && m.pTarget !== m.dir) runTime(m);
    }, 100);
  }
  morphStore.set((s) => ({ list: [...s.list], rev: s.rev + 1 }));
}
/* 从此刻的进度、带着此刻的速度走向 m.dir 那一端。
   时长按要走的距离缩放（整段 × 距离），不短于 REV_MIN；曲线是三次 Hermite：起点的斜率等于此刻的速度，终点斜率 0。
   速度朝着目标就接着往前走，背着目标就先往原方向再冲一点点（动量）再折回来，不会在转折那一帧速度突变。
   起点斜率 s = v·D/d 不截断：s 和 D 成正比，起点速度 d·s/D = v，所以任何一条限制（见下）都靠缩短 D 来满足，D 缩短、s 跟着等比变小，起点速度不变。
   限制：往目标方向走时 s ≤ 3（再大会冲过目标）；往回折时冲出去的量不超过 REV_OVERSHOOT 那一档，也不超过原方向剩下的距离的 90%（不冲出 0~1 的范围）。
   缩短时可以低于 REV_MIN：开头按 Esc 本来就该很快收回，减速更急，但起点速度不变，速度仍然连续 */
function hermite(s: number) {
  return (t: number) => s * (t * t * t - 2 * t * t + t) + (-2 * t * t * t + 3 * t * t);
}
export function glide(m: MorphRec) {
  const pv = m.pv!;
  const target = m.dir;
  const p0 = clamp(pv.get(), 0, 1);
  const v = pv.getVelocity();
  m.pAnim?.stop();
  m.pTarget = target;
  const d = target - p0;
  if (freezeAt() >= 0) {
    clearTimeout(m.doneTimer);
    pv.set(freezeAt());
    return;
  }
  if (Math.abs(d) < 0.003) {
    m.pAnim = undefined;
    requestAnimationFrame(() => finishMorph(m, target));
    return;
  }
  let D = Math.max(REV_MIN * SLOW, m.dur * Math.abs(d)) / 1000;
  const head = v > 0 ? 1 - p0 : p0; // 往原方向冲，最多冲到范围的边
  const cap = Math.min(head * 0.9, Math.max(REV_OVERSHOOT, REV_OVERSHOOT_REL * Math.abs(d)));
  const dMin = (REV_SHRINK_MIN * SLOW) / 1000;
  let sl = (v * D) / d;
  for (let i = 0; i < 24; i++) {
    if (sl > REV_FWD_SLOPE) {
      D = (REV_FWD_SLOPE * Math.abs(d)) / Math.abs(v);
      sl = REV_FWD_SLOPE;
      break;
    }
    const e = hermite(sl);
    let mn = 0;
    for (let k = 1; k <= 80; k++) mn = Math.min(mn, e(k / 80));
    const over = -mn * Math.abs(d);
    if (over <= cap || D <= dMin) break;
    /* 冲出量大致和 D 成正比：按超出的比例缩短（每次至少缩 10%、最多缩到 30%），几次就收敛 */
    D = Math.max(dMin, D * clamp((0.9 * cap) / over, 0.3, 0.9));
    sl = (v * D) / d;
  }
  clearTimeout(m.doneTimer);
  m.doneTimer = setTimeout(() => finishMorph(m, m.dir), D * 1000 + 260);
  m.pAnim = animate(pv, target, {
    duration: D,
    ease: hermite(sl),
    onComplete: () => finishMorph(m, target),
  });
}
/* 原来的反向：从此刻的值出发，整段时长、同一条缓动曲线，不带速度（起步斜率不是 0，转折那一帧速度突变） */
function snap(m: MorphRec) {
  const pv = m.pv!;
  const target = m.dir;
  m.pAnim?.stop();
  m.pTarget = target;
  if (freezeAt() >= 0) {
    clearTimeout(m.doneTimer);
    pv.set(freezeAt());
    return;
  }
  clearTimeout(m.doneTimer);
  m.doneTimer = setTimeout(() => finishMorph(m, m.dir), m.dur + 260);
  m.pAnim = animate(pv, target, {
    duration: m.dur / 1000,
    ease: EASE_MORPH,
    onComplete: () => finishMorph(m, target),
  });
}
/* 进度的计时和外框的 layout 动画同一帧启动（外框动画开始时的回调里启动它；万一外框没有动画，100 ms 后兜底自己启动）。小件外框第一次直接启动 */
function runTime(m: MorphRec, fromLayout = false) {
  if (freezeAt() >= 0) {
    clearTimeout(m.doneTimer);
    m.pv!.set(freezeAt());
    return;
  }
  if (m.pTarget === m.dir && m.pAnim && !fromLayout) return;
  m.pTarget = m.dir;
  m.pAnim?.stop();
  m.pAnim = animate(m.pv!, m.dir, {
    duration: m.dur / 1000,
    ease: EASE_MORPH,
    onComplete: () => finishMorph(m, m.dir),
  });
}

/* 等某一类形变都结束了再做某件事（现在没有就马上做）。用来把「会让桌面重排的操作」排在形变后面，或者排在「先退回」后面 */
const waiters: { match: (m: MorphRec) => boolean; fn: () => void }[] = [];
export function whenMorphsDone(match: (m: MorphRec) => boolean, fn: () => void) {
  if (!active().some((m) => !m.dead && match(m))) {
    fn();
    return;
  }
  waiters.push({ match, fn });
}
function runWaiters() {
  for (const w of [...waiters]) {
    if (active().some((m) => !m.dead && w.match(m))) continue;
    waiters.splice(waiters.indexOf(w), 1);
    try {
      w.fn();
    } catch (e) {
      console.error(e);
    }
  }
}
/* 到达一端：清理外框和内容层，回调收尾 */
export function finishMorph(m: MorphRec, dir: 0 | 1 = m.dir) {
  if (m.dead) return;
  m.dead = true;
  clearTimeout(m.doneTimer);
  m.pAnim?.stop();
  fpsMeter.end();
  for (const L of m.layers) {
    L.el.style.willChange = '';
    const t = L.tgt || (L.el.firstElementChild as HTMLElement);
    if (t) {
      t.style.willChange = '';
      t.style.opacity = '';
      t.style.filter = '';
    }
    L.el.style.transform = '';
  }
  morphStore.set((s) => ({ list: s.list.filter((x) => x !== m), rev: s.rev + 1 }));
  try {
    m.settle(dir);
  } catch (e) {
    console.error(e);
  }
  m.drivers.forEach((d) => d(dir));
  m.layers.forEach((L) => {
    if (L.el.dataset.clone === '1') L.el.remove();
  });
  m.extras.forEach((e) => e.remove());
  runWaiters();
}
/* 立刻收尾到现在要去的那一端（别的操作要接着走，来不及等） */
export function settleAll() {
  for (const m of [...active()]) finishMorph(m, m.dir);
}

/* 外框：两个并列的 layout 元素（不是父子）：外面一个是边线色，里面一个缩进 1px 是底色。
   两个元素的矩形各自从起点动画到终点，缓动、时长相同，所以任何一帧里里面那个都正好比外面那个小 1px 一圈：边线始终 1px，圆角各自由 Motion 校正。
   （试过父子嵌套：Motion 会让子元素保持自己最终的大小、不跟着父元素缩放，不是想要的） */
function MorphFrame({ m }: { m: MorphRec }) {
  const dur = m.dur / 1000;
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    m.frameEl = ref.current;
    startLoop();
    tick();
    /* 起点矩形渲染过一次了，下一帧换成终点矩形，Motion 从起点动画到终点 */
    const raf = requestAnimationFrame(() => {
      if (m.dead) return;
      m.go = true;
      m.dir = 1;
      m.doneTimer = setTimeout(() => finishMorph(m, m.dir), m.dur + 260);
      setTimeout(() => {
        if (!m.dead && m.pTarget !== m.dir) runTime(m);
      }, 100);
      morphStore.set((s) => ({ list: [...s.list], rev: s.rev + 1 }));
    });
    return () => cancelAnimationFrame(raf);
  }, [m]);
  const r = m.go ? (m.dir ? m.B : m.A) : m.A;
  const tr = `${dur}s ${cssBezier(EASE_MORPH)}`;
  const t = { layout: { duration: dur, ease: EASE_MORPH } };
  return (
    <>
      <motion.div
        ref={ref}
        layout
        className="mf"
        data-morph={m.id}
        style={{
          left: r.left,
          top: r.top,
          width: r.width,
          height: r.height,
          borderRadius: r.radius,
          background: r.bd,
          opacity: r.opacity,
          willChange: 'transform',
          transition: `background-color ${tr}, opacity ${tr}`,
        }}
        transition={t}
        onLayoutAnimationStart={() => {
          if (m.go) runTime(m, true);
        }}
        onLayoutAnimationComplete={() => {
          if (m.go && !m.dead) finishMorph(m, m.dir);
        }}
      />
      <motion.div
        layout
        className="mf mf-in"
        style={{
          left: r.left + 1,
          top: r.top + 1,
          width: Math.max(0, r.width - 2),
          height: Math.max(0, r.height - 2),
          borderRadius: Math.max(0, r.radius - 1),
          background: r.bg,
          opacity: r.opacity,
          willChange: 'transform',
          transition: `background-color ${tr}, opacity ${tr}`,
        }}
        transition={t}
      />
    </>
  );
}

function PieceFrame({ m }: { m: MorphRec }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    m.shell = createShell(ref.current!, m.A, m.B);
    m.frameEl = ref.current;
    startLoop();
    tick();
    const raf = requestAnimationFrame(() => {
      if (m.dead) return;
      m.go = true;
      m.dir = 1;
      m.doneTimer = setTimeout(() => finishMorph(m, m.dir), m.dur + 260);
      runTime(m);
    });
    return () => cancelAnimationFrame(raf);
  }, [m]);
  return <div className="fs-shell" ref={ref} />;
}
function MorphWrap({ m }: { m: MorphRec }) {
  const ref = useRef<HTMLDivElement>(null);
  /* 内容层和小件挂进容器：要等 MorphFrame 和这个容器的 ref 都就位，所以放在父元素的 layout effect 里 */
  useLayoutEffect(() => {
    const host = ref.current;
    if (!host) return;
    m.layersHost = host;
    for (const e of m.extras) host.append(e);
    for (const L of m.layers) {
      if (L.el.parentNode !== host && L.el.dataset.clone === '1') {
        host.append(L.el);
        (L.el as HTMLElement & { _restore?: () => void })._restore?.();
        realignSky(L.el);
      }
      L.el.style.willChange = 'transform';
      (L.tgt || (L.el.firstElementChild as HTMLElement) || L.el).style.willChange =
        'opacity, filter';
    }
    tick();
  }, [m]);
  return (
    <div className="mf-wrap">
      {FRAME_MODE === 'pieces' ? <PieceFrame m={m} /> : <MorphFrame m={m} />}
      <div className="mf-layers" ref={ref} />
    </div>
  );
}

export function MorphHost({ host }: { host: 'ghosts' | 'fs' }) {
  const list = useStore(morphStore, (s) => s.list).filter((m) => m.host === host);
  return (
    <>
      {list.map((m) => (
        <MorphWrap key={m.key} m={m} />
      ))}
    </>
  );
}
