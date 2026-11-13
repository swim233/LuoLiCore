import { badgeFx } from '../../fx/client';
import type { ColKey, FxName, Op } from '../../fx/badge-msg';
import { motionOn, subscribeMotion } from '@luoli/ui/motion';
import { rand } from '@luoli/ui/util';
import { getLook, onLook } from './appearance';
import type { Look, Main } from './appearance';
import {
  COMP_ORBITS,
  COMP_STATIC_TH,
  HOLLOW,
  SAT_ORBIT,
  TAU,
  makeOrbit,
  orbitAt,
  orbitFrames,
} from './geometry';
import type { Orbit } from './geometry';
import { onTimeRate, real, timeRate, vnow } from './timescale';

/* 徽记的控制器：每个徽记一个，命令式地管它的动画、计时器和 Worker 里的画布。
   React 只渲染骨架（Badge.tsx），布局 effect 里创建控制器，卸载时销毁。
   控制器订阅「样子」（appearance.ts），换样子时：
   - 本体（弯月、星星）从此刻的样子用 0.65 秒过渡到新状态的基准姿态（blend），新状态的循环动作都是叠加的（composite: 'add'），从中点开始，
     所以不跳、不停顿；
   - 弯月和星星之间用星尘聚散（粒子在 Worker 里画，主线程只发消息）；
   - 动画只动 transform 和 opacity；变亮用提亮的一层（hot）的透明度，不用 filter。
   看不见的徽记（display:none、visibility:hidden、不在视口里、标签页在后台）不画：拆掉动画和计时器，清掉 Worker 里的画布；重新看得见时直接画当前的样子。
   全屏时被暗层盖住的顶栏、胶囊里的徽记看得见（在暗层后面），照常动画、照常画粒子。
   静态底子：当前的样子（主状态、伴星数、离线）一直写在 .bd 的 data-look、data-comps、data-offline 上（看不见时也写），样式表（styles/app.css）按它画出静止的样子；
   动画和行内样式叠在上面。所以新挂上的徽记、拆掉后重新看得见的徽记、形变用的复制层（cloneNode 会带上这几个属性）不跑脚本，第一帧就是当前的样子；
   控制器接手后，需要「等一会儿再变」的层（弯月和星星的透明度、伴星的出现）用行内样式或动画压住底子，所以底子随样子一变，也不会提前露出来。
   关掉动画（motionOn 为假）时每种状态一张静态图，切换直接换。
   参数照拷问时的演示页（.grill/badge/index.html）。 */

const BLEND = 650;
const EASE_BLEND = 'cubic-bezier(.4,0,.2,1)';
type Group = 's' | 'f' | 'c';

/* 每种状态本体的基准姿态：sti 外层的变换，hot 提亮层的透明度，glint 小卫星的亮度 */
const POSE: Record<Main, { sti: string; hot: number; glint: number }> = {
  idle: { sti: 'none', hot: 0, glint: 0.85 },
  waiting: { sti: 'none', hot: 0, glint: 0.85 },
  thinking: { sti: 'scale(.88)', hot: 0, glint: 0.7 },
  replying: { sti: 'none', hot: 0.1, glint: 0.85 },
  tool: { sti: 'none', hot: 0.05, glint: 0.85 },
  retry: { sti: 'none', hot: 0, glint: 0.85 },
  error: { sti: 'none', hot: 0, glint: 0.85 },
  linger: { sti: 'none', hot: 0.06, glint: 0.85 },
};
/* 金粉的量：演示页的「再多一些」档，1.5 倍 */
const GLITTER = 1.5;
const many = (v: number) => Math.floor(v) + (Math.random() < v % 1 ? 1 : 0);

const satOrbit = makeOrbit(SAT_ORBIT);

/* CSS 在奇异矩阵（缩到 0 的 scale(0)、计算出来的 matrix(0,0,0,0,0,0)）和别的变换之间不做插值，只在进度 50% 时整个翻过去：
   伴星「长出来」「散掉」会在不透明度约 0.5 的那一帧一下子满尺寸、或一下子没了。起点（元素此刻计算出来的值）和终点两端都过一遍：
   缩到肉眼看不见的程度（SING 以下）的，换成 scale(TINY)，两端都能分解，就照常插值，缓动的过冲也在。
   只处理二维的缩放，三维矩阵（rotateY 等）原样放过 */
const SING = 1e-6;
const TINY = 0.002;
function interpolable(t: string) {
  if (!t || t === 'none') return t;
  let m: DOMMatrix;
  try {
    m = new DOMMatrix(t);
  } catch {
    return t;
  }
  return m.is2D && Math.abs(m.a * m.d - m.b * m.c) < SING ? `scale(${TINY})` : t;
}

interface Rt {
  anim: Animation;
  extra?: Animation;
  delay: number;
  orbit: Orbit;
  front: boolean;
}

export class BadgeController {
  readonly root: HTMLElement;
  private readonly s: number;
  private readonly small: boolean;
  private readonly fl: HTMLElement;
  private readonly fl2: HTMLElement;
  private readonly mo: HTMLElement;
  private readonly moonBody: HTMLElement;
  private readonly mhot: HTMLElement;
  private readonly mdim: HTMLElement;
  private readonly cloud: HTMLElement;
  private readonly cloudI: HTMLElement;
  private readonly starW: HTMLElement;
  private readonly sti: HTMLElement;
  private readonly sw: HTMLElement;
  private readonly red: HTMLElement;
  private readonly hot: HTMLElement;
  private readonly sat: HTMLElement;
  private readonly glint: HTMLElement;
  private readonly zl: HTMLElement;
  private readonly compEl: HTMLElement[];
  private readonly compMv: HTMLElement[];
  private readonly compPopEl: HTMLElement[];
  private readonly compStarEl: HTMLElement[];

