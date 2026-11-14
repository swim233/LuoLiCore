import type { AnchorHTMLAttributes, MouseEvent, PointerEvent } from 'react';
import { cx } from './cx';

export interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  /** 地址：必须是 @luoli/ui/url 的 linkHref 认过的（只有 http、https），调用的地方负责 */
  href: string;
  /** 不写是写出来的链接；auto 是自动认出来的网址（下划线是虚线） */
  variant?: 'auto';
}

/* 链接：在新标签页打开（rel 带 noopener noreferrer）、悬停显示地址（title）。
   点它、按下它、双击它都不会顺带触发外面的点击（会话列表打开会话、整理模式拖动部件……），所以这三个事件在这里停止冒泡，
   用的地方不用再管。用的地方自己传了 onClick、onPointerDown、onDoubleClick 也照常调（先调它的，再停止冒泡），不会被顶掉。
   还不能点的（比如逐字输出时还没写完的链接）不要用它，写成 <span className="ll-link">。样式见 controls/link.css */
export function Link({
  href,
  variant,
  className,
  onClick,
  onPointerDown,
  onDoubleClick,
  ...rest
}: LinkProps) {
  return (
    <a
      className={cx('ll-link', className)}
      data-variant={variant}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={href}
      {...rest}
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(e);
        e.stopPropagation();
      }}
      onPointerDown={(e: PointerEvent<HTMLAnchorElement>) => {
        onPointerDown?.(e);
        e.stopPropagation();
      }}
      onDoubleClick={(e: MouseEvent<HTMLAnchorElement>) => {
        onDoubleClick?.(e);
        e.stopPropagation();
      }}
    />
  );
}
