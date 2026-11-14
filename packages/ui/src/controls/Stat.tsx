import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from './cx';

export interface StatProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  /** 方格（默认）、hero（头条：大数字加单位）、row（一行：标签在左、数字在右） */
  variant?: 'hero' | 'row';
  /** 标签（hero 不显示） */
  label?: ReactNode;
  /** 数字：任意内容（比如 <Roll />） */
  value: ReactNode;
  /** 单位（只有 hero 显示） */
  unit?: ReactNode;
  /** 下面的东西（比如能量槽 <Meter />） */
  children?: ReactNode;
}

/* 统计格：三种样子，见 controls/stat.css */
export function Stat({ variant, label, value, unit, className, children, ...rest }: StatProps) {
  return (
    <div className={cx('ll-stat', className)} data-variant={variant} {...rest}>
      {variant === 'row' ? (
        <div className="ll-stat-line">
          <span className="ll-stat-label">{label}</span>
          <span className="ll-stat-value">{value}</span>
        </div>
      ) : (
        <>
          {variant !== 'hero' && label != null && <span className="ll-stat-label">{label}</span>}
          <div className="ll-stat-value">{value}</div>
          {variant === 'hero' && unit != null && <span className="ll-stat-unit">{unit}</span>}
        </>
      )}
      {children}
    </div>
  );
}
