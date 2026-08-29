<script setup lang="ts">
/**
 * dev 文案面板：浮在真实界面之上的校对视图。左侧是产品界面，这里列出本屏实际渲染过的每一句。
 *
 * 本屏的判定依靠渲染期收集而不是 DOM 扫描：属性里的 `title` / `aria-label` / `placeholder`，以及
 * toast 的文字都不在 DOM 文本里，扫描 DOM 无法发现。
 *
 * 所有改动都只是暂存：改文案走内存覆盖层，版式 / 偏移 / 隐藏 / 删除走 DOM 预览。源码不发生任何
 * 变化，直到点击〔保存〕，那一刻所有暂存改动一次写完（见 `extract.ts` 的 `applyChanges`：
 * offset 均基于同一份原文测量，逐条写盘会让后续全部偏移）。撤销分两级：未保存的逐步回退
 * （Ctrl+Z），已保存的按历史栈回退任意一步（`history.ts`）。
 *
 * 两条设计约束，修改这个文件时需保持：
 *
 * - 每一条的预览使用它在页面上真实的计算样式渲染（`refreshType`）。这是整个面板存在的理由：
 *   在 13px 通用无衬线字体下判断不了一个 `.68rem` 标题的字距是否合适。改字号 / 字重时预览同步变化，
 *   所见即保存后的效果。
 * - 面板自身的样式不能受产品 CSS 影响。`styles.css` 里有 `button, input, select, textarea
 *   { font: inherit }` 与 `body` 上的字体，而正在修改的就是那套 CSS。因此根节点显式重置，
 *   所有规则限定在 `.cp*` 前缀下。
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { missingSlots as missing } from "../slots.js";

interface Meta {
  id: string;
  file: string;
  line: number;
  surface: string;
  kind: string;
  where: string;
  core: string;
  slots: string[];
  pinned: string[];
  owner?: string;
}
interface Box {
  file: string;
  tag: string;
  utilities: Partial<Record<Group, string>>;
  offset: { dx: number; dy: number };
  basis: number | null;
  guards: string[];
  inner: number;
}
interface Step {
  id: string;
  at: number;
  applied: number;
  files: string[];
}

/**
 * 与 `extract.ts` 的 `UTILITIES` 一一对应（`tests/copy-edit.test.ts` 约束 prefix 一致）。
 * 档位固定、不开放任意数值：尺度一旦逐句微调，界面整体的节奏很快就不再一致。
 */
const GROUPS = {
  push: {
    prefix: "u-push",
    tiers: [
      ["start", "靠左"],
      ["center", "居中"],
      ["end", "靠右"],
    ],
  },
  text: {
    prefix: "u-text",
    tiers: [
      ["start", "左"],
      ["center", "中"],
      ["end", "右"],
    ],
  },
  gapx: {
    prefix: "u-gap-x",
    tiers: [
      ["0", "无"],
      ["1", "窄"],
      ["2", "宽"],
      ["3", "更宽"],
    ],
  },
  gapy: {
    prefix: "u-gap-y",
    tiers: [
      ["0", "无"],
      ["1", "窄"],
      ["2", "宽"],
      ["3", "更宽"],
    ],
  },
  size: {
    prefix: "u-size",
    tiers: [
      ["xs", "更小"],
      ["sm", "小"],
      ["lg", "大"],
      ["xl", "更大"],
    ],
  },
  weight: {
    prefix: "u-weight",
    tiers: [
      ["400", "常规"],
      ["500", "中"],
      ["600", "半粗"],
      ["700", "粗"],
    ],
  },
  slant: {
    prefix: "u-slant",
    tiers: [
      ["italic", "斜"],
      ["normal", "正"],
    ],
  },
  display: { prefix: "u-display", tiers: [["none", "隐藏"]] },
} as const;
type Group = keyof typeof GROUPS;

/** 一件暂存改动。`before` 记的是它之前的暂存值（没有就是 undefined），撤销靠它回退一步。 */
interface Staged {
  slot: string;
  kind: "text" | "class" | "style" | "remove" | "basis";
  /** 文案改动指向条目；版式 / 偏移 / 删除指向元素。两者的 slot 键因此不同。 */
  id?: string;
  key?: string;
  group?: Group;
  value?: string;
  dx?: number;
  dy?: number;
  px?: number | null;
}

const store = window.__LUOLI_COPY__;
const open = ref(true);
const mode = ref<"live" | "all">("live");
const query = ref("");
const meta = ref<Record<string, Meta>>({});
const boxes = ref<Record<string, Box>>({});
const saving = ref(false);
const message = ref("");
const focused = ref("");
const confirming = ref("");
const history = ref<Step[]>([]);
const showHistory = ref(false);
const booting = ref(true);
const committed = ref(false);
/** 当前暂存的目标态，一个位置只留最后一次。`slot` = 种类 + 目标（+ 组）。 */
const staged = ref<Record<string, Staged>>({});
/** 撤销栈：每一步记下改的是哪个 slot、以及改之前那儿是什么。 */
const undoStack = ref<Array<{ slot: string; before: Staged | undefined }>>([]);
/** 选中那一条的真实排版，抄自页面上的元素。见文件头第一条约束。 */
const typeCss = ref<Record<string, string>>({});

// ── 浮窗：位置 / 尺寸 / 贴边，全部记在 localStorage ──────────────────────
/**
 * 浮窗形态。`dock` 是贴回右侧那一档：脱开后面板会遮住正在编辑的区域，而调整排版时需要看到
 * 页面全貌，因此两种形态都保留，支持一键切换。
 */
interface Frame {
  mode: "float" | "dock";
  x: number;
  y: number;
  w: number;
  h: number;
}
const SEAT = "luoli.copy.frame";
const fallback = (): Frame => ({
  mode: "float",
  x: Math.max(16, window.innerWidth - 452),
  y: 64,
  w: 428,
  h: Math.min(680, window.innerHeight - 96),
});
const frame = ref<Frame>(fallback());
const dragMode = ref<"" | "move" | "size">("");
/** 收进视口。窗口缩小或更换显示器后，保存的位置可能完全落在视口之外，此时面板不可见。 */
function clamp(next: Frame): Frame {
  const w = Math.min(Math.max(next.w, 320), window.innerWidth);
  const h = Math.min(Math.max(next.h, 240), window.innerHeight);
  return {
    mode: next.mode,
    w,
    h,
    x: Math.min(Math.max(next.x, 8 - w + 120), window.innerWidth - 120),
    y: Math.min(Math.max(next.y, 0), window.innerHeight - 56),
  };
}
onMounted(() => {
  try {
    const saved = JSON.parse(
      localStorage.getItem(SEAT) ?? "null",
    ) as Frame | null;
    if (saved && typeof saved.x === "number")
      frame.value = clamp({ ...fallback(), ...saved });
  } catch {
    /* 存坏了就用默认位置，不值得为它报错 */
  }
  setTimeout(() => {
    booting.value = false;
  }, 700);
});
watch(
  frame,
  (next) => {
    localStorage.setItem(SEAT, JSON.stringify(next));
  },
  { deep: true },
);
const onResize = (): void => {
  frame.value = clamp(frame.value);
};
onMounted(() => window.addEventListener("resize", onResize));
onUnmounted(() => window.removeEventListener("resize", onResize));

