import { useEffect, useRef } from 'react';
import type { HTMLAttributes } from 'react';
import { motionOn } from '../motion';
import { nf } from '../util';
import { cx } from './cx';
import { rollTo } from './roll-anim';

export interface RollProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  /** 要显示的数 */
  value: number;
  /** 把数写成文字（默认是千分位） */
  fmt?: (n: number) => string;
}

/* 滚动数字：值变了就从旧值滚到新值（0.9 秒，曲线 EASE_OUT，用 requestAnimationFrame 走，不用 Motion），
   滚动期间根上有 data-rolling（颜色变白），结束半秒后还原；中途值又变了从当前数接着滚；
   动画关掉时直接到新值；值赶在第一帧之前又变回显示着的数时不滚、只去掉 data-rolling（rollTo）；卸载时停掉。首次挂上直接显示，不滚。
   里面的文字由这里直接改（node.textContent），React 不管。样式见 controls/roll.css */
export function Roll({ value, fmt = nf, className, ...rest }: RollProps) {
  const el = useRef<HTMLSpanElement>(null);
  const cur = useRef(value);
  const first = useRef(true);
  useEffect(() => {
    const node = el.current!;
    if (first.current) {
      first.current = false;
      node.textContent = fmt(value);
      cur.current = value;
      return;
    }
    return rollTo(node, cur.current, value, fmt, motionOn(), (n) => {
      cur.current = n;
    });
  }, [value]);
  return (
    <span className={cx('ll-roll', className)} ref={el} {...rest}>
      {fmt(0)}
    </span>
  );
}
