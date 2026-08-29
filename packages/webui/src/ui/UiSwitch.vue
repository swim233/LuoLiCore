<script setup lang="ts">
// 开关某项能力（启用 provider、停用工具、根文件系统只读）使用该组件；从一组中选取多项使用 UiCheckbox。
// 这一区分不是审美偏好：开关表达某个对象当前是否启用，勾选框表达某一项是否在已选集合中。
import { computed } from "vue";

const props = withDefaults(
  defineProps<{
    modelValue?: boolean;
    label?: string;
    onLabel?: string;
    offLabel?: string;
    ariaLabel?: string;
    disabled?: boolean;
  }>(),
  { modelValue: false, label: "", onLabel: "", offLabel: "", ariaLabel: "" },
);
const emit = defineEmits<{
  "update:modelValue": [boolean];
  change: [boolean];
}>();

/** `label` 为固定文案；`onLabel` / `offLabel` 是随状态变化的说明文案，两者二选一。 */
const text = computed(
  () => props.label || (props.modelValue ? props.onLabel : props.offLabel),
);
function onChange(event: Event): void {
  const next = (event.target as HTMLInputElement).checked;
  emit("update:modelValue", next);
  emit("change", next);
}
</script>

<template>
  <label class="ui-switch" :class="{ on: modelValue }">
    <input
      type="checkbox"
      role="switch"
      :checked="modelValue"
      :disabled="disabled"
      :aria-label="ariaLabel || undefined"
      @change="onChange"
    />
    <span class="ui-switch-track"><span class="ui-switch-knob" /></span>
    <span v-if="text || $slots.default" class="ui-switch-label"
      ><slot>{{ text }}</slot></span
    >
  </label>
</template>
