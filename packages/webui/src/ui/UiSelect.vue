<script setup lang="ts">
// 下拉框：触发器与展开面板均为自绘。原生 `<select>` 的弹层由操作系统绘制，圆角、行高、
// 选中色、深色主题都不受页面控制，在这套卡片中是唯一一块不可控样式。
// 面板 Teleport 到 body 并使用 fixed 定位：它的宿主容器（对话框正文、「全部配置」的分组）都是
// `overflow: auto` 的滚动区，留在原地会被裁剪。
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from "vue";

type Option = string | Record<string, unknown>;
const props = defineProps<{
  modelValue: string | null;
  options: Option[];
  optionLabel?: string | ((option: any) => string);
  optionValue?: string;
  placeholder?: string;
  showClear?: boolean;
  disabled?: boolean;
  ariaLabel?: string;
}>();
const emit = defineEmits<{
  "update:modelValue": [string | null];
  change: [];
}>();

const id = useId();
const rows = computed(() =>
  props.options.map((option) => {
    const value =
      typeof option === "string"
        ? option
        : String(option[props.optionValue ?? "value"] ?? "");
    const label =
      typeof props.optionLabel === "function"
        ? props.optionLabel(option)
        : typeof option === "string"
          ? option
          : String(option[props.optionLabel ?? "label"] ?? value);
    return { value, label };
  }),
);
// 「不设置」一行的出现条件与原 <select> 中的空 option 完全一致，语义相同：空串向上层返回 null。
const items = computed(() =>
  props.showClear || props.placeholder || props.modelValue === null
    ? [{ value: "", label: props.placeholder ?? "不设置" }, ...rows.value]
    : rows.value,
);
const picked = computed(
  () => rows.value.find((row) => row.value === props.modelValue) ?? null,
);

const open = ref(false);
const at = ref(-1);
const trigger = ref<HTMLButtonElement | null>(null);
const panel = ref<HTMLElement | null>(null);
const box = ref({ left: 0, width: 0, top: 0, bottom: 0, height: 0, up: false });
const style = computed(() => ({
  left: `${box.value.left}px`,
  width: `${box.value.width}px`,
  maxHeight: `${box.value.height}px`,
  ...(box.value.up
    ? { bottom: `${box.value.bottom}px` }
    : { top: `${box.value.top}px` }),
}));

const GAP = 5;
function place(): void {
  const rect = trigger.value?.getBoundingClientRect();
  if (!rect) return;
  const below = window.innerHeight - rect.bottom - GAP - 8;
  const above = rect.top - GAP - 8;
  // 下方空间不足且上方更充裕时向上展开：设置页与对话框中的控件常紧贴视口底边。
  const up = below < 220 && above > below;
  box.value = {
    left: rect.left,
    width: rect.width,
    top: rect.bottom + GAP,
    bottom: window.innerHeight - rect.top + GAP,
    height: Math.max(120, Math.min(288, up ? above : below)),
    up,
  };
}

const scrollToActive = (): void => {
  panel.value?.querySelector(".at")?.scrollIntoView({ block: "nearest" });
};
async function show(): Promise<void> {
  if (props.disabled) return;
  place();
  open.value = true;
  at.value = Math.max(
    0,
    items.value.findIndex((row) => row.value === (props.modelValue ?? "")),
  );
  await nextTick();
  scrollToActive();
}
function hide(): void {
  open.value = false;
  typed = "";
}
function pick(index: number): void {
  const row = items.value[index];
  if (!row) return;
  // 先关闭面板再发事件：`@change` 可能打开对话框或重载列表，焦点需在此之前归还触发器。
  hide();
  trigger.value?.focus();
  emit("update:modelValue", row.value === "" ? null : row.value);
  emit("change");
}
function move(delta: number): void {
  if (!items.value.length) return;
  at.value = (at.value + delta + items.value.length) % items.value.length;
  void nextTick(scrollToActive);
}

