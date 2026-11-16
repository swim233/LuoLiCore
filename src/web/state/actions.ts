import { flushSync } from 'react-dom';
import { animate } from 'motion';
import { motionOn } from '@luoli/ui/motion';
import { prefs } from '../lib/prefs';
import { env } from '@luoli/ui/env';
import { storage } from '@luoli/ui/storage';
import { DUR_MORPH, DUR_VANISH, EASE_MORPH, EASE_OUT, EASE_OUT_CSS } from '@luoli/ui/easing';
import { edgeRun, pulse } from '../lib/fx-dom';
import { fx, sky } from '../fx/client';
import { bus } from '../model/bus';
import { status } from '../model/status';
import { nowModel } from '../model/nowModel';
import {
  LAYOUT_KEY,
  DEFAULT_LAYOUT,
  desk,
  hasDef,
  hooks,
  registerWidget,
  saveLayout,
  unregisterWidget,
} from './desk';
import { popHandle } from './ui';
import {
  cloneFace,
  deskFace,
  frameAt,
  onScreen,
  occluded,
  rectOf,
  shrinkRect,
  unmorph,
} from '../shell/faceUtil';
import type { Face } from '../shell/faceUtil';
import { faces, fsFace } from '../shell/faces';
import type { FrameSpec, LayerSpec, MorphRec, Rect } from '../shell/morph';
import {
  applyNow,
  capLay,
  finishMorph,
  followTarget,
  glide,
  lay,
  markBusy,
  morphStore,
  PIECES,
  REVERSE_SNAP,
  setDir,
  startMorph,
  whenMorphsDone,
} from '../shell/morph';
import type { FullParams, SizeKey, WidgetDef } from '../widgets/types';

/* 桌面上的动作：三档之间切换、换大小、收进收纳盒、整理模式、全屏、「此刻」的展开与缩回。
   任何会让桌面重排的操作都走 relayout：先量「之前」，改布局（flushSync，同步渲染完），再量「之后」，然后形变、让位 */

/* ---------- 量位置 ---------- */
/* Motion 的 layout 动画把 transform 写在 .w 和 .cap-wrap 的行内样式上：量「真正的排版位置」时先拿掉再放回 */
function atFinalLayout<T>(fn: () => T): T {
  const els: [HTMLElement, string][] = [];
  const grab = (el?: HTMLElement | null) => {
    if (el && el.style.transform && !el.classList.contains('is-morphing')) {
      els.push([el, el.style.transform]);
      el.style.transform = 'none';
    }
  };
  for (const id of desk.get().layout.order) {
    const f = faces(id);
    grab(f.wrap);
    grab(f.cap);
  }
  try {
    return fn();
  } finally {
    for (const [el, t] of els) el.style.transform = t;
  }
}
function snapshot(finalLayout = false) {
  const read = () => {
    const m = new Map<string, Rect>();
    for (const id of desk.get().layout.order) {
      const f = faces(id);
      if (f.wrap?.isConnected) m.set(id + ':card', rectOf(f.wrap.getBoundingClientRect()));
      if (f.cap?.isConnected && !f.cap.hasAttribute('data-placeholder'))
        m.set(id + ':cap', rectOf(f.cap.getBoundingClientRect()));
    }
    return m;
  };
  return finalLayout ? atFinalLayout(read) : read();
}
interface Before {
  rect: Rect;
  kind: Face['kind'];
  frame: FrameSpec;
  clone: ReturnType<typeof cloneFace>;
  sheen: string | null;
}
function beforeFaces(skip?: Set<string>) {
  const m = new Map<string, Before>();
  for (const id of desk.get().layout.order) {
    if (skip?.has(id)) continue;
    const f = deskFace(id);
    if (!f) continue;
    const r = rectOf(f.el.getBoundingClientRect());
    if (r.width < 4 || r.height < 4) continue;
    m.set(id + (f.kind === 'cap' ? ':cap' : ':card'), {
      rect: r,
      kind: f.kind,
      frame: frameAt(f.inner, r, f.kind),
      clone: cloneFace(f),
      sheen: f.kind === 'cap' ? getComputedStyle(f.inner).backgroundImage : null,
    });
  }
  return m;
}
/* 胶囊在视口外时，「此刻」改从顶栏的徽记长出来、落回顶栏的徽记 */
function onScreenRect(r: Rect | undefined): Rect {
  const topB = document.getElementById('top')!.getBoundingClientRect().bottom;
  if (r && r.top + r.height > topB - 4 && r.top < window.innerHeight) return r;
  const b = document.getElementById('top-badge')!.getBoundingClientRect();
  return rectOf(b.width ? b : document.getElementById('top-status')!.getBoundingClientRect());
}

/* ---------- 出现、消失 ----------
   这几条短动画用浏览器自带的 WAAPI（element.animate），关键帧和第 4.1 版一模一样，结束后不在元素上留任何行内样式。
   不用 Motion 的 animate：它对 transform 字符串关键帧里的 `none` 处理有误——`scale(.94)` 到 `none`，none 被读成「没有数字」、数字按 0 算，
   结果缩到 scale(0)；`none` 到 `scale(.9)` 就是从 scale(0) 长出来。而且它会把终值留在行内样式里，盖掉样式表里的 transform（悬停效果 D 的倾斜）。 */
function appear(el: HTMLElement | null | undefined) {
  if (!el) return;
  el.animate(
    [
      { opacity: 0, transform: 'scale(.94)' },
      { opacity: 1, transform: 'none' },
    ],
    { duration: 380, easing: EASE_OUT_CSS },
  );
}
function vanish(r: Rect, rad = 16) {
  const host = document.getElementById('ghosts');
  if (!host) return;
  const g = document.createElement('div');
  g.className = 'ghost ll-sky';
  Object.assign(g.style, {
    left: r.left + 'px',
    top: r.top + 'px',
    width: r.width + 'px',
    height: r.height + 'px',
    borderRadius: rad + 'px',
  });
  host.append(g);
  const a = g.animate(
    [
      { opacity: 1, transform: 'none' },
      { opacity: 0, transform: 'scale(.9)' },
    ],
    { duration: DUR_VANISH, easing: 'ease-in', fill: 'forwards' },
  );
  a.finished.then(
    () => g.remove(),
    () => g.remove(),
  );
}

