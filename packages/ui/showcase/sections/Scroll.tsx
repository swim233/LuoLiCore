import { SectionHead } from '../components/SectionHead';
import { GlideBlock } from './scroll/GlideBlock';
import { LogBlock } from './scroll/LogBlock';
import { PaneBlock } from './scroll/PaneBlock';
import { WheelBlock } from './scroll/WheelBlock';

/* 「滚动」一节：窗格、长列表、悬停高亮、滚轮缓动（@luoli/ui/scroll）和滚动条。程序自己滚的滑动（@luoli/ui/slide）是长列表里用的，纯逻辑，没有单独的演示 */
const INDEX: readonly (readonly [string, string])[] = [
  ['scr-pane', '窗格'],
  ['scr-log', '长列表'],
  ['scr-glide', '悬停高亮'],
  ['scr-wheel', '滚轮缓动'],
];

export function Scroll() {
  return (
    <>
      <SectionHead title="滚动">
        部件里滚动相关的几样：窗格（标题和输入框浮在内容上面、滚进去的内容由浅到深地糊）、长列表（时间线的贴底、上推、停在某一条）、悬停高亮（跟着鼠标滑的边光）、滚轮缓动。
        入口是 <code>@luoli/ui/scroll</code>；样式在库的 <code>@layer ll.controls</code>{' '}
        里，库不认识外壳，大动画期间的取舍由用的地方决定。
      </SectionHead>
      <div className="sc-ctl-bar">
        <nav className="sc-ctl-index" aria-label="这一节里的块" data-index="">
          {INDEX.map(([id, name]) => (
            <button
              key={id}
              type="button"
              onClick={() =>
                document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              }
            >
              {name}
            </button>
          ))}
        </nav>
      </div>
      <PaneBlock />
      <LogBlock />
      <GlideBlock />
      <WheelBlock />
    </>
  );
}
