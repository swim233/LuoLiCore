import { useEffect, useLayoutEffect, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { motionOn } from '../lib/prefs';

/* 虚拟滚动的时间线：@tanstack/react-virtual，动态高度，贴底。
   - 切换会话（resetKey 变）：给了 anchorKey 就停在那一条（顶上留一点空）并且不贴底，否则直接到底；
   - 新条目进来时如果本来就在底部附近（距底 < 80px）就平滑跟到底（动画开着时）；内容变高（逐字、折叠展开）时，原本贴底的继续贴底；
   - 顶上多了条目（往上翻取回了更早的消息）：画面停在原来看的那一条，不跳；
   - onScrollState：滚动、内容变了之后报告「在不在最底下」「是不是快到顶了」（时间线据此标已读、取更早的消息）。
   定位用 DOM 的真实位置逐帧校正：条目高度是估的，量到真实高度以前，只靠估算位置会偏。 */
export interface LogItem {
  key: string;
  node: React.ReactNode;
  est?: number;
}
export interface ScrollState {
  /** 最后一条消息在可视区里（距底不到一个底部留白） */
  atBottom: boolean;
  /** 离顶部不到 160px */
  nearTop: boolean;
}
/** 停在 anchorKey 那一条时，它的顶边离可视区顶边多少 px */
const ANCHOR_OFFSET = 40;
/** .tline 的上内边距：虚拟列表的起点离滚动内容顶部这么多 */
const PAD_TOP = 16;
const BOTTOM_SLACK = 24;

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
/** 条目的顶边比「想要的位置」低多少（正数：要往下滚） */
const offBy = (c: HTMLElement, key: string | number, want: number) => () => {
  const el = elOf(c, key);
  return el ? el.getBoundingClientRect().top - c.getBoundingClientRect().top - want : null;
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
  const virt = useVirtualizer({
    count: items.length,
    getScrollElement: () => scRef.current,
    estimateSize: (i) => items[i]?.est ?? 70,
    gap: 10,
    overscan: 6,
    getItemKey: (i) => items[i]?.key ?? i,
    initialRect: { width: 600, height: 500 },
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
  const report = () => {
    const c = scRef.current;
    if (!c || !onScrollState) return;
    onScrollState({
      atBottom: c.scrollHeight - c.scrollTop - c.clientHeight <= BOTTOM_SLACK,
      nearTop: c.scrollTop < 160,
    });
  };
  useLayoutEffect(() => {
    const c = scRef.current;
    if (!c) return;
    const switched = lastKey.current !== resetKey;
    lastKey.current = resetKey;
    const snap = topSnap.current;
    topSnap.current = null;
    const anchorIdx = anchorKey ? items.findIndex((it) => it.key === anchorKey) : -1;
    if (switched) {
      stopSettle.current?.();
      stopSettle.current = null;
      if (anchorIdx >= 0) {
        stick.current = false;
        const m = virt.measurementsCache[anchorIdx];
        if (m) c.scrollTop = Math.max(0, m.start + PAD_TOP - ANCHOR_OFFSET);
        // 定位期间不贴底（免得和校正打架）；定好以后按真实位置定：内容不满一屏时本来就在底部，
        // 没有滚动事件，不在这里设的话新消息永远不跟到底
        stopSettle.current = settle(c, offBy(c, items[anchorIdx].key, ANCHOR_OFFSET), () => {
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
          if (m) c.scrollTop = Math.max(0, m.start + PAD_TOP - snap.top);
          stopSettle.current = settle(c, offBy(c, snap.key, snap.top));
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
      className="tline"
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
                transform: `translateY(${v.start}px)`,
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
