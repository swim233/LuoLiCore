import { useEffect, useRef } from 'react';
import {
  type Bezier,
  DUR_GLIDE,
  EASE_GLIDE_BACK,
  EASE_GLIDE_GO,
  GLIDE_OVERSHOOT,
  GLIDE_PEAK,
  cssBezier,
} from '../easing';
import { motionOn } from '../motion';

/* 列表的悬停高亮：会话列表（桌面、全屏）、任务列表和对话里选会话的菜单共用。只在有鼠标时（(hover: hover) and (pointer: fine)，触屏没有）。
   对外：useGlide(行的选择器)、hideGlides()；样子在 glide.css（.ll-glide，.ll-hl，行的集合 .ll-row 和 .ll-glide-item）。
   - 一个列表一块高亮（.ll-glide，列表的第一个子元素，绝对定位在列表的内容里，跟着内容滚）：
     鼠标进到一行时用 transform 把它挪过去（0.3 秒）：先滑过目标约 4 像素再回来，过冲的距离固定、方向跟着滑动的方向，
     曲线与数字见 @luoli/ui/easing。位置用 Web Animations 的三段关键帧做。
     中途换目标（鼠标连着划过几行）时从此刻（动画里）的位置接着走：新动画从上一帧的时刻算起（不在原地多停一帧），
     顺着原来的方向时起步不比此刻慢（不先顿一下再走）。宽高跟着那一行，用 CSS 过渡，不回弹。
     从隐藏到显示时先瞬移到那一行再淡入（0.14 秒，不回弹）；离开列表淡出（0.25 秒）。
   - 边光要的 --ll-glide-mx、--ll-glide-my 是鼠标相对那一行的坐标（写在高亮上；关掉动画时写在那一行上）。
   - 列表变了，高亮不停在错的行上：
     - 列表滚动（鼠标没动）：瞬移到鼠标下现在的那一行；
     - 行进出场、重新排序（DOM 的子节点变了），或者鼠标下那一行自己挪了位置（进出场的高度动画、FLIP 排序）：
       淡掉，等鼠标再动、而且那一行停稳了（连着两帧位置不变）再出现；
     - 用的地方调 hideGlides()（面板：窗口开始形变——缩成胶囊、全屏——时调）：此刻显示着的高亮淡掉，等鼠标再动、行停稳了再出现；
       库不认识外壳，什么时候该淡掉由用的地方说了算。
   - 关掉动画（motionOn() 为假）：不滑，每一行自己淡入淡出（那一行加 .ll-hl，样式在行自己的 ::before、::after 上）。
   用法：const g = useGlide('.conv-item')；列表元素 ref={g.list}，第一个子元素 <i className="ll-glide" ref={g.glide} />。
   行要是库的 .ll-row，或者带 .ll-glide-item（不是 .ll-row 的行，比如菜单里的按钮），关动画时才有那两个伪元素。
   行得是 position: relative、自成一个层叠上下文、自己没有不透明的底（.ll-row 就是这样）。
   列表只看直接子节点的增减（MutationObserver）：行嵌在更里面的容器里时，行的增减不会让高亮淡掉。
   useGlide 只在挂载（和选择器变）时接一次：列表元素和 .ll-glide 要在挂载时就在。 */
/* 此刻有没有鼠标：用到的时候才读（这个入口加载时不碰 window） */
let hoverQuery: MediaQueryList | undefined;
const canHover = () =>
  (hoverQuery ??= window.matchMedia('(hover: hover) and (pointer: fine)')).matches;

/* 所有挂着的高亮各自「马上淡掉」的函数 */
const hiders = new Set<() => void>();
/** 让所有挂着的高亮马上淡掉：显示着的那块高亮（或关动画时那一行的高亮）淡出，等鼠标再动、鼠标下那一行停稳（连着两帧位置不变）再出现 */
export function hideGlides() {
  for (const hide of [...hiders]) hide();
}

