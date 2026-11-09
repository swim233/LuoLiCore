import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { motionOn } from '../lib/prefs';

/* 虚拟滚动的时间线：@tanstack/react-virtual，动态高度，贴底。
   它自己就是窗格（components/Pane.tsx）的滚动区（.pane-sc）：上下的内边距里有浮在上面的标题、输入框，位置都要算上它们：
   - 切换会话（resetKey 变）：给了 anchorKey 就停在那一条（离浮着的标题下沿留一点空）并且不贴底，否则直接到底；
   - 新条目进来时如果本来就在底部附近（距底 < 80px）就平滑跟到底（动画开着时）；内容变高（逐字、折叠展开）时，原本贴底的继续贴底；
   - 顶上多了条目（往上翻取回了更早的消息）：画面停在原来看的那一条，不跳；
   - onScrollState：滚动、内容变了之后报告「在不在最底下」「是不是快到顶了」（时间线据此标已读、取更早的消息）。
     「在最底下」是最后一条完整露在输入框（没有输入框时是窗口底边）上面；
   - 输入框变高（多行、加图片）、窗格变高变矮：原本贴底的继续贴底，最后一条不被盖住。
   定位用 DOM 的真实位置逐帧校正：条目高度是估的，量到真实高度以前，只靠估算位置会偏。 */
export interface LogItem {
  key: string;
  node: React.ReactNode;
  est?: number;
}
export interface ScrollState {
  /** 最后一条消息完整露在下面的浮层（输入框）上面 */
  atBottom: boolean;
  /** 离顶部不到 160px */
  nearTop: boolean;
}
/** 停在 anchorKey 那一条时，它的顶边离浮着的标题下沿多少 px */
const ANCHOR_OFFSET = 40;
/* 窗格量出来的浮层高度（--ht、--hb），滚动区从 .pane 继承 */
const cssPx = (c: HTMLElement, name: string) =>
  parseFloat(getComputedStyle(c).getPropertyValue(name)) || 0;
/** 上下的内边距：浮层的高度加滚动区自己的留白。虚拟列表的起点离滚动内容顶部 top 这么多 */
function pads(c: HTMLElement) {
  const cs = getComputedStyle(c);
  const top = parseFloat(cs.paddingTop) || 0,
    bottom = parseFloat(cs.paddingBottom) || 0;
  return { top, bottom, ht: cssPx(c, '--ht'), hb: cssPx(c, '--hb') };
}
/** 停在某一条时它的顶边离滚动区顶边多少：浮着的标题下沿再往下 ANCHOR_OFFSET */
const anchorAt = (c: HTMLElement) => () => pads(c).ht + ANCHOR_OFFSET;

/* 逐帧把 find() 说的偏差滚掉，最多 40 帧；连着 4 帧偏差小于 0.5px 就算稳了；用户自己滚动、点按时立刻放手。
   结束时（不管怎么结束）调 onDone */
