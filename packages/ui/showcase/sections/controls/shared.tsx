import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import { Stage } from '../../components/Stage';
import type { StageKind } from '../../components/Stage';

/* 「基础控件」一节各块共用的零件 */

/** 摆在舞台上的东西垫哪种底：整节的「舞台的底」选的 */
export const StageCtx = createContext<StageKind>('sky');
export const useStageKind = () => useContext(StageCtx);

/** 每个控件一块：标题、一句说明、里面的内容 */
export function Group({
  id,
  title,
  sub,
  children,
}: {
  id: string;
  title: string;
  sub: string;
  children: ReactNode;
}) {
  return (
    <section className="sc-group" id={id} data-group={id}>
      <h3 className="sc-h3">
        {title} <span className="sc-count">{sub}</span>
      </h3>
      {children}
    </section>
  );
}

/** 一张表：每行一种（样子……），每列一种（尺寸、状态……），每格画一个控件。舞台的底跟着整节的开关走 */
export function Matrix({
  name,
  rows,
  cols,
  render,
}: {
  name: string;
  rows: readonly (readonly [string, string])[];
  cols: readonly (readonly [string, string])[];
  render: (row: string, col: string) => ReactNode;
}) {
  const kind = useStageKind();
  return (
    <Stage kind={kind}>
      <div className="sc-ctl-grid" style={{ '--cols': cols.length }} data-matrix={name}>
        <span />
        {cols.map(([id, label]) => (
          <span key={id} className="sc-ctl-col">
            {label}
          </span>
        ))}
        {rows.map(([id, label]) => (
          <div className="sc-ctl-row" key={id} data-row={id}>
            <span className="sc-ctl-rowlabel">{label}</span>
            {cols.map(([cid]) => (
              <span className="sc-ctl-cell" key={cid} data-col={cid}>
                {render(id, cid)}
              </span>
            ))}
          </div>
        ))}
      </div>
    </Stage>
  );
}

/** 状态：平常、悬停（强制）、按下保持、禁用、键盘焦点（强制） */
export interface StateProps {
  className?: string;
  pressed?: boolean;
  disabled?: boolean;
}
export const STATES: readonly (readonly [string, string, StateProps])[] = [
  ['normal', '平常', {}],
  ['hover', '悬停', { className: 'sc-hover' }],
  ['pressed', '按下保持', { pressed: true }],
  ['disabled', '禁用', { disabled: true }],
  ['focus', '键盘焦点', { className: 'sc-focus' }],
];
const STATE_COLS = STATES.map(([id, label]) => [id, label] as const);

/** 状态表：每行一种（样子或尺寸……），每列一种状态；悬停和键盘焦点是强制显示的（不用鼠标和键盘）。
    render 拿到的 StateProps 展开到控件上就行（className 是强制状态的类，pressed、disabled 是控件自己的属性） */
export function StateTable({
  name,
  rows,
  render,
}: {
  name: string;
  rows: readonly (readonly [string, string])[];
  render: (row: string, s: StateProps) => ReactNode;
}) {
  return (
    <Matrix
      name={name}
      rows={rows}
      cols={STATE_COLS}
      render={(row, col) => render(row, STATES.find(([id]) => id === col)![2])}
    />
  );
}
