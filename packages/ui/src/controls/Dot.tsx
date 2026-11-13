import type { HTMLAttributes } from 'react';
import { cx } from './cx';

export type DotTone = 'accent' | 'quote' | 'star' | 'tool' | 'warning' | 'danger' | 'ok';

export interface DotProps extends HTMLAttributes<HTMLSpanElement> {
  /** 色调：不写是灰；star 和 danger 带光晕 */
  tone?: DotTone;
}

/* 状态点：7px 的圆点，只是装饰；意思要在旁边用文字写出来。样式见 controls/dot.css */
export function Dot({ tone, className, ...rest }: DotProps) {
  return <span className={cx('ll-dot', className)} data-tone={tone} aria-hidden="true" {...rest} />;
}
