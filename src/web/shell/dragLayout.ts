/* 整理模式拖动换位的纯计算：给定顺序和指针的位置，算出被拖的部件该排到哪里。不碰 DOM，所以可以单独测试。

   为什么不按「指针下面是哪张卡」判断：那样看的是动画途中的位置，换位以后别的卡片滑开时又经过指针，会再触发一次换位，来回不停；
   小卡拖到大卡上时，换过去的小卡只占大卡的一格，指针所在的格子被网格的 dense 排布填进了第三张卡，换位又把顺序换回去。
   这里的做法：对每个可能的插入位置，按浏览器的排布规则把整个顺序排一遍，只留下「排好以后被拖的部件盖住指针」的位置。
   结果只由指针的位置、其他部件的顺序和大小决定：换过去以后，被拖的部件盖住指针，再算一次就是「不动」，所以停住（含抖动）时不会反复换位。 */

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Pt {
  x: number;
  y: number;
}
/** 一个部件占的列数和行数 */
export type Span = readonly [cols: number, rows: number];
export interface Size {
  w: number;
  h: number;
}
/** 把整个顺序排一遍：返回的第 i 个盒子是 order[i] 的位置和大小 */
export type LayoutFn = (order: readonly string[]) => Box[];

/* CSS 网格 grid-auto-flow: row dense 的排布：按顺序，每个部件放在「从左上角起一行一行扫，第一个放得下的位置」。
   单位是格子：x、y 是列、行（从 0 起），w、h 是占的列数、行数。列数不够的部件占满一行（和 spanOf 一样收到列数以内） */
export function packDense(cols: number, spans: readonly Span[]): Box[] {
  const n = Math.max(1, Math.floor(cols));
  const taken = new Set<number>();
  const at = (c: number, r: number) => r * n + c;
  return spans.map(([sc, sr]) => {
    const w = Math.min(Math.max(1, Math.floor(sc)), n);
    const h = Math.max(1, Math.floor(sr));
    for (let r = 0; ; r++) {
      for (let c = 0; c + w <= n; c++) {
        let free = true;
        for (let dr = 0; dr < h && free; dr++)
          for (let dc = 0; dc < w; dc++)
            if (taken.has(at(c + dc, r + dr))) {
              free = false;
              break;
            }
        if (!free) continue;
        for (let dr = 0; dr < h; dr++) for (let dc = 0; dc < w; dc++) taken.add(at(c + dc, r + dr));
        return { x: c, y: r, w, h };
      }
    }
  });
}

/* flex-wrap: wrap 的排布（胶囊那一排）：从左往右排，这一行放不下就换行；一行的高度是这一行里最高的。单位是像素 */
export function flowWrap(width: number, gapX: number, gapY: number, sizes: readonly Size[]): Box[] {
  const boxes: Box[] = [];
  let x = 0,
    y = 0,
    lineH = 0;
  for (const s of sizes) {
    if (x > 0 && x + s.w > width + 0.01) {
      y += lineH + gapY;
      x = 0;
      lineH = 0;
    }
    boxes.push({ x, y, w: s.w, h: s.h });
    x += s.w + gapX;
    lineH = Math.max(lineH, s.h);
  }
  return boxes;
}

const covers = (b: Box | undefined, p: Pt) =>
  !!b && p.x >= b.x && p.x < b.x + b.w && p.y >= b.y && p.y < b.y + b.h;

export interface ChooseOpts {
  /** 现在的顺序（含被拖的部件） */
  order: readonly string[];
  dragged: string;
  layout: LayoutFn;
  /** 指针的位置，和 layout 返回的盒子是同一个坐标系（格子或像素）。位置在 y 方向无穷大表示指针在所有部件的下面 */
  point: Pt;
  /** 指针附近的几个点：现在的排布盖住其中任何一个，也算盖住（防止指针停在两格交界处、抖动一下就换位） */
  near?: readonly Pt[];
  /** 指针在所有部件的后面时，要不要放到最后（默认要）。拖动时调用方先传 false，指针在后面的空白处停够了时间再传 true */
  end?: boolean;
}

/* 返回新的顺序；返回 null 表示不用动：
   - 现在的排布已经盖住指针（或指针附近），不动；
   - 有几个插入位置排好以后都盖住指针，取离现在位置（顺序里的下标）最近的，一样近的取靠前的；
   - 一个都没有：指针在所有部件的后面（最后一行的右边、最后一个部件的下面），放到最后（end 为 false 时不放）；否则不动。 */
export function chooseOrder(o: ChooseOpts): string[] | null {
  const cur = o.order.indexOf(o.dragged);
  if (cur < 0) return null;
  const others = o.order.filter((id) => id !== o.dragged);
  const withAt = (k: number) => [...others.slice(0, k), o.dragged, ...others.slice(k)];
  const boxAt = (k: number) => o.layout(withAt(k))[k];
  const here = o.layout(o.order)[cur];
  if (covers(here, o.point) || o.near?.some((p) => covers(here, p))) return null;
  let best = -1;
  for (let k = 0; k <= others.length; k++) {
    if (k === cur || !covers(boxAt(k), o.point)) continue;
    if (best < 0 || Math.abs(k - cur) < Math.abs(best - cur)) best = k;
  }
  if (best >= 0) return withAt(best);
  if (o.end === false) return null;
  const p = o.point;
  const after = o.layout(others).every((b) => p.y >= b.y + b.h || (p.y >= b.y && p.x >= b.x + b.w));
  if (after && cur !== others.length) return withAt(others.length);
  return null;
}
