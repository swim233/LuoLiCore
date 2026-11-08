import { env, particleScale } from '../lib/env';
import { motionOn, prefs } from '../lib/prefs';
import { cssRGB } from '../lib/util';

/* 星空和粒子的主线程这一头：把画布交给 Worker（OffscreenCanvas），之后只发消息（尺寸、动画开关、全屏停住、粒子的位置） */
interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
}
const dprOf = () => Math.min(2, window.devicePixelRatio || 1);
let skyW: Worker | null = null,
  fxW: Worker | null = null;
const SKY_FPS = 30;

export const sky = {
  start(canvas: HTMLCanvasElement) {
    if (skyW) return;
    const off = canvas.transferControlToOffscreen();
    skyW = new Worker(new URL('./sky.worker.ts', import.meta.url), { type: 'module' });
    const colors = {
      goldStar: `rgb(${cssRGB('--gold-star')})`,
      fg2: `rgb(${cssRGB('--fg-2')})`,
      fg: `rgb(${cssRGB('--fg')})`,
      goldLine: `rgba(${cssRGB('--gold')},.06)`,
      goldDot: `rgba(${cssRGB('--gold-star')},.34)`,
    };
    skyW.postMessage(
      {
        type: 'init',
        canvas: off,
        w: window.innerWidth,
        h: window.innerHeight,
        dpr: dprOf(),
        colors,
        narrow: env.narrow,
        lowPower: env.lowPower,
        motion: prefs.get().motion,
        fps: SKY_FPS,
      },
      [off],
    );
  },
  size() {
    skyW?.postMessage({
      type: 'size',
      w: window.innerWidth,
      h: window.innerHeight,
      dpr: dprOf(),
      narrow: env.narrow,
    });
  },
  /* 全屏期间整个星空停住：被暗层盖着看不清，也省得后面的模糊层跟着星星每帧重算 */
  hold(on: boolean) {
    skyW?.postMessage({ type: 'hold', on });
  },
  sync() {
    skyW?.postMessage({ type: 'motion', on: prefs.get().motion });
  },
  /* 星座的点和线各自的透明度：第 6 版的接口位置 */
  setConstellation(id: number, o: { dotAlpha?: number[]; lineAlpha?: number[] }) {
    skyW?.postMessage({ type: 'con', id, ...o });
  },
};
export const fx = {
  start(canvas: HTMLCanvasElement) {
    if (fxW) return;
    const off = canvas.transferControlToOffscreen();
    fxW = new Worker(new URL('./fx.worker.ts', import.meta.url), { type: 'module' });
    fxW.postMessage(
      { type: 'init', canvas: off, w: window.innerWidth, h: window.innerHeight, dpr: dprOf() },
      [off],
    );
  },
  size() {
    fxW?.postMessage({ type: 'size', w: window.innerWidth, h: window.innerHeight, dpr: dprOf() });
  },
  /* 粒子的颜色在发给 Worker 之前从 CSS 变量读取（配色变了跟着变） */
  palette(kind: 'burst' | 'assemble' | 'scatter') {
    const GOLD = cssRGB('--gold-pale'),
      BLUE = cssRGB('--fg-2'),
      WHITE = cssRGB('--white');
    return kind === 'scatter' ? [GOLD, BLUE, WHITE] : [GOLD, GOLD, BLUE, WHITE];
  },
  /* 回复完成：星尘散开 */
  burst(x: number, y: number, { n = 30, speed = 150 }: { n?: number; speed?: number } = {}) {
    if (!motionOn() || !fxW) return;
    fxW.postMessage({
      type: 'burst',
      x,
      y,
      n: Math.max(6, Math.round(n * particleScale())),
      speed,
      palette: this.palette('burst'),
    });
  },
  /* 新增部件：星点从四周汇聚成形；时间到 80% 就 resolve，不等粒子全部落完 */
  assemble(r: RectLike, ms = 950) {
    if (!motionOn() || !fxW) return Promise.resolve();
    fxW.postMessage({
      type: 'assemble',
      r: {
        left: r.left,
        top: r.top,
        width: r.width,
        height: r.height,
        right: r.right,
        bottom: r.bottom,
      },
      n: Math.max(24, Math.round(90 * particleScale())),
      ms,
      palette: this.palette('assemble'),
    });
    return new Promise<void>((res) => setTimeout(res, ms * 0.8));
  },
  /* 部件消散 */
  scatter(r: RectLike) {
    if (!motionOn() || !fxW) return;
    fxW.postMessage({
      type: 'scatter',
      r: {
        left: r.left,
        top: r.top,
        width: r.width,
        height: r.height,
        right: r.right,
        bottom: r.bottom,
      },
      n: Math.max(14, Math.round(50 * particleScale())),
      palette: this.palette('scatter'),
    });
  },
};
