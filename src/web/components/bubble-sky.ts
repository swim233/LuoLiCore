import { skyShift } from '../lib/skyShift';
import { ensureBubbleSky } from '../lib/winSky';

/* 「预先糊好」方式（lib/glass.ts：正式页面里只有会话窗口整层淡入淡出的那 0.26 秒用它，开发模式里能整个切过去）下，
   气泡里垫的那层星空（.bubble-sky）和窗口里的星空对齐。
   背景怎么画、为什么要对齐见 app.css 的「时间线：毛玻璃气泡」；「实时模糊」方式（默认）下气泡里没有这一层，也没有这个文件里的任何东西在跑：
   没有挂着的层就没有观察器、没有滚动和滚轮的监听、没有每帧的探针（最后一层摘掉时都拆掉，见 shutdown）。
   这里只管位移：量气泡和窗口（.w-card）在屏幕上的矩形，算出「窗口的左上角相对气泡的左上角」（lib/skyShift.ts），
   写进这层自己的 --sk-x、--sk-y、--sk-w、--sk-h（只写在这一层上：它是叶子，不会让别的元素重算样式）。
   做法：脚本更新，不用 CSS 的 scroll 动画。条目是用 transform 定位的，CSS 的 view() 时间线不看 transform，对不上。
   - 什么时候更新：挂上的那一刻同步算一次（第一帧画出来的就是对好的，形变里复制出来的副本也带着这些值）；
     之后任何滚动区滚动（滚动事件不冒泡，在 document 上捕获）、气泡或窗口的大小变了（ResizeObserver）、时间线重新排了条目
     （VirtualLog 调 touchSky）、新挂上的气泡（出现动画、外框补间的头几百毫秒位置还在动），都排一次「接下来几帧每帧量一次」，
     没有事件了就停，闲着的时候一帧也不跑；
   - 量的时机在布局之后、绘制之前（ResizeObserver 的回调里）：滚轮缓动、各种滑动是在 rAF 里写 scrollTop 的，条目的位置是在别的
     ResizeObserver 回调里写的，在 rAF 里量会晚一帧（折叠展开时一帧挪 20 多 px，晚一帧就差 20 多 px）。每帧要量时，rAF 里把
     一个看不见的小元素的宽度来回改一下，让它的 ResizeObserver 在这一帧布局之后叫醒我们；VirtualLog 写完各条的位置后、
     气泡或窗口的大小变了时，直接在它们自己的回调里量（flushSky）；
   - 窗口在形变里被缩放、位置被动画推着走：量到的是屏幕上的矩形，两个矩形一起缩，差除以缩放换回排版的像素，所以窗口怎么动都不用更新；
   - 晚一帧更新看不出来：气泡后面的星空糊成了 20 像素的柔光，位移差几像素色差不到 3/255。 */
interface Sky {
  leaf: HTMLElement;
  /** 气泡本身（这一层的父元素） */
  box: HTMLElement;
  card: HTMLElement | null;
  v: [number, number, number, number];
}
const skies = new Set<Sky>();
/** 没有新的触发以后，还要每帧量多少毫秒 */
const HOLD = 400;
const HOLD_SCROLL = 120;
/** 离窗口的上下沿还有这么远（屏幕上的 px）以外的气泡这一帧不更新 */
const OFF = 120;
let raf = 0;
let until = 0;
let ro: ResizeObserver | null = null;
let listening = false;
const observed = new Map<Element, number>();

const fmt = (n: number) => Math.round(n * 100) / 100;

interface CardInfo {
  rect: DOMRect;
  w: number;
  h: number;
}
function apply(s: Sky, cards: Map<HTMLElement, CardInfo>, force = false) {
  if (!s.leaf.isConnected) return;
  if (!s.card || !s.card.isConnected) s.card = s.box.closest<HTMLElement>('.w-card');
  const card = s.card;
  if (!card) return;
  let ci = cards.get(card);
  if (!ci) {
    ci = { rect: card.getBoundingClientRect(), w: card.offsetWidth, h: card.offsetHeight };
    cards.set(card, ci);
  }
  const b = s.box.getBoundingClientRect();
  /* 在窗口外面的（虚拟列表多挂的几条、滚出去的）这一帧不用对：它们进到窗口里的那一帧，flush 照样在绘制之前量到它。
     少写一半的样式，也少重画一半的气泡 */
  if (!force && (b.width < 1 || b.bottom < ci.rect.top - OFF || b.top > ci.rect.bottom + OFF))
    return;
  const d = skyShift(b, ci.rect, ci.w, ci.h);
  if (!d) return;
  const next: Sky['v'] = [fmt(d.x), fmt(d.y), d.w, d.h];
  const names = ['--sk-x', '--sk-y', '--sk-w', '--sk-h'];
  for (let i = 0; i < 4; i++)
    if (s.v[i] !== next[i]) {
      s.v[i] = next[i];
      s.leaf.style.setProperty(names[i], next[i] + 'px');
    }
}
function flush() {
  const cards = new Map<HTMLElement, CardInfo>();
  for (const s of skies) apply(s, cards);
}
/* 看不见的小元素：每帧要量时改它的宽度，它的 ResizeObserver 在这一帧布局之后、绘制之前叫醒 flush */
let probe: HTMLElement | null = null;
let probeRo: ResizeObserver | null = null;
let flip = 0;
function frame() {
  raf = 0;
  if (performance.now() >= until) return;
  if (!probe) {
    probe = document.createElement('div');
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText =
      'position:fixed;left:-9px;top:-9px;width:1px;height:1px;visibility:hidden;pointer-events:none;contain:strict';
    document.body.append(probe);
    probeRo = new ResizeObserver(() => flush());
    probeRo.observe(probe);
  }
  flip ^= 1;
  probe.style.width = 1 + flip + 'px';
  raf = requestAnimationFrame(frame);
}
/** 位置可能变了（滚动、条目重新排、挂上了新的气泡）：接下来的几帧里每帧量一次 */
export function touchSky(hold = HOLD) {
  if (!skies.size) return;
  until = Math.max(until, performance.now() + hold);
  if (!raf) raf = requestAnimationFrame(frame);
}
/** 现在就量一次（调用的地方已经在布局之后、绘制之前：ResizeObserver 的回调里） */
export function flushSky() {
  if (skies.size) flush();
}

