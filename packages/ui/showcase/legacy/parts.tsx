import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { motionOn, useMotionOn } from '../../src/motion';

/* 面板里这一批控件的旧写法里用到的小零件，原样抄一份（样式在 controls.css）。4b 结束时和 controls.css 一起删掉。
   图标是 src/web/components/icons.tsx 里那几个；转圈是 components/Hl.tsx 里的 Spin。 */

const svg16 = {
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  'aria-hidden': true,
} as const;
export const LEGACY_ICON_MIN = (
  <svg {...svg16} strokeWidth={1.6} strokeLinecap="round">
    <path d="M3.5 8h9" />
  </svg>
);
export const LEGACY_ICON_MAX = (
  <svg {...svg16} strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round">
    <path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9" />
  </svg>
);
export const LEGACY_ICON_RESTORE = (
  <svg {...svg16} strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round">
    <path d="M13.5 6.5h-4v-4M2.5 9.5h4v4M9.5 6.5 14 2M6.5 9.5 2 14" />
  </svg>
);
export const LEGACY_ICON_ARRANGE = (
  <svg {...svg16} strokeWidth={1.4}>
    <rect x="1.5" y="1.5" width="5" height="5" rx="1.2" />
    <rect x="9.5" y="1.5" width="5" height="5" rx="1.2" />
    <rect x="1.5" y="9.5" width="5" height="5" rx="1.2" />
    <rect x="9.5" y="9.5" width="5" height="5" rx="1.2" />
  </svg>
);

/* 转圈的符号：一个计时器带动所有的转圈（Hl.tsx 的 Spin 原样） */
const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
const spinSet = new Set<HTMLElement>();
let spinI = 0;
let spinTimer: ReturnType<typeof setInterval> | 0 = 0;
const spinTick = () => {
  spinI = (spinI + 1) % SPIN.length;
  spinSet.forEach((el) => {
    if (!el.isConnected) spinSet.delete(el);
    else el.textContent = SPIN[spinI];
  });
  if (!spinSet.size && spinTimer) {
    clearInterval(spinTimer);
    spinTimer = 0;
  }
};
export function LegacySpin(props: {
  'data-probe'?: string;
  'data-item'?: string;
  'data-state'?: string;
}) {
  useMotionOn();
  return (
    <span
      className="spin"
      aria-hidden="true"
      {...props}
      ref={(el) => {
        if (!el) return;
        if (motionOn()) {
          el.textContent = SPIN[spinI];
          spinSet.add(el);
          if (!spinTimer) spinTimer = setInterval(spinTick, 80);
        } else el.textContent = '⋯';
      }}
    />
  );
}

/* 旧写法的开关：顶栏的动画开关（.tbtn.tswitch），点一下拨一下，和面板里一样 */
export function LegacySwitch({
  initial,
  label,
  ...rest
}: {
  initial: boolean;
  label: ReactNode;
  'data-probe'?: string;
  'data-item'?: string;
  'data-state'?: string;
  className?: string;
}) {
  const [on, setOn] = useState(initial);
  return (
    <button
      className="tbtn tswitch"
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => setOn(!on)}
      {...rest}
    >
      <span className="tswitch-track" aria-hidden="true" />
      <span className="tlabel">{label}</span>
    </button>
  );
}

/* 旧写法的两步确认（设置里的 ResetLayoutButton 原样，3 秒内再点才算，超时、点别处、焦点离开都恢复） */
export function LegacyConfirm({
  label,
  armedLabel,
  onConfirm,
  ...rest
}: {
  label: string;
  armedLabel: string;
  onConfirm: () => void;
  'data-probe'?: string;
  'data-item'?: string;
  'data-state'?: string;
}) {
  const [armed, setArmed] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 3000);
    const away = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setArmed(false);
    };
    document.addEventListener('pointerdown', away, true);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('pointerdown', away, true);
    };
  }, [armed]);
  return (
    <button
      ref={ref}
      className={'chip' + (armed ? ' is-armed' : '')}
      type="button"
      onBlur={() => setArmed(false)}
      onClick={() => {
        if (!armed) {
          setArmed(true);
          return;
        }
        setArmed(false);
        onConfirm();
      }}
      {...rest}
    >
      {armed ? armedLabel : label}
    </button>
  );
}
