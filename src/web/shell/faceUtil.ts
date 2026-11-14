import { cssRGB } from '@luoli/ui/util';
import { faces } from './faces';
import type { FrameSpec, Rect } from './morph';

/* 部件在桌面上现在的样子：普通大小（含浮起、灵动岛）的卡片，或缩略的胶囊 */
export interface Face {
  id: string;
  el: HTMLElement;
  inner: HTMLElement;
  kind: 'card' | 'now' | 'cap';
}
export function deskFace(id: string): Face | null {
  const f = faces(id);
  if (f.wrap?.isConnected && f.card)
    return { id, el: f.wrap, inner: f.card, kind: id === 'now' ? 'now' : 'card' };
  if (f.cap?.isConnected && f.capBtn && !f.cap.hasAttribute('data-placeholder'))
    return { id, el: f.cap, inner: f.capBtn, kind: 'cap' };
  return null;
}
export const rectOf = (r: DOMRect | Rect): Rect => ({
  left: r.left,
  top: r.top,
  width: r.width,
  height: r.height,
});

function rgbaOf(str: string): number[] | null {
  let m = /^rgba?\(([^)]+)\)/.exec(str);
  if (m) {
    const p = m[1]
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map(Number);
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  }
  m = /^color\(srgb\s+([^)]+)\)/.exec(str);
  if (m) {
    const p = m[1]
      .split(/[\s/]+/)
      .filter(Boolean)
      .map(Number);
    return [p[0] * 255, p[1] * 255, p[2] * 255, p.length > 3 ? p[3] : 1];
  }
  return null;
}
/* 半透明的颜色压在底色上，得到同样观感的不透明颜色：外框不透明，形变时后面的卡片不会透出来 */
function over(str: string, base: number[]) {
  const c = rgbaOf(str);
  if (!c || c[3] >= 1)
    return c ? `rgb(${Math.round(c[0])}, ${Math.round(c[1])}, ${Math.round(c[2])})` : str;
  const a = c[3];
  return `rgb(${[0, 1, 2].map((i) => Math.round(c[i] * a + base[i] * (1 - a))).join(', ')})`;
}
const rgbNums = (s: string) =>
  s
    .match(/[\d.]+/g)!
    .slice(0, 3)
    .map(Number);

/* 外框在某个位置上的样子：照抄那张卡片（或胶囊）算好的底色、边框、圆角。
   夜空窗口没有边框：边线取窗口四周那圈细线的颜色（--ll-sky-line，胶囊是 --ll-sky-line-cap），压在底色上 */
export function frameAt(
  inner: HTMLElement,
  r: Rect,
  kind: 'card' | 'now' | 'cap',
  opacity = 1,
): FrameSpec {
  const cs = getComputedStyle(inner);
  const page = cssRGB('--ll-bg').split(',').map(Number);
  const bg = over(cs.backgroundColor, page);
  const line =
    parseFloat(cs.borderTopWidth) > 0
      ? cs.borderTopColor
      : getComputedStyle(document.documentElement)
          .getPropertyValue(kind === 'cap' ? '--ll-sky-line-cap' : '--ll-sky-line')
          .trim();
  const bd = over(line || cs.borderTopColor, rgbNums(bg));
  return {
    left: r.left,
    top: r.top,
    width: r.width,
    height: r.height,
    radius: kind === 'cap' ? r.height / 2 : parseFloat(cs.borderTopLeftRadius) || 16,
    bg,
    bd,
    opacity,
  };
}
/* 至少一半在视口里，才从它那里长出来、落回它那里；否则从窗口中间淡入淡出 */
export function onScreen(r: Rect | null) {
  if (!r || r.width < 4 || r.height < 4) return false;
  const w = Math.max(0, Math.min(r.left + r.width, window.innerWidth) - Math.max(r.left, 0));
  const hh = Math.max(0, Math.min(r.top + r.height, window.innerHeight) - Math.max(r.top, 0));
  return w * hh >= r.width * r.height * 0.5;
}
/* 部件被别的东西盖住了一块（浮起的「此刻」、灵动岛、顶栏、开发模式的演示控制……）：从它那里长出来会在第一帧把盖住的部分翻到上面，
   落回去时最后一帧又会突然被盖住。这种情况改成从窗口中间淡入淡出。在部件上取 5×3 个点，看最上面的是不是它自己 */
