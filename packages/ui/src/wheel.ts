/* 滚轮缓动的数学（不碰 DOM；找滚动区、挂监听的部分在 scroll/install-wheel.ts）。
   鼠标滚轮滚一格时内容不是跳过去，而是带着缓动滑过去：每个滚轮事件的 deltaY 加到「剩下要走的距离」上，每帧走剩下的一部分：
     走的量 = 剩下的 × (1 − e^(−dt/τ))，τ = 90 毫秒（90 毫秒走 63%，约 0.3 秒走完）；剩下不到 0.5 px 就一步走完、停下。
   - 记的是「剩下的距离」，不是绝对的目标位置：别处改了 scrollTop（虚拟器补偿滚动位置、取到更早的消息后校正、贴底）时，位置跟着挪，剩下的距离不变，
     滚轮的总行程仍然是每个事件的 deltaY 之和，不多不少。
   - 位置用内部的浮点数记：scrollTop 写进去会被浏览器取整到物理像素，每帧不到 1 px 的挪动要是从 scrollTop 读回来再加就丢了。
     读回来的值和上次写进去的差超过 1 px 才算别处动过（取整最多差半个像素）；
   - 连着滚几格距离累加，速度自然变快；反方向滚剩下的距离相应抵消、掉头，不停顿；
   - 滚到头了（位置加剩下的距离超出 [0, 最大]），超出的部分清掉，不攒着；
   - dt 很大（标签页在后台、被卡住）时一步走完，不越界。
   WheelMotion 由 host 给时钟、帧回调、读写位置，测试里用假的（wheel.test.ts）。
   接不接管：takesOver 看单个事件；一串连着的事件（触控板甩动）整串一致，由 WheelStream 在第一个事件上定。 */
export const WHEEL_TAU = 90;
/** 剩下不到这么多 px 就一步走完 */
const EPS = 0.5;
/** 两帧之间超过这么久（毫秒）就一步走完 */
const SNAP_DT = 250;
/** 读回来的位置和上次写进去的差超过这么多 px，才算别处也动了 */
const EXTERNAL = 1;

/** 像素级的小步（多半是触控板）：不到这么多 px 的不接管 */
export const WHEEL_SMALL_STEP = 40;
/** 一个滚轮事件算作多少 px：行（deltaMode 1）按每行 40 px，页（deltaMode 2）按滚动区的可视高度 */
export const WHEEL_LINE_PX = 40;