  /** 看得见吗：在视口里、标签页在前台、没被隐藏（display:none、visibility:hidden） */
  inView = true;
  private visible = false;
  private dead = false;
  private still = !motionOn();
  /** 此刻的样子（一直跟着走），和已经画出来的样子（null：还没画） */
  private look: Look = getLook();
  private shown: Look | null = null;
  private form: 'moon' | 'star' | null = null;
  private shattered = false;
  private off = false;
  /** 云遮月的样式已经按当前画过一次（重建后第一次一定要画） */
  private offReady = false;
  private redOn = false;
  /** 星星在星尘里聚好的时刻（徽记时间）；之前不开始状态的特效 */
  private readyAt = 0;
  private loops: { shine?: Animation; flicker?: Animation } = {};
  private satRt: Rt | null = null;
  private compRt: (Rt | null)[] = [null, null, null];
  private compTarget = [false, false, false];
  /** 三颗伴星的显示状态已经按当前画过一次（重建后第一次三颗都要明确写一遍，用行内样式压住静态底子） */
  private compsReady = false;
  private cloudAnim: Animation | null = null;
  private sparkOn = false;
  private zT: ReturnType<typeof setInterval> | undefined;
  private timers: Record<Group, Set<ReturnType<typeof setTimeout>>> = {
    s: new Set(),
    f: new Set(),
    c: new Set(),
  };
  private cv: HTMLCanvasElement | null = null;
  private id = 0;
  private readonly offs: (() => void)[] = [];

  constructor(root: HTMLElement, size: number) {
    this.root = root;
    this.s = size;
    this.small = size < 30;
    const q = (c: string) => root.querySelector<HTMLElement>('.' + c)!;
    const qa = (c: string) => Array.from(root.querySelectorAll<HTMLElement>('.' + c));
    this.fl = q('bd-fl');
    this.fl2 = q('bd-fl2');
    this.mo = q('bd-mo');
    this.moonBody = q('bd-mb');
    this.mhot = q('bd-mhot');
    this.mdim = q('bd-mdim');
    this.cloud = q('bd-cloud');
    this.cloudI = q('bd-cloud-i');
    this.starW = q('bd-starw');
    this.sti = q('bd-sti');
    this.sw = q('bd-sw');
    this.red = q('bd-red');
    this.hot = q('bd-hot');
    this.sat = q('bd-sat');
    this.glint = q('bd-glint');
    this.zl = q('bd-zs');
    this.compEl = qa('bd-comp');
    this.compMv = qa('bd-cmv');
    this.compPopEl = qa('bd-cpop');
    this.compStarEl = qa('bd-cstar');
    this.offs.push(
      onLook((l) => this.onLook(l)),
      subscribeMotion(() => {
        const still = !motionOn();
        if (still === this.still) return;
        this.still = still;
        /* 开关动画：立刻停成静态图（或直接接上当前样子），不留残影 */
        if (this.visible) this.rebuild();
      }),
      onTimeRate((r) => {
        root.getAnimations({ subtree: true }).forEach((a) => a.updatePlaybackRate(r));
      }),
    );
    this.mark(this.look);
    ALL.add(this);
    io.observe(root);
    this.refresh();
  }

  destroy() {
    this.dead = true;
    ALL.delete(this);
    io.unobserve(this.root);
    this.offs.forEach((f) => f());
    this.teardown();
    if (this.id) badgeFx.del(this.id);
    this.cv?.remove();
    this.cv = null;
    this.id = 0;
  }

  /* ---------- 看得见吗 ---------- */
  /** 重新判断看不看得见，变了就重建或拆掉 */
  refresh() {
    if (this.dead) return;
    this.setVisible(this.computeVisible());
  }
  private computeVisible() {
    const el = this.root;
    if (document.hidden || !this.inView || !el.isConnected) return false;
    return el.checkVisibility({
      checkVisibilityCSS: true,
      visibilityProperty: true,
    } as CheckVisibilityOptions);
  }
  private setVisible(v: boolean) {
    if (v === this.visible) return;
    this.visible = v;
    if (v) this.rebuild();
    else this.teardown();
  }
  /** 从头按当前的样子画，不放切换动画（刚看得见、开关动画、挂上时） */
  private rebuild() {
    this.teardown();
    if (!this.still) this.startFloat();
    this.look = getLook();
    this.applyLook(this.look, true);
  }
  /** 拆掉所有动画、计时器、Worker 里的粒子，回到没画过的样子 */
  private teardown() {
    this.clear('s');
    this.clear('f');
    this.clear('c');
    clearInterval(this.zT);
    this.zT = undefined;
    this.sparkOn = false;
    this.root.getAnimations({ subtree: true }).forEach((a) => a.cancel());
    for (const el of [
      this.fl,
      this.fl2,
      this.mo,
      this.moonBody,
      this.mhot,
      this.mdim,
      this.cloud,
      this.cloudI,
      this.starW,
      this.sti,
      this.sw,
      this.red,
      this.hot,
      this.sat,
      this.glint,
      ...this.compEl,
      ...this.compMv,
      ...this.compPopEl,
      ...this.compStarEl,
    ])
      el.style.cssText = '';
    this.zl.replaceChildren();
    this.shown = null;
    this.form = null;
    this.shattered = false;
    this.off = false;
    this.offReady = false;
    this.redOn = false;
    this.readyAt = 0;
    this.loops = {};
    this.satRt = null;
    this.compRt = [null, null, null];
    this.compTarget = [false, false, false];
    this.compsReady = false;
    this.cloudAnim = null;
    if (this.id) badgeFx.reset(this.id);
  }

