<script setup lang="ts">
/**
 * 折线 / 面积图。自建 SVG 而不引入图表库：全站已移除 PrimeVue，为绘制两条线再引入
 * 数百 KB 的依赖不划算，且 WebUI 的 CSP 不允许从 CDN 获取。
 *
 * 一条线对应一个 series，y 轴共用同一量程（两条线量级相差较大时较小的一条不可辨认，
 * 这正是 token 数与花费放在一起时的情况，因此调用方需分成两张图或自行归一化）。
 */
import { computed } from "vue";

const props = withDefaults(
  defineProps<{
    labels: string[];
    series: Array<{ name: string; values: number[]; color?: string }>;
    height?: number;
    /** y 轴数值的显示格式。默认使用整数千分位。 */
    format?: (value: number) => string;
  }>(),
  { height: 160 },
);

const PADDING = { top: 12, right: 8, bottom: 22, left: 44 };
const WIDTH = 640;

const format = (value: number): string =>
  props.format ? props.format(value) : Math.round(value).toLocaleString();

const maximum = computed(() => {
  const all = props.series.flatMap((entry) => entry.values);
  // 全为 0 时给出 1 的量程：否则所有点贴在底边，看起来像没有数据而不是数值均为 0。
  return Math.max(1, ...all);
});

const plot = computed(() => ({
  width: WIDTH - PADDING.left - PADDING.right,
  height: props.height - PADDING.top - PADDING.bottom,
}));

function x(index: number): number {
  const count = Math.max(1, props.labels.length - 1);
  return PADDING.left + (index / count) * plot.value.width;
}
function y(value: number): number {
  return (
    PADDING.top +
    plot.value.height -
    (value / maximum.value) * plot.value.height
  );
}

const paths = computed(() =>
  props.series.map((entry, index) => ({
    ...entry,
    color: entry.color ?? `var(--chart-${index % 4})`,
    line: entry.values
      .map(
        (value, position) =>
          `${position ? "L" : "M"}${x(position).toFixed(1)},${y(value).toFixed(1)}`,
      )
      .join(" "),
    area: `${entry.values.map((value, position) => `${position ? "L" : "M"}${x(position).toFixed(1)},${y(value).toFixed(1)}`).join(" ")} L${x(entry.values.length - 1).toFixed(1)},${y(0).toFixed(1)} L${x(0).toFixed(1)},${y(0).toFixed(1)} Z`,
  })),
);

/** 三条水平参考线（0、中值、最大值）。数量再多会使这种高度的图表难以辨读。 */
const gridlines = computed(() =>
  [0, maximum.value / 2, maximum.value].map((value) => ({
    value,
    y: y(value),
    label: format(value),
  })),
);
/** 标签过密时只绘制首、尾与中间三个：7 天可全部绘制，30 天会相互重叠。 */
const ticks = computed(() =>
  props.labels.map((label, index) => ({
    label,
    index,
    show:
      props.labels.length <= 10 ||
      index === 0 ||
      index === props.labels.length - 1 ||
      index === Math.floor(props.labels.length / 2),
  })),
);
</script>

<template>
  <div class="ui-chart">
    <svg
      :viewBox="`0 0 ${WIDTH} ${height}`"
      preserveAspectRatio="none"
      role="img"
      :aria-label="series.map((entry) => entry.name).join('、')"
    >
      <line
        v-for="line in gridlines"
        :key="`g${line.value}`"
        class="chart-grid"
        :x1="PADDING.left"
        :x2="WIDTH - PADDING.right"
        :y1="line.y"
        :y2="line.y"
      />
      <text
        v-for="line in gridlines"
        :key="`t${line.value}`"
        class="chart-axis"
        :x="PADDING.left - 6"
        :y="line.y + 3"
        text-anchor="end"
      >
        {{ line.label }}
      </text>
      <template v-for="entry in paths" :key="entry.name">
        <path
          class="chart-area"
          :d="entry.area"
          :style="{ fill: entry.color }"
        />
        <path
          class="chart-line"
          :d="entry.line"
          :style="{ stroke: entry.color }"
        />
      </template>
      <text
        v-for="tick in ticks.filter((entry) => entry.show)"
        :key="tick.label"
        class="chart-axis"
        :x="x(tick.index)"
        :y="height - 6"
        text-anchor="middle"
      >
        {{ tick.label }}
      </text>
    </svg>
    <ul class="chart-legend">
      <li v-for="entry in paths" :key="entry.name">
        <i :style="{ background: entry.color }" />{{ entry.name }}
      </li>
    </ul>
  </div>
</template>