export function occluded(face: Face, r: Rect) {
  for (let i = 0; i < 5; i++)
    for (let j = 0; j < 3; j++) {
      const x = r.left + 6 + ((r.width - 12) * i) / 4,
        y = r.top + 6 + ((r.height - 12) * j) / 2;
      if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) continue;
      const hit = document.elementsFromPoint(x, y).find((n) => !n.closest('#fs, #ghosts'));
      if (!hit || face.el.contains(hit)) continue;
      const o = hit.closest(
        '.w, .cap-wrap, .top, [data-dev], .tray, .arrange-bar, .pop, .island-slot',
      );
      if (o && !face.el.contains(o) && !o.contains(face.el)) return true;
    }
  return false;
}
export const shrinkRect = (r: Rect, k: number): Rect => ({
  left: r.left + (r.width * (1 - k)) / 2,
  top: r.top + (r.height * (1 - k)) / 2,
  width: r.width * k,
  height: r.height * k,
});

/* 滚动驱动的动画（窗格上下的渐变和模糊，见 @luoli/ui 的 scroll/pane.css）此刻该有的透明度。
   刚挂上的窗口里这些动画还没有开始（pending）：时间线要到下一帧才有当前时间，这时读到的是基准值（透明度 0）；
   从胶囊展开、全屏退回桌面时，复制层是在挂上的那一刻复制的，把这个 0 写死进去，副本里上下的渐变就一直是没有的，
   滚进头部、输入框下面的内容露出来压在它们上面。这里按动画自己的关键帧、范围和滚动区此刻的位置直接算出该有的值。
   算不了（时间线已经有当前时间、不是纵向、没有滚动范围、不是线性缓动、关键帧里不只是透明度、范围的写法认不得）就返回 null，
   调用的地方照旧用读到的值 */
type Numeric = { value?: number; unit?: string; operator?: string; values?: Iterable<Numeric> };
function rangePx(v: unknown, max: number): number | null {
  const n = v as Numeric | null;
  if (!n) return null;
  if (n.unit === 'px') return n.value ?? null;
  if (n.unit === 'percent') return n.value === undefined ? null : (n.value / 100) * max;
  if (n.operator === 'negate') {
    const x = rangePx((n as { value?: unknown }).value, max);
    return x === null ? null : -x;
  }
  if (n.operator === 'sum' && n.values) {
    let sum = 0;
    for (const x of n.values) {
      const px = rangePx(x, max);
      if (px === null) return null;
      sum += px;
    }
    return sum;
  }
  return null;
}
function scrollDrivenOpacity(a: Animation): number | null {
  if (typeof ScrollTimeline === 'undefined' || !(a.timeline instanceof ScrollTimeline)) return null;
  const eff = a.effect as KeyframeEffect | null;
  const src = a.timeline.source as HTMLElement | null;
  if (a.timeline.currentTime !== null || !eff || !src || a.timeline.axis === 'x') return null;
  const max = src.scrollHeight - src.clientHeight;
  if (max <= 0) return null;
  const range = a as unknown as {
    rangeStart?: { offset: unknown };
    rangeEnd?: { offset: unknown };
  };
  const start = rangePx(range.rangeStart?.offset, max);
  const end = rangePx(range.rangeEnd?.offset, max);
  if (start === null || end === null || end <= start) return null;
  const tm = eff.getTiming();
  if (tm.easing !== 'linear' || tm.direction !== 'normal' || tm.iterations !== 1) return null;
  const kf = eff.getKeyframes();
  if (kf.length < 2 || kf.some((k) => k.easing !== 'linear' || k.opacity === undefined))
    return null;
  const p = Math.min(1, Math.max(0, (src.scrollTop - start) / (end - start)));
  for (let i = 1; i < kf.length; i++) {
    const o0 = kf[i - 1].computedOffset;
    const o1 = kf[i].computedOffset;
    if (p <= o1 || i === kf.length - 1) {
      const v0 = parseFloat(String(kf[i - 1].opacity));
      const v1 = parseFloat(String(kf[i].opacity));
      if (Number.isNaN(v0) || Number.isNaN(v1)) return null;
      return o1 > o0 ? v0 + (v1 - v0) * Math.min(1, Math.max(0, (p - o0) / (o1 - o0))) : v1;
    }
  }
  return null;
}

