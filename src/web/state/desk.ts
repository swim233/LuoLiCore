import { createStore, useStore } from '@luoli/ui/store';
import { storage } from '@luoli/ui/storage';
import { DUR_MORPH, EASE_MORPH } from '@luoli/ui/easing';
import type { Bezier } from '@luoli/ui/easing';
import { bus } from '../model/bus';
import type { FullParams, SizeKey, WidgetDef, WidgetHandle } from '../widgets/types';
import { useEffect, useState } from 'react';

/* 桌面的状态层：部件定义（注册表）、布局（位置、大小档、隐藏、缩略）、「此刻」的形态、全屏、整理模式。
   外部 store + 动作（见 actions.ts）；组件用 useDesk(selector) 订阅 */
export const SIZES: Record<SizeKey, [number, number]> = {
  '1x1': [1, 1],
  '2x1': [2, 1],
  '1x2': [1, 2],
  '2x2': [2, 2],
  full: [99, 1],
};
export const SIZE_LABEL: Record<SizeKey, string> = {
  '1x1': '1×1',
  '2x1': '2×1',
  '1x2': '1×2',
  '2x2': '2×2',
  full: '通栏',
};
export const LAYOUT_KEY = 'luoli-webui-demo-layout-v1';
/* 后来新增的默认部件：浏览器里已经存过布局的用户，布局里没有它时自动加一次（放在最后）。加过就记在这里（部件 id 的列表），
   之后用户把它收进收纳盒、拖到哪儿都照用户的，不再自动加；「恢复默认布局」用的是默认布局，本来就有 */
const ADDED_KEY = 'luoli-webui-demo-added-widgets-v1';
const LATE_WIDGETS = ['tasks'];

export interface Layout {
  order: string[];
  size: Record<string, SizeKey>;
  hidden: Record<string, boolean>;
  mini: Record<string, boolean>;
  extra: string[];
}
export const DEFAULT_LAYOUT = (): Layout => ({
  order: ['now', 'sessions', 'chat', 'settings', 'today', 'tasks'],
  size: {},
  hidden: {},
  mini: { now: true },
  extra: [],
});

function loadLayout(): Layout {
  const d = DEFAULT_LAYOUT();
  const s = storage.get<Record<string, unknown> | null>(LAYOUT_KEY, null);
  const added = storage.get<unknown>(ADDED_KEY, []);
  const seen = Array.isArray(added) ? added.filter((x): x is string => typeof x === 'string') : [];
  const todo = LATE_WIDGETS.filter((id) => !seen.includes(id));
  if (todo.length) storage.set(ADDED_KEY, [...seen, ...todo]);
  if (!s || !Array.isArray(s.order)) return d;
  const rec = <T>(v: unknown) => (v && typeof v === 'object' ? (v as Record<string, T>) : {});
  const strs = (v: unknown[]) => v.filter((x): x is string => typeof x === 'string');
  const L: Layout = {
    order: strs(s.order),
    size: rec<SizeKey>(s.size),
    hidden: rec<boolean>(s.hidden),
    mini: rec<boolean>(s.mini),
    extra: Array.isArray(s.extra) ? strs(s.extra) : [],
  };
  for (const id of d.order)
    if (!L.order.includes(id) && !LATE_WIDGETS.includes(id)) L.order.push(id);
  for (const id of todo) if (!L.order.includes(id)) L.order.push(id);
  return L;
}

export interface FullState {
  id: string;
  params: FullParams;
  /** 每次进入全屏加一，用来判断异步收尾是不是已经过期 */
  seq: number;
}
export interface DeskState {
  layout: Layout;
  defsRev: number;
  arranging: boolean;
  arrLeaving: boolean;
  activeId: string | null;
  full: FullState | null;
  /** 全屏层里现在有的窗口（切换、关闭的过渡期间，旧窗口还要留着，直到过渡结束） */
  fsWins: { key: number; id: string; params: FullParams }[];
  /** 「此刻」浮起（自动展开） */
  nowFloat: boolean;
  floatTop: number | null;
  calling: boolean;
  fresh: string[];
  /** 整理提示条退出时脱离文档流，固定在这个位置淡出 */
  barPos: { top: number; left: number; width: number } | null;
  /** 整理模式的依次错开（--ad） */
  stagger: Record<string, number>;
  /** 其他卡片让位的 FLIP：时长（秒）和缓动，随这次重排里形变的最长时长变 */
  flip: { dur: number; ease: Bezier };
}

