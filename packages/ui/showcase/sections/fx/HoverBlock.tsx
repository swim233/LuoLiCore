import { useRef } from 'react';
import { Button } from '../../../src/controls';
import { edgeRun, hoverHandlers } from '../../../src/fx';
import type { HoverEffect } from '../../../src/fx';
import { Stage } from '../../components/Stage';
import { Group } from '../controls/shared';

/* 「悬停和流光」一块：三个夜空窗口各演示一种悬停的效果（窗口自己写 data-ll-hover；面板是写在根元素上整页一种），下面一个放流光的按钮 */
const WINS: readonly (readonly [HoverEffect, string, string])[] = [
  ['sweep', '流光 sweep', '鼠标进来时有一道光绕着窗口边缘跑一圈，窗口多一圈淡光'],
  ['glow', '边光 glow', '鼠标附近的那段边被照亮，跟着鼠标走'],
  ['tilt', '倾斜 tilt', '边光，加卡牌倾斜（最大 ±3 度）'],
];
const handlers = hoverHandlers();

function Win({ mode, title, text }: { mode: HoverEffect; title: string; text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={ref}
      className="ll-sky ll-hover sc-fx-win"
      data-ll-hover={mode}
      data-demo={`hover-${mode}`}
      {...handlers}
    >
      <i className="ll-edge" />
      <b>{title}</b>
      <span>{text}</span>
      <Button size="sm" data-demo={`edge-${mode}`} onClick={() => edgeRun(ref.current)}>
        放一圈流光
      </Button>
    </div>
  );
}

export function HoverBlock() {
  return (
    <Group id="fx-hover" title="悬停和流光" sub="hoverHandlers · edgeRun">
      <p className="sc-note">
        窗口（要有定位）加 <code>ll-hover</code> 类，用 <code>hoverHandlers()</code>{' '}
        的三个处理函数（进入时加 <code>ll-hot</code>、移动时写鼠标的坐标、离开时去掉）；
        <code>data-ll-hover</code>（<code>sweep</code>、<code>glow</code>、<code>tilt</code>
        ）说用哪一种，写在根元素上（<code>setHoverEffect</code>
        ）整页一种，也可以写在窗口自己身上，下面三个就是。 窗口里放一个空的{' '}
        <code>&lt;i className="ll-edge" /&gt;</code>，<code>edgeRun(窗口)</code>{' '}
        给它放一圈流光（悬停的 sweep
        进入时放一圈，别的事件也能放，比如新消息来了）。只在有鼠标时生效；
        动画关着时流光不出现、不倾斜。窗口自己的 transform 过渡（倾斜回正要靠它）、
        「什么时候不倾斜」（<code>canTilt</code>）、「什么时候不放流光」（<code>skipEdge</code>
        ）都由用的地方定。
      </p>
      <Stage kind="page">
        <div className="sc-fx-row" data-demo="fx-hover">
          {WINS.map(([mode, title, text]) => (
            <Win key={mode} mode={mode} title={title} text={text} />
          ))}
        </div>
      </Stage>
    </Group>
  );
}