export interface WheelLike {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}
/** 这个事件本身有没有资格被接管，和同一串里别的事件无关：关掉动画、按着 Ctrl（缩放）、Shift（横向）、Alt、Meta、横着的、没有竖向距离的，都没有 */
export function eligible(e: WheelLike, motion: boolean): boolean {
  if (!motion) return false;
  if (e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return false;
  if (!e.deltaY || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return false;
  return true;
}
/** 是不是「整格」：行、页，或者像素但 |deltaY| 不小于 40。像素级的小步多半是触控板、高精度滚轮 */
export const isStep = (e: Pick<WheelLike, 'deltaY' | 'deltaMode'>) =>
  e.deltaMode !== 0 || Math.abs(e.deltaY) >= WHEEL_SMALL_STEP;
/** 单独看一个事件，要不要接管（不接管的交给浏览器）。一串事件里怎么定见 WheelStream */
export function takesOver(e: WheelLike, motion: boolean): boolean {
  return eligible(e, motion) && isStep(e);
}

/** 间隔不超过这么久（毫秒）的滚轮事件算同一串 */
export const WHEEL_STREAM_GAP = 150;
/* 同一串连着的滚轮事件（触控板甩动、高精度滚轮、一格接一格的鼠标滚轮），接不接管只在这一串的第一个事件上判一次，整串一致：
   - 定为接管的：后面的小步也加进剩下的距离，大小混在一起也走得出平滑的一条线，总行程 = deltaY 之和；
   - 定为不接管的：整串都交给浏览器，哪怕中间有大的；
   不然一串里大的缓动、小的原生，每个交给浏览器的事件还要清掉余量，丢行程，速度一抖一抖。
   没有资格接管的事件（eligible 为假：关了动画、修饰键、横向为主）逐个判断为不接管，并结束这一串，下一个事件重新定。
   时间用事件自己的时间戳（主线程忙、事件攒着一起处理时，处理时刻的间隔不准）。 */
export class WheelStream {
  private take: boolean | null = null;
  private last = 0;

  /** 这个事件接不接管；now 是事件的时间（毫秒） */
  decide(e: WheelLike, motion: boolean, now: number): boolean {
    if (!eligible(e, motion)) {
      this.take = null;
      return false;
    }
    if (this.take === null || now - this.last > WHEEL_STREAM_GAP) this.take = isStep(e);
    this.last = now;
    return this.take;
  }
  /** 结束这一串，下一个事件重新定 */
  reset() {
    this.take = null;
  }
}
/** 事件的 deltaY 换成 px；pageHeight 是滚动区的可视高度（deltaMode 2 要用） */
export function wheelPixels(e: Pick<WheelLike, 'deltaY' | 'deltaMode'>, pageHeight: number) {
  return e.deltaMode === 1
    ? e.deltaY * WHEEL_LINE_PX
    : e.deltaMode === 2
      ? e.deltaY * pageHeight
      : e.deltaY;
}

export interface WheelHost {
  get(): number;
  set(v: number): void;
  /** scrollTop 的最大值（每帧重取：内容变高它就往下走） */
  max(): number;
  now(): number;
  raf(cb: () => void): number;
  caf(id: number): void;
}

export class WheelMotion {
  private pos = 0;
  private lastSet = 0;
  private remain = 0;
  private last = 0;
  private id = 0;
  private run = false;
  /** onIdle：走完或放手了。alive：每帧问一次，false 就放手（关了动画、形变开始了） */
  constructor(
    private host: WheelHost,
    private opts: { onIdle?: () => void; alive?: () => boolean } = {},
  ) {}

  /** 还有没走完的距离在走 */
  get active() {
    return this.run;
  }
  /** 没走完的距离（带符号，正数是往下） */
  get pending() {
    return this.remain;
  }
  /** 往这个方向（1 往下，-1 往上）还能走多远，算上没走完的：滚到头了就是 0 */
  capacity(dir: 1 | -1): number {
    const base = this.run ? this.pos + this.remain : this.host.get();
    return Math.max(0, dir > 0 ? this.host.max() - base : base);
  }

  /** 又滚了 dy px（正数往下）：加到剩下的距离上，夹在能走的范围里 */
  add(dy: number) {
    const now = this.host.now();
    if (!this.run) {
      this.lastSet = this.pos = this.host.get();
      this.last = now;
      this.run = true;
    } else this.syncExternal();
    this.remain = this.clamp(this.remain + dy);
    if (!this.id) this.id = this.host.raf(this.frame);
  }

  /** 放手：剩下的距离清掉，停在此刻的位置 */
  cancel() {
    if (!this.run) return;
    this.stop();
  }

  private clamp(remain: number) {
    return Math.min(this.host.max() - this.pos, Math.max(-this.pos, remain)) + 0;
  }
  /* 别处也动了 scrollTop：位置跟着挪，剩下的距离不变 */
  private syncExternal() {
    const cur = this.host.get();
    if (Math.abs(cur - this.lastSet) > EXTERNAL) {
      this.pos += cur - this.lastSet;
      this.lastSet = cur;
    }
  }
  private stop() {
    this.run = false;
    this.remain = 0;
    if (this.id) {
      this.host.caf(this.id);
      this.id = 0;
    }
    this.opts.onIdle?.();
  }

  private frame = () => {
    this.id = 0;
    if (!this.run) return;
    if (this.opts.alive && !this.opts.alive()) return this.stop();
    const now = this.host.now();
    const dt = now - this.last;
    this.last = now;
    this.syncExternal();
    this.remain = this.clamp(this.remain);
    let move = dt > SNAP_DT ? this.remain : this.remain * (1 - Math.exp(-dt / WHEEL_TAU));
    if (Math.abs(this.remain - move) < EPS) move = this.remain;
    this.pos += move;
    this.remain -= move;
    this.host.set(this.pos);
    this.lastSet = this.pos;
    if (this.remain === 0) return this.stop();
    // set() 里可能有人（滚动事件处理）放了手
    if (this.run && !this.id) this.id = this.host.raf(this.frame);
  };
}

/* 哪个滚动区有没走完的滚轮缓动：别的代码（虚拟列表的定位、第 3 步的滑动、「此刻」的贴底）要看一眼，或者让它放手。
   键是滚动区的元素（用 object 当类型，本文件不引用 DOM 类型） */
const motions = new WeakMap<object, WheelMotion>();
export const wheelRegistry = {
  set(el: object, m: WheelMotion) {
    motions.set(el, m);
  },
  get(el: object) {
    return motions.get(el);
  },
};
/** 这个滚动区正有滚轮缓动在走 */
export const isWheeling = (el: object) => motions.get(el)?.active === true;
/** 没走完的滚轮距离的方向：-1 往上、1 往下、0 没在走 */
export const wheelDir = (el: object): -1 | 0 | 1 => {
  const m = motions.get(el);
  return m?.active ? (Math.sign(m.pending) as -1 | 0 | 1) : 0;
};
/** 程序自己要滚了（滑动、定位）或用户换了别的操作：这个滚动区没走完的滚轮距离清掉 */
export const cancelWheel = (el: object) => motions.get(el)?.cancel();
/** 滚轮缓动开始往某个方向走时，在滚动区上发的事件（detail.dy：这一下的距离，带符号），同步发出，比第一帧早 */
export const WHEEL_EVENT = 'wheelscroll';