/** 拖标题栏移动、拖右下角改尺寸。只响应标题栏与那个把手：从内容区起拖会与拖动页面元素冲突。 */
function grab(event: PointerEvent, what: "move" | "size"): void {
  if (event.button !== 0) return;
  if (what === "move" && (event.target as HTMLElement).closest("button"))
    return;
  event.preventDefault();
  dragMode.value = what;
  const from = { ...frame.value };
  const origin = { x: event.clientX, y: event.clientY };
  const onMove = (moved: PointerEvent): void => {
    const dx = moved.clientX - origin.x;
    const dy = moved.clientY - origin.y;
    frame.value =
      what === "move"
        ? { ...frame.value, mode: "float", x: from.x + dx, y: from.y + dy }
        : {
            ...frame.value,
            w: from.w + (from.mode === "dock" ? -dx : dx),
            h: from.h + dy,
          };
  };
  const onUp = (): void => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    dragMode.value = "";
    frame.value = clamp(frame.value);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}
const seat = computed(() =>
  frame.value.mode === "dock"
    ? { top: "0px", right: "0px", bottom: "0px", width: `${frame.value.w}px` }
    : {
        top: `${frame.value.y}px`,
        left: `${frame.value.x}px`,
        width: `${frame.value.w}px`,
        height: `${frame.value.h}px`,
      },
);

async function loadMeta(): Promise<void> {
  const payload = await fetch("/__copy/entries").then(
    (r) =>
      r.json() as Promise<{ entries: Meta[]; elements: Record<string, Box> }>,
  );
  meta.value = Object.fromEntries(payload.entries.map((row) => [row.id, row]));
  boxes.value = payload.elements;
  // 占位符原文交给运行时：运行时只持有表达式的值（顺序一致），还原需要这份文本。
  for (const key of Object.keys(store.slots)) delete store.slots[key];
  for (const row of payload.entries)
    if (row.slots.length) store.slots[row.id] = row.slots;
  store.tick.value += 1;
}
async function loadHistory(): Promise<void> {
  history.value = await fetch("/__copy/history")
    .then((r) => r.json() as Promise<{ steps: Step[] }>)
    .then((r) => r.steps.reverse());
}
onMounted(() => {
  void loadMeta();
  void loadHistory();
});

/** 新出现的排在前面：切一页过去，那一页的文案就浮到顶上。 */
const live = computed<Meta[]>(() => {
  void store.tick.value;
  const rows: Meta[] = [];
  for (const id of [...store.seen.keys()].reverse()) {
    const row = meta.value[id];
    if (row) rows.push(row);
  }
  return rows;
});
const rows = computed<Meta[]>(() => {
  const needle = query.value.trim().toLowerCase();
  const base = mode.value === "live" ? live.value : Object.values(meta.value);
  if (!needle) return base;
  return base.filter((row) =>
    `${row.core} ${row.where} ${row.surface} ${row.file}`
      .toLowerCase()
      .includes(needle),
  );
});
// `basis:` 不算一件改动：它是字号档的随行件（见 `tune`），计进去点一下字号就显示「改了 2」。
const dirty = computed(
  () =>
    Object.keys(staged.value).filter((slot) => !slot.startsWith("basis:"))
      .length,
);
/**
 * 缺少哪些占位。判据与落盘侧共用同一份（`../slots.js`）：各写一份的必然结果是面板提示可以保存
 * 而落盘拒绝，或者反过来面板拦下本可保存的内容。
 */
const missingSlots = (row: Meta): string[] => {
  const typed = store.overrides[row.id]?.trim();
  return typed ? missing(typed, row.core, row.slots) : [];
};
/**
 * 是否有条目缺少占位。判据取决于暂存了什么，而不是当前可见什么：按视图计算时，改坏一条后
 * 用搜索把它过滤掉，保存按钮就会重新可用（落盘一侧仍会拒绝，但界面已给出了错误反馈）。
 */
const blocked = computed(() =>
  Object.values(staged.value).some((entry) => {
    const row =
      entry.kind === "text" && entry.id ? meta.value[entry.id] : undefined;
    return row ? missingSlots(row).length > 0 : false;
  }),
);
const boxOf = (row: Meta): Box | null =>
  row.owner ? (boxes.value[row.owner] ?? null) : null;
/**
 * 这一行是否有未保存的改动。文案按行记录、版式按元素记录：后者在源码上就是一个元素，
 * 而 185 个元素被两条以上文案共用（472 条），按行记录时两行各记一份且状态互不可见。
 */
const touched = (row: Meta): boolean =>
  Object.keys(staged.value).some(
    (slot) =>
      slot.split(":")[1] === row.id ||
      (row.owner ? slot.split(":")[1] === row.owner : false),
  );
/** 一个元素上关联的那几条文案 id：元素级预览依靠它们的 `data-copy-id` 定位 DOM 节点。 */
const idsOf = (owner: string): string[] =>
  Object.values(meta.value)
    .filter((row) => row.owner === owner)
    .map((row) => row.id);

// ── 暂存：改的全是 DOM 预览，源码一个字节都不动，直到按保存 ────────────────
/**
 * 记录一步，并使撤销栈可以回退。
 *
 * `coalesce` 用于连续输入：同一个输入框每次按键都压入一步时，撤销一次只回退一个字符，
 * 需按十次才能回到上一句，因此同一个 slot 的连续编辑合并为一步。
 */
function stage(next: Staged, coalesce = false): void {
  const last = undoStack.value[undoStack.value.length - 1];
  if (!(coalesce && last?.slot === next.slot))
    undoStack.value.push({ slot: next.slot, before: staged.value[next.slot] });
  staged.value = { ...staged.value, [next.slot]: next };
}
/** 撤销某个 slot 的暂存态。它同样进入撤销栈：取消删除本身也是一步，可以回退。 */
function unstage(slot: string): void {
  undoStack.value.push({ slot, before: staged.value[slot] });
  const next = { ...staged.value };
  delete next[slot];
  staged.value = next;
  paint(slot);
}
/** 把某个 slot 的暂存态（或没有暂存时的源码原状）画到 DOM 上。 */
function paint(slot: string): void {
  const entry = staged.value[slot];
  const [kind, target, group] = slot.split(":");
  if (kind === "text") {
    if (entry) store.overrides[target ?? ""] = String(entry.value ?? "");
    else delete store.overrides[target ?? ""];
    return;
  }
  // 元素级的 slot 记录的是元素 key，而 DOM 上挂的是条目 id，因此用该元素上所有条目的
  // 选择器一并查找。（同一个元素可能被两条文案共用，任一条都能定位到它。）
  const selector = idsOf(target ?? "")
    .map((each) => `[data-copy-id~="${each}"]`)
    .join(",");
  const nodes = selector
    ? document.querySelectorAll<HTMLElement>(selector)
    : [];
  if (kind === "basis") {
    const px = entry ? entry.px : (boxes.value[target ?? ""]?.basis ?? null);
    for (const node of nodes)
      node.style.setProperty("--u-base", px ? `${px}px` : "");
    return;
  }
  if (kind === "remove") {
    // 预览的效果是元素真正不可见，而不是加一个标记：删掉一个 flex 子元素会让相邻元素重新排列，
    // 而那正是保存之前唯一需要确认的内容。面板那一行仍在，随时可以取消。
    for (const node of nodes) node.classList.toggle("cp-ghost", Boolean(entry));
    return;
  }
  if (kind === "class") {
    const spec = GROUPS[group as Group] ?? GROUPS.push;
    const fallbackTier =
      boxes.value[target ?? ""]?.utilities[group as Group] ?? "";
    // 没有暂存值时回到源码里那一档（`boxes` 是磁盘状态的基线，保存之前不会变）。
    const value = entry ? String(entry.value ?? "") : fallbackTier;
    for (const node of nodes) {
      for (const [each] of spec.tiers)
        node.classList.remove(`${spec.prefix}-${each}`);
      if (value) node.classList.add(`${spec.prefix}-${value}`);
    }
    const shown = meta.value[focused.value];
    if (shown?.owner === target) void nextTick(() => refreshType(shown));
    return;
  }
  const base = boxes.value[target ?? ""]?.offset ?? { dx: 0, dy: 0 };
  const dx = entry ? Number(entry.dx ?? 0) : base.dx;
  const dy = entry ? Number(entry.dy ?? 0) : base.dy;
  for (const node of nodes)
    node.style.translate = dx === 0 && dy === 0 ? "" : `${dx}px ${dy}px`;
}

