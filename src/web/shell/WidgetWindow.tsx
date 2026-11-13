import { memo, useLayoutEffect, useRef } from 'react';
import { motion } from 'motion/react';
import { env } from '@luoli/ui/env';
import { SLOW } from '../lib/debug';
import { MiniSky } from '../components/MiniSky';
import { GripIcon, ICON_MAX, ICON_MIN, ICON_RESTORE } from '../components/icons';
import {
  desk,
  getDef,
  sizeKey,
  spanOf,
  SIZES,
  SIZE_LABEL,
  useDesk,
  useWidgetRefresh,
} from '../state/desk';
import {
  activate,
  closeFull,
  hideWidget,
  minimize,
  nowCtl,
  openFull,
  setSize,
} from '../state/actions';
import { fsFace, setFace } from './faces';
import { hoverHandlers } from './hover';
import { dragStart } from './drag';
import { positionFloat, positionIsland } from './position';
import type { FullParams, SizeKey } from '../widgets/types';

export type Variant = 'desk' | 'float' | 'island' | 'full';
interface Props {
  id: string;
  variant: Variant;
  cols: number;
  winKey?: number;
  params?: FullParams;
}

/* 部件的外壳：.w 负责位置（Motion 的 layout 动画：其他卡片让位），.w-card 负责外观（悬停、倾斜、晃动）。
   .w-card 是夜空窗口：部件的内容（.w-body，里面是窗格）铺满整块，标题栏（.w-head）浮在最上面；
   四周向内压暗的暗边和细线（.w-vig）画在窗格的模糊上面、浮层下面，不跟着被糊开（层次见 components/Pane.tsx） */
export const WidgetWindow = memo(function WidgetWindow({
  id,
  variant,
  cols,
  winKey,
  params,
}: Props) {
  const def = getDef(id)!;
  useWidgetRefresh(def);
  const full = variant === 'full';
  const active = useDesk((s) => s.activeId === id);
  const fresh = useDesk((s) => s.fresh.includes(id));
  const sz = useDesk(() => sizeKey(id));
  const flip = useDesk((s) => s.flip);
  const ad = useDesk((s) => s.stagger[id]);
  const wrapRef = useRef<HTMLElement | null>(null);
  const [c, r] = spanOf(id, cols);
  const cls = [
    'w',
    id === 'now' && 'now-card',
    active && !full && 'is-active',
    variant === 'float' && 'is-float',
    variant === 'island' && 'is-island',
    full && 'is-full',
  ]
    .filter(Boolean)
    .join(' ');
  const sub = def.sub ? def.sub() : '';
  const hover = hoverHandlers(full);

  /* 「此刻」浮起、灵动岛：放到该在的位置（量位置，要在画出来之前） */
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    if (variant === 'float') positionFloat(el);
    else if (variant === 'island') positionIsland(el);
  });

  const setRefs = (el: HTMLElement | null) => {
    wrapRef.current = el;
    if (full) return;
    setFace(id, 'wrap')(el);
  };
  const cardRef = (el: HTMLDivElement | null) => {
    if (full) fsFace.card = el;
    else setFace(id, 'card')(el);
  };

  const head = (
    <header
      className="w-head"
      onDoubleClick={(ev) => {
        if ((ev.target as Element).closest('.w-btns')) return;
        if (full) return void closeFull();
        if (env.narrow || desk.get().arranging) return;
        openFull(id);
      }}
      onClick={(ev) => {
        if (
          full ||
          !env.narrow ||
          (ev.target as Element).closest('.w-btns') ||
          desk.get().arranging
        )
          return;
        openFull(id);
      }}
    >
      <span className="w-icon">{def.icon}</span>
      <h2 className="w-title">{def.name}</h2>
      {fresh && !full && <span className="w-new">新</span>}
      <span className="w-sub">{sub}</span>
      <div className="w-btns">
        <button
          className="w-btn"
          type="button"
          title="缩小到缩略"
          aria-label="缩小到缩略"
          onClick={() => minimize(id)}
        >
          {ICON_MIN}
        </button>
        {full ? (
          <button
            className="w-btn"
            type="button"
            title="还原（双击标题栏、按 Esc 或点窗口外面）"
            aria-label="还原"
            onClick={() => closeFull()}
          >
            {ICON_RESTORE}
          </button>
        ) : (
          <button
            className="w-btn"
            type="button"
            title="放大到全屏（也可以双击标题栏）"
            aria-label="放大到全屏"
            onClick={() => openFull(id)}
          >
            {ICON_MAX}
          </button>
        )}
      </div>
    </header>
  );
  const arr = !full && (
    <div className="w-arr">
      <span className="w-grip" title="按住拖动换位置">
        {GripIcon}
        <span>按住这里拖动</span>
      </span>
      <div className="w-sizes" role="group" aria-label="普通大小">
        {(Object.keys(SIZES) as SizeKey[]).map((k) => (
          <button
            key={k}
            className="chip"
            type="button"
            data-size={k}
            aria-pressed={k === sz}
            onClick={() => setSize(id, k)}
          >
            {SIZE_LABEL[k]}
          </button>
        ))}
      </div>
      <button className="chip w-hide" type="button" onClick={() => hideWidget(id)}>
        收进收纳盒
      </button>
    </div>
  );
  const body = (
    <div
      className="w-card"
      ref={cardRef}
      style={ad != null ? { '--ad': ad + 'ms' } : undefined}
      {...hover}
      onPointerDown={(ev) => {
        if (!full) dragStart(ev, id, 'card');
      }}
    >
      {def.sky && <MiniSky n={full ? 48 : 26} />}
      <i className="w-edge" />
      {head}
      <div className="w-body">
        <def.View mode={full ? 'full' : 'normal'} params={params || {}} handle={def._h!} />
      </div>
      <i className="w-vig" aria-hidden="true" />
      {arr}
    </div>
  );
  const common = {
    className: cls,
    'data-id': id,
    'data-key': winKey,
    'aria-label': def.name + (full ? '（全屏）' : ''),
    onPointerDownCapture: () => activate(id),
    onFocus: () => activate(id),
    onPointerLeave: id === 'now' ? () => nowCtl.onLeave() : undefined,
  } as const;

  if (full)
    return (
      <section ref={setRefs} {...common}>
        {body}
      </section>
    );
  if (variant === 'desk') {
    return (
      <motion.section
        ref={setRefs}
        layout="position"
        transition={{ layout: { duration: flip.dur * SLOW, ease: flip.ease } }}
        style={{
          gridColumn: `span ${c}`,
          gridRow: `span ${r}`,
          '--ad': ad != null ? ad + 'ms' : undefined,
        }}
        {...common}
      >
        {body}
      </motion.section>
    );
  }
  return (
    <section ref={setRefs} {...common}>
      {body}
    </section>
  );
});