function settle(c: HTMLElement, find: () => number | null, onDone?: () => void) {
  let frames = 0;
  let stable = 0;
  let dead = false;
  const events = ['wheel', 'pointerdown', 'touchstart', 'keydown'] as const;
  const stop = () => {
    if (dead) return;
    dead = true;
    for (const e of events) c.removeEventListener(e, stop);
    onDone?.();
  };
  for (const e of events) c.addEventListener(e, stop, { passive: true });
  const step = () => {
    if (dead) return;
    const d = find();
    if (d !== null && Math.abs(d) > 0.5) {
      c.scrollTop += d;
      stable = 0;
    } else stable++;
    if (++frames >= 40 || stable >= 4) return stop();
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  return stop;
}
const elOf = (c: HTMLElement, key: string | number) =>
  c.querySelector<HTMLElement>(`[data-key="${CSS.escape(String(key))}"]`);
/** 条目的顶边比「想要的位置」低多少（正数：要往下滚）。想要的位置每帧重读（浮层的高度可能刚量好）；
    全屏打开的形变期间窗口带着缩放，量到的距离按缩放换回排版的像素 */
const offBy = (c: HTMLElement, key: string | number, want: () => number) => () => {
  const el = elOf(c, key);
  if (!el) return null;
  const r = c.getBoundingClientRect();
  const k = c.offsetHeight ? r.height / c.offsetHeight : 1;
  return (el.getBoundingClientRect().top - r.top) / (k || 1) - want();
};

export function VirtualLog({
  items,
  resetKey,
  label,
  live,
  children,
  anchorKey,
  topNotice,
  onScrollState,
}: {
  items: LogItem[];
  resetKey: string | null;
  label: string;
  live?: boolean;
  children?: React.ReactNode;
  /** 切换到这个会话时停在这一条（如「以下是新消息」的分隔线）；不给就到底 */
  anchorKey?: string | null;
  /** 贴在顶上的小提示（「加载中」） */
  topNotice?: React.ReactNode;
  onScrollState?: (s: ScrollState) => void;
}) {
  const scRef = useRef<HTMLDivElement>(null);
  /* 上内边距（浮着的标题加留白）：虚拟列表从这里开始，告诉虚拟器（scrollMargin），它算可视范围、滚到某一条才是对的 */
  const [padTop, setPadTop] = useState(0);
  const virt = useVirtualizer({
    count: items.length,
    getScrollElement: () => scRef.current,
    estimateSize: (i) => items[i]?.est ?? 70,
    gap: 10,
    overscan: 6,
    getItemKey: (i) => items[i]?.key ?? i,
    initialRect: { width: 600, height: 500 },
    scrollMargin: padTop,
  });
  const nearBottom = () => {
    const c = scRef.current;
    return !c || c.scrollHeight - c.scrollTop - c.clientHeight < 80;
  };
  const stick = useRef(true);
  const lastKey = useRef<string | null | undefined>(undefined);
  const prevCount = useRef(0);
  const prevFirst = useRef<string | undefined>(undefined);
  const stopSettle = useRef<(() => void) | null>(null);
  /* 顶上的内容变了：趁 DOM 还是旧的，记下现在看着的第一条和它的位置 */
  const topSnap = useRef<{ key: string; top: number } | null>(null);
  const firstKey = items[0]?.key;
  if (
    lastKey.current === resetKey &&
    prevFirst.current !== undefined &&
    firstKey !== prevFirst.current &&
    !topSnap.current &&
    scRef.current
  ) {
    const c = scRef.current;
    const ct = c.getBoundingClientRect().top;
    for (const el of c.querySelectorAll<HTMLElement>('[data-key]')) {
      const r = el.getBoundingClientRect();
      if (r.bottom > ct + 1) {
        topSnap.current = { key: el.dataset.key!, top: r.top - ct };
        break;
      }
    }
  }
  /* 在最底下：离滚到底还差的距离不超过滚动区自己的底部留白（再多一点，最后一条的下沿就到输入框下面去了） */
  const report = () => {
    const c = scRef.current;
    if (!c || !onScrollState) return;
    const p = pads(c);
    onScrollState({
      atBottom: c.scrollHeight - c.scrollTop - c.clientHeight <= Math.max(0, p.bottom - p.hb) + 1,
      nearTop: c.scrollTop < 160,
    });
  };
  const reportRef = useRef(report);
  reportRef.current = report;
  /* 量上内边距；之后滚动区的内容框变了（浮层变高变矮、窗格大小变了）：重量，原本贴底的继续贴底。
     第一次只量：第一次定位（停在分隔线还是到底）由下面的 layout effect 做，这里先滚到底、报「在最底下」会误标已读 */
  useLayoutEffect(() => {
    const c = scRef.current;
    if (!c) return;
    const fit = (first: boolean) => {
      const t = pads(c).top;
      setPadTop((v) => (Math.abs(v - t) < 0.5 ? v : t));
      if (first) return;
      if (stick.current) c.scrollTop = c.scrollHeight;
      reportRef.current();
    };
    fit(true);
    const ro = new ResizeObserver(() => fit(false));
    ro.observe(c);
    return () => ro.disconnect();
  }, []);
  useLayoutEffect(() => {
    const c = scRef.current;
    if (!c) return;
    const switched = lastKey.current !== resetKey;
    lastKey.current = resetKey;
    const snap = topSnap.current;
    topSnap.current = null;
    const anchorIdx = anchorKey ? items.findIndex((it) => it.key === anchorKey) : -1;
    /* 虚拟器算的位置用的是上一次渲染的上内边距；刚量出新的、还没重新渲染时按差补上 */
    const dm = pads(c).top - virt.options.scrollMargin;
    if (switched) {
      stopSettle.current?.();
      stopSettle.current = null;
      if (anchorIdx >= 0) {
        stick.current = false;
        const m = virt.measurementsCache[anchorIdx];
        const want = anchorAt(c);
        if (m) c.scrollTop = Math.max(0, m.start + dm - want());
        // 定位期间不贴底（免得和校正打架）；定好以后按真实位置定：内容不满一屏时本来就在底部，
        // 没有滚动事件，不在这里设的话新消息永远不跟到底
        stopSettle.current = settle(c, offBy(c, items[anchorIdx].key, want), () => {
          stick.current = nearBottom();
        });
      } else {
        stick.current = true;
        if (items.length) virt.scrollToIndex(items.length - 1, { align: 'end' });
        requestAnimationFrame(() => {
          if (items.length) virt.scrollToIndex(items.length - 1, { align: 'end' });
          c.scrollTop = c.scrollHeight;
        });
      }
    } else {
      let restored = false;
      if (snap) {
        const idx = items.findIndex((it) => String(it.key) === snap.key);
        if (idx >= 0) {
          restored = true;
          stopSettle.current?.();
          const m = virt.measurementsCache[idx];
          if (m) c.scrollTop = Math.max(0, m.start + dm - snap.top);
          stopSettle.current = settle(
            c,
            offBy(c, snap.key, () => snap.top),
          );
        }
      }
      if (!restored && items.length !== prevCount.current && stick.current && items.length) {
        virt.scrollToIndex(items.length - 1, {
          align: 'end',
          behavior: motionOn() ? 'smooth' : 'auto',
        });
      }
    }
    prevCount.current = items.length;
    prevFirst.current = items[0]?.key;
  });
  useEffect(() => () => stopSettle.current?.(), []);
  const total = virt.getTotalSize();
  useEffect(() => {
    const c = scRef.current;
    if (c && stick.current) c.scrollTop = c.scrollHeight;
  }, [total]);
  /* 内容变了之后也报一次：没有滚动事件时（新消息把内容撑高、取回了更早的消息）时间线也要知道现在的位置 */
  useEffect(() => {
    report();
  });
  return (
    <div
      className="tline pane-sc"
      ref={scRef}
      role="log"
      aria-label={label}
      aria-live={live ? 'polite' : undefined}
      onScroll={() => {
        stick.current = nearBottom();
        report();
      }}
      style={{ display: 'block' }}
    >
      {topNotice && <div className="log-top">{topNotice}</div>}
      <div style={{ position: 'relative', height: total, width: '100%' }}>
        {virt.getVirtualItems().map((v) => {
          const it = items[v.index];
          if (!it) return null;
          return (
            <div
              key={v.key}
              data-index={v.index}
              data-key={String(v.key)}
              ref={virt.measureElement}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                transform: `translateY(${v.start - padTop}px)`,
                display: 'flex',
                flexDirection: 'column',
              }}
            >
              {it.node}
            </div>
          );
        })}
      </div>
      {children}
    </div>
  );
}