function watch(el: Element) {
  ro ??= new ResizeObserver(() => {
    flush();
    touchSky();
  });
  observed.set(el, (observed.get(el) ?? 0) + 1);
  if (observed.get(el) === 1) ro.observe(el);
}
function unwatch(el: Element) {
  const n = (observed.get(el) ?? 0) - 1;
  if (n > 0) return void observed.set(el, n);
  observed.delete(el);
  ro?.unobserve(el);
}

const onScroll = () => touchSky(HOLD_SCROLL);
/* 滚轮缓动（@luoli/ui/scroll 的 installWheel）在滚轮事件之后的 rAF 里写 scrollTop，滚动事件要晚一帧才来：滚轮事件一来就先排上，
   排的 rAF 在滚轮缓动的 rAF 后面（这个监听比 installWheel 里的晚装），同一帧里写完 scrollTop 再量，头一帧也是对的 */
const onWheel = () => touchSky(HOLD_SCROLL);
const LISTEN = { capture: true, passive: true } as const;

/** 最后一层摘掉了（切到「实时模糊」、气泡都卸载了）：监听、观察器、探针、排着的帧全部拆掉，之后不再有任何开销 */
function shutdown() {
  if (listening) {
    listening = false;
    document.removeEventListener('scroll', onScroll, LISTEN);
    document.removeEventListener('wheel', onWheel, LISTEN);
  }
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  until = 0;
  ro?.disconnect();
  ro = null;
  observed.clear();
  probeRo?.disconnect();
  probeRo = null;
  probe?.remove();
  probe = null;
}

/** 一层星空挂上了：马上量一次，之后跟着滚动和大小的变化更新。返回摘掉的函数 */
export function attachBubbleSky(leaf: HTMLElement): () => void {
  const box = leaf.parentElement;
  if (!box) return () => {};
  ensureBubbleSky();
  const s: Sky = { leaf, box, card: null, v: [NaN, NaN, NaN, NaN] };
  skies.add(s);
  if (!listening) {
    listening = true;
    document.addEventListener('scroll', onScroll, LISTEN);
    document.addEventListener('wheel', onWheel, LISTEN);
  }
  apply(s, new Map(), true);
  watch(box);
  const card = box.closest<HTMLElement>('.w-card');
  if (card) watch(card);
  touchSky();
  return () => {
    if (!skies.delete(s)) return;
    unwatch(box);
    if (card) unwatch(card);
    if (!skies.size) shutdown();
  };
}

/** 现在挂着多少层、有没有在跑（诊断用：切到「实时模糊」以后应当全是 0 / false） */
export function skyStats() {
  return {
    skies: skies.size,
    observed: observed.size,
    listening,
    ro: !!ro,
    raf: !!raf,
    probe: !!probe,
  };
}

/** 复制出来的一份窗口（形变用的副本、整理时跟着指针走的副本）挂到页面上以后：里面的星空按它自己的样子重新对一次。
    副本里的位移是从真窗口抄来的，但真窗口里滚在可视范围外面的那些条目没有更新过，副本的滚动位置也可能和真窗口不一样（拖动的副本没有带滚动位置），
    所以挂上以后都再量一遍。副本是静态的，量一次就够 */
export function realignSky(root: HTMLElement) {
  const cards = new Map<HTMLElement, CardInfo>();
  for (const leaf of root.querySelectorAll<HTMLElement>('.bubble-sky')) {
    const box = leaf.parentElement;
    if (box) apply({ leaf, box, card: null, v: [NaN, NaN, NaN, NaN] }, cards, true);
  }
}

/* 时间线（@luoli/ui/scroll 的 VirtualLog）的两个回调：条目的高度变了、位置挪了（同一帧里，布局之后绘制之前）让「预先糊好」的气泡星空当场重新对齐，
   接下来几帧也每帧对一次；每次定位做完（条目有增减、重新排了）再对一次，120 毫秒内每帧对。以前是 VirtualLog 自己调 flushSky、touchSky */
export const skyLogHooks = {
  onRowsMoved: () => {
    flushSky();
    touchSky();
  },
  onPositioned: () => touchSky(120),
};
