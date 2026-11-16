import { Slider as BaseSlider } from '@base-ui/react/slider';
import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { cx } from '../controls/cx';
import { useFormConfig } from './config';
import type { FormSize } from './config';
import { numberFormat, sliderValueText } from './value-text';

/* 滑块 Slider：Base UI 的 Slider（拖把手、点轨道跳过去、键盘 ← → ↑ ↓ 走一步，PageUp / PageDown（或 Shift 加方向键）走一大步，Home、End 到最小最大，
   读屏的 slider 角色和 aria-valuenow 都是它给的）。单个把手。
   - value、defaultValue、onValueChange（给新的数）、onValueCommitted（松手、键盘走完时给）；min（0）、max（100）、step（1）、largeStep（10）；
   - 右边显示当前值（showValue，默认显示）：renderValue 自己决定怎么写（比如 0 写「永久」、别的写「30 天」），不给就是格式化好的数字（format 是 Intl.NumberFormat 的选项，默认不加千分位）加 unit；
     这段文字同时给读屏（aria-valuetext，字或数字才用；写的是别的就读格式化好的数字加 unit）；
   - 样子：粗一点的轨，填充和库的能量槽一家（强调色到点睛色的渐变），把手是一道竖条；
   - 一定要有名字：aria-label，或放在 FormField 里（group）由标签给。 */
export interface SliderProps {
  size?: FormSize;
  className?: string;
  value?: number;
  defaultValue?: number;
  onValueChange?: (value: number) => void;
  onValueCommitted?: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  largeStep?: number;
  format?: Intl.NumberFormatOptions;
  unit?: string;
  showValue?: boolean;
  renderValue?: (value: number) => ReactNode;
  disabled?: boolean;
  name?: string;
  'aria-label'?: string;
}

export function Slider({
  size,
  className,
  value,
  defaultValue,
  onValueChange,
  onValueCommitted,
  min = 0,
  max = 100,
  step = 1,
  largeStep = 10,
  format,
  unit,
  showValue = true,
  renderValue,
  disabled,
  name,
  'aria-label': ariaLabel,
}: SliderProps) {
  const cfg = useFormConfig({ size });
  const fmt = useMemo(() => numberFormat(format), [format]);
  const num = (v: number | readonly number[]) => (typeof v === 'number' ? v : (v[0] ?? min));
  return (
    <BaseSlider.Root
      className={cx('ll-slider', className)}
      data-size={cfg.size}
      value={value}
      defaultValue={value === undefined ? (defaultValue ?? min) : undefined}
      onValueChange={(v) => onValueChange?.(num(v))}
      onValueCommitted={(v) => onValueCommitted?.(num(v))}
      min={min}
      max={max}
      step={step}
      largeStep={largeStep}
      format={fmt}
      disabled={disabled}
      name={name}
    >
      <BaseSlider.Control className="ll-slider-ctl">
        <BaseSlider.Track className="ll-slider-track">
          <BaseSlider.Indicator className="ll-slider-fill" />
          <BaseSlider.Thumb
            className="ll-slider-thumb"
            aria-label={ariaLabel}
            getAriaValueText={(formatted, v) =>
              sliderValueText({ rendered: renderValue?.(v), formatted, unit })
            }
          />
        </BaseSlider.Track>
      </BaseSlider.Control>
      {showValue && (
        <BaseSlider.Value className="ll-slider-val">
          {(formatted, values) =>
            renderValue
              ? renderValue(values[0] ?? min)
              : `${formatted[0] ?? ''}${unit ? ` ${unit}` : ''}`
          }
        </BaseSlider.Value>
      )}
    </BaseSlider.Root>
  );
}
