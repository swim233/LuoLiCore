<script setup lang="ts">
/**
 * 水平条形图。用于按维度查看用量的排行：维度值是 chat / user / model 的名称，
 * 纵向排列会使标签折行，横向排列才便于阅读。
 *
 * 只绘制前 `limit` 条并把其余合并为一条汇总项，不能只做截断：一张只显示前十项
 * 而不说明剩余数量的图表，会让人误以为这就是全部（docs/22 §0「no silent caps」）。
 */
import { computed } from "vue";

const props = withDefaults(
  defineProps<{
    rows: Array<{ label: string; value: number; hint?: string }>;
    limit?: number;
    format?: (value: number) => string;
  }>(),
  { limit: 10 },
);

const format = (value: number): string =>
  props.format ? props.format(value) : value.toLocaleString();

const display = computed(() => {
  const sorted = [...props.rows].sort(
    (left, right) => right.value - left.value,
  );
  if (sorted.length <= props.limit) return sorted;
  const head = sorted.slice(0, props.limit);
  const rest = sorted.slice(props.limit);
  return [
    ...head,
    {
      label: `其余 ${rest.length} 项`,
      value: rest.reduce((sum, row) => sum + row.value, 0),
      hint: "合计",
      rest: true,
    },
  ];
});
const maximum = computed(() =>
  Math.max(1, ...display.value.map((row) => row.value)),
);
</script>

<template>
  <ul class="ui-bars">
    <li
      v-for="(row, index) in display"
      :key="row.label"
      :class="{ rest: 'rest' in row }"
    >
      <span class="bar-label" :title="row.hint ?? row.label">{{
        row.label
      }}</span>
      <span class="bar-track"
        ><i
          :style="{
            width: `${Math.max(2, (row.value / maximum) * 100)}%`,
            background: `var(--chart-${index % 4})`,
          }"
      /></span>
      <b class="bar-value">{{ format(row.value) }}</b>
    </li>
    <li v-if="!display.length" class="empty">暂无用量</li>
  </ul>
</template>
