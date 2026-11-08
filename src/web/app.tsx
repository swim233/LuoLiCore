import { useEffect, useRef, useState } from 'react';
import { fx, sky } from './fx/client';
import { MotionConfig } from 'motion/react';
import { usePrefs } from './lib/prefs';
import { DeskWrap } from './shell/Desk';
import { TopBar } from './shell/TopBar';
import { FullscreenLayer } from './shell/FullscreenLayer';
import { MorphHost, motionBusy } from './shell/morph';
import { ArrangeBar, Pop, Toast, Tray } from './shell/Overlays';
import { devSlot } from './lib/dev-slot';
import { setArranging } from './state/actions';
import { useDesk } from './state/desk';

export function App() {
  const DevPanel = devSlot.Panel;
  /* 「动画」开关的设置（motionPref）立刻管新开始的转场；html 的 .still 类和 MotionConfig 用的是 motion，等正在走的动画都走完再跟上（见 motionBusy） */
  const motionPref = usePrefs((p) => p.motion);
  const [motion, setMotion] = useState(motionPref);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const apply = () => {
      if (motionBusy()) {
        t = setTimeout(apply, 60);
        return;
      }
      setMotion(motionPref);
    };
    apply();
    return () => clearTimeout(t);
  }, [motionPref]);
  const hover = usePrefs((p) => p.hover);
  const arranging = useDesk((s) => s.arranging);
  const arrLeaving = useDesk((s) => s.arrLeaving);
  const skyRef = useRef<HTMLCanvasElement>(null);
  const fxRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    sky.start(skyRef.current!);
    fx.start(fxRef.current!);
    let t: ReturnType<typeof setTimeout>;
    const on = () => {
      clearTimeout(t);
      t = setTimeout(() => {
        sky.size();
        fx.size();
      }, 140);
    };
    window.addEventListener('resize', on);
    return () => {
      window.removeEventListener('resize', on);
      clearTimeout(t);
    };
  }, []);
  useEffect(() => {
    const r = document.documentElement;
    r.classList.toggle('motion', motion);
    r.classList.toggle('still', !motion);
    sky.sync();
  }, [motion]);
  useEffect(() => {
    const r = document.documentElement;
    r.classList.remove('hover-B', 'hover-C', 'hover-D');
    r.classList.add('hover-' + hover);
  }, [hover]);
  useEffect(() => {
    document.body.classList.toggle('arranging', arranging);
    document.body.classList.toggle('arr-leaving', arrLeaving);
  }, [arranging, arrLeaving]);
  return (
    <MotionConfig reducedMotion={motion ? 'never' : 'always'}>
      <svg
        width="0"
        height="0"
        style={{ position: 'absolute' }}
        aria-hidden="true"
        focusable="false"
      >
        <defs>
          <linearGradient
            id="g-star"
            x1="0"
            y1="-1"
            x2="0"
            y2="1"
            gradientUnits="objectBoundingBox"
          >
            <stop offset="0" style={{ stopColor: 'var(--gold-pale)' }} />
            <stop offset=".55" style={{ stopColor: 'var(--gold)' }} />
            <stop offset="1" style={{ stopColor: 'var(--gold-deep)' }} />
          </linearGradient>
        </defs>
      </svg>
      <canvas id="sky" className="sky" ref={skyRef} aria-hidden="true" />
      <div className="app" id="app">
        <h1 className="sr-only">
          {import.meta.env.DEV ? 'LuoLi 星夜桌面（开发模式，模拟数据）' : 'LuoLi 星夜桌面'}
        </h1>
        <TopBar />
        <ArrangeBar onDone={() => setArranging(false)} />
        <main className="main" id="main">
          <DeskWrap />
        </main>
      </div>
      <Tray />
      <FullscreenLayer />
      <div className="ghosts" id="ghosts" aria-hidden="true">
        <MorphHost host="ghosts" />
      </div>
      <canvas id="fx" className="fx" ref={fxRef} aria-hidden="true" />
      <Pop />
      {DevPanel && <DevPanel />}
      <Toast />
    </MotionConfig>
  );
}