/* ---------- 桌面上的形变（缩略 ↔ 普通、换大小） ---------- */
function morphWidget(
  id: string,
  b: Before,
  fromRect: Rect,
  aface: Face,
  toRect: Rect,
  o: { dur: number; faceTarget?: boolean },
) {
  if (!b || !aface) return Promise.resolve();
  const dur = o.dur;
  const from: FrameSpec = Object.assign({}, b.frame, fromRect, {
    radius: b.kind === 'cap' ? fromRect.height / 2 : b.frame.radius,
  });
  const to = frameAt(aface.inner, toRect, aface.kind);
  const hide = aface.el;
  hide.setAttribute('data-hide', '');
  const nc = cloneFace(aface);
  const oc = b.clone;
  const layers: LayerSpec[] = [
    b.kind === 'cap' ? capLay(oc, b.rect, 'out') : lay(oc, b.rect, 'out'),
    aface.kind === 'cap' ? capLay(nc, nc._rect, 'in') : lay(nc, nc._rect, 'in'),
  ];
  oc.dataset.clone = '1';
  nc.dataset.clone = '1';
  const drivers: ((g: number) => void)[] = [];
  const sheens: HTMLElement[] = [];
  const sheen = (bg: string | null, rect: Rect, toCap: boolean) => {
    if (!bg || bg === 'none') return;
    const i = document.createElement('i');
    i.className = 'fs-sheen';
    i.dataset.clone = '1';
    i.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;background-image:${bg};border-radius:${rect.height / 2}px;opacity:${toCap ? 0 : 1}`;
    sheens.push(i);
    drivers.push((g) => {
      i.style.opacity = String(toCap ? g : 1 - g);
    });
  };
  if (b.kind === 'cap') sheen(b.sheen, b.rect, false);
  if (aface.kind === 'cap') sheen(getComputedStyle(aface.inner).backgroundImage, toRect, true);
  let done!: () => void;
  const p = new Promise<void>((res) => (done = res));
  const rec: MorphRec = startMorph({
    id,
    host: 'ghosts',
    dur,
    A: from,
    B: to,
    layers,
    extras: sheens,
    drivers,
    kind: 'desk',
    beforeKind: b.kind,
    afterKind: aface.kind,
    faceTarget: !!o.faceTarget,
    settle: () => {
      rec.hide?.removeAttribute('data-hide');
      done();
    },
  });
  rec.hide = hide;
  return p;
}
/* ---------- 重新布局 ---------- */
export interface RelayoutOpts {
  instant?: boolean;
  assemble?: string;
  flipDur?: number;
  flipEase?: [number, number, number, number];
  now?: boolean;
}
const isFsMorph = (m: MorphRec) => m.host === 'fs';
const isDeskMorph = (m: MorphRec) => m.kind === 'desk';
/* 全屏的形变还在走时，不能让桌面重排（全屏退出要落在桌面上的位置，重排会把落点挪走）：先排着，形变结束了再做 */
function deferFs(fn: () => void): boolean {
  if (!fsBusy()) return false;
  whenMorphsDone(isFsMorph, fn);
  return true;
}
export function relayout(mutate: (() => void) | null, opts: RelayoutOpts = {}): Promise<void> {
  if (!opts.now && fsBusy())
    return new Promise<void>((res) =>
      whenMorphsDone(isFsMorph, () => {
        relayout(mutate, opts).then(res);
      }),
    );
  popHandle.close();
  const anim = motionOn() && !opts.instant;
  /* 桌面上还在走的形变：这次重排如果正好把它变回去（缩到一半又点开、展开到一半又缩回），就让它从此刻的位置原路退回；否则立刻收尾 */
  const running = morphStore.get().list.filter((m) => !m.dead && m.kind === 'desk');
  const runIds = new Set(running.map((m) => m.id));
  const before = anim ? snapshot() : null;
  const bFaces = anim ? beforeFaces(runIds) : null;
  const L = desk.get().layout;
  /* 其他卡片让位的 FLIP 用的时长：先按默认 DUR_MORPH，有形变时下面再改（Motion 的 layout 动画在渲染后下一帧才开始，来得及） */
  flushSync(() => {
    mutate?.();
    desk.set({
      layout: { ...desk.get().layout },
      flip: { dur: (opts.flipDur ?? DUR_MORPH) / 1000, ease: opts.flipEase ?? EASE_MORPH },
    });
  });
  saveLayout();
  let mdur = 0;
  if (!anim) {
    for (const m of running) finishMorph(m, m.dir);
    return Promise.resolve();
  }
  const after = snapshot(true);
  const sameSize = (a: Rect, b: Rect) =>
    Math.abs(a.width - b.width) <= 2 && Math.abs(a.height - b.height) <= 2;
  /* 桌面上还在走的形变，这次重排怎么处理（任何一种都不跳）：
     - 把它变回去了（终点那份又回到起点的样子、大小）：从此刻的位置原路退回；
     - 退回去的又被改回来了：再掉头往终点走；
     - 终点那份还在、只是被别的重排挪了位置：接着走，外框平滑地落到它此刻的位置上；
     - 终点没了或变成别的样子：整个形变淡出 */
  for (const m of running) {
    const f = deskFace(m.id);
    const fin = f ? after.get(m.id + (f.kind === 'cap' ? ':cap' : ':card')) : undefined;
    const toStart = f && fin && f.kind === m.beforeKind && sameSize(fin, m.A);
    const toEnd = f && fin && f.kind === m.afterKind;
    if (toStart && m.dir === 1) {
      m.hide?.removeAttribute('data-hide');
      f!.el.setAttribute('data-hide', '');
      m.hide = f!.el;
      setDir(m, 0);
      mdur = Math.max(mdur, m.dur);
    } else if (toEnd && m.dir === 0 && sameSize(fin!, m.B)) {
      m.hide?.removeAttribute('data-hide');
      f!.el.setAttribute('data-hide', '');
      m.hide = f!.el;
      setDir(m, 1);
      mdur = Math.max(mdur, m.dur);
    } else if (toEnd && m.faceTarget) {
      m.hide?.removeAttribute('data-hide');
      f!.el.setAttribute('data-hide', '');
      m.hide = f!.el;
      followTarget(m, fin!);
      mdur = Math.max(mdur, m.dur);
    } else if (!(toEnd || toStart)) {
      fadeOutMorph(m);
      if (f) appear(f.inner); /* 新的样子淡入，和淡出的形变交叠，不在淡出的同时突然冒出来 */
    }
  }
  const jobs: Promise<void>[] = [];
  const sized = (a: Rect, b: Rect) => !sameSize(a, b);
  const morph = (dur: number, f: (d: number) => Promise<void>) => {
    mdur = Math.max(mdur, dur);
    jobs.push(f(dur));
  };
  const ids = L.order;
  for (const id of ids) {
    if (opts.assemble === id || runIds.has(id)) continue;
    const bc = before!.get(id + ':card'),
      ac = after.get(id + ':card'),
      bp = before!.get(id + ':cap'),
      ap = after.get(id + ':cap');
    const isNow = id === 'now';
    const f = deskFace(id);
    const e = faces(id);
    if (bc && ac) {
      if (sized(bc, ac))
        morph(560, (dur) =>
          morphWidget(id, bFaces!.get(id + ':card')!, bc, f!, ac, { dur, faceTarget: true }),
        );
    } else if (ac) {
      if (bp) {
        const from = isNow ? onScreenRect(bp) : bp;
        morph(isNow ? 700 : 600, (dur) =>
          morphWidget(id, bFaces!.get(id + ':cap')!, from, f!, ac, { dur, faceTarget: true }),
        );
      } else appear(e.card);
    } else if (bc) {
      if (ap) {
        const to = isNow ? onScreenRect(ap) : ap;
        morph(isNow ? 640 : 560, (dur) =>
          morphWidget(id, bFaces!.get(id + ':card')!, bc, f!, to, { dur, faceTarget: to === ap }),
        );
      } else vanish(bc);
    }
    if (!bp && ap && !bc) appear(e.capBtn);
    else if (bp && !ap && !ac) vanish(bp, 999);
  }
  if (mdur && !opts.flipDur) {
    /* 有形变：其他卡片让位的时长改成形变的最长时长（Motion 的 layout 动画在下一帧才读时长） */
    desk.set({ flip: { dur: mdur / 1000, ease: EASE_MORPH } });
  }
  markBusy((mdur || opts.flipDur || DUR_MORPH) + 200);
  return Promise.all(jobs).then(() => {});
}
/* 形变的终点没了（部件被隐藏、换成别的样子）：整个形变淡出再收尾，不在最后一帧突然消失 */
function fadeOutMorph(m: MorphRec) {
  const wrap = m.frameEl?.parentElement;
  m.pAnim?.stop();
  clearTimeout(m.doneTimer);
  if (!wrap) {
    finishMorph(m, m.dir);
    return;
  }
  const a = animate(wrap, { opacity: [1, 0] }, { duration: 0.2, ease: 'easeIn' });
  const done = () => finishMorph(m, m.dir);
  a.finished.then(done, done);
}

/* ---------- 激活 ---------- */
export function activate(id: string) {
  if (desk.get().activeId !== id) desk.set({ activeId: id });
  if (desk.get().fresh.includes(id)) setTimeout(() => clearFresh(id), 1200);
}

/* ---------- 三档之间切换 ---------- */
export function expand(id: string) {
  if (id === 'now') return nowCtl.manualExpand();
  relayout(() => {
    desk.get().layout.mini[id] = false;
  });
  activate(id);
}
export function minimize(id: string) {
  if (desk.get().full?.id === id) return fullToMini(id);
  if (id === 'now') return nowCtl.minimize();
  relayout(() => {
    desk.get().layout.mini[id] = true;
  });
}
/* 全屏里点「缩小到缩略」：一段形变直接落到胶囊上。先在全屏窗口下面把桌面换成缩略的排版，再退出全屏，退出的终点就是它的胶囊 */
export function fullToMini(id: string) {
  /* 全屏的形变还在走：先退回（打开到一半原路退，切换到一半退回起点），退回去之后再缩到缩略 */
  if (fsBusy()) {
    if (fsMorph!.kind !== 'close') closeFull();
    whenMorphsDone(isFsMorph, () => minimize(id));
    return;
  }
  if (id === 'now') {
    nowCtl.cancel();
    desk.set({ nowFloat: false, floatTop: null });
  }
  relayout(
    () => {
      desk.get().layout.mini[id] = true;
    },
    { assemble: id },
  );
  if (id === 'now' && !status.snapshot().count) nowModel.clearEnded();
  closeFull();
}
export function setSize(id: string, key: SizeKey) {
  relayout(() => {
    desk.get().layout.size[id] = key;
  });
}
/* 收进收纳盒。整理时把部件拖进收纳盒：拖的路上它可能已经换过位置，restoreBefore 给了就在同一次重排里先放回原来的位置
   （原来排在谁的前面；null 是原来在最后），收纳盒里「放回原处」才回得到原处 */
export function hideWidget(id: string, restoreBefore?: string | null) {
  if (fsBusy()) {
    if (desk.get().full?.id === id && fsMorph!.kind !== 'close') closeFull();
    whenMorphsDone(isFsMorph, () => hideWidget(id, restoreBefore));
    return;
  }
  if (desk.get().full?.id === id) closeFull();
  if (id === 'now') {
    desk.set({ nowFloat: false, floatTop: null });
    nowCtl.cancel();
    nowCtl.call(false);
  }
  relayout(
    () => {
      const L = desk.get().layout;
      if (restoreBefore !== undefined) orderBefore(L.order, id, restoreBefore);
      L.hidden[id] = true;
    },
    { now: true },
  );
}
export function unhideWidget(id: string, beforeId?: string | null) {
  relayout(() => {
    const L = desk.get().layout;
    delete L.hidden[id];
    if (beforeId && beforeId !== id) {
      const o = L.order;
      o.splice(o.indexOf(id), 1);
      o.splice(o.indexOf(beforeId), 0, id);
    }
  });
}
/* 整理时拖动换位：把部件排到 beforeId 的前面（beforeId 为 null：排到最后）。同样的参数再调一次不会再变，
   其他部件由 Motion 的 layout 动画让位 */
export function placeBefore(id: string, beforeId: string | null) {
  relayout(() => orderBefore(desk.get().layout.order, id, beforeId), {
    flipDur: 340,
    flipEase: EASE_OUT,
  });
}
/** 就地把 id 排到 beforeId 前面；beforeId 是 null、或不在顺序里：排到最后 */
function orderBefore(o: string[], id: string, beforeId: string | null) {
  const from = o.indexOf(id);
  if (from < 0) return;
  o.splice(from, 1);
  const to = beforeId == null ? -1 : o.indexOf(beforeId);
  o.splice(to < 0 ? o.length : to, 0, id);
}
export function flashWidget(id: string, kind: 'stream' | 'error') {
  const f = faces(id);
  const targets: (HTMLElement | null | undefined)[] = [];
  if (f.wrap?.isConnected) targets.push(f.card);
  else if (f.cap?.isConnected) targets.push(f.capBtn);
  if (desk.get().full?.id === id && kind === 'error') targets.push(fsFace.card);
  for (const t of targets) (kind === 'error' ? pulse : edgeRun)(t);
}
hooks.flash = flashWidget;
hooks.openFull = (id, params) => openFull(id, params);
/* 部件自己的形变结束以后再调 fn（WidgetHandle.afterMorph）：这个部件现在有进行中的形变（桌面上的、全屏的都算，按部件 id 认）就排队等它们都走完，
   没有就马上调。部件视图挂上时形变要么还没建（和挂上在同一个同步调用里，开始形变在它后面），要么就在眼前，所以视图要在挂上之后的下一拍再问 */
hooks.afterMorph = (id, fn) => {
  let off = false;
  whenMorphsDone(
    (m) => m.id === id,
    () => {
      if (!off) fn();
    },
  );
  return () => {
    off = true;
  };
};

/* 新增部件的「新」标记 */
const freshTimers = new Map<string, ReturnType<typeof setTimeout>>();
export function markFresh(id: string) {
  const s = desk.get();
  if (!s.fresh.includes(id)) desk.set({ fresh: [...s.fresh, id] });
  clearTimeout(freshTimers.get(id));
  freshTimers.set(
    id,
    setTimeout(() => clearFresh(id), 9000),
  );
  faces(id).card?.addEventListener('pointerenter', () => setTimeout(() => clearFresh(id), 1500), {
    once: true,
  });
}
export function clearFresh(id: string) {
  const s = desk.get();
  if (!s.fresh.includes(id)) return;
  const tag = faces(id).card?.querySelector('.w-new') as HTMLElement | null;
  const drop = () => desk.set({ fresh: desk.get().fresh.filter((x) => x !== id) });
  if (tag && motionOn())
    tag
      .animate(
        [
          { opacity: 1, transform: 'none' },
          { opacity: 0, transform: 'scale(.6)' },
        ],
        { duration: DUR_VANISH, easing: 'ease-in', fill: 'forwards' },
      )
      .finished.then(drop, drop);
  else drop();
}

/* 运行时新增一个部件：从星点汇聚成形，出现在桌面末尾，带「新」 */
export function addWidget(def: WidgetDef) {
  if (hasDef(def.id)) return;
  if (deferFs(() => addWidget(def))) return;
  registerWidget(def);
  const L = desk.get().layout;
  if (!L.extra.includes(def.id)) L.extra.push(def.id);
  const o = L.order;
  o.splice(o.indexOf(def.id), 1);
  o.push(def.id);
  relayout(
    () => {
      delete desk.get().layout.hidden[def.id];
      desk.get().layout.mini[def.id] = false;
    },
    { assemble: def.id },
  );
  const e = faces(def.id);
  if (!e.wrap) return;
  e.wrap.setAttribute('data-hide', '');
  const r0 = e.wrap.getBoundingClientRect();
  const off = r0.bottom > window.innerHeight || r0.top < 0;
  if (off) e.wrap.scrollIntoView({ block: 'nearest', behavior: motionOn() ? 'smooth' : 'auto' });
  setTimeout(
    () => {
      const w = faces(def.id).wrap;
      if (!w) return;
      const r = w.getBoundingClientRect();
      fx.assemble({
        left: r.left,
        top: r.top,
        width: r.width,
        height: r.height,
        right: r.right,
        bottom: r.bottom,
      }).then(() => {
        w.removeAttribute('data-hide');
        if (motionOn()) {
          /* 动画挂在里面的 .w-card 上，不挂在 .w 上：.w 的 transform 归 Motion 的 layout 动画管 */
          const card = faces(def.id).card;
          if (card)
            card.animate(
              [
                { opacity: 0, transform: 'scale(.94)', filter: 'brightness(1.8)' },
                { opacity: 1, transform: 'none', filter: 'none' },
              ],
              { duration: 560, easing: EASE_OUT_CSS },
            );
          edgeRun(faces(def.id).card);
          fx.burst(r.left + r.width / 2, r.top + r.height / 2, { n: 14, speed: 80 });
        }
        markFresh(def.id);
      });
    },
    motionOn() && off ? 420 : 30,
  );
}
export function removeWidget(id: string) {
  if (!hasDef(id)) return;
  if (fsBusy()) {
    if (desk.get().full?.id === id && fsMorph!.kind !== 'close') closeFull();
    whenMorphsDone(isFsMorph, () => removeWidget(id));
    return;
  }
  /* 正在全屏的就是它：等全屏关完再移除（关闭的形变要用它的窗口，部件的定义先注销了，窗口会画不出来、整页报错） */
  if (desk.get().full?.id === id) {
    closeFull().then(() => removeWidget(id));
    return;
  }
  const f = faces(id);
  const el = f.wrap?.isConnected ? f.wrap : f.cap?.isConnected ? f.cap : null;
  if (el) {
    const r = el.getBoundingClientRect();
    fx.scatter({
      left: r.left,
      top: r.top,
      width: r.width,
      height: r.height,
      right: r.right,
      bottom: r.bottom,
    });
    if (motionOn()) vanish(rectOf(r));
  }
  relayout(
    () => {
      unregisterWidget(id);
      const L = desk.get().layout;
      L.extra = L.extra.filter((x) => x !== id);
    },
    { now: true },
  );
}

/* ---------- 「此刻」：自动展开（浮起）、自动缩回、手动展开 ---------- */
export const nowCtl = {
  timer: 0 as ReturnType<typeof setTimeout> | 0,
  expired: false,
  get mode() {
    const L = desk.get().layout;
    if (!hasDef('now') || L.hidden.now) return 'hidden';
    if (!L.mini.now) return 'docked';
    return desk.get().nowFloat ? 'float' : 'mini';
  },
  autoExpand() {
    if (deferFs(() => this.autoExpand())) return;
    this.cancel();
    if (this.mode !== 'mini' || desk.get().arranging) return;
    /* 窄屏上展开会盖住下面的内容：用户正在操作别的部件时不自动展开，只让胶囊发光提示，点一下再展开 */
    if (env.narrow && operatingOther()) {
      this.call(true);
      return;
    }
    desk.set({ nowFloat: true, floatTop: null });
    relayout(null);
  },
  call(on: boolean) {
    if (desk.get().calling !== on) desk.set({ calling: on });
  },
  collapse() {
    if (deferFs(() => this.collapse())) return;
    this.cancel();
    if (!desk.get().nowFloat) return;
    desk.set({ nowFloat: false, floatTop: null });
    popHandle.close();
    relayout(null);
    nowModel.clearEnded();
  },
  manualExpand() {
    if (deferFs(() => this.manualExpand())) return;
    this.cancel();
    this.call(false);
    const wasMode = this.mode;
    desk.set({ nowFloat: false, floatTop: null });
    if (wasMode !== 'docked')
      relayout(() => {
        const L = desk.get().layout;
        delete L.hidden.now;
        L.mini.now = false;
      });
    activate('now');
    const f = faces('now');
    if (f.wrap && !env.narrow)
      setTimeout(
        () =>
          faces('now').wrap?.scrollIntoView({
            behavior: motionOn() ? 'smooth' : 'auto',
            block: 'nearest',
          }),
        wasMode === 'docked' ? 0 : 120,
      );
    if (wasMode === 'docked') edgeRun(f.card);
  },
  minimize() {
    if (deferFs(() => this.minimize())) return;
    this.cancel();
    desk.set({ nowFloat: false, floatTop: null });
    relayout(() => {
      desk.get().layout.mini.now = true;
    });
    if (!status.snapshot().count) nowModel.clearEnded();
  },
  onStatus(s: { count: number }) {
    if (s.count === 0) this.schedule();
    else this.cancel();
  },
  schedule() {
    if (this.timer || this.expired) return;
    this.timer = setTimeout(() => {
      this.timer = 0;
      this.settle();
    }, prefs.get().collapse * 1000);
  },
  settle() {
    if (status.snapshot().count) return;
    this.call(false);
    if (desk.get().nowFloat) {
      const w = faces('now').wrap;
      if ((w && w.matches(':hover')) || desk.get().full?.id === 'now') {
        this.expired = true;
        return;
      }
      this.collapse();
    } else nowModel.clearEnded();
  },
  onLeave() {
    if (!this.expired) return;
    this.expired = false;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = 0;
      this.settle();
    }, 1500);
  },
  cancel() {
    clearTimeout(this.timer);
    this.timer = 0;
    this.expired = false;
  },
};
bus.on('status', (s) => nowCtl.onStatus(s));
/* 用户正在操作别的部件：焦点在它里面，或者 20 秒内最后点按的是它。只算点按；划动页面、浏览器接管成滚动的都不算 */
export const lastTouch: { id: string | null; at: number } = { id: null, at: 0 };
function operatingOther() {
  const a = document.activeElement as HTMLElement | null;
  const fw = a && a !== document.body && a.closest ? (a.closest('.w') as HTMLElement | null) : null;
  if (fw?.dataset.id && fw.dataset.id !== 'now') return true;
  return !!(lastTouch.id && lastTouch.id !== 'now' && Date.now() - lastTouch.at < 20000);
}
let pressCand: { pid: number; id: string | null; x: number; y: number } | null = null;
export function installPressTracking() {
  document.addEventListener(
    'pointerdown',
    (e) => {
      const t = e.target as Element;
      if (t.closest && t.closest('[data-dev]')) {
        pressCand = null;
        return;
      }
      const w = t.closest ? (t.closest('.w, .cap-wrap') as HTMLElement | null) : null;
      pressCand = {
        pid: e.pointerId,
        id: w ? w.dataset.id || null : null,
        x: e.clientX,
        y: e.clientY,
      };
    },
    true,
  );
  document.addEventListener(
    'pointerup',
    (e) => {
      const c = pressCand;
      pressCand = null;
      if (!c || c.pid !== e.pointerId || Math.hypot(e.clientX - c.x, e.clientY - c.y) > 10) return;
      lastTouch.id = c.id;
      lastTouch.at = Date.now();
    },
    true,
  );
  document.addEventListener(
    'pointercancel',
    () => {
      pressCand = null;
    },
    true,
  );
}

/* ---------- 全屏 ----------
   一次全屏转场 = 一条形变（morph.tsx）：A 是起点、B 是终点（按创建时的方向），反向就是进度走回 A。
   打开：A = 桌面上的那一份（或窗口中间缩 10% 透明），B = 全屏窗口；关闭：反过来。
   settle(dir)：dir = 1 走到了 B，dir = 0 退回了 A。 */
let fsSeq = 0;
let fsKey = 0;
let fsMorph: MorphRec | null = null;
let fsLifted: HTMLElement | null = null;
export function setLifted(el: HTMLElement | null) {
  if (fsLifted === el) return;
  fsLifted?.removeAttribute('data-lifted');
  fsLifted = el;
  fsLifted?.setAttribute('data-lifted', '');
}
export const fsBusy = () => !!fsMorph && !fsMorph.dead;
/* 全屏时锁住页面滚动。滚动条的位置本来就一直留着（html 的 scrollbar-gutter），锁的时候只要把 overflow-y 换成 hidden */
function lockScroll(on: boolean) {
  document.documentElement.style.overflowY = on ? 'hidden' : '';
}
/* 开发模式的演示控制面板：在过渡结束时换到当前该在的位置（全屏时右上角，平时右下角），再淡入。正式构建里没有面板，这两个类名没有样式 */
export function demoTo() {
  document.body.classList.toggle('dev-fs', !!desk.get().full);
  document.body.classList.remove('dev-hide');
}
function landingRect(face: Face | null) {
  setLifted(null);
  return atFinalLayout(() => {
    const r = face ? rectOf(face.el.getBoundingClientRect()) : null;
    return face && r && onScreen(r) && !occluded(face, r) ? r : null;
  });
}
const winEls = () => [...document.querySelectorAll('#fs-stage > .w')] as HTMLElement[];
const curWin = () => {
  const ws = winEls();
  return ws[ws.length - 1] || null;
};
const cardOf = (w: HTMLElement) => w.querySelector(':scope > .w-card') as HTMLElement;

/* 暗层、图标条、窗口外面的光晕：不跟矩形走的东西，跟着进度走。open 为真时进度 0 在桌面、1 在全屏；关闭时反过来 */
function fsDrivers(open: boolean, to: FrameSpec) {
  const dim = document.getElementById('fs-dim')!,
    sw = document.getElementById('fs-switch')!;
  const glow = document.createElement('div');
  glow.className = 'fs-glow';
  glow.dataset.clone = '1';
  glow.style.cssText = `left:${to.left}px;top:${to.top}px;width:${to.width}px;height:${to.height}px;border-radius:${to.radius}px;opacity:${open ? 0 : 1}`;
  dim.style.willChange = 'opacity';
  /* 顶部的图标条逐帧改 opacity、transform：要先给它单独一层，不然每帧都重绘（里面选中项有 20px 的发光阴影，栅格很费）。过渡结束就撤掉 */
  sw.style.willChange = 'opacity, transform';
  /* h：0 在桌面、1 在全屏 */
  const apply = (h: number) => {
    dim.style.opacity = String(h);
    const o = h < 0.4 ? 0 : (h - 0.4) / 0.6;
    const e = open
      ? o * o * (3 - 2 * o)
      : h < 0.65
        ? 0
        : (() => {
            const t = (h - 0.65) / 0.35;
            return t * t * (3 - 2 * t);
          })();
    sw.style.opacity = String(e);
    sw.style.transform = `translateY(${(-8 * (1 - e)).toFixed(2)}px)`;
    glow.style.opacity = String(h < 0.5 ? 0 : (h - 0.5) / 0.5);
  };
  return {
    extras: [glow],
    driver: (p: number) => apply(open ? p : 1 - p),
    end: () => {
      sw.style.willChange = '';
    },
  };
}
function startFade(to: 0 | 1, ms: number, done: () => void) {
  const dim = document.getElementById('fs-dim')!,
    win = document.getElementById('fs-win')!;
  const a = animate([dim, win], { opacity: to ? [0, 1] : [1, 0] }, { duration: ms / 1000 });
  a.finished.then(done, done);
}
function finishClose(seq: number) {
  if (seq !== fsSeq || desk.get().full) return;
  desk.set({ fsWins: [] });
  document.body.classList.remove('fs-open');
  document.getElementById('fs-dim')?.removeAttribute('style');
  document.getElementById('fs-win')?.removeAttribute('style');
  document.getElementById('fs-switch')?.removeAttribute('style');
  demoTo();
  lockScroll(false);
  setLifted(null);
  sky.hold(false);
  if (nowCtl.expired) nowCtl.onLeave();
}

export function openFull(id: string, params?: FullParams): void {
  if (!hasDef(id)) return;
  const s = desk.get();
  if (s.full) {
    if (s.full.id === id) {
      if (params) {
        const wins = desk.get().fsWins;
        desk.set({
          full: { ...s.full, params },
          fsWins: wins.map((w, i) => (i === wins.length - 1 ? { ...w, params } : w)),
        });
      }
      return;
    }
    return switchFull(id, params);
  }
  /* 关到一半又打开：外框从此刻的位置退回全屏（反向），不跳；打开到一半被关、正在退回时又点开，也是掉头往全屏走。
     打开的是别的部件：先退回全屏，退回去之后再切换过去 */
  if (fsMorph && !fsMorph.dead && (fsMorph.kind === 'close' || fsMorph.kind === 'open')) {
    const m = fsMorph;
    const seq = ++fsSeq;
    desk.set({ full: { id: m.id, params: m.id === id ? params || {} : {}, seq } });
    setDir(m, m.kind === 'close' ? 0 : 1);
    if (m.id !== id) whenMorphsDone(isFsMorph, () => openFull(id, params));
    return;
  }
  /* 桌面上的形变还在走：等它走完再开（全屏要从桌面上那份长出来，它还在半路上） */
  if (morphStore.get().list.some((m) => !m.dead && isDeskMorph(m))) {
    whenMorphsDone(isDeskMorph, () => openFull(id, params));
    return;
  }
  if (desk.get().arranging) setArranging(false);
  popHandle.close();
  const seq = ++fsSeq;
  const anim = motionOn();
  const face = deskFace(id);
  let S = face ? rectOf(face.el.getBoundingClientRect()) : null;
  if (!face || !onScreen(S) || occluded(face, S!)) S = null;
  const from = S && face ? frameAt(face.inner, S, face.kind) : null;
  const key = ++fsKey;
  const clone = S && anim && face ? cloneFace(face) : null;
  document.body.classList.add('fs-open', 'dev-hide');
  lockScroll(true);
  sky.hold(true);
  flushSync(() =>
    desk.set({
      full: { id, params: params || {}, seq },
      fsWins: [{ key, id, params: params || {} }],
    }),
  );
  if (face)
    setLifted(
      S ? face.el : null,
    ); /* 被挡住、不从它那里长出来时不藏它：露在外面的那一截不会在第一帧突然消失 */
  document.getElementById('fs-win')!.focus({ preventScroll: true });
  if (!anim) {
    startFade(1, 180, demoTo);
    return;
  }
  const w = curWin()!;
  const card = cardOf(w);
  const F = rectOf(w.getBoundingClientRect());
  const kind = id === 'now' ? 'now' : 'card';
  const to = frameAt(card, F, kind);
  const A = from || frameAt(card, shrinkRect(F, 0.9), kind, 0);
  w.classList.add('is-morphing');
  const layers: LayerSpec[] = [lay(w, F, 'in', { tgt: card, blur: 12 })];
  if (clone && face) {
    clone.dataset.clone = '1';
    layers.push(face.kind === 'cap' ? capLay(clone, S!, 'out') : lay(clone, S!, 'out'));
  }
  const dr = fsDrivers(true, to);
  const rec = startMorph({
    id,
    host: 'fs',
    dur: DUR_MORPH,
    A,
    B: to,
    layers,
    extras: dr.extras,
    drivers: [dr.driver],
    kind: 'open',
    settle: (dir) => settleFs(rec, dir),
  });
  fsInfo.set(rec, { startKey: null, startId: null, endKey: key, endId: id, dr, waiters: [] });
  fsMorph = rec;
}

/* 一次全屏形变里涉及的窗口：起点那个（打开时没有）、终点那个。中途改道会有第三个，终点换成它 */
interface FsInfo {
  startKey: number | null;
  startId: string | null;
  endKey: number;
  endId: string;
  dr: { end: () => void };
  waiters: (() => void)[];
}
const fsInfo = new WeakMap<MorphRec, FsInfo>();
const stageEl = () => document.getElementById('fs-stage')!;
/* 到达一端：dir 为 1 留下终点那个窗口，为 0 留下起点那个（打开的起点是「没有」，也就是整个关掉） */
function settleFs(m: MorphRec, dir: 0 | 1) {
  const info = fsInfo.get(m)!;
  for (const w of winEls()) unmorph(w);
  info.dr.end();
  if (m.kind === 'close') {
    fsMorph = null;
    if (dir === 1) finishClose(fsSeq);
    else demoTo();
  } else if (m.kind === 'open') {
    if (dir === 1) {
      desk.set({ fsWins: desk.get().fsWins.filter((x) => x.key === info.endKey) });
      stageEl().classList.remove('is-switching');
      fsMorph = null;
      demoTo();
    } else {
      fsMorph = null;
      finishClose(fsSeq);
    }
  } else {
    const keep = dir === 1 ? info.endKey : info.startKey;
    desk.set({ fsWins: desk.get().fsWins.filter((x) => x.key === keep) });
    stageEl().classList.remove('is-switching');
    fsMorph = null;
  }
  for (const f of info.waiters) f();
}

export function closeFull() {
  const f = desk.get().full;
  if (!f)
    return fsMorph && !fsMorph.dead && fsMorph.kind === 'close'
      ? new Promise<void>((res) => fsInfo.get(fsMorph!)!.waiters.push(res))
      : Promise.resolve();
  /* 打开到一半（含中途改道过的）又关：外框从此刻的位置退回桌面（反向），不跳 */
  if (fsMorph && !fsMorph.dead && fsMorph.kind === 'open') {
    desk.set({ full: null });
    ++fsSeq;
    document.body.classList.add('dev-hide');
    const m = fsMorph;
    setDir(m, 0);
    return new Promise<void>((res) => fsInfo.get(m)!.waiters.push(res));
  }
  /* 切换到一半又关：先退回起点那个窗口，退回去之后再关 */
  if (fsMorph && !fsMorph.dead && fsMorph.kind === 'switch') {
    const m = fsMorph;
    const info = fsInfo.get(m)!;
    const w = desk.get().fsWins.find((x) => x.key === info.startKey);
    desk.set({ full: { id: info.startId!, params: w?.params || {}, seq: f.seq } });
    setDir(m, 0);
    return new Promise<void>((res) =>
      whenMorphsDone(isFsMorph, () => {
        closeFull().then(res);
      }),
    );
  }
  desk.set({ full: null });
  const seq = ++fsSeq;
  document.body.classList.add('dev-hide');
  if (!motionOn()) {
    return new Promise<void>((res) =>
      startFade(0, 160, () => {
        finishClose(seq);
        res();
      }),
    );
  }
  const face = deskFace(f.id);
  const T = landingRect(face);
  setLifted(
    T && face ? face.el : null,
  ); /* 落不到它上面时不藏它：露在外面的那一截一直看得见，不会在最后一帧突然出现 */
  const w = curWin()!;
  const card = cardOf(w);
  const F = rectOf(w.getBoundingClientRect());
  const kind = f.id === 'now' ? 'now' : 'card';
  const A = frameAt(card, F, kind);
  const B =
    T && face ? frameAt(face.inner, T, face.kind) : frameAt(card, shrinkRect(F, 0.9), kind, 0);
  const clone = T && face ? cloneFace(face) : null;
  w.classList.add('is-morphing');
  const layers: LayerSpec[] = [lay(w, F, 'out', { tgt: card, blur: T ? 12 : 8 })];
  if (clone && face) {
    clone.dataset.clone = '1';
    layers.push(face.kind === 'cap' ? capLay(clone, T!, 'in') : lay(clone, T!, 'in'));
  }
  const dr = fsDrivers(false, A);
  const p = new Promise<void>((res) => {
    const rec: MorphRec = startMorph({
      id: f.id,
      host: 'fs',
      dur: DUR_MORPH,
      A,
      B,
      layers,
      extras: dr.extras,
      drivers: [dr.driver],
      kind: 'close',
      settle: (dir) => {
        settleFs(rec, dir);
      },
    });
    fsInfo.set(rec, { startKey: null, startId: null, endKey: 0, endId: f.id, dr, waiters: [res] });
    fsMorph = rec;
  });
  return p;
}
/* 全屏里用顶部图标切换：外框不动（底色在两个部件之间过渡），旧内容略微缩小、变糊淡出，新内容从略小一点长到原样、从模糊里淡入。
   形变还在走时再点图标：不先跳到终点，而是从此刻的状态改去新的目标（redirectFull） */
export function switchFull(id: string, params?: FullParams): void {
  const old = desk.get().full;
  if (!old) return openFull(id, params);
  if (fsMorph && !fsMorph.dead && (fsMorph.kind === 'open' || fsMorph.kind === 'switch'))
    return redirectFull(fsMorph, id, params);
  const oldWin = curWin();
  const key = ++fsKey;
  flushSync(() =>
    desk.set({
      full: { id, params: params || {}, seq: old.seq },
      fsWins: [...desk.get().fsWins, { key, id, params: params || {} }],
    }),
  );
  const face = deskFace(id);
  setLifted(landingRect(face) && face ? face.el : null);
  const nw = curWin()!;
  const stage = stageEl();
  if (!motionOn() || !oldWin) {
    const done = () => {
      desk.set({ fsWins: desk.get().fsWins.filter((x) => x.key === key) });
      unmorph(nw);
      stage.classList.remove('is-switching');
    };
    const a = oldWin
      ? animate(oldWin, { opacity: [1, 0] }, { duration: 0.16 }).finished
      : Promise.resolve();
    const b = animate(nw, { opacity: [0, 1] }, { duration: 0.16 }).finished;
    Promise.all([a, b]).then(done, done);
    return;
  }
  const F = rectOf(nw.getBoundingClientRect());
  const oCard = cardOf(oldWin),
    nCard = cardOf(nw);
  const A = frameAt(oCard, F, old.id === 'now' ? 'now' : 'card'),
    B = frameAt(nCard, F, id === 'now' ? 'now' : 'card');
  oldWin.classList.add('is-morphing');
  nw.classList.add('is-morphing');
  stage.classList.add('is-switching');
  const layers: LayerSpec[] = [
    lay(oldWin, F, 'out', {
      tgt: oCard,
      blur: 8,
      win: [0.05, 0.6],
      at: (g) => shrinkRect(F, 1 - SWITCH_K * g),
    }),
    lay(nw, F, 'in', {
      tgt: nCard,
      blur: 10,
      win: [0.1, 0.72],
      at: (g) => shrinkRect(F, 1 - SWITCH_K * (1 - g)),
    }),
  ];
  const startKey = desk.get().fsWins.find((x) => x.id === old.id && x.key !== key)?.key ?? null;
  const rec: MorphRec = startMorph({
    id,
    host: 'fs',
    dur: DUR_MORPH,
    A,
    B,
    layers,
    drivers: [],
    kind: 'switch',
    timeDriven: true,
    settle: (dir) => settleFs(rec, dir),
  });
  fsInfo.set(rec, {
    startKey,
    startId: old.id,
    endKey: key,
    endId: id,
    dr: { end: () => {} },
    waiters: [],
  });
  fsMorph = rec;
}
const SWITCH_K = 0.015;

/* 形变还在走时点了图标条：不跳到终点，从此刻的状态改去新的目标。
   - 点的是起点那个窗口（切换到一半）：原路退回；点的是现在要去的：掉头再去；
   - 点的是第三个：加上它的窗口，从此刻的进度起淡入（模糊里长出来），原来「要去的」那个从此刻起淡出；外框、暗层接着往全屏走，
     全部由同一个进度 p 带着，所以反向、再改道都还是原路平滑 */
function redirectFull(m: MorphRec, id: string, params?: FullParams) {
  const info = fsInfo.get(m)!;
  const cur = desk.get().full!;
  const winParams = (key: number | null) =>
    desk.get().fsWins.find((x) => x.key === key)?.params || {};
  if (m.kind === 'switch' && id === info.startId) {
    desk.set({ full: { id, params: winParams(info.startKey), seq: cur.seq } });
    setDir(m, 0);
    return;
  }
  if (id === info.endId) {
    desk.set({ full: { id, params: params || winParams(info.endKey), seq: cur.seq } });
    setDir(m, 1);
    return;
  }
  const p0 = Math.min(1, Math.max(0, m.pv!.get()));
  const key = ++fsKey;
  flushSync(() =>
    desk.set({
      full: { id, params: params || {}, seq: cur.seq },
      fsWins: [...desk.get().fsWins, { key, id, params: params || {} }],
    }),
  );
  const face = deskFace(id);
  setLifted(landingRect(face) && face ? face.el : null);
  const nw = curWin()!;
  const F = rectOf(nw.getBoundingClientRect());
  const nCard = cardOf(nw);
  nw.classList.add('is-morphing');
  nw.style.willChange = 'transform';
  nCard.style.willChange = 'opacity, filter';
  stageEl().classList.add('is-switching');
  for (const L of m.layers) if (L.role === 'in') (L.fades ||= []).push(p0);
  m.layers.push(
    lay(nw, F, 'in', {
      tgt: nCard,
      blur: 10,
      win: [0.1, 0.72],
      from: p0,
      at: (g) => shrinkRect(F, 1 - SWITCH_K * (1 - g)),
    }),
  );
  m.id = id;
  info.endKey = key;
  info.endId = id;
  applyNow();
  /* 接着往终点走；已经快到终点了就把剩下的重新排一遍时长（不短于 180 ms，带着此刻的速度），免得新旧两个窗口在最后几帧里一下子换完 */
  if (m.dir === 1) {
    if (PIECES && !REVERSE_SNAP) glide(m);
  } else setDir(m, 1);
}

/* 点窗口外面（变暗的桌面、四周的边距）退出全屏。按下和松开都要在外面；顶部的图标那一条不算外面；过渡进行中不算 */
let fsPress: number | null = null;
const fsOutside = (t: Element | null) =>
  !!(t && t.closest && t.closest('#fs') && !t.closest('#fs-stage > .w, .fs-switch'));
export const fsPointer = {
  down(e: PointerEvent) {
    fsPress =
      desk.get().full && !fsBusy() && e.button === 0 && fsOutside(e.target as Element)
        ? e.pointerId
        : null;
  },
  up(e: PointerEvent) {
    const p = fsPress;
    fsPress = null;
    if (p === null || p !== e.pointerId || !desk.get().full || fsBusy()) return;
    if (!fsOutside(document.elementFromPoint(e.clientX, e.clientY))) return;
    closeFull();
  },
  cancel() {
    fsPress = null;
  },
};

/* ---------- 整理模式 ---------- */
export const ARR_STEP = 30,
  ARR_MAX = 150,
  ARR_DUR = 340;
let arrTok = 0;
function staggerArr() {
  let i = 0;
  const st: Record<string, number> = {};
  const set = (id: string) => {
    st[id] = Math.min(i++ * ARR_STEP, ARR_MAX);
  };
  const isl = document.querySelector('.island-slot .cap-wrap') as HTMLElement | null;
  if (isl?.dataset.id) set(isl.dataset.id);
  for (const c of document.querySelectorAll('.shelf > .cap-wrap'))
    set((c as HTMLElement).dataset.id!);
  for (const c of document.querySelectorAll('.desk > .w')) set((c as HTMLElement).dataset.id!);
  desk.set({ stagger: st });
}
export function setArranging(on: boolean) {
  const s = desk.get();
  if (on === s.arranging) return;
  /* 全屏的形变还在走：打开着就先原路退回，然后等它结束再进、出整理模式 */
  if (fsBusy()) {
    if (on && fsMorph!.kind !== 'close') closeFull();
    whenMorphsDone(isFsMorph, () => setArranging(on));
    return;
  }
  if (on && s.full) closeFull();
  const tok = ++arrTok;
  const wasFloat = on && s.nowFloat;
  staggerArr();
  if (!on) {
    /* 退出：提示条脱离文档流、固定在原处滑走，桌面马上往上让（由 Motion 的 layout 动画接住） */
    const bar = document.getElementById('arrange-bar');
    if (bar) {
      const r = bar.getBoundingClientRect();
      const tf = getComputedStyle(bar).transform;
      const ty = tf && tf !== 'none' ? new DOMMatrixReadOnly(tf).m42 : 0;
      desk.set({ barPos: { top: r.top - ty, left: r.left, width: r.width } });
    }
  }
  relayout(
    () => {
      if (wasFloat) {
        nowCtl.cancel();
        desk.set({ nowFloat: false, floatTop: null });
      }
      desk.set({ arranging: on, arrLeaving: !on });
    },
    { flipDur: ARR_DUR, flipEase: EASE_OUT, now: true },
  );
  if (on) {
    if (wasFloat) nowModel.clearEnded();
    return;
  }
  setTimeout(
    () => {
      if (tok !== arrTok) return;
      desk.set({ arrLeaving: false });
    },
    ARR_DUR + ARR_MAX + 40,
  );
  if (status.snapshot().count && nowCtl.mode === 'mini') nowCtl.autoExpand();
}

/* ---------- 其他 ---------- */
export function resetLayout() {
  if (deferFs(() => resetLayout())) return;
  const hadToday = hasDef('today');
  storage.del(LAYOUT_KEY);
  nowCtl.cancel();
  desk.set({ nowFloat: false, floatTop: null });
  if (desk.get().arranging) setArranging(false);
  relayout(() => {
    const L = DEFAULT_LAYOUT();
    if (hadToday) L.extra.push('today');
    for (const id of desk.get().layout.order) if (!L.order.includes(id)) L.order.push(id);
    desk.set({ layout: L });
  });
}
