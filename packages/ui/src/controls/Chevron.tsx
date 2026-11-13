import type { HTMLAttributes } from 'react';
import { cx } from './cx';

export interface ChevronProps extends HTMLAttributes<HTMLSpanElement> {
  /** 方向；不写时朝右，父元素 aria-expanded='true' 时转向下 */
  dir?: 'right' | 'down' | 'left' | 'up';
}

/* 小箭头：CSS 画的，颜色跟着文字。样式见 controls/chev.css */
export function Chevron({ dir, className, ...rest }: ChevronProps) {
  return <span className={cx('ll-chev', className)} data-dir={dir} aria-hidden="true" {...rest} />;
}
