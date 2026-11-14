import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from './cx';

export interface EmptyProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  /** 标题（可没有） */
  title?: ReactNode;
  /** 没有外边距和内边距 */
  flat?: boolean;
  /** 说明后面的按钮（比如 <Button size="sm">重试</Button>），直接放在里面 */
  action?: ReactNode;
}

/* 空状态：居中的一块，标题、说明、可带一个按钮。children 是说明。样式见 controls/empty.css */
export function Empty({ title, flat, action, className, children, ...rest }: EmptyProps) {
  return (
    <div className={cx('ll-empty', className)} data-flat={flat ? '' : undefined} {...rest}>
      {title != null && <b className="ll-empty-title">{title}</b>}
      {children}
      {action}
    </div>
  );
}
