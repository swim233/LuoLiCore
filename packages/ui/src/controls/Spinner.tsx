import { useLayoutEffect, useRef } from 'react';
import type { HTMLAttributes } from 'react';
import { useMotionOn } from '../motion';
import { cx } from './cx';

export interface SpinnerProps extends HTMLAttributes<HTMLSpanElement> {
  /** 色调：不写是点睛色；accent、tool、dim */
  tone?: 'accent' | 'tool' | 'dim';
}

/* 转圈的符号：一个字符轮着换，所有转圈共用一个定时器。动画关掉时显示「⋯」。样式见 controls/spin.css */
const FRAMES = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
const spinning = new Set<HTMLElement>();
let frame = 0;
let timer: ReturnType<typeof setInterval> | 0 = 0;
function tick() {
  frame = (frame + 1) % FRAMES.length;
  spinning.forEach((el) => {
    if (!el.isConnected) spinning.delete(el);
    else el.textContent = FRAMES[frame];
  });
  if (!spinning.size && timer) {
    clearInterval(timer);
    timer = 0;
  }
}

export function Spinner({ tone, className, ...rest }: SpinnerProps) {
  const on = useMotionOn();
  const el = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const node = el.current;
    if (!node) return;
    if (!on) {
      node.textContent = '⋯';
      return;
    }
    node.textContent = FRAMES[frame];
    spinning.add(node);
    if (!timer) timer = setInterval(tick, 80);
    return () => {
      spinning.delete(node);
    };
  }, [on]);
  return (
    <span
      ref={el}
      className={cx('ll-spin', className)}
      data-tone={tone}
      aria-hidden="true"
      {...rest}
    />
  );
}
