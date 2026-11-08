import { STAR_PATH, GLINT_PATH } from './icons';
import { STATE_TEXT, useStatus } from '../model/status';
import type { Snap } from '../model/status';

/* 状态徽记：一颗四角星（SVG），八种状态。星星自己是一个 <svg> 元素（不是 SVG 里的 <g>）：
   HTML 元素上的 transform / opacity 动画跑在合成器上，SVG 里的子元素的动画要主线程每帧重画 */
const SPARKS = [0, 60, 120, 180, 240, 300];
export function BadgeView({ size, snap }: { size: number; snap: Snap }) {
  return (
    <span
      className="badge"
      role="img"
      data-s={snap.state}
      style={{ '--bs': size + 'px' }}
      aria-label={'洛璃：' + STATE_TEXT[snap.state]}
    >
      <span className="badge-halo" />
      <svg className="badge-svg" viewBox="-50 -50 100 100" aria-hidden="true">
        <g className="b-rings">
          <circle r="44" />
          <circle r="44" />
          <circle r="44" />
        </g>
        <g className="b-sparks">
          {SPARKS.map((a, i) => (
            <circle
              key={a}
              r="3.4"
              style={{ '--a': a + 'deg', '--d': (i * 0.18).toFixed(2) + 's' }}
            />
          ))}
        </g>
      </svg>
      <svg className="badge-svg b-star" viewBox="-50 -50 100 100" aria-hidden="true">
        <path className="b-star-path" d={STAR_PATH} />
        <path className="b-glint" d={GLINT_PATH} />
      </svg>
      <span className="badge-count">{snap.count >= 2 ? snap.count : ''}</span>
    </span>
  );
}
/* 订阅状态的徽记 */
export function Badge({ size }: { size: number }) {
  return <BadgeView size={size} snap={useStatus()} />;
}
/* 调用工具时显示的工具名（等宽 12px，闪烁） */
export function ToolName() {
  const snap = useStatus();
  return <span className="badge-tool">{snap.state === 'tool' ? snap.tool || '' : ''}</span>;
}
