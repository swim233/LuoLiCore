<script setup lang="ts">
// 从一组中选取多项（工具多选、绕过角色、表格行选中）或筛选视图时使用该组件；开关某项能力使用 UiSwitch。
// 原生 input 保留在 DOM 中：键盘操作、`<label>` 关联、`:checked` / `:indeterminate` 均依赖它，只是移出视觉范围。
import { onMounted, ref, watch } from "vue";

const props = withDefaults(
  defineProps<{
    modelValue?: boolean;
    label?: string;
    ariaLabel?: string;
    disabled?: boolean;
    indeterminate?: boolean;
  }>(),
  { modelValue: false, label: "", ariaLabel: "", indeterminate: false },
);
const emit = defineEmits<{
  "update:modelValue": [boolean];
  change: [boolean];
}>();

// indeterminate 只有 IDL 属性而没有 HTML attribute，`:indeterminate` 伪类只识别前者：只能在挂载后写入，
// 且每次 checked 变化都需重新设置，浏览器会在用户点击时将其置为 false。
const input = ref<HTMLInputElement | null>(null);
const apply = (): void => {
  if (input.value) input.value.indeterminate = props.indeterminate;
};
onMounted(apply);
watch(() => [props.indeterminate, props.modelValue], apply, { flush: "post" });

function onChange(event: Event): void {
  const next = (event.target as HTMLInputElement).checked;
  emit("update:modelValue", next);
  emit("change", next);
}
</script>

<template>
  <label class="ui-check">
    <input
      ref="input"
      type="checkbox"
      :checked="modelValue"
      :disabled="disabled"
      :aria-label="ariaLabel || undefined"
      @change="onChange"
    />
    <span class="ui-check-box"
      ><i
        :class="indeterminate ? 'pi pi-minus' : 'pi pi-check'"
        aria-hidden="true"
    /></span>
    <span v-if="label || $slots.default" class="ui-check-label"
      ><slot>{{ label }}</slot></span
    >
  </label>
</template>
