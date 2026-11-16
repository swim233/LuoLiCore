/* 气泡外框的跟随：外框的宽、高每帧向内容的自然大小靠拢（纯函数，不碰 DOM；DOM 的部分在 bubble-frame.ts）。
   - 高：一阶跟随，当前值 += (目标 − 当前值) × (1 − e^(−dt/τ))，τ = 50 毫秒，约 0.15 秒到位。多出一行（+21.6 px）时头一帧只动 3 px 左右；
   - 宽：逐字时每出一个字，自然宽度跳 13.5 px（一个字的宽），光标的星星伸出文字右边 13 px。单级一阶跟随在每秒 480 px 的匀速增长下稳态落后 τ×速度：
     τ 取 50 毫秒就落后 24 px，把刚出的字和光标整个挡在外框外面。所以宽度用两级串联的一阶跟随，每级的 τ 只有 6 毫秒：
     * 每一级都只朝它的输入走、不会走过头，所以整条链永远不超过目标，没有超调、不会来回抖；
     * 匀速输入下稳态落后是 2τ×速度（6 毫秒、每秒 480 px 时 5.8 px），一个字的 13.5 px 台阶被摊到约 3 帧里（144 Hz 下匀速时平均每帧 3.4 px，台阶刚跳上去的那一帧最多 6～8 px，稳态落后 p95 约 7 px、最多 8 px 左右）；
     * 落后得远时（整块内容突然出现：代码块、表格、一张图）把 τ 放大到 28 毫秒，两级串联约 0.2 秒到位，不是一下子跳。
   dt 很大（标签页切到后台再回来、被卡住了）时不插值，直接到位。 */
export const FOLLOW = {
  /** 高度的时间常数（毫秒） */
  heightTau: 50,
  /** 宽度每一级的时间常数：落后得不远时（匀速打字）、落后得远时 */
  widthTauFast: 6,
  widthTauSlow: 28,
  /** 落后多少 px 以内用 widthTauFast，多少以上用 widthTauSlow（中间平滑过渡） */
  gapLo: 24,
  gapHi: 80,
  /** 差距小于它（px）就算到位 */
  eps: 0.5,
  /** 两次计算之间超过这么久（毫秒）就不再插值，直接到位 */
  snapDt: 250,
} as const;

const smooth = (t: number) => {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * (3 - 2 * x);
};
/** 落后 gap px 时宽度每一级用的时间常数（毫秒） */
export const widthTau = (gap: number) =>
  FOLLOW.widthTauFast +
  (FOLLOW.widthTauSlow - FOLLOW.widthTauFast) *
    smooth((Math.abs(gap) - FOLLOW.gapLo) / (FOLLOW.gapHi - FOLLOW.gapLo));

export class SizeFollower {
  /** 宽度第一级、第二级（第二级是外框实际的宽） */
  private w1: number;
  private w2: number;
  private h: number;
  constructor(w: number, h: number) {
    this.w1 = this.w2 = w;
    this.h = h;
  }
  get width() {
    return this.w2;
  }
  get height() {
    return this.h;
  }
  /** 直接放到某个大小 */
  snap(w: number, h: number) {
    this.w1 = this.w2 = w;
    this.h = h;
  }
  /** 向目标走 dt 毫秒，返回走到的（宽，高） */
  step(tw: number, th: number, dt: number): [number, number] {
    if (!(dt > 0)) return [this.w2, this.h];
    if (dt > FOLLOW.snapDt) {
      this.snap(tw, th);
      return [tw, th];
    }
    this.h += (th - this.h) * (1 - Math.exp(-dt / FOLLOW.heightTau));
    const a = 1 - Math.exp(-dt / widthTau(tw - this.w2));
    this.w1 += (tw - this.w1) * a;
    this.w2 += (this.w1 - this.w2) * a;
    return [this.w2, this.h];
  }
  /** 宽、高都已经和目标差不到 eps */
  settled(tw: number, th: number) {
    return Math.abs(tw - this.w2) < FOLLOW.eps && Math.abs(th - this.h) < FOLLOW.eps;
  }
}
