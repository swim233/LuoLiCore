import { env, particleScale } from '@luoli/ui/env';
import { motionOn } from '@luoli/ui/motion';
import { cssRGB } from '@luoli/ui/util';
import type { BadgeReply, BadgeStats, Op } from './badge-msg';

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
  fxW: Worker | null = null,
  fxCanvas = false;
const SKY_FPS = 30;
/* 星尘 Worker：整屏的星尘和徽记的小画布共用一个。徽记可能比整屏画布先挂上，所以谁先用谁创建 */
function fxWorker() {
  if (!fxW) {
    fxW = new Worker(new URL('./fx.worker.ts', import.meta.url), { type: 'module' });
    fxW.onmessage = (e: MessageEvent<BadgeReply>) => {
      if (e.data.type === 'bd-stats') statsWait.splice(0).forEach((f) => f(e.data.stats));
    };
  }
  return fxW;
}
const statsWait: ((s: BadgeStats[]) => void)[] = [];

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
        motion: motionOn(),
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
    skyW?.postMessage({ type: 'motion', on: motionOn() });
  },
  /* 星座的点和线各自的透明度：第 6 版的接口位置 */
  setConstellation(id: number, o: { dotAlpha?: number[]; lineAlpha?: number[] }) {
    skyW?.postMessage({ type: 'con', id, ...o });
  },
};
export const fx = {
  start(canvas: HTMLCanvasElement) {
    if (fxCanvas) return;
    fxCanvas = true;
    const off = canvas.transferControlToOffscreen();
    fxWorker().postMessage(
      { type: 'init', canvas: off, w: window.innerWidth, h: window.innerHeight, dpr: dprOf() },
      [off],
    );
  },
  size() {
    if (fxCanvas)
      fxW?.postMessage({ type: 'size', w: window.innerWidth, h: window.innerHeight, dpr: dprOf() });
    badgeFx.size();
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
    if (!motionOn() || !fxCanvas) return;
    fxW!.postMessage({
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
    if (!motionOn() || !fxCanvas) return Promise.resolve();
    fxW!.postMessage({
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
    if (!motionOn() || !fxCanvas) return;
    fxW!.postMessage({
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

/* 徽记的小画布：每个徽记一张，交给同一个 Worker。消息的结构见 badge-msg.ts */
const badgeIds = new Set<number>();
let badgeSeq = 0;
export const badgeFx = {
  add(canvas: HTMLCanvasElement, s: number): number {
    const id = ++badgeSeq;
    badgeIds.add(id);
    const off = canvas.transferControlToOffscreen();
    fxWorker().postMessage({ type: 'bd-add', id, canvas: off, s, dpr: dprOf() }, [off]);
    return id;
  },
  del(id: number) {
    badgeIds.delete(id);
    fxW?.postMessage({ type: 'bd-del', id });
  },
  post(id: number, ops: Op[]) {
    fxW?.postMessage({ type: 'bd-do', id, ops });
  },
  /* 缩放页面、窗口换到另一个屏幕时 DPR 变了：小画布按新的 DPR 重设像素尺寸 */
  size() {
    for (const id of badgeIds) fxW?.postMessage({ type: 'bd-size', id, dpr: dprOf() });
  },
  /* 清空（看不见了、关掉动画、重建）：粒子和特效都不淡出 */
  reset(id: number) {
    fxW?.postMessage({ type: 'bd-reset', id });
  },
  /* 现有的特效淡出 */
  stop(id: number) {
    fxW?.postMessage({ type: 'bd-stop', id });
  },
  /* 时间倍率：只有开发模式的实验台会改它 */
  rate(rate: number) {
    fxW?.postMessage({ type: 'bd-rate', rate });
  },
  /* 每个徽记画了多少帧、此刻有多少粒子（检查看不见的徽记有没有在画） */
  stats(): Promise<BadgeStats[]> {
    return new Promise((res) => {
      statsWait.push(res);
      fxWorker().postMessage({ type: 'bd-stats' });
    });
  },
};
(window as Window & { __badgeStats?: () => Promise<BadgeStats[]> }).__badgeStats = () =>
  badgeFx.stats();
/* DPR 变了（缩放 110%、125%，换屏）：不一定有 resize 事件，用分辨率的媒体查询盯着 */
function watchDpr() {
  const mq = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
  mq.addEventListener(
    'change',
    () => {
      badgeFx.size();
      watchDpr();
    },
    { once: true },
  );
}
watchDpr();
