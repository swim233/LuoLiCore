/* 把一个滚动区的 scrollTop 滑到某个位置：程序自己要滚的地方（贴底时上推、发出消息后回到最底下、思考内容框跟到最新）都用它。
   用户的鼠标滚轮缓动不用它，在 @luoli/ui/wheel：那边记的是「剩下的距离」而不是绝对的目标位置（别处改了 scrollTop 剩下的距离不变），
   而且不能被滚轮打断；这里的滑动是程序在滚，用户一滚轮、按下、按键就要放手。两边互相让位：这里每次 to() 开头把那个滚动区没走完的滚轮距离清掉（onStart），
   滚轮缓动开始时这里的监听（wheel，捕获）先把程序的滑动放掉。
   - 一个滚动区同一时刻只有一个目标（sliderOf(el) 每个元素一个 Slider）。再调 to() 就是换目标：从此刻的位置接着走，不回头；
   - 目标可以是函数，每帧重新取：「最底下」会随着内容变高而往下走，滑到一半内容又长了也不会停在半路；
   - 两种走法：
     * ease：固定时长、ease-out 曲线（发出消息后滑回底部：离得远也不超过 SLIDE_SEND_MAX）。开始时的距离按这条曲线滑完；
       途中目标又往下走了（内容长高了），新长的部分另外按 exp（SLIDE_PUSH_TAU）滑完，位置不跳；时长到了以后新长的部分原样跟上；
     * exp：每帧 pos += (目标 − pos) × (1 − e^(−dt/τ))，差不到 0.5 px 就停（上推、思考框跟随）。
       目标是函数时可以加 passthrough：目标在途中的变化（内容逐字长高，「最底下」一直往下走）原样加到位置上，不被 τ 拖慢；
       只有开始滑的那一刻已有的差距（新来的一条把底部推下去一截）才按 τ 慢慢滑完。不加的话，内容一直在长时位置永远追不上目标，滑动停不下来、始终落后；
   - 位置用内部的浮点数记，不每帧从 scrollTop 读回来（整数像素的屏上读回来的是取整过的值，慢下来以后每帧不到 1 px 的挪动会被吃掉，停在半路）；
     只在读回来的值和上次写进去的差得多（超过 1.5 px：别处也在写 scrollTop、被夹在滚动范围里）时，把差按原样算进内部的位置；
   - 用户自己动手（滚轮、按下鼠标或手指、按键）时放手：停下，不再写 scrollTop，onEnd 收到 'cancel'；
   - 滑的途中 active 为真：滚动事件处理里用它区分「自己在滚」和「用户在滚」（不能因为滑到一半离底部还远就把「贴底」清掉）；
   - 到位时恰好写到目标；dt 很大（标签页在后台）时不插值，直接到位。
   Slider 不碰 DOM：时钟、帧回调、读写位置都由 host 给，测试里用假的（slide.test.ts）。 */
import { cancelWheel } from './wheel';

export type Ease = (t: number) => number;
export const easeOutCubic: Ease = (t) => 1 - Math.pow(1 - t, 3);

export type Motion =
  { kind: 'ease'; ms: number; ease?: Ease } | { kind: 'exp'; tau: number; passthrough?: boolean };
export type EndReason = 'done' | 'cancel' | 'replace';

/** 上推（贴底时来了新内容）的时间常数（毫秒）：约 0.18 秒到位 */
export const SLIDE_PUSH_TAU = 40;
/** 思考内容框跟到最新的时间常数 */
export const SLIDE_FOLLOW_TAU = 60;
/** 发出消息后滑到底：时长随距离，最长这么久（毫秒） */
export const SLIDE_SEND_MAX = 450;
export const slideSendMs = (distance: number) =>
  Math.min(SLIDE_SEND_MAX, 160 + Math.abs(distance) * 0.24);
/** 差不到这么多 px 就算到了 */
const EPS = 0.5;
/** 两帧之间超过这么久（毫秒）就不插值，直接到位 */
const SNAP_DT = 250;

export interface SlideHost {
  get(): number;
  set(v: number): void;
  now(): number;
  raf(cb: () => void): number;
  caf(id: number): void;
}

export class Slider {
  private pos = 0;
  /** 上次写进 scrollTop 的值、上一帧的目标 */
  private lastSet = 0;
  private prevTarget = 0;
  /** ease：走到的进度（0～1）、开始时的距离还剩多少（按曲线缩小）、途中目标又长出来的距离还剩多少（按 exp 缩小） */
  private p = 0;
  private main = 0;
  private extra = 0;
  private t0 = 0;
  private last = 0;
  private motion: Motion | null = null;
  private tf: (() => number) | null = null;
  private onEnd: ((r: EndReason) => void) | undefined;
  private id = 0;
  /** 用户做了这些事就放手（事件名）。DOM 一侧的 sliderOf 照它挂监听 */
  interruptOn: string[] = ['wheel', 'pointerdown', 'touchstart', 'keydown'];
  /** onStart：每次 to() 开头调一次（程序要自己滚了：滚轮缓动没走完的距离要清掉，见 @luoli/ui/wheel） */
  constructor(
    private host: SlideHost,
    private opts: { onStart?: () => void } = {},
  ) {}

  /** 正在滑 */
  get active() {
    return this.motion !== null;
  }
  /** 此刻的目标（没在滑时是 null） */
  get target(): number | null {
    return this.tf ? this.tf() : null;
  }
  /** 内部记的位置（浮点） */
  get position() {
    return this.pos;
  }

