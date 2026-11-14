import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { motionOn } from '../motion';
import { isSliding, maxScrollTop, SLIDE_PUSH_TAU, slideSendMs, sliderOf } from '../slide';
import { isWheeling, WHEEL_EVENT, wheelDir } from '../wheel';

/* 虚拟滚动的长列表（时间线）：@tanstack/react-virtual，动态高度，贴底。
   它自己就是窗格（Pane.tsx）的滚动区（.ll-pane-sc）：上下的内边距里有浮在上面的标题、输入框，位置都要算上它们：
   - 切换会话（resetKey 变）：给了 anchorKey 就停在那一条（离浮着的标题下沿留一点空）并且不贴底，否则直接到底（瞬间，不滑）；
   - 新条目进来时如果本来就在底部附近（距底 < 80px）就滑过去：贴底、内容往上推，约 0.18 秒（动画开着时；../slide.ts）；
     内容变高（逐字、气泡外框的补间、折叠展开）时，原本贴底的在同一帧里继续贴底（见下面「同一帧」）；
   - 顶上多了条目（往上翻取回了更早的消息）：画面停在原来看的那一条，不跳（瞬间）；
   - jumpKey 加一（对话里发出了消息）：不管现在滚到哪里，回到最底下，之后新来的内容照常贴底。离得远时滑过去
     （ease-out，最长 0.45 秒），滑的途中新内容长出来、目标跟着往下走；用户自己滚动、点按就放手；
   - onScrollState：滚动、内容变了之后报告「在不在最底下」「是不是快到顶了」（时间线据此标已读、取更早的消息）。
     「在最底下」是最后一条完整露在输入框（没有输入框时是窗口底边）上面；
   - 输入框变高（多行、加图片）、窗格变高变矮：原本贴底的继续贴底，最后一条不被盖住。
   定位用 DOM 的真实位置逐帧校正：条目高度是估的，量到真实高度以前，只靠估算位置会偏。

   同一帧：条目是绝对定位的，容器高度和各条的位置原本要等虚拟器的 ResizeObserver、再等 React 重渲染才更新，贴底的 scrollTop 在 useEffect 里改，
   气泡每多一行都有一帧最后一条的下沿伸到输入框下面、下一帧才被拉回来。现在自己也观察每一条的高度（watchRow）：
   量到变了就在同一个 ResizeObserver 回调里（布局之后、绘制之前）把新高度交给虚拟器、直接写容器的高度和各条的 transform、
   贴底时把 scrollTop 滚到底，这一帧画出来的就是对好的。React 之后渲染出的是同样的值。
   滑动（上推、发出后回到底部）正在进行时 scrollTop 由滑动写，这里只更新位置与高度，滑动的目标（每帧重取「最底下」）自己会跟上。

   对外：VirtualLog 的 props（items、resetKey、label、live、children、anchorKey、topNotice、onScrollState、jumpKey、className，
   和两个回调 onRowsMoved、onPositioned）、类型 LogItem、ScrollState。DOM：滚动区带 class ll-pane-sc、ll-vlog，加 className；
   里面是 div.ll-vlog-top（topNotice，样式在 vlog.css）和绝对定位的各条（data-index、data-key，高度变了会被逐条观察）。
   滚动区的 display 在行内样式里写成 block（盖过用的地方给 className 带来的 flex 之类）。
   用的地方的约定：滚动区要放在 Pane 里（浮层的高度、留白变量都从 .ll-pane 来）；气泡等条目里的东西高度变了，不用通知，行高会被观察到。
   - onScrollState：滚动时、每次渲染之后都会调（没有滚动事件时，内容变了、取回了更早的条目也要报位置）：在里面设 React 状态时，值没变就别设，不然会循环渲染；
   回调：
   - onRowsMoved：某几条的高度变了，已经同步到虚拟器、容器高度和各条的位置、滚动位置也写完了（ResizeObserver 回调里，布局之后绘制之前）。
     面板在这里让「预先糊好」的气泡星空当场对位；
   - onPositioned：每次渲染提交后的定位（layout effect）做完时调，条目有增减、重新排了也包括在内。 */
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
/** 发出消息后滑回底部：最多从离底部这么多屏的地方开始滑 */
const SEND_SLIDE_VIEWPORTS = 2;
/** 停在 anchorKey 那一条时，它的顶边离浮着的标题下沿多少 px */
const ANCHOR_OFFSET = 40;
/* 窗格量出来的浮层高度（--ll-pane-ht、--ll-pane-hb），滚动区从 .ll-pane 继承 */
const cssPx = (c: HTMLElement, name: string) =>
  parseFloat(getComputedStyle(c).getPropertyValue(name)) || 0;
