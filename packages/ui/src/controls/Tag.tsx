import type { HTMLAttributes } from 'react';
import { cx } from './cx';

export interface TagProps extends HTMLAttributes<HTMLSpanElement> {
  /** outline（默认，一圈细线）或 soft（半透明底） */
  variant?: 'outline' | 'soft';
  /** 色调：默认、accent、star */
  tone?: 'accent' | 'star';
  /** sm（默认）或 md */
  size?: 'sm' | 'md';
}

/* 标签：一小条不能点的字。样式见 controls/tag.css */
export function Tag({ variant, tone, size, className, ...rest }: TagProps) {
  return (
    <span
      className={cx('ll-tag', className)}
      data-variant={variant}
      data-tone={tone}
      data-size={size}
      {...rest}
    />
  );
}