function undo(): void {
  const step = undoStack.value.pop();
  if (!step) return;
  const next = { ...staged.value };
  if (step.before) next[step.slot] = step.before;
  else delete next[step.slot];
  staged.value = next;
  paint(step.slot);
}
function discardAll(): void {
  const slots = Object.keys(staged.value);
  staged.value = {};
  undoStack.value = [];
  for (const slot of slots) paint(slot);
}

/**
 * 复制选中条目在页面上的真实排版。字号限制在 11–30px：一个 1.55rem 的大号数字原样
 * 放进 400px 宽的面板会撑破整行，而判断字重与字距并不需要原始尺寸。
 */
function refreshType(row: Meta): void {
  const node = document.querySelector<HTMLElement>(
    `[data-copy-id~="${row.id}"]`,
  );
  if (!node) {
    typeCss.value = {};
    return;
  }
  const style = getComputedStyle(node);
  const px = Math.min(
    Math.max(Number.parseFloat(style.fontSize) || 13, 11),
    30,
  );
  typeCss.value = {
    fontFamily: style.fontFamily,
    fontSize: `${px}px`,
    fontWeight: style.fontWeight,
    fontStyle: style.fontStyle,
    letterSpacing: style.letterSpacing,
    textTransform: style.textTransform,
  };
}
function focus(row: Meta): void {
  focused.value = row.id;
  confirming.value = "";
  refreshType(row);
  // 展开后那一条会增加六行控件，很容易整块落在可视区之外：选中一条却看不到它的控件
  // 属于点击无反应的一种。`nearest` 不做多余的滚动。
  void nextTick(() =>
    document
      .querySelector(`#luoli-copy-panel [data-row="${row.id}"]`)
      ?.scrollIntoView({ block: "nearest", behavior: "smooth" }),
  );
}

/** 界面上点了一句 → 切到能看见它的视图、滚过去、给输入框焦点。 */
watch(store.picked, async (ids) => {
  if (!ids.length) {
    message.value =
      "这一处没有登记在册的文案（可能是图标、纯数字，或来自服务端）";
    return;
  }
  const first = ids.find((id) => meta.value[id]) ?? "";
  if (!first) {
    await loadMeta();
  }
  const target = ids.find((id) => meta.value[id]) ?? "";
  if (!target) {
    message.value = "点到的 id 不在册（源码刚改过？点〔重新扫描〕）";
    return;
  }
  query.value = "";
  if (!live.value.some((row) => row.id === target)) mode.value = "all";
  const row = meta.value[target];
  if (row) focus(row);
  await nextTick();
  const node = document.querySelector<HTMLElement>(`[data-row="${target}"]`);
  node?.scrollIntoView({ block: "center", behavior: "smooth" });
  node?.querySelector("textarea")?.focus();
});

/**
 * 间距调整左间距还是上间距，取决于真实容器的排列方向。
 *
 * 这套界面里有 86 处 `display: flex` 与 95 处 `display: grid`，只有 5 处 `flex-direction: column`：
 * 横向排列的容器中与上一块的距离是水平方向的，标注为上间距即与实际不符。
 */
function axis(row: Meta): "gapx" | "gapy" {
  const node = row.owner
    ? document.querySelector<HTMLElement>(`[data-copy-id~="${row.id}"]`)
    : null;
  const box = node?.parentElement;
  if (!box) return "gapy";
  const style = getComputedStyle(box);
  const flex = style.display.includes("flex");
  const grid = style.display.includes("grid");
  const columns = grid
    ? style.gridTemplateColumns.split(/\s+/).filter(Boolean).length
    : 0;
  if (flex && style.flexDirection.startsWith("column")) return "gapy";
  if (!flex && !(grid && columns > 1)) return "gapy";
  return "gapx";
}

/** 悬停时把界面上那句圈出来。只对最终落成可见文字的那些有效，属性类的找不到就什么都不做。 */
let marked: HTMLElement | null = null;
function unmark(): void {
  if (marked) {
    marked.style.outline = "";
    marked.style.outlineOffset = "";
    marked = null;
  }
}
function mark(row: Meta): void {
  unmark();
  const owner = row.owner
    ? document.querySelector<HTMLElement>(`[data-copy-id~="${row.id}"]`)
    : null;
  const host = owner ?? findByText(row);
  if (!host) return;
  host.style.outline = "2px solid #ffb020";
  host.style.outlineOffset = "2px";
  host.scrollIntoView({ block: "center", behavior: "smooth" });
  marked = host;
}
function findByText(row: Meta): HTMLElement | null {
  const text = (store.overrides[row.id]?.trim() || row.core)
    .replace(/\{\{[^}]*\}\}|\$\{[^}]*\}/g, "")
    .trim();
  if (text.length < 2) return null;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const host = node.parentElement;
    if (!host || host.closest("#luoli-copy-panel")) continue;
    if ((node.textContent ?? "").includes(text)) return host;
  }
  return null;
}

/** 把暂存的目标态折成后端要的 changes。 */
function payload(): unknown[] {
  return Object.values(staged.value).flatMap((entry) => {
    if (entry.kind === "text") {
      const row = entry.id ? meta.value[entry.id] : undefined;
      return row
        ? [{ kind: "text", file: row.file, id: row.id, value: entry.value }]
        : [];
    }
    const box = entry.key ? boxes.value[entry.key] : undefined;
    if (!box || !entry.key) return [];
    if (entry.kind === "remove")
      return [{ kind: "remove", file: box.file, key: entry.key }];
    if (entry.kind === "basis")
      return [
        { kind: "basis", file: box.file, key: entry.key, px: entry.px ?? null },
      ];
    if (entry.kind === "class")
      return [
        {
          kind: "class",
          file: box.file,
          key: entry.key,
          group: entry.group,
          value: entry.value,
        },
      ];
    return [
      {
        kind: "style",
        file: box.file,
        key: entry.key,
        dx: entry.dx,
        dy: entry.dy,
      },
    ];
  });
}

async function save(): Promise<void> {
  if (!dirty.value) return;
  saving.value = true;
  try {
    const result = await fetch("/__copy/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ changes: payload() }),
    }).then(
      (r) =>
        r.json() as Promise<{
          applied: number;
          refused: string[];
          stuck?: string[];
          history?: number;
        }>,
    );
    /**
     * 已落盘的清除（源码已更新，保留只会与新基线冲突），未落盘的保留。
     *
     * 这里此前是无条件清空：服务端返回拒绝 3 处时，那三处既未落盘、用户刚输入的内容也一并丢失。
     * 对一个以改动安全为前提的工具，这是最不应出现的失败方式。`stuck` 即为此新增：
     * `refused` 只是给人阅读的说明，无法据它判断应保留哪几条。
     *
     * 不清除 `seen`：清除后，本屏上未被改动、因此不会重新渲染的那些句子会整批从列表消失，
     * 需切换页面再切回才能恢复。已修改的那几条 id 发生变化，`live` 按 meta 过滤时会自行排除。
     */
    const stuck = new Set(result.stuck ?? []);
    const kept: Record<string, Staged> = {};
    for (const [slot, entry] of Object.entries(staged.value)) {
      if (stuck.has(entry.id ?? entry.key ?? "")) kept[slot] = entry;
    }
    for (const key of Object.keys(store.overrides))
      if (!stuck.has(key)) delete store.overrides[key];
    for (const node of document.querySelectorAll(".cp-ghost"))
      node.classList.remove("cp-ghost");
    staged.value = kept;
    undoStack.value = [];
    for (const slot of Object.keys(kept)) paint(slot);
    committed.value = true;
    setTimeout(() => {
      committed.value = false;
    }, 520);
    message.value = result.refused.length
      ? `写回 ${result.applied} 处，拒绝 ${result.refused.length} 处（还留在面板上）：${result.refused[0]}`
      : `写回 ${result.applied} 处 —— 历史里第 ${result.history ?? 1} 层，随时退得回来`;
    await Promise.all([loadMeta(), loadHistory()]);
  } catch (error) {
    message.value = `保存失败：${error instanceof Error ? error.message : String(error)}`;
  }
  saving.value = false;
}

