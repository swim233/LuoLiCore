import type { FrameSpec, Rect } from './morph';

/* 外框的另一种做法：一圈只动 transform、opacity 的小件（四条边线、四个圆角、两条交叉的底），每一帧由进度 p 算出各件的 transform，
   不走 Motion 的 layout 投影，所以没有每帧重新栅格（小件都是纯色，栅格一次就够）。
   防黑边：小件的元素本身取它最大时的大小，transform 只缩小、不放大（小数缩放下 1px 的元素放大几百倍，凑整的误差会被放大成缺口）。
   颜色过渡：两端颜色、圆角不一样时摆两套小件（起点那套垫在下面，终点那套淡入盖上去）。 */
const SH_T = 1,
  SH_O = 0.5;
type GeoKey = 'fa' | 'fb' | 'lt' | 'lb' | 'll' | 'lr';
type Geo = Record<GeoKey, number[]>;
function geo(R: Rect, p: number): Geo {
  const L = R.left,
    T = R.top,
    W = R.width,
    H = R.height,
    t = SH_T,
    o = SH_O;
  return {
    fa: [L + p - o, T, W - 2 * p + 2 * o, H],
    fb: [L, T + p - o, W, H - 2 * p + 2 * o],
    lt: [L + p, T, W - 2 * p, t],
    lb: [L + p, T + H - t, W - 2 * p, t],
    ll: [L, T + p, t, H - 2 * p],
    lr: [L + W - t, T + p, t, H - 2 * p],
  };
}
const corner = (R: Rect, c: number, k: string) =>
  ({
    tl: [R.left, R.top],
    tr: [R.left + R.width - c, R.top],
    bl: [R.left, R.top + R.height - c],
    br: [R.left + R.width - c, R.top + R.height - c],
  })[k]!;