  /* ---------- 小工具：计时器、动画、粒子消息 ---------- */
  private later(fn: () => void, ms: number, g: Group = 's') {
    const set = this.timers[g];
    const t = setTimeout(() => {
      set.delete(t);
      fn();
    }, real(ms));
    set.add(t);
    return t;
  }
  private every(fn: () => void, ms: number, g: Group = 's') {
    const t = setInterval(fn, real(ms));
    this.timers[g].add(t);
    return t;
  }
  private clear(g: Group) {
    this.timers[g].forEach((t) => {
      clearTimeout(t);
      clearInterval(t);
    });
    this.timers[g].clear();
  }
  /** 创建动画：开发模式慢放时按倍率设 playbackRate */
  private anim(el: Element, kf: Keyframe[], o: KeyframeAnimationOptions) {
    const a = el.animate(kf, o);
    const r = timeRate();
    if (r !== 1) a.playbackRate = r;
    return a;
  }
  /** 正弦式的往复：从中点开始（add 时中点是恒等），没有跳变 */
  private wave(el: Element, a: string, b: string, dur: number, add: boolean) {
    return this.anim(el, [{ transform: a }, { transform: b }], {
      duration: dur,
      iterations: Infinity,
      direction: 'alternate',
      easing: 'ease-in-out',
      composite: add ? 'add' : 'replace',
      delay: -dur / 2,
    });
  }
  /** 叠加的循环 */
  private add(el: Element, kf: Keyframe[], dur: number, o: KeyframeAnimationOptions = {}) {
    return this.anim(el, kf, { duration: dur, iterations: Infinity, composite: 'add', ...o });
  }
  /** 把动画的此刻的样子写成行内样式再取消（接着从当前样子往下演） */
  private settle(el: HTMLElement) {
    el.getAnimations().forEach((a) => {
      try {
        a.commitStyles();
      } catch {
        /* 元素没渲染出来时不能 commit */
      }
      a.cancel();
    });
  }
  /*
   * 本体的衔接：把元素从「此刻的样子」（含正在跑的所有动作）用 BLEND 毫秒平滑带到新状态的基准姿态，
   * 新状态的动作都用 composite: 'add' 叠在上面、从中点（恒等）开始，所以换状态时位置、亮度都不会跳。
   */
  private blend(
    el: HTMLElement,
    to: Record<string, string>,
    inst: boolean,
    dur = BLEND,
    easing = EASE_BLEND,
  ) {
    const cs = getComputedStyle(el);
    const from: Keyframe = {};
    for (const k of Object.keys(to)) {
      const v = cs.getPropertyValue(k) || cs[k as never];
      from[k] = k === 'transform' ? interpolable(v) : v;
    }
    el.getAnimations().forEach((a) => a.cancel());
    for (const k of Object.keys(to)) el.style.setProperty(k, inst ? to[k] : '');
    if (inst) return;
    const end = to.transform === undefined ? to : { ...to, transform: interpolable(to.transform) };
    this.anim(el, [from, end], { duration: dur, easing, fill: 'forwards' });
  }
  private fx(ops: Op[]) {
    if (!this.visible || this.dead || !ops.length) return;
    this.ensureCanvas();
    badgeFx.post(this.id, ops);
  }
  /** 画布：第一次要画粒子时才创建，交给 Worker */
  private ensureCanvas() {
    if (this.cv) return;
    const cv = document.createElement('canvas');
    cv.className = 'bd-fx';
    cv.setAttribute('aria-hidden', 'true');
    const W = this.s * 3;
    cv.style.cssText = `width:${W}px;height:${W}px;left:${-this.s}px;top:${-this.s}px`;
    this.root.appendChild(cv);
    this.cv = cv;
    this.id = badgeFx.add(cv, this.s);
  }
  private drift(x: number, y: number, o: Omit<Extract<Op, { op: 'drift' }>, 'op' | 'x' | 'y'>): Op {
    return { op: 'drift', x, y, ...o };
  }
  private burst(n: number, cols: ColKey, sp: [number, number] = [40, 80]): Op {
    return this.drift(0, 0, { n, sp, life: [550, 900], r: [1.2, 2.2], cols });
  }

