import { useEffect, useRef } from 'react';
import type { HTMLAttributes } from 'react';
import { runRoll } from '../../src/controls/roll-anim';
import { motionOn } from '../../src/motion';
import { clamp, nf } from '../../src/util';
import type { RollNode } from '../../src/controls/roll-anim';

/* 面板里 components/Roll.tsx 的旧写法，原样抄一份（样式在 step5.css，类名是 roll、is-up、energy……）。b 段结束时和 step5.css 一起删掉。
   差别只有两处，都不影响样子：滚动的计时用库的 runRoll（面板原来用 Motion 的 animate，曲线、时长一样）；滚动期间的类 is-up 由下面的小转接写。 */

/** 把 runRoll 里写的 data-rolling 转成旧的 is-up 类 */
const asLegacy = (el: HTMLElement): RollNode => ({
  get textContent() {
    return el.textContent;
  },
  set textContent(v) {
    el.textContent = v;
  },
  setAttribute: () => el.classList.add('is-up'),
  removeAttribute: () => el.classList.remove('is-up'),
});

export function LegacyRoll({
  value,
  fmt = nf,
  ...rest
}: { value: number; fmt?: (n: number) => string } & Omit<
  HTMLAttributes<HTMLSpanElement>,
  'children'
>) {
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
    return runRoll(asLegacy(node), from, value, fmt, (n) => {
      cur.current = n;
    });
  }, [value]);
  return (
    <span className="roll" ref={el} {...rest}>
      {fmt(0)}
    </span>
  );
}

export function LegacyEnergy({
  value,
  bad = false,
  label = '',
  ...rest
}: { value: number; bad?: boolean; label?: string } & Omit<
  HTMLAttributes<HTMLDivElement>,
  'children'
>) {
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
      {...rest}
    >
      <div className="energy-fill" style={{ width: (f * 100).toFixed(2) + '%' }} />
      <div className="energy-ticks" />
      <div className="energy-shine" ref={shine} />
    </div>
  );
}
