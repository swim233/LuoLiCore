/**
 * dev 文案面板的入口。只被 `scripts/copy/plugin.ts` 在 `COPY_EDIT=1` 的 dev server 上注入到
 * `main.ts` 的**最前面** —— 必须先于 `App.vue` 求值，因为组件模块顶层的标签表在 import 期就会
 * 调 `__LUOLI_C__`。
 *
 * 刻意放在 `packages/webui/src` 之外：生产构建里没有任何一处引用得到这个路径，插件本身也带
 * `apply: 'serve'`，两道闩都断了才谈得上「不影响 release」。
 */
import { createApp, reactive, ref } from 'vue';
import { fillSlots } from '../slots.js';
import CopyPanel from './CopyPanel.vue';

/** 改写中的文案。reactive 的缺键读取也会被追踪，所以后填一个 key 能触发用到它的组件重渲染。 */
const overrides = reactive<Record<string, string>>({});
/** 这次会话里**真的渲染过**的条目，按第一次出现的顺序。渲染期不能碰响应式状态，所以放普通 Map。 */
const seen = new Map<string, string>();
const tick = ref(0);
let pending = false;

/** 点选模式：界面上点哪句，面板就跳到那一条。Alt+点击 随时可用，不必先开模式。 */
const picking = ref(false);
const picked = ref<string[]>([]);
/** 拖拽模式：按住界面上的一句话直接拖。落下时面板负责写回源码。 */
const dragging = ref(false);
const dragged = ref<{ id: string; dx: number; dy: number } | null>(null);
/** 正在拖的那一下：仅用于面板显示实时读数，不落盘。 */
const dragLive = ref<{ id: string; dx: number; dy: number } | null>(null);

/**
 * 每条条目的占位符原文，按源码顺序。面板加载 `/__copy/entries` 之后填进来 ——
 * 插桩那侧只知道**表达式的值**（按同一个顺序传进来），不知道人在面板里看到的是 `{{ n }}` 还是 `${n}`。
 */
const slots: Record<string, string[]> = {};

declare global {
  interface Window {
    __LUOLI_C__: (id: string, original: string, values?: unknown[]) => string;
    __LUOLI_COPY__: { overrides: Record<string, string>; seen: Map<string, string>; tick: typeof tick;
      slots: Record<string, string[]>;
      picking: typeof picking; picked: typeof picked;
      dragging: typeof dragging; dragged: typeof dragged; dragLive: typeof dragLive };
  }
}

/**
 * 覆盖层里那句话是**带占位的模板**（`一共 {{ n }} 回`），而页面要显示的是填好的那句。
 * 所以拿到覆盖之后按 `slots` 把占位换成这一次渲染的真实值 —— 逐条按**文本**替换而不是按位置，
 * 于是人把占位挪到句首、或者一句里出现两次，都还对。
 */
window.__LUOLI_C__ = (id, original, values) => {
  if (!seen.has(id)) {
    seen.set(id, original);
    // 渲染过程中改响应式状态会被 Vue 警告、还可能自激。攒到下一帧再让面板去读。
    if (!pending) { pending = true; requestAnimationFrame(() => { pending = false; tick.value += 1; }); }
  }
  const override = overrides[id];
  if (override === undefined) return original;
  const texts = slots[id];
  return values?.length && texts?.length ? fillSlots(override, texts, values) : override;
};
window.__LUOLI_COPY__ = { overrides, seen, tick, slots, picking, picked, dragging, dragged, dragLive };

/**
 * 自由拖拽。按住带 `data-copy-id` 的元素移动鼠标，实时改它的 `translate`，松手交给面板落盘。
 *
 * 偏移是**累加**在已有值上的（源码里可能已经写着一个 `translate`），所以起手先读一次当前值。
 * 用 `translate` 而不是 `transform`：`transform` 被按压反馈、入场动画、页面过渡用着，
 * 内联写上去会把它们整条顶掉；`translate` 是独立变换属性，与 `transform` 叠加。
 *
 * 按住 Shift 锁定单轴 —— 只想水平挪的时候，手不稳会带出几像素的竖直偏移。
 */
document.addEventListener('mousedown', (event) => {
  if (!dragging.value || event.button !== 0) return;
  const target = event.target as HTMLElement | null;
  if (!target || target.closest('#luoli-copy-panel')) return;
  const node = target.closest<HTMLElement>('[data-copy-id]');
  if (!node) return;
  const id = (node.getAttribute('data-copy-id') ?? '').split(/\s+/)[0] ?? '';
  if (!id) return;
  event.preventDefault();
  event.stopPropagation();
  const base = /(-?[\d.]+)px\s+(-?[\d.]+)px/.exec(node.style.translate || getComputedStyle(node).translate || '');
  const from = { x: Number(base?.[1] ?? 0), y: Number(base?.[2] ?? 0) };
  const origin = { x: event.clientX, y: event.clientY };
  const outline = node.style.outline;
  node.style.outline = '2px dashed #f59e0b';
  const onMove = (moved: MouseEvent): void => {
    let dx = moved.clientX - origin.x;
    let dy = moved.clientY - origin.y;
    if (moved.shiftKey) { if (Math.abs(dx) >= Math.abs(dy)) dy = 0; else dx = 0; }
    const next = { dx: Math.round(from.x + dx), dy: Math.round(from.y + dy) };
    node.style.translate = `${next.dx}px ${next.dy}px`;
    dragLive.value = { id, ...next };
  };
  const onUp = (): void => {
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('mouseup', onUp, true);
    node.style.outline = outline;
    const live = dragLive.value;
    dragLive.value = null;
    // 没真的动过就不落盘 —— 一次误点不该在源码里留下 `translate: 0px 0px`。
    if (live && (live.dx !== from.x || live.dy !== from.y)) dragged.value = live;
  };
  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('mouseup', onUp, true);
}, true);
/** 拖拽模式下屏蔽点击，否则松手那一下会顺带触发按钮、切页、提交表单。 */
document.addEventListener('click', (event) => {
  if (!dragging.value) return;
  const target = event.target as HTMLElement | null;
  if (target?.closest('#luoli-copy-panel')) return;
  event.preventDefault();
  event.stopPropagation();
}, true);

/**
 * 捕获阶段拦点击：插件给带文案的元素挂了 `data-copy-id`，往上找最近的一个就知道点的是哪几句。
 * 点选模式下要 `preventDefault` + `stopPropagation` —— 不拦的话这一下会顺带触发按钮、切页、
 * 提交表单，人是来指字的，不是来操作的。
 */
document.addEventListener('click', (event) => {
  if (!picking.value && !event.altKey) return;
  const target = event.target as HTMLElement | null;
  if (!target || target.closest('#luoli-copy-panel')) return;
  const owner = target.closest('[data-copy-id]');
  event.preventDefault();
  event.stopPropagation();
  picked.value = owner ? (owner.getAttribute('data-copy-id') ?? '').split(/\s+/).filter(Boolean) : [];
}, true);
/** Esc 退出点选 / 拖动，免得鼠标被「黏住」。 */
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  picking.value = false;
  dragging.value = false;
}, true);

const host = document.createElement('div');
host.id = 'luoli-copy-panel';
document.body.appendChild(host);
createApp(CopyPanel).mount(host);
