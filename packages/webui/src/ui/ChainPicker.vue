<script setup lang="ts">
import { computed, ref } from "vue";
import UiTag from "./UiTag.vue";
import type { ChainItem } from "./types";

const props = withDefaults(
  defineProps<{
    modelValue: ChainItem[];
    options: ChainItem[];
    sourceHeader?: string;
    targetHeader?: string;
    empty?: string;
  }>(),
  {
    sourceHeader: "可选模型",
    targetHeader: "fallback 链（按顺序）",
    empty: "还没有选任何模型",
  },
);
const emit = defineEmits<{ "update:modelValue": [ChainItem[]] }>();
const dragging = ref(-1);

const available = computed(() =>
  props.options.filter(
    (option) => !props.modelValue.some((entry) => entry.id === option.id),
  ),
);
function add(item: ChainItem): void {
  emit("update:modelValue", [...props.modelValue, item]);
}
function remove(index: number): void {
  emit(
    "update:modelValue",
    props.modelValue.filter((_, at) => at !== index),
  );
}
function move(from: number, to: number): void {
  if (to < 0 || to >= props.modelValue.length || from === to) return;
  const next = [...props.modelValue];
  const [item] = next.splice(from, 1);
  if (item) next.splice(to, 0, item);
  emit("update:modelValue", next);
}
function onDrop(index: number): void {
  if (dragging.value >= 0) move(dragging.value, index);
  dragging.value = -1;
}
</script>

<template>
  <div class="chain-picker">
    <section class="chain-col">
      <header>{{ sourceHeader }}</header>
      <ul>
        <li v-for="item in available" :key="item.id" class="chain-row">
          <code>{{ item.label }}</code>
          <UiTag v-if="!item.enabled" value="已停用" severity="warn" />
          <button
            type="button"
            class="icon-btn"
            aria-label="加入 fallback 链"
            title="加入 fallback 链"
            @click="add(item)"
          >
            <i class="pi pi-arrow-right" aria-hidden="true" />
          </button>
        </li>
        <li v-if="!available.length" class="chain-empty">没有更多可选模型</li>
      </ul>
    </section>
    <section class="chain-col">
      <header>{{ targetHeader }}</header>
      <ol>
        <li
          v-for="(item, index) in modelValue"
          :key="item.id"
          :class="['chain-row', { dragging: dragging === index }]"
          draggable="true"
          @dragstart="dragging = index"
          @dragend="dragging = -1"
          @dragover.prevent
          @drop.prevent="onDrop(index)"
        >
          <span class="idx">{{ index + 1 }}</span>
          <code>{{ item.label }}</code>
          <UiTag v-if="!item.enabled" value="已停用" severity="warn" />
          <button
            type="button"
            class="icon-btn"
            aria-label="上移"
            :disabled="index === 0"
            @click="move(index, index - 1)"
          >
            <i class="pi pi-chevron-up" aria-hidden="true" />
          </button>
          <button
            type="button"
            class="icon-btn"
            aria-label="下移"
            :disabled="index === modelValue.length - 1"
            @click="move(index, index + 1)"
          >
            <i class="pi pi-chevron-down" aria-hidden="true" />
          </button>
          <button
            type="button"
            class="icon-btn danger"
            aria-label="移出链"
            @click="remove(index)"
          >
            <i class="pi pi-times" aria-hidden="true" />
          </button>
        </li>
        <li v-if="!modelValue.length" class="chain-empty">{{ empty }}</li>
      </ol>
    </section>
  </div>
</template>