/**
 * 回退到某一步保存之前。不传 id 即回退最近一步。
 *
 * 先丢弃未保存的内容：回退后源码已是另一份，保留的暂存态里记录的 offset 与元素 key 均为旧值，
 * 下一次保存会被整批拒绝，而点击保存后没有任何变化是最难排查的一种表现。
 */
async function rewind(to?: string): Promise<void> {
  if (dirty.value) discardAll();
  saving.value = true;
  try {
    const result = await fetch("/__copy/revert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(to ? { to } : {}),
    }).then(
      (r) =>
        r.json() as Promise<{
          ok: boolean;
          reason?: string;
          files?: string[];
          dropped?: string[];
        }>,
    );
    message.value = result.ok
      ? `回滚 ${result.files?.length ?? 0} 个文件，退掉 ${result.dropped?.length ?? 0} 层`
      : `回滚不了：${result.reason ?? "未知原因"}`;
    showHistory.value = false;
    await Promise.all([loadMeta(), loadHistory()]);
  } catch (error) {
    message.value = `回滚失败：${error instanceof Error ? error.message : String(error)}`;
  }
  saving.value = false;
}
const when = (at: number): string =>
  new Date(at).toLocaleTimeString("zh-CN", { hour12: false });

/** 文案改写：预览 + 暂存。连续打字并成一个撤销步。 */
function editText(row: Meta, value: string): void {
  store.overrides[row.id] = value;
  stage({ slot: `text:${row.id}`, kind: "text", id: row.id, value }, true);
}
/** 一个工具类 token，同组互斥，点已选中的那个就是取消。 */
function tune(row: Meta, group: Group, value: string): void {
  if (!boxOf(row)) return;
  const slot = `class:${row.owner}:${group}`;
  const next = current(row, group) === value ? "" : value;
  // 字号档要连同基准一起写：档位是基准乘以倍数，而基准需要测量元素自身当前的尺寸。见 styles.css
  // 里 `.u-size-*` 那段注释。取消档位时一并移除基准，否则源码里会留下一条不会被读取的声明。
  if (group === "size") {
    const px = next ? basisFor(row) : null;
    stage({ slot: `basis:${row.owner}`, kind: "basis", key: row.owner, px });
    paint(`basis:${row.owner}`);
  }
  stage({ slot, kind: "class", key: row.owner, group, value: next });
  paint(slot);
}
/**
 * 字号基准：源码里已存在时使用它（那才是元素的原始尺寸），否则当场测量一次。
 *
 * 测量前要先移除已挂上的 `u-size-*` 与 `--u-base`：带着上一档测量时，第二次点击放大
 * 会在已放大的尺寸上继续放大，四个档位会随点击次数偏移。
 */
function basisFor(row: Meta): number | null {
  const stored = boxOf(row)?.basis ?? null;
  if (stored) return stored;
  const node = document.querySelector<HTMLElement>(
    `[data-copy-id~="${row.id}"]`,
  );
  if (!node) return null;
  const tiers = GROUPS.size.tiers
    .map(([tier]) => `${GROUPS.size.prefix}-${tier}`)
    .filter((name) => node.classList.contains(name));
  for (const name of tiers) node.classList.remove(name);
  const had = node.style.getPropertyValue("--u-base");
  node.style.removeProperty("--u-base");
  const px = Number.parseFloat(getComputedStyle(node).fontSize);
  for (const name of tiers) node.classList.add(name);
  if (had) node.style.setProperty("--u-base", had);
  return Number.isFinite(px) ? Math.round(px * 10) / 10 : null;
}
/** 某一组当前生效的档位：优先暂存态，其次源码里那一档。 */
function current(row: Meta, group: Group): string {
  const entry = staged.value[`class:${row.owner}:${group}`];
  return entry
    ? String(entry.value ?? "")
    : (boxOf(row)?.utilities[group] ?? "");
}
/** 当前偏移：优先暂存态，其次源码里那一条。 */
function offsetOf(row: Meta): { dx: number; dy: number } {
  const entry = staged.value[`style:${row.owner}`];
  if (entry) return { dx: Number(entry.dx ?? 0), dy: Number(entry.dy ?? 0) };
  return boxOf(row)?.offset ?? { dx: 0, dy: 0 };
}
/** 拖拽落下 / 归位 / 方向键微调都汇到这里。 */
function offsetTo(row: Meta, dx: number, dy: number, coalesce = false): void {
  if (!boxOf(row)) return;
  const slot = `style:${row.owner}`;
  stage({ slot, kind: "style", key: row.owner, dx, dy }, coalesce);
  paint(slot);
}
/**
 * 实际删除：从模板里移除这个元素。否决权在服务端（`ElementInfo.guards`），这里只是禁用按钮：
 * 判据需要基于 AST，而面板只持有服务端交回的那几项信息。
 */
const removing = (row: Meta): boolean =>
  Boolean(staged.value[`remove:${row.owner}`]);
function remove(row: Meta): void {
  const box = boxOf(row);
  if (!box || box.guards.length) return;
  const slot = `remove:${row.owner}`;
  if (removing(row)) {
    unstage(slot);
    confirming.value = "";
    return;
  }
  stage({ slot, kind: "remove", key: row.owner });
  paint(slot);
  confirming.value = "";
  message.value = `已标记删除 <${box.tag}>${box.inner > 1 ? `（连带 ${box.inner} 条文案）` : ""} —— 按〔保存〕才真的动源码`;
}
/** 界面上完成一次拖拽后：boot.ts 把结果写入 `dragged`，这里接收并暂存。 */
watch(store.dragged, (hit) => {
  if (!hit) return;
  store.dragged.value = null;
  const row = meta.value[hit.id];
  if (!row) {
    message.value = "拖的这一处不在册（源码刚改过？点〔重新扫描〕）";
    return;
  }
  offsetTo(row, hit.dx, hit.dy);
  focus(row);
  message.value = `暂存偏移 ${hit.dx}, ${hit.dy} —— 按〔保存〕才写进源码`;
});
watch(message, (value) => {
  if (value)
    setTimeout(() => {
      message.value = "";
    }, 8000);
});

/**
 * Ctrl/Cmd+Z 回退一步。输入框内不拦截：在文本域里按撤销时，用户要的是撤回刚输入的字符，
 * 交由浏览器处理；拦截会破坏输入体验。
 */
onMounted(() => {
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && showHistory.value) {
      showHistory.value = false;
      return;
    }
    if (
      !(event.key === "z" && (event.ctrlKey || event.metaKey)) ||
      event.shiftKey
    )
      return;
    const active = document.activeElement;
    if (
      active instanceof HTMLTextAreaElement ||
      active instanceof HTMLInputElement
    )
      return;
    if (!undoStack.value.length) return;
    event.preventDefault();
    undo();
  };
  window.addEventListener("keydown", onKey, true);
});
</script>