  /** 滑向 target（数，或每帧重新取的函数）。正在滑的先结束（'replace'），新的从此刻的位置走 */
  to(target: number | (() => number), motion: Motion, onEnd?: (r: EndReason) => void) {
    this.opts.onStart?.();
    const wasActive = this.active;
    const prevEnd = this.onEnd;
    this.onEnd = onEnd;
    this.tf = typeof target === 'function' ? target : () => target;
    this.motion = motion;
    // 正在滑时位置就是内部记的；没在滑时从 scrollTop 现在的值起步
    if (!wasActive) this.lastSet = this.pos = this.host.get();
    this.p = 0;
    this.extra = 0;
    this.prevTarget = this.tf();
    this.main = this.prevTarget - this.pos;
    this.t0 = this.last = this.host.now();
    if (wasActive) prevEnd?.('replace');
    if (Math.abs(this.tf() - this.pos) < EPS) {
      this.finish('done');
      return;
    }
    if (!this.id) this.id = this.host.raf(this.frame);
  }

  /** 目标刚变了（同一帧里内容变高、「最底下」往下走）：带 passthrough 的 exp 马上把变化原样加到位置上并写进去，不等下一帧。
      其余的（ease，没带 passthrough 的 exp）新长的部分本来就要慢慢滑，什么也不做 */
  sync() {
    const m = this.motion;
    const tf = this.tf;
    if (!m || !tf || m.kind !== 'exp' || !m.passthrough) return;
    const target = tf();
    this.pos += target - this.prevTarget;
    this.prevTarget = target;
    this.host.set(this.pos);
    this.lastSet = this.pos;
  }

  /** 放手：停在此刻的位置 */
  cancel() {
    if (!this.motion) return;
    this.finish('cancel');
  }

  private finish(reason: EndReason) {
    const end = this.onEnd;
    if (reason === 'done' && this.tf) {
      this.lastSet = this.pos = this.tf();
      this.host.set(this.pos);
    }
    this.motion = null;
    this.tf = null;
    this.onEnd = undefined;
    if (this.id) {
      this.host.caf(this.id);
      this.id = 0;
    }
    end?.(reason);
  }

  /* 每帧：位置 = 目标 − 还没滑完的距离 rest，rest 按走法变小。
     exp：rest 乘 e^(−dt/τ)；带 passthrough 时这一帧目标的变化先原样加到位置上（不计入 rest）。
     ease：rest = main + extra。main 是开始时的距离，按曲线剩下的比例（1 − ease(p)）缩小，p 到 1 就是 0；
     extra 是途中目标又往下走的部分（内容长高），按 exp 缩小；时长到了以后目标的变化原样跟上，extra 滑完就结束。 */
  private frame = () => {
    this.id = 0;
    const m = this.motion;
    const tf = this.tf;
    if (!m || !tf) return;
    const now = this.host.now();
    const dt = now - this.last;
    this.last = now;
    const target = tf();
    // 别处也动了 scrollTop（被夹在滚动范围里、别的代码在写）：差原样算进内部的位置
    const cur = this.host.get();
    const shift = Math.abs(cur - this.lastSet) > 1.5 ? cur - this.lastSet : 0;
    this.pos += shift;
    const dT = target - this.prevTarget;
    this.prevTarget = target;
    if (m.kind === 'ease') {
      const p1 = (now - this.t0) / Math.max(1, m.ms);
      this.main -= shift;
      if (p1 < 1) {
        const ease = m.ease ?? easeOutCubic;
        const a = 1 - ease(this.p);
        this.main = a > 1e-9 ? this.main * ((1 - ease(p1)) / a) : 0;
        this.p = p1;
        this.extra += dT;
      } else this.main = 0;
      if (dt > SNAP_DT) return this.finish('done');
      this.extra *= Math.exp(-dt / SLIDE_PUSH_TAU);
      if (p1 >= 1 && Math.abs(this.extra) < EPS) return this.finish('done');
      this.pos = target - this.main - this.extra;
    } else {
      if (dt > SNAP_DT) return this.finish('done');
      let rest = target - this.pos;
      if (m.passthrough) rest -= dT;
      rest *= Math.exp(-dt / m.tau);
      if (Math.abs(rest) < EPS) return this.finish('done');
      this.pos = target - rest;
    }
    this.host.set(this.pos);
    this.lastSet = this.pos;
    // set() 里可能有人（onScroll 之类同步的回调）换了目标或放了手
    if (this.motion && !this.id) this.id = this.host.raf(this.frame);
  };
}

const sliders = new WeakMap<HTMLElement, Slider>();
const EVENTS = ['wheel', 'pointerdown', 'touchstart', 'keydown'] as const;
/** 这个滚动区的 Slider（第一次取时建好，并挂上用户动手就放手的监听） */
export function sliderOf(el: HTMLElement): Slider {
  let s = sliders.get(el);
  if (s) return s;
  const slider = new Slider(
    {
      get: () => el.scrollTop,
      set: (v) => {
        el.scrollTop = v;
      },
      now: () => performance.now(),
      raf: (cb) => requestAnimationFrame(cb),
      caf: (id) => cancelAnimationFrame(id),
    },
    { onStart: () => cancelWheel(el) },
  );
  for (const e of EVENTS)
    el.addEventListener(
      e,
      () => {
        if (slider.interruptOn.includes(e)) slider.cancel();
      },
      { passive: true, capture: true },
    );
  sliders.set(el, slider);
  s = slider;
  return s;
}
/** 滚动区此刻正在被程序滑着 */
export const isSliding = (el: HTMLElement) => sliders.get(el)?.active === true;
/** 滚到底时 scrollTop 的值（每帧重新算，内容变高它就往下走） */
export const maxScrollTop = (el: HTMLElement) => Math.max(0, el.scrollHeight - el.clientHeight);
