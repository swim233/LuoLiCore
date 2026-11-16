import { useLayoutEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { Button } from '../../../src/controls';
import type { FormSize } from '../../../src/forms';
import { Stage } from '../../components/Stage';
import type { StageKind } from '../../components/Stage';
import './forms-demo.css';

/* 「表单」一节各块共用的零件 */

/** 强制显示悬停、键盘焦点：给里面符合选择器的元素加 sc-hover、sc-focus 类
    （展示页启动时把库里带 :hover、:focus-visible 的规则各复制了一条 .sc-hover、.sc-focus 的，见 lib/force-states.ts）。
    每次渲染以后重新加一遍（React 重画不会去掉不是它加的类，这里只是保险）。 */
export function Force({
  hover,
  focus,
  children,
}: {
  hover?: string;
  focus?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    if (hover) root.querySelectorAll(hover).forEach((el) => el.classList.add('sc-hover'));
    if (focus) root.querySelectorAll(focus).forEach((el) => el.classList.add('sc-focus'));
  });
  return (
    <div ref={ref} className="sc-fm-force">
      {children}
    </div>
  );
}

export interface StateCell {
  id: string;
  label: string;
  node: ReactNode;
}

/** 各状态摆一格一格的（每格上面写状态名），舞台垫夜空 */
export function StateGrid({
  name,
  cells,
  kind = 'sky',
}: {
  name: string;
  cells: readonly StateCell[];
  kind?: StageKind;
}) {
  return (
    <Stage kind={kind}>
      <div className="sc-fm-states" data-demo={name}>
        {cells.map((c) => (
          <figure key={c.id} className="sc-fm-cell" data-state={c.id}>
            <figcaption>{c.label}</figcaption>
            {c.node}
          </figure>
        ))}
      </div>
    </Stage>
  );
}

const SIZES: readonly (readonly [FormSize, string])[] = [
  ['sm', 'sm 高 22'],
  ['md', 'md 高 28'],
  ['lg', 'lg 高 32（表单里默认）'],
];

/** 三档尺寸摆三行，每行控件旁边放一个同档的按钮（要一样高） */
export function SizeRows({
  name,
  render,
  withButton = true,
}: {
  name: string;
  render: (size: FormSize) => ReactNode;
  withButton?: boolean;
}) {
  return (
    <Stage kind="sky">
      <div className="sc-fm-sizes" data-demo={name}>
        {SIZES.map(([size, label]) => (
          <div className="sc-fm-size-row" key={size} data-size-row={size}>
            <span className="sc-fm-size-label">{label}</span>
            <div className="sc-fm-size-ctl">{render(size)}</div>
            {withButton && (
              <Button size={size} variant="primary">
                按钮
              </Button>
            )}
          </div>
        ))}
      </div>
    </Stage>
  );
}

/** 一块：标题、说明、内容 */
export function Block({
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

/** 一行小标题 */
export const H4 = ({ children }: { children: ReactNode }) => <h4 className="sc-h4">{children}</h4>;
