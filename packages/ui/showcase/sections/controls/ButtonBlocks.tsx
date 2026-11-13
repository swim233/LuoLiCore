import { useState } from 'react';
import { Button, Chevron, IconButton, Spinner } from '../../../src/controls';
import {
  IconArrange,
  IconChevronLeft,
  IconCheck,
  IconMax,
  IconMin,
  IconRestore,
  IconX,
} from '../../../src/icons';
import {
  LEGACY_ICON_ARRANGE,
  LEGACY_ICON_MAX,
  LEGACY_ICON_MIN,
  LEGACY_ICON_RESTORE,
  LegacySpin,
} from '../../legacy/parts';
import { Stage } from '../../components/Stage';
import { Group, Items, Matrix, StateTable, probe, useStageKind } from './shared';
import type { Item } from './shared';

/* 「按钮」和「图标按钮」两块：所有样子 × 尺寸、各种状态、能点的小演示，和「现在」的对比。 */

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

/* 对比项：面板里每一处用到按钮的地方，左边是旧样式，右边是库的组件 */
const BUTTON_ITEMS: Item[] = [
  {
    id: 'topbar-arrange',
    title: '顶栏的「整理」按钮（.tbtn）',
    stage: 'page',
    now: (
      <div className="sc-row">
        <button className="tbtn" type="button" {...probe('now', 'topbar-arrange')}>
          {LEGACY_ICON_ARRANGE}
          <span className="tlabel">整理</span>
        </button>
        <button
          className="tbtn"
          type="button"
          aria-pressed="true"
          {...probe('now', 'topbar-arrange', 'pressed')}
        >
          {LEGACY_ICON_ARRANGE}
          <span className="tlabel">整理</span>
        </button>
      </div>
    ),
    merged: (
      <div className="sc-row">
        <Button size="lg" {...probe('merged', 'topbar-arrange')}>
          <IconArrange />
          整理
        </Button>
        <Button size="lg" pressed {...probe('merged', 'topbar-arrange', 'pressed')}>
          <IconArrange />
          整理
        </Button>
      </div>
    ),
    note: '左边平常、右边整理模式开着时（按下保持）。尺寸、字号、图标都不变；按下保持的底从「强调色 22% 叠在控件底上」变成「强调色 30%」（和别处的按下保持统一）。窄屏下收起文字用的 .tlabel 留在面板。',
  },
  {
    id: 'arrange-chips',
    title: '整理模式里的按钮（.chip）：尺寸、收进收纳盒、完成、禁用',
    wide: true,
    now: (
      <div className="w-sizes">
        <button className="chip" type="button" {...probe('now', 'chip')}>
          1×1
        </button>
        <button
          className="chip"
          type="button"
          aria-pressed="true"
          {...probe('now', 'chip', 'pressed')}
        >
          2×1
        </button>
        <button className="chip" type="button">
          通栏
        </button>
        <button className="chip w-hide" type="button" {...probe('now', 'w-hide')}>
          收进收纳盒
        </button>
        <button className="chip" type="button" aria-pressed="true">
          完成
        </button>
        <button className="chip" type="button" disabled {...probe('now', 'chip', 'disabled')}>
          算了
        </button>
      </div>
    ),
    merged: (
      <div className="w-sizes">
        <Button {...probe('merged', 'chip')}>1×1</Button>
        <Button pressed {...probe('merged', 'chip', 'pressed')}>
          2×1
        </Button>
        <Button>通栏</Button>
        <Button {...probe('merged', 'w-hide')}>收进收纳盒</Button>
        <Button pressed>完成</Button>
        <Button disabled {...probe('merged', 'chip', 'disabled')}>
          算了
        </Button>
      </div>
    ),
    note: '高 28 不变，字号 12 不变；左右内边距 11→12；禁用时不透明度 0.35→0.5，禁用的按钮悬停不再变亮。「完成」（整理条上）是同一种按下保持的按钮，「收进收纳盒」的字色本来就和别的一样。',
  },
  {
    id: 'now-open',
    title: '「此刻」里的「在会话中打开」（.now-open）',
    now: (
      <button className="now-open" type="button" {...probe('now', 'now-open')}>
        在会话中打开
      </button>
    ),
    merged: <Button {...probe('merged', 'now-open')}>在会话中打开</Button>,
    note: '高 26→28，左右内边距 11→12，字号 12 不变。靠右（margin-left: auto）留在面板里。',
  },
  {
    id: 'task-cancel',
    title: '任务行的「取消」（.task-cancel）',
    now: (
      <button className="task-cancel" type="button" {...probe('now', 'task-cancel')}>
        取消
      </button>
    ),
    merged: (
      <Button size="sm" {...probe('merged', 'task-cancel')}>
        取消
      </Button>
    ),
    note: '面板里这个按钮只写了高、内边距、字号，没有写底和字色（没有套 .chip），所以现在是浏览器自己的按钮样子；换成 sm 的 soft 按钮：半透明的底、药丸形、字号 11、字色 fg-2，悬停变亮，和别的按钮一致。这是面板上最大的一处变化。',
  },
  {
    id: 'task-ask',
    title: '任务行里「取消这个任务？」那一行的两个按钮（.task-ask .chip）',
    now: (
      <div className="task-ask" role="group" aria-label="取消这个任务？">
        <span>取消这个任务？</span>
        <button className="chip is-armed" type="button" {...probe('now', 'task-confirm')}>
          确认
        </button>
        <button className="chip" type="button" {...probe('now', 'task-keep')}>
          算了
        </button>
        <button
          className="chip is-armed"
          type="button"
          disabled
          {...probe('now', 'task-confirm', 'disabled')}
        >
          取消中…
        </button>
      </div>
    ),
    merged: (
      <div className="task-ask" role="group" aria-label="取消这个任务？">
        <span>取消这个任务？</span>
        <Button size="sm" variant="danger" data-armed="" {...probe('merged', 'task-confirm')}>
          确认
        </Button>
        <Button size="sm" {...probe('merged', 'task-keep')}>
          算了
        </Button>
        <Button
          size="sm"
          variant="danger"
          data-armed=""
          disabled
          {...probe('merged', 'task-confirm', 'disabled')}
        >
          取消中…
        </Button>
      </div>
    ),
    note: '这一行的按钮现在是高 24 的 chip，换成 sm（高 22、字号 11、左右内边距 10），和旁边的「取消」一样大。「确认」是危险的样子加红光，底从危险色 22% 变成 24%。最右边是「取消中…」的禁用状态。',
  },
  {
    id: 'retry-pill',
    title: '提示条里的「重试」（.log-retry）',
    now: (
      <span className="log-pill is-err">
        更早的消息没取到
        <button className="log-retry" type="button" {...probe('now', 'retry-pill')}>
          重试
        </button>
      </span>
    ),
    merged: (
      <span className="log-pill is-err">
        更早的消息没取到
        <Button size="xs" style={{ marginLeft: 8 }} {...probe('merged', 'retry-pill')}>
          重试
        </Button>
      </span>
    ),
    note: '字号 12 不变，左右内边距 9→8；现在没有定高（行高带出来约 18.6），换成高 18；字色从主要文字色（fg）变成次要文字色（fg-2），和别的按钮一致。左边的空隙（8px）留在面板里。',
  },
  {
    id: 'retry-empty',
    title: '「没取到」的整块提示里的「重试」（.empty .log-retry）',
    now: (
      <div className="empty">
        <b>这个会话的消息没取到</b>
        <div>连上后会自动恢复</div>
        <button className="log-retry" type="button" {...probe('now', 'retry-empty')}>
          重试
        </button>
      </div>
    ),
    merged: (
      <div className="empty">
        <b>这个会话的消息没取到</b>
        <div>连上后会自动恢复</div>
        <Button size="sm" style={{ margin: '8px 0 0' }} {...probe('merged', 'retry-empty')}>
          重试
        </Button>
      </div>
    ),
    note: '现在是上下内边距 2、左右 12、字号 12（高约 22.6）的大一点的「重试」；换成 sm：高 22、左右内边距 10、字号 11；字色 fg→fg-2。上面的空隙（8px）留在面板里。',
  },
  {
    id: 'retry-chat',
    title: '出错的回复下面的「重试」（.chat-retry）',
    now: (
      <div className="msg">
        <button className="log-retry chat-retry" type="button" {...probe('now', 'retry-chat')}>
          重试
        </button>
      </div>
    ),
    merged: (
      <div className="msg">
        <Button size="sm" style={{ margin: '4px 4px 0' }} {...probe('merged', 'retry-chat')}>
          重试
        </Button>
      </div>
    ),
    note: '现在是上下内边距 2、左右 14、字号 12.5（高约 23.4）；换成 sm：高 22、左右内边距 10、字号 11；字色 fg→fg-2。四周的空隙（4px）留在面板里。',
  },
  {
    id: 'retry-live',
    title: '输入框上面「洛璃正在回复…」那一行里的「中止」（.chat-live .log-retry）',
    now: (
      <div className="chat-live" role="status">
        <LegacySpin {...probe('now', 'spin', 'live')} />
        <span>洛璃正在回复…</span>
        <button className="log-retry" type="button" {...probe('now', 'retry-live')}>
          中止
        </button>
      </div>
    ),
    merged: (
      <div className="chat-live" role="status">
        <Spinner {...probe('merged', 'spin', 'live')} />
        <span>洛璃正在回复…</span>
        <Button size="xs" style={{ marginLeft: 'auto' }} {...probe('merged', 'retry-live')}>
          中止
        </Button>
      </div>
    ),
    note: '「中止」和别处的「重试」是同一种小按钮（xs）：左右内边距 9→8，高约 18.6→18，字色 fg→fg-2。转圈不变。靠右（margin-left: auto）留在面板里。',
  },
  {
    id: 'seg-btn',
    title: '时间线里的「摘要」展开按钮（.seg-btn）',
    now: (
      <div className="sc-row">
        <button
          className="seg-btn"
          type="button"
          aria-expanded="false"
          {...probe('now', 'seg-btn')}
        >
          摘要
          <span className="chev" aria-hidden="true" />
        </button>
        <button
          className="seg-btn"
          type="button"
          aria-expanded="true"
          {...probe('now', 'seg-btn', 'expanded')}
        >
          摘要
          <span className="chev" aria-hidden="true" />
        </button>
      </div>
    ),
    merged: (
      <div className="sc-row">
        <Button size="xs" aria-expanded="false" {...probe('merged', 'seg-btn')}>
          摘要
          <Chevron />
        </Button>
        <Button size="xs" aria-expanded="true" {...probe('merged', 'seg-btn', 'expanded')}>
          摘要
          <Chevron />
        </Button>
      </div>
    ),
    note: '左边收着、右边展开着。字号 12 不变，左右内边距 9→8；箭头两边的空隙（现在左 0.5em、右 0.2em）并进按钮的 gap（6px），整个按钮窄约 4px；箭头的垂直位置在 1.5px 以内的变化（库的箭头是真正居中的）。',
  },
  {
    id: 'term-jump',
    title: '「此刻」终端的「回到最新」（.term-jump）',
    ctxStyle: { position: 'relative', height: 56 },
    now: (
      <div className="term-jump-wrap">
        <button className="term-jump" type="button" {...probe('now', 'term-jump')}>
          回到最新
          <span className="chev" aria-hidden="true" />
        </button>
      </div>
    ),
    merged: (
      <div className="term-jump-wrap">
        <Button variant="glass" style={{ pointerEvents: 'auto' }} {...probe('merged', 'term-jump')}>
          回到最新
          <Chevron dir="down" />
        </Button>
      </div>
    ),
    note: '字号 12.5→12，左右内边距 14 和 13→12；箭头 0.42em→0.38em、不透明度 0.8→1、位置居中；箭头和字之间的空隙变小，整个按钮窄约 14px。玻璃的底、边光、模糊、阴影不变；进场动画和定位留在面板里。',
  },
  {
    id: 'chat-send',
    title: '输入框的「发送」和「中止」（.chat-send）',
    now: (
      <div className="sc-row">
        <button className="chat-send" type="button" {...probe('now', 'chat-send')}>
          发送
        </button>
        <button className="chat-send is-stop" type="button" {...probe('now', 'chat-stop')}>
          中止
        </button>
        <button
          className="chat-send"
          type="button"
          disabled
          {...probe('now', 'chat-send', 'disabled')}
        >
          发送中
        </button>
      </div>
    ),
    merged: (
      <div className="sc-row">
        <Button variant="primary" style={{ minWidth: 52 }} {...probe('merged', 'chat-send')}>
          发送
        </Button>
        <Button variant="danger" style={{ minWidth: 52 }} {...probe('merged', 'chat-stop')}>
          中止
        </Button>
        <Button
          variant="primary"
          style={{ minWidth: 52 }}
          disabled
          {...probe('merged', 'chat-send', 'disabled')}
        >
          发送中
        </Button>
      </div>
    ),
    note: '高 28 不变；字号 12.5→12，左右内边距 13→12；粗 600 不变；禁用的不透明度 0.6→0.5。「中止」的淡红底不变（已经是 24%），但字重 600→400（danger 样子不加粗）。min-width: 52px 留在面板里。',
  },
  {
    id: 'sess-back',
    title: '窗口里会话头部的「‹ 返回」（.w-btn.sess-back）',
    now: (
      <div className="sess-win-head">
        <button className="w-btn sess-back" type="button" {...probe('now', 'sess-back')}>
          <span aria-hidden="true">‹</span>返回
        </button>
      </div>
    ),
    merged: (
      <Button variant="ghost" style={{ marginLeft: -4 }} {...probe('merged', 'sess-back')}>
        <IconChevronLeft />
        返回
      </Button>
    ),
    note: '现在是图标按钮（.w-btn）加上自己改的宽高和内边距，里面的「‹」是一个字；换成 ghost 的按钮加一个箭头图标：高 28 不变，字号 12.5→12，左右内边距 8 和 10→12，圆角 9→全圆角，字色 fg-dim→fg-2。左边的负空隙（-4px）留在面板里。',
  },
];

