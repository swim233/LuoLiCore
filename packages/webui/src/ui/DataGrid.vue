<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import UiCheckbox from './UiCheckbox.vue';
import type { GridColumn } from './types';

const props = withDefaults(defineProps<{
  rows: any[]; columns: GridColumn[]; dataKey?: string; paginate?: boolean; pageSize?: number;
  clickable?: boolean; loading?: boolean; empty?: string; scrollHeight?: string; selection?: any[]; selectable?: (row: any) => boolean;
}>(), { pageSize: 20, empty: '暂无数据' });
const emit = defineEmits<{ 'row-click': [any]; 'update:selection': [any[]] }>();

const page = ref(0);
const pageCount = computed(() => props.paginate ? Math.max(1, Math.ceil(props.rows.length / props.pageSize)) : 1);
// SSE 事件会让列表在原地重拉，这里只把页码夹回合法区间；直接重置会让人翻到第 3 页就被弹回第 1 页。
watch(pageCount, (count) => { if (page.value >= count) page.value = count - 1; });
const pageRows = computed(() => props.paginate ? props.rows.slice(page.value * props.pageSize, (page.value + 1) * props.pageSize) : props.rows);
const span = computed(() => props.columns.length + (props.selection ? 1 : 0));
const rowKey = (row: any, index: number): string => props.dataKey ? String(row[props.dataKey]) : String(index);
const cell = (row: any, column: GridColumn): unknown => row[column.field ?? column.key] ?? '';

const pickable = computed(() => props.rows.filter((row) => !props.selectable || props.selectable(row)));
const isPicked = (row: any): boolean => (props.selection ?? []).some((entry) => props.dataKey ? entry[props.dataKey] === row[props.dataKey] : entry === row);
const allPicked = computed(() => pickable.value.length > 0 && pickable.value.every((row) => isPicked(row)));
// 选了一部分时表头给横杠而不是空框：模型目录一页 20 行、勾了 3 行，空框读起来像「一个都没选」。
const somePicked = computed(() => !allPicked.value && pickable.value.some((row) => isPicked(row)));
function togglePick(row: any): void {
  emit('update:selection', isPicked(row) ? (props.selection ?? []).filter((entry) => props.dataKey ? entry[props.dataKey] !== row[props.dataKey] : entry !== row) : [...(props.selection ?? []), row]);
}
function toggleAll(): void { emit('update:selection', allPicked.value ? [] : [...pickable.value]); }
</script>

<template>
  <div :class="['data-grid', { clickable }]">
    <div class="grid-scroll" :style="scrollHeight ? { maxHeight: scrollHeight } : undefined">
      <table>
        <thead>
          <tr>
            <th v-if="selection" class="pick"><UiCheckbox aria-label="全选" :model-value="allPicked" :indeterminate="somePicked" :disabled="!pickable.length" @change="toggleAll" /></th>
            <th v-for="column in columns" :key="column.key" :style="column.width ? { width: column.width } : undefined">{{ column.header }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, index) in pageRows" :key="rowKey(row, index)" :class="{ picked: selection && isPicked(row), unpickable: selection && selectable && !selectable(row) }" @click="emit('row-click', row)">
            <td v-if="selection" class="pick" @click.stop>
              <UiCheckbox :aria-label="`选择第 ${index + 1} 行`" :model-value="isPicked(row)" :disabled="selectable ? !selectable(row) : false" @change="togglePick(row)" />
            </td>
            <td v-for="column in columns" :key="column.key"><slot :name="column.key" :data="row">{{ cell(row, column) }}</slot></td>
          </tr>
          <tr v-if="loading" class="grid-note"><td :colspan="span"><i class="pi pi-spin pi-spinner" aria-hidden="true" /> 加载中…</td></tr>
          <tr v-else-if="!rows.length" class="grid-note"><td :colspan="span">{{ empty }}</td></tr>
        </tbody>
      </table>
    </div>
    <footer v-if="paginate && pageCount > 1" class="grid-pager">
      <span>共 {{ rows.length }} 条 · 第 {{ page + 1 }} / {{ pageCount }} 页</span>
      <button type="button" aria-label="上一页" :disabled="page === 0" @click="page -= 1"><i class="pi pi-chevron-left" aria-hidden="true" /></button>
      <button type="button" aria-label="下一页" :disabled="page >= pageCount - 1" @click="page += 1"><i class="pi pi-chevron-right" aria-hidden="true" /></button>
    </footer>
  </div>
</template>
