<script setup lang="ts">
import { computed } from 'vue';

type Option = string | Record<string, unknown>;
const props = defineProps<{ modelValue: string | null; options: Option[]; optionLabel?: string | ((option: any) => string); optionValue?: string; placeholder?: string; showClear?: boolean; disabled?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [string | null]; change: [] }>();
const rows = computed(() => props.options.map((option) => {
  const value = typeof option === 'string' ? option : String(option[props.optionValue ?? 'value'] ?? '');
  const label = typeof props.optionLabel === 'function' ? props.optionLabel(option)
    : typeof option === 'string' ? option : String(option[props.optionLabel ?? 'label'] ?? value);
  return { value, label };
}));
// 空串代表「没选」，回给上层必须是 null：别名的 reasoning 留空 = 不下发这个字段，'' 会被 zod 拒。
function onChange(event: Event): void {
  const raw = (event.target as HTMLSelectElement).value;
  emit('update:modelValue', raw === '' ? null : raw);
  emit('change');
}
</script>

<template>
  <select class="ui-select" :value="modelValue ?? ''" :disabled="disabled" @change="onChange">
    <option v-if="showClear || placeholder || modelValue === null" value="">{{ placeholder ?? '不设置' }}</option>
    <option v-for="row in rows" :key="row.value" :value="row.value">{{ row.label }}</option>
  </select>
</template>
