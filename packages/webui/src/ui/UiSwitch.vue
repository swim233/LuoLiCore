<script setup lang="ts">
// 开关某一项能力（启用 provider、停用工具、根文件系统只读）用这个；从一组里挑几个用 UiCheckbox。
// 分界不是审美偏好：开关读作「这个东西现在是开着还是关着」，勾选框读作「这一项在不在我选的集合里」。
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

/** `label` 是固定文案；`onLabel` / `offLabel` 是「已开启 / 已关闭」这种跟着状态走的说明，二选一。 */
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