  /* ---------- 换样子 ---------- */
  private onLook(l: Look) {
    this.look = l;
    if (this.visible) this.applyLook(l, false);
    else this.mark(l);
  }
  /** 当前的样子写在 .bd 的属性上，样式表据此画静态底子（看不见时也写）。要放在换样子的衔接动画读完起点之后写，所以在 applyLook 的最后 */
  private mark(l: Look) {
    const d = this.root.dataset;
    d.look = l.main;
    d.comps = String(l.comps);
    if (l.offline) d.offline = '';
    else delete d.offline;
  }
  private applyLook(look: Look, inst: boolean) {
    try {
      this.applyLookInner(look, inst);
    } finally {
      this.mark(look);
    }
  }
  private applyLookInner(look: Look, instIn: boolean) {
    const inst = instIn || this.still || this.shown === null;
    const prev = this.shown;
    this.shown = look;
    this.setComps(look.comps, inst);
    this.setOff(look.offline, inst);
    if (prev && prev.main === look.main) return;
    const st = look.main;
    this.clear('s');
    this.stopFx(inst);
    if (st !== 'idle') this.hushZ(inst);
    const want = st === 'idle' || st === 'waiting' ? 'moon' : 'star';
    /* 出错后碎掉的星星，下一个状态重新聚出来 */
    const restore = this.shattered && want === 'star' && this.form === 'star';
    this.body(st, inst);
    if (restore) {
      this.shattered = false;
      if (!inst) this.appearStar();
      else this.starW.style.cssText = 'opacity:1';
    }
    if (st === 'idle' && this.form === 'star' && !inst) {
      /* 星星散回弯月（回复完留够了、中止、出错后、离线） */
      this.shattered = false;
      this.toForm('moon', false);
      this.startZ(2300);
      return;
    }
    this.shattered = false;
    this.toForm(want, inst);
    if (this.still) {
      this.staticDecor(st);
      return;
    }
    if (st === 'idle') {
      this.startZ(inst ? 900 : 2300);
      return;
    }
    if (st === 'linger') {
      if (!inst) this.finishFlash();
      return;
    }
    const wait = inst ? 0 : Math.max(this.readyAt - vnow(), 0);
    if (wait > 0) this.later(() => this.startFx(st, false), wait);
    else this.startFx(st, inst);
  }
  /** 旧状态的光点、扫描弧等淡出（0.32 秒），不再立刻消失 */
  private stopFx(inst: boolean) {
    if (this.id) {
      if (inst) badgeFx.reset(this.id);
      else badgeFx.stop(this.id);
    }
    if (this.redOn) {
      this.redOn = false;
      this.blend(this.red, { opacity: '0' }, inst, 350, 'ease');
    }
  }
  private body(st: Main, inst: boolean) {
    const P = POSE[st];
    this.blend(this.sti, { transform: P.sti, opacity: '1' }, inst);
    this.blend(this.sw, { transform: 'none' }, inst);
    this.blend(this.moonBody, { transform: 'none' }, inst);
    this.blend(this.hot, { opacity: String(P.hot) }, inst);
    this.blend(this.glint, { opacity: String(P.glint) }, inst);
    /* 等待合并：弯月醒着，亮一些 */
    this.blend(this.mhot, { opacity: st === 'waiting' ? '1' : '0' }, inst, 900, 'ease');
    this.loops = {};
    if (this.still) return;
    const O = 'cubic-bezier(.61,1,.88,1)',
      I = 'cubic-bezier(.12,0,.39,0)';
    if (st === 'waiting') {
      /* 一阵阵发抖 */
      this.add(
        this.moonBody,
        [
          { transform: 'rotate(0deg) translateX(0)' },
          { transform: 'rotate(-3deg) translateX(-1%)', offset: 0.06 },
          { transform: 'rotate(2.5deg) translateX(1%)', offset: 0.12 },
          { transform: 'rotate(-2deg) translateX(-.8%)', offset: 0.18 },
          { transform: 'rotate(1.5deg) translateX(.6%)', offset: 0.24 },
          { transform: 'rotate(0deg) translateX(0)', offset: 0.3 },
          { transform: 'rotate(0deg) translateX(0)' },
        ],
        1300,
      );
    } else if (st === 'thinking') {
      this.wave(this.sti, 'translateY(3%) scale(.98)', 'translateY(-3%) scale(1.02)', 2400, true);
      this.wave(this.sti, 'rotate(-5deg)', 'rotate(5deg)', 3100, true);
      this.add(this.glint, [{ opacity: -0.35 }, { opacity: 0.15 }], 1300, {
        direction: 'alternate',
        easing: 'ease-in-out',
        delay: -650,
      });
    } else if (st === 'replying') {
      /* 随风轻摇：绕上方一点摆（两层周期叠加），整颗慢慢侧过身；侧向光的一边时亮一下 */
      this.wave(this.sw, 'rotate(-4.5deg)', 'rotate(4.5deg)', 2700, true);
      this.wave(this.sw, 'rotate(-2deg)', 'rotate(2deg)', 4300, true);
      this.add(
        this.sti,
        [
          { transform: 'rotateY(0deg)', easing: O },
          { transform: 'rotateY(24deg)', offset: 0.25, easing: I },
          { transform: 'rotateY(0deg)', offset: 0.5, easing: O },
          { transform: 'rotateY(-24deg)', offset: 0.75, easing: I },
          { transform: 'rotateY(0deg)' },
        ],
        6600,
      );
      this.loops.shine = this.add(
        this.hot,
        [
          { opacity: 0 },
          { opacity: 0.26, offset: 0.25 },
          { opacity: 0, offset: 0.5 },
          { opacity: -0.08, offset: 0.75 },
          { opacity: 0 },
        ],
        6600,
        { easing: 'ease-in-out' },
      );
    } else if (st === 'tool') {
      this.wave(this.sti, 'scale(.975)', 'scale(1.025)', 700, true);
    } else if (st === 'retry') {
      /* 接触不良：都是相对基准的增量（opacity 减多少、scale 乘多少）；再亮起时提亮层闪一下 */
      this.loops.flicker = this.add(
        this.sti,
        [
          { opacity: 0, transform: 'scale(1)' },
          { opacity: -0.7, offset: 0.05 },
          { opacity: 0, offset: 0.1 },
          { opacity: -0.8, offset: 0.15 },
          { opacity: -0.15, offset: 0.2 },
          { opacity: -0.75, transform: 'scale(1)', offset: 0.27 },
          { opacity: -0.7, transform: 'scale(.78)', offset: 0.5 },
          { opacity: -0.7, transform: 'scale(.78)', offset: 0.7 },
          { opacity: 0, transform: 'scale(1.14)', offset: 0.78 },
          { opacity: 0, transform: 'scale(1)' },
        ],
        1700,
      );
      this.add(
        this.hot,
        [
          { opacity: 0 },
          { opacity: 0, offset: 0.74 },
          { opacity: 0.7, offset: 0.78 },
          { opacity: 0 },
        ],
        1700,
      );
    } else if (st === 'linger') {
      this.wave(this.sw, 'translateY(2.5%)', 'translateY(-2.5%)', 1600, true);
    }
  }
  private finishFlash() {
    this.anim(
      this.sti,
      [
        { transform: 'scale(1)' },
        { transform: 'scale(1.16)', offset: 0.28 },
        { transform: 'scale(1)' },
      ],
      { duration: 650, easing: 'ease-out', composite: 'add' },
    );
    this.anim(this.hot, [{ opacity: 0 }, { opacity: 0.9, offset: 0.28 }, { opacity: 0 }], {
      duration: 650,
      easing: 'ease-out',
      composite: 'add',
    });
    this.fx([
      this.burst(this.small ? 10 : 22, 'spark', [60, 115]),
      { op: 'ring', r0: 28, r1: 78, w: 2.4, a: 0.8, col: 'pale', dur: 750 },
    ]);
  }

