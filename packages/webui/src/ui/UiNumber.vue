<script setup lang="ts">
// 数字步进：外框接管聚焦态，中间是原生 `type=number`（键盘上下键、数字键盘、`min`/`max`/`step`
// 校验均由它提供），两侧为自绘的加减按钮。原生的上下箭头在 Chrome 仅 hover 时显示、Firefox 常驻，
// 尺寸也无法调整，因此由 CSS 关闭。
import { computed, onBeforeUnmount, ref } from "vue";

const props = withDefaults(
  defineProps<{
    modelValue: number | null;
    min?: number;
    max?: number;
    step?: number;
    placeholder?: string;
    disabled?: boolean;
  }>(),
  { step: 1 },
);
const emit = defineEmits<{ "update:modelValue": [number | null] }>();

const input = ref<HTMLInputElement | null>(null);
const atMin = computed(
  () =>
    props.modelValue !== null &&
    props.min !== undefined &&
    props.modelValue <= props.min,
);
const atMax = computed(
  () =>
    props.modelValue !== null &&
    props.max !== undefined &&
    props.modelValue >= props.max,
);

/** 清空输入框应还原为 null 而不是 0：采样参数留空表示使用 provider 默认值（docs/04 §5.2.1）。 */
function onInput(event: Event): void {
  const raw = (event.target as HTMLInputElement).value.trim();
  const parsed = Number(raw);
  emit(
    "update:modelValue",
    raw === "" || !Number.isFinite(parsed) ? null : parsed,
  );
}

const places = (value: number): number => {
  const text = String(value);
  const dot = text.indexOf(".");
  return dot < 0 ? 0 : text.length - dot - 1;
};
function nudge(direction: 1 | -1): void {
  if (props.disabled) return;
  // 从空值开始时第一步停在下限本身而不是下限加一格：点击加号期望得到最小的合法值。
  const next =
    props.modelValue === null
      ? (props.min ?? 0)
      : props.modelValue + direction * props.step;
  // 0.1 + 0.2 = 0.30000000000000004，按 step 与当前值中较长的小数位收敛一次，否则温度点两次即产生脏值。
  const digits = Math.min(
    10,
    Math.max(places(props.step), places(props.modelValue ?? 0)),
  );
  emit(
    "update:modelValue",
    Number(
      Math.min(
        props.max ?? Infinity,
        Math.max(props.min ?? -Infinity, next),
      ).toFixed(digits),
    ),
  );
}

// 长按连发：编辑间隔这类 step=500、跨度 0–30000 的输入项，逐次点击需要六十次。
let repeat = 0;
function stop(): void {
  if (repeat) {
    window.clearTimeout(repeat);
    window.clearInterval(repeat);
    repeat = 0;
  }
}
function hold(direction: 1 | -1): void {
  if (props.disabled) return;
  nudge(direction);
  input.value?.focus();
  stop();
  repeat = window.setTimeout(() => {
    repeat = window.setInterval(() => nudge(direction), 60);
  }, 400);
  // 同一函数引用重复注册为空操作，因此这里各自最多注册一个；`once` 保证正常抬起后自动移除。
  window.addEventListener("pointerup", stop, { once: true });
  window.addEventListener("pointercancel", stop, { once: true });
}
onBeforeUnmount(() => {
  stop();
  window.removeEventListener("pointerup", stop);
  window.removeEventListener("pointercancel", stop);
});
</script>

<template>
  <div class="ui-number" :class="{ off: disabled }">
    <!-- 加减用 <span> 而不是 <button>：调用方普遍写成 `<label>内存上限<UiNumber/></label>`，而 <button>
         是 labelable 元素 —— 点标题文字会被转发成「点了第一个 labelable 后代」，也就是静悄悄减一格。
         换成 span 后转发落到中间那个 input 上，点标题 = 聚焦输入框。键盘用户走 input 自己的上下键。 -->
    <span
      class="step"
      :class="{ off: atMin }"
      aria-hidden="true"
      @pointerdown.prevent="hold(-1)"
      ><i class="pi pi-minus"
    /></span>
    <input
      ref="input"
      type="number"
      :value="modelValue ?? ''"
      :min="min"
      :max="max"
      :step="step"
      :placeholder="placeholder"
      :disabled="disabled"
      @input="onInput"
    />
    <span
      class="step"
      :class="{ off: atMax }"
      aria-hidden="true"
      @pointerdown.prevent="hold(1)"
      ><i class="pi pi-plus"
    /></span>
  </div>
</template>