const px = (v: number) => v.toFixed(2) + 'px';
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const rectAt = (A: Rect, B: Rect, p: number): Rect => ({
  left: lerp(A.left, B.left, p),
  top: lerp(A.top, B.top, p),
  width: lerp(A.width, B.width, p),
  height: lerp(A.height, B.height, p),
});
const rgb = (s: string) => (s.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
const close = (a: string, b: string) => {
  if (a === b) return true;
  const x = rgb(a),
    y = rgb(b);
  return x.length === 3 && y.length === 3 && x.every((v, i) => Math.abs(v - y[i]) <= 2);
};

interface Piece {
  el: HTMLElement;
  kind: 'flat' | 'corner';
  key: string;
  rad: number;
  base?: number[];
  op: [number, number];
}
export function createShell(host: HTMLElement, A: FrameSpec, B: FrameSpec) {
  host.textContent = '';
  const ra = Math.max(0, Math.min(A.radius, A.width / 2, A.height / 2)),
    rb = Math.max(0, Math.min(B.radius, B.width / 2, B.height / 2));
  const radDiff = Math.abs(ra - rb) >= 0.5;
  const differ = radDiff || !close(A.bg, B.bg) || !close(A.bd, B.bd);
  const sets = [{ rad: ra, bg: A.bg, bd: A.bd, over: false }];
  if (differ) sets.push({ rad: rb, bg: B.bg, bd: B.bd, over: true });
  const pieces: Piece[] = [];
  const mk = (css: Partial<CSSStyleDeclaration>, cls: string) => {
    const i = document.createElement('i');
    i.className = cls;
    Object.assign(i.style, css);
    host.append(i);
    return i;
  };
  const bw: Record<string, string> = {
    tl: `${SH_T}px 0 0 ${SH_T}px`,
    tr: `${SH_T}px ${SH_T}px 0 0`,
    br: `0 ${SH_T}px ${SH_T}px 0`,
    bl: `0 0 ${SH_T}px ${SH_T}px`,
  };
  const brad = (k: string, c: number) =>
    ({ tl: `${c}px 0 0 0`, tr: `0 ${c}px 0 0`, br: `0 0 ${c}px 0`, bl: `0 0 0 ${c}px` })[k]!;
  /* 叠放顺序：先铺所有的底（两套），再画所有的边线（两套），最后是边角的圆环。
     不这样排，to 那套半透明的底会盖在 from 那套已经画好的边线上，中点处线的颜色被底冲淡（实测只有两端的约 80%） */
  const setsGeo = sets.map((S) => ({ S, g0: geo(A, S.rad), g1: geo(B, S.rad) }));
  const flatPiece = (
    S: (typeof sets)[number],
    g0: Geo,
    g1: Geo,
    key: GeoKey,
    color: string,
    op: [number, number],
  ) => {
    const base = [Math.max(g0[key][2], g1[key][2], 1), Math.max(g0[key][3], g1[key][3], 1)];
    const el = mk(
      {
        position: 'absolute',
        left: '0',
        top: '0',
        transformOrigin: '0 0',
        width: px(base[0]),
        height: px(base[1]),
        backgroundColor: color,
      },
      'fs-flat',
    );
    pieces.push({ el, kind: 'flat', key, rad: S.rad, base, op });
  };
  for (const { S, g0, g1 } of setsGeo) {
    const fillOp: [number, number] = S.over ? [0, 1] : [1, 1];
    const cfOp: [number, number] = S.over ? [0, 1] : radDiff ? [1, 0] : [1, 1];
    for (const key of ['fa', 'fb'] as const) flatPiece(S, g0, g1, key, S.bg, fillOp);
    if (S.rad < 0.5) continue;
    for (const k of ['tl', 'tr', 'bl', 'br']) {
      const f = mk(
        {
          position: 'absolute',
          left: '0',
          top: '0',
          width: S.rad + 'px',
          height: S.rad + 'px',
          backgroundColor: S.bg,
          borderRadius: brad(k, S.rad),
        },
        'fs-corner',
      );
      pieces.push({ el: f, kind: 'corner', key: k, rad: S.rad, op: cfOp });
    }
  }
  /* 边线：半径相同时，颜色是不透明的，from 那套垫底不动、to 那套淡入盖上去，混出来正好是两端颜色的线性插值，中间不会变暗。
     （第 4.1 版是两套互相淡入淡出，中点处两层各只剩一部分，线的颜色只有两端的约 75%。）半径不同时两套线的位置对不上，只能互相淡入淡出 */
  const lineOpOf = (S: (typeof sets)[number]): [number, number] =>
    !differ ? [1, 1] : radDiff ? (S.over ? [0, 1] : [1, 0]) : S.over ? [0, 1] : [1, 1];
  for (const { S, g0, g1 } of setsGeo)
    for (const key of ['lt', 'lb', 'll', 'lr'] as const)
      flatPiece(S, g0, g1, key, S.bd, lineOpOf(S));
  for (const { S } of setsGeo) {
    if (S.rad < 0.5) continue;
    for (const k of ['tl', 'tr', 'bl', 'br']) {
      const r = mk(
        {
          position: 'absolute',
          left: '0',
          top: '0',
          width: S.rad + 'px',
          height: S.rad + 'px',
          boxSizing: 'border-box',
          borderStyle: 'solid',
          borderColor: S.bd,
          borderWidth: bw[k],
          borderRadius: brad(k, S.rad),
          backgroundColor: 'transparent',
        },
        'fs-corner',
      );
      pieces.push({ el: r, kind: 'corner', key: k, rad: S.rad, op: lineOpOf(S) });
    }
  }
  let lastP = -1;
  return {
    /* p：0 在起点、1 在终点 */
    update(p: number, Rin?: Rect) {
      const R = Rin ?? rectAt(A, B, p);
      host.style.opacity = String(lerp(A.opacity, B.opacity, p));
      const gcache = new Map<number, Geo>();
      for (const pc of pieces) {
        if (pc.kind === 'flat') {
          let g = gcache.get(pc.rad);
          if (!g) {
            g = geo(R, pc.rad);
            gcache.set(pc.rad, g);
          }
          const a = g[pc.key as keyof Geo];
          pc.el.style.transform = `translate(${px(a[0])}, ${px(a[1])}) scale(${(Math.max(0, a[2]) / pc.base![0]).toFixed(5)}, ${(Math.max(0, a[3]) / pc.base![1]).toFixed(5)})`;
        } else {
          const a = corner(R, pc.rad, pc.key);
          pc.el.style.transform = `translate(${px(a[0])}, ${px(a[1])})`;
        }
        if (pc.op[0] !== pc.op[1] && p !== lastP)
          pc.el.style.opacity = String(lerp(pc.op[0], pc.op[1], p));
      }
      lastP = p;
    },
  };
}