  /* ---------- 形态：弯月、星星 ---------- */
  private dissolve(el: HTMLElement, target: number, over: HTMLElement, peak: number) {
    this.settle(el);
    const cur = parseFloat(getComputedStyle(el).opacity);
    this.anim(
      el,
      [
        { opacity: cur, transform: 'scale(1)' },
        { opacity: cur, transform: 'scale(1.05)', offset: 0.3 },
        { opacity: target, transform: target ? 'scale(1)' : 'scale(.9)' },
      ],
      { duration: 480, easing: 'ease-in', fill: 'forwards' },
    );
    /* 变亮一下：提亮层的透明度，不用 filter */
    this.anim(over, [{ opacity: 0 }, { opacity: peak, offset: 0.3 }, { opacity: 0 }], {
      duration: 480,
      easing: 'ease-in',
      composite: 'add',
    });
  }
  private appearStar() {
    const st = this.starW;
    this.settle(st);
    const cur = parseFloat(getComputedStyle(st).opacity);
    this.satStart();
    this.anim(
      st,
      [
        { opacity: cur, transform: 'scale(.72) rotate(-35deg)' },
        { opacity: 1, transform: 'scale(1.08) rotate(4deg)', offset: 0.55 },
        { opacity: 1, transform: 'scale(1) rotate(0deg)' },
      ],
      { duration: 600, easing: 'cubic-bezier(.2,.7,.2,1)', fill: 'forwards' },
    );
    this.anim(this.hot, [{ opacity: 0.9 }, { opacity: 0.6, offset: 0.55 }, { opacity: 0 }], {
      duration: 600,
      easing: 'cubic-bezier(.2,.7,.2,1)',
      composite: 'add',
    });
    this.fx([this.burst(this.small ? 6 : 12, 'spark')]);
  }
  private appearMoon() {
    const mo = this.mo;
    this.settle(mo);
    const cur = parseFloat(getComputedStyle(mo).opacity);
    this.anim(
      mo,
      [
        { opacity: cur, transform: 'scale(.92)' },
        { opacity: 1, transform: 'scale(1)' },
      ],
      {
        duration: 800,
        easing: 'cubic-bezier(.2,.7,.2,1)',
        fill: 'forwards',
      },
    );
    this.anim(this.mhot, [{ opacity: 0.9 }, { opacity: 0 }], {
      duration: 800,
      easing: 'cubic-bezier(.2,.7,.2,1)',
      composite: 'add',
    });
  }
  private toForm(to: 'moon' | 'star', inst: boolean) {
    const from = this.form;
    if (from === to) return;
    this.form = to;
    this.clear('f');
    const now = vnow();
    if (inst || from === null || this.still) {
      this.settle(this.mo);
      this.settle(this.starW);
      this.mo.style.cssText = 'opacity:' + (to === 'moon' ? 1 : 0);
      this.starW.style.cssText = 'opacity:' + (to === 'star' ? 1 : 0);
      this.readyAt = 0;
      if (to === 'star') this.satStart();
      else this.satStop();
      return;
    }
    const n = this.small ? 26 : 60;
    const toStar = to === 'star';
    if (toStar) this.dissolve(this.mo, 0, this.mhot, 1);
    else this.dissolve(this.starW, 0, this.hot, 0.55);
    this.fx([
      {
        op: 'move',
        from: toStar ? { t: 'moon' } : { t: 'star' },
        to: toStar ? { t: 'star' } : { t: 'moon' },
        n,
        sort: true,
        delay: 80,
        stagger: toStar ? 280 : 300,
        dur: toStar ? [700, 900] : [950, 1250],
        r: [1.2, 2.3],
        cols: toStar ? 'goldS' : 'dustGold',
        swirl: toStar ? 0.9 : -0.8,
        shift: (n / 6) | 0,
        fo: toStar ? 0.78 : 0.72,
      },
    ]);
    if (toStar) {
      this.later(() => this.appearStar(), 900, 'f');
      this.readyAt = now + 1450;
    } else {
      this.later(() => this.satStop(), 520, 'f');
      this.later(() => this.appearMoon(), 1080, 'f');
      this.readyAt = now + 1900;
    }
  }

  /* ---------- 离线：云遮月 ---------- */
  private setOff(off: boolean, inst: boolean) {
    const was = this.off;
    if (off === was && this.offReady) return;
    this.offReady = true;
    this.off = off;
    this.blend(this.cloud, { opacity: off ? '.96' : '0' }, inst, 1100, 'ease');
    this.blend(this.mdim, { opacity: off ? '.5' : '0' }, inst, 900, 'ease');
    if (off && !this.still) {
      if (!this.cloudAnim)
        this.cloudAnim = this.wave(this.cloudI, 'translateX(-7%)', 'translateX(7%)', 6000, false);
    } else if (this.cloudAnim) {
      const a = this.cloudAnim;
      this.cloudAnim = null;
      if (inst) a.cancel();
      else this.later(() => a.cancel(), 1100, 'c');
    }
    if (off && !was) this.hushZ(inst);
    if (was && !off && !inst && !this.still)
      /* 重新连上：弯月旁飘起一点星尘 */
      this.fx([
        this.drift(-4, 4, {
          n: this.small ? 5 : 10,
          sp: [25, 55],
          up: 10,
          life: [600, 900],
          r: [1, 1.8],
          cols: 'dustWhite',
        }),
      ]);
  }

