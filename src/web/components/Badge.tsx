import { memo, useLayoutEffect, useRef } from 'react';
import { BadgeController } from './badge/controller';
import { MOON_PATH, SAT_PATH, STAR_PATH } from './badge/geometry';
import { STATE_TEXT, useStatus } from '../model/status';
import { useAssistantName } from '../model/who';

/* 状态徽记：待机是冷色弯月，工作时弯月散成星尘、聚成金色四角星，右上角有一颗绕着转的小卫星；几个会话同时回复时主星外面有伴星。
   React 只渲染这副骨架（SVG 与几层包装），画面由命令式的控制器（badge/controller.ts）管，订阅「样子」（badge/appearance.ts）：
   五处徽记（顶栏、胶囊、「此刻」、全屏标签）同一帧一起变，React 不逐帧渲染。粒子画在自己的小画布上，在星尘 Worker 里。
   每个叠加的层都是独立的 <svg> 或 <span>（HTML 元素上的 transform、opacity 动画跑在合成器上，SVG 里的子元素的动画要主线程每帧重画） */
const Sv = ({ cls, d }: { cls: string; d: string }) => (
  <svg className={'bd-svg ' + cls} viewBox="-50 -50 100 100" aria-hidden="true">
    <path d={d} />
  </svg>
);
const Skeleton = memo(function Skeleton() {
  return (
    <>
      <span className="bd-fl">
        <span className="bd-fl2">
          <span className="bd-mo">
            <span className="bd-mb">
              <Sv cls="bd-moon" d={MOON_PATH} />
              <Sv cls="bd-mhot" d={MOON_PATH} />
              <Sv cls="bd-mdim" d={MOON_PATH} />
            </span>
          </span>
        </span>
      </span>
      <span className="bd-cloud">
        <span className="bd-cloud-i" />
      </span>
      <span className="bd-starw">
        <span className="bd-sti">
          <span className="bd-sw">
            <Sv cls="bd-star" d={STAR_PATH} />
            <Sv cls="bd-red" d={STAR_PATH} />
            <Sv cls="bd-hot" d={STAR_PATH} />
          </span>
        </span>
        <span className="bd-sat">
          <Sv cls="bd-glint" d={SAT_PATH} />
        </span>
      </span>
      {[0, 1, 2].map((i) => (
        <span className={`bd-comp bd-c${i}`} key={i}>
          <span className="bd-cmv">
            <span className="bd-cpop">
              <Sv cls="bd-cstar" d={STAR_PATH} />
            </span>
          </span>
        </span>
      ))}
      <span className="bd-zs" />
    </>
  );
});
export function Badge({ size }: { size: number }) {
  const snap = useStatus();
  const name = useAssistantName();
  const ref = useRef<HTMLSpanElement>(null);
  /* 布局 effect：挂上的同一次提交里就写好 data-look 等静态底子、画好当前的样子，浏览器的第一帧不会是默认的弯月 */
  useLayoutEffect(() => {
    const c = new BadgeController(ref.current!, size);
    return () => c.destroy();
  }, [size]);
  return (
    <span
      className="bd"
      ref={ref}
      role="img"
      style={{ '--s': size + 'px' }}
      aria-label={name + '：' + STATE_TEXT[snap.state]}
    >
      <Skeleton />
    </span>
  );
}
/* 调用工具时显示的工具名（等宽 12px，闪烁） */
export function ToolName() {
  const snap = useStatus();
  return <span className="badge-tool">{snap.state === 'tool' ? snap.tool || '' : ''}</span>;
}