<template>
  <button v-if="!open" type="button" class="cp-fab" @click="open = true">
    <i />文案<b v-if="dirty">{{ dirty }}</b>
  </button>
  <aside
    v-else
    class="cp"
    :class="{
      boot: booting,
      moving: dragMode === 'move',
      docked: frame.mode === 'dock',
    }"
    :style="seat"
  >
    <header @pointerdown="grab($event, 'move')">
      <span class="cp-grip" />
      <b>校样</b>
      <span class="cp-count"
        >{{ rows.length }} 条<template v-if="dirty">
          · <em>改了 {{ dirty }}</em></template
        ></span
      >
      <button
        type="button"
        :title="frame.mode === 'dock' ? '脱开成浮窗' : '贴回右侧（不遮挡页面）'"
        @click="
          frame = clamp({
            ...frame,
            mode: frame.mode === 'dock' ? 'float' : 'dock',
          })
        "
      >
        {{ frame.mode === "dock" ? "⇱" : "⇥" }}
      </button>
      <button type="button" title="收起" @click="open = false">×</button>
    </header>
    <div class="cp-bar">
      <div class="cp-seg">
        <button
          type="button"
          :class="{ on: mode === 'live' }"
          @click="mode = 'live'"
        >
          本屏出现的
        </button>
        <button
          type="button"
          :class="{ on: mode === 'all' }"
          @click="mode = 'all'"
        >
          全部
        </button>
      </div>
      <button
        type="button"
        class="cp-rescan"
        title="源码改过之后重新抽取一遍"
        @click="
          store.seen.clear();
          store.tick.value++;
          loadMeta();
        "
      >
        重扫
      </button>
    </div>
    <div class="cp-modes">
      <span>工具</span>
      <button
        type="button"
        :class="{ on: store.picking.value }"
        title="点界面上的字，跳到面板里那一条（Alt+点击 随时可用）"
        @click="
          store.picking.value = !store.picking.value;
          store.dragging.value = false;
        "
      >
        {{ store.picking.value ? "点选中 · Esc" : "点选" }}
      </button>
      <button
        type="button"
        :class="{ on: store.dragging.value }"
        title="按住界面上的一句话直接拖，改它的位置"
        @click="
          store.dragging.value = !store.dragging.value;
          store.picking.value = false;
        "
      >
        {{ store.dragging.value ? "拖动中 · Esc" : "拖动" }}
      </button>
    </div>
    <p v-if="store.dragging.value" class="cp-tip">
      在界面上按住任意一句话拖 —— 按住 Shift 锁定单轴。松手只是暂存。
      <span v-if="store.dragLive.value"
        >{{ store.dragLive.value.dx }}, {{ store.dragLive.value.dy }}</span
      >
    </p>
    <input v-model="query" class="cp-search" placeholder="搜文案、位置、文件" />
    <p v-if="message" class="cp-msg">{{ message }}</p>
    <div class="cp-list" :class="{ committed }">
      <p v-if="!rows.length" class="cp-empty">
        {{
          mode === "live"
            ? "还没收集到 —— 界面上点一下，或切一页过去。"
            : "没有匹配的条目。"
        }}
      </p>
      <section
        v-for="(row, index) in rows.slice(0, 300)"
        :key="row.id"
        :data-row="row.id"
        :style="{ '--i': index }"
        :class="{
          hit: focused === row.id,
          dirty: touched(row),
          gone: removing(row),
        }"
        @mouseenter="mark(row)"
        @mouseleave="unmark()"
        @click="focus(row)"
      >
        <p class="cp-where">
          <span class="cp-line">{{ row.line }}</span>
          <span class="cp-kind">{{ row.kind }}</span
          >{{ row.where }}
          <span
            v-if="row.pinned.length"
            class="cp-pin"
            :title="row.pinned.join('\n')"
            >钉住</span
          >
        </p>
        <p class="cp-now" :style="focused === row.id ? typeCss : undefined">
          {{ store.overrides[row.id] || row.core }}
        </p>
        <template v-if="focused === row.id">
          <textarea
            :value="store.overrides[row.id] ?? ''"
            rows="2"
            :placeholder="row.core"
            spellcheck="false"
            @input="editText(row, ($event.target as HTMLTextAreaElement).value)"
          />
          <p
            v-if="row.slots.length"
            class="cp-slots"
            :class="{ bad: missingSlots(row).length }"
          >
            <span>占位</span>
            <code
              v-for="slot in [...new Set(row.slots)]"
              :key="slot"
              :class="{ gone: missingSlots(row).includes(slot) }"
              title="必须原样留着，位置随便挪。少一个，界面上就是一个消失的数字"
              >{{ slot }}</code
            >
            <em v-if="missingSlots(row).length">少了就不给存</em>
          </p>
          <p class="cp-at">
            {{ row.file.replace("packages/", "") }}
            <span v-if="boxOf(row)" class="cp-pos"
              >&lt;{{ boxOf(row)!.tag }}&gt;</span
            >
          </p>
          <template v-if="boxOf(row)">
            <div class="cp-tune">
              <span>字号</span>
              <button
                v-for="[value, label] in GROUPS.size.tiers"
                :key="`s${value}`"
                type="button"
                :class="{ on: current(row, 'size') === value }"
                :title="`比它现在${label}（相对档，em）`"
                @click="tune(row, 'size', value)"
              >
                {{ label }}
              </button>
              <span>斜体</span>
              <button
                v-for="[value, label] in GROUPS.slant.tiers"
                :key="`i${value}`"
                type="button"
                :class="{ on: current(row, 'slant') === value }"
                :title="
                  value === 'italic'
                    ? '中文没有真斜体，浏览器是把字倾斜画出来的 —— 限英文用'
                    : '把继承来的斜体掰正'
                "
                @click="tune(row, 'slant', value)"
              >
                {{ label }}
              </button>
            </div>
            <div class="cp-tune">
              <span>字重</span>
              <button
                v-for="[value, label] in GROUPS.weight.tiers"
                :key="`w${value}`"
                type="button"
                :class="{ on: current(row, 'weight') === value }"
                :title="`font-weight: ${value}`"
                @click="tune(row, 'weight', value)"
              >
                {{ label }}
              </button>
            </div>
            <div class="cp-tune">
              <span>贴边</span>
              <button
                v-for="[value, label] in GROUPS.push.tiers"
                :key="`p${value}`"
                type="button"
                :class="{ on: current(row, 'push') === value }"
                :title="`把它推到容器的${label} —— 点已选中的取消`"
                @click="tune(row, 'push', value)"
              >
                {{ label }}
              </button>
              <span>对齐</span>
              <button
                v-for="[value, label] in GROUPS.text.tiers"
                :key="`t${value}`"
                type="button"
                :class="{ on: current(row, 'text') === value }"
                :title="`文字在自己框里${label}对齐`"
                @click="tune(row, 'text', value)"
              >
                {{ label }}
              </button>
            </div>
            <div class="cp-tune">
              <span>{{ axis(row) === "gapx" ? "左间距" : "上间距" }}</span>
              <button
                v-for="[value, label] in GROUPS.gapx.tiers"
                :key="`g${value}`"
                type="button"
                :class="{ on: current(row, axis(row)) === value }"
                :title="`与${axis(row) === 'gapx' ? '左边' : '上面'}那一块的距离`"
                @click="tune(row, axis(row), value)"
              >
                {{ label }}
              </button>
            </div>
            <div class="cp-tune">
              <span
                :class="[
                  'cp-off',
                  { live: offsetOf(row).dx || offsetOf(row).dy },
                ]"
                title="拖拽偏移（元素自己的 translate）。开〔拖动〕后在界面上按住这句话拖，或用这几个键微调"
              >
                {{ offsetOf(row).dx }}, {{ offsetOf(row).dy }}
              </span>
              <button
                type="button"
                title="左移 1px（按住 Shift 为 10px）"
                @click="
                  offsetTo(
                    row,
                    offsetOf(row).dx - ($event.shiftKey ? 10 : 1),
                    offsetOf(row).dy,
                    true,
                  )
                "
              >
                ←
              </button>
              <button
                type="button"
                title="上移 1px（按住 Shift 为 10px）"
                @click="
                  offsetTo(
                    row,
                    offsetOf(row).dx,
                    offsetOf(row).dy - ($event.shiftKey ? 10 : 1),
                    true,
                  )
                "
              >
                ↑
              </button>
              <button
                type="button"
                title="下移 1px（按住 Shift 为 10px）"
                @click="
                  offsetTo(
                    row,
                    offsetOf(row).dx,
                    offsetOf(row).dy + ($event.shiftKey ? 10 : 1),
                    true,
                  )
                "
              >
                ↓
              </button>
              <button
                type="button"
                title="右移 1px（按住 Shift 为 10px）"
                @click="
                  offsetTo(
                    row,
                    offsetOf(row).dx + ($event.shiftKey ? 10 : 1),
                    offsetOf(row).dy,
                    true,
                  )
                "
              >
                →
              </button>
              <button
                type="button"
                :disabled="!offsetOf(row).dx && !offsetOf(row).dy"
                title="归位（清掉这条偏移）"
                @click="offsetTo(row, 0, 0)"
              >
                归位
              </button>
            </div>
            <div class="cp-tune cp-struct">
              <span>结构</span>
              <button
                type="button"
                :class="{ on: current(row, 'display') === 'none' }"
                title="先藏起来看看 —— 写的是 u-display-none，随时点第二下取消"
                @click="tune(row, 'display', 'none')"
              >
                隐藏
              </button>
              <template v-if="boxOf(row)!.guards.length">
                <span class="cp-guard" :title="boxOf(row)!.guards.join('；')"
                  >删不了：{{ boxOf(row)!.guards[0] }}</span
                >
              </template>
              <template v-else-if="removing(row)">
                <button
                  type="button"
                  class="cp-danger on"
                  @click.stop="remove(row)"
                >
                  取消删除
                </button>
              </template>
              <template v-else-if="confirming === row.id">
                <button
                  type="button"
                  class="cp-danger"
                  @click.stop="remove(row)"
                >
                  真的删<template v-if="boxOf(row)!.inner > 1"
                    >（连带 {{ boxOf(row)!.inner }} 条）</template
                  >
                </button>
                <button type="button" @click.stop="confirming = ''">
                  算了
                </button>
              </template>
              <button
                v-else
                type="button"
                class="cp-danger-quiet"
                @click.stop="confirming = row.id"
              >
                删除…
              </button>
            </div>
          </template>
        </template>
      </section>
      <p v-if="rows.length > 300" class="cp-empty">
        还有 {{ rows.length - 300 }} 条，用搜索缩小范围。
      </p>
    </div>
    <footer>
      <div v-if="showHistory" class="cp-history">
        <p v-if="!history.length" class="cp-empty">还没有保存过。</p>
        <button
          v-for="step in history"
          :key="step.id"
          type="button"
          :disabled="saving"
          @click="rewind(step.id)"
        >
          <b>{{ when(step.at) }}</b>
          <span>{{ step.applied }} 处 · {{ step.files.length }} 个文件</span>
          <em>退到这之前</em>
        </button>
      </div>
      <div class="cp-undo">
        <button
          type="button"
          :disabled="!undoStack.length"
          title="退回上一步（Ctrl+Z）"
          @click="undo"
        >
          撤销
        </button>
        <button
          type="button"
          :disabled="!dirty"
          title="丢弃全部未保存的改动"
          @click="discardAll"
        >
          全部丢弃
        </button>
        <button
          type="button"
          :class="{ on: showHistory }"
          :disabled="!history.length"
          title="保存历史：可以退到任意一次保存之前"
          @click="showHistory = !showHistory"
        >
          历史 {{ history.length || "" }}
        </button>
      </div>
      <button
        type="button"
        class="cp-save"
        :disabled="!dirty || saving || blocked"
        @click="save"
      >
        {{
          saving
            ? "写回中……"
            : blocked
              ? "有条目缺插值"
              : dirty
                ? `保存 ${dirty} 处到源码`
                : "没有未保存的改动"
        }}
      </button>
    </footer>
    <span
      v-if="frame.mode === 'float'"
      class="cp-size"
      title="拖这里改尺寸"
      @pointerdown="grab($event, 'size')"
    />
  </aside>