  /* ---------- 伴星：几个会话同时回复，每多一个会话多一颗 ---------- */
  private setComps(n: number, inst: boolean) {
    const init = !this.compsReady;
    this.compsReady = true;
    for (let i = 0; i < 3; i++) {
      const on = i < n;
      if (on === this.compTarget[i] && !init) continue;
      this.compTarget[i] = on;
      if (inst || this.still) {
        if (on) this.compStart(i, true);
        this.compPop(i, on, true);
        if (!on) this.compStop(i);
        continue;
      }
      if (on) {
        /* 主星飘出一缕星尘，在伴星的位置聚成它 */
        this.compStart(i);
        const q = this.compPos(i, 560);
        const m = this.small ? 7 : 14;
        this.fx([
          {
            op: 'move',
            from: { t: 'star', k: 0.6 },
            to: { t: 'at', x: q.x, y: q.y, j: 6 },
            n: m,
            dur: [520, 720],
            stagger: 120,
            r: [0.9, 1.6],
            cols: 'spark',
            swirl: 0.6,
            fo: 0.75,
          },
        ]);
        this.later(() => this.compTarget[i] && this.compPop(i, true, false), 560, 'c');
      } else {
        /* 伴星散成星尘 */
        const q = this.compPos(i, 0);
        this.compPop(i, false, false);
        this.fx([
          this.drift(q.x, q.y, {
            n: this.small ? 4 : 8,
            sp: [18, 42],
            life: [500, 850],
            r: [0.8, 1.5],
            cols: 'spark',
          }),
        ]);
        this.later(() => !this.compTarget[i] && this.compStop(i), 450, 'c');
      }
    }
  }
  private compPop(i: number, on: boolean, inst: boolean) {
    this.blend(
      this.compPopEl[i],
      { opacity: on ? '1' : '0', transform: on ? 'none' : 'scale(0)' },
      inst,
      on ? 450 : 350,
      on ? 'cubic-bezier(.3,1.6,.5,1)' : 'ease-in',
    );
  }
  /** 伴星的轨道动画：出现时才开始，散掉后停掉。inst：从静止的位置（COMP_STATIC_TH）接着转，不跳；否则从随机的位置开始 */
  private compStart(i: number, inst = false) {
    if (this.compRt[i] || this.still) return;
    const o = makeOrbit({ ...COMP_ORBITS[i], ph: inst ? COMP_STATIC_TH[i] : rand(0, TAU) });
    const delay = inst ? 0 : -rand(0, o.per);
    const anim = this.anim(this.compMv[i], orbitFrames(o, this.s), {
      duration: o.per,
      iterations: Infinity,
      delay,
    });
    const extra = this.anim(this.compStarEl[i], [{ opacity: 0.62 }, { opacity: 1 }], {
      duration: rand(1100, 2200),
      iterations: Infinity,
      direction: 'alternate',
      easing: 'ease-in-out',
      delay: -rand(0, 2200),
    });
    const front = orbitAt(o, -delay / o.per).front;
    this.compRt[i] = { anim, extra, delay, orbit: o, front };
    this.compEl[i].style.zIndex = front ? '4' : '1';
    this.zStart();
    this.sparkStart();
  }
  private compStop(i: number) {
    const rt = this.compRt[i];
    if (!rt) return;
    rt.anim.cancel();
    rt.extra?.cancel();
    this.compRt[i] = null;
    this.compEl[i].style.zIndex = '';
    this.zStopIfIdle();
  }
  /** 伴星 ahead 毫秒（真实时间）之后的位置，徽记坐标 */
  private compPos(i: number, ahead: number) {
    const rt = this.compRt[i];
    if (!rt) return { x: 0, y: 0 };
    const ct = Number(rt.anim.currentTime ?? 0) + ahead * timeRate();
    const p = orbitAt(rt.orbit, (ct - rt.delay) / rt.orbit.per);
    return { x: p.x, y: p.y };
  }
  /** 不定时挑一颗伴星自己亮一下，掉一点金粉 */
  private sparkStart() {
    if (this.sparkOn) return;
    this.sparkOn = true;
    const tick = () => {
      if (!this.sparkOn) return;
      this.later(
        () => {
          this.compSpark();
          tick();
        },
        rand(1100, 2400),
        'c',
      );
    };
    this.later(tick, rand(600, 1800), 'c');
  }
  private compSpark() {
    const on = [0, 1, 2].filter((i) => this.compRt[i] && this.compTarget[i]);
    if (!on.length) {
      this.sparkOn = false;
      return;
    }
    const q = this.compPos(on[Math.floor(Math.random() * on.length)], 0);
    this.fx([
      { op: 'pulse', x: q.x, y: q.y, r: this.small ? 2.6 : 3.4, col: 'flare', dur: 560 },
      this.drift(q.x, q.y + 3, {
        n: 1,
        g: 45,
        ang: Math.PI / 2,
        spread: 1.1,
        sp: [4, 14],
        life: [900, 1300],
        r: [0.7, 1.2],
        cols: 'sparkGP',
        delay: 150,
      }),
    ]);
  }

  /* ---------- 小卫星：一直绕着主星转（只在星星显示的时候） ---------- */
  private satStart() {
    /* 关掉动画时停在右上角：样式表里的静态底子就是那个位置 */
    if (this.satRt || this.still) return;
    const anim = this.anim(this.sat, orbitFrames(satOrbit, '%'), {
      duration: satOrbit.per,
      iterations: Infinity,
    });
    this.satRt = { anim, delay: 0, orbit: satOrbit, front: true };
    this.sat.style.zIndex = '2';
    this.zStart();
  }
  private satStop() {
    this.satRt?.anim.cancel();
    this.satRt = null;
    this.sat.style.cssText = '';
    this.zStopIfIdle();
  }
  /** 转到后面时压到主星下面：每 70 毫秒看一眼，前后变了才改 z-index（不用动画改 z-index） */
  private zStart() {
    if (this.zT) return;
    this.zT = setInterval(() => this.zTick(), real(70));
  }
  private zStopIfIdle() {
    if (this.satRt || this.compRt.some(Boolean)) return;
    clearInterval(this.zT);
    this.zT = undefined;
  }
  private frontOf(rt: Rt) {
    const ct = Number(rt.anim.currentTime ?? 0);
    return orbitAt(rt.orbit, (ct - rt.delay) / rt.orbit.per).front;
  }
  private zTick() {
    const s = this.satRt;
    if (s) {
      const f = this.frontOf(s);
      if (f !== s.front) {
        s.front = f;
        this.sat.style.zIndex = f ? '2' : '0';
      }
    }
    this.compRt.forEach((c, i) => {
      if (!c) return;
      const f = this.frontOf(c);
      if (f !== c.front) {
        c.front = f;
        this.compEl[i].style.zIndex = f ? '4' : '1';
      }
    });
  }

