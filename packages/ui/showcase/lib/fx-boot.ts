import { fx, sky } from '../../src/fx';

/* 展示页启动背景星空和整屏星尘：每张画布只能转移一次，已经启动了就不再建 Worker（库的 start 本来也挡，这里先挡是为了不白建一个星尘的 Worker）。
   星空的 Worker 库自己建；星尘的 Worker 由这里建好传给库（和面板的做法一样，只是面板里它还要和徽记的小画布共用） */
let skyOn = false,
  fxOn = false;
const NARROW = '(max-width: 719px)';
export function startSky(canvas: HTMLCanvasElement) {
  if (skyOn) return;
  skyOn = true;
  sky.start(canvas, {
    narrow: () => matchMedia(NARROW).matches,
    lowPower: (navigator.hardwareConcurrency || 8) <= 4,
  });
}
export function startFx(canvas: HTMLCanvasElement) {
  if (fxOn) return;
  fxOn = true;
  const narrow = () => matchMedia(NARROW).matches;
  const low = (navigator.hardwareConcurrency || 8) <= 4;
  fx.start(canvas, {
    worker: new Worker(new URL('../fx.worker.ts', import.meta.url), { type: 'module' }),
    scale: () => (narrow() ? 0.5 : 1) * (low ? 0.5 : 1),
  });
}
