import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from './cx';

export interface FieldProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  /** 标签 */
  label: ReactNode;
  /** 说明：竖排时写在控件下面；横排不显示，只留在根元素的 title 里（悬停看） */
  hint?: string;
  /** 竖排（默认，标签在上）或 row（标签在左、控件在右、放不下就折行） */
  layout?: 'row';
  /** 给了，标签就是 <label htmlFor>（点标签聚焦那个控件）；没给是一个 <span> */
  htmlFor?: string;
}

/* 表单项：标签、控件（children）、说明。样式见 controls/field.css */
export function Field({ label, hint, layout, htmlFor, className, children, ...rest }: FieldProps) {
  return (
    <div className={cx('ll-field', className)} data-layout={layout} title={hint} {...rest}>
      {htmlFor ? (
        <label className="ll-field-label" htmlFor={htmlFor}>
          {label}
        </label>
      ) : (
        <span className="ll-field-label">{label}</span>
      )}
      {children}
      {hint && <p className="ll-field-hint">{hint}</p>}
    </div>
  );
}
