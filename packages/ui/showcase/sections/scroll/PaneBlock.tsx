import { useState } from 'react';
import { Pane } from '../../../src/scroll';
import { Switch } from '../../../src/controls';
import { Stage } from '../../components/Stage';
import { Group } from '../controls/shared';

/* 「窗格」一块：放在夜空窗口里，标题、选会话那一行、输入框浮在内容上面，内容滚进去的部分由浅到深地糊 */
const LINES = Array.from(
  { length: 28 },
  (_, i) => `第 ${i + 1} 行：内容铺满整块，滚进浮着的东西下面就被糊开。`,
);

const SHORT = ['第 1 行：内容不够一屏。', '第 2 行：两边都没有渐变带。'];

function Win({ lines, noBlur, name }: { lines: string[]; noBlur: boolean; name: string }) {
  return (
    <div
      className={`sc-scr-win ll-sky${noBlur ? ' sc-scr-noblur' : ''}`}
      data-demo={name}
      data-noblur={noBlur ? '' : undefined}
    >
      <div className="sc-scr-title">窗口标题（外壳画，浮在最上面）</div>
      <Pane
        top={<div className="sc-scr-bar">浮着的一行（对话里选会话的那一行）</div>}
        bottom={<div className="sc-scr-composer">输入框浮在下面</div>}
      >
        <div className="ll-pane-sc sc-scr-body" data-demo={`${name}-scroll`}>
          {lines.map((t) => (
            <p key={t}>{t}</p>
          ))}
        </div>
      </Pane>
      <i className="ll-sky-vig" aria-hidden="true" style={{ zIndex: 3 }} />
    </div>
  );
}

export function PaneBlock() {
  const [noBlur, setNoBlur] = useState(false);
  return (
    <Group id="scr-pane" title="窗格" sub="Pane · .ll-pane">
      <p className="sc-note">
        部件里的一块滚动区：<code>&lt;Pane top bottom&gt;</code> 的 children
        是滚动区本身（恰好一个元素，带 <code>ll-pane-sc</code>
        ），上面、下面浮着的东西盖在内容上面。内容滚进它们下面时由浅到深地糊：每边一组 4 层
        backdrop-filter（半径
        0.38、1.65、6.08、21.52px，按指数曲线）加一层渐变的底；渐变带长度是窗格高度的
        10.5%（24～82px）；只在那一边还有内容时出现（CSS 的滚动驱动动画：顶上那组在滚动头 32px
        里淡入，底下那组在最后 32px 里淡出），下面右边那个窗口内容不够一屏，两边都没有。
      </p>
      <p className="sc-note">
        对外的约定：Pane 量出浮层高度写成 <code>--ll-pane-ht</code>、<code>--ll-pane-hb</code>、
        <code>--ll-pane-rt</code>、<code>--ll-pane-ph</code>（写在 <code>.ll-pane</code>{' '}
        上）；用的地方给 <code>--ll-pane-head</code>（标题栏高度，空出来的 <code>.ll-pane-hsp</code>{' '}
        用）、滚动区自己的留白 <code>--ll-pane-sc-pt</code>/<code>--ll-pane-sc-pb</code>、窗口圆角{' '}
        <code>--ll-pane-rtl</code>/<code>rtr</code>/<code>rbl</code>/<code>rbr</code>
        。容器上不能有透明度动画、opacity &lt; 1、filter、mask（模糊会看不到后面）。库不认识外壳：
        <b>大动画期间（形变、整理拖动）</b>要关掉模糊、只留渐变的底， 就对{' '}
        <code>.ll-pane-ov &gt; i:not(.ll-pane-tn)</code> 写{' '}
        <code>backdrop-filter: none; transition: none</code>
        （下面的开关就是这么写的）；停下来撤掉，模糊按 0.2 秒淡回来。
      </p>
      <div className="sc-pill-row sc-scr-ctl">
        <Switch
          checked={noBlur}
          onChange={setNoBlur}
          label="模拟大动画期间：关掉模糊，只留渐变的底"
          data-demo="pane-noblur"
        />
      </div>
      <Stage kind="page">
        <div className="sc-pill-row" style={{ alignItems: 'flex-start' }}>
          <Win lines={LINES} noBlur={noBlur} name="pane" />
          <Win lines={SHORT} noBlur={noBlur} name="pane-short" />
        </div>
      </Stage>
    </Group>
  );
}
