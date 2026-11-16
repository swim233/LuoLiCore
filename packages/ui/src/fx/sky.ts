import { motionOn } from '../motion';
import { cssRGB } from '../util';
import { dprOf } from './dpr';
import type { SkyMsg } from './sky-msg';

/* 背景星空的主线程这一头：把画布交给 Worker（OffscreenCanvas，在 sky.worker.ts 里画），之后只发消息（尺寸、动画开关、全屏停住）。
   星点会漂、会闪，带两组淡淡的星座连线，帧率封顶 30。入口加载时不碰 DOM，Worker 到 start 里才建。
   库不认识外壳：窄屏、性能低、画布放哪一层由用的地方定（start 的选项）；全屏时要不要停住（hold）、动画开关变了（sync）也由用的地方来调。 */
/** 星点、星座用的颜色（CSS 颜色字符串）：金色星点、两种淡色星点、星座的线、星座的点 */
export type SkyColors = Record<'goldStar' | 'fg2' | 'fg' | 'goldLine' | 'goldDot', string>;
export interface SkyOptions {
  /** 现在是不是窄屏（窄屏星点少）：窗口缩放时会变，所以是个函数，每次 size 都问一次 */
  narrow: () => boolean;
  /** 性能低（星点少）：启动时定一次 */
  lowPower: boolean;
  /** 帧率封顶，默认 30 */
  fps?: number;
  /** 自己建好的 Worker（要和别处共用、或打包器不认库里的写法时）：不给就由库建 */
  worker?: Worker;
  /** 星点、星座的颜色：不给就读 CSS 变量（--ll-star-dust、--ll-fg-2、--ll-fg、--ll-star） */
  colors?: SkyColors;
  /** 固定种子：每次画出来的星点都一样（对照、截图用）；不给就是随机的 */
  seed?: number;
}
const SKY_FPS = 30;
let skyW: Worker | null = null;
let skyNarrow: () => boolean = () => false;
const post = (m: SkyMsg, transfer: Transferable[] = []) => skyW?.postMessage(m, transfer);

export const sky = {
  /** 启动：同一张画布只能转移一次（transferControlToOffscreen），已经启动了就什么也不做（React 严格模式下 effect 会跑两遍） */
  start(canvas: HTMLCanvasElement, opts: SkyOptions) {
    if (skyW) return;
    skyNarrow = opts.narrow;
    const off = canvas.transferControlToOffscreen();
    /* Vite 只认 new Worker(new URL('…', import.meta.url), …) 这一整句，不能拆成变量或辅助函数 */
    skyW =
      opts.worker ?? new Worker(new URL('./sky.worker.ts', import.meta.url), { type: 'module' });
    const colors = opts.colors ?? {
      goldStar: `rgb(${cssRGB('--ll-star-dust')})`,
      fg2: `rgb(${cssRGB('--ll-fg-2')})`,
      fg: `rgb(${cssRGB('--ll-fg')})`,
      goldLine: `rgba(${cssRGB('--ll-star')},.06)`,
      goldDot: `rgba(${cssRGB('--ll-star-dust')},.34)`,
    };
    post(
      {
        type: 'init',
        canvas: off,
        w: window.innerWidth,
        h: window.innerHeight,
        dpr: dprOf(),
        colors,
        narrow: opts.narrow(),
        lowPower: opts.lowPower,
        motion: motionOn(),
        fps: opts.fps ?? SKY_FPS,
        // 没给种子时不带这一项（消息和以前一样）
        ...(opts.seed !== undefined && { seed: opts.seed }),
      },
      [off],
    );
  },
  size() {
    if (!skyW) return;
    post({
      type: 'size',
      w: window.innerWidth,
      h: window.innerHeight,
      dpr: dprOf(),
      narrow: skyNarrow(),
    });
  },
  /* 全屏期间整个星空停住：被暗层盖着看不清，也省得后面的模糊层跟着星星每帧重算 */
  hold(on: boolean) {
    if (!skyW) return;
    post({ type: 'hold', on });
  },
  /* 动画开关变了：关了就停掉、画一帧静态图，开了接着动 */
  sync() {
    if (!skyW) return;
    post({ type: 'motion', on: motionOn() });
  },
  /* 星座的点和线各自的透明度：给以后的星座动画留的接口，现在没有用到 */
  setConstellation(id: number, o: { dotAlpha?: number[]; lineAlpha?: number[] }) {
    if (!skyW) return;
    post({ type: 'con', id, ...o });
  },
};
