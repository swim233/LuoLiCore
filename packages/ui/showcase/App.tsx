import { useEffect } from 'react';
import { Seg } from './components/Seg';
import { Toaster, TooltipProvider } from '../src/overlay';
import { useToastDuration, useToasterOn } from './lib/overlay-prefs';
import { DEFAULT_SECTION, SECTIONS } from './sections';
import { Pending } from './sections/Pending';
import { useHashRoute } from './lib/hash';
import { ZOOMS, chooseMotion, chooseZoom, useMotionMode, useZoom } from './lib/prefs';
import type { MotionMode } from '../src/motion';
import type { Zoom } from './lib/prefs';

const IDS = SECTIONS.map((s) => s.id);

/* 展示页的骨架：顶上一条工具栏（动画开关、缩放），左边一列分节的导航，右边是当前这一节。
   内容放在 .sc-body 这一层容器里（缩放作用在它身上）；它后面有一层 .sc-sky，现在是空的：
   星空的画布在面板里（第 10 步才搬进库），以后垫在这一层里，不用改版面 */
export function App() {
  const route = useHashRoute(IDS, DEFAULT_SECTION);
  const zoom = useZoom();
  const mode = useMotionMode();
  const section = SECTIONS.find((s) => s.id === route) ?? SECTIONS[0];
  const duration = useToastDuration();
  const toasterOn = useToasterOn();
  useEffect(() => {
    document.title = `${section.title} · @luoli/ui 展示页`;
    window.scrollTo(0, 0);
  }, [section]);
  const firstPending = SECTIONS.findIndex((s) => !s.Component);
  const Body = section.Component;
  return (
    <TooltipProvider>
      <div className="sc-app" style={{ '--sc-zoom': zoom }}>
        <div className="sc-sky" id="sc-sky" aria-hidden="true" />
        <header className="sc-bar">
          <div className="sc-brand">
            <svg viewBox="-50 -50 100 100" aria-hidden="true">
              <path d="M0-42C3-14 14-3 42 0C14 3 3 14 0 42C-3 14-14 3-42 0C-14-3-3-14 0-42Z" />
            </svg>
            <b>@luoli/ui</b>
            <span className="sc-brand-sub">展示页</span>
          </div>
          <div className="sc-bar-ctl">
            <div className="sc-bar-group">
              <span className="sc-bar-label">动画</span>
              <Seg<MotionMode>
                label="动画开关"
                value={mode}
                items={[
                  ['system', '跟随系统'],
                  ['on', '开'],
                  ['off', '关'],
                ]}
                onPick={chooseMotion}
              />
            </div>
            <div className="sc-bar-group">
              <span className="sc-bar-label">缩放</span>
              <Seg<Zoom>
                label="缩放"
                value={zoom}
                items={ZOOMS.map((z) => [z, `${Math.round(z * 100)}%`] as const)}
                onPick={chooseZoom}
              />
            </div>
          </div>
        </header>
        <div className="sc-body" id="sc-body">
          <nav className="sc-nav" aria-label="分节">
            {SECTIONS.map((s, i) => (
              <span className="sc-nav-cell" key={s.id}>
                {i === firstPending && <span className="sc-nav-sep">以后加进来</span>}
                <a
                  className={`sc-nav-item ${s.Component ? '' : 'is-pending'}`}
                  href={`#${s.id}`}
                  data-section={s.id}
                  aria-current={s.id === section.id ? 'page' : undefined}
                >
                  {s.title}
                  {!s.Component && <span className="sc-nav-tag">还没有</span>}
                </a>
              </span>
            ))}
          </nav>
          <main className="sc-main" id={`sc-${section.id}`} data-section={section.id}>
            {Body ? <Body /> : <Pending title={section.title} steps={section.steps ?? '?'} />}
          </main>
        </div>
        {toasterOn && <Toaster duration={duration} />}
      </div>
    </TooltipProvider>
  );
}
