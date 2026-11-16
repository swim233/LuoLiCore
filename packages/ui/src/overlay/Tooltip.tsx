import { Tooltip as BaseTooltip } from '@base-ui/react/tooltip';
import type { ReactElement, ReactNode } from 'react';
import { cx } from '../controls/cx';

/* 提示气泡：Base UI 的 Tooltip 打底（悬停和键盘焦点都能出、Esc 关、触屏上关闭都是它给的），这里只加类名和样子。
   - 它只是视觉上的补充说明：触屏上不出，读屏也念不到；触发的元素要自己带 aria-label（和气泡里的字对得上），重要的信息别只放在气泡里；
   - TooltipProvider：一个应用放一次（放在根上）。delay 默认 500 毫秒；timeout 是「一个刚关、这么久以内移到下一个就立即出现」（Base UI 默认 400）；
   - Tooltip：简单用法 <Tooltip content="缩小到胶囊"><IconButton aria-label="缩小到胶囊" … /></Tooltip>。触发的元素就是那个子元素（不多包一层，
     用的是 Base UI 的 render）；
     side 默认 top、sideOffset 6；鼠标移不进气泡（它只是说明，disableHoverablePopup）；container 同别的浮层；
   - 没有 Provider 也能用，这时延迟是 Base UI 默认的 600 毫秒，每个单独算。
   样子见 tooltip.css。入口加载时不碰 DOM。 */
export interface TooltipProviderProps {
  /** 悬停多久后出现（毫秒），默认 500 */
  delay?: number;
  /** 关闭前等多久（毫秒） */
  closeDelay?: number;
  /** 一个刚关，这么久以内移到下一个就立即出现（毫秒，Base UI 默认 400） */
  timeout?: number;
  children?: ReactNode;
}
export function TooltipProvider({
  delay = 500,
  closeDelay,
  timeout,
  children,
}: TooltipProviderProps) {
  return (
    <BaseTooltip.Provider delay={delay} closeDelay={closeDelay} timeout={timeout}>
      {children}
    </BaseTooltip.Provider>
  );
}

export interface TooltipProps
  extends
    Pick<
      BaseTooltip.Positioner.Props,
      | 'side'
      | 'align'
      | 'sideOffset'
      | 'alignOffset'
      | 'collisionPadding'
      | 'collisionAvoidance'
      | 'anchor'
    >,
    Pick<BaseTooltip.Portal.Props, 'container'> {
  /** 气泡里的字 */
  content: ReactNode;
  /** 触发的元素：一个 React 元素，它自己就是触发的按钮 */
  children: ReactElement;
  /** 不出气泡（比如被截断的文字其实没被截断时） */
  disabled?: boolean;
  /** 单独改这一个的悬停延迟（毫秒） */
  delay?: number;
  closeDelay?: number;
  className?: string;
}

export function Tooltip({
  content,
  children,
  disabled,
  delay,
  closeDelay,
  side = 'top',
  align,
  sideOffset = 6,
  alignOffset,
  collisionPadding = 8,
  collisionAvoidance,
  anchor,
  container,
  className,
}: TooltipProps) {
  return (
    <BaseTooltip.Root disabled={disabled} disableHoverablePopup>
      <BaseTooltip.Trigger render={children} delay={delay} closeDelay={closeDelay} />
      <BaseTooltip.Portal container={container}>
        <BaseTooltip.Positioner
          className="ll-tip-pos"
          side={side}
          align={align}
          sideOffset={sideOffset}
          alignOffset={alignOffset}
          collisionPadding={collisionPadding}
          collisionAvoidance={collisionAvoidance}
          anchor={anchor}
        >
          <BaseTooltip.Popup className={cx('ll-tip', className)}>{content}</BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}