const ICON_BTN_ITEMS: Item[] = [
  {
    id: 'w-btns',
    title: '窗口右上角的三个图标按钮（.w-btn）：缩小、放大、还原',
    now: (
      <div className="w-btns">
        <button
          className="w-btn"
          type="button"
          aria-label="缩小到缩略"
          {...probe('now', 'w-btn', 'min')}
        >
          {LEGACY_ICON_MIN}
        </button>
        <button
          className="w-btn"
          type="button"
          aria-label="放大到全屏"
          {...probe('now', 'w-btn', 'max')}
        >
          {LEGACY_ICON_MAX}
        </button>
        <button
          className="w-btn"
          type="button"
          aria-label="还原"
          {...probe('now', 'w-btn', 'restore')}
        >
          {LEGACY_ICON_RESTORE}
        </button>
      </div>
    ),
    merged: (
      <div className="w-btns">
        <IconButton aria-label="缩小到缩略" {...probe('merged', 'w-btn', 'min')}>
          <IconMin />
        </IconButton>
        <IconButton aria-label="放大到全屏" {...probe('merged', 'w-btn', 'max')}>
          <IconMax />
        </IconButton>
        <IconButton aria-label="还原" {...probe('merged', 'w-btn', 'restore')}>
          <IconRestore />
        </IconButton>
      </div>
    ),
    note: '30×30、图标 15px、字色和悬停都不变；圆角 9→10（吸附到刻度）。靠右（margin-left: auto）和整理时淡出的过渡留在面板里。',
  },
];

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
        aria-pressed，禁用用 disabled。面板里的 9 种按钮并成了这 5 种样子：
        .chip、.tbtn、.now-open、.task-cancel、.log-retry、.seg-btn 是 soft，.chat-send 是 primary，
        .chat-send.is-stop 和等待确认的 .chip 是 danger，.term-jump 是 glass。
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
      <h4 className="sc-h4">和面板现在的对比</h4>
      <Items items={BUTTON_ITEMS} />
    </Group>
  );
}

export function IconButtonBlock() {
  const kind = useStageKind();
  return (
    <Group id="ctl-icon-button" title="图标按钮" sub="IconButton · .ll-icon-btn">
      <p className="sc-note">
        30×30、透明底、字色最淡、悬停出现控件的底；里面一个 15px 的图标。必须有 aria-label（React
        组件的类型上就要求）。对应面板的 .w-btn。
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
      <h4 className="sc-h4">和面板现在的对比</h4>
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
      <Items items={ICON_BTN_ITEMS} />
    </Group>
  );
}
