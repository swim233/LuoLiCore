import type { ReactNode, SyntheticEvent } from 'react';

/* 消息里的链接：在新标签页打开；点它不会顺带触发外面的点击（会话列表打开会话、整理模式拖动部件……）。
   href 必须是 lib/url.ts 的 linkHref 认过的地址，调用的地方负责 */
const stop = (e: SyntheticEvent) => e.stopPropagation();
export function Link({
  href,
  className,
  children,
}: {
  href: string;
  className: string;
  children: ReactNode;
}) {
  return (
    <a
      className={className}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={href}
      onClick={stop}
      onPointerDown={stop}
      onDoubleClick={stop}
    >
      {children}
    </a>
  );
}
