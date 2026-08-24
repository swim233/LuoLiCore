<script setup lang="ts">
// 从一组里挑几个（工具多选、绕过角色、表格行选中）或筛选视图时用这个；开关某一项能力用 UiSwitch。
// 原生 input 留在 DOM 里 —— 键盘、`<label>` 关联、`:checked` / `:indeterminate` 全靠它，只是挪出视野。
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

// indeterminate 只有 IDL 属性没有 HTML attribute，`:indeterminate` 这个伪类只认前者：只能挂载后写进去，
// 而且每次 checked 变化都要补一次 —— 浏览器在用户点击时会自己把它清成 false。
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
