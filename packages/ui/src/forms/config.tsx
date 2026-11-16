import { createContext, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';

/* 表单控件共用的配置：一处设，下面所有的表单控件都照这个来（控件自己也能单独指定 size）。
   - size：控件的尺寸，sm 高 22、md 高 28、lg 高 32（默认），和库的按钮同档；表单里默认用 lg（高 32、字 13），
     要和 28 高的按钮放一排就整排都写 md；
   - layout：表单项的排法，不写是竖排（标签在上），row 是横排（标签在左）。 */
export type FormSize = 'sm' | 'md' | 'lg';
export type FormLayout = 'row';

export interface FormConfigValue {
  size?: FormSize;
  layout?: FormLayout;
}

/** 配置补全以后的样子：除了 layout（竖排就是没有）都有值 */
export interface ResolvedFormConfig {
  size: FormSize;
  layout: FormLayout | undefined;
}

export const DEFAULT_FORM_CONFIG: ResolvedFormConfig = {
  size: 'lg',
  layout: undefined,
};

/** 把几层配置叠起来：后面的覆盖前面的，值是 undefined 的不覆盖；最后用默认值补全 */
export function resolveFormConfig(...layers: (FormConfigValue | undefined)[]): ResolvedFormConfig {
  const out: ResolvedFormConfig = { ...DEFAULT_FORM_CONFIG };
  for (const layer of layers) {
    if (!layer) continue;
    if (layer.size !== undefined) out.size = layer.size;
    if (layer.layout !== undefined) out.layout = layer.layout;
  }
  return out;
}

const FormConfigCtx = createContext<FormConfigValue>({});

/** 给下面的表单控件设配置；可以嵌套，里层的覆盖外层的 */
export function FormConfig({ children, size, layout }: FormConfigValue & { children?: ReactNode }) {
  const parent = useContext(FormConfigCtx);
  const merged = useMemo<FormConfigValue>(
    () => ({
      ...parent,
      ...(size !== undefined && { size }),
      ...(layout !== undefined && { layout }),
    }),
    [parent, size, layout],
  );
  return <FormConfigCtx.Provider value={merged}>{children}</FormConfigCtx.Provider>;
}

/** 控件读配置：自己传的（own）盖过外面设的，再用默认值补全 */
export function useFormConfig(own?: FormConfigValue): ResolvedFormConfig {
  const ctx = useContext(FormConfigCtx);
  return resolveFormConfig(ctx, own);
}
