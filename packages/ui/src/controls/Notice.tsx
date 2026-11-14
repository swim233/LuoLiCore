import type { HTMLAttributes } from 'react';
import { cx } from './cx';

export interface NoticeProps extends HTMLAttributes<HTMLSpanElement> {
  /** 色调：不写是平常的字；danger 是危险色的字 */
  tone?: 'danger';
  /** sm（默认，小提示）或 lg（整理模式那样的提示条） */
  size?: 'sm' | 'lg';
}

/* 提示条：玻璃的小药丸，一句话，后面可以放一个按钮（<Button size="xs">重试</Button>）。
   role 由用的地方传（要念出来的写 role="status"）。样式见 controls/notice.css */
export function Notice({ tone, size, className, ...rest }: NoticeProps) {
  return (
    <span className={cx('ll-notice', className)} data-tone={tone} data-size={size} {...rest} />
  );
}
