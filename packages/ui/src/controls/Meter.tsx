import { useEffect, useRef } from 'react';
import type { HTMLAttributes } from 'react';
import { clamp } from '../util';
import { cx } from './cx';
import { NO_PREV, shouldShine } from './meter-shine';

export interface MeterProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  /** 0 到 1（超出的截到这个范围，不是数的当 0） */
  value: number;
  /** 色调：不写是强调色到点睛色的渐变；danger 是危险色 */
  tone?: 'danger';
  /** 念出来的名字（aria-label） */
  label?: string;
}

/* 能量槽：细的一条。宽度的变化是 CSS 的过渡（0.9 秒）；数值变大时给光的那一层写 data-run（先去掉、强制回流、再加上，重新扫一次），
   第一次渲染不扫；扫光是装饰性的动画，动画关掉时 CSS 不放。样式见 controls/meter.css */
export function Meter({ value, tone, label = '', className, ...rest }: MeterProps) {
  const shine = useRef<HTMLDivElement>(null);
  const prev = useRef(NO_PREV);
  const f = clamp(value || 0, 0, 1);
  useEffect(() => {
    const up = shouldShine(prev.current, f);
    prev.current = f;
    const s = shine.current;
    if (up && s) {
      s.removeAttribute('data-run');
      void s.offsetWidth;
      s.setAttribute('data-run', '');
    }
  }, [f]);
  return (
    <div
      className={cx('ll-meter', className)}
      data-tone={tone}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(f * 100)}
      aria-label={label}
      {...rest}
    >
      <div className="ll-meter-fill" style={{ width: (f * 100).toFixed(2) + '%' }} />
      <div className="ll-meter-shine" ref={shine} />
    </div>
  );
}
