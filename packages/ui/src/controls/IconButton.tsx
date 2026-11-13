import type { ButtonHTMLAttributes, Ref } from 'react';
import { cx } from './cx';

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** 图标按钮没有文字，一定要有名字（读屏和键盘用户靠它） */
  'aria-label': string;
  /** 按下保持的状态（写成 aria-pressed） */
  pressed?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

/* 图标按钮：30×30、透明底，里面放一个图标（@luoli/ui/icons）。样式见 controls/icon-button.css */
export function IconButton({ pressed, className, type = 'button', ...rest }: IconButtonProps) {
  return (
    <button type={type} className={cx('ll-icon-btn', className)} aria-pressed={pressed} {...rest} />
  );
}
