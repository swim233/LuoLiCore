/* 数字输入、滑块里和「数字怎么写」有关的两个纯函数。 */

/** 数字输入、滑块默认不加千分位（端口 7310、超时 1200 秒都不该写成「7,310」「1,200」）；要千分位的自己在 format 里写 useGrouping: true */
export function numberFormat(format?: Intl.NumberFormatOptions): Intl.NumberFormatOptions {
  return { useGrouping: false, ...format };
}

/** 滑块给读屏的文字（aria-valuetext）：自己写的显示（renderValue，比如「永久」「30 天」）是字或数字就照它读；
    写的是别的（图标之类）就退回格式化好的数字加单位 */
export function sliderValueText(o: {
  rendered?: unknown;
  formatted: string;
  unit?: string;
}): string {
  if (typeof o.rendered === 'string' || typeof o.rendered === 'number') return String(o.rendered);
  return o.unit ? `${o.formatted} ${o.unit}` : o.formatted;
}
