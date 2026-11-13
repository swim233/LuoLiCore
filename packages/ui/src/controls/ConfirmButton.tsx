import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Button } from './Button';
import type { ButtonProps } from './Button';

export interface ConfirmButtonProps extends Omit<ButtonProps, 'onClick' | 'pressed'> {
  /** 第二次点（确认）时调用 */
  onConfirm: () => void;
  /** 等待确认时按钮上的字（默认是「再点一次」） */
  armedLabel?: ReactNode;
  /** 等待确认多久（毫秒，默认 3000），过了就恢复 */
  timeout?: number;
}

/* 两步确认的按钮：第一次点，变成等待确认的样子（danger，加 data-armed），字换成 armedLabel；
   timeout 内再点才调用 onConfirm；超时、点了别处、焦点离开，按钮都恢复原样。样式是按钮的 danger 加 [data-armed]。 */
export function ConfirmButton({
  onConfirm,
  armedLabel = '再点一次',
  timeout = 3000,
  variant,
  children,
  onBlur,
  ref,
  ...rest
}: ConfirmButtonProps) {
  const [armed, setArmed] = useState(false);
  const own = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), timeout);
    const away = (e: PointerEvent) => {
      if (!own.current?.contains(e.target as Node)) setArmed(false);
    };
    document.addEventListener('pointerdown', away, true);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('pointerdown', away, true);
    };
  }, [armed, timeout]);
  /* 合并外面传进来的 ref：函数要稳定（依赖 ref），不然每次渲染都是新的函数，React 会先传 null 再传元素 */
  const setRefs = useCallback(
    (el: HTMLButtonElement | null) => {
      own.current = el;
      if (typeof ref === 'function') ref(el);
      else if (ref) ref.current = el;
    },
    [ref],
  );
  return (
    <Button
      {...rest}
      ref={setRefs}
      variant={armed ? 'danger' : variant}
      data-armed={armed ? '' : undefined}
      onBlur={(e) => {
        setArmed(false);
        onBlur?.(e);
      }}
      onClick={() => {
        if (!armed) {
          setArmed(true);
          return;
        }
        setArmed(false);
        onConfirm();
      }}
    >
      {armed ? armedLabel : children}
    </Button>
  );
}