export const desk = createStore<DeskState>({
  layout: loadLayout(),
  defsRev: 0,
  arranging: false,
  arrLeaving: false,
  activeId: null,
  full: null,
  fsWins: [],
  nowFloat: false,
  floatTop: null,
  calling: false,
  fresh: [],
  barPos: null,
  stagger: {},
  flip: { dur: DUR_MORPH / 1000, ease: EASE_MORPH },
});
export const useDesk = <R>(sel: (s: DeskState) => R) => useStore(desk, sel);
export const saveLayout = () => storage.set(LAYOUT_KEY, desk.get().layout);

/* --- 注册表 --- */
const defs = new Map<string, WidgetDef & { _offs?: (() => void)[]; _h?: WidgetHandle }>();
export const getDef = (id: string) => defs.get(id);
export const hasDef = (id: string) => defs.has(id);
export const allDefs = () => [...defs.values()];
export function useDefsRev() {
  return useStore(desk, (s) => s.defsRev);
}
export function visibleIds(L = desk.get().layout) {
  return L.order.filter((id) => defs.has(id) && !L.hidden[id]);
}
export function sizeKey(id: string): SizeKey {
  const L = desk.get().layout;
  const k = L.size[id];
  return k && SIZES[k] ? k : defs.get(id)!.defaultSize;
}
export function spanOf(id: string, n: number): [number, number] {
  const [c, r] = SIZES[sizeKey(id)] || SIZES['1x1'];
  return [Math.min(c, n), r];
}

/* 总线订阅挂在部件上：部件移除时一起取消 */
export type FlashFn = (id: string, kind: 'stream' | 'error') => void;
export const hooks: {
  flash: FlashFn;
  openFull: (id: string, params?: FullParams) => void;
  afterMorph: (id: string, fn: () => void) => () => void;
} = {
  flash: () => {},
  openFull: () => {},
  afterMorph: (_id, fn) => {
    fn();
    return () => {};
  },
};

export function registerWidget(def: WidgetDef) {
  const offs: (() => void)[] = [];
  const handle: WidgetHandle = {
    id: def.id,
    on(type, fn) {
      offs.push(bus.on(type, fn));
    },
    flash(kind) {
      hooks.flash(def.id, kind);
    },
    openFull(target, params) {
      hooks.openFull(target || def.id, params);
    },
    get isFull() {
      const f = desk.get().full;
      return !!(f && f.id === def.id);
    },
    afterMorph(fn) {
      return hooks.afterMorph(def.id, fn);
    },
  };
  const entry = Object.assign(def, { _offs: offs, _h: handle });
  defs.set(def.id, entry);
  const L = desk.get().layout;
  if (!L.order.includes(def.id)) L.order.push(def.id);
  const ret = def.init?.(handle);
  if (typeof ret === 'function') offs.push(ret);
  desk.set({ defsRev: desk.get().defsRev + 1 });
}
export function unregisterWidget(id: string) {
  const d = defs.get(id);
  if (!d) return;
  d._offs?.forEach((f) => f());
  defs.delete(id);
  const s = desk.get();
  desk.set({ defsRev: s.defsRev + 1, fresh: s.fresh.filter((x) => x !== id) });
}
export const handleOf = (id: string) => defs.get(id)?._h as WidgetHandle;

/* 缩略文字、小字：部件声明的事件来了就重算，另外每 30 秒重算一次（「3 分钟前」要变） */
export function useWidgetRefresh(def: WidgetDef | undefined) {
  const [, setN] = useState(0);
  useEffect(() => {
    if (!def) return;
    const bump = () => setN((n) => n + 1);
    const offs = (def.refreshOn || []).map((t) => bus.on(t, bump));
    const timer = setInterval(bump, 30000);
    return () => {
      offs.forEach((f) => f());
      clearInterval(timer);
    };
  }, [def]);
}
