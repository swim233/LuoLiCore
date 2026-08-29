/**
 * dev 文案面板的入口。只由 `scripts/copy/plugin.ts` 在 `COPY_EDIT=1` 的 dev server 上注入到
 * `main.ts` 的最前面：必须先于 `App.vue` 求值，因为组件模块顶层的标签表在 import 期即会
 * 调用 `__LUOLI_C__`。
 *
 * 刻意放在 `packages/webui/src` 之外：生产构建中没有任何位置能引用到该路径，插件自身也带
 * `apply: 'serve'`，两道闸同时成立才能保证不影响发布产物。
 */
import { createApp, reactive, ref } from "vue";
import { fillSlots } from "../slots.js";
import CopyPanel from "./CopyPanel.vue";

/** 改写中的文案。reactive 对缺失键的读取同样会被追踪，因此后续填入某个 key 可触发相关组件重渲染。 */
const overrides = reactive<Record<string, string>>({});
/** 本次会话中实际渲染过的条目，按首次出现顺序排列。渲染期不能修改响应式状态，因此使用普通 Map。 */
const seen = new Map<string, string>();
const tick = ref(0);
let pending = false;

/** 点选模式：点击界面上的某句文案，面板即定位到对应条目。Alt+点击 随时可用，无需先开启模式。 */
const picking = ref(false);
const picked = ref<string[]>([]);
/** 拖拽模式：按住界面上的某句文案直接拖动，释放时由面板写回源码。 */
const dragging = ref(false);
const dragged = ref<{ id: string; dx: number; dy: number } | null>(null);
/** 当前正在进行的拖拽：仅用于面板显示实时读数，不写入磁盘。 */
const dragLive = ref<{ id: string; dx: number; dy: number } | null>(null);

/**
 * 每条条目的占位符原文，按源码顺序排列。面板加载 `/__copy/entries` 之后填入：
 * 插桩侧只知道表达式的值（按同一顺序传入），不知道面板中显示的是 `{{ n }}` 还是 `${n}`。
 */
const slots: Record<string, string[]> = {};

declare global {
  interface Window {
    __LUOLI_C__: (id: string, original: string, values?: unknown[]) => string;
    __LUOLI_COPY__: {
      overrides: Record<string, string>;
      seen: Map<string, string>;
      tick: typeof tick;
      slots: Record<string, string[]>;
      picking: typeof picking;
      picked: typeof picked;
      dragging: typeof dragging;
      dragged: typeof dragged;
      dragLive: typeof dragLive;
    };
  }
}

/**
 * 覆盖层中的文案是带占位符的模板（`一共 {{ n }} 回`），而页面需要显示填充后的结果。
 * 因此取得覆盖后按 `slots` 将占位符替换为本次渲染的真实值，逐条按文本替换而不是按位置替换，
 * 这样占位符被移到句首或在同一句中出现两次时结果仍然正确。
 */
window.__LUOLI_C__ = (id, original, values) => {
  if (!seen.has(id)) {
    seen.set(id, original);
    // 渲染过程中修改响应式状态会触发 Vue 警告并可能形成自激循环，因此累积到下一帧再由面板读取。
    if (!pending) {
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        tick.value += 1;
      });
    }
  }
  const override = overrides[id];
  if (override === undefined) return original;
  const texts = slots[id];
  return values?.length && texts?.length
    ? fillSlots(override, texts, values)
    : override;
};
window.__LUOLI_COPY__ = {
  overrides,
  seen,
  tick,
  slots,
  picking,
  picked,
  dragging,
  dragged,
  dragLive,
};

/**
 * 自由拖拽。按住带 `data-copy-id` 的元素移动鼠标，实时修改其 `translate`，释放后由面板写入磁盘。
 *
 * 偏移量累加在已有值之上（源码中可能已存在 `translate`），因此开始时先读取一次当前值。
 * 使用 `translate` 而不是 `transform`：`transform` 已被按压反馈、入场动画、页面过渡占用，
 * 内联写入会整体覆盖它们；`translate` 是独立的变换属性，与 `transform` 叠加生效。
 *
 * 按住 Shift 锁定单轴：仅需水平移动时，手部抖动会引入数像素的竖直偏移。
 */
document.addEventListener(
  "mousedown",
  (event) => {
    if (!dragging.value || event.button !== 0) return;
    const target = event.target as HTMLElement | null;
    if (!target || target.closest("#luoli-copy-panel")) return;
    const node = target.closest<HTMLElement>("[data-copy-id]");
    if (!node) return;
    const id = (node.getAttribute("data-copy-id") ?? "").split(/\s+/)[0] ?? "";
    if (!id) return;
    event.preventDefault();
    event.stopPropagation();
    const base = /(-?[\d.]+)px\s+(-?[\d.]+)px/.exec(
      node.style.translate || getComputedStyle(node).translate || "",
    );
    const from = { x: Number(base?.[1] ?? 0), y: Number(base?.[2] ?? 0) };
    const origin = { x: event.clientX, y: event.clientY };
    const outline = node.style.outline;
    node.style.outline = "2px dashed #f59e0b";
    const onMove = (moved: MouseEvent): void => {
      let dx = moved.clientX - origin.x;
      let dy = moved.clientY - origin.y;
      if (moved.shiftKey) {
        if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      const next = { dx: Math.round(from.x + dx), dy: Math.round(from.y + dy) };
      node.style.translate = `${next.dx}px ${next.dy}px`;
      dragLive.value = { id, ...next };
    };
    const onUp = (): void => {
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("mouseup", onUp, true);
      node.style.outline = outline;
      const live = dragLive.value;
      dragLive.value = null;
      // 未实际移动时不写入磁盘：一次误点不应在源码中留下 `translate: 0px 0px`。
      if (live && (live.dx !== from.x || live.dy !== from.y))
        dragged.value = live;
    };
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("mouseup", onUp, true);
  },
  true,
);
/** 拖拽模式下屏蔽点击，否则释放动作会连带触发按钮、切页或提交表单。 */
document.addEventListener(
  "click",
  (event) => {
    if (!dragging.value) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest("#luoli-copy-panel")) return;
    event.preventDefault();
    event.stopPropagation();
  },
  true,
);

/**
 * 在捕获阶段拦截点击：插件为带文案的元素挂载了 `data-copy-id`，向上查找最近的一个即可确定点击对象。
 * 点选模式下需 `preventDefault` 与 `stopPropagation`：不拦截会连带触发按钮、切页或
 * 提交表单，而此时的操作意图是选取文案而不是执行功能。
 */
document.addEventListener(
  "click",
  (event) => {
    if (!picking.value && !event.altKey) return;
    const target = event.target as HTMLElement | null;
    if (!target || target.closest("#luoli-copy-panel")) return;
    const owner = target.closest("[data-copy-id]");
    event.preventDefault();
    event.stopPropagation();
    picked.value = owner
      ? (owner.getAttribute("data-copy-id") ?? "").split(/\s+/).filter(Boolean)
      : [];
  },
  true,
);
/** Esc 退出点选与拖动模式，避免鼠标操作被持续拦截。 */
document.addEventListener(
  "keydown",
  (event) => {
    if (event.key !== "Escape") return;
    picking.value = false;
    dragging.value = false;
  },
  true,
);

const host = document.createElement("div");
host.id = "luoli-copy-panel";
document.body.appendChild(host);
createApp(CopyPanel).mount(host);
