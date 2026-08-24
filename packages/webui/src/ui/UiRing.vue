<script setup lang="ts">
/**
 * 额度环形图（docs/09 §3.1）。`limit` 为 null 表示「不限」—— 这时**不画环**，
 * 只写「不限」：画一个永远填不满的圈会让人以为额度快用完了还是还早。
 */
import { computed } from "vue";

const props = defineProps<{
  spent: number;
  limit: number | null;
  label: string;
  warnAtRatio?: number;
}>();

const ratio = computed(() =>
  props.limit === null || props.limit <= 0
    ? null
    : Math.min(1, props.spent / props.limit),
);
const RADIUS = 34;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const severity = computed(() => {
  if (ratio.value === null) return "idle";
  if (ratio.value >= 1) return "danger";
  return ratio.value >= (props.warnAtRatio ?? 0.8) ? "warn" : "ok";
});
const money = (value: number): string => `$${value.toFixed(2)}`;
</script>

<template>
  <div :class="['ui-ring', severity]">
    <svg
      viewBox="0 0 80 80"
      role="img"
      :aria-label="`${label}：已用 ${money(spent)}${limit === null ? '（不限）' : ` / ${money(limit)}`}`"
    >
      <circle class="ring-track" cx="40" cy="40" :r="RADIUS" />
      <circle
        v-if="ratio !== null"
        class="ring-value"
        cx="40"
        cy="40"
        :r="RADIUS"
        :stroke-dasharray="`${(ratio * CIRCUMFERENCE).toFixed(2)} ${CIRCUMFERENCE.toFixed(2)}`"
        transform="rotate(-90 40 40)"
      />
    </svg>
    <div class="ring-text">
      <b>{{ ratio === null ? "不限" : `${Math.round(ratio * 100)}%` }}</b>
      <small>{{ label }}</small>
      <small class="ring-detail"
        >{{ money(spent)
        }}{{ limit === null ? "" : ` / ${money(limit)}` }}</small
      >
    </div>
  </div>
</template>
