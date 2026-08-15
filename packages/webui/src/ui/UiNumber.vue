<script setup lang="ts">
defineProps<{ modelValue: number | null; min?: number; max?: number; step?: number; placeholder?: string; disabled?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [number | null] }>();
/** 清空输入框要还原成 null 而不是 0：采样参数留空 = 用 provider 默认（docs/04 §5.2.1）。 */
function onInput(event: Event): void {
  const raw = (event.target as HTMLInputElement).value.trim();
  const parsed = Number(raw);
  emit('update:modelValue', raw === '' || !Number.isFinite(parsed) ? null : parsed);
}
</script>

<template>
  <input class="ui-number" type="number" :value="modelValue ?? ''" :min="min" :max="max" :step="step" :placeholder="placeholder" :disabled="disabled" @input="onInput">
</template>
