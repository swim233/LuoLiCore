import { Checkbox as BaseCheckbox } from '@base-ui/react/checkbox';
import { CheckboxGroup as BaseCheckboxGroup } from '@base-ui/react/checkbox-group';
import { Radio as BaseRadio } from '@base-ui/react/radio';
import { RadioGroup as BaseRadioGroup } from '@base-ui/react/radio-group';
import type { ReactNode } from 'react';
import { cx } from '../controls/cx';
import { IconCheck, IconMinus } from '../icons';
import { FormConfig, useFormConfig } from './config';
import type { FormSize } from './config';

/* 复选框 Checkbox、复选组 CheckboxGroup、单选 Radio、单选组 RadioGroup：Base UI 的 Checkbox、Radio（空格键切换、方向键在单选之间走、
   读屏的 checkbox / radio 角色、接 Field 和表单提交都是它给的），样子自己画（choice.css）。
   - 一个选项是一个 <label>：框加文字（children），点文字也能切换；框 16×16（sm 14、lg 18），复选框圆角 4，单选是圆；
   - 复选框有半选：indeterminate 属性（用在「全选」那一个上：CheckboxGroup 的 allValues 加这个复选框的 parent，Base UI 会自己算勾选、半选）；
   - 选中的样子：强调色实心，里面的勾（点）是深色；
   - 组：CheckboxGroup（value 是选中的 value 数组）、RadioGroup（value 是选中的那个）。orientation 是 column（默认，一个一行）或 row（排成一行、放不下折行）；
     组上的 size 一次设给里面所有的选项。放在 FormField 里时给 FormField 加 group，标签就是这一组的名字。 */
type Orientation = 'column' | 'row';

export type CheckboxProps = Omit<BaseCheckbox.Root.Props, 'className' | 'children' | 'render'> & {
  size?: FormSize;
  className?: string;
  /** 框右边的文字 */
  children?: ReactNode;
};

export function Checkbox({ size, className, children, ...rest }: CheckboxProps) {
  const cfg = useFormConfig({ size });
  return (
    <label className={cx('ll-check', className)} data-size={cfg.size}>
      <BaseCheckbox.Root className="ll-check-box" {...rest}>
        <BaseCheckbox.Indicator className="ll-check-mark" keepMounted>
          <IconCheck className="ll-check-tick" />
          <IconMinus className="ll-check-dash" />
        </BaseCheckbox.Indicator>
      </BaseCheckbox.Root>
      {children != null && <span className="ll-check-label">{children}</span>}
    </label>
  );
}

export type CheckboxGroupProps = Omit<BaseCheckboxGroup.Props, 'className'> & {
  size?: FormSize;
  orientation?: Orientation;
  className?: string;
};
export function CheckboxGroup({ size, orientation, className, ...rest }: CheckboxGroupProps) {
  return (
    <FormConfig size={size}>
      <BaseCheckboxGroup
        className={cx('ll-choice-group', className)}
        data-orientation={orientation}
        {...rest}
      />
    </FormConfig>
  );
}

export type RadioProps = Omit<BaseRadio.Root.Props<string>, 'className' | 'children' | 'render'> & {
  size?: FormSize;
  className?: string;
  children?: ReactNode;
};

export function Radio({ size, className, children, ...rest }: RadioProps) {
  const cfg = useFormConfig({ size });
  return (
    <label className={cx('ll-check ll-radio', className)} data-size={cfg.size}>
      <BaseRadio.Root className="ll-check-box" {...rest}>
        <BaseRadio.Indicator className="ll-check-mark" keepMounted>
          <span className="ll-radio-dot" />
        </BaseRadio.Indicator>
      </BaseRadio.Root>
      {children != null && <span className="ll-check-label">{children}</span>}
    </label>
  );
}

export type RadioGroupProps = Omit<BaseRadioGroup.Props<string>, 'className'> & {
  size?: FormSize;
  orientation?: Orientation;
  className?: string;
};
export function RadioGroup({ size, orientation, className, ...rest }: RadioGroupProps) {
  return (
    <FormConfig size={size}>
      <BaseRadioGroup
        className={cx('ll-choice-group', className)}
        data-orientation={orientation}
        {...rest}
      />
    </FormConfig>
  );
}
