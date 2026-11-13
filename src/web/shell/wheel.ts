import { motionOn } from '@luoli/ui/motion';
import { WHEEL_EVENT, wheelPixels, WheelMotion, wheelRegistry, WheelStream } from '@luoli/ui/wheel';
import { motionBusy } from './morph';

/* 滚轮缓动：整个页面只在 document 上挂一份监听（boot.ts 里装），按滚轮事件的位置找到该滚的竖向滚动区，
   以后新加的竖向滚动区不用单独接。数学（剩下的距离、每帧走多少）在 @luoli/ui/wheel。
   接管：鼠标滚轮这种整格的滚动。触控板一类的像素级小步、按着 Ctrl/Shift/Alt/Meta 的、关掉动画时、
   形变和让位动画进行中，都不接管，交给浏览器，而且此刻还没走完的滚轮缓动立刻清掉（不要两边抢）；键盘、按下鼠标、触屏也一样。
   大小步混在一起的一串事件（触控板甩动）接不接管只在这一串的第一个事件上定，整串一致（@luoli/ui/wheel 的 WheelStream）。
   找滚动区：从事件的目标往外一层一层找，第一个 overflow-y 是 auto、scroll（或 overlay）而且内容真的超出了的元素；
   找到页面根（html）就用 document.scrollingElement（桌面本身的滚动；全屏锁滚动时 html 的 overflow-y 是 hidden，不算）。
   - 输入框一类（textarea、input、select）自己能滚的，整个交给浏览器；
   - 带 data-native-wheel 的元素里面不接管（待发图片那一排自己把竖滚轮变成横着走）；
   - 横着滚的（代码块、表格、切换条）overflow-y 不是 auto，找不到它，滚的就是外面那个竖向的；
   - 滚到头以后接着滚谁，和浏览器一样：滚动区设了 overscroll-behavior: contain / none（部件的内容区、选会话的菜单）就停在这里，
     没设的（思考内容框）接着滚外面一层；设了 contain / none 的滚动区哪怕内容放得下、没有可滚的，也停在这里（浏览器也是这样，不带着外面走）；
   - 连着滚的一串滚轮事件锁在同一个滚动区（LATCH_MS 内没有新的滚轮事件才重新找）：滚到头的那一瞬间不会突然换成滚外层，
     和浏览器原生「滚到头也不立刻换」的手感一样。
   每个滚动区一个 WheelMotion（登记在 @luoli/ui/wheel 的 wheelRegistry 里，别的代码用 isWheeling、wheelDir、cancelWheel 看它或让它放手）。
   开始往某个方向滚时在滚动区上同步发 WHEEL_EVENT（带 detail.dy），虚拟列表、思考框据此马上不再贴底。 */
const LATCH_MS = 400;
/** 还能往这个方向滚的距离不到这么多 px 算到头了 */
const EDGE = 0.5;
const KEY = '__luoliWheelOff';

const live = new Set<WheelMotion>();
const stream = new WheelStream();
let latch: { el: HTMLElement; t: number } | null = null;

const maxOf = (el: HTMLElement) => Math.max(0, el.scrollHeight - el.clientHeight);

function motionFor(el: HTMLElement): WheelMotion {
  const had = wheelRegistry.get(el) as WheelMotion | undefined;
  if (had) return had;
  const m: WheelMotion = new WheelMotion(
    {
      get: () => el.scrollTop,
      set: (v) => {
        el.scrollTop = v;
      },
      max: () => maxOf(el),
      now: () => performance.now(),
      raf: (cb) => requestAnimationFrame(cb),
      caf: (id) => cancelAnimationFrame(id),
    },
    { onIdle: () => live.delete(m), alive: () => motionOn() && !motionBusy() },
  );
  wheelRegistry.set(el, m);
  return m;
}

function capacityOf(el: HTMLElement, dir: 1 | -1) {
  const m = wheelRegistry.get(el) as WheelMotion | undefined;
  if (m) return m.capacity(dir);
  return dir > 0 ? maxOf(el) - el.scrollTop : el.scrollTop;
}

const isControl = (el: Element) => /^(TEXTAREA|INPUT|SELECT)$/.test(el.tagName);

const isScroller = (cs: CSSStyleDeclaration) =>
  cs.overflowY === 'auto' || cs.overflowY === 'scroll' || cs.overflowY === 'overlay';
