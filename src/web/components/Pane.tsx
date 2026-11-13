import { useCallback } from 'react';
import { clamp } from '@luoli/ui/util';

/* 窗格：部件里的一块滚动区。内容铺满整块，上面、下面浮着的东西（标题、选会话那一行、输入框）盖在内容上面；
   内容滚进它们下面时由浅到深地糊：每一边一组 4 层 backdrop-filter 加一层渐变的底，强度按指数曲线涨（层数、半径、曲线见 app.css「窗格」一节）。
   - children 就是滚动区本身：恰好一个元素，带 class `pane-sc`。由各部件自己渲染（VirtualLog、会话列表、终端……），
     滚动事件、ref、role 都在它们自己手里；它的上下内边距由这里量出来的 --ht、--hb 加上它自己的 --sc-pt、--sc-pb。
   - 上面浮着的东西前面先空出窗口标题的高度（.pane-hsp，高 --pane-head：默认是窗口标题栏；「此刻」是标题栏加它自己的头部），
     窗口标题由外壳画在最上面，内容滚到它下面也一样糊。窄屏里上下叠着的几栏，下面那几栏不空：样式表里把它们的 .pane-hsp 设成 0。
   - 量的是浮层的高度（--ht、--hb）和窗格的高度（--ph；渐变带的长度 --rt = floor(clamp(32, 高 × 0.14, 110) × 0.75)，24～82 px，窗口高度的 10.5%；向下取整，最长正好 82，四舍五入会在最长时多出 1 px）。
     量在上面那个浮层的 ref 里做：提交时整棵 DOM 已经插好，它排在滚动区前面，ref 比滚动区里的 layout effect 先执行，
     VirtualLog 第一次定位时内边距已经是对的。之后用 ResizeObserver 跟着变（输入框变高、调整大小、全屏）。
     DOM 的顺序照阅读顺序（上浮层、内容、下浮层），Tab 键的顺序和以前一样；画的先后由 z-index 定。
   - 「只在那一边还有内容时出现」是 CSS 的 scroll-driven animation，每层自己的透明度跟着滚动区（timeline-scope 在 .pane 上）。
   - 层次：内容 < 模糊（z 2）< 窗口的暗边（z 3，外壳画的）< 浮层（z 4）< 窗口标题（z 5）。.pane 自己不建层叠上下文，
     这几层和外壳的暗边、标题在同一个层叠上下文（.w-card）里排。 */
const OV = (side: 't' | 'b') => (
  <div className={'pane-ov ' + side} aria-hidden="true">
    <i className="l1" />
    <i className="l2" />
    <i className="l3" />
    <i className="l4" />
    <i className="tn" />
  </div>
);

function fit(pane: HTMLElement) {
  const t = pane.querySelector<HTMLElement>(':scope > .pane-top');
  const b = pane.querySelector<HTMLElement>(':scope > .pane-bot');
  const ht = t ? t.offsetHeight : 0,
    hb = b ? b.offsetHeight : 0;
  const ph = pane.clientHeight;
  const rt = Math.floor(clamp(ph * 0.14, 32, 110) * 0.75);
  const set = (k: string, v: number) => {
    const s = v + 'px';
    if (pane.style.getPropertyValue(k) !== s) pane.style.setProperty(k, s);
  };
  set('--ht', ht);
  set('--hb', hb);
  set('--rt', rt);
  set('--ph', ph);
}

export function Pane({
  top,
  bottom,
  children,
  className,
}: {
  top?: React.ReactNode;
  bottom?: React.ReactNode;
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
    const b = pane.querySelector(':scope > .pane-bot');
    if (b) ro.observe(b);
    return () => ro.disconnect();
  }, []);
  return (
    <div className={'pane' + (className ? ' ' + className : '')}>
      <div className="pane-top" ref={measure}>
        <div className="pane-hsp" aria-hidden="true" />
        {top}
      </div>
      {children}
      <div className="pane-bot">{bottom}</div>
      {OV('t')}
      {OV('b')}
    </div>
  );
}
