<script setup lang="ts">
import type { TagSeverity } from "./types";

withDefaults(
  defineProps<{ value: string | number; severity?: TagSeverity }>(),
  { severity: "primary" },
);
</script>

<template>
  <span :class="['ui-tag', severity]">{{ value }}</span>
</template>
