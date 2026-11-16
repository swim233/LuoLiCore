import { motionOn } from '../motion';
import { cssRGB } from '../util';
import { dprOf } from './dpr';

/* 星尘的主线程这一头：把一张固定的整屏画布交给 Worker（OffscreenCanvas），之后只发消息（尺寸、粒子的位置）。
   三种：burst 迸发（回复完成时从光标散开、新增部件完成时迸一小团）、assemble 汇聚成形（新增部件）、scatter 散开（移除部件）。
   它们只收「屏幕上的矩形或点」，不认识部件。
   Worker 由用的地方建好传进来（start 的 worker）：Worker 里用 particles.ts 的 particleMessage 处理消息，用的地方在入口里先问自己的消息、
   再交给它，所以别的画布（面板里徽记的小画布）能和整屏的星尘共用一个 Worker。
   库不认识外壳：粒子数要不要缩（窄屏、性能低）由用的地方传进来；动画关了就什么也不放（在这里拦，不是在 Worker 里）。
   入口加载时不碰 DOM。 */
export interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
}
export interface FxOptions {
  /** 整屏星尘用的 Worker：用的地方建好传进来，Worker 里调 particleMessage */
  worker: Worker;
  /** 粒子数的缩放（窄屏、性能低时小于 1），每次迸发、汇聚、消散时现问一次；不给就是 1 */
  scale?: () => number;
  /** 固定种子：粒子的位置每次都一样（对照、截图用）；不给就是随机的 */
  seed?: number;
}
let fxW: Worker | null = null,
  fxCanvas = false,
  fxScale: () => number = () => 1;
const resizeCbs = new Set<() => void>();

/* 粒子的颜色在发给 Worker 之前从 CSS 变量读取（配色变了跟着变） */
function palette(kind: 'burst' | 'assemble' | 'scatter') {
  const GOLD = cssRGB('--ll-star-pale'),
    BLUE = cssRGB('--ll-fg-2'),
    WHITE = cssRGB('--ll-white');
  return kind === 'scatter' ? [GOLD, BLUE, WHITE] : [GOLD, GOLD, BLUE, WHITE];
}
const rectOf = (r: RectLike): RectLike => ({
  left: r.left,
  top: r.top,
  width: r.width,
  height: r.height,
  right: r.right,
  bottom: r.bottom,
});

export const fx = {
  /** 启动：同一张画布只能转移一次，已经启动了就什么也不做（React 严格模式下 effect 会跑两遍） */
  start(canvas: HTMLCanvasElement, opts: FxOptions) {
    if (fxCanvas) return;
    fxCanvas = true;
    fxW = opts.worker;
    fxScale = opts.scale ?? (() => 1);
    const off = canvas.transferControlToOffscreen();
    fxW.postMessage(
      {
        type: 'init',
        canvas: off,
        w: window.innerWidth,
        h: window.innerHeight,
        dpr: dprOf(),
        // 没给种子时不带这一项（消息和以前一样）
        ...(opts.seed !== undefined && { seed: opts.seed }),
      },
      [off],
    );
  },
  size() {
    if (fxCanvas)
      fxW?.postMessage({ type: 'size', w: window.innerWidth, h: window.innerHeight, dpr: dprOf() });
    for (const f of resizeCbs) f();
  },
  /** 窗口大小、像素比变了（size）以后也要跟着变的东西（和这个 Worker 共用画布的别的画布）登记在这里；返回取消登记的函数 */
  onResize(fn: () => void) {
    resizeCbs.add(fn);
    return () => {
      resizeCbs.delete(fn);
    };
  },
  palette,
  /* 回复完成：星尘散开 */
  burst(x: number, y: number, { n = 30, speed = 150 }: { n?: number; speed?: number } = {}) {
    if (!motionOn() || !fxCanvas) return;
    fxW!.postMessage({
      type: 'burst',
      x,
      y,
      n: Math.max(6, Math.round(n * fxScale())),
      speed,
      palette: palette('burst'),
    });
  },
  /* 新增部件：星点从四周汇聚成形；时间到 80% 就 resolve，不等粒子全部落完 */
  assemble(r: RectLike, ms = 950) {
    if (!motionOn() || !fxCanvas) return Promise.resolve();
    fxW!.postMessage({
      type: 'assemble',
      r: rectOf(r),
      n: Math.max(24, Math.round(90 * fxScale())),
      ms,
      palette: palette('assemble'),
    });
    return new Promise<void>((res) => setTimeout(res, ms * 0.8));
  },
  /* 部件消散 */
  scatter(r: RectLike) {
    if (!motionOn() || !fxCanvas) return;
    fxW!.postMessage({
      type: 'scatter',
      r: rectOf(r),
      n: Math.max(14, Math.round(50 * fxScale())),
      palette: palette('scatter'),
    });
  },
};