/** 上下的内边距：浮层的高度加滚动区自己的留白。虚拟列表的起点离滚动内容顶部 top 这么多 */
function pads(c: HTMLElement) {
  const cs = getComputedStyle(c);
  const top = parseFloat(cs.paddingTop) || 0,
    bottom = parseFloat(cs.paddingBottom) || 0;
  return { top, bottom, ht: cssPx(c, '--ll-pane-ht'), hb: cssPx(c, '--ll-pane-hb') };
}
/** 停在某一条时它的顶边离滚动区顶边多少：浮着的标题下沿再往下 ANCHOR_OFFSET */
const anchorAt = (c: HTMLElement) => () => pads(c).ht + ANCHOR_OFFSET;

/* 逐帧把 find() 说的偏差滚掉（瞬间的定位：停在某一条、取回更早的消息后保持位置，不滑），最多 40 帧；连着 4 帧偏差小于 0.5px 就算稳了；
   用户自己滚动、点按时立刻放手。结束时（不管怎么结束）调 onDone */
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
    // 用户的鼠标滚轮缓动在走：位置是用户在挪，不再往回校正（滚轮的事件本身在上面已经让它停过一次，这里是事件之后还没走完的那段）
    if (isWheeling(c)) return stop();
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
  jumpKey,
  className,
  onRowsMoved,
  onPositioned,
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
  /** 每加一次，时间线滚到最底下并重新贴底（对话里发出消息、重试） */
  jumpKey?: number;
  /** 加在滚动区上的类名（用的地方自己的版面：内边距变量、左右留白……） */
  className?: string;
  /** 逐条行高同步完以后调（见上面「对外」） */
  onRowsMoved?: () => void;
  /** 每次定位的 layout effect 末尾调 */
  onPositioned?: () => void;
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
  /* 把虚拟器的位置对到滚动区此刻真实的 scrollTop，并马上重画。
     虚拟器的位置只靠滚动事件更新，事件要到下一帧才来：挂上这一刻（从胶囊展开、打开全屏时形变用的冻结副本就是这一刻的 DOM），
     它画的还是 scrollTop 为 0 的那一屏，滚动区却已经在底部或分隔线那里，副本里正文是空白的，要等到副本换成真窗口才出现。
     layout effect 里定好位置以后调它，重画在同一次提交里同步完成，副本拿到的就是最终要停的那一屏。
     不用派发滚动事件：虚拟器对滚动事件的通知会 flushSync，在提交阶段调用会报警告 */
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  /* 定位之后再校正几次：重画出来的那些条目挂上时量到了真实高度（之前只是估的），位置比估的差几 px。
     校正在随后的几次提交里做（skip：定位的那次提交自己不做；left：还要做几次，每次按虚拟器此刻的测量重算，几次就收敛），
     副本才和随后真正停下的位置一致，换成真窗口时不会挪。key 为 null：贴底；否则对齐到那一条 */
  const fixup = useRef<{ key: string | null; skip: boolean; left: number } | null>(null);
  const syncOffset = () => {
    const c = scRef.current;
    if (!c) return;
    virt.scrollOffset = c.scrollTop;
    redraw();
  };
  const stick = useRef(true);
  const sizer = useRef<HTMLDivElement>(null);
  /** 发出消息后的滑动正在进行（新条目进来时不换成上推的走法） */
  const sendSlide = useRef(false);
  const padTopRef = useRef(padTop);
  padTopRef.current = padTop;
  /* 条目量到新高度时虚拟器默认会补偿 scrollTop（让看着的那一屏不动）：第一次量到、顶边在可视范围上面的，补偿估算和真实的差；
     之后再量到的，只补偿整条都在上面的。这里原样保留，只加一条：贴着底部时不补偿。贴底的由 syncRows 在同一帧里滚到底；
     补偿的写入会被浏览器夹住（容器的高度还没跟上），虚拟器把它记下来，之后每次内容变高都重发一遍旧的目标位置，和贴底、滑动拉扯 */
  virt.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, inst) => {
    if (stick.current) return false;
    const off = inst.scrollOffset ?? 0;
    return inst.itemSizeCache.has(item.key)
      ? item.start + item.size <= off && inst.scrollDirection !== 'backward'
      : item.start < off;
  };
  /* 同一帧：某几条的高度变了（回调在布局之后、绘制之前）——交给虚拟器，容器的高度、各条的位置、贴底都当场对上 */
  const syncRows = (entries: ResizeObserverEntry[]) => {
    const c = scRef.current,
      box = sizer.current;
    if (!c || !box) return;
    for (const e of entries) {
      const el = e.target as HTMLElement;
      const i = Number(el.dataset.index);
      if (!el.isConnected || !Number.isInteger(i)) continue;
      virt.resizeItem(i, e.borderBoxSize?.[0]?.blockSize ?? el.offsetHeight);
    }
    box.style.height = `${virt.getTotalSize()}px`;
    const pt = padTopRef.current;
    for (const el of box.children as HTMLCollectionOf<HTMLElement>) {
      const m = virt.measurementsCache[Number(el.dataset.index)];
      if (m) el.style.transform = `translateY(${m.start - pt}px)`;
    }
    if (stick.current) {
      /* 滑动的目标（最底下）这一帧又往下走了：当场按新目标算位置写进去（slide.sync），否则最后一条的下沿要晚一帧才跟上 */
      const sl = sliderOf(c);
      if (sl.active) sl.sync();
      else c.scrollTop = c.scrollHeight;
    }
    // 各条的位置挪了、滚动位置也写完了（这里在布局之后、绘制之前）：交给用的地方（面板让气泡里垫的星空当场重新对齐，接下来几帧也每帧对一次）
    onRowsMoved?.();
  };
  const syncRef = useRef(syncRows);
  syncRef.current = syncRows;
  const rowRo = useRef<ResizeObserver | null>(null);
  const watchRow = useCallback(
    (el: HTMLDivElement) => {
      virt.measureElement(el);
      rowRo.current ??= new ResizeObserver((es) => syncRef.current(es));
      rowRo.current.observe(el);
      return () => {
        rowRo.current?.unobserve(el);
        virt.measureElement(null);
      };
    },
    [virt],
  );
  useEffect(
    () => () => {
      rowRo.current?.disconnect();
      rowRo.current = null;
    },
    [],
  );
  /* 滚轮缓动开始往上滚（install-wheel.ts 同步发的事件，比第一帧的滚动事件早）：马上不再贴底，
     第一帧之前来的新内容不会把人拉回底部 */
  useEffect(() => {
    const c = scRef.current;
    if (!c) return;
    const on = (e: Event) => {
      if ((e as CustomEvent<{ dy: number }>).detail.dy < 0) stick.current = false;
    };
    c.addEventListener(WHEEL_EVENT, on);
    return () => c.removeEventListener(WHEEL_EVENT, on);
  }, []);
  const lastKey = useRef<string | null | undefined>(undefined);
  const prevCount = useRef(0);
  /** 上一次渲染时最后一条的 key：条数没变、最后一条换了（「正在回复」换成回复的气泡）也算新来了一条 */
  const prevLastKey = useRef<string | undefined>(undefined);
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
      if (stick.current && !isSliding(c)) c.scrollTop = c.scrollHeight;
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
      sliderOf(c).cancel();
      if (anchorIdx >= 0) {
        stick.current = false;
        const m = virt.measurementsCache[anchorIdx];
        const want = anchorAt(c);
        if (m) c.scrollTop = Math.max(0, m.start + dm - want());
        syncOffset();
        fixup.current = { key: items[anchorIdx].key, skip: true, left: 3 };
        // 定位期间不贴底（免得和校正打架）；定好以后按真实位置定：内容不满一屏时本来就在底部，
        // 没有滚动事件，不在这里设的话新消息永远不跟到底
        stopSettle.current = settle(c, offBy(c, items[anchorIdx].key, want), () => {
          stick.current = nearBottom();
        });
      } else {
        stick.current = true;
        /* 这一帧就滚到底，并让虚拟器画这一屏。不用虚拟器自己的 scrollToIndex：它留下的「滚到某一条」的命令会在随后的每一帧里
           接着往它算出的位置写 scrollTop（不含底部浮层那一段内边距，永远到不了），和这里的贴底、上面的滑动互相拉扯 */
        c.scrollTop = c.scrollHeight;
        syncOffset();
        fixup.current = { key: null, skip: true, left: 3 };
        requestAnimationFrame(() => {
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
      const lastKeyNow = items[items.length - 1]?.key;
      if (
        !restored &&
        (items.length !== prevCount.current || lastKeyNow !== prevLastKey.current) &&
        stick.current &&
        items.length
      ) {
        /* 新条目：贴着底部就往上推。滑的目标每帧重取（最底下会随内容变高往下走）；已经在滑（发出消息后的滑动）就让它继续，不换走法 */
        if (!motionOn()) c.scrollTop = c.scrollHeight;
        else if (!sendSlide.current)
          sliderOf(c).to(() => maxScrollTop(c), {
            kind: 'exp',
            tau: SLIDE_PUSH_TAU,
            passthrough: true,
          });
      }
    }
    prevCount.current = items.length;
    prevFirst.current = items[0]?.key;
    prevLastKey.current = items[items.length - 1]?.key;
    // 条目有增减、重新排了：交给用的地方（面板让气泡里垫的星空重新对齐）
    onPositioned?.();
  });
  useLayoutEffect(() => {
    const f = fixup.current;
    const c = scRef.current;
    if (!f || !c) return;
    if (f.skip) {
      f.skip = false;
      return;
    }
    if (--f.left <= 0) fixup.current = null;
    if (f.key === null) {
      if (stick.current) c.scrollTop = c.scrollHeight;
    } else {
      /* 用虚拟器此刻的测量算（不量 DOM 的位置：从胶囊展开时挂上的窗口还带着缩放，量出来的距离不准） */
      const idx = items.findIndex((it) => it.key === f.key);
      const m = idx >= 0 ? virt.measurementsCache[idx] : undefined;
      if (m)
        c.scrollTop = Math.max(
          0,
          m.start + pads(c).top - virt.options.scrollMargin - anchorAt(c)(),
        );
    }
  });
  useEffect(() => () => stopSettle.current?.(), []);
  /* 发出消息：设成贴底，回到最底下。离得远（动画开着时）滑过去，不是跳：ease-out，时长随距离，最长 0.45 秒；
     本来就在底部（或关了动画）直接到。之后新消息、回复进来时高度是慢慢长出来的：滑动的目标每帧重取「最底下」，
     滑完以后靠同一帧贴底（syncRows）。滑的途中不用 settle 那样的逐帧校正，滚动事件也不会把「贴底」清掉（isSliding）；
     用户自己滚动、点按（../slide.ts 里的监听）就放手 */
  const jumpSeen = useRef(jumpKey);
  useLayoutEffect(() => {
    if (jumpKey === jumpSeen.current) return;
    jumpSeen.current = jumpKey;
    const c = scRef.current;
    if (!c) return;
    stopSettle.current?.();
    stopSettle.current = null;
    stick.current = true;
    const sl = sliderOf(c);
    let dist = maxScrollTop(c) - c.scrollTop;
    if (!motionOn() || dist < 2) {
      sl.cancel();
      sendSlide.current = false;
      c.scrollTop = c.scrollHeight;
      return;
    }
    /* 离得更远的（几千像素）先直接到离底部两屏的地方再滑：滑过的每一屏都要挂上、画出来，一路滑过去只是白费力气，帧也会卡 */
    if (dist > c.clientHeight * SEND_SLIDE_VIEWPORTS) {
      c.scrollTop = maxScrollTop(c) - c.clientHeight * SEND_SLIDE_VIEWPORTS;
      dist = maxScrollTop(c) - c.scrollTop;
    }
    sendSlide.current = true;
    sl.to(
      () => maxScrollTop(c),
      { kind: 'ease', ms: slideSendMs(dist) },
      (r) => {
        if (r !== 'replace') sendSlide.current = false;
        if (r === 'done') stick.current = true;
      },
    );
  }, [jumpKey]);
  const total = virt.getTotalSize();
  useEffect(() => {
    const c = scRef.current;
    if (c && stick.current && !isSliding(c)) c.scrollTop = c.scrollHeight;
  }, [total]);
  /* 内容变了之后也报一次：没有滚动事件时（新消息把内容撑高、取回了更早的消息）时间线也要知道现在的位置 */
  useEffect(() => {
    report();
  });
  return (
    <div
      className={'ll-pane-sc ll-vlog' + (className ? ' ' + className : '')}
      ref={scRef}
      role="log"
      aria-label={label}
      aria-live={live ? 'polite' : undefined}
      onScroll={() => {
        const c = scRef.current!;
        // 程序自己在滑的时候离底部还远，不算用户往上翻了；用户的滚轮正往上滚时，哪怕离底部还不到 80px 也已经不贴底了
        if (!isSliding(c)) stick.current = wheelDir(c) < 0 ? false : nearBottom();
        report();
      }}
      style={{ display: 'block' }}
    >
      {topNotice && <div className="ll-vlog-top">{topNotice}</div>}
      <div ref={sizer} style={{ position: 'relative', height: total, width: '100%' }}>
        {virt.getVirtualItems().map((v) => {
          const it = items[v.index];
          if (!it) return null;
          return (
            <div
              key={v.key}
              data-index={v.index}
              data-key={String(v.key)}
              ref={watchRow}
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
