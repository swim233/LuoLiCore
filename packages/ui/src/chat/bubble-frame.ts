import { motionOn } from '../motion';
import { SizeFollower } from './follow';

/* 气泡外框的补间（ChatBubble 里用；终端那样不带气泡外框的地方不用）。数学在 follow.ts，这里是 DOM 的部分。
   气泡是两层：外框 .ll-bubble（背景、边、圆角）和里面的 .ll-bubble-in（所有内容）。
   用的项目启动时调一次 installBubbleFrame({ busy })（和 installWheel({ busy }) 同一个做法）：busy 返回真表示「此刻有大动画在走（形变、让位……）」，
   那时不补间（已经在补的马上到位）；不调就是从不忙。
   - 平时（没有补间）内容在外框里正常排版，外框的大小就是内容的大小，和没有这一层时完全一样，窗口大小变了照常重新折行；
   - 内容自己变了（逐字、工具结果到了、状态换了：.ll-bubble-in 里的 DOM 有增删或文字变化）而且大小因此变了，就开始补间：
     外框改成写死的宽高（从变之前的大小起步，overflow: hidden 裁住内容），内容改成绝对定位、按「自然的大小」排版
     （width: max-content，最宽不超过 .ll-msg 的上限减去内边距：折行和不补间时一模一样）；
     每帧量内容的自然大小，让外框的宽高向它靠拢（SizeFollower）。外框的宽高就是整条时间线里这一行的高度，
     所以贴底时每一帧都跟到底（VirtualLog 在同一帧里量到行高变了就滚），上推自然是平滑的；
   - 补间停下来（差不到 0.5 px、自然大小也不再变）就去掉写死的宽高和绝对定位，回到平时的排版，之后窗口大小变化照常折行；
   - 直接到位、不补间的情形：行刚挂上（还没有「变之前的大小」）、没有内容变化只有大小变化（窗口或部件改了大小引起的重新折行）、
     形变和让位动画进行中、关掉动画、行宽在补间中途变了（改窗口大小）、量到有缩放（形变的复制层、动画里的窗口）；
   - 展开、收起折叠不在这里：它们是 CSS 的（controls/fold.css 的 ::details-content），展开的内容自己缓缓撑开，气泡跟着变，不需要补间；
   - 采样的时机：内容变化由 MutationObserver 在变化的那个微任务里处理（在布局之前、绘制之前，同一帧），其余时间由 rAF 推着走。 */
const FIRST_DT = 5;
/** 用的项目给的「此刻忙不忙」（installBubbleFrame 里设，拆掉时还原） */
let busy: () => boolean = () => false;

export interface InstallBubbleFrameOptions {
  busy?: () => boolean;
}

/** 告诉气泡外框的补间「什么时候不要补」，返回还原的函数 */
export function installBubbleFrame(options: InstallBubbleFrameOptions = {}): () => void {
  busy = options.busy ?? (() => false);
  return () => {
    busy = () => false;
  };
}
/** 补间中途这一行的宽变了：不超过这么多 px 的（滚动条出现、消失占了 8 px）当作内容的一部分，接着补间；更多的是改了窗口大小，直接到位 */
const ROW_SLACK = 20;
/** 两次计算之间不到这么久（毫秒）就留给下一帧（同一帧里变化和 rAF 各来一次，布局不用算两遍） */
const MIN_DT = 2;

interface Run {
  fol: SizeFollower;
  /** 内容的大小到外框的大小要加上的（内边距加边框） */
  padX: number;
  padY: number;
  /** 这一行的宽：补间中途变了就是滚动条出现了，或者改了窗口大小 */
  row: HTMLElement;
  rowW: number;
  msg: HTMLElement;
  t: number;
  raf: number;
  /** 上一次量到的自然大小，连着几次不变才算停稳 */
  nat: [number, number];
  stable: number;
}

const px = (s: string) => parseFloat(s) || 0;
/* 内容最宽能排多宽：.ll-msg 的宽度上限（百分比，量不出像素）。给 .ll-msg 一个很大的宽度，它被 max-width 夹住，量到的就是上限 */
function capOf(msg: HTMLElement) {
  const w0 = msg.style.width;
  msg.style.width = '100000px';
  const cap = msg.getBoundingClientRect().width;
  msg.style.width = w0;
  return cap;
}

