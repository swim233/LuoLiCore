import { Input as BaseInput } from '@base-ui/react/input';
import { useCallback, useRef, useState } from 'react';
import type { MouseEvent, ReactNode, Ref } from 'react';
import { cx } from '../controls/cx';
import { IconEye, IconEyeOff, IconX } from '../icons';
import { useFormConfig } from './config';
import type { FormSize } from './config';

/* 单行输入 Input：Base UI 的 Input（接 Field：校验、出错状态、aria-describedby 都是它给的）加一层「槽」的外壳（.ll-input，样子见 input.css）。
   - leading、trailing：输入框前后的位置，放图标、单位（「秒」）、小按钮；点这两处（不是按钮）也会聚焦输入框；
   - clearable：有字时右边出一个清除按钮（清掉以后焦点回到输入框，走的是真的 input 事件，所以 Field 的校验、脏状态照常）；
   - invalid：强制显示出错的样子（放在 FormField 里时由 Field 自己给，不用写）；
   - value / defaultValue / onValueChange 都认；onValueChange 只给新的字（不要 Base UI 的 details）。
   ref 接到里面的 <input>；className 是外壳的，inputClassName 是 <input> 的。其余属性（type、placeholder、disabled、readOnly、name、required、maxLength……）原样给 <input>。 */
export type InputProps = Omit<
  BaseInput.Props,
  'className' | 'size' | 'prefix' | 'value' | 'defaultValue' | 'onValueChange' | 'ref'
> & {
  size?: FormSize;
  className?: string;
  inputClassName?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
  clearable?: boolean;
  clearLabel?: string;
  invalid?: boolean;
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  ref?: Ref<HTMLInputElement>;
};

/** 清掉输入框里的字：走原生的 value 写入加 input 事件，React（和 Base UI 的 Field）当成用户清掉的 */
function clearInput(el: HTMLInputElement) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  set?.call(el, '');
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.focus();
}

export function Input({
  size,
  className,
  inputClassName,
  leading,
  trailing,
  clearable,
  clearLabel = '清除',
  invalid,
  value: valueProp,
  defaultValue,
  onValueChange,
  ref,
  disabled,
  readOnly,
  ...rest
}: InputProps) {
  const cfg = useFormConfig({ size });
  const [inner, setInner] = useState(defaultValue ?? '');
  const value = valueProp ?? inner;
  const el = useRef<HTMLInputElement | null>(null);
  const setRefs = useCallback(
    (node: HTMLElement | null) => {
      el.current = node as HTMLInputElement | null;
      if (typeof ref === 'function') ref(node as HTMLInputElement | null);
      else if (ref) ref.current = node as HTMLInputElement | null;
    },
    [ref],
  );
  /* 点外壳的空白处（前后的位置、内边距）：焦点给输入框；点在按钮、输入框自己上不管 */
  const focusInput = (e: MouseEvent<HTMLSpanElement>) => {
    const t = e.target as HTMLElement;
    if (t === el.current || t.closest('button')) return;
    e.preventDefault();
    el.current?.focus();
  };
  const canClear = clearable && value !== '' && !disabled && !readOnly;
  return (
    <span
      className={cx('ll-input', className)}
      data-size={cfg.size}
      data-invalid={invalid ? '' : undefined}
      onMouseDown={focusInput}
    >
      {leading != null && <span className="ll-input-aff">{leading}</span>}
      <BaseInput
        ref={setRefs}
        className={cx('ll-input-el', inputClassName)}
        value={value}
        disabled={disabled}
        readOnly={readOnly}
        aria-invalid={invalid ? true : undefined}
        onValueChange={(v) => {
          if (valueProp === undefined) setInner(v);
          onValueChange?.(v);
        }}
        {...rest}
      />
      {canClear && (
        <button
          type="button"
          className="ll-input-btn"
          aria-label={clearLabel}
          onClick={() => el.current && clearInput(el.current)}
        >
          <IconX />
        </button>
      )}
      {trailing != null && <span className="ll-input-aff">{trailing}</span>}
    </span>
  );
}

/* 密码输入：Input 加右边的眼睛按钮（切换显示、隐藏）。按钮不抢输入框的焦点（鼠标点它时输入框保持聚焦，光标还在原处）；
   键盘用户 Tab 到它、按空格或回车切换，aria-pressed 说现在是不是显示着。其余属性同 Input（type 由它管，不用传） */
export type PasswordInputProps = Omit<InputProps, 'type'> & {
  showLabel?: string;
  hideLabel?: string;
};
export function PasswordInput({
  showLabel = '显示密码',
  hideLabel = '隐藏密码',
  trailing,
  ...rest
}: PasswordInputProps) {
  const [shown, setShown] = useState(false);
  return (
    <Input
      autoComplete="off"
      spellCheck={false}
      {...rest}
      type={shown ? 'text' : 'password'}
      trailing={
        <>
          <button
            type="button"
            className="ll-input-btn"
            aria-label={shown ? hideLabel : showLabel}
            aria-pressed={shown}
            disabled={rest.disabled}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setShown((s) => !s)}
          >
            {shown ? <IconEyeOff /> : <IconEye />}
          </button>
          {trailing}
        </>
      }
    />
  );
}
