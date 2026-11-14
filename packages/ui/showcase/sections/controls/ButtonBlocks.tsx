import { useState } from 'react';
import { Button, Chevron, IconButton } from '../../../src/controls';
import { IconArrange, IconCheck, IconMax, IconMin, IconRestore, IconX } from '../../../src/icons';
import { Stage } from '../../components/Stage';
import { Group, Matrix, StateTable, useStageKind } from './shared';

/* 「按钮」和「图标按钮」两块：所有样子 × 尺寸、各种状态、能点的小演示。 */

const VARIANTS = [
  ['soft', 'soft（默认）'],
  ['primary', 'primary'],
  ['danger', 'danger'],
  ['glass', 'glass'],
  ['ghost', 'ghost'],
] as const;
type Variant = (typeof VARIANTS)[number][0];
const SIZES = [
  ['xs', 'xs · 高 18'],
  ['sm', 'sm · 高 22'],
  ['md', 'md · 高 28（默认）'],
  ['lg', 'lg · 高 32'],
] as const;
type Size = (typeof SIZES)[number][0];

/* 能点的小演示：按下保持、点击计数 */
function Playground() {
  const [on, setOn] = useState(false);
  const [n, setN] = useState(0);
  return (
    <div className="sc-row" data-live="button">
      <Button pressed={on} onClick={() => setOn(!on)} data-live-toggle="">
        {on ? '按下保持：开' : '按下保持：关'}
      </Button>
      <Button variant="primary" onClick={() => setN(n + 1)} data-live-count="">
        点我（{n}）
      </Button>
      <Button variant="ghost" onClick={() => setN(0)}>
        <IconX />
        清零
      </Button>
      <IconButton aria-label="确认" onClick={() => setN(n + 10)}>
        <IconCheck />
      </IconButton>
    </div>
  );
}

export function ButtonBlock() {
  const kind = useStageKind();
  return (
    <Group id="ctl-button" title="按钮" sub="Button · .ll-btn">
      <p className="sc-note">
        五种样子（data-variant）× 四档尺寸（data-size），都是全圆角。不写时是 soft、md。按下保持用
        aria-pressed，禁用用 disabled。面板里的按钮都用这 5 种样子：大多数是
        soft，输入框的「发送」是 primary，「中止」和等待确认的按钮是 danger，「回到最新」是
        glass，会话头部的「返回」「N 个任务」是 ghost。
      </p>
      <Matrix
        name="button"
        rows={VARIANTS}
        cols={SIZES}
        render={(v, s) => (
          <Button variant={v as Variant} size={s as Size}>
            按钮
          </Button>
        )}
      />
      <h4 className="sc-h4">带图标、带小箭头（图标 14px，和字隔 6px）</h4>
      <Stage kind={kind}>
        <div className="sc-row" data-demo="button-icons">
          <Button size="lg">
            <IconArrange />
            整理
          </Button>
          <Button>
            <IconCheck />
            完成
          </Button>
          <Button size="xs">
            摘要
            <Chevron />
          </Button>
          <Button variant="glass">
            回到最新
            <Chevron dir="down" />
          </Button>
        </div>
      </Stage>
      <h4 className="sc-h4">状态（悬停和键盘焦点是强制显示的，不用鼠标和键盘）</h4>
      <StateTable
        name="button-states"
        rows={VARIANTS}
        render={(v, s) => (
          <Button
            variant={v as Variant}
            pressed={s.pressed}
            disabled={s.disabled}
            className={s.className}
          >
            按钮
          </Button>
        )}
      />
      <h4 className="sc-h4">试试看（真的能点）</h4>
      <Stage kind={kind}>
        <Playground />
      </Stage>
    </Group>
  );
}

export function IconButtonBlock() {
  const kind = useStageKind();
  return (
    <Group id="ctl-icon-button" title="图标按钮" sub="IconButton · .ll-icon-btn">
      <p className="sc-note">
        30×30、透明底、字色最淡、悬停出现控件的底；里面一个 15px 的图标。必须有 aria-label（React
        组件的类型上就要求）。面板窗口标题栏右上角的缩小、放大、还原用的就是它。
      </p>
      <h4 className="sc-h4">状态</h4>
      <StateTable
        name="icon-button-states"
        rows={[['icon', '图标按钮']]}
        render={(_, s) => (
          <IconButton
            aria-label="还原"
            pressed={s.pressed}
            disabled={s.disabled}
            className={s.className}
          >
            <IconRestore />
          </IconButton>
        )}
      />
      <h4 className="sc-h4">几个图标按钮</h4>
      <Stage kind={kind}>
        <div className="sc-row" data-demo="icon-buttons">
          <IconButton aria-label="缩小">
            <IconMin />
          </IconButton>
          <IconButton aria-label="放大">
            <IconMax />
          </IconButton>
          <IconButton aria-label="整理">
            <IconArrange />
          </IconButton>
          <IconButton aria-label="关闭">
            <IconX />
          </IconButton>
        </div>
      </Stage>
    </Group>
  );
}
