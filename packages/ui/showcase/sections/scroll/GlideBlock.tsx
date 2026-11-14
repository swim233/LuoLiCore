import { useState } from 'react';
import { hideGlides, useGlide } from '../../../src/scroll';
import { Button, RowButton } from '../../../src/controls';
import { useMotionOn } from '../../../src/motion';
import { Stage } from '../../components/Stage';
import { Group } from '../controls/shared';

/* 「悬停高亮」一块：鼠标滑过一列行，一块边光高亮跟着滑过去；动画关掉时只淡入淡出 */
const ROWS: [string, string][] = [
  ['星空观测站', '洛璃：好的，周六早上八点北门集合'],
  ['周末打球', '群友：那就先按下午三点来'],
  ['读书会', '有人在吗，这周读到哪一章了'],
  ['CLI 会话', '星星落进口袋里，口袋里装着一整个夏天'],
  ['推荐几部科幻小说', '任务到点 · 提醒我看科幻小说的书评'],
];
const MENU = ['星空观测站', '周末打球', '读书会', '＋ 新对话'];

function Rows() {
  const g = useGlide('.ll-row');
  return (
    <div
      className="sc-scr-rows"
      data-demo="glide-rows"
      ref={(el) => {
        g.list.current = el;
      }}
    >
      <i
        className="ll-glide"
        ref={(el) => {
          g.glide.current = el;
        }}
        aria-hidden="true"
      />
      {ROWS.map(([title, sub]) => (
        <RowButton key={title} title={title} sub={sub} />
      ))}
    </div>
  );
}

function Menu() {
  const g = useGlide('.sc-scr-menu > button');
  return (
    <div
      className="sc-scr-menu"
      role="menu"
      data-demo="glide-menu"
      ref={(el) => {
        g.list.current = el;
      }}
    >
      <i
        className="ll-glide"
        ref={(el) => {
          g.glide.current = el;
        }}
        aria-hidden="true"
      />
      {MENU.map((t) => (
        <button key={t} type="button" role="menuitem" className="ll-glide-item">
          {t}
        </button>
      ))}
    </div>
  );
}

export function GlideBlock() {
  const on = useMotionOn();
  const [n, setN] = useState(0);
  return (
    <Group id="scr-glide" title="悬停高亮" sub="useGlide · hideGlides · .ll-glide">
      <p className="sc-note">
        一个列表一块高亮：<code>const g = useGlide(行的选择器)</code>，列表元素{' '}
        <code>ref={'{g.list}'}</code>，列表的第一个子元素是{' '}
        <code>&lt;i className="ll-glide" ref={'{g.glide}'} /&gt;</code>
        。鼠标进到一行时高亮滑过去（0.3 秒，先过冲约 4
        像素再回来，方向跟着滑动的方向，中途换行从此刻的位置接着走），宽高跟着那一行，离开列表淡出；列表滚动时跟到鼠标下的那一行；
        行进出场、重排时淡掉，等鼠标再动、那一行停稳了再出现；只认鼠标（触屏没有）。关动画时不滑：那一行自己淡入淡出（行带{' '}
        <code>ll-hl</code>）。 行是库的 <code>.ll-row</code>，不是 <code>.ll-row</code>{' '}
        的行（菜单里的按钮）自己加 <code>ll-glide-item</code>； 高亮的圆角由列表上的{' '}
        <code>--ll-glide-radius</code> 定（默认 12px，要和行的圆角一样）。
        <b>库不认识外壳</b>：窗口开始形变这类「该淡掉了」的时刻由用的地方调{' '}
        <code>hideGlides()</code>（下面的按钮）。 现在动画是{on ? '开着' : '关着'}的。
      </p>
      <div className="sc-pill-row sc-scr-ctl">
        <Button
          onClick={() => {
            hideGlides();
            setN((v) => v + 1);
          }}
          data-demo="glide-hide"
        >
          hideGlides()
        </Button>
        <span className="sc-stage-tag">
          先把鼠标停在一行上，再点按钮：高亮马上淡掉，鼠标再动、那一行停稳了才出来（点了 {n} 次）
        </span>
      </div>
      <Stage kind="sky">
        <div className="sc-pill-row" style={{ alignItems: 'flex-start' }}>
          <Rows />
          <Menu />
        </div>
      </Stage>
    </Group>
  );
}