</template>

<!-- 非 scoped：预览「删掉之后长什么样」要作用在**页面上**的元素，scoped 的属性选择器碰不到它。 -->
<style>
.cp-ghost {
  display: none !important;
}
</style>

<style scoped>
/**
 * 面板的外观：浮在产品之上的一层校对视图。
 *
 * 取舍记录在此，避免下次重做时重复讨论：
 * - 恒为暗色，不跟随产品的浅色 / 深色主题。它是工具而不是产品的一部分（devtools 的惯例），
 *   浅色面板浮在浅色页面上难以区分层次。
 * - 数据一律用 `--font-mono`（产品自托管的 Fira Code，已加载）：行号、offset、tag、时间。
 *   正文与控件用 `--font-sans`。这使工具与产品同源，同时不与产品混淆。
 * - 强调色只有一个（琥珀 `#ffb020`）：选中、暂存、危险三种状态靠形状与位置区分，不增加颜色。
 * - `font` / `color` 在根节点上显式写全：产品的 `button, input, select, textarea { font: inherit }`
 *   会影响到这里，而正在修改的就是那套 CSS。
 */
.cp,
.cp-fab {
  --ink: #120e1a;
  --ink-2: #1a1524;
  --ink-3: #241d33;
  --line: #2e2640;
  --text: #ece7f5;
  --dim: #8b83a3;
  --mark: #ffb020;
  --bad: #ff6b57;
  --sans: var(--font-sans, system-ui, sans-serif);
  --mono: var(--font-mono, ui-monospace, monospace);
  z-index: 2147483000;
  color: var(--text);
  font: 400 13px/1.5 var(--sans);
  box-sizing: border-box;
}
.cp *,
.cp-fab * {
  box-sizing: border-box;
}

