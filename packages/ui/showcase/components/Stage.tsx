import type { CSSProperties, ReactNode } from 'react';

/* 舞台：对比块、示例的底。page 是页面底（--ll-bg），sky 是夜空窗口的底（--ll-sky-bg 加四周的暗边）。
   星点贴图现在还在面板里，所以夜空窗口里只有压暗层和两团光；以后星空进了库，在这里垫上就行 */
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
    <div className={`sc-stage is-${kind} ${className}`} data-stage={kind} style={style}>
      {children}
    </div>
  );
}