export function attachBubbleFrame(f: HTMLElement, c: HTMLElement): () => void {
  /* 没有补间时外框的大小：RO 每次变了就记（RO 在布局之后、绘制之前，内容变化的微任务比它早，所以拿到的是变之前的大小） */
  let last: { w: number; h: number } | null = null;
  let run: Run | null = null;

  const ro = new ResizeObserver((es) => {
    const e = es[es.length - 1];
    const b = e.borderBoxSize?.[0];
    last = { w: b ? b.inlineSize : f.offsetWidth, h: b ? b.blockSize : f.offsetHeight };
  });
  ro.observe(f, { box: 'border-box' });

  /* 量到的是缩放过的（形变的复制层、动画里的窗口）：用 rect 和排版尺寸的比判断，补间不做 */
  const unscaled = (el: HTMLElement, r: DOMRect) =>
    el.offsetWidth < 1 || Math.abs(r.width - el.offsetWidth) <= 1;

  const end = () => {
    const s = run;
    if (!s) return;
    run = null;
    cancelAnimationFrame(s.raf);
    f.removeAttribute('data-tw');
    f.style.width = f.style.height = '';
    c.style.maxWidth = c.style.left = c.style.top = '';
  };

  const schedule = (s: Run) => {
    if (!s.raf)
      s.raf = requestAnimationFrame(() => {
        s.raf = 0;
        if (run === s) tick();
      });
  };

  const tick = () => {
    const s = run;
    if (!s) return;
    const now = performance.now();
    const dt = now - s.t;
    if (dt < MIN_DT) return schedule(s);
    s.t = now;
    if (!motionOn() || busy() || !f.isConnected) return end();
    const dRow = s.row.offsetWidth - s.rowW;
    if (Math.abs(dRow) > 0.5) {
      if (Math.abs(dRow) > ROW_SLACK) return end();
      s.rowW += dRow;
      c.style.maxWidth = Math.max(1, capOf(s.msg) - s.padX) + 'px';
    }
    const r = c.getBoundingClientRect();
    if (!unscaled(c, r)) return end();
    const nw = r.width + s.padX,
      nh = r.height + s.padY;
    const [w, h] = s.fol.step(nw, nh, dt);
    s.stable = Math.abs(nw - s.nat[0]) < 0.2 && Math.abs(nh - s.nat[1]) < 0.2 ? s.stable + 1 : 0;
    s.nat = [nw, nh];
    if (s.fol.settled(nw, nh) && s.stable >= 2) return end();
    f.style.width = w.toFixed(2) + 'px';
    f.style.height = h.toFixed(2) + 'px';
    schedule(s);
  };

  /* 内容变了，外框还是平时的排版：量一下变成多大了，大小真的变了才开始补间 */
  const start = () => {
    const from = last;
    if (!from || from.w < 1 || from.h < 1 || !motionOn() || busy()) return;
    const r = f.getBoundingClientRect();
    if (!unscaled(f, r)) return;
    if (Math.abs(r.width - from.w) < 0.5 && Math.abs(r.height - from.h) < 0.5) return;
    const cs = getComputedStyle(f);
    const padX =
      px(cs.paddingLeft) + px(cs.paddingRight) + px(cs.borderLeftWidth) + px(cs.borderRightWidth);
    const padY =
      px(cs.paddingTop) + px(cs.paddingBottom) + px(cs.borderTopWidth) + px(cs.borderBottomWidth);
    const msg = f.parentElement;
    if (!msg) return;
    const cap = capOf(msg);
    const row = f.closest<HTMLElement>('[data-index]') ?? msg;
    // 切到补间的排版：外框写死变之前的大小，内容脱离排版流
    f.setAttribute('data-tw', '');
    f.style.width = from.w + 'px';
    f.style.height = from.h + 'px';
    c.style.left = cs.paddingLeft;
    c.style.top = cs.paddingTop;
    c.style.maxWidth = Math.max(1, cap - padX) + 'px';
    run = {
      fol: new SizeFollower(from.w, from.h),
      padX,
      padY,
      row,
      rowW: row.offsetWidth,
      msg,
      t: performance.now() - FIRST_DT,
      raf: 0,
      nat: [r.width, r.height],
      stable: 0,
    };
    tick();
  };

  const mo = new MutationObserver(() => {
    if (run) tick();
    else start();
  });
  mo.observe(c, { childList: true, characterData: true, subtree: true });

  return () => {
    mo.disconnect();
    ro.disconnect();
    end();
  };
}