  /* ---------- 弯月的浮动 ---------- */
  private startFloat() {
    this.wave(this.fl, 'translateY(4.5%)', 'translateY(-4.5%)', 2500, false);
    this.wave(this.fl2, 'rotate(-5deg)', 'rotate(4deg)', 2500, false);
  }

  /* ---------- 状态里的粒子、光点、定时的小事件 ---------- */
  /** 动画循环里按进度触发：anim 每转一圈，到 marks 里的位置时调用 fn(序号) */
  private sync(anim: Animation, period: number, marks: number[], fn: (i: number) => void) {
    let last = -1;
    this.every(() => {
      const ct = anim.currentTime;
      if (ct == null) return;
      const t = (Number(ct) % period) / period;
      if (last >= 0)
        marks.forEach((m, i) => {
          if (last <= t ? m > last && m <= t : m > last || m <= t) fn(i);
        });
      last = t;
    }, 30);
  }
  private fxOn(fx: FxName, o: { fin?: number; every?: number; p?: number; n?: number } = {}) {
    this.fx([{ op: 'fx', fx, ...o }]);
  }
  /** 尖上慢慢亮起再暗下去，飘出几点金粉 */
  private softFlare(deg: number, n: number) {
    const a = (deg * Math.PI) / 180,
      x = Math.cos(a) * 41,
      y = Math.sin(a) * 41,
      sm = this.small;
    const ops: Op[] = [{ op: 'pulse', x, y, r: sm ? 3.6 : 4.8, col: 'flare', dur: 640 }];
    if (n > 0)
      ops.push(
        this.drift(x, y, {
          n,
          ang: a,
          spread: 0.45,
          sp: [26, 58],
          up: 5,
          life: [750, 1150],
          r: [0.9, 1.6],
          cols: 'spark',
          delay: 160,
        }),
      );
    this.fx(ops);
  }
  private glitter(n: number): Op[] {
    return n > 0
      ? [
          this.drift(rand(-6, 6), rand(26, 38), {
            n,
            g: 55,
            ang: Math.PI / 2,
            spread: 1.3,
            sp: [6, 22],
            life: [1100, 1700],
            r: [0.8, 1.5],
            cols: 'spark',
          }),
        ]
      : [];
  }
  private startFx(st: Main, inst: boolean) {
    const sm = this.small;
    const fin = inst ? { fin: 0 } : {};
    if (st === 'waiting') {
      this.fxOn('charge', { every: sm ? 130 : 70 });
    } else if (st === 'thinking') {
      this.fxOn('motes', fin);
    } else if (st === 'replying') {
      if (this.loops.shine)
        this.sync(this.loops.shine, 6600, [0.22, 0.28], (i) =>
          this.softFlare(i === 0 ? 0 : -90, i === 0 ? many((sm ? 2 : 3) * GLITTER) : 0),
        );
      const gust = () => {
        const s = rand(0.7, 1.15);
        this.anim(
          this.sw,
          [0, 8, -5.2, 3, -1.6, 0.6, 0].map((v, i) => ({
            transform: `rotate(${(v * s).toFixed(2)}deg)`,
            offset: [0, 0.14, 0.32, 0.5, 0.68, 0.84, 1][i],
            easing: 'ease-in-out',
          })),
          { duration: 2600, composite: 'add' },
        );
        this.later(() => this.fx(this.glitter(many((sm ? 2 : 4) * GLITTER))), 260);
        this.later(gust, rand(3600, 6000));
      };
      this.later(gust, rand(1200, 2200));
      this.fxOn('rain', { every: 620, p: 0.7, n: (sm ? 1 : 1.2) * GLITTER });
    } else if (st === 'tool') {
      this.fxOn('scan', fin);
    } else if (st === 'retry') {
      if (this.loops.flicker)
        this.sync(this.loops.flicker, 1700, [0.76], () =>
          this.fx([
            { op: 'ring', r0: 30, r1: 72, w: 2, a: 0.8, col: 'amber', dur: 700 },
            this.burst(sm ? 4 : 9, 'amber', [50, 95]),
          ]),
        );
    } else if (st === 'error') {
      if (inst) {
        /* 刚挂上、刚看得见时直接是碎完以后的样子：星星没了，留一点红光 */
        this.settle(this.starW);
        this.starW.style.cssText = 'opacity:0';
        this.shattered = true;
        this.fxOn('redglow', { fin: 0 });
        return;
      }
      this.redOn = true;
      this.blend(this.red, { opacity: '.9' }, false, 350, 'ease');
      this.anim(
        this.sti,
        [
          { transform: 'translateX(0)' },
          { transform: 'translateX(-7%) rotate(-6deg)', offset: 0.15 },
          { transform: 'translateX(7%) rotate(6deg)', offset: 0.35 },
          { transform: 'translateX(-5%) rotate(-4deg)', offset: 0.55 },
          { transform: 'translateX(4%) rotate(3deg)', offset: 0.75 },
          { transform: 'translateX(0)' },
        ],
        { duration: 520, easing: 'ease-in-out', composite: 'add' },
      );
      this.later(() => {
        this.shattered = true;
        this.settle(this.starW);
        this.anim(
          this.starW,
          [
            { opacity: 1, transform: 'scale(1)' },
            { opacity: 0, transform: 'scale(1.06)' },
          ],
          {
            duration: 260,
            fill: 'forwards',
          },
        );
        this.anim(this.hot, [{ opacity: 0 }, { opacity: 0.6 }], {
          duration: 260,
          composite: 'add',
        });
        this.fx([
          { op: 'shatter', n: sm ? 26 : 56 },
          { op: 'fx', fx: 'redglow' },
        ]);
      }, 560);
    }
  }
  /** 关掉动画时：每种状态一张静止的图 */
  private staticDecor(st: Main) {
    this.zl.replaceChildren();
    const fixed = (fx: FxName, v: number) => this.fx([{ op: 'fx', fx, fixed: v }]);
    if (st === 'idle') {
      if (!this.off) {
        const z = document.createElement('span');
        z.className = 'z static';
        z.textContent = 'z';
        z.style.fontSize = Math.max(this.s * 0.26, 8) + 'px';
        z.style.left = ((HOLLOW.x + 10) * this.s) / 100 + 'px';
        z.style.top = ((HOLLOW.y - 14) * this.s) / 100 + 'px';
        this.zl.appendChild(z);
      }
      return;
    }
    if (st === 'error') {
      this.red.style.opacity = '.9';
      this.redOn = true;
    } else if (st === 'waiting') fixed('tipsWait', 1);
    else if (st === 'thinking') fixed('motes', 700);
    else if (st === 'replying') fixed('tipsReply', 1);
    else if (st === 'tool') fixed('scan', -260);
    else if (st === 'retry') this.sti.style.opacity = '.55';
  }

