import { Field } from '@base-ui/react/field';
import { Form as BaseForm } from '@base-ui/react/form';
import { useId } from 'react';
import type { FormHTMLAttributes, ReactNode } from 'react';
import { cx } from '../controls/cx';
import { IconAlert } from '../icons';
import { FormConfig, useFormConfig } from './config';
import type { FormConfigValue, FormLayout, FormSize } from './config';

/* 表单项 FormField：标签、控件、说明、错误信息摆在一起的壳，接 Base UI 的 Field（校验、出错状态、aria-describedby、
   点标签聚焦控件都是它给的）。库里另有 controls/Field（只管摆放、不接校验）；这个版本的样子沿用 .ll-field（标签 --ll-text-sm、--ll-fg-3，说明同色），
   多了出错的样子和横排的格子。
   - label：标签；required 时标签后面带一个红色的星号（只是看的，读屏靠控件自己的 required）；
   - description：说明，竖排时写在控件下面，横排时写在标签下面（小一号、更淡）；
   - layout：不写跟 FormConfig 的（竖排：标签在上）；row 横排：标签（带说明）在左、控件在右；
   - 控件放在 children 里：Input、PasswordInput、NumberInput、Textarea、Select、Slider 直接放，它们自己接 Field；
     一组复选框、单选这种「一组」的控件加 group：标签变成一组控件的名字（role=group、aria-labelledby 指到它）；
     Select 的钮不是 <input>，点标签不能「聚焦」它，所以标签不用 <label>：nativeLabel={false}（group 时自动不用）；
   - 校验：validate（返回错误文字，没问题返回 null）、validationMode（onBlur 默认、onChange、onSubmit）、invalid（外面强制）；
     放在 <Form> 里时提交会校验所有的项，把没填的、填错的标出来，焦点给第一个出错的；
   - 出错的样子：控件的细线变红、底带一点红（在各控件的样式里），下面一行红字，字前面带一个警告图标。 */
export interface FormFieldProps {
  name?: string;
  label: ReactNode;
  description?: ReactNode;
  layout?: FormLayout;
  size?: FormSize;
  required?: boolean;
  invalid?: boolean;
  /** 外面给的错误文字（比如服务端返回的）：给了就是出错状态、显示这句；不给就用校验（validate、控件自己的 required、min 等）算出来的 */
  error?: ReactNode;
  disabled?: boolean;
  validate?: Field.Root.Props['validate'];
  validationMode?: Field.Root.Props['validationMode'];
  group?: boolean;
  nativeLabel?: boolean;
  className?: string;
  children?: ReactNode;
}

export function FormField({
  name,
  label,
  description,
  layout,
  size,
  required,
  invalid,
  error,
  disabled,
  validate,
  validationMode,
  group,
  nativeLabel,
  className,
  children,
}: FormFieldProps) {
  const cfg = useFormConfig({ layout, size });
  const labelId = useId();
  const asLabel = nativeLabel ?? !group;
  return (
    <div className="ll-form-box">
      <Field.Root
        name={name}
        invalid={invalid ?? (error != null ? true : undefined)}
        disabled={disabled}
        validate={validate}
        validationMode={validationMode}
        className={cx('ll-form-field', className)}
        data-layout={cfg.layout}
        data-size={cfg.size}
      >
        <Field.Label
          id={group ? labelId : undefined}
          className="ll-form-label"
          nativeLabel={asLabel}
          render={asLabel ? undefined : <span />}
        >
          {label}
          {required && (
            <span className="ll-form-req" aria-hidden="true">
              *
            </span>
          )}
        </Field.Label>
        <div
          className="ll-form-ctl"
          role={group ? 'group' : undefined}
          aria-labelledby={group ? labelId : undefined}
        >
          {children}
        </div>
        {description != null && (
          <Field.Description className="ll-form-desc">{description}</Field.Description>
        )}
        <Field.Error
          className="ll-form-err"
          match={error != null ? true : undefined}
          render={(props) => (
            <div {...props}>
              <IconAlert className="ll-form-err-ic" />
              <span>{error ?? props.children}</span>
            </div>
          )}
        />
      </Field.Root>
    </div>
  );
}

/* 表单 Form：Base UI 的 Form（<form>，提交时校验里面所有的 FormField，没填的、填错的标出来，焦点给第一个出错的；通过了调 onFormSubmit）。
   同时把 FormConfig（size、layout）设给里面所有的控件。errors 可以由外面（服务端）按 name 塞错误文字进来。 */
export type FormProps = Omit<FormHTMLAttributes<HTMLFormElement>, 'onSubmit'> &
  FormConfigValue & {
    errors?: BaseForm.Props['errors'];
    onFormSubmit?: BaseForm.Props['onFormSubmit'];
    validationMode?: BaseForm.Props['validationMode'];
  };

export function Form({ size, layout, className, ...rest }: FormProps) {
  return (
    <FormConfig size={size} layout={layout}>
      <BaseForm className={cx('ll-form', className)} {...rest} />
    </FormConfig>
  );
}
