import type { ButtonHTMLAttributes, Ref } from 'react';
import { cx } from './cx';

export type ButtonVariant = 'soft' | 'primary' | 'danger' | 'glass' | 'ghost';
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** 样子：soft（默认）、primary、danger、glass、ghost */
  variant?: ButtonVariant;
  /** 尺寸：xs、sm、md（默认）、lg */
  size?: ButtonSize;
  /** 按下保持的状态（写成 aria-pressed） */
  pressed?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

/* 按钮：渲染成 <button type="button" class="ll-btn">，样子和尺寸写成 data- 属性（不写就是 soft、md），其余属性原样传给 <button>。
   样式见 controls/button.css；只靠样式也能用：<button class="ll-btn" data-variant="primary">。 */
export function Button({
  variant,
  size,
  pressed,
  className,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx('ll-btn', className)}
      data-variant={variant}
      data-size={size}
      aria-pressed={pressed}
      {...rest}
    />
  );
}
