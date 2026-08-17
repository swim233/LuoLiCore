<script setup lang="ts">
/**
 * 水平条形图。用于「按维度看用量」那类排行：维度值是 chat / user / model 的名字，
 * 竖着放会把标签压成竖排，横着放才读得出来。
 *
 * 只画前 `limit` 条并把剩下的合成一条「其余 N 项」——**不能只截断**：一张只显示前十
 * 而不说还有多少的图，会让人以为那就是全部（docs/22 §0「no silent caps」）。
 */
import { computed } from 'vue';

const props = withDefaults(defineProps<{
  rows: Array<{ label: string; value: number; hint?: string }>;
  limit?: number;
  format?: (value: number) => string;
}>(), { limit: 10 });

const format = (value: number): string => props.format ? props.format(value) : value.toLocaleString();

const display = computed(() => {
  const sorted = [...props.rows].sort((left, right) => right.value - left.value);
  if (sorted.length <= props.limit) return sorted;
  const head = sorted.slice(0, props.limit);
  const rest = sorted.slice(props.limit);
  return [...head, { label: `其余 ${rest.length} 项`, value: rest.reduce((sum, row) => sum + row.value, 0), hint: '合计', rest: true }];
});
const maximum = computed(() => Math.max(1, ...display.value.map((row) => row.value)));
</script>

<template>
  <ul class="ui-bars">
    <li v-for="(row, index) in display" :key="row.label" :class="{ rest: 'rest' in row }">
      <span class="bar-label" :title="row.hint ?? row.label">{{ row.label }}</span>
      <span class="bar-track"><i :style="{ width: `${Math.max(2, (row.value / maximum) * 100)}%`, background: `var(--chart-${index % 4})` }" /></span>
      <b class="bar-value">{{ format(row.value) }}</b>
    </li>
    <li v-if="!display.length" class="empty">这个区间里没有用量</li>
  </ul>
</template>
