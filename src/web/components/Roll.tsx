import { useEffect, useRef } from 'react';
import { animate } from 'motion';
import { motionOn } from '../lib/prefs';
import { clamp, nf } from '../lib/util';

/* 滚动数字：从旧值到新值 900 ms，先快后慢，滚动期间变 --gold-pale，结束后 .5 秒还原；动画关掉时直接跳到新值 */
export function Roll({ value, fmt = nf }: { value: number; fmt?: (n: number) => string }) {
  const el = useRef<HTMLSpanElement>(null);
  const cur = useRef(value);
  const first = useRef(true);
  useEffect(() => {
    const node = el.current!;
    if (first.current) {
      first.current = false;
      node.textContent = fmt(value);
      cur.current = value;
      return;
    }
    const from = cur.current;
    if (value === from) return;
    if (!motionOn()) {
      cur.current = value;
      node.textContent = fmt(value);
      return;
    }
    node.classList.add('is-up');
    let off: ReturnType<typeof setTimeout>;
    const a = animate(0, 1, {
      duration: 0.9,
      ease: (t: number) => 1 - Math.pow(1 - t, 3),
      onUpdate: (k: number) => {
        cur.current = from + (value - from) * k;
        node.textContent = fmt(cur.current);
      },
      onComplete: () => {
        cur.current = value;
        node.textContent = fmt(value);
        off = setTimeout(() => node.classList.remove('is-up'), 500);
      },
    });
    return () => {
      a.stop();
      clearTimeout(off);
    };
  }, [value]);
  return (
    <span className="roll" ref={el}>
      {fmt(0)}
    </span>
  );
}

/* 能量槽：宽度过渡 .9 秒；数值增加时一道白光从左扫到右 */
export function Energy({
  value,
  bad = false,
  label = '',
}: {
  value: number;
  bad?: boolean;
  label?: string;
}) {
  const shine = useRef<HTMLDivElement>(null);
  const prev = useRef(-1);
  const f = clamp(value || 0, 0, 1);
  useEffect(() => {
    const up = f > prev.current && prev.current >= 0;
    prev.current = f;
    const s = shine.current;
    if (up && s) {
      s.classList.remove('run');
      void s.offsetWidth;
      s.classList.add('run');
    }
  }, [f]);
  return (
    <div
      className={'energy' + (bad ? ' is-bad' : '')}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(f * 100)}
      aria-label={label}
    >
      <div className="energy-fill" style={{ width: (f * 100).toFixed(2) + '%' }} />
      <div className="energy-ticks" />
      <div className="energy-shine" ref={shine} />
    </div>
  );
}
