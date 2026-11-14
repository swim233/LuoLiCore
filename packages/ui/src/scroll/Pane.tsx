import { useCallback } from 'react';
import { clamp } from '../util';

/* 窗格：部件里的一块滚动区。内容铺满整块，上面、下面浮着的东西（标题、选会话那一行、输入框）盖在内容上面；
   内容滚进它们下面时由浅到深地糊：每一边一组 4 层 backdrop-filter 加一层渐变的底，强度按指数曲线涨（层数、半径、曲线见 pane.css）。
   - children 就是滚动区本身：恰好一个元素，带 class `ll-pane-sc`（VirtualLog 自己就带着）。由用的地方渲染，
     滚动事件、ref、role 都在它们自己手里；它的上下内边距由这里量出来的 --ll-pane-ht、--ll-pane-hb 加上它自己的 --ll-pane-sc-pt、--ll-pane-sc-pb。
   - 上面浮着的东西前面先空出窗口标题的高度（.ll-pane-hsp，高 --ll-pane-head：用的地方在外层定，不写就是 0）；
     窗口标题由外壳画在最上面，内容滚到它下面也一样糊。上下叠着的几栏，下面那几栏不空：样式里把它们的 .ll-pane-hsp 设成 0。
   - 量的是浮层的高度（--ll-pane-ht、--ll-pane-hb）和窗格的高度（--ll-pane-ph；渐变带的长度 --ll-pane-rt = floor(clamp(32, 高 × 0.14, 110) × 0.75)，
     24～82 px，窗口高度的 10.5%；向下取整，最长正好 82，四舍五入会在最长时多出 1 px），写在 .ll-pane 的行内样式上。
     量在上面那个浮层的 ref 里做：提交时整棵 DOM 已经插好，它排在滚动区前面，ref 比滚动区里的 layout effect 先执行，
     VirtualLog 第一次定位时内边距已经是对的。之后用 ResizeObserver 跟着变（输入框变高、调整大小、全屏）。
     DOM 的顺序照阅读顺序（上浮层、内容、下浮层），Tab 键的顺序不变；画的先后由 z-index 定。
   - 「只在那一边还有内容时出现」是 CSS 的 scroll-driven animation，每层自己的透明度跟着滚动区（timeline-scope 在 .ll-pane 上）。
   - 层次：内容 < 模糊（z 2）< 浮层（z 4）。.ll-pane 自己不建层叠上下文，这几层和用的地方画的东西（面板里是窗口的暗边 z 3、标题 z 5）
     在同一个层叠上下文里排。
   对外的约定（类名、变量、怎么关掉模糊）写在 pane.css 开头。加载时不碰 DOM。 */
const OV = (side: 't' | 'b') => (
  <div className="ll-pane-ov" data-side={side} aria-hidden="true">
    <i className="ll-pane-l1" />
    <i className="ll-pane-l2" />
    <i className="ll-pane-l3" />
    <i className="ll-pane-l4" />
    <i className="ll-pane-tn" />
  </div>
);

function fit(pane: HTMLElement) {
  const t = pane.querySelector<HTMLElement>(':scope > .ll-pane-top');
  const b = pane.querySelector<HTMLElement>(':scope > .ll-pane-bot');
  const ht = t ? t.offsetHeight : 0,
    hb = b ? b.offsetHeight : 0;
  const ph = pane.clientHeight;
  const rt = Math.floor(clamp(ph * 0.14, 32, 110) * 0.75);
  const set = (k: string, v: number) => {
    const s = v + 'px';
    if (pane.style.getPropertyValue(k) !== s) pane.style.setProperty(k, s);
  };
  set('--ll-pane-ht', ht);
  set('--ll-pane-hb', hb);
  set('--ll-pane-rt', rt);
  set('--ll-pane-ph', ph);
}

export function Pane({
  top,
  bottom,
  children,
  className,
}: {
  /** 浮在内容上面的东西（标题、选会话那一行）；前面先空出 --ll-pane-head 那么高 */
  top?: React.ReactNode;
  /** 浮在内容下面的东西（输入框） */
  bottom?: React.ReactNode;
  /** 滚动区本身：恰好一个元素，带 class ll-pane-sc */
  children: React.ReactNode;
  className?: string;
}) {
  /* 上面那个浮层的 ref：整个窗格已经在页面上了，量一次，再盯着三样（窗格、两个浮层）的大小 */
  const measure = useCallback((t: HTMLDivElement | null) => {
    const pane = t?.parentElement;
    if (!t || !pane) return;
    fit(pane);
    const ro = new ResizeObserver(() => fit(pane));
    ro.observe(pane);
    ro.observe(t);
    const b = pane.querySelector(':scope > .ll-pane-bot');
    if (b) ro.observe(b);
    return () => ro.disconnect();
  }, []);
  return (
    <div className={'ll-pane' + (className ? ' ' + className : '')}>
      <div className="ll-pane-top" ref={measure}>
        <div className="ll-pane-hsp" aria-hidden="true" />
        {top}
      </div>
      {children}
      <div className="ll-pane-bot">{bottom}</div>
      {OV('t')}
      {OV('b')}
    </div>
  );
}