/* ── 收起时那一枚 ─────────────────────────────────────────────────────── */
.cp-fab {
  position: fixed;
  right: 18px;
  bottom: 18px;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 9px 15px;
  border: 1px solid #3b2f1a;
  border-radius: 12px;
  background: linear-gradient(#241d33, #1a1524);
  color: var(--mark);
  font: 600 12px/1 var(--mono);
  letter-spacing: 0.04em;
  cursor: pointer;
  box-shadow: 0 10px 30px rgb(0 0 0 / 45%);
  transition:
    transform 0.16s cubic-bezier(0.2, 0.8, 0.2, 1),
    border-color 0.16s;
}
.cp-fab:hover {
  transform: translateY(-2px);
  border-color: var(--mark);
}
.cp-fab i {
  width: 7px;
  height: 7px;
  border-radius: 2px;
  background: var(--mark);
  box-shadow: 0 0 10px var(--mark);
}
.cp-fab b {
  padding: 1px 5px;
  border-radius: 5px;
  background: var(--mark);
  color: #1c1207;
  font-size: 11px;
}

/* ── 窗体 ─────────────────────────────────────────────────────────────── */
.cp {
  position: fixed;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: var(--ink);
  box-shadow:
    0 24px 70px rgb(0 0 0 / 55%),
    0 0 0 1px rgb(255 255 255 / 3%) inset;
  animation: cp-rise 0.2s cubic-bezier(0.2, 0.8, 0.2, 1) both;
}
.cp.docked {
  border-radius: 0;
  border-width: 0 0 0 1px;
  box-shadow: -12px 0 40px rgb(0 0 0 / 45%);
}
.cp.moving {
  box-shadow: 0 34px 90px rgb(0 0 0 / 65%);
  cursor: grabbing;
}
@keyframes cp-rise {
  from {
    opacity: 0;
    transform: scale(0.985) translateY(6px);
  }
}

.cp header {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 11px 12px 11px 14px;
  border-bottom: 1px solid var(--line);
  background: linear-gradient(var(--ink-2), var(--ink));
  cursor: grab;
  user-select: none;
}
.cp header b {
  font: 600 13px/1 var(--sans);
  letter-spacing: 0.04em;
}
/* 抓手：标明只有这条边可拖动。三道短线，不占空间也不依赖图标字体。 */
.cp-grip {
  width: 9px;
  height: 13px;
  flex: none;
  border-inline: 2px solid var(--line);
  border-radius: 1px;
}
.cp-count {
  flex: 1;
  color: var(--dim);
  font: 11px/1 var(--mono);
}
.cp-count em {
  color: var(--mark);
  font-style: normal;
}
.cp header button {
  width: 24px;
  height: 24px;
  border: 1px solid transparent;
  border-radius: 7px;
  background: none;
  color: var(--dim);
  font: 13px/1 var(--sans);
  cursor: pointer;
  transition:
    color 0.14s,
    border-color 0.14s,
    background 0.14s;
}
.cp header button:hover {
  border-color: var(--line);
  background: var(--ink-3);
  color: var(--text);
}

/* 视图与工具是两类东西，因此外观不同：
   - 视图是筛选（查看哪一批），做成分段控件，即一个控件里的两档而不是两个平级按钮；
   - 工具是模式（点击页面时会发生什么），做成一条带标签的虚线工具条。
   此前它们是五枚外观相同的等宽药丸并排，无法区分哪个会改变鼠标行为。 */
.cp-bar {
  display: flex;
  gap: 6px;
  padding: 10px 14px 0;
}
.cp-seg {
  display: flex;
  flex: 1;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--ink-2);
}
.cp-seg button {
  flex: 1;
  padding: 5px 0;
  border: 0;
  border-radius: 7px;
  background: none;
  color: #9c95ab;
  font: 500 11.5px/1 var(--sans);
  cursor: pointer;
  transition:
    color 0.14s,
    background 0.14s;
}
.cp-seg button:hover {
  color: var(--text);
}
.cp-seg button.on {
  background: #2a2014;
  color: #ffd08a;
  box-shadow: 0 1px 0 rgb(255 255 255 / 4%) inset;
}
.cp-rescan {
  flex: none;
  padding: 0 11px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--ink-2);
  color: #8b83a3;
  font: 500 11px/1 var(--mono);
  cursor: pointer;
  transition:
    color 0.14s,
    border-color 0.14s;
}
.cp-rescan:hover {
  border-color: #4b4359;
  color: var(--text);
}
.cp-modes {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 8px 14px 0;
  padding: 3px 3px 3px 9px;
  border: 1px dashed var(--line);
  border-radius: 9px;
}
.cp-modes > span {
  flex: none;
  color: #5f5972;
  font: 10px/1 var(--mono);
  letter-spacing: 0.1em;
}
.cp-modes button {
  flex: 1;
  padding: 6px 0;
  border: 1px solid transparent;
  border-radius: 7px;
  background: var(--ink-2);
  color: #b9b2c6;
  font: 500 11.5px/1 var(--sans);
  cursor: pointer;
  transition:
    color 0.14s,
    border-color 0.14s,
    background 0.14s;
}
.cp-modes button:hover {
  border-color: #4b4359;
  color: var(--text);
}
.cp-modes button.on {
  border-color: var(--mark);
  background: #2a2014;
  color: #ffd08a;
}
.cp-search {
  margin: 9px 14px;
  padding: 8px 11px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--ink-2);
  color: inherit;
  font: 12.5px/1.4 var(--sans);
  outline: none;
  transition:
    border-color 0.14s,
    background 0.14s;
}
.cp-search::placeholder {
  color: #6b6480;
}
.cp-search:focus {
  border-color: var(--mark);
  background: var(--ink-3);
}
.cp-tip {
  margin: 9px 14px 0;
  padding: 8px 10px;
  border: 1px dashed var(--line);
  border-radius: 8px;
  background: var(--ink-2);
  color: var(--dim);
  font-size: 11px;
  line-height: 1.65;
}
.cp-tip span {
  color: var(--mark);
  font-family: var(--mono);
}
.cp-msg {
  margin: 0 14px 8px;
  padding: 8px 10px;
  border-radius: 8px;
  background: #2a2014;
  color: #ffd08a;
  font-size: 11.5px;
  animation: cp-slide 0.2s cubic-bezier(0.2, 0.8, 0.2, 1) both;
}
@keyframes cp-slide {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
}

/* ── 条目 ─────────────────────────────────────────────────────────────── */
/**
 * 这一段是面板的标志性版式：左侧一道贯穿全列的沟槽，行号位于沟槽上，改动标记落在页边，
 * 与校样的排布一致。行号取自源码，因此面板里的一条与编辑器里的一行是同一个坐标。
 *
 * 沟槽线绘制为 `.cp-list` 的背景渐变而不是每行一条 `border-left`：溢出容器的背景铺在 padding box
 * 上、不随内容滚动，因此那道线是连续的，而不会被行间距切断成多段。
 */
/* 底部那道渐隐承载信息而不是装饰：展开一条会增加六行控件，列表几乎总有后续内容，
   而被窗口边缘直接截断的按钮行看起来像渲染异常。 */
