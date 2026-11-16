import { NumberField } from '@base-ui/react/number-field';
import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { cx } from '../controls/cx';
import { IconGrip, IconMinus, IconPlus } from '../icons';
import { useFormConfig } from './config';
import type { FormSize } from './config';
import { numberFormat } from './value-text';

/* 数字输入 NumberInput：Base UI 的 NumberField（键盘 ↑ ↓、Shift 一次加大步、Alt 小步、Home/End 到最小最大、
   输入时按 min、max 夹住、接 Field 的校验）加槽的外壳。两头各一个加减钮（减在左、加在右，数字居中）。
   - min、max、step（默认 1）、smallStep、largeStep、format（Intl.NumberFormat 的选项，默认不加千分位：useGrouping: false，要的话自己写 useGrouping: true）、locale；
   - unit：数字后面的单位（「秒」）；
   - 拖动改值（scrub）默认关：scrub 打开后，单位（没有单位时一个把手）成了拖动区，按住左右拖就改值，鼠标指针换成两个箭头；
   - 滚轮改值（wheel）默认关（页面一滚、数字就改了，容易误改）：wheel 打开后，输入框聚焦时滚轮才改。
   value 是 number 或 null（空）；onValueChange 只给新的值。其余属性（disabled、readOnly、required、name、placeholder……）见 Base UI。 */
export interface NumberInputProps {
  size?: FormSize;
  className?: string;
  value?: number | null;
  defaultValue?: number;
  onValueChange?: (value: number | null) => void;
  min?: number;
  max?: number;
  step?: number;
  smallStep?: number;
  largeStep?: number;
  format?: Intl.NumberFormatOptions;
  locale?: Intl.LocalesArgument;
  unit?: ReactNode;
  scrub?: boolean;
  wheel?: boolean;
  placeholder?: string;
  invalid?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  required?: boolean;
  name?: string;
  id?: string;
  'aria-label'?: string;
  incrementLabel?: string;
  decrementLabel?: string;
}

export function NumberInput({
  size,
  className,
  value,
  defaultValue,
  onValueChange,
  min,
  max,
  step,
  smallStep,
  largeStep,
  format,
  locale,
  unit,
  scrub,
  wheel,
  placeholder,
  invalid,
  disabled,
  readOnly,
  required,
  name,
  id,
  'aria-label': ariaLabel,
  incrementLabel = '增加',
  decrementLabel = '减少',
}: NumberInputProps) {
  const cfg = useFormConfig({ size });
  const fmt = useMemo(() => numberFormat(format), [format]);
  return (
    <NumberField.Root
      className={cx('ll-num', className)}
      data-size={cfg.size}
      value={value}
      defaultValue={defaultValue}
      onValueChange={(v) => onValueChange?.(v)}
      min={min}
      max={max}
      step={step}
      smallStep={smallStep}
      largeStep={largeStep}
      format={fmt}
      locale={locale}
      allowWheelScrub={wheel ?? false}
      disabled={disabled}
      readOnly={readOnly}
      required={required}
      name={name}
      id={id}
    >
      <NumberField.Group
        className="ll-input"
        data-invalid={invalid ? '' : undefined}
        data-size={cfg.size}
      >
        <NumberField.Decrement className="ll-num-btn" aria-label={decrementLabel}>
          <IconMinus />
        </NumberField.Decrement>
        <NumberField.Input
          className="ll-input-el"
          placeholder={placeholder}
          aria-label={ariaLabel}
          aria-invalid={invalid ? true : undefined}
        />
        {scrub ? (
          <NumberField.ScrubArea className="ll-input-aff ll-num-scrub">
            {unit ?? <IconGrip />}
            <NumberField.ScrubAreaCursor className="ll-num-cursor">
              <IconGrip />
            </NumberField.ScrubAreaCursor>
          </NumberField.ScrubArea>
        ) : (
          unit != null && <span className="ll-input-aff">{unit}</span>
        )}
        <NumberField.Increment className="ll-num-btn" aria-label={incrementLabel}>
          <IconPlus />
        </NumberField.Increment>
      </NumberField.Group>
    </NumberField.Root>
  );
}