/* 复制一份桌面上的部件当形变用的内容层：滚动位置、正在跑的动画此刻的样子都照搬，第一帧和原来的一模一样 */
/* 复制出来的内容层，带着形变要用的几个临时属性：起点的矩形、各处的滚动位置、挂上页面后补滚动位置的函数 */
export type CloneEl = HTMLElement & {
  _rect: Rect;
  _scrolls: [number, number, number][];
  _restore?: () => void;
};
export function cloneFace(face: Face): CloneEl {
  const src = face.el,
    r = src.getBoundingClientRect();
  const c = src.cloneNode(true) as CloneEl;
  c.removeAttribute('id');
  c.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
  c.classList.remove('is-float', 'is-island', 'is-active', 'is-placeholder');
  c.removeAttribute('data-lifted');
  c.removeAttribute('data-hide');
  c.removeAttribute('data-placeholder');
  c.classList.add('is-frozen', 'is-morphing');
  if (src.closest('.island-slot')) c.classList.add('in-island');
  c.querySelectorAll('.w-edge.run').forEach((n) => n.classList.remove('run'));
  c.setAttribute('aria-hidden', 'true');
  c.inert = true;
  c.dataset.clone = '1';
  c.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;z-index:auto;`;
  c._rect = rectOf(r);
  const pathOf = (n: Node | null) => {
    const p: number[] = [];
    while (n && n !== src) {
      p.push(Array.prototype.indexOf.call(n.parentNode!.children, n));
      n = n.parentNode;
    }
    return n === src ? p.reverse() : null;
  };
  for (const a of src.getAnimations({ subtree: true })) {
    const t = (a.effect as KeyframeEffect | null)?.target as HTMLElement | null;
    if (!t || t === src || (a.effect as KeyframeEffect).pseudoElement) continue;
    const p = pathOf(t);
    const ct =
      p && (p.reduce<Element | undefined>((n, i) => n?.children[i], c) as HTMLElement | undefined);
    if (!ct) continue;
    const cs = getComputedStyle(t);
    ct.style.transform = cs.transform;
    const sd = scrollDrivenOpacity(a);
    ct.style.opacity = sd === null ? cs.opacity : String(sd);
  }
  const all = src.querySelectorAll('*');
  c._scrolls = [];
  for (let i = 0; i < all.length; i++)
    if (all[i].scrollTop || all[i].scrollLeft)
      c._scrolls.push([i, all[i].scrollTop, all[i].scrollLeft]);
  /* 滚动位置要等复制层挂到页面上之后才能设（MorphWrap 把它挂进内容层容器后调用）。
     所有用复制层的形变（桌面重排、全屏打开、全屏关闭）都靠它，所以放在 cloneFace 里，不让哪一处漏调 */
  c._restore = () => {
    if (!c._scrolls.length) return;
    const call = c.querySelectorAll('*');
    for (const [i, t, l] of c._scrolls)
      if (call[i]) {
        call[i].scrollTop = t;
        call[i].scrollLeft = l;
      }
  };
  return c;
}
/* 形变结束：去掉 is-morphing 时不要让卡片的边框、阴影再过渡一遍 */
export function unmorph(w: HTMLElement | null | undefined) {
  if (!w) return;
  w.classList.add('no-tr');
  w.classList.remove('is-morphing');
  if (w.firstElementChild) void getComputedStyle(w.firstElementChild).borderTopColor;
  w.classList.remove('no-tr');
}
