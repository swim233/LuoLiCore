import type { HTMLAttributes, ReactNode, Ref } from 'react';
import { cx } from './cx';

export interface SegProps<T extends string> extends Omit<
  HTMLAttributes<HTMLDivElement>,
  'onChange' | 'role'
> {
  /** 当前项的值 */
  value: T;
  /** [值, 按钮文字, 悬停说明] */
  items: readonly (readonly [T, ReactNode, string?])[];
  onPick: (value: T) => void;
  /** 给读屏用的名字（直接写文字），或者用 labelledBy 指到页面上的一个标题 */
  label?: string;
  labelledBy?: string;
  ref?: Ref<HTMLDivElement>;
}

/* 分段选择：一排互斥的按钮（aria-pressed 表示当前项）。样式见 controls/seg.css */
export function Seg<T extends string>({
  value,
  items,
  onPick,
  label,
  labelledBy,
  className,
  ...rest
}: SegProps<T>) {
  return (
    <div
      role="group"
      aria-label={label}
      aria-labelledby={labelledBy}
      className={cx('ll-seg', className)}
      {...rest}
    >
      {items.map(([v, text, title]) => (
        <button
          key={v}
          type="button"
          data-v={v}
          title={title}
          aria-pressed={value === v}
          onClick={() => onPick(v)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}
