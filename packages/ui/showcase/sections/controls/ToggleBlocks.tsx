import { useEffect, useRef, useState } from 'react';
import type { ComponentProps } from 'react';
import { Button, ConfirmButton, Seg, Switch } from '../../../src/controls';
import { LegacyConfirm, LegacySwitch } from '../../legacy/parts';
import { Stage } from '../../components/Stage';
import { Ctx, Group, Items, Matrix, probe, useStageKind } from './shared';
import type { Item } from './shared';

/* 「开关」「分段选择」「两步确认的按钮」三块 */

/** 能拨的开关（库的）：点一下拨一下 */
function LiveSwitch({
  initial,
  ...rest
}: { initial: boolean } & Omit<ComponentProps<typeof Switch>, 'checked' | 'onChange'>) {
  const [on, setOn] = useState(initial);
  return <Switch checked={on} onChange={setOn} {...rest} />;
}

const SWITCH_ITEMS: Item[] = [
  {
    id: 'topbar-motion',
    title: '顶栏的动画开关（.tbtn.tswitch）',
    stage: 'page',
    now: (
      <div className="sc-row">
        <LegacySwitch initial label="动画" {...probe('now', 'topbar-motion', 'on')} />
        <LegacySwitch initial={false} label="动画" {...probe('now', 'topbar-motion', 'off')} />
      </div>
    ),
    merged: (
      <div className="sc-row">
        <LiveSwitch
          initial
          boxed
          size="lg"
          label="动画"
          {...probe('merged', 'topbar-motion', 'on')}
        />
        <LiveSwitch
          initial={false}
          boxed
          size="lg"
          label="动画"
          {...probe('merged', 'topbar-motion', 'off')}
        />
      </div>
    ),
    note: '左边开着、右边关着；点一下能拨。高 32、字号 13、轨道 28×16、钮 12 都不变，拨动的过渡不变；右边的内边距 13→14。窄屏下收起文字用的 .tlabel 和更窄的内边距留在面板里。',
  },
];

function LiveSeg({
  initial,
  names,
  settings,
  ...rest
}: {
  initial: string;
  names: readonly (readonly [string, string])[];
  settings?: boolean;
  'data-probe'?: string;
  'data-item'?: string;
  'data-state'?: string;
}) {
  const [v, setV] = useState(initial);
  const el = useRef<HTMLDivElement>(null);
  /* 对比块里要量里面的按钮：Seg 不给每个按钮开口子，这里挂载以后给前两个按钮加上标记 */
  useEffect(() => {
    const item = rest['data-item'];
    if (!item) return;
    ['on', 'off'].forEach((state, i) => {
      const b = el.current?.querySelectorAll('button')[i];
      if (!b) return;
      b.dataset.probe = 'merged';
      b.dataset.item = item;
      b.dataset.state = state;
    });
  }, [rest]);
  return (
    <Seg
      ref={el}
      label="动画"
      value={v}
      items={names}
      onPick={setV}
      style={settings ? { alignSelf: 'flex-start', maxWidth: '100%' } : undefined}
      {...rest}
    />
  );
}

const SEG_NAMES = [
  ['system', '跟随系统'],
  ['on', '开'],
  ['off', '关'],
] as const;

const SEG_ITEMS: Item[] = [
  {
    id: 'seg-settings',
    title: '设置里的分段选择（.seg-ctl）',
    now: (
      <div className="set-field">
        <div
          className="seg-ctl"
          role="group"
          aria-label="动画"
          {...probe('now', 'seg', 'container')}
        >
          <button type="button" aria-pressed="true" {...probe('now', 'seg', 'on')}>
            跟随系统
          </button>
          <button type="button" aria-pressed="false" {...probe('now', 'seg', 'off')}>
            开
          </button>
          <button type="button" aria-pressed="false">
            关
          </button>
        </div>
      </div>
    ),
    merged: (
      <div className="set-field">
        <LiveSeg
          initial="system"
          names={SEG_NAMES}
          settings
          {...probe('merged', 'seg', 'container')}
        />
      </div>
    ),
    note: '外框圆角 9→10、里面的按钮圆角 7→6（吸附到刻度）；高 26、字号 12、内边距、底色、选中的底都不变。设置里的按钮左右内边距 12px（.set-field 里改的）留在面板里。点一下能选。',
  },
];

const RESET_ITEMS: Item[] = [
  {
    id: 'reset-layout',
    title: '设置里的「恢复默认布局」（.chip 加 .is-armed）',
    now: (
      <div className="sc-row">
        <div className="set-field">
          <button className="chip" type="button" {...probe('now', 'reset-layout')}>
            恢复默认布局
          </button>
        </div>
        <div className="set-field">
          <button
            className="chip is-armed"
            type="button"
            {...probe('now', 'reset-layout', 'armed')}
          >
            再点一次恢复
          </button>
        </div>
      </div>
    ),
    merged: (
      <div className="sc-row">
        <div className="set-field">
          <ConfirmButton
            onConfirm={() => {}}
            armedLabel="再点一次恢复"
            style={{ alignSelf: 'flex-start', maxWidth: '100%' }}
            {...probe('merged', 'reset-layout')}
          >
            恢复默认布局
          </ConfirmButton>
        </div>
        <div className="set-field">
          <Button
            variant="danger"
            data-armed=""
            style={{ alignSelf: 'flex-start', maxWidth: '100%' }}
            {...probe('merged', 'reset-layout', 'armed')}
          >
            再点一次恢复
          </Button>
        </div>
      </div>
    ),
    note: '左边平常、右边等待确认。现在设置里把这个按钮改成了高 30、左右内边距 14，换成 md：高 28、左右内边距 12，字号 12 不变；等待确认的红底 22%→24%，红光不变。右边是等待确认时的样子（静态画出来）；左边那个两边都是真的，点一下就会走两步确认。',
  },
];

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
      <h4 className="sc-h4">和面板现在的对比</h4>
      <Items items={SWITCH_ITEMS} />
    </Group>
  );
}

export function SegBlock() {
  const kind = useStageKind();
  const [v, setV] = useState('system');
  return (
    <Group id="ctl-seg" title="分段选择" sub="Seg · .ll-seg">
      <p className="sc-note">
        一排互斥的按钮，aria-pressed 表示当前项；没有边框的底，选中的是强调色 30% 的底。接口照面板的
        Seg：value、items（值、文字、悬停说明）、onPick、label、labelledBy。
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
      <h4 className="sc-h4">和面板现在的对比</h4>
      <Items items={SEG_ITEMS} />
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
        秒内再点才触发；超时、点了别处、焦点离开都恢复。行为照面板里设置的「恢复默认布局」。
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
      <h4 className="sc-h4">和面板现在的对比</h4>
      <Items items={RESET_ITEMS} />
      <Stage kind={kind}>
        <Ctx legacy className="sc-row">
          <LegacyConfirm
            label="恢复默认布局（面板里的旧版，也能走两步）"
            armedLabel="再点一次恢复"
            onConfirm={() => {}}
            data-demo="legacy-confirm"
          />
        </Ctx>
      </Stage>
    </Group>
  );
}
