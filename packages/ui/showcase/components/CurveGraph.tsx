import type { Bezier } from '../../src/easing';

/* 一条 cubic-bezier 曲线的图：横轴是时间、纵轴是进度；虚线是匀速，细线连着两个控制点。超出 0～1 的（回弹）也画得出来 */
export function CurveGraph({ bezier, size = 132 }: { bezier: Bezier | null; size?: number }) {
  if (!bezier)
    return (
      <div className="sc-graph is-empty" style={{ width: size, height: size }}>
        读不出曲线
      </div>
    );
  const [x1, y1, x2, y2] = bezier;
  const pad = 16;
  const X = (x: number) => pad + x * (size - 2 * pad);
  const Y = (y: number) => size - pad - y * (size - 2 * pad);
  return (
    <svg
      className="sc-graph"
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={`曲线 cubic-bezier(${bezier.join(', ')})`}
    >
      <rect className="sc-graph-box" x={X(0)} y={Y(1)} width={X(1) - X(0)} height={Y(0) - Y(1)} />
      <line className="sc-graph-lin" x1={X(0)} y1={Y(0)} x2={X(1)} y2={Y(1)} />
      <line className="sc-graph-handle" x1={X(0)} y1={Y(0)} x2={X(x1)} y2={Y(y1)} />
      <line className="sc-graph-handle" x1={X(1)} y1={Y(1)} x2={X(x2)} y2={Y(y2)} />
      <path
        className="sc-graph-curve"
        d={`M${X(0)} ${Y(0)} C${X(x1)} ${Y(y1)} ${X(x2)} ${Y(y2)} ${X(1)} ${Y(1)}`}
      />
      <circle className="sc-graph-pt" cx={X(x1)} cy={Y(y1)} r="3" />
      <circle className="sc-graph-pt" cx={X(x2)} cy={Y(y2)} r="3" />
    </svg>
  );
}