  /* ---------- zzz：待机的弯月每 6 秒冒一组 z，飘到头碎成星尘 ---------- */
  private startZ(delay: number) {
    const group = () => {
      for (let i = 0; i < 3; i++) this.later(() => this.spawnZ(i), i * 700);
    };
    this.later(() => {
      group();
      this.every(group, 6000);
    }, delay);
  }
  private hushZ(inst: boolean) {
    for (const el of Array.from(this.zl.children) as HTMLElement[]) {
      if (inst) {
        el.remove();
        continue;
      }
      const op = getComputedStyle(el).opacity;
      el.getAnimations().forEach((a) => a.pause());
      const a = this.anim(el, [{ opacity: Number(op) }, { opacity: 0 }], {
        duration: 260,
        fill: 'forwards',
      });
      a.onfinish = () => el.remove();
    }
  }
  private spawnZ(i: number) {
    if (
      !this.visible ||
      this.shown?.main !== 'idle' ||
      this.form !== 'moon' ||
      this.off ||
      this.still
    )
      return;
    const s = this.s;
    let fs = s * [0.2, 0.26, 0.34][i];
    if (this.small) fs = Math.max(fs, 7 + i * 1.3);
    const sx = (HOLLOW.x * s) / 100,
      sy = (HOLLOW.y * s) / 100;
    const dx = Math.max(s * 0.3, 9) + i * s * 0.03,
      dy = -Math.max(s * 0.6, 16);
    const dur = 2600 * 0.86;
    const el = document.createElement('span');
    el.className = 'z';
    el.textContent = i === 2 ? 'Z' : 'z';
    el.style.fontSize = fs.toFixed(1) + 'px';
    el.style.left = sx + 'px';
    el.style.top = sy + 'px';
    this.zl.appendChild(el);
    const T = (x: number, y: number, sc: number, rot: number) =>
      `translate(-50%,-50%) translate(${x.toFixed(1)}px,${y.toFixed(1)}px) scale(${sc}) rotate(${rot}deg)`;
    const a = this.anim(
      el,
      [
        { offset: 0, opacity: 0, transform: T(0, 0, 0.5, -14) },
        { offset: 0.17, opacity: 1, transform: T(dx * 0.14, dy * 0.15, 0.75, -6) },
        { offset: 0.58, opacity: 0.95, transform: T(dx * 0.62, dy * 0.5, 0.95, 4) },
        { offset: 0.93, opacity: 0.9, transform: T(dx * 0.8, dy * 0.8, 1.08, -2) },
        { offset: 1, opacity: 0, transform: T(dx * 0.86, dy * 0.86, 1.2, 0) },
      ],
      { duration: dur, easing: 'cubic-bezier(.3,.55,.45,1)', fill: 'forwards' },
    );
    a.onfinish = () => el.remove();
    this.later(() => {
      if (this.shown?.main !== 'idle' || this.off) return;
      const x = HOLLOW.x + (dx * 0.84 * 100) / s,
        y = HOLLOW.y + (dy * 0.84 * 100) / s;
      this.fx([
        this.drift(x, y, {
          n: this.small ? 3 : 5,
          sp: [10, 26],
          up: 6,
          jit: (fs * 0.25 * 100) / s,
          life: [650, 950],
          r: [0.9, 1.6],
          cols: 'dust',
        }),
      ]);
    }, dur * 0.88);
  }
}

/* ---------- 全部徽记共用：看得见吗 ---------- */
const ALL = new Set<BadgeController>();
const io = new IntersectionObserver(
  (ents) => {
    for (const e of ents) {
      const c = [...ALL].find((b) => b.root === e.target);
      if (!c) continue;
      c.inView = e.isIntersecting;
      c.refresh();
    }
  },
  { rootMargin: '80px' },
);
const refreshAll = () => ALL.forEach((c) => c.refresh());
document.addEventListener('visibilitychange', refreshAll);
/* 部件被藏起来、露出来（形变里的 data-hide、data-lifted，class 里的 is-hidden-for-anim、is-lifted、is-placeholder-float）不会触发交叉观察：
   监听这几个属性，变的元素里有徽记就马上重新判断（在浏览器画下一帧之前）。另有一个低频的兜底 */
const hideAttrs = new MutationObserver((recs) => {
  for (const r of recs) for (const c of ALL) if (r.target.contains(c.root)) return refreshAll();
});
hideAttrs.observe(document.body, {
  attributes: true,
  subtree: true,
  attributeFilter: ['data-hide', 'data-lifted', 'class', 'hidden'],
});
setInterval(() => {
  if (!document.hidden && ALL.size) refreshAll();
}, 1000);