// 首字母跳转：模型与会话等列表动辄数十行，缺少该能力只能连续使用方向键。
let typed = "";
let typedTimer = 0;
function typeahead(key: string): void {
  window.clearTimeout(typedTimer);
  typed += key.toLowerCase();
  typedTimer = window.setTimeout(() => {
    typed = "";
  }, 700);
  const found = items.value.findIndex((row) =>
    row.label.toLowerCase().startsWith(typed),
  );
  if (found >= 0) {
    at.value = found;
    void nextTick(scrollToActive);
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (props.disabled) return;
  if (event.key === "Escape") {
    if (!open.value) return;
    // 对话框中的 UiSelect：UiModal 的 Escape 监听挂在 window 上，不拦截会连同对话框一并关闭。
    event.preventDefault();
    event.stopPropagation();
    hide();
    return;
  }
  if (event.key === "Tab") {
    hide();
    return;
  }
  if (!open.value) {
    // Enter / Space 在 <button> 上会合成一次 click，此处拦截并自行展开，避免展开后立即被 click 关闭。
    if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
      event.preventDefault();
      void show();
    }
    return;
  }
  switch (event.key) {
    case "ArrowDown":
      event.preventDefault();
      move(1);
      break;
    case "ArrowUp":
      event.preventDefault();
      move(-1);
      break;
    case "Home":
      event.preventDefault();
      at.value = 0;
      void nextTick(scrollToActive);
      break;
    case "End":
      event.preventDefault();
      at.value = items.value.length - 1;
      void nextTick(scrollToActive);
      break;
    case "Enter":
    case " ":
      event.preventDefault();
      pick(at.value);
      break;
    default:
      if (
        event.key.length === 1 &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey
      )
        typeahead(event.key);
  }
}

function onPointerDown(event: PointerEvent): void {
  const target = event.target as Node;
  if (trigger.value?.contains(target) || panel.value?.contains(target)) return;
  hide();
}
function bind(): void {
  // scroll 不冒泡，需使用捕获阶段才能收到滚动区自身的事件；面板为 fixed 定位，宿主滚动即需重算。
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("scroll", place, true);
  window.addEventListener("resize", place);
}
function unbind(): void {
  document.removeEventListener("pointerdown", onPointerDown, true);
  document.removeEventListener("scroll", place, true);
  window.removeEventListener("resize", place);
}
watch(open, (isOpen) => (isOpen ? bind() : unbind()));
onBeforeUnmount(() => {
  unbind();
  window.clearTimeout(typedTimer);
});
</script>

<template>
  <button
    ref="trigger"
    type="button"
    class="ui-select"
    :class="{ open }"
    :disabled="disabled"
    role="combobox"
    aria-haspopup="listbox"
    :aria-expanded="open"
    :aria-controls="open ? id : undefined"
    :aria-activedescendant="open && at >= 0 ? `${id}-${at}` : undefined"
    :aria-label="ariaLabel || undefined"
    @click="open ? hide() : show()"
    @keydown="onKeydown"
  >
    <span :class="{ blank: !picked }">{{
      picked?.label ?? placeholder ?? "不设置"
    }}</span>
    <i class="pi pi-chevron-down" aria-hidden="true" />
    <Teleport to="body">
      <Transition name="select">
        <ul
          v-if="open"
          :id="id"
          ref="panel"
          class="ui-options"
          :class="{ up: box.up }"
          :style="style"
          role="listbox"
          :aria-label="ariaLabel || undefined"
        >
          <li
            v-for="(row, index) in items"
            :id="`${id}-${index}`"
            :key="row.value"
            role="option"
            :class="{
              at: index === at,
              on: row.value === (modelValue ?? ''),
              blank: row.value === '',
            }"
            :aria-selected="row.value === (modelValue ?? '')"
            @click="pick(index)"
            @pointermove="at = index"
          >
            <span>{{ row.label }}</span>
            <i class="pi pi-check" aria-hidden="true" />
          </li>
        </ul>
      </Transition>
    </Teleport>
  </button>
</template>