export function useGlide(itemSel: string) {
  const list = useRef<HTMLElement | null>(null);
  const glide = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const l = list.current,
      g = glide.current;
    if (!l || !g) return;
    return attach(l, g, itemSel);
  }, [itemSel]);
  return { list, glide };
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
/* 行在列表内容里的位置（不受列表滚动影响；含行自己的 transform，也就是看得见的位置） */
function boxIn(l: HTMLElement, it: HTMLElement): Box {
  const lr = l.getBoundingClientRect(),
    r = it.getBoundingClientRect();
  return {
    x: r.left - lr.left - l.clientLeft + l.scrollLeft,
    y: r.top - lr.top - l.clientTop + l.scrollTop,
    w: r.width,
    h: r.height,
  };
}
const same = (a: Box | null, b: Box | null) =>
  !!a &&
  !!b &&
  Math.abs(a.x - b.x) < 0.5 &&
  Math.abs(a.y - b.y) < 0.5 &&
  Math.abs(a.w - b.w) < 0.5 &&
  Math.abs(a.h - b.h) < 0.5;

function attach(l: HTMLElement, g: HTMLElement, sel: string) {
  let at: HTMLElement | null = null; // 高亮现在在哪一行
  let box: Box | null = null; // 那一行在哪（放上去的时候）
  let shown = false;
  let stale = false; // 列表变过，等鼠标再动、行停稳了再出现
  let inside = false;
  let lx = 0,
    ly = 0;
  let raf = 0;
  let prev: Box | null = null; // 停稳检查：上一帧的位置
  let slide: Animation | null = null; // 正在滑的那段位置动画
  const fade = () => !motionOn();

  const itemAt = (x: number, y: number) => {
    const el = document.elementFromPoint(x, y);
    const it = el?.closest<HTMLElement>(sel);
    return it && l.contains(it) ? it : null;
  };
  const point = (it: HTMLElement) => {
    const r = it.getBoundingClientRect();
    const t = fade() ? it : g;
    t.style.setProperty('--ll-glide-mx', (lx - r.left).toFixed(1) + 'px');
    t.style.setProperty('--ll-glide-my', (ly - r.top).toFixed(1) + 'px');
  };
  const tr = (x: number, y: number) => `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
  const read = () => {
    const m = new DOMMatrixReadOnly(getComputedStyle(g).transform);
    return { x: m.m41, y: m.m42 };
  };
  /* 高亮此刻在哪、往哪走多快（像素/毫秒）：
     在滑就取动画里此刻（上一帧）的值，再把动画往回拨 8 毫秒量一次算出速度（这段动画接着就被换掉，拨了不要紧）；
     没在滑就是上次放到的位置，不动 */
  const here = () => {
    if (!slide) return box && { x: box.x, y: box.y, vx: 0, vy: 0 };
    const p = read();
    const t = slide.currentTime;
    if (typeof t !== 'number' || t <= 0) return { ...p, vx: 0, vy: 0 };
    const dt = Math.min(8, t);
    slide.currentTime = t - dt;
    const q = read();
    return { ...p, vx: (p.x - q.x) / dt, vy: (p.y - q.y) / dt };
  };
  /* 放到一行上：瞬移（snap），或者从此刻的位置滑过去，到位时回弹 */
  const put = (it: HTMLElement, b: Box, snap: boolean) => {
    const from = snap ? null : here();
    slide?.cancel();
    slide = null;
    if (snap) g.style.transition = 'none';
    g.style.transform = tr(b.x, b.y);
    g.style.width = b.w.toFixed(1) + 'px';
    g.style.height = b.h.toFixed(1) + 'px';
    if (snap) {
      void g.offsetWidth;
      g.style.transition = '';
    }
    const dx = from ? b.x - from.x : 0,
      dy = from ? b.y - from.y : 0,
      d = Math.hypot(dx, dy);
    if (from && d >= 0.5) {
      const ov = Math.min(GLIDE_OVERSHOOT, d / 4),
        k = ov / d;
      /* 起步的速度：曲线起点的斜率 y1/x1 对应「到最远处的距离 ÷ 第一段的时长」。
         此刻顺着新方向在走、而且比默认的起步快，就把 y1 抬到和此刻一样快（最多到 1，第一段不会冲过最远处）；
         反方向或者停着时用默认的曲线 */
      const [x1, y1, x2, y2] = EASE_GLIDE_GO;
      const v = (from.vx * dx + from.vy * dy) / d;
      const go: Bezier = [
        x1,
        Math.min(1, Math.max(y1, (v * DUR_GLIDE * GLIDE_PEAK * x1) / (d + ov))),
        x2,
        y2,
      ];
      const a = g.animate(
        [
          { transform: tr(from.x, from.y), easing: cssBezier(go) },
          {
            transform: tr(b.x + dx * k, b.y + dy * k),
            offset: GLIDE_PEAK,
            easing: cssBezier(EASE_GLIDE_BACK),
          },
          { transform: tr(b.x, b.y) },
        ],
        { duration: DUR_GLIDE },
      );
      /* 从上一帧的时刻算起：from 是上一帧的位置，下一帧就已经往前走了，不会在原地多停一帧 */
      a.startTime = document.timeline.currentTime;
      a.onfinish = () => {
        if (slide === a) slide = null;
      };
      slide = a;
    }
    at = it;
    box = b;
  };
  const show = (it: HTMLElement, snap: boolean) => {
    if (fade()) {
      if (at !== it) at?.classList.remove('ll-hl');
      it.classList.add('ll-hl');
      at = it;
      box = boxIn(l, it);
    } else put(it, boxIn(l, it), snap || !shown);
    shown = true;
    stale = false;
    g.classList.toggle('ll-on', !fade());
    point(it);
    loop();
  };
  const hide = () => {
    g.classList.remove('ll-on');
    at?.classList.remove('ll-hl');
    if (fade()) at = null;
    shown = false;
  };
  /* 停稳了再出现：鼠标下那一行连着两帧位置不变。鼠标下没有行（行与行的空隙、列表下面的空白）就先不等，鼠标再动时再看 */
  const settle = (): 'none' | 'wait' | 'done' => {
    const it = itemAt(lx, ly);
    if (!it) {
      prev = null;
      return 'none';
    }
    const b = boxIn(l, it);
    const ok = it === at && same(prev, b);
    prev = b;
    at = it;
    if (!ok) return 'wait';
    show(it, true);
    return 'done';
  };
  /* 鼠标在列表里时每帧看一眼：等着停稳（stale），或者高亮着的那一行挪了位置（进出场的高度动画、FLIP 排序）就淡掉 */
  const tick = () => {
    raf = 0;
    if (!inside) return;
    if (stale) {
      if (settle() === 'wait') raf = requestAnimationFrame(tick);
      return;
    }
    if (!shown || !at) return;
    if (!at.isConnected || !same(box, boxIn(l, at))) {
      hide();
      stale = true;
      prev = null;
      return;
    }
    raf = requestAnimationFrame(tick);
  };
  const loop = () => {
    if (!raf) raf = requestAnimationFrame(tick);
  };

  const onMove = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse' || !canHover()) return;
    lx = e.clientX;
    ly = e.clientY;
    inside = true;
    if (stale) {
      loop();
      return;
    }
    const it = (e.target as Element).closest<HTMLElement>(sel);
    if (!it || !l.contains(it)) {
      if (at && shown) point(at);
      return;
    }
    if (it !== at || !shown) show(it, false);
    else point(it);
  };
  const onLeave = () => {
    inside = false;
    stale = false;
    hide();
    cancelAnimationFrame(raf);
    raf = 0;
  };
  /* 列表滚动、鼠标没动：瞬移到鼠标下现在的那一行 */
  const onScroll = () => {
    if (!inside || !shown || stale) return;
    const it = itemAt(lx, ly);
    if (!it) return;
    if (it !== at) show(it, true);
    else {
      box = boxIn(l, it);
      point(it);
    }
  };
  /* 行进出场、重新排序：淡掉，等鼠标再动 */
  const mo = new MutationObserver(() => {
    if (!shown && !stale) return;
    hide();
    stale = true;
    prev = null;
  });
  mo.observe(l, { childList: true });
  /* hideGlides()：淡掉，等鼠标再动、行停稳 */
  const hideNow = () => {
    if (shown) {
      hide();
      stale = true;
      prev = null;
    }
  };
  hiders.add(hideNow);
  l.addEventListener('pointermove', onMove);
  l.addEventListener('pointerleave', onLeave);
  l.addEventListener('scroll', onScroll, { passive: true });
  return () => {
    mo.disconnect();
    hiders.delete(hideNow);
    cancelAnimationFrame(raf);
    slide?.cancel();
    l.removeEventListener('pointermove', onMove);
    l.removeEventListener('pointerleave', onLeave);
    l.removeEventListener('scroll', onScroll);
    at?.classList.remove('ll-hl');
  };
}
