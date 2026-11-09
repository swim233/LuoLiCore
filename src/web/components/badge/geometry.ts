import { STAR_PATH } from '../icons';

/* 徽记的几何：弯月、四角星、小卫星的形状（viewBox -50..50），绕星星转的椭圆轨道 */
export { STAR_PATH };
export const TAU = Math.PI * 2;
export const MS = 1.12;

/* 弯月 = 大圆去掉一个偏上偏右的小圆；坐标是演示页的数值乘 MS（演示页里是 scale(MS) 的一层）。
   算出两圆的交点，画成一条路径：外圆的长弧加里圆的短弧 */
const M = { ox: -4 * MS, oy: 4 * MS, R: 32 * MS, cx: 9 * MS, cy: -6 * MS, rc: 30 * MS };
export const MOON_GRAD = { cx: M.cx, cy: M.cy, r: 50 * MS };
function crescent() {
  const dx = M.cx - M.ox,
    dy = M.cy - M.oy,
    d = Math.hypot(dx, dy);
  const a = (M.R * M.R - M.rc * M.rc + d * d) / (2 * d),
    h = Math.sqrt(M.R * M.R - a * a);
  const ux = dx / d,
    uy = dy / d;
  const px = M.ox + a * ux,
    py = M.oy + a * uy;
  const p1 = [px - uy * h, py + ux * h],
    p2 = [px + uy * h, py - ux * h];
  const f = (v: number) => v.toFixed(2);
  return `M${f(p1[0])} ${f(p1[1])}A${f(M.R)} ${f(M.R)} 0 1 1 ${f(p2[0])} ${f(p2[1])}A${f(M.rc)} ${f(M.rc)} 0 0 0 ${f(p1[0])} ${f(p1[1])}Z`;
}
export const MOON_PATH = crescent();
/* 弯月的凹处：z 从这里冒出来 */
export const HOLLOW = { x: 12 * MS, y: -14 * MS };
/* 小卫星的形状，以自己为中心 */
export const SAT_PATH = 'M0-11C.8-3 3-.8 11 0C3 .8 .8 3 0 11C-.8 3-3 .8-11 0C-3-.8-.8-3 0-11Z';

/* 绕主星转的轨道：沿一条倾斜的椭圆，快慢有起伏（关键帧的位置不是均匀的）。
   坐标单位是徽记的 100×100；转到后面（front 为负）时变小变暗，压到主星下面 */
export interface Orbit {
  /** 关键帧的位置（0~1）、各点的位置（单位）、各点是否在前面 */
  offs: number[];
  xs: number[];
  ys: number[];
  fronts: boolean[];
  per: number;
  /** 各点的缩放和透明度 */
  scales: number[];
  ops: number[];
}
export interface OrbitSpec {
  R: number;
  ry: number;
  tilt: number;
  dir?: number;
  ph?: number;
  per: number;
  /** 缩放：base + amp · front；透明度同理 */
  scale: [number, number];
  opacity: [number, number];
}
const N = 24;
export function orbitPoint(sp: Pick<OrbitSpec, 'R' | 'ry' | 'tilt'>, th: number) {
  const x0 = sp.R * Math.cos(th),
    y0 = sp.R * sp.ry * Math.sin(th);
  return {
    x: x0 * Math.cos(sp.tilt) - y0 * Math.sin(sp.tilt),
    y: x0 * Math.sin(sp.tilt) + y0 * Math.cos(sp.tilt),
    front: Math.sin(th),
  };
}
export function makeOrbit(sp: OrbitSpec): Orbit {
  const o: Orbit = { offs: [], xs: [], ys: [], fronts: [], per: sp.per, scales: [], ops: [] };
  const dir = sp.dir ?? 1,
    ph = sp.ph ?? 0;
  for (let k = 0; k <= N; k++) {
    const p = orbitPoint(sp, ph + (dir * TAU * k) / N);
    o.offs.push(k / N + (k % N ? 0.035 * Math.sin((4 * Math.PI * k) / N) : 0));
    o.xs.push(p.x);
    o.ys.push(p.y);
    o.fronts.push(p.front >= 0);
    o.scales.push(sp.scale[0] + sp.scale[1] * p.front);
    o.ops.push(sp.opacity[0] + sp.opacity[1] * p.front);
  }
  return o;
}
/** 关键帧：translate 用 unit 换算（'%' 是徽记宽度的百分比，数字是每个单位多少 px） */
export function orbitFrames(o: Orbit, unit: '%' | number): Keyframe[] {
  const t = (v: number) =>
    unit === '%' ? v.toFixed(2) + '%' : ((v * unit) / 100).toFixed(2) + 'px';
  return o.offs.map((off, k) => ({
    offset: off,
    transform: `translate(${t(o.xs[k])},${t(o.ys[k])}) scale(${o.scales[k].toFixed(3)})`,
    opacity: o.ops[k].toFixed(3),
  }));
}
/** 动画走到进度 p（0~1）时的位置（单位）和是否在前面；和浏览器按关键帧线性插值的结果一致 */
export function orbitAt(o: Orbit, p: number) {
  p = ((p % 1) + 1) % 1;
  let k = 0;
  while (k < o.offs.length - 2 && p >= o.offs[k + 1]) k++;
  const f = (p - o.offs[k]) / (o.offs[k + 1] - o.offs[k] || 1);
  return {
    x: o.xs[k] + (o.xs[k + 1] - o.xs[k]) * f,
    y: o.ys[k] + (o.ys[k + 1] - o.ys[k]) * f,
    front: f < 0.5 ? o.fronts[k] : o.fronts[k + 1],
  };
}

/* 伴星静止时（关掉动画、没跑脚本的复制层、刚挂上还没开始动的徽记）停在轨道上的位置（弧度）。
   styles/app.css 里 .bd-c0~2 .bd-cmv 的静态姿态是照这三个角度、用上面的 orbitPoint 和缩放、透明度公式算出来的，
   改了这里要同步改那里；伴星重建时也从这个角度开始转，所以从静止的位置接着动，不跳 */
export const COMP_STATIC_TH = [0.5, 2.5, 4.1];
/* 小卫星：从右上角出发，6.4 秒一圈 */
export const SAT_ORBIT: OrbitSpec = {
  R: 44,
  ry: 0.45,
  tilt: -0.6,
  per: 6400,
  scale: [0.8, 0.25],
  opacity: [0.62, 0.38],
};
/* 伴星：半径、倾角、方向、周期都不同 */
export const COMP_ORBITS: Omit<OrbitSpec, 'ph'>[] = [
  { R: 62, ry: 0.42, tilt: -0.35, dir: 1, per: 5600, scale: [0.86, 0.16], opacity: [0.7, 0.3] },
  { R: 70, ry: 0.42, tilt: 0.5, dir: -1, per: 7700, scale: [0.86, 0.16], opacity: [0.7, 0.3] },
  { R: 78, ry: 0.42, tilt: 0.12, dir: 1, per: 9400, scale: [0.86, 0.16], opacity: [0.7, 0.3] },
];
