import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { cx } from './cx';

export interface SwitchProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'onChange' | 'role' | 'children'
> {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** 轨道旁边的文字；没有文字时要自己给 aria-label */
  label?: ReactNode;
  /** 外面套一层按钮的底（顶栏的动画开关那样）；size 选 md（默认）或 lg */
  boxed?: boolean;
  size?: 'md' | 'lg';
  ref?: Ref<HTMLButtonElement>;
}

/* 开关：role="switch" 的按钮，里面是轨道和可选的文字。样式见 controls/switch.css */
export function Switch({
  checked,
  onChange,
  label,
  boxed,
  size,
  className,
  type = 'button',
  onClick,
  ...rest
}: SwitchProps) {
  return (
    <button
      type={type}
      role="switch"
      aria-checked={checked}
      className={cx('ll-switch', className)}
      data-boxed={boxed ? '' : undefined}
      data-size={boxed ? size : undefined}
      onClick={(e) => {
        onClick?.(e);
        if (!e.defaultPrevented) onChange(!checked);
      }}
      {...rest}
    >
      <span className="ll-switch-track" aria-hidden="true" />
      {label != null && <span className="ll-switch-label">{label}</span>}
    </button>
  );
}
