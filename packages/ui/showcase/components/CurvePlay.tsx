import { useEffect, useRef, useState } from 'react';
import { motionOn } from '../../src/motion';
import { cssVar } from '../lib/css-read';
import { CopyName } from './CopyName';
import { CurveGraph } from './CurveGraph';
import { MISSING_TEXT, useIsMissing } from './missing';
import { Seg } from './Seg';
import type { Bezier } from '../../src/easing';

export interface CurveSpec {
  id: string;
  name: string;
  /** 来源：css 是 tokens.css 里的变量，ts 是 easing.ts 里的常量（没有 CSS 变量） */
  source: 'css' | 'ts';
  /** 这条曲线用在哪 */
  usage: string;
  /** 现在的四个数（读不出来是 null） */
  bezier: Bezier | null;
  /** 播放时用的 easing 字符串，每次播放时现读 */
  easing: () => string;
  /** 默认的时长（毫秒） */
  defaultMs: number;
}

const DURS = [120, 140, 180, 200, 250, 300, 500, 800] as const;

/* 一条曲线：曲线图，旁边一条轨道和一个小方块，点「播放」按这条曲线和选的时长走一遍；动画关掉时直接到位 */
export function CurvePlay({ spec }: { spec: CurveSpec }) {
  const missing = useIsMissing(spec.name);
  const [ms, setMs] = useState<number>(spec.defaultMs);
  const puck = useRef<HTMLDivElement>(null);
  const anim = useRef<Animation | null>(null);
  const timer = useRef(0);
  useEffect(
    () => () => {
      anim.current?.cancel();
      window.clearTimeout(timer.current);
    },
    [],
  );
  const reset = () => {
    anim.current?.cancel();
    anim.current = null;
    if (puck.current) puck.current.style.left = '0%';
    if (puck.current) puck.current.dataset.state = 'idle';
  };
  const play = () => {
    const el = puck.current;
    if (!el) return;
    window.clearTimeout(timer.current);
    reset();
    const end = 'calc(100% - var(--sc-puck))';
    if (!motionOn()) {
      /* 动画关掉：直接到位，停一会儿再回去 */
      el.style.left = end;
      el.dataset.state = 'done';
      timer.current = window.setTimeout(reset, 700);
      return;
    }
    el.dataset.state = 'run';
    const a = el.animate([{ left: '0%' }, { left: end }], {
      duration: ms,
      easing: spec.easing() || 'ease',
      fill: 'forwards',
    });
    anim.current = a;
    a.finished
      .then(() => {
        el.dataset.state = 'done';
        timer.current = window.setTimeout(reset, 600);
      })
      .catch(() => {
        /* 被新的一次播放或卸载取消了 */
      });
  };
  return (
    <div
      className={`sc-curve ${missing ? 'is-missing' : ''}`}
      data-curve={spec.id}
      data-token={spec.source === 'css' ? spec.name : undefined}
      data-missing={missing ? '' : undefined}
    >
      <CurveGraph bezier={spec.bezier} />
      <div className="sc-curve-main">
        <div className="sc-curve-head">
          {spec.source === 'css' ? (
            <CopyName name={spec.name} />
          ) : (
            <span className="sc-curve-name">{spec.name}</span>
          )}
          <span className={`sc-tag ${spec.source === 'css' ? 'is-css' : 'is-ts'}`}>
            {spec.source === 'css' ? 'CSS 变量' : 'TS 常量'}
          </span>
        </div>
        {missing && <div className="sc-missing">{MISSING_TEXT}</div>}
        <div className="sc-curve-nums" data-value="">
          {spec.source === 'css'
            ? cssVar(spec.name)
            : spec.bezier
              ? `cubic-bezier(${spec.bezier.join(', ')})`
              : '读不出曲线'}
        </div>
        <div className="sc-curve-usage">{spec.usage}</div>
        <div className="sc-rail" aria-hidden="true">
          <div className="sc-puck" ref={puck} data-state="idle" />
        </div>
        <div className="sc-curve-ctl">
          <button type="button" className="sc-btn" data-play={spec.id} onClick={play}>
            播放
          </button>
          <Seg
            label="时长"
            value={ms}
            items={DURS.map((d) => [d, `${d}`] as const)}
            onPick={setMs}
          />
          <span className="sc-unit">毫秒</span>
        </div>
      </div>
    </div>
  );
}
