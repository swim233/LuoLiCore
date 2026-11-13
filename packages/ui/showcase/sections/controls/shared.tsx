import { createContext, useContext } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Compare } from '../../components/Compare';
import type { CompareMode } from '../../components/Compare';
import { Stage } from '../../components/Stage';
import type { StageKind } from '../../components/Stage';

/* 「基础控件」一节各块共用的零件 */

/** 摆在舞台上的东西垫哪种底：整节的「舞台的底」选的（对比块自己另有一个开关） */
export const StageCtx = createContext<StageKind>('sky');
export const useStageKind = () => useContext(StageCtx);

/** 对比块里被量的元素：QA 的脚本按 data-probe（now 现在 / merged 归并后）、data-item（哪一处）、data-state（哪种状态）把两边配对，
    读计算样式；页面上「面板上会变的地方」那张表的行也用同样的 item 和 state 对应 */
export const probe = (side: 'now' | 'merged', item: string, state = 'normal') => ({
  'data-probe': side,
  'data-item': item,
  'data-state': state,
});

/** 对比块里放控件的那一层：两边都套 .sc-ctx（字体、字号、行高照面板的 body），「现在」那边再套 .sc-legacy（旧样式只在这里生效） */
export function Ctx({
  legacy,
  className = '',
  style,
  children,
}: {
  legacy?: boolean;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <div className={`sc-ctx ${legacy ? 'sc-legacy' : ''} ${className}`} style={style}>
      {children}
    </div>
  );
}

/** 一个对比项：left 是面板现在的写法（旧样式），right 是换成库的组件以后 */
export interface Item {
  id: string;
  title: string;
  now: ReactNode;
  merged: ReactNode;
  /** 下面写变了什么（没变的写「不变」） */
  note: ReactNode;
  stage?: StageKind;
  mode?: CompareMode;
  /** 内容一行放不下的，独占一整行（免得「现在」「归并后」有一边折行，折行本身变成看得见的差别） */
  wide?: boolean;
  /** 外层的版面（两边一样）：className 和 style */
  ctxClass?: string;
  ctxStyle?: CSSProperties;
}

export function Items({ items }: { items: Item[] }) {
  return (
    <div className="sc-cmps">
      {items.map((it) => (
        <Compare
          key={it.id}
          title={it.title}
          stage={it.stage ?? 'sky'}
          mode={it.mode ?? 'side'}
          className={it.wide ? 'is-wide' : ''}
          nowLabel="现在（面板里的旧样式）"
          mergedLabel="归并后（库的组件）"
          now={
            <Ctx legacy className={it.ctxClass} style={it.ctxStyle}>
              {it.now}
            </Ctx>
          }
          merged={
            <Ctx className={it.ctxClass} style={it.ctxStyle}>
              {it.merged}
            </Ctx>
          }
          note={it.note}
        />
      ))}
    </div>
  );
}

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