const overflowsY = (el: Element) => el.scrollHeight - el.clientHeight > 1;
/** 滚到头、或者根本没有可滚的内容时，设了 contain / none 的滚动区把滚轮挡在这里，不往外传 */
const containsOverscroll = (cs: CSSStyleDeclaration) =>
  cs.overscrollBehaviorY === 'contain' || cs.overscrollBehaviorY === 'none';

/** 该滚的滚动区：找到了返回它，交给浏览器（输入框、没有可滚的）返回 null。
    返回的滚动区可能这个方向已经滚不动（contain / none 挡在这里），调用的人要看 capacity */
function pick(target: Element, dir: 1 | -1, now: number): HTMLElement | null {
  if (target.closest('[data-native-wheel]')) return null;
  if (latch && now - latch.t < LATCH_MS && latch.el.isConnected && latch.el.contains(target))
    return latch.el;
  for (let el: Element | null = target; el; el = el.parentElement) {
    if (el === document.body) continue;
    const cs = getComputedStyle(el);
    if (isControl(el)) {
      if (isScroller(cs) && overflowsY(el)) return null;
      continue;
    }
    if (el === document.documentElement) {
      const root = document.scrollingElement as HTMLElement | null;
      if (root && cs.overflowY !== 'hidden' && maxOf(root) > 1) {
        if (capacityOf(root, dir) > EDGE || containsOverscroll(cs)) return root;
      }
      continue;
    }
    if (!isScroller(cs)) {
      // overflow: hidden 也是滚动容器，设了 contain / none 照样挡住往外传：交给浏览器，它什么也不滚
      if (cs.overflowY === 'hidden' && containsOverscroll(cs)) return null;
      continue;
    }
    if (overflowsY(el) && capacityOf(el as HTMLElement, dir) > EDGE) return el as HTMLElement;
    // 滚到头了，或者内容放得下：设了 contain / none 的停在这里（吞掉，不带着外面走），没设的接着找外面一层
    if (containsOverscroll(cs)) return el as HTMLElement;
  }
  return null;
}

function cancelAll() {
  for (const m of [...live]) m.cancel();
}

function onWheel(e: WheelEvent) {
  if (e.defaultPrevented) return;
  // 没有位移的事件（只带阶段信息）不算，不打断一串，也不清余量
  if (!e.deltaX && !e.deltaY) return;
  const take = stream.decide(e, motionOn() && !motionBusy(), e.timeStamp || performance.now());
  // 浏览器已经在原生滚动、事件取消不掉（比如主线程卡了一下，合成线程先滚了）：让它滚，不要两边一起滚
  if (!take || !e.cancelable) {
    cancelAll();
    return;
  }
  const t = e.target;
  if (!(t instanceof Element)) return;
  const dir = e.deltaY > 0 ? 1 : -1;
  const now = performance.now();
  const el = pick(t, dir, now);
  if (!el) {
    cancelAll();
    return;
  }
  e.preventDefault();
  latch = { el, t: now };
  // 到头了（或者设了 contain / none 的滚动区内容放得下）：这一格吞掉，不攒着，也不带着外面走
  if (capacityOf(el, dir) <= EDGE) return;
  const m = motionFor(el);
  const dy = wheelPixels(e, el.clientHeight);
  live.add(m);
  m.add(dy);
  el.dispatchEvent(new CustomEvent(WHEEL_EVENT, { detail: { dy } }));
}

/** 装上滚轮缓动，返回拆掉的函数。整个页面只装一份 */
export function installWheel(): () => void {
  const w = window as unknown as Record<string, (() => void) | undefined>;
  w[KEY]?.();
  const opts = { capture: true, passive: true } as const;
  const stop = () => cancelAll();
  document.addEventListener('wheel', onWheel, { capture: true, passive: false });
  for (const ev of ['keydown', 'pointerdown', 'mousedown', 'touchstart'] as const)
    document.addEventListener(ev, stop, opts);
  const off = () => {
    document.removeEventListener('wheel', onWheel, { capture: true });
    for (const ev of ['keydown', 'pointerdown', 'mousedown', 'touchstart'] as const)
      document.removeEventListener(ev, stop, opts);
    cancelAll();
    latch = null;
    stream.reset();
    w[KEY] = undefined;
  };
  w[KEY] = off;
  return off;
}
