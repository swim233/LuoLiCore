import type { HTMLAttributes } from 'react';
import { cx } from './cx';

export interface SkeletonProps extends HTMLAttributes<HTMLSpanElement> {
  /** 不写是一条灰线；block 是一块占位的输入框（高 34，高可以用 style 改） */
  shape?: 'block';
}

/* 骨架条：还没做的东西的占位，静态的、只是装饰（aria-hidden）。样式见 controls/skeleton.css */
export function Skeleton({ shape, className, ...rest }: SkeletonProps) {
  return (
    <span className={cx('ll-skel', className)} data-shape={shape} aria-hidden="true" {...rest} />
  );
}
