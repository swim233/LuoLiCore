import type { CSSProperties, ReactNode } from 'react';

/* 舞台：对比块、示例的底。page 是页面底（--ll-bg），sky 是库的夜空窗口的底（.ll-sky：压暗层、星点、两团光，加盖在上面的暗边 .ll-sky-vig）。
   星点由 main.tsx 启动时调 startSkyStars() 画好。舞台自己的圆角、不要外阴影写在 showcase.css 里 */
export type StageKind = 'page' | 'sky';

export function Stage({
  kind = 'sky',
  className = '',
  style,
  children,
}: {
  kind?: StageKind;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <div
      className={`sc-stage is-${kind} ${kind === 'sky' ? 'll-sky' : ''} ${className}`}
      data-stage={kind}
      style={style}
    >
      {children}
      {kind === 'sky' && <i className="ll-sky-vig" aria-hidden="true" />}
    </div>
  );
}
