import { useEffect, useRef, useState } from 'react';
import type { DetailsHTMLAttributes, MouseEvent, ReactNode, ToggleEvent } from 'react';
import { cx } from './cx';
import { syncOpen } from './fold-sync';

export interface FoldProps extends Omit<
  DetailsHTMLAttributes<HTMLDetailsElement>,
  'open' | 'children'
> {
  /** 头：点它展开收起（里面可以放文字、标签、库的 Chevron……） */
  head: ReactNode;
  /** 加在头（summary）上的类名：版面（外边距、内边距）、换掉头的颜色字号用 */
  headClassName?: string;
  /** 展开着没有（受控）；不写就是不受控，用 defaultOpen 定开头的样子 */
  open?: boolean;
  defaultOpen?: boolean;
  /** 点头要换成什么状态；受控时由用的地方改 open */
  onOpenChange?: (open: boolean) => void;
  children?: ReactNode;
}

/* 折叠：渲染成 <details class="ll-fold"><summary class="ll-fold-head">头</summary>内容</details>。
   open 完全由这里管（受控用 open，不受控自己记着）：点头时挡掉浏览器自己的开合，改 React 的状态，所以受控时用的地方不让开它就开不了。
   浏览器自己开的例外：页面内查找（Ctrl+F）命中收着的内容时浏览器会自己打开 <details>，DOM 开了、记着的还是关的。toggle 事件里对一下
   （fold-sync.ts）：不受控的跟着改，并调 onOpenChange；受控的调 onOpenChange，用的地方没跟着改就把 DOM 改回去。
   使用方自己传的 onToggle（开合真的发生以后浏览器发的事件，面板要用）照常先调，其余属性传给 <details>。样式见 controls/fold.css */
export function Fold({
  head,
  headClassName,
  open,
  defaultOpen = false,
  onOpenChange,
  onToggle,
  className,
  children,
  ...rest
}: FoldProps) {
  const [inner, setInner] = useState(defaultOpen);
  const controlled = open !== undefined;
  const now = controlled ? open : inner;
  /* 下一帧再看用的地方有没有跟着改，要看最新的 */
  const latest = useRef(now);
  useEffect(() => {
    latest.current = now;
  });
  const toggle = (e: MouseEvent) => {
    e.preventDefault();
    const next = !now;
    if (!controlled) setInner(next);
    onOpenChange?.(next);
  };
  const sync = (e: ToggleEvent<HTMLDetailsElement>) => {
    onToggle?.(e);
    const el = e.currentTarget;
    const plan = syncOpen({ dom: el.open, now, controlled });
    if (plan.adopt !== undefined) setInner(plan.adopt);
    if (plan.notify !== undefined) onOpenChange?.(plan.notify);
    if (plan.revertIfUnchanged)
      requestAnimationFrame(() => {
        if (el.open !== latest.current) el.open = latest.current;
      });
  };
  return (
    <details className={cx('ll-fold', className)} open={now} onToggle={sync} {...rest}>
      <summary className={cx('ll-fold-head', headClassName)} onClick={toggle}>
        {head}
      </summary>
      {children}
    </details>
  );
}
