import type { HTMLAttributes } from 'react';
import { cx } from './cx';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  /** 色调：star（默认）、accent、neutral */
  tone?: 'star' | 'accent' | 'neutral';
}

/* 数字徽标（未读数那样）：没有内容时留着位置、不显示。样式见 controls/tag.css */
export function Badge({ tone, className, ...rest }: BadgeProps) {
  return <span className={cx('ll-badge', className)} data-tone={tone} {...rest} />;
}
