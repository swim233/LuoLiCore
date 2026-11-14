import { useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { EASE_OUT_CSS } from '../../src/easing';
import { motionOn } from '../../src/motion';

/* 面板里任务部件「已结束（N）」的旧写法的仿制品（样式在 step5b.css，类名 task-ended、task-more、task-wrap）。b 段结束时和 step5b.css 一起删掉。
   面板里展开收起用 Motion 的 AnimatePresence（高度 0→auto 加淡入，0.42 秒 EASE_OUT；收起高度到 0 加淡出，0.32 秒 easeIn；动画关掉时进场没有动画、退场只淡出）；
   展示页不引 Motion，用 Web Animations 照同样的时长和曲线仿出来（是仿的，不是面板里的原件）。 */
export function LegacyEnded({
  label,
  children,
  ...rest
}: { label: string; children: ReactNode } & Record<string, unknown>) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!open || !el || !motionOn()) return;
    el.animate(
      [
        { height: '0px', opacity: 0 },
        { height: `${el.scrollHeight}px`, opacity: 1 },
      ],
      { duration: 420, easing: EASE_OUT_CSS },
    );
  }, [open, mounted]);
  const toggle = () => {
    if (!open) {
      setMounted(true);
      setOpen(true);
      return;
    }
    setOpen(false);
    const el = box.current;
    if (!el) return;
    const a = el.animate(
      motionOn()
        ? [
            { height: `${el.offsetHeight}px`, opacity: 1 },
            { height: '0px', opacity: 0 },
          ]
        : [{ opacity: 1 }, { opacity: 0 }],
      { duration: motionOn() ? 320 : 1, easing: 'ease-in', fill: 'forwards' },
    );
    a.onfinish = () => setMounted(false);
  };
  return (
    <div className="task-ended" {...rest}>
      <button className="task-more" type="button" aria-expanded={open} onClick={toggle}>
        {label}
        <span className="ll-chev" aria-hidden="true" />
      </button>
      {mounted && (
        <div className="task-wrap" role="list" ref={box}>
          {children}
        </div>
      )}
    </div>
  );
}
