import { useState } from 'react';
import type { ComponentProps } from 'react';
import { ConfirmButton, Seg, Switch } from '../../../src/controls';
import { Stage } from '../../components/Stage';
import { Group, Matrix, useStageKind } from './shared';

/* 「开关」「分段选择」「两步确认的按钮」三块 */

/** 能拨的开关（库的）：点一下拨一下 */
function LiveSwitch({
  initial,
  ...rest
}: { initial: boolean } & Omit<ComponentProps<typeof Switch>, 'checked' | 'onChange'>) {
  const [on, setOn] = useState(initial);
  return <Switch checked={on} onChange={setOn} {...rest} />;
}

export function SwitchBlock() {
  return (
    <Group id="ctl-switch" title="开关" sub="Switch · .ll-switch">
      <p className="sc-note">
        一个 role=&quot;switch&quot; 的按钮，里面是轨道（28×16、钮
        12）和可选的文字；开着是强调色的底、白色的钮。两种用法：只有轨道，或者加 data-boxed
        外面套一层按钮的底（顶栏的动画开关就是 lg 的）。
      </p>
      <h4 className="sc-h4">样子和状态</h4>
      <Matrix
        name="switch"
        rows={[
          ['bare', '只有轨道'],
          ['label', '轨道加文字'],
          ['boxed-md', '按钮的底 · md'],
          ['boxed-lg', '按钮的底 · lg'],
        ]}
        cols={[
          ['off', '关'],
          ['on', '开'],
          ['hover', '悬停（强制）'],
          ['focus', '键盘焦点（强制）'],
          ['disabled', '禁用'],
        ]}
        render={(row, col) => (
          <LiveSwitch
            key={col}
            initial={col === 'on' || col === 'focus'}
            boxed={row.startsWith('boxed')}
            size={row === 'boxed-lg' ? 'lg' : undefined}
            label={row === 'bare' ? undefined : '动画'}
            aria-label={row === 'bare' ? '动画' : undefined}
            disabled={col === 'disabled'}
            className={col === 'hover' ? 'sc-hover' : col === 'focus' ? 'sc-focus' : undefined}
          />
        )}
      />
    </Group>
  );
}

export function SegBlock() {
  const kind = useStageKind();
  const [v, setV] = useState('system');
  return (
    <Group id="ctl-seg" title="分段选择" sub="Seg · .ll-seg">
      <p className="sc-note">
        一排互斥的按钮，aria-pressed 表示当前项；没有边框的底，选中的是强调色 30%
        的底。接口：value、items（值、文字、悬停说明）、onPick、label、labelledBy。
        面板设置里的「外观」用的就是它。
      </p>
      <h4 className="sc-h4">样子和状态</h4>
      <Stage kind={kind}>
        <div className="sc-ctl-stack" data-demo="seg">
          <Seg
            label="动画"
            value={v}
            onPick={setV}
            items={[
              ['system', '跟随系统', '跟随系统的「减少动态效果」'],
              ['on', '开', '一直开着'],
              ['off', '关', '一直关着'],
            ]}
          />
          <Seg
            label="禁用"
            value="on"
            onPick={() => {}}
            items={[
              ['system', '跟随系统'],
              ['on', '开'],
              ['off', '关'],
            ]}
            data-disabled-demo=""
          />
          <div className="sc-note" style={{ margin: 0 }}>
            当前选的是：<b data-live-value="">{v}</b>。悬停一项能看到说明；Tab
            走进去，空格、回车选中。
          </div>
        </div>
      </Stage>
    </Group>
  );
}

export function ConfirmBlock() {
  const kind = useStageKind();
  const [n, setN] = useState(0);
  return (
    <Group id="ctl-confirm" title="两步确认的按钮" sub="ConfirmButton">
      <p className="sc-note">
        第一次点，变成等待确认的样子（danger、红光、data-armed），字换成确认的说法；3
        秒内再点才触发；超时、点了别处、焦点离开都恢复。面板设置里的「恢复默认布局」用的就是它。
      </p>
      <h4 className="sc-h4">试试看（真的能走完两步）</h4>
      <Stage kind={kind}>
        <div className="sc-row" data-live="confirm">
          <ConfirmButton onConfirm={() => setN(n + 1)} armedLabel="再点一次恢复" data-live-btn="">
            恢复默认布局
          </ConfirmButton>
          <ConfirmButton
            onConfirm={() => setN(n + 1)}
            armedLabel="确认删除？"
            variant="ghost"
            size="sm"
            timeout={5000}
            data-live-btn2=""
          >
            删除（5 秒）
          </ConfirmButton>
          <span className="sc-note" style={{ margin: 0 }}>
            已确认 <b data-confirm-count="">{n}</b> 次
          </span>
        </div>
      </Stage>
    </Group>
  );
}
