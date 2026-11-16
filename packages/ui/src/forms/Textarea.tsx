import { Field } from '@base-ui/react/field';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { ChangeEventHandler, Ref, TextareaHTMLAttributes } from 'react';
import { cx } from '../controls/cx';
import { autosize, charCount, countLabel } from './autosize';
import { useFormConfig } from './config';
import type { FormSize } from './config';

/* 多行输入 Textarea：外壳同单行输入（.ll-input），里面是 <textarea>；接 Base UI 的 Field（用的是 Field.Control 渲染成 textarea）。
   - 随内容长高：minRows（默认 3）到 maxRows（默认 8）之间，内容再多就停在上限、里面滚（滚动条用库的细滚动条）；autosize 关掉就是固定高度（minRows 行）、里面滚；
     量高度、夹上下限的算法在 autosize.ts（纯函数）；宽度变了（窗口拉宽、拉窄）折行变了会重新量；
   - count：右下角显示字数（给了 maxLength 就写「12 / 200」，没给只写数字）；超出 maxLength 的输入被浏览器挡住，所以字数不会超；
   - 不能手动拖大小（resize 关掉：高度由内容定）。
   其余属性（value、defaultValue、onChange、placeholder、disabled、readOnly、name、required、maxLength……）原样给 <textarea>。 */
export type TextareaProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'size' | 'rows'> & {
  size?: FormSize;
  className?: string;
  minRows?: number;
  maxRows?: number;
  autosize?: boolean;
  count?: boolean;
  invalid?: boolean;
  ref?: Ref<HTMLTextAreaElement>;
};

export function Textarea({
  size,
  className,
  minRows = 3,
  maxRows = 8,
  autosize: auto = true,
  count,
  invalid,
  ref,
  value,
  defaultValue,
  onChange,
  maxLength,
  ...rest
}: TextareaProps) {
  const cfg = useFormConfig({ size });
  const el = useRef<HTMLTextAreaElement | null>(null);
  const [inner, setInner] = useState(String(defaultValue ?? ''));
  const text = value === undefined ? inner : String(value);
  const setRefs = useCallback(
    (node: HTMLElement | null) => {
      el.current = node as HTMLTextAreaElement | null;
      if (typeof ref === 'function') ref(node as HTMLTextAreaElement | null);
      else if (ref) ref.current = node as HTMLTextAreaElement | null;
    },
    [ref],
  );
  /* 量一次、设一次高度 */
  const fit = useCallback(() => {
    const t = el.current;
    if (!t) return;
    const cs = getComputedStyle(t);
    const fontSize = parseFloat(cs.fontSize) || 12;
    const lineHeight = parseFloat(cs.lineHeight) || fontSize * 1.5;
    const padding = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    t.style.height = 'auto';
    const { height, overflow } = autosize({
      scrollHeight: t.scrollHeight,
      lineHeight,
      padding,
      minRows,
      maxRows: auto ? maxRows : minRows,
    });
    t.style.height = `${height}px`;
    t.style.overflowY = overflow ? 'auto' : 'hidden';
  }, [auto, minRows, maxRows]);
  useLayoutEffect(fit, [fit, text, cfg.size, count]);
  /* 宽度变了折行跟着变：只在宽度真的变了时重新量（自己改高度不会触发，免得循环） */
  useLayoutEffect(() => {
    const t = el.current;
    if (!t || typeof ResizeObserver === 'undefined') return;
    let w = t.clientWidth;
    const ro = new ResizeObserver(() => {
      if (t.clientWidth !== w) {
        w = t.clientWidth;
        fit();
      }
    });
    ro.observe(t);
    return () => ro.disconnect();
  }, [fit]);
  return (
    <span
      className={cx('ll-input', className)}
      data-multiline=""
      data-size={cfg.size}
      data-invalid={invalid ? '' : undefined}
      data-count={count ? '' : undefined}
    >
      <Field.Control
        ref={setRefs}
        render={<textarea rows={1} />}
        className={cx('ll-input-el ll-scrollbar')}
        value={text}
        maxLength={maxLength}
        aria-invalid={invalid ? true : undefined}
        onValueChange={(v) => {
          if (value === undefined) setInner(v);
        }}
        onChange={onChange as unknown as ChangeEventHandler<HTMLInputElement>}
        {...(rest as object)}
      />
      {count && (
        <span className="ll-input-count" aria-hidden="true">
          {countLabel(charCount(text), maxLength)}
        </span>
      )}
    </span>
  );
}