.cp-list {
  flex: 1;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 0 14px 14px;
  background: linear-gradient(
    to right,
    transparent 37px,
    #241f30 37px 38px,
    transparent 38px
  );
  mask-image: linear-gradient(to bottom, #000 calc(100% - 14px), transparent);
}
.cp-list section {
  position: relative;
  padding: 9px 0 9px 42px;
  border-bottom: 1px solid #221e2b;
  cursor: pointer;
  transition: background 0.14s;
}
/* 页边那道改动标记：选中是实心白，有未保存改动是琥珀，其余不画。 */
.cp-list section::before {
  content: "";
  position: absolute;
  inset: 6px auto 6px 0;
  width: 2px;
  border-radius: 2px;
  background: transparent;
  transition: background 0.18s;
}
.cp-list section:hover {
  background: #1b1823;
}
.cp-list section.dirty::before {
  background: var(--mark);
}
.cp-list section.hit {
  background: #201c2b;
}
.cp-list section.hit::before {
  background: var(--text);
}
.cp-list section.gone .cp-now {
  text-decoration: line-through;
  opacity: 45%;
}
.cp-list.committed section::before {
  animation: cp-commit 0.5s ease-out both;
}
@keyframes cp-commit {
  0% {
    background: var(--mark);
  }
  100% {
    background: transparent;
  }
}

.cp-where {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 5px;
  color: #7f7890;
  font: 10.5px/1.4 var(--mono);
  word-break: break-all;
}
/* 行号位于沟槽上并脱离文档流：它是坐标，不是这一行文字的组成部分。 */
.cp-line {
  position: absolute;
  left: 4px;
  width: 26px;
  color: #5b5470;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.cp-kind {
  flex: none;
  padding: 1px 6px;
  border-radius: 5px;
  background: #2b2635;
  color: #c3bcd0;
}
.cp-pin {
  flex: none;
  margin-left: auto;
  padding: 1px 5px;
  border-radius: 5px;
  background: #3a2a18;
  color: #f0b45f;
  cursor: help;
}
/* 这一行是校样：选中时用它在页面上真实的字体、字号、字重、字距渲染。 */
.cp-now {
  margin: 0;
  color: #d7d1e2;
  white-space: pre-wrap;
  word-break: break-word;
  transition:
    font-size 0.16s,
    font-weight 0.16s;
}
.cp-list textarea {
  width: 100%;
  margin-top: 7px;
  padding: 7px 9px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #131017;
  color: #fff;
  font: 12.5px/1.5 var(--sans);
  resize: vertical;
  outline: none;
  transition: border-color 0.14s;
}
.cp-list textarea:focus {
  border-color: var(--mark);
}
.cp-bad {
  margin: 5px 0 0;
  color: var(--bad);
  font-size: 11px;
}
/* 占位符始终展示，而不是改坏之后才出现：需要先知道哪些必须保留，再进行修改。 */
.cp-slots {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  margin: 6px 0 0;
}
.cp-slots > span {
  color: #5f5972;
  font: 10px/1.6 var(--mono);
}
.cp-slots code {
  padding: 1px 5px;
  border: 1px solid #2f2a3c;
  border-radius: 5px;
  background: #1d1926;
  color: #b9b2c6;
  font: 10px/1.6 var(--mono);
  cursor: help;
}
.cp-slots code.gone {
  border-color: var(--bad);
  background: #2c1512;
  color: #ff9d8d;
  text-decoration: line-through;
}
.cp-slots em {
  color: var(--bad);
  font-style: normal;
  font-size: 10px;
}
.cp-at {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 6px 0 0;
  color: #5f5972;
  font: 10px/1.4 var(--mono);
}
.cp-pos {
  margin-left: auto;
  color: #7f7890;
}

.cp-tune {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  margin-top: 6px;
}
.cp-tune > span {
  color: #5f5972;
  font: 10px/1.6 var(--mono);
}
.cp-tune > span:not(:first-child) {
  margin-left: 5px;
}
.cp-tune button {
  padding: 2px 7px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--ink-2);
  color: #9c95ab;
  font: 10.5px/1.6 var(--sans);
  cursor: pointer;
  transition:
    color 0.12s,
    border-color 0.12s,
    background 0.12s;
}
.cp-tune button:hover:not(:disabled) {
  border-color: #4b4359;
  color: var(--text);
}
.cp-tune button.on {
  border-color: var(--mark);
  background: #2a2014;
  color: #ffd08a;
}
.cp-tune button:disabled {
  opacity: 35%;
  cursor: default;
}
.cp-off {
  padding: 1px 6px;
  border-radius: 5px;
  background: #2b2635;
  color: #8a8299;
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
  cursor: help;
}
.cp-off.live {
  background: #2a2014;
  color: #ffd08a;
}
.cp-struct {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed #251f31;
}
.cp-danger,
.cp-danger-quiet {
  margin-left: auto;
}
.cp-danger {
  border-color: #5a2a24 !important;
  background: #2c1512 !important;
  color: #ff9d8d !important;
}
.cp-danger:hover {
  border-color: var(--bad) !important;
  color: #ffc4b9 !important;
}
.cp-danger.on {
  border-color: var(--bad) !important;
}
.cp-danger-quiet:hover {
  border-color: #5a2a24 !important;
  color: #ff9d8d !important;
}
.cp-guard {
  margin-left: auto;
  max-width: 62%;
  color: #6f6784;
  font-size: 10px;
  text-align: right;
  cursor: help;
}
.cp-empty {
  padding: 20px 0;
  color: #7f7890;
  text-align: center;
  font-size: 12px;
}

/* ── 底栏与历史 ───────────────────────────────────────────────────────── */
.cp footer {
  padding: 11px 14px 12px;
  border-top: 1px solid var(--line);
  background: linear-gradient(var(--ink), var(--ink-2));
}
.cp-undo {
  display: flex;
  gap: 6px;
  margin-bottom: 8px;
}
.cp-undo button {
  flex: 1;
  padding: 7px 0;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--ink-2);
  color: #b9b2c6;
  font: 500 11px/1 var(--sans);
  cursor: pointer;
  transition:
    color 0.14s,
    border-color 0.14s,
    background 0.14s;
}
.cp-undo button:hover:not(:disabled) {
  border-color: #4b4359;
  color: var(--text);
}
.cp-undo button.on {
  border-color: var(--mark);
  background: #2a2014;
  color: #ffd08a;
}
.cp-undo button:disabled {
  opacity: 40%;
  cursor: default;
}
.cp-history {
  max-height: 190px;
  overflow-y: auto;
  margin-bottom: 9px;
  padding: 5px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--ink);
  animation: cp-slide 0.18s cubic-bezier(0.2, 0.8, 0.2, 1) both;
}
.cp-history button {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  border: 0;
  border-radius: 7px;
  background: none;
  color: #b9b2c6;
  font: 11px/1.4 var(--sans);
  text-align: left;
  cursor: pointer;
  transition: background 0.12s;
}
.cp-history button:hover:not(:disabled) {
  background: var(--ink-3);
}
.cp-history button:disabled {
  opacity: 45%;
  cursor: default;
}
.cp-history b {
  flex: none;
  color: var(--text);
  font-family: var(--mono);
  font-weight: 500;
}
.cp-history span {
  flex: 1;
  color: var(--dim);
  font-family: var(--mono);
  font-size: 10px;
}
.cp-history em {
  flex: none;
  color: var(--mark);
  font-style: normal;
  font-size: 10px;
}
.cp-save {
  width: 100%;
  padding: 10px 0;
  border: 0;
  border-radius: 9px;
  background: linear-gradient(#ffc76a, var(--mark));
  color: #1c1207;
  font: 600 12.5px/1 var(--sans);
  letter-spacing: 0.02em;
  cursor: pointer;
  transition:
    filter 0.14s,
    transform 0.14s;
}
.cp-save:hover:not(:disabled) {
  filter: brightness(1.08);
}
.cp-save:active:not(:disabled) {
  transform: scale(0.99);
}
.cp-save:disabled {
  background: #262030;
  color: #6d6680;
  cursor: default;
}

/* 右下角那块把手：两道斜线，比图标更能表明可拖拽。 */
.cp-size {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 16px;
  height: 16px;
  cursor: nwse-resize;
  background: linear-gradient(
    135deg,
    transparent 50%,
    var(--line) 50% 62%,
    transparent 62% 74%,
    var(--line) 74% 86%,
    transparent 86%
  );
}

/* 入场动画只在挂载时执行一次：列表每次筛选都重放会造成干扰。错开量上限 180ms：300 条逐个错开时
   最后一条需等待五秒才出现，那已不是编排效果而是卡顿。 */
.cp.boot .cp-list section {
  animation: cp-row 0.26s cubic-bezier(0.2, 0.8, 0.2, 1) both;
  animation-delay: min(calc(var(--i, 0) * 16ms), 180ms);
}
@keyframes cp-row {
  from {
    opacity: 0;
    transform: translateX(-5px);
  }
}

@media (prefers-reduced-motion: reduce) {
  .cp,
  .cp-fab,
  .cp *,
  .cp-fab * {
    animation: none !important;
    transition: none !important;
  }
}
</style>
