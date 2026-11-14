import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';
import { cx } from './cx';

/** 一行里放什么（两种根共用） */
export interface RowContent {
  /** 左边的图标位（会话的圆形图标） */
  lead?: ReactNode;
  /** 标题 */
  title: ReactNode;
  /** 标题下面的次要文字 */
  sub?: ReactNode;
  /** 右边的一列（竖着排、靠右）：小字用 <span className="ll-row-meta">，也可以放按钮、徽标 */
  side?: ReactNode;
  /** 能折行（顶对齐，任务的行）；不写是一行一行截断（会话的行） */
  wrap?: boolean;
  /** 选中（写成 aria-current）；不写就不带这个属性 */
  selected?: boolean;
  /** 主区、右列后面接的东西（要占满整行的加 className="ll-row-full"） */
  children?: ReactNode;
}
export type RowProps = RowContent & Omit<HTMLAttributes<HTMLDivElement>, 'title' | 'children'>;
export type RowButtonProps = RowContent &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title' | 'children'>;

function parts({ lead, title, sub, side, children }: RowContent) {
  return (
    <>
      {lead != null && <span className="ll-row-lead">{lead}</span>}
      <span className="ll-row-main">
        <span className="ll-row-title">{title}</span>
        {sub != null && <span className="ll-row-sub">{sub}</span>}
      </span>
      {side != null && <span className="ll-row-side">{side}</span>}
      {children}
    </>
  );
}

/* 列表行：根是 <div>（行里另有按钮，比如任务的行）。整行能点的用 RowButton。样式见 controls/row.css */
export function Row({
  lead,
  title,
  sub,
  side,
  wrap,
  selected,
  className,
  children,
  ...rest
}: RowProps) {
  return (
    <div
      className={cx('ll-row', className)}
      data-wrap={wrap ? '' : undefined}
      aria-current={selected}
      {...rest}
    >
      {parts({ lead, title, sub, side, children })}
    </div>
  );
}

/* 整行能点的列表行：根是 <button type="button">（会话的行） */
export function RowButton({
  lead,
  title,
  sub,
  side,
  wrap,
  selected,
  className,
  children,
  type = 'button',
  ...rest
}: RowButtonProps) {
  return (
    <button
      type={type}
      className={cx('ll-row', className)}
      data-wrap={wrap ? '' : undefined}
      aria-current={selected}
      {...rest}
    >
      {parts({ lead, title, sub, side, children })}
    </button>
  );
}
